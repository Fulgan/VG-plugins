import { useEffect, useMemo, useState } from "react";
import ApplyBar, { ApplyMsg } from "./ApplyBar";
import type { ApplyApi } from "./useApply";
import {
  ANY_TYPE, boosterId, boosterPinKey, boosterScore, boosterType, boosterTypeColor, boosterTypes, boosterValue,
  EMPTY_PIN,
  defaultSlotTypes, isBooster, optimizeBoosters, resonancePct, unlockBonusText,
  type BoosterCtx, type BoosterPick, type ResonanceOrder,
} from "./booster";
import { defaultProfileForShip } from "./activityPresets";
// What the hull can actually use, derived from the fit — one owner, shared with the gear tab and the rail.
import { shipFit } from "./itemKind";
import { DEFAULT_SCOPE, isScope, SCOPE_LABEL, type Scope } from "./scope";
import { rankByValue, type StatMarginal } from "./statMarginals";
import { load, save } from "./storage";
import type { Inventories, Item, Loadout, Resonance } from "./types";
import { itemIcon, type Conn } from "./api";
import { RARITY_COLOR, fmt } from "./format";
import { ItemTip } from "./ItemCard";
import SlotPickList from "./SlotPickList";
import SlotCard, { Vig, NewVig, FilterSelect, SlotLock } from "./SlotCard";
import { useEscape } from "./Modal";
import "./officers.css";

const locLabel = (l?: string) => (l === "equipped" ? "Ship" : l === "cargo" ? "Inventory" : l === "armory" ? "Armory" : l ?? "");
const progText = (r: Resonance) => (r.unlocked ? "Resonance unlocked" : `${Math.round(r.progress).toLocaleString()} / ${Math.round(r.threshold).toLocaleString()} ${r.unit}`);

// Shared booster state (slot types + force + the optimized picks), lifted into App so both the Boosters
// tab (display) and the Summary tab (apply) work off one result.
// How the optimizer is being asked to read resonance, per ship. Persisted like every other preference ∴ it
// follows the playthrough rather than the browser.
const VIEW_KEY = "shipoptimizer.boosterView";
// `order` is the player's resonance preference, best first, PER SHIP AND PER BOOSTER TYPE — the same argument
// the blocklist makes for the ship (a Reload Speed bonus is worth chasing on a gunship and pointless on a
// hauler), carried one level further because the bonus pools overlap: Drone Power rolls on a Combat, Drone,
// Mining or Salvage booster, and ranking it once would answer for all four.
interface BoosterView {
  scope: Scope;
  blacklist: Record<string, string[]>;
  order: Record<string, ResonanceOrder>;
  /** Slots the player answered: slot index to pin key. Absorbed the old `locked` set, which was only ever a pin
   *  to the booster already fitted. `locked` is still read once, to carry old saves across. */
  pins: Record<string, Record<string, string>>;
  locked?: Record<string, number[]>;
  /** What each slot is FOR, per ship. A CHOICE, so it outlives the session like every other preference here:
   *  it was being re-derived from whatever happened to be fitted, so saying "this slot is for Armor HP" survived
   *  only until the next reload, and a slot the player had retyped silently went back to describing its cargo. */
  slotTypes: Record<string, (string | null)[]>;
}
// A stored order is a bare array where it was written before the preference was asked per type. It becomes the
// list every type falls back to, which is what that answer meant when it was given: one statement covering the
// whole ship. Spreading it across the individual types instead would need the pool (not loaded here) and a
// fixed type→bonus table to filter it by — a table that goes stale the first time the game adds a bonus.
export const migrateOrder = (raw: Record<string, ResonanceOrder | string[]> | undefined): Record<string, ResonanceOrder> => {
  const out: Record<string, ResonanceOrder> = {};
  for (const [guid, v] of Object.entries(raw ?? {})) out[guid] = Array.isArray(v) ? { [ANY_TYPE]: v } : v;
  return out;
};
const loadView = (): BoosterView => {
  const v = load<Partial<BoosterView>>(VIEW_KEY, {});
  return {
    scope: isScope(v.scope) ? v.scope : DEFAULT_SCOPE,
    blacklist: v.blacklist ?? {},
    order: migrateOrder(v.order as Record<string, ResonanceOrder | string[]> | undefined),
    pins: v.pins ?? {},
    locked: v.locked,
    slotTypes: v.slotTypes ?? {},
  };
};

export interface BoosterBuilder {
  loadout: Loadout | null;
  slotCount: number;
  equippedBySlot: (Item | null)[];
  pool: Item[];
  invBoosters: Item[];
  types: string[];
  slotTypes: (string | null)[];
  setType: (i: number, t: string) => void;
  setSlotTypes: (types: (string | null)[]) => void; // replace all slot types (for restoring a saved loadout)
  forced: Set<string>;
  toggleForce: (id: string) => void;
  picks: BoosterPick[];
  assigned: Set<string>;
  unplaceable: Set<string>;
  totals: [string, number][];
  /** How resonance is being priced, and the switch for it. */
  scope: Scope;
  setScope: (s: Scope) => void;
  /** Bonus stats the player has told the optimizer not to chase on THIS ship. */
  blacklist: Set<string>;
  toggleBlacklist: (stat: string) => void;
  /** Resonance bonus stats in the player's own order, best first, per booster type. Read BEFORE the score. */
  resOrder: ResonanceOrder;
  setTypeOrder: (type: string, next: string[]) => void;
  /** Slots the player answered rather than the optimizer. Same map as `pins`. */
  locked: Map<number, string>;
  /** Answer a slot with whatever is fitted, or hand it back when it is already answered. */
  toggleLock: (slot: number) => void;
  /** A booster the player chose for a specific slot, by slot index. In memory: a booster id carries a store
   *  slot, and a restock refills it with different goods. */
  pins: Map<number, string>;
  pinSlot: (slot: number, it: Item | null) => void;
  /** What the ranking used, for the row that explains a pick. */
  ctx: BoosterCtx;
  changed: number;
  unfilled: number;
  applyPayload: { kind: string; slot: number; store?: string; key: number | null; name: string; level: number }[];
}

