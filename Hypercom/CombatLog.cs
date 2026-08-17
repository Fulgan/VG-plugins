using System;
using System.Collections.Concurrent;
using System.Collections.Generic;
using System.IO;
using System.Text;
using System.Threading;
using System.Linq;
using Behaviour.Equipment.Module;
using Behaviour.Equipment.Turret;
using Behaviour.Unit;
using Behaviour.Weapons;
using HarmonyLib;
using Source.Combat;
using Source.Item;
using Source.Player;
using Source.Util;
using UnityEngine;

namespace Hypercom
{
    // Every damage event as it happens, so the offline model can be checked against a REAL fight
    // instead of against another derivation of the same source.
    //
    // A LOG, not a read: a fight is transient. The enemy does not exist before it, its layers are gone
    // by the end, and the interesting quantities — when each shot landed, what each layer absorbed, how
    // long the shield lasted — are only observable while it is happening. A point-in-time GET would
    // answer none of them.
    //
    // PRODUCER/CONSUMER, because both simpler designs are wrong. `TakeDamage` runs inside the frame and
    // a boss fight produces thousands of events, so writing the file there is a visible stall (the
    // shape) — but a purely in-memory ring is bounded and loses everything on a crash, and the
    // end of a long fight is exactly the part worth having.
    //
    // So the game thread only ENQUEUES, and a background thread serializes and appends. The writer
    // never touches a Unity object: every live value is read in `Record` while the frame still owns it,
    // and what is queued is a dictionary of primitives. That is what makes it safe off the main thread.
    internal static class CombatLog
    {
        private const string FileName = "hypercom-combat.jsonl";
        // One batch per wake, so at most this much of a recording is lost if the process dies.
        private const int FlushIntervalMs = 40;
        private const int MaxBatch = 4096;

        private static readonly ConcurrentQueue<Dictionary<string, object>> Pending =
            new ConcurrentQueue<Dictionary<string, object>>();
        // Concurrent because the two ends really are on different threads: `Record` adds from the game
        // thread while `Dto(clear: true)` empties it from a socket thread. A plain HashSet here is a
        // data race that would show up as a corrupted set months later, not as a crash today.
        private static readonly ConcurrentDictionary<int, byte> Seen = new ConcurrentDictionary<int, byte>();
        private static readonly object StartGate = new object();
        private static volatile bool _running;

        internal static string Path => System.IO.Path.Combine(BepInEx.Paths.ConfigPath, FileName);

        // Started on the first event rather than at load, so a player who never turns the debug flag
        // on never gets a thread.
        private static void EnsureWriter()
        {
            if (_running) return;
            lock (StartGate)
            {
                if (_running) return;
                _running = true;
                new Thread(WriterLoop) { IsBackground = true, Name = "HypercomCombatLog" }.Start();
            }
        }

        private static void WriterLoop()
        {
            while (_running)
            {
                try
                {
                    if (Pending.IsEmpty) { Thread.Sleep(FlushIntervalMs); continue; }
                    var sb = new StringBuilder();
                    var n = 0;
                    while (n < MaxBatch && Pending.TryDequeue(out var row))
                    {
                        sb.Append(Json.Write(row)).Append('\n');
                        n++;
                    }
                    if (sb.Length > 0) File.AppendAllText(Path, sb.ToString());
                }
                catch (Exception e)
                {
                    Plugin.Log.LogWarning("combat log writer: " + e.Message);
                    Thread.Sleep(250);   // a failing disk must not spin the thread
                }
            }
        }

        // Off unless the hidden debug flag is on, exactly like the routes that read this.
        internal static bool Enabled => HttpServer.DebugEnabled;

        internal static void Record(AbstractUnit target, DamageData dd, float hullBefore, float shieldBefore, float armorBefore, float incoming, int depth)
        {
            if (!Enabled || target == null) return;
            try
            {
                EnsureWriter();
                var id = target.GetInstanceID();
                if (Seen.TryAdd(id, 0))
                {
                    var p = Profile(target);
                    p["kind"] = "profile";
                    Pending.Enqueue(p);
                }
                {
                    // The turret is what `ApplyVsLayerBonus` reads and what the shot schedule belongs
                    // to, so it is the join key back to a modelled weapon.
                    var turret = dd.sourceTurret;
                    Pending.Enqueue(new Dictionary<string, object>
                    {
                        ["kind"] = "event",
                        ["t"] = GamePlayer.current != null ? GamePlayer.current.elapsedTime : 0d,
                        ["unit"] = id,
                        ["turret"] = turret != null ? turret.name : null,
                        ["turretType"] = turret != null ? turret.typeDisplayName : null,
                        ["type"] = dd.type.ToString(),
                        // The amount BEFORE the target touched it — captured in the prefix, because by
                        // the postfix the chain has already mitigated and absorbed it.
                        ["incoming"] = incoming,
                        ["critCount"] = dd.critCount,
                        ["absorbedByShield"] = dd.absorbedByShield,
                        ["absorbedByArmor"] = dd.absorbedByArmor,
                        ["hullBefore"] = hullBefore,
                        ["hullAfter"] = target.currentHullHP,
                        ["shieldBefore"] = shieldBefore,
                        ["shieldAfter"] = target.currentShieldHP,
                        ["armorBefore"] = armorBefore,
                        ["armorAfter"] = target.currentArmorHP,
                        ["fromPlayer"] = dd.sourceUnit != null && dd.sourceUnit.IsPlayer(),
                        // What THIS call put on the hull, taken from the damage data rather than from a
                        // hull delta. A hull delta is not attributable: two projectiles from the same
                        // burst can be inside TakeDamage together, and the second one's effect is
                        // already in `currentHullHP` by the time the first one's postfix reads it.
                        ["hullDamage"] = dd.damageAmount,
                        // Re-entrancy depth. >1 means another TakeDamage was in flight on this thread
                        // when this one ran, which is exactly when a delta stops being attributable.
                        ["depth"] = depth,
                    });
                }
            }
            catch (Exception e) { Plugin.Log.LogWarning("combat log: " + e.Message); }
        }

