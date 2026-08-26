/**
 * WHAT ONE POINT OF EACH COMBAT STAT IS WORTH ON THIS SHIP, measured through the damage model rather than ranked by
 * reputation.
 *
 * The optimizer already scores gear through `setDps`, so it has always valued these correctly when CHOOSING an item.
 * What it could not do is answer the question directly — "is crit or attack speed worth more to me" — and that answer
 * is what a booster ranking is set from. So this moves ONE reported stat at a time and reports the difference.
 *
 * THE ANSWER IS PER SHIP AND PER BATTERY, which is the whole reason it is computed rather than tabulated:
 *   - crit chance, crit damage and precision are pure multipliers ⇒ identical on every battery;
 *   - attack speed and reload speed act on the FIRING CYCLE ⇒ their value is decided by magazine size and reload
 *     time. On single-shot guns attack speed is worth nothing at all (the cycle is the reload) while reload is the
 *     best cycle stat; on a 250-round gatling that reverses.
 *   - combat power is linear in the pool ⇒ a flat roll is worth less the bigger the pool already is.
 * A table shipped as constants would be wrong for the second and third groups the moment the player refits.
 *
 * THE NUDGE GOES INTO THE REPORTED STATUS, never into the derived background. `background()` recovers residual
 * multipliers and the crit additive by DIVIDING the reported figures out, so editing its output afterwards leaves
 * those residuals describing a ship that no longer exists and the change partly cancels itself: measured, +1% of the
 * combat-power pool read as +0.33% DPS that way against +0.99% when re-derived from the reading.
 */
import { setDps, background, poolsFromStatus, type ShipPools } from "./fleetDps";
import type { Item } from "./types";

/** The status fields a marginal needs. A subset of `/status`, so callers can pass the payload straight in. */
export interface StatusPools {
  poolCombatPower?: number | null;
  poolPrecision?: number | null;
  precisionDivisor?: number | null;
  critChance?: number | null;
  critDamage?: number | null;
  poolAttackSpeed?: number | null;
  poolReloadSpeed?: number | null;
  poolMagazineSize?: number | null;
}

/**
 * Anything shaped like a status reading. `/status` carries dozens of fields this does not name, and an index
 * signature over `unknown` would refuse the real payload rather than accept it, so the extra keys ride along
 * untyped and are copied through untouched.
 */
type Reading = StatusPools & Record<string, unknown>;

export interface StatMarginal {
  /** The stat's name in the game's own words, so a resonance or a substat can be matched to it. */
  stat: string;
  /** DPS fraction bought by one point (a percentage stat) or by 1% of the pool (a flat one). */
  perPoint: number;
  /** What `perPoint` is a point OF, for a caller that wants to say so. */
  unit: "point" | "percentOfPool";
  /** True when the figure required dropping the crit anchor, i.e. it is indicative rather than exact. */
  approximate?: boolean;
}

const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);

/** DPS for a battery under a status, or null when the status does not describe a scoreable ship. */
function dpsOf(status: Reading, turrets: Item[]): number | null {
  const pools = poolsFromStatus(status as never);
  if (!pools) return null;
  return setDps(turrets, background(pools, turrets));
}

function moved(status: Reading, turrets: Item[], edit: (s: Reading) => void): number | null {
  const copy: Reading = { ...status };
  edit(copy);
  return dpsOf(copy, turrets);
}

/**
 * Every combat stat's marginal value, strongest first.
 *
 * Returns an empty list when the status cannot be scored (no pool reading, no combat turret, a reading that belongs to
 * a different hull — the caller decides that last one, see `poolsForShip`). Empty is the honest answer there: a
 * ranking computed from the wrong ship's pools is worse than no ranking.
 */
