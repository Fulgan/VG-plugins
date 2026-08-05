import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, itemIcon, type Conn } from "./api";
import type { CatalogTypes, Inventories, Item, ShipHardpoint, ShipLayout } from "./types";
import { RARITY_COLOR, num, mainVal, effectiveMainVal } from "./format";
import { aspectDamageFraction, damageAspects } from "./aspect";
import { turretScore, scoreReasons, BASE_CRIT, type CritContext } from "./turretScore";
import { activityOf, optimizeTurretSet, optimizeTurretSetLayered, coversLayer, sameScale, background, setRank, rankGt, rankSub, worthSwitching, isCombat, moduleBetter, moduleGain, shortlist, MIN_GAIN, type LayerRole, type LayerTarget, type ModuleCtx, type PowerActivity, type Rank, type ShipPools } from "./fleetDps";
import { AspectMarks } from "./AspectMark";
import { load, save } from "./storage";
import { ACTIVITIES, catOf, activityLabel, compareModules, equippedIn, isTurret, shipFit, type Activity } from "./itemKind";
import { ItemTip } from "./ItemCard";
import { useEscape } from "./Modal";
import { turretFits, moduleFits, mayKeepEquipped, parseActivity, type GearFilter } from "./gearFit";
import { energyDraw, reactorModifier } from "./reactor";
import GearTotals, { type ReactorInfo } from "./GearTotals";
import ApplyBar, { ApplyMsg } from "./ApplyBar";
import PlanNotice from "./PlanNotice";
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
export type Ranking = "simple" | "expanded";
const RANK_KEY = "shipoptimizer.gearRanking";
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
export const rankValue = (it: Item, mode: Ranking, crit: CritContext): number =>
  !isTurret(it) ? effectiveMainVal(it) ?? 0
  : mode === "simple" ? power(it)
  : isCombat(it) ? turretScore(it, crit).score
  : effectiveMainVal(it) ?? 0;
export { ACTIVITIES, catOf, activityLabel, isTurret };
export { ItemTip };
export type { Activity };

