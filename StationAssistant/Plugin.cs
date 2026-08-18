using System;
using System.Collections;
using System.Collections.Generic;
using System.Linq;
using System.Reflection;
using BepInEx;
using BepInEx.Configuration;
using BepInEx.Logging;
using VG.Shared;
using Behaviour.Item;
using Behaviour.Item.Usable;
using Behaviour.UI.Spacestation;
using HarmonyLib;
using Source.Galaxy.POI;
using Source.Item;
using Source.Player;
using Source.SpaceShip;
using UnityEngine;
using VG.ModApi;

using VG.Text;

namespace StationAssistant
{
    internal enum SellTrigger { Manual, OnDock, OnUndock }

    [BepInPlugin(Guid, "Station Assistant", "1.1.5")]
    public sealed class Plugin : BaseUnityPlugin
    {
        public const string Guid = "fulgan.vanguardgalaxy.stationassistant";

        internal static ManualLogSource Log;
        internal static Config Cfg;
        internal static SettingsWindow Window;

        private VG.Core.UpdateNotice _notice;

        private void Awake()
        {
            Log = Logger;
            Cfg = new Config(base.Config);
            GameSettings.Init(base.Config); // persist per-playthrough on every settings change
            Loc.Setup(Info?.Location);

            new Harmony(Guid).PatchAll();
            Window = new SettingsWindow(Cfg);

            // Fold our UI into the shared mod host (VG.ModApi): our tabs and hotkeys live in the one
            // neutral settings window alongside any other mod's — no separate window or hotkey polling.
            var host = VGModSettings.GetOrCreate();
            host.SetGameGate(() => VG.Game.GameState.Loaded);
            host.SetToggleKey(Cfg.ToggleKey.Value.MainKey);
            host.RegisterTab(Loc.T("tab.quartermaster"), Window.DrawQuartermasterPage, 0);
            host.RegisterTab(Loc.T("tab.sell"), Window.DrawSellPage, 1);
            host.RegisterTab(Loc.T("tab.ammo"), Window.DrawAmmoPage, 2);
            host.RegisterTab(Loc.T("tab.loadouts"), Window.DrawLoadoutsPage, 3);
            host.RegisterHotkey("stationassistant.sell", "Station Assistant: sell cargo",
                () => Cfg.SellHotkey.Value.MainKey,
                k => Cfg.SellHotkey.Value = new KeyboardShortcut(k),
                () => Window.ShowLastSell(AutoSell.SellNow(Cfg), announce: true));
            host.RegisterHotkey("stationassistant.ammo", "Station Assistant: gunner",
                () => Cfg.AmmoHotkey.Value.MainKey,
                k => Cfg.AmmoHotkey.Value = new KeyboardShortcut(k),
                () => Window.ShowLastAmmo(Gunner.RunNow(Cfg), announce: true));
            host.RegisterHotkey("stationassistant.decoy", "Station Assistant: toggle auto-decoy",
                () => Cfg.DecoyHotkey.Value.MainKey,
                k => Cfg.DecoyHotkey.Value = new KeyboardShortcut(k),
                DecoyLogic.ToggleAuto);

            // Version check only: it reads the published version list and reports what it says. Nothing is
            // downloaded, written or run. The running version comes from BepInEx's own metadata — the
            // [BepInPlugin] literal it parsed — never from a third copy written here.
            _notice = VG.Core.UpdateSettings.Install(base.Config, "Station Assistant", Guid,
                Info.Metadata.Version.ToString(), m => Util.Notify(m), m => Log.LogInfo(m));

            Log.LogInfo("Station Assistant loaded.");
        }

        private void Update()
        {
            GameSettings.Poll();  // swap gameplay settings when the playthrough changes
            _notice?.Pump();      // hand a finished version check onto the main thread
        }
    }

    internal sealed class Config
    {
        internal readonly ConfigEntry<bool> Enabled;
        internal readonly ConfigEntry<bool> AutoBuy;
        internal readonly ConfigEntry<int> DesiredStock;
        internal readonly ConfigEntry<bool> ActivateOnUndock;
        internal readonly ConfigEntry<bool> DecoyDisableDuringEcho;
        internal readonly ConfigEntry<KeyboardShortcut> DecoyHotkey;
        internal readonly ConfigEntry<KeyboardShortcut> ToggleKey;

        internal readonly ConfigEntry<bool> SellEnabled;
        internal readonly ConfigEntry<SellTrigger> SellMode;
        internal readonly ConfigEntry<KeyboardShortcut> SellHotkey;
        internal readonly ConfigEntry<Rarity> KeepRarity;
        internal readonly ConfigEntry<Rarity> KeepBoosterRarity;
        internal readonly ConfigEntry<int> KeepItemLevel;
        private readonly Dictionary<ItemCategory, ConfigEntry<bool>> _sellCategories = new Dictionary<ItemCategory, ConfigEntry<bool>>();

        internal readonly ConfigEntry<string> KeepRulesRaw;
        internal readonly List<KeepRule> KeepRules = new List<KeepRule>();

        internal readonly ConfigEntry<bool> AmmoEnabled;
        internal readonly ConfigEntry<SellTrigger> AmmoMode;
        internal readonly ConfigEntry<KeyboardShortcut> AmmoHotkey;
        internal readonly ConfigEntry<bool> AmmoStowUnused;
        internal readonly ConfigEntry<bool> AmmoAutoBuy;
        internal readonly ConfigEntry<bool> AmmoUseEchoMinutes;
        internal readonly ConfigEntry<string> AmmoTargetsRaw;
        // key = "<shipGuid><ammoIdentifier>" -> desired cargo count
        private readonly Dictionary<string, int> _ammoTargets = new Dictionary<string, int>();

        internal readonly ConfigEntry<SellTrigger> QmMode;
        internal readonly ConfigEntry<string> QmTargetsRaw;
        // key = shipGuid + sep + itemKey -> (inventory target in cargo, reserve target in armory)
        private readonly Dictionary<string, (int inv, int res)> _qmTargets = new Dictionary<string, (int inv, int res)>();
        // per-item (not per-ship) "skip while ECHO drives" toggles, keyed by item key
        private readonly Dictionary<string, ConfigEntry<bool>> _qmEchoSkip = new Dictionary<string, ConfigEntry<bool>>();

        // Gameplay settings that swap per playthrough (UI keybinds stay global). Filled at ctor end.
        internal readonly List<ConfigEntryBase> Gameplay = new List<ConfigEntryBase>();

        // Only equipment is sellable: turrets, modules and boosters carry rarity + item level, so the
        // rarity/level keep-floors are meaningful for them. Most other categories (ore, ammo, junk, …)
        // have no item level, which would make the level floor a no-op and risk dumping wanted stock.
        private static readonly ItemCategory[] SellableCategories =
        {
            ItemCategory.Turret, ItemCategory.Module, ItemCategory.Booster
        };

        // Carry values over after a config SECTION is renamed. BepInEx keys a setting by section+key, so a
        // rename leaves the old values in `OrphanedEntries` and every renamed entry silently starts at its
        // default — losing rebinds and packed per-ship data. Only entries still at their default are adopted,
        // so a value the player set under the new name always wins, and the orphan is dropped afterwards so
        // the migration runs exactly once.
        private static void AdoptLegacySection(ConfigFile file, string oldSection, string newSection, params string[] keys)
        {
            // `OrphanedEntries` is not public API, so it is reached reflectively — and a build that hides it
            // costs the migration, not the load.
            var orphans = typeof(ConfigFile)
                .GetProperty("OrphanedEntries", BindingFlags.Instance | BindingFlags.Public | BindingFlags.NonPublic)
                ?.GetValue(file) as IDictionary;
            if (orphans == null) return;

            foreach (var key in keys)
            {
                var legacy = new ConfigDefinition(oldSection, key);
                if (!orphans.Contains(legacy)) continue;
                var raw = orphans[legacy] as string;
                var moved = new ConfigDefinition(newSection, key);
                // The untyped indexer, not TryGetEntry<T>: this walks keys of mixed value types.
                if (raw != null && file.ContainsKey(moved))
                {
                    var entry = file[moved];
                    if (Equals(entry.BoxedValue, entry.DefaultValue))
                        try { entry.SetSerializedValue(raw); } catch { /* unparseable: keep the default */ }
                }
                orphans.Remove(legacy);
            }
            file.Save();
        }

