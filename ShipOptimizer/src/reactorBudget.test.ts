// The reactor budget: the denominator every power decision divides by.
//
// Reported twice from live play, both times because the CAPACITY half was missing from something: a card that
// called a reactor's own `Energy` "not scored", and a warning that said a plan crossed a bracket edge
// while the panel beside it showed the load falling from 45% to 32% — that one divided both loads by the
// CURRENT capacity, on a plan whose whole point was a bigger reactor.
import { describe, expect, it } from "vitest";
import { background, capacityWith, contributionOf, pairBudget, poolsFromStatus, poolsWithModules, reactorBudgetOf, setRank, statPart, worthSwitching, type ShipPools } from "./fleetDps";
import { reactorModifier } from "./reactor";
import type { Item } from "./types";

const mod = (over: Partial<Item> = {}, stats: { stat: string; amount?: number; multiplier?: number }[] = []): Item => ({
  key: 1, slot: null, identifier: null, name: "Reactor", rarity: "Standard", level: 60,
  size: "Large", type: "Reactor", slotType: "Reactor", category: "Module", sellValue: 0,
  mainStat: { name: "Energy", amount: "10,800" },
  stats: stats.map((x) => ({ amount: 0, multiplier: 1, percent: false, ...x })),
  substats: [], aspects: [], bonus: null, bonusStat: null,
  ...over,
} as unknown as Item);

describe("capacityWith", () => {
  it("moves the budget by the difference between two reactors", () => {
    const small = mod({}, [{ stat: "Energy", amount: 10_800 }]);
    const big = mod({}, [{ stat: "Energy", amount: 21_200 }]);
    expect(capacityWith(10_800, [small], [big])).toBeCloseTo(21_200, 6);
  });

  it("counts what an ASPECT adds to the budget, not only the item's own line", () => {
    // Microgenerators: "increases reactor energy by 10%" — it arrives with the item and leaves with it, so a
    // comparison that ignored it would undervalue the reactor carrying it.
    const plain = mod({}, [{ stat: "Energy", amount: 10_000 }]);
    const withAspect = mod({}, [{ stat: "Energy", amount: 10_000 }]);
    (withAspect as unknown as { aspects: unknown[] }).aspects = [
      { id: "Microgenerators", name: "Microgenerators", description: "+10% reactor energy",
        stats: [{ stat: "Energy", amount: 0, multiplier: 1.1, percent: true }] },
    ];
    expect(statPart(withAspect, "Energy").mul).toBeCloseTo(1.1, 6);
    expect(capacityWith(10_000, [plain], [withAspect])).toBeGreaterThan(10_000);
  });

  it("leaves the budget alone when neither side touches it", () => {
    const a = mod({ mainStat: { name: "Precision", amount: "100" } }, [{ stat: "Precision", amount: 100 }]);
    const b = mod({ mainStat: { name: "Precision", amount: "200" } }, [{ stat: "Precision", amount: 200 }]);
    expect(capacityWith(12_950, [a], [b])).toBe(12_950);
  });

  it("never returns a capacity of zero, which would make every load infinite", () => {
    const huge = mod({}, [{ stat: "Energy", amount: 99_999 }]);
    expect(capacityWith(10_000, [huge], [])).toBeGreaterThanOrEqual(1);
  });
});

// The reported plan: draw goes UP and the load goes DOWN, because the reactor got bigger. A bracket verdict that
// ignores the second half claims a crossing that is not there.
describe("the bracket a plan actually lands in", () => {
  it("improves when a bigger reactor outpaces a heavier draw", () => {
    const capNow = 12_950, capNext = capacityWith(capNow, [], []) + 8_250;   // the reactor swap
    const loadNow = 5_827 / capNow;          // 45%
    const loadNext = 6_863 / capNext;        // 32%
    expect(loadNow).toBeGreaterThan(0.4);
    expect(loadNext).toBeLessThan(0.4);
    // Both sit under the 50% edge ∴ the bracket is unchanged and nothing "crosses" anything.
    expect(reactorModifier(loadNext)).toBe(reactorModifier(loadNow));
    expect(reactorModifier(loadNext)).toBeGreaterThan(0);
  });

  it("does report a crossing when the draw really does push past the edge", () => {
    expect(reactorModifier(6_863 / 12_950)).toBeLessThan(reactorModifier(5_827 / 12_950));
  });
});

