import { useCallback, useEffect, useMemo, useState, type CSSProperties, type MouseEvent } from "react";
import ApplyBar, { ApplyMsg } from "./ApplyBar";
import { Notice } from "./Notice";
import type { ApplyApi } from "./useApply";
import { buildCatalog, buildFullCatalog, defaultPriorities, evaluateRecruits, exportPriorities, importPriorities, isNamePrio, MAX_LEVEL, namePrioLabel, optimize, prioritiesFromCrew, type BrowsableSkill, type CatalogSkill, type OptimizeResult, type RecruitOfficer, type Scope } from "./officer";
import { composeActivity, defaultProfileForShip, DEFAULT_PROFILE, type ActivityProfile, type MainActivity } from "./activityPresets";
import { ApiError, api, type Conn } from "./api";
import type { Officer, Recruits } from "./types";
import { RARITY_COLOR, brokeMsg, undockedMsg, affordLine } from "./format";
import { load, save } from "./storage";
import { useConfirm } from "./Modal";
import "./officers.css";

// Ship the optimizer targets (owned ship joined from /officers + /ships).
export interface BuilderShip {
  guid: string;
  name: string;
  role: string | null;
  slots: number;
  hasDroneBay: boolean;
  defenseLayer: "shield" | "armor" | null; // from the ship's equipped defensive module slot
  assigned: (string | null)[]; // currently-assigned officer guids (per slot)
}

const initials = (nm: string) => nm.split(" ").map((w) => w[0]).slice(0, 2).join("");

// Shared builder state (ship pick, per-ship priorities + pins, scope). Lifted into App so the Officers
// and Summary tabs render the same optimizer result.
export interface OfficerBuilder {
  officers: Officer[];
  ships: BuilderShip[];
  ship: BuilderShip | undefined;
  scope: Scope;
  setScope: (s: Scope) => void;
  catalog: CatalogSkill[];
  prio: string[];
  setPrio: (p: string[]) => void;
  forced: Set<string>;
  togglePin: (guid: string) => void;
  setForced: (guids: string[]) => void; // replace the whole pin set (for restoring a saved loadout)
  result: OptimizeResult | null;
  profile: ActivityProfile;
  setProfile: (p: ActivityProfile) => void;
}

// Persisted builder choices (per-ship priorities + pins + activity profile, scope) — survive reloads.
const BUILDER_KEY = "shipoptimizer.officerBuilder";
interface BuilderSaved { prio: Record<string, string[]>; forced: Record<string, string[]>; profile: Record<string, ActivityProfile>; scope: Scope }
function loadBuilder(): BuilderSaved {
  return { prio: {}, forced: {}, profile: {}, scope: "potential", ...load<Partial<BuilderSaved>>(BUILDER_KEY, {}) };
}

