using System;
using System.Collections;
using System.Collections.Generic;
using System.Linq;
using System.Reflection;
using Behaviour.Equipment.Builder;
using Behaviour.Equipment.Module;
using Behaviour.Equipment.Turret;
using Behaviour.Unit;
using Source.Util;
using Behaviour.Equipment.Aspect;
using UnityEngine;

namespace Hypercom
{
    // Equipment catalog: the TEMPLATES that instances are rolled from — `EquipmentBuilder` (recipe) +
    // its `EquipmentBuilderStat` children (per-stat roll band + level/rarity scaling). This is the
    // version-stable definition, NOT rolled instances: a concrete item's stat is a roll in
    // [minValue, maxValue] scaled by level (levelScaling) and rarity (rarityScaling). Stamped with the
    // game version so two builds can be diffed. Reflection is used for the builder's private lists.
    internal static class Catalog
    {
        private static readonly FieldInfo AllBuildersF =
            typeof(EquipmentBuilder).GetField("allBuilders", BindingFlags.NonPublic | BindingFlags.Static);
        private static readonly FieldInfo MainStatsF =
            typeof(EquipmentBuilder).GetField("mainStats", BindingFlags.NonPublic | BindingFlags.Instance);
        private static readonly FieldInfo OptStatsF =
            typeof(EquipmentBuilder).GetField("optionalStats", BindingFlags.NonPublic | BindingFlags.Instance);

        internal static Dictionary<string, object> EquipmentDto()
        {
            var builders = new List<object>();
            var all = AllBuildersF?.GetValue(null) as IDictionary;
            if (all != null)
                foreach (var v in all.Values)
                    if (v is EquipmentBuilder b)
                    {
                        try { builders.Add(BuilderDto(b)); }
                        catch (Exception ex) { Plugin.Log.LogWarning($"[Hypercom] catalog builder failed: {ex.Message}"); }
                    }

            builders.Sort((a, z) => string.CompareOrdinal(
                (string)((Dictionary<string, object>)a)["identifier"],
                (string)((Dictionary<string, object>)z)["identifier"]));

            return new Dictionary<string, object>
            {
                ["gameVersion"] = Application.version,
                ["count"] = builders.Count,
                ["builders"] = builders,
            };
        }

        // Distinct turret types (by category + damage) and module slots that EXIST in the game — so the
        // gear filters can offer any type, not just owned/equipped ones. Light + non-debug.
        internal static Dictionary<string, object> TypesDto()
        {
            var turrets = new Dictionary<string, Dictionary<string, object>>();
            var damage = new SortedSet<string>(StringComparer.Ordinal);
            var modules = new SortedSet<string>(StringComparer.Ordinal);
            var all = AllBuildersF?.GetValue(null) as IDictionary;
            if (all != null)
                foreach (var v in all.Values)
                {
                    if (!(v is EquipmentBuilder b)) continue;
                    try
                    {
                        var prefab = b.prefab;
                        var t = prefab != null ? prefab.GetComponent<AbstractTurret>() : null;
                        if (t != null)
                        {
                            var type = t.typeDisplayName;
                            var dmg = t.damageType.ToString();
                            var cat = t.powerStat.ToString(); // CombatPower/MiningPower/SalvagePower
                            var category = cat.StartsWith("Combat") ? "Combat" : cat.StartsWith("Mining") ? "Mining" : cat.StartsWith("Salvage") ? "Salvage" : "Other";
                            if (!string.IsNullOrEmpty(type) && !turrets.ContainsKey(type))
                                turrets[type] = new Dictionary<string, object> { ["type"] = type, ["category"] = category, ["damageType"] = dmg };
                            if (!string.IsNullOrEmpty(dmg)) damage.Add(dmg);
                        }
                        else modules.Add(b.slot.ToString());
                    }
                    catch { }
                }
            return new Dictionary<string, object>
            {
                ["turrets"] = turrets.Values.OrderBy(d => (string)d["type"], StringComparer.Ordinal).ToList<object>(),
                ["damageTypes"] = damage.ToList(),
                ["moduleSlots"] = modules.ToList(),
            };
        }