// The projected figures have to carry BOTH halves of a plan. A module's own pooled contribution was missing from
// every one of them — only its power draw was projected — so a scanner swap giving up 1,122 Mining Power moved
// nothing on screen while the card beside it printed the loss.
describe("a plan's projected pools", () => {
  const scanner = (precision: number, mining: number): Item => ({
    key: 2, slot: null, identifier: null, name: `Scanner ${precision}`, rarity: "Standard", level: 61,
    size: "Large", type: "Scanner", slotType: "Scanner", category: "Module", sellValue: 0,
    mainStat: { name: "Precision", amount: String(precision) },
    stats: [
      { stat: "Precision", amount: precision, multiplier: 1, percent: false },
      { stat: "Mining Power", amount: mining, multiplier: 1, percent: false },
    ],
    substats: [], aspects: [], bonus: null, bonusStat: null,
  } as unknown as Item);

  const pools = {
    poolCombatPower: 0, poolPrecision: 11_051, poolMiningPower: 80_980,
    equivalentTurrets: 4, equivalentTurretsMining: 4,
    precisionDivisor: 5_000, critDamage: 1, megaCrit: 0, critChance: 0.2, critChanceMult: 1,
  } as unknown as Parameters<typeof poolsWithModules>[0];

  it("moves the mining pool when a module swap gives up Mining Power", () => {
    const out = scanner(5_402, 1_122);
    const inn = scanner(5_335, 0);
    const next = poolsWithModules(pools, [out], [inn]);
    expect(next.poolMiningPower).toBeCloseTo(80_980 - 1_122, 3);
  });

  it("moves the precision pool by the module's own headline", () => {
    const next = poolsWithModules(pools, [scanner(5_402, 0)], [scanner(5_335, 0)]);
    expect(next.poolPrecision).toBeCloseTo(11_051 - 67, 0);
  });

  it("leaves the pools alone when the plan changes no module", () => {
    const same = scanner(5_402, 1_122);
    expect(poolsWithModules(pools, [same], [same]).poolMiningPower).toBe(80_980);
  });
});

// ONE SOURCE FOR THE BUDGET. Measured on the live ship: `/status` reported 5,829 over 11,858 (49% load, +20%)
// while the pools object the scorer held reported 10,857 over 21,229 (51%, +10%) — a cached reading paired with a
// live payload. Every figure the player could check was ~10% off the one that decided the suggestion, and because
// the ship sat ON the 50% edge the two drifted independently, flipping the bracket between refreshes.
describe("the budget has one owner", () => {
  const statusOf = (used: number, capacity: number, mod: number) => ({
    poolCombatPower: 100_000, poolCombatPowerMult: 1 + mod, precisionDivisor: 3_430,
    poolPrecision: 1_000, equivalentTurrets: 3, critChance: 0.2, critChanceMult: 1,
    combatReactorOutputCP: 0.05,
    energyUsed: used, energyCapacity: capacity, energyUsage: used / capacity, reactorBonus: mod,
    // The other name the bridge sends the same skill increase under. Nothing reads it, and a value that disagrees
    // must not be able to reach the panel through a second door.
    reactorCombatBonus: 0.99,
  });

  const gun = (draw: number): Item => ({
    name: "Cannon", size: "Large", damageType: "Kinetic", aspects: [], substats: [], stats: [],
    powerUsage: draw, gameplayType: "Combat", mainStat: { name: "Combat Power", amount: "1000" },
  } as unknown as Item);

  it("projects the panel's reading out of the pools the scorer holds", () => {
    const pools = poolsFromStatus(statusOf(5_829, 11_858, 0.2))!;
    const b = reactorBudgetOf(pools)!;
    expect(b.used).toBe(5_829);
    expect(b.capacity).toBe(11_858);
    expect(b.usage).toBeCloseTo(5_829 / 11_858, 9);
    expect(b.mod).toBe(0.2);
    // Read through the pools, so it is the value the objective's own reactor factor uses — not the duplicate field.
    expect(b.combatBonus).toBe(0.05);
  });

  it("keeps printing the load the reading was TAKEN at after the battery is drained out of it", () => {
    // `background()` removes the equipped guns' draw so a candidate set's can be added back, which makes `used`
    // the wrong load to print for the same reason it is the wrong one to de-bracket with.
    const pools = poolsFromStatus(statusOf(5_829, 11_858, 0.2))!;
    const drained = background(pools, [gun(800), gun(800)]);
    expect(drained.energy!.used).toBeCloseTo(5_829 - 1_600, 6);
    expect(reactorBudgetOf(drained)!.used).toBe(5_829);
    expect(reactorBudgetOf(drained)!.usage).toBeCloseTo(5_829 / 11_858, 9);
  });

  it("has nothing to project when the bridge reports no reactor", () => {
    const s = statusOf(5_829, 11_858, 0.2) as Record<string, unknown>;
    s.energyUsed = null; s.energyCapacity = null; s.energyUsage = null;
    const b = reactorBudgetOf(poolsFromStatus(s as Parameters<typeof poolsFromStatus>[0]))!;
    expect(b.capacity).toBeNull();
    expect(b.used).toBeNull();
    expect(b.usage).toBeNull();
  });

  it("falls back to the load the game printed when the capacity is unreadable", () => {
    const s = statusOf(5_829, 0, 0.2) as Record<string, unknown>;
    s.energyUsage = 0.49;
    expect(reactorBudgetOf(poolsFromStatus(s as Parameters<typeof poolsFromStatus>[0]))!.usage).toBe(0.49);
  });
});

