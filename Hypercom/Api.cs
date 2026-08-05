using System;
using System.Collections;
using System.Diagnostics;
using System.Collections.Generic;
using System.Globalization;
using System.Linq;
using static Hypercom.Body;
using Behaviour.Crew;
using Source.SpaceShip;
using Behaviour.Item;
using Behaviour.UI.Spacestation;
using Source.Galaxy.POI;
using Source.Item;
using Source.Player;
using Source.Util;
using UnityEngine;
using VG.Loadout;

namespace Hypercom
{
    // Request handlers. Every method runs its game access inside MainThread.Run so it executes on
    // the Unity main thread; a whole mutation lives in one lambda, making it atomic.
    internal static class Api
    {
        internal readonly struct Result
        {
            internal readonly int Status;
            internal readonly object Body;
            internal Result(int status, object body) { Status = status; Body = body; }
            internal static Result Ok(object body) => new Result(200, body);
            internal static Result Err(int status, string msg)
                => new Result(status, new Dictionary<string, object> { ["error"] = msg });
        }

        // "docked" = inside the station interior. SpaceStation.current stays set in-sector after undock,
        // so it can't represent docked-ness; the interior instance flips on dock/undock (matches the
        // event watcher).
        // Docked = inside the station interior. SpaceStation.current lingers after undock (until you
        // travel away), so it can't detect undock — the interior instance (created on dock, destroyed on
        // undock) can. Single source; Plugin's status poll reads this too.
        internal static bool Docked => SpaceStationInterior.instance != null;
        private static bool Echo => GamePlayer.current?.currentAutopilotSessionStats != null;

        private static AppliedTransient _lastApplied; // last apply, for one-level undo

        // Crew (officer) management changed in the 0.8.1.19 beta and will likely change again, so crew
        // features gate on this. Call on the Unity main thread (reads Application.version).
        // Stable id for the current playthrough — the web uses it to drop cached inventory/loadout when you
        // switch save/playthrough. The game has no persisted "universe seed": the galaxy is generated once at
        // new-game (SeededRandom.Global, itself seeded from DateTime.Now.Ticks) and then serialized whole into
        // Player.map. But every sector gets a Guid.NewGuid() at generation that persists unchanged for the life
        // of the playthrough — so the ordered set of sector guids IS a stable, unique per-playthrough fingerprint
        // (equivalent to a seed). Hashed deterministically (FNV-1a) so it's compact and process-independent.
        // Reflection (Compat) keeps this typeref-free so one binary runs on both game versions. Falls back to
        // commander identity when there's no galaxy yet (main menu / brand-new game).
        // Delegates to the shared store's fingerprint so Hypercom and Station Assistant compute the SAME
        // per-playthrough key (galaxy sector-guid hash; commander fallback). See VG.Loadout.LoadoutStore.
        private static string PlaythroughId(GamePlayer p) => LoadoutStore.PlaythroughKey(p);

        // The current playthrough's key — the ONE accessor every caller uses, request path or not (the ledger
        // stamps every row with it).
        //
        // Never throws: a row worth keeping must not be lost because the save key was unreadable. The guarded
        // call must be `PlaythroughId`, not this method — a self-call here recurses until the stack is gone, and
        // a stack overflow is not catchable, so the `catch` cannot turn it back into a null.
        internal static string CurrentPlaythrough()
        {
            try { return PlaythroughId(GamePlayer.current); } catch { return null; }
        }

        // Crew (officer) features gate on the game version. This binary is built against the beta's
        // Source.Personnel crew API (>= 0.8.1.19); the 0.8.0.15 release renamed it to Source.Crew, whose
        // members this binary doesn't reference — so crew is OFF there. Crucially, every method that
        // touches OfficerData is only *invoked* behind this gate, so it never JIT-compiles (and can't
        // TypeLoad) on a version that lacks the type.
        internal static bool CrewSupported() => GameVersion.IsAtLeast(Application.version, 0, 8, 1, 19);

        // Does a turret's share of a power pool get cut AGAIN as the battery grows? True on the release, whose
        // `AbstractTurret.CalculateAttackPower` scales the share by a ladder on the equivalent-turret count
        // (0.85 past ~2 down to 0.65 past ~6). Beta 0.8.1.19 deleted that formula and raised enemy HP instead.
        //
        // Version-gated because it must be: the ladder is arithmetic inside a method body, so no member's
        // presence can stand in for it. Sharing 0.8.1.19 with the crew gate is coincidence — two unrelated
        // changes that happened to ship in one patch — so it is written out rather than derived from the other.
        internal static bool ExtraTurretPenalty() => !GameVersion.IsAtLeast(Application.version, 0, 8, 1, 19);

        // The barter currency's item identifier, as it arrives in a shop offer's `costItem`.
        private const string VanguardMarkId = "VanguardMark";

        // Every currency THIS BUILD ships, as `{id, name, owned}`.
        //
        // Read out of the item registry by CATEGORY, never by identifier. Two reasons, and the second one is a
        // crash: (1) the set differs per build — the release earns four commendations and has no `VanguardMark`;
        // the beta replaced them with it and the retired entries LINGER in the registry at 0, which is why this
        // reports everything and lets the client filter on holdings (a retired currency and one you simply have
        // none of are indistinguishable from here) — so the answer is only knowable at runtime, data-driven
        // (`InventoryItemType.FromJson`); (2) `CountAvailableItems(string)` reaches the game's implicit
        // `string`→`InventoryItemType` conversion, which INDEXES the registry (`allItems[name]`) ∴ an
        // identifier this build never shipped throws `KeyNotFoundException` rather than answering null or 0.
        // Passing the resolved TYPE is what makes the count safe.
        //
        // The category is matched by NAME so no enum member is referenced: a build whose enum lacks `Currency`
        // yields an empty wallet instead of failing to JIT.
        private static List<object> Wallet(GamePlayer p)
        {
            var rows = new List<Dictionary<string, object>>();
            if (p == null) return new List<object>();
            foreach (var t in Compat.Enumerate(Compat.StaticGet(Compat.FindType("Behaviour.Item.InventoryItemType"), "all")))
            {
                if (!(t is InventoryItemType it) || it.itemCategory.ToString() != "Currency") continue;
                rows.Add(new Dictionary<string, object>
                {
                    ["id"] = it.identifier,
                    // an item's name reaches a client only through ItemNames — a currency's `displayName`
                    // is a localization key on the same terms as ammo's.
                    ["name"] = VG.Game.ItemNames.Pretty(it),
                    ["owned"] = p.CountAvailableItems(it),
                });
            }
            // Ordered by name so the wallet does not reshuffle between polls (the registry's order is a
            // dictionary's, i.e. no order at all).
            rows.Sort((a, b) => string.CompareOrdinal(a["name"] as string, b["name"] as string));
            return rows.ConvertAll(r => (object)r);
        }

        // One currency's holdings out of an already-built wallet, 0 when this build has no such currency.
        private static long Owned(List<object> wallet, string id)
        {
            foreach (var row in wallet)
                if (row is Dictionary<string, object> r && (r["id"] as string) == id)
                    return Convert.ToInt64(r["owned"]);
            return 0L;
        }

        // ---- reads ----