export function useOfficerBuilder(officers: Officer[], ships: BuilderShip[], currentShipGuid: string | null): OfficerBuilder {
  const catalog = useMemo(() => buildCatalog(officers), [officers]);
  // Always optimize the current (docked) ship — there's no manual ship picker. Fall back to the first
  // ship with officer slots when the current ship is unknown (e.g. undocked before ever docking).
  const ship = ships.find((s) => s.guid === currentShipGuid) ?? ships[0];

  const [saved] = useState(loadBuilder);
  const [scope, setScope] = useState<Scope>(saved.scope);
  const [prioByShip, setPrioByShip] = useState<Record<string, string[]>>(saved.prio);
  const [forcedByShip, setForcedByShip] = useState<Record<string, string[]>>(saved.forced);
  const [profileByShip, setProfileByShip] = useState<Record<string, ActivityProfile>>(saved.profile);

  // Persist choices whenever they change.
  useEffect(() => {
    save(BUILDER_KEY, { prio: prioByShip, forced: forcedByShip, profile: profileByShip, scope });
  }, [prioByShip, forcedByShip, profileByShip, scope]);

  // A ship with no stored priority list yet falls back to the role default (until the user edits it).
  const prio = ship ? prioByShip[ship.guid] ?? defaultPriorities(catalog, ship.role) : [];
  const setPrio = (next: string[]) => ship && setPrioByShip((m) => ({ ...m, [ship.guid]: next }));

  // Activity profile is per-ship: until the user edits it, default from the ship's role + defensive
  // module slot (combat ship with an armor slot → armor layer). Edits persist per ship.
  const profile = ship ? profileByShip[ship.guid] ?? defaultProfileForShip(ship.role, ship.defenseLayer) : DEFAULT_PROFILE;
  const setProfile = (next: ActivityProfile) => ship && setProfileByShip((m) => ({ ...m, [ship.guid]: next }));

  const forced = useMemo(() => new Set(ship ? forcedByShip[ship.guid] ?? [] : []), [forcedByShip, ship]);
  const togglePin = (guid: string) =>
    ship && setForcedByShip((m) => {
      const cur = new Set(m[ship.guid] ?? []);
      if (cur.has(guid)) cur.delete(guid); else cur.add(guid);
      return { ...m, [ship.guid]: [...cur] };
    });
  const setForced = (guids: string[]) => ship && setForcedByShip((m) => ({ ...m, [ship.guid]: [...guids] }));

  // The WHOLE roster, deliberately: an officer serves several ships AT ONCE — 62 filled slots across 19
  // ships can come from 23 officers — so crewing this ship takes nobody off another. This reads like a
  // double-assignment bug and is not one; excluding officers seen on other ships would wrongly shrink the
  // pool to almost nothing. `assigned` is passed only as the incumbency tie-break for THIS ship.
  const result = useMemo(
    () => ship
      ? optimize({ officers, slots: ship.slots, role: ship.role, hasDroneBay: ship.hasDroneBay, priorities: prio, scope, forced, assigned: new Set((ship.assigned ?? []).filter((g): g is string => !!g)) })
      : null,
    [officers, ship, prio, scope, forced],
  );

  return { officers, ships, ship, scope, setScope, catalog, prio, setPrio, forced, togglePin, setForced, result, profile, setProfile };
}