// The freshness PAIRING, which the ship-identity guards do not cover: a cached reading for the right ship, taken
// at a load one bracket away from the one the ship is flying at now.
describe("pairing a held reading with the reported budget", () => {
  const pools = (used: number, capacity: number, mod: number): ShipPools => ({
    poolCombatPower: 100_000, poolPrecision: 1_000, equivalentTurrets: 3, precisionDivisor: 3_430,
    critDamage: 1, megaCrit: 0,
    energy: { used, capacity, mod },
  });

  it("refuses the reported pair rather than pricing a build on the wrong side of the edge", () => {
    const held = pools(10_857, 21_229, 0.1);              // 51% — one bracket below
    const res = pairBudget(held, { used: 5_829, capacity: 11_858, mod: 0.2 });   // 49%
    expect(res.pools).toBeNull();
    expect(res.note).toMatch(/51%/);
    expect(res.note).toMatch(/49%/);
    // The mechanism is worth naming with its size: a 10% multiplier on every power pool.
    expect(res.note).toMatch(/\+10%/);
  });

  it("keeps a held reading that drifted WITHIN a bracket, and says nothing about it", () => {
    // The load moves by a rounding on every refresh; refusing on that would switch the objective off for good.
    const res = pairBudget(pools(5_700, 11_858, 0.2), { used: 5_829, capacity: 11_858, mod: 0.2 });
    expect(res.pools).not.toBeNull();
    expect(res.note).toBeNull();
  });

  it("stays silent when the live payload carries no budget at all", () => {
    // `reactorModule` is read off the live unit, so a scene change takes the whole reading away. The held one is
    // then the only honest reading there is, which is the substitution rule already in force.
    const held = pools(10_857, 21_229, 0.1);
    expect(pairBudget(held, null)).toEqual({ pools: held, note: null });
  });

  it("passes a null reading through without inventing a verdict about it", () => {
    expect(pairBudget(null, { used: 5_829, capacity: 11_858, mod: 0.2 })).toEqual({ pools: null, note: null });
  });

  it("compares the load the held reading was TAKEN at, not its drained one", () => {
    // A drained `used` sits below the real load, which would put a 51% reading in the 49% bracket and pass the
    // very pair this guard exists to refuse.
    const held = background(pools(10_857, 21_229, 0.1), [{
      name: "Cannon", size: "Large", aspects: [], substats: [], stats: [], powerUsage: 900,
      gameplayType: "Combat", mainStat: { name: "Combat Power", amount: "1000" },
    } as unknown as Item]);
    expect(pairBudget(held, { used: 5_829, capacity: 11_858, mod: 0.2 }).pools).toBeNull();
  });

  it("does not refuse on a capacity of zero, which is not a bracket disagreement", () => {
    expect(pairBudget(pools(500, 0, 0), { used: 5_829, capacity: 11_858, mod: 0.2 }).note).toBeNull();
  });
});

