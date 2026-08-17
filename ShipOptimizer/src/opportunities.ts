import type { Item, ShipHardpoint } from "./types";
import { boosterId, boosterScore, boosterType, boosterValue, resonanceRank, type BoosterCtx } from "./booster";
import { shipFit } from "./itemKind";
import { moduleWhy, type ModuleCtx, type ShipPools } from "./fleetDps";
import { saturatedMainVal } from "./format";
import { turretFits, moduleFits, mayKeepEquipped, type GearFilter } from "./gearFit";
import { wantSentence, wantedBy, type WantRule } from "./wantRules";
import type { FieldCtx } from "./sellRules";

// What the opportunity RAILS offer, and how each kind is scored.
//
// Lifted out of App.tsx, which was rendering the rails AND deciding what belongs on them. With no shared owner
// the rail's objective drifts from the gear tab's, and it recommends buying a turret the optimizer then refuses
// to fit. Scoring is a module of its own, so a change to what counts as an upgrade lands in one place.
//
// Each family scores by the SAME rule the tab that would apply it uses:
//   turrets  the gain function the caller passes in — the Gear tab's selected ranking, whole-battery in
//            expanded mode, so recommending and fitting cannot disagree
//   modules  `moduleBetter` — the DPS objective where it has an opinion, `compareModules` for the ties
//   boosters `boosterValue` — no damage model applies

// Config-aware turret opportunities: per hardpoint, rank candidates that fit the slot's CONFIGURED
// filter (Gear tab) and beat the equipped turret. Best instance per item name, biggest gain first.
//
// `score` is the Gear tab's SELECTED ranking, so the rail agrees with the tab it sends you to: under the
// expanded ranking a gun with a big headline stat but a poor firing cycle is not an upgrade, and offering it
// as one contradicts the optimizer one click away.
export function gearTurretOpps(cands: Item[], hps: ShipHardpoint[], filters: Record<number, GearFilter>, cats: Record<string, string[]>, gain: (equipped: Item, candidate: Item) => number): Opp[] {
  const best = new Map<string, Opp>();
  for (const hp of hps) {
    const eq = hp.equipped;
    if (!eq) continue; // empty slots are filled from the Gear tab
    const f = filters[hp.index] ?? { mode: "all" };
    const keepAllowed = mayKeepEquipped(eq, hp.size, f, cats);
    for (const c of cands) {
      if (!turretFits(c, hp.size, f, cats)) continue;
      const delta = gain(eq, c);
      if (!Number.isFinite(delta)) continue;
      // Right type already equipped → upgrades only. Wrong type (filter set, equipped doesn't match) →
      // offer any candidate of the configured type, even at lower power (a deliberate type switch).
      if (keepAllowed && delta <= 0) continue;
      const prev = best.get(c.name);
      if (!prev || delta > prev.delta)
        best.set(c.name, { item: c, replaces: eq, delta, slotLabel: `slot ${hp.index + 1}` });
    }
  }
  return [...best.values()].sort((a, b) => b.delta - a.delta);
}

export interface Opp {
  item: Item;
  // What it would displace, in the slot named by slotLabel. Absent on a WANTED row: a shopping rule says what
  // the player came for, which is a reason of its own and needs no incumbent to beat.
  replaces?: Item;
  delta: number;  // headline change; 0 when the win came from a tie-break, and always 0 on a wanted row
  // Which hardpoint or module slot the gain is FOR. An item is an upgrade in one slot and a downgrade in
  // another (pooled stats and the occupant's own aspects decide it), so a rail entry without its slot reads as
  // a contradiction of the gear tab, which shows whichever slot happens to be selected.
  slotLabel?: string;
  // The shopping rule that claimed this offer, in its own words. Present ⇒ the row is on the rail because the
  // player asked for it, not because it beats anything: `delta` says nothing and must not be shown as a gain.
  wanted?: string;
  // WHY this row is an upgrade, in the words of whatever decided it — a percentage of the battery where the
  // objective spoke, the tie-break that separated them where it did not. A `+0` with no reason reads as a
  // mistake, and three bugs in one day hid behind exactly that.
  why?: string;
}

// Module opportunities, judged by the SAME rule the gear tab uses (`moduleBetter`: the battery objective
// wherever it has an opinion, the comparator for the ties it cannot see). Scoring these on the headline alone —
// which is what the generic path did — offered modules the tab then declined to fit, and offered a scanner that
// cost the battery a crit aspect and 2,605 pooled Combat Power for a bigger Precision number.
export function gearModuleOpps(cands: Item[], mslots: { slot: string; size: string; equipped: Item | null }[],
                        energy: { used: number; capacity: number } | undefined, role: string | null,
                        pools?: ShipPools | null, turrets?: Item[]): Opp[] {
  const best = new Map<string, Opp>();
  const fit = shipFit(role, mslots, turrets ?? []);
  for (const m of mslots) {
    const eq = m.equipped;
    if (!eq) continue;   // an empty slot is filled from the Gear tab
    const en = energy && energy.capacity > 0
      ? { usedWithout: energy.used - (eq.powerUsage ?? 0), capacity: energy.capacity } : undefined;
    const mctx: ModuleCtx = { pools, turrets, energy: en, role, fit };
    for (const c of cands) {
      if (!moduleFits(c, m.slot, m.size)) continue;
      const verdict = moduleWhy(c, eq, mctx);
      if (!verdict.better) continue;
      // The rail's number is the headline change, which can be 0 when the win came from a tie-break — the entry
      // still belongs here, it just sorts below anything with a headline gain. SATURATED, like the decision that
      // put it here: a rail promising +4 tractor beams the objective priced at 0 is the rail disagreeing with the
      // tab about the same swap.
      const delta = (saturatedMainVal(c) ?? 0) - (saturatedMainVal(eq) ?? 0);
      const prev = best.get(c.name);
      // The REASON travels with the row: a module row's delta is a headline change, and where the headline ties the
      // number is 0 while the decision was made on something else entirely.
      if (!prev || delta > prev.delta)
        best.set(c.name, { item: c, replaces: eq, delta, slotLabel: m.slot, why: verdict.why });
    }
  }
  return [...best.values()].sort((a, b) => b.delta - a.delta);
}

