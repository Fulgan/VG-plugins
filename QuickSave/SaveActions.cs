using System;
using UnityEngine;
using VG.Game;

namespace QuickSave
{
    // Quick save / quick load, each on one hotkey and one fixed slot.
    //
    // WHICH load call to make was decided by reading the game's IL, and the obvious names are the wrong ones:
    //
    //   LoadGameUI.DoExecuteAction()  =  if (selectedFile != null) GameManager.Instance.LoadGame(selectedFile)
    //   SaveGameFile.LoadSaveGame()   =  SaveGame.LoadState(this.Recall())      <- raw state apply, no orchestration
    //   SaveGame.LoadLatestSave()     =  GetLatestSave().LoadSaveGame()          <- so THIS one is the unsafe path
    //
    // ∴ `GameManager.Instance.LoadGame(file)` is what the menu button does and the only call that gets the loading
    // screen and scene teardown. `LoadLatestSave` reads like the intended API while being the dangerous one.
    //
    // Everything is best-effort and never throws into game code.
    internal static class SaveActions
    {
        // One slot each, always. Not a rotation: an autosave ring is the game's own concern (`AutosaveSlots`,
        // `StoreAutosaveState`) and racing it from outside would fight its bookkeeping.
        internal const string SlotName = "quicksave";

        // Written immediately BEFORE a load, so an accidental press is recoverable from the game's own menu. A
        // quick load discards everything since the last save; a hotkey that can silently cost an hour needs an
        // undo, and one extra slot is the whole price of it.
        internal const string UndoSlotName = "quicksave-undo";

        // A LOAD is asynchronous — `GameManager.LoadGame` starts the work and returns — so the guard has to outlive
        // the CALL (see Shared/Cooldown.cs).
        //
        // This is the CEILING, not the measurement: `LoadDone` releases sooner, as soon as the game reports the new
        // world ready. It stays SHORT because it is also the fallback when the predicate can never answer true (a
        // renamed member, a load abandoned by a popup), where a long ceiling means minutes of dead hotkey.
        private const float LoadCooldownSeconds = 12f;
        // The world the press was made in still stands for the first frames of a load, so `LoadDone` is not asked
        // before this.
        private const float LoadSettleSeconds = 1f;
        // A save is synchronous, so its own call cannot overlap — but two presses in consecutive frames would still
        // write the file twice for nothing.
        private const float SaveCooldownSeconds = 1.5f;

        // Shared by save AND load: a save must not run while a load is tearing the scene down.
        private static readonly Cooldown Guard = new Cooldown(() => Time.realtimeSinceStartup);

        /// <summary>Write the current state to the quick-save slot.</summary>
        internal static void Save()
        {
            if (Guard.Blocked) { GameToast.Show($"Quick {Guard.Reason} in progress — ignored."); return; }
            try
            {
                // At the main menu there is no run to save, and `DoSave` on no player would either throw or write
                // an empty state that looks loadable.
                if (Source.Player.GamePlayer.current == null)
                {
                    GameToast.Show("Nothing to quick save — no game in progress.");
                    return;
                }
                if (IsEphemeral())
                {
                    GameToast.Show("Nothing to quick save — this run is not saved by the game.");
                    return;
                }
                Guard.Claim("save", SaveCooldownSeconds);
                if (!Write(SlotName)) { GameToast.Show("Quick save unavailable — see the log."); return; }
                GameToast.Show($"Quick saved to \"{SlotName}\".");
                Plugin.Log.LogInfo($"quick saved to \"{SlotName}\"");
            }
            catch (Exception ex)
            {
                // A failed save must SAY so. Silence reads as success, and the player finds out only when the slot
                // they were relying on turns out to be hours old.
                GameToast.Show("Quick save FAILED — see the log.");
                Plugin.Log.LogWarning($"quick save failed: {ex.Message}");
            }
        }