export function useBoosterBuilder(loadout: Loadout | null, inv: Inventories | null): BoosterBuilder {
  const shipGuid = loadout?.shipGuid ?? "";
  const role = loadout?.role ?? null;
  const slotCount = loadout?.boosterSlots ?? loadout?.boosters?.length ?? 0;

  const invBoosters = useMemo(
    () => (inv?.stores ?? []).flatMap((st) => st.items.filter(isBooster).map((it) => ({ ...it, location: st.id }))),
    [inv],
  );
  // `slotKey` lets an equipped booster's icon resolve: "equipped" is a marker, not a real store.
  const equipped = useMemo(() => (loadout?.boosters ?? []).map((b) => ({ ...b, location: "equipped", slotKey: `b:${b.slot ?? 0}` })), [loadout]);
  const equippedBySlot = useMemo(
    () => Array.from({ length: slotCount }, (_, i) => equipped.find((b) => b.slot === i) ?? null),
    [equipped, slotCount],
  );
  const pool = useMemo(() => [...equipped, ...invBoosters], [equipped, invBoosters]);
  const types = useMemo(() => boosterTypes(pool), [pool]);

  const [slotTypes, setSlotTypesLocal] = useState<(string | null)[]>([]);
  useEffect(() => {
    // A SAVED ANSWER BEATS A DERIVED ONE. The default reads the slot's own contents, which is the right FIRST
    // answer and the wrong one to keep re-applying: it overwrites the player's choice every time the tab
    // remounts. A stored list is only trusted at the current slot count, since a different hull of the class
    // reads a different number of bays and a positional list does not survive that.
    const saved = loadView().slotTypes[shipGuid];
    setSlotTypesLocal(saved && saved.length === slotCount
      ? saved
      : defaultSlotTypes(equippedBySlot, slotCount, role, pool));
  }, [shipGuid, slotCount]); // eslint-disable-line react-hooks/exhaustive-deps

  const [forced, setForced] = useState<Set<string>>(new Set());
  const toggleForce = (id: string) => setForced((s) => { const n = new Set(s); n.has(id) ? n.delete(id) : n.add(id); return n; });

  const [view, setView] = useState<BoosterView>(loadView);
  const writeView = (next: BoosterView) => { setView(next); save(VIEW_KEY, next); };
  // Both writers go through one place, so a slot type set from the foot select and one restored with a loadout
  // are stored the same way and neither can forget to persist.
  const setSlotTypes = (next: (string | null)[]) => {
    setSlotTypesLocal(next);
    writeView({ ...view, slotTypes: { ...view.slotTypes, [shipGuid]: next } });
  };
  const setType = (i: number, t: string) => setSlotTypes(slotTypes.map((x, j) => (j === i ? t : x)));
  const setScope = (scope: Scope) => writeView({ ...view, scope });
  const blacklist = useMemo(() => new Set(view.blacklist[shipGuid] ?? []), [view, shipGuid]);
  const toggleBlacklist = (stat: string) => {
    const cur = new Set(view.blacklist[shipGuid] ?? []);
    cur.has(stat) ? cur.delete(stat) : cur.add(stat);
    writeView({ ...view, blacklist: { ...view.blacklist, [shipGuid]: [...cur] } });
  };
  const resOrder = useMemo<ResonanceOrder>(() => view.order[shipGuid] ?? {}, [view, shipGuid]);
  // An emptied list is KEPT as an empty list rather than deleted: for a type that would otherwise fall back to
  // `ANY_TYPE`, "I have no preference here" and "I never said" are different answers, and dropping the key
  // would silently restore the fallback the player just cleared.
  const setTypeOrder = (type: string, next: string[]) =>
    writeView({ ...view, order: { ...view.order, [shipGuid]: { ...resOrder, [type]: next } } });
  // NO BAN LIST ON BOOSTERS. It was added without being asked for, and boosters are few enough per type that
  // "never offer me this one" is overhead rather than help: the slot has a handful of candidates and the
  // resonance order already says which the player wants. GEAR is where a ban earns its keep — a large armory and
  // many candidates per hardpoint — so the plumbing it needs is left standing (`optimizeBoosters`' own `refused`
  // parameter and its tests) rather than deleted and rewritten there.
  //
  // ⚠ THE PERSISTED `refused` KEY IS NO LONGER READ. An existing saved blob may still carry one; it is ignored
  // rather than migrated, so nothing a player banned before keeps filtering a pool they can no longer see.
  // ONE ANSWER PER SLOT. A slot belongs to the optimizer or to the player, and when it is the player's it names
  // a booster. "Lock" used to be a second control for the same idea: locking a slot was pinning it to the
  // booster already fitted, and nothing on screen distinguished the two, so the tab carried a lock, a pin, a
  // lightning bolt and a cross to express what is really one switch.
  //
  // Pins persist now, which the lock always did. The old reason not to (a `boosterId` carries a store slot, and
  // a restock puts something else there) died with the key: `boosterPinKey` names what the player CHOSE (name,
  // level, rarity), so it survives a restock, an apply, and a reload.
  const pins = useMemo(() => {
    const saved = view.pins[shipGuid];
    if (saved) return new Map(Object.entries(saved).map(([k, v]) => [Number(k), v] as const));
    // Carried over from a save written when a lock was its own thing: a locked slot was "keep what is fitted",
    // which is a pin to that booster, or to emptiness when the slot was empty.
    const old = view.locked?.[shipGuid];
    if (!old?.length) return new Map<number, string>();
    return new Map(old.map((i) => {
      const eq = equippedBySlot[i];
      return [i, eq ? boosterPinKey(eq) : EMPTY_PIN] as const;
    }));
  }, [view, shipGuid, equippedBySlot]);

  const writePins = (next: Map<number, string>) =>
    writeView({ ...view, pins: { ...view.pins, [shipGuid]: Object.fromEntries(next) } });

  // The whole of "this slot is mine" and "this slot is yours", in one toggle: it answers the slot with whatever
  // is fitted, which is what the lock did, and the picker answers it with a booster by name.
  const toggleLock = (slot: number) => {
    const n = new Map(pins);
    if (n.has(slot)) n.delete(slot);
    else {
      const eq = equippedBySlot[slot];
      n.set(slot, eq ? boosterPinKey(eq) : EMPTY_PIN);
    }
    writePins(n);
  };
  // PINNING A BOOSTER SAYS WHAT THE SLOT IS FOR. The pin used to record the item alone, leaving the slot's own
  // TYPE at whatever it was: a slot headed `COMBAT POWER`, with its foot select on Combat Power, proposing a
  // Drone R-Booster. The card contradicted itself, and the stale type went on driving what the picker offered
  // for a slot the player had already decided differently about.
  const pinSlot = (slot: number, it: Item | null) => {
    const n = new Map(pins);
    if (it) n.set(slot, boosterPinKey(it)); else n.delete(slot);
    writePins(n);
    // THE SLOT TYPE IS THE PLAYER'S SETTING, and picking a booster does not rewrite it. It used to, so that a
    // slot could not be headed `COMBAT POWER` while holding a Drone booster; but the type is also a saved
    // choice about what the slot is FOR, and silently changing it discards that. A slot whose type has nothing
    // to offer says so on the card instead.
  };

  // What the ship is FOR, read off the SHIP and not off its role label: `shipFit` (the owner the gear tab and the
  // opportunity rail already use) takes the fitted turrets and the module slots, so a Combat hull carrying a
  // mining laser counts as mining and a hull with no drone bay stops crediting Drone Power. Judged by role alone,
  // this refused an `ore` resonance its potential credit on exactly that ship and called its Mining Power bonus
  // inert — both wrong about the ship in front of the player.
  const ctx = useMemo<BoosterCtx>(() => ({
    scope: view.scope,
    profile: defaultProfileForShip(role, null),
    // A module slot the bridge could not name is skipped rather than guessed at: `shipFit` only asks whether one
    // of them is a drone bay, and an unnamed slot is no evidence either way.
    fit: shipFit(role,
      (loadout?.modules ?? []).flatMap((m) => (m.slot ? [{ slot: m.slot }] : [])),
      loadout?.hardpoints ?? []),
    blacklist,
    order: resOrder,
  }), [view.scope, role, loadout, blacklist, resOrder]);

  const { picks, unplaceableForced } = useMemo(
    () => optimizeBoosters(pool, slotTypes, forced, ctx, undefined, pins), [pool, slotTypes, forced, ctx, pins],
  );
  const assigned = useMemo(() => new Set(picks.filter((p) => p.chosen).map((p) => boosterId(p.chosen!))), [picks]);
  const unplaceable = useMemo(() => new Set(unplaceableForced.map(boosterId)), [unplaceableForced]);
  const totals = useMemo(() => {
    const m = new Map<string, number>();
    for (const p of picks) if (p.chosen) m.set(p.type!, (m.get(p.type!) ?? 0) + p.value);
    return [...m.entries()];
  }, [picks]);
  // Real change = a chosen booster that isn't already equipped anywhere on the ship. A booster that
  // stays on the ship but moves slot is NOT a change (slot order is irrelevant for stacking).
  const equippedIds = new Set(equippedBySlot.filter(Boolean).map((b) => boosterId(b as Item)));
  const changed = picks.filter((p) => p.chosen && !equippedIds.has(boosterId(p.chosen))).length;
  const unfilled = picks.filter((p) => p.type && !p.chosen).length;
  const applyPayload = picks
    .filter((p) => p.chosen && p.chosen !== equippedBySlot[p.slot] && p.chosen.location !== "equipped" && p.chosen.key != null)
    .map((p) => ({ kind: "Booster", slot: p.slot, store: p.chosen!.location, key: p.chosen!.key, name: p.chosen!.name, level: p.chosen!.level }));

  return { locked: pins, loadout, slotCount, equippedBySlot, pool, invBoosters, types, slotTypes, setType, setSlotTypes, forced, toggleForce, picks, assigned, unplaceable, totals, scope: view.scope, setScope, blacklist, toggleBlacklist, resOrder, setTypeOrder, toggleLock, pins, pinSlot, ctx, changed, unfilled, applyPayload };
}

