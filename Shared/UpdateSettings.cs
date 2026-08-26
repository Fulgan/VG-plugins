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

                // ⚠ NO KEYS AT ALL ANY MORE, and that is the whole change. `Enabled`, `CheckIntervalHours` and the
                // `LastCheckUtc` bookmark existed to describe an AUTOMATIC check: when to run, how often, and
                // whether to run at all. A button answers all three by being pressed, so three keys a player had
                // to find in three separate .cfg files are gone. BepInEx leaves the old entries orphaned in an
                // existing file, which is harmless and is not migrated: there is nothing to migrate them TO.
                var notice = new UpdateNotice(modName, guid, installedVersion)
                {
                    Toast = toast,
                    Log = log,
                };

                // One row on the host's one Updates tab, plus the check it runs. A host from an older mod has
                // neither method and simply shows nothing, which is now the whole feature rather than half of it:
                // there is no unattended check left to run behind a missing row.
                try
                {
                    var host = VGModSettings.GetOrCreate();
                    host.RegisterUpdateRow(modName, notice.Status, notice.Url);
                    host.RegisterUpdateCheck(modName, notice.CheckNow);
                }
                catch (Exception e) { Warn(log, "update row not registered: " + e.Message); }

                // NOT STARTED HERE. It used to check from `Awake`, which is what made it something the player had
                // to opt out of rather than into.
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
