// The real EngineAdapter: plugs the deterministic simulation into the lockstep
// protocol. Also owns game initialization (galaxy, empires, home colonies).

import { canonicalParse, canonicalStringify, hashCanonical } from './canonical';
import {
  applicationsOfField,
  fieldById,
  fieldByNum,
  racePresetById,
  startingFieldNums,
  validatePicks,
  ALWAYS_KNOWN_ITEMS,
} from './data/index';
import { applyCommand, validateCommand, type EngineCommand } from './commands';
import { generateGalaxy, starDistance } from './galaxy';
import { colonyMaxPop, colonyOutput, farmingViable, maxPopulation } from './economy';
import { ceilDiv, floorDiv } from './imath';
import { seedMonsters } from './npc';
import { rngFor } from './rng';
import { empireContactPairs } from './selectors';
import { advanceTurn, resolveCombat } from './pipeline';
import { resolveTraits, type RaceTraits } from './race';
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

  // starting knowledge: all applications of the start-mode fields + basics.
  // "average" is a HEAD START over pre-warp, so it must be a superset — the
  // generated table alone omits the tier-1 roots (colony_base, star_base,
  // lasers...), leaving an average empire knowing less basics than pre-warp.
  // "advanced" plays the default (pre-warp) tech age plus Cold Fusion: the
  // big developed empires need colony ships and freighters from day one.
  const startFieldNums =
    start.settings.startMode === 'average'
      ? [...new Set([...startingFieldNums('pre_warp'), ...startingFieldNums('average')])]
      : start.settings.startMode === 'advanced'
        ? [...new Set([...startingFieldNums('pre_warp'), fieldById.get('cold_fusion')!.num])]
        : startingFieldNums('pre_warp');
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

  if (start.settings.startMode === 'advanced') {
    // big identical developed empires (regions, half-full worlds, freighter
    // pools, frontier scouts) — replaces the classic single-home opening
    advancedStart(state, galaxy.homePlanets, traits);
  } else {
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
      // classic opening: a scout for everyone…
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
      // …but the free colony ship is the "average" head start only: a
      // pre-warp empire researches Cold Fusion before it can settle out
      // (bugs.md: the early start must not begin with a colony ship)
      if (start.settings.startMode === 'average') {
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
    }
  }
  state.colonies.sort((a, b) => a.id - b.id);
  state.ships.sort((a, b) => a.id - b.id);

  seedMonsters(state); // guarded systems + the Guardian's prize system (M1)

  if (start.settings.bigStart && start.settings.startMode !== 'advanced') bigEmpireStart(state);

  return state;
}

/** Advanced start: every player begins with an identical developed empire.
 *
 * The players' regions together cover about a THIRD of the galaxy (split
 * evenly), claimed nearest-first around each homeworld so they stay
 * contiguous and disjoint. Within the regions, player i's k-th system is
 * stamped with EXACTLY the worlds of player 0's k-th system — identical
 * empires — while the free two-thirds of the map keeps its organic roll
 * (deliberately NOT a mirror galaxy). Every colonized planet starts half
 * full, the freighter pool covers the empire's whole food run from turn one,
 * and five scouts wait at the frontier. Runs before seedMonsters, so no
 * keeper ever spawns inside a starting region. */
