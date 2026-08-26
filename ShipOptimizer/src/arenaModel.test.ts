// A MODE THAT CANNOT ANSWER MUST NOT BE SELECTABLE.
//
// The `simple`-mode report is the precedent: it proposed swaps, offered Apply, and its own panel admitted it
// had no model behind it — a plan with nothing under it is indistinguishable from one with everything under
// it. The third ranking is the same risk with better branding, so these pin the refusals rather than the
// forward pass (which is `arenaNet.test.ts`, and skips without an artifact).
import { describe, it, expect, afterEach } from "vitest";
import { modelBlock, MODEL_BLOCK_TEXT, scoreFromSeconds, comparePredictions,
         featureNames, secondsForSet, resetArtifactCache, invertedAxes, clampToTrained,
         nearTieBandOf, nearTieBand, preference, preferenceWithin, NEAR_TIE_TRUST } from "./arenaModel";
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

  it("does not judge an axis the artifact itself calls unreadable alone", () => {
    // The crit columns are one effect split across several, so the leftovers land wherever they fit and a single
    // member's sign says nothing about the effect. Refusing an honest artifact for that is the same failure as
    // passing a dishonest one, one direction over.
    const art = withAblation({ ...HEALTHY, "battery.mean_crit_chance": +0.69 });
    (art.metrics as Record<string, unknown>).ablationUnreportableAlone = ["battery.mean_crit_chance"];
    expect(invertedAxes(art)).toEqual([]);
  });

  it("does not judge a column the training set left constant", () => {
    const art = withAblation({ ...HEALTHY, "battery.total_power_log": +2.2 });
    (art.metrics as Record<string, unknown>).constantInTraining = ["battery.total_power_log"];
    expect(invertedAxes(art)).toEqual([]);
  });

  it("prefers the GROUPED ablation, which is the reportable one", () => {
    const art = withAblation({ ...HEALTHY, "defender.hull_log": -13.7 });   // the ungrouped map is wrong
    (art.metrics as Record<string, unknown>).ablationGrouped = HEALTHY;     // the reportable one is not
    expect(invertedAxes(art)).toEqual([]);
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

// A GAP THE MODEL CANNOT CALL IS NOT A PREFERENCE.
//
// Held-out pairs inside 5% are ordered at 0.495, with every bootstrap band spanning zero, while the same nets
// order wide gaps at 85% to 93%. The floor for acting on a gain is 1%, so without a silence band every swap this
// mode would suggest comes out of the range where it is a coin flip.
const withPairwise = (p: Record<string, unknown> | undefined): ArenaNetArtifact => ({
  formatVersion: 1,
  label: { name: "seconds", sense: "cost", lowerIsBetter: true, headOutput: "seconds" },
  featureNames: [], standardizer: { mean: [], std: [] }, weights: {},
  metrics: p ? { pairwiseAccuracy: p } : {},
} as unknown as ArenaNetArtifact);

describe("the near-tie band comes from the artifact, and both halves of it are read", () => {
  it("takes the declared fraction where the accuracy inside it is a coin flip", () => {
    expect(nearTieBandOf(withPairwise({ nearTieFraction: 0.05, nearTie: 0.4954, allPairs: 0.9159 }))).toBe(0.05);
  });

  it("collapses the band to zero where the artifact evidences it can order close pairs", () => {
    // Suppressing them then would discard an ability the file measured. The threshold is competence, so it is
    // the accuracy that decides and never the sample size.
    expect(nearTieBandOf(withPairwise({ nearTieFraction: 0.05, nearTie: 0.81 }))).toBe(0);
    expect(nearTieBandOf(withPairwise({ nearTieFraction: 0.05, nearTie: NEAR_TIE_TRUST }))).toBe(0);
    expect(nearTieBandOf(withPairwise({ nearTieFraction: 0.05, nearTie: NEAR_TIE_TRUST - 0.001 }))).toBe(0.05);
  });

  it("keeps the band where the accuracy in it was never measured", () => {
    // Unmeasured and competent are different claims, and only one of them earns the benefit of the doubt.
    expect(nearTieBandOf(withPairwise({ nearTieFraction: 0.05, nearTie: null }))).toBe(0.05);
    expect(nearTieBandOf(withPairwise({ nearTieFraction: 0.05 }))).toBe(0.05);
  });

  it("returns null for an artifact that states no band, so the loader can refuse it", () => {
    expect(nearTieBandOf(withPairwise(undefined))).toBeNull();
    expect(nearTieBandOf(withPairwise({ allPairs: 0.93 }))).toBeNull();
    expect(nearTieBandOf(withPairwise({ nearTieFraction: Number.NaN }))).toBeNull();
    // Every pre-v22 artifact lands here, which is the point: the reason a mode is dark must be nameable.
    expect(MODEL_BLOCK_TEXT["no-band"]).toMatch(/close together/i);
  });
});

describe("a swap inside the band gets no answer rather than a coin flip", () => {
  it("says nothing about a pair the model orders no better than chance", () => {
    // 100s against 103s is 3%, inside a 5% band: the tie-break the other rankings use decides instead.
    expect(preferenceWithin(0.05, 103, 100)).toBe("no-preference");
    expect(preferenceWithin(0.05, 100, 103)).toBe("no-preference");
    // Exactly at the edge is still silence — the band is measured as `< fraction` and the edge is unmeasured.
    expect(preferenceWithin(0.05, 105, 100)).toBe("no-preference");
  });

  it("answers a gap wider than the band, in the direction fewer seconds points", () => {
    expect(preferenceWithin(0.05, 80, 100)).toBe("candidate");
    expect(preferenceWithin(0.05, 100, 80)).toBe("incumbent");
  });

  it("measures the gap against the SMALLER prediction, matching how the band was measured", () => {
    // 100 -> 106 is 6% of 100 and 5.66% of 106: on the mean it would fall inside the band and be suppressed.
    expect(preferenceWithin(0.055, 106, 100)).toBe("incumbent");
    expect(preferenceWithin(0.055, 100, 106)).toBe("candidate");
  });

  it("is antisymmetric wherever it has an opinion, so the answer cannot depend on argument order", () => {
    for (const [a, b] of [[80, 100], [100, 80], [12, 400], [400, 12]] as const) {
      const one = preferenceWithin(0.05, a, b), other = preferenceWithin(0.05, b, a);
      expect(one).not.toBe(other);
    }
  });

  it("refuses to prefer anything on a prediction that is not a positive time", () => {
    // A zero or negative second reading is not a faster build, it is a broken row.
    expect(preferenceWithin(0.05, 0, 100)).toBe("no-preference");
    expect(preferenceWithin(0.05, -5, 100)).toBe("no-preference");
    expect(preferenceWithin(0.05, Number.NaN, 100)).toBe("no-preference");
    expect(preferenceWithin(0.05, Number.POSITIVE_INFINITY, 100)).toBe("no-preference");
  });

  it("with no band still answers, and an exact tie is silence at any band", () => {
    expect(preferenceWithin(0, 99.9, 100)).toBe("candidate");
    expect(preferenceWithin(0, 100, 100)).toBe("no-preference");
    // Nothing is bundled in this build, so the live entry point has no band to apply and still cannot invert.
    expect(nearTieBand()).toBe(0);
    expect(preference(80, 100)).toBe("candidate");
    expect(preference(100, 100)).toBe("no-preference");
  });
});

describe("clampToTrained — containment for a column the net never learned", () => {
  const ART = {
    featureNames: ["a", "b", "c"],
    metrics: { featureRange: { a: [0, 10], b: [-1, 1] } },
  } as unknown as ArenaNetArtifact;

  it("holds a value inside the range the net was trained on", () => {
    expect(clampToTrained(ART, [999, 5, 42])).toEqual([10, 1, 42]);
    expect(clampToTrained(ART, [-999, -5, 42])).toEqual([0, -1, 42]);
  });

  it("may only ever DECLINE: an in-range value passes through untouched", () => {
    // A guard that adjusted a legal input would be a second model nobody could see.
    const row = [4, 0.25, 7];
    expect(clampToTrained(ART, row)).toEqual(row);
  });

  it("leaves a column with no declared range alone", () => {
    // `c` has no range: inventing one would assert the very thing that is missing.
    expect(clampToTrained(ART, [5, 0, 1e9])[2]).toBe(1e9);
  });

  it("passes an artifact reporting no ranges straight through", () => {
    const bare = { featureNames: ["a"], metrics: {} } as unknown as ArenaNetArtifact;
    expect(clampToTrained(bare, [1e9])).toEqual([1e9]);
  });
});
