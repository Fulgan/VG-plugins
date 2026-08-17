using System;
using System.Collections.Generic;
using System.Linq;
using Source.Galaxy.POI;
using Source.Player;
using VG.Loadout;

namespace Hypercom
{
    // The galaxy map, as much of it as the player could actually know.
    //
    // Shape of the game's data (mapped with the debug reflection browser):
    //   GalaxyMapData → allSectors (15) → allSystems (200) → pointsOfInterest (1464 total)
    //   SectorMapData : quadrant (0 prologue / 1 frontier / 2 conquest), conquestSector, mapPosition
    //   SystemMapData : guid, name, level, faction, position, isUnlocked, jumpgateOpen,
    //                   GetLastVisitedTime() (0 = NEVER visited), GetAdjacentSystems()
    //   JumpGate POI  : targetSystemGuid, jumpgateOpen, canUseJumpGate, sectorJumpgate,
    //                   linkedJumpgatePassGuid (the pass item that opens it)
    //   SpaceStation  : eight per-facility shop inventories, ShopRefreshInterval (3600s),
    //                   shopRefreshTime (-1 until first visit)
    //
    // Everything goes through Compat reflection rather than typed references: these types are new
    // territory in a beta, and a rename should degrade to a partial map instead of failing to load the
    // plugin (the same reasoning behind the crew-API gate in Api.CrewSupported).
    internal static class Galaxy
    {
        // What the player is allowed to see. Anything below `Known` is never sent to the client at all —
        // fog of war enforced at the source, so no UI mistake can leak it.
        private const string Visited = "visited"; // been there: full POI detail, station shops
        private const string Known = "known";     // a visited system has a gate pointing here: name only

        private const int RecentCount = 25;

        // ---- per-playthrough cache -------------------------------------------------------------
        // Sectors, systems and the gate graph are generated once at new-game and never change, so they
        // are cached. POIs are NOT: they move, and mission objectives are added and removed as POIs
        // (a system's `allPointsOfInterest` really does return more than its backing `pointsOfInterest`
        // list). Visited times, gate/pass state and shop timers change too — all of that is re-read on
        // every call. Keyed by playthrough so a different save can never be served another's galaxy.
        private sealed class Skeleton
        {
            internal string Playthrough;
            internal int SystemCount;
            internal int SectorCount;
            internal List<Dictionary<string, object>> Sectors = new List<Dictionary<string, object>>();
            internal List<Dictionary<string, object>> Systems = new List<Dictionary<string, object>>();
            internal Dictionary<string, object> SystemObjects = new Dictionary<string, object>(); // guid → live SystemMapData
            internal Dictionary<string, object> SectorObjects = new Dictionary<string, object>(); // guid → live SectorMapData
            internal List<Dictionary<string, object>> Edges = new List<Dictionary<string, object>>();
        }

        private static Skeleton _cache;
        private static readonly object Gate = new object();

        // The volatile pass walks all 200 systems and ~1100 POIs, about 85ms, which is a visible
        // frame hitch (see MainThread.Drain: a request IS a frame's work). The map changes only when you
        // travel, so the finished payload is reused for a few seconds. Travel takes far longer than that,
        // so the client can poll freely without ever making the game stutter.
        private const float TtlSeconds = 5f;
        private static object _dto;
        private static float _dtoAt = -999f;
        private static string _dtoPlaythrough;

        internal static void Invalidate() { lock (Gate) { _cache = null; _dto = null; _dtoAt = -999f; } }