export function statMarginals(status: StatusPools | null, turrets: Item[]): StatMarginal[] {
  if (!status || !turrets.length) return [];
  const reading = status as Reading;
  const base = dpsOf(reading, turrets);
  if (!base || !(base > 0)) return [];

  const gain = (dps: number | null) => (dps == null ? null : (dps / base) - 1);
  const rows: StatMarginal[] = [];
  const push = (stat: string, unit: StatMarginal["unit"], g: number | null, approximate?: boolean) => {
    if (g != null && Number.isFinite(g)) rows.push({ stat, perPoint: g, unit, ...(approximate ? { approximate } : {}) });
  };

  push("Combat Power", "percentOfPool",
    gain(moved(reading, turrets, (s) => { s.poolCombatPower = num(s.poolCombatPower) * 1.01; })));
  push("Critical Chance", "point",
    gain(moved(reading, turrets, (s) => { s.critChance = num(s.critChance) + 0.01; })));
  push("Critical Damage", "point",
    gain(moved(reading, turrets, (s) => { s.critDamage = num(s.critDamage) + 0.01; })));
  push("Attack Speed", "point",
    gain(moved(reading, turrets, (s) => { s.poolAttackSpeed = num(s.poolAttackSpeed) + 0.01; })));
  push("Reload Speed", "point",
    gain(moved(reading, turrets, (s) => { s.poolReloadSpeed = num(s.poolReloadSpeed) + 0.01; })));
  push("Magazine Size", "point",
    gain(moved(reading, turrets, (s) => { s.poolMagazineSize = num(s.poolMagazineSize) + 0.01; })));

  // PRECISION IS ONLY VISIBLE WITH THE ANCHOR DROPPED. Crit chance is reported as a product the game will not
  // factorise, so `background` recovers the additive part by subtracting the Precision curve out of the reading —
  // which means raising Precision lowers the recovered additive by exactly as much and the total does not move.
  // Measured with the reading discarded (crit left to the curve), and flagged approximate for that reason: how much
  // Precision is really worth depends on how much of the reported chance came from it in the first place.
  const noAnchor: Reading = { ...reading, critChance: null };
  const anchorless = dpsOf(noAnchor, turrets);
  if (anchorless && anchorless > 0) {
    const up = moved(noAnchor, turrets, (s) => { s.poolPrecision = num(s.poolPrecision) * 1.01; });
    if (up != null) push("Precision", "percentOfPool", (up / anchorless) - 1, true);
  }

  return rows.sort((a, b) => b.perPoint - a.perPoint);
}

/**
 * A priority order over bonus names, strongest first, for the names this ship's damage model has an opinion about.
 *
 * Names it cannot value (Hull HP, Cargo Capacity, a mining bonus on a combat hull) are returned in `unranked` rather
 * than sorted to the bottom: "worth nothing for damage" and "not a damage stat" are different statements, and a
 * ranking that silently buries the second is a ranking that lies about the first.
 */
export function rankByValue(names: string[], marginals: StatMarginal[]): { ranked: string[]; unranked: string[] } {
  const value = new Map(marginals.map((m) => [m.stat, m.perPoint]));
  const ranked = names.filter((n) => value.has(n)).sort((a, b) => (value.get(b) ?? 0) - (value.get(a) ?? 0));
  const unranked = names.filter((n) => !value.has(n));
  return { ranked, unranked };
}


// ---------------------------------------------------------------------------------------------------------------
// RANKING WHAT THE PLAYER OTHERWISE RANKS BY HAND.
//
// A booster resonance names a stat outright, so it matches a marginal directly. An officer SKILL names an effect in
// prose (`Crit Chance +1%`, `Attack Speed +12%`), and that prose is the only machine-readable statement of what the
// skill does — so it is parsed rather than re-tabulated, and a skill whose effect does not parse is reported as
// unrankable instead of being sorted to the bottom.

/** The game's own stat names, as the marginals key them, for the shorter words a skill effect uses. */
const EFFECT_ALIASES: ReadonlyMap<string, string> = new Map([
  ["crit chance", "Critical Chance"],
  ["critical chance", "Critical Chance"],
  ["crit damage", "Critical Damage"],
  ["critical damage", "Critical Damage"],
  ["attack speed", "Attack Speed"],
  ["reload speed", "Reload Speed"],
  ["magazine size", "Magazine Size"],
  ["combat power", "Combat Power"],
  ["precision", "Precision"],
]);

