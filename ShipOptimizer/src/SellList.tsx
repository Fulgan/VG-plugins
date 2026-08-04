// The sell list. Renders `sellRules` and decides nothing itself — the rails-vs-tab disagreement came from two surfaces answering one question, and this is the surface that spends money.
//
// Layout: KEEP and SELL as two columns, so the constraint (one default, all exceptions on
// the other side) is visible rather than explained. The default side holds one card; the other holds the
// rules, an OR between each, and a full-width add button under the last one.
import { Fragment, useMemo, useState } from "react";
import { api, ApiError, itemIcon, type Conn } from "./api";
import { Modal, useConfirm } from "./Modal";
import { RARITY_COLOR } from "./format";
import { ItemTip } from "./ItemCard";
import { useHoverIntent } from "./useCursorTip";
import type { Item } from "./types";
import "./sellList.css";
import {
  FIELDS, GROUP_FIELDS, ORDERS, RARITY_ORDER, cantSell, clauses, defaultDir, evaluate, explain,
  exportList, listProblems, mergeCats, newRule, orderOptions, otherKind, parseList, pinsUnit, runRule, typeOf,
  type Cats, type FieldCtx, type Kind, type RangeCond, type Rule, type SellListFile, type SetCond,
} from "./sellRules";

const OPS: [string, string][] = [["lt", "<"], ["lte", "≤"], ["eq", "="], ["gte", "≥"], ["gt", ">"]];
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
}

