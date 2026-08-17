using System;
using System.Collections.Generic;
using Behaviour.Equipment.Turret;
using Behaviour.Equipment.Turret.CombatTurrets;
using Behaviour.Unit;
using Source.Combat;
using Source.Item;
using UnityEngine;

namespace Hypercom
{
    // What the game itself says a fitted turret does, per turret — the oracle a damage model is checked
    // against, and the inputs alpha needs.
    //
    // It is a LIVE-SHIP read and cannot be a catalog dump: `GetExpectedDps` → `GetAttackPower` →
    // `CalculateAttackPower` dereferences `base.parent` unguarded, so it throws on a template prefab where
    // `parent` is null. The game guards this itself elsewhere (`empPerSecond` tests `base.parent != null`
    // before calling `GetAttackPower`).
    //
    // The stats are read off the TURRET, not the ship. `AbstractEquipment.GetStat` is the parent's value
    // plus that weapon's own boost aspects, and the difference between the two is exactly what a pooled
    // reading loses — a `"weapon"`-scoped aspect line lands here and nowhere else.
    internal static class TurretAttack
    {
        /// <summary>
        /// One row per fitted combat turret. Shared with the arena probe's offense half so there is one
        /// definition of "what the game says this gun does" rather than a second copy that drifts.
        /// </summary>
        internal static List<object> Rows(AbstractUnit ship)
        {
            var rows = new List<object>();
            if (ship == null) return rows;
            foreach (var t in ship.GetComponentsInChildren<AbstractCombatTurret>())
            {
                var type = t.damageType;
                // The boost term `CalculateDamage` applies is `1 + GetStat(typed) + GetStat(Damage)`, both
                // off the turret, so both halves are served rather than their sum: a client that needs one
                // cannot recover it from the total.
                var boostStat = type.GetDamageBoostStat();
                var power = t.GetAttackPower();
                var rate = t.defaultAttacksPerSecond;
                // `SpaceShipHardpoint.index` is the slot the game itself stamped when it loaded the
                // hardpoint, so it is the same index `/loadout` addresses a slot by.
                var hardpoint = t.GetComponentInParent<SpaceShipHardpoint>();
                rows.Add(new Dictionary<string, object>
                {
                    ["slot"] = hardpoint != null ? (object)hardpoint.index : null,
                    ["type"] = t.typeDisplayName,
                    ["damageType"] = type.ToString(),
                    // What `DamageData.power` is set from: this turret's own contribution plus its pooled
                    // share. A client can otherwise only recover it by subtraction.
                    ["attackPower"] = power,
                    // The game's own expected DPS. It models ONE crit linearly and carries no timing term,
                    // so it is an oracle for the roll and the boost and NOT for the mega-crit stack.
                    ["expectedDps"] = t.GetExpectedDps(),
                    ["defaultAttacksPerSecond"] = rate,
                    // The only quantity the shot schedule still decides: the rate cancels out of sustained
                    // DPS, but this is what the incoming cap clips and what crosses a layer in one step.
                    ["alphaPerShot"] = rate > 0f ? (object)(power / 5f / rate) : null,
                    ["stats"] = new Dictionary<string, object>
                    {
                        ["criticalChance"] = t.GetStat(EquipStat.CriticalChance),
                        ["criticalDamage"] = t.GetStat(EquipStat.CriticalDamage),
                        ["typedDamage"] = t.GetStat(boostStat),
                        ["damage"] = t.GetStat(EquipStat.Damage),
                        ["damageVsShield"] = t.GetStat(EquipStat.DamageVsShield),
                        ["damageVsArmor"] = t.GetStat(EquipStat.DamageVsArmor),
                        // The three that move the REAL cadence while leaving `defaultAttacksPerSecond`
                        // alone — that figure is built from the base serialized fields. Without them a
                        // client can compute the cadence the damage assumes but not the one the gun
                        // achieves, and the two are not the same number.
                        ["attackSpeed"] = t.GetStat(EquipStat.AttackSpeed),
                        ["reloadSpeed"] = t.GetStat(EquipStat.ReloadSpeed),
                        ["magazineSize"] = t.GetStat(EquipStat.MagazineSize),
                    },
                });
            }
            return rows;
        }

        /// <summary>
        /// `GET /ship/turrets/attack` — debug-gated, `gameVersion` stamped so a capture cannot be read
        /// against a build it was not taken on.
        /// </summary>
        internal static Api.Result Dto() => MainThread.Run(() =>
        {
            var ship = GameplayManager.Instance?.spaceShip;
            if (ship == null) return Api.Result.Err(409, "no player ship");
            var data = ship.unitData as Source.SpaceShip.SpaceShipData;
            var dto = new Dictionary<string, object>
            {
                ["gameVersion"] = Application.version,
                // The identity every figure belongs to, so a caller can refuse a reading paired with the
                // wrong hull.
                ["shipGuid"] = data?.guid,
                ["shipType"] = data?.shipClass?.name,
                ["turrets"] = Rows(ship),
            };
            // These figures are an ORACLE — they exist to be compared against and captured — so the
            // payload has to say whether they had finished moving when it read them.
            ShipStats.AddSettled(dto, ship);
            return Api.Result.Ok(dto);
        });
    }
}
