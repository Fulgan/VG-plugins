using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;
using BepInEx;
using BepInEx.Configuration;
using BepInEx.Logging;
using Behaviour.UI.Spacestation;
using HarmonyLib;
using Source.Galaxy.POI;
using Source.Player;
using UnityEngine;
using VG.ModApi;

namespace Hypercom
{
    // Headless bridge: hosts a loopback HTTP server exposing inventory read/control to an external
    // client. No in-game UI — the client is the UI.
    [BepInPlugin(Guid, "Hypercom", Version)]
    public sealed class Plugin : BaseUnityPlugin
    {
        public const string Guid = "fulgan.vanguardgalaxy.hypercom";
        public const string Version = "0.2.0";

        internal static ManualLogSource Log;

        private ConfigEntry<bool> _enabled;
        private ConfigEntry<int> _port;
        private ConfigEntry<bool> _requireAuth;
        private ConfigEntry<bool> _openBrowser;
        private ConfigEntry<string> _pairHost;
        private ConfigEntry<bool> _allowRemote;
        private ConfigEntry<bool> _debugEndpoints;
        private HttpServer _server;

        // Quick-save hotkey; `KeyCode.None` = disabled (the default).

        private void Awake()
        {
            Log = Logger;

            _enabled = Config.Bind("Server", "Enabled", true,
                "Master switch for the local inventory-control HTTP server.");
            _port = Config.Bind("Server", "Port", 8777,
                "TCP port the server listens on (bound to 127.0.0.1 only).");
            _requireAuth = Config.Bind("Server", "RequireAuth", false,
                "Require the X-Auth-Token header (and ?token= for /events). Off is reasonable for the " +
                "default 127.0.0.1 bind. WARNING: with it off, any local process or webpage you visit can " +
                "call the server (CORS blocks reading replies, not mutations). Turn ON for a shared machine " +
                "or a non-loopback bind. The token file is always written so it's ready when you enable this.");
            _openBrowser = Config.Bind("Server", "OpenBrowserOnStart", true,
                "Open the bundled web UI in your default browser when the game starts. Only fires when a UI " +
                "is actually bundled (Release builds); Debug builds have no UI, so run it via Vite. Set false to disable.");
            _allowRemote = Config.Bind("Server", "AllowRemote", false,
                "Bind to 0.0.0.0 (reachable from your LAN) instead of 127.0.0.1. Forces token auth on. " +
                "WARNING: exposes inventory control to your local network — enable only on a trusted LAN.");
            _pairHost = Config.Bind("Server", "PairHost", "",
                "Address to put in the pairing QR, when auto-detection picks the wrong one (a machine with a " +
                "VPN, WSL or Hyper-V has several). Empty = detect the address this PC would actually route " +
                "from. Set to the IP your phone can reach, e.g. 192.168.1.20.");
            HttpServer.PairHostOverride = _pairHost.Value;
            _pairHost.SettingChanged += (_, __) => HttpServer.PairHostOverride = _pairHost.Value;

            // Paired phones live beside the master token; the store path is injected so `Pairing` stays
            // game-free and testable.
            Pairing.UseStore(System.IO.Path.Combine(Paths.ConfigPath, "hypercom-devices.json"));
            Pairing.Warn = m => Log.LogWarning(m);
            VG.Game.GameToast.Warn = m => Log.LogWarning(m);

            // Hidden developer flag: gates the /catalog/* dev-dump endpoints. Off (and invisible in the
            // config UI) in the public plugin; flip in the .cfg to enable local reversing/dumps.
            _debugEndpoints = Config.Bind("Debug", "EnableDebugEndpoints", false,
                new BepInEx.Configuration.ConfigDescription(
                    "Enable developer/debug HTTP endpoints (e.g. GET /catalog/equipment). Leave off for normal use.",
                    null, new ConfigurationManagerAttributes { Browsable = false, IsAdvanced = true }));
            HttpServer.DebugEnabled = _debugEndpoints.Value;

            // Before anything serves a request: earlier versions installed the UI as loose files beside this
            // DLL, and those files are now dead weight under the same names the embedded ones answer to.
            UiCleanup.Run();

            if (!_enabled.Value)
            {
                Log.LogInfo("Hypercom server disabled by config.");
                return;
            }

            try
            {
                new Harmony(Guid).PatchAll(); // log-capture hooks (notifications + event log)
            }
            catch (System.Exception ex)
            {
                Log.LogWarning($"log hooks failed to patch: {ex.Message}");
            }

            try
            {
                // The "never expose the LAN without a token" rule is the SERVER's, enforced in its constructor and
                // in Restart — so this passes the raw setting rather than re-deriving it and leaving the rule in
                // two places.
                _server = new HttpServer(_port.Value, _requireAuth.Value, _allowRemote.Value);
                _server.Start();

                // Auto-open the UI only when one is bundled (Release). Application.OpenURL hits the OS
                // default browser; Awake runs on the Unity main thread, so this is safe here.
                if (_openBrowser.Value && HttpServer.UiBundled)
                {
                    var url = WebUiUrl();
                    // The code is deliberately NOT logged: the log is copied into bug reports.
                    Log.LogInfo($"Opening web UI at {_server.LocalUrl}{(_server.RequiresAuth ? " (with an enrolment code)" : "")}");
                    OpenBrowserDetached(url);
                }
            }
            catch (System.Exception ex)
            {
                Log.LogError($"Hypercom failed to start: {ex}");
                _server = null;
            }

            // Contribute our settings tab to the shared mod host (VG.ModApi). Find-or-create: works
            // whether or not other mods are present, no separate window or hotkey of our own.
            try { VGModSettings.GetOrCreate().RegisterTab("Hypercom - WebUI", DrawBridgeSettings, 10); }
            catch (Exception ex) { Log.LogWarning($"could not register settings tab: {ex.Message}"); }
        }