        internal static Result Status() => MainThread.Run(() =>
        {
            var p = GamePlayer.current;
            var roleType = p?.currentSpaceShip?.shipClass?.shipRoleType;
            var wallet = Wallet(p);
            return Result.Ok(new Dictionary<string, object>
            {
                ["docked"] = Docked,
                ["station"] = SpaceStation.current?.name,
                ["lastStation"] = p?.lastStation?.name,
                ["shipGuid"] = p?.currentSpaceShip?.guid,
                ["shipType"] = p?.currentSpaceShip?.shipClass?.displayName, // ship class, e.g. "Chisel Mk I"
                ["role"] = roleType != null ? roleType.GetRole().ToString() : null,
                ["credits"] = VG.Game.Wallet.Balance(p),
                // The PLAYER's level, which is the commander's (`GamePlayer.level => commander.level`). Every
                // "vs mine" filter needs it, and without it a client can only substitute something that is not
                // a level at all — the highest item level owned, which makes the best item's own relative level
                // 0 and every other item negative. Name-based: absent ⇒ null, and the client says so.
                ["level"] = (int?)Compat.Num(p, "level"),
                // Every currency this build has, counted with the same call the shop DTO uses for
                // `costItemOwned` (`CountAvailableItems`) ∴ the header total and an offer's "you have" cannot
                // disagree.
                ["currencies"] = wallet,
                // Kept for clients written before `currencies` existed. 0 where this build ships no such
                // currency, which is a wallet an old client can render as "none" rather than a failed request.
                ["vanguardMarks"] = Owned(wallet, VanguardMarkId),
                ["crewSupported"] = CrewSupported(),
                // What this game build supports, so the UI can hide rather than offer-and-fail. `crewSupported`
                // stays for older clients.
                ["caps"] = Caps.Dto(),
                // Crit context for the web UI's expanded gear ranking. A turret's own "Critical Damage" roll is
                // worth nothing without a chance to crit, and worth MORE the higher that chance is — so a crit
                // build has to be read off the live ship rather than assumed. Ship-wide, hence here and not per
                // item; the statics are the fallback when no ship is instantiated.
                // Whether the numbers below came off the LIVE unit or fell back to class-level statics. The
                // fallbacks are indistinguishable from real readings (`BaseCritChance` 0.03 is a plausible
                // crit chance), and the unit is briefly absent around scene changes — a client that re-scores
                // on a fallback reshuffles its whole ranking for a beat. Says which, so it can hold instead.
                ["statsLive"] = LiveShip(p) != null,
                ["critChance"] = ShipStat(p, EquipStat.CriticalChance, "BaseCritChance"),
                // `GetStat(CriticalChance)` is `(0.03 + GetPrecisionCrit() + additive lines) * multiplier`, so
                // the reported figure alone cannot be split back into "what Precision explains" and "what it
                // does not": additive 0.19 with multiplier 1 and additive 0 with multiplier 1.676 both produce
                // the same reading and disagree the moment Precision changes. A client re-scoring candidate
                // Precision needs the multiplier to separate them.
                ["critChanceMult"] = ShipStatMultiplier(p, EquipStat.CriticalChance),
                ["critDamage"] = ShipStat(p, EquipStat.CriticalDamage, "BaseCritDamage"),
                // One hit can crit several times: each further crit rolls at half the previous chance, capped
                // by this skill node. It scales how much a Critical Damage roll is worth.
                ["megaCrit"] = Compat.AsNumber(Compat.Get(
                    Compat.StaticGet(Compat.FindType("Behaviour.Crew.SkilltreeNode"), "combatMegaCrit"),
                    "currentPoints")),
                // Ship-level POOLS, for the web UI's set-level turret optimisation. Every stat an item rolls
                // registers on the UNIT, not on the item (`AbstractEquipment.GetStat` reads
                // `parent.GetStat(s)` and adds only its `TurretBoostStat` lines), so a Precision or Combat
                // Power roll benefits EVERY turret — which means gear cannot be ranked slot by slot. The
                // client subtracts the currently-equipped turrets' own contributions from these to get the
                // fixed background (hull + crew + modules) and re-adds a candidate set's.
                ["poolCombatPower"] = ShipStat(p, EquipStat.CombatPower, null),
                // The multiplier baked into each reported pool. A client that subtracts an equipped item's own
                // contribution out of a pool, or adds a candidate's in, is mixing a MULTIPLIED total with an
                // unmultiplied part unless it knows this factor: `GetStatRaw` is `(base + Σ additive) * Π
                // multiplier`, and the reactor bracket is only one of those factors — a hull role bonus and any
                // gear or aspect line with `multiplier != 1` land in the same product.
                ["poolCombatPowerMult"] = ShipStatMultiplier(p, EquipStat.CombatPower),
                // The reactor factor is PER STAT: `ApplyReactorModifier` adds this skill node's increase to the
                // COMBAT pool alone, and only while energy usage is at or below half capacity. One
                // `reactorBonus` cannot describe all three pools, so the term travels separately.
                ["combatReactorOutputCP"] = Compat.AsNumber(
                    Compat.Get(Compat.StaticGet(Compat.FindType("Behaviour.Crew.SkilltreeNode"),
                                                "combatReactorOutputCP"), "currentIncrease")),
                ["poolPrecisionMult"] = ShipStatMultiplier(p, EquipStat.Precision),
                ["poolPrecision"] = ShipStat(p, EquipStat.Precision, null),
                // The fire cycle is driven by POOLED stats, not by the firing gun's own rolls:
                //
                //   fireDelay   => _fireDelay   / (1 + GetStat(AttackSpeed))
                //   reloadDelay => _reloadDelay / (1 + GetStat(ReloadSpeed))
                //   maxMagSize  => round(_maxMagSize * (1 + GetStat(MagazineSize)))
                //
                // and `AbstractEquipment.GetStat` is `parent.GetStat(s)` plus that turret's own boost aspects, so
                // one gun's Attack Speed roll speeds up EVERY gun. It matters because per-shot damage divides by
                // `defaultAttacksPerSecond`, which is built from the RAW fields — so the boosted-over-raw ratio is
                // a straight DPS multiplier, and a client scoring a roll against one hardpoint undervalues it by
                // the size of the battery.
                ["poolAttackSpeed"] = ShipStat(p, EquipStat.AttackSpeed, null),
                ["poolReloadSpeed"] = ShipStat(p, EquipStat.ReloadSpeed, null),
                ["poolMagazineSize"] = ShipStat(p, EquipStat.MagazineSize, null),
                // Mining and salvage guns feed pools of their own. A battery of them contributes nothing to
                // CombatPower, so without these there is no number to compare two mining lasers by. All three
                // pools are `reactorAffectedStats`, so each carries the same bracket.
                ["poolMiningPower"] = ShipStat(p, EquipStat.MiningPower, null),
                ["poolSalvagePower"] = ShipStat(p, EquipStat.SalvagePower, null),
                // Same reason as the combat pool: each of these is a product, and a client subtracting an
                // equipped gun's own power out of one — or adding a candidate's in — needs the factor to do it
                // in the space the contributions actually live in.
                ["poolMiningPowerMult"] = ShipStatMultiplier(p, EquipStat.MiningPower),
                ["poolSalvagePowerMult"] = ShipStatMultiplier(p, EquipStat.SalvagePower),
                // `GetEquivalentTurretsCount(CombatPower)` — the divisor that shares the power pool out, so
                // adding a gun lowers every gun's per-shot damage. It is asked PER STAT: the count for
                // MiningPower excludes the cannons, so a mixed battery does not dilute one pool with the other's
                // guns.
                ["equivalentTurrets"] = Compat.AsNumber(Compat.Call(LiveShip(p), "GetEquivalentTurretsCount", EquipStat.CombatPower)),
                ["equivalentTurretsMining"] = Compat.AsNumber(Compat.Call(LiveShip(p), "GetEquivalentTurretsCount", EquipStat.MiningPower)),
                ["equivalentTurretsSalvage"] = Compat.AsNumber(Compat.Call(LiveShip(p), "GetEquivalentTurretsCount", EquipStat.SalvagePower)),
                // Crit chance is DERIVED from pooled Precision, not rolled: `0.03f + GetPrecisionCrit()`,
                // where the divisor is `25 * GameMath.DamageMultiplier(level)` and the curve soft-caps past
                // 5% (`^0.75`). Sent as the divisor so the client reproduces the game's own curve instead of
                // approximating it.
                ["precisionDivisor"] = PrecisionDivisor(p),
                // Reactor budget. Energy usage is not a comfort stat: it multiplies the Power, CombatPower,
                // MiningPower and SalvagePower pools by a bracketed modifier (+20% under 50% use, down to
                // -75% past 150%), so fitting one more gun can cost more damage than it adds. Read off the
                // reactor module itself rather than re-summed here, so the figures are the game's own.
                ["energyCapacity"] = ReactorNum(p, "energyCapacity"),
                ["energyUsed"] = ReactorNum(p, "usedCapacity"),
                ["energyUsage"] = ReactorNum(p, "energyUsage"),
                ["reactorBonus"] = ReactorNum(p, "energyBonusOrPenalty"),
                // Extra CombatPower the skill tree grants ON TOP of the bracket, and only while usage is at
                // or under 50% — so the client can't infer it from the bracket table alone.
                ["reactorCombatBonus"] = Compat.AsNumber(Compat.Get(
                    Compat.StaticGet(Compat.FindType("Behaviour.Crew.SkilltreeNode"), "combatReactorOutputCP"),
                    "currentIncrease")),
                ["hasDroneBay"] = Compat.Call(p?.currentSpaceShip, "HasDroneBay") ?? false,
                // Can gear be refitted HERE? A personal hangar is where that happens, and not every station has
                // one — an industry station overrides `HasFacility` to Forge/Airlock/Exit only. Asked through the
                // VIRTUAL method so the override answers, ⊥ by probing `personalHangar`, which the base class
                // constructs for every station and would therefore always say yes.
                ["hasPersonalHangar"] = HasFacility("PersonalHangar"),
                ["playthrough"] = PlaythroughId(p), // stable per save — lets the web drop stale cross-playthrough cache
                ["playthroughName"] = Playthroughs.Name(PlaythroughId(p)), // user-chosen pretty name (null = unnamed)
                ["gameVersion"] = Application.version,
                ["pluginVersion"] = Plugin.Version,
            });
        });

        // The live unit behind the player's current ship. `SpaceShipData` is data and carries no stats, but it
        // holds a back-reference to its own behaviour, and that stays valid while docked — which is when the
        // gear screens are used.
        //
        // `SpaceShip.allShips` is NOT an alternative: it is the ship-CLASS catalog, keyed by internal name and
        // holding templates with pre-equipment stats. Reading a stat off one yields a plausible wrong number.
        private static object LiveShip(GamePlayer p) => Compat.Get(p?.currentSpaceShip, "unit");


        // Does the docked station offer a facility? Named rather than typed so no enum typeref lands on a path
        // served unconditionally. Undocked → false: nothing is on offer out there.
        private static bool HasFacility(string facility)
        {
            try
            {
                var station = SpaceStation.current;
                if (station == null) return false;
                var t = Compat.FindType("Source.Galaxy.POI.SpaceStationFacility");
                if (t == null) return false;
                var value = System.Enum.Parse(t, facility);
                return Compat.Call(station, "HasFacility", value) is bool b && b;
            }
            catch { return false; }
        }

        // A number off the ship's reactor module (capacity, used capacity, usage fraction, bracket modifier).
        // Null when there is no live ship or no reactor fitted — the client hides the panel rather than
        // showing a build as drawing 0 of 0.
        private static float? ReactorNum(GamePlayer p, string member)
            => Compat.Num(Compat.Get(LiveShip(p), "reactorModule"), member);

        // `25 * GameMath.DamageMultiplier(level)` — the denominator Precision is measured against, so the same
        // Precision roll is worth less at higher level. Null when the level or the helper can't be read.
        private static float? PrecisionDivisor(GamePlayer p)
        {
            var level = Compat.Num(p?.currentSpaceShip, "level");
            if (level == null) return null;
            var mult = Compat.AsNumber(Compat.CallStatic(
                Compat.FindType("Source.Util.GameMath"), "DamageMultiplier", level.Value));
            return mult == null ? null : (float?)System.Math.Round(25f * mult.Value);
        }

        // An EFFECTIVE ship-wide stat (ship + hull + crew + equipped gear), read off the LIVE unit — the
        // `SpaceShipData` the player carries is data and has no `GetStat`. Falls back to the class-level
        // default when nothing is instantiated (main menu, or a ship that has never been spawned), so the
        // caller always gets a usable number.
        private static float? ShipStat(GamePlayer p, EquipStat stat, string staticFallback)
        {
            var v = Compat.AsNumber(Compat.Call(LiveShip(p), "GetStat", stat));
            if (v != null || staticFallback == null) return v;
            return Compat.StaticNum(Compat.FindType("Behaviour.Unit.AbstractUnit"), staticFallback);
        }

        // The multiplier half of a stat. `GetStatRaw` is `(base + additive) * multiplier`, and only the product
        // is otherwise observable — no fallback, because inventing 1.0 for a build that cannot report it would
        // assert "nothing multiplies this stat" instead of admitting the reading is unavailable.
        private static float? ShipStatMultiplier(GamePlayer p, EquipStat stat) =>
            Compat.AsNumber(Compat.Call(LiveShip(p), "GetStatMultiplier", stat));

        // The captain SKILL TREE: every node, what is invested in it, and the stat boosts an invested node
        // grants. Read-only.
        //
        // Why the bridge serves it at all: invested nodes are `IEquipStatSource`s that flow through the same
        // `ApplyStatSourceLines` as gear, so they are part of the multiplier and additive terms a client has to
        // reproduce to rank anything. "Which skills are invested" is a model input, not a browser feature.
        //
        // A build is RE-ASSIGNABLE at any station, so this is a SNAPSHOT: the ship identity travels with it and
        // a caller pairing it with an older reading of the same ship is comparing two different worlds.
        internal static Result Skills() => MainThread.Run(() =>
        {
            var p = GamePlayer.current;
            if (p == null) return Result.Err(400, "no player");
            var commander = Compat.Get(p, "commander");
            if (commander == null) return Result.Err(409, "no commander");

            // Invested points come off each TREE, which resolves its own save data — `SkillTreeData` exposes no
            // identifier, so it cannot be joined back to a tree by name and must not be read directly here.
            var investedTotal = 0;

            var trees = new List<object>();
            var treeType = Compat.FindType("Behaviour.Crew.Skilltree");
            foreach (var tree in Compat.Enumerate(Compat.StaticGet(treeType, "all")))
            {
                var tid = Compat.Get<string>(tree, "identifier", null);
                var nodes = new List<object>();
                foreach (var node in Compat.Enumerate(Compat.Get(tree, "allNodes")))
                {
                    var boosts = new List<object>();
                    foreach (var b in Compat.Enumerate(Compat.Get(node, "statBoosts")))
                        foreach (var ln in Compat.Enumerate(Compat.Call(b, "GetStats")))
                            boosts.Add(new Dictionary<string, object>
                            {
                                ["stat"] = Compat.Get(ln, "stat")?.ToString(),
                                ["amount"] = Compat.Num(ln, "amount"),
                                ["multiplier"] = Compat.Num(ln, "multiplier"),
                            });
                    nodes.Add(new Dictionary<string, object>
                    {
                        ["identifier"] = Compat.Get<string>(node, "identifier", null),
                        ["tier"] = Compat.Num(node, "tier"),
                        ["row"] = Compat.Num(node, "row"),
                        ["maxPoints"] = Compat.Num(node, "maxSkillPoints"),
                        ["invested"] = Compat.AsNumber(Compat.Call(node, "CurrentCommanderPoints")),
                        ["requiredPointsInTree"] = Compat.Num(node, "requiredPointsInTree"),
                        ["requiredPointsTotal"] = Compat.Num(node, "requiredPointsTotal"),
                        ["conquestLocked"] = Compat.Get<bool>(node, "conquestLocked", false),
                        // A boost with `multiplier != 1` multiplies its pool rather than adding to it — the
                        // distinction the whole ranking model turns on.
                        ["boosts"] = boosts,
                    });
                }
                var treeInvested = Compat.AsNumber(Compat.Call(tree, "GetInvestedSkillPoints"));
                if (treeInvested != null) investedTotal += (int)treeInvested.Value;
                trees.Add(new Dictionary<string, object>
                {
                    ["identifier"] = tid,
                    ["locked"] = Compat.AsNumber(Compat.Call(tree, "IsLocked")) != null
                        ? (object)(Compat.AsNumber(Compat.Call(tree, "IsLocked")) != 0f) : null,
                    ["masteryLevel"] = Compat.AsNumber(Compat.Call(tree, "GetMasteryLevel")),
                    ["invested"] = treeInvested,
                    ["maxPoints"] = Compat.Num(tree, "maxPoints"),
                    ["nodes"] = nodes,
                });
            }

            // Saved skill BUILDS, and the one in force. The active build is named on the SHIP
            // (`SpaceShipData.skillLoadout`), not on the captain — which is why two hulls can sit on different
            // builds and why `CaptainData.selectedLoadout` resolves by matching that string against the list.
            var builds = new List<object>();
            foreach (var ld in Compat.Enumerate(Compat.Get(commander, "loadouts")))
            {
                var trees2 = new List<object>();
                foreach (var kv in Compat.Enumerate(Compat.Get(ld, "skills")))
                    trees2.Add(Compat.Get<string>(kv, "Key", null));
                builds.Add(new Dictionary<string, object>
                {
                    ["name"] = Compat.Get<string>(ld, "name", null),
                    ["trees"] = trees2,
                });
            }

            return Result.Ok(new Dictionary<string, object>
            {
                // Identity, because a respec or a hull change between two reads makes any pairing meaningless.
                ["shipGuid"] = p.currentSpaceShip?.guid.ToString(),
                ["playthrough"] = CurrentPlaythrough(),
                ["pointsAvailable"] = Compat.AsNumber(Compat.Call(commander, "GetRemainingSkillPoints")),
                ["pointsInvested"] = investedTotal,
                // The build this SHIP is on. Null when the ship names none, which is not the same as "no builds
                // exist" — a caller showing "none" for both would be wrong about one of them.
                ["activeBuild"] = Compat.Get<string>(p.currentSpaceShip, "skillLoadout", null),
                ["selectedIndex"] = Compat.Num(commander, "selectedLoadoutIndex"),
                ["builds"] = builds,
                ["trees"] = trees,
            });
        });

