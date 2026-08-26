using System;
using System.Collections.Generic;
using System.Text;
using TMPro;
using UnityEngine;
using UnityEngine.EventSystems;
using UnityEngine.UI;
using VG.Core;

namespace CicWatch
{
    // The standing readout: what is in the area, kept on screen while you fly.
    //
    // uGUI, never IMGUI (C4). An IMGUI overlay paints over everything, cannot sit in the UI layer, and only draws
    // while its OnGUI runs, which makes "leave it open and keep playing" impossible.
    //
    // ON OUR OWN CANVAS, which is a deliberate change from the original plan of parenting to the game's HUD canvas.
    // The reason that plan existed was to reuse the game's own window components, and that turned out to be
    // impossible. Without that
    // reason, our own canvas is strictly better: marked DontDestroyOnLoad it survives a dock or a system change
    // with no re-find, which was the failure V7 warned about ("it vanishes silently, which reads as the mod
    // breaking"). The font still comes from the game, cloned off a live label, so the panel reads as part of it.
    internal static class Panel
    {
        private const float Width = 460f;
        private const float Pad = 10f;

        // ONE palette, named, rather than hex at each call site. GOLD is a capture and it is the game's own
        // Legendary tone, so it reads as the game's idea of "rare"; RED is a threat, GREEN a neighbour.
        private const string Gold = "#f2c14e";
        private const string Red = "#ff8a8a";
        private const string Green = "#8ae89a";
        private const string Bright = "#ffffff";
        private const string Dim = "#c8d4e0";

        private static GameObject _root;
        private static RectTransform _rect;
        private static TMP_Text _title;
        private static TMP_Text _body;
        private static bool _open;
        private static bool _warned;

        internal static bool IsOpen => _open && _root != null;

        // WHO RAISED IT, which decides who may lower it. A panel the watch raised may be lowered again when the plot
        // clears; a panel the player opened stays up until they close it. And a panel the player CLOSED is not raised
        // again for the same engagement, or dismissing it would be pointless — the flag clears once the area is empty.
        internal static bool AutoOpened;
        internal static bool DismissedByHand;

        internal static void Toggle()
        {
            // Logged on every request, so a keypress that reaches us is visible even when nothing appears: the
            // first report of this panel was "not displayed", and silence cannot distinguish a hotkey that never
            // fired from a panel that failed to draw.
            Plugin.Log.LogInfo($"panel toggle requested (was {(_open ? "open" : "closed")}, "
                               + $"built {(_root != null ? "yes" : "no")})");
            if (_root == null && !Build()) return;
            _open = !_open;
            _root.SetActive(_open);
            AutoOpened = false;
            DismissedByHand = !_open;
            if (_open) Refresh();
        }

        internal static void Close()
        {
            _open = false;
            if (_root != null) _root.SetActive(false);
        }

        /// <summary>Lower a panel the WATCH raised. One the player opened is left alone.</summary>
        internal static void AutoHide()
        {
            if (!_open || !AutoOpened) return;
            AutoOpened = false;
            Close();
        }

        // AN ARRIVAL BORROWS THE HEADER, AND CARRIES IT. The line it replaces says what is out there, so the wave
        // sentence states the change AND what the plot holds after it (`Voice.Change`) rather than hiding the second
        // for six seconds. Amber, since gold is a capture and red is a hull shooting at us.
        private const string Alert = "#f0b84a";
        private static string _flash;
        private static float _flashUntil;

        internal static void Flash(string line, float seconds = 6f)
        {
            _flash = line;
            _flashUntil = Time.unscaledTime + seconds;
            Refresh();
        }

        // THE HEADER IS THE AREA, THE ROWS ARE THE RULES. Every hostile hull is called whether or not it earned a
        // row: the quality rules choose what is worth a line, not what exists. The counts come from `Watch.Standing`,
        // which the wave call reads too, so the flash and the line it replaces cannot state different numbers.
        private static string Header(int designated)
        {
            return Voice.Report(Watch.Standing(designated));
        }

        /// <summary>Redraw, scanning for itself. For a settings change, where no tick is in hand.</summary>
        internal static void Refresh() { Refresh(null); }

        /// <summary>
        /// RAISE the panel, without stealing focus. Named `Raise` rather than `Show` because `Show` is what a
        /// NOTIFICATION does (`GameToast.Show`), and the two are opposite in kind: one puts a sentence in front of the
        /// player and goes, the other puts a standing readout on screen and stays.
        /// </summary>
        internal static void Raise(bool auto = false)
        {
            if (_root == null && !Build()) return;
            if (auto && !_open) AutoOpened = true;
            _open = true;
            _root.SetActive(true);
            Refresh();
        }

