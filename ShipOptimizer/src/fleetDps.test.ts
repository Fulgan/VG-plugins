import { describe, it, expect } from "vitest";
import { setDps, setPower, setRank, rankGt, rankSub, worthSwitching, MIN_GAIN, background, contributionOf, precisionCrit, expectedCrit, speedRatio, optimizeTurretSet, optimizeTurretSetLayered, coversLayer, coversLayers, sameScale, setPowerByLayer, poolShare, poolsForShip, poolsReconcile, type ShipPools, type Rank, rating, isCombat } from "./fleetDps";
import type { Item } from "./types";

// A ship whose hull/crew/modules alone give some power and precision.
const bg: ShipPools = {
  poolCombatPower: 10_000, poolPrecision: 1_000, equivalentTurrets: 2,
  precisionDivisor: 5_000, critDamage: 1, megaCrit: 0,
};

const gun = (over: Partial<Item> = {}): Item => ({
  key: 1, slot: 1, identifier: null, name: "Gun", rarity: "Exotic", level: 64,
  size: "Medium", type: "Railgun", category: "Turret", damageType: "Kinetic", sellValue: 0,
  mainStat: { name: "Combat Power", amount: "2,000" },
  fireDelayRaw: 0.4, reloadDelayRaw: 2, magSizeRaw: 10, burstAmount: 1, burstDelay: 0,
  aspects: [], stats: [], substats: [], bonus: null, bonusStat: null, ...over,
} as unknown as Item);

const withStats = (lines: { stat: string; amount: number }[], over: Partial<Item> = {}) =>
  gun({ stats: lines.map((l) => ({ ...l, multiplier: 1 })), ...over } as Partial<Item>);

describe("precisionCrit", () => {
  it("is linear below 5% and soft-caps above it", () => {
    // AbstractUnit.GetPrecisionCrit: 0.05 * (stat/divisor), then ^0.75 past 0.05.
    expect(precisionCrit(2_500, 5_000)).toBeCloseTo(0.025, 10);
    expect(precisionCrit(5_000, 5_000)).toBeCloseTo(0.05, 10);
    const doubled = precisionCrit(10_000, 5_000);
    expect(doubled).toBeGreaterThan(0.05);
    expect(doubled).toBeLessThan(0.1);          // diminishing, not linear
  });

  it("is worth less at higher level, because the divisor scales with it", () => {
    expect(precisionCrit(2_500, 10_000)).toBeLessThan(precisionCrit(2_500, 5_000));
  });
});

describe("expectedCrit", () => {
  it("weights the cascade by chance", () => {
    expect(expectedCrit(0, 1, 0)).toBe(1);
    expect(expectedCrit(1, 0, 0)).toBeCloseTo(2, 10);      // one guaranteed crit at x2
    expect(expectedCrit(1, 0, 1)).toBeCloseTo(3, 10);      // plus a 50% second
  });
});

describe("background", () => {
  it("subtracts the equipped turrets' own contributions, leaving hull + crew + modules", () => {
    const equipped = [withStats([{ stat: "Precision", amount: 400 }])];   // 2,000 power + 400 precision
    const b = background(bg, equipped);
    expect(b.poolCombatPower).toBe(8_000);
    expect(b.poolPrecision).toBe(600);
  });
});

describe("setDps", () => {
  it("rises when a set contributes more power", () => {
    const weak = setDps([gun(), gun()], bg);
    const strong = setDps([gun({ mainStat: { name: "Combat Power", amount: "3,000" } }), gun()], bg);
    expect(strong).toBeGreaterThan(weak);
  });

  it("credits a Precision roll to EVERY gun, not just its host", () => {
    // This is the whole point of a set-level objective: crit chance is shared, so one gun's Precision lifts
    // the other's damage too.
    const plain = setDps([gun(), gun()], bg);
    const withPrecision = setDps([withStats([{ stat: "Precision", amount: 2_000 }]), gun()], bg);
    const gain = withPrecision / plain;
    expect(gain).toBeGreaterThan(1);

    // And the gain must exceed what the same roll would be worth if it only helped its host: with two
    // identical guns, a host-only model would give at most half this.
    const hostOnly = 1 + (gain - 1) / 2;
    expect(gain).toBeGreaterThan(hostOnly);
  });

  it("can prefer a WEAKER gun that carries Precision over a stronger plain one", () => {
    // The trade a per-slot ranking cannot express. Second slot fixed; first slot is the choice.
    const other = gun();
    const strongPlain = gun({ mainStat: { name: "Combat Power", amount: "2,600" } });
    const weakPrecision = withStats([{ stat: "Precision", amount: 6_000 }],
      { mainStat: { name: "Combat Power", amount: "2,000" } });

    expect(contributionOf(strongPlain).combatPower).toBeGreaterThan(contributionOf(weakPrecision).combatPower);
    expect(setDps([weakPrecision, other], bg)).toBeGreaterThan(setDps([strongPlain, other], bg));
  });

  it("spreads a turret's speed roll across the whole battery", () => {
    // `fireDelay` is `_fireDelay / (1 + GetStat(AttackSpeed))`, and `AbstractEquipment.GetStat` reads the UNIT's
    // stat — so a roll on one gun shortens EVERY gun's cycle. The decisive case is the gun that rolled nothing:
    // it still fires faster for its neighbour's roll, which is why the boost is an argument here rather than
    // something read off the host item.
    const fast = withStats([{ stat: "Attack Speed", amount: 0.5 }]);
    expect(speedRatio(gun(), 0.5)).toBeGreaterThan(1);
    expect(speedRatio(fast)).toBe(1);      // nothing pooled in ⇒ the raw cycle, whatever the host rolled
    expect(setDps([fast, gun()], bg)).toBeGreaterThan(setDps([gun(), gun()], bg));
  });

  it("the ratio stays per gun even though the boost is shared", () => {
    // Same pooled boost, different cycles: `ceil(mag / burst)` and the flat reload term make it worth more to a
    // gun that reloads often. A single battery-wide factor would be wrong in the other direction.
    const small = withStats([], { magSizeRaw: 4, reloadDelayRaw: 3, fireDelayRaw: 1 });
    const big = withStats([], { magSizeRaw: 40, reloadDelayRaw: 3, fireDelayRaw: 1 });
    expect(speedRatio(big, 0.5)).not.toBeCloseTo(speedRatio(small, 0.5), 3);
  });

  it("is zero for an empty set", () => expect(setDps([], bg)).toBe(0));
});

describe("optimizeTurretSet", () => {
  const bg2: ShipPools = { ...bg, equivalentTurrets: 2 };

  it("fills every slot, never reusing an item (gear is not shared)", () => {
    const a = gun({ name: "A" }), b = gun({ name: "B" });
    const chosen = optimizeTurretSet([
      { key: "t:0", candidates: [a, b] },
      { key: "t:1", candidates: [a, b] },
    ], bg2);
    expect(chosen.size).toBe(2);
    expect(new Set([...chosen.values()].map((i) => i.name)).size).toBe(2);
  });

  it("picks the pooled-Precision gun over a bigger plain one when that raises TOTAL output", () => {
    const plainBig = gun({ name: "big", mainStat: { name: "Combat Power", amount: "2,600" } });
    const precisionSmall = withStats([{ stat: "Precision", amount: 6_000 }],
      { name: "precise", mainStat: { name: "Combat Power", amount: "2,000" } });
    const filler = gun({ name: "filler" });

    const chosen = optimizeTurretSet([
      { key: "t:0", candidates: [plainBig, precisionSmall] },
      { key: "t:1", candidates: [filler] },
    ], bg2);
    expect(chosen.get("t:0")?.name).toBe("precise");
  });

  it("still prefers raw power when nothing pooled is on offer", () => {
    const small = gun({ name: "small", mainStat: { name: "Combat Power", amount: "1,000" } });
    const big = gun({ name: "big", mainStat: { name: "Combat Power", amount: "3,000" } });
    const chosen = optimizeTurretSet([{ key: "t:0", candidates: [small, big] }], { ...bg, equivalentTurrets: 1 });
    expect(chosen.get("t:0")?.name).toBe("big");
  });

  it("never lowers the objective relative to the best-alone seeding", () => {
    const cands = [
      gun({ name: "p1", mainStat: { name: "Combat Power", amount: "2,100" } }),
      withStats([{ stat: "Precision", amount: 3_000 }], { name: "p2" }),
      withStats([{ stat: "Critical Damage", amount: 2 }], { name: "p3" }),
    ];
    const slots = [{ key: "t:0", candidates: cands }, { key: "t:1", candidates: cands }];
    const chosen = optimizeTurretSet(slots, bg2);
    const result = setDps([...chosen.values()], bg2);
    // Any single-pick pair must not beat what the search settled on.
    for (const a of cands) for (const b of cands) {
      if (a === b) continue;
      expect(result).toBeGreaterThanOrEqual(setDps([a, b], bg2) - 1e-6);
    }
  });
});

