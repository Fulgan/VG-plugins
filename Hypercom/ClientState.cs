using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Text;
using BepInEx;

namespace Hypercom
{
    // Server-side persistence for the WEB CLIENT's own state — the state that used to live in the
    // browser's localStorage (optimizer preferences, the action log, the last-docked inventory
    // snapshot). Moving it here means it follows the playthrough instead of the browser: open the UI
    // from a second machine and your categories, filters and log are there, and a cleared browser
    // cache costs nothing.
    //
    // Values are OPAQUE strings. The bridge never parses them — the client owns their shape, exactly
    // like a loadout preset's `settings` blob. Scoping is per playthrough and (optionally) per ship,
    // so per-hull preferences (gear filters, booster slot types) can't collide between ships.
    internal static class ClientState
    {
        private const char Sep = '␞';
        private static readonly object Gate = new object();
        private static Dictionary<string, string> _state;   // "<pt>␞<ship>␞<key>" → value
        private static string Path => System.IO.Path.Combine(Paths.ConfigPath, "hypercom-clientstate.dat");

        // The snapshot blob is hundreds of KB and gets rewritten on every docked refresh, so writes are
        // coalesced: the in-memory copy is authoritative and the file is flushed at most this often
        // (plus once on shutdown, via Flush). Losing a few seconds of a rebuildable cache after a crash
        // is a fair trade for not hammering the disk while the player is trading.
        private const int FlushIntervalMs = 3000;
        private static bool _dirty;
        private static DateTime _lastFlush = DateTime.MinValue;

        // Keys kept in memory but NEVER written to disk. The inventory snapshot is ~800 KB per ship and
        // the client keeps its own copy in localStorage, so persisting it would rewrite megabytes every
        // few seconds while the player trades, to protect a cache that rebuilds itself on the next
        // docked refresh. In memory it still serves a second browser within the same session.
        private static readonly HashSet<string> Volatile = new HashSet<string> { "shipoptimizer.snapshot" };

        private static string Key(string pt, string ship, string key) => (pt ?? "") + Sep + (ship ?? "") + Sep + key;

        // ---- API used by Api.cs ----

        // Every value stored for a playthrough (+ ship, when given) as key → value. A ship-scoped read
        // also returns the playthrough-wide entries, so one call hydrates the whole client.
        internal static Dictionary<string, object> Get(string pt, string ship)
        {
            lock (Gate)
            {
                var all = Store();
                var outp = new Dictionary<string, object>();
                foreach (var kv in all)
                {
                    var parts = kv.Key.Split(Sep);
                    if (parts.Length != 3 || parts[0] != (pt ?? "")) continue;
                    var entryShip = parts[1];
                    if (entryShip.Length > 0 && entryShip != (ship ?? "")) continue; // another ship's entry
                    // Ship-scoped entries win over a playthrough-wide one of the same name.
                    if (entryShip.Length > 0 || !outp.ContainsKey(parts[2])) outp[parts[2]] = kv.Value;
                }
                return outp;
            }
        }

        // Store (or, with a null value, delete) one entry. `ship` empty/null = playthrough-wide.
        internal static void Put(string pt, string ship, string key, string value)
        {
            if (string.IsNullOrEmpty(key)) return;
            lock (Gate)
            {
                var all = Store();
                var k = Key(pt, ship, key);
                if (value == null) { if (!all.Remove(k)) return; }
                else
                {
                    if (all.TryGetValue(k, out var old) && old == value) return; // no-op write: don't touch the disk
                    all[k] = value;
                }
                if (Volatile.Contains(key)) return; // memory-only — no disk churn for the big caches
                _dirty = true;
                MaybeFlush(false);
            }
        }

        internal static int Clear(string pt, string ship)
        {
            lock (Gate)
            {
                var all = Store();
                var doomed = all.Keys.Where(k =>
                {
                    var parts = k.Split(Sep);
                    return parts.Length == 3 && parts[0] == (pt ?? "") && (string.IsNullOrEmpty(ship) || parts[1] == ship);
                }).ToList();
                foreach (var k in doomed) all.Remove(k);
                if (doomed.Count > 0) { _dirty = true; MaybeFlush(true); }
                return doomed.Count;
            }
        }

        // Called on plugin shutdown so a coalesced write can't be lost on a clean exit.
        internal static void Flush()
        {
            lock (Gate) MaybeFlush(true);
        }

        // ---- persistence (tab-delimited: S = one entry) ----

        // Unlike the shared loadout store this cache is Hypercom-only, so it's read once and kept in
        // memory — no other plugin writes the file behind our back.
        private static Dictionary<string, string> Store()
        {
            if (_state != null) return _state;
            _state = new Dictionary<string, string>();
            try
            {
                if (File.Exists(Path))
                    foreach (var line in File.ReadAllLines(Path))
                    {
                        var c = line.Split('\t');
                        if (c.Length >= 5 && c[0] == "S") _state[Key(Nz(c[1]), Nz(c[2]), c[3])] = c[4];
                    }
            }
            catch (Exception ex) { Plugin.Log.LogWarning($"client-state load failed: {ex.Message}"); }
            return _state;
        }

        private static void MaybeFlush(bool force)
        {
            if (!_dirty) return;
            if (!force && (DateTime.UtcNow - _lastFlush).TotalMilliseconds < FlushIntervalMs) return;
            try
            {
                var sb = new StringBuilder();
                foreach (var kv in _state)
                {
                    var parts = kv.Key.Split(Sep);
                    if (parts.Length != 3 || Volatile.Contains(parts[2])) continue;
                    sb.Append("S\t").Append(Esc(parts[0])).Append('\t').Append(Esc(parts[1])).Append('\t')
                      .Append(Esc(parts[2])).Append('\t').Append(Esc(kv.Value)).Append('\n');
                }
                // Write beside the target, then swap — a crash mid-write can't truncate the good file.
                var tmp = Path + ".tmp";
                File.WriteAllText(tmp, sb.ToString());
                if (File.Exists(Path)) File.Delete(Path);
                File.Move(tmp, Path);
                _dirty = false;
                _lastFlush = DateTime.UtcNow;
            }
            catch (Exception ex) { Plugin.Log.LogWarning($"client-state save failed: {ex.Message}"); }
        }

        private static string Nz(string s) => string.IsNullOrEmpty(s) ? null : s;
        // Values are minified JSON from the client (JSON.stringify never emits raw control characters),
        // so this only guards against a hand-edited file.
        private static string Esc(string s) => (s ?? "").Replace('\t', ' ').Replace('\r', ' ').Replace('\n', ' ');
    }
}
