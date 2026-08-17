// Which stations still have an Umbral daily today.
//
// The game keeps this itself, per station and in the save: `MissionBoard.umbralMission` is the offer and
// `umbralMissionDate` the `DateTime.Now.DayOfYear` it last rolled on. So the question a player has — "which
// station have I not used today" — is a READ of the game's own state, and there is no ledger of ours to drift
// from it. What these tests pin is the READING of that pair, which is the part that could be wrong:
//
//   date ≠ today          the board will roll a fresh one when you arrive     → somewhere to go
//   date = today, offer   it rolled today and nobody took it                  → somewhere to go, right now
//   date = today, none    you have had today's                                → nothing here until midnight
//
// The reset is the MACHINE's midnight, which is why `today` comes from the bridge (the same clock the game read)
// rather than from the browser's own idea of a day.
import { describe, it, expect } from "vitest";
import { colorFor, rawColorFor, umbralInfected, umbralStateOf, umbralSystemState } from "./MapTab";

const TODAY = 218;

describe("one station's daily", () => {
  it("says NONE where there is not enough umbral presence to offer one", () => {
    // Presence is a LEVEL: the daily needs 0.05 control and the umbral SHOP needs 0.5, so "no shop" is not the
    // same fact — the bridge has already applied the threshold it read off the build.
    expect(umbralStateOf({ umbralMissions: false, umbralDailyDate: TODAY, umbralDailyWaiting: true }, TODAY))
      .toBe("none");
  });

  it("says AWAY when the board last rolled on another day — it will roll again on arrival", () => {
    expect(umbralStateOf({ umbralMissions: true, umbralDailyDate: 217, umbralDailyWaiting: false }, TODAY))
      .toBe("away");
    expect(umbralStateOf({ umbralMissions: true, umbralDailyDate: 3, umbralDailyWaiting: true }, TODAY))
      .toBe("away");
  });

  it("says WAITING when today's is still on the board", () => {
    expect(umbralStateOf({ umbralMissions: true, umbralDailyDate: TODAY, umbralDailyWaiting: true }, TODAY))
      .toBe("waiting");
  });

  it("says SPENT when today's is gone", () => {
    expect(umbralStateOf({ umbralMissions: true, umbralDailyDate: TODAY, umbralDailyWaiting: false }, TODAY))
      .toBe("spent");
  });

  // A station that has never rolled one, and a bridge too old to report the day, are both "no reading" — and the
  // honest answer to no reading is the state that sends you to look, not the one that says you are done.
  it("treats a missing date or a missing clock as somewhere still worth going", () => {
    expect(umbralStateOf({ umbralMissions: true, umbralDailyWaiting: false }, TODAY)).toBe("away");
    expect(umbralStateOf({ umbralMissions: true, umbralDailyDate: TODAY, umbralDailyWaiting: false }, undefined))
      .toBe("away");
  });
});

describe("a system with several stations", () => {
  it("reports the best of them: one unclaimed daily is a reason to fly there", () => {
    const spent = { umbralMissions: true, umbralDailyDate: TODAY, umbralDailyWaiting: false };
    const waiting = { umbralMissions: true, umbralDailyDate: TODAY, umbralDailyWaiting: true };
    const fresh = { umbralMissions: true, umbralDailyDate: 200, umbralDailyWaiting: false };
    expect(umbralSystemState([spent, waiting], TODAY)).toBe("waiting");
    expect(umbralSystemState([spent, fresh], TODAY)).toBe("away");
    expect(umbralSystemState([spent, spent], TODAY)).toBe("spent");
    expect(umbralSystemState([{ umbralMissions: false }], TODAY)).toBe("none");
    expect(umbralSystemState(undefined, TODAY)).toBe("none");
  });
});

// The virus, as opposed to the daily: a station can be infected and offer neither a mission (0.05) nor a shop
// (0.5), and that is the state the eye on the node exists to show — spreading, before it has a consequence.
describe("umbralInfected", () => {
  it("marks any presence at all, however small", () => {
    expect(umbralInfected([{ umbralControl: 0.01 }])).toBe(true);
    expect(umbralInfected([{ umbralControl: 0.9 }])).toBe(true);
  });

  it("does not mark a clean system, and treats a missing figure as clean", () => {
    // The bridge omits `umbralControl` when it is zero ∴ absent must mean clean, not unknown-so-flag-it.
    expect(umbralInfected([{}])).toBe(false);
    expect(umbralInfected([{ umbralControl: 0 }])).toBe(false);
    expect(umbralInfected([])).toBe(false);
    expect(umbralInfected(undefined)).toBe(false);
  });

  it("marks the system when only one of its stations is infected", () => {
    expect(umbralInfected([{}, { umbralControl: 0.2 }])).toBe(true);
  });

  // The eye is INDEPENDENT of the daily: infected with today's daily already spent still shows the virus.
  it("is a different question from the daily's state", () => {
    const spent = { umbralControl: 0.3, umbralMissions: true, umbralDailyDate: TODAY, umbralDailyWaiting: false };
    expect(umbralSystemState([spent], TODAY)).toBe("spent");
    expect(umbralInfected([spent])).toBe(true);
  });
});

// The node paints the faction twice on purpose: a normalised FILL that can carry a level digit, and a 1px RIM in
// the game's own value. A rim that fell back to the palette would make the two indistinguishable and the rim
// pointless; a fill that used the raw value is the unreadable case fixed.
describe("rawColorFor", () => {
  const factions = [{ id: "Blue", name: "Stellar Industries", conquestColor: "#0004ff", color: "#0004ff" }];

  it("returns the game's exact value, where the fill is normalised away from it", () => {
    expect(rawColorFor(factions, "Blue", "Stellar Industries")).toBe("#0004ff");
    expect(colorFor(factions, "Blue", "Stellar Industries")).not.toBe("#0004ff");
  });

  it("falls back to the name hash for a faction the payload does not list", () => {
    const unknown = rawColorFor(factions, "Missing", "Some Faction");
    expect(unknown).toMatch(/^hsl\(/);
  });
});
