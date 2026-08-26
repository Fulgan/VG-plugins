using System;
using System.Collections.Generic;
using System.Linq;
using Behaviour.Equipment.Module;
using Behaviour.Equipment.Turret;
using Behaviour.Item;
using Behaviour.UI;
using Behaviour.UI.NotificationAlert;
using Behaviour.Util;
using Source.Galaxy.POI;
using Source.Item;
using Source.Player;
using Source.SpaceShip;
using Source.Util;
using UnityEngine;

namespace StationAssistant
{
    // Gunner. Operates on the current ship's cargo only, while docked.
    //  - Stows ammo the equipped guns don't use into the armory (the player's global stash).
    //  - RunNow: brings each equipped gun's ammo to its per-ship, per-ammo target — tops up when
    //    below (armory then shop) and stows the excess back to the armory when above.
    //  - Autoload: stows unused ammo, then fills cargo to ~10% of capacity split evenly by weight
    //    across the equipped guns' ammo types (rounded up per ammo), never exceeding free space.
    // Both pull from the armory first, then buy the remainder from the station shop.
    // Blocked while ECHO drives (ECHO manages its own ammo).
    internal static class Gunner
    {
        // Fraction of total cargo capacity to fill with ammo when autoloading.
        private const float AutoloadCapacityFraction = 0.10f;

        // Most of the hold a restock may ever spend on ammo. A target expressed in MINUTES has no idea how big
        // the ship is, so on a small hull ECHO's own figure asks for more rounds than the ship can physically
        // carry; the hold then fills in whatever order the ammo types happened to be walked in and the last
        // gun gets nothing.
        private const float HoldFillFraction = 0.5f;

        // Fixed seconds inside one torpedo launch that no stat covers: 0.5s deploying the latch, 0.5s fading
        // the torpedo in, 3s finishing the sequence. The door animation adds more and is driven by a per-prefab
        // speed modifier rather than a readable constant, so this is the FASTEST a bay can cycle: it stocks
        // slightly over rather than leaving a bay dry.
        private const double TorpedoLaunchOverheadSeconds = 4.0;

        // Used only when a bay's own period cannot be read. It is the SLOWEST bay's figure on purpose: guessing
        // fast would hand the bay a share of the hold the guns then go without, and torpedoes are bulky.
        private const float TorpedoFallbackPeriodSeconds = 8f;

        internal struct AmmoResult
        {
            internal int Stowed;   // moved cargo -> armory
            internal int Pulled;   // moved armory -> cargo
            internal int Bought;   // bought from shop -> cargo
            internal MoveLog Moves; // which items moved, per direction (null on the failure paths)
            internal string Reason;
        }

        // Distinct ammo item types consumed by everything currently equipped on the ship.
        // Reads from ship data (hardpoints and module slots), so it works while docked (no live components).
        internal static List<InventoryItemType> EquippedAmmoTypes(SpaceShipData ship)
        {
            var result = new List<InventoryItemType>();
            if (ship is null)
                return result;

            var hardpoints = ship.hardpoints;
            if (hardpoints != null)
                foreach (var hp in hardpoints)
                {
                    if (hp is null)
                        continue;
                    var turret = hp.GetComponent<AbstractTurret>();
                    var ammo = turret != null && turret.HasAmmoType() ? turret.ammoType : null;
                    if (ammo != null && !result.Contains(ammo))
                        result.Add(ammo);
                }

            // A torpedo bay draws from cargo the same way a gun does — its own `ammoType`, one round taken per
            // launch — but it sits in a MODULE slot, so a walk over hardpoints alone cannot see it and every
            // ship carrying one was left to run its bay dry.
            var modules = ship.equippedModules;
            if (modules != null)
                foreach (var m in modules)
                {
                    if (m is null)
                        continue;
                    var bay = m.GetComponent<TorpedoBayModule>();
                    var ammo = bay != null ? bay.ammoType : null;
                    if (ammo != null && !result.Contains(ammo))
                        result.Add(ammo);
                }
            return result;
        }