// A slot's "no proposal" verdict as text. `why` is the second line: the action it implies, since each of these
// wants a DIFFERENT one from the player and an undifferentiated "keep current" implied none.
function verdictText(v: { kind: string; n?: number; pct?: number } | undefined): { text: string; why: string } | null {
  if (!v) return null;
  switch (v.kind) {
    case "locked":
      return { text: "locked to current", why: "You chose to keep what is fitted here, so nothing is proposed for it. Click the lock to release it." };
    case "pinned":
      return { text: "you set this", why: "Suggestions skip a slot you chose yourself — release the pin to have it re-answered." };
    case "empty-nofit":
      return { text: "nothing fits", why: "Empty, and nothing you own matches this slot's filter and size. Widen the filter." };
    case "forced":
      return { text: "breaks this filter", why: "The fitted gun does not match the filter you set here, so a switch is owed — press ⚡ or pick one." };
    case "floor":
      return {
        text: `kept — best of ${v.n} beats it by only ${((v.pct ?? 0) * 100).toFixed(2)}%`,
        why: `Under the ${MIN_GAIN * 100}% worth-it floor, so it is not worth a hangar trip. The opportunity rails apply the same floor and will not offer it either.`,
      };
    default:
      return { text: `kept — best of ${v.n}`, why: "Nothing that fits this slot's filter and size scores higher for the whole battery." };
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


/** What the builder needs to answer one slot. Passed explicitly so the answer is a pure function of the plan. */
export interface SlotCtx {
  hps: ShipHardpoint[];
  mslots: { slot: string; size: string; equipped: Item | null }[];
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
  // Set when the ship cannot reach one layer at all, so the score is single-layer BY NECESSITY rather than
  // by choice — the UI states it, since a silent substitution is indistinguishable from a bug.
  layerNote: string | null;
}

// Shared gear state (assignments + per-ship filters + categories), lifted into App so the Gear tab and
// the Summary tab work off one result.
export function useGearBuilder(layout: ShipLayout | null, inv: Inventories | null, currentShipGuid?: string | null, crit: CritContext = BASE_CRIT, pools?: ShipPools | null, role?: string | null): GearBuilder {
  // The layout and the live ship can disagree for a moment after a ship change (separate fetches). Every
  // proposal is derived from the layout's slots, so while they disagree we suggest nothing and apply
  // nothing — a plan for the previous hull's hardpoints is worse than no plan.
  const layoutFresh = !!layout && (!currentShipGuid || layout.shipGuid === currentShipGuid);
  const gear = useMemo<Item[]>(() => {
    const out: Item[] = [];
    for (const st of inv?.stores ?? [])
      for (const it of st.items)
        if (it.category === "Turret" || isModule({ ...it, location: st.id }))
          out.push({ ...it, location: st.id });
    return out;
  }, [inv]);
  const shipGuid = layout?.shipGuid ?? "";
  const [cats, setCatsS] = useState<Record<string, string[]>>(loadCats);
  // Ranking mode is a per-user preference, not per ship: it is a question about how to judge gear.
  const [ranking, setRankingS] = useState<Ranking>(loadRanking);
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
    .map((h) => (h.equipped ? { ...h, equipped: { ...h.equipped, slotKey: `t:${h.index}` } } : h)), [layout]);
  const mslots = useMemo(() => (layout?.modules ?? [])
    .map((m) => (m.equipped ? { ...m, equipped: { ...m.equipped, slotKey: `m:${m.slot}` } } : m)), [layout]);
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
  const planRegresses = useMemo<boolean | null>(() => {
    if (!pools || ranking !== "expanded" || !layoutFresh || !changes.length) return null;
    const curTurrets = hps.map((h) => h.equipped).filter((x): x is Item => !!x);
    const nextTurrets = hps.map((h) => assign[`t:${h.index}`] ?? h.equipped).filter((x): x is Item => !!x);
    const curOther = mslots.map((m) => m.equipped).filter((x): x is Item => !!x);
    const nextOther = mslots.map((m) => assign[`m:${m.slot}`] ?? m.equipped).filter((x): x is Item => !!x);
    if (!sameScale(curTurrets, nextTurrets)) return null;   // two different units — no comparison to make
    const bg = background(pools, curTurrets);
    const draw = energyDraw(nextOther) - energyDraw(curOther);
    const bgNext = bg.energy
      ? { ...bg, energy: { ...bg.energy, used: bg.energy.used + draw } }
      : bg;
    const cur = setRank(curTurrets, bg);
    const next = setRank(nextTurrets, bgNext);
    // Nothing this objective can weigh: same guns, same load.
    if (draw === 0 && rankSub(next, cur) === 0) return null;
    return rankGt(cur, next);
  }, [pools, ranking, layoutFresh, changes, hps, mslots, assign]);
  // ---- suggestion engine ----
  // Lives in the builder, not the Gear tab, so auto-suggest keeps working whichever tab is open (the
  // Summary tab shows proposals for a ship whose Gear tab you never visited). Slots in `manual` are
  // skipped: your explicit choice wins.
  // Which layers this ship can reach AT ALL, from everything it owns plus what is fitted. Balance is only a
  // requirement where it is achievable: if you own no Core gun, demanding both layers scores every possible build
  // 0 and the tab goes quiet — which punishes you for not owning a part rather than for building badly. So the
  // target degrades, and the substitution is LABELLED rather than left to be inferred from a dead button.
  //
  // Achievability is a property of the INVENTORY, so it is derived here rather than from the click-time candidate
  // lists — one owner, and the note the UI shows is the same fact the optimizer acted on.
  const layerPlan = useMemo(() => {
    const act = ["Mining", "Salvage"].find((a) => [...gear, ...hps.map((h) => h.equipped).filter((x): x is Item => !!x)].some((g) => catOf(g) === a)) ?? null;
    if (!act) return { act: null, degradeTo: null as LayerTarget | null, note: null as string | null };
    const universe = [...gear, ...hps.map((h) => h.equipped).filter((x): x is Item => !!x)].filter((g) => catOf(g) === act);
    const canS = universe.some((g) => coversLayer(g, "Surface"));
    const canC = universe.some((g) => coversLayer(g, "Core"));
    if (canS === canC) return { act, degradeTo: null, note: null };
    return {
      act,
      degradeTo: (canS ? "surface" : "core") as LayerTarget,
      note: `No ${canS ? "core" : "surface"} ${act.toLowerCase()} gun in stock — this build is scored on ${canS ? "surface" : "core"} alone.`,
    };
  }, [gear, hps]);

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
        const keepOk = (hp: ShipHardpoint) =>
          mayKeepEquipped(hp.equipped, hp.size, filters[hp.index] ?? { mode: "all" }, cats);
        const slots = open.map((hp) => ({
          key: `t:${hp.index}`,
          // KEEPING what is fitted is an option — unless the filter rules it out, per keepOk. Without the
          // equipped item as a candidate the optimizer would be forced to name an inventory item for every slot
          // and a separate "is it better?" test would have to undo that, against a different baseline.
          current: keepOk(hp) ? hp.equipped : undefined,
          candidates: [
            ...(hp.equipped && keepOk(hp) ? [hp.equipped] : []),
            // Shortlisted, because the search is linear in this list and runs once per layer assignment: a
            // long playthrough's armory holds thousands of guns per size, of which only the best on each
            // axis can win (see `shortlist`).
            ...shortlist(gear.filter((g) => turretFits(g, hp.size, filters[hp.index] ?? { mode: "all" }, cats) && !used.has(handle(g)))),
          ],
        }));
        // A slot's layer ROLE is derived from its own filter — no second piece of state to keep in step, and the
        // "Set all to…" bulk write already reaches it. `mixed`/no filter leaves the slot open for the meta search.
        const roleOf = (hp: ShipHardpoint): LayerRole => {
          const f = filters[hp.index] ?? { mode: "all" as const };
          if (f.mode !== "activity") return "any";
          const { layer } = parseActivity(f.value);
          return layer === "Surface" ? "surface" : layer === "Core" ? "core" : "any";
        };
        const withRoles = slots.map((sl, i) => ({ ...sl, layerRole: roleOf(open[i]) }));

        // And the ship-level TARGET is derived from those roles rather than being its own control: pin every slot
        // to one layer and that is plainly what you are building for; leave them open and both layers are wanted.
        const roles = withRoles.map((sl) => sl.layerRole);
        let target: LayerTarget =
          roles.every((r) => r === "surface") ? "surface"
          : roles.every((r) => r === "core") ? "core"
          : "balanced";

        // Only a non-combat battery has layers to balance, and the activity is the SHIP'S. A slot FILTER naming an
        // activity decides it: that is an explicit instruction, and it is also what generated the candidates, so
        // anything else scores a mining candidate against the salvage pool and rates every one of them 0. Failing
        // that, what is FITTED, then the hull's role. Deriving it from the candidate pool was wrong: that pool
        // holds every gun of the right size, so a salvage hull whose owner also owns mining lasers resolved to
        // "Mining".
        const filterActs = new Set(open
          .map((hp) => filters[hp.index] ?? { mode: "all" as const })
          .filter((f) => f.mode === "activity")
          .map((f) => parseActivity(f.value).act));
        const filterAct = filterActs.size === 1 ? [...filterActs][0] : null;
        const fittedAct = activityOf(hps.map((hp) => hp.equipped).filter((x): x is Item => !!x));
        const roleAct = role === "Mining" || role === "Salvaging" ? (role === "Mining" ? "Mining" : "Salvage") : null;
        const wantedAct = filterAct ?? fittedAct ?? roleAct;
        // Combat is not a layered activity and has no power pool of its own to bottleneck.
        const layerAct: PowerActivity | null =
          wantedAct === "Mining" || wantedAct === "Salvage" ? (wantedAct as PowerActivity) : null;
        // Balance is only REQUIRED where achievable — see the `layerPlan` memo. If nothing you own reaches a
        // layer, demanding both would score every build 0 and the tab would go silent.
        if (target === "balanced" && layerPlan.degradeTo) target = layerPlan.degradeTo;
        const chosen = layerAct
          ? optimizeTurretSetLayered(withRoles, bg, layerAct, { target, maxPasses: 4, fixed })
          : optimizeTurretSet(slots, bg, 4, fixed);
        // Judge the PLAN, not each slot in isolation. A per-slot floor lets a set through whose slots each look
        // worthwhile only because the OTHER slots were assumed to change too; apply it and the new baseline makes
        // yet another set look worthwhile, which is the apply → new suggestions → apply ping-pong. Requiring the
        // whole set to beat what is fitted by more than the floor makes the applied build a fixed point: after
        // applying, the same computation proposes nothing.
        const fittedAll = [...fixed, ...open.map((hp) => hp.equipped).filter((x): x is Item => !!x)];
        const plannedAll = [...fixed, ...open.map((hp) => chosen.get(`t:${hp.index}`) ?? hp.equipped).filter((x): x is Item => !!x)];
        // The activity is the SHIP'S, fixed for the whole comparison: scoring `now` as Salvage and `plan` as
        // Mining compares two units and the fatter pool always wins.
        const now = setRank(fittedAll, bg, target, layerAct ?? undefined);
        const plan = setRank(plannedAll, bg, target, layerAct ?? undefined);
        // A forced switch (the fitted gun breaks its slot's filter) is exempt: compliance is the point there. But
        // the exemption is that SLOT'S, not the whole plan's — one non-compliant hardpoint used to waive the floor
        // for every other slot, which is how a strictly worse build shipped: two good guns were swapped out
        // alongside the one that had to move, with nothing checking they were an improvement.
        if (!worthSwitching(plan, now)) {
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
  }, [gear, hps, filters, cats, manual, keep, ranking, crit, pools]);
  const suggestModules = useCallback(() => {
    const pinned = new Set([...manual, ...keep]);
    setAssign((a) => {
      const n = { ...a };
      const used = new Set<string>(Object.entries(a).filter(([k]) => pinned.has(k)).map(([, it]) => handle(it)));
      for (const m of mslots) {
        const key = `m:${m.slot}`;
        if (pinned.has(key)) continue;
        // Same comparator as the per-slot suggest and the list order, so the three cannot disagree about which
        // module is better — headline, then energy draw, then how much else it brings.
        const en = pools?.energy && pools.energy.capacity > 0
          ? { usedWithout: pools.energy.used - (m.equipped?.powerUsage ?? 0), capacity: pools.energy.capacity } : undefined;
        // A swap must not quietly give up a reactor bracket. Under the OBJECTIVE the bracket is a term like any
        // other — `poolsWithModule` moves the draw and `poolParts` re-brackets on it — but the comparator that
        // decides the remaining ties cannot see that crossing an edge scales EVERY power pool at once (+20% →
        // +10% at half capacity), so it stays a CONSTRAINT wherever the objective is not deciding.
        const keepsBracket = (cand: Item): boolean => {
          const e = pools?.energy;
          if (!e || !(e.capacity > 0)) return true;
          const planned = mslots.map((s) => (s.slot === m.slot ? cand : n[`m:${s.slot}`] ?? s.equipped)).filter((x): x is Item => !!x);
          const current = mslots.map((s) => s.equipped).filter((x): x is Item => !!x);
          const after = e.used - energyDraw(current) + energyDraw(planned);
          return reactorModifier(after / e.capacity) >= reactorModifier(e.used / e.capacity);
        };
        const turrets = hps.map((h) => a[`t:${h.index}`] ?? h.equipped).filter((x): x is Item => !!x);
        const mctx: ModuleCtx = {
          pools: ranking === "expanded" ? pools : null,
          turrets, energy: en, role, fit: shipFit(role, mslots, turrets),
        };
        const fits = gear.filter((g) => moduleFits(g, m.slot, m.size) && !used.has(handle(g)) && keepsBracket(g));
        const best = fits.reduce<Item | undefined>((x, y) => (!x || moduleBetter(y, x, mctx) ? y : x), undefined);
        if (best && moduleBetter(best, m.equipped, mctx)) { n[key] = best; used.add(handle(best)); }
        else delete n[key];
      }
      return n;
    });
  }, [gear, mslots, filters, cats, manual, keep, ranking, crit, pools, role]);

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
  // Per ship too: one watermark shared across hulls made a switch either re-run needlessly or skip a ship whose
  // signature happened to match the previous one's.
  const lastRunAll = useRef<Record<string, string | null>>({});
  const lastRun = { get current() { return lastRunAll.current[shipRef.current] ?? null; },
                    set current(v: string | null) { lastRunAll.current[shipRef.current] = v; } };
  useEffect(() => {
    if (!autoSuggest || !layoutFresh || !gear.length || lastRun.current === autoSig) return;
    lastRun.current = autoSig;
    // Modules FIRST: the turret optimizer scores against the plan's non-turret draw, so the module picks have to
    // be in `assign` before it runs. The other order left turrets optimised for a load the plan then changed.
    suggestModules();
    suggestTurrets();
  }, [autoSuggest, layoutFresh, autoSig, gear.length, suggestTurrets, suggestModules]);
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
    setManual(new Set());
    setAssign({});
  }, []);

  // Fed every render so `setSlotItem`'s refill answers against the CURRENT inventory, filters and pools.
  slotCtxRef.current = { hps, mslots, gear, filters, cats, pools: pools ?? null, ranking, crit, role: role ?? null };

  return {
    ranking, setRanking, crit, pools,
    gear, hps, mslots, cats, setCats, filters, setFilters, assign, setAssign, setSlotItem, clearAll,
    suggestTurrets, suggestModules, autoSuggest, setAutoSuggest, payload, changes, planRegresses,
    layerNote: layerPlan.note,
    pinned: manual,
    keep, toggleKeep,
    unpin,
  };
}

