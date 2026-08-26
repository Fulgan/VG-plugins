using System;

namespace VG.Core
{
    /// <summary>
    /// Hull sizes: the game's own order, the label they draw as, and the colour they draw in.
    ///
    /// GAME-FREE ON PURPOSE, and that is a build constraint rather than a preference. `CicWatch/WatchRule.cs`
    /// stores rule indices against <see cref="SizeNames"/> and is linked into `tests/Hypercom.Tests`, which links
    /// only sources that need no game assembly. Putting this list on `VG.Game.ShipLook` beside the members that
    /// take a `SpaceShipData` broke that test project outright: nothing here may reference the game.
    ///
    /// The game-bound half — reading a size, role or type OFF a ship, and composing a row — is
    /// `VG.Game.ShipLook`, which delegates the parts below.
    /// </summary>
    public static class ShipSizes
    {
        /// <summary>The game's own `SpaceShipType` member names for hull sizes, smallest first. Order is meaning:
        /// callers index into it, and CIC Watch PERSISTS those indices, so this list and <see cref="Tints"/>
        /// cannot be reordered independently or against a saved config.</summary>
        public static readonly string[] SizeNames =
            { "Size1", "Size2", "Size3", "Size4", "Size5", "Size6", "Size7", "Size8" };

        // Cool to hot, one step per tier, so the shape of a fleet is readable at a glance rather than after
        // reading every row. Its own colour family on purpose: badges elsewhere carry hostility and capture
        // (red, green, gold), and reusing those would make two different questions share one language.
        private static readonly string[] Tints =
        {
            "#79c0ff", "#79d8c0", "#a8e07f", "#e0d97f",   // S1 to S4
            "#f0b84a", "#f28c4a", "#f2664a", "#ff5a5a",   // S5 to S8
        };

        private const string Unknown = "#8a94a0";

        /// <summary>Position in <see cref="SizeNames"/>, or -1. The sort key for a size-ordered list.</summary>
        public static int Rank(string sizeName) { return Array.IndexOf(SizeNames, sizeName); }

        /// <summary>Colour for a hull size, by the game's own enum member name. Grey for anything unrecognised,
        /// drones included: they are not a size and must not borrow one.</summary>
        public static string Tint(string sizeName)
        {
            var i = Rank(sizeName);
            return i >= 0 && i < Tints.Length ? Tints[i] : Unknown;
        }

        /// <summary>
        /// `S6` for a size, the name itself for anything else (`Drone`), null for nothing.
        ///
        /// ONE ANSWER, because there were two: this and `WatchMatch.SizeLabel` disagreed on an unrecognised name,
        /// so the same hull could read `Drone` in one panel and blank in another.
        /// </summary>
        public static string Label(string sizeName)
        {
            if (string.IsNullOrEmpty(sizeName)) return null;
            var i = Rank(sizeName);
            return i >= 0 ? "S" + (i + 1) : sizeName;
        }
    }
}
