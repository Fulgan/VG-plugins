using System;
using System.Collections.Generic;
using System.Linq;
using System.Reflection;
using Behaviour.Equipment.Module;
using Behaviour.Equipment.Turret;
using Behaviour.Unit;
using Behaviour.Weapons;
using Source.Combat;
using Source.Util;
using Source.Item;
using UnityEngine;

namespace Hypercom
{
    // A defender built to order, so a damage vector can be taken against CHOSEN resists rather than
    // against whatever enemy happened to be in front of the ship.
    //
    // The unit is a `SpaceShip` on a GameObject created INACTIVE and never activated: Unity runs no
    // Awake, OnEnable, Start or Update on an inactive hierarchy, so none of the scene wiring those
    // methods do (physics bodies, sprite renderers, shield effects, auto-action coroutines) has to
    // exist. Everything the damage chain actually reads is then set explicitly.
    //
    // The entry point is `AbstractUnit.DamagePrevention`, NOT `TakeDamage`. `TakeDamage` wraps the
    // layer chain in aggro bookkeeping, `BasePoiManager.MarkFactionPlayerHostile`, two UI singletons,
    // battle-damage sprites and the death/boarding/loot path — all of which either need a live scene
    // or change persistent world state. `DamagePrevention` reads only `shieldGeneratorModule`,
    // `armorModule` and the static `ApplyVsLayerBonus`, so it is the widest cut of the chain that can
    // run against a unit that is not in the world. The mitigation step above it is reproduced here
    // from the three lines it is, with both of its inputs reported as the game returned them.
    internal static class Arena
    {
        private static readonly PropertyInfo UnitDataP =
            typeof(AbstractUnit).GetProperty("unitData", BindingFlags.Public | BindingFlags.Instance);
        private static readonly PropertyInfo ParentP =
            typeof(Behaviour.Equipment.AbstractEquipment).GetProperty("parent", BindingFlags.Public | BindingFlags.Instance);
        private static readonly PropertyInfo LevelP =
            typeof(Source.Data.AbstractUnitData).GetProperty("level", BindingFlags.Public | BindingFlags.Instance);
        private static readonly MethodInfo SetShieldM =
            typeof(AbstractUnit).GetMethod("SetShieldGeneratorModule", BindingFlags.NonPublic | BindingFlags.Instance);
        private static readonly MethodInfo SetArmorM =
            typeof(AbstractUnit).GetMethod("SetArmorModule", BindingFlags.NonPublic | BindingFlags.Instance);
        private static readonly MethodInfo DamagePreventionM =
            typeof(AbstractUnit).GetMethod("DamagePrevention", BindingFlags.NonPublic | BindingFlags.Instance);
        private static readonly MethodInfo IncomingCapM =
            typeof(AbstractUnit).GetMethod("ApplyIncomingDamageCap", BindingFlags.NonPublic | BindingFlags.Instance);

        // Stat lines handed to the unit through the game's own aggregation, so a chosen resist reaches
        // `GetStat` by the path a real item's lines take rather than by writing `calcedStats` behind it.
        private sealed class Lines : IEquipStatSource
        {
            private readonly List<EquipStatLine> _lines = new List<EquipStatLine>();
            internal void Add(EquipStat stat, float amount) => _lines.Add(new EquipStatLine(stat, amount));
            public IEnumerable<EquipStatLine> GetStats() => _lines;
            public EquipStatLine? GetStatLine(EquipStat stat)
            {
                foreach (var l in _lines) if (l.stat == stat) return l;
                return null;
            }
            public string GetName() => "ArenaProfile";
        }

        // A constructed defender and the GameObject it has to be destroyed with.
        internal sealed class Defender : IDisposable
        {
            internal SpaceShip Unit;
            internal GameObject Root;
            internal AbstractTurret Turret;
            internal Dictionary<string, object> Built;
            public void Dispose() { if (Root != null) UnityEngine.Object.Destroy(Root); }

            // Layers back to full. A golden vector starts from full layers by construction: they are a
            // transient at the start of an engagement, so a vector taken against a half-empty shield
            // measures the previous vector as much as its own.
            internal void Reset()
            {
                Unit.currentHullHP = Unit.maxHullHP;
                Unit.currentArmorHP = Unit.maxArmorHP;
                Unit.currentShieldHP = Unit.maxShieldHP;
            }
        }

