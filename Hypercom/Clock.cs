using System.Collections.Generic;
using Source.Galaxy.POI;
using Source.Player;

namespace Hypercom
{
    // The game's play clock, and the countdowns measured against it: station shop restock and the conquest
    // tick.
    //
    // Everything here reads its game members by reflection. This runs from `/shops` and `/galaxy`, which are
    // served on every build, and the members are newer than the oldest supported one — a hard reference would
    // fail to JIT where they are absent and take the whole endpoint with it. The surface stays typed: callers
    // get `float?`, and an absent member is null.
    internal static class Clock
    {
        // Elapsed play time in seconds — the unit `SpaceStation.shopRefreshTime` and
        // `SystemMapData.GetLastVisitedTime()` are recorded in. Not wall time, and not `Time.time`, which
        // resets per session.
        internal static float? Now() => AsFloat(Compat.Get(GamePlayer.current, "elapsedTime"));

        // Shop stock rolls over on a GLOBAL boundary: every station's `shopRefreshTime` is an exact multiple
        // of `ShopRefreshInterval`, so the cycle is shared and only the phase within it matters. Seconds to
        // the next boundary, or null when the clock or the interval can't be read.
        internal static float? ShopRestockIn()
        {
            var now = Now();
            var interval = StationInterval();
            if (now == null || interval == null || interval <= 0f) return null;
            return interval.Value - (now.Value % interval.Value);
        }

        // Whether this station's stock is already stale — it last rolled in an earlier cycle than the current
        // one, so it rerolls as soon as you dock. Null when never visited (`shopRefreshTime` is -1 until then)
        // or the clock is unreadable.
        internal static bool? ShopDue(SpaceStation station)
        {
            if (station == null) return null;
            var last = AsFloat(Compat.Get(station, "shopRefreshTime"));
            var now = Now();
            var interval = StationInterval();
            if (last == null || last < 0f || now == null || interval == null || interval <= 0f) return null;
            var epochStart = System.Math.Floor(now.Value / interval.Value) * interval.Value;
            return last.Value < epochStart;
        }

        // The length of that shared cycle (3600s), so a client can show progress through it and not just the
        // remainder.
        internal static float? ShopRestockInterval() => StationInterval();

        private static float? StationInterval() =>
            AsFloat(Compat.StaticGet(typeof(SpaceStation), "ShopRefreshInterval"));

        // A mission board is NOT on a global boundary the way shops are. `MissionBoard.timer` starts full and is
        // advanced for EVERY board by the galaxy-wide ambient pass, but it only resets — and regenerates — where
        // `SpaceStation.current == owner`. So a board the player is away from runs past due and stays there until
        // they dock, and its countdown belongs to that board alone, not to the play clock.
        internal static float? MissionInterval() =>
            AsFloat(Compat.StaticGet(Compat.FindType("Source.Galaxy.POI.Station.MissionBoard"), "RefreshTime")) ?? 300f;

        // One board's own countdown to its next reroll, capped at the interval. Negative means it came due while
        // the player was elsewhere: nothing will roll it until they arrive, which is what `fresh` reports.
        internal static float? MissionRefreshIn(object board) => Compat.Num(board, "remainingTime");

        internal static bool? MissionFresh(object board)
        {
            var left = MissionRefreshIn(board);
            return left == null ? (bool?)null : left.Value <= 0f;
        }

        // The station whose board the player would fly back to: the one they are at, or the last one they were at.
        // `SpaceStation.current` stays set in-sector after undock, which is exactly the window where the board is
        // still counting down and worth watching.
        private static object CurrentOrLastStation() =>
            (object)SpaceStation.current ?? Compat.Get(GamePlayer.current, "lastStation");

        // That station's board as a cycle: a countdown while it is still running, `fresh` once it has come due.
        // Null before any station has been visited — there is no board to report on, and 0 would read as due.
        internal static Dictionary<string, object> MissionRestock()
        {
            var station = CurrentOrLastStation();
            if (station == null) return null;
            var board = Compat.Get(station, "missionBoard");
            var left = MissionRefreshIn(board);
            if (left == null) return null;
            return new Dictionary<string, object>
            {
                ["nextIn"] = left.Value < 0f ? 0f : left.Value,
                ["interval"] = MissionInterval(),
                ["station"] = Compat.Get(station, "name") as string,
                ["fresh"] = left.Value <= 0f,
            };
        }

