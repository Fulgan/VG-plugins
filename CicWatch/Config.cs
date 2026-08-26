using System;
using System.Collections.Generic;
using BepInEx.Configuration;
using UnityEngine;

namespace CicWatch
{
    // When the panel raises itself without being asked. Ours, not the game's: a mod-defined enum keeps the
    // config file readable and binds no game type.
    internal enum AutoOpen
    {
        /// <summary>The panel only ever opens by hand.</summary>
        Never,
        /// <summary>Up whenever a rule has called something, down when the plot clears.</summary>
        WhenCalled,
    }

    // Every setting, bound once here. Values persist themselves; a caller reads `.Value`.
    internal sealed class Config
    {
        // The size names are the game enum's OWN members, so a value in the file matches what the game calls the
        // hull. `S6` is display text and is deliberately not accepted here: two spellings of one size would be
        // two things to keep in step.
        //
        // `Drone` is NOT among them: there is no useful answer to "which drones do I want named", so drones carry no
        // rule and are therefore never listed on quality. One still appears if it turns boardable, since that path
        // bypasses quality altogether.
        // ONE owner, on the game-free side: `WatchMatch` is what the rules are matched by and what the tests
        // compile against, so a second copy here is the duplication that keeps costing this repo.
        internal static string[] SizeNames { get { return WatchMatch.SizeNames; } }

        /// <summary>How far either side of our own level a rule's floor may sit.</summary>
        internal const int LevelReach = WatchMatch.LevelReach;

        internal readonly ConfigEntry<bool> Enabled;
        internal readonly ConfigEntry<AutoOpen> AutoOpenOn;

        // THE OLD KEYS, kept ONLY so an existing setup can be carried into the rule list once. They are never read
        // again after `Migrate`, and they are hidden rather than deleted: deleting them would silently discard what
        // a player had configured the first time they launched a build with this change.
        private readonly ConfigEntry<string> _oldReport;
        private readonly ConfigEntry<bool> _oldHostileOnly;
        private readonly ConfigEntry<bool> _oldLevelFilter;
        private readonly ConfigEntry<int> _oldLevelDelta;

        // WHAT A ROW SHOWS. Three lines per hull is a lot when the question is only "what is out there", so the
        // detail is optional and the identity line never is: a row that can be switched down to nothing would be a
        // panel that lies about being empty.
        internal readonly ConfigEntry<bool> ShowVitals;
        internal readonly ConfigEntry<bool> ShowCapture;

        // QUIET LINES, which is also the panel's own on-a-quiet-plot behaviour: showing them means staying up with
        // nothing to report, so one switch owns both halves. Two switches for one question is what the tab had before,
        // and the player could not tell what either of them did.
        internal readonly ConfigEntry<bool> QuietLines;

        internal readonly ConfigEntry<string> PanelRect;

        /// <summary>The rule list itself: AND inside a rule, OR between them, default silence.</summary>
        internal readonly ConfigEntry<string> Rules;

        // The parsed list. Rebuilt whenever the key changes, so the file and the editor cannot disagree.
        private List<WatchCriteria> _rules = new List<WatchCriteria>();

        /// <summary>Which translation of the old keys this file has had. Bumped when the translation itself is wrong.</summary>
        private const int MigrationVersion = 2;
        private readonly ConfigEntry<int> _migrated;

