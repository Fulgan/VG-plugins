using System;
using System.Collections.Generic;
using System.IO;
using System.Text;
using BepInEx;
using BepInEx.Configuration;
using Source.Player;

namespace StationAssistant
{
    // Per-playthrough gameplay settings. The game exposes no stable playthrough id, so we key on the
    // commander's identity (set at new-game, stable across that playthrough's save files). Gameplay
    // ConfigEntries (Plugin.Cfg.Gameplay) are swapped in/out per playthrough; UI keybinds stay global.
    // A new playthrough (no profile file yet) starts from plugin defaults; the in-game window can copy
    // another pilot's profile into the active one. Poll() detects the active playthrough each frame.
    internal static class GameSettings
    {
        private static string _active; // active playthrough key, null on the main menu
        private static bool _loading;  // suppress saves while applying a profile

        // Subscribe to persist immediately whenever a gameplay setting changes.
        internal static void Init(ConfigFile file)
        {
            file.SettingChanged += (_, args) =>
            {
                if (Plugin.Cfg.Gameplay.Contains(args.ChangedSetting))
                    OnChanged();
            };
        }

        private static void OnChanged()
        {
            if (!_loading && _active != null)
                Save();
        }

        private static string Dir => Path.Combine(Paths.ConfigPath, "StationAssistant");
        private static string FileFor(string key) => Path.Combine(Dir, key + ".cfg");

        // v1 (pre per-pilot) config: every setting lived in this one global BepInEx file.
        private static string LegacyCfg => Path.Combine(Paths.ConfigPath, Plugin.Guid + ".cfg");

        // Stable-ish per-playthrough key from the commander + starter choices. Read by reflection so
        // there's no compile-time crew typeref: the crew type is named differently across game versions
        // (Commander vs Captain), and a hard reference makes this method fail to JIT on the version that
        // lacks it — which runs every frame from Poll().
        private static object Member(object o, string name)
        {
            if (o == null) return null;
            var t = o.GetType();
            var p = t.GetProperty(name); if (p != null) return p.GetValue(o);
            var f = t.GetField(name); return f?.GetValue(o);
        }
        internal static string KeyFor(GamePlayer p)
        {
            if (p == null) return null;
            var c = Member(p, "commander") ?? Member(p, "captain");
            if (c == null) return null;
            return Sanitize($"{Member(c, "firstName")}_{Member(c, "lastName")}_{Member(c, "callsign")}_{Member(p, "starterSpaceshipName")}_{Member(p, "starterSpecialization")}");
        }

        // Called every frame from Plugin.Update. Switches profile when the playthrough changes.
        internal static void Poll()
        {
            try
            {
                var p = GamePlayer.current;
                if (p == null)
                {
                    if (_active != null) { Save(); _active = null; } // back to menu — persist current
                    return;
                }
                var key = KeyFor(p);
                if (key != null && key != _active)
                    SwitchTo(key);
            }
            catch (Exception ex) { Plugin.Log.LogWarning($"settings poll failed: {ex.Message}"); }
        }

        private static void SwitchTo(string key)
        {
            Save();          // persist outgoing playthrough
            _active = key;
            Load(key);       // apply incoming (or plugin defaults for a new playthrough)
            Plugin.Log.LogInfo($"Station Assistant settings profile: {key}");
        }

        // Persist the active playthrough's gameplay settings.
        internal static void Save()
        {
            if (_active == null)
                return;
            try
            {
                Directory.CreateDirectory(Dir);
                var sb = new StringBuilder();
                foreach (var e in Plugin.Cfg.Gameplay)
                    sb.Append(e.Definition.Section).Append('/').Append(e.Definition.Key)
                      .Append('\t').Append(e.GetSerializedValue()).Append('\n');
                File.WriteAllText(FileFor(_active), sb.ToString());
                Plugin.Log.LogInfo($"Station Assistant: saved profile '{_active}'");
            }
            catch (Exception ex) { Plugin.Log.LogWarning($"settings save failed: {ex.Message}"); }
        }

