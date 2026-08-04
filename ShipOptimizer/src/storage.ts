import { api, loadConn } from "./api";

// Persistence for the web client. The BRIDGE is authoritative (it stores this per playthrough, so your
// preferences follow the save rather than the browser); localStorage is a write-through cache in front
// of it, which is what keeps `load` synchronous:
//
//   boot    → hydrateFromBridge() overwrites the local cache, THEN the app renders (main.tsx), so every
//             `useState(load(...))` initializer already sees the server's values — no async hydration,
//             no first-render flash, and no write-before-hydrate race overwriting server data.
//   save    → local write (instant, and the offline fallback) + a coalesced push to the bridge.
//   offline → everything still works against the cache; the next successful save/hydrate reconciles.
//
// `load` returns the fallback on a missing key or any parse/access error; `save` reports failures
// instead of silently dropping them (see StorageFailure).

// The two DISPOSABLE keys: pure caches, rebuilt from the bridge on the next docked refresh. When the
// quota is hit these get sacrificed so the small, irreplaceable preference keys can still be written.
// Owned here (rather than by their consumers) so the eviction order and the config export agree.
export const SNAPSHOT_KEY = "shipoptimizer.snapshot";
export const LOG_KEY = "shipoptimizer.summaryLog";
// Dragged widths of the grid's text columns, keyed by column id. Per browser, not per playthrough: it answers
// "how wide is my screen", which no save can know.
export const COL_W_KEY = "shipoptimizer.colWidths";

// Keys that must NEVER leave the browser: the connection settings are how we reach the bridge in the
// first place (a bad round-trip would lock you out), and the station/playthrough markers exist purely
// to invalidate the LOCAL cache.
const LOCAL_ONLY = new Set(["shipoptimizer.conn", "shipoptimizer.station", "shipoptimizer.playthrough"]);

// Keys stored per SHIP bridge-side. Only the snapshot needs it: every other per-ship preference already
// carries the ship dimension inside its value (FiltersByShip, prio/forced/profile keyed by guid) or in
// the key itself (activePreset.<guid>), so they're playthrough-wide entries and a ship switch needs no
// re-hydration.
const SHIP_SCOPED = new Set([SNAPSHOT_KEY]);
const PREFIX = "shipoptimizer.";

export interface StorageFailure {
  key: string;
  message: string;
  quota: boolean;     // true = out of space, as opposed to storage being unavailable/blocked
  reclaimed: boolean; // true = the disposable caches were dropped trying to make room
}

// A swallowed failure means a full quota silently loses preference writes with no signal anywhere, so
// consumers subscribe and surface it instead.
type Listener = (f: StorageFailure) => void;
const listeners = new Set<Listener>();
let lastFailure: StorageFailure | null = null;

export function onStorageFailure(fn: Listener): () => void {
  listeners.add(fn);
  if (lastFailure) fn(lastFailure); // a late subscriber still learns about an earlier failure
  return () => { listeners.delete(fn); };
}

export const clearStorageFailure = () => { lastFailure = null; };

function report(f: StorageFailure): void {
  lastFailure = f;
  for (const fn of listeners) { try { fn(f); } catch { /* a listener must not break persistence */ } }
}

// Browsers signal a full store differently: standard name, Firefox's legacy name, or a bare code 22.
function isQuota(e: unknown): boolean {
  const err = e as { name?: string; code?: number } | null;
  return err?.name === "QuotaExceededError" || err?.name === "NS_ERROR_DOM_QUOTA_REACHED" || err?.code === 22;
}

export function load<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw != null ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}

// Drop the disposable caches to free space. Returns whether anything was actually removed, so the write
// is only retried when the store really did shrink.
function reclaim(exceptKey: string): boolean {
  let freed = false;
  for (const k of [SNAPSHOT_KEY, LOG_KEY]) {
    if (k === exceptKey) continue; // never evict the key we're trying to write
    try {
      if (localStorage.getItem(k) != null) { localStorage.removeItem(k); freed = true; }
    } catch { /* already in the error path */ }
  }
  return freed;
}

// Returns whether the value was stored. On a full quota the disposable caches are evicted and the write
// retried once, so preferences survive at the cost of a cache that rebuilds itself on the next refresh.
export function save(key: string, value: unknown): boolean {
  let raw: string;
  try {
    raw = JSON.stringify(value);
  } catch (e) {
    report({ key, message: `could not serialize: ${(e as Error).message}`, quota: false, reclaimed: false });
    return false;
  }
  queuePush(key, raw); // bridge-side copy — independent of whether the local cache write succeeds
  return writeLocal(key, raw);
}

