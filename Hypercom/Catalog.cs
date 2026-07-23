using System;
using System.Collections;
using System.Collections.Generic;
using System.Linq;
using System.Reflection;
using Behaviour.Equipment.Builder;
using Behaviour.Equipment.Turret;
using UnityEngine;

namespace Hypercom
{
    // Equipment catalog: the TEMPLATES that instances are rolled from — `EquipmentBuilder` (recipe) +
    // its `EquipmentBuilderStat` children (per-stat roll band + level/rarity scaling). This is the
    // version-stable definition, NOT rolled instances: a concrete item's stat is a roll in
    // [minValue, maxValue] scaled by level (levelScaling) and rarity (rarityScaling). Stamped with the
    // game version so two builds can be diffed. Reflection is used for the builder's private lists.
    internal static class Catalog
    {
        private static readonly FieldInfo AllBuildersF =
            typeof(EquipmentBuilder).GetField("allBuilders", BindingFlags.NonPublic | BindingFlags.Static);
        private static readonly FieldInfo MainStatsF =
            typeof(EquipmentBuilder).GetField("mainStats", BindingFlags.NonPublic | BindingFlags.Instance);
        private static readonly FieldInfo OptStatsF =
            typeof(EquipmentBuilder).GetField("optionalStats", BindingFlags.NonPublic | BindingFlags.Instance);

        internal static Dictionary<string, object> EquipmentDto()
        {
            var builders = new List<object>();
            var all = AllBuildersF?.GetValue(null) as IDictionary;
            if (all != null)
                foreach (var v in all.Values)
                    if (v is EquipmentBuilder b)
                    {
                        try { builders.Add(BuilderDto(b)); }
                        catch (Exception ex) { Plugin.Log.LogWarning($"[Hypercom] catalog builder failed: {ex.Message}"); }
                    }

            builders.Sort((a, z) => string.CompareOrdinal(
                (string)((Dictionary<string, object>)a)["identifier"],
                (string)((Dictionary<string, object>)z)["identifier"]));

            return new Dictionary<string, object>
            {
                ["gameVersion"] = Application.version,
                ["count"] = builders.Count,
                ["builders"] = builders,
            };
        }

        // Distinct turret types (by category + damage) and module slots that EXIST in the game — so the
        // gear filters can offer any type, not just owned/equipped ones. Light + non-debug.
        internal static Dictionary<string, object> TypesDto()
        {
            var turrets = new Dictionary<string, Dictionary<string, object>>();
            var damage = new SortedSet<string>(StringComparer.Ordinal);
            var modules = new SortedSet<string>(StringComparer.Ordinal);
            var all = AllBuildersF?.GetValue(null) as IDictionary;
            if (all != null)
                foreach (var v in all.Values)
                {
                    if (!(v is EquipmentBuilder b)) continue;
                    try
                    {
                        var prefab = b.prefab;
                        var t = prefab != null ? prefab.GetComponent<AbstractTurret>() : null;
                        if (t != null)
                        {
                            var type = t.typeDisplayName;
                            var dmg = t.damageType.ToString();
                            var cat = t.powerStat.ToString(); // CombatPower/MiningPower/SalvagePower
                            var category = cat.StartsWith("Combat") ? "Combat" : cat.StartsWith("Mining") ? "Mining" : cat.StartsWith("Salvage") ? "Salvage" : "Other";
                            if (!string.IsNullOrEmpty(type) && !turrets.ContainsKey(type))
                                turrets[type] = new Dictionary<string, object> { ["type"] = type, ["category"] = category, ["damageType"] = dmg };
                            if (!string.IsNullOrEmpty(dmg)) damage.Add(dmg);
                        }
                        else modules.Add(b.slot.ToString());
                    }
                    catch { }
                }
            return new Dictionary<string, object>
            {
                ["turrets"] = turrets.Values.OrderBy(d => (string)d["type"], StringComparer.Ordinal).ToList<object>(),
                ["damageTypes"] = damage.ToList(),
                ["moduleSlots"] = modules.ToList(),
            };
        }

        private static Dictionary<string, object> BuilderDto(EquipmentBuilder b)
        {
            // damage type / power stat come from the base item's turret component (if it's a turret).
            string damageType = null, powerStat = null;
            var prefab = b.prefab;
            var turret = prefab != null ? prefab.GetComponent<AbstractTurret>() : null;
            if (turret != null) { damageType = turret.damageType.ToString(); powerStat = turret.powerStat.ToString(); }

            return new Dictionary<string, object>
            {
                ["identifier"] = b.identifier ?? "?",
                ["slot"] = b.slot.ToString(),
                ["size"] = b.equipmentSize.ToString(),
                ["minLevel"] = b.minLevel,
                ["maxLevel"] = b.maxLevel,
                ["rarities"] = Rarities(b),
                ["inGeneralShop"] = Compat.Get(b, "IncludedInGeneralShop"), // beta-only
                ["damageType"] = damageType,
                ["powerStat"] = powerStat,
                ["mainStats"] = Stats(MainStatsF?.GetValue(b) as IEnumerable),
                ["optionalStats"] = Stats(OptStatsF?.GetValue(b) as IEnumerable),
            };
        }

        private static List<string> Rarities(EquipmentBuilder b)
        {
            var r = new List<string>();
            if (b.rarityStandard) r.Add("Standard");
            if (b.rarityEnhanced) r.Add("Enhanced");
            if (b.rarityHighGrade) r.Add("HighGrade");
            if (b.rarityExotic) r.Add("Exotic");
            if (b.rarityLegendary) r.Add("Legendary");
            return r;
        }

        private static List<object> Stats(IEnumerable stats)
        {
            var list = new List<object>();
            if (stats == null) return list;
            foreach (var o in stats)
            {
                if (!(o is EquipmentBuilderStat s)) continue;
                list.Add(new Dictionary<string, object>
                {
                    ["stat"] = s.stat.ToString(),
                    ["isMainStat"] = s.isMainStat,
                    ["isMultiplier"] = s.isMultiplier,
                    ["minValue"] = s.minValue,
                    ["maxValue"] = s.maxValue,
                    ["levelScaling"] = s.levelScaling,
                    ["rarityScaling"] = s.rarityScaling,
                    ["spawnWeight"] = s.spawnWeight,
                    ["minSpawnLevel"] = s.minSpawnLevel,
                });
            }
            return list;
        }
    }
}
