import { describe, it, expect } from "vitest";
import {
  background, moduleBetter, moduleWhy, optimizeModuleSet, poolsWithModule, poolsWithModules, setRank, rankGt,
  type ShipPools,
} from "./fleetDps";
import type { Item } from "./types";

// Choosing MODULES as a set, against the battery.
//
// One slot at a time is not enough because the modules share the ship: they feed the pools the guns are scored
// on, and the reactor bracket answers to the TOTAL draw. Two swaps that each keep their bracket can lose it
// together, and a per-slot search can only defend against that by refusing to give up a bracket at all — which
// also refuses the crossings that pay for themselves.

const gun = (over: Partial<Item> = {}): Item => ({
  key: 1, slot: 1, name: "Gun", rarity: "Exotic", level: 64, size: "Medium", type: "Railgun",
  category: "Turret", gameplayType: "Combat", damageType: "Kinetic", sellValue: 0,
  mainStat: { name: "Combat Power", amount: "10,000" }, powerUsage: 0, powerUsageBase: 0,
  fireDelayRaw: 0.4, reloadDelayRaw: 2, magSizeRaw: 10, burstAmount: 1, burstDelay: 0,
  aspects: [], stats: [], substats: [], bonus: null, bonusStat: null, ...over,
} as unknown as Item);

const mod = (slotType: string, name: string, draw: number,
             lines: { stat: string; amount?: number; multiplier?: number }[] = [],
             over: Partial<Item> = {}): Item => ({
  key: 2, slot: 2, name, rarity: "Standard", level: 60, size: "Large", type: slotType, slotType,
  category: "Module", gameplayType: null, sellValue: 0,
  mainStat: { name: "Armor HP", amount: "1,000" },
  powerUsage: draw, powerUsageBase: draw,
  stats: lines.map((l) => ({ amount: 0, multiplier: 1, ...l })),
  aspects: [], substats: [], bonus: null, bonusStat: null, ...over,
} as unknown as Item);

const battery = [gun(), gun()];
const CAP = 20_000;
const pools = (used: number): ShipPools => ({
  poolCombatPower: 40_000, poolPrecision: 12_300, equivalentTurrets: 4,
  precisionDivisor: 5_000, critDamage: 1, megaCrit: 0, critChance: 0.2, critChanceMult: 1,
  energy: { used, capacity: CAP, mod: 0.2 },
});

describe("poolsWithModules", () => {
  it("is the fold of the single swaps", () => {
    const a0 = mod("Armor", "a0", 2_000), a1 = mod("Armor", "a1", 3_000, [{ stat: "Combat Power", amount: 500 }]);
    const h0 = mod("Hull", "h0", 2_000), h1 = mod("Hull", "h1", 1_000, [{ stat: "Precision", amount: 800 }]);
    const one = poolsWithModule(poolsWithModule(pools(8_000), a0, a1), h0, h1);
    const many = poolsWithModules(pools(8_000), [a0, h0], [a1, h1]);
    expect(many.poolCombatPower).toBeCloseTo(one.poolCombatPower, 6);
    expect(many.poolPrecision).toBeCloseTo(one.poolPrecision, 6);
    expect(many.energy!.used).toBe(one.energy!.used);
    expect(many.energy!.capacity).toBeCloseTo(one.energy!.capacity, 6);
  });

  it("adds up the draw of the whole set, which is what a bracket answers to", () => {
    const a0 = mod("Armor", "a0", 2_000), a1 = mod("Armor", "a1", 4_000);
    const h0 = mod("Hull", "h0", 2_000), h1 = mod("Hull", "h1", 4_000);
    // 8,000 of 20,000 is 40%. Either swap alone reaches 10,000 — 50%, still the +20% band. Both reach 12,000,
    // which is 60% and only +10%.
    expect(poolsWithModules(pools(8_000), [a0, h0], [a1, h0]).energy!.used).toBe(10_000);
    expect(poolsWithModules(pools(8_000), [a0, h0], [a0, h1]).energy!.used).toBe(10_000);
    expect(poolsWithModules(pools(8_000), [a0, h0], [a1, h1]).energy!.used).toBe(12_000);
  });
});

