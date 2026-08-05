using System;

namespace Hypercom
{
    // Anything the web UI does that spends resources or changes the roster gets announced IN GAME as well
    // as logged. Acting on the game from a second screen shouldn't be invisible on the first one: if a
    // purchase happens, the player should see it happen even if they were looking at the game window.
    //
    // Three destinations, all best-effort:
    //   * the game's own on-screen notification (NotificationManager.CreateNotification)
    //   * LogBuffer, which is what GET /log serves back to the web UI
    //   * the BepInEx log, so a transaction is still recoverable after the fact
    //
    // The notification call is discovered by reflection rather than bound directly. LogHooks already
    // patches this type, so the binding exists — but that hook is a read-only postfix, and a UI method's
    // shape (static vs singleton instance) is exactly the kind of thing that shifts between betas. Failing
    // to toast must never fail the transaction that already succeeded.
    internal static class Notify
    {
        // Attribution, phrased as the crew member who did it rather than as the subsystem that logged it —
        // "Your quartermaster bought 1x RailCannon Ammo" reads like the game talking, "Hypercom: bought 1x
        // @RailcannonAmmo" reads like a debug trace. Still identifiable as the web UI's doing.
        private const string Prefix = "Your quartermaster";

        // The on-screen half lives in Shared/GameToast.cs — every plugin needs it, and this one adds only the
        // web log and the BepInEx log on top.
        internal static void Toast(string text, bool warn = false) => VG.Game.GameToast.Show(text, warn);

        // A completed transaction: on screen, in the web log, and in the BepInEx log.
        //
        // `text` must start with a verb ("bought 2x …"), because the speaker is prepended to form one
        // sentence. `speaker` lets a non-stores action attribute itself properly — hiring is the personnel
        // officer's job, not the quartermaster's.
        internal static void Transaction(string kind, string text, string speaker = Prefix)
        {
            var line = $"{speaker} {text}";
            try { LogBuffer.Add(kind, line); } catch { }
            try { Plugin.Log.LogInfo(line); } catch { }
            Toast(line);
        }
    }
}
