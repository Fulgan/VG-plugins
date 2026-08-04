using System;
using System.Collections;
using System.Collections.Generic;
using System.Linq;
using System.Reflection;
using UnityEngine;

namespace Hypercom
{
    // Cross-version reflection shim. The beta and release games differ (renamed/added/removed members:
    // crew API, resonant boosters, EMP, item quality, drone-bay, HangarBay slot, …). To ship ONE binary
    // that keeps FULL functionality on the version that has a member and degrades gracefully on the one
    // that doesn't, every version-specific member is touched through here — no compile-time typeref, so
    // a missing member is just a null at runtime instead of a TypeLoadException.
    internal static class Compat
    {
        private static readonly Dictionary<string, MemberInfo> Members = new Dictionary<string, MemberInfo>();
        private static readonly Dictionary<string, Type> Types = new Dictionary<string, Type>();

        // Resolve a type by full name across loaded assemblies (cached; null if it doesn't exist here).
        // Delegates to the shared owner: every plugin needs this and a second cache would answer differently
        // after an assembly loads late.
        internal static Type FindType(string fullName) => VG.Game.GameMembers.FindType(fullName);

        // Get a property or field value by name (null if the object/member is absent). Forwards to the shared
        // owner; it has no body of its own to diverge.
        internal static object Get(object obj, string name) => VG.Game.GameMembers.Get(obj, name);

        // Get a property or field a type keeps to ITSELF, walking the base chain. Separate from `Get` on
        // purpose: reading a private member is a claim about the game's internals that outlives no refactor,
        // so the call sites that do it are worth being able to find.
        internal static object GetPrivate(object obj, string name)
        {
            if (obj == null) return null;
            for (var t = obj.GetType(); t != null; t = t.BaseType)
            {
                const BindingFlags f = BindingFlags.Instance | BindingFlags.Public | BindingFlags.NonPublic
                                       | BindingFlags.DeclaredOnly;
                try
                {
                    var pi = t.GetProperty(name, f);
                    if (pi != null) return pi.GetValue(obj);
                    var fi = t.GetField(name, f);
                    if (fi != null) return fi.GetValue(obj);
                }
                catch { return null; }
            }
            return null;
        }

        internal static T Get<T>(object obj, string name, T fallback = default)
        {
            var v = Get(obj, name);
            return v is T tv ? tv : fallback;
        }

        // Invoke a method by name (best-effort by arg count; null if absent or it throws).
        internal static object Call(object obj, string name, params object[] args)
        {
            if (obj == null) return null;
            try
            {
                var mi = obj.GetType().GetMethods(BindingFlags.Public | BindingFlags.Instance)
                    .FirstOrDefault(x => x.Name == name && x.GetParameters().Length == args.Length);
                return mi?.Invoke(obj, args);
            }
            catch { return null; }
        }

        // Invoke a public static method — the shape the game's extension helpers take (`ReputationLevelExtensions`,
        // `ConquestRankExtension`: everything derived from a raw number lives on one of those). Overloads are
        // resolved on the ARGUMENTS' runtime types, not just arity: `GetShopDiscount` exists for both an `int`
        // reputation and a `ReputationLevel`, and picking by count alone would pass an enum where an int is wanted.
        // Null when the type, the method or the overload is absent, or the call throws.
        internal static object CallStatic(Type t, string name, params object[] args)
        {
            if (t == null) return null;
            try
            {
                var types = args.Select(a => a?.GetType() ?? typeof(object)).ToArray();
                const BindingFlags F = BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Static;
                var mi = t.GetMethod(name, F, null, types, null)
                         ?? t.GetMethods(F).FirstOrDefault(m => m.Name == name && m.GetParameters().Length == args.Length);
                return mi?.Invoke(null, args);
            }
            catch { return null; }
        }

        internal static bool Has(object obj, string name) => obj != null && Member(obj.GetType(), name) != null;

        // Whether a TYPE declares an instance member — answerable with no instance to hand, which matters for
        // capability probing: "can this build report shop restock times" must not depend on being docked.
        internal static bool HasMember(Type t, string name) => t != null && Member(t, name) != null;

