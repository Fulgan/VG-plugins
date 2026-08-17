// Tooltip placement. Reported by a player as five gear tooltips along the top of the window, each with its
// first lines missing — the item's name and headline, which is everything the tooltip is for.
//
// The old rule flipped around the viewport midpoint, which chooses a DIRECTION and never checks that the box
// FITS. These pin the property that was missing: whatever the cursor position and however big the box, the
// result is inside the window.
import { describe, expect, it } from "vitest";
import { tipPlacement } from "./useCursorTip";

const VW = 1280, VH = 800;
const EDGE = 8;

const inside = (p: { left: number; top: number }, w: number, h: number, vw = VW, vh = VH) =>
  p.left >= EDGE && p.top >= EDGE && p.left + w <= vw - EDGE && p.top + h <= vh - EDGE;

describe("tipPlacement", () => {
  it("puts the box away from the cursor when there is room", () => {
    const p = tipPlacement(100, 100, 320, 400, VW, VH);
    expect(p.left).toBeGreaterThan(100);
    expect(p.top).toBeGreaterThan(100);
    expect(inside(p, 320, 400)).toBe(true);
  });

  // The reported case: a cursor just past the vertical midpoint, and a tooltip tall enough that growing upward
  // runs off the top. The old rule anchored it upward anyway and the head of it was clipped.
  it("keeps a tall box inside the top edge for a cursor just past the midpoint", () => {
    const h = 520;
    const p = tipPlacement(600, VH / 2 + 20, 320, h, VW, VH);
    expect(p.top).toBeGreaterThanOrEqual(EDGE);
    expect(inside(p, 320, h)).toBe(true);
  });

  it("keeps a wide box inside the right edge near the right side", () => {
    const w = 520;
    const p = tipPlacement(VW - 40, 300, w, 200, VW, VH);
    expect(p.left + w).toBeLessThanOrEqual(VW - EDGE);
    expect(inside(p, w, 200)).toBe(true);
  });

  it("lands inside the window from every corner, for a box that only just fits", () => {
    const w = VW - 200, h = VH - 200;
    for (const [x, y] of [[0, 0], [VW, 0], [0, VH], [VW, VH], [VW / 2, VH / 2]]) {
      const p = tipPlacement(x, y, w, h, VW, VH);
      expect(inside(p, w, h), `${x},${y}`).toBe(true);
    }
  });

  // A box larger than the viewport cannot be placed; it is pinned to the near edge and scrolls (the hook caps it
  // with max-height). What must NOT happen is a negative offset, which is the clipping this fixed.
  it("never places a box off the top or left, even when it cannot fit at all", () => {
    for (const [w, h] of [[2000, 2000], [400, 5000], [5000, 400]]) {
      for (const [x, y] of [[10, 10], [VW - 10, VH - 10], [VW / 2, VH / 2 + 20]]) {
        const p = tipPlacement(x, y, w, h, VW, VH);
        expect(p.left, `${w}x${h} @ ${x},${y}`).toBeGreaterThanOrEqual(EDGE);
        expect(p.top, `${w}x${h} @ ${x},${y}`).toBeGreaterThanOrEqual(EDGE);
      }
    }
  });

  // A small window is where the box is largest relative to the viewport — the same case as browser zoom above
  // 100%, which is how a player hits this without resizing anything.
  it("holds at a small window, where the box is large relative to the viewport", () => {
    const vw = 700, vh = 420;
    const p = tipPlacement(360, 300, 380, 360, vw, vh);
    expect(inside(p, 380, 360, vw, vh)).toBe(true);
  });

  it("clears the cursor rather than sitting under the pointer", () => {
    const p = tipPlacement(400, 400, 200, 200, VW, VH);
    // the box starts below-right of the pointer, not on it
    expect(p.left).toBeGreaterThanOrEqual(400);
    expect(p.top).toBeGreaterThanOrEqual(400);
  });
});
