using System;
using System.Collections.Generic;
using System.IO;
using System.Reflection;
using UnityEngine;

// Shared SOURCE (not a shared DLL) compiled into every VG mod via:
//   <Compile Include="..\Shared\ModHost.cs" Link="ModHost.cs" />
// Each mod therefore ships as one self-contained assembly: nothing extra to deploy. Because each mod
// has its own compiled copy of these types, cross-mod calls go through a reflection forwarder (Handle)
// that only passes FRAMEWORK types (string / Action / Func<KeyCode> / KeyCode / int). Differing copies
// or versions never break casts: the first mod to load creates the host; the rest drive it by method
// name and feature-check (a missing method is simply skipped).
//
// ⚠ ONE DEPENDENCY, AND IT IS ENFORCED BY NOTHING BUT THIS LINE: the Updates tab splits a row on
// `VG.Core.Updater.Separator`, so any csproj that compiles this file must also compile `Shared/Updater.cs`. All
// four mods do today. A new mod that takes the window and not the update feature will fail to compile until it
// adds that one Compile line, which is a better failure than the tab silently drawing one wrong column.
namespace VG.ModApi
{
    // Entry point: the one shared settings window + hotkey manager. Call from Awake.
    internal static class VGModSettings
    {
        // 1: tabs, hotkeys, game gate.  2: RegisterUpdateRow.  3: RegisterUpdateCheck (the check is a button now).
        internal const int Version = 3;
        private const string HostObjectName = "VGModSettings";
        private static Handle _cached;

        internal static Handle GetOrCreate()
        {
            if (_cached != null) return _cached;

            var go = GameObject.Find(HostObjectName);
            Component host;
            if (go == null)
            {
                go = new GameObject(HostObjectName);
                UnityEngine.Object.DontDestroyOnLoad(go);
                host = go.AddComponent<VGModSettingsHost>(); // we're first: our copy runs
            }
            else
            {
                host = FindHost(go) ?? go.AddComponent<VGModSettingsHost>();
            }
            _cached = new Handle(host);
            return _cached;
        }

        private static Component FindHost(GameObject go)
        {
            foreach (var c in go.GetComponents<Component>())
                if (c != null && c.GetType().Name == nameof(VGModSettingsHost))
                    return c; // may be another mod's compiled copy: that's fine, Handle reflects into it
            return null;
        }
    }

    // Forwards to the live host: a direct call when it's our own compiled type, else reflection over
    // framework-typed args (so a host created by a different mod's copy is driven safely).
    internal sealed class Handle
    {
        private readonly object _host;
        private readonly VGModSettingsHost _native;
        private readonly MethodInfo _regTab, _regKey, _setKey, _open, _close, _toggle, _setGate, _setUngated, _regUpdate, _regCheck;

        private const BindingFlags Flags = BindingFlags.Instance | BindingFlags.Public | BindingFlags.NonPublic;

        internal Handle(object host)
        {
            _host = host;
            _native = host as VGModSettingsHost;
            if (_native == null)
            {
                var t = host.GetType();
                _regTab = t.GetMethod("RegisterTab", Flags);
                _regKey = t.GetMethod("RegisterHotkey", Flags);
                _setKey = t.GetMethod("SetToggleKey", Flags);
                _open = t.GetMethod("Open", Flags);
                _close = t.GetMethod("Close", Flags);
                _toggle = t.GetMethod("Toggle", Flags);
                _setGate = t.GetMethod("SetGameGate", Flags);
                _setUngated = t.GetMethod("SetHotkeyUngated", Flags);
                _regUpdate = t.GetMethod("RegisterUpdateRow", Flags);
                _regCheck = t.GetMethod("RegisterUpdateCheck", Flags);
            }
        }

        internal bool RegisterTab(string title, Action draw, int order = 0, Func<bool> visible = null)
        {
            if (_native != null) return _native.RegisterTab(title, draw, order, visible);
            try { return _regTab?.Invoke(_host, new object[] { title, draw, order, visible }) is bool b && b; }
            catch { return false; }
        }

        internal void RegisterHotkey(string id, string label, Func<KeyCode> get, Action<KeyCode> set, Action onPressed)
        {
            if (_native != null) { _native.RegisterHotkey(id, label, get, set, onPressed); return; }
            try { _regKey?.Invoke(_host, new object[] { id, label, get, set, onPressed }); } catch { /* older host lacks it */ }
        }

        internal void SetToggleKey(KeyCode key)
        {
            if (_native != null) { _native.SetToggleKey(key); return; }
            try { _setKey?.Invoke(_host, new object[] { key }); } catch { }
        }