export default function GearTab({
  layout, builder, catalog, conn, currentShipGuid, goSummary, reactor, role, vitals, apply,
}: {
  layout: ShipLayout | null;
  builder: GearBuilder;
  catalog: CatalogTypes | null;
  conn: Conn;
  currentShipGuid: string | null;
  goSummary: () => void;
  reactor?: ReactorInfo | null;
  role?: string | null;   // the ship's role — decides which stats count as useful (compareModules)
  vitals?: import("./types").Vitals | null;
  apply?: ApplyApi;   // present when this tab may commit its own section — see ApplyBar
}) {
  const { gear, hps, mslots, cats, setCats, filters, setFilters, assign, setSlotItem, payload,
    suggestTurrets, suggestModules, autoSuggest, setAutoSuggest, ranking, setRanking, pinned, unpin,
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
    | { kind: "floor"; n: number; pct: number }
    | { kind: "forced" };
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
      const n = fits.length;
      // Only expanded mode has a set-level objective to state a margin in. Simple mode's headline difference
      // shares no unit with it, so it reports the search size and stops there.
      if (builder.ranking !== "expanded" || !builder.pools) { out.set(key, { kind: "best", n }); continue; }
      const bg = background(builder.pools, hps.map((h) => h.equipped).filter((x): x is Item => !!x));
      const others = hps.filter((h) => h.index !== hp.index)
        .map((h) => assign[`t:${h.index}`] ?? h.equipped).filter((x): x is Item => !!x);
      const asIs = setRank([...others, hp.equipped], bg);
      let bestPct = 0;
      for (const c of fits) {
        if (c === hp.equipped) continue;
        const r = setRank([...others, c], bg);
        if (r[0] !== asIs[0] || asIs[1] <= 0) continue;   // no ratio across tiers
        const pct = rankSub(r, asIs) / asIs[1];
        if (pct > bestPct) bestPct = pct;
      }
      out.set(key, bestPct > 0 ? { kind: "floor", n, pct: bestPct } : { kind: "best", n });
    }
    return out;
  }, [hps, gear, filters, cats, assign, pinned, builder.keep, builder.ranking, builder.pools]);

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

  // valid drop targets for the item being dragged

  // Best match for a single slot (honors its filter/size), excluding gear assigned to other slots.
  // Delegates to the one owner, so the ⚡ and the refill after a pick cannot disagree about what fits here.
  const suggestSlot = (key: string) => {
    const next = answerSlot(key, assign, {
      hps, mslots, gear, filters, cats,
      pools: builder.pools ?? null, ranking: builder.ranking, crit: builder.crit, role: role ?? null,
    });
    setSlotItem(key, next, false);
  };
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
    // A pop-in over the slot, not a column and not inline: a permanent rail cost width on every unselected
    // slot, and putting it in the flow made each card taller. `stopPropagation` because the panel behind it
    // toggles selection on click.
    <div className="gear-list-popin" onClick={(e) => e.stopPropagation()}>
      <div className="gear-list-head">
        <b>Fits this slot</b>
        <span className="dim">· {listItems.length}</span>
        <span className="spacer" />
        <button className="popin-x" title="close (Esc)" onClick={() => setSelSlot(null)}>×</button>
      </div>
      {selSlot && <input className="gear-list-search" value={listQ} onChange={(e) => setListQ(e.target.value)} placeholder="search name / type…" />}
      {listAspects.length > 0 && (
        <div className="gear-asp-filter">
          <span className="dim">aspects (OR):</span>
          {listAspects.map((a) => (
            <button key={a} className={`asp-chip${aspFilter.has(a) ? " on" : ""}`} onClick={() => setAspFilter((s) => { const n = new Set(s); n.has(a) ? n.delete(a) : n.add(a); return n; })}>{a}</button>
          ))}
          {aspFilter.size > 0 && <button className="asp-chip clr" onClick={() => setAspFilter(new Set())}>clear</button>}
        </div>
      )}
      <div className="gear-list">
        {selSlot && listItems.length === 0 && <div className="sum-none">Nothing owned fits.</div>}
        {listItems.map((it) => (
          // Clicking the row IS the pick: the list opens inside the slot it applies to, so dragging it across and
          // a separate "select" button were both ceremony around a click that was already there.
          <div key={handle(it) + it.name} className="gear-litem"
            // Picking answers the question the pop-in was asking, so it closes — for a module slot exactly as
            // for a turret one, because both render this same list.
            onClick={() => { if (selSlot) { setSlotItem(selSlot, it); setSelSlot(null); } }}
            /* enter/leave only — ItemTip follows the cursor itself (no re-render per move) */
            onMouseEnter={(e) => setHover({ it, x: e.clientX, y: e.clientY, vs: curOf(selSlot) })}
            onMouseLeave={() => setHover(null)}>
            <span className="li-icon" style={{ backgroundImage: `url("${itemIcon(conn, it) ?? ""}")` }} />
            <span className="li-name" style={{ color: RARITY_COLOR[it.rarity] ?? "#cfcfcf" }}>{it.name}</span>
            {spokenFor.has(handle(it)) && (
              <span className="li-elsewhere" title={`Already proposed for ${spokenFor.get(handle(it))}. Picking it here moves it — there is only one of it.`}>
                in {spokenFor.get(handle(it))}
              </span>
            )}
            <span className="li-slots" title={`${it.aspects.length} of ${it.aspectSlots ?? 0} aspect slots filled`}>
              <AspectMarks conn={conn} aspects={it.aspects} slots={it.aspectSlots} size={13} />
            </span>
            <span className="li-main">+{num(power(it))}</span>
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
            <span className="li-lvl dim">Lv {it.level}</span>
          </div>
        ))}
      </div>
    </div>
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
      <div key={key} className={`gear-panel${selSlot === key ? " sel" : ""}`}
        onClick={() => setSelSlot(selSlot === key ? null : key)}   // click again to close the pop-in
        onMouseEnter={() => setHoverSlot(hp.index)} onMouseLeave={() => setHoverSlot((x) => (x === hp.index ? null : x))}
