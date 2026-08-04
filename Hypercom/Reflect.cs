#if DEBUG
using System;
using System.Collections;
using System.Collections.Generic;
using System.Linq;
using System.Reflection;
using Behaviour.UI.Spacestation;
using Source.Galaxy.POI;
using Source.Player;

namespace Hypercom
{
    // DEBUG-ONLY live object browser, for mapping an undocumented game surface without a rebuild-and-restart per
    // guess. Compiled out of Release entirely (the file sits inside `#if DEBUG`) AND gated at runtime on
    // Debug/EnableDebugEndpoints, so a debug build still won't expose it by accident.
    //
    // Safety rules, deliberately narrow:
    //   • READ ONLY. Fields, property getters and list indexers. No setters, ever.
    //   • Enumeration NEVER invokes a method, so looking at something cannot cause a side effect.
    //   • A zero-arg method runs only when the path asks for it with `()`, and only if its name doesn't look like
    //     a mutator (see MutatorPrefixes). This is a debug tool on the user's own game, not a sandbox.
    //   • Every member read is individually guarded: game properties throw readily when state is absent, and one
    //     bad getter must not abort the walk or escape onto the game's main thread.
    //   • Depth, member count, collection preview and string length are all capped.
    internal static class Reflect
    {
        private const int MaxDepth = 3;
        private const int MaxMembers = 250;
        private const int MaxItems = 25;
        private const int MaxString = 240;

        // A zero-arg method whose name starts with one of these is never invoked, even if asked for.
        private static readonly string[] MutatorPrefixes =
        {
            "Set", "Add", "Remove", "Clear", "Create", "Destroy", "Reset", "Advance", "Join", "Apply",
            "Load", "Save", "Generate", "Patch", "Start", "Stop", "Kill", "Spawn", "Buy", "Sell",
            "Equip", "Unequip", "Move", "Delete", "Write", "Send", "Open", "Close", "Toggle", "Update",
            "Init", "Enable", "Disable", "Refresh", "Rebuild", "Dispose", "Register", "Unregister",
        };

        // Whitelisted entry points. Everything reachable has to start from one of these.
        private static object Root(string name)
        {
            switch (name)
            {
                case "player": return GamePlayer.current;
                case "ship": return GamePlayer.current?.currentSpaceShip;
                case "map": return Get(GamePlayer.current, "map");
                case "station": return SpaceStation.current;
                case "interior": return SpaceStationInterior.instance;
                default: return null;
            }
        }

        internal static readonly string[] Roots = { "player", "ship", "map", "station", "interior" };

        // GET /debug/reflect?path=map.allSectors[0].allSystems[2]&depth=2
        internal static Api.Result Browse(string path, int depth) => MainThread.Run(() =>
        {
            depth = Math.Max(0, Math.Min(depth <= 0 ? 1 : depth, MaxDepth));
            var steps = (path ?? "").Split('.').Where(s => s.Length > 0).ToList();
            if (steps.Count == 0)
                return Api.Result.Ok(new Dictionary<string, object> { ["roots"] = Roots, ["hint"] = "path=map.allSectors[0]&depth=2" });

            object cur;
            var walked = new List<string>();
            try
            {
                cur = Resolve(steps, walked, out var declared);
                var body = new Dictionary<string, object>
                {
                    ["path"] = string.Join(".", walked),
                    ["type"] = TypeName(cur?.GetType() ?? declared),
                    ["null"] = cur == null,
                    ["value"] = Describe(cur, 0),
                };
                // On null, fall back to the DECLARED type so the shape is still visible.
                var t = cur?.GetType() ?? declared;
                if (t != null && !IsLeaf(t)) body["members"] = Members(cur, t, depth);
                return Api.Result.Ok(body);
            }
            catch (Exception ex)
            {
                return Api.Result.Err(400, $"at '{string.Join(".", walked)}': {ex.Message}");
            }
        });