describe("rating", () => {
  // AbstractTurret.turretEquivalentRating — size ALONE decides a turret's share of the pool. The reported
  // equivalent-turret count is the sum of these (measured live: 3 Large + 3 Medium = 15).
  it("matches the game's per-size ratings", () => {
    expect(rating({ size: "Tiny" } as Item)).toBe(0.45);
    expect(rating({ size: "Medium" } as Item)).toBe(2);
    expect(rating({ size: "Large" } as Item)).toBe(3);
    expect(rating({ size: null } as Item)).toBe(1);
  });

  it("gives a Large hardpoint more of the pool than a Medium", () => {
    const bg = { poolCombatPower: 150, poolPrecision: 0, equivalentTurrets: 5, precisionDivisor: 3430, critDamage: 0, megaCrit: 0 };
    const t = (size: string) => ({ size, damageType: "Kinetic", aspects: [], stats: [], substats: [],
      gameplayType: "Combat", mainStat: { name: "Combat Power", amount: "0" } } as unknown as Item);
    const large = setDps([t("Large")], bg);
    const medium = setDps([t("Medium")], bg);
    expect(large / medium).toBeCloseTo(1.5); // 3/15 vs 2/15 of the pool
  });
});

describe("energy brackets in the objective", () => {
  // A turret's headline Combat Power IS its pool contribution (contributionOf reads mainStat), so the fixture
  // has to carry it there rather than as a stat line.
  const gun = (name: string, cp: number, draw: number): Item => ({
    name, size: "Large", damageType: "Kinetic", aspects: [], substats: [], stats: [], powerUsage: draw,
    mainStat: { name: "Combat Power", amount: String(cp) },
  } as unknown as Item);

  // 200 capacity, 60 drawn by non-turret gear. One Large hardpoint.
  const pools = (usedBackground: number, mod: number) => ({
    poolCombatPower: 1000 * (1 + mod), poolPrecision: 0, equivalentTurrets: 3, precisionDivisor: 3430,
    critDamage: 0, megaCrit: 0, energy: { used: usedBackground, capacity: 200, mod },
  });

  it("prefers a zero-draw gun when drawing would cross a threshold", () => {
    // At 60 drawn of 200, a 45-draw gun lands at 52.5% (+10%) while a free one stays at 30% (+20%). The
    // free gun is WEAKER on paper and still wins — which is the Solar Powered case.
    const bg = pools(60, 0.2);
    const thirsty = setDps([gun("thirsty", 400, 45)], bg);
    const solar = setDps([gun("solar", 300, 0)], bg);
    expect(solar).toBeGreaterThan(thirsty);
  });

  it("still prefers the stronger gun when neither crosses", () => {
    const bg = pools(10, 0.2);
    expect(setDps([gun("strong", 400, 20)], bg)).toBeGreaterThan(setDps([gun("weak", 300, 0)], bg));
  });

  // The objective is set-level, so several swaps at once are bracketed TOGETHER: two guns that are each
  // affordable can cross a threshold jointly, and a per-slot score could never see that.
  it("brackets a multi-swap on the whole set's draw", () => {
    const bg = { ...pools(0, 0.2), equivalentTurrets: 6 };
    const two = (d: number) => setDps([gun("a", 300, d), gun("b", 300, d)], bg);
    const under = two(49);   // 98/200 = 49% → +20%
    const over = two(51);    // 102/200 = 51% → +10%
    expect(under).toBeGreaterThan(over);
    expect(under / over).toBeCloseTo(1.2 / 1.1, 3);
  });

  it("is unchanged when the bridge reports no reactor", () => {
    const noEnergy = { poolCombatPower: 1000, poolPrecision: 0, equivalentTurrets: 3, precisionDivisor: 3430, critDamage: 0, megaCrit: 0 };
    expect(setDps([gun("a", 300, 999)], noEnergy)).toBeCloseTo(setDps([gun("a", 300, 0)], noEnergy));
  });

  it("takes the equipped turrets' draw out of the background", () => {
    const eq = gun("eq", 300, 40);
    const bg = background({ ...pools(100, 0.2) } as never, [eq]);
    expect(bg.energy?.used).toBe(60); // 100 total − 40 the turret drew
  });
});

describe("optimizeTurretSet: keeping, reuse and repeatability", () => {
  const gun = (name: string, cp: number, draw = 0): Item => ({
    name, size: "Large", damageType: "Kinetic", aspects: [], substats: [], stats: [], powerUsage: draw,
    mainStat: { name: "Combat Power", amount: String(cp) },
  } as unknown as Item);
  const bg: ShipPools = { poolCombatPower: 1000, poolPrecision: 0, equivalentTurrets: 6, precisionDivisor: 3430, critDamage: 0, megaCrit: 0 };

  it("keeps the equipped turret when nothing owned beats it", () => {
    const eq = gun("equipped", 900);
    const chosen = optimizeTurretSet([{ key: "t:0", candidates: [eq, gun("weak", 100)] }], bg);
    expect(chosen.get("t:0")).toBe(eq);
  });

  it("never puts one item in two slots", () => {
    const best = gun("best", 900);
    const next = gun("next", 800);
    const chosen = optimizeTurretSet([
      { key: "t:0", candidates: [best, next] },
      { key: "t:1", candidates: [best, next] },
    ], bg);
    expect(new Set([chosen.get("t:0"), chosen.get("t:1")]).size).toBe(2);
  });

  it("gives the same answer when run again on the same inputs", () => {
    const cands = [gun("a", 500), gun("b", 700), gun("c", 300)];
    const slots = [{ key: "t:0", candidates: cands }, { key: "t:1", candidates: cands }];
    const once = optimizeTurretSet(slots, bg);
    const twice = optimizeTurretSet(slots, bg);
    expect([...twice.entries()].map(([k, v]) => [k, v.name])).toEqual([...once.entries()].map(([k, v]) => [k, v.name]));
  });

  // `fixed` turrets are kept but not chosen — they still occupy the ship, so they must enter every score.
  // With a reactor bracket keyed on TOTAL draw, leaving them out changes which candidate wins.
  it("counts fixed turrets in the score", () => {
    const energyBg: ShipPools = { ...bg, energy: { used: 0, capacity: 100, mod: 0 } };
    const thirstyFixed = gun("fixed", 500, 45);
    const withFixed = optimizeTurretSet([{ key: "t:0", candidates: [gun("free", 300, 0), gun("draws", 400, 10)] }],
                                        energyBg, 4, [thirstyFixed]);
    // 45 already drawn: the 10-draw gun lands at 55% (+10%), the free one stays at 45% (+20%).
    expect(withFixed.get("t:0")?.name).toBe("free");
  });
});

