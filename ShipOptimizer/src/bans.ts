import { useCallback, useEffect, useMemo, useState } from "react";
import { load, save } from "./storage";
import type { Item } from "./types";
import { itemSignature } from "./itemKind";

export { itemSignature };

// WHAT THE PLAYER HAS TOLD THIS SHIP NOT TO BE OFFERED.
//
// The optimizers cannot see every reason an item is refused: a bad aspect roll, one held back for another hull, or
// simply not wanting it. A ban is where that reason lives, and it is PER SHIP because "I never want this item" and
// "not on this hull" are different statements while the armory is shared.
//
// TWO KINDS, because the thing being refused is not the same in each.
//
// An OWNED item is banned by what it IS. The ban has to survive that item moving between the ship, the armory and
// cargo, and applying a plan does exactly that, so the key names the item rather than where it sits. A store handle
// would be worse than useless here: a `key` is an inventory SLOT, and a restock refills the same slot with different
// goods, so a ban keyed by one would silently transfer to whatever landed there next.
//
// A STORE OFFER is banned exactly as rolled, and only until the shop rerolls: every offer is regenerated on a
// restock, so a ban that outlived one would land on a different item. Its key therefore carries the whole roll, and
// it is held in memory rather than persisted, which is at worst the same lifetime the player asked for.
const KEY = "shipoptimizer.bans";

/**
 * WHICH QUESTION A REFUSAL ANSWERS.
 *
 * `fit` is what the optimizer may CHOOSE from: the gear pool, the booster pool, the crew it ranks.
 * `notice` is what the app POINTS OUT: the opportunity rails, inventory and shop alike, and the hire list.
 *
 * They are two questions, not one control in two places. The rails are a WIDER net by design — they rank on the
 * headline where the tab weighs a whole battery — so they surface things the optimizer would never choose, which
 * is the point of them: a way to rescue a build the optimizer's rules cannot see. Refusing a candidate there says
 * "stop pointing this out", and refusing one on a slot card says "never fit this". One set for both meant lifting
 * either lifted the other.
 *
 * ⊥ CALLED `buy`: the inventory rail spends nothing. It reads the player's own gear against what they fly.
 */
export type BanScope = "fit" | "notice";

/** The stored key: the question, then the thing. */
export const banKey = (scope: BanScope, it: Item): string => `${scope}:${itemSignature(it)}`;
export const officerKey = (scope: BanScope, o: { guid: string }): string => `${scope}:${officerBanKey(o)}`;

/** The thing, without the question — what `reconciled` checks against the world. */
const thingOf = (key: string): string => key.slice(key.indexOf(":") + 1);

/**
 * An officer is refused by GUID, and one rule covers both kinds.
 *
 * A crew member's guid is stable, so the ban follows the person. A station recruit's guid dies with the roster
 * it was rolled into, so the ban stops matching at the next restock on its own. Prefixed so an officer and an
 * item can never collide in the one store.
 */
export const officerBanKey = (o: { guid: string }): string => `o:${o.guid}`;

export interface Bans {
  /** Is this item refused for this question on this ship? */
  has: (it: Item, scope: BanScope) => boolean;
  /** Refuse it for that question, or lift the refusal it already carries there. */
  toggle: (it: Item, scope: BanScope) => void;
  /** The same question and the same answer for a crew member or a recruit. */
  hasOfficer: (o: { guid: string }, scope: BanScope) => boolean;
  toggleOfficer: (o: { guid: string; name?: string }, scope: BanScope) => void;
  /**
   * Lift these bans, by key.
   *
   * ⊥ "lift everything": each surface counts what IT is hiding, so the control beside that count has to lift the
   * same set. Clearing the whole ship from the shop rail also emptied the inventory's list, which is the count
   * and the button disagreeing about what they are about.
   */
  liftAll: (keys: Iterable<string>) => void;
  /** How many stand in total. Each surface counts what IT is hiding instead; this is for nothing else. */
  count: number;
}

/** What a refusal remembers: what it was called, and when it was made. */
interface Entry { n: string; t: number }
/** ship guid → ban key → entry. */
type Stored = Record<string, Record<string, Entry>>;

/** What the list calls a refused item. Level included: two of a name differ by it more often than not. */
const labelOf = (it: Item): string => `${it.name}${it.level != null ? ` Lv ${it.level}` : ""}`;

/**
 * How long a refusal survives once the thing it named is nowhere to be found.
 *
 * A SHOP restocks hourly, so an entry that matched an offer is spent an hour after it was made — the reroll
 * changes the substats and the signature can never match again.
 *
 * Anything the player OWNS is different: it is kept for as long as they own it, however long that is. The grace
 * period is only there so a ban made on a shop row does not evaporate before the shelf turns over, and so that a
 * refresh arriving mid-flight cannot mistake "not loaded yet" for "no longer owned".
 */
const GRACE_MS = 60 * 60 * 1000;

/** What the player has right now, so a refusal can be checked against the world rather than against a clock. */
export interface Present {
  /** Signatures of everything owned: inventory, armory, cargo. Officer keys too. */
  held: ReadonlySet<string>;
  /** Signatures of what is FITTED on a ship. Fitting a thing is the plainest statement that it is wanted. */
  fitted: ReadonlySet<string>;
  /** False while the payloads are still arriving — nothing is pruned against a world not yet read. */
  ready: boolean;
}

