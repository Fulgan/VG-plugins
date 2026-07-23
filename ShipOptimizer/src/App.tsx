import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { ApiError, api, loadConn, saveConn, type Conn } from "./api";
import { useEvents } from "./useEvents";
import { itemImage, itemWiki } from "./wikiLinks";
import { isRoleStat } from "./roleStats";
import OfficersTab, { useOfficerBuilder, type BuilderShip } from "./OfficersTab";
import { evaluateRecruits, type RecruitOfficer } from "./officer";
import SummaryTab from "./SummaryTab";
import BoostersTab, { useBoosterBuilder } from "./BoostersTab";
import { boosterType, boosterValue, isBooster } from "./booster";
import GearTab, { useGearBuilder, turretFits, isTurret, type GearFilter } from "./GearTab";
import { loadProfile, saveProfile, type ActivityProfile } from "./activityPresets";
import type { CatalogTypes, Inventories, Item, Loadout, LoadoutPresetInfo, LogEntry, Officers, Recruits, ShipHardpoint, ShipLayout, StatLine, Status } from "./types";
import "./App.css";

type Tab = "inventory" | "officers" | "boosters" | "gear" | "summary";
const TABS: Tab[] = ["inventory", "officers", "boosters", "gear", "summary"];
// Hash router: the active tab lives in the URL (#/gear) so a tab is directly addressable / bookmarkable
// and the browser back/forward buttons move between tabs. Unknown/empty hash → inventory.
const tabFromHash = (): Tab => {
  const h = location.hash.replace(/^#\/?/, "");
  return (TABS as string[]).includes(h) ? (h as Tab) : "inventory";
};

// Last docked snapshot, persisted so it survives reloads / jumps while undocked.
const SNAP_KEY = "shipoptimizer.snapshot";
interface Snap { inv: Inventories | null; loadout: Loadout | null; shops: Item[]; layout?: ShipLayout | null }

// Identity for change-detection (location + name + rarity + level), count excluded.
const flashKey = (it: Item) => `${it.location ?? ""}|${it.name}|${it.rarity}|${it.level}`;

// Full item identity for exact-match line select. Items can only change by aspect, quality (rarity up)
// or one rerolled substat, so an exact match pins the same physical item: type/size/level/aspect-slot
// count/main-stat value/rarity + the exact aspect set + the exact substat set (stat, amount, reroll
// flag). Two rows sharing this key are the same item; clicking one selects them all.
const exactKey = (it: Item) =>
  [
    it.type ?? "", it.size ?? "", it.level, it.aspectSlots ?? 0, it.rarity, it.mainStat?.amount ?? "",
    it.gameplayType ?? "", it.targetLayer ?? "", // surface vs core mining/salvage turrets are distinct
    (it.aspects ?? []).map((a) => a.name).sort().join(","),
    (it.stats ?? []).map((s) => `${s.stat}=${s.amount}:${s.canReroll ? 1 : 0}`).sort().join(","),
  ].join("|");

// Ship image, loaded dynamically from the wiki (MediaWiki Special:FilePath redirects "<Name>.png" to
// the real file; `?width=128` serves a light thumbnail). Dynamic on purpose — new ships resolve with
// no bundle to maintain. Most ships match display-name-with-underscores; a few don't, so the <img>
// hides on error. Requires network; offline just shows no image.
const shipImg = (shipType?: string | null) =>
  shipType ? `https://wiki.vanguardgalaxy.com/Special:FilePath/${encodeURIComponent(shipType.replace(/ /g, "_"))}.png?width=128` : null;
function loadSnap(): Snap | null {
  try { const r = localStorage.getItem(SNAP_KEY); return r ? (JSON.parse(r) as Snap) : null; } catch { return null; }
}
function saveSnap(s: Snap) {
  try { localStorage.setItem(SNAP_KEY, JSON.stringify(s)); } catch { /* quota — ignore */ }
}

const num = (n: number) => Number(n.toFixed(2)).toString();

// Pill/badge toggles (like the aspect OR-filter) — a button per option, highlighted when "on".
function Pills({ options, isOn, onToggle }: { options: string[]; isOn: (o: string) => boolean; onToggle: (o: string) => void }) {
  return <>{options.map((o) => <button key={o} className={`asp-chip${isOn(o) ? " on" : ""}`} onClick={() => onToggle(o)}>{o}</button>)}</>;
}

// The client config (categories, per-ship gear filters, activity profile, connection) — every
// "shipoptimizer.*" key except the transient snapshot/log — as pretty JSON.
const CFG_SKIP = new Set(["shipoptimizer.snapshot", "shipoptimizer.summaryLog"]);
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
const JSON_KEYS = ["shipoptimizer.turretCategories", "shipoptimizer.gearFilters", "shipoptimizer.conn", "shipoptimizer.officerBuilder", "shipoptimizer.activityProfile"];
function validateConfig(raw: string): { errors: string[]; cfg?: Record<string, string> } {
  let obj: unknown;
  try { obj = JSON.parse(raw); } catch (e) { return { errors: ["Not valid JSON: " + (e as Error).message] }; }
  if (typeof obj !== "object" || obj === null || Array.isArray(obj)) return { errors: ["Root must be a JSON object of key → value."] };
  const errors: string[] = [];
  const cfg = obj as Record<string, unknown>;
  for (const [k, v] of Object.entries(cfg)) {
    if (!k.startsWith("shipoptimizer.")) { errors.push(`unexpected key "${k}"`); continue; }
    if (typeof v !== "string") { errors.push(`"${k}" must be a string`); continue; }
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
  // Close on Escape only — not on backdrop click, so a stray click doesn't discard edits.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  const validate = () => { const { errors } = validateConfig(text); setMsg(errors.length ? `✗ ${errors.length} problem(s): ${errors.slice(0, 4).join("; ")}${errors.length > 4 ? " …" : ""}` : "✓ Valid — safe to apply."); };
  const apply = () => {
    const { errors, cfg } = validateConfig(text);
    if (errors.length || !cfg) { setMsg(`✗ Not applied — ${errors.slice(0, 4).join("; ")}${errors.length > 4 ? " …" : ""}`); return; }
    for (const [k, v] of Object.entries(cfg)) localStorage.setItem(k, v);
    location.reload();
  };
  return (
    <div className="cfg-back">
      <div className="cfg-pop" onClick={(e) => e.stopPropagation()}>
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
      </div>
    </div>
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
  // Close on Escape only — NOT on backdrop click, so a stray click while editing the name/JSON
  // doesn't discard the popin.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div className="cfg-back">
      <div className="cfg-pop" onClick={(e) => e.stopPropagation()}>
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
          {msg && <div className="dim" style={{ marginTop: 8 }}>{msg}</div>}
        </div>
      </div>
    </div>
  );
}

function cell(line: StatLine | undefined): string {
  if (!line) return "";
  if (line.multiplier && line.multiplier !== 1) return `×${Number(line.multiplier.toFixed(3))}`;
  return num(line.amount);
}

// Readable substat, tooltip-style: "+817 ShieldHP" or "×1.03 CriticalDamage".
function subFmt(l: StatLine): string {
  if (l.multiplier && l.multiplier !== 1) return `×${Number(l.multiplier.toFixed(3))} ${l.stat}`;
  return `${l.amount >= 0 ? "+" : ""}${num(l.amount)} ${l.stat}`;
}

// Never-shown item classes.
const EXCLUDE_KINDS = ["ammo", "aspect", "deploy", "drone", "defensiveturret"];

// Classify an item as equipment we care about, or null to always exclude it.
function kindOf(it: Item): "Turret" | "Module" | "Booster" | null {
  const c = (it.category ?? "").toLowerCase();
  const t = (it.type ?? "").toLowerCase();
  if (EXCLUDE_KINDS.some((e) => c.includes(e))) return null;
  if (!it.stats?.length) return null; // no stats ⇒ ammo/consumable/etc.
  if (c.includes("turret") || t.endsWith("turret")) return "Turret";
  if (c.includes("booster") || t.endsWith("booster")) return "Booster";
  return "Module";
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
  const [inv, setInv] = useState<Inventories | null>(() => loadSnap()?.inv ?? null);
  const [loadout, setLoadout] = useState<Loadout | null>(() => loadSnap()?.loadout ?? null);
  const [shops, setShops] = useState<Item[]>(() => loadSnap()?.shops ?? []);
  const [seenStation, setSeenStation] = useState<string | null>(() => localStorage.getItem("shipoptimizer.station"));
  const [log, setLog] = useState<LogEntry[]>([]);
  const [stale, setStale] = useState(false);
  const [cfgOpen, setCfgOpen] = useState(false);
  const [toolsOpen, setToolsOpen] = useState(false);
  const [presetsNonce, setPresetsNonce] = useState(0); // bumped on claim → SummaryTab reloads its preset list
  const [flashed, setFlashed] = useState<Set<string>>(new Set());
  const prevCounts = useRef<Map<string, number>>(new Map());
  const playthroughRef = useRef<string | null>(localStorage.getItem("shipoptimizer.playthrough"));
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
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

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const s = await api.status(conn);
      setStatus(s);
      // New playthrough → drop stale cached inventory/loadout/shops/layout (they belong to the old save).
      if (s.playthrough && s.playthrough !== playthroughRef.current) {
        playthroughRef.current = s.playthrough;
        localStorage.setItem("shipoptimizer.playthrough", s.playthrough);
        localStorage.removeItem(SNAP_KEY);
        setInv(null); setLoadout(null); setShops([]); setLayout(null); setOfficers(null); setRecruits(null);
      }
      if (s.station) {
        setSeenStation(s.station);
        localStorage.setItem("shipoptimizer.station", s.station);
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
          const live = await api.inventories(conn); // cargo only when undocked
          const cargo = live.stores.filter((st) => st.id === "cargo");
          setInv((prev) => ({ stores: [...cargo, ...(prev?.stores ?? []).filter((st) => st.id !== "cargo")] }));
        } catch { /* keep snapshot */ }
        return;
      }
      setStale(false);

      const invData = await api.inventories(conn);
      setInv(invData);
      let ld: Loadout | null = null;
      try {
        ld = await api.loadout(conn);
      } catch (e) {
        if (!(e instanceof ApiError && e.status === 403)) throw e;
      }
      setLoadout(ld);
      let lay: ShipLayout | null = null;
      try { lay = await api.shipLayout(conn); } catch { /* keep null */ }
      setLayout(lay); // hardpoint positions for the gear editor
      const shopData = (await api.shops(conn)).shops
        .flatMap((shop) => shop.items.map((it) => ({ ...it, location: shop.facility })))
        .filter((it) => kindOf(it) !== null);
      setShops(shopData);
      saveSnap({ inv: invData, loadout: ld, shops: shopData, layout: lay }); // persist last docked snapshot

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
  const { connected: live } = useEvents(conn, true, (e) => {
    if (e.type === "echo") setEcho(!!e.active);
    else if (e.type === "log") setLog((l) => [...l, { t: e.t ?? "", source: e.source ?? "", text: e.text ?? "" }].slice(-200));
    else debouncedRefresh();
  });

  const currentItems: Item[] = useMemo(
    () =>
      loadout
        ? [...(loadout.hardpoints ?? []), ...(loadout.modules ?? []).map((m) => m.item), ...(loadout.boosters ?? [])]
        : [],
    [loadout],
  );

  const equippable: Item[] = useMemo(() => {
    const out: Item[] = [];
    for (const store of inv?.stores ?? [])
      for (const it of store.items) if (kindOf({ ...it }) !== null) out.push({ ...it, location: store.id });
    return out;
  }, [inv]);

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
  const loadoutShown = useMemo(() => currentItems.filter(passes), [currentItems, hidden]);

  const stationLabel = status?.station ?? status?.lastStation ?? seenStation;
  const role = status?.role ?? null;
  // Opportunities must compare like-for-like within a slot+size group, else a candidate ranked by
  // one stat "beats" an equipped item ranked by another (a scanner's Precision vs an equipped
  // scanner's Combat Power). Two consistent bases:
  //  - main stat: the same stat for every item of a slot family (Precision vs Precision). Broad view.
  //  - role stat: the ship-role stat, null when the item lacks it → excluded from role comparisons.
  // Missing role stat = 0 (not null): an item that *adds* the ship's role stat where the equipped one
  // has none is still an upgrade for that slot (e.g. a Hull Kit that adds Mining Power). Within a
  // slot+size group everything shares 0 when none carry the stat, so no false upgrades appear.
  // Turret opportunities respect the Gear-tab per-slot config (filter/category); modules & boosters use
  // the generic slot+size comparison. Ranked by gain (delta) across all three.
  const gearBuilder = useGearBuilder(layout, inv);
  const boosterBuilder = useBoosterBuilder(loadout, inv);
  const oppsFor = useCallback((src: Item[]) => {
    const cands = src.filter(passes);
    const turrets = gearTurretOpps(cands.filter(isTurret), gearBuilder.hps, gearBuilder.filters, gearBuilder.cats);
    const boosters = gearBoosterOpps(cands.filter(isBooster), boosterBuilder.slotTypes, boosterBuilder.equippedBySlot);
    const other = opportunities(cands.filter((i) => !isTurret(i) && !isBooster(i)), currentItems.filter((i) => !isTurret(i) && !isBooster(i)), mainVal);
    return [...turrets, ...boosters, ...other].sort((a, b) => b.delta - a.delta);
  }, [passes, currentItems, gearBuilder, boosterBuilder]);
  const invOpps = useMemo(() => oppsFor(equippable), [equippable, hidden, oppsFor]);
  const shopOpps = useMemo(() => oppsFor(shops), [shops, hidden, oppsFor]);
  const credits = status?.credits ?? null;

  // Officer optimizer: ships with officer slots (from /officers) joined with names/roles (from /ships),
  // current ship first. The builder hook drives both the Officers and Summary tabs.
  const shipList: BuilderShip[] = useMemo(() => {
    const byGuid = new Map(shipsAll.map((l) => [l.shipGuid, l]));
    return (officers?.ships ?? [])
      .filter((s) => s.slots > 0)
      .map((s) => {
        const ld = byGuid.get(s.shipGuid);
        return { guid: s.shipGuid, name: ld?.name ?? ld?.shipType ?? s.shipGuid, role: ld?.role ?? null, slots: s.slots, hasDroneBay: s.hasDroneBay, assigned: s.assigned ?? [] };
      })
      .sort((a, b) => Number(b.guid === status?.shipGuid) - Number(a.guid === status?.shipGuid));
  }, [officers, shipsAll, status?.shipGuid]);
  const builder = useOfficerBuilder(officers?.officers ?? [], shipList);
  const portraitUrl = useCallback((guid: string | null) => api.portraitUrl(conn, guid), [conn]);
  const crewSupported = !!status?.crewSupported;
  // #/officers is dead on the release game (no crew) — bounce it back to inventory.
  useEffect(() => { if (tab === "officers" && status && !crewSupported) setTab("inventory"); }, [tab, crewSupported, status, setTab]);

  // Global activity profile — shared across all optimizers, drives the priority-suggestion presets.
  const [profile, setProfileState] = useState<ActivityProfile>(loadProfile);
  const setProfile = useCallback((p: ActivityProfile) => { setProfileState(p); saveProfile(p); }, []);

  // Count of station recruits that would out-rank an assigned officer → Officers-tab badge.
  // Station recruits that out-rank an assigned officer — surfaced on the inventory tab's opportunity rail.
  // Total pending changes (officers + boosters + gear) → Summary tab badge.
  const summaryChanges = useMemo(() => {
    const oShip = builder.ship;
    const onCur = !!oShip && oShip.guid === status?.shipGuid;
    const asg = new Set((oShip?.assigned ?? []).filter((g): g is string => !!g));
    const chosen = new Set((builder.result?.chosen ?? []).map((o) => o.guid));
    const join = (builder.result?.chosen ?? []).filter((o) => !asg.has(o.guid)).length;
    const leave = builder.officers.filter((o) => asg.has(o.guid) && !chosen.has(o.guid)).length;
    const off = crewSupported && onCur ? Math.max(join, leave) : 0;
    return off + boosterBuilder.applyPayload.length + gearBuilder.changes.length;
  }, [builder, boosterBuilder, gearBuilder, status?.shipGuid, crewSupported]);

  const officerOpps = useMemo(() => {
    if (!recruits?.hasPersonnelCenter || !builder.ship || !builder.result) return [];
    return evaluateRecruits(
      recruits.officers as RecruitOfficer[],
      { role: builder.ship.role, hasDroneBay: builder.ship.hasDroneBay, priorities: builder.prio, scope: builder.scope },
      builder.result.chosen,
    ).filter((o) => o.isOpp);
  }, [recruits, builder.ship, builder.result, builder.prio, builder.scope]);
  const officerOppCount = officerOpps.length;

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
            {status.role && <span className="role"> {status.role}</span>} · {status.credits.toLocaleString()} cr
            {echo && <span className="echo"> ECHO</span>}
          </span>
        )}
        <button onClick={() => setCfgOpen(true)} title="Export / import categories, filters & settings">Config</button>
        <button className="tools-btn" onClick={() => setToolsOpen(true)} title="Tools — reclaim orphaned loadouts & maintenance" aria-label="Tools">⋯</button>
        {status && <span className="versions" title="Game / Hypercom plugin version">game {status.gameVersion ?? "?"} · plugin {status.pluginVersion ?? "?"}</span>}
        <span className="spacer" />
        <ConnPanel conn={conn} onSave={(c) => { setConn(c); saveConn(c); }} onRefresh={refresh} loading={loading} />
      </header>

      {cfgOpen && <ConfigDialog onClose={() => setCfgOpen(false)} />}
      {toolsOpen && <ToolsDialog conn={conn} playthrough={status?.playthrough ?? null} playthroughName={status?.playthroughName ?? null} onClose={() => setToolsOpen(false)} onChanged={() => { setPresetsNonce((n) => n + 1); refresh(); }} />}
      {error && <div className="error">⚠ {error}</div>}
      {stale && (
        <div className="stale">
          ⚠ Undocked — cargo is live; armory / material / shop / loadout are from the last dock{stationLabel ? ` at ${stationLabel}` : ""}.
        </div>
      )}

      <nav className="tabs">
        <button className={tab === "inventory" ? "on" : ""} onClick={() => setTab("inventory")}>
          Inventory &amp; opportunities
          {invOpps.length > 0 && <span className="opp-badge inv" title="Inventory items that beat something equipped">{invOpps.length} inv</span>}
          {shopOpps.length > 0 && <span className="opp-badge shop" title="Shop items at this station that beat something equipped">{shopOpps.length} shop</span>}
        </button>
        {crewSupported && (
          <button className={tab === "officers" ? "on" : ""} onClick={() => setTab("officers")}>
            Officers
            {officerOppCount > 0 && <span className="opp-badge hire" title="Recruitable officers that would out-rank an assigned one">{officerOppCount} hire</span>}
          </button>
        )}
        <button className={tab === "boosters" ? "on" : ""} onClick={() => setTab("boosters")}>Boosters</button>
        <button className={tab === "gear" ? "on" : ""} onClick={() => setTab("gear")}>Ship gear</button>
        <button className={tab === "summary" ? "on" : ""} onClick={() => setTab("summary")}>Summary{summaryChanges > 0 && <span className="opp-badge apply" title="Pending changes to apply">{summaryChanges}</span>}</button>
      </nav>

      {tab === "officers" && <OfficersTab builder={builder} portraitUrl={portraitUrl} recruits={recruits} portraitByIcon={(icon) => api.portraitByIcon(conn, icon)} profile={profile} setProfile={setProfile} goSummary={() => setTab("summary")} />}
      {tab === "boosters" && <BoostersTab builder={boosterBuilder} docked={!!status?.docked} goSummary={() => setTab("summary")} />}
      {tab === "gear" && <GearTab layout={layout} builder={gearBuilder} catalog={catTypes} conn={conn} docked={!!status?.docked} currentShipGuid={status?.shipGuid ?? null} goSummary={() => setTab("summary")} />}
      {tab === "summary" && (
        <SummaryTab officer={builder} boosters={boosterBuilder} gear={gearBuilder} portraitUrl={portraitUrl} conn={conn}
          crewSupported={crewSupported} docked={!!status?.docked} currentShipGuid={status?.shipGuid ?? null} playthrough={status?.playthrough ?? null} playthroughName={status?.playthroughName ?? null} reloadNonce={presetsNonce} onChanged={refresh} />
      )}

      {tab === "inventory" && (<>
      <div className="globals">
        <b>Show:</b>
        <Pills options={["Turret", "Booster", ...moduleTypes]} isOn={(o) => !hidden.has(o)} onToggle={toggleHidden} />
        {hidden.size > 0 && <button onClick={() => setHidden(new Set())}>show all</button>}
      </div>


      <div className="layout">
        <aside className="side">
          <div className="opp-panel">
            <div className="opp-head">
              <h2>Opportunities from inventories</h2>
            </div>
            {loadout ? (
              invOpps.length ? <OpportunityList opps={invOpps} equipped={currentItems} role={role} /> : <p className="hint">none better than equipped</p>
            ) : (
              <p className="hint">dock to see upgrades</p>
            )}
          </div>
        </aside>

        <main className="center">
          <section>
            <h2>
              Inventory <small>{invShown.length}/{equippable.length} items{loadout ? "" : " · undocked (cargo only)"}</small>
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
              <span className="hint">per-column filters below: text = substring; numbers = <code>&gt;=100</code>, <code>!=0</code>, <code>&lt;5</code>, <code>=3</code></span>
            </div>
            <ItemGrid items={invShown} showWhere equipped={currentItems} role={role} flashed={flashed} />
          </section>

          <section>
            <h2>
              Station shop{" "}
              {stationLabel && <small>@ {stationLabel}{status && !status.docked ? " (last visited)" : ""}</small>}{" "}
              <small>{shopShown.length}/{shops.length} items</small>
            </h2>
            {shopShown.length ? (
              <ItemGrid items={shopShown} showShop equipped={currentItems} role={role} flashed={flashed} />
            ) : (
              <p className="hint">No shop items (dock at a station with a shop).</p>
            )}
          </section>

          <section>
            <h2>Current loadout {loadout && <small>{loadout.name}</small>}</h2>
            {loadout ? <ItemGrid items={loadoutShown} equipped={currentItems} role={role} /> : <p className="hint">Dock at a station to read the loadout.</p>}
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
              <p className="hint">No events captured yet (the bridge logs game notifications + events as they happen).</p>
            )}
          </section>
        </main>

        <aside className="side">
          <div className="opp-panel">
            <div className="opp-head">
              <h2>Opportunities from shop</h2>
            </div>
            {loadout ? (
              shopOpps.length ? <OpportunityList opps={shopOpps} equipped={currentItems} showCost role={role} credits={credits} /> : <p className="hint">none better than equipped</p>
            ) : (
              <p className="hint">dock to see upgrades</p>
            )}
          </div>

          {crewSupported && (
            <div className="opp-panel officer-opps">
              <div className="opp-head"><h2>Officer hires <small className="dim">{builder.ship ? `for ${builder.ship.name}` : ""}</small></h2></div>
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
              ) : <p className="hint">{recruits?.hasPersonnelCenter ? "none better than your crew" : "dock at a station with a Personnel Center"}</p>}
            </div>
          )}
        </aside>
      </div>
      </>)}
    </div>
  );
}