        // ECHO's configured "minutes of ammo" (Autopilot setting). Read by reflection so there's no hard
        // typeref to AutopilotSettings/ammoMinutes (keeps one binary valid across game versions). Default 3.
        private static int EchoAmmoMinutes(GamePlayer p)
        {
            try
            {
                var s = Util.Member(p, "autopilotSettings");
                if (Util.Member(s, "ammoMinutes") is int m && m > 0) return m;
            }
            catch { }
            return 3;
        }

        // Rounds of one ammo type the ship burns per second of sustained fire, summed over everything that
        // feeds on it. ONE OWNER, because both a target in minutes and a target in cargo volume are this
        // number times something, and two copies would disagree about which guns count.
        //
        // A gun's true draw is `defaultAttacksPerSecond * ammoPerShot / shotsPerAmmo`
        // (`AbstractTurret.RecordShotFired`). ECHO's own reload formula omits `ammoPerShot`, which under-stocks
        // a gun firing more than one round per shot (autocannons) so it runs dry before the configured minutes.
        //
        // A bay's draw is one torpedo per launch cycle. `fireRate` is a PERIOD in seconds, not a rate, and both
        // it and `reloadSpeed` are private ∴ read by name: the properties over them are beta-only, and a hard
        // reference would throw on the release branch the first time this method was JITted.
        private static double DrainPerSecond(SpaceShipData ship, InventoryItemType ammo)
        {
            double total = 0;
            if (ship is null)
                return 0;

            var hardpoints = ship.hardpoints;
            if (hardpoints != null)
                foreach (var hp in hardpoints)
                {
                    var t = hp?.GetComponent<AbstractTurret>();
                    if (t == null || !t.HasAmmoType() || t.ammoType != ammo) continue;
                    total += (double)t.defaultAttacksPerSecond
                        * Math.Max(1, t.ammoPerShot) / Math.Max(1, t.shotsPerAmmo);
                }

            var modules = ship.equippedModules;
            if (modules != null)
                foreach (var m in modules)
                {
                    var bay = m?.GetComponent<TorpedoBayModule>();
                    if (bay == null || bay.ammoType != ammo) continue;
                    var period = VG.Game.GameMembers.GetPrivate(bay, "fireRate") is float f && f > 0f
                        ? f
                        : TorpedoFallbackPeriodSeconds;
                    total += 1.0 / (period + TorpedoLaunchOverheadSeconds);
                }
            return total;
        }

        // Rounds of `ammo` that last `seconds` of sustained fire. The arithmetic is `VG.Core.AmmoPlan`'s, which
        // is where it can be tested: a mod is only exercisable by flying a ship.
        private static int RoundsFor(SpaceShipData ship, InventoryItemType ammo, double seconds)
            => VG.Core.AmmoPlan.RoundsFor(DrainPerSecond(ship, ammo), seconds);

        /// <summary>
        /// The volume a restock may put into ammo: a share of the WHOLE hold, capped by what the hold can actually
        /// reach.
        ///
        /// Two figures, and using the wrong one reintroduces the bug this budget exists to fix. `capacity` is TOTAL
        /// m³ and is the right basis for "ammo may occupy at most half the hold", which is a statement about the
        /// finished hold. But every add is clamped against FREE space (`ShrinkToCargo` walks `IsFull`) ∴ on a hull
        /// already more than half full of ore, a target sized off the total cannot be met, the adds are trimmed in
        /// WALK ORDER, and the last ammo type gets nothing again.
        ///
        /// The reachable ceiling is what is already aboard plus what still fits, so the budget is the smaller of
        /// the two. The even-firing-time split then divides a figure the hold can honour, which is what makes the
        /// shares fair rather than merely computed.
        /// </summary>
        private static float HoldBudget(Context ctx, float fraction)
        {
            var share = ctx.Cargo.capacity * fraction;
            float held = 0f;
            foreach (var a in ctx.Used)
                if (a != null && a.m3 > 0f)
                    held += ctx.Cargo.GetCount(a) * a.m3;
            var reachable = held + Math.Max(0, ctx.Cargo.GetSpaceAvailable());
            return Math.Min(share, reachable);
        }