describe("non-combat turrets", () => {
  const mk = (name: string, stat: string, cp: number, type?: string): Item => ({
    name, size: "Large", damageType: "Kinetic", aspects: [], substats: [], stats: [], gameplayType: type,
    mainStat: { name: stat, amount: String(cp) },
  } as unknown as Item);
  const bg: ShipPools = { poolCombatPower: 1000, poolPrecision: 0, equivalentTurrets: 3, precisionDivisor: 3430, critDamage: 0, megaCrit: 0 };

  it("classifies by the game's own gameplayType, falling back to the stat name", () => {
    expect(isCombat(mk("a", "Combat Power", 1, "Combat"))).toBe(true);
    expect(isCombat(mk("b", "Combat Power", 1, "Mining"))).toBe(false);  // enum wins over the stat name
    expect(isCombat(mk("c", "Mining Power", 1))).toBe(false);
    expect(isCombat(mk("d", "Combat Power", 1))).toBe(true);
  });

  it("does not count Mining Power as combat power", () => {
    expect(contributionOf(mk("miner", "Mining Power", 9183, "Mining")).combatPower).toBe(0);
    expect(contributionOf(mk("gun", "Combat Power", 9183, "Combat")).combatPower).toBe(9183);
  });

  // A mining gun in a weapon slot is not a damage upgrade, however big its headline number.
  it("never prefers a mining turret over a combat one", () => {
    const chosen = optimizeTurretSet([{ key: "t:0",
      candidates: [mk("gun", "Combat Power", 400, "Combat"), mk("miner", "Mining Power", 9999, "Mining")] }], bg);
    expect(chosen.get("t:0")?.name).toBe("gun");
  });

  it("contributes no DPS while still occupying the hardpoint", () => {
    const withMiner = setDps([mk("gun", "Combat Power", 400, "Combat"), mk("miner", "Mining Power", 9999, "Mining")], bg);
    const alone = setDps([mk("gun", "Combat Power", 400, "Combat")], bg);
    expect(withMiner).toBeCloseTo(alone);
  });
});

describe("optimizeTurretSet never regresses", () => {
  const gun = (name: string, cp: number, draw = 0): Item => ({
    name, size: "Large", damageType: "Kinetic", aspects: [], substats: [], stats: [], powerUsage: draw,
    gameplayType: "Combat", mainStat: { name: "Combat Power", amount: String(cp) },
  } as unknown as Item);

  // The failure this guards: coordinate ascent from a "best alone per slot" seed converges to a LOCAL optimum
  // that can sit below the build already fitted — measured at −3.13% on a live ship. Seeding from the current
  // build as well makes "keep everything" the floor.
  it("is never worse than the build already fitted", () => {
    const bg: ShipPools = { poolCombatPower: 1000, poolPrecision: 0, equivalentTurrets: 9, precisionDivisor: 3430,
      critDamage: 0, megaCrit: 0, energy: { used: 40, capacity: 100, mod: 0.2 } };
    const eq0 = gun("eq0", 900, 0), eq1 = gun("eq1", 800, 0), eq2 = gun("eq2", 700, 0);
    // Every loose gun is individually big but thirsty: taking any of them crosses 50% and costs the bracket.
    const loose = [gun("l1", 950, 30), gun("l2", 940, 30), gun("l3", 930, 30)];
    const equipped = [eq0, eq1, eq2];
    const slots = equipped.map((eq, i) => ({ key: `t:${i}`, current: eq, candidates: [eq, ...loose] }));
    const chosen = optimizeTurretSet(slots, bg);
    expect(setDps([...chosen.values()], bg)).toBeGreaterThanOrEqual(setDps(equipped, bg) - 1e-9);
  });

  it("still takes a genuine upgrade", () => {
    const bg: ShipPools = { poolCombatPower: 1000, poolPrecision: 0, equivalentTurrets: 3, precisionDivisor: 3430, critDamage: 0, megaCrit: 0 };
    const eq = gun("eq", 100);
    const better = gun("better", 900);
    const chosen = optimizeTurretSet([{ key: "t:0", current: eq, candidates: [eq, better] }], bg);
    expect(chosen.get("t:0")).toBe(better);
  });
});

describe("a plan must beat what is fitted (no ping-pong)", () => {
  const gun = (name: string, cp: number): Item => ({
    name, size: "Large", damageType: "Kinetic", aspects: [], substats: [], stats: [], gameplayType: "Combat",
    mainStat: { name: "Combat Power", amount: String(cp) },
  } as unknown as Item);
  const bg: ShipPools = { poolCombatPower: 1000, poolPrecision: 0, equivalentTurrets: 9, precisionDivisor: 3430, critDamage: 0, megaCrit: 0 };

  // The optimizer must be a fixed point: feed it the build it just chose and it chooses the same again.
  // Without that, applying its answer produces a new answer, which is the apply → suggest → apply loop.
  it("re-choosing its own output changes nothing", () => {
    const pool = [gun("a", 900), gun("b", 880), gun("c", 500), gun("d", 480)];
    const slots1 = [
      { key: "t:0", current: pool[2], candidates: [pool[2], ...pool] },
      { key: "t:1", current: pool[3], candidates: [pool[3], ...pool] },
    ];
    const first = optimizeTurretSet(slots1, bg);
    const slots2 = [
      { key: "t:0", current: first.get("t:0"), candidates: [first.get("t:0") as Item, ...pool] },
      { key: "t:1", current: first.get("t:1"), candidates: [first.get("t:1") as Item, ...pool] },
    ];
    const second = optimizeTurretSet(slots2, bg);
    expect([second.get("t:0"), second.get("t:1")]).toEqual([first.get("t:0"), first.get("t:1")]);
  });
});


