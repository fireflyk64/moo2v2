// Weapon mod gating (bug): MIRV/ECCM need research TWO field levels beyond
// the weapon in its subject; point defense needs one.

import { describe, expect, it } from 'vitest';
import { gameEngine } from '@engine/index';
import { modUnlocked } from '@engine/shipdesign';
import { validateCommand } from '@engine/commands';
import { FIELD_ROWS } from '@engine/data/index';
import type { GameState } from '@engine/types';

const SEED = 'aaaabbbbccccddddeeeeffff00001111';

function newGame(): GameState {
  return gameEngine.init({
    seed: SEED,
    settings: {
      galaxySize: 'small',
      startMode: 'pre_warp', // base fields only: nothing deeper is known yet
      playerCount: 2,
      modes: { creativeVariant: false, pickBidding: false, stickyBuild: false, antarans: false, randomEvents: false },
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

describe('advanced weapon mods unlock with deeper research', () => {
  it('MIRV is locked at game start and a MIRVed design is rejected', () => {
    const state = newGame();
    const empire = state.empires[0]!;
    expect(modUnlocked(empire, 'nuclear_missile', 'mv')).toBe(false);
    expect(modUnlocked(empire, 'laser_cannon', 'pd')).toBe(false);
    // the base weapon itself is fine
    expect(modUnlocked(empire, 'laser_cannon', 'hv')).toBe(true);

    const err = validateCommand(state, {
      turn: state.turn,
      playerId: 0,
      kind: 'save_design',
      payload: {
        name: 'Cheater',
        hull: 'frigate',
        computer: 0,
        shield: 0,
        specials: [],
        weapons: [{ weapon: 'laser_cannon', count: 1, mods: ['pd'] }],
      },
    });
    expect(err).toContain('deeper research');
  });

  it('mastering the whole tree unlocks everything', () => {
    const state = newGame();
    const empire = state.empires[0]!;
    empire.completedFields = FIELD_ROWS.map((f) => f.num).sort((a, b) => a - b);
    expect(modUnlocked(empire, 'nuclear_missile', 'mv')).toBe(true);
    expect(modUnlocked(empire, 'nuclear_missile', 'eccm')).toBe(true);
    expect(modUnlocked(empire, 'laser_cannon', 'pd')).toBe(true);
  });
});
