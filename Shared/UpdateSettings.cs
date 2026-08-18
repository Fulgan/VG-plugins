using System;
using BepInEx.Configuration;
using VG.ModApi;

namespace VG.Core
{
    // The three config keys the update check answers to, and the wiring from them to the shared settings window.
    // ONE owner for all of it: three mods each binding their own copy would drift on defaults, on wording, and
    // eventually on what the keys are called, and the keys are the part a player reads in a .cfg file.
    //
    // A mod's whole cost is one Install call and one Pump in its Update loop.
    public static class UpdateSettings
    {
        public const string Section = "Updates";

        /// <summary>
        /// Bind the keys, register the settings row, and start this session's check. Returns the notice to Pump
        /// each frame, or null when it could not be set up: a courtesy notice must never be why a mod failed to
        /// load, so the caller treats null as "no updates feature" and nothing else.
        /// </summary>
        public static UpdateNotice Install(ConfigFile config, string modName, string guid, string installedVersion,
                                          Action<string> toast, Action<string> log)
        {
            try
            {
                if (config == null || string.IsNullOrEmpty(guid) || string.IsNullOrEmpty(installedVersion)) return null;

                var enabled = config.Bind(Section, "Enabled", true,
                    "Check once a day whether a newer " + modName + " has been released, and say so in the mod " +
                    "settings window. Nothing is ever downloaded or installed: the check reads a published version " +
                    "list and shows a link to the release page.");

                var interval = config.Bind(Section, "CheckIntervalHours", 24,
                    new ConfigDescription(
                        "Hours to wait between checks. One check per game session at most, whatever this says.",
                        new AcceptableValueRange<int>(1, 720)));

                // Hidden: it is a bookmark the plugin writes, not a setting. Editing it only moves when the next
                // check is due, and a stamp in the future is treated as "check now" rather than "never again".
                var last = config.Bind(Section, "LastCheckUtc", "",
                    new ConfigDescription(
                        "When the last check ran (UTC). Written by the plugin.",
                        null, new VG.Shared.ConfigurationManagerAttributes { Browsable = false, IsAdvanced = true }));

                var notice = new UpdateNotice(modName, guid, installedVersion)
                {
                    Enabled = () => enabled.Value,
                    IntervalHours = () => interval.Value,
                    LastCheckIso = () => last.Value,
                    SaveLastCheckIso = s => last.Value = s,
                    Toast = toast,
                    Log = log,
                };

                // One row on the host's one Updates tab. A host from an older mod has no such method and simply
                // shows nothing: the check still runs and still toasts.
                try { VGModSettings.GetOrCreate().RegisterUpdateRow(modName, notice.Status, notice.Url); }
                catch (Exception e) { Warn(log, "update row not registered: " + e.Message); }

                notice.Begin();
                return notice;
            }
            catch (Exception e)
            {
                Warn(log, "update notice unavailable: " + e.Message);
                return null;
            }
        }

        private static void Warn(Action<string> log, string message)
        {
            if (log == null) return;
            try { log(message); } catch { }
        }
    }
}
