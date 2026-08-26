using System.Globalization;

namespace CicWatch
{
    // Percentages, written the same way everywhere.
    //
    // `"P0"` looked like the obvious choice and is not: it is CULTURE-dependent, and on the machine this mod was
    // first tested on it produced "100 %" with a non-breaking space, which rendered in TMP as a bare "100". A
    // readout that silently drops its unit is one the player has to guess at, so the sign is written by hand and
    // the number is formatted against the invariant culture rather than whatever the game is running under.
    internal static class Fmt
    {
        /// <summary>`S6`, or `Drone`. Owned by <see cref="WatchMatch"/>, which the rule editor already reads.</summary>
        internal static string SizeLabel(string sizeName) { return WatchMatch.SizeLabel(sizeName); }

        /// <summary>Colour for a hull size, by the game's own enum member name. The ramp itself is
        /// <see cref="VG.Game.ShipLook"/>'s: the station assistant draws ships in a list too, and a tint that means
        /// "Size 6" has to mean that in both mods.</summary>
        internal static string SizeColor(string sizeName) { return VG.Game.ShipLook.SizeTint(sizeName); }

        internal static string Pct(float fraction, int decimals = 0)
        {
            var value = fraction * 100f;
            var text = decimals <= 0
                ? ((int)System.Math.Round(value)).ToString(CultureInfo.InvariantCulture)
                : value.ToString("0." + new string('0', decimals), CultureInfo.InvariantCulture);
            return text + "%";
        }
    }
}
