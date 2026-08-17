// Which owned equipment is scrap. The objective, owned by no tab — the sell list renders this and never
// re-derives any of it.
//
// A ruleset is ONE DEFAULT STANCE plus EXCEPTIONS of the opposite kind. An item either matches an
// exception, taking that kind, or it matches none and takes the default. Since every exception shares one
// kind, two of them matching cannot disagree — which is why there is no precedence anywhere below, and why
// adding a rule is how the user says OR.
//
// Each rule is a small query: WHERE narrows, GROUP BY partitions, HAVING tests the group, ORDER BY
// ranks inside it, TAKE keeps or drops the ends. TAKE is optional and its absence is the common case.
import type { Item } from "./types";
import { effectiveMainVal } from "./format";
import { catOf, isTurret } from "./itemKind";
// The game's own resonance fraction, so a filter and the booster optimizer agree on what "in progress" means.
import { resonanceLive } from "./booster";

export type Kind = "keep" | "sell";
export type Dir = "asc" | "desc";

/** Rarity, worst → best. */
export const RARITY_ORDER = ["Standard", "Enhanced", "HighGrade", "Exotic", "Legendary"] as const;
const rarityRank = (r: string | null | undefined) => {
  const i = RARITY_ORDER.indexOf((r ?? "") as (typeof RARITY_ORDER)[number]);
  return i < 0 ? 0 : i;
};

/** The user's own turret categories: a named set of turret TYPES, so an item can be in several. */
export type Cats = Record<string, string[]>;

// ---------------------------------------------------------------------------------------------------
// The field registry. ONE owner: every consumer (picker, grouping, ordering, sentence, matcher) derives
// from this. A hand-maintained mirror of it drifts the moment a field is added or removed.
// ---------------------------------------------------------------------------------------------------
export type FieldKind = "set" | "multi" | "range";

export interface FieldDef {
  label: string;
  kind: FieldKind;
  /** `set` → one value; `multi` → several; `range` → a number. */
  get: (it: Item, ctx: FieldCtx) => string | number | string[] | null | undefined;
  /** Counts read "most/fewest" where magnitudes read "highest/lowest". */
  counting?: boolean;
  /**
   * A range field with ONE reading: a floor. Per the user, "no need for a comparison picker, it's always at
   * least" — and it is not only convenience: a CEILING on the figure an item is chosen for says "give me a
   * weaker one", so the picker offers no comparison and the chip has no side to flip.
   */
  onlyMin?: boolean;
  /** Ordering by a pooled power figure is only meaningful inside one unit. */
  pooled?: boolean;
}

export interface FieldCtx {
  cats: Cats;
  /** The player's own level, for "level vs mine". */
  myLevel: number;
  /**
   * How many of each item NAME the player already holds, for the shopping list's `copies owned` clause.
   *
   * Absent on the sell side, where it reads 0 for everything — which is also what keeps the field out of the
   * sell list's picker without that picker having to know the field is buy-side: it offers only fields whose
   * value VARIES across the items in front of it.
   */
  owned?: Record<string, number>;
}

/** A booster's real identity is its MAIN STAT: the DTO reports `type: "Booster"` for every one of them, so
 *  grouping by type alone pools them all and proposes selling nearly the lot. */
export const typeOf = (it: Item): string | null =>
  it.category === "Booster" ? (it.mainStat?.name ?? it.type) : it.type;

const aspectNames = (it: Item) => (it.aspects ?? []).map((a) => a.name).filter(Boolean);
const catsOf = (it: Item, ctx: FieldCtx) =>
  Object.keys(ctx.cats).filter((k) => (ctx.cats[k] ?? []).includes(it.type ?? ""));

