// A MODE THAT CANNOT ANSWER MUST NOT BE SELECTABLE.
//
// The `simple`-mode report is the precedent: it proposed swaps, offered Apply, and its own panel admitted it
// had no model behind it — a plan with nothing under it is indistinguishable from one with everything under
// it. The third ranking is the same risk with better branding, so these pin the refusals rather than the
// forward pass (which is `arenaNet.test.ts`, and skips without an artifact).
import { describe, it, expect, afterEach } from "vitest";
import { modelBlock, MODEL_BLOCK_TEXT, scoreFromSeconds, comparePredictions,
         featureNames, secondsForSet, resetArtifactCache, invertedAxes } from "./arenaModel";
import type { ArenaNetArtifact } from "./arenaNet";

afterEach(() => resetArtifactCache());

describe("the model refuses rather than guesses", () => {
  it("is blocked with no artifact bundled, whatever the role", () => {
    // This build ships none, so every role is blocked for that reason FIRST — a missing model is not a
    // property of the ship.
    expect(modelBlock("Combat")).toBe("no-artifact");
    expect(modelBlock("Salvaging")).toBe("no-artifact");
    expect(MODEL_BLOCK_TEXT["no-artifact"]).toMatch(/no model/i);
  });

  it("throws rather than returning a number when asked to score with no artifact", () => {
    // A silent 0 here would rank every candidate equal and read as "the model has no opinion".
    expect(() => secondsForSet([1, 2, 3])).toThrow(/no artifact/i);
    expect(featureNames()).toEqual([]);
  });

  it("names every reason it can refuse, so the button can say which", () => {
    for (const k of ["no-artifact", "not-combat", "bad-sense"] as const) {
      expect(MODEL_BLOCK_TEXT[k]).toBeTruthy();
    }
    // The combat-only reason must say what it is about, since a player on a salvage hull sees it most.
    expect(MODEL_BLOCK_TEXT["not-combat"]).toMatch(/combat/i);
  });
});

describe("seconds are a cost, and the conversion happens once", () => {
  it("turns a time into a rate, so bigger is better and ratios still mean something", () => {
    expect(scoreFromSeconds(10)).toBeCloseTo(0.1, 9);
    // Half the time is twice the throughput — the property a negation would lose.
    expect(scoreFromSeconds(5) / scoreFromSeconds(10)).toBeCloseTo(2, 9);
  });

  it("refuses to invent a score from a time that is not one", () => {
    expect(scoreFromSeconds(0)).toBe(0);
    expect(scoreFromSeconds(-3)).toBe(0);
    expect(scoreFromSeconds(Number.NaN)).toBe(0);
    expect(scoreFromSeconds(Number.POSITIVE_INFINITY)).toBe(0);
  });

  it("compares two absolute predictions, which is antisymmetric by construction", () => {
    // V70's pair guard exists for a comparison against a baseline the compared items move; this is not that
    // shape, and the test says so in the only way that matters — a(b) == -b(a), for any pair.
    expect(comparePredictions(8, 10)).toBeLessThan(0);        // candidate deplete faster ⇒ preferred
    expect(comparePredictions(10, 8)).toBeGreaterThan(0);
    expect(comparePredictions(8, 10)).toBe(-comparePredictions(10, 8));
    expect(comparePredictions(9, 9)).toBe(0);
  });
});

// A DECLARED LABEL AND A LEARNED DIRECTION ARE DIFFERENT CLAIMS.
//
// `assertCostSense` reads what the artifact SAYS its output is. It would pass a net whose label is honest and
// whose coefficients are inverted — and one was: mega-crit came out making fights LONGER, consistently, where
// the game's own cascade takes 0 -> 3 points from 10.18s to 7.09s. A wrong label is a typo; a wrong axis ranks
// backwards while looking healthy, so it is refused at load.
const withAblation = (ablation: Record<string, number> | undefined): ArenaNetArtifact => ({
  formatVersion: 1,
  stamp: { gameVersion: "0.8.1.24", escalationTier: 0 },
  label: { name: "seconds", sense: "cost", lowerIsBetter: true, headOutput: "seconds" },
  featureNames: [], standardizer: { mean: [], std: [] }, weights: {},
  metrics: ablation ? { ablation } : {},
} as unknown as ArenaNetArtifact);

const HEALTHY = {
  "skills.mega_crit_points": -0.9,   // more mega-crit ⇒ shorter fight
  "defender.hull_log": 13.7,         // bigger hull ⇒ longer fight
  "battery.mean_crit_chance": -1.3,
  "battery.total_power_log": -0.4,
};

describe("an artifact that ranks backwards is refused, not scored", () => {
  it("accepts a model whose known axes all point the right way", () => {
    expect(invertedAxes(withAblation(HEALTHY))).toEqual([]);
  });

  it("names the axis that is inverted — the real failure, with its real sign", () => {
    // The measured defect: mega-crit reported as making fights LONGER.
    const bad = withAblation({ ...HEALTHY, "skills.mega_crit_points": +0.749 });
    expect(invertedAxes(bad)).toEqual(["skills.mega_crit_points"]);
  });

  it("catches a hull axis pointing the wrong way too, so the check is not one special case", () => {
    expect(invertedAxes(withAblation({ ...HEALTHY, "defender.hull_log": -13.7 })))
      .toEqual(["defender.hull_log"]);
  });

  it("refuses an artifact that reports NO ablation at all", () => {
    // A check that exists and a check that ran are different things. Silence is not a pass.
    expect(invertedAxes(withAblation(undefined))).toEqual(["<no ablation reported>"]);
  });

  it("does not judge an axis the artifact did not measure", () => {
    // Absent and zero are both "not measured" — judging them would refuse a healthy model for being quiet.
    const partial = withAblation({ "defender.hull_log": 13.7, "skills.mega_crit_points": 0 });
    expect(invertedAxes(partial)).toEqual([]);
  });
});
