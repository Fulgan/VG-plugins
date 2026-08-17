// Design registry: one entry per look. A CODE-only extension point — there is no user-facing picker, and
// `main.tsx` pins `data-design` to DEFAULT_DESIGN before the first paint, so no stored id can strand a browser
// in a look it cannot leave. Adding one is a source edit: drop `src/designs/<id>.css`, scope every rule under
// `:root[data-design="<id>"]` (see graphite.css), then add a line to DESIGNS and an `import` at the bottom.
//
// A design works at two levels: TOKENS override the custom properties in tokens.css (cheapest, reaches
// everything already migrated), SELECTORS override concrete rules tokens can't express.
//
// ⚠️ Much of the older CSS still hardcodes colours (`#14141a` and friends), which do NOT follow a token
// override — each one needs moving to `var(--…)` before it responds to a design.

export interface Design {
  id: string;
  label: string;
  hint?: string;
}

// `classic` is the current look and owns no CSS file — it IS the base stylesheet with no overrides. Keep it
// first: it is what `DEFAULT_DESIGN` resolves to, and every caller passes that.
export const DESIGNS: Design[] = [
  { id: "classic", label: "Classic", hint: "The current dark UI" },
  { id: "graphite", label: "Graphite", hint: "Flatter, higher contrast, tighter rows" },
];

export const DEFAULT_DESIGN = DESIGNS[0].id;

export const isDesign = (id: string | null | undefined): boolean => !!id && DESIGNS.some((d) => d.id === id);

// Applied to <html> rather than a React wrapper so the whole document — including anything portalled or
// rendered outside the app root — is covered by the same design.
//
// Nothing is PERSISTED: with no picker there is no choice to remember, and a stored id is the one thing that
// could strand a browser in a look it has no control to leave. The caller passes the id it wants.
export function applyDesign(id: string): void {
  document.documentElement.dataset.design = isDesign(id) ? id : DEFAULT_DESIGN;
}

import "./tokens.css";
import "./graphite.css";