// THE LOAD A REPORTED FIGURE WAS TAKEN AT IS ONE RATIO, AND A PROJECTION MUST PIN BOTH ITS HALVES TOGETHER.
//
// Measured on the live Assayer (2026-08-06), two builds differing by one Scanner and one Engine. The Scanner that
// carries Microgenerators buys +10% reactor CAPACITY; the other carries +1,122 Mining Power:
//
//   MICRO build:  poolMiningPower 160,773.45  mult 5.52390575  capacity 13,043.71  used 6,049.47  (46.4%)
//   PREC  build:  poolMiningPower 163,699.42  mult 5.415594    capacity 11,857.91  used 5,829.27  (49.2%)
//
// Both sit inside the top bracket ∴ the +20% is the same on either build and the capacity buys NOTHING. But the
// projection moved `capacity` while leaving `usedAll` to be filled in from the already-moved `used`, so the
// de-bracket factor was taken at 6,049.47 / 11,857.91 = 51.0% — the new reactor's draw over the OLD reactor's
// capacity, a load the ship has never been at. One bracket down on the baseline, handed straight back by the
// re-bracket: +9.09% of pure fiction, in the direction that GAINS capacity and only that direction. The tab
// therefore proposed each build from the other forever.
describe("a projection that moves the reactor capacity", () => {
  const PREC: ShipPools = {
    poolCombatPower: 3_415.15356, poolCombatPowerMult: 1.5599997,
    poolMiningPower: 163_699.422, poolMiningPowerMult: 5.415594,
    poolPrecision: 10_983.9951, poolPrecisionMult: 1,
    equivalentTurrets: 0, equivalentTurretsMining: 5,
    precisionDivisor: 2_425, critDamage: 0, megaCrit: 0, critChance: 0.2096314, critChanceMult: 1,
    energy: { used: 5_829.26953, capacity: 11_857.9141, mod: 0.2 },
  };

  // The swap PREC → MICRO: gives up the +1,122 Mining Power, gains the ×1.1 reactor energy, draws 220.2 more.
  const noEnergy = { mainStat: { name: "Mining Power", amount: "0" }, type: "Scanner", slotType: "Scanner" };
  const precScanner = mod({ ...noEnergy, name: "Scanner-PREC", powerUsage: 0 },
    [{ stat: "Mining Power", amount: 1_122.9 }]);
  const microScanner = (() => {
    const it = mod({ ...noEnergy, name: "Scanner-MICRO", powerUsage: 220.2 }, []);
    (it as unknown as { aspects: unknown[] }).aspects = [
      { id: "Microgenerators", name: "Microgenerators", description: "+10% reactor energy",
        stats: [{ stat: "Energy", amount: 0, multiplier: 1.1, percent: true }] },
    ];
    return it;
  })();

  it("pins the load it was taken at as ONE reading, both halves together", () => {
    const next = poolsWithModules(PREC, [precScanner], [microScanner]);
    expect(next.energy!.capacity).toBeCloseTo(13_043.7, 0);       // the projection flies at the new budget
    expect(next.energy!.used).toBeCloseTo(6_049.47, 1);
    // …and the reading is still the reading: 5,829.27 over 11,857.91, the pair the game reported.
    expect(next.energy!.usedAll).toBeCloseTo(5_829.26953, 6);
    expect(next.energy!.capacityAll).toBeCloseTo(11_857.9141, 6);
    const readAt = next.energy!.usedAll! / next.energy!.capacityAll!;
    expect(readAt).toBeCloseTo(0.4916, 4);
    // The bracket the figures were reported under — NOT the 51% the mismatched pair produced.
    expect(reactorModifier(readAt)).toBe(0.2);
    expect(reactorModifier(6_049.47 / 11_857.9141)).toBe(0.1);    // the fiction this pin removes
  });

  it("keeps the pin when the projection is folded twice, as a module PLAN is", () => {
    // `poolsWithModules` folds one swap at a time, each step reading the last one's output. A pin that survives
    // only the first fold would come apart on any plan touching two slots.
    const eng = { mainStat: { name: "Thrust", amount: "0" }, type: "Engine", slotType: "Engine" };
    const engineOut = mod({ ...eng, name: "Engine-A", powerUsage: 300 }, []);
    const engineIn = mod({ ...eng, name: "Engine-B", powerUsage: 340 }, []);
    const next = poolsWithModules(PREC, [precScanner, engineOut], [microScanner, engineIn]);
    expect(next.energy!.usedAll).toBeCloseTo(5_829.26953, 6);
    expect(next.energy!.capacityAll).toBeCloseTo(11_857.9141, 6);
    expect(next.energy!.used).toBeCloseTo(6_049.47 + 40, 1);
  });

  it("does not turn a mining LOSS into a gain", () => {
    // Giving up 1,122 Mining Power inside one bracket is a loss, and the capacity gained buys nothing at 46% vs
    // 49% — both are the +20% bracket. The projection must say so.
    const gun = (mining: number, layer: string): Item => ({
      name: `cutter-${mining}`, size: "Small", aspects: [], substats: [], stats: [], powerUsage: 300,
      gameplayType: "Mining", targetLayer: layer, mainStat: { name: "Mining Power", amount: String(mining) },
    } as unknown as Item);
    const turrets = [gun(2_445, "Core"), gun(5_516, "Core"), gun(3_271, "Surface"), gun(3_475, "Surface")];
    const now = setRank(turrets, background(PREC, turrets), "balanced", "Mining");
    const projected = poolsWithModules(PREC, [precScanner], [microScanner]);
    const then = setRank(turrets, background(projected, turrets), "balanced", "Mining");
    expect(then[0]).toBe(now[0]);              // same tier, so the values are comparable
    expect(then[1]).toBeLessThan(now[1]);
  });

  it("is antisymmetric over the pair, so neither build can be proposed from the other", () => {
    const MICRO = poolsWithModules(PREC, [precScanner], [microScanner]);
    // Back again, from a reading that now describes the MICRO build — the pin is re-derived from ITS budget.
    const reported: ShipPools = { ...MICRO, energy: { used: 6_049.47, capacity: 13_043.7, mod: 0.2 } };
    const back = poolsWithModules(reported, [microScanner], [precScanner]);
    expect(back.energy!.usedAll).toBeCloseTo(6_049.47, 6);
    expect(back.energy!.capacityAll).toBeCloseTo(13_043.7, 6);
    expect(reactorModifier(back.energy!.usedAll! / back.energy!.capacityAll!)).toBe(0.2);
    // The additive half round-trips exactly, which is what makes the bracket the only thing that could have lied.
    expect(back.poolMiningPower! / (back.poolMiningPowerMult ?? 1))
      .toBeCloseTo(PREC.poolMiningPower! / PREC.poolMiningPowerMult!, 4);
  });
});