        /// <summary>
        /// The PREFAB CONSTANTS behind the recipes — serialized component fields that no roll ever touches.
        ///
        /// `EquipmentBuilder` decides a stat LINE; these decide how the item BEHAVES, and the two are stored
        /// differently: `BuildInitialStats` writes `EquipStatLine`s into `equip.stats`, while `resistAmount`,
        /// `weakTypes`, `fireRate` and the firing cycle are serialized on the prefab and are identical for
        /// every instance of it. That is why they belong here and not in `EquipmentDto` — and why they are the
        /// same for an NPC's armor as for the player's, since both instantiate the same prefab and both run
        /// `ArmorModule.ApplyArmorResistance`. There is no NPC variant to observe separately.
        ///
        /// Read off the TEMPLATE, so no ship need be loaded and nothing here depends on the save. Anything
        /// reaching through `parent` would throw on a prefab (`GetExpectedDps` does) ∴ only plain serialized
        /// fields and parent-free properties are read, each guarded so one bad member cannot empty the dump.
        /// </summary>
        internal static Dictionary<string, object> PrefabsDto()
        {
            var armor = new List<object>();
            var shield = new List<object>();
            var torpedo = new List<object>();
            var turrets = new List<object>();

            var all = AllBuildersF?.GetValue(null) as IDictionary;
            if (all != null)
                foreach (var v in all.Values)
                {
                    if (!(v is EquipmentBuilder b)) continue;
                    try
                    {
                        var prefab = b.prefab;
                        if (prefab == null) continue;

                        var t = prefab.GetComponent<AbstractTurret>();
                        if (t != null) { turrets.Add(TurretPrefabDto(b, t)); continue; }

                        var a = prefab.GetComponent<ArmorModule>();
                        if (a != null) { armor.Add(ArmorPrefabDto(b, a)); continue; }

                        var s = prefab.GetComponent<ShieldGeneratorModule>();
                        if (s != null) { shield.Add(ShieldPrefabDto(b, s)); continue; }

                        var tb = prefab.GetComponent<TorpedoBayModule>();
                        if (tb != null) torpedo.Add(TorpedoPrefabDto(b, tb));
                    }
                    catch (Exception ex) { Plugin.Log.LogWarning($"[Hypercom] prefab dump failed for {b.identifier}: {ex.Message}"); }
                }

            return new Dictionary<string, object>
            {
                ["gameVersion"] = Application.version,
                ["armor"] = armor,
                ["shieldGenerator"] = shield,
                ["torpedoBay"] = torpedo,
                ["turrets"] = turrets,
                // The NPC rank ladder. Rank scales an enemy's speed, HP and power (`AbstractUnit`'s
                // `npcAffectedStats`/`npcHealthAffectedStats`) but NOT its resists, so "an enemy of level N"
                // is not one set of numbers and anything modelling a target needs the ladder itself.
                ["unitRank"] = UnitRankDto(),
            };
        }

