import { describe, expect, it } from "vitest";
import { nextSpark, sparkGap, type Lane } from "./mapSpark";

const lane = (key: string, len: number): Lane => ({ key, x1: 0, y1: 0, x2: len, y2: 0 });

describe("nextSpark", () => {
  it("has nothing to launch when no lane is passable", () => {
    expect(nextSpark([], () => 0.5)).toBeNull();
  });

  it("paces a dot by DISTANCE, so a long hop takes longer than a short one", () => {
    const short = nextSpark([lane("a", 60)], () => 0.4)!;
    const long = nextSpark([lane("b", 300)], () => 0.4)!;
    expect(long.ms).toBeGreaterThan(short.ms);
  });

  // Speed is rolled per spark, so two dots down the SAME lane do not travel in step.
  it("varies pace between sparks on one lane", () => {
    const l = [lane("a", 200)];
    expect(nextSpark(l, () => 0.05)!.ms).toBeGreaterThan(nextSpark(l, () => 0.95)!.ms);
  });

  // A one-frame flash and a dot that sits on the map are both worse than no animation at all.
  it("keeps every duration inside its bounds, however long the lane", () => {
    for (const len of [0, 1, 40, 400, 4000])
      for (const roll of [0, 0.5, 0.999]) {
        const s = nextSpark([lane("l", len)], () => roll)!;
        expect(s.ms).toBeGreaterThanOrEqual(550);
        expect(s.ms).toBeLessThanOrEqual(3400);
      }
  });

  // `rand()` returning exactly 1 is out of contract for Math.random but in range for a stub, and an index off
  // the end would render a spark on `undefined` endpoints (NaN in the path, an invisible permanent element).
  it("stays inside the lane list at both ends of the roll", () => {
    const lanes = [lane("a", 10), lane("b", 20), lane("c", 30)];
    expect(nextSpark(lanes, () => 0)!.lane.key).toBe("a");
    expect(nextSpark(lanes, () => 1)!.lane.key).toBe("c");
    expect(nextSpark(lanes, () => 0.999999)!.lane.key).toBe("c");
  });

  it("runs sparks both ways down the network", () => {
    const lanes = [lane("a", 10)];
    expect(nextSpark(lanes, () => 0.1)!.back).toBe(true);
    expect(nextSpark(lanes, () => 0.9)!.back).toBe(false);
  });
});

describe("sparkGap", () => {
  it("stays inside its bounds, so the map neither goes quiet nor gets busy", () => {
    for (const roll of [0, 0.25, 0.5, 1]) {
      expect(sparkGap(() => roll)).toBeGreaterThanOrEqual(220);
      expect(sparkGap(() => roll)).toBeLessThanOrEqual(1300);
    }
  });
});
