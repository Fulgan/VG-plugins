// The sell list. Renders `sellRules` and decides nothing itself — the rails-vs-tab disagreement came from two surfaces answering one question, and this is the surface that spends money.
//
// Layout: KEEP and SELL as two columns, so the constraint (one default, all exceptions on
// the other side) is visible rather than explained. The default side holds one card; the other holds the
// rules, an OR between each, and a full-width add button under the last one.
import { Fragment, useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode, type RefObject } from "react";
import { itemIcon, type Conn } from "./api";
// The sale itself lives in one place, called from here and from the inventory grid's "sell selected".
import { sellRows, sellableRows } from "./sellRun";
import { Modal, useConfirm } from "./Modal";
import { Notice } from "./Notice";
import { RARITY_COLOR } from "./format";
import { ItemTip } from "./ItemCard";
import { useHoverIntent } from "./useCursorTip";
import type { Item } from "./types";
import "./sellList.css";
import { useWindowed } from "./useWindowed";

import {
  FIELDS, GROUP_FIELDS, ORDERS, cantSell, clauses, defaultDir, evaluate, explain,
  exportList, fieldVaries, listProblems, mergeCats, newRule, orderOptions, otherKind, parseList,
  pinsUnit, runRule,
  type Cats, type FieldCtx, type Kind, type Rule, type SellListFile,
} from "./sellRules";
import {
  DEFAULT_COLS, NAME_COL, cellText, fieldLabel, sortRows, toggleSort, viewFields, viewRows, viewTree,
  type Bucket, type SortKey, type ViewNode, type ViewRow, type ViewState,
} from "./sellView";
import { NumBox, WhereChips, usePopAnchor, usePopDismiss } from "./whereEditor";
import { ViewBar } from "./viewGrid";

const fmt = (n: number) => n.toLocaleString();
/** One handle per inventory row. `name` is the last resort only: an entry with no slot is not sellable
 *  anyway, so it can never be confused with a real slot. */
const idOf = (it: Item) => `${it.location ?? "?"}#${it.key ?? it.name}`;

export interface SellListProps {
  open: boolean;
  onClose: () => void;
  conn: Conn;
  docked: boolean;
  /** Everything the list may act on: equipment plus anything the game protects, so the guard is visible. */
  items: Item[];
  cats: Cats;
  myLevel: number;
  defaultKind: Kind;
  rules: Rule[];
  onChange: (next: { defaultKind: Kind; rules: Rule[] }) => void;
  /** Saved rule lists, by name. Playthrough-independent on purpose. */
  lists: Record<string, SellListFile>;
  onLists: (next: Record<string, SellListFile>) => void;
  /** An imported list brings its own category definitions; they merge into the ones every tab filters by. */
  onCats: (next: Cats) => void;
  onSold: () => void;
  /** How the split is laid out. Separate from the rules on purpose: it changes what is read, never what is
   *  sold, so it is stored beside them rather than inside one. */
  view: ViewState;
  onView: (next: ViewState) => void;
}