        internal static Api.Result Dto(string poisForSystem = null, bool fresh = false) => MainThread.Run(() =>
        {
            var player = GamePlayer.current;
            var map = Compat.Get(player, "map");
            if (map == null) return Api.Result.Err(404, "no galaxy map (no save loaded?)");
            var pt = LoadoutStore.PlaythroughKey(player);

            var now = UnityEngine.Time.realtimeSinceStartup;
            if (poisForSystem == null && !fresh)
                lock (Gate)
                    if (_dto != null && _dtoPlaythrough == pt && now - _dtoAt < TtlSeconds)
                        return Api.Result.Ok(_dto);

            Skeleton sk;
            lock (Gate)
            {
                // A changed playthrough — or a changed system count, which catches a regenerated galaxy
                // the fingerprint somehow shares — rebuilds from scratch.
                // The galaxy is generated in regions, not all at once: an early save has 9 Frontier
                // sectors / 93 systems and NO conquest quadrant, while a late one has 15 / 200. So the
                // "static" skeleton is only static until a region appears — watch both counts and rebuild
                // when either moves.
                var systemCount = Compat.Enumerate(Compat.Get(map, "allSystems")).Count();
                var sectorCount = Compat.Enumerate(Compat.Get(map, "allSectors")).Count();
                if (_cache == null || _cache.Playthrough != pt
                    || _cache.SystemCount != systemCount || _cache.SectorCount != sectorCount)
                    _cache = BuildSkeleton(map, pt, systemCount, sectorCount);
                sk = _cache;
            }

            // Active missions, keyed to the system holding their source POI - the game's system tooltip
            // lists them ("Missions: Lost Crew").
            var missionsBySystem = new Dictionary<string, List<object>>();
            foreach (var m in Compat.Enumerate(Compat.Get(player, "missions")))
            {
                if (m == null) continue;
                var sysGuid = Compat.Get<string>(Compat.Get(Compat.Get(m, "sourcePoi"), "system"), "guid", null);
                if (sysGuid == null) continue;
                if (!missionsBySystem.TryGetValue(sysGuid, out var list))
                    missionsBySystem[sysGuid] = list = new List<object>();
                list.Add(new Dictionary<string, object>
                {
                    ["name"] = Compat.Get<string>(m, "name", null),
                    ["description"] = Compat.Get<string>(m, "description", null),
                    ["storyId"] = Compat.Get<string>(m, "storyId", null),
                    ["complete"] = Compat.Get<bool>(m, "isComplete", false),
                    ["sourcePoi"] = Compat.Get<string>(Compat.Get(m, "sourcePoi"), "guid", null),
                });
            }

            // ---- volatile pass: visits, knowledge, gate state, POIs -----------------------------
            var visitedAt = new Dictionary<string, float>();
            foreach (var kv in sk.SystemObjects)
            {
                var t = AsFloat(Compat.Call(kv.Value, "GetLastVisitedTime"));
                if (t > 0f) visitedAt[kv.Key] = t;
            }

            // KNOWLEDGE IS SECTOR-SCOPED, matching the game's own tooltips. Enter a subsector
            // and every system in it is drawn with level, controlling faction and station owners, even
            // ones behind a locked gate ("Forlorn Graveyard, Lv 25, Controlled by Steel Vultures" shows in
            // full while never visited). An earlier adjacency rule returned 7 of LZ-981 Rift's 12 systems,
            // i.e. strictly less than the game shows. Subsectors never entered stay hidden entirely, so
            // the boundary of knowledge is the subsector, not the system.
            var visitedSectors = new HashSet<string>(
                sk.Systems.Where(x => visitedAt.ContainsKey((string)x["guid"]))
                          .Select(x => (string)x["sector"])
                          .Where(g => g != null));

            var systems = new List<object>();
            // Collected while walking the systems so only factions actually on the visible map are sent.
            var factionsSeen = new List<object>();
            var shown = new HashSet<string>();
            foreach (var s in sk.Systems)
            {
                var guid = (string)s["guid"];
                if (!visitedSectors.Contains((string)s["sector"])) continue; // subsector never entered → hide
                shown.Add(guid);
                var d = new Dictionary<string, object>(s);
                var isVisited = visitedAt.TryGetValue(guid, out var at);
                d["knowledge"] = isVisited ? Visited : Known;
                if (isVisited) d["lastVisited"] = at;
                if (!isVisited) d.Remove("storyId"); // story tags aren't something the map tells you
                if (sk.SystemObjects.TryGetValue(guid, out var live))
                {
                    // Level and faction are shown by the game for unvisited systems too, and both are
                    // live: a frontier system's level climbs with conquest progress (cap 64) and its owner
                    // can change with it.
                    d["level"] = Compat.Get<int>(live, "level", 0);
                    var fac = Compat.Get(live, "faction");
                    d["faction"] = FactionName(fac);
                    // Stable key for colour/icon lookup — the display name changes per playthrough.
                    d["factionId"] = FactionId(fac);
                    if (fac != null) factionsSeen.Add(fac);
                    d["unlocked"] = Compat.Get<bool>(live, "isUnlocked", true);
                    d["jumpgateOpen"] = Compat.Get<bool>(live, "jumpgateOpen", true);
                    Summarise(live, d, isVisited);
                    if (missionsBySystem.TryGetValue(guid, out var ms)) d["missions"] = ms;
                }
                systems.Add(d);
            }

            // Gate state is live: buying a pass opens one mid-session.
            var edges = new List<object>();
            foreach (var e in sk.Edges)
            {
                var from = (string)e["from"];
                var to = e["to"] as string;
                // Same sector scope: any system the game draws has its gates drawn too — the in-game map
                // shows red (locked) edges radiating from systems that were never visited.
                if (!shown.Contains(from)) continue;
                var d = new Dictionary<string, object>(e);
                if (to == null || !shown.Contains(to))
                {
                    // Route out of the visible galaxy. The gate is a POI in a system you've seen, so its
                    // existence is knowable — but the far end isn't sent, so the UI draws a stub. (The
                    // gate's own name is kept: it's written on the gate in-game.)
                    d["to"] = null;
                    d["leadsOut"] = true;
                }
                if (e.TryGetValue("_poi", out var poi))
                {
                    d.Remove("_poi");
                    // `usable` (canUseJumpGate) is the flag that matters: on an early save
                    // where two gates read open=true, usable=false (to Forlorn Graveyard and to Amber-9,
                    // the Motherlode). `jumpgateOpen` describes the gate structure and is ~always true, so
                    // a UI marking routes closed should key on `usable`, not `open`.
                    d["open"] = Compat.Get<bool>(poi, "jumpgateOpen", true);
                    d["usable"] = Compat.Get<bool>(poi, "canUseJumpGate", true);
                    var pass = Compat.Get<string>(poi, "linkedJumpgatePassGuid", null);
                    if (!string.IsNullOrEmpty(pass)) d["passGuid"] = pass;
                }
                edges.Add(d);
            }

            // POIs are fetched per system, not with the map: walking every visited system's POIs was ~95%
            // of the request cost, and a map only needs systems and gates. Always read live — POIs move,
            // and mission objectives are added and removed as you play.
            if (poisForSystem != null)
            {
                if (!visitedAt.ContainsKey(poisForSystem) || !shown.Contains(poisForSystem))
                    return Api.Result.Err(404, "system not visited (or not known)");
                var list = new List<object>();
                if (sk.SystemObjects.TryGetValue(poisForSystem, out var one))
                    // `allPointsOfInterest`, not the backing list: dynamic and mission POIs only appear here.
                    foreach (var p in Compat.Enumerate(Compat.Get(one, "allPointsOfInterest")))
                    {
                        if (p == null || Compat.Get<bool>(p, "hidden", false)) continue;
                        list.Add(PoiDto(p, poisForSystem));
                    }
                return Api.Result.Ok(new Dictionary<string, object> { ["system"] = poisForSystem, ["pois"] = list });
            }

            var anySystem = sk.SystemObjects.Values.FirstOrDefault();
            var recent = visitedAt.Where(kv => shown.Contains(kv.Key)).OrderByDescending(kv => kv.Value).Take(RecentCount)
                .Select(kv => (object)new Dictionary<string, object>
                {
                    ["guid"] = kv.Key,
                    ["name"] = sk.Systems.FirstOrDefault(x => (string)x["guid"] == kv.Key)?["name"],
                    ["lastVisited"] = kv.Value,
                }).ToList();

            var body = new Dictionary<string, object>
            {
                ["playthrough"] = pt,
                // GamePlayer exposes this directly; the static SystemMapData.current is the fallback.
                ["currentSystem"] = Compat.Get<string>(Compat.Get(player, "currentSystem"), "guid", null)
                    ?? Compat.Get<string>(StaticGet(anySystem?.GetType(), "current"), "guid", null),
                // Faction identity + the game's OWN colours, so the map shades territory the way the game does
                // rather than hashing a hue from the name.
                ["factions"] = FactionsDto(factionsSeen),
                // The game presents each quadrant as its OWN galaxy map, with a link across ("< Frontier" /
                // "Conquest >"). Derived from the data rather than hardcoded: only quadrants that actually
                // hold visible subsectors are listed, and an unrecognised id still comes through with a
                // usable label, so a third map would appear without a code change.
                ["quadrants"] = sk.Sectors
                    .Where(x => visitedSectors.Contains((string)x["guid"]))
                    .Select(x => (int)x["quadrant"]).Distinct().OrderBy(q => q)
                    .Select(q => Quadrant(q, QuadrantName(q), sk, visitedSectors)).ToList(),
                // Only sectors you've actually entered — the game hides the rest entirely. Level is read
                // live for the same reason as a system's.
                ["sectors"] = sk.Sectors.Where(x => visitedSectors.Contains((string)x["guid"]))
                    .Select(x =>
                    {
                        var d = new Dictionary<string, object>(x);
                        if (sk.SectorObjects.TryGetValue((string)x["guid"], out var live))
                        {
                            d["level"] = Compat.Get<int>(live, "level", 0);
                            // The game shows a RANGE per subsector ("Lv. 10-16"), held as a (min,max) tuple.
                            var range = Compat.Get(live, "sectorLevel");
                            var lo = Compat.Get<int>(range, "Item1", 0);
                            var hi = Compat.Get<int>(range, "Item2", 0);
                            if (hi > 0) d["levelRange"] = new[] { lo, hi };
                        }
                        return (object)d;
                    }).ToList(),
                ["systems"] = systems,
                ["edges"] = edges,
                ["recent"] = recent,          // most-recent-first: lets the client draw where you've been
                // TODAY, as the game itself counts it: `MissionBoard.umbralMissionDate` is `DateTime.Now.DayOfYear`
                // ∴ a client comparing against anything else (UTC, its own idea of a day) reads someone else's day.
                // The year is for DISPLAY only. Day-of-year WRAPS, and the game stores no year beside it — so a
                // stored 218 from last year is indistinguishable from today's, for US and for the GAME alike. That
                // ambiguity is therefore matched rather than papered over: reporting what the game will itself act
                // on is the only reading that cannot disagree with the board the player walks up to.
                ["umbralToday"] = DateTime.Now.DayOfYear,
                ["umbralYear"] = DateTime.Now.Year,
                ["counts"] = new Dictionary<string, object>
                {
                    ["systemsGenerated"] = sk.SystemCount, // grows: a region appears when you reach it
                    ["systemsShown"] = systems.Count,
                    ["systemsVisited"] = visitedAt.Count,
                    ["sectorsGenerated"] = sk.Sectors.Count,
                    ["sectorsVisited"] = visitedSectors.Count,
                    ["gatesOut"] = edges.Count(e => ((Dictionary<string, object>)e).ContainsKey("leadsOut")),
                },
                // Frontier levels rise with conquest progress and cap here, so a client can render
                // "how far has the war pushed" as level/levelCap without inventing the ceiling.
                ["levelCap"] = 64,
            };
            // The three refresh cycles, from their one owner (`Clock.CyclesDto`) — the same keys `/cycles`
            // serves alone, merged in here so the two payloads cannot drift apart.
            foreach (var cycle in Clock.CyclesDto()) body[cycle.Key] = cycle.Value;
            lock (Gate) { _dto = body; _dtoAt = now; _dtoPlaythrough = pt; }
            return Api.Result.Ok(body);
        });

