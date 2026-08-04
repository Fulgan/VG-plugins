using System;
using System.Collections.Generic;
using System.Linq;
using Source.Player;
using VG.Loadout;

namespace Hypercom
{
    // "Where is my stuff?" — every station keeps its OWN material storage, so a long playthrough scatters
    // materials across dozens of stations with no in-game way to see the whole picture.
    //
    // The useful discovery: a remote station's `materialStorage` is fully readable without docking. Every
    // SpaceStation POI in memory carries its inventory, so the entire galaxy's storage can be summarised
    // from one call. Slot lists include empty slots (Inventory.DefaultLength is 16), so entries with a null
    // item are skipped.
    //
    // Station storage is the WHOLE scope: the ship's cargo and the armory are deliberately not here. Both
    // follow the player rather than sitting somewhere, so neither has a system to name, and the question
    // this answers is strictly positional — which station to fly to. Every `place` is a station and every
    // `at` entry carries a system.
    internal static class Materials
    {
        private const float TtlSeconds = 5f;
        private static object _dto;
        private static float _dtoAt = -999f;
        private static string _dtoPlaythrough;

        internal static void Invalidate() { lock (Lock) { _dto = null; _dtoAt = -999f; } }
        private static readonly object Lock = new object();

        internal static Api.Result Dto(bool fresh) => MainThread.Run(() =>
        {
            var player = GamePlayer.current;
            var map = Compat.Get(player, "map");
            if (map == null) return Api.Result.Err(404, "no galaxy map (no save loaded?)");
            var pt = LoadoutStore.PlaythroughKey(player);

            var now = UnityEngine.Time.realtimeSinceStartup;
            if (!fresh)
                lock (Lock)
                    if (_dto != null && _dtoPlaythrough == pt && now - _dtoAt < TtlSeconds)
                        return Api.Result.Ok(_dto);

            // guid → aggregate across every location, so "I have 300 titanium, spread over 4 stations" is
            // answerable directly rather than by summing client-side.
            var totals = new Dictionary<string, Dictionary<string, object>>();
            var places = new List<object>();

            void Record(string placeName, string placeGuid, string systemName, string systemGuid, object inventory)
            {
                var items = ReadSlots(inventory);
                if (items.Count == 0) return;
                places.Add(new Dictionary<string, object>
                {
                    // Constant: a place here is always a station. The field stays so a client never has to
                    // special-case its absence.
                    ["kind"] = "station",
                    ["name"] = placeName,
                    ["guid"] = placeGuid,
                    ["system"] = systemGuid,
                    ["systemName"] = systemName,
                    // m3 in use, the figure the game's own per-system tooltip shows ("Materials stored: 1,764m3").
                    ["volume"] = AsFloat(Compat.Get(inventory, "spaceUsed")),
                    ["items"] = items.Select(kv => (object)new Dictionary<string, object>
                    {
                        ["id"] = kv.Key,
                        ["name"] = kv.Value.Label ?? kv.Key,
                        ["category"] = kv.Value.Category,
                        ["count"] = kv.Value.Count,
                    }).OrderByDescending(x => (long)((Dictionary<string, object>)x)["count"]).ToList(),
                    ["slots"] = items.Count,
                });

                foreach (var kv in items)
                {
                    if (!totals.TryGetValue(kv.Key, out var agg))
                        totals[kv.Key] = agg = new Dictionary<string, object>
                        {
                            ["id"] = kv.Key,
                            ["name"] = kv.Value.Label ?? kv.Key,
                            // Without this the client can't separate a million rounds of ammo from the
                            // refined products someone is actually hunting for.
                            ["category"] = kv.Value.Category,
                            ["total"] = 0L,
                            ["at"] = new List<object>(),
                        };
                    agg["total"] = (long)agg["total"] + kv.Value.Count;
                    ((List<object>)agg["at"]).Add(new Dictionary<string, object>
                    {
                        ["kind"] = "station",
                        ["name"] = placeName,
                        ["guid"] = placeGuid,
                        ["system"] = systemGuid,
                        ["systemName"] = systemName,
                        ["count"] = kv.Value.Count,
                    });
                }
            }

            // Every station in a subsector you've entered. Same fog-of-war boundary as the map: a station
            // in a subsector you've never seen isn't something you could have stored anything in.
            var visitedSectors = new HashSet<string>();
            foreach (var sys in Compat.Enumerate(Compat.Get(map, "allSystems")))
                if (AsFloat(Compat.Call(sys, "GetLastVisitedTime")) > 0f)
                {
                    var sg = Compat.Get<string>(Compat.Get(sys, "sector"), "guid", null);
                    if (sg != null) visitedSectors.Add(sg);
                }

            foreach (var sys in Compat.Enumerate(Compat.Get(map, "allSystems")))
            {
                var sectorGuid = Compat.Get<string>(Compat.Get(sys, "sector"), "guid", null);
                if (sectorGuid == null || !visitedSectors.Contains(sectorGuid)) continue;
                var sysName = Compat.Get<string>(sys, "name", null);
                var sysGuid = Compat.Get<string>(sys, "guid", null);
                foreach (var poi in Compat.Enumerate(Compat.Get(sys, "allPointsOfInterest")))
                {
                    if (poi == null || Compat.Get<bool>(poi, "hidden", false)) continue;
                    var storage = Compat.Get(poi, "materialStorage");
                    if (storage == null) continue;
                    Record(Compat.Get<string>(poi, "name", null), Compat.Get<string>(poi, "guid", null), sysName, sysGuid, storage);
                }
            }

            var body = new Dictionary<string, object>
            {
                ["playthrough"] = pt,
                // by item: "where is my titanium", most-plentiful first
                ["items"] = totals.Values
                    .OrderByDescending(x => (long)x["total"])
                    .Select(x =>
                    {
                        x["at"] = ((List<object>)x["at"])
                            .OrderByDescending(a => (long)((Dictionary<string, object>)a)["count"]).ToList();
                        return (object)x;
                    }).ToList(),
                // by place: "what's in this station"
                ["places"] = places,
                ["counts"] = new Dictionary<string, object>
                {
                    ["places"] = places.Count,
                    ["distinctItems"] = totals.Count,
                    ["units"] = totals.Values.Sum(x => (long)x["total"]),
                },
            };
            lock (Lock) { _dto = body; _dtoAt = now; _dtoPlaythrough = pt; }
            return Api.Result.Ok(body);
        });

