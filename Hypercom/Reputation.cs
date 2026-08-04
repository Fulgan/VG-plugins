using System;
using System.Collections;
using System.Collections.Generic;
using System.Linq;
using Source.Player;

namespace Hypercom
{
    // Standing with every faction, on the two separate ladders the game tracks — one panel each in the
    // Captain screen:
    //
    //   reputation  one signed value per faction, capped at `Conquest.maxReputation`, negative meaning at war.
    //               Stored as PAIRS between factions, so the player's own standing is the pair whose other
    //               side is the `Player` faction; the same table also holds third-party relations (who hates
    //               whom, independent of you), which are not reported here.
    //   conquest    `playerContribution` per faction, and the Rank1..Rank6 the game derives from it.
    //
    // Everything derived from those two numbers — level, rank, names, colours, thresholds, per-tier perks — comes
    // from the game's own static helpers (`Source.Util.ReputationLevelExtensions`, `ConquestRankExtension`) rather
    // than being recomputed, so a balance change moves this endpoint with it. Reflection throughout: neither helper
    // is on a type this binary references, and the conquest half is absent on a save with no conquest story.
    internal static class Reputation
    {
        private const string PlayerFactionId = "Player";
        private const string RepExt = "Source.Util.ReputationLevelExtensions";
        private const string RankExt = "Source.Util.ConquestRankExtension";
        private const string FactionType = "Source.Galaxy.Faction";
        private const string FactionDataType = "Source.Galaxy.FactionData";

