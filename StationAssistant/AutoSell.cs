using System;
using System.Collections.Generic;
using System.Linq;
using System.Reflection;
using Behaviour.Equipment;
using Behaviour.Equipment.Aspect;
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
    // Sells matching stacks from the current ship's cargo only (never global/material/other ships).
    internal static class AutoSell
    {
        internal struct SellResult
        {
            internal int Items;
            internal long Credits;
            internal string Reason;
        }

        internal static SellResult SellNow(Config cfg)
        {
            try
            {
                if (!cfg.SellEnabled.Value)
                    return Fail("disabled");

                var player = GamePlayer.current;
                var cargo = player?.currentSpaceShip?.cargo;
                if (cargo is null)
                    return Fail("no ship");

                if (player.currentAutopilotSessionStats != null)
                    return Fail("ECHO active");
                if (SpaceStation.current == null)
                    return Fail("not docked");

                // snapshot: selling mutates cargo
                var toSell = cargo.items?.Where(i => i?.item != null && ShouldSell(i, cfg)).ToList();
                if (toSell is null or { Count: 0 })
                    return Fail("no matching items");

                var shop = SpaceStation.current?.shopInventory; // for the grid refresh below
                var buyback = 0;

                var items = 0;
                var credits = 0L;
                foreach (var entry in toSell)
                {
                    var count = entry.count;
                    var value = (long)entry.item.sellValue * count;

                    // THE GOODS LEAVE FIRST. `Inventory.Remove(entry, n)` answers false when the entry is not
                    // this store's — a stale handle, another inventory — and removes nothing; crediting before
                    // that answer is known pays for an item the player still holds.
                    var removed = VG.Game.GameMembers.RemoveItems(cargo, entry, count);
                    if (removed != count)
                    {
                        Plugin.Log.LogWarning($"Auto-sell: skipped {Util.ItemName(entry.item)} — the game removed {removed} of {count}, so nothing was paid or shelved.");
                        continue;
                    }

                    // The balance is written second, and a failure to write it puts the goods back: an unpaid sale
                    // and a paid-for phantom are both worse than an abandoned one.
                    if (!VG.Game.Wallet.SetBalance(player, AddClamped(VG.Game.Wallet.Balance(player), value)))
                    {
                        cargo.Add(entry.item, count);
                        Plugin.Log.LogWarning($"Auto-sell: could not credit {value:N0} for {Util.ItemName(entry.item)} — the item was returned to cargo.");
                        break;
                    }

                    // Sold goods go to the station's shelf — ONE owner (`VG.Game.GameShops.Shelve`), shared with
                    // the bridge, because the game adds them WHATEVER their buy-back flag says.
                    if (VG.Game.GameShops.Shelve(SpaceStation.current, entry.item, count).boughtBack)
                        buyback += count;

                    items += count;
                    credits = AddClamped(credits, value);
                }

                // The cargo panel does not rebuild on its own unless the used volume changed, so the store we
                // took items OUT of is repainted whether or not anything landed on a shelf.
                VG.Game.GameShops.Repaint(cargo);

                if (buyback > 0)
                {
                    VG.Game.GameShops.Repaint(shop);
                    Plugin.Log.LogInfo($"Returned {buyback} item(s) to the {shop.facility} shop buyback.");
                }

                Plugin.Log.LogInfo($"Auto-sell: sold {items} item(s) from cargo for {credits:N0} credits.");
                Util.Notify(Loc.F("sell.result.sold", VG.Text.Say.Count(items, "item"), VG.Text.Say.Credits(credits)));
                return new SellResult { Items = items, Credits = credits, Reason = "ok" };
            }
            catch (Exception ex)
            {
                Plugin.Log.LogWarning($"Auto-sell skipped after an error: {ex}");
                return Fail("error");
            }
        }

        internal static int PreviewCount(Config cfg, out long estCredits)
        {
            estCredits = 0;
            try
            {
                var cargo = GamePlayer.current?.currentSpaceShip?.cargo;
                if (cargo?.items is null)
                    return 0;

                var count = 0;
                foreach (var entry in cargo.items)
                {
                    if (entry?.item == null || !ShouldSell(entry, cfg))
                        continue;
                    count += entry.count;
                    estCredits = AddClamped(estCredits, (long)entry.item.sellValue * entry.count);
                }
                return count;
            }
            catch
            {
                return 0;
            }
        }

        internal static List<string> ListMatches(Config cfg)
        {
            var lines = new List<string>();
            try
            {
                var cargo = GamePlayer.current?.currentSpaceShip?.cargo;
                if (cargo?.items is null)
                    return lines;

                foreach (var e in cargo.items)
                {
                    if (e?.item == null || !ShouldSell(e, cfg))
                        continue;
                    var name = Util.ItemName(e.item);
                    var val = (long)e.item.sellValue * e.count;
                    lines.Add($"{e.count}x {name} — {val:N0} cr");
                }
            }
            catch (Exception ex)
            {
                Plugin.Log.LogWarning($"ListMatches failed: {ex.Message}");
            }
            return lines;
        }

        private static bool ShouldSell(Inventory.InventoryItem entry, Config cfg)
        {
            var item = entry.item;
            if (!item.canSell || item.missionItem || item.criticalItem
                || VG.Game.ItemFlags.IsFavourited(entry, item) || item.sellValue == 0)
                return false;

            if (!cfg.IsCategoryEnabled(item.itemCategory))
                return false;

            // Keep if good enough in EITHER dimension (rarity OR item level); sell only if lower in both.
            var isBooster = item.itemCategory == ItemCategory.Booster;
            var keepRarity = isBooster ? cfg.KeepBoosterRarity.Value : cfg.KeepRarity.Value;
            var rarityOk = (int)item.rarity >= (int)keepRarity;

            if (isBooster)
            {
                // Boosters are all item level 1 — rarity alone decides; the level floor doesn't apply.
                if (rarityOk)
                    return false;
            }
            else
            {
                var levelOk = cfg.KeepItemLevel.Value > 0 && item.itemLevel >= cfg.KeepItemLevel.Value;
                if (rarityOk || levelOk)
                    return false;
            }

            foreach (var rule in cfg.KeepRules)
                if (rule.Matches(item))
                    return false;

            return true;
        }

        private static List<string> _allTypesCache;
        private static List<AspectOption> _allAspectsCache;

        // An aspect the user can pick: Id is the stored/matched identifier, Name the readable label.
        internal struct AspectOption
        {
            internal string Id;
            internal string Name;
        }

        // Readable aspect name from its identifier; falls back to the identifier if untranslated.
        internal static string AspectName(string id)
        {
            if (id == KeepRule.AllBossAspects)
                return Loc.T("aspect.allBoss");
            try
            {
                var name = Translation.Translate("@Aspect" + id);
                return string.IsNullOrEmpty(name) || name == "@Aspect" + id ? id : name;
            }
            catch
            {
                return id;
            }
        }

        // All concrete AbstractTurret/AbstractModule type names from the assembly (cached).
        internal static List<string> AllEquipmentTypes()
        {
            if (_allTypesCache != null)
                return _allTypesCache;

            var result = new List<string>();
            try
            {
                var asm = typeof(AbstractEquipment).Assembly;
                Type[] types;
                try { types = asm.GetTypes(); }
                catch (ReflectionTypeLoadException ex) { types = ex.Types.Where(t => t != null).ToArray(); }

                foreach (var t in types)
                {
                    if (t is null || t.IsAbstract)
                        continue;
                    if (typeof(AbstractTurret).IsAssignableFrom(t) || typeof(AbstractModule).IsAssignableFrom(t))
                        result.Add(t.Name);
                }
                result = result.Distinct().OrderBy(n => n).ToList();
            }
            catch (Exception ex)
            {
                Plugin.Log.LogWarning($"AllEquipmentTypes failed: {ex.Message}");
            }

            _allTypesCache = result;
            return result;
        }

        // Individual aspects hidden from the picker: editor/internal ('_'-prefixed) and the 'test'
        // aspect. Boss aspects ('boss'-prefixed) are also hidden individually — they're collapsed
        // into the single "<All Boss aspects>" meta entry (see AllAspects).
        private static bool IsHiddenAspect(EquipAspect a)
            => a.name.StartsWith("_")
               || a.identifier.StartsWith("test", StringComparison.OrdinalIgnoreCase)
               || a.identifier.StartsWith("boss", StringComparison.OrdinalIgnoreCase);

        // Selectable aspects from Resources("EquipAspects"), by readable name (cached once loaded).
        // First entry is the "<All Boss aspects>" meta filter; individual boss aspects are hidden.
        internal static List<AspectOption> AllAspects()
        {
            if (_allAspectsCache != null && _allAspectsCache.Count > 0)
                return _allAspectsCache;

            var result = new List<AspectOption>
            {
                new AspectOption { Id = KeepRule.AllBossAspects, Name = AspectName(KeepRule.AllBossAspects) },
            };
            try
            {
                var aspects = Resources.LoadAll<EquipAspect>("EquipAspects");
                var regular = aspects
                    .Where(a => a != null && !IsHiddenAspect(a))
                    .Select(a => a.identifier)
                    .Distinct()
                    .Select(id => new AspectOption { Id = id, Name = AspectName(id) })
                    .OrderBy(o => o.Name)
                    .ToList();

                result.AddRange(regular);
                if (regular.Count > 0)
                    _allAspectsCache = result; // only cache once the real aspects have loaded
            }
            catch (Exception ex)
            {
                Plugin.Log.LogWarning($"AllAspects failed: {ex.Message}");
            }

            return result;
        }

        // Add non-negative b to a, clamping at long.MaxValue instead of overflowing.
        private static long AddClamped(long a, long b) => (b > 0 && a > long.MaxValue - b) ? long.MaxValue : a + b;

        private static MethodInfo _updateVisible;

        // Push shop changes into the visible grid (UpdateVisibleItems is internal; reflected once).
        private static SellResult Fail(string reason) => new SellResult { Items = 0, Credits = 0, Reason = reason };
    }

    // Keep exception. Unset field = any; rarity and level are minimums (>=), SIZE is exact — a Large module is
    // not a better Small one, so a minimum would spare items the player did not pick. Matches -> item is spared.
    internal sealed class KeepRule
    {
        // Sentinel Aspect value: match ANY boss aspect (identifier starts with "boss") instead of one exact id.
        internal const string AllBossAspects = VG.Core.KeepMatch.AllBossAspects;

        internal ItemCategory? Category;
        internal string SpecificType;   // equipment class name, null = any
        internal Rarity? MinRarity;
        internal ModuleSize? Size;
        internal int MinLevel;          // 0 = any
        internal string Aspect;         // aspect identifier, AllBossAspects sentinel, or null = any

        internal bool IsEmpty => !Category.HasValue && SpecificType == null && !MinRarity.HasValue
                                 && !Size.HasValue && MinLevel <= 0 && Aspect == null;

        // Adapter: build the game-free ItemFacts + KeepCriteria POCOs and let VG.Core.KeepMatch decide.
        // The matching logic (rank minimums, boss-aspect sentinel) lives there so it can be unit-tested.
        internal bool Matches(InventoryItemType item)
        {
            var eq = item.GetComponent<AbstractEquipment>();
            var facts = new VG.Core.ItemFacts
            {
                Category = item.itemCategory.ToString(),
                Type = eq != null ? eq.GetType().Name : null,
                RarityRank = (int)item.rarity,
                SizeRank = eq != null ? (int)eq.size : -1,
                Level = item.itemLevel,
                AspectIds = eq != null
                    ? eq.aspectSlots.Select(s => s?.equipAspect?.identifier).Where(id => id != null).ToArray()
                    : Array.Empty<string>(),
            };
            var crit = new VG.Core.KeepCriteria
            {
                Category = Category?.ToString(),
                Type = SpecificType,
                MinRarityRank = MinRarity.HasValue ? (int)MinRarity.Value : -1,
                SizeRank = Size.HasValue ? (int)Size.Value : -1,
                MinLevel = MinLevel,
                Aspect = Aspect,
            };
            return VG.Core.KeepMatch.Matches(crit, facts);
        }

        internal string Describe(Func<Rarity, string> colorRarity, Func<string, string> prettifyType = null)
        {
            var parts = new List<string>();
            if (Category.HasValue) parts.Add(Category.Value.ToString());
            if (SpecificType != null) parts.Add(prettifyType != null ? prettifyType(SpecificType) : SpecificType);
            if (MinRarity.HasValue) parts.Add("≥" + colorRarity(MinRarity.Value));
            if (Size.HasValue) parts.Add(Size.Value.ToString());
            if (MinLevel > 0) parts.Add("lvl≥" + MinLevel);
            if (Aspect != null) parts.Add("aspect:" + AutoSell.AspectName(Aspect));
            return parts.Count == 0 ? "(empty)" : string.Join(", ", parts);
        }

        // cat|type|rarity|size|level|aspect ; "~" = unset
        private string Serialize() => string.Join("|", new[]
        {
            Category?.ToString() ?? "~",
            SpecificType ?? "~",
            MinRarity?.ToString() ?? "~",
            Size?.ToString() ?? "~",
            MinLevel.ToString(),
            Aspect ?? "~"
        });

        private static KeepRule Deserialize(string s)
        {
            var p = s.Split('|');
            if (p.Length < 6) return null;
            var r = new KeepRule();
            if (p[0] != "~" && Enum.TryParse(p[0], out ItemCategory c)) r.Category = c;
            if (p[1] != "~") r.SpecificType = p[1];
            if (p[2] != "~" && Enum.TryParse(p[2], out Rarity ra)) r.MinRarity = ra;
            if (p[3] != "~" && Enum.TryParse(p[3], out ModuleSize sz)) r.Size = sz;
            int.TryParse(p[4], out r.MinLevel);
            if (p[5] != "~") r.Aspect = p[5];
            return r.IsEmpty ? null : r;
        }

        internal static List<KeepRule> ParseList(string raw)
            => string.IsNullOrEmpty(raw)
                ? new List<KeepRule>()
                : raw.Split(';').Select(Deserialize).Where(r => r != null).ToList();

        internal static string SerializeList(IEnumerable<KeepRule> rules)
            => string.Join(";", rules.Select(r => r.Serialize()));
    }
}
