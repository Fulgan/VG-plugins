import type { Item } from "./types";

// Editable link map to the Vanguard Galaxy wiki. Add/adjust entries here — the UI reads it live.
export const WIKI_BASE = "https://wiki.vanguardgalaxy.com";

// Section pages by equipment kind. Extend `byType`/`byName` for finer targets or images.
export const WIKI = {
  base: WIKI_BASE,
  byKind: {
    Turret: "/Turrets",
    Module: "/Modules",
    Booster: "/Boosters",
  } as Record<string, string>,
  aspects: "/Aspects",
  ammo: "/Ammo",
  items: "/Items",
  // Optional finer overrides, keyed by the item's `type` (e.g. "Reactor": "/Modules#reactor").
  byType: {} as Record<string, string>,
  // Optional per-item image URLs, keyed by identifier or type. Fill in as you gather them.
  images: {} as Record<string, string>,
};

export const wikiUrl = (path: string) => (path.startsWith("http") ? path : WIKI_BASE + path);

// Best wiki page for an item: type override → kind section → Items.
export function itemWiki(item: Item, kind: string | null): string | null {
  if (item.type && WIKI.byType[item.type]) return wikiUrl(WIKI.byType[item.type]);
  if (kind && WIKI.byKind[kind]) return wikiUrl(WIKI.byKind[kind]);
  return wikiUrl(WIKI.items);
}

export const aspectWiki = () => wikiUrl(WIKI.aspects);

// Optional item image (returns null until a URL is mapped).
export function itemImage(item: Item): string | null {
  return (item.identifier && WIKI.images[item.identifier]) || (item.type && WIKI.images[item.type]) || null;
}