export default function SellList(p: SellListProps) {
  const [draft, setDraft] = useState<Rule | null>(null);
  const [openPop, setOpenPop] = useState<string | null>(null);
  const [pickField, setPickField] = useState<string>("l");
  const [pickOp, setPickOp] = useState("lte");
  const [pickNum, setPickNum] = useState("");
  const [pickQ, setPickQ] = useState("");
  const [splitQ, setSplitQ] = useState("");
  const [reviewQ, setReviewQ] = useState("");
  const [listName, setListName] = useState("");
  // Items the player struck off this sale by hand. Keyed by SLOT within its store, so a de-selection cannot
  // wander onto a different item; kept for the session only, because it answers "not this one, now".
  const [held, setHeld] = useState<Set<string>>(new Set());
  const [openGroups, setOpenGroups] = useState<Set<string>>(new Set());
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const { ask, ui: confirmUi } = useConfirm();
  const { target: hover, show: showTip, hide: hideTip } = useHoverIntent<{ it: Item; x: number; y: number }>();

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
  const counts = useMemo(() => {
    let keep = 0, cant = 0;
    // Counts are per ITEM (a row you act on); only credits multiply by the stack.
    for (const v of verdicts) if (v === "cant") cant++; else if (v !== "sell") keep++;
    return {
      keep, cant, sell: rows.length, back: proposed.length - rows.length,
      cr: rows.reduce((n, it) => n + Math.max(1, it.count ?? 1) * (it.sellValue ?? 0), 0),
    };
  }, [verdicts, proposed, rows]);

  const commit = (rules: Rule[], defaultKind: Kind = p.defaultKind) => p.onChange({ defaultKind, rules });

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
        detail: "Each row is re-checked as it sells; anything that moved is skipped.",
        confirmLabel: "Sell", danger: true,
      }))) return;
      let sold = 0, earned = 0;
      const failed: string[] = [];
      for (const it of rows) {
        if (it.key == null || !it.location) continue;
        try {
          // `expectName` every time: the list was built before the press, so each handle is already stale.
          const r = await api.sell(p.conn, it.location, it.key, Math.max(1, it.count ?? 1), it.name);
          sold += r.sold; earned += r.credits;
        } catch (e) {
          failed.push(`${it.name}: ${e instanceof ApiError ? e.message : String(e)}`);
        }
      }
      setMsg({
        ok: !failed.length,
        text: `Sold ${sold} for ${fmt(earned)} cr.` + (failed.length ? ` ${failed.length} skipped — ${failed.slice(0, 2).join("; ")}` : ""),
      });
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

        {msg && <div className={msg.ok ? "sum-msg ok" : "sum-msg err"}>{msg.ok ? "✓" : "⚠"} {msg.text}</div>}

        <div className="sl-body">
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
                          rule={rule} kind={other} items={p.items} ctx={ctx}
                          open={expanded.has(rule.id)}
                          onToggle={() => setExpanded((s) => { const n = new Set(s); n.has(rule.id) ? n.delete(rule.id) : n.add(rule.id); return n; })}
                          onCopy={() => setDraft({ ...structuredClone(rule), id: seq() })}
                          onEdit={() => { setDraft(structuredClone(rule)); commit(p.rules.filter((r) => r.id !== rule.id)); }}
                          defaultKind={p.defaultKind}
                          openGroups={openGroups} setOpenGroups={setOpenGroups}
                          splitQ={splitQ} setSplitQ={setSplitQ}
                          showTip={showTip} hideTip={hideTip}
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
              <div className="cfg-head"><b className="eyebrow">editing</b><span className="spacer" /><span className="dim">{other}</span></div>
              <Editor
                draft={draft} setDraft={setDraft} kind={other} items={p.items} ctx={ctx}
                openPop={openPop} setOpenPop={setOpenPop}
                pickField={pickField} setPickField={setPickField}
                pickOp={pickOp} setPickOp={setPickOp} pickNum={pickNum} setPickNum={setPickNum}
                pickQ={pickQ} setPickQ={setPickQ}
                defaultKind={p.defaultKind}
                openGroups={openGroups} setOpenGroups={setOpenGroups}
                splitQ={splitQ} setSplitQ={setSplitQ}
                showTip={showTip} hideTip={hideTip}
              />
              <div className="sl-foot">
                <span className="dim">{fmt(runRule(draft, p.items, ctx).size)} matched</span>
                <span className="spacer" />
                <button className="mini" onClick={() => setDraft(null)}>discard</button>
                <button className="apply" onClick={() => { commit([...p.rules, draft]); setExpanded((s) => new Set(s).add(draft.id)); setDraft(null); }}>Add rule</button>
              </div>
            </div>
          )}

          {/* The last step: the rules propose, the player decides. Nothing sells that is not ticked here. */}
          {!!proposed.length && (
            <div className="card sl-review">
              <div className="cfg-head">
                <b className="eyebrow">to sell</b>
                <span className="dim">{fmt(counts.sell)} of {fmt(proposed.length)} ticked · <span className="sl-cr">{fmt(counts.cr)} cr</span></span>
                <span className="spacer" />
                <button className="mini" onClick={() => setHeld(new Set())}>tick all</button>
                <button className="mini" onClick={() => setHeld(new Set(proposed.map(idOf)))}>tick none</button>
                <input className="sl-rq" value={reviewQ} placeholder="search…" onChange={(e) => setReviewQ(e.target.value)} />
              </div>
              <div className="sl-rlist">
                <table className="sl-grid">
                  <thead><tr><th /><th>Item</th><th className="num">Lv</th><th>Quality</th><th className="num">Value</th></tr></thead>
                  <tbody>
                    {proposed
                      .filter((it) => !reviewQ.trim() || (it.name ?? "").toLowerCase().includes(reviewQ.trim().toLowerCase()))
                      .map((it) => {
                        const id = idOf(it);
                        const on = !held.has(id);
                        const toggle = () => setHeld((s) => { const n = new Set(s); on ? n.add(id) : n.delete(id); return n; });
                        return (
                          <tr key={id} className={on ? "" : "sl-off"} onClick={toggle}
                              onMouseEnter={(e) => showTip({ it, x: e.clientX, y: e.clientY })} onMouseLeave={hideTip}>
                            <td><input type="checkbox" checked={on} onChange={toggle} onClick={(e) => e.stopPropagation()}
                                       aria-label={`sell ${it.name}`} /></td>
                            <td className="nm" style={{ color: RARITY_COLOR[it.rarity] }}>
                              {it.name}{(it.count ?? 1) > 1 ? `  ×${it.count}` : ""}
                            </td>
                            <td className="num">{it.level}</td>
                            <td style={{ color: RARITY_COLOR[it.rarity] }}>{it.rarity}</td>
                            <td className="num">{fmt(Math.max(1, it.count ?? 1) * (it.sellValue ?? 0))}</td>
                          </tr>
                        );
                      })}
                  </tbody>
                </table>
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

/* ---- one saved rule, as prose ------------------------------------------------------------------- */
function RuleRow(q: {
  rule: Rule; kind: Kind; items: Item[]; ctx: FieldCtx; open: boolean;
  onToggle: () => void; onCopy: () => void; onEdit: () => void; defaultKind: Kind;
  openGroups: Set<string>; setOpenGroups: (f: (s: Set<string>) => Set<string>) => void;
  splitQ: string; setSplitQ: (s: string) => void;
  showTip: (t: { it: Item; x: number; y: number }) => void; hideTip: () => void;
}) {
  const n = runRule(q.rule, q.items, q.ctx).size;
  return (
    <div className="sl-rule">
      <div className="sl-rhead" onClick={q.onToggle}>
        <span className="sl-tw">{q.open ? "▾" : "▸"}</span>
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
      {q.open && <Split {...q} />}
    </div>
  );
}

/* ---- the live split: what comes in, and how it divides ------------------------------------------ */
function Split(q: {
  rule: Rule; kind: Kind; items: Item[]; ctx: FieldCtx; defaultKind: Kind;
  openGroups: Set<string>; setOpenGroups: (f: (s: Set<string>) => Set<string>) => void;
  splitQ: string; setSplitQ: (s: string) => void;
  showTip: (t: { it: Item; x: number; y: number }) => void; hideTip: () => void;
}) {
  const { groups, excluded, protected: prot } = useMemo(
    () => explain(q.rule, q.items, q.ctx), [q.rule, q.items, q.ctx]);
  const nIn = groups.reduce((n, g) => n + g.nIn, 0), nOut = groups.reduce((n, g) => n + g.nOut, 0);
  const inKind = q.kind, outKind = q.defaultKind;
  const ql = q.splitQ.trim().toLowerCase();
  const crOf = (rows: { it: Item }[]) => rows.reduce((n, r) => n + Math.max(1, r.it.count ?? 1) * (r.it.sellValue ?? 0), 0);
  const inRows = groups.flatMap((g) => g.rows.filter((r) => r.in));
  const outRows = groups.flatMap((g) => g.rows.filter((r) => !r.in));

  const shown = groups.map((g) => ({
    g, rows: g.rows.filter((r) => !ql || (r.it.name ?? "").toLowerCase().includes(ql) || g.key.toLowerCase().includes(ql)),
  })).filter((x) => !ql || x.rows.length);

  return (
    <div className="sl-split">
      <div className="sl-sh">
        <div className="sl-sh-in">{fmt(nIn + nOut)} come in</div>
        <div className="dim">→</div>
        <div className={"sl-sh-box k-" + inKind} title="Matched by this rule.">
          <b>{fmt(nIn)}</b> {inKind.toUpperCase()}{inKind === "sell" && <span className="sl-cr"> {fmt(crOf(inRows))} cr</span>}
        </div>
        <div className={"sl-sh-box k-" + outKind} title="Matched the filter, but the count left them out.">
          <b>{fmt(nOut)}</b> {outKind.toUpperCase()}{outKind === "sell" && <span className="sl-cr"> {fmt(crOf(outRows))} cr</span>}
        </div>
      </div>
      <div className="sl-note">
        {fmt(excluded.length)} not selected → {q.defaultKind.toUpperCase()}
        {prot.length > 0 && (
          <span title={prot.map((it) => `${it.name} (${cantSell(it)})`).join("\n")}>
            {"  ·  "}{fmt(prot.length)} protected — never sold
          </span>
        )}
      </div>

      <div className="sl-bar">
        <button className="mini" onClick={() => q.setOpenGroups(() => new Set())}>fold all</button>
        <button className="mini" onClick={() => q.setOpenGroups(() => new Set(groups.map((g) => q.rule.id + "|" + g.key)))}>unfold all</button>
        <input value={q.splitQ} placeholder="search item or group…" onChange={(e) => q.setSplitQ(e.target.value)} />
        {!!ql && <button className="mini" onClick={() => q.setSplitQ("")}>clear</button>}
      </div>

      <div className="sl-groups">
        {shown.map(({ g, rows }) => {
          const gid = q.rule.id + "|" + g.key;
          const isOpen = ql ? true : q.openGroups.has(gid);
          return (
            <div key={gid}>
              <div className="sl-group" onClick={() => !ql && q.setOpenGroups((s) => { const n = new Set(s); n.has(gid) ? n.delete(gid) : n.add(gid); return n; })}>
                {isOpen ? "▾ " : "▸ "}{g.key}{"  "}
                <span className="dim">
                  {g.sitsOut ? `${g.held} held — rule sits out here`
                    : `${g.held} held → ${g.nIn} ${inKind.toUpperCase()}, ${g.nOut} ${outKind.toUpperCase()}`}
                </span>
              </div>
              {isOpen && (
                <div className="sl-rows">
                  <table className="sl-grid">
                    <thead><tr><th /><th>Item</th><th className="num">Lv</th><th>Quality</th><th className="num">Value</th></tr></thead>
                    <tbody>
                      {rows.map((r, i) => {
                        const prev = i > 0 ? rows[i - 1].in : r.in;
                        const cut = i > 0 && r.in !== prev;
                        const why = cantSell(r.it);
                        const fate = why ? "cant" : r.in ? inKind : outKind;
                        return (
                          <Fragment key={`${r.it.location ?? ""}#${r.it.key ?? i}`}>
                            {cut && <tr className="sl-cut"><td colSpan={5}>— the count falls here —</td></tr>}
                            <tr className={"f-" + fate}
                                onMouseEnter={(e) => q.showTip({ it: r.it, x: e.clientX, y: e.clientY })}
                                onMouseLeave={q.hideTip}>
                              <td><span className={"sl-fate f-" + fate} title={why ?? undefined}>{why ? "CAN’T" : fate.toUpperCase()}</span></td>
                              <td className="nm" style={{ color: RARITY_COLOR[r.it.rarity] }}>
                                {r.it.name}{(r.it.count ?? 1) > 1 ? `  ×${r.it.count}` : ""}
                              </td>
                              <td className="num">{r.it.level}</td>
                              <td style={{ color: RARITY_COLOR[r.it.rarity] }}>{r.it.rarity}</td>
                              <td className="num">{fmt(Math.max(1, r.it.count ?? 1) * (r.it.sellValue ?? 0))}</td>
                            </tr>
                          </Fragment>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          );
        })}
      </div>
      <div className="sl-note">{fmt(shown.length)}{ql ? ` of ${fmt(groups.length)}` : ""} group{groups.length === 1 ? "" : "s"}</div>
    </div>
  );
}

/* ---- the editor: the sentence, with its variable parts editable in place ------------------------ */
function Editor(q: {
  draft: Rule; setDraft: (r: Rule) => void; kind: Kind; items: Item[]; ctx: FieldCtx; defaultKind: Kind;
  openPop: string | null; setOpenPop: (s: string | null) => void;
  pickField: string; setPickField: (s: string) => void;
  pickOp: string; setPickOp: (s: string) => void;
  pickNum: string; setPickNum: (s: string) => void;
  pickQ: string; setPickQ: (s: string) => void;
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

  return (
    <div className="sl-sent-ed">
      {/* the subject */}
      <div className="sl-line first">
        <span className="lead">{q.kind === "keep" ? "Keep" : "Sell"}</span>
        <span className="sl-chips">
          {!entries.length && <span className="dim">everything I own</span>}
          {!!entries.length && <span className="dim">everything</span>}
          {entries.map(([k, cond], i) => {
            const F = FIELDS[k];
            if (!F) return null;
            const drop = () => { const w = { ...d.where }; delete w[k]; put({ where: w }); };
            if (F.kind === "range") {
              const c = cond as RangeCond;
              const hasMin = c.min != null, hasMax = c.max != null;
              const numBox = (v: number, on: (n: number | null) => void) => (
                <input type="number" value={v} onChange={(e) => on(e.target.value === "" ? null : +e.target.value)} />
              );
              return (
                <span key={k} className="sl-chip">
                  {i > 0 && <span className="sl-and">AND</span>}
                  <span className="cw">{(k === "lrel" ? "level" : F.label) + " is "}</span>
                  {hasMin && hasMax && <>{numBox(c.min!, (n) => put({ where: { ...d.where, [k]: { ...c, min: n } } }))}<span className="cw"> to </span>{numBox(c.max!, (n) => put({ where: { ...d.where, [k]: { ...c, max: n } } }))}</>}
                  {hasMax && !hasMin && <>{numBox(c.max!, (n) => put({ where: { ...d.where, [k]: { ...c, max: n } } }))}<span className="cw"> or less</span></>}
                  {hasMin && !hasMax && <>{numBox(c.min!, (n) => put({ where: { ...d.where, [k]: { ...c, min: n } } }))}<span className="cw"> or more</span></>}
                  {!hasMin && !hasMax && <span className="cw">anything</span>}
                  {k === "lrel" && <span className="cw"> vs mine</span>}
                  <button onClick={drop}>×</button>
                </span>
              );
            }
            const c = cond as SetCond;
            return (
              <span key={k} className={"sl-chip" + (c.not ? " neg" : "")}>
                {i > 0 && <span className="sl-and">AND</span>}
                <span className="cw">{F.label} </span>
                <button className="chipword" title="click to invert"
                        onClick={() => put({ where: { ...d.where, [k]: { ...c, not: !c.not } } })}>
                  {c.not ? "is not" : "is"}
                </button>
                <span className="cw"> {c.values.join(" or ")}</span>
                <button onClick={drop}>×</button>
              </span>
            );
          })}
          <Picker {...q} />
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
            <input type="number" min={0} value={d.take.n} onChange={(e) => put({ take: { ...d.take!, n: Math.max(0, +e.target.value || 0) } })} />
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
          <input type="number" min={0} value={d.having.n} onChange={(e) => put({ having: { ...d.having!, n: Math.max(0, +e.target.value || 0) } })} />
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
             openGroups={q.openGroups} setOpenGroups={q.setOpenGroups}
             splitQ={q.splitQ} setSplitQ={q.setSplitQ} showTip={q.showTip} hideTip={q.hideTip} />
    </div>
  );
}

/* ---- two panes: the field on the left, its values on the right ---------------------------------- */
function Picker(q: Parameters<typeof Editor>[0]) {
  const d = q.draft;
  const openId = "where";
  const isOpen = q.openPop === openId;
  const put = (patch: Partial<Rule>) => q.setDraft({ ...d, ...patch });

  // Coarse first: these are what most rules are about, and they used to sit below every turret type.
  const order = ["l", "lrel", "v", "r", "s", "c", "a", "t", "st", "cat", "dt", "ms", "sub", "asp", "aspN", "aspE"];
  const varies = (f: string) => new Set(q.items.flatMap((it) => {
    const v = FIELDS[f]?.get(it, q.ctx);
    return v == null ? [] : Array.isArray(v) ? v : [v];
  })).size > 1;
  const fields = order.filter((k) => FIELDS[k] && varies(k));
  const field = fields.includes(q.pickField) ? q.pickField : fields[0];
  const F = field ? FIELDS[field] : null;

  const valuesFor = (f: string): (string | number)[] => {
    if (f === "cat") return Object.keys(q.ctx.cats).filter((n) => q.items.some((it) => (q.ctx.cats[n] ?? []).includes(it.type ?? "")));
    if (f === "r") return RARITY_ORDER.filter((r) => q.items.some((it) => it.rarity === r));
    const vals = [...new Set(q.items.flatMap((it) => {
      const v = FIELDS[f].get(it, q.ctx);
      return v == null || v === "" ? [] : Array.isArray(v) ? v : [v];
    }))];
    return vals.every((v) => typeof v === "number") ? (vals as number[]).sort((a, b) => a - b) : vals.map(String).sort();
  };

  const toggle = (v: string | number) => {
    const val = String(v);
    const c = d.where[field] as SetCond | undefined;
    const w = { ...d.where };
    if (c?.values) {
      const next = c.values.includes(val) ? c.values.filter((x) => x !== val) : [...c.values, val];
      if (next.length) w[field] = { ...c, values: next }; else delete w[field];
    } else w[field] = { values: [val], not: false };
    put({ where: w });
  };
  const applyCompare = () => {
    if (q.pickNum === "") return;
    const n = +q.pickNum;
    const c = { ...(d.where[field] as RangeCond | undefined ?? { min: null, max: null }) };
    if (q.pickOp === "lt") c.max = n - 1;
    if (q.pickOp === "lte") c.max = n;
    if (q.pickOp === "gt") c.min = n + 1;
    if (q.pickOp === "gte") c.min = n;
    if (q.pickOp === "eq") { c.min = n; c.max = n; }
    put({ where: { ...d.where, [field]: c } });
    q.setPickNum("");
  };

  const ql = q.pickQ.trim().toLowerCase();
  const slotOf = useMemo(() => {
    const m = new Map<string, string>();
    for (const it of q.items) { const t = typeOf(it); if (t && !m.has(t)) m.set(t, it.slotType ?? "—"); }
    return m;
  }, [q.items]);

  return (
    <span className="sl-popwrap">
      <button className={"sl-add" + (isOpen ? " on" : "")}
              onClick={(e) => { e.stopPropagation(); q.setOpenPop(isOpen ? null : openId); q.setPickQ(""); }}>
        ＋ narrow it down
      </button>
      {isOpen && F && (
        <div className="sl-pop" onClick={(e) => e.stopPropagation()}>
          <div className="sl-pk2">
            <div className="sl-fields">
              {fields.map((k) => (
                <button key={k} className={"sl-field" + (k === field ? " sel" : "") + (k in d.where ? " used" : "")}
                        onClick={() => { q.setPickField(k); q.setPickQ(""); }}>
                  {FIELDS[k].label}
                </button>
              ))}
            </div>
            <div className="sl-vals">
              {F.kind === "range" ? (
                <>
                  <div className="sl-pkrow">
                    <span className="dim">{field === "lrel" ? "level vs mine" : F.label}</span>
                    <select value={q.pickOp} onChange={(e) => q.setPickOp(e.target.value)}>
                      {OPS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
                    </select>
                    <input type="number" value={q.pickNum} onChange={(e) => q.setPickNum(e.target.value)}
                           onKeyDown={(e) => { if (e.key === "Enter") applyCompare(); }} />
                    <button className="apply" disabled={q.pickNum === ""} onClick={applyCompare}>add</button>
                  </div>
                  <div className="dim sl-opt" title={"Add a second comparison to close the range." + (field === "lrel" ? ` Your level is ${q.ctx.myLevel}.` : "")}>
                    {(() => {
                      const c = d.where[field] as RangeCond | undefined;
                      return c ? [c.min != null ? "≥ " + c.min : null, c.max != null ? "≤ " + c.max : null].filter(Boolean).join("  ") : "";
                    })()}
                  </div>
                  {d.where[field] && <button className="mini" onClick={() => { const w = { ...d.where }; delete w[field]; put({ where: w }); }}>clear</button>}
                </>
              ) : (
                <>
                  {valuesFor(field).length > 12 && (
                    <input value={q.pickQ} placeholder={`search ${F.label}…`} onChange={(e) => q.setPickQ(e.target.value)} />
                  )}
                  <div className="sl-vlist">
                    {(() => {
                      const all = valuesFor(field).filter((v) => !ql || String(v).toLowerCase().includes(ql));
                      const cur = d.where[field] as SetCond | undefined;
                      const opt = (v: string | number) => (
                        <button key={String(v)} className={"sl-val" + (cur?.values?.includes(String(v)) ? " on" : "")}
                                onClick={() => toggle(v)}>
                          {cur?.values?.includes(String(v)) ? "✓ " : ""}{String(v)}
                        </button>
                      );
                      if (field !== "t") return all.map(opt);
                      // `type` is the long list, so its values sit under the slot they go in.
                      const bySlot = new Map<string, (string | number)[]>();
                      for (const v of all) {
                        const k = slotOf.get(String(v)) ?? "—";
                        const a = bySlot.get(k); if (a) a.push(v); else bySlot.set(k, [v]);
                      }
                      const rank = (k: string) => (k === "Hardpoint" ? -1 : k === "Booster" ? 1 : 0);
                      return [...bySlot.keys()].sort((a, b) => rank(a) - rank(b) || a.localeCompare(b))
                        .flatMap((k) => [<div key={"h" + k} className="sl-sub">{k}</div>, ...bySlot.get(k)!.map(opt)]);
                    })()}
                  </div>
                  <div className="sl-pkfoot">
                    <label>
                      <input type="checkbox" disabled={!d.where[field]}
                             checked={!!(d.where[field] as SetCond | undefined)?.not}
                             onChange={(e) => {
                               const c = d.where[field] as SetCond;
                               put({ where: { ...d.where, [field]: { ...c, not: e.target.checked } } });
                             }} />
                      is NOT
                    </label>
                    <span className="dim" title="Several values in one field match as OR.">
                      {(d.where[field] as SetCond | undefined)?.values?.length ?? 0} chosen
                    </span>
                  </div>
                </>
              )}
            </div>
          </div>
          <div className="sl-pkclose"><button className="mini" onClick={() => q.setOpenPop(null)}>close</button></div>
        </div>
      )}
    </span>
  );
}

function GroupPicker(q: Parameters<typeof Editor>[0]) {
  const d = q.draft;
  const isOpen = q.openPop === "group";
  const avail = GROUP_FIELDS.filter((k) => !d.group.includes(k));
  if (!avail.length) return null;
  return (
    <span className="sl-popwrap">
      <button className={"sl-add" + (isOpen ? " on" : "")}
              onClick={(e) => { e.stopPropagation(); q.setOpenPop(isOpen ? null : "group"); }}>＋ and each…</button>
      {isOpen && (
        <div className="sl-pop narrow" onClick={(e) => e.stopPropagation()}>
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
