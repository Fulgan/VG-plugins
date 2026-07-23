using System.Collections.Generic;
using System.IO;
using BepInEx;

namespace Hypercom
{
    // User-chosen display names for playthroughs, keyed by the stable galaxy fingerprint (see
    // Api.PlaythroughId). Purely cosmetic — the fingerprint stays the real key everywhere (presets,
    // action log). Persisted next to the presets file so it survives restarts and beta/release switches.
    internal static class Playthroughs
    {
        private static readonly object Gate = new object();
        private static Dictionary<string, string> _cache;
        private static string Path => System.IO.Path.Combine(Paths.ConfigPath, "hypercom-playthroughs.json");

        private static Dictionary<string, string> Store()
        {
            if (_cache != null) return _cache;
            _cache = new Dictionary<string, string>();
            try
            {
                if (File.Exists(Path))
                {
                    var root = Json.ParseObject(File.ReadAllText(Path));
                    foreach (var kv in root) if (kv.Value != null) _cache[kv.Key] = kv.Value.ToString();
                }
            }
            catch (System.Exception ex) { Plugin.Log.LogWarning($"playthrough names load failed: {ex.Message}"); }
            return _cache;
        }

        private static void Persist()
        {
            try
            {
                var root = new Dictionary<string, object>();
                foreach (var kv in _cache) root[kv.Key] = kv.Value;
                File.WriteAllText(Path, Json.Write(root));
            }
            catch (System.Exception ex) { Plugin.Log.LogWarning($"playthrough names save failed: {ex.Message}"); }
        }

        // The pretty name for a fingerprint, or null if none set.
        internal static string Name(string fingerprint)
        {
            if (string.IsNullOrEmpty(fingerprint)) return null;
            lock (Gate) return Store().TryGetValue(fingerprint, out var n) && !string.IsNullOrEmpty(n) ? n : null;
        }

        // Set (or clear, when name is empty) the pretty name for a fingerprint.
        internal static void SetName(string fingerprint, string name)
        {
            if (string.IsNullOrEmpty(fingerprint)) return;
            lock (Gate)
            {
                var store = Store();
                if (string.IsNullOrWhiteSpace(name)) store.Remove(fingerprint);
                else store[fingerprint] = name.Trim();
                Persist();
            }
        }
    }
}
