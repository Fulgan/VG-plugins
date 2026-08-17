// @vitest-environment jsdom
//
// The regression verdict is computed per plan; these pin the only thing the UI is allowed to do with it.
//
// The banner has been wrong three times, each time in its EXPLANATION rather than its verdict: the words rendered
// out of order, the reason was asserted rather than measured, and the reason it asserted was unreadable and blamed
// a bracket drop as though that were a failure in itself. So these tests are about what it SAYS,
// not only about when it appears.
import { describe, it, expect, afterEach } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import PlanNotice, { type PlanVerdict } from "./PlanNotice";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let host: HTMLDivElement | null = null;
afterEach(() => {
  if (root) act(() => root!.unmount());
  host?.remove();
  root = null; host = null;
});

const verdict = (over: Partial<PlanVerdict> = {}): PlanVerdict => ({
  worse: true, label: "Mining power", cur: 87_334, next: 80_980, pct: -0.0728, bracket: null, ...over,
});

function render(v: PlanVerdict | null) {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  act(() => { root!.render(<PlanNotice verdict={v} />); });
  return host;
}

describe("a losing plan says so", () => {
  it("warns when the plan scores below the fitted build", () => {
    expect(render(verdict()).textContent).toMatch(/worse/i);
  });

  it("says nothing when the plan is not worse", () => {
    expect(render(verdict({ worse: false })).textContent).toBe("");
  });

  // An absent warning must never mean "checked, and fine": there is no reassuring variant to fall into.
  it("says nothing at all when the objective cannot judge the plan", () => {
    expect(render(null).textContent).toBe("");
  });
});

describe("it states WHY, with the figures", () => {
  it("prints the figure that got worse, both sides, and the ratio", () => {
    const text = render(verdict()).textContent ?? "";
    expect(text).toContain("Mining power");
    expect(text).toContain((87_334).toLocaleString());
    expect(text).toContain((80_980).toLocaleString());
    expect(text).toMatch(/7\.3%/);
  });

  it("names the DPS index for a combat battery, since the two are different units", () => {
    expect(render(verdict({ label: "DPS index" })).textContent).toContain("DPS index");
  });

  it("omits the ratio rather than inventing one when there is no baseline", () => {
    expect(render(verdict({ pct: null })).textContent).not.toMatch(/%\)/);
  });

  // A bracket drop is NOT a failure by itself — the objective nets it against what the plan gains, and this notice
  // only appears when that net came out worse. So the bracket is named as the MECHANISM, with both values.
  it("names the bracket it moved, and says the gain did not cover it", () => {
    const text = render(verdict({ bracket: { from: 0.2, to: 0.1 } })).textContent ?? "";
    expect(text).toMatch(/\+20%/);
    expect(text).toMatch(/\+10%/);
    expect(text).toMatch(/does not cover/i);
  });

  it("never mentions a bracket that did not move", () => {
    expect(render(verdict({ bracket: null })).textContent).not.toMatch(/bracket/i);
  });

  it("keeps the sentence in one flex child so it reads in order", () => {
    const t = render(verdict()).querySelector(".sum-msg-t");
    expect(t).not.toBeNull();
    expect(t!.textContent).toMatch(/this plan is worse than what you have fitted/i);
  });
});
