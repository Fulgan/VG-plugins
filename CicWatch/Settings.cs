using System;
using System.Collections.Generic;
using UnityEngine;
using VG.Core;

namespace CicWatch
{
    // The mod's tab in the shared settings window. IMGUI, like every other mod's tab: C4 forbids IMGUI for the
    // standing PANEL, which has to survive being left open while playing, and says nothing about a settings page
    // the player opens on purpose.
    //
    // Why this exists before the panel does: BepInEx reads a .cfg once at startup, so every threshold change meant
    // editing a file and restarting the game. A threshold that can only be changed by restarting cannot be tuned
    // against what is actually flying around, and HighGrade hulls are rare enough that waiting for one is not a
    // test.
    //
    // EVERY STATE IS SPELLED OUT IN TEXT. A pressed IMGUI button differs from an unpressed one by a few
    // shades, and this window is grey on grey: the first two reports of this tab were that a filter had silently
    // emptied the list, and then that what was active could not be told at all. So a control says what it is set
    // to in words, and a line above each group says what the setting MEANS for what gets reported.
    internal static class Settings
    {
        // EVERY piece of text on this tab carries its own colour. The skin's default label colour is dark, this
        // window is grey, and dark on grey is unreadable: an untagged label is therefore a bug here, not a
        // shortcut. Reported twice, once as grey on grey and once as dark on grey.
        private const string Text = "#e8edf2";   // the default this tab uses instead of the skin's
        private const string Hint = "#c8d4e0";
        private const string On = "#7fe08a";
        private const string Off = "#e08a8a";    // #c07070 was still too dark against the window
        private const string Warn = "#f0b84a";
        private const string Gold = "#f2c14e";   // a capture, the game's own Legendary tone

        // A palette meant for badges is not automatically legible as TEXT on grey: `Rarity.Color` gives Standard
        // #B0B0B0, which is the window's own tone. So a colour is lifted until it clears a contrast floor, rather
        // than forking the shared palette that Station Assistant also draws with.
        private static string Bright(string hex)
        {
            if (string.IsNullOrEmpty(hex) || hex.Length != 7 || hex[0] != '#') return Text;
            int r, g, b;
            try
            {
                r = Convert.ToInt32(hex.Substring(1, 2), 16);
                g = Convert.ToInt32(hex.Substring(3, 2), 16);
                b = Convert.ToInt32(hex.Substring(5, 2), 16);
            }
            catch { return Text; }

            // Rec. 601 luma, which is close enough for "can this be read" and needs no colour library.
            for (var guard = 0; guard < 8; guard++)
            {
                var luma = (0.299 * r + 0.587 * g + 0.114 * b) / 255.0;
                if (luma >= 0.62) break;
                r = r + (255 - r) / 3;
                g = g + (255 - g) / 3;
                b = b + (255 - b) / 3;
            }
            return $"#{r:X2}{g:X2}{b:X2}";
        }

        private static string Plain(string s) => $"<color={Text}>{s}</color>";

        // CONTROL BOTH SIDES OF THE CONTRAST PAIR. Colour tags alone were not enough twice over, because they only
        // set the ink: what it sits on belongs to whatever skin the game installed, and this window is grey. So the
        // tab paints its own near-black panel behind the text and writes light on it, which cannot be wrong for
        // either a light or a dark skin. Buttons keep the skin's own background, since their ink is the only half a
        // mod can safely change there.
        private static GUIStyle _panel;
        private static GUIStyle _label;
        private static Texture2D _bg;

        private static void EnsureStyles()
        {
            if (_panel != null && _bg != null) return;

            _bg = new Texture2D(1, 1);
            _bg.SetPixel(0, 0, new Color(0.09f, 0.10f, 0.12f, 0.94f));
            _bg.Apply();
            // Not collected between frames: a texture created per OnGUI would allocate every frame and vanish.
            UnityEngine.Object.DontDestroyOnLoad(_bg);
            _bg.hideFlags = HideFlags.HideAndDontSave;

            _panel = new GUIStyle(GUI.skin.box) { richText = true, padding = new RectOffset(8, 8, 6, 6) };
            _panel.normal.background = _bg;

            _label = new GUIStyle(GUI.skin.label) { richText = true, wordWrap = true };
            _label.normal.textColor = new Color(0.91f, 0.93f, 0.95f);
        }

