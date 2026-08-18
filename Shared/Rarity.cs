// Game-free rarity table: display order + colour, keyed by rarity NAME (a plugin adapter maps the
// game's Rarity enum → its name via ToString). Single source so StationAssistant's IMGUI colouring and
// any ordering logic can't drift apart. POCO/framework-only → compiles into the headless test project.
// NOTE: these hex values are the in-game IMGUI palette; the web UI has its own palette in format.ts.
namespace VG.Core
{
    public static class Rarity
    {
        // Worst → best. Index = display order.
        public static readonly string[] Order = { "Standard", "Enhanced", "HighGrade", "Exotic", "Legendary" };
        static readonly string[] Hex = { "#B0B0B0", "#5FD35F", "#5AA9E6", "#B266FF", "#F2C14E" };

        // The hull REFIT letter, the rarity half of the game's `Type-A25` label. Same order as above, and the
        // game's own fallback for an unrecognised value is the first letter, not blank.
        static readonly string[] Refit = { "A", "B", "C", "X", "S" };

        // Display-order index (0-based); -1 for an unknown name.
        public static int Rank(string rarity)
        {
            for (var i = 0; i < Order.Length; i++)
                if (Order[i] == rarity) return i;
            return -1;
        }

        // Hex colour "#RRGGBB" for a rarity name; grey fallback for unknown.
        public static string Color(string rarity)
        {
            var r = Rank(rarity);
            return r >= 0 ? Hex[r] : Hex[0];
        }

        // Refit letter for a rarity name: A B C X S, unknown reads as A.
        public static string RefitCode(string rarity)
        {
            var r = Rank(rarity);
            return r >= 0 ? Refit[r] : Refit[0];
        }

        // The whole label, composed the way the game composes it rather than stored: letter from the rarity,
        // number from the upgrade points spent. The NUMBER scales with level and says nothing about danger, so
        // anything ranking hulls compares the letter and prints the rest.
        public static string RefitLabel(string rarity, int pointsSpent)
        {
            return "Type-" + RefitCode(rarity) + pointsSpent;
        }
    }
}
