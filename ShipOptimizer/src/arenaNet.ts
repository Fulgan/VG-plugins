// Inference for the arena's time-to-deplete model: the forward pass, and nothing else.
//
// The weights are trained offline and bundled here so scoring happens in the player's own browser
// against their own inventory. This file deliberately does NOT know how to build a feature row — that
// is the caller's job and it must match `featureNames` in the artifact — because a layout guessed here
// and a layout produced there would disagree silently.
//
// THE OUTPUT IS A COST. Seconds to deplete: lower is better, the opposite sign to every other score in
// this app. The artifact states this in `label.sense` and `assertCostSense` checks it, because a sign
// slip here inverts every suggestion and nothing else would catch it.

export interface ArenaNetArtifact {
  formatVersion: number;
  stamp: { gameVersion: string; escalationTier: number };
  label: { name: string; sense: string; lowerIsBetter: boolean; headOutput: string };
  featureNames: string[];
  standardizer: { mean: number[]; std: number[] };
  weights: Record<string, number[] | number[][]>;
  metrics?: Record<string, unknown>;
}

/** x * sigmoid(x) — the trunk's activation. Must match torch.nn.SiLU exactly. */
const silu = (v: number): number => v / (1 + Math.exp(-v));

function linear(input: number[], weight: number[][], bias: number[]): number[] {
  // torch stores a Linear as [out, in], so the row index is the OUTPUT unit. Reading it the other way
  // still produces numbers of a plausible magnitude, which is why the conformance cases include rows
  // several sigma out on a single column — a transpose survives an "it looks about right" check.
  const out = new Array<number>(weight.length);
  for (let o = 0; o < weight.length; o++) {
    const row = weight[o];
    let acc = bias[o];
    for (let i = 0; i < row.length; i++) acc += row[i] * input[i];
    out[o] = acc;
  }
  return out;
}

/** Throws unless the artifact still describes seconds as a cost. */
export function assertCostSense(a: ArenaNetArtifact): void {
  if (a.label?.sense !== "cost" || a.label?.lowerIsBetter !== true) {
    throw new Error(
      `arenaNet: artifact does not describe its label as a cost (${JSON.stringify(a.label)}). ` +
      `Refusing to score: every other number in this app reads the other way.`,
    );
  }
}

/**
 * Seconds to deplete for one feature row, in `featureNames` order.
 *
 * The row is RAW — the artifact's standardizer is applied here, so a caller cannot accidentally apply
 * it twice or not at all.
 */
export function predictSeconds(a: ArenaNetArtifact, row: number[]): number {
  if (row.length !== a.featureNames.length) {
    throw new Error(`arenaNet: ${row.length} features for ${a.featureNames.length} columns`);
  }
  const { mean, std } = a.standardizer;
  const x = row.map((v, i) => (v - mean[i]) / std[i]);

  const w = a.weights as Record<string, number[][] & number[]>;
  let h = linear(x, w["trunk.0.weight"] as unknown as number[][], w["trunk.0.bias"] as unknown as number[]);
  h = h.map(silu);
  h = linear(h, w["trunk.2.weight"] as unknown as number[][], w["trunk.2.bias"] as unknown as number[]);
  h = h.map(silu);
  const head = linear(h, w["seconds_head.weight"] as unknown as number[][],
                      w["seconds_head.bias"] as unknown as number[]);

  // The head predicts LOG seconds: a squared error on raw seconds would price a long fight's absolute
  // error far above a short fight's identical relative error, which inverts the ranking.
  return a.label.headOutput === "log" ? Math.exp(head[0]) : head[0];
}

/**
 * What the model says decided this estimate.
 *
 * Named `explainNet` rather than `explain`: `sellRules.ts` owns `explain` for the sell-rule surface,
 * and this repo's costliest recurring defect is one name meaning two things. They are unrelated —
 * that one narrates a rule, this one ablates a net — so the fix is a distinct name, not a shared
 * helper.
 *
 * Each feature is neutralised to its TRAINING MEAN — a standardised zero — and the estimate re-run. A
 * raw zero would assert something specific and usually absurd (a defender with no hull), and the net
 * would answer a question nobody asked.
 *
 * Features the target does not differ on are omitted: neutralising them changes nothing, and naming a
 * property the target has not got is exactly the actionable-but-wrong reason V48 forbids.
 */
export function explainNet(
  a: ArenaNetArtifact,
  row: number[],
  opts: { minSigma?: number } = {},
): { seconds: number; effects: { feature: string; deltaSeconds: number }[] } {
  const minSigma = opts.minSigma ?? 0.05;
  const seconds = predictSeconds(a, row);
  const { mean, std } = a.standardizer;
  const effects: { feature: string; deltaSeconds: number }[] = [];

  for (let i = 0; i < row.length; i++) {
    if (Math.abs((row[i] - mean[i]) / std[i]) < minSigma) continue;
    const probe = row.slice();
    probe[i] = mean[i];
    effects.push({ feature: a.featureNames[i], deltaSeconds: predictSeconds(a, probe) - seconds });
  }
  effects.sort((p, q) => Math.abs(q.deltaSeconds) - Math.abs(p.deltaSeconds));
  return { seconds, effects };
}
