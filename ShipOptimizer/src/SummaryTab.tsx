import { useCallback, useEffect, useMemo, useRef, useState, type MouseEvent } from "react";
import { api, itemIcon, type Conn } from "./api";
import { boosterId, boosterTypeColor, boosterValue } from "./booster";
import type { OfficerBuilder } from "./OfficersTab";
import { ApplyMsg } from "./ApplyBar";
import PlanNotice from "./PlanNotice";
import type { ApplyApi } from "./useApply";
import type { BoosterBuilder } from "./BoostersTab";
import { type GearBuilder } from "./GearTab";
import { type GearFilter } from "./gearFit";
import { ItemTip } from "./ItemCard";
import { useConfirm } from "./Modal";
import type { Scope } from "./officer";
import type { ActivityProfile } from "./activityPresets";
import type { Item, LoadoutPresetInfo, Officer } from "./types";
import { RARITY_COLOR, fmt } from "./format";
import { load, save } from "./storage";
import { useCursorTip } from "./useCursorTip";

// Persistent action log (localStorage) — records every apply/undo: request payload + the ship's equipped
// state at click time + the raw response. Survives reloads so a mis-apply can be inspected after the fact.
// `ship` is the ship the action ran against — the log persists across ship switches, so without it an
// entry can't be told apart from the same action on another hull. Absent on entries logged before it existed.

// The optimizer settings a saved loadout carries alongside its equipped gear/officers — serialized to
// the preset's opaque `settings` blob (bridge-persisted + portable via export/import), reapplied on
// restore. All fields optional so an older preset (no blob) or a partial one restores what it has.
interface LoadoutSettings {
  prio?: string[];                       // officer priority-skill order
  forced?: string[];                     // pinned officer guids
  scope?: Scope;                         // current vs full-potential
  profile?: ActivityProfile;             // activity suggestion profile
  gearFilters?: Record<number, GearFilter>; // per-hardpoint filter
  cats?: Record<string, string[]>;       // custom turret categories
  boosterTypes?: (string | null)[];      // booster slot types
}
// Short, readable form of a playthrough fingerprint (drops the "gx-" tag, keeps 6 hex chars).
const shortPt = (pt?: string | null) => (pt ? pt.replace(/^gx-/, "").slice(0, 6) : "—");
// Last saved/loaded preset + a fingerprint of the loadout at that time — to offer "Update" when it drifts.
// `v` guards the fingerprint FORMAT: a baseline taken by an older build can't be compared against a
// fingerprint built by a newer one, so bump this whenever `itemFp`/`fingerprint` changes shape. A
// mismatched baseline is dropped (loadout reads as unmodified) instead of showing a bogus "modified".
const FP_VERSION = 2;
// Settle window for re-baselining after a restore (see `capture` below).
const CAPTURE_MS = 2500;
// Presets are per SHIP, so the "which loadout is active" baseline is stored per ship guid too —
// otherwise switching ships kept showing the previous ship's loadout as active/modified.
const ACTIVE_KEY = "shipoptimizer.activePreset";
const activeKey = (shipGuid: string | null) => `${ACTIVE_KEY}.${shipGuid ?? "none"}`;
interface ActivePreset { name: string; fp: string; v?: number }
const loadActive = (shipGuid: string | null): ActivePreset | null => {
  const a = load<ActivePreset | null>(activeKey(shipGuid), null);
  return a && a.v === FP_VERSION ? a : null;
};
const saveActive = (shipGuid: string | null, a: ActivePreset | null) => save(activeKey(shipGuid), a);

// Identity of one equipped item for drift detection. Name alone (or name#level) is NOT unique: two
// rolls of the same item share both, so swapping an Officer R-Booster Mk.XVI (+5.9) for a (+6.19) —
// or a Railgun Mk.XVI for a better-rolled Railgun Mk.XVI — used to read as "no change". Include
// everything that makes a roll distinct: quality, headline value, bonus lines. NOT aspects — those are
// swappable at a workshop, so socketing one must not read as "the equipped item changed under me".
const itemFp = (it: Item | null | undefined): string =>
  !it ? "-" : [
    it.name, it.level, it.rarity, it.bonus ?? 0, it.bonusStat ?? "", it.mainStat?.amount ?? "",
    (it.substats ?? []).map((s) => `${s.stat}=${s.amount}:${s.multiplier}`).sort().join(","),
  ].join("/");

