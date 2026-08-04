// @vitest-environment jsdom
//
// Mounting: does the component render, and does it survive the transition from "no data yet" to "data
// arrived"?
//
// Both renders go into the SAME root on purpose. Hook order is only checked across re-renders of one mounted
// component, so a conditional hook (one declared below an early return) is invisible to a single render or to
// `renderToString`.
//
// Not a full app test — no bridge, no network. Just the tabs that own hook-heavy state, empty then populated.
import { describe, it, expect, afterEach, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import OfficersTab, { useOfficerBuilder, type OfficerBuilder } from "./OfficersTab";
import StandingPanels from "./StandingPanels";
import { api } from "./api";
import type { Officer, OfficerSkill, Reputation, StandingEntry } from "./types";

// React 19 wants this flag set or it warns that act() is being used outside a test environment.
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const conn = { host: "127.0.0.1", port: "8777", token: "" };

let root: Root | null = null;
let host: HTMLDivElement | null = null;

function mount(ui: React.ReactNode) {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  act(() => { root!.render(ui); });
  return host;
}
// Re-render into the SAME root — this is the part that reproduces a hook-order fault.
function rerender(ui: React.ReactNode) {
  act(() => { root!.render(ui); });
  return host!;
}

afterEach(() => {
  if (root) act(() => root!.unmount());
  host?.remove();
  root = null; host = null;
  vi.restoreAllMocks();
});

const sk = (id: string, name: string): OfficerSkill => ({ id, name, tier: 1, major: false });
const officer = (guid: string): Officer => ({
  guid, name: guid, callsign: "", profession: "Combat", rarity: "Standard", level: 10, gender: "Male",
  icon: null, chosenBonus: "", current: [sk("s1", "Iron Rage")], potential: [sk("s1", "Iron Rage")],
});

// A minimal builder, so the tab can be rendered without the bridge. Shaped by hand rather than mocked so a
// change to OfficerBuilder's contract shows up as a type error here.
function builderStub(overrides: Partial<OfficerBuilder> = {}): OfficerBuilder {
  const ship = { guid: "ship-1", name: "Manglor", role: "Combat", slots: 2, hasDroneBay: false, assigned: [null, null] };
  return {
    officers: [officer("A")], ships: [ship], ship,
    scope: "potential", setScope: () => {},
    catalog: [{ id: "s1", name: "Iron Rage", major: false, roles: ["Combat"], drone: false }],
    prio: [], setPrio: () => {},
    forced: new Set<string>(), togglePin: () => {}, setForced: () => {},
    result: null,
    profile: { main: "combat", combatStance: "brawler", combatLayer: "surface", echo: false, drone: false, boarding: false },
    setProfile: () => {},
    ...overrides,
  } as OfficerBuilder;
}

describe("mounting", () => {
  it("renders the officers tab with an empty roster, then with data, on one root", () => {
    // Render 1 hits the early returns (no ships / no officers) — fewer branches reached.
    const el = mount(<OfficersTab builder={builderStub({ officers: [], ships: [], ship: undefined })}
      portraitUrl={() => null} recruits={null} portraitByIcon={() => null} goSummary={() => {}}
      conn={conn} docked={false} credits={0} onHired={() => {}} />);
    expect(el.textContent).toMatch(/No ships with officer slots/i);

    // Render 2 goes all the way through. If any hook sits below an early return, React throws here.
    const el2 = rerender(<OfficersTab builder={builderStub()}
      portraitUrl={() => null} recruits={null} portraitByIcon={() => null} goSummary={() => {}}
      conn={conn} docked credits={500_000} onHired={() => {}} />);
    expect(el2.textContent).toContain("Iron Rage");
  });

  it("survives the reverse transition too (data, then nothing)", () => {
    mount(<OfficersTab builder={builderStub()}
      portraitUrl={() => null} recruits={null} portraitByIcon={() => null} goSummary={() => {}}
      conn={conn} docked credits={0} onHired={() => {}} />);
    const el = rerender(<OfficersTab builder={builderStub({ officers: [], ships: [], ship: undefined })}
      portraitUrl={() => null} recruits={null} portraitByIcon={() => null} goSummary={() => {}}
      conn={conn} docked={false} credits={0} onHired={() => {}} />);
    expect(el.textContent).toMatch(/No ships with officer slots/i);
  });

  it("shows every skill when the browser is switched to All", () => {
    const el = mount(<OfficersTab builder={builderStub()}
      portraitUrl={() => null} recruits={null} portraitByIcon={() => null} goSummary={() => {}}
      conn={conn} docked credits={0} onHired={() => {}} />);
    const all = [...el.querySelectorAll("button")].find((b) => b.textContent?.startsWith("All"));
    expect(all).toBeTruthy();
    act(() => { all!.dispatchEvent(new MouseEvent("click", { bubbles: true })); });
    // A skill no officer here has — proves the full catalog is in play, not just the roster's.
    expect(el.textContent).toContain("Harvester");
  });
});

describe("standing panels", () => {
  const standing = (): Reputation => ({
    conquestRepMax: 30000, foeAt: -500, topRankAt: 4500,
    levels: [
      { tier: "Hostile", at: -5000, name: "Hostile", group: "Negative" },
      { tier: "Neutral", at: 0, name: "Neutral", group: "Neutral" },
      { tier: "Respected", at: 5000, name: "Respected", group: "Positive" },
    ],
    ranks: [{ tier: "Rank1", at: 500, name: "Rank 1" }],
    factions: [
      {
        id: "MiningGuild", name: "Mindus Holdings", color: "#ffb020", atWar: false,
        reputation: {
          value: 4200, level: "Respected", levelName: "Respected", group: "Positive", color: "#58c26b",
          progress: 0.4, bandProgress: 200, bandRange: 1000, nextAt: 5000, toNext: 800,
          perks: { shopDiscount: 0.1, shipyardDiscount: 0, repairCostDiscount: 0, repairSpeed: 0,
            missionReward: 1.2, bonusMissions: 1, boardRefreshTimer: 240, shopRefreshTokens: 0,
            canRefreshShop: true, canRefreshBoard: null },
        },
        conquest: {
          contribution: 2916, rank: "Rank4", rankName: "Oracle's Chosen", color: "#c07bff",
          areaHeld: 3, areaMax: 9, conqueredPct: 0.33, rejoinCooldown: 0,
          perks: { creditMultiplier: 1.15, reputationBonus: 0, fleetStrengthBonus: 0.05,
            commendationsBonus: 0, destroyer: true },
        },
      },
      // At war while POSITIVE: war is the game's own flag, never derived from the value.
      { id: "Blue", name: "Kolyatov Collective", color: "#6ec8ff", atWar: true,
        reputation: { value: 6751, level: "Friendly", levelName: "Friendly", group: "Positive", color: "#58c26b",
          progress: 0.5, bandProgress: 1751, bandRange: 10000, nextAt: 15000, toNext: 8249 } },
      // Reputation only — the conquest half must be optional, not assumed.
      { id: "Red", name: "Steel Vultures", color: "#ff7b7b", atWar: false,
        reputation: { value: -900, level: "Hostile", levelName: "Hostile", group: "Negative", color: "#ff7b7b",
          progress: 0, bandProgress: 0, bandRange: 500, nextAt: -500, toNext: 400 } },
    ],
  });

  // A healthy sampler: 15 factions watched, checked seconds ago. Without this an empty log is reported as a
  // fault rather than as "nothing has happened".
  const alive = { samples: 40, periodSeconds: 3, lastSampleAgo: 1.2, watchingFactions: 15, watchingConquest: 11, lastError: null };

  const logEntry = (over: Partial<StandingEntry> = {}): StandingEntry => ({
    seq: 1, t: "12:04:31", ladder: "faction", factionId: "Red", faction: "Steel Vultures",
    delta: -250, value: -900, tierWas: "Wary", tier: "Hostile", at: "LZ-981 Rift", ...over,
  });

  it("mounts through loading → data and expands a faction's perks", async () => {
    let resolve!: (r: Reputation) => void;
    vi.spyOn(api, "reputation").mockReturnValue(new Promise<Reputation>((r) => { resolve = r; }));
    vi.spyOn(api, "standingLog").mockResolvedValue({ entries: [], seq: 0, capacity: 400, playthrough: "pt", sampler: alive });
    const el = mount(<StandingPanels conn={conn} conquestUnlocked />);
    expect(el.textContent).toMatch(/Loading standing/i);

    // Second render on the same root: a hook below the loading early-return would throw here.
    await act(async () => { resolve(standing()); });
    expect(el.textContent).toContain("Mindus Holdings");
    expect(el.textContent).toContain("Oracle's Chosen");
    expect(el.textContent).toContain("Steel Vultures");

    // The reputation half must actually render — an empty column was the symptom of the bridge reading the
    // faction PAIR's non-public fields instead of asking the faction.
    // Printed the way the game prints it: value against the end of the ladder on its own side of zero.
    expect(el.textContent).toContain(`${(4200).toLocaleString()} / ${(5000).toLocaleString()}`);
    expect(el.textContent).toContain("Respected");
    expect(el.textContent).toContain(`${(-900).toLocaleString()} / ${(-5000).toLocaleString()}`);
    // Neither "max" the game exposes is a ceiling, so neither is labelled as one.
    expect(el.textContent).toContain(`top rank at ${(4500).toLocaleString()}`);
    expect(el.textContent).not.toContain("cap");
    // War is the game's flag: a faction at +6,751 still reads At War, and its band is not shown as the state.
    expect(el.textContent).toContain("At War");

    // Each panel expands its OWN ladder's perks: the reputation row knows nothing about conquest rewards.
    const [repPanel, conqPanel] = [...el.querySelectorAll(".std-panel")];
    const rowIn = (panel: Element) =>
      [...panel.querySelectorAll("button")].find((b) => b.textContent?.includes("Mindus Holdings"))!;

    act(() => { rowIn(repPanel).dispatchEvent(new MouseEvent("click", { bubbles: true })); });
    expect(repPanel.textContent).toContain("Shop 10% off");
    expect(repPanel.textContent).not.toContain("Destroyer hull unlocked");
    // A zero perk is absent, not printed as "0%".
    expect(repPanel.textContent).not.toContain("Shipyard 0% off");

    act(() => { rowIn(conqPanel).dispatchEvent(new MouseEvent("click", { bubbles: true })); });
    expect(conqPanel.textContent).toContain("Destroyer hull unlocked");
    expect(conqPanel.textContent).toContain("Credits x1.15");
  });

  it("keeps the payload's order and hides conquest until the map is unlocked", async () => {
    vi.spyOn(api, "reputation").mockResolvedValue(standing());
    vi.spyOn(api, "standingLog").mockResolvedValue({ entries: [], seq: 0, capacity: 400, playthrough: null, sampler: alive });
    const el = mount(<StandingPanels conn={conn} />);
    await act(async () => { await Promise.resolve(); });

    // One panel only: no conquest section, so no ranks and no conquest log either.
    expect(el.querySelectorAll(".std-panel")).toHaveLength(1);
    expect(el.textContent).not.toContain("Oracle's Chosen");
    expect(el.textContent).not.toContain("Conquest contribution");

    // Rows follow the game's order (the bridge sends it), NOT reputation or name.
    const names = [...el.querySelectorAll(".std-rows .fac-mark-name")].map((n) => n.textContent);
    expect(names).toEqual(["Mindus Holdings", "Kolyatov Collective", "Steel Vultures"]);

    // Unlocking adds the second panel without touching the first.
    const el2 = rerender(<StandingPanels conn={conn} conquestUnlocked />);
    expect(el2.querySelectorAll(".std-panel")).toHaveLength(2);
    expect(el2.textContent).toContain("Oracle's Chosen");
  });

  it("says WHY a log is empty — quiet sampler vs broken one", async () => {
    vi.spyOn(api, "reputation").mockResolvedValue(standing());
    vi.spyOn(api, "standingLog").mockResolvedValue({
      entries: [], seq: 0, capacity: 400, playthrough: "pt", sampler: alive,
    });
    const el = mount(<StandingPanels conn={conn} conquestUnlocked />);
    await act(async () => { await Promise.resolve(); });
    // Healthy: name what it is watching, so "no entries" reads as "nothing happened".
    expect(el.textContent).toContain("watching 15 factions");

    // Watching nothing: it CANNOT record, which must not look like a quiet game.
    vi.spyOn(api, "standingLog").mockResolvedValue({
      entries: [], seq: 0, capacity: 400, playthrough: "pt",
      sampler: { ...alive, watchingFactions: 0 },
    });
    const el2 = rerender(<StandingPanels conn={conn} conquestUnlocked bump={1} />);
    await act(async () => { await Promise.resolve(); });
    expect(el2.textContent).toContain("Nothing to watch here");

    // Stalled: last check far older than the sampling period.
    vi.spyOn(api, "standingLog").mockResolvedValue({
      entries: [], seq: 0, capacity: 400, playthrough: "pt",
      sampler: { ...alive, lastSampleAgo: 600 },
    });
    const el3 = rerender(<StandingPanels conn={conn} conquestUnlocked bump={2} />);
    await act(async () => { await Promise.resolve(); });
    expect(el3.textContent).toContain("Sampler stalled");

    // Throwing: surface the message rather than an innocent-looking empty list.
    vi.spyOn(api, "standingLog").mockResolvedValue({
      entries: [], seq: 0, capacity: 400, playthrough: "pt",
      sampler: { ...alive, lastError: "GetReputation missing" },
    });
    const el4 = rerender(<StandingPanels conn={conn} conquestUnlocked bump={3} />);
    await act(async () => { await Promise.resolve(); });
    expect(el4.textContent).toContain("Sampler failing: GetReputation missing");
  });

  it("reports a bridge failure instead of hanging on the loader", async () => {
    vi.spyOn(api, "reputation").mockRejectedValue(new Error("404 no player"));
    vi.spyOn(api, "standingLog").mockResolvedValue({ entries: [], seq: 0, capacity: 400, playthrough: null, sampler: alive });
    const el = mount(<StandingPanels conn={conn} conquestUnlocked />);
    await act(async () => { await Promise.resolve(); });
    expect(el.textContent).toContain("404 no player");
  });

  it("clamps a contribution that has climbed past the top rank", async () => {
    const over = standing();
    over.factions[0].conquest!.contribution = 5441;   // observed live against a 4,500 "max"
    vi.spyOn(api, "reputation").mockResolvedValue(over);
    vi.spyOn(api, "standingLog").mockResolvedValue({ entries: [], seq: 0, capacity: 400, playthrough: null, sampler: alive });
    const el = mount(<StandingPanels conn={conn} conquestUnlocked />);
    await act(async () => { await Promise.resolve(); });

    expect(el.textContent).toContain((5441).toLocaleString());
    const widths = [...el.querySelectorAll<HTMLElement>(".std-panel:last-child .std-bar i")].map((i) => parseFloat(i.style.width));
    expect(Math.max(...widths)).toBeLessThanOrEqual(100);
  });

  it("splits the change log by ladder and keeps a band crossing visible", async () => {
    localStorage.clear();
    vi.spyOn(api, "reputation").mockResolvedValue(standing());
    vi.spyOn(api, "standingLog").mockResolvedValue({
      entries: [
        logEntry(),
        logEntry({ seq: 2, ladder: "conquest", factionId: "MiningGuild", faction: "Mindus Holdings",
          delta: 120, value: 2916, tierWas: "Oracle's Chosen", tier: "Oracle's Chosen" }),
      ],
      seq: 2, capacity: 400, playthrough: "pt", sampler: alive,
    });
    const el = mount(<StandingPanels conn={conn} conquestUnlocked />);
    await act(async () => { await Promise.resolve(); });

    const logs = [...el.querySelectorAll(".std-log")];
    expect(logs).toHaveLength(2);
    const rep = logs[0].textContent ?? "", conq = logs[1].textContent ?? "";
    // Each entry belongs to exactly ONE stream — the two ladders must not bleed into each other.
    expect(rep).toContain("Steel Vultures");
    expect(rep).not.toContain("Mindus Holdings");
    expect(conq).toContain("Mindus Holdings");
    expect(conq).not.toContain("Steel Vultures");
    // A crossed band is shown; an unchanged one isn't repeated as noise.
    expect(rep).toContain("Wary → Hostile");
    expect(conq).not.toContain("→");
    expect(rep).toContain((-250).toLocaleString());
    expect(conq).toContain(`+${(120).toLocaleString()}`);
  });
});

describe("useOfficerBuilder", () => {
  it("mounts as a hook without a roster and then with one", () => {
    let seen: OfficerBuilder | null = null;
    const Probe = ({ officers }: { officers: Officer[] }) => {
      seen = useOfficerBuilder(officers, [], null);
      return null;
    };
    mount(<Probe officers={[]} />);
    expect(seen).toBeTruthy();
    rerender(<Probe officers={[officer("A")]} />);
    expect(seen!.catalog.length).toBeGreaterThan(0);
  });
});