        internal Config(ConfigFile file)
        {
            ToggleKey = file.Bind("UI", "ToggleKey", new KeyboardShortcut(KeyCode.F7),
                "Key to open/close the in-game settings window.");

            // HIDDEN developer flag, off by default: times each dock/undock step and logs the ones that held the
            // frame long enough to feel. A player's log is for what
            // went wrong, ⊥ for measurements, so this is invisible in the settings window and has to be set in the
            //.cfg — the same treatment Hypercom gives its debug endpoints. Removal is tracked as.
            var logSlow = file.Bind("Debug", "LogSlowSteps", false,
                new ConfigDescription(
                    "Log a warning when an on-dock/undock automation step holds the game's frame for more than 50ms. "
                    + "Developer diagnostic — leave off for normal play.",
                    null, new ConfigurationManagerAttributes { Browsable = false, IsAdvanced = true }));
            VG.Shared.Stall.Enabled = logSlow.Value;
            logSlow.SettingChanged += (_, __) => VG.Shared.Stall.Enabled = logSlow.Value;

            Enabled = file.Bind("DecoyTransponder", "Enabled", true,
                "Master switch for decoy (Umbral) transponder automation on undock.");

            AutoBuy = file.Bind("DecoyTransponder", "AutoBuy", true,
                "Buy decoy transponders from the Umbral (shadow faction) shop when below the desired stock. " +
                "Only fires at stations that actually have an Umbral shop.");

            DesiredStock = file.Bind("DecoyTransponder", "DesiredStock", 1,
                "Buy transponders (on docking) until the ship carries at least this many. 0 disables buying.");

            ActivateOnUndock = file.Bind("DecoyTransponder", "ActivateOnUndock", true,
                "Activate one decoy transponder when leaving a station, if one isn't already active.");

            DecoyDisableDuringEcho = file.Bind("DecoyTransponder", "DisableDuringEcho", true,
                "Skip decoy buy/activate while ECHO (autopilot) is running the ship. Avoids it being an AFK cheat.");

            DecoyHotkey = file.Bind("DecoyTransponder", "Hotkey", new KeyboardShortcut(KeyCode.F11),
                "Hotkey: toggle auto-decoy (activate-one-on-undock). If it turns ON while you're undocked "
                + "and no decoy is active, one is deployed immediately.");

            SellEnabled = file.Bind("AutoSell", "Enabled", true,
                "Master switch for the cargo-hold auto-sell feature.");
            SellMode = file.Bind("AutoSell", "Mode", SellTrigger.Manual,
                "Manual = sell only via the button/hotkey. OnDock = also sell each time you dock. " +
                "OnUndock = sell just before leaving (targets the ship you undock in, handy after switching ships).");
            SellHotkey = file.Bind("AutoSell", "SellHotkey", new KeyboardShortcut(KeyCode.F8),
                "Key to sell matching cargo right now. Selling always requires being docked at a station.");
            KeepRarity = file.Bind("AutoSell", "KeepRarity", Rarity.Standard,
                "Quality keep-floor (Standard < Enhanced < HighGrade < Exotic < Legendary). An item is kept if " +
                "it clears this OR the item-level floor; it sells only when below both. Boosters use their own floor below.");
            KeepBoosterRarity = file.Bind("AutoSell", "KeepBoosterRarity", Rarity.Standard,
                "Quality keep-floor for Booster items. Boosters are all item level 1, so the level floor is ignored for them.");
            KeepItemLevel = file.Bind("AutoSell", "KeepItemLevel", 0,
                "Item-level keep-floor. An item is kept if it clears this OR the quality floor. 0 = ignore level (quality alone decides).");

            foreach (var cat in SellableCategories)
                _sellCategories[cat] = file.Bind("AutoSell.Categories", cat.ToString(), false,
                    $"Sell items of category {cat} (subject to the rarity/level/size/type limits).");

            KeepRulesRaw = file.Bind("AutoSell", "KeepRules", "",
                "Keep-rule exceptions, packed. Edit via the in-game window rather than by hand. " +
                "Format: cat|type|rarity|size|level|aspect, rules joined by ';', '~' = unspecified.");
            KeepRules.AddRange(KeepRule.ParseList(KeepRulesRaw.Value));

            AmmoEnabled = file.Bind("Gunner", "Enabled", true,
                "Master switch for the gunner (stow unused ammo, restock ammo for equipped guns).");
            AmmoMode = file.Bind("Gunner", "Mode", SellTrigger.Manual,
                "Manual = run only via the button/hotkey. OnDock = also run each time you dock. " +
                "OnUndock = run just before leaving (targets the ship you undock in, handy after switching ships).");
            AmmoHotkey = file.Bind("Gunner", "Hotkey", new KeyboardShortcut(KeyCode.F9),
                "Key to run the gunner now. Always requires being docked at a station.");
            AmmoStowUnused = file.Bind("Gunner", "StowUnused", true,
                "Move ammo the currently equipped guns don't use from cargo to the station's material storage.");
            AmmoAutoBuy = file.Bind("Gunner", "AutoBuy", true,
                "Buy missing ammo from the station shop after pulling from material storage.");
            AmmoUseEchoMinutes = file.Bind("Gunner", "UseEchoMinutes", true,
                "Restock each equipped gun with enough ammo to fire for ECHO's configured number of minutes " +
                "(the Autopilot ammo setting), computed the same way ECHO reloads. When on, this replaces the " +
                "manual per-ammo targets below.");
            AmmoTargetsRaw = file.Bind("Gunner", "Targets", "",
                "Per-ship, per-ammo desired cargo counts, packed. Edit via the in-game window rather than by hand. " +
                "Format: shipGuid|ammoId|count, entries joined by ';'.");
            AdoptLegacySection(file, "AmmoValet", "Gunner",
                "Enabled", "Mode", "Hotkey", "StowUnused", "AutoBuy", "UseEchoMinutes", "Targets");
            LoadAmmoTargets();

            QmMode = file.Bind("Quartermaster", "Mode", SellTrigger.OnUndock,
                "When to auto-restock. Manual = only via the button. OnDock = each time you dock. " +
                "OnUndock = just before leaving — targets the ship you undock in, so switching ships in a " +
                "station still leaves stocked.");
            QmTargetsRaw = file.Bind("Quartermaster", "Targets", "",
                "Per-ship, per-item stock targets, packed. Edit via the in-game window rather than by hand. " +
                "Format: shipGuid|itemKey|inventory|reserve, entries joined by ';'.");
            LoadQmTargets();

            foreach (var sup in Quartermaster.Supplies)
                _qmEchoSkip[sup.Key] = file.Bind("Quartermaster.EchoSkip", sup.Key, true,
                    $"Skip restocking '{sup.Key}' while ECHO (autopilot) drives the ship.");

            // Everything except the UI keybinds is per-playthrough.
            Gameplay.AddRange(new ConfigEntryBase[]
            {
                Enabled, AutoBuy, DesiredStock, ActivateOnUndock, DecoyDisableDuringEcho,
                SellEnabled, SellMode, KeepRarity, KeepBoosterRarity, KeepItemLevel, KeepRulesRaw,
                AmmoEnabled, AmmoMode, AmmoStowUnused, AmmoAutoBuy, AmmoUseEchoMinutes, AmmoTargetsRaw,
                QmMode, QmTargetsRaw,
            });
            Gameplay.AddRange(_sellCategories.Values);
            Gameplay.AddRange(_qmEchoSkip.Values);
        }

        // Re-derive cached collections after per-playthrough values are swapped in.
        internal void ReloadDerived()
        {
            KeepRules.Clear();
            KeepRules.AddRange(KeepRule.ParseList(KeepRulesRaw.Value));
            _ammoTargets.Clear();
            LoadAmmoTargets();
            _qmTargets.Clear();
            LoadQmTargets();
        }

        private const char AmmoKeySep = (char)1;
        private static string AmmoKey(string shipGuid, string ammoId) => shipGuid + AmmoKeySep + ammoId;