        // Every mod passes the same answer (`VG.Game.GameState.Loaded`), so whichever sets it last is setting
        // it to what the others would have. An older host lacks the method and simply stays ungated.
        internal void SetGameGate(Func<bool> gameLoaded)
        {
            if (_native != null) { _native.SetGameGate(gameLoaded); return; }
            try { _setGate?.Invoke(_host, new object[] { gameLoaded }); } catch { }
        }

        internal void SetHotkeyUngated(string id)
        {
            if (_native != null) { _native.SetHotkeyUngated(id); return; }
            try { _setUngated?.Invoke(_host, new object[] { id }); } catch { }
        }

        // One row on the host's single "Updates" tab. Three mods installed must not mean three tabs, which is
        // only achievable at the host, so each mod contributes its own line and the host owns the tab.
        //
        // `status` and `url` are read at DRAW time rather than passed as values: the check that fills them
        // finishes on a worker thread long after Awake, and a host older than this method simply has no tab.
        internal void RegisterUpdateRow(string modName, Func<string> status, Func<string> url)
        {
            if (_native != null) { _native.RegisterUpdateRow(modName, status, url); return; }
            try { _regUpdate?.Invoke(_host, new object[] { modName, status, url }); } catch { /* older host lacks it */ }
        }

        /// <summary>
        /// The action the host's one "Check now" button runs for this mod.
        ///
        /// A SEPARATE METHOD rather than a fourth argument to <see cref="RegisterUpdateRow"/>: the forwarder finds
        /// methods by NAME, so adding an overload would make that lookup ambiguous and break every host it reflects
        /// into. An older host lacks this one and simply gets no button, which is the honest degradation now that
        /// there is no unattended check to fall back on.
        /// </summary>
        internal void RegisterUpdateCheck(string modName, Action check)
        {
            if (_native != null) { _native.RegisterUpdateCheck(modName, check); return; }
            try { _regCheck?.Invoke(_host, new object[] { modName, check }); } catch { /* older host lacks it */ }
        }

        internal void Open() { if (_native != null) _native.Open(); else try { _open?.Invoke(_host, null); } catch { } }
        internal void Close() { if (_native != null) _native.Close(); else try { _close?.Invoke(_host, null); } catch { } }
        internal void Toggle() { if (_native != null) _native.Toggle(); else try { _toggle?.Invoke(_host, null); } catch { } }
    }

    // The neutral window + hotkey host. Only the creating mod's compiled copy actually runs.
    internal sealed class VGModSettingsHost : MonoBehaviour
    {
        private sealed class TabEntry { public string Title; public Action Draw; public int Order; public Func<bool> Visible; }
        private sealed class HotkeyEntry { public string Id; public string Label; public Func<KeyCode> Get; public Action<KeyCode> Set; public Action OnPressed; public bool Ungated; }
        private sealed class UpdateEntry { public string Mod; public Func<string> Status; public Func<string> Url; }

        private readonly List<TabEntry> _tabs = new List<TabEntry>();
        private readonly List<HotkeyEntry> _keys = new List<HotkeyEntry>();
        private readonly List<UpdateEntry> _updates = new List<UpdateEntry>();
        private string _activeTitle; // active tab tracked by title (the visible set can change)
        private bool _open;
        private string _rebinding; // hotkey id currently capturing a new key, null otherwise
        private Rect _rect = new Rect(60f, 60f, 440f, 0f);
        private const int WindowId = 0x5647_4D53; // "VGMS"

        private KeyCode _toggle = KeyCode.F7;
        private static string TogglePath => Path.Combine(Application.persistentDataPath, "vg-modsettings-toggle.txt");


        // "Is a game loaded": supplied by a mod, because the host is game-neutral and holds no game reference.
        // Null until a mod sets it, and null means ungated: a host older than this feature behaves as before.
        private Func<bool> _gameLoaded;

        private void Awake()
        {
            try { if (File.Exists(TogglePath) && Enum.TryParse(File.ReadAllText(TogglePath).Trim(), out KeyCode k)) _toggle = k; }
            catch { /* default F7 */ }

            RegisterTab("Hotkeys", DrawHotkeysTab, int.MaxValue); // always last
            RegisterHotkey("vg.modsettings.toggle", "Open settings", () => _toggle, SetToggleKey, Toggle);
            // The window itself is not a game action: it must open at the main menu, or a key cannot be rebound
            // without loading a save first.
            SetHotkeyUngated("vg.modsettings.toggle");
        }

