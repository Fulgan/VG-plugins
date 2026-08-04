import { describe, it, expect } from "vitest";
import { turretScore, expectedCritFactor, scoreReasons } from "./turretScore";
import type { Item } from "./types";

// A Small Autocannon's real numbers, read off the running game: base rate 2.037/s.
const turret = (over: Partial<Item> = {}): Item => ({
  key: 1, slot: 1, identifier: null, name: "Autocannon Mk.XVI", rarity: "Exotic", level: 63,
  size: "Small", type: "Autocannon", category: "Turret", damageType: "Kinetic", sellValue: 0,
  mainStat: { name: "Combat Power", amount: "2,500" },
  fireDelayRaw: 0.4, reloadDelayRaw: 2, magSizeRaw: 10, burstAmount: 1, burstDelay: 0,
  aspects: [], stats: [], substats: [], bonus: null, bonusStat: null, ...over,
} as unknown as Item);

const withStats = (lines: { stat: string; amount: number; multiplier?: number }[], over: Partial<Item> = {}) =>
  turret({ stats: lines.map((l) => ({ multiplier: 1, ...l })), ...over } as Partial<Item>);

describe("expectedCritFactor", () => {
  it("is 1 without crit chance", () => expect(expectedCritFactor(0, 5)).toBe(1));
  it("weights the multiplier by the chance, base multiplier being 2 + CriticalDamage", () => {
    expect(expectedCritFactor(0.25, 0)).toBeCloseTo(1.25, 10);   // .75×1 + .25×2
    expect(expectedCritFactor(0.5, 1)).toBeCloseTo(2, 10);       // .5×1 + .5×3
  });
});

describe("turretScore", () => {
  it("equals power/5 for a plain turret — the fire rate cancels out", () => {
    // Per-shot damage is power/5 ÷ rate, so × rate leaves power/5. Two guns with the same power and very
    // different rates must score identically.
    expect(turretScore(turret()).score).toBeCloseTo(500, 6);
    expect(turretScore(turret({ fireDelayRaw: 0.05, magSizeRaw: 100 })).score).toBeCloseTo(500, 6);
  });

  it("values an AttackSpeed roll, which the main stat cannot see", () => {
    const plain = turretScore(turret());
    const fast = turretScore(withStats([{ stat: "AttackSpeed", amount: 0.25 }]));
    expect(fast.score).toBeGreaterThan(plain.score);
    // 10 shots: 10×0.4 + 2 = 6s → 1.667/s. With +25%: 0.32 each → 5.2s → 1.923/s. Ratio ≈ 1.1538.
    expect(fast.speedGain).toBeCloseTo(1.1538, 3);
  });

  it("values ReloadSpeed and MagazineSize too", () => {
    expect(turretScore(withStats([{ stat: "ReloadSpeed", amount: 1 }])).speedGain).toBeGreaterThan(1);
    expect(turretScore(withStats([{ stat: "MagazineSize", amount: 1 }])).speedGain).toBeGreaterThan(1);
  });

  it("counts only the damage type this turret actually fires", () => {
    // Kinetic gun: a KineticDamage roll counts, a ColdDamage roll does not — the game reads
    // GetStat(type.GetDamageBoostStat()), one aggregate per type.
    expect(turretScore(withStats([{ stat: "KineticDamage", amount: 0.1 }])).damageGain).toBeCloseTo(1.1, 6);
    expect(turretScore(withStats([{ stat: "ColdDamage", amount: 0.1 }])).damageGain).toBeCloseTo(1, 6);
    // The untyped Damage stat applies whatever the type.
    expect(turretScore(withStats([{ stat: "Damage", amount: 0.2 }])).damageGain).toBeCloseTo(1.2, 6);
  });

  it("folds a stat listed twice, and reads a multiplier line as its additive equivalent", () => {
    expect(turretScore(withStats([
      { stat: "Damage", amount: 0.1 }, { stat: "Damage", amount: 0.05 },
    ])).damageGain).toBeCloseTo(1.15, 6);
    expect(turretScore(withStats([{ stat: "Damage", amount: 0, multiplier: 1.1 }])).damageGain).toBeCloseTo(1.1, 6);
  });

  it("includes aspect damage", () => {
    const it = turret({ aspects: [{ name: "Frozen Core", description: "Deals an additional 10% Cold damage." }] } as Partial<Item>);
    expect(turretScore(it).score).toBeCloseTo(550, 6);
  });

  it("reports incomplete without rate components, and still ranks by the old baseline", () => {
    const old = turretScore(turret({ fireDelayRaw: null, magSizeRaw: null }));
    expect(old.complete).toBe(false);
    expect(old.speedGain).toBe(1);
    expect(old.score).toBeCloseTo(500, 6);
  });

  it("explains only the factors that actually moved the score", () => {
    expect(scoreReasons(turretScore(turret()))).toEqual([]);
    expect(scoreReasons(turretScore(withStats([{ stat: "Damage", amount: 0.2 }])))).toEqual(["damage +20%"]);
  });
});