export default function SellList(p: SellListProps) {
  const [draft, setDraft] = useState<Rule | null>(null);
  const [openPop, setOpenPop] = useState<string | null>(null);
  const [splitQ, setSplitQ] = useState("");
  const [reviewQ, setReviewQ] = useState("");
  const [listName, setListName] = useState("");
  // Items the player struck off this sale by hand. Keyed by SLOT within its store, so a de-selection cannot
  // wander onto a different item; kept for the session only, because it answers "not this one, now".
  const [held, setHeld] = useState<Set<string>>(new Set());
  // The review list is the scroll container its ungrouped grid windows against.
  const reviewRef = useRef<HTMLDivElement | null>(null);
  const [openGroups, setOpenGroups] = useState<Set<string>>(new Set());
  // The review list's own folds. Separate from the split's: they are two lists, and folding one to read the
  // other is the normal way to use them.
  const [openReview, setOpenReview] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const { ask, ui: confirmUi } = useConfirm();
  const { target: hover, show: showTip, hide: hideTip } = useHoverIntent<{ it: Item; x: number; y: number }>();

  // A click outside and Escape both close the picker (`usePopDismiss`); the third exit is the draft going away,
  // discarded or added, since nothing anchors the popover then.
  usePopDismiss(openPop, () => setOpenPop(null));
  useEffect(() => { if (!draft) setOpenPop(null); }, [draft]);

  const ctx: FieldCtx = useMemo(() => ({ cats: p.cats, myLevel: p.myLevel }), [p.cats, p.myLevel]);
  const other = otherKind(p.defaultKind);
  const seq = () => "r" + (p.rules.reduce((n, r) => Math.max(n, Number(r.id.slice(1)) || 0), 0) + 1);

  // The RuleSet is built INSIDE the memo: a fresh object per render would defeat it, and listing the object
  // as a dep while reading its parts is how a memo silently stops memoising.
  const verdicts = useMemo(
    () => evaluate(p.items, { defaultKind: p.defaultKind, rules: p.rules, cats: p.cats, myLevel: p.myLevel }),
    [p.items, p.defaultKind, p.rules, p.cats, p.myLevel]);
  // What the rules propose, and what survives the review below. A rule set says what KIND of thing to sell;
  // the last word on a specific item is the player's, so the sale acts on `rows`, never on the verdicts.
  const proposed = useMemo(() => p.items.filter((_, i) => verdicts[i] === "sell"), [p.items, verdicts]);
  const rows = useMemo(() => proposed.filter((it) => !held.has(idOf(it))), [proposed, held]);

  // THE REVIEW LIST IS THE GRID THE PLAYER DRIVES: grouping, sorting and columns decide what is READ
  // here, and the rules above decide what is sold. Every proposed row is in the list whatever the layout says —
  // a row nobody can see is a row nobody reviewed, and the sale still acts on it.
  const reviewRows = useMemo<ViewRow[]>(
    () => proposed.map((it) => ({ it, bucket: "in", why: null })), [proposed]);
  const reviewQl = reviewQ.trim().toLowerCase();
  // The search matches the name or any group label the row sits under, so a term naming a group finds the
  // group rather than nothing.
  const reviewMatches = useMemo(() => reviewQl
    ? reviewRows.filter((r) => (r.it.name ?? "").toLowerCase().includes(reviewQl)
        || p.view.group.some((k) => cellText(r.it, k, ctx).toLowerCase().includes(reviewQl)))
    : reviewRows, [reviewRows, reviewQl, p.view.group, ctx]);
  const reviewTree = useMemo(
    () => viewTree(reviewMatches, p.view.group, p.view.sort, ctx), [reviewMatches, p.view.group, p.view.sort, ctx]);
  // Columns that say something about THESE rows. A shop-floor field over an armory is one value for every row
  // — an owned item has no price and reports no owned count — so `price` was a column of zeros, which reads as
  // a broken number rather than as a question this list cannot answer. Judged over the WHOLE proposal, never
  // per group: one row is uniform by itself and would keep no columns at all.
  const reviewCols = useMemo(
    () => p.view.cols.filter((k) => fieldVaries(proposed, k, ctx)), [p.view.cols, proposed, ctx]);
  const counts = useMemo(() => {
    let keep = 0, cant = 0;
    // Counts are per ITEM (a row you act on); only credits multiply by the stack.
    for (const v of verdicts) if (v === "cant") cant++; else if (v !== "sell") keep++;
    return {
      keep, cant, sell: rows.length, back: proposed.length - rows.length,
      cr: rows.reduce((n, it) => n + Math.max(1, it.count ?? 1) * (it.sellValue ?? 0), 0),
    };
  }, [verdicts, proposed, rows]);

  // Striking a row off is the player's last word, so the tick is the row's own control and the whole row is a
  // target for it. Held by SLOT within its store (`idOf`), never by position: the list re-sorts under the tick.
  const tick = (it: Item) => setHeld((s) => {
    const n = new Set(s), id = idOf(it);
    if (n.has(id)) n.delete(id); else n.add(id);
    return n;
  });
  const tickCell = (it: Item) => (
    <td onClick={(e) => e.stopPropagation()}>
      <input type="checkbox" checked={!held.has(idOf(it))} onChange={() => tick(it)} aria-label={`sell ${it.name}`} />
    </td>
  );

  const commit = (rules: Rule[], defaultKind: Kind = p.defaultKind) => p.onChange({ defaultKind, rules });

  // ONE owner for "the draft becomes a rule": the editor offers it at the head and at the foot, since the split
  // preview between them can be thousands of rows tall.
  const addDraft = () => {
    if (!draft) return;
    // An edit REPLACES the rule it came from, in place: appending would leave the old version beside the new
    // one, and two rules of the same kind both match, so the sale would obey the version being replaced.
    const at = p.rules.findIndex((r) => r.id === draft.id);
    commit(at < 0 ? [...p.rules, draft] : p.rules.map((r) => (r.id === draft.id ? draft : r)));
    setDraft(null);
  };

  // ---- saved lists ----------------------------------------------------------------------------
  // Applying a list REPORTS what it could not resolve here. A category this browser does not define and a
  // type this inventory has never seen both match nothing in silence, so an unreported import would look
  // like a list that simply found no scrap today.
  const applyList = async (file: SellListFile, how: string) => {
    const names = Object.keys(p.lists);
    if (p.rules.length && !(await ask({
      title: `Replace the current ${p.rules.length} rule${p.rules.length === 1 ? "" : "s"}?`,
      detail: `“${file.name}” takes over the ${file.defaultKind === "keep" ? "keep" : "sell"} default and its ` +
              `${file.rules.length} rule${file.rules.length === 1 ? "" : "s"}. The current set is not saved unless you saved it.`,
      confirmLabel: "Replace",
    }))) return;
    const merged = mergeCats(p.cats, file.cats);
    if (merged.added.length) p.onCats(merged.cats);
    commit(file.rules, file.defaultKind);
    setListName(file.name);
    setDraft(null);
    const notes = [
      ...(merged.added.length ? [`added categor${merged.added.length === 1 ? "y" : "ies"} ${merged.added.join(", ")}`] : []),
      ...(merged.kept.length ? [`kept your own ${merged.kept.join(", ")}`] : []),
      ...listProblems(file.rules, merged.cats, p.items),
    ];
    setMsg({ ok: !listProblems(file.rules, merged.cats, p.items).length, text: `${how} “${file.name}”${notes.length ? " — " + notes.join("; ") : ""}${names.length === 0 ? "" : ""}` });
  };

  const saveList = async () => {
    const name = listName.trim();
    if (!name) return;
    if (p.lists[name] && !(await ask({
      title: `Overwrite “${name}”?`, detail: "The saved copy is replaced by what is on screen.", confirmLabel: "Overwrite",
    }))) return;
    p.onLists({ ...p.lists, [name]: exportList(name, p.defaultKind, p.rules, p.cats) });
    setMsg({ ok: true, text: `Saved “${name}” — ${p.rules.length} rule${p.rules.length === 1 ? "" : "s"}.` });
  };

  const deleteList = async (name: string) => {
    if (!(await ask({ title: `Delete “${name}”?`, detail: "The rules on screen are untouched.", confirmLabel: "Delete", danger: true }))) return;
    const next = { ...p.lists };
    delete next[name];
    p.onLists(next);
    setMsg({ ok: true, text: `Deleted “${name}”.` });
  };

  // A file, because the point of a saved list is to use it on a playthrough this browser has never seen.
  const download = () => {
    const name = listName.trim() || "sell-rules";
    const file = exportList(name, p.defaultKind, p.rules, p.cats);
    const url = URL.createObjectURL(new Blob([JSON.stringify(file, null, 2)], { type: "application/json" }));
    const a = document.createElement("a");
    a.href = url;
    a.download = `${name.replace(/[^\w.-]+/g, "-")}.sellrules.json`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const upload = async (f: File | null | undefined) => {
    if (!f) return;
    let data: unknown;
    try { data = JSON.parse(await f.text()); } catch { setMsg({ ok: false, text: `${f.name} is not JSON.` }); return; }
    const { list, error } = parseList(data);
    if (!list) { setMsg({ ok: false, text: `${f.name}: ${error}` }); return; }
    await applyList(list, "Imported");
  };

  const setStance = (k: Kind) => {
    // Every exception just changed kind, so the end of the ranking it reaches for changed with it.
    const flipped = p.rules.map((r) => ({ ...r, order: { ...r.order, dir: defaultDir(otherKind(k), r.take?.mode ?? "except") } }));
    if (draft) setDraft({ ...draft, order: { ...draft.order, dir: defaultDir(otherKind(k), draft.take?.mode ?? "except") } });
    commit(flipped, k);
  };

  const sellNow = async () => {
    if (!rows.length) return;
    setBusy(true); setMsg(null);
    try {
      if (!(await ask({
        title: `Sell ${rows.length} item${rows.length === 1 ? "" : "s"} for ${fmt(counts.cr)} cr?`,
        detail: "Each row is re-checked as it sells; anything that moved is skipped. A long list takes a few "
          + "seconds and says so in game while it works.",
        confirmLabel: "Sell", danger: true,
      }))) return;
      const out = await sellRows(p.conn, sellableRows(rows));
      setMsg({ ok: out.ok, text: out.text });
      p.onSold();
    } finally { setBusy(false); }
  };

  return (
    <Modal open={p.open} onClose={p.onClose} label="Sell list" className="sell-pop">
      <>
        {confirmUi}
        <div className="cfg-head">
          <b>Sell list</b>
          <span className="spacer" />
          <span className="sl-strip">
            <b className={counts.sell ? "k-sell" : "dim"}>{fmt(counts.sell)}</b> to sell
            <span className="sl-cr">{fmt(counts.cr)} cr</span>
            <span className="dim">· {fmt(counts.keep)} kept · {fmt(counts.cant)} can’t
              {counts.back > 0 && ` · ${fmt(counts.back)} struck off`}</span>
          </span>
          <button className="popin-x" title="close (Esc)" onClick={p.onClose}>×</button>
        </div>

        {/* A sale is not a confirmation that stops being true — it is the record of money moving, and it must
            still be on screen when the player looks back at the tab. Dismissed by hand, never by a timer. */}
        <Notice msg={msg} onClose={() => setMsg(null)} holdMs={0} />

        {/* While a rule is being written the EDITOR is the work and the review list is not: it takes the room
            it needs and the body scrolls, rather than the editor scrolling inside a box of its own. */}
        <div className={"sl-body" + (draft ? " editing" : "")}>
          {/* Saved lists. A list outlives the playthrough it was written on, which is the whole point of one. */}
          <div className="sl-lists">
            <span className="dim">list</span>
            <input value={listName} placeholder="name this list…" onChange={(e) => setListName(e.target.value)} />
            <button className="mini" disabled={!listName.trim() || !p.rules.length} onClick={saveList}
                    title={p.rules.length ? "save the rules on screen under this name" : "no rules to save"}>save</button>
            {Object.keys(p.lists).sort().map((name) => (
              <span key={name} className={"sl-tag" + (name === listName.trim() ? " on" : "")}>
                <button className="tagname" title={`load “${name}” — ${p.lists[name].rules.length} rules`}
                        onClick={() => applyList(p.lists[name], "Loaded")}>{name}</button>
                <button title="delete" onClick={() => deleteList(name)}>×</button>
              </span>
            ))}
            <span className="spacer" />
            <button className="mini" disabled={!p.rules.length} onClick={download} title="save to a file you can carry to another playthrough">export</button>
            <label className="mini sl-imp" title="load a list from a file">import
              <input type="file" accept=".json,application/json" onChange={(e) => { void upload(e.target.files?.[0]); e.target.value = ""; }} />
            </label>
          </div>

          <div className="sl-sides">
            {(["keep", "sell"] as Kind[]).map((side) => (
              <div key={side} className={`card sl-side ${side}`}>
                <div className="sl-side-h">{side === "keep" ? "Keep" : "Sell"}
                  <span className="n">{p.defaultKind === side ? "default" : `${p.rules.length} rule${p.rules.length === 1 ? "" : "s"}`}</span>
                </div>
                {p.defaultKind === side ? (
                  <div className="sl-def">
                    <select value={p.defaultKind} onChange={(e) => setStance(e.target.value as Kind)} className={"k-" + p.defaultKind}>
                      <option value="keep">Keep</option>
                      <option value="sell">Sell</option>
                    </select>
                    <span className="dim">everything else</span>
                  </div>
                ) : (
                  <>
                    {!p.rules.length && <div className="sl-empty">No exceptions yet.</div>}
                    {p.rules.map((rule, idx) => (
                      <div key={rule.id}>
                        {idx > 0 && <div className="sl-or">OR</div>}
                        <RuleRow
                          editing={draft?.id === rule.id}
                          rule={rule} kind={other} items={p.items} ctx={ctx}
                          onCopy={() => setDraft({ ...structuredClone(rule), id: seq() })}
                          // The rule STAYS in the set while it is edited. Taking it out was a trap with money
                          // attached: the draft says "not applied yet", the rule row is gone, and a sale run in
                          // that state silently ignores a rule the player believes is theirs. `addDraft`
                          // replaces it by id when the edit is committed; `discard` leaves the original alone.
                          onEdit={() => setDraft(structuredClone(rule))}
                        />
                      </div>
                    ))}
                    {!draft && (
                      <button className="sl-addrule" onClick={() => setDraft(newRule(other, seq()))}>
                        ＋ add {other} rule
                      </button>
                    )}
                  </>
                )}
              </div>
            ))}
          </div>

          {draft && (
            <div className="card sl-editor">
              {/* A draft changes NOTHING until it is added, and the split below it updates as though it had —
                  which reads as the rule working while the sale ignores it. The head says so and carries the
                  same control the foot does, because the split can be thousands of rows long and the foot is
                  then off screen. */}
              <div className="cfg-head">
                <b className="eyebrow">editing</b>
                <span className="dim">{other} · not applied yet</span>
                <span className="spacer" />
                <button className="apply" onClick={addDraft}>Add rule</button>
              </div>
              <Editor
                draft={draft} setDraft={setDraft} kind={other} items={p.items} ctx={ctx}
                openPop={openPop} setOpenPop={setOpenPop}
                defaultKind={p.defaultKind}
                view={p.view} setView={p.onView}
                openGroups={openGroups} setOpenGroups={setOpenGroups}
                splitQ={splitQ} setSplitQ={setSplitQ}
                showTip={showTip} hideTip={hideTip}
              />
              <div className="sl-foot">
                <span className="dim">{fmt(runRule(draft, p.items, ctx).size)} matched</span>
                <span className="spacer" />
                <button className="mini" onClick={() => setDraft(null)}>discard</button>
                <button className="apply" onClick={addDraft}>Add rule</button>
              </div>
            </div>
          )}

          {/* The last step: the rules propose, the player decides. Nothing sells that is not ticked here. */}
          {!!proposed.length && (
            <div className="card sl-review">
              <div className="cfg-head">
                <b className="eyebrow">to sell</b>
                <span className="dim">{fmt(counts.sell)} of {fmt(proposed.length)} selling · <span className="sl-cr">{fmt(counts.cr)} cr</span></span>
                <span className="spacer" />
                <button className="mini" title="sell every row the rules proposed"
                        onClick={() => setHeld(new Set())}>sell all</button>
                <button className="mini" title="keep every row — nothing sells until you pick some again"
                        onClick={() => setHeld(new Set(proposed.map(idOf)))}>sell none</button>
                <input className="sl-rq" value={reviewQ} placeholder="search…" onChange={(e) => setReviewQ(e.target.value)} />
              </div>
              {/* The sell list's own vocabulary: `FIELDS` keys, narrowed to what tells THESE rows apart — which is
                  what keeps `price` and `copies owned` (constant over an armory) out of the picker without the bar
 knowing they are shop-floor fields. */}
              <ViewBar view={p.view} setView={p.onView} label={fieldLabel}
                       fields={viewFields().filter((k) => k !== NAME_COL
                         && (p.view.cols.includes(k) || fieldVaries(proposed, k, ctx)))}
                       groupable={GROUP_FIELDS.filter((k) => fieldVaries(proposed, k, ctx))} />
              {!!p.view.group.length && (
                <div className="sl-bar">
                  <button className="mini" onClick={() => setOpenReview(new Set())}>fold all</button>
                  <button className="mini" onClick={() => setOpenReview(new Set(allKeys(reviewTree)))}>unfold all</button>
                  <span className="dim sl-opt">
                    {fmt(reviewTree.length)} group{reviewTree.length === 1 ? "" : "s"} · {fmt(reviewMatches.length)} rows
                  </span>
                </div>
              )}
              {/* The rows are the only thing that scrolls (see sellList.css), so this IS the scroll container —
                  and what the ungrouped grid windows its rows against. */}
              <div className="sl-rlist" ref={reviewRef}>
                {!p.view.group.length && (
                  <RowGrid rows={sortRows(reviewMatches, p.view.sort, ctx)} cols={reviewCols} ctx={ctx}
                           sort={p.view.sort} onSort={(sort) => p.onView({ ...p.view, sort })} scroll={reviewRef}
                           lead={{ head: <th />, cell: (r) => tickCell(r.it) }}
                           rowClass={(r) => (held.has(idOf(r.it)) ? "sl-off" : "")}
                           onRowClick={(r) => tick(r.it)} showTip={showTip} hideTip={hideTip} />
                )}
                {!!p.view.group.length && (
                  <ReviewNodes nodes={reviewTree} ctx={ctx} view={p.view} setView={p.onView} cols={reviewCols}
                               open={openReview} setOpen={setOpenReview} ql={reviewQl}
                               held={held} setHeld={setHeld} tick={tick} tickCell={tickCell}
                               showTip={showTip} hideTip={hideTip} />
                )}
              </div>
            </div>
          )}
        </div>

        <div className="cfg-actions">
          <span className="dim">{fmt(counts.sell)} selected · <b>{fmt(counts.cr)} cr</b></span>
          <span className="spacer" />
          {!p.docked && <span className="dim">dock to sell</span>}
          <button className="danger" disabled={busy || !counts.sell || !p.docked} onClick={sellNow}>
            {busy ? "Selling…" : `Sell ${fmt(counts.sell)}`}
          </button>
        </div>
        {hover && <ItemTip it={hover.it} x={hover.x} y={hover.y} conn={p.conn} imgUrl={itemIcon(p.conn, hover.it)} />}
      </>
    </Modal>
  );
}

/* ---- one saved rule, as prose -------------------------------------------------------------------
 *
 * PROSE ONLY. The per-rule split is the EDITOR's evidence — "did that clause say what I meant" — so it is
 * drawn while the rule is being written and nowhere else: a saved rule's own rows are not the review, and the
 * list that decides what sells is the one at the foot.
 */
function RuleRow(q: {
  rule: Rule; kind: Kind; items: Item[]; ctx: FieldCtx;
  onCopy: () => void; onEdit: () => void;
  /** This rule is open in the editor. It still APPLIES — what is on screen below is not in effect yet. */
  editing?: boolean;
}) {
  const n = runRule(q.rule, q.items, q.ctx).size;
  return (
    <div className={"sl-rule" + (q.editing ? " editing" : "")}>
      <div className="sl-rhead" onClick={q.onEdit} title="edit this rule">
        <div className="sl-sent">
          {clauses(q.rule, q.kind, q.items).map((c, i) => (
            <div key={i} className="sl-cl">
              <span className={i === 0 ? "lead0" : "lead"}>{c.lead} </span>
              <span className="cw">{c.text}</span>
            </div>
          ))}
        </div>
        <div className={"sl-count k-" + q.kind}>{fmt(n)}</div>
        <button className="mini" title="duplicate into the editor" onClick={(e) => { e.stopPropagation(); q.onCopy(); }}>copy</button>
        <button className="mini" title="pull into the editor" onClick={(e) => { e.stopPropagation(); q.onEdit(); }}>edit</button>
      </div>
    </div>
  );
}

/* ---- the live split: what the rule takes, what the count leaves, and what the DEFAULT takes ------
 *
 * Every row a rule touches is on screen, including the ones no clause selected. Those are the rows the
 * default disposes of, and they are the ones with no rule to explain them: a rule's own rows sit under the
 * clauses that claimed them, while "not selected" is a verdict nothing on screen accounts for unless the row
 * says which clause turned it away.
 *
 * This is the EDITOR's evidence, ⊥ the player's grid: it nests by the rule's own GROUP BY, keeps the rule's
 * ORDER BY (so the count's cut line points at something) and draws a fixed set of columns. Grouping, sorting
 * and columns are the REVIEW list's, at the foot — a rule preview that can be re-sorted invites reading the
 * result of one rule as the decision, which is the whole list's job.
 */
function Split(q: {
  rule: Rule; kind: Kind; items: Item[]; ctx: FieldCtx; defaultKind: Kind;
  view: ViewState; setView: (v: ViewState) => void;
  openGroups: Set<string>; setOpenGroups: (f: (s: Set<string>) => Set<string>) => void;
  splitQ: string; setSplitQ: (s: string) => void;
  showTip: (t: { it: Item; x: number; y: number }) => void; hideTip: () => void;
}) {
  const ex = useMemo(() => explain(q.rule, q.items, q.ctx), [q.rule, q.items, q.ctx]);
  const inKind = q.kind, outKind = q.defaultKind;
  const ql = q.splitQ.trim().toLowerCase();
  const gf = q.rule.group;
  const rows = useMemo(() => viewRows(ex), [ex]);
  // Rows the player has left visible, then the search. Searching matches the name or any of the group labels
  // the row sits under, so a term that names a group finds the whole group rather than nothing.
  const visible = useMemo(() => {
    const hidden = new Set(q.view.hide);
    return rows.filter((r) => !hidden.has(r.bucket)
      && (!ql || (r.it.name ?? "").toLowerCase().includes(ql)
        || gf.some((k) => cellText(r.it, k, q.ctx).toLowerCase().includes(ql))));
  }, [rows, q.view.hide, ql, gf, q.ctx]);
  // The rule's own order inside each group: the cut line the count leaves means nothing against any other.
  const tree = useMemo(() => viewTree(visible, gf, [], q.ctx), [visible, gf, q.ctx]);

  const nOf = (b: Bucket) => rows.filter((r) => r.bucket === b).length;
  const crOf = (b: Bucket) => rows.filter((r) => r.bucket === b)
    .reduce((n, r) => n + Math.max(1, r.it.count ?? 1) * (r.it.sellValue ?? 0), 0);
  const nIn = nOf("in"), nOut = nOf("out"), nEx = nOf("excluded");
  const prot = ex.protected;
  const toggleBucket = (b: Bucket) =>
    q.setView({ ...q.view, hide: q.view.hide.includes(b) ? q.view.hide.filter((x) => x !== b) : [...q.view.hide, b] });
  const box = (b: Bucket, n: number, kind: Kind, title: string) => (
    <button className={"sl-sh-box k-" + kind + (q.view.hide.includes(b) ? " off" : "")}
            title={title + (q.view.hide.includes(b) ? " (hidden — click to show)" : " (click to hide)")}
            onClick={() => toggleBucket(b)}>
      <b>{fmt(n)}</b> {kind.toUpperCase()}{kind === "sell" && <span className="sl-cr"> {fmt(crOf(b))} cr</span>}
    </button>
  );

  return (
    <div className="sl-split">
      <div className="sl-sh">
        <div className="sl-sh-in">{fmt(nIn + nOut)} come in</div>
        <div className="dim">→</div>
        {box("in", nIn, inKind, "Matched by this rule.")}
        {box("out", nOut, outKind, "Matched the filter, but the count left them out.")}
        <div className="dim">·</div>
        {box("excluded", nEx, outKind, "No clause selected them, so the default decides.")}
      </div>
      <div className="sl-note">
        {fmt(nEx)} not selected → {q.defaultKind.toUpperCase()} — listed below, each with the clause that turned it away
        {prot.length > 0 && (
          <span title={prot.map((it) => `${it.name} (${cantSell(it)})`).join("\n")}>
            {"  ·  "}{fmt(prot.length)} protected — never sold
          </span>
        )}
      </div>

      <div className="sl-note dim">
        grouped as this rule counts it{gf.length ? ` (${gf.map(fieldLabel).join(" › ")})` : ", as one pool"}
      </div>

      <div className="sl-bar">
        <button className="mini" onClick={() => q.setOpenGroups(() => new Set())}>fold all</button>
        <button className="mini" onClick={() => q.setOpenGroups(() => new Set(allKeys(tree)))}>unfold all</button>
        <input value={q.splitQ} placeholder="search item or group…" onChange={(e) => q.setSplitQ(e.target.value)} />
        {!!ql && <button className="mini" onClick={() => q.setSplitQ("")}>clear</button>}
      </div>

      <div className="sl-groups">
        {!gf.length && <Leaf node={{ key: "all", label: "", depth: 0, kids: [], rows: visible, held: 0, nIn: 0, nOut: 0, nExcluded: 0, credits: 0 }}
                             {...q} inKind={inKind} outKind={outKind} bare />}
        {!!gf.length && <Nodes nodes={tree} {...q} inKind={inKind} outKind={outKind} ql={ql} />}
      </div>
      <div className="sl-note">{fmt(tree.length)} group{tree.length === 1 ? "" : "s"} · {fmt(visible.length)} rows shown</div>
    </div>
  );
}

const allKeys = (nodes: ViewNode[]): string[] => nodes.flatMap((n) => [n.key, ...allKeys(n.kids)]);

/* ---- the split's tree, nested by the rule's own GROUP BY ------------------------------------------ */
function Nodes(p: {
  nodes: ViewNode[]; ctx: FieldCtx; ql: string;
  openGroups: Set<string>; setOpenGroups: (f: (s: Set<string>) => Set<string>) => void;
  inKind: Kind; outKind: Kind;
  showTip: (t: { it: Item; x: number; y: number }) => void; hideTip: () => void;
}) {
  return (
    <>
      {p.nodes.map((n) => {
        const open = p.ql ? true : p.openGroups.has(n.key);
        return (
          <div key={n.key} className="sl-branch">
            <div className="sl-group" style={{ paddingLeft: n.depth * 12 }}
                 onClick={() => !p.ql && p.setOpenGroups((s) => { const x = new Set(s); x.has(n.key) ? x.delete(n.key) : x.add(n.key); return x; })}>
              {open ? "▾ " : "▸ "}<b>{n.label}</b>{"  "}
              <span className="dim">
                {n.held} held → {n.nIn} {p.inKind.toUpperCase()}, {n.nOut} {p.outKind.toUpperCase()}
                {n.nExcluded > 0 && `, ${n.nExcluded} not selected`}
              </span>
            </div>
            {open && !!n.kids.length && <Nodes {...p} nodes={n.kids} />}
            {open && !n.kids.length && <Leaf {...p} node={n} />}
          </div>
        );
      })}
    </>
  );
}

/* ---- one group's rows, as the columns the player asked for --------------------------------------
 *
 * The rows are revealed in pages rather than capped: sorting and grouping run over the WHOLE set, and what is
 * on screen is only what has been drawn so far — an armory sized by the playthrough would otherwise cost
 * minutes of layout, and a hard cap would hide the very rows this view exists to show.
 */
const PAGE = 100;

/**
 * ONE table, for the split's rows AND the review list's. Each caller supplies what its own leading cell is (a
 * verdict chip; a tick box), what it puts after the columns, and whether the headers SORT — two copies of this
 * is how the two lists would come to disagree about what a column shows or what a value is worth.
 */
function RowGrid(p: {
  rows: ViewRow[]; cols: string[]; ctx: FieldCtx;
  /** Present only where a view bar owns the order: the split's rows keep the rule's own ORDER BY. */
  sort?: SortKey[]; onSort?: (next: SortKey[]) => void;
  lead: { head: ReactNode; cell: (r: ViewRow) => ReactNode };
  trail?: { head: ReactNode; cell: (r: ViewRow) => ReactNode };
  rowClass?: (r: ViewRow) => string;
  onRowClick?: (r: ViewRow) => void;
  /** Where a boundary line is drawn between two rows — the count's cut, on the list that has one. */
  cutAt?: (prev: ViewRow, r: ViewRow) => boolean;
  /**
   * The element that scrolls, when this grid is the ONLY table inside it. Its rows are then WINDOWED — the
   * whole list stays scrollable and only the visible slice is in the DOM, which is what lets a 10,000-row
 * armory be read by scrolling.
   *
   * A TREE of grids cannot window: each leaf would need its own slice of one scroller, and the slices move as
   * groups fold. Those page instead, which is bounded by the number of groups the player has opened.
   */
  scroll?: RefObject<HTMLElement | null>;
  /** How many rows are drawn before `show more`, where paging is what happens (no `scroll`). */
  page?: number;
  className?: string; style?: CSSProperties;
  showTip: (t: { it: Item; x: number; y: number }) => void; hideTip: () => void;
}) {
  const [shown, setShown] = useState(p.page ?? PAGE);
  const { rows, cols } = p;
  const span = 2 + cols.length + (p.trail ? 1 : 0);
  // Windowing needs a scroller; without one the hook sits idle (it recomputes nothing and its range goes
  // unread) rather than being called conditionally, which no hook may be.
  const idle = useRef<HTMLElement | null>(null);
  const win = useWindowed(rows.length, { scroll: p.scroll ?? idle, rowH: 19 });
  const windowed = !!p.scroll;
  const from = windowed ? win.start : 0;
  const drawn = windowed ? rows.slice(win.start, win.end) : rows.slice(0, shown);
  const sortDir = (k: string) => p.sort?.find((s) => s.k === k)?.dir;
  const onSort = p.onSort;
  const head = (k: string, label: string, num?: boolean) => (
    <th key={k} className={num ? "num" : undefined}
        title={onSort ? "click to sort · shift-click to add a second key" : undefined}
        style={onSort ? undefined : { cursor: "default" }}
        onClick={onSort ? (e) => onSort(toggleSort(p.sort ?? [], k, e.shiftKey)) : undefined}>
      {label}{sortDir(k) === "asc" ? " ▲" : sortDir(k) === "desc" ? " ▼" : ""}
    </th>
  );

  return (
    <div className={p.className} style={p.style}>
      <table className="sl-grid">
        <thead>
          <tr>
            {p.lead.head}
            {head(NAME_COL, "Item")}
            {cols.map((k) => head(k, fieldLabel(k), FIELDS[k]?.kind === "range"))}
            {p.trail?.head}
          </tr>
        </thead>
        <tbody>
          {/* The cell carries the height: a cell-less `<tr>` collapses to zero and the scroller's own
              scrollHeight then covers only the drawn slice. */}
          {windowed && win.padTop > 0 && (
            <tr aria-hidden="true"><td colSpan={span} style={{ height: win.padTop, padding: 0, border: 0 }} /></tr>
          )}
          {drawn.map((r, i) => {
            const prev = from + i > 0 ? rows[from + i - 1] : null;
            const cut = !!prev && !!p.cutAt?.(prev, r);
            return (
              <Fragment key={`${r.it.location ?? ""}#${r.it.key ?? i}`}>
                {cut && <tr className="sl-cut"><td colSpan={span}>— the count falls here —</td></tr>}
                <tr className={p.rowClass?.(r) ?? ""} ref={i === 0 ? win.measureRef : undefined}
                    onClick={p.onRowClick ? () => p.onRowClick?.(r) : undefined}
                    onMouseEnter={(e) => p.showTip({ it: r.it, x: e.clientX, y: e.clientY })}
                    onMouseLeave={p.hideTip}>
                  {p.lead.cell(r)}
                  <td className="nm" style={{ color: RARITY_COLOR[r.it.rarity] }}>
                    {r.it.name}{(r.it.count ?? 1) > 1 ? `  ×${r.it.count}` : ""}
                  </td>
                  {cols.map((k) => (
                    <td key={k} className={FIELDS[k]?.kind === "range" ? "num" : undefined}
                        style={k === "r" ? { color: RARITY_COLOR[r.it.rarity] } : undefined}>
                      {k === "v" ? fmt(Math.max(1, r.it.count ?? 1) * (r.it.sellValue ?? 0)) : cellText(r.it, k, p.ctx)}
                    </td>
                  ))}
                  {p.trail?.cell(r)}
                </tr>
              </Fragment>
            );
          })}
          {windowed && win.padBottom > 0 && (
            <tr aria-hidden="true"><td colSpan={span} style={{ height: win.padBottom, padding: 0, border: 0 }} /></tr>
          )}
          {!windowed && rows.length > shown && (
            <tr className="sl-cut">
              <td colSpan={span}>
                showing {fmt(shown)} of {fmt(rows.length)} ·{" "}
                <button className="mini" onClick={() => setShown((n) => n + (p.page ?? PAGE) * 5)}>show more</button>
                {" "}
                <button className="mini" onClick={() => setShown(rows.length)}>show all</button>
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}

/** The split's rows: the verdict first, the clause that turned a row away last, the rule's own order kept. */
function Leaf(p: {
  node: ViewNode; ctx: FieldCtx; inKind: Kind; outKind: Kind; bare?: boolean;
  showTip: (t: { it: Item; x: number; y: number }) => void; hideTip: () => void;
}) {
  const rows = p.node.rows;
  const anyExcluded = rows.some((r) => r.bucket === "excluded");
  const fateOf = (r: ViewRow) => (r.bucket === "in" ? p.inKind : p.outKind);
  return (
    <RowGrid
      rows={rows} cols={DEFAULT_COLS} ctx={p.ctx}
      className={"sl-rows" + (p.bare ? " bare" : "")}
      style={{ paddingLeft: p.bare ? 0 : (p.node.depth + 1) * 12 }}
      lead={{
        head: <th />,
        cell: (r) => <td><span className={"sl-fate f-" + fateOf(r)}>{fateOf(r).toUpperCase()}</span></td>,
      }}
      trail={anyExcluded ? {
        head: <th>why not</th>,
        cell: (r) => (
          <td className="dim">
            {r.bucket === "excluded" ? (r.why ? `no match: ${fieldLabel(r.why)}` : "no clauses") : ""}
          </td>
        ),
      } : undefined}
      rowClass={(r) => "f-" + fateOf(r) + (r.bucket === "excluded" ? " b-ex" : "")}
      cutAt={(prev, r) => prev.bucket === "in" && r.bucket === "out"}
      showTip={p.showTip} hideTip={p.hideTip} />
  );
}

/** Every row under a node, however deep — a group's totals are about what it CONTAINS, not what it holds. */
const nodeRows = (n: ViewNode): ViewRow[] => (n.kids.length ? n.kids.flatMap(nodeRows) : n.rows);

/* ---- the review list's tree: the rows that will sell, grouped the way the player asked ------------
 *
 * A group here is something to ACT on, not only to read: the header carries what the group is worth and the
 * two controls that strike it off or put it back, since "sell none of the boosters" is one decision and
 * ticking 249 rows is not.
 */
function ReviewNodes(p: {
  nodes: ViewNode[]; ctx: FieldCtx; view: ViewState; setView: (v: ViewState) => void;
  /** The columns that say something about these rows — see `reviewCols`. */
  cols: string[];
  open: Set<string>; setOpen: (f: (s: Set<string>) => Set<string>) => void; ql: string;
  held: Set<string>; setHeld: (f: (s: Set<string>) => Set<string>) => void;
  tick: (it: Item) => void; tickCell: (it: Item) => ReactNode;
  showTip: (t: { it: Item; x: number; y: number }) => void; hideTip: () => void;
}) {
  return (
    <>
      {p.nodes.map((n) => {
        // A search shows what it found: folds are the player's reading of the whole list, not of a filtered one.
        const open = p.ql ? true : p.open.has(n.key);
        const rows = nodeRows(n);
        const on = rows.filter((r) => !p.held.has(idOf(r.it)));
        const cr = on.reduce((s, r) => s + Math.max(1, r.it.count ?? 1) * (r.it.sellValue ?? 0), 0);
        const setMany = (keep: boolean) => p.setHeld((s) => {
          const x = new Set(s);
          for (const r of rows) { const id = idOf(r.it); if (keep) x.delete(id); else x.add(id); }
          return x;
        });
        return (
          <div key={n.key} className="sl-branch">
            <div className="sl-group" style={{ paddingLeft: n.depth * 12 }}
                 onClick={() => !p.ql && p.setOpen((s) => {
                   const x = new Set(s);
                   if (x.has(n.key)) x.delete(n.key); else x.add(n.key);
                   return x;
                 })}>
              {open ? "▾ " : "▸ "}<b>{n.label}</b>{"  "}
              <span className="dim">
                {fmt(on.length)} of {fmt(rows.length)} selling · <span className="sl-cr">{fmt(cr)} cr</span>
              </span>
              <button className="mini" title="sell every row in this group"
                      onClick={(e) => { e.stopPropagation(); setMany(true); }}>sell all</button>
              <button className="mini" title="keep every row in this group — leave them out of this sale"
                      onClick={(e) => { e.stopPropagation(); setMany(false); }}>sell none</button>
            </div>
            {open && !!n.kids.length && <ReviewNodes {...p} nodes={n.kids} />}
            {open && !n.kids.length && (
              <RowGrid rows={n.rows} cols={p.cols} ctx={p.ctx}
                       sort={p.view.sort} onSort={(sort) => p.setView({ ...p.view, sort })}
                       className="sl-rows flow" style={{ paddingLeft: (n.depth + 1) * 12 }}
                       lead={{ head: <th />, cell: (r) => p.tickCell(r.it) }}
                       rowClass={(r) => (p.held.has(idOf(r.it)) ? "sl-off" : "")}
                       onRowClick={(r) => p.tick(r.it)}
                       showTip={p.showTip} hideTip={p.hideTip} />
            )}
          </div>
        );
      })}
    </>
  );
}

/* ---- the editor: the sentence, with its variable parts editable in place ------------------------ */
function Editor(q: {
  draft: Rule; setDraft: (r: Rule) => void; kind: Kind; items: Item[]; ctx: FieldCtx; defaultKind: Kind;
  view: ViewState; setView: (v: ViewState) => void;
  openPop: string | null; setOpenPop: (s: string | null) => void;
  openGroups: Set<string>; setOpenGroups: (f: (s: Set<string>) => Set<string>) => void;
  splitQ: string; setSplitQ: (s: string) => void;
  showTip: (t: { it: Item; x: number; y: number }) => void; hideTip: () => void;
}) {
  const d = q.draft;
  // A filter or grouping edit can retire the ranking measure (power means nothing across mixed units), so the
  // patch repairs it before it lands. Correcting it while RENDERING instead updates the parent from this
  // component's render pass — React drops such an update from the tree it is already rendering.
  const put = (patch: Partial<Rule>) => {
    const next = { ...d, ...patch };
    const opts = orderOptions(next, q.items, q.ctx);
    if (opts.length && !opts.some(([k]) => k === next.order.f)) next.order = { ...next.order, f: opts[0][0] };
    q.setDraft(next);
  };
  const entries = Object.entries(d.where);
  const pins = pinsUnit(d);
  const orders = orderOptions(d, q.items, q.ctx);
  // A rule pulled in from storage may name a measure this inventory no longer supports. Keep it selectable
  // and marked, rather than silently showing the first option while the rule still ranks by the old one.
  const measureGone = !!orders.length && !orders.some(([k]) => k === d.order.f);

  // A rule with no clauses yet says "everything I own", which is both true and useless: it is the state the
  // editor OPENS in, and nothing on screen said which of the three buttons starts the work. So the untouched
  // draft names its own problem and points at the one control that solves it.
  const untouched = !entries.length && !d.take && !d.having;

  return (
    <div className={"sl-sent-ed" + (untouched ? " fresh" : "")}>
      {untouched && (
        <p className="sl-startline">
          This matches <b>everything you own</b>. Start with <b>narrow it down</b> to say what should go —
          a type, a level, a quality. The split below updates as you do.
        </p>
      )}
      {/* the subject */}
      <div className="sl-line first">
        <span className="lead">{q.kind === "keep" ? "Keep" : "Sell"}</span>
        <span className="sl-chips">
          {!entries.length && <span className="dim">everything I own</span>}
          {!!entries.length && <span className="dim">everything</span>}
          <WhereChips where={d.where} onChange={(where) => put({ where })}
                      items={q.items} ctx={q.ctx} openPop={q.openPop} setOpenPop={q.setOpenPop} />
        </span>
      </div>

      {/* the count */}
      {d.take && (
        <>
          <div className="sl-line">
            <select className="lead" value={d.take.mode}
                    onChange={(e) => {
                      const mode = e.target.value as "only" | "except";
                      put({ take: { ...d.take!, mode }, order: { ...d.order, dir: defaultDir(q.kind, mode) } });
                    }}>
              <option value="except">except</option>
              <option value="only">but only</option>
            </select>
            <span className="dim">the</span>
            <NumBox value={d.take.n} onCommit={(n) => put({ take: { ...d.take!, n: Math.max(0, n) } })} />
            <span className="dim">with the</span>
            <select value={d.order.dir} onChange={(e) => put({ order: { ...d.order, dir: e.target.value as "asc" | "desc" } })}>
              <option value="asc">lowest</option>
              <option value="desc">highest</option>
            </select>
            <select value={d.order.f} onChange={(e) => put({ order: { ...d.order, f: e.target.value } })}>
              {measureGone && <option value={d.order.f}>⚠ {ORDERS[d.order.f]?.label ?? d.order.f}</option>}
              {orders.map(([k, o]) => <option key={k} value={k}>{o.label}</option>)}
            </select>
            {!pins && <span className="dim sl-opt">(power needs one unit)</span>}
            <button className="mini sl-drop" title="drop this clause" onClick={() => put({ take: null })}>×</button>
          </div>
          <div className="sl-line">
            <span className="lead">counting</span>
            <span className="sl-chips">
              {!d.group.length && <span className="dim">everything as one pool</span>}
              {d.group.map((k, gi) => (
                <span key={k} className="sl-chip grp">
                  <span className="cw">each {FIELDS[k]?.label ?? k}</span>
                  <button onClick={() => put({ group: d.group.filter((_, i) => i !== gi) })}>×</button>
                </span>
              ))}
              {!!d.group.length && <span className="dim">separately</span>}
              <GroupPicker {...q} />
            </span>
          </div>
        </>
      )}

      {/* the group condition */}
      {d.having && (
        <div className="sl-line">
          <span className="lead">and only where</span>
          <span className="dim">I hold</span>
          <select value={d.having.op} onChange={(e) => put({ having: { ...d.having!, op: e.target.value as "gt" | "lt" } })}>
            <option value="gt">more than</option>
            <option value="lt">fewer than</option>
          </select>
          <NumBox value={d.having.n} onCommit={(n) => put({ having: { ...d.having!, n: Math.max(0, n) } })} />
          <span className="dim">{d.take && d.group.length ? "of that group" : "in total"}</span>
          <button className="mini sl-drop" title="drop this clause" onClick={() => put({ having: null })}>×</button>
        </div>
      )}

      {/* clauses not in use — one obvious home each, which a nested tree never had */}
      <div className="sl-adders">
        {!d.take && <button className="sl-add" onClick={() => put({ take: { mode: "except", n: 4 }, order: { ...d.order, dir: defaultDir(q.kind, "except") } })}>＋ except some of them</button>}
        {!d.having && <button className="sl-add" onClick={() => put({ having: { op: "gt", n: 5 } })}>＋ only when I hold enough</button>}
      </div>

      <Split rule={d} kind={q.kind} items={q.items} ctx={q.ctx} defaultKind={q.defaultKind}
             view={q.view} setView={q.setView}
             openGroups={q.openGroups} setOpenGroups={q.setOpenGroups}
             splitQ={q.splitQ} setSplitQ={q.setSplitQ} showTip={q.showTip} hideTip={q.hideTip} />
    </div>
  );
}

function GroupPicker(q: Parameters<typeof Editor>[0]) {
  const d = q.draft;
  const isOpen = q.openPop === "group";
  const { trigger, at } = usePopAnchor(isOpen, 220);
  const avail = GROUP_FIELDS.filter((k) => !d.group.includes(k));
  if (!avail.length) return null;
  return (
    <span className="sl-popwrap">
      <button ref={trigger} className={"sl-add" + (isOpen ? " on" : "")}
              onClick={(e) => { e.stopPropagation(); q.setOpenPop(isOpen ? null : "group"); }}>＋ and each…</button>
      {isOpen && (
        <div className="sl-pop narrow" style={at} onClick={(e) => e.stopPropagation()}>
          <div className="sl-vlist">
            {avail.map((k) => (
              <button key={k} className="sl-val"
                      onClick={() => { q.setDraft({ ...d, group: [...d.group, k] }); q.setOpenPop(null); }}>
                each {FIELDS[k].label}
              </button>
            ))}
          </div>
        </div>
      )}
    </span>
  );
}
