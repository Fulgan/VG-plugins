import type { ApplyRequest, ApplyResult, CatalogTypes, Inventories, Loadout, LoadoutPresetInfo, Logs, Officers, Recruits, ShipLayout, Ships, Shops, Status, UndoResult } from "./types";

// Connection settings, persisted to localStorage.
export interface Conn {
  host: string;
  port: string;
  token: string; // optional; sent only when non-empty
}

const KEY = "shipoptimizer.conn";

export function loadConn(): Conn {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) return { host: "127.0.0.1", port: "8777", token: "", ...JSON.parse(raw) };
  } catch {
    /* ignore */
  }
  return { host: "127.0.0.1", port: "8777", token: "" };
}

export function saveConn(c: Conn) {
  localStorage.setItem(KEY, JSON.stringify(c));
}

export function baseUrl(c: Conn) {
  return `http://${c.host}:${c.port}`;
}

export class ApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

async function send<T>(c: Conn, method: string, path: string, body?: unknown): Promise<T> {
  const headers: Record<string, string> = {};
  if (c.token) headers["X-Auth-Token"] = c.token;
  if (body !== undefined) headers["Content-Type"] = "application/json";
  let resp: Response;
  try {
    resp = await fetch(baseUrl(c) + path, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined });
  } catch {
    // Network-level failure (bridge down, CORS blocked, etc.) — V4.
    throw new ApiError(0, "Cannot reach the bridge. Is the game running with Hypercom?");
  }
  const text = await resp.text();
  if (!resp.ok) {
    let msg = `HTTP ${resp.status}`;
    try {
      const j = JSON.parse(text);
      if (j?.error) msg = j.error;
    } catch {
      /* keep default */
    }
    throw new ApiError(resp.status, msg);
  }
  return JSON.parse(text) as T;
}

const get = <T>(c: Conn, path: string): Promise<T> => send<T>(c, "GET", path);

export const api = {
  status: (c: Conn) => get<Status>(c, "/status"),
  inventories: (c: Conn) => get<Inventories>(c, "/inventories"),
  loadout: (c: Conn) => get<Loadout>(c, "/loadout"),
  ships: (c: Conn) => get<Ships>(c, "/ships"),
  shops: (c: Conn) => get<Shops>(c, "/shops"),
  officers: (c: Conn) => get<Officers>(c, "/officers"),
  recruits: (c: Conn) => get<Recruits>(c, "/recruits"),
  shipLayout: (c: Conn) => get<ShipLayout>(c, "/ship/layout"),
  catalogTypes: (c: Conn) => get<CatalogTypes>(c, "/catalog/types"),
  log: (c: Conn) => get<Logs>(c, "/log"),
  // loadout transient (apply/undo/pending)
  loadoutApply: (c: Conn, body: ApplyRequest) => send<ApplyResult>(c, "POST", "/loadout/apply", body),
  loadoutUndo: (c: Conn) => send<UndoResult>(c, "POST", "/loadout/undo"),
  // Named loadout presets (gear fingerprints + officer guids), persisted bridge-side.
  presetsList: (c: Conn) => get<{ presets: LoadoutPresetInfo[] }>(c, "/loadout/presets"),
  // Orphaned presets (untagged legacy entries from before playthrough scoping) + claiming one.
  presetsOrphans: (c: Conn) => get<{ presets: LoadoutPresetInfo[] }>(c, "/loadout/presets/orphans"),
  presetClaim: (c: Conn, rawKey: string) => send<{ claimed: string }>(c, "POST", "/loadout/presets/claim", { rawKey }),
  // Portable loadout export/import (all presets for the current playthrough) + playthrough naming.
  presetsExport: (c: Conn) => get<{ playthrough: string | null; playthroughName: string | null; presets: unknown[] }>(c, "/loadout/presets/export"),
  presetsImport: (c: Conn, presets: unknown[]) => send<{ imported: number }>(c, "POST", "/loadout/presets/import", { presets }),
  playthroughSetName: (c: Conn, name: string) => send<{ playthrough: string | null; name: string | null }>(c, "POST", "/playthrough/name", { name }),
  presetSave: (c: Conn, name: string) => send<{ saved: string; gearSlots: number; officers: number }>(c, "POST", "/loadout/presets/save", { name }),
  presetRestore: (c: Conn, name: string) => send<{ restored: string; changed: number; prior: boolean }>(c, "POST", "/loadout/presets/restore", { name }),
  presetDelete: (c: Conn, name: string) => send<{ deleted: boolean }>(c, "POST", "/loadout/presets/delete", { name }),
  // SSE URL (token via query, since EventSource can't set headers).
  eventsUrl: (c: Conn) => baseUrl(c) + "/events" + (c.token ? `?token=${encodeURIComponent(c.token)}` : ""),
  // Officer portrait PNG (token via query, since <img> can't set headers). null when no guid.
  portraitUrl: (c: Conn, guid: string | null) =>
    guid ? baseUrl(c) + "/officers/portrait?guid=" + encodeURIComponent(guid) + (c.token ? `&token=${encodeURIComponent(c.token)}` : "") : null,
  // Portrait by icon id — for recruits (not in the owned roster, so guid won't resolve server-side).
  portraitByIcon: (c: Conn, icon: string | null) =>
    icon ? baseUrl(c) + "/officers/portrait?icon=" + encodeURIComponent(icon) + (c.token ? `&token=${encodeURIComponent(c.token)}` : "") : null,
  // Item icon PNG by store + item handle (for gear-editor tooltips). null when no handle.
  itemImageUrl: (c: Conn, store: string | null, key: number | null) =>
    store && key != null ? baseUrl(c) + "/item/image?store=" + encodeURIComponent(store) + "&key=" + key + (c.token ? `&token=${encodeURIComponent(c.token)}` : "") : null,
  // Equipped item icon by ship slot key ("t:<i>" / "m:<EquipmentSlot>") — for currently-fitted gear (no store handle).
  itemImageBySlot: (c: Conn, slotKey: string | null) =>
    slotKey ? baseUrl(c) + "/item/image?slot=" + encodeURIComponent(slotKey) + (c.token ? `&token=${encodeURIComponent(c.token)}` : "") : null,
  // Ship image rendered from the game's own sprite (the actual, current-fit ship). null if no guid.
  shipImageUrl: (c: Conn, guid: string | null) =>
    guid ? baseUrl(c) + "/ships/image?guid=" + encodeURIComponent(guid) + (c.token ? `&token=${encodeURIComponent(c.token)}` : "") : null,
};