// Key-order-independent serialization — the settings blob is part of the loadout fingerprint, so a
// mere reordering of object keys (round-tripping through JSON on restore) must not read as a change.
const stableKey = (v: unknown): string => {
  if (Array.isArray(v)) return `[${v.map(stableKey).join(",")}]`;
  if (v && typeof v === "object")
    return `{${Object.entries(v as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([k, x]) => `${k}:${stableKey(x)}`).join(",")}}`;
  return JSON.stringify(v) ?? "null";
};

// Pair leaving → joining into current→new rows (extra on either side pairs with a blank).
function pairs<T>(leave: T[], join: T[]): { cur: T | null; next: T | null }[] {
  const n = Math.max(leave.length, join.length);
  return Array.from({ length: n }, (_, i) => ({ cur: leave[i] ?? null, next: join[i] ?? null }));
}



// The apply hub: a current→new change list per category (officers, boosters), applied to the CURRENT
// ship via POST /loadout/apply (officers by guid, boosters by exact handle). Undo reverts the last apply.
export default function SummaryTab({
  officer, boosters, gear, portraitUrl, conn, crewSupported, currentShipGuid, playthrough, playthroughName, reloadNonce, apply,
}: {
  officer: OfficerBuilder;
  boosters: BoosterBuilder;
  gear: GearBuilder;
  apply: ApplyApi;   // the app's ONE apply owner — see useApply
  portraitUrl: (guid: string | null) => string | null;
  conn: Conn;
  crewSupported: boolean; // false on the release game (crew API renamed) — hide/mute all officer bits
  docked: boolean;
  hasHangar?: boolean;   // a personal hangar at the docked station — where a refit happens
  currentShipGuid: string | null;
  playthrough?: string | null; // current playthrough fingerprint — tagged onto each action-log entry
  playthroughName?: string | null; // pretty name for the current playthrough (shown instead of the hash)
  reloadNonce?: number; // bumped by the parent (e.g. after claiming an orphan) to force a preset reload
  onChanged: () => void;
}) {
  // Apply state comes from the shared owner, so this tab and the per-tab buttons agree on busy/message/log.
  const { busy, cannotApply, gate, addLog, run, log, clearLog, setMsg, shipName } = apply;
  const { applyOfficers, applyBoosters, applyGear, applyAll, undo } = apply;
  const [tip, setTip] = useState<TipState | null>(null); // hover tooltip for change-row items/officers



  // ---- officer changes: SET diff (who joins / who leaves), ignoring pure slot swaps ----
  // Slot order doesn't matter for stacking, so an officer that stays on the ship in a different
  // slot is NOT a change. Pair the leavers with the joiners into current→new rows.
  const oShip = officer.ship;
  const oAssigned = new Set((oShip?.assigned ?? []).filter((g): g is string => !!g));
  const oChosen = new Set((officer.result?.chosen ?? []).map((o) => o.guid));
  const oJoin = crewSupported ? (officer.result?.chosen ?? []).filter((o) => !oAssigned.has(o.guid)) : [];
  const oLeave = crewSupported ? officer.officers.filter((o) => oAssigned.has(o.guid) && !oChosen.has(o.guid)) : [];
  const officerPairs = pairs<Officer>(oLeave, oJoin);
  const officerOnCurrent = crewSupported && !!oShip && oShip.guid === currentShipGuid;

  // ---- booster changes: SET diff by booster identity (equipped set → chosen set) ----
  // A booster that stays on the ship (just moved slots) is not a change — skip it.
  const bEquipped = boosters.equippedBySlot.filter((b): b is Item => !!b);
  const bEqIds = new Set(bEquipped.map(boosterId));
  const bChosen = boosters.picks.map((p) => p.chosen).filter((b): b is Item => !!b);
  const bChIds = new Set(bChosen.map(boosterId));
  const bJoin = bChosen.filter((b) => !bEqIds.has(boosterId(b)));
  const bLeave = bEquipped.filter((b) => !bChIds.has(boosterId(b)));
  const boosterPairs = pairs<Item>(bLeave, bJoin);
  const boosterPayload = boosters.applyPayload;

  // Snapshot of what's equipped per booster slot right now — logged with each apply so we can see the
  // state change between clicks (the "had to apply twice" bug).

  // ---- gear changes: from the shared gear builder (turret + module assignments) ----
  const gearPayload = gear.payload;



  // ---- saved loadout presets (bridge-persisted: gear fingerprints + officer guids) ----
  const [presets, setPresets] = useState<LoadoutPresetInfo[]>([]);
  // The bridge already returns only the current ship's loadouts (presets are keyed per ship), so no
  // client-side filtering — show what we get.
  const shownPresets = presets;
  const [presetName, setPresetName] = useState("");
  const { ask, ui: confirmUi } = useConfirm();
  const [active, setActive] = useState<ActivePreset | null>(() => loadActive(currentShipGuid)); // last saved/loaded, per ship
  // The optimizer settings a loadout carries: officer priorities/pins/scope/activity, gear filters +
  // custom categories, booster slot types. Saved into the preset's opaque blob AND part of the
  // fingerprint below — changing a preference is a change to the loadout, so it enables "Update".
  const settings = useMemo<LoadoutSettings>(() => ({
    prio: officer.prio,
    forced: [...officer.forced].sort(), // a Set — sort so insertion order can't fake a change
    scope: officer.scope,
    profile: officer.profile,
    gearFilters: gear.filters,
    cats: gear.cats,
    boosterTypes: boosters.slotTypes,
  }), [officer, gear, boosters]);
  // Snapshot the optimizer settings into the preset's opaque blob (minified JSON — no tabs/newlines,
  // safe for the bridge's tab-delimited store).
  const gatherSettings = (): string => JSON.stringify(settings);
  // Fingerprint of the loadout: what's EQUIPPED (turrets + modules + boosters + officers) plus the
  // optimizer preferences. Per-item identity is content-based (see itemFp) so a same-name, same-level
  // swap for a different roll still registers.
  const fingerprint = useMemo(() => {
    const t = gear.hps.map((h) => `${h.index}:${itemFp(h.equipped)}`).join("|");
    const m = gear.mslots.map((s) => `${s.slot}:${itemFp(s.equipped)}`).join("|");
    const b = boosters.equippedBySlot.map((x, i) => `${i}:${itemFp(x)}`).join("|");
    const o = (officer.ship?.assigned ?? []).map((g) => g ?? "-").join(",");
    return `${t}##${m}##${b}##${o}##${stableKey(settings)}`;
  }, [gear, boosters, officer, settings]);
  const setActiveP = (a: ActivePreset | null) => { const n = a && { ...a, v: FP_VERSION }; setActive(n); saveActive(currentShipGuid, n); };
  // After a restore the loadout settles in TWO waves: the settings blob applies right away (local
  // state), the equipped gear only once the bridge refresh lands. So re-adopt the baseline on every
  // fingerprint change inside a short settle window — the last wave wins. A one-shot capture would
  // latch the first wave and then read the second as a user edit ("modified" straight after restore).
  const capture = useRef<{ name: string; until: number } | null>(null);
  useEffect(() => {
    const c = capture.current;
    if (!c) return;
    if (Date.now() > c.until) { capture.current = null; return; }
    setActiveP({ name: c.name, fp: fingerprint });
  }, [fingerprint]);
  const dirty = !!active && !!active.fp && active.fp !== fingerprint;
  // Update is offered for the active loadout once it drifts — and for ANY loadout when no active one is
  // tracked, since there's then nothing to detect drift against (new browser, ship switch, or a
  // fingerprint-format bump all land here) and the button would otherwise never appear.
  const canUpdate = (name: string) => (active ? active.name === name && dirty : true);

  // The bridge keys presets per ship, so the list must be refetched when the player switches ship —
  // `currentShipGuid` is a dep, not just decoration (without it a switch kept the old ship's list).
  const loadPresets = useCallback(async () => { try { setPresets((await api.presetsList(conn)).presets); } catch { /* offline */ } }, [conn, currentShipGuid]);
  useEffect(() => { loadPresets(); }, [loadPresets, reloadNonce]);
  // A switch also swaps which loadout counts as active — that baseline is stored per ship guid.
  useEffect(() => { capture.current = null; setActive(loadActive(currentShipGuid)); }, [currentShipGuid]);
  // Reapply a restored preset's settings to the live builders (current ship). Missing fields are left
  // untouched; a parse failure is ignored (restore of gear/officers still succeeded).
  const applySettings = (raw?: string | null) => {
    if (!raw) return;
    let s: LoadoutSettings;
    try { s = JSON.parse(raw) as LoadoutSettings; } catch { return; }
    if (s.prio) officer.setPrio(s.prio);
    if (s.forced) officer.setForced(s.forced);
    if (s.scope) officer.setScope(s.scope);
    if (s.profile) officer.setProfile(s.profile);
    if (s.gearFilters) gear.setFilters(() => s.gearFilters!);
    if (s.cats) gear.setCats(s.cats);
    if (s.boosterTypes) boosters.setSlotTypes(s.boosterTypes);
  };

  const doSave = (name: string) => run(async () => {
    const r = await api.presetSave(conn, name, gatherSettings()); addLog("save preset", [name], `gear=${r.gearSlots} officers=${r.officers}`);
    setPresetName(""); setActiveP({ name, fp: fingerprint }); await loadPresets(); return `Saved loadout "${r.saved}".`;
  });
  const savePreset = async () => {
    const n = presetName.trim(); if (!n) { setMsg({ ok: false, text: "name the loadout first" }); return; }
    if (presets.some((p) => p.name === n)
      && !(await ask({ title: `Overwrite the saved loadout "${n}"?`, detail: "The stored slots and officers are replaced by what is fitted now.", confirmLabel: "Overwrite", danger: true }))) return;
    doSave(n);
  };
  const updatePreset = async (name: string) => {
    if (await ask({ title: `Update "${name}" with the current loadout?`, detail: "The stored slots and officers are replaced by what is fitted now.", confirmLabel: "Update" })) doSave(name);
  };
  const restorePreset = (name: string) => run(async () => {
    const r = await api.presetRestore(conn, name); addLog("restore preset", [name], `changed=${r.changed} prior=${r.prior}`);
    applySettings(r.settings); // reapply the saved optimizer settings (priorities, filters, booster types, …)
    capture.current = { name, until: Date.now() + CAPTURE_MS };
    return `Restored "${r.restored}" — ${r.changed} slot(s). Undo reverts it.`;
  });
  const deletePreset = async (name: string) => {
    if (!(await ask({ title: `Delete the saved loadout "${name}"?`, detail: "This cannot be undone.", confirmLabel: "Delete", danger: true }))) return;
    run(async () => { await api.presetDelete(conn, name); if (active?.name === name) setActiveP(null); await loadPresets(); return `Deleted "${name}".`; });
  };

  const totalChanges = (officerOnCurrent ? officerPairs.length : 0) + boosterPairs.length + gear.changes.length;
  // Refitting happens in a personal hangar, and an industry station has none — so "docked" is not enough.
  // Defaults to true so an older bridge, which sends no such flag, is not locked out of applying.

  return (
    <div className="summary">
      {confirmUi}
      <div className="sum-head">
        <div className="panel-title">Loadout summary <span className="dim">— {boosters.loadout?.name ?? "ship"} · {totalChanges} change{totalChanges === 1 ? "" : "s"}</span></div>
        <div className="sum-actions">
          <button className="apply" disabled={gate || totalChanges === 0} title={cannotApply ?? "Apply every change below to the current ship."} onClick={applyAll}>Apply all</button>
          <button className="undo" disabled={gate} title="Restore the last applied change" onClick={undo}>Undo last</button>
        </div>
      </div>
      <ApplyMsg apply={apply} />

      {/* What the ship currently IS, above the list of what you're about to change about it. */}

      {/* Saved loadouts */}
      <div className="sum-presets">
        <div className="sum-card-head">
          <div><b>Saved loadouts</b> <span className="dim">— {crewSupported ? "gear + officers" : "gear"} for this ship</span></div>
        </div>
        <div className="preset-save">
          <input value={presetName} onChange={(e) => setPresetName(e.target.value)} placeholder="name this loadout…" onKeyDown={(e) => { if (e.key === "Enter") savePreset(); }} />
          <button className="apply sm" disabled={busy || !presetName.trim()} onClick={savePreset}>Save current</button>
        </div>
        {shownPresets.length === 0
          ? <div className="sum-none">No saved loadouts for this ship yet.</div>
          : shownPresets.map((p) => (
            <div key={p.name} className={`preset-row${active?.name === p.name ? " active" : ""}`}>
              <span className="preset-name">{p.name}{active?.name === p.name && <span className="dim"> · active{dirty ? " · modified" : ""}</span>}</span>
              <span className="dim">{p.ship} · {p.gearSlots} gear{crewSupported ? ` · ${p.officers} officers` : ""}</span>
              <span className="spacer" />
              {/* Saving only records state (bridge-side) — no docking needed, unlike Restore. Offered
                  whenever the active loadout has drifted, AND whenever there's no active loadout at all:
                  with no baseline to compare against, hiding Update left no way to update anything (the
                  case after a fresh browser, a ship switch, or a fingerprint-format change). */}
              {canUpdate(p.name) && <button className="apply sm" disabled={busy} title={active ? "Overwrite this loadout with the current gear + officers + preferences" : "No active loadout tracked — overwrite this one with the current state"} onClick={() => updatePreset(p.name)}>Update</button>}
              <button className="apply sm" disabled={gate} title={cannotApply ?? "Restore onto the current ship (undoable)."} onClick={() => restorePreset(p.name)}>Restore</button>
              <button className="rm" title="delete" onClick={() => deletePreset(p.name)}>×</button>
            </div>
          ))}
      </div>

      <div className="sum-sections">
        {/* Officers — hidden on the release game (crew API unavailable) */}
        {crewSupported && (
        <div className="sum-card">
          <div className="sum-card-head">
            <div><b>Officers</b> <span className="dim">— {oShip?.name ?? "—"}{officerOnCurrent ? "" : " · not the current ship"} · {officerPairs.length} change{officerPairs.length === 1 ? "" : "s"}</span></div>
            <button className="apply sm" disabled={gate || !officerOnCurrent || !officerPairs.length} title={!officerOnCurrent ? "Switch to this ship to apply its crew." : "Apply the officer changes."} onClick={applyOfficers}>Apply officers</button>
          </div>
          {officerPairs.length ? officerPairs.map((r, i) => (
            <ChangeRow key={i} onHover={setTip}
              cur={r.cur && { label: r.cur.name, color: RARITY_COLOR[r.cur.rarity] ?? "#cfcfcf", img: portraitUrl(r.cur.guid), tip: { officer: r.cur } }}
              next={r.next && { label: r.next.name, color: RARITY_COLOR[r.next.rarity] ?? "#cfcfcf", img: portraitUrl(r.next.guid), tip: { officer: r.next } }} />
          )) : <div className="sum-none">No officer changes{oJoin.length || oLeave.length ? "" : " (crew unchanged)"}.</div>}
        </div>
        )}

        {/* Boosters */}
        <div className="sum-card">
          <div className="sum-card-head">
            <div><b>Boosters</b> <span className="dim">— {boosterPairs.length} change{boosterPairs.length === 1 ? "" : "s"}</span></div>
            <button className="apply sm" disabled={gate || !boosterPayload.length} title={!boosterPayload.length ? "No armory/cargo booster changes." : "Apply the booster changes."} onClick={applyBoosters}>Apply boosters</button>
          </div>
          {boosterPairs.length ? boosterPairs.map((r, i) => (
            <ChangeRow key={i} onHover={setTip}
              cur={r.cur && { label: `${r.cur.name} (+${fmt(boosterValue(r.cur))})`, color: RARITY_COLOR[r.cur.rarity] ?? "#cfcfcf", img: itemIcon(conn, r.cur), tile: boosterTypeColor(r.cur), tip: { item: r.cur, imgUrl: itemIcon(conn, r.cur) } }}
              next={r.next && { label: `${r.next.name} (+${fmt(boosterValue(r.next))})`, color: RARITY_COLOR[r.next.rarity] ?? "#cfcfcf", img: itemIcon(conn, r.next), tile: boosterTypeColor(r.next), tip: { item: r.next, imgUrl: itemIcon(conn, r.next), vs: r.cur } }} />
          )) : <div className="sum-none">No booster changes.</div>}
        </div>

        {/* Turrets & modules (from the Gear tab) */}
        <div className="sum-card">
          <div className="sum-card-head">
            <div><b>Turrets &amp; modules</b> <span className="dim">— {gear.changes.length} change{gear.changes.length === 1 ? "" : "s"}</span></div>
            <button className="apply sm" disabled={gate || !gearPayload.length} title={!gearPayload.length ? "Pick gear in the Ship gear tab." : "Equip the selected gear."} onClick={applyGear}>Apply gear</button>
          </div>
          <PlanNotice verdict={gear.planVerdict} />
          {gear.changes.length ? gear.changes.map((c, i) => (
            <ChangeRow key={i} onHover={setTip}
              cur={c.current && { label: c.current.name, color: RARITY_COLOR[c.current.rarity] ?? "#cfcfcf", img: api.itemImageBySlot(conn, c.key, c.current?.name), tip: { item: c.current, imgUrl: api.itemImageBySlot(conn, c.key, c.current?.name) } }}
              next={{ label: c.next.name, color: RARITY_COLOR[c.next.rarity] ?? "#cfcfcf", img: itemIcon(conn, c.next), tip: { item: c.next, imgUrl: itemIcon(conn, c.next), vs: c.current } }} />
          )) : <div className="sum-none">No gear changes — pick some in the Ship gear tab.</div>}
        </div>
      </div>

      {/* persistent action log — every apply/undo: request + equipped snapshot + raw response */}
      <div className="sum-log">
        <div className="sum-log-head">
          <span className="panel-title">Action log <span className="dim">— {log.length}, newest first (persists)</span>
            {playthrough && <span className="pt-chip" title={`Current playthrough: ${playthroughName ? `${playthroughName} (${playthrough})` : playthrough}`}>▷ {playthroughName || shortPt(playthrough)}</span>}</span>
          <button className="undo-suggest" disabled={!log.length} onClick={clearLog}>Clear</button>
        </div>
        {log.length === 0
          ? <div className="sum-none">No actions yet — apply something and it's recorded here.</div>
          : log.map((e, i) => (
            <div key={i} className="log-row">
              <div className="log-line">
                <span className="log-t">{e.t}</span>
                <span className={`pt-chip${e.pt && playthrough && e.pt !== playthrough ? " other" : ""}`} title={e.pt ? `Playthrough: ${e.pt}` : "No playthrough recorded"}>{e.pt && e.pt === playthrough && playthroughName ? playthroughName : shortPt(e.pt)}</span>
                {/* which hull the action hit — dimmed when it wasn't the ship you're on now */}
                <span className={`ship-chip${e.ship && shipName && e.ship !== shipName ? " other" : ""}`} title={e.ship ? `Ship: ${e.ship}` : "No ship recorded"}>{e.ship ?? "—"}</span>
                <span className="log-act">{e.action}</span><span className="log-res">{e.res}</span>
              </div>
              {e.req.length > 0 && <ul className="log-req">{e.req.map((l, j) => <li key={j}>{l}</li>)}</ul>}
            </div>
          ))}
      </div>

      {tip?.item && <ItemTip it={tip.item} x={tip.x} y={tip.y} conn={conn} imgUrl={tip.imgUrl} vs={tip.vs} />}
      {tip?.officer && <OfficerTip o={tip.officer} x={tip.x} y={tip.y} portraitUrl={portraitUrl} />}
    </div>
  );
}