export interface EffectValue {
  /** The first matched stat, in the marginals' vocabulary. */
  stat: string;
  /** How many POINTS (or percent of pool) that first clause grants. */
  amount: number;
  /** DPS fraction the WHOLE effect is worth on the ship the marginals came from — every priced clause summed. */
  gain: number;
  /** Each clause that could be priced, in the order the effect states them. */
  parts: Array<{ stat: string; amount: number }>;
  /** True when any marginal behind it is itself indicative (Precision). */
  approximate?: boolean;
}

/**
 * What a skill or resonance effect is worth, or null when nothing in it can be valued.
 *
 * EVERY PRICEABLE CLAUSE COUNTS, summed. `Crit Chance +1%, Crit Damage +2.5%` is two boosts on one skill, and reading
 * only the first priced it identically to a skill that grants the first alone — which put `Target Weak Spots` level
 * with `Precise Targeting` even though it also carries the crit damage.
 *
 * A clause is SKIPPED, not guessed at, when it is conditional (`kills → Attack Speed stacks`), when its subject is not
 * a damage stat this model prices (`Cargo Capacity +10%`), or when it carries no number at all (`crit retrigger` —
 * unquantified in the game's own skill data, so there is nothing to multiply). An effect where nothing survives that
 * returns null and is reported as unpriced rather than as worthless.
 */
export function valueOfEffect(effect: string | undefined, marginals: StatMarginal[]): EffectValue | null {
  if (!effect) return null;
  const value = new Map(marginals.map((m) => [m.stat, m]));

  let gain = 0;
  let first: { stat: string; amount: number } | null = null;
  let approximate = false;
  const parts: Array<{ stat: string; amount: number }> = [];

  for (const clause of effect.split(",")) {
    const text = clause.trim();
    // A trigger clause describes something that happens SOMETIMES; its worth depends on an uptime nobody measures here.
    if (text.includes("→")) continue;
    const m = /^([A-Za-z ]+?)\s*\+([\d.]+)%?/.exec(text);
    if (!m) continue;
    const stat = EFFECT_ALIASES.get(m[1].trim().toLowerCase());
    if (!stat) continue;
    const marginal = value.get(stat);
    if (!marginal) continue;
    const amount = Number(m[2]);
    if (!Number.isFinite(amount)) continue;
    // A percentage stat reads in points; a pool stat reads as a percentage OF the pool. Both arrive as the number the
    // text states, and `perPoint` is already per one of whichever unit its own stat uses.
    gain += amount * marginal.perPoint;
    approximate = approximate || !!marginal.approximate;
    parts.push({ stat, amount });
    if (!first) first = { stat, amount };
  }

  if (!first) return null;
  return { stat: first.stat, amount: first.amount, gain, parts, ...(approximate ? { approximate: true } : {}) };
}

/**
 * Officer skills ordered by what they are worth on this ship, strongest first.
 *
 * `unrankable` holds the ones whose effect this cannot value — a trigger, a non-damage stat, an effect with no number
 * — and they are handed back separately for the same reason `rankByValue` separates its own: an ordering that buries
 * "cannot say" among "worth little" is an ordering that misrepresents both.
 */
export function rankSkillsByValue(
  skills: Array<{ id: string; effect?: string }>,
  marginals: StatMarginal[],
): { ranked: Array<{ id: string; gain: number }>; unrankable: string[] } {
  // `unrankable` is the honest word for it: these are skills whose worth is UNKNOWN to this model, ⊥ skills known to
  // be worth little. A conditional effect can be strong (`kills → Attack Speed stacks` on a fast-clearing fit) and an
  // unquantified one can be the best node in the tree; the caller has to say so rather than let position imply it.
  const scored: Array<{ id: string; gain: number }> = [];
  const unrankable: string[] = [];
  for (const s of skills) {
    const v = valueOfEffect(s.effect, marginals);
    if (v) scored.push({ id: s.id, gain: v.gain });
    else unrankable.push(s.id);
  }
  scored.sort((a, b) => b.gain - a.gain);
  return { ranked: scored, unrankable };
}

/** The pools a marginal was computed from, for a caller that wants to state the ship it describes. */
export type { ShipPools };
