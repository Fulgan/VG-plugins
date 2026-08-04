using VG.Core;
using Xunit;

namespace StationAssistant.Tests
{
    // Headless tests for keep-rule matching (rank minimums, type/category, boss-aspect sentinel).
    public class KeepMatchTests
    {
        // A turret: Combat / "PlasmaBeam" / rarity 3 (Exotic) / size 1 / level 40 / one boss aspect.
        static ItemFacts Turret() => new ItemFacts
        {
            Category = "Turret", Type = "PlasmaBeam", RarityRank = 3, SizeRank = 1, Level = 40,
            AspectIds = new[] { "boss_krall_rage", "overcharge" },
        };
        static ItemFacts Ore() => new ItemFacts { Category = "Material", Type = null, RarityRank = 0, SizeRank = -1, Level = 0, AspectIds = new string[0] };

        [Fact]
        public void EmptyCriteria_MatchesAnything()
        {
            var k = new KeepCriteria { MinRarityRank = -1, SizeRank = -1 };
            Assert.True(KeepMatch.Matches(k, Turret()));
            Assert.True(KeepMatch.Matches(k, Ore()));
        }

        [Fact]
        public void Category_Filters()
        {
            var k = new KeepCriteria { Category = "Turret", MinRarityRank = -1, SizeRank = -1 };
            Assert.True(KeepMatch.Matches(k, Turret()));
            Assert.False(KeepMatch.Matches(k, Ore()));
        }

        [Fact]
        public void Type_NonEquipment_NeverMatches()
        {
            var k = new KeepCriteria { Type = "PlasmaBeam", MinRarityRank = -1, SizeRank = -1 };
            Assert.True(KeepMatch.Matches(k, Turret()));
            Assert.False(KeepMatch.Matches(k, Ore())); // Type == null
        }

        [Fact]
        public void MinRarity_IsInclusiveFloor()
        {
            Assert.True(KeepMatch.Matches(new KeepCriteria { MinRarityRank = 3, SizeRank = -1 }, Turret()));  // 3 >= 3
            Assert.True(KeepMatch.Matches(new KeepCriteria { MinRarityRank = 2, SizeRank = -1 }, Turret()));  // 3 >= 2
            Assert.False(KeepMatch.Matches(new KeepCriteria { MinRarityRank = 4, SizeRank = -1 }, Turret())); // 3 < 4
        }

        [Fact]
        public void Size_NonEquipment_Fails()
        {
            // Ore has no size at all (SizeRank -1), so any size rule must exclude it — otherwise a rule about
            // modules would start sparing materials.
            var k = new KeepCriteria { SizeRank = 1, MinRarityRank = -1 };
            Assert.False(KeepMatch.Matches(k, Ore()));
            Assert.True(KeepMatch.Matches(k, Turret()));   // the turret IS size 1
        }

        [Fact]
        public void MinLevel_Floor()
        {
            Assert.True(KeepMatch.Matches(new KeepCriteria { MinLevel = 40, MinRarityRank = -1, SizeRank = -1 }, Turret()));
            Assert.False(KeepMatch.Matches(new KeepCriteria { MinLevel = 41, MinRarityRank = -1, SizeRank = -1 }, Turret()));
        }

        [Fact]
        public void Aspect_ExactId()
        {
            Assert.True(KeepMatch.Matches(new KeepCriteria { Aspect = "overcharge", MinRarityRank = -1, SizeRank = -1 }, Turret()));
            Assert.False(KeepMatch.Matches(new KeepCriteria { Aspect = "nope", MinRarityRank = -1, SizeRank = -1 }, Turret()));
        }

        [Fact]
        public void Aspect_BossSentinel_MatchesAnyBoss()
        {
            var k = new KeepCriteria { Aspect = KeepMatch.AllBossAspects, MinRarityRank = -1, SizeRank = -1 };
            Assert.True(KeepMatch.Matches(k, Turret())); // has "boss_krall_rage"
            var noBoss = Turret(); noBoss.AspectIds = new[] { "overcharge" };
            Assert.False(KeepMatch.Matches(k, noBoss));
        }

        [Fact]
        public void Aspect_NoAspects_Fails()
        {
            var k = new KeepCriteria { Aspect = "overcharge", MinRarityRank = -1, SizeRank = -1 };
            Assert.False(KeepMatch.Matches(k, Ore()));
        }

        [Fact]
        public void AllCriteria_Together()
        {
            var k = new KeepCriteria { Category = "Turret", Type = "PlasmaBeam", MinRarityRank = 2, SizeRank = 1, MinLevel = 30, Aspect = KeepMatch.AllBossAspects };
            Assert.True(KeepMatch.Matches(k, Turret()));
        }
    
        // Size is EXACT, unlike rarity and level. A Large module is not a better Small one — it fits a different
        // slot — so a rule naming Medium must not spare Large.
        [Fact]
        public void SizeMatchesExactlyNotAsAMinimum()
        {
            var medium = new KeepCriteria { MinRarityRank = -1, SizeRank = 1 };
            Assert.True(KeepMatch.Matches(medium, Turret()));                                  // turret is size 1
            Assert.False(KeepMatch.Matches(new KeepCriteria { MinRarityRank = -1, SizeRank = 0 }, Turret()));  // smaller
            Assert.False(KeepMatch.Matches(new KeepCriteria { MinRarityRank = -1, SizeRank = 2 }, Turret()));  // bigger
        }
}
}