        internal int AmmoTarget(string shipGuid, string ammoId)
            => _ammoTargets.TryGetValue(AmmoKey(shipGuid, ammoId), out var v) ? v : 0;

        internal void SetAmmoTarget(string shipGuid, string ammoId, int count)
        {
            var key = AmmoKey(shipGuid, ammoId);
            if (count <= 0)
                _ammoTargets.Remove(key);
            else
                _ammoTargets[key] = count;

            AmmoTargetsRaw.Value = string.Join(";", _ammoTargets.Select(kv =>
            {
                var sep = kv.Key.IndexOf(AmmoKeySep);
                return kv.Key.Substring(0, sep) + "|" + kv.Key.Substring(sep + 1) + "|" + kv.Value;
            }));
        }

        private void LoadAmmoTargets()
        {
            foreach (var entry in (AmmoTargetsRaw.Value ?? "").Split(new[] { ';' }, StringSplitOptions.RemoveEmptyEntries))
            {
                var p = entry.Split('|');
                if (p.Length >= 3 && int.TryParse(p[2], out var c) && c > 0)
                    _ammoTargets[AmmoKey(p[0], p[1])] = c;
            }
        }

        // Per-ship, per-item Quartermaster stock targets (same packed-string model as the ammo targets).
        private static string QmKey(string shipGuid, string itemKey) => shipGuid + AmmoKeySep + itemKey;

        internal (int inv, int res) QmTarget(string shipGuid, string itemKey)
            => _qmTargets.TryGetValue(QmKey(shipGuid, itemKey), out var v) ? v : (0, 0);

        internal bool QmEchoSkip(string itemKey)
            => _qmEchoSkip.TryGetValue(itemKey, out var e) && e.Value;

        internal ConfigEntry<bool> QmEchoSkipEntry(string itemKey)
            => _qmEchoSkip.TryGetValue(itemKey, out var e) ? e : null;

        internal void SetQmTarget(string shipGuid, string itemKey, int inv, int res)
        {
            Put(shipGuid, itemKey, inv, res);
            SaveQmTargets();
        }

        private void Put(string shipGuid, string itemKey, int inv, int res)
        {
            var key = QmKey(shipGuid, itemKey);
            if (inv <= 0 && res <= 0)
                _qmTargets.Remove(key);
            else
                _qmTargets[key] = (Math.Max(0, inv), Math.Max(0, res));
        }

        private void SaveQmTargets()
        {
            QmTargetsRaw.Value = string.Join(";", _qmTargets.Select(kv =>
            {
                var sep = kv.Key.IndexOf(AmmoKeySep);
                return kv.Key.Substring(0, sep) + "|" + kv.Key.Substring(sep + 1) + "|" + kv.Value.inv + "|" + kv.Value.res;
            }));
        }

        // Copy one ship's whole Quartermaster target set onto every other owned ship, and REPLACE what those
        // ships had — a partial merge would leave a ship half-configured from two different intents, which is
        // harder to reason about than "they all match this one now".
        //
        // Serialises once at the end rather than per write: SetQmTarget rebuilds the entire packed string each
        // call, so doing it per ship per supply would be needlessly quadratic.
        // Returns how many other ships were written.
        internal int CopyQmTargetsToAllShips(string fromShipGuid, IEnumerable<string> supplyKeys)
        {
            var p = GamePlayer.current;
            if (p == null || string.IsNullOrEmpty(fromShipGuid)) return 0;

            var keys = supplyKeys?.ToList() ?? new List<string>();
            var source = keys.Select(k => new { k, t = QmTarget(fromShipGuid, k) }).ToList();

            var targets = new List<string>();
            if (p.currentSpaceShip?.guid != null) targets.Add(p.currentSpaceShip.guid);
            if (p.spaceShips != null)
                foreach (var s in p.spaceShips)
                    if (s?.guid != null && !targets.Contains(s.guid)) targets.Add(s.guid);

            var n = 0;
            foreach (var guid in targets)
            {
                if (guid == fromShipGuid) continue;
                foreach (var s in source)
                    Put(guid, s.k, s.t.inv, s.t.res);
                n++;
            }
            if (n > 0) SaveQmTargets();
            return n;
        }

        private void LoadQmTargets()
        {
            foreach (var entry in (QmTargetsRaw.Value ?? "").Split(new[] { ';' }, StringSplitOptions.RemoveEmptyEntries))
            {
                var p = entry.Split('|');
                if (p.Length >= 4 && int.TryParse(p[2], out var inv) && int.TryParse(p[3], out var res) && (inv > 0 || res > 0))
                    _qmTargets[QmKey(p[0], p[1])] = (Math.Max(0, inv), Math.Max(0, res));
            }
        }

        internal void SaveKeepRules() => KeepRulesRaw.Value = KeepRule.SerializeList(KeepRules);

        internal IEnumerable<KeyValuePair<ItemCategory, ConfigEntry<bool>>> SellCategories => _sellCategories;

        internal bool IsCategoryEnabled(ItemCategory cat)
            => _sellCategories.TryGetValue(cat, out var entry) && entry.Value;
    }

    [HarmonyPatch(typeof(SpacestationExteriorManager), nameof(SpacestationExteriorManager.StartUndocking))]
    internal static class UndockPatch
    {
        [HarmonyPostfix]
        private static void Postfix()
        {
            try
            {
                var cfg = Plugin.Cfg;

                // Decoy: activate one transponder on undock.
                if (cfg.Enabled.Value && cfg.ActivateOnUndock.Value)
                {
                    var player = GamePlayer.current;
                    var cargo = player?.currentSpaceShip?.cargo;
                    var echo = cfg.QmEchoSkip("decoy") && player?.currentAutopilotSessionStats != null;
                    if (cargo != null && !player.hasUmbralTransponder && !echo)
                        DecoyLogic.ActivateDecoy(cargo);
                }

                // Quartermaster restock (after the decoy is activated, so the deployed one gets replaced).
                // OnUndock is the default: it targets the ship you actually leave in — switching ships in a
                // station still leaves stocked.
                //
                // TIMED, all three: this body runs inside a Harmony patch, so the game is frozen for exactly as
                // long as it takes, and the cost grows with the playthrough (one ammo pass moved 1,269 items on a
                // reported save). A freeze nobody can attribute is what these lines exist to prevent.
                if (cfg.Enabled.Value && cfg.QmMode.Value == SellTrigger.OnUndock)
                    Stall.Timed(say => { var r = Quartermaster.Restock(cfg); Plugin.Window.ShowLastQm(r); say($"stowed {r.Stowed}, pulled {r.Pulled}, bought {r.Bought}"); },
                                "undock quartermaster", Plugin.Log.LogWarning);

                // Sell / gunner can run on undock too — acts on the ship you actually leave in.
                if (cfg.SellEnabled.Value && cfg.SellMode.Value == SellTrigger.OnUndock)
                    Stall.Timed(say => { var r = AutoSell.SellNow(cfg); Plugin.Window.ShowLastSell(r); say($"{r.Items} item(s) sold"); },
                                "undock auto-sell", Plugin.Log.LogWarning);
                if (cfg.AmmoEnabled.Value && cfg.AmmoMode.Value == SellTrigger.OnUndock)
                    Stall.Timed(say => { var r = Gunner.RunNow(cfg); Plugin.Window.ShowLastAmmo(r); say($"stowed {r.Stowed}, pulled {r.Pulled}, bought {r.Bought}"); },
                                "undock ammo valet", Plugin.Log.LogWarning);
            }
            catch (Exception ex)
            {
                Plugin.Log.LogWarning($"Undock automation skipped after an error: {ex}");
            }
        }
    }

