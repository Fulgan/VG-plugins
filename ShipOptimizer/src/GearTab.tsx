import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type DragEvent } from "react";
import { api, type Conn } from "./api";
import type { CatalogTypes, Inventories, Item, ShipHardpoint, ShipLayout } from "./types";
import "./officers.css";

// Same physical fit? Used to tell whether a proposed item differs from what's equipped (so an already-
// applied change clears and isn't re-sent). Type/size/level/rarity + MAIN STAT value + aspects +
// substats — the main stat matters because two same-name rolls can differ only there. null+null = same.
function sameFit(a: Item | null, b: Item | null): boolean {
  if (!a || !b) return !a && !b;
  return (a.type ?? a.name) === (b.type ?? b.name)
    && (a.size ?? "") === (b.size ?? "")
    && a.level === b.level && a.rarity === b.rarity
    && (a.mainStat?.amount ?? "") === (b.mainStat?.amount ?? "")
    && (a.aspects ?? []).map((x) => x.name).sort().join(",") === (b.aspects ?? []).map((x) => x.name).sort().join(",")
    && (a.stats ?? []).map((s) => `${s.stat}=${s.amount}`).sort().join(",") === (b.stats ?? []).map((s) => `${s.stat}=${s.amount}`).sort().join(",");
}

const RARITY_COLOR: Record<string, string> = {
  Standard: "#cfcfcf", Enhanced: "#58c26b", HighGrade: "#4aa3ff", Exotic: "#c07bff", Legendary: "#ffb020",
};
const SIZES = ["Small", "Medium", "Large", "Tiny"];
const num = (n: number) => (n >= 1000 ? n.toLocaleString(undefined, { maximumFractionDigits: 0 }) : Number(n.toFixed(1)).toString());
const subFmt = (l: { stat: string; amount: number; multiplier?: number }) =>
  l.multiplier && l.multiplier !== 1 ? `×${Number(l.multiplier.toFixed(3))} ${l.stat}` : `${l.amount >= 0 ? "+" : ""}${num(l.amount)} ${l.stat}`;

function power(it: Item): number {
  const raw = it.mainStat?.amount;
  if (!raw) return 0;
  const m = raw.replace(/,/g, "").match(/([+-]?\d+(?:\.\d+)?)\s*([KMBT%]?)/i);
  if (!m) return 0;
  const mult: Record<string, number> = { "": 1, K: 1e3, M: 1e6, B: 1e9, T: 1e12, "%": 1 };
  return parseFloat(m[1]) * (mult[m[2].toUpperCase()] ?? 1);
}
const catOf = (it: Item): "Combat" | "Mining" | "Salvage" | "Other" => {
  const n = it.mainStat?.name ?? "";
  return n.startsWith("Combat") ? "Combat" : n.startsWith("Mining") ? "Mining" : n.startsWith("Salvage") ? "Salvage" : "Other";
};
export const isTurret = (it: Item) => it.category === "Turret";
const isModule = (it: Item) => !!it.slotType && it.slotType !== "Hardpoint" && it.category !== "Turret" && it.category !== "Booster";
const handle = (it: Item) => `${it.location ?? ""}:${it.key}`;

// A gear slot key: "t:<index>" (turret) or "m:<EquipmentSlot>" (module).
type Filter = { mode: "all" | "type" | "damage" | "category"; value?: string };

// user categories persist (global)
const CAT_KEY = "shipoptimizer.turretCategories";
function loadCats(): Record<string, string[]> { try { return JSON.parse(localStorage.getItem(CAT_KEY) ?? "{}"); } catch { return {}; } }
function saveCats(c: Record<string, string[]>) { try { localStorage.setItem(CAT_KEY, JSON.stringify(c)); } catch { /* quota */ } }
// per-ship slot filters persist (keyed by ship guid), so a ship's gun-filter setup survives reloads.
const GF_KEY = "shipoptimizer.gearFilters";
type FiltersByShip = Record<string, Record<number, Filter>>;
function loadGF(): FiltersByShip { try { return JSON.parse(localStorage.getItem(GF_KEY) ?? "{}"); } catch { return {}; } }
function saveGF(m: FiltersByShip) { try { localStorage.setItem(GF_KEY, JSON.stringify(m)); } catch { /* quota */ } }

