// The real EngineAdapter: plugs the deterministic simulation into the lockstep
// protocol. Also owns game initialization (galaxy, empires, home colonies).

import { canonicalParse, canonicalStringify, hashCanonical } from './canonical';
import {
  applicationsOfField,
  fieldByNum,
  racePresetById,
  startingFieldNums,
  validatePicks,
  ALWAYS_KNOWN_ITEMS,
} from './data/index';
import { applyCommand, validateCommand, type EngineCommand } from './commands';
import { generateGalaxy } from './galaxy';
import { seedMonsters } from './npc';
import { advanceTurn, resolveCombat } from './pipeline';
import { resolveTraits } from './race';
import type { Colony, GameState, GameStateSettings, PendingBattle, TurnEvent } from './types';

/** Race configuration carried in game_start player entries (raceJson). */
export interface RaceConfig {
  presetId?: string;
  picks?: string[];
  raceName?: string;
}

export interface EngineGameStart {
  seed: string;
  settings: GameStateSettings;
  players: Array<{ id: number; name: string; raceJson: string | null }>;
  dataVersion: string;
}

export function resolveRaceConfig(raceJson: string | null): { picks: string[]; raceName: string } {
  let cfg: RaceConfig = {};
  if (raceJson) {
    try {
      cfg = JSON.parse(raceJson) as RaceConfig;
    } catch {
      cfg = {};
    }
  }
  if (cfg.presetId) {
    const preset = racePresetById.get(cfg.presetId);
    if (preset) return { picks: [...preset.picks], raceName: cfg.raceName ?? preset.name };
  }
  if (cfg.picks && validatePicks(cfg.picks).ok) {
    return { picks: [...cfg.picks].sort(), raceName: cfg.raceName ?? 'Custom' };
  }
  const fallback = racePresetById.get('solari')!;
  return { picks: [...fallback.picks], raceName: fallback.name };
}

export function initGame(start: EngineGameStart): GameState {
  const configs = start.players.map((p) => resolveRaceConfig(p.raceJson));
  const traits = configs.map((c) => resolveTraits(c.picks));
  const galaxy = generateGalaxy(start.seed, start.settings, traits);

  const state: GameState = {
    turn: 1,
    seed: start.seed,
    settings: start.settings,
    nextId: galaxy.nextId,
    stars: galaxy.stars,
    planets: galaxy.planets,
    empires: [],
    colonies: [],
    ships: [],
    phase: 'planning',
    pendingBattles: [],
    relations: [],
    proposals: [],
    council: { nextVoteTurn: 25, pending: null },
    leaderOffers: [],
    monsters: [],
    antarans: { nextRaidTurn: 25, assaultBy: null },
    winner: null,
    winType: null,
  };

  // starting knowledge: all applications of the start-mode fields + basics
  const startFieldNums = startingFieldNums(start.settings.startMode);
  const startApps = new Set<string>(ALWAYS_KNOWN_ITEMS);
  for (const num of startFieldNums) {
    const field = fieldByNum.get(num);
    if (!field) continue;
    for (const app of applicationsOfField(field.id)) startApps.add(app.id);
  }

  for (let i = 0; i < start.players.length; i++) {
    const player = start.players[i]!;
    const cfg = configs[i]!;
    state.empires.push({
      id: player.id,
      name: player.name,
      raceName: cfg.raceName,
      picks: [...cfg.picks].sort(),
      government: resolveTraits(cfg.picks).government,
      bc: 50,
      freighters: 0,
      research: {
        fieldNum: null,
        targetApp: null,
        accumRP: 0,
        extraQueue: [],
        extraAccumRP: 0,
        hyperLevels: {},
      },
      knownApps: [...startApps].sort(),
      completedFields: [...startFieldNums].sort((a, b) => a - b),
      exploredStars: [],
      designs: [],
      spies: { count: 0, target: null, mode: 'steal' },
      leaders: [],
      eliminated: false,
    });
  }
  state.empires.sort((a, b) => a.id - b.id);

  // starter warship design: a laser frigate everyone can build on day one
  for (const empire of state.empires) {
    empire.designs.push({
      id: state.nextId++,
      name: 'Patrol Frigate',
      hull: 'frigate',
      computer: empire.knownApps.includes('electronic_computer') ? 1 : 0,
      shield: empire.knownApps.includes('class_i_shield') ? 1 : 0,
      specials: [],
      weapons: [{ weapon: 'laser_cannon', count: 2, mods: [] }],
      obsolete: false,
    });
  }

  // home colonies: 8 units, balanced jobs, starting buildings by mode
  for (let i = 0; i < start.players.length; i++) {
    const empire = state.empires[i]!;
    const hwPlanetId = galaxy.homePlanets[i]!;
    const planet = state.planets.find((p) => p.id === hwPlanetId)!;
    const star = state.stars.find((s) => s.id === planet.starId)!;
    const startPop = 8;
    const t = traits[i]!;
    const farmers = t.lithovore ? 0 : 4;
    const colony: Colony = {
      id: state.nextId++,
      planetId: planet.id,
      owner: empire.id,
      name: star.name,
      groups: [
        {
          race: empire.id,
          popK: startPop * 1000,
          farmers,
          workers: startPop - farmers - 2,
          scientists: 2,
          unrest: false,
        },
      ],
      buildings: start.settings.startMode === 'average' ? ['marine_barracks', 'star_base'] : ['marine_barracks'],
      queue: [],
      storedProd: 0,
      stickyInvested: {},
      boughtThisTurn: false,
      foodLackPrev: 0,
      prodLackPrev: 0,
      housingPPPrev: 0,
      outpost: false,
    };
    state.colonies.push(colony);
    empire.exploredStars = [star.id];
    // scout + colony ship, classic opening
    state.ships.push({
      id: state.nextId++,
      owner: empire.id,
      shipKind: 'scout',
      designId: null,
      location: { kind: 'star', starId: star.id },
      cargoPopUnits: 0,
      cargoRace: empire.id,
      dmgStructure: 0,
      dmgArmor: 0,
    });
    state.ships.push({
      id: state.nextId++,
      owner: empire.id,
      shipKind: 'colony_ship',
      designId: null,
      location: { kind: 'star', starId: star.id },
      cargoPopUnits: 0,
      cargoRace: empire.id,
      dmgStructure: 0,
      dmgArmor: 0,
    });
  }
  state.colonies.sort((a, b) => a.id - b.id);
  state.ships.sort((a, b) => a.id - b.id);

  seedMonsters(state); // guarded systems + the Guardian's prize system (M1)

  return state;
}