        // Per-SOURCE breakdown of one ship stat — the data behind the game's own stats panel
        // (`AbstractUnit.GetStatsInfoItems`, which walks `statSources` concatenated with `unitData.statBoosts`,
        // so it covers gear, the hull's bonus badge and crew boosts alike).
        //
        // Why it exists: `GetStat` reports a PRODUCT, `(base + Σ additive) * Π multiplier`, and a client that
        // subtracts one item's contribution out of a pool needs to know which factors it is working inside. The
        // totals alone cannot say where a multiplier came from, so a pool that reads 3.24x its additive parts is
        // unattributable without this. Returned in ONE main-thread read, with the ship identity attached: the
        // player can change hull or respec between two calls, and a breakdown paired with the wrong ship is the
        // same class of mistake as scoring one hull's battery against another's pools.
        internal static Result StatSources(string statName) => MainThread.Run(() =>
        {
            var p = GamePlayer.current;
            if (p == null) return Result.Err(400, "no player");
            if (string.IsNullOrEmpty(statName)) return Result.Err(400, "stat required, e.g. ?stat=CombatPower");
            EquipStat stat;
            try { stat = (EquipStat)Enum.Parse(typeof(EquipStat), statName, ignoreCase: true); }
            catch { return Result.Err(400, $"unknown stat \"{statName}\""); }

            var ship = LiveShip(p);
            if (ship == null) return Result.Err(409, "no live ship");

            // Every source the unit aggregates, which is what `AggregateStatLines` itself walks: the
            // components registered on the unit plus the data's stat boosts.
            //
            // Read through `GetStats()`, ⊥ `GetStatLine(stat)`. `AbstractUnit.GetStatsInfoItems` uses the
            // latter, and a source that implements its work in `GetStats()` alone — `ShipUpgradeStatSource`
            // does — is then NAMED in the breakdown while contributing nothing to it. That is what made a hull
            // upgrade's multiplier invisible here and left the additive column short of the total.
            var srcList = new List<object>();
            foreach (var x in Compat.Enumerate(Compat.GetPrivate(ship, "statSources"))) srcList.Add(x);
            foreach (var x in Compat.Enumerate(Compat.Get(Compat.Get(ship, "unitData"), "statBoosts"))) srcList.Add(x);

            var sources = new List<object>();
            var wanted = stat.ToString();
            // A generic `Power` line feeds ALL THREE activity pools: `ApplyStatSourceLines` writes it into
            // CombatPower, MiningPower and SalvagePower at once, and `GetStatsInfoItems` folds it in the same
            // way. Filtering strictly on the named stat drops it, which loses whole modules — a Scanner that
            // reports only `Power` then appears to contribute nothing to salvage.
            var poolStat = wanted == "CombatPower" || wanted == "MiningPower" || wanted == "SalvagePower";
            double addSum = 0;
            double multProduct = 1;
            foreach (var src in srcList)
            {
                if (src == null) continue;
                foreach (var line in Compat.Enumerate(Compat.Call(src, "GetStats")))
                {
                    var lineStat = Compat.Get(line, "stat")?.ToString();
                    var viaPower = poolStat && lineStat == "Power";
                    if (lineStat != wanted && !viaPower) continue;
                    var amount = Compat.Num(line, "amount") ?? 0f;
                    var mult = Compat.Num(line, "multiplier") ?? 1f;
                    addSum += amount;
                    multProduct *= mult;
                    sources.Add(new Dictionary<string, object>
                    {
                        // Through the name owner: a stat source can be an untranslated key (`@SalvagingMastery`)
                        // and a raw one in a client is what the shared translator exists to stop.
                        ["source"] = Stores.Text(Compat.Call(src, "GetName") as string),
                        ["amount"] = amount,
                        ["multiplier"] = mult,
                        // Which pool line this came from, so a caller can see that a Scanner reached salvage
                        // through generic Power rather than a salvage line of its own.
                        ["via"] = viaPower ? "Power" : lineStat,
                    });
                }
            }

            return Result.Ok(new Dictionary<string, object>
            {
                ["stat"] = stat.ToString(),
                // The identity every figure below belongs to, so a caller can refuse a mismatched pairing.
                ["shipGuid"] = p.currentSpaceShip?.guid.ToString(),
                ["shipType"] = p.currentSpaceShip?.shipClass?.name,
                ["total"] = ShipStat(p, stat, null),
                ["multiplier"] = ShipStatMultiplier(p, stat),
                // The breakdown's OWN totals, so a caller can tell whether it accounts for the reported figure
                // instead of assuming it does. `additiveSum` should reach `total / multiplier`, and
                // `multiplierProduct` should reach `multiplier` — where they do not, a contributor is missing
                // and any conclusion drawn from the list is partial.
                ["additiveSum"] = addSum,
                ["multiplierProduct"] = multProduct,
                ["sources"] = sources,
            });
        });

        // Owned officer roster + per-ship officer-slot counts. Crew-only; older builds → error.
        internal static Result Officers() => MainThread.Run(() =>
        {
            // Beta first, because its reader is typed and richer. The release answers the same question under
            // different names and without per-stat bonuses (Crew.cs) ∴ it gets the same envelope with those
            // fields null, rather than a 400 that reads as "this game has no crew" when it plainly does.
            if (CrewSupported()) return Result.Ok(Stores.OfficersDto());
            var p = GamePlayer.current;
            if (Crew.Supported(p)) return Result.Ok(Crew.Dto());
            return Result.Err(400, "crew not supported by this game version");
        });

        // The three galaxy-wide refresh cycles, and nothing else. Same figures `/galaxy` reports, off the same
        // `Clock` calls — one owner, so a change to how a cycle is read reaches both — but without the galaxy
        // attached: a header strip shown on every tab polls this, and polling `/galaxy` for three countdowns
        // would move every system, station and faction to render three lines.
        //
        // Each cycle is a PHASE of the play clock, not a wall clock: `nextIn` with its `interval` is what lets a
        // client tick locally and re-ask only when the cycle turns over. Null where the save has no such cycle
        // (no conquest story) — absent, ⊥ zero, so a client can hide the card instead of showing "due".
        internal static Result Cycles() => MainThread.Run(() => Result.Ok(Clock.CyclesDto()));

        // Recruitable officers at the docked station's Personnel Center (+ hire cost). Docked-only.
        internal static Result Recruits() => MainThread.Run(() =>
        {
            var releaseCrew = !CrewSupported() && Crew.Supported(GamePlayer.current);
            if (!CrewSupported() && !releaseCrew)
                return Result.Err(400, "crew not supported by this game version");
            if (!Docked)
                return Result.Err(403, "not docked");
            // The release recruits from the station BAR rather than a personnel center (Crew.cs), so the venue
            // differs while the answer — who can I hire here, and for how much — does not.
            return Result.Ok(releaseCrew ? Crew.RecruitsDto() : Stores.RecruitsDto());
        });

        // Equipment TEMPLATE catalog — the EquipmentBuilder recipes (stat bands + level/rarity scaling)
        // that instances are rolled from, stamped with the game version. Not rolled instances.
        internal static Result EquipmentCatalog() => MainThread.Run(() =>
        {
            try { return Result.Ok(Catalog.EquipmentDto()); }
            catch (Exception ex) { return Result.Err(500, "catalog failed: " + ex.Message); }
        });

        // Distinct turret types + damage types + module slots that exist in the game (for gear filters).
        internal static Result CatalogTypes() => MainThread.Run(() =>
        {
            try { return Result.Ok(Catalog.TypesDto()); }
            catch (Exception ex) { return Result.Err(500, "catalog types failed: " + ex.Message); }
        });

        // Render a ship's sprite to PNG bytes (null → 404), from the game itself so it always matches the
        // actual (incl. new/beta) ship. The body sprite is `surfaceSprite` on the live unit — often null
        // while docked — so fall back to the class prefab's first SpriteRenderer. Experimental.
        // `cacheKey` is the client's opaque key (game build + ship class). The sprite comes from the ship
        // CLASS, so it's identical for every ship of that class and only changes with the game build —
        // hence cacheable, unlike anything rendered from the live fit.
        internal static byte[] ShipImage(string guid, string cacheKey)
            => CachedRender(string.IsNullOrEmpty(cacheKey) ? null : $"ship:{cacheKey}|{guid}", () => MainThread.Run(() =>
        {
            var ship = string.IsNullOrEmpty(guid) ? GamePlayer.current?.currentSpaceShip : LoadoutCore.FindShip(guid);
            var cls = ship?.shipClass;
            if (cls == null) return null;
            Sprite sp = null;
            try { sp = cls.surfaceSprite?.sprite; } catch { }
            if (sp == null) { try { sp = cls.GetComponentInChildren<SpriteRenderer>(true)?.sprite; } catch { } }
            return RenderSprite(sp);
        }));

        // Render an officer portrait to PNG bytes (null → 404). The icon sprite lives in an atlas, so
        // blit it to a temp RenderTexture and read back the sprite's region — works whether or not the
        // source texture is CPU-readable. Unity-graphics calls → must run on the main thread.
        // Cached like item icons (see CachedRender) — a portrait never changes for a given guid/icon.
        internal static byte[] OfficerPortrait(string guid, string icon) => CachedRender(
            "officer:" + (string.IsNullOrEmpty(guid) ? icon : guid),
            () => MainThread.Run(() => CrewSupported() ? PortraitImpl(guid, icon) : null)); // gate before PortraitImpl so OfficerData never JITs off-version

        // Isolated so its OfficerData typeref only resolves on crew-capable versions (see CrewSupported).
        private static byte[] PortraitImpl(string guid, string icon)
        {
            Sprite sprite = null;
            if (!string.IsNullOrEmpty(guid))
                sprite = GamePlayer.current?.GetOfficer(guid)?.icon?.sprite;
            if (sprite == null && !string.IsNullOrEmpty(icon))
                sprite = OfficerIcons.Get(icon)?.sprite;
            return RenderSprite(sprite);
        }

