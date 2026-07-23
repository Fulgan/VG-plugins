// Officer optimizer — pure logic (no React). Ports the "why top-N is exact" algorithm from the spec
// (§V30) and doc/officer-skills.md: the objective is separable (rank(Sᵢ) = # chosen officers with Sᵢ),
// so the optimum is the top-N officers under a lexicographic priority-coverage comparator.
import { OFFICER_SKILLS, type SkillMeta } from "./officerSkills";
import type { Officer, OfficerSkill } from "./types";

export type Scope = "current" | "potential";

// Rarity ordering for the tiebreak + the real idle-income multiplier (game: HourlyIdleIncome =
// level × 40 × mult). Mirrors OfficerData in Assembly-CSharp.
const RARITY_RANK: Record<string, number> = { Standard: 0, Enhanced: 1, HighGrade: 2, Exotic: 3, Legendary: 4 };
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

export interface ScoredOfficer extends Officer {
  scopeSkills: OfficerSkill[]; // in-scope skills (drone-filtered) at the chosen scope
  cov: boolean[]; // per-priority coverage (aligned to the priority list)
  covCount: number;
  roleRel: number; // # in-scope skills relevant to the ship role
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

// Score one officer against the ship + priorities: coverage vector, role relevance, idle income.
export function scoreOfficer(o: Officer, ctx: Pick<OptimizeInput, "role" | "hasDroneBay" | "priorities" | "scope">): ScoredOfficer {
  const scopeSkills = inScope(o, ctx.scope, ctx.hasDroneBay);
  const ids = new Set(scopeSkills.map((s) => s.id));
  const cov = ctx.priorities.map((id) => ids.has(id));
  const roleRel = ctx.role ? scopeSkills.filter((s) => skillMeta(s.name).roles.includes(ctx.role!)).length : 0;
  return { ...o, scopeSkills, cov, covCount: cov.filter(Boolean).length, roleRel, idle: idleIncomeOf(o) };
}

// Lexicographic comparator: cover the highest-priority skill the other misses → rank higher; ties →
// ship-role relevance, then rarity, then level. Negative ⇒ `a` ranks above `b`.
export function comparator(priorityCount: number) {
  return (a: ScoredOfficer, b: ScoredOfficer): number => {
    for (let i = 0; i < priorityCount; i++) if (a.cov[i] !== b.cov[i]) return a.cov[i] ? -1 : 1;
    if (a.roleRel !== b.roleRel) return b.roleRel - a.roleRel;
    const ra = RARITY_RANK[a.rarity] ?? 0, rb = RARITY_RANK[b.rarity] ?? 0;
    if (ra !== rb) return rb - ra;
    return b.level - a.level;
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

// Resolve a priority skill id back to its display name (from any officer that has it).
function catalogName(officers: Officer[], id: string): string {
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
