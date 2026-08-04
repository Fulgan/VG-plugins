using System.Collections.Generic;
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
    }
}
