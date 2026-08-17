using System;
using System.Collections.Concurrent;
using System.Reflection;

namespace VG.Game
{
    // Name-based access to game members, shared by every plugin.
    //
    // Named `GameMembers`, not `Reflect`: Hypercom already has its own `Reflect` (the DEBUG live-object browser),
    // and two classes with that name in one assembly is the same hazard as two CSS classes sharing a word. Compiled into each (no shared DLL), like the
    // rest of Shared/.
    //
    // Why by name at all: one binary loads on several game builds and a hard typeref in an always-run path fails
    // to JIT where the member is absent, taking the whole feature down. Reflection degrades to null instead.
    //
    // ⚠️ That is also the hazard: a misnamed member returns null, which reads as EMPTY rather than WRONG. So every
    // name reached through here belongs in the API checks, which report what a given build actually has
    //
    public static class GameMembers
    {
        // CONCURRENT because Hypercom serves HTTP on its own thread while the game runs on Unity's main one.
        // Every reflection path traced today happens to sit inside MainThread.Run, so this is hardening rather
        // than a fix — but a plain Dictionary written from two threads corrupts its buckets silently, and the
        // cost of ruling that out is one type name.
        private static readonly ConcurrentDictionary<string, Type> Types = new ConcurrentDictionary<string, Type>();
        private static readonly ConcurrentDictionary<string, MemberInfo> Instance = new ConcurrentDictionary<string, MemberInfo>();

        /// <summary>A game type by full name, searching every loaded assembly. Cached, null when absent.</summary>
        public static Type FindType(string fullName)
        {
            if (Types.TryGetValue(fullName, out var hit)) return hit;
            var t = Type.GetType(fullName);
            if (t == null)
                foreach (var asm in AppDomain.CurrentDomain.GetAssemblies())
                {
                    try { t = asm.GetType(fullName); } catch { t = null; }
                    if (t != null) break;
                }
            Types[fullName] = t;   // last writer wins; both resolve the same type
            return t;
        }

        /// <summary>
        /// A static field or property, walking the BASE CHAIN and including non-public members.
        /// Named `Deep` to distinguish it from a shallow public-only lookup — they are not interchangeable.
        ///
        /// The chain walk is the point: a singleton's `Instance` is often declared on a generic base
        /// (`GameManager : PersistentSingleton&lt;GameManager&gt;`), so a lookup on the derived type alone finds
        /// nothing — and reports it as "absent" rather than "look further up".
        /// </summary>
        public static object StaticGetDeep(Type type, string name)
        {
            const BindingFlags F = BindingFlags.NonPublic | BindingFlags.Public | BindingFlags.Static;
            for (var t = type; t != null; t = t.BaseType)
                try
                {
                    var fi = t.GetField(name, F);
                    if (fi != null) return fi.GetValue(null);
                    var pi = t.GetProperty(name, F);
                    if (pi != null && pi.CanRead) return pi.GetValue(null);
                }
                catch { return null; }
            return null;
        }

        /// <summary>
        /// An instance field or property by name, walking the base chain. Null when the object or the member
        /// is absent.
        ///
        /// FIELD OR PROPERTY, always both: which one a member is differs between game builds with no rename to
        /// signal it, and a compiled `ldfld` or `get_x()` binds to exactly one of them. Reading by name is what
        /// makes the difference invisible to the caller.
        /// </summary>
        public static object Get(object obj, string name)
        {
            if (obj == null) return null;
            try
            {
                switch (Member(obj.GetType(), name))
                {
                    case FieldInfo f: return f.GetValue(obj);
                    case PropertyInfo p when p.CanRead: return p.GetValue(obj);
                    default: return null;
                }
            }
            catch { return null; }
        }

        /// <summary>
        /// An instance field or property by name INCLUDING non-public ones, walking the base chain.
        ///
        /// Separate from `Get` on purpose: `Get` is Public|Instance because reading a private member is normally
        /// a mistake — the private one is a backing array whose shape the game is free to change, and reading it
        /// instead of the public projection is what once reported an empty galaxy-wide inventory. This exists for
        /// the cases where the private state IS the subject: `Inventory.allItems` (the data) against
        /// `visibleItems` (what a panel draws) cannot be compared through any public member, because the public
        /// `items` projects the first one only.
        /// </summary>
        public static object GetPrivate(object obj, string name)
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

        /// <summary>The public instance field or property behind a name, or null. Cached: a DTO pass resolves
        /// the same handful of names once per item.</summary>
        public static MemberInfo Member(Type t, string name)
        {
            if (t == null) return null;
            var key = t.FullName + "." + name;
            if (Instance.TryGetValue(key, out var hit)) return hit;
            const BindingFlags F = BindingFlags.Public | BindingFlags.Instance;
            MemberInfo m = null;
            try { m = (MemberInfo)t.GetField(name, F) ?? t.GetProperty(name, F); } catch { }
            Instance[key] = m;
            return m;
        }

        /// <summary>
        /// Write an instance field or property by name. False when the member is absent or read-only, so a
        /// caller that is changing game state can tell that nothing happened — silently dropping a write to
        /// the player's balance is worse than refusing it.
        /// </summary>
        public static bool Set(object obj, string name, object value)
        {
            if (obj == null) return false;
            try
            {
                switch (Member(obj.GetType(), name))
                {
                    case FieldInfo f: f.SetValue(obj, value); return true;
                    case PropertyInfo p when p.CanWrite: p.SetValue(obj, value); return true;
                    default: return false;
                }
            }
            catch { return false; }
        }