export const FIELDS: Record<string, FieldDef> = {
  l:    { label: "level",         kind: "range", get: (it) => it.level },
  // Relative to the player, so a rule keeps meaning something as they level.
  lrel: { label: "level vs mine", kind: "range", get: (it, c) => (it.level ?? 0) - c.myLevel },
  v:    { label: "sell value",    kind: "range", get: (it) => it.sellValue ?? 0 },
  r:    { label: "quality",       kind: "set",   get: (it) => it.rarity },
  s:    { label: "size",          kind: "set",   get: (it) => it.size },
  c:    { label: "item kind",     kind: "set",   get: (it) => it.category },
  // Activity carries the LAYER in the gear tab's own encoding, so "Mining" matches all of it and
  // "Mining - core" narrows. Combat has no layer worth choosing (shield → armor → hull cascade), which is
  // why the gear tab's own filter list splits mining and salvage only.
  a:    { label: "activity",      kind: "multi", get: (it) => {
            const act = catOf(it);
            if (!act) return [];
            const layer = it.targetLayer;
            return act !== "Combat" && layer ? [act, `${act} - ${layer.toLowerCase()}`] : [act];
          } },
  t:    { label: "type",          kind: "set",   get: (it) => typeOf(it) },
  st:   { label: "slot",          kind: "set",   get: (it) => it.slotType },
  cat:  { label: "category",      kind: "multi", get: catsOf },
  dt:   { label: "damage",        kind: "set",   get: (it) => it.damageType },
  ms:   { label: "main stat",     kind: "set",   get: (it) => it.mainStat?.name ?? null },
  // WHAT the headline is worth, beside `ms`'s WHICH it is — "any Large gun over 11K Combat Power" is the plainest
  // want there is and had no clause. The EFFECTIVE figure, ⊥ the printed one: `mainVal` reads a display string
  // rounded to three significant figures, and `effectiveMainVal` folds the aspect-granted lines the card already
  // shows, which is the number the player is comparing against.
  mv:   { label: "main stat amount", kind: "range", onlyMin: true, get: (it) => effectiveMainVal(it) ?? 0 },
  sub:  { label: "substat",       kind: "multi", get: (it) => (it.substats ?? []).map((x) => x.stat).filter(Boolean) },
  // HOW MANY bonus lines, as opposed to WHICH ones (`sub`) — the pair `asp`/`aspN` already is, ticked the same
  // way: the counts a roll actually comes with are a short list, so several ticked read as OR ("2 or 3 of them,
  // whatever they are"). Named `substats count` because "substat" and "substats" one line apart in the picker
  // is two fields the player has to guess between.
  subN: { label: "substats count", kind: "set", counting: true, get: (it) => (it.substats ?? []).length },
  asp:  { label: "aspect",        kind: "multi", get: (it) => aspectNames(it) },
  aspN: { label: "aspect slots",  kind: "set",   get: (it) => it.aspectSlots ?? 0, counting: true },
  aspE: { label: "empty slots",   kind: "set",   counting: true,
          get: (it) => Math.max(0, (it.aspectSlots ?? 0) - aspectNames(it).length) },
  // Shop-floor fields. An owned item has no price and its owned count is not reported here, so both read a
  // constant on the sell side and the picker leaves them out of a sell rule by itself.
  //
  // A BARTER offer leaves `cost` null and prices itself in goods, so it is INFINITELY far outside any credit
  // cap rather than free: "price at most 200,000" must not quietly claim an offer whose price is 12 marks.
  p:    { label: "price",         kind: "range", get: (it) => (it.costItem ? Number.POSITIVE_INFINITY : it.cost ?? 0) },
  own:  { label: "copies owned",  kind: "range", counting: true, get: (it, c) => c.owned?.[it.name] ?? 0 },
  // RESONANCE — resonant boosters only, and the feature is BETA-ONLY on the game side (`ResonantBooster` is
  // absent from the release build, so the bridge sends `resonance: null` for everything). Every clause here
  // therefore reads the same on a release build ∴ `fieldVaries` drops all four from the picker by itself, with
  // no build check to keep in sync — the same mechanism that keeps `price` out of a list of things you own.
  res:  { label: "resonance",     kind: "set", get: (it) => (it.resonance
            ? (it.resonance.unlocked ? "finished" : resonanceLive(it.resonance) > 0 ? "in progress" : "unstarted")
            : "none") },
  // The stat the bonus grants, which is what a player chases or blocks — ⊥ the booster's own headline (`ms`).
  resS: { label: "resonance bonus", kind: "set", get: (it) => it.resonance?.bonusStat ?? null },
  // What it wants DONE. A `kills` threshold on a hauler never progresses, so this is how a shopping list says
  // "only boosters my ship can actually finish".
  resU: { label: "resonance needs", kind: "set", get: (it) => it.resonance?.unit ?? null },
  // How far along, as a PERCENTAGE: thresholds differ by orders of magnitude between units (1 per kill against a
  // credit count), so raw progress is not comparable across boosters and the fraction is the only honest figure.
  resP: { label: "resonance progress %", kind: "range",
          get: (it) => (it.resonance ? Math.round(resonanceLive(it.resonance) * 100) : 0) },
};

/**
 * One bound of a `level vs mine` clause said in words — "at least 10 below", "at most 2 above" — which is how
 * the clause is read, edited AND written into the rule's sentence. ONE vocabulary: the editor and the sentence
 * disagreeing about what a clause means is the same defect as two implementations of it.
 *
 * The stored form is a signed OFFSET (`level - myLevel`), and which BOUND a term writes follows from the pair:
 * further below me is a SMALLER offset ∴ "at least 10 below" is `max: -10`, while "at most 10 below" is the
 * near side, `min: -10`. Getting that backwards inverts the rule, which is why it is derived and not typed out.
 */
export interface RelTerm { q: "at least" | "at most"; n: number; dir: "below" | "above" }

export const relSide = (t: RelTerm): "min" | "max" => ((t.q === "at least") === (t.dir === "above") ? "min" : "max");

/** The bound a term writes, as `{side, value}` — the caller decides what happens to the other bound. */
export function relBound(t: RelTerm): { side: "min" | "max"; value: number } {
  const n = Math.abs(t.n);
  // At MY level the distance says nothing and the direction says everything: "below mine" is `max: 0`, "above
  // mine" is `min: 0`. Reading the side off the sign instead collapses both onto one bound.
  // `-0` is a real value in JS and survives into stored JSON, where it compares unequal to the 0 every other
  // path writes — so a distance of nothing is normalised here rather than everywhere it is read.
  return { side: n === 0 ? (t.dir === "below" ? "max" : "min") : relSide(t), value: n === 0 ? 0 : t.dir === "below" ? -n : n };
}

/** MY OWN LEVEL, exactly — a distance of zero in BOTH directions, which no single bound can say. */
export const REL_EXACT: RangeCond = { min: 0, max: 0 };
export const isRelExact = (c: RangeCond) => c.min === 0 && c.max === 0;

/**
 * Every reading a `level vs mine` clause has, as the ONE list its quantifier offers.
 *
 * Three of the five carry no distance, and they are the common ones: "everything at or below my level" is what
 * a player means far more often than any offset, and making them type a 0 to say it — then working out which
 * bound a 0 lands on — is arithmetic the sentence exists to remove. INCLUSIVE on purpose: `max: 0` is my own
 * level and everything under it, and "at or below" says that where "below" would leave a reader guessing
 * whether their own level is in or out.
 */
export type RelQ = RelTerm["q"] | "at or below" | "at or above" | "exactly";
export const REL_QS: RelQ[] = ["at least", "at most", "at or below", "at or above", "exactly"];
export const relNeedsNumber = (q: RelQ) => q === "at least" || q === "at most";