        /// <summary>
        /// Every hull in the game with the slots it carries — `SpaceShip.allShips`, which is the SAME pool NPC
        /// ships are drawn from (`GetNPCShipTypes` filters it by point value and role, and nothing else).
        ///
        /// It exists to settle one question that decides how much the damage-type rule is worth: HOW OFTEN
        /// DOES A TARGET HAVE ARMOR RATHER THAN A SHIELD? Armor is the only layer with a type table
        /// (`weakTypes`/`resistAmount`); a shield absorbs 1:1 and is blind to damage type ∴ the Corrosion
        /// advantage applies to the armored fraction and to nothing else. Counting the PLAYER's own ships
        /// answers a different and biased question — what one player bought and kept.
        ///
        /// Slots only, no sprite maths: `/ship/layout` owns the positional read for ONE ship, and this owns the
        /// inventory read for ALL of them. ⚠ `GetStat` on a template returns pre-equipment numbers that are
        /// plausible and wrong (api §934) ∴ only the SCALES and the slot arrays are read here.
        /// </summary>
        internal static Dictionary<string, object> ShipsDto()
        {
            var ships = new List<object>();
            foreach (var kv in SpaceShip.GetAll())
            {
                var s = kv.Value;
                if (s == null) continue;
                try
                {
                    var modules = new List<object>();
                    var mslots = s.moduleSlots;
                    if (mslots != null)
                        foreach (var m in mslots)
                            if (m != null)
                                modules.Add(new Dictionary<string, object>
                                {
                                    ["slot"] = m.slot.ToString(),
                                    ["size"] = m.size.ToString(),
                                });

                    var hardpoints = new List<object>();
                    var hslots = s.hardpointSlots;
                    if (hslots != null)
                        foreach (var h in hslots)
                            if (h != null) hardpoints.Add(h.size.ToString());

                    ships.Add(new Dictionary<string, object>
                    {
                        ["identifier"] = kv.Key,
                        ["displayName"] = s.displayName,
                        // The HP SCALES, not the stats: effective HP is `scale * 150|300|300` before equipment.
                        // A zero scale with a matching slot is a data error the game itself asserts on.
                        ["hullHPScale"] = s.hullHPScale,
                        ["armorHPScale"] = s.armorHPScale,
                        ["shieldHPScale"] = s.shieldHPScale,
                        // EVERY filter `Faction.GetNPCShipTypes` applies, so a caller can reproduce the exact
                        // enemy pool instead of assuming one. It keeps a hull only when
                        // `pointValue ∈ [min,max] && !noRandomSpawn && IsNPCShipAvailable(...)`, where the last
                        // is `shipRoleType.GetGameplayType() == activity` — so a COMBAT spawn draws only from
                        // combat-role hulls — and then prefers the faction's own ships over allied ones.
                        // Without these, counting armor vs shield over all 156 answers a question nobody asked.
                        ["pointValue"] = s.pointValue,
                        ["roleType"] = Compat.Get(s, "shipRoleType")?.ToString(),
                        ["gameplayType"] = Compat.Call(Compat.Get(s, "shipRoleType"), "GetGameplayType")?.ToString(),
                        ["noRandomSpawn"] = Compat.Get(s, "noRandomSpawn"),
                        // `CategoriseShipIntoCollection` sorts on these: a hull whose prereq names the spawning
                        // faction is an "own ship" and is preferred over allied and fallback.
                        ["factionPrereq"] = FactionPrereqNames(s),
                        ["modules"] = modules,
                        ["hardpoints"] = hardpoints,
                    });
                }
                catch (Exception ex) { Plugin.Log.LogWarning($"[Hypercom] ship catalog failed for {kv.Key}: {ex.Message}"); }
            }

            ships.Sort((a, z) => string.CompareOrdinal(
                (string)((Dictionary<string, object>)a)["identifier"],
                (string)((Dictionary<string, object>)z)["identifier"]));

            return new Dictionary<string, object>
            {
                ["gameVersion"] = Application.version,
                ["count"] = ships.Count,
                ["ships"] = ships,
            };
        }

        // The faction names on a hull's shop prerequisites, which is what decides whether a spawning faction
        // treats it as its OWN ship. Read by name and tolerant of an empty list: a hull with no prereq falls
        // through to `fallbackShips` rather than being unavailable.
        private static List<object> FactionPrereqNames(SpaceShip s)
        {
            var names = new List<object>();
            var data = Compat.Get(s, "shopItemData");
            foreach (var p in Compat.Enumerate(Compat.Get(data, "factionPrereq")))
            {
                var fn = Compat.Get(Compat.Get(p, "reqFaction"), "name");
                names.Add(fn == null ? null : Stores.Text(fn.ToString()));
            }
            return names;
        }

