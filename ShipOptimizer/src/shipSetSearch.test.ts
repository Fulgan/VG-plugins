// ONE search over BOTH halves of the ship.
//
// The two single-block passes share the objective and the ascent but not the SEARCH: `optimizeModuleSet` holds
// the battery still and `optimizeTurretSet` holds the modules still, so the coupling that runs between them is
// invisible to both. The case that proves it, and the reason this entry point exists: a bigger reactor raises
// capacity, which relaxes the bracket, which makes a THIRSTIER gun affordable. Each half alone refuses its own
// step — the reactor pays for nothing while the old gun is fitted, and the gun cannot be afforded while the old
// reactor is — so the player can only reach it by pressing the two buttons in the right order, twice.
import { describe, it, expect } from "vitest";
import {
  background, moduleBetter, optimizeModuleSet, optimizeShipSet, optimizeTurretSet, poolsWithModules, setRank,
  rankGt, type ShipPools,
} from "./fleetDps";
import type { Item } from "./types";

const gun = (name: string, cp: number, draw: number, key: number, over: Partial<Item> = {}): Item => ({
  key, slot: key, name, rarity: "Exotic", level: 64, size: "Medium", type: "Railgun",
  category: "Turret", gameplayType: "Combat", damageType: "Kinetic", sellValue: 0,
  mainStat: { name: "Combat Power", amount: String(cp) },
  powerUsage: draw, powerUsageBase: draw,
  fireDelayRaw: 0.4, reloadDelayRaw: 2, magSizeRaw: 10, burstAmount: 1, burstDelay: 0,
  aspects: [], stats: [], substats: [], bonus: null, bonusStat: null, ...over,
} as unknown as Item);

const mod = (slotType: string, name: string, draw: number, key: number,
             lines: { stat: string; amount?: number; multiplier?: number }[] = []): Item => ({
  key, slot: key, name, rarity: "Standard", level: 60, size: "Large", type: slotType, slotType,
  category: "Module", gameplayType: null, sellValue: 0,
  mainStat: { name: "Armor HP", amount: "1000" },
  powerUsage: draw, powerUsageBase: draw,
  stats: lines.map((l) => ({ amount: 0, multiplier: 1, ...l })),
  aspects: [], substats: [], bonus: null, bonusStat: null,
} as unknown as Item);

// A ship inside the TOP band: 9,000 of 20,000 is 45%, so every power pool carries +20%. `Energy` on a module
// raises CAPACITY (`capacityWith`), which is the mechanism the unlock runs through.
const CAP = 20_000;
const pools = (used: number, capacity = CAP): ShipPools => ({
  poolCombatPower: 40_000, poolPrecision: 12_300, equivalentTurrets: 4,
  precisionDivisor: 5_000, critDamage: 1, megaCrit: 0, critChance: 0.2, critChanceMult: 1,
  energy: { used, capacity, mod: 0.2 },
});

