// @vitest-environment jsdom
import { describe, expect, it, vi, afterEach } from "vitest";
import { createRoot } from "react-dom/client";
import { act } from "react";
import { ErrorBoundary } from "./ErrorBoundary";

// React 19 wants this flag set or it warns that act() is being used outside a test environment.
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// A render throw used to unmount the whole tree and leave an EMPTY document — no message and no way back but a
// manual reload. That is the failure the bridge produces routinely, since the game restarts under a live page.
describe("ErrorBoundary", () => {
  const errs: unknown[][] = [];
  const spy = vi.spyOn(console, "error").mockImplementation((...a) => { errs.push(a); });
  afterEach(() => { errs.length = 0; });

  const mount = (node: React.ReactNode) => {
    const host = document.createElement("div");
    document.body.appendChild(host);
    const root = createRoot(host);
    act(() => root.render(node));
    return host;
  };

  const Boom = (): React.ReactNode => { throw new Error("pct is not defined"); };

  it("renders children when nothing throws", () => {
    const host = mount(<ErrorBoundary><p>fine</p></ErrorBoundary>);
    expect(host.textContent).toContain("fine");
  });

  it("shows the message and a way back instead of a blank page", () => {
    const host = mount(<ErrorBoundary><Boom /></ErrorBoundary>);
    expect(host.textContent).not.toBe("");
    expect(host.textContent).toContain("pct is not defined");
    expect(host.querySelector("button")?.textContent).toBe("Reload");
    // Does NOT name a cause. A boundary catches a bad read from the bridge and a plain coding mistake through
    // the same path and cannot tell them apart, so any confident explanation is wrong about half the time — the
    // first version blamed the bridge, and the first real crash it caught was a missing identifier.
    expect(host.textContent).not.toMatch(/bridge|plugin|game closing/i);
    // Does say the things it actually knows, because "something broke" with no direction is barely better
    // than a blank page.
    expect(host.textContent).toMatch(/nothing was changed in the game/i);
    expect(host.textContent).toMatch(/console/i);
  });

  it("keeps the component stack in the console for whoever has to find the culprit", () => {
    mount(<ErrorBoundary><Boom /></ErrorBoundary>);
    expect(errs.some((a) => String(a[0]).includes("ShipOptimizer crashed"))).toBe(true);
    spy.mockClear();
  });
});
