using System;
using System.Collections.Generic;
using System.Globalization;
using Behaviour.Equipment;
using Behaviour.Item;
using Source.Galaxy.POI;
using Source.Item;
using Source.Player;
using Source.SpaceShip;
using UnityEngine;

// Shared SOURCE (compiled into both StationAssistant and Hypercom via
//   <Compile Include="..\Shared\LoadoutCore.cs" Link="LoadoutCore.cs" />
// — no shared DLL, no runtime coupling). Holds the game-facing loadout logic: fingerprint capture,
// the item finder, and additive apply/undo. Loc-free (returns structured data; each mod formats) and
// logs via UnityEngine.Debug. Persistence + UI text stay in each mod.
namespace VG.Loadout
{
    // Best-effort item fingerprint. Rolled gear has no stable id, so a slot is matched by identity
    // invariants (type, size, level, aspect-slot count, main-stat value) + rarity/aspects/substats.
    [Serializable]
    public sealed class LoadoutSlot
    {
        public string kind;             // "Turret" | "Module" | "Booster"
        public string slot;             // EquipmentSlot name (modules) or index (turrets/boosters)
        public string identifier;
        public string type;             // equipment component class name
        public string name;
        public string rarity;
        public int level;
        public string size;
        public string mainStat = "";
        public int aspectSlotCount;
        public List<string> aspects = new List<string>();
        public List<string> stats = new List<string>(); // "Stat=amount:cr" (cr = canReroll 1/0)
    }

    [Serializable]
    public sealed class LoadoutPreset
    {
        public string name;
        public List<LoadoutSlot> slots = new List<LoadoutSlot>();
    }

    // One officer→slot request (officers keyed by stable OfficerData.guid; empty guid = clear the slot).
    public sealed class OfficerAssign
    {
        public int slot;
        public string guid;
    }

    // Undo bookkeeping: the prior occupant of a touched slot, captured at apply time.
    public sealed class SlotPrior
    {
        public LoadoutSlot slot;
        public InventoryItemType prior; // gear item previously in the slot (null = was empty)
    }

    public sealed class OfficerPrior
    {
        public int slot;
        public string priorGuid; // officer guid previously in the slot (null/empty = was empty)
    }

    // A single applied transient's touched slots + their prior occupants — the unit of undo (§V26).
    public sealed class AppliedTransient
    {
        public string shipGuid;
        public List<SlotPrior> gear = new List<SlotPrior>();
        public List<OfficerPrior> officers = new List<OfficerPrior>();
    }

    // An exact-handle gear equip (no finder): the caller already resolved the item + its source store.
    public sealed class DirectSlot
    {
        public string kind;              // "Turret" | "Module" | "Booster"
        public int slot;                 // array index (turret/booster)
        public string slotName;          // EquipmentSlot name (modules only — they're keyed by slot, not index)
        public InventoryItemType item;   // the exact item to equip
        public Inventory source;         // store to pull it from
    }

    // One planned slot change (structured; the caller renders/localizes).
    public sealed class PlanEntry
    {
        public LoadoutSlot slot;
        public InventoryItemType chosen; // item to equip (null for keep/none)
        public Inventory source;         // where `chosen` comes from (cargo or armory)
        public string status;            // "keep" | "equip" | "none"
    }

    public enum ApplyStatus { Ok, NoShip, NotDocked, Echo }

    public struct ApplyResult
    {
        public ApplyStatus status;
        public int changed;
    }

    public static class LoadoutCore
    {
        // Module slots to snapshot. Hardpoint/Booster are array-based (handled separately). HangarBay is
        // beta-only, so it's added by reflection only when the enum defines it (keeps one binary valid on
        // both game versions).
        public static readonly EquipmentSlot[] ModuleSlots = BuildModuleSlots();
        private static EquipmentSlot[] BuildModuleSlots()
        {
            var list = new List<EquipmentSlot>
            {
                EquipmentSlot.Reactor, EquipmentSlot.ShieldGenerator, EquipmentSlot.Armor, EquipmentSlot.Engine,
                EquipmentSlot.DroneBay, EquipmentSlot.MiningSystem, EquipmentSlot.SalvageSystem,
                EquipmentSlot.TractorBeam, EquipmentSlot.Scanner, EquipmentSlot.TopedoBay, EquipmentSlot.Hull,
            };
            try { if (Enum.IsDefined(typeof(EquipmentSlot), "HangarBay")) list.Add((EquipmentSlot)Enum.Parse(typeof(EquipmentSlot), "HangarBay")); } catch { }
            return list.ToArray();
        }

        // ---- fingerprint ----

