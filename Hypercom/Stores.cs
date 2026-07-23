using System;
using System.Collections;
using System.Collections.Generic;
using System.Linq;
using System.Reflection;
using Behaviour.Crew;
using Behaviour.Equipment;
using Behaviour.Equipment.Builder;
using Behaviour.Equipment.Turret;
using Behaviour.Item;
using Source.Data;
using Source.Galaxy.POI;
using Source.Item;
using Source.Personnel;
using Source.Player;
using Source.SpaceShip;
using Source.Util;

namespace Hypercom
{
    // Bridge between the game inventories and the JSON DTOs. All methods assume they run on the
    // Unity main thread (called only from inside MainThread.Run).
    internal static class Stores
    {
        internal const string Cargo = "cargo";
        internal const string Armory = "armory";
        internal const string Material = "material";

        internal static readonly string[] All = { Cargo, Armory, Material };

        // Resolve a store id to its Inventory, or null if unavailable (e.g. material while undocked).
        internal static Inventory Resolve(string id)
        {
            var player = GamePlayer.current;
            switch (id)
            {
                case Cargo: return player?.currentSpaceShip?.cargo;
                case Armory: return player?.globalInventory;
                case Material: return SpaceStation.current?.materialStorage;
                default: return null;
            }
        }

        internal static bool IsValidStore(string id) => id == Cargo || id == Armory || id == Material;

        // The inventory entry at the given slot. Null if none.
        // slot (InventoryItem.slot) is the stable, unique per-entry handle — unlike identifier,
        // which is null on rolled equipment (~95% of items), so it can't be a key.
        internal static Inventory.InventoryItem FindEntry(Inventory inv, int slot)
        {
            if (inv?.items == null)
                return null;
            foreach (var e in inv.items)
                if (e?.item != null && e.slot == slot)
                    return e;
            return null;
        }

        // ---- DTOs ----

        internal static Dictionary<string, object> StoreDto(string id, Inventory inv)
        {
            var items = new List<object>();
            if (inv?.items != null)
                foreach (var e in inv.items)
                    if (e?.item != null)
                    {
                        var dto = ItemDto(e.item, e.slot);
                        dto["count"] = e.count;
                        items.Add(dto);
                    }
            return new Dictionary<string, object> { ["id"] = id, ["items"] = items };
        }

