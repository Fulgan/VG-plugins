using System;
using System.Collections.Generic;
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
    // client. No in-game UI — the client is the UI. See SPEC.md at the workspace root.
    [BepInPlugin(Guid, "Hypercom", Version)]
    public sealed class Plugin : BaseUnityPlugin
    {
        public const string Guid = "fulgan.vanguardgalaxy.hypercom";
        public const string Version = "0.1.0";

        internal static ManualLogSource Log;

        private ConfigEntry<bool> _enabled;
        private ConfigEntry<int> _port;
        private ConfigEntry<bool> _requireAuth;
        private ConfigEntry<bool> _openBrowser;
        private ConfigEntry<bool> _allowRemote;
        private ConfigEntry<bool> _debugEndpoints;
        private HttpServer _server;

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
            // Hidden developer flag: gates the /catalog/* dev-dump endpoints. Off (and invisible in the
            // config UI) in the public plugin; flip in the .cfg to enable local reversing/dumps.
            _debugEndpoints = Config.Bind("Debug", "EnableDebugEndpoints", false,
                new BepInEx.Configuration.ConfigDescription(
                    "Enable developer/debug HTTP endpoints (e.g. GET /catalog/equipment). Leave off for normal use.",
                    null, new ConfigurationManagerAttributes { Browsable = false, IsAdvanced = true }));
            HttpServer.DebugEnabled = _debugEndpoints.Value;

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
                var requireAuth = _requireAuth.Value || _allowRemote.Value; // never expose LAN without a token
                _server = new HttpServer(_port.Value, requireAuth, _allowRemote.Value);
                _server.Start();

                // Auto-open the UI only when one is bundled (Release). Application.OpenURL hits the OS
                // default browser; Awake runs on the Unity main thread, so this is safe here.
                if (_openBrowser.Value && HttpServer.UiBundled)
                {
                    Log.LogInfo($"Opening web UI at {_server.LocalUrl}");
                    UnityEngine.Application.OpenURL(_server.LocalUrl);
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

        // Service queued game-API jobs on the Unity main thread (V3), then poll for state changes
        // to feed the SSE event bus.
        private void Update()
        {
            MainThread.Drain();
            if (_server != null)
                PollEvents();
        }

        // IMGUI settings body — rendered as the "Hypercom" tab in the shared mod host window.
        private void DrawBridgeSettings()
        {
            GUI.skin.label.richText = true;
            var running = _server != null && _server.Running;
            GUILayout.Label(running ? $"Server: listening on {_server.LocalUrl}" : "Server: stopped");

            GUILayout.Space(4f);
            GUI.enabled = running && HttpServer.UiBundled;
            if (GUILayout.Button(HttpServer.UiBundled ? "Open web UI" : "Web UI not bundled (dev build)"))
                UnityEngine.Application.OpenURL(_server.LocalUrl);
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
        }

        // ---- event watcher (T10) ----
        // Snapshot key state each frame; emit only on transition (V8). Runs on the main thread, so
        // reading game state is safe; emitting never blocks (per-client queues, V9).
        private bool _init;
        private bool _lastDocked;
        private bool _lastEcho;
        private string _lastShip;
        private string _lastStation;
        private long _lastCredits;

        private void PollEvents()
        {
            try
            {
                var player = GamePlayer.current;
                if (player == null)
                    return;

                // "docked" = inside the station interior. SpaceStation.current (currentPointOfInterest)
                // stays set after undock until you travel away, so it can't detect undock — use the
                // interior instance, which is created on dock and destroyed on undock.
                var docked = SpaceStationInterior.instance != null;
                var stationName = SpaceStation.current?.name;
                var ship = player.currentSpaceShip?.guid;
                var echo = player.currentAutopilotSessionStats != null;
                var credits = player.credits;

                if (!_init)
                {
                    _init = true;
                    _lastDocked = docked; _lastEcho = echo; _lastShip = ship; _lastStation = stationName; _lastCredits = credits;
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

                _lastDocked = docked; _lastEcho = echo; _lastShip = ship; _lastStation = stationName; _lastCredits = credits;
            }
            catch (System.Exception ex)
            {
                Log.LogWarning($"event poll failed: {ex.Message}");
            }
        }

        private void OnDestroy() => _server?.Stop();
    }
}