/** The whole clause a distance-free quantifier writes, or null for the two that need a number. */
export const relFixed = (q: RelQ): RangeCond | null =>
  q === "at or below" ? { min: null, max: 0 }
  : q === "at or above" ? { min: 0, max: null }
  : q === "exactly" ? { ...REL_EXACT }
  : null;

/** Which distance-free reading a clause IS, or null when it carries a distance. */
export function relFixedQ(c: RangeCond): RelQ | null {
  if (isRelExact(c)) return "exactly";
  if (c.max === 0 && c.min == null) return "at or below";
  if (c.min === 0 && c.max == null) return "at or above";
  return null;
}

/** The words for one bound of a clause, or null when that bound is open. */
export function relTermOf(c: RangeCond, side: "min" | "max"): RelTerm | null {
  const v = side === "min" ? c.min : c.max;
  if (v == null) return null;
  if (v === 0) return { q: "at least", n: 0, dir: side === "min" ? "above" : "below" };
  const dir = v < 0 ? "below" : "above";
  return { q: (side === "min") === (dir === "above") ? "at least" : "at most", n: Math.abs(v), dir };
}

/**
 * What a `level vs mine` clause selects, in ABSOLUTE levels — the only form of it a player can check against
 * the level column. The stored number is a signed offset (`-10` = ten levels below), which reads as a level
 * itself and is the one part of the clause the editor cannot show any other way.
 *
 * Clamped at 1 because that is where levels start: `-70 or less` on a level-60 player selects everything, and
 * "Lv 1 or less" says that where "Lv -10 or less" reads as an error.
 */
export function relAbs(c: RangeCond, myLevel: number): string {
  const at = (n: number) => Math.max(1, myLevel + n);
  if (c.min != null && c.max != null) return c.min === c.max ? `= Lv ${at(c.min)}` : `= Lv ${at(c.min)}–${at(c.max)}`;
  if (c.max != null) return `= Lv ${at(c.max)} or less`;
  if (c.min != null) return `= Lv ${at(c.min)} or more`;
  return "";
}

/** Fields a count can be partitioned by. */
export const GROUP_FIELDS = ["t", "s", "st", "ms", "a", "cat", "c", "r", "dt", "aspN"] as const;

/** Measures a rule can rank by. `power` folds aspect-granted stats via `effectiveMainVal`. */
export const ORDERS: Record<string, { label: string; counting?: boolean; pooled?: boolean }> = {
  m:    { label: "power", pooled: true },
  l:    { label: "level" },
  r:    { label: "quality" },
  v:    { label: "sell value" },
  aspN: { label: "aspect slots", counting: true },
  aspE: { label: "empty slots", counting: true },
};

export const rankVal = (it: Item, f: string): number =>
  f === "m" ? (effectiveMainVal(it) ?? 0)
  : f === "r" ? rarityRank(it.rarity)
  : f === "l" ? (it.level ?? 0)
  : f === "v" ? (it.sellValue ?? 0)
  : f === "aspN" ? (it.aspectSlots ?? 0)
  : f === "aspE" ? Math.max(0, (it.aspectSlots ?? 0) - aspectNames(it).length)
  : 0;

// ---------------------------------------------------------------------------------------------------
// The rule
// ---------------------------------------------------------------------------------------------------
export interface SetCond {
  values: string[];
  /** Inverts whatever the clause selects. What that MEANS depends on `need`, so read `setQOf`, not this. */
  not?: boolean;
  /**
   * HOW MANY of the ticked values the item needs. Absent = 1, i.e. any of them.
   *
   * A number is a threshold ("at least 2 of these three aspects"); `"all"` tracks the LIST rather than a count,
   * so ticking a fourth value still means every one — storing `4` there would silently become "at least 4 of 5".
   *
   * Only a `multi` field can hold several values at once (aspects, substats, activities, categories), so a
   * threshold is offered there alone: a `set` field answers with ONE value, and "size is Small and Large"
   * matches nothing.
   */
  need?: number | "all";
  /** The earlier stored spelling of `need: "all"`. Read so a saved rule keeps meaning what it said. */
  all?: boolean;
}

/** `need` as a number, against the clause's own list. Absent = 1: any one of them. */
export const needCount = (c: SetCond): number => {
  const n = c.need ?? (c.all ? "all" : 1);
  return n === "all" ? Math.max(1, c.values.length) : Math.max(1, Math.min(n, c.values.length || 1));
};

/**
 * Every reading a ticked list has, as the ONE list its control offers — the same shape `RelQ` gives the
 * relative-level clause, and for the same reason: the chip, the picker and the sentence must not word a clause
 * three ways.
 *
 * These are the words the player sees. `not` and a threshold are what the RULE stores, and the pairing is not
 * something to make anyone work out: "has none of" is `not` over a threshold of one, while "is missing at least
 * one of" is `not` over ALL — the same tick with `not` set, selecting a completely different set of items.
 */
export type SetQ = "any" | "all" | "atLeast" | "none" | "notAll" | "fewer";
/** Order shown: the two plain readings, then the counted ones, then the three negatives. */
export const SET_QS: SetQ[] = ["any", "all", "atLeast", "none", "notAll", "fewer"];
/** Readings a field can offer at all: a one-value field (a size, a quality) can only be one of them or not. */
export const SET_QS_ONE: SetQ[] = ["any", "none"];
export const setQNeedsNumber = (q: SetQ) => q === "atLeast" || q === "fewer";