        internal bool RegisterTab(string title, Action draw, int order = 0, Func<bool> visible = null)
        {
            if (string.IsNullOrEmpty(title) || draw == null) return false;
            _tabs.Add(new TabEntry { Title = title, Draw = draw, Order = order, Visible = visible });
            _tabs.Sort((a, b) => a.Order != b.Order ? a.Order.CompareTo(b.Order) : string.CompareOrdinal(a.Title, b.Title));
            return true;
        }

        internal void RegisterHotkey(string id, string label, Func<KeyCode> get, Action<KeyCode> set, Action onPressed)
        {
            if (string.IsNullOrEmpty(id) || get == null) return;
            _keys.RemoveAll(h => h.Id == id);
            _keys.Add(new HotkeyEntry { Id = id, Label = label ?? id, Get = get, Set = set, OnPressed = onPressed });
        }

        internal void SetGameGate(Func<bool> gameLoaded) => _gameLoaded = gameLoaded;

        // One line per mod on ONE tab, registered on first use so a host whose mods know nothing about updates
        // grows no empty tab. Re-registering the same mod replaces its row rather than doubling it.
        internal void RegisterUpdateRow(string modName, Func<string> status, Func<string> url)
        {
            if (string.IsNullOrEmpty(modName) || status == null) return;
            if (_updates.Count == 0) RegisterTab("Updates", DrawUpdatesTab, int.MaxValue - 1); // just before Hotkeys
            _updates.RemoveAll(u => u.Mod == modName);
            _updates.Add(new UpdateEntry { Mod = modName, Status = status, Url = url });
            _updates.Sort((a, b) => string.CompareOrdinal(a.Mod, b.Mod));
        }

        // Exempt one hotkey from the game gate. For a key whose whole job is to reach a state where no game is
        // loaded (quick LOAD, or opening this window), being ignored there would remove the feature.
        internal void SetHotkeyUngated(string id)
        {
            var h = _keys.Find(x => x.Id == id);
            if (h != null) h.Ungated = true;
        }

        internal void SetToggleKey(KeyCode key)
        {
            _toggle = key;
            try { File.WriteAllText(TogglePath, key.ToString()); } catch { /* non-fatal */ }
        }

        internal void Open() => _open = true;
        internal void Close() => _open = false;
        internal void Toggle() => _open = !_open;

        private void Update()
        {
            if (_rebinding != null)
            {
                if (Input.GetKeyDown(KeyCode.Escape)) { _rebinding = null; return; }
                foreach (KeyCode k in Enum.GetValues(typeof(KeyCode)))
                {
                    if (k == KeyCode.None || !Input.GetKeyDown(k)) continue;
                    _keys.Find(x => x.Id == _rebinding)?.Set?.Invoke(k);
                    _rebinding = null;
                    break;
                }
                return; // don't fire actions mid-rebind
            }

            // With no game loaded there is nothing for an action to act on and nothing to persist a setting
            // into, so a press is DROPPED: silently, because the player pressing at a menu is not making a
            // mistake worth a message. Rebinding above is unaffected: it changes no game state.
            var gated = _gameLoaded != null && !_gameLoaded();

            foreach (var h in _keys)
            {
                if (h.OnPressed == null) continue;
                if (gated && !h.Ungated) continue;
                var k = h.Get();
                if (k != KeyCode.None && Input.GetKeyDown(k))
                {
                    try { h.OnPressed(); }
                    catch (Exception ex) { Debug.LogWarning($"[VGModSettings] hotkey '{h.Id}' failed: {ex.Message}"); }
                }
            }
        }

        // THE WINDOW OWNS BOTH HALVES OF THE CONTRAST PAIR, and until it did every tab had to guess at one of them.
        //
        // A colour tag only sets the INK. What that ink sits on is whatever skin the game installed, and this one is
        // a mid grey: on it, the game's own rarity blue and purple are unreadable, and so is any grey a tab picks
        // for secondary text. CIC Watch worked around it by painting its own near-black panel; doing that per tab
        // means every tab has the same bug until someone notices it there too, so the HOST paints it once and every
        // tab inherits a known background.
        //
        // ⚠ SET, DRAW, RESTORE. `GUI.skin` is global and shared with the game's own IMGUI, so these are put back
        // immediately after the window is drawn rather than left mutated — a permanently re-tinted label style
        // would follow the game into every other OnGUI pass.
        private static Texture2D _panelTex;
        private static readonly Color Ink = new Color(0.91f, 0.93f, 0.95f);

        private static Texture2D PanelTexture()
        {
            if (_panelTex != null) return _panelTex;
            _panelTex = new Texture2D(1, 1);
            _panelTex.SetPixel(0, 0, new Color(0.09f, 0.10f, 0.12f, 0.96f));
            _panelTex.Apply();
            // Not collected between frames: a texture built per OnGUI would allocate every frame and then vanish.
            UnityEngine.Object.DontDestroyOnLoad(_panelTex);
            _panelTex.hideFlags = HideFlags.HideAndDontSave;
            return _panelTex;
        }

