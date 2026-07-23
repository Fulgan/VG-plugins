using System;
using System.Collections.Generic;
using System.Linq;
using BepInEx;
using BepInEx.Configuration;
using BepInEx.Logging;
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

namespace StationAssistant
{
    internal enum SellTrigger { Manual, OnDock, OnUndock }

    [BepInPlugin(Guid, "Station Assistant", "1.0.0")]
    public sealed class Plugin : BaseUnityPlugin
    {
        public const string Guid = "fulgan.vanguardgalaxy.stationassistant";

        internal static ManualLogSource Log;
        internal static Config Cfg;
        internal static SettingsWindow Window;

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
            host.SetToggleKey(Cfg.ToggleKey.Value.MainKey);
            host.RegisterTab(Loc.T("tab.decoy"), Window.DrawDecoyPage, 0);
            host.RegisterTab(Loc.T("tab.sell"), Window.DrawSellPage, 1);
            host.RegisterTab(Loc.T("tab.ammo"), Window.DrawAmmoPage, 2);
            host.RegisterTab(Loc.T("tab.loadouts"), Window.DrawLoadoutsPage, 3);
            host.RegisterHotkey("stationassistant.sell", "Station Assistant: sell cargo",
                () => Cfg.SellHotkey.Value.MainKey,
                k => Cfg.SellHotkey.Value = new KeyboardShortcut(k),
                () => Window.ShowLastSell(AutoSell.SellNow(Cfg)));
            host.RegisterHotkey("stationassistant.ammo", "Station Assistant: ammo valet",
                () => Cfg.AmmoHotkey.Value.MainKey,
                k => Cfg.AmmoHotkey.Value = new KeyboardShortcut(k),
                () => Window.ShowLastAmmo(AmmoValet.RunNow(Cfg)));

            Log.LogInfo("Station Assistant loaded.");
        }