    // Decoy transponder activation on undock. Stocking the decoy (and other consumables) is the
    // Quartermaster's job now; this keeps the "activate one when leaving a station" behaviour, plus the
    // shared shop-purchase / cargo helpers reused by the gunner and the Quartermaster.
    internal static class DecoyLogic
    {
        // Activate one decoy from cargo. Returns true when one was actually deployed (a charge consumed).
        internal static bool ActivateDecoy(Inventory cargo)
        {
            var entry = cargo.items?.FirstOrDefault(i => IsTransponder(i?.item));
            if (entry is null)
                return false;

            var transponder = entry.item.GetComponent<UmbralTransponderItem>();
            // OnUse returns true when a charge is consumed.
            if (transponder != null && transponder.OnUse())
            {
                // The charge is already spent, so a refused removal cannot be undone — it is REPORTED instead,
                // because a transponder that stays in cargo after being used reads as the mod doing nothing.
                if (VG.Game.GameMembers.RemoveItems(cargo, entry, 1) != 1)
                    Plugin.Log.LogWarning("Decoy transponder was used but the game did not remove it from cargo.");
                Plugin.Log.LogInfo("Decoy transponder activated.");
                return true;
            }
            return false;
        }

        // Hotkey: the key means "I want a decoy out", so it branches on what is actually flying rather than
        // blindly flipping the setting. In space with the setting already on and nothing active, a press
        // DEPLOYS and leaves the setting on; the press that switches the setting off is the one made while a
        // decoy is already running (or while docked, where there is nothing to deploy). A manual press is
        // deliberate ∴ NOT gated by the ECHO/AFK guard, unlike the on-undock automation.
        internal static void ToggleAuto()
        {
            try
            {
                var cfg = Plugin.Cfg;
                var player = GamePlayer.current;
                var undocked = SpaceStationInterior.instance == null;

                if (cfg.ActivateOnUndock.Value && undocked && player != null && !player.hasUmbralTransponder)
                {
                    DeployNow(player);
                    return;
                }

                cfg.ActivateOnUndock.Value = !cfg.ActivateOnUndock.Value;
                if (!cfg.ActivateOnUndock.Value) { Util.Notify(Loc.T("decoy.off")); return; }

                // Turned ON. While docked, nothing to deploy now (it fires on the next undock).
                if (!undocked || player == null) { Util.Notify(Loc.T("decoy.on")); return; }
                if (player.hasUmbralTransponder) { Util.Notify(Loc.T("decoy.on.active")); return; }
                DeployNow(player);
            }
            catch (Exception ex) { Plugin.Log.LogWarning($"decoy hotkey failed: {ex.Message}"); }
        }

        // Both press paths that end in a deployment share this, so they cannot disagree about which hold is
        // drawn from or what the player is told when it is empty.
        private static void DeployNow(GamePlayer player)
        {
            var cargo = player.currentSpaceShip?.cargo;
            if (cargo != null && ActivateDecoy(cargo)) Util.Notify(Loc.T("decoy.on.deployed"));
            else Util.Notify(Loc.T("decoy.on.nostock"), warn: true);
        }

        private static bool IsTransponder(InventoryItemType item)
            => item != null && item.GetComponent<UmbralTransponderItem>() != null;

        internal static int BuyFromShop(GamePlayer player, ShopInventory shop, Func<InventoryItemType, bool> match, int needed)
        {
            var cargo = player.currentSpaceShip.cargo;
            var offer = shop.items?.FirstOrDefault(i => i?.item != null && match(i.item) && (i.count > 0 || i.item.HasInfiniteShopSupply()));
            if (offer is null)
                return 0;

            // Affordability (credit/barter/stock) + cargo fit decided by the shared, unit-tested planner;
            // cargo space via ShrinkToCargo. Then the game-way mutation. One flow shared with Quartermaster.
            var ctx = new VG.Game.BuyContext(player, offer.costItem, (_, want) => ShrinkToCargo(cargo, offer.item, want));
            var amount = VG.Core.PurchasePlan.Affordable(VG.Game.PurchaseExec.ToOffer(offer), ctx, needed);
            if (amount <= 0)
                return 0;

            if (!VG.Game.PurchaseExec.Apply(player, shop, offer, cargo, amount))
                return 0;
            return amount;
        }

        internal static int ShrinkToCargo(Inventory cargo, InventoryItemType item, int amount)
        {
            while (amount > 0 && cargo.IsFull(item.m3 * amount))
                amount--;
            return amount;
        }
    }

    // Fires on the real dock: SpaceStationInterior.Awake runs when the station interior opens
    // (any dock path — travel, manual fly-in, or re-dock), after the game inits shops and raises
    // MissionTrigger.DockedWithSpaceStation. SpaceshipHasArrived only fired on travel-arrival, so
    // manual docks and re-docks never triggered on-dock automation.
    [HarmonyPatch(typeof(SpaceStationInterior), "Awake")]
    internal static class DockPatch
    {
        [HarmonyPostfix]
        private static void Postfix()
        {
            try
            {
                var cfg = Plugin.Cfg;
                // Timed for the same reason the undock path is: the frame is held for the whole body.
                if (cfg.Enabled.Value && cfg.QmMode.Value == SellTrigger.OnDock)
                    Stall.Timed(say => { var r = Quartermaster.Restock(cfg); Plugin.Window.ShowLastQm(r); say($"stowed {r.Stowed}, pulled {r.Pulled}, bought {r.Bought}"); },
                                "dock quartermaster", Plugin.Log.LogWarning);
                if (cfg.SellEnabled.Value && cfg.SellMode.Value == SellTrigger.OnDock)
                    Stall.Timed(say => { var r = AutoSell.SellNow(cfg); Plugin.Window.ShowLastSell(r); say($"{r.Items} item(s) sold"); },
                                "dock auto-sell", Plugin.Log.LogWarning);
                if (cfg.AmmoEnabled.Value && cfg.AmmoMode.Value == SellTrigger.OnDock)
                    Stall.Timed(say => { var r = Gunner.RunNow(cfg); Plugin.Window.ShowLastAmmo(r); say($"stowed {r.Stowed}, pulled {r.Pulled}, bought {r.Bought}"); },
                                "dock ammo valet", Plugin.Log.LogWarning);
            }
            catch (Exception ex)
            {
                Plugin.Log.LogWarning($"On-dock automation skipped after an error: {ex}");
            }
        }
    }

    internal sealed class SettingsWindow
    {
        private readonly Config _cfg;
        private Vector2 _catScroll;
        private Vector2 _ruleScroll;
        private Vector2 _matchScroll;
        private Vector2 _ammoScroll;
        private Vector2 _qmScroll;
        private List<string> _matchList;
        private string _maxLevelBuf;
        private string _lastSell = "";
        private string _lastQm = "";
        // "Copy to all ships" is armed by the first click and performed by the second — it overwrites the
        // other ships' targets with no undo, so a stray click shouldn't do it.
        private bool _qmCopyArmed;
        private string _qmCopyMsg = "";
        private string _rulesMsg = "";
        private bool _pasteArmed;
        private string _lastAmmo = "";
        private string _profileMsg = "";
        private string _loadoutName = "";
        private int _pvIndex = -1;                 // preset index currently previewing an apply, -1 = none
        private List<string> _pvLines;
        private string _loadoutMsg = "";
        private string _loadoutShipGuid;           // detect ship change to re-prefill the name field
        private readonly Dictionary<string, string> _ammoBufs = new Dictionary<string, string>();
        private readonly Dictionary<string, string> _qmBufs = new Dictionary<string, string>(); // key = itemKey|inv / itemKey|res

        // Rule builder draft; index 0 = "Any".
        private int _bCat, _bType, _bRarity, _bSize, _bAspect;
        private string _bLevelBuf = "0";
        private string _openDd; // expanded dropdown id, null = none

        internal SettingsWindow(Config cfg)
        {
            _cfg = cfg;
            SyncBuffers();
        }

        // An action the player ASKED FOR reports on screen, whatever the outcome. The window line is for looking
        // back at; a hotkey press needs an answer where the player is looking, and "it did nothing" is an answer
        // — pressing F8 with every category off used to be indistinguishable from a broken hotkey.
        //
        // `announce` is false for the automatic runs: a "nothing to do" toast on every dock is noise, and the
        // success path announces itself from inside the job either way.
        internal void ShowLastSell(AutoSell.SellResult r, bool announce = false)
        {
            _lastSell = r.Items > 0
                ? Loc.F("sell.result.sold", Say.Count(r.Items, "item"), Say.Credits(r.Credits))
                : Loc.F("sell.result.nothing", r.Reason);
            if (announce && r.Items == 0) Util.Notify(_lastSell, warn: true);
        }