        /// <summary>
        /// Build a defender to a profile. ONE owner: `/arena/probe` and `/arena/vectors` both come
        /// through here, so a vector set cannot be captured against a differently-built unit than the
        /// one the probe reports on.
        /// </summary>
        internal static Defender Build(ArenaProfile p, string hullName = null)
        {
            var hull = PickHull(hullName);
            if (hull == null) throw new InvalidOperationException("no hull prefab named '" + hullName + "' in SpaceShip.GetAll()");

            var go = new GameObject("HypercomArenaDefender");
            go.SetActive(false);
            var d = new Defender { Root = go };
            // faction stays null: it is not Faction.player, so `IsPlayer` is false and every
            // faction-scoped branch in the chain is skipped without naming a real faction.
            var unit = go.AddComponent<SpaceShip>();
            d.Unit = unit;
            UnitDataP.GetSetMethod(true).Invoke(unit, new object[] { new Source.SpaceShip.SpaceShipData(hull, false, null) });

            // Rank and escalation tier scale a non-player unit's layers, and the level curve scales
            // everyone's, so a layer HP handed to the profile is not the layer HP the chain sees. Both
            // axes are set here and all three factors reported, or the difference reads as a bug in the
            // profile rather than as the game doing what it always does.
            var data = (Source.SpaceShip.SpaceShipData)UnitDataP.GetValue(unit);
            data.unitRank = (UnitRank)Enum.Parse(typeof(UnitRank), p.Rank.ToString());
            LevelP.GetSetMethod(true).Invoke(data, new object[] { p.Level });

            var lines = new Lines();
            lines.Add(EquipStat.HullHP, p.HullHP);
            if (p.ArmorHP > 0f) lines.Add(EquipStat.ArmorHP, p.ArmorHP);
            if (p.ShieldHP > 0f) lines.Add(EquipStat.ShieldHP, p.ShieldHP);
            if (p.DamageReduction != 0f) lines.Add(EquipStat.DamageReduction, p.DamageReduction);
            foreach (var kv in p.Resists) lines.Add(kv.Key, kv.Value);
            unit.RegisterStatSource(lines);

            // A layer with no HP gets NO module, not an empty one: `DamagePrevention` tests the module
            // reference, so an empty module and an absent one are different code paths.
            if (p.ShieldHP > 0f)
            {
                var shield = Attach<ShieldGeneratorModule>(go, unit, "Shield");
                shield.rechargeRate = p.ShieldRechargeRate;
                shield.rechargeDelay = p.ShieldRechargeDelay;
                shield.overrideBaseCapacity = 0f;
                SetShieldM.Invoke(unit, new object[] { shield });
            }
            if (p.ArmorHP > 0f)
            {
                var armor = Attach<ArmorModule>(go, unit, "Armor");
                armor.resistAmount = p.ArmorResist;
                armor.weakAmount = p.ArmorWeakAmount;
                armor.weakTypes = p.ArmorWeakTypes;
                armor.overrideBaseCapacity = 0f;
                SetArmorM.Invoke(unit, new object[] { armor });
            }

            unit.MarkStatsDirty();
            d.Built = new Dictionary<string, object>
            {
                ["hull"] = hull.name,
                ["level"] = data.level,
                ["unitRank"] = data.unitRank.ToString(),
                ["rankHpMultiplier"] = data.unitRank.GetHpMultiplier(),
                ["escalationHpMultiplier"] = EscalationHelper.GetNpcHpMultiplier(),
                ["escalationTier"] = EscalationHelper.CurrentTier,
                ["hpBalanceMultiplier"] = GameMath.HpBalanceMultiplier(data.level),
                ["maxHullHP"] = unit.maxHullHP,
                ["maxArmorHP"] = unit.maxArmorHP,
                ["maxShieldHP"] = unit.maxShieldHP,
                ["maxTotalHP"] = unit.maxTotalHP,
            };
            d.Reset();
            return d;
        }

        /// <summary>
        /// A synthetic ATTACKER carrying a chosen vs-layer roll. Built the same way as the defender —
        /// inactive GameObject, `parent` set by hand — because the alternative is waiting for the player
        /// to own a gun with the roll on it, and the axis the whole model exists to price would stay
        /// unmeasured until then. `AbstractEquipment.GetStat` is `parent.GetStat(s)` plus the turret's
        /// own lines, so the roll is registered on the attacker unit and reaches the turret through the
        /// game's own lookup rather than being written into the turret.
        /// </summary>
        internal static Defender BuildAttacker(float vsShield, float vsArmor)
        {
            var d = Build(new ArenaProfile { Name = "attacker" });
            var lines = new Lines();
            lines.Add(EquipStat.DamageVsShield, vsShield);
            lines.Add(EquipStat.DamageVsArmor, vsArmor);
            d.Unit.RegisterStatSource(lines);
            d.Unit.MarkStatsDirty();
            var turret = Attach<Behaviour.Equipment.Turret.CombatTurrets.CannonTurret>(d.Root, d.Unit, "Gun");
            d.Turret = turret;
            return d;
        }

