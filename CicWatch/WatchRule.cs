using System;
using System.Collections.Generic;
using System.Text;

// Game-free rule matching for the CIC plot. The game-bound side (Watch) stays the adapter: it builds a
// ContactFacts POCO from the live unit and asks here. Pure + POCO ∴ it compiles into the headless test
// project and the near-miss and ordering edge cases are unit-tested (the KeepMatch pattern).
namespace CicWatch
{
    /// <summary>
    /// One rule as plain data: every criterion that is SET must hold, and an unset criterion means "any".
    /// A list of these is OR'd — see <see cref="WatchMatch"/> — so a rule can only ever ADD what is called.
    /// </summary>
    internal struct WatchCriteria
    {
        /// <summary>Index into <see cref="SizeNames"/>, and a MINIMUM. -1 = any.</summary>
        // ORDINAL, unlike KeepCriteria's size. For an ITEM a Large module is not a better Small one, it fits a
        // different slot; for a HULL, bigger is bigger and "S6 and up" is the thing a player wants to say. The two
        // structs disagree on purpose and each says why.
        public int MinSize;
        /// <summary>Index into <see cref="SizeNames"/>, and a MAXIMUM. -1 = no ceiling.</summary>
        // A size RANGE, not just a floor, because the thing being said is often bounded: "S6 to S8 at A, and I do
        // not care about anything smaller". Without a ceiling a rule for one size silently covers every size above
        // it, which cannot express a per-size table at all.
        public int MaxSize;
        /// <summary>Worst rarity worth calling, as (int)Rarity. -1 = any.</summary>
        public int MinRarity;
        /// <summary>Level floor RELATIVE to the player, per V31's surviving half. Unset = any level.</summary>
        public bool HasLevel;
        public int MinLevelDelta;
        /// <summary>0 = any, 1 = hostile only, 2 = friendly only.</summary>
        public int Hostility;
        /// <summary>0 = any, 1 = only a hull that can be taken RIGHT NOW.</summary>
        public int Boardable;

        internal const int AnyHostility = 0, HostileOnly = 1, FriendlyOnly = 2;
        internal const int AnyBoardable = 0, BoardableNow = 1;

        /// <summary>
        /// A rule with every criterion unset — the ONLY correct way to start one.
        ///
        /// `default(WatchCriteria)` is NOT that rule and never will be: the rank fields carry -1 for "any" while a
        /// struct zeroes them, so a rule built without this reads as "size exactly S1, quality exactly Standard"
        /// and matches almost nothing. Zero is a legal index here, so it cannot double as the absent value.
        /// </summary>
        internal static WatchCriteria None()
        {
            return new WatchCriteria { MinSize = -1, MaxSize = -1, MinRarity = -1 };
        }

        /// <summary>A rule with nothing set calls EVERYTHING. Worth naming so the editor can warn rather than surprise.</summary>
        internal bool IsEmpty
        {
            get
            {
                return MinSize < 0 && MaxSize < 0 && MinRarity < 0 && !HasLevel
                       && Hostility == AnyHostility && Boardable == AnyBoardable;
            }
        }
    }

    /// <summary>What the plot knows about one contact. Ranks are -1 where the game gave nothing.</summary>
    internal struct ContactFacts
    {
        public int SizeRank;      // index into SizeNames, -1 when the size is unknown
        public int RarityRank;    // (int)Rarity, -1 when absent
        public int Level;
        public int PlayerLevel;
        public bool Hostile;
        public bool Boardable;
    }

    /// <summary>Which criterion of a rule a contact failed, for a panel that has to say what would have to change.</summary>
    internal struct WatchMiss
    {
        public int Held;          // criteria this contact satisfied
        public string Failed;     // the first criterion it did not, or null when the rule matched
        public string Detail;     // what it would take, in the player's terms
    }

