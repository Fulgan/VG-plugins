import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type MouseEvent } from "react";
import { ApiError, api, type Conn } from "./api";
import { boosterId, boosterTypeColor, boosterValue } from "./booster";
import type { OfficerBuilder } from "./OfficersTab";
import type { BoosterBuilder } from "./BoostersTab";
import { ItemTip, type GearBuilder } from "./GearTab";
import type { ApplyResult, Item, LoadoutPresetInfo, Officer } from "./types";

// Persistent action log (localStorage) — records every apply/undo: request payload + the ship's equipped
// state at click time + the raw response. Survives reloads so a mis-apply can be inspected after the fact.
interface LogEntry { t: string; action: string; req: string[]; res: string; pt?: string | null }
// Short, readable form of a playthrough fingerprint (drops the "gx-" tag, keeps 6 hex chars).
const shortPt = (pt?: string | null) => (pt ? pt.replace(/^gx-/, "").slice(0, 6) : "—");
const LOG_KEY = "shipoptimizer.summaryLog";
function loadLog(): LogEntry[] { try { return JSON.parse(localStorage.getItem(LOG_KEY) ?? "[]"); } catch { return []; } }
function saveLog(l: LogEntry[]) { try { localStorage.setItem(LOG_KEY, JSON.stringify(l)); } catch { /* quota */ } }
// Last saved/loaded preset + a fingerprint of the loadout at that time — to offer "Update" when it drifts.
const ACTIVE_KEY = "shipoptimizer.activePreset";
function loadActive(): { name: string; fp: string } | null { try { return JSON.parse(localStorage.getItem(ACTIVE_KEY) ?? "null"); } catch { return null; } }
function saveActive(a: { name: string; fp: string } | null) { try { localStorage.setItem(ACTIVE_KEY, JSON.stringify(a)); } catch { /* quota */ } }
function fmtApply(r: ApplyResult): string {
  if (r.error) return `ERROR: ${r.error}`;
  return `applied=${r.applied ?? "?"} changed=${r.changed} stale=${r.stale ?? 0}${r.prior !== undefined ? ` prior=${r.prior}` : ""}`;
}

// Pair leaving → joining into current→new rows (extra on either side pairs with a blank).
function pairs<T>(leave: T[], join: T[]): { cur: T | null; next: T | null }[] {
  const n = Math.max(leave.length, join.length);
  return Array.from({ length: n }, (_, i) => ({ cur: leave[i] ?? null, next: join[i] ?? null }));
}

// Format an apply result into a status line (+ stale note).
function note(r: ApplyResult, label: string): string {
  if (r.error) return r.error;
  let t = `Applied ${r.changed} ${label}${r.changed === 1 ? "" : "s"}.`;
  if (r.stale) t += ` ${r.stale} moved — skipped.`;
  return t;
}

const RARITY_COLOR: Record<string, string> = {
  Standard: "#cfcfcf", Enhanced: "#58c26b", HighGrade: "#4aa3ff", Exotic: "#c07bff", Legendary: "#ffb020",
};
const fmt = (n: number) => (n >= 1000 ? n.toLocaleString(undefined, { maximumFractionDigits: 0 }) : Number(n.toFixed(2)).toString());

