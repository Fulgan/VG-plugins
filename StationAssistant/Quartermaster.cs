using System;
using System.Collections.Generic;
using System.Linq;
using Behaviour.Item;
using Behaviour.Item.Usable;
using Behaviour.UI.NotificationAlert;
using Behaviour.Util;
using Source.Galaxy.POI;
using Source.Item;
using Source.Player;
using Source.SpaceShip;
using Source.Util;

namespace StationAssistant
{
    // Quartermaster. On dock, keeps a set of consumables stocked on the current ship, per-ship:
    //   - inventory target = units kept in the ship's cargo (ready to use)
    //   - reserve target   = units kept in the armory (player.globalInventory, no volume limit)
    // Like the gunner it sources armory-first then buys the shortfall from a station shop, but the
    // purchase is ALL-OR-NOTHING: the whole shopping list is priced up front (credits + each barter
    // cost-item) and nothing is bought unless the full bill is affordable. Free armory<->cargo moves
    // always run. Blocked while ECHO drives (when DisableDuringEcho is set) to avoid an AFK farm.
    // The decoy transponder is one of the managed items; its "activate one on undock" behaviour stays
    // in DecoyLogic/UndockPatch.
    internal static class Quartermaster
    {
        internal enum Kind { Decoy, IonFuel, PlasmaFuel, LocatorBeacon, TrackingTagBot }

        internal sealed class Supply
        {
            internal Kind Kind;
            internal string Key;        // stable config key (do not change — persisted)
            internal string LabelKey;   // localization key for the display name
            internal bool AutoUse;      // decoy: also activated on undock
            internal Func<InventoryItemType, bool> Match;
        }

        // The managed consumables. Match is by game component (never by name), mirroring DecoyLogic.
        internal static readonly Supply[] Supplies =
        {
            new Supply { Kind = Kind.Decoy, Key = "decoy", LabelKey = "qm.item.decoy", AutoUse = true,
                Match = t => t != null && t.GetComponent<UmbralTransponderItem>() != null },
            new Supply { Kind = Kind.IonFuel, Key = "ionfuel", LabelKey = "qm.item.ionfuel",
                Match = t => IsFuel(t, WarpFuelItem.WarpFuelType.IonCell) },
            new Supply { Kind = Kind.PlasmaFuel, Key = "plasmafuel", LabelKey = "qm.item.plasmafuel",
                Match = t => IsFuel(t, WarpFuelItem.WarpFuelType.PlasmaCell) },
            new Supply { Kind = Kind.LocatorBeacon, Key = "locator", LabelKey = "qm.item.locator",
                Match = t => t != null && t.GetComponent<PoiBeaconItem>() != null },
            new Supply { Kind = Kind.TrackingTagBot, Key = "trackingbot", LabelKey = "qm.item.trackingbot",
                Match = t => t != null && t.GetComponent<UmbralTrackingBeacon>() != null },
        };

        // Ion and Plasma cells share the WarpFuelItem component; the cell tier comes from GetWarpFuelType().
        private static bool IsFuel(InventoryItemType t, WarpFuelItem.WarpFuelType want)
        {
            var w = t == null ? null : t.GetComponent<WarpFuelItem>();
            return w != null && w.GetWarpFuelType() == want;
        }

        internal struct QmResult
        {
            internal int Stowed;      // moved cargo -> armory
            internal int Pulled;      // moved armory -> cargo
            internal int Bought;      // bought from shop
            internal bool Skipped;    // whole transaction abandoned (funds/space) -> bought & loaded nothing
            internal string SkipReason; // "funds" | "space"
            internal MoveLog Moves;   // which supplies moved, per direction
            internal bool Short;      // proceeded, but some target unmet (shop out of stock / not sold here)
            internal string ShortItems;
            internal string Reason;
        }

        private sealed class Plan
        {
            internal ShopInventory Shop;
            internal Inventory.InventoryItem Offer;
            internal int Qty; // units bought into the armory
            internal string Label; // the supply's display name, for the restock report
        }

