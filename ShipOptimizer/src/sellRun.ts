// Selling a batch of items, and reporting what actually happened. ONE owner.
//
// This is the only code in the app that spends something irreversibly, and everything in it was learned from a
// sale that went wrong: handles go stale between building a list and pressing the button, an older bridge reads
// the batch body as a single sale and refuses it, a station will not always buy back what it just took, and a
// failure list of names says nothing a player can act on where a count per REASON does. A second copy of that
// would be a second set of those lessons to keep in step — so the sell list and the inventory grid's
// "sell selected" call this instead.
//
// Deliberately NOT a component and NOT a hook: it takes the confirmation as a function and returns a result. The
// two callers word their own button, their own busy state and their own notice, because those belong to the
// surface — what must not differ is what gets sent and what the player is told afterwards.
import { ApiError, api, type Conn } from "./api";
import { fmt } from "./format";
import type { Item } from "./types";

export interface SellRow {
  store: string;
  key: number;
  count: number;
  name: string;
  id: string | null;
}

/** Rows the bridge can actually be asked about: an item with no handle cannot be named in a request. */
export const sellableRows = (items: Item[]): SellRow[] =>
  items
    .filter((it) => it.key != null && it.location)
    .map((it) => ({
      store: it.location as string,
      key: it.key as number,
      count: Math.max(1, it.count ?? 1),
      name: it.name,
      id: it.identifier ?? null,
    }));

export interface SellOutcome {
  sold: number;
  earned: number;
  skipped: number;
  /** One line per REASON, commonest first — a count a player can act on, ⊥ a list of names. */
  reasons: string[];
  /** Where the goods went, when the station will not take all of them back. */
  backNote: string | null;
  /** The sentence to show. Built here so both surfaces say the same thing about the same sale. */
  text: string;
  ok: boolean;
}

/**
 * Sell `rows`, then say what happened.
 *
 * `expectName`/`expectId` ride on every row because the list was built BEFORE the press: a handle is an inventory
 * slot, not an item identity, and a restock or a drop can put something else there. The bridge refuses with 409
 * rather than selling whatever now sits in that slot.
 */
export async function sellRows(conn: Conn, rows: SellRow[]): Promise<SellOutcome> {
  let sold = 0, earned = 0, skipped = 0;
  let reasons: string[] = [];
  let backNote: string | null = null;

  try {
    const r = await api.sellBatch(conn, rows.map(({ name, id, ...row }) => ({ ...row, expectName: name, expectId: id })));
    sold = r.sold; earned = r.credits; skipped = r.failed ?? 0;
    // Grouped by reason: "6 skipped" with two example names says nothing about the other four, and the reason is
    // the part a player can do something about ("refresh the inventory", "the game will not sell that").
    const counts = r.failureCounts
      ?? (r.failures ?? []).reduce<Record<string, number>>((m, f) => ({ ...m, [f.error]: (m[f.error] ?? 0) + 1 }), {});
    reasons = Object.entries(counts).sort((a, b) => b[1] - a[1]).map(([why, n]) => `${n}× ${why}`);
    const back = r.boughtBack ?? 0;
    if (sold > 0 && back < sold) {
      backNote = back > 0
        ? `${fmt(back)} can be bought back${r.buybackNote ? `; the rest not: ${r.buybackNote}` : ""}.`
        : `Nothing can be bought back${r.buybackNote ? ` — ${r.buybackNote}` : ""}.`;
    }
  } catch (e) {
    // A bridge that predates the batch form reads the body as a single sale and refuses it for want of a key.
    // Fall back to one request per row: slower by two orders of magnitude, but it still sells.
    if (!(e instanceof ApiError) || e.status !== 400) throw e;
    for (const row of rows) {
      try {
        const r = await api.sell(conn, row.store, row.key, row.count, row.name, row.id);
        sold += r.sold; earned += r.credits;
      } catch (err) {
        skipped++;
        if (reasons.length < 20) reasons.push(`${row.name}: ${err instanceof ApiError ? err.message : String(err)}`);
      }
    }
  }

  return {
    sold, earned, skipped, reasons, backNote,
    ok: !skipped,
    text: `Sold ${fmt(sold)} for ${fmt(earned)} cr.`
      + (skipped ? ` ${fmt(skipped)} skipped — ${reasons.slice(0, 3).join("; ")}` : "")
      + (backNote ? ` ${backNote}` : ""),
  };
}