describe("per-activity objective (mining and salvage)", () => {
  const turret = (name: string, act: "Combat" | "Mining" | "Salvage", val: number, draw = 0): Item => ({
    name, size: "Large", damageType: "Kinetic", aspects: [], substats: [], stats: [], powerUsage: draw,
    gameplayType: act, mainStat: { name: `${act === "Combat" ? "Combat" : act} Power`, amount: String(val) },
  } as unknown as Item);

  // Three Large hardpoints' worth of each pool. `equivalentTurretsMining` is asked per stat, so it counts only
  // the mining guns — 3 here, i.e. one Large.
  const bg: ShipPools = {
    poolCombatPower: 1000, poolPrecision: 0, equivalentTurrets: 3, precisionDivisor: 3430, critDamage: 0, megaCrit: 0,
    poolMiningPower: 900, poolSalvagePower: 600, equivalentTurretsMining: 3, equivalentTurretsSalvage: 3,
  };

  // The failure this pins: every mining candidate scored 0, so the whole comparison was a tie and no suggestion
  // could ever be made.
  it("scores a mining battery instead of collapsing to zero", () => {
    const strong = setRank([turret("big", "Mining", 400)], bg);
    const weak = setRank([turret("small", "Mining", 100)], bg);
    expect(strong[0]).toBe(1);
    expect(strong[1]).toBeGreaterThan(0);
    expect(rankGt(strong, weak)).toBe(true);
  });

  it("reads the salvage pool for a salvage battery", () => {
    const mining = setRank([turret("m", "Mining", 100)], bg);
    const salvage = setRank([turret("s", "Salvage", 100)], bg);
    // Same own contribution, different pool behind it — 900 vs 600.
    expect(mining[1]).toBeGreaterThan(salvage[1]);
  });

  // Combat-first ordering, enforced by the tier rather than by a magnitude comparison, which a bigger
  // non-combat number would otherwise win.
  it("ranks any combat set above any non-combat one, whatever the magnitudes", () => {
    const feeble = setRank([turret("pistol", "Combat", 1)], bg);
    const huge = setRank([turret("laser", "Mining", 999_999)], bg);
    expect(rankGt(feeble, huge)).toBe(true);
    expect(rankGt(huge, feeble)).toBe(false);
  });

  it("states no difference across tiers and a real one inside a tier", () => {
    expect(rankSub([2, 500], [1, 100])).toBe(0);
    expect(rankSub([1, 500], [2, 100])).toBe(0);
    expect(rankSub([1, 500], [1, 100])).toBe(400);
  });

  it("has no rank at all for a set with no activity", () => {
    expect(setRank([], bg)).toEqual([0, 0]);
    const inert = { name: "x", size: "Large", aspects: [], stats: [], substats: [],
      mainStat: { name: "Armor HP", amount: "10" } } as unknown as Item;
    expect(setRank([inert], bg)).toEqual([0, 0]);
  });

  // Mining Power is a `reactorAffectedStats` entry too, so the de-bracket/re-bracket dance has to apply to it —
  // a zero-draw mining laser can beat a bigger one by keeping the ship in a better bracket.
  it("re-brackets the mining pool on the set's own draw", () => {
    const withEnergy: ShipPools = { ...bg, poolMiningPower: 900 * 1.2,
      energy: { used: 60, capacity: 200, mod: 0.2 } };
    // 60 of 200 already drawn: a 45-draw gun lands at 52.5% (+10%), a free one stays at 30% (+20%).
    const thirsty = setPower([turret("thirsty", "Mining", 400, 45)], withEnergy, "Mining");
    const solar = setPower([turret("solar", "Mining", 300, 0)], withEnergy, "Mining");
    expect(solar).toBeGreaterThan(thirsty);
  });

  it("picks the better mining gun on a mining-only slot", () => {
    const chosen = optimizeTurretSet([{ key: "t:0",
      candidates: [turret("weak", "Mining", 100), turret("strong", "Mining", 400)] }], bg);
    expect(chosen.get("t:0")?.name).toBe("strong");
  });

  it("takes the equipped mining guns' power out of the background", () => {
    const eq = turret("eq", "Mining", 300);
    const stripped = background(bg, [eq]);
    expect(stripped.poolMiningPower).toBe(600);
    expect(stripped.poolCombatPower).toBe(1000); // a mining gun feeds no combat pool
  });

  // An older bridge sends no per-activity pool. The battery then has nothing to be scored against, and a 0 that
  // a candidate's own power could stand in for would be worse than no answer.
  it("degrades to no comparison when the bridge sends no such pool", () => {
    const old: ShipPools = { poolCombatPower: 1000, poolPrecision: 0, equivalentTurrets: 3,
      precisionDivisor: 3430, critDamage: 0, megaCrit: 0 };
    expect(setRank([turret("big", "Mining", 400)], old)).toEqual([1, 0]);
    expect(background(old, [turret("eq", "Mining", 300)]).poolMiningPower).toBeUndefined();
  });

  it("applies the worth-it floor as a ratio, in either unit", () => {
    expect(worthSwitching([1, 1000 * (1 + MIN_GAIN * 2)], [1, 1000])).toBe(true);
    expect(worthSwitching([1, 1000 * (1 + MIN_GAIN / 2)], [1, 1000])).toBe(false);
    // A tier RISE is a different job, not a bigger number — never noise.
    expect(worthSwitching([2, 1], [1, 999_999])).toBe(true);
    expect(worthSwitching([1, 999_999], [2, 1])).toBe(false);
  });
});

// The release cuts each gun's share again as the battery grows; beta 0.8.1.19 deleted that formula. Both
// behaviours ship in one client, chosen by `caps.extraTurretPenalty`, so both are pinned here — and the
// thresholds are pinned at their EDGES, since a ">" written as ">=" moves every boundary by one turret.
describe("poolShare — the release's extra-turret ladder", () => {
  const off: ShipPools = { ...bg, extraTurretPenalty: false };
  const on: ShipPools = { ...bg, extraTurretPenalty: true };

  it("divides by the equivalent-turret count and nothing else on the beta", () => {
    for (const nEq of [1, 2, 3, 4, 5, 6, 7]) expect(poolShare(1000, nEq, off)).toBeCloseTo(1000 / nEq, 6);
  });

  it("applies the game's ladder on the release", () => {
    expect(poolShare(1000, 1, on)).toBeCloseTo(1000, 6);              // one gun: no penalty
    expect(poolShare(1000, 2, on)).toBeCloseTo((1000 / 2) * 0.85, 6);
    expect(poolShare(1000, 3, on)).toBeCloseTo((1000 / 3) * 0.78, 6);
    expect(poolShare(1000, 4, on)).toBeCloseTo((1000 / 4) * 0.72, 6);
    expect(poolShare(1000, 5, on)).toBeCloseTo((1000 / 5) * 0.68, 6);
    expect(poolShare(1000, 6, on)).toBeCloseTo((1000 / 6) * 0.65, 6);
    expect(poolShare(1000, 9, on)).toBeCloseTo((1000 / 9) * 0.65, 6);  // the last rung is the floor
  });

  it("keeps the thresholds exclusive, as the game writes them", () => {
    expect(poolShare(1000, 1.9, on)).toBeCloseTo(1000 / 1.9, 6);            // 1.9 is NOT > 1.9
    expect(poolShare(1000, 1.91, on)).toBeCloseTo((1000 / 1.91) * 0.85, 6);
    expect(poolShare(1000, 5.9, on)).toBeCloseTo((1000 / 5.9) * 0.68, 6);   // still the 4.9 rung
    expect(poolShare(1000, 5.91, on)).toBeCloseTo((1000 / 5.91) * 0.65, 6);
  });

  it("floors the divisor at 0.45 so one small gun cannot out-damage the pool", () => {
    // A lone Tiny rates 0.45: pool/0.45 would hand it more than the whole pool, which is why the game floors
    // the DIVISOR rather than the count.
    expect(poolShare(1000, 0.45, off)).toBeCloseTo(1000 / 0.45, 6);
    expect(poolShare(1000, 0.1, off)).toBeCloseTo(1000 / 0.45, 6);
    expect(poolShare(1000, 0, off)).toBeCloseTo(1000 / 0.45, 6);
  });

  it("defaults to no penalty when the bridge sends no caps", () => {
    expect(poolShare(1000, 6, bg)).toBeCloseTo(1000 / 6, 6);
  });
});

