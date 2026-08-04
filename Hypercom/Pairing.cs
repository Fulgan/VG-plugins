using System;
using System.Collections.Generic;
using System.Linq;
using System.Security.Cryptography;
using System.Text;

namespace Hypercom
{
    // Pairing a phone or tablet with the bridge, and the device tokens that come out of it.
    //
    // The shape of the exchange, and why:
    //
    //   The PC shows a short-lived CODE (as a QR and as text). The phone loads the shell over the LAN and posts
    //   the code back, and gets its OWN token. The master token never leaves the PC, so a photo of the screen is
    //   worth nothing once the session expires, and one phone's token can be revoked without disturbing the
    //   others or the master.
    //
    //   A code, not a token, is what the QR carries. Putting the master token in the QR would make the screen
    //   itself the secret — permanently, and retroactively for anyone who has ever photographed it.
    //
    // Everything here is BCL-only and the store path is injected, so this type links into the test project and
    // its rules are tested off-process. It touches no game state, so it needs no main-thread marshalling — but
    // it IS reached from both the socket thread and `OnGUI`, so every read and write goes through one lock.
    internal static class Pairing
    {
        // Crockford base32 without I, L, O and U: the alphabet exists so a code read off a screen and typed by
        // hand cannot be misread, which is the fallback when a camera won't focus.
        private const string Alphabet = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
        private const int CodeLength = 8;
        private const int MaxAttempts = 5;
        private const int MaxDevices = 16;
        internal static readonly TimeSpan SessionTtl = TimeSpan.FromSeconds(120);

        private static readonly object Gate = new object();

        // Where a failure goes. Injected rather than calling `Plugin.Log` directly: this type is compiled into
        // the test project, which has no BepInEx, and a store that cannot be written must still not throw into
        // a caller on the socket thread or in OnGUI.
        internal static Action<string> Warn = _ => { };

        // ---- open session -----------------------------------------------------------------------------

        private static string _code;
        private static DateTime _expiresUtc;
        private static int _attemptsLeft;
        private static string _storePath;

        internal sealed class Device
        {
            internal string Id;
            internal string Token;
            internal string Label;
            internal DateTime PairedUtc;
            internal DateTime? LastSeenUtc;
        }

        private static readonly List<Device> Devices = new List<Device>();
        private static bool _loaded;
        private static bool _dirty;

        // Where the device list lives. Injected rather than read from BepInEx `Paths` so this type stays
        // game-free and a test can point it at a temp file.
        internal static void UseStore(string path)
        {
            lock (Gate)
            {
                _storePath = path;
                _loaded = false;
                Devices.Clear();
            }
        }

        // ---- session ----------------------------------------------------------------------------------

        internal sealed class SessionState
        {
            internal bool Open;
            internal string Code;
            internal int SecondsLeft;
            internal int AttemptsLeft;
        }

        // Start (or restart) a pairing window. Restarting replaces any code already on screen: two live codes
        // would mean two ways in, and the one you are not looking at is the one you would forget to cancel.
        internal static string Open()
        {
            lock (Gate)
            {
                _code = NewCode();
                _expiresUtc = DateTime.UtcNow + SessionTtl;
                _attemptsLeft = MaxAttempts;
                return _code;
            }
        }

        internal static void Close()
        {
            lock (Gate)
            {
                _code = null;
                _expiresUtc = DateTime.MinValue;
                _attemptsLeft = 0;
            }
        }

        // A snapshot for the settings tab to draw. Expiry is evaluated here rather than on a timer, so a window
        // that ran out while nothing was looking is closed the next time anyone asks.
        internal static SessionState Snapshot()
        {
            lock (Gate)
            {
                var left = _code == null ? 0 : (int)Math.Ceiling((_expiresUtc - DateTime.UtcNow).TotalSeconds);
                if (_code != null && left <= 0) { _code = null; left = 0; }
                return new SessionState
                {
                    Open = _code != null,
                    Code = _code,
                    SecondsLeft = Math.Max(0, left),
                    AttemptsLeft = _attemptsLeft,
                };
            }
        }