        // Rebuilt from the live set. Called at 4 Hz rather than per frame: a distance that updates 60 times a
        // second reads no better and costs a string build every frame.
        /// <summary>Redraw from a scan already taken, so one pass serves the panel and the state changes.</summary>
        internal static void Refresh(List<Contact> given)
        {
            if (!IsOpen || _body == null) return;

            var all = given ?? Watch.Scan();

            var sb = new StringBuilder();

            // AN EMPTY PANEL SAYS ONE LINE AND STOPS. It used to print the whole rejection breakdown plus a note
            // about which ranks can roll which letters, and the player's verdict on that was "all this is noise":
            // a HUD that lectures is worse than one that says little, and the tab is where a player goes to ask why.
            // V11's requirement is still met, in the place that can afford it.
            var flashing = _flash != null && Time.unscaledTime < _flashUntil;
            _title.text = flashing
                ? $"<b>CIC</b>  <color={Alert}><b>{_flash}</b></color>"
                : $"<b>CIC</b>  <color={Dim}>{Header(all.Count)}</color>";

            // THE BODY SITS UNDER WHATEVER THE TITLE ACTUALLY TOOK. A fixed 24 px offset assumed the header is one
            // line, and a wave call is long enough to wrap: the second line landed on top of the first contact row.
            // The title is the only wrapping element here, so its measured height is the whole layout.
            // Measured AFTER the layout runs: `preferredHeight` read straight after a text assignment can still be
            // last frame's, which would place the body under the wrong header.
            _title.ForceMeshUpdate();
            var head = Mathf.Max(22f, _title.preferredHeight);
            _body.rectTransform.anchoredPosition = new Vector2(Pad, -Pad - head - 2f);

            if (all.Count == 0)
            {
                _body.text = "";
                _rect.sizeDelta = new Vector2(Width, head + Pad * 2 + 8f);
                return;
            }

            var shown = 0;
            foreach (var c in all)
            {
                if (shown++ == 14) { sb.Append($"<color=#c8d4e0>...and {all.Count - 14} more</color>"); break; }

                var p = Prospects.Read(c.Unit);
                if (!p.Known) continue;

                // GOLD IS A CAPTURE and it outranks hostility: a hull you can take is a different decision from one
                // shooting at you, and the rarer one. Red is a threat, green a neighbour.
                var tint = p.Boardable ? Gold : c.Hostile ? Red : Green;
                var range = c.Distance > 0f ? $"  <color={Dim}>{c.Distance:n0}m</color>" : "";

                // SIZE FIRST, in NORMAL letter spacing. It was monospaced with `<mspace=0.62em>` to line the column
                // up, and that was the whole legibility problem: forcing every glyph to one narrow width jams `S`
                // against `3`. The colour was never the issue. Alignment now comes from `<pos>`, which places the
                // next run at a fixed offset without touching the glyphs, and the tier colour sits behind the label
                // as a chip so the letters stay the brightest thing in the row.
                var size = $"<mark={Fmt.SizeColor(c.Size)}66><b><color={Bright}> {c.SizeLabel} </color></b></mark>";

                // BOARDABLE lives on the status line below, with the hull figure beside it, so it is not said twice.
                // It moves up here only when the status line is switched off, because a setting must not be able to
                // hide the one state that has a clock on it.
                var take = p.Boardable && !Plugin.Cfg.ShowVitals.Value
                    ? $"  <color={Gold}><b>BOARDABLE</b></color>"
                    : "";
                // `<pos>` starts the badge at a fixed offset, so the size labels form a column even though `Drone` is
                // five glyphs and `S3` is two. That is what `<mspace>` was doing badly. The dot stays as the
                // separator asked for earlier, now with real space on both sides.
                sb.Append($"{size} <color={Dim}>·</color><pos=5em><color={tint}>{c.Label}</color>  {c.Class}  "
                          + $"<color={Dim}>{c.RankLabel}</color>{range}{take}\n");

                // TWO LINES PER SHIP AT MOST (the player's cap): the status line carries the vitals AND, when the
                // answer is no, why this hull can never be taken. A third line for one short clause was a row that
                // scrolled the panel for no gain.
                if (Plugin.Cfg.ShowVitals.Value)
                {
                    // A BOARDABLE hull gets the status line to itself, with its hull figure. Armor and shields are
                    // noise there: the fight is over, the layers stopped mattering, and the only number that still
                    // means anything is how much hull is left on the thing you are about to take.
                    if (p.Boardable)
                    {
                        // INTEGRITY, not hull: it is what the game's boarding panel counts down from, and a hull shot
                        // to 0% still opens an operation at 20%. BOARDING vs BOARDABLE separates a figure that is
                        // FALLING from one that is waiting: the first is the live count the simulation is spending,
                        // the second is what an operation would open with.
                        var state = p.Boarding ? "BOARDING" : "BOARDABLE";
                        sb.Append($"   <color={Gold}><b>{state}</b></color>  <color={Dim}>integrity</color> "
                                  + $"{Pct(p.Integrity)}\n");
                    }
                    else
                    {
                        // Only the layers this hull actually carries: a drone with no plating and no generator reads
                        // `hull 62%` and nothing else, which is the whole truth about it.
                        sb.Append($"   <color={Dim}>hull</color> {Pct(p.Hull)}");
                        if (p.HasArmor) sb.Append($" <color={Dim}>arm</color> {Pct(p.Armor)}");
                        if (p.HasShield)
                            sb.Append(p.ShieldsDown ? " <color=#f0b84a>shields down</color>"
                                                    : $" <color={Dim}>shd</color> {Pct(p.Shield)}");

                        var why = Plugin.Cfg.ShowCapture.Value ? CaptureLine(p) : null;
                        if (why != null) sb.Append($"  <color={Dim}>|</color> ").Append(why);
                        sb.Append("\n");
                    }
                }
                else if (Plugin.Cfg.ShowCapture.Value && !p.Boardable)
                {
                    // Status line off: the reason gets its own line, since it is the only thing left to say.
                    var why = CaptureLine(p);
                    if (why != null) sb.Append("   ").Append(why).Append("\n");
                }
            }
            _body.text = sb.ToString();

            // The panel is as tall as what it holds. A fixed height either clips the list or leaves a hole.
            var height = Mathf.Clamp(_body.preferredHeight + head + 22f, 70f, 620f);
            _rect.sizeDelta = new Vector2(Width, height);
        }