        private static object Quadrant(int id, string name, Skeleton sk, HashSet<string> visible) => new Dictionary<string, object>
        {
            ["id"] = id,
            ["name"] = name,
            ["sectors"] = sk.Sectors
                .Where(s => (int)s["quadrant"] == id && visible.Contains((string)s["guid"]))
                .Select(s => s["guid"]).ToList(),
        };

        // Names for the quadrant ids the game defines today (SectorMapData.quadrantPrologue/Frontier/
        // Conquest). Anything new degrades to "Quadrant <n>" rather than being dropped.
        private static string QuadrantName(int id)
        {
            switch (id)
            {
                case 0: return "Prologue";
                case 1: return "Frontier";
                case 2: return "Conquest";
                default: return "Quadrant " + id;
            }
        }

        // ---- skeleton build (once per playthrough) ---------------------------------------------
        private static Skeleton BuildSkeleton(object map, string pt, int systemCount, int sectorCount)
        {
            var sk = new Skeleton { Playthrough = pt, SystemCount = systemCount, SectorCount = sectorCount };

            foreach (var sec in Compat.Enumerate(Compat.Get(map, "allSectors")))
            {
                var guid = Compat.Get<string>(sec, "guid", null);
                if (guid == null) continue;
                var pos = Vec(Compat.Get(sec, "mapPosition"));
                sk.SectorObjects[guid] = sec;
                sk.Sectors.Add(new Dictionary<string, object>
                {
                    ["guid"] = guid,
                    ["name"] = Compat.Get<string>(sec, "name", null),
                    ["quadrant"] = Compat.Get<int>(sec, "quadrant", 1),
                    ["conquest"] = Compat.Get<bool>(sec, "conquestSector", false),
                    ["x"] = pos.Item1,
                    ["y"] = pos.Item2,
                });
            }

            foreach (var sys in Compat.Enumerate(Compat.Get(map, "allSystems")))
            {
                var guid = Compat.Get<string>(sys, "guid", null);
                if (guid == null) continue;
                var pos = Vec(Compat.Get(sys, "position"));
                var sectorPos = Vec(Compat.Get(sys, "sectorPosition"));
                sk.SystemObjects[guid] = sys;
                sk.Systems.Add(new Dictionary<string, object>
                {
                    ["guid"] = guid,
                    ["name"] = Compat.Get<string>(sys, "name", null),
                    ["sector"] = Compat.Get<string>(Compat.Get(sys, "sector"), "guid", null),
                    ["storyId"] = Compat.Get<string>(sys, "storyId", null),
                    ["pocket"] = Compat.Get<bool>(sys, "pocketSystem", false),
                    ["x"] = pos.Item1,
                    ["y"] = pos.Item2,
                    ["sx"] = sectorPos.Item1,
                    ["sy"] = sectorPos.Item2,
                });

                // Gates are part of the static generation, so the edge list belongs in the skeleton —
                // only their open/pass state is re-read per call (see the volatile pass).
                foreach (var p in Compat.Enumerate(Compat.Get(sys, "pointsOfInterest")))
                {
                    if (p == null) continue;
                    var tn = p.GetType().Name;
                    if (tn.IndexOf("JumpGate", StringComparison.OrdinalIgnoreCase) < 0 && tn.IndexOf("GreatGate", StringComparison.OrdinalIgnoreCase) < 0) continue;
                    var target = Compat.Get<string>(p, "targetSystemGuid", null);
                    if (string.IsNullOrEmpty(target)) continue;
                    sk.Edges.Add(new Dictionary<string, object>
                    {
                        ["from"] = guid,
                        ["to"] = target,
                        ["gate"] = Compat.Get<string>(p, "guid", null),
                        ["name"] = Compat.Get<string>(p, "name", null),
                        ["kind"] = tn,
                        ["crossSector"] = Compat.Get<bool>(p, "sectorJumpgate", false),
                        ["_poi"] = p, // live object, stripped before serialization
                    });
                }
            }
            Plugin.Log.LogInfo($"[Hypercom] galaxy skeleton: {sk.Sectors.Count} sectors, {sk.Systems.Count} systems, {sk.Edges.Count} gates (playthrough {pt})");
            return sk;
        }

