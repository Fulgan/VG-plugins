import { useEffect, useMemo, useState } from "react";
import {
  boosterId, boosterType, boosterTypeColor, boosterTypes, boosterValue,
  defaultSlotTypes, isBooster, optimizeBoosters, resonancePct, unlockBonusText, type BoosterPick,
} from "./booster";
import type { Inventories, Item, Loadout, Resonance } from "./types";
import "./officers.css";

const RARITY_COLOR: Record<string, string> = {
  Standard: "#cfcfcf", Enhanced: "#58c26b", HighGrade: "#4aa3ff", Exotic: "#c07bff", Legendary: "#ffb020",
};
const fmt = (n: number) => (n >= 1000 ? n.toLocaleString(undefined, { maximumFractionDigits: 0 }) : Number(n.toFixed(2)).toString());
const locLabel = (l?: string) => (l === "equipped" ? "Ship" : l === "cargo" ? "Inventory" : l === "armory" ? "Armory" : l ?? "");
const progText = (r: Resonance) => (r.unlocked ? "Resonance unlocked" : `${Math.round(r.progress).toLocaleString()} / ${Math.round(r.threshold).toLocaleString()} ${r.unit}`);

// Shared booster state (slot types + force + the optimized picks), lifted into App so both the Boosters
// tab (display) and the Summary tab (apply) work off one result.
export interface BoosterBuilder {
  loadout: Loadout | null;
  slotCount: number;
  equippedBySlot: (Item | null)[];
  pool: Item[];
  invBoosters: Item[];
  types: string[];
  slotTypes: (string | null)[];
  setType: (i: number, t: string) => void;
  forced: Set<string>;
  toggleForce: (id: string) => void;
  picks: BoosterPick[];
  assigned: Set<string>;
  unplaceable: Set<string>;
  totals: [string, number][];
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
  const equipped = useMemo(() => (loadout?.boosters ?? []).map((b) => ({ ...b, location: "equipped" })), [loadout]);
  const equippedBySlot = useMemo(
    () => Array.from({ length: slotCount }, (_, i) => equipped.find((b) => b.slot === i) ?? null),
    [equipped, slotCount],
  );
  const pool = useMemo(() => [...equipped, ...invBoosters], [equipped, invBoosters]);
  const types = useMemo(() => boosterTypes(pool), [pool]);

  const [slotTypes, setSlotTypes] = useState<(string | null)[]>([]);
  useEffect(() => {
    setSlotTypes(defaultSlotTypes(equippedBySlot, slotCount, role, pool));
  }, [shipGuid, slotCount]); // eslint-disable-line react-hooks/exhaustive-deps
  const setType = (i: number, t: string) => setSlotTypes((s) => s.map((x, j) => (j === i ? t : x)));

  const [forced, setForced] = useState<Set<string>>(new Set());
  const toggleForce = (id: string) => setForced((s) => { const n = new Set(s); n.has(id) ? n.delete(id) : n.add(id); return n; });

  const { picks, unplaceableForced } = useMemo(() => optimizeBoosters(pool, slotTypes, forced), [pool, slotTypes, forced]);
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

  return { loadout, slotCount, equippedBySlot, pool, invBoosters, types, slotTypes, setType, forced, toggleForce, picks, assigned, unplaceable, totals, changed, unfilled, applyPayload };
}

export default function BoostersTab({ builder, docked, goSummary }: { builder: BoosterBuilder; docked: boolean; goSummary: () => void }) {
  const { loadout, slotCount, equippedBySlot, pool, types, slotTypes, setType, forced, toggleForce, picks, assigned, unplaceable, totals, changed, unfilled } = builder;

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
  const arrow = (k: string) => (sort.key === k ? (sort.dir === -1 ? " ▼" : " ▲") : "");
  const anyFilter = !!(fName || fType || fLoc || fRes);

  if (slotCount === 0) return <p className="hint">This ship has no booster slots{docked ? "" : " — dock to read the loadout"}.</p>;

  const card = (b: Item | null, kind: "current" | "best", typeSet: boolean) => {
    const rc = b ? RARITY_COLOR[b.rarity] ?? "#cfcfcf" : "#3a3a42";
    const r = b?.resonance ?? null;
    const emptyLabel = kind === "best" ? (typeSet ? "none owned" : "—") : "empty slot";
    return (
      <div className={`bcard${kind === "best" ? " best" : ""}${b ? "" : " empty"}`}>
        <div className="bcard-top">
          <span className="bicon" style={{ background: b ? boosterTypeColor(b) : "#1b1b1f", borderColor: b ? "transparent" : "#2a2a30" }} />
          <span className="bname" style={{ color: b ? rc : "#6f6f78" }}>{b ? b.name : emptyLabel}</span>
          {r?.unlocked && <span className="bres" title="Resonance unlocked">RES</span>}
          <span className="blvl">{b ? `Lv ${b.level}` : "—"}</span>
        </div>
        <div className="bcard-val">
          <span className="bsec">{r ? unlockBonusText(r) : b?.mainStat?.name ?? ""}</span>
          <span className="bval" style={{ color: b ? "#86efac" : "#5a5a62" }}>{b ? `+${fmt(boosterValue(b))}` : "—"}</span>
        </div>
        {r ? (
          <>
            <div className="bprog" title={progText(r)}><div className="bprog-fill" style={{ width: `${resonancePct(r)}%`, background: r.unlocked ? "#c07bff" : "#5a6b8a" }} /></div>
            <div className="bprog-txt">{progText(r)}</div>
          </>
        ) : <div className="bprog-spacer" />}
      </div>
    );
  };

  return (
    <div className="boosters">
      <div className="sum-head">
        <div className="panel-title">Booster optimizer <span className="dim">— {loadout?.name ?? "ship"} · {slotCount} slots</span></div>
        <button className="apply" onClick={goSummary} title="Review & apply changes in the Summary tab">Go to Summary →</button>
      </div>
      <p className="sum-note">
        Pick a booster <b>type</b> per slot (seeded from what's equipped; empty slots default to the ship's role).
        The optimizer drops in the highest-value owned booster of that type — none used twice — across your armory and inventory.
      </p>
      <div className="btype-note">
        <span className="dim">TYPE PER SLOT · CURRENT → BEST</span>
        <span className="up">{changed > 0 ? `${changed} slot${changed === 1 ? "" : "s"} would change` : "matches current"}</span>
      </div>
      {!docked && <div className="sum-msg err">⚠ Undocked — armory boosters aren't readable; dock for the full pool.</div>}

      <div className="bslot-grid">
        {slotTypes.map((t, i) => (
          <div key={i} className="bslot">
            <div className="bslot-head">
              <span className="bslot-num">#{i + 1}</span>
              <select value={t ?? ""} onChange={(e) => setType(i, e.target.value)}>
                {t && !types.includes(t) && <option value={t}>{t}</option>}
                {types.map((ty) => (<option key={ty} value={ty}>{ty}</option>))}
              </select>
            </div>
            {card(equippedBySlot[i], "current", !!t)}
            <div className="barrow">▼</div>
            {card(picks[i]?.chosen ?? null, "best", !!t)}
          </div>
        ))}
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
                <span className="bicon26" style={{ background: boosterTypeColor(b) }} />
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
  );
}