function advancedStart(state: GameState, homePlanets: number[], traits: RaceTraits[]): void {
  const n = state.empires.length;
  const perPlayer = Math.max(2, Math.round(state.stars.length / (3 * n)));
  const homeStars = homePlanets.map((pid) => state.planets.find((p) => p.id === pid)!.starId);

  // --- claim contiguous equal regions: home + nearest colonizable systems ---
  const claimed: number[][] = homeStars.map((s) => [s]);
  const takenHomes = new Set<number>(homeStars);
  const ranked: Array<{ starId: number; owner: number; d: number }> = [];
  for (const star of state.stars) {
    if (takenHomes.has(star.id)) continue;
    if (!state.planets.some((p) => p.starId === star.id && p.body === 'planet')) continue;
    let owner = 0;
    let bestD = Infinity;
    for (let i = 0; i < n; i++) {
      const hs = state.stars.find((s) => s.id === homeStars[i])!;
      const d = starDistance(hs, star);
      if (d < bestD) {
        bestD = d;
        owner = i;
      }
    }
    ranked.push({ starId: star.id, owner, d: bestD });
  }
  ranked.sort((a, b) => a.d - b.d || a.starId - b.starId);
  for (const r of ranked) {
    if (claimed[r.owner]!.length < perPlayer) claimed[r.owner]!.push(r.starId);
  }
  // identical sizes even on lopsided maps: everyone keeps their nearest few
  const size = Math.min(...claimed.map((c) => c.length));
  for (let i = 0; i < n; i++) claimed[i] = claimed[i]!.slice(0, size);

  // --- stamp: player i's k-th system carries player 0's k-th system's worlds
  // (k=0 is the home system, already made identical by placeHomeworlds) ---
  for (let k = 1; k < size; k++) {
    const template = state.planets
      .filter((p) => p.starId === claimed[0]![k])
      .sort((a, b) => a.orbit - b.orbit || a.id - b.id);
    for (let i = 1; i < n; i++) {
      const starId = claimed[i]![k]!;
      state.planets = state.planets.filter((p) => p.starId !== starId);
      for (const t of template) {
        state.planets.push({
          id: state.nextId++,
          starId,
          orbit: t.orbit,
          body: t.body,
          sizeClass: t.sizeClass,
          climate: t.climate,
          minerals: t.minerals,
          gravity: t.gravity,
          special: t.special,
          homeworldOf: null,
          terraformSteps: t.terraformSteps ?? 0,
        });
      }
    }
  }

  // --- colonies: every world in a claimed system, half full, fed jobs ---
  const romans = ['I', 'II', 'III', 'IV', 'V'];
  for (let i = 0; i < n; i++) {
    const empire = state.empires[i]!;
    for (let k = 0; k < size; k++) {
      const starId = claimed[i]![k]!;
      const star = state.stars.find((s) => s.id === starId)!;
      const worlds = state.planets
        .filter((p) => p.starId === starId && p.body === 'planet')
        .sort((a, b) => a.orbit - b.orbit || a.id - b.id);
      for (const planet of worlds) {
        if (state.colonies.some((c) => c.planetId === planet.id)) continue;
        const cap = maxPopulation(planet, traits[i]!, 0);
        const units = Math.max(1, floorDiv(cap, 2)); // each planet half full
        const isHome = planet.id === homePlanets[i];
        const colony: Colony = {
          id: state.nextId++,
          planetId: planet.id,
          owner: empire.id,
          name: isHome ? star.name : `${star.name} ${romans[planet.orbit - 1] ?? planet.orbit}`,
          groups: [{ race: empire.id, popK: units * 1000, farmers: 0, workers: units, scientists: 0, unrest: false }],
          buildings: isHome ? ['marine_barracks'] : [],
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
        if (farmingViable(state, colony)) {
          const g = colony.groups[0]!;
          g.farmers = Math.min(units, ceilDiv(units, 2));
          g.workers = units - g.farmers;
        }
        // founding salvages the wreck exactly like the colonize command does
        if (planet.special === 'space_debris') {
          empire.bc += 50;
          planet.special = null;
        }
      }
      if (!empire.exploredStars.includes(starId)) empire.exploredStars.push(starId);
    }
    empire.exploredStars.sort((a, b) => a - b);
  }
  state.colonies.sort((a, b) => a.id - b.id);

  // --- freighters: enough to feed the whole empire from turn one ---
  for (const empire of state.empires) {
    let deficit = 0;
    for (const c of state.colonies) {
      if (c.owner !== empire.id || c.outpost) continue;
      const net = colonyOutput(state, c).foodNet;
      if (net < 0) deficit += -net;
    }
    empire.freighters = ceilDiv(deficit, 5) * 5; // whole fleets, never short
  }

  // --- five scouts at the frontier (farthest claimed systems from home) ---
  for (let i = 0; i < n; i++) {
    const empire = state.empires[i]!;
    const home = state.stars.find((s) => s.id === homeStars[i])!;
    const frontier = claimed[i]!
      .map((id) => state.stars.find((s) => s.id === id)!)
      .sort((a, b) => starDistance(home, b) - starDistance(home, a) || a.id - b.id)
      .slice(0, 5);
    for (let j = 0; j < 5; j++) {
      state.ships.push({
        id: state.nextId++,
        owner: empire.id,
        shipKind: 'scout',
        designId: null,
        location: { kind: 'star', starId: frontier[j % frontier.length]!.id },
        cargoPopUnits: 0,
        cargoRace: empire.id,
        dmgStructure: 0,
        dmgArmor: 0,
      });
    }
  }
}

/** Matches the protocol layer's EngineAdapter interface structurally, plus a
 * deterministic event side-channel consumed after advance_turn.
 *
 * FACTORY, not singleton: every HostCore/GameSession must own its own
 * instance — `lastEvents` is mutable, and sessions sharing one buffer on the
 * same page dropped pre-combat reports and doubled combat events. */
export function createGameEngine() {
  return {
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
      // append (don't replace): command events emitted since the last drain
      // (treaty signed, surrender...) belong to this boundary's flush too.
      // Soft cap keeps undrained holders (HostCore) from growing unbounded.
      this.lastEvents = [...this.lastEvents, ...result.events].slice(-5000);
      return next;
    }
    if (cmd.kind === 'resolve_combat') {
      const result = resolveCombat(next);
      this.lastEvents = [...this.lastEvents, ...result.events].slice(-5000);
      return next;
    }
    // commands can emit events too (treaty signed, surrender, failed accept);
    // they ride the buffer and surface at the next turn boundary flush
    const cmdEvents: TurnEvent[] = [];
    applyCommand(next, cmd as EngineCommand, cmdEvents);
    if (cmdEvents.length) this.lastEvents = [...this.lastEvents, ...cmdEvents];
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

  /** protocol hook (fast-start): live empire pairs that have met. While this
   * is empty the empires cannot interact and turns may resolve async. */
  contactPairs(state: GameState): Array<[number, number]> {
    return empireContactPairs(state);
  },

  /** protocol hook (fast-start): victory also ends the async phase */
  winnerOf(state: GameState): number | null {
    return state.winner;
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
}

/** Shared default instance: fine for stateless calls (hash/init/serialize)
 * and single-session tests; live sessions should call createGameEngine(). */
export const gameEngine = createGameEngine();

export type GameEngine = ReturnType<typeof createGameEngine>;

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
