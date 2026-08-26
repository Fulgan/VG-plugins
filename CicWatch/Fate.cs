using System;
using System.Collections.Generic;
using HarmonyLib;
using Behaviour.Unit;
using UnityEngine;

namespace CicWatch
{
    // WHICH WAY A CONTACT WENT, WITNESSED AT THE MOMENT IT WENT.
    //
    // A kill and a departure are indistinguishable after the fact: the game destroys the hull's GameObject and drops
    // its guid out of the area for both, and a kill's wreck is a freshly built unit carrying a guid of its own, so
    // there is nothing left for a sweep to read. Most kills leave no wreck at all. ∴ a death has to be caught as it
    // happens, and everything absent that was not caught is a hull that left.
    internal static class Fate
    {
        // How long a death stays on the books. The hull outlives the death effects by a few frames, so the sweep
        // straight after a kill can still see it and the absence is only noticed on the sweep after that. Longer than
        // that span, and shorter than any span in which a guid could be reused.
        private const float Keep = 15f;

        // Guid → when the hull died. A guid nobody asks about is one the plot never held: a kill outside the panel's
        // own bookkeeping, which is why this is pruned rather than merely consumed.
        private static readonly Dictionary<string, float> _died = new Dictionary<string, float>();

        internal static void Install(Harmony harmony)
        {
            // By NAME, like every other game member this mod touches, so an absent member costs a feature and never
            // a load failure.
            var death = AccessTools.Method(typeof(AbstractUnit), "ShowEffectsOnDeath");
            if (death != null)
            {
                harmony.Patch(death, postfix: new HarmonyMethod(typeof(Fate), nameof(AfterDeath)));
                Plugin.Log.LogInfo("fate: watching AbstractUnit.ShowEffectsOnDeath");
            }
            else
                Plugin.Log.LogWarning("AbstractUnit.ShowEffectsOnDeath not found: a hull that is destroyed will be "
                                      + "reported as one that left the area.");
        }

        // THE GUID AND NOTHING ELSE. A hull's rarity, rank and faction are not all assigned at every point the game
        // calls into this mod, and reading them here would put a classification on the death path for no gain: the
        // panel already holds everything it needs to describe a contact it was tracking.
        private static void AfterDeath(AbstractUnit __instance)
        {
            try
            {
                if (Plugin.Cfg == null || !Plugin.Cfg.Enabled.Value || __instance == null) return;
                var guid = __instance.unitData?.guid;
                Seen(guid, __instance);
                if (string.IsNullOrEmpty(guid)) return;
                _died[guid] = Time.unscaledTime;
            }
            catch (Exception e) { Plugin.Log.LogWarning($"death not recorded: {e.Message}"); }
        }

        // THE FIRST FEW DEATHS, NAMED. A fate is the one thing this mod reports that no surface can be checked
        // against afterwards: the hull is gone either way, so a wrong call looks exactly like a right one. Capped,
        // because a long session kills hundreds of hulls and the interesting evidence is the first mismatch.
        private static int _logged;

        private static void Seen(string guid, AbstractUnit unit)
        {
            if (_logged >= 20) return;
            _logged++;
            var what = "?";
            try { what = unit.GetType().Name; } catch { }
            Plugin.Log.LogInfo($"fate: death of {what} guid='{guid}'");
        }

        /// <summary>
        /// Did this hull go down? Asked once per contact that has left the plot, and the answer is CONSUMED: a guid
        /// is only ever reported once, and a hull that leaves and returns must not read as dying twice.
        /// </summary>
        internal static bool Down(string guid)
        {
            return !string.IsNullOrEmpty(guid) && _died.Remove(guid);
        }

        /// <summary>Drop the record. A new area's losses are not this one's.</summary>
        internal static void Forget()
        {
            _died.Clear();
        }

        /// <summary>
        /// Age out deaths nobody claimed. Every kill is recorded, including hulls the panel was never tracking, so
        /// without this the map grows for as long as the session lasts.
        /// </summary>
        internal static void Prune()
        {
            if (_died.Count == 0) return;

            var now = Time.unscaledTime;
            List<string> stale = null;
            foreach (var entry in _died)
                if (now - entry.Value > Keep)
                    (stale ?? (stale = new List<string>())).Add(entry.Key);

            if (stale == null) return;
            foreach (var guid in stale) _died.Remove(guid);
        }
    }
}
