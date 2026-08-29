// THE RANKED GOAL — "combat power over armor over precision".
//
// The property that makes this safe is the one that makes `officer.ts` safe: the keys are EXACT. A sign is
// computed once per candidate against the fitted build, so the vector is fixed and a lexicographic scan over it
// is a total order. The alternative — comparing two candidates pairwise with a band — is intransitive, which is
// V70's family and would let a hill-climb cycle. These tests pin that property first, because everything else
// about the design is only correct if it holds.
import { describe, expect, it } from "vitest";
import {
  defaultGoalOrder, goalCompare, goalDrops, goalKeysFor, goalPrefers, goalReadingOf, goalRefuses, goalSign,
  goalVector, GOAL_KEYS, GOAL_LABEL, OBJECTIVE_TIE,
  type GoalCandidate, type GoalKey, type GoalReading, type ShipPools,
  expectedCrit,
} from "./fleetDps";
import { cleanOrder } from "./GearTab";

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
    // A key with no measurement under it would be an opinion the model cannot check. Each of these is a pool the
    // game enumerates through `/stat/sources`, the battery score built from them, or a LAYER figure from
    // `setPowerByLayer` — the same call the panel's own Surface and Core rows print. What is NOT here is
    // a raw `mining`/`salvage` pool: ranking on one let a pooled substat authorise a plan whose throughput fell.
    expect([...GOAL_KEYS].sort()).toEqual([
      "armor", "combat", "dps", "hull",
      "miningBalanced", "miningCore", "miningSurface",
      "precision",
      "salvageBalanced", "salvageStructural", "salvageSurface",
      "shield",
    ]);
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

  it("defaults to the hull's own job, and to nothing at all without a role", () => {
    expect(combatShip).toEqual(["combat"]);
    expect(defaultGoalOrder("Mining", 4)).toEqual(["miningBalanced"]);
    expect(defaultGoalOrder("Salvaging", 4)).toEqual(["salvageBalanced"]);
    expect(defaultGoalOrder(null)).toEqual([]);
  });

  it("states no balanced default on a hull with one hardpoint", () => {
    // One gun serves one layer ∴ `min` is structurally 0 and a balanced default would be a goal no build on that
    // hull can meet. Which layer it should be is the player's call, not a default's.
    expect(defaultGoalOrder("Mining", 1)).toEqual([]);
    expect(defaultGoalOrder("Salvaging", 1)).toEqual([]);
    // Combat has no layers at all, so nothing about it changes.
    expect(defaultGoalOrder("Combat", 1)).toEqual(["combat"]);
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
    // A layer no gun on this hull reaches orders nothing rather than counting as a collapse to zero. Two
    // hardpoints, so the Mining default is the balanced key.
    expect(goalRefuses(defaultGoalOrder("Mining", 2),
                       { miningBalanced: undefined }, { miningBalanced: undefined })).toBeNull();
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

// THE DROP WARNING WATCHES THE LAYER THE HULL TANKS ON, and nothing else.
//
// This is a percentage problem, not a policy one. A drop is `(a - b) / a` with no absolute floor, and the layer a
// hull has no module for is whatever its guns happen to roll: measured on a real armour hull, shield read 10,646
// against armour 1,729,044, with two fitted turrets carrying 2,900 and 2,459 of that shield. Swapping either gun
// is a 23% to 27% "drop" in Shield and a fifth of a percent of the ship's survivability. A warning that fires
// there is a warning the player learns to ignore.
describe("which layer a drop warning is allowed to name", () => {
  // The figures above, as read off the ship.
  const NOW: GoalReading = { armor: 1_729_044, shield: 10_646, hull: 1_017_056, dps: 200_000 };
  const SWAPPED: GoalReading = { armor: 1_729_044, shield: 7_746, hull: 1_017_056, dps: 204_000 };

  it("says nothing about the vestigial layer on a hull that tanks on the other one", () => {
    expect(goalDrops(NOW, SWAPPED, 0.10, "armor")).toEqual([]);
  });

  it("names it when that IS the layer the hull tanks on", () => {
    const drops = goalDrops(NOW, SWAPPED, 0.10, "shield");
    expect(drops.map((d) => d.key)).toEqual(["shield"]);
    expect(drops[0].drop).toBeCloseTo(2_900 / 10_646, 6);
  });

  it("watches BOTH when the hull carries no defensive module at all", () => {
    // With nothing to be primary, either layer falling is worth saying.
    for (const tanks of [null, undefined]) {
      expect(goalDrops(NOW, SWAPPED, 0.10, tanks).map((d) => d.key)).toEqual(["shield"]);
    }
  });

  it("never gates hull, which every ship carries a kit for", () => {
    const gutted: GoalReading = { ...NOW, hull: 500_000 };
    for (const tanks of ["armor", "shield", null] as const) {
      expect(goalDrops(NOW, gutted, 0.10, tanks).some((d) => d.key === "hull")).toBe(true);
    }
  });

  it("still watches every non-layer key whatever the hull tanks on", () => {
    // The axis that matters is the one the plan happens to spend: a swap costing 4.9% of Combat Power on a combat
    // hull said nothing at all while a hull cap was busy refusing plans.
    const spent: GoalReading = { ...NOW, combat: 95_100 };
    const drops = goalDrops({ ...NOW, combat: 100_000 }, spent, 0.02, "armor");
    expect(drops.map((d) => d.key)).toEqual(["combat"]);
  });
});

// THE SPLIT ITSELF: which keys a hull is offered, and what a stored order from before it becomes.
describe("the layer keys", () => {
  it("offers an activity's keys only where the hull can serve it", () => {
    expect(goalKeysFor(4, ["Mining"])).toEqual(
      ["dps", "combat", "precision", "miningSurface", "miningCore", "miningBalanced", "hull", "armor", "shield"]);
    expect(goalKeysFor(4, ["Salvage"])).toEqual(
      ["dps", "combat", "precision", "salvageSurface", "salvageStructural", "salvageBalanced",
       "hull", "armor", "shield"]);
    // A hull doing both is offered both, in GOAL_KEYS order.
    expect(goalKeysFor(4, ["Mining", "Salvage"])).toEqual([...GOAL_KEYS]);
    // And a combat hull is offered no layer key at all, which is why the rank floor covers it instead.
    expect(goalKeysFor(4, [])).toEqual(["dps", "combat", "precision", "hull", "armor", "shield"]);
  });

  it("withholds balanced on a single hardpoint but keeps the layer choice", () => {
    const one = goalKeysFor(1, ["Mining", "Salvage"]);
    expect(one).not.toContain("miningBalanced");
    expect(one).not.toContain("salvageBalanced");
    expect(one).toContain("miningSurface");
    expect(one).toContain("miningCore");
    expect(one).toContain("salvageStructural");
  });

  it("reads balanced as the bottleneck, and absent where a layer is unreached", () => {
    const r = goalReadingOf({ poolCombatPower: 1, precisionDivisor: 1 } as ShipPools, undefined, undefined,
                            { miningSurface: 9_000, miningCore: 4_000 });
    expect(r.miningBalanced).toBe(4_000);
    // A layer no gun covers reads absent, and balanced cannot be computed from half a pair — absent orders
    // nothing, which is what keeps an unreachable layer legible instead of scoring 0.
    const half = goalReadingOf({ poolCombatPower: 1, precisionDivisor: 1 } as ShipPools, undefined, undefined,
                               { miningSurface: 9_000, miningCore: null });
    expect(half.miningSurface).toBe(9_000);
    expect(half.miningCore).toBeUndefined();
    expect(half.miningBalanced).toBeUndefined();
  });

  it("maps a stored order written before the split", () => {
    // MAPPED, not dropped: dropping would silently un-state a goal the player set, and `balanced` is what the
    // derived target already was for a hull with mixed slots.
    expect(cleanOrder(["mining", "armor"])).toEqual(["miningBalanced", "armor"]);
    expect(cleanOrder(["salvage"])).toEqual(["salvageBalanced"]);
    // A key that never existed is still dropped, and a duplicate is still collapsed.
    expect(cleanOrder(["mining", "miningBalanced", "nonsense"])).toEqual(["miningBalanced"]);
  });
});