/** Which reading a stored clause IS. */
export function setQOf(c: SetCond): SetQ {
  const all = (c.need ?? (c.all ? "all" : 1)) === "all";
  const n = needCount(c);
  if (c.not) return all && c.values.length > 1 ? "notAll" : n > 1 ? "fewer" : "none";
  return all && c.values.length > 1 ? "all" : n > 1 ? "atLeast" : "any";
}

/** The clause a reading writes over the values already ticked. `n` is used only by the counted readings. */
export function setCondFor(q: SetQ, c: SetCond, n = 2): SetCond {
  const values = c.values;
  switch (q) {
    case "any":     return { values, not: false, need: 1 };
    case "all":     return { values, not: false, need: "all" };
    case "atLeast": return { values, not: false, need: Math.max(2, n) };
    case "none":    return { values, not: true, need: 1 };
    case "notAll":  return { values, not: true, need: "all" };
    case "fewer":   return { values, not: true, need: Math.max(2, n) };
  }
}

/**
 * A reading in words, for a control. `several` is false for a field that answers with one value, where "has any
 * of" would be a promise the data cannot keep — a turret has one size, so the question is only which.
 *
 * `one` shortens the two readings a single ticked value has: "is Legendary" beats "is one of Legendary".
 */
export function setQWords(q: SetQ, several: boolean, one = false): string {
  if (!several) return q === "none" ? (one ? "is not" : "is none of") : (one ? "is" : "is one of");
  switch (q) {
    case "any":     return one ? "has" : "has any of";
    case "all":     return "has all of";
    case "atLeast": return "has at least";
    case "none":    return one ? "does not have" : "has none of";
    case "notAll":  return "is missing at least one of";
    case "fewer":   return "has fewer than";
  }
}
export interface RangeCond { min?: number | null; max?: number | null }
export type Cond = SetCond | RangeCond;

/**
 * The clauses of one rule, keyed by CLAUSE: a field id for the first clause about that field, `field#n` for a
 * further one.
 *
 * Clauses are ANDed and the values inside one clause are ORed, so two clauses over one field say an AND of two
 * lists — "has any of Crit Chance or Crit Damage AND has any of Fire Rate or Damage" — which no single ticked
 * list says at any threshold: `need` counts across ONE list, and `all` demands every value in it.
 *
 * Iteration is INSERTION order, since no key is an array index: that is the order the clauses were written and
 * the order `whereFail` reports them in.
 */
export type Where = Record<string, Cond>;

/** The field a clause key names. Every `FIELDS` lookup from a `where` key goes through this. */
export const fieldOf = (key: string): string => {
  const i = key.indexOf("#");
  return i < 0 ? key : key.slice(0, i);
};

/** Every clause about one field, as keys, in the order the rule holds them. */
export const clauseKeys = (where: Where, field: string): string[] =>
  Object.keys(where).filter((k) => fieldOf(k) === field);

export const hasField = (where: Where, field: string): boolean =>
  Object.keys(where).some((k) => fieldOf(k) === field);

/**
 * Does this field tell the rows in front of us APART?
 *
 * A field every row answers the same way says nothing about them — and it is what keeps the two SHOP-FLOOR
 * fields out of a sell rule and out of a sell list's columns with no buy-side flag anywhere in the code: an
 * owned item has no `cost` and reports no owned count, so `p` and `own` are one value over an armory and
 * nineteen over a shop floor. A clause or column ALREADY in force is offered regardless.
 */
export const fieldVaries = (items: Item[], field: string, ctx: FieldCtx): boolean =>
  new Set(items.flatMap((it) => {
    const v = FIELDS[field]?.get(it, ctx);
    return v == null ? [] : Array.isArray(v) ? v : [v];
  })).size > 1;

/** Where a NEW clause about this field goes, leaving the clauses already there untouched. */
export function freeKey(where: Where, field: string): string {
  if (!(field in where)) return field;
  for (let n = 2; ; n++) if (!(`${field}#${n}` in where)) return `${field}#${n}`;
}

export interface Take { mode: "only" | "except"; n: number }
export interface Having { op: "gt" | "lt"; n: number }

export interface Rule {
  id: string;
  where: Where;
  group: string[];
  order: { f: string; dir: Dir };
  take: Take | null;
  having: Having | null;
}

export interface RuleSet {
  /** What happens to anything no exception claims. */
  defaultKind: Kind;
  /** All of the opposite kind to `defaultKind`. */
  rules: Rule[];
  cats: Cats;
  myLevel: number;
  /** Per-aspect feedstock targets, against the AspectItems already held. */
  aspectTargets?: Record<string, number>;
}

export const otherKind = (k: Kind): Kind => (k === "keep" ? "sell" : "keep");
/** `only` acts on the kind's own extreme; `except` SPARES it and acts on the rest. Keying on kind alone
 *  made "sell everything except the 4" spare the four WORST and sell the good ones. */
const OWN_END: Record<Kind, Dir> = { keep: "desc", sell: "asc" };
export const defaultDir = (kind: Kind, mode: Take["mode"] | null): Dir =>
  mode === "except" ? (OWN_END[kind] === "desc" ? "asc" : "desc") : OWN_END[kind];

export const newRule = (kind: Kind, id: string): Rule => ({
  id,
  where: {},
  group: ["t", "s"],
  order: { f: "m", dir: defaultDir(kind, "except") },
  take: null,
  having: null,
});

// ---------------------------------------------------------------------------------------------------
// What the bridge refuses. `favourite` first: it is the flag a player sets deliberately, so proposing a
// favourited item would be this feature's worst failure. Absent fields mean UNKNOWN, never "allowed".
// ---------------------------------------------------------------------------------------------------
export function cantSell(it: Item): string | null {
  if (it.favourite) return "favourited";
  if (it.canSell === false) return "the game refuses to sell it";
  if (it.missionItem) return "mission item";
  if (it.criticalItem) return "critical item";
  if (!((it.sellValue ?? 0) > 0)) return "no sell value";
  return null;
}