        // What the game's tooltip tells you about a system without visiting it: which KINDS of thing are
        // there (the map draws a badge per kind) and who owns the stations. Counts only - full detail is
        // ?pois=<guid> - so this stays cheap enough to run for every drawn system.
        private static void Summarise(object sys, Dictionary<string, object> d, bool isVisited)
        {
            var kinds = new Dictionary<string, object>();
            var stations = new List<object>();
            foreach (var p in Compat.Enumerate(Compat.Get(sys, "allPointsOfInterest")))
            {
                if (p == null || Compat.Get<bool>(p, "hidden", false)) continue;
                var kind = p.GetType().Name;
                kinds[kind] = (kinds.TryGetValue(kind, out var n) ? (int)n : 0) + 1;
                if (kind.IndexOf("Station", StringComparison.OrdinalIgnoreCase) < 0) continue;
                var st = new Dictionary<string, object>
                {
                    ["name"] = Compat.Get<string>(p, "name", null),
                    ["faction"] = FactionName(Compat.Get(p, "faction")),
                    // The stable key, same reason as a system's: the display name is per-playthrough, so colour
                    // and badge can only be looked up by identifier.
                    ["factionId"] = FactionId(Compat.Get(p, "faction")),
                    ["kind"] = kind,
                };
                if (isVisited)
                {
                    // Only meaningful once you've docked: shopRefreshTime is -1 until then.
                    st["shops"] = ShopFields.Where(f => Compat.Get(p, f) != null)
                        .Select(f => f.Replace("ShopInventory", "")).ToList();
                    st["refreshTime"] = AsFloat(Compat.Get(p, "shopRefreshTime"));
                    // static const on the type: an instance read silently yields 0
                    st["refreshInterval"] = AsFloat(StaticGet(p.GetType(), "ShopRefreshInterval"));
                    // Whether this station's stock last rolled in an earlier cycle than the current one, i.e. it
                    // rerolls the moment you dock.
                    st["due"] = Clock.ShopDue(p as SpaceStation);
                    // Two facilities on their own cycles, both readable without docking: the Personnel Center
                    // (7200s) and the mission board (300s). `missionsIn` reads <= 0 once the board has come due
                    // with nobody there to roll it, which is what `missionsFresh` states: it rerolls on arrival.
                    st["recruitsIn"] = Clock.OfficerRefreshIn(Compat.Get(p, "personnelCenter"));
                    var board = Compat.Get(p, "missionBoard");
                    st["missionsIn"] = Clock.MissionRefreshIn(board);
                    st["missionsFresh"] = Clock.MissionFresh(board);
                }
                // THE UMBRAL DAILY, as FACTS ⊥ as a verdict. The game keeps this itself, per station and in
                // the save: `MissionBoard.umbralMission` is the offer and `umbralMissionDate` the day-of-year it was
                // last rolled on, so what a player wants to know — "which station have I not used today" — is a READ
                // and needs no ledger of ours.
                //
                // ⚠ NEVER `GetUmbralMission(bool)`: it ROLLS one when the stored date is stale, so asking would make
                // this endpoint the author of what it reports. Fields only.
                //
                // Presence is a LEVEL, ⊥ a flag: the daily is offered from `Conquest.UmbralControlForMissions` (0.05)
                // while the umbral SHOP needs 0.5, which is why a station can offer the mission with no shop in
                // sight. Both consts are read off the build (they are `const` ∴ literal) with the observed value as
                // the fallback, because a balance number is exactly the kind of thing a patch moves.
                var umbral = Compat.Num(p, "umbralControlLevel");
                if (umbral > 0) st["umbralControl"] = umbral;
                st["umbralMissions"] = umbral >= UmbralControlForMissions;
                var mboard = Compat.Get(p, "missionBoard");
                if (mboard != null)
                {
                    // The DAY the daily was last rolled (`DateTime.Now.DayOfYear`) and whether one is sitting there
                    // now. What the pair MEANS is the client's to say — see the galaxy root's `umbralToday`.
                    var when = Compat.Num(mboard, "umbralMissionDate");
                    if (when > 0) st["umbralDailyDate"] = (int)when;
                    st["umbralDailyWaiting"] = Compat.Get(mboard, "umbralMission") != null;
                }
                stations.Add(st);
            }
            d["poiKinds"] = kinds;
            if (stations.Count > 0) d["stations"] = stations;

            // Materials held in this system's stations. The game shows exactly this per system
            // ("Materials stored: 1,764m3", then the first few item names), and a remote station's
            // storage is readable without docking - which is what makes a galaxy-wide view possible.
            var volume = 0f;
            var names = new List<string>();
            foreach (var poi in Compat.Enumerate(Compat.Get(sys, "allPointsOfInterest")))
            {
                var storage = poi == null ? null : Compat.Get(poi, "materialStorage");
                if (storage == null) continue;
                volume += AsFloat(Compat.Get(storage, "spaceUsed"));
                foreach (var slot in Materials.Slots(storage))
                {
                    var item = slot == null ? null : Compat.Get(slot, "item");   // slots include empties
                    if (item == null) continue;
                    var label = Stores.ItemLabel(item);
                    if (label == null) continue;
                    if (!names.Contains(label)) names.Add(label);
                }
            }
            if (volume > 0f || names.Count > 0)
                d["materials"] = new Dictionary<string, object>
                {
                    ["volume"] = volume,          // m3, as the tooltip shows it
                    ["distinct"] = names.Count,
                    ["items"] = names.Take(6).ToList(),
                };

            // Conquest systems carry a much richer state, held on the system's `storyteller`
            // (Source.Simulation.World.System.ConquestSystem).
            //
            // EVERY number here goes through Compat.Num, because most of them are declared `float` even when
            // they read like counts — `Get<int>` returned the fallback for those and produced numbers that
            // looked plausible and were wrong. Checked against the in-game tooltip for The Red Fall:
            //   combatStrength 77.21   -> "Fleet strength: 77"
            //   totalReinforcements 21 -> "Reinforcements: +21"   (baseReinforcements 1 + HQ 20)
            //   umbralControlLevel 1   -> "Umbral Reach control: 100%"   <- a FRACTION, 0..1
            var teller = Compat.Get(sys, "storyteller");
            if (teller != null && teller.GetType().Name.IndexOf("Conquest", StringComparison.OrdinalIgnoreCase) >= 0)
                d["conquest"] = new Dictionary<string, object>
                {
                    ["combatStrength"] = Compat.Num(teller, "combatStrength"),
                    ["controlLevel"] = Compat.Num(teller, "controlLevel"),
                    ["playerControlLevel"] = Compat.Num(teller, "playerControlLevel"),
                    // 0..1, NOT 0..100 — the game renders it as a percentage. Compare against
                    // /galaxy.conquest.umbralForShop (0.5) to know if the umbral shop is open here.
                    ["umbralControlLevel"] = Compat.Num(teller, "umbralControlLevel"),
                    ["baseReinforcements"] = Compat.Num(teller, "baseReinforcements"),
                    ["hqReinforcements"] = Compat.Num(teller, "HeadquartersReinforcements"),
                    ["totalReinforcements"] = Compat.Num(teller, "totalReinforcements"),
                    ["headquarters"] = Compat.Get<bool>(teller, "headquarters", false),
                    ["faction"] = FactionName(Compat.Get(teller, "faction")),
                    ["station"] = Compat.Get<string>(Compat.Get(teller, "station"), "guid", null),
                };
        }

