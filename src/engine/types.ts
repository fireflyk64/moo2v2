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
  /** completed terraforming steps (raises the next step's cost) */
  terraformSteps: number;
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
  /** recently conquered: 25% output penalty until assimilated (S11) */
  unrest: boolean;
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

export interface EmpireDesign {
  id: number;
  name: string;
  hull: string;
  computer: number;
  shield: number;
  specials: string[];
  weapons: Array<{ weapon: string; count: number; mods: string[] }>;
  obsolete: boolean;
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
  designs: EmpireDesign[];
  spies: {
    count: number;
    /** null = all defensive; else offensive against this empire */
    target: number | null;
    mode: 'steal' | 'sabotage';
  };
  eliminated: boolean;
}

export type ShipKind = 'colony_ship' | 'outpost_ship' | 'transport' | 'scout';

export type ShipLocation =
  | { kind: 'star'; starId: number }
  | { kind: 'transit'; from: number; to: number; departedTurn: number; arrivalTurn: number };

export interface Ship {
  id: number;
  owner: number;
  shipKind: ShipKind | 'design';
  designId: number | null;
  location: ShipLocation;
  /** transports carry colonists (units) */
  cargoPopUnits: number;
  cargoRace: number;
  /** battle damage carried between fights (0 = undamaged) */
  dmgStructure: number;
  dmgArmor: number;
}

export interface RelationEntry {
  a: number; // lower empire id
  b: number;
  status: 'peace' | 'war';
  peaceOfferedBy: number[]; // sorted; both present -> peace restored at S11
  treaties: {
    nap: boolean; // non-aggression pact
    alliance: boolean;
    trade: boolean; // BC per turn for both sides
    research: boolean; // RP per turn for both sides
  };
}

export interface PendingBattle {
  id: string;
  starId: number;
  attacker: number;
  defender: number;
  /** orders keyed by side; null until submitted (host fills defaults on timeout) */
  ordersA: unknown | null;
  ordersD: unknown | null;
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

export type ProposalKind =
  | 'peace'
  | 'non_aggression'
  | 'alliance'
  | 'trade'
  | 'research'
  | 'gift_bc'
  | 'tech_exchange';

export interface Proposal {
  id: number;
  from: number;
  to: number;
  kind: ProposalKind;
  /** gift_bc: amount; tech_exchange: offered app */
  giveBc: number;
  giveApp: string | null;
  /** tech_exchange: requested app */
  wantApp: string | null;
  expiresTurn: number;
}

export interface CouncilState {
  nextVoteTurn: number;
  pending: {
    candidates: number[]; // two largest empires by population
    /** empireId -> candidate voted for (-1 = abstain) */
    votes: Record<string, number>;
  } | null;
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
  /** 'planning' normally; 'battle_orders' pauses resolution awaiting orders */
  phase: 'planning' | 'battle_orders';
  pendingBattles: PendingBattle[];
  relations: RelationEntry[];
  proposals: Proposal[];
  council: CouncilState;
  winner: number | null;
  winType: 'conquest' | 'council' | null;
}

/** Deterministic turn event emitted during resolution (not part of hashed state). */
export interface TurnEvent {
  visibleTo: number; // -1 all
  kind: string;
  payload: Record<string, unknown>;
}