        // Shared item DTO: handle (store slot) + identity + aspects + effective stat block from
        // AbstractEquipment.GetStats(). `slot` is the actionable handle; null for loadout (read-only).
        internal static Dictionary<string, object> ItemDto(InventoryItemType item, int? slot = null)
        {
            var dto = new Dictionary<string, object>
            {
                ["key"] = slot,   // pass this back as `key` to /move,/sell (or /buy for shops)
                ["slot"] = slot,
                ["identifier"] = item.identifier,
                ["name"] = string.IsNullOrEmpty(item.displayName) ? item.identifier : item.displayName,
                ["rarity"] = item.rarity.ToString(),
                ["level"] = item.itemLevel,
                ["category"] = item.itemCategory.ToString(),
                ["sellValue"] = item.sellValue,
                ["volume"] = item.m3,
            };

            var eq = SafeGetEquipment(item);
            dto["slotType"] = eq != null ? eq.slot.ToString() : null; // Hardpoint (weapons), Reactor, ShieldGenerator, …
            dto["mainStat"] = MainStatDto(eq);

            // Turret-only tooltip fields.
            var turret = eq as AbstractTurret;
            dto["damageType"] = turret != null ? turret.damageType.ToString() : null;
            dto["gameplayType"] = turret != null ? turret.gameplayType.ToString() : null;  // Combat | Mining | Salvage
            dto["targetLayer"] = turret != null ? turret.targetLayer.ToString() : null;    // Surface | Core | Both (mining/salvage)
            dto["fireRate"] = turret != null ? (object)turret.defaultAttacksPerSecond : null;
            dto["ammo"] = turret?.ammoType != null
                ? (string.IsNullOrEmpty(turret.ammoType.displayName) ? turret.ammoType.identifier : turret.ammoType.displayName)
                : null;
            // Sustained ammo used per minute: shots/sec (already includes burst + reload) × 60 ×
            // ammoPerShot ÷ shotsPerAmmo. Null when the turret uses no ammo. Match the game: one cargo
            // round removed (ammoPerShot) every shotsPerAmmo shots.
            dto["ammoPerMin"] = turret?.ammoType != null
                ? (object)(turret.defaultAttacksPerSecond * 60f * turret.ammoPerShot / System.Math.Max(1, turret.shotsPerAmmo))
                : null;

            // Power usage (energy draw) — matches the game tooltip: energyDraw when fitted (uses the
            // ship's draw multiplier + aspects), else the base capacityCost. EMP factor (turrets only,
            // 0 when the turret has no EMP charge). Both are effective/derived, not item identity.
            dto["powerUsage"] = eq != null ? (object)(eq.parent != null ? eq.energyDraw : eq.capacityCost) : null;
            dto["emp"] = turret != null ? Compat.Get(turret, "empPerSecond") : null; // beta-only
            dto["range"] = turret != null ? (object)turret.range : null;             // _range × (1 + WeaponRange)
            var mf = item.GetManufacturer();                                          // brand, e.g. "Spirit Design"
            dto["manufacturer"] = mf.HasValue ? mf.Value.GetDisplayName() : null;

            dto["size"] = eq != null ? eq.size.ToString() : null;
            dto["type"] = TypeName(eq); // modules → readable slot name; turrets/boosters → class name
            dto["aspects"] = Aspects(eq);
            dto["aspectSlots"] = eq?.aspectSlots?.Count ?? 0; // slot count is fixed per item (identity)
            dto["stats"] = Stats(eq);
            dto["substats"] = Substats(eq);                              // "item bonuses" — non-main stat lines
            dto["bonus"] = eq != null ? Compat.Get(eq, "qualityLevel") : null; // workshop quality (beta-only)
            dto["bonusStat"] = BonusStat(eq);                             // the stat the quality affix boosts
            dto["resonance"] = ResonanceDto(item);                        // resonant boosters only, else null
            return dto;
        }

        // Resonant-booster progress + unlock bonus (null for non-resonant / when the feature doesn't exist
        // in this game build). Reflection-only (ResonantBooster is beta-only) so one binary runs on both.
        private static Dictionary<string, object> ResonanceDto(InventoryItemType item)
        {
            var rb = Compat.GetComponent(item, "Behavior.Equipment.Booster.ResonantBooster");
            if (rb == null) return null;
            try
            {
                var ub = Compat.Get(rb, "unlockBonus"); // EquipStatLine
                string bonus = Compat.Call(ub, "ToReadableString") as string;
                var stat = ub != null ? Compat.Get(ub, "stat") : null;
                if (bonus == null && stat is EquipStat es) bonus = StatName(es);
                var req = Compat.Get(rb, "requirementType");
                return new Dictionary<string, object>
                {
                    ["unlocked"] = Compat.Get(rb, "IsUnlocked"),
                    ["progress"] = Compat.Get(rb, "unlockProgress"),
                    ["threshold"] = Compat.Get(rb, "unlockThreshold"),
                    ["unit"] = ResonanceUnit(req?.ToString()),
                    ["bonus"] = bonus,
                    ["bonusStat"] = stat is EquipStat es2 ? StatName(es2) : null,
                };
            }
            catch { return null; }
        }
        private static string ResonanceUnit(string req) => req switch
        {
            "EnemiesKilled" => "kills", "ShipsBoarded" => "boardings", "OreMined" => "ore",
            "ScrapSalvaged" => "scrap", "TradeProfitEarned" => "profit", "DamageAbsorbed" => "absorbed", _ => "progress",
        };

        // The game's readable equipment type ("Hailfire M-Launcher", "Plasma Beam", "Reactor", …).
        private static string TypeName(AbstractEquipment eq) => eq != null ? eq.typeDisplayName : null;

