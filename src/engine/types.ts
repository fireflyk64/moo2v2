// GameState: the complete deterministic simulation state. Rules:
// - Integers only (canonical serializer enforces this).
// - Arrays kept sorted by id; iteration is always in id order.
// - No derived/cached values: anything computable lives in selectors/economy.

import type { MasterSeed } from './rng';
import type { Government } from './data/index';

export type Climate =
  | 'hostile' // safe-terminology for the worst class
  | 'energized'
  | 'barren'
  | 'desert'
  | 'tundra'
  | 'ocean'
  | 'swamp'
  | 'arid'
  | 'terran'
  | 'gaia';

export type Minerals = 'ultra_poor' | 'poor' | 'abundant' | 'rich' | 'ultra_rich';
export type Gravity = 'low' | 'normal' | 'high';
export type StarColor = 'blue' | 'white' | 'yellow' | 'orange' | 'red' | 'brown' | 'black_hole';
export type BodyType = 'planet' | 'asteroids' | 'gas_giant';

export interface Star {
  id: number;
  name: string;
  x: number; // centiparsecs
  y: number;
  color: StarColor;
  wormholeTo: number | null; // starId
}

export interface Planet {
  id: number;
  starId: number;
  orbit: number; // 1..5
  body: BodyType;
  sizeClass: number; // 1 tiny .. 5 huge
  climate: Climate;
  minerals: Minerals;
  gravity: Gravity;
  special: string | null; // planet_specials id
  homeworldOf: number | null; // empireId
}

export type Job = 'farmers' | 'workers' | 'scientists';

/** Population group: colonists of one origin living on a colony. */
export interface PopGroup {
  /** empireId of the race, or -1 natives, -2 androids (later phases) */
  race: number;
  popK: number; // thousands; 1 colonist unit = 1000k
  /** assigned jobs, in whole colonist units */
  farmers: number;
  workers: number;
  scientists: number;
}

export interface QueueItem {
  item: string; // buildable id or ship kind
}

export interface Colony {
  id: number;
  planetId: number;
  owner: number;
  name: string;
  groups: PopGroup[]; // sorted by race
  buildings: string[]; // sorted buildable ids
  queue: QueueItem[]; // [0] is active
  /** production invested in the active item (normal mode) */
  storedProd: number;
  /** sticky-build mode: parked progress per item id */
  stickyInvested: Record<string, number>;
  boughtThisTurn: boolean;
  /** food shortage (in colonist units) recorded last resolution, drives next growth */
  foodLackPrev: number;
  /** production shortage for cybernetic races */
  prodLackPrev: number;
  /** housing production applied last resolution (drives next growth) */
  housingPPPrev: number;
  outpost: boolean;
}

export interface EmpireResearch {
  fieldNum: number | null; // current field being researched
  targetApp: string | null; // pre-selected application granted on completion
  accumRP: number;
  /** creative-variant mode: additional applications being bought, head first */
  extraQueue: string[];
  extraAccumRP: number;
  /** hyper-advanced repeat counters per advf field num */
  hyperLevels: Record<string, number>;
}

export interface Empire {
  id: number; // playerId
  name: string;
  raceName: string;
  picks: string[]; // sorted
  government: Government;
  bc: number;
  freighters: number; // individual freighters (fleets of 5)
  research: EmpireResearch;
  knownApps: string[]; // sorted application ids
  completedFields: number[]; // sorted field nums
  exploredStars: number[]; // sorted starIds
  eliminated: boolean;
}

export type ShipKind = 'colony_ship' | 'outpost_ship' | 'transport' | 'scout';

export type ShipLocation =
  | { kind: 'star'; starId: number }
  | { kind: 'transit'; from: number; to: number; departedTurn: number; arrivalTurn: number };

export interface Ship {
  id: number;
  owner: number;
  /** Phase 3: fixed kinds; Phase 4 adds designId for warships */
  shipKind: ShipKind | 'design';
  designId: number | null;
  location: ShipLocation;
  /** transports carry colonists (units) */
  cargoPopUnits: number;
  cargoRace: number;
}

export interface GameStateSettings {
  galaxySize: 'small' | 'medium' | 'large' | 'huge';
  startMode: 'pre_warp' | 'average';
  playerCount: number;
  modes: {
    creativeVariant: boolean;
    pickBidding: boolean;
    stickyBuild: boolean;
    antarans: boolean;
    randomEvents: boolean;
  };
  battleOrdersTimeoutMs: number;
  debugCommands: boolean;
}

export interface GameState {
  turn: number; // 1-based once started
  seed: MasterSeed;
  settings: GameStateSettings;
  nextId: number;
  stars: Star[];
  planets: Planet[];
  empires: Empire[];
  colonies: Colony[];
  ships: Ship[];
  winner: number | null;
}

/** Deterministic turn event emitted during resolution (not part of hashed state). */
export interface TurnEvent {
  visibleTo: number; // -1 all
  kind: string;
  payload: Record<string, unknown>;
}