        // PRIVATE members. Separate from `Get`/`Num`/`StaticNum` on purpose: the ordinary accessors stay
        // public-only so a typo can't silently bind to a compiler-generated backing field
        // (`<items>k__BackingField`) and appear to work. Reach for these only where the game exposes no public
        // equivalent — a private member can be renamed by any build, so the caller must tolerate null.
        internal static object PrivateGet(object obj, string name)
        {
            if (obj == null) return null;
            const BindingFlags F = BindingFlags.NonPublic | BindingFlags.Public | BindingFlags.Instance;
            for (var t = obj.GetType(); t != null; t = t.BaseType)
                try
                {
                    var fi = t.GetField(name, F);
                    if (fi != null) return fi.GetValue(obj);
                    var pi = t.GetProperty(name, F);
                    if (pi != null && pi.CanRead) return pi.GetValue(obj);
                }
                catch { return null; }
            return null;
        }

        internal static float? PrivateNum(object obj, string name)
        {
            if (obj == null) return null;
            const BindingFlags F = BindingFlags.NonPublic | BindingFlags.Public | BindingFlags.Instance;
            for (var t = obj.GetType(); t != null; t = t.BaseType)
                try
                {
                    var fi = t.GetField(name, F);
                    if (fi != null) return AsNumber(fi.GetValue(obj));
                    var pi = t.GetProperty(name, F);
                    if (pi != null && pi.CanRead) return AsNumber(pi.GetValue(obj));
                }
                catch { return null; }
            return null;
        }

        // A private STATIC member's value. Same caveats as PrivateGet; needed for tables the game keeps to
        // itself (`EquipAspect.allAspects`).
        // Base-chain static lookup, shared: a singleton's `Instance` is often declared on a generic base.
        internal static object PrivateStaticGet(Type type, string name) => VG.Game.GameMembers.StaticGetDeep(type, name);

        internal static float? PrivateStaticNum(Type type, string name)
        {
            const BindingFlags F = BindingFlags.NonPublic | BindingFlags.Public | BindingFlags.Static;
            for (var t = type; t != null; t = t.BaseType)
                try
                {
                    var fi = t.GetField(name, F);
                    if (fi != null) return AsNumber(fi.GetValue(null));
                    var pi = t.GetProperty(name, F);
                    if (pi != null && pi.CanRead) return AsNumber(pi.GetValue(null));
                }
                catch { return null; }
            return null;
        }

        // A numeric member, converted from whatever numeric type the game declared. Null when absent or
        // non-numeric. Prefer this over `Get<int>`/`Get<float>` for game numbers: those match on the exact
        // type (`value is int`) and return the fallback for any other numeric type, so a `float` field read
        // as `int` yields 0 rather than its value.
        internal static float? Num(object obj, string name) => AsNumber(Get(obj, name));

        // Same tolerance for a static.
        internal static float? StaticNum(Type t, string name) => AsNumber(StaticGet(t, name));

        internal static float? AsNumber(object o)
        {
            switch (o)
            {
                case float f: return f;
                case double d: return (float)d;
                case int i: return i;
                case long l: return l;
                case short s: return s;
                case byte b: return b;
                case uint u: return u;
                case ulong ul: return ul;
                case decimal m: return (float)m;
                default: return null;
            }
        }

        // Static property/field by name, walking the base chain. Statics are INVISIBLE to `Get`, which binds
        // against an instance — reading e.g. `SpaceStation.ShopRefreshInterval` or `SystemMapData.current`
        // through an instance silently yields null/0 rather than failing, so they need this path.
        internal static object StaticGet(Type t, string name)
        {
            if (t == null) return null;
            const BindingFlags F = BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Static;
            for (var ty = t; ty != null; ty = ty.BaseType)
            {
                try
                {
                    var pi = ty.GetProperty(name, F);
                    if (pi != null && pi.CanRead) return pi.GetValue(null);
                    var fi = ty.GetField(name, F);
                    if (fi != null) return fi.GetValue(null);
                }
                catch { return null; }
            }
            return null;
        }

        // GetComponent<T> by type full name — null if the component type doesn't exist in this build.
        internal static Component GetComponent(Component c, string typeFullName)
        {
            var ty = FindType(typeFullName);
            return ty != null && c != null ? c.GetComponent(ty) : null;
        }

        // Enum value by name (e.g. EquipmentSlot.HangarBay), or null if that member doesn't exist.
        internal static object EnumValue(string enumFullName, string valueName)
        {
            var ty = FindType(enumFullName);
            if (ty == null || !ty.IsEnum) return null;
            try { return Enum.IsDefined(ty, valueName) ? Enum.Parse(ty, valueName) : null; } catch { return null; }
        }

        internal static IEnumerable<object> Enumerate(object maybeEnumerable)
        {
            if (maybeEnumerable is IEnumerable e) foreach (var x in e) yield return x;
        }

        private static MemberInfo Member(Type t, string name) => VG.Game.GameMembers.Member(t, name);
    }
}