        private static Dictionary<string, object> ArmorPrefabDto(EquipmentBuilder b, ArmorModule a)
            => new Dictionary<string, object>
            {
                ["identifier"] = b.identifier ?? "?",
                ["size"] = b.equipmentSize.ToString(),
                // A flat fraction off any damage type NOT in `weakTypes`.
                ["resistAmount"] = a.resistAmount,
                // A type in this set is AMPLIFIED by `weakAmount` and skips the resist entirely — the branch
                // returns early, so armor is never both weak and resistant to the same type.
                ["weakTypes"] = a.weakTypes == null ? new List<object>() : a.weakTypes.Select(x => (object)x.ToString()).ToList(),
                ["weakAmount"] = a.weakAmount,
                ["overrideBaseCapacity"] = a.overrideBaseCapacity,
            };

        private static Dictionary<string, object> ShieldPrefabDto(EquipmentBuilder b, ShieldGeneratorModule s)
            => new Dictionary<string, object>
            {
                ["identifier"] = b.identifier ?? "?",
                ["size"] = b.equipmentSize.ToString(),
                // The tick path: every `tickDelay` seconds once `rechargeDelay` has elapsed, the shield regains
                // `maxShieldHP * rechargePerTick * rechargeRate`. ⚠ `DamagePrevention` resets that delay on
                // EVERY incoming hit, so under sustained fire this path never runs at all.
                ["rechargeRate"] = s.rechargeRate,
                ["rechargeDelay"] = s.rechargeDelay,
                ["overrideBaseCapacity"] = s.overrideBaseCapacity,
                // Consts, echoed so a balance change to either shows up in a dump diff rather than silently.
                ["tickDelay"] = Compat.PrivateStaticNum(typeof(ShieldGeneratorModule), "tickDelay"),
                ["rechargePerTick"] = Compat.PrivateStaticNum(typeof(ShieldGeneratorModule), "rechargePerTick"),
            };

        private static Dictionary<string, object> TorpedoPrefabDto(EquipmentBuilder b, TorpedoBayModule tb)
            => new Dictionary<string, object>
            {
                ["identifier"] = b.identifier ?? "?",
                ["size"] = b.equipmentSize.ToString(),
                // ⚠ `fireRate` is a PERIOD in seconds (`nextFireTime = Time.time + fireRate`), not a rate.
                //
                // Read by NAME rather than through the `FireRate` property: that property is beta-only
                // (`the build checks` reports `get_FireRate` absent on release), and a hard reference to it
                // would throw `MissingMethodException` the first time this method is JITted on that branch —
                // taking the whole dump down rather than leaving one field null.
                ["fireRate"] = Compat.PrivateNum(tb, "fireRate"),
                ["reloadSpeed"] = Compat.PrivateNum(tb, "reloadSpeed"),
            };

        private static Dictionary<string, object> TurretPrefabDto(EquipmentBuilder b, AbstractTurret t)
        {
            var d = new Dictionary<string, object>
            {
                ["identifier"] = b.identifier ?? "?",
                ["size"] = b.equipmentSize.ToString(),
                ["type"] = t.typeDisplayName,
                ["damageType"] = t.damageType.ToString(),
                ["powerMultiplier"] = t.powerMultiplier,
                // The firing cycle's INPUTS. `defaultAttacksPerSecond` is derived from exactly these and reads
                // the raw fields with no stat modifiers, which is why it is safe to compute from a template.
                ["fireDelay"] = Compat.PrivateNum(t, "_fireDelay"),
                ["reloadDelay"] = Compat.PrivateNum(t, "_reloadDelay"),
                ["maxMagSize"] = Compat.PrivateNum(t, "_maxMagSize"),
                ["burstAmount"] = t.burstAmount,
                ["burstDelay"] = t.burstDelay,
                ["ammoPerShot"] = t.ammoPerShot,
                // Geometry, which the optimizer deliberately does not price — served so that stays a CHOICE
                // rather than an absence of data.
                ["range"] = Compat.PrivateNum(t, "_range"),
                ["projectileSpeed"] = Compat.PrivateNum(t, "_projectileSpeed"),
                ["rotationSpeed"] = Compat.PrivateNum(t, "_rotationSpeed"),
                ["accuracyAngle"] = t.accuracyAngle,
                ["maxFiringAngle"] = t.maxFiringAngle,
            };
            // Parent-free properties, but still guarded: a future override could reach through `parent`, and a
            // throw here would cost the whole dump rather than one field.
            try { d["shotsPerAmmo"] = t.shotsPerAmmo; } catch { d["shotsPerAmmo"] = null; }
            try { d["defaultAttacksPerSecond"] = t.defaultAttacksPerSecond; } catch { d["defaultAttacksPerSecond"] = null; }
            try { d["turretEquivalentRating"] = t.turretEquivalentRating; } catch { d["turretEquivalentRating"] = null; }
            try { d["powerStat"] = t.powerStat.ToString(); } catch { d["powerStat"] = null; }
            return d;
        }

