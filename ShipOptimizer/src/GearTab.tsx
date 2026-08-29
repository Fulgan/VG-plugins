import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, itemIcon, type Conn } from "./api";
import type { CatalogTypes, Inventories, Item, ShipHardpoint, ShipLayout, Vitals } from "./types";
import { num, mainVal, effectiveMainVal } from "./format";
import { aspectDamageFraction, damageAspects } from "./aspect";
import { turretScore, scoreReasons, BASE_CRIT, type CritContext } from "./turretScore";
import { powerReadingOf, goalKeysFor, type PowerReading, activityOf, capacityWith, optimizeTurretSet, optimizeModuleSet, optimizeShipSet, poolsWithModules, optimizeTurretSetLayered, coversLayer, sameScale, background, setRank, rankGt, rankSub, worthSwitching, isCombat, moduleBetter, moduleGain, shortlist, MIN_GAIN, OBJECTIVE_TIE, type LayerRole, type LayerTarget, type ModuleCtx, type PowerActivity, defaultGoalOrder, goalReadingOf, goalRefuses, goalDrops, goalAccepts, goalUnread, allowanceBreach, DEFAULT_ALLOWANCE, type Breach, GOAL_KEYS, GOAL_LABEL, liveVeto, projectLayer, DEFAULT_LAYER_CAP, frontier, FRONTIER_STEPS, type FrontierPoint, type LayerReading,
  type GoalKey, type GoalReading, type Rank, type ReactorBudget, type ShipPools, type SlotChoice } from "./fleetDps";
import { AspectMarks } from "./AspectMark";
import { load, save, LAYER_CAP_KEY, ALLOWANCE_KEY, GOAL_ORDER_KEY } from "./storage";
import { atMaxQuality, atScope } from "./quality";
import { getScope, setSharedScope, subscribeScope, type Scope } from "./scope";
import { modelBlock, MODEL_BLOCK_TEXT } from "./arenaModel";
import { ACTIVITIES, catOf, activityLabel, compareModules, equippedIn, isTurret, shipFit, type Activity } from "./itemKind";
import SlotPickList from "./SlotPickList";
import SlotCard, { Vig as BaseVig, NewVig as BaseNewVig, FilterSelect, type FGroup, SlotLock } from "./SlotCard";
import { ItemTip } from "./ItemCard";
import { useEscape } from "./Modal";
import { turretFits, moduleFits, mayKeepEquipped, parseActivity, reachableLayers, type GearFilter } from "./gearFit";
import { energyDraw, reactorModifier } from "./reactor";
import GearTotals from "./GearTotals";
import GoalOrder from "./GoalOrder";
import AllowanceSweep from "./AllowanceSweep";
import { defenseLayerOf } from "./activityPresets";
import ApplyBar, { ApplyMsg } from "./ApplyBar";
import PlanNotice, { type PlanVerdict } from "./PlanNotice";
import type { ApplyApi } from "./useApply";
import "./officers.css";

// Same physical fit? Used to tell whether a proposed item differs from what's equipped (so an already-
// applied change clears and isn't re-sent). Type/size/level/rarity + MAIN STAT value + aspects +
// substats — the main stat matters because two same-name rolls can differ only there. null+null = same.
// Aspects are excluded: they can be swapped at a workshop, so two otherwise-identical turrets are the same
// FIT whatever is currently socketed in them.
function sameFit(a: Item | null, b: Item | null): boolean {
  if (!a || !b) return !a && !b;
  return (a.type ?? a.name) === (b.type ?? b.name)
    && (a.size ?? "") === (b.size ?? "")
    && a.level === b.level && a.rarity === b.rarity
    && (a.mainStat?.amount ?? "") === (b.mainStat?.amount ?? "")
    && (a.stats ?? []).map((s) => `${s.stat}=${s.amount}`).sort().join(",") === (b.stats ?? []).map((s) => `${s.stat}=${s.amount}`).sort().join(",");
}

// One frozen empty set, so an unvisited ship's `manual` is referentially stable across renders.
const EMPTY_KEYS: Set<string> = new Set();

const SIZES = ["Small", "Medium", "Large", "Tiny"];

// Headline main-stat value, 0 when absent — the optimizer's ranking score. (Bonus lines on the same
// stat are deliberately NOT folded in here; that's `effectiveMainVal`, used by the tooltip pie.)
const power = (it: Item): number => mainVal(it) ?? 0;

// How gear is ranked. TWO modes, because they answer different questions and the second is an estimate:
//
//   simple    the headline main stat, exactly as the game prints it. Already a per-second figure (the damage
//             calc divides by the fire rate), which is why it has served well.
//   expanded  that baseline times what the ITEM's own rolls add: fire rate, crit, typed/generic damage and
//             aspects — none of which move the headline number. Hull and crew bonuses stay out because they
//             are equal for every candidate; the ship's CRIT setup is passed in, though, because it decides
//             how much an item's own crit roll is worth.
// A THIRD MODE, and it is the arena model rather than another reading of the same numbers:
// `simple` and `expanded` both rank an ITEM, this one scores a whole BATTERY against a defender and
// answers in seconds. It is unreachable until an artifact is bundled — see `arenaModel.modelBlock`.
export type Ranking = "simple" | "expanded" | "model";
const RANK_KEY = "shipoptimizer.gearRanking";
// A PERSISTED `model` must not brick the tab on a build with no artifact, or on a hull the model cannot
// speak about: the stored choice is honoured only where it is usable, and falls back to the mode that is.
const loadRanking = () => load<Ranking>(RANK_KEY, "expanded");
const saveRanking = (r: Ranking) => save(RANK_KEY, r);

// Modules have no damage model, so they rank on their headline value — but the EFFECTIVE one, which folds in
// bonus lines and aspect boosts on that same stat. Ranking a reactor on the printed number alone is what let a
// bigger reactor beat one whose aspect grants it +10%. Turrets in `simple` mode keep the printed
// headline exactly as the game shows it, which is what that mode means.
// `turretScore` is a COMBAT damage model — fire rate, crit, typed and aspect DAMAGE. None of it applies to a
// mining or salvage gun, whose throughput is its share of its own power pool: scoring one with it ranked a
// 3,036 Mining Power autocannon over a 3,262 Cutter on 1.43 attacks/sec and a +25% damage aspect, neither of
// which mining reads. Non-combat turrets rank on their EFFECTIVE headline instead, which folds in the
// bonus lines and aspect boosts landing on that same stat — the measure modules already use.
// `model` never reaches here: the net scores a whole BATTERY and there is no per-item version of that
// quantity (pooled crit, attack speed and reload speed make an item's worth depend on the rest of the set).
// It reads as `expanded` so a stored preference cannot produce a wrong number while the mode is unreachable.
export const rankValue = (it: Item, mode: Ranking, crit: CritContext): number =>
  !isTurret(it) ? effectiveMainVal(it) ?? 0
  : mode === "simple" ? power(it)
  : isCombat(it) ? turretScore(it, crit).score
  : effectiveMainVal(it) ?? 0;
export { ACTIVITIES, catOf, activityLabel, isTurret };
export { ItemTip };
export type { Activity };

// A slot's "no proposal" verdict as text.
//
// A SECOND LINE ONLY WHERE IT SAYS SOMETHING THE FIRST CANNOT, which is the player's own rule: `remove all these
// filler texts that carry no information`. A sentence restating the label in longer words ("locked to current" →
// "you chose to keep what is fitted here") is noise on a card read at a glance, and the control it points at is
// already on the card. What survives is a FACT the card has nowhere else to put: the floor's percentage, why a
// balanced score can be zero, why a per-slot gain does not survive the whole battery.
function verdictText(v: { kind: string; n?: number; pct?: number } | undefined): { text: string; why?: string } | null {
  if (!v) return null;
  switch (v.kind) {
    case "locked":
      return { text: "locked to current" };
    case "pinned":
      return { text: "you set this" };
    case "empty-nofit":
      return { text: "nothing fits", why: "nothing owned matches this filter and size" };
    case "forced":
      return { text: "breaks this filter" };
    case "zero":
      return {
        text: `best of ${v.n} would score where this scores nothing`,
        why: "this battery reaches only one layer, so its balanced score is zero",
      };
    case "floor":
      return {
        text: `kept — best of ${v.n} beats it by only ${((v.pct ?? 0) * 100).toFixed(2)}%`,
        why: `under the ${MIN_GAIN * 100}% worth-it floor`,
      };
    case "unchosen":
      return {
        text: `kept — best of ${v.n} scores ${((v.pct ?? 0) * 100).toFixed(2)}% higher in this slot alone`,
        why: "the gain does not survive the whole battery — the pools are shared",
      };
    default:
      return { text: `kept — best of ${v.n}` };
  }
}

const isModule = (it: Item) => !!it.slotType && it.slotType !== "Hardpoint" && it.category !== "Turret" && it.category !== "Booster";
const handle = (it: Item) => `${it.location ?? ""}:${it.key}`;

// A gear slot key: "t:<index>" (turret) or "m:<EquipmentSlot>" (module).
// The filter TYPE and the fit predicates live in `gearFit.ts` — owned by no tab, because the opportunity
// rails and the sell list decide by them too.
type Filter = GearFilter;

// user categories persist (global)
const CAT_KEY = "shipoptimizer.turretCategories";
const loadCats = () => load<Record<string, string[]>>(CAT_KEY, {});
const saveCats = (c: Record<string, string[]>) => save(CAT_KEY, c);
// per-ship slot filters persist (keyed by ship guid), so a ship's gun-filter setup survives reloads.
const GF_KEY = "shipoptimizer.gearFilters";
type FiltersByShip = Record<string, Record<number, Filter>>;
const loadGF = () => load<FiltersByShip>(GF_KEY, {});
const saveGF = (m: FiltersByShip) => save(GF_KEY, m);
// The player's ranked stat goal, per ship, in the same shape and for the same reason as the filters above.
type OrderByShip = Record<string, GoalKey[]>;
// The officers tab owns "what is this ship for" and writes it here; the gear frontier READS it so the two
// objectives cannot disagree about which layer a hull tanks on.
const loadProfiles = (): Record<string, { combatLayer?: "armor" | "shield" }> =>
  load<{ profile?: Record<string, { combatLayer?: "armor" | "shield" }> }>("shipoptimizer.officerBuilder", {}).profile ?? {};
const loadGO = () => load<OrderByShip>(GOAL_ORDER_KEY, {});
const saveGO = (m: OrderByShip) => save(GOAL_ORDER_KEY, m);
// A stored order is only as good as the build that wrote it: a key this build does not have is dropped rather than
// carried into the comparator, where it would read as a stat nothing can measure. Duplicates go too — a key twice
// in a lexicographic scan makes the second copy unreachable, which is a silent way for an order to lie.
// A stored order written before the layer split named one key per activity, and that key read a POOL. MAPPED
// rather than dropped: dropping it would silently un-state a goal the player set, and leaving it would name a key
// that no longer exists. `balanced` is the honest translation — it is what the derived target already was for a
// hull whose slots are mixed, and it is the figure the panel prints under the same word.
const RETIRED_GOALS: Record<string, GoalKey> = { mining: "miningBalanced", salvage: "salvageBalanced" };

export const cleanOrder = (v: unknown): GoalKey[] => {
  if (!Array.isArray(v)) return [];
  const seen = new Set<string>();
  return v
    .map((k) => (typeof k === "string" && RETIRED_GOALS[k] ? RETIRED_GOALS[k] : k))
    .filter((k): k is GoalKey =>
      typeof k === "string" && (GOAL_KEYS as readonly string[]).includes(k) && !seen.has(k) && !!seen.add(k));
};
// Slots LOCKED to whatever is fitted, per ship. Distinct from `manual`, which pins a slot to an item the player
// PICKED: this says "leave this slot alone" and survives reloads and re-optimisation. It exists because not every
// hull is worth good gear — a size-1 ship that rides in a carrier gets a deliberately cheap module, and the
// optimizer offering to upgrade it forever is noise, not advice.
const KEEP_KEY = "shipoptimizer.gearKeep";
type KeepByShip = Record<string, string[]>;
const loadKeep = () => load<KeepByShip>(KEEP_KEY, {});
const saveKeep = (m: KeepByShip) => save(KEEP_KEY, m);
// Auto-suggest: re-run the optimizer whenever the inventory (or a filter) changes, like the booster tab
// does. On by default — the buttons stay for a manual re-run.
const AUTO_KEY = "shipoptimizer.gearAuto";
const loadAuto = () => load<boolean>(AUTO_KEY, true);
const saveAuto = (v: boolean) => save(AUTO_KEY, v);


/** One internal slot as the layout reports it. */
export type MSlot = { slot: string; size: string; equipped: Item | null };

/**
 * WHAT MAY GO IN THE OPEN HARDPOINTS, and how the battery that results is to be SCORED.
 *
 * One owner for three callers — the turret button, the joint button, and the ship-wide auto run — because every
 * part of it is a decision that must not be made twice: which candidates a slot's filter admits, whether KEEPING
 * the fitted gun is even allowed (`keepOk`), which layer a slot serves, the ship-level target those roles imply,
 * and WHICH ACTIVITY the whole comparison is in (V32 — score one candidate as Salvage and another as Mining and
 * the fatter pool always wins). A second copy is that bug waiting for the second button.
 */
export interface TurretPlan {
  slots: SlotChoice[];
  /** The same slots carrying their layer roles, for the layered search. */
  withRoles: SlotChoice[];
  target: LayerTarget;
  /** The layered activity, or null for combat — which has no layers and no pool of its own to bottleneck. */
  layerAct: PowerActivity | null;
  keepOk: (hp: ShipHardpoint) => boolean;
}

export function turretPlan(args: {
  open: ShipHardpoint[]; hps: ShipHardpoint[]; gear: Item[]; filters: Record<number, Filter>;
  cats: Record<string, string[]>; used: Set<string>; role: string | null;
  /** The single layer to fall back to when nothing owned reaches the other — see `layerPlan`. */
  degradeTo: LayerTarget | null;
}): TurretPlan {
  const { open, hps, gear, filters, cats, used, role, degradeTo } = args;
  const filterOf = (hp: ShipHardpoint) => filters[hp.index] ?? ({ mode: "all" } as Filter);
  // A slot filter is a RESTRICTION on what may be FITTED, not merely on what may be considered. So when a filter
  // is set and the equipped gun does not satisfy it, keeping that gun is not an option — the answer has to be a
  // switch, even at lower power, which is what the player asked for by setting the filter.
  const keepOk = (hp: ShipHardpoint) => mayKeepEquipped(hp.equipped, hp.size, filterOf(hp), cats);
  const slots: SlotChoice[] = open.map((hp) => ({
    key: `t:${hp.index}`,
    // KEEPING what is fitted is an option — unless the filter rules it out. Without the equipped item as a
    // candidate the optimizer would have to name an inventory item for every slot, and a separate "is it better?"
    // test would have to undo that against a different baseline.
    current: keepOk(hp) ? hp.equipped : undefined,
    candidates: [
      ...(hp.equipped && keepOk(hp) ? [hp.equipped] : []),
      // Shortlisted, because the search is linear in this list and runs once per layer assignment: a long
      // playthrough's armory holds thousands of guns per size, of which only the best on each axis can win.
      ...shortlist(gear.filter((g) => turretFits(g, hp.size, filterOf(hp), cats) && !used.has(handle(g)))),
    ],
  }));
  // A slot's layer ROLE is derived from its own filter — no second piece of state to keep in step, and the
  // "Set all to…" bulk write already reaches it. `mixed`/no filter leaves the slot open for the meta search.
  const roleOf = (hp: ShipHardpoint): LayerRole => {
    const f = filterOf(hp);
    if (f.mode !== "activity") return "any";
    const { layer } = parseActivity(f.value);
    return layer === "Surface" ? "surface" : layer === "Core" ? "core" : "any";
  };
  const withRoles = slots.map((sl, i) => ({ ...sl, layerRole: roleOf(open[i]) }));
  // The ship-level TARGET follows from those roles rather than being its own control: pin every slot to one layer
  // and that is plainly what you are building for; leave them open and both layers are wanted.
  const roles = withRoles.map((sl) => sl.layerRole);
  let target: LayerTarget =
    roles.every((r) => r === "surface") ? "surface"
    : roles.every((r) => r === "core") ? "core"
    : "balanced";
  // WHICH activity, in order: a slot FILTER naming one (an explicit instruction, and also what generated the
  // candidates), then what is FITTED, then the hull's role. Never the candidate pool — that holds every gun of
  // the right size, so a salvage hull whose owner also owns mining lasers resolved to "Mining".
  const filterActs = new Set(open
    .map((hp) => filterOf(hp))
    .filter((f) => f.mode === "activity")
    .map((f) => parseActivity(f.value).act));
  const filterAct = filterActs.size === 1 ? [...filterActs][0] : null;
  const fittedAct = activityOf(hps.map((hp) => hp.equipped).filter((x): x is Item => !!x));
  const roleAct = role === "Mining" || role === "Salvaging" ? (role === "Mining" ? "Mining" : "Salvage") : null;
  const wantedAct = filterAct ?? fittedAct ?? roleAct;
  const layerAct: PowerActivity | null =
    wantedAct === "Mining" || wantedAct === "Salvage" ? (wantedAct as PowerActivity) : null;
  // Balance is only REQUIRED where achievable: if nothing you own reaches a layer, demanding both would score
  // every build 0 and the tab would go silent.
  if (target === "balanced" && degradeTo) target = degradeTo;
  return { slots, withRoles, target, layerAct, keepOk };
}

/** What may go in the open MODULE slots. Same one-owner reason: the joint search fills these too. */
export function modulePlan(args: { open: MSlot[]; gear: Item[]; used: Set<string> }): {
  slots: SlotChoice[]; fitsFor: (m: MSlot) => Item[];
} {
  const { open, gear, used } = args;
  const fitsFor = (m: MSlot) => [
    ...(m.equipped ? [m.equipped] : []),
    ...gear.filter((g) => moduleFits(g, m.slot, m.size) && !used.has(handle(g))),
  ];
  return { fitsFor, slots: open.map((m) => ({ key: `m:${m.slot}`, current: m.equipped, candidates: fitsFor(m) })) };
}

