using System;
using System.Collections.Generic;
using System.Linq;

namespace Hypercom
{
    /// <summary>
    /// What missions were taken, finished, failed and abandoned — the history the app cannot reconstruct.
    ///
    /// A `Mission` carries its name, category, difficulty, level, source faction and source POI while it is LIVE and
    /// is gone from `player.missions` the moment it is turned in. So "what did I do this session, and where did it
    /// come from" is answerable only by recording it as it happens, which is the same argument that put purchases in
    /// `Ledger` rather than in the browser: a mission completes with the web UI closed.
    ///
    /// DETECTION IS A POLL, ⊥ a Harmony patch, and that is a deliberate trade. `Mission` exposes `OnMissionStart`,
    /// `ClaimRewards` and `MissionFailed` as METHODS, so patching them would be exact — and would also put our code
    /// inside the game's own mission flow, where a signature change breaks the patch and an exception escapes into a
    /// path that has already changed the player's state. A poll only READS: it diffs the active list, and a mission
    /// that has left is classified by the last state we saw it in (`isComplete` → completed, `failed` → failed,
    /// neither → abandoned). That last classification is a best-effort and is recorded as one.
    ///
    /// The poll runs on the main thread from `Plugin.Update`, so it is bounded on purpose: every
    /// <see cref="PollSeconds"/> seconds, over a list that holds a handful of entries. is what an unbounded
    /// per-frame job costs.
    /// </summary>
    internal static class MissionLog
    {
        private const int MaxEntries = 4000;
        /// <summary>A mission is not a per-frame event; this is often enough to catch one and cheap enough to ignore.</summary>
        private const float PollSeconds = 2f;

        private static readonly JsonlStore Store = new JsonlStore("hypercom-missions.jsonl", MaxEntries);

        /// <summary>The last state each live mission was seen in, so a DISAPPEARANCE can be classified.</summary>
        private static Dictionary<string, Dictionary<string, object>> _live;
        private static float _next;

        /// <summary>Call once per frame from the main thread. Cheap: it returns immediately between polls.</summary>
        internal static void Poll()
        {
            try
            {
                var now = UnityEngine.Time.realtimeSinceStartup;
                if (now < _next) return;
                _next = now + PollSeconds;

                var player = Source.Player.GamePlayer.current;
                if (player == null) return;
                var seen = new Dictionary<string, Dictionary<string, object>>();
                foreach (var m in Compat.Enumerate(Compat.Get(player, "missions")))
                {
                    if (m == null) continue;
                    var row = Describe(m);
                    var key = Key(row);
                    if (key != null) seen[key] = row;
                }

                // The FIRST poll of a session establishes what is already live; recording those as "accepted" would
                // invent a history that did not happen here (and would do it again on every game start).
                if (_live == null) { _live = seen; return; }

                foreach (var kv in seen)
                    if (!_live.ContainsKey(kv.Key)) Write("accepted", kv.Value);
                foreach (var kv in _live)
                    if (!seen.ContainsKey(kv.Key)) Write(Ended(kv.Value), kv.Value);
                _live = seen;
            }
            catch (Exception ex)
            {
                // A watcher that throws must not take the frame with it, and it must not spin: the next poll is
                // already scheduled, so one bad read costs one interval.
                Plugin.Log.LogWarning($"mission log poll failed: {ex.Message}");
            }
        }

        /// <summary>
        /// How a mission that LEFT the list ended, from the last state we saw.
        ///
        /// `isComplete` and `failed` are the game's own flags; a mission gone with neither set was given up on. This
        /// is the one inference in the file, and the row carries it as `event` so a reader can see what was guessed:
        /// a poll cannot witness the moment itself, only the state either side of it.
        /// </summary>
        private static string Ended(Dictionary<string, object> last)
            => Truthy(last, "complete") ? "completed" : Truthy(last, "failed") ? "failed" : "abandoned";

