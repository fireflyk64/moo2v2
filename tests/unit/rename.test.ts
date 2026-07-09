import { describe, expect, it } from 'vitest';
import { gameEngine } from '@engine/index';
import { applyCommand, validateCommand, COLONY_TAGS } from '@engine/commands';
import type { GameState } from '@engine/types';

const SEED = 'aaaabbbbccccddddeeeeffff00001111';

function newGame(): GameState {
  return gameEngine.init({
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
}

function cmd(state: GameState, playerId: number, kind: string, payload: unknown) {
  return { turn: state.turn, playerId, kind, payload };
}

describe('rename_star', () => {
  it('renames a star where the player has a settlement', () => {
    const state = newGame();
    const home = state.colonies.find((c) => c.owner === 0)!;
    const starId = state.planets.find((p) => p.id === home.planetId)!.starId;
    const c = cmd(state, 0, 'rename_star', { starId, name: '  New Terra  ' });
    expect(validateCommand(state, c)).toBeNull();
    applyCommand(state, c);
    expect(state.stars.find((s) => s.id === starId)!.name).toBe('New Terra');
  });

  it('rejects renaming a star without a settlement there', () => {
    const state = newGame();
    const home0 = state.colonies.find((c) => c.owner === 0)!;
    const myStar = state.planets.find((p) => p.id === home0.planetId)!.starId;
    const other = state.stars.find((s) => s.id !== myStar)!;
    expect(validateCommand(state, cmd(state, 0, 'rename_star', { starId: other.id, name: 'Mine' }))).toContain(
      'colony or outpost',
    );
  });

  it('rejects empty and oversized names', () => {
    const state = newGame();
    const home = state.colonies.find((c) => c.owner === 0)!;
    const starId = state.planets.find((p) => p.id === home.planetId)!.starId;
    expect(validateCommand(state, cmd(state, 0, 'rename_star', { starId, name: '   ' }))).toContain('empty');
    expect(validateCommand(state, cmd(state, 0, 'rename_star', { starId, name: 'x'.repeat(25) }))).toContain('too long');
    expect(validateCommand(state, cmd(state, 0, 'rename_star', { starId, name: 42 }))).toContain('text');
  });
});

describe('rename_colony + set_colony_tags', () => {
  it('renames own colony, rejects renaming others', () => {
    const state = newGame();
    const mine = state.colonies.find((c) => c.owner === 0)!;
    const theirs = state.colonies.find((c) => c.owner === 1)!;
    const c = cmd(state, 0, 'rename_colony', { colonyId: mine.id, name: 'Alpha Prime' });
    expect(validateCommand(state, c)).toBeNull();
    applyCommand(state, c);
    expect(state.colonies.find((x) => x.id === mine.id)!.name).toBe('Alpha Prime');
    expect(validateCommand(state, cmd(state, 0, 'rename_colony', { colonyId: theirs.id, name: 'Hax' }))).toContain(
      'not yours',
    );
  });

  it('sets, replaces, and clears tags from the fixed set', () => {
    const state = newGame();
    const mine = state.colonies.find((c) => c.owner === 0)!;
    const set = (tags: string[]) => cmd(state, 0, 'set_colony_tags', { colonyId: mine.id, tags });
    expect(validateCommand(state, set(['industry', 'core']))).toBeNull();
    applyCommand(state, set(['industry', 'core']));
    expect(state.colonies.find((x) => x.id === mine.id)!.tags).toEqual(['core', 'industry']); // sorted
    expect(validateCommand(state, set(['bogus']))).toContain('unknown tag');
    expect(validateCommand(state, set(['core', 'core']))).toContain('duplicate');
    applyCommand(state, set([]));
    expect(state.colonies.find((x) => x.id === mine.id)!.tags).toBeUndefined(); // absent = none
    // every advertised tag validates
    expect(validateCommand(state, set([...COLONY_TAGS]))).toBeNull();
  });

  it('round-trips through serialize/deserialize with tags set', () => {
    const state = newGame();
    const mine = state.colonies.find((c) => c.owner === 0)!;
    applyCommand(state, cmd(state, 0, 'set_colony_tags', { colonyId: mine.id, tags: ['farm'] }));
    const json = gameEngine.serialize(state);
    const back = gameEngine.deserialize(json);
    expect(gameEngine.hash(back)).toBe(gameEngine.hash(state));
    expect(back.colonies.find((x) => x.id === mine.id)!.tags).toEqual(['farm']);
  });
});