        // ONLY THE NEGATIVE IS WORTH A LINE, which is the player's own conclusion after seeing every other version of
        // this: "the only thing that MIGHT be useful is an indication that an enemy cannot be made boardable". That
        // is the one capture fact that changes behaviour, because it stops someone grinding a hull to 1% for a
        // capture the game will never allow. "It can be captured" changes nothing, so it says nothing, and BOARDABLE
        // speaks for itself on the status line.
        private static string CaptureLine(Prospect p)
        {
            if (p.Boardable || p.CanTake) return null;
            return $"<color={Dim}>cannot be captured: {p.WhyNot}</color>";
        }

        // Percent written by hand rather than through "P0": that format is CULTURE-dependent and on this machine
        // it produced "100 %" with a non-breaking space, which rendered as a bare "100". A readout that drops its
        // unit is a readout a player has to guess at.
        private static string Pct(float f)
        {
            var tint = f > 0.6f ? "#7fe08a" : f > 0.25f ? "#f0b84a" : "#e08a8a";
            return $"<color={tint}>{Fmt.Pct(f)}</color>";
        }

        private static Vector2? PlayerPosition()
        {
            try
            {
                var ship = Source.Player.GamePlayer.current?.currentSpaceShip;
                var unit = ship == null ? null : ship.unit;
                return unit == null ? (Vector2?)null : (Vector2)unit.transform.position;
            }
            catch { return null; }
        }

        // ---- construction -------------------------------------------------------------------------------