        /// <summary>Load the quick-save slot through the game's own orchestrator.</summary>
        internal static void Load()
        {
            if (Guard.Blocked) { GameToast.Show($"Quick {Guard.Reason} in progress — ignored."); return; }
            try
            {
                var sg = GameMembers.FindType("Source.Util.SaveGame");
                var get = GameMembers.StaticMethod(sg, "GetSaveGame", 1);
                if (get == null) { Plugin.Log.LogWarning("SaveGame.GetSaveGame absent"); return; }
                var file = get.Invoke(null, new object[] { SlotName });
                if (file == null) { GameToast.Show($"No \"{SlotName}\" slot to load."); return; }

                // `Instance` is inherited (GameManager : PersistentSingleton<GameManager>), so this walks the base
                // chain — a lookup on GameManager alone finds nothing.
                var gmT = GameMembers.FindType("Behaviour.GameManager");
                var gm = GameMembers.StaticGetDeep(gmT, "Instance");
                var load = GameMembers.Method(gmT, "LoadGame", 1);
                if (gm == null || load == null)
                {
                    GameToast.Show("Quick load unavailable — see the log.");
                    Plugin.Log.LogWarning($"quick load: GameManager.Instance={gm != null}, LoadGame={load != null}");
                    return;
                }

                // Claim the deadline BEFORE starting the load: everything after this point is asynchronous, so a
                // second press must already be refused by the time the first one hands off to the game. The pair
                // captured here is the epoch `LoadDone` compares against — both null at the main menu, which is
                // right: there is no previous run for the load to be confused with.
                var priorPlayer = (object)Source.Player.GamePlayer.current;
                var priorPoi = CurrentPoiManager();
                Guard.Claim("load", LoadCooldownSeconds, () => LoadDone(priorPlayer, priorPoi), LoadSettleSeconds);

                // Safety net. A failure here must NOT block the load the player asked for, so it only warns.
                if (Source.Player.GamePlayer.current != null)
                {
                    try { Write(UndoSlotName); }
                    catch (Exception ex) { Plugin.Log.LogWarning($"pre-load undo save failed: {ex.Message}"); }
                }

                // Said BEFORE the call: the scene is about to be torn down and a toast into a dying UI is not seen.
                GameToast.Show($"Loading \"{SlotName}\"…");
                Plugin.Log.LogInfo($"quick loading \"{SlotName}\" (undo slot: \"{UndoSlotName}\")");
                load.Invoke(gm, new object[] { file });
            }
            catch (Exception ex)
            {
                GameToast.Show("Quick load FAILED — see the log.");
                Plugin.Log.LogWarning($"quick load failed: {ex.Message}");
            }
        }

        // "Is the load over?" — the moment the game itself considers the player back in control:
        // `BasePoiManager.InitializationComplete` hides the loading screen one yield before setting
        // `initializedAndReady`.
        //
        // Each test rules out a different half-built moment:
        //  - `LoadState` installs the new player BEFORE asking the loader to rebuild, so a new player alone means
        //    only that deserialization happened;
        //  - the manager's IDENTITY is the world's epoch, one instance per built world registered in its `Awake`.
        //    `BasePoiManager.current` is `TravelManager.localPoiManager`, which the load path never clears, so
        //    whether it reads null in the gap depends on scene composition rather than on code. Requiring a
        //    DIFFERENT instance holds either way;
        //  - a manager from an unloaded scene is destroyed but still carries `initializedAndReady == true`, and a
        //    destroyed `UnityEngine.Object` is not null as a managed reference — nor does reading a plain
        //    auto-property off it throw. Unity's own `==` is what distinguishes them.
        //
        // Name-based: a renamed member reads as null, this answers false, and the deadline runs out instead.
        private static bool LoadDone(object priorPlayer, object priorPoi)
        {
            var player = (object)Source.Player.GamePlayer.current;
            if (player == null || ReferenceEquals(player, priorPlayer)) return false;

            var poi = CurrentPoiManager();
            if (poi == null || ReferenceEquals(poi, priorPoi)) return false;
            if (poi as UnityEngine.Object == null) return false;

            return GameMembers.Get(poi, "initializedAndReady") is bool ready && ready;
        }

        // A run the game refuses to persist (the test arena). Absent member ⇒ false, which is the state every
        // normal playthrough is in.
        private static bool IsEphemeral() =>
            GameMembers.Get(Source.Player.GamePlayer.current, "isEphemeral") is bool e && e;

        // The local POI manager, or null. Its identity is an epoch: one instance per built world.
        private static object CurrentPoiManager() =>
            GameMembers.StaticGetDeep(GameMembers.FindType("Behaviour.Managers.BasePoiManager"), "current");

        // The ONE writer: the quick-save and the pre-load undo slot both go through it, so they cannot diverge in
        // which call they use or whether they invalidate the save-list cache.
        //
        // Name-based, so both members are covered by the API checks: a renamed member returns null here
        // and must degrade to a logged warning rather than a silent no-save.
        private static bool Write(string slot)
        {
            // `SaveGame.Store` returns without writing when the run is ephemeral, so calling it and reporting
            // success would promise a slot that does not exist — and the undo slot's absence is only discovered
            // at the moment it is needed. Refused here, at the one writer, rather than at each caller.
            if (IsEphemeral()) { Plugin.Log.LogWarning($"\"{slot}\" not written: this run is ephemeral"); return false; }

            var t = GameMembers.FindType("Source.Util.SaveGame");
            var m = GameMembers.StaticMethod(t, "DoSave", 1);
            if (m == null) { Plugin.Log.LogWarning("SaveGame.DoSave absent"); return false; }
            m.Invoke(null, new object[] { slot });
            // The cache the save list is served from is now stale; the game invalidates it on its own paths.
            try { GameMembers.StaticMethod(t, "InvalidateSaveCache", 0)?.Invoke(null, null); } catch { }
            return true;
        }
    }
}