        private static void L(string text) { GUILayout.Label(text, _label); }

        // WHAT WE ARE ACTUALLY DRAWING ON, logged once. Three attempts at this tab's contrast were guesses about a
        // skin nobody had measured, and the player cannot send a screenshot right now, so the mod reports the
        // colours itself. Cheap, one-shot, and it turns "still grey on grey" into numbers.
        private static bool _describedSkin;

        private static void DescribeSkin()
        {
            if (_describedSkin) return;
            _describedSkin = true;
            try
            {
                var s = GUI.skin;
                Plugin.Log.LogInfo(
                    $"skin '{s.name}': label text {Hex(s.label.normal.textColor)} richText={s.label.richText}, "
                    + $"button text {Hex(s.button.normal.textColor)} bg={(s.button.normal.background != null ? "yes" : "none")}, "
                    + $"box bg={(s.box.normal.background != null ? "yes" : "none")}, "
                    + $"window text {Hex(s.window.normal.textColor)} bg={(s.window.normal.background != null ? "yes" : "none")}, "
                    + $"GUI.color {Hex(GUI.color)}, contentColor {Hex(GUI.contentColor)}, backgroundColor {Hex(GUI.backgroundColor)}, "
                    + $"our panel bg={(_panel != null && _panel.normal.background != null ? "applied" : "MISSING")}");
            }
            catch (Exception e) { Plugin.Log.LogWarning($"could not describe the skin: {e.Message}"); }
        }

        private static string Hex(Color c)
        {
            return $"#{(int)(c.r * 255):X2}{(int)(c.g * 255):X2}{(int)(c.b * 255):X2}"
                   + (c.a < 0.99f ? $"(a{c.a:0.00})" : "");
        }
        private static void L(string text, float width) { GUILayout.Label(text, _label, GUILayout.Width(width)); }

        internal static void Draw()
        {
            var cfg = Plugin.Cfg;
            if (cfg == null) { L(Plain("not configured")); return; }

            GUI.skin.label.richText = true;
            GUI.skin.button.richText = true;
            EnsureStyles();
            DescribeSkin();

            GUILayout.BeginVertical(_panel);
            DrawMaster(cfg);
            GUILayout.Space(6f);

            DrawRules(cfg);
            GUILayout.Space(6f);

            DrawWhoCounts(cfg);
            GUILayout.Space(8f);

            DrawContacts(cfg);
            GUILayout.EndVertical();
        }

        private static void DrawMaster(Config cfg)
        {
            var on = cfg.Enabled.Value;
            GUILayout.BeginHorizontal();
            if (GUILayout.Button(State(on, "Plot manned", "Plot unmanned"), GUILayout.Width(230f)))
                cfg.Enabled.Value = !on;
            L(on ? "" : $"<color={Warn}>no sweeps run while the plot is unmanned</color>");
            GUILayout.EndHorizontal();

            // The one manual way in. The panel raises itself against the situation, so this exists for the opposite
            // case: putting it away, and proving it can be drawn at all when nothing has raised it.
            GUILayout.BeginHorizontal();
            if (GUILayout.Button(Plain(Panel.IsOpen ? "Strike the plot" : "Show the plot"),
                    GUILayout.Width(230f)))
                Panel.Toggle();
            GUILayout.EndHorizontal();
        }

        // THE RULE LIST. A contact is called when ANY rule matches ALL of its own criteria, and nothing is
        // called unless a rule says so.
        //
        // THE WINDOW IS 440px WIDE, FIXED, WITH NO SCROLL VIEW (`ModHost`) - so every row here is built to fit
        // inside roughly 420px and that is a hard constraint, not a preference. A row that overflows does not wrap
        // or scroll, it walks off the screen and takes its controls with it.
        //
        // ONE RULE OPEN AT A TIME. Each rule collapses to a single line that reads as a sentence, because the list
        // is the thing consulted most and the criteria only while one is being changed. Expanding every rule at
        // once costs five lines each and pushes the contacts readout off the bottom of a window that cannot scroll.
        //
        // EVERY VALUE IS ON SCREEN AND THE CHOSEN ONE IS BRACKETED - the idiom this tab already uses for the
        // quality letters, and what V11 exists for. A control that cycles its values on each press shows only the
        // state you are in and never what the alternatives are called.
        private static int _open = -1;