        public static LoadoutPreset Snapshot(SpaceShipData ship, string name)
        {
            var p = new LoadoutPreset { name = name };
            if (ship.hardpoints != null)
                for (var i = 0; i < ship.hardpoints.Length; i++)
                    if (ship.hardpoints[i] != null) p.slots.Add(Describe(ship.hardpoints[i], "Turret", i.ToString()));
            foreach (var slot in ModuleSlots)
            {
                var it = ship.GetEquippedItem(slot);
                if (it != null) p.slots.Add(Describe(it, "Module", slot.ToString()));
            }
            if (ship.boosters != null)
                for (var i = 0; i < ship.boosters.Length; i++)
                    if (ship.boosters[i] != null) p.slots.Add(Describe(ship.boosters[i], "Booster", i.ToString()));
            return p;
        }

        public static LoadoutSlot Describe(InventoryItemType item, string kind, string slot)
        {
            var eq = item.GetComponent<AbstractEquipment>();
            var s = new LoadoutSlot
            {
                kind = kind,
                slot = slot,
                identifier = item.identifier ?? "",
                name = string.IsNullOrEmpty(item.displayName) ? (item.identifier ?? "?") : item.displayName,
                rarity = item.rarity.ToString(),
                level = item.itemLevel,
                type = eq != null ? eq.GetType().Name : "",
                size = eq != null ? eq.size.ToString() : "",
                aspectSlotCount = eq?.aspectSlots?.Count ?? 0,
                mainStat = MainStatKey(eq),
            };
            if (eq != null)
            {
                foreach (var a in eq.aspectSlots)
                    if (a?.equipAspect != null) s.aspects.Add(a.equipAspect.identifier);
                try
                {
                    foreach (var line in eq.GetStats())
                        s.stats.Add($"{line.stat}={Fmt(line.amount)}:{(line.canReroll ? 1 : 0)}");
                }
                catch { }
            }
            return s;
        }

        // Culture-invariant, drift-tolerant (default ToString varies by culture + last-digit across
        // sessions from baked-stat recompute; 3 decimals kills drift, keeps rolls distinct).
        public static string Fmt(float v) => v.ToString("0.###", CultureInfo.InvariantCulture);

        public static string MainStatKey(AbstractEquipment eq)
        {
            try { var m = eq?.GetMainStat(); return m != null ? (m.mainStatAmount ?? "") : ""; }
            catch { return ""; }
        }

        // ---- finder ----

        // 2 = exact (same item / identical roll); 1 = upgrade (same base, quality up / rerolled substat);
        // 0 = no match. Invariants: type, size, level, aspect-slot count, main-stat value.
        public static int Score(InventoryItemType item, LoadoutSlot slot)
        {
            var eq = item.GetComponent<AbstractEquipment>();
            if (eq == null) return 0;
            if (eq.GetType().Name != slot.type) return 0;
            if (eq.size.ToString() != slot.size) return 0;
            if (item.itemLevel != slot.level) return 0;
            if ((eq.aspectSlots?.Count ?? 0) != slot.aspectSlotCount) return 0;
            if (MainStatKey(eq) != slot.mainStat) return 0;

            var d = Describe(item, slot.kind, slot.slot);
            if (item.rarity.ToString() == slot.rarity && SameSet(d.aspects, slot.aspects) && SameSet(d.stats, slot.stats))
                return 2;
            if (RarityRank(item.rarity) >= RarityRank(slot.rarity) && LockedSubset(slot.stats, d.stats))
                return 1;
            return 0;
        }

        private static int RarityRank(Rarity r) => (int)r;
        private static int RarityRank(string r) => Enum.TryParse(r, out Rarity x) ? (int)x : -1;

        private static bool SameSet(List<string> a, List<string> b)
        {
            if (a.Count != b.Count) return false;
            var rest = new List<string>(b);
            foreach (var x in a)
                if (!rest.Remove(x)) return false;
            return true;
        }

        // Locked (canReroll=false, "...:0") substats of the target must be present in the candidate with
        // the same stat+value (reroll flag ignored).
        private static bool LockedSubset(List<string> target, List<string> cand)
        {
            var vals = new HashSet<string>();
            foreach (var s in cand) vals.Add(StripCr(s));
            foreach (var s in target)
                if (s.EndsWith(":0") && !vals.Contains(StripCr(s))) return false;
            return true;
        }

        private static string StripCr(string s) { var i = s.LastIndexOf(':'); return i >= 0 ? s.Substring(0, i) : s; }

