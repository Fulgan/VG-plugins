// Does an item FIT a slot, under that slot's filter? Owned by no tab.
//
// It lived in `GearTab.tsx` while the gear tab was its only caller. It is not any more: the opportunity
// rails score against it, and the sell list decides what to SELL by it — so a tab owning this predicate is
// The same defect as a tab owning a rule other surfaces obey, one file along and with money attached. The
// filter vocabulary is shared on purpose: a reserve rule that spares what no slot filter would accept is a
// reserve of items that never get fitted, and two matchers would drift into exactly that.
import type { Item } from "./types";
import { catOf, isTurret } from "./itemKind";
import { coversLayer, type Layer } from "./fleetDps";

/** A slot's filter: what may be fitted there. `all` = no restriction. */
export type GearFilter = { mode: "all" | "type" | "damage" | "category" | "activity"; value?: string };

const isModuleItem = (it: Item) =>
  !!it.slotType && it.slotType !== "Hardpoint" && it.category !== "Turret" && it.category !== "Booster";

/** Does an item fit a turret slot (size) under its filter? */
export function turretFits(it: Item, size: string, f: GearFilter, cats: Record<string, string[]>): boolean {
  if (!isTurret(it) || it.size !== size) return false;
  if (f.mode === "type") return it.type === f.value;
  if (f.mode === "damage") return catOf(it) === "Combat" && it.damageType === f.value;
  if (f.mode === "category") return (cats[f.value ?? ""] ?? []).includes(it.type ?? ""); // any turret type (combat/mining/salvage)
  // Activity: the game's own gameplayType, optionally narrowed to ONE target layer — a mining or salvage gun
  // reaches only the layer it is built for, and "which layer is this hardpoint for" is the same kind of coarse
  // choice as "which activity", so it rides the same control rather than adding a second one.
  if (f.mode === "activity") {
    const { act, layer } = parseActivity(f.value);
    if (catOf(it) !== act) return false;
    return layer ? coversLayer(it, layer) : true;
  }
  return true;
}

/**
 * `Mining` | `Mining-surface` | `Mining-core` → activity plus the layer it is pinned to, if any.
 *
 * ONE owner: `turretFits` restricts the candidates with it and the optimizer derives each slot's layer ROLE from
 * it, and those two reading the value differently is how a slot would be offered a gun the plan then rejects.
 */
export function parseActivity(v: string | undefined): { act: string; layer: Layer | null } {
  const raw = v ?? "";
  if (raw.endsWith("-surface")) return { act: raw.slice(0, -"-surface".length), layer: "Surface" };
  if (raw.endsWith("-core")) return { act: raw.slice(0, -"-core".length), layer: "Core" };
  return { act: raw, layer: null };
}

// May the slot KEEP what is fitted? A slot filter restricts what may be FITTED, not merely what may be
// considered: with a filter set and a non-matching gun in the slot, the answer has to be a switch even at lower
// power, because that is what setting the filter asked for. When keeping IS allowed, only an upgrade is worth
// proposing. Every suggest path and the opportunity rails ask this one question — it had drifted into four
// copies (`keepOk`, two `upgradeOnly`s, and an `eqMatches` in App.tsx), which is how expanded mode ended up
// being the only one that ignored the rule.
export function mayKeepEquipped(equipped: Item | null | undefined, size: string, f: GearFilter, cats: Record<string, string[]>): boolean {
  if (f.mode === "all" || !equipped) return true;
  return turretFits(equipped, size, f, cats);
}

/**
 * Which layers this ship can actually REACH, judged by what it can MOUNT.
 *
 * The distinction is the whole point: owning a Core drill proves nothing if it is Large and every hardpoint on the
 * hull is Small, or if the slot's own filter would refuse it. Measured over the inventory as a whole, a single
 * unmountable gun made the app demand a balanced build the ship could not possibly field — and a balanced target
 * scores `min(surface, core)`, so every candidate battery scored 0, nothing ever beat anything, and every slot
 * reported "kept". That is the exact silence the degrade rule exists to prevent.
 *
 * FITTED guns always count: they are mounted, whatever a filter now says.
 */
export function reachableLayers(
  act: string,
  fitted: ReadonlyArray<Item>,
  candidates: ReadonlyArray<Item>,
  slots: ReadonlyArray<{ size: string; filter: GearFilter }>,
  cats: Record<string, string[]>,
): { surface: boolean; core: boolean } {
  const mine = (g: Item) => catOf(g) === act;
  const mountable = candidates.filter((g) => mine(g) && slots.some((sl) => turretFits(g, sl.size, sl.filter, cats)));
  const universe = [...fitted.filter(mine), ...mountable];
  return {
    surface: universe.some((g) => coversLayer(g, "Surface")),
    core: universe.some((g) => coversLayer(g, "Core")),
  };
}

export const moduleFits = (it: Item, slot: string, size: string) =>
  isModuleItem(it) && it.slotType === slot && (!size || !it.size || it.size === size);
