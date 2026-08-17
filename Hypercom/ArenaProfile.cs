using System.Collections.Generic;
using Source.Combat;
using Source.Item;

namespace Hypercom
{
    // A defender profile: everything a synthetic unit needs, and nothing about the fight.
    //
    // Profiles exist to move ONE axis at a time. A vector set that only ever moves two together cannot
    // say which of them a port got wrong, which is the whole reason the golden set is worth capturing.
    internal sealed class ArenaProfile
    {
        internal string Name;
        internal float HullHP = 1_000_000f;
        internal float ArmorHP;                 // 0 ⇒ no armor module at all, not an empty one
        internal float ShieldHP;                // 0 ⇒ no shield module at all
        internal float DamageReduction;
        internal readonly Dictionary<EquipStat, float> Resists = new Dictionary<EquipStat, float>();
        internal float ArmorResist;
        internal float ArmorWeakAmount;
        internal DamageType[] ArmorWeakTypes = new DamageType[0];
        internal float ShieldRechargeRate = 1f;
        internal float ShieldRechargeDelay = 5f;
        internal UnitRankSetting Rank = UnitRankSetting.Veteran;
        internal int Level;

        internal enum UnitRankSetting { Rookie, Standard, Veteran, Elite, Champion, Commander, Legendary }

        internal Dictionary<string, object> Spec()
        {
            var resists = new Dictionary<string, object>();
            foreach (var kv in Resists) resists[kv.Key.ToString()] = kv.Value;
            var weak = new List<object>();
            foreach (var w in ArmorWeakTypes) weak.Add(w.ToString());
            return new Dictionary<string, object>
            {
                ["name"] = Name,
                ["hullHP"] = HullHP,
                ["armorHP"] = ArmorHP,
                ["shieldHP"] = ShieldHP,
                ["damageReduction"] = DamageReduction,
                ["resists"] = resists,
                ["armorResist"] = ArmorResist,
                ["armorWeakAmount"] = ArmorWeakAmount,
                ["armorWeakTypes"] = weak,
                ["rank"] = Rank.ToString(),
                ["level"] = Level,
            };
        }

        /// <summary>
        /// The canonical set. Each entry exists to isolate one axis; the comment on each says which,
        /// because a profile whose purpose is not written down gets "tidied" into overlapping with
        /// its neighbour and the set silently stops covering anything.
        /// </summary>
        internal static List<ArenaProfile> Canonical()
        {
            var list = new List<ArenaProfile>
            {
                // Nothing mitigates and nothing absorbs: the mapping from incoming to hull, so every
                // other profile can be read as a difference against this one.
                new ArenaProfile { Name = "baseline" },
                // The untyped half of mitigation, alone.
                new ArenaProfile { Name = "damageReduction", DamageReduction = 0.50f },
                // Mitigation's floor. 0.60 + 0.50 exceeds 1, so `max(0.2, 1 - dr - resist)` clamps and
                // the vector pins the clamp rather than the subtraction.
                new ArenaProfile
                {
                    Name = "mitigationFloor",
                    DamageReduction = 0.60f,
                    Resists = { { EquipStat.KineticResist, 0.50f } },
                },
                // Shield alone, sized to swallow a small hit whole and to be overrun by a large one.
                new ArenaProfile { Name = "shieldHeavy", ShieldHP = 500_000f },
                // Armor alone, with a resist that only the armor applies — distinct from a typed resist,
                // which the unit applies before any layer is consulted.
                new ArenaProfile { Name = "armorHeavy", ArmorHP = 500_000f, ArmorResist = 0.30f },
                // The one type-dependent effect that AMPLIFIES. Cold is weak, everything else is resisted
                // by the same armor, so one profile carries both directions.
                new ArenaProfile
                {
                    Name = "armorWeakCold",
                    ArmorHP = 500_000f,
                    ArmorResist = 0.30f,
                    ArmorWeakAmount = 0.50f,
                    ArmorWeakTypes = new[] { DamageType.Cold },
                },
                // Both layers, so the order between them is exercised and not merely assumed.
                new ArenaProfile { Name = "bothLayers", ArmorHP = 100_000f, ShieldHP = 100_000f },
            };

            // One per typed resist. The unit-level resist is a different quantity from the armor's, and
            // nothing but a per-type sweep shows that the mapping from damage type to resist stat is the
            // one the game uses rather than the one that looks obvious.
            foreach (DamageType t in System.Enum.GetValues(typeof(DamageType)))
            {
                var p = new ArenaProfile { Name = "resist" + t };
                p.Resists[t.GetResistStat()] = 0.40f;
                list.Add(p);
            }
            return list;
        }
    }
}