        private void Update() => GameSettings.Poll(); // swap gameplay settings when the playthrough changes
    }

    internal sealed class Config
    {
        internal readonly ConfigEntry<bool> Enabled;
        internal readonly ConfigEntry<bool> AutoBuy;
        internal readonly ConfigEntry<int> DesiredStock;
        internal readonly ConfigEntry<bool> ActivateOnUndock;
        internal readonly ConfigEntry<bool> DecoyDisableDuringEcho;
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

        // Gameplay settings that swap per playthrough (UI keybinds stay global). Filled at ctor end.
        internal readonly List<ConfigEntryBase> Gameplay = new List<ConfigEntryBase>();

        // Only equipment is sellable: turrets, modules and boosters carry rarity + item level, so the
        // rarity/level keep-floors are meaningful for them. Most other categories (ore, ammo, junk, …)
        // have no item level, which would make the level floor a no-op and risk dumping wanted stock.
        private static readonly ItemCategory[] SellableCategories =
        {
            ItemCategory.Turret, ItemCategory.Module, ItemCategory.Booster
        };

        internal Config(ConfigFile file)
        {
            ToggleKey = file.Bind("UI", "ToggleKey", new KeyboardShortcut(KeyCode.F7),
                "Key to open/close the in-game settings window.");

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

            AmmoEnabled = file.Bind("AmmoValet", "Enabled", true,
                "Master switch for the ammo valet (stow unused ammo, restock ammo for equipped guns).");
            AmmoMode = file.Bind("AmmoValet", "Mode", SellTrigger.Manual,
                "Manual = run only via the button/hotkey. OnDock = also run each time you dock. " +
                "OnUndock = run just before leaving (targets the ship you undock in, handy after switching ships).");
            AmmoHotkey = file.Bind("AmmoValet", "Hotkey", new KeyboardShortcut(KeyCode.F9),
                "Key to run the ammo valet now. Always requires being docked at a station.");
            AmmoStowUnused = file.Bind("AmmoValet", "StowUnused", true,
                "Move ammo the currently equipped guns don't use from cargo to the station's material storage.");
            AmmoAutoBuy = file.Bind("AmmoValet", "AutoBuy", true,
                "Buy missing ammo from the station shop after pulling from material storage.");
            AmmoUseEchoMinutes = file.Bind("AmmoValet", "UseEchoMinutes", true,
                "Restock each equipped gun with enough ammo to fire for ECHO's configured number of minutes " +
                "(the Autopilot ammo setting), computed the same way ECHO reloads. When on, this replaces the " +
                "manual per-ammo targets below.");
            AmmoTargetsRaw = file.Bind("AmmoValet", "Targets", "",
                "Per-ship, per-ammo desired cargo counts, packed. Edit via the in-game window rather than by hand. " +
                "Format: shipGuid|ammoId|count, entries joined by ';'.");
            LoadAmmoTargets();

            // Everything except the UI keybinds is per-playthrough.
            Gameplay.AddRange(new ConfigEntryBase[]
            {
                Enabled, AutoBuy, DesiredStock, ActivateOnUndock, DecoyDisableDuringEcho,
                SellEnabled, SellMode, KeepRarity, KeepBoosterRarity, KeepItemLevel, KeepRulesRaw,
                AmmoEnabled, AmmoMode, AmmoStowUnused, AmmoAutoBuy, AmmoUseEchoMinutes, AmmoTargetsRaw,
            });
            Gameplay.AddRange(_sellCategories.Values);
        }

        // Re-derive cached collections after per-playthrough values are swapped in.
        internal void ReloadDerived()
        {
            KeepRules.Clear();
            KeepRules.AddRange(KeepRule.ParseList(KeepRulesRaw.Value));
            _ammoTargets.Clear();
            LoadAmmoTargets();
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
                    var echo = cfg.DecoyDisableDuringEcho.Value && player?.currentAutopilotSessionStats != null;
                    if (cargo != null && !player.hasUmbralTransponder && !echo)
                        DecoyLogic.ActivateDecoy(cargo);
                }

                // Sell / ammo valet can run on undock too — acts on the ship you actually leave in.
                if (cfg.SellEnabled.Value && cfg.SellMode.Value == SellTrigger.OnUndock)
                    Plugin.Window.ShowLastSell(AutoSell.SellNow(cfg));
                if (cfg.AmmoEnabled.Value && cfg.AmmoMode.Value == SellTrigger.OnUndock)
                    Plugin.Window.ShowLastAmmo(AmmoValet.RunNow(cfg));
            }
            catch (Exception ex)
            {
                Plugin.Log.LogWarning($"Undock automation skipped after an error: {ex}");
            }
        }
    }

    internal static class DecoyLogic
    {
        internal static void RestockOnDock(Config cfg)
        {
            if (!cfg.Enabled.Value || !cfg.AutoBuy.Value || cfg.DesiredStock.Value <= 0)
                return;

            var player = GamePlayer.current;
            var cargo = player?.currentSpaceShip?.cargo;
            if (cargo is null)
                return;
            if (cfg.DecoyDisableDuringEcho.Value && player.currentAutopilotSessionStats != null)
                return;

            var have = CountInCargo(cargo, IsTransponder);
            var needed = cfg.DesiredStock.Value - have;
            var umbralShop = SpaceStation.current?.umbralShopInventory;
            if (needed <= 0 || umbralShop is null)
                return;

            var bought = BuyFromShop(player, umbralShop, IsTransponder, needed);
            if (bought > 0)
                Plugin.Log.LogInfo($"Bought {bought}x decoy transponder from the Umbral shop on docking (stock now {have + bought}).");
        }

        internal static void ActivateDecoy(Inventory cargo)
        {
            var entry = cargo.items?.FirstOrDefault(i => IsTransponder(i?.item));
            if (entry is null)
                return;

            var transponder = entry.item.GetComponent<UmbralTransponderItem>();
            // OnUse returns true when a charge is consumed.
            if (transponder != null && transponder.OnUse())
            {
                cargo.Remove(entry, 1);
                Plugin.Log.LogInfo("Decoy transponder activated on undock.");
            }
        }

        private static bool IsTransponder(InventoryItemType item)
            => item != null && item.GetComponent<UmbralTransponderItem>() != null;

        internal static int BuyFromShop(GamePlayer player, ShopInventory shop, Func<InventoryItemType, bool> match, int needed)
        {
            var cargo = player.currentSpaceShip.cargo;
            var offer = shop.items?.FirstOrDefault(i => i?.item != null && match(i.item) && (i.count > 0 || i.item.HasInfiniteShopSupply()));
            if (offer is null)
                return 0;

            var available = offer.item.HasInfiniteShopSupply() ? int.MaxValue : offer.count;
            var amount = Math.Min(needed, available);

            var barter = offer.costItem != null;
            if (barter)
            {
                var per = offer.costItemCount;
                var canPay = per > 0 ? player.CountAvailableItems(offer.costItem) / per : amount;
                amount = Math.Min(amount, canPay);
            }
            else
            {
                if (offer.cost <= 0)
                    return 0;
                amount = Math.Min(amount, (int)Math.Min(int.MaxValue, player.credits / offer.cost));
            }

            amount = ShrinkToCargo(cargo, offer.item, amount);
            if (amount <= 0)
                return 0;

            if (barter)
                player.ConsumeAvailableItems(offer.costItem, offer.costItemCount * amount);
            else
                player.RemoveCredits(offer.cost * amount); // release RemoveCredits takes no spend-category

            var bought = offer.item;
            cargo.Add(bought, amount);
            if (!bought.HasInfiniteShopSupply())
                shop.Remove(offer, amount);

            foreach (var part in bought.GetComponents<InventoryItemPart>())
                part.OnPurchase(amount);

            return amount;
        }

        private static int CountInCargo(Inventory cargo, Func<InventoryItemType, bool> match)
            => cargo.items?.Where(i => i?.item != null && match(i.item)).Sum(i => i.count) ?? 0;

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
                DecoyLogic.RestockOnDock(cfg);
                if (cfg.SellEnabled.Value && cfg.SellMode.Value == SellTrigger.OnDock)
                    Plugin.Window.ShowLastSell(AutoSell.SellNow(cfg));
                if (cfg.AmmoEnabled.Value && cfg.AmmoMode.Value == SellTrigger.OnDock)
                    Plugin.Window.ShowLastAmmo(AmmoValet.RunNow(cfg));
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
        private List<string> _matchList;
        private string _desiredStockBuf;
        private string _maxLevelBuf;
        private string _lastSell = "";
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

        // Rule builder draft; index 0 = "Any".
        private int _bCat, _bType, _bRarity, _bSize, _bAspect;
        private string _bLevelBuf = "0";
        private string _openDd; // expanded dropdown id, null = none

        internal SettingsWindow(Config cfg)
        {
            _cfg = cfg;
            SyncBuffers();
        }

        internal void ShowLastSell(AutoSell.SellResult r)
            => _lastSell = r.Items > 0
                ? Loc.F("sell.result.sold", r.Items, r.Credits.ToString("N0"))
                : Loc.F("sell.result.nothing", r.Reason);

        internal void ShowLastAmmo(AmmoValet.AmmoResult r)
            => _lastAmmo = r.Reason == "ok"
                ? Loc.F("ammo.result.ok", r.Stowed, r.Pulled, r.Bought)
                : Loc.F("ammo.result.nothing", r.Reason);

        private void SyncBuffers()
        {
            _desiredStockBuf = _cfg.DesiredStock.Value.ToString();
            _maxLevelBuf = _cfg.KeepItemLevel.Value.ToString();
        }

        // Called after GameSettings swaps or copies a profile while the window may be open: refit the
        // text buffers to the new values (int fields don't self-heal; ammo/preview lists rebuild lazily).
        internal void OnProfileChanged()
        {
            SyncBuffers();
            _ammoBufs.Clear();
            _matchList = null;
        }

        // Tab bodies registered with the shared host (VG.ModApi). Each renders its content plus SA's
        // per-pilot profile footer; the host owns the window chrome, tab bar, hotkey and close button.
        internal void DrawDecoyPage() { DrawDecoyTab(); GUILayout.Space(4f); DrawProfileBar(); }
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

        private void DrawDecoyTab()
        {
            _cfg.Enabled.Value = GUILayout.Toggle(_cfg.Enabled.Value, Loc.T("decoy.enabled"));

            GUILayout.Space(6f);
            GUILayout.Label(Loc.T("decoy.flags"));
            _cfg.AutoBuy.Value = GUILayout.Toggle(_cfg.AutoBuy.Value, Loc.T("decoy.autobuy"));
            _cfg.ActivateOnUndock.Value = GUILayout.Toggle(_cfg.ActivateOnUndock.Value, Loc.T("decoy.activate"));
            _cfg.DecoyDisableDuringEcho.Value = GUILayout.Toggle(_cfg.DecoyDisableDuringEcho.Value, Loc.T("decoy.disableEcho"));

            GUILayout.Space(6f);
            GUILayout.Label(Loc.T("decoy.limits"));
            IntField(Loc.T("decoy.desiredStock"), _cfg.DesiredStock, ref _desiredStockBuf);

            GUILayout.Space(2f);
            GUILayout.Label(Loc.F("decoy.saveHint", _cfg.ToggleKey.Value));
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
            _cfg.AmmoUseEchoMinutes.Value = GUILayout.Toggle(_cfg.AmmoUseEchoMinutes.Value, Loc.F("ammo.echoMinutes", AmmoValet.EchoMinutes()));

            GUILayout.Space(6f);
            var ship = GamePlayer.current?.currentSpaceShip;
            if (ship is null)
            {
                GUILayout.Label(Loc.T("ammo.noShip"));
            }
            else
            {
                var name = !string.IsNullOrEmpty(ship.customShipName) ? ship.customShipName
                    : (ship.shipClass?.displayName ?? ship.guid); // type name when unrenamed, never the guid
                GUILayout.Label(Loc.F("ammo.ship", name));

                var ammos = AmmoValet.EquippedAmmoTypes(ship);
                if (ammos.Count == 0)
                {
                    GUILayout.Label(Loc.T("ammo.noGuns"));
                }
                else if (_cfg.AmmoUseEchoMinutes.Value)
                {
                    // ECHO-minutes mode: targets are computed, not edited. Show them read-only.
                    GUILayout.Label(Loc.F("ammo.echoTargets", AmmoValet.EchoMinutes()));
                    _ammoScroll = GUILayout.BeginScrollView(_ammoScroll, GUILayout.Height(160f));
                    foreach (var ammo in ammos)
                    {
                        var label = string.IsNullOrEmpty(ammo.displayName) ? ammo.identifier : ammo.displayName;
                        GUILayout.Label(Loc.F("ammo.echoTargetRow", label, AmmoValet.EchoTargetFor(ship, ammo)));
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
                ShowLastAmmo(AmmoValet.RunNow(_cfg));
            if (GUILayout.Button(Loc.T("ammo.autoload")))
                ShowLastAmmo(AmmoValet.Autoload(_cfg));
            GUILayout.EndHorizontal();
            GUILayout.Label(Loc.T("ammo.autoloadHint"));
            if (_lastAmmo.Length > 0)
                GUILayout.Label("<size=11>" + _lastAmmo + "</size>");
        }

        private void DrawAmmoRow(SpaceShipData ship, InventoryItemType ammo)
        {
            var id = ammo.identifier;
            var label = string.IsNullOrEmpty(ammo.displayName) ? id : ammo.displayName;
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
                ShowLastSell(AutoSell.SellNow(_cfg));
            if (GUILayout.Button(Loc.T("btn.listMatches")))
                _matchList = AutoSell.ListMatches(_cfg);
            GUILayout.EndHorizontal();

            if (_lastSell.Length > 0)
                GUILayout.Label("<size=11>" + _lastSell + "</size>");

            if (_matchList is not null)
            {
                GUILayout.Label(Loc.F("sell.wouldSell", _matchList.Count));
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
                _rulesMsg = Loc.F("rules.copied", _cfg.KeepRules.Count);
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
                _rulesMsg = Loc.F("rules.pasteArm", _cfg.KeepRules.Count, parsed.Count);
                return;
            }

            _cfg.KeepRules.Clear();
            _cfg.KeepRules.AddRange(parsed);
            _cfg.SaveKeepRules();
            _rulesMsg = Loc.F("rules.imported", parsed.Count);
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
            _bSize = Dropdown("size", Loc.T("field.minSize"), sizeOpts, _bSize);

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
                if (_bSize > 0) rule.MinSize = (ModuleSize)(_bSize - 1);
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
        private static readonly string[] RarityHex = { "#B0B0B0", "#5FD35F", "#5AA9E6", "#B266FF", "#F2C14E" };
        private static readonly Rarity[] RarityOrder = { Rarity.Standard, Rarity.Enhanced, Rarity.HighGrade, Rarity.Exotic, Rarity.Legendary };
        private static string ColorRarity(Rarity r) => $"<color={RarityHex[(int)r]}>{r}</color>";

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
