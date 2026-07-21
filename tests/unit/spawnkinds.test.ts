// debug_spawn_ships optional shipKind (0.21.0): a non-design kind spawns
// plain hulls (colony ships, scouts, ...) instead of warships — the engine
// primitive behind the mirror-mode bot catch-up. The ABSENT field must keep
// the old designId contract exactly, so pre-0.21.0 logs replay identically.

import { describe, expect, it } from 'vitest';
import { gameEngine } from '@engine/index';
import { applyCommand, validateCommand } from '@engine/commands';
import type { GameState, ShipKind } from '@engine/types';

const SEED = 'aaaabbbbccccddddeeeeffff00001111';

function newGame(debugCommands = true): GameState {
  return gameEngine.init({
    seed: SEED,
    settings: {
      galaxySize: 'small',
      startMode: 'average',
      playerCount: 2,
      modes: { creativeVariant: false, pickBidding: false, stickyBuild: false, antarans: false, randomEvents: false },
      battleOrdersTimeoutMs: 1000,
      debugCommands,
    },
    players: [
      { id: 0, name: 'A', raceJson: JSON.stringify({ presetId: 'solari' }) },
      { id: 1, name: 'B', raceJson: JSON.stringify({ presetId: 'solari' }) },
    ],
    dataVersion: 'test',
  });
}

function cmd(state: GameState, playerId: number, payload: unknown) {
  return { turn: state.turn, playerId, kind: 'debug_spawn_ships', payload };
}

function homeStar(state: GameState, playerId: number): number {
  const colony = state.colonies.find((c) => c.owner === playerId)!;
  return state.planets.find((p) => p.id === colony.planetId)!.starId;
}

describe('debug_spawn_ships shipKind extension', () => {
  it('absent shipKind keeps the exact old behavior (warships of designId)', () => {
    const state = newGame();
    const starId = homeStar(state, 0);
    const designId = state.empires.find((e) => e.id === 0)!.designs[0]!.id;
    const before = state.ships.length;
    const c = cmd(state, 0, { starId, designId, count: 3 });
    expect(validateCommand(state, c)).toBeNull();
    applyCommand(state, c);
    const spawned = state.ships.slice(before);
    expect(spawned).toHaveLength(3);
    for (const s of spawned) {
      expect(s.shipKind).toBe('design');
      expect(s.designId).toBe(designId);
      expect(s.owner).toBe(0);
      expect(s.location).toEqual({ kind: 'star', starId });
      expect(s.cargoPopUnits).toBe(0);
      expect(s.marines).toBeUndefined();
    }
    // old strictness intact: absent shipKind still REQUIRES an integer designId
    expect(validateCommand(state, cmd(state, 0, { starId, designId: null, count: 1 }))).toBe('bad ids');
    expect(validateCommand(state, cmd(state, 0, { starId, count: 1 }))).toBe('bad ids');
  });

  it('spawns every non-design kind with designId ignored', () => {
    const state = newGame();
    const starId = homeStar(state, 1);
    const kinds: ShipKind[] = ['colony_ship', 'outpost_ship', 'transport', 'scout', 'construction_ship'];
    for (const shipKind of kinds) {
      const before = state.ships.length;
      const c = cmd(state, 1, { starId, designId: null, count: 2, shipKind });
      expect(validateCommand(state, c), shipKind).toBeNull();
      applyCommand(state, c);
      const spawned = state.ships.slice(before);
      expect(spawned).toHaveLength(2);
      for (const s of spawned) {
        expect(s.shipKind).toBe(shipKind);
        expect(s.designId).toBeNull();
        expect(s.owner).toBe(1);
        expect(s.location).toEqual({ kind: 'star', starId });
        // like a yard with an empty garrison: transports spawn without marines
        expect(s.marines).toBeUndefined();
      }
    }
    // a stale designId rides along fine but never lands on the ship
    const c = cmd(state, 1, { starId, designId: 42, count: 1, shipKind: 'colony_ship' });
    expect(validateCommand(state, c)).toBeNull();
    applyCommand(state, c);
    expect(state.ships[state.ships.length - 1]!.designId).toBeNull();
  });

  it('validates strictly (hostile JSON payloads)', () => {
    const state = newGame();
    const starId = homeStar(state, 0);
    const bad = (payload: unknown) => validateCommand(state, cmd(state, 0, payload));
    expect(bad({ starId, designId: null, count: 1, shipKind: 'design' })).toBe('bad shipKind');
    expect(bad({ starId, designId: null, count: 1, shipKind: 'battleship' })).toBe('bad shipKind');
    expect(bad({ starId, designId: null, count: 1, shipKind: 7 })).toBe('bad shipKind');
    expect(bad({ starId, designId: null, count: 1, shipKind: null })).toBe('bad shipKind');
    expect(bad({ starId, designId: 1.5, count: 1, shipKind: 'colony_ship' })).toBe('bad ids');
    expect(bad({ starId: 0.5, designId: null, count: 1, shipKind: 'colony_ship' })).toBe('bad ids');
    expect(bad({ starId, designId: null, count: 0, shipKind: 'colony_ship' })).toBe('bad count');
    expect(bad({ starId, designId: null, count: 21, shipKind: 'colony_ship' })).toBe('bad count');
    // still gated on the settings like every debug command
    const off = newGame(false);
    expect(
      validateCommand(off, cmd(off, 0, { starId: homeStar(off, 0), designId: null, count: 1, shipKind: 'colony_ship' })),
    ).toBe('debug commands disabled');
  });

  it('spawned hulls are real ships: a granted colony ship can colonize', () => {
    const state = newGame();
    const starId = homeStar(state, 0);
    const free = state.planets.find(
      (p) => p.starId === starId && p.body === 'planet' && !state.colonies.some((c) => c.planetId === p.id),
    );
    applyCommand(state, cmd(state, 0, { starId, designId: null, count: 1, shipKind: 'colony_ship' }));
    const ship = state.ships[state.ships.length - 1]!;
    if (free) {
      const col = { turn: state.turn, playerId: 0, kind: 'colonize', payload: { shipId: ship.id, planetId: free.id } };
      expect(validateCommand(state, col)).toBeNull();
    }
    // round-trips through the canonical serializer without hash drift
    const back = gameEngine.deserialize(gameEngine.serialize(state));
    expect(gameEngine.hash(back)).toBe(gameEngine.hash(state));
  });
});