        private static void Load(string key)
        {
            _loading = true;
            try
            {
                var file = FileFor(key);
                if (File.Exists(file))
                    ApplyFile(file);              // this pilot already has a saved profile
                else if (!TryMigrateLegacy(key))  // first load after a v1 upgrade? adopt the old global cfg
                    ResetToDefaults();            // otherwise a brand-new pilot: clean slate from defaults
                Plugin.Cfg.ReloadDerived();
                Plugin.Window?.OnProfileChanged();
            }
            catch (Exception ex) { Plugin.Log.LogWarning($"settings load failed: {ex.Message}"); }
            finally { _loading = false; }
        }

        // Overlay a profile file's values onto the live gameplay entries. Keys absent from the file
        // keep their current value; a full profile written by Save() contains every gameplay key.
        private static void ApplyFile(string file)
        {
            var map = new Dictionary<string, string>();
            foreach (var line in File.ReadAllLines(file))
            {
                var t = line.IndexOf('\t');
                if (t > 0) map[line.Substring(0, t)] = line.Substring(t + 1);
            }
            foreach (var e in Plugin.Cfg.Gameplay)
            {
                var k = e.Definition.Section + "/" + e.Definition.Key;
                if (map.TryGetValue(k, out var v))
                    try { e.SetSerializedValue(v); } catch { /* keep current on parse error */ }
            }
        }

        private static void ResetToDefaults()
        {
            foreach (var e in Plugin.Cfg.Gameplay)
                e.BoxedValue = e.DefaultValue;
        }

        // One-time v1 -> per-pilot migration. Before per-pilot profiles existed, all settings lived in
        // the single global BepInEx cfg. On the first game load after upgrading — legacy cfg present and
        // no profiles saved yet — adopt those v1 values (already loaded into the live entries by BepInEx)
        // as the active pilot's profile, then remove the legacy file. Returns true if it migrated, so the
        // caller keeps the live v1 values instead of resetting to defaults.
        private static bool TryMigrateLegacy(string key)
        {
            try
            {
                if (!File.Exists(LegacyCfg))
                    return false; // fresh install, no v1 settings to carry over
                if (Directory.Exists(Dir) && Directory.GetFiles(Dir, "*.cfg").Length > 0)
                    return false; // profiles already exist — not a first-time upgrade

                Save(); // persist the live (v1) values into this pilot's profile
                try { File.Delete(LegacyCfg); } catch { /* best-effort; BepInEx may recreate it, but the profile now exists so this never re-runs */ }
                Plugin.Log.LogInfo($"Station Assistant: migrated v1 settings into profile '{key}'.");
                return true;
            }
            catch (Exception ex)
            {
                Plugin.Log.LogWarning($"v1 migration failed: {ex.Message}");
                return false;
            }
        }

        // Active pilot's profile key, null on the main menu.
        internal static string ActiveKey => _active;

        // Saved profiles other than the active pilot's — feeds the copy-from-pilot UI.
        internal static List<string> OtherProfiles()
        {
            var list = new List<string>();
            try
            {
                if (Directory.Exists(Dir))
                    foreach (var f in Directory.GetFiles(Dir, "*.cfg"))
                    {
                        var k = Path.GetFileNameWithoutExtension(f);
                        if (k != _active) list.Add(k);
                    }
                list.Sort(StringComparer.OrdinalIgnoreCase);
            }
            catch (Exception ex) { Plugin.Log.LogWarning($"profile list failed: {ex.Message}"); }
            return list;
        }

        // Copy another pilot's saved profile into the active pilot's settings, then persist.
        internal static void CopyFrom(string sourceKey)
        {
            if (_active == null || sourceKey == null || sourceKey == _active)
                return;
            try
            {
                var file = FileFor(sourceKey);
                if (!File.Exists(file))
                    return;
                _loading = true;
                try
                {
                    ApplyFile(file);
                    Plugin.Cfg.ReloadDerived();
                    Plugin.Window?.OnProfileChanged();
                }
                finally { _loading = false; }
                Save(); // write the copied values into the active pilot's profile
                Plugin.Log.LogInfo($"Station Assistant: copied profile '{sourceKey}' -> '{_active}'");
            }
            catch (Exception ex) { Plugin.Log.LogWarning($"settings copy failed: {ex.Message}"); }
        }

        private static string Sanitize(string s)
        {
            foreach (var c in Path.GetInvalidFileNameChars())
                s = s.Replace(c, '_');
            return string.IsNullOrEmpty(s) ? "default" : s;
        }
    }
}