// `Power` IS THE UMBRELLA OVER THE THREE POWER POOLS, AND A MULTIPLIER ON IT SCALES ALL OF THEM.
//
// MEASURED on the live Assayer (game 0.8.1.23), the two saved builds the tab kept swapping between. They differ by
// one Engine and one Scanner, and every difference in the reported multipliers is accounted for by two aspects:
//
//   Engine Mk.XVII Lv 65 — `Operational Reserves`, its only line `Power ×1.02`
//   Scanner Mk.XVI Lv 61 — `Microgenerators`, `Energy ×1.1`
//
//   build with them   poolCombatPowerMult 1.59119976  poolMiningPowerMult 5.52390575  poolSalvagePowerMult 1.69646621
//   build without     poolCombatPowerMult 1.5599997   poolMiningPowerMult 5.415594    poolSalvagePowerMult 1.66320217
//   ratio                            1.02000004                     1.01999998                    1.02000000
//   poolPrecisionMult / critChanceMult / poolAttackSpeed:  UNCHANGED
//
// Three power pools moved by exactly the aspect's factor and nothing else moved at all. `MODULE_POOLS` maps each
// pool to ONE stat name, so a line called `Power` matched nothing, the projection carried the reported multiplier
// through unchanged, and every projected power figure read 2% above what the game reported after the apply — the
// panel promising 86,133 Mining Power where the ship then read 84,444.
describe("the Power umbrella", () => {
  const RESERVES = { id: "OperationalReserves", name: "Operational Reserves", description: "+2% power",
                     stats: [{ stat: "Power", amount: 0, multiplier: 1.02, percent: true }] };

  const engine = (reserves: boolean): Item => {
    const it = mod({ mainStat: { name: "Thrust", amount: "34864.957" }, name: "Engine Mk.XVII",
                     type: "Engine", slotType: "Engine", powerUsage: 1_282.92 },
      [{ stat: "Thrust", amount: 34_864.957 }, { stat: "Salvage Power", amount: 1_276.57654 }]);
    (it as unknown as { aspects: unknown[] }).aspects = reserves ? [RESERVES] : [];
    return it;
  };

  it("folds a x1.02 Power line into all three power pools and nothing else", () => {
    const c = contributionOf(engine(true));
    expect(c.mul.combatPower).toBeCloseTo(1.02, 9);
    expect(c.mul.miningPower).toBeCloseTo(1.02, 9);
    expect(c.mul.salvagePower).toBeCloseTo(1.02, 9);
    // The stats the measurement showed standing still.
    expect(c.mul.precision).toBe(1);
    expect(c.mul.critDamage).toBe(1);
    expect(c.mul.attackSpeed).toBe(1);
  });

  it("leaves an item carrying no umbrella line exactly as it was", () => {
    const c = contributionOf(engine(false));
    expect(c.mul.combatPower).toBe(1);
    expect(c.mul.miningPower).toBe(1);
    expect(c.mul.salvagePower).toBe(1);
  });

  it("moves the reported multiplier when the umbrella LEAVES the build", () => {
    // The real reading on the build that HAS the aspect, and the swap that gives it up.
    const withIt: ShipPools = {
      poolCombatPower: 3_483.45679, poolCombatPowerMult: 1.59119976,
      poolMiningPower: 160_773.453, poolMiningPowerMult: 5.52390575,
      poolSalvagePower: 5_726.06543, poolSalvagePowerMult: 1.69646621,
      poolPrecision: 9_327.562, poolPrecisionMult: 1,
      equivalentTurrets: 0, equivalentTurretsMining: 5,
      precisionDivisor: 2_425, critDamage: 0, megaCrit: 0, critChance: 0.184946015, critChanceMult: 1,
      energy: { used: 6_049.47, capacity: 13_043.7061, mod: 0.2 },
    };
    const next = poolsWithModules(withIt, [engine(true)], [engine(false)]);
    // Every power multiplier divided by the umbrella — the figures the game actually reported on the other build.
    expect(next.poolCombatPowerMult).toBeCloseTo(1.5599997, 5);
    expect(next.poolMiningPowerMult).toBeCloseTo(5.415594, 4);
    expect(next.poolSalvagePowerMult).toBeCloseTo(1.66320217, 5);
    // Precision is not a power pool and is not touched by the umbrella.
    expect(next.poolPrecisionMult).toBe(1);
  });

  it("round-trips, so gaining and losing the umbrella are the same swap read twice", () => {
    const base: ShipPools = {
      poolCombatPower: 3_483.45679, poolCombatPowerMult: 1.59119976,
      poolMiningPower: 160_773.453, poolMiningPowerMult: 5.52390575,
      poolPrecision: 9_327.562, poolPrecisionMult: 1,
      equivalentTurrets: 0, equivalentTurretsMining: 5,
      precisionDivisor: 2_425, critDamage: 0, megaCrit: 0, critChance: 0.184946015, critChanceMult: 1,
      energy: { used: 6_049.47, capacity: 13_043.7061, mod: 0.2 },
    };
    const off = poolsWithModules(base, [engine(true)], [engine(false)]);
    const back = poolsWithModules(off, [engine(false)], [engine(true)]);
    expect(back.poolMiningPowerMult).toBeCloseTo(base.poolMiningPowerMult!, 6);
    expect(back.poolMiningPower).toBeCloseTo(base.poolMiningPower!, 4);
    expect(back.poolCombatPowerMult).toBeCloseTo(base.poolCombatPowerMult!, 6);
  });
});