        public static InventoryItemType CurrentItem(SpaceShipData ship, LoadoutSlot slot)
        {
            try
            {
                switch (slot.kind)
                {
                    case "Turret": { var i = int.Parse(slot.slot); return ship.hardpoints != null && i < ship.hardpoints.Length ? ship.hardpoints[i] : null; }
                    case "Booster": { var i = int.Parse(slot.slot); return ship.boosters != null && i < ship.boosters.Length ? ship.boosters[i] : null; }
                    default: return Enum.TryParse(slot.slot, out EquipmentSlot es) ? ship.GetEquippedItem(es) : null;
                }
            }
            catch { return null; }
        }

        // True if the ship currently matches the preset on every slot it covers (exact). Null = no ship.
        public static bool? MatchesCurrent(SpaceShipData ship, LoadoutPreset p)
        {
            if (ship == null || p == null) return null;
            foreach (var slot in p.slots)
            {
                var cur = CurrentItem(ship, slot);
                if (cur == null || Score(cur, slot) < 2) return false;
            }
            return true;
        }

        // Additive plan: per slot → keep (already exact) / equip (exact, else the single unambiguous
        // upgrade) / none. Never touches slots the preset omits.
        public static List<PlanEntry> BuildPlan(SpaceShipData ship, LoadoutPreset p)
        {
            var pool = new List<KeyValuePair<InventoryItemType, Inventory>>();
            void Add(Inventory inv)
            {
                if (inv?.items == null) return;
                foreach (var it in inv.items)
                    if (it?.item != null) pool.Add(new KeyValuePair<InventoryItemType, Inventory>(it.item, inv));
            }
            Add(GamePlayer.current?.globalInventory);
            Add(ship.cargo);

            var used = new HashSet<InventoryItemType>();
            var plan = new List<PlanEntry>();
            foreach (var slot in p.slots)
            {
                var cur = CurrentItem(ship, slot);
                if (cur != null && Score(cur, slot) == 2) { plan.Add(new PlanEntry { slot = slot, status = "keep" }); continue; }

                InventoryItemType chosen = null; Inventory chosenInv = null;
                foreach (var kv in pool)
                    if (!used.Contains(kv.Key) && Score(kv.Key, slot) == 2) { chosen = kv.Key; chosenInv = kv.Value; break; }

                if (chosen == null)
                {
                    var ups = new List<KeyValuePair<InventoryItemType, Inventory>>();
                    foreach (var kv in pool)
                        if (!used.Contains(kv.Key) && Score(kv.Key, slot) == 1) ups.Add(kv);
                    if (ups.Count == 1) { chosen = ups[0].Key; chosenInv = ups[0].Value; }
                }

                if (chosen != null) { used.Add(chosen); plan.Add(new PlanEntry { slot = slot, chosen = chosen, source = chosenInv, status = "equip" }); }
                else plan.Add(new PlanEntry { slot = slot, status = "none" });
            }
            return plan;
        }

        // ---- apply ----

        // Additive apply: equip each plan's chosen item, return displaced gear to armory, rebuild ship.
        // Gated: docked + not ECHO. The caller localizes the returned status.
        public static ApplyResult Apply(SpaceShipData ship, LoadoutPreset p)
        {
            if (ship == null) return new ApplyResult { status = ApplyStatus.NoShip };
            if (SpaceStation.current == null) return new ApplyResult { status = ApplyStatus.NotDocked };
            if (GamePlayer.current.currentAutopilotSessionStats != null) return new ApplyResult { status = ApplyStatus.Echo };

            var armory = GamePlayer.current.globalInventory;
            var changed = 0;
            foreach (var e in BuildPlan(ship, p))
            {
                if (e.status != "equip" || e.chosen == null) continue;
                try
                {
                    e.source?.Remove(e.chosen, 1);
                    var displaced = EquipToData(ship, e.slot, e.chosen);
                    if (displaced != null) armory?.Add(displaced, 1);
                    changed++;
                }
                catch (Exception ex) { Debug.LogWarning($"[VG.Loadout] apply {e.slot.kind}{e.slot.slot} failed: {ex.Message}"); }
            }
            if (changed > 0) RefreshView(ship);
            return new ApplyResult { status = ApplyStatus.Ok, changed = changed };
        }

        private static InventoryItemType EquipToData(SpaceShipData ship, LoadoutSlot slot, InventoryItemType item)
        {
            switch (slot.kind)
            {
                case "Turret": { var i = int.Parse(slot.slot); var old = ship.hardpoints[i]; ship.hardpoints[i] = item; return old; }
                case "Booster": { var i = int.Parse(slot.slot); var old = ship.boosters[i]; ship.boosters[i] = item; return old; }
                default: return ship.EquipModule(item, (EquipmentSlot)Enum.Parse(typeof(EquipmentSlot), slot.slot));
            }
        }