>
        <div className="gear-panel-head">Slot {hp.index + 1} <span className="dim">· {hp.size}</span>
          {pinned.has(key) && (
            <button className="slot-pin" title="You chose this slot yourself, so suggestions skip it. Click to release it."
              onClick={(e) => { e.stopPropagation(); unpin(key); }}>📌 pinned</button>
          )}
          {/* Lock the slot to what is FITTED. Not every hull deserves good gear — a size-1 ship that
              rides in a carrier gets a cheap module on purpose, and an optimizer that offers to upgrade it
              forever is noise. Distinct from the pin, which fixes a slot to an item you PICKED. */}
          <button className={`slot-lock${keep.has(key) ? " on" : ""}`}
            title={keep.has(key)
              ? "Locked to the fitted item — suggestions skip this slot. Click to release."
              : "Keep what is fitted here and stop suggesting for this slot (remembered for this ship)"}
            onClick={(e) => { e.stopPropagation(); toggleKeep(key); }}>{keep.has(key) ? "🔒" : "🔓"}</button>
          <button className="slot-sug" title="suggest best for this slot" onClick={(e) => { e.stopPropagation(); suggestSlot(key); }}>⚡</button></div>
        <div className="gear-swap">
          <Vig it={cur ?? null} label="current" conn={conn} onHover={setHover} />
          <span className="gear-arrow">
            →
            {slotGain.has(key) && (
              <span className={`gear-gain${(slotGain.get(key) as number) >= 0 ? " up" : " down"}`}
                title="Change in the whole battery's estimated DPS if this swap is applied — pooled stats and the reactor bracket included, so it is not the difference between the two cards' numbers.">
                {(slotGain.get(key) as number) >= 0 ? "+" : ""}{((slotGain.get(key) as number) * 100).toFixed(1)}%
              </span>
            )}
          </span>
          <NewVig it={nu} onClear={() => setSlotItem(key, null)} onHover={(h) => setHover(h && { ...h, vs: cur ?? null })} conn={conn}
            verdict={verdictText(verdicts.get(key))} same={!!nu && sameFit(cur ?? null, nu)} />
        </div>
        <FilterSelect
          value={f.mode === "all" ? "" : `${f.mode}:${f.value}`}
          groups={filterGroups()}
          onChange={(v) => { const [m, ...r] = v.split(":"); setFilters((s) => ({ ...s, [hp.index]: v ? { mode: m as Filter["mode"], value: r.join(":") } : { mode: "all" } })); setSelSlot(key); }} />
        {selSlot === key && candidateList()}
      </div>
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
      <PlanNotice regresses={builder.planRegresses} />
      {showCats && <CategoryEditor combatTypes={combatTypes} cats={cats} setCats={setCats} />}

      <div className="gear-ship">
        <div className="gear-ship-wrap">
          <img className="gear-img" src={api.shipImageUrl(conn, layout.shipGuid, layout.name) ?? ""} alt={layout.name} />
          {hps.map((h) => {
            const on = hoverSlot === h.index || selSlot === `t:${h.index}`;
            return <span key={h.index} className={`gear-mount${on ? " hot" : ""}`} style={{ left: `${h.u * 100}%`, top: `${h.v * 100}%` }} title={`#${h.index} ${h.size}`}><span className="gear-mount-dot" /></span>;
          })}
        </div>
        <GearTotals pools={builder.pools} reactor={reactor} ranking={ranking} vitals={vitals} layerNote={builder.layerNote}
          curTurrets={hps.map((h) => h.equipped).filter((x): x is Item => !!x)}
          nextTurrets={hps.map((h) => assign[`t:${h.index}`] ?? h.equipped).filter((x): x is Item => !!x)}
          curOther={mslots.map((m) => m.equipped).filter((x): x is Item => !!x)}
          nextOther={mslots.map((m) => assign[`m:${m.slot}`] ?? m.equipped).filter((x): x is Item => !!x)} />
      </div>

      <div className="gear-main">
        <div className="gear-slots">
          <div className="gear-mod-head">
            <div className="panel-title">Hardpoints <span className="dim">— current → new · click a slot, then pick an item</span></div>
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
            {/* Which question the ranking answers. "Raw" is the game's own headline number, already a
                per-second figure; "calculated" adds what the ITEM's own rolls do to it (speed, crit, damage,
                aspects) and is an estimate — so it is offered, not imposed. */}
            <button
              className={`asp-chip${ranking === "expanded" ? " on" : ""}`}
              title={ranking === "expanded"
                ? "Expanded: estimated DPS contribution — headline power adjusted for this item's own fire-rate, crit, damage and aspect rolls, valued against your ship's crit setup."
                : "Simple: the game's headline main stat only"}
              onClick={() => setRanking(ranking === "expanded" ? "simple" : "expanded")}
            >{ranking === "expanded" ? "expanded" : "simple"}</button>
            <button className="undo-suggest" onClick={suggestTurrets}>Suggest guns</button>
          </div>
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
              <div className="panel-title">Modules <span className="dim">— internal · current → new</span></div>
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
                      {pinned.has(key) && (
                        <button className="slot-pin" title="You chose this slot yourself, so suggestions skip it. Click to release it."
                          onClick={(e) => { e.stopPropagation(); unpin(key); }}>📌 pinned</button>
                      )}
                      {/* Lock the slot to what is FITTED. Not every hull deserves good gear — a size-1 ship that
                          rides in a carrier gets a cheap module on purpose, and an optimizer that offers to upgrade it
                          forever is noise. Distinct from the pin, which fixes a slot to an item you PICKED. */}
                      <button className={`slot-lock${keep.has(key) ? " on" : ""}`}
                        title={keep.has(key)
                          ? "Locked to the fitted item — suggestions skip this slot. Click to release."
                          : "Keep what is fitted here and stop suggesting for this slot (remembered for this ship)"}
                        onClick={(e) => { e.stopPropagation(); toggleKeep(key); }}>{keep.has(key) ? "🔒" : "🔓"}</button>
                      <button className="slot-sug" title="suggest best for this slot" onClick={(e) => { e.stopPropagation(); suggestSlot(key); }}>⚡</button></div>
                    <div className="gear-swap">
                      <Vig it={m.equipped} label="current" conn={conn} onHover={setHover} />
                      <span className="gear-arrow">→</span>
                      <NewVig it={nu} onClear={() => setSlotItem(key, null)} onHover={(h) => setHover(h && { ...h, vs: m.equipped })} conn={conn}
                        same={!!nu && sameFit(m.equipped, nu)} />
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