        // Seconds until a station's Personnel Center rerolls its recruits. A DIFFERENT cycle from the shops:
        // `OfficerRefreshInterval` is 7200s against the shops' 3600. All three members are private, so this
        // returns null on a build that renames them.
        internal static float? OfficerRefreshIn(object personnelCenter)
        {
            if (personnelCenter == null) return null;
            var last = Compat.PrivateNum(personnelCenter, "officerRefreshTime");
            var interval = Compat.PrivateStaticNum(personnelCenter.GetType(), "OfficerRefreshInterval");
            var now = Now();
            if (last == null || last < 0f || interval == null || interval <= 0f || now == null) return null;
            var left = last.Value + interval.Value - now.Value;
            return left < 0f ? 0f : left;
        }

        // Seconds until this station rolls its stock over. Null rather than 0 when unknowable — the station
        // has never been visited (`shopRefreshTime` is -1 until then), there is no clock, or the members are
        // absent. 0 would read as "restocking right now".
        internal static float? ShopRefreshIn(SpaceStation station)
        {
            if (station == null) return null;
            var last = AsFloat(Compat.Get(station, "shopRefreshTime"));
            if (last == null || last < 0f) return null;
            // Static on SpaceStation: an instance read resolves to nothing.
            var interval = AsFloat(Compat.StaticGet(station.GetType(), "ShopRefreshInterval"));
            if (interval == null || interval <= 0f) return null;
            var now = Now();
            if (now == null) return null;
            var left = last.Value + interval.Value - now.Value;
            return left < 0f ? 0f : left;
        }

        // The global conquest story, or null where the save has none. It is one of several storytellers the
        // player carries (Default, Sandbox, Puppeteers, Economy, Conquest); matched by type name so neither
        // list order nor the type's presence is assumed.
        private static object ConquestStory()
        {
            foreach (var t in Compat.Enumerate(Compat.Get(GamePlayer.current, "storytellers")))
                if (t != null && t.GetType().Name == "Conquest") return t;
            return null;
        }

        internal static bool ConquestSupported() => ConquestStory() != null;

        // The three refresh cycles as ONE dictionary, so `/cycles` and `/galaxy` cannot report them differently.
        // They are the same three keys at the top level of both payloads: `/galaxy` merges this in beside the map,
        // `/cycles` returns it alone.
        //
        // `nextIn` paired with `interval` is what lets a client tick locally and re-ask only on rollover. Only the
        // first two are phases of the play clock; the mission board is one station's own timer. `conquest` is null
        // on a save with no conquest story — absent, not zero, so a client hides that cycle rather than showing it
        // as due, and `missionRestock` is null the same way before any station has been visited.
        internal static Dictionary<string, object> CyclesDto() => new Dictionary<string, object>
        {
            ["conquest"] = ConquestStatus(),
            // Shop stock rolls over on ONE galaxy-wide boundary ∴ the countdown is not per station; only the
            // phase differs there, which is what a station's own `due` carries.
            ["shopRestock"] = new Dictionary<string, object>
            {
                ["nextIn"] = ShopRestockIn(),
                ["interval"] = ShopRestockInterval(),
            },
            // Mission boards are per station, so this one names whose board it is. There is no galaxy-wide
            // mission cycle to report beside the two above.
            ["missionRestock"] = MissionRestock(),
        };

        // Conquest state, or null where there is no conquest story. `conquestTickTime` is already the
        // remaining seconds to the next tick — it counts down, so it needs no arithmetic against TickDelay.
        internal static Dictionary<string, object> ConquestStatus()
        {
            var c = ConquestStory();
            if (c == null) return null;
            var t = c.GetType();
            var d = new Dictionary<string, object>
            {
                ["tickIn"] = AsFloat(Compat.Get(c, "conquestTickTime")),
                ["tickDelay"] = AsFloat(Compat.StaticGet(t, "TickDelay")),   // 3600 — one tick per play hour
                ["umbralContribution"] = Compat.Get<int>(c, "umbralContribution", 0),
                // Thresholds the game gates on, as fractions of full control.
                ["umbralForShop"] = AsFloat(Compat.StaticGet(t, "UmbralControlForShop")),
                ["umbralForMissions"] = AsFloat(Compat.StaticGet(t, "UmbralControlForMissions")),
                // `MaxLevel` caps the PLAYER's level (it backs the maxPlayerLevel property), not a system's —
                // conquest systems reach 64.
                ["maxPlayerLevel"] = AsFloat(Compat.StaticGet(t, "MaxLevel")),
                ["reinforcementsMax"] = AsFloat(Compat.StaticGet(t, "ReinforcementsMax")),
            };
            var last = Compat.Get(c, "lastConquestTick");
            if (last is System.DateTime dt) d["lastTick"] = dt.ToString("o");
            return d;
        }

        // Boxed so JSON carries null for an absent member instead of 0.
        private static float? AsFloat(object o)
        {
            switch (o)
            {
                case float f: return f;
                case double d: return (float)d;
                case int i: return i;
                case long l: return l;
                default: return null;
            }
        }
    }
}