/** What the builder needs to answer one slot. Passed explicitly so the answer is a pure function of the plan. */
export interface SlotCtx {
  hps: ShipHardpoint[];
  mslots: MSlot[];
  gear: Item[];
  filters: Record<number, Filter>;
  cats: Record<string, string[]>;
  pools: ShipPools | null;
  ranking: Ranking;
  crit: CritContext;
  role: string | null;
}

/**
 * The best item for ONE slot, given a plan — or null for "leave it alone".
 *
 * The single owner of "what goes here". Both the per-slot ⚡ and the refill that follows a pick call it, so they
 * cannot disagree; a second copy is how the rail and the tab came to answer differently.
 *
 * `plan` is the assignment the answer is judged against, so the caller can ask about a plan it has not committed
 * yet. Turrets are scored on the WHOLE battery as it would then stand; modules use `compareModules`, which
 * has no damage model to share.
 */
export function answerSlot(key: string, plan: Record<string, Item>, ctx: SlotCtx): Item | null {
  const usedOther = new Set(Object.entries(plan).filter(([k]) => k !== key).map(([, it]) => handle(it)));
  if (key.startsWith("t:")) {
    const idx = Number(key.slice(2));
    const hp = ctx.hps.find((h) => h.index === idx);
    if (!hp) return null;
    const f = ctx.filters[idx] ?? { mode: "all" };
    const keepOk = mayKeepEquipped(hp.equipped, hp.size, f, ctx.cats);
    const fits = ctx.gear.filter((g) => turretFits(g, hp.size, f, ctx.cats) && !usedOther.has(handle(g)));
    if (ctx.ranking === "expanded" && ctx.pools) {
      const bg = background(ctx.pools, ctx.hps.map((h) => h.equipped).filter((x): x is Item => !!x));
      const others = ctx.hps.filter((h) => `t:${h.index}` !== key)
        .map((h) => plan[`t:${h.index}`] ?? h.equipped).filter((x): x is Item => !!x);
      const score = (it: Item): Rank => setRank([...others, it], bg);
      const asIs: Rank = hp.equipped ? score(hp.equipped) : [0, 0];
      const best = fits.reduce<Item | undefined>((a, b) => (!a || rankGt(score(b), score(a)) ? b : a), undefined);
      // An EMPTY hardpoint takes the best fit outright — there is no incumbent for a floor to measure against.
      const worth = best && (!keepOk || !hp.equipped || worthSwitching(score(best), asIs));
      return worth && best !== hp.equipped ? (best as Item) : null;
    }
    const eqPow = hp.equipped ? power(hp.equipped) : 0;
    const best = fits.sort((x, y) => power(y) - power(x))[0];
    return best && (!keepOk || power(best) > eqPow) ? best : null;
  }
  const slot = key.slice(2);
  const m = ctx.mslots.find((x) => x.slot === slot);
  if (!m) return null;
  const e = ctx.pools?.energy;
  const en = e && e.capacity > 0 ? { usedWithout: e.used - (m.equipped?.powerUsage ?? 0), capacity: e.capacity } : undefined;
  // A module pools its stats like everything else, so in EXPANDED mode it is judged on the battery it changes
  // — Precision, Combat Power, a crit aspect and the draw priced against each other — and the comparator only
  // breaks the ties that objective cannot see.
  const turrets = ctx.hps.map((h) => plan[`t:${h.index}`] ?? h.equipped).filter((x): x is Item => !!x);
  const mctx: ModuleCtx = {
    pools: ctx.ranking === "expanded" ? ctx.pools : null,
    turrets, energy: en, role: ctx.role, fit: shipFit(ctx.role, ctx.mslots, turrets),
  };
  const fits = ctx.gear.filter((g) => moduleFits(g, slot, m.size) && !usedOther.has(handle(g)));
  const cand = fits.reduce<Item | undefined>((a, b) => (!a || moduleBetter(b, a, mctx) ? b : a), undefined);
  return cand && moduleBetter(cand, m.equipped, mctx) ? cand : null;
}

export interface GearChange { key: string; kind: "Turret" | "Module"; label: string; current: Item | null; next: Item; }
export interface GearBuilder {
  gear: Item[];
  hps: ShipHardpoint[];
  mslots: { slot: string; size: string; equipped: Item | null }[];
  cats: Record<string, string[]>; setCats: (c: Record<string, string[]>) => void;
  filters: Record<number, Filter>; setFilters: (upd: (f: Record<number, Filter>) => Record<number, Filter>) => void;
  assign: Record<string, Item>;
  setAssign: (upd: (a: Record<string, Item>) => Record<string, Item>) => void;
  setSlotItem: (key: string, it: Item | null, pin?: boolean) => void;
  // Slots whose contents the player chose by hand. Auto-suggest leaves these alone, so the UI has to say which
  // they are — otherwise a pinned slot and an optimizer verdict look identical and "why didn't it change?" has
  // no visible answer.
  pinned: Set<string>;
  // Slots locked to what is fitted (persisted per ship). Suggestions skip them entirely — see KEEP_KEY.
  keep: Set<string>;
  toggleKeep: (key: string) => void;
  unpin: (key: string) => void;
  clearAll: () => void;
  suggestTurrets: () => void;
  suggestModules: () => void;
  /** ONE slot answered on request (the ⚡). Skips a pinned or locked slot, like every other suggest path. */
  suggestSlot: (key: string) => void;
  /** Both halves in one search — the whole build decided at once. */
  suggestShip: () => void;
  autoSuggest: boolean; setAutoSuggest: (v: boolean) => void;
  ranking: Ranking; setRanking: (r: Ranking) => void;
  crit: CritContext;
  pools?: ShipPools | null;
  payload: { kind: string; slot: number | string; store: string; key: number | null; name: string; level: number }[];
  changes: GearChange[];
  // Is the projected build WORSE than the fitted one? `true` means the union of individually-good changes is a
  // net loss, which the reactor bracket makes possible. `null` means unjudgeable — no pools, no proposals, or a
  // module-only plan this objective cannot see — and must NOT be rendered as reassurance.
  planRegresses: boolean | null;
  /** Tracked measurements this plan lowers past the warning level, worst first. */
  planDrops: { key: GoalKey; drop: number }[];
  /** The same verdict with its figures, for the notice that has to explain it. */
  planVerdict: PlanVerdict | null;
  // Set when the ship cannot reach one layer at all, so the score is single-layer BY NECESSITY rather than
  // by choice — the UI states it, since a silent substitution is indistinguishable from a bug.
  layerNote: string | null;
  /** The stats this ship is ranked on, in the player's own order. Empty = the objective has no opinion. */
  goalOrder: GoalKey[];
  /** Writes the order for THIS ship. Persisted per ship and pushed with the playthrough. */
  setGoalOrder: (next: GoalKey[]) => void;
  /** Ranked keys the plan on screen cannot be judged on, so the control can say so instead of implying a tie. */
  goalUnreadKeys: GoalKey[];
  /** The keys worth offering on THIS hull — see `goalKeysFor`. */
  goalKeysOffered: GoalKey[];
  // THE ALLOWANCE SWEPT, as real builds. Null until asked for: each point is a whole-ship search.
  tankLayer: "armor" | "shield" | null;
  frontierPts: FrontierPoint[] | null;
  frontierBusy: boolean;
  /** Steps solved, and the reading the rows are printed against — one snapshot for both. */
  frontierSolved: number | null;
  frontierNow: GoalReading | null;
  buildFrontier: () => void;
  applyFrontier: (p: FrontierPoint) => void;
  clearFrontier: () => void;
  /** Why a plan was withheld, when the player's order refused it rather than the floor. */
  goalNote: string | null;
  // What a plan may spend of any ONE defensive layer, as a fraction of the ship's own reading, and the setter
  // the tab's control writes through. Persisted and pushed with the playthrough: how much survivability a
  // player will trade is a way of flying, not a fact about a window.
  layerCap: number;
  /** Read every item as it IS, or at its workshop-quality ceiling. Shared with the officers tab (one control). */
  scope: Scope;
  setScope: (v: Scope) => void;
  /** What a plan may spend of a RANKED stat, as a fraction of the fitted build. A refusal, not a warning. */
  allowance: number;
  setAllowance: (v: number) => void;
  setLayerCap: (v: number) => void;
}

