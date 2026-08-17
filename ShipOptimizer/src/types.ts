// DTOs mirrored from the InventoryBridge HTTP API (phase 1).

export interface StatLine {
  stat: string;
  amount: number;
  multiplier: number;
  canReroll?: boolean; // reroll flag: fresh item all-true; after a reroll only the rerollable one is true
  // The game's own `EquipStat.IsPercentageStat`: `amount` is a FRACTION, so 0.0141 means +1.41%. Decided by
  // ranges over the game's enum and therefore not reproducible here — it must arrive from the bridge.
  percent?: boolean;
  // WHOSE stat this line moves, on an ASPECT's line only (an item's own lines always pool — V16).
  //
  //   "ship"    a `BoostStat`, an `IEquipStatSource` registered on the UNIT ∴ it joins the pool and lifts every
  //             gun, exactly like a module's line.
  //   "weapon"  a `TurretBoostStat`, folded by `AbstractEquipment.GetStat` into THAT WEAPON alone — what
  //             `CalculateDamage` reads as `sourceTurret.GetStat(...)`.
  //
  // Pooling a "weapon" line overstates it by the whole battery, so scoring must keep them apart. Absent on an
  // older bridge, where every aspect line was assumed pooled.
  scope?: "ship" | "weapon";
}

export interface Aspect {
  id?: string;        // EquipAspect.identifier — the handle for GET /aspects/icon
  name: string;
  description: string;
  // Stat lines the aspect GRANTS. Absent from the item's own `stats[]`, because a stat-granting aspect is a
  // `BoostStat` registered on the unit rather than on the item — so ranking must add these itself.
  stats?: StatLine[];
}

// Resonant-booster unlock state (progress toward its bonus + the bonus itself).
export interface Resonance {
  unlocked: boolean;
  progress: number;
  threshold: number;
  unit: string; // kills | boardings | ore | scrap | profit | absorbed
  bonus?: string; // game-formatted unlock bonus at FULL progress, e.g. "+2.22% Reload Speed"
  /** What it pays TODAY, formatted by the game (`GetScaledUnlockBonus`). Absent on an older bridge. */
  bonusNow?: string;
  /**
   * The numbers behind the line, because the two kinds are worth entirely different things: `bonusAmount` ADDS to
   * the ship's pool for that stat, while `bonusMultiplier` scales the WHOLE pool — every gun, booster and hull
   * contribution to it (`AbstractUnitData.ApplyStatSourceLines`). One of the two is always the identity.
   */
  bonusAmount?: number;
  bonusMultiplier?: number;
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
  // Base draw (`capacityCost`), the same basis whether or not the item is fitted. `powerUsage` is effective for a
  // FITTED item and base for a stored one, so only this field can compare the two.
  powerUsageBase?: number | null;
  emp?: number | null; // turrets: EMP factor per second (0 = none)
  range?: number | null; // turrets: effective weapon range
  manufacturer?: string | null; // brand, e.g. "Spirit Design"
  fireRate?: number | null; // turrets: attacks per second (sustained, incl. burst + reload) — BASE rate:
                            // built from raw _fireDelay/_maxMagSize/_reloadDelay, so no speed bonuses
  // ---- turret ranking inputs (absent on a bridge older than these fields) ----
  // RAW serialized cycle components, so a client can rebuild defaultAttacksPerSecond and re-run it with the
  // item's OWN speed rolls. Deliberately not the boosted properties: those divide by GetStat(), which on a
  // fitted turret includes ship/crew bonuses that are equal for every candidate and must not enter a
  // comparison. See src/turretScore.ts.
  fireDelayRaw?: number | null;
  reloadDelayRaw?: number | null;
  magSizeRaw?: number | null;
  burstAmount?: number | null;
  burstDelay?: number | null;
  damageSpreadMean?: number | null; // mean of the per-hit RandomRange(0.8, 1.25) — same for all, informational
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
  // What `POST /sell` refuses. A client that cannot see these has to attempt a sale to
  // discover the refusal, which is backwards for `favourite` — the one a player sets deliberately.
  // `favourite` is per STACK, so it is absent (not false) wherever there is no store entry.
  canSell?: boolean;
  favourite?: boolean;
  missionItem?: boolean;
  criticalItem?: boolean;
  // client-side / shop annotations
  slotKey?: string; // equipped items only: "t:<i>" | "m:<EquipmentSlot>" | "b:<i>" — resolves their icon,
                    // which has no store handle to look up (see api.itemImageBySlot)
  location?: string; // which store/shop the item is in
  cost?: number; // shop: credit price
  costItem?: string | null; // shop: barter item id (if bartered)
  costItemCount?: number; // shop: barter qty (per unit)
  costItemOwned?: number; // shop: how many of the barter item the player owns (affordability)
  stock?: number; // shop: units in stock, -1 = infinite
  // shop: the player's OWN stock, handed back after a sale. Absent means the station's own — every row
  // in the ordinary answer — so this is only ever true.
  buyback?: boolean;
}