// Local cache write with the quota handling. Used by `save` and by hydration (which must not push the
// server's own values straight back at it).
function writeLocal(key: string, raw: string): boolean {
  try {
    localStorage.setItem(key, raw);
    return true;
  } catch (e) {
    if (!isQuota(e)) {
      report({ key, message: (e as Error).message || "storage unavailable", quota: false, reclaimed: false });
      return false;
    }
    const freed = reclaim(key);
    if (freed) {
      try { localStorage.setItem(key, raw); return true; } catch { /* still full — fall through */ }
    }
    report({ key, message: `browser storage is full — "${key}" was not saved`, quota: true, reclaimed: freed });
    return false;
  }
}

// ---- bridge sync ----

const PUSH_DELAY_MS = 400;      // coalesce bursts (a refresh writes snapshot + markers back to back)
const PUSH_RETRY_MAX_MS = 30000; // backoff ceiling while the bridge refuses writes
const HYDRATE_TIMEOUT_MS = 1500; // never let a dead bridge hold up the first render

const pending = new Map<string, string>();
const lastPushed = new Map<string, string>(); // what the bridge already has, to skip redundant POSTs
let pushTimer: ReturnType<typeof setTimeout> | null = null;
let retryDelay = PUSH_DELAY_MS;

function queuePush(key: string, raw: string): void {
  if (LOCAL_ONLY.has(key) || !key.startsWith(PREFIX)) return;
  if (lastPushed.get(key) === raw) return; // unchanged — the snapshot alone is ~800 KB per POST
  pending.set(key, raw);
  schedulePush(PUSH_DELAY_MS);
}

function schedulePush(delay: number): void {
  if (pushTimer != null) return;
  pushTimer = setTimeout(() => { pushTimer = null; void flushPush(); }, delay);
}

// Push the queued entries. Ship-scoped and playthrough-scoped keys go in separate requests because the
// scope is a property of the request, not of the entry — and each is sent independently so one failing
// can't suppress the other.
//
// A failed push RE-QUEUES its entries and retries with backoff. Dropping them was wrong: at boot the
// bridge is often up before the save is loaded, and it (correctly) rejects writes with no playthrough —
// which silently threw away the whole localStorage migration.
async function flushPush(): Promise<void> {
  if (!pending.size) return;
  const perShip: Record<string, string> = {};
  const perPt: Record<string, string> = {};
  for (const [k, v] of pending) (SHIP_SCOPED.has(k) ? perShip : perPt)[k] = v;
  pending.clear();
  const conn = loadConn();
  let failed = false;
  for (const [entries, perShipScope] of [[perPt, false], [perShip, true]] as [Record<string, string>, boolean][]) {
    if (!Object.keys(entries).length) continue;
    try {
      await api.clientStatePut(conn, entries, perShipScope);
      for (const [k, v] of Object.entries(entries)) lastPushed.set(k, v);
    } catch {
      failed = true;
      // Re-queue, but never over a newer value queued while this request was in flight.
      for (const [k, v] of Object.entries(entries)) if (!pending.has(k)) pending.set(k, v);
    }
  }
  if (failed && pending.size) {
    schedulePush(retryDelay);
    retryDelay = Math.min(retryDelay * 2, PUSH_RETRY_MAX_MS);
  } else {
    retryDelay = PUSH_DELAY_MS;
  }
}

// Overwrite the local cache from the bridge. MUST be awaited before the app renders, so the synchronous
// `load` calls in state initializers see server values. On a first run against a bridge that has nothing
// stored yet, the existing local keys are uploaded instead (migration off localStorage).
export async function hydrateFromBridge(): Promise<void> {
  const conn = loadConn();
  try {
    const res = await Promise.race([
      api.clientStateGet(conn),
      new Promise<never>((_, rej) => setTimeout(() => rej(new Error("timeout")), HYDRATE_TIMEOUT_MS)),
    ]);
    const entries = res.entries ?? {};
    const keys = Object.keys(entries).filter((k) => k.startsWith(PREFIX) && !LOCAL_ONLY.has(k));
    for (const k of keys) {
      writeLocal(k, entries[k]);
      lastPushed.set(k, entries[k]); // already on the bridge — don't push it straight back
    }
  } catch { /* bridge unreachable or serving an older build — run off the local cache */ }
}

// Drop every cached preference, keeping only the keys that address the bridge itself. Called when the
// playthrough changes: settings belong to a SAVE, and a value left over from another one is not a
// preference but a stranger's. It matters most for the sell rules, where inheriting them silently
// re-arms a list built around what a different, richer character considered scrap — and it defeats the
// empty-list-sells-nothing guarantee a new save is entitled to.
export function clearCachedPrefs(): void {
  try {
    const doomed: string[] = [];
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k && k.startsWith(PREFIX) && !LOCAL_ONLY.has(k)) doomed.push(k);
    }
    for (const k of doomed) localStorage.removeItem(k);
  } catch { /* storage blocked — nothing cached to clear */ }
  lastPushed.clear();
}

// A playthrough the bridge has no entry for gets DEFAULTS, never this browser's leftovers. Uploading the
// cache to fill the gap would make every new save inherit the last one's settings, which is the opposite
// of storing them per playthrough in the first place.