        internal sealed class ClaimResult
        {
            internal bool Ok;
            internal string Token;
            internal string Label;
            internal string Error;
        }

        // Trade a code for a device token. Every failure path returns the same shape and burns an attempt, and
        // a success closes the session — a code is single-use, so a replayed claim (or a second phone reading
        // the same photo) gets nothing.
        internal static ClaimResult Claim(string code, string label)
        {
            lock (Gate)
            {
                if (_code == null) return Fail("no pairing session is open");
                if (DateTime.UtcNow > _expiresUtc)
                {
                    _code = null;
                    return Fail("the pairing code expired");
                }
                if (!FixedTimeEquals(code, _code))
                {
                    // Wrong code: burn an attempt, and close the window entirely once they run out. Without
                    // that, an 8-character code is a few million guesses away over a LAN.
                    _attemptsLeft--;
                    if (_attemptsLeft <= 0) { _code = null; return Fail("too many wrong codes — pairing cancelled"); }
                    return Fail($"wrong code — {_attemptsLeft} attempt{(_attemptsLeft == 1 ? "" : "s")} left");
                }

                Load();
                if (Devices.Count >= MaxDevices)
                    // Refused, not silently rotated: evicting the oldest device would log out a phone that is
                    // still in use, and the player would have no idea why.
                    return Fail($"already paired with {MaxDevices} devices — revoke one first");

                var device = new Device
                {
                    Id = Guid.NewGuid().ToString("N").Substring(0, 12),
                    Token = NewToken(),
                    Label = SanitizeLabel(label),
                    PairedUtc = DateTime.UtcNow,
                };
                Devices.Add(device);
                _dirty = true;
                _code = null;   // single use
                Flush();
                return new ClaimResult { Ok = true, Token = device.Token, Label = device.Label };
            }
        }

        private static ClaimResult Fail(string error) => new ClaimResult { Ok = false, Error = error };

        // ---- device tokens ----------------------------------------------------------------------------

        // Whether `token` belongs to a paired device. Compared in fixed time against every device, and the loop
        // deliberately does NOT exit early: a timing difference would reveal how many devices are paired and
        // how far a guess got.
        internal static bool IsDeviceToken(string token)
        {
            if (string.IsNullOrEmpty(token)) return false;
            lock (Gate)
            {
                Load();
                var match = false;
                foreach (var d in Devices)
                    if (FixedTimeEquals(token, d.Token))
                    {
                        match = true;
                        d.LastSeenUtc = DateTime.UtcNow;
                        _dirty = true;   // flushed on pair/revoke/quit, never per request
                    }
                return match;
            }
        }

        internal static List<Device> Snapshots()
        {
            lock (Gate)
            {
                Load();
                return Devices.Select(d => new Device
                {
                    Id = d.Id, Token = null, Label = d.Label, PairedUtc = d.PairedUtc, LastSeenUtc = d.LastSeenUtc,
                }).ToList();
            }
        }

        internal static bool Revoke(string id)
        {
            lock (Gate)
            {
                Load();
                var removed = Devices.RemoveAll(d => d.Id == id) > 0;
                if (removed) { _dirty = true; Flush(); }
                return removed;
            }
        }

        internal static int RevokeAll()
        {
            lock (Gate)
            {
                Load();
                var n = Devices.Count;
                Devices.Clear();
                if (n > 0) { _dirty = true; Flush(); }
                return n;
            }
        }

        // ---- persistence ------------------------------------------------------------------------------

        // `lastSeen` is the only field that changes on a normal request, and it is worth nothing after a crash,
        // so writes are batched: pair, revoke and quit flush, ordinary traffic does not touch the disk.
        internal static void Flush()
        {
            lock (Gate)
            {
                if (!_dirty || _storePath == null) return;
                try
                {
                    var rows = Devices.Select(d => (object)new Dictionary<string, object>
                    {
                        ["id"] = d.Id,
                        ["token"] = d.Token,
                        ["label"] = d.Label,
                        ["paired"] = d.PairedUtc.ToString("o"),
                        ["lastSeen"] = d.LastSeenUtc?.ToString("o"),
                    }).ToList();
                    var json = Json.Write(new Dictionary<string, object> { ["devices"] = rows });
                    System.IO.File.WriteAllText(_storePath, json);
                    _dirty = false;
                }
                catch (Exception e) { Warn($"paired devices not saved: {e.Message}"); }
            }
        }

