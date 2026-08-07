// Reconciliation engine rules: the scripted economy replaces production,
// predetermined colonization holds and catches up, elimination halts a
// script, and the settle commands are locked out.

import { describe, expect, it } from 'vitest';
import { gameEngine } from '@engine/index';
import { validateCommand } from '@engine/commands';
import type { GameState, ReconcileSchedule } from '@engine/types';

const SEED = 'aaaabbbbccccddddeeeeffff00001111';

function emptySchedule(empireId: number): ReconcileSchedule {
  return { empireId, research: [], fields: [], ships: [], colonize: [], pop: [], buildings: [], marines: [], spies: [] };
}

function newGame(): GameState {
  const state = gameEngine.init({
    seed: SEED,
    settings: {
      galaxySize: 'small',
      startMode: 'average',
      playerCount: 2,
      modes: { creativeVariant: false, pickBidding: false, stickyBuild: false, antarans: false, randomEvents: false },
      battleOrdersTimeoutMs: 1000,
      debugCommands: false,
    },
    players: [
      { id: 0, name: 'A', raceJson: JSON.stringify({ presetId: 'solari' }) },
      { id: 1, name: 'B', raceJson: JSON.stringify({ presetId: 'solari' }) },
    ],
    dataVersion: 'test',
  });
  state.reconcile = { schedules: [emptySchedule(0), emptySchedule(1)], usedClaims: [] };
  return state;
}

function advance(state: GameState): GameState {
  const next = gameEngine.apply(state, { turn: state.turn, playerId: -1, kind: 'advance_turn', payload: {} });
  if (next.phase === 'battle_orders') {
    return gameEngine.apply(next, { turn: next.turn, playerId: -1, kind: 'resolve_combat', payload: {} });
  }
  return next;
}

function freePlanet(state: GameState): number {
  return state.planets.find(
    (p) =>
      p.body === 'planet' &&
      !state.colonies.some((c) => c.planetId === p.id) &&
      !state.monsters.some((m) => m.starId === p.starId) &&
      p.special === null,
  )!.id;
}

