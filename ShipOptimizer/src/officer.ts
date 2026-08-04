// Officer optimizer — pure logic (no React). Ports the "why top-N is exact" algorithm from the spec
//: the objective is separable (rank(Sᵢ) = # chosen officers with Sᵢ),
// so the optimum is the top-N officers under a lexicographic priority-coverage comparator.
import { OFFICER_SKILLS, type SkillMeta } from "./officerSkills";
import { RARITY_RANK } from "./format";
import type { Officer, OfficerSkill } from "./types";

export type Scope = "current" | "potential";

// Idle-income multiplier by rarity (game: HourlyIdleIncome = level × 40 × mult). Mirrors OfficerData
// in Assembly-CSharp. (Rarity ordering for the comparator tiebreak lives in ./format as RARITY_RANK.)
const IDLE_MULT: Record<string, number> = { Standard: 1, Enhanced: 2, HighGrade: 5, Exotic: 10, Legendary: 20 };
export const MAX_LEVEL = 60;

export const skillMeta = (name: string): SkillMeta => OFFICER_SKILLS[name] ?? { roles: [] };
export const idleIncomeOf = (o: Officer): number => Math.round(o.level * 40 * (IDLE_MULT[o.rarity] ?? 1));

// A prioritizable skill: identity from the officers' own nodes, enriched with the editable role table.
export interface CatalogSkill {
  id: string;
  name: string;
  major: boolean;
  roles: string[];
  drone: boolean;
  effect?: string;
}

// Distinct skills across every officer's full potential (the things you can prioritize), deduped by id.
export function buildCatalog(officers: Officer[]): CatalogSkill[] {
  const byId = new Map<string, CatalogSkill>();
  for (const o of officers)
    for (const sk of o.potential) {
      if (byId.has(sk.id)) continue;
      const m = skillMeta(sk.name);
      byId.set(sk.id, { id: sk.id, name: sk.name, major: sk.major, roles: m.roles ?? [], drone: !!m.drone, effect: m.effect });
    }
  return [...byId.values()].sort((a, b) => a.name.localeCompare(b.name));
}

// Every skill the game HAS, not just the ones your officers happen to carry — from the curated
// name-keyed table. Skills your roster lacks get a `name:` id (see namePrio) since no real id exists for
// them in this save; they are marked `owned: false` so the browser can show them as aspirational, which is
// the point: prioritise a skill you don't have and recruits offering it start ranking higher.
export interface BrowsableSkill extends CatalogSkill { owned: boolean }