// Searchable combobox replacing the native <select> for the per-slot filter (grouped + type-to-filter).
interface FGroup { label: string; opts: { v: string; label: string }[] }
function FilterSelect({ value, groups, onChange, placeholder, className }: { value: string; groups: FGroup[]; onChange: (v: string) => void; placeholder?: string; className?: string }) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const cur = groups.flatMap((g) => g.opts).find((o) => o.v === value);
  // `placeholder` marks an action-style select (e.g. "Set all to…") whose value stays "" after each
  // pick — show the placeholder instead of the "All compatible" resting label.
  const label = value === "" ? (placeholder ?? "All compatible") : cur?.label ?? value;
  const ql = q.trim().toLowerCase();
  const pick = (v: string) => { onChange(v); setOpen(false); setQ(""); };
  return (
    <div className={`fsel${className ? ` ${className}` : ""}`} onClick={(e) => e.stopPropagation()}>
      <button className="fsel-btn" onClick={() => setOpen((o) => !o)}>{label}<span className="dim"> ▾</span></button>
      {open && (
        <>
          <div className="fsel-back" onClick={() => setOpen(false)} />
          <div className="fsel-pop">
            <input autoFocus className="fsel-search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="search…" />
            <div className="fsel-opts">
              {"all compatible".includes(ql) && <div className={`fsel-opt${value === "" ? " on" : ""}`} onClick={() => pick("")}>All compatible</div>}
              {groups.map((g) => {
                const opts = g.opts.filter((o) => o.label.toLowerCase().includes(ql));
                if (!opts.length) return null;
                return <div key={g.label}><div className="fsel-grp">{g.label}</div>{opts.map((o) => <div key={o.v} className={`fsel-opt${value === o.v ? " on" : ""}`} onClick={() => pick(o.v)}>{o.label}</div>)}</div>;
              })}
            </div>
          </div>
        </>
      )}
    </div>
  );
}

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