        // Everything that decides what the defender does, captured once per unit. Read rather than
        // guessed: rank, escalation tier and the level curve each scale the layers, and a profile with
        // any of them wrong makes a model mismatch unattributable.
        private static Dictionary<string, object> Profile(AbstractUnit u)
        {
            var d = new Dictionary<string, object>
            {
                ["unit"] = u.GetInstanceID(),
                ["name"] = u.name,
                ["level"] = u.unitData?.level,
                ["unitRank"] = u.unitData?.unitRank.ToString(),
                ["rankHpMultiplier"] = u.unitData?.unitRank.GetHpMultiplier(),
                ["escalationTier"] = EscalationHelper.CurrentTier,
                ["escalationHpMultiplier"] = EscalationHelper.GetNpcHpMultiplier(),
                ["escalationDamageMultiplier"] = EscalationHelper.GetNpcDamageMultiplier(),
                ["hpBalanceMultiplier"] = u.unitData != null ? GameMath.HpBalanceMultiplier(u.unitData.level) : 1f,
                ["maxHullHP"] = u.maxHullHP,
                ["maxArmorHP"] = u.maxArmorHP,
                ["maxShieldHP"] = u.maxShieldHP,
                ["maxTotalHP"] = u.maxTotalHP,
                ["damageReduction"] = u.GetStat(EquipStat.DamageReduction),
                ["isPlayer"] = u.IsPlayer(),
            };
            try
            {
                var boosts = new List<object>();
                foreach (var src in Compat.Enumerate(Compat.Get(u.unitData, "statBoosts")))
                {
                    if (src == null) continue;
                    // Read the struct's FIELDS. `EquipStatLine` overrides `ToString(bool)` and not
                    // `ToString()`, so the default one returns the type name — a boost whose lines all
                    // read "Source.Item.EquipStatLine" is what this looked like before.
                    var lines = new List<object>();
                    foreach (var l in Compat.Enumerate(Compat.Call(src, "GetStats")))
                    {
                        if (l == null) continue;
                        lines.Add(new Dictionary<string, object>
                        {
                            ["stat"] = Compat.Get(l, "stat")?.ToString(),
                            ["amount"] = Compat.Num(l, "amount"),
                            ["multiplier"] = Compat.Num(l, "multiplier"),
                        });
                    }
                    boosts.Add(new Dictionary<string, object>
                    {
                        ["name"] = Compat.Call(src, "GetName") as string,
                        ["lines"] = lines,
                    });
                }
                d["statBoosts"] = boosts;
            }
            catch (Exception e) { d["statBoostsError"] = e.Message; }

            var resists = new Dictionary<string, object>();
            foreach (DamageType t in Enum.GetValues(typeof(DamageType)))
                resists[t.ToString()] = u.GetStat(t.GetResistStat());
            d["resists"] = resists;

            // The armor's own resist and weakness are prefab constants and are NOT stat lines, so they
            // are invisible to GetStat and have to be read off the module.
            var armor = u.GetComponentInChildren<ArmorModule>();
            if (armor != null)
            {
                d["armorResist"] = armor.resistAmount;
                d["armorWeakAmount"] = armor.weakAmount;
                d["armorWeakTypes"] = armor.weakTypes != null
                    ? armor.weakTypes.Select(x => (object)x.ToString()).ToList()
                    : new List<object>();
            }
            var shield = u.GetComponentInChildren<ShieldGeneratorModule>();
            if (shield != null)
            {
                d["shieldRechargeRate"] = shield.rechargeRate;
                d["shieldRechargeDelay"] = shield.rechargeDelay;
            }
            // The two REGEN figures are unit stats, not module fields, so they are read off the unit and
            // emitted for every profile. A unit with armor and no shield is exactly where armor regen is
            // observable, and gating these on the shield module made them absent there — an absent field
            // cannot be told apart from a measured zero, which is the one distinction a rate needs.
            d["shieldRegen"] = u.GetStat(EquipStat.ShieldRegen);
            d["armorRegen"] = u.GetStat(EquipStat.ArmorRegen);
            return d;
        }