        // Service queued game-API jobs on the Unity main thread, then poll for state changes
        // to feed the SSE event bus.
        private void Update()
        {
            MainThread.Drain();
            if (_server != null)
            {
                PollEvents();
                RepLog.Poll();
            }
        }

        // IMGUI settings body — rendered as the "Hypercom" tab in the shared mod host window.
        private void DrawBridgeSettings()
        {
            GUI.skin.label.richText = true;
            var running = _server != null && _server.Running;
            GUILayout.Label(running ? $"Server: listening on {_server.LocalUrl}" : "Server: stopped");

            GUILayout.Space(4f);
            GUI.enabled = running && HttpServer.UiBundled;
            // Route through OpenBrowserDetached (not Application.OpenURL) so the browser starts OUTSIDE
            // Steam's job object — else the game hangs at exit until the browser closes (same reason as
            // the auto-open path). This button is the common open path when OpenBrowserOnStart is off.
            // The label says what the click will DO: with auth on it enrols the browser rather than just
            // opening a page that would greet the player with a token prompt.
            var openLabel = !HttpServer.UiBundled ? "Web UI not bundled (dev build)"
                          : running && _server.RequiresAuth ? "Open web UI (enrols this browser)"
                          : "Open web UI";
            if (GUILayout.Button(openLabel))
                OpenBrowserDetached(WebUiUrl());
            GUI.enabled = true;
            _openBrowser.Value = GUILayout.Toggle(_openBrowser.Value, " Open the web UI automatically on game start");

            GUILayout.Space(6f);
            var auth = GUILayout.Toggle(_requireAuth.Value, " Require auth token");
            var remote = GUILayout.Toggle(_allowRemote.Value, " Allow remote (LAN) connections");
            if (remote)
            {
                auth = true; // LAN bind forces auth on
                GUILayout.Label("<color=#e0a030>⚠ LAN-exposed. Token auth forced on.</color>");
            }

            GUILayout.Space(6f);
            GUILayout.Label("Token (paste into the web UI when auth is on):");
            GUILayout.TextField(_server != null ? _server.Token : "(server off)");
            if (GUILayout.Button("Regenerate token"))
                _server?.RegenerateToken();

            // Apply bind/auth changes live by rebinding the listener.
            if (_server != null && (auth != _requireAuth.Value || remote != _allowRemote.Value))
            {
                _requireAuth.Value = auth;
                _allowRemote.Value = remote;
                _server.Restart(_port.Value, auth, remote);
            }

            DrawPairing();
        }

        // ---- pairing a phone -------------------------------------------------------------------------
        // The QR texture is built once per session and destroyed with it: a Texture2D is an unmanaged
        // allocation, and rebuilding one every OnGUI frame would leak a few MB a second.
        private Texture2D _qr;
        private string _qrForCode;
        private int _addressIndex;
        private string _pairMessage;

