using System;
using System.IO;
using System.Net;
using System.Text;
using System.Threading;

namespace VG.Core
{
    // The fetch half of update notification: one HTTPS GET of the published manifest, on a worker thread, whose
    // result is picked up by the caller's own Update loop. Everything it can produce is a version string and a
    // link that has already been constrained to the known repository (Updater.LinkPrefix).
    //
    // Three properties matter more than the feature does:
    //
    //  - IT NEVER DELAYS OR BREAKS A LOAD. Begin() returns immediately and the request runs off the main thread;
    //    a player with no network sees nothing at all, because a mod that works offline must not report errors
    //    about a service it only uses for a courtesy.
    //  - IT NEVER RETRIES IN A LOOP. One attempt per session, gated by the caller's interval. A failure waits
    //    for the next session rather than hammering a host that is down.
    //  - IT DOWNLOADS NOTHING ELSE. No asset, no zip, no file written anywhere. The response is read into a
    //    capped buffer, parsed, and dropped.
    //
    // Unity-free and BepInEx-free on purpose: the caller supplies its own logger, and the result is handed back
    // through TryTake() so the plugin marshals it onto the main thread itself.
    public static class UpdateCheck
    {
        /// <summary>Where a failure goes. Set once at startup; the plugin's own logger. Never user-facing.</summary>
        public static Action<string> Log;

        public sealed class Result
        {
            public string Guid;
            public string Installed;
            public string Latest;       // null when the manifest had no line for this GUID
            public string Url;
            public bool IsNewer;
            public string CheckedAtIso; // persist this, so the interval survives a restart
        }

        private const int TimeoutMs = 10000;

        private static Result _pending;
        private static int _started;

        /// <summary>
        /// Start the one check for this session, if the interval allows it. Returns false when nothing was
        /// started: already run, not due, or disabled by the caller.
        /// </summary>
        public static bool Begin(string guid, string installedVersion, string lastCheckIso, double intervalHours)
        {
            try
            {
                if (string.IsNullOrEmpty(guid) || string.IsNullOrEmpty(installedVersion)) return false;
                if (!Updater.Due(lastCheckIso, DateTime.UtcNow, intervalHours)) return false;
                // One attempt per process, whatever else calls in.
                if (Interlocked.Exchange(ref _started, 1) != 0) return false;

                var t = new Thread(() => Run(guid, installedVersion)) { IsBackground = true, Name = "vg-update-check" };
                t.Start();
                return true;
            }
            catch (Exception e)
            {
                Warn("update check could not start: " + e.Message);
                return false;
            }
        }

        /// <summary>
        /// Hand over a completed check exactly once. Call from the plugin's Update: the request finished on a
        /// worker thread, and everything the result feeds (a toast, a settings row) is main-thread work.
        /// </summary>
        public static bool TryTake(out Result result)
        {
            result = Interlocked.Exchange(ref _pending, null);
            return result != null;
        }

        private static void Run(string guid, string installed)
        {
            try
            {
                var body = Fetch(Updater.ManifestUrl);
                if (body == null) return;                    // already logged; silence for the player

                var entry = Updater.Find(body, guid);
                var r = new Result
                {
                    Guid = guid,
                    Installed = installed,
                    Latest = entry != null ? entry.Version : null,
                    Url = entry != null ? entry.Url : null,
                    IsNewer = entry != null && Updater.IsNewer(installed, entry.Version),
                    CheckedAtIso = Updater.Stamp(DateTime.UtcNow),
                };
                Interlocked.Exchange(ref _pending, r);
            }
            catch (Exception e)
            {
                // A worker thread that throws takes the process down in some runtimes; nothing here is worth that.
                Warn("update check failed: " + e.Message);
            }
        }

        private static string Fetch(string url)
        {
            try
            {
                // Mono in the game may not have TLS 1.2 among its defaults. This setting is process-wide and the
                // game shares it, so the bit is ADDED and nothing is removed or replaced.
                if ((ServicePointManager.SecurityProtocol & SecurityProtocolType.Tls12) == 0)
                    ServicePointManager.SecurityProtocol |= SecurityProtocolType.Tls12;

                var req = (HttpWebRequest)WebRequest.Create(url);
                req.Method = "GET";
                req.Timeout = TimeoutMs;
                req.ReadWriteTimeout = TimeoutMs;
                req.UserAgent = "VG-plugins update check";
                req.AllowAutoRedirect = true;
                req.MaximumAutomaticRedirections = 4;
                // Certificate validation is left exactly as the runtime configured it. A plugin that installs its
                // own callback would be relaxing the one check that makes the rest of this safe.

                using (var resp = (HttpWebResponse)req.GetResponse())
                {
                    if (resp.StatusCode != HttpStatusCode.OK)
                    {
                        Warn("manifest answered " + (int)resp.StatusCode);
                        return null;
                    }
                    // A redirect chain must not leave the host we asked, and must still be TLS. The manifest is
                    // published at one address; anything else answering for it is not the manifest.
                    var final = resp.ResponseUri;
                    var asked = new Uri(url);
                    if (final.Scheme != Uri.UriSchemeHttps ||
                        !string.Equals(final.Host, asked.Host, StringComparison.OrdinalIgnoreCase))
                    {
                        Warn("manifest redirected off " + asked.Host + " to " + final.Host + ": ignored");
                        return null;
                    }
                    if (resp.ContentLength > Updater.MaxManifestBytes)
                    {
                        Warn("manifest is " + resp.ContentLength + " bytes: not a manifest");
                        return null;
                    }
                    return ReadCapped(resp);
                }
            }
            catch (WebException we)
            {
                // A status code arrives as an exception, not a response, and 404 is the ORDINARY state until a
                // release has mirrored the manifest, so it is named rather than folded into "unreachable".
                var http = we.Response as HttpWebResponse;
                if (http != null) Warn("manifest answered " + (int)http.StatusCode + " (" + Updater.ManifestUrl + ")");
                else Warn("manifest unreachable: " + we.Message);
                return null;
            }
            catch (Exception e)
            {
                // Offline, DNS, timeout, TLS: all one thing here, and none of them is the player's problem.
                Warn("manifest unreachable: " + e.Message);
                return null;
            }
        }

        // Read at most MaxManifestBytes whatever the headers claimed: Content-Length is the server's word for it,
        // and an unbounded read on a shared process is worse than no update check.
        private static string ReadCapped(HttpWebResponse resp)
        {
            using (var s = resp.GetResponseStream())
            {
                if (s == null) return null;
                var buf = new byte[8192];
                var mem = new MemoryStream();
                int n;
                while ((n = s.Read(buf, 0, buf.Length)) > 0)
                {
                    if (mem.Length + n > Updater.MaxManifestBytes)
                    {
                        Warn("manifest exceeded " + Updater.MaxManifestBytes + " bytes: ignored");
                        return null;
                    }
                    mem.Write(buf, 0, n);
                }
                return Encoding.UTF8.GetString(mem.ToArray());
            }
        }

        private static void Warn(string message)
        {
            var log = Log;
            if (log == null) return;
            try { log(message); } catch { /* a logger that throws must not become the failure */ }
        }
    }
}
