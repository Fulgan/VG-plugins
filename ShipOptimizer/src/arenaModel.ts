// THE CLIENT SIDE OF THE ARENA MODEL: is there a model, may this ship use it, and what is a
// prediction worth as a score. The forward pass itself is `arenaNet.ts` and stays there.
//
// WHY THIS FILE EXISTS AT ALL rather than the tab calling `predictSeconds` directly: the label is a COST —
// seconds to deplete, lower is better — and it is the only figure in this app that reads that way. Every
// other score is a utility, `worthSwitching`, `MIN_GAIN` and `rankGt` all assume bigger is better, so the
// conversion has to happen at ONE owner or a sign slip inverts every suggestion in a place no test looks.
import { assertCostSense, predictSeconds, type ArenaNetArtifact } from "./arenaNet";

// Compiled to nothing while no artifact is bundled, and picks one up with no code change when it lands.
// A static import of a file that does not exist fails the BUILD, which would make "the trainer has not
// shipped weights yet" a broken app rather than a missing feature.
const BUNDLED = import.meta.glob("./arenaNet.artifact.json", { eager: true, import: "default" }) as
  Record<string, ArenaNetArtifact>;

/** Why the model cannot be used here, in the player's terms. `null` when it can. */
export type ModelBlock = "no-artifact" | "not-combat" | "bad-sense" | "bad-axis";

let cached: ArenaNetArtifact | null | undefined;
let sense: "ok" | "bad" | "axis" = "ok";

/**
 * The bundled artifact, or null.
 *
 * `assertCostSense` runs HERE, once, on load — not per score. A prediction is a number and a number that
 * means the opposite of what the caller assumes still ranks, still looks plausible, and is wrong in every
 * row at once. Refusing the whole mode is the only failure mode worth having.
 */
export function artifact(): ArenaNetArtifact | null {
  if (cached !== undefined) return cached;
  const first = Object.values(BUNDLED)[0];
  if (!first) { cached = null; return cached; }
  try { assertCostSense(first); } catch { sense = "bad"; cached = null; return cached; }
  // The second gate, and it fails the artifact rather than the score: a net that ranks backwards on a settled
  // axis is worse than no net, because every suggestion it makes looks considered.
  const bad = invertedAxes(first);
  if (bad.length) { sense = "axis"; cached = null; return cached; }
  sense = "ok"; cached = first;
  return cached;
}

/**
 * Whether this ship may be ranked by the model, and why not when it may not.
 *
 * COMBAT ONLY, by the same argument makes for the tier ordering: the label is seconds against a
 * combat profile, so it is not comparable with a mining or salvage score and a hull ranked on one of those
 * must never see it.
 */
export function modelBlock(role: string | null | undefined): ModelBlock | null {
  if (sense === "bad") return "bad-sense";
  if (sense === "axis") return "bad-axis";
  if (!artifact()) return "no-artifact";
  if ((role ?? "").toLowerCase() !== "combat") return "not-combat";
  return null;
}

export const MODEL_BLOCK_TEXT: Record<ModelBlock, string> = {
  "no-artifact": "No model is bundled in this build yet — nothing to rank with.",
  "not-combat": "The model predicts seconds against a COMBAT target, so it cannot rank a mining or salvage hull.",
  "bad-sense": "The bundled model does not describe its output as a cost. Refusing to rank rather than risk inverting every suggestion.",
  "bad-axis": "The bundled model moves the wrong way on an axis whose direction is known from the game's own arithmetic. Refusing to rank.",
};

/**
 * Axes whose DIRECTION is settled by the game's arithmetic, not by the training set.
 *
 * Each entry is the sign the label must move in when the feature RISES. Seconds is a cost, so a feature that
 * makes a fight shorter must have a NEGATIVE ablation delta.
 *
 * Why this exists beside `assertCostSense`: that check reads the artifact's declared LABEL and would pass a net
 * whose label is honest and whose coefficients are inverted. A trained model did exactly that — mega-crit came
 * out making fights LONGER, consistently and across the crit range, where `CalculateDamage`'s cascade makes
 * 0 → 3 points go 10.18s → 7.09s. A wrong label is a typo; a wrong axis is a model that ranks backwards while
 * looking healthy, and the one place it can be caught cheaply is the moment it loads.
 */
