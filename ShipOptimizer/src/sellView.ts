// How the split's result is LAID OUT — sorting, grouping, columns — and nothing about what a rule decides.
//
// The two are deliberately separate state. `where|group|having|order|take` decide what is sold; the values
// here decide what the player is looking at while they check that decision. A view control that reached into
// the rule would mean re-reading a result by quality changes the result, and the rule's own GROUP BY is a
// semantic partition (what TAKE counts within), not a layout: the view may nest by fields the rule refuses.
//
// Pure — no React — so the grouping and the ordering can be tested without mounting a popin.
import { FIELDS, NO_VALUE, asList, fieldOf, rankVal, valueLabel, type Explain, type FieldCtx } from "./sellRules";
import type { Item } from "./types";

/** Which side of the rule a row landed on. `in` = the rule acts on it, `out` = it matched the filter and the
 *  count left it behind, `excluded` = no clause selected it, so the DEFAULT decides its fate. */
export type Bucket = "in" | "out" | "excluded";

export interface ViewRow {
  it: Item;
  bucket: Bucket;
  /** The clause that turned it away, as a clause key. Set for `excluded` rows only. */
  why: string | null;
}

export interface SortKey { k: string; dir: "asc" | "desc" }

export interface ViewState {
  /** Fields the REVIEW list nests by, outermost first. Empty = one flat list. */
  group: string[];
  /** Sort keys in priority order; empty keeps the order the rules produced the rows in. */
  sort: SortKey[];
  /** Field keys drawn as columns, beside the always-present name. */
  cols: string[];
  /** Buckets the player has folded away. Empty = every row is on screen, which is the state a review starts
   *  in: hiding a side is a choice, never a default, or the rows nobody chose to see go unseen. */
  hide: Bucket[];
}

/** The name is not a field — every row is identified by it, so it is drawn whatever the column set says. */
export const NAME_COL = "nm";

export const DEFAULT_COLS = ["l", "r", "v"];
export const emptyView = (): ViewState => ({ group: [], sort: [], cols: [...DEFAULT_COLS], hide: [] });
export const BUCKETS: Bucket[] = ["in", "out", "excluded"];

/** Fields a row can be sorted or shown by: everything the rule can filter on, plus the name. */
export const viewFields = (): string[] => [NAME_COL, ...Object.keys(FIELDS)];
/** Takes a column key or a CLAUSE key: a second clause about one field is still labelled by that field. */
export const fieldLabel = (k: string): string => (k === NAME_COL ? "item" : FIELDS[fieldOf(k)]?.label ?? k);

/** Every row a rule produced, in one list, each carrying the side it landed on. Protected items are not here:
 *  the game refuses to sell them, so there is no decision to inspect. */
export function viewRows(ex: Explain): ViewRow[] {
  const out: ViewRow[] = [];
  for (const g of ex.groups)
    for (const r of g.rows) out.push({ it: r.it, bucket: r.in ? "in" : "out", why: null });
  for (const x of ex.excluded) out.push({ it: x.it, bucket: "excluded", why: x.k });
  return out;
}

/** What a field says about an item, as the text a cell and a group label both show. A `multi` field answers
 *  with several values at once and they identify the group together, so they are joined rather than picked. */
export function cellText(it: Item, k: string, ctx: FieldCtx): string {
  if (k === NAME_COL) return it.name ?? "";
  const F = FIELDS[k];
  if (!F) return "";
  return asList(F.get(it, ctx)).map((v) => valueLabel(k, v)).join(" + ");
}

/**
 * What a field is worth for ORDERING. `ORDERS` already ranks the measures whose text sorts wrong — quality is
 * the one that matters, since alphabetical would put Common above Legendary — and `rankVal` owns that ranking.
 * Everything else compares as its own text, numerically where the text is a number.
 */
function sortVal(it: Item, k: string, ctx: FieldCtx): number | string {
  if (k === NAME_COL) return it.name ?? "";
  if (k === "r" || k === "m" || k === "l" || k === "v" || k === "aspN" || k === "aspE") return rankVal(it, k);
  const F = FIELDS[k];
  if (F?.kind === "range") return Number(F.get(it, ctx) ?? 0);
  return cellText(it, k, ctx);
}

/** Numbers as numbers ("Lv 2" before "Lv 10"), everything else alphabetically; `none` last, since it is the
 *  absence of the thing the column is named for. */
export function compareText(a: string, b: string): number {
  if (a === b) return 0;
  if (a === NO_VALUE) return 1;
  if (b === NO_VALUE) return -1;
  const na = Number(a), nb = Number(b);
  if (Number.isFinite(na) && Number.isFinite(nb)) return na - nb;
  return a.localeCompare(b);
}

const compareVal = (a: number | string, b: number | string): number =>
  typeof a === "number" && typeof b === "number" ? a - b : compareText(String(a), String(b));