        // Walk the dotted path, honouring `name`, `name()` and any number of `[n]` suffixes.
        private static object Resolve(List<string> steps, List<string> walked, out Type declared)
        {
            declared = null;
            object cur = null;
            for (var i = 0; i < steps.Count; i++)
            {
                var step = steps[i];
                var name = step;
                var indexes = new List<int>();
                var br = step.IndexOf('[');
                if (br >= 0)
                {
                    name = step.Substring(0, br);
                    foreach (var part in step.Substring(br).Split('['))
                    {
                        var s = part.TrimEnd(']');
                        if (s.Length > 0 && int.TryParse(s, out var ix)) indexes.Add(ix);
                    }
                }
                var call = name.EndsWith("()");
                if (call) name = name.Substring(0, name.Length - 2);

                if (i == 0)
                {
                    if (!Roots.Contains(name)) throw new ArgumentException($"unknown root '{name}' (use: {string.Join(", ", Roots)})");
                    cur = Root(name);
                }
                else
                {
                    if (cur == null) throw new InvalidOperationException("null before this step");
                    cur = call ? Call(cur, name) : Get(cur, name);
                }
                walked.Add(step);
                foreach (var ix in indexes)
                {
                    cur = Index(cur, ix);
                    if (cur == null) break;
                }
                if (cur != null) declared = cur.GetType();
            }
            return cur;
        }

        private static object Get(object o, string name)
        {
            if (o == null) return null;
            var t = o.GetType();
            for (var ty = t; ty != null; ty = ty.BaseType)
            {
                var pi = ty.GetProperty(name, Flags);
                if (pi != null && pi.CanRead) return pi.GetValue(o);
                var fi = ty.GetField(name, Flags);
                if (fi != null) return fi.GetValue(o);
            }
            throw new MissingMemberException($"no readable member '{name}' on {TypeName(t)}");
        }

        private static object Call(object o, string name)
        {
            if (o == null) return null;
            var t = o.GetType();
            if (MutatorPrefixes.Any(p => name.StartsWith(p, StringComparison.Ordinal)))
                throw new InvalidOperationException($"'{name}' looks like a mutator — not invoked");
            for (var ty = t; ty != null; ty = ty.BaseType)
            {
                var mi = ty.GetMethods(Flags).FirstOrDefault(m => m.Name == name && m.GetParameters().Length == 0 && m.ReturnType != typeof(void));
                if (mi != null) return mi.Invoke(o, null);
            }
            throw new MissingMemberException($"no zero-arg non-void method '{name}' on {TypeName(t)}");
        }

        private static object Index(object o, int i)
        {
            if (o == null) return null;
            if (o is IList list) return i >= 0 && i < list.Count ? list[i] : null;
            if (o is IEnumerable e && !(o is string))
            {
                var n = 0;
                foreach (var x in e) if (n++ == i) return x;
                return null;
            }
            throw new InvalidOperationException($"{TypeName(o.GetType())} is not indexable");
        }

        private const BindingFlags Flags = BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Instance | BindingFlags.Static | BindingFlags.DeclaredOnly;