        /// <summary>A public static method by name and arity, or null.</summary>
        public static MethodInfo StaticMethod(Type type, string name, int argCount = -1)
        {
            if (type == null) return null;
            try
            {
                foreach (var m in type.GetMethods(BindingFlags.Public | BindingFlags.Static))
                    if (m.Name == name && (argCount < 0 || m.GetParameters().Length == argCount)) return m;
            }
            catch { }
            return null;
        }

        /// <summary>
        /// `Inventory.Remove(item, amount)` — by name, because the overload that takes an `InventoryItemType`
        /// gained a trailing `bool skipFavourited = false` parameter and older builds do not have it.
        ///
        /// An optional argument is baked into the CALL SITE: `inv.Remove(type, n)` compiles to a reference to
        /// the two-argument method, which the newer build does not have, and the reference is resolved when the
        /// CALLING method is JIT-compiled. So the failure is a `MissingMethodException` that takes out the whole
        /// method — the sale, the restock, the loadout apply — before its own try/catch can run. Both shapes must
        /// stay reachable from one binary, ∴ neither may be named at compile time.
        ///
        /// `item` may be an `InventoryItemType` or an `Inventory.InventoryItem` entry: the overload is chosen by
        /// what the first parameter accepts, so the two are not interchangeable by arity alone (both are 2-arg).
        ///
        /// ⚠️ THE TWO OVERLOADS RETURN DIFFERENT TYPES, and a caller that moves value must not treat one as the
        /// other: the `InventoryItemType` form returns the `int` it removed, the entry form returns a `bool` and
        /// answers `false` whenever `item.inventory != this` — i.e. the entry belongs to another store or is a
        /// stale handle, which removes NOTHING while looking like an ordinary call.
        ///
        /// Returns how many units the game says it removed: `amount` on a `true`/full removal, the reported count
        /// for the counting overload, `0` when the game refused, and <b>-1 when the call could not be made at
        /// all</b> (no such overload, or it threw). A caller ! distinguish -1 from 0 — one is a broken build, the
        /// other is a refusal about this item — and ! treat either as success.
        /// </summary>
        public static int RemoveItems(object inventory, object item, int amount)
        {
            if (inventory == null || item == null || amount <= 0) return -1;
            var m = RemoveOverload(inventory.GetType(), item.GetType());
            if (m == null)
            {
                Complain(item, "no Remove overload takes " + item.GetType().Name);
                return -1;
            }
            try
            {
                var args = m.GetParameters().Length == 2
                    ? new[] { item, (object)amount }
                    : new[] { item, (object)amount, false };
                switch (m.Invoke(inventory, args))
                {
                    case int n: return n;
                    case bool ok: return ok ? amount : 0;
                    // A void or unrecognised return cannot be checked, so it is reported as uncallable rather
                    // than assumed good: an unverifiable removal beside a credit is how an item gets duplicated.
                    default:
                        Complain(item, m.Name + " returned " + (m.ReturnType?.Name ?? "void") + ", which cannot be verified");
                        return -1;
                }
            }
            catch (Exception e)
            {
                Complain(item, e.GetBaseException().Message);
                return -1;
            }
        }

        // Named for the log line it writes, not for a policy: whoever calls RemoveItems decides what a failure
        // costs. This only makes sure a failure is never silent — the defect it exists for was invisible in
        // every log while it moved items.
        //
        // `UnityEngine.Debug` is reached BY NAME so this file carries no Unity typeref and can be compiled into
        // the test project, where there is no Unity at all: absent logger ⇒ no log, never a throw.
        private static void Complain(object item, string why)
        {
            try
            {
                var log = LogWarning.Value;
                if (log != null) log.Invoke(null, new object[] { "[VG] Inventory.Remove refused or unavailable for " + (item ?? "null") + ": " + why });
            }
            catch { }
        }

        private static readonly Lazy<MethodInfo> LogWarning = new Lazy<MethodInfo>(() =>
        {
            var t = FindType("UnityEngine.Debug");
            try { return t?.GetMethod("LogWarning", BindingFlags.Public | BindingFlags.Static, null, new[] { typeof(object) }, null); }
            catch { return null; }
        });

        private static readonly ConcurrentDictionary<string, MethodInfo> Removers = new ConcurrentDictionary<string, MethodInfo>();

        // Shortest parameter list first: the two-argument form is the one both branches share, and it leaves the
        // build's own default for any parameter beyond it rather than asserting a value for it.
        private static MethodInfo RemoveOverload(Type inventory, Type itemType)
        {
            var key = inventory.FullName + "|" + itemType.FullName;
            if (Removers.TryGetValue(key, out var hit)) return hit;
            MethodInfo best = null;
            try
            {
                foreach (var m in inventory.GetMethods(BindingFlags.Public | BindingFlags.Instance))
                {
                    if (m.Name != "Remove") continue;
                    var ps = m.GetParameters();
                    if (ps.Length < 2 || !ps[0].ParameterType.IsAssignableFrom(itemType)) continue;
                    if (ps[1].ParameterType != typeof(int)) continue;
                    if (best == null || ps.Length < best.GetParameters().Length) best = m;
                }
            }
            catch { best = null; }
            Removers[key] = best;
            return best;
        }

        /// <summary>A public instance method by name and arity, or null.</summary>
        public static MethodInfo Method(Type type, string name, int argCount = -1)
        {
            if (type == null) return null;
            try
            {
                foreach (var m in type.GetMethods(BindingFlags.Public | BindingFlags.Instance))
                    if (m.Name == name && (argCount < 0 || m.GetParameters().Length == argCount)) return m;
            }
            catch { }
            return null;
        }
    }
}
