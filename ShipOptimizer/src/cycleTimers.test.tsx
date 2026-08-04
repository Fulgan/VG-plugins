// @vitest-environment jsdom
//
// A cycle row with nothing to count must keep ASKING. Two states have nothing to count — `due` (waiting on the
// player) and no reading at all (`—`) — and neither ticks nor fires the expiry refetch, so a row that enters one
// with no other prompt latches on its label for the rest of the session. Measured in game: the bridge was serving
// `missionRestock.nextIn: 283.13` while the strip still read `Mission board —`.
import { describe, it, expect, afterEach, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import CycleTimers from "./CycleTimers";
import { api } from "./api";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let host: HTMLDivElement | null = null;
afterEach(() => {
  if (root) act(() => root!.unmount());
  host?.remove();
  root = null; host = null;
  vi.restoreAllMocks();
  vi.useRealTimers();
});

const conn = { host: "127.0.0.1", port: "8777", token: "" } as never;
const conquest = { tickIn: 900, tickDelay: 3600 };

const render = async (Node: React.ReactElement) => {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => { root!.render(Node); });
};

const missionRow = () => host!.querySelector(".cyc-mission")?.textContent ?? "";

describe("the cycle strip keeps asking when it has nothing to count", () => {
  it("re-fetches a row that arrived with NO reading, and fills it in", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const cycles = vi.spyOn(api, "cycles")
      // First answer: no board at all — undocked before any station was visited.
      .mockResolvedValueOnce({ conquest, shopRestock: { nextIn: 1785, interval: 3600 } } as never)
      // Every answer after: the board the bridge was serving all along.
      .mockResolvedValue({ conquest, shopRestock: { nextIn: 1785, interval: 3600 },
        missionRestock: { nextIn: 283.13, interval: 300, station: "Drift Zero", fresh: false } } as never);

    await render(<CycleTimers conn={conn} />);
    expect(cycles).toHaveBeenCalledTimes(1);
    expect(missionRow()).toContain("—");          // the latched em-dash

    // The row owns no timer of its own, so only the re-ask can rescue it.
    await act(async () => { await vi.advanceTimersByTimeAsync(10_500); });
    expect(cycles.mock.calls.length).toBeGreaterThan(1);
    expect(missionRow()).toContain("4:4");             // 283s, ticking
    expect(missionRow()).not.toContain("—");
  });

  it("re-fetches a row that is DUE, so it notices the reroll", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const cycles = vi.spyOn(api, "cycles")
      .mockResolvedValueOnce({ conquest,
        missionRestock: { nextIn: -30, interval: 300, station: "Drift Zero", fresh: false } } as never)
      .mockResolvedValue({ conquest,
        missionRestock: { nextIn: 300, interval: 300, station: "Drift Zero", fresh: true } } as never);

    await render(<CycleTimers conn={conn} />);
    expect(missionRow()).toContain("on arrival");
    await act(async () => { await vi.advanceTimersByTimeAsync(10_500); });
    expect(cycles.mock.calls.length).toBeGreaterThan(1);
    expect(missionRow()).not.toContain("on arrival");
  });
});
