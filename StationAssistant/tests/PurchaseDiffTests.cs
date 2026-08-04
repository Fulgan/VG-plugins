using System;
using VG.Core;
using Xunit;

namespace StationAssistant.Tests
{
    // Differential / oracle tests: reconstruct the EXACT pre-refactor affordability math from both old
    // buy paths (BuyFromShop, Quartermaster.Purchase) and fuzz thousands of random inputs asserting the
    // new shared PurchasePlan.Affordable produces the identical result. This proves the refactor is
    // behaviour-preserving without anyone eyeballing the diff or running the game. The cargo-fit step is
    // supplied as the same closure to both sides, so it cancels and the test isolates the pay/stock math.
    public class PurchaseDiffTests
    {
        sealed class Ctx : IPurchaseContext
        {
            public long Credits { get; set; }
            public int Barter { get; set; }
            public Func<float, int, int> Fit;
            public int OwnedBarter(string costItem) => Barter;
            public int CargoFitUnits(float unitVolume, int want) => Fit != null ? Fit(unitVolume, want) : want;
        }

        // ---- oracles: verbatim reconstructions of the original code ----

        // Original BuyFromShop clamp (Plugin.cs), cargo-fit modelled by `fit`.
        static int OldBuyFromShop(bool barter, int cost, int per, int owned, long credits, int stock, bool infinite, int needed, Func<int, int> fit)
        {
            var available = infinite ? int.MaxValue : stock;
            var amount = Math.Min(needed, available);
            if (barter)
            {
                var canPay = per > 0 ? owned / per : amount;
                amount = Math.Min(amount, canPay);
            }
            else
            {
                if (cost <= 0) return 0;
                amount = Math.Min(amount, (int)Math.Min(int.MaxValue, credits / cost));
            }
            amount = fit(amount);
            if (amount <= 0) return 0;
            return amount;
        }

        // Original Quartermaster.Purchase clamp (no cargo fit).
        static int OldPurchase(bool barter, int cost, int per, int owned, long credits, int stock, bool infinite, int needed)
        {
            var amount = needed;
            if (amount <= 0) return 0;
            if (barter)
            {
                var canPay = per > 0 ? owned / per : amount;
                amount = Math.Min(amount, canPay);
            }
            else
            {
                if (cost <= 0) return 0;
                amount = Math.Min(amount, (int)Math.Min(int.MaxValue, credits / cost));
            }
            if (!infinite) amount = Math.Min(amount, stock);
            if (amount <= 0) return 0;
            return amount;
        }

        static Offer MakeOffer(bool barter, int cost, int per, int stock, bool infinite) => new Offer
        {
            Cost = cost,
            CostItem = barter ? "scrap" : null,
            CostItemPer = per,
            Stock = infinite ? -1 : stock,
            UnitVolume = 1f,
        };

        [Fact]
        public void Fuzz_MatchesBothOriginalBuyPaths()
        {
            var rng = new Random(1234567); // fixed seed → reproducible
            for (var i = 0; i < 200000; i++)
            {
                var barter = rng.Next(2) == 0;
                var cost = rng.Next(-2, 500);          // include 0 / negative (free/invalid)
                var per = rng.Next(0, 6);              // include 0 (no per-unit barter cost)
                var owned = rng.Next(0, 200);
                long credits = rng.Next(0, 100000);
                var stock = rng.Next(0, 50);
                var infinite = rng.Next(4) == 0;       // ~25% infinite supply
                var needed = rng.Next(0, 40);

                var offer = MakeOffer(barter, cost, per, stock, infinite);

                // Purchase path: identity fit (destination space pre-checked upstream).
                var ctxId = new Ctx { Credits = credits, Barter = owned, Fit = null };
                Assert.Equal(
                    OldPurchase(barter, cost, per, owned, credits, stock, infinite, needed),
                    PurchasePlan.Affordable(offer, ctxId, needed));

                // BuyFromShop path: a shared arbitrary cargo cap applied identically to both sides.
                var cap = rng.Next(0, 40);
                Func<int, int> fit = a => Math.Min(a, cap);
                var ctxCap = new Ctx { Credits = credits, Barter = owned, Fit = (_, want) => fit(want) };
                Assert.Equal(
                    OldBuyFromShop(barter, cost, per, owned, credits, stock, infinite, needed, fit),
                    PurchasePlan.Affordable(offer, ctxCap, needed));
            }
        }
    }
}
