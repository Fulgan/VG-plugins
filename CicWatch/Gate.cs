using System;
using VG.Game;

namespace CicWatch
{
    // Whether this build of the game can answer the two questions this mod exists to answer. Checked ONCE, at
    // startup, by name.
    //
    // A build older than 0.8.2 does not carry a reduced version of these features, it carries none of them: no
    // hull rarity, no upgrade points, no boarding of any kind, and not even the hook that says a hull arrived. A
    // panel there could only list rank and size, which is not worth a mod, so the mod switches itself off and says
    // so once in the log instead of shipping an empty window.
    //
    // ONE switch for the whole mod, on purpose. Some of what a readout could show (asteroid ore, wreck contents)
    // does exist on every build, so a per-feature gate is buildable and is deliberately not built: a mod that
    // half-works on a build turns into "why is my panel empty?" every time, and the hull readout is the reason
    // to install this. Adding a feature that survives the gate does not make splitting it correct.
    //
    // Every probe is a NAME. A missing member must read as "this build cannot", never as a throw inside game code
    // and never as an empty result that looks like "nothing is nearby".
    internal static class Gate
    {
        internal const string ShipUpgradeCalculator = "Source.SpaceShip.ShipUpgradeCalculator";
        internal const string SpaceShipData = "Source.SpaceShip.SpaceShipData";
        internal const string AbstractUnitData = "Source.Data.AbstractUnitData";
        internal const string BoardableUnit = "Behaviour.Unit.BoardableUnit";
        internal const string SpaceShip = "Behaviour.Unit.SpaceShip";
        internal const string PhysicsInteraction = "Behaviour.Unit.PhysicsInteraction";

        /// <summary>True when every member the mod's features need is present on this build.</summary>
        internal static bool Supported { get; private set; }

        /// <summary>What was missing, for the one log line. Null once <see cref="Supported"/> is true.</summary>
        internal static string Missing { get; private set; }

        internal static bool Check()
        {
            try
            {
                // The refit letter: its own type, plus the two fields it is composed from.
                if (GameMembers.FindType(ShipUpgradeCalculator) == null) return No(ShipUpgradeCalculator);

                var shipData = GameMembers.FindType(SpaceShipData);
                if (shipData == null) return No(SpaceShipData);
                if (GameMembers.Member(shipData, "shipRarity") == null) return No("SpaceShipData.shipRarity");
                if (GameMembers.Member(shipData, "upgradeState") == null) return No("SpaceShipData.upgradeState");

                // Capture: the standing set, and the gate that says whether a hull can ever be taken. The gate is
                // protected, which is why it is reached deep rather than re-derived from its clauses.
                if (GameMembers.FindType(BoardableUnit) == null) return No(BoardableUnit);

                var ship = GameMembers.FindType(SpaceShip);
                if (ship == null) return No(SpaceShip);
                if (GameMembers.MethodDeep(ship, "CanBecomeBoardable", 0) == null)
                    return No("SpaceShip.CanBecomeBoardable()");

                // Arrivals, and the area read that gives distance.
                var unitData = GameMembers.FindType(AbstractUnitData);
                if (unitData == null) return No(AbstractUnitData);
                if (GameMembers.Method(unitData, "RegisterUnit", 1) == null) return No("AbstractUnitData.RegisterUnit(unit)");

                var physics = GameMembers.FindType(PhysicsInteraction);
                if (physics == null) return No(PhysicsInteraction);
                if (GameMembers.StaticMethod(physics, "GetUnitsWithinRange") == null)
                    return No("PhysicsInteraction.GetUnitsWithinRange(...)");

                Missing = null;
                Supported = true;
                return true;
            }
            catch (Exception e)
            {
                // A probe that throws is the same answer as a probe that finds nothing: the feature is off.
                return No("probe failed: " + e.Message);
            }
        }

        private static bool No(string what)
        {
            Supported = false;
            Missing = what;
            return false;
        }
    }
}