// ---------------------------------------------------------------------------------------------------
// Matching
// ---------------------------------------------------------------------------------------------------
/**
 * What a `set` or `multi` field is worth on an item that has NONE of it — a module has no activity, a booster
 * no damage type — as a VALUE rather than as an absence.
 *
 * An absence matches nothing, and a rule of exceptions turns that into its opposite: "keep everything whose
 * activity is Combat" cannot match a module, so the default stance sells every module and booster the player
 * owns and the rule never mentioned them. Naming the case makes it tickable in the picker, visible in the
 * split, and sayable in the sentence — the fix is that the player can SEE it, not that the matcher guesses.
 */
export const NO_VALUE = "none";

/**
 * How a stored value READS. Only where the two differ: a value is a key first — a saved rule holds it, an
 * exported list carries it between playthroughs — so it is never renamed to make a sentence nicer.
 *
 * `activity: Other` is the one that costs something. `catOf` answers Combat|Mining|Salvage|Other, and Other is
 * every reactor, engine, scanner and hull kit the player owns — so "keep everything whose activity is Combat,
 * Mining or Salvage" sells all of them, and the value that would have said so is a word the player reads as
 * "some other activity" rather than as "no activity at all".
 */
export const valueLabel = (field: string, v: string): string =>
  v === NO_VALUE ? "none"
  : field === "a" && v === "Other" ? "no activity (modules, boosters)"
  : v;

export const asList = (v: string | number | string[] | null | undefined): string[] => {
  if (v == null) return [NO_VALUE];
  const xs = Array.isArray(v) ? v.map(String) : [String(v)];
  return xs.length ? xs : [NO_VALUE];
};

/**
 * The FIRST clause this item fails, as its clause key — null when the item matches the whole filter.
 *
 * The matcher answers "which", and `matchesWhere` asks it for "whether". A filter that only reports a boolean
 * leaves the split with a count and no reason, and the only way to learn which clause dropped an item is to
 * take the clause off and watch the number move.
 *
 * Clauses are tested in the order the rule stores them, so the named one is the first the player wrote that
 * this item fails — not the only one it fails.
 */
export function whereFail(it: Item, where: Where, ctx: FieldCtx): string | null {
  for (const [k, cond] of Object.entries(where)) {
    const F = FIELDS[fieldOf(k)];
    if (!F) continue; // a rule may name a field this build does not have — inert, never a throw
    if (F.kind === "range") {
      const c = cond as RangeCond;
      // A half-written comparison matches everything on purpose, rather than nothing.
      if (c.min == null && c.max == null) continue;
      const v = Number(F.get(it, ctx) ?? 0);
      if (c.min != null && v < c.min) return k;
      if (c.max != null && v > c.max) return k;
    } else {
      const c = cond as SetCond;
      if (!c.values?.length) continue;
      const have = asList(F.get(it, ctx));
      // ONE test for every reading: count the ticked values the item carries and compare against what the clause
      // needs. `not` then inverts it, which is why the two negatives are different sets — below one is "none of
      // them", below all is "missing at least one" — and why the sentence has to say which (see `setQOf`).
      const got = c.values.reduce((n, v) => n + (have.includes(String(v)) ? 1 : 0), 0);
      const hit = got >= needCount(c);
      if (c.not ? hit : !hit) return k;
    }
  }
  return null;
}

export const matchesWhere = (it: Item, where: Where, ctx: FieldCtx): boolean =>
  whereFail(it, where, ctx) === null;

/** Does a ranking by this measure mean anything for this rule? Power is a number only inside ONE unit:
 *  grouping by type, activity or main stat pins one, and so does filtering down to a single one. */
export function pinsUnit(rule: Rule): boolean {
  const single = (k: string) => clauseKeys(rule.where, k).some((key) => {
    const c = rule.where[key] as SetCond | undefined;
    return !!c?.values && c.values.length === 1 && !c.not;
  });
  return ["a", "t", "ms"].some((k) => rule.group.includes(k) || single(k));
}

// `ctx` is unused today but kept in the signature: a measure derived from a context value (level vs mine)
// would need it, and every other entry point already takes one.
export const orderOptions = (rule: Rule, items: Item[], _ctx?: FieldCtx) =>
  Object.entries(ORDERS).filter(([k, o]) => {
    if (o.pooled && !pinsUnit(rule)) return false;
    // A measure that is CONSTANT across the inventory makes the cut arbitrary and says nothing about it.
    return new Set(items.map((it) => rankVal(it, k))).size > 1;
  });

// ---------------------------------------------------------------------------------------------------
// What a rule does
// ---------------------------------------------------------------------------------------------------
export interface Row { it: Item; in: boolean }
export interface Group {
  key: string;
  /** The key split by the rule's GROUP BY fields, in that order — a tree, before it is flattened for display. */
  parts: string[];
  held: number;
  sitsOut: boolean;
  rows: Row[];
  nIn: number;
  nOut: number;
}
/** An item no clause selected, WITH the clause that turned it away — see `whereFail`. `k` is null only for a
 *  rule with no clauses at all, which selects everything and excludes nothing. */
export interface Excluded { it: Item; k: string | null }

export interface Explain {
  groups: Group[];
  /** Selected by no filter — they take the default stance. */
  excluded: Excluded[];
  /** Removed before matching: the game will not sell them at all. */
  protected: Item[];
  /** Indices into the input list that this rule acts on. */
  inSet: Set<number>;
}

