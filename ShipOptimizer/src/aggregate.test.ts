import { describe, it, expect } from "vitest";
import { aggregate, delta } from "./aggregate";
import type { Item } from "./types";

function item(stats: { stat: string; amount?: number; multiplier?: number }[]): Item {
  return {
    key: null, slot: null, identifier: null, name: "x", rarity: "Standard", level: 1,
    size: null, type: null, category: "Turret", sellValue: 0, aspects: [], substats: [], bonus: null, bonusStat: null,
    stats: stats.map((s) => ({ stat: s.stat, amount: s.amount ?? 0, multiplier: s.multiplier ?? 1 })),
  };
}

describe("aggregate (V2 — totals from bridge stats only)", () => {
  it("sums flat amounts per stat across items", () => {
    const t = aggregate([
      item([{ stat: "CombatPower", amount: 100 }]),
      item([{ stat: "CombatPower", amount: 50 }, { stat: "ShieldHP", amount: 20 }]),
    ]);
    expect(t.CombatPower.amount).toBe(150);
    expect(t.ShieldHP.amount).toBe(20);
  });

  it("multiplies percentage multipliers", () => {
    const t = aggregate([
      item([{ stat: "FireRate", multiplier: 1.1 }]),
      item([{ stat: "FireRate", multiplier: 1.2 }]),
    ]);
    expect(t.FireRate.amount).toBe(0);
    expect(t.FireRate.multiplier).toBeCloseTo(1.32);
  });

  it("handles empty input", () => {
    expect(aggregate([])).toEqual({});
  });

  it("delta subtracts base from build over the union of stats", () => {
    const build = aggregate([item([{ stat: "CombatPower", amount: 200 }])]);
    const base = aggregate([item([{ stat: "CombatPower", amount: 150 }, { stat: "ShieldHP", amount: 10 }])]);
    const d = delta(build, base);
    expect(d.CombatPower.amount).toBe(50);
    expect(d.ShieldHP.amount).toBe(-10);
  });
});
