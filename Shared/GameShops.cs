using System.Collections.Generic;
using Behaviour.Item;
using Source.Galaxy.POI;
using Source.Item;

// Shared game-bound helper: enumerate every facility shop a station has. Both plugins listed the same
// eight shop properties (general/mining/salvage/bounty/patrol/industry/conquest/umbral); one place now,
// so adding a facility is a single edit. Compiled into each plugin (no shared DLL).
namespace VG.Game
{
    internal static class GameShops
    {
        // Non-null, de-duplicated facility shops for a station (empty when station is null).
        internal static IEnumerable<ShopInventory> Enumerate(SpaceStation station)
        {
            if (station == null)
                yield break;
            var all = new[]
            {
                station.generalShopInventory, station.miningShopInventory, station.salvageShopInventory,
                station.bountyShopInventory, station.patrolShopInventory, station.industryShopInventory,
                station.conquestShopInventory, station.umbralShopInventory,
            };
            var seen = new HashSet<ShopInventory>();
            foreach (var s in all)
                if (s != null && seen.Add(s))
                    yield return s;
        }

        /**
         * Put sold goods on a shelf the player can find them on, and say what happened.
         *
         * ONE owner, because two plugins sell (the bridge's `/sell` and Station Assistant's auto-sell) and both
         * had their own copy of this — with the same two faults, fixed once in one of them.
         *
         * Written from the game's own path (`InventoryInteractionManager.SellAmount`, 0.8.1.23):
         *
         *   - the goods go to the shop WHATEVER `buyBack` says. It is the third ARGUMENT to `Add` — the flag
         *     stored on the new entry — and gating the add on it means anything not buy-back-able is sold into
         *     nowhere and the player never sees it again.
         *   - the game adds to the shop the player has OPEN. A hotkey or a bridge sale has none, so the general
         *     store is the closest equivalent; `SpaceStation.shopInventory` is only "first non-null of the
         *     eight", which at a bounty-only station is the bounty office.
         *   - `Inventory.Add` grows its array and checks no capacity, so there is nothing to clamp against.
         *
         * Returns whether the goods can be BOUGHT BACK, and the reason when they cannot.
         */
        /**
         * Push a mutation into the shop grid the player is looking AT.
         *
         * The game's own sell path ends in `InventoryInteractionManager.ReloadUI()`, and a mod that skips it
         * leaves the panel drawing the list it built when it opened: the goods are on the shelf, the shop looks
 * empty, and typing in the shop's search box — which rebuilds the grid — makes them appear.
         * `UpdateVisibleItems` is internal, so it is reached by name; both halves are best-effort, because a
         * repaint that fails must never fail the sale that already happened.
         */
        // Rebuild a store's VISIBLE list and reload whatever panel is drawing it. Named for the shop it was
        // written for, but it applies to any inventory, and the player's own stores need it MORE: the cargo panel
        // only rebuilds when `spaceUsed` changes (`InventoryPanel.FillCargoImage`), so a change that nets to the
        // same volume — sell an item and buy the same one back — leaves it drawing a list the data has moved past.
        public static void Repaint(Inventory shop)
        {
            if (shop == null) return;
            _updateVisible = _updateVisible ?? typeof(Inventory).GetMethod("UpdateVisibleItems",
                System.Reflection.BindingFlags.Instance | System.Reflection.BindingFlags.NonPublic
                | System.Reflection.BindingFlags.Public);
            try { _updateVisible?.Invoke(shop, null); } catch { }
            try
            {
                // ⊥ gated on `isShopOpen`: the station-storage and cargo panels are the ones that go stale
                // without a volume delta, and the game calls this unconditionally itself (`Inventory.cs:806`).
                Behaviour.UI.InventoryInteractionManager.Instance?.ReloadUI();
            }
            catch { }
        }

        private static System.Reflection.MethodInfo _updateVisible;

        public static (bool boughtBack, string note) Shelve(SpaceStation station, InventoryItemType item, int amount)
        {
            if (station == null) return (false, "no station");
            if (item == null || amount <= 0) return (false, "nothing to shelve");
            ShopInventory target = station.generalShopInventory;
            if (target == null)
                foreach (var s in Enumerate(station)) { target = s; break; }
            if (target == null) return (false, "this station has no shop");
            try
            {
                target.Add(item, amount, item.buyBack);
                return (item.buyBack, item.buyBack ? null : "the game does not allow buying these back");
            }
            catch (System.Exception ex) { return (false, ex.GetType().Name); }
        }
    }
}
