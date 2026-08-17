// THE RANKED GOAL — "combat power over armor over precision".
//
// The property that makes this safe is the one that makes `officer.ts` safe: the keys are EXACT. A sign is
// computed once per candidate against the fitted build, so the vector is fixed and a lexicographic scan over it
// is a total order. The alternative — comparing two candidates pairwise with a band — is intransitive, which is
// V70's family and would let a hill-climb cycle. These tests pin that property first, because everything else
// about the design is only correct if it holds.
import { describe, expect, it } from "vitest";
import {
  defaultGoalOrder, goalCompare, goalPrefers, goalRefuses, goalSign, goalVector, GOAL_KEYS, GOAL_LABEL, OBJECTIVE_TIE,
  type GoalCandidate, type GoalKey, type GoalReading,
  expectedCrit,
} from "./fleetDps";

const ORDER: GoalKey[] = ["combat", "armor", "precision"];
const build = (combat: number, armor: number, precision: number): GoalReading => ({ combat, armor, precision });
const FITTED = build(100_000, 50_000, 20_000);
const cand = (r: GoalReading, scalar = 0): GoalCandidate =>
  ({ signs: goalVector(ORDER, r, FITTED), scalar });

describe("a sign is exact, and taken against the fitted build", () => {
  it("reads better, same and worse — three states, because a build can regress", () => {
    expect(goalSign(110, 100)).toBe(1);
    expect(goalSign(90, 100)).toBe(-1);
    expect(goalSign(100, 100)).toBe(0);
  });

  it("calls a difference inside the silence band `same`", () => {
    // OBJECTIVE_TIE is the band this objective already declines to have an opinion below — an INTRA-stat
    // judgement, which is answerable, unlike the inter-stat rate a weight would need.
    expect(goalSign(100 * (1 + OBJECTIVE_TIE / 2), 100)).toBe(0);
    expect(goalSign(100 * (1 - OBJECTIVE_TIE / 2), 100)).toBe(0);
    expect(goalSign(100 * (1 + OBJECTIVE_TIE * 2), 100)).toBe(1);
  });

  it("orders nothing on a key either side cannot report", () => {
    expect(goalSign(undefined, 100)).toBe(0);
    expect(goalSign(100, undefined)).toBe(0);
    expect(goalSign(NaN, 100)).toBe(0);
  });

  it("treats a key the fitted build reads as zero as improvable but not regressable", () => {
    expect(goalSign(10, 0)).toBe(1);
    expect(goalSign(0, 0)).toBe(0);
  });
});

describe("the order is total, which a banded pairwise comparator would not be", () => {
  it("is TRANSITIVE across a chain that a pairwise band would break", () => {
    // The trap: with a band applied BETWEEN candidates, A~B and B~C while A<C. Against a fixed reference every
    // candidate gets its own exact sign, so the chain cannot form.
    const step = FITTED.combat! * OBJECTIVE_TIE * 0.6;      // each gap alone is inside the band
    const A = cand(build(FITTED.combat!, 50_000, 20_000));
    const B = cand(build(FITTED.combat! + step, 50_000, 20_000));
    const C = cand(build(FITTED.combat! + step * 2, 50_000, 20_000));
    const ab = Math.sign(goalCompare(A, B)), bc = Math.sign(goalCompare(B, C)), ac = Math.sign(goalCompare(A, C));
    if (ab === 0 && bc === 0) expect(ac).toBe(0);           // ties must chain, or sort is undefined
    expect([ab, bc, ac].every((x) => Number.isFinite(x))).toBe(true);
  });

  it("is ANTISYMMETRIC for every pair of candidates", () => {
    const set = [
      cand(build(120_000, 40_000, 20_000), 5),
      cand(build(100_000, 60_000, 20_000), 4),
      cand(build(100_000, 50_000, 25_000), 3),
      cand(build(90_000, 90_000, 90_000), 2),
      cand(FITTED, 1),
    ];
    for (const a of set) for (const b of set)
      // `|| 0` normalises the -0 that Math.sign yields for a self-comparison; Object.is separates them.
      expect(Math.sign(goalCompare(a, b)) || 0).toBe(-Math.sign(goalCompare(b, a)) || 0);
  });

  it("sorts deterministically, which an intransitive comparator cannot promise", () => {
    const set = [cand(build(90_000, 99_000, 20_000), 1), cand(build(120_000, 10_000, 20_000), 2),
                 cand(build(100_000, 60_000, 20_000), 3)];
    const once = [...set].sort(goalCompare).map((c) => c.signs.join(""));
    const again = [...set].reverse().sort(goalCompare).map((c) => c.signs.join(""));
    expect(once).toEqual(again);
  });
});

