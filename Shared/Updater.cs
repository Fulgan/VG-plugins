using System;
using System.Collections.Generic;

namespace VG.Core
{
    // Game-free half of update NOTIFICATION: parse the published manifest, compare versions, decide whether a
    // check is due. No network, no Unity, no BepInEx, so it compiles into the headless test project and its
    // rules are pinned by tests rather than reasoned about. The fetch and the plumbing live in UpdateCheck.
    //
    // The whole feature only ever produces TEXT AND A LINK. Nothing here downloads, writes or runs anything, and
    // that is what makes the trust question small enough to answer: the worst a hostile manifest can do is name a
    // version that does not exist, and the link it is shown beside cannot leave the known repository.
    public static class Updater
    {
        // Where the manifest lives, and the only prefix a link in it may carry. Both are COMPILED IN and neither
        // is configurable: a repointable check is a redirect someone can be talked into setting, and the single
        // thing this feature offers a player is that the text came from us.
        public const string ManifestUrl = "https://raw.githubusercontent.com/Fulgan/VG-plugins/main/versions.txt";
        public const string LinkPrefix = "https://github.com/Fulgan/VG-plugins/";

        // A manifest is a few hundred bytes. Anything past this is not one, and is refused before it is parsed
        // rather than after.
        public const int MaxManifestBytes = 64 * 1024;

        public sealed class Entry
        {
            public string Guid;
            public string Version;
            public string Url;
        }

        /// <summary>
        /// The entry for one plugin GUID, or null. Keyed by GUID because a display name is UI text that may be
        /// re-worded, while the GUID is the identity BepInEx already keys on.
        /// </summary>
        public static Entry Find(string manifest, string guid)
        {
            if (string.IsNullOrEmpty(manifest) || string.IsNullOrEmpty(guid)) return null;
            foreach (var e in Parse(manifest))
                if (string.Equals(e.Guid, guid, StringComparison.OrdinalIgnoreCase))
                    return e;   // first wins: a duplicate line further down cannot override one already read
            return null;
        }

        /// <summary>
        /// Every well-formed line, in file order. A line that is malformed, short, over-long or carries a link
        /// outside <see cref="LinkPrefix"/> is DROPPED, not guessed at: a manifest that cannot be read exactly
        /// produces silence, which is the only failure mode that cannot mislead.
        /// </summary>
        public static List<Entry> Parse(string manifest)
        {
            var list = new List<Entry>();
            if (string.IsNullOrEmpty(manifest)) return list;

            foreach (var raw in manifest.Split('\n'))
            {
                var line = raw.Trim();                                  // also strips the \r of CRLF
                if (line.Length == 0 || line[0] == '#') continue;

                var f = line.Split('|');
                if (f.Length != 3) continue;

                var guid = f[0].Trim();
                var ver = f[1].Trim();
                var url = f[2].Trim();
                if (guid.Length == 0 || ver.Length == 0) continue;
                if (!IsVersion(ver)) continue;
                if (!url.StartsWith(LinkPrefix, StringComparison.Ordinal)) continue;

                list.Add(new Entry { Guid = guid, Version = ver, Url = url });
            }
            return list;
        }

        /// <summary>
        /// True only when <paramref name="available"/> is strictly newer than <paramref name="installed"/>.
        /// Unreadable on either side, equal, or older all answer false: a dev build ahead of the mirror is
        /// ordinary here, and there is nothing to tell a player about it.
        /// </summary>
        public static bool IsNewer(string installed, string available)
        {
            int cmp;
            return TryCompare(available, installed, out cmp) && cmp > 0;
        }

        /// <summary>
        /// Component-wise NUMERIC compare of two dotted versions; false when either cannot be read. Numeric
        /// because ordinal string order gets `0.10.0` and `0.9.0` backwards, which is the one comparison a
        /// version scheme is guaranteed to reach eventually.
        /// </summary>
        public static bool TryCompare(string a, string b, out int cmp)
        {
            cmp = 0;
            int[] x, y;
            if (!TryParse(a, out x) || !TryParse(b, out y)) return false;

            var n = Math.Max(x.Length, y.Length);
            for (var i = 0; i < n; i++)
            {
                // A version with fewer components is that version with zeros: 1.2 and 1.2.0 are one release.
                var xi = i < x.Length ? x[i] : 0;
                var yi = i < y.Length ? y[i] : 0;
                if (xi != yi) { cmp = xi < yi ? -1 : 1; return true; }
            }
            return true;
        }

        public static bool IsVersion(string s)
        {
            int[] parts;
            return TryParse(s, out parts);
        }

        // 1 to 4 dot-separated runs of digits, nothing else. A prerelease suffix (`1.2.0-rc1`) is deliberately
        // NOT accepted: ordering it would be a policy, and no release here has ever carried one.
        private static bool TryParse(string s, out int[] parts)
        {
            parts = null;
            if (string.IsNullOrEmpty(s)) return false;

            var f = s.Split('.');
            if (f.Length < 1 || f.Length > 4) return false;

            var n = new int[f.Length];
            for (var i = 0; i < f.Length; i++)
            {
                var t = f[i];
                if (t.Length == 0 || t.Length > 9) return false;    // 9 digits fits an int with room to spare
                for (var j = 0; j < t.Length; j++)
                    if (t[j] < '0' || t[j] > '9') return false;
                n[i] = int.Parse(t);
            }
            parts = n;
            return true;
        }

        /// <summary>
        /// Whether a check may run now. Never checked, or an unreadable stamp, means yes; a stamp in the future
        /// (a clock moved back, or a config edited by hand) also means yes rather than never again.
        /// </summary>
        public static bool Due(string lastCheckIso, DateTime utcNow, double intervalHours)
        {
            if (string.IsNullOrEmpty(lastCheckIso)) return true;

            DateTime last;
            if (!DateTime.TryParse(lastCheckIso, System.Globalization.CultureInfo.InvariantCulture,
                                   System.Globalization.DateTimeStyles.AdjustToUniversal |
                                   System.Globalization.DateTimeStyles.AssumeUniversal, out last)) return true;

            if (last > utcNow) return true;
            if (intervalHours <= 0) return true;
            return (utcNow - last).TotalHours >= intervalHours;
        }

        /// <summary>
        /// The settings-row text. Every state a check can be in has a wording, because a row that says nothing
        /// while the check is in flight reads as a broken feature.
        /// </summary>
        public static string StatusText(string installed, string latest, bool completed, bool enabled)
        {
            var have = string.IsNullOrEmpty(installed) ? "?" : installed;
            if (!enabled) return have + " - checks off";
            if (!completed) return have + " - checking";
            if (string.IsNullOrEmpty(latest)) return have + " - no version published";
            if (IsNewer(installed, latest)) return have + " - " + latest + " available";
            return have + " - up to date";
        }

        /// <summary>The one-line toast for a newer release. Names both versions: "newer" alone is not actionable.</summary>
        public static string ToastText(string modName, string installed, string latest)
        {
            var name = string.IsNullOrEmpty(modName) ? "This mod" : modName;
            return name + " " + latest + " is out (you have " + installed + ")";
        }

        /// <summary>The stamp format written back after a check. Round-trips through <see cref="Due"/>.</summary>
        public static string Stamp(DateTime utcNow)
        {
            return utcNow.ToUniversalTime().ToString("yyyy-MM-ddTHH:mm:ssZ",
                System.Globalization.CultureInfo.InvariantCulture);
        }
    }
}
