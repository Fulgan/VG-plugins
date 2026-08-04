import { useCallback, useMemo, useState } from "react";
import { api, ApiError, type Conn } from "./api";
import type { ApplyResult } from "./types";

/** One recorded action. NOT `types.LogEntry`, which is the GAME log ({t, source, text}) — a different thing. */
export interface ActionLogEntry { t: string; action: string; req: string[]; res: string; pt?: string | null; ship?: string | null }
import type { OfficerBuilder } from "./OfficersTab";
import type { BoosterBuilder } from "./BoostersTab";
import type { GearBuilder } from "./GearTab";
import { load, save, LOG_KEY } from "./storage";

// Applying is the app's ONE mutation path, and it is now offered from four screens (Officers, Boosters, Ship
// gear, Summary). So it gets one owner, mounted once in App and handed down — not a copy per tab.
//
// The reason is not tidiness: `busy`, the last message and the action LOG are all single-valued. Two tabs each
// holding their own would show contradictory state, and two log lists writing the same localStorage key would
// silently drop each other's entries. Hoisted here, the tabs render the same truth and only choose which SECTION
// they apply.

const loadLog = () => load<ActionLogEntry[]>(LOG_KEY, []); // LOG_KEY lives in storage.ts — evicted on a full quota
const saveLog = (l: ActionLogEntry[]) => save(LOG_KEY, l);

// Format an apply result into a status line (+ stale note).
function note(r: ApplyResult, label: string): string {
  const n = r.changed ?? 0;
  const stale = r.stale ? ` ${r.stale} stale (already in place).` : "";
  return `Applied ${n} ${label}${n === 1 ? "" : "s"}.${stale}`;
}
// The log line for an apply. Reports `error` first: a failed apply that logged only its counts read as a
// successful no-op.
function fmtApply(r: ApplyResult): string {
  if (r.error) return `ERROR: ${r.error}`;
  return `applied=${r.applied ?? "?"} changed=${r.changed} stale=${r.stale ?? 0}${r.prior !== undefined ? ` prior=${r.prior}` : ""}`;
}

export interface ApplyApi {
  busy: boolean;
  msg: { ok: boolean; text: string } | null;
  /** Why applying is impossible here, or null when it is allowed. Same sentence everywhere it is shown. */
  cannotApply: string | null;
  /** `busy || cannotApply` — the disabled condition every apply button shares. */
  gate: boolean;
  // WHICH gate, so the UI can avoid restating what other banners already say. Undocked is announced app-wide and
  // by each tab; a missing hangar is not announced anywhere else, so only that one needs its own bar.
  gateReason: "undocked" | "no-hangar" | null;
  counts: { officers: number; boosters: number; gear: number; total: number };
  applyOfficers: () => void;
  applyBoosters: () => void;
  applyGear: () => void;
  applyAll: () => void;
  undo: () => void;
  /** For the Summary tab's action log panel. */
  log: ActionLogEntry[];
  clearLog: () => void;
  addLog: (action: string, req: string[], res: string) => void;
  /** So a caller can report its OWN validation failure through the same banner. */
  setMsg: (m: { ok: boolean; text: string } | null) => void;
  /** Ship the actions run against, as recorded on each log entry. */
  shipName: string | null;
  run: (fn: () => Promise<string>) => Promise<void>;
}