        // Owned-crew guids per ship slot. Isolated (touches SpaceShipData.officers/OfficerData) — only
        // called behind CrewSupported so it never JITs on a version without the Personnel crew API.
        private static List<string> CollectOfficers(SpaceShipData ship)
        {
            var list = new List<string>();
            if (ship?.officers != null) foreach (var o in ship.officers) list.Add(o?.guid);
            return list;
        }

        // Ship hardpoint layout: each gun mount's normalized position (u,v) on the rendered ship image
        // (/ships/image), + size/index/equipped. For a positional loadout editor overlay. Modules are
        // NOT positional (internal) — returned as a flat list.
        // (u,v) are in image space: origin top-left, (0,0)=top-left corner, (1,1)=bottom-right.
        //
        // `guid` selects any ship the player OWNS; omitted means the current one. The sizes and positions come
        // from the ship CLASS, which every owned ship carries, so this works for a hull sitting in a carrier as
        // well as the one being flown. It is the only place empty hardpoints have a size at all: `/ships` reports
        // each ship's fitted items, and an empty slot has no item to read a size off.
        internal static Result ShipLayout(string guid) => MainThread.Run(() =>
        {
            var p = GamePlayer.current;
            var ship = p?.currentSpaceShip;
            if (!string.IsNullOrEmpty(guid))
            {
                ship = null;
                if (p?.spaceShips != null)
                    foreach (var s in p.spaceShips)
                        if (s != null && s.guid == guid) { ship = s; break; }
                if (ship == null) return Result.Err(404, "no such ship");
            }
            var cls = ship?.shipClass;
            if (cls == null) return Result.Err(404, "no current ship");

            // Use the SAME renderer /ships/image draws from, so overlay coords match the PNG exactly.
            SpriteRenderer sr = null; Sprite sp = null;
            try { sr = cls.surfaceSprite; sp = sr?.sprite; } catch { }
            if (sp == null) { sr = cls.GetComponentInChildren<SpriteRenderer>(true); sp = sr?.sprite; }
            if (sr == null || sp == null) return Result.Err(404, "no ship sprite");
            var b = sp.bounds; // local-space AABB matching the rendered textureRect

            var hardpoints = new List<object>();
            var slots = cls.hardpointSlots;
            if (slots != null)
                for (int i = 0; i < slots.Length; i++)
                {
                    var hp = slots[i];
                    if (hp == null) continue;
                    var local = sr.transform.InverseTransformPoint(hp.transform.position);
                    var u = b.size.x > 0 ? (local.x - b.min.x) / b.size.x : 0.5f;
                    var v = b.size.y > 0 ? (local.y - b.min.y) / b.size.y : 0.5f;
                    var idx = hp.index >= 0 ? hp.index : i;
                    InventoryItemType item = (ship.hardpoints != null && idx < ship.hardpoints.Length) ? ship.hardpoints[idx] : null;
                    hardpoints.Add(new Dictionary<string, object>
                    {
                        ["index"] = idx,
                        ["size"] = hp.size.ToString(),
                        ["rotate"] = hp.rotate,
                        ["u"] = u,
                        ["v"] = 1f - v, // flip: image origin is top-left, sprite bounds bottom-left
                        ["equipped"] = item == null ? null : Stores.ItemDto(item), // full DTO → mainStat/power + tooltip
                    });
                }

            var modules = new List<object>();
            var mslots = cls.moduleSlots;
            if (mslots != null)
                foreach (var m in mslots)
                    if (m != null)
                    {
                        InventoryItemType mi = null;
                        try { mi = ship.GetEquippedItem(m.slot); } catch { }
                        modules.Add(new Dictionary<string, object>
                        {
                            ["slot"] = m.slot.ToString(),
                            ["size"] = m.size.ToString(),
                            ["equipped"] = mi == null ? null : Stores.ItemDto(mi),
                        });
                    }

            return Result.Ok(new Dictionary<string, object>
            {
                ["shipGuid"] = ship.guid,
                ["name"] = cls.displayName,
                ["image"] = new Dictionary<string, object> { ["w"] = Mathf.RoundToInt(sp.textureRect.width), ["h"] = Mathf.RoundToInt(sp.textureRect.height) },
                ["hardpoints"] = hardpoints,
                ["modules"] = modules,
                ["diag"] = new Dictionary<string, object> { ["slotCount"] = slots?.Length ?? 0, ["fromSurfaceSprite"] = cls.surfaceSprite != null },
            });
        });

        // Render an inventory item's icon to PNG (null → 404), by store + item handle. For the gear
        // editor's in-game-style tooltips.
        // Rendered PNGs, keyed by the caller's opaque cache key (the web UI sends the item/officer name
        // — icons are per item TYPE, not per roll). Rendering one means a hop onto the game's main
        // thread plus a full atlas blit + ReadPixels + PNG encode, so a tooltip hover used to pay all
        // of that every single time it appeared. Bounded; dropped wholesale once it grows too large.
        private static readonly Dictionary<string, byte[]> IconCache = new Dictionary<string, byte[]>();
        private const int IconCacheMax = 512;

        // Escape hatch for the web UI's "purge images" action: drop every memoized PNG so the next request
        // re-renders from the game. Needed when art changes WITHOUT the game version changing (a beta
        // hotfix), since the version is what normally invalidates the client's cache key.
        internal static Result PurgeImages()
        {
            int n;
            lock (IconCache) { n = IconCache.Count; IconCache.Clear(); }
            return Result.Ok(new Dictionary<string, object> { ["purged"] = n });
        }

        private static byte[] CachedRender(string cacheKey, Func<byte[]> render)
        {
            if (!string.IsNullOrEmpty(cacheKey))
                lock (IconCache)
                    if (IconCache.TryGetValue(cacheKey, out var hit))
                        return hit;
            var png = render();
            if (png != null && !string.IsNullOrEmpty(cacheKey))
                lock (IconCache)
                {
                    if (IconCache.Count >= IconCacheMax) IconCache.Clear();
                    IconCache[cacheKey] = png;
                }
            return png;
        }

        // The memo key mixes the client's `v` with the REQUEST identity (store+key / slot). `v` alone was
        // unsafe: it's client-supplied, so a duplicated or empty one served the wrong item's icon for
        // everything sharing it. Including the handle means a bad key can at worst miss, never lie.
        internal static byte[] ItemImage(string store, int key, string slot, string cacheKey)
            => CachedRender(string.IsNullOrEmpty(cacheKey) ? null : $"item:{cacheKey}|{store}:{key}:{slot}", () => MainThread.Run(() =>
        {
            InventoryItemType item = null;
            if (!string.IsNullOrEmpty(slot))
            {
                // Equipped item by ship slot — these have no store handle. "t:<i>" hardpoint,
                // "m:<EquipmentSlot>" module, "b:<i>" booster (boosters are an indexed array like
                // hardpoints; without this form every equipped booster was iconless in the comparisons).
                var ship = GamePlayer.current?.currentSpaceShip;
                if (ship != null)
                {
                    if (slot.StartsWith("t:") && int.TryParse(slot.Substring(2), out var i) && ship.hardpoints != null && i >= 0 && i < ship.hardpoints.Length)
                        item = ship.hardpoints[i];
                    else if (slot.StartsWith("b:") && int.TryParse(slot.Substring(2), out var b) && ship.boosters != null && b >= 0 && b < ship.boosters.Length)
                        item = ship.boosters[b];
                    else if (slot.StartsWith("m:"))
                        try { item = ship.GetEquippedItem((EquipmentSlot)Enum.Parse(typeof(EquipmentSlot), slot.Substring(2))); } catch { }
                }
            }
            else
            {
                var inv = Stores.Resolve(store);
                item = (inv != null ? Stores.FindEntry(inv, key) : null)?.item;
            }
            Sprite sp = null;
            try { sp = item?.icon; } catch { }
            return RenderSprite(sp);
        }));

        // Item icon PNG by item-type IDENTIFIER ("VanguardMark"), for an item the player may not own — a barter
        // price names a currency item that has no store slot to address it by, so `/item/image` cannot reach it.
        // `InventoryItemType.all` is the public view over the type registry; matched on `identifier` rather than
        // read out of the private `allItems` dictionary it wraps.
        internal static byte[] ItemIconById(string id) => CachedRender("itemid:" + id, () => MainThread.Run(() =>
        {
            if (string.IsNullOrEmpty(id)) return null;
            var all = Compat.StaticGet(Compat.FindType("Behaviour.Item.InventoryItemType"), "all");
            foreach (var t in Compat.Enumerate(all))
                if (string.Equals(Compat.Get<string>(t, "identifier", null), id, StringComparison.OrdinalIgnoreCase))
                {
                    Sprite sp = null;
                    try { sp = (t as InventoryItemType)?.icon; } catch { }
                    return RenderSprite(sp);
                }
            return null;
        }));

        // Faction badge PNG, keyed by the faction's stable identifier ("Gold", "MiningGuild"). Sourced from the
        // game's own sprite via Faction.GetIcon() — the same art the in-game map draws — rather than the wiki.
        // Reflection-only: `Source.Galaxy.Faction` and its factions table are not worth a typeref here.
        internal static byte[] FactionIcon(string id) => CachedRender("faction:" + id, () => MainThread.Run(() =>
        {
            if (string.IsNullOrEmpty(id)) return null;
            // Resolved through the faction TYPE, never through a faction instance found in the world: the
            // system you are standing in often has no owner, and reaching the table via its `faction` left
            // every badge unresolvable whenever that was true.
            var type = Compat.FindType("Source.Galaxy.Faction");
            var faction = Compat.CallStatic(type, "Get", id);
            if (faction == null)
            {
                // `allFactions` is a private STATIC dictionary keyed by identifier; scan it as a fallback in
                // case a build keys it otherwise.
                var all = Compat.StaticGet(type, "allFactions") as System.Collections.IDictionary;
                if (all != null && all.Contains(id)) faction = all[id];
                foreach (var f in Compat.Enumerate(all?.Values))
                {
                    if (faction != null) break;
                    if (string.Equals(Compat.Get<string>(f, "identifier", null), id, StringComparison.OrdinalIgnoreCase))
                        faction = f;
                }
            }
            return RenderSprite(FactionSprite(faction));
        }));

        // A faction's badge sprite. `Faction.GetIcon()` is the obvious accessor and returns NULL — the art is
        // held by `Behaviour.UI.FactionIconSet`, a component that registers itself per faction as it awakens, so
        // the sprite only exists once some UI carrying it has loaded. Asked for in order of usefulness (full
        // badge → map pip → tiny), with `GetIcon` kept as the fallback in case a build wires it up.
        private static Sprite FactionSprite(object faction)
        {
            if (faction == null) return null;
            var set = Compat.CallStatic(Compat.FindType("Behaviour.UI.FactionIconSet"), "Get", faction);
            return (Compat.Get(set, "fullSize") as Sprite)
                   ?? (Compat.Get(set, "mapIcon") as Sprite)
                   ?? (Compat.Get(set, "tinySize") as Sprite)
                   ?? (Compat.Call(faction, "GetIcon") as Sprite);
        }

        // An aspect's badge PNG, keyed by `EquipAspect.identifier` (the `id` on each item's aspect entry).
        // Sourced from the aspect's own `icon` sprite, so the UI shows the game's art. Found by scanning the
        // aspect table the game loads itself — `EquipAspect.Get(name)` needs the loaded table, and reaching it
        // reflectively keeps this working if that lookup is renamed.
        internal static byte[] AspectIcon(string id) => CachedRender("aspect:" + id, () => MainThread.Run(() =>
        {
            if (string.IsNullOrEmpty(id)) return null;
            var type = Compat.FindType("Behaviour.Equipment.Aspect.EquipAspect");
            var found = Compat.CallStatic(type, "Get", id);
            if (found == null && Compat.PrivateStaticGet(type, "allAspects") is IDictionary all)
            {
                if (all.Contains(id)) found = all[id];
                else
                    foreach (DictionaryEntry e in all)
                        if (string.Equals(Compat.Get<string>(e.Value, "identifier", null), id, StringComparison.OrdinalIgnoreCase))
                        { found = e.Value; break; }
            }
            return RenderSprite(Compat.Get(found, "icon") as Sprite);
        }));