// Shared gear state (assignments + per-ship filters + categories), lifted into App so the Gear tab and
// the Summary tab work off one result.
export function useGearBuilder(layout: ShipLayout | null, inv: Inventories | null, currentShipGuid?: string | null, crit: CritContext = BASE_CRIT, poolsReported?: ShipPools | null, role?: string | null, vitals?: Vitals | null): GearBuilder {
  // The layout and the live ship can disagree for a moment after a ship change (separate fetches). Every
  // proposal is derived from the layout's slots, so while they disagree we suggest nothing and apply
  // nothing — a plan for the previous hull's hardpoints is worse than no plan.
  const layoutFresh = !!layout && (!currentShipGuid || layout.shipGuid === currentShipGuid);
  /**
   * CURRENT OR FULL POTENTIAL — the officers tab's own control, reused rather than copied (V?): the question is
   * identical, only the mechanism differs (there, an officer's unlocked skills; here, an item's workshop quality).
   *
   * EVERY item is read at the chosen scope, the fitted ones included, and that symmetry is the whole correctness
   * of it: scoring candidates at their ceiling against incumbents as they stand would favour whatever has the most
 * headroom left, which is a bias dressed as an upgrade.
   */
  const [scope, setScopeLocal] = useState<Scope>(getScope);
  // ⚠ RE-READ ON MOUNT, ⊥ only on notify. `primeScope` seeds the store from the officers' saved blob WITHOUT
  // notifying (it runs inside a `useState` initialiser, so notifying would set state during another component's
  // render), and this tab is constructed FIRST — it therefore took `DEFAULT_SCOPE` and never heard about the saved
  // one. A player whose saved scope was `current` got the officers tab on `current` and this one stuck on `full
  // potential`, both segmented controls disagreeing until one was clicked. Syncing here is order-independent.
  useEffect(() => {
    setScopeLocal(getScope());
    return subscribeScope(() => setScopeLocal(getScope()));
  }, []);
  const gear = useMemo<Item[]>(() => {
    const out: Item[] = [];
    for (const st of inv?.stores ?? [])
      for (const it of st.items)
        if (it.category === "Turret" || isModule({ ...it, location: st.id }))
          out.push(atScope({ ...it, location: st.id }, scope));
    return out;
  }, [inv, scope]);
  /**
   * THE BASELINE, RE-READ AT THE CHOSEN SCOPE. The bridge's pools describe the ship as it is ∴ at `potential` they
   * describe the wrong ship, and leaving them alone would score upgraded candidates against un-upgraded pools —
   * the asymmetry that makes a plan look like a gain because only one side of it was projected.
   *
   * IT CARRIES THE TURRETS, and here that is correct rather than the V76 double count. That rule exists because
   * `setDps` adds each gun's own MAIN power itself, so folding a proposed gun into the pool counts it twice.
   * Quality cannot cause that: it scales every line EXCEPT the main stat, so what moves here is only the pooled
   * substat half, and the main power `setDps` adds is the one number quality leaves alone.
   */
  const pools = useMemo<ShipPools | null>(() => {
    if (!poolsReported || scope !== "potential") return poolsReported ?? null;
    const fittedTurretsAndModules: (Item | null)[] = [
      ...(layout?.hardpoints ?? []).map((h) => h.equipped ?? null),
      ...(layout?.modules ?? []).map((m) => m.equipped ?? null),
    ];
    // scope-projection: the baseline itself, not a plan — both halves, main stat unscaled.
    return poolsWithModules(poolsReported, fittedTurretsAndModules,
                            fittedTurretsAndModules.map((x) => (x ? atMaxQuality(x) : null)));
  }, [poolsReported, scope, layout]);
  const shipGuid = layout?.shipGuid ?? "";
  const [cats, setCatsS] = useState<Record<string, string[]>>(loadCats);
  // Ranking mode is a per-user preference, not per ship: it is a question about how to judge gear.
  const [rankingStored, setRankingS] = useState<Ranking>(loadRanking);
  // WHAT THE TAB ACTUALLY RANKS BY. A stored `model` is honoured only where the model can answer — no
  // artifact bundled, or a hull it cannot speak about, and it reads as `expanded` instead. Otherwise a build
  // that ships without weights, or a swap to a mining hull, would silently rank on nothing.
  const ranking: Ranking = rankingStored === "model" && modelBlock(role) ? "expanded" : rankingStored;
  const setRanking = (r: Ranking) => { setRankingS(r); saveRanking(r); };
  const setCats = useCallback((c: Record<string, string[]>) => { setCatsS(c); saveCats(c); }, []);
  const [filtersByShip, setFiltersByShip] = useState<FiltersByShip>(loadGF);
  const filters = useMemo(() => filtersByShip[shipGuid] ?? {}, [filtersByShip, shipGuid]);
  const setFilters = useCallback((upd: (f: Record<number, Filter>) => Record<number, Filter>) =>
    setFiltersByShip((m) => { const next = { ...m, [shipGuid]: upd(m[shipGuid] ?? {}) }; saveGF(next); return next; }), [shipGuid]);
  // EVERY per-slot decision is bucketed by SHIP. Slot keys (`t:0`, `m:Reactor`) are identical on two hulls of the
  // same class, so a single bucket silently applies one ship's plan to the next — which is how a pinned slot on
  // ship A stopped ship B from ever suggesting anything. Bucketing also means switching away and back
  // KEEPS the plan, which is what outfitting several ships in one sitting needs.
  //
  // In memory, deliberately NOT localStorage: an item's `key` is its store SLOT, and a restock refills the same
  // slot with different goods — a plan persisted by handle would silently point at other items on
  // the next session. Presets exist for lasting intent and store DESCRIPTIONS for exactly that reason.
  // The writers read the ship from a REF, not from the closure. That keeps their identity stable — so the many
  // `useCallback`s that call them can keep empty dep lists — while still always writing the CURRENT ship's bucket.
  // A ship-bound closure instead would make every one of those callbacks stale the moment the ship changed, and a
  // stale writer silently files ship B's pick under ship A, which is worse than the bug being fixed.
  const shipRef = useRef(shipGuid);
  shipRef.current = shipGuid;
  const pinnedRef = useRef<Set<string>>(EMPTY_KEYS);
  const [assignAll, setAssignAll] = useState<Record<string, Record<string, Item>>>({});
  const assign = useMemo(() => assignAll[shipGuid] ?? {}, [assignAll, shipGuid]);
  const setAssign = useCallback((upd: Record<string, Item> | ((a: Record<string, Item>) => Record<string, Item>)) =>
    setAssignAll((m) => {
      const g = shipRef.current;
      return { ...m, [g]: typeof upd === "function" ? upd(m[g] ?? {}) : upd };
    }), []);
  // Slots the USER decided on (drag/drop, picking from the list, the per-slot ⚡, or clearing). Auto-suggest
  // leaves these alone — same idea as a forced booster: your explicit choice outranks the optimizer.
  const [manualAll, setManualAll] = useState<Record<string, Set<string>>>({});
  const manual = useMemo(() => manualAll[shipGuid] ?? EMPTY_KEYS, [manualAll, shipGuid]);
  const setManual = useCallback((upd: Set<string> | ((m: Set<string>) => Set<string>)) =>
    setManualAll((m) => {
      const g = shipRef.current;
      return { ...m, [g]: typeof upd === "function" ? upd(m[g] ?? EMPTY_KEYS) : upd };
    }), []);
  // Locked-to-current slots, loaded per ship and written straight back so the lock outlives a reload.
  const [keep, setKeepS] = useState<Set<string>>(() => new Set(loadKeep()[shipGuid ?? ""] ?? []));
  useEffect(() => { setKeepS(new Set(loadKeep()[shipGuid ?? ""] ?? [])); }, [shipGuid]);
  const toggleKeep = useCallback((key: string) => {
    setKeepS((prev) => {
      const n = new Set(prev);
      n.has(key) ? n.delete(key) : n.add(key);
      if (shipGuid) saveKeep({ ...loadKeep(), [shipGuid]: [...n] });
      return n;
    });
    // Locking must also drop any proposal standing for that slot, and unlocking has to let the optimizer look at
    // it again — otherwise the freed slot would stay empty until something else invalidated the signature.
    setAssign((a) => { const n = { ...a }; delete n[key]; return n; });
    lastRun.current = null;
  }, [shipGuid]);
  // PICKING an item is a deliberate choice and pins the slot, so the auto run never overwrites it. CLEARING is
  // not a choice — it dismisses a proposal — so it must NOT pin: if the player wanted the slot decided by hand
  // they would have picked something. It does suppress the auto run for the CURRENT signature, or auto-suggest
  // would put the proposal straight back and the × would do nothing visible.
  // `pin` marks the slot as the player's own choice so auto-suggest leaves it alone. A SUGGESTION must not pin
  // (it is the optimizer's answer, not a decision), and CLEARING releases the pin — a slot with nothing in it is
  // not a choice, and leaving it pinned meant suggestions skipped it forever. Clearing still suppresses the auto
  // run for the current state, or the proposal would reappear immediately.
  const setSlotItem = useCallback((key: string, it: Item | null, pin = true) => {
    if (it && pin) setManual((m) => new Set(m).add(key));
    if (!it) { setManual((m) => { const n = new Set(m); n.delete(key); return n; }); lastRun.current = sigRef.current; }
    setAssign((a) => {
      const n = { ...a };
      if (!it) { delete n[key]; return n; }
      // ONE physical item, ONE slot: there is a single copy of it in the armoury, so proposing it twice
      // would be a plan that cannot be applied. Picking it here therefore releases it from wherever it was —
      // the newest choice is the one the player means, and silently ignoring the second pick would be worse.
      const h = handle(it);
      const freed: string[] = [];
      for (const [k, v] of Object.entries(n)) if (k !== key && handle(v) === h) { delete n[k]; freed.push(k); }
      n[key] = it;
      // A slot that just lost its item must be RE-ANSWERED, not left blank. Only that slot: the rest of the plan is
      // untouched, so picking one item changes the slot you picked and the one you took it from, and nothing else.
      // A full re-run would be jointly optimal for the open slots but would also churn proposals you were happy
      // with, which is the behaviour this exists to avoid. `manual` slots are never refilled — they are decisions.
      const ctx = slotCtxRef.current;
      if (ctx) for (const k of freed) {
        if (pinnedRef.current.has(k)) continue;
        const next = answerSlot(k, n, ctx);
        if (next) n[k] = next;
      }
      return n;
    });
  }, []);
  // The inputs `answerSlot` needs, in a ref for the same reason the writers use one: `setSlotItem` keeps an empty
  // dep list, and reading these from its closure would answer a freed slot against the FIRST render's inventory.
  const slotCtxRef = useRef<SlotCtx | null>(null);
  pinnedRef.current = manual;
  const [autoSuggest, setAutoSuggestS] = useState<boolean>(loadAuto);
  const setAutoSuggest = useCallback((v: boolean) => { setAutoSuggestS(v); saveAuto(v); }, []);
  // Equipped items get their ship slot stamped on them (`slotKey`): they carry no store handle, so that
  // key is the only way to fetch their icon (see itemIcon in api.ts).
  const hps = useMemo(() => [...(layout?.hardpoints ?? [])]
    .sort((a, b) => a.index - b.index)
    .map((h) => (h.equipped ? { ...h, equipped: atScope({ ...h.equipped, slotKey: `t:${h.index}` }, scope) } : h)),
    [layout, scope]);
  const mslots = useMemo(() => (layout?.modules ?? [])
    .map((m) => (m.equipped ? { ...m, equipped: atScope({ ...m.equipped, slotKey: `m:${m.slot}` }, scope) } : m)),
    [layout, scope]);
  // No clear-on-switch: every per-slot decision is bucketed by ship above, so switching simply reads a different
  // bucket and switching BACK finds the plan intact. What still has to be guarded is a slot key that exists on one
  // hull and not another — `slotExists` and `fitsSlot` do that where the plan is read.
  // Does the current ship actually have this slot? Guards against assigns for slots not on this ship.
  const slotExists = useCallback((k: string): boolean =>
    k.startsWith("t:") ? hps.some((h) => h.index === Number(k.slice(2)))
                       : mslots.some((x) => x.slot === k.slice(2)), [hps, mslots]);
  // Does this item physically fit the slot as THIS ship has it? Slot keys survive a ship change (index 3
  // exists on both hulls) while the size behind them does not, so identity of the key is not enough.
  const fitsSlot = useCallback((k: string, it: Item): boolean => {
    if (k.startsWith("t:")) {
      const hp = hps.find((h) => h.index === Number(k.slice(2)));
      return !!hp && isTurret(it) && it.size === hp.size;
    }
    const slot = k.slice(2);
    const m = mslots.find((x) => x.slot === slot);
    return !!m && moduleFits(it, slot, m.size);
  }, [hps, mslots]);
  // Currently-equipped item for an assign key ("t:<idx>" hardpoint / "m:<slot>" module).
  const curOf = useCallback((k: string | null) => equippedIn(k, hps, mslots), [hps, mslots]);
  // Skip no-op assignments: if the equipped item already IS the proposed one, it's not a change (and
  // must not be re-applied — the armory handle would be stale). Identity includes main stat.
  const payload = useMemo(() => {
    const p: GearBuilder["payload"] = [];
    if (!layoutFresh) return p; // layout belongs to another ship — never apply against it
    for (const [k, it] of Object.entries(assign)) {
      if (!slotExists(k) || it.key == null || !it.location) continue;
      if (!fitsSlot(k, it)) continue; // wrong size/slot type for THIS ship's slot
      if (sameFit(curOf(k), it)) continue;
      if (k.startsWith("t:")) p.push({ kind: "Turret", slot: Number(k.slice(2)), store: it.location, key: it.key, name: it.name, level: it.level });
      else p.push({ kind: "Module", slot: k.slice(2), store: it.location, key: it.key, name: it.name, level: it.level });
    }
    return p;
  }, [assign, curOf, slotExists, fitsSlot, layoutFresh]);
  const changes = useMemo<GearChange[]>(() => {
    const out: GearChange[] = [];
    if (!layoutFresh) return out; // stale layout → show no proposals rather than wrong ones
    for (const [k, it] of Object.entries(assign)) {
      if (!slotExists(k)) continue; // slot not on this ship (stale/cross-ship proposal) → ignore
      if (!fitsSlot(k, it)) continue; // same index, different size (e.g. after a ship change) → ignore
      const current = curOf(k);
      if (sameFit(current, it)) continue; // equipped already matches the proposal → not a change
      if (k.startsWith("t:")) out.push({ key: k, kind: "Turret", label: `Slot ${Number(k.slice(2)) + 1}`, current, next: it });
      else out.push({ key: k, kind: "Module", label: k.slice(2), current, next: it });
    }
    return out.sort((a, b) => a.key.localeCompare(b.key));
  }, [assign, curOf, slotExists, fitsSlot, layoutFresh]);

  // Is the WHOLE plan WORSE than what is fitted? Asked in that direction on purpose: "every change is an
  // improvement" and "the plan is an improvement" are different claims, and only the REGRESSION is actionable.
  // Turrets and modules are chosen by different code against one shared, STEPPED resource, so their union can
  // cross a reactor bracket edge and land below the status quo while each slot still shows a gain: five
  // proposals, +24.4% on one slot, and the build's own index down 0.66%.
  //
  // Scored the way GearTotals scores the same two builds, including the plan's non-turret draw — a module swap
  // moves the load the turrets are bracketed against.
  //
  // `null` means UNJUDGEABLE, which is not the same as fine: no pools, simple ranking, no proposals, or a plan
  // whose turret set and projected draw are both unchanged — a module-only plan that this objective cannot see,
  // since a module's own pooled contribution sits inside the reported pool. Reporting such a plan as a
  // regression would warn about every module upgrade.
  const planVerdict = useMemo<PlanVerdict | null>(() => {
    if (!pools || ranking !== "expanded" || !layoutFresh || !changes.length) return null;
    const curTurrets = hps.map((h) => h.equipped).filter((x): x is Item => !!x);
    const nextTurrets = hps.map((h) => assign[`t:${h.index}`] ?? h.equipped).filter((x): x is Item => !!x);
    const curOther = mslots.map((m) => m.equipped).filter((x): x is Item => !!x);
    const nextOther = mslots.map((m) => assign[`m:${m.slot}`] ?? m.equipped).filter((x): x is Item => !!x);
    if (!sameScale(curTurrets, nextTurrets)) return null;   // two different units — no comparison to make
    const bg = background(pools, curTurrets);
    // The PLAN's pools, through the objective's own owner: pooled stats, draw AND capacity. Projecting the draw
    // alone made a plan that fits a BIGGER REACTOR read as a bracket loss — the load looked like it rose past the
    // 50% edge because it was divided by the old capacity — so a build the panel scored higher carried a warning
    // saying it was lower. Two computations of one figure, and this was the one that skipped the hard half.
    const projected = poolsWithModules(pools, curOther, nextOther);
    const bgNext = background(projected, curTurrets);
    const draw = energyDraw(nextOther) - energyDraw(curOther);
    const cur = setRank(curTurrets, bg);
    const next = setRank(nextTurrets, bgNext);
    // Nothing this objective can weigh: same guns, same pools.
    if (draw === 0 && rankSub(next, cur) === 0 && projected === pools) return null;

    // The BRACKET either side, and only where it actually moved. Dropping a bracket is ⊥ a failure by itself: the
    // score below already nets it against everything the plan gains, and this verdict only says "worse" when that
    // net came out worse — so the notice names the bracket as the MECHANISM, never as the verdict.
    const cap = pools.energy?.capacity ?? 0;
    const modOf = (turrets: Item[], other: Item[], capacity: number) =>
      capacity > 0 ? reactorModifier((energyDraw(turrets) + energyDraw(other)) / capacity) : null;
    const modNow = modOf(curTurrets, curOther, cap);
    const modNext = modOf(nextTurrets, nextOther, capacityWith(cap, curOther, nextOther));
    const moved = modNow != null && modNext != null && modNext !== modNow;

    return {
      worse: rankGt(cur, next),
      label: cur[0] === 1 ? `${activityOf(curTurrets) ?? "Non-combat"} power` : "DPS index",
      cur: cur[1],
      next: next[1],
      // A ratio needs a non-zero baseline and one scale; `rankSub` already returns 0 across tiers.
      pct: cur[1] > 0 && cur[0] === next[0] ? rankSub(next, cur) / cur[1] : null,
      bracket: moved ? { from: modNow!, to: modNext! } : null,
    };
  }, [pools, ranking, layoutFresh, changes, hps, mslots, assign]);
  /** The boolean the rest of the tab asks for; the notice itself wants the figures. */
  const planRegresses = planVerdict == null ? null : planVerdict.worse;
  // ---- suggestion engine ----
  // Lives in the builder, not the Gear tab, so auto-suggest keeps working whichever tab is open (the
  // Summary tab shows proposals for a ship whose Gear tab you never visited). Slots in `manual` are
  // skipped: your explicit choice wins.
  // Which layers this ship can reach AT ALL — from what is FITTED plus what it could MOUNT. Balance is only a
  // requirement where it is achievable: demanding both layers when one is out of reach scores every possible build
  // 0 (the target is `min(surface, core)`) and the tab goes quiet, which punishes the player for not owning a part
  // rather than for building badly. So the target degrades, and the substitution is LABELLED rather than left to be
  // inferred from a tab that proposes nothing.
  //
  // "Could mount" is the load-bearing word: reach measured over the whole inventory counted a gun the hull cannot
  // take — wrong size, or refused by that slot's own filter — and re-created the silence this rule exists to
  // prevent. One owner for the predicate (`turretFits`, through `reachableLayers`) so the reach test and
  // the candidate lists cannot disagree.
  const layerPlan = useMemo(() => {
    const act = ["Mining", "Salvage"].find((a) => [...gear, ...hps.map((h) => h.equipped).filter((x): x is Item => !!x)].some((g) => catOf(g) === a)) ?? null;
    if (!act) return { act: null, degradeTo: null as LayerTarget | null, note: null as string | null };
    // Judged by what the ship can MOUNT, ⊥ by what the player owns: a Core gun that fits no hardpoint on this hull
    // (wrong size, or refused by that slot's own filter) proves nothing about this build's reach, and treating it
    // as proof demanded a balance the ship could not field — which scores every candidate 0 and goes silent.
    const fitted = hps.map((h) => h.equipped).filter((x): x is Item => !!x);
    const { surface: canS, core: canC } = reachableLayers(
      act, fitted, gear,
      hps.map((hp) => ({ size: hp.size, filter: filters[hp.index] ?? ({ mode: "all" } as Filter) })), cats);
    if (canS === canC) return { act, degradeTo: null, note: null };
    // WHICH CAUSE, because the two have different fixes and the note is useless without saying which. Reach is
    // measured a second time with every filter opened: if the layer comes back within reach, no gun is missing —
    // the slot FILTERS closed it, and the answer is to change one rather than to go shopping.
    const open = reachableLayers(act, fitted, gear,
      hps.map((hp) => ({ size: hp.size, filter: { mode: "all" } as Filter })), cats);
    const missing = canS ? "core" : "surface";
    const byFilter = canS ? open.core : open.surface;
    return {
      act,
      degradeTo: (canS ? "surface" : "core") as LayerTarget,
      note: byFilter
        ? `Every hardpoint's filter refuses the ${missing} ${act.toLowerCase()} guns you own — `
          + `this build is scored on ${canS ? "surface" : "core"} alone. Open one slot's filter to score both.`
        : `No ${missing} ${act.toLowerCase()} gun this ship can mount — `
          + `this build is scored on ${canS ? "surface" : "core"} alone.`,
    };
    // `filters` and `cats` are READ here, so they belong in the deps: without them a filter change left the target
    // and this note computed from the previous filters, which is the one input a player changes by hand.
  }, [gear, hps, filters, cats]);

  // THE PLAYER'S ORDER over the stats, and the key that last refused a plan because of it. The order defaults to
  // the hull's own role and nothing more (`defaultGoalOrder`) — a longer default would be an ordering nobody
  // asked for. `vetoed` is written by the suggest paths and read for the note: a plan withheld in silence is
  // indistinguishable from one that was never found.
  const [orderByShip, setOrderByShip] = useState<OrderByShip>(loadGO);
  // STATED beats DEFAULTED, and an empty stated order is a statement: a player who cleared every key is asking the
  // objective to have no opinion, which is not the same as never having answered. Only the absence of an entry
  // falls back to the hull's role.
  const goalOrder = useMemo(() => {
    const stated = shipGuid ? orderByShip[shipGuid] : undefined;
    return stated ? cleanOrder(stated) : defaultGoalOrder(role ?? null, hps.length);
  }, [orderByShip, shipGuid, role, hps.length]);
  const setGoalOrder = useCallback((next: GoalKey[]) => {
    if (!shipGuid) return;
    setOrderByShip((m) => { const n = { ...m, [shipGuid]: cleanOrder(next) }; saveGO(n); return n; });
  }, [shipGuid]);
  // TIED TO THE RUN THAT WROTE IT, which a bare key was not: this component stays mounted across a ship change,
  // so a refusal earned on the previous hull stayed on screen beside a ship whose order does not even contain
  // that key (a salvage hull told its first goal was Combat Power). An explanation of an absence is only true
  // of the run it came from, so it is stored with that run's signature and ignored once the signature moves.
  const vetoed = useRef<{ sig: string; key: GoalKey } | null>(null);
  // WHAT AN ALLOWANCE REFUSED, kept the same way and for the same reason: a plan withheld because a ranked stat
  // would fall too far produces NO ROW, and an absence with no reason is indistinguishable from an empty armory
  //. Held with its run's signature so it cannot outlive the question it answers.
  const bound = useRef<{ sig: string; breach: Breach } | null>(null);

  // THE DEFENSIVE CAP, in front of the order rather than inside it. An order with Combat first never reads a
  // hull key on a plan whose combat power ROSE, which is exactly the plan the player objected to — "it wants me
  // to cut the shields and hull in half for a small DPS gain". The cap is the statement an order cannot make:
  // the level at which a plan's costs are REPORTED — a warning, not a ceiling: nothing is refused for it
  // that offers a swap, because a helper applied at some call sites is the same defect as no helper.
  const [layerCap, setLayerCapState] = useState<number>(() => {
    const v = load<number>(LAYER_CAP_KEY, DEFAULT_LAYER_CAP);
    return Number.isFinite(v) && v >= 0 && v <= 1 ? v : DEFAULT_LAYER_CAP;
  });
  const setLayerCap = useCallback((v: number) => {
    const c = Math.min(1, Math.max(0, v));
    setLayerCapState(c);
    save(LAYER_CAP_KEY, c);
  }, []);

  // WHAT A PLAN MAY SPEND of a ranked stat — a REFUSAL, and the mechanism an ORDER cannot provide: an order
  // sequences keys, so any gain on the first outranks any loss below it. Stated as a fraction of the
  // fitted build, which is the one thing a player can state without an exchange rate between two stats.
  const [allowance, setAllowanceState] = useState<number>(() => {
    const v = load<number>(ALLOWANCE_KEY, DEFAULT_ALLOWANCE);
    return Number.isFinite(v) && v >= 0 && v <= 1 ? v : DEFAULT_ALLOWANCE;
  });
  const setAllowance = useCallback((v: number) => {
    const c = Math.min(1, Math.max(0, v));
    setAllowanceState(c);
    save(ALLOWANCE_KEY, c);
  }, []);
  // The layers as the GAME reports them, projected across a candidate build by the objective's own owner. Null
  // where `/ship/vitals` has not been read — and a layer with no reading orders nothing, rather than reading as
  // a layer destroyed.
  /**
   * A LAYER THIS HULL HAS NO SLOT FOR IS NOT A LAYER THIS APP MAY RANK, WARN ABOUT OR TRADE.
   *
   * A ship can carry armor HP with no `Armor` slot to apply it — measured across the ship catalog, 76 hulls have
   * armor HP and only 53 have the slot, and player-buyable hulls are among the difference. Nothing the optimiser
   * chooses can move such a pool, so a warning that it fell is a warning about a number no plan can act on, and a
   * floor on it would refuse builds for failing an unreachable requirement.
   *
   * Read from the hull's SLOTS, the same fact `defenseLayerOf` reads, rather than inferred from the HP being
   * non-zero — that inference agrees with the truth right up until it does not.
   */
  const hasLayerSlot = useCallback((slotType: string) => mslots.some((m) => m.slot === slotType), [mslots]);
  const layerMax = useCallback((layer: "hull" | "armor" | "shield"): number | null => {
    if (layer === "armor" && !hasLayerSlot("Armor")) return null;
    if (layer === "shield" && !hasLayerSlot("ShieldGenerator")) return null;
    return vitals?.[layer]?.max ?? null;
  }, [vitals, hasLayerSlot]);

  const layersOf = useCallback((cur: Item[], next: Item[]): LayerReading => ({
    hull: projectLayer(layerMax("hull"), "Hull HP", cur, next),
    armor: projectLayer(layerMax("armor"), "Armor HP", cur, next),
    shield: projectLayer(layerMax("shield"), "Shield HP", cur, next),
  }), [layerMax]);
  const layersNow = useCallback((): LayerReading => ({
    hull: layerMax("hull"), armor: layerMax("armor"), shield: layerMax("shield"),
  }), [layerMax]);

  /**
   * A PLAN'S RANKED READING — the pools with EVERY slot the plan touches folded in, hardpoints included.
   *
   * ONE owner, because the two projections this app keeps are a step apart and the wrong one reads as a gain:
   *
   *   the battery's BACKGROUND is the module assignment alone, since `setDps` adds each candidate gun's own
   *   contribution and folding the guns in there counts them twice;
   *   a RANKED READING is a figure of the whole SHIP, so a hardpoint losing 6,188 of Salvage Power belongs in it.
   *
   * Read from the module projection, every ranked key of a turret plan ties — the doc on `goalUnread` says so in
   * as many words — and a plan trading gun power for a module's `Power` line reads as pure gain on the very key
   * the player ranked first.
   *
   * POSITIONAL: `cur[i]` is what leaves the slot `next[i]` enters, so both sides carry a null for an empty slot
   * rather than being compacted (`filter(Boolean)` on one side pairs each item with the wrong slot).
   */
  const planReading = useCallback((rank: Rank, cur: (Item | null)[], next: (Item | null)[],
                                   layers?: LayerReading, power?: PowerReading): GoalReading => {
    if (!pools) return {};
    return goalReadingOf(poolsWithModules(pools, cur, next), rank, layers, power);
  }, [pools]);

  /** Every slot's item, in slot order and keeping the empties, for `planReading`'s positional pairing. */
  const slotItems = useCallback((plan: Record<string, Item> | null) => ({
    turrets: hps.map((h) => (plan ? plan[`t:${h.index}`] ?? h.equipped : h.equipped) ?? null),
    modules: mslots.map((m) => (plan ? plan[`m:${m.slot}`] ?? m.equipped : m.equipped) ?? null),
  }), [hps, mslots]);

  /**
 * WHICH LAYER THIS HULL TANKS ON — the frontier's whole axis, and what the drop warning watches.
   *
   * The player's own statement first (`profile.combatLayer`, the shield|armor buttons on the officers tab), and
   * the hull's slots as its default. ONE owner shared with the officer objective: the two answer the same
   * question, "what is this ship for", and a second reader is how they come to disagree.
   */
  const tankLayer = useMemo<"armor" | "shield" | null>(() => {
    const stated = shipGuid ? loadProfiles()[shipGuid]?.combatLayer : undefined;
    return stated ?? defenseLayerOf(mslots.map((m) => m.slot));
  }, [shipGuid, mslots]);

  /**
   * What the plan ON SCREEN costs, across every tracked measurement — computed from the plan, never latched.
   *
   * This replaces the layer CAP as a refusal. A cap declines a trade the player might have taken and leaves only a
   * sentence explaining an absence; naming the falls hands them the decision with the numbers attached. It also
   * watches all eight keys rather than the three layers, because the axis that matters is the one the plan
   * happens to spend — a swap costing 4.9% of Combat Power on a combat hull passed a hull cap in silence.
   */
  const planDrops = useMemo(() => {
    if (!pools || !layoutFresh || !changes.length) return [];
    const curT = hps.map((h) => h.equipped).filter((x): x is Item => !!x);
    const nextT = hps.map((h) => assign[`t:${h.index}`] ?? h.equipped).filter((x): x is Item => !!x);
    const curM = mslots.map((m) => m.equipped).filter((x): x is Item => !!x);
    const nextM = mslots.map((m) => assign[`m:${m.slot}`] ?? m.equipped).filter((x): x is Item => !!x);
    const projected = poolsWithModules(pools, curM, nextM);
    const rankNow = setRank(curT, background(pools, curT));
    const rankNext = setRank(nextT, background(projected, curT));
    const was = slotItems(null), plan = slotItems(assign);
    return goalDrops(
      goalReadingOf(pools, rankNow, layersNow(), powerReadingOf(curT, background(pools, curT))),
      planReading(rankNext, [...was.turrets, ...was.modules], [...plan.turrets, ...plan.modules],
                  layersOf([...curT, ...curM], [...nextT, ...nextM]),
                  powerReadingOf(nextT, background(projected, curT))),
      layerCap,
      // The other layer is whatever the guns happen to roll, and warning on a percentage of almost nothing is how
      // a warning gets trained out of a player. Null (no defensive slot at all) watches both.
      tankLayer,
    );
  }, [pools, layoutFresh, changes, hps, mslots, assign, layersNow, layersOf, layerCap, planReading, slotItems,
      tankLayer]);

  /**
 * The ranked keys the plan on screen cannot answer — said out loud rather than left to look like a tie.
   *
   * With no pools the objective can read nothing at all, so every ranked key is unread; that is the same state the
   * whole expanded ranking degrades to, and it should read the same way here.
   */
  // Which activities this hull's hardpoints can actually serve, read off what they hold and what their filters
  // admit rather than off the ship's role: a Mining hull with a salvage gun fitted can be ranked on salvage, and a
  // role is a label on the hull, not a statement about its battery.
  const goalKeysOffered = useMemo(() => {
    const acts = new Set<PowerActivity>();
    const add = (a: string | null | undefined) => { if (a === "Mining" || a === "Salvage") acts.add(a); };
    // A slot FILTER naming an activity is an instruction, so it counts even with nothing of that kind fitted yet,
    // and the fitted guns count because that is what the ship is doing now. Same precedence `turretPlan` uses,
    // minus the role: a role is a label on the hull, and offering a key on it alone would offer mining to a
    // combat hull that has never held a drill.
    for (const hp of hps) {
      const f = filters[hp.index] ?? ({ mode: "all" } as Filter);
      if (f.mode === "activity") add(parseActivity(f.value).act);
      if (hp.equipped) add(activityOf([hp.equipped]));
    }
    return goalKeysFor(hps.length, [...acts]);
  }, [hps, filters]);

  const goalUnreadKeys = useMemo(() => {
    if (!goalOrder.length) return [];
    if (!pools) return [...goalOrder];
    const curT = hps.map((h) => h.equipped).filter((x): x is Item => !!x);
    const nextT = hps.map((h) => assign[`t:${h.index}`] ?? h.equipped).filter((x): x is Item => !!x);
    const curM = mslots.map((m) => m.equipped).filter((x): x is Item => !!x);
    const nextM = mslots.map((m) => assign[`m:${m.slot}`] ?? m.equipped).filter((x): x is Item => !!x);
    const projected = poolsWithModules(pools, curM, nextM);
    const was = slotItems(null), plan = slotItems(assign);
    return goalUnread(
      goalOrder,
      goalReadingOf(pools, setRank(curT, background(pools, curT)), layersNow(),
                    powerReadingOf(curT, background(pools, curT))),
      planReading(setRank(nextT, background(projected, curT)),
                  [...was.turrets, ...was.modules], [...plan.turrets, ...plan.modules],
                  layersOf([...curT, ...curM], [...nextT, ...nextM]),
                  powerReadingOf(nextT, background(projected, curT))),
    );
  }, [goalOrder, pools, hps, mslots, assign, layersNow, layersOf, planReading, slotItems]);

  const [frontierPts, setFrontierPts] = useState<FrontierPoint[] | null>(null);
  const [frontierBusy, setFrontierBusy] = useState(false);
  /** How many allowances were solved, and what the ship read when they were — both from the sweep's own snapshot,
   *  so the rows and the baseline they are printed against cannot come from two different moments. */
  const [frontierSolved, setFrontierSolved] = useState<number | null>(null);
  const [frontierNow, setFrontierNow] = useState<GoalReading | null>(null);

  /**
   * WHAT OTHER ALLOWANCES BUY — the same search the `allow` box already runs, at the neighbouring settings.
   *
   * ONE MECHANISM WITH THAT BOX, not a second control beside it: the sweep's rows differ only in the number the
   * player types there, so a row needs no name of its own and the panel needs no vocabulary. The player's own
   * allowance is swept alongside the fixed steps, so the list always contains the build they are flying under.
   *
   * Run on DEMAND, never on a render: each point is a whole-ship search, and five of them on every keystroke is
   * the freeze this app has already been blamed for once. The button is the statement that this costs something.
   */
  const buildFrontier = useCallback(() => {
    if (!pools || !layoutFresh || !goalOrder.length) return;
    setFrontierBusy(true);
    // Off the current frame so the button paints its busy state before the searches start.
    setTimeout(() => {
      try {
        const pinned = new Set([...manual, ...keep]);
        const used = new Set<string>(Object.entries(assign).filter(([k]) => pinned.has(k)).map(([, it]) => handle(it)));
        const openT = hps.filter((hp) => !pinned.has(`t:${hp.index}`));
        const openM = mslots.filter((m) => !pinned.has(`m:${m.slot}`));
        if (!openT.length && !openM.length) { setFrontierPts([]); return; }

        const fittedTurrets = hps.map((h) => h.equipped).filter((x): x is Item => !!x);
        const fixedTurrets = hps.filter((hp) => pinned.has(`t:${hp.index}`))
          .map((hp) => assign[`t:${hp.index}`] ?? hp.equipped).filter((x): x is Item => !!x);

        // THE SAME PLAN THE SUGGEST BUTTONS BUILD, so a frontier row is a build this app would otherwise have
        // proposed. Deriving the slots a second way here is how the two would come to answer differently.
        const { slots: tSlots, target: tgt, layerAct: act } = turretPlan({
          open: openT, hps, gear, filters, cats, used, role: role ?? null, degradeTo: layerPlan.degradeTo,
        });
        const { slots: mSlots } = modulePlan({ open: openM, gear, used });
        const nowM = openM.map((m) => m.equipped ?? null);

        // The layers are projected from the MODULE assignment plus the fitted battery, the same pairing the
        // module search uses: a row that could not see armor would be ranked by an order missing a key the
        // player put in it.
        const layers = (mods: (Item | null)[], guns?: (Item | null)[]) =>
          layersOf([...fittedTurrets, ...nowM.filter((x): x is Item => !!x)],
                   [...(guns ? [...fixedTurrets, ...guns.filter((x): x is Item => !!x)] : fittedTurrets),
                    ...mods.filter((x): x is Item => !!x)]);
        const fittedRank = setRank(fittedTurrets, background(pools, fittedTurrets), tgt, act ?? undefined);

        // The player's own setting joins the fixed steps and the list is solved in order, so the row they fly
        // under is always present and the neighbours read as looser or stricter than it rather than as options
        // out of nowhere.
        const steps = [...new Set([...FRONTIER_STEPS, allowance])].sort((x, y) => x - y);
        const fitted = goalReadingOf(pools, fittedRank, layersNow(),
                                     powerReadingOf(fittedTurrets, background(pools, fittedTurrets)));
        const pts = frontier(
          {
            turretSlots: tSlots, moduleSlots: mSlots, pools, fittedTurrets, fixedTurrets,
            ctx: { role, fit: shipFit(role, mslots, fittedTurrets), target: tgt, act: act ?? undefined },
            target: tgt, act: act ?? undefined,
            goal: { order: goalOrder, fitted, layers },
          },
          steps,
        );
        setFrontierNow(fitted);
        setFrontierSolved(steps.length);
        setFrontierPts(pts);
      } finally {
        setFrontierBusy(false);
      }
    }, 0);
  }, [pools, layoutFresh, goalOrder, allowance, manual, keep, hps, mslots, assign, gear, filters, cats, role,
      layerPlan.degradeTo, layersNow, layersOf]);

  /**
   * Take a frontier point as the plan. The rows are real assignments, so this is a copy, not a re-search.
   *
   * ⚠ MERGED ONTO WHAT IS THERE, ⊥ substituted for it, and that is not a style choice: `buildFrontier` solves only
   * the OPEN slots — it excludes `manual ∪ keep` from `openT`/`openM` — so `p.chosen` never contains a slot the
   * player answered. Replacing the map therefore DROPPED every pin: hand-pick a turret, take a sweep row, and the
   * slot still rendered as pinned while holding nothing, missing from the plan and from the apply payload. Every
   * other `setAssign` caller here merges; this was the one that did not.
   */
  const applyFrontier = useCallback((p: FrontierPoint) => {
    setAssign((a) => {
      const n = { ...a };
      for (const [k, v] of p.chosen) n[k] = v;
      return n;
    });
    setFrontierPts(null);
  }, [setAssign]);

  const suggestTurrets = useCallback(() => {
    const pinned = new Set([...manual, ...keep]);   // PICKED for, or locked to what is fitted
    setAssign((a) => {
      const n = { ...a };
      const used = new Set<string>(Object.entries(a).filter(([k]) => pinned.has(k)).map(([, it]) => handle(it)));
      const open = hps.filter((hp) => !pinned.has(`t:${hp.index}`));

      // EXPANDED: choose the whole battery at once. Pooled stats (Precision → crit, Combat Power, typed
      // damage) mean a slot's best gun depends on what the OTHER slots hold — a Precision-heavy turret can
      // be worth more than a bigger one because it lifts every gun's crit. A per-slot loop cannot express
      // that; `optimizeTurretSet` evaluates whole sets. Falls back to the simple loop when the bridge sent
      // no pools (older plugin), rather than silently ranking on an empty model.
      if (ranking === "expanded" && pools) {
        // The background strips EVERY equipped turret, so each evaluated set must put the whole battery back:
        // the open slots' picks plus `fixed` — the manual slots' items and any hardpoint this call isn't
        // choosing for. Scoring only the open slots would model a ship missing its other guns, and with the
        // reactor bracket keyed on total draw that is not a small error.
        // Against the load the plan will ACTUALLY have, not the one on the ship right now. A module proposal
        // already in `a` changes the non-turret draw, and the reactor bracket keyed on TOTAL draw scales every
        // power pool — so turrets chosen against the current draw and modules chosen separately can each be
        // right while their union crosses a bracket edge and ends up worse than changing nothing: an engine swap
        // takes the load 50% → 57%, the bonus +20% → +10%, and the whole plan scores below the fitted build
        // while every individual slot still shows a gain.
        const bgNow = background(pools, hps.map((hp) => hp.equipped).filter((x): x is Item => !!x));
        const plannedOther = mslots.map((m) => a[`m:${m.slot}`] ?? m.equipped).filter((x): x is Item => !!x);
        const currentOther = mslots.map((m) => m.equipped).filter((x): x is Item => !!x);
        const bg = bgNow.energy
          ? { ...bgNow, energy: { ...bgNow.energy,
              used: Math.max(0, bgNow.energy.used - energyDraw(currentOther) + energyDraw(plannedOther)) } }
          : bgNow;
        const fixed = hps
          .filter((hp) => pinned.has(`t:${hp.index}`))
          .map((hp) => a[`t:${hp.index}`] ?? hp.equipped)
          .filter((x): x is Item => !!x);
        // A slot filter is a RESTRICTION on what may be FITTED, not merely on what may be considered. So when a
        // filter is set and the equipped gun does not satisfy it, keeping that gun is not an option — the answer
        // has to be a switch, even at lower power, which is what the player asked for by setting the filter.
        // (Same rule the per-slot ⚡ and the simple mode already followed; expanded mode maximised DPS instead
        // and therefore kept a Railgun in a slot restricted to EMP weapons, making the button look dead.)
        // Which candidates, which layer roles, which target and which activity — all of it from the ONE owner,
        // so this button and the joint one cannot disagree about what a filter means.
        const { slots, withRoles, target, layerAct, keepOk } = turretPlan({
          open, hps, gear, filters, cats, used, role: role ?? null, degradeTo: layerPlan.degradeTo,
        });
        // The fitted battery and its rank are the goal's REFERENCE, so both are needed before the search runs
        // rather than after it (they were computed below, beside the gate, when only the gate read them).
        const fittedAll = [...fixed, ...open.map((hp) => hp.equipped).filter((x): x is Item => !!x)];
        const now = setRank(fittedAll, bg, target, layerAct ?? undefined);
        // THE PLAYER'S ORDER GOES INTO THE SEARCH, ⊥ only onto the gate below. Read from the objective's index
        // alone, this button kept re-proposing a gun the index likes and every other ranked key dislikes, because
        // nothing inside the ascent could see those keys. `pools` is the REPORTED reading, which is what
        // a ranked key is a figure of; the background `bg` cannot serve — it has the battery stripped out of it.
        const turretGoal = goalOrder.length && pools
          ? {
              order: goalOrder, pools, allow: allowance,
              fitted: goalReadingOf(pools, now, layersNow(), powerReadingOf(fittedAll, bg)),
              // The PINNED hardpoints stay on both sides: `projectLayer` divides the whole multiplier product out
              // of the reported figure to recover the additive base, so a set missing the guns that are not moving
              // divides out a different product and the projection lands somewhere the game never would.
              layers: (guns: (Item | null)[]) =>
                layersOf(fittedAll, [...fixed, ...guns.filter((x): x is Item => !!x)]),
            }
          : undefined;
        const chosen = layerAct
          ? optimizeTurretSetLayered(withRoles, bg, layerAct, { target, maxPasses: 4, fixed, goal: turretGoal })
          : optimizeTurretSet(slots, bg, 4, fixed, target, layerAct ?? undefined, turretGoal);
        // Judge the PLAN, not each slot in isolation. A per-slot floor lets a set through whose slots each look
        // worthwhile only because the OTHER slots were assumed to change too; apply it and the new baseline makes
        // yet another set look worthwhile, which is the apply → new suggestions → apply ping-pong. Requiring the
        // whole set to beat what is fitted by more than the floor makes the applied build a fixed point: after
        // applying, the same computation proposes nothing.
        const plannedAll = [...fixed, ...open.map((hp) => chosen.get(`t:${hp.index}`) ?? hp.equipped).filter((x): x is Item => !!x)];
        // The activity is the SHIP'S, fixed for the whole comparison: scoring `now` as Salvage and `plan` as
        // Mining compares two units and the fatter pool always wins.
        const plan = setRank(plannedAll, bg, target, layerAct ?? undefined);
        // A forced switch (the fitted gun breaks its slot's filter) is exempt: compliance is the point there. But
        // the exemption is that SLOT'S, not the whole plan's — one non-compliant hardpoint used to waive the floor
        // for every other slot, which is how a strictly worse build shipped: two good guns were swapped out
        // alongside the one that had to move, with nothing checking they were an improvement.
        // AND THE PLAYER'S ORDER. `goalRefuses` names the key for the note; `goalAccepts` is the gate, and it owns
        // when the worth-it floor still applies — the band decides where the order speaks, the floor only where
        // every ranked key tied.
        // BOTH READINGS OFF THE SAME POOLS WAS THE WHOLE GUN HALF GOING UNREAD: every pooled key then ties by
        // construction and only `dps` moves, so a salvage or mining hull's own ranked key could not refuse a
        // battery that loses power. The hardpoint deltas are folded in; the modules are on both sides of this
        // gate untouched, so they cancel.
        const wasGuns = hps.map((hp) => hp.equipped ?? null);
        const planGuns = hps.map((hp) => (chosen.get(`t:${hp.index}`) ?? a[`t:${hp.index}`] ?? hp.equipped) ?? null);
        // The layers are read on BOTH sides or neither: a fitted reading with no armor against a planned reading
        // that has one is not a comparison, it is one key that can only ever look unchanged.
        const nowRead = goalReadingOf(pools, now, layersNow(), powerReadingOf(fittedAll, bg));
        const planRead = planReading(plan, wasGuns, planGuns,
                                     layersOf(wasGuns.filter((x): x is Item => !!x),
                                              planGuns.filter((x): x is Item => !!x)));
        const vetoT = goalRefuses(goalOrder, nowRead, planRead);
        if (vetoT) vetoed.current = { sig: sigRef.current, key: vetoT };
        const breachT = allowanceBreach(goalOrder, nowRead, planRead, allowance);
        if (breachT) bound.current = { sig: sigRef.current, breach: breachT };
        if (!goalAccepts(goalOrder, nowRead, planRead, plan, now, OBJECTIVE_TIE, allowance)) {
          for (const hp of open) {
            const key = `t:${hp.index}`;
            const pick = chosen.get(key);
            if (!keepOk(hp) && pick && pick !== hp.equipped) n[key] = pick;
            else delete n[key];
          }
          return n;
        }
        const picked = open.map((hp) => chosen.get(`t:${hp.index}`) ?? hp.equipped).filter((x): x is Item => !!x);
        for (const hp of open) {
          const key = `t:${hp.index}`;
          const pick = chosen.get(key);
          // The equipped item winning its own slot IS the "keep current" answer — propose nothing.
          if (!pick || pick === hp.equipped) { delete n[key]; continue; }
          const others = [...fixed, ...picked.filter((p) => p !== pick)];
          const asIs = setRank(hp.equipped ? [...others, hp.equipped] : others, bg, target, layerAct ?? undefined);
          // The floor is about not sending the player to the workshop for noise. It does NOT apply when the
          // equipped gun breaks the slot's filter: there the swap is the point, whatever it costs in DPS.
          if (keepOk(hp) && !worthSwitching(setRank([...others, pick], bg, target, layerAct ?? undefined), asIs)) { delete n[key]; continue; }
          n[key] = pick;
        }
        return n;
      }

      // SIMPLE: weakest-equipped slots pick first, so the best owned turret lands where the gain is biggest —
      // among interchangeable (same size+filter) slots, don't replace a stronger gun and skip a weaker one.
      const order = [...hps].sort((x, y) => (x.equipped ? rankValue(x.equipped, ranking, crit) : 0) - (y.equipped ? rankValue(y.equipped, ranking, crit) : 0));
      for (const hp of order) {
        const key = `t:${hp.index}`;
        if (pinned.has(key)) continue;
        const f = filters[hp.index] ?? { mode: "all" };
        const eqPow = hp.equipped ? rankValue(hp.equipped, ranking, crit) : 0;
        const upgradeOnly = mayKeepEquipped(hp.equipped, hp.size, f, cats);
        const best = gear.filter((g) => turretFits(g, hp.size, f, cats) && !used.has(handle(g))).sort((x, y) => rankValue(y, ranking, crit) - rankValue(x, ranking, crit))[0];
        if (best && (upgradeOnly ? rankValue(best, ranking, crit) > eqPow : true)) { n[key] = best; used.add(handle(best)); }
        else delete n[key]; // equipped already best (or matches filter + stronger) → keep
      }
      return n;
    });
  }, [gear, hps, filters, cats, manual, keep, ranking, crit, pools, goalOrder, planReading,
      allowance, layersNow, layersOf]);
  const suggestModules = useCallback(() => {
    const pinned = new Set([...manual, ...keep]);
    setAssign((a) => {
      const n = { ...a };
      const used = new Set<string>(Object.entries(a).filter(([k]) => pinned.has(k)).map(([, it]) => handle(it)));
      const open = mslots.filter((m) => !pinned.has(`m:${m.slot}`));
      const turrets = hps.map((h) => a[`t:${h.index}`] ?? h.equipped).filter((x): x is Item => !!x);
      const mctx: ModuleCtx = { role, fit: shipFit(role, mslots, turrets) };
      const { slots: mSlots, fitsFor } = modulePlan({ open, gear, used });

      // The module slots are chosen as a SET, against the battery. Two things make that necessary rather than
      // tidy: the modules feed the same pools the guns are scored on, and the reactor bracket answers to the
      // TOTAL draw, so two swaps that each keep their bracket can lose it together. Scoring the whole assignment
      // prices that — and prices the crossings that pay for themselves, which the old bracket-preserving
      // constraint had to refuse along with the ones that do not.
      if (ranking === "expanded" && pools) {
        // The order ORDERS the search, it does not merely veto its answer: a module set that ties on the first
        // ranked key is separated by the second, which is the whole point of stating one.
        const chosen = optimizeModuleSet(mSlots, pools, turrets, mctx, undefined, goalOrder.length ? {
          order: goalOrder,
          fitted: goalReadingOf(pools, setRank(turrets, background(pools, turrets)), layersNow(),
                                powerReadingOf(turrets, background(pools, turrets))),
          layers: (mods) => layersOf(
            [...turrets, ...open.map((m) => m.equipped).filter((x): x is Item => !!x)],
            [...turrets, ...mods.filter((x): x is Item => !!x)]),
        } : undefined);
        // Judge the PLAN, not each slot alone: a per-slot floor passes a set whose slots each look worthwhile only
        // because the others were assumed to change too, and applying that makes yet another set look worthwhile —
        // the apply → suggest → apply ping-pong. Whole-plan means the applied build is a fixed point.
        const outs = open.map((m) => m.equipped ?? null);
        const plan = open.map((m) => chosen.get(`m:${m.slot}`) ?? m.equipped ?? null);
        const rankOf = (inn: (Item | null)[]) =>
          setRank(turrets, background(poolsWithModules(pools, outs, inn), turrets));

        // THE SAME ASYMMETRY, ONE LEVEL UP. The pair guard in `moduleWhy` cannot see this: the set search
        // scores whole ASSIGNMENTS, and a plan can clear the floor from the current baseline while the reverse plan
        // clears it from the plan's own baseline — which is precisely a bounce, since applying one makes the other
        // the proposal. So the plan is measured from BOTH baselines: the projected pools of the plan become the
        // baseline for the mirror comparison, and a plan that wins both ways is refused.
        const planPools = poolsWithModules(pools, outs, plan);
        const mirror = (inn: (Item | null)[]) =>
          setRank(turrets, background(poolsWithModules(planPools, plan, inn), turrets));
        const bounces = worthSwitching(rankOf(plan), rankOf(outs))
          && worthSwitching(mirror(outs), mirror(plan));

        // The LAYERS ride with the pools here, unlike the turret path: a module assignment is what moves hull,
        // armor and shield at all, so an order naming one of them can only be answered on this path.
        const keptM = (inn: (Item | null)[]) => [...turrets, ...inn.filter((x): x is Item => !!x)];
        const nowReadM = goalReadingOf(pools, rankOf(outs), layersNow(),
                                       powerReadingOf(turrets, background(pools, turrets)));
        const planReadM = goalReadingOf(planPools, rankOf(plan), layersOf(keptM(outs), keptM(plan)),
                                        powerReadingOf(turrets, background(planPools, turrets)));
        const vetoM = goalRefuses(goalOrder, nowReadM, planReadM);
        if (vetoM) vetoed.current = { sig: sigRef.current, key: vetoM };
        const breachM = allowanceBreach(goalOrder, nowReadM, planReadM, allowance);
        if (breachM) bound.current = { sig: sigRef.current, breach: breachM };
        if (bounces || !goalAccepts(goalOrder, nowReadM, planReadM, rankOf(plan), rankOf(outs),
                                    OBJECTIVE_TIE, allowance)) {
          // No plan worth the trip. A slot may STILL be decided on what the objective cannot see — but only where
          // it genuinely cannot see: an EMPTY slot (anything beats nothing) or a difference inside the tie band
          // (`OBJECTIVE_TIE`), where the tie-break chain is the whole answer.
          //
          // It used to fall through for every open slot, and that is the apply → suggest → apply ping-pong the
          // floor above exists to prevent ( reported as "it keeps offering me new tweaks every time I
          // apply"): a sub-floor gain the objective had just REJECTED came back as a tie-break win, was applied,
          // moved the pools slightly, and the next round found another one. Where the objective has an opinion and
          // that opinion is "not worth the trip", a tie-break must not overrule it.
          const mc = { ...mctx, pools, turrets };
          for (const m of open) {
            const key = `m:${m.slot}`;
            const eq = m.equipped ?? null;
            const best = fitsFor(m).reduce<Item | undefined>((x, y) => (!x || moduleBetter(y, x, mc) ? y : x), undefined);
            if (!best || best === eq) { delete n[key]; continue; }
            const silent = !eq || Math.abs(moduleGain(best, eq, mc)) <= OBJECTIVE_TIE;
            if (silent && moduleBetter(best, eq, mc)) { n[key] = best; used.add(handle(best)); }
            else delete n[key];
          }
          return n;
        }
        for (const m of open) {
          const key = `m:${m.slot}`;
          const pick = chosen.get(key);
          if (!pick || pick === m.equipped) { delete n[key]; continue; }
          n[key] = pick;
          used.add(handle(pick));
        }
        return n;
      }

      // No pools, or `simple` — the heuristic alone, one slot at a time, which is that mode's whole model.
      for (const m of open) {
        const key = `m:${m.slot}`;
        const best = fitsFor(m).reduce<Item | undefined>((x, y) => (!x || moduleBetter(y, x, mctx) ? y : x), undefined);
        if (best && best !== m.equipped && moduleBetter(best, m.equipped, mctx)) { n[key] = best; used.add(handle(best)); }
        else delete n[key];
      }
      return n;
    });
  }, [gear, hps, mslots, filters, cats, manual, keep, ranking, crit, pools, role, goalOrder, layersNow, layersOf]);

  /**
   * BOTH HALVES IN ONE SEARCH — the coupling that runs between them, which neither single-block pass can see.
   *
   * A bigger reactor raises capacity, which relaxes the bracket, which makes a thirstier gun affordable: the
   * turret pass holds the modules still and the module pass holds the battery still, so each refuses the step the
   * other unlocks and the player can only reach it by pressing the two buttons in the right order, twice. The
   * objective and the ascent are the ones both buttons already use — only the SEARCH widens.
   *
   * The two single-block buttons stay: most refits are one half, and the smaller search is the faster answer.
   */
  const suggestShip = useCallback(() => {
    const pinned = new Set([...manual, ...keep]);
    if (!(ranking === "expanded" && pools)) { suggestModules(); suggestTurrets(); return; }
    setAssign((a) => {
      const n = { ...a };
      const used = new Set<string>(Object.entries(a).filter(([k]) => pinned.has(k)).map(([, it]) => handle(it)));
      const openT = hps.filter((hp) => !pinned.has(`t:${hp.index}`));
      const openM = mslots.filter((m) => !pinned.has(`m:${m.slot}`));
      if (!openT.length && !openM.length) return n;

      // What the ship keeps but this run is not choosing. A pinned hardpoint's gun takes part in every evaluation
      // — the objective is the whole ship, and a battery missing its other guns is a ship that does not exist.
      const fixedTurrets = hps
        .filter((hp) => pinned.has(`t:${hp.index}`))
        .map((hp) => a[`t:${hp.index}`] ?? hp.equipped)
        .filter((x): x is Item => !!x);
      const fittedTurrets = hps.map((hp) => hp.equipped).filter((x): x is Item => !!x);
      const { slots: tSlots, withRoles, target, layerAct, keepOk } = turretPlan({
        open: openT, hps, gear, filters, cats, used, role: role ?? null, degradeTo: layerPlan.degradeTo,
      });
      const { slots: mSlots } = modulePlan({ open: openM, gear, used });
      // A PINNED module stays where it is, so its slot is not in `mSlots` and its draw is part of the reported
      // pools already — the same treatment a pinned hardpoint gets through `fixedTurrets`.
      const mctx: ModuleCtx = { role, fit: shipFit(role, mslots, fittedTurrets), target, act: layerAct ?? undefined };
      // The layered search is the turret half's own refinement and has no joint form yet: it enumerates layer
      // assignments and each inner run holds the modules still. So a LAYERED battery keeps the two-pass answer
      // rather than being handed a search that would silently ignore its roles.
      if (layerAct && withRoles.some((s) => (s.layerRole ?? "any") !== "any")) {
        suggestModules(); suggestTurrets();
        return n;
      }

      const chosen = optimizeShipSet({
        turretSlots: tSlots, moduleSlots: mSlots, pools, fittedTurrets, fixedTurrets,
        ctx: mctx, target, act: layerAct ?? undefined,
        goal: goalOrder.length ? {
          order: goalOrder,
          fitted: goalReadingOf(pools, setRank(fittedTurrets, background(pools, fittedTurrets), target,
                                               layerAct ?? undefined), layersNow(),
                                powerReadingOf(fittedTurrets, background(pools, fittedTurrets))),
          // The candidate BATTERY, not the fitted one: this search moves both halves, and the pinned hardpoints
          // ride along on the planned side because `guns` covers only the slots being chosen.
          layers: (mods, guns) => layersOf(
            [...fittedTurrets, ...openM.map((m) => m.equipped).filter((x): x is Item => !!x)],
            [...(guns ? [...fixedTurrets, ...guns.filter((x): x is Item => !!x)] : fittedTurrets),
             ...mods.filter((x): x is Item => !!x)]),
        } : undefined,
      });

      // ONE floor over the WHOLE plan: a per-half floor lets each half through on the strength of the
      // other's assumed change, and applying that makes the next run propose again — the ping-pong. Fitted and
      // planned are scored the same way, modules folded onto the pools and the battery read against them.
      const outs = openM.map((m) => m.equipped ?? null);
      const rankOf = (mods: (Item | null)[], turrets: Item[]) =>
        setRank(turrets, background(poolsWithModules(pools, outs, mods), fittedTurrets), target, layerAct ?? undefined);
      const planMods = openM.map((m) => chosen.get(`m:${m.slot}`) ?? m.equipped ?? null);
      const planGuns = [...fixedTurrets, ...openT.map((hp) => chosen.get(`t:${hp.index}`) ?? hp.equipped).filter((x): x is Item => !!x)];
      const nowGuns = [...fixedTurrets, ...openT.map((hp) => hp.equipped).filter((x): x is Item => !!x)];
      // Measured from BOTH baselines, as the module path is: a joint plan that wins from the current build
      // AND loses to the current build from its own projected pools is a bounce, not an improvement.
      const planPools = poolsWithModules(pools, outs, planMods);
      const mirror = (mods: (Item | null)[], turrets: Item[]) =>
        setRank(turrets, background(poolsWithModules(planPools, planMods, mods), fittedTurrets), target, layerAct ?? undefined);
      const bounces = worthSwitching(rankOf(planMods, planGuns), rankOf(outs, nowGuns))
        && worthSwitching(mirror(outs, nowGuns), mirror(planMods, planGuns));
      // Both halves move here, so both halves feed the layer projection.
      const keptJ = (mods: (Item | null)[], guns: Item[]) => [...guns, ...mods.filter((x): x is Item => !!x)];
      // `planPools` is the MODULE half alone — the background the battery is scored against. A ranked reading is a
      // figure of the whole ship ∴ the hardpoints are folded in too, or a plan paying for a module's `Power` line
      // with a hardpoint's own power reads as a gain on the key the player ranked (`planReading`).
      const wasGunsJ = hps.map((hp) => hp.equipped ?? null);
      const planGunsJ = hps.map((hp) => (chosen.get(`t:${hp.index}`) ?? hp.equipped) ?? null);
      // The battery's layer figures are read against the SAME background the rank beside them was taken against,
      // module half folded in on each side: read against the other side's pools they would price one battery's
      // throughput under another's reactor bracket.
      const bgJ = (mods: (Item | null)[]) => background(poolsWithModules(pools, outs, mods), fittedTurrets);
      const nowReadJ = goalReadingOf(pools, rankOf(outs, nowGuns), layersNow(),
                                     powerReadingOf(nowGuns, bgJ(outs)));
      const planReadJ = planReading(rankOf(planMods, planGuns),
                                    [...wasGunsJ, ...outs], [...planGunsJ, ...planMods],
                                    layersOf(keptJ(outs, nowGuns), keptJ(planMods, planGuns)),
                                    powerReadingOf(planGuns, bgJ(planMods)));
      const vetoJ = goalRefuses(goalOrder, nowReadJ, planReadJ);
      if (vetoJ) vetoed.current = { sig: sigRef.current, key: vetoJ };
      const breachJ = allowanceBreach(goalOrder, nowReadJ, planReadJ, allowance);
      if (breachJ) bound.current = { sig: sigRef.current, breach: breachJ };
      if (bounces || !goalAccepts(goalOrder, nowReadJ, planReadJ,
                                  rankOf(planMods, planGuns), rankOf(outs, nowGuns),
                                  OBJECTIVE_TIE, allowance)) {
        // Not worth the trip as a whole. Fall back to the two single-block answers, which have their own floors
        // and their own fall-throughs — a slot can still be decided on what the objective cannot see.
        suggestModules(); suggestTurrets();
        return n;
      }
      for (const hp of openT) {
        const key = `t:${hp.index}`;
        const pick = chosen.get(key);
        // The equipped gun winning its own slot IS "keep current" — propose nothing. A gun that breaks its slot's
        // filter is the exception: there the switch is the point, whatever it costs.
        if (!pick || pick === hp.equipped) { if (!keepOk(hp) && pick) n[key] = pick; else delete n[key]; continue; }
        n[key] = pick;
      }
      for (const m of openM) {
        const key = `m:${m.slot}`;
        const pick = chosen.get(key);
        if (!pick || pick === m.equipped) { delete n[key]; continue; }
        n[key] = pick;
      }
      return n;
    });
  }, [gear, hps, mslots, filters, cats, manual, keep, ranking, pools, role, layerPlan.degradeTo,
      suggestModules, suggestTurrets, goalOrder, layersNow, layersOf, planReading]);

  // A pending choice that breaks its slot's CURRENT filter is dropped when the filter changes — including one
  // the player made by hand. Narrowing a slot to railguns while a Plasma Cannon is proposed there leaves a plan
  // that contradicts the restriction just set, and because a hand-picked slot is pinned, auto-suggest would skip
  // it and the contradiction would sit there indefinitely. The pin goes with it, so the slot can be re-answered.
  useEffect(() => {
    const stale = Object.entries(assign).filter(([k, it]) => {
      if (!k.startsWith("t:")) return false;
      const hp = hps.find((h) => `t:${h.index}` === k);
      return !!hp && !turretFits(it, hp.size, filters[hp.index] ?? { mode: "all" }, cats);
    }).map(([k]) => k);
    if (!stale.length) return;
    setAssign((a) => { const n = { ...a }; for (const k of stale) delete n[k]; return n; });
    setManual((m) => { const n = new Set(m); for (const k of stale) n.delete(k); return n; });
  }, [filters, cats, hps, assign]);

  // Auto-suggest, keyed on a signature of everything a suggestion depends on: the owned pool, WHAT IS
  // FITTED, the ship, the per-slot filters and the categories. Comparing the signature (rather than reacting
  // to the raw deps) is what keeps this from looping — `manual` deliberately isn't part of it, so marking a
  // slot manual never re-triggers a run.
  //
  // The fitted gear belongs in here because the objective is set-relative: every proposal is scored against
  // the rest of the battery, so applying a change makes the previous answer stale. Leaving it out meant an
  // applied suggestion could stay on screen as though it had never been applied. Equipped items carry no store
  // handle, so they are identified by slot + name + headline value.
  const fittedSig = useMemo(
    () => [...hps.map((h) => `t${h.index}:${h.equipped?.name ?? ""}:${h.equipped?.mainStat?.amount ?? ""}`),
           ...mslots.map((m) => `m${m.slot}:${m.equipped?.name ?? ""}`)].join(","),
    [hps, mslots],
  );
  const autoSig = useMemo(
    () => `${shipGuid}|${currentShipGuid ?? ""}|${gear.map((g) => `${g.location}:${g.key}`).join(",")}|${fittedSig}|${JSON.stringify(filters)}|${JSON.stringify(cats)}`,
    [shipGuid, currentShipGuid, gear, fittedSig, filters, cats],
  );
  const sigRef = useRef(autoSig);
  sigRef.current = autoSig;
  // The refusal survives only while the run it describes is still the current question. `autoSig` opens with the
  // ship guid, so a hull change alone invalidates it, and so does any edit to gear, filters or categories.
  const vetoKey = liveVeto(vetoed.current, autoSig);
  const boundBy = bound.current && bound.current.sig === autoSig ? bound.current.breach : null;
  // Per ship too: one watermark shared across hulls made a switch either re-run needlessly or skip a ship whose
  // signature happened to match the previous one's.
  const lastRunAll = useRef<Record<string, string | null>>({});
  const lastRun = { get current() { return lastRunAll.current[shipRef.current] ?? null; },
                    set current(v: string | null) { lastRunAll.current[shipRef.current] = v; } };
  useEffect(() => {
    if (!autoSuggest || !layoutFresh || !gear.length || lastRun.current === autoSig) return;
    lastRun.current = autoSig;
    // ONE search over both halves: the whole build is being decided here, which is exactly the case the joint
    // pass exists for — the two-in-sequence answer cannot see a gun that only becomes affordable after a reactor.
    // `suggestShip` falls back to modules-then-turrets itself where a joint search does not apply (simple mode,
    // no pools, a layered battery), and that ORDER matters: the turret pass scores against the plan's non-turret
    // draw, so the module picks have to be in `assign` before it runs.
    suggestShip();
  }, [autoSuggest, layoutFresh, autoSig, gear.length, suggestShip]);
  // Clearing means "no proposals" — so mark this signature as already handled, or the auto-run would
  // immediately fill everything back in.
  // Releasing a pin also clears the "already handled" mark, or auto-suggest would consider the current state
  // done and leave the freed slot empty.
  const unpin = useCallback((key: string) => {
    setManual((m) => { const n = new Set(m); n.delete(key); return n; });
    lastRun.current = null;
  }, []);

  const clearAll = useCallback(() => {
    lastRun.current = sigRef.current;
    // The refusal notes describe the run that set them, so they go with the plan they explained.
    vetoed.current = null;
    setManual(new Set());
    setAssign({});
  }, []);

  // Fed every render so `setSlotItem`'s refill answers against the CURRENT inventory, filters and pools.
  slotCtxRef.current = { hps, mslots, gear, filters, cats, pools: pools ?? null, ranking, crit, role: role ?? null };

  /**
   * The per-slot ⚡ — one slot answered on request, through the same owner (`answerSlot`) the refill uses.
   *
   * It obeys the PINS like every other suggest path: a pinned slot carries the player's own item and a locked one
   * says what is fitted stays, and an optimizer answer written into either contradicts a decision still on screen.
   * Releasing the pin (the badge is the button) is how a player asks for that slot to be re-answered.
   */
  const suggestSlot = useCallback((key: string) => {
    if (manual.has(key) || keep.has(key)) return;
    const ctx = slotCtxRef.current;
    if (!ctx) return;
    setSlotItem(key, answerSlot(key, assign, ctx), false);
  }, [manual, keep, assign, setSlotItem]);

  return {
    suggestSlot,
    goalOrder,
    setGoalOrder,
    goalUnreadKeys,
    goalKeysOffered,
    scope,
    setScope: setSharedScope,
    tankLayer,
    frontierPts,
    frontierBusy,
    frontierSolved,
    frontierNow,
    buildFrontier,
    applyFrontier,
    clearFrontier: () => setFrontierPts(null),
    // The CAP speaks first when both refused, because it is the stronger statement: the order says nothing was
    // better on a stat you ranked, the cap says something was better and was refused anyway. A player told only
    // the first would go looking for the gain the app had decided not to take.
    // BOTH SENTENCES SAY "EVERY" OR "NO", so neither may be shown beside a plan that proposes something: the
    // refs latch when a guard fires and are not cleared by a later run that found a change, which left the note
    // contradicting the very rows under it — one plan with two verdicts. The note answers "why is nothing
    // proposed", so it belongs only where nothing is.
    // NAME THE CONTROL AND THE WAY OUT. A note saying only that something was refused leaves the player looking
    // for a setting the sentence never names — the figure it quotes appears nowhere else on screen in that form.
    // So each one says what was refused, which control refused it, and the one edit that would change the answer.
    goalNote: changes.length > 0
      // WITH a plan, the note is a WARNING about what that plan costs — named, measured, and left to the player.
      ? (planDrops.length
        ? `This plan costs ${planDrops.map((d) => `${Math.round(d.drop * 100)}% ${GOAL_LABEL[d.key]}`).join(", ")}`
          + ` — more than the ${Math.round(layerCap * 100)}% you asked to be warned about. It is still proposed;`
          + ` apply it or change the slots yourself.`
        : null)
      // WITHOUT one, two things can have refused it, and they are DIFFERENT edits to make: the ALLOWANCE, which
      // bounds what a plan may spend of a ranked stat, and the ORDER, which decides who gets to speak at all. The
      // allowance is named first because it is the newer and stricter of the two and the one a plan is most often
      // bound by at 2%.
      : boundBy
        ? `Nothing to change: the best plan would have cost ${Math.round(boundBy.drop * 100)}% `
          + `${GOAL_LABEL[boundBy.key]}, and you allow ${Math.round(boundBy.allow * 100)}%. `
          + `Raise the allowance to let it spend more, or reorder the goals so ${GOAL_LABEL[boundBy.key]} `
          + `is what gets bought.`
        : vetoKey
          ? `Nothing to change: no candidate raised ${GOAL_LABEL[vetoKey]}, the highest-ranked goal in this ship's `
            + `order that any candidate moved, and a plan that lowers it is refused whatever else it gains. `
            + `Reorder the goals to let another stat decide.`
          : null,
    planDrops,
    ranking, setRanking, crit, pools, layerCap, setLayerCap, allowance, setAllowance,
    gear, hps, mslots, cats, setCats, filters, setFilters, assign, setAssign, setSlotItem, clearAll,
    suggestTurrets, suggestModules, suggestShip, autoSuggest, setAutoSuggest, payload, changes, planRegresses, planVerdict,
    layerNote: layerPlan.note,
    pinned: manual,
    keep, toggleKeep,
    unpin,
  };
}