        private void DrawPairing()
        {
            GUILayout.Space(10f);
            GUILayout.Label("<b>Phone / tablet</b>");

            if (_server == null || !_server.Running)
            {
                GUILayout.Label("Server is stopped — nothing to pair with.");
                return;
            }

            // A phone cannot reach 127.0.0.1, so pairing is meaningless until the server is bound to the LAN.
            // The warning goes ABOVE the button: a consequence read after the click is not a choice.
            if (!_allowRemote.Value)
            {
                GUILayout.Label("<color=#e0a030>⚠ Your phone can't reach a loopback-only server. Enabling LAN "
                                + "access lets any device on your network load the web UI; every data call still "
                                + "needs a token, and token auth is forced on.</color>");
                if (GUILayout.Button("Enable LAN access & pair"))
                {
                    _allowRemote.Value = true;
                    _requireAuth.Value = true;
                    _server.Restart(_port.Value, true, true);
                    StartPairing();
                }
                DrawDeviceList();
                return;
            }

            var session = Pairing.Snapshot();
            if (session.Open)
            {
                var addresses = HttpServer.LanCandidates();
                var address = _server.LanAddress();
                var current = addresses.Find(a => a.Address == address);
                GUILayout.Label($"Scan this with your phone's camera, or open <b>{_server.LanUrl}</b> "
                                + $"and enter the code. Expires in <b>{session.SecondsLeft}s</b>.");

                if (_qr == null || _qrForCode != session.Code)
                {
                    QrTexture.Release(ref _qr);
                    // Over capacity → the encoder returns null rather than a truncated symbol, and the URL
                    // below is then the only way in. A truncated QR would still scan, to the wrong place.
                    _qr = QrTexture.Build(VG.Util.QrCode.Encode(Encoding.UTF8.GetBytes(_server.PairUrl(session.Code))));
                    _qrForCode = session.Code;
                }
                if (_qr != null) GUILayout.Label(_qr, GUILayout.Width(_qr.width), GUILayout.Height(_qr.height));
                else GUILayout.Label($"<color=#e0a030>URL too long for a QR — type it in:</color> {_server.PairUrl(session.Code)}");

                GUILayout.Label($"Code: <b>{session.Code}</b>   ({session.AttemptsLeft} wrong "
                                + $"attempt{(session.AttemptsLeft == 1 ? "" : "s")} allowed)");

                // Several plausible addresses is the normal case on a machine with a VPN or a hypervisor, and
                // only the player can tell which one the phone can actually reach.
                if (addresses.Count > 1 && GUILayout.Button(
                        $"Address: {address}{(current == null ? "" : $" ({current.Label})")} — try another"))
                {
                    _addressIndex = (_addressIndex + 1) % addresses.Count;
                    HttpServer.PairHostOverride = addresses[_addressIndex].Address;
                    _pairHost.Value = addresses[_addressIndex].Address;   // remembered, so the choice sticks
                    QrTexture.Release(ref _qr);
                    _qrForCode = null;
                }
                // A tailnet address is the one that also works when the phone is NOT on this network, which is
                // otherwise a silent failure: the QR scans, the page never loads.
                if (current != null && current.OffLan)
                    GUILayout.Label("<color=#7fc8a0>This is a mesh-VPN address — works from anywhere your phone "
                                    + "is on the same tailnet.</color>");
                else if (addresses.Exists(a => a.OffLan))
                    GUILayout.Label("<color=#e0a030>Only reachable from this network. Cycle to the "
                                    + $"{addresses.Find(a => a.OffLan).Label} address if your phone is elsewhere.</color>");
                if (GUILayout.Button("Cancel pairing"))
                {
                    Pairing.Close();
                    QrTexture.Release(ref _qr);
                    _pairMessage = null;
                }
            }
            else
            {
                if (GUILayout.Button("Pair a phone")) StartPairing();
                if (!string.IsNullOrEmpty(_pairMessage)) GUILayout.Label(_pairMessage);
            }

            DrawDeviceList();
        }

        private void StartPairing()
        {
            Pairing.Open();
            QrTexture.Release(ref _qr);
            _qrForCode = null;
            _pairMessage = null;
        }

        private void DrawDeviceList()
        {
            var devices = Pairing.Snapshots();
            if (devices.Count == 0) return;

            GUILayout.Space(6f);
            GUILayout.Label($"<b>Paired devices ({devices.Count})</b>");
            foreach (var d in devices)
            {
                GUILayout.BeginHorizontal();
                // The label came from the device, so it was sanitised on ingest — rich text is on here.
                GUILayout.Label(d.LastSeenUtc == null
                    ? $"{d.Label} — never seen"
                    : $"{d.Label} — last seen {d.LastSeenUtc.Value.ToLocalTime():HH:mm}");
                if (GUILayout.Button("Revoke", GUILayout.Width(70f)))
                {
                    Pairing.Revoke(d.Id);
                    _pairMessage = $"Revoked {d.Label}.";
                }
                GUILayout.EndHorizontal();
            }
            if (GUILayout.Button("Revoke all devices"))
                _pairMessage = $"Revoked {Pairing.RevokeAll()} device(s).";
        }