        // ---- POI ------------------------------------------------------------------------------
        /// <summary>
        /// The umbral control a station needs before its mission board offers the DAILY, read off the build.
        ///
        /// `Source.Simulation.Story.Conquest.UmbralControlForMissions` is a `const` (0.05 on game 0.8.1.23) and
        /// `UmbralControlForShop` is 0.5 — a 10× gap, which is why "has an umbral shop" is the WRONG test for
        /// "offers the daily". Read rather than hardcoded because a balance number is what a patch moves; the
        /// observed value is the fallback so an unknown build degrades to today's behaviour instead of to zero.
        /// </summary>
        private static readonly float UmbralControlForMissions = ConquestConst("UmbralControlForMissions", 0.05f);

        private static float ConquestConst(string name, float fallback)
        {
            try
            {
                var t = VG.Game.GameMembers.FindType("Source.Simulation.Story.Conquest");
                var f = t?.GetField(name, System.Reflection.BindingFlags.Public | System.Reflection.BindingFlags.NonPublic
                                        | System.Reflection.BindingFlags.Static);
                if (f != null && f.IsLiteral)
                {
                    var raw = f.GetRawConstantValue();
                    if (raw is float ff) return ff;
                    if (raw is double dd) return (float)dd;
                }
            }
            catch (Exception ex) { Plugin.Log.LogWarning($"{name} unreadable, using {fallback}: {ex.Message}"); }
            return fallback;
        }

