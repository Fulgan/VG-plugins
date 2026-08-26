// WHICH COMBAT BONUS IS WORTH MORE, MEASURED THROUGH THE REAL MODEL.
//
// "Crits, attack speed, or pure combat power?" has no single answer: each stat enters the damage product at a
// different place, and where it enters decides whether the answer depends on the guns. So this drives `setDps` —
// the same function the gear tab optimises with — over a battery, moves ONE reported stat at a time, and prints what
// the move bought. Archetype batteries are built from the player's OWN turrets, so the comparison is between real
// cadences rather than invented ones.
//
// It PRINTS a table and asserts only SHAPES. The ordering is a property of the ship and its battery: pinning today's
// ordering would turn a measurement into a rule, while the shapes (attack speed diminishing, combat power linear,
// crit chance holding its value to certainty) are what any recommendation actually rests on.
//
// The snapshot lives in `live/`, which is gitignored — a real save never enters the repo — so every case skips when
// it is absent rather than failing.
import { describe, it, expect } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { setDps, background, poolsFromStatus, type ShipPools } from "./fleetDps";
import type { Item } from "./types";

const STATUS = "live/status.json";
const LAYOUT = "live/layout.json";
const INVENTORIES = "live/inventories.json";

type Status = Record<string, unknown>;

function snapshot(): { status: Status; pools: ShipPools; equipped: Item[]; spares: Item[] } | null {
  if (!existsSync(STATUS) || !existsSync(LAYOUT)) return null;
  const status = JSON.parse(readFileSync(STATUS, "utf8")) as Status;
  const layout = JSON.parse(readFileSync(LAYOUT, "utf8"));
  const pools = poolsFromStatus(status as never);
  if (!pools) return null;

  const combat = (it: Item | undefined): it is Item =>
    !!it && it.category === "Turret" && it.gameplayType === "Combat" && it.fireDelayRaw != null;

  const equipped: Item[] = (layout.hardpoints ?? []).map((h: { equipped?: Item }) => h.equipped).filter(combat);
  const spares: Item[] = existsSync(INVENTORIES)
    ? (JSON.parse(readFileSync(INVENTORIES, "utf8")).stores ?? [])
        .flatMap((s: { items?: Item[] }) => s.items ?? []).filter(combat)
    : [];
  return equipped.length ? { status, pools, equipped, spares } : null;
}

/**
 * DPS with one REPORTED stat moved, everything downstream re-derived.
 *
 * The nudge goes into the status the bridge read, NOT into the derived background: `background()` recovers the
 * residual multipliers and the crit additive BY DIVIDING the reported figures out, so editing its output afterwards
 * leaves those residuals describing a ship that no longer exists and the change partly cancels itself. Measured:
 * +1% of the combat-power pool read as +0.33% DPS that way against +0.99% when re-derived from the reading.
 */
function dpsWith(status: Status, turrets: Item[], edit: (s: Status) => void): number {
  const moved = { ...status };
  edit(moved);
  const pools = poolsFromStatus(moved as never);
  if (!pools) throw new Error("status no longer yields pools");
  return setDps(turrets, background(pools, turrets));
}

/** Shots per second at the raw cadence — for DESCRIBING a battery, not for scoring it. */
function shotsPerSecond(it: Item): number {
  const burst = Math.max(1, it.burstAmount ?? 1);
  const bd = it.burstDelay ?? 0;
  const mag = Math.max(1, it.magSizeRaw as number);
  const bursts = Math.ceil(mag / burst);
  const cycle = (mag - bursts) * bd + (bursts - 1) * (it.fireDelayRaw as number)
    + Math.max(it.fireDelayRaw as number, (it.reloadDelayRaw ?? 0) * 0.8);
  return cycle > 0 ? mag / cycle : 0;
}

/**
 * What one point of each stat is worth on this battery, as a DPS fraction.
 *
 * Every move is UPWARD from the live reading, and that is not a detail: `background()` subtracts the set's own rolls
 * out of the pool to find the part no candidate can move, so a request BELOW what the equipped guns already supply
 * clamps to zero and reads as "this stat does nothing".
 */
