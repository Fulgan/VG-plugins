using Behaviour.Managers;
using Behaviour.UI.NotificationAlert;
using HarmonyLib;
using Source.Data;
using Source.Player;

namespace Hypercom
{
    // Harmony hooks that tee the game's on-screen messages into LogBuffer. Postfixes only read the
    // string argument and never touch game state, so they can't disturb the game (wrapped anyway).
    [HarmonyPatch(typeof(NotificationManager), nameof(NotificationManager.CreateNotification))]
    internal static class NotificationHook
    {
        [HarmonyPostfix]
        private static void Postfix(string text)
        {
            try { LogBuffer.Add("notification", text); } catch { }
        }
    }

    [HarmonyPatch(typeof(EventLogManager), "NewEvent")]
    internal static class EventLogHook
    {
        [HarmonyPostfix]
        private static void Postfix(string log)
        {
            try { LogBuffer.Add("event", log); } catch { }
        }
    }

    // Every gear change funnels through AbstractUnitData.RecalculateLevel (equip/unequip a turret,
    // module, or booster all recompute the ship level). Postfix emits "loadoutChanged" for the current
    // ship only, so the web refreshes loadout + inventory when the player installs gear in-game. Data-layer
    // type (present in both game versions) — no crew/UI typeref, keeps the one-binary rule.
    [HarmonyPatch(typeof(AbstractUnitData), nameof(AbstractUnitData.RecalculateLevel))]
    internal static class LoadoutChangeHook
    {
        [HarmonyPostfix]
        private static void Postfix(AbstractUnitData __instance)
        {
            try
            {
                if (__instance != null && ReferenceEquals(__instance, GamePlayer.current?.currentSpaceShip))
                    EventBus.Emit("loadoutChanged");
            }
            catch { }
        }
    }
}