        private static readonly string[] ShopFields =
        {
            "generalShopInventory", "miningShopInventory", "salvageShopInventory", "bountyShopInventory",
            "patrolShopInventory", "industryShopInventory", "conquestShopInventory", "umbralShopInventory",
        };

        private static object PoiDto(object p, string systemGuid)
        {
            var pos = Vec(Compat.Get(p, "position"));
            var d = new Dictionary<string, object>
            {
                ["system"] = systemGuid,
                ["guid"] = Compat.Get<string>(p, "guid", null),
                ["name"] = Compat.Get<string>(p, "name", null),
                ["kind"] = p.GetType().Name,          // JumpGate | SpaceStation | Mining | Salvage | Combat | …
                ["typeName"] = Compat.Get<string>(p, "typeName", null), // localisation key
                ["faction"] = FactionName(Compat.Get(p, "faction")),
                ["level"] = Compat.Get<int>(p, "level", 0),
                ["x"] = pos.Item1,
                ["y"] = pos.Item2,
                ["dynamic"] = Compat.Get<bool>(p, "isDynamicPoi", false),
            };
            var lastVisit = AsFloat(Compat.Get(p, "lastVisitedTime"));
            if (lastVisit > 0f) d["lastVisited"] = lastVisit;

            // Stations: which facilities they actually have, and when their stock rolls over. The client
            // can then say "seen 40 minutes ago, refreshes in 20" instead of guessing.
            if (p.GetType().Name.IndexOf("Station", StringComparison.OrdinalIgnoreCase) >= 0)
            {
                var shops = ShopFields.Where(f => Compat.Get(p, f) != null)
                    .Select(f => f.Replace("ShopInventory", "")).ToList();
                d["station"] = new Dictionary<string, object>
                {
                    ["shops"] = shops,
                    ["size"] = Compat.Get(p, "stationSize")?.ToString(),
                    ["variant"] = Compat.Get(p, "stationVariant")?.ToString(),
                    // ShopRefreshInterval is STATIC (3600s) — read through the instance it came back 0.
                    ["refreshInterval"] = AsFloat(Compat.StaticGet(p.GetType(), "ShopRefreshInterval")),
                    ["refreshTime"] = AsFloat(Compat.Get(p, "shopRefreshTime")),      // -1 = never visited
                    ["refreshesIn"] = Clock.ShopRefreshIn(p as SpaceStation),         // seconds, null if unknowable
                    ["dryDock"] = Compat.Get(p, "dryDock") != null,
                    ["workshop"] = Compat.Get(p, "salvageWorkshop") != null,
                    ["canBeHome"] = Compat.Get<bool>(p, "canBeHomeStation", false),
                };
            }
            return d;
        }

