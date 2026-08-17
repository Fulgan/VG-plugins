using System.Collections.Generic;

namespace Hypercom
{
    // Whether a unit's numbers have SETTLED — a different question from whether the unit exists.
    //
    // `MarkStatsDirty` sets `statsDirty` and the recalculation runs later, so there is a window where
    // every stat on the ship is mid-move while it still answers. Measured on 0.8.1.23: a read taken in
    // that window reported a turret's `GetAttackPower` at 504,645 where the settled value is 68,864 — a
    // factor of 7.3, with nothing in the payload to say the reading was in flight.
    //
    // Any surface serving a figure a caller will COMPARE or CAPTURE has to say this, or a fixture can
    // record a transient as a constant and every later run disagrees with it for no visible reason.
    internal static class ShipStats
    {
        // The two private member names live here and nowhere else: a name-based read that is spelled in
        // two places is the drift this repo pays for, and reflection reports a misspelling as `null`,
        // which reads as "settled".
        internal static object Dirty(object ship) => Compat.GetPrivate(ship, "statsDirty");
        internal static object Calculating(object ship) => Compat.GetPrivate(ship, "isCalculatingStats");

        internal static void AddSettled(Dictionary<string, object> dto, object ship)
        {
            dto["statsLive"] = !(ship is null) && !ship.Equals(null);
            dto["statsDirty"] = Dirty(ship);
            dto["statsCalculating"] = Calculating(ship);
        }

        /// <summary>
        /// True when a figure read off this unit is safe to compare or capture.
        /// A null read (an older build without the field) counts as settled: the flag is an extra
        /// guarantee where it exists, not a reason to refuse everywhere it does not.
        /// </summary>
        internal static bool IsSettled(object ship)
        {
            if (ship is null || ship.Equals(null)) return false;
            return !(Dirty(ship) as bool? ?? false) && !(Calculating(ship) as bool? ?? false);
        }
    }
}