const KNOWN_AXIS_SIGN: Record<string, -1 | 1> = {
  // More mega-crit points ⇒ more damage per shot ⇒ fewer seconds. Saturates past 3 but never reverses.
  "skills.mega_crit_points": -1,
  // A bigger hull takes longer to deplete. The largest axis in the model and the easiest sanity check.
  "defender.hull_log": 1,
  // More crit chance ⇒ more damage ⇒ fewer seconds.
  "battery.mean_crit_chance": -1,
  // More total power ⇒ fewer seconds.
  "battery.total_power_log": -1,
};

/**
 * Every known axis the artifact's own ablation says it moves the wrong way.
 *
 * Reads `metrics.ablation` — a map of feature name to the label delta produced by raising that feature. An
 * artifact that does not report ablation is NOT trusted silently: `artifact()` refuses it, because the check
 * existing and the check running are different things and only one of them is worth anything.
 */
export function invertedAxes(a: ArenaNetArtifact): string[] {
  const abl = (a.metrics as { ablation?: Record<string, number> } | undefined)?.ablation;
  if (!abl) return ["<no ablation reported>"];
  const bad: string[] = [];
  for (const [name, want] of Object.entries(KNOWN_AXIS_SIGN)) {
    const d = abl[name];
    if (typeof d !== "number" || !Number.isFinite(d) || d === 0) continue;  // not measured ⇒ not judged
    if (Math.sign(d) !== want) bad.push(name);
  }
  return bad;
}

/**
 * A predicted time turned into something the app can rank on: bigger is better.
 *
 * A RATE (1/seconds), ⊥ a negation. Negating keeps the ordering but produces a number whose ratios are
 * meaningless, and `MIN_GAIN` and the tie band are both RELATIVE — `(a-b)/b` over negatives compares two
 * quantities that grow the wrong way. A rate divides honestly: twice the rate is twice the throughput.
 */
export function scoreFromSeconds(seconds: number): number {
  return Number.isFinite(seconds) && seconds > 0 ? 1 / seconds : 0;
}

/**
 * Seconds for one BATTERY against one defender, from a row in the artifact's own `featureNames` order.
 *
 * PER SET, and there is no per-item version of this quantity. Crit chance, crit damage, attack speed,
 * reload speed and magazine size are UNIT stats, so one gun's Precision roll lifts every gun — an item's
 * worth depends on the rest of the battery and cannot be asked in isolation. A caller ranks a candidate by
 * scoring the set twice, once with it and once with the incumbent, and comparing the two.
 *
 * THE ROW'S LAYOUT COMES FROM THE ARTIFACT, never from a copy of the list: `featureNames` travels beside
 * the weights precisely so a column inserted by the trainer shifts nothing here silently. `predictSeconds`
 * enforces the length; the ORDER is the caller's contract with `a.featureNames`.
 */
export function secondsForSet(row: number[]): number {
  const a = artifact();
  if (!a) throw new Error("arenaModel: no artifact bundled");
  return predictSeconds(a, row);
}

/** The column order this build must fill, straight from the artifact. Empty when no model is bundled. */
export function featureNames(): readonly string[] {
  return artifact()?.featureNames ?? [];
}

/**
 * Which of two batteries the model prefers: negative when `withCandidate` is better (fewer seconds).
 *
 * Two ABSOLUTE predictions of one quantity, so this is antisymmetric by construction and needs none of
 * V70's pair guarding — that guard exists for a comparison measured against a baseline the compared items
 * themselves move (`moduleGain`), which is a different shape. Converting to a gain happens at
 * `scoreFromSeconds`, AFTER the ordering, so no ratio is taken over a quantity that reads backwards.
 */
export function comparePredictions(withCandidate: number, withIncumbent: number): number {
  return withCandidate - withIncumbent;
}

/** Test seam: forget the cached artifact so a suite can exercise both states. */
export function resetArtifactCache(): void { cached = undefined; sense = "ok"; }
