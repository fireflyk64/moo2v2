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
import { generateGalaxy, starDistance } from './galaxy';
import { colonyMaxPop } from './economy';
import { seedMonsters } from './npc';
import { rngFor } from './rng';
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

export function resolveRaceConfig(raceJson: string | null, pickBudget?: number): { picks: string[]; raceName: string } {
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
  if (cfg.picks && validatePicks(cfg.picks, pickBudget).ok) {
    return { picks: [...cfg.picks].sort(), raceName: cfg.raceName ?? 'Custom' };
  }
  const fallback = racePresetById.get('solari')!;
  return { picks: [...fallback.picks], raceName: fallback.name };
}

export function initGame(start: EngineGameStart): GameState {
  const configs = start.players.map((p) => resolveRaceConfig(p.raceJson, start.settings.pickPoints));
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
  // (deliberate: fitWeapon doesn't gate on knowledge for this starter kit)
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

  if (start.settings.bigStart) bigEmpireStart(state);

  return state;
}

/** Matches the protocol layer's EngineAdapter interface structurally, plus a
 * deterministic event side-channel consumed after advance_turn. */
export const gameEngine = {
  lastEvents: [] as TurnEvent[],

  init(start: {
    seed: string;
    settings: unknown;
    players: Array<{ id: number; name: string; raceJson: string | null }>;
    dataVersion: string;
    resumeState?: string;
  }): GameState {
    if (start.resumeState) {
      // resume/branch from an embedded snapshot: the state IS the game —
      // missing newer fields default via the optional-field contract
      return canonicalParse(start.resumeState) as unknown as GameState;
    }
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

/** Big-empire start: give every player a coherent bubble of 10-20 colonies
 * around their homeworld, each 1/3-1/2 populated. Planets nearest an empire's
 * home (that nobody else is closer to and no monster guards) join that empire,
 * so the territories stay contiguous and non-overlapping. */
function bigEmpireStart(state: GameState): void {
  const rng = rngFor(state.seed, 0, 'bigstart');
  const homeStarOf = new Map<number, number>();
  for (const c of state.colonies) {
    const p = state.planets.find((x) => x.id === c.planetId)!;
    homeStarOf.set(c.owner, p.starId);
  }
  const empires = [...state.empires].sort((a, b) => a.id - b.id);
  const target = new Map<number, number>();
  for (const e of empires) target.set(e.id, 10 + rng.int(11)); // 10..20 each

  // candidate planets: colonizable, unguarded, not already a homeworld
  const guarded = new Set(state.monsters.map((m) => m.starId));
  const homeStars = new Set(homeStarOf.values());
  const candidates = state.planets.filter(
    (p) =>
      p.body === 'planet' &&
      !guarded.has(p.starId) &&
      !homeStars.has(p.starId) &&
      !state.colonies.some((c) => c.planetId === p.id),
  );

  // assign each candidate to the empire whose home is nearest (contiguous
  // bubbles); nearest-first so inner planets fill before the frontier
  const claim: Array<{ planet: (typeof candidates)[number]; owner: number; d: number }> = [];
  for (const planet of candidates) {
    const star = state.stars.find((s) => s.id === planet.starId)!;
    let best = -1;
    let bestD = Infinity;
    for (const e of empires) {
      const hs = state.stars.find((s) => s.id === homeStarOf.get(e.id))!;
      const d = starDistance(hs, star);
      if (d < bestD) {
        bestD = d;
        best = e.id;
      }
    }
    if (best >= 0) claim.push({ planet, owner: best, d: bestD });
  }
  claim.sort((a, b) => a.d - b.d || a.planet.id - b.planet.id);

  const count = new Map<number, number>();
  for (const e of empires) count.set(e.id, 1); // the homeworld counts
  for (const { planet, owner } of claim) {
    if ((count.get(owner) ?? 0) >= (target.get(owner) ?? 0)) continue;
    const star = state.stars.find((s) => s.id === planet.starId)!;
    const romans = ['I', 'II', 'III', 'IV', 'V'];
    const colony: Colony = {
      id: state.nextId++,
      planetId: planet.id,
      owner,
      name: `${star.name} ${romans[planet.orbit - 1] ?? planet.orbit}`,
      groups: [{ race: owner, popK: 1000, farmers: 0, workers: 1, scientists: 0, unrest: false }],
      buildings: [],
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
    // 1/3 to 1/2 of capacity, split into fed jobs
    const cap = colonyMaxPop(state, colony);
    const units = Math.max(1, Math.floor((cap * (33 + rng.int(18))) / 100));
    const farmers = Math.min(units, Math.ceil(units / 2));
    colony.groups[0] = {
      race: owner,
      popK: units * 1000,
      farmers,
      workers: units - farmers,
      scientists: 0,
      unrest: false,
    };
    const emp = state.empires.find((e) => e.id === owner)!;
    if (!emp.exploredStars.includes(star.id)) emp.exploredStars.push(star.id);
    count.set(owner, (count.get(owner) ?? 0) + 1);
  }
  for (const e of empires) e.exploredStars.sort((a, b) => a - b);
  state.colonies.sort((a, b) => a.id - b.id);
}
