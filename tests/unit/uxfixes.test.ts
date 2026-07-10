import { describe, expect, it } from 'vitest';
import { gameEngine } from '@engine/index';
import { applyCommand, validateCommand } from '@engine/commands';
import { fieldCost, fieldCostMultiplierPct, fieldGrantsAll } from '@engine/research';
import { colonyOutput } from '@engine/economy';
import { FIELD_ROWS, applicationsOfField } from '@engine/data/index';
import type { GameState } from '@engine/types';

const SEED = 'aaaabbbbccccddddeeeeffff00001111';

function newGame(startMode: 'pre_warp' | 'average' = 'average'): GameState {
  return gameEngine.init({
    seed: SEED,
    settings: {
      galaxySize: 'small',
      startMode,
      playerCount: 2,
      modes: { creativeVariant: false, pickBidding: false, stickyBuild: false, antarans: false, randomEvents: false },
      battleOrdersTimeoutMs: 1000,
      debugCommands: true,
    },
    players: [
      { id: 0, name: 'A', raceJson: JSON.stringify({ presetId: 'solari' }) }, // non-creative
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

describe('tier-1 research grants every application (bug: basic fields should research all 3)', () => {
  it('a non-creative empire completing a tier-1 field learns all of its applications', () => {
    // pre_warp: the general (grants-all) fields are start-known on "average"
    // now that average is a strict superset of the pre-warp basics
    let state = newGame('pre_warp');
    const chemistry = FIELD_ROWS.find((f) => f.id === 'cold_fusion')!;
    expect(fieldGrantsAll(chemistry)).toBe(true);
    // no target application required for a grants-all field
    expect(
      validateCommand(state, {
        turn: state.turn,
        playerId: 0,
        kind: 'set_research',
        payload: { fieldNum: chemistry.num, targetApp: null },
      }),
    ).toBeNull();
    applyCommand(state, { turn: state.turn, playerId: 0, kind: 'set_research', payload: { fieldNum: chemistry.num, targetApp: null } });
    state.empires[0]!.research.accumRP = chemistry.cost; // completes on the next resolution
    state = advance(state);
    const known = state.empires[0]!.knownApps;
    for (const app of applicationsOfField('cold_fusion')) {
      expect(known).toContain(app.id);
    }
  });

  it('higher-tier fields still grant only the chosen target', () => {
    const advanced = FIELD_ROWS.find((f) => f.id === 'advanced_construction');
    expect(advanced && fieldGrantsAll(advanced)).toBe(false);
  });
});

describe('same-turn fleet re-ordering (bug: cannot re-order fleets before commit)', () => {
  it('a move order placed this turn can be re-routed and cancelled', () => {
    const state = newGame();
    const ship = state.ships.find((s) => s.owner === 0)!;
    const home = (ship.location as { starId: number }).starId;
    const reachable = state.stars.filter(
      (s) => s.id !== home && validateCommand(state, { turn: state.turn, playerId: 0, kind: 'move_ships', payload: { shipIds: [ship.id], destStarId: s.id } }) === null,
    );
    expect(reachable.length).toBeGreaterThanOrEqual(2);
    const [first, second] = reachable;

    applyCommand(state, { turn: state.turn, playerId: 0, kind: 'move_ships', payload: { shipIds: [ship.id], destStarId: first!.id } });
    expect(ship.location.kind).toBe('transit');

    // re-route to a different destination in the same turn
    expect(
      validateCommand(state, { turn: state.turn, playerId: 0, kind: 'move_ships', payload: { shipIds: [ship.id], destStarId: second!.id } }),
    ).toBeNull();
    applyCommand(state, { turn: state.turn, playerId: 0, kind: 'move_ships', payload: { shipIds: [ship.id], destStarId: second!.id } });
    expect((ship.location as { to: number }).to).toBe(second!.id);
    expect((ship.location as { from: number }).from).toBe(home);

    // cancel by ordering it back to its origin
    applyCommand(state, { turn: state.turn, playerId: 0, kind: 'move_ships', payload: { shipIds: [ship.id], destStarId: home } });
    expect(ship.location).toEqual({ kind: 'star', starId: home });
  });
});

describe('buy-then-switch lockout (bug: switching items after buying)', () => {
  it('cannot change the active item after buying this turn', () => {
    const state = newGame();
    const colony = state.colonies.find((c) => c.owner === 0)!;
    colony.queue = [{ item: 'housing' }];
    colony.boughtThisTurn = true;
    expect(
      validateCommand(state, { turn: state.turn, playerId: 0, kind: 'set_build_queue', payload: { colonyId: colony.id, items: ['trade_goods'] } }),
    ).toMatch(/bought/);
    // keeping the same head but editing the tail is fine
    expect(
      validateCommand(state, { turn: state.turn, playerId: 0, kind: 'set_build_queue', payload: { colonyId: colony.id, items: ['housing', 'trade_goods'] } }),
    ).toBeNull();
  });
});

describe('empire tax rate (bug: need a tax when losing money)', () => {
  it('set_tax_rate converts queue production into BC at 2:1', () => {
    const state = newGame();
    const colony = state.colonies.find((c) => c.owner === 0)!;
    colony.queue = [{ item: 'star_base' }];
    const before = colonyOutput(state, colony);
    expect(validateCommand(state, { turn: state.turn, playerId: 0, kind: 'set_tax_rate', payload: { pct: 50 } })).toBeNull();
    applyCommand(state, { turn: state.turn, playerId: 0, kind: 'set_tax_rate', payload: { pct: 50 } });
    const after = colonyOutput(state, colony);
    expect(after.prodToQueue).toBeLessThan(before.prodToQueue);
    expect(after.taxBC).toBe(Math.floor(Math.floor((before.prodToQueue * 50) / 100) / 2));
    expect(after.bcIncome).toBe(before.bcIncome + after.taxBC);
    expect(validateCommand(state, { turn: state.turn, playerId: 0, kind: 'set_tax_rate', payload: { pct: 60 } })).toMatch(/0-50/);
  });
});

describe('seeded research cost variance (same for all players, per game)', () => {
  it('multiplier is 100-200%, identical across empires, and skips tier-1 basics', () => {
    const state = newGame();
    for (const f of FIELD_ROWS) {
      const pct = fieldCostMultiplierPct(state, f);
      expect(pct).toBeGreaterThanOrEqual(100);
      expect(pct).toBeLessThanOrEqual(200);
      if (fieldGrantsAll(f)) expect(pct).toBe(100);
      expect(fieldCost(state, state.empires[0]!, f)).toBe(fieldCost(state, state.empires[1]!, f));
    }
    // a different seed shuffles the multipliers
    const other = { ...state, seed: 'ffffeeeeddddccccbbbbaaaa99998888' } as GameState;
    const changed = FIELD_ROWS.some((f) => fieldCostMultiplierPct(other, f) !== fieldCostMultiplierPct(state, f));
    expect(changed).toBe(true);
  });
});

describe('repulsive diplomacy (bug: repulsive should not allow trade)', () => {
  it('treaty proposals to/from repulsive races are rejected', () => {
    const state = newGame();
    state.empires[1]!.picks = [...state.empires[1]!.picks, 'repulsive'].sort();
    expect(
      validateCommand(state, { turn: state.turn, playerId: 0, kind: 'diplo_propose', payload: { to: 1, kind: 'trade' } }),
    ).toMatch(/repulsive/);
    // gifts still get through
    state.empires[0]!.bc = 100;
    expect(
      validateCommand(state, { turn: state.turn, playerId: 0, kind: 'diplo_propose', payload: { to: 1, kind: 'gift_bc', giveBc: 50 } }),
    ).toBeNull();
  });
});

describe('sell_building (bug: be able to sell buildings)', () => {
  it('sells for half cost, one per colony per turn, and resets next turn', () => {
    let state = newGame();
    const colony = state.colonies.find((c) => c.owner === 0)!;
    expect(colony.buildings).toContain('star_base');
    const bcBefore = state.empires[0]!.bc;
    expect(
      validateCommand(state, { turn: state.turn, playerId: 0, kind: 'sell_building', payload: { colonyId: colony.id, buildingId: 'star_base' } }),
    ).toBeNull();
    applyCommand(state, { turn: state.turn, playerId: 0, kind: 'sell_building', payload: { colonyId: colony.id, buildingId: 'star_base' } });
    expect(colony.buildings).not.toContain('star_base');
    expect(state.empires[0]!.bc).toBeGreaterThan(bcBefore);
    // second sale the same turn is rejected
    expect(
      validateCommand(state, { turn: state.turn, playerId: 0, kind: 'sell_building', payload: { colonyId: colony.id, buildingId: 'marine_barracks' } }),
    ).toMatch(/already sold/);
    state = advance(state);
    const after = state.colonies.find((c) => c.id === colony.id)!;
    expect(after.soldThisTurn).toBe(false);
  });
});