export default function GearTab({
  layout, builder, catalog, conn, currentShipGuid, goSummary, reactor, budgetNote, role, vitals, apply,
}: {
  layout: ShipLayout | null;
  builder: GearBuilder;
  catalog: CatalogTypes | null;
  conn: Conn;
  currentShipGuid: string | null;
  goSummary: () => void;
  reactor?: ReactorBudget | null;
  // Set when the set objective is off because the held budget and the reported one straddle a bracket edge.
  budgetNote?: string | null;
  role?: string | null;   // the ship's role — decides which stats count as useful (compareModules)
  vitals?: import("./types").Vitals | null;
  apply?: ApplyApi;   // present when this tab may commit its own section — see ApplyBar
}) {
  const { gear, hps, mslots, cats, setCats, filters, setFilters, assign, setSlotItem, payload,
    suggestTurrets, suggestModules, suggestShip, autoSuggest, setAutoSuggest, ranking, setRanking, pinned, unpin,
    keep, toggleKeep } = builder;
  // Equipped turrets from the ship layout — part of the option universe even when not in the armory.
  const equippedT = useMemo(() => hps.map((h) => h.equipped).filter((x): x is Item => !!x && isTurret(x)), [hps]);
  // ALL turret types the game knows (catalog) ∪ owned ∪ equipped — categories can group any of them,
  // not just what the player currently has. Falls back to owned+equipped if the catalog isn't loaded.
  const combatTypes = useMemo(
    () => [...new Set([
      ...(catalog?.turrets ?? []).map((t) => t.type),
      ...gear.filter(isTurret).map((g) => g.type ?? ""),
      ...equippedT.map((g) => g.type ?? ""),
    ])].filter(Boolean).sort(),
    [gear, equippedT, catalog],
  );
  const onCurrent = layout?.shipGuid === currentShipGuid;

  const [selSlot, setSelSlot] = useState<string | null>(null);
  const [aspFilter, setAspFilter] = useState<Set<string>>(new Set());
  const [listQ, setListQ] = useState(""); // name search over the compatible-equipment list
  const [hover, setHover] = useState<{ it: Item; x: number; y: number; vs?: Item | null } | null>(null);
  const [hoverSlot, setHoverSlot] = useState<number | null>(null);
  const [showCats, setShowCats] = useState(false);
  // Currently-equipped item in a slot key ("t:<idx>" / "m:<slot>") — the comparison anchor for tooltips.
  const curOf = useCallback((k: string | null) => equippedIn(k, hps, mslots), [hps, mslots]);

  // Everything currently equipped that the hovered item could REPLACE — every hardpoint of its size for
  // a turret, the matching module slot for a module. The tooltip shows these alongside the slot you
  // clicked, so a candidate is judged against the whole set it competes with rather than one slot.
  // Strongest first, since that's the bar to beat.
  const comparables = useCallback((it: Item): { it: Item; label: string }[] => {
    const out = isTurret(it)
      ? hps.filter((h) => h.size === it.size && h.equipped).map((h) => ({ it: h.equipped as Item, label: `slot ${h.index + 1}` }))
      : mslots.filter((m) => m.equipped && !!it.slotType && m.slot === it.slotType).map((m) => ({ it: m.equipped as Item, label: m.slot }));
    return out.sort((a, b) => rankValue(b.it, builder.ranking, builder.crit) - rankValue(a.it, builder.ranking, builder.crit));
  }, [hps, mslots, builder.ranking, builder.crit]);

  // The ship's draw without the module a slot currently holds, so a candidate's own draw can be added back and
  // the resulting reactor bracket compared (see compareModules).
  const modEnergy = useCallback((equipped?: Item | null) => {
    const e = builder.pools?.energy;
    return e && e.capacity > 0 ? { usedWithout: e.used - (equipped?.powerUsage ?? 0), capacity: e.capacity } : undefined;
  }, [builder.pools]);

  // The list orders modules by the same rule that suggests one, so what sits at the top is what the ⚡ picks.
  const moduleCtx = useCallback((equipped?: Item | null): ModuleCtx => {
    const turrets = hps.map((h) => builder.assign[`t:${h.index}`] ?? h.equipped).filter((x): x is Item => !!x);
    return {
      pools: builder.ranking === "expanded" ? builder.pools : null,
      turrets, energy: modEnergy(equipped), role,
      fit: shipFit(role, mslots, turrets),
    };
  }, [hps, mslots, builder.assign, builder.pools, builder.ranking, modEnergy, role]);

  // Items shown in the shared list, filtered by the selected slot + aspect OR-filter.
  const listItems = useMemo(() => {
    let items: Item[] = [];
    if (selSlot?.startsWith("t:")) {
      const idx = Number(selSlot.slice(2));
      const hp = hps.find((h) => h.index === idx);
      if (hp) items = gear.filter((g) => turretFits(g, hp.size, filters[idx] ?? { mode: "all" }, cats));
    } else if (selSlot?.startsWith("m:")) {
      const slot = selSlot.slice(2);
      const m = mslots.find((x) => x.slot === slot);
      if (m) items = gear.filter((g) => moduleFits(g, slot, m.size));
    }
    if (aspFilter.size) items = items.filter((it) => it.aspects.some((a) => aspFilter.has(a.name)));
    const q = listQ.trim().toLowerCase();
    if (q) items = items.filter((it) => it.name.toLowerCase().includes(q) || (it.type ?? "").toLowerCase().includes(q));
    // A copy: with no filter applied `items` can still be `gear` itself, and sorting in place would reorder
    // the caller's store. The ranking mode is a dependency — the order is what it changes.
    if (selSlot?.startsWith("m:")) {
      // Ordered by what each candidate does to the BATTERY against the fitted module — one number per item, so
      // the order is a ranking rather than a chain of pairwise verdicts, which need not be transitive.
      const eq = curOf(selSlot);
      const mc = moduleCtx(eq);
      const gain = new Map(items.map((it) => [handle(it), moduleGain(it, eq, mc)]));
      return [...items].sort((a, b) => {
        const d = (gain.get(handle(b)) ?? 0) - (gain.get(handle(a)) ?? 0);
        return Math.abs(d) > 1e-9 ? d : compareModules(b, a, mc.energy, role, mc.fit);
      });
    }
    return [...items].sort((a, b) => rankValue(b, builder.ranking, builder.crit) - rankValue(a, builder.ranking, builder.crit));
  }, [selSlot, hps, mslots, gear, filters, cats, aspFilter, listQ, builder.ranking, builder.crit, curOf, moduleCtx, role]);

  // Relative value of every candidate in the list, in EXPANDED mode: swap it into the selected slot, leave the
  // other slots as they stand, and score the resulting BATTERY. Expressed as a percentage of the best option,
  // because the absolute figure is only meaningful against the others — and because pooled stats mean a
  // candidate's worth depends on the set it joins, so it cannot be read off the item alone.
  const relValues = useMemo(() => {
    const out = new Map<string, number>();
    if (builder.ranking !== "expanded" || !builder.pools || !selSlot?.startsWith("t:")) return out;
    const idx = Number(selSlot.slice(2));
    const bg = background(builder.pools, hps.map((hp) => hp.equipped).filter((x): x is Item => !!x));
    const others = hps
      .filter((hp) => hp.index !== idx)
      .map((hp) => assign[`t:${hp.index}`] ?? hp.equipped)
      .filter((x): x is Item => !!x);
    // The slot's current occupant is scored alongside the candidates even though it isn't one: without it
    // the percentages have nothing to say about whether a swap is an upgrade at all.
    const current = assign[selSlot] ?? hps.find((hp) => hp.index === idx)?.equipped;
    const ranks = new Map<string, Rank>();
    let best: Rank = [0, 0];
    for (const it of current ? [...listItems, current] : listItems) {
      const key = handle(it) + it.name;
      if (ranks.has(key)) continue;
      const r = setRank([...others, it], bg);
      ranks.set(key, r);
      if (rankGt(r, best)) best = r;
    }
    // A percentage of the best option only says something when both are measured in the same unit. An unfiltered
    // slot can list a mining laser beside a cannon, and a mining gun's power share expressed as a fraction of a
    // DPS index is the incompatible-scales trap — so a candidate in a lower tier gets NO figure, the same
    // treatment an item equipped on another hardpoint already gets.
    if (best[1] > 0) for (const [k, r] of ranks) if (r[0] === best[0]) out.set(k, (r[1] / best[1]) * 100);
    return out;
  }, [builder.ranking, builder.pools, selSlot, hps, assign, listItems]);

  // What each proposed swap does to the WHOLE battery, per slot. This is the number the decision turns on and
  // it belongs beside the swap, not only in the candidate list: pooled stats and the reactor bracket mean a
  // bigger gun can be worth less, so "+0.8%" and "-3.1%" are not inferable from the two cards' stats.
  // Every proposal is scored against the OTHER slots as they will stand (their own proposals included), so the
  // numbers describe the plan being assembled rather than six independent what-ifs.
  const slotGain = useMemo(() => {
    const out = new Map<string, number>();
    if (builder.ranking !== "expanded" || !builder.pools) return out;
    const equipped = hps.map((h) => h.equipped).filter((x): x is Item => !!x);
    const bg = background(builder.pools, equipped);
    const planned = (skip: string) => hps
      .filter((h) => `t:${h.index}` !== skip)
      .map((h) => assign[`t:${h.index}`] ?? h.equipped)
      .filter((x): x is Item => !!x);
    for (const hp of hps) {
      const key = `t:${hp.index}`;
      const nu = assign[key];
      if (!nu || !hp.equipped) continue;
      const others = planned(key);
      const asIs = setRank([...others, hp.equipped], bg);
      const next = setRank([...others, nu], bg);
      // A ratio across tiers would divide Mining Power by a DPS index — and a ratio across ACTIVITIES divides
      // Mining Power by Salvage Power, which the tier check alone lets through since both are tier 1. A swap that
      // changes what the battery is FOR is stated by the plan itself, not by a percentage.
      if (asIs[1] <= 0 || !sameScale([...others, hp.equipped], [...others, nu])) continue;
      out.set(key, next[1] / asIs[1] - 1);
    }
    return out;
  }, [hps, assign, builder.pools, builder.ranking]);

  // WHY a slot proposes nothing. "keep current" was one string doing four jobs — the equipped gun is genuinely
  // the best of everything that fits; something IS better but by less than the worth-it floor; you pinned the
  // slot so the optimizer never looked; or nothing fits the filter at all. Those call for four different actions
  // (none, "raise the filter's sights", unpin, widen the filter) and the player could not tell them apart.
  //
  // The margin to the runner-up is the other half: "best of 21" says the search was real, and a floor verdict
  // that names the gain it declined is checkable against the rails, which apply the same floor.
  type Verdict =
    | { kind: "locked" }
    | { kind: "pinned" }
    | { kind: "empty-nofit" }
    | { kind: "best"; n: number }
    // Nothing can be expressed as a percentage because the CURRENT battery scores zero — see the verdict text.
    | { kind: "zero"; n: number }
    | { kind: "floor"; n: number; pct: number }
    // Better than the floor on its own numbers, and still not chosen: the whole-battery search answers a different
    // question than one slot does. Distinct from `floor` because the two call for opposite reactions — one says
    // "there is nothing here worth the trip", the other says "there is, and the set disagrees".
    | { kind: "unchosen"; n: number; pct: number }
    | { kind: "forced" };
  // WHAT THIS MODE CANNOT ANSWER. `simple` ranks each slot by the game's printed headline and nothing else — no set
  // objective, so no `min(surface, core)` and no layer reasoning of any kind. On a mining or salvage ship that is a
  // different QUESTION, not a rougher answer: a core gun has a lower headline than a surface gun, so simple mode
  // can never propose one and a ship that mines no core is told "kept" forever, which reads as "you are optimal".
  // Said out loud rather than left to be discovered, and only where it actually bites: a non-combat battery
  // whose ship could reach a layer it is not reaching.
  const modeNote = useMemo(() => {
    if (ranking === "expanded") return null;
    // A layer the ship cannot reach at all is already stated by the builder's own note; this is about the MODE.
    if (builder.layerNote) return null;
    const fittedT = hps.map((h) => h.equipped).filter((x): x is Item => !!x);
    const act = activityOf(fittedT);
    if (!act) return null;
    const mine = fittedT.filter((g) => catOf(g) === act);
    if (!mine.length) return null;
    const covered = ["Surface", "Core"].filter((l) => mine.some((g) => coversLayer(g, l)));
    if (covered.length === 2) return null;               // already on both layers; nothing is being missed
    const missing = covered.includes("Surface") ? "core" : "surface";
    return `Simple ranking sorts by the headline number only, so it will never propose a ${missing} `
      + `${act.toLowerCase()} gun — switch to expanded to balance the two ore layers.`;
  }, [ranking, builder.layerNote, hps]);

  const verdicts = useMemo(() => {
    const out = new Map<string, Verdict>();
    for (const hp of hps) {
      const key = `t:${hp.index}`;
      if (assign[key]) continue;                       // a proposal stands; the arrow already carries its %
      if (builder.keep.has(key)) { out.set(key, { kind: "locked" }); continue; }
      if (pinned.has(key)) { out.set(key, { kind: "pinned" }); continue; }
      const f = filters[hp.index] ?? { mode: "all" };
      const fits = gear.filter((g) => turretFits(g, hp.size, f, cats));
      if (!hp.equipped) { if (!fits.length) out.set(key, { kind: "empty-nofit" }); continue; }
      if (!mayKeepEquipped(hp.equipped, hp.size, f, cats)) { out.set(key, { kind: "forced" }); continue; }
      // WHAT THIS SLOT COULD ACTUALLY HAVE. An item proposed for another slot is spoken for, and counting it here
      // scored it TWICE — once inside `others` and once as the candidate — which quoted a margin no build could
      // deliver. Gear is not shared between slots, and the verdict has to obey the same rule the search does.
      const takenElsewhere = new Set<string>();
      for (const h of hps) {
        if (h.index === hp.index) continue;
        const other = assign[`t:${h.index}`] ?? h.equipped;
        if (other) takenElsewhere.add(handle(other));
      }
      const free = fits.filter((g) => g === hp.equipped || !takenElsewhere.has(handle(g)));
      const n = free.length;
      // Only expanded mode has a set-level objective to state a margin in. Simple mode's headline difference
      // shares no unit with it, so it reports the search size and stops there.
      if (builder.ranking !== "expanded" || !builder.pools) { out.set(key, { kind: "best", n }); continue; }
      const bg = background(builder.pools, hps.map((h) => h.equipped).filter((x): x is Item => !!x));
      const others = hps.filter((h) => h.index !== hp.index)
        .map((h) => assign[`t:${h.index}`] ?? h.equipped).filter((x): x is Item => !!x);
      const asIs = setRank([...others, hp.equipped], bg);
      let bestPct = 0;
      let beatsZero = false;
      for (const c of free) {
        if (c === hp.equipped) continue;
        const r = setRank([...others, c], bg);
        if (r[0] !== asIs[0]) continue;                   // no ratio across tiers
        // A ZERO baseline has no ratio either, but it is the opposite of "nothing is better": under a balanced
        // target an all-surface battery scores 0, so any candidate reaching the other layer is an unbounded
        // improvement. Reporting `kept — best of N` there told the player they were optimal at zero.
        if (asIs[1] <= 0) { if (r[1] > 0) beatsZero = true; continue; }
        const pct = rankSub(r, asIs) / asIs[1];
        if (pct > bestPct) bestPct = pct;
      }
      // THE VERDICT STATES THE REASON IT ACTUALLY HAS. A margin under the floor is the floor's verdict; a margin
      // OVER it is not, and printing "under the 1% floor" beside a figure of 8.74% is a note that argues with
      // itself. Where the set search kept a slot whose best candidate looks better alone, that IS the finding.
      out.set(key, bestPct >= MIN_GAIN ? { kind: "unchosen", n, pct: bestPct }
                 : bestPct > 0 ? { kind: "floor", n, pct: bestPct }
                 : beatsZero ? { kind: "zero", n }
                 : { kind: "best", n });
    }
    return out;
  }, [hps, gear, filters, cats, assign, pinned, builder.keep, builder.ranking, builder.pools]);

  // WHY it regressed, and only ever what was measured. The notice used to blame the reactor bracket in every case;
  // on a plan that LOWERS the load that sentence contradicted the panel beside it. The bracket is compared
  // on the same two loads the verdict was computed from — including the plan's own module draw, since a module swap
  // moves the load the turrets are bracketed against.

  // Which items this plan already spends elsewhere. Picking one here MOVES it (one physical item, one slot), so
  // the row has to say where it currently sits — otherwise the pick silently empties another slot.
  const spokenFor = useMemo(() => {
    const m = new Map<string, string>();
    for (const [k, it] of Object.entries(assign)) {
      if (k === selSlot) continue;
      m.set(handle(it), k.startsWith("t:") ? `slot ${Number(k.slice(2)) + 1}` : k.slice(2));
    }
    return m;
  }, [assign, selSlot]);

  const relValue = (it: Item): number | null => relValues.get(handle(it) + it.name) ?? null;
  // Tooltip form: the same number and reasoning as the list column, or nothing at all for an item the
  // current slot can't take (a gun equipped on another hardpoint would have to vacate it, so scoring it
  // here would compare against a battery that is short a gun).
  const relTip = (it: Item) => {
    const pct = relValue(it);
    return pct == null ? null : { pct, note: relTitle(it), metric: relMetric(it) };
  };
  // The metric the percentage is a fraction OF. A mining gun's figure is a share of Mining Power, so labelling it
  // DPS is right in the number and wrong in the word.
  const relMetric = (it: Item): string => (isCombat(it) ? "DPS" : `${catOf(it)} power`);
  const relTitle = (it: Item): string => {
    const pct = relValue(it);
    // Damage reasons only mean something for a combat gun; a mining gun's aspects and fire rate do not feed its
    // throughput, so listing them would explain the figure with terms it does not contain.
    const reasons = isCombat(it) ? scoreReasons(turretScore(it, builder.crit)) : [];
    return `${pct?.toFixed(1)}% of the best option's total ship ${relMetric(it)}`
      + (reasons.length ? ` — ${reasons.join(", ")}` : "")
      + " · scored as the whole battery, since the pools are shared across every gun";
  };

  const listAspects = useMemo(() => {
    const base = selSlot ? unfiltered() : [];
    return [...new Set(base.flatMap((it) => it.aspects.map((a) => a.name)))].sort();
    function unfiltered(): Item[] {
      if (selSlot?.startsWith("t:")) { const idx = Number(selSlot.slice(2)); const hp = hps.find((h) => h.index === idx); return hp ? gear.filter((g) => turretFits(g, hp.size, filters[idx] ?? { mode: "all" }, cats)) : []; }
      if (selSlot?.startsWith("m:")) { const slot = selSlot.slice(2); const m = mslots.find((x) => x.slot === slot); return m ? gear.filter((g) => moduleFits(g, slot, m.size)) : []; }
      return [];
    }
  }, [selSlot, hps, mslots, gear, filters, cats]);

  // The ⚡ is the builder's, so the pin guard and the answer live together rather than one being a view detail.
  const suggestSlot = builder.suggestSlot;
  // Set the SAME list-filter on every turret slot (e.g. all → a damage type or a custom category).
  const setAllFilter = (v: string) => {
    const [m, ...r] = v.split(":");
    const f: Filter = v && v !== "all" ? { mode: m as Filter["mode"], value: r.join(":") } : { mode: "all" };
    setFilters(() => Object.fromEntries(hps.map((h) => [h.index, f])));
  };

  // Grouped filter options shared by every turret slot AND the "set all" control — so all use one
  // sorted, searchable list with every type available. Universe = catalog (all game types) ∪ owned ∪
  // equipped, split into custom categories / combat type / combat damage / mining+salvage type.
  const filterGroups = (): FGroup[] => {
    const ct = catalog?.turrets ?? [];
    const ownedT = [...gear.filter(isTurret), ...equippedT];
    const combat = [...new Set([
      ...ct.filter((t) => t.category === "Combat").map((t) => t.type),
      ...ownedT.filter((g) => catOf(g) === "Combat").map((g) => g.type ?? ""),
    ])].filter(Boolean).sort();
    const dmgs = [...new Set([
      ...(catalog?.damageTypes ?? []),
      ...ownedT.filter((g) => catOf(g) === "Combat").map((g) => g.damageType).filter((d): d is string => !!d),
    ])].sort();
    const nonCombat = [...new Set([
      ...ct.filter((t) => t.category !== "Combat").map((t) => t.type),
      ...ownedT.filter((g) => catOf(g) !== "Combat").map((g) => g.type ?? ""),
    ])].filter(Boolean).sort();
    const catNames = Object.keys(cats).filter((n) => (cats[n] ?? []).some((ty) => combat.includes(ty) || nonCombat.includes(ty)));
    // Activities the player can actually field a gun for. Listed FIRST because it is the coarsest choice —
    // "I'm going mining" precedes any question about which mining laser.
    const acts = ACTIVITIES.filter((a) => ownedT.some((g) => catOf(g) === a));
    return [
      // Combat has no layers. Mining and salvage each get three: `mixed` leaves the layer open (and lets the
      // optimizer's meta search decide), the other two pin the hardpoint to one layer.
      ...(acts.length ? [{
        label: "Activity",
        opts: acts.flatMap((a) => a === "Combat"
          ? [{ v: `activity:${a}`, label: a }]
          : [{ v: `activity:${a}`, label: `${a} - mixed` },
             { v: `activity:${a}-surface`, label: `${a} - surface` },
             { v: `activity:${a}-core`, label: `${a} - core` }]),
      }] : []),
      ...(catNames.length ? [{ label: "My categories", opts: catNames.map((n) => ({ v: `category:${n}`, label: n })) }] : []),
      ...(combat.length ? [{ label: "Combat — type", opts: combat.map((t) => ({ v: `type:${t}`, label: t })) }] : []),
      ...(dmgs.length ? [{ label: "Combat — damage", opts: dmgs.map((d) => ({ v: `damage:${d}`, label: d })) }] : []),
      ...(nonCombat.length ? [{ label: "Mining / Salvage — type", opts: nonCombat.map((t) => ({ v: `type:${t}`, label: t })) }] : []),
    ];
  };

  // The candidate list lives INSIDE the selected slot, not in a column of its own: it only ever applies to one
  // slot, and a permanent rail cost horizontal space on every slot that was not selected.
  const candidateList = () => (
    // ONE picker for the whole app (`SlotPickList`) — the boosters tab renders the same component with its own
    // cells, so a change to how choosing an item WORKS lands in both at once. What is passed here is only what
    // is specific to gear: the aspect filter above the rows, and the aspect/relative-value cells inside them.
    <SlotPickList
      title="Fits this slot"
      items={listItems}
      query={listQ}
      setQuery={setListQ}
      onPick={(it) => { if (selSlot) { setSlotItem(selSlot, it); setSelSlot(null); } }}
      onClose={() => setSelSlot(null)}
      keyOf={(it) => handle(it) + it.name}
      iconOf={(it) => itemIcon(conn, it)}
      nameOf={(it) => it.name}
      rarityOf={(it) => it.rarity}
      trailOf={(it) => `Lv ${it.level}`}
      emptyText="Nothing owned fits."
      /* enter/leave only — ItemTip follows the cursor itself (no re-render per move) */
      hoverProps={(it) => ({
        onMouseEnter: (e: React.MouseEvent) => setHover({ it, x: e.clientX, y: e.clientY, vs: curOf(selSlot) }),
        onMouseLeave: () => setHover(null),
      })}
      spokenFor={(it) => spokenFor.get(handle(it)) ?? null}
      mainCell={(it) => `+${num(power(it))}`}
      header={listAspects.length > 0 ? (
        <div className="gear-asp-filter">
          <span className="dim">aspects (OR):</span>
          {listAspects.map((a) => (
            <button key={a} className={`asp-chip${aspFilter.has(a) ? " on" : ""}`} onClick={() => setAspFilter((s) => { const n = new Set(s); n.has(a) ? n.delete(a) : n.add(a); return n; })}>{a}</button>
          ))}
          {aspFilter.size > 0 && <button className="asp-chip clr" onClick={() => setAspFilter(new Set())}>clear</button>}
        </div>
      ) : null}
      cells={(it) => (
        <>
          <span className="li-slots" title={`${it.aspects.length} of ${it.aspectSlots ?? 0} aspect slots filled`}>
            <AspectMarks conn={conn} aspects={it.aspects} slots={it.aspectSlots} size={13} />
          </span>
          {relValue(it) != null && (
            // Relative value in EXPANDED mode: this candidate's resulting total ship DPS as a percentage
            // of the best candidate's, so the spread between options is visible at a glance. 100% is the
            // best on offer — the number answers "how much am I giving up by taking this one".
            <span className={`li-rel${relValue(it)! >= 99.95 ? " best" : ""}`}
              title={relTitle(it)}>{relValue(it)!.toFixed(relValue(it)! >= 99.95 ? 0 : 1)}%</span>
          )}
          {builder.ranking !== "expanded" && aspectDamageFraction(it) > 0 && (
            <span className="li-asp" title={damageAspects(it).map((a) => `${a.name}: +${Math.round(a.fraction * 100)}%${a.overTime ? " over time" : ""}`).join(" · ")}>
              +{Math.round(aspectDamageFraction(it) * 100)}%
            </span>
          )}
        </>
      )}
    />
  );

  // Escape closes the candidate pop-in — it overlays the slots below it, so there has to be a way out that
  // isn't "click the slot again". This panel stays ANCHORED to its slot and is deliberately not a modal:
  // the top layer would position it against the viewport instead, and `inert` would stop the next slot
  // being clicked, which is the interaction.
  useEscape(() => setSelSlot(null), !!selSlot);

  // The build caveat stays as a tooltip, not a sentence: it matters on the one day you updated the plugin and
  // did not restart, and it is noise on every other.
  if (!layout) return <p className="hint" title="Needs the current Hypercom build — restart the game if you just updated it">Dock once to load the layout; it stays readable while undocked.</p>;
  const sizesPresent = SIZES.filter((s) => hps.some((h) => h.size === s));


  // Turret slot panel
  const turretPanel = (hp: (typeof hps)[number]) => {
    const key = `t:${hp.index}`;
    const cur = hp.equipped;
    const nu = assign[key] ?? null;
    const f = filters[hp.index] ?? { mode: "all" };
    // Dropdown lists every turret type/damage you own (ANY size) so a filter is always selectable; the
    // item list below still enforces this slot's size (picking a type you lack in this size → empty list).
    return (
      <SlotCard key={key} className={selSlot === key ? "sel" : undefined}
        onClick={() => setSelSlot(selSlot === key ? null : key)}   // click again to close the pop-in
        onMouseEnter={() => setHoverSlot(hp.index)} onMouseLeave={() => setHoverSlot((x) => (x === hp.index ? null : x))}
        title={`Slot ${hp.index + 1}`}
        sub={hp.size}
        head={<>
          {/* ONE SWITCH, from `SlotCard`. The pin badge and the lock were two names for one state: this slot is
             the player's, not the optimizer's. The objective always agreed (it reads `manual ∪ keep` as one
             `pinned` set); only the head drew them as separate controls. What the slot is locked TO still
             differs, an item you picked or the one already fitted, which is what the tooltip names. */}
          <SlotLock locked={pinned.has(key) || keep.has(key)}
            what={cur ? cur.name : "nothing"}
            onToggle={() => {
              const wasLocked = pinned.has(key) || keep.has(key);
              if (pinned.has(key)) unpin(key);
              if (keep.has(key)) toggleKeep(key);
              // "Let the optimizer choose this slot" has to make it choose. Releasing alone only stops the
              // slot being SKIPPED, and with auto-suggest off nothing then answers it, so the slot sits on
              // whatever is fitted and the control looks inert. That gap is what the bolt was for.
              if (wasLocked) suggestSlot(key); else toggleKeep(key);
            }} />
        </>}
        current={<Vig it={cur ?? null} conn={conn} onHover={setHover} />}
        arrow={slotGain.has(key) ? (
          <span className={`gear-gain${(slotGain.get(key) as number) >= 0 ? " up" : " down"}`}
            title="Change in the whole battery's DPS, not the difference between the two cards">
            {(slotGain.get(key) as number) >= 0 ? "+" : ""}{((slotGain.get(key) as number) * 100).toFixed(1)}%
          </span>
        ) : null}
        next={<NewVig it={nu} mine={pinned.has(key)} onClear={() => setSlotItem(key, null)} onHover={(h) => setHover(h && { ...h, vs: cur ?? null })} conn={conn}
          verdict={verdictText(verdicts.get(key))} unchanged={!!nu && sameFit(cur ?? null, nu)} />}
        foot={<FilterSelect
          value={f.mode === "all" ? "" : `${f.mode}:${f.value}`}
          groups={filterGroups()}
          onChange={(v) => { const [m, ...r] = v.split(":"); setFilters((s) => ({ ...s, [hp.index]: v ? { mode: m as Filter["mode"], value: r.join(":") } : { mode: "all" } })); setSelSlot(key); }} />}
      >
        {selSlot === key && candidateList()}
      </SlotCard>
    );
  };

  return (
    <div className="gear">
      <div className="sum-head">
        {/* No title: the tab you are on says "Ship gear", and the hull and hardpoint count are drawn below.
            The one thing NOT visible elsewhere is planning against a ship you are not flying, so that alone
            stays. */}
        <div className="panel-title">{onCurrent ? "" : <span className="dim">not the current ship</span>}</div>
        <div className="sum-actions">
          <button className="undo-suggest" onClick={() => setShowCats((v) => !v)}>{showCats ? "▾ Categories" : "▸ Categories"}</button>
          {apply && <ApplyBar apply={apply} section="gear" label="gear" />}
          <button className="apply" onClick={goSummary} title="Review & apply all changes in the Summary tab">Go to Summary{payload.length ? ` (${payload.length})` : ""} →</button>
        </div>
      </div>
      {apply && <ApplyMsg apply={apply} />}
      <PlanNotice verdict={builder.planVerdict} />
      {showCats && <CategoryEditor combatTypes={combatTypes} cats={cats} setCats={setCats} />}

      <div className="gear-ship">
        <div className="gear-ship-wrap">
          <img className="gear-img" src={api.shipImageUrl(conn, layout.shipGuid, layout.name) ?? ""} alt={layout.name} />
          {hps.map((h) => {
            const on = hoverSlot === h.index || selSlot === `t:${h.index}`;
            return <span key={h.index} className={`gear-mount${on ? " hot" : ""}`} style={{ left: `${h.u * 100}%`, top: `${h.v * 100}%` }} title={`#${h.index} ${h.size}`}><span className="gear-mount-dot" /></span>;
          })}
        </div>
        <GearTotals pools={builder.pools} reactor={reactor} ranking={ranking} vitals={vitals} layerNote={builder.layerNote} budgetNote={budgetNote} shipGuid={layout?.shipGuid ?? currentShipGuid ?? null}
          curTurrets={hps.map((h) => h.equipped).filter((x): x is Item => !!x)}
          nextTurrets={hps.map((h) => assign[`t:${h.index}`] ?? h.equipped).filter((x): x is Item => !!x)}
          curOther={mslots.map((m) => m.equipped).filter((x): x is Item => !!x)}
          nextOther={mslots.map((m) => assign[`m:${m.slot}`] ?? m.equipped).filter((x): x is Item => !!x)} />
      </div>

      {modeNote && <p className="gear-modenote">{modeNote}</p>}
      {/* The player order refused this plan — said, not left as an empty tab. */}
      {builder.goalNote && <p className="gear-modenote">{builder.goalNote}</p>}

      <div className="gear-main">
        <div className="gear-slots">
          <div className="gear-mod-head">
            <div className="panel-title">Hardpoints</div>
            <span className="spacer" />
            <FilterSelect value="" placeholder="Set all to…" className="setall" groups={filterGroups()} onChange={setAllFilter} />
            {/* On (the default) the optimizer re-runs itself whenever the inventory or a filter changes,
                like the booster tab. Slots you set yourself are never overwritten. */}
            <button
              className={`asp-chip${autoSuggest ? " on" : ""}`}
              title={autoSuggest
                ? "Auto: re-suggests whenever your inventory or filters change (slots you set yourself are kept)"
                : "Auto off — suggestions only when you press the buttons"}
              onClick={() => setAutoSuggest(!autoSuggest)}
            >auto</button>
            {/* WHICH QUESTION THE RANKING ANSWERS, as a segmented control: two buttons with FIXED labels and the
                active one lit. It was one button whose label was the mode it was IN — which reads as a button that
                does the thing written on it, so a player in `simple` saw "simple" and believed they had chosen the
 full model. A control that has to be read twice is a
                control that will be read wrong, and this one silently decides whether the objective can reason
                about ore layers at all. */}
            <span className="gear-mode" role="group" aria-label="ranking model">
              <button className={`seg ${ranking === "simple" ? "on" : ""}`}
                title="Simple: the game's headline main stat only — no set objective, and no ore-layer balancing."
                onClick={() => setRanking("simple")}>simple</button>
              <button className={`seg ${ranking === "expanded" ? "on" : ""}`}
                title="Expanded: the whole battery as one objective, priced on your ship's crit setup"
                onClick={() => setRanking("expanded")}>expanded</button>
              {/* THE MODEL, and it is disabled until it can actually answer. A mode that ranks on nothing is
                  exactly the defect the `simple`-mode report described — it proposed swaps, offered Apply, and
                  the panel admitted it had no model behind it. So the button carries its own reason instead of
 being silently inert, and cannot be selected while `modelBlock` names one. */}
              <button className={`seg ${ranking === "model" ? "on" : ""}`}
                disabled={!!modelBlock(role)}
                title={modelBlock(role)
                  ? MODEL_BLOCK_TEXT[modelBlock(role)!]
                  : "Model: the arena's trained net scores the whole battery against a combat target and answers in SECONDS to deplete it — lower is better. It is the only ranking here that knows about resists, armor weakness and mitigation."}
                onClick={() => setRanking("model")}>model</button>
            </span>
            {/* WHAT AN ITEM IS, OR WHAT IT COULD BE — the officers tab's control, shared rather than copied: one
                choice, one pair of labels, and changing it on either tab changes both. What it means here is
                workshop QUALITY, which multiplies every stat line except the main one by 1.01 per level up to a
                ceiling set by rarity (Legendary 25, Exotic 20, HighGrade 15). A gun's headline Combat Power is the
                main stat ∴ quality is invisible in the one figure the item's card leads with, and the substats it
                does move are what feed the ship's pools. */}
            <span className="gear-mode" role="group" aria-label="item scope">
              <button className={`seg ${builder.scope === "current" ? "on" : ""}`}
                title="Rank every item by the stats it has TODAY."
                onClick={() => builder.setScope("current")}>current</button>
              <button className={`seg ${builder.scope === "potential" ? "on" : ""}`}
                title="Rank everything as if workshop quality were maxed, fitted items included"
                onClick={() => builder.setScope("potential")}>full potential</button>
            </span>
            {/* WHAT A PLAN MAY SPEND OF A LAYER. Beside the ranking because it is part of the same question —
                what "better" means for this ship — and stated as a percentage of what the ship already has, so
                it needs no knowledge of the hull's actual figure. 0 means no defensive loss at all is accepted;
                100 restores the old behaviour, where the objective had no opinion on survivability. */}
            <label className="gear-cap" title={`Warn when a plan lowers any tracked measurement by more than this share`}>
              {/* The label says what the number DOES. It began as "keep 10% of each layer", which read as its own
                  inverse, then as a spend ceiling that refused plans; it is now the level at which a plan's costs
                  are reported. The note quotes this label back verbatim so the sentence and the box that produced
                  it can be connected on sight. */}
              warn over
              <input type="number" min={0} max={100} step={5}
                value={Math.round(builder.layerCap * 100)}
                onChange={(e) => {
                  const pc = Number(e.target.value);
                  if (Number.isFinite(pc)) builder.setLayerCap(Math.min(1, Math.max(0, pc / 100)));
                }} />
              % drop
            </label>
            {/* WHAT A PLAN MAY SPEND OF A RANKED STAT, and the difference from the box beside it is the whole
                point: `warn over` REPORTS a cost, this one REFUSES it. An order can only sequence goals — any
                gain on the first outranks any loss below it — so this is the only control that can price a trade
                without anyone stating an exchange rate between two stats: a fraction of the build you already
                fly. Applies to every ranked stat EXCEPT the first, which is the one being bought. */}
            <label className="gear-cap" title={`Refuse a plan that costs a lower-ranked goal more than this share of what you have`}>
              allow
              <input type="number" min={0} max={100} step={1}
                value={Math.round(builder.allowance * 100)}
                onChange={(e) => {
                  const pc = Number(e.target.value);
                  if (Number.isFinite(pc)) builder.setAllowance(Math.min(1, Math.max(0, pc / 100)));
                }} />
              % loss
            </label>
            {/* BOTH halves at once. Beside the two single-block buttons, ⊥ replacing them: most refits are one
                half and the smaller search is the faster answer, while this one is what the whole build being
                decided asks for — a gun that only becomes affordable after a reactor is invisible to either
 half alone. */}
            <button className="undo-suggest" onClick={suggestShip}
                    title="Guns and modules together: finds pairs neither button sees alone">
              Suggest whole ship
            </button>
            <button className="undo-suggest" onClick={suggestTurrets}>Suggest guns</button>
          </div>
          {/* ITS OWN ROW, beneath the buttons rather than inside them: the cap is one number and belongs on a
              button bar, the order is a LIST and never did. Collapsed it is the sentence a plan should be read
              beside; open it needs the full width the bar could not give it. */}
          <GoalOrder order={builder.goalOrder} setOrder={builder.setGoalOrder} unread={builder.goalUnreadKeys}
                     offer={builder.goalKeysOffered} />
          {/* Directly under the order it sweeps: the ORDER says which stat wins, the `allow` box says how much of
              the others a plan may spend, and this shows what the other settings of that box actually return. One
              mechanism, read top to bottom, with no third idea between them. */}
          <AllowanceSweep
            order={builder.goalOrder}
            now={builder.frontierNow}
            allowance={builder.allowance}
            points={builder.frontierPts}
            solved={builder.frontierSolved}
            busy={builder.frontierBusy}
            onBuild={builder.buildFrontier}
            onPick={builder.applyFrontier}
            onClear={builder.clearFrontier}
          />
          <div className="gear-cols">
            {sizesPresent.map((size) => (
              <div key={size} className="gear-col">
                <div className="gear-col-head">{size} <span className="dim">· {hps.filter((h) => h.size === size).length}</span></div>
                {hps.filter((h) => h.size === size).map((h) => turretPanel(h))}
              </div>
            ))}
          </div>

          <div className="gear-modules">
            <div className="gear-mod-head">
              <div className="panel-title">Modules</div>
              <button className="undo-suggest" onClick={suggestModules}>Suggest</button>
            </div>
            <div className="gear-cols">
              {mslots.map((m, i) => {
                const key = `m:${m.slot}`;
                const nu = assign[key] ?? null;
                return (
                  <div key={i} className={`gear-panel${selSlot === key ? " sel" : ""}`}
                    onClick={() => setSelSlot(selSlot === key ? null : key)}>
                    <div className="gear-panel-head">{m.slot} <span className="dim">· {m.size}</span>
                      <SlotLock locked={pinned.has(key) || keep.has(key)}
                        what={m.equipped ? m.equipped.name : "nothing"}
                        onToggle={() => {
                          const wasLocked = pinned.has(key) || keep.has(key);
                          if (pinned.has(key)) unpin(key);
                          if (keep.has(key)) toggleKeep(key);
                          // "Let the optimizer choose this slot" has to make it choose. Releasing alone only stops the
                          // slot being SKIPPED, and with auto-suggest off nothing then answers it, so the slot sits on
                          // whatever is fitted and the control looks inert. That gap is what the bolt was for.
                          if (wasLocked) suggestSlot(key); else toggleKeep(key);
                        }} /></div>
                    <div className="gear-swap">
                      <Vig it={m.equipped} conn={conn} onHover={setHover} />
                      <span className="gear-arrow">→</span>
                      <NewVig it={nu} mine={pinned.has(key)} onClear={() => setSlotItem(key, null)} onHover={(h) => setHover(h && { ...h, vs: m.equipped })} conn={conn}
                        unchanged={!!nu && sameFit(m.equipped, nu)} />
                    </div>
                    {selSlot === key && candidateList()}
                  </div>
                );
              })}
            </div>
          </div>
        </div>


      </div>

      {/* Suppressed mid-drag: the tooltip follows the cursor, so it sits between the pointer and the slot the
          player is aiming at — it hides the drop target and its own hover handlers fight the drag. */}
      {hover && <ItemTip it={hover.it} x={hover.x} y={hover.y} conn={conn} vs={hover.vs} others={comparables(hover.it)} rel={relTip} />}
    </div>
  );
}