        internal static Api.Result Dto() => MainThread.Run(() =>
        {
            var player = GamePlayer.current;
            if (player == null) return Api.Result.Err(404, "no player (no save loaded?)");

            var repExt = Compat.FindType(RepExt);
            var rankExt = Compat.FindType(RankExt);
            var conquest = ConquestStory();

            var rows = new Dictionary<string, Dictionary<string, object>>();
            var order = new List<string>();
            // Rows come out in the game's own order, so this list is walked FIRST and the conquest pass only
            // fills in rows it already created.
            var factions = AllFactions(out var playerFaction);

            Dictionary<string, object> Row(object faction)
            {
                var id = Compat.Get<string>(faction, "identifier", null);
                if (id == null || id == PlayerFactionId) return null;
                if (!rows.TryGetValue(id, out var row))
                {
                    rows[id] = row = new Dictionary<string, object>
                    {
                        ["id"] = id,
                        ["name"] = Galaxy.FactionName(faction),
                        ["color"] = Galaxy.Hex(Compat.Get(faction, "color")),
                        // War is its OWN state, not a reputation threshold: the game shows "At War" against a
                        // faction sitting at +6751. `IsEnemy` is the only thing that answers it.
                        ["atWar"] = playerFaction == null
                            ? null
                            : Compat.Call(faction, "IsEnemy", playerFaction) as bool?,
                    };
                    order.Add(id);
                }
                return row;
            }

            // ---- reputation ladder -------------------------------------------------------------------
            // Standing is stored as symmetric PAIRS between factions, but the pair LIST is private ∴ it is read
            // the way the game reads it: ask each faction what it thinks of the player.
            foreach (var f in factions)
            {
                var row = Row(f);
                if (row == null) continue;
                var rep = Compat.AsNumber(Compat.Call(f, "GetReputation", playerFaction));
                if (rep != null) row["reputation"] = RepDto(repExt, (int)rep.Value);
            }

            // ---- conquest ladder ---------------------------------------------------------------------
            // Driven by the ELIGIBLE POOL, the way the game's own panel is: `CaptainConquestRanks` iterates
            // `Conquest.conquestFactions` plus Puppeteers. Walking the standings table instead reported whichever
            // factions happened to have acquired an entry, so the endpoint disagreed with the panel about who is
            // in the war at all — a faction yet to acquire a standing still has a rank (None) and still shows —
            // and it never reported the Umbral rank, which the game derives from `umbralContribution` rather than
            // from any standing.
            //
            // Membership is DYNAMIC and the pool is not the roster: `autoPopulatingFactions` re-enter unaided
            // (`HandleEmbassyRejoinLogic` feeds an embassy with no headquarters until it can retake one), while
            // `playerPopulatingFactions` enter through player action. Losing a headquarters sets
            // `rejoinConquestCooldown = 5`, which `JoinConquestSector` spends down before letting them back. So
            // `joins` is reported per faction: without it, "why is this faction here and that one gone" is
            // unanswerable from the response.
            //
            // The standings dictionary is READ, never asked to create. `GetFactionStanding` materialises a
            // missing entry, and answering a GET must not write to the save.
            var standings = Compat.PrivateGet(conquest, "factionStanding") as IDictionary;
            var factionType = Compat.FindType(FactionType);
            var ids = new Func<object, HashSet<string>>(set =>
            {
                var outp = new HashSet<string>();
                foreach (var f in Compat.Enumerate(set))
                {
                    var fid = Compat.Get<string>(f, "identifier", null);
                    if (fid != null) outp.Add(fid);
                }
                return outp;
            });
            var conquestType = conquest?.GetType();
            var autoIds = ids(Compat.StaticGet(conquestType, "autoPopulatingFactions"));
            var playerIds = ids(Compat.StaticGet(conquestType, "playerPopulatingFactions"));

            var pool = new List<object>(Compat.Enumerate(Compat.StaticGet(conquestType, "conquestFactions")));
            // Puppeteers is in the panel but never in the pool, because its contribution lives on the story.
            var puppeteers = Compat.StaticGet(factionType, "puppeteers");
            if (puppeteers != null) pool.Add(puppeteers);

            foreach (var f in pool)
            {
                var row = Row(f);
                if (row == null) continue;
                var fid = Compat.Get<string>(f, "identifier", null);
                var standing = standings != null && standings.Contains(f) ? standings[f] : null;
                var umbral = f == puppeteers ? Compat.Num(conquest, "umbralContribution") : null;
                var dto = ConquestDto(rankExt, f, standing, umbral);
                // Whether this faction can return on its own, needs the player, or is neither (Puppeteers).
                dto["joins"] = autoIds.Contains(fid) ? "auto" : playerIds.Contains(fid) ? "player" : "story";
                // No standing yet ⇒ it has never taken part. Distinct from a standing that has fallen to 0.
                dto["engaged"] = standing != null;
                row["conquest"] = dto;
            }

            var body = new Dictionary<string, object>
            {
                // The game's own order, unsorted: the Reputation panel lists factions in a fixed sequence and a
                // reader comparing the two should find the same rows in the same places.
                ["factions"] = order.Select(id => rows[id]).ToList(),
                // `conquestRepMax` is `Conquest.maxReputation` (30000) — NOT the ladder's top, which the
                // thresholds put at 50000; the two disagree ∴ it is reported under its own name and the SCALE
                // is taken from `levels`. `foeAt` is the point below which a faction is at war with you.
                ["conquestRepMax"] = Compat.Num(conquest, "maxReputation"),
                // STATIC on the type — reading it off the FactionData instance yields nothing.
                ["foeAt"] = Compat.StaticNum(Compat.FindType(FactionDataType), "foeReputation"),
                // The ladders themselves, so a client can draw the scale without hardcoding it. `group` is the
                // game's coarse Negative|Neutral|Positive banding, a level ABOVE the named bands.
                ["levels"] = Ladder(repExt, "ReputationThresholds",
                    lvl => Compat.CallStatic(repExt, "GetReputationCategory", lvl) as string),
                ["ranks"] = Ladder(rankExt, "ConquestRankThresholds", null),
                // The contribution the TOP rank needs. Contribution is not capped there — it keeps climbing
                // past it (observed 5441 against a 4500 "max") ∴ ⊥ presented as a ceiling.
                ["topRankAt"] = Compat.StaticNum(rankExt, "MaxConquestContribution"),
            };
            return Api.Result.Ok(body);
        });