        // ---- event watcher ----
        // Snapshot key state each frame; emit only on transition. Runs on the main thread, so
        // reading game state is safe; emitting never blocks (per-client queues).
        private bool _init;
        private bool _lastDocked;
        private bool _lastEcho;
        private string _lastShip;
        private string _lastStation;
        private long _lastCredits;
        private long _lastShopStock;

        private void PollEvents()
        {
            try
            {
                var player = GamePlayer.current;
                if (player == null)
                    return;

                var docked = Api.Docked; // single source (see Api.Docked) — was duplicated here
                var stationName = SpaceStation.current?.name;
                var ship = player.currentSpaceShip?.guid;
                var echo = player.currentAutopilotSessionStats != null;
                var credits = VG.Game.Wallet.Balance(player);
                var shopStock = docked ? ShopStockSignature() : 0L;

                if (!_init)
                {
                    _init = true;
                    _lastDocked = docked; _lastEcho = echo; _lastShip = ship; _lastStation = stationName; _lastCredits = credits; _lastShopStock = shopStock;
                    return; // no events on the first snapshot
                }

                if (docked != _lastDocked)
                    EventBus.Emit(docked ? "dock" : "undock",
                        docked ? new Dictionary<string, object> { ["station"] = stationName } : null);
                else if (docked && stationName != _lastStation)
                    EventBus.Emit("stationChanged", new Dictionary<string, object> { ["station"] = stationName });

                if (ship != _lastShip)
                    EventBus.Emit("shipChanged", new Dictionary<string, object> { ["shipGuid"] = ship });

                if (echo != _lastEcho)
                    EventBus.Emit("echo", new Dictionary<string, object> { ["active"] = echo });

                // Credits change ⇒ a buy/sell happened ⇒ inventory/shop changed → tell the client to refresh.
                if (credits != _lastCredits)
                    EventBus.Emit("credits", new Dictionary<string, object> { ["credits"] = credits });

                // Shop stock change while staying docked ⇒ a purchase/sale happened. Catches BARTER buys
                // too (those don't move credits), so the web opportunities refresh after any shop change.
                if (docked && _lastDocked && shopStock != _lastShopStock)
                    EventBus.Emit("shopChanged");

                _lastDocked = docked; _lastEcho = echo; _lastShip = ship; _lastStation = stationName; _lastCredits = credits; _lastShopStock = shopStock;
            }
            catch (System.Exception ex)
            {
                Log.LogWarning($"event poll failed: {ex.Message}");
            }
        }

        // Cheap change-signature of the current station's shop stock: sum of item counts across every
        // facility shop. Any buy/sell (credits OR barter) shifts a finite stock and moves this number, so
        // the poll can fire "shopChanged". Infinite-supply items don't change and are simply not counted.
        private static long ShopStockSignature()
        {
            var st = SpaceStation.current;
            if (st == null)
                return 0L;
            long sum = 0;
            foreach (var s in new[]
            {
                st.generalShopInventory, st.miningShopInventory, st.salvageShopInventory, st.bountyShopInventory,
                st.patrolShopInventory, st.industryShopInventory, st.conquestShopInventory, st.umbralShopInventory,
            })
            {
                if (s?.items == null)
                    continue;
                foreach (var e in s.items)
                    if (e?.item != null && !e.item.HasInfiniteShopSupply())
                        sum += e.count;
            }
            return sum;
        }

        // Open the default browser so it does NOT stay inside the game's Steam job object. Steam launches
        // the game in a Windows Job Object and waits on the WHOLE job at quit; any process spawned by a job
        // member (a browser opened via Application.OpenURL, or even via explorer.exe) joins the job, so the
        // game hangs at "stopping…" until that browser closes. Launching with CREATE_BREAKAWAY_FROM_JOB
        // starts the opener OUTSIDE the job. Fall back to explorer.exe, then Application.OpenURL, if the
        // job forbids breakaway (then only turning OpenBrowserOnStart off fully avoids the hang).

