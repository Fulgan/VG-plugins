using System.Collections.Generic;
using System.IO;
using System.Linq;
using BepInEx;
using VG.Loadout;

namespace Hypercom
{
    // Named loadout presets for the bridge — a thin adapter over the SHARED VG.Loadout.LoadoutStore
    // (one file, shared with Station Assistant). Scoped per playthrough + per ship. This type only maps
    // between the store's LoadoutEntry and the bridge's JSON DTOs; the storage/keying lives in the store.
    internal static class Presets
    {
        internal sealed class Preset
        {
            internal string Ship;              // ship display label
            internal string ShipGuid;          // ship this loadout was taken from
            internal LoadoutPreset Gear;       // hardpoints + modules + boosters (fingerprints)
            internal List<string> Officers;    // officer guid per slot (null = empty)
        }

        // One-time migration of the pre-shared-store file (hypercom-loadouts.json) into the shared store.
        private static bool _migrated;
        private static string LegacyPath => Path.Combine(Paths.ConfigPath, "hypercom-loadouts.json");
        private static void MigrateOnce()
        {
            if (_migrated) return;
            _migrated = true;
            try
            {
                if (!File.Exists(LegacyPath)) return;
                var root = Json.ParseObject(File.ReadAllText(LegacyPath));
                var entries = new List<LoadoutEntry>();
                foreach (var kv in root)
                {
                    if (!(kv.Value is Dictionary<string, object> d)) continue;
                    // key was "<pt>␞<ship>␞<name>", "<pt>␞<name>", or "<name>" (legacy orphan).
                    var parts = kv.Key.Split('␞');
                    var name = parts[parts.Length - 1];
                    var pt = parts.Length >= 2 ? parts[0] : null;
                    var shipGuid = parts.Length >= 3 ? parts[1] : (d.TryGetValue("shipGuid", out var sgv) ? sgv?.ToString() : null);
                    entries.Add(new LoadoutEntry
                    {
                        playthrough = string.IsNullOrEmpty(pt) ? null : pt,
                        shipGuid = string.IsNullOrEmpty(shipGuid) ? null : shipGuid,
                        shipLabel = d.TryGetValue("ship", out var sv) ? sv?.ToString() : null,
                        name = name,
                        gear = GearFromDict(d),
                        officers = OfficersFromDict(d),
                    });
                }
                LoadoutStore.Seed(entries);
                File.Move(LegacyPath, LegacyPath + ".migrated"); // don't re-import next start
                Plugin.Log.LogInfo($"[Hypercom] migrated {entries.Count} loadout(s) into the shared store.");
            }
            catch (System.Exception ex) { Plugin.Log.LogWarning($"preset migration failed: {ex.Message}"); }
        }

        private static LoadoutEntry ToEntry(string pt, string shipGuid, string name, Preset p) => new LoadoutEntry
        {
            playthrough = pt, shipGuid = shipGuid, shipLabel = p.Ship, name = name,
            gear = p.Gear ?? new LoadoutPreset { name = name }, officers = p.Officers ?? new List<string>(),
        };
        private static Preset ToPreset(LoadoutEntry e) => e == null ? null : new Preset
        {
            Ship = e.shipLabel, ShipGuid = e.shipGuid, Gear = e.gear, Officers = e.officers,
        };

        // ---- API used by Api.cs ----

        internal static List<object> List(string playthrough, string shipGuid)
        {
            MigrateOnce();
            return LoadoutStore.ForShip(playthrough, shipGuid).Select(e => Info(e, e.name)).ToList();
        }

        internal static Preset Get(string playthrough, string shipGuid, string name)
        {
            MigrateOnce();
            return ToPreset(LoadoutStore.Get(playthrough, shipGuid, name));
        }

        internal static void Put(string playthrough, string shipGuid, string name, Preset p)
        {
            MigrateOnce();
            LoadoutStore.Put(ToEntry(playthrough, shipGuid, name, p));
        }

        internal static bool Remove(string playthrough, string shipGuid, string name)
        {
            MigrateOnce();
            return LoadoutStore.Remove(playthrough, shipGuid, name);
        }

        internal static List<object> ListOrphans()
        {
            MigrateOnce();
            return LoadoutStore.Orphans().Select(e =>
            {
                var d = Info(e, e.name);
                ((Dictionary<string, object>)d)["rawKey"] = LoadoutStore.RawKeyOf(e);
                return d;
            }).ToList();
        }

        // "claimed" | "conflict" | "missing"
        internal static string Claim(string playthrough, string shipGuid, string rawKey)
        {
            MigrateOnce();
            return LoadoutStore.Claim(rawKey, playthrough, shipGuid);
        }