        // Every member of a type, with its current value where readable. Methods are LISTED (so their
        // existence is discoverable) but never called here.
        private static List<object> Members(object o, Type t, int depth)
        {
            var seen = new HashSet<string>();
            var outp = new List<object>();
            for (var ty = t; ty != null && ty != typeof(object) && outp.Count < MaxMembers; ty = ty.BaseType)
            {
                foreach (var fi in ty.GetFields(Flags))
                {
                    if (!seen.Add("f:" + fi.Name) || outp.Count >= MaxMembers) continue;
                    outp.Add(Entry(fi.Name, "field", fi.FieldType, () => fi.IsStatic ? fi.GetValue(null) : (o == null ? null : fi.GetValue(o)), depth));
                }
                foreach (var pi in ty.GetProperties(Flags))
                {
                    if (!pi.CanRead || pi.GetIndexParameters().Length > 0 || !seen.Add("p:" + pi.Name) || outp.Count >= MaxMembers) continue;
                    outp.Add(Entry(pi.Name, "prop", pi.PropertyType, () => pi.GetGetMethod(true)?.IsStatic == true ? pi.GetValue(null) : (o == null ? null : pi.GetValue(o)), depth));
                }
                foreach (var mi in ty.GetMethods(Flags))
                {
                    if (mi.IsSpecialName || mi.GetParameters().Length != 0 || mi.ReturnType == typeof(void)) continue;
                    if (!seen.Add("m:" + mi.Name) || outp.Count >= MaxMembers) continue;
                    outp.Add(new Dictionary<string, object>
                    {
                        ["name"] = mi.Name + "()",
                        ["kind"] = "method",
                        ["type"] = TypeName(mi.ReturnType),
                        ["value"] = "(not called — append () in the path to invoke)",
                    });
                }
            }
            return outp;
        }

        private static object Entry(string name, string kind, Type declared, Func<object> read, int depth)
        {
            object value;
            try { value = Describe(read(), depth - 1); }
            catch (Exception ex) { value = $"⟨threw: {(ex.InnerException ?? ex).Message}⟩"; }
            return new Dictionary<string, object> { ["name"] = name, ["kind"] = kind, ["type"] = TypeName(declared), ["value"] = value };
        }

        private static bool IsLeaf(Type t) =>
            t.IsPrimitive || t.IsEnum || t == typeof(string) || t == typeof(decimal) || t == typeof(DateTime) || t == typeof(Guid);

        // A compact, JSON-safe rendering. Recurses only while `depth` allows.
        private static object Describe(object o, int depth)
        {
            if (o == null) return null;
            var t = o.GetType();
            if (t.IsPrimitive || t == typeof(decimal)) return o;
            if (t.IsEnum) return o.ToString();
            if (o is string s) return s.Length > MaxString ? s.Substring(0, MaxString) + "…" : s;
            if (o is DateTime || o is Guid) return o.ToString();
            if (o is UnityEngine.Vector2 v2) return $"({v2.x}, {v2.y})";
            if (o is UnityEngine.Vector3 v3) return $"({v3.x}, {v3.y}, {v3.z})";

            if (o is IEnumerable e && !(o is string))
            {
                var items = new List<object>();
                var n = 0;
                foreach (var x in e)
                {
                    n++;
                    if (items.Count < MaxItems) items.Add(depth > 0 ? Describe(x, depth - 1) : Stamp(x));
                }
                return new Dictionary<string, object> { ["count"] = n, ["items"] = items, ["truncated"] = n > items.Count };
            }

            if (depth <= 0) return Stamp(o);
            // shallow object: name/type plus its own readable members one level down
            var d = new Dictionary<string, object> { ["$type"] = TypeName(t) };
            foreach (var m in Members(o, t, depth).Take(MaxItems))
                if (m is Dictionary<string, object> md && (string)md["kind"] != "method")
                    d[(string)md["name"]] = md["value"];
            return d;
        }

        // One-line identity for something we're not expanding.
        private static object Stamp(object o)
        {
            if (o == null) return null;
            if (IsLeaf(o.GetType())) return o is string ? Describe(o, 0) : o;
            var name = TryName(o);
            return name == null ? TypeName(o.GetType()) : $"{name} ({TypeName(o.GetType())})";
        }

        private static string TryName(object o)
        {
            foreach (var n in new[] { "displayName", "name", "systemName", "starName", "sectorName" })
            {
                try
                {
                    var v = Get(o, n);
                    if (v is string str && str.Length > 0) return str.Length > 80 ? str.Substring(0, 80) : str;
                }
                catch { /* not present */ }
            }
            return null;
        }

        private static string TypeName(Type t) => t == null ? null : (t.FullName ?? t.Name);
    }
}
#endif
