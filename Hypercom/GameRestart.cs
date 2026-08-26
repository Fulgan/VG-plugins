using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using UnityEngine;
using VG.Game;

namespace Hypercom
{
    // SAVE AND QUIT, AND CONTINUE ONLY WHEN ASKED — three separate calls, piloted from outside the game.
    //
    // WHY NOTHING IS IMPLICIT. The first version left a MARKER FILE behind and continued the latest save at the
    // next startup. Two things killed it. A launch that nobody asked to resume resumed anyway, which is a decision
    // taken on the player's behalf about their own save. And the marker is consumed by whichever process reads it
    // first: launching the exe directly makes STEAM re-exec the game, so process A ate the marker and process B —
    // the one that actually lives — booted with nothing to act on and sat at the menu. Both faults have the same
    // shape: state left lying around for an unknown reader, in place of a call.
    //
    // ∴ the resume is an ENDPOINT (`POST /debug/continue`), issued to a game that is already up and listening. No
    // marker, no age window, no race with a second process — and a launch continues nothing unless it is told to.
    //
    // WHAT MUST LIVE IN-PROCESS is only what nothing outside can do: saving through the game's own API, quitting
    // through `Application.Quit`, and calling the menu button's own `LoadGame`. The waiting and the launching
    // belong to `tools/restart-game.ps1`, in an environment doorstop never touched.
    //
    // DEBUG-ONLY (`HttpServer.DebugPaths`) and neither mutation fires by accident: both refuse without an explicit
    // confirm, because a mis-typed URL that closes a game or discards a run is a different class of mistake from
    // one that returns a 404.
    internal static class GameRestart
    {
        // The slot the pre-quit save goes to, and the reason it is NAMED rather than a rotation: the game's own
        // autosave ring is its own bookkeeping (`AutosaveSlots`), and a restart writing into it would fight that.
        // `GetLatestSave` picks by write time ∴ this slot IS "continue" once written.
        internal const string SlotName = "hypercom-restart";

        /// <summary>
        /// Continue the latest save, through the menu button's own path. Returns what happened, in words, because
        /// the caller is a script and "false" cannot say which of the reasons it was.
        ///
        /// REFUSES OVER A LIVE RUN: loading on top of one would throw away whatever is being played, and the test
        /// is a SHIP under the player rather than `GamePlayer.current` — measured false at the menu and true in a
        /// run, where the player object alone is not the same question.
        /// </summary>
        internal static string Continue()
        {
            try
            {
                if (InAGame()) return "a game is already loaded";

                var sg = GameMembers.FindType("Source.Util.SaveGame");
                var latest = GameMembers.StaticMethod(sg, "GetLatestSave", 0)?.Invoke(null, null);
                if (latest == null) return "no save to continue";

                // `Instance` is inherited (GameManager : PersistentSingleton<GameManager>) ∴ the lookup walks the
                // base chain; one on GameManager alone finds nothing.
                var gmT = GameMembers.FindType("Behaviour.GameManager");
                var gm = GameMembers.StaticGetDeep(gmT, "Instance");
                var load = GameMembers.Method(gmT, "LoadGame", 1);
                if (gm == null || load == null) return "the game is not ready to load yet";

                // `GameManager.LoadGame` is the MENU BUTTON'S own path and the only one that gets a loading screen
                // and scene teardown; `SaveGame.LoadLatestSave` reads like the intended API and applies state raw.
                // Same choice QuickSave documents, for the same reason.
                Plugin.Log.LogInfo("continue: loading the latest save");
                load.Invoke(gm, new[] { latest });
                return "loading";
            }
            catch (Exception e)
            {
                Plugin.Log.LogWarning($"continue failed: {e.Message}");
                return "failed: " + e.Message;
            }
        }

        /// <summary>
        /// Save (unless refused) and quit. MAIN THREAD ONLY — it touches the game and then ends the process.
        ///
        /// Nothing is left behind for the next launch to find: a caller that wants the run back asks for it
        /// (`Continue`) once the game is up again.
        /// </summary>
        internal static bool Go(bool save)
        {
            var saved = false;
            if (save)
            {
                saved = Write();
                if (!saved) Plugin.Log.LogWarning("quit: nothing saved — a later continue would load an OLDER save");
            }

            GameToast.Show("Hypercom: saving and quitting…");
            Plugin.Log.LogInfo($"quit: saved={saved} — quitting");

            // The game's OWN quit. `Application.Quit` is what raises `OnApplicationQuit`, which is where
            // `GameManager.HandleApplicationQuit` and the Steam stats handler do their own shutdown work —
            // killing the process instead would skip exactly that.
            Application.Quit();
            return saved;
        }

