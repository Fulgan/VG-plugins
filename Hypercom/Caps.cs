using System.Collections.Generic;
using Source.Galaxy.POI;
using Source.Player;
using UnityEngine;

namespace Hypercom
{
    // What the RUNNING game build can actually do.
    //
    // Not every build carries every API this plugin can use. Rather than let the web UI offer a feature that
    // quietly returns null, `/status` reports these flags and the UI hides what isn't there.
    //
    // FEATURE-DETECTED, never version-compared: a member either resolves or it doesn't, which survives a
    // renumbered build and a branch that back-ports something.
    //
    // Only flags that actually gate UI live here. Things believed stable across branches (the play clock,
    // `Inventory.items`) are not worth a flag — if they ever move, that is a bug to fix, not a feature to
    // hide. `SpaceStation` and `GamePlayer` are safe to name: `/status` references both on every branch.
    internal static class Caps
    {
        private static Dictionary<string, object> _dto;

        internal static void Invalidate() { _dto = null; }

        internal static Dictionary<string, object> Dto()
        {
            var cached = _dto;
            if (cached != null) return cached;

            var player = GamePlayer.current;
            var dto = new Dictionary<string, object>
            {
                // Shop restock countdown. Needs the per-station stamp AND the static interval. Probed on the
                // TYPE, not on SpaceStation.current, so the answer doesn't flip to false while undocked.
                ["shopRefresh"] = Compat.HasMember(typeof(SpaceStation), "shopRefreshTime")
                                  && Compat.StaticGet(typeof(SpaceStation), "ShopRefreshInterval") != null,
                // Conquest map + umbral. Present only when the player carries a Conquest storyteller, so this
                // needs a loaded save to answer — hence the caching rule below.
                ["conquest"] = Clock.ConquestSupported(),
            };

            // Only cache once a save is loaded: probed from the main menu, `storytellers` is null and a wrong
            // "no conquest" answer would be frozen for the whole session.
            if (player != null) _dto = dto;
            return dto;
        }
    }
}
