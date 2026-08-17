import { describe, it, expect } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { predictSeconds, explainNet, assertCostSense, type ArenaNetArtifact } from "./arenaNet";

// Conformance for the arena net's forward pass. Two implementations of the same arithmetic that are
// never compared WILL drift, and the drift is silent — both sides produce plausible seconds and gear
// is ranked by the wrong one.
//
// The artifact and its expected outputs are produced by the Python trainer and are not tracked here, so
// an absent file SKIPS. A bare `npm test` runs every *.test.* under src/, and a suite that reddens
// because a sibling repo has not exported anything is one people learn to ignore.

const ART = process.env.ARENA_NET ?? resolve(__dirname, "../../../arena/out/big-net.json");
const VEC = process.env.ARENA_VECTORS ?? resolve(__dirname, "../../../arena/out/inference-vectors.json");
const have = existsSync(ART) && existsSync(VEC);

const load = <T,>(p: string): T => JSON.parse(readFileSync(p, "utf-8")) as T;

describe("arenaNet", () => {
  it("refuses an artifact that does not describe its label as a cost", () => {
    // Input-free, so an import break or a signature change still fails when the rest is skipped. The
    // sign is the one error nothing downstream would catch: it inverts every suggestion silently.
    const fake = { label: { name: "x", sense: "value", lowerIsBetter: false, headOutput: "log" } };
    expect(() => assertCostSense(fake as ArenaNetArtifact)).toThrow(/cost/);
  });

  it.skipIf(!have)("reproduces every conformance case from the Python net", () => {
    const art = load<ArenaNetArtifact>(ART);
    const vec = load<{
      featureNames: string[];
      relativeTolerance: number;
      cases: { features: number[]; expectedSeconds: number }[];
    }>(VEC);

    assertCostSense(art);
    expect(art.featureNames).toEqual(vec.featureNames);
    expect(vec.cases.length).toBeGreaterThan(50);

    let worst = 0;
    for (const c of vec.cases) {
      const got = predictSeconds(art, c.features);
      const rel = Math.abs(got - c.expectedSeconds) / Math.max(1e-12, Math.abs(c.expectedSeconds));
      worst = Math.max(worst, rel);
    }
    // Stated in the fixture rather than chosen here: float32 weights in one language against float64
    // arithmetic in another cannot be bit-identical, and pretending otherwise makes the check unusable.
    expect(worst).toBeLessThan(vec.relativeTolerance);
  });

  it.skipIf(!have)("omits features the target does not differ on, and ranks the rest by effect", () => {
    const art = load<ArenaNetArtifact>(ART);

    // An exactly-average target has nothing to explain. Reporting a feature here would name a property
    // the target does not differ on, which is the wrong-but-actionable reason V48 forbids.
    const average = art.standardizer.mean.slice();
    expect(explainNet(art, average).effects).toEqual([]);

    // Move one column well off the mean and it must be the top mover.
    const i = art.featureNames.indexOf("defender.hull_log");
    expect(i).toBeGreaterThanOrEqual(0);
    const row = average.slice();
    row[i] += 5 * art.standardizer.std[i];
    const { effects } = explainNet(art, row);
    expect(effects.length).toBeGreaterThan(0);
    expect(effects[0].feature).toBe("defender.hull_log");
  });

  it.skipIf(!have)("neutralises to the training mean, not to a raw zero", () => {
    // A raw zero asserts a defender with no hull. The standardised zero is the population average,
    // which is what "this input told the net nothing" has to mean.
    const art = load<ArenaNetArtifact>(ART);
    const i = art.featureNames.indexOf("defender.hull_log");
    const row = art.standardizer.mean.slice();
    row[i] += 3 * art.standardizer.std[i];

    const { seconds, effects } = explainNet(art, row);
    const moved = effects.find((e) => e.feature === "defender.hull_log")!.deltaSeconds;
    const atMean = predictSeconds(art, art.standardizer.mean);
    expect(seconds + moved).toBeCloseTo(atMean, 6);
  });
});