describe('reconciliation scripted economy', () => {
  it('scripts fire on schedule; the normal economy is off', () => {
    let state = newGame();
    const sched0 = state.reconcile!.schedules[0]!;
    const homeColony = state.colonies.find((c) => c.owner === 0)!;
    const homePlanet = state.planets.find((p) => p.id === homeColony.planetId)!;
    const t = state.turn + 1;
    sched0.research.push({ turn: t, app: 'tritanium_armor' });
    sched0.ships.push({ turn: t, starId: homePlanet.starId, kind: 'design:frigate' });
    sched0.pop.push({ turn: t, planetId: homePlanet.id, units: 2 });
    sched0.buildings.push({ turn: t, planetId: homePlanet.id, building: 'automated_factory' });
    sched0.marines.push({ turn: t, planetId: homePlanet.id, count: 7 });
    sched0.spies.push({ turn: t, count: 3 });
    // give the idle empire a full queue so any live economy would betray itself
    const other = state.colonies.find((c) => c.owner === 1)!;
    other.queue = [{ item: 'automated_factory' }];
    other.storedProd = 500;
    const otherPopK = other.groups.reduce((n, g) => n + g.popK, 0);

    state = advance(state); // resolves turn 1 -> scripts for turn t fire at the t boundary? no: entries fire when state.turn === t during advance
    state = advance(state);

    const e0 = state.empires[0]!;
    expect(e0.knownApps).toContain('tritanium_armor');
    expect(state.ships.some((s) => s.owner === 0 && s.shipKind === 'design')).toBe(true);
    const home = state.colonies.find((c) => c.owner === 0)!;
    expect(home.groups[0]!.popK).toBeGreaterThanOrEqual(10000); // 8 start + 2 scripted
    expect(home.buildings).toContain('automated_factory');
    expect(home.marines).toBe(7);
    expect(e0.spies.count).toBe(3);

    // the idle empire built NOTHING and grew NOTHING (no s1-s5)
    const otherAfter = state.colonies.find((c) => c.owner === 1)!;
    expect(otherAfter.buildings).not.toContain('automated_factory');
    expect(otherAfter.storedProd).toBe(500);
    expect(otherAfter.groups.reduce((n, g) => n + g.popK, 0)).toBe(otherPopK);
  });

  it('predetermined colonization: first claim wins, the loser holds, then catches up', () => {
    let state = newGame();
    const planetId = freePlanet(state);
    const [s0, s1] = [state.reconcile!.schedules[0]!, state.reconcile!.schedules[1]!];
    s0.colonize.push({ turn: 2, planetId });
    s1.colonize.push({ turn: 3, planetId });
    s1.pop.push({ turn: 4, planetId, units: 1 }, { turn: 6, planetId, units: 2 });
    s1.buildings.push({ turn: 5, planetId, building: 'automated_factory' });

    while (state.turn < 8) state = advance(state);
    let colony = state.colonies.find((c) => c.planetId === planetId);
    expect(colony?.owner).toBe(0); // A grabbed it first; B is on hold
    expect(state.reconcile!.usedClaims).toEqual([{ planetId, empireId: 0 }]);

    // A loses the world (bombed to nothing): B's claim activates next turn
    // WITH the intervening pop deltas and buildings
    state.colonies = state.colonies.filter((c) => c.planetId !== planetId);
    state = advance(state);
    colony = state.colonies.find((c) => c.planetId === planetId);
    expect(colony?.owner).toBe(1);
    expect(colony!.groups[0]!.popK).toBe(4000); // 1 founding + 1 (t4) + 2 (t6)
    expect(colony!.buildings).toContain('automated_factory');
    expect(state.reconcile!.usedClaims).toEqual([
      { planetId, empireId: 0 },
      { planetId, empireId: 1 },
    ]);
  });

  it('scripted growth stops for a lost colony; elimination halts the whole script', () => {
    let state = newGame();
    const planetId = freePlanet(state);
    const s0 = state.reconcile!.schedules[0]!;
    s0.colonize.push({ turn: 2, planetId });
    s0.pop.push({ turn: 5, planetId, units: 3 });
    while (state.turn < 3) state = advance(state);
    // the colony is wiped before its growth arrives — the delta must not apply
    state.colonies = state.colonies.filter((c) => c.planetId !== planetId);
    // claim is used: nobody re-colonizes, pop never lands
    while (state.turn < 7) state = advance(state);
    expect(state.colonies.find((c) => c.planetId === planetId)).toBeUndefined();

    // eliminated empires produce nothing
    const s1 = state.reconcile!.schedules[1]!;
    const home1 = state.colonies.find((c) => c.owner === 1)!;
    const home1Planet = state.planets.find((p) => p.id === home1.planetId)!;
    s1.ships.push({ turn: state.turn + 1, starId: home1Planet.starId, kind: 'design:frigate' });
    state.empires[1]!.eliminated = true;
    state.colonies = state.colonies.filter((c) => c.owner !== 1);
    state.ships = state.ships.filter((s) => s.owner !== 1);
    state = advance(state);
    expect(state.ships.some((s) => s.owner === 1)).toBe(false);
  });

  it('ships pop out at the colony nearest their recorded star', () => {
    let state = newGame();
    const s0 = state.reconcile!.schedules[0]!;
    // record production at a star the empire does NOT own
    const foreign = state.stars.find(
      (st) => !state.colonies.some((c) => state.planets.some((p) => p.id === c.planetId && p.starId === st.id)),
    )!;
    s0.ships.push({ turn: state.turn + 1, starId: foreign.id, kind: 'design:frigate' });
    state = advance(state);
    state = advance(state); // entries at turn T fire during turn T's resolution
    const ship = state.ships.find((s) => s.owner === 0 && s.shipKind === 'design')!;
    const home = state.colonies.find((c) => c.owner === 0)!;
    const homeStar = state.planets.find((p) => p.id === home.planetId)!.starId;
    expect(ship.location).toEqual({ kind: 'star', starId: homeStar }); // only colony = nearest colony
  });

  it('reach insurance: every 5th turn a colonyful empire without an outpost ship gets one', () => {
    let state = newGame();
    while (state.turn <= 5) state = advance(state);
    for (const e of state.empires) {
      expect(state.ships.filter((s) => s.owner === e.id && s.shipKind === 'outpost_ship').length).toBe(1);
    }
    // no stockpiling: the next 5th turn only replaces a SPENT ship
    while (state.turn <= 10) state = advance(state);
    for (const e of state.empires) {
      expect(state.ships.filter((s) => s.owner === e.id && s.shipKind === 'outpost_ship').length).toBe(1);
    }
  });

  it('a scheduled colonization claim evicts a squatting outpost', () => {
    let state = newGame();
    const planetId = freePlanet(state);
    // empire 1 has an outpost dome on the world
    state.colonies.push({
      id: 900000001,
      planetId,
      owner: 1,
      name: 'Squat',
      groups: [],
      buildings: [],
      queue: [],
      storedProd: 0,
      stickyInvested: {},
      boughtThisTurn: false,
      foodLackPrev: 0,
      prodLackPrev: 0,
      housingPPPrev: 0,
      outpost: true,
    });
    state.colonies.sort((a, b) => a.id - b.id);
    state.reconcile!.schedules[0]!.colonize.push({ turn: 2, planetId });
    while (state.turn < 3) state = advance(state);
    const colony = state.colonies.find((c) => c.planetId === planetId)!;
    expect(colony.owner).toBe(0);
    expect(colony.outpost).toBe(false);
    expect(state.colonies.filter((c) => c.planetId === planetId).length).toBe(1);
  });

  it('recorded terraforming reshapes the world while its owner holds it', () => {
    let state = newGame();
    const planetId = freePlanet(state);
    const s0 = state.reconcile!.schedules[0]!;
    s0.colonize.push({ turn: 2, planetId });
    s0.terraform = [{ turn: 3, planetId, climate: 'gaia', steps: 4 }];
    s0.pop.push({ turn: 4, planetId, units: 8 }); // needs the gaia cap to fit
    while (state.turn < 5) state = advance(state);
    const planet = state.planets.find((p) => p.id === planetId)!;
    expect(planet.climate).toBe('gaia');
    expect(planet.terraformSteps).toBe(4);
    const colony = state.colonies.find((c) => c.planetId === planetId)!;
    expect(colony.groups[0]!.popK).toBeGreaterThanOrEqual(6000); // room only a gaia offers
  });

  it('monsters die when a scripted colony lands on their world (the record proves the kill)', () => {
    let state = newGame();
    const planetId = freePlanet(state);
    const starId = state.planets.find((p) => p.id === planetId)!.starId;
    state.monsters.push({ id: state.nextId++, kind: 'hydra', starId, dmgStructure: 0 });
    state.reconcile!.schedules[0]!.colonize.push({ turn: 2, planetId });
    while (state.turn < 3) state = advance(state);
    expect(state.colonies.find((c) => c.planetId === planetId)?.owner).toBe(0);
    expect(state.monsters.some((m) => m.starId === starId)).toBe(false);
  });

  it('core-worlds scoring: the green stars decide the election, not total population', () => {
    let state = newGame();
    state.reconcile!.endTurn = 3;
    // designate a free world as the core world and hand it to empire 0
    const planetId = freePlanet(state);
    state.coreWorlds = [planetId];
    state.reconcile!.schedules[0]!.colonize.push({ turn: 2, planetId });
    // empire 1 dwarfs empire 0 in TOTAL population
    state.colonies.find((c) => c.owner === 1)!.groups[0]!.popK = 30000;
    while (state.turn <= 3 && state.winner === null) state = advance(state);
    expect(state.winner).toBe(0); // people on the victory star outrank the masses
    expect(state.winType).toBe('core_worlds');
  });

  it('when the saves run out of turns, the remaining population elects a leader', () => {
    let state = newGame();
    state.reconcile!.endTurn = 3;
    // hand empire 1 the bigger realm
    state.colonies.find((c) => c.owner === 1)!.groups[0]!.popK = 15000;
    while (state.turn <= 3 && state.winner === null) state = advance(state);
    expect(state.winner).toBe(1);
    expect(state.winType).toBe('council');
  });

  it('settle and migration commands are locked out while reconciling', () => {
    const state = newGame();
    for (const kind of ['colonize', 'construct_planet', 'move_colonists', 'load_transports', 'unload_transports']) {
      expect(validateCommand(state, { turn: state.turn, playerId: 0, kind, payload: {} })).toMatch(/recorded script/);
    }
    // ordinary fleet/war commands stay open (bots need them)
    expect(validateCommand(state, { turn: state.turn, playerId: 0, kind: 'declare_war', payload: { target: 1 } })).toBeNull();
  });
});
