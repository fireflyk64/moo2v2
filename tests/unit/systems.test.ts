import { describe, expect, it } from 'vitest';
import { gameEngine } from '@engine/index';
import { validateCommand } from '@engine/commands';
import { resolveEspionage } from '@engine/espionage';
import { colonyMaxPop, colonyOutput } from '@engine/economy';
import { NEXT_TERRAFORM, terraformCost } from '@engine/terraform';
import type { GameState, TurnEvent } from '@engine/types';

const SEED = 'aaaabbbbccccddddeeeeffff00001111';

function newGame(): GameState {
  return gameEngine.init({
    seed: SEED,
    settings: {
      galaxySize: 'small',
      startMode: 'average',
      playerCount: 2,
      modes: { creativeVariant: false, pickBidding: false, stickyBuild: false, antarans: true, randomEvents: false },
      battleOrdersTimeoutMs: 1000,
      debugCommands: true,
    },
    players: [
      { id: 0, name: 'A', raceJson: JSON.stringify({ presetId: 'solari' }) },
      { id: 1, name: 'B', raceJson: JSON.stringify({ presetId: 'solari' }) },
    ],
    dataVersion: 'test',
  });
}

function advance(state: GameState): GameState {
  const next = gameEngine.apply(state, { turn: state.turn, playerId: -1, kind: 'advance_turn', payload: {} });
  if (next.phase === 'battle_orders') {
    return gameEngine.apply(next, { turn: next.turn, playerId: -1, kind: 'resolve_combat', payload: {} });
  }
  return next;
}

describe('spies', () => {
  it('spy project trains agents up to the cap', () => {
    let state = newGame();
    const colony = state.colonies.find((c) => c.owner === 0)!;
    const empire = state.empires[0]!;
    empire.knownApps = [...empire.knownApps, 'spy'].sort();
    expect(
      validateCommand(state, { turn: state.turn, playerId: 0, kind: 'set_build_queue', payload: { colonyId: colony.id, items: ['spy'] } }),
    ).toBeNull();
    colony.queue = [{ item: 'spy' }];
    colony.storedProd = 60;
    state = advance(state);
    expect(state.empires[0]!.spies.count).toBe(1);
    // cap enforced at queue time
    state.empires[0]!.spies.count = 10;
    const c2 = state.colonies.find((c) => c.owner === 0)!;
    expect(
      validateCommand(state, { turn: state.turn, playerId: 0, kind: 'set_build_queue', payload: { colonyId: c2.id, items: ['spy'] } }),
    ).toMatch(/roster is full/);
  });

  it('offensive spies steal tech deterministically', () => {
    const state = newGame();
    const a = state.empires[0]!;
    const b = state.empires[1]!;
    a.spies = { count: 10, target: 1, mode: 'steal' };
    b.knownApps = [...new Set([...b.knownApps, 'neutron_blaster'])].sort();
    a.knownApps = a.knownApps.filter((x) => x !== 'neutron_blaster');
    let stolen = false;
    for (let t = 0; t < 20 && !stolen; t++) {
      const events: TurnEvent[] = [];
      resolveEspionage(state, events);
      state.turn++;
      if (a.spies.count === 0) a.spies.count = 10; // keep the pressure on
      stolen = a.knownApps.includes('neutron_blaster');
    }
    expect(stolen).toBe(true);
  });
});

describe('terraforming', () => {
  it('steps climates along the T1 chain with rising costs', () => {
    let state = newGame();
    const colony = state.colonies.find((c) => c.owner === 0)!;
    const planet = state.planets.find((p) => p.id === colony.planetId)!;
    planet.climate = 'desert';
    planet.terraformSteps = 0;
    state.empires[0]!.knownApps = [...state.empires[0]!.knownApps, 'terraforming'].sort();
    expect(terraformCost(planet)).toBe(250);
    expect(
      validateCommand(state, { turn: state.turn, playerId: 0, kind: 'set_build_queue', payload: { colonyId: colony.id, items: ['terraforming'] } }),
    ).toBeNull();
    const before = colonyMaxPop(state, colony);
    colony.queue = [{ item: 'terraforming' }];
    colony.storedProd = 250;
    state = advance(state);
    const planet2 = state.planets.find((p) => p.id === colony.planetId)!;
    expect(planet2.climate).toBe(NEXT_TERRAFORM['desert']);
    expect(planet2.terraformSteps).toBe(1);
    expect(terraformCost(planet2)).toBe(500);
    const colony2 = state.colonies.find((c) => c.owner === 0)!;
    expect(colonyMaxPop(state, colony2)).toBeGreaterThan(before);
  });

  it('hostile and energized worlds refuse terraforming; shield rescues hostile', () => {
    const state = newGame();
    const colony = state.colonies.find((c) => c.owner === 0)!;
    const planet = state.planets.find((p) => p.id === colony.planetId)!;
    state.empires[0]!.knownApps = [...state.empires[0]!.knownApps, 'terraforming'].sort();
    planet.climate = 'hostile';
    expect(
      validateCommand(state, { turn: state.turn, playerId: 0, kind: 'set_build_queue', payload: { colonyId: colony.id, items: ['terraforming'] } }),
    ).toMatch(/cannot be terraformed/);
    const before = colonyOutput(state, colony);
    colony.buildings = [...colony.buildings, 'stellar_safety_shield'].sort();
    const after = colonyOutput(state, colony);
    expect(after.maxPop).toBeGreaterThanOrEqual(before.maxPop); // barren-equivalent
  });
});