    internal static class WatchMatch
    {
        // The size names are the game enum's OWN members, so a value in a config file matches what the game calls
        // the hull. `S6` is display text and is deliberately not accepted here: two spellings of one size would be
        // two things to keep in step.
        //
        // `Drone` is NOT among them: there is no useful answer to "which drones do I want called", so drones carry
        // no size rank and can only be reached by a rule that names no size.
        //
        // HERE rather than on `Config` because the matcher is the thing that has to be game-free: a constant on the
        // BepInEx-bound class would drag the whole plugin into the test project. `Config` reads them from here.
        // Rule indices are stored against this order, so it is config identity as well as display order. One copy,
        // in `VG.Core.ShipSizes`, because the tint ramp indexes the same list. ⚠ IT MUST BE THE GAME-FREE OWNER:
        // this file is linked into `tests/Hypercom.Tests`, so reaching for `VG.Game.ShipLook` here fails that
        // build even though both mods compile.
        internal static readonly string[] SizeNames = VG.Core.ShipSizes.SizeNames;

        /// <summary>How far either side of our own level a rule's floor may sit. Wide enough to be a real range.</summary>
        internal const int LevelReach = 60;

        /// <summary>
        /// `S6`, or `Drone`. The enum name is the storage; this is what a reader sees.
        ///
        /// ⚠ DELIBERATELY ⊥ <see cref="VG.Core.ShipSizes.Label"/> AND NOT YET MERGED WITH IT: this one answers
        /// `"?"` for an empty name where that one answers null, and the panel DRAWS that `"?"` (see the rank
        /// fallback below). Collapsing them would change what a shipping readout prints, which is not a release-day
        /// edit. The size ORDER and the tint are already shared; only this one string differs.
        /// </summary>
        internal static string SizeLabel(string sizeName)
        {
            return string.IsNullOrEmpty(sizeName) ? "?"
                 : sizeName == "Drone" ? "Drone"
                 : sizeName.Length > 4 ? "S" + sizeName.Substring(4)
                 : sizeName;
        }

        /// <summary>Does this contact satisfy every criterion this rule sets?</summary>
        internal static bool Matches(WatchCriteria c, ContactFacts f)
        {
            return Judge(c, f).Failed == null;
        }

        /// <summary>
        /// Is this contact called at all? DEFAULT SILENCE: an empty list calls nothing, and each rule can
        /// only ever add. There is no precedence to get wrong because no rule can subtract what another matched.
        /// </summary>
        internal static bool Any(IList<WatchCriteria> rules, ContactFacts f)
        {
            if (rules == null) return false;
            for (var i = 0; i < rules.Count; i++) if (Matches(rules[i], f)) return true;
            return false;
        }

        /// <summary>
        /// How close this rule came, and on which criterion it failed FIRST.
        ///
        /// Under a disjunction no single gate dropped a contact ∴ "what dropped them" has no answer and the only
        /// useful thing the panel can say is what would have to change. Criteria are judged in a fixed order so the
        /// answer is stable between frames rather than following whatever the struct happens to enumerate.
        /// </summary>
        internal static WatchMiss Judge(WatchCriteria c, ContactFacts f)
        {
            var m = new WatchMiss();

            if (c.Hostility != WatchCriteria.AnyHostility)
            {
                var want = c.Hostility == WatchCriteria.HostileOnly;
                if (f.Hostile != want)
                    return Fail(m, "hostility", want ? "a hostile hull" : "a friendly hull");
                m.Held++;
            }

            if (c.Boardable != WatchCriteria.AnyBoardable)
            {
                if (!f.Boardable) return Fail(m, "boardable", "a hull that can be taken right now");
                m.Held++;
            }

            if (c.MinSize >= 0 || c.MaxSize >= 0)
            {
                // An unknown size cannot satisfy a size criterion. Treating it as 0 would let anything the game
                // failed to describe through the one criterion most likely to be the point of the rule.
                if (f.SizeRank < 0) return Fail(m, "size", "a hull whose size the game reports");
                if (c.MinSize >= 0 && f.SizeRank < c.MinSize)
                    return Fail(m, "size", SizeSpan(c) + ", so bigger than this");
                if (c.MaxSize >= 0 && f.SizeRank > c.MaxSize)
                    return Fail(m, "size", SizeSpan(c) + ", so smaller than this");
                m.Held++;
            }

            if (c.MinRarity >= 0)
            {
                if (f.RarityRank < 0) return Fail(m, "rarity", "a hull whose quality the game reports");
                if (f.RarityRank < c.MinRarity)
                    return Fail(m, "rarity", VG.Core.Rarity.RefitCode(VG.Core.Rarity.Order[c.MinRarity]) + " or better");
                m.Held++;
            }

            if (c.HasLevel)
            {
                var floor = f.PlayerLevel + c.MinLevelDelta;
                if (f.Level < floor)
                    return Fail(m, "level", "level " + floor + " or above (short by " + (floor - f.Level) + ")");
                m.Held++;
            }

            return m;
        }