        internal static QmResult Restock(Config cfg)
        {
            try
            {
                if (!cfg.Enabled.Value)
                    return new QmResult { Reason = "disabled" };

                var player = GamePlayer.current;
                var ship = player?.currentSpaceShip;
                var cargo = ship?.cargo;
                if (cargo is null)
                    return new QmResult { Reason = "no ship" };

                var station = SpaceStation.current;
                if (station == null)
                    return new QmResult { Reason = "not docked" };

                var echoActive = player.currentAutopilotSessionStats != null;
                var armory = player.globalInventory;
                // Search every facility shop the station has — a consumable can be sold at any of them
                // (mining/salvage/patrol/…), not just the general or umbral shop.
                var shops = new List<ShopInventory>(VG.Game.GameShops.Enumerate(station));

                var r = new QmResult { Reason = "ok", Moves = new MoveLog() };
                var autoBuy = cfg.AutoBuy.Value;

                // Flow, per item: extra cargo -> armory (free); buy the shortfall INTO the armory; then fill
                // cargo from the armory. Shops -> armory -> cargo. The WHOLE transaction is abandoned (buy
                // nothing, load nothing) only when the full order is unaffordable or won't fit the cargo
                // hold; a shop being out of stock / not stocking an item just buys the eligible rest.
                var active = new List<(Supply sup, int cargoTarget)>(); // items to fill cargo for (post-buy)
                var plans = new List<Plan>();
                long creditsNeeded = 0;
                var barterNeeded = new Dictionary<InventoryItemType, long>();
                // why an item might stay short, for the failure notification: sold here at all? and if so,
                // is it out of stock / short on stock (vs simply not sold at this station)?
                var diag = new Dictionary<string, (bool soldHere, bool stockShort)>();
                float cargoSpaceNeeded = 0f; // total volume to lift cargo to its targets (all-or-nothing)

                foreach (var sup in Supplies)
                {
                    var t = cfg.QmTarget(ship.guid, sup.Key);
                    int cargoTarget = t.inv, armoryTarget = t.res;
                    if (cargoTarget <= 0 && armoryTarget <= 0)
                        continue; // both containers ignored for this item
                    if (echoActive && cfg.QmEchoSkip(sup.Key))
                        continue; // per-item ECHO skip

                    bool manageCargo = cargoTarget > 0; // 0 = ignore the cargo container (leave it untouched)
                    int haveC = CountMatching(cargo, sup.Match);
                    int haveA = CountMatching(armory, sup.Match);

                    // extra from cargo -> armory (only when the cargo container is managed)
                    if (manageCargo && haveC > cargoTarget)
                    {
                        var moved = MoveMatching(cargo, armory, sup.Match, haveC - cargoTarget, cargoDest: false);
                        r.Stowed += moved; haveA += moved; haveC -= moved;
                        MoveLog.Add(r.Moves?.Stowed, Loc.T(sup.LabelKey), moved);
                    }

                    if (manageCargo)
                        active.Add((sup, cargoTarget));

                    float unitVol = UnitVol(sup.Match, cargo, armory); // per-unit volume for the space math

                    // Buy the total shortfall into the armory. Units already in cargo count toward the
                    // targets only when the cargo container is managed (a 0 cargo target ignores its stock).
                    int haveTowardTargets = (manageCargo ? haveC : 0) + haveA;
                    int totalShort = Math.Max(0, (cargoTarget + armoryTarget) - haveTowardTargets);
                    if (totalShort > 0 && autoBuy)
                    {
                        var offer = FindOffer(shops, sup.Match, out var shop, out var soldHere);
                        if (unitVol <= 0f && offer != null)
                            unitVol = offer.item.m3;
                        int avail = offer == null ? 0 : (offer.item.HasInfiniteShopSupply() ? int.MaxValue : offer.count);
                        // sold here but can't fully cover the need = out of stock / not enough stock
                        diag[sup.Key] = (soldHere, soldHere && (offer == null || avail < totalShort));

                        if (offer != null)
                        {
                            int qty = Math.Min(totalShort, avail);
                            if (qty > 0)
                            {
                                var priced = true;
                                if (offer.costItem != null)
                                {
                                    if (offer.costItemCount > 0)
                                    {
                                        barterNeeded.TryGetValue(offer.costItem, out var acc);
                                        barterNeeded[offer.costItem] = acc + (long)offer.costItemCount * qty;
                                    }
                                }
                                else if (offer.cost > 0)
                                {
                                    creditsNeeded += (long)offer.cost * qty;
                                }
                                else
                                {
                                    priced = false; // free/unpriced — skip to be safe
                                }
                                if (priced)
                                    plans.Add(new Plan { Shop = shop, Offer = offer, Qty = qty, Label = Loc.T(sup.LabelKey) });
                            }
                        }
                    }

                    // Volume to lift this item's cargo to its target (whether pulled or bought → pulled).
                    if (manageCargo && haveC < cargoTarget && unitVol > 0f)
                        cargoSpaceNeeded += (cargoTarget - haveC) * unitVol;
                }

                // All-or-nothing gate: abandon the WHOLE transaction on insufficient funds or cargo space.
                bool moneyOK = VG.Game.Wallet.Balance(player) >= creditsNeeded;
                if (moneyOK)
                    foreach (var kv in barterNeeded)
                        if (player.CountAvailableItems(kv.Key) < kv.Value) { moneyOK = false; break; }
                bool spaceOK = cargoSpaceNeeded <= 0f || !cargo.IsFull(cargoSpaceNeeded);

                if (plans.Count > 0 && !moneyOK)
                {
                    r.Skipped = true; r.SkipReason = "funds";
                }
                else if (!spaceOK)
                {
                    r.Skipped = true; r.SkipReason = "space";
                }
                else
                {
                    foreach (var p in plans)
                    {
                        var got = Purchase(player, p.Shop, p.Offer, p.Qty, armory);
                        r.Bought += got;
                        MoveLog.Add(r.Moves?.Bought, p.Label, got);
                    }

                    // missing from cargo <- armory: fill each active item's cargo target from the armory.
                    foreach (var (sup, cargoTarget) in active)
                    {
                        int haveC = CountMatching(cargo, sup.Match);
                        if (haveC >= cargoTarget)
                            continue;
                        var pulled = MoveMatching(armory, cargo, sup.Match, cargoTarget - haveC, cargoDest: true);
                        r.Pulled += pulled;
                        MoveLog.Add(r.Moves?.Pulled, Loc.T(sup.LabelKey), pulled);
                    }

                    // Partial shortfall (we proceeded): items still under target because the shop was out of
                    // stock or doesn't stock them here. Money/space were handled above as full abandons.
                    if (autoBuy)
                    {
                        var shortNames = new List<string>();
                        foreach (var sup in Supplies)
                        {
                            var t = cfg.QmTarget(ship.guid, sup.Key);
                            if (t.inv <= 0 && t.res <= 0)
                                continue;
                            if (echoActive && cfg.QmEchoSkip(sup.Key))
                                continue;
                            bool cargoShort = t.inv > 0 && CountMatching(cargo, sup.Match) < t.inv;
                            bool armoryShort = t.res > 0 && CountMatching(armory, sup.Match) < t.res;
                            if (!cargoShort && !armoryShort)
                                continue;
                            bool hasDiag = diag.TryGetValue(sup.Key, out var d);
                            string reason =
                                hasDiag && !d.soldHere ? Loc.T("qm.short.notsold")
                                : hasDiag && d.stockShort ? Loc.T("qm.short.stock")
                                : Loc.T("qm.short.other");
                            shortNames.Add(Loc.F("qm.short.item", Loc.T(sup.LabelKey), reason));
                        }
                        if (shortNames.Count > 0)
                        {
                            r.Short = true;
                            r.ShortItems = string.Join(", ", shortNames);
                        }
                    }
                }

                Finish(ref r);
                return r;
            }
            catch (Exception ex)
            {
                Plugin.Log.LogWarning($"Quartermaster skipped after an error: {ex}");
                return new QmResult { Reason = "error" };
            }
        }

