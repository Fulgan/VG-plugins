import type { Item, ShipHardpoint } from "./types";
import { boosterType, boosterValue } from "./booster";
import { shipFit } from "./itemKind";
import { moduleBetter, type ModuleCtx, type ShipPools } from "./fleetDps";
import { effectiveMainVal } from "./format";
import { turretFits, moduleFits, mayKeepEquipped, type GearFilter } from "./gearFit";

// What the opportunity RAILS offer, and how each kind is scored.
//
// Lifted out of App.tsx, which was rendering the rails AND deciding what belongs on them. With no shared owner
// the rail's objective drifts from the gear tab's, and it recommends buying a turret the optimizer then refuses
// to fit. Scoring is a module of its own, so a change to what counts as an upgrade lands in one place.
//
// Each family scores by the SAME rule the tab that would apply it uses:
//   turrets  the gain function the caller passes in — the Gear tab's selected ranking, whole-battery in
//            expanded mode, so recommending and fitting cannot disagree
//   modules  `moduleBetter` — the DPS objective where it has an opinion, `compareModules` for the ties
//   boosters `boosterValue` — no damage model applies

// Config-aware turret opportunities: per hardpoint, rank candidates that fit the slot's CONFIGURED
// filter (Gear tab) and beat the equipped turret. Best instance per item name, biggest gain first.
//
// `score` is the Gear tab's SELECTED ranking, so the rail agrees with the tab it sends you to: under the
// expanded ranking a gun with a big headline stat but a poor firing cycle is not an upgrade, and offering it
// as one contradicts the optimizer one click away.
export function gearTurretOpps(cands: Item[], hps: ShipHardpoint[], filters: Record<number, GearFilter>, cats: Record<string, string[]>, gain: (equipped: Item, candidate: Item) => number): Opp[] {
  const best = new Map<string, Opp>();
  for (const hp of hps) {
    const eq = hp.equipped;
    if (!eq) continue; // empty slots are filled from the Gear tab
    const f = filters[hp.index] ?? { mode: "all" };
    const keepAllowed = mayKeepEquipped(eq, hp.size, f, cats);
    for (const c of cands) {
      if (!turretFits(c, hp.size, f, cats)) continue;
      const delta = gain(eq, c);
      if (!Number.isFinite(delta)) continue;
      // Right type already equipped → upgrades only. Wrong type (filter set, equipped doesn't match) →
      // offer any candidate of the configured type, even at lower power (a deliberate type switch).
      if (keepAllowed && delta <= 0) continue;
      const prev = best.get(c.name);
      if (!prev || delta > prev.delta)
        best.set(c.name, { item: c, replaces: eq, delta, slotLabel: `slot ${hp.index + 1}` });
    }
  }
  return [...best.values()].sort((a, b) => b.delta - a.delta);
}

export interface Opp {
  item: Item;
  replaces: Item; // what it would displace, in the slot named by slotLabel
  delta: number;  // headline change; 0 when the win came from a tie-break
  // Which hardpoint or module slot the gain is FOR. An item is an upgrade in one slot and a downgrade in
  // another (pooled stats and the occupant's own aspects decide it), so a rail entry without its slot reads as
  // a contradiction of the gear tab, which shows whichever slot happens to be selected.
  slotLabel?: string;
}

// Module opportunities, judged by the SAME rule the gear tab uses (`moduleBetter`: the battery objective
// wherever it has an opinion, the comparator for the ties it cannot see). Scoring these on the headline alone —
// which is what the generic path did — offered modules the tab then declined to fit, and offered a scanner that
// cost the battery a crit aspect and 2,605 pooled Combat Power for a bigger Precision number.
export function gearModuleOpps(cands: Item[], mslots: { slot: string; size: string; equipped: Item | null }[],
                        energy: { used: number; capacity: number } | undefined, role: string | null,
                        pools?: ShipPools | null, turrets?: Item[]): Opp[] {
  const best = new Map<string, Opp>();
  const fit = shipFit(role, mslots, turrets ?? []);
  for (const m of mslots) {
    const eq = m.equipped;
    if (!eq) continue;   // an empty slot is filled from the Gear tab
    const en = energy && energy.capacity > 0
      ? { usedWithout: energy.used - (eq.powerUsage ?? 0), capacity: energy.capacity } : undefined;
    const mctx: ModuleCtx = { pools, turrets, energy: en, role, fit };
    for (const c of cands) {
      if (!moduleFits(c, m.slot, m.size)) continue;
      if (!moduleBetter(c, eq, mctx)) continue;
      // The rail's number is the headline change, which can be 0 when the win came from a tie-break — the entry
      // still belongs here, it just sorts below anything with a headline gain.
      const delta = (effectiveMainVal(c) ?? 0) - (effectiveMainVal(eq) ?? 0);
      const prev = best.get(c.name);
      if (!prev || delta > prev.delta) best.set(c.name, { item: c, replaces: eq, delta, slotLabel: m.slot });
    }
  }
  return [...best.values()].sort((a, b) => b.delta - a.delta);
}

// Config-aware booster opportunities: per booster slot, candidates of the slot's CONFIGURED type that
// beat the equipped booster's value.
export function gearBoosterOpps(cands: Item[], slotTypes: (string | null)[], equippedBySlot: (Item | null)[]): Opp[] {
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
