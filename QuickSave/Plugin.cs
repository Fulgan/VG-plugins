using System;
using BepInEx;
using BepInEx.Configuration;
using BepInEx.Logging;
using UnityEngine;
using VG.ModApi;

namespace QuickSave
{
    // Quick save and quick load on hotkeys. Its own plugin rather than a corner of another one: it shares no
    // surface with the HTTP bridge or the station automation, and a player who wants only this should not install
    // either of those to get it.
    //
    // No Harmony patch: the keys are registered with the shared settings host, which owns the polling and the
    // rebinding UI (Shared/ModHost.cs). The one thing this plugin ticks per frame is the update notice, which
    // hands over a finished version check on the main thread and does nothing else.
    [BepInPlugin(Guid, "Quick Save", "1.0.0")]
    public sealed class Plugin : BaseUnityPlugin
    {
        internal const string Guid = "fulgan.vanguardgalaxy.quicksave";
        internal static ManualLogSource Log;

        // Both default to None. The shared host collision-checks other MODS' bindings, not the GAME's own, so
        // claiming F5/F9 unasked could silently shadow something the game already uses — the player opts in.
        private ConfigEntry<KeyCode> _saveKey;
        private ConfigEntry<KeyCode> _loadKey;

        private VG.Core.UpdateNotice _notice;

        private void Awake()
        {
            Log = Logger;
            VG.Game.GameToast.Warn = m => Log.LogWarning(m);

            _saveKey = Config.Bind("Keys", "QuickSave", KeyCode.None,
                "Key that writes the current game to the \"quicksave\" slot. None = disabled. Rebind here or in " +
                "the shared mod settings window's Hotkeys tab.");
            _loadKey = Config.Bind("Keys", "QuickLoad", KeyCode.None,
                "Key that loads the \"quicksave\" slot. None = disabled. Goes through the game's own " +
                "GameManager.LoadGame, the same call its menu button makes. The state at the moment you press it " +
                "is written to \"quicksave-undo\" first, so an accidental press is recoverable from the game's menu.");

            // Through the shared host so the bindings are collision-checked against every other mod's and appear in
            // its Hotkeys tab, while persistence stays in THIS plugin's config via the get/set pairs.
            try
            {
                var host = VGModSettings.GetOrCreate();
                host.SetGameGate(() => VG.Game.GameState.Loaded);
                host.RegisterHotkey("quicksave.save", "Quick save",
                    () => _saveKey.Value, k => _saveKey.Value = k, SaveActions.Save);
                host.RegisterHotkey("quicksave.load", "Quick load",
                    () => _loadKey.Value, k => _loadKey.Value = k, SaveActions.Load);
                // Loading is the one action whose point is to run with no game loaded — from the main menu it is
                // the fastest way back into a save.
                host.SetHotkeyUngated("quicksave.load");
            }
            catch (Exception ex) { Log.LogWarning($"could not register hotkeys: {ex.Message}"); }

            // Version check only: it reads the published version list and reports what it says. Nothing is
            // downloaded, written or run. The running version comes from BepInEx's own metadata — the
            // [BepInPlugin] literal it parsed — never from a third copy written here.
            _notice = VG.Core.UpdateSettings.Install(base.Config, "Quick Save", Guid,
                Info.Metadata.Version.ToString(), m => VG.Game.GameToast.Show(m), m => Log.LogInfo(m));

            Log.LogInfo($"Quick Save ready (save={_saveKey.Value}, load={_loadKey.Value}; None = disabled)");
        }

        private void Update()
        {
            _notice?.Pump();
        }
    }
}