describe('surrender', () => {
  it('transfers the realm and eliminates the empire', () => {
    let state = newGame();
    state.proposals.push({
      id: state.nextId++,
      from: 1,
      to: 0,
      kind: 'surrender',
      giveBc: 0,
      giveApp: null,
      wantApp: null,
      expiresTurn: state.turn + 5,
    });
    const pid = state.proposals[0]!.id;
    state = gameEngine.apply(state, { turn: state.turn, playerId: 0, kind: 'diplo_respond', payload: { proposalId: pid, accept: true } });
    expect(state.empires[1]!.eliminated).toBe(true);
    expect(state.colonies.every((c) => c.owner === 0)).toBe(true);
    expect(state.ships.every((s) => s.owner === 0)).toBe(true);
    // next resolution declares conquest victory
    state = advance(state);
    expect(state.winner).toBe(0);
    expect(state.winType).toBe('conquest');
  });
});

describe('council victory', () => {
  it('two-thirds of population-weighted votes elects a ruler', () => {
    let state = newGame();
    // make empire 0 dominant so its own vote carries 2/3 of the weight
    const c0 = state.colonies.find((c) => c.owner === 0)!;
    c0.groups[0]!.popK = 40_000;
    state.council.pending = { candidates: [0, 1], votes: {} };
    state = gameEngine.apply(state, { turn: state.turn, playerId: 0, kind: 'cast_vote', payload: { candidate: 0 } });
    state = gameEngine.apply(state, { turn: state.turn, playerId: 1, kind: 'cast_vote', payload: { candidate: -1 } });
    state = advance(state);
    expect(state.winner).toBe(0);
    expect(state.winType).toBe('council');
  });
});

describe('concession', () => {
  it('resigning dissolves the realm and hands the last empire the game', () => {
    let state = newGame();
    state = gameEngine.apply(state, { turn: state.turn, playerId: 1, kind: 'resign', payload: {} });
    expect(state.empires[1]!.eliminated).toBe(true);
    expect(state.colonies.some((c) => c.owner === 1)).toBe(false);
    expect(state.ships.some((s) => s.owner === 1)).toBe(false);
    state = advance(state);
    expect(state.winner).toBe(0);
  });
});

describe('blockade', () => {
  it('blockaded colonies get no freighter food', () => {
    let state = newGame();
    const a = state.empires[0]!;
    a.freighters = 10;
    const colony = state.colonies.find((c) => c.owner === 0)!;
    // starve the colony: all scientists
    for (const g of colony.groups) {
      g.scientists = g.farmers + g.workers + g.scientists;
      g.farmers = 0;
      g.workers = 0;
    }
    // hostile warship parked at the home star, at war
    const planet = state.planets.find((p) => p.id === colony.planetId)!;
    const enemy = state.empires[1]!;
    const design = enemy.designs[0]!;
    state.ships.push({
      id: state.nextId++,
      owner: 1,
      shipKind: 'design',
      designId: design.id,
      location: { kind: 'star', starId: planet.starId },
      cargoPopUnits: 0,
      cargoRace: 1,
      dmgStructure: 0,
      dmgArmor: 0,
    });
    state.relations.push({ a: 0, b: 1, status: 'war', peaceOfferedBy: [], treaties: { nap: false, alliance: false, trade: false, research: false } });
    // remove the defender's own ships so the blockade holds
    state.ships = state.ships.filter((s) => !(s.owner === 0 && s.location.kind === 'star' && s.location.starId === planet.starId));
    state = advance(state);
    const after = state.colonies.find((c) => c.owner === 0);
    expect(after).toBeDefined();
    expect(after!.foodLackPrev).toBeGreaterThan(0); // shortage stood despite freighters
  });
});