        // Rebuild the hangar preview from edited data (ShowShip(true) re-instantiates it → refreshes the
        // picture); reinit the in-world ship when the edited ship is the active one.
        public static void RefreshView(SpaceShipData target)
        {
            try { Behaviour.UI.Spacestation.Location.PersonalHangar.current?.shipSelect?.ShowShip(true); }
            catch (Exception ex) { Debug.LogWarning($"[VG.Loadout] hangar preview refresh failed: {ex.Message}"); }

            if (target == GamePlayer.current?.currentSpaceShip)
            {
                try { GameplayManager.Instance.ReinitPlayerSpaceship(); }
                catch (Exception ex) { Debug.LogWarning($"[VG.Loadout] ship reinit failed: {ex.Message}"); }
            }
        }

        // ---- transient apply / undo (§V23-V28) ----

        // Set a slot to `item` (null clears it) and return the previous occupant. Modules go through
        // EquipModule/RemoveModuleOfType; hardpoints/boosters are array slots. Neither touches inventory
        // — the caller moves items in/out of the armory itself, so apply and undo stay symmetric.
        private static InventoryItemType SetSlot(SpaceShipData ship, LoadoutSlot slot, InventoryItemType item)
        {
            switch (slot.kind)
            {
                case "Turret": { var i = int.Parse(slot.slot); var old = ship.hardpoints[i]; ship.hardpoints[i] = item; return old; }
                case "Booster": { var i = int.Parse(slot.slot); var old = ship.boosters[i]; ship.boosters[i] = item; return old; }
                default:
                {
                    var es = (EquipmentSlot)Enum.Parse(typeof(EquipmentSlot), slot.slot);
                    var old = ship.GetEquippedItem(es);
                    if (item == null) ship.RemoveModuleOfType(es); else ship.EquipModule(item, es);
                    return old;
                }
            }
        }

        // Apply a partial, additive transient: equip each gear slot's best match (finder plan) and assign
        // officers by guid. Touches ONLY the pushed slots; captures each prior occupant for undo (§V23,
        // V26). Displaced gear goes to the armory. Officers gate on `crewSupported` (§V28). Returns the
        // undo record (null only if there is no ship); `changed` = # slots actually altered.
        public static AppliedTransient ApplyTransient(SpaceShipData ship, LoadoutPreset gear, List<OfficerAssign> officers, bool crewSupported, out int changed)
        {
            changed = 0;
            if (ship == null) return null;
            var t = new AppliedTransient { shipGuid = ship.guid };
            var armory = GamePlayer.current?.globalInventory;

            if (gear != null)
                foreach (var e in BuildPlan(ship, gear))
                {
                    if (e.status != "equip" || e.chosen == null) continue;
                    try
                    {
                        var prior = SetSlot(ship, e.slot, e.chosen);
                        e.source?.Remove(e.chosen, 1);
                        if (prior != null) armory?.Add(prior, 1);
                        t.gear.Add(new SlotPrior { slot = e.slot, prior = prior });
                        changed++;
                    }
                    catch (Exception ex) { Debug.LogWarning($"[VG.Loadout] apply gear {e.slot.kind}{e.slot.slot} failed: {ex.Message}"); }
                }

            // Officer assignment lives in ApplyOfficers (touches SpaceShipData.officers/OfficerData) and is
            // only invoked when crewSupported — so it never JITs on a game version without the Personnel
            // crew API. See doc/game-version-api-diff.md.
            if (crewSupported && officers != null)
                changed += ApplyOfficers(ship, officers, t);

            if (changed > 0) RefreshView(ship);
            return t;
        }

        // Assign officers by guid to their slots on the ship, recording undo entries. Isolated so its
        // OfficerData typeref only resolves on crew-capable versions (caller gates on crewSupported).
        private static int ApplyOfficers(SpaceShipData ship, List<OfficerAssign> officers, AppliedTransient t)
        {
            if (ship.officers == null) return 0;
            var changed = 0;
            // Snapshot the ORIGINAL occupants before any mutation so undo restores true originals
            // regardless of how assigns + single-slot dedupe interleave. One undo entry per touched slot.
            var original = new string[ship.officers.Length];
            for (var i = 0; i < original.Length; i++) original[i] = ship.officers[i]?.guid;
            var touched = new HashSet<int>();

            foreach (var oa in officers)
            {
                if (oa == null || oa.slot < 0 || oa.slot >= ship.officers.Length) continue;
                try
                {
                    var next = string.IsNullOrEmpty(oa.guid) ? null : GamePlayer.current?.GetOfficer(oa.guid);
                    if (!string.IsNullOrEmpty(oa.guid) && next == null) continue; // unknown guid → skip
                    // An officer can hold only one slot on this ship — vacate any other slot it occupies.
                    if (next != null)
                        for (var i = 0; i < ship.officers.Length; i++)
                            if (i != oa.slot && ship.officers[i] == next) { touched.Add(i); ship.officers[i] = null; }
                    touched.Add(oa.slot);
                    ship.officers[oa.slot] = next;
                    changed++;
                }
                catch (Exception ex) { Debug.LogWarning($"[VG.Loadout] assign officer slot {oa.slot} failed: {ex.Message}"); }
            }

            foreach (var i in touched)
                t.officers.Add(new OfficerPrior { slot = i, priorGuid = original[i] });
            return changed;
        }

