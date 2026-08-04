using System;
using VG.Core;
using Xunit;

namespace StationAssistant.Tests
{
    // Differential test for keep-rule matching: reconstruct the original KeepRule.Matches boolean logic
    // (as it read game fields) over the same POCO facts, fuzz random rule/item combos, assert the new
    // VG.Core.KeepMatch agrees. Guards the port (type null-handling, size==-1, boss startsWith, floors).
    public class KeepMatchDiffTests
    {
        // Verbatim reconstruction of the original Matches logic, expressed over ItemFacts fields.
        static bool OldMatches(KeepCriteria k, ItemFacts it)
        {
            if (k.Category != null && it.Category != k.Category) return false;
            if (k.Type != null) { if (it.Type == null || it.Type != k.Type) return false; }
            if (k.MinRarityRank >= 0 && it.RarityRank < k.MinRarityRank) return false;
            if (k.SizeRank >= 0) { if (it.SizeRank != k.SizeRank) return false; }   // EXACT: size is not a quality ordering
            if (k.MinLevel > 0 && it.Level < k.MinLevel) return false;
            if (k.Aspect != null)
            {
                var ids = it.AspectIds ?? Array.Empty<string>();
                bool hit = false;
                foreach (var id in ids)
                {
                    if (id == null) continue;
                    if (k.Aspect == KeepMatch.AllBossAspects
                        ? id.StartsWith("boss", StringComparison.OrdinalIgnoreCase)
                        : id == k.Aspect) { hit = true; break; }
                }
                if (!hit) return false;
            }
            return true;
        }

        static readonly string[] Cats = { "Turret", "Module", "Booster", "Material", null };
        static readonly string[] Types = { "PlasmaBeam", "Railgun", "ShieldMod", null };
        static readonly string[] Aspects = { "boss_krall", "BossFoo", "overcharge", "reload", null };

        [Fact]
        public void Fuzz_MatchesOriginalKeepLogic()
        {
            var rng = new Random(987654);
            for (var i = 0; i < 200000; i++)
            {
                var it = new ItemFacts
                {
                    Category = Cats[rng.Next(Cats.Length)],
                    Type = Types[rng.Next(Types.Length)],
                    RarityRank = rng.Next(-1, 5),
                    SizeRank = rng.Next(-1, 4),
                    Level = rng.Next(0, 61),
                    AspectIds = RandAspects(rng),
                };
                var k = new KeepCriteria
                {
                    Category = Cats[rng.Next(Cats.Length)],
                    Type = Types[rng.Next(Types.Length)],
                    MinRarityRank = rng.Next(-1, 5),
                    SizeRank = rng.Next(-1, 4),
                    MinLevel = rng.Next(0, 61),
                    Aspect = rng.Next(3) == 0 ? KeepMatch.AllBossAspects : Aspects[rng.Next(Aspects.Length)],
                };
                Assert.Equal(OldMatches(k, it), KeepMatch.Matches(k, it));
            }
        }

        static string[] RandAspects(Random rng)
        {
            var n = rng.Next(0, 4);
            var a = new string[n];
            for (var j = 0; j < n; j++) a[j] = Aspects[rng.Next(Aspects.Length)];
            return a;
        }
    }
}