        private static WatchMiss Fail(WatchMiss m, string what, string detail)
        {
            m.Failed = what;
            m.Detail = detail;
            return m;
        }

        private static string Size(int rank)
        {
            return rank >= 0 && rank < SizeNames.Length ? SizeLabel(SizeNames[rank]) : "?";
        }

        /// <summary>`S6`, `S6+`, `up to S4`, `S3-S5` — the span said the way a reader would say it.</summary>
        internal static string SizeSpan(WatchCriteria c)
        {
            if (c.MinSize < 0 && c.MaxSize < 0) return "any size";
            if (c.MinSize < 0) return "up to " + Size(c.MaxSize);
            if (c.MaxSize < 0) return Size(c.MinSize) + "+";
            return c.MinSize == c.MaxSize ? Size(c.MinSize) : Size(c.MinSize) + "-" + Size(c.MaxSize);
        }

        // ------------------------------------------------------------------------------------------------
        // PERSISTENCE. Flat text, because BepInEx config is flat text: one rule per `;`, one criterion per `,`.
        // Written to be readable and hand-editable in the .cfg, since that is the only place a player can see the
        // whole list at once outside the game.
        // ------------------------------------------------------------------------------------------------

        internal static string Serialize(IList<WatchCriteria> rules)
        {
            var sb = new StringBuilder();
            for (var i = 0; i < (rules == null ? 0 : rules.Count); i++)
            {
                if (sb.Length > 0) sb.Append(';');
                sb.Append(One(rules[i]));
            }
            return sb.ToString();
        }

        private static string One(WatchCriteria c)
        {
            var parts = new List<string>();
            if (c.Hostility == WatchCriteria.HostileOnly) parts.Add("hostile");
            if (c.Hostility == WatchCriteria.FriendlyOnly) parts.Add("friendly");
            if (c.Boardable == WatchCriteria.BoardableNow) parts.Add("boardable");
            if (c.MinSize >= 0) parts.Add("size>=" + SizeNames[c.MinSize]);
            if (c.MaxSize >= 0) parts.Add("size<=" + SizeNames[c.MaxSize]);
            if (c.MinRarity >= 0) parts.Add("rarity>=" + VG.Core.Rarity.Order[c.MinRarity]);
            if (c.HasLevel) parts.Add("level>=" + (c.MinLevelDelta > 0 ? "+" : "") + c.MinLevelDelta);
            // A rule with no criteria still has to round-trip, or saving an empty row silently drops it and the
            // editor and the file disagree about how many rules there are.
            return parts.Count == 0 ? "any" : string.Join(",", parts.ToArray());
        }