        /// <summary>
        /// A shot LEAVING a gun, which a damage event cannot stand in for: a miss produces no damage
        /// event at all, so counting hits conflates how often a gun fires with how often it connects.
        /// With these, the three quantities separate — fired ÷ predicted is uptime, hits ÷ fired is
        /// accuracy, and fired ÷ nominal is the cadence question on its own.
        /// </summary>
        internal static void RecordFired(AbstractTurret turret)
        {
            if (!Enabled || turret == null) return;
            try
            {
                EnsureWriter();
                Pending.Enqueue(new Dictionary<string, object>
                {
                    ["kind"] = "fired",
                    ["t"] = GamePlayer.current != null ? GamePlayer.current.elapsedTime : 0d,
                    ["turret"] = turret.name,
                    ["turretType"] = turret.typeDisplayName,
                    ["damageType"] = turret.damageType.ToString(),
                    ["fromPlayer"] = turret.parent != null && turret.parent.IsPlayer(),
                });
            }
            catch (Exception e) { Plugin.Log.LogWarning("combat log fired: " + e.Message); }
        }

        /// <summary>
        /// `GET /combat/log` — what the writer has flushed so far.
        ///
        /// Rows are handed back as the JSON TEXT they were written as, one string per line: this class
        /// wrote them and the caller parses them, so re-parsing here would only add a second place to
        /// be wrong. Runs OFF the game thread — it is a file read that touches nothing Unity owns, so
        /// making the frame wait for it would be pure cost.
        /// </summary>
        internal static Api.Result Dto(bool clear)
        {
            try
            {
                var lines = new List<object>();
                var pendingAtRead = Pending.Count;
                if (File.Exists(Path))
                    foreach (var line in File.ReadAllLines(Path))
                        if (!string.IsNullOrWhiteSpace(line)) lines.Add(line);
                if (clear)
                {
                    try { File.Delete(Path); } catch { }
                    Seen.Clear();   // ConcurrentDictionary.Clear is safe against a concurrent TryAdd
                }
                return Api.Result.Ok(new Dictionary<string, object>
                {
                    ["gameVersion"] = Application.version,
                    ["path"] = Path,
                    ["rows"] = lines,
                    // Anything still queued has NOT reached the file. Said out loud, so a read taken
                    // seconds after a fight knows whether to ask again rather than treating a partial
                    // recording as the whole one.
                    ["pending"] = pendingAtRead,
                });
            }
            catch (Exception e) { return Api.Result.Err(500, e.Message); }
        }
    }

    // Wraps the whole chain: the prefix reads what the target had before it was touched, the postfix
    // reads what is left. `DamageData` carries the per-layer split itself, so the two ends are enough
    // to reconstruct every step without hooking each one.
    [HarmonyPatch(typeof(AbstractUnit), nameof(AbstractUnit.TakeDamage))]
    internal static class TakeDamageLogPatch
    {
        [ThreadStatic] private static int _depth;

        [HarmonyPrefix]
        private static void Prefix(AbstractUnit __instance, DamageData damageData,
                                   out (float Hull, float Shield, float Armor, float In, int Depth) __state)
        {
            __state = (0f, 0f, 0f, 0f, 0);
            try
            {
                if (!CombatLog.Enabled || __instance == null || damageData == null) return;
                _depth++;
                __state = (__instance.currentHullHP, __instance.currentShieldHP, __instance.currentArmorHP,
                           damageData.damageAmount, _depth);
            }
            catch { /* never let a diagnostic throw into game code */ }
        }

        [HarmonyPostfix]
        private static void Postfix(AbstractUnit __instance, DamageData damageData,
                                    (float Hull, float Shield, float Armor, float In, int Depth) __state)
        {
            try
            {
                if (!CombatLog.Enabled || __instance == null || damageData == null) return;
                if (_depth > 0) _depth--;
                CombatLog.Record(__instance, damageData, __state.Hull, __state.Shield, __state.Armor,
                                 __state.In, __state.Depth);
            }
            catch { /* never let a diagnostic throw into game code */ }
        }
    }

    // `RecordShotFired` is private and runs only when `FireInternal` returned true, so it is the one
    // place that means "a shot actually left this gun" rather than "the gun tried".
    [HarmonyPatch(typeof(AbstractTurret), "RecordShotFired")]
    internal static class ShotFiredLogPatch
    {
        [HarmonyPostfix]
        private static void Postfix(AbstractTurret __instance)
        {
            try { CombatLog.RecordFired(__instance); }
            catch { /* never let a diagnostic throw into game code */ }
        }
    }
}