        // `UnitRankHelper`'s ladders, by rank. Private statics, so read by name and reported as whatever is
        // there — a build adding a rank lengthens these arrays rather than breaking the shape.
        private static Dictionary<string, object> UnitRankDto()
        {
            var d = new Dictionary<string, object>();
            foreach (var name in new[] { "statMultiplier", "additionMultiplier", "hpMultiplier", "pointMultiplier" })
            {
                var raw = Compat.PrivateStaticGet(typeof(UnitRankHelper), name);
                var list = new List<object>();
                foreach (var x in Compat.Enumerate(raw)) list.Add(Compat.AsNumber(x));
                d[name] = list;
            }
            d["ranks"] = Enum.GetNames(typeof(UnitRank)).ToList();
            return d;
        }

        private static Dictionary<string, object> BuilderDto(EquipmentBuilder b)
        {
            // damage type / power stat come from the base item's turret component (if it's a turret).
            string damageType = null, powerStat = null;
            var prefab = b.prefab;
            var turret = prefab != null ? prefab.GetComponent<AbstractTurret>() : null;
            if (turret != null) { damageType = turret.damageType.ToString(); powerStat = turret.powerStat.ToString(); }

            return new Dictionary<string, object>
            {
                ["identifier"] = b.identifier ?? "?",
                ["slot"] = b.slot.ToString(),
                ["size"] = b.equipmentSize.ToString(),
                ["minLevel"] = b.minLevel,
                ["maxLevel"] = b.maxLevel,
                ["rarities"] = Rarities(b),
                ["inGeneralShop"] = Compat.Get(b, "IncludedInGeneralShop"), // beta-only
                ["damageType"] = damageType,
                ["powerStat"] = powerStat,
                ["mainStats"] = Stats(MainStatsF?.GetValue(b) as IEnumerable),
                ["optionalStats"] = Stats(OptStatsF?.GetValue(b) as IEnumerable),
            };
        }

        private static List<string> Rarities(EquipmentBuilder b)
        {
            var r = new List<string>();
            if (b.rarityStandard) r.Add("Standard");
            if (b.rarityEnhanced) r.Add("Enhanced");
            if (b.rarityHighGrade) r.Add("HighGrade");
            if (b.rarityExotic) r.Add("Exotic");
            if (b.rarityLegendary) r.Add("Legendary");
            return r;
        }

        private static List<object> Stats(IEnumerable stats)
        {
            var list = new List<object>();
            if (stats == null) return list;
            foreach (var o in stats)
            {
                if (!(o is EquipmentBuilderStat s)) continue;
                list.Add(new Dictionary<string, object>
                {
                    ["stat"] = s.stat.ToString(),
                    ["isMainStat"] = s.isMainStat,
                    ["isMultiplier"] = s.isMultiplier,
                    ["minValue"] = s.minValue,
                    ["maxValue"] = s.maxValue,
                    ["levelScaling"] = s.levelScaling,
                    ["rarityScaling"] = s.rarityScaling,
                    ["spawnWeight"] = s.spawnWeight,
                    ["minSpawnLevel"] = s.minSpawnLevel,
                });
            }
            return list;
        }

