// The gear tab's ship art, guarded at the STYLESHEET — because the defect it had is invisible to every other
// kind of test. jsdom performs no layout, so a mount dot placed 300px off the hull renders identically to one on
// it; the fault only exists once a browser resolves a percentage against a box that got stretched.
//
// Read off disk rather than imported: a `?raw` css import resolves to an empty string under this project's
// vitest, and every assertion below would then hold trivially.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const css = readFileSync(new URL("./officers.css", import.meta.url), "utf8");

const block = (selector: string) => {
  const m = new RegExp(`${selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*\\{([^}]*)\\}`).exec(css);
  if (!m) throw new Error(`no rule for ${selector}`);
  return m[1];
};

describe("officers.css", () => {
  it("was actually read", () => {
    expect(css.length).toBeGreaterThan(1000);
  });
});

// A dot is placed with `left: u%` / `top: v%`, which resolves against `.gear-ship-wrap`. If that box is ever
// wider than the picture inside it, every dot on every ship is wrong — so the wrapper has to be unstretchable,
// and that is the property worth pinning rather than any particular number.
describe("the hardpoint markers' positioning context", () => {
  const wrap = () => block(".gear-ship-wrap");

  it("establishes the context at all", () => {
    expect(wrap()).toMatch(/position:\s*relative/);
  });

  it("refuses to be stretched by a flex or grid parent", () => {
    // `.gear-ship` is a flex row that becomes a COLUMN with `align-items: stretch` in the wide layout, which is
    // exactly what stretched this box across the left column.
    expect(wrap()).toMatch(/align-self:\s*(start|flex-start)/);
  });

  it("sizes to its own content, so no parent can widen it", () => {
    // The durable half: `align-self` handles today's parent, this handles whatever positions it tomorrow.
    expect(wrap()).toMatch(/width:\s*(max-content|fit-content|min-content)/);
  });

  it("still shrinks with a narrow column instead of overflowing it", () => {
    // Sizing to content must not cost the responsive behaviour — the image scales down and the box follows it,
    // which is what keeps the percentages correct at a small window and at zoom above 100%.
    expect(wrap()).toMatch(/max-width:\s*100%/);
    expect(block(".gear-img")).toMatch(/max-width:\s*100%/);
  });

  // The dot itself is centred on its coordinate; without this every dot sits down-right of its mount by half its
  // own size, which reads as a systematic offset rather than as a bug.
  it("centres each dot on its coordinate", () => {
    expect(block(".gear-mount")).toMatch(/transform:\s*translate\(-50%,\s*-50%\)/);
  });
});
