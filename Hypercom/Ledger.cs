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
        private static readonly object Gate = new object();
        private static List<Dictionary<string, object>> _cache;

        private static string Path => System.IO.Path.Combine(Paths.ConfigPath, "hypercom-ledger.jsonl");

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
                lock (Gate)
                {
                    Load();
                    _cache.Add(entry);
                    if (_cache.Count > MaxEntries) _cache.RemoveRange(0, _cache.Count - MaxEntries);
                    Persist();
                }
            }
            catch (Exception ex) { Plugin.Log.LogWarning($"ledger write failed: {ex.Message}"); }
        }

        // Newest first, optionally limited and scoped to one playthrough. Totals are computed over the FILTERED
        // rows, so they always describe what the caller is looking at.
        internal static Dictionary<string, object> Dto(int limit, string playthrough)
        {
            lock (Gate)
            {
                Load();
                var rows = _cache.AsEnumerable();
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
            lock (Gate)
            {
                Load();
                var before = _cache.Count;
                _cache = string.IsNullOrEmpty(playthrough)
                    ? new List<Dictionary<string, object>>()
                    : _cache.Where(e => !string.Equals(Get(e, "playthrough"), playthrough, StringComparison.Ordinal)).ToList();
                Persist();
                return before - _cache.Count;
            }
        }

        private static void Load()
        {
            if (_cache != null) return;
            _cache = new List<Dictionary<string, object>>();
            try
            {
                if (!File.Exists(Path)) return;
                foreach (var line in File.ReadAllLines(Path))
                {
                    if (string.IsNullOrWhiteSpace(line)) continue;
                    // One unparseable line loses one transaction, not the file: a partial last write (killed
                    // mid-append) must not take the rest of the history with it.
                    try { var o = Json.ParseObject(line); if (o != null) _cache.Add(o); } catch { }
                }
            }
            catch (Exception ex) { Plugin.Log.LogWarning($"ledger load failed: {ex.Message}"); }
        }

        private static void Persist()
        {
            try
            {
                File.WriteAllLines(Path, _cache.Select(Json.Write));
            }
            catch (Exception ex) { Plugin.Log.LogWarning($"ledger save failed: {ex.Message}"); }
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
