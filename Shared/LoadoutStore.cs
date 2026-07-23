using System;
using System.Collections;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Text;
using BepInEx;
using Source.Player;

namespace VG.Loadout
{
    // One named loadout: the gear fingerprints (LoadoutPreset) + optional officer guids, tagged with the
    // playthrough it belongs to and the ship it was taken from. An entry with no playthrough or no ship
    // guid is an "orphan" (migrated from an older format) — hidden until claimed onto a ship.
    public sealed class LoadoutEntry
    {
        public string playthrough;         // galaxy fingerprint (LoadoutStore.PlaythroughKey)
        public string shipGuid;            // ship this loadout was taken from
        public string shipLabel;           // display name at save time
        public string name;                // user-chosen loadout name
        public LoadoutPreset gear = new LoadoutPreset();
        public List<string> officers = new List<string>();
        public bool IsOrphan => string.IsNullOrEmpty(playthrough) || string.IsNullOrEmpty(shipGuid);
    }

    // The SHARED loadout store — a single file both Hypercom and Station Assistant read/write, so a
    // loadout saved in one mod is visible in the other. It is shared *source* (compiled into each mod),
    // not a DLL, so there's no runtime coupling. Scoped per playthrough + per ship. Serialized as a
    // small tab-delimited text file (no JSON dependency, so it compiles into every plugin unchanged).
    public static class LoadoutStore
    {
        private const char Sep = '␞';   // ␞ key separator
        private static readonly object Gate = new object();
        private static Dictionary<string, LoadoutEntry> _cache;
        private static DateTime _loadedStamp; // file mtime the cache was built from — reload when it changes
        private static string Path => System.IO.Path.Combine(Paths.ConfigPath, "vg-loadouts.dat");

        private static string Key(string pt, string ship, string name) => (pt ?? "") + Sep + (ship ?? "") + Sep + name;
        private static string KeyOf(LoadoutEntry e) => Key(e.playthrough, e.shipGuid, e.name);

        // ---- playthrough identity (shared so both mods agree) ----

        // Stable per-playthrough fingerprint: hash of the galaxy's sector guids (generated once at new
        // game, immutable). Reflection-only so there's no version-variant typeref. Falls back to the
        // commander/captain identity when there's no galaxy yet. Null → unknown (main menu).
        public static string PlaythroughKey(GamePlayer p)
        {
            if (p == null) return null;
            try
            {
                var sectors = Member(Member(p, "map"), "allSectors") as IEnumerable;
                if (sectors != null)
                {
                    ulong h = 14695981039346656037UL; var any = false;
                    foreach (var s in sectors)
                    {
                        var g = Member(s, "guid") as string;
                        if (string.IsNullOrEmpty(g)) continue;
                        any = true;
                        foreach (var ch in g) { h ^= ch; h *= 1099511628211UL; }
                        h ^= (byte)'|'; h *= 1099511628211UL;
                    }
                    if (any) return "gx-" + h.ToString("x");
                }
            }
            catch { /* fall through */ }
            try
            {
                var c = Member(p, "commander") ?? Member(p, "captain");
                if (c == null) return null;
                return $"{Member(c, "firstName")}|{Member(c, "lastName")}|{Member(c, "callsign")}|{Member(p, "starterSpaceshipName")}|{Member(p, "starterSpecialization")}";
            }
            catch { return null; }
        }

        private static object Member(object o, string name)
        {
            if (o == null) return null;
            var t = o.GetType();
            var pi = t.GetProperty(name); if (pi != null) return pi.GetValue(o);
            var fi = t.GetField(name); return fi?.GetValue(o);
        }

        // ---- queries ----

        // Loadouts for one ship in one playthrough (the normal per-ship view).
        public static List<LoadoutEntry> ForShip(string pt, string shipGuid)
        {
            lock (Gate) return Store().Values.Where(e => e.playthrough == pt && e.shipGuid == shipGuid && !e.IsOrphan).ToList();
        }

        public static LoadoutEntry Get(string pt, string shipGuid, string name)
        {
            lock (Gate) return Store().TryGetValue(Key(pt, shipGuid, name), out var e) ? e : null;
        }

        public static void Put(LoadoutEntry e)
        {
            lock (Gate) { Store()[KeyOf(e)] = e; Persist(); }
        }

        public static bool Remove(string pt, string shipGuid, string name)
        {
            lock (Gate) { var ok = Store().Remove(Key(pt, shipGuid, name)); if (ok) Persist(); return ok; }
        }

        // All loadouts for a playthrough (across ships) — for export.
        public static List<LoadoutEntry> ForPlaythrough(string pt)
        {
            lock (Gate) return Store().Values.Where(e => e.playthrough == pt && !e.IsOrphan).ToList();
        }

        // Untagged loadouts (no playthrough or no ship) — from migrated legacy data, reclaimable.
        public static List<LoadoutEntry> Orphans()
        {
            lock (Gate) return Store().Values.Where(e => e.IsOrphan).ToList();
        }

        // Adopt an orphan (identified by its current raw key) onto a playthrough+ship. Returns
        // "claimed" | "conflict" | "missing".
        public static string Claim(string rawKey, string pt, string shipGuid)
        {
            lock (Gate)
            {
                var store = Store();
                if (string.IsNullOrEmpty(rawKey) || !store.TryGetValue(rawKey, out var e) || !e.IsOrphan) return "missing";
                var target = Key(pt, shipGuid, e.name);
                if (store.ContainsKey(target)) return "conflict";
                store.Remove(rawKey);
                e.playthrough = pt; e.shipGuid = shipGuid;
                store[target] = e;
                Persist();
                return "claimed";
            }
        }