        private static bool Truthy(Dictionary<string, object> d, string k)
            => d.TryGetValue(k, out var v) && v is bool b && b;

        /// <summary>
        /// A mission's identity across polls. `storyId` where the game has one (a story mission is one thing in the
        /// world), else the name plus where it came from — two escort jobs from different stations are two jobs, and
        /// keying on the name alone would make the second one invisible.
        /// </summary>
        private static string Key(Dictionary<string, object> row)
        {
            var story = row.TryGetValue("storyId", out var s) ? s as string : null;
            if (!string.IsNullOrEmpty(story)) return "story:" + story;
            var name = row.TryGetValue("name", out var n) ? n as string : null;
            if (string.IsNullOrEmpty(name)) return null;
            var from = row.TryGetValue("from", out var f) ? f as string : null;
            return name + "@" + (from ?? "?");
        }

        /// <summary>Fields whose read has already failed once, so the warning is said once and not every 2 seconds.</summary>
        private static readonly HashSet<string> Warned = new HashSet<string>();

        /// <summary>
        /// One field, guarded on its own.
        ///
        /// A game PROPERTY is a method: `Mission.isComplete` computes from the mission's steps, and on a mission whose
        /// step state is not what the getter assumes it throws (`Nullable object must have a value` — seen
        /// every 2s on a live save). Guarding the whole row meant one such property cost the entire poll, which is
        /// how a watcher that reads nine fields recorded nothing at all. Now a bad field costs THAT field, once, and
        /// says which one it was so the next build can stop reading it.
        /// </summary>
        private static T Field<T>(string name, Func<T> read, T fallback = default)
        {
            try { return read(); }
            catch (Exception ex)
            {
                // DEBUG, ⊥ a warning: which of nine fields a game property refused to compute is a developer's
                // business, and a player's log is for what went wrong. Nothing IS wrong — the row is written
                // without it. (Observed: `Mission.level` throws on a mission with no level to derive.)
                if (Warned.Add(name)) Plugin.Log.LogDebug($"mission log: `{name}` unreadable ({ex.GetType().Name}) — omitted from the row");
                return fallback;
            }
        }

        private static Dictionary<string, object> Describe(object m)
        {
            var faction = Field("sourceFaction", () => Compat.Get(m, "sourceFaction"));
            var row = new Dictionary<string, object>
            {
                ["name"] = Field("name", () => Compat.Get(m, "name") as string),
                // Null on nearly every mission and that is CORRECT, ⊥ a failed read: only `IndustryMission` sets
                // `category` (and sets it to an already-translated string). Recorded because when it IS there it
                // is the industrial op's own grouping, and a reader who saw it missing would otherwise chase it.
                ["category"] = Field("category", () => Compat.Get(m, "category") as string),
                ["storyId"] = Field("storyId", () => Compat.Get(m, "storyId") as string),
                // `sourceName` is a localisation KEY on a board mission (`@FactionNameGold`) ∴ it goes through the
                // game's own translator, which strips the `@` and looks it up. Printing it raw put a key where a
                // reader expects a name — the exact trap `Hypercom/the internal notes` V56 names for item display text.
                ["from"] = Field("sourceName", () => VG.Game.ItemNames.Text(Compat.Get(m, "sourceName") as string)),
                ["faction"] = Field("faction", () => Compat.Get(faction, "identifier") as string
                                                    ?? Compat.Get(faction, "displayName") as string),
                ["level"] = Field("level", () => (int)Compat.Num(m, "level")),
                ["difficulty"] = Field("difficulty", () => Compat.Get(m, "difficulty")?.ToString()),
                // WHAT IT PAID, which is most of a ledger's value. Every `MissionReward` subclass carries an
                // `amount` and a formatted `rewardText`, so a row records the TYPE, the number and the game's own
                // sentence — that shape survives a build adding a reward kind we have never seen, where reading
                // named fields per subclass would not.
                ["rewards"] = Field("rewards", () => Rewards(m), new List<object>()),
                // The two that decide `completed` vs `abandoned`. Both are computed properties ∴ both are guarded,
                // and a mission whose flags cannot be read leaves as `abandoned` — the reading that claims least.
                ["complete"] = Field("isComplete", () => Compat.Get(m, "isComplete") as bool? ?? false, false),
                ["failed"] = Field("failed", () => Compat.Get(m, "failed") as bool? ?? false, false),
            };
            return row;
        }