        private static void Load()
        {
            if (_loaded) return;
            _loaded = true;
            if (_storePath == null || !System.IO.File.Exists(_storePath)) return;
            try
            {
                var root = Json.ParseObject(System.IO.File.ReadAllText(_storePath));
                if (!(root != null && root.TryGetValue("devices", out var list) && list is List<object> rows)) return;
                foreach (var row in rows.OfType<Dictionary<string, object>>())
                {
                    var token = row.TryGetValue("token", out var t) ? t as string : null;
                    if (string.IsNullOrEmpty(token)) continue;   // a row without a token can authorise nothing
                    Devices.Add(new Device
                    {
                        Id = (row.TryGetValue("id", out var i) ? i as string : null) ?? Guid.NewGuid().ToString("N").Substring(0, 12),
                        Token = token,
                        // Re-sanitised on the way IN as well as at pair time: the file is editable, and this is
                        // the only place that can promise the draw code a safe string.
                        Label = SanitizeLabel(row.TryGetValue("label", out var l) ? l as string : null),
                        PairedUtc = ParseTime(row, "paired") ?? DateTime.UtcNow,
                        LastSeenUtc = ParseTime(row, "lastSeen"),
                    });
                }
            }
            catch (Exception e) { Warn($"paired devices not loaded: {e.Message}"); }
        }

        private static DateTime? ParseTime(Dictionary<string, object> row, string key) =>
            row.TryGetValue(key, out var v) && v is string s && DateTime.TryParse(s, null,
                System.Globalization.DateTimeStyles.RoundtripKind, out var parsed) ? parsed : (DateTime?)null;

        // ---- primitives -------------------------------------------------------------------------------

        // A device label is attacker-supplied (it comes from the claim request) and is drawn in an IMGUI label
        // with rich text ON, where `<color=…>` would rewrite the panel. Sanitised on INGEST so no draw site has
        // to remember: control characters dropped, `<` defanged, length capped.
        internal static string SanitizeLabel(string label)
        {
            if (string.IsNullOrEmpty(label)) return "device";
            var sb = new StringBuilder(label.Length);
            foreach (var ch in label)
            {
                if (char.IsControl(ch)) continue;
                sb.Append(ch == '<' ? '(' : ch == '>' ? ')' : ch);
                if (sb.Length >= 40) break;
            }
            var result = sb.ToString().Trim();
            return result.Length == 0 ? "device" : result;
        }

        private static string NewCode()
        {
            var bytes = new byte[CodeLength];
            using (var rng = RandomNumberGenerator.Create()) rng.GetBytes(bytes);
            var sb = new StringBuilder(CodeLength);
            // Modulo bias over a 32-character alphabet from 256 values is exactly zero (256 = 8 x 32), so the
            // simple reduction is uniform here.
            foreach (var b in bytes) sb.Append(Alphabet[b % Alphabet.Length]);
            return sb.ToString();
        }

        private static string NewToken()
        {
            var bytes = new byte[32];
            using (var rng = RandomNumberGenerator.Create()) rng.GetBytes(bytes);
            var sb = new StringBuilder(bytes.Length * 2);
            foreach (var b in bytes) sb.Append(b.ToString("x2"));
            return sb.ToString();
        }

        // Length-independent only in its comparison: the length itself is not secret, but which CHARACTER first
        // differs must not be observable, or a code can be recovered one position at a time.
        internal static bool FixedTimeEquals(string a, string b)
        {
            if (a == null || b == null) return false;
            if (a.Length != b.Length) return false;
            var diff = 0;
            for (var i = 0; i < a.Length; i++) diff |= a[i] ^ b[i];
            return diff == 0;
        }
    }
}