// The layer split. A mining or salvage gun reaches only its own `targetLayer`, so a battery that cannot
// touch one layer cannot finish the job however much power it piles onto the other.
describe("layer-aware objective (V31)", () => {
  const bgL: ShipPools = {
    poolCombatPower: 10_000, poolPrecision: 0, equivalentTurrets: 2,
    precisionDivisor: 5_000, critDamage: 1, megaCrit: 0,
    poolSalvagePower: 9_000, equivalentTurretsSalvage: 2,
  };
  const sv = (name: string, val: number, layer?: string): Item => ({
    name, size: "Large", damageType: "Kinetic", aspects: [], substats: [], stats: [], powerUsage: 0,
    gameplayType: "Salvage", targetLayer: layer,
    mainStat: { name: "Salvage Power", amount: String(val) },
  } as unknown as Item);

  it("counts a `Both` gun toward EITHER layer, not neither", () => {
    // Matching `targetLayer === layer` exactly excluded a Both gun from both sides, under-reporting every figure.
    expect(coversLayer(sv("b", 100, "Both"), "Surface")).toBe(true);
    expect(coversLayer(sv("b", 100, "Both"), "Core")).toBe(true);
    expect(coversLayer(sv("s", 100, "Surface"), "Core")).toBe(false);
    const both = [sv("b", 100, "Both"), sv("b2", 100, "Both")];
    expect(setPowerByLayer(both, bgL, "Salvage", "Core")).toBeGreaterThan(0);
    expect(setRank(both, bgL, "balanced")[1]).toBeGreaterThan(0);
  });

  it("scores an all-Surface battery at zero under `balanced`, and refuses it", () => {
    const set = [sv("a", 500, "Surface"), sv("b", 500, "Surface")];
    expect(setRank(set, bgL, "balanced")).toEqual([1, 0]);
    expect(coversLayers(set, "Salvage", "balanced")).toBe(false);
    // ...while the same battery is perfectly good if that is all you asked of it.
    expect(setRank(set, bgL, "surface")[1]).toBeGreaterThan(0);
    expect(coversLayers(set, "Salvage", "surface")).toBe(true);
  });

  it("is the BOTTLENECK layer — piling onto the strong side buys nothing", () => {
    const mixed = [sv("s", 500, "Surface"), sv("c", 500, "Core")];
    const bal = setRank(mixed, bgL, "balanced")[1];
    const s = setPowerByLayer(mixed, bgL, "Salvage", "Surface")!;
    const c = setPowerByLayer(mixed, bgL, "Salvage", "Core")!;
    // The guns fire in parallel, so the wreck is stripped no faster than its slower layer.
    expect(bal).toBeCloseTo(Math.min(s, c), 6);
    expect(bal).toBeLessThanOrEqual(setPower(mixed, bgL, "Salvage"));

    // A third gun on the ALREADY-STRONG layer still adds to the battery's total, because it is another gun with
    // its own main power. It does NOT lift the other layer: since 0.8.1.23 a turret's main power stays with that
    // turret, and only power SUBSTATS reach the pool the other layer draws from.
    const lopsided = [sv("s1", 500, "Surface"), sv("s2", 900, "Surface"), sv("c", 500, "Core")];
    expect(setPower(lopsided, bgL, "Salvage")).toBeGreaterThan(setPower(mixed, bgL, "Salvage"));
    expect(setRank(lopsided, bgL, "balanced")[1]).toBeGreaterThanOrEqual(bal);

    // What the bottleneck figure actually rewards is EVEN RATINGS across the layers, not raw power: the pool is
    // shared out by turret SIZE, so with four equal guns a 2:2 split beats 3:1 — the odd gun on the strong layer
    // does nothing for the layer that is holding you up.
    const even = [sv("s1", 500, "Surface"), sv("s2", 500, "Surface"), sv("c1", 500, "Core"), sv("c2", 500, "Core")];
    const uneven = [sv("s1", 500, "Surface"), sv("s2", 500, "Surface"), sv("s3", 500, "Surface"), sv("c1", 500, "Core")];
    expect(setPower(even, bgL, "Salvage")).toBeCloseTo(setPower(uneven, bgL, "Salvage"), 6);  // same total
    expect(setRank(even, bgL, "balanced")[1]).toBeGreaterThan(setRank(uneven, bgL, "balanced")[1]);

    // Raising the bottleneck now takes raising BOTH sides. Upgrading one gun leaves the other layer as the cap,
    // because its own main power is the part that no longer travels: under the old averaged mechanic a fatter
    // Core gun lifted the Surface figure too, and the bottleneck moved with it.
    const oneSide = [sv("s", 500, "Surface"), sv("c2", 900, "Core")];
    expect(setRank(oneSide, bgL, "balanced")[1]).toBeCloseTo(bal, 6);
    const bothSides = [sv("s", 900, "Surface"), sv("c2", 900, "Core")];
    expect(setRank(bothSides, bgL, "balanced")[1]).toBeGreaterThan(bal);
  });

  // The objective is STRICT and monotone: it never exempts a small set. Exempting one made it non-monotone in set
  // size (one Core gun scored well, two scored 0) and the ascent read that as "never add a second gun of a layer",
  // proposing one weak off-layer gun and leaving every other slot alone.
  it("is strict and monotone — a lone gun is not exempted from `balanced`", () => {
    const one = [sv("only", 500, "Surface")];
    expect(setRank(one, bgL, "balanced")[1]).toBe(0);
    expect(coversLayers(one, "Salvage", "balanced")).toBe(false);
    // Adding a second gun of the SAME layer must not be a cliff.
    const two = [sv("a", 500, "Surface"), sv("b", 500, "Surface")];
    expect(setRank(two, bgL, "balanced")[1]).toBe(setRank(one, bgL, "balanced")[1]);
    // ...and under a single-layer target more guns is more power, with no discontinuity anywhere.
    expect(setRank(two, bgL, "surface")[1]).toBeGreaterThan(setRank(one, bgL, "surface")[1]);
  });

  it("resolves a single-hardpoint hull by taking the better single-layer answer", () => {
    const surface = sv("s", 900, "Surface");
    const core = sv("c", 400, "Core");
    const chosen = optimizeTurretSetLayered([{ key: "t:0", candidates: [surface, core] }], bgL, "Salvage", { target: "balanced" });
    expect(chosen.get("t:0")).toBe(surface);   // not left empty, and not scored 0
  });

  it("falls back to the summed figure when a gun declares no reach, rather than inventing a zero", () => {
    const unknown = [sv("a", 500), sv("b", 500)];            // no targetLayer at all
    expect(setRank(unknown, bgL, "balanced")[1]).toBe(setPower(unknown, bgL, "Salvage"));
    expect(coversLayers(unknown, "Salvage", "balanced")).toBe(true);
  });

  it("enumerates assignments to reach both layers", () => {
    const surface = [sv("s1", 900, "Surface"), sv("s2", 800, "Surface")];
    const core = [sv("c1", 400, "Core")];
    const slots = [
      { key: "t:0", current: surface[0], candidates: [...surface, ...core] },
      { key: "t:1", current: surface[1], candidates: [...surface, ...core] },
    ];
    const picked = [...optimizeTurretSetLayered(slots, bgL, "Salvage", { target: "balanced" }).values()];
    expect(picked).toHaveLength(2);
    expect(coversLayers(picked, "Salvage", "balanced")).toBe(true);
    // NB the plain ascent solves this one too — an uncovered layer scores 0, so any covering move is a strict
    // gain and one pass finds it. The enumeration's value is in the cases where it stalls; see the search below.
  });

  // Does the meta search actually earn its keep, and is it ever a step backwards? Both are empirical questions,
  // so they are answered by search rather than by argument. Deterministic LCG, so a failure is reproducible.
  it("is never worse than the plain ascent, and is sometimes strictly better", () => {
    let seed = 12345;
    const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
    let wins = 0, trials = 0;
    for (let t = 0; t < 400; t++) {
      const nSlots = 2 + Math.floor(rnd() * 3);
      const pool: Item[] = [];
      for (let i = 0; i < nSlots + Math.floor(rnd() * 4); i++)
        pool.push(sv(`i${i}`, 100 + Math.floor(rnd() * 900), rnd() < 0.5 ? "Surface" : "Core"));
      const slots = Array.from({ length: nSlots }, (_, k) => ({
        key: `t:${k}`,
        current: rnd() < 0.6 ? pool[Math.floor(rnd() * pool.length)] : null,
        candidates: pool.filter(() => rnd() < 0.8),
      }));
      if (slots.some((sl) => sl.candidates.length === 0)) continue;
      trials++;
      const plain = setRank([...optimizeTurretSet(slots, bgL, 4, [], "balanced").values()], bgL, "balanced");
      const layered = setRank([...optimizeTurretSetLayered(slots, bgL, "Salvage", { target: "balanced" }).values()], bgL, "balanced");
      // Holds by construction: the plain result is one of the candidates the enumeration keeps.
      expect(rankGt(plain, layered)).toBe(false);
      if (rankGt(layered, plain)) wins++;
    }
    expect(trials).toBeGreaterThan(300);
    // Measured ~8% of instances over a 4000-trial run; asserted loosely so the figure moving is not a failure.
    expect(wins).toBeGreaterThan(0);
  }, 30_000);

  it("honours a pinned layerRole instead of enumerating over it", () => {
    const surface = sv("s", 900, "Surface");
    const core = sv("c", 400, "Core");
    const slots = [
      { key: "t:0", candidates: [surface, core], layerRole: "core" as const },
      { key: "t:1", candidates: [surface, core] },
    ];
    const chosen = optimizeTurretSetLayered(slots, bgL, "Salvage", { target: "balanced" });
    expect(chosen.get("t:0")).toBe(core);      // the pin decided this one
    expect(chosen.get("t:1")).toBe(surface);   // the enumeration filled the other layer
  });

  it("filters to one layer for a single-layer target", () => {
    const surface = sv("s", 900, "Surface");
    const core = sv("c", 400, "Core");
    const slots = [{ key: "t:0", candidates: [surface, core] }];
    expect(optimizeTurretSetLayered(slots, bgL, "Salvage", { target: "core" }).get("t:0")).toBe(core);
    expect(optimizeTurretSetLayered(slots, bgL, "Salvage", { target: "surface" }).get("t:0")).toBe(surface);
  });
});

