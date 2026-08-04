using System;

// Game-free purchase logic — the affordability math shared by every "buy from a station shop" path
// (StationAssistant decoy restock + Quartermaster consumables, Hypercom's buy endpoint). Pure + POCO,
// no UnityEngine / Assembly-CSharp types, so it compiles into the headless test project WITHOUT the
// game assembly and is unit-tested. Each plugin's adapter converts game objects → Offer /
// IPurchaseContext, calls Affordable, then performs the actual mutation (see VG.Game.PurchaseExec).
namespace VG.Core
{
    // A shop offer as plain data.
    public struct Offer
    {
        public int Cost;         // credit price per unit; ignored when CostItem != null
        public string CostItem;  // barter item identifier, or null for a credit purchase
        public int CostItemPer;  // barter units required per purchased unit
        public int Stock;        // units in stock; negative = infinite supply
        public float UnitVolume; // cargo volume (m³) per unit — for the destination-space clamp
    }

    // What the affordability planner needs to query about the world. Implemented by a plugin adapter
    // over GamePlayer/cargo; faked in tests.
    public interface IPurchaseContext
    {
        long Credits { get; }
        int OwnedBarter(string costItem);              // how many of the barter item the player owns
        int CargoFitUnits(float unitVolume, int want); // how many of `want` units actually fit the dest
    }

    public static class PurchasePlan
    {
        // Units the player can actually buy AND store, clamped by price (credit or barter), stock, and
        // destination space — in that order. No side effects. Mirrors the game's own purchase clamping
        // so the two plugin buy paths can share one implementation instead of each re-deriving it.
        public static int Affordable(Offer o, IPurchaseContext ctx, int needed)
        {
            if (ctx == null || needed <= 0) return 0;
            var amount = needed;
            if (o.Stock >= 0) amount = Math.Min(amount, o.Stock); // finite stock (negative = infinite)
            if (amount <= 0) return 0;

            if (o.CostItem != null) // barter
            {
                var canPay = o.CostItemPer > 0 ? ctx.OwnedBarter(o.CostItem) / o.CostItemPer : amount;
                amount = Math.Min(amount, canPay);
            }
            else // credits
            {
                if (o.Cost <= 0) return 0;
                amount = (int)Math.Min((long)amount, ctx.Credits / o.Cost);
            }
            if (amount <= 0) return 0;

            amount = ctx.CargoFitUnits(o.UnitVolume, amount); // adapter decides what "fits" (cargo vs dest)
            return amount > 0 ? amount : 0;
        }
    }
}