// Does an item fit a turret slot (size) under its filter?
export type GearFilter = Filter;
export function turretFits(it: Item, size: string, f: Filter, cats: Record<string, string[]>): boolean {
  if (!isTurret(it) || it.size !== size) return false;
  if (f.mode === "type") return it.type === f.value;
  if (f.mode === "damage") return catOf(it) === "Combat" && it.damageType === f.value;
  if (f.mode === "category") return (cats[f.value ?? ""] ?? []).includes(it.type ?? ""); // any turret type (combat/mining/salvage)
  return true;
}
const moduleFits = (it: Item, slot: string, size: string) => isModule(it) && it.slotType === slot && (!size || !it.size || it.size === size);

export interface GearChange { key: string; kind: "Turret" | "Module"; label: string; current: Item | null; next: Item; }
export interface GearBuilder {
  gear: Item[];
  hps: ShipHardpoint[];
  mslots: { slot: string; size: string; equipped: Item | null }[];
  cats: Record<string, string[]>; setCats: (c: Record<string, string[]>) => void;
  filters: Record<number, Filter>; setFilters: (upd: (f: Record<number, Filter>) => Record<number, Filter>) => void;
  assign: Record<string, Item>;
  setAssign: (upd: (a: Record<string, Item>) => Record<string, Item>) => void;
  setSlotItem: (key: string, it: Item | null) => void;
  clearAll: () => void;
  payload: { kind: string; slot: number | string; store: string; key: number | null; name: string; level: number }[];
  changes: GearChange[];
}