        // The seconds of fire a volume budget buys when every ammo type is to run out at the SAME moment.
        private static double SecondsAffordable(SpaceShipData ship, List<InventoryItemType> used, float budgetM3)
        {
            if (used == null)
                return 0;
            var draws = new List<VG.Core.AmmoDraw>();
            foreach (var a in used)
                if (a != null)
                    draws.Add(new VG.Core.AmmoDraw(DrainPerSecond(ship, a), a.m3));
            return VG.Core.AmmoPlan.SecondsAffordable(draws, budgetM3);
        }

        private static int EchoAmmoTarget(SpaceShipData ship, InventoryItemType ammo, int ammoSeconds)
            => RoundsFor(ship, ammo, ammoSeconds);

        // For the settings window: ECHO's minutes + the computed per-ammo target (read-only preview).
        internal static int EchoMinutes() => EchoAmmoMinutes(GamePlayer.current);
        internal static int EchoTargetFor(SpaceShipData ship, InventoryItemType ammo)
            => EchoAmmoTarget(ship, ammo, EchoAmmoMinutes(GamePlayer.current) * 60);

        // Restock each equipped gun's ammo to its target (ECHO-minutes or the manual per-ship target).
        internal static AmmoResult RunNow(Config cfg)
        {
            try
            {
                var ctx = Begin(cfg, out var fail);
                if (ctx is null)
                    return fail;

                var r = new AmmoResult { Reason = "ok", Moves = new MoveLog() };
                if (cfg.AmmoStowUnused.Value)
                    r.Stowed += StowUnused(ctx, r.Moves);

                // ECHO-minutes mode: target each ammo type for enough rounds to fire ECHO's configured
                // number of minutes across every gun that uses it — the same formula ECHO reloads with.
                var echoMinutes = cfg.AmmoUseEchoMinutes.Value;
                var ammoSeconds = echoMinutes ? EchoAmmoMinutes(ctx.Player) * 60 : 0;

                // What the HOLD can actually pay for, as a firing time every ammo type shares. A target set in
                // minutes, or by hand, knows nothing about the ship it is being asked of.
                var affordableSeconds = SecondsAffordable(ctx.Ship, ctx.Used, HoldBudget(ctx, HoldFillFraction));

                foreach (var ammo in ctx.Used)
                {
                    var target = echoMinutes
                        ? EchoAmmoTarget(ctx.Ship, ammo, ammoSeconds)
                        : cfg.AmmoTarget(ctx.Ship.guid, ammo.identifier);
                    if (target <= 0)
                        continue; // no target for this ammo — leave it alone

                    // Trimmed to the shared firing time rather than to a per-type volume share: every gun then
                    // runs dry at the same moment instead of the walk order deciding which one goes short.
                    var affordable = RoundsFor(ctx.Ship, ammo, affordableSeconds);
                    if (affordable > 0 && target > affordable)
                        target = affordable;

                    var have = ctx.Cargo.GetCount(ammo);
                    if (have > target)
                        StowExcess(ctx, ammo, have - target, ref r); // over the limit -> back to armory
                    else
                        TopUp(ctx, ammo, target - have, cfg.AmmoAutoBuy.Value, ref r);
                }

                Finish(ctx, ref r);
                return r;
            }
            catch (Exception ex)
            {
                Plugin.Log.LogWarning($"Gunner skipped after an error: {ex}");
                return Fail("error");
            }
        }

