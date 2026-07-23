// Booster optimizer — pure logic (no React). A booster's "type" is the stat it boosts (its mainStat
// name, e.g. "Combat Power", "Officer Bonus", "Mining Power"); its value is that stat's amount. You
// pick a type per ship booster slot, and the optimizer fills each slot with the highest-value unused
// booster of that type from the pool (equipped + armory + cargo). Each physical booster used once.
import type { Item } from "./types";

// The booster's type = its main stat name. Falls back to the readable equipment type, else "Other".
export function boosterType(it: Item): string {
  return it.mainStat?.name || it.type || "Other";
}

// Numeric value of a booster = its main-stat amount. Parses "1,257", "540.9", "6.25%", "1.2M".
export function boosterValue(it: Item): number {
  const raw = it.mainStat?.amount;
  if (!raw) return 0;
  const m = raw.replace(/,/g, "").match(/([+-]?\d+(?:\.\d+)?)\s*([KMBT%]?)/i);
  if (!m) return 0;
  const mult: Record<string, number> = { "": 1, K: 1e3, M: 1e6, B: 1e9, T: 1e12, "%": 1 };
  return parseFloat(m[1]) * (mult[m[2].toUpperCase()] ?? 1);
}

// Per-type accent colour for the icon tile (matches the in-game item tint), keyed by main-stat name.
const TYPE_COLOR: Record<string, string> = {
  "Combat Power": "#ff6a4d", "Reload Speed": "#ffb020", "Mining Power": "#38c6e0",
  "Salvage Power": "#4ad06a", "Shield HP": "#4aa3ff", "Armor HP": "#e0863a",
  "Officer Bonus": "#c07bff", "Cargo Capacity": "#9aa4b2",
};
export const boosterTypeColor = (it: Item): string => TYPE_COLOR[boosterType(it)] ?? "#7d7d86";

// Readable resonance unlock-bonus, e.g. "+2.22% Reload Speed" — game-formatted from the bridge.
export function unlockBonusText(r: import("./types").Resonance): string {
  return r.bonus || r.bonusStat || "";
}
export const resonancePct = (r: import("./types").Resonance): number =>
  r.unlocked ? 100 : r.threshold > 0 ? Math.min(100, Math.round((r.progress / r.threshold) * 100)) : 0;

// Is this item a booster? (category Booster, or a type/name ending in "booster")
export function isBooster(it: Item): boolean {
  const c = (it.category ?? "").toLowerCase();
  const t = (it.type ?? "").toLowerCase();
  return c.includes("booster") || t.includes("booster");
}

// Distinct booster types present in a pool, most valuable first (for the per-slot type picker).
export function boosterTypes(pool: Item[]): string[] {
  const best = new Map<string, number>();
  for (const b of pool) {
    const t = boosterType(b);
    best.set(t, Math.max(best.get(t) ?? 0, boosterValue(b)));
  }
  return [...best.entries()].sort((a, b) => b[1] - a[1]).map(([t]) => t);
}

// Default per-slot type: keep what's equipped; empty slots default to the ship role's booster type
// (matched loosely against the available types), else the pool's most common type.
export function defaultSlotTypes(equipped: (Item | null)[], slotCount: number, role: string | null, pool: Item[]): (string | null)[] {
  const types = boosterTypes(pool);
  const roleType = role ? types.find((t) => t.toLowerCase().includes(role.toLowerCase())) ?? null : null;
  const fallback = roleType ?? types[0] ?? null;
  return Array.from({ length: slotCount }, (_, i) => {
    const cur = equipped[i];
    return cur ? boosterType(cur) : fallback;
  });
}

// Stable per-booster id for a session (location + inventory slot / equipped index / name).
export const boosterId = (b: Item): string => `${b.location ?? "ship"}:${b.key ?? b.slot ?? ""}:${b.name}:${b.level}`;

export interface BoosterPick {
  slot: number;
  type: string | null;
  chosen: Item | null; // best available booster of that type (null = none in pool)
  value: number;
  forced: boolean; // filled by a user-forced booster
}

export interface BoosterResult {
  picks: BoosterPick[];
  unplaceableForced: Item[]; // forced boosters whose type has no matching slot
}

// Fill each slot with the highest-value unused booster of its type. Forced boosters (by id) take a
// slot of their type first; a forced booster with no matching slot is returned as unplaceable.
export function optimizeBoosters(pool: Item[], slotTypes: (string | null)[], forced?: Set<string>): BoosterResult {
  const used = new Set<Item>();
  const picks: BoosterPick[] = slotTypes.map((type, slot) => ({ slot, type, chosen: null, value: 0, forced: false }));
  const forcedSet = forced ?? new Set<string>();
  const forcedBoosters = pool.filter((b) => forcedSet.has(boosterId(b)));

  // Pass 1: place forced boosters into a slot matching their type (highest value first).
  const unplaceableForced: Item[] = [];
  for (const b of [...forcedBoosters].sort((a, z) => boosterValue(z) - boosterValue(a))) {
    const t = boosterType(b);
    const slot = picks.find((p) => p.type === t && !p.chosen);
    if (slot) { slot.chosen = b; slot.value = boosterValue(b); slot.forced = true; used.add(b); }
    else unplaceableForced.push(b);
  }

  // Pass 2: fill remaining slots per type, KEEPING equipped boosters in their own slot. Only new
  // (armory/cargo) boosters move into slots — displacing the weakest equipped one of that type. This
  // keeps the result stable: re-optimizing after an apply proposes no further churn (the armory pick
  // is now equipped-in-place), so a single Apply sticks instead of cascading over several clicks.
  const openPicks = picks.filter((p) => !p.chosen && p.type);
  for (const t of new Set(openPicks.map((p) => p.type))) {
    const slotsOfType = openPicks.filter((p) => p.type === t);
    const winners = pool
      .filter((b) => !used.has(b) && boosterType(b) === t)
      .sort((a, z) => boosterValue(z) - boosterValue(a))
      .slice(0, slotsOfType.length);
    const bySlot = new Map(slotsOfType.map((p) => [p.slot, p]));
    const free = new Set(slotsOfType);
    const movers: Item[] = [];
    // Pin each winning booster that's already equipped to the very slot it sits in.
    for (const w of winners) {
      const p = w.location === "equipped" ? bySlot.get(w.slot as number) : undefined;
      if (p && free.has(p)) { p.chosen = w; p.value = boosterValue(w); used.add(w); free.delete(p); }
      else movers.push(w);
    }
    // Remaining winners (armory/cargo, or equipped in a now-retyped slot) fill the freed slots.
    const freeSlots = [...free];
    movers.forEach((w, i) => { const p = freeSlots[i]; if (p) { p.chosen = w; p.value = boosterValue(w); used.add(w); } });
  }
  return { picks, unplaceableForced };
}
