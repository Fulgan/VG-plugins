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
        internal static Type FindType(string fullName)
        {
            if (Types.TryGetValue(fullName, out var t)) return t;
            t = Type.GetType(fullName);
            if (t == null)
                foreach (var asm in AppDomain.CurrentDomain.GetAssemblies())
                {
                    try { t = asm.GetType(fullName); } catch { t = null; }
                    if (t != null) break;
                }
            Types[fullName] = t;
            return t;
        }

        // Get a property or field value by name (null if the object/member is absent).
        internal static object Get(object obj, string name)
        {
            if (obj == null) return null;
            var m = Member(obj.GetType(), name);
            try
            {
                return m switch { PropertyInfo p => p.GetValue(obj), FieldInfo f => f.GetValue(obj), _ => null };
            }
            catch { return null; }
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

        internal static bool Has(object obj, string name) => obj != null && Member(obj.GetType(), name) != null;

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

        private static MemberInfo Member(Type t, string name)
        {
            var key = t.FullName + "." + name;
            if (Members.TryGetValue(key, out var m)) return m;
            m = (MemberInfo)t.GetProperty(name, BindingFlags.Public | BindingFlags.Instance)
                ?? t.GetField(name, BindingFlags.Public | BindingFlags.Instance);
            Members[key] = m;
            return m;
        }
    }
}