interface TipState { item?: Item; officer?: Officer; imgUrl?: string | null; vs?: Item | null; x: number; y: number }
interface Side { label: string; color: string; img?: string | null; tile?: string; tip?: { item?: Item; officer?: Officer; imgUrl?: string | null; vs?: Item | null } }
function ChangeRow({ cur, next, onHover }: { cur: Side | null | false; next: Side | null | false; onHover: (t: TipState | null) => void }) {
  return (
    <div className="chg-row">
      <Cell side={cur || null} placeholder="— (added)" onHover={onHover} />
      <span className="chg-arrow">→</span>
      <Cell side={next || null} placeholder="— (removed)" onHover={onHover} />
    </div>
  );
}
function Cell({ side, placeholder, onHover }: { side: Side | null; placeholder: string; onHover: (t: TipState | null) => void }) {
  if (!side) return <span className="chg-cell dim">{placeholder}</span>;
  // enter/leave only — the tips follow the cursor themselves (see useCursorTip), so a move doesn't
  // re-render the summary.
  const hov = side.tip
    ? {
      onMouseEnter: (e: MouseEvent) => onHover({ ...side.tip!, x: e.clientX, y: e.clientY }),
      onMouseLeave: () => onHover(null),
    }
    : {};
  return (
    <span className="chg-cell" {...hov}>
      {/* The item's own icon wins. `tile` is a flat booster-TYPE colour and used to take precedence, so booster
          rows showed a coloured square where every other row showed art — and the type is already in the name
          ("Combat R-Booster"). It stays as the fallback for an item whose icon is missing. */}
      {side.img
        ? <span className="chg-portrait" style={{ borderColor: side.color }}><span className="portrait-img" style={{ backgroundImage: `url("${side.img}")` }} /></span>
        : side.tile
          ? <span className="chg-tile" style={{ background: side.tile }} />
          : <span className="chg-portrait" style={{ borderColor: side.color }} />}
      <span style={{ color: side.color }}>{side.label}</span>
    </span>
  );
}

