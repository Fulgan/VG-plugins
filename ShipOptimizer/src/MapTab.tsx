import { useCallback, useEffect, useMemo, useState } from "react";
import { api, type Conn } from "./api";
import type { Galaxy, GalaxyFaction, GalaxySector, GalaxySystem, Materials } from "./types";
import { useCursorTip, useHoverIntent } from "./useCursorTip";
import { reachFrom } from "./route";
import { MAP_EMPTY, STATIONS_FULL, mapRamp } from "./mapRamp";
import StandingPanels from "./StandingPanels";
import FactionMark from "./FactionMark";
import "./map.css";

// PROPOSAL / TEMPORARY TAB — a first pass at a galaxy map that's easier to read than the in-game one.
//
// The in-game map draws everything at once at equal weight: five faction territories as hard Voronoi
// borders, connection lines over the top, and up to five badges per node. The idea here is the opposite —
// one question at a time. A layer picker decides what the map is ABOUT (ownership, materials, danger,
// recency), so at any moment a single variable carries the colour and everything else recedes.
//
// Two zoom levels mirroring the game's own breadcrumb: quadrant → subsector → (hover) system detail.
// Quadrants come from the payload rather than being hardcoded, so a third map would appear on its own.

type Layer = "owner" | "materials" | "level" | "recency" | "stations";

// The game's quadrant ids (0 Prologue, 1 Frontier, 2 Conquest). Only the conquest one needs naming: its
// presence in the payload is what tells us the conquest map is open to this save.
const CONQUEST_QUADRANT = 2;

const LAYERS: { id: Layer; label: string; hint: string }[] = [
  { id: "owner", label: "Ownership", hint: "Controlling faction per system" },
  { id: "materials", label: "Materials", hint: "Where your stuff is stored (m³ held)" },
  { id: "level", label: "Level", hint: "System level against the conquest cap" },
  { id: "recency", label: "Recency", hint: "How recently you were there" },
  { id: "stations", label: "Stations", hint: "Systems with docks, by owner count" },
];

// Faction colours come from the payload (`Faction.conquestColor`, the value the game paints territory with),
// keyed by the faction's stable identifier — the display name is per-playthrough ("Gold" → "Mindus Holdings")
// and so cannot be a key. The name hash below is only a fallback for a bridge that sends no `factions`; it
// yields an arbitrary hue, not the faction's real colour.
const hueOf = (s: string) => {
  let h = 0;
  for (const ch of s) h = (h * 31 + ch.charCodeAt(0)) % 360;
  return h;
};
const fallbackColor = (f?: string | null) => (f ? `hsl(${hueOf(f)} 62% 58%)` : MAP_EMPTY);

// Resolve a faction's colour from the payload's table, keyed by identifier. Module-level (not a closure) so
// the tooltip components can use it too — they get the table passed in rather than re-deriving it.
function colorFor(factions: GalaxyFaction[] | undefined, factionId?: string | null, faction?: string | null): string {
  const f = factionId ? factions?.find((x) => x.id === factionId) : undefined;
  return f?.conquestColor ?? f?.color ?? fallbackColor(faction);
}

// Frontier holds special systems that sit ABOVE their subsector's level range and are worth finding on
// purpose: warzones (combat), motherlodes (mining) and graveyards (salvage). The game flags all three with
// `pocketSystem`; which one it is follows from the POI mix. In LZ-981 Rift (range 10-18):
//   Warzone Zeta      lvl 21  pocket  Combat x3 + CombatStation x2
//   Forlorn Graveyard lvl 25  pocket  Salvage x3
//   Amber-9 ...lode   lvl 25  pocket  Mining x3
// Derived client-side rather than server-side: it's a reading of data the payload already carries.
export type Special = "warzone" | "motherlode" | "graveyard" | "special";

// Colours are the activity tokens, the same ones a POI of that activity uses, so a motherlode and the mining
// sites inside it read as one thing.
const SPECIALS: Record<Special, { label: string; glyph: string; color: string }> = {
  warzone:    { label: "Warzone",    glyph: "⚔", color: "var(--map-combat)" },
  motherlode: { label: "Motherlode", glyph: "◆", color: "var(--map-mining)" },
  graveyard:  { label: "Graveyard",  glyph: "⚙", color: "var(--map-salvage)" },
  special:    { label: "Anomaly",    glyph: "✲", color: "var(--map-anomaly)" },
};

// Node shapes, generated so a radius change stays in one place.
const poly = (cx: number, cy: number, r: number, sides: number, rot: number) =>
  Array.from({ length: sides }, (_, i) => {
    const a = rot + (i * 2 * Math.PI) / sides;
    return `${(cx + r * Math.cos(a)).toFixed(1)},${(cy + r * Math.sin(a)).toFixed(1)}`;
  }).join(" ");

const hexagon = (cx: number, cy: number, r: number) => poly(cx, cy, r, 6, -Math.PI / 2);
const diamond = (cx: number, cy: number, r: number) => poly(cx, cy, r, 4, -Math.PI / 2);


function classify(s: GalaxySystem): Special | null {
  if (!s.pocket) return null;
  const k = s.poiKinds ?? {};
  const combat = (k.Combat ?? 0) + (k.CombatStation ?? 0);
  const mining = k.Mining ?? 0;
  const salvage = k.Salvage ?? 0;
  const top = Math.max(combat, mining, salvage);
  if (top === 0) return "special";              // pocket, but nothing decisive yet (unvisited, maybe)
  if (combat === top) return "warzone";
  if (mining === top) return "motherlode";
  return "graveyard";
}