        // One faction's reputation standing: the raw value, the level it lands in, progress through that level,
        // and every perk the level grants. All of it asked of the game.
        private static Dictionary<string, object> RepDto(Type repExt, int rep)
        {
            var level = Compat.CallStatic(repExt, "GetReputationLevel", rep);
            var d = new Dictionary<string, object>
            {
                ["value"] = rep,
                ["level"] = level?.ToString(),
                // The BAND ("Absolute Threat", "Respected") — the enum name is the only handle the game gives
                // it. `GetReputationCategory` is a coarser grouping (Negative|Neutral|Positive) that sits ABOVE
                // the bands, so it can't stand in for the name.
                ["levelName"] = Pretty(level?.ToString()),
                ["group"] = Compat.CallStatic(repExt, "GetReputationCategory", level) as string,
                ["color"] = Galaxy.Hex(Compat.CallStatic(repExt, "GetReputationColor", level)),
                // Where in the current band this sits, and what the next band costs. `progress` is 0-1 across
                // the whole ladder; `bandProgress`/`bandRange` are within this level only.
                ["progress"] = Compat.AsNumber(Compat.CallStatic(repExt, "GetTotalReputationProgress", rep)),
                ["bandProgress"] = Compat.AsNumber(Compat.CallStatic(repExt, "GetCurrentLevelProgress", rep)),
                ["bandRange"] = Compat.AsNumber(Compat.CallStatic(repExt, "GetCurrentLevelRange", rep)),
                ["nextAt"] = Compat.AsNumber(Compat.CallStatic(repExt, "GetNextLevelThreshold", rep)),
                ["toNext"] = Compat.AsNumber(Compat.CallStatic(repExt, "GetNextLevelRequirement", rep)),
            };
            if (level != null)
                d["perks"] = new Dictionary<string, object>
                {
                    // Fractions, not percentages — 0.1 is 10% off.
                    ["shopDiscount"] = Compat.AsNumber(Compat.CallStatic(repExt, "GetShopDiscount", level)),
                    ["shipyardDiscount"] = Compat.AsNumber(Compat.CallStatic(repExt, "GetShipyardDiscount", level)),
                    ["repairCostDiscount"] = Compat.AsNumber(Compat.CallStatic(repExt, "GetRepairCostDiscount", level)),
                    ["repairSpeed"] = Compat.AsNumber(Compat.CallStatic(repExt, "GetRepairSpeedMultiplier", level)),
                    ["missionReward"] = Compat.AsNumber(Compat.CallStatic(repExt, "GetMissionRewardMultiplier", level)),
                    ["bonusMissions"] = Compat.AsNumber(Compat.CallStatic(repExt, "GetBonusMissionAmount", level)),
                    ["boardRefreshTimer"] = Compat.AsNumber(Compat.CallStatic(repExt, "GetMissionBoardRefreshTimer", level)),
                    ["shopRefreshTokens"] = Compat.AsNumber(Compat.CallStatic(repExt, "GetShopRefreshTokens", level)),
                    ["canRefreshShop"] = Compat.CallStatic(repExt, "CanRefreshShop", level) as bool?,
                    ["canRefreshBoard"] = Compat.CallStatic(repExt, "CanRefreshBoard", level) as bool?,
                };
            return d;
        }

