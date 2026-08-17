// The shopping list's rules, inline on the shop rail that renders their matches.
//
// Not a modal of its own, deliberately: a want rule is written while looking at what the station has, and the
// count beside each rule is the answer to "did that clause say what I meant". A separate screen would put the
// evidence one click away from the rule.
//
// Editing is DIRECT — no draft, no add button. A want rule has one part (its filters) and every keystroke's
// effect is on screen beside it; the sell list's draft-then-add exists because its rule has four parts and a
// half-written one would propose selling the wrong things. Here a half-written rule matches nothing.
import { useEffect, useState } from "react";
import { WhereChips, usePopDismiss, type Vocabulary } from "./whereEditor";
import { isInert, nextWantId, newWant, wantMatches, wantSentence, type WantRule } from "./wantRules";
import type { FieldCtx, Where } from "./sellRules";
import type { Item } from "./types";

export default function WantedRules(p: {
  rules: WantRule[];
  onChange: (next: WantRule[]) => void;
  /** What the rules run against here and now — the station's own stock. */
  offers: Item[];
  /**
   * The population the field picker reads its values from: the offers PLUS what the player owns.
   *
   * The picker only offers a field whose value VARIES across that population, which is right when it is the
   * whole armory and wrong when it is the four rows a station happens to stock — a rule written for the next
   * station could not name a quality or a type that this one has only one of.
   */
  vocabulary: Item[];
  /**
   * The game's OWN vocabulary — every turret type, module slot and damage type it ships, whether or not this
   * station stocks one. A shopping list is written about what you do not have: derived from the rows in front of
   * it, the type list offered the nine types in stock out of thirty-one.
   */
  catalog?: Vocabulary;
  ctx: FieldCtx;
  /** Closes the flyout this is drawn in. Optional so the panel can be mounted plainly in a test. */
  onClose?: () => void;
}) {
  const [openPop, setOpenPop] = useState<string | null>(null);
  usePopDismiss(openPop, () => setOpenPop(null));

  // Escape closes the panel — but only once the field picker has had it. That popover takes Escape in the
  // CAPTURE phase and stops it there, so while it is open this bubble-phase listener never runs, and one press
  // shuts the picker rather than the panel it was opened from.
  const { onClose } = p;
  useEffect(() => {
    if (!onClose) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  const put = (id: string, where: Where) => p.onChange(p.rules.map((r) => (r.id === id ? { ...r, where } : r)));
  const drop = (id: string) => p.onChange(p.rules.filter((r) => r.id !== id));

  return (
    <div className="want-panel">
      {onClose && (
        <div className="want-head">
          <b>Shopping list</b>
          <button className="mini" onClick={onClose}>close</button>
        </div>
      )}
      {!p.rules.length && (
        <p className="hint">
          A want is a filter over what the shop has, in the same words the sell list uses — quality, type,
          aspect, price, how many you already own. Matches join the rail below with a buy button.
        </p>
      )}
      {p.rules.map((r) => {
        const n = wantMatches(p.offers, r, p.ctx).length;
        return (
          <div key={r.id} className="want-rule">
            <div className="want-say">
              <span className={isInert(r) ? "dim" : undefined}>{wantSentence(r)}</span>
              <button className="mini" title="drop this want" onClick={() => drop(r.id)}>×</button>
            </div>
            <span className="sl-chips">
              <WhereChips where={r.where} onChange={(w) => put(r.id, w)}
                          items={p.vocabulary} catalog={p.catalog} ctx={p.ctx}
                          openPop={openPop} setOpenPop={setOpenPop} popId={r.id} />
            </span>
            <div className="hint">
              {isInert(r) ? "no filters yet — matches nothing" : `${n} on offer here`}
            </div>
          </div>
        );
      })}
      <button className="want-add" onClick={() => p.onChange([...p.rules, newWant(nextWantId(p.rules))])}>
        ＋ add a want
      </button>
    </div>
  );
}