/** Multi-key row order. Keys are applied in the order the player added them; ties fall through to the next. */
export function compareRows(a: Item, b: Item, sort: SortKey[], ctx: FieldCtx): number {
  for (const s of sort) {
    const d = compareVal(sortVal(a, s.k, ctx), sortVal(b, s.k, ctx));
    if (d) return s.dir === "desc" ? -d : d;
  }
  return 0;
}

export interface ViewNode {
  /** Stable across renders and unique within the tree: the path of labels that reaches this node. */
  key: string;
  label: string;
  depth: number;
  kids: ViewNode[];
  /** Rows at this node. A node with kids holds none — its rows live in the leaves. */
  rows: ViewRow[];
  held: number;
  nIn: number;
  nOut: number;
  nExcluded: number;
  /** What the rows under this node are worth, counting stacks. */
  credits: number;
}

const tally = (node: ViewNode, rows: ViewRow[]): void => {
  for (const r of rows) {
    const n = Math.max(1, r.it.count ?? 1);
    node.held += n;
    node.credits += n * (r.it.sellValue ?? 0);
    if (r.bucket === "in") node.nIn += n;
    else if (r.bucket === "out") node.nOut += n;
    else node.nExcluded += n;
  }
};

/**
 * Nest rows by `group`, outermost field first, sorting each level by its own label and each leaf's rows by
 * `sort`. A field the items answer with nothing groups under `none` rather than vanishing, the same value the
 * matcher uses, so a group the player can see is a group they can also write a clause about.
 */
export function viewTree(rows: ViewRow[], group: string[], sort: SortKey[], ctx: FieldCtx): ViewNode[] {
  const build = (rs: ViewRow[], depth: number, path: string): ViewNode[] => {
    if (depth >= group.length) return [];
    const by = new Map<string, ViewRow[]>();
    for (const r of rs) {
      const label = cellText(r.it, group[depth], ctx) || NO_VALUE;
      const arr = by.get(label);
      if (arr) arr.push(r); else by.set(label, [r]);
    }
    return [...by.entries()]
      .sort((a, b) => compareText(a[0], b[0]))
      .map(([label, kidRows]) => {
        const key = path + "|" + label;
        const node: ViewNode = {
          key, label, depth, kids: build(kidRows, depth + 1, key),
          rows: [], held: 0, nIn: 0, nOut: 0, nExcluded: 0, credits: 0,
        };
        if (!node.kids.length) node.rows = sortRows(kidRows, sort, ctx);
        tally(node, kidRows);
        return node;
      });
  };
  return build(rows, 0, "");
}

/** The leaf order. With no sort keys the rows keep the order the rule produced them in, which is its own
 *  ORDER BY — the count's cut line only means something against that sequence. */
export const sortRows = (rows: ViewRow[], sort: SortKey[], ctx: FieldCtx): ViewRow[] =>
  sort.length ? [...rows].sort((a, b) => compareRows(a.it, b.it, sort, ctx)) : rows;

/** Toggle a column's sort: a fresh key sorts descending for measures and ascending for text, clicking the
 *  same key again flips it. `append` (shift-click) keeps the existing keys and adds this one after them. */
export function toggleSort(sort: SortKey[], k: string, append: boolean): SortKey[] {
  const at = sort.findIndex((s) => s.k === k);
  const flipped: SortKey = at >= 0
    ? { k, dir: sort[at].dir === "desc" ? "asc" : "desc" }
    : { k, dir: k === NAME_COL || FIELDS[k]?.kind === "set" || FIELDS[k]?.kind === "multi" ? "asc" : "desc" };
  if (!append) return [flipped];
  const rest = sort.filter((s) => s.k !== k);
  return [...rest, flipped];
}

/** A stored view can name fields this build does not have — an imported list, or one written against a newer
 *  app. Unknown keys are dropped rather than refused, so the rest of the layout still loads. */
export function sanitizeView(v: unknown): ViewState {
  const o = (v ?? {}) as Partial<ViewState>;
  const known = (k: unknown): k is string => typeof k === "string" && (k === NAME_COL || !!FIELDS[k]);
  const group = Array.isArray(o.group) ? o.group.filter((k) => known(k) && k !== NAME_COL) : [];
  const cols = Array.isArray(o.cols) ? o.cols.filter(known) : [...DEFAULT_COLS];
  const sort = Array.isArray(o.sort)
    ? o.sort.filter((s): s is SortKey => !!s && known(s.k) && (s.dir === "asc" || s.dir === "desc"))
    : [];
  const hide = Array.isArray(o.hide) ? o.hide.filter((b): b is Bucket => BUCKETS.includes(b as Bucket)) : [];
  return { group, sort, cols, hide };
}
