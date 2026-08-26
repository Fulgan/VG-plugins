using System;

namespace VG.Core
{
    // The per-mod glue between the check (UpdateCheck), the wording (Updater) and the two places a player meets
    // it: one row on the shared settings window, and at most one toast per session.
    //
    // Deliberately thin: every rule it obeys lives in Updater, where it is tested. What is HERE is the part that
    // cannot be tested outside the game: when Begin runs, when the result is picked up, and that the toast fires
    // once. Each mod owns one instance and supplies its own config accessors, so this holds no BepInEx type.
    public sealed class UpdateNotice
    {
        private readonly string _modName;
        private readonly string _guid;
        private readonly string _installed;

        private string _latest;
        private string _url;
        private bool _completed;
        private bool _toasted;

        public UpdateNotice(string modName, string guid, string installedVersion)
        {
            _modName = modName;
            _guid = guid;
            _installed = installedVersion;
        }

        /// <summary>Reads the "may I check at all" answer. Null counts as yes.</summary>
        public Func<bool> Enabled;

        /// <summary>Hours between checks. Null falls back to a day.</summary>
        public Func<double> IntervalHours;

        /// <summary>Last check stamp, read from and written back to the mod's own config.</summary>
        public Func<string> LastCheckIso;
        public Action<string> SaveLastCheckIso;

        /// <summary>One line on the game's screen. Called on the main thread, at most once per session.</summary>
        public Action<string> Toast;

        /// <summary>Diagnostics only: never user-facing.</summary>
        public Action<string> Log;

        public bool IsEnabled
        {
            get { try { return Enabled == null || Enabled(); } catch { return false; } }
        }

        /// <summary>Row text for the settings window.</summary>
        public string Status()
        {
            // BEFORE ANYONE PRESSES THE BUTTON THERE IS NOTHING TO REPORT, and the row must say that rather than
            // borrow one of the check's wordings. `checking` would be a lie and `up to date` would be a claim
            // nothing had verified — the state this feature spent the day getting wrong.
            if (!_asked) return string.IsNullOrEmpty(_installed) ? "?" : _installed;
            return Updater.StatusText(_installed, _latest, _completed, IsEnabled);
        }

        /// <summary>Release page for the newer version, or null, which is what hides the row's button.</summary>
        public string Url()
        {
            return _url;
        }

        /// <summary>
        /// Run the check now, because the player asked.
        ///
        /// ⚠ NO INTERVAL AND NO SCHEDULE. This used to start itself from `Awake` and re-run on a daily timer, and
        /// the player's only lever was a config key they had to find in three separate .cfg files. It is a BUTTON
        /// now: nothing leaves the machine unless someone presses it, which is a smaller promise to have to trust
        /// and removes the whole question of when a mod is talking to the network.
        ///
        /// Returns before the request is made. `_asked` stops a second press while one is in flight, since the
        /// request answers on a worker thread and `Pump` is what collects it.
        /// </summary>
        public void CheckNow()
        {
            try
            {
                if (!IsEnabled) return;
                UpdateCheck.Log = Log;
                _asked = true;
                _completed = false;
                // Interval 0 and no bookmark: "due" is not a question a button asks.
                UpdateCheck.Begin(_guid, _installed, null, 0.0);
            }
            catch (Exception e)
            {
                Warn("update check could not start: " + e.Message);
            }
        }

        private bool _asked;

        /// <summary>Whether the player has asked this session, so the row can say "not checked" rather than lie.</summary>
        public bool Asked { get { return _asked; } }

        /// <summary>
        /// Call every frame from the mod's Update. Cheap when there is nothing waiting: the check hands its
        /// result over exactly once, and everything from there is main-thread work.
        /// </summary>
        public void Pump()
        {
            try
            {
                UpdateCheck.Result r;
                if (!UpdateCheck.TryTake(out r)) return;

                _completed = true;
                _latest = r.Latest;
                _url = r.IsNewer ? r.Url : null;   // no link unless there is something to go and read about

                // The stamp is written whatever the answer was: a check that found nothing new still happened,
                // and re-asking every session is the noise the interval exists to prevent.
                if (SaveLastCheckIso != null && !string.IsNullOrEmpty(r.CheckedAtIso))
                {
                    try { SaveLastCheckIso(r.CheckedAtIso); } catch (Exception e) { Warn("stamp not saved: " + e.Message); }
                }

                if (!r.IsNewer || _toasted) return;
                _toasted = true;
                var toast = Toast;
                if (toast == null) return;
                try { toast(Updater.ToastText(_modName, r.Installed, r.Latest)); }
                catch (Exception e) { Warn("toast failed: " + e.Message); }
            }
            catch (Exception e)
            {
                Warn("update notice failed: " + e.Message);
            }
        }

        private void Warn(string message)
        {
            var log = Log;
            if (log == null) return;
            try { log(message); } catch { }
        }
    }
}