// Same tier is not the same unit: Mining and Salvage are both tier 1, so a delta between them is a
// mislabel one level down — the tier check that guards a DPS index against a power share does not catch it.
describe("sameScale (V18, cross-activity)", () => {
  const t = (act: "Combat" | "Mining" | "Salvage"): Item => ({
    name: act, size: "Large", damageType: "Kinetic", aspects: [], substats: [], stats: [], powerUsage: 0,
    gameplayType: act, targetLayer: "Surface", mainStat: { name: `${act} Power`, amount: "500" },
  } as unknown as Item);

  it("refuses a Mining/Salvage comparison even though both are tier 1", () => {
    expect(setRank([t("Mining")], bg)[0]).toBe(1);
    expect(setRank([t("Salvage")], bg)[0]).toBe(1);
    expect(sameScale([t("Mining")], [t("Salvage")])).toBe(false);
  });

  it("allows like for like, and refuses combat against non-combat", () => {
    expect(sameScale([t("Salvage")], [t("Salvage")])).toBe(true);
    expect(sameScale([t("Combat")], [t("Combat")])).toBe(true);
    expect(sameScale([t("Combat")], [t("Mining")])).toBe(false);
  });
});

// The activity a set is judged on is the CALLER'S, never read off the set being scored. `activityOf` answers
// "Mining" for any mixed non-combat battery, so a single mining gun flips which pool the whole set is measured
// against — and with a fatter mining pool the ascent climbs by inserting guns the ship's actual job cannot use,
// while every panel still reads Salvage.
describe("the scored activity is an INPUT (V31)", () => {
  const bgX: ShipPools = {
    poolCombatPower: 1_000, poolPrecision: 0, equivalentTurrets: 3,
    precisionDivisor: 3_430, critDamage: 0, megaCrit: 0,
    poolMiningPower: 90_000, poolSalvagePower: 9_000,
    equivalentTurretsMining: 3, equivalentTurretsSalvage: 3,
  };
  const g = (name: string, act: "Mining" | "Salvage", val: number, layer: string): Item => ({
    name, size: "Large", damageType: "Kinetic", aspects: [], substats: [], stats: [], powerUsage: 0,
    gameplayType: act, targetLayer: layer,
    mainStat: { name: `${act} Power`, amount: String(val) },
  } as unknown as Item);

  const cutter = g("Salvage Cutter", "Salvage", 10_400, "Surface");
  const grinder = g("Salvage Grinder", "Salvage", 9_764, "Core");
  const slicer = g("Mining Twin Slicer", "Mining", 4_950, "Surface");
  const buster = g("Core Buster", "Mining", 5_516, "Core");

  it("cannot raise a SALVAGE score by adding mining guns", () => {
    const salvageOnly = setRank([cutter, grinder], bgX, "balanced", "Salvage");
    // BOTH mining layers, so the mining figure is a real number rather than a bottlenecked 0 — otherwise this
    // passes for the wrong reason and the swap it is meant to forbid still happens.
    const withMining = setRank([cutter, grinder, slicer, buster], bgX, "balanced", "Salvage");
    expect(rankGt(withMining, salvageOnly)).toBe(false);
  });

  it("keeps a salvage battery whatever the mining pool is worth", () => {
    const slots = [
      { key: "t:0", current: cutter, candidates: [cutter, slicer, buster] },
      { key: "t:1", current: grinder, candidates: [grinder, slicer, buster] },
    ];
    const chosen = optimizeTurretSetLayered(slots, bgX, "Salvage", { target: "balanced" });
    expect([...chosen.values()].map((it) => it.gameplayType)).toEqual(["Salvage", "Salvage"]);
  });

  it("scores the same set differently depending only on which activity was asked about", () => {
    const set = [cutter, grinder, slicer, buster];
    const asSalvage = setRank(set, bgX, "balanced", "Salvage")[1];
    const asMining = setRank(set, bgX, "balanced", "Mining")[1];
    expect(asSalvage).toBeGreaterThan(0);
    expect(asMining).toBeGreaterThan(0);
    expect(asSalvage).not.toBeCloseTo(asMining, 6);
    // Read off the set, the answer is Mining — which is why it has to be an input.
    expect(setRank(set, bgX, "balanced")[1]).toBeCloseTo(asMining, 6);
  });
});

// The pools belong to the ship being FLOWN; the gear tab can be aimed at a parked one. Scoring across that gap is
// how a strictly weaker gun came to read "+9.2%": the background clamps to 0 and the candidate's own roll becomes
// the entire pool.
describe("pools are only used for the ship they describe (V19, V26)", () => {
  const p: ShipPools = {
    poolCombatPower: 7_816, poolPrecision: 14_935, equivalentTurrets: 4,
    precisionDivisor: 2_986, critDamage: 0, megaCrit: 0,
  };

  it("refuses a reading from another ship", () => {
    expect(poolsForShip(p, "flown-guid", "parked-guid")).toBeNull();
  });

  it("allows it for the ship it came from", () => {
    expect(poolsForShip(p, "same-guid", "same-guid")).toBe(p);
  });

  // An older bridge or a pre-layout render names neither ship; refusing there would drop expanded mode for
  // everyone, so an unknown identity is not treated as a mismatch.
  it("does not refuse when either ship is unknown", () => {
    expect(poolsForShip(p, null, "parked-guid")).toBe(p);
    expect(poolsForShip(p, "flown-guid", null)).toBe(p);
    expect(poolsForShip(null, "a", "a")).toBeNull();
  });
});

