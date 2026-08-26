import type { Item, StatLine } from "./types";
import type { Scope } from "./scope";

/**
 * WORKSHOP QUALITY, AND WHAT AN ITEM WOULD BE AT ITS CEILING.
 *
 * Read off `AbstractEquipment` rather than inferred, because every part of it is counter-intuitive:
 *
 * ONE LEVEL MULTIPLIES EVERY STAT LINE EXCEPT THE MAIN STAT BY 1.01. `BakeQualityStep` walks the item's stats and
 * skips `IsMainStat(i)`; `BakeAllQualityFromScratch` is `Mathf.Pow(1.01f, qualityLevel)` over the same skip. So a
 * gun's headline Combat Power gains NOTHING from quality, and everything that feeds the ship's pools gains all of
 * it. An item's quality is therefore invisible in the one figure the game puts on its card.
 *
 * A LINE SCALES BY ITS EFFECT, not by its number. `ScaleStatBy` sends a flat line to `amount * (1 + f)` and a
 * percent line to `1 + (multiplier - 1) * (1 + f)` — the EXCESS over 1 grows. Scaling a `×171.43` armor
 * multiplier as `171.43 * f` would credit a plating with hundreds of times what quality actually buys.
 *
 * THE CEILING IS THE RARITY'S. Legendary 25, Exotic 20, HighGrade 15, and nothing below HighGrade can be upgraded
 * at all (`Source.Item.RarityExtentions.GetMaxQualityLevel`). The workshop also needs player level 50, which is a
 * fact about the PLAYER rather than the item ∴ it is not modelled here: an item's ceiling does not move when the
 * player levels, and a plan is a plan whether or not today is the day it can be paid for.
 *
 * WHAT IS DELIBERATELY NOT CREDITED: at quality 25 one RANDOMLY chosen substat gains a further ×1.10
 * (`PickRandomSubstatIndex`, then persisted as `qualityBonusStatIndex` and served as `bonusStat`). Only Legendary
 * can reach 25. For an item already there the bonus is baked into the numbers the bridge sends, so it needs no
 * help; for one that is not, WHICH line receives it is unknowable, and spreading a bonus that lands on exactly
 * one line across all of them would credit every line with something only one of them gets. So the projection
 * stops at the deterministic half and the tab says so.
 */

/** The quality ceiling for a rarity. Absent from this table ⇒ the workshop refuses the item outright. */
export const MAX_QUALITY: Readonly<Record<string, number>> = {
  HighGrade: 15,
  Exotic: 20,
  Legendary: 25,
};

/** One level's factor. Quality is `STEP ** levels`, never `1 + STEP * levels` — it compounds. */
export const QUALITY_STEP = 1.01;

/** What this item's rarity allows. 0 for a rarity the workshop will not touch. */
export function qualityCap(rarity: string | null | undefined): number {
  return (rarity && MAX_QUALITY[rarity]) || 0;
}

/** The level an item is AT. The bridge serves it as `bonus`, and absent means "this build cannot report it". */
export function qualityOf(it: Item): number {
  const q = it.bonus;
  return typeof q === "number" && Number.isFinite(q) && q > 0 ? q : 0;
}

/**
 * Levels still available on this item. 0 ⇒ maxed, a rarity with no quality at all, or an item quality cannot
 * touch.
 *
 * A BOOSTER IS THAT THIRD CASE, and it is the game's own accounting rather than a special case invented here.
 * Quality scales exactly the NON-MAIN lines, and the bridge builds `substats` from
 * `GetStatsWithIndex(includeMainStat: false)` — the game's answer to which lines those are. For a booster it comes
 * back EMPTY (its two `Combat Power` lines, flat and multiplier, are both the main stat) ∴ there is nothing for a
 * level to move, and levels that buy nothing are not headroom. Reporting them as headroom is how this told the
 * player their six boosters were worth +16% to +22% each, which was false.
 */
export function qualityHeadroom(it: Item): number {
  if (!(it.substats ?? []).length) return 0;
  return Math.max(0, qualityCap(it.rarity) - qualityOf(it));
}

/** What every non-main stat line would be multiplied by after `levels` more upgrades. */
export function qualityFactor(levels: number): number {
  return levels > 0 ? QUALITY_STEP ** levels : 1;
}

/** A line's own scaling rule: the EFFECT grows, so a percent line's excess over 1 is what moves. */
function scaleLine(s: StatLine, factor: number): StatLine {
  if (s.multiplier && s.multiplier !== 1) return { ...s, amount: 0, multiplier: 1 + (s.multiplier - 1) * factor };
  return { ...s, amount: s.amount * factor, multiplier: 1 };
}

/**
 * The item as it would read at its quality ceiling, or the item itself when there is nothing to gain.
 *
 * THE SAME OBJECT IS RETURNED WHERE NOTHING MOVES, and that is load-bearing rather than an optimisation: the
 * search and the tab both compare items by IDENTITY (`pick === hp.equipped` is how "keep current" is expressed,
 * and `handle(it)` dedupes the armory), so cloning an item that gained nothing would make every slot look like a
 * swap and every candidate look like a different item from the one in the list.
 *
 * `substats` IS the set that scales — the bridge builds it from `GetStatsWithIndex(includeMainStat: false)`, which
 * is the game's own answer to "everything but the main stat". `stats` holds the main line as well, so its entries
 * are matched against `substats` and only the matched ones move. That needs no main-stat name matching, which is
 * the part that would rot: the two lists disagree about spelling in places (`Energy` against `EnergyCapacity`).
 *
 * ASPECTS ARE UNTOUCHED. An aspect's boost lives on a separate component (`BoostStat`), not in the equipment's
 * `stats` list, so no amount of quality moves it.
 */
export function atMaxQuality(it: Item): Item {
  const levels = qualityHeadroom(it);
  if (levels <= 0) return it;
  const factor = qualityFactor(levels);

  // Consumed as they match, so an item carrying the same stat twice scales both rather than one twice.
  const pool = (it.substats ?? []).map((s) => ({ s, used: false }));
  const scalable = (line: StatLine) => {
    const hit = pool.find((p) => !p.used && p.s.stat === line.stat
                                 && p.s.amount === line.amount && p.s.multiplier === line.multiplier);
    if (!hit) return false;
    hit.used = true;
    return true;
  };

  return {
    ...it,
    stats: (it.stats ?? []).map((s) => (scalable(s) ? scaleLine(s, factor) : s)),
    substats: (it.substats ?? []).map((s) => scaleLine(s, factor)),
  };
}

/** One owner for "read this item as it is, or as it could be", so no surface decides it a second way. */
export function atScope(it: Item, scope: Scope): Item {
  return scope === "potential" ? atMaxQuality(it) : it;
}

/** The same, over a list, keeping nulls in place so a positional pairing survives it. */
export function listAtScope<T extends Item | null>(items: readonly T[], scope: Scope): T[] {
  return scope === "potential" ? items.map((x) => (x ? (atMaxQuality(x) as T) : x)) : [...items];
}