// A module's PRECISION has to reach the objective, and for a long time it did not: `background` recovers the
// ship's additive crit sources by subtracting the precision curve from the REPORTED crit chance, so a projection
// that rewrites precision while leaving the reported chance alone grows the anchor by exactly the crit it removed.
// The gain came out as 0 and the decision fell through to tie-breaks — which handed a slot to whichever module
// drew less power, over one carrying +1,220 Precision and two aspects.
// a hangar bay was offered over a module carrying +1,220 Precision, because the projection left the
// precision anchor describing the OLD pool and the roll priced at nothing.
describe("a module's precision reaches the objective", () => {
  const rich = mod("Scanner", "rich", 500, [{ stat: "Precision", amount: 1_220 }]);
  const bare = mod("Scanner", "bare", 400);
  // Crit must be REPORTED for the anchor to exist at all — that is the case this guards.
  const withCrit = (used: number): ShipPools => ({ ...pools(used), critChance: 0.28, critChanceMult: 1 });

  it("prices losing it as a loss, not as nothing", () => {
    const bg = (inn: Item) => background(poolsWithModules(withCrit(8_000), [rich], [inn]), battery);
    const keep = setRank(battery, bg(rich));
    const swap = setRank(battery, bg(bare));
    expect(swap[1]).toBeLessThan(keep[1]);
    expect(rankGt(keep, swap)).toBe(true);
  });

  it("refuses the swap that only wins on draw", () => {
    const chosen = optimizeModuleSet([
      { key: "m:Scanner", current: rich, candidates: [rich, bare] },
    ], withCrit(8_000), battery, { role: "Combat" });
    expect(chosen.get("m:Scanner")).toBe(rich);
  });

  it("moves the reported chance by the curve, so the anchor comes out unchanged", () => {
    // The projection's own arithmetic: precision down ⇒ reported chance down by the curve's own difference.
    const next = poolsWithModules(withCrit(8_000), [rich], [bare]);
    expect(next.poolPrecision).toBeLessThan(withCrit(8_000).poolPrecision!);
    expect(next.critChance!).toBeLessThan(0.28);
  });
});

describe("optimizeModuleSet", () => {
  const a0 = mod("Armor", "a0", 2_000);
  const h0 = mod("Hull", "h0", 2_000);
  // Each candidate is a real gain on its own: a little pooled Combat Power for 2,000 more draw, which stays
  // inside the bracket alone.
  const a1 = mod("Armor", "a1", 4_000, [{ stat: "Combat Power", amount: 300 }]);
  const h1 = mod("Hull", "h1", 4_000, [{ stat: "Combat Power", amount: 300 }]);

  const worthOf = (inn: (Item | null)[]) =>
    setRank(battery, background(poolsWithModules(pools(8_000), [a0, h0], inn), battery));

  it("prices the pair that crosses a bracket TOGETHER, and takes only one", () => {
    // Each alone is an upgrade; both together are not, because the +20% band is lost on every pool at once.
    expect(rankGt(worthOf([a1, h0]), worthOf([a0, h0]))).toBe(true);
    expect(rankGt(worthOf([a0, h1]), worthOf([a0, h0]))).toBe(true);
    expect(rankGt(worthOf([a1, h1]), worthOf([a0, h0]))).toBe(false);

    const chosen = optimizeModuleSet([
      { key: "m:Armor", current: a0, candidates: [a0, a1] },
      { key: "m:Hull", current: h0, candidates: [h0, h1] },
    ], pools(8_000), battery, { role: "Combat" });
    expect([chosen.get("m:Armor"), chosen.get("m:Hull")]).not.toEqual([a1, h1]);
    // ...and it does not simply give up either: one of the two swaps is still taken, since one is free.
    expect(chosen.get("m:Armor") === a1 || chosen.get("m:Hull") === h1).toBe(true);
  });

  it("takes a crossing that pays for itself, which a bracket-preserving rule had to refuse", () => {
    // Same 4,000 draw, but the pooled gain is large enough to outweigh dropping +20% to +10%.
    const rich = mod("Armor", "rich", 8_000, [{ stat: "Combat Power", amount: 40_000 }]);
    const chosen = optimizeModuleSet([
      { key: "m:Armor", current: a0, candidates: [a0, rich] },
    ], pools(8_000), battery, { role: "Combat" });
    expect(chosen.get("m:Armor")).toBe(rich);
    expect(rankGt(worthOf([rich, h0]), worthOf([a0, h0]))).toBe(true);
  });

  it("is never worse than what is fitted", () => {
    // Every candidate is a loss, so the ascent has to keep the incumbent — the one guarantee a suggest button owes.
    const worse = mod("Armor", "worse", 9_000, [{ stat: "Combat Power", amount: -2_000 }]);
    const chosen = optimizeModuleSet([
      { key: "m:Armor", current: a0, candidates: [a0, worse] },
      { key: "m:Hull", current: h0, candidates: [h0] },
    ], pools(8_000), battery, { role: "Combat" });
    expect(chosen.get("m:Armor")).toBe(a0);
  });

  it("stays interactive on an armory of thousands", () => {
    // A real armory runs to thousands of modules and the ascent scores every candidate of every slot on every
    // pass of both seeds. The scoring state is mutated in place rather than copied per candidate, which is what
    // keeps that affordable; this pins it.
    const many = Array.from({ length: 2_000 }, (_, i) =>
      mod("Armor", `a${i}`, 1_000 + (i % 40) * 50, [{ stat: "Combat Power", amount: 100 + (i % 60) }]));
    const started = performance.now();
    const chosen = optimizeModuleSet([
      { key: "m:Armor", current: a0, candidates: [a0, ...many] },
      { key: "m:Hull", current: h0, candidates: [h0, h1] },
    ], pools(8_000), battery, { role: "Combat" });
    const took = performance.now() - started;
    expect(chosen.get("m:Armor")).toBeDefined();
    expect(took).toBeLessThan(3_000);
  });

  it("asks moduleBetter where the objective is silent, rather than inventing a tie rule", () => {
    // Two hull kits the objective cannot separate — no pooled lines, identical draw — so the countable
    // tie-breaks decide, and the ascent must reach the same answer `moduleBetter` gives on its own.
    const plain = mod("Hull", "plain", 2_000, [], { aspectSlots: 0 });
    const roomy = mod("Hull", "roomy", 2_000, [], { aspectSlots: 2 });
    const ctx = { pools: pools(8_000), turrets: battery, role: "Combat" as const };
    expect(moduleBetter(roomy, plain, ctx)).toBe(true);
    const chosen = optimizeModuleSet([
      { key: "m:Hull", current: plain, candidates: [plain, roomy] },
    ], pools(8_000), battery, { role: "Combat" });
    expect(chosen.get("m:Hull")).toBe(roomy);
  });
});