// The objective anchors on the crit chance the GAME reports, and lets a candidate move only the part
// Precision explains. Without this, every flat crit source (skill tree, officers, crit aspects) is invisible.
describe("crit anchoring", () => {
  // Shaped like the real capture this was measured on, so the recovered additive is the real 0.19.
  const anchored = (critChance?: number, critChanceMult = 1): ShipPools => ({
    poolCombatPower: 200_000, poolPrecision: 22_355.64, equivalentTurrets: 6,
    precisionDivisor: 3_430, critDamage: 0.345990747, megaCrit: 3, critChance, critChanceMult,
  });
  const plain = (cp: number, prec: number) =>
    withStats([{ stat: "Combat Power", amount: cp }, { stat: "Precision", amount: prec }]);

  it("recovers the additive sources the reported figure carries beyond Precision", () => {
    // 0.25049 of the reported 0.47049 is what Precision explains at this divisor; 0.03 is the base; the rest
    // is additive — skill tree, officers, crit aspects.
    const bgA = background(anchored(0.470489651), []);
    expect(bgA.critAdd).toBeCloseTo(0.19, 6);
  });

  // The whole reason the multiplier has to travel with the reading: the product alone is ambiguous, and the
  // two readings below are IDENTICAL yet imply different additive sources.
  it("splits the same reported chance differently once the multiplier is known", () => {
    const one = background(anchored(0.470489651, 1), []);
    const scaled = background(anchored(0.470489651, 1.676), []);
    expect(one.critAdd).toBeCloseTo(0.19, 6);
    expect(scaled.critAdd).toBeCloseTo(0.470489651 / 1.676 - 0.03 - 0.250490, 5);
    expect(scaled.critAdd).not.toBeCloseTo(one.critAdd as number, 3);
  });

  it("refuses to anchor at all when the multiplier is missing — the split would be a guess", () => {
    const noMult = background({ ...anchored(0.470489651), critChanceMult: undefined }, []);
    expect(noMult.critAdd).toBeUndefined();
  });

  it("derives it against the FULL precision, before the equipped turrets come out", () => {
    // The reported chance was measured with the battery fitted, so the remainder must be taken there —
    // subtracting first would credit the turrets' Precision to the flat sources.
    const fitted = [plain(10_000, 4_000)];
    const withTurret = background(anchored(0.470489651), fitted);
    const bare = background(anchored(0.470489651), []);
    expect(withTurret.poolPrecision).toBeLessThan(bare.poolPrecision);
    expect(withTurret.critAdd).toBeCloseTo(bare.critAdd as number, 10);
  });

  it("REFUSES a reading the curve cannot account for, rather than clamping it to zero", () => {
    // Reported below what Precision alone implies: the reading and the curve disagree about this hull, so
    // there is no honest anchor. A clamped 0 would assert "no flat sources" about a ship reporting otherwise.
    expect(background(anchored(0.01), []).critAdd).toBeUndefined();
  });

  it("leaves an older bridge on the base-plus-curve footing it already had", () => {
    const bgNone = background(anchored(undefined), []);
    expect(bgNone.critAdd).toBeUndefined();
    // Same numbers as before the anchor existed: base plus curve, no additive, no multiplier.
    const set = [plain(20_000, 5_000)];
    expect(setDps(set, bgNone)).toBeGreaterThan(0);
    expect(setDps(set, { ...bgNone, critAdd: 0, critChanceMult: 1 })).toBeCloseTo(setDps(set, bgNone), 10);
  });

  it("is a NO-OP on a hull whose only flat source is the base itself", () => {
    // Measured on a real ship: reported 0.24490793 == 0.03 + precisionCrit(17645.6348, 3200), so the
    // remainder IS the base and anchoring must not move a single figure.
    const hull: ShipPools = {
      poolCombatPower: 10_033.9346, poolPrecision: 17_645.6348, equivalentTurrets: 3,
      precisionDivisor: 3_200, critDamage: 0.0296789762, megaCrit: 0,
      critChance: 0.24490793, critChanceMult: 1,
    };
    const bgA = background(hull, []);
    expect(bgA.critAdd).toBeCloseTo(0, 7);
    const set = [plain(5_000, 2_000)];
    // Compared as a RATIO: the figures are in the thousands, so an absolute tolerance would be testing the
    // magnitude rather than the agreement. What is left is the 8-decimal truncation of the reported chance.
    expect(setDps(set, bgA) / setDps(set, { ...bgA, critAdd: undefined })).toBeCloseTo(1, 7);
  });

  it("makes a Precision roll worth MORE, not less — understating crit understated Precision", () => {
    // The direction that was not obvious: a higher base compounds through the megaCrit cascade, so the same
    // Precision delta buys more damage once the flat sources are honoured.
    const bgA = background(anchored(0.470489651), []);
    const bgU: ShipPools = { ...bgA, critAdd: undefined };
    const dull = plain(20_000, 0);
    const sharp = plain(20_000, 6_000);      // same power, more Precision
    const gainAnchored = setDps([sharp], bgA) / setDps([dull], bgA) - 1;
    const gainUnanchored = setDps([sharp], bgU) / setDps([dull], bgU) - 1;
    expect(gainAnchored).toBeGreaterThan(gainUnanchored);
  });
});

// A reported pool is a PRODUCT. Every factor except the reactor bracket stays constant while candidates
// are swapped, so contributions must be subtracted and added in ADDITIVE space and the factors re-applied.
describe("pool de-multiplication", () => {
  const RESID = 2.697861;              // measured on a Combat hull after the reactor factor is divided out
  const REACTOR = 0.2;                 // +20% bracket, as reported
  const pools = (mult?: number): ShipPools => ({
    poolCombatPower: 241_899.359, poolPrecision: 24_176.8184, equivalentTurrets: 15,
    precisionDivisor: 3_430, critDamage: 0.425, megaCrit: 3,
    poolCombatPowerMult: mult,
    energy: { used: 8_000, capacity: 40_000, mod: REACTOR },
  });
  // `contributionOf` reads a turret's own power off its MAIN STAT, not off a stat line, so the headline is
  // what has to move here — a `Combat Power` line would leave every gun contributing the factory default.
  const cpGun = (cp: number) => gun({ mainStat: { name: "Combat Power", amount: String(cp) } });

  it("derives the residual as the reported multiplier minus the reactor factor", () => {
    const bg = background(pools(RESID * (1 + REACTOR)), []);
    expect(bg.combatMultResidual).toBeCloseTo(RESID, 6);
  });

  it("ROUND TRIPS: what background removed is exactly what the pool credited", () => {
    // The strong check: recompose rather than eyeball. A pool that holds `residual`x of
    // each fitted gun's power must give that much back when the gun is taken out.
    const fitted = [cpGun(9_000), cpGun(7_500)];
    const full = pools(RESID * (1 + REACTOR));
    const bg = background(full, fitted);
    const removed = 16_500 * (1 + REACTOR) * RESID;
    expect(bg.poolCombatPower + removed).toBeCloseTo(full.poolCombatPower, 3);
  });

  it("credits a candidate's own power at its real worth, not at 1/residual of it", () => {
    // Without the residual a gun's own Combat Power lands at x1 into a pool holding x2.698 of everyone else's,
    // so the same swap reads as a far smaller improvement than the game would give.
    const rel = (bg: ShipPools) => {
      const small = setDps([cpGun(8_000)], bg);
      const big = setDps([cpGun(16_000)], bg);
      return big / small - 1;
    };
    const corrected = rel(background(pools(RESID * (1 + REACTOR)), []));
    const uncorrected = rel(background(pools(undefined), []));
    expect(corrected).toBeGreaterThan(uncorrected);
    // The candidate's contribution is amplified by exactly the residual, so the gap is not marginal.
    expect(corrected / uncorrected).toBeGreaterThan(1.5);
  });

  it("leaves the arithmetic untouched when the bridge reports no multiplier", () => {
    const bg = background(pools(undefined), []);
    expect(bg.combatMultResidual).toBeUndefined();
    // The plain arithmetic, before the non-reactor residual is factored out: reported/reactor + own.
    const set = [cpGun(10_000)];
    expect(setDps(set, bg)).toBeCloseTo(setDps(set, { ...bg, combatMultResidual: 1 }), 6);
  });

  it("refuses a nonsense multiplier rather than dividing by it", () => {
    expect(background(pools(0), []).combatMultResidual).toBeUndefined();
    expect(background(pools(-3), []).combatMultResidual).toBeUndefined();
  });
});