describe("the order is the player's", () => {
  it("refuses a plan that regresses the TOP key, whatever it does for the rest", () => {
    // The reported case: combat power down, armor and precision up, and the tab offered it.
    const worseCombat = cand(build(91_000, 99_000, 40_000), 999);
    expect(goalPrefers(worseCombat)).toBe(false);
    expect(goalCompare(worseCombat, cand(FITTED))).toBeGreaterThan(0);
  });

  it("reads ARMOR only where combat power came out the same", () => {
    const sameCombatMoreArmor = cand(build(100_000, 60_000, 20_000));
    expect(goalPrefers(sameCombatMoreArmor)).toBe(true);
    // …and a combat gain outranks any armor gain, without anyone saying how much a hull point is worth.
    const moreCombatLessArmor = cand(build(120_000, 10_000, 20_000));
    expect(goalCompare(moreCombatLessArmor, sameCombatMoreArmor)).toBeLessThan(0);
  });

  it("reorders when the player reorders", () => {
    const armourFirst: GoalKey[] = ["armor", "combat", "precision"];
    const c = (r: GoalReading) => ({ signs: goalVector(armourFirst, r, FITTED) });
    const moreArmourLessCombat = c(build(90_000, 60_000, 20_000));
    expect(goalCompare(moreArmourLessCombat, c(build(120_000, 10_000, 20_000)))).toBeLessThan(0);
  });
});

describe("incumbency, copied from the officer comparator", () => {
  it("keeps the fitted build when a candidate ties every key", () => {
    const tie = cand(build(100_000, 50_000, 20_000), 500);
    expect(goalPrefers(tie)).toBe(false);
    expect(goalCompare(tie, { signs: [0, 0, 0], fitted: true })).toBeGreaterThan(0);
  });

  it("still displaces it for a real gain on a ranked key", () => {
    expect(goalPrefers(cand(build(120_000, 50_000, 20_000)))).toBe(true);
  });

  it("separates two candidates with the SAME vector by magnitude, not by nothing", () => {
    const small = cand(build(101_000, 50_000, 20_000), 10);
    const large = cand(build(140_000, 50_000, 20_000), 40);
    expect(small.signs).toEqual(large.signs);
    expect(goalCompare(large, small)).toBeLessThan(0);
  });
});

describe("the key list", () => {
  it("offers only figures the reconciler covers", () => {
    // A key with no measurement under it would be an opinion the model cannot check — every one of these is a
    // pool the game enumerates through `/stat/sources`, or the battery score built from them.
    expect([...GOAL_KEYS].sort()).toEqual(
      ["armor", "combat", "dps", "hull", "mining", "precision", "salvage", "shield"]);
  });
});

