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

        // What each store is actually for — the game keeps them strictly separated:
        //   cargo    ship hold: what you're carrying right now
        //   armory   player-wide: ammo and equipment
        //   material STATION-LOCAL, materials ONLY — each starbase has its own, which is the "where is my
        //            stuff" problem the Stuff tab answers
        //
        // Deliberately NOT included: `GamePlayer.dataInventory` (beta-only, a fourth store). It holds
        // blueprints, sell-only oddments and crafting fragments — nothing worth optimising or hunting for,
        // so surfacing it would be clutter.
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

        internal static bool IsValidStore(string id) => System.Array.IndexOf(All, id) >= 0;

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
                        var dto = ItemDto(e.item, e.slot, e); // the entry carries `favourite`
                        dto["count"] = e.count;
                        items.Add(dto);
                    }
            return new Dictionary<string, object> { ["id"] = id, ["items"] = items };
        }

        // Shared item DTO: handle (store slot) + identity + aspects + effective stat block from
        // AbstractEquipment.GetStats(). `slot` is the actionable handle; null for loadout (read-only).
        // `entry` is the STACK the item sits in, when there is one: `favourite` lives there rather than on
        // the type (moved in game 0.8.1.21), so it can only be reported for a store read.
        internal static Dictionary<string, object> ItemDto(InventoryItemType item, int? slot = null,
                                                          Inventory.InventoryItem entry = null)
        {
            var dto = new Dictionary<string, object>
            {
                ["key"] = slot,   // pass this back as `key` to /move,/sell (or /buy for shops)
                ["slot"] = slot,
                ["identifier"] = item.identifier,
                ["name"] = ItemName(item),
                ["rarity"] = item.rarity.ToString(),
                ["level"] = item.itemLevel,
                ["category"] = item.itemCategory.ToString(),
                ["sellValue"] = item.sellValue,
                ["volume"] = item.m3,
                // Why a client needs these: /sell refuses all of them, and a client that cannot SEE the
                // refusal has to attempt the sale to discover it. A sell list built that way proposes
                // FAVOURITED gear and is corrected by a 403 — backwards for the one mechanism a player uses
                // to protect things. `sellValue <= 0` was the only refusal visible before.
                ["canSell"] = item.canSell,
                ["missionItem"] = item.missionItem,
                ["criticalItem"] = item.criticalItem,
            };
            // Absent, ⊥ false, when nothing here can answer: "unknown" and "not favourited" are different
            // claims, and a client defaulting the second from the first would sell protected gear.
            var fav = VG.Game.ItemFlags.Favourite(entry, item);
            if (fav.HasValue) dto["favourite"] = fav.Value;

            var eq = SafeGetEquipment(item);
            dto["slotType"] = eq != null ? eq.slot.ToString() : null; // Hardpoint (weapons), Reactor, ShieldGenerator, …
            dto["mainStat"] = MainStatDto(eq);

            // Turret-only tooltip fields.
            var turret = eq as AbstractTurret;
            dto["damageType"] = turret != null ? turret.damageType.ToString() : null;
            dto["gameplayType"] = turret != null ? turret.gameplayType.ToString() : null;  // Combat | Mining | Salvage
            dto["targetLayer"] = turret != null ? turret.targetLayer.ToString() : null;    // Surface | Core | Both (mining/salvage)
            dto["fireRate"] = turret != null ? (object)turret.defaultAttacksPerSecond : null;
            // Through ItemName like every other item name: ammo `displayName` is a KEY.
            dto["ammo"] = ItemName(turret?.ammoType);
            // Sustained ammo used per minute: shots/sec (already includes burst + reload) × 60 ×
            // ammoPerShot ÷ shotsPerAmmo. Null when the turret uses no ammo. Match the game: one cargo
            // round removed (ammoPerShot) every shotsPerAmmo shots.
            dto["ammoPerMin"] = turret?.ammoType != null
                ? (object)(turret.defaultAttacksPerSecond * 60f * turret.ammoPerShot / System.Math.Max(1, turret.shotsPerAmmo))
                : null;
            AddDpsInputs(dto, turret);
            // The game's OWN per-turret figures, for a client that models this to check itself against.
            //
            // `CalculateAttackPower` is where a turret's main power stops being shared: it is
            // `displayedPower * statMultiplier + max(0, GetStat(powerStat) - GetMainPowerSum(powerStat) *
            // statMultiplier) / equivalentTurrets * turretEquivalentRating`, so only the pool MINUS every
            // turret's main power gets divided out. Any client reproducing that arithmetic is guessing until it
            // can compare against these two numbers.
            //
            // Both are meaningful only for a turret with a `parent` — an unequipped one returns 0 from
            // `GetStat` — so they are emitted only where the turret is actually fitted, rather than as a 0 that
            // reads like a real reading.
            if (turret != null && turret.parent != null)
            {
                try
                {
                    dto["attackPower"] = turret.GetAttackPower();
                    // `GetExpectedDps` is the game's display estimate: attackPower/5 x 1.025 x crit x damage
                    // bonuses, with NO fire-rate term and a LINEAR crit rather than the cascade the damage path
                    // rolls. Useful as a cross-check on the power split, ⊥ as a DPS model.
                    // Read by name: builds without it must still get the rest of the turret block.
                    if (Compat.Call(turret, "GetExpectedDps") is float dps) dto["expectedDps"] = dps;
                }
                catch (Exception ex) { Plugin.Log.LogWarning($"turret dps figures failed: {ex.Message}"); }
            }

            // Power usage (energy draw) — matches the game tooltip: energyDraw when fitted (uses the
            // ship's draw multiplier + aspects), else the base capacityCost. EMP factor (turrets only,
            // 0 when the turret has no EMP charge). Both are effective/derived, not item identity.
            dto["powerUsage"] = eq != null ? (object)(eq.parent != null ? eq.energyDraw : eq.capacityCost) : null;
            // The SAME figure for every item, fitted or not. `powerUsage` above is effective when the item is
            // fitted (ship draw multiplier + aspects) and base when it is in storage, so comparing an equipped
            // item against a stored one on that field alone reports a difference between two identical items.
            dto["powerUsageBase"] = eq != null ? (object)eq.capacityCost : null;
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

        // ONE shape for every stat line the bridge emits, so a field added here reaches the item's own stats, its
        // substats and its aspects' stats together.
        //
        // `percent` carries the game's OWN classification (`EquipStat.IsPercentageStat`), which is decided by
        // ranges over the enum — an Attack Speed roll of 0.0141 means +1.41%, not +0.0141. A client cannot infer
        // that from the number (0.0141 is a plausible absolute value) and must not reproduce the ranges, because
        // they shift whenever a stat is inserted into the enum.
        private static Dictionary<string, object> StatLine(EquipStat stat, float amount, float multiplier, bool? canReroll)
        {
            var d = new Dictionary<string, object>
            {
                ["stat"] = StatName(stat),
                ["amount"] = amount,
                ["multiplier"] = multiplier,
                ["percent"] = stat.IsPercentageStat(),
            };
            if (canReroll.HasValue)
                d["canReroll"] = canReroll.Value;
            return d;
        }

        private static AbstractEquipment SafeGetEquipment(InventoryItemType item)
        {
            try { return item.GetComponent<AbstractEquipment>(); }
            catch { return null; }
        }


        // Stat lines contributed by one aspect. `BoostStat` lives on the aspect's own GameObject; reached by
        // reflection so this stays typeref-free on an unconditionally served path. An unequipped aspect can
        // report a zero stack, in which case the single-stack value is what the item is worth fitted.
        private static List<object> AspectStats(object aspect)
        {
            var list = new List<object>();
            try
            {
                var t = Compat.FindType("Behaviour.Equipment.Aspect.BoostStat");
                if (t == null || aspect == null) return list;
                if (!(Compat.Call(aspect, "GetComponents", t) is System.Array comps)) return list;
                foreach (var comp in comps)
                {
                    var lines = Compat.Call(comp, "GetStats") as System.Collections.IEnumerable;
                    var any = false;
                    if (lines != null)
                        foreach (var line in lines) { Add(list, line); any = true; }
                    if (!any) Add(list, Compat.Call(comp, "GetStatLine", Compat.Get(comp, "stat")));
                }
            }
            catch { }
            return list;

            void Add(List<object> into, object line)
            {
                if (line == null) return;
                var stat = Compat.Get(line, "stat");
                var amount = Compat.AsNumber(Compat.Get(line, "amount")) ?? 0f;
                var mult = Compat.AsNumber(Compat.Get(line, "multiplier")) ?? 1f;
                if (stat == null || (amount == 0f && mult == 1f)) return;
                into.Add(StatLine((EquipStat)stat, amount, mult, null));
            }
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
                // `id` is the icon handle as well as the identity: `GET /aspects/icon?id=` renders the
                // aspect's own sprite, so the UI shows the game's art rather than a coloured placeholder.
                list.Add(new Dictionary<string, object>
                {
                    ["id"] = asp.identifier,
                    ["name"] = AspectName(asp.identifier),
                    ["description"] = desc,
                    // The STATS the aspect grants. These are invisible in the item's own `stats[]`: a stat-granting
                    // aspect is a `BoostStat`, its own `IEquipStatSource` registered on the UNIT, so `eq.GetStats()`
                    // never reports it. Without them a ranking cannot see that a reactor's "+10% reactor energy"
                    // beats a bigger reactor without one, or that an aspect granting Precision lifts every gun.
                    ["stats"] = AspectStats(asp),
                });
            }
            return list;
        }

        // Readable aspect name via the game's translation table (key "@Aspect<id>").
        private static string AspectName(string id) => Translate("@Aspect" + id, id);

        // Strip TextMeshPro rich-text tags (<color=…>, <b>, …) for plain-text display.
        private static string StripTags(string s)
            => string.IsNullOrEmpty(s) ? s : System.Text.RegularExpressions.Regex.Replace(s, "<[^>]+>", "");

        // Display text for an item. `displayName` is a localisation key ("@RarityUpgradeKitName") and
        // translates; `name` is the asset name ("ShipRarityUpgradeKit", "EmptyCell") and never does, so it is
        // only a last resort.
        internal static string ItemLabel(object item)
        {
            var display = Compat.Get<string>(item, "displayName", null);
            if (!string.IsNullOrEmpty(display)) return Text(display);
            var id = Compat.Get<string>(item, "identifier", null);
            return !string.IsNullOrEmpty(id) ? id : Compat.Get<string>(item, "name", null);
        }

        // Kept as the local name every caller already uses; the implementation is shared with the other
        // plugins (VG.Game.ItemNames) so "how do I name an item" has exactly one answer.
        internal static string Translate(string key, string fallback) => VG.Game.ItemNames.Translate(key, fallback);
        // Self-fallback form, for the common case: an untranslated key is shown raw, never blanked.
        internal static string Text(string key) => VG.Game.ItemNames.Text(key);

        // An item's display text. For ammo and materials `displayName` is a localization KEY, so this is not
        // the same string as `displayName` and must be used wherever a name reaches a person or the web UI.
        internal static string ItemName(InventoryItemType item) => VG.Game.ItemNames.Pretty(item);

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
                    ["name"] = Text(m.mainStatName),
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
                    list.Add(StatLine(pair.stat.stat, pair.stat.amount, pair.stat.multiplier, pair.stat.canReroll));
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

        // Effective, per-item stat lines (baked scaling) straight from the game.
        private static List<object> Stats(AbstractEquipment eq)
        {
            var list = new List<object>();
            if (eq == null)
                return list;
            try
            {
                foreach (var s in eq.GetStats())
                    list.Add(StatLine(s.stat, s.amount, s.multiplier, s.canReroll));
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
        // API they never JIT and can't TypeLoad.

        // {ships:[{shipGuid, slots, hasDroneBay, assigned:[guid?]}], officers:[officer]}.
        // `/officers` for a BETA build: the shared envelope (`Crew.Envelope`, one owner for the shape) over
        // `officers`, with the typed officer DTO that carries the bonuses and skills only this branch has.
        internal static Dictionary<string, object> OfficersDto()
            => Crew.Envelope("officers", o => OfficerDto((OfficerData)o));

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

        // The RAW rate components, so a client can rank turrets by output instead of by headline power.
        //
        // Why raw and not the boosted properties: `fireDelay`/`reloadDelay`/`maxMagSize` divide by
        // `GetStat(...)`, and on an EQUIPPED turret `GetStat` aggregates the ship's and crew's bonuses too.
        // Sending those would make a fitted gun outrank an identical loose one for reasons that belong to the
        // hull, not the gun. Ship- and crew-wide bonuses are the same for every candidate, so they cancel in a
        // comparison — the only thing worth sending is what varies per item, and the item's own rolls already
        // travel in `stats`/`substats` (parent-free).
        //
        // With these, a client reproduces `AbstractTurret.defaultAttacksPerSecond` and can re-run it with the
        // item's own AttackSpeed/ReloadSpeed/MagazineSize applied:
        //     group = (burstAmount - 1) * burstDelay + fireDelay
        //     cycle = ceil(magSize / burstAmount) * group + reloadDelay
        //     rate  = magSize / cycle
        private static void AddDpsInputs(Dictionary<string, object> dto, AbstractTurret turret)
        {
            if (turret == null) return;
            // Private serialized fields — the public properties of the same name are the boosted ones.
            dto["fireDelayRaw"] = Compat.PrivateNum(turret, "_fireDelay");
            dto["reloadDelayRaw"] = Compat.PrivateNum(turret, "_reloadDelay");
            dto["magSizeRaw"] = Compat.PrivateNum(turret, "_maxMagSize");
            dto["burstAmount"] = turret.burstAmount;
            dto["burstDelay"] = turret.burstDelay;
            // Mean of the per-hit spread `RandomRange(0.8f, 1.25f)`: identical for every turret, so it does not
            // affect ranking — sent because it makes a displayed estimate honest rather than 2.5% optimistic.
            dto["damageSpreadMean"] = 1.025f;
        }


    }
}