export function explain(rule: Rule, items: Item[], ctx: FieldCtx): Explain {
  const cand: { it: Item; i: number }[] = [];
  const excluded: Excluded[] = [];
  const prot: Item[] = [];
  items.forEach((it, i) => {
    // Protected items are out of the question entirely — not candidates, not "out", not "not selected".
    if (cantSell(it)) { prot.push(it); return; }
    const k = whereFail(it, rule.where, ctx);
    if (k === null) cand.push({ it, i });
    else excluded.push({ it, k });
  });

  const buckets = new Map<string, { it: Item; i: number }[]>();
  const partsOf = new Map<string, string[]>();
  for (const x of cand) {
    const parts = rule.take && rule.group.length
      ? rule.group.map((f) => asList(FIELDS[f]?.get(x.it, ctx)).join("+"))
      : ["everything"];
    const key = parts.join(" · ");
    partsOf.set(key, parts);
    const arr = buckets.get(key);
    if (arr) arr.push(x); else buckets.set(key, [x]);
  }

  const groups: Group[] = [];
  const inSet = new Set<number>();
  for (const [key, arr] of buckets) {
    const held = arr.reduce((n, x) => n + Math.max(1, x.it.count ?? 1), 0);
    const sitsOut = !!rule.having && !(rule.having.op === "gt" ? held > rule.having.n : held < rule.having.n);
    if (rule.take) {
      arr.sort((p, q) => {
        const d = rankVal(q.it, rule.order.f) - rankVal(p.it, rule.order.f);
        return rule.order.dir === "desc" ? d : -d;
      });
    }
    let n = 0;
    const rows: Row[] = arr.map((x) => {
      const before = n;
      n += Math.max(1, x.it.count ?? 1);
      const isIn = sitsOut ? false
        : !rule.take ? true
        : rule.take.mode === "only" ? before < rule.take.n : !(before < rule.take.n);
      if (isIn) inSet.add(x.i);
      return { it: x.it, in: isIn };
    });
    groups.push({ key, parts: partsOf.get(key) ?? [key], held, sitsOut, rows, nIn: rows.filter((r) => r.in).length, nOut: rows.filter((r) => !r.in).length });
  }
  groups.sort((a, b) => b.nIn - a.nIn || b.held - a.held);
  return { groups, excluded, protected: prot, inSet };
}

export const runRule = (rule: Rule, items: Item[], ctx: FieldCtx) => explain(rule, items, ctx).inSet;

export type Verdict = Kind | "cant";

/** One verdict per item, in input order. `extra` scores a draft rule alongside the saved ones. */
export function evaluate(items: Item[], set: RuleSet, extra?: Rule | null): Verdict[] {
  const ctx: FieldCtx = { cats: set.cats, myLevel: set.myLevel };
  const matched = new Set<number>();
  for (const r of extra ? [...set.rules, extra] : set.rules)
    for (const i of runRule(r, items, ctx)) matched.add(i);
  const other = otherKind(set.defaultKind);
  return items.map((it, i) => (cantSell(it) ? "cant" : matched.has(i) ? other : set.defaultKind));
}

/** Credits the sold rows would bring in. Money is per UNIT; the counts elsewhere are per item. */
export const proceeds = (items: Item[], verdicts: Verdict[]) =>
  items.reduce((n, it, i) => (verdicts[i] === "sell" ? n + Math.max(1, it.count ?? 1) * (it.sellValue ?? 0) : n), 0);

// ---------------------------------------------------------------------------------------------------
// Saying it in English. One clause per line: each survives being read alone, which a single run-on line
// did not — and each is one message with slots, which is the only shape a translator can work with.
// ---------------------------------------------------------------------------------------------------
const joinWords = (xs: string[], word: string) =>
  xs.length < 2 ? (xs[0] ?? "") : xs.slice(0, -1).join(", ") + ` ${word} ` + xs[xs.length - 1];
/** A filter's values are alternatives; a grouping is a conjunction. One helper produced "each type or size". */
export const listWords = (xs: string[]) => joinWords(xs, "or");
export const groupWords = (xs: string[]) => joinWords(xs, "and");
export const groupLabel = (g: string[]) => "each " + groupWords(g.map((k) => FIELDS[k]?.label ?? k));
export const dirWord = (dir: Dir, f: string) =>
  ORDERS[f]?.counting ? (dir === "desc" ? "most" : "fewest") : dir === "desc" ? "highest" : "lowest";

/**
 * One set clause as a phrase, in the SAME reading the control shows (`setQOf`). Each caller supplies the two
 * prepositions that fit its own field — "carrying" reads wrong over categories, "in" reads wrong over aspects —
 * and the counted and negated readings are built from them here so no caller can word one differently.
 *
 * A threshold joins its values with "or" (any 2 OF THESE), an "all" with "and" (this one AND that one): the
 * conjunction is part of what the clause means, not decoration.
 */
const setPhrase = (c: SetCond, yes: string, no: string, notAll: string) => {
  const q = setQOf(c);
  const n = needCount(c);
  switch (q) {
    case "any":     return `${yes} ${listWords(c.values)}`;
    case "all":     return `${yes} ${groupWords(c.values)}`;
    case "atLeast": return `${yes} at least ${n} of ${listWords(c.values)}`;
    case "none":    return `${no} ${listWords(c.values)}`;
    case "notAll":  return `${notAll} ${groupWords(c.values)}`;
    case "fewer":   return `${yes} fewer than ${n} of ${listWords(c.values)}`;
  }
};

/** A canonical clause order, so the sentence reads the same however the filters were added — and so the
 *  absolute level clause always precedes the relative one that leans on it for its noun. */
const PHRASE_ORDER = ["c", "st", "a", "s", "r", "t", "cat", "dt", "ms", "mv", "l", "lrel", "v", "p", "own", "subN", "aspN", "aspE", "asp", "sub"];

