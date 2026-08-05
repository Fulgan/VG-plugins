import type { ApplyRequest, ApplyResult, CatalogTypes, Galaxy, Inventories, Item, LedgerDto, Loadout, LoadoutPresetInfo, Logs, Materials, Officers, Recruits, Reputation, ShipLayout, Ships, Shops, StandingLog, Status, UndoResult, Vitals } from "./types";

// Connection settings, persisted to localStorage.
export interface Conn {
  host: string;
  port: string;
  token: string; // optional; sent only when non-empty
}

const KEY = "shipoptimizer.conn";

// Where to look for the bridge when nothing has been stored yet.
//
// In a PRODUCTION build the shell was served BY the bridge, so its own origin is the answer — and on a phone
// it is the only possible one: a hardcoded 127.0.0.1 would aim every request at the phone's own loopback,
// where nothing is listening. Under Vite (`npm run dev`) the shell comes from the dev server on :5173
// instead, so `location` is the wrong answer there and the loopback default is right.
function defaultConn(): Conn {
  if (import.meta.env.DEV) return { host: "127.0.0.1", port: "8777", token: "" };
  return { host: location.hostname || "127.0.0.1", port: location.port || "8777", token: "" };
}

export function loadConn(): Conn {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) return { ...defaultConn(), ...JSON.parse(raw) };
  } catch {
    /* ignore */
  }
  return defaultConn();
}

export function saveConn(c: Conn) {
  localStorage.setItem(KEY, JSON.stringify(c));
}

// An IPv6 literal has to be bracketed in a URL, and `location.hostname` reports it inconsistently across
// browsers (some include the brackets, some don't) — so normalise rather than trust either form. Reaching the
// bridge over a mesh VPN by its IPv6 address is a real path: those tunnels hand out both families and phones
// often prefer v6.
export function hostForUrl(host: string): string {
  const bare = host.replace(/^\[|\]$/g, "");
  return bare.includes(":") ? `[${bare}]` : bare;
}

export function baseUrl(c: Conn) {
  return `http://${hostForUrl(c.host)}:${c.port}`;
}

// Game build the rendered art belongs to, folded into every image URL as part of its cache key. Sprites
// don't change within a build — but they can across one — so this is what lets the icons be cached hard
// (a day, immutable) without risking a game update serving a day of stale art: a new version means new
// URLs, and the old entries simply age out. Set once from /status; empty until then.
let assetVersion = "";
export const setAssetVersion = (v: string | null | undefined) => { assetVersion = v ?? ""; };

