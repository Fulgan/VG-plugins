using System.Collections;
using System.Collections.Generic;
using Source.Galaxy.POI;
using Source.Item;
using Source.Player;

namespace Hypercom
{
    // Does the game's inventory DATA agree with what its panel DRAWS?
    //
    // `Inventory` keeps two arrays: `allItems`, which is the data (and what the public `items` projects), and
    // `visibleItems`, which is what a panel renders. Only `UpdateVisibleItems()` reconciles them, and the game
    // calls it from ten places — none of which is the store that RECEIVES a shop buy-back. So an item can be in
    // your hold, be saved, and be invisible until something else rebuilds the list.
    //
    // A player cannot report that: it looks exactly like the item never arrived. This compares the two arrays, so
    // the divergence itself is the observation, and the log line names what is missing and what preceded it.
    internal static class Diag
    {
        // The comparison itself lives in `Shared/ViewDivergence.cs` — game-free, so the tests can pin it.

        // `slot|name` — slot alone cannot be read after a sort renumbers it, and name alone collapses
        // stacks of the same item sitting in different slots.
        private static string Key(object entry)
        {
            if (entry == null) return "null";
            var slot = VG.Game.GameMembers.Get(entry, "slot");
            var item = VG.Game.GameMembers.Get(entry, "item") as Behaviour.Item.InventoryItemType;
            return (slot?.ToString() ?? "?") + "|" + (item != null ? VG.Game.ItemNames.Pretty(item) : "?");
        }

        private static List<string> Keys(object array)
        {
            var keys = new List<string>();
            if (array is IEnumerable rows)
                foreach (var r in rows)
                    if (r != null) keys.Add(Key(r));
            return keys;
        }

        internal static VG.Game.ViewDivergence Check(Inventory inv)
        {
            if (inv == null) return null;
            var data = Keys(VG.Game.GameMembers.GetPrivate(inv, "allItems"));
            var view = Keys(VG.Game.GameMembers.GetPrivate(inv, "visibleItems"));
            return VG.Game.ViewDivergence.Compare(data, view);
        }

        // ⚠️ A FILTER MAKES A DIVERGENCE NORMAL. `UpdateVisibleItems` copies everything only when there is no
        // search text and no category filter; otherwise `visibleItems` is deliberately a subset (`Inventory.cs:748`).
        // So a divergence is evidence of the game bug ONLY on an unfiltered store — without this the diagnostic
        // reports a player's own filter as a fault, which is worse than not having it.
        private static string FilterOf(Inventory inv)
        {
            var search = VG.Game.GameMembers.Get(inv, "searchFilter") as string;
            var byCategory = VG.Game.GameMembers.Get(inv, "hasCategoryFilter") is bool b && b;
            if (!string.IsNullOrEmpty(search) && byCategory) return "search \"" + search + "\" + a category filter";
            if (!string.IsNullOrEmpty(search)) return "search \"" + search + "\"";
            return byCategory ? "a category filter" : null;
        }

        // Every store the player can look at, named as `/inventories` names them.
        private static IEnumerable<KeyValuePair<string, Inventory>> Stores()
        {
            var p = GamePlayer.current;
            yield return new KeyValuePair<string, Inventory>("cargo", p?.currentSpaceShip?.cargo);
            yield return new KeyValuePair<string, Inventory>("armory", p?.globalInventory);
            // `dataInventory` is beta-only (absent on 0.8.0.15) ∴ by name, or this method fails to JIT there.
            yield return new KeyValuePair<string, Inventory>("data", VG.Game.GameMembers.Get(p, "dataInventory") as Inventory);
            yield return new KeyValuePair<string, Inventory>("material", SpaceStation.current?.materialStorage);
            yield return new KeyValuePair<string, Inventory>("shop", SpaceStation.current?.shopInventory);
        }

        internal static Dictionary<string, object> Dto()
        {
            var stores = new List<object>();
            var diverged = 0;
            foreach (var kv in Stores())
            {
                var d = Check(kv.Value);
                if (d == null) continue;
                var filter = FilterOf(kv.Value);
                var unexplained = d.Diverged && filter == null;
                if (unexplained) diverged++;
                stores.Add(new Dictionary<string, object>
                {
                    ["store"] = kv.Key,
                    ["data"] = d.Data,
                    ["view"] = d.View,
                    ["filter"] = filter,                 // non-null ⇒ the subset is the player's own doing
                    ["diverged"] = unexplained,          // a fault only when nothing explains it
                    ["missingFromView"] = d.MissingFromView,
                    ["onlyInView"] = d.OnlyInView,
                });
            }
            return new Dictionary<string, object>
            {
                ["stores"] = stores,
                ["divergedStores"] = diverged,
                // What the game did last, as far as we can tell — the value of the report is the pairing of a
                // divergence with the action before it, since that is what a bug report needs and what a player
                // cannot recall afterwards.
                ["lastAction"] = LastAction,
                ["docked"] = SpaceStation.current != null,
            };
        }

        // Set by whoever is about to touch a store, ours or the game's, as far as we can observe it.
        internal static string LastAction = "none";

        internal static void Note(string action) => LastAction = action;

        // Called on the transitions the watcher already detects. Logs ONCE per divergence per store so a
        // permanent divergence does not fill the log at frame rate.
        private static readonly Dictionary<string, string> Reported = new Dictionary<string, string>();

        internal static void LogIfDiverged(string when)
        {
            foreach (var kv in Stores())
            {
                var d = Check(kv.Value);
                if (d == null) continue;
                if (FilterOf(kv.Value) != null) continue;   // the player is filtering; nothing to report
                var signature = d.Diverged ? d.Data + "/" + d.View + ":" + string.Join(",", d.MissingFromView.ToArray()) : "";
                Reported.TryGetValue(kv.Key, out var last);
                if (signature == (last ?? "")) continue;
                Reported[kv.Key] = signature;
                if (!d.Diverged) continue;
                Plugin.Log.LogWarning(
                    $"[diag] {kv.Key} view disagrees with data at {when} (after {LastAction}): data {d.Data} rows, view {d.View}. " +
                    $"Not drawn: {string.Join(", ", d.MissingFromView.ToArray())}. " +
                    "The items are in the save; the panel has not rebuilt its list. GET /diag/inventory for the full picture.");
            }
        }
    }
}