        private static void DrawRules(Config cfg)
        {
            var rules = new List<WatchCriteria>(cfg.RuleList);

            L(rules.Count == 0
                ? Plain("Rules:") + $" <color={Warn}><b>none, so nothing will ever be called</b></color>"
                : Plain("Rules: called when <b>any</b> of these matches"));

            var changed = false;
            var remove = -1;

            for (var i = 0; i < rules.Count; i++)
            {
                var r = rules[i];
                var open = _open == i;

                GUILayout.BeginHorizontal();
                L($"<color={Hint}>{i + 1}</color>", 18f);
                L(r.IsEmpty
                    ? $"<color={Warn}>everything (no criteria set)</color>"
                    : $"<color={Text}>{WatchMatch.Say(r)}</color>");
                if (GUILayout.Button(open ? $"<color={On}>[ done ]</color>" : Plain("edit"), GUILayout.Width(56f)))
                    _open = open ? -1 : i;
                if (GUILayout.Button($"<color={Off}>x</color>", GUILayout.Width(24f))) remove = i;
                GUILayout.EndHorizontal();

                if (!open) continue;

                // SIZE, as a span. `any` is the leftmost value on the same row rather than a separate switch,
                // because the player is choosing one thing and "no size rule" is one of its values.
                GUILayout.BeginHorizontal();
                L($"<color={Hint}>size</color>", 46f);
                if (Pick(r.MinSize < 0 && r.MaxSize < 0, "any", 36f)) { r.MinSize = -1; r.MaxSize = -1; changed = true; }
                for (var z = 0; z < Config.SizeNames.Length; z++)
                {
                    var named = !(r.MinSize < 0 && r.MaxSize < 0);
                    var inSpan = named && (r.MinSize < 0 || z >= r.MinSize) && (r.MaxSize < 0 || z <= r.MaxSize);
                    var edge = z == r.MinSize || z == r.MaxSize;
                    var tint = Bright(Fmt.SizeColor(Config.SizeNames[z]));
                    var name = Fmt.SizeLabel(Config.SizeNames[z]);
                    var label = edge ? $"<b><color={tint}>[{name}]</color></b>"
                              : inSpan ? $"<color={tint}>{name}</color>"
                                       : $"<color={Hint}>{name}</color>";
                    if (GUILayout.Button(label, GUILayout.Width(36f)))
                    {
                        // FIRST PRESS SETS ONE SIZE; pressing it again opens the span upward; pressing another
                        // extends to it. Two presses reach every span and one reaches the common single size.
                        if (r.MinSize == z && r.MaxSize == z) { r.MaxSize = -1; }
                        else if (r.MinSize < 0 || r.MaxSize < 0 || z < r.MinSize) { r.MinSize = z; r.MaxSize = z; }
                        else { r.MaxSize = z; }
                        changed = true;
                    }
                }
                GUILayout.EndHorizontal();

                GUILayout.BeginHorizontal();
                L($"<color={Hint}>quality</color>", 46f);
                if (Pick(r.MinRarity < 0, "any", 36f)) { r.MinRarity = -1; changed = true; }
                for (var q = 0; q < Rarity.Order.Length; q++)
                {
                    var letter = Rarity.RefitCode(Rarity.Order[q]);
                    var tint = Bright(Rarity.Color(Rarity.Order[q]));
                    var label = r.MinRarity == q ? $"<b><color={tint}>[{letter}]</color></b>"
                              : r.MinRarity >= 0 && q > r.MinRarity ? $"<color={On}>+</color><color={tint}>{letter}</color>"
                                                                    : $"<color={Hint}>{letter}</color>";
                    if (GUILayout.Button(label, GUILayout.Width(36f))) { r.MinRarity = q; changed = true; }
                }
                L($"<color={Hint}>S never rolls</color>");
                GUILayout.EndHorizontal();

                // LEVEL stays RELATIVE: an absolute floor goes stale on every level-up, and
                // the row states BOTH numbers because an offset alone cannot be checked against the panel.
                GUILayout.BeginHorizontal();
                L($"<color={Hint}>level</color>", 46f);
                if (Pick(!r.HasLevel, "any", 36f)) { r.HasLevel = false; changed = true; }
                if (Pick(r.HasLevel, r.HasLevel ? Gap(r.MinLevelDelta) : "a gap", 74f)) { r.HasLevel = true; changed = true; }
                if (r.HasLevel)
                {
                    if (GUILayout.Button(Plain("-5"), GUILayout.Width(30f))) { r.MinLevelDelta = Clamp(r.MinLevelDelta - 5); changed = true; }
                    if (GUILayout.Button(Plain("-1"), GUILayout.Width(30f))) { r.MinLevelDelta = Clamp(r.MinLevelDelta - 1); changed = true; }
                    if (GUILayout.Button(Plain("+1"), GUILayout.Width(30f))) { r.MinLevelDelta = Clamp(r.MinLevelDelta + 1); changed = true; }
                    if (GUILayout.Button(Plain("+5"), GUILayout.Width(30f))) { r.MinLevelDelta = Clamp(r.MinLevelDelta + 5); changed = true; }
                    if (GUILayout.Button(Plain("mine"), GUILayout.Width(48f))) { r.MinLevelDelta = 0; changed = true; }
                }
                GUILayout.EndHorizontal();
                if (r.HasLevel)
                    L($"<color={Hint}>       = level {Config.MyLevel() + r.MinLevelDelta} and above (you are {Config.MyLevel()})</color>");

                GUILayout.BeginHorizontal();
                L($"<color={Hint}>who</color>", 46f);
                if (Pick(r.Hostility == WatchCriteria.AnyHostility, "anyone", 62f)) { r.Hostility = WatchCriteria.AnyHostility; changed = true; }
                if (Pick(r.Hostility == WatchCriteria.HostileOnly, "hostile", 62f)) { r.Hostility = WatchCriteria.HostileOnly; changed = true; }
                if (Pick(r.Hostility == WatchCriteria.FriendlyOnly, "friendly", 66f)) { r.Hostility = WatchCriteria.FriendlyOnly; changed = true; }
                GUILayout.EndHorizontal();

                GUILayout.BeginHorizontal();
                L($"<color={Hint}>taking</color>", 46f);
                if (Pick(r.Boardable == WatchCriteria.AnyBoardable, "any", 36f)) { r.Boardable = WatchCriteria.AnyBoardable; changed = true; }
                if (Pick(r.Boardable == WatchCriteria.BoardableNow, "boardable now", 108f)) { r.Boardable = WatchCriteria.BoardableNow; changed = true; }
                GUILayout.EndHorizontal();

                // A ROW OF ITS OWN, under the criteria rather than among them: this one does not change WHAT the
                // rule calls, only whether the call is audible, and putting it in the `who`/`taking` run would read
                // as a third thing being watched for.
                GUILayout.BeginHorizontal();
                L($"<color={Hint}>sound</color>", 46f);
                if (Pick(!r.Chime, "silent", 52f)) { r.Chime = false; changed = true; }
                if (Pick(r.Chime, "chime", 52f)) { r.Chime = true; changed = true; }
                if (r.Chime && !Plugin.Cfg.ChimeEnabled.Value)
                    L($"  <color={Hint}>sound is switched off below, so this rule stays silent</color>");
                GUILayout.EndHorizontal();

                GUILayout.Space(3f);
                rules[i] = r;
            }

            if (remove >= 0)
            {
                rules.RemoveAt(remove);
                // The open rule is tracked by INDEX, so removing one above it would leave the editor open on a
                // different rule than the player was editing.
                if (_open == remove) _open = -1; else if (_open > remove) _open--;
                changed = true;
            }

            GUILayout.BeginHorizontal();
            if (GUILayout.Button(Plain("+ rule"), GUILayout.Width(70f)))
            {
                // A NEW RULE STARTS EMPTY, SAYS SO, AND OPENS: an empty rule calls everything, so leaving it shut
                // would hide the one state that needs attention immediately.
                rules.Add(WatchCriteria.None());
                _open = rules.Count - 1;
                changed = true;
            }
            if (GUILayout.Button(Plain("+ hostiles C+"), GUILayout.Width(110f)))
            {
                var hostiles = WatchCriteria.None();
                hostiles.MinRarity = Rarity.Rank("HighGrade");
                hostiles.Hostility = WatchCriteria.HostileOnly;
                rules.Add(hostiles);
                changed = true;
            }
            if (GUILayout.Button(Plain("+ boardable"), GUILayout.Width(100f)))
            {
                var takeable = WatchCriteria.None();
                takeable.Boardable = WatchCriteria.BoardableNow;
                rules.Add(takeable);
                changed = true;
            }
            GUILayout.EndHorizontal();

            L($"<color={Hint}>Adding a rule only ever widens what is called, never narrows it.</color>");

            if (changed) cfg.SetRules(rules);
        }

