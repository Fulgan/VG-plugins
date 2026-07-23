import { useEffect, useMemo, useState, type CSSProperties, type MouseEvent } from "react";
import { buildCatalog, defaultPriorities, evaluateRecruits, MAX_LEVEL, optimize, prioritiesFromCrew, type CatalogSkill, type OptimizeResult, type RecruitOfficer, type Scope } from "./officer";
import { composeActivity, type ActivityProfile, type MainActivity } from "./activityPresets";
import type { Officer, Recruits } from "./types";
import "./officers.css";

// Ship the optimizer targets (owned ship joined from /officers + /ships).
export interface BuilderShip {
  guid: string;
  name: string;
  role: string | null;
  slots: number;
  hasDroneBay: boolean;
  assigned: (string | null)[]; // currently-assigned officer guids (per slot)
}

const RARITY_COLOR: Record<string, string> = {
  Standard: "#cfcfcf", Enhanced: "#58c26b", HighGrade: "#4aa3ff", Exotic: "#c07bff", Legendary: "#ffb020",
};
const initials = (nm: string) => nm.split(" ").map((w) => w[0]).slice(0, 2).join("");

// Shared builder state (ship pick, per-ship priorities + pins, scope). Lifted into App so the Officers
// and Summary tabs render the same optimizer result.
export interface OfficerBuilder {
  officers: Officer[];
  ships: BuilderShip[];
  ship: BuilderShip | undefined;
  shipIdx: number;
  setShipIdx: (i: number) => void;
  scope: Scope;
  setScope: (s: Scope) => void;
  catalog: CatalogSkill[];
  prio: string[];
  setPrio: (p: string[]) => void;
  forced: Set<string>;
  togglePin: (guid: string) => void;
  result: OptimizeResult | null;
}

// Persisted builder choices (per-ship priorities + pins, scope) — survive page reloads.
const BUILDER_KEY = "shipoptimizer.officerBuilder";
interface BuilderSaved { prio: Record<string, string[]>; forced: Record<string, string[]>; scope: Scope }
function loadBuilder(): BuilderSaved {
  try {
    const r = localStorage.getItem(BUILDER_KEY);
    if (r) return { prio: {}, forced: {}, scope: "potential", ...JSON.parse(r) };
  } catch { /* ignore */ }
  return { prio: {}, forced: {}, scope: "potential" };
}

export function useOfficerBuilder(officers: Officer[], ships: BuilderShip[]): OfficerBuilder {
  const catalog = useMemo(() => buildCatalog(officers), [officers]);
  const [shipIdx, setShipIdx] = useState(0);
  const ship = ships[Math.min(shipIdx, Math.max(0, ships.length - 1))];

  const [saved] = useState(loadBuilder);
  const [scope, setScope] = useState<Scope>(saved.scope);
  const [prioByShip, setPrioByShip] = useState<Record<string, string[]>>(saved.prio);
  const [forcedByShip, setForcedByShip] = useState<Record<string, string[]>>(saved.forced);

  // Persist choices whenever they change.
  useEffect(() => {
    try { localStorage.setItem(BUILDER_KEY, JSON.stringify({ prio: prioByShip, forced: forcedByShip, scope })); } catch { /* quota */ }
  }, [prioByShip, forcedByShip, scope]);

  // A ship with no stored priority list yet falls back to the role default (until the user edits it).
  const prio = ship ? prioByShip[ship.guid] ?? defaultPriorities(catalog, ship.role) : [];
  const setPrio = (next: string[]) => ship && setPrioByShip((m) => ({ ...m, [ship.guid]: next }));

  const forced = useMemo(() => new Set(ship ? forcedByShip[ship.guid] ?? [] : []), [forcedByShip, ship]);
  const togglePin = (guid: string) =>
    ship && setForcedByShip((m) => {
      const cur = new Set(m[ship.guid] ?? []);
      if (cur.has(guid)) cur.delete(guid); else cur.add(guid);
      return { ...m, [ship.guid]: [...cur] };
    });

  const result = useMemo(
    () => ship
      ? optimize({ officers, slots: ship.slots, role: ship.role, hasDroneBay: ship.hasDroneBay, priorities: prio, scope, forced })
      : null,
    [officers, ship, prio, scope, forced],
  );

  return { officers, ships, ship, shipIdx, setShipIdx, scope, setScope, catalog, prio, setPrio, forced, togglePin, result };
}

