// DTOs mirrored from the InventoryBridge HTTP API (phase 1).

export interface StatLine {
  stat: string;
  amount: number;
  multiplier: number;
  canReroll?: boolean; // reroll flag: fresh item all-true; after a reroll only the rerollable one is true
}

export interface Aspect {
  name: string;
  description: string;
}

// Resonant-booster unlock state (progress toward its bonus + the bonus itself).
export interface Resonance {
  unlocked: boolean;
  progress: number;
  threshold: number;
  unit: string; // kills | boardings | ore | scrap | profit | absorbed
  bonus?: string; // game-formatted unlock bonus, e.g. "+2.22% Reload Speed"
  bonusStat: string;
}

export interface Item {
  key: number | null; // slot handle within its store/shop; null for loadout entries
  slot: number | null;
  identifier: string | null;
  name: string;
  rarity: string;
  level: number;
  size: string | null;
  slotType?: string | null; // equipment slot: Hardpoint (weapons), Reactor, ShieldGenerator, …
  type: string | null; // readable equipment type, e.g. "Plasma Beam"
  category: string;
  sellValue: number;
  volume?: number;
  mainStat?: { name: string; amount: string } | null;
  damageType?: string | null; // turrets
  gameplayType?: string | null; // turrets: Combat | Mining | Salvage
  targetLayer?: string | null; // mining/salvage turrets: Surface | Core | Both
  powerUsage?: number | null; // energy draw (effective; changed by aspects)
  emp?: number | null; // turrets: EMP factor per second (0 = none)
  range?: number | null; // turrets: effective weapon range
  manufacturer?: string | null; // brand, e.g. "Spirit Design"
  fireRate?: number | null; // turrets: attacks per second (sustained, incl. burst + reload)
  ammo?: string | null; // turrets: required ammo
  ammoPerMin?: number | null; // turrets: sustained ammo consumed per minute (fireRate×60×ammoPerShot÷shotsPerAmmo)
  aspects: Aspect[];
  aspectSlots?: number; // fixed slot count — part of item identity
  stats: StatLine[];
  substats: StatLine[]; // "item bonuses" — non-main stat lines
  bonus: number | null; // quality/upgrade level 0..25
  bonusStat: string | null; // stat the quality affix boosts
  resonance?: Resonance | null; // resonant boosters only
  count?: number; // stores only
  // client-side / shop annotations
  location?: string; // which store/shop the item is in
  cost?: number; // shop: credit price
  costItem?: string | null; // shop: barter item id (if bartered)
  costItemCount?: number; // shop: barter qty (per unit)
  costItemOwned?: number; // shop: how many of the barter item the player owns (affordability)
  stock?: number; // shop: units in stock, -1 = infinite
}

export interface Shop {
  id: string;
  facility: string;
  items: Item[];
}

export interface Shops {
  shops: Shop[];
}

export interface LogEntry {
  t: string;
  source: string;
  text: string;
}

export interface Logs {
  entries: LogEntry[];
}

export interface Store {
  id: string; // cargo | armory | material
  items: Item[];
}

export interface ModuleSlot {
  slot: string | null;
  item: Item;
}

export interface Loadout {
  shipGuid: string;
  name: string;
  shipType?: string | null; // ship class, e.g. "Chisel Mk I"
  role?: string | null;
  hardpoints: Item[]; // each carries its slot index
  hardpointSlots?: number; // total incl. empty
  modules: ModuleSlot[];
  boosters: Item[]; // each carries its slot index
  boosterSlots?: number; // total incl. empty
  error?: string;
}

export interface Ships {
  ships: Loadout[];
}

export interface Status {
  docked: boolean;
  station: string | null;
  lastStation?: string | null;
  shipGuid: string | null;
  shipType?: string | null; // ship class, e.g. "Chisel Mk I"
  role?: string | null; // Combat | Mining | Salvaging | Cargo | Generic
  credits: number;
  crewSupported?: boolean; // game >= 0.8.1.19 — gate the (future) crew optimizer
  gameVersion?: string;
  pluginVersion?: string;
  playthrough?: string | null; // stable per-save id — web drops stale cache when it changes
  playthroughName?: string | null; // user-chosen pretty name for the playthrough (null = unnamed)
}

export interface Inventories {
  stores: Store[];
}

// A candidate loadout the user assembles client-side (never sent to the game — V6).
export interface Build {
  id: string;
  name: string;
  items: Item[]; // flat list of chosen equipment
}

// ---- officers (GET /officers) ----

// One captain skill-node an officer grants (+1 rank; ranks stack across officers).
export interface OfficerSkill {
  id: string; // stable node identifier
  name: string; // display name — key into the skill↔role table
  tier: number;
  major: boolean; // the powerful single-slot skill (vs a stacking minor)
  unlock?: number; // level the slot activates at (ascending = activation order)
}

export interface Officer {
  guid: string;
  name: string;
  callsign: string;
  profession: string;
  rarity: string;
  level: number;
  gender: string;
  icon: string | null; // portrait sprite id (GET /officers/portrait?guid=…)
  chosenBonus: string; // the officer's chosen passive stat (EquipStat name)
  bonusValue?: number; // effective passive bonus for that stat (fraction, 0.006 = 0.6%)
  current: OfficerSkill[]; // skills active at the officer's level
  potential: OfficerSkill[]; // all rolled slots (max level)
}

// Per-ship officer-slot info.
export interface OfficerShip {
  shipGuid: string;
  slots: number;
  hasDroneBay: boolean;
  assigned: (string | null)[]; // officer guid (or null) in each slot
}

export interface Officers {
  ships: OfficerShip[];
  officers: Officer[];
  error?: string;
}

// GET /recruits — recruitable officers at the docked station's Personnel Center.
export interface Recruits {
  station: string | null;
  hasPersonnelCenter: boolean;
  officers: (Officer & { hireCost: number })[];
  error?: string;
}

// POST /loadout/apply — a partial additive transient (gear fingerprints + officer slot→guid).
export interface ApplyRequest {
  slots?: unknown[]; // gear fingerprints (unused by the officer UI yet)
  officers?: { slot: number; guid: string }[];
}
export interface ApplyResult {
  applied?: boolean;
  pending?: boolean; // queued (undocked) — applies on next dock
  changed: number;
  stale?: number; // exact-handle gear slots skipped because the item moved since the client's refresh
  prior?: boolean; // undo available
  error?: string;
}
export interface UndoResult {
  restored: number;
}
export interface LoadoutPresetInfo { name: string; ship: string; shipGuid?: string | null; rawKey?: string; gearSlots: number; officers: number; }
// GET /catalog/types — every turret type / damage type / module slot that exists in the game (for gear filters).
export interface CatalogTypes {
  turrets: { type: string; category: string; damageType: string }[];
  damageTypes: string[];
  moduleSlots: string[];
}
// GET /ship/layout — hardpoint mount positions on the rendered ship image (for the positional editor).
export interface ShipHardpoint {
  index: number;
  size: string;
  rotate: number;
  u: number; // normalized image coords, origin top-left
  v: number;
  equipped: Item | null; // full item DTO (mainStat/stats/aspects) so the UI can compare + tooltip
}
export interface ShipLayout {
  shipGuid: string;
  name: string;
  image: { w: number; h: number };
  hardpoints: ShipHardpoint[];
  modules: { slot: string; size: string; equipped: Item | null }[];
  diag?: Record<string, unknown>;
}
export interface PendingResult {
  pending: boolean | null;
  gearSlots?: number;
  officers?: number;
}