        private void OnGUI()
        {
            if (!_open || _tabs.Count == 0) return;
            GUI.skin.label.richText = true;
            GUI.skin.button.richText = true;

            // ⚠ EVERY STATE, ⊥ JUST `normal`. Setting `normal` alone changed nothing on screen, because a GUIStyle
            // has eight of them and Unity picks by state: a window that is FOCUSED — which ours is, the moment it
            // is open — draws `onNormal`, so the one state being set was the one never used. The button on the
            // Updates tab changed in the same build, which is what proved the code was running and the target was
            // wrong.
            var tex = PanelTexture();
            var win = Save(GUI.skin.window);
            var box = Save(GUI.skin.box);
            var lab = Save(GUI.skin.label);
            Paint(GUI.skin.window, tex, Ink);
            Paint(GUI.skin.box, tex, Ink);
            Paint(GUI.skin.label, null, Ink);
            try
            {
                _rect.height = 0f;
                _rect = GUILayout.Window(WindowId, _rect, DrawWindow, "Mod Settings");
            }
            finally
            {
                // Restored because `GUI.skin` is global and shared with the game's own IMGUI: a permanently
                // re-tinted style would follow the game into every other OnGUI pass.
                Restore(GUI.skin.window, win);
                Restore(GUI.skin.box, box);
                Restore(GUI.skin.label, lab);
            }

            if (!_describedSkin)
            {
                _describedSkin = true;
                // WHAT WE ACTUALLY PAINTED, once. Three attempts at this contrast were guesses about a skin nobody
                // had measured; a line in the log turns "still grey on grey" into something checkable.
                Debug.Log($"[VGModSettings] panel painted: tex={(tex != null ? tex.width + "x" + tex.height : "null")}"
                          + $", window.onNormal.bg={(GUI.skin.window.onNormal.background != null ? "set" : "none")}"
                          + $", label ink was {lab[0].textColor}");
            }
        }

        private static bool _describedSkin;

        // The eight states a GUIStyle draws from. Unity chooses among them by control state, and a control that is
        // active, hovered, focused or "on" reads a different one than `normal` — so a paint that misses any of them
        // is a paint that sometimes does nothing.
        private static GUIStyleState[] States(GUIStyle s)
        {
            return new[] { s.normal, s.hover, s.active, s.focused, s.onNormal, s.onHover, s.onActive, s.onFocused };
        }

        private static GUIStyleState[] Save(GUIStyle s)
        {
            var src = States(s);
            var copy = new GUIStyleState[src.Length];
            for (var i = 0; i < src.Length; i++)
                copy[i] = new GUIStyleState { background = src[i].background, textColor = src[i].textColor };
            return copy;
        }

        private static void Paint(GUIStyle s, Texture2D bg, Color ink)
        {
            foreach (var st in States(s))
            {
                if (bg != null) st.background = bg;
                st.textColor = ink;
            }
        }

        private static void Restore(GUIStyle s, GUIStyleState[] saved)
        {
            var live = States(s);
            for (var i = 0; i < live.Length && i < saved.Length; i++)
            {
                live[i].background = saved[i].background;
                live[i].textColor = saved[i].textColor;
            }
        }

        private static bool IsVisible(TabEntry t)
        {
            if (t.Visible == null) return true;
            try { return t.Visible(); } catch { return false; }
        }

        private void DrawWindow(int id)
        {
            // THE BACKGROUND, PAINTED RATHER THAN CONFIGURED. Setting it on the window's GUIStyle depends on which
            // of the style's eight states Unity resolves for a focused window, which is exactly the kind of guess
            // that already failed twice here. Drawing the texture FIRST cannot miss: everything the tabs draw after
            // this lands on top of it, and the GUI clip stack trims the rect to the window, which is why the
            // oversized rect is the idiom `GUI.DragWindow` below already uses.
            GUI.DrawTexture(new Rect(0f, 0f, 10000f, 10000f), PanelTexture());

            var vis = new List<TabEntry>();
            foreach (var t in _tabs)
                if (IsVisible(t)) vis.Add(t);

            if (vis.Count > 0)
            {
                var active = vis.FindIndex(t => t.Title == _activeTitle);
                if (active < 0) active = 0;

                GUILayout.Space(2f);
                GUILayout.BeginHorizontal();
                for (var i = 0; i < vis.Count; i++)
                    if (GUILayout.Toggle(active == i, vis[i].Title, GUI.skin.button) && active != i)
                        active = i;
                GUILayout.EndHorizontal();
                _activeTitle = vis[active].Title;
                GUILayout.Space(4f);

                try { vis[active].Draw(); }
                catch (Exception ex)
                {
                    GUILayout.Label("<i>tab error (see log)</i>");
                    Debug.LogWarning($"[VGModSettings] tab '{vis[active].Title}' draw failed: {ex.Message}");
                }
            }

            GUILayout.Space(4f);
            if (GUILayout.Button("Close")) _open = false;
            GUI.DragWindow(new Rect(0f, 0f, 10000f, 22f));
        }

