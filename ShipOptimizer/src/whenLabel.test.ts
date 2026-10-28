import { describe, it, expect } from "vitest";
import { whenLabel } from "./StandingPanels";

// A bare clock on a row from last week reads as this morning. The column has to say which day once it is not
// today, and say nothing it cannot know when the bridge sends no day at all.
describe("when a logged standing change happened", () => {
  const today = new Date(2026, 8, 6, 14, 0, 0);   // 2026-09-06
  it("shows the clock alone for today", () => {
    expect(whenLabel({ t: "09:23:41", day: "2026-09-06" }, today)).toBe("09:23:41");
  });
  it("names yesterday and the days before it", () => {
    expect(whenLabel({ t: "09:23:41", day: "2026-09-05" }, today)).toBe("yesterday 09:23:41");
    expect(whenLabel({ t: "09:23:41", day: "2026-09-03" }, today)).toBe("3 days ago 09:23:41");
  });
  // Past a week the count stops helping and the date itself is the shorter statement.
  it("falls back to the date once a week has passed", () => {
    expect(whenLabel({ t: "09:23:41", day: "2026-08-20" }, today)).toBe("2026-08-20 09:23:41");
  });
  // Whole days, not hours: 23:00 and 01:00 are a day apart across a midnight the player watched pass.
  it("counts calendar days rather than elapsed hours", () => {
    expect(whenLabel({ t: "23:50:00", day: "2026-09-05" }, new Date(2026, 8, 6, 0, 10, 0))).toBe("yesterday 23:50:00");
  });
  it("shows the time alone when the bridge sends no day", () => {
    expect(whenLabel({ t: "09:23:41" }, today)).toBe("09:23:41");
  });
});
