import type { Item } from "./types";

// A combined stat total: flat `amount`s are summed; percentage `multiplier`s are multiplied.
// (EquipStatLine is either a flat amount with multiplier==1, or a multiplier with amount==0.)
export interface StatTotal {
  amount: number;
  multiplier: number;
}

export type Totals = Record<string, StatTotal>;

// Aggregate the effective stats of a set of items into per-stat totals.
// Values come straight from the bridge's baked GetStats() — no scaling is re-derived here (V2).
export function aggregate(items: Item[]): Totals {
  const totals: Totals = {};
  for (const item of items) {
    for (const line of item.stats ?? []) {
      const t = (totals[line.stat] ??= { amount: 0, multiplier: 1 });
      t.amount += line.amount ?? 0;
      if (line.multiplier && line.multiplier !== 1) t.multiplier *= line.multiplier;
    }
  }
  return totals;
}

// Signed delta of `build` totals vs `base` totals, per stat (union of both key sets).
export function delta(build: Totals, base: Totals): Totals {
  const out: Totals = {};
  for (const stat of new Set([...Object.keys(build), ...Object.keys(base)])) {
    const b = build[stat] ?? { amount: 0, multiplier: 1 };
    const a = base[stat] ?? { amount: 0, multiplier: 1 };
    out[stat] = { amount: b.amount - a.amount, multiplier: b.multiplier - a.multiplier };
  }
  return out;
}

// Format a total for display: flat amount, and multiplier as a percent when it isn't 1.
export function formatTotal(t: StatTotal): string {
  const parts: string[] = [];
  if (t.amount !== 0) parts.push(Number(t.amount.toFixed(2)).toString());
  if (t.multiplier !== 1 && t.multiplier !== 0)
    parts.push(`×${Number(t.multiplier.toFixed(3))}`);
  return parts.length ? parts.join(" ") : "0";
}
