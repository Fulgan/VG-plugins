using VG.Core;
using Xunit;

namespace StationAssistant.Tests
{
    public class RarityTests
    {
        [Theory]
        [InlineData("Standard", 0)]
        [InlineData("Enhanced", 1)]
        [InlineData("HighGrade", 2)]
        [InlineData("Exotic", 3)]
        [InlineData("Legendary", 4)]
        public void Rank_MatchesOrder(string name, int expected) => Assert.Equal(expected, Rarity.Rank(name));

        [Fact]
        public void Rank_Unknown_IsNegativeOne() => Assert.Equal(-1, Rarity.Rank("Mythic"));

        [Fact]
        public void Color_KnownRarity_HasHex() => Assert.Equal("#F2C14E", Rarity.Color("Legendary"));

        [Fact]
        public void Color_Unknown_FallsBackToStandard() => Assert.Equal(Rarity.Color("Standard"), Rarity.Color("Nope"));

        [Fact]
        public void Order_IsWorstToBest() => Assert.Equal(new[] { "Standard", "Enhanced", "HighGrade", "Exotic", "Legendary" }, Rarity.Order);
    }
}