/** Matches the protocol layer's EngineAdapter interface structurally, plus a
 * deterministic event side-channel consumed after advance_turn. */
export const gameEngine = {
  lastEvents: [] as TurnEvent[],

  init(start: { seed: string; settings: unknown; players: Array<{ id: number; name: string; raceJson: string | null }>; dataVersion: string }): GameState {
    return initGame({
      seed: start.seed,
      settings: start.settings as GameStateSettings,
      players: start.players,
      dataVersion: start.dataVersion,
    });
  },

  validate(state: GameState, cmd: { turn: number; playerId: number; kind: string; payload: unknown }): string | null {
    if (cmd.playerId === -1) return null; // system commands always valid
    return validateCommand(state, cmd as EngineCommand);
  },

  apply(state: GameState, cmd: { turn: number; playerId: number; kind: string; payload: unknown }): GameState {
    const next = structuredClone(state);
    if (cmd.kind === 'game_start') return next;
    if (cmd.kind === 'advance_turn') {
      const result = advanceTurn(next);
      this.lastEvents = result.events;
      return next;
    }
    if (cmd.kind === 'resolve_combat') {
      const result = resolveCombat(next);
      this.lastEvents = [...this.lastEvents, ...result.events];
      return next;
    }
    applyCommand(next, cmd as EngineCommand);
    return next;
  },

  /** protocol hook: sequencer pauses turn advancement outside 'planning' */
  phaseOf(state: GameState): string {
    return state.phase;
  },

  /** protocol hook: battles awaiting orders (host emits resolve_combat when
   * all are filled or the order timeout expires) */
  pendingBattles(state: GameState): PendingBattle[] {
    return state.pendingBattles;
  },

  turnOf(state: GameState): number {
    return state.turn;
  },

  hash(state: GameState): string {
    return hashCanonical(state as unknown as Record<string, unknown>);
  },

  serialize(state: GameState): string {
    return canonicalStringify(state);
  },

  deserialize(json: string): GameState {
    return canonicalParse(json) as unknown as GameState;
  },

  advancePayload(state: GameState): unknown {
    return { fromTurn: state.turn };
  },

  /** Deterministic events from the most recent advance_turn application. */
  takeEvents(): TurnEvent[] {
    const ev = this.lastEvents;
    this.lastEvents = [];
    return ev;
  },
};

export type GameEngine = typeof gameEngine;
