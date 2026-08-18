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
namespace VG.ModApi
{
    // Entry point: the one shared settings window + hotkey manager. Call from Awake.
    internal static class VGModSettings
    {
        // 1: tabs, hotkeys, game gate.  2: RegisterUpdateRow.
        internal const int Version = 2;
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
        private readonly MethodInfo _regTab, _regKey, _setKey, _open, _close, _toggle, _setGate, _setUngated, _regUpdate;

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

        private void OnGUI()
        {
            if (!_open || _tabs.Count == 0) return;
            GUI.skin.label.richText = true;
            GUI.skin.button.richText = true;
            _rect.height = 0f;
            _rect = GUILayout.Window(WindowId, _rect, DrawWindow, "Mod Settings");
        }

        private static bool IsVisible(TabEntry t)
        {
            if (t.Visible == null) return true;
            try { return t.Visible(); } catch { return false; }
        }

        private void DrawWindow(int id)
        {
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

        // The standing readout: what is installed, what is published, and a way to go read about it. Nothing on
        // this tab downloads or installs anything: the button opens a page in the player's browser.
        private void DrawUpdatesTab()
        {
            GUILayout.Label("Version check only: nothing is downloaded or installed.");
            GUILayout.Space(4f);

            foreach (var u in _updates)
            {
                string status, url;
                // A getter reaching into a half-finished check must cost this row, not the tab.
                try { status = u.Status(); } catch { status = "unavailable"; }
                try { url = u.Url != null ? u.Url() : null; } catch { url = null; }

                GUILayout.BeginHorizontal();
                GUILayout.Label(u.Mod, GUILayout.Width(160f));
                GUILayout.Label(status ?? "", GUILayout.Width(200f));
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