// `Power` IS PRICED ON BOTH HALVES, and the game says which pools it reaches. `GET /stat/sources?stat=<pool>`
// reports a `via` per contribution: on the Manglor "2nd law" (0.8.1.23) the Reactor's `Power 2,289.86` and a
// Missile Launcher's `Power 1,262.33` appear under CombatPower, MiningPower AND SalvagePower — MiningPower's whole
// additive sum being exactly those two — while Precision lists no `Power` source at all. A projection that dropped
// the additive half reported no mining change at all for a reactor swap.
describe("the Power umbrella is priced on both halves", () => {
  const reactorLike = (power: number, energy: number): Item => mod(
    { name: `Reactor ${power}`, powerUsage: 0, mainStat: { name: "Energy", amount: String(energy) } },
    [{ stat: "Energy", amount: energy }, { stat: "Power", amount: power }]);

  const pools = (): ShipPools => ({
    poolCombatPower: 331_405.375, poolCombatPowerMult: 3.2533958,
    poolMiningPower: 5_551.8667, poolMiningPowerMult: 1.55419171,
    poolSalvagePower: 8_815.852, poolSalvagePowerMult: 1.56077981,
    poolPrecision: 19_959.9648, poolPrecisionMult: 1,
    equivalentTurrets: 15, precisionDivisor: 3_676,
    critDamage: 0.4892, megaCrit: 3, critChance: 0.4318967, critChanceMult: 1,
    energy: { used: 12_571.4, capacity: 25_223.7, mod: 0.2 },
  });

  it("moves EVERY power pool when a `Power` line changes, additive included", () => {
    const out = reactorLike(2_289.86, 20_846), inn = reactorLike(1_000, 20_846);
    const next = poolsWithModules(pools(), [out], [inn]);
    const d = -1_289.86;   // the additive delta the umbrella carries
    const p = pools();
    expect(next.poolCombatPower! / next.poolCombatPowerMult!)
      .toBeCloseTo(p.poolCombatPower! / p.poolCombatPowerMult! + d, 3);
    expect(next.poolMiningPower! / next.poolMiningPowerMult!)
      .toBeCloseTo(p.poolMiningPower! / p.poolMiningPowerMult! + d, 3);
    expect(next.poolSalvagePower! / next.poolSalvagePowerMult!)
      .toBeCloseTo(p.poolSalvagePower! / p.poolSalvagePowerMult! + d, 3);
  });

  it("leaves PRECISION alone — the umbrella is power pools only", () => {
    const next = poolsWithModules(pools(), [reactorLike(2_289.86, 20_846)], [reactorLike(1_000, 20_846)]);
    expect(next.poolPrecision).toBe(19_959.9648);
    expect(next.poolPrecisionMult).toBe(1);
  });

  it("reports a mining change for a reactor swap on a ship whose mining pool is ONLY `Power` lines", () => {
    // The measured case: dropping the additive half made this exactly zero.
    const next = poolsWithModules(pools(), [reactorLike(2_289.86, 20_846)], [reactorLike(0, 20_846)]);
    expect(next.poolMiningPower).toBeLessThan(5_551.8667);
  });

  it("round-trips, so gaining and losing a `Power` line are one swap read twice", () => {
    const a = reactorLike(2_289.86, 20_846), b = reactorLike(1_000, 20_846);
    const there = poolsWithModules(pools(), [a], [b]);
    const back = poolsWithModules(there, [b], [a]);
    expect(back.poolCombatPower).toBeCloseTo(331_405.375, 3);
    expect(back.poolMiningPower).toBeCloseTo(5_551.8667, 3);
  });
});

