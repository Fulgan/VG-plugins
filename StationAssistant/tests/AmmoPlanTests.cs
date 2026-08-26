using VG.Core;
using Xunit;

namespace StationAssistant.Tests
{
    // The restock arithmetic, headless. A hold budget has to come back as a per-ammo round count, and the whole
    // point of the rule is that the split is by FIRING TIME rather than by volume: the two agree only when every
    // type happens to be burned at the same rate, which is exactly the case a hand check would pick.
    public class AmmoPlanTests
    {
        [Fact]
        public void every_ammo_type_lasts_the_same_time_even_when_one_is_burned_far_faster()
        {
            // A fast, compact round against a slow, bulky one. An even split of the 100 m3 would give each 50 m3:
            // 50 rounds of the first (16.7s) and 5 of the second (50s), so the ship is dry on one for half a minute
            // while still carrying the other.
            var fast = new AmmoDraw(perSecond: 3.0, volumePerRound: 1.0);
            var slow = new AmmoDraw(perSecond: 0.1, volumePerRound: 10.0);

            var seconds = AmmoPlan.SecondsAffordable(new[] { fast, slow }, budgetVolume: 100.0);

            // 100 / (3*1 + 0.1*10) = 25s for both.
            Assert.Equal(25.0, seconds, 9);
            Assert.Equal(75, AmmoPlan.RoundsFor(fast.PerSecond, seconds));
            Assert.Equal(3, AmmoPlan.RoundsFor(slow.PerSecond, seconds));
        }

        [Fact]
        public void the_split_spends_the_budget_and_no_more()
        {
            var a = new AmmoDraw(2.0, 0.5);
            var b = new AmmoDraw(0.25, 4.0);
            var seconds = AmmoPlan.SecondsAffordable(new[] { a, b }, 60.0);

            // Rounding up can only ever push it over by less than one round of each type.
            var spent = AmmoPlan.RoundsFor(a.PerSecond, seconds) * a.VolumePerRound
                      + AmmoPlan.RoundsFor(b.PerSecond, seconds) * b.VolumePerRound;
            Assert.True(spent >= 60.0);
            Assert.True(spent < 60.0 + a.VolumePerRound + b.VolumePerRound);
        }

        [Fact]
        public void an_ammo_of_unknown_volume_is_left_out_rather_than_treated_as_free()
        {
            // Counting it as weightless would let it take rounds out of the answer while adding nothing to the
            // denominator, so the budget would be overspent by however much that type actually occupies.
            var known = new AmmoDraw(1.0, 2.0);
            var unknown = new AmmoDraw(5.0, 0.0);

            var withUnknown = AmmoPlan.SecondsAffordable(new[] { known, unknown }, 20.0);
            var alone = AmmoPlan.SecondsAffordable(new[] { known }, 20.0);
            Assert.Equal(alone, withUnknown, 9);
        }

        [Fact]
        public void a_type_nothing_fires_does_not_shrink_everyone_elses_share()
        {
            var live = new AmmoDraw(1.0, 2.0);
            var idle = new AmmoDraw(0.0, 50.0); // carried, but no gun feeds on it

            Assert.Equal(
                AmmoPlan.SecondsAffordable(new[] { live }, 20.0),
                AmmoPlan.SecondsAffordable(new[] { live, idle }, 20.0),
                9);
        }

        [Fact]
        public void no_budget_and_no_draw_both_mean_no_cap_to_impose()
        {
            Assert.Equal(0.0, AmmoPlan.SecondsAffordable(new[] { new AmmoDraw(1.0, 1.0) }, 0.0));
            Assert.Equal(0.0, AmmoPlan.SecondsAffordable(new[] { new AmmoDraw(0.0, 1.0) }, 100.0));
            Assert.Equal(0.0, AmmoPlan.SecondsAffordable(null, 100.0));
        }

        [Fact]
        public void a_round_count_is_rounded_up_so_the_stock_reaches_the_time_it_was_asked_for()
        {
            Assert.Equal(1, AmmoPlan.RoundsFor(0.1, 1.0));   // a tenth of a round still needs one aboard
            Assert.Equal(3, AmmoPlan.RoundsFor(1.5, 2.0));   // 3.0 exactly: rounding up must not add a free one
            Assert.Equal(4, AmmoPlan.RoundsFor(1.5, 2.1));
            Assert.Equal(0, AmmoPlan.RoundsFor(0.0, 100.0));
            Assert.Equal(0, AmmoPlan.RoundsFor(1.0, 0.0));
        }
    }
}