        /// <summary>
        /// Drive one vector and report EVERY step, not only the total. A set that reports totals cannot
        /// say WHICH step a port got wrong, which is the only question a golden fixture answers.
        /// </summary>
        internal static List<object> Drive(SpaceShip unit, DamageType type, float raw, AbstractTurret src = null)
        {
            var steps = new List<object>();
            // A vector with no attacker: `power` 0 and `criticalChance` 0 make the roll and the crit
            // stack no-ops, then the amount is set outright — so the vector is EXACT and reproducible,
            // where `CalculateDamage`'s own `RandomRange(0.8, 1.25)` would not be. `sourceTurret` stays
            // null, which is also what a torpedo carries, and `ApplyVsLayerBonus` reads the turret only.
            // `sourceTurret` is READONLY and set only by this constructor, which is why an attackerless
            // vector can never exercise the vs-layer bonus however large the ship's pools are.
            var dd = src != null ? new DamageData(src) : new DamageData();
            dd.type = type;
            dd.OverrideDamageAmount(raw);
            steps.Add(Step("incoming", dd.damageAmount));

            var reduction = unit.GetStat(EquipStat.DamageReduction);
            var resist = unit.GetStat(type.GetResistStat());
            var mitigation = Mathf.Max(0.2f, 1f - reduction - resist);
            dd.OverrideDamageAmount(dd.damageAmount * mitigation);
            steps.Add(Step("mitigated", dd.damageAmount, new Dictionary<string, object>
            {
                ["damageReduction"] = reduction,
                ["typedResist"] = resist,
                ["resistStat"] = type.GetResistStat().ToString(),
                ["factor"] = mitigation,
                ["onClamp"] = mitigation <= 0.2f,
            }));

            var beforeCap = dd.damageAmount;
            IncomingCapM.Invoke(unit, new object[] { dd });
            steps.Add(Step("afterIncomingCap", dd.damageAmount, new Dictionary<string, object>
            {
                ["cap"] = unit.maxTotalHP * 0.2f,
                // Whether it FIRED, not merely what it would have been: the cap is gated on the Defense
                // milestone, and a synthetic unit has none, so reporting the ceiling alone would read as
                // an applied cap on every vector.
                ["applied"] = dd.damageAmount < beforeCap,
            }));

            DamagePreventionM.Invoke(unit, new object[] { dd });
            steps.Add(Step("afterLayers", dd.damageAmount, new Dictionary<string, object>
            {
                ["absorbedByShield"] = dd.absorbedByShield,
                ["absorbedByArmor"] = dd.absorbedByArmor,
                ["shieldLeft"] = unit.currentShieldHP,
                ["armorLeft"] = unit.currentArmorHP,
            }));
            return steps;
        }

        /// <summary>
        /// `GET /arena/probe` — the go/no-go, and nothing else. Two halves that fail
        /// independently, because a partial failure narrows the claim instead of blocking the work:
        /// the OFFENSE half needs no construction at all and reads the live battery, the DEFENDER half
        /// is the one that needs the synthetic unit.
        /// </summary>
        internal static Api.Result Probe(string hullName, string damageType, string amount, string rank, string level) => MainThread.Run(() =>
        {
            var dto = new Dictionary<string, object>
            {
                ["gameVersion"] = Application.version,
            };
            dto["offense"] = OffenseHalf();
            dto["defender"] = DefenderHalf(hullName, damageType, amount, rank, level);
            return Api.Result.Ok(dto);
        });