// The apply hub: a current→new change list per category (officers, boosters), applied to the CURRENT
// ship via POST /loadout/apply (officers by guid, boosters by exact handle). Undo reverts the last apply.
export default function SummaryTab({
  officer, boosters, gear, portraitUrl, conn, crewSupported, docked, currentShipGuid, playthrough, playthroughName, reloadNonce, onChanged,
}: {
  officer: OfficerBuilder;
  boosters: BoosterBuilder;
  gear: GearBuilder;
  portraitUrl: (guid: string | null) => string | null;
  conn: Conn;
  crewSupported: boolean; // false on the release game (crew API renamed) — hide/mute all officer bits
  docked: boolean;
  currentShipGuid: string | null;
  playthrough?: string | null; // current playthrough fingerprint — tagged onto each action-log entry
  playthroughName?: string | null; // pretty name for the current playthrough (shown instead of the hash)
  reloadNonce?: number; // bumped by the parent (e.g. after claiming an orphan) to force a preset reload
  onChanged: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [tip, setTip] = useState<TipState | null>(null); // hover tooltip for change-row items/officers
  const [log, setLog] = useState<LogEntry[]>(loadLog);
  const addLog = useCallback((action: string, req: string[], res: string) => {
    setLog((prev) => {
      const next = [{ t: new Date().toLocaleTimeString(), action, req, res, pt: playthrough ?? null }, ...prev].slice(0, 80);
      saveLog(next); return next;
    });
  }, [playthrough]);
  const run = useCallback(async (fn: () => Promise<string>) => {
    setBusy(true); setMsg(null);
    try { setMsg({ ok: true, text: await fn() }); onChanged(); }
    catch (e) { setMsg({ ok: false, text: e instanceof ApiError ? e.message : String(e) }); }
    finally { setBusy(false); }
  }, [onChanged]);

  // ---- officer changes: SET diff (who joins / who leaves), ignoring pure slot swaps ----
  // Slot order doesn't matter for stacking, so an officer that stays on the ship in a different
  // slot is NOT a change. Pair the leavers with the joiners into current→new rows.
  const oShip = officer.ship;
  const oAssigned = new Set((oShip?.assigned ?? []).filter((g): g is string => !!g));
  const oChosen = new Set((officer.result?.chosen ?? []).map((o) => o.guid));
  const oJoin = crewSupported ? (officer.result?.chosen ?? []).filter((o) => !oAssigned.has(o.guid)) : [];
  const oLeave = crewSupported ? officer.officers.filter((o) => oAssigned.has(o.guid) && !oChosen.has(o.guid)) : [];
  const officerPairs = pairs<Officer>(oLeave, oJoin);
  const officerPayload = crewSupported ? (officer.result?.chosen ?? []).map((o, i) => ({ slot: i, guid: o.guid })) : [];
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
  const equippedNow = () => `now[${boosters.equippedBySlot.map((b, i) => `${i}:${b ? b.name : "—"}`).join(" ")}]`;
  const oName = (g: string) => officer.officers.find((o) => o.guid === g)?.name ?? g.slice(0, 8);
  const boosterReq = () => [equippedNow(), ...boosterPayload.map((p) => `#${p.slot} ← ${p.name} L${p.level} [${p.store}:${p.key}]`)];
  const officerReq = () => officerPayload.map((p) => `slot ${p.slot} ← ${oName(p.guid)}`);

  // ---- gear changes: from the shared gear builder (turret + module assignments) ----
  const gearPayload = gear.payload;
  const gearReq = () => gear.changes.map((c) => `${c.kind} ${c.label} ← ${c.next.name} [${c.next.location}:${c.next.key}]`);

  const applyOfficers = () => run(async () => {
    const r = await api.loadoutApply(conn, { officers: officerPayload });
    addLog("apply officers", officerReq(), fmtApply(r));
    return note(r, "officer");
  });
  const applyBoosters = () => run(async () => {
    const r = await api.loadoutApply(conn, { slots: boosterPayload });
    addLog("apply boosters", boosterReq(), fmtApply(r));
    return note(r, "booster");
  });
  const applyGear = () => run(async () => {
    const r = await api.loadoutApply(conn, { slots: gearPayload });
    addLog("apply gear", gearReq(), fmtApply(r));
    return note(r, "gear change");
  });
  const applyAll = () => run(async () => {
    const r = await api.loadoutApply(conn, { officers: officerOnCurrent ? officerPayload : [], slots: [...boosterPayload, ...gearPayload] });
    addLog("apply all", [...(officerOnCurrent ? officerReq() : []), ...boosterReq(), ...gearReq()], fmtApply(r));
    return note(r, "change");
  });
  const undo = () => run(async () => {
    const r = await api.loadoutUndo(conn);
    addLog("undo", [], `restored=${r.restored}`);
    return `Undo restored ${r.restored} slot(s).`;
  });

  // ---- saved loadout presets (bridge-persisted: gear fingerprints + officer guids) ----
  const [presets, setPresets] = useState<LoadoutPresetInfo[]>([]);
  // The bridge already returns only the current ship's loadouts (presets are keyed per ship), so no
  // client-side filtering — show what we get.
  const shownPresets = presets;
  const [presetName, setPresetName] = useState("");
  const [active, setActive] = useState<{ name: string; fp: string } | null>(loadActive); // last saved/loaded
  const captureNext = useRef<string | null>(null); // capture the baseline fp after a restore settles
  // Fingerprint of the currently-EQUIPPED loadout — turrets + modules + boosters + assigned officers.
  const fingerprint = useMemo(() => {
    const t = gear.hps.map((h) => `${h.index}:${h.equipped ? `${h.equipped.name}#${h.equipped.level}` : "-"}`).join("|");
    const m = gear.mslots.map((s) => `${s.slot}:${s.equipped ? `${s.equipped.name}#${s.equipped.level}` : "-"}`).join("|");
    const b = boosters.equippedBySlot.map((x, i) => `${i}:${x ? x.name : "-"}`).join("|");
    const o = (officer.ship?.assigned ?? []).map((g) => g ?? "-").join(",");
    return `${t}##${m}##${b}##${o}`;
  }, [gear, boosters, officer]);
  const setActiveP = (a: { name: string; fp: string } | null) => { setActive(a); saveActive(a); };
  useEffect(() => { // after a restore, once the loadout settles, adopt the new fingerprint as the baseline
    if (captureNext.current) { setActiveP({ name: captureNext.current, fp: fingerprint }); captureNext.current = null; }
  }, [fingerprint]);
  const dirty = !!active && !!active.fp && active.fp !== fingerprint;

  const loadPresets = useCallback(async () => { try { setPresets((await api.presetsList(conn)).presets); } catch { /* offline */ } }, [conn]);
  useEffect(() => { loadPresets(); }, [loadPresets, reloadNonce]);
  const doSave = (name: string) => run(async () => {
    const r = await api.presetSave(conn, name); addLog("save preset", [name], `gear=${r.gearSlots} officers=${r.officers}`);
    setPresetName(""); setActiveP({ name, fp: fingerprint }); await loadPresets(); return `Saved loadout "${r.saved}".`;
  });
  const savePreset = () => {
    const n = presetName.trim(); if (!n) { setMsg({ ok: false, text: "name the loadout first" }); return; }
    if (presets.some((p) => p.name === n) && !confirm(`Overwrite the saved loadout "${n}"?`)) return;
    doSave(n);
  };
  const updatePreset = (name: string) => { if (confirm(`Update "${name}" with the current loadout?`)) doSave(name); };
  const restorePreset = (name: string) => run(async () => {
    const r = await api.presetRestore(conn, name); addLog("restore preset", [name], `changed=${r.changed} prior=${r.prior}`);
    captureNext.current = name; return `Restored "${r.restored}" — ${r.changed} slot(s). Undo reverts it.`;
  });
  const deletePreset = (name: string) => { if (!confirm(`Delete the saved loadout "${name}"?`)) return; run(async () => { await api.presetDelete(conn, name); if (active?.name === name) setActiveP(null); await loadPresets(); return `Deleted "${name}".`; }); };

  const totalChanges = (officerOnCurrent ? officerPairs.length : 0) + boosterPairs.length + gear.changes.length;
  const gate = busy || !docked;

  return (
    <div className="summary">
      <div className="sum-head">
        <div className="panel-title">Loadout summary <span className="dim">— {boosters.loadout?.name ?? "ship"} · {totalChanges} change{totalChanges === 1 ? "" : "s"}</span></div>
        <div className="sum-actions">
          <button className="apply" disabled={gate || totalChanges === 0} title={!docked ? "Dock to apply." : "Apply every change below to the current ship."} onClick={applyAll}>Apply all</button>
          <button className="undo" disabled={gate} title="Restore the last applied change" onClick={undo}>Undo last</button>
        </div>
      </div>
      <p className="sum-note">Every proposed change vs your current loadout. Apply a section on its own or all at once — one additive transient via <code>POST /loadout/apply</code>; <code>/undo</code> reverts the last apply.</p>
      {!docked && <div className="sum-msg err">⚠ Undocked — dock to apply.</div>}
      {msg && <div className={msg.ok ? "sum-msg ok" : "sum-msg err"}>{msg.ok ? "✓" : "⚠"} {msg.text}</div>}

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
              {active?.name === p.name && dirty && <button className="apply sm" disabled={busy || !docked} title="Overwrite this loadout with the current gear + officers" onClick={() => updatePreset(p.name)}>Update</button>}
              <button className="apply sm" disabled={gate} title={!docked ? "Dock to restore." : "Restore onto the current ship (undoable)."} onClick={() => restorePreset(p.name)}>Restore</button>
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
              cur={r.cur && { label: `${r.cur.name} (+${fmt(boosterValue(r.cur))})`, color: RARITY_COLOR[r.cur.rarity] ?? "#cfcfcf", tile: boosterTypeColor(r.cur), tip: { item: r.cur, imgUrl: api.itemImageUrl(conn, r.cur.location ?? null, r.cur.key ?? null) } }}
              next={r.next && { label: `${r.next.name} (+${fmt(boosterValue(r.next))})`, color: RARITY_COLOR[r.next.rarity] ?? "#cfcfcf", tile: boosterTypeColor(r.next), tip: { item: r.next, imgUrl: api.itemImageUrl(conn, r.next.location ?? null, r.next.key ?? null) } }} />
          )) : <div className="sum-none">No booster changes.</div>}
        </div>

        {/* Turrets & modules (from the Gear tab) */}
        <div className="sum-card">
          <div className="sum-card-head">
            <div><b>Turrets &amp; modules</b> <span className="dim">— {gear.changes.length} change{gear.changes.length === 1 ? "" : "s"}</span></div>
            <button className="apply sm" disabled={gate || !gearPayload.length} title={!gearPayload.length ? "Pick gear in the Ship gear tab." : "Equip the selected gear."} onClick={applyGear}>Apply gear</button>
          </div>
          {gear.changes.length ? gear.changes.map((c, i) => (
            <ChangeRow key={i} onHover={setTip}
              cur={c.current && { label: c.current.name, color: RARITY_COLOR[c.current.rarity] ?? "#cfcfcf", img: api.itemImageBySlot(conn, c.key), tip: { item: c.current, imgUrl: api.itemImageBySlot(conn, c.key) } }}
              next={{ label: c.next.name, color: RARITY_COLOR[c.next.rarity] ?? "#cfcfcf", img: api.itemImageUrl(conn, c.next.location ?? null, c.next.key ?? null), tip: { item: c.next, imgUrl: api.itemImageUrl(conn, c.next.location ?? null, c.next.key ?? null) } }} />
          )) : <div className="sum-none">No gear changes — pick some in the Ship gear tab.</div>}
        </div>
      </div>

      {/* persistent action log — every apply/undo: request + equipped snapshot + raw response */}
      <div className="sum-log">
        <div className="sum-log-head">
          <span className="panel-title">Action log <span className="dim">— {log.length}, newest first (persists)</span>
            {playthrough && <span className="pt-chip" title={`Current playthrough: ${playthroughName ? `${playthroughName} (${playthrough})` : playthrough}`}>▷ {playthroughName || shortPt(playthrough)}</span>}</span>
          <button className="undo-suggest" disabled={!log.length} onClick={() => { setLog([]); saveLog([]); }}>Clear</button>
        </div>
        {log.length === 0
          ? <div className="sum-none">No actions yet — apply something and it's recorded here.</div>
          : log.map((e, i) => (
            <div key={i} className="log-row">
              <div className="log-line">
                <span className="log-t">{e.t}</span>
                <span className={`pt-chip${e.pt && playthrough && e.pt !== playthrough ? " other" : ""}`} title={e.pt ? `Playthrough: ${e.pt}` : "No playthrough recorded"}>{e.pt && e.pt === playthrough && playthroughName ? playthroughName : shortPt(e.pt)}</span>
                <span className="log-act">{e.action}</span><span className="log-res">{e.res}</span>
              </div>
              {e.req.length > 0 && <ul className="log-req">{e.req.map((l, j) => <li key={j}>{l}</li>)}</ul>}
            </div>
          ))}
      </div>

      {tip?.item && <ItemTip it={tip.item} x={tip.x} y={tip.y} conn={conn} imgUrl={tip.imgUrl} />}
      {tip?.officer && <OfficerTip o={tip.officer} x={tip.x} y={tip.y} portraitUrl={portraitUrl} />}
    </div>
  );
}

