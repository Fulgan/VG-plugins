using System;
using System.Collections.Generic;
using Source.Galaxy.POI;
using Source.Player;

namespace Hypercom
{
    // The RELEASE branch's crew, served in the same shape as the beta's officers.
    //
    // Two APIs answer one question. The beta calls them officers (`Source.Personnel.OfficerData`,
    // `GamePlayer.officers`, `SpaceShipData.officers`); the release calls them crew
    // (`Source.Crew.CrewMemberData`, `GamePlayer.crewMembers`, `SpaceShipData.crewMembers`, sized by the same
    // `shipClass.maxOfficers`). `Stores.OfficersDto` reads the beta names with hard typerefs, which is correct
    // there and unusable here: this binary compiles against the BETA assemblies, where no `Source.Crew` type
    // exists to reference. So every read below goes through `Compat` — reflection is not a preference here, it
    // is the only way one binary can serve both.
    //
    // What the release does NOT have is the reason this is a separate reader rather than a widened one: an
    // officer's `chosenBonus`/`GetBonusForStat` pair is what the officer OPTIMIZER scores, and release crew
    // carry no such per-stat bonus at all. The DTO therefore reports `chosenBonus`/`bonusValue` as null, which
    // is the honest answer and what stops a client from ranking on a number that does not exist. Skills stay
    // absent for the same reason: `unlockedNodes` is a different model here and nothing consumes it yet.
    internal static class Crew
    {
        // Is this build's crew reachable through the release names? FEATURE-DETECTED, not version-compared: the
        // member either resolves on the live player or it does not.
        internal static bool Supported(GamePlayer p) => p != null && Compat.Has(p, "crewMembers");

        // The ONE `/officers` envelope, for both branches. They answer the same question through different member
        // NAMES — beta `officers`, release `crewMembers` — and the name happens to be the same on `GamePlayer` as
        // on `SpaceShipData`, so one argument covers both. Everything else that differs is the per-member DTO,
        // which the caller supplies: the beta's is typed and carries bonuses and skills, the release's does not.
        //
        // Read reflectively even on the beta, where the types are available: two copies of this loop is what
        // the duplication check flagged, and a shape served on both branches needs one owner or the odd one out
        // becomes a bug nobody sees until a client hits it.
        internal static Dictionary<string, object> Envelope(string member, Func<object, Dictionary<string, object>> memberDto)
        {
            var p = GamePlayer.current;

            var ships = new List<object>();
            foreach (var s in Compat.Enumerate(Compat.Get(p, "spaceShips")))
            {
                if (s == null) continue;
                var assigned = new List<object>();
                var slots = 0;
                // The slot array is FIXED-LENGTH and its index IS the slot ∴ a null entry is an empty slot and
                // has to survive as a null in the list, or a client cannot tell slot 2 from slot 0.
                foreach (var m in Compat.Enumerate(Compat.Get(s, member)))
                {
                    slots++;
                    assigned.Add(Compat.Get<string>(m, "guid", null));
                }
                ships.Add(new Dictionary<string, object>
                {
                    ["shipGuid"] = Compat.Get<string>(s, "guid", null),
                    ["slots"] = slots,
                    // Null where the build has no such method at all (the release), ⊥ false: a client must not
                    // read "this ship has no bay" out of "this game has no bays".
                    ["hasDroneBay"] = Compat.Call(s, "HasDroneBay"),
                    ["assigned"] = assigned,
                });
            }

            var roster = new List<object>();
            foreach (var m in Compat.Enumerate(Compat.Get(p, member)))
                if (m != null) roster.Add(memberDto(m));

            return new Dictionary<string, object> { ["ships"] = ships, ["officers"] = roster };
        }

        // `/officers` for a RELEASE build: the shared envelope over `crewMembers`, with the release member DTO.
        internal static Dictionary<string, object> Dto() => Envelope("crewMembers", MemberDto);