        internal Config(ConfigFile file)
        {
            Enabled = file.Bind("Watch", "Enabled", true,
                "Watch the area and report what is in it. Off means nothing is read.");

            // ONE LIST, ⊥ a table plus a hostility switch plus a level floor. Those were three gates a contact had
            // to clear at once, so any one of them could veto the others in silence — which is exactly what
            // cost. A rule list has no precedence to get wrong: a rule can only ADD what is called.
            Rules = file.Bind("Watch", "Rules", DefaultRules(),
                new ConfigDescription(
                    "What gets called. One rule per `;`, one criterion per `,`, and a contact is called when ANY "
                    + "rule matches ALL of its own criteria. Nothing is called unless a rule says so. Criteria: "
                    + "`size>=<Size>`, `size<=<Size>`, `rarity>=<quality>`, `level>=<offset from YOUR level>`, "
                    + "`hostile`, `friendly`, `boardable`. Qualities are the game's own: Standard = A, Enhanced = B, "
                    + "HighGrade = C, Exotic = X, Legendary = S (never rolled by an enemy). Sizes: "
                    + string.Join(", ", SizeNames)
                    + ". Example: `hostile,size>=Size6,rarity>=Standard;boardable`."));

            var legacy = new VG.Shared.ConfigurationManagerAttributes { Browsable = false, IsAdvanced = true };
            _oldReport = file.Bind("Watch", "Report", "",
                new ConfigDescription("Replaced by Rules. Read once to carry an old setup across, then ignored.", null, legacy));
            _oldLevelFilter = file.Bind("Watch", "LevelFilter", false,
                new ConfigDescription("Replaced by a `level>=` criterion on a rule.", null, legacy));
            _oldLevelDelta = file.Bind("Watch", "MinLevelDelta", 0,
                new ConfigDescription("Replaced by a `level>=` criterion on a rule.",
                    new AcceptableValueRange<int>(-LevelReach, LevelReach), legacy));
            _oldHostileOnly = file.Bind("Watch", "HostileOnly", true,
                new ConfigDescription("Replaced by a `hostile` criterion on a rule.", null, legacy));
            _migrated = file.Bind("Watch", "RulesFrom", 0,
                new ConfigDescription("Which translation of the keys above produced Rules. Bookkeeping.", null, legacy));

            // The old values (Boardable, HostileAndBoardable, Any) were a SECOND policy beside the rule list and
            // are gone with it. A file still carrying one no longer parses and falls back to this default, which is
            // the behaviour those values were reaching for anyway.
            AutoOpenOn = file.Bind("Watch", "AutoOpenOn", AutoOpen.WhenCalled,
                "When the panel raises itself: WhenCalled (a rule called something) or Never. What counts as worth "
                + "naming is the Rules list and nothing else. It never takes keyboard focus.");

            // UNBOUND by default, which is Quick Save's rule and for the same reason: the game already uses a lot
            // of keys, and claiming one uninvited shadows something the player relies on. F9 was the first default
            // and it collided immediately. The settings tab carries a button, so the mod is fully usable with no
            // key at all, and the shared host's Hotkeys tab is where one gets chosen and collision-checked.
            ShowVitals = file.Bind("UI", "ShowVitals", true,
                "Show each hull's hull, armor and shield line in the panel. Off keeps one line per ship.");

            ShowCapture = file.Bind("UI", "ShowCapture", true,
                "Show each hull's capture line in the panel: whether it can be taken, why not, or the chance per "
                + "roll. Off keeps one line per ship. A hull that is boardable RIGHT NOW is still marked, whatever "
                + "this says, because that state has a clock on it.");

            QuietLines = file.Bind("UI", "QuietLines", true,
                "Report a quiet plot in words and stay up while it is quiet. Off hides the panel whenever there is "
                + "nothing to report and brings it back when there is.");

            PanelRect = file.Bind("UI", "PanelRect", "",
                new ConfigDescription(
                    "Where the panel sits, as x,y,width,height. Written when you move or resize it.",
                    null, new VG.Shared.ConfigurationManagerAttributes { Browsable = false, IsAdvanced = true }));

            Migrate();
            ReadRules();
            Rules.SettingChanged += (_, __) =>
            {
                ReadRules();
                // Redraw at once. A rule change that only shows up on the next 4 Hz tick leaves the player
                // wondering whether it applied at all, which is how a working filter came to be reported as
                // broken: nothing re-judged the hulls already on screen.
                try { Panel.Refresh(); } catch { }
            };
            QuietLines.SettingChanged += (_, __) => { try { Panel.Refresh(); } catch { } };
            ShowVitals.SettingChanged += (_, __) => { try { Panel.Refresh(); } catch { } };
            ShowCapture.SettingChanged += (_, __) => { try { Panel.Refresh(); } catch { } };
            Enabled.SettingChanged += (_, __) => { try { Panel.Refresh(); } catch { } };
        }

        /// <summary>Our own level, or 0 off-save.</summary>
        internal static int MyLevel()
        {
            try { return Source.Player.GamePlayer.current?.level ?? 0; }
            catch { return 0; }
        }

        /// <summary>The rules as parsed. Read-only to callers: writing goes through <see cref="SetRules"/>.</summary>
        internal IList<WatchCriteria> RuleList { get { return _rules; } }

        /// <summary>Write the whole list back, so the file, the editor and the scan cannot disagree.</summary>
        internal void SetRules(IList<WatchCriteria> rules)
        {
            _rules = new List<WatchCriteria>(rules);
            Rules.Value = WatchMatch.Serialize(_rules);
        }

        /// <summary>
        /// Could a FRIENDLY hull ever be called under the current list? The header counts friendlies separately and
        /// has to know whether they are merely uncounted or genuinely out of scope, and under a rule list that is no
        /// longer one switch to read.
        /// </summary>
        internal bool CallsFriendlies()
        {
            for (var i = 0; i < _rules.Count; i++)
                if (_rules[i].Hostility != WatchCriteria.HostileOnly) return true;
            return false;
        }

        private static string DefaultRules()
        {
            // The behaviour the old defaults gave, said in the new model: hostiles at HighGrade or better whatever
            // their size, plus anything that can be taken right now. The model changed and what a fresh install
            // reports did not.
            return "hostile,rarity>=HighGrade;boardable";
        }