// A verdict the player cannot check is how and all stayed invisible: the rail showed `+0`
// beside a candidate that looked worse, and nothing said which step had decided.
//: a rail row has to carry the reason it is there.
describe("the decision says why", () => {
  const plain = mod("Hull", "plain", 500);

  it("names the objective when the objective spoke", () => {
    const rich = mod("Hull", "rich", 500, [{ stat: "Combat Power", amount: 40_000 }]);
    const v = moduleWhy(rich, plain, { pools: pools(8_000), turrets: battery, role: "Combat" });
    expect(v.better).toBe(true);
    expect(v.why).toMatch(/whole battery/);
  });

  it("names the TIE-BREAK when the objective could not separate them, and says it was silent", () => {
    const roomy = { ...mod("Hull", "roomy", 500), aspectSlots: 2 } as Item;
    const v = moduleWhy(roomy, plain, { pools: pools(8_000), turrets: battery, role: "Combat" });
    expect(v.better).toBe(true);
    expect(v.why).toContain("same battery score");
    expect(v.why).toMatch(/aspect slot/);
  });

  it("explains a REFUSAL too, so a row's absence has a reason as well", () => {
    const worse = mod("Hull", "worse", 500, [{ stat: "Combat Power", amount: -40_000 }]);
    const v = moduleWhy(worse, plain, { pools: pools(8_000), turrets: battery, role: "Combat" });
    expect(v.better).toBe(false);
    expect(v.why).toMatch(/whole battery/);
  });

  it("cannot disagree with `moduleBetter`, because that is one line over it", () => {
    const cands = [plain, mod("Hull", "a", 400), mod("Hull", "b", 900, [{ stat: "Precision", amount: 300 }]),
                   { ...mod("Hull", "c", 500), aspectSlots: 1 } as Item];
    const ctx = { pools: pools(8_000), turrets: battery, role: "Combat" as const };
    for (const c of cands) for (const e of cands)
      expect(moduleBetter(c, e, ctx)).toBe(moduleWhy(c, e, ctx).better);
  });
});
