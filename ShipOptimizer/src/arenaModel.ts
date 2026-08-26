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
export type ModelBlock = "no-artifact" | "not-combat" | "bad-sense" | "bad-axis" | "no-band";

let cached: ArenaNetArtifact | null | undefined;
let sense: "ok" | "bad" | "axis" | "band" = "ok";

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
  // The third gate: an artifact must state how well it orders CLOSE pairs, because that is the only kind of
  // pair a swap suggestion is ever made of. One that does not state it cannot be gated on it, and a mode whose
  // silence band is unknown reports every gap as a preference.
  if (nearTieBandOf(first) === null) { sense = "band"; cached = null; return cached; }
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
  // The refusal reason is read AFTER the load, never before it: `sense` is set by `artifact()`, so asking first
  // reports a refused artifact as an absent one until something else has already loaded it.
  if (!artifact()) {
    if (sense === "bad") return "bad-sense";
    if (sense === "axis") return "bad-axis";
    if (sense === "band") return "no-band";
    return "no-artifact";
  }
  if ((role ?? "").toLowerCase() !== "combat") return "not-combat";
  return null;
}

export const MODEL_BLOCK_TEXT: Record<ModelBlock, string> = {
  "no-artifact": "No model is bundled in this build yet — nothing to rank with.",
  "not-combat": "The model predicts seconds against a COMBAT target, so it cannot rank a mining or salvage hull.",
  "bad-sense": "The bundled model does not describe its output as a cost. Refusing to rank rather than risk inverting every suggestion.",
  "bad-axis": "The bundled model moves the wrong way on an axis whose direction is known from the game's own arithmetic. Refusing to rank.",
  "no-band": "The bundled model does not report how well it orders builds that are close together, which is the only comparison a swap is made of. Refusing to rank.",
};

/**
 * Axes whose DIRECTION is settled by the game's arithmetic, not by the training set.
 *
 * Each entry is the sign the label must move in when the feature RISES. Seconds is a cost, so a feature that
 * makes a fight shorter must have a NEGATIVE ablation delta.
 *
 * Why this exists beside `assertCostSense`: that check reads the artifact's declared LABEL and would pass a net
 * whose label is honest and whose coefficients are inverted. A wrong label is a typo; a wrong axis is a model that
 * ranks backwards while looking healthy, and the one place it can be caught cheaply is the moment it loads.
 *
 * The sign is asserted of the GAME, never of a fitted curve. A net trained on a feature it encodes badly can
 * report an honest ablation that disagrees, and refusing it is the intended outcome rather than a false positive.
 */
