using Source.SpaceShip;
using VG.Core;

namespace VG.Game
{
    /// <summary>
    /// How a ship READS in a list: its size as a tinted label, then role, type and name.
    ///
    /// THE GAME-BOUND HALF ONLY. The size list, ranking, label and tint are `VG.Core.ShipSizes`, and they have to
    /// be: `CicWatch/WatchRule.cs` indexes that list and is linked into `tests/Hypercom.Tests`, which links only
    /// game-free sources, so holding the list here broke that project's build outright. Anything below that takes
    /// a `SpaceShipData` belongs here; anything that does not belongs there.
    ///
    /// A ship's SIZE, ROLE and TYPE all come off `shipClass.shipRoleType`, and every accessor used here exists on
    /// every pinned branch, so this needs no gating.
    /// </summary>
    public static class ShipLook
    {
        /// <summary>See <see cref="ShipSizes.SizeNames"/>. Kept as a forwarder so existing callers still read.</summary>
        public static string[] SizeNames { get { return ShipSizes.SizeNames; } }

        /// <summary>See <see cref="ShipSizes.Rank"/>.</summary>
        public static int SizeRank(string sizeName) { return ShipSizes.Rank(sizeName); }

        /// <summary>See <see cref="ShipSizes.Tint"/>.</summary>
        public static string SizeTint(string sizeName) { return ShipSizes.Tint(sizeName); }

        /// <summary>See <see cref="ShipSizes.Label"/>.</summary>
        public static string SizeLabel(string sizeName) { return ShipSizes.Label(sizeName); }

        /// <summary>The `SpaceShipType` member name for a hull, or null. Never throws: a list of ships must draw
        /// even when one of them cannot answer.</summary>
        public static string SizeNameOf(SpaceShipData ship)
        {
            try
            {
                var role = ship?.shipClass?.shipRoleType;
                return role != null ? role.GetShipType().ToString() : null;
            }
            catch { return null; }
        }

        /// <summary>The hull's role (`SpaceShipRole`), or null.</summary>
        public static string RoleOf(SpaceShipData ship)
        {
            try
            {
                var role = ship?.shipClass?.shipRoleType;
                return role != null ? role.GetRole().ToString() : null;
            }
            catch { return null; }
        }

        /// <summary>The hull's type name as the game words it, or null.</summary>
        public static string TypeNameOf(SpaceShipData ship)
        {
            try
            {
                var role = ship?.shipClass?.shipRoleType;
                return role != null ? role.GetTypeName() : null;
            }
            catch { return null; }
        }

        /// <summary>
        /// What a ship IS, in one short phrase: role then type (`Combat Battlecruiser`), or whichever of the two
        /// answers. Null when neither does.
        ///
        /// ⚠ RETURNED SEPARATELY FROM THE NAME, ⊥ composed into one string, because the caller needs to lay them
        /// out in COLUMNS. Composed, the variable-width middle pushed every name to a different x and the row was
        /// unreadable across a fleet; a fixed-width control per part is the only thing that lines up in IMGUI.
        /// </summary>
        public static string RoleTypeOf(SpaceShipData ship)
        {
            var role = RoleOf(ship);
            var type = TypeNameOf(ship);
            // They often read the same on a hull with one job, and printing it twice is noise.
            if (string.IsNullOrEmpty(type) || type == role) return string.IsNullOrEmpty(role) ? null : role;
            return string.IsNullOrEmpty(role) ? type : role + " " + type;
        }

    }
}