        internal static int CountMatching(Inventory inv, Func<InventoryItemType, bool> match)
            => inv?.items?.Where(e => e?.item != null && match(e.item)).Sum(e => e.count) ?? 0;

        // Per-unit volume of a matching item, from any instance in cargo or armory (0 if none found —
        // callers fall back to the shop offer's m3). Used to size the all-or-nothing cargo-space check.
        private static float UnitVol(Func<InventoryItemType, bool> match, Inventory a, Inventory b)
        {
            var e = a?.items?.FirstOrDefault(x => x?.item != null && match(x.item))
                 ?? b?.items?.FirstOrDefault(x => x?.item != null && match(x.item));
            return e?.item?.m3 ?? 0f;
        }

        // Move up to `amount` matching units from src to dst, entry by entry (preserves per-item data such
        // as a fuel cell's remaining charge). When dst is the cargo, clamp each add to the free hold volume.
        private static int MoveMatching(Inventory src, Inventory dst, Func<InventoryItemType, bool> match, int amount, bool cargoDest)
        {
            if (src == null || dst == null || amount <= 0)
                return 0;
            var entries = src.items?.Where(e => e?.item != null && match(e.item)).ToList();
            if (entries == null)
                return 0;

            int moved = 0;
            foreach (var e in entries)
            {
                if (amount <= 0)
                    break;
                int take = Math.Min(amount, e.count);
                if (cargoDest)
                    take = DecoyLogic.ShrinkToCargo(dst, e.item, take);
                if (take <= 0)
                    continue;
                try
                {
                    // SOURCE FIRST: a move is a removal plus an add, and doing the add first turns a refused
                    // removal into a duplicated item. `Remove(entry, n)` refuses when the entry is not this
                    // store's, which a cached list cannot rule out.
                    var removed = VG.Game.GameMembers.RemoveItems(src, e, take);
                    if (removed != take)
                    {
                        Plugin.Log.LogWarning($"Quartermaster: skipped {Util.ItemName(e.item)} — the game removed {removed} of {take}, so nothing was moved.");
                        continue;
                    }
                    dst.Add(e.item, take);
                    moved += take;
                    amount -= take;
                }
                catch (Exception ex)
                {
                    Plugin.Log.LogWarning($"Quartermaster: could not move {e.item?.identifier}: {ex.Message}");
                }
            }
            if (moved > 0)
            {
                VG.Game.GameShops.Repaint(src);
                VG.Game.GameShops.Repaint(dst);
            }
            return moved;
        }