        private static byte[] RenderSprite(Sprite sprite)
        {
            if (sprite == null || sprite.texture == null) return null;
            var tex = sprite.texture;
            var rect = sprite.textureRect; // sprite's pixel region within the atlas (bottom-left origin)
            var w = Mathf.RoundToInt(rect.width);
            var h = Mathf.RoundToInt(rect.height);
            if (w <= 0 || h <= 0) return null;

            var prevActive = RenderTexture.active;
            var rt = RenderTexture.GetTemporary(tex.width, tex.height, 0,
                RenderTextureFormat.ARGB32, RenderTextureReadWrite.sRGB);
            Texture2D readable = null;
            try
            {
                Graphics.Blit(tex, rt);
                RenderTexture.active = rt;
                readable = new Texture2D(w, h, TextureFormat.RGBA32, false);
                // RenderTexture and texture space share the bottom-left origin, so the region maps directly.
                readable.ReadPixels(new Rect(rect.x, rect.y, w, h), 0, 0);
                readable.Apply();
                return readable.EncodeToPNG();
            }
            catch (Exception ex)
            {
                Plugin.Log.LogWarning($"portrait render failed: {ex.Message}");
                return null;
            }
            finally
            {
                RenderTexture.active = prevActive;
                RenderTexture.ReleaseTemporary(rt);
                if (readable != null) UnityEngine.Object.Destroy(readable);
            }
        }

        // ---- /inventories, cached ------------------------------------------------------------------------
        //
        // The DTO is built on the MAIN THREAD, so its cost is a frame the game does not get: a long
        // playthrough's armory is thousands of rows, each read through the game API, and one refresh measured
        // 1.4s of held frame at 8k rows. The app refreshes on dock, undock, ship change and after every apply,
        // and those arrive in bursts — so the same 1.4s was paid several times over for a list that had not
        // changed between them.
        //
        // A SHORT ttl, because the armory also changes from inside the game (loot, a sale at the station
        // counter) where the bridge sees nothing: 4s is long enough to collapse a burst and short enough that
        // nobody watches a stale list. `fresh=1` bypasses it for a deliberate refresh, and every mutation this
        // bridge performs invalidates it outright.
        private const float InvTtlSeconds = 4f;
        private static readonly object InvLock = new object();
        private static object _invBody;
        private static float _invAt = -999f;
        private static string _invKey;

        /**
 * A read whose cost is set by the playthrough, held for a few seconds.
         *
         * ONE owner for both of them: `/inventories` and `/shops` cache for the same reason, key on the same
         * kind of thing (which world am I looking at) and are dropped by the same mutations — written twice
         * they drift, and the one that is forgotten is the one that serves a pre-sale world.
         *
         * The GRAPH is cached, not the serialised text: serialising happens on the connection's thread, so
         * caching text would move ~145ms INTO the frame to save it off-thread.
         */
        private sealed class ReadCache
        {
            private readonly object _gate = new object();
            private readonly float _ttl;
            private Dictionary<string, object> _body;
            private string _key;
            private float _at = -999f;

            internal ReadCache(float ttl) { _ttl = ttl; }

            internal bool TryGet(string key, bool fresh, float now, out Dictionary<string, object> body)
            {
                lock (_gate)
                {
                    body = _body;
                    return !fresh && _body != null && _key == key && now - _at < _ttl;
                }
            }

            internal void Put(string key, Dictionary<string, object> body, float now)
            {
                lock (_gate) { _body = body; _key = key; _at = now; }
            }

            internal void Drop()
            {
                lock (_gate) { _body = null; _at = -999f; }
            }
        }

        private static readonly ReadCache ShopCache = new ReadCache(InvTtlSeconds);

        /// <summary>Drop the cached inventory AND shop DTOs. Called by every path here that moves an item.</summary>
        internal static void InvalidateInventories()
        {
            lock (InvLock) { _invAt = -999f; _invBody = null; }
            // A sale moves items INTO the shop's buy-back stock, so the shop list is as stale as the armory —
            // and a client that refreshes both after selling would otherwise be told the sale never happened.
            ShopCache.Drop();
        }

        internal static Result Inventories(bool fresh = false) => MainThread.Run(() =>
        {
            // Keyed on what decides the SHAPE of the answer, so a dock, an undock or a ship change cannot be
            // served from a cache built for the other state — those change which stores exist, not just counts.
            var key = (Docked ? "d" : "u") + "|" + (CurrentPlaythrough() ?? "") + "|" +
                      (GamePlayer.current?.currentSpaceShip?.guid ?? "");
            var now = UnityEngine.Time.realtimeSinceStartup;
            if (!fresh)
                lock (InvLock)
                    if (_invBody != null && _invKey == key && now - _invAt < InvTtlSeconds)
                        return Result.Ok(_invBody);

            var stores = new List<object>();
            // undocked → cargo only; docked → all three.
            var ids = Docked ? Stores.All : new[] { Stores.Cargo };
            foreach (var id in ids)
            {
                var inv = Stores.Resolve(id);
                if (inv != null)
                    stores.Add(Stores.StoreDto(id, inv));
            }
            // The GRAPH is cached, not the serialised text, and deliberately: serialising happens on the
            // connection's thread (`WriteResponse`), so caching text would mean serialising here instead —
            // inside the frame — trading ~145ms of client latency for ~145ms of extra game stall. A repeat
            // request therefore still pays its own `Json.Write`; it just no longer costs the game anything.
            var body = new Dictionary<string, object> { ["stores"] = stores };
            lock (InvLock) { _invBody = body; _invAt = now; _invKey = key; }
            return Result.Ok(body);
        });

        // Is this offer the player's OWN stock, handed back after a sale? Read by name: the flag is an entry
        // field on a type this binary otherwise only reads through public members, and a shape change here must
        // degrade to "not buy-back" rather than take the endpoint down with it.
        private static bool IsBuyback(Inventory.InventoryItem e)
            => e != null && (Compat.Get<bool>(e, "isSoldByPlayer") || Compat.Get<bool>(e, "buyBack"));

        /**
         * The station's stock.
         *
         * BUY-BACK IS OPT-IN (`?buyback=1`), and that is a scale decision, not a preference: selling a long
         * playthrough's armory hands thousands of rows to the shop, and they arrive in every poll of a list the
         * player is reading for what the STATION sells (measured: 10.2 MB and 843ms of held frame after one
         * 7,891-item sale). What was sold is a list you go LOOKING for, so it is fetched when looked for; the
         * count comes back either way, so the client can offer it rather than hide it.
         */
        internal static Result Shops(bool buyback = false, bool fresh = false) => MainThread.Run(() =>
        {
            if (!Docked) return Result.Err(403, "not docked");
            // Keyed on what decides the SHAPE of the answer: the station, and whether buy-back is in it.
            var key = (CurrentPlaythrough() ?? "") + "|" + (SpaceStation.current?.name ?? "") + "|" + (buyback ? "b" : "-");
            var now = UnityEngine.Time.realtimeSinceStartup;
            if (ShopCache.TryGet(key, fresh, now, out var cached))
                return Result.Ok(cached);

            var shops = new List<object>();
            foreach (var (id, shop) in EnumerateShops())
            {
                var items = new List<object>();
                var sold = 0;
                if (shop.items != null)
                    foreach (var e in shop.items)
                        if (e?.item != null && (e.count > 0 || e.item.HasInfiniteShopSupply())) // hide sold-out
                        {
                            var mine = IsBuyback(e);
                            if (mine)
                            {
                                sold++;
                                if (!buyback) continue;
                            }
                            var dto = Stores.ItemDto(e.item);
                            // The offer's slot IS the handle POST /buy needs. ItemDto only fills `key` for
                            // store entries, so without this a shop offer arrived with key:null and the web
                            // UI had nothing to buy WITH - the buy button could never even be shown.
                            dto["key"] = e.slot;
                            dto["slot"] = e.slot;
                            dto["cost"] = e.cost;
                            dto["costItem"] = e.costItem?.identifier;
                            dto["costItemCount"] = e.costItemCount;
                            // Barter items: how many of the cost currency the player owns (armory+cargo+
                            // material) — so the UI can tell if a barter purchase is actually affordable.
                            if (e.costItem != null)
                                dto["costItemOwned"] = GamePlayer.current?.CountAvailableItems(e.costItem) ?? 0;
                            dto["stock"] = e.item.HasInfiniteShopSupply() ? -1 : e.count;
                            // Only when true: absent means "the station's own stock", which is every row in the
                            // ordinary answer, and a false on each of them is bytes saying nothing.
                            if (mine) dto["buyback"] = true;
                            items.Add(dto);
                        }
                shops.Add(new Dictionary<string, object>
                {
                    ["id"] = id,
                    ["facility"] = id,
                    ["items"] = items,
                    // Reported whether or not the rows are: a client cannot offer to show what it cannot count.
                    ["buybackCount"] = sold,
                });
            }
            // When this stock rolls over. The client needs it because offer keys are slot indices that get
            // REUSED for different goods on restock (see Clock) — knowing the deadline lets it refetch before
            // a click can land on the wrong item. The game shows the same countdown in its shop panel.
            var st = SpaceStation.current;
            var body = new Dictionary<string, object>
            {
                ["shops"] = shops,
                ["station"] = st?.name,
                ["refreshesIn"] = Clock.ShopRefreshIn(st),
                // Reflected: a direct reference to this newer static would fail to JIT where it is absent,
                // taking the whole endpoint with it.
                ["refreshInterval"] = st == null ? null : Compat.StaticGet(st.GetType(), "ShopRefreshInterval"),
            };
            ShopCache.Put(key, body, now);
            return Result.Ok(body);
        });

        // Ship vitals: hull / armor / shield as current-vs-max, plus cargo fill.
        //
        // Members are read reflectively — they are newer than the oldest supported build, and this endpoint is
        // polled. A pair whose max is 0 or unreadable is omitted rather than sent as 0/0, so a ship without a
        // shield generator yields no shield entry at all instead of an empty one.
        //
        // No combat power: the game exposes no ship-level total for it (`BuildStatsJson()` carries HP only,
        // and `statBoosts` has no CombatPower entry).
        internal static Result Vitals() => MainThread.Run(() =>
        {
            var ship = GamePlayer.current?.currentSpaceShip;
            if (ship == null) return Result.Err(404, "no ship");

            void Pair(Dictionary<string, object> into, string key, string curName, string maxName)
            {
                var max = Compat.Num(ship, maxName);
                if (max == null || max <= 0f) return;          // the ship simply doesn't have this
                var cur = Compat.Num(ship, curName);
                into[key] = new Dictionary<string, object> { ["cur"] = cur ?? max, ["max"] = max };
            }

            var d = new Dictionary<string, object>
            {
                ["ship"] = Compat.Call(ship, "GetShipName") as string
                           ?? Compat.Get<string>(Compat.Get(ship, "shipClass"), "displayName", null),
                ["guid"] = Compat.Get<string>(ship, "guid", null),
            };
            Pair(d, "hull", "currentHullHP", "maxHullHP");
            Pair(d, "armor", "currentArmorHP", "maxArmorHP");
            Pair(d, "shield", "currentShieldHP", "maxShieldHP");

            var cap = Compat.Num(ship, "cargoCapacity");
            if (cap != null && cap > 0f)
                d["cargo"] = new Dictionary<string, object>
                {
                    ["cur"] = Compat.Num(ship, "cargoUsed") ?? 0f,
                    ["max"] = cap,
                };
            return Result.Ok(d);
        });

        internal static Result Loadout() => MainThread.Run(() =>
        {
            if (!Docked) return Result.Err(403, "not docked");
            return Result.Ok(Stores.LoadoutDto(GamePlayer.current?.currentSpaceShip));
        });