        // Readable stat name matching the in-game display (EquipStat.GetDisplayName equivalent).
        private static string StatName(EquipStat stat) => Translate("@EquipStat" + stat, stat.ToString());

        private static AbstractEquipment SafeGetEquipment(InventoryItemType item)
        {
            try { return item.GetComponent<AbstractEquipment>(); }
            catch { return null; }
        }

        private static List<object> Aspects(AbstractEquipment eq)
        {
            var list = new List<object>();
            if (eq?.aspectSlots == null)
                return list;
            foreach (var slot in eq.aspectSlots)
            {
                var asp = slot?.equipAspect;
                if (asp == null || string.IsNullOrEmpty(asp.identifier))
                    continue;
                string desc;
                try { desc = StripTags(asp.description); } catch { desc = ""; } // .description fills {0} args
                list.Add(new Dictionary<string, object> { ["name"] = AspectName(asp.identifier), ["description"] = desc });
            }
            return list;
        }

        // Readable aspect name via the game's translation table (key "@Aspect<id>").
        private static string AspectName(string id) => Translate("@Aspect" + id, id);

        // Strip TextMeshPro rich-text tags (<color=…>, <b>, …) for plain-text display.
        private static string StripTags(string s)
            => string.IsNullOrEmpty(s) ? s : System.Text.RegularExpressions.Regex.Replace(s, "<[^>]+>", "");

        private static string Translate(string key, string fallback)
        {
            try
            {
                var s = Translation.Translate(key);
                return string.IsNullOrEmpty(s) || s == key ? fallback : s;
            }
            catch { return fallback; }
        }

        // Main stat (e.g. "Combat Power" + "4,338"), translated. Null for items without one.
        private static Dictionary<string, object> MainStatDto(AbstractEquipment eq)
        {
            if (eq == null)
                return null;
            try
            {
                var m = eq.GetMainStat();
                if (m == null)
                    return null;
                return new Dictionary<string, object>
                {
                    ["name"] = Translate(m.mainStatName, m.mainStatName),
                    ["amount"] = m.mainStatAmount,
                };
            }
            catch { return null; }
        }

        // Substats ("item bonuses"): the item's stat lines minus its main stat.
        private static List<object> Substats(AbstractEquipment eq)
        {
            var list = new List<object>();
            if (eq == null)
                return list;
            try
            {
                foreach (var pair in eq.GetStatsWithIndex(includeMainStat: false))
                    list.Add(new Dictionary<string, object>
                    {
                        ["stat"] = StatName(pair.stat.stat),
                        ["amount"] = pair.stat.amount,
                        ["multiplier"] = pair.stat.multiplier,
                        ["canReroll"] = pair.stat.canReroll,
                    });
            }
            catch (Exception ex)
            {
                Plugin.Log.LogWarning($"substats failed for an item: {ex.Message}");
            }
            return list;
        }

        // Name of the stat the quality bonus (qualityBonusStatIndex) applies to, or null.
        private static string BonusStat(AbstractEquipment eq)
        {
            if (eq == null)
                return null;
            try
            {
                if (!(Compat.Get(eq, "qualityBonusStatIndex") is int idx)) return null; // beta-only
                if (idx < 0)
                    return null;
                var stats = eq.GetStats().ToList();
                return idx < stats.Count ? stats[idx].stat.ToString() : null;
            }
            catch { return null; }
        }

        // Effective, per-item stat lines (baked scaling) straight from the game (V15/V16).
        private static List<object> Stats(AbstractEquipment eq)
        {
            var list = new List<object>();
            if (eq == null)
                return list;
            try
            {
                foreach (var s in eq.GetStats())
                    list.Add(new Dictionary<string, object>
                    {
                        ["stat"] = StatName(s.stat),
                        ["amount"] = s.amount,
                        ["multiplier"] = s.multiplier,
                        ["canReroll"] = s.canReroll,
                    });
            }
            catch (Exception ex)
            {
                Plugin.Log.LogWarning($"GetStats failed for an item: {ex.Message}");
            }
            return list;
        }