export default function BoostersTab({ builder, docked, conn, goSummary, apply, marginals }: { builder: BoosterBuilder; docked: boolean; conn: Conn; goSummary: () => void; apply?: ApplyApi; marginals?: StatMarginal[] }) {
  const { loadout, slotCount, equippedBySlot, pool, types, slotTypes, setType, forced, toggleForce, picks, assigned, unplaceable, totals, scope, setScope, blacklist, toggleBlacklist, resOrder, setTypeOrder, toggleLock, pins, pinSlot, ctx, changed, unfilled } = builder;
  // The cursor-following card, the same one the gear and inventory tabs use (`ItemTip`, one owner). The booster
  // cards showed a name, a level and one number; everything else an item carries — its own stat lines, its
  // aspects, its resonance detail, what it would replace — was only visible by leaving this tab.
  const [hover, setHover] = useState<{ it: Item; vs: Item | null; x: number; y: number } | null>(null);
  const hoverProps = (it: Item | null, vs: Item | null = null) => (!it ? {} : {
    onMouseEnter: (e: React.MouseEvent) => setHover({ it, vs, x: e.clientX, y: e.clientY }),
    onMouseMove: (e: React.MouseEvent) => setHover((h) => (h && h.it === it ? { ...h, x: e.clientX, y: e.clientY } : h)),
    onMouseLeave: () => setHover((h) => (h && h.it === it ? null : h)),
  });

  // owned-list view state (local to the tab)
  const [fName, setFName] = useState("");
  const [fType, setFType] = useState("");
  const [fLoc, setFLoc] = useState("");
  const [fRes, setFRes] = useState("");
  const [sort, setSort] = useState<{ key: "value" | "level" | "name"; dir: 1 | -1 }>({ key: "value", dir: -1 });
  const owned = useMemo(() => {
    const r = pool.filter((b) =>
      (!fName || b.name.toLowerCase().includes(fName.toLowerCase())) &&
      (!fType || boosterType(b) === fType) &&
      (!fLoc || b.location === fLoc) &&
      (!fRes || (fRes === "unlocked" ? b.resonance?.unlocked : fRes === "locked" ? b.resonance && !b.resonance.unlocked : true)));
    const val = (b: Item) => (sort.key === "value" ? boosterValue(b) : sort.key === "level" ? b.level : b.name.toLowerCase());
    return [...r].sort((a, z) => { const x = val(a), y = val(z); return (x < y ? -1 : x > y ? 1 : 0) * sort.dir; });
  }, [pool, fName, fType, fLoc, fRes, sort]);
  const clickSort = (key: "value" | "level" | "name") => setSort((s) => (s.key === key ? { key, dir: s.dir === -1 ? 1 : -1 } : { key, dir: -1 }));
  // Resonance is BETA-ONLY in the game (`ResonantBooster` is absent from the release build, so every item arrives
  // with `resonance: null`). Nothing about it is drawn unless something the player owns actually has one —
  // a control for a feature the build does not have is worse than a missing one: it invites a setting that can
  // never do anything.
  const hasResonance = useMemo(() => pool.some((b) => !!b.resonance), [pool]);
  // Bonus stats present in the pool, for the "block a bonus" picker — the vocabulary comes from what the player
  // actually owns, ⊥ a hardcoded list of stats that would go stale with the game.
  const resStats = useMemo(
    () => [...new Set(pool.map((b) => b.resonance?.bonusStat).filter((x): x is string => !!x))].sort(),
    [pool],
  );
  // The same vocabulary split BY BOOSTER TYPE, which is what a per-type ranking may offer: a type can only be
  // ranked on bonuses it can actually roll, and the pools overlap rather than partition, so this cannot be
  // derived by dividing `resStats` up — a stat belongs to as many types as carry it.
  const resStatsByType = useMemo(() => {
    const m = new Map<string, Set<string>>();
    for (const b of pool) {
      const stat = b.resonance?.bonusStat;
      if (!stat) continue;
      const t = boosterType(b);
      if (!m.has(t)) m.set(t, new Set());
      m.get(t)!.add(stat);
    }
    return new Map([...m].map(([t, set]) => [t, [...set].sort()] as const));
  }, [pool]);
  // Types with a ranking to state, plus `ANY_TYPE` when an order predating the per-type question is still
  // standing — it acts on every type that has no list, so it is shown rather than left working invisibly.
  const orderTypes = useMemo(() => {
    const ts = [...resStatsByType.keys()].sort();
    return resOrder[ANY_TYPE] ? [ANY_TYPE, ...ts] : ts;
  }, [resStatsByType, resOrder]);
  const [blockPick, setBlockPick] = useState(false);
  const [orderPick, setOrderPick] = useState<string | null>(null);

  // WHAT EACH BONUS IS WORTH ON THIS SHIP. Computed from the damage model by the caller and passed in, so the tab
  // states a measurement rather than an opinion. Absent (no pool reading, a parked hull) ⇒ nothing is shown and the
  // ranking button does not appear: a silent guess is worse than a manual list.
  const worth = useMemo(() => new Map((marginals ?? []).map((m) => [m.stat, m])), [marginals]);

  const worthOf = (stat: string) => {
    const m = worth.get(stat);
    if (!m) return null;
    const pct = m.perPoint * 100;
    // A figure under a hundredth of a percent reads as `0.00%`, which looks like a measurement failure rather than
    // like a stat that does nothing. Said in words instead.
    return pct < 0.005 ? "nothing here" : `${pct.toFixed(2)}%${m.approximate ? "?" : ""}`;
  };

  const worthTitle = (stat: string) => {
    const m = worth.get(stat);
    if (!m) return undefined;
    const unit = m.unit === "point" ? "one point" : "1% of the pool";
    const head = `${(m.perPoint * 100).toFixed(3)}% DPS per ${unit}, on this ship's own guns`;
    return m.approximate
      ? `${head}. Indicative: the game reports crit chance as a product it will not factorise, so Precision's share of it cannot be separated exactly.`
      : head;
  };

  /** The bonuses in this type's vocabulary that the model can actually value. */
  const rankable = (type: string) => {
    const vocab = type === ANY_TYPE ? resStats : (resStatsByType.get(type) ?? []);
    return vocab.filter((s) => worth.has(s));
  };

  /**
   * This type's list, reordered by measured value.
   *
   * Bonuses the model cannot judge KEEP THEIR RELATIVE PLACES at the end rather than being dropped or interleaved:
   * `Hull HP` is not a damage stat, and sorting it against damage figures would state something the measurement does
   * not support. A bonus that is ranked but no longer in the vocabulary stays too — removing it is the player's call.
   */
  const byValue = (list: readonly string[]) => {
    const { ranked, unranked } = rankByValue([...list], marginals ?? []);
    return [...ranked, ...unranked];
  };
  const [pickFor, setPickFor] = useState<number | null>(null);
  const [pickQ, setPickQ] = useState("");
  const [resDrag, setResDrag] = useState<{ type: string; from: number; over: number } | null>(null);
  // Which sections stand open. `null` means nobody has touched them yet, and the default is what the ship's
  // slots are actually set to — the types a ranking would change an answer for today.
  const [openTypes, setOpenTypes] = useState<Set<string> | null>(null);
  const isOpen = (t: string) => (openTypes ? openTypes.has(t) : slotTypes.includes(t));
  const toggleOpen = (t: string) => setOpenTypes((cur) => {
    const n = new Set(cur ?? slotTypes.filter((x): x is string => !!x));
    n.has(t) ? n.delete(t) : n.add(t);
    return n;
  });
  // Escape closes the slot picker, as it does the gear tab's — it overlays the grid, so there has to be a way
  // out that is not "click the same button again".
  useEscape(() => { setPickFor(null); setPickQ(""); }, pickFor !== null);
  const arrow = (k: string) => (sort.key === k ? (sort.dir === -1 ? " ▼" : " ▲") : "");
  const anyFilter = !!(fName || fType || fLoc || fRes);

  // The booster card that used to live here is gone: the slot now renders `SlotCard` + `Vig`/`NewVig`, the
  // same components the gear tab draws, so there is one answer to "what does a slot look like".

  return (
    <div className="boosters">
      <div className="sum-head">
        <div className="panel-title">Booster optimizer <span className="dim">— {loadout?.name ?? "ship"} · {slotCount} slots</span></div>
        {/* Grouped in `.sum-actions` like every other tab head: `.sum-head` is `space-between`, so a third direct
            child gets spread into the middle of the bar instead of sitting with the other actions. */}
        <div className="sum-actions">
          {apply && <ApplyBar apply={apply} section="boosters" label="booster" />}
          <button className="apply" onClick={goSummary} title="Review & apply changes in the Summary tab">Go to Summary →</button>
        </div>
      </div>
      {apply && <ApplyMsg apply={apply} />}
      {/* CONTROLS, NOT PROSE. What each control does belongs in its own `title`, where it is available to whoever
          wants it and costs nothing to whoever does not — three paragraphs above a six-slot grid pushed the
          grid off the screen and were read once, on the first visit, by one person. */}
      <div className="btype-note">
        {hasResonance && <>
          {(["current", "potential"] as Scope[]).map((sc) => (
            <button key={sc} className={`seg ${scope === sc ? "on" : ""}`} onClick={() => setScope(sc)}
                    title="Price resonance as it stands now, or as it will be once flown">{SCOPE_LABEL[sc]}</button>
          ))}
        </>}
        <span className="up">{changed > 0 ? `${changed} slot${changed === 1 ? "" : "s"} would change` : "matches current"}</span>
      </div>
      {/* THE OFFICERS TAB'S LAYOUT: `opt-grid` is `340px minmax(0, 1fr)`, the ranking panel on the left and the
          thing being ranked on the right, collapsing to one column under 900px. The two tabs ask the same
          question — state an order, then look at what it produced — so they are read the same way round. */}
      <div className="opt-grid">
        <div className="panel bres-panel">
      {hasResonance && (
        // The BLOCKLIST, visible and reversible. The RES chip on a card blocks a bonus in one click, but a blocked
        // bonus then has no home: the player would have to find a booster carrying it to get it back. This is that
        // home — per ship, because a Reload Speed bonus is worth chasing on a gunship and pointless on a hauler.
        <div className="bblock">
          {[...blacklist].sort().map((stat) => (
            <span key={stat} className="sl-vchip">
              {stat}
              <button className="x" title="chase this bonus again on this ship"
                      onClick={() => toggleBlacklist(stat)}>×</button>
            </span>
          ))}
          <button className="mini" title="Bonuses this ship should not chase. The booster is still picked on its main stat."
                  onClick={() => setBlockPick(!blockPick)}>+ block a bonus…</button>
          {blockPick && (
            <div className="sl-vpop">
              {resStats.filter((x) => !blacklist.has(x)).map((stat) => (
                <button key={stat} className="mini" onClick={() => { toggleBlacklist(stat); setBlockPick(false); }}>
                  {stat}
                </button>
              ))}
              {resStats.every((x) => blacklist.has(x)) && <span className="dim">nothing left to block</span>}
            </div>
          )}
        </div>
      )}
      {hasResonance && (
        // THE ORDER, and it is read BEFORE the value — the player's own decision, so it is stated plainly here
        // rather than hidden in a tooltip. Beta-gated with everything else about resonance: `hasResonance` is
        // false on a release build, where no item carries one at all, and none of this is drawn.
        //
        // Per ship (like the blocklist), because what a hull is FOR decides which bonus is worth having, and
        // PER BOOSTER TYPE within that, because the pools overlap: a stat ranked once would answer for every
        // type that can roll it. Deliberately not seeded with a default: an order nobody chose would be this
        // app inventing the preference it exists to ask for.
        // THE OFFICER TAB'S PRIORITY LIST, class for class (`prio-list`, `prio-row`, the grip, the position, the
        // ▲▼× column — all defined once in `officers.css`). It is the same question about a different thing:
        // "rank these, best first, and read the ranking before anything else", so it reads the same way and a
        // player learns it once. Drag to reorder, exactly as there.
        <div className="bres-order">
          {orderTypes.map((type) => {
            const list = resOrder[type] ?? [];
            const vocab = type === ANY_TYPE ? resStats : (resStatsByType.get(type) ?? []);
            const open = isOpen(type);
            const write = (next: string[]) => setTypeOrder(type, next);
            return (
              <div key={type} className="bres-sect">
                {/* The count rides on the header because a collapsed section that says nothing about holding a
                    ranking reads as holding none, and the ranking is what decides the slot. */}
                <button className={`bres-head${open ? " open" : ""}`} onClick={() => toggleOpen(type)}
                        title={type === ANY_TYPE
                          ? "Ranked before this app asked per booster type. It applies to every type you have not ranked on its own."
                          : `How ${type} boosters are ranked. Only bonuses a ${type} booster can roll are offered here.`}>
                  <span className="bres-caret">{open ? "▼" : "▶"}</span>
                  <span className="bres-type">{type === ANY_TYPE ? "Every other type" : type}</span>
                  <span className="spacer" />
                  <span className="bres-count">{list.length}</span>
                </button>
                {open && (
                  <div className="prio-list">
                    {list.map((stat, i) => {
                      const dragHere = resDrag?.type === type;
                      const over = dragHere && resDrag.over === i && resDrag.from !== i;
                      const move = (d: number) => {
                        const n = [...list];
                        [n[i + d], n[i]] = [n[i], n[i + d]];
                        write(n);
                      };
                      // A RANK NOTHING CAN ROLL IS A LEFTOVER, ⊥ a wish. The add-picker offers this type's own
                      // vocabulary only, so a stat outside it got here by outliving the booster that carried it: the
                      // row is inert until such a booster is owned again. It is dimmed rather than badged, because
                      // a badge only restates the state while the row's own remove button is the answer to it.
                      // NAMED `prio-inert`, ⊥ `stale`: `.stale` is the app-wide STALE-DATA banner (amber on brown,
                      // `App.css`), so a row carrying that word inherited a warning colour it had no business wearing
                      // and every unrollable rank turned brown.
                      const inert = !vocab.includes(stat);
                      return (
                        <div key={stat}
                             className={`prio-row${inert ? " prio-inert" : ""}${over ? " over" : ""}${dragHere && resDrag.from === i ? " dragging" : ""}`}
                             draggable
                             onDragStart={() => setResDrag({ type, from: i, over: i })}
                             onDragOver={(e) => { e.preventDefault(); setResDrag((d) => (d && d.type === type ? { ...d, over: i } : d)); }}
                             onDrop={(e) => {
                               e.preventDefault();
                               // A row dropped into a DIFFERENT type's list is not a move: the two lists rank
                               // different vocabularies, and the dragged stat may not even be rollable here.
                               if (dragHere) {
                                 const n = [...list];
                                 n.splice(i, 0, ...n.splice(resDrag.from, 1));
                                 write(n);
                               }
                               setResDrag(null);
                             }}
                             onDragEnd={() => setResDrag(null)}>
                          <span className="grip" title="drag to reorder">⠿</span>
                          <span className="pos">{i + 1}</span>
                          <div className="prio-main">
                            <div className="prio-name-row">
                              <span className="prio-name"
                                    title={inert
                                      ? `${stat} — no ${type} booster you own carries this, so this rank does nothing until one does. Remove it with the x.`
                                      : stat}>{stat}</span>
                              {/* WHAT IT IS WORTH ON THIS SHIP, measured through the damage model. Shown beside the
                                  rank because the rank is the decision it informs: an ordering with the figures next
                                  to it can be checked, and one without has to be trusted. */}
                              {worthOf(stat) && (
                                <span className="prio-worth" title={worthTitle(stat)}>{worthOf(stat)}</span>
                              )}
                              <span className="spacer" />
                              {blacklist.has(stat) && (
                                <span className="prio-rank" title="Also blocked on this ship, which wins: the block is the narrower statement">blocked</span>
                              )}
                            </div>
                          </div>
                          <div className="prio-btns">
                            <button disabled={i === 0} onClick={() => move(-1)} title="up">▲</button>
                            <button disabled={i === list.length - 1} onClick={() => move(1)} title="down">▼</button>
                            <button className="rm" onClick={() => write(list.filter((s) => s !== stat))} title="remove">×</button>
                          </div>
                        </div>
                      );
                    })}
                    <div className="prio-add">
                      {/* ONE CLICK INSTEAD OF A HAND-SORTED LIST. The order comes from this ship's own measured
                          values, so it is not a wiki opinion: a bonus that does nothing for these guns sinks, and a
                          bonus this model cannot judge (Hull HP on a damage ranking) is LEFT WHERE IT IS rather than
                          buried, since "not a damage stat" is a different claim from "worth nothing". */}
                      {!!rankable(type).length && (
                        <button className="mini" title={`Order this list by what each bonus is worth on ${loadout?.name ?? "this ship"} right now, strongest first. Bonuses this model cannot value keep their places at the end.`}
                                onClick={() => write(byValue(list))}>rank by value</button>
                      )}
                      <button className="mini" title="Resonance bonuses for this type, best first. Read before the value."
                              onClick={() => setOrderPick(orderPick === type ? null : type)}>+ rank a bonus…</button>
                      {orderPick === type && (
                        <div className="sl-vpop">
                          {vocab.filter((x) => !list.includes(x)).map((stat) => (
                            <button key={stat} className="mini" onClick={() => { write([...list, stat]); setOrderPick(null); }}>
                              {stat}
                            </button>
                          ))}
                          {vocab.every((x) => list.includes(x)) && <span className="dim">every bonus this type rolls is ranked</span>}
                        </div>
                      )}
                    </div>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
      {!hasResonance && <p className="hint">No resonances on anything you own — nothing to rank.</p>}
        </div>

        <div className="bres-main">
      {/* A note, not a second warning — the app-level bar already says you are undocked. This adds only what is
          specific to boosters: the pool is narrower, and applying needs a station. */}
      {!docked && <p className="sum-note">Cargo only out here; applying needs a station.</p>}

      <div className="bslot-grid">
        {slotTypes.map((t, i) => {
          const eq = equippedBySlot[i], best = picks[i]?.chosen ?? null;
          const same = !!best && !!eq && boosterId(best) === boosterId(eq);
          // A SLOT TYPED FOR ONE THING AND HOLDING ANOTHER IS A STATE THE CARD HAS TO SAY OUT LOUD. It is
          // legitimate (asking for Armor HP in a slot that currently carries a Combat booster is how you
          // ask the optimizer to change it), but with nothing owned of the wanted type the slot falls
          // through to a bare `keep current`, which reads as the optimizer having no opinion rather than
          // as it having nothing to offer.
          const wantedMissing = !!t && !!eq && boosterType(eq) !== t && !best;
          // What a booster's vignette SAYS, where a turret's says its damage type and power: the stat it boosts,
          // its value, and where it lives. The frame around it is `SlotCard`'s — the same one the gear tab draws.
          const bSub = (b: Item) => `${boosterType(b)} · +${fmt(boosterValue(b))} · ${locLabel(b.location)}`;
          const bMark = (b: Item) => (b.resonance
            // A bare `RES` says only that the booster HAS a resonance, which the player can see from the fact
            // that the badge is there. What they need is whether it is paying yet, so it carries the figure.
            ? <span className={`bres mini-res${b.resonance.unlocked ? " done" : ""}`}
                    title={`${unlockBonusText(b.resonance)} · ${progText(b.resonance)}`}>
                {b.resonance.unlocked ? "RES ✓" : `RES ${resonancePct(b.resonance)}%`}
              </span>
            : null);
          return (
          <SlotCard key={i}
            className={pickFor === i ? "sel" : undefined}
            onClick={() => setPickFor(pickFor === i ? null : i)}   // click the card to open the picker, as a gear slot does
            title={`Slot ${i + 1}`}
            sub={t ?? "no type"}
            head={<>
              {wantedMissing && (
                <span className="slot-warn"
                      title={`Set to ${t}, but you own no ${t} booster. Change the type below, or leave it.`}>no {t}</span>
              )}
              <SlotLock locked={pins.has(i)} onToggle={() => toggleLock(i)} what={eq ? eq.name : "nothing"} />
              {picks[i]?.pinUnresolved && (
                <span className="slot-warn" title="You no longer own the booster this slot is pinned to">pin unmet</span>
              )}
            </>}
            current={<Vig it={eq} conn={conn}
                          sub={eq ? bSub(eq) : null} extra={eq ? bMark(eq) : null}
                          onHover={(h) => setHover(h ? { ...h, vs: null } : null)} />}
            next={<NewVig it={best} conn={conn} mine={pins.has(i)} unchanged={same}
                          onClear={pins.has(i) ? () => pinSlot(i, null) : undefined}
                          sub={best ? bSub(best) : null} extra={best ? bMark(best) : null}
                          onHover={(h) => setHover(h ? { ...h, vs: eq } : null)} />}
            // WHAT THIS SLOT IS FOR, in the gear tab's own selector at the foot of the card — the same control
            // in the same place, so changing a slot is one gesture across both tabs.
            foot={<FilterSelect
              value={t ?? ""}
              restingLabel="any type"
              groups={[{ label: "Booster type", opts: types.map((ty) => ({ v: ty, label: ty })) }]}
              onChange={(v) => { setType(i, v); setPickFor(i); }} />}
          >
              {pickFor === i && (() => {
                // THE APP'S ONE PICKER (`SlotPickList`), the same component the gear tab renders — not the same
                // look reproduced. Only the cells differ: a booster row says which resonance it carries where a
                // turret row says its aspects and relative value.
                const q = pickQ.trim().toLowerCase();
                const rows = [...pool]
                  .filter((b) => !q || b.name.toLowerCase().includes(q) || boosterType(b).toLowerCase().includes(q)
                    || (b.resonance?.bonusStat ?? "").toLowerCase().includes(q))
                  .sort((a, z) => boosterScore(z, ctx) - boosterScore(a, ctx));
                return (
                  <SlotPickList
                    title={`Slot #${i + 1}`}
                    items={rows}
                    query={pickQ}
                    setQuery={setPickQ}
                    placeholder="search name / type / resonance…"
                    onPick={(b) => { pinSlot(i, b); setPickFor(null); }}
                    onClose={() => setPickFor(null)}
                    keyOf={(b) => boosterId(b)}
                    iconOf={(b) => itemIcon(conn, b)}
                    nameOf={(b) => b.name}
                    rarityOf={(b) => b.rarity}
                    trailOf={(b) => `Lv ${b.level}`}
                    emptyText={docked ? "Nothing owned matches." : "Dock to read the armory."}
                    hoverProps={(b) => hoverProps(b, equippedBySlot[i])}
                    // Only one of each physical booster exists, so one already placed is SAID to be spoken for
                    // rather than hidden — picking it here moves it, exactly as a turret does.
                    spokenFor={(b) => (assigned.has(boosterId(b)) && pins.get(i) !== boosterPinKey(b) ? "another slot" : null)}
                    mainCell={(b) => `+${fmt(boosterValue(b))}`}
                    cells={(b) => b.resonance?.bonusStat
                      ? <span className="li-asp" title={unlockBonusText(b.resonance)}>{b.resonance.bonusStat}</span>
                      : null}
                    leadRow={pins.has(i) ? (
                      <div className="gear-litem" onClick={() => { pinSlot(i, null); setPickFor(null); }}>
                        <span className="li-name dim">let the optimizer decide</span>
                      </div>
                    ) : null}
                  />
                );
              })()}
          </SlotCard>
          );
        })}
      </div>

      <div className="btotals">
        <span className="dim">Optimized totals</span>
        {totals.map(([name, v]) => (<span key={name} className="btotal">{name} <b>+{fmt(v)}</b></span>))}
        {!totals.length && <span className="dim">— pick types above</span>}
        <span className="spacer" />
        {unfilled > 0 && <span className="bmiss">{unfilled} slot{unfilled === 1 ? "" : "s"} unfilled — no owned booster of that type</span>}
      </div>

      <div className="panel bowned">
        <div className="bowned-head">
          <div className="panel-title">Owned boosters <span className="dim">— {owned.length} of {pool.length}</span></div>
          {anyFilter && <button className="undo-suggest" onClick={() => { setFName(""); setFType(""); setFLoc(""); setFRes(""); }}>Clear filters</button>}
        </div>
        <div className="brow bhdr">
          <span style={{ width: 26, flex: "0 0 auto" }} />
          <button className={`bsort${sort.key === "name" ? " on" : ""}`} style={{ width: 216 }} onClick={() => clickSort("name")}>Booster{arrow("name")}</button>
          <span className="bh" style={{ width: 120 }}>Type</span>
          <button className={`bsort${sort.key === "value" ? " on" : ""}`} style={{ width: 80, textAlign: "right" }} onClick={() => clickSort("value")}>Value{arrow("value")}</button>
          <button className={`bsort${sort.key === "level" ? " on" : ""}`} style={{ width: 52 }} onClick={() => clickSort("level")}>Lvl{arrow("level")}</button>
          <span className="bh" style={{ width: 58 }}>Loc</span>
          <span className="bh" style={{ width: 150 }}>Unlock bonus</span>
          <span className="bh" style={{ width: 120 }}>Resonance</span>
          <span style={{ flex: 1 }} />
        </div>
        <div className="brow bfrow">
          <span style={{ width: 26, flex: "0 0 auto" }} />
          <span style={{ width: 216, flex: "0 0 auto" }}><input className="bfield" value={fName} onChange={(e) => setFName(e.target.value)} placeholder="filter name…" /></span>
          <span style={{ width: 120, flex: "0 0 auto" }}><select className="bfield" value={fType} onChange={(e) => setFType(e.target.value)}><option value="">All types</option>{types.map((ty) => <option key={ty} value={ty}>{ty}</option>)}</select></span>
          <span style={{ width: 80, flex: "0 0 auto" }} />
          <span style={{ width: 52, flex: "0 0 auto" }} />
          <span style={{ width: 58, flex: "0 0 auto" }}><select className="bfield" value={fLoc} onChange={(e) => setFLoc(e.target.value)}><option value="">All</option><option value="armory">Armory</option><option value="cargo">Inventory</option><option value="equipped">Ship</option></select></span>
          <span style={{ width: 150, flex: "0 0 auto" }} />
          <span style={{ width: 120, flex: "0 0 auto" }}><select className="bfield" value={fRes} onChange={(e) => setFRes(e.target.value)}><option value="">All</option><option value="unlocked">Unlocked</option><option value="locked">Locked</option></select></span>
          <span style={{ flex: 1 }} />
        </div>
        <div className="brows">
          {owned.map((b) => {
            const id = boosterId(b);
            const r = b.resonance ?? null;
            const isA = assigned.has(id), isSkip = unplaceable.has(id), isF = forced.has(id);
            const rc = RARITY_COLOR[b.rarity] ?? "#cfcfcf";
            return (
              <div key={id} className={`brow${isA ? " a" : isSkip ? " s" : ""}`}>
                <span className="bicon26" style={{ backgroundColor: boosterTypeColor(b), backgroundImage: `url("${itemIcon(conn, b) ?? ""}")` }} />
                <span className="bname" style={{ color: rc, width: 216, flex: "0 0 auto" }}>{b.name}</span>
                <span className="btype" style={{ width: 120 }}>{boosterType(b)}</span>
                <span className="bvalc" style={{ width: 80 }}>+{fmt(boosterValue(b))}</span>
                <span className="blvlc" style={{ width: 52 }}>Lv {b.level}</span>
                <span className="bloc" style={{ width: 58 }}>{locLabel(b.location)}</span>
                <span className="bsecc" style={{ width: 150, color: r?.unlocked ? "#c07bff" : "#7a6a8a" }}>{r ? unlockBonusText(r) : "—"}</span>
                <span style={{ width: 120, flex: "0 0 auto" }} title={r ? progText(r) : ""}>
                  {r && <><div className="bprog"><div className="bprog-fill" style={{ width: `${resonancePct(r)}%`, background: r.unlocked ? "#c07bff" : "#5a6b8a" }} /></div><div className="bprog-txt">{progText(r)}</div></>}
                </span>
                <span style={{ flex: 1 }} />
                {b.location === "equipped" && <span className="beq">EQUIPPED</span>}
                {isA && <span className="badot">● assigned</span>}
                {isSkip && <span className="bwarn" title="Forced but no slot is set to its type">⚠ forced · no slot</span>}
                <button className={`bforce${isF ? " on" : ""}`} title="Force this booster into a slot of its type" onClick={() => toggleForce(id)}>{isF ? "★" : "☆"}</button>
              </div>
            );
          })}
        </div>
        {!owned.length && <p className="hint">No boosters{pool.length ? " match the filter" : docked ? " owned" : " — dock to read the armory"}.</p>}
        </div>
        </div>
      </div>
      {/* The same card every other tab shows, rather than a booster-shaped summary of it — one owner, so a
          booster's stat lines, aspects and resonance read identically wherever the player meets them. */}
      {hover && <ItemTip it={hover.it} x={hover.x} y={hover.y} conn={conn} vs={hover.vs}
                         role={loadout?.role ?? null} />}
    </div>
  );
}