interface TipState { item?: Item; officer?: Officer; imgUrl?: string | null; x: number; y: number }
interface Side { label: string; color: string; img?: string | null; tile?: string; tip?: { item?: Item; officer?: Officer; imgUrl?: string | null } }
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
  const hov = side.tip
    ? {
      onMouseEnter: (e: MouseEvent) => onHover({ ...side.tip!, x: e.clientX, y: e.clientY }),
      onMouseMove: (e: MouseEvent) => onHover({ ...side.tip!, x: e.clientX, y: e.clientY }),
      onMouseLeave: () => onHover(null),
    }
    : {};
  return (
    <span className="chg-cell" {...hov}>
      {side.tile
        ? <span className="chg-tile" style={{ background: side.tile }} />
        : <span className="chg-portrait" style={{ borderColor: side.color }}>{side.img && <span className="portrait-img" style={{ backgroundImage: `url("${side.img}")` }} />}</span>}
      <span style={{ color: side.color }}>{side.label}</span>
    </span>
  );
}

// Compact officer tooltip (game-style card) for the change rows.
function OfficerTip({ o, x, y, portraitUrl }: { o: Officer; x: number; y: number; portraitUrl: (g: string | null) => string | null }) {
  const flip = x > window.innerWidth / 2;
  const style: CSSProperties = { position: "fixed", top: Math.min(y + 14, window.innerHeight - 80), left: flip ? undefined : x + 16, right: flip ? window.innerWidth - x + 16 : undefined };
  const pu = portraitUrl(o.guid);
  const skills = (o.potential ?? []).slice(0, 10);
  return (
    <div className="git" style={style}>
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