        /// <summary>
        /// One row per reward the mission carries. `hidden` rewards are recorded too and marked: the game keeps
        /// them off the board on purpose, but a ledger that silently dropped them would under-report what a job
        /// actually paid.
        /// </summary>
        private static List<object> Rewards(object m)
        {
            var out_ = new List<object>();
            foreach (var r in Compat.Enumerate(Compat.Get(m, "rewards")))
            {
                if (r == null) continue;
                var row = new Dictionary<string, object>
                {
                    ["kind"] = r.GetType().Name,
                    ["text"] = Field("rewardText", () => Compat.Get(r, "rewardText") as string),
                };
                // `amount` is on every subclass but is not on the abstract base ∴ read by name, and absent means
                // a reward whose worth is not a number (coordinates, a follow-up mission) rather than zero.
                var amount = Compat.Num(r, "amount");
                if (amount != 0) row["amount"] = amount;
                if (Compat.Get(r, "hidden") is bool h && h) row["hidden"] = true;
                out_.Add(row);
            }
            return out_;
        }

        private static void Write(string ev, Dictionary<string, object> row)
        {
            var entry = new Dictionary<string, object>(row)
            {
                ["at"] = DateTime.UtcNow.ToString("o"),
                ["event"] = ev,
                ["station"] = SafeStation(),
                ["playthrough"] = Api.CurrentPlaythrough(),
            };
            // The live flags describe the row's LAST seen state, which `event` now states outright — keeping both
            // invites a reader to trust the flags over the verdict.
            entry.Remove("complete");
            entry.Remove("failed");
            Store.Append(entry);
            var what = row.TryGetValue("name", out var n) ? n?.ToString() : null;
            Plugin.Log.LogInfo($"mission {ev}: {what ?? "?"}");
        }

        private static string SafeStation()
        {
            try { return Source.Galaxy.POI.SpaceStation.current?.name; } catch { return null; }
        }

        /// <summary>Newest first, optionally only what happened after `since` (an ISO timestamp) and per playthrough.</summary>
        internal static Dictionary<string, object> Dto(string since, string playthrough, int limit)
        {
            var rows = Store.Rows().AsEnumerable();
            if (!string.IsNullOrEmpty(playthrough))
                rows = rows.Where(e => string.Equals(e.TryGetValue("playthrough", out var p) ? p?.ToString() : null,
                                                     playthrough, StringComparison.Ordinal));
            if (!string.IsNullOrEmpty(since))
                // String comparison is correct for round-trip ISO ("o"): it sorts as it reads, and a malformed
                // `since` then filters nothing rather than everything.
                rows = rows.Where(e => string.CompareOrdinal(e.TryGetValue("at", out var a) ? a?.ToString() ?? "" : "", since) > 0);
            var all = rows.ToList();
            var take = limit > 0 ? Math.Min(limit, all.Count) : all.Count;
            var recent = new List<object>(take);
            for (var i = all.Count - 1; i >= all.Count - take; i--) recent.Add(all[i]);
            return new Dictionary<string, object>
            {
                ["playthrough"] = playthrough,
                ["count"] = all.Count,
                ["entries"] = recent,
            };
        }

        /// <summary>Drop one playthrough's rows, or every row when none is named — the ledger's own semantics.</summary>
        internal static int Clear(string playthrough)
            => Store.Keep(e => !string.IsNullOrEmpty(playthrough)
                && !string.Equals(e.TryGetValue("playthrough", out var p) ? p?.ToString() : null,
                                  playthrough, StringComparison.Ordinal));
    }
}