/** `everything` is what the phrase says when no clause narrows it: the sell list speaks of what you own, the
 *  shopping list of what is on offer, and the same clauses read either way round. */
export function subjectPhrase(where: Where, everything = "everything I own"): string {
  const adj: string[] = [], rel: string[] = [];
  // Clauses about one field keep the order the rule holds them in: the sort is stable, and their shared field
  // gives them one place in the canonical order.
  const ordered = Object.entries(where).sort(
    (x, y) => ((PHRASE_ORDER.indexOf(fieldOf(x[0])) + 1) || 99) - ((PHRASE_ORDER.indexOf(fieldOf(y[0])) + 1) || 99));
  for (const [key, cond] of ordered) {
    const k = fieldOf(key);
    const F = FIELDS[k];
    if (!F) continue;
    if (k === "lrel") {
      const c = cond as RangeCond, p: string[] = [];
      // The editor's own words (`relTermOf`), so a rule reads the same in the chip that wrote it. Zero is the
      // one bound no offset phrasing fits — "0 above my level" is my level — so it keeps its own wording.
      // The distance-free readings are said whole, in the editor's own words.
      const fixed = relFixedQ(c);
      if (fixed) p.push(fixed === "exactly" ? "exactly my own level" : `${fixed} my own level`);
      for (const side of fixed ? [] : (["min", "max"] as const)) {
        const v = side === "min" ? c.min : c.max;
        if (v == null) continue;
        if (v === 0) { p.push(side === "min" ? "at or above my own level" : "at or below my own level"); continue; }
        const t = relTermOf(c, side)!;
        p.push(`${t.q} ${t.n} ${t.dir} my level`);
      }
      // No "whose level is" when the absolute clause has already said it, and one when it has not.
      if (p.length) rel.push((hasField(where, "l") ? "" : "whose level is ") + p.join(" and "));
    } else if (k === "own") {
      // A holding is something you HAVE, not a property of the offer: "whose copies owned is at most 1" reads as
      // a fact about the item on the shelf, and the clause is about the shelf at home.
      const c = cond as RangeCond, p: string[] = [];
      if (c.max != null) p.push("at most " + c.max);
      if (c.min != null) p.push("at least " + c.min);
      if (p.length) rel.push(`that I already own ${p.join(" and ")} of`);
    } else if (F.kind === "range") {
      const c = cond as RangeCond, p: string[] = [];
      if (c.min != null) p.push("at least " + c.min);
      if (c.max != null) p.push("at most " + c.max);
      if (p.length) rel.push(`whose ${F.label} is ${p.join(" and ")}`);
    } else {
      const c = cond as SetCond;
      if (!c.values?.length) continue;
      if (k === "asp") rel.push(setPhrase(c, "carrying", "without", "not carrying all of"));
      else if (k === "sub") rel.push(setPhrase(c, "with", "without", "missing at least one of"));
      else if (k === "cat") rel.push(setPhrase(c, "in", "outside", "not in all of"));
      // The field is called `substats count` so the picker cannot be mistaken for `substat`, but a sentence
      // counts the things themselves: "with 2 or 3 substats", never "with 2 or 3 substats count".
      else if (k === "subN")
        rel.push(`${c.not ? "without" : "with"} ${listWords(c.values)} substat${c.values.length === 1 && c.values[0] === "1" ? "" : "s"}`);
      else if (F.counting) rel.push(`${c.not ? "without" : "with"} ${listWords(c.values)} ${F.label}`);
      else {
        // These read as ADJECTIVES on the subject — "everything Legendary, Large" — which only the two plain
        // readings fit. A counted one ("at least 2 of Mining, Combat") is a fact about a list, so it moves to a
        // relative clause instead of being forced into the noun phrase.
        const labelled = { ...c, values: c.values.map((v) => valueLabel(k, v)) };
        const q = setQOf(c);
        const several = F.kind === "multi";
        // The adjective form cannot say AND: two clauses over one field, both read as adjectives, give
        // "everything Legendary, Exotic" — which is what ONE clause's own OR already reads as. So a field
        // carrying several clauses names itself in each of them.
        if (clauseKeys(where, k).length > 1)
          rel.push(`whose ${F.label} ` + setPhrase(labelled,
            several ? "has" : "is", several ? "has none of" : "is not",
            several ? "is missing at least one of" : "is not all of"));
        else if (q === "any") adj.push(listWords(labelled.values));
        else if (q === "none") adj.push("not " + listWords(labelled.values));
        else rel.push(setPhrase(labelled, "with", "without", "missing at least one of"));
      }
    }
  }
  let out = adj.length ? "everything " + adj.join(", ") : everything;
  if (rel.length) out += " " + rel.join(" and ");
  return out;
}

export interface Clause { lead: string; text: string }

export function clauses(rule: Rule, kind: Kind, items?: Item[]): Clause[] {
  const out: Clause[] = [{ lead: kind === "keep" ? "Keep" : "Sell", text: subjectPhrase(rule.where) }];
  if (rule.take) {
    out.push({
      lead: rule.take.mode === "only" ? "but only" : "except",
      text: `the ${rule.take.n} with the ${dirWord(rule.order.dir, rule.order.f)} ${ORDERS[rule.order.f]?.label ?? rule.order.f}`,
    });
    if (rule.group.length) out.push({ lead: "counting", text: groupLabel(rule.group) + " separately" });
  }
  if (rule.having)
    out.push({ lead: "and only where", text: `I hold ${rule.having.op === "gt" ? "more" : "fewer"} than ${rule.having.n}` });
  // A saved rule can outlive the inventory that made its measure meaningful.
  if (items && rule.take && new Set(items.map((it) => rankVal(it, rule.order.f))).size <= 1)
    out.push({ lead: "⚠", text: `every item has the same ${ORDERS[rule.order.f]?.label ?? rule.order.f}, so which ones are picked is arbitrary` });
  return out;
}

