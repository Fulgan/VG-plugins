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
