// Booster optimizer — pure logic (no React). A booster's "type" is the stat it boosts (its mainStat
// name, e.g. "Combat Power", "Officer Bonus", "Mining Power"); its value is that stat's amount. You
// pick a type per ship booster slot, and the optimizer fills each slot with the highest-value unused
// booster of that type from the pool (equipped + armory + cargo). Each physical booster used once.
import type { Item, Resonance } from "./types";
import type { Scope } from "./scope";
import { unitReachable, type ActivityProfile } from "./activityPresets";
import { isRoleStat, statApplies, type ShipFit } from "./roleStats";

// The booster's type = its main stat name. Falls back to the readable equipment type, else "Other".
export function boosterType(it: Item): string {
  return it.mainStat?.name || it.type || "Other";
}

// Numeric value of a booster = its main-stat amount. Parses "1,257", "540.9", "6.25%", "1.2M".
export function boosterValue(it: Item): number {
  const raw = it.mainStat?.amount;
  if (!raw) return 0;
  const m = raw.replace(/,/g, "").match(/([+-]?\d+(?:\.\d+)?)\s*([KMBT%]?)/i);
  if (!m) return 0;
  const mult: Record<string, number> = { "": 1, K: 1e3, M: 1e6, B: 1e9, T: 1e12, "%": 1 };
  return parseFloat(m[1]) * (mult[m[2].toUpperCase()] ?? 1);
}

// Per-type accent colour for the icon tile (matches the in-game item tint), keyed by main-stat name.
const TYPE_COLOR: Record<string, string> = {
  "Combat Power": "#ff6a4d", "Reload Speed": "#ffb020", "Mining Power": "#38c6e0",
  "Salvage Power": "#4ad06a", "Shield HP": "#4aa3ff", "Armor HP": "#e0863a",
  "Officer Bonus": "#c07bff", "Cargo Capacity": "#9aa4b2",
};
export const boosterTypeColor = (it: Item): string => TYPE_COLOR[boosterType(it)] ?? "#7d7d86";

// Readable resonance unlock-bonus, e.g. "+2.22% Reload Speed" — game-formatted from the bridge.
export function unlockBonusText(r: import("./types").Resonance): string {
  return r.bonus || r.bonusStat || "";
}
export const resonancePct = (r: import("./types").Resonance): number =>
  r.unlocked ? 100 : r.threshold > 0 ? Math.min(100, Math.round((r.progress / r.threshold) * 100)) : 0;

/**
 * How much of its resonance bonus a booster is paying RIGHT NOW, as a fraction.
 *
 * The game's own arithmetic (`ResonantBooster.GetScaledUnlockBonus`, 0.8.1.23): `clamp01(progress / threshold)`,
 * applied to the bonus, and appended to the booster's stats as soon as progress is above zero. So resonance is
 * ⊥ a locked/unlocked switch — a half-progressed booster is already worth half its bonus, and `unlocked` marks
 * where it stops GROWING rather than where it starts paying. Treating it as a switch under-rates every booster
 * the player has flown but not finished, which is most of them.
 */
export function resonanceLive(r: Resonance | null | undefined): number {
  if (!r) return 0;
  if (r.threshold > 0) return Math.min(1, Math.max(0, r.progress / r.threshold));
  return r.unlocked ? 1 : 0;      // a threshold of zero is never "IsUnlocked" in game, but trust the flag
}

/**
 * A ranked list of resonance bonus stats per booster type, best first.
 *
 * `ANY_TYPE` is the list a type falls back to when it has none of its own. It is how an order stated before the
 * question was asked per type keeps applying: it covers every type at once until one is ranked on its own terms,
 * and a type's own list — even an empty one — replaces it rather than merging with it.
 */
export type ResonanceOrder = Readonly<Record<string, readonly string[]>>;

/** The key covering every booster type that has no list of its own. Not a booster type; no `mainStat` reads "*". */
export const ANY_TYPE = "*";