export interface Shop {
  id: string;
  facility: string;
  items: Item[];
  // How many of this shop's rows are the player's OWN stock, handed back after a sale. Reported whether or not
  // those rows were asked for, so the tab can offer them by number instead of hiding that they exist.
  buybackCount?: number;
}

export interface Shops {
  shops: Shop[];
  station?: string | null;
  // Seconds until this station's stock rolls over, null when unknowable. Offer keys are slot indices that
  // get reused on restock, so this is the deadline after which a cached list must not be bought from.
  refreshesIn?: number | null;
  refreshInterval?: number | null;
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

// What the running GAME build supports. The plugin is one binary that loads on both the public release and
// the beta, and they don't carry the same API — so features are hidden rather than offered-and-broken.
// Every flag is optional: an older bridge sends no `caps` at all, and the UI must not read that as "off".
export interface Caps {
  crew?: boolean;         // officers/crew (release renamed the whole namespace)
  shopRefresh?: boolean;  // shop restock countdown
  conquest?: boolean;     // conquest map + umbral state
  // The release cuts each turret's share again once the battery grows (see EXTRA_TURRET_PENALTY in fleetDps.ts).
  // Beta 0.8.1.19 deleted that formula and compensated with enemy HP, so scoring a beta build with the ladder
  // — or a release build without it — misprices every multi-turret set.
  extraTurretPenalty?: boolean;
}

// One spendable currency: the identifier a barter offer's `costItem` carries, its display name, and holdings.
export interface Currency {
  id: string;
  name: string;
  owned: number;
}

export interface Status {
  docked: boolean;
  station: string | null;
  lastStation?: string | null;
  shipGuid: string | null;
  shipType?: string | null; // ship class, e.g. "Chisel Mk I"
  role?: string | null; // Combat | Mining | Salvaging | Cargo | Generic
  credits: number;
  /** The player's OWN level (the commander's). Absent on a bridge that predates it, and the difference matters:
   *  without it a "vs mine" filter can only compare against the highest item level owned, which is not a level
   *  — it makes the best item's own relative level 0 and every other item negative. */
  level?: number | null;
  // Every currency the RUNNING build ships, not a fixed set: the release has four commendations and no
  // `VanguardMark`, the beta the same four plus it — so the wallet is whatever the bridge enumerated out of the
  // item registry. Counted by the same call the shop DTO uses for `costItemOwned`, so the header and an offer's
  // "you have" agree. Absent on an older bridge — fall back to `vanguardMarks`.
  currencies?: Currency[] | null;
  // The beta's barter currency alone, kept for older bridges only. Prefer `currencies`.
  vanguardMarks?: number | null;
  crewSupported?: boolean; // game >= 0.8.1.19 — gate the (future) crew optimizer
  caps?: Caps;             // what the running game build supports; absent on an older bridge
  gameVersion?: string;
  pluginVersion?: string;
  // Crit setup of the CURRENT ship, effective (ship + hull + crew + gear) — read off the live unit, with the
  // class defaults as fallback. Ship-wide, so the same for every gear candidate, but not a constant that
  // cancels: a high crit chance is what makes a turret's Critical Damage roll valuable.
  // False when the live ship object wasn't resolvable, so the crit values below are class-level fallbacks and
  // the pools are absent. Indistinguishable from real readings otherwise (0.03 is a plausible crit chance).
  hasPersonalHangar?: boolean;
  statsLive?: boolean;
  critChance?: number | null;
  // The multiplier half of CriticalChance. The reported chance is (base + curve + additive) * multiplier, so
  // the product alone cannot be split back into its parts.
  critChanceMult?: number | null;
  // Skill-tree term the game adds to the COMBAT pool's reactor factor, in the top bracket only.
  combatReactorOutputCP?: number | null;
  critDamage?: number | null;
  megaCrit?: number | null;   // how many times one hit may crit (combatMegaCrit skill points)
  // Ship-level POOLS, for set-level turret optimisation. Every stat an item rolls registers on the UNIT, so
  // a Precision or Combat Power roll on one gun benefits every gun — gear cannot be ranked slot by slot.
  // These include the currently equipped turrets; subtract their own contributions to get the fixed
  // background (hull + crew + modules).
  poolCombatPower?: number | null;
  poolPrecision?: number | null;
  equivalentTurrets?: number | null;  // GetEquivalentTurretsCount(CombatPower) — shares the power pool out
  // Mining and salvage guns feed their own pools, each with its own equivalent-turret divisor — the count is per
  // stat, so the combat one would misprice a mixed battery. Without these a non-combat battery has no objective
  // and every candidate ties.
  poolMiningPower?: number | null;
  poolSalvagePower?: number | null;
  equivalentTurretsMining?: number | null;
  equivalentTurretsSalvage?: number | null;
  precisionDivisor?: number | null;   // 25 x GameMath.DamageMultiplier(level); Precision is measured against it
  // Reactor budget, straight off the ship's reactor module. `energyUsage` (used/capacity) decides a bracketed
  // multiplier on the Power/Combat/Mining/Salvage pools — see reactor.ts — so a build's draw changes its
  // damage, and `reactorBonus` is the modifier currently baked into the pools above. Null with no reactor.
  energyCapacity?: number | null;
  energyUsed?: number | null;
  energyUsage?: number | null;
  reactorBonus?: number | null;
  // The same skill-tree increase `combatReactorOutputCP` carries. Two names for one value, kept for clients
  // written against either; this one is UNREAD here, because the client resolves the whole budget once through
  // `poolsFromStatus` and everything downstream projects it out of the pools.
  reactorCombatBonus?: number | null;
  playthrough?: string | null; // stable per-save id — web drops stale cache when it changes
  playthroughName?: string | null; // user-chosen pretty name for the playthrough (null = unnamed)
}

export interface Inventories {
  stores: Store[];
}

// A candidate loadout the user assembles client-side (never sent to the game).
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
export interface LoadoutPresetInfo { name: string; ship: string; shipGuid?: string | null; rawKey?: string; gearSlots: number; officers: number; settings?: string | null; }
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

// ---- galaxy map (GET /galaxy) -------------------------------------------------------------------
// Knowledge is subsector-scoped, enforced server-side: a subsector you've never entered isn't in the
// payload at all, so the map can't draw what you couldn't know. `visited` systems add POI/station
// detail; `known` ones carry what the game's own tooltip shows (level, owner, stations).
export interface GalaxySystem {
  guid: string; name: string; sector: string;
  knowledge: "visited" | "known";
  level?: number; faction?: string | null; factionId?: string | null; storyId?: string | null; pocket?: boolean;
  x: number; y: number; sx: number; sy: number;
  lastVisited?: number; unlocked?: boolean; jumpgateOpen?: boolean;
  poiKinds?: Record<string, number>;
  stations?: {
    name: string; faction: string | null; factionId?: string | null; kind: string; shops?: string[];
    refreshTime?: number; refreshInterval?: number; due?: boolean | null; recruitsIn?: number | null;
    missionsIn?: number | null; missionsFresh?: boolean | null;
    /** Umbral control at this station, 0..1. The DAILY is offered above 0.05, the umbral shop only above 0.5. */
    umbralControl?: number;
    /** Whether that level clears the daily's threshold — both consts are read off the build. */
    umbralMissions?: boolean;
    /** `DateTime.Now.DayOfYear` when this board last rolled its daily. Compare against `umbralToday`. */
    umbralDailyDate?: number;
    /** Whether a daily is sitting on the board right now. */
    umbralDailyWaiting?: boolean;
  }[];
  missions?: { name: string; description?: string; storyId?: string; complete?: boolean }[];
  materials?: { volume: number; distinct: number; items: string[] };   // "Materials stored: 1,764m3"
  conquest?: {
    combatStrength: number; controlLevel: number; playerControlLevel: number; umbralControlLevel: number;
    baseReinforcements: number; hqReinforcements: number; totalReinforcements: number;
    headquarters: boolean; faction: string | null; station: string | null;
  };
}
export interface GalaxySector {
  guid: string; name: string; quadrant: number; conquest: boolean;
  level?: number; levelRange?: [number, number]; x: number; y: number;
}
export interface GalaxyEdge {
  from: string; to: string | null; gate: string; name: string; kind: string;
  crossSector: boolean; open?: boolean; usable?: boolean; passGuid?: string; leadsOut?: boolean;
}
export interface Galaxy {
  playthrough: string | null; currentSystem: string | null; levelCap?: number;
  quadrants: { id: number; name: string; sectors: string[] }[];
  sectors: GalaxySector[]; systems: GalaxySystem[]; edges: GalaxyEdge[];
  recent: { guid: string; name: string; lastVisited: number }[];
  counts: Record<string, number>;
  conquest?: ConquestStatus | null;
  // Shops roll over on one galaxy-wide boundary; per-station only the phase differs (see station.due).
  shopRestock?: { nextIn?: number | null; interval?: number | null } | null;
  // A mission board is NOT on a galaxy-wide cycle: each board has its own timer, advanced everywhere but reset
  // only where you are. This is the board of the station named in `station` — the one you would fly back to —
  // and `fresh` says it has already come due, so it rerolls the moment you dock.
  missionRestock?: { nextIn?: number | null; interval?: number | null; station?: string | null; fresh?: boolean | null } | null;
  /**
   * TODAY as the game counts it — `DateTime.Now.DayOfYear` — because that is what a mission board stores against
   * its daily. Comparing against anything else (UTC, a locally computed day) reads someone else's day, and the
   * reset is the MACHINE's midnight. `umbralYear` is for display: the game keeps no year beside the day, so a
 * stored day from a year ago is ambiguous for the game as much as for us.
   */
  umbralToday?: number;
  umbralYear?: number;
  // Faction identity + the GAME's own colours, so territory shading matches the in-game map.
  factions?: GalaxyFaction[];
}

// Galaxy-wide conquest state. `tickIn` is the live countdown to the next conquest tick (seconds).
// `umbralForShop`/`umbralForMissions` are the game's own gate thresholds as fractions (0-1).
export interface GalaxyFaction {
  id: string;
  name: string | null;
  conquestColor?: string | null;   // what the conquest map paints territory with
  color?: string | null;           // the faction's general colour
  relationColor?: string | null;   // tracks your standing, not identity
}

export interface ConquestStatus {
  tickIn: number; tickDelay: number; lastTick: string; umbralContribution: number;
  umbralForShop: number; umbralForMissions: number; maxPlayerLevel: number; reinforcementsMax: number;
}

// ---- standing (GET /reputation) -----------------------------------------------------------------
// Two independent ladders per faction, mirroring the game's two Captain panels. Every derived field
// (level, rank, their names, colours, perks) comes from the game's own tables, so nothing here is a
// local reimplementation of its balance. Any of them can be null on a build that renamed a helper, and
// `conquest` is absent entirely on a save with no conquest story.
export interface RepPerks {
  // Fractions, not percentages: 0.1 means 10% off.
  shopDiscount: number | null; shipyardDiscount: number | null; repairCostDiscount: number | null;
  repairSpeed: number | null; missionReward: number | null; bonusMissions: number | null;
  boardRefreshTimer: number | null; shopRefreshTokens: number | null;
  canRefreshShop: boolean | null; canRefreshBoard: boolean | null;
}
export interface RepStanding {
  value: number;
  // `level` = the ReputationLevel enum, `levelName` = the same words spaced ("Absolute Threat"). `group` is
  // the game's coarser Negative|Neutral|Positive banding that sits above the named bands.
  level: string | null; levelName: string | null; group: string | null; color: string | null;
  progress: number | null;        // 0-1 across the whole ladder
  bandProgress: number | null; bandRange: number | null;   // within the current level only
  nextAt: number | null; toNext: number | null;
  perks?: RepPerks;
}
export interface ConquestPerks {
  creditMultiplier: number | null; reputationBonus: number | null;
  fleetStrengthBonus: number | null; commendationsBonus: number | null;
  destroyer: boolean | null;
}
export interface ConquestStanding {
  contribution: number | null;
  rank: string | null;            // None | Rank1..Rank6
  rankName: string | null;        // per-faction title ("Oracle's Chosen")
  color: string | null;
  areaHeld: number | null; areaMax: number | null; conqueredPct: number | null;
  rejoinCooldown: number | null;
  perks?: ConquestPerks;
}
export interface FactionStanding {
  id: string; name: string | null; color: string | null;
  // The game's OWN war flag (`Faction.IsEnemy`), not a reputation threshold: a faction at +6,751 can be at
  // war. It is a toggle you set at a station, forced on only while your reputation is negative.
  atWar: boolean | null;
  reputation?: RepStanding;
  conquest?: ConquestStanding;
}
export interface Reputation {
  factions: FactionStanding[];
  // `Conquest.maxReputation` (30,000) — reported under its own name, NOT as the ladder's ceiling: the
  // thresholds run to 50,000, so the two disagree and only `levels` may be used as the scale.
  conquestRepMax: number | null;
  foeAt: number | null;           // below this a faction is at war with you
  levels: { tier: string; name: string | null; at: number; group: string | null }[] | null;
  ranks: { tier: string; name: string | null; at: number }[] | null;
  // What the TOP rank costs. Contribution keeps climbing past it (5,441 seen against 4,500) ∴ not a cap.
  topRankAt: number | null;
}

// ---- standing changes (GET /reputation/log) ------------------------------------------------------
// The bridge samples both ladders and records every move, one entry per faction per change. `seq` is
// monotonic per bridge run, which is what lets a client ask for only what it hasn't seen.
export interface StandingEntry {
  seq: number;
  t: string;                       // HH:mm:ss, when the change was NOTICED (sampled, up to 3s late)
  ladder: "faction" | "conquest";
  factionId: string; faction: string | null;
  delta: number; value: number;
  tierWas: string | null; tier: string | null;   // named band before/after — a crossing is the interesting case
  at: string | null;               // system you were in
}
export interface StandingLog {
  entries: StandingEntry[];
  seq: number;                     // the newest seq the bridge holds
  capacity: number;                // how many entries it keeps before dropping the oldest
  playthrough: string | null;
  // Proof of life. An empty log means "nothing changed" ONLY if the sampler is running and watching
  // factions; `watchingFactions: 0` means it could not have recorded anything.
  sampler?: {
    samples: number; periodSeconds: number; lastSampleAgo: number | null;
    watchingFactions: number; watchingConquest: number; lastError: string | null;
  };
}

// ---- "where is my stuff" (GET /materials) -------------------------------------------------------
// Every station keeps its OWN storage, so a long playthrough scatters materials across dozens of them
// with no in-game way to see the whole picture. Aggregated two ways: by item and by place.
//
// Station storage only — cargo and the armory travel with you, so they have no system and no place on
// the map. Every place therefore has a system, and totals are what is STORED, not what is held.
export interface MaterialPlace {
  kind: "station";
  name: string; guid: string | null;
  system: string | null; systemName: string | null;
  volume?: number;   // m3 in use, as the game's per-system tooltip shows it
  items: { id: string; name: string; category?: string | null; count: number }[];
  slots: number;
}
export interface MaterialItem {
  id: string; name: string; category?: string | null; total: number;
  at: { kind: "station"; name: string; guid: string | null; system: string | null; systemName: string | null; count: number }[];
}
export interface Materials {
  playthrough: string | null;
  items: MaterialItem[];
  places: MaterialPlace[];
  counts: { places: number; distinctItems: number; units: number };
}

// Ship vitals for the status panel (GET /ship/vitals). A block is ABSENT when the ship has none of that
// thing — no shield generator means no `shield` key at all, so the bar simply isn't drawn. Combat power is
// not here: the game exposes no ship-level total, so the client derives it from the equipped turrets.
export interface VitalPair { cur: number; max: number }
export interface Vitals {
  ship: string | null;
  guid: string | null;
  hull?: VitalPair;
  armor?: VitalPair;
  shield?: VitalPair;
  cargo?: VitalPair;
}


// A persisted purchase/sale, from GET /ledger. `credits` is signed from the player's side (negative =
// bought), so a running total is a plain sum. A barter purchase moves no credits and names the goods instead.
export interface LedgerEntry {
  at: string;              // ISO-8601 UTC
  kind: "buy" | "sell";
  item: string;
  itemId?: string | null;
  count: number;
  credits: number;
  costItem?: string | null;
  costItemCount?: number | null;
  shop?: string | null;
  station?: string | null;
  ship?: string | null;
  playthrough?: string | null;
}

export interface LedgerDto {
  entries: LedgerEntry[];  // newest first
  count: number;           // rows in scope, before the limit
  spent: number;
  earned: number;
  net: number;
  barters: number;         // purchases paid in goods — a real cost that no credit total can show
}

/** One reward line a mission carried, as the game itself words it. */
export interface MissionRewardEntry {
  /** The reward class: `Credits`, `Experience`, `Item`, `Reputation`, `ConquestStrength`, `Officer`, … */
  kind?: string | null;
  /** The game's own sentence for it, e.g. "1,250 credits". */
  text?: string | null;
  /** Absent where a reward's worth is not a number (map coordinates, a follow-up mission) — ⊥ zero. */
  amount?: number;
  /** The game keeps some rewards off the board; recorded and marked rather than dropped. */
  hidden?: boolean;
}

/**
 * The mission history (`GET /missions/log`).
 *
 * `event` is what the bridge's watcher concluded when a mission LEFT the player's list: `completed` and `failed`
 * come from the game's own flags, `abandoned` is what remains when neither was set. A poll sees the state either
 * side of the moment, never the moment — so the word is a reading, and the row says which reading it is.
 */
export interface MissionLogEntry {
  at: string;
  event: "accepted" | "completed" | "failed" | "abandoned";
  name?: string | null;
  category?: string | null;
  storyId?: string | null;
  /** The board or contact it came from, translated — the game stores it as a localisation key. */
  from?: string | null;
  faction?: string | null;
  level?: number;
  difficulty?: string | null;
  station?: string | null;
  playthrough?: string | null;
  /** What the job paid. Absent on a row written by a bridge that predates the reward read. */
  rewards?: MissionRewardEntry[];
}

export interface MissionLog {
  playthrough: string | null;
  count: number;
  entries: MissionLogEntry[];
}