        // Stow unused ammo, then fill cargo to ~10% of capacity, split evenly by weight across the
        // equipped guns' ammo types (rounded up per ammo). Never exceeds free cargo space.
        internal static AmmoResult Autoload(Config cfg)
        {
            try
            {
                var ctx = Begin(cfg, out var fail);
                if (ctx is null)
                    return fail;

                var r = new AmmoResult { Reason = "ok", Moves = new MoveLog() };
                r.Stowed += StowUnused(ctx, r.Moves); // autoload always clears unused ammo

                if (ctx.Used.Count > 0)
                {
                    // 10% of the hold, spent so every ammo type lasts the same firing time. An even share of the
                    // VOLUME reads fair and is not: a fast gun and a slow one get the same cubic metres and run
                    // out minutes apart.
                    var seconds = SecondsAffordable(ctx.Ship, ctx.Used, HoldBudget(ctx, AutoloadCapacityFraction));

                    foreach (var ammo in ctx.Used)
                    {
                        if (ammo.m3 <= 0f)
                            continue; // can't size a weightless/unknown ammo

                        var need = RoundsFor(ctx.Ship, ammo, seconds) - ctx.Cargo.GetCount(ammo);
                        TopUp(ctx, ammo, need, cfg.AmmoAutoBuy.Value, ref r);
                    }
                }

                Finish(ctx, ref r);
                return r;
            }
            catch (Exception ex)
            {
                Plugin.Log.LogWarning($"Gunner skipped after an error: {ex}");
                return Fail("error");
            }
        }

        // ---- shared machinery ----

        private sealed class Context
        {
            internal GamePlayer Player;
            internal SpaceShipData Ship;
            internal Inventory Cargo;
            internal Inventory Armory;      // global cross-ship stash
            internal ShopInventory Shop;
            internal List<InventoryItemType> Used;
            internal HashSet<string> UsedIds;
        }

        // Shared guards. Returns null (and sets `fail`) when the valet can't run.
        private static Context Begin(Config cfg, out AmmoResult fail)
        {
            fail = default;

            if (!cfg.AmmoEnabled.Value)
            {
                fail = Fail("disabled");
                return null;
            }

            var player = GamePlayer.current;
            var ship = player?.currentSpaceShip;
            var cargo = ship?.cargo;
            if (cargo is null)
            {
                fail = Fail("no ship");
                return null;
            }
            if (player.currentAutopilotSessionStats != null)
            {
                fail = Fail("ECHO active");
                return null;
            }

            var station = SpaceStation.current;
            if (station == null)
            {
                fail = Fail("not docked");
                return null;
            }

            var used = EquippedAmmoTypes(ship);
            return new Context
            {
                Player = player,
                Ship = ship,
                Cargo = cargo,
                Armory = player.globalInventory,
                Shop = station.generalShopInventory ?? station.shopInventory,
                Used = used,
                UsedIds = new HashSet<string>(used.Select(a => a.identifier)),
            };
        }

        // Move ammo the equipped guns don't use from cargo to the armory. Returns units stowed.
        private static int StowUnused(Context ctx, MoveLog log)
        {
            if (ctx.Armory == null)
                return 0;

            var toStow = ctx.Cargo.items?
                .Where(e => e?.item != null
                            && e.item.itemCategory == ItemCategory.Ammo
                            && !ctx.UsedIds.Contains(e.item.identifier)
                            && !e.item.missionItem && !e.item.criticalItem)
                .ToList();
            if (toStow == null)
                return 0;

            var stowed = 0;
            foreach (var e in toStow)
            {
                var count = e.count;
                try
                {
                    // SOURCE FIRST — see AutoSell: adding before the removal is confirmed duplicates the item
                    // when the game refuses (a stale entry handle answers false and removes nothing).
                    var removed = VG.Game.GameMembers.RemoveItems(ctx.Cargo, e, count);
                    if (removed != count)
                    {
                        Plugin.Log.LogWarning($"Gunner: skipped stowing {Util.ItemName(e.item)} — the game removed {removed} of {count}.");
                        continue;
                    }
                    ctx.Armory.Add(e.item, count);
                    stowed += count;
                    MoveLog.Add(log?.Stowed, Util.ItemName(e.item), count);
                }
                catch (Exception ex)
                {
                    Plugin.Log.LogWarning($"Gunner: could not stow {e.item.identifier}: {ex.Message}");
                }
            }
            return stowed;
        }