// The per-slot selector lives in `SlotCard` — both tabs render it, so a slot is changed the same way in each.

// The game's icon for a slot vignette. Same source as the tooltips (api.itemIcon) — store handle for
// inventory gear, ship slot for what's equipped.
// The one-line discriminator under an item's name, shared by BOTH cards. It lived twice: `Vig` chose damage type
// for a combat gun and activity+layer otherwise, while `NewVig` had a naive `damageType ?? catOf` — so one Core
// Buster read "Mining · Core" as CURRENT and "Explosive" as NEW, which looks like two different items.
function vigSub(it: Item): string {
  // For a combat gun the damage type is the useful discriminator; for a mining or salvage one it is the activity
  // and the layer it can reach, since a Core laser is useless on a surface deposit.
  if (!isTurret(it)) return `Lv ${it.level}`;
  return catOf(it) === "Combat"
    ? `${it.damageType ?? ""} · Lv ${it.level}`
    : `${activityLabel(it)} · Lv ${it.level}`;
}

// The vignettes themselves live in `SlotCard` — one owner, so the booster tab's slots and these are the same
// object rather than the same idea. These two wrappers supply the GEAR reading of an item: what its sub-line
// says and which marks ride beside it.
const gearSub = (it: Item) => `${vigSub(it)} · +${num(power(it))}`;
const gearMarks = (it: Item, conn: Conn) => (
  <AspectMarks conn={conn} aspects={it.aspects} slots={it.aspectSlots} size={18} />
);

