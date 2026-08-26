// The shopping list: the sell list's filter system, read the other way round. A sell rule asks which of the
// items you OWN are scrap; a want rule asks which of the offers in front of you is something you came for —
// the same clauses, the same words, the same editor, plus the two fields that only mean anything on a shop
// floor (`price`, `copies owned`).
//
// Deliberately WHERE only: no GROUP BY / TAKE / HAVING. Those exist to cut an over-large owned pile down to
// its extremes, and a shop floor is a handful of rows that either match or do not. A want rule never spends
// anything either — it puts a row on the shop rail beside the upgrade rows, with the buy button those already
// have — so a rule that matches too much costs a line on screen, never credits.
import { matchesWhere, subjectPhrase, type FieldCtx, type Where } from "./sellRules";
import type { Item } from "./types";

export interface WantRule {
  id: string;
  where: Where;
  /**
   * What the player calls this list. OPTIONAL, and absent is the normal case: a rule states itself in words
   * already, so a name is only worth typing when several rules are being told apart on the rail. Where it exists
   * it is what a matched offer is tagged with.
   */
  name?: string;
}

export const newWant = (id: string): WantRule => ({ id, where: {} });

export const nextWantId = (rules: WantRule[]) =>
  "w" + (rules.reduce((n, r) => Math.max(n, Number(r.id.slice(1)) || 0), 0) + 1);

/**
 * A rule with no clauses matches NOTHING, not everything.
 *
 * `matchesWhere` on an empty `where` is true by construction — every clause it was asked about held — which is
 * the right answer for a sell rule being narrowed down inside a preview. Here the rule's matches go straight
 * onto a rail: the whole shop floor appearing the moment "add a want" is pressed reads as a broken feature
 * rather than as an unfinished rule.
 */
export const isInert = (r: WantRule) => Object.keys(r.where).length === 0;

/**
 * The rule in words. FLAG, ⊥ "buy": a want rule spends nothing — it puts a row on the shop rail beside the
 * upgrades, with the same confirm-then-buy button those already have — and a sentence that opens with "Buy"
 * claims an automation this app deliberately does not have. Per the user: "it's not 'buy everything', it's 'flag
 * everything'. There is no auto-buy."
 */
export const wantSentence = (r: WantRule) => "Flag " + subjectPhrase(r.where, "anything on offer") + ".";

/**
 * How many of each item NAME the player holds, for the `copies owned` clause.
 *
 * Keyed by NAME because that is what a player means by "I already have one": a store handle is a slot the game
 * refills on restock, and two rolls of the same gun are the same thing to a shopping list.
 */
export function ownedCounts(items: Item[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const it of items) out[it.name] = (out[it.name] ?? 0) + Math.max(1, it.count ?? 1);
  return out;
}

/**
 * The first rule that claims this offer, or null.
 *
 * FIRST rather than all: a rail row names ONE reason, and two want rules cannot disagree about an offer — they
 * are all of one kind, which is the same constraint that lets the sell list have no precedence rules either.
 */
export function wantedBy(it: Item, rules: WantRule[], ctx: FieldCtx): WantRule | null {
  for (const r of rules) if (!isInert(r) && matchesWhere(it, r.where, ctx)) return r;
  return null;
}

/**
 * EVERY rule that claims this offer, not just the first.
 *
 * A row is tagged with the lists it belongs to, and belonging to two is the interesting case — it is why the
 * offer is worth more attention, not less. `wantedBy` stays for the yes/no question.
 */
export function wantedByAll(it: Item, rules: WantRule[], ctx: FieldCtx): WantRule[] {
  return rules.filter((r) => !isInert(r) && matchesWhere(it, r.where, ctx));
}

/** What to tag a matched offer with: the rule's own name, trimmed, or null when it was never named. */
export const wantTag = (r: WantRule) => {
  const t = (r.name ?? "").trim();
  return t.length ? t : null;
};

/** Offers one rule claims, for the count beside it in the editor. */
export const wantMatches = (offers: Item[], r: WantRule, ctx: FieldCtx): Item[] =>
  isInert(r) ? [] : offers.filter((it) => matchesWhere(it, r.where, ctx));
