// The count badge on a tab. ONE owner for every tab, because five hand-assembled `<span className="opp-badge …">`
// at five call sites is how they drifted: some carried a word ("1 inv"), some a bare number, so a pill and a
// circle ended up sitting next to each other looking like different kinds of thing.
//
// Every badge is therefore `<count> <label>` — same shape, same height, whatever it counts — and the
// hide-when-zero rule lives here too, instead of as `{n > 0 && …}` repeated at each site.
//
// The kind's CSS class is DERIVED (`b-<kind>`), never hand-written, and namespaced: a bare `apply` collided with
// the green Apply BUTTON's `.apply` rule, which is declared later at equal specificity — so the badge inherited a
// button's padding, font size and colour and only its background survived. A global class name shared with an
// unrelated component is the same one-owner defect wearing a stylesheet.

export type BadgeKind = "inv" | "shop" | "hire" | "pending";

export default function TabBadge({ kind, count, label, title }: {
  kind: BadgeKind;
  count: number;
  /** What is being counted, in one short word. Kept short: it sits inside a tab. */
  label: string;
  title: string;
}) {
  if (count <= 0) return null;
  return <span className={`opp-badge b-${kind}`} title={title}>{count} {label}</span>;
}

/** A badge with no count — a standing note on a tab, e.g. "wip". Same pill, so it does not read as a third thing. */
export function TabNote({ text, title }: { text: string; title: string }) {
  return <span className="opp-badge b-note" title={title}>{text}</span>;
}