        /// <summary>
        /// Read the list back. An unreadable CRITERION drops its whole rule rather than widening it: a typo must
        /// never call MORE than the player asked for, which is the same rule the old per-size table followed.
        /// </summary>
        internal static List<WatchCriteria> Deserialize(string raw, Action<string> warn)
        {
            var outp = new List<WatchCriteria>();
            foreach (var chunk in (raw ?? "").Split(';'))
            {
                var line = chunk.Trim();
                if (line.Length == 0) continue;

                var c = WatchCriteria.None();
                var ok = true;
                foreach (var rawTerm in line.Split(','))
                {
                    var term = rawTerm.Trim();
                    if (term.Length == 0) continue;
                    if (term.Equals("any", StringComparison.OrdinalIgnoreCase)) continue;
                    if (term.Equals("hostile", StringComparison.OrdinalIgnoreCase)) { c.Hostility = WatchCriteria.HostileOnly; continue; }
                    if (term.Equals("friendly", StringComparison.OrdinalIgnoreCase)) { c.Hostility = WatchCriteria.FriendlyOnly; continue; }
                    if (term.Equals("boardable", StringComparison.OrdinalIgnoreCase)) { c.Boardable = WatchCriteria.BoardableNow; continue; }

                    // `<=` is accepted for SIZE alone: every other criterion is a floor, and a ceiling on quality
                    // or rank would be a way of saying "and nothing better than this", which nobody has asked for.
                    var upper = false;
                    var at = term.IndexOf(">=", StringComparison.Ordinal);
                    if (at <= 0) { at = term.IndexOf("<=", StringComparison.Ordinal); upper = at > 0; }
                    if (at <= 0) { if (warn != null) warn("'" + term + "' is not a criterion, rule dropped"); ok = false; break; }
                    var key = term.Substring(0, at).Trim();
                    var val = term.Substring(at + 2).Trim();
                    if (upper && !key.Equals("size", StringComparison.OrdinalIgnoreCase))
                    { if (warn != null) warn("only size takes a `<=`, rule dropped"); ok = false; break; }

                    if (key.Equals("size", StringComparison.OrdinalIgnoreCase))
                    {
                        var i = Array.FindIndex(SizeNames, n => n.Equals(val, StringComparison.OrdinalIgnoreCase));
                        if (i < 0) { if (warn != null) warn("'" + val + "' is not a hull size, rule dropped"); ok = false; break; }
                        if (upper) c.MaxSize = i; else c.MinSize = i;
                    }
                    else if (key.Equals("rarity", StringComparison.OrdinalIgnoreCase))
                    {
                        var r = VG.Core.Rarity.Rank(val);
                        if (r < 0) { if (warn != null) warn("'" + val + "' is not a quality, rule dropped"); ok = false; break; }
                        c.MinRarity = r;
                    }
                    else if (key.Equals("level", StringComparison.OrdinalIgnoreCase))
                    {
                        int d;
                        if (!int.TryParse(val.TrimStart('+'), out d)) { if (warn != null) warn("'" + val + "' is not a level offset, rule dropped"); ok = false; break; }
                        if (d < -LevelReach) d = -LevelReach;
                        if (d > LevelReach) d = LevelReach;
                        c.HasLevel = true;
                        c.MinLevelDelta = d;
                    }
                    else { if (warn != null) warn("'" + key + "' is not a criterion, rule dropped"); ok = false; break; }
                }
                if (ok) outp.Add(c);
            }
            return outp;
        }

        /// <summary>
        /// The level criterion as a player would say it, ⊥ as it is stored.
        ///
        /// `level +10 on mine` was the delta read out loud: it names the sign, the number and the comparison in
        /// the order the field happens to hold them, and none of that is how the thing is said. A criterion the
        /// player cannot read back is one they cannot check, which is the whole job of this line.
        /// </summary>
        private static string LevelSaid(int delta)
        {
            if (delta == 0) return "same level as I am";
            var n = delta > 0 ? delta : -delta;
            return n + (n == 1 ? " level " : " levels ") + (delta > 0 ? "above me" : "below me");
        }

        /// <summary>A rule as one line of English, for the editor and for the near-miss lines.</summary>
        internal static string Say(WatchCriteria c)
        {
            var parts = new List<string>();
            // `boardable`, ⊥ "can be taken now": that is the word the rest of the mod uses, the `+ boardable`
            // button sits directly under this list, and one feature calling the same state two things is how a
            // reader stops trusting either.
            if (c.Boardable == WatchCriteria.BoardableNow) parts.Add("boardable");
            if (c.MinSize >= 0 || c.MaxSize >= 0) parts.Add(SizeSpan(c));
            if (c.MinRarity >= 0) parts.Add(VG.Core.Rarity.RefitCode(VG.Core.Rarity.Order[c.MinRarity]) + "+");
            if (c.HasLevel) parts.Add(LevelSaid(c.MinLevelDelta));
            if (c.Hostility == WatchCriteria.HostileOnly) parts.Add("hostile");
            if (c.Hostility == WatchCriteria.FriendlyOnly) parts.Add("friendly");
            return parts.Count == 0 ? "everything" : string.Join(" and ", parts.ToArray());
        }
    }
}
