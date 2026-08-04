using System.Collections.Generic;
using Source.Galaxy.POI;
using Source.Player;
using UnityEngine;

namespace Hypercom
{
    // What the RUNNING game build can actually do.
    //
    // One binary has to load on the public release (0.8.0.15) and on the beta,
    // and the two do not carry the same API. Rather than let the web UI offer a feature that quietly returns
    // null, `/status` reports these flags and the UI hides what isn't there.
    //
    // FEATURE-DETECTED, not version-compared, wherever possible: a member either resolves or it doesn't,
    // which survives a renumbered build and a branch that back-ports something. Crew is the exception — it
    // stays a version gate, because the answer has to be reached WITHOUT touching the crew types at all (a
    // typeref would defeat the purpose) and the release renamed the whole namespace.
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
                // Crew/officers the OPTIMIZER can score — version-gated, see Api.CrewSupported(). False on the
                // release, whose crew carry no per-stat bonus to rank on.
                ["crew"] = Api.CrewSupported(),
                // A crew ROSTER is readable — true on both branches, feature-detected. Separate from `crew`
                // because listing who is aboard and ranking who should be are different capabilities, and the
                // release has the first without the second: a single flag would either hide the roster or offer
                // an optimizer with nothing to optimise.
                ["crewRoster"] = Api.CrewSupported() || Crew.Supported(player),
                // Shop restock countdown. Needs the per-station stamp AND the static interval. Probed on the
                // TYPE, not on SpaceStation.current, so the answer doesn't flip to false while undocked.
                ["shopRefresh"] = Compat.HasMember(typeof(SpaceStation), "shopRefreshTime")
                                  && Compat.StaticGet(typeof(SpaceStation), "ShopRefreshInterval") != null,
                // Conquest map + umbral. Present only when the player carries a Conquest storyteller, so this
                // needs a loaded save to answer — hence the caching rule below.
                ["conquest"] = Clock.ConquestSupported(),
                // Does a turret's damage get cut AGAIN as the battery grows? Release only — a client that scores
                // a set without the ladder over-values every turret it adds there, and one that applies it on
                // the beta under-values them. See Api.ExtraTurretPenalty().
                ["extraTurretPenalty"] = Api.ExtraTurretPenalty(),
            };

            // Only cache once a save is loaded: probed from the main menu, `storytellers` is null and a wrong
            // "no conquest" answer would be frozen for the whole session.
            if (player != null) _dto = dto;
            return dto;
        }
    }
}
