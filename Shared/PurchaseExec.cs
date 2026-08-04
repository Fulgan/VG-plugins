using System;
using Behaviour.Item;
using Source.Galaxy.POI;
using Source.Item;
using Source.Player;
using Source.SpaceShip;
using UnityEngine;

// Game-bound adapter for the shared purchase flow: maps a game shop offer → the game-free VG.Core.Offer
// the planner works on, exposes player/space state via IPurchaseContext, and performs the actual buy
// mutation the game's own way. Compiled into each plugin (no shared DLL). The affordability *decision*
// lives in VG.Core.PurchasePlan (pure + unit-tested); everything that touches game state lives here so
// StationAssistant's decoy restock, the Quartermaster, and Hypercom's buy endpoint share ONE flow.
namespace VG.Game
{
    internal static class PurchaseExec
    {
        // Shop offer → game-free Offer. CostItem is just a non-null marker for "barter" (the real barter
        // item object stays with the context for the mutation); infinite supply → Stock = -1.
        internal static VG.Core.Offer ToOffer(Inventory.InventoryItem offer) => new VG.Core.Offer
        {
            Cost = offer.cost,
            CostItem = offer.costItem != null ? (offer.costItem.identifier ?? "barter") : null,
            CostItemPer = offer.costItemCount,
            Stock = offer.item.HasInfiniteShopSupply() ? -1 : offer.count,
            UnitVolume = offer.item.m3,
        };

        // The purchase mutation, mirroring the game's own flow: pay (barter or credits) → add to dest →
        // decrement finite stock → fire OnPurchase. Caller has already clamped `amount` via PurchasePlan.
        internal static void Apply(GamePlayer player, ShopInventory shop, Inventory.InventoryItem offer, Inventory dest, int amount)
        {
            if (amount <= 0) return;
            if (offer.costItem != null)
                player.ConsumeAvailableItems(offer.costItem, offer.costItemCount * amount);
            else
                Wallet.Spend(player, offer.cost * amount);  // arity differs by build — see Wallet
            dest.Add(offer.item, amount);
            if (!offer.item.HasInfiniteShopSupply())
                shop.Remove(offer, amount);
            foreach (var part in offer.item.GetComponents<InventoryItemPart>())
                part.OnPurchase(amount);
        }
    }

    // IPurchaseContext over the live game. `barter` is the offer's barter item (null for credit buys);
    // `fit` decides how many units fit the destination — cargo callers pass a volume-shrink closure,
    // callers whose space is pre-checked pass null (→ no extra clamp).
    internal sealed class BuyContext : VG.Core.IPurchaseContext
    {
        readonly GamePlayer _player;
        readonly InventoryItemType _barter;
        readonly Func<float, int, int> _fit;

        internal BuyContext(GamePlayer player, InventoryItemType barter, Func<float, int, int> fit)
        {
            _player = player; _barter = barter; _fit = fit;
        }

        public long Credits => Wallet.Balance(_player);
        public int OwnedBarter(string costItem) => _barter != null ? _player.CountAvailableItems(_barter) : 0;
        public int CargoFitUnits(float unitVolume, int want) => _fit != null ? _fit(unitVolume, want) : want;
    }
}