        public static string RawKeyOf(LoadoutEntry e) => KeyOf(e);

        // Bulk import into a playthrough (each entry keeps its own shipGuid). Overwrites same key.
        public static int Import(string pt, IEnumerable<LoadoutEntry> entries)
        {
            if (entries == null) return 0;
            var n = 0;
            lock (Gate)
            {
                foreach (var e in entries) { e.playthrough = pt; Store()[KeyOf(e)] = e; n++; }
                if (n > 0) Persist();
            }
            return n;
        }

        // ---- migration: a plugin pushes legacy entries once, then deletes its old file ----

        // Add entries only if their key isn't already present (idempotent). Used by each plugin to seed
        // the shared store from its own old format. Orphans (missing pt/ship) are allowed.
        public static void Seed(IEnumerable<LoadoutEntry> legacy)
        {
            if (legacy == null) return;
            lock (Gate)
            {
                var added = false;
                foreach (var e in legacy)
                {
                    var k = KeyOf(e);
                    if (!Store().ContainsKey(k)) { Store()[k] = e; added = true; }
                }
                if (added) Persist();
            }
        }

        // ---- persistence (tab-delimited: E = entry header, T = gear slot) ----

        // Reload the cache whenever the file's mtime differs from what we last loaded. Because the store
        // is compiled separately into each plugin, they hold independent caches over the same file; the
        // mtime check keeps them coherent and stops one plugin's stale write from clobbering the other's.
        private static Dictionary<string, LoadoutEntry> Store()
        {
            var stamp = File.Exists(Path) ? File.GetLastWriteTimeUtc(Path) : DateTime.MinValue;
            if (_cache != null && stamp == _loadedStamp) return _cache;
            _loadedStamp = stamp;
            _cache = new Dictionary<string, LoadoutEntry>();
            try
            {
                if (File.Exists(Path))
                {
                    LoadoutEntry e = null;
                    foreach (var line in File.ReadAllLines(Path))
                    {
                        var c = line.Split('\t');
                        if (c.Length == 0) continue;
                        if (c[0] == "E" && c.Length >= 6)
                        {
                            e = new LoadoutEntry
                            {
                                playthrough = Nz(c[1]), shipGuid = Nz(c[2]), shipLabel = c[3], name = c[4],
                                officers = SplitList(c[5]),
                                gear = new LoadoutPreset { name = c[4] },
                            };
                            _cache[KeyOf(e)] = e;
                        }
                        else if (c[0] == "T" && e != null && c.Length >= 13)
                        {
                            int.TryParse(c[7], out var lvl);
                            int.TryParse(c[9], out var asc);
                            e.gear.slots.Add(new LoadoutSlot
                            {
                                kind = c[1], slot = c[2], identifier = c[3], type = c[4], name = c[5],
                                rarity = c[6], level = lvl, size = c[8], aspectSlotCount = asc, mainStat = c[10],
                                aspects = SplitList(c[11]), stats = SplitList(c[12]),
                            });
                        }
                    }
                }
            }
            catch (Exception ex) { UnityEngine.Debug.LogWarning($"[VG.Loadout] store load failed: {ex.Message}"); }
            return _cache;
        }

        private static void Persist()
        {
            try
            {
                var sb = new StringBuilder();
                foreach (var e in _cache.Values)
                {
                    sb.Append("E\t").Append(Esc(e.playthrough)).Append('\t').Append(Esc(e.shipGuid)).Append('\t')
                      .Append(Esc(e.shipLabel)).Append('\t').Append(Esc(e.name)).Append('\t')
                      .Append(Esc(string.Join("|", (e.officers ?? new List<string>()).Select(o => o ?? "").ToArray()))).Append('\n');
                    if (e.gear?.slots != null)
                        foreach (var t in e.gear.slots)
                            sb.Append("T\t").Append(Esc(t.kind)).Append('\t').Append(Esc(t.slot)).Append('\t')
                              .Append(Esc(t.identifier)).Append('\t').Append(Esc(t.type)).Append('\t').Append(Esc(t.name)).Append('\t')
                              .Append(Esc(t.rarity)).Append('\t').Append(t.level).Append('\t').Append(Esc(t.size)).Append('\t')
                              .Append(t.aspectSlotCount).Append('\t').Append(Esc(t.mainStat)).Append('\t')
                              .Append(Esc(string.Join("|", (t.aspects ?? new List<string>()).ToArray()))).Append('\t')
                              .Append(Esc(string.Join("|", (t.stats ?? new List<string>()).ToArray()))).Append('\n');
                }
                File.WriteAllText(Path, sb.ToString());
                _loadedStamp = File.GetLastWriteTimeUtc(Path); // our own write — don't trigger a needless reload
            }
            catch (Exception ex) { UnityEngine.Debug.LogWarning($"[VG.Loadout] store save failed: {ex.Message}"); }
        }

        private static string Nz(string s) => string.IsNullOrEmpty(s) ? null : s;
        private static string Esc(string s) => (s ?? "").Replace('\t', ' ').Replace('\r', ' ').Replace('\n', ' ');
        private static List<string> SplitList(string s) => string.IsNullOrEmpty(s) ? new List<string>() : new List<string>(s.Split('|'));
    }
}