        // ---- loadout (current ship, read-only) ----

        private static FieldInfo _equipmentField;

        internal static Dictionary<string, object> LoadoutDto(SpaceShipData ship)
        {
            if (ship == null)
                return new Dictionary<string, object> { ["error"] = "no ship" };

            // Each equipped hardpoint/booster carries its `slot` index (the total slot count includes
            // empty slots, so the UI can lay out per-slot columns + address slots for apply).
            var hardpoints = new List<object>();
            if (ship.hardpoints != null)
                for (var i = 0; i < ship.hardpoints.Length; i++)
                    if (ship.hardpoints[i] != null) { var d = ItemDto(ship.hardpoints[i]); d["slot"] = i; hardpoints.Add(d); }

            var boosters = new List<object>();
            if (ship.boosters != null)
                for (var i = 0; i < ship.boosters.Length; i++)
                    if (ship.boosters[i] != null) { var d = ItemDto(ship.boosters[i]); d["slot"] = i; boosters.Add(d); }

            var roleType = ship.shipClass?.shipRoleType;
            return new Dictionary<string, object>
            {
                ["shipGuid"] = ship.guid,
                // Unrenamed ships have no customShipName — fall back to the type name, not the guid.
                ["name"] = !string.IsNullOrEmpty(ship.customShipName) ? ship.customShipName
                    : (ship.shipClass?.displayName ?? ship.guid),
                ["shipType"] = ship.shipClass?.displayName, // ship class, e.g. "Chisel Mk I"
                ["role"] = roleType != null ? roleType.GetRole().ToString() : null,
                ["hardpoints"] = hardpoints,
                ["hardpointSlots"] = ship.hardpoints?.Length ?? 0,
                ["modules"] = Modules(ship),
                ["boosters"] = boosters,
                ["boosterSlots"] = ship.boosters?.Length ?? 0, // total incl. empty
            };
        }

        // All owned ships (read-only) — GamePlayer.spaceShips holds every ship's saved loadout.
        internal static List<object> ShipsDto()
        {
            var list = new List<object>();
            var ships = GamePlayer.current?.spaceShips;
            if (ships == null)
                return list;
            foreach (var s in ships)
                if (s != null) list.Add(LoadoutDto(s));
            return list;
        }

        // ---- officers (crew roster, read-only) ----
        // These methods reference the Source.Personnel crew API (OfficerData). They are ONLY called from
        // Api.Officers()/Recruits(), which gate on CrewSupported() — so on a game version without this
        // API they never JIT and can't TypeLoad. See doc/game-version-api-diff.md.

        // {ships:[{shipGuid, slots, hasDroneBay, assigned:[guid?]}], officers:[officer]}.
        internal static Dictionary<string, object> OfficersDto()
        {
            var p = GamePlayer.current;

            var ships = new List<object>();
            if (p?.spaceShips != null)
                foreach (var s in p.spaceShips)
                {
                    if (s == null) continue;
                    var assigned = new List<object>();
                    if (s.officers != null)
                        foreach (var o in s.officers)
                            assigned.Add(o?.guid);
                    ships.Add(new Dictionary<string, object>
                    {
                        ["shipGuid"] = s.guid,
                        ["slots"] = s.officers?.Length ?? 0,
                        ["hasDroneBay"] = s.HasDroneBay(),
                        ["assigned"] = assigned,
                    });
                }

            var officers = new List<object>();
            if (p?.officers != null)
                foreach (var o in p.officers)
                    if (o != null) officers.Add(OfficerDto(o));

            return new Dictionary<string, object> { ["ships"] = ships, ["officers"] = officers };
        }

