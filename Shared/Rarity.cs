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
    }
}
