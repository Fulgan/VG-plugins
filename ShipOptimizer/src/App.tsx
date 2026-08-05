import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { ApiError, api, loadConn, saveConn, setAssetVersion, bumpImageCacheBust, type Conn } from "./api";
import { useEvents } from "./useEvents";
import Price from "./Price";
import Ledger from "./Ledger";
import CycleTimers from "./CycleTimers";
import type { CritContext } from "./turretScore";
import type { ShipPools } from "./fleetDps";
import { background, poolsForShip, poolsFromStatus, poolsReconcile, rankSub, setRank, MIN_GAIN } from "./fleetDps";
import { isRoleStat } from "./roleStats";
import { kindOf } from "./itemKind";
import OfficersTab, { useOfficerBuilder, type BuilderShip } from "./OfficersTab";
import { evaluateRecruits, type RecruitOfficer } from "./officer";
import SummaryTab from "./SummaryTab";
import MapTab from "./MapTab";
import BoostersTab, { useBoosterBuilder } from "./BoostersTab";
import { isBooster } from "./booster";
import GearTab, { useGearBuilder, isTurret, type Ranking } from "./GearTab";
import { ItemTip } from "./ItemCard";
import { Notice } from "./Notice";
import { Modal, useConfirm } from "./Modal";
import SellList from "./SellList";
import type { Kind as SellKind, Rule as SellRule, SellListFile } from "./sellRules";
import type { CatalogTypes, Inventories, Item, Loadout, LoadoutPresetInfo, LogEntry, Officers, Recruits, ShipLayout, StatLine, Status, Vitals } from "./types";
import { num, subFmt, statVal, mainVal, brokeMsg, barterMsg, undockedMsg, buyExpect, priceLabel, affordTip, affordLine } from "./format";
import { useHoverIntent } from "./useCursorTip";
import { useWindowed } from "./useWindowed";
import TabBadge, { TabNote } from "./TabBadge";
import { gearTurretOpps, gearModuleOpps, gearBoosterOpps, type Opp } from "./opportunities";
import { useApply } from "./useApply";
import { load, save, onStorageFailure, clearStorageFailure, clearCachedPrefs, SNAPSHOT_KEY, LOG_KEY, COL_W_KEY, type StorageFailure } from "./storage";
import "./App.css";