        internal void ShowLastAmmo(Gunner.AmmoResult r, bool announce = false)
        {
            _lastAmmo = r.Reason == "ok"
                ? Loc.F("ammo.result.ok", Util.Moved(r.Moves, r.Stowed, r.Pulled, r.Bought, "round"))
                : Loc.F("ammo.result.nothing", r.Reason);
            if (announce && r.Reason != "ok") Util.Notify(_lastAmmo, warn: true);
        }

        internal void ShowLastQm(Quartermaster.QmResult r, bool announce = false)
        {
            _lastQm = r.Skipped ? Loc.T(r.SkipReason == "space" ? "qm.result.skipped.space" : "qm.result.skipped.funds")
                : r.Short ? Loc.F("qm.result.short", r.ShortItems)
                : r.Reason == "ok" ? Loc.F("qm.result.ok", Util.Moved(r.Moves, r.Stowed, r.Pulled, r.Bought, "item"))
                : Loc.F("qm.result.nothing", r.Reason);
            if (announce && (r.Skipped || r.Short || r.Reason != "ok")) Util.Notify(_lastQm, warn: true);
        }

        private void SyncBuffers()
        {
            _maxLevelBuf = _cfg.KeepItemLevel.Value.ToString();
        }

        // Called after GameSettings swaps or copies a profile while the window may be open: refit the
        // text buffers to the new values (int fields don't self-heal; ammo/preview lists rebuild lazily).
        internal void OnProfileChanged()
        {
            SyncBuffers();
            _ammoBufs.Clear();
            _qmBufs.Clear();
            _matchList = null;
        }

        // Tab bodies registered with the shared host (VG.ModApi). Each renders its content plus SA's
        // per-pilot profile footer; the host owns the window chrome, tab bar, hotkey and close button.
        internal void DrawQuartermasterPage() { DrawQuartermasterTab(); GUILayout.Space(4f); DrawProfileBar(); }
        internal void DrawSellPage() { DrawSellTab(); GUILayout.Space(4f); DrawProfileBar(); }
        internal void DrawAmmoPage() { DrawAmmoTab(); GUILayout.Space(4f); DrawProfileBar(); }
        internal void DrawLoadoutsPage() { DrawLoadoutsTab(); }

        private void DrawLoadoutsTab()
        {
            if (Behaviour.UI.Spacestation.Location.PersonalHangar.current == null)
            {
                GUILayout.Label(Loc.T("loadout.hangarOnly"));
                return;
            }

            var presets = LoadoutStore.Current(out var shipLabel, out var guid);
            if (shipLabel == null)
            {
                GUILayout.Label(Loc.T("loadout.noShip"));
                return;
            }

            // Prefill the name field with the ship's last saved/applied loadout; reset on ship change.
            if (guid != _loadoutShipGuid)
            {
                _loadoutShipGuid = guid;
                _loadoutName = LoadoutStore.LastName();
                _pvIndex = -1; _pvLines = null; _loadoutMsg = "";
            }

            GUILayout.Label(Loc.F("loadout.ship", shipLabel));
            GUILayout.BeginHorizontal();
            _loadoutName = GUILayout.TextField(_loadoutName, GUILayout.MinWidth(150f));
            if (GUILayout.Button(Loc.T("loadout.save"), GUILayout.Width(150f)) && LoadoutStore.SaveCurrent(_loadoutName))
                _loadoutMsg = Loc.F("loadout.saved", _loadoutName.Trim());
            GUILayout.EndHorizontal();

            // Indicator: does the ship currently match the preset named in the field?
            var sel = LoadoutStore.FindByName(_loadoutName);
            if (sel != null)
            {
                var matches = LoadoutStore.MatchesCurrent(sel) == true;
                GUILayout.Label(matches
                    ? "<color=#60c060>✓ " + Loc.T("loadout.matches") + "</color>"
                    : "<color=#e0a030>● " + Loc.T("loadout.differs") + "</color>");
            }

            GUILayout.Space(6f);
            if (presets.Count == 0)
            {
                GUILayout.Label(Loc.T("loadout.none"));
            }
            else
            {
                var del = -1;
                for (var i = 0; i < presets.Count; i++)
                {
                    GUILayout.BeginHorizontal();
                    GUILayout.Label(Loc.F("loadout.entry", presets[i].name, presets[i].slots.Count));
                    if (GUILayout.Button(Loc.T("loadout.apply"), GUILayout.Width(70f)))
                    {
                        _pvIndex = i; _pvLines = LoadoutStore.Preview(presets[i]); _loadoutMsg = "";
                        _loadoutName = presets[i].name; // track selection for the name field + indicator
                    }
                    if (GUILayout.Button(Loc.T("loadout.delete"), GUILayout.Width(70f)))
                        del = i;
                    GUILayout.EndHorizontal();

                    if (_pvIndex == i && _pvLines != null)
                    {
                        foreach (var line in _pvLines)
                            GUILayout.Label("<size=11>  " + line + "</size>");
                        GUILayout.BeginHorizontal();
                        if (GUILayout.Button(Loc.T("loadout.confirm"), GUILayout.Width(150f)))
                        {
                            _loadoutMsg = LoadoutStore.Apply(presets[i]);
                            _pvIndex = -1; _pvLines = null;
                        }
                        if (GUILayout.Button(Loc.T("loadout.cancel"), GUILayout.Width(90f)))
                        {
                            _pvIndex = -1; _pvLines = null;
                        }
                        GUILayout.EndHorizontal();
                    }
                }
                if (del >= 0) { LoadoutStore.Delete(del); _pvIndex = -1; _pvLines = null; }
            }

            if (_loadoutMsg.Length > 0)
                GUILayout.Label("<size=11>" + _loadoutMsg + "</size>");

            GUILayout.Space(4f);
            GUILayout.Label("<size=11>" + Loc.T("loadout.applyHint") + "</size>");
        }

        // Per-pilot profile footer: shows the active pilot and offers to copy another pilot's settings.
        private void DrawProfileBar()
        {
            var active = GameSettings.ActiveKey;
            if (active == null)
                return; // main menu — no pilot active

            GUILayout.Label(Loc.F("profile.active", active));

            var others = GameSettings.OtherProfiles();
            if (others.Count == 0)
                return;

            GUILayout.BeginHorizontal();
            GUILayout.Label(Loc.T("profile.copyFrom"), GUILayout.Width(120f));
            if (GUILayout.Button(Loc.T("profile.pick"), GUILayout.MinWidth(150f)))
                _openDd = _openDd == "profile" ? null : "profile";
            GUILayout.EndHorizontal();

            if (_openDd == "profile")
                foreach (var k in others)
                    if (GUILayout.Button("    " + k))
                    {
                        GameSettings.CopyFrom(k);
                        _profileMsg = Loc.F("profile.copied", k);
                        _openDd = null;
                    }

            if (_profileMsg.Length > 0)
                GUILayout.Label("<size=11>" + _profileMsg + "</size>");
        }