        /// <summary>One value of a criterion: bracketed when it is the chosen one. Returns true when pressed.</summary>
        private static bool Pick(bool chosen, string label, float width)
        {
            return GUILayout.Button(chosen ? $"<b><color={On}>[{label}]</color></b>" : $"<color={Hint}>{label}</color>",
                                    GUILayout.Width(width));
        }

        /// <summary>The gap in the terms it was set in: `my level`, `+3`, `-3`.</summary>
        private static string Gap(int delta) => delta == 0 ? "my level" : delta > 0 ? "+" + delta : delta.ToString();

        private static int Clamp(int delta)
        {
            return delta < -Config.LevelReach ? -Config.LevelReach
                 : delta > Config.LevelReach ? Config.LevelReach
                 : delta;
        }

        private static void DrawWhoCounts(Config cfg)
        {
            // WHO COUNTS is a criterion on a rule now, not a switch here: a switch beside the list would be a gate
            // able to veto every rule at once, which is the shape B19 came from.

            // QUIET LINES own the panel's behaviour on an empty plot, because the two are the same choice: a line
            // about a clear plot is only worth writing if the panel is there to write it on.
            var quiet = cfg.QuietLines.Value;
            L(quiet
                ? Plain("The plot <b>stays up when it is clear</b> and says so")
                  + $" <color={Hint}>(Plot's clear, Skipper)</color>"
                : Plain("The plot <b>waits for something to call</b>")
                  + $" <color={Hint}>(it comes up when a contact is worth naming, and goes when the plot clears)</color>");

            var pickQuiet = Choice(quiet, "Report a clear plot", "Strike the plot when clear");
            if (pickQuiet != quiet) cfg.QuietLines.Value = pickQuiet;

            GUILayout.Space(6f);
            // THE SWITCH AND THE LEVEL SIT TOGETHER, and neither is where a rule is made audible: this decides
            // whether the mod may make a sound at all, the rule decides which calls are worth one. Off by rule
            // rather than off by default here, so a player who marks a rule and hears nothing has one place to look.
            var chime = cfg.ChimeEnabled.Value;
            L(chime
                ? Plain("Rules marked <b>chime</b> make a sound when they call something new")
                  + $" <color={Hint}>(the game's own effects volume applies on top)</color>"
                : Plain("<b>No sound</b>, whatever a rule says"));
            var pickChime = Choice(chime, "Let rules chime", "Silence every rule");
            if (pickChime != chime) cfg.ChimeEnabled.Value = pickChime;

            if (cfg.ChimeEnabled.Value)
            {
                GUILayout.BeginHorizontal();
                L($"<color={Hint}>volume</color>", 56f);
                var v = GUILayout.HorizontalSlider(cfg.ChimeVolume.Value, 0f, 1f, GUILayout.Width(140f));
                if (Mathf.Abs(v - cfg.ChimeVolume.Value) > 0.001f) cfg.ChimeVolume.Value = v;
                L($"  <color={Hint}>{Mathf.RoundToInt(cfg.ChimeVolume.Value * 100f)}%</color>", 44f);
                // A PREVIEW IGNORES THE COOLDOWN. It exists to answer "can I hear this", and a button that does
                // nothing because a hull was called two seconds ago answers the opposite question.
                if (GUILayout.Button(Plain("Play it"), GUILayout.Width(70f))) Chime.PlayNow();
                GUILayout.FlexibleSpace();
                GUILayout.EndHorizontal();
            }
        }

