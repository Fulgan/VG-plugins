using System;
using System.Collections.Generic;
using System.IO;
using System.Reflection;
using Source.Util;

namespace StationAssistant
{
    // Read-only string lookup. Loads lang/<locale>.lang (key=value), else en-US.lang, else embedded Defaults.
    internal static class Loc
    {
        private const string DefaultLocale = "en-US";
        private static readonly Dictionary<string, string> Map = new Dictionary<string, string>();
        private static string _langDir;
        private static bool _defaultsLoaded;
        private static bool _localeApplied;

        internal static void Setup(string pluginDllPath)
        {
            try
            {
                var baseDir = string.IsNullOrEmpty(pluginDllPath)
                    ? Path.GetDirectoryName(Assembly.GetExecutingAssembly().Location)
                    : Path.GetDirectoryName(pluginDllPath);
                _langDir = Path.Combine(baseDir ?? ".", "lang");
            }
            catch
            {
                _langDir = "lang";
            }

            LoadDefaults();
            OverlayFile(Path.Combine(_langDir, DefaultLocale + ".lang"));
            Plugin.Log?.LogInfo($"Station Assistant: language files at {_langDir}");
        }

        internal static string T(string key)
        {
            EnsureInit();
            return Map.TryGetValue(key, out var v) ? v : key;
        }

        internal static string F(string key, params object[] args)
        {
            try { return string.Format(T(key), args); }
            catch { return T(key); }
        }

        private static void LoadDefaults()
        {
            if (_defaultsLoaded)
                return;
            foreach (var kv in Defaults)
                Map[kv.Key] = kv.Value;
            _defaultsLoaded = true;
        }

        private static void OverlayFile(string path)
        {
            try
            {
                if (path is null || !File.Exists(path))
                    return;
                foreach (var raw in File.ReadAllLines(path))
                {
                    var line = raw.TrimStart();
                    if (line.Length == 0 || line[0] == '#')
                        continue;
                    var eq = line.IndexOf('=');
                    if (eq > 0)
                        Map[line.Substring(0, eq).Trim()] = line.Substring(eq + 1);
                }
            }
            catch (Exception ex)
            {
                Plugin.Log?.LogWarning($"Could not read {path}: {ex.Message}");
            }
        }

        // Applies the locale overlay once the game locale is available (retries until it resolves).
        private static void EnsureInit()
        {
            if (_localeApplied || _langDir is null)
                return;

            string locale;
            try { locale = Translation.CurrentLocale; }
            catch { return; }
            if (string.IsNullOrEmpty(locale))
                return;

            _localeApplied = true;
            foreach (var candidate in Candidates(locale))
            {
                if (candidate == DefaultLocale)
                    continue;
                var path = Path.Combine(_langDir, candidate + ".lang");
                if (File.Exists(path))
                {
                    OverlayFile(path);
                    Plugin.Log?.LogInfo($"Station Assistant: loaded language '{candidate}' (game locale '{locale}').");
                    return;
                }
            }
            if (!string.Equals(locale, DefaultLocale, StringComparison.OrdinalIgnoreCase))
                Plugin.Log?.LogInfo($"Station Assistant: no language file for '{locale}', using English.");
        }

        private static IEnumerable<string> Candidates(string locale)
        {
            yield return locale;
            var dash = locale.IndexOf('-');
            if (dash > 0)
                yield return locale.Substring(0, dash);
        }

