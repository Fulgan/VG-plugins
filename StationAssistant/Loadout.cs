using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using BepInEx;
using Source.Player;
using Source.SpaceShip;
using VG.Loadout;

namespace StationAssistant
{
    // Per-ship loadout presets — UI glue over the SHARED VG.Loadout.LoadoutStore (one file, shared with
    // Hypercom). Scoped per playthrough + per ship; the game-facing fingerprint/finder/apply lives in the
    // shared VG.Loadout.LoadoutCore. This type only adapts the store to the Station Assistant window and
    // migrates the old per-pilot ".loadouts" files into the shared store once.
    internal static class LoadoutStore
    {
        // last-saved/applied name per ship (prefills the name field). Session-only convenience — the
        // loadouts themselves live in the shared store.
        private static readonly Dictionary<string, string> _lastName = new Dictionary<string, string>();

        private static SpaceShipData TargetShip() => GamePlayer.current?.currentSpaceShip;
        private static string Pt() => VG.Loadout.LoadoutStore.PlaythroughKey(GamePlayer.current);

        // ---- one-time migration of the old per-pilot files into the shared store ----
        private static readonly HashSet<string> _migrated = new HashSet<string>();
        private static string Dir => Path.Combine(Paths.ConfigPath, "StationAssistant");
        private static void MigrateActivePilotOnce()
        {
            var key = GameSettings.ActiveKey ?? "default";
            if (!_migrated.Add(key)) return;
            try
            {
                var f = Path.Combine(Dir, Sanitize(key) + ".loadouts");
                if (!File.Exists(f)) return;
                var pt = Pt(); // assume the active pilot == the current playthrough
                var entries = new List<LoadoutEntry>();
                LoadoutEntry cur = null;
                foreach (var line in File.ReadAllLines(f))
                {
                    var c = line.Split('\t');
                    if (c.Length == 0) continue;
                    if (c[0] == "S" && c.Length >= 3) { cur = null; _shipGuidForMigration = c[1]; }
                    else if (c[0] == "P" && c.Length >= 2 && _shipGuidForMigration != null)
                    {
                        cur = new LoadoutEntry { playthrough = pt, shipGuid = _shipGuidForMigration, name = c[1], gear = new LoadoutPreset { name = c[1] } };
                        entries.Add(cur);
                    }
                    else if (c[0] == "T" && cur != null && c.Length >= 13)
                    {
                        int.TryParse(c[7], out var lvl); int.TryParse(c[9], out var asc);
                        cur.gear.slots.Add(new LoadoutSlot
                        {
                            kind = c[1], slot = c[2], identifier = c[3], type = c[4], name = c[5], rarity = c[6],
                            level = lvl, size = c[8], aspectSlotCount = asc, mainStat = c[10],
                            aspects = SplitList(c[11]), stats = SplitList(c[12]),
                        });
                    }
                }
                VG.Loadout.LoadoutStore.Seed(entries);
                File.Move(f, f + ".migrated");
                Plugin.Log.LogInfo($"[StationAssistant] migrated {entries.Count} loadout(s) into the shared store.");
            }
            catch (Exception ex) { Plugin.Log.LogWarning($"loadout migration failed: {ex.Message}"); }
        }
        private static string _shipGuidForMigration;
        private static List<string> SplitList(string s) => string.IsNullOrEmpty(s) ? new List<string>() : new List<string>(s.Split('|'));
        private static string Sanitize(string s)
        {
            foreach (var c in Path.GetInvalidFileNameChars()) s = s.Replace(c, '_');
            return string.IsNullOrEmpty(s) ? "default" : s;
        }

        // Stable-ordered loadouts for the current ship.
        private static List<LoadoutEntry> Entries()
        {
            MigrateActivePilotOnce();
            var ship = TargetShip();
            if (ship == null) return new List<LoadoutEntry>();
            return VG.Loadout.LoadoutStore.ForShip(Pt(), ship.guid).OrderBy(e => e.name, StringComparer.OrdinalIgnoreCase).ToList();
        }

        // ---- API used by the settings window ----

