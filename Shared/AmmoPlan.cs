using System.Collections.Generic;

namespace VG.Core
{
    /// <summary>
    /// One ammo type's demand on the hold: how fast it is burned, and what one round occupies.
    /// </summary>
    public struct AmmoDraw
    {
        /// <summary>Rounds consumed per second of sustained fire, across everything that feeds on this type.</summary>
        public double PerSecond;

        /// <summary>Volume of a single round.</summary>
        public double VolumePerRound;

        public AmmoDraw(double perSecond, double volumePerRound)
        {
            PerSecond = perSecond;
            VolumePerRound = volumePerRound;
        }
    }

    /// <summary>
    /// How a volume budget is turned into a per-ammo round count.
    ///
    /// The whole point is that the budget is shared as a FIRING TIME rather than as volume. An even split of the
    /// cubic metres looks fair and is not: a fast gun and a slow one get the same space and run dry at different
    /// times, so the ship is out of one of them while still carrying plenty of the other. Solving for a single
    /// duration every type reaches makes them run out together, which is the only moment worth arriving at.
    ///
    /// Kept free of game types so it can be tested: the arithmetic is where this goes quietly wrong, and a mod
    /// can only be exercised by flying a ship.
    /// </summary>
    public static class AmmoPlan
    {
        /// <summary>
        /// The seconds of sustained fire `budgetVolume` buys when every type is to run out at the same moment.
        /// Zero when nothing is drawing, or when there is no budget: callers treat that as "impose no cap".
        ///
        /// A type with no volume per round is skipped rather than treated as free. It would otherwise contribute
        /// nothing to the denominator while still being handed rounds out of the answer, and an unknown volume is
        /// a reason to leave a type alone, not a reason to stock it without limit.
        /// </summary>
        public static double SecondsAffordable(IEnumerable<AmmoDraw> draws, double budgetVolume)
        {
            if (draws == null || budgetVolume <= 0)
                return 0;

            double volumePerSecond = 0;
            foreach (var d in draws)
            {
                if (d.PerSecond <= 0 || d.VolumePerRound <= 0)
                    continue;
                volumePerSecond += d.PerSecond * d.VolumePerRound;
            }
            return volumePerSecond <= 0 ? 0 : budgetVolume / volumePerSecond;
        }

        /// <summary>
        /// Rounds that last `seconds` at `perSecond`. Rounded UP: a stock that lands just short of the duration
        /// it was asked for has failed at the one thing it was for.
        /// </summary>
        public static int RoundsFor(double perSecond, double seconds)
        {
            if (perSecond <= 0 || seconds <= 0)
                return 0;
            var rounds = perSecond * seconds;
            var whole = (int)rounds;
            return rounds > whole ? whole + 1 : whole;
        }
    }
}