        // Recruitable crew at the docked station, in `Stores.RecruitsDto`'s shape.
        //
        // The release hires in the BAR: `SpaceStation.bar.availablePatrons`, a mixed list where only the crew
        // patrons carry a `CrewMemberData` (a bar also seats mercenaries and other kinds). Filtering on that
        // member's presence is what keeps a non-crew patron out, rather than a type name that could be renamed.
        //
        // Read-only on purpose: the beta path calls `EnsureOfficersPopulated()` to fill an empty roster, and the
        // bar's equivalent (`CheckUpdatePatrons`) ROLLS new patrons — a read that reshuffles who is on offer
        // would change the game's state behind the player, so an empty bar is reported as empty.
        internal static Dictionary<string, object> RecruitsDto()
        {
            var st = SpaceStation.current;
            var list = new List<object>();
            foreach (var patron in Compat.Enumerate(Compat.Get(Compat.Get(st, "bar"), "availablePatrons")))
            {
                var member = Compat.Get(patron, "crewMember");
                if (member == null) continue;
                list.Add(MemberDto(member));
            }
            return new Dictionary<string, object>
            {
                ["station"] = st?.name,
                ["recruits"] = list,
            };
        }

        // A crew member's skill nodes. `unlockedOnly` applies the game's own rule from `unlockedNodes`:
        // `crewLevelRequired <= level`. Read off `skillNodes` rather than `unlockedNodes` for both lists, so the
        // locked ones remain visible as potential — the filtered property cannot answer "what comes later".
        //
        // Every member is optional here: a node whose `identifier` or `displayName` moved reports null for that
        // field and still lists the skill, which is worth more than dropping it.
        private static List<object> Skills(object m, bool unlockedOnly)
        {
            var list = new List<object>();
            var level = Compat.Num(m, "level") ?? 0f;
            foreach (var n in Compat.Enumerate(Compat.Get(m, "skillNodes")))
            {
                if (n == null) continue;
                var required = Compat.Num(n, "crewLevelRequired") ?? 0f;
                if (unlockedOnly && required > level) continue;
                var id = Compat.Get<string>(n, "identifier", null);
                list.Add(new Dictionary<string, object>
                {
                    ["id"] = id,
                    // Display text goes through the shared translator: a node's `displayName` is a
                    // localization key, and the identifier is the honest fallback when it has no entry.
                    ["name"] = VG.Game.ItemNames.Translate(Compat.Get<string>(n, "displayName", null), id),
                    ["tier"] = Compat.Num(n, "tier"),
                    // The powerful one-per-member skills the beta calls MajorOfficer. Compared by NAME so no
                    // enum member is referenced — the enum exists on both branches, its members need not.
                    ["major"] = Compat.Get(n, "skillNodeLevel")?.ToString() == "MajorOfficer",
                    ["unlock"] = required,
                });
            }
            return list;
        }

        private static Dictionary<string, object> MemberDto(object m) => new Dictionary<string, object>
        {
            ["guid"] = Compat.Get<string>(m, "guid", null),
            ["name"] = Compat.Call(m, "GetFullName") as string,
            ["callsign"] = Compat.Get<string>(m, "callsign", null),
            ["profession"] = Compat.Get(m, "profession")?.ToString(),
            ["rarity"] = Compat.Get(m, "rarity")?.ToString(),
            ["level"] = (int)(Compat.Num(m, "level") ?? 0f),
            ["gender"] = Compat.Get(m, "gender")?.ToString(),
            ["icon"] = Compat.Get<string>(Compat.Get(m, "icon"), "identifier", null),
            // Release crew choose no per-stat bonus ∴ there is nothing to rank them by. Null, never 0: a 0
            // bonus reads as "chose a stat and gets nothing from it", which is a different claim.
            ["chosenBonus"] = null,
            ["bonusValue"] = null,
            // The skills the game's own Officers panel shows. Same two lists the beta serves: `current` is what
            // this level has unlocked, `potential` every node the member can ever get — the difference is what
            // levelling would buy, and one list cannot express it.
            ["current"] = Skills(m, unlockedOnly: true),
            ["potential"] = Skills(m, unlockedOnly: false),
            // Marks a crew member the game will not let you dismiss — no beta equivalent, so it only appears
            // where the member exists.
            ["critical"] = Compat.Has(m, "critical") ? (object)Compat.Get<bool>(m, "critical", false) : null,
            ["hireCost"] = Compat.Num(m, "purchaseCost"),
        };
    }
}