export default function OfficersTab({
  builder, portraitUrl, recruits, portraitByIcon, profile, setProfile, goSummary,
}: {
  builder: OfficerBuilder;
  portraitUrl: (guid: string | null) => string | null;
  recruits: Recruits | null;
  portraitByIcon: (icon: string | null) => string | null;
  profile: ActivityProfile;
  setProfile: (p: ActivityProfile) => void;
  goSummary: () => void;
}) {
  const { officers, ships, ship, shipIdx, setShipIdx, scope, setScope, catalog, prio, setPrio, forced, togglePin, result } = builder;

  // Stable per-skill hue so a skill reads the same everywhere (priority list, cards, roster).
  const hueOf = useMemo(() => {
    const m = new Map<string, number>();
    catalog.forEach((c, i) => m.set(c.id, catalog.length ? (i * 360) / catalog.length : 0));
    return (id: string) => m.get(id) ?? 0;
  }, [catalog]);
  const skillChip = (id: string, strong: boolean): CSSProperties => {
    const h = hueOf(id);
    return {
      display: "inline-flex", alignItems: "center", gap: "4px",
      fontSize: "10.5px", borderRadius: "10px", padding: "1px 8px", whiteSpace: "nowrap",
      color: `hsl(${h} 62% ${strong ? 74 : 62}%)`,
      background: `hsl(${h} 55% 45% / ${strong ? 0.22 : 0.1})`,
      border: `1px solid hsl(${h} 55% 55% / ${strong ? 0.6 : 0.3})`,
      fontWeight: strong ? 600 : 400,
    };
  };
  const skillDot = (id: string): CSSProperties => ({ flex: "0 0 auto", width: "8px", height: "8px", borderRadius: "50%", background: `hsl(${hueOf(id)} 62% 62%)` });

  // How many owned officers have each skill in their kit (full potential) — roster coverage.
  const rosterCount = useMemo(() => {
    const m = new Map<string, number>();
    for (const o of officers) for (const s of o.potential) m.set(s.id, (m.get(s.id) ?? 0) + 1);
    return (id: string) => m.get(id) ?? 0;
  }, [officers]);

  const nameOf = (id: string) => catalog.find((c) => c.id === id)?.name ?? id;
  const byUnlock = (a: { unlock?: number }, b: { unlock?: number }) => (a.unlock ?? 0) - (b.unlock ?? 0); // activation order

  // Styled skill tooltip (game-like) — follows the cursor; one instance rendered per tab. Shared hover
  // props + per-skill colour so EVERY skill display (chips, priority rows, rank labels) reads the same.
  const [skillHover, setSkillHover] = useState<{ id: string; x: number; y: number } | null>(null);
  // Generic styled info tooltip (same look as the skill cards) — for the (i) markers.
  const [infoTip, setInfoTip] = useState<{ text: string; x: number; y: number } | null>(null);
  const infoProps = (text: string) => ({
    onMouseEnter: (e: MouseEvent) => setInfoTip({ text, x: e.clientX, y: e.clientY }),
    onMouseMove: (e: MouseEvent) => setInfoTip({ text, x: e.clientX, y: e.clientY }),
    onMouseLeave: () => setInfoTip(null),
  });
  const skillColor = (id: string) => `hsl(${hueOf(id)} 62% 72%)`;
  // No native `title` — the styled tooltip below replaces it (avoids a double tooltip).
  const skillHoverProps = (id: string) => ({
    onMouseEnter: (e: MouseEvent) => setSkillHover({ id, x: e.clientX, y: e.clientY }),
    onMouseMove: (e: MouseEvent) => setSkillHover({ id, x: e.clientX, y: e.clientY }),
    onMouseLeave: () => setSkillHover((h) => (h?.id === id ? null : h)),
  });
  // A skill pill: hue-colored, tooltip on hover, a leading dot when it's in the priority list (strong),
  // dimmed when the officer hasn't unlocked it yet.
  const chipEl = (id: string, strong: boolean, dim = false) => (
    <span key={id} style={{ ...skillChip(id, strong), ...(dim ? { opacity: 0.4 } : null) }} {...skillHoverProps(id)}>
      {strong && <span style={{ width: 6, height: 6, borderRadius: "50%", background: `hsl(${hueOf(id)} 62% 62%)`, flex: "0 0 auto" }} />}
      {nameOf(id)}
    </span>
  );

  const [drag, setDrag] = useState<{ from: number; over: number } | null>(null);
  const move = (i: number, d: number) => { const j = i + d; if (j < 0 || j >= prio.length) return; const p = prio.slice(); [p[i], p[j]] = [p[j], p[i]]; setPrio(p); };
  const reorder = (from: number, to: number) => { if (from === to) return; const p = prio.slice(); const [it] = p.splice(from, 1); p.splice(to, 0, it); setPrio(p); };
  const addPrio = (id: string) => { if (id && !prio.includes(id)) setPrio([...prio, id]); };

  // Activity profile → suggested priority list (replace). Compose skill names, map to live catalog ids.
  // Snapshot the prior list (per ship) so Suggest is one-level undoable.
  const byName = useMemo(() => new Map(catalog.map((c) => [c.name, c.id])), [catalog]);
  const [undoPrio, setUndoPrio] = useState<{ guid: string; list: string[] } | null>(null);
  const snapshot = () => { if (ship) setUndoPrio({ guid: ship.guid, list: prio }); };
  const suggest = () => {
    snapshot();
    setPrio([...new Set(composeActivity(profile).map((n) => byName.get(n)).filter((id): id is string => !!id))]);
  };
  // Seed priorities from the ship's currently-assigned crew (skills ranked by how many carry them).
  const assignedOfficers = useMemo(
    () => (ship?.assigned ?? []).filter((g): g is string => !!g).map((g) => officers.find((o) => o.guid === g)).filter((o): o is Officer => !!o),
    [ship, officers],
  );
  const suggestFromCrew = () => {
    if (!ship) return;
    snapshot();
    setPrio(prioritiesFromCrew(assignedOfficers, { scope, hasDroneBay: ship.hasDroneBay }));
  };
  const canUndo = !!undoPrio && !!ship && undoPrio.guid === ship.guid;
  const undoSuggest = () => { if (canUndo) { setPrio(undoPrio!.list); setUndoPrio(null); } };
  const setP = (patch: Partial<ActivityProfile>) => setProfile({ ...profile, ...patch });
  const [showActivity, setShowActivity] = useState(false);
  const [addOpen, setAddOpen] = useState(false);
  const [rosterQ, setRosterQ] = useState("");
  const activitySummary = [
    profile.main[0].toUpperCase() + profile.main.slice(1),
    ...(profile.main === "combat" ? [profile.combatStance, profile.combatLayer] : []),
    ...(profile.echo ? ["ECHO"] : []), ...(profile.drone ? ["drone"] : []), ...(profile.boarding ? ["boarding"] : []),
  ].join(" · ");

  if (!ships.length) return <p className="hint">No ships with officer slots found. Dock and refresh.</p>;
  if (!officers.length) return <p className="hint">No officers in your roster yet.</p>;
  if (!ship) return <p className="hint">No ship selected.</p>;

  const maxRank = Math.max(1, ...(result?.ranks.map((r) => r.rank) ?? [1]));
  const addOptions = catalog.filter((c) => !prio.includes(c.id));

  // Station recruits scored against the selected ship's crew — flag hires that out-rank the weakest.
  const stationView = recruits?.hasPersonnelCenter && result
    ? evaluateRecruits(recruits.officers as RecruitOfficer[], { role: ship.role, hasDroneBay: ship.hasDroneBay, priorities: prio, scope }, result.chosen)
    : [];
  const stationOppCount = stationView.filter((o) => o.isOpp).length;

  // Apply diff: the optimizer's proposed crew vs the ship's current assignment.
  const assignedNow = new Set((ship.assigned ?? []).filter((g): g is string => !!g));
  const chosenGuids = new Set((result?.chosen ?? []).map((o) => o.guid));
  const joining = (result?.chosen ?? []).filter((o) => !assignedNow.has(o.guid));
  const leaving = officers.filter((o) => assignedNow.has(o.guid) && !chosenGuids.has(o.guid));
  // Align current → proposed per slot: officers that STAY keep their current slot (so top == bottom
  // and a pure slot-swap doesn't read as a change); joiners fill the slots vacated by leavers. This
  // is the booster optimizer's before→after slot layout applied to officers.
  const stay = new Set((result?.chosen ?? []).map((o) => o.guid).filter((g) => assignedNow.has(g)));
  const curBySlot = Array.from({ length: ship.slots }, (_, i) => officers.find((o) => o.guid === (ship.assigned[i] ?? "")) ?? null);
  const afterBySlot: (Officer | null)[] = new Array(ship.slots).fill(null);
  curBySlot.forEach((o, i) => { if (o && stay.has(o.guid)) afterBySlot[i] = o; });
  const joiners = (result?.chosen ?? []).filter((o) => !stay.has(o.guid));
  let ji = 0;
  for (let i = 0; i < ship.slots; i++) if (!afterBySlot[i]) afterBySlot[i] = joiners[ji++] ?? null;

  const offCard = (o: Officer | null, kind: "current" | "after") => {
    if (!o) return <div className="ocard empty"><span className="oc-name dim">{kind === "after" ? "— empty" : "empty slot"}</span></div>;
    const rc = RARITY_COLOR[o.rarity] ?? "#cfcfcf";
    const pu = portraitUrl(o.guid);
    const kit = scope === "potential" ? o.potential : o.current;
    const prioSet = new Set(prio);
    const pri = kit.filter((s) => prioSet.has(s.id)).sort(byUnlock);
    const other = kit.filter((s) => !prioSet.has(s.id)).sort(byUnlock);
    return (
      <div className={`ocard${kind === "after" ? " best" : ""}`}>
        <div className="oc-top">
          <div className="oc-portrait" style={{ borderColor: rc, color: rc }}>{pu ? <div className="portrait-img" style={{ backgroundImage: `url("${pu}")` }} /> : initials(o.name)}</div>
          <div className="oc-id">
            <div className="oc-name-row"><span className="oc-name" style={{ color: rc }}>{o.name}</span>{o.level >= MAX_LEVEL && <span className="max">MAX</span>}</div>
            <div className="oc-sub">Lv {o.level} · {o.profession}</div>
          </div>
        </div>
        <div className="oc-skills">
          {pri.map((s) => chipEl(s.id, true))}
          {other.map((s) => chipEl(s.id, false, true))}
          {!pri.length && <span className="filler">no priority skills</span>}
        </div>
        {o.bonusValue ? <div className="oc-bonus">+{(o.bonusValue * 100).toFixed(1)}% {o.chosenBonus}</div> : null}
      </div>
    );
  };

  // Crew passive bonuses: sum each assigned officer's chosen-stat bonus, by stat (fraction → %).
  const crewBonuses = (() => {
    const m = new Map<string, number>();
    for (const o of result?.chosen ?? []) if (o.bonusValue) m.set(o.chosenBonus, (m.get(o.chosenBonus) ?? 0) + o.bonusValue);
    return [...m.entries()].sort((a, b) => b[1] - a[1]);
  })();

  // Roster search — match name / profession / any skill name.
  const rosterShown = (result?.sorted ?? []).filter((o) => {
    const q = rosterQ.trim().toLowerCase();
    if (!q) return true;
    return o.name.toLowerCase().includes(q) || o.profession.toLowerCase().includes(q) || o.potential.some((s) => s.name.toLowerCase().includes(q));
  });

  return (
    <div className="officers">
      {/* ship context bar */}
      <div className="ctx-bar">
        {ships.length > 1 && (
          <select value={shipIdx} onChange={(e) => setShipIdx(Number(e.target.value))}>
            {ships.map((s, i) => (<option key={s.guid} value={i}>{s.name}{s.role ? ` · ${s.role}` : ""}</option>))}
          </select>
        )}
        <span className="ctx-line">
          <b>{ship.name}</b> · <span className="role-hi">{ship.role ?? "—"}</span> role ·{" "}
          <b>{ship.slots}</b> officer slots ·{" "}
          <span style={{ color: ship.hasDroneBay ? "#86efac" : "#7d7d86" }}>{ship.hasDroneBay ? "drone bay" : "no drone bay"}</span>
        </span>
        <span className="sep" />
        {result && (
          <span className="ctx-idle" title="Idle income from officers not assigned to this ship">
            <span className="idle-v">¢ {result.idleTotal.toLocaleString()}</span> / hr idle
            <span className="dim"> · {result.benchedCount} benched</span>
          </span>
        )}
        <span className="spacer" />
        <span className="dim" title="Evaluate skills at each officer's current unlocked level, or full potential once maxed">Skills at</span>
        <button className={`seg ${scope === "current" ? "on" : ""}`} onClick={() => setScope("current")}>current level</button>
        <button className={`seg ${scope === "potential" ? "on" : ""}`} onClick={() => setScope("potential")}>full potential</button>
        <button className="apply sm" style={{ marginLeft: 8 }} onClick={goSummary} title="Review & apply changes in the Summary tab">Go to Summary →</button>
      </div>

      <div className="opt-grid">
        {/* priority skills */}
        <div className="panel">
          <div className="panel-title title-info">Priority skills <span className="info" {...infoProps("Highest first. The optimizer fills every officer slot to maximize the rank of #1, then #2, and so on. Each assigned officer that has a skill adds +1 rank; ranks stack.")}>ⓘ</span></div>

          {/* activity profile → suggested priorities (collapsible; global, shared by all optimizers) */}
          <div className="activity">
            <button className="act-head" onClick={() => setShowActivity((v) => !v)} aria-expanded={showActivity}>
              <span className="act-caret">{showActivity ? "▾" : "▸"}</span>
              <span className="act-title">Suggest priorities by activity</span>
              <span className="act-summary">{activitySummary}</span>
            </button>
            {showActivity && (
              <div className="act-body">
                <div className="act-row main">
                  <select value={profile.main} onChange={(e) => setP({ main: e.target.value as MainActivity })}>
                    <option value="combat">Combat</option>
                    <option value="mining">Mining</option>
                    <option value="salvage">Salvage</option>
                    <option value="crafting">Crafting</option>
                  </select>
                  {profile.main === "combat" && (
                    <>
                      <span className="seg-group">
                        <button className={`seg ${profile.combatStance === "offence" ? "on" : ""}`} onClick={() => setP({ combatStance: "offence" })}>off</button>
                        <button className={`seg ${profile.combatStance === "defence" ? "on" : ""}`} onClick={() => setP({ combatStance: "defence" })}>def</button>
                      </span>
                      <span className="seg-group">
                        <button className={`seg ${profile.combatLayer === "shield" ? "on" : ""}`} onClick={() => setP({ combatLayer: "shield" })}>shield</button>
                        <button className={`seg ${profile.combatLayer === "armor" ? "on" : ""}`} onClick={() => setP({ combatLayer: "armor" })}>armor</button>
                      </span>
                    </>
                  )}
                </div>
                <div className="act-row">
                  <span className="act-flags">
                    <label><input type="checkbox" checked={profile.echo} onChange={(e) => setP({ echo: e.target.checked })} /> ECHO</label>
                    <label><input type="checkbox" checked={profile.drone} onChange={(e) => setP({ drone: e.target.checked })} /> Drone</label>
                    <label><input type="checkbox" checked={profile.boarding} onChange={(e) => setP({ boarding: e.target.checked })} /> Boarding</label>
                  </span>
                </div>
                <div className="act-row">
                  <button className="suggest ghost" onClick={suggestFromCrew} disabled={!assignedOfficers.length} title="Seed priorities from this ship's currently-assigned crew">From current crew</button>
                  <span className="spacer" />
                  {canUndo && <button className="undo-suggest" onClick={undoSuggest} title="Restore the priority list from before the last Suggest">↶ undo</button>}
                  <button className="suggest" onClick={suggest} title="Replace the priority list with this activity's preset">Suggest ↻</button>
                </div>
              </div>
            )}
          </div>

          <div className="prio-list">
            {prio.map((id, i) => {
              const over = drag?.over === i && drag.from !== i;
              return (
                <div
                  key={id}
                  className={`prio-row${over ? " over" : ""}${drag?.from === i ? " dragging" : ""}`}
                  draggable
                  onDragStart={() => setDrag({ from: i, over: i })}
                  onDragOver={(e) => { e.preventDefault(); setDrag((d) => (d ? { ...d, over: i } : d)); }}
                  onDrop={(e) => { e.preventDefault(); if (drag) reorder(drag.from, i); setDrag(null); }}
                  onDragEnd={() => setDrag(null)}
                >
                  <span className="grip" title="drag to reorder">⠿</span>
                  <span className="pos">{i + 1}</span>
                  <div className="prio-main">
                    <div className="prio-name-row">
                      <span style={skillDot(id)} />
                      <span className="prio-name" style={{ color: skillColor(id), fontWeight: catalog.find((c) => c.id === id)?.major ? 600 : 500 }} {...skillHoverProps(id)}>{nameOf(id)}</span>
                      <span className="spacer" />
                      {(() => { const rk = result?.ranks.find((r) => r.id === id)?.rank ?? 0; return <span className={`prio-rank${rk > 0 ? " on" : ""}`} title={`${rk} assigned officer${rk === 1 ? "" : "s"} carry this skill — ranks stack`}>×{rk}</span>; })()}
                    </div>
                    <div className="prio-eff">{catalog.find((c) => c.id === id)?.effect ?? ""}</div>
                  </div>
                  <div className="prio-btns">
                    <button disabled={i === 0} onClick={() => move(i, -1)} title="up">▲</button>
                    <button disabled={i === prio.length - 1} onClick={() => move(i, 1)} title="down">▼</button>
                    <button className="rm" onClick={() => setPrio(prio.filter((x) => x !== id))} title="remove">×</button>
                  </div>
                </div>
              );
            })}
            {!prio.length && <p className="hint">Add a priority skill below to start.</p>}
          </div>
          <div className="add-prio-wrap">
            <button className="add-prio-btn" onClick={() => setAddOpen((v) => !v)}>
              + add priority skill… <span className="dim">{addOpen ? "▲" : "▼"}</span>
            </button>
            {addOpen && (
              <div className="add-prio-menu">
                {addOptions.map((c) => (
                  <div key={c.id} className="add-prio-item" {...skillHoverProps(c.id)} onClick={() => { addPrio(c.id); setAddOpen(false); setSkillHover(null); }}>
                    <span className={`prio-rank${rosterCount(c.id) > 0 ? " on" : ""}`} title={`${rosterCount(c.id)} officer${rosterCount(c.id) === 1 ? "" : "s"} in your roster have this skill`}>×{rosterCount(c.id)}</span>
                    <span className="ap-name" style={{ color: skillColor(c.id), fontWeight: c.major ? 600 : 500 }}>{c.name}</span>
                    <span className="ap-eff">{c.effect}</span>
                  </div>
                ))}
                {!addOptions.length && <div className="add-prio-item dim">all skills added</div>}
              </div>
            )}
          </div>
        </div>

        {/* optimized crew */}
        <div>
          <div className="crew-head">
            <div className="panel-title">Optimized crew <span className="dim">— {ship.slots} slots · {prio.length ? `top-${ship.slots} by priority coverage` : "add a priority skill"}</span></div>
            {(joining.length > 0 || leaving.length > 0)
              ? <span className="crew-diff" title="Change vs the ship's current crew">{joining.length > 0 && <span className="up">+{joining.length}</span>}{leaving.length > 0 && <span className="down"> −{leaving.length}</span>} vs current</span>
              : <span className="dim">matches current crew</span>}
          </div>
          <div className="oslot-grid">
            {Array.from({ length: ship.slots }, (_, i) => {
              const cur = curBySlot[i], aft = afterBySlot[i];
              const chg = (cur?.guid ?? null) !== (aft?.guid ?? null);
              return (
                <div key={i} className={`oslot${chg ? " chg" : ""}`}>
                  <div className="bslot-head">
                    <span className="bslot-num">Slot {i + 1}</span>
                    <span className="spacer" />
                    {chg ? <span className="oslot-tag">changes</span> : <span className="oslot-same">unchanged</span>}
                  </div>
                  {offCard(cur, "current")}
                  <div className="barrow">▼</div>
                  {offCard(aft, "after")}
                </div>
              );
            })}
          </div>

          {/* resulting ranks */}
          <div className="panel ranks">
            <div className="panel-note">Resulting stacked ranks across the assigned crew</div>
            {result?.ranks.map((r) => (
              <div key={r.id} className="rank-row">
                <span className="rank-name" style={{ color: skillColor(r.id) }} {...skillHoverProps(r.id)}>{r.name}</span>
                <div className="rank-track"><div className="rank-fill" style={{ width: `${(r.rank / maxRank) * 100}%`, background: r.rank > 0 ? "#4ad06a" : "transparent" }} /></div>
                <span className="rank-val" style={{ color: r.rank > 0 ? "#86efac" : "#5a5a62" }}>×{r.rank}</span>
              </div>
            ))}
            {!prio.length && <p className="hint">No priorities yet.</p>}
          </div>

          {/* crew passive stat bonuses (each officer's chosen-stat bonus, summed) */}
          {crewBonuses.length > 0 && (
            <div className="panel ranks">
              <div className="panel-note">Crew passive bonuses <span className="dim">— summed chosen-stat bonus across the assigned crew</span></div>
              <div className="bonus-list">
                {crewBonuses.map(([stat, v]) => (
                  <span key={stat} className="bonus-chip">+{(v * 100).toFixed(1)}% {stat}</span>
                ))}
              </div>
            </div>
          )}
        </div>
      </div>

      {/* roster */}
      <div className="panel roster">
        <div className="roster-head">
          <div className="panel-title">Owned officer roster <span className="dim">— ranked by priority coverage; top {ship.slots} assigned</span></div>
          <input className="roster-search" value={rosterQ} onChange={(e) => setRosterQ(e.target.value)} placeholder="filter name / profession / skill…" />
        </div>
        {rosterShown.map((o) => {
          const rc = RARITY_COLOR[o.rarity] ?? "#cfcfcf";
          const on = !!result?.chosen.some((c) => c.guid === o.guid);
          const pinned = forced.has(o.guid);
          const pu = portraitUrl(o.guid);
          return (
            <div key={o.guid} className={`roster-row${on ? " on" : ""}`}>
              <span className="badge-dot" style={{ color: pinned ? "#ffcf70" : "#4ad06a" }}>{on ? "●" : ""}</span>
              <div className="avatar" style={{ borderColor: rc, color: rc }}>
                <span>{initials(o.name)}</span>
                {pu && <div className="portrait-img" style={{ backgroundImage: `url("${pu}")` }} />}
              </div>
              <span className="roster-name" style={{ color: rc, fontWeight: on ? 600 : 400 }}>{o.name}</span>
              <span className="roster-prof dim">{o.profession} · Lv{o.level}</span>
              <span className="roster-max">{o.level >= MAX_LEVEL && <span className="max">MAX</span>}</span>
              <span className="roster-idle" title={on ? "Assigned — inactive (earns no idle income)" : "Benched — earning idle income"} style={{ color: on ? "#6a6a72" : "#c7ccd4" }}>¢ {o.idle.toLocaleString()}/hr</span>
              <div className="roster-skills">
                {(() => {
                  // Show the officer's full kit. Split by UNLOCKED-BY-LEVEL: skills active at the officer's
                  // current level, then a red divider, then rolled-but-not-yet-unlocked (needs more XP),
                  // dimmed. Drone-bay gating is the optimizer's concern, not this display.
                  const curIds = new Set(o.current.map((s) => s.id));
                  const list = scope === "potential" ? o.potential : o.current;
                  const act = list.filter((s) => curIds.has(s.id)).sort(byUnlock);
                  const lck = list.filter((s) => !curIds.has(s.id)).sort(byUnlock);
                  return (
                    <>
                      {act.map((s) => chipEl(s.id, prio.includes(s.id)))}
                      {lck.length > 0 && <span className="xp-sep" title="below: not yet unlocked — needs more level / XP" />}
                      {lck.map((s) => chipEl(s.id, prio.includes(s.id), true))}
                    </>
                  );
                })()}
              </div>
              <button className={`pin${pinned ? " on" : ""}`} onClick={() => togglePin(o.guid)} title="Force this officer into an assigned slot">{pinned ? "★ forced" : "☆ force"}</button>
            </div>
          );
        })}
        {!rosterShown.length && <p className="hint">No officers match “{rosterQ}”.</p>}
      </div>

      {/* personal center — officer hire opportunities */}
      {recruits?.hasPersonnelCenter && (
        <div className="panel roster">
          <div className="panel-title">Personal Center <span className="dim">— {recruits.station} · officers to hire</span></div>
          <div className="panel-note">
            {stationOppCount ? `${stationOppCount} would out-rank an assigned officer` : "none better than your current crew"}. Highlighted officers would out-rank one you have assigned.
          </div>
          {stationView.map((o) => {
            const rc = RARITY_COLOR[o.rarity] ?? "#cfcfcf";
            // Full kit: priority-covered skills first, the rest dimmed (like the crew cards/roster).
            const prioSet = new Set(prio);
            const kit = scope === "potential" ? o.potential : o.current;
            const priSk = kit.filter((s) => prioSet.has(s.id)).sort(byUnlock);
            const otherSk = kit.filter((s) => !prioSet.has(s.id)).sort(byUnlock);
            const pu = portraitByIcon(o.icon);
            return (
              <div key={o.guid} className={`recruit-row${o.isOpp ? " opp" : ""}`}>
                <div className="avatar" style={{ borderColor: rc, color: rc, width: 34, height: 34 }}>
                  <span>{initials(o.name)}</span>
                  {pu && <div className="portrait-img" style={{ backgroundImage: `url("${pu}")` }} />}
                </div>
                <div className="recruit-id">
                  <div className="crew-name-row">
                    <span className="roster-name" style={{ color: rc }}>{o.name}</span>
                    {o.level >= MAX_LEVEL && <span className="max">MAX</span>}
                  </div>
                  <div className="crew-sub">{o.profession} · Lv{o.level}</div>
                </div>
                <div className="roster-skills">
                  {priSk.map((s) => chipEl(s.id, true))}
                  {otherSk.map((s) => chipEl(s.id, false, true))}
                </div>
                {o.isOpp && <span className="recruit-opp">↑ replaces {o.replaces}</span>}
                <span className="recruit-cost">¢ {o.hireCost.toLocaleString()}</span>
              </div>
            );
          })}
          {!stationView.length && <p className="hint">No recruits available at this station.</p>}
        </div>
      )}

      {/* how it works — collapsible */}
      <details className="explainer">
        <summary>How the optimizer works</summary>
        <ul>
          <li><b>Priorities drive it.</b> Order skills top-down; it fills your ship's officer slots to maximize your #1 skill first, then #2, and so on.</li>
          <li><b>Rank</b> of a skill = how many assigned officers have it — each adds +1, they <b>stack</b>.</li>
          <li>It assigns the <b>best {ship.slots}</b> officers (your ship's slot count), judged on their own priority coverage.</li>
          <li><b>Ties</b> break in order: covers a higher priority the other misses → matches the ship's role → higher rarity → higher level.</li>
          <li><b>Current vs full potential</b> (top-right): score skills unlocked at each officer's level now, or as if maxed.</li>
          <li><b>Drone skills</b> only count when the ship has a <b>drone bay</b>{ship.hasDroneBay ? " (this one does)" : " (this one doesn't)"}.</li>
          <li><b>Force</b> (roster) locks an officer into a slot; the optimizer fills the rest around them.</li>
        </ul>
      </details>

      {/* game-style skill tooltip (follows cursor) */}
      {skillHover && (() => {
        const c = catalog.find((x) => x.id === skillHover.id);
        if (!c) return null;
        const flip = skillHover.x > window.innerWidth / 2;
        const style: CSSProperties = {
          position: "fixed", top: Math.min(skillHover.y + 16, window.innerHeight - 96),
          left: flip ? undefined : skillHover.x + 16, right: flip ? window.innerWidth - skillHover.x + 16 : undefined,
        };
        return (
          <div className="skill-tip" style={style}>
            <div className="skill-tip-head" style={{ color: `hsl(${hueOf(c.id)} 62% 74%)` }}>{c.name}</div>
            <div className="skill-tip-desc">{c.effect ?? "—"}</div>
            <div className="skill-tip-foot">{c.roles.join(", ") || "—"} · {c.major ? "major" : "minor"}{c.drone ? " · drone" : ""}</div>
          </div>
        );
      })()}

      {infoTip && (() => {
        const flip = infoTip.x > window.innerWidth / 2;
        const style: CSSProperties = {
          position: "fixed", top: Math.min(infoTip.y + 16, window.innerHeight - 96),
          left: flip ? undefined : infoTip.x + 16, right: flip ? window.innerWidth - infoTip.x + 16 : undefined,
        };
        return <div className="skill-tip" style={style}><div className="skill-tip-desc">{infoTip.text}</div></div>;
      })()}
    </div>
  );
}