        // THE LEVEL ROW IS GONE, and its rule is not: `level>=` is a criterion on a rule now. As a standalone
        // control it was a gate across every rule at once, which is what B19 cost - a hull that matched its size
        // rule, held back for being one level short. V31's relativity survives inside the criterion; only its role
        // as a veto is gone.

        // What the watcher holds now. A DIAGNOSTIC, not the panel: the panel is uGUI under the game's own canvas and
        // stays open while you fly. This one is only visible while the settings window is, which is exactly when you
        // are not flying.
        // ONE scan per LAYOUT pass, reused for the Repaint that follows it.
        //
        // ⚠ IMGUI issues both events for the same frame and matches controls BY ORDER, and the control count below
        // depends on how many contacts came back ∴ a hull dying or spawning between the two passes changes the
        // count and Unity throws "Getting control N's position in a group with only M controls", which the host
        // renders as "tab error (see log)". Scanning once per Layout also stops a 100,000-radius sweep running on
        // every event, which was roughly 120 times a second while this window was open.
        private static List<Contact> _shown;
        private static Watch.Tally _shownArea = new Watch.Tally();

        private static void DrawContacts(Config cfg)
        {
            if (_shown == null || Event.current == null || Event.current.type == EventType.Layout)
            {
                _shown = Watch.Scan();
                _shownArea = Watch.Area;
            }
            var all = _shown;
            var d = _shownArea;

            L($"<b><color={Text}>Contacts held: {all.Count}</color></b>");

            if (all.Count == 0)
            {
                // NAME WHAT EMPTIED IT. "0" on its own is indistinguishable from a broken readout, and that is
                // exactly how this feature was first reported.
                if (d.Seen == 0)
                {
                    L($"<color={Hint}>Nothing on the scope. This is a sweep of what is out there now, "
                      + "not a log of what has passed through.</color>");
                }
                else
                {
                    // WHAT WOULD HAVE TO CHANGE, not what dropped them: under a disjunction no single criterion
                    // dropped anything, so the only honest and useful thing to report is the rule that came closest
                    // and the one term it fell on.
                    L($"<color={Hint}>{VG.Text.Say.Count(d.Seen, "contact")} on the scope, none called. "
                      + (cfg.RuleList.Count == 0
                            ? "There are no rules, so nothing can be.</color>"
                            : "What would have to change:</color>"));
                    foreach (var near in d.Misses)
                    {
                        var rule = near.Rule >= 0 && near.Rule < cfg.RuleList.Count
                            ? WatchMatch.Say(cfg.RuleList[near.Rule]) : "?";
                        L($"  <color={Warn}>{near.Count}</color> <color={Text}>missed "
                          + $"<b>rule {near.Rule + 1}</b> ({rule}) on {near.Failed}</color>"
                          + $" <color={Hint}>(wants {near.Detail})</color>");
                    }
                    if (d.Wreck > 0)
                        L($"  <color={Warn}>{VG.Text.Say.Count(d.Wreck, "salvage wreck")}</color>"
                          + $"<color={Text}>, not ships</color>");
                    Reason("your own ship", d.Own, null);
                    Reason("hired wingmen", d.Hired, null);
                }
            }
            else
            {
                var shown = 0;
                foreach (var c in all)
                {
                    if (shown++ == 12) { L($"...and {all.Count - 12} more"); break; }
                    // Same language as the panel: size first on its own colour ramp, a dot between it and the badge,
                    // gold for a capture ahead of the hostility colour.
                    var tint = c.Boardable ? Gold : c.Hostile ? "#ff8a8a" : "#8ae89a";
                    L($"<b><color={Bright(Fmt.SizeColor(c.Size))}>{c.SizeLabel,-5}</color></b>"
                      + $"<color={Hint}>·</color> <color={tint}>{c.Label}</color>  "
                      + $"<color={Text}>{c.Class}</color>  <color={Hint}>{c.RankLabel}</color>"
                      + (c.Boardable ? $"  <color={Gold}><b>BOARDABLE</b></color>" : ""));

                    if (!cfg.ShowVitals.Value && !cfg.ShowCapture.Value) continue;

                    var p = Prospects.Read(c.Unit);
                    if (!p.Known) { L($"    <color={Hint}>gone</color>"); continue; }

                    // Only the layers this hull actually carries: a drone with no plating and no generator reads
                    // hull alone, which is the whole truth about it.
                    if (cfg.ShowVitals.Value)
                    {
                        var vitals = $"<color={Hint}>hull</color> {Bar(p.Hull)}";
                        if (p.HasArmor) vitals += $" <color={Hint}>armor</color> {Bar(p.Armor)}";
                        if (p.HasShield)
                            vitals += p.ShieldsDown
                                ? $" <color={Warn}>shields down</color>"
                                : $" <color={Hint}>shield</color> {Bar(p.Shield)}";
                        L("    " + vitals);
                    }

                    // Null means there is nothing worth saying about capturing this hull, so no line is drawn.
                    if (cfg.ShowCapture.Value)
                    {
                        var capture = Capture(p);
                        if (capture != null) L("    " + capture);
                    }
                }
                L($"<color={Hint}>{d.Seen} on the scope, {d.Listed} called, "
                  + $"{d.Seen - d.Listed} matching no rule.</color>");
            }

            // Our own cost, in the open. A freeze is always blamed on the newest mod, and the only answer to that is
            // a number the player can read off the screen.
            L($"<color={Hint}>Last sweep: {d.Seen} contacts resolved in {Watch.ScanMs:n1} ms.</color>");

            GUILayout.Space(4f);
            if (GUILayout.Button(Plain("Repeat the last call")))
                Plugin.Log.LogInfo(Watch.AnnounceAgain());
        }