        private void DrawQuartermasterTab()
        {
            _cfg.Enabled.Value = GUILayout.Toggle(_cfg.Enabled.Value, Loc.T("qm.enabled"));

            GUILayout.Space(4f);
            GUILayout.BeginHorizontal();
            GUILayout.Label(Loc.T("sell.mode"), GUILayout.Width(46f));
            if (GUILayout.Toggle(_cfg.QmMode.Value == SellTrigger.Manual, Loc.T("mode.manual"), GUI.skin.button))
                _cfg.QmMode.Value = SellTrigger.Manual;
            if (GUILayout.Toggle(_cfg.QmMode.Value == SellTrigger.OnDock, Loc.T("mode.onDock"), GUI.skin.button))
                _cfg.QmMode.Value = SellTrigger.OnDock;
            if (GUILayout.Toggle(_cfg.QmMode.Value == SellTrigger.OnUndock, Loc.T("mode.onUndock"), GUI.skin.button))
                _cfg.QmMode.Value = SellTrigger.OnUndock;
            GUILayout.EndHorizontal();

            GUILayout.Space(6f);
            GUILayout.Label(Loc.T("qm.flags"));
            _cfg.AutoBuy.Value = GUILayout.Toggle(_cfg.AutoBuy.Value, Loc.T("qm.autobuy"));

            GUILayout.Space(6f);
            var ship = GamePlayer.current?.currentSpaceShip;
            if (ship is null)
            {
                GUILayout.Label(Loc.T("qm.noShip"));
            }
            else
            {
                var name = Util.ShipName(ship);
                GUILayout.Label(Loc.F("qm.ship", name));
                GUILayout.Label(Loc.T("qm.header"));
                _qmScroll = GUILayout.BeginScrollView(_qmScroll, GUILayout.Height(230f));
                foreach (var sup in Quartermaster.Supplies)
                    DrawQmRow(ship, sup);
                GUILayout.EndScrollView();

                // Set one ship up properly, then give the rest of the fleet the same orders. Two-step, because
                // it REPLACES the other ships' targets and there is no undo — the first click only arms it.
                GUILayout.Space(4f);
                GUILayout.BeginHorizontal();
                if (_qmCopyArmed)
                {
                    if (GUILayout.Button(Loc.T("qm.copyAll.confirm"), GUILayout.Width(190f)))
                    {
                        var n = _cfg.CopyQmTargetsToAllShips(ship.guid, Quartermaster.Supplies.Select(s => s.Key));
                        _qmCopyMsg = n > 0 ? Loc.F("qm.copyAll.done", Say.Count(n, "other ship")) : Loc.T("qm.copyAll.none");
                        _qmCopyArmed = false;
                    }
                    if (GUILayout.Button(Loc.T("qm.copyAll.cancel"), GUILayout.Width(80f)))
                        _qmCopyArmed = false;
                }
                else if (GUILayout.Button(Loc.T("qm.copyAll"), GUILayout.Width(190f)))
                {
                    _qmCopyArmed = true;
                    _qmCopyMsg = "";
                }
                GUILayout.EndHorizontal();
                if (_qmCopyMsg.Length > 0)
                    GUILayout.Label("<size=11>" + _qmCopyMsg + "</size>");
            }

            GUILayout.Space(6f);
            if (GUILayout.Button(Loc.T("qm.runNow")))
                ShowLastQm(Quartermaster.Restock(_cfg), announce: true);
            if (_lastQm.Length > 0)
                GUILayout.Label("<size=11>" + _lastQm + "</size>");
            GUILayout.Label(Loc.F("qm.saveHint", _cfg.ToggleKey.Value));
        }

        private void DrawQmRow(SpaceShipData ship, Quartermaster.Supply sup)
        {
            var haveC = Quartermaster.CountMatching(ship.cargo, sup.Match);
            var haveA = Quartermaster.CountMatching(GamePlayer.current?.globalInventory, sup.Match);

            // Line 1: name + live cargo/armory counts (own full-width line, so it can't shove the steppers).
            GUILayout.Label(Loc.F("qm.row", Loc.T(sup.LabelKey), haveC, haveA));

            // Line 2: cargo & armory targets (0 = ignore that container). Indented, left-aligned.
            GUILayout.BeginHorizontal();
            GUILayout.Space(16f);
            GUILayout.Label(Loc.T("qm.inv"), GUILayout.Width(28f));
            QmStepper(ship, sup, reserve: false);
            GUILayout.Space(14f);
            GUILayout.Label(Loc.T("qm.res"), GUILayout.Width(30f));
            QmStepper(ship, sup, reserve: true);
            GUILayout.FlexibleSpace();
            GUILayout.EndHorizontal();

            // Line 3: per-item options — skip during ECHO, and (decoy only) activate one on undock.
            GUILayout.BeginHorizontal();
            GUILayout.Space(16f);
            var echoEntry = _cfg.QmEchoSkipEntry(sup.Key);
            if (echoEntry != null)
                echoEntry.Value = GUILayout.Toggle(echoEntry.Value, Loc.T("qm.echoSkip"));
            if (sup.AutoUse)
            {
                GUILayout.Space(14f);
                _cfg.ActivateOnUndock.Value = GUILayout.Toggle(_cfg.ActivateOnUndock.Value, Loc.T("qm.autoActivate"));
            }
            GUILayout.FlexibleSpace();
            GUILayout.EndHorizontal();

            GUILayout.Space(8f); // gap between items
        }

        // "- [field] +" for one target field (inventory or reserve); persists both values together.
        private void QmStepper(SpaceShipData ship, Quartermaster.Supply sup, bool reserve)
        {
            var t = _cfg.QmTarget(ship.guid, sup.Key);
            var cur = reserve ? t.res : t.inv;
            var bufKey = sup.Key + (reserve ? "|res" : "|inv");
            if (!_qmBufs.TryGetValue(bufKey, out var buf) || (int.TryParse(buf, out var b) && b != cur))
            {
                buf = cur.ToString();
                _qmBufs[bufKey] = buf;
            }

            if (GUILayout.Button("-", GUILayout.Width(24f)))
            {
                cur = Mathf.Max(0, cur - 1);
                PersistQm(ship, sup, reserve, cur);
                _qmBufs[bufKey] = cur.ToString();
            }
            var typed = GUILayout.TextField(_qmBufs[bufKey], GUILayout.Width(44f));
            if (typed != _qmBufs[bufKey])
            {
                _qmBufs[bufKey] = typed;
                if (int.TryParse(typed, out var parsed))
                    PersistQm(ship, sup, reserve, Mathf.Max(0, parsed));
            }
            if (GUILayout.Button("+", GUILayout.Width(24f)))
            {
                cur += 1;
                PersistQm(ship, sup, reserve, cur);
                _qmBufs[bufKey] = cur.ToString();
            }
        }

        private void PersistQm(SpaceShipData ship, Quartermaster.Supply sup, bool reserve, int val)
        {
            var t = _cfg.QmTarget(ship.guid, sup.Key);
            if (reserve)
                _cfg.SetQmTarget(ship.guid, sup.Key, t.inv, val);
            else
                _cfg.SetQmTarget(ship.guid, sup.Key, val, t.res);
        }