// Ship image: the game's own sprite (the actual current-fit ship) first; on error the wiki thumbnail;
// then hidden. Keyed by ship guid so switching ships restarts the fallback chain.
function ShipImg({ conn, guid, shipType }: { conn: Conn; guid: string | null; shipType: string }) {
  const [stage, setStage] = useState(guid ? 0 : 1);
  const src = stage === 0 ? api.shipImageUrl(conn, guid) : stage === 1 ? shipImg(shipType) : null;
  if (!src) return null;
  return <img className="ship-img" src={src} alt={shipType} title={shipType} onError={() => setStage((s) => s + 1)} />;
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

const statVal = (it: Item, name: string): number => {
  const l = it.stats.find((s) => s.stat === name);
  return l ? (l.multiplier && l.multiplier !== 1 ? l.multiplier : l.amount) : 0;
};

// Numeric value of an item's main stat (Combat Power for weapons; the key stat per module type).
// Parses the game's formatted amount: "4,338", "540.9", "1.2M", and signed/percent forms like
// "+68%" or "-5%" (% is a plain multiplier-style headline — take the number, drop the sign glyph).
// null if the item has no main stat or nothing numeric to parse.
function mainVal(it: Item): number | null {
  if (!it.mainStat) return null;
  const m = it.mainStat.amount.replace(/,/g, "").match(/([+-]?\d+(?:\.\d+)?)\s*([KMBT%]?)/i);
  if (!m) return null;
  const mult: Record<string, number> = { "": 1, K: 1e3, M: 1e6, B: 1e9, T: 1e12, "%": 1 };
  return parseFloat(m[1]) * (mult[m[2].toUpperCase()] ?? 1);
}

// Grouping key for "comparable" gear: slot + size. Boosters carry no slotType, so group them by
// function (type) — a Combat booster competes only with Combat boosters, not Mining/Scanner ones.
// Mining/salvage turrets also split by target layer (surface vs core) — a ship needs both, so a
// surface turret must not be compared against a core one.
const groupKey = (it: Item) => {
  const slot = it.slotType ?? kindOf(it) ?? "";
  const fn = it.slotType ? "" : it.type ?? "";
  const layer = it.targetLayer && it.targetLayer !== "Both" ? it.targetLayer : "";
  return `${slot}|${it.size ?? ""}|${fn}|${layer}`;
};

export interface Opp {
  item: Item;
  replaces: Item; // weakest equipped in the same slot+size
  delta: number;
}

// Candidates whose value (role stat if any, else main stat) beats the weakest equipped item in the
// same slot+size group.
function opportunities(cands: Item[], equipped: Item[], val: (it: Item) => number | null): Opp[] {
  const groups = new Map<string, Item[]>();
  for (const e of equipped) {
    if (val(e) == null) continue;
    const k = groupKey(e);
    (groups.get(k) ?? groups.set(k, []).get(k)!).push(e);
  }
  const out: Opp[] = [];
  for (const c of cands) {
    const cv = val(c);
    if (cv == null) continue;
    const g = groups.get(groupKey(c));
    if (!g || !g.length) continue;
    let weakest = g[0];
    let wv = val(g[0])!;
    for (const e of g) {
      const ev = val(e)!;
      if (ev < wv) { wv = ev; weakest = e; }
    }
    if (cv > wv) out.push({ item: c, replaces: weakest, delta: cv - wv });
  }
  // Dedupe to the best instance per item name — many rolled copies of the same item otherwise
  // flood the list (5× "Combat R-Booster Mk.XVI"); keep the strongest, drop the rest.
  const best = new Map<string, Opp>();
  for (const o of out) {
    const prev = best.get(o.item.name);
    if (!prev || o.delta > prev.delta) best.set(o.item.name, o);
  }
  return [...best.values()].sort((a, b) => b.delta - a.delta);
}

// Config-aware turret opportunities: per hardpoint, rank candidates that fit the slot's CONFIGURED
// filter (Gear tab) and beat the equipped turret's main stat. Best instance per item name, biggest gain first.
function gearTurretOpps(cands: Item[], hps: ShipHardpoint[], filters: Record<number, GearFilter>, cats: Record<string, string[]>): Opp[] {
  const best = new Map<string, Opp>();
  for (const hp of hps) {
    const eq = hp.equipped;
    if (!eq) continue; // empty slots are filled from the Gear tab
    const f = filters[hp.index] ?? { mode: "all" };
    const eqPow = mainVal(eq) ?? 0;
    const eqMatches = turretFits(eq, hp.size, f, cats);
    for (const c of cands) {
      if (!turretFits(c, hp.size, f, cats)) continue;
      const cv = mainVal(c);
      if (cv == null) continue;
      // Right type already equipped → upgrades only. Wrong type (filter set, equipped doesn't match) →
      // offer any candidate of the configured type, even at lower power (a deliberate type switch).
      if (eqMatches && cv <= eqPow) continue;
      const delta = cv - eqPow;
      const prev = best.get(c.name);
      if (!prev || delta > prev.delta) best.set(c.name, { item: c, replaces: eq, delta });
    }
  }
  return [...best.values()].sort((a, b) => b.delta - a.delta);
}

// Config-aware booster opportunities: per booster slot, candidates of the slot's CONFIGURED type that
// beat the equipped booster's value.
function gearBoosterOpps(cands: Item[], slotTypes: (string | null)[], equippedBySlot: (Item | null)[]): Opp[] {
  const best = new Map<string, Opp>();
  slotTypes.forEach((type, i) => {
    if (!type) return;
    const eq = equippedBySlot[i];
    if (!eq) return; // upgrades only
    const eqVal = boosterValue(eq);
    for (const c of cands) {
      if (boosterType(c) !== type) continue;
      const v = boosterValue(c);
      if (v <= eqVal) continue;
      const delta = v - eqVal;
      const prev = best.get(c.name);
      if (!prev || delta > prev.delta) best.set(c.name, { item: c, replaces: eq, delta });
    }
  });
  return [...best.values()].sort((a, b) => b.delta - a.delta);
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

// Dense grid: fixed columns + one column per stat. Click a header to sort (first click desc).
// A filter row under the header filters each column (text substring; numeric operators).
function ItemGrid({
  items, showWhere, showShop, equipped, role, flashed,
}: { items: Item[]; showWhere?: boolean; showShop?: boolean; equipped?: Item[]; role?: string | null; flashed?: Set<string> }) {
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const toggleSel = (k: string) =>
    setSelected((s) => {
      const n = new Set(s);
      if (n.has(k)) n.delete(k);
      else n.add(k);
      return n;
    });
  const statCols = useMemo(() => statColumns(items), [items]);
  const columns: Col[] = useMemo(() => {
    const distinct = (f: (it: Item) => string | null | undefined) =>
      [...new Set(items.map(f).filter((v): v is string => !!v))].sort();
    return [
      {
        key: "__name", label: "Item", cls: "c-name", sortable: true, text: (it) => it.name,
        cell: (it) => (
          <span className={`r-${it.rarity}`}>
            {it.name}{" "}
            <a className="wlink" href={itemWiki(it, kindOf(it)) ?? "#"} target="_blank" rel="noreferrer" onClick={(e) => e.stopPropagation()}>↗</a>
          </span>
        ),
      },
      { key: "__type", label: "Type", sortable: true, text: (it) => it.type ?? "", opts: distinct((i) => i.type), cell: (it) => <span className="dim">{it.type ?? ""}</span> },
      { key: "__level", label: "Lvl", cls: "num", sortable: true, num: (it) => it.level, cell: (it) => it.level },
      { key: "__size", label: "Size", sortable: true, text: (it) => it.size ?? "", opts: distinct((i) => i.size), cell: (it) => it.size ?? "" },
      ...(showWhere ? [{ key: "__where", label: "Where", sortable: true, text: (it: Item) => it.location ?? "", opts: distinct((i) => i.location), cell: (it: Item) => it.location ?? "" } as Col] : []),
      ...(showShop
        ? ([
            { key: "__cost", label: "Cost", cls: "num", sortable: true, num: (it: Item) => it.cost ?? 0, cell: (it: Item) => (it.costItem ? `${it.costItemCount}× ${it.costItem}` : it.cost != null ? `${it.cost.toLocaleString()} cr` : "") },
            { key: "__stock", label: "Stock", cls: "num", sortable: true, num: (it: Item) => (it.stock === -1 ? Infinity : it.stock ?? 0), cell: (it: Item) => (it.stock === -1 ? "∞" : it.stock ?? "") },
          ] as Col[])
        : []),
      { key: "__bonus", label: "Qual", cls: "num", sortable: true, num: (it) => it.bonus ?? 0, cell: (it) => (it.bonus ? `${it.bonus}${it.bonusStat ? " " + it.bonusStat : ""}` : "") },
      { key: "__asp", label: "Aspects", cls: "c-asp", text: (it) => it.aspects.map((a) => a.name).join(", "), cell: (it) => it.aspects.map((a) => a.name).join(", ") },
      { key: "__sub", label: "Substats", cls: "c-sub", text: (it) => (it.substats ?? []).map(subFmt).join(", "), cell: (it) => (it.substats ?? []).map(subFmt).join(", ") },
      { key: "__count", label: "#", cls: "num", num: (it) => it.count ?? 0, cell: (it) => (it.count && it.count > 1 ? it.count : "") },
      ...statCols.map(
        (c): Col => ({ key: c, label: c, cls: `num c-stat ${isRoleStat(role, c) ? "role" : ""}`, sortable: true, num: (it) => statVal(it, c), cell: (it) => cell(it.stats.find((s) => s.stat === c)) }),
      ),
    ];
  }, [statCols, items, showWhere, showShop, role]);

  const [filters, setFilters] = useState<Record<string, string>>({});
  const [sort, setSort] = useState<{ key: string; dir: 1 | -1 } | null>(null);
  const [hover, setHover] = useState<{ it: Item; x: number; y: number } | null>(null);

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

  const clickSort = (key: string) => setSort((s) => (s?.key === key ? { key, dir: s.dir === -1 ? 1 : -1 } : { key, dir: -1 }));
  const arrow = (key: string) => (sort?.key === key ? (sort.dir === -1 ? " ▼" : " ▲") : "");
  const setF = (key: string, v: string) => setFilters((f) => ({ ...f, [key]: v }));

  if (!items.length) return <p className="hint">(none)</p>;
  return (
    <div className="grid-wrap">
      <table className="grid">
        <thead>
          <tr>
            {columns.map((c) => (
              <th key={c.key} className={c.cls ?? ""}>
                <div
                  className={`th-label ${c.sortable ? "sortable" : ""}`}
                  title={c.label}
                  onClick={c.sortable ? () => clickSort(c.key) : undefined}
                >
                  {c.label}
                  {arrow(c.key)}
                </div>
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
        <tbody>
          {rows.map((it, i) => (
            <tr
              key={i}
              className={`row-click ${selected.has(exactKey(it)) ? "sel" : ""} ${flashed?.has(flashKey(it)) ? "flash" : ""}`}
              onClick={() => toggleSel(exactKey(it))}
              onMouseEnter={(e) => setHover({ it, x: e.clientX, y: e.clientY })}
              onMouseMove={(e) => setHover((h) => (h ? { ...h, x: e.clientX, y: e.clientY } : h))}
              onMouseLeave={() => setHover(null)}
            >
              {columns.map((c) => (
                <td key={c.key} className={c.cls ?? ""}>{c.cell(it)}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
      <div className="hint">{rows.length}/{items.length} shown</div>
      {hover && <ItemTooltip it={hover.it} x={hover.x} y={hover.y} equipped={equipped} role={role} />}
    </div>
  );
}

// Per-stat delta (a − b), only where they differ.
function compareStats(a: Item, b: Item): { stat: string; d: number }[] {
  const names = new Set([...a.stats.map((s) => s.stat), ...b.stats.map((s) => s.stat)]);
  const rows: { stat: string; d: number }[] = [];
  for (const stat of names) {
    const d = statVal(a, stat) - statVal(b, stat);
    if (d !== 0) rows.push({ stat, d });
  }
  const dPower = (a.powerUsage ?? 0) - (b.powerUsage ?? 0);
  if (dPower !== 0) rows.push({ stat: "Power use", d: dPower });
  const dEmp = (a.emp ?? 0) - (b.emp ?? 0);
  if (dEmp !== 0) rows.push({ stat: "EMP", d: dEmp });
  return rows.sort((r1, r2) => r1.stat.localeCompare(r2.stat));
}

// Comparison popup: hovered item + one full panel per equipped item of the same slot & type,
// each panel showing a Δ (equipped − hovered) per stat. Info-only (follows the cursor).
function ItemTooltip({ it, x, y, equipped, role }: { it: Item; x: number; y: number; equipped?: Item[]; role?: string | null }) {
  // Compare against equipped items in the same slot & size (e.g. a Medium weapon vs all Medium
  // weapons on the ship). Falls back to kind+size until the bridge sends slotType.
  const matches = (equipped ?? []).filter(
    (e) =>
      e.size === it.size &&
      (it.slotType && e.slotType ? e.slotType === it.slotType : kindOf(e) === kindOf(it)),
  );
  const flip = x > window.innerWidth / 2;
  const style: CSSProperties = { top: Math.min(y + 16, window.innerHeight - 40), left: flip ? undefined : x + 16, right: flip ? window.innerWidth - x + 16 : undefined };
  return (
    <div className="tips" style={style}>
      <ItemPanel it={it} tag="hovered" role={role} />
      {matches.slice(0, 4).map((e, i) => <ItemPanel key={i} it={e} vs={it} tag="equipped" role={role} />)}
    </div>
  );
}

// One item panel — full game-style tooltip; when `vs` is given, appends a per-stat Δ vs `vs`.
function ItemPanel({ it, vs, tag, role }: { it: Item; vs?: Item; tag?: string; role?: string | null }) {
  const img = itemImage(it);
  const cmp = vs ? compareStats(it, vs) : [];
  return (
    <div className={`tip ${vs ? "cmp" : ""}`}>
      <div className="tip-head">
        {[it.size, it.type].filter(Boolean).join(" ")}
        {tag && <span className="tip-tag"> · {tag}</span>}
      </div>
      <div className="tip-name-row">
        <span className={`tip-name r-${it.rarity}`}>{it.name}</span>
        <span className="tip-lvl">Lv. {it.level}</span>
      </div>
      {img && <img className="tip-img" src={img} alt="" />}
      {it.mainStat && <div className={`tip-main ${isRoleStat(role, it.mainStat.name) ? "role" : ""}`}>{it.mainStat.amount} {it.mainStat.name}</div>}
      {it.fireRate != null && <div className="tip-line">{it.fireRate} attacks per second</div>}
      {it.damageType && <div className="tip-line">{it.damageType} damage</div>}
      {it.powerUsage != null && <div className="tip-line">⚡ {num(it.powerUsage)} power use</div>}
      {it.emp ? <div className="tip-line">◇ {num(it.emp)} EMP</div> : null}
      {it.substats?.length > 0 && (
        <div className="tip-subs">{it.substats.map((s, i) => <div key={i} className={`tip-sub ${isRoleStat(role, s.stat) ? "role" : ""}`}>{subFmt(s)}</div>)}</div>
      )}
      {it.ammo && <div className="tip-line dim">Requires {it.ammo} Ammo</div>}
      {it.aspects.map((a, i) => (
        <div key={i} className="tip-aspect">
          <div className="tip-asp-name">{a.name}</div>
          {a.description && <div className="tip-asp-desc">{a.description}</div>}
        </div>
      ))}
      {vs && (
        <div className="tip-cmp">
          <div className="tip-cmp-head">Δ vs hovered</div>
          {cmp.length ? (
            cmp.map((r) => (
              <div key={r.stat} className="tip-cmp-row">
                <span>{r.stat}</span>
                <span className={r.d > 0 ? "up" : "down"}>{r.d > 0 ? "+" : ""}{num(r.d)}</span>
              </div>
            ))
          ) : (
            <div className="tip-cmp-row dim">identical</div>
          )}
        </div>
      )}
      <div className="tip-foot">
        <span>Vol {it.volume ?? "?"} m³</span>
        <span>Value {it.sellValue.toLocaleString()}</span>
      </div>
    </div>
  );
}

// Compact upgrade rail: items beating the weakest equipped in their slot+size. Type multi-checkbox
// filter; hover a row for the full comparison tooltip.
function OpportunityList({ opps, equipped, showCost, role, credits }: { opps: Opp[]; equipped: Item[]; showCost?: boolean; role?: string | null; credits?: number | null }) {
  const types = useMemo(() => [...new Set(opps.map((o) => o.item.type).filter((t): t is string => !!t))].sort(), [opps]);
  const [hiddenTypes, setHiddenTypes] = useState<Set<string>>(new Set());
  const [affOnly, setAffOnly] = useState(false);
  const [hover, setHover] = useState<{ it: Item; x: number; y: number } | null>(null);
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
  const shown = opps.filter((o) => !hiddenTypes.has(o.item.type ?? "") && (!affOnly || affordable(o)));
  return (
    <div>
      {(types.length > 1 || showCost) && (
        <div className="opp-filter">
          {showCost && <button className={`asp-chip${affOnly ? " on" : ""}`} onClick={() => setAffOnly((v) => !v)}>affordable</button>}
          <Pills options={types} isOn={(t) => !hiddenTypes.has(t)} onToggle={toggle} />
        </div>
      )}
      <div className="opp-list">
        {shown.map((o, i) => (
          <div
            key={i}
            className="opp-row"
            onMouseEnter={(e) => setHover({ it: o.item, x: e.clientX, y: e.clientY })}
            onMouseMove={(e) => setHover((h) => (h ? { ...h, x: e.clientX, y: e.clientY } : h))}
            onMouseLeave={() => setHover(null)}
          >
            <span className={`opp-name r-${o.item.rarity}`}>{o.item.name}</span>
            <span className={`opp-d ${o.delta >= 0 ? "up" : "switch"}`} title={o.delta < 0 ? "lower power — a type switch to match your slot filter" : undefined}>{o.delta >= 0 ? "+" : ""}{num(o.delta)}</span>
            <span className="opp-type dim">{o.item.type}</span>
            {showCost && (
              <span className={`opp-cost ${affordable(o) ? "dim" : "down"}`}>{o.item.costItem ? `${o.item.costItemCount}× ${o.item.costItem}` : o.item.cost != null ? `${o.item.cost.toLocaleString()} cr` : ""}</span>
            )}
          </div>
        ))}
      </div>
      {hover && <ItemTooltip it={hover.it} x={hover.x} y={hover.y} equipped={equipped} role={role} />}
    </div>
  );
}

