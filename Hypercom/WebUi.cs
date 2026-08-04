using System;
using System.Collections.Generic;
using System.Reflection;

namespace Hypercom
{
    // The web UI lives INSIDE this assembly as manifest resources: one file to install, and the bundle served
    // can never be a different build from the code serving it. Nothing here touches the filesystem — a request
    // path is a dictionary key, so there is no directory to escape from and no stale asset to find.
    internal static class WebUi
    {
        // Every embedded file is named "ui/<path>". MSBuild writes RecursiveDir with the platform separator, so
        // names are normalised to '/' here rather than assumed uniform.
        private const string Prefix = "ui/";

        private static Dictionary<string, string> _byPath;

        // Request path (no leading slash) -> resource name.
        private static Dictionary<string, string> ByPath
        {
            get
            {
                if (_byPath != null) return _byPath;
                var map = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
                try
                {
                    foreach (var name in Assembly.GetExecutingAssembly().GetManifestResourceNames())
                    {
                        var norm = name.Replace('\\', '/');
                        if (norm.StartsWith(Prefix, StringComparison.OrdinalIgnoreCase))
                            map[norm.Substring(Prefix.Length)] = name;
                    }
                }
                catch (Exception ex) { Plugin.Log.LogWarning($"web UI resources unreadable: {ex.Message}"); }
                return _byPath = map;
            }
        }

        // A UI is embedded on Release builds only. A Debug build skips the Vite step, so nothing is embedded and
        // the browser must be pointed at `npm run dev` instead.
        internal static bool Bundled => ByPath.ContainsKey("index.html");

        /// <summary>The bytes of one embedded file, or null when this build embeds no such path.</summary>
        internal static byte[] Read(string relPath)
        {
            if (string.IsNullOrEmpty(relPath)) return null;
            if (!ByPath.TryGetValue(relPath.Replace('\\', '/'), out var resource)) return null;
            try
            {
                using (var s = Assembly.GetExecutingAssembly().GetManifestResourceStream(resource))
                {
                    if (s == null) return null;
                    var buf = new byte[s.Length];
                    // A resource stream is free to return short reads; a partially filled buffer would be served
                    // as a truncated file with a correct Content-Length, which no client can detect.
                    var got = 0;
                    while (got < buf.Length)
                    {
                        var n = s.Read(buf, got, buf.Length - got);
                        if (n <= 0) break;
                        got += n;
                    }
                    if (got == buf.Length) return buf;
                    Plugin.Log.LogWarning($"web UI resource {relPath} read short ({got}/{buf.Length} bytes)");
                    return null;
                }
            }
            catch (Exception ex)
            {
                Plugin.Log.LogWarning($"web UI resource {relPath} unreadable: {ex.Message}");
                return null;
            }
        }
    }
}