export function useApply({
  officer, boosters, gear, conn, crewSupported, docked, hasHangar, currentShipGuid, playthrough, onChanged,
}: {
  officer: OfficerBuilder;
  boosters: BoosterBuilder;
  gear: GearBuilder;
  conn: Conn;
  crewSupported: boolean;
  docked: boolean;
  hasHangar: boolean;
  currentShipGuid: string | null;
  playthrough: string | null;
  onChanged: () => void;
}): ApplyApi {
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [log, setLog] = useState<ActionLogEntry[]>(loadLog);

  // Ship the actions run against: the player's own ship name from the loadout DTO, with the officer builder's
  // ship as a fallback. Recorded on every log entry.
  const shipName = boosters.loadout?.name ?? officer.ship?.name ?? null;
  const addLog = useCallback((action: string, req: string[], res: string) => {
    setLog((prev) => {
      const next = [{ t: new Date().toLocaleTimeString(), action, req, res, pt: playthrough ?? null, ship: shipName }, ...prev].slice(0, 80);
      saveLog(next); return next;
    });
  }, [playthrough, shipName]);
  const run = useCallback(async (fn: () => Promise<string>) => {
    setBusy(true); setMsg(null);
    try { setMsg({ ok: true, text: await fn() }); onChanged(); }
    catch (e) { setMsg({ ok: false, text: e instanceof ApiError ? e.message : String(e) }); }
    finally { setBusy(false); }
  }, [onChanged]);

  // Officers apply to the ship they were crewed for, and only when that is the one being flown.
  const oShip = officer.ship;
  const officerOnCurrent = crewSupported && !!oShip && oShip.guid === currentShipGuid;
  const officerPayload = useMemo(
    () => (crewSupported ? (officer.result?.chosen ?? []).map((o, i) => ({ slot: i, guid: o.guid })) : []),
    [crewSupported, officer.result]);
  const boosterPayload = boosters.applyPayload;
  const gearPayload = gear.payload;

  const oName = (g: string) => officer.officers.find((o) => o.guid === g)?.name ?? g.slice(0, 8);
  // Snapshot of what each booster slot holds right now, logged with every apply so the state change between two
  // clicks is visible afterwards.
  const equippedNow = () => `now[${boosters.equippedBySlot.map((b, i) => `${i}:${b ? b.name : "—"}`).join(" ")}]`;
  const officerReq = () => officerPayload.map((p) => `slot ${p.slot} ← ${oName(p.guid)}`);
  const boosterReq = () => [equippedNow(), ...boosterPayload.map((p) => `#${p.slot} ← ${p.name} L${p.level} [${p.store}:${p.key}]`)];
  const gearReq = () => gear.changes.map((c) => `${c.kind} ${c.label} ← ${c.next.name} [${c.next.location}:${c.next.key}]`);

  // How many officers actually MOVE: a pure slot swap is not a change, so it is the larger of joins and leaves.
  const officerCount = useMemo(() => {
    if (!officerOnCurrent) return 0;
    const assigned = new Set((oShip?.assigned ?? []).filter((g): g is string => !!g));
    const chosen = new Set((officer.result?.chosen ?? []).map((o) => o.guid));
    const join = (officer.result?.chosen ?? []).filter((o) => !assigned.has(o.guid)).length;
    const leave = officer.officers.filter((o) => assigned.has(o.guid) && !chosen.has(o.guid)).length;
    return Math.max(join, leave);
  }, [officerOnCurrent, oShip, officer.result, officer.officers]);

  const counts = {
    officers: officerCount,
    boosters: boosterPayload.length,
    gear: gear.changes.length,
    total: officerCount + boosterPayload.length + gear.changes.length,
  };

  const gateReason: "undocked" | "no-hangar" | null = !docked ? "undocked" : !hasHangar ? "no-hangar" : null;
  const cannotApply = gateReason === "undocked" ? "Dock to apply."
    : gateReason === "no-hangar" ? "No personal hangar at this station — dock somewhere with one to refit."
    : null;

  const applyOfficers = () => void run(async () => {
    const r = await api.loadoutApply(conn, { officers: officerPayload });
    addLog("apply officers", officerReq(), fmtApply(r));
    return note(r, "officer");
  });
  const applyBoosters = () => void run(async () => {
    const r = await api.loadoutApply(conn, { slots: boosterPayload });
    addLog("apply boosters", boosterReq(), fmtApply(r));
    return note(r, "booster");
  });
  const applyGear = () => void run(async () => {
    const r = await api.loadoutApply(conn, { slots: gearPayload });
    addLog("apply gear", gearReq(), fmtApply(r));
    return note(r, "gear change");
  });
  const applyAll = () => void run(async () => {
    const r = await api.loadoutApply(conn, {
      officers: officerOnCurrent ? officerPayload : [],
      slots: [...boosterPayload, ...gearPayload],
    });
    addLog("apply all", [...(officerOnCurrent ? officerReq() : []), ...boosterReq(), ...gearReq()], fmtApply(r));
    return note(r, "change");
  });
  const undo = () => void run(async () => {
    const r = await api.loadoutUndo(conn);
    addLog("undo", [], `restored=${r.restored}`);
    return `Undo restored ${r.restored} slot(s).`;
  });

  return {
    busy, msg, cannotApply, gateReason, gate: busy || !!cannotApply, counts,
    applyOfficers, applyBoosters, applyGear, applyAll, undo,
    log, clearLog: () => { setLog([]); saveLog([]); }, addLog, run, setMsg, shipName,
  };
}