        // Move `excess` units of `ammo` from cargo back to the armory (over the ship's limit).
        private static void StowExcess(Context ctx, InventoryItemType ammo, int excess, ref AmmoResult r)
        {
            if (ctx.Armory == null || excess <= 0)
                return;
            try
            {
                var removed = VG.Game.GameMembers.RemoveItems(ctx.Cargo, ammo, excess);
                if (removed != excess)
                {
                    Plugin.Log.LogWarning($"Gunner: skipped stowing excess {Util.ItemName(ammo)} — the game removed {removed} of {excess}.");
                    return;
                }
                ctx.Armory.Add(ammo, excess);
                r.Stowed += excess;
                MoveLog.Add(r.Moves?.Stowed, Util.ItemName(ammo), excess);
            }
            catch (Exception ex)
            {
                Plugin.Log.LogWarning($"Gunner: could not stow excess {ammo.identifier}: {ex.Message}");
            }
        }

        // Bring `need` more units of `ammo` into cargo: pull from armory first, then buy the rest.
        // ShrinkToCargo clamps every add to the free cargo volume, so we never overflow the hold.
        private static void TopUp(Context ctx, InventoryItemType ammo, int need, bool autoBuy, ref AmmoResult r)
        {
            if (need <= 0)
                return;

            if (ctx.Armory != null)
            {
                var take = DecoyLogic.ShrinkToCargo(ctx.Cargo, ammo, Math.Min(need, ctx.Armory.GetCount(ammo)));
                if (take > 0)
                {
                    try
                    {
                        var pulled = VG.Game.GameMembers.RemoveItems(ctx.Armory, ammo, take);
                        if (pulled != take)
                        {
                            Plugin.Log.LogWarning($"Gunner: skipped pulling {Util.ItemName(ammo)} — the armory removed {pulled} of {take}.");
                            return;
                        }
                        ctx.Cargo.Add(ammo, take);
                        r.Pulled += take;
                        MoveLog.Add(r.Moves?.Pulled, Util.ItemName(ammo), take);
                        need -= take;
                    }
                    catch (Exception ex)
                    {
                        Plugin.Log.LogWarning($"Gunner: could not pull {ammo.identifier} from armory: {ex.Message}");
                    }
                }
            }

            if (need > 0 && autoBuy && ctx.Shop != null)
            {
                var id = ammo.identifier;
                var got = DecoyLogic.BuyFromShop(ctx.Player, ctx.Shop, t => t != null && t.identifier == id, need);
                r.Bought += got;
                MoveLog.Add(r.Moves?.Bought, Util.ItemName(ammo), got);
            }
        }

        private static void Finish(Context ctx, ref AmmoResult r)
        {
            if (r.Stowed == 0 && r.Pulled == 0 && r.Bought == 0)
            {
                r.Reason = "nothing to do";
                return;
            }
            if (r.Pulled > 0 || r.Bought > 0)
                RefreshStorage(ctx.Armory);

            Plugin.Log.LogInfo($"Gunner: stowed {r.Stowed}, pulled {r.Pulled} from armory, bought {r.Bought}.");
            Util.Notify(Loc.F("ammo.result.ok", Util.Moved(r.Moves, r.Stowed, r.Pulled, r.Bought, "round")));
        }

        private static void RefreshStorage(Inventory storage)
        {
            try
            {
                var iim = InventoryInteractionManager.Instance;
                if (iim != null && iim.isShopOpen)
                    iim.ReloadUI();
            }
            catch { }
        }

        private static AmmoResult Fail(string reason) => new AmmoResult { Reason = reason };
    }
}