        // Restore the touched slots of the last applied transient to their prior occupants (§V26). Gear:
        // re-equip the prior item (pulled back from the armory) and return the currently-equipped item to
        // the armory. Officers: reassign the prior guid. Returns # slots restored.
        public static int Undo(AppliedTransient t)
        {
            if (t == null) return 0;
            var ship = FindShip(t.shipGuid);
            if (ship == null) return 0;
            var armory = GamePlayer.current?.globalInventory;
            var restored = 0;

            foreach (var g in t.gear)
            {
                try
                {
                    if (g.prior != null) armory?.Remove(g.prior, 1); // apply put it here; take it back onto the ship
                    var applied = SetSlot(ship, g.slot, g.prior);    // prior null → unequip
                    if (applied != null) armory?.Add(applied, 1);
                    restored++;
                }
                catch (Exception ex) { Debug.LogWarning($"[VG.Loadout] undo gear {g.slot.kind}{g.slot.slot} failed: {ex.Message}"); }
            }

            // Officer undo is isolated in UndoOfficers (OfficerData typeref). t.officers is only ever
            // populated by ApplyOfficers, which runs solely on crew-capable versions — so on other
            // versions this stays empty and UndoOfficers never JITs.
            if (t.officers.Count > 0)
                restored += UndoOfficers(ship, t);

            if (restored > 0) RefreshView(ship);
            return restored;
        }

        // Reassign each recorded prior officer guid to its slot. Isolated (see ApplyOfficers).
        private static int UndoOfficers(SpaceShipData ship, AppliedTransient t)
        {
            if (ship.officers == null) return 0;
            var restored = 0;
            foreach (var o in t.officers)
            {
                if (o.slot < 0 || o.slot >= ship.officers.Length) continue;
                try { ship.officers[o.slot] = string.IsNullOrEmpty(o.priorGuid) ? null : GamePlayer.current?.GetOfficer(o.priorGuid); restored++; }
                catch (Exception ex) { Debug.LogWarning($"[VG.Loadout] undo officer slot {o.slot} failed: {ex.Message}"); }
            }
            return restored;
        }

        // Equip exact items into slots (no finder) — for gear the caller already resolved (store + item).
        // Displaced gear goes to the armory; prior occupants captured for undo. Same undo path as gear.
        public static AppliedTransient ApplyDirect(SpaceShipData ship, List<DirectSlot> slots, out int changed)
        {
            changed = 0;
            if (ship == null || slots == null) return null;
            var t = new AppliedTransient { shipGuid = ship.guid };
            var armory = GamePlayer.current?.globalInventory;
            foreach (var d in slots)
            {
                if (d?.item == null) continue;
                try
                {
                    var ls = new LoadoutSlot { kind = d.kind, slot = d.kind == "Module" ? (d.slotName ?? "") : d.slot.ToString() };
                    var prior = SetSlot(ship, ls, d.item);
                    if (prior == d.item) continue; // already in this slot — no-op
                    d.source?.Remove(d.item, 1);
                    if (prior != null) armory?.Add(prior, 1);
                    t.gear.Add(new SlotPrior { slot = ls, prior = prior });
                    changed++;
                }
                catch (Exception ex) { Debug.LogWarning($"[VG.Loadout] direct equip {d.kind}{d.slot} failed: {ex.Message}"); }
            }
            if (changed > 0) RefreshView(ship);
            return t;
        }

        // Locate an owned ship by guid (current ship first, then the owned fleet).
        public static SpaceShipData FindShip(string guid)
        {
            var p = GamePlayer.current;
            if (p == null || string.IsNullOrEmpty(guid)) return null;
            if (p.currentSpaceShip?.guid == guid) return p.currentSpaceShip;
            if (p.spaceShips != null)
                foreach (var s in p.spaceShips)
                    if (s?.guid == guid) return s;
            return null;
        }
    }
}
