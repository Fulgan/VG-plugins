using VG.Core;
using Xunit;

namespace StationAssistant.Tests
{
    // Headless unit tests for the game-free purchase affordability logic. A fake IPurchaseContext
    // stands in for GamePlayer/cargo so the money-path math is testable without the game assembly.
    public class PurchasePlanTests
    {
        // Configurable fake world. CargoFit defaults to "everything fits" unless a cap is set.
        sealed class FakeCtx : IPurchaseContext
        {
            public long Credits { get; set; }
            public int Barter { get; set; }
            public int? FitCap { get; set; } // null → unlimited space
            public int OwnedBarter(string costItem) => Barter;
            public int CargoFitUnits(float unitVolume, int want) => FitCap.HasValue ? System.Math.Min(want, FitCap.Value) : want;
        }

        static Offer Credit(int cost, int stock = -1) => new Offer { Cost = cost, CostItem = null, Stock = stock, UnitVolume = 1f };
        static Offer Barter(string item, int per, int stock = -1) => new Offer { CostItem = item, CostItemPer = per, Stock = stock, UnitVolume = 1f };

        [Fact]
        public void CreditBuy_ClampedByCredits()
        {
            var ctx = new FakeCtx { Credits = 250 };
            Assert.Equal(2, PurchasePlan.Affordable(Credit(100), ctx, needed: 5)); // 250/100 = 2
        }

        [Fact]
        public void CreditBuy_ClampedByNeeded()
        {
            var ctx = new FakeCtx { Credits = 100000 };
            Assert.Equal(3, PurchasePlan.Affordable(Credit(10), ctx, needed: 3));
        }

        [Fact]
        public void CreditBuy_ZeroPrice_Refused()
        {
            var ctx = new FakeCtx { Credits = 100000 };
            Assert.Equal(0, PurchasePlan.Affordable(Credit(0), ctx, needed: 5));
        }

        [Fact]
        public void Barter_ClampedByOwnedPerUnit()
        {
            var ctx = new FakeCtx { Barter = 7 };
            Assert.Equal(3, PurchasePlan.Affordable(Barter("scrap", per: 2), ctx, needed: 5)); // 7/2 = 3
        }

        [Fact]
        public void Barter_ShortFunds_Zero()
        {
            var ctx = new FakeCtx { Barter = 1 };
            Assert.Equal(0, PurchasePlan.Affordable(Barter("scrap", per: 2), ctx, needed: 5)); // 1/2 = 0
        }

        [Fact]
        public void FiniteStock_Clamps()
        {
            var ctx = new FakeCtx { Credits = 100000 };
            Assert.Equal(4, PurchasePlan.Affordable(Credit(1, stock: 4), ctx, needed: 10));
        }

        [Fact]
        public void InfiniteStock_NoStockClamp()
        {
            var ctx = new FakeCtx { Credits = 100000 };
            Assert.Equal(10, PurchasePlan.Affordable(Credit(1, stock: -1), ctx, needed: 10));
        }

        [Fact]
        public void CargoFull_ClampsToFit()
        {
            var ctx = new FakeCtx { Credits = 100000, FitCap = 2 };
            Assert.Equal(2, PurchasePlan.Affordable(Credit(1), ctx, needed: 10));
        }

        [Fact]
        public void NeededZeroOrNegative_Zero()
        {
            var ctx = new FakeCtx { Credits = 100000 };
            Assert.Equal(0, PurchasePlan.Affordable(Credit(1), ctx, needed: 0));
            Assert.Equal(0, PurchasePlan.Affordable(Credit(1), ctx, needed: -3));
        }

        [Fact]
        public void CreditsAndStockAndCargo_TightestWins()
        {
            // credits allow 6 (600/100), stock caps 5, cargo caps 3 → 3.
            var ctx = new FakeCtx { Credits = 600, FitCap = 3 };
            Assert.Equal(3, PurchasePlan.Affordable(Credit(100, stock: 5), ctx, needed: 10));
        }
    }
}