export default function OfficersTab({
  builder, portraitUrl, recruits, portraitByIcon, goSummary, conn, docked, credits, onHired, apply,
}: {
  builder: OfficerBuilder;
  portraitUrl: (guid: string | null) => string | null;
  recruits: Recruits | null;
  conn?: Conn;
  docked?: boolean;
  credits?: number | null;
  onHired?: () => void;
  portraitByIcon: (icon: string | null) => string | null;
  goSummary: () => void;
  apply?: ApplyApi;
}) {
  const { officers, ships, ship, scope, setScope, catalog, prio, setPrio, forced, togglePin, result, profile, setProfile } = builder;

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

  // A `name:`-keyed priority (a skill no officer has yet, or an import that didn't resolve) carries its
  // label in the key itself — otherwise the row would read "name:iron rage".
  const nameOf = (id: string) =>
    catalog.find((c) => c.id === id)?.name ?? (isNamePrio(id) ? namePrioLabel(id) : id);
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
  const [skillQ, setSkillQ] = useState(""); // full-text search over the permanent skill browser
  const [skillCats, setSkillCats] = useState<Set<string>>(new Set()); // active category (role) filters
  const [rosterQ, setRosterQ] = useState("");
  const activitySummary = [
    profile.main[0].toUpperCase() + profile.main.slice(1),
    ...(profile.main === "combat" ? [profile.combatStance, profile.combatLayer] : []),
    ...(profile.echo ? ["ECHO"] : []), ...(profile.drone ? ["drone"] : []), ...(profile.boarding ? ["boarding"] : []),
  ].join(" · ");

  // Every hook must be declared above the early returns further down: hook identity is call order, so a
  // conditional return before one changes that order between renders.
  //
  // `showAllSkills` switches the browser between the roster's learnable skills and every skill in the game.
  // Skills nobody owns have no id in this save and are keyed by name instead (see namePrio).
  const [showAllSkills, setShowAllSkills] = useState(false);
  const [prioMsg, setPrioMsg] = useState<string | null>(null);
  const [hiring, setHiring] = useState<string | null>(null);
  const [hireMsg, setHireMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const { ask, ui: confirmUi } = useConfirm();
  const fullCatalog = useMemo(() => buildFullCatalog(catalog), [catalog]);
  // Metadata for ANY priority entry, including a `name:` one whose skill nobody owns — the owned catalog
  // alone would leave those rows with no effect text and the wrong weight.
  const metaOf = useCallback((id: string) => fullCatalog.find((c) => c.id === id), [fullCatalog]);

  if (!ships.length) return <p className="hint">No ships with officer slots.</p>;
  if (!officers.length) return <p className="hint">No officers in your roster yet.</p>;
  if (!ship) return <p className="hint">No ship selected.</p>;

  const maxRank = Math.max(1, ...(result?.ranks.map((r) => r.rank) ?? [1]));
  // Permanent skill browser: category (role) filter chips + full-text search over name / effect / role.
  const SKILL_CATS = ["Combat", "Mining", "Salvaging", "Engineering", "Industrial", "Unique"];
  const browseList: BrowsableSkill[] = showAllSkills ? fullCatalog : catalog.map((c) => ({ ...c, owned: true }));

  const catsAvail = SKILL_CATS.filter((c) => browseList.some((s) => s.roles.includes(c)));
  const skillListShown = browseList.filter((c) => {
    if (skillCats.size && !c.roles.some((r) => skillCats.has(r))) return false;
    const q = skillQ.trim().toLowerCase();
    if (!q) return true;
    return c.name.toLowerCase().includes(q) || (c.effect ?? "").toLowerCase().includes(q) || c.roles.some((r) => r.toLowerCase().includes(q));
  });
  const unownedCount = fullCatalog.filter((c) => !c.owned).length;

  // ---- priority list export / import ----
  // Portable across ships, playthroughs and players. Import matches on skill NAME first (ids don't survive
  // a save change) and keeps unmatched names as name-only priorities rather than silently dropping them.
  const prioFileName = `priorities-${(ship?.role ?? "crew").toLowerCase()}.json`;
  const prioJson = () => JSON.stringify(
    exportPriorities(prio, nameOf, { ship: ship?.name ?? null, role: ship?.role ?? null, scope }), null, 2);

  const exportPrioFile = () => {
    const url = URL.createObjectURL(new Blob([prioJson()], { type: "application/json" }));
    const a = document.createElement("a");
    a.href = url; a.download = prioFileName; a.style.display = "none";
    document.body.appendChild(a); a.click(); a.remove();  // must be in the DOM or some browsers drop it
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    setPrioMsg(`Saved ${prioFileName} (${prio.length} skill${prio.length === 1 ? "" : "s"}).`);
  };
  const copyPrio = () => navigator.clipboard?.writeText(prioJson())
    .then(() => setPrioMsg(`Copied ${prio.length} priorities to the clipboard.`))
    .catch(() => setPrioMsg("Copy failed — no clipboard access."));

  const applyImport = (text: string) => {
    try {
      const r = importPriorities(JSON.parse(text), catalog);
      if (!r.prio.length) { setPrioMsg("Nothing usable in that file."); return; }
      snapshot();                           // same undo affordance as Suggest
      setPrio(r.prio);
      if (r.scope) setScope(r.scope);
      const bits = [`${r.matched} matched`];
      if (r.byName) bits.push(`${r.byName} kept by name (no officer has it yet)`);
      if (r.skipped.length) bits.push(`${r.skipped.length} unusable`);
      setPrioMsg(`Imported ${r.prio.length} priorities — ${bits.join(", ")}.`);
    } catch (e) {
      setPrioMsg(`Could not read that: ${e instanceof Error ? e.message : String(e)}`);
    }
  };
  const importPrioFile = (f: File) => f.text().then(applyImport).catch(() => setPrioMsg("Could not read file."));
  const pastePrio = () => navigator.clipboard?.readText().then(applyImport)
    .catch(() => setPrioMsg("Paste failed — grant clipboard access."));
  const toggleCat = (c: string) => setSkillCats((s) => { const n = new Set(s); n.has(c) ? n.delete(c) : n.add(c); return n; });

  // Same courtesy block as buying: refuse in words, not with a dead button.
  const hireBlockedBecause = (cost: number): string | null => {
    if (!docked) return undockedMsg;
    if (credits == null || cost <= credits) return null;
    return brokeMsg(cost, credits);
  };

  const hire = async (guid: string, name: string, cost: number, skipConfirm = false) => {
    if (!conn) return;
    // Latch claimed around the confirmation: an awaited dialog does not block the event loop, so a second
    // click would otherwise open a second question and hire twice.
    setHiring(guid); setHireMsg(null);
    try {
      if (!skipConfirm && !(await ask({
        title: `Hire ${name} for ${cost.toLocaleString()} cr?`,
        detail: affordLine({ name, cost }, credits ?? null),
        confirmLabel: "Hire",
      }))) return;
      const r = await api.hireOfficer(conn, guid);
      if (r.hired === false) setHireMsg({ ok: false, text: `${name}: the game accepted the call but the roster didn't change (${r.method ?? "no method"}).` });
      else setHireMsg({ ok: true, text: `Hired ${r.officer ?? name} for ${r.cost.toLocaleString()} cr.` });
      onHired?.();
    } catch (e) {
      setHireMsg({ ok: false, text: e instanceof ApiError ? e.message : String(e) });
    } finally { setHiring(null); }
  };

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
      {confirmUi}
      {/* ship context bar — always the current ship */}
      <div className="ctx-bar">
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
        {apply && <ApplyBar apply={apply} section="officers" label="officer" />}
        <button className="apply sm" style={{ marginLeft: 8 }} onClick={goSummary} title="Review & apply changes in the Summary tab">Go to Summary →</button>
      </div>
      {apply && <ApplyMsg apply={apply} />}

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
                      <span className="prio-name" style={{ color: skillColor(id), fontWeight: metaOf(id)?.major ? 600 : 500 }} {...skillHoverProps(id)}>{nameOf(id)}</span>
                      {isNamePrio(id) && <span className="prio-wanted" title="No officer of yours has this yet — recruits who do will rank higher">wanted</span>}
                      <span className="spacer" />
                      {(() => { const rk = result?.ranks.find((r) => r.id === id)?.rank ?? 0; return <span className={`prio-rank${rk > 0 ? " on" : ""}`} title={`${rk} assigned officer${rk === 1 ? "" : "s"} carry this skill — ranks stack`}>×{rk}</span>; })()}
                    </div>
                    <div className="prio-eff">{metaOf(id)?.effect ?? ""}</div>
                  </div>
                  <div className="prio-btns">
                    <button disabled={i === 0} onClick={() => move(i, -1)} title="up">▲</button>
                    <button disabled={i === prio.length - 1} onClick={() => move(i, 1)} title="down">▼</button>
                    <button className="rm" onClick={() => setPrio(prio.filter((x) => x !== id))} title="remove">×</button>
                  </div>
                </div>
              );
            })}
            {!prio.length && <p className="hint">Add a priority skill below.</p>}
          </div>

          {/* Take a priority list somewhere else — another ship, another playthrough, another player. */}
          <div className="prio-io">
            <span className="dim">Priority list</span>
            <button onClick={exportPrioFile} disabled={!prio.length} title="Save the ordered priority list as JSON">Export</button>
            <button onClick={copyPrio} disabled={!prio.length} title="Copy the list as JSON">Copy</button>
            <label className={`import-cfg${!ship ? " off" : ""}`} title="Load a priority list from a file">
              Import
              <input type="file" accept="application/json" style={{ display: "none" }} disabled={!ship}
                onChange={(e) => { const f = e.target.files?.[0]; if (f) void importPrioFile(f); e.target.value = ""; }} />
            </label>
            <button onClick={pastePrio} disabled={!ship} title="Import from the clipboard">Paste</button>
            {prioMsg && <span className="dim prio-io-msg">{prioMsg}</span>}
          </div>

          <div className="skill-browser">
            <div className="skill-browser-head">
              <b>Add priority skills</b>
              {/* Owned-only by default: those are the skills that can affect today's crew. "All" is for
                  planning ahead — prioritise something nobody has and recruits carrying it rank higher. */}
              <div className="seg skill-scope">
                <button className={showAllSkills ? "" : "on"} onClick={() => setShowAllSkills(false)}
                  title="Only skills your officers can learn">My officers <span className="dim">{catalog.length}</span></button>
                <button className={showAllSkills ? "on" : ""} onClick={() => setShowAllSkills(true)}
                  title={`Every skill in the game — ${unownedCount} that no officer of yours has yet`}>All <span className="dim">{fullCatalog.length}</span></button>
              </div>
            </div>
            {/* Its own row: sharing the header line with the title and the two scope buttons squeezed it to a few
                characters. The clear button sits inside the field, so it costs no extra width. */}
            <div className="skill-search-row">
              <input className="skill-search" value={skillQ} onChange={(e) => setSkillQ(e.target.value)} placeholder="search name / effect…" />
              {skillQ && <button className="skill-search-x" title="clear" onClick={() => setSkillQ("")}>×</button>}
            </div>
            <div className="skill-cats">
              {/* No filter selected already means "all", so All simply clears — but say it plainly rather
                  than making that inference the user's problem. */}
              <button className="cat-chip all" disabled={!skillCats.size} onClick={() => setSkillCats(new Set())} title="No role filter — show every skill">All</button>
              <button className="cat-chip all" onClick={() => setSkillCats(new Set(catsAvail))} title="Select every role">None</button>
              {catsAvail.map((c) => (
                <button key={c} className={`cat-chip${skillCats.has(c) ? " on" : ""}`} onClick={() => toggleCat(c)}>{c}</button>
              ))}
            </div>
            <div className="skill-browser-list">
              {skillListShown.map((c) => {
                const added = prio.includes(c.id);
                return (
                  <div key={c.id} className={`add-prio-item${added ? " added" : ""}${c.owned ? "" : " unowned"}`} {...skillHoverProps(c.id)} onClick={() => { if (!added) addPrio(c.id); }}>
                    <span className={`prio-rank${rosterCount(c.id) > 0 ? " on" : ""}`}
                      title={c.owned
                        ? `${rosterCount(c.id)} officer${rosterCount(c.id) === 1 ? "" : "s"} in your roster have this skill`
                        : "No officer of yours has this — prioritise it and recruits who do will rank higher"}>×{rosterCount(c.id)}</span>
                    <span className="ap-name" style={{ color: skillColor(c.id), fontWeight: c.major ? 600 : 500 }}>{c.name}</span>
                    <span className="ap-eff">{c.effect}</span>
                    <span className="ap-add">{added ? "✓ added" : "+ add"}</span>
                  </div>
                );
              })}
              {!skillListShown.length && <div className="add-prio-item dim">no skills match</div>}
            </div>
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
              {/* Money after the chips, as in the hire list below: the chips are what you scan, the figure is
                  what you check afterwards. */}
              <span className="roster-idle" title={on ? "Assigned — inactive (earns no idle income)" : "Benched — earning idle income"} style={{ color: on ? "#6a6a72" : "#c7ccd4" }}>¢ {o.idle.toLocaleString()}/hr</span>
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
          <Notice msg={hireMsg} onClose={() => setHireMsg(null)} />
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
                {/* One-line identity, exactly as a crew row states it, so the two lists read alike and stand the
                    same height. */}
                <span className="roster-name" style={{ color: rc }}>{o.name}</span>
                <span className="roster-prof dim">{o.profession} · Lv{o.level}</span>
                <span className="roster-max">{o.level >= MAX_LEVEL && <span className="max">MAX</span>}</span>
                <div className="roster-skills">
                  {priSk.map((s) => chipEl(s.id, true))}
                  {otherSk.map((s) => chipEl(s.id, false, true))}
                </div>
                {o.isOpp && <span className="recruit-opp">↑ replaces {o.replaces}</span>}
                <span className="recruit-cost">¢ {o.hireCost.toLocaleString()}</span>
                {conn && (() => {
                    const why = hireBlockedBecause(o.hireCost);
                    return (
                      <button
                        className={`recruit-hire${why ? " blocked" : ""}`}
                        disabled={hiring === o.guid}
                        title={why ?? `Hire ${o.name}: ${affordLine({ name: o.name, cost: o.hireCost }, credits ?? null)} — ctrl+click skips the confirmation`}
                        onClick={(e) => {
                          if (why) { setHireMsg({ ok: false, text: why }); return; }
                          void hire(o.guid, o.name, o.hireCost, e.ctrlKey || e.metaKey);
                        }}
                      >{hiring === o.guid ? "…" : "hire"}</button>
                    );
                  })()}
              </div>
            );
          })}
          {!stationView.length && <p className="hint">No recruits here.</p>}
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