// What the SHOPPING LIST adds to the shop rail: offers a want rule claims, whether or not anything comparable
// is equipped. The upgrade rows answer "does this beat what I fly with"; a want rule answers "is this what I
// came for", which is a question no ranking can be asked — a spare of a gun already fitted, a hull kit for a
// ship in a carrier, feedstock for an aspect.
//
// `taken` holds the item NAMES the upgrade rows already offer, so one offer never becomes two rows saying two
// different things about itself. Best-per-name here too (cheapest), matching what the upgrade rails do.
export function wantedOpps(offers: Item[], rules: WantRule[], ctx: FieldCtx, taken?: Set<string>): Opp[] {
  const best = new Map<string, Opp>();
  for (const it of offers) {
    if (taken?.has(it.name)) continue;
    const r = wantedBy(it, rules, ctx);
    if (!r) continue;
    const prev = best.get(it.name);
    if (!prev || creditPrice(it) < creditPrice(prev.item))
      best.set(it.name, { item: it, delta: 0, wanted: wantSentence(r) });
  }
  // Cheapest first: the rail is read to decide what to spend on next. A barter offer has no credit price to
  // compare, so it sorts last rather than as though it were free.
  return [...best.values()].sort((a, b) => creditPrice(a.item) - creditPrice(b.item));
}

const creditPrice = (it: Item) => (it.costItem ? Number.POSITIVE_INFINITY : it.cost ?? 0);

/**
 * The shop rail in reading order: WANTS first, upgrades after.
 *
 * An upgrade row is the app's own idea; a want row is an instruction the player wrote down, and an instruction
 * outranks a suggestion on the surface that spends money. On a station with a dozen upgrades the ★ rows were
 * below the fold, which breaks the shopping list's one promise — that what you came for is in front of you when
 * you dock.
 *
 * An offer a want claims AND an upgrade beats is not here twice: `wantedOpps` yields it to the upgrade row (that
 * row says strictly more), so this only moves the rows the wants own. Order WITHIN each block is each scorer's
 * own — cheapest-first for wants, biggest-delta-first for upgrades.
 */
export const shopRailRows = (upgrades: Opp[], wanted: Opp[]): Opp[] => [...wanted, ...upgrades];

/**
 * Config-aware booster opportunities: per booster slot, candidates of the slot's CONFIGURED type that beat the
 * equipped booster.
 *
 * `ctx` is the SAME reading the booster tab optimizes under — the resonance scope and the ship's blocklist. Without
 * it the rail ranked on raw main-stat value alone ∴ it offered boosters the optimizer would refuse, and kept
 * offering a bonus the player had explicitly said not to chase on this ship: a suggestion that contradicts the
 * setting the player just changed reads as the app ignoring them.
 *
 * The DELTA stays in raw main-stat units, because that is the figure on the row and the one a player compares by
 * eye. What `ctx` decides is WHICH candidates are better at all, not what the number says.
 */
export function gearBoosterOpps(
  cands: Item[], slotTypes: (string | null)[], equippedBySlot: (Item | null)[], ctx?: BoosterCtx | null,
  refused?: ReadonlySet<string>, locked?: ReadonlySet<number>,
): Opp[] {
  const best = new Map<string, Opp>();
  const score = (b: Item) => boosterScore(b, ctx);
  const rank = (b: Item) => resonanceRank(b, ctx);
  const out = refused ?? new Set<string>();
  const lockedSlots = locked ?? new Set<number>();
  slotTypes.forEach((type, i) => {
    if (!type) return;
    // A LOCKED slot is not answered here either. "Leave this one alone" said in the tab and an upgrade for
    // that same slot offered on the rail are two verdicts about one slot, which is the state V48 forbids.
    if (lockedSlots.has(i)) return;
    const eq = equippedBySlot[i];
    if (!eq) return; // upgrades only
    const eqVal = boosterValue(eq), eqScore = score(eq), eqRank = rank(eq);
    for (const c of cands) {
      // A REFUSED candidate is out of the pool, exactly as it is for the optimizer — the rail re-offering
      // what the tab was told to stop offering reads as the refusal never having been heard.
      if (out.has(boosterId(c))) continue;
      if (boosterType(c) !== type) continue;
      const v = boosterValue(c);
      // THE PLAYER'S ORDER FIRST, THEN THE SCORE — the same precedence `optimizeBoosters` ranks by, because a
      // rail that ordered these the other way round would offer what the tab would then refuse to fit.
      const cRank = rank(c);
      if (cRank > eqRank) continue;
      if (cRank === eqRank && score(c) <= eqScore) continue;
      // Ranked by score, reported in raw value — and a candidate that only wins on resonance still has to be
      // worth swapping for, so a row whose headline would go DOWN is not offered.
      if (v <= eqVal) continue;
      const delta = v - eqVal;
      const prev = best.get(c.name);
      if (!prev || delta > prev.delta) best.set(c.name, { item: c, replaces: eq, delta });
    }
  });
  return [...best.values()].sort((a, b) => b.delta - a.delta);
}