/** What the player is asking of the optimizer, per ship. */
export interface BoosterCtx {
  /** `current` prices what a booster pays today; `potential` prices what it will pay once flown. */
  scope: Scope;
  /** The ship's stated way of playing — decides which unlock requirements are reachable at all. */
  profile: ActivityProfile;
  /** The hull, for judging whether the BONUS stat does anything here. */
  fit?: ShipFit | null;
  /** Bonus stats the player has said not to chase on this ship. */
  blacklist?: ReadonlySet<string>;
  /**
   * The player's own ORDER over resonance bonus stats, best first — read BEFORE the score, always.
   *
   * Strict priority is the player's decision and it is not a weight: a booster whose resonance ranks higher
   * wins its slot over one that ranks lower, whatever the main stats say. That is the point of stating an
   * order — an order never compares Combat Power to Shield HP, it compares rank to rank, so no exchange rate
 * between two stats is invented (the same argument makes for gear).
   *
   * It is also why this can hand over a much smaller booster, and that is the ASKED-FOR behaviour rather than
   * a defect. A stat not in the list ranks after every stat that is, and so does a booster with no resonance
   * at all; an empty order leaves every candidate tied and the score decides exactly as before.
   *
   * KEYED BY BOOSTER TYPE, because the bonus pools overlap without partitioning: Drone Power is rollable on a
   * Combat, Drone, Mining OR Salvage booster, so one list over all types cannot say "Drone Power first on a
   * combat booster, last on a mining one" — ranking the stat once answers for every type that carries it.
   */
  order?: ResonanceOrder;
}

/**
 * What a resonance bonus is worth to THIS ship, as a fraction of the booster's own value.
 *
 * Priced as a MULTIPLIER, ⊥ as an additive term, and that is a deliberate limit: the bonus stat is usually a
 * different quantity from the booster's main stat (a Resonant Combat Booster's headline is Combat Power and its
 * bonus may be Reload Speed), and this app has no exchange rate between them — that model exists for combat
 * stats only, inside `fleetDps`, and boosters are not in it. A multiplier keeps the ranking in the main stat's
 * own units, where a comparison is meaningful, and lets resonance decide between two boosters of the SAME type,
 * which is the only comparison the slot picker ever makes.
 *
 * `RESONANCE_WEIGHT` is therefore a WEIGHT rather than a measurement: it says how much a fully-paying, useful
 * resonance is allowed to outrank raw main-stat value. Set it high and a weak booster with a good bonus wins on
 * a stat nobody priced; set it to zero and this whole reading disappears.
 */
export const RESONANCE_WEIGHT = 0.2;

export interface ResonanceCredit {
  /** The multiplier applied to the booster's value: `value * (1 + credit)`. */
  credit: number;
  /** The fraction of the bonus this reading counts — today's, or the whole thing under `potential`. */
  paying: number;
  /** Why it is worth nothing, where it is: the row shown to the player. */
  why: string | null;
}

export function resonanceCredit(it: Item, ctx: BoosterCtx): ResonanceCredit {
  const r = it.resonance;
  if (!r) return { credit: 0, paying: 0, why: null };

  const live = resonanceLive(r);
  const stat = r.bonusStat || "";

  if (stat && ctx.blacklist?.has(stat))
    return { credit: 0, paying: live, why: `${stat} is blacklisted on this ship` };
  // A bonus the hull cannot use is a number attached to nothing — the same test the gear comparator applies.
  if (stat && !statApplies(stat, ctx.fit))
    return { credit: 0, paying: live, why: `${stat} does nothing on this hull` };

  const reachable = unitReachable(r.unit, ctx.profile, ctx.fit?.activities);
  // `potential` credits the WHOLE bonus, but only where the ship can actually finish it: an ore threshold on a
  // hull with no mining gun is a promise nobody can keep, and crediting it would rank that booster above one
  // already paying. `current` never looks past what is live today, whatever the ship could reach.
  const paying = ctx.scope === "potential" && reachable ? 1 : live;

  // Weight what the bonus is FOR: a role stat is what this ship is for, anything else still applies but matters
  // less. Deliberately coarse — see RESONANCE_WEIGHT on why this is a weight and not an exchange rate.
  const useful = isRoleStat(ctx.fit?.role, stat) ? 1 : 0.5;
  const credit = RESONANCE_WEIGHT * useful * paying;

  const why = paying === 0
    ? (r.unit && !reachable ? `no ${r.unit} on this ship` : "not started")
    : null;
  return { credit, paying, why };
}

/**
 * The figure the optimizer ranks on: main-stat value, lifted by what its resonance pays.
 *
 * `boosterValue` stays the RAW headline (what the card shows, and what a player compares by eye) — this is the
 * scored reading, and the two are kept apart for the reason gives about saturated stats: the number on the
 * card and the number that wins an argument are allowed to differ, as long as neither is quietly the other.
 */
export function boosterScore(it: Item, ctx?: BoosterCtx | null): number {
  const base = boosterValue(it);
  if (!ctx) return base;
  return base * (1 + resonanceCredit(it, ctx).credit);
}

