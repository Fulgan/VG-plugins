import { describe, it, expect } from "vitest";
import { background, poolsWithModules, setRank, type ShipPools } from "./fleetDps";
import type { Item } from "./types";

// THE BACKGROUND A BATTERY IS SCORED AGAINST NEVER CONTAINS THAT BATTERY.
//
// `setDps` adds each turret's own main power itself, so the pools handed to `background()` must not already
// carry the guns being scored. There are TWO projections and they are not interchangeable:
//
//   all items    — what the ship's POOL ROWS would read. A display quantity.
//   modules only — what the battery is SCORED against.
//
// Passing the first where the second belongs counts every proposed gun twice, and the error is invisible:
// both numbers are plausible and the bias is always flattering. It reached the live report, which announced
// +13.52% for a plan the tab rates +9.89% — the diagnostic that exists to catch bad suggestions
// overstating them instead. Prose did not prevent it; this does.

const gun = (cp: number, name = "Gun"): Item => ({
  key: 1, slot: 1, name, rarity: "Exotic", level: 64, size: "Medium", type: "Railgun",
  category: "Turret", gameplayType: "Combat", damageType: "Kinetic", sellValue: 0,
  mainStat: { name: "Combat Power", amount: String(cp) },
  stats: [{ stat: "Combat Power", amount: cp, multiplier: 1 }],
  powerUsage: 0, powerUsageBase: 0,
  fireDelayRaw: 0.4, reloadDelayRaw: 2, magSizeRaw: 10, burstAmount: 1, burstDelay: 0,
  aspects: [], substats: [], bonus: null, bonusStat: null,
} as unknown as Item);

const POOLS: ShipPools = {
  poolCombatPower: 40_000, poolPrecision: 12_300, equivalentTurrets: 4,
  precisionDivisor: 5_000, critDamage: 1, megaCrit: 0, critChance: 0.2, critChanceMult: 1,
  energy: { used: 4_000, capacity: 20_000, mod: 0.2 },
} as unknown as ShipPools;

const fitted = [gun(10_000, "fitted-a"), gun(10_000, "fitted-b")];
const planned = [gun(13_000, "planned-a"), gun(10_000, "fitted-b")];   // one slot swapped for a bigger gun

describe("the scoring background excludes the battery (V76)", () => {
  it("is unchanged by a TURRET swap when no module moves", () => {
    // The modules-only projection over an empty module change is the identity, so the background a plan is
    // scored against is exactly the one the fitted build was scored against. Any projection that differs has
    // folded the turrets in.
    const scoring = background(poolsWithModules(POOLS, [], []), fitted);
    const plain = background(POOLS, fitted);
    expect(scoring.poolCombatPower).toBe(plain.poolCombatPower);
    expect(scoring.poolPrecision).toBe(plain.poolPrecision);
  });

  it("counts a proposed gun ONCE — the all-items projection inflates it, and by a knowable amount", () => {
    const bg = background(POOLS, fitted);
    const honest = setRank(planned, bg)[1];

    // The defect shape: fold the plan's own turrets into the pool, then score the same turrets against it.
    const doubled = setRank(planned, background(poolsWithModules(POOLS, fitted, planned), fitted))[1];

    expect(doubled).toBeGreaterThan(honest);
    // Not merely "bigger": the inflation is the swapped gun's own +3,000 arriving a second time through the
    // shared pool, so a reader who sees this fail knows which quantity leaked rather than only that one did.
    expect(doubled / honest).toBeGreaterThan(1.01);
  });

  it("leaves a swap that changes no pooled line unaffected either way", () => {
    // Guard against the test above passing for the wrong reason: with an identical-power candidate the two
    // projections agree, so the assertion above is measuring the double count and not some constant offset.
    const same = [gun(10_000, "other"), gun(10_000, "fitted-b")];
    const honest = setRank(same, background(POOLS, fitted))[1];
    const doubled = setRank(same, background(poolsWithModules(POOLS, fitted, same), fitted))[1];
    expect(doubled).toBeCloseTo(honest, 6);
  });
});