// Shared gear state (assignments + per-ship filters + categories), lifted into App so the Gear tab and
// the Summary tab work off one result.
export function useGearBuilder(layout: ShipLayout | null, inv: Inventories | null): GearBuilder {
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
  const setCats = useCallback((c: Record<string, string[]>) => { setCatsS(c); saveCats(c); }, []);
  const [filtersByShip, setFiltersByShip] = useState<FiltersByShip>(loadGF);
  const filters = useMemo(() => filtersByShip[shipGuid] ?? {}, [filtersByShip, shipGuid]);
  const setFilters = useCallback((upd: (f: Record<number, Filter>) => Record<number, Filter>) =>
    setFiltersByShip((m) => { const next = { ...m, [shipGuid]: upd(m[shipGuid] ?? {}) }; saveGF(next); return next; }), [shipGuid]);
  const [assign, setAssign] = useState<Record<string, Item>>({});
  const setSlotItem = useCallback((key: string, it: Item | null) =>
    setAssign((a) => { const n = { ...a }; if (it) n[key] = it; else delete n[key]; return n; }), []);
  const clearAll = useCallback(() => setAssign({}), []);
  const hps = useMemo(() => [...(layout?.hardpoints ?? [])].sort((a, b) => a.index - b.index), [layout]);
  const mslots = layout?.modules ?? [];
  // Proposed gear is per-ship — drop it all when the ship changes, so a previous ship's changes (e.g. a
  // module slot the new ship doesn't even have) don't leak into the summary/apply.
  const prevShip = useRef<string | null>(shipGuid);
  useEffect(() => { if (prevShip.current !== shipGuid) { prevShip.current = shipGuid; setAssign({}); } }, [shipGuid]);
  // Does the current ship actually have this slot? Guards against assigns for slots not on this ship.
  const slotExists = useCallback((k: string): boolean =>
    k.startsWith("t:") ? hps.some((h) => h.index === Number(k.slice(2)))
                       : mslots.some((x) => x.slot === k.slice(2)), [hps, mslots]);
  // Currently-equipped item for an assign key ("t:<idx>" hardpoint / "m:<slot>" module).
  const curOf = useCallback((k: string): Item | null =>
    k.startsWith("t:") ? (hps.find((h) => h.index === Number(k.slice(2)))?.equipped ?? null)
                       : (mslots.find((x) => x.slot === k.slice(2))?.equipped ?? null), [hps, mslots]);
  // Skip no-op assignments: if the equipped item already IS the proposed one, it's not a change (and
  // must not be re-applied — the armory handle would be stale). Identity includes main stat.
  const payload = useMemo(() => {
    const p: GearBuilder["payload"] = [];
    for (const [k, it] of Object.entries(assign)) {
      if (!slotExists(k) || it.key == null || !it.location) continue;
      if (sameFit(curOf(k), it)) continue;
      if (k.startsWith("t:")) p.push({ kind: "Turret", slot: Number(k.slice(2)), store: it.location, key: it.key, name: it.name, level: it.level });
      else p.push({ kind: "Module", slot: k.slice(2), store: it.location, key: it.key, name: it.name, level: it.level });
    }
    return p;
  }, [assign, curOf, slotExists]);
  const changes = useMemo<GearChange[]>(() => {
    const out: GearChange[] = [];
    for (const [k, it] of Object.entries(assign)) {
      if (!slotExists(k)) continue; // slot not on this ship (stale/cross-ship proposal) → ignore
      const current = curOf(k);
      if (sameFit(current, it)) continue; // equipped already matches the proposal → not a change
      if (k.startsWith("t:")) out.push({ key: k, kind: "Turret", label: `Slot ${Number(k.slice(2)) + 1}`, current, next: it });
      else out.push({ key: k, kind: "Module", label: k.slice(2), current, next: it });
    }
    return out.sort((a, b) => a.key.localeCompare(b.key));
  }, [assign, curOf, slotExists]);
  return { gear, hps, mslots, cats, setCats, filters, setFilters, assign, setAssign, setSlotItem, clearAll, payload, changes };
}

