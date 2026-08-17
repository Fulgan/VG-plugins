using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using BepInEx;

namespace Hypercom
{
    // A persisted record of every purchase and sale the web UI makes.
    //
    // Separate from `LogBuffer`, which is a bounded in-memory tail of game notifications and starts empty on
    // every launch: money spent is exactly the thing a player wants to look back at across sessions ("what did
    // that refit cost me?"), and a transaction that only exists until the next restart cannot answer it.
    //
    // Append-only JSON lines, one file for all playthroughs with the fingerprint on each row, so a save that is
    // reloaded keeps its own history and the reader filters. Writes are best-effort: a ledger that throws must
    // never fail the transaction it is recording — the money has already moved by the time we are called.
    internal static class Ledger
    {
        private const int MaxEntries = 4000;   // trimmed on write; ~1 MB of lines at this shape

        // The MECHANICS live in `JsonlStore` — the mission log needs the same append-only file, the same trim and
        // the same deferred write, and two copies of that is two answers to "what happens when a row cannot be
        // written". What stays here is the SHAPE of a transaction row and what a total over them means.
        private static readonly JsonlStore Store = new JsonlStore("hypercom-ledger.jsonl", MaxEntries);

        // One transaction. `credits` is signed from the PLAYER's side: negative for a purchase, positive for a
        // sale, so a running total is a plain sum. A barter purchase moves no credits at all and instead
        // records what was handed over, which is why cost cannot be a single number.
        internal static void Record(string kind, string itemName, string itemId, int count,
                                    long credits, string costItem, int costItemCount, string shop)
        {
            try
            {
                var entry = new Dictionary<string, object>
                {
                    ["at"] = DateTime.UtcNow.ToString("o"),   // socket thread may write: no UnityEngine time here
                    ["kind"] = kind,                          // "buy" | "sell"
                    ["item"] = itemName,
                    ["itemId"] = itemId,
                    ["count"] = count,
                    ["credits"] = credits,
                    ["shop"] = shop,
                    ["station"] = SafeStation(),
                    ["ship"] = SafeShip(),
                    ["playthrough"] = Api.CurrentPlaythrough(),
                };
                if (!string.IsNullOrEmpty(costItem))
                {
                    entry["costItem"] = costItem;
                    entry["costItemCount"] = costItemCount;
                }
                Store.Append(entry);
            }
            catch (Exception ex) { Plugin.Log.LogWarning($"ledger write failed: {ex.Message}"); }
        }

        /**
         * Hold the file write until `Flush`, for an operation that records many rows at once.
         *
         * The ROWS are not batched — the ledger is the audit trail and a sale is a row whatever else is
         * happening. Only the persistence is: rewriting the file per row made a 7,891-item sale into 7,891 full
         * file writes, which is the whole of the ~12ms each sale cost and the reason the game stood still
         * through it. Nested and ref-counted, so an inner scope cannot flush an outer one's work early.
         *
         * `Flush` must run even when the operation throws: an unflushed batch loses rows for transactions that
         * already moved money.
         */
        internal static void Defer() => Store.Defer();

        internal static void Flush() => Store.Flush();

        // Newest first, optionally limited and scoped to one playthrough. Totals are computed over the FILTERED
        // rows, so they always describe what the caller is looking at.
        internal static Dictionary<string, object> Dto(int limit, string playthrough)
        {
            {
                var rows = Store.Rows().AsEnumerable();
                if (!string.IsNullOrEmpty(playthrough))
                    rows = rows.Where(e => string.Equals(Get(e, "playthrough"), playthrough, StringComparison.Ordinal));
                var all = rows.ToList();

                long spent = 0, earned = 0;
                var barters = 0;
                foreach (var e in all)
                {
                    var c = e.TryGetValue("credits", out var v) ? ToLong(v) : 0L;
                    if (c < 0) spent += -c; else earned += c;
                    if (e.ContainsKey("costItem")) barters++;
                }

                var take = limit > 0 ? Math.Min(limit, all.Count) : all.Count;
                var recent = new List<object>(take);
                for (var i = all.Count - 1; i >= all.Count - take; i--) recent.Add(all[i]);

                return new Dictionary<string, object>
                {
                    ["entries"] = recent,
                    ["count"] = all.Count,
                    ["spent"] = spent,
                    ["earned"] = earned,
                    ["net"] = earned - spent,
                    ["barters"] = barters,   // purchases paid in goods: real cost, but not in credits
                };
            }
        }

        // Drop every row for one playthrough (or all of them when none is named).
        internal static int Clear(string playthrough)
        {
            return Store.Keep(e => !string.IsNullOrEmpty(playthrough)
                && !string.Equals(Get(e, "playthrough"), playthrough, StringComparison.Ordinal));
        }

        private static string Get(Dictionary<string, object> e, string k)
            => e.TryGetValue(k, out var v) ? v?.ToString() : null;

        private static long ToLong(object v)
        {
            if (v is long l) return l;
            if (v is int i) return i;
            if (v is double d) return (long)d;
            return long.TryParse(v?.ToString(), out var p) ? p : 0L;
        }

        // Station and ship are recorded for context ("bought where?"), and both are optional: a ledger row is
        // worth keeping even when the world state can't be read.
        private static string SafeStation()
        {
            try { return Source.Galaxy.POI.SpaceStation.current?.name; } catch { return null; }
        }

        private static string SafeShip()
        {
            try
            {
                var ship = Source.Player.GamePlayer.current?.currentSpaceShip;
                return ship == null ? null
                     : !string.IsNullOrEmpty(ship.customShipName) ? ship.customShipName
                     : ship.shipClass?.displayName;
            }
            catch { return null; }
        }
    }
}
