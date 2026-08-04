using System;
using System.Collections.Generic;
using System.IO;
using System.Reflection;
using System.Security.Cryptography;
using System.Text;

namespace Hypercom
{
    // Removes the `ui/` folder that earlier versions deployed beside the plugin. The UI is embedded in the
    // assembly now (see WebUi), so nothing reads those files — and a folder that nothing reads is a folder that
    // misleads whoever finds it, since its files carry the same names as the ones actually being served.
    //
    // DELETES ONLY WHAT A RELEASE PUT THERE. A file goes when its path AND its bytes match an entry in Shipped;
    // anything else stays — a hand-built bundle, a file the player dropped in, a newer build installed over an
    // older one. This runs unattended at startup with no undo, so an unrecognised file is left and named in the
    // log rather than guessed at. A directory is removed only once it is empty.
    internal static class UiCleanup
    {
        // One file a released version deployed into `ui/`. Vite content-hashes asset names, so each entry
        // identifies exactly one build's output and cannot match anything else. The list only grows: every
        // release whose zip carried a `ui/` folder needs its files here, or they will never be cleaned up.
        private sealed class Shipped
        {
            internal readonly string Path;
            internal readonly long Length;
            internal readonly string Sha256;

            internal Shipped(string path, long length, string sha256) { Path = path; Length = length; Sha256 = sha256; }
        }

        private static readonly Shipped[] Deployed =
        {
            // 0.1.0 — the last version to ship the UI as loose files.
            new Shipped("index.html",                  464, "96106BD9E85F3F712272687581A9884CF04228EF400889F939A31E4DD506D709"),
            new Shipped("assets/index-DJqoBVjk.js", 309671, "604B2302F501C3B24BF02C824E8ADEA285ABDDD08670D3DF54BD5D4CB17C1A24"),
            new Shipped("assets/index-DJulA8Pc.css", 38091, "2EE09C6C37263974105FEEA905AD8221BA55A1F3A30E2AC53C25D92A9663E0B3"),
            new Shipped("icons.svg",                  5031, "B45FA506195CFCDEF406BA9F0C77B36DDC1A7C224040926EC70ABC2FDEA7B93A"),
            new Shipped("favicon.svg",                9522, "61BC9A161DE58248288E6905425D7180F0624C2865007B97D763FDAC12043A66"),
        };

        /// <summary>Remove a previously deployed UI folder, keeping anything this plugin never shipped.</summary>
        internal static void Run()
        {
            try
            {
                var root = System.IO.Path.Combine(
                    System.IO.Path.GetDirectoryName(Assembly.GetExecutingAssembly().Location) ?? ".", "ui");
                if (!Directory.Exists(root)) return;

                var known = new Dictionary<string, Shipped>(StringComparer.OrdinalIgnoreCase);
                foreach (var s in Deployed) known[s.Path] = s;

                var removed = 0;
                var kept = new List<string>();

                foreach (var file in Directory.GetFiles(root, "*", SearchOption.AllDirectories))
                {
                    var rel = file.Substring(root.Length).TrimStart('\\', '/').Replace('\\', '/');
                    if (!known.TryGetValue(rel, out var entry) || !SameBytes(file, entry))
                    {
                        kept.Add(rel);
                        continue;
                    }
                    try { File.Delete(file); removed++; }
                    catch (Exception ex)
                    {
                        kept.Add(rel);
                        Plugin.Log.LogWarning($"could not remove {rel} from the old web UI folder: {ex.Message}");
                    }
                }

                PruneEmptyFolders(root);

                if (removed > 0)
                    Plugin.Log.LogInfo($"removed {removed} file(s) of a previously installed web UI from {root} " +
                                       "(the UI ships inside the plugin now)");
                if (kept.Count > 0)
                    Plugin.Log.LogInfo($"{root} keeps {kept.Count} file(s) no release of this plugin installed, " +
                                       $"left untouched: {Names(kept)}");
            }
            catch (Exception ex)
            {
                // Cosmetic housekeeping: it must never cost the player a working bridge.
                Plugin.Log.LogWarning($"old web UI cleanup skipped: {ex.Message}");
            }
        }

        // Length first: it rules out almost everything for the cost of a stat, so a folder that accumulated
        // dozens of unrelated bundles is not hashed end to end.
        private static bool SameBytes(string file, Shipped entry)
        {
            try
            {
                if (new FileInfo(file).Length != entry.Length) return false;
                using (var sha = SHA256.Create())
                {
                    if (sha == null) return false;
                    using (var s = File.OpenRead(file))
                    {
                        var hash = sha.ComputeHash(s);
                        var hex = new StringBuilder(hash.Length * 2);
                        foreach (var b in hash) hex.Append(b.ToString("X2"));
                        return string.Equals(hex.ToString(), entry.Sha256, StringComparison.OrdinalIgnoreCase);
                    }
                }
            }
            catch { return false; } // unreadable is not a match, so the file stays
        }

        // Deepest first, so a folder whose only content was subfolders also goes. `root` itself is included.
        private static void PruneEmptyFolders(string root)
        {
            var dirs = new List<string>(Directory.GetDirectories(root, "*", SearchOption.AllDirectories));
            dirs.Sort((a, b) => b.Length.CompareTo(a.Length));
            dirs.Add(root);
            foreach (var d in dirs)
            {
                try
                {
                    if (Directory.GetFileSystemEntries(d).Length == 0) Directory.Delete(d);
                }
                catch { /* in use or not ours to remove — leave it */ }
            }
        }

        private static string Names(List<string> kept)
        {
            const int Max = 10;
            var shown = kept.Count <= Max ? kept.ToArray() : kept.GetRange(0, Max).ToArray();
            var list = string.Join(", ", shown);
            return kept.Count > Max ? $"{list}, … ({kept.Count - Max} more)" : list;
        }
    }
}