        // All owned ships + their loadouts (read-only; available anywhere, not just docked).
        internal static Result Ships() => MainThread.Run(() =>
            Result.Ok(new Dictionary<string, object> { ["ships"] = Stores.ShipsDto() }));

        // Consolidated in-game log captured since the bridge started (thread-safe buffer, no game call).
        internal static Result Log() => Result.Ok(new Dictionary<string, object> { ["entries"] = LogBuffer.Recent() });

        // ---- mutations ----

        internal static Result Move(Dictionary<string, object> body) => MainThread.Run(() =>
        {
            if (!Docked) return Result.Err(403, "not docked");
            if (Echo) return Result.Err(409, "ECHO active");
            // Anything past this point moves items, so the cached list is wrong from here on — dropped
            // BEFORE the work rather than after it, so a mutation that fails halfway cannot leave a stale cache.
            InvalidateInventories();

            var from = Str(body, "from");
            var to = Str(body, "to");
            if (!Stores.IsValidStore(from) || !Stores.IsValidStore(to))
                return Result.Err(400, "from/to must be cargo|armory|material");
            if (from == to)
                return Result.Err(400, "from and to are the same store");
            if (!TryInt(body, "key", out var slot))
                return Result.Err(400, "missing item key (slot)");

            var src = Stores.Resolve(from);
            var dst = Stores.Resolve(to);
            if (src == null || dst == null)
                return Result.Err(400, "store unavailable");

            var entry = Stores.FindEntry(src, slot);
            if (entry == null)
                return Result.Err(404, $"item not found in {from}");

            var want = Int(body, "count");
            var n = want <= 0 ? entry.count : Math.Min(want, entry.count);
            n = ClampToSpace(dst, entry.item, n);
            if (n <= 0)
                return Result.Err(400, "no space in destination");

            dst.Add(entry.item, n);
            src.Remove(entry, n);
            return Result.Ok(new Dictionary<string, object> { ["moved"] = n });
        });

        // How long one main-thread job may spend selling before handing the frame back. Every game read and
        // write runs inside that job, so a batch that ran as ONE job would freeze the game for its whole
        // length — and the batch this exists for is a long playthrough's entire armory.
        //
        // A TIME budget, not a row count: what a sale costs is not knowable from here (it was 12ms each while
        // the ledger rewrote its file per row, and a fixed 64 rows then held the frame for 800ms — one frame
        // per chunk, which is a freeze with extra steps). Budgeting the frame instead means a slow sale yields
        // sooner and a fast one gets through more, and neither can turn the batch into a hang.
        private const double SellFrameBudgetMs = 12;

        // ...but always ONE row, however slow it is: a budget that can be exhausted before the first sale would
        // spin forever without selling anything.
        private const int SellMinPerFrame = 1;

        // A cap on one request, so a malformed or hostile body cannot make the bridge hold frames indefinitely.
        private const int SellBatchMax = 25_000;

        // How often a long sale says so on screen. The point is that the player knows the game is working, not
        // that they can count along: a toast per item is 8,000 toasts, which is the same as no message at all.
        private const double SellToastEverySeconds = 2.5;

        /** One sale's outcome — an error carries the status the whole request would have used alone. */
        private struct Sale
        {
            internal int Sold;
            internal long Credits;
            internal int Code;
            internal string Error;
            internal string Name;
            /// Whether the goods reached a shop the player can buy them back from, and why not when they did not.
            internal bool BoughtBack;
            internal string BuybackNote;
        }

        // The refusals every sale shares, plus the cache drop. INVALIDATE FIRST: a route that sells and
        // then invalidates has a window where the next read is served the pre-sale world.
        private static Result? SellGate()
        {
            if (!Docked) return Result.Err(403, "not docked");
            if (Echo) return Result.Err(409, "ECHO active");
            InvalidateInventories();
            return null;
        }

        /**
         * Does the slot still hold what the caller believes it holds? Null when it does.
         *
         * IDENTITY first (`expectId` against `identifier`), because a NAME is not identity: for ammo, materials
         * and boosters `displayName` is a localisation KEY (`@BoosterCombatPower1`) while the DTO's `name` is
         * the resolved text ("Combat Power I") — so a client echoing the name it was shown could never match the
         * raw value, and every booster in a reviewed list was refused with "slot 25 now holds Combat Power I,
 * not Combat Power I".
         *
         * `expectName` stays supported for a client that sends no id, and is compared BOTH raw and resolved:
         * either spelling is the same claim about the same item, and refusing a sale over which one arrived is
         * the guard misfiring rather than working.
         */
        private static bool SameItem(InventoryItemType item, string expectId, string expectName)
        {
            if (item == null) return false;
            if (!string.IsNullOrEmpty(expectId)) return string.Equals(item.identifier, expectId, StringComparison.Ordinal);
            if (string.IsNullOrEmpty(expectName)) return true;      // nothing claimed, nothing to refuse
            var raw = string.IsNullOrEmpty(item.displayName) ? item.identifier : item.displayName;
            return string.Equals(raw, expectName, StringComparison.Ordinal)
                || string.Equals(Stores.Text(raw), Stores.Text(expectName), StringComparison.Ordinal);
        }

        private static string SlotChanged(InventoryItemType item, int slot, string expectId, string expectName)
            => SameItem(item, expectId, expectName) ? null
             : $"inventory changed: slot {slot} now holds \"{Stores.ItemName(item)}\" — refresh the inventory";

        // ONE sale, on the main thread and past the gate. `quiet` suppresses the per-item notice: in a batch the
        // announcement is the batch's, and one toast per row buries every other thing the game wants to say.
        private static Sale SellOne(Dictionary<string, object> row, bool quiet)
        {
            var store = Str(row, "store");
            if (!Stores.IsValidStore(store))
                return new Sale { Code = 400, Error = "store must be cargo|armory|material" };
            if (!TryInt(row, "key", out var slot))
                return new Sale { Code = 400, Error = "missing item key (slot)" };

            var inv = Stores.Resolve(store);
            if (inv == null)
                return new Sale { Code = 400, Error = "store unavailable" };

            var entry = Stores.FindEntry(inv, slot);
            if (entry == null)
                return new Sale { Code = 404, Error = $"item not found in {store}" };

            var item = entry.item;
            // An inventory `key` is a store SLOT, and a slot freed by an earlier sale is refillable by a drop
            // or a /move — so a client that reviewed a list before spending is acting on a handle older than
            // the press. Same guard as /buy, one store over: echo back what you believe you are selling and
            // the sale is refused when the slot disagrees. Optional, so older callers are unchanged.
            var mismatch = SlotChanged(item, slot, Str(row, "expectId"), Str(row, "expectName"));
            if (mismatch != null) return new Sale { Code = 409, Error = mismatch };

            if (!item.canSell || item.missionItem || item.criticalItem
                || VG.Game.ItemFlags.IsFavourited(entry, item) || item.sellValue <= 0)
                return new Sale { Code = 403, Error = "item is not sellable" };

            var want = Int(row, "count");
            var n = want <= 0 ? entry.count : Math.Min(want, entry.count);
            var value = (long)item.sellValue * n;

            var player = GamePlayer.current;
            // Refuse the sale outright if the balance cannot be written: handing over the goods and failing to
            // pay for them is the one outcome worse than not selling.
            if (!VG.Game.Wallet.SetBalance(player, AddClamped(VG.Game.Wallet.Balance(player), value)))
                return new Sale { Code = 500, Error = "could not credit the sale — nothing was sold" };

            var back = Buyback(item, n);

            inv.Remove(entry, n);
            var name = Stores.Text(item.displayName);
            // A sale moves money too, so it gets the same in-game notice and log line as a purchase.
            if (!quiet) Notify.Transaction("sell", $"sold {n}x {name} for {value:N0} cr.");
            // The ledger stays PER ITEM whatever the announcement does: it is the audit trail, and "8,000 items"
            // is not an answer to "what did I sell".
            Ledger.Record("sell", name, item.identifier, n, value, null, 0, store);
            return new Sale { Sold = n, Credits = value, Name = name, BoughtBack = back.ok, BuybackNote = back.note };
        }

        /**
         * Put what was just sold on a shelf the player can buy it back from, and SAY when that is not possible.
         *
         * `SpaceStation.current.shopInventory` is the game's "first non-null shop" convenience, which at a
         * station whose only facility is a bounty office is the bounty office — a shop that holds bounties, not
         * gear. So the goods are offered to the general shop first, then to whatever the station has, and the
         * refusals are counted rather than swallowed: a sale that quietly cannot be undone is exactly the thing
 * a player needs told. Volume is checked before the add, because a shop's capacity is m³ and
         * an armory's worth of gear does not fit in one.
         */
        // ONE owner, in `Shared/GameShops.cs`: Station Assistant sells too, and the two copies of this had the
        // same two faults.
        private static (bool ok, string note) Buyback(InventoryItemType item, int n)
            => VG.Game.GameShops.Shelve(SpaceStation.current, item, n);

        /**
         * Sell one item, or a whole reviewed list in one request.
         *
         * The list form exists because the per-item one cannot be looped at a playthrough's scale: every request
 * costs a round trip AND a main-thread hop, and a hop is serviced once per frame — 8,000 rows is
         * over two minutes of waiting for frames, with the game silent throughout. Batched, the same sale is
         * 8,000 / 64 frames, and the bridge announces it on screen while it works.
         *
 * A batch is not a transaction: each row is guarded and reported on its own (V60's per-entry handles are
         * what make that safe), so one refusal never abandons the rest.
         */
        internal static Result Sell(Dictionary<string, object> body)
        {
            var rows = body != null && body.TryGetValue("items", out var raw) ? raw as List<object> : null;
            if (rows == null)
                return MainThread.Run(() =>
                {
                    var gate = SellGate();
                    if (gate.HasValue) return gate.Value;
                    var r = SellOne(body, quiet: false);
                    if (r.Error == null)
                    {
                        var st = SpaceStation.current;
                        if (st != null) VG.Game.GameShops.Repaint(st.generalShopInventory ?? st.shopInventory);
                    }
                    return r.Error != null
                        ? Result.Err(r.Code, r.Error)
                        : Result.Ok(new Dictionary<string, object>
                        {
                            ["sold"] = r.Sold, ["credits"] = r.Credits,
                            ["boughtBack"] = r.BoughtBack, ["buybackNote"] = r.BuybackNote,
                        });
                });
            if (rows.Count > SellBatchMax)
                return Result.Err(400, $"too many items in one request (max {SellBatchMax})");
            return SellBatch(rows);
        }

        // How many failures a response names. The count is always exact; the list is for the player to read, and
        // a thousand identical "not sellable" lines are not more informative than a dozen.
        private const int SellFailuresReported = 20;