// A PROJECTION THAT DOES NOT MOVE THE READ LOAD MUST NOT MOVE THE RESIDUAL.
//
// MEASURED on the Aquila "Momentum" (Combat, 0.8.1.23). The tab proposed giving up 5,176 of additive Combat Power
// — two modules whose `Power` and `Combat Power` lines both left — and reported the battery as +9.00% STRONGER for
// it, beside a Combat power row correctly reading -5.2%.
//
// `background()` derived the residual at `used / capacityAll`: the PROJECTED draw over the capacity the reading was
// taken at, 11,897.80 / 23,411.996 = 50.8%, on a build whose real load is 46.2% and whose reading was taken at
// 47.2%. Past the 50% edge that drops the bracket AND the combat skill term, so the residual came out x1.3/1.1 too
// large. It cancels in `shared * mult` (which is `reported * next / now`) but NOT in each gun's own main power,
// which `mult` scales directly — and own power dominates the shared remainder, so the whole battery read ~9%
// stronger for a bracket it never lost.
describe("the residual is derived at the load the reading was taken at", () => {
  const AQUILA: ShipPools = {
    poolCombatPower: 356_560.438, poolCombatPowerMult: 3.56627512,
    poolPrecision: 13_400.7422, poolPrecisionMult: 1,
    critChance: 0.49511528, critChanceMult: 1, critDamage: 0.406268239, megaCrit: 5,
    precisionDivisor: 3_200, equivalentTurrets: 15, combatReactorBonus: 0.1,
    energy: { used: 11_050.4092, capacity: 23_411.9961, mod: 0.2 },
  };
  const gun = (cp: number, draw: number, n: number): Item => ({
    name: `gun${n}`, size: "Large", damageType: "Kinetic", gameplayType: "Combat",
    mainStat: { name: "Combat Power", amount: String(cp) },
    powerUsage: draw, powerUsageBase: draw,
    stats: [{ stat: "Combat Power", amount: cp, multiplier: 1 }], substats: [], aspects: [],
  } as unknown as Item);
  // Six Large guns: 58,600 of main power and 7,455 of draw, as measured.
  const turrets = Array.from({ length: 6 }, (_, i) => gun(58_600 / 6, 7_455.16 / 6, i));

  // The reported swap: a Solar Powered scanner and an engine leave, taking 5,176 of Combat Power with them; the
  // replacements draw 847 more and carry a Microgenerators aspect worth x1.1 capacity.
  const out = mod({ name: "kept", type: "Scanner", slotType: "Scanner", powerUsage: 0,
                    mainStat: { name: "Combat Power", amount: "5175.6" } },
                  [{ stat: "Combat Power", amount: 5_175.6 }]);
  const inn = (() => {
    const it = mod({ name: "proposed", type: "Scanner", slotType: "Scanner", powerUsage: 847.39,
                     mainStat: { name: "Combat Power", amount: "0" } }, []);
    (it as unknown as { aspects: unknown[] }).aspects = [
      { id: "Microgenerators", name: "Microgenerators", description: "+10% reactor energy",
        stats: [{ stat: "Energy", amount: 0, multiplier: 1.1, percent: true }] }];
    return it;
  })();

  it("keeps the residual fixed when the projection leaves the read load where it was", () => {
    const proj = poolsWithModules(AQUILA, [out], [inn]);
    const bg = background(AQUILA, turrets);
    const bgN = background(proj, turrets);
    // The pair the residual is derived from is the READING's, so it cannot move: 47.2% either way.
    expect(bgN.combatMultResidual).toBeCloseTo(bg.combatMultResidual!, 9);
    expect(bgN.miningMultResidual ?? 1).toBeCloseTo(bg.miningMultResidual ?? 1, 9);
    // The mismatched pair produced 50.8% — over the edge, and x1.3/1.1 = 1.1818 too much residual.
    expect(11_897.7992 / 23_411.9961).toBeGreaterThan(0.5);
    expect(bg.combatMultResidual! * 1.1818).toBeGreaterThan(bg.combatMultResidual! * 1.05);
  });

  it("scores a plan that gives up Combat Power as a LOSS, not a 9% gain", () => {
    const proj = poolsWithModules(AQUILA, [out], [inn]);
    const cur = setRank(turrets, background(AQUILA, turrets));
    const next = setRank(turrets, background(proj, turrets));
    expect(next[0]).toBe(cur[0]);
    expect(next[1]).toBeLessThan(cur[1]);
    // And below the floor, so the tab declines it rather than offering it.
    expect(worthSwitching(next, cur)).toBe(false);
  });
});
