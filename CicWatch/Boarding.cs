using System.Collections;
using Behaviour.Unit;
using UnityEngine;
using VG.Game;

namespace CicWatch
{
    // THE LIVE BOARDING FIGURE, which is a different number from the one the seed formula gives.
    //
    // `min(1, fractionHullHP + 0.2)` is what a boarding STARTS with. Once the operation is running, the simulation owns
    // the value and spends it: compartments fall, integrity drops, and the game's own bar counts down from that seed.
    // So a boarding in progress is read from the simulation and never recomputed, or the panel would sit at the
    // starting figure while the fight it describes is being lost.
    //
    // ALL BY NAME. `BoardableUnit` and `DungeonSimulation` do not exist on the release branch, so a compiled reference
    // to either would break the one-binary rule; the mod is beta-only, and this stays reflected anyway because a
    // missing member has to cost the READOUT rather than the method it sits in.
    internal static class Boarding
    {
        internal const float None = -1f;

        private static bool _looked;
        private static System.Type _boardable;

        private static void Look()
        {
            if (_looked) return;
            _looked = true;
            _boardable = GameMembers.FindType("Behaviour.Unit.BoardableUnit");
            if (_boardable == null) Plugin.Log.LogWarning("BoardableUnit not found: a boarding in progress will show "
                                                          + "the figure it started with instead of the live one");
        }

        /// <summary>
        /// Structure integrity of the boarding running against this hull, as a fraction, or <see cref="None"/> when no
        /// operation is under way. A completed simulation counts as none: the number stops meaning anything once the
        /// fight is over.
        /// </summary>
        internal static float Live(SpaceShip ship)
        {
            if (ship == null) return None;
            Look();
            if (_boardable == null) return None;

            try
            {
                // `BoardableUnit.all` is the game's own registry of hulls that can be boarded, so there is no set to
                // maintain here and nothing to keep in step with spawns.
                var all = GameMembers.StaticGetDeep(_boardable, "all") as IEnumerable;
                if (all == null) return None;

                foreach (var entry in all)
                {
                    if (entry == null) continue;
                    if (!ReferenceEquals(GameMembers.Get(entry, "ship"), ship)) continue;

                    var sim = GameMembers.Get(entry, "simulation");
                    if (sim == null) return None;

                    var done = GameMembers.Get(sim, "isComplete");
                    if (done is bool && (bool)done) return None;

                    var max = Num(sim, "maxStructureIntegrity");
                    if (max <= 0f) return None;
                    return Mathf.Clamp01(Num(sim, "structureIntegrity") / max);
                }
            }
            catch { }

            return None;
        }

        private static float Num(object on, string name)
        {
            var v = GameMembers.Get(on, name);
            return v == null ? 0f : System.Convert.ToSingle(v);
        }
    }
}
