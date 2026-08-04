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
// first so it stays the default when nothing is stored.
export const DESIGNS: Design[] = [
  { id: "classic", label: "Classic", hint: "The current dark UI" },
  { id: "graphite", label: "Graphite", hint: "Flatter, higher contrast, tighter rows" },
];

export const DEFAULT_DESIGN = DESIGNS[0].id;
const KEY = "shipoptimizer.design";

export const isDesign = (id: string | null | undefined): boolean => !!id && DESIGNS.some((d) => d.id === id);

export function loadDesign(): string {
  try {
    const v = localStorage.getItem(KEY);
    return isDesign(v) ? v! : DEFAULT_DESIGN;
  } catch {
    return DEFAULT_DESIGN;   // storage blocked (private mode / embedded webview)
  }
}

// Applied to <html> rather than a React wrapper so the whole document — including anything portalled or
// rendered outside the app root — is covered by the same design.
export function applyDesign(id: string): void {
  const chosen = isDesign(id) ? id : DEFAULT_DESIGN;
  document.documentElement.dataset.design = chosen;
  try { localStorage.setItem(KEY, chosen); } catch { /* not worth failing a theme change over */ }
}

import "./tokens.css";
import "./graphite.css";