        // Best offer across the station's shops. Prefer a credit-priced offer over a barter (marks) one,
        // so we spend credits before Vanguard Marks / other cost-items when the same item sells in several.
        private static Inventory.InventoryItem FindOffer(List<ShopInventory> shops, Func<InventoryItemType, bool> match, out ShopInventory shop, out bool soldHere)
        {
            soldHere = false;
            Inventory.InventoryItem barter = null;
            ShopInventory barterShop = null;
            foreach (var s in shops)
            {
                if (s.items == null)
                    continue;
                foreach (var i in s.items)
                {
                    if (i?.item == null || !match(i.item))
                        continue;
                    soldHere = true; // stocked at this station (distinguishes out-of-stock from not-sold)
                    if (!(i.count > 0 || i.item.HasInfiniteShopSupply()))
                        continue; // sold here but currently empty — not buyable right now
                    if (i.costItem == null && i.cost > 0)
                    {
                        shop = s; // credit-priced and in stock — take immediately
                        return i;
                    }
                    if (barter == null)
                    {
                        barter = i; // remember first in-stock barter offer as fallback
                        barterShop = s;
                    }
                }
            }
            shop = barterShop;
            return barter;
        }

        // Pay for and receive up to `amount` of `offer` into `dest` (always the armory — no volume limit).
        // The all-or-nothing gate has already verified the full bill; the per-call credit/barter clamps here
        // are just safety. Mirrors DecoyLogic.BuyFromShop otherwise.
        private static int Purchase(GamePlayer player, ShopInventory shop, Inventory.InventoryItem offer, int amount, Inventory dest)
        {
            // Affordability (credit/barter/stock) via the shared, unit-tested planner; destination space is
            // already accounted for by the Restock planner, so no extra fit clamp (null). Then game-way
            // mutation. Same flow as BuyFromShop — one place to maintain the money path.
            var ctx = new VG.Game.BuyContext(player, offer.costItem, null);
            amount = VG.Core.PurchasePlan.Affordable(VG.Game.PurchaseExec.ToOffer(offer), ctx, amount);
            if (amount <= 0)
                return 0;

            if (!VG.Game.PurchaseExec.Apply(player, shop, offer, dest, amount))
                return 0;
            return amount;
        }

        private static void Finish(ref QmResult r)
        {
            if (r.Skipped)
            {
                var key = r.SkipReason == "space" ? "qm.result.skipped.space" : "qm.result.skipped.funds";
                Plugin.Log.LogInfo($"Quartermaster: whole transaction abandoned ({r.SkipReason}).");
                Util.Notify(Loc.T(key), warn: true);
                return;
            }
            if (r.Short)
            {
                Plugin.Log.LogInfo($"Quartermaster: stowed {r.Stowed}, pulled {r.Pulled}, bought {r.Bought}; still short on {r.ShortItems}.");
                Util.Notify(Loc.F("qm.result.short", r.ShortItems), warn: true);
                return;
            }
            if (r.Stowed == 0 && r.Pulled == 0 && r.Bought == 0)
            {
                r.Reason = "nothing to do";
                return;
            }
            Plugin.Log.LogInfo($"Quartermaster: stowed {r.Stowed}, pulled {r.Pulled}, bought {r.Bought}.");
            Util.Notify(Loc.F("qm.result.ok", Util.Moved(r.Moves, r.Stowed, r.Pulled, r.Bought, "item")));
        }

    }
}
