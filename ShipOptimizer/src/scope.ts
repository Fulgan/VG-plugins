/**
 * Score what a thing IS, or what it will become once used.
 *
 * The same question is asked of two different surfaces, and it has to be asked the same way in both: an officer's
 * skills can be read at their current unlocked level or at full potential, and a booster's resonance bonus can be
 * read as live-now or as the bonus it unlocks once the booster has been flown. One vocabulary and one pair of
 * labels ∴ the two controls cannot drift into meaning different things by different words.
 *
 * `current` is the honest reading of the ship as it stands today. `potential` is a PLAN: it credits what will
 * arrive if the player commits to the thing — which is the reading that answers "what should I equip", since
 * nothing unlocks in the armory. Neither is more correct; they answer different questions, so the player picks.
 */
export type Scope = "current" | "potential";

export const SCOPE_LABEL: Record<Scope, string> = {
  current: "current",
  potential: "full potential",
};

export const DEFAULT_SCOPE: Scope = "potential";

export const isScope = (v: unknown): v is Scope => v === "current" || v === "potential";

/**
 * ONE CHOICE, READ BY EVERY TAB THAT ASKS THE QUESTION.
 *
 * The officers tab owned this state, and the gear tab cannot receive it: their builders are separate hooks and the
 * officer one is constructed LATER in the tree (it needs the ship list), so there is no prop that could carry it
 * upward. Two `useState`s reading one persisted key would drift — a tab changing the scope would leave the other
 * showing figures for the scope it was not on, which is worse than having no control at all.
 *
 * So the value lives HERE, module-level, with subscribers. Whoever persists it stays the persister: this store
 * holds no storage key, because the officers' saved blob already carries `scope` beside its priorities and pins,
 * and splitting one saved object across two owners is the drift this store exists to prevent.
 */
let current: Scope = DEFAULT_SCOPE;
const listeners = new Set<() => void>();

/** Seed from whatever persisted it, without notifying: called while the first reader is initialising. */
export function primeScope(v: Scope) {
  current = v;
}

export function getScope(): Scope {
  return current;
}

export function setSharedScope(v: Scope) {
  if (v === current) return;
  current = v;
  for (const fn of [...listeners]) fn();
}

export function subscribeScope(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}