// The guard and the subtraction it protects must reconcile in ONE space, or the guard passes while
// `background()` clamps a real deficit — the failure the reconcile guard exists to catch.
describe("poolsReconcile agrees with background's space", () => {
  const cpGun = (cp: number) => gun({ mainStat: { name: "Combat Power", amount: String(cp) } });
  const pools = (reported: number, mult?: number): ShipPools => ({
    poolCombatPower: reported, poolPrecision: 1_000, equivalentTurrets: 6,
    precisionDivisor: 3_430, critDamage: 0.4, megaCrit: 0,
    poolCombatPowerMult: mult,
    energy: { used: 1_000, capacity: 10_000, mod: 0.2 },
  });

  it("refuses a reading whose ADDITIVE pool cannot hold the battery, even though the product could", () => {
    // reported 120,000 at multiplier 3.0 is only 40,000 of additive room; a 50,000 battery does not fit.
    // Dividing by the reactor alone (100,000) would have said yes and let the subtraction clamp.
    const battery = [cpGun(25_000), cpGun(25_000)];
    expect(poolsReconcile(pools(120_000, 3), battery)).toBe(false);
    expect(poolsReconcile(pools(120_000, undefined), battery)).toBe(true);   // the old, weaker test
  });

  it("accepts one that does fit, and background then stays non-negative", () => {
    const battery = [cpGun(9_000), cpGun(7_000)];
    const p = pools(120_000, 3);
    expect(poolsReconcile(p, battery)).toBe(true);
    // 40,000 additive room less 16,000 of battery leaves 24,000 — positive, so nothing is clamped.
    const bg = background(p, battery);
    expect(bg.poolCombatPower).toBeGreaterThan(0);
    expect(bg.poolCombatPower / (bg.poolCombatPowerMult as number)).toBeCloseTo(24_000, 6);
  });
});

// The non-combat pools have the same product problem, and their own multipliers.
describe("mining and salvage pools de-multiply too", () => {
  const mineGun = (mp: number) => gun({
    type: "Mining Laser", gameplayType: "Mining", targetLayer: "Surface",
    mainStat: { name: "Mining Power", amount: String(mp) },
  } as Partial<Item>);
  const pools = (mult?: number): ShipPools => ({
    poolCombatPower: 1_000, poolPrecision: 1_000, equivalentTurrets: 1,
    precisionDivisor: 3_430, critDamage: 0.4, megaCrit: 0,
    poolMiningPower: 120_000, equivalentTurretsMining: 4,
    poolMiningPowerMult: mult,
    energy: { used: 1_000, capacity: 10_000, mod: 0.2 },
  });

  it("derives a mining residual and round trips through background", () => {
    const bg = background(pools(3.6), [mineGun(5_000)]);
    expect(bg.miningMultResidual).toBeCloseTo(3, 6);        // 3.6 / 1.2
    // 120,000 / 3.6 = 33,333.3 additive, less the fitted 5,000 = 28,333.3; back up by 3.6.
    expect((bg.poolMiningPower as number) / 3.6).toBeCloseTo(28_333.333, 2);
  });

  it("credits a mining gun's own power at its real worth", () => {
    const rel = (bg: ShipPools) =>
      setPower([mineGun(16_000)], bg, "Mining") / setPower([mineGun(8_000)], bg, "Mining") - 1;
    expect(rel(background(pools(3.6), []))).toBeGreaterThan(rel(background(pools(undefined), [])));
  });

  it("leaves the arithmetic alone when no mining multiplier is reported", () => {
    const bg = background(pools(undefined), []);
    expect(bg.miningMultResidual).toBeUndefined();
    const set = [mineGun(9_000)];
    expect(setPower(set, bg, "Mining")).toBeCloseTo(setPower(set, { ...bg, miningMultResidual: 1 }, "Mining"), 6);
  });

  it("keeps the two activities' residuals apart", () => {
    const bg = background({ ...pools(3.6), poolSalvagePower: 50_000, poolSalvagePowerMult: 1.2 }, []);
    expect(bg.miningMultResidual).toBeCloseTo(3, 6);
    expect(bg.salvageMultResidual).toBeCloseTo(1, 6);
  });
});

// The reactor factor is PER STAT. `ApplyReactorModifier` adds a skill-tree term to the COMBAT pool
// only, and only in the top bracket, so a client using one `reactorBonus` for all three is out by that term.
describe("combat reactor factor carries a skill term", () => {
  const cpGun = (cp: number) => gun({ mainStat: { name: "Combat Power", amount: String(cp) } });
  // Measured on a live Combat hull: reported multiplier 3.836866 with named sources giving 2.372759, i.e. the
  // combat factor the game applied was 1.617048 where the plain bracket is 1.20 — an implied bonus of 0.417.
  const SKILL = 0.417048;
  const pools = (over: Partial<ShipPools> = {}): ShipPools => ({
    poolCombatPower: 299_106.5, poolPrecision: 19_734, equivalentTurrets: 15,
    precisionDivisor: 3_430, critDamage: 0.667, megaCrit: 3,
    poolCombatPowerMult: 3.836866, combatReactorBonus: SKILL,
    energy: { used: 4_000, capacity: 40_000, mod: 0.2 },     // 10% load: top bracket
    ...over,
  });

  it("divides out 1.617, not 1.20, when deriving the residual", () => {
    const bg = background(pools(), []);
    expect(bg.combatMultResidual).toBeCloseTo(3.836866 / 1.617048, 4);
    // The old arithmetic would have produced a residual a third larger.
    expect(bg.combatMultResidual).toBeLessThan(3.836866 / 1.2);
  });

  it("ROUND TRIPS through the factor it actually applied", () => {
    const fitted = [cpGun(9_000)];
    const full = pools();
    const bg = background(full, fitted);
    const removed = 9_000 * 1.617048 * (bg.combatMultResidual as number);
    expect(bg.poolCombatPower + removed).toBeCloseTo(full.poolCombatPower, 2);
  });

  it("drops the skill term when a candidate set pushes usage out of the top bracket", () => {
    // At >50% load the game applies the plain bracket, so a set that crosses the line loses the skill term
    // as well as the bracket — a bigger cliff than the bracket alone.
    const bg = background(pools(), []);
    const thrifty = setDps([gun({ mainStat: { name: "Combat Power", amount: "20000" }, powerUsage: 0 } as Partial<Item>)], bg);
    const hungry = setDps([gun({ mainStat: { name: "Combat Power", amount: "20000" }, powerUsage: 30_000 } as Partial<Item>)], bg);
    expect(hungry).toBeLessThan(thrifty);
  });

  it("leaves the other pools on the plain bracket", () => {
    const p = pools({ poolMiningPower: 120_000, poolMiningPowerMult: 3.6, equivalentTurretsMining: 4 });
    const bg = background(p, []);
    // Mining divides by 1.2 even though combat divides by 1.617.
    expect(bg.miningMultResidual).toBeCloseTo(3.6 / 1.2, 6);
    expect(bg.combatMultResidual).toBeCloseTo(3.836866 / 1.617048, 4);
  });

  it("is a no-op where the skill node is unspent", () => {
    const withBonus = background(pools({ combatReactorBonus: 0 }), []);
    expect(withBonus.combatMultResidual).toBeCloseTo(3.836866 / 1.2, 6);
  });
});

// The floor is a statement about what the model can RESOLVE, so it is pinned: three known gaps (an unexplained
// x1.2439 on the combat pool, a multiplier folded into an additive term, weapon-local aspect stats the bridge
// cannot see) put sub-percent predictions inside the noise. A 0.28% gain was enough to propose trading a Lv64
// gun for a Lv63 one, which is the case this guards.
describe("the worth-it floor", () => {
  it("refuses a gain smaller than the model's own uncertainty", () => {
    expect(MIN_GAIN).toBe(0.01);
    const base: Rank = [2, 100_000];
    expect(worthSwitching([2, 100_276], base)).toBe(false);   // +0.276% — the measured live proposal
    expect(worthSwitching([2, 100_900], base)).toBe(false);   // +0.9%, still under
    expect(worthSwitching([2, 102_000], base)).toBe(true);    // +2%, worth a workshop trip
  });

  it("still refuses a regression, and a tie", () => {
    const base: Rank = [2, 100_000];
    expect(worthSwitching([2, 99_000], base)).toBe(false);
    expect(worthSwitching([2, 100_000], base)).toBe(false);
  });
});