        // An Inventory's slot list. The member is `items` — there is no `allItems`, and reflection reports
        // a missing member as null, so reading the wrong name produced an *empty* inventory rather than an
        // error: every station looked like it held nothing. Shared with Galaxy's per-system summary so the
        // two can't disagree about where the slots live.
        internal static IEnumerable<object> Slots(object inventory) =>
            Compat.Enumerate(Compat.Get(inventory, "items"));

        // One item's presence in one inventory: how many, and what kind of thing it is.
        private sealed class Held
        {
            internal long Count;
            internal string Category;
            // Captured from the item itself: the dictionary key is the ASSET name, which never translates.
            internal string Label;
        }

        // item id → count + category, skipping the empty slots every Inventory carries.
        private static Dictionary<string, Held> ReadSlots(object inventory)
        {
            var outp = new Dictionary<string, Held>();
            if (inventory == null) return outp;
            foreach (var slot in Slots(inventory))
            {
                if (slot == null) continue;
                var item = Compat.Get(slot, "item");
                if (item == null) continue;
                var id = Compat.Get<string>(item, "name", null);
                if (string.IsNullOrEmpty(id)) continue;
                var n = (long)AsFloat(Compat.Get(slot, "count"));
                if (n <= 0) n = 1;
                if (!outp.TryGetValue(id, out var held))
                    outp[id] = held = new Held
                    {
                        Category = Compat.Get(item, "itemCategory")?.ToString(),
                        Label = Stores.ItemLabel(item),
                    };
                held.Count += n;
            }
            return outp;
        }

        private static float AsFloat(object o)
        {
            if (o is float f) return f;
            if (o is double d) return (float)d;
            if (o is int i) return i;
            if (o is long l) return l;
            return 0f;
        }
    }
}