        private void DrawAmmoTab()
        {
            _cfg.AmmoEnabled.Value = GUILayout.Toggle(_cfg.AmmoEnabled.Value, Loc.T("ammo.enabled"));

            GUILayout.Space(4f);
            GUILayout.BeginHorizontal();
            GUILayout.Label(Loc.T("sell.mode"), GUILayout.Width(46f));
            if (GUILayout.Toggle(_cfg.AmmoMode.Value == SellTrigger.Manual, Loc.T("mode.manual"), GUI.skin.button))
                _cfg.AmmoMode.Value = SellTrigger.Manual;
            if (GUILayout.Toggle(_cfg.AmmoMode.Value == SellTrigger.OnDock, Loc.T("mode.onDock"), GUI.skin.button))
                _cfg.AmmoMode.Value = SellTrigger.OnDock;
            if (GUILayout.Toggle(_cfg.AmmoMode.Value == SellTrigger.OnUndock, Loc.T("mode.onUndock"), GUI.skin.button))
                _cfg.AmmoMode.Value = SellTrigger.OnUndock;
            GUILayout.EndHorizontal();

            GUILayout.Space(4f);
            _cfg.AmmoStowUnused.Value = GUILayout.Toggle(_cfg.AmmoStowUnused.Value, Loc.T("ammo.stowUnused"));
            _cfg.AmmoAutoBuy.Value = GUILayout.Toggle(_cfg.AmmoAutoBuy.Value, Loc.T("ammo.autobuy"));
            _cfg.AmmoUseEchoMinutes.Value = GUILayout.Toggle(_cfg.AmmoUseEchoMinutes.Value, Loc.F("ammo.echoMinutes", Gunner.EchoMinutes()));

            GUILayout.Space(6f);
            var ship = GamePlayer.current?.currentSpaceShip;
            if (ship is null)
            {
                GUILayout.Label(Loc.T("ammo.noShip"));
            }
            else
            {
                var name = Util.ShipName(ship);
                GUILayout.Label(Loc.F("ammo.ship", name));

                var ammos = Gunner.EquippedAmmoTypes(ship);
                if (ammos.Count == 0)
                {
                    GUILayout.Label(Loc.T("ammo.noGuns"));
                }
                else if (_cfg.AmmoUseEchoMinutes.Value)
                {
                    // ECHO-minutes mode: targets are computed, not edited. Show them read-only.
                    GUILayout.Label(Loc.F("ammo.echoTargets", Gunner.EchoMinutes()));
                    _ammoScroll = GUILayout.BeginScrollView(_ammoScroll, GUILayout.Height(160f));
                    foreach (var ammo in ammos)
                    {
                        var label = Util.ItemName(ammo);
                        GUILayout.Label(Loc.F("ammo.echoTargetRow", label, Gunner.EchoTargetFor(ship, ammo)));
                    }
                    GUILayout.EndScrollView();
                }
                else
                {
                    GUILayout.Label(Loc.T("ammo.targets"));
                    _ammoScroll = GUILayout.BeginScrollView(_ammoScroll, GUILayout.Height(160f));
                    foreach (var ammo in ammos)
                        DrawAmmoRow(ship, ammo);
                    GUILayout.EndScrollView();

                    if (GUILayout.Button(Loc.T("ammo.useCurrent")))
                        foreach (var ammo in ammos)
                        {
                            var have = ship.cargo?.GetCount(ammo) ?? 0;
                            _cfg.SetAmmoTarget(ship.guid, ammo.identifier, have);
                            _ammoBufs[ammo.identifier] = have.ToString();
                        }
                }
            }

            GUILayout.Space(6f);
            GUILayout.BeginHorizontal();
            if (GUILayout.Button(Loc.F("ammo.runNow", _cfg.AmmoHotkey.Value)))
                ShowLastAmmo(Gunner.RunNow(_cfg), announce: true);
            if (GUILayout.Button(Loc.T("ammo.autoload")))
                ShowLastAmmo(Gunner.Autoload(_cfg));
            GUILayout.EndHorizontal();
            GUILayout.Label(Loc.T("ammo.autoloadHint"));
            if (_lastAmmo.Length > 0)
                GUILayout.Label("<size=11>" + _lastAmmo + "</size>");
        }

        private void DrawAmmoRow(SpaceShipData ship, InventoryItemType ammo)
        {
            var id = ammo.identifier;
            var label = Util.ItemName(ammo) ?? id;
            var target = _cfg.AmmoTarget(ship.guid, id);
            if (!_ammoBufs.TryGetValue(id, out var buf) || (int.TryParse(buf, out var b) && b != target))
            {
                buf = target.ToString();
                _ammoBufs[id] = buf;
            }
            var have = ship.cargo?.GetCount(ammo) ?? 0;

            GUILayout.BeginHorizontal();
            GUILayout.Label(Loc.F("ammo.row", label, have), GUILayout.Width(190f));
            if (GUILayout.Button("-", GUILayout.Width(26f)))
            {
                target = Mathf.Max(0, target - 1);
                _cfg.SetAmmoTarget(ship.guid, id, target);
                _ammoBufs[id] = target.ToString();
            }
            var typed = GUILayout.TextField(_ammoBufs[id], GUILayout.Width(50f));
            if (typed != _ammoBufs[id])
            {
                _ammoBufs[id] = typed;
                if (int.TryParse(typed, out var parsed))
                    _cfg.SetAmmoTarget(ship.guid, id, Mathf.Max(0, parsed));
            }
            if (GUILayout.Button("+", GUILayout.Width(26f)))
            {
                target += 1;
                _cfg.SetAmmoTarget(ship.guid, id, target);
                _ammoBufs[id] = target.ToString();
            }
            GUILayout.EndHorizontal();
        }

        private void DrawSellTab()
        {
            GUILayout.BeginHorizontal();

            // LEFT column
            GUILayout.BeginVertical(GUILayout.Width(280f));
            _cfg.SellEnabled.Value = GUILayout.Toggle(_cfg.SellEnabled.Value, Loc.T("sell.enabled"));

            GUILayout.Space(4f);
            GUILayout.BeginHorizontal();
            GUILayout.Label(Loc.T("sell.mode"), GUILayout.Width(46f));
            if (GUILayout.Toggle(_cfg.SellMode.Value == SellTrigger.Manual, Loc.T("mode.manual"), GUI.skin.button))
                _cfg.SellMode.Value = SellTrigger.Manual;
            if (GUILayout.Toggle(_cfg.SellMode.Value == SellTrigger.OnDock, Loc.T("mode.onDock"), GUI.skin.button))
                _cfg.SellMode.Value = SellTrigger.OnDock;
            if (GUILayout.Toggle(_cfg.SellMode.Value == SellTrigger.OnUndock, Loc.T("mode.onUndock"), GUI.skin.button))
                _cfg.SellMode.Value = SellTrigger.OnUndock;
            GUILayout.EndHorizontal();

            GUILayout.Space(6f);
            GUILayout.Label(Loc.T("sell.keepFloorHdr"));
            EnumStepper(Loc.T("sell.keepQuality"), () => _cfg.KeepRarity.Value, v => _cfg.KeepRarity.Value = v, ColorRarity);
            EnumStepper(Loc.T("sell.keepBooster"), () => _cfg.KeepBoosterRarity.Value, v => _cfg.KeepBoosterRarity.Value = v, ColorRarity);
            IntField(Loc.T("sell.keepLevel"), _cfg.KeepItemLevel, ref _maxLevelBuf);

            GUILayout.Space(6f);
            GUILayout.Label(Loc.T("sell.categories"));
            _catScroll = GUILayout.BeginScrollView(_catScroll, GUILayout.Height(150f));
            foreach (var kv in _cfg.SellCategories)
                kv.Value.Value = GUILayout.Toggle(kv.Value.Value, " " + kv.Key);
            GUILayout.EndScrollView();

            GUILayout.Space(6f);
            var matches = AutoSell.PreviewCount(_cfg, out var est);
            GUILayout.Label(Loc.F("sell.matches", matches, est.ToString("N0")));

            GUILayout.BeginHorizontal();
            if (GUILayout.Button(Loc.F("btn.sellNow", _cfg.SellHotkey.Value)))
                ShowLastSell(AutoSell.SellNow(_cfg), announce: true);
            if (GUILayout.Button(Loc.T("btn.listMatches")))
                _matchList = AutoSell.ListMatches(_cfg);
            GUILayout.EndHorizontal();

            if (_lastSell.Length > 0)
                GUILayout.Label("<size=11>" + _lastSell + "</size>");

            if (_matchList is not null)
            {
                GUILayout.Label(Loc.F("sell.wouldSell", Say.Count(_matchList.Count, "stack")));
                _matchScroll = GUILayout.BeginScrollView(_matchScroll, GUILayout.Height(120f));
                if (_matchList.Count == 0)
                    GUILayout.Label(Loc.T("sell.nothingMatches"));
                else
                    foreach (var line in _matchList)
                        GUILayout.Label("<size=11>" + line + "</size>");
                GUILayout.EndScrollView();
                if (GUILayout.Button(Loc.T("btn.hideList")))
                    _matchList = null;
            }
            GUILayout.EndVertical();

            GUILayout.Space(10f);

            // RIGHT column
            GUILayout.BeginVertical(GUILayout.Width(300f));
            GUILayout.Label(Loc.T("rules.header"));

            GUILayout.BeginHorizontal();
            if (GUILayout.Button(Loc.T("btn.copyRules")))
            {
                GUIUtility.systemCopyBuffer = KeepRule.SerializeList(_cfg.KeepRules);
                _rulesMsg = Loc.F("rules.copied", Say.Count(_cfg.KeepRules.Count, "rule"));
                _pasteArmed = false;
            }
            if (GUILayout.Button(_pasteArmed ? Loc.T("btn.pasteConfirm") : Loc.T("btn.pasteRules")))
                PasteRules();
            GUILayout.EndHorizontal();
            if (_rulesMsg.Length > 0)
                GUILayout.Label("<size=11>" + _rulesMsg + "</size>");

            _ruleScroll = GUILayout.BeginScrollView(_ruleScroll, GUILayout.Height(300f));
            DrawRuleList();
            DrawRuleBuilder();
            GUILayout.EndScrollView();
            GUILayout.EndVertical();

            GUILayout.EndHorizontal();
        }