export const sentence = (rule: Rule, kind: Kind) =>
  clauses(rule, kind).map((c) => `${c.lead} ${c.text}`).join(" ") + ".";

/** Aspect stock: the portable `AspectItem`s already held, keyed by aspect name. Extraction destroys
 *  the source gear, so a carrier can be worth more than its headline says. */
export function aspectStock(all: Item[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const it of all) {
    const m = /^Aspect: (.+)$/.exec(it.name ?? "");
    if (m) out[m[1]] = (out[m[1]] ?? 0) + Math.max(1, it.count ?? 1);
  }
  return out;
}

/** `isTurret` is re-exported so a consumer needs one import for the vocabulary. */
export { isTurret };

// ---------------------------------------------------------------------------------------------------
// Portable rule lists. A list is the one piece of this feature's state that is deliberately
// playthrough-INDEPENDENT — the reason to save one is to use it on the next save — so it travels as a file
// and carries its own definitions. A rule's selector is STRINGS, and two of them name things that live
// outside the list: a `cat` is a key into the player's OWN vocabulary, and a `t` is a game identifier a
// different build may not ship. Both resolve to "matched nothing" in silence, which is why an import
// REPORTS instead of hoping.
// ---------------------------------------------------------------------------------------------------
export const LIST_VERSION = 1;

export interface SellListFile {
  v: number;
  name: string;
  defaultKind: Kind;
  rules: Rule[];
  /** Only the categories these rules reference — enough to run the list, nothing more. */
  cats: Cats;
}

/** Every value the rule's clauses about this field name — across all of them, since a field can carry several. */
const setValues = (rule: Rule, field: string): string[] =>
  clauseKeys(rule.where, field).flatMap((k) => (rule.where[k] as SetCond | undefined)?.values ?? []);
/** Every category name the rules mention, whether or not this browser defines it. */
export const referencedCats = (rules: Rule[]): string[] =>
  [...new Set(rules.flatMap((r) => setValues(r, "cat")))].sort();

export function exportList(name: string, defaultKind: Kind, rules: Rule[], cats: Cats): SellListFile {
  const used: Cats = {};
  for (const c of referencedCats(rules)) if (cats[c]) used[c] = [...cats[c]];
  return { v: LIST_VERSION, name, defaultKind, rules: structuredClone(rules), cats: used };
}

/** Shape check for a file that came from outside. Returns the list, or the reason it cannot be one. */
export function parseList(data: unknown): { list: SellListFile | null; error: string | null } {
  const o = data as Partial<SellListFile> | null;
  if (!o || typeof o !== "object") return { list: null, error: "not a sell-list file" };
  if (!Array.isArray(o.rules)) return { list: null, error: "no rules in this file" };
  if (o.defaultKind !== "keep" && o.defaultKind !== "sell")
    return { list: null, error: "the default stance is missing — a list without one decides nothing" };
  if (typeof o.v === "number" && o.v > LIST_VERSION)
    return { list: null, error: `written by a newer version (${o.v}) — this build reads ${LIST_VERSION}` };
  const rules: Rule[] = [];
  for (const r of o.rules as Partial<Rule>[]) {
    if (!r || typeof r !== "object" || typeof r.where !== "object" || !r.where) continue;
    rules.push({
      id: typeof r.id === "string" ? r.id : "r" + (rules.length + 1),
      where: r.where,
      group: Array.isArray(r.group) ? r.group : [],
      order: r.order?.f ? r.order : { f: "l", dir: "asc" },
      take: r.take ?? null,
      having: r.having ?? null,
    });
  }
  if (!rules.length) return { list: null, error: "no readable rules in this file" };
  const cats = (o.cats && typeof o.cats === "object" ? o.cats : {}) as Cats;
  return { list: { v: LIST_VERSION, name: typeof o.name === "string" ? o.name : "imported", defaultKind: o.defaultKind, rules, cats }, error: null };
}

/** Fold an imported list's categories into the player's own. A name already in use is NOT overwritten —
 *  their definition is the one every other surface already filters by — and the clash is reported. */
export function mergeCats(mine: Cats, theirs: Cats): { cats: Cats; added: string[]; kept: string[] } {
  const cats: Cats = { ...mine };
  const added: string[] = [], kept: string[] = [];
  for (const [name, types] of Object.entries(theirs)) {
    if (mine[name]) { if (mine[name].join("|") !== types.join("|")) kept.push(name); continue; }
    cats[name] = [...types];
    added.push(name);
  }
  return { cats, added: added.sort(), kept: kept.sort() };
}

/** What a list cannot resolve HERE: a category this browser does not define, or a type this inventory has
 *  never seen. Both match nothing in silence, so a rule carrying one is reported as inert rather than left
 *  to read as "nothing qualified today". */
export function listProblems(rules: Rule[], cats: Cats, items: Item[]): string[] {
  const types = new Set(items.map((it) => typeOf(it)).filter(Boolean) as string[]);
  const out: string[] = [];
  rules.forEach((r, i) => {
    const missCat = setValues(r, "cat").filter((c) => !cats[c]);
    const missType = setValues(r, "t").filter((t) => !types.has(t));
    if (missCat.length) out.push(`rule ${i + 1}: no category named ${listWords(missCat)} here — that clause matches nothing`);
    if (missType.length) out.push(`rule ${i + 1}: nothing of type ${listWords(missType)} in this inventory`);
  });
  return out;
}