        internal static List<LoadoutPreset> Current(out string shipLabel, out string shipGuid)
        {
            shipLabel = null; shipGuid = null;
            try
            {
                var ship = TargetShip();
                if (ship == null) return new List<LoadoutPreset>();
                shipGuid = ship.guid;
                shipLabel = !string.IsNullOrEmpty(ship.customShipName) ? ship.customShipName
                    : (ship.shipClass?.displayName ?? ship.guid);
                return Entries().Select(e => e.gear).ToList();
            }
            catch (Exception ex) { Plugin.Log.LogWarning($"loadouts read failed: {ex.Message}"); return new List<LoadoutPreset>(); }
        }

        internal static bool SaveCurrent(string name)
        {
            try
            {
                var ship = TargetShip();
                if (ship == null) return false;
                name = string.IsNullOrEmpty(name) ? "Loadout" : name.Trim();
                var gear = LoadoutCore.Snapshot(ship, name);
                var label = !string.IsNullOrEmpty(ship.customShipName) ? ship.customShipName : (ship.shipClass?.displayName ?? ship.guid);
                VG.Loadout.LoadoutStore.Put(new LoadoutEntry { playthrough = Pt(), shipGuid = ship.guid, shipLabel = label, name = name, gear = gear });
                _lastName[ship.guid] = name;
                return true;
            }
            catch (Exception ex) { Plugin.Log.LogWarning($"loadout save failed: {ex.Message}"); return false; }
        }

        internal static string LastName()
        {
            var ship = TargetShip();
            return ship != null && _lastName.TryGetValue(ship.guid, out var n) ? n : "";
        }

        internal static LoadoutPreset FindByName(string name)
        {
            var ship = TargetShip();
            if (ship == null || string.IsNullOrEmpty(name)) return null;
            return VG.Loadout.LoadoutStore.Get(Pt(), ship.guid, name)?.gear;
        }

        internal static bool? MatchesCurrent(LoadoutPreset p) => LoadoutCore.MatchesCurrent(TargetShip(), p);

        internal static void Delete(int index)
        {
            try
            {
                var ship = TargetShip();
                if (ship == null) return;
                var list = Entries();
                if (index < 0 || index >= list.Count) return;
                VG.Loadout.LoadoutStore.Remove(Pt(), ship.guid, list[index].name);
            }
            catch (Exception ex) { Plugin.Log.LogWarning($"loadout delete failed: {ex.Message}"); }
        }

        // Per-slot preview — only changed lines (equip / no-match); "keep" omitted; empty → "no change".
        internal static List<string> Preview(LoadoutPreset p)
        {
            var lines = new List<string>();
            var ship = TargetShip();
            if (ship == null) { lines.Add(Loc.T("loadout.noShip")); return lines; }
            foreach (var e in LoadoutCore.BuildPlan(ship, p))
            {
                var where = e.source != null && e.source == ship.cargo ? "cargo" : "armory";
                switch (e.status)
                {
                    case "equip": lines.Add(Loc.F("loadout.pv.equip", e.slot.kind, e.slot.slot,
                        string.IsNullOrEmpty(e.chosen.displayName) ? e.slot.name : e.chosen.displayName, where)); break;
                    case "none": lines.Add(Loc.F("loadout.pv.none", e.slot.kind, e.slot.slot, e.slot.name)); break;
                }
            }
            if (lines.Count == 0) lines.Add(Loc.T("loadout.pv.nochange"));
            return lines;
        }

        // Additive apply via the shared core; localizes the result.
        internal static string Apply(LoadoutPreset p)
        {
            var ship = TargetShip();
            var r = LoadoutCore.Apply(ship, p);
            switch (r.status)
            {
                case ApplyStatus.NoShip: return Loc.T("loadout.noShip");
                case ApplyStatus.NotDocked: return Loc.T("loadout.notDocked");
                case ApplyStatus.Echo: return Loc.T("loadout.echo");
            }
            if (ship != null) _lastName[ship.guid] = p.name;
            return Loc.F("loadout.applied", r.changed);
        }
    }
}