        private static Result SellBatch(List<object> rows)
        {
            var gate = MainThread.Run(SellGate, "POST /sell (batch)");
            if (gate.HasValue) return gate.Value;

            var total = rows.Count;
            var failures = new List<object>();
            // Every refusal COUNTED by reason, whatever the named list holds: the names stop at
            // `SellFailuresReported`, and "6 skipped" without saying six of WHAT is not a report.
            var reasons = new Dictionary<string, int>();
            long credits = 0;
            var sold = 0;
            var failed = 0;
            var at = 0;
            var backOk = 0;
            string backNote = null;
            var lastToast = DateTime.UtcNow;
            var announced = false;
            var started = Stopwatch.StartNew();

            // The ledger keeps its row per sale and writes ONCE for the batch. In the finally, because the rows
            // record money that has already moved.
            Ledger.Defer();
            try
            {
                while (at < total)
                {
                    // Each pass is its own main-thread job: the frame comes back between them, which is what
                    // keeps a batch from reading as a hang. Everything inside runs on that thread, toasts too.
                    MainThread.Run<object>(() =>
                    {
                        if (!announced)
                        {
                            announced = true;
                            Notify.Toast($"Your quartermaster is selling {total:N0} items…");
                        }
                        var frame = Stopwatch.StartNew();
                        var inFrame = 0;
                        while (at < total && (inFrame < SellMinPerFrame || frame.Elapsed.TotalMilliseconds < SellFrameBudgetMs))
                        {
                            var row = rows[at] as Dictionary<string, object>;
                            var r = row == null
                                ? new Sale { Code = 400, Error = "row is not an object" }
                                : SellOne(row, quiet: true);
                            if (r.Error != null)
                            {
                                failed++;
                                reasons.TryGetValue(r.Error ?? "?", out var had);
                                reasons[r.Error ?? "?"] = had + 1;
                                if (failures.Count < SellFailuresReported)
                                    failures.Add(new Dictionary<string, object>
                                    {
                                        ["key"] = row == null ? -1 : (object)Int(row, "key"),
                                        ["name"] = row == null ? null : Str(row, "expectName"),
                                        ["error"] = r.Error,
                                    });
                            }
                            else
                        {
                            sold += r.Sold; credits += r.Credits;
                            if (r.BoughtBack) backOk++;
                            else if (backNote == null) backNote = r.BuybackNote;
                        }
                            at++;
                            inFrame++;
                        }
                        var now = DateTime.UtcNow;
                        if (at < total && (now - lastToast).TotalSeconds >= SellToastEverySeconds)
                        {
                            lastToast = now;
                            Notify.Toast($"Selling… {at:N0} of {total:N0}");
                        }
                        if (at >= total)
                            Notify.Transaction("sell", $"sold {sold:N0} items for {credits:N0} cr."
                                                       + (failed > 0 ? $" ({failed:N0} skipped)" : ""));
                        return null;
                    }, "POST /sell (batch)");
                }
            }
            finally
            {
                Ledger.Flush();
                // ONCE, at the end: the shop grid is rebuilt from the inventory, so doing it per row would be
                // the per-item cost exists to avoid — and the player only sees the end state anyway.
                MainThread.Run<object>(() =>
                {
                    var st = SpaceStation.current;
                    if (st != null) VG.Game.GameShops.Repaint(st.generalShopInventory ?? st.shopInventory);
                    return null;
                }, "POST /sell (repaint)");
            }

            // The per-item cost is what decides whether this reads as a pause or a freeze, and it is not
            // knowable from the code — so it is measured, every time, with the shape that produced it.
            Plugin.Log.LogInfo($"sold {sold:N0} of {total:N0} rows in {started.ElapsedMilliseconds:N0}ms "
                               + $"({started.Elapsed.TotalMilliseconds / Math.Max(1, total):F2}ms/row); "
                               + $"buy-back {backOk:N0}" + (backNote == null ? "" : $", rest not offered: {backNote}"));

            return Result.Ok(new Dictionary<string, object>
            {
                ["sold"] = sold,
                ["credits"] = credits,
                ["failed"] = failed,
                ["failures"] = failures,
                // What can be undone, and why the rest cannot. A sale is irreversible if the goods went nowhere,
                // and the player deciding whether to sell again deserves to know that BEFORE they do.
                ["boughtBack"] = backOk,
                ["buybackNote"] = backNote,
            });
        }

        internal static Result Buy(Dictionary<string, object> body) => MainThread.Run(() =>
        {
            if (!Docked) return Result.Err(403, "not docked");
            if (Echo) return Result.Err(409, "ECHO active");
            // Anything past this point moves items, so the cached list is wrong from here on — dropped
            // BEFORE the work rather than after it, so a mutation that fails halfway cannot leave a stale cache.
            InvalidateInventories();

            if (!TryInt(body, "key", out var slot))
                return Result.Err(400, "missing item key (slot)");
            var want = Int(body, "count");
            if (want <= 0)
                return Result.Err(400, "count must be >= 1");

            var wantShop = Str(body, "shop"); // optional; recommended when slots overlap across shops

            // Find the offer at `slot` in the requested shop (or the first shop that has that slot).
            ShopInventory shop = null;
            string shopId = null;   // which facility shop the offer came from, recorded in the ledger
            Inventory.InventoryItem offer = null;
            foreach (var (id, s) in EnumerateShops())
            {
                if (!string.IsNullOrEmpty(wantShop) && id != wantShop)
                    continue;
                offer = s.items?.FirstOrDefault(i => i?.item != null && i.slot == slot
                                                     && (i.count > 0 || i.item.HasInfiniteShopSupply()));
                if (offer != null) { shop = s; shopId = id; break; }
            }
            if (offer == null)
                return Result.Err(404, "no matching offer in shop(s)");

            var player = GamePlayer.current;
            var cargo = player.currentSpaceShip?.cargo;
            if (cargo == null)
                return Result.Err(400, "no ship cargo");

            var barter = offer.costItem != null;
            if (!barter && offer.cost <= 0)
                return Result.Err(400, "item has no purchasable price");

            // A shop offer's `slot` is an inventory index, not an item identity: a restock refills the same
            // slots with different goods at different prices. A caller may echo back what it believes it is
            // buying, and the purchase is refused when that disagrees with the slot's current occupant.
            // Optional, so callers that don't send it still work.
            var expectName = Str(body, "expectName");
            var expectId = Str(body, "expectId");
            if (!string.IsNullOrEmpty(expectName) || !string.IsNullOrEmpty(expectId))
            {
                // IDENTITY where the caller sends one, and a name matched in BOTH spellings otherwise: for ammo
                // and materials `displayName` is a key like "@RailcannonAmmo" while the DTO's `name` is the
                // resolved text, so comparing raw against a resolved echo refuses every one of them.
                if (!SameItem(offer.item, expectId, expectName))
                    return Result.Err(409, $"shop restocked: slot {slot} now holds \"{Stores.ItemName(offer.item)}\" "
                                           + "— refresh the shop list");
            }
            // Same slot, same item, new price is just as wrong to buy blind.
            if (TryInt(body, "expectCost", out var expectCost))
            {
                var actualCost = barter ? offer.costItemCount : (int)offer.cost;
                if (actualCost != expectCost)
                    return Result.Err(409, barter
                        ? $"cost changed: slot {slot} now wants {actualCost}x, not {expectCost}x — refresh the shop list"
                        : $"price changed: slot {slot} now costs {actualCost:N0} cr, not {expectCost:N0} cr — refresh the shop list");
            }

            // Affordability (credit/barter/stock) + cargo fit via the shared, unit-tested planner; then
            // the game-way mutation. Same flow as StationAssistant's buy paths — one money path.
            var ctx = new VG.Game.BuyContext(player, offer.costItem, (_, w) => ClampToSpace(cargo, offer.item, w));
            var amount = VG.Core.PurchasePlan.Affordable(VG.Game.PurchaseExec.ToOffer(offer), ctx, want);
            if (amount <= 0)
            {
                // Say WHICH limit bit, so the web UI can tell "save up" from "make room". Affordability
                // itself is decided by the shared, unit-tested planner above - never by the client.
                var have = barter
                    ? (long)(player.CountAvailableItems(offer.costItem))   // same source as the DTO's costItemOwned
                    : VG.Game.Wallet.Balance(player);
                var need = barter ? (long)offer.costItemCount : (long)offer.cost;
                var reason = have < need
                    ? (barter
                        ? $"need {need}x {Stores.ItemName(offer.costItem) ?? "item"}, have {have}"
                        : $"need {need:N0} cr, have {have:N0}")
                    : "no cargo space";
                return Result.Err(409, $"cannot buy: {reason}");
            }

            var spent = barter ? 0L : (long)offer.cost * amount;
            VG.Game.PurchaseExec.Apply(player, shop, offer, cargo, amount);

            // Announce it in game as well as in the log: a purchase made from the web UI shouldn't be
            // invisible on the game screen.
            // Translate the name: `displayName` is a raw key for ammo and materials ("@RailcannonAmmo"), and
            // that is not something to put on the player's screen.
            var boughtName = Stores.Text(offer.item.displayName);
            Notify.Transaction("buy", barter
                ? $"bartered for {amount}x {boughtName}."
                : $"bought {amount}x {boughtName} for {spent:N0} cr.");
            // Signed from the player's side so a running total is a plain sum; a barter purchase moves no
            // credits and records the goods handed over instead.
            Ledger.Record("buy", boughtName, offer.item.identifier, amount, -spent,
                          barter ? offer.costItem?.identifier : null,
                          barter ? offer.costItemCount * amount : 0,
                          shopId);

            return Result.Ok(new Dictionary<string, object>
            {
                ["bought"] = amount,
                ["spent"] = spent,
                ["barter"] = barter,
            });
        });

        // ---- loadout apply / undo / pending ----

        // Apply a partial additive transient: gear best-match + officers by guid. Docked → apply now
        // (tracked for undo); undocked → queue exactly one pending, applied on next dock. ECHO-refused.
        internal static Result LoadoutApply(Dictionary<string, object> body) => MainThread.Run(() =>
        {
            if (Echo) return Result.Err(409, "ECHO active");
            var gear = ParseGear(body);          // fingerprint slots (finder)
            var officers = ParseOfficers(body);
            var hasDirect = HasDirectSlots(body); // exact-handle gear slots (store+key)
            if (gear.slots.Count == 0 && officers.Count == 0 && !hasDirect)
                return Result.Err(400, "nothing to apply (no slots or officers)");
            var crew = CrewSupported();

            // Apply only while docked (armory readable + a sane place to refit). No queueing.
            if (!Docked) return Result.Err(403, "dock to apply");
            // A refit moves gear between the ship and the armory, so the cached list is wrong from here on.
            InvalidateInventories();
            // And only where the refit can happen: a station without a personal hangar (an industry station, say)
            // offers no way to change gear, so accepting the request would report success for nothing.
            if (!HasFacility("PersonalHangar"))
                return Result.Err(403, "no personal hangar at this station — dock somewhere with one to refit");

            var ship = GamePlayer.current?.currentSpaceShip;
            if (ship == null) return Result.Err(400, "no current ship");

            var t = LoadoutCore.ApplyTransient(ship, gear, officers, crew, out var changed);
            // Direct gear: resolve + validate each handle against what the client saw (skip moved items).
            var (direct, stale) = ParseDirect(body);
            if (direct.Count > 0)
            {
                var td = LoadoutCore.ApplyDirect(ship, direct, out var dc);
                changed += dc;
                if (t == null) t = td; else if (td != null) t.gear.AddRange(td.gear);
            }
            _lastApplied = t;
            return Result.Ok(new Dictionary<string, object>
            {
                ["applied"] = true,
                ["changed"] = changed,
                ["stale"] = stale, // handles that no longer matched (moved/sold) — client should refresh
                ["prior"] = t != null && (t.gear.Count > 0 || t.officers.Count > 0),
            });
        });

        // Restore the last applied transient's touched slots to their prior occupants.
        internal static Result LoadoutUndo() => MainThread.Run(() =>
        {
            if (!Docked) return Result.Err(403, "not docked");
            if (Echo) return Result.Err(409, "ECHO active");
            // Anything past this point moves items, so the cached list is wrong from here on — dropped
            // BEFORE the work rather than after it, so a mutation that fails halfway cannot leave a stale cache.
            InvalidateInventories();
            var n = LoadoutCore.Undo(_lastApplied);
            _lastApplied = null; // one level of undo
            return Result.Ok(new Dictionary<string, object> { ["restored"] = n });
        });

        // ---- web-client state (the former localStorage contents), scoped per playthrough + ship ----

        internal static Result ClientStateGet() => MainThread.Run(() => Result.Ok(new Dictionary<string, object>
        {
            ["playthrough"] = CurrentPlaythrough(),
            ["shipGuid"] = GamePlayer.current?.currentSpaceShip?.guid,
            ["entries"] = ClientState.Get(CurrentPlaythrough(), GamePlayer.current?.currentSpaceShip?.guid),
        }));