        // Key -> English text. Placeholders: {0} etc. Rich-text tags are part of the value.
        private static readonly Dictionary<string, string> Defaults = new Dictionary<string, string>
        {
            ["window.title"] = "Station Assistant",
            ["tab.quartermaster"] = "Quartermaster",
            ["tab.sell"] = "Auto-sell",
            ["btn.close"] = "Close",
            ["profile.active"] = "Pilot profile: {0}",
            ["profile.copyFrom"] = "Copy from pilot",
            ["profile.pick"] = "Select…",
            ["profile.copied"] = "Copied settings from {0}.",
            ["tab.loadouts"] = "Loadouts",
            ["loadout.noShip"] = "No active ship.",
            ["loadout.hangarOnly"] = "Only available in the Personal Hangar.",
            ["loadout.ship"] = "Ship: {0}",
            ["loadout.save"] = "Save current loadout",
            ["loadout.none"] = "No saved loadouts for this ship yet.",
            ["loadout.entry"] = "{0}  <size=11>({1} items)</size>",
            ["loadout.delete"] = "Delete",
            ["loadout.apply"] = "Apply",
            ["loadout.confirm"] = "Confirm apply",
            ["loadout.cancel"] = "Cancel",
            ["loadout.applyHint"] = "Apply fills the saved slots from your armory/cargo (best match) and leaves other slots untouched.",
            ["loadout.notDocked"] = "Dock at a station first.",
            ["loadout.echo"] = "Not while ECHO is flying the ship.",
            ["loadout.applied"] = "Applied {0}.",
            ["loadout.saved"] = "Saved '{0}'.",
            ["loadout.matches"] = "current equipment matches this loadout",
            ["loadout.differs"] = "current equipment differs from this loadout",
            ["loadout.pv.keep"] = "{0} {1}: keep {2}",
            ["loadout.pv.equip"] = "{0} {1}: equip {2} (from {3})",
            ["loadout.pv.none"] = "{0} {1}: no owned match for {2}",
            ["loadout.pv.nochange"] = "Already matches — nothing to change.",
            ["btn.sellNow"] = "Sell now  [{0}]",
            ["btn.listMatches"] = "List matches",
            ["btn.hideList"] = "Hide list",
            ["btn.addRule"] = "Add rule",
            ["mode.manual"] = "Manual",
            ["mode.onDock"] = "On dock",
            ["mode.onUndock"] = "On undock",

            ["decoy.on"] = "Auto-decoy on.",
            ["decoy.off"] = "Auto-decoy off.",
            ["decoy.on.deployed"] = "Auto-decoy on — decoy away.",
            ["decoy.on.active"] = "Auto-decoy on — one is already running.",
            ["decoy.on.nostock"] = "Auto-decoy on — but there is no decoy in the hold to deploy.",

            ["qm.enabled"] = " Automation enabled",
            ["qm.flags"] = "<b>Flags</b>",
            ["qm.autobuy"] = " Auto-buy the shortfall from station shops",
            ["qm.echoSkip"] = " skip while ECHO drives",
            ["qm.autoActivate"] = " activate one on undock",
            ["qm.noShip"] = "<size=11>(no active ship)</size>",
            ["qm.ship"] = "Ship: <b>{0}</b>",
            ["qm.header"] = "<b>Stock targets</b> <size=10>— cargo (on ship) + armory (reserve); 0 = leave that container alone. On dock: extra cargo → armory, shortfall bought into armory (all-or-nothing), then cargo filled from armory</size>",
            ["qm.row"] = "<b>{0}</b>  <size=10>(cargo {1} · armory {2})</size>",
            ["qm.inv"] = "inv",
            ["qm.res"] = "res",
            ["qm.item.decoy"] = "Decoy Transponder",
            ["qm.item.ionfuel"] = "Ion Fuel Cell",
            ["qm.item.plasmafuel"] = "Plasma Fuel Cell",
            ["qm.item.locator"] = "Locator Beacon",
            ["qm.item.trackingbot"] = "Tracking Tag Bot",
            ["qm.runNow"] = "Restock now",
            ["qm.copyAll"] = "Copy targets to all ships",
            ["qm.copyAll.confirm"] = "Overwrite every other ship?",
            ["qm.copyAll.cancel"] = "Cancel",
            ["qm.copyAll.done"] = "<color=#60c060>Copied to {0}.</color>",
            ["qm.copyAll.none"] = "<color=#e0a030>No other ships to copy to.</color>",
            ["qm.saveHint"] = "<size=10>Changes save immediately. Auto-restock runs per the mode above (default: on undock). Toggle: {0}</size>",
            // Notifications read as a crew member reporting back, not as a subsystem logging. Same numbers,
            // same order — only the voice changes.
            // {0} is a composed clause list ("stowed 2 items, pulled 1 item and bought 12 items") — see
            // Util.Moved. The verbs are the `act.*` keys so they stay translatable.
            ["qm.result.ok"] = "Your quartermaster {0}.",
            ["act.stowed"] = "stowed {0}",
            ["act.pulled"] = "pulled {0}",
            ["act.bought"] = "bought {0}",
            ["qm.result.skipped.funds"] = "Your quartermaster couldn't afford the full order — bought nothing.",
            ["qm.result.skipped.space"] = "Your quartermaster found no room in the hold — nothing loaded.",
            ["qm.result.short"] = "Your quartermaster couldn't fully restock — {0}",
            ["qm.short.item"] = "{0} ({1})",
            ["qm.short.stock"] = "shop out of stock",
            ["qm.short.notsold"] = "not sold here",
            ["qm.short.other"] = "unavailable",
            ["qm.result.nothing"] = "Your quartermaster had nothing to do ({0}).",

            ["sell.enabled"] = " Auto-sell enabled",
            ["sell.mode"] = "Mode:",
            ["sell.keepFloorHdr"] = "<b>Keep floor</b> <size=10>— keep if quality OR level meets these; sell only if lower in both. Boosters: quality only</size>",
            ["sell.keepQuality"] = "Keep quality ≥",
            ["sell.keepBooster"] = "… Boosters ≥",
            ["sell.keepLevel"] = "Keep item level ≥ (0 = ignore)",
            ["sell.categories"] = "<b>Sell these categories</b>",
            ["sell.matches"] = "Matches in cargo: <b>{0}</b> (~{1} cr)",
            ["sell.wouldSell"] = "<size=11>Would sell {0}:</size>",
            ["sell.nothingMatches"] = "<size=11>(nothing matches)</size>",
            ["sell.result.sold"] = "Your quartermaster cleared the hold — {0} sold for {1}.",
            ["sell.result.nothing"] = "Nothing worth selling ({0}).",

            ["rules.header"] = "<b>Keep-rules (exceptions)</b> <size=10>— matching items are spared</size>",
            ["rules.none"] = "<size=11>(none)</size>",
            ["btn.copyRules"] = "Copy",
            ["btn.pasteRules"] = "Paste",
            ["btn.pasteConfirm"] = "Paste (confirm?)",
            ["rules.copied"] = "Copied {0} to the clipboard.",
            ["rules.imported"] = "Imported {0}.",
            ["rules.importBad"] = "Clipboard has no valid rules — kept current list",
            ["rules.pasteArm"] = "Replaces {0} with {1} — click Paste again to confirm.",
            ["rules.addHdr"] = "<size=11><b>Add a keep-rule</b> (blank = any)</size>",
            ["field.category"] = "Category",
            ["field.type"] = "Type",
            ["field.minRarity"] = "Min rarity",
            ["field.size"] = "Size",
            ["field.minLevel"] = "Min level",
            ["field.aspect"] = "Aspect",
            ["opt.any"] = "<Any>",
            ["aspect.allBoss"] = "<All Boss aspects>",

            ["tab.ammo"] = "Gunner",
            ["ammo.enabled"] = " Gunner enabled",
            ["ammo.stowUnused"] = " Stow ammo unused by equipped guns",
            ["ammo.autobuy"] = " Buy missing ammo from shop",
            ["ammo.echoMinutes"] = " Auto: reload for ECHO's {0} min of fire (all guns)",
            ["ammo.echoTargets"] = "<b>Auto targets</b> <size=10>— enough for ECHO's {0} min of fire, per equipped gun</size>",
            ["ammo.echoTargetRow"] = "{0}: <b>{1}</b> rounds",
            ["ammo.noShip"] = "<size=11>(no active ship)</size>",
            ["ammo.noGuns"] = "<size=11>(no equipped guns use ammo)</size>",
            ["ammo.ship"] = "Ship: <b>{0}</b>",
            ["ammo.targets"] = "<b>Keep in cargo</b> <size=10>— per equipped-gun ammo; pulled from storage, then bought</size>",
            ["ammo.row"] = "{0}  <size=10>(have {1})</size>",
            ["ammo.useCurrent"] = "Set targets from current cargo",
            ["ammo.runNow"] = "Run gunner  [{0}]",
            ["ammo.autoload"] = "Autoload",
            ["ammo.autoloadHint"] = "<size=10>Autoload: clear unused ammo, then fill ~10% of cargo evenly across your guns' ammo</size>",
            ["ammo.result.ok"] = "Your gunner {0}.",
            ["ammo.result.nothing"] = "Your gunner had nothing to do ({0}).",
        };
    }
}