export default function GearTab({
  layout, builder, catalog, conn, docked, currentShipGuid, goSummary,
}: {
  layout: ShipLayout | null;
  builder: GearBuilder;
  catalog: CatalogTypes | null;
  conn: Conn;
  docked: boolean;
  currentShipGuid: string | null;
  goSummary: () => void;
}) {
  const ro = !docked; // undocked → read-only (armory data is stale); config still viewable
  const { gear, hps, mslots, cats, setCats, filters, setFilters, assign, setAssign, setSlotItem, payload } = builder;
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
  const [dragItem, setDragItem] = useState<Item | null>(null);
  const [aspFilter, setAspFilter] = useState<Set<string>>(new Set());
  const [listQ, setListQ] = useState(""); // name search over the compatible-equipment list
  const [hover, setHover] = useState<{ it: Item; x: number; y: number } | null>(null);
  const [hoverSlot, setHoverSlot] = useState<number | null>(null);
  const [showCats, setShowCats] = useState(false);

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
    return items.sort((a, b) => power(b) - power(a));
  }, [selSlot, hps, mslots, gear, filters, cats, aspFilter, listQ]);

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
  const validSlot = useCallback((key: string): boolean => {
    if (!dragItem) return false;
    if (key.startsWith("t:")) { const hp = hps.find((h) => `t:${h.index}` === key); return !!hp && isTurret(dragItem) && dragItem.size === hp.size; }
    const slot = key.slice(2); const m = mslots.find((x) => x.slot === slot); return !!m && moduleFits(dragItem, slot, m.size);
  }, [dragItem, hps, mslots]);

  // Best match for a single slot (honors its filter/size), excluding gear assigned to other slots.
  const suggestSlot = (key: string) => {
    const usedOther = new Set(Object.entries(assign).filter(([k]) => k !== key).map(([, it]) => handle(it)));
    let cand: Item | undefined; let eqPow = 0; let upgradeOnly = true;
    if (key.startsWith("t:")) {
      const idx = Number(key.slice(2)); const hp = hps.find((h) => h.index === idx); if (!hp) return;
      const f = filters[idx] ?? { mode: "all" };
      eqPow = hp.equipped ? power(hp.equipped) : 0;
      // Lower-power swap allowed ONLY to change type: filter set AND the equipped gun doesn't match it.
      const eqMatches = hp.equipped ? turretFits(hp.equipped, hp.size, f, cats) : false;
      upgradeOnly = f.mode === "all" || eqMatches;
      cand = gear.filter((g) => turretFits(g, hp.size, f, cats) && !usedOther.has(handle(g))).sort((x, y) => power(y) - power(x))[0];
    } else {
      const slot = key.slice(2); const m = mslots.find((x) => x.slot === slot); if (!m) return;
      eqPow = m.equipped ? power(m.equipped) : 0;
      cand = gear.filter((g) => moduleFits(g, slot, m.size) && !usedOther.has(handle(g))).sort((x, y) => power(y) - power(x))[0];
    }
    setSlotItem(key, cand && (upgradeOnly ? power(cand) > eqPow : true) ? cand : null);
  };
  // Set the SAME list-filter on every turret slot (e.g. all → a damage type or a custom category).
  const setAllFilter = (v: string) => {
    const [m, ...r] = v.split(":");
    const f: Filter = v && v !== "all" ? { mode: m as Filter["mode"], value: r.join(":") } : { mode: "all" };
    setFilters(() => Object.fromEntries(hps.map((h) => [h.index, f])));
  };
  const allDmgs = useMemo(() => [...new Set(gear.filter((g) => isTurret(g) && catOf(g) === "Combat").map((g) => g.damageType).filter((d): d is string => !!d))].sort(), [gear]);

  const suggestTurrets = () => {
    setAssign((a) => {
      const n = { ...a };
      const used = new Set<string>();
      // Weakest-equipped slots pick first, so the best owned turret lands where the gain is biggest —
      // among interchangeable (same size+filter) slots, don't replace a stronger gun and skip a weaker one.
      const order = [...hps].sort((x, y) => (x.equipped ? power(x.equipped) : 0) - (y.equipped ? power(y.equipped) : 0));
      for (const hp of order) {
        const f = filters[hp.index] ?? { mode: "all" };
        const eqPow = hp.equipped ? power(hp.equipped) : 0;
        const eqMatches = hp.equipped ? turretFits(hp.equipped, hp.size, f, cats) : false;
        const upgradeOnly = f.mode === "all" || eqMatches;
        const best = gear.filter((g) => turretFits(g, hp.size, f, cats) && !used.has(handle(g))).sort((x, y) => power(y) - power(x))[0];
        if (best && (upgradeOnly ? power(best) > eqPow : true)) { n[`t:${hp.index}`] = best; used.add(handle(best)); }
        else delete n[`t:${hp.index}`]; // equipped already best (or matches filter + stronger) → keep
      }
      return n;
    });
  };
  const suggestModules = () => {
    setAssign((a) => {
      const n = { ...a };
      const used = new Set<string>();
      for (const m of mslots) {
        const eqPow = m.equipped ? power(m.equipped) : 0;
        const best = gear.filter((g) => moduleFits(g, m.slot, m.size) && !used.has(handle(g))).sort((x, y) => power(y) - power(x))[0];
        if (best && power(best) > eqPow) { n[`m:${m.slot}`] = best; used.add(handle(best)); }
        else delete n[`m:${m.slot}`];
      }
      return n;
    });
  };

  if (!layout) return <p className="hint">Dock once to load the ship layout — it then stays visible (read-only) while undocked. (Needs the current Hypercom build; restart the game if you just updated it.)</p>;
  const sizesPresent = SIZES.filter((s) => hps.some((h) => h.size === s));

  const dropProps = (key: string) => ({
    onDragOver: (e: DragEvent) => { if (validSlot(key)) e.preventDefault(); },
    onDrop: (e: DragEvent) => { e.preventDefault(); if (validSlot(key) && dragItem) { setSlotItem(key, dragItem); setDragItem(null); } },
  });

  // Turret slot panel
  const turretPanel = (hp: (typeof hps)[number]) => {
    const key = `t:${hp.index}`;
    const cur = hp.equipped;
    const nu = assign[key] ?? null;
    const f = filters[hp.index] ?? { mode: "all" };
    // Dropdown lists every turret type/damage you own (ANY size) so a filter is always selectable; the
    // item list below still enforces this slot's size (picking a type you lack in this size → empty list).
    // Option universe = catalog (all game types) ∪ owned ∪ equipped, split by category.
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
    const dimmed = !!dragItem && !validSlot(key);
    return (
      <div key={key} className={`gear-panel${selSlot === key ? " sel" : ""}${dragItem ? (validSlot(key) ? " droptgt" : " dim") : ""}`}
        onClick={() => setSelSlot(key)}
        onMouseEnter={() => setHoverSlot(hp.index)} onMouseLeave={() => setHoverSlot((x) => (x === hp.index ? null : x))}
        {...dropProps(key)}>
        <div className="gear-panel-head">Slot {hp.index + 1} <span className="dim">· {hp.size}</span><button className="slot-sug" title="suggest best for this slot" disabled={ro} onClick={(e) => { e.stopPropagation(); suggestSlot(key); }}>⚡</button></div>
        <div className="gear-swap">
          <Vig it={cur ?? null} label="current" onHover={setHover} />
          <span className="gear-arrow">→</span>
          <NewVig it={nu} onClear={ro ? undefined : () => setSlotItem(key, null)} onHover={setHover} dimmed={dimmed} />
        </div>
        <FilterSelect
          value={f.mode === "all" ? "" : `${f.mode}:${f.value}`}
          groups={[
            ...(catNames.length ? [{ label: "My categories", opts: catNames.map((n) => ({ v: `category:${n}`, label: n })) }] : []),
            ...(combat.length ? [{ label: "Combat — type", opts: combat.map((t) => ({ v: `type:${t}`, label: t })) }] : []),
            ...(dmgs.length ? [{ label: "Combat — damage", opts: dmgs.map((d) => ({ v: `damage:${d}`, label: d })) }] : []),
            ...(nonCombat.length ? [{ label: "Mining / Salvage — type", opts: nonCombat.map((t) => ({ v: `type:${t}`, label: t })) }] : []),
          ]}
          onChange={(v) => { const [m, ...r] = v.split(":"); setFilters((s) => ({ ...s, [hp.index]: v ? { mode: m as Filter["mode"], value: r.join(":") } : { mode: "all" } })); setSelSlot(key); }} />
      </div>
    );
  };

  return (
    <div className="gear">
      <div className="sum-head">
        <div className="panel-title">Ship gear <span className="dim">— {layout.name} · {hps.length} hardpoints{onCurrent ? "" : " · not the current ship"}</span></div>
        <div className="sum-actions">
          <button className="undo-suggest" onClick={() => setShowCats((v) => !v)}>{showCats ? "▾ Categories" : "▸ Categories"}</button>
          <button className="apply" onClick={goSummary} title="Review & apply all changes in the Summary tab">Go to Summary{payload.length ? ` (${payload.length})` : ""} →</button>
        </div>
      </div>
      {ro && <div className="sum-msg err">⚠ Undocked — read-only (showing the last docked loadout). Dock to change gear.</div>}
      {showCats && <CategoryEditor combatTypes={combatTypes} cats={cats} setCats={setCats} />}

      <div className="gear-ship">
        <div className="gear-ship-wrap">
          <img className="gear-img" src={api.shipImageUrl(conn, layout.shipGuid) ?? ""} alt={layout.name} />
          {hps.map((h) => {
            const on = hoverSlot === h.index || selSlot === `t:${h.index}` || (dragItem && isTurret(dragItem) && dragItem.size === h.size);
            return <span key={h.index} className={`gear-mount${on ? " hot" : ""}`} style={{ left: `${h.u * 100}%`, top: `${h.v * 100}%` }} title={`#${h.index} ${h.size}`}><span className="gear-mount-dot" /></span>;
          })}
        </div>
      </div>

      <div className="gear-main">
        <div className="gear-slots">
          <div className="gear-mod-head">
            <div className="panel-title">Hardpoints <span className="dim">— current → new · drag from the list or click a slot</span></div>
            <span className="spacer" />
            <select className="gear-sel setall" value="" title="Set the same filter on every turret slot" onChange={(e) => setAllFilter(e.target.value)}>
              <option value="">Set all to…</option>
              <option value="all">All compatible</option>
              {Object.keys(cats).length ? <optgroup label="My categories">{Object.keys(cats).map((n) => <option key={n} value={`category:${n}`}>{n}</option>)}</optgroup> : null}
              {allDmgs.length ? <optgroup label="Damage">{allDmgs.map((d) => <option key={d} value={`damage:${d}`}>{d}</option>)}</optgroup> : null}
            </select>
            <button className="undo-suggest" disabled={ro} onClick={suggestTurrets}>Suggest guns</button>
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
              <button className="undo-suggest" disabled={ro} onClick={suggestModules}>Suggest</button>
            </div>
            <div className="gear-cols">
              {mslots.map((m, i) => {
                const key = `m:${m.slot}`;
                const nu = assign[key] ?? null;
                return (
                  <div key={i} className={`gear-panel${selSlot === key ? " sel" : ""}${dragItem ? (validSlot(key) ? " droptgt" : " dim") : ""}`}
                    onClick={() => setSelSlot(key)} {...dropProps(key)}>
                    <div className="gear-panel-head">{m.slot} <span className="dim">· {m.size}</span><button className="slot-sug" title="suggest best for this slot" disabled={ro} onClick={(e) => { e.stopPropagation(); suggestSlot(key); }}>⚡</button></div>
                    <div className="gear-swap">
                      <Vig it={m.equipped} label="current" onHover={setHover} />
                      <span className="gear-arrow">→</span>
                      <NewVig it={nu} onClear={ro ? undefined : () => setSlotItem(key, null)} onHover={setHover} dimmed={!!dragItem && !validSlot(key)} />
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        </div>

        {/* shared compatible-equipment list */}
        <aside className="gear-list-panel">
          <div className="gear-list-head">
            <b>{selSlot ? "Fits this slot" : "Pick a slot"}</b>
            <span className="dim">{selSlot ? `· ${listItems.length}` : "· click a slot panel"}</span>
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
              <div key={handle(it) + it.name} className="gear-litem" draggable={!ro}
                onDragStart={() => setDragItem(it)} onDragEnd={() => setDragItem(null)}
                onClick={() => { if (!ro && selSlot) setSlotItem(selSlot, it); }}
                onMouseEnter={(e) => setHover({ it, x: e.clientX, y: e.clientY })}
                onMouseMove={(e) => setHover((h) => (h ? { ...h, x: e.clientX, y: e.clientY } : h))}
                onMouseLeave={() => setHover(null)}>
                <span className="li-icon" style={{ backgroundImage: `url("${api.itemImageUrl(conn, it.location ?? null, it.key ?? null) ?? ""}")` }} />
                <span className="li-name" style={{ color: RARITY_COLOR[it.rarity] ?? "#cfcfcf" }}>{it.name}</span>
                <span className="li-slots" title={`${it.aspects.length} of ${it.aspectSlots ?? 0} aspect slots filled`}>{"◆".repeat(it.aspects.length)}{"◇".repeat(Math.max(0, (it.aspectSlots ?? 0) - it.aspects.length))}<span className="dim"> {it.aspectSlots ?? 0}</span></span>
                <span className="li-main">+{num(power(it))}</span>
                <span className="li-lvl dim">Lv {it.level}</span>
              </div>
            ))}
          </div>
        </aside>
      </div>

      {hover && <ItemTip it={hover.it} x={hover.x} y={hover.y} conn={conn} />}
    </div>
  );
}