        // Body: { entries: { "<key>": "<opaque string>" | null }, ship: bool }. `ship:true` scopes the
        // write to the current hull; per-hull preferences (gear filters) need that, a shared taxonomy
        // (turret categories) does not. A null value deletes the entry.
        internal static Result ClientStatePut(Dictionary<string, object> body) => MainThread.Run(() =>
        {
            var pt = CurrentPlaythrough();
            if (string.IsNullOrEmpty(pt)) return Result.Err(409, "no playthrough — load a save first");
            var perShip = body != null && body.TryGetValue("ship", out var sv) && sv is bool b && b;
            var ship = perShip ? GamePlayer.current?.currentSpaceShip?.guid : null;
            if (perShip && string.IsNullOrEmpty(ship)) return Result.Err(409, "no current ship");
            if (body == null || !body.TryGetValue("entries", out var ev) || !(ev is Dictionary<string, object> entries))
                return Result.Err(400, "missing entries object");
            var n = 0;
            foreach (var kv in entries) { ClientState.Put(pt, ship, kv.Key, kv.Value?.ToString()); n++; }
            return Result.Ok(new Dictionary<string, object> { ["saved"] = n });
        });

        internal static Result ClientStateClear(Dictionary<string, object> body) => MainThread.Run(() =>
        {
            var shipOnly = body != null && body.TryGetValue("ship", out var sv) && sv is bool b && b;
            var removed = ClientState.Clear(CurrentPlaythrough(), shipOnly ? GamePlayer.current?.currentSpaceShip?.guid : null);
            return Result.Ok(new Dictionary<string, object> { ["removed"] = removed });
        });

        // ---- named loadout presets (gear snapshot + officer guids, persisted) ----

        internal static Result PresetsList() => MainThread.Run(()
            => Result.Ok(new Dictionary<string, object> { ["presets"] = Presets.List(CurrentPlaythrough(), GamePlayer.current?.currentSpaceShip?.guid) }));

        // Snapshot the current ship's gear (fingerprints) + officer assignment under a name.
        internal static Result PresetSave(Dictionary<string, object> body) => MainThread.Run(() =>
        {
            var name = Str(body, "name")?.Trim();
            if (string.IsNullOrEmpty(name)) return Result.Err(400, "missing preset name");
            var ship = GamePlayer.current?.currentSpaceShip;
            if (ship == null) return Result.Err(400, "no current ship");

            var gear = LoadoutCore.Snapshot(ship, name);
            var officers = CrewSupported() ? CollectOfficers(ship) : new List<string>(); // gated: CollectOfficers touches OfficerData
            var settings = Str(body, "settings"); // opaque UI-settings blob, stored verbatim
            Presets.Put(CurrentPlaythrough(), ship.guid, name, new Presets.Preset { Ship = ship.shipClass?.displayName ?? name, ShipGuid = ship.guid, Gear = gear, Officers = officers, Settings = settings });
            return Result.Ok(new Dictionary<string, object>
            {
                ["saved"] = name,
                ["gearSlots"] = gear.slots.Count,
                ["officers"] = officers.Count(g => !string.IsNullOrEmpty(g)),
            });
        });

        // Restore a preset onto the current ship: gear via the finder, officers by guid. Undoable.
        internal static Result PresetRestore(Dictionary<string, object> body) => MainThread.Run(() =>
        {
            if (Echo) return Result.Err(409, "ECHO active");
            if (!Docked) return Result.Err(403, "not docked");
            var ship = GamePlayer.current?.currentSpaceShip;
            if (ship == null) return Result.Err(400, "no current ship");
            var p = Presets.Get(CurrentPlaythrough(), ship.guid, Str(body, "name") ?? "");
            if (p == null) return Result.Err(404, "no such preset");

            var officers = new List<OfficerAssign>();
            if (CrewSupported() && p.Officers != null)
                for (var i = 0; i < p.Officers.Count; i++)
                    if (!string.IsNullOrEmpty(p.Officers[i])) officers.Add(new OfficerAssign { slot = i, guid = p.Officers[i] });

            var t = LoadoutCore.ApplyTransient(ship, p.Gear, officers, CrewSupported(), out var changed);
            _lastApplied = t;
            return Result.Ok(new Dictionary<string, object>
            {
                ["restored"] = Str(body, "name"),
                ["changed"] = changed,
                ["prior"] = t != null && (t.gear.Count > 0 || t.officers.Count > 0),
                ["settings"] = p.Settings, // web reapplies its UI settings from this
            });
        });

        internal static Result PresetDelete(Dictionary<string, object> body) => MainThread.Run(()
            => Result.Ok(new Dictionary<string, object> { ["deleted"] = Presets.Remove(CurrentPlaythrough(), GamePlayer.current?.currentSpaceShip?.guid, Str(body, "name") ?? "") }));

        // Export/import all presets for the current playthrough (portable JSON, moves between machines).
        internal static Result PresetsExport() => MainThread.Run(() =>
        {
            var pt = CurrentPlaythrough();
            return Result.Ok(new Dictionary<string, object>
            {
                ["playthrough"] = pt,
                ["playthroughName"] = Playthroughs.Name(pt),
                ["presets"] = Presets.Export(pt),
            });
        });

        internal static Result PresetsImport(Dictionary<string, object> body) => MainThread.Run(() =>
        {
            var pt = CurrentPlaythrough();
            if (string.IsNullOrEmpty(pt)) return Result.Err(409, "no active playthrough");
            var entries = body != null && body.TryGetValue("presets", out var pv) ? pv as List<object> : null;
            var n = Presets.Import(pt, entries);
            return Result.Ok(new Dictionary<string, object> { ["imported"] = n });
        });

        // Set (or clear, when empty) the pretty name for the current playthrough.
        internal static Result PlaythroughName(Dictionary<string, object> body) => MainThread.Run(() =>
        {
            var pt = CurrentPlaythrough();
            if (string.IsNullOrEmpty(pt)) return Result.Err(409, "no active playthrough");
            Playthroughs.SetName(pt, Str(body, "name") ?? "");
            return Result.Ok(new Dictionary<string, object> { ["playthrough"] = pt, ["name"] = Playthroughs.Name(pt) });
        });

        // Orphaned presets (untagged legacy entries) + claiming one into the current playthrough.
        internal static Result PresetsOrphans()
            => Result.Ok(new Dictionary<string, object> { ["presets"] = Presets.ListOrphans() });

        internal static Result PresetClaim(Dictionary<string, object> body) => MainThread.Run(() =>
        {
            var rawKey = Str(body, "rawKey")?.Trim() ?? Str(body, "name")?.Trim(); // rawKey identifies the orphan
            if (string.IsNullOrEmpty(rawKey)) return Result.Err(400, "missing preset key");
            var pt = CurrentPlaythrough();
            if (string.IsNullOrEmpty(pt)) return Result.Err(409, "no active playthrough");
            var ship = GamePlayer.current?.currentSpaceShip;
            if (ship == null) return Result.Err(400, "no current ship to claim onto");
            switch (Presets.Claim(pt, ship.guid, rawKey))
            {
                case "missing": return Result.Err(404, "no such orphaned preset");
                case "conflict": return Result.Err(409, "a loadout with that name already exists on this ship");
                default: return Result.Ok(new Dictionary<string, object> { ["claimed"] = rawKey });
            }
        });

        // ---- request parsing ----

        private static LoadoutPreset ParseGear(Dictionary<string, object> body)
        {
            var p = new LoadoutPreset { name = "transient" };
            if (body != null && body.TryGetValue("slots", out var sv) && sv is List<object> arr)
                foreach (var o in arr)
                    if (o is Dictionary<string, object> d && !d.ContainsKey("store")) p.slots.Add(ParseSlot(d)); // fingerprint slots
            return p;
        }

        private static bool HasDirectSlots(Dictionary<string, object> body)
            => body != null && body.TryGetValue("slots", out var sv) && sv is List<object> arr
               && arr.Any(o => o is Dictionary<string, object> d && d.ContainsKey("store"));

        // Exact-handle gear slots {kind, slot, store, key, name, level}. The handle is re-resolved live
        // and validated against the identity the client saw; a mismatch (item moved/sold) is counted as
        // stale and skipped — never equips the wrong item.
        private static (List<DirectSlot> slots, int stale) ParseDirect(Dictionary<string, object> body)
        {
            var list = new List<DirectSlot>();
            var stale = 0;
            if (body != null && body.TryGetValue("slots", out var sv) && sv is List<object> arr)
                foreach (var o in arr)
                {
                    if (!(o is Dictionary<string, object> d) || !d.ContainsKey("store")) continue;
                    var kind = Str(d, "kind");
                    var isModule = kind == "Module";
                    // Modules are keyed by EquipmentSlot NAME (a string); turrets/boosters by array index (int).
                    string slotName = null; int slot = 0;
                    if (isModule) { slotName = Str(d, "slot"); if (string.IsNullOrEmpty(slotName)) { stale++; continue; } }
                    else if (!TryInt(d, "slot", out slot)) { stale++; continue; }
                    if (!TryInt(d, "key", out var key)) { stale++; continue; }
                    var inv = Stores.Resolve(Str(d, "store"));
                    var entry = inv != null ? Stores.FindEntry(inv, key) : null;
                    var name = Str(d, "name");
                    var lvl = Int(d, "level");
                    if (entry?.item == null
                        || (name != null && entry.item.displayName != name)   // raw: compares the echoed name
                        || (lvl > 0 && entry.item.itemLevel != lvl))
                    { stale++; continue; } // handle moved / no longer the same item
                    list.Add(new DirectSlot { kind = kind, slot = slot, slotName = slotName, item = entry.item, source = inv });
                }
            return (list, stale);
        }

        private static LoadoutSlot ParseSlot(Dictionary<string, object> d)
        {
            var s = new LoadoutSlot
            {
                kind = Str(d, "kind") ?? "",
                slot = Str(d, "slot") ?? "",
                identifier = Str(d, "identifier") ?? "",
                type = Str(d, "type") ?? "",
                name = Str(d, "name") ?? "",
                rarity = Str(d, "rarity") ?? "",
                level = Int(d, "level"),
                size = Str(d, "size") ?? "",
                mainStat = Str(d, "mainStat") ?? "",
                aspectSlotCount = Int(d, "aspectSlotCount"),
            };
            if (d.TryGetValue("aspects", out var av) && av is List<object> al)
                foreach (var a in al) if (a != null) s.aspects.Add(a.ToString());
            // stats accepted as ready fingerprint strings ("Stat=amount:cr") or as the /loadout DTO's
            // {stat, amount, canReroll} objects — normalized to the finder's string form either way.
            if (d.TryGetValue("stats", out var stv) && stv is List<object> sl)
                foreach (var x in sl)
                {
                    if (x is string str) s.stats.Add(str);
                    else if (x is Dictionary<string, object> sd)
                        s.stats.Add($"{Str(sd, "stat")}={LoadoutCore.Fmt((float)Dbl(sd, "amount"))}:{(Bool(sd, "canReroll") ? 1 : 0)}");
                }
            return s;
        }

        private static List<OfficerAssign> ParseOfficers(Dictionary<string, object> body)
        {
            var list = new List<OfficerAssign>();
            if (body != null && body.TryGetValue("officers", out var ov) && ov is List<object> arr)
                foreach (var o in arr)
                    if (o is Dictionary<string, object> d)
                        list.Add(new OfficerAssign { slot = Int(d, "slot"), guid = Str(d, "guid") });
            return list;
        }

        // ---- helpers ----

        private static IEnumerable<(string id, ShopInventory shop)> EnumerateShops()
        {
            foreach (var s in VG.Game.GameShops.Enumerate(SpaceStation.current))
                yield return (s.facility.ToString(), s);
        }

        // Largest n (0..amount) whose volume still fits the inventory (no-cap stores never clamp).
        private static int ClampToSpace(Inventory inv, InventoryItemType item, int amount)
        {
            while (amount > 0 && inv.IsFull(item.m3 * amount))
                amount--;
            return amount;
        }

        private static long AddClamped(long a, long b)
            => (b > 0 && a > long.MaxValue - b) ? long.MaxValue : a + b;

    }
}