        /// <summary>
        /// Is a RUN in progress — as opposed to a menu with a player object already built? One owner, because the
        /// resume and the diagnostic below must not answer it differently.
        /// </summary>
        private static bool InAGame()
        {
            try { return Source.Player.GamePlayer.current?.currentSpaceShip != null; }
            catch { return false; }
        }

        /// <summary>
        /// WHAT THE RESUME CAN SEE RIGHT NOW, for reading while the game sits at a menu.
        ///
        /// It exists because the first live run of this feature failed with NO EVIDENCE: BepInEx's disk log was
        /// off, so a resume that armed and then abandoned itself left nothing behind, and the two candidate causes
        /// (a player object at the menu, or no save reported) could only be guessed between. Each probe is reported
        /// separately ∴ the next failure names itself.
        /// </summary>
        internal static Dictionary<string, object> Diag()
        {
            var sg = GameMembers.FindType("Source.Util.SaveGame");
            var gmT = GameMembers.FindType("Behaviour.GameManager");
            object latest = null;
            try { latest = GameMembers.StaticMethod(sg, "GetLatestSave", 0)?.Invoke(null, null); } catch { }
            return new Dictionary<string, object>
            {
                ["playerObject"] = Source.Player.GamePlayer.current != null,
                ["inAGame"] = InAGame(),
                ["latestSave"] = latest != null,
                ["latestSaveName"] = latest == null ? null : (Compat.Get(latest, "name")?.ToString() ?? latest.ToString()),
                ["hasSaveGames"] = GameMembers.StaticMethod(sg, "HasSaveGames", 0)?.Invoke(null, null),
                ["gameManager"] = GameMembers.StaticGetDeep(gmT, "Instance") != null,
                ["loadGame"] = GameMembers.Method(gmT, "LoadGame", 1) != null,
            };
        }

        /// <summary>Write the current run to <see cref="SlotName"/>. False when there is nothing to write.</summary>
        private static bool Write()
        {
            try
            {
                if (Source.Player.GamePlayer.current == null) return false;
                // An ephemeral run is one the game itself refuses to store (`SaveGame.Store`), so a "saved"
                // report here would promise a slot that does not exist.
                var eph = Compat.Get(Source.Player.GamePlayer.current, "isEphemeral");
                if (eph is bool b && b) { Plugin.Log.LogWarning("restart: run is ephemeral, not saved"); return false; }

                var t = GameMembers.FindType("Source.Util.SaveGame");
                var m = GameMembers.StaticMethod(t, "DoSave", 1);
                if (m == null) { Plugin.Log.LogWarning("restart: SaveGame.DoSave absent"); return false; }
                // ⚠ A SUCCESSFUL INVOKE IS ⊥ A SUCCESSFUL SAVE, and this returned true on both. `DoSave` is VOID
                // and `SaveGame.Store` never throws: it retries five times, DELETES the partial file, raises its
                // own alert and only `Debug.LogException`s. So a full disk reported "saved and quitting", the quit
                // ran, and the continue afterwards silently loaded an older save — exactly what the `saved = false`
                // path exists to announce.
                //
                // Stamped BEFORE the call with slack for filesystem granularity, so an OLD file in the slot cannot
                // pass: the question is whether THIS call wrote one.
                var before = DateTime.UtcNow.AddSeconds(-5);
                m.Invoke(null, new object[] { SlotName });
                try { GameMembers.StaticMethod(t, "InvalidateSaveCache", 0)?.Invoke(null, null); } catch { }

                var got = GameMembers.StaticMethod(t, "GetSaveGame", 1)?.Invoke(null, new object[] { SlotName });
                var fi = GameMembers.GetPrivate(got, "File") as System.IO.FileInfo;
                if (fi == null || !fi.Exists || fi.LastWriteTimeUtc < before)
                {
                    Plugin.Log.LogWarning("restart: SaveGame.DoSave wrote no slot for " + SlotName
                                          + " — reporting NOT saved rather than quitting on a promise");
                    return false;
                }
                return true;
            }
            catch (Exception e) { Plugin.Log.LogWarning($"restart: save failed: {e.Message}"); return false; }
        }

    }
}
