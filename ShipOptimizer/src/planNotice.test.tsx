// @vitest-environment jsdom
//
// The regression verdict is computed per plan; these pin the only thing the UI is allowed to do with it.
import { describe, it, expect, afterEach } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import PlanNotice from "./PlanNotice";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let host: HTMLDivElement | null = null;
afterEach(() => {
  if (root) act(() => root!.unmount());
  host?.remove();
  root = null; host = null;
});

function render(regresses: boolean | null) {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  act(() => { root!.render(<PlanNotice regresses={regresses} />); });
  return host;
}

describe("a losing plan says so", () => {
  it("warns when the plan scores below the fitted build", () => {
    const el = render(true);
    expect(el.textContent).toMatch(/lower/i);
    expect(el.querySelector(".sum-msg.warn")).not.toBeNull();
  });

  // `null` is "cannot judge", not "checked, and fine": a module-only plan and a simple-ranking plan both land
  // here, so anything rendered would be a claim the objective never made.
  it("says nothing when the verdict is unjudgeable", () => {
    expect(render(null).textContent).toBe("");
  });

  it("says nothing when the plan is an improvement", () => {
    expect(render(false).textContent).toBe("");
  });
});