        /// <summary>
        /// Carry an existing setup into the rule list, once.
        ///
        /// THE LEVEL FLOOR BECOMES ITS OWN RULE and is deliberately NOT carried onto the size rules. Folding it in
        /// would preserve the old CONJUNCTION, which is the whole defect the rule list exists to remove: a hull
        /// matching its size rule and held back for being one level short. The floor was only ever meant as one
        /// more reason to call something.
        ///
        /// SIZES KEEP THEIR BOUNDS. The old table was EXACT per size, so each entry becomes a bounded span and
        /// consecutive sizes sharing a quality collapse into one. A bare minimum would widen every rule to cover
        /// every larger size, which is a different set of contacts than the player configured.
        /// </summary>
        private void Migrate()
        {
            // VERSIONED, because the first cut of this translation was wrong in both of those directions at once.
            // A player who already ran that build carries a rule list that is not what their table said, and the
            // old keys are still sitting beside it untouched, so the honest repair is to translate again.
            if (_migrated.Value >= MigrationVersion) return;
            _migrated.Value = MigrationVersion;

            var old = (_oldReport.Value ?? "").Trim();
            if (old.Length == 0) return;

            var hostility = _oldHostileOnly.Value ? WatchCriteria.HostileOnly : WatchCriteria.AnyHostility;

            // Read the table into one quality per size, so runs are adjacent and can be collapsed by index.
            var perSize = new int[SizeNames.Length];
            for (var i = 0; i < perSize.Length; i++) perSize[i] = -1;
            foreach (var raw in old.Split(';'))
            {
                var line = raw.Trim();
                if (line.Length == 0) continue;
                var eq = line.IndexOf('=');
                if (eq <= 0) continue;

                var size = line.Substring(0, eq).Trim();
                var quality = line.Substring(eq + 1).Trim();
                var at = Array.FindIndex(SizeNames, s => s.Equals(size, StringComparison.OrdinalIgnoreCase));
                if (at < 0) continue;                                     // `Drone`, or a typo: it reported nothing
                if (quality.Equals("off", StringComparison.OrdinalIgnoreCase)) continue;
                var rank = VG.Core.Rarity.Rank(quality);
                if (rank < 0) continue;                                   // unreadable reported nothing before, too
                perSize[at] = rank;
            }

            var made = new List<WatchCriteria>();
            for (var i = 0; i < perSize.Length; i++)
            {
                if (perSize[i] < 0) continue;
                var j = i;
                while (j + 1 < perSize.Length && perSize[j + 1] == perSize[i]) j++;
                made.Add(new WatchCriteria
                {
                    MinSize = i,
                    // A run reaching the LARGEST size keeps no ceiling: it means "this size and up", which is what
                    // the player would write by hand and what a new hull size should inherit.
                    MaxSize = j == perSize.Length - 1 ? -1 : j,
                    MinRarity = perSize[i],
                    Hostility = hostility,
                });
                i = j;
            }

            // THE LEVEL FLOOR, as its OWN rule. It could only ever remove contacts before, and it is the one place
            // this migration deliberately does not reproduce the old behaviour.
            if (_oldLevelFilter.Value)
                made.Add(new WatchCriteria
                {
                    MinSize = -1, MaxSize = -1, MinRarity = -1,
                    HasLevel = true, MinLevelDelta = _oldLevelDelta.Value,
                    Hostility = hostility,
                });

            // The old boardable BYPASS was an exception to gates that no longer exist ∴ it becomes a rule, which is
            // the same behaviour with nothing special written.
            var takeable = WatchCriteria.None();
            takeable.Boardable = WatchCriteria.BoardableNow;
            made.Add(takeable);

            SetRules(made);
            Plugin.Log?.LogInfo($"CIC Watch: carried the old size table into {made.Count} rules -> {Rules.Value}");
        }

        /// <summary>Fold `Size6=A, Size7=A, Size8=A` into one `size>=Size6, rarity>=A`.</summary>
        private static List<WatchCriteria> Collapse(List<WatchCriteria> made)
        {
            var outp = new List<WatchCriteria>();
            for (var i = 0; i < made.Count; i++)
            {
                var run = made[i];
                // Only a run reaching the LARGEST size may collapse: a minimum has no upper bound, so folding a
                // middle run would silently widen the rule to sizes the player had set to something else.
                var j = i;
                while (j + 1 < made.Count
                       && made[j + 1].MinSize == made[j].MinSize + 1
                       && made[j + 1].MinRarity == run.MinRarity
                       && made[j + 1].Hostility == run.Hostility
                       && made[j + 1].HasLevel == run.HasLevel
                       && made[j + 1].MinLevelDelta == run.MinLevelDelta) j++;
                if (j == made.Count - 1 && made[j].MinSize == SizeNames.Length - 1) { outp.Add(run); return outp; }
                outp.Add(run);
            }
            return outp;
        }

        private void ReadRules()
        {
            _rules = WatchMatch.Deserialize(Rules.Value, m => Plugin.Log?.LogWarning("Rules: " + m));
        }
    }
}