export default function MapTab({ conn, docked, standingBump = 0 }: {
  conn: Conn; docked: boolean; standingBump?: number;
}) {
  const [g, setG] = useState<Galaxy | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [quadrant, setQuadrant] = useState<number | null>(null);
  const [sector, setSector] = useState<string | null>(null); // null = quadrant overview
  const [layer, setLayer] = useState<Layer>("owner");
  const [focus, setFocus] = useState<string | null>(null);  // system guid -> in-system view
  const [q, setQ] = useState("");
  const [onlySpecial, setOnlySpecial] = useState<Special | null>(null);
  const { target: hover, show, hide } = useHoverIntent<{ sys: GalaxySystem; x: number; y: number }>(60);

  // "Where is my stuff" — belongs on the map, because the answer is a place. Pick an item and every system
  // holding it lights up by quantity. `/materials` is the galaxy-wide aggregate (every visited station's
  // storage, readable without docking); the per-system `materials` block on /galaxy only carries volume and
  // the first few names, which can't answer "how much of THIS, where".
  const [mats, setMats] = useState<Materials | null>(null);
  const [matSort, setMatSort] = useState<"most" | "near">("near");
  const [itemId, setItemId] = useState<string | null>(null);
  const [itemQ, setItemQ] = useState("");
  const [pickerOpen, setPickerOpen] = useState(false);

  // Open where the player actually is. Done once per payload identity, so it doesn't yank the view back
  // while you're browsing elsewhere - but a ship jump to another subsector re-homes the map.
  const [homedOn, setHomedOn] = useState<string | null>(null);

  const load = useCallback(async (fresh = false) => {
    try { setG(await api.galaxy(conn, fresh)); setErr(null); }
    catch (e) { setErr(e instanceof Error ? e.message : String(e)); }
    // Materials are a separate request and a separate failure: the map is still useful without them, so a
    // bridge too old to serve /materials just means no item heat, not a broken tab.
    try { setMats(await api.materials(conn, fresh)); }
    catch { setMats(null); }
  }, [conn]);

  // The refresh policy the map actually needs: on open, on dock/undock, and a slow tick — the galaxy only
  // changes when you travel or when conquest advances.
  useEffect(() => { void load(true); }, [load, docked]);
  useEffect(() => {
    const t = setInterval(() => void load(), 60_000);
    return () => clearInterval(t);
  }, [load]);

  const here = useMemo(() => g?.systems.find((x) => x.guid === g.currentSystem) ?? null, [g]);
  const hereSector = useMemo(() => (here ? g?.sectors.find((x) => x.guid === here.sector) ?? null : null), [g, here]);
  useEffect(() => {
    if (!here || !hereSector || homedOn === here.guid) return;
    setHomedOn(here.guid);
    setQuadrant(hereSector.quadrant);
    setSector(hereSector.guid);
  }, [here, hereSector, homedOn]);

  const quadrants = g?.quadrants.filter((q) => q.sectors.length > 0) ?? [];
  const activeQuadrant = quadrant ?? quadrants[0]?.id ?? null;
  const sectorsHere = useMemo(
    () => (g?.sectors ?? []).filter((s) => s.quadrant === activeQuadrant),
    [g, activeQuadrant],
  );
  const systemsBySector = useMemo(() => {
    const m = new Map<string, GalaxySystem[]>();
    for (const s of g?.systems ?? []) {
      if (!m.has(s.sector)) m.set(s.sector, []);
      m.get(s.sector)!.push(s);
    }
    return m;
  }, [g]);

  // Layer scales are computed over what's on screen, so a quiet subsector still shows contrast.
  const scale = useMemo(() => {
    const pool = sector ? systemsBySector.get(sector) ?? [] : (g?.systems ?? []).filter((s) => sectorsHere.some((x) => x.guid === s.sector));
    const vols = pool.map((s) => s.materials?.volume ?? 0);
    const visits = pool.map((s) => s.lastVisited ?? 0).filter((v) => v > 0);
    return {
      maxVolume: Math.max(1, ...vols),
      newest: Math.max(0, ...visits),
      oldest: visits.length ? Math.min(...visits) : 0,
      levelCap: g?.levelCap ?? 64,
    };
  }, [g, sector, sectorsHere, systemsBySector]);

  // The selected item, and how much of it sits in each system. A system can hold the same item in more than
  // one station, so counts are summed per system rather than per place. `/materials` reports station storage
  // only, so every entry belongs on the map; one without a system could not be placed and is skipped.
  const item = useMemo(() => (itemId ? mats?.items.find((i) => i.id === itemId) ?? null : null), [itemId, mats]);
  const itemHeat = useMemo(() => {
    const bySystem = new Map<string, number>();
    for (const at of item?.at ?? []) {
      if (!at.system) continue;
      bySystem.set(at.system, (bySystem.get(at.system) ?? 0) + at.count);
    }
    return { bySystem, max: Math.max(1, ...bySystem.values()) };
  }, [item]);

  // Jump distance from where you are to everywhere else. A pile of ore is only worth knowing about with its
  // distance attached — and a gate you cannot pass yet makes the biggest stack in the galaxy worthless today.
  const reach = useMemo(() => reachFrom(g?.edges ?? [], g?.currentSystem), [g?.edges, g?.currentSystem]);

  // What the map paints a system's territory with. `conquestColor` first (that is the territory colour the
  // game itself uses), then the faction's general `color`, then the legacy name hash.
  const factionColor = useCallback(
    (s: Pick<GalaxySystem, "faction" | "factionId">) => colorFor(g?.factions, s.factionId, s.faction),
    [g],
  );
  // Recruit rosters are per station: each Personnel Center has its own `officerRefreshTime`. But the countdown is
  // measured against the GLOBAL play clock, so it runs whether or not you are there — it does not stop when you
  // leave. So prefer the station you are docked at, then the soonest still-running figure, and fall back to an
  // elapsed one only if that is all there is.
  // Each case normalises its own datum against its own scale and hands the fraction to the ramp; the colour
  // itself belongs to `mapRamp`, so no layer can invent a hue or a brightness span of its own. A layer with
  // nothing to report returns MAP_EMPTY — one colour for that fact, whichever layer is asking.
  const tint = (s: GalaxySystem): string => {
    // An item search overrides whatever layer is selected — you asked a question, the map answers THAT.
    // Scaled by the galaxy-wide maximum so a system's shade means the same thing in every subsector.
    if (item) {
      const n = itemHeat.bySystem.get(s.guid) ?? 0;
      return n <= 0 ? MAP_EMPTY : mapRamp("item", n / itemHeat.max);
    }
    // Never visited: only ownership is known-good. That it is unvisited is already on screen as SHAPE — a
    // hollow node, a faint dot — so the fill says the same "no reading" every other layer's zero says.
    if (s.knowledge === "known" && layer !== "owner") return MAP_EMPTY;
    switch (layer) {
      case "owner": return factionColor(s);
      case "materials": {
        const v = (s.materials?.volume ?? 0) / scale.maxVolume;
        return v <= 0 ? MAP_EMPTY : mapRamp("materials", v);
      }
      case "level":
        return s.level == null ? MAP_EMPTY : mapRamp("level", s.level / scale.levelCap);
      case "recency": {
        if (!s.lastVisited) return MAP_EMPTY;
        const span = Math.max(1, scale.newest - scale.oldest);
        return mapRamp("recency", (s.lastVisited - scale.oldest) / span);
      }
      case "stations": {
        const n = s.stations?.length ?? 0;
        return n === 0 ? MAP_EMPTY : mapRamp("stations", n / STATIONS_FULL);
      }
    }
  };

  // One place that knows how to get anywhere, so search results, the recency rail and "show my
  // subsector" all navigate identically.
  const goTo = (systemGuid: string, open = false) => {
    const sys = g?.systems.find((x) => x.guid === systemGuid);
    if (!sys) return;
    const sec = g?.sectors.find((x) => x.guid === sys.sector);
    if (sec) { setQuadrant(sec.quadrant); setSector(sec.guid); }
    setFocus(open ? systemGuid : null);
    setQ("");
  };

  // Search spans everything the payload knows: system and station names, factions, POI kinds and stored
  // materials. Matching on materials is what turns "where is my titanium" into one keystroke - it needs
  // the per-system materials field, so it stays empty until that ships.
  const results = useMemo(() => {
    const needle = q.trim().toLowerCase();
    if (needle.length < 2 || !g) return [];
    const out: { sys: GalaxySystem; why: string }[] = [];
    for (const sys of g.systems) {
      const reasons: string[] = [];
      if (sys.name.toLowerCase().includes(needle)) reasons.push("system");
      if (sys.faction?.toLowerCase().includes(needle)) reasons.push(`faction ${sys.faction}`);
      for (const st of sys.stations ?? []) {
        if (st.name?.toLowerCase().includes(needle)) reasons.push(st.name);
        else if (st.faction?.toLowerCase().includes(needle)) reasons.push(`${st.faction} station`);
        for (const shop of st.shops ?? [])
          if (shop.toLowerCase().includes(needle)) reasons.push(`${shop} shop`);
      }
      for (const k of Object.keys(sys.poiKinds ?? {}))
        if (k.toLowerCase().includes(needle)) reasons.push(`${sys.poiKinds![k]}x ${k}`);
      for (const m of sys.materials?.items ?? [])
        if (m.toLowerCase().includes(needle)) reasons.push(`holds ${m}`);
      for (const mi of sys.missions ?? [])
        if (mi.name?.toLowerCase().includes(needle)) reasons.push(`mission ${mi.name}`);
      const kind = classify(sys);
      if (kind && SPECIALS[kind].label.toLowerCase().includes(needle)) reasons.push(SPECIALS[kind].label);
      if (reasons.length) out.push({ sys, why: [...new Set(reasons)].slice(0, 3).join(" · ") });
    }
    return out.slice(0, 40);
  }, [q, g]);

  if (err) return <div className="sum-msg err">⚠ {err} <button className="undo-suggest" onClick={() => void load(true)}>retry</button></div>;
  if (!g) return <p className="hint">Loading…</p>;

  const sectorObj = sector ? sectorsHere.find((s) => s.guid === sector) : null;
  const shown = sector ? systemsBySector.get(sector) ?? [] : [];

  return (
    <div className="map">
      <div className="sum-head">
        <div className="panel-title">
          Galaxy <span className="dim">— {g.counts.systemsVisited} of {g.counts.systemsGenerated ?? g.counts.systemsTotal} systems visited · {g.counts.sectorsVisited} subsectors</span>
        </div>
        <div className="sum-actions">
          <button className="undo-suggest" onClick={() => void load(true)}>refresh</button>
        </div>
      </div>

      {/* Where am I - stated in words as well as drawn, since a ring on one of 79 nodes is easy to miss. */}
      {here && (
        <div className="map-here">
          <span className="map-here-pin" />
          <b>{here.name}</b>
          {hereSector && <span className="dim">{hereSector.name}</span>}
          {here.level != null && <span className="dim">Lv. {here.level}</span>}
          {/* The station is named in the app header; here only WHETHER you are docked adds anything. */}
          {docked ? <span className="map-docked">docked</span> : <span className="dim">in space</span>}
          {(!sector || sector !== here.sector) && (
            <button className="undo-suggest" onClick={() => {
              if (hereSector) { setQuadrant(hereSector.quadrant); setSector(hereSector.guid); }
            }}>show my subsector</button>
          )}
        </div>
      )}



      {/* quadrant = the game's separate galaxy maps ("< Frontier" / "Conquest >") */}
      <div className="map-bar">
        {quadrants.map((q) => (
          <button key={q.id} className={`asp-chip${q.id === activeQuadrant ? " on" : ""}`}
            onClick={() => { setQuadrant(q.id); setSector(null); }}>
            {q.name} <span className="dim">{q.sectors.length}</span>
          </button>
        ))}
        <span className="spacer" />
        {LAYERS.map((l) => (
          <button key={l.id} className={`asp-chip${layer === l.id ? " on" : ""}`} title={l.hint} onClick={() => setLayer(l.id)}>{l.label}</button>
        ))}
        {(["warzone", "motherlode", "graveyard"] as Special[]).map((k) => (
          <button key={k} className={`asp-chip${onlySpecial === k ? " on" : ""}`}
            title={`Highlight ${SPECIALS[k].label.toLowerCase()}s — higher level than the rest of their subsector`}
            onClick={() => setOnlySpecial(onlySpecial === k ? null : k)}>
            <span style={{ color: SPECIALS[k].color }}>{SPECIALS[k].glyph}</span> {SPECIALS[k].label}
          </button>
        ))}
        {/* Where is my stuff — an item picker, because the answer to "where" is a map. */}
        <button className={`asp-chip${item ? " on" : ""}`} disabled={!mats}
          title={mats ? "Find an item across every station's storage" : "Materials unavailable from this bridge"}
          onClick={() => setPickerOpen((v) => !v)}>
          {item ? `◉ ${item.name}` : "Find my stuff"}
        </button>
        {item && <button className="asp-chip" title="Clear the item search" onClick={() => { setItemId(null); setPickerOpen(false); }}>clear</button>}
        <input className="map-search" value={q} onChange={(e) => setQ(e.target.value)}
          placeholder="search systems, stations, factions, materials…" />
      </div>

      {/* Who owns what, with the game's own colours and badges — so a territory here reads as the same
          faction it does in the game. Only on the ownership layer, where colour means faction. */}
      {layer === "owner" && !item && (g.factions?.length ?? 0) > 0 && (
        <div className="fac-legend">
          {g.factions!.map((f) => (
            <span key={f.id} className="fac-chip">
              <FactionMark conn={conn} id={f.id} name={f.name}
                color={f.conquestColor ?? f.color} size={15} />
            </span>
          ))}
        </div>
      )}

      {/* Item picker: the whole galaxy-wide item list, most-held first, searchable. */}
      {pickerOpen && mats && (
        <div className="stuff-pick">
          <input className="map-search" autoFocus value={itemQ} onChange={(e) => setItemQ(e.target.value)}
            placeholder="which item? (name)" />
          <div className="stuff-pick-list">
            {mats.items
              .filter((i) => !itemQ.trim() || i.name.toLowerCase().includes(itemQ.trim().toLowerCase()))
              .slice(0, 60)
              .map((i) => (
                <button key={i.id} className={`stuff-pick-item${i.id === itemId ? " on" : ""}`}
                  onClick={() => { setItemId(i.id); setPickerOpen(false); }}>
                  <span className="sp-name">{i.name}</span>
                  {i.category && <span className="sp-cat dim">{i.category}</span>}
                  <span className="sp-total">{i.total.toLocaleString()}</span>
                  <span className="sp-places dim">{i.at.length} place{i.at.length === 1 ? "" : "s"}</span>
                </button>
              ))}
            {!mats.items.length && <div className="dim" style={{ padding: 6 }}>No materials stored anywhere yet.</div>}
          </div>
        </div>
      )}

      {/* Where that item actually is, ranked — the map shades it, this names it. */}
      {item && (
        <div className="stuff-found">
          <div className="sf-head">
            <b>{item.name}</b>
            <span className="dim">{item.total.toLocaleString()} stored</span>
            <span className="spacer" />
            <div className="seg-group" title="Rank by amount held, or by jumps from here">
              {(["most", "near"] as const).map((k) => (
                <button key={k} className={`seg${matSort === k ? " on" : ""}`} onClick={() => setMatSort(k)}>
                  {k === "most" ? "most" : "nearest"}
                </button>
              ))}
            </div>
          </div>
          <div className="sf-list">
            {[...itemHeat.bySystem.entries()]
              .sort((a, b) => {
                if (matSort === "near") {
                  // Unreachable last whatever it holds, then by jumps, amount as the tie-break.
                  const ra = a[0] === g.currentSystem ? 0 : reach.get(a[0])?.hops ?? Infinity;
                  const rb = b[0] === g.currentSystem ? 0 : reach.get(b[0])?.hops ?? Infinity;
                  if (ra !== rb) return ra - rb;
                }
                return b[1] - a[1];
              })
              .map(([guid, n]) => {
                const sys = g.systems.find((x) => x.guid === guid);
                const sec = sys ? g.sectors.find((x) => x.guid === sys.sector) : null;
                const r = guid === g.currentSystem ? { hops: 0, locked: 0 } : reach.get(guid);
                return (
                  <button key={guid} className={`sf-row${guid === g.currentSystem ? " here" : ""}`}
                    title={sys ? `Show ${sys.name}` : guid}
                    onClick={() => sys && goTo(guid, true)}>
                    <span className="sf-n">{n.toLocaleString()}</span>
                    <span className="sf-sys">{sys?.name ?? "(unvisited sector)"}</span>
                    <span className="sf-sec dim">{sec?.name ?? ""}</span>
                    {/* Distance is what turns a pile into an errand. "no route" is said plainly rather than
                        left blank, which would read as "next door". */}
                    {guid !== g.currentSystem && (
                      r
                        ? <span className={`sf-hops${r.locked ? " locked" : ""}`}
                            title={r.locked ? `${r.hops} jumps, ${r.locked} locked gate${r.locked === 1 ? "" : "s"} on the way` : `${r.hops} jump${r.hops === 1 ? "" : "s"} away`}>
                            {r.hops}j{r.locked ? ` · ${r.locked} locked` : ""}
                          </span>
                        : <span className="sf-hops none" title="No gate route from here on the known map">no route</span>
                    )}
                    {guid === g.currentSystem && <span className="sf-you">you are here</span>}
                  </button>
                );
              })}
            {!itemHeat.bySystem.size && <div className="dim" style={{ padding: 6 }}>None in any station's storage.</div>}
          </div>
        </div>
      )}

      {results.length > 0 && (
        <div className="map-results">
          {results.map((r) => (
            <button key={r.sys.guid} className="map-result" onClick={() => goTo(r.sys.guid, true)}>
              <b>{r.sys.name}</b>
              <span className="dim">{g.sectors.find((x) => x.guid === r.sys.sector)?.name}</span>
              {r.sys.level != null && <span className="dim">Lv {r.sys.level}</span>}
              <span className="spacer" />
              <span className="map-why">{r.why}</span>
              {r.sys.knowledge === "known" && <span className="dim">not visited</span>}
            </button>
          ))}
        </div>
      )}

      {sectorObj && (
        <div className="map-crumb">
          <button className="undo-suggest" onClick={() => setSector(null)}>← {quadrants.find((q) => q.id === activeQuadrant)?.name}</button>
          <b>{sectorObj.name}</b>
          <span className="dim">
            {sectorObj.levelRange ? `Lv. ${sectorObj.levelRange[0]}–${sectorObj.levelRange[1]}` : sectorObj.level ? `Lv. ${sectorObj.level}` : ""}
            {sectorObj.conquest ? " · conquest warzone" : ""} · {shown.length} systems
          </span>
        </div>
      )}

      {!sector ? (
        // ---- quadrant overview: one card per subsector, ordered by level so the Frontier reads as the
        // progression ladder it is. The 79-system conquest sector stays a single card until opened.
        <div className="map-sectors">
          {[...sectorsHere]
            .sort((a, b) => (a.levelRange?.[0] ?? a.level ?? 0) - (b.levelRange?.[0] ?? b.level ?? 0))
            .map((sec) => {
              const sys = systemsBySector.get(sec.guid) ?? [];
              const visited = sys.filter((s) => s.knowledge === "visited").length;
              const vol = sys.reduce((n, s) => n + (s.materials?.volume ?? 0), 0);
              return (
                <button key={sec.guid}
                  className={`map-sector${sec.conquest ? " warzone" : ""}${sec.guid === here?.sector ? " youarehere" : ""}`}
                  onClick={() => setSector(sec.guid)}>
                  <div className="map-sector-head">
                    <b>{sec.name}</b>
                    {sec.guid === here?.sector && <span className="map-hereflag">you are here</span>}
                    <span className="dim">{sec.levelRange ? `${sec.levelRange[0]}–${sec.levelRange[1]}` : sec.level ?? "?"}</span>
                  </div>
                  <div className="map-mini">
                    {sys.map((s) => (
                      <span key={s.guid} className={`map-dot${s.guid === g.currentSystem ? " here" : ""}${s.knowledge === "known" ? " faint" : ""}`}
                        style={{ background: tint(s) }} title={s.name} />
                    ))}
                  </div>
                  <div className="map-sector-foot dim">
                    {visited}/{sys.length} visited{vol > 0 ? ` · ${Math.round(vol).toLocaleString()} m³` : ""}
                    {(() => {
                      const specials = sys.map(classify).filter(Boolean) as Special[];
                      if (!specials.length) return null;
                      const counts = specials.reduce<Record<string, number>>((a, k) => ({ ...a, [k]: (a[k] ?? 0) + 1 }), {});
                      return (
                        <span className="map-card-specials">
                          {Object.entries(counts).map(([k, n]) => (
                            <span key={k} title={`${n} ${SPECIALS[k as Special].label}${n > 1 ? "s" : ""}`}
                              style={{ color: SPECIALS[k as Special].color }}>{SPECIALS[k as Special].glyph}{n > 1 ? n : ""}</span>
                          ))}
                        </span>
                      );
                    })()}
                  </div>
                </button>
              );
            })}
        </div>
      ) : (
        <>
          <SectorGraph galaxy={g} systems={shown} tint={tint} onHover={show} onLeave={hide}
            onOpen={(guid) => setFocus(guid)} highlight={onlySpecial} />

          {/* Status strip, as in the design — but only figures we actually have. No bearing (meaningless for
              a galaxy map) and no light-year scale (the coordinates are the game's own layout units). */}
          <div className="map-foot">
            <span className="dim">{g.counts.systemsVisited} / {g.counts.systemsGenerated ?? g.counts.systemsTotal} surveyed</span>
            <span className="spacer" />
            <span className="dim">◻ crossing · ◆ special · digits = level</span>
          </div>
          {focus && (
            <SystemView conn={conn} sys={g.systems.find((x) => x.guid === focus) ?? null} onClose={() => setFocus(null)} />
          )}
        </>
      )}

      {/* recency rail — the game shows nothing like this, and it answers "where was I?" directly */}
      {g.recent.length > 0 && (
        <div className="map-recent">
          <span className="dim">Recent:</span>
          {g.recent.slice(0, 12).map((r) => (
            <button key={r.guid} className="asp-chip" onClick={() => {
              const sys = g.systems.find((x) => x.guid === r.guid);
              if (sys) { setQuadrant(g.sectors.find((x) => x.guid === sys.sector)?.quadrant ?? activeQuadrant); setSector(sys.sector); }
            }}>{r.name}</button>
          ))}
        </div>
      )}

      {/* Standing lives at the foot of the map because it is about the same thing the map is: who holds what,
          and who will shoot at you for being there. Conquest is shown only once its quadrant is on the map —
          that is what "unlocked" means here, and it comes from the payload rather than a separate probe. */}
      <StandingPanels conn={conn} bump={standingBump}
        conquestUnlocked={quadrants.some((q) => q.id === CONQUEST_QUADRANT && q.sectors.length > 0)} />

      {hover && (
        <SystemTip conn={conn} sys={hover.sys} x={hover.x} y={hover.y} levelCap={g.levelCap ?? 64} factions={g.factions}
          umbralForShop={g.conquest?.umbralForShop ?? null}
          sector={g.sectors.find((x) => x.guid === hover.sys.sector) ?? null} />
      )}
    </div>
  );
}

// One subsector as a node graph. Positions come from the game's own layout (`x`/`y`), normalised to the
// viewport so a wide chain and a tight cluster both fill the space.
function SectorGraph({
  galaxy, systems, tint, onHover, onLeave, onOpen, highlight,
}: {
  galaxy: Galaxy; systems: GalaxySystem[]; tint: (s: GalaxySystem) => string;
  onHover: (h: { sys: GalaxySystem; x: number; y: number }) => void; onLeave: () => void;
  onOpen: (guid: string) => void;
  highlight: Special | null;
}) {
  const W = 1000, H = 420, PAD = 46;
  const pos = useMemo(() => {
    const xs = systems.map((s) => s.x), ys = systems.map((s) => s.y);
    const minX = Math.min(...xs), maxX = Math.max(...xs), minY = Math.min(...ys), maxY = Math.max(...ys);
    const sx = maxX - minX || 1, sy = maxY - minY || 1;
    const m = new Map<string, { x: number; y: number }>();
    for (const s of systems)
      m.set(s.guid, {
        x: PAD + ((s.x - minX) / sx) * (W - PAD * 2),
        // Y IS FLIPPED. The game's coordinates are world-space, where y grows UPWARD; SVG's y grows
        // downward. Projecting them straight through mirrored every subsector vertically, so the layout
        // no longer matched the in-game map it is supposed to be recognisable as.
        y: PAD + (1 - (s.y - minY) / sy) * (H - PAD * 2),
      });
    return m;
  }, [systems]);

  const inSector = new Set(systems.map((s) => s.guid));
  // One line per gate pair, not two: the same link exists as a POI on both sides.
  const seen = new Set<string>();
  const edges = galaxy.edges.filter((e) => {
    if (!inSector.has(e.from)) return false;
    const key = [e.from, e.to ?? "out:" + e.gate].sort().join("|");
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  return (
    <div className="map-graph">
      <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="xMidYMid meet">
        {/* Coordinate ruler along the top, from the game's own layout units. */}
        <g className="map-ruler">
          <line x1={PAD} y1={14} x2={W - PAD} y2={14} />
          {Array.from({ length: 6 }, (_, i) => PAD + (i * (W - PAD * 2)) / 5).map((x, i) => (
            <g key={i}>
              <line x1={x} y1={9} x2={x} y2={19} />
              <text x={x + 4} y={12}>{String(i * 60).padStart(3, "0")}</text>
            </g>
          ))}
        </g>

        {edges.map((e) => {
          const a = pos.get(e.from);
          const b = e.to ? pos.get(e.to) : null;
          if (!a) return null;
          // A gate whose far end isn't on this map used to get a short dashed stub. It said nothing — a line
          // to empty space, at a fixed angle unrelated to where the gate actually leads — so it is not drawn.
          if (!b) return null;
          return (
            <line key={e.gate} className={`map-edge${e.usable === false ? " locked" : ""}${e.crossSector ? " cross" : ""}`}
              x1={a.x} y1={a.y} x2={b.x} y2={b.y}>
              <title>{e.name}{e.usable === false ? " — locked" : ""}</title>
            </line>
          );
        })}
        {systems.map((s) => {
          const p = pos.get(s.guid);
          if (!p) return null;
          const r = 9;                       // uniform: varying it by station count read as noise
          const kind = classify(s);
          const muted = highlight != null && kind !== highlight;
          return (
            <g key={s.guid} className={`map-node${s.knowledge === "known" ? " known" : ""}${s.guid === galaxy.currentSystem ? " here" : ""}${muted ? " muted" : ""}`}
              onMouseEnter={(ev) => onHover({ sys: s, x: ev.clientX, y: ev.clientY })} onMouseLeave={onLeave}
              onClick={() => onOpen(s.guid)}>
              {/* Colour carries the active layer; shape carries what you'd change course for:
                    hexagon         an ordinary system
                    diamond         a special (warzone / motherlode / graveyard)
                    boxed hexagon   a faction's CONQUEST HEADQUARTERS
                  The box was previously bound to "this system's gate leaves the subsector", which is common,
                  already drawn by the dashed amber link, and got read as the headquarters anyway — so it now
                  marks the headquarters, which is what one box per faction should mean. Uniform node size:
                  scaling by station count gives every node its own size and reads as noise. */}
              {/* Visited systems are SOLID, never-visited ones are hollow with a thin outline. Not an opacity
                  difference: a faded node reads as a rendering artefact rather than a fact about the galaxy —
                  you cannot tell "I haven't been here" from "this is drawn badly". */}
              {(() => {
                const shape = kind ? diamond(p.x, p.y, r + 1) : hexagon(p.x, p.y, r);
                // The fill goes through `style`, not the `fill` attribute: a tint can be a `var()` and an
                // inline declaration resolves one everywhere, a presentation attribute not reliably.
                return s.knowledge === "known"
                  ? <polygon className="map-shape hollow" points={shape} fill="none" style={{ stroke: tint(s) }} />
                  : <polygon className="map-shape" points={shape} style={{ fill: tint(s) }} />;
              })()}
              {s.conquest?.headquarters && (
                <rect className="map-hq" x={p.x - r - 3} y={p.y - r - 3} width={(r + 3) * 2} height={(r + 3) * 2}
                  style={{ stroke: tint(s) }}>
                  <title>{s.faction} headquarters</title>
                </rect>
              )}
              {s.guid === galaxy.currentSystem && (
                // Where you are: the design's targeting reticle — two wide concentric rings plus crosshair
                // ticks — with the pulse kept on the inner ring so it draws the eye without the text label.
                <g className="map-you">
                  <circle className="map-you-outer" cx={p.x} cy={p.y} r={r + 20} />
                  <circle className="map-you-ring" cx={p.x} cy={p.y} r={r + 11} />
                  <circle className="map-you-pulse" cx={p.x} cy={p.y} r={r + 11} />
                  {[[0, -1], [0, 1], [-1, 0], [1, 0]].map(([dx, dy], i) => (
                    <line key={i} className="map-you-tick"
                      x1={p.x + dx * (r + 13)} y1={p.y + dy * (r + 13)}
                      x2={p.x + dx * (r + 24)} y2={p.y + dy * (r + 24)} />
                  ))}
                </g>
              )}
              {kind && (
                // special systems always carry their mark, whatever the active layer - they're
                // structural, not just another attribute
                <>
                  <circle className="map-special-ring" cx={p.x} cy={p.y} r={r + 3} style={{ stroke: SPECIALS[kind].color }} />
                  <text className="map-special-glyph" x={p.x + r + 6} y={p.y - r} style={{ fill: SPECIALS[kind].color }}>{SPECIALS[kind].glyph}</text>
                </>
              )}
              {/* Level stays on the node — the one number worth reading without hovering, and it costs no
                  extra space sitting inside the shape. Names don't: those are in the tooltip. */}
              {s.level != null && (
                // Dark digits sit on a filled node; a hollow one has no fill to sit on, so they take its colour.
                <text className={`map-lvl${s.knowledge === "known" ? " on-hollow" : ""}`} x={p.x} y={p.y + 3.5}
                  textAnchor="middle" style={s.knowledge === "known" ? { fill: tint(s) } : undefined}>{s.level}</text>
              )}
            </g>
          );
        })}
      </svg>
    </div>
  );
}

// Third zoom level: inside one system. POI positions come from the game (a small grid, roughly 20x5),
// so the layout matches what you see in-game rather than being invented. Fetched on demand - POIs are
// most of the map's cost, which is why they aren't in the main payload.
interface Poi {
  guid: string; name: string; kind: string; typeName?: string | null; faction?: string | null;
  level?: number; x: number; y: number; dynamic?: boolean; lastVisited?: number;
  station?: { shops: string[]; size?: string; variant?: string; refreshTime?: number; refreshInterval?: number; dryDock?: boolean; workshop?: boolean; canBeHome?: boolean };
}

const KIND_GLYPH: Record<string, string> = {
  JumpGate: "⇄", EmbassyJumpgate: "⇄", GreatGate: "✲",
  SpaceStation: "◉", ConquestStation: "⬢", CombatStation: "⬟", EmbassyStation: "◎",
  Mining: "◆", Salvage: "⚙", Combat: "⚔", Beacon: "▲",
};

function SystemView({ conn, sys, onClose }: { conn: Conn; sys: GalaxySystem | null; onClose: () => void }) {
  const [pois, setPois] = useState<Poi[] | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    if (!sys) return;
    setPois(null); setErr(null);
    api.galaxyPois(conn, sys.guid)
      .then((r) => setPois((r.pois as Poi[]) ?? []))
      .catch((e) => setErr(e instanceof Error ? e.message : String(e)));
  }, [conn, sys]);

  if (!sys) return null;
  const W = 1000, H = 260, PAD = 40;
  const xs = (pois ?? []).map((p) => p.x), ys = (pois ?? []).map((p) => p.y);
  const minX = Math.min(0, ...xs), maxX = Math.max(20, ...xs);
  const minY = Math.min(0, ...ys), maxY = Math.max(5, ...ys);
  const at = (p: Poi) => ({
    x: PAD + ((p.x - minX) / (maxX - minX || 1)) * (W - PAD * 2),
    // Flipped for the same reason as SectorGraph: game y grows up, SVG y grows down.
    y: PAD + (1 - (p.y - minY) / (maxY - minY || 1)) * (H - PAD * 2),
  });

  return (
    <div className="map-system">
      <div className="map-crumb">
        <button className="undo-suggest" onClick={onClose}>← subsector</button>
        <b>{sys.name}</b>
        <span className="dim">
          {sys.level != null ? `Lv. ${sys.level}` : ""}{sys.faction ? ` · ${sys.faction}` : ""}
          {sys.knowledge === "known" ? " · never visited" : ""}
        </span>
        <span className="spacer" />
        {sys.materials && <span className="dim">{Math.round(sys.materials.volume).toLocaleString()} m³ stored</span>}
      </div>

      {err && <div className="sum-msg err">⚠ {err}</div>}
      {!pois && !err && <p className="hint">Reading system…</p>}
      {pois && pois.length === 0 && <p className="hint">Nothing known in this system.</p>}

      {pois && pois.length > 0 && (
        <>
          <div className="map-graph">
            <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="xMidYMid meet">
              {pois.map((p) => {
                const c = at(p);
                return (
                  <g key={p.guid} className={`map-poi k-${p.kind}`}>
                    <circle cx={c.x} cy={c.y} r={13} />
                    <text className="map-poi-glyph" x={c.x} y={c.y + 4} textAnchor="middle">{KIND_GLYPH[p.kind] ?? "●"}</text>
                    <text className="map-poi-name" x={c.x} y={c.y + 27} textAnchor="middle">{p.name}</text>
                    <title>{p.kind}{p.faction ? ` · ${p.faction}` : ""}{p.station?.shops?.length ? ` · ${p.station.shops.join(", ")}` : ""}</title>
                  </g>
                );
              })}
            </svg>
          </div>
          <div className="map-poi-list">
            {pois.map((p) => (
              <div key={p.guid} className="map-poi-row">
                <span className="map-poi-kind">{KIND_GLYPH[p.kind] ?? "●"} {p.kind.replace(/([a-z])([A-Z])/g, "$1 $2")}</span>
                <b>{p.name}</b>
                {p.faction && <span className="dim">{p.faction}</span>}
                {p.dynamic && <span className="map-dyn" title="dynamic / mission POI">dynamic</span>}
                <span className="spacer" />
                {p.station?.shops?.length ? <span className="map-shops">{p.station.shops.join(" · ")}</span> : null}
                {p.station?.dryDock && <span className="dim">dry dock</span>}
                {p.station?.workshop && <span className="dim">workshop</span>}
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

// The in-game tooltip, restructured: the same facts, grouped and labelled instead of a flat list.
// Umbral reach is a 0-1 fraction; the game shows it as a percentage and gates the umbral shop on it.
const umbralHint = (reach: number, forShop?: number | null) =>
  forShop == null
    ? "Umbral influence in this system"
    : reach >= forShop
      ? `Umbral influence ${Math.round(reach * 100)}% — at or above the ${Math.round(forShop * 100)}% the umbral shop needs, so it's available here`
      : `Umbral influence ${Math.round(reach * 100)}% — the umbral shop needs ${Math.round(forShop * 100)}%`;

function SystemTip({ conn, sys, x, y, levelCap, sector, factions, umbralForShop }: {
  conn: Conn; sys: GalaxySystem; x: number; y: number; levelCap: number; sector: GalaxySector | null;
  factions?: GalaxyFaction[];   // the game's own faction colours, for the owner line
  umbralForShop?: number | null; // threshold from /galaxy.conquest, so the % can say what it unlocks
}) {
  const { ref, style } = useCursorTip(x, y);
  const c = sys.conquest;
  const kind = classify(sys);
  // These sit above their subsector's band, which is the whole reason to seek them out.
  const overLevel = kind && sector?.levelRange && sys.level != null && sys.level > sector.levelRange[1];
  return (
    <div className="tip map-tip" ref={ref} style={style}>
      <div className="tip-name-row">
        <span className="tip-name">{sys.name}</span>
        <span className="tip-lvl">{sys.level != null ? `Lv. ${sys.level}` : sys.knowledge}</span>
      </div>
      <div className="tip-head">{sys.knowledge === "visited" ? "visited" : "not visited"}</div>
      {kind && (
        <div className="map-tip-special" style={{ borderColor: SPECIALS[kind].color }}>
          <span style={{ color: SPECIALS[kind].color }}>{SPECIALS[kind].glyph} {SPECIALS[kind].label}</span>
          {overLevel && <span className="dim"> · Lv {sys.level} vs subsector {sector!.levelRange![0]}–{sector!.levelRange![1]}</span>}
        </div>
      )}
      {sys.faction && (
        <div className="tip-line">Controlled by{" "}
          <FactionMark conn={conn} id={sys.factionId} name={sys.faction}
            color={colorFor(factions, sys.factionId, sys.faction)} size={13} />
        </div>
      )}

      {sys.stations && sys.stations.length > 0 && (
        <div className="tip-subs">
          <div className="tip-cmp-head">Space stations</div>
          {sys.stations.map((st) => (
            <div key={st.name} className="tip-cmp-row">
              <span>{st.name}</span>
              {/* The cycle is galaxy-wide, so a per-station clock would be the same number repeated. What
                  differs is whether this one is stale from an earlier cycle and rerolls when you arrive. */}
              {st.due && <span className="tip-restock" title="Stock is stale — it rerolls when you dock">new stock on arrival</span>}
              <FactionMark conn={conn} id={st.factionId} name={st.faction}
                color={colorFor(factions, st.factionId, st.faction)} size={13} />
            </div>
          ))}
        </div>
      )}

      {sys.materials && (
        <div className="tip-cmp">
          <div className="tip-cmp-head">Materials stored</div>
          <div className="tip-cmp-row"><span>{Math.round(sys.materials.volume).toLocaleString()} m³</span><span className="dim">{sys.materials.distinct} kinds</span></div>
          <div className="tip-asp-desc">{sys.materials.items.join(", ")}{sys.materials.distinct > sys.materials.items.length ? ", …" : ""}</div>
        </div>
      )}

      {c && (
        // Every row says what the number MEANS, in the unit the game uses. The raw values are unreadable on
        // their own: "Umbral reach 1" is a 0-1 fraction that the game prints as 100%, and "System control
        // 1 yours 0" is two separate control levels with no hint that they're being compared.
        <div className="tip-cmp">
          <div className="tip-cmp-head">Conquest{c.headquarters ? " · headquarters" : ""}</div>
          <div className="tip-cmp-row" title="Defending fleet power in this system">
            <span>Defending fleet</span><span>{Math.round(c.combatStrength).toLocaleString()}</span>
          </div>
          <div className="tip-cmp-row" title={`Added each conquest tick: ${c.baseReinforcements} base${c.hqReinforcements ? ` + ${c.hqReinforcements} from the headquarters` : ""}`}>
            <span>Reinforcements</span>
            <span>+{c.totalReinforcements}<span className="dim"> per tick</span></span>
          </div>
          {/* `controlLevel` / `playerControlLevel` are deliberately not shown: the rule that turns them into
              the game's label ("System control: Secure") is unknown, and the bare numbers invite a comparison
              that may not hold. They remain available in /galaxy. */}
          <div className="tip-cmp-row" title={umbralHint(c.umbralControlLevel, umbralForShop)}>
            <span>Umbral reach</span>
            <span>
              {Math.round(c.umbralControlLevel * 100)}%
              {umbralForShop != null && (
                <span className="dim">
                  {c.umbralControlLevel >= umbralForShop ? " · shop open" : ` · shop at ${Math.round(umbralForShop * 100)}%`}
                </span>
              )}
            </span>
          </div>
        </div>
      )}

      {sys.missions && sys.missions.length > 0 && (
        <div className="tip-cmp">
          <div className="tip-cmp-head">Missions</div>
          {sys.missions.map((m) => <div key={m.name} className="tip-sub">{m.name}</div>)}
        </div>
      )}

      {sys.poiKinds && (
        // Bare "Combat 1 Mining 1 Salvage 1" gave no clue these are things IN the system — say so once.
        <div className="tip-foot map-kinds" title="What this system contains">
          <span className="dim">Here:</span>
          {Object.entries(sys.poiKinds).map(([k, n]) => <span key={k}>{n}× {k.replace(/([a-z])([A-Z])/g, "$1 $2")}</span>)}
        </div>
      )}
      {sys.level != null && (
        // An unlabelled gradient bar is a riddle. Say what it measures: this system's level against the cap
        // (frontier systems climb as conquest advances, so "how far along is this one" is the question).
        <div className="map-levelrow">
          <span className="dim">System level</span>
          <span className="map-levelbar" title={`Level ${sys.level} of a maximum ${levelCap}`}>
            <span style={{ width: `${Math.min(100, (sys.level / levelCap) * 100)}%` }} />
          </span>
          <span className="map-levelnum">{sys.level}<span className="dim"> / {levelCap}</span></span>
        </div>
      )}
    </div>
  );
}