// THE VETO, on the two builds that prompted it — measured, not invented.
//
// Aquila "Momentum": the tab offered a plan whose Combat Power FELL 214,280 → 203,180 while it claimed a stronger
// battery, and the user's words were "Neither makes any sense". Varyag: a plan that cuts draw enough to recover
// the reactor bracket, where Combat Power RISES — which must still be offered, or the goal has broken the
// optimizer rather than corrected it.
describe("the veto refuses a regression and nothing else", () => {
  const combatShip = defaultGoalOrder("Combat");

  it("defaults to the hull's own pool, and to nothing at all without a role", () => {
    expect(combatShip).toEqual(["combat"]);
    expect(defaultGoalOrder("Mining")).toEqual(["mining"]);
    expect(defaultGoalOrder(null)).toEqual([]);
  });

  it("refuses the Aquila plan: Combat Power fell", () => {
    const fitted = { combat: 214_280 }, planned = { combat: 203_180 };
    expect(goalRefuses(combatShip, fitted, planned)).toBe("combat");
    expect(GOAL_LABEL[goalRefuses(combatShip, fitted, planned)!]).toBe("Combat Power");
  });

  it("allows the Varyag plan: Combat Power rose, bracket recovered", () => {
    expect(goalRefuses(combatShip, { combat: 214_280 }, { combat: 237_569 })).toBeNull();
  });

  it("stays out of the way when the ship has no role to rank on", () => {
    expect(goalRefuses([], { combat: 214_280 }, { combat: 1 })).toBeNull();
  });

  it("stops at the FIRST ranked key — a gain there is not overruled from below", () => {
    const order: GoalKey[] = ["combat", "precision"];
    // Combat up, precision down: the order says combat decides, so this is allowed.
    expect(goalRefuses(order, { combat: 100, precision: 100 }, { combat: 120, precision: 10 })).toBeNull();
    // Combat down: refused before precision is read at all, however good it is.
    expect(goalRefuses(order, { combat: 100, precision: 100 }, { combat: 90, precision: 999 })).toBe("combat");
  });

  it("is silent on a key the objective cannot read for this ship", () => {
    // A mining pool the bridge never reported orders nothing rather than counting as a collapse to zero.
    expect(goalRefuses(defaultGoalOrder("Mining"), { mining: undefined }, { mining: undefined })).toBeNull();
  });
});

// MEGA-CRIT SATURATES AT 3, and the ceiling is in the game's own arithmetic rather than in taste.
//
// `CalculateDamage` needs the previous crit AND a roll at half its chance for each further one, so the k-th
// crit costs `c^k * 2^-(k(k-1)/2)` — super-exponentially unlikely. Past three the term is under the noise on
// any measurement of it. Effective mega-crit runs 3 -> 5 across the player's ships, so that entire range is
// flat: a point bought above 3 buys nothing, and an optimizer pricing points linearly would trade real
// Combat Power for it.
//
// Confirmed on three paths that share no code: this closed form, a 4M-draw Monte Carlo of the decompiled
// loop, and the arena port's own CalculateDamage measured over 4M draws per cell (2.57617 vs 2.5762).
describe("the mega-crit cascade stops paying", () => {
  const C = 0.571, CD = 0.406;

  it("is flat from 3 points up", () => {
    const at = (m: number) => expectedCrit(C, CD, m);
    expect(at(4) / at(3) - 1).toBeLessThan(0.002);   // +0.11%
    expect(at(5) / at(4) - 1).toBeLessThan(0.0001);  // +0.004%
  });

  it("still rises steeply below 3, so the ceiling is a ceiling and not a floor", () => {
    const at = (m: number) => expectedCrit(C, CD, m);
    expect(at(1) / at(0) - 1).toBeGreaterThan(0.25);
    expect(at(2) / at(1) - 1).toBeGreaterThan(0.07);
  });

  it("keeps paying for crit CHANCE, which is the easy thing to conflate with it", () => {
    // ~1.8% of damage per crit point at c ~ 0.57 — the cascade COUNT saturates, the chance does not.
    const gain = expectedCrit(0.585, CD, 3) / expectedCrit(0.571, CD, 3) - 1;
    expect(gain).toBeGreaterThan(0.02);
    expect(gain).toBeLessThan(0.03);
  });
});