// Manual cache-buster, bumped by the Tools → "purge cached images" action and kept in localStorage.
// The version key covers the normal case (art changes with the build); this covers the exception — a beta
// hotfix that changes sprites without bumping the version string. There's no API to clear the browser's
// HTTP cache, so changing the URL is the only way to force a refetch.
const BUST_KEY = "shipoptimizer.imgBust";
let imgBust = "";
try { imgBust = localStorage.getItem(BUST_KEY) ?? ""; } catch { /* storage blocked */ }
export function bumpImageCacheBust(): string {
  imgBust = String((Number(imgBust) || 0) + 1);
  try { localStorage.setItem(BUST_KEY, imgBust); } catch { /* storage blocked — lasts for this session */ }
  return imgBust;
}
// Cache key for one asset: the build plus whatever identifies the asset itself. Null when there's
// nothing to key on, which makes the bridge fall back to a short cache policy.
const assetKey = (id?: string | null) => (id ? `${assetVersion}${imgBust ? "#" + imgBust : ""}:${id}` : null);
const qv = (key: string | null) => (key ? `&v=${encodeURIComponent(key)}` : "");

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
    // Network-level failure (bridge down, CORS blocked, etc.).
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
  // `fresh` bypasses the bridge's short cache. The cache exists because building this list holds a game frame
  // (thousands of armory rows, read one at a time through the game API), so an event burst must not pay for it
  // repeatedly — but a refresh the PLAYER asked for is exactly when a stale answer is not acceptable.
  inventories: (c: Conn, fresh = false) => get<Inventories>(c, "/inventories" + (fresh ? "?fresh=1" : "")),
  loadout: (c: Conn) => get<Loadout>(c, "/loadout"),
  ships: (c: Conn) => get<Ships>(c, "/ships"),
  // The station's stock. BUY-BACK IS OPT-IN, and at a playthrough's scale that is the difference between a
  // 200 KB read and a 10 MB one: selling an armory hands thousands of rows to the shop, and they would arrive
  // in every poll of a list read for what the STATION sells. The count comes back either way.
  shops: (c: Conn, buyback = false) => get<Shops>(c, "/shops" + (buyback ? "?buyback=1" : "")),
  officers: (c: Conn) => get<Officers>(c, "/officers"),
  recruits: (c: Conn) => get<Recruits>(c, "/recruits"),
  // `guid` selects any ship the player OWNS; omitted means the one being flown. This is the only route that
  // knows an EMPTY hardpoint's size — `/ships` reports fitted items, and an empty slot has no item to read one
  // off — so planning for a hull you are not in has to come through here.
  shipLayout: (c: Conn, guid?: string | null) =>
    get<ShipLayout>(c, `/ship/layout${guid ? `?guid=${encodeURIComponent(guid)}` : ""}`),
  // Hull/armor/shield/cargo for the vitals panel. Blocks the ship doesn't have are absent, not zeroed.
  vitals: (c: Conn) => get<Vitals>(c, "/ship/vitals"),
  // Pairing: trade a code shown on the PC for this device's own token. The ONE call that carries no token —
  // a phone that has never paired has none — so it is spelled out here rather than going through `send`.
  pairClaim: async (c: Conn, code: string, label: string) => {
    const res = await fetch(baseUrl(c) + "/pair/claim", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ code, label }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new ApiError(res.status, (data as { error?: string }).error ?? `pairing failed (${res.status})`);
    return data as { token: string; label: string };
  },
  // Faction standing on both ladders (reputation + conquest), with the perks each tier grants.
  reputation: (c: Conn) => get<Reputation>(c, "/reputation"),
  // Standing changes since `seq`. The bridge's buffer is bounded and starts empty on each game launch, so
  // the client keeps the long history and this only fetches the new tail.
  standingLog: (c: Conn, since = 0) => get<StandingLog>(c, `/reputation/log?since=${since}`),
  catalogTypes: (c: Conn) => get<CatalogTypes>(c, "/catalog/types"),
  log: (c: Conn) => get<Logs>(c, "/log"),
  // loadout transient (apply/undo/pending)
  loadoutApply: (c: Conn, body: ApplyRequest) => send<ApplyResult>(c, "POST", "/loadout/apply", body),
  loadoutUndo: (c: Conn) => send<UndoResult>(c, "POST", "/loadout/undo"),
  // Web-client state (preferences, action log, cached snapshot) persisted bridge-side, scoped to the
  // playthrough — so it follows the save instead of the browser. See storage.ts for the sync rules.
  clientStateGet: (c: Conn) => get<{ playthrough: string | null; shipGuid: string | null; entries: Record<string, string> }>(c, "/client/state"),
  clientStatePut: (c: Conn, entries: Record<string, string | null>, perShip: boolean) =>
    send<{ saved: number }>(c, "POST", "/client/state", { entries, ship: perShip }),
  // Buy from a station shop. `key` is the offer's slot handle and `shop` its facility id; the bridge
  // re-validates docked / not-ECHO / affordability / cargo space and performs the game's own purchase
  // flow, so the client never has to reason about money.
  // `key` is the offer's inventory SLOT, and shops reuse slots for different goods when they restock — so
  // the item we think we're buying travels with the request. The bridge refuses (409) if the slot now holds
  // something else, or costs something else, rather than silently buying the wrong thing.
  buy: (c: Conn, shop: string | null, key: number, count = 1, expect?: { name: string; cost: number; id?: string | null }) =>
    send<{ bought: number; spent: number; barter: boolean }>(c, "POST", "/buy",
      { shop, key, count, expectName: expect?.name, expectId: expect?.id, expectCost: expect?.cost }),
  // Sell from a store. `key` is the item's inventory SLOT, and a slot freed by an earlier sale is refillable
  // by a drop or a /move — so the name we believe we are selling travels with the request and the bridge
  // refuses with 409 rather than selling whatever now sits there. The sell list reviews a batch before it
  // spends, so every row's handle is older than the press by construction: `expectName` is not optional here
  // even though the endpoint allows it to be.
  sell: (c: Conn, store: string, key: number, count: number, expectName: string, expectId?: string | null) =>
    send<{ sold: number; credits: number }>(c, "POST", "/sell", { store, key, count, expectName, expectId }),
  // A whole reviewed list in ONE request. Selling row by row costs a round trip and a main-thread hop each,
  // and a hop is serviced once per frame — a long playthrough's armory is minutes of that, with the game
  // silent throughout. The bridge walks the list a chunk per frame and announces its progress in game.
  // A batch is not a transaction: `failures` names what was refused and the rest still sold.
  // `expectId` is the item's `identifier` — IDENTITY, where `expectName` is display text. They are not the
  // same claim: a booster's `displayName` is a localisation key and its `name` is the resolved text, so a guard
  // on the name alone refused every one of them (Hypercom).
  sellBatch: (c: Conn, items: { store: string; key: number; count: number; expectName: string; expectId?: string | null }[]) =>
    send<{
      sold: number; credits: number; failed: number;
      failures: { key: number; name: string | null; error: string }[];
      // Every refusal counted by reason — `failures` names only the first few, and a skip count without the
      // reasons is not something a player can act on.
      failureCounts?: Record<string, number>;
      // How many rows the station will sell BACK, and why the rest will not — a sale the station cannot undo
      // is a different decision from one it can, and the player only finds out afterwards.
      boughtBack?: number; buybackNote?: string | null;
    }>(c, "POST", "/sell", { items }),
  // Hire a recruit. The bridge re-checks docked / not-ECHO / affordability and finds the game's hire
  // method by reflection (the crew API moves between betas). dryRun reports without spending.
  hireOfficer: (c: Conn, guid: string, dryRun = false) =>
    send<{ officer: string; cost: number; credits: number; affordable: boolean; method: string | null; hired?: boolean; error?: string; dryRun?: boolean }>(
      c, "POST", "/officers/hire", { guid, dryRun }),
  // Galaxy map, fog-of-war filtered server-side. `fresh` bypasses the bridge's short TTL (use it for the
  // explicit dock/undock refresh); POIs for one system are fetched separately, they're most of the cost.
  galaxy: (c: Conn, fresh = false) => get<Galaxy>(c, "/galaxy" + (fresh ? "?fresh=1" : "")),
  galaxyPois: (c: Conn, systemGuid: string) => get<{ system: string; pois: unknown[] }>(c, "/galaxy?pois=" + encodeURIComponent(systemGuid)),
  // The three refresh cycles alone — the header strip polls this rather than `/galaxy`, which would carry the
  // whole galaxy to render three countdowns. Same figures, same `Clock` source.
  cycles: (c: Conn) => get<{
    shopRestock?: { nextIn?: number | null; interval?: number | null } | null;
    missionRestock?: { nextIn?: number | null; interval?: number | null; station?: string | null; fresh?: boolean | null } | null;
    conquest?: { tickIn?: number | null; tickDelay?: number | null } | null;
  }>(c, "/cycles"),
  // Everything you own and where it sits: ship cargo, global storage, and every visited station's material
  // storage. Readable without docking at each one, which is what makes a galaxy-wide answer possible.
  materials: (c: Conn, fresh = false) => get<Materials>(c, "/materials" + (fresh ? "?fresh=1" : "")),
  // Faction badge PNG — the game's own sprite (Faction.GetIcon), keyed by stable identifier, not the wiki.
  // An aspect's badge, from the game's own art. Cached hard on the asset key like other rendered sprites.
  aspectIconUrl: (c: Conn, id: string) =>
    baseUrl(c) + "/aspects/icon?id=" + encodeURIComponent(id) + qv(assetKey(id)) + (c.token ? `&token=${encodeURIComponent(c.token)}` : ""),
  // An item type's icon by IDENTIFIER, for an item the player need not own — a barter price names a currency
  // item that has no store slot, so itemIcon() cannot address it.
  itemIconByIdUrl: (c: Conn, id: string) =>
    baseUrl(c) + "/item/icon?id=" + encodeURIComponent(id) + qv(assetKey(id)) + (c.token ? `&token=${encodeURIComponent(c.token)}` : ""),
  factionIconUrl: (c: Conn, id: string) =>
    baseUrl(c) + "/factions/icon?id=" + encodeURIComponent(id) + qv(assetKey(id)) + (c.token ? `&token=${encodeURIComponent(c.token)}` : ""),
  // Persisted purchase/sale history. Scoped to the current playthrough bridge-side unless asked otherwise.
  ledger: (c: Conn, limit = 200, playthrough?: string) =>
    get<LedgerDto>(c, `/ledger?limit=${limit}` + (playthrough ? `&playthrough=${encodeURIComponent(playthrough)}` : "")),
  ledgerClear: (c: Conn, playthrough?: string) =>
    send<{ cleared: number }>(c, "POST", "/ledger/clear" + (playthrough ? `?playthrough=${encodeURIComponent(playthrough)}` : "")),
  // Drop the bridge's memoized PNGs (pair with bumpImageCacheBust for the browser's own copies).
  imagesPurge: (c: Conn) => send<{ purged: number }>(c, "POST", "/images/purge"),
  // Named loadout presets (gear fingerprints + officer guids), persisted bridge-side.
  presetsList: (c: Conn) => get<{ presets: LoadoutPresetInfo[] }>(c, "/loadout/presets"),
  // Orphaned presets (untagged legacy entries from before playthrough scoping) + claiming one.
  presetsOrphans: (c: Conn) => get<{ presets: LoadoutPresetInfo[] }>(c, "/loadout/presets/orphans"),
  presetClaim: (c: Conn, rawKey: string) => send<{ claimed: string }>(c, "POST", "/loadout/presets/claim", { rawKey }),
  // Portable loadout export/import (all presets for the current playthrough) + playthrough naming.
  presetsExport: (c: Conn) => get<{ playthrough: string | null; playthroughName: string | null; presets: unknown[] }>(c, "/loadout/presets/export"),
  presetsImport: (c: Conn, presets: unknown[]) => send<{ imported: number }>(c, "POST", "/loadout/presets/import", { presets }),
  playthroughSetName: (c: Conn, name: string) => send<{ playthrough: string | null; name: string | null }>(c, "POST", "/playthrough/name", { name }),
  presetSave: (c: Conn, name: string, settings?: string) => send<{ saved: string; gearSlots: number; officers: number }>(c, "POST", "/loadout/presets/save", { name, settings }),
  presetRestore: (c: Conn, name: string) => send<{ restored: string; changed: number; prior: boolean; settings?: string | null }>(c, "POST", "/loadout/presets/restore", { name }),
  presetDelete: (c: Conn, name: string) => send<{ deleted: boolean }>(c, "POST", "/loadout/presets/delete", { name }),
  // SSE URL (token via query, since EventSource can't set headers).
  eventsUrl: (c: Conn) => baseUrl(c) + "/events" + (c.token ? `?token=${encodeURIComponent(c.token)}` : ""),
  // Officer portrait PNG (token via query, since <img> can't set headers). null when no guid.
  portraitUrl: (c: Conn, guid: string | null) =>
    guid ? baseUrl(c) + "/officers/portrait?guid=" + encodeURIComponent(guid) + qv(assetKey(guid)) + (c.token ? `&token=${encodeURIComponent(c.token)}` : "") : null,
  // Portrait by icon id — for recruits (not in the owned roster, so guid won't resolve server-side).
  portraitByIcon: (c: Conn, icon: string | null) =>
    icon ? baseUrl(c) + "/officers/portrait?icon=" + encodeURIComponent(icon) + qv(assetKey(icon)) + (c.token ? `&token=${encodeURIComponent(c.token)}` : "") : null,
  // Item icon PNG by store + item handle (for gear-editor tooltips). null when no handle.
  // `v` is the icon's cache key — pass the item NAME (icons are per item type, not per roll). It lets
  // the bridge and the browser both keep the rendered PNG, while still changing the URL if the handle
  // later points at a different item. Without it every hover re-renders the sprite in-game.
  itemImageUrl: (c: Conn, store: string | null, key: number | null, v?: string | null) =>
    store && key != null ? baseUrl(c) + "/item/image?store=" + encodeURIComponent(store) + "&key=" + key + qv(assetKey(v)) + (c.token ? `&token=${encodeURIComponent(c.token)}` : "") : null,
  // Equipped item icon by ship slot key ("t:<i>" / "m:<EquipmentSlot>") — for currently-fitted gear (no store handle).
  itemImageBySlot: (c: Conn, slotKey: string | null, v?: string | null) =>
    slotKey ? baseUrl(c) + "/item/image?slot=" + encodeURIComponent(slotKey) + qv(assetKey(v)) + (c.token ? `&token=${encodeURIComponent(c.token)}` : "") : null,
  // Ship image rendered from the game's own sprite. It comes from the ship CLASS (surfaceSprite), so the
  // cache key is the class + build — not the guid, and not the current fit. null if no guid.
  shipImageUrl: (c: Conn, guid: string | null, shipType?: string | null) =>
    guid ? baseUrl(c) + "/ships/image?guid=" + encodeURIComponent(guid) + qv(assetKey(shipType)) + (c.token ? `&token=${encodeURIComponent(c.token)}` : "") : null,
};

// The icon URL for ANY item, from whichever handle it actually has: a store item resolves by store+key,
// an equipped one by its ship slot. Every icon should go through this — hand-picking the form at each
// call site is how equipped gear ended up iconless in the comparison tooltips.
export function itemIcon(c: Conn, it: Item | null | undefined): string | null {
  if (!it) return null;
  // "equipped" is a client-side marker for gear on the ship, not a real store — resolve those by slot.
  const viaStore = it.location && it.location !== "equipped"
    ? api.itemImageUrl(c, it.location, it.key ?? null, it.name)
    : null;
  return viaStore ?? api.itemImageBySlot(c, it.slotKey ?? null, it.name);
}


