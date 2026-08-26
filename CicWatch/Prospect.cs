using System;
using UnityEngine;
using System.Reflection;
using Behaviour.Unit;
using Source.SpaceShip;
using VG.Game;

namespace CicWatch
{
    // What a hull is worth RIGHT NOW, read live rather than remembered: vitals and capture prospects both move
    // while you shoot, so a value cached at arrival would be a lie by the time anyone reads it.
    internal struct Prospect
    {
        internal bool Known;

        // Vitals, as fractions of each layer's own maximum. Per layer and never summed: shields absorb first,
        // armor carries its own resist table and hull is what is left, so a total hides one layer at zero while
        // another covers for it.
        internal float Hull, Armor, Shield;
        internal bool ShieldsDown;

        /// <summary>Does this hull carry the layer at all? A layer it lacks is left out rather than shown at zero.</summary>
        internal bool HasArmor;
        internal bool HasShield;

        // Capture. `CanTake` is the GAME's answer, not ours.
        internal bool CanTake;
        internal string WhyNot;      // null when it can be taken
        internal bool Boardable;     // already boardable: the one state with a clock on it

        /// <summary>
        /// SHIP INTEGRITY the boarding operation would START with, which is what the game's own boarding panel
        /// counts down from: `min(1, fractionHullHP + 0.2)` (`DungeonSimulation.CreateForShipBoarding`, seeded from
        /// `DungeonOperation.StartPodSimulation`). NOT the hull figure: a hull shot to 0% still boards at 20%
        /// integrity, and the pre-boarding panel shows the plain hull fraction, which is why the two readings differ
        /// by that margin. Only meaningful when <see cref="Boardable"/>.
        /// </summary>
        internal float Integrity;

        /// <summary>A boarding is RUNNING against this hull ∴ <see cref="Integrity"/> is the live figure, not the seed.</summary>
        internal bool Boarding;

        // NO ODDS AND NO WINDOW. Both were built, both were reported and both were removed at the player's word:
        // "there is nothing actionable to do with that info". What IS actionable is whether a hull can be taken at
        // all, since that is what stops someone grinding a level-81 hull to 1% for nothing. The formula and the
        // window still live in the internal notes, where knowing them costs no screen space.
    }

    // Reads a contact's live state. Everything beta-only goes through GameMembers BY NAME, and the capture GATE is
    // REFLECTED rather than re-derived: it is six clauses on the game's side, and a transcribed copy compiles,
    // runs, and disagrees the first patch that moves one of them.
    internal static class Prospects
    {
        private static MethodInfo _canBecomeBoardable;
        private static bool _looked;

        internal static Prospect Read(AbstractUnit unit)
        {
            var p = new Prospect();
            if (unit == null) return p;

            try
            {
                // CLAMPED, and a reading outside the range is LOGGED rather than drawn. A hull parked at a station
                // reported `hull 2294% arm 0% shd 617%`: current and max are not always two readings of one hull, and a
                // percentage over 100 in a readout is a defect the player has to interpret. The log keeps the evidence.
                var maxHull = unit.maxHullHP;
                var maxArm = unit.maxArmorHP;
                var maxShd = unit.maxShieldHP;

                // A LAYER EXISTS WHERE THE THING THAT SPENDS IT EXISTS, ⊥ where the STAT is above zero. `maxArmorHP`
                // is `GetStat(EquipStat.ArmorHP)` and can be positive from any stat source, while the pool is only ever
                // drawn down inside `ArmorModule.AbsorbArmorDamage`. The game fabricates the missing module for
                // PLAYER-owned ships only (`EnsurePlayerBaseModules`) ∴ an NPC can carry armor HP that nothing spends,
                // and it dies at `arm 100%` — a live-looking number for a layer that never absorbs a shot. Same shape
                // for shields and their generator. Read by NAME so no module type is bound here.
                p.HasArmor = maxArm > 0f && GameMembers.Get(unit, "armorModule") != null;
                p.HasShield = maxShd > 0f && GameMembers.Get(unit, "shieldGeneratorModule") != null;

                p.Hull = Ratio(maxHull > 0 ? unit.currentHullHP / maxHull : 0f, "hull");
                p.Armor = p.HasArmor ? Ratio(unit.currentArmorHP / maxArm, "armor") : 0f;
                p.Shield = p.HasShield ? Ratio(unit.currentShieldHP / maxShd, "shield") : 0f;
                p.ShieldsDown = p.HasShield && unit.currentShieldHP <= 0f;
                p.Known = true;

                var ship = unit as SpaceShip;
                if (ship == null) return p;

                p.Boardable = ship.isBoardable;
                if (p.Boardable)
                {
                    var live = CicWatch.Boarding.Live(ship);
                    if (live >= 0f)
                    {
                        // The simulation owns the number once it is running: it spends the seed as compartments fall,
                        // and recomputing the seed here would freeze the readout at the figure the fight began with.
                        p.Integrity = live;
                        p.Boarding = true;
                    }
                    else
                    {
                        // What an operation would OPEN with. `AbstractUnit.fractionHullHP`, which the game seeds the
                        // boarding from, is `currentHullHP / maxHullHP` — the same division `Hull` already is, so
                        // reading it by name would only add a second owner of one number.
                        p.Integrity = Mathf.Min(1f, p.Hull + 0.2f);
                    }
                }
                p.CanTake = AskTheGame(ship);
                if (!p.CanTake) p.WhyNot = Because(ship);

            }
            catch
            {
                // A hull that cannot be read is reported as unknown. It is never worth a throw inside a draw.
            }
            return p;
        }

        private static int _oddRatios;

        private static float Ratio(float f, string what)
        {
            if (f >= 0f && f <= 1.0001f) return Mathf.Clamp01(f);
            if (_oddRatios < 3)
            {
                _oddRatios++;
                Plugin.Log.LogWarning($"{what} read {f:0.00} of its maximum, which is outside 0..1 and was clamped");
            }
            return Mathf.Clamp01(f);
        }

        private static bool AskTheGame(SpaceShip ship)
        {
            if (!_looked)
            {
                _looked = true;
                _canBecomeBoardable = GameMembers.MethodDeep(typeof(SpaceShip), "CanBecomeBoardable", 0);
            }
            if (_canBecomeBoardable == null) return false;
            try { return _canBecomeBoardable.Invoke(ship, null) is bool b && b; }
            catch { return false; }
        }

        // The reason, for a player who would otherwise grind a hull to 1% for nothing. Derived from the same clauses
        // the gate reads, and it says so when it cannot account for the answer: a wrong reason beside a right verdict
        // is worse than no reason. TERSE on purpose — it shares the status line now, and a clause that wraps costs a
        // row the player capped at two.
        private static string Because(SpaceShip ship)
        {
            try
            {
                var data = ship.unitData;
                if (ship.isBoardable) return null;                       // already taken through the gate
                if (ship.noBoardable) return "already boarded";
                if (ship.shipRoleType != null && ship.shipRoleType.GetShipType() == SpaceShipType.Drone)
                    return "a drone";
                if (data != null && data.level > 80) return $"level {data.level}, over 80";

                var loot = GameMembers.Get(data, "loot");
                var count = loot == null ? 0 : Convert.ToInt32(loot.GetType().GetProperty("Count")?.GetValue(loot, null) ?? 0);
                if (count > 0) return "carrying loot";

                // `MapPointOfInterest` is in Source.Galaxy, the station types one namespace deeper in .POI.
                if (Source.Galaxy.MapPointOfInterest.current is Source.Galaxy.POI.IndustryStation)
                    return "industry station";

                return "the game says no";
            }
            catch { return "the game says no"; }
        }

    }
}