        internal static List<object> Export(string playthrough)
        {
            MigrateOnce();
            return LoadoutStore.ForPlaythrough(playthrough).Select(e =>
            {
                var d = ToDict(e);
                return (object)d;
            }).ToList();
        }

        internal static int Import(string playthrough, IEnumerable<object> entries)
        {
            MigrateOnce();
            if (entries == null) return 0;
            var list = new List<LoadoutEntry>();
            foreach (var o in entries)
            {
                if (!(o is Dictionary<string, object> d)) continue;
                var name = d.TryGetValue("name", out var nv) ? nv?.ToString()?.Trim() : null;
                if (string.IsNullOrEmpty(name)) continue;
                list.Add(new LoadoutEntry
                {
                    playthrough = playthrough,
                    shipGuid = d.TryGetValue("shipGuid", out var sg) ? sg?.ToString() : null,
                    shipLabel = d.TryGetValue("ship", out var sv) ? sv?.ToString() : null,
                    name = name,
                    gear = GearFromDict(d),
                    officers = OfficersFromDict(d),
                });
            }
            return LoadoutStore.Import(playthrough, list);
        }

        // ---- DTO mapping ----

        private static object Info(LoadoutEntry e, string name) => new Dictionary<string, object>
        {
            ["name"] = name,
            ["ship"] = e.shipLabel,
            ["shipGuid"] = e.shipGuid,
            ["gearSlots"] = e.gear?.slots.Count ?? 0,
            ["officers"] = e.officers?.Count(g => !string.IsNullOrEmpty(g)) ?? 0,
        };

        private static Dictionary<string, object> ToDict(LoadoutEntry e) => new Dictionary<string, object>
        {
            ["name"] = e.name,
            ["ship"] = e.shipLabel,
            ["shipGuid"] = e.shipGuid,
            ["gear"] = e.gear?.slots.Select(SlotToDict).ToList<object>() ?? new List<object>(),
            ["officers"] = e.officers?.Cast<object>().ToList() ?? new List<object>(),
        };

        private static LoadoutPreset GearFromDict(Dictionary<string, object> d)
        {
            var gear = new LoadoutPreset { name = "preset" };
            if (d.TryGetValue("gear", out var gv) && gv is List<object> arr)
                foreach (var o in arr) if (o is Dictionary<string, object> sd) gear.slots.Add(SlotFromDict(sd));
            return gear;
        }

        private static List<string> OfficersFromDict(Dictionary<string, object> d)
        {
            var officers = new List<string>();
            if (d.TryGetValue("officers", out var ov) && ov is List<object> oa)
                foreach (var g in oa) officers.Add(g?.ToString());
            return officers;
        }

        private static Dictionary<string, object> SlotToDict(LoadoutSlot s) => new Dictionary<string, object>
        {
            ["kind"] = s.kind, ["slot"] = s.slot, ["identifier"] = s.identifier, ["type"] = s.type,
            ["name"] = s.name, ["rarity"] = s.rarity, ["level"] = s.level, ["size"] = s.size,
            ["mainStat"] = s.mainStat, ["aspectSlotCount"] = s.aspectSlotCount,
            ["aspects"] = s.aspects.Cast<object>().ToList(), ["stats"] = s.stats.Cast<object>().ToList(),
        };

        private static LoadoutSlot SlotFromDict(Dictionary<string, object> d)
        {
            var s = new LoadoutSlot
            {
                kind = Str(d, "kind"), slot = Str(d, "slot"), identifier = Str(d, "identifier"), type = Str(d, "type"),
                name = Str(d, "name"), rarity = Str(d, "rarity"), level = (int)Dbl(d, "level"), size = Str(d, "size"),
                mainStat = Str(d, "mainStat"), aspectSlotCount = (int)Dbl(d, "aspectSlotCount"),
            };
            if (d.TryGetValue("aspects", out var av) && av is List<object> al) foreach (var a in al) if (a != null) s.aspects.Add(a.ToString());
            if (d.TryGetValue("stats", out var sv) && sv is List<object> sl) foreach (var x in sl) if (x != null) s.stats.Add(x.ToString());
            return s;
        }

        private static string Str(Dictionary<string, object> d, string k) => d.TryGetValue(k, out var v) ? v?.ToString() : null;
        private static double Dbl(Dictionary<string, object> d, string k) { try { return d.TryGetValue(k, out var v) && v != null ? System.Convert.ToDouble(v, System.Globalization.CultureInfo.InvariantCulture) : 0; } catch { return 0; } }
    }
}