/**
 * Where this booster's resonance sits in the player's order FOR ITS OWN TYPE. Lower is better; everything
 * unranked shares the last place, so an unlisted bonus and no bonus at all are the same statement — "you did
 * not ask for this" — and neither is treated as a penalty against the other.
 *
 * A BLACKLISTED stat ranks last too, whatever the order says: the two controls answer the same question and a
 * bonus the player has told this ship not to chase cannot also be its first preference. The blocklist wins
 * because it is the narrower, more recently expressed statement.
 *
 * Ranks from two different types are not on one scale, and nothing compares them: a slot is filled from
 * candidates of ONE type. The exception is the forced-booster pass, which sorts mixed types to decide claim
 * order — each still lands in a slot of its own type, so no cross-type exchange rate follows from it.
 */
export function resonanceRank(it: Item, ctx?: BoosterCtx | null): number {
  const order = ctx?.order?.[boosterType(it)] ?? ctx?.order?.[ANY_TYPE] ?? [];
  if (!order.length) return 0;                       // no order stated ⇒ every candidate ties, score decides
  const stat = it.resonance?.bonusStat;
  if (!stat || ctx?.blacklist?.has(stat)) return order.length;
  const i = order.indexOf(stat);
  return i >= 0 ? i : order.length;
}

// Is this item a booster? (category Booster, or a type/name ending in "booster")
export function isBooster(it: Item): boolean {
  const c = (it.category ?? "").toLowerCase();
  const t = (it.type ?? "").toLowerCase();
  return c.includes("booster") || t.includes("booster");
}

// Distinct booster types present in a pool, most valuable first (for the per-slot type picker).
export function boosterTypes(pool: Item[]): string[] {
  const best = new Map<string, number>();
  for (const b of pool) {
    const t = boosterType(b);
    best.set(t, Math.max(best.get(t) ?? 0, boosterValue(b)));
  }
  return [...best.entries()].sort((a, b) => b[1] - a[1]).map(([t]) => t);
}

/**
 * Default per-slot type: keep what is equipped; an empty slot defaults to the booster type this ROLE is for.
 *
 * The role's stats come from `roleStats`, which owns that mapping — matching the role's own NAME against the
 * type list instead only worked by luck of the naming ("Combat" is a substring of "Combat Power"), and every
 * other role matched nothing: `Salvaging` never finds `Salvage Power`, `Cargo` never finds `Cargo Capacity`,
 * and both fell through to whatever the pool's biggest type happened to be.
 */
export function defaultSlotTypes(equipped: (Item | null)[], slotCount: number, role: string | null, pool: Item[]): (string | null)[] {
  const types = boosterTypes(pool);
  const roleType = types.find((t) => isRoleStat(role, t)) ?? null;
  const fallback = roleType ?? types[0] ?? null;
  return Array.from({ length: slotCount }, (_, i) => {
    const cur = equipped[i];
    return cur ? boosterType(cur) : fallback;
  });
}

// Stable per-booster id for a session (location + inventory slot / equipped index / name).
export const boosterId = (b: Item): string => `${b.location ?? "ship"}:${b.key ?? b.slot ?? ""}:${b.name}:${b.level}`;

export interface BoosterPick {
  slot: number;
  type: string | null;
  chosen: Item | null; // best available booster of that type (null = none in pool)
  /** The RAW main-stat amount — what the card shows and what the player compares by eye. */
  value: number;
  /** What the ranking actually used: `value` lifted by the resonance credit. Equal to `value` with no ctx. */
  score: number;
  forced: boolean; // filled by a user-forced booster
}

export interface BoosterResult {
  picks: BoosterPick[];
  unplaceableForced: Item[]; // forced boosters whose type has no matching slot
}

