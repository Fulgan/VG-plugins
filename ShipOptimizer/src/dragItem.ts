import { useSyncExternalStore, type DragEvent } from "react";
import type { Item } from "./types";

// WHAT IS CURRENTLY BEING DRAGGED, held as one module-level fact rather than a context.
//
// A drag is singular and global: exactly one thing is in flight at a time, anywhere on the page. Threading a
// provider through every tab would say that less clearly than the browser already does.
//
// It has to exist at all because `dataTransfer` CANNOT BE READ DURING `dragover` — the spec puts it in
// protected mode until the drop itself — so a slot cannot ask "is this meant for me" at the one moment it
// needs to look like a target. The payload still rides on `dataTransfer` as well, so a drag that began outside
// the app carries nothing this store knows about and every slot stays inert.

let held: Item | null = null;
const listeners = new Set<() => void>();

const subscribe = (l: () => void) => { listeners.add(l); return () => { listeners.delete(l); }; };
const snapshot = () => held;
const emit = () => { for (const l of [...listeners]) l(); };

export const beginDrag = (it: Item) => { held = it; emit(); };
export const endDrag = () => { if (held !== null) { held = null; emit(); } };

/** The item in flight, or null. Re-renders a target when a drag starts, which is what arms it. */
export function useDragged(): Item | null {
  return useSyncExternalStore(subscribe, snapshot, () => null);
}

/**
 * The props that make something a drag SOURCE.
 *
 * THE DRAG IMAGE IS THE ITEM, NOT THE ROW. A row is the full width of the list, and its ghost covers the slot
 * the player is aiming at — the one thing they need to see while aiming. Any source can nominate a smaller
 * element by marking it `data-drag-image`; the icon is the obvious choice, and the row stays the drag HANDLE
 * so the whole thing is grabbable rather than one small square being the only live pixel.
 */
export function dragSource(it: Item) {
  return {
    draggable: true,
    onDragStart: (e: DragEvent<HTMLElement>) => {
      beginDrag(it);
      const img = e.currentTarget.querySelector<HTMLElement>("[data-drag-image]");
      if (img) e.dataTransfer.setDragImage(img, img.offsetWidth / 2, img.offsetHeight / 2);
      // Never read back (see above), but some platforms refuse to start a drag that carries no payload at all.
      e.dataTransfer.setData("text/plain", it.name);
      e.dataTransfer.effectAllowed = "copy";
    },
    onDragEnd: endDrag,
  };
}