        // Import keep-rules from the clipboard. Safe: validates first, never wipes the existing list
        // on empty/garbage input, and requires a second (confirm) click before replacing non-empty rules.
        private void PasteRules()
        {
            List<KeepRule> parsed;
            try
            {
                parsed = KeepRule.ParseList(GUIUtility.systemCopyBuffer);
            }
            catch (Exception ex)
            {
                Plugin.Log.LogWarning($"Keep-rule import failed: {ex.Message}");
                _rulesMsg = Loc.T("rules.importBad");
                _pasteArmed = false;
                return;
            }

            if (parsed.Count == 0)
            {
                // Nothing valid parsed — leave the current list untouched.
                _rulesMsg = Loc.T("rules.importBad");
                _pasteArmed = false;
                return;
            }

            if (_cfg.KeepRules.Count > 0 && !_pasteArmed)
            {
                // Would overwrite existing rules — arm and wait for a confirming second click.
                _pasteArmed = true;
                _rulesMsg = Loc.F("rules.pasteArm", Say.Count(_cfg.KeepRules.Count, "rule"), Say.Count(parsed.Count, "rule"));
                return;
            }

            _cfg.KeepRules.Clear();
            _cfg.KeepRules.AddRange(parsed);
            _cfg.SaveKeepRules();
            _rulesMsg = Loc.F("rules.imported", Say.Count(parsed.Count, "rule"));
            _pasteArmed = false;
        }

        private void DrawRuleList()
        {
            if (_cfg.KeepRules.Count == 0)
            {
                GUILayout.Label(Loc.T("rules.none"));
                return;
            }
            for (var i = 0; i < _cfg.KeepRules.Count; i++)
            {
                GUILayout.BeginHorizontal();
                var remove = GUILayout.Button("✕", GUILayout.Width(24f));
                GUILayout.Label("<size=11>" + _cfg.KeepRules[i].Describe(ColorRarity, Prettify) + "</size>");
                GUILayout.EndHorizontal();
                if (remove)
                {
                    _cfg.KeepRules.RemoveAt(i);
                    _cfg.SaveKeepRules();
                    return;
                }
            }
        }

        private void DrawRuleBuilder()
        {
            GUILayout.Space(4f);
            GUILayout.Label(Loc.T("rules.addHdr"));

            var cats = _cfg.SellCategories.Select(k => k.Key).ToList();
            var types = AutoSell.AllEquipmentTypes();
            var aspects = AutoSell.AllAspects();

            var any = Loc.T("opt.any");
            var catOpts = Prepend(any, cats.Select(c => c.ToString()));
            var typeOpts = Prepend(any, types.Select(Prettify));
            var rarityOpts = Prepend(any, RarityOrder.Select(ColorRarity));
            var sizeOpts = new[] { any, "Tiny", "Small", "Medium", "Large" };
            var aspectOpts = Prepend(any, aspects.Select(a => a.Name));

            _bCat = Dropdown("cat", Loc.T("field.category"), catOpts, _bCat);
            _bType = Dropdown("type", Loc.T("field.type"), typeOpts, _bType);
            _bRarity = Dropdown("rar", Loc.T("field.minRarity"), rarityOpts, _bRarity);
            _bSize = Dropdown("size", Loc.T("field.size"), sizeOpts, _bSize);

            GUILayout.BeginHorizontal();
            GUILayout.Label(Loc.T("field.minLevel"), GUILayout.Width(80f));
            _bLevelBuf = GUILayout.TextField(_bLevelBuf ?? "0", GUILayout.MinWidth(50f));
            GUILayout.EndHorizontal();

            _bAspect = Dropdown("asp", Loc.T("field.aspect"), aspectOpts, _bAspect);

            if (GUILayout.Button(Loc.T("btn.addRule")))
            {
                var rule = new KeepRule();
                if (_bCat > 0 && _bCat - 1 < cats.Count) rule.Category = cats[_bCat - 1];
                if (_bType > 0 && _bType - 1 < types.Count) rule.SpecificType = types[_bType - 1];
                if (_bRarity > 0) rule.MinRarity = (Rarity)(_bRarity - 1);
                if (_bSize > 0) rule.Size = (ModuleSize)(_bSize - 1);
                if (int.TryParse(_bLevelBuf, out var lvl) && lvl > 0) rule.MinLevel = lvl;
                if (_bAspect > 0 && _bAspect - 1 < aspects.Count) rule.Aspect = aspects[_bAspect - 1].Id;

                if (!rule.IsEmpty)
                {
                    _cfg.KeepRules.Add(rule);
                    _cfg.SaveKeepRules();
                }
            }
        }

        private static string[] Prepend(string first, IEnumerable<string> rest)
        {
            var list = new List<string> { first };
            list.AddRange(rest);
            return list.ToArray();
        }

        // grey, green, blue, purple, gold
        private static readonly Rarity[] RarityOrder = { Rarity.Standard, Rarity.Enhanced, Rarity.HighGrade, Rarity.Exotic, Rarity.Legendary };
        // Colour from the shared VG.Core.Rarity table (keyed by name) so the palette has one source.
        private static string ColorRarity(Rarity r) => $"<color={VG.Core.Rarity.Color(r.ToString())}>{r}</color>";

        private int Dropdown(string id, string label, string[] opts, int idx)
        {
            if (opts.Length == 0) opts = new[] { "Any" };
            idx = Mathf.Clamp(idx, 0, opts.Length - 1);

            GUILayout.BeginHorizontal();
            GUILayout.Label(label, GUILayout.Width(80f));
            if (GUILayout.Button(opts[idx], GUILayout.MinWidth(150f)))
                _openDd = _openDd == id ? null : id;
            GUILayout.EndHorizontal();

            if (_openDd == id)
                for (var i = 0; i < opts.Length; i++)
                    if (GUILayout.Button((i == idx ? "▸ " : "    ") + opts[i]))
                    {
                        idx = i;
                        _openDd = null;
                    }

            return idx;
        }

        // "RailCannonTurret" -> "Rail Cannon"
        private static string Prettify(string typeName)
        {
            var s = typeName;
            if (s.EndsWith("Turret")) s = s.Substring(0, s.Length - "Turret".Length);
            else if (s.EndsWith("Module")) s = s.Substring(0, s.Length - "Module".Length);
            return System.Text.RegularExpressions.Regex.Replace(s, "(?<=[a-z])(?=[A-Z])", " ");
        }

        private static void EnumStepper<T>(string label, Func<T> get, Action<T> set, Func<T, string> fmt = null) where T : struct, Enum
        {
            var values = (T[])Enum.GetValues(typeof(T));
            var idx = Array.IndexOf(values, get());
            if (idx < 0) idx = 0;

            GUILayout.BeginHorizontal();
            GUILayout.Label(label, GUILayout.Width(140f));
            if (GUILayout.Button("◄", GUILayout.Width(24f)))
                set(values[(idx - 1 + values.Length) % values.Length]);
            GUILayout.Label(fmt is not null ? fmt(get()) : get().ToString(), GUILayout.MinWidth(64f));
            if (GUILayout.Button("►", GUILayout.Width(24f)))
                set(values[(idx + 1) % values.Length]);
            GUILayout.EndHorizontal();
        }

        private static void IntField(string label, ConfigEntry<int> entry, ref string buffer)
        {
            GUILayout.Label(label);
            GUILayout.BeginHorizontal();

            if (GUILayout.Button("-", GUILayout.Width(26f)))
            {
                entry.Value = Mathf.Max(0, entry.Value - 1);
                buffer = entry.Value.ToString();
            }

            var typed = GUILayout.TextField(buffer, GUILayout.MinWidth(60f));
            if (typed != buffer)
            {
                buffer = typed;
                if (int.TryParse(typed, out var parsed))
                    entry.Value = Mathf.Max(0, parsed);
            }

            if (GUILayout.Button("+", GUILayout.Width(26f)))
            {
                entry.Value += 1;
                buffer = entry.Value.ToString();
            }

            GUILayout.EndHorizontal();
        }
    }
}