const KNOWN_AXIS_SIGN: Record<string, -1 | 1> = {
  // More mega-crit points ⇒ more damage per shot ⇒ fewer seconds. `CalculateDamage` halves the crit chance on
  // every success, so the branch saturates: essentially the whole effect is delivered by point 2 and 3 onward is
  // flat. Flat, never upward — the direction holds across the range even where the magnitude stops.
  "skills.mega_crit_points": -1,
  // A bigger hull takes longer to deplete. The largest axis in the model and the easiest sanity check.
  "defender.hull_log": 1,
  // Shield that comes BACK is effective hull the battery has to chew through twice. Measured returning 46% of an
  // 11.2M pool inside one fight, so it is not a rounding term on a shielded target — and an artifact did ship with
  // it backwards, trained on defenders drawn with no regeneration at all.
  "defender.shield_regen_log": 1,
  // Damage the target refuses outright makes the fight longer, whatever else is true of it.
  "defender.damage_reduction": 1,
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
  const m = a.metrics as {
    ablation?: Record<string, number>;
    ablationGrouped?: Record<string, number>;
    ablationNotAReason?: string[];
    ablationUnreportableAlone?: string[];
    constantInTraining?: string[];
  } | undefined;
  const abl = m?.ablationGrouped ?? m?.ablation;
  if (!abl) return ["<no ablation reported>"];

  // A COLUMN THE ARTIFACT ITSELF CALLS UNREADABLE IS NOT JUDGED. Three kinds, and each would produce a false
  // accusation rather than catch a real one: a one-hot or simplex member, whose solo ablation describes a target
  // weak to every damage type at once; a member of an effect the net splits across several columns, where the
  // leftovers land wherever they fit and one member's sign says nothing about the effect; and a column the
  // training set left constant, which was never fitted at all. Refusing an honest artifact for one of these is
  // the same failure as passing a dishonest one, one direction over.
  const mute = new Set<string>([
    ...(m?.ablationNotAReason ?? []),
    ...(m?.ablationUnreportableAlone ?? []),
    ...(m?.constantInTraining ?? []),
  ]);

  const bad: string[] = [];
  for (const [name, want] of Object.entries(KNOWN_AXIS_SIGN)) {
    if (mute.has(name)) continue;
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
  return predictSeconds(a, clampToTrained(a, row));
}

/**
 * Hold every feature inside the range the net was TRAINED on, before it is asked anything.
 *
 * A column the training set left CONSTANT is standardised at std 1, so it reaches the net unscaled: a live
 * value on one of those is not a two-sigma move, it is off the end of everything the model has ever seen. An
 * ordinary armour-regenerating boss predicted a 93x longer fight that way, against a model whose own median
 * error is under 4%.
 *
 * TWO PROPERTIES, both load-bearing:
 *
 * IT MAY ONLY EVER DECLINE. An in-range value passes through untouched, so this bounds a prediction and never
 * moves one — a guard that adjusted a legal input would be a second model nobody could see.
 *
 * IT IS CONTAINMENT, NOT A FIX. A clamped untrained column contributes exactly nothing, so the model is
 * IGNORING that axis rather than reading it. That is honest and survivable where a 93x estimate is not, and the
 * real repair belongs to whoever draws the training set, not here.
 *
 * An artifact that reports no range is passed through: the range travels beside the weights, and inventing one
 * would be asserting the very thing that is missing.
 */
export function clampToTrained(a: ArenaNetArtifact, row: number[]): number[] {
  const range = (a.metrics as { featureRange?: Record<string, [number, number]> } | undefined)?.featureRange;
  if (!range) return row;
  return row.map((v, i) => {
    const span = range[a.featureNames[i]];
    if (!span || span.length !== 2) return v;
    const [lo, hi] = span;
    if (!Number.isFinite(lo) || !Number.isFinite(hi)) return v;
    return v < lo ? lo : v > hi ? hi : v;
  });
}

/** The column order this build must fill, straight from the artifact. Empty when no model is bundled. */
export function featureNames(): readonly string[] {
  return artifact()?.featureNames ?? [];
}

/**
 * The per-row agreement a fact has to clear before it counts as a preference rather than a coin flip.
 *
 * 0.50 IS A COIN FLIP and the floor sits just above it, so an axis measured AT chance cannot pass by being
 * measured on a big enough sample: this is a competence threshold, not a confidence one.
 */
export const NEAR_TIE_TRUST = 0.6;

/**
 * The relative gap inside which this artifact's ordering is worth nothing, or `null` when it does not say.
 *
 * `metrics.pairwiseAccuracy` carries the band (`nearTieFraction`) beside the accuracy MEASURED inside it
 * (`nearTie`) on held-out pairs against one defender. Both halves are needed and neither is assumed:
 *
 * - no block at all, or no fraction, is `null`: the artifact is refused at load rather than trusted to the edge
 *   of a band nobody measured.
 * - a `nearTie` accuracy that CLEARS `NEAR_TIE_TRUST` collapses the band to 0. The model demonstrated it can
 *   order close pairs, and suppressing them then would be discarding an ability the file evidences.
 * - anything else keeps the declared fraction. An artifact reporting the band but no accuracy in it is the
 *   cautious case, not the trusting one: unmeasured and competent are different claims.
 */
export function nearTieBandOf(a: ArenaNetArtifact): number | null {
  const p = (a.metrics as { pairwiseAccuracy?: { nearTieFraction?: number; nearTie?: number | null } } | undefined)
    ?.pairwiseAccuracy;
  const frac = p?.nearTieFraction;
  if (typeof frac !== "number" || !Number.isFinite(frac) || frac < 0) return null;
  const acc = p?.nearTie;
  if (typeof acc === "number" && Number.isFinite(acc) && acc >= NEAR_TIE_TRUST) return 0;
  return frac;
}

/** The bundled artifact's silence band, or 0 when nothing is bundled (nothing to be silent about). */
export function nearTieBand(): number {
  const a = artifact();
  return a ? (nearTieBandOf(a) ?? 0) : 0;
}

/** What the model has to say about one swap. `no-preference` is an ANSWER, not a failure to answer. */
export type Preference = "candidate" | "incumbent" | "no-preference";

/**
 * The model's opinion of a swap, with its own blind band applied.
 *
 * WHY A THIRD ANSWER EXISTS. The caller's floor for acting on a gain (`MIN_GAIN`) is 1% and the band inside
 * which this model orders no better than chance is 5%, so every swap the ranking would actually make lives
 * inside the band: without this, the mode reports coin flips with a number beside them. Falling through to the
 * tie-break the other rankings already use is worse than nothing only if the model knew something, and inside
 * the band it does not.
 *
 * THE DENOMINATOR IS THE SMALLER PREDICTION, matching how the band itself is measured (`|a-b| / min(a,b)`).
 * Reading it against the mean or against the incumbent alone would apply a band of a different width than the
 * one the artifact reports, which is the same defect as inventing the band.
 *
 * WHAT THIS CANNOT DO, and it is a limit rather than a bug: the band is measured on TRUE labels and applied
 * here to PREDICTED ones, because predictions are all a client has. A pair the model wrongly believes to be
 * far apart is still answered.
 */
export function preference(withCandidate: number, withIncumbent: number): Preference {
  return preferenceWithin(nearTieBand(), withCandidate, withIncumbent);
}

/**
 * The same answer against a band stated by the caller.
 *
 * Split out because the band is a property of the ARTIFACT and the comparison is not: the rule is testable, and
 * a caller holding several artifacts (or a suite holding none) is not forced through the bundled one.
 */
export function preferenceWithin(band: number, withCandidate: number, withIncumbent: number): Preference {
  const lo = Math.min(withCandidate, withIncumbent);
  if (!Number.isFinite(withCandidate) || !Number.isFinite(withIncumbent) || lo <= 0) return "no-preference";
  const gap = Math.abs(withCandidate - withIncumbent) / lo;
  if (gap <= band) return "no-preference";
  return comparePredictions(withCandidate, withIncumbent) < 0 ? "candidate" : "incumbent";
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
