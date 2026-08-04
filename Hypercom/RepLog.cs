using System;
using System.Collections;
using System.Collections.Generic;
using Source.Player;
using UnityEngine;

namespace Hypercom
{
    // A history of standing CHANGES, one stream per ladder: faction reputation and conquest contribution.
    //
    // The game shows only the current value on each panel, and its notification toasts scroll away, so there is
    // no way to answer "what did that mission cost me with the Vultures" or "when did I last gain conquest
    // ground". This watches both numbers and records every move.
    //
    // Sampled rather than hooked. `Faction.ChangePlayerReputation(int)` exists and could be patched, but it
    // carries no reason argument, so a patch would add nothing a sample can't see — and it would MISS the paths
    // that write the value another way (`SetReputation`, a conquest tick recomputing standings, a save load).
    // Conquest contribution has no mutator at all: `playerContribution` is a plain field the story writes
    // directly. One sampler covers both, and cannot be bypassed.
    //
    // The cost is that a change is timestamped when it is NOTICED, up to `Period` late, and that two changes
    // inside one period collapse into one entry. Both are acceptable for a log read by a human.
    internal static class RepLog
    {
        private const float Period = 3f;
        private const int Max = 400;

        private static readonly object Gate = new object();
        private static readonly LinkedList<Dictionary<string, object>> Entries = new LinkedList<Dictionary<string, object>>();

        // Last seen value per faction, per ladder. Absent = not yet baselined, which is NOT a change: a fresh
        // baseline (bridge start, save load, playthrough switch) must not log 11 phantom gains.
        private static readonly Dictionary<string, int> LastRep = new Dictionary<string, int>();
        private static readonly Dictionary<string, int> LastContribution = new Dictionary<string, int>();
        private static string _playthrough;
        private static float _nextSample;
        private static long _seq;
        // Sampler health, reported with the log. An empty log is ambiguous on its own — nothing changed, or
        // nothing is being watched — and that ambiguity cost a "is the log even working?" round trip.
        private static int _samples;
        // Wall clock, not `Time.realtimeSinceStartup`: the log endpoint is served straight off the socket
        // thread (it touches no game state) and any UnityEngine read there throws.
        private static DateTime? _lastSampleAt;
        private static string _lastError;

        // Called every frame from the game's Update; self-throttled to `Period`. Nothing may escape from here
        // into game code, and a sampler that starts failing must not take the bridge with it: the throttle is
        // set before the work, so a throwing build costs one log line per period at worst.
        internal static void Poll()
        {
            try { Sample(); }
            catch (Exception e)
            {
                _lastError = e.Message;
                Plugin.Log?.LogWarning($"standing sampler: {e.Message}");
            }
        }

        private static void Sample()
        {
            var now = Time.realtimeSinceStartup;
            if (now < _nextSample) return;
            _nextSample = now + Period;

            var player = GamePlayer.current;
            if (player == null) return;

            // A different save is a different history. Clearing the baselines (and the log) is what keeps one
            // playthrough's numbers from being diffed against another's.
            var pt = VG.Loadout.LoadoutStore.PlaythroughKey(player);
            if (pt != _playthrough)
            {
                _playthrough = pt;
                LastRep.Clear();
                LastContribution.Clear();
                lock (Gate) Entries.Clear();
            }

            var where = Compat.Get<string>(Compat.Get(player, "currentSystem"), "name", null);
            SampleReputation(where);
            SampleConquest(where);
            _samples++;
            _lastSampleAt = DateTime.Now;
        }

        private static void SampleReputation(string where)
        {
            var factions = Reputation.AllFactions(out var playerFaction);
            if (playerFaction == null) return;

            foreach (var f in factions)
            {
                var id = Compat.Get<string>(f, "identifier", null);
                if (id == null) continue;
                // Standing is stored as a PAIR, so it is symmetric: asking the faction about the player is the
                // same reading the Reputation panel shows.
                var rep = Compat.AsNumber(Compat.Call(f, "GetReputation", playerFaction));
                if (rep == null) continue;
                var value = (int)rep.Value;
                if (LastRep.TryGetValue(id, out var was))
                {
                    if (was != value)
                        Add("faction", f, id, value - was, value, where,
                            Reputation.LevelName(was), Reputation.LevelName(value));
                }
                LastRep[id] = value;
            }
        }

        private static void SampleConquest(string where)
        {
            var conquest = Reputation.ConquestStory();
            if (!(Compat.PrivateGet(conquest, "factionStanding") is IDictionary standings)) return;

            foreach (DictionaryEntry e in standings)
            {
                var id = Compat.Get<string>(e.Key, "identifier", null);
                if (id == null) continue;
                var c = Compat.Num(e.Value, "playerContribution");
                if (c == null) continue;
                var value = (int)c.Value;
                if (LastContribution.TryGetValue(id, out var was))
                {
                    if (was != value)
                        Add("conquest", e.Key, id, value - was, value, where,
                            Reputation.RankTitle(e.Key, was), Reputation.RankTitle(e.Key, value));
                }
                LastContribution[id] = value;
            }
        }

        // `tierWas`/`tier` are the named band the value sat in before and after — the same delta matters much
        // more when it crosses one, and only the log can show that it did.
        private static void Add(string ladder, object faction, string id, int delta, int value, string where,
            string tierWas, string tier)
        {
            var entry = new Dictionary<string, object>
            {
                ["seq"] = ++_seq,
                ["t"] = DateTime.Now.ToString("HH:mm:ss"),
                ["ladder"] = ladder,
                ["factionId"] = id,
                ["faction"] = Galaxy.FactionName(faction),
                ["delta"] = delta,
                ["value"] = value,
                ["tierWas"] = tierWas,
                ["tier"] = tier,
                ["at"] = where,
            };
            lock (Gate)
            {
                Entries.AddLast(entry);
                while (Entries.Count > Max)
                    Entries.RemoveFirst();
            }
            EventBus.Emit("standing", new Dictionary<string, object>(entry));
        }

        // Newest last, so a client appending to its own history keeps chronological order. `since` returns only
        // what a caller hasn't seen, which is what makes polling cheap; 0 returns everything held.
        internal static Api.Result Dto(long since)
        {
            var list = new List<object>();
            lock (Gate)
                foreach (var e in Entries)
                    if (Convert.ToInt64(e["seq"]) > since)
                        list.Add(e);
            return Api.Result.Ok(new Dictionary<string, object>
            {
                ["entries"] = list,
                ["seq"] = _seq,
                // How far back the buffer reaches. A client that fell further behind than this has a gap, and
                // knowing the cap is how it can tell.
                ["capacity"] = Max,
                ["playthrough"] = _playthrough,
                // Proof of life: how many samples have run, how long ago the last one was, how many factions
                // each ladder is actually watching, and the last error if one ever fired. `watchingFactions` at
                // 0 means the log CANNOT record anything, which reads nothing like "nothing has happened".
                ["sampler"] = new Dictionary<string, object>
                {
                    ["samples"] = _samples,
                    ["periodSeconds"] = Period,
                    ["lastSampleAgo"] = _lastSampleAt == null
                        ? (float?)null
                        : (float)(DateTime.Now - _lastSampleAt.Value).TotalSeconds,
                    ["watchingFactions"] = LastRep.Count,
                    ["watchingConquest"] = LastContribution.Count,
                    ["lastError"] = _lastError,
                },
            });
        }
    }
}