function marginals(status: Status, turrets: Item[]): Array<[string, number]> {
  const base = setDps(turrets, background(poolsFromStatus(status as never)!, turrets));
  const n = (k: string) => Number(status[k] ?? 0);
  const rel = (dps: number) => (dps / base) - 1;
  return [
    ["combat power +1% of pool", rel(dpsWith(status, turrets, (s) => { s.poolCombatPower = n("poolCombatPower") * 1.01; }))],
    ["crit chance +1 point", rel(dpsWith(status, turrets, (s) => { s.critChance = n("critChance") + 0.01; }))],
    ["crit damage +0.01", rel(dpsWith(status, turrets, (s) => { s.critDamage = n("critDamage") + 0.01; }))],
    ["attack speed +1 point", rel(dpsWith(status, turrets, (s) => { s.poolAttackSpeed = n("poolAttackSpeed") + 0.01; }))],
    ["reload speed +1 point", rel(dpsWith(status, turrets, (s) => { s.poolReloadSpeed = n("poolReloadSpeed") + 0.01; }))],
    // Precision pays ONLY through the crit curve, and the anchor hides it: `background` recovers the crit additive
    // from the reported chance, so raising Precision lowers the recovered additive by the same amount and the total
    // does not move at all. Measured with the anchor dropped, i.e. crit chance left to the curve.
    ["precision +1% of pool (no crit anchor)", (() => {
      const noAnchor: Status = { ...status, critChance: null };
      const b = setDps(turrets, background(poolsFromStatus(noAnchor as never)!, turrets));
      const up = dpsWith(noAnchor, turrets, (s) => { s.poolPrecision = n("poolPrecision") * 1.01; });
      return (up / b) - 1;
    })()],
  ];
}

/**
 * A TYPICAL ROLL of each stat, taken from the player's own gear rather than from a table.
 *
 * Per-POINT figures are not comparable across stats: one point of crit damage and one point of the combat-power pool
 * are wildly different asks. What a decision is actually made in is ROLLS — "keep this substat or that one" — so the
 * median rolled amount converts the per-point value into per-roll value. A stat with no roll in the snapshot is
 * skipped rather than guessed at.
 */
function medianRolls(): Map<string, number> {
  if (!existsSync(INVENTORIES)) return new Map();
  const amounts = new Map<string, number[]>();
  for (const store of JSON.parse(readFileSync(INVENTORIES, "utf8")).stores ?? []) {
    for (const it of (store.items ?? []) as Item[]) {
      for (const s of [...(it.substats ?? []), ...(it.stats ?? [])] as Array<{ stat?: string; amount?: number }>) {
        if (!s.stat || typeof s.amount !== "number" || !s.amount) continue;
        const list = amounts.get(s.stat) ?? [];
        list.push(Math.abs(s.amount));
        amounts.set(s.stat, list);
      }
    }
  }
  const median = new Map<string, number>();
  for (const [stat, list] of amounts) {
    list.sort((a, b) => a - b);
    median.set(stat, list[Math.floor(list.length / 2)]);
  }
  return median;
}