type Tab = "inventory" | "officers" | "boosters" | "gear" | "summary" | "map";
const TABS: Tab[] = ["inventory", "officers", "boosters", "gear", "summary", "map"];
// Hash router: the active tab lives in the URL (#/gear) so a tab is directly addressable / bookmarkable
// and the browser back/forward buttons move between tabs. Unknown/empty hash → inventory.
const tabFromHash = (): Tab => {
  const h = location.hash.replace(/^#\/?/, "");
  return (TABS as string[]).includes(h) ? (h as Tab) : "inventory";
};

// Last docked snapshot, persisted so it survives reloads / jumps while undocked.
const SNAP_KEY = SNAPSHOT_KEY; // canonical name lives in storage.ts (it evicts this key on a full quota)
// What survives a reload, and deliberately NOT the item lists. Inventory and shop stock are UNBOUNDED — an
// armory of 85k items serialises past the whole origin quota, so caching them cannot succeed at the one size
// where it would matter, and the attempt costs a multi-megabyte stringify plus a push of the same payload at
// the bridge. They are refetched by the first refresh anyway, which is exactly what already happened whenever
// the quota evicted this key. What stays is small, bounded and worth having before the first paint: the
// loadout, the layout, and the pool reading they have to travel with.
interface Snap {
  loadout: Loadout | null; layout?: ShipLayout | null;
  // The last DOCKED pool reading, with the ship and station it belongs to. The layout above is cached the same
  // way, and the two have to travel together: score a cached docked battery against a live in-space pool and the
  // pool cannot absorb its own gear, so the background collapses to zero.
  pools?: ShipPools | null; poolsShip?: string | null; poolsStation?: string | null;
}

// Identity for change-detection (location + name + rarity + level), count excluded.
const flashKey = (it: Item) => `${it.location ?? ""}|${it.name}|${it.rarity}|${it.level}`;

// Full item identity for exact-match line select: type/size/level/aspect-slot count/main-stat value/
// rarity + the exact substat set (stat, amount, reroll flag). Two rows sharing this key are the same item;
// clicking one selects them all.
//
// Aspects are deliberately NOT in here. They are swappable at a station workshop (install/extract), so an
// aspect change is a change to the item's LOADOUT, not to which item it is — including them made a turret
// stop matching itself the moment you fitted an aspect to it. The aspect-SLOT COUNT stays: that is fixed
// at creation and part of the roll.
const exactKey = (it: Item) =>
  [
    it.type ?? "", it.size ?? "", it.level, it.aspectSlots ?? 0, it.rarity, it.mainStat?.amount ?? "",
    it.gameplayType ?? "", it.targetLayer ?? "", // surface vs core mining/salvage turrets are distinct
    (it.stats ?? []).map((s) => `${s.stat}=${s.amount}:${s.canReroll ? 1 : 0}`).sort().join(","),
  ].join("|");

const loadSnap = () => load<Snap | null>(SNAP_KEY, null);
const saveSnap = (s: Snap) => save(SNAP_KEY, s);

// Pill/badge toggles (like the aspect OR-filter) — a button per option, highlighted when "on".
function Pills({ options, isOn, onToggle }: { options: string[]; isOn: (o: string) => boolean; onToggle: (o: string) => void }) {
  return <>{options.map((o) => <button key={o} className={`asp-chip${isOn(o) ? " on" : ""}`} onClick={() => onToggle(o)}>{o}</button>)}</>;
}

// The client config (categories, per-ship gear filters, activity profile, connection) — every
// "shipoptimizer.*" key except the transient snapshot/log — as pretty JSON.
// The markers go too: they record WHICH SAVE this browser last saw, so importing someone else's would
// claim their playthrough and suppress the reset that gives a new save its own settings.
const CFG_SKIP = new Set<string>([SNAPSHOT_KEY, LOG_KEY, "shipoptimizer.playthrough", "shipoptimizer.station"]);

// Grid columns whose width the user may drag, each with the default the CSS also states, the cell class to
// measure for auto-size, and the custom property the width rides on. Text columns only: the rest carry one
// number and size themselves, and a grip on 15 headers would be noise.
const RESIZABLE: Record<string, { def: number; cls: string; prop: string }> = {
  __sub: { def: 280, cls: "c-sub", prop: "--sub-w" },
  __asp: { def: 200, cls: "c-asp", prop: "--asp-w" },
};
// Widest a column may be dragged or auto-sized to, and narrowest. A column dragged to nothing takes its own
// grip with it; one dragged past the viewport hides every number the table exists to show.
const COL_MIN = 90, COL_MAX = 900;
function configJson(): string {
  const cfg: Record<string, string> = {};
  for (let i = 0; i < localStorage.length; i++) {
    const k = localStorage.key(i);
    if (k && k.startsWith("shipoptimizer.") && !CFG_SKIP.has(k)) cfg[k] = localStorage.getItem(k) ?? "";
  }
  return JSON.stringify(cfg, null, 2);
}

// Validate a pasted/edited config before applying: must be an object of shipoptimizer.* string values;
// JSON-backed keys must parse and have the right shape. Returns the error list (empty = valid).
const JSON_KEYS = ["shipoptimizer.turretCategories", "shipoptimizer.gearFilters", "shipoptimizer.conn", "shipoptimizer.officerBuilder", "shipoptimizer.activityProfile",
                   "shipoptimizer.sellRules", "shipoptimizer.sellLists"];
function validateConfig(raw: string): { errors: string[]; cfg?: Record<string, string> } {
  let obj: unknown;
  try { obj = JSON.parse(raw); } catch (e) { return { errors: ["Not valid JSON: " + (e as Error).message] }; }
  if (typeof obj !== "object" || obj === null || Array.isArray(obj)) return { errors: ["Root must be a JSON object of key → value."] };
  const errors: string[] = [];
  const cfg = obj as Record<string, unknown>;
  for (const [k, v] of Object.entries(cfg)) {
    if (!k.startsWith("shipoptimizer.")) { errors.push(`unexpected key "${k}"`); continue; }
    if (typeof v !== "string") { errors.push(`"${k}" must be a string`); continue; }
    // Not JSON, but it decides the fate of everything no rule claims — the one value where a typo means
    // the whole inventory lands on the wrong side.
    if (k === "shipoptimizer.sellDefault" && v !== "keep" && v !== "sell" && v !== '"keep"' && v !== '"sell"') {
      errors.push('sellDefault must be "keep" or "sell"');
      continue;
    }
    const looksJson = v.trim().startsWith("{") || v.trim().startsWith("[");
    if (JSON_KEYS.includes(k) || looksJson) {
      let p: unknown;
      try { p = JSON.parse(v); } catch { errors.push(`"${k}" is not valid JSON`); continue; }
      const isObj = typeof p === "object" && p !== null && !Array.isArray(p);
      if (k === "shipoptimizer.turretCategories") {
        if (!isObj) errors.push("turretCategories must be an object");
        else for (const [cn, list] of Object.entries(p as Record<string, unknown>)) if (!Array.isArray(list) || list.some((x) => typeof x !== "string")) errors.push(`category "${cn}" must be a string array`);
      } else if (k === "shipoptimizer.conn") {
        if (!isObj) errors.push("conn must be an object");
        else for (const f of ["host", "port", "token"]) { const cv = (p as Record<string, unknown>)[f]; if (cv !== undefined && typeof cv !== "string") errors.push(`conn.${f} must be a string`); }
      } else if ((k === "shipoptimizer.gearFilters" || k === "shipoptimizer.officerBuilder") && !isObj) {
        errors.push(`${k.split(".")[1]} must be an object`);
      } else if (k === "shipoptimizer.sellRules") {
        // Checked harder than the rest because this one DECIDES WHAT GETS SOLD: a malformed rule that
        // survives import is a rule whose clauses silently do not apply, and an exception that fails to
        // match leaves its items on the default side.
        if (!Array.isArray(p)) errors.push("sellRules must be an array");
        else p.forEach((r, i) => {
          const rule = r as Record<string, unknown>;
          if (typeof rule?.id !== "string") errors.push(`sellRules[${i}] needs a string id`);
          if (typeof rule?.where !== "object" || rule.where === null) errors.push(`sellRules[${i}] needs a where object`);
          if (!Array.isArray(rule?.group)) errors.push(`sellRules[${i}].group must be an array`);
        });
      } else if (k === "shipoptimizer.sellLists" && !isObj) {
        errors.push("sellLists must be an object of name → list");
      }
    }
  }
  return { errors, cfg: errors.length === 0 ? (cfg as Record<string, string>) : undefined };
}

// Config popin: an editable text area preloaded with the current config; copy/paste to move it around,
// save/load a file, or Apply to write it back and reload. Validated before applying.
function ConfigDialog({ onClose }: { onClose: () => void }) {
  const [text, setText] = useState(configJson);
  const [msg, setMsg] = useState("");
  const copy = () => navigator.clipboard?.writeText(text).then(() => setMsg("Copied to clipboard.")).catch(() => setMsg("Copy failed."));
  const paste = () => navigator.clipboard?.readText().then((t) => { setText(t); setMsg("Pasted from clipboard."); }).catch(() => setMsg("Paste failed (grant clipboard access)."));
  const save = () => {
    const url = URL.createObjectURL(new Blob([text], { type: "application/json" }));
    const a = document.createElement("a");
    a.href = url; a.download = "shipoptimizer-config.json"; a.style.display = "none";
    document.body.appendChild(a); a.click(); a.remove(); // must be in the DOM or some browsers drop the download
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    setMsg("Saved shipoptimizer-config.json.");
  };
  const load = (f: File) => f.text().then(setText).catch(() => setMsg("Could not read file."));
  const validate = () => { const { errors } = validateConfig(text); setMsg(errors.length ? `✗ ${errors.length} problem(s): ${errors.slice(0, 4).join("; ")}${errors.length > 4 ? " …" : ""}` : "✓ Valid — safe to apply."); };
  const apply = () => {
    const { errors, cfg } = validateConfig(text);
    if (errors.length || !cfg) { setMsg(`✗ Not applied — ${errors.slice(0, 4).join("; ")}${errors.length > 4 ? " …" : ""}`); return; }
    for (const [k, v] of Object.entries(cfg)) localStorage.setItem(k, v);
    location.reload();
  };
  return (
    <Modal open onClose={onClose} label="Config">
      <>
        <div className="cfg-head"><b>Config <span className="dim">— categories, filters, activity, connection</span></b><button onClick={onClose}>×</button></div>
        <textarea className="cfg-ta" value={text} spellCheck={false} onChange={(e) => setText(e.target.value)} />
        <div className="cfg-actions">
          <button onClick={copy}>Copy</button>
          <button onClick={paste}>Paste</button>
          <button onClick={save}>Save file</button>
          <label className="import-cfg">Load file<input type="file" accept="application/json" style={{ display: "none" }} onChange={(e) => { const f = e.target.files?.[0]; if (f) load(f); }} /></label>
          <button onClick={validate}>Validate</button>
          <span className="spacer" />
          {msg && <span className="dim">{msg}</span>}
          <button className="apply" onClick={apply}>Apply &amp; reload</button>
        </div>
      </>
    </Modal>
  );
}

// Discreet Tools popin: maintenance that doesn't belong in the main flow — name the playthrough,
// export/import the playthrough's loadouts (portable JSON), and reclaim orphaned loadouts (presets from
// an older version / another game version, tied to no playthrough) by claiming them into this playthrough.
function ToolsDialog({ conn, playthrough, playthroughName, onClose, onChanged }: {
  conn: Conn; playthrough: string | null; playthroughName: string | null; onClose: () => void; onChanged: () => void;
}) {
  const [orphans, setOrphans] = useState<LoadoutPresetInfo[] | null>(null);
  const [msg, setMsg] = useState("");
  const [busy, setBusy] = useState(false);
  const [name, setName] = useState(playthroughName ?? "");
  const [loadoutsJson, setLoadoutsJson] = useState("");
  const reload = useCallback(() => {
    api.presetsOrphans(conn).then((r) => setOrphans(r.presets)).catch((e) => { setOrphans([]); setMsg(e instanceof Error ? e.message : String(e)); });
  }, [conn]);
  useEffect(() => { reload(); }, [reload]);
  const shortHash = playthrough ? playthrough.replace(/^gx-/, "").slice(0, 6) : "—";

  const wrap = (fn: () => Promise<string>) => { setBusy(true); setMsg(""); fn().then(setMsg).catch((e) => setMsg(e instanceof ApiError ? e.message : String(e))).finally(() => setBusy(false)); };
  const claim = (p: LoadoutPresetInfo) => wrap(async () => { await api.presetClaim(conn, p.rawKey ?? p.name); reload(); onChanged(); return `Claimed "${p.name}" onto the current ship.`; });
  const saveName = () => wrap(async () => { await api.playthroughSetName(conn, name); onChanged(); return name.trim() ? `Named this playthrough "${name.trim()}".` : "Cleared the playthrough name."; });
  const exportLoadouts = () => wrap(async () => { const r = await api.presetsExport(conn); setLoadoutsJson(JSON.stringify(r, null, 2)); return `Exported ${r.presets.length} loadout(s).`; });
  const importLoadouts = () => wrap(async () => {
    let parsed: unknown;
    try { parsed = JSON.parse(loadoutsJson); } catch { throw new Error("Not valid JSON."); }
    const arr = Array.isArray(parsed) ? parsed : (parsed as { presets?: unknown[] })?.presets;
    if (!Array.isArray(arr)) throw new Error('Expected an array, or an object with a "presets" array.');
    const r = await api.presetsImport(conn, arr); reload(); onChanged();
    return `Imported ${r.imported} loadout(s) into this playthrough.`;
  });
  const copy = () => navigator.clipboard?.writeText(loadoutsJson).then(() => setMsg("Copied to clipboard.")).catch(() => setMsg("Copy failed."));
  const paste = () => navigator.clipboard?.readText().then((t) => { setLoadoutsJson(t); setMsg("Pasted from clipboard."); }).catch(() => setMsg("Paste failed."));
  const saveFile = () => {
    const url = URL.createObjectURL(new Blob([loadoutsJson || "[]"], { type: "application/json" }));
    const a = document.createElement("a");
    a.href = url; a.download = `loadouts-${(name.trim() || shortHash).replace(/[^\w.-]+/g, "_")}.json`; a.style.display = "none";
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    setMsg("Saved loadouts file.");
  };
  const loadFile = (f: File) => f.text().then(setLoadoutsJson).catch(() => setMsg("Could not read file."));
  // Drop both copies of the rendered art: the bridge's memo, and the browser's (by bumping the cache-bust
  // token every image URL carries — there's no API to clear an HTTP cache). Reloading is the simplest way
  // to make every <img> pick up the new URLs at once.
  const purgeImages = () => wrap(async () => {
    const r = await api.imagesPurge(conn).catch(() => ({ purged: 0 })); // browser-side purge still worth doing
    bumpImageCacheBust();
    setTimeout(() => location.reload(), 400);
    return `Purged ${r.purged} cached image(s) — reloading…`;
  });
  return (
    <Modal open onClose={onClose} label="Tools">
      <>
        <div className="cfg-head"><b>Tools <span className="dim">— playthrough {name.trim() || shortHash}</span></b><button onClick={onClose}>×</button></div>
        <div className="tools-body">
          {/* Playthrough name */}
          <div><b>Playthrough name</b> <span className="dim">— cosmetic; the fingerprint <code>{shortHash}</code> stays the real key.</span></div>
          <div className="preset-save">
            <input value={name} disabled={!playthrough} placeholder={shortHash} onChange={(e) => setName(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") saveName(); }} />
            <button className="apply sm" disabled={busy || !playthrough} onClick={saveName}>Save name</button>
          </div>

          {/* Loadouts export / import */}
          <div style={{ marginTop: 12 }}><b>Loadouts export / import</b> <span className="dim">— this playthrough's saved loadouts as portable JSON. Import writes into the current playthrough.</span></div>
          <textarea className="cfg-ta" style={{ minHeight: 140 }} value={loadoutsJson} spellCheck={false} placeholder="Export to fill this, or paste/load a loadouts file to import…" onChange={(e) => setLoadoutsJson(e.target.value)} />
          <div className="cfg-actions">
            <button disabled={busy} onClick={exportLoadouts}>Export</button>
            <button disabled={busy} onClick={copy}>Copy</button>
            <button disabled={busy} onClick={paste}>Paste</button>
            <button disabled={busy} onClick={saveFile}>Save file</button>
            <label className="import-cfg">Load file<input type="file" accept="application/json" style={{ display: "none" }} onChange={(e) => { const f = e.target.files?.[0]; if (f) loadFile(f); }} /></label>
            <span className="spacer" />
            <button className="apply" disabled={busy || !playthrough || !loadoutsJson.trim()} onClick={importLoadouts}>Import</button>
          </div>

          {/* Orphaned loadouts */}
          <div style={{ marginTop: 12 }}><b>Orphaned loadouts</b> <span className="dim">— loadouts saved before per-ship tagging (or on another version), not tied to any ship. Claim one onto the current ship.</span></div>
          {orphans === null
            ? <div className="sum-none">Loading…</div>
            : orphans.length === 0
              ? <div className="sum-none">None — nothing to reclaim.</div>
              : orphans.map((p) => (
                <div key={p.name} className="preset-row">
                  <span className="preset-name">{p.name}</span>
                  <span className="dim">{p.ship} · {p.gearSlots} gear{p.officers ? ` · ${p.officers} officers` : ""}</span>
                  <span className="spacer" />
                  <button className="apply sm" disabled={busy} title="Attach this loadout to the current ship" onClick={() => claim(p)}>Claim</button>
                </div>
              ))}
          {/* Cached art */}
          <div style={{ marginTop: 12 }}><b>Cached images</b> <span className="dim">— icons, portraits and ship art are cached hard (a day) and keyed by game build. Purge if a beta changed the art without changing its version.</span></div>
          <div className="cfg-actions">
            <button disabled={busy} onClick={purgeImages}>Purge cached images</button>
            <span className="dim">reloads the page</span>
          </div>

          {msg && <div className="dim" style={{ marginTop: 8 }}>{msg}</div>}
        </div>
      </>
    </Modal>
  );
}

function cell(line: StatLine | undefined): string {
  if (!line) return "";
  if (line.multiplier && line.multiplier !== 1) return `×${Number(line.multiplier.toFixed(3))}`;
  return num(line.amount);
}

// Global-filter token: "Turret" / "Booster", or the specific module type for modules.
function globalToken(it: Item): string | null {
  const k = kindOf(it);
  return k === "Module" ? it.type ?? "Module" : k;
}

// Distinct stat names across items, ordered by how often they appear (most common first).
function statColumns(items: Item[]): string[] {
  const freq = new Map<string, number>();
  for (const it of items) for (const s of it.stats ?? []) freq.set(s.stat, (freq.get(s.stat) ?? 0) + 1);
  return [...freq.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map((e) => e[0]);
}

export default function App() {
  const [conn, setConn] = useState<Conn>(loadConn());
  const [status, setStatus] = useState<Status | null>(null);
  // Item lists start empty and arrive with the first refresh — they are not cached (see Snap).
  const [inv, setInv] = useState<Inventories | null>(null);
  const [loadout, setLoadout] = useState<Loadout | null>(() => loadSnap()?.loadout ?? null);
  const [shops, setShops] = useState<Item[]>([]);
  // What the station holds of the player's OWN sold stock, and whether the tab is asking for it. A REF as well
  // as state because `refresh` is called from callbacks that captured an older render, and the fetch must use
  // what the toggle says NOW rather than what it said when the callback was made.
  const [buybackCount, setBuybackCount] = useState(0);
  const [buybackShown, setBuybackShown] = useState(false);
  const showBuyback = useRef(false);
  // Deadline after which the cached shop list must not be bought from (see RestockClock). Deliberately not
  // persisted with the snapshot: a countdown restored from a previous session would be pure fiction.
  const [restock, setRestock] = useState<{ secs: number; fetched: number } | null>(null);
  // Hull / armor / shield totals, the game's own figures. Fetched here rather than inside the panel that shows
  // them: the gear tab projects them against a pending build, so they belong with the rest of the ship state.
  // A layer the ship lacks is ABSENT from the payload, not zeroed.
  const [vitals, setVitals] = useState<Vitals | null>(null);
  const [log, setLog] = useState<LogEntry[]>([]);
  const [stale, setStale] = useState(false);
  const [cfgOpen, setCfgOpen] = useState(false);
  const [toolsOpen, setToolsOpen] = useState(false);
  const [presetsNonce, setPresetsNonce] = useState(0); // bumped on claim → SummaryTab reloads its preset list
  // Persistence failures (full quota, storage blocked) — banner-worthy, since the alternative is
  // preferences quietly not saving.
  const [storeErr, setStoreErr] = useState<StorageFailure | null>(null);
  useEffect(() => onStorageFailure(setStoreErr), []);
  const [flashed, setFlashed] = useState<Set<string>>(new Set());
  const prevCounts = useRef<Map<string, number>>(new Map());
  const playthroughRef = useRef<string | null>(localStorage.getItem("shipoptimizer.playthrough"));
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [ledgerNonce, setLedgerNonce] = useState(0);
  const [tab, setTabState] = useState<Tab>(tabFromHash);
  const setTab = useCallback((t: Tab) => {
    setTabState(t);
    if (location.hash.replace(/^#\/?/, "") !== t) location.hash = "/" + t; // reflect into the URL
  }, []);
  useEffect(() => {
    const onHash = () => setTabState(tabFromHash());
    window.addEventListener("hashchange", onHash);
    if (!location.hash) location.hash = "/" + tabFromHash(); // seed the URL on first load
    return () => window.removeEventListener("hashchange", onHash);
  }, []);
  const [officers, setOfficers] = useState<Officers | null>(null);
  const [recruits, setRecruits] = useState<Recruits | null>(null);
  const [shipsAll, setShipsAll] = useState<Loadout[]>([]);
  const [layout, setLayout] = useState<ShipLayout | null>(() => loadSnap()?.layout ?? null);
  const [catTypes, setCatTypes] = useState<CatalogTypes | null>(null);

  // `fresh` is set only by a refresh the PLAYER asked for. The bridge caches the inventory for a few seconds
  // because building it holds a game frame, and an event burst must not pay that cost once per event — but a
  // refresh someone clicked is exactly when a stale answer is not acceptable.
  const refresh = useCallback(async (fresh = false) => {
    setLoading(true);
    setError(null);
    // Every buy/sell path already refreshes; bumping here re-reads the ledger with them rather than adding a
    // second callback to each transaction site.
    setLedgerNonce((n) => n + 1);
    try {
      const s = await api.status(conn);
      // Stamp the build onto every image URL before anything renders one: sprites are cached hard in the
      // browser, and the version in the key is what makes a game update fetch fresh art (see setAssetVersion).
      setAssetVersion(s.gameVersion);
      setStatus(s);
      // New playthrough → drop stale cached inventory/loadout/shops/layout (they belong to the old save).
      if (s.playthrough && s.playthrough !== playthroughRef.current) {
        const switched = !!playthroughRef.current;   // false on first boot: nothing to have carried over
        playthroughRef.current = s.playthrough;
        localStorage.setItem("shipoptimizer.playthrough", s.playthrough);
        localStorage.removeItem(SNAP_KEY);
        setInv(null); setLoadout(null); setShops([]); setLayout(null); setOfficers(null); setRecruits(null);
        // Preferences belong to the SAVE, and every one of them was read into component state at mount —
        // clearing the cache alone would leave the old save's rules live in memory. Reload so the boot
        // hydration re-reads this playthrough's own settings, or the defaults where it has none.
        if (switched) {
          clearCachedPrefs();
          location.reload();
          return;
        }
      }
      try {
        setLog((await api.log(conn)).entries); // global; always available
      } catch { /* optional */ }

      // Officers + all-ships are available undocked (no dock gate); officers gate on crewSupported.
      try {
        setShipsAll((await api.ships(conn)).ships);
        try { setCatTypes(await api.catalogTypes(conn)); } catch { /* optional */ }
      } catch { /* optional */ }
      if (s.crewSupported) {
        try { setOfficers(await api.officers(conn)); } catch { /* optional */ }
        // Recruits are docked-only (station Personnel Center). Clear when undocked.
        if (s.docked) { try { setRecruits(await api.recruits(conn)); } catch { /* optional */ } }
        else setRecruits(null);
      } else {
        setOfficers(null);
        setRecruits(null);
      }

      // Undocked: cargo is still live (loot/jettison/ammo), but armory/material/shop/loadout aren't.
      // Refresh the cargo store live, keep the rest from the last docked snapshot, mark stale.
      if (!s.docked) {
        setStale(true);
        try {
          const live = await api.inventories(conn, fresh); // cargo only when undocked
          const cargo = live.stores.filter((st) => st.id === "cargo");
          setInv((prev) => ({ stores: [...cargo, ...(prev?.stores ?? []).filter((st) => st.id !== "cargo")] }));
        } catch { /* keep snapshot */ }
        return;
      }
      setStale(false);

      // Docked-ness can change BETWEEN the status read above and these reads. When it does, the bridge answers a
      // docked-only route with 403 "not docked" — a correct answer to a question that stopped being valid, not an
      // error to show the player. Every docked-only read below is therefore covered: treat a 403 as "we just
      // undocked", mark the data stale and keep the last snapshot, exactly as the undocked branch does. Only
      // `/loadout` had this tolerance, so undocking mid-refresh surfaced a raw bridge string in the error bar.
      try {

        // Fetch inventory, loadout and layout FIRST, then publish all three together. Setting them one at a
        // time (with awaits between) meant React rendered with the new inventory against the PREVIOUS ship's
        // layout — and the gear optimizer, which re-runs whenever the pool changes, would compute a proposal
        // for the old ship's hardpoints. After buying a ship that's a different slot layout entirely, so the
        // proposal was nonsense and each apply produced a new one: it took three applies to converge.
        const invData = await api.inventories(conn, fresh);
        let ld: Loadout | null = null;
        try {
          ld = await api.loadout(conn);
        } catch (e) {
          if (!(e instanceof ApiError && e.status === 403)) throw e;
        }
        let lay: ShipLayout | null = null;
        try { lay = await api.shipLayout(conn); } catch { /* keep null */ }
        try { setVitals(await api.vitals(conn)); } catch { /* a build without the route: the rows simply hide */ }
        setInv(invData);
        setLoadout(ld);
        setLayout(lay); // hardpoint positions for the gear editor
        const shopRes = await api.shops(conn, showBuyback.current);
        const shopData = shopRes.shops
          .flatMap((shop) => shop.items.map((it) => ({ ...it, location: shop.facility })))
          .filter((it) => kindOf(it) !== null);
        setShops(shopData);
        setBuybackCount(shopRes.shops.reduce((n, shop) => n + (shop.buybackCount ?? 0), 0));
        // When this list stops being safe to buy from. Stamped with the fetch time so the countdown can be
        // extrapolated locally instead of polling the bridge every second. Absent on a game build that has no
        // restock timer — the clock then simply doesn't render.
        setRestock(shopRes.refreshesIn != null ? { secs: shopRes.refreshesIn, fetched: Date.now() } : null);
        // Persist the last docked snapshot. The pools ride along ONLY from a docked read, and the previous ones are
        // kept otherwise: an in-space reading omits the ship's own gear, so caching it would overwrite the only
        // reading that can be reconciled with the layout stored beside it.
        saveSnap({
          loadout: ld, layout: lay,
          pools: cachedPools.current.pools, poolsShip: cachedPools.current.ship, poolsStation: cachedPools.current.station,
        });

        // Flash rows whose count changed vs the previous refresh (buy/sell/move).
        const counts = new Map<string, number>();
        for (const st of invData.stores)
          for (const it of st.items) {
            const k = flashKey({ ...it, location: st.id });
            counts.set(k, (counts.get(k) ?? 0) + (it.count ?? 1));
          }
        for (const it of shopData) counts.set(flashKey(it), (counts.get(flashKey(it)) ?? 0) + (it.count ?? 1));
        const changed = new Set<string>();
        if (prevCounts.current.size)
          for (const [k, c] of counts) if (prevCounts.current.get(k) !== c) changed.add(k);
        prevCounts.current = counts;
        setFlashed(changed);
      } catch (e) {
        if (e instanceof ApiError && e.status === 403) { setStale(true); return; }
        throw e;
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [conn]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  // Global click feedback: flash a ring on any button clicked, so a press registers visibly even when
  // it changes nothing. Re-trigger the animation by removing/reflowing/re-adding the class.
  useEffect(() => {
    const onClick = (e: globalThis.MouseEvent) => {
      const b = (e.target as HTMLElement | null)?.closest("button");
      if (!b || (b as HTMLButtonElement).disabled) return;
      b.classList.remove("btn-flash");
      void b.offsetWidth;
      b.classList.add("btn-flash");
    };
    document.addEventListener("click", onClick, true);
    return () => document.removeEventListener("click", onClick, true);
  }, []);

  const [echo, setEcho] = useState(false);
  // Coalesce bursty events (a multi-slot install fires one "loadoutChanged" per slot) into one refresh.
  const refreshTimer = useRef<number | null>(null);
  const debouncedRefresh = useCallback(() => {
    if (refreshTimer.current != null) clearTimeout(refreshTimer.current);
    refreshTimer.current = window.setTimeout(() => { refreshTimer.current = null; refresh(); }, 250);
  }, [refresh]);
  // Standing changes are their own signal: they don't invalidate inventory or loadout, so they nudge the
  // standing panels (at the foot of the map) instead of triggering a full refresh.
  const [standingBump, setStandingBump] = useState(0);
  const { connected: live } = useEvents(conn, true, (e) => {
    if (e.type === "echo") setEcho(!!e.active);
    else if (e.type === "log") setLog((l) => [...l, { t: e.t ?? "", source: e.source ?? "", text: e.text ?? "" }].slice(-200));
    else if (e.type === "standing") setStandingBump((n) => n + 1);
    else debouncedRefresh();
  });

  // Equipped gear, tagged with the ship slot it sits in. Equipped items carry no store handle, so the slot
  // key is the only way to ask the bridge for their icon — without it every "equipped" comparison card in
  // the tooltips was iconless.
  const currentItems: Item[] = useMemo(
    () =>
      loadout
        ? [
          ...(loadout.hardpoints ?? []).map((it) => ({ ...it, slotKey: `t:${it.slot ?? 0}` })),
          ...(loadout.modules ?? []).map((m) => ({ ...m.item, slotKey: m.slot ? `m:${m.slot}` : undefined })),
          ...(loadout.boosters ?? []).map((it) => ({ ...it, slotKey: `b:${it.slot ?? 0}` })),
        ]
        : [],
    [loadout],
  );

  const equippable: Item[] = useMemo(() => {
    const out: Item[] = [];
    for (const store of inv?.stores ?? [])
      for (const it of store.items) if (kindOf({ ...it }) !== null) out.push({ ...it, location: store.id });
    return out;
  }, [inv]);

  // The sell list needs the UNFILTERED inventory: aspect stock is counted off portable AspectItems, which
  // are not equippable and so never reach `equippable`. Applying that filter out of habit here would zero
  // every aspect stock and spare every carrier.
  // What the sell list may act on: EQUIPMENT (the game's Turret | Module | Booster categories), plus anything
  // the game refuses to sell — a protected item that never reaches the list cannot be shown as protected, and
  // "0 protected" would mean two things.
  //
  // Deliberately NOT the whole inventory. A default stance of "sell everything else" would then propose the
  // player's ammo, ore and trade goods, and the protection against that would be a rule they have to remember
  // to write; cargo stock is Station Assistant's auto-sell, which has its own per-category switches.
  const sellItems: Item[] = useMemo(() => {
    const out: Item[] = [];
    for (const store of inv?.stores ?? [])
      for (const it of store.items) {
        const guarded = it.favourite || it.canSell === false || it.missionItem || it.criticalItem;
        if (kindOf({ ...it }) !== null || guarded) out.push({ ...it, location: store.id });
      }
    return out;
  }, [inv]);

  // The player's own level, which every "vs mine" filter compares against. The bridge reports it
  // (`GamePlayer.level`); the fallback is the highest item level owned, which is NOT a level and behaves badly
  // as one — it makes the best item's relative level exactly 0 and every other item negative, so "within 10 of
  // mine" silently means "within 10 of my best item". Kept only so an older bridge still filters at all.
  const myLevel = useMemo(
    () => status?.level ?? Math.max(1, ...sellItems.map((i) => i.level ?? 0)),
    [status?.level, sellItems]);

  const [sellOpen, setSellOpen] = useState(false);
  const [sellDefault, setSellDefault] = useState<SellKind>(() => load<SellKind>("shipoptimizer.sellDefault", "keep"));
  const [sellRules, setSellRules] = useState<SellRule[]>(() => load<SellRule[]>("shipoptimizer.sellRules", []));
  // Saved rule lists live beside the active set, not inside it: the active set belongs to this playthrough and
  // a saved list is deliberately independent of one.
  const [sellLists, setSellLists] = useState<Record<string, SellListFile>>(
    () => load<Record<string, SellListFile>>("shipoptimizer.sellLists", {}));

  // Inventory filters/search.
  const [cat, setCat] = useState("");
  const [rar, setRar] = useState("");
  const uniq = (vals: (string | null)[]) => [...new Set(vals.filter((v): v is string => !!v))].sort();
  const cats = useMemo(() => uniq(equippable.map((i) => i.category)), [equippable]);
  const rars = useMemo(() => uniq(equippable.map((i) => i.rarity)), [equippable]);
  const filtered = useMemo(
    () => equippable.filter((i) => (!cat || i.category === cat) && (!rar || i.rarity === rar)),
    [equippable, cat, rar],
  );


  // Global category filter, applied across every list. Everything shows by default; a token in
  // `hidden` hides that category (checkbox unchecked). Tokens: "Turret", "Booster", or a module type.
  const [hidden, setHidden] = useState<Set<string>>(new Set());
  const toggleHidden = (tok: string) =>
    setHidden((s) => {
      const n = new Set(s);
      if (n.has(tok)) n.delete(tok);
      else n.add(tok);
      return n;
    });
  const passes = (it: Item) => {
    const t = globalToken(it);
    return t != null && !hidden.has(t);
  };
  const moduleTypes = useMemo(
    () =>
      [...new Set([...equippable, ...shops, ...currentItems].filter((i) => kindOf(i) === "Module").map((i) => i.type ?? "Module"))].sort(),
    [equippable, shops, currentItems],
  );
  const invShown = useMemo(() => filtered.filter(passes), [filtered, hidden]);
  const shopShown = useMemo(() => shops.filter(passes), [shops, hidden]);
  // An item the player just SOLD is not an opportunity to buy: the rails exist to find what the station stocks
  // that beats what is fitted, and offering back what was scrapped a minute ago is the opposite of that.
  const shopStock = useMemo(() => shops.filter((it) => !it.buyback), [shops]);
  const loadoutShown = useMemo(() => currentItems.filter(passes), [currentItems, hidden]);

  const role = status?.role ?? null;
  // Opportunities compare like-for-like within a slot+size group, else a candidate ranked by one stat "beats" an
  // equipped item ranked by another (a scanner's Precision vs its Combat Power). Two consistent bases: the MAIN
  // stat, the same one for every item of a slot family, and the ROLE stat, null when the item lacks it. A missing
  // role stat scores 0 rather than null, so an item that ADDS the ship's role stat where the equipped one has none
  // still reads as an upgrade; within a group everything shares 0 when nobody carries it, so no false upgrades
  // appear. Turrets respect the Gear-tab per-slot config; modules and boosters use the generic comparison.
  // Crit setup and the ship-level POOLS drive the expanded gear ranking: an item's rolled stats land on the
  // ship, not the item, so a Precision roll on one gun raises every gun's crit. Both come from /status;
  // absent (older bridge) means the expanded mode falls back to per-slot ranking.
  // The ranking context is STICKY per ship. Around a scene change `/status` reports class-level fallbacks and no
  // pools, and those crit fallbacks are indistinguishable from real readings — letting one through re-scores every
  // candidate, so the list reorders and the relative-value column blinks. `statsLive` says which kind of reading it
  // is; the last live one stands until superseded, and switching ships drops it.
  const lastLive = useRef<{ ship: string | null; crit: CritContext | null; pools: ShipPools | null }>(
    { ship: null, crit: null, pools: null });
  // The last docked pool reading, surviving a reload. Read once — the snapshot is large enough that parsing it
  // per render would be felt.
  const [snapPools] = useState(() => {
    const s = loadSnap();
    return { ship: s?.poolsShip ?? null, pools: s?.pools ?? null, station: s?.poolsStation ?? null };
  });
  const cachedPools = useRef(snapPools);
  const { critCtx, shipPools } = useMemo(() => {
    const ship = status?.shipGuid ?? null;
    if (lastLive.current.ship !== ship) lastLive.current = { ship, crit: null, pools: null };
    // A bridge too old to send `statsLive` omits it: treat what it sends as live, which is what that client
    // did before this existed.
    const live = status != null && (status.statsLive ?? true);
    if (live) {
      lastLive.current.crit = {
        chance: status.critChance ?? 0.03,
        damage: status.critDamage ?? 1,
        megaCrit: status.megaCrit ?? 0,
      };
      // A reading is only usable if it CONTAINS the gear it will be asked about. A live unit whose equipment is
      // not registered yet passes `statsLive` (which only means `unit != null`) while reporting hull-and-crew
      // pools — CombatPower an order of magnitude down and `equivalentTurrets` at 0, with crew-dominated
      // Precision unmoved. `background()` would then subtract more than the pool holds and clamp the deficit to
      // zero, which is not a scale error: a candidate's own power becomes the whole pool. Reconciled against the
      // battery rather than gated on `docked`, a settled undocked reading being identical to the docked one at
      // the same station.
      const fresh = poolsFromStatus(status);
      const eq = (layout?.hardpoints ?? []).map((h) => h.equipped).filter((x): x is Item => !!x);
      if (fresh && poolsReconcile(fresh, eq)) {
        lastLive.current.pools = fresh;
        cachedPools.current = { ship, pools: fresh, station: status.station ?? null };
      } else if (fresh) {
        lastLive.current.pools = null;   // unusable; the cache below stands in
      }
    }
    // When the live reading is refused, the last reconcilable one for THIS ship stands in — it describes the
    // layout the gear tab is showing, and ranking keeps working instead of degrading to simple. SILENTLY: the
    // substitution lasts a scene change, the player cannot act on it, and a banner explaining which reading a
    // ranking came from is detail nobody reads. The guard still refuses the bad reading; it just says nothing.
    const cached = cachedPools.current.ship === ship ? cachedPools.current : null;
    let pools = lastLive.current.pools ?? cached?.pools ?? null;
    // The cache's guard only establishes that the FLOWN ship is unchanged, not that it is the one being SCORED —
    // see poolsForShip, which owns that rule.
    pools = poolsForShip(pools, ship, layout?.shipGuid ?? null);
    return {
      critCtx: lastLive.current.crit ?? { chance: 0.03, damage: 1, megaCrit: 0 },
      shipPools: pools,
    };
  }, [status?.shipGuid, status?.statsLive, status?.docked, status?.station, layout,
      status?.critChance, status?.critDamage, status?.megaCrit,
      status?.poolCombatPower, status?.poolPrecision, status?.equivalentTurrets, status?.precisionDivisor,
      status?.poolMiningPower, status?.poolSalvagePower,
      status?.equivalentTurretsMining, status?.equivalentTurretsSalvage,
      status?.energyCapacity, status?.energyUsed, status?.reactorBonus]);
  // Reactor budget for the Gear tab's totals panel. Not folded into ShipPools: the pools are the ranking
  // model's inputs, while this is the ship-wide budget a whole BUILD is judged against.
  const reactorInfo = useMemo(() => ({
    capacity: status?.energyCapacity ?? null,
    used: status?.energyUsed ?? null,
    usage: status?.energyUsage ?? null,
    bonus: status?.reactorBonus ?? null,
    combatBonus: status?.reactorCombatBonus ?? null,
  }), [status?.energyCapacity, status?.energyUsed, status?.energyUsage, status?.reactorBonus, status?.reactorCombatBonus]);
  const gearBuilder = useGearBuilder(layout, inv, status?.shipGuid ?? null, critCtx, shipPools, status?.role ?? null);
  const boosterBuilder = useBoosterBuilder(loadout, inv);
  // What swapping one turret for another is WORTH, under the Gear tab's selected ranking — the rail's
  // objective has to be the optimizer's, or the two disagree and the rail recommends buying something the
  // optimizer then declines to fit. "simple" is the headline stat, as the game shows it. "expanded" scores
  // the whole BATTERY with the candidate swapped in, exactly as the gear optimizer does: pooled stats mean an
  // item's worth depends on the set it joins, so a per-item score can call something an upgrade that lowers
  // total damage.
  const gearGain = useCallback((equipped: Item, candidate: Item) => {
    if (gearBuilder.ranking !== "expanded" || !shipPools)
      return (mainVal(candidate) ?? 0) - (mainVal(equipped) ?? 0);
    const equippedTurrets = gearBuilder.hps.map((h) => h.equipped).filter((x): x is Item => !!x);
    const bg = background(shipPools, equippedTurrets);
    // The candidate replaces THIS turret and leaves the rest standing — the same one-slot swap the Gear tab's
    // relative-value column scores, so the two agree on what an upgrade is.
    const others = equippedTurrets.filter((t) => t !== equipped);
    // `rankSub`, not a subtraction: a mining laser and a cannon are scored in different units, and it returns 0
    // across tiers ∴ a cross-activity candidate falls below the floor below and is never railed. The rail deals
    // in one number and a tier change has no magnitude — proposing that switch is the Gear tab's job, where the
    // whole battery is on screen.
    return rankSub(setRank([...others, candidate], bg), setRank([...others, equipped], bg));
  }, [gearBuilder.ranking, gearBuilder.hps, shipPools]);

  const oppsFor = useCallback((src: Item[]) => {
    const cands = src.filter(passes);
    // The same floor the gear tab applies: below it a swap is model noise and the optimizer refuses it, so
    // advertising it here would offer what the tab then declines — a "+49.4" on a 90,577 index is 0.05%.
    const equippedT = gearBuilder.hps.map((h) => h.equipped).filter((x): x is Item => !!x);
    // The baseline is the battery's own rank VALUE — a DPS index for a combat set, the activity's power for a
    // mining or salvage one. The floor is a ratio ∴ it stays valid in either unit, which is why `gearGain` must
    // report inside the same tier for the division to mean anything.
    const baseDps = shipPools && gearBuilder.ranking === "expanded" && equippedT.length
      ? setRank(equippedT, background(shipPools, equippedT))[1] : 0;
    const turrets = gearTurretOpps(cands.filter(isTurret), gearBuilder.hps, gearBuilder.filters, gearBuilder.cats, gearGain)
      .filter((o) => baseDps <= 0 || o.delta / baseDps >= MIN_GAIN);
    const boosters = gearBoosterOpps(cands.filter(isBooster), boosterBuilder.slotTypes, boosterBuilder.equippedBySlot);
    // The rails judge a module the way the tab does: on the battery it changes, wherever the pools allow it.
    const other = gearModuleOpps(cands.filter((i) => !isTurret(i) && !isBooster(i)), gearBuilder.mslots,
      shipPools?.energy, status?.role ?? null,
      gearBuilder.ranking === "expanded" ? shipPools : null, equippedT);
    return [...turrets, ...boosters, ...other].sort((a, b) => b.delta - a.delta);
  }, [passes, currentItems, gearBuilder, boosterBuilder, gearGain]);
  const invOpps = useMemo(() => oppsFor(equippable), [equippable, hidden, oppsFor]);
  const shopOpps = useMemo(() => oppsFor(shopStock), [shopStock, hidden, oppsFor]);
  const credits = status?.credits ?? null;

  // Officer optimizer: ships with officer slots (from /officers) joined with names/roles (from /ships),
  // current ship first. The builder hook drives both the Officers and Summary tabs.
  const shipList: BuilderShip[] = useMemo(() => {
    const byGuid = new Map(shipsAll.map((l) => [l.shipGuid, l]));
    return (officers?.ships ?? [])
      .filter((s) => s.slots > 0)
      .map((s) => {
        const ld = byGuid.get(s.shipGuid);
        // Defensive layer from the ship's equipped defensive module slot (armor wins if both exist).
        const hasSlot = (nm: string) => (ld?.modules ?? []).some((m) => (m.slot ?? m.item?.slotType) === nm);
        const defenseLayer: "shield" | "armor" | null = hasSlot("Armor") ? "armor" : hasSlot("ShieldGenerator") ? "shield" : null;
        return { guid: s.shipGuid, name: ld?.name ?? ld?.shipType ?? s.shipGuid, role: ld?.role ?? null, slots: s.slots, hasDroneBay: s.hasDroneBay, defenseLayer, assigned: s.assigned ?? [] };
      })
      .sort((a, b) => Number(b.guid === status?.shipGuid) - Number(a.guid === status?.shipGuid));
  }, [officers, shipsAll, status?.shipGuid]);
  const builder = useOfficerBuilder(officers?.officers ?? [], shipList, status?.shipGuid ?? null);
  const portraitUrl = useCallback((guid: string | null) => api.portraitUrl(conn, guid), [conn]);
  const crewSupported = !!status?.crewSupported;
  // #/officers is dead on the release game (no crew) — bounce it back to inventory.
  useEffect(() => { if (tab === "officers" && status && !crewSupported) setTab("inventory"); }, [tab, crewSupported, status, setTab]);

  // Count of station recruits that would out-rank an assigned officer → Officers-tab badge.
  // Station recruits that out-rank an assigned officer — surfaced on the inventory tab's opportunity rail.

  // ONE apply owner for the whole app: `busy`, the last message and the action log are single-valued, so a copy
  // per tab would show contradictory state and two log lists would overwrite each other's localStorage entry.
  // Each screen renders the same truth and only picks which SECTION it applies.
  const applyApi = useApply({
    officer: builder, boosters: boosterBuilder, gear: gearBuilder, conn,
    crewSupported, docked: !!status?.docked, hasHangar: status?.hasPersonalHangar ?? true,
    currentShipGuid: status?.shipGuid ?? null, playthrough: status?.playthrough ?? null, onChanged: refresh,
  });

  const officerOpps = useMemo(() => {
    if (!recruits?.hasPersonnelCenter || !builder.ship || !builder.result) return [];
    return evaluateRecruits(
      recruits.officers as RecruitOfficer[],
      { role: builder.ship.role, hasDroneBay: builder.ship.hasDroneBay, priorities: builder.prio, scope: builder.scope },
      builder.result.chosen,
    ).filter((o) => o.isOpp);
  }, [recruits, builder.ship, builder.result, builder.prio, builder.scope]);
  const officerOppCount = officerOpps.length;

  // A badge that says HOW MANY without saying what it costs sends the player into the tab to find out. Both
  // tooltips are built by one formatter (`affordTip`) so buying and hiring word it the same way.
  const shopTip = useMemo(
    () => affordTip(`${shopOpps.length} shop item${shopOpps.length === 1 ? "" : "s"} at this station beat something equipped`,
      shopOpps.map((o) => ({
        name: o.item.name, cost: o.item.cost,
        costItem: o.item.costItem, costItemCount: o.item.costItemCount, costItemOwned: o.item.costItemOwned,
      })), credits),
    [shopOpps, credits]);
  const hireTip = useMemo(
    () => affordTip(`${officerOppCount} recruit${officerOppCount === 1 ? "" : "s"} would out-rank an assigned officer`,
      officerOpps.map((o) => ({ name: o.name, cost: o.hireCost })), credits),
    [officerOpps, officerOppCount, credits]);

  return (
    <div className="app">
      <header>
        <h1>Ship Optimizer</h1>
        <span className={`badge ${live ? "on" : "off"}`}>{live ? "live" : "no feed"}</span>
        {status?.shipType && <ShipImg key={status.shipGuid ?? status.shipType} conn={conn} guid={status.shipGuid} shipType={status.shipType} />}
        {status && (
          <span className="status">
            {status.docked ? `⚓ ${status.station}` : "undocked"}
            {status.shipType && <span className="ship"> · {status.shipType}</span>}
            {status.role && <span className="role"> {status.role}</span>}
            {echo && <span className="echo"> ECHO</span>}
          </span>
        )}
        {status && (
          // Its own element, not the tail of a sentence: this is the figure checked before every purchase, and it
          // was rendered in the same grey as the ship name with no separation. Tabular figures so the digits do not
          // shift as it changes.
          <span className="wallet" title="Credits on hand">
            <b>{status.credits.toLocaleString()}</b> cr
          </span>
        )}
        {/* Non-credit currencies: barter offers are priced in them, so a wallet showing only credits cannot
            answer "can I afford it" for half the shop. The set is per build — the release earns four
            commendations, the beta replaced them with `VanguardMark` — hence a list rather than a named field.
            An older bridge sends only `vanguardMarks`, so that is the fallback.

            Only what you HOLD is shown. A build that replaced a currency leaves the old entry in the item
            registry, permanently at 0, and the bridge cannot tell a retired currency from one you simply have
            none of — so filtering on holdings is what keeps four dead commendations out of the beta's header.
            The cost is that a currency you have none of is invisible until you earn one, which is the right way
            round: an empty row answers no question. */}
        {(status?.currencies?.length
          ? status.currencies
          : status?.vanguardMarks != null
            ? [{ id: "VanguardMark", name: "marks", owned: status.vanguardMarks }]
            : []
        ).filter((c) => c.owned > 0).map((c) => (
          <span key={c.id} className="wallet marks" title={`${c.name} on hand — what barter offers are priced in`}>
            <b>{c.owned.toLocaleString()}</b> {c.name}
          </span>
        ))}
        <button onClick={() => setCfgOpen(true)} title="Export / import categories, filters & settings">Config</button>
        <button className="tools-btn" onClick={() => setToolsOpen(true)} title="Tools — reclaim orphaned loadouts & maintenance" aria-label="Tools">⋯</button>
        {status && <span className="versions" title="Game / Hypercom plugin version">game {status.gameVersion ?? "?"} · plugin {status.pluginVersion ?? "?"}</span>}
        <span className="spacer" />
        <ConnPanel conn={conn} onSave={(c) => { setConn(c); saveConn(c); }} onRefresh={refresh} loading={loading} />
      </header>

      <SellList
        open={sellOpen}
        onClose={() => setSellOpen(false)}
        conn={conn}
        docked={!!status?.docked}
        items={sellItems}
        cats={gearBuilder.cats}
        myLevel={myLevel}
        defaultKind={sellDefault}
        rules={sellRules}
        onChange={(next) => {
          setSellDefault(next.defaultKind); save("shipoptimizer.sellDefault", next.defaultKind);
          setSellRules(next.rules); save("shipoptimizer.sellRules", next.rules);
        }}
        lists={sellLists}
        onLists={(next) => { setSellLists(next); save("shipoptimizer.sellLists", next); }}
        onCats={gearBuilder.setCats}
        onSold={refresh}
      />
      {cfgOpen && <ConfigDialog onClose={() => setCfgOpen(false)} />}
      {toolsOpen && <ToolsDialog conn={conn} playthrough={status?.playthrough ?? null} playthroughName={status?.playthroughName ?? null} onClose={() => setToolsOpen(false)} onChanged={() => { setPresetsNonce((n) => n + 1); refresh(); }} />}
      {error && <div className="error">⚠ {error}</div>}
      {/* A swallowed write failure means preferences silently stop persisting. Say so. */}
      {storeErr && (
        <div className="error">
          ⚠ {storeErr.message}.{storeErr.reclaimed ? " Cached inventory snapshot and action log were dropped to make room." : ""}
          {storeErr.quota ? " Clear this site's data if it keeps happening." : " Settings won't persist in this browser (private mode or storage blocked?)."}
          <button className="tools-btn" onClick={() => { clearStorageFailure(); setStoreErr(null); }} title="Dismiss">×</button>
        </div>
      )}
      {stale && (
        <div className="stale">
          {/* The station is named ONCE, in the header. Repeating it here and again on the shop heading told the
              same fact three times for one dock. */}
          ⚠ Undocked — armory / shop / loadout from the last dock
        </div>
      )}

      {/* Above the tabs, so the refresh cycles read the same from every one of them: "is it worth docking yet"
          is a question you have while looking at gear, not only while looking at the map. */}
      <CycleTimers conn={conn} />

      <nav className="tabs">
        <button className={tab === "inventory" ? "on" : ""} onClick={() => setTab("inventory")}>
          Inventory &amp; opportunities
          <TabBadge kind="inv" count={invOpps.length} label="inv" title="Inventory items that beat something equipped" />
          <TabBadge kind="shop" count={shopOpps.length} label="shop" title={shopTip} />
        </button>
        {crewSupported && (
          <button className={tab === "officers" ? "on" : ""} onClick={() => setTab("officers")}>
            Officers
            <TabBadge kind="pending" count={applyApi.counts.officers} label="new" title="Proposed crew changes for this ship" />
            <TabBadge kind="hire" count={officerOppCount} label="hire" title={hireTip} />
          </button>
        )}
        {/* Per-tab counts of what is PROPOSED there, so the pending work is visible without opening each tab. The
            Summary badge is their total plus officers, which is why these three can disagree with it by design. */}
        <button className={tab === "boosters" ? "on" : ""} onClick={() => setTab("boosters")}>Boosters
          <TabBadge kind="pending" count={applyApi.counts.boosters} label="new" title="Proposed booster changes" />
        </button>
        <button className={tab === "gear" ? "on" : ""} onClick={() => setTab("gear")}>Ship gear
          <TabBadge kind="pending" count={applyApi.counts.gear} label="new" title="Proposed gear changes for this ship" />
        </button>
        <button className={tab === "summary" ? "on" : ""} onClick={() => setTab("summary")}>Summary
          <TabBadge kind="pending" count={applyApi.counts.total} label="new" title="Pending changes to apply — officers, boosters and gear" />
        </button>
        {/* temporary: galaxy map proposal */}
        <button className={tab === "map" ? "on" : ""} onClick={() => setTab("map")}>Map <TabNote text="wip" title="Work in progress" /></button>
      </nav>

      {tab === "officers" && <OfficersTab apply={applyApi} builder={builder} portraitUrl={portraitUrl} recruits={recruits} portraitByIcon={(icon) => api.portraitByIcon(conn, icon)} goSummary={() => setTab("summary")} conn={conn} docked={!!status?.docked} credits={credits} onHired={refresh} />}
      {tab === "boosters" && <BoostersTab apply={applyApi} builder={boosterBuilder} docked={!!status?.docked} conn={conn} goSummary={() => setTab("summary")} />}
      {tab === "gear" && <GearTab layout={layout} builder={gearBuilder} catalog={catTypes} conn={conn} currentShipGuid={status?.shipGuid ?? null} goSummary={() => setTab("summary")} reactor={reactorInfo} role={role} vitals={vitals} apply={applyApi} />}
      {tab === "map" && <MapTab conn={conn} docked={!!status?.docked} standingBump={standingBump} />}
      {tab === "summary" && (
        <SummaryTab officer={builder} boosters={boosterBuilder} gear={gearBuilder} portraitUrl={portraitUrl} conn={conn}
          crewSupported={crewSupported} docked={!!status?.docked} hasHangar={status?.hasPersonalHangar ?? true} currentShipGuid={status?.shipGuid ?? null} playthrough={status?.playthrough ?? null} playthroughName={status?.playthroughName ?? null} reloadNonce={presetsNonce} onChanged={refresh} apply={applyApi} />
      )}

      {tab === "inventory" && (<>
      <div className="globals">
        <b>Show:</b>
        {/* ALL / NONE up front: with a dozen module types, clearing the lot to pick one back is the common
            move, and toggling eleven chips by hand to get there is the slow way to do it. */}
        <button className="pill-all" disabled={!hidden.size} onClick={() => setHidden(new Set())} title="Show every category">All</button>
        <button className="pill-all" onClick={() => setHidden(new Set(["Turret", "Booster", ...moduleTypes]))} title="Hide every category">None</button>
        <Pills options={["Turret", "Booster", ...moduleTypes]} isOn={(o) => !hidden.has(o)} onToggle={toggleHidden} />
      </div>


      <div className="layout">
        <aside className="side">
          <div className="opp-panel">
            <div className="opp-head">
              <h2>From inventories</h2>
            </div>
            {loadout ? (
              invOpps.length ? <OpportunityList opps={invOpps} equipped={currentItems} role={role} conn={conn} docked={!!status?.docked} onBought={refresh} ranking={gearBuilder.ranking} /> : <p className="hint" title="Nothing you own or can buy here beats what is equipped">none better</p>
            ) : (
              <p className="hint">dock to see upgrades</p>
            )}
          </div>
        </aside>

        <main className="center">
          <section>
            <h2>
              {/* "cargo only" is already said by the undocked bar above; the count needs no unit. */}
              Inventory <small>{invShown.length}/{equippable.length}</small>
            </h2>
            <div className="filters">
              <select value={cat} onChange={(e) => setCat(e.target.value)}>
                <option value="">all categories</option>
                {cats.map((c) => (<option key={c} value={c}>{c}</option>))}
              </select>
              <select value={rar} onChange={(e) => setRar(e.target.value)}>
                <option value="">all rarities</option>
                {rars.map((r) => (<option key={r} value={r}>{r}</option>))}
              </select>
              {(cat || rar) && <button onClick={() => { setCat(""); setRar(""); }}>clear</button>}
              <button onClick={() => downloadText("inventory.csv", toCsv(invShown))}>CSV</button>
              <button onClick={() => setSellOpen(true)} title="What is scrap, and why — rules you write, reviewed before anything sells">Sell list…</button>
            </div>
            <ItemGrid items={invShown} showWhere equipped={currentItems} role={role} flashed={flashed} conn={conn} />
          </section>

          <section>
            <h2>
              {status && !status.docked ? "Station shop (last)" : "Station shop"}{" "}
              <small>{shopShown.length}/{shops.length}</small>{" "}
              <RestockClock deadline={restock} onExpire={refresh} />{" "}
              {/* Fetched on request, because after selling an armory this is thousands of rows and megabytes
                  on a list that is otherwise read for what the STATION sells. */}
              {buybackCount > 0 && (
                <button className="mini" title="Items you sold here. The station holds them until it restocks."
                        onClick={() => { showBuyback.current = !buybackShown; setBuybackShown(!buybackShown); refresh(); }}>
                  {buybackShown ? "hide" : "show"} {buybackCount.toLocaleString()} you sold
                </button>
              )}
            </h2>
            {shopShown.length ? (
              <ItemGrid items={shopShown} showShop equipped={currentItems} role={role} flashed={flashed} conn={conn} docked={!!status?.docked} credits={credits} onBought={refresh} />
            ) : (
              <p className="hint">No shop items.</p>
            )}
          </section>

          <section>
            <h2>Current loadout {loadout && <small>{loadout.name}</small>}</h2>
            {loadout ? <ItemGrid items={loadoutShown} equipped={currentItems} role={role} conn={conn} /> : <p className="hint">Dock to read the loadout.</p>}
          </section>


          <section>
            <Ledger conn={conn} reloadNonce={ledgerNonce} />
          </section>

          <section>
            <div className="row">
              <h2>Game log <small>{log.length}</small></h2>
              {log.length > 0 && <button onClick={() => setLog([])}>clear</button>}
            </div>
            {log.length ? (
              <div className="logbox">
                {[...log].reverse().map((e, i) => (
                  <div key={i} className="logrow">
                    <span className="logt">{e.t}</span>
                    <span className={`logsrc s-${e.source}`}>{e.source}</span>
                    <span className="logtext">{e.text}</span>
                  </div>
                ))}
              </div>
            ) : (
              <p className="hint">No events yet.</p>
            )}
          </section>
        </main>

        <aside className="side">
          <div className="opp-panel">
            <div className="opp-head">
              <h2>From shop</h2>
            </div>
            {loadout ? (
              shopOpps.length ? <OpportunityList opps={shopOpps} equipped={currentItems} showCost role={role} credits={credits} conn={conn} docked={!!status?.docked} onBought={refresh} ranking={gearBuilder.ranking} /> : <p className="hint" title="Nothing you own or can buy here beats what is equipped">none better</p>
            ) : (
              <p className="hint">dock to see upgrades</p>
            )}
          </div>

          {crewSupported && (
            <div className="opp-panel officer-opps">
              {/* Which ship the hires are ranked against goes in the tooltip: the Officers tab already shows the
                  selected ship, so naming it here was the third place it appeared. */}
              <div className="opp-head"><h2 title={builder.ship ? `Ranked against ${builder.ship.name}` : undefined}>Officer hires</h2></div>
              {officerOpps.length ? (
                <div className="opp-list">
                  {officerOpps.map((o, i) => (
                    <div key={i} className="opp-row" title={`Lv ${o.level} · ${o.profession}`}>
                      <span className={`opp-name r-${o.rarity}`}>{o.name}</span>
                      <span className="opp-d up">↑ {o.replaces}</span>
                      <span className="opp-cost dim">¢{o.hireCost.toLocaleString()}</span>
                    </div>
                  ))}
                </div>
              ) : <p className="hint" title={recruits?.hasPersonnelCenter ? undefined : "Needs a station with a Personnel Center"}>{recruits?.hasPersonnelCenter ? "none better" : "dock to see hires"}</p>}
            </div>
          )}
        </aside>
      </div>
      </>)}
    </div>
  );
}

// Ship image: rendered by the GAME from its own sprite, nothing else. Art from anywhere but the running build
// can be wrong (or stale across a beta), so a failed render just hides the image. Keyed by ship guid so
// switching ships retries.
function ShipImg({ conn, guid, shipType }: { conn: Conn; guid: string | null; shipType: string }) {
  const [failed, setFailed] = useState(false);
  const src = guid && !failed ? api.shipImageUrl(conn, guid, shipType) : null;
  if (!src) return null;
  return <img className="ship-img" src={src} alt={shipType} title={shipType} onError={() => setFailed(true)} />;
}

function ConnPanel({
  conn, onSave, onRefresh, loading,
}: { conn: Conn; onSave: (c: Conn) => void; onRefresh: () => void; loading: boolean }) {
  const [d, setD] = useState(conn);
  return (
    <div className="conn">
      <input value={d.host} onChange={(e) => setD({ ...d, host: e.target.value })} placeholder="host" size={10} />
      <input value={d.port} onChange={(e) => setD({ ...d, port: e.target.value })} placeholder="port" size={5} />
      <input value={d.token} onChange={(e) => setD({ ...d, token: e.target.value })} placeholder="token (if RequireAuth)" size={14} />
      <button onClick={() => onSave(d)}>save</button>
      <button onClick={onRefresh} disabled={loading}>{loading ? "…" : "refresh"}</button>
    </div>
  );
}

// Numeric filter: "*" or bare number defaults to >=; supports >= <= > < = !=. Unparseable = no filter.
function numMatch(v: number, expr: string): boolean {
  const m = expr.trim().match(/^(>=|<=|!=|=|>|<)?\s*(-?\d+(?:\.\d+)?)$/);
  if (!m) return true;
  const n = parseFloat(m[2]);
  switch (m[1] ?? ">=") {
    case ">=": return v >= n;
    case "<=": return v <= n;
    case ">": return v > n;
    case "<": return v < n;
    case "!=": return v !== n;
    case "=": return v === n;
    default: return true;
  }
}

interface Col {
  key: string;
  label: string;
  cls?: string;
  sortable?: boolean;
  num?: (it: Item) => number; // numeric columns: filter with operators, sort numerically
  text?: (it: Item) => string; // text columns: substring filter (or exact when opts set)
  opts?: string[]; // when set, filter is a dropdown matching exactly
  cell: (it: Item) => ReactNode;
}

// ---- CSV export ----
function csvCell(v: unknown): string {
  const s = String(v ?? "");
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
function toCsv(items: Item[]): string {
  const statCols = statColumns(items);
  const head = ["name", "type", "size", "slot", "rarity", "level", "qual", "location", "mainStat", "substats", ...statCols];
  const rows = items.map((it) => [
    it.name, it.type ?? "", it.size ?? "", it.slotType ?? "", it.rarity, it.level, it.bonus ?? "", it.location ?? "",
    it.mainStat ? `${it.mainStat.amount} ${it.mainStat.name}` : "",
    (it.substats ?? []).map(subFmt).join("; "),
    ...statCols.map((c) => { const l = it.stats.find((s) => s.stat === c); return l ? (l.multiplier && l.multiplier !== 1 ? l.multiplier : l.amount) : ""; }),
  ]);
  return [head, ...rows].map((r) => r.map(csvCell).join(",")).join("\n");
}
function downloadText(name: string, text: string) {
  const url = URL.createObjectURL(new Blob([text], { type: "text/csv" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  URL.revokeObjectURL(url);
}

// Time left before the station rolls its stock over, as the game's own shop panel shows it.
//
// This is not decoration. An offer is addressed by its inventory SLOT, and a restock refills those same
// slots with different goods — so once the clock runs out the list on screen is a trap, and we refetch
// rather than leave it there. The countdown is extrapolated from one reading (the bridge's number is play
// time, which stops when the game is paused, so local ticking can run ahead); it self-corrects, because
// hitting zero triggers a refetch that brings back the true remaining time.
function RestockClock({ deadline, onExpire }: { deadline: { secs: number; fetched: number } | null; onExpire: () => void }) {
  const [now, setNow] = useState(() => Date.now());
  const fired = useRef(false);
  useEffect(() => {
    if (!deadline) return;
    fired.current = false;
    const t = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(t);
  }, [deadline]);

  const left = deadline ? Math.max(0, deadline.secs - (now - deadline.fetched) / 1000) : null;
  useEffect(() => {
    if (left === 0 && !fired.current) { fired.current = true; onExpire(); }
  }, [left, onExpire]);

  if (left == null) return null;
  const m = Math.floor(left / 60);
  const s = Math.floor(left % 60);
  return (
    <small className={`restock${left < 120 ? " soon" : ""}`} title="Stock rolls over then — offer slots are reused, so the list is refetched">
      {m}:{String(s).padStart(2, "0")}
    </small>
  );
}

// Dense grid: fixed columns + one column per stat. Click a header to sort (first click desc).
// A filter row under the header filters each column (text substring; numeric operators).
function ItemGrid({
  items, showWhere, showShop, equipped, role, flashed, conn, docked, credits, onBought,
}: {
  items: Item[]; showWhere?: boolean; showShop?: boolean; equipped?: Item[]; role?: string | null;
  flashed?: Set<string>; conn: Conn; docked?: boolean; credits?: number | null; onBought?: () => void;
}) {
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const toggleSel = (k: string) =>
    setSelected((s) => {
      const n = new Set(s);
      if (n.has(k)) n.delete(k);
      else n.add(k);
      return n;
    });
  // Buying straight from the shop table: the opportunities rail only lists UPGRADES, so without this
  // there's no way to buy anything the optimizer doesn't rate (ammo, a cheap spare, a downgrade you want
  // on purpose). Same rules and same wording as the rail.
  const [buying, setBuying] = useState<string | null>(null);
  const [gridMsg, setGridMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const { ask, ui: confirmUi } = useConfirm();
  const whyBlocked = useCallback((it: Item): string | null => {
    if (!docked) return undockedMsg;
    if (it.costItem) {
      const need = it.costItemCount ?? 0, have = it.costItemOwned ?? 0;
      return have >= need ? null : barterMsg(need, have, it.costItem);
    }
    const cost = it.cost ?? 0;
    if (credits == null || cost <= credits) return null;
    return brokeMsg(cost, credits);
  }, [docked, credits]);

  const doBuy = useCallback(async (it: Item, skipConfirm: boolean) => {
    if (it.key == null || !it.location) return;
    const handle = `${it.location}:${it.key}`;
    // The latch is claimed BEFORE the confirmation, not after it. `window.confirm` blocked the event loop, so
    // nothing could race it; an awaited dialog does not, and a second click while the question is on screen
    // would otherwise open a second one and buy twice.
    setBuying(handle); setGridMsg(null);
    try {
      const price = priceLabel(it) ?? `${(it.cost ?? 0).toLocaleString()} cr`;
      if (!skipConfirm && !(await ask({ title: `Buy ${it.name} for ${price}?`, detail: affordLine(it, credits ?? null), confirmLabel: "Buy" }))) return;
      const r = await api.buy(conn, it.location, it.key, 1, buyExpect(it));
      setGridMsg({ ok: true, text: `Bought ${it.name}${r.barter ? " (barter)" : ` for ${r.spent.toLocaleString()} cr`}.` });
      onBought?.();
    } catch (e) {
      setGridMsg({ ok: false, text: e instanceof ApiError ? e.message : String(e) });
    } finally { setBuying(null); }
  }, [conn, onBought, ask, credits]);

  const statCols = useMemo(() => statColumns(items), [items]);
  const columns: Col[] = useMemo(() => {
    const distinct = (f: (it: Item) => string | null | undefined) =>
      [...new Set(items.map(f).filter((v): v is string => !!v))].sort();
    return [
      {
        key: "__name", label: "Item", cls: "c-name", sortable: true, text: (it) => it.name,
        cell: (it) => <span className={`r-${it.rarity}`}>{it.name}</span>,
      },
      { key: "__type", label: "Type", sortable: true, text: (it) => it.type ?? "", opts: distinct((i) => i.type), cell: (it) => <span className="dim">{it.type ?? ""}</span> },
      { key: "__level", label: "Lvl", cls: "num", sortable: true, num: (it) => it.level, cell: (it) => it.level },
      { key: "__size", label: "Size", sortable: true, text: (it) => it.size ?? "", opts: distinct((i) => i.size), cell: (it) => it.size ?? "" },
      ...(showWhere ? [{ key: "__where", label: "Where", sortable: true, text: (it: Item) => it.location ?? "", opts: distinct((i) => i.location), cell: (it: Item) => it.location ?? "" } as Col] : []),
      ...(showShop
        ? ([
            { key: "__cost", label: "Cost", cls: "num", sortable: true, num: (it: Item) => it.cost ?? 0, cell: (it: Item) => (priceLabel(it) ? <Price it={it} conn={conn} /> : "") },
            { key: "__stock", label: "Stock", cls: "num", sortable: true, num: (it: Item) => (it.stock === -1 ? Infinity : it.stock ?? 0), cell: (it: Item) => (it.stock === -1 ? "∞" : it.stock ?? "") },
          ] as Col[])
        : []),
      { key: "__bonus", label: "Qual", cls: "num", sortable: true, num: (it) => it.bonus ?? 0, cell: (it) => (it.bonus ? `${it.bonus}${it.bonusStat ? " " + it.bonusStat : ""}` : "") },
      { key: "__asp", label: "Aspects", cls: "c-asp", text: (it) => it.aspects.map((a) => a.name).join(", "), cell: (it) => it.aspects.map((a) => a.name).join(", ") },
      ...(showShop
        ? [{
          key: "__buy",
          label: "",
          cls: "c-buy",
          cell: (it: Item) => {
            if (it.key == null || !it.location) return null;
            const why = whyBlocked(it);
            const handle = `${it.location}:${it.key}`;
            return (
              // Not `disabled` when merely blocked — the click is how the reason gets said out loud.
              <button
                className={`opp-buy${why ? " blocked" : ""}`}
                disabled={buying === handle}
                title={why ?? `Buy ${it.name}: ${affordLine(it, credits ?? null)} — ctrl+click skips the confirmation`}
                onClick={(e) => {
                  e.stopPropagation();
                  if (why) { setGridMsg({ ok: false, text: why }); return; }
                  void doBuy(it, e.ctrlKey || e.metaKey);
                }}
              >{buying === handle ? "…" : "buy"}</button>
            );
          },
        } as Col]
        : []),
      { key: "__sub", label: "Substats", cls: "c-sub", text: (it) => (it.substats ?? []).map(subFmt).join(", "), cell: (it) => (it.substats ?? []).map(subFmt).join(", ") },
      { key: "__count", label: "#", cls: "num", num: (it) => it.count ?? 0, cell: (it) => (it.count && it.count > 1 ? it.count : "") },
      ...statCols.map(
        (c): Col => ({ key: c, label: c, cls: `num c-stat ${isRoleStat(role, c) ? "role" : ""}`, sortable: true, num: (it) => statVal(it, c), cell: (it) => cell(it.stats.find((s) => s.stat === c)) }),
      ),
    ];
  }, [statCols, items, showWhere, showShop, role, whyBlocked, doBuy, buying]);

  const [filters, setFilters] = useState<Record<string, string>>({});
  const [sort, setSort] = useState<{ key: string; dir: 1 | -1 } | null>(null);

  // Width of the two clipped TEXT columns, in px, dragged by the grip in their header and persisted per
  // browser. Only these two: every other column holds one short number or word and sizes itself, while
  // "Substats" and "Aspects" hold a sentence whose useful width is a matter of screen and taste.
  const [colW, setColW] = useState<Record<string, number>>(() => load(COL_W_KEY, {} as Record<string, number>));
  // The widths are ALSO held in a ref, and the drag handlers read only the ref: they are created inside a
  // memoized header (deps: columns/filters/sort), so a handler closing over `colW` would still see the width
  // from the render that built it — the second drag of a column would jump back to its first drag's start.
  const colWRef = useRef(colW);
  colWRef.current = colW;
  const tableRef = useRef<HTMLTableElement | null>(null);
  const dragRef = useRef<{ key: string; startX: number; startW: number; live: number } | null>(null);

  // Apply a width WITHOUT React: the custom property goes straight onto the table node. Dragging through state
  // re-rendered the whole tab on every pointermove, which is what made it feel heavy — a drag is a paint, not a
  // data change, and only its RESULT is worth telling React about.
  const paintWidth = (key: string, px: number) => {
    const prop = RESIZABLE[key]?.prop;
    if (prop && tableRef.current) tableRef.current.style.setProperty(prop, `${px}px`);
  };

  const commitWidth = (key: string, px: number) => {
    const next = { ...colWRef.current, [key]: px };
    colWRef.current = next;
    setColW(next);
    save(COL_W_KEY, next);
  };

  const beginResize = (key: string, defaultW: number) => (e: React.PointerEvent<HTMLDivElement>) => {
    e.preventDefault();          // a grip drag is not a header click, so it must not sort
    e.stopPropagation();
    const startW = colWRef.current[key] ?? defaultW;
    dragRef.current = { key, startX: e.clientX, startW, live: startW };
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    e.currentTarget.classList.add("dragging");
  };
  const onResizeMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const d = dragRef.current;
    if (!d) return;
    d.live = Math.max(COL_MIN, Math.min(COL_MAX, d.startW + (e.clientX - d.startX)));
    paintWidth(d.key, d.live);
  };
  const endResize = (e: React.PointerEvent<HTMLDivElement>) => {
    const d = dragRef.current;
    if (!d) return;
    dragRef.current = null;
    e.currentTarget.classList.remove("dragging");
    commitWidth(d.key, d.live);   // one drag is one preference change, ⊥ fifty
  };

  // Double-click the grip → fit the column to its widest visible cell. The cells are clipped (`overflow:
  // hidden`, one line), so each one's `scrollWidth` already IS its full content width — no measuring canvas and
  // no reflow needed. Only the RENDERED rows are measured, which is what "fit what I'm looking at" means.
  const autoSize = (key: string) => (e: React.MouseEvent<HTMLDivElement>) => {
    e.preventDefault();
    e.stopPropagation();
    const meta = RESIZABLE[key];
    if (!meta || !tableRef.current) return;
    let widest = 0;
    for (const cell of tableRef.current.querySelectorAll<HTMLElement>(`td.${meta.cls}`))
      widest = Math.max(widest, cell.scrollWidth);
    if (!widest) return;
    // Cell padding (8px each side) is inside scrollWidth for the text but not for the box it needs, so add it
    // back; +2 keeps the ellipsis from appearing on the very widest row.
    const next = Math.max(COL_MIN, Math.min(COL_MAX, widest + 18));
    paintWidth(key, next);
    commitWidth(key, next);
  };
  // Hover intent, not raw hover: see useHoverIntent — sweeping 700 rows must not build 700 tooltips.
  const { target: hover, show: showTip, hide: hideTip } = useHoverIntent<{ it: Item; x: number; y: number }>();

  const rows = useMemo(() => {
    const active = columns.filter((c) => filters[c.key]?.trim());
    let r = items.filter((it) =>
      active.every((c) => {
        const f = filters[c.key].trim();
        if (c.opts) return c.text ? c.text(it) === f : true; // dropdown = exact
        if (c.num) return numMatch(c.num(it), f);
        if (c.text) return c.text(it).toLowerCase().includes(f.toLowerCase());
        return true;
      }),
    );
    if (sort) {
      const col = columns.find((c) => c.key === sort.key);
      if (col) {
        const val = (it: Item): string | number => (col.num ? col.num(it) : col.text ? col.text(it).toLowerCase() : "");
        r = [...r].sort((a, b) => {
          const x = val(a), y = val(b);
          return (x < y ? -1 : x > y ? 1 : 0) * sort.dir;
        });
      }
    }
    return r;
  }, [items, columns, filters, sort]);

  // WINDOWED, not capped: an armory of 8k items is an ordinary long playthrough, and the point of this table is
  // working through it — so every row stays in the list and only the slice on screen is in the DOM. Filtering
  // and sorting above still run over everything.
  const win = useWindowed(rows.length, { scroll: wrapRef, rowH: 20 });
  const capped = rows.slice(win.start, win.end);

  const clickSort = (key: string) => setSort((s) => (s?.key === key ? { key, dir: s.dir === -1 ? 1 : -1 } : { key, dir: -1 }));
  const arrow = (key: string) => (sort?.key === key ? (sort.dir === -1 ? " ▼" : " ▲") : "");
  const setF = (key: string, v: string) => setFilters((f) => ({ ...f, [key]: v }));

  // The row set is built ONCE per data/sort/filter/selection change and reused across hover changes.
  // Hovering a row still flips `hover` state, which re-renders this component — but React skips a subtree
  // whose element reference is unchanged, so the table's hundreds of rows × ~15 cells are no longer
  // diffed every time the pointer crosses a row boundary. That per-row cost, not the per-pixel one, is
  // what was left making these tooltips feel heavier than the gear tab's (whose list is far shorter).
  const body = useMemo(() => (
    <tbody>
      {/* Spacers stand in for the undrawn rows, so the scrollbar measures the whole list. The cell is not
          optional: a `<tr>` with no cells collapses to zero height, the container's scrollHeight then covers
          only the drawn slice, and the browser clamping scrollTop against it fights the window forever. */}
      {win.padTop > 0 && (
        <tr aria-hidden="true"><td colSpan={columns.length} style={{ height: win.padTop, padding: 0, border: 0 }} /></tr>
      )}
      {capped.map((it, i) => (
        <tr
          ref={i === 0 ? win.measureRef : undefined}
          key={i}
          className={`row-click ${selected.has(exactKey(it)) ? "sel" : ""} ${flashed?.has(flashKey(it)) ? "flash" : ""}`}
          onClick={() => toggleSel(exactKey(it))}
          /* enter/leave only — ItemTooltip follows the cursor itself (no re-render per move) */
          onMouseEnter={(e) => showTip({ it, x: e.clientX, y: e.clientY })}
          onMouseLeave={hideTip}
        >
          {columns.map((c) => (
            <td key={c.key} className={c.cls ?? ""}>{c.cell(it)}</td>
          ))}
        </tr>
      ))}
      {win.padBottom > 0 && (
        <tr aria-hidden="true"><td colSpan={columns.length} style={{ height: win.padBottom, padding: 0, border: 0 }} /></tr>
      )}
    </tbody>
  ), [capped, win.padTop, win.padBottom, win.measureRef, columns, selected, flashed, toggleSel, showTip, hideTip]);

  // Memoized for the same reason as `body` — the header carries a live input/select per column, and
  // re-creating ~15 of them on every hover is pure waste.
  const head = useMemo(() => (
    <thead>
      <tr>
        {columns.map((c) => (
          <th key={c.key} className={`${c.cls ?? ""}${RESIZABLE[c.key] ? " resizable" : ""}`}>
            <div
              className={`th-label ${c.sortable ? "sortable" : ""}`}
              title={c.label}
              onClick={c.sortable ? () => clickSort(c.key) : undefined}
            >
              {c.label}
              {arrow(c.key)}
            </div>
            {/* Only the clipped text columns get a grip: everything else is one number and sizes itself. */}
            {RESIZABLE[c.key] && (
              <div
                className="th-grip"
                title="Drag to resize · double-click to fit"
                onPointerDown={beginResize(c.key, RESIZABLE[c.key].def)}
                onPointerMove={onResizeMove}
                onPointerUp={endResize}
                onPointerCancel={endResize}
                onDoubleClick={autoSize(c.key)}
              />
            )}
            {c.opts ? (
              <select value={filters[c.key] ?? ""} onChange={(e) => setF(c.key, e.target.value)}>
                <option value="">all</option>
                {c.opts.map((o) => (<option key={o} value={o}>{o}</option>))}
              </select>
            ) : (
              <input value={filters[c.key] ?? ""} onChange={(e) => setF(c.key, e.target.value)} placeholder={c.num ? "≥ / !=0" : "filter"} />
            )}
          </th>
        ))}
      </tr>
    </thead>
    // eslint-disable-next-line react-hooks/exhaustive-deps -- clickSort/setF/arrow are render-stable closures over state setters
  ), [columns, filters, sort]);

  if (!items.length) return <p className="hint">(none)</p>;
  return (
    <div className="grid-wrap-outer">
      {confirmUi}
      <Notice msg={gridMsg} onClose={() => setGridMsg(null)} />
    <div className="grid-wrap" ref={wrapRef}>
      {/* Dragged widths ride as custom properties on the table, so the CSS keeps the defaults and one style
          object covers header and body cells alike. */}
      <table
        className="grid"
        ref={tableRef}
        style={{
          ...(colW.__sub ? { "--sub-w": `${colW.__sub}px` } : {}),
          ...(colW.__asp ? { "--asp-w": `${colW.__asp}px` } : {}),
        } as React.CSSProperties}
      >
        {head}
        {body}
      </table>
      <div className="hint">{rows.length.toLocaleString()}/{items.length.toLocaleString()} shown</div>
    </div>
      {hover && <ItemTooltip it={hover.it} x={hover.x} y={hover.y} equipped={equipped} role={role} conn={conn} />}
    </div>
  );
}

// Comparison popup: hovered item + one full panel per equipped item of the same slot & type,
// each panel showing a Δ (equipped − hovered) per stat. Info-only (follows the cursor).
// The inventory grid and the opportunity rails hover the SAME card every other tab uses (see ItemCard.tsx).
// This wrapper only decides WHAT to compare against: the equipped items that share the hovered item's slot and
// size, which is the question the inventory view is asking.
function ItemTooltip({ it, x, y, equipped, role, conn }: { it: Item; x: number; y: number; equipped?: Item[]; role?: string | null; conn: Conn }) {
  // Falls back to kind+size until the bridge sends slotType.
  const matches = (equipped ?? []).filter(
    (e) =>
      e.size === it.size &&
      (it.slotType && e.slotType ? e.slotType === it.slotType : kindOf(e) === kindOf(it)),
  );
  return (
    <ItemTip it={it} x={x} y={y} conn={conn} role={role}
      others={matches.slice(0, 4).map((e) => ({ it: e, label: "equipped" }))} />
  );
}

function OpportunityList({ opps, equipped, showCost, role, credits, conn, docked, onBought, ranking }: {
  opps: Opp[]; equipped: Item[]; showCost?: boolean; role?: string | null; credits?: number | null;
  ranking?: Ranking;
  conn: Conn; docked?: boolean; onBought?: () => void;
}) {
  // Buying spends credits (or barter goods) and can't be undone, so each purchase is confirmed with its
  // price. `busy` is the offer handle in flight, which also stops a double-click buying twice.
  const [busy, setBusy] = useState<string | null>(null);
  const [buyMsg, setBuyMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const { ask, ui: confirmUi } = useConfirm();
  // ctrl/⌘-click buys straight away — the confirm is there to stop an accidental spend, not to slow down
  // someone deliberately clearing a shortlist.
  // Why this purchase can't happen, in words - or null when it can. Mirrors the bridge's own checks so
  // the two can't disagree; the bridge remains the authority.
  const blockedBecause = (o: Opp): string | null => {
    if (!docked) return undockedMsg;
    const it = o.item;
    if (it.costItem) {
      const need = it.costItemCount ?? 0, have = it.costItemOwned ?? 0;
      return have >= need ? null : barterMsg(need, have, it.costItem);
    }
    const cost = it.cost ?? 0;
    if (credits == null || cost <= credits) return null;
    return brokeMsg(cost, credits);
  };

  const buy = async (o: Opp, skipConfirm = false) => {
    const it = o.item;
    if (it.key == null || !it.location) return;
    const handle = `${it.location}:${it.key}`;
    // Latch claimed around the confirmation, not after it — see doBuy.
    setBusy(handle); setBuyMsg(null);
    try {
      const price = priceLabel(it) ?? `${(it.cost ?? 0).toLocaleString()} cr`;
      if (!skipConfirm && !(await ask({ title: `Buy ${it.name} for ${price}?`, detail: affordLine(it, credits ?? null), confirmLabel: "Buy" }))) return;
      const r = await api.buy(conn, it.location, it.key, 1, buyExpect(it));
      setBuyMsg({ ok: true, text: `Bought ${it.name}${r.barter ? " (barter)" : ` for ${r.spent.toLocaleString()} cr`}.` });
      onBought?.();
    } catch (e) {
      setBuyMsg({ ok: false, text: e instanceof ApiError ? e.message : String(e) });
    } finally {
      setBusy(null);
    }
  };
  const types = useMemo(() => [...new Set(opps.map((o) => o.item.type).filter((t): t is string => !!t))].sort(), [opps]);
  const [hiddenTypes, setHiddenTypes] = useState<Set<string>>(new Set());
  const [affOnly, setAffOnly] = useState(false);
  // Hover intent, not raw hover: see useHoverIntent — sweeping 700 rows must not build 700 tooltips.
  const { target: hover, show: showTip, hide: hideTip } = useHoverIntent<{ it: Item; x: number; y: number }>();
  const toggle = (t: string) =>
    setHiddenTypes((s) => {
      const n = new Set(s);
      if (n.has(t)) n.delete(t);
      else n.add(t);
      return n;
    });
  // Affordable = barter → own enough of the cost item; else cost within current credits.
  const affordable = (o: Opp) =>
    o.item.costItem != null
      ? (o.item.costItemOwned ?? 0) >= (o.item.costItemCount ?? 0)
      : credits == null || o.item.cost == null || o.item.cost <= credits;
  // Says which number the rail is showing, since the Gear tab's ranking decides it.
  const oppMetric = ranking === "expanded"
    ? "Gain in the WHOLE battery's estimated DPS (expanded ranking), for the slot named beside the type — the same objective the gear optimizer uses. The same item can be a downgrade in another slot."
    : "Gain in the headline main stat (simple ranking).";
  const shown = opps.filter((o) => !hiddenTypes.has(o.item.type ?? "") && (!affOnly || affordable(o)));
  // Row list memoized so hovering one doesn't rebuild the whole rail (same reasoning as the grid body).
  const list = useMemo(() => (
    <div className="opp-list">
      {shown.map((o, i) => (
        <div
          key={i}
          className="opp-row"
          onMouseEnter={(e) => showTip({ it: o.item, x: e.clientX, y: e.clientY })}
          onMouseLeave={hideTip}
        >
          <span className={`opp-name r-${o.item.rarity}`}>{o.item.name}</span>
          <span className={`opp-d ${o.delta >= 0 ? "up" : "switch"}`} title={o.delta < 0 ? "lower than equipped — a type switch to match your slot filter" : oppMetric}>{o.delta >= 0 ? "+" : ""}{num(o.delta)}</span>
          <span className="opp-type dim">{o.item.type}{o.slotLabel ? ` · ${o.slotLabel}` : ""}</span>
          {showCost && (
            <span className={`opp-cost ${affordable(o) ? "dim" : "down"}`}><Price it={o.item} conn={conn} /></span>
          )}
          {showCost && o.item.key != null && o.item.location && (() => {
              const why = blockedBecause(o);
              const handle = `${o.item.location}:${o.item.key}`;
              return (
                // Deliberately NOT `disabled` when merely unaffordable: a disabled button swallows the
                // click, so the reason would never be seen. It looks refused and says why when pressed.
                <button
                  className={`opp-buy${why ? " blocked" : ""}`}
                  disabled={busy === handle}
                  title={why ?? `Buy ${o.item.name} from ${o.item.location}: ${affordLine(o.item, credits ?? null)} — ctrl+click skips the confirmation`}
                  onClick={(e) => {
                    e.stopPropagation();
                    if (why) { setBuyMsg({ ok: false, text: why }); return; }
                    void buy(o, e.ctrlKey || e.metaKey);
                  }}
                >{busy === handle ? "…" : "buy"}</button>
              );
            })()}
        </div>
      ))}
    </div>
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `shown`/`affordable` derive from these
  ), [opps, hiddenTypes, affOnly, showCost, credits, showTip, hideTip, docked, busy, buyMsg]);
  return (
    <div>
      {confirmUi}
      {(types.length > 1 || showCost) && (
        <div className="opp-filter">
          {showCost && <button className={`asp-chip${affOnly ? " on" : ""}`} onClick={() => setAffOnly((v) => !v)}>affordable</button>}
          <Pills options={types} isOn={(t) => !hiddenTypes.has(t)} onToggle={toggle} />
        </div>
      )}
      <Notice msg={buyMsg} onClose={() => setBuyMsg(null)} />
      {list}
      {hover && <ItemTooltip it={hover.it} x={hover.x} y={hover.y} equipped={equipped} role={role} conn={conn} />}
    </div>
  );
}