        /// <summary>
        /// `GET /catalog/aspects` — the numbers an aspect ACTS BY, which live on its prefab and nowhere else.
        ///
        /// An aspect's magnitude is Unity asset data: `PayloadTurretExtraDamage.damagePercentage` is a
        /// `[SerializeField] private float`, `DamageOverTime.tickDelay`/`tickCount` are serialized too. A
        /// decompiler prints the FIELD and never the VALUE, so only a runtime read produces them — which is why
        /// the client had to parse magnitudes out of description prose and scored 0 for every aspect whose text
        /// carries no number.
        ///
        /// GENERIC OVER THE PAYLOAD, deliberately: every component beside the aspect is dumped with its numeric
        /// serialized fields, keyed by the component's own type name. A new aspect family then needs no change
        /// here — the alternative is a hand-written field list per payload, which is a table that goes stale on
        /// the balance patch nobody notices.
        /// </summary>
        internal static Api.Result AspectsDto()
        {
            try
            {
                var list = new List<object>();
                foreach (var a in Resources.LoadAll<EquipAspect>("EquipAspects"))
                {
                    if (a == null || string.IsNullOrEmpty(a.identifier)) continue;
                    string desc;
                    try { desc = Stores.StripTags(a.description); } catch { desc = ""; }

                    var payloads = new List<object>();
                    foreach (var c in a.GetComponentsInChildren<MonoBehaviour>(true))
                    {
                        // Skip the BASE aspect component only. `is EquipAspect` also caught SUBCLASSES, and the
                        // subclass is where several families keep their numbers — `BossClusterPayload` carries the
                        // cadence triple and the drone-bay aspects their counts, so all of them dumped empty.
                        if (c == null || c.GetType() == typeof(EquipAspect)) continue;
                        var nums = SerializedNumbers(c);
                        if (nums.Count == 0) continue;
                        payloads.Add(new Dictionary<string, object>
                        {
                            // The COMPONENT TYPE is the mechanism: a client has to tell an extra hit from a DoT
                            // from a cadence change, and that distinction is exactly what the component is.
                            ["kind"] = c.GetType().Name,
                            ["values"] = nums,
                        });
                    }
                    list.Add(new Dictionary<string, object>
                    {
                        ["id"] = a.identifier,
                        ["name"] = Stores.AspectName(a.identifier),
                        ["description"] = desc,
                        // Empty, never absent: "carries no payload numbers" and "was not dumped" are different
                        // claims and a consumer must be able to tell them apart.
                        ["payloads"] = payloads,
                    });
                }
                list.Sort((x, z) => string.CompareOrdinal(
                    (string)((Dictionary<string, object>)x)["id"],
                    (string)((Dictionary<string, object>)z)["id"]));
                return Api.Result.Ok(new Dictionary<string, object>
                {
                    ["gameVersion"] = Application.version,
                    ["count"] = list.Count,
                    ["aspects"] = list,
                });
            }
            catch (Exception e) { return Api.Result.Err(500, e.Message); }
        }

        /// <summary>
        /// Every numeric or enum field a component serializes, its own and its bases'.
        ///
        /// Walks the hierarchy by hand because `GetFields` does not return a base type's NON-PUBLIC members, and
        /// the interesting ones are `[SerializeField] private` — reflecting only the declared type would return
        /// an empty set for exactly the payloads worth reading. Object references are skipped: a prefab pointer
        /// serialises as a name that means nothing outside the running game.
        /// </summary>
        private static Dictionary<string, object> SerializedNumbers(object c)
        {
            var d = new Dictionary<string, object>();
            for (var t = c.GetType(); t != null && t != typeof(MonoBehaviour); t = t.BaseType)
                foreach (var f in t.GetFields(BindingFlags.Instance | BindingFlags.Public | BindingFlags.NonPublic
                                              | BindingFlags.DeclaredOnly))
                {
                    if (d.ContainsKey(f.Name)) continue;
                    object v;
                    try { v = f.GetValue(c); } catch { continue; }
                    var ft = f.FieldType;
                    if (ft == typeof(float) || ft == typeof(int) || ft == typeof(bool) || ft == typeof(double))
                        d[f.Name] = v;
                    else if (ft.IsEnum)
                        d[f.Name] = v == null ? null : v.ToString();
                }
            return d;
        }
    }
}
