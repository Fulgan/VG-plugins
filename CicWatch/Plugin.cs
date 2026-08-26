using System;
using BepInEx;
using BepInEx.Logging;
using UnityEngine;
using HarmonyLib;
using VG.ModApi;

namespace CicWatch
{
    // CIC Watch: a combat information centre for the area you are in. A standing readout of what is around you,
    // what of it can be captured, and what is carrying loot, rather than an alert that fires once and is gone.
    //
    // Its own plugin for Quick Save's reason: it shares no surface with the station automation or the bridge, and
    // someone who wants only this should not install either to get it.
    //
    // BETA ONLY, and it says so once rather than pretending. Hull rarity, upgrade points, boarding and even the
    // hook that reports a hull arriving are all absent on the release branch, so there is no reduced version of
    // this mod to run there (see Gate).
    [BepInPlugin(Guid, "CIC Watch", "0.1.0")]
    public sealed class Plugin : BaseUnityPlugin
    {
        internal const string Guid = "fulgan.vanguardgalaxy.cicwatch";
        internal static ManualLogSource Log;
        internal static Config Cfg;

        private void Awake()
        {
            Log = Logger;
            VG.Game.GameToast.Warn = m => Log.LogWarning(m);

            // Config first, whatever the branch: the file is how a player turns things off, and it should exist
            // to be read even where the features cannot run.
            Cfg = new Config(base.Config);

            if (!Gate.Check())
            {
                Log.LogInfo($"CIC Watch is off: this game build has no {Gate.Missing}. "
                            + "The area readout needs the beta branch (hull rarity and boarding).");
                // ⚠ `enabled = false` AND ⊥ ONLY `return`: returning leaves `Update` running, and `Update` drives
                // `Watch.Tick` into `Scan`, which reads the very members this gate just declared missing. A log
                // line saying the mod is off while it keeps running at 4 Hz is the worst of both.
                enabled = false;
                return;
            }

            // Patched only past the gate, which is what keeps the beta-only reads inside these bodies unreached
            // on a build that lacks them: a method is bound when it first RUNS, not when the assembly loads.
            try
            {
                Watch.Install(new Harmony(Guid));
            }
            catch (Exception ex)
            {
                Log.LogWarning($"CIC Watch could not hook arrivals, the area readout is off: {ex.Message}");
                // Same reason as the gate above: "the area readout is off" has to be true of `Update` too.
                enabled = false;
                return;
            }

            // The tab is how a threshold gets changed at all: BepInEx reads the .cfg once at startup, so without
            // it every filter change costs a restart, and the hulls worth watching for are too rare to tune that
            // way. The panel hotkey is NOT registered yet: a key that answers nothing reads as a broken key.
            try
            {
                var host = VGModSettings.GetOrCreate();
                host.SetGameGate(() => VG.Game.GameState.Loaded);
                host.RegisterTab("CIC Watch", Settings.Draw, 5);
                // Registered now that there IS a panel to toggle: a key that answers nothing reads as a broken
                // key. Persistence stays in this plugin's own config through the get/set pair, and the shared host
                // checks the binding against every other mod's.
                // NO HOTKEY. The panel raises itself against the situation and the tab carries a button, so a key
                // would be a third way in that has to be bound, checked for clashes and explained.
            }
            catch (Exception ex) { Log.LogWarning($"could not register the settings tab: {ex.Message}"); }

            // The Updates row, which this mod was the only one missing: it registered no version at all, so the
            // tab listed three mods and left a player wondering whether the fourth had a check that was failing.
            // Registered past the gate with everything else — on a branch where the mod turns itself off there is
            // nothing to tell anyone about.
            _notice = VG.Core.UpdateSettings.Install(base.Config, "CIC Watch", Guid,
                Info.Metadata.Version.ToString(), m => VG.Game.GameToast.Show(m), m => Log.LogInfo(m));

            // `Config` alone is BaseUnityPlugin's own ConfigFile property, so ours is named in full.
            var rules = Cfg.RuleList.Count;
            Log.LogInfo($"CIC Watch ready ({(rules == 0 ? "no rules, nothing will be called" : rules + " rule(s)")}, "
                        + $"quiet plot {(Cfg.QuietLines.Value ? "reported" : "strikes the plot")}).");
        }

        // ONE pass at 4 Hz, whether or not the panel is open: it feeds the panel and it notices the state changes
        // worth a toast. A toast that only fired while a window was open would be pointless.
        private VG.Core.UpdateNotice _notice;

        private void Update()
        {
            // Outside the 4 Hz gate below: the check hands its result over exactly once and `Pump` is what collects
            // it, so throttling this would only delay the row by up to a quarter second for no gain.
            _notice?.Pump();

            if (Time.realtimeSinceStartup - _lastPanelDraw < 0.25f) return;
            _lastPanelDraw = Time.realtimeSinceStartup;
            var here = Watch.Tick();
            if (Panel.IsOpen) Panel.Refresh(here);
        }

        private float _lastPanelDraw;
    }
}