        /// <summary>
        /// The action this mod's row runs when the player presses the check button.
        ///
        /// THE CHECK IS A BUTTON, so the host holds actions and not a setting. It was an automatic daily check with
        /// a per-mod `Updates/Enabled`, then briefly a global switch defaulting to off; a button is what both were
        /// reaching for. Nothing leaves the machine unless someone presses it, there is no schedule to reason
        /// about, and there is no state to persist or explain.
        /// </summary>
        internal void RegisterUpdateCheck(string modName, Action check)
        {
            if (string.IsNullOrEmpty(modName) || check == null) return;
            _updateChecks[modName] = check;
        }

        private readonly Dictionary<string, Action> _updateChecks = new Dictionary<string, Action>();

        // The standing readout: what is installed, what is published, and a way to go read about it. Nothing here
        // downloads or installs anything.
        private void DrawUpdatesTab()
        {
            // ONE button for every mod, ⊥ one per row: "is there a newer version" is a question about the install,
            // and asking it four times is four requests for one answer.
            if (_updateChecks.Count > 0)
            {
                if (GUILayout.Button("Check for new versions"))
                {
                    foreach (var kv in _updateChecks)
                    {
                        // One mod's check failing must not cost the others theirs.
                        try { kv.Value(); }
                        catch (Exception ex) { Debug.LogWarning($"[VGModSettings] update check for '{kv.Key}' failed: {ex.Message}"); }
                    }
                }
                GUILayout.Space(4f);
            }

            foreach (var u in _updates)
            {
                string status, url;
                // A getter reaching into a half-finished check must cost this row, not the tab.
                try { status = u.Status(); } catch { status = "unavailable"; }
                try { url = u.Url != null ? u.Url() : null; } catch { url = null; }

                // THREE COLUMNS, ⊥ TWO. Version and state in one 200px label wrapped the longer states onto a
                // second line and left every row a different height. Split on `Updater.Separator`, which the same
                // shared code puts there, so the versions line up under each other and the state gets the rest of
                // the row with no fixed width to wrap inside.
                var cut = (status ?? "").IndexOf(Core.Updater.Separator, StringComparison.Ordinal);
                var version = cut > 0 ? status.Substring(0, cut) : status ?? "";
                var state = cut > 0 ? status.Substring(cut + Core.Updater.Separator.Length) : "";

                GUILayout.BeginHorizontal();
                GUILayout.Label(u.Mod, GUILayout.Width(150f));
                GUILayout.Label(version, GUILayout.Width(55f));
                GUILayout.Label(state);
                GUILayout.FlexibleSpace();
                if (!string.IsNullOrEmpty(url) && GUILayout.Button("Release page", GUILayout.MinWidth(110f)))
                    Application.OpenURL(url);
                GUILayout.EndHorizontal();
            }
        }

        private void DrawHotkeysTab()
        {
            GUILayout.Label("Click a key, then press the new one (Esc cancels).");
            GUILayout.Space(4f);

            var counts = new Dictionary<KeyCode, int>();
            foreach (var h in _keys)
            {
                var k = h.Get();
                if (k != KeyCode.None) counts[k] = counts.TryGetValue(k, out var c) ? c + 1 : 1;
            }

            var anyClash = false;
            foreach (var h in _keys)
            {
                var k = h.Get();
                var clash = k != KeyCode.None && counts[k] > 1;
                anyClash |= clash;

                GUILayout.BeginHorizontal();
                GUILayout.Label(clash ? $"<color=#e05050>{h.Label}</color>" : h.Label, GUILayout.Width(220f));
                var capturing = _rebinding == h.Id;
                if (GUILayout.Button(capturing ? "<press a key…>" : k.ToString(), GUILayout.MinWidth(120f)))
                    _rebinding = capturing ? null : h.Id;
                GUILayout.EndHorizontal();
            }

            if (anyClash)
                GUILayout.Label("<color=#e05050>⚠ Highlighted keys are bound more than once.</color>");
        }
    }
}