/**
 * Drop what the world no longer justifies.
 *
 * Three rules, and none of them is a timer on a thing that still exists:
 *   FITTED    lifted outright. A player who mounts an item has answered the question the refusal was asking, and
 *             leaving it refused would hide the very item now on the ship.
 *   HELD      kept, for as long as it is held.
 *   NEITHER   sold, dropped, lost, or a shop offer the restock has rerolled ∴ kept only for the grace period,
 *             after which nothing it could match exists and no surface could ever count or lift it.
 */
export function reconciled(all: Stored, ship: string, present: Present, now = Date.now()): Stored {
  if (!present.ready) return all;
  const cur = all[ship];
  if (!cur) return all;
  let touched = false;
  const kept: Record<string, Entry> = {};
  for (const [k, e] of Object.entries(cur)) {
    const thing = thingOf(k);
    if (present.fitted.has(thing)) { touched = true; continue; }
    if (present.held.has(thing)) { kept[k] = e; continue; }
    if (now - e.t < GRACE_MS) kept[k] = e; else touched = true;
  }
  return touched ? { ...all, [ship]: kept } : all;
}

/**
 * The ban set for one ship.
 *
 * The owned half is persisted and the offer half is not, which is the whole difference between the two kinds. Both
 * are counted together, because a player asking "what am I refusing" means all of it.
 */
export function useBans(shipGuid: string | null, present?: Present): Bans {
  // A saved blob from before the label was kept holds a bare list of keys. It is read as keys naming themselves
  // rather than migrated: the items are long gone, so there is nothing better to call them.
  const [owned, setOwned] = useState<Stored>(() => {
    const raw = load<Record<string, Record<string, string | Entry> | string[]>>(KEY, {});
    const now = Date.now();
    const out: Stored = {};
    for (const [g, v] of Object.entries(raw)) {
      // Blobs written before the label, and before the timestamp, are read rather than migrated away: a bare key
      // names itself, and an entry with no date is treated as made now so it gets its full life rather than
      // vanishing on the first load that knows about ageing.
      const entries = Array.isArray(v) ? Object.fromEntries(v.map((k) => [k, k])) : v;
      out[g] = Object.fromEntries(Object.entries(entries).map(([k, e]) =>
        // A key with no question in front of it was written when there was only one control, and that control
        // lived on the gear pool ∴ it is read as `fit` rather than widened to both.
        [k.startsWith("fit:") || k.startsWith("notice:") ? k : `fit:${k}`,
         typeof e === "string" ? { n: e, t: now } : { n: e.n, t: e.t ?? now }]));
    }
    return out;
  });
  const guid = shipGuid ?? "";

  // AGAINST THE WORLD, once the world is known. Fitted items are lifted, held ones kept, and anything that is
  // neither is spent an hour after it was made — a shop offer the restock has rerolled, or gear since sold.
  useEffect(() => {
    if (!present?.ready) return;
    setOwned((prev) => {
      const next = reconciled(prev, guid, present);
      if (next !== prev) save(KEY, next);
      return next;
    });
  }, [guid, present]);

  const mine = useMemo(() => owned[guid] ?? {}, [owned, guid]);

  const has = useCallback(
    (it: Item, scope: BanScope) => banKey(scope, it) in mine,
    [mine],
  );

  const toggle = useCallback((it: Item, scope: BanScope) => {
    const k = banKey(scope, it);
    setOwned((prev) => {
      const cur = { ...(prev[guid] ?? {}) };
      if (k in cur) delete cur[k]; else cur[k] = { n: labelOf(it), t: Date.now() };
      const next = { ...prev, [guid]: cur };
      save(KEY, next);
      return next;
    });
  }, [guid]);

  // Officers ride in the PERSISTED half whichever kind they are: a recruit's guid dies with its roster, so the
  // entry simply stops matching rather than needing a lifetime of its own.
  const hasOfficer = useCallback((o: { guid: string }, scope: BanScope) => officerKey(scope, o) in mine, [mine]);
  const toggleOfficer = useCallback((o: { guid: string; name?: string }, scope: BanScope) => {
    const k = officerKey(scope, o);
    setOwned((prev) => {
      const cur = { ...(prev[guid] ?? {}) };
      if (k in cur) delete cur[k]; else cur[k] = { n: o.name ?? k, t: Date.now() };
      const next = { ...prev, [guid]: cur };
      save(KEY, next);
      return next;
    });
  }, [guid]);

  const liftAll = useCallback((keys: Iterable<string>) => {
    const drop = new Set(keys);
    setOwned((prev) => {
      const cur = prev[guid];
      if (!cur) return prev;
      const kept: Record<string, Entry> = {};
      for (const [k, v] of Object.entries(cur)) if (!drop.has(k)) kept[k] = v;
      const next = { ...prev, [guid]: kept };
      save(KEY, next);
      return next;
    });
  }, [guid]);

  return { has, toggle, hasOfficer, toggleOfficer, liftAll, count: Object.keys(mine).length };
}