// Compact officer tooltip (game-style card) for the change rows.
function OfficerTip({ o, x, y, portraitUrl }: { o: Officer; x: number; y: number; portraitUrl: (g: string | null) => string | null }) {
  // Same cursor tracking as the item tip: measured + clamped in the DOM, no re-render per move.
  const { ref, style } = useCursorTip(x, y);
  const pu = portraitUrl(o.guid);
  const skills = (o.potential ?? []).slice(0, 10);
  return (
    <div className="git" ref={ref} style={style}>
      <div className="git-top">
        <div>
          <div className="git-cls">{o.profession}</div>
          <div className="git-name" style={{ color: RARITY_COLOR[o.rarity] ?? "#cfcfcf" }}>{o.name}</div>
          {o.callsign && <div className="git-mfr">“{o.callsign}”</div>}
        </div>
        <div className="git-lvl">Lv {o.level}</div>
      </div>
      {pu && <span className="git-img" style={{ backgroundImage: `url("${pu}")` }} />}
      {o.bonusValue ? <div className="git-main">+{(o.bonusValue * 100).toFixed(1)}% {o.chosenBonus}</div> : null}
      {skills.length > 0 && <div className="git-subs">{skills.map((s, i) => <div key={i} className="git-sub">{s.name}</div>)}</div>}
    </div>
  );
}

