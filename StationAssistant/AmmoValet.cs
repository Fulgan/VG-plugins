using System;
using System.Collections.Generic;
using System.Linq;
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
    // Ammo valet. Operates on the current ship's cargo only, while docked.
    //  - Stows ammo the equipped guns don't use into the armory (the player's global stash).
    //  - RunNow: brings each equipped gun's ammo to its per-ship, per-ammo target — tops up when
    //    below (armory then shop) and stows the excess back to the armory when above.
    //  - Autoload: stows unused ammo, then fills cargo to ~10% of capacity split evenly by weight
    //    across the equipped guns' ammo types (rounded up per ammo), never exceeding free space.
    // Both pull from the armory first, then buy the remainder from the station shop.
    // Blocked while ECHO drives (ECHO manages its own ammo).
    internal static class AmmoValet
    {
        // Fraction of total cargo capacity to fill with ammo when autoloading.
        private const float AutoloadCapacityFraction = 0.10f;

        internal struct AmmoResult
        {
            internal int Stowed;   // moved cargo -> armory
            internal int Pulled;   // moved armory -> cargo
            internal int Bought;   // bought from shop -> cargo
            internal string Reason;
        }

        // Distinct ammo item types consumed by the guns currently equipped on the ship.
        // Reads from ship data (hardpoints), so it works while docked (no live turret components).
        internal static List<InventoryItemType> EquippedAmmoTypes(SpaceShipData ship)
        {
            var result = new List<InventoryItemType>();
            var hardpoints = ship?.hardpoints;
            if (hardpoints is null)
                return result;

            foreach (var hp in hardpoints)
            {
                if (hp is null)
                    continue;
                var turret = hp.GetComponent<AbstractTurret>();
                var ammo = turret != null && turret.HasAmmoType() ? turret.ammoType : null;
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
                var s = Member(p, "autopilotSettings");
                if (Member(s, "ammoMinutes") is int m && m > 0) return m;
            }
            catch { }
            return 3;
        }

        // Rounds to stock for one ammo type = sum over the equipped guns that use it of ECHO's own reload
        // formula: (int)(defaultAttacksPerSecond * ammoSeconds / shotsPerAmmo). See doc/vanguard-galaxy-api.md.
        private static int EchoAmmoTarget(SpaceShipData ship, InventoryItemType ammo, int ammoSeconds)
        {
            var total = 0;
            var hardpoints = ship?.hardpoints;
            if (hardpoints == null) return 0;
            foreach (var hp in hardpoints)
            {
                var t = hp?.GetComponent<AbstractTurret>();
                if (t == null || !t.HasAmmoType() || t.ammoType != ammo) continue;
                total += (int)(t.defaultAttacksPerSecond * ammoSeconds / Math.Max(1, t.shotsPerAmmo));
            }
            return total;
        }

        private static object Member(object o, string name)
        {
            if (o == null) return null;
            var ty = o.GetType();
            var pi = ty.GetProperty(name); if (pi != null) return pi.GetValue(o);
            var fi = ty.GetField(name); return fi?.GetValue(o);
        }

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

                var r = new AmmoResult { Reason = "ok" };
                if (cfg.AmmoStowUnused.Value)
                    r.Stowed += StowUnused(ctx);

                // ECHO-minutes mode: target each ammo type for enough rounds to fire ECHO's configured
                // number of minutes across every gun that uses it — the same formula ECHO reloads with.
                var echoMinutes = cfg.AmmoUseEchoMinutes.Value;
                var ammoSeconds = echoMinutes ? EchoAmmoMinutes(ctx.Player) * 60 : 0;

                foreach (var ammo in ctx.Used)
                {
                    var target = echoMinutes
                        ? EchoAmmoTarget(ctx.Ship, ammo, ammoSeconds)
                        : cfg.AmmoTarget(ctx.Ship.guid, ammo.identifier);
                    if (target <= 0)
                        continue; // no target for this ammo — leave it alone

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
                Plugin.Log.LogWarning($"Ammo valet skipped after an error: {ex}");
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

                var r = new AmmoResult { Reason = "ok" };
                r.Stowed += StowUnused(ctx); // autoload always clears unused ammo

                if (ctx.Used.Count > 0)
                {
                    // Volume budget for each ammo type: an even share of 10% of total capacity.
                    var volumePerType = ctx.Cargo.capacity * AutoloadCapacityFraction / ctx.Used.Count;

                    foreach (var ammo in ctx.Used)
                    {
                        var perUnit = ammo.m3;
                        if (perUnit <= 0f)
                            continue; // can't size a weightless/unknown ammo

                        var desired = Mathf.CeilToInt(volumePerType / perUnit); // round the ammo amount up
                        var need = desired - ctx.Cargo.GetCount(ammo);
                        TopUp(ctx, ammo, need, cfg.AmmoAutoBuy.Value, ref r);
                    }
                }

                Finish(ctx, ref r);
                return r;
            }
            catch (Exception ex)
            {
                Plugin.Log.LogWarning($"Ammo valet skipped after an error: {ex}");
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
        private static int StowUnused(Context ctx)
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
                    ctx.Armory.Add(e.item, count);
                    ctx.Cargo.Remove(e, count);
                    stowed += count;
                }
                catch (Exception ex)
                {
                    Plugin.Log.LogWarning($"Ammo valet: could not stow {e.item.identifier}: {ex.Message}");
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
                ctx.Armory.Add(ammo, excess);
                ctx.Cargo.Remove(ammo, excess);
                r.Stowed += excess;
            }
            catch (Exception ex)
            {
                Plugin.Log.LogWarning($"Ammo valet: could not stow excess {ammo.identifier}: {ex.Message}");
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
                        ctx.Armory.Remove(ammo, take);
                        ctx.Cargo.Add(ammo, take);
                        r.Pulled += take;
                        need -= take;
                    }
                    catch (Exception ex)
                    {
                        Plugin.Log.LogWarning($"Ammo valet: could not pull {ammo.identifier} from armory: {ex.Message}");
                    }
                }
            }

            if (need > 0 && autoBuy && ctx.Shop != null)
            {
                var id = ammo.identifier;
                r.Bought += DecoyLogic.BuyFromShop(ctx.Player, ctx.Shop, t => t != null && t.identifier == id, need);
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

            Plugin.Log.LogInfo($"Ammo valet: stowed {r.Stowed}, pulled {r.Pulled} from armory, bought {r.Bought}.");
            Notify(Loc.F("ammo.result.ok", r.Stowed, r.Pulled, r.Bought));
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

        private static void Notify(string text)
        {
            try
            {
                Singleton<NotificationManager>.Instance
                    .CreateNotification(text).WithColor(ColorHelper.greenish).WithCustomTime(3f).Show();
            }
            catch { }
        }
    }
}