        // One faction's conquest standing. The rank comes from the faction itself where it will answer, and is
        // otherwise derived from the contribution the same way the game derives it. Rank NAMES are per-faction
        // ("Oracle's Chosen" vs "Commissar" at the same tier), so the identifier is part of the lookup.
        // `contributionOverride` carries the Umbral case: `Faction.GetConquestRank` reads
        // `Conquest.umbralContribution` for Puppeteers instead of a standing, so the figure the rank came from is
        // not on any standing object and has to be passed in. A null standing is normal, not an error — it means
        // the faction is eligible but has never taken part, which is a rank of None and no territory.
        private static Dictionary<string, object> ConquestDto(Type rankExt, object faction, object standing,
                                                             double? contributionOverride = null)
        {
            var contribution = contributionOverride ?? Compat.Num(standing, "playerContribution") ?? 0d;
            // `GetConquestRank` is asked FIRST because it owns the Umbral special case and any future one; the
            // derivation is the fallback for a build where it will not answer.
            var rank = Compat.Call(faction, "GetConquestRank")
                       ?? Compat.CallStatic(rankExt, "GetConquestRankLevel", (int)contribution);
            var id = Compat.Get<string>(faction, "identifier", null);
            var d = new Dictionary<string, object>
            {
                ["contribution"] = contribution,
                ["rank"] = rank?.ToString(),
                ["rankName"] = Str(Compat.CallStatic(rankExt, "GetConquestRankTranslation", rank, id)),
                ["color"] = Galaxy.Hex(Compat.CallStatic(rankExt, "GetConquestColor", rank)),
                // How much of this faction's conquest territory is currently held, and the cooldown before you
                // may rejoin its war after leaving.
                ["areaHeld"] = Compat.Num(standing, "currentConquestArea"),
                ["areaMax"] = Compat.Num(standing, "maxConquestArea"),
                ["conqueredPct"] = Compat.Num(standing, "currentConqueredPercentage"),
                ["rejoinCooldown"] = Compat.Num(standing, "rejoinConquestCooldown"),
            };
            if (rank != null)
                d["perks"] = new Dictionary<string, object>
                {
                    ["creditMultiplier"] = Compat.AsNumber(Compat.CallStatic(rankExt, "GetCreditRewardMultiplier", rank)),
                    ["reputationBonus"] = Compat.AsNumber(Compat.CallStatic(rankExt, "GetReputationBonus", rank)),
                    ["fleetStrengthBonus"] = Compat.AsNumber(Compat.CallStatic(rankExt, "GetFleetStrengthRewardBonus", rank, id)),
                    ["commendationsBonus"] = Compat.AsNumber(Compat.CallStatic(rankExt, "GetMissionCommendationsRewardBonus", rank, id)),
                    ["destroyer"] = Compat.CallStatic(rankExt, "UnlocksDestroyer", rank, id) as bool?,
                };
            return d;
        }

        // A `Dictionary<TEnum,int>` threshold table flattened to an ordered list of `{tier, name, at, group?}`.
        // Sorted by threshold, so the result reads bottom-of-the-ladder first whatever order the dictionary
        // iterates in.
        private static List<Dictionary<string, object>> Ladder(Type owner, string field, Func<object, string> group)
        {
            if (!(Compat.StaticGet(owner, field) is IDictionary table)) return null;
            var rungs = new List<Dictionary<string, object>>();
            foreach (DictionaryEntry e in table)
            {
                var at = Compat.AsNumber(e.Value);
                if (at == null) continue;
                var tier = e.Key?.ToString();
                var rung = new Dictionary<string, object> { ["tier"] = tier, ["name"] = Pretty(tier), ["at"] = at };
                if (group != null) rung["group"] = group(e.Key);
                rungs.Add(rung);
            }
            return rungs.OrderBy(r => (float?)r["at"] ?? 0f).ToList();
        }

        // An enum name as a label: "AbsoluteThreat" → "Absolute Threat". The game keeps no display string for
        // these bands, so the enum name IS the name and only needs its words separated.
        private static string Pretty(string enumName)
        {
            if (string.IsNullOrEmpty(enumName)) return null;
            var sb = new System.Text.StringBuilder(enumName.Length + 4);
            for (var i = 0; i < enumName.Length; i++)
            {
                if (i > 0 && char.IsUpper(enumName[i]) && !char.IsUpper(enumName[i - 1])) sb.Append(' ');
                sb.Append(enumName[i]);
            }
            return sb.ToString();
        }

