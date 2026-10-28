using System;
using System.Reflection;
using UnityEngine;

namespace VG.Game
{
    /**
     * Which game build a plugin was compiled for, and what to tell the player when the running game is another.
     *
     * Each plugin is compiled against ONE pinned game build (game-pin.props) and stamped with it as assembly
     * metadata. The unit of compatibility is the game LINE, its first three version parts: `0.8.2.1` to `0.8.2.5`
     * share an API, and `0.8.3` is where the game reshapes it. On another line the plugin still starts: most of
     * it usually works, and a member that moved fails only the feature that reads it. The warning names the
     * build to install, so the log explains a feature that does nothing.
     */
    internal static class GameTarget
    {
        internal static string Target => Meta("VG.TargetGame");
        internal static string Channel => Meta("VG.GameChannel");

        /// <summary>
        /// What to log at load about the running game, or null when it is the build this plugin targets.
        /// <paramref name="warning"/> is true on another game line, false for a newer patch of the same one.
        /// </summary>
        internal static string Notice(string mod, out bool warning)
        {
            warning = false;
            var target = Target;
            var running = Application.version;
            if (!TryParse(target, out var t) || !TryParse(running, out var r)) return null;

            var line = Compare(r, t, 3);
            if (line == 0)
                return Compare(r, t, 4) > 0
                    ? $"{mod} was built for game {target} and the game is {running}: same version line, not yet tested on this patch."
                    : null;

            warning = true;
            var built = $"{mod} was built for game {Line(t)} ({Channel} branch) and the game is {running}: some features may not work.";
            return line > 0
                ? built + " Run Update-VGMods.ps1, or wait for a build for this game version."
                : built + " Run Update-VGMods.ps1 to install the build for your game branch.";
        }

        private static string Meta(string key)
        {
            foreach (var a in typeof(GameTarget).Assembly.GetCustomAttributes<AssemblyMetadataAttribute>())
                if (a.Key == key) return a.Value;
            return null;
        }

        private static string Line(int[] v) => $"{v[0]}.{v[1]}.{v[2]}";

        // Missing parts count as 0, so `0.8.2` and `0.8.2.0` are the same build.
        private static int Compare(int[] a, int[] b, int parts)
        {
            for (var i = 0; i < parts; i++)
            {
                var x = i < a.Length ? a[i] : 0;
                var y = i < b.Length ? b[i] : 0;
                if (x != y) return x < y ? -1 : 1;
            }
            return 0;
        }

        private static bool TryParse(string s, out int[] v)
        {
            v = null;
            if (string.IsNullOrEmpty(s)) return false;
            var f = s.Trim().TrimStart('v').Split('.');
            if (f.Length < 3) return false;
            v = new int[f.Length];
            for (var i = 0; i < f.Length; i++)
                if (!int.TryParse(f[i], out v[i])) return false;
            return true;
        }
    }
}
