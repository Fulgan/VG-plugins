using System;
using System.Globalization;
using VG.Text;
using Xunit;

namespace StationAssistant.Tests
{
    // The inflector is hand-rolled (Humanizer's needs BCL assemblies Unity's Mono lacks, and threw inside the
    // notification it was formatting), so every rule it implements is pinned here — these strings land in front
    // of the player, and there is no library behind them to be right on our behalf.
    public class SayTests
    {
        [Theory]
        [InlineData(1, "item", "1 item")]
        [InlineData(3, "item", "3 items")]
        [InlineData(0, "item", "0 items")]
        // Multi-word nouns inflect on the LAST word only, which is what makes item names usable here.
        [InlineData(2, "other ship", "2 other ships")]
        [InlineData(12, "Ion Cell", "12 Ion Cells")]
        [InlineData(1, "Ion Cell", "1 Ion Cell")]
        // An already-plural game name must not double up ("Shellses").
        [InlineData(240, "Flak Shells", "240 Flak Shells")]
        // Real translated ammo names: "Ammo" is uncountable and must not gain an -s, and an already-plural
        // "Projectiles" must not double up. Before the game text was translated these arrived as keys
        // ("@RailcannonAmmo") and the inflector mangled those into "@RailcannonAmmos".
        [InlineData(270, "Railcannon Ammo", "270 Railcannon Ammo")]
        [InlineData(2, "Missile Ammo", "2 Missile Ammo")]
        [InlineData(3, "Plasma AutoCannon Projectiles", "3 Plasma AutoCannon Projectiles")]

        // Irregulars: the -s rules get these wrong, so they are table-driven.
        [InlineData(2, "Battery", "2 Batteries")]
        [InlineData(3, "Analysis", "3 Analyses")]
        [InlineData(3, "Ammo", "3 Ammo")]          // uncountable: "3 Ammos" is wrong
        [InlineData(2, "Bus", "2 Buses")]           // -us is singular, unlike a plain -s
        [InlineData(4, "Mass", "4 Masses")]
        [InlineData(2, "Plasma Cell", "2 Plasma Cells")]
        [InlineData(2, "Umbral Decoy", "2 Umbral Decoys")]  // -oy: vowel before y, so not -ies
        public void Count_inflects_and_groups(long n, string noun, string expected)
            => Assert.Equal(expected, Say.Count(n, noun));

        [Fact]
        public void Count_honours_an_explicit_plural_override()
        {
            Assert.Equal("3 Ammo", Say.Count(3, "Ammo", "Ammo"));
            Assert.Equal("1 Ammo", Say.Count(1, "Ammo", "Ammo"));
        }

        [Theory]
        [InlineData(new[] { "a" }, "a")]
        [InlineData(new[] { "a", "b" }, "a and b")]
        [InlineData(new[] { "a", "b", "c" }, "a, b and c")]
        public void List_joins_with_a_trailing_and(string[] parts, string expected)
            => Assert.Equal(expected, Say.List(parts));

        [Fact]
        public void List_drops_empties_and_tolerates_nothing()
        {
            Assert.Equal("", Say.List(null));
            Assert.Equal("", Say.List(new string[0]));
            Assert.Equal("a and b", Say.List(new[] { "a", "", null, "b" }));
        }

        // Grouping follows the PLAYER's locale (a bare 1204 reads as the wrong magnitude at a glance), so
        // these pin a culture rather than assume the build machine's — fr-CH groups with a space, en-US with
        // a comma, and both are correct in front of the player who set them.
        [Fact]
        public void Counts_and_credits_group_per_culture()
        {
            InCulture("en-US", () =>
            {
                Assert.Equal("1,204 rounds", Say.Count(1204, "round"));
                Assert.Equal("966,778 cr", Say.Credits(966778));
            });
            InCulture("fr-CH", () =>
            {
                Assert.Equal("1 204 rounds", Say.Count(1204, "round").Replace(' ', ' ').Replace(' ', ' '));
                Assert.Equal("966 778 cr", Say.Credits(966778).Replace(' ', ' ').Replace(' ', ' '));
            });
        }

        private static void InCulture(string name, Action body)
        {
            var prev = CultureInfo.CurrentCulture;
            CultureInfo.CurrentCulture = new CultureInfo(name);
            try { body(); } finally { CultureInfo.CurrentCulture = prev; }
        }
    }
}