// Searchable combobox replacing the native <select> for the per-slot filter (grouped + type-to-filter).
interface FGroup { label: string; opts: { v: string; label: string }[] }
function FilterSelect({ value, groups, onChange }: { value: string; groups: FGroup[]; onChange: (v: string) => void }) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const cur = groups.flatMap((g) => g.opts).find((o) => o.v === value);
  const label = value === "" ? "All compatible" : cur?.label ?? value;
  const ql = q.trim().toLowerCase();
  const pick = (v: string) => { onChange(v); setOpen(false); setQ(""); };
  return (
    <div className="fsel" onClick={(e) => e.stopPropagation()}>
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

// current-side vignette; `it === null` = empty, `undefined` = show name/sub props
function Vig({ it, label, onHover }: { it: Item | null; label: string; onHover?: (h: { it: Item; x: number; y: number } | null) => void }) {
  if (!it) return <div className="gear-vig"><div className="gear-vig-tag">{label}</div><div className="gear-vig-name dim">empty</div></div>;
  const sub = isTurret(it) ? `${it.damageType ?? ""} · Lv ${it.level}` : `Lv ${it.level}`;
  return (
    <div className="gear-vig" onMouseEnter={(e) => onHover?.({ it, x: e.clientX, y: e.clientY })} onMouseMove={(e) => onHover?.({ it, x: e.clientX, y: e.clientY })} onMouseLeave={() => onHover?.(null)}>
      <div className="gear-vig-tag">{label}</div>
      <div className="gear-vig-name" style={{ color: RARITY_COLOR[it.rarity] ?? "#cfcfcf" }}>{it.name}</div>
      <div className="gear-vig-sub">{sub} · +{num(power(it))} · ◆{it.aspectSlots ?? 0}</div>
    </div>
  );
}
function NewVig({ it, onClear, onHover, dimmed }: { it: Item | null; onClear?: () => void; onHover: (h: { it: Item; x: number; y: number } | null) => void; dimmed?: boolean }) {
  return (
    <div className={`gear-vig${it ? " best" : ""}${dimmed ? " dim" : ""}`}>
      <div className="gear-vig-tag">new{it && onClear && <button className="vig-x" onClick={(e) => { e.stopPropagation(); onClear(); }} title="leave alone">×</button>}</div>
      {it ? (
        <div onMouseEnter={(e) => onHover({ it, x: e.clientX, y: e.clientY })} onMouseMove={(e) => onHover({ it, x: e.clientX, y: e.clientY })} onMouseLeave={() => onHover(null)}>
          <div className="gear-vig-name" style={{ color: RARITY_COLOR[it.rarity] ?? "#cfcfcf" }}>{it.name}</div>
          <div className="gear-vig-sub">{it.damageType ?? catOf(it)} · Lv {it.level} · +{num(power(it))} · ◆{it.aspectSlots ?? 0}</div>
        </div>
      ) : <div className="gear-vig-name dim">keep current</div>}
    </div>
  );
}

// Full in-game-style tooltip.
export function ItemTip({ it, x, y, conn, imgUrl }: { it: Item; x: number; y: number; conn: Conn; imgUrl?: string | null }) {
  const img = imgUrl !== undefined ? imgUrl : api.itemImageUrl(conn, it.location ?? null, it.key ?? null);
  const ref = useRef<HTMLDivElement>(null);
  // Measure the rendered tooltip and clamp it fully inside the viewport (flip left/up near edges).
  const [pos, setPos] = useState<{ left: number; top: number; vis: boolean }>({ left: x + 16, top: y + 14, vis: false });
  useLayoutEffect(() => {
    const el = ref.current; if (!el) return;
    const r = el.getBoundingClientRect(); const pad = 8;
    let left = x + 16; if (left + r.width > window.innerWidth - pad) left = Math.max(pad, x - 16 - r.width);
    let top = y + 14; if (top + r.height > window.innerHeight - pad) top = Math.max(pad, window.innerHeight - pad - r.height);
    setPos({ left, top, vis: true });
  }, [x, y, it]);
  const style: CSSProperties = { position: "fixed", left: pos.left, top: pos.top, visibility: pos.vis ? "visible" : "hidden" };
  return (
    <div className="git" ref={ref} style={style}>
      <div className="git-top">
        <div>
          <div className="git-cls">{[it.size, it.type].filter(Boolean).join(" ")}</div>
          <div className="git-name" style={{ color: RARITY_COLOR[it.rarity] ?? "#cfcfcf" }}>{it.name}</div>
          {it.manufacturer && <div className="git-mfr">{it.manufacturer}</div>}
        </div>
        <div className="git-lvl">Lv {it.level}{it.bonus ? <span className="git-q"> Q{it.bonus}</span> : null}</div>
      </div>
      {img && <span className="git-img" style={{ backgroundImage: `url("${img}")` }} />}
      {it.mainStat && <div className="git-main">{it.mainStat.amount} {it.mainStat.name}</div>}
      {it.fireRate != null && <div className="git-line">{Number(it.fireRate.toFixed(2))} attacks per second</div>}
      {it.damageType && <div className="git-line">{it.damageType} damage</div>}
      <div className="git-icons">
        {it.range != null && <span title="range">→ {num(it.range)}</span>}
        {it.emp ? <span title="EMP">◇ {num(it.emp)}</span> : null}
        {it.powerUsage != null && <span title="power use">⚡ {num(it.powerUsage)}</span>}
      </div>
      {(it.substats?.length ?? 0) > 0 && <div className="git-subs">{(it.substats ?? []).map((s, i) => <div key={i} className="git-sub">{subFmt(s)}</div>)}</div>}
      {it.ammo && <div className="git-line dim">Requires {it.ammo} Ammo{it.ammoPerMin != null ? ` · ~${Math.round(it.ammoPerMin)}/min` : ""}</div>}
      {(it.aspects ?? []).map((a, i) => (
        <div key={i} className="git-asp"><div className="git-asp-name">{a.name}</div>{a.description && <div className="git-asp-desc">{a.description}</div>}</div>
      ))}
      <div className="git-foot"><span>Vol {it.volume ?? "?"} m³</span><span>Value ¢{(it.sellValue ?? 0).toLocaleString()}</span><span className="dim">◆ {(it.aspects ?? []).length}/{it.aspectSlots ?? 0}</span></div>
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
      {Object.keys(cats).length === 0 && <div className="sum-none">No categories yet — add one, then check turret types into it. They appear in each combat slot's filter.</div>}
      {Object.entries(cats).map(([n, types]) => (
        <div key={n} className="gear-cat">
          <div className="gear-cat-head"><b>{n}</b> <span className="dim">· {types.length}</span><span className="spacer" /><button className="rm" onClick={() => del(n)}>×</button></div>
          <div className="gear-cat-types">{shownTypes.map((ty) => <label key={ty} className={types.includes(ty) ? "on" : ""}><input type="checkbox" checked={types.includes(ty)} onChange={() => toggle(n, ty)} /> {ty}</label>)}</div>
        </div>
      ))}
    </div>
  );
}