        // The URL to open a browser at. With auth off it is just the UI. With auth ON it carries a pairing
        // code, so the page enrols itself and the player never sees a token — the alternative was reading a
        // 32-character hex string out of a config file and pasting it into a form.
        //
        // An unexpired code already on screen is REUSED rather than replaced: each claim consumes a device
        // slot (16 max), and pressing the button twice should not spend two of them or invalidate the QR the
        // settings tab is currently showing.
        private string WebUiUrl()
        {
            if (_server == null) return null;
            if (!_server.RequiresAuth) return _server.LocalUrl;
            var live = Pairing.Snapshot();
            var code = live != null && live.Open && live.SecondsLeft > 5 ? live.Code : Pairing.Open();
            return _server.LocalPairUrl(code);
        }

        private void OpenBrowserDetached(string url)
        {
            try { if (TryOpenBreakaway(url)) { Log.LogInfo("browser: launched via CREATE_BREAKAWAY_FROM_JOB (outside Steam job)"); return; } }
            catch (Exception ex) { Log.LogWarning($"breakaway browser launch failed: {ex.Message}"); }
            try
            {
                System.Diagnostics.Process.Start(new System.Diagnostics.ProcessStartInfo
                { FileName = "explorer.exe", Arguments = url, UseShellExecute = false });
                Log.LogWarning("browser: breakaway unavailable — fell back to explorer.exe (may stay in Steam's job → game can hang at exit until the browser closes)");
                return;
            }
            catch (Exception ex) { Log.LogWarning($"explorer.exe browser launch failed: {ex.Message}"); }
            try { UnityEngine.Application.OpenURL(url); Log.LogWarning("browser: fell back to Application.OpenURL (inside Steam's job → game can hang at exit until the browser closes)"); } catch { }
        }

        // --- native launch that breaks out of Steam's job object ---
        private const uint CREATE_BREAKAWAY_FROM_JOB = 0x01000000;
        private const uint CREATE_NO_WINDOW = 0x08000000;

        [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
        private struct STARTUPINFO
        {
            public int cb; public string lpReserved, lpDesktop, lpTitle;
            public int dwX, dwY, dwXSize, dwYSize, dwXCountChars, dwYCountChars, dwFillAttribute, dwFlags;
            public short wShowWindow, cbReserved2; public IntPtr lpReserved2, hStdInput, hStdOutput, hStdError;
        }
        [StructLayout(LayoutKind.Sequential)]
        private struct PROCESS_INFORMATION { public IntPtr hProcess, hThread; public int dwProcessId, dwThreadId; }

        [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
        private static extern bool CreateProcess(string lpApplicationName, string lpCommandLine,
            IntPtr lpProcessAttributes, IntPtr lpThreadAttributes, bool bInheritHandles, uint dwCreationFlags,
            IntPtr lpEnvironment, string lpCurrentDirectory, ref STARTUPINFO lpStartupInfo,
            out PROCESS_INFORMATION lpProcessInformation);
        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern bool CloseHandle(IntPtr hObject);

        // Run `cmd /c start "" <url>` outside the job → the browser it opens isn't in Steam's job either.
        private static bool TryOpenBreakaway(string url)
        {
            var comspec = Environment.GetEnvironmentVariable("ComSpec") ?? "cmd.exe";
            var cmdline = $"\"{comspec}\" /c start \"\" \"{url}\"";
            var si = new STARTUPINFO(); si.cb = Marshal.SizeOf(si);
            if (!CreateProcess(null, cmdline, IntPtr.Zero, IntPtr.Zero, false,
                    CREATE_BREAKAWAY_FROM_JOB | CREATE_NO_WINDOW, IntPtr.Zero, null, ref si, out var pi))
            {
                // job forbids breakaway (ERROR_ACCESS_DENIED=5) or the process isn't in a job at all — the
                // caller falls back. GetLastError distinguishes the cause so the failure isn't silent.
                Log.LogWarning($"CREATE_BREAKAWAY_FROM_JOB failed, GetLastError={Marshal.GetLastWin32Error()} (5=ERROR_ACCESS_DENIED: Steam's job disallows breakaway)");
                return false;
            }
            CloseHandle(pi.hThread);
            CloseHandle(pi.hProcess);
            return true;
        }

        // Stop the listener on both teardown paths — OnApplicationQuit fires on a clean game exit, OnDestroy
        // on scene/plugin teardown. Both are safe to call (Stop is idempotent), so the socket is always
        // released and never lingers to keep the process (and Steam's "running" state) alive.
        // Client-state writes are coalesced (see ClientState), so flush on the way out or the last few
        // seconds of preference changes would be lost on a clean exit.
        private void OnApplicationQuit() { ClientState.Flush(); Pairing.Flush(); _server?.Stop(); }
        private void OnDestroy() { ClientState.Flush(); Pairing.Flush(); QrTexture.Release(ref _qr); _server?.Stop(); }
    }
}