export function buildFullCatalog(owned: CatalogSkill[]): BrowsableSkill[] {
  const byName = new Map(owned.map((c) => [c.name.toLowerCase(), c]));
  const out: BrowsableSkill[] = owned.map((c) => ({ ...c, owned: true }));
  for (const [name, m] of Object.entries(OFFICER_SKILLS)) {
    if (byName.has(name.toLowerCase())) continue;
    out.push({
      id: namePrio(name), name, major: !!m.major,
      roles: m.roles ?? [], drone: !!m.drone, effect: m.effect, owned: false,
    });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

export interface ScoredOfficer extends Officer {
  scopeSkills: OfficerSkill[]; // in-scope skills (drone-filtered) at the chosen scope
  cov: boolean[]; // per-priority coverage (aligned to the priority list)
  covCount: number;
  roleRel: number; // # in-scope skills relevant to the ship role
  assigned: boolean; // currently assigned to this ship (incumbent)
  idle: number;
}

export interface OptimizeInput {
  officers: Officer[];
  slots: number;
  role: string | null;
  hasDroneBay: boolean;
  priorities: string[]; // skill ids, highest priority first
  scope: Scope;
  forced: Set<string>; // officer guids pinned into a slot
  assigned?: Set<string>; // officer guids currently assigned to this ship (incumbents — kept on ties)
}

export interface RankLine {
  id: string;
  name: string;
  rank: number;
}

export interface OptimizeResult {
  chosen: ScoredOfficer[]; // assigned crew, comparator order
  sorted: ScoredOfficer[]; // full roster, comparator order
  ranks: RankLine[]; // resulting stacked rank per priority skill
  idleTotal: number; // idle income from benched (unassigned) officers
  benchedCount: number;
}

// In-scope skills: current vs potential, minus drone skills when the ship has no drone bay.
function inScope(o: Officer, scope: Scope, hasDroneBay: boolean): OfficerSkill[] {
  const src = scope === "potential" ? o.potential : o.current;
  return src.filter((s) => hasDroneBay || !skillMeta(s.name).drone);
}

// A priority entry that carries no skill id, only a name. Two things need this: prioritising a skill
// NOBODY on the roster has yet (the whole point — a recruit offering it should then rank higher, but there
// is no id to key on until someone has it), and importing a priority list from another playthrough or a
// hand-edited file, where ids may not resolve.
export const NAME_PRIO_PREFIX = "name:";
export const namePrio = (name: string) => NAME_PRIO_PREFIX + name.toLowerCase();
export const isNamePrio = (p: string) => p.startsWith(NAME_PRIO_PREFIX);

// Two accessors, not interchangeable: `namePrioKey` is the lowercased key and the only thing to compare
// against; `namePrioLabel` is the properly-cased name, for display only.
const PROPER_NAME = new Map(Object.keys(OFFICER_SKILLS).map((n) => [n.toLowerCase(), n]));
export const namePrioKey = (p: string) => p.slice(NAME_PRIO_PREFIX.length);
export const namePrioLabel = (p: string) => {
  const lower = namePrioKey(p);
  return PROPER_NAME.get(lower) ?? lower;
};

// Score one officer against the ship + priorities: coverage vector, role relevance, idle income.
export function scoreOfficer(o: Officer, ctx: Pick<OptimizeInput, "role" | "hasDroneBay" | "priorities" | "scope" | "assigned">): ScoredOfficer {
  const scopeSkills = inScope(o, ctx.scope, ctx.hasDroneBay);
  const ids = new Set(scopeSkills.map((s) => s.id));
  // Names too, so a `name:`-keyed priority still matches the officers who do have the skill.
  const names = new Set(scopeSkills.map((s) => s.name.toLowerCase()));
  const cov = ctx.priorities.map((p) => (isNamePrio(p) ? names.has(namePrioKey(p)) : ids.has(p)));
  const roleRel = ctx.role ? scopeSkills.filter((s) => skillMeta(s.name).roles.includes(ctx.role!)).length : 0;
  const assigned = ctx.assigned?.has(o.guid) ?? false;
  return { ...o, scopeSkills, cov, covCount: cov.filter(Boolean).length, roleRel, assigned, idle: idleIncomeOf(o) };
}

// Lexicographic comparator: cover the highest-priority skill the other misses → rank higher; then
// INCUMBENCY (a currently-assigned officer outranks a benched one that only ties on coverage) → ship-
// role relevance → rarity → level → guid. Negative ⇒ `a` ranks above `b`.
// Incumbency comes right after coverage so the optimizer never proposes a swap that doesn't change
// priority coverage — an assigned officer is displaced only by someone covering a higher priority they
// miss, not for a cosmetic rarity/level tiebreak (that churn read as "changes I didn't ask for").
// The final guid tiebreak keeps the order deterministic: without it two fully-tied officers fall back
// to input-array order, which the game reloads differently each restart.
export function comparator(priorityCount: number) {
  return (a: ScoredOfficer, b: ScoredOfficer): number => {
    for (let i = 0; i < priorityCount; i++) if (a.cov[i] !== b.cov[i]) return a.cov[i] ? -1 : 1;
    if (a.assigned !== b.assigned) return a.assigned ? -1 : 1;
    if (a.roleRel !== b.roleRel) return b.roleRel - a.roleRel;
    const ra = RARITY_RANK[a.rarity] ?? 0, rb = RARITY_RANK[b.rarity] ?? 0;
    if (ra !== rb) return rb - ra;
    if (a.level !== b.level) return b.level - a.level;
    return (a.guid ?? "").localeCompare(b.guid ?? "");
  };
}

export function optimize(input: OptimizeInput): OptimizeResult {
  const { officers, slots, priorities, forced } = input;

  const scored = officers.map((o) => scoreOfficer(o, input));
  const cmp = comparator(priorities.length);
  const sorted = [...scored].sort(cmp);

  // Forced officers take slots first (still in comparator order); the optimizer fills what remains.
  const chosen = [...sorted.filter((o) => forced.has(o.guid)), ...sorted.filter((o) => !forced.has(o.guid))].slice(0, Math.max(0, slots));
  const chosenGuids = new Set(chosen.map((o) => o.guid));

  const ranks: RankLine[] = priorities.map((id, i) => {
    const name = catalogName(officers, id);
    return { id, name, rank: chosen.filter((o) => o.cov[i]).length };
  });

  const benched = scored.filter((o) => !chosenGuids.has(o.guid));
  const idleTotal = benched.reduce((sum, o) => sum + o.idle, 0);

  return { chosen, sorted, ranks, idleTotal, benchedCount: benched.length };
}

// ---- priority list export / import --------------------------------------------------------------
// A priority list is portable: the same "what I care about" applies to another ship, another playthrough,
// or a friend's game. Skill IDs are the internal key but are NOT trustworthy across saves, so every entry
// carries its display NAME too and import prefers the name — that also makes the file hand-editable.

export const PRIO_FILE_KIND = "shipoptimizer.priorities";

export interface PriorityFile {
  kind: typeof PRIO_FILE_KIND;
  v: 1;
  ship?: string | null;      // context only, never used on import
  role?: string | null;
  scope?: Scope;
  skills: { id?: string; name: string }[];   // ORDER IS THE PRIORITY
}

// Build the portable form. `nameOf` resolves an id to its display name (catalog or roster).
export function exportPriorities(
  prio: string[],
  nameOf: (id: string) => string,
  ctx?: { ship?: string | null; role?: string | null; scope?: Scope },
): PriorityFile {
  return {
    kind: PRIO_FILE_KIND,
    v: 1,
    ship: ctx?.ship ?? null,
    role: ctx?.role ?? null,
    scope: ctx?.scope,
    skills: prio.map((p) => (isNamePrio(p)
      ? { name: namePrioLabel(p) }                 // no id to give — it was never resolved
      : { id: p, name: nameOf(p) })),
  };
}

export interface PriorityImport {
  prio: string[];
  matched: number;     // resolved to a real catalog id
  byName: number;      // kept as a name-only priority (no id in this save)
  skipped: string[];   // entries with nothing usable
  scope?: Scope;
}

// Parse anything reasonable into a priority list: the exported object, a bare array of entries, or a bare
// array of names/ids (so a hand-written list of names works). Unresolvable names are KEPT as name-only
// priorities rather than dropped — a skill your roster lacks today is exactly the kind you want to
// prioritise for recruiting.
export function importPriorities(raw: unknown, catalog: CatalogSkill[]): PriorityImport {
  const byId = new Map(catalog.map((c) => [c.id, c]));
  const byName = new Map(catalog.map((c) => [c.name.toLowerCase(), c]));

  const entries: { id?: string; name?: string }[] = [];
  const push = (v: unknown) => {
    if (typeof v === "string") entries.push({ name: v });
    else if (v && typeof v === "object") {
      const o = v as { id?: unknown; name?: unknown };
      entries.push({
        id: typeof o.id === "string" ? o.id : undefined,
        name: typeof o.name === "string" ? o.name : undefined,
      });
    }
  };

  let scope: Scope | undefined;
  if (Array.isArray(raw)) raw.forEach(push);
  else if (raw && typeof raw === "object") {
    const o = raw as { skills?: unknown; prio?: unknown; scope?: unknown };
    if (o.scope === "current" || o.scope === "potential") scope = o.scope;
    const list = Array.isArray(o.skills) ? o.skills : Array.isArray(o.prio) ? o.prio : null;
    if (!list) throw new Error("no `skills` array in this file");
    list.forEach(push);
  } else throw new Error("expected a priority list or an exported priorities file");

  const prio: string[] = [];
  const seen = new Set<string>();
  const skipped: string[] = [];
  let matched = 0;
  let named = 0;

  for (const e of entries) {
    // Name first: it survives a playthrough change, an id does not.
    const hit = (e.name && byName.get(e.name.toLowerCase())) || (e.id && byId.get(e.id)) || null;
    if (hit) {
      if (!seen.has(hit.id)) { seen.add(hit.id); prio.push(hit.id); matched++; }
      continue;
    }
    if (e.name) {
      const key = namePrio(e.name);
      if (!seen.has(key)) { seen.add(key); prio.push(key); named++; }
      continue;
    }
    if (e.id) skipped.push(e.id);
  }
  return { prio, matched, byName: named, skipped, scope };
}

// Resolve a priority skill id back to its display name (from any officer that has it).
function catalogName(officers: Officer[], id: string): string {
  if (isNamePrio(id)) return namePrioLabel(id);   // no officer has it — the key carries the name
  for (const o of officers) {
    const s = o.potential.find((x) => x.id === id) ?? o.current.find((x) => x.id === id);
    if (s) return s.name;
  }
  return id;
}

export interface RecruitOfficer extends Officer {
  hireCost: number;
}
export interface ScoredRecruit extends ScoredOfficer {
  hireCost: number;
  isOpp: boolean; // would out-rank the weakest currently-assigned officer
  replaces: string | null;
}

// Score station recruits and flag any that would out-rank the weakest assigned officer (same
// lexicographic comparator) → a hire opportunity. Opportunities first, then comparator order.
export function evaluateRecruits(
  recruits: RecruitOfficer[],
  ctx: Pick<OptimizeInput, "role" | "hasDroneBay" | "priorities" | "scope">,
  chosen: ScoredOfficer[],
): ScoredRecruit[] {
  const cmp = comparator(ctx.priorities.length);
  const weakest = chosen.length ? chosen[chosen.length - 1] : null;
  return recruits
    .map((r): ScoredRecruit => {
      const s = scoreOfficer(r, ctx);
      const isOpp = weakest ? cmp(s, weakest) < 0 : s.covCount > 0;
      return { ...s, hireCost: r.hireCost, isOpp, replaces: isOpp && weakest ? weakest.name : null };
    })
    .sort((a, b) => Number(b.isOpp) - Number(a.isOpp) || cmp(a, b));
}

// Derive a priority list from a set of officers (e.g. a ship's currently-assigned crew): rank skills
// by how many of those officers carry them (majors, then name, as tiebreak). Lets the user seed the
// priorities from the current loadout and refine. Respects scope + drone-bay gate.
export function prioritiesFromCrew(crew: Officer[], ctx: { scope: Scope; hasDroneBay: boolean }): string[] {
  const freq = new Map<string, { count: number; name: string; major: boolean }>();
  for (const o of crew)
    for (const s of inScope(o, ctx.scope, ctx.hasDroneBay)) {
      const e = freq.get(s.id) ?? { count: 0, name: s.name, major: s.major };
      e.count++;
      freq.set(s.id, e);
    }
  return [...freq.entries()]
    .sort((a, b) => b[1].count - a[1].count || Number(b[1].major) - Number(a[1].major) || a[1].name.localeCompare(b[1].name))
    .map(([id]) => id);
}

// Default priority list for a ship role: the role's own skills, majors first, by the table order.
export function defaultPriorities(catalog: CatalogSkill[], role: string | null): string[] {
  if (!role) return [];
  const inRole = catalog.filter((c) => c.roles.includes(role));
  const ranked = [...inRole].sort((a, b) => Number(b.major) - Number(a.major) || a.name.localeCompare(b.name));
  return ranked.slice(0, 4).map((c) => c.id);
}