// Fill each slot with the highest-value unused booster of its type. Forced boosters (by id) take a
// slot of their type first; a forced booster with no matching slot is returned as unplaceable.
export function optimizeBoosters(
  pool: Item[], slotTypes: (string | null)[], forced?: Set<string>, ctx?: BoosterCtx | null,
  refused?: ReadonlySet<string>, pins?: ReadonlyMap<number, string>, locked?: ReadonlySet<number>,
): BoosterResult {
  // What the ranking uses. Without a ctx this is the raw main-stat value ∴ every existing caller keeps its
  // behaviour, and resonance enters only where a ship (and therefore a way of playing) is known.
  const score = (b: Item) => boosterScore(b, ctx);
  // THE PLAYER'S ORDER FIRST, THEN THE SCORE. Strict, by their decision: rank is compared to rank and never
  // traded against a main stat, which is what makes it an order rather than a weight.
  const better = (a: Item, z: Item) =>
    resonanceRank(a, ctx) - resonanceRank(z, ctx)
    || score(z) - score(a)
    // On a tie, the EQUIPPED booster holds its place: an equal candidate displacing it would read as a change
    // the player then has to apply for nothing.
    || (Number(z.location === "equipped") - Number(a.location === "equipped"))
    || boosterId(a).localeCompare(boosterId(z));   // stable across reloads
  // A REFUSED candidate is out of the pool entirely, so the slot re-picks the next best rather than freezing.
  // Refusing the suggestion and locking the slot are different requests: this is the first, and it leaves the
  // optimizer free to keep answering the slot (`toggleRefuse` in the tab is how one comes back).
  const out = refused ?? new Set<string>();
  pool = pool.filter((b) => !out.has(boosterId(b)));
  const used = new Set<Item>();
  const picks: BoosterPick[] = slotTypes.map((type, slot) => ({ slot, type, chosen: null, value: 0, score: 0, forced: false }));
  const forcedSet = forced ?? new Set<string>();
  const forcedBoosters = pool.filter((b) => forcedSet.has(boosterId(b)));

  // Pass -1: LOCKED SLOTS keep what is fitted and are not answered at all. The booster stays in `used`, so the
  // rest of the plan cannot take it — a lock that let another slot steal the booster it was protecting would be
  // no lock. Distinct from a pin (an item the player CHOSE) and from a refusal (one candidate rejected).
  const lockedSlots = locked ?? new Set<number>();
  for (const slot of lockedSlots) {
    const p = picks[slot];
    if (!p) continue;
    const fitted = pool.find((b) => b.location === "equipped" && b.slot === slot);
    if (fitted) { p.chosen = fitted; p.value = boosterValue(fitted); p.score = score(fitted); used.add(fitted); }
    // An EMPTY locked slot stays empty and stays out of the search: "leave this alone" is an answer even when
    // there is nothing in it.
    p.type = fitted ? boosterType(fitted) : p.type;
  }

  // Pass 0: THE PLAYER'S OWN CHOICE, into the exact slot they chose it for. A pin is not a preference the
  // optimizer weighs — it is an answer already given, so it is placed before anything is scored and the slot's
  // TYPE does not gate it: choosing a booster for a slot is also how the type gets changed.
  const pinned = pins ?? new Map<number, string>();
  for (const [slot, id] of pinned) {
    const p = picks[slot];
    const b = pool.find((x) => boosterId(x) === id);
    if (!p || !b || used.has(b)) continue;
    p.chosen = b; p.value = boosterValue(b); p.score = score(b); p.forced = true; p.type = boosterType(b);
    used.add(b);
  }

  // Pass 1: place forced boosters into a slot matching their type (highest value first).
  const unplaceableForced: Item[] = [];
  for (const b of [...forcedBoosters].sort(better)) {
    const t = boosterType(b);
    const slot = picks.find((p) => p.type === t && !p.chosen);
    if (slot) { slot.chosen = b; slot.value = boosterValue(b); slot.score = score(b); slot.forced = true; used.add(b); }
    else unplaceableForced.push(b);
  }

  // Pass 2: fill remaining slots per type, KEEPING equipped boosters in their own slot. Only new
  // (armory/cargo) boosters move into slots — displacing the weakest equipped one of that type. This
  // keeps the result stable: re-optimizing after an apply proposes no further churn (the armory pick
  // is now equipped-in-place), so a single Apply sticks instead of cascading over several clicks.
  const openPicks = picks.filter((p) => !p.chosen && p.type && !lockedSlots.has(p.slot));
  for (const t of new Set(openPicks.map((p) => p.type))) {
    const slotsOfType = openPicks.filter((p) => p.type === t);
    const winners = pool
      .filter((b) => !used.has(b) && boosterType(b) === t)
      // The player's resonance order first, then value, then the equipped holder on a tie, then a stable id —
      // one comparator (`better`), shared with the forced pass so the two cannot disagree about "best".
      .sort(better)
      .slice(0, slotsOfType.length);
    const bySlot = new Map(slotsOfType.map((p) => [p.slot, p]));
    const free = new Set(slotsOfType);
    const movers: Item[] = [];
    // Pin each winning booster that's already equipped to the very slot it sits in.
    for (const w of winners) {
      const p = w.location === "equipped" ? bySlot.get(w.slot as number) : undefined;
      if (p && free.has(p)) { p.chosen = w; p.value = boosterValue(w); p.score = score(w); used.add(w); free.delete(p); }
      else movers.push(w);
    }
    // Remaining winners (armory/cargo, or equipped in a now-retyped slot) fill the freed slots.
    const freeSlots = [...free];
    movers.forEach((w, i) => { const p = freeSlots[i]; if (p) { p.chosen = w; p.value = boosterValue(w); p.score = score(w); used.add(w); } });
  }
  return { picks, unplaceableForced };
}