function VigIcon({ it, conn }: { it: Item; conn: Conn }) {
  const src = itemIcon(conn, it);
  if (!src) return null;
  return <span className="gear-vig-icon" style={{ backgroundImage: `url("${src}")` }} />;
}

// current-side vignette; `it === null` = empty, `undefined` = show name/sub props
function Vig({ it, label, conn, onHover }: { it: Item | null; label: string; conn: Conn; onHover?: (h: { it: Item; x: number; y: number } | null) => void }) {
  if (!it) return <div className="gear-vig"><div className="gear-vig-tag">{label}</div><div className="gear-vig-name dim">empty</div></div>;
  return (
    <div className="gear-vig" onMouseEnter={(e) => onHover?.({ it, x: e.clientX, y: e.clientY })} onMouseLeave={() => onHover?.(null)}>
      <div className="gear-vig-tag">{label}</div>
      <div className="gear-vig-body">
        <VigIcon it={it} conn={conn} />
        <div className="gear-vig-text">
          <div className="gear-vig-name" style={{ color: RARITY_COLOR[it.rarity] ?? "#cfcfcf" }}>{it.name}</div>
          <div className="gear-vig-sub">{vigSub(it)} · +{num(power(it))}</div>
        </div>
        <span className="gear-vig-asps">
          <AspectMarks conn={conn} aspects={it.aspects} slots={it.aspectSlots} size={18} />
        </span>
      </div>
    </div>
  );
}
function NewVig({ it, onClear, onHover, dimmed, conn, verdict, same }: { it: Item | null; onClear?: () => void; onHover: (h: { it: Item; x: number; y: number } | null) => void; dimmed?: boolean; conn: Conn; verdict?: { text: string; why: string } | null; same?: boolean }) {
  return (
    <div className={`gear-vig${it ? " best" : ""}${dimmed ? " dim" : ""}`}>
      <div className="gear-vig-tag">new{it && onClear && <button className="vig-x" onClick={(e) => { e.stopPropagation(); onClear(); }} title="leave alone">×</button>}</div>
      {it ? (
        <div className="gear-vig-body" onMouseEnter={(e) => onHover({ it, x: e.clientX, y: e.clientY })} onMouseLeave={() => onHover(null)}>
          <VigIcon it={it} conn={conn} />
          <div className="gear-vig-text">
            <div className="gear-vig-name" style={{ color: RARITY_COLOR[it.rarity] ?? "#cfcfcf" }}>{it.name}</div>
            <div className="gear-vig-sub">{vigSub(it)} · +{num(power(it))}</div>
          </div>
          <span className="gear-vig-asps">
            <AspectMarks conn={conn} aspects={it.aspects} slots={it.aspectSlots} size={18} />
          </span>
          {/* An equivalent item: `changes` drops it (sameFit), so it is never counted or applied. Without saying so
              the slot shows a pending swap that nothing else in the app agrees exists. */}
          {same && <span className="gear-vig-same" title="Identical fit to what is already equipped, so applying it would do nothing">changes nothing</span>}
        </div>
      ) : verdict ? (
        <div className="gear-vig-verdict" title={verdict.why}>
          {verdict.text}
          <span className="gear-vig-why">{verdict.why}</span>
        </div>
      ) : <div className="gear-vig-name dim">keep current</div>}
    </div>
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