describe("what each combat bonus is worth", () => {
  const live = snapshot();

  it("prints the per-point table for the live battery and for archetypes of the player's own turrets", () => {
    if (!live) { console.log("no live snapshot — run tools/pull-live.ps1 first"); return; }

    // Archetypes: five of one gun, picked from what the player OWNS by cadence, which is the axis that decides
    // whether a cycle stat pays. Hardpoint sizes are ignored on purpose — this compares stat value per battery
    // SHAPE, not a fitting the hull would allow.
    const byRate = [...live.spares].sort((a, b) => shotsPerSecond(a) - shotsPerSecond(b));
    const cases: Array<[string, Item[]]> = [["live battery", live.equipped]];
    if (byRate.length >= 3) {
      const slow = byRate[0];
      const mid = byRate[Math.floor(byRate.length / 2)];
      const fast = byRate[byRate.length - 1];
      cases.push([`slow  5x ${slow.type} (${shotsPerSecond(slow).toFixed(2)} shots/s)`, Array(5).fill(slow)]);
      cases.push([`burst 5x ${mid.type} (${shotsPerSecond(mid).toFixed(2)} shots/s)`, Array(5).fill(mid)]);
      cases.push([`fast  5x ${fast.type} (${shotsPerSecond(fast).toFixed(2)} shots/s)`, Array(5).fill(fast)]);
    }

    const p = live.pools;
    console.log(`\nlive ${live.status.gameVersion} — level ${live.status.level}, pool ${(p.poolCombatPower ?? 0).toFixed(0)}, `
      + `crit ${((p.critChance ?? 0) * 100).toFixed(1)}%, critDmg +${(p.critDamage ?? 0).toFixed(3)}, `
      + `atkSpd +${((p.poolAttackSpeed ?? 0) * 100).toFixed(1)}%, reload +${((p.poolReloadSpeed ?? 0) * 100).toFixed(1)}%, `
      + `megaCrit ${p.megaCrit}`);
    for (const [label, set] of cases) {
      console.log(`\n  ${label}`);
      for (const [stat, gain] of marginals(live.status, set))
        console.log(`    ${stat.padEnd(38)} ${(gain * 100).toFixed(3)}% DPS`);
    }
  });

  it("prints what a TYPICAL ROLL of each stat is worth, which is the unit a decision is made in", () => {
    if (!live) { console.log("no live snapshot"); return; }
    const rolls = medianRolls();
    if (!rolls.size) { console.log("no inventory snapshot — per-roll values need one"); return; }

    const n = (k: string) => Number(live.status[k] ?? 0);
    const per = new Map(marginals(live.status, live.equipped));
    // Each entry: the roll's stat name in the game's own words, the per-point row it scales, and how many POINTS one
    // median roll is worth. A flat roll is converted against the pool it joins; a percentage roll is already points.
    const table: Array<[string, string, (amount: number) => number]> = [
      ["Combat Power", "combat power +1% of pool", (a) => (a / n("poolCombatPower")) * 100],
      ["Critical Damage", "crit damage +0.01", (a) => a / 0.01],
      ["Attack Speed", "attack speed +1 point", (a) => a / 0.01],
      ["Reload Speed", "reload speed +1 point", (a) => a / 0.01],
      ["Precision", "precision +1% of pool (no crit anchor)", (a) => (a / n("poolPrecision")) * 100],
    ];

    console.log("");
    console.log("  one median roll off your own gear, on the live battery:");
    for (const [stat, row, points] of table) {
      const amount = rolls.get(stat);
      const unit = per.get(row);
      if (amount == null || unit == null) { console.log(`    ${stat.padEnd(18)} no roll in the snapshot`); continue; }
      console.log(`    ${stat.padEnd(18)} roll ${amount.toFixed(4).padStart(10)}  ->  ${(points(amount) * unit * 100).toFixed(3)}% DPS`);
    }
    for (const stat of ["Critical Chance"])
      if (!rolls.has(stat)) console.log(`    ${stat.padEnd(18)} not a rolled substat in this snapshot — it comes from Precision and named sources`);
  });

  it("attack speed diminishes: each further point buys less cycle", () => {
    if (!live) return;
    const from = Number(live.status.poolAttackSpeed ?? 0);
    const point = (at: number) => {
      const a = dpsWith(live.status, live.equipped, (s) => { s.poolAttackSpeed = at; });
      const b = dpsWith(live.status, live.equipped, (s) => { s.poolAttackSpeed = at + 0.01; });
      return (b / a) - 1;
    };
    expect(point(from)).toBeGreaterThan(point(from + 0.5));
    expect(point(from + 0.5)).toBeGreaterThan(point(from + 1.5));
  });

  it("combat power is linear: a percent of the pool is a percent at any pool size", () => {
    if (!live) return;
    const pool = Number(live.status.poolCombatPower);
    const point = (mult: number) => {
      const a = dpsWith(live.status, live.equipped, (s) => { s.poolCombatPower = pool * mult; });
      const b = dpsWith(live.status, live.equipped, (s) => { s.poolCombatPower = pool * mult * 1.01; });
      return (b / a) - 1;
    };
    expect(Math.abs(point(1) - point(4))).toBeLessThan(0.01);
  });

  it("crit chance holds its value up to certainty: the mega-crit cascade keeps paying", () => {
    if (!live) return;
    // Below `0.03 + precisionCrit(P)` the recovered additive would be negative and the model falls back to the curve,
    // so the low end of such a sweep is flat BY CONSTRUCTION. Sampled above that floor.
    const point = (chance: number) => {
      const a = dpsWith(live.status, live.equipped, (s) => { s.critChance = chance; });
      const b = dpsWith(live.status, live.equipped, (s) => { s.critChance = chance + 0.01; });
      return (b / a) - 1;
    };
    const mid = point(0.6);
    const high = point(0.95);
    expect(mid).toBeGreaterThan(0.01);          // over 1% DPS per point at 60%
    expect(high).toBeGreaterThan(mid * 0.85);   // and it has not collapsed by 95%
  });
});