        private static bool Build()
        {
            try
            {
                var template = FindLabel();
                if (template == null)
                {
                    if (!_warned)
                    {
                        _warned = true;
                        Plugin.Log.LogWarning("no game text label to clone a font from, so the panel cannot be "
                                              + "drawn. The settings tab still shows the same list.");
                    }
                    return false;
                }

                _root = new GameObject("CicWatchPanel");
                UnityEngine.Object.DontDestroyOnLoad(_root);

                var canvas = _root.AddComponent<Canvas>();
                canvas.renderMode = RenderMode.ScreenSpaceOverlay;
                // Above the game's HUD, which sits at 0: a readout the player asked for should not end up behind a
                // panel they did not.
                canvas.sortingOrder = 200;
                var scaler = _root.AddComponent<CanvasScaler>();
                scaler.uiScaleMode = CanvasScaler.ScaleMode.ConstantPixelSize;
                _root.AddComponent<GraphicRaycaster>();

                var window = new GameObject("Window");
                window.transform.SetParent(_root.transform, false);
                _rect = window.AddComponent<RectTransform>();
                _rect.anchorMin = _rect.anchorMax = new Vector2(0f, 1f);   // top-left, so saved positions are stable
                _rect.pivot = new Vector2(0f, 1f);
                _rect.sizeDelta = new Vector2(Width, 120f);
                _rect.anchoredPosition = LoadPosition();

                var bg = window.AddComponent<Image>();
                bg.color = new Color(0.06f, 0.07f, 0.09f, 0.88f);
                bg.raycastTarget = true;                                    // the whole window is the drag handle
                window.AddComponent<Dragger>().Target = _rect;

                _title = Clone(template, window.transform, new Vector2(Pad, -Pad), Width - Pad * 2, 22f);
                _body = Clone(template, window.transform, new Vector2(Pad, -Pad - 24f), Width - Pad * 2, 0f);
                _body.textWrappingMode = TextWrappingModes.NoWrap;

                _root.SetActive(false);
                Plugin.Log.LogInfo("panel built");
                return true;
            }
            catch (Exception e)
            {
                Plugin.Log.LogWarning($"panel could not be built: {e.Message}");
                _root = null;
                return false;
            }
        }

        // The font comes from the GAME's own label, cloned: a mod that ships no font and picks no built-in one
        // cannot end up with the wrong glyphs or a missing material.
        private static TMP_Text FindLabel()
        {
            var all = UnityEngine.Object.FindObjectsByType<TMP_Text>();
            foreach (var t in all)
                if (t != null && t.font != null) return t;
            return null;
        }

        private static TMP_Text Clone(TMP_Text template, Transform parent, Vector2 at, float width, float height)
        {
            var go = new GameObject("Text");
            go.transform.SetParent(parent, false);
            var rt = go.AddComponent<RectTransform>();
            rt.anchorMin = rt.anchorMax = new Vector2(0f, 1f);
            rt.pivot = new Vector2(0f, 1f);
            rt.anchoredPosition = at;
            rt.sizeDelta = new Vector2(width, height);

            var text = go.AddComponent<TextMeshProUGUI>();
            text.font = template.font;
            text.fontSharedMaterial = template.fontSharedMaterial;
            text.fontSize = 15f;
            text.color = new Color(0.91f, 0.93f, 0.95f);
            text.richText = true;
            text.raycastTarget = false;      // clicks belong to the window, so dragging works anywhere on it
            text.alignment = TextAlignmentOptions.TopLeft;
            text.text = "";
            return text;
        }

        // ---- position, remembered ----------------------------------------------------------------------

        private static Vector2 LoadPosition()
        {
            try
            {
                var raw = Plugin.Cfg.PanelRect.Value;
                if (!string.IsNullOrEmpty(raw))
                {
                    var parts = raw.Split(',');
                    if (parts.Length >= 2
                        && float.TryParse(parts[0], out var x) && float.TryParse(parts[1], out var y))
                        return new Vector2(x, y);
                }
            }
            catch { }
            return new Vector2(24f, -120f);
        }

        internal static void SavePosition()
        {
            try
            {
                if (_rect == null || Plugin.Cfg == null) return;
                var p = _rect.anchoredPosition;
                Plugin.Cfg.PanelRect.Value = $"{p.x:0},{p.y:0}";
            }
            catch { }
        }
    }

    // Drag on Unity's own interface, NOT the game's DraggableWindowBar: that one wants an IDraggableWindow
    // implementation (a compiled game typeref this mod must not take) plus prefab-serialised colours and child
    // handles, so attaching it to a mod-built object yields null wiring and an exception inside game code.
    internal sealed class Dragger : MonoBehaviour, IBeginDragHandler, IDragHandler, IEndDragHandler
    {
        internal RectTransform Target;

        public void OnBeginDrag(PointerEventData e) { }

        public void OnDrag(PointerEventData e)
        {
            if (Target == null) return;
            Target.anchoredPosition += e.delta;
        }

        // Written on release rather than on every frame of the drag: the config file is on disk.
        public void OnEndDrag(PointerEventData e) { Panel.SavePosition(); }
    }
}