        // BOARDABLE speaks for itself and carries a clock, so it is stated with the figure the game's own boarding
        // panel counts down from. Otherwise ONLY THE NEGATIVE is worth a line: knowing a hull can NEVER be taken is
        // what stops a pointless grind to 1% hull, while "it can be captured" changes nothing and so says nothing.
        private static string Capture(Prospect p)
        {
            if (p.Boardable)
                return $"<color={Gold}><b>BOARDABLE NOW</b></color> "
                       + $"<color={Hint}>boarding starts at {Fmt.Pct(p.Integrity)} integrity</color>";

            if (!p.CanTake)
                return $"<color={Hint}>cannot be taken: {p.WhyNot}. Kill it for the drop instead.</color>";
            return null;
        }

        // A four-cell bar AND the number: the bar is for the glance across a list, the number is for the decision.
        // Either alone loses one of the two jobs the row has.
        /// <summary>
        /// A layer as a tinted percentage.
        ///
        /// The `####`/`____` meter that used to precede it is GONE: four characters cannot say anything the number
        /// beside them did not already say exactly, and at full health it read as `#### 100%`, which looks like a
        /// formatting fault rather than a bar. The tint carries the at-a-glance half.
        /// </summary>
        private static string Bar(float f)
        {
            var tint = f <= 0.25f ? Off : f <= 0.6f ? Warn : On;
            return $"<color={tint}>{Fmt.Pct(f)}</color>";
        }

