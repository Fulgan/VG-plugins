using Source.SpaceShip;

namespace VG.Game
{
    // What to call a ship on screen, in one place. The chain is custom name, then the class name, then the guid,
    // and the ORDER is the point: an unrenamed ship must read as "Chisel Mk I" rather than as
    // "d41d8cd9-8f00-...", and a ship with no class at all must still be identifiable rather than blank.
    //
    // This existed five times before it existed once (the bridge's ledger and ship DTO, the station assistant's
    // util and two of its window bodies), which is the duplication this repo pays for most: one of the five had
    // already dropped the guid fallback, so the same ship answered differently depending on which surface asked.
    public static class ShipNames
    {
        /// <summary>
        /// The HULL CLASS only, never a custom name: `Voron`, `Pathfinder`. Falls back to the guid for the same reason
        /// <see cref="Label"/> does — a hull with no class must stay identifiable rather than read as blank.
        ///
        /// Separate from <see cref="Label"/> because the two answer different questions: a readout about SOMEONE ELSE'S
        /// ship wants what the hull is, and a name its owner chose says nothing about that.
        /// </summary>
        public static string ClassName(SpaceShipData ship)
        {
            if (ship == null) return null;
            return ship.shipClass?.displayName ?? ship.guid;
        }

        /// <summary>Display name for a ship: custom name, else class name, else guid. Null only for a null ship.</summary>
        public static string Label(SpaceShipData ship)
        {
            if (ship == null) return null;
            if (!string.IsNullOrEmpty(ship.customShipName)) return ship.customShipName;
            return ship.shipClass?.displayName ?? ship.guid;
        }
    }
}