        /// <summary>
        /// `GET /arena/vectors` — the golden set's port is tested against, run once per game
        /// build. Every profile crossed with every damage type at two amounts, each vector starting
        /// from full layers.
        /// </summary>
        internal static Api.Result Vectors(string hullName, string amount) => MainThread.Run(() =>
        {
            var amounts = new List<float> { 10_000f };
            if (float.TryParse(amount, out var extra) && extra > 0f) amounts.Add(extra);
            else amounts.Add(5_000_000f);   // large enough to overrun a layer and to reach hull

            const float VsShield = 0.50f;
            const float VsArmor = 0.25f;
            var profiles = new List<object>();
            var vectors = new List<object>();
            using (var attacker = BuildAttacker(VsShield, VsArmor))
            foreach (var p in ArenaProfile.Canonical())
            {
                using (var d = Build(p, hullName))
                {
                    var spec = p.Spec();
                    spec["built"] = d.Built;
                    profiles.Add(spec);
                    foreach (DamageType t in Enum.GetValues(typeof(DamageType)))
                        foreach (var a in amounts)
                        {
                            d.Reset();
                            vectors.Add(new Dictionary<string, object>
                            {
                                ["profile"] = p.Name,
                                ["type"] = t.ToString(),
                                ["amount"] = a,
                                ["attacker"] = null,
                                ["steps"] = Drive(d.Unit, t, a),
                            });
                            // The same shot from a gun carrying a vs-layer roll. Paired with the
                            // attackerless one above so the bonus is the ONLY difference between them.
                            d.Reset();
                            vectors.Add(new Dictionary<string, object>
                            {
                                ["profile"] = p.Name,
                                ["type"] = t.ToString(),
                                ["amount"] = a,
                                ["attacker"] = new Dictionary<string, object>
                                {
                                    ["damageVsShield"] = attacker.Turret.GetStat(EquipStat.DamageVsShield),
                                    ["damageVsArmor"] = attacker.Turret.GetStat(EquipStat.DamageVsArmor),
                                },
                                ["steps"] = Drive(d.Unit, t, a, attacker.Turret),
                            });
                        }
                }
            }

            return Api.Result.Ok(new Dictionary<string, object>
            {
                ["gameVersion"] = Application.version,
                // The offense half reads the live battery, so a capture taken mid-recalculation would
                // pin a transient. Reported rather than refused: the DEFENDER vectors are synthetic and
                // unaffected, so a dirty read invalidates part of the set, not all of it.
                ["shipStatsSettled"] = ShipStats.IsSettled(GameplayManager.Instance?.spaceShip),
                // The escalation tier is the PLAYER'S setting and it multiplies every layer, so a set
                // captured at one tier cannot be compared against a set captured at another. Stamped
                // beside the game version for the same reason and refused the same way.
                ["escalationTier"] = EscalationHelper.CurrentTier,
                ["escalationHpMultiplier"] = EscalationHelper.GetNpcHpMultiplier(),
                ["profiles"] = profiles,
                ["vectors"] = vectors,
                // What this set does NOT cover, named rather than left to be discovered. A suite silent
                // about its gaps reads as coverage.
                ["gaps"] = Gaps(),
            });
        });

        // Axes the vector set deliberately leaves unexercised, and why.
        private static List<object> Gaps()
        {
            var gaps = new List<object>
            {
                "vsLayerBonus: CLOSED. Half the vectors are fired from a synthetic CannonTurret carrying a "
                + "chosen DamageVsShield/DamageVsArmor roll, paired with an attackerless shot of the same "
                + "type and amount so the bonus is the only difference between them. What is still NOT "
                + "covered is a roll arriving from a real item's aspect lines rather than from the unit's "
                + "pool - the lookup is the same AbstractEquipment.GetStat either way, but nothing here "
                + "proves an aspect reaches it.",
                "incomingDamageCap: gated on the Defense milestone, which a synthetic SpaceShipData does not "
                + "carry, so 'applied' is expected false throughout. The ceiling is reported for comparison "
                + "but the branch is not taken.",
                "empBleedThrough / battle damage / death: reached only through TakeDamage, which this tap does "
                + "not call.",
                "shield tick recharge and the regen stats: they run in Update, which never fires on an "
                + "inactive unit. Every vector is a single instant.",
                "the offense roll: CalculateDamage multiplies by SeededRandom.Global.RandomRange(0.8, 1.25), "
                + "which cannot be pinned without mutating the game's global RNG. Vectors set the amount "
                + "outright instead, and GetExpectedDps on /ship/turrets/attack is the offense oracle.",
            };
            var ship = GameplayManager.Instance?.spaceShip;
            if (ship != null)
            {
                var anyVsLayer = TurretAttack.Rows(ship).Cast<Dictionary<string, object>>().Any(r =>
                {
                    var s = r["stats"] as Dictionary<string, object>;
                    return Convert.ToSingle(s["damageVsShield"]) != 0f || Convert.ToSingle(s["damageVsArmor"]) != 0f;
                });
                if (anyVsLayer)
                    gaps.Add("NOTE: the live battery DOES carry a non-zero DamageVsShield/DamageVsArmor roll, so "
                             + "the vsLayerBonus gap is closable on this save.");
            }
            return gaps.Cast<object>().ToList();
        }