function Vig({ it, conn, onHover }: { it: Item | null; conn: Conn; onHover?: (h: { it: Item; x: number; y: number } | null) => void }) {
  return <BaseVig it={it} conn={conn} onHover={onHover}
                  sub={it ? gearSub(it) : null} extra={it ? gearMarks(it, conn) : null} />;
}

function NewVig({ it, onClear, onHover, dimmed, conn, verdict, unchanged, mine }: { it: Item | null; onClear?: () => void; onHover: (h: { it: Item; x: number; y: number } | null) => void; dimmed?: boolean; conn: Conn; verdict?: { text: string; why?: string } | null; unchanged?: boolean; mine?: boolean }) {
  return (
    <BaseNewVig it={it} onClear={onClear} onHover={onHover} dimmed={dimmed} conn={conn}
                verdict={verdict} unchanged={unchanged} mine={mine}
                sub={it ? gearSub(it) : null} extra={it ? gearMarks(it, conn) : null} />
  );
}

function CategoryEditor({ combatTypes, cats, setCats }: { combatTypes: string[]; cats: Record<string, string[]>; setCats: (c: Record<string, string[]>) => void }) {
  const [name, setName] = useState("");
  const [typeQ, setTypeQ] = useState(""); // name filter for the type checkboxes (e.g. "rail")
  const add = () => { const n = name.trim(); if (n && !cats[n]) { setCats({ ...cats, [n]: [] }); setName(""); } };
  const del = (n: string) => { const c = { ...cats }; delete c[n]; setCats(c); };
  const toggle = (n: string, ty: string) => { const cur = new Set(cats[n] ?? []); cur.has(ty) ? cur.delete(ty) : cur.add(ty); setCats({ ...cats, [n]: [...cur] }); };
  const shownTypes = combatTypes.filter((ty) => ty.toLowerCase().includes(typeQ.trim().toLowerCase()));
  return (
    <div className="gear-cats">
      <div className="gear-cats-add">
        <input value={name} onChange={(e) => setName(e.target.value)} placeholder="new category (e.g. Long range = railguns + missiles)" onKeyDown={(e) => { if (e.key === "Enter") add(); }} />
        <button className="undo-suggest" onClick={add} disabled={!name.trim()}>+ add</button>
      </div>
      {Object.keys(cats).length > 0 && (
        <div className="gear-cats-add">
          <input value={typeQ} onChange={(e) => setTypeQ(e.target.value)} placeholder="filter turret types… (e.g. rail)" />
          {typeQ && <button className="undo-suggest" onClick={() => setTypeQ("")}>clear</button>}
        </div>
      )}
      {Object.keys(cats).length === 0 && <div className="sum-none" title="Categories appear in each combat slot's filter">No categories yet.</div>}
      {Object.entries(cats).map(([n, types]) => (
        <div key={n} className="gear-cat">
          <div className="gear-cat-head"><b>{n}</b> <span className="dim">· {types.length}</span><span className="spacer" /><button className="rm" onClick={() => del(n)}>×</button></div>
          <div className="gear-cat-types">{shownTypes.map((ty) => <label key={ty} className={types.includes(ty) ? "on" : ""}><input type="checkbox" checked={types.includes(ty)} onChange={() => toggle(n, ty)} /> {ty}</label>)}</div>
        </div>
      ))}
    </div>
  );
}