        // Recruitable officers at the docked station's Personnel Center + hire cost.
        internal static Dictionary<string, object> RecruitsDto()
        {
            var st = SpaceStation.current;
            var pc = st?.personnelCenter;
            var list = new List<object>();
            if (pc != null)
            {
                pc.EnsureOfficersPopulated(); // generate/refresh the recruit roster (as the game panel does)
                foreach (var o in pc.officers)
                    if (o != null)
                    {
                        var d = OfficerDto(o);
                        d["hireCost"] = o.purchaseCost;
                        list.Add(d);
                    }
            }
            return new Dictionary<string, object>
            {
                ["station"] = st?.name,
                ["hasPersonnelCenter"] = pc != null,
                ["officers"] = list,
            };
        }

        // One officer: identity + rarity/level + the skills it grants. `current` = slots enabled at the
        // officer's level (unlockedNodes); `potential` = all rolled slots (skillNodes, max level).
        private static Dictionary<string, object> OfficerDto(OfficerData o)
        {
            return new Dictionary<string, object>
            {
                ["guid"] = o.guid,
                ["name"] = o.GetFullName(),
                ["callsign"] = o.callsign,
                ["profession"] = o.profession.ToString(),
                ["rarity"] = o.rarity.ToString(),
                ["level"] = o.level,
                ["gender"] = o.gender.ToString(),
                ["icon"] = o.icon?.identifier,
                ["chosenBonus"] = o.chosenBonus.ToString(),
                ["bonusValue"] = SafeBonus(o), // effective passive bonus for the chosen stat (fraction)
                ["current"] = OfficerSkills(o, includeLocked: false),
                ["potential"] = OfficerSkills(o, includeLocked: true),
            };
        }

        // Officer's effective passive bonus for its chosen stat (game calc; fraction). No stat chosen
        // (chosenBonus == None) → no passive bonus, regardless of what the game returns.
        private static float SafeBonus(OfficerData o)
        {
            try { return o.chosenBonus.ToString() == "None" ? 0f : o.GetBonusForStat(o.chosenBonus); } catch { return 0f; }
        }

        // Each skill = the captain node it grants. `major` marks the powerful single-slot skills; the
        // rest stack. `unlock` = the level the slot activates at. `includeLocked=false` → active slots only.
        private static List<object> OfficerSkills(OfficerData o, bool includeLocked)
        {
            var list = new List<object>();
            var nodes = o.skillNodes;
            if (nodes == null) return list;
            for (var i = 0; i < nodes.Count; i++)
            {
                var n = nodes[i];
                if (n == null) continue;
                var unlock = (o.skillUnlockLevels != null && i < o.skillUnlockLevels.Count)
                    ? o.skillUnlockLevels[i] : n.crewLevelRequired;
                if (!includeLocked && unlock > o.level) continue;
                list.Add(new Dictionary<string, object>
                {
                    ["id"] = n.identifier,
                    ["name"] = Translate(n.displayName, n.identifier),
                    ["tier"] = n.tier,
                    ["major"] = n.skillNodeLevel == SkillNodeLevel.MajorOfficer,
                    ["unlock"] = unlock,
                });
            }
            return list;
        }

        // Equipped modules with their slot. `equipment` is a private Dictionary<EquipmentSlot,
        // InventoryItemType> on AbstractUnitData — reflected (cached) to recover the slot per module.
        private static List<object> Modules(AbstractUnitData ship)
        {
            var list = new List<object>();
            _equipmentField ??= typeof(AbstractUnitData).GetField("equipment",
                BindingFlags.Instance | BindingFlags.NonPublic);

            if (_equipmentField?.GetValue(ship) is IDictionary dict)
            {
                foreach (DictionaryEntry kv in dict)
                {
                    if (kv.Value is InventoryItemType item)
                        list.Add(new Dictionary<string, object>
                        {
                            ["slot"] = kv.Key?.ToString(),
                            ["item"] = ItemDto(item),
                        });
                }
                return list;
            }

            // Fallback: values only, no slot info.
            foreach (var m in ship.equippedModules)
                if (m != null)
                    list.Add(new Dictionary<string, object> { ["slot"] = null, ["item"] = ItemDto(m) });
            return list;
        }
    }
}