        // ---- helpers --------------------------------------------------------------------------
        // `SystemMapData.current` and friends are static, so they are invisible through an instance.
        private static object StaticGet(Type t, string name) => Compat.StaticGet(t, name);

        // Factions come through as localisation keys ("@FactionNameBlue") — resolve to display text.
        internal static string FactionName(object faction)
        {
            var key = Compat.Get<string>(faction, "name", null);
            return key == null ? null : Stores.Text(key);
        }

        // Whether the game has a display name for this faction at all. `FactionName` falls back to the loc KEY
        // so a missing translation still yields something printable, which means it can never answer this —
        // and a faction with no name is one the game does not surface to the player.
        private static bool HasDisplayName(object faction)
        {
            var key = Compat.Get<string>(faction, "name", null);
            return key != null && Stores.Translate(key, null) != null;
        }

        // The faction's stable identifier ("Gold", "Red", "MiningGuild"). The DISPLAY name is per-playthrough
        // ("Mindus Holdings"), so it can't be a key for colours or icons — this can.
        private static string FactionId(object faction) => Compat.Get<string>(faction, "identifier", null);

        // A UnityEngine.Color as "#rrggbb". Read by component so no Color typeref is needed here.
        internal static string Hex(object color)
        {
            if (color == null) return null;
            var r = Compat.Num(color, "r");
            var g = Compat.Num(color, "g");
            var b = Compat.Num(color, "b");
            if (r == null || g == null || b == null) return null;
            int C(float v) => Math.Max(0, Math.Min(255, (int)Math.Round(v * 255f)));
            return $"#{C(r.Value):x2}{C(g.Value):x2}{C(b.Value):x2}";
        }