        // Helper strings from the game are localisation keys as often as not.
        private static string Str(object o)
        {
            var s = o as string;
            return string.IsNullOrEmpty(s) ? null : Stores.Text(s);
        }

        // The band a raw reputation value sits in ("Respected"), for the change log's before/after.
        internal static string LevelName(int rep)
        {
            var repExt = Compat.FindType(RepExt);
            return Pretty(Compat.CallStatic(repExt, "GetReputationLevel", rep)?.ToString());
        }

        // The factions the game's own Reputation panel lists, IN ITS ORDER, and the player's own out-of-band.
        // Reputation lives on the faction (`GetReputation`), not on a reachable pair, so this is the entry
        // point for both ladders.
        //
        // ORDER: `Faction` declares one static field per faction, and the panel's rows follow that declaration
        // order exactly (Luminate, Kolyatov, Stellar, Mindus, Intertrade, …). Those field names are the only
        // handle on it — neither `allFactions` (a dictionary) nor `corporations` (just gold/red/blue) gives it —
        // so they are read in order, and any faction not among them is appended rather than dropped.
        //
        // MEMBERSHIP: these fifteen fields ARE the panel's rows. The three factions left out (Fanatics, Amalgam,
        // HolyRadicals) have static fields too, so the game's filter is not visible from the type — it lives in
        // the panel's scene data. `missionTypes` looked like it (all three have none) but Puppeteers has none
        // either and IS shown, so it only serves as the test for a faction this list does not name: a later
        // build's addition earns a row if standing with it can be earned at all.
        private static readonly string[] PanelOrder =
        {
            "gold", "red", "blue", "miningGuild", "tradingGuild", "salvageGuild", "policeGuild", "bountyGuild",
            "industrialGuild", "stranded", "mercenaryGuild", "darkspacers", "smugglers", "puppeteers", "marauders",
        };

        internal static List<object> AllFactions(out object playerFaction)
        {
            var type = Compat.FindType(FactionType);
            var table = Compat.StaticGet(type, "allFactions") as IDictionary;
            playerFaction = Compat.StaticGet(type, "player")
                            ?? (table != null && table.Contains(PlayerFactionId) ? table[PlayerFactionId] : null);

            var ordered = new List<object>();
            var seen = new HashSet<string>();
            bool Take(object f, bool named)
            {
                var id = Compat.Get<string>(f, "identifier", null);
                if (f == null || id == null || id == PlayerFactionId || !seen.Add(id)) return false;
                if (!named && !Compat.Enumerate(Compat.Get(f, "missionTypes")).Any()) return false;
                ordered.Add(f);
                return true;
            }

            foreach (var field in PanelOrder) Take(Compat.StaticGet(type, field), true);
            foreach (var f in Compat.Enumerate(Compat.StaticGet(type, "all"))) Take(f, false);
            if (table != null) foreach (var f in Compat.Enumerate(table.Values)) Take(f, false);
            return ordered;
        }

        // The rank a contribution buys with THIS faction — titles differ per faction at the same tier.
        internal static string RankTitle(object faction, int contribution)
        {
            var rankExt = Compat.FindType(RankExt);
            var rank = Compat.CallStatic(rankExt, "GetConquestRankLevel", contribution);
            var id = Compat.Get<string>(faction, "identifier", null);
            return Str(Compat.CallStatic(rankExt, "GetConquestRankTranslation", rank, id)) ?? rank?.ToString();
        }

        internal static object ConquestStory()
        {
            foreach (var t in Compat.Enumerate(Compat.Get(GamePlayer.current, "storytellers")))
                if (t != null && t.GetType().Name == "Conquest") return t;
            return null;
        }
    }
}
