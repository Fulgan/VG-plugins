using System;

// Game-free keep-rule matching for AutoSell. The game-bound KeepRule (game enums + AbstractEquipment)
// stays the adapter: it builds an ItemFacts POCO from the game item and a KeepCriteria from itself,
// then delegates the decision here. Pure + POCO → compiles into the headless test project and the
// rank/aspect edge cases are unit-tested.
namespace VG.Core
{
    // A keep rule as plain data. Null/absent = "any"; rank/level fields are minimums (>=).
    public struct KeepCriteria
    {
        public string Category;    // null = any (ItemCategory name)
        public string Type;        // null = any (equipment class name)
        public int MinRarityRank;  // -1 = any (else (int)Rarity)
        // EXACT, unlike rarity and level. Size is not a quality ordering — a Large module is not a better Small
        // one, it fits a different slot — so ">= Medium" was incoherent as a keep rule: it spared Large items the
        // player had chosen Medium for.
        public int SizeRank;       // -1 = any (else (int)ModuleSize), matched exactly
        public int MinLevel;       // 0 = any
        public string Aspect;      // null = any; AllBossAspects = any boss aspect; else exact identifier
    }

    // The item's properties the matcher inspects. Ranks are -1 when absent (e.g. non-equipment has no
    // size). AspectIds is never null (empty is fine).
    public struct ItemFacts
    {
        public string Category;
        public string Type;        // equipment class name; null if the item isn't equipment
        public int RarityRank;
        public int SizeRank;       // -1 if the item has no size (not equipment)
        public int Level;
        public string[] AspectIds; // equipped aspect identifiers; empty when none
    }

    public static class KeepMatch
    {
        // Sentinel Aspect value: match ANY boss aspect (identifier starts with "boss") vs one exact id.
        public const string AllBossAspects = "*boss*";

        // True when the item satisfies every set criterion → the item is spared from selling.
        public static bool Matches(in KeepCriteria k, in ItemFacts it)
        {
            if (k.Category != null && it.Category != k.Category) return false;
            if (k.Type != null && it.Type != k.Type) return false; // non-equipment (Type==null) never matches a type rule
            if (k.MinRarityRank >= 0 && it.RarityRank < k.MinRarityRank) return false;
            if (k.SizeRank >= 0 && it.SizeRank != k.SizeRank) return false;
            if (k.MinLevel > 0 && it.Level < k.MinLevel) return false;
            if (k.Aspect != null)
            {
                var ids = it.AspectIds ?? Array.Empty<string>();
                var hit = false;
                foreach (var id in ids)
                {
                    if (id == null) continue;
                    if (k.Aspect == AllBossAspects ? id.StartsWith("boss", StringComparison.OrdinalIgnoreCase) : id == k.Aspect)
                    { hit = true; break; }
                }
                if (!hit) return false;
            }
            return true;
        }
    }
}