        // EVERY faction, with the colours the GAME uses — so the map can match the in-game territory shading
        // instead of inventing a hue per name. `conquestColor` is the one the conquest map paints territories
        // with; `color` is the faction's general colour and `relationColor` tracks standing, all three kept for
        // the client to choose from.
        //
        // The whole table, not just the owners of visible systems: a faction can own a STATION without owning
        // any system (Void Drifters, Umbral Reach), and a name with no entry here left the client hashing an
        // arbitrary hue for it. Faction identity is not fog-of-war — the game's own Reputation panel lists them
        // all — so there is nothing to withhold, and `factions` are passed in only as a fallback for a build
        // where the static table cannot be read.
        private static List<object> FactionsDto(IEnumerable<object> factions)
        {
            var seen = new Dictionary<string, object>();
            var table = Compat.StaticGet(Compat.FindType("Source.Galaxy.Faction"), "allFactions") as System.Collections.IDictionary;
            // A faction whose name does not translate ("@FactionNameHolyRadicals") is one the game never shows
            // the player, and this table IS drawn (the map legend names every entry). Owners of visible systems
            // are kept regardless: something on screen must never be left without a colour.
            var seenIds = new HashSet<string>(Compat.Enumerate(factions).Select(FactionId).Where(id => id != null));
            foreach (var f in Compat.Enumerate(table?.Values).Concat(factions))
            {
                var fid = FactionId(f);
                if (fid == "Player") continue;
                if (!HasDisplayName(f) && !seenIds.Contains(fid)) continue;
                var id = FactionId(f);
                if (id == null || seen.ContainsKey(id)) continue;
                seen[id] = new Dictionary<string, object>
                {
                    ["id"] = id,
                    ["name"] = FactionName(f),
                    ["conquestColor"] = Hex(Compat.Get(f, "conquestColor")),
                    ["color"] = Hex(Compat.Get(f, "color")),
                    ["relationColor"] = Hex(Compat.Get(f, "relationColor")),
                };
            }
            return seen.Values.ToList();
        }

        private static Tuple<float, float> Vec(object v)
        {
            if (v is UnityEngine.Vector2 v2) return Tuple.Create(v2.x, v2.y);
            if (v is UnityEngine.Vector3 v3) return Tuple.Create(v3.x, v3.y);
            return Tuple.Create(0f, 0f);
        }

        private static float AsFloat(object o)
        {
            if (o is float f) return f;
            if (o is double d) return (float)d;
            if (o is int i) return i;
            return 0f;
        }
    }
}