describe("optimizeShipSet", () => {
  // The fitted pair draws 9,000 of 20,000 — 45%, the +20% band. The upgrade pair: a reactor that adds 16,000
  // capacity and buys nothing by itself (the band is already the top one), and a gun worth +40% more power for
  // NINE times the draw — which on the old capacity takes the load to 85% and costs the +20% on every pool.
  const smallReactor = mod("Reactor", "small-reactor", 1_000, 1);
  const bigReactor = mod("Reactor", "big-reactor", 1_000, 2, [{ stat: "Energy", amount: 16_000 }]);
  const modestGun = gun("modest", 10_000, 1_000, 3);
  const thirstyGun = gun("thirsty", 14_000, 9_000, 4);
  const fitted = [modestGun];

  const worth = (mods: (Item | null)[], turrets: Item[]) =>
    setRank(turrets, background(poolsWithModules(pools(9_000), [smallReactor], mods), fitted));

  it("the two halves each refuse the step the other unlocks", () => {
    // The reactor alone: more capacity, nothing using it — the same battery on a lighter load. It is not a LOSS,
    // but it buys nothing on its own, and the thirsty gun alone is what the bracket cannot afford.
    const gunAlone = worth([smallReactor], [thirstyGun]);
    const both = worth([bigReactor], [thirstyGun]);
    const now = worth([smallReactor], [modestGun]);
    expect(rankGt(both, now)).toBe(true);          // together they pay
    expect(rankGt(both, gunAlone)).toBe(true);     // and the capacity is what makes the gun worth its draw

    // Each single-block pass, run against the other half as FITTED — which is what the two buttons do.
    const modulesFirst = optimizeModuleSet(
      [{ key: "m:Reactor", current: smallReactor, candidates: [smallReactor, bigReactor] }],
      pools(9_000), fitted, { role: "Combat" });
    const bgNow = background(pools(9_000), fitted);
    const turretsFirst = optimizeTurretSet(
      [{ key: "t:0", current: modestGun, candidates: [modestGun, thirstyGun] }], bgNow);
    // Neither reaches the pair: the turret pass cannot see the capacity it would need.
    expect(turretsFirst.get("t:0")).toBe(modestGun);
    expect(modulesFirst.get("m:Reactor") === bigReactor && turretsFirst.get("t:0") === thirstyGun).toBe(false);
  });

  it("finds the pair in ONE pass", () => {
    const chosen = optimizeShipSet({
      turretSlots: [{ key: "t:0", current: modestGun, candidates: [modestGun, thirstyGun] }],
      moduleSlots: [{ key: "m:Reactor", current: smallReactor, candidates: [smallReactor, bigReactor] }],
      pools: pools(9_000), fittedTurrets: fitted, ctx: { role: "Combat" },
    });
    expect(chosen.get("m:Reactor")).toBe(bigReactor);
    expect(chosen.get("t:0")).toBe(thirstyGun);
  });

  it("is never worse than what is fitted", () => {
    // Every candidate is a loss, so the ascent keeps the incumbents — the one guarantee a suggest button owes.
    const worseGun = gun("worse", 4_000, 9_000, 5);
    const worseMod = mod("Reactor", "worse-reactor", 9_000, 6, [{ stat: "Combat Power", amount: -2_000 }]);
    const chosen = optimizeShipSet({
      turretSlots: [{ key: "t:0", current: modestGun, candidates: [modestGun, worseGun] }],
      moduleSlots: [{ key: "m:Reactor", current: smallReactor, candidates: [smallReactor, worseMod] }],
      pools: pools(9_000), fittedTurrets: fitted, ctx: { role: "Combat" },
    });
    expect(chosen.get("t:0")).toBe(modestGun);
    expect(chosen.get("m:Reactor")).toBe(smallReactor);
  });

  it("asks moduleBetter where the objective is silent, and leaves turret ties to the objective", () => {
    // Two hull kits the objective cannot separate — no pooled lines, same draw — so the countable tie-breaks
    // decide, and the joint search must reach the same answer `moduleBetter` gives on its own.
    const plain = { ...mod("Hull", "plain", 500, 7), aspectSlots: 0 } as Item;
    const roomy = { ...mod("Hull", "roomy", 500, 8), aspectSlots: 2 } as Item;
    expect(moduleBetter(roomy, plain, { pools: pools(9_000), turrets: fitted, role: "Combat" })).toBe(true);
    const chosen = optimizeShipSet({
      turretSlots: [{ key: "t:0", current: modestGun, candidates: [modestGun] }],
      moduleSlots: [{ key: "m:Hull", current: plain, candidates: [plain, roomy] }],
      pools: pools(9_000), fittedTurrets: fitted, ctx: { role: "Combat" },
    });
    expect(chosen.get("m:Hull")).toBe(roomy);
  });

  it("stays interactive when both halves are wide", () => {
    // The cost is the SUM over slots per pass, not the product of the candidate sets — but every module change
    // re-derives the pools, so the background is memoised on the module vector. This pins that it holds.
    const guns = Array.from({ length: 500 }, (_, i) => gun(`g${i}`, 9_000 + i * 10, 500 + (i % 30) * 100, 100 + i));
    const mods = Array.from({ length: 500 }, (_, i) =>
      mod("Reactor", `r${i}`, 500 + (i % 20) * 100, 1_000 + i, [{ stat: "Energy", amount: (i % 25) * 400 }]));
    const started = performance.now();
    const chosen = optimizeShipSet({
      turretSlots: [
        { key: "t:0", current: modestGun, candidates: [modestGun, ...guns] },
        { key: "t:1", current: modestGun, candidates: [modestGun, ...guns] },
      ],
      moduleSlots: [
        { key: "m:Reactor", current: smallReactor, candidates: [smallReactor, ...mods] },
        { key: "m:Hull", current: null, candidates: mods.map((m) => ({ ...m, type: "Hull", slotType: "Hull" } as Item)) },
      ],
      pools: pools(9_000), fittedTurrets: fitted, ctx: { role: "Combat" },
    });
    const took = performance.now() - started;
    expect(chosen.get("t:0")).toBeDefined();
    expect(took).toBeLessThan(10_000);
    console.log(`joint search over 2 hardpoints + 2 module slots × ~500 candidates each: ${Math.round(took)}ms`);
  });
});