        // A switch says its STATE in words before its label, because a pressed IMGUI button differs from an
        // unpressed one by a few shades and this window is grey on grey.
        private static string State(bool on, string yes, string no)
        {
            return on ? $"<color={On}>ON</color>  {Plain(yes)}" : $"<color={Off}>OFF</color>  {Plain(no)}";
        }

        // TWO NAMED VALUES SIDE BY SIDE, the chosen one bracketed, rather than one button that toggles: a toggle
        // shows only where you are and never what the alternative is called.
        private static bool Choice(bool first, string a, string b)
        {
            var picked = first;
            GUILayout.BeginHorizontal();
            if (GUILayout.Button(first ? $"<color={On}>[ {a} ]</color>" : Plain(a), GUILayout.Width(200f)))
                picked = true;
            if (GUILayout.Button(!first ? $"<color={On}>[ {b} ]</color>" : Plain(b), GUILayout.Width(200f)))
                picked = false;
            GUILayout.EndHorizontal();
            return picked;
        }

        // One line per reason, only when it dropped something, and it names the CONTROL that undoes it: a list of
        // zeroes is noise, and a reason with no way out leaves the player hunting for a setting.
        private static void Reason(string what, int count, string fix)
        {
            if (count <= 0) return;
            var tail = fix == null ? "" : $" <color={Hint}>(press {fix})</color>";
            L($"  <color={Warn}>{count}</color> <color={Text}>{what}</color>{tail}");
        }
    }
}