        // Half (a): the vectors that need nothing built. `GetExpectedDps` walks `base.parent`
        // unguarded, so it is a live-ship read and cannot be taken off a template prefab.
        private static object OffenseHalf()
        {
            try
            {
                var ship = GameplayManager.Instance?.spaceShip;
                if (ship == null) return Fail("no player ship — offense vectors need the live battery");
                return new Dictionary<string, object> { ["ok"] = true, ["turrets"] = TurretAttack.Rows(ship) };
            }
            catch (Exception e) { return Fail(e.ToString()); }
        }

        // Half (b): can a defender be constructed, and does the layer chain run against it.
        private static object DefenderHalf(string hullName, string damageType, string amount, string rank, string level)
        {
            try
            {
                var p = new ArenaProfile
                {
                    Name = "probe",
                    ArmorHP = 20_000f,
                    ShieldHP = 20_000f,
                    DamageReduction = 0.10f,
                    ArmorResist = 0.30f,
                    ArmorWeakAmount = 0.50f,
                    ArmorWeakTypes = new[] { DamageType.Cold },
                    Rank = ArenaProfile.UnitRankSetting.Rookie,
                };
                p.Resists[EquipStat.KineticResist] = 0.25f;
                if (!string.IsNullOrEmpty(rank) && Enum.IsDefined(typeof(ArenaProfile.UnitRankSetting), rank))
                    p.Rank = (ArenaProfile.UnitRankSetting)Enum.Parse(typeof(ArenaProfile.UnitRankSetting), rank, true);
                if (int.TryParse(level, out var lvl)) p.Level = lvl;

                using (var d = Build(p, hullName))
                {
                    var type = ParseType(damageType);
                    var raw = float.TryParse(amount, out var a) ? a : 10_000f;
                    return new Dictionary<string, object>
                    {
                        ["ok"] = true,
                        ["built"] = d.Built,
                        ["vector"] = new Dictionary<string, object> { ["type"] = type.ToString(), ["amount"] = raw },
                        ["steps"] = Drive(d.Unit, type, raw),
                    };
                }
            }
            catch (Exception e)
            {
                return new Dictionary<string, object> { ["ok"] = false, ["error"] = e.ToString() };
            }
        }

        // A module is a child component whose `parent` the game would have resolved in Awake. Awake
        // never runs here, so both halves of what it does are done explicitly.
        private static T Attach<T>(GameObject root, AbstractUnit unit, string name) where T : Behaviour.Equipment.AbstractEquipment
        {
            var child = new GameObject(name);
            child.SetActive(false);
            child.transform.SetParent(root.transform, false);
            var mod = child.AddComponent<T>();
            ParentP.GetSetMethod(true).Invoke(mod, new object[] { unit });
            unit.RegisterStatSource(mod);
            return mod;
        }

        private static SpaceShip PickHull(string name)
        {
            var all = SpaceShip.GetAll();
            if (all == null || all.Count == 0) return null;
            if (!string.IsNullOrEmpty(name))
            {
                foreach (var kv in all)
                    if (string.Equals(kv.Key, name, StringComparison.OrdinalIgnoreCase)) return kv.Value;
                return null;
            }
            return all.Values.FirstOrDefault();
        }

        private static DamageType ParseType(string s)
        {
            if (!string.IsNullOrEmpty(s))
                foreach (DamageType t in Enum.GetValues(typeof(DamageType)))
                    if (string.Equals(t.ToString(), s, StringComparison.OrdinalIgnoreCase)) return t;
            return DamageType.Kinetic;
        }

        private static object Step(string name, float remaining, Dictionary<string, object> extra = null)
        {
            var d = new Dictionary<string, object> { ["step"] = name, ["remaining"] = remaining };
            if (extra != null) foreach (var kv in extra) d[kv.Key] = kv.Value;
            return d;
        }

        private static object Fail(string why) => new Dictionary<string, object> { ["ok"] = false, ["error"] = why };
    }
}
