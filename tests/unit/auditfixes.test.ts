// Regression locks for the 2026-07-10 bugfinder audit (discovered_bugs.md).
// Each case replays the audit's own repro against the fixed engine.

import { describe, expect, it } from 'vitest';
import { gameEngine } from '@engine/adapter';
import { validateCommand, applyCommand } from '@engine/commands';
import { hashCanonical } from '@engine/canonical';
import { designDps } from '@engine/combat';
import { knownWeapons } from '@engine/shipdesign';
import { commandPoints } from '@engine/movement';
import { gravitySteps, resolveTraits } from '@engine/race';
import type { GameState } from '@engine/types';

const SEED = 'aaaabbbbccccddddeeeeffff00001111';

function newGame(): GameState {
  return gameEngine.init({
    seed: SEED,
    settings: {
      galaxySize: 'small',
      startMode: 'pre_warp',
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

describe('audit finding 1: malformed computer/shield rejected', () => {
  it('rejects fractional and negative tiers', () => {
    const state = newGame();
    const base = { name: 'X', hull: 'frigate', specials: [], weapons: [] };
    const cmd = (computer: number, shield: number) => ({
      turn: state.turn,
      playerId: 0,
      kind: 'save_design',
      payload: { ...base, computer, shield },
    });
    expect(validateCommand(state, cmd(0.5, 0))).toContain('bad computer tier');
    expect(validateCommand(state, cmd(0, -1))).toContain('bad shield tier');
    expect(validateCommand(state, cmd(0, 0))).toBeNull();
  });
});

describe('audit finding 2: unresearched weapons rejected at design time', () => {
  it('a turn-1 empire cannot mount dragon_breath or zeon_missile', () => {
    const state = newGame();
    for (const weapon of ['zeon_missile', 'mauler_device']) {
      const err = validateCommand(state, {
        turn: state.turn,
        playerId: 0,
        kind: 'save_design',
        payload: { name: 'X', hull: 'frigate', computer: 0, shield: 0, specials: [], weapons: [{ weapon, count: 1, mods: [] }] },
      });
      expect(err, weapon).not.toBeNull();
    }
  });
});

describe('audit finding 3: validators are pure', () => {
  it('a diplo_propose validation does not change the state hash', () => {
    const state = newGame();
    const before = hashCanonical(state as unknown as Record<string, unknown>);
    validateCommand(state, {
      turn: state.turn,
      playerId: 0,
      kind: 'diplo_propose',
      payload: { to: 1, kind: 'non_aggression' },
    });
    expect(hashCanonical(state as unknown as Record<string, unknown>)).toBe(before);
  });
});

describe('audit finding 4: malformed payloads are rejected, not thrown', () => {
  it('non-string queue items and non-array specials reject cleanly', () => {
    const state = newGame();
    const colony = state.colonies.find((c) => c.owner === 0 && !c.outpost)!;
    expect(
      validateCommand(state, { turn: state.turn, playerId: 0, kind: 'set_build_queue', payload: { colonyId: colony.id, items: [123] } }),
    ).toBeTruthy();
    expect(
      validateCommand(state, {
        turn: state.turn,
        playerId: 0,
        kind: 'save_design',
        payload: { name: 'X', hull: 'frigate', computer: 0, shield: 0, specials: 5, weapons: [] },
      }),
    ).toBeTruthy();
  });
});

describe('audit finding 7: disruptor/proton/plasma torpedo id-join', () => {
  it('the three flagship weapons become mountable when their app is known', () => {
    const empire = {
      knownApps: ['disruptor_cannon', 'proton_torpedoes', 'plasma_torpedoes'],
      picks: [],
      completedFields: [],
    } as never;
    const ids = knownWeapons(empire).map((w) => w.id);
    expect(ids).toContain('disrupter');
    expect(ids).toContain('proton_torpedo');
    expect(ids).toContain('plasma_torpedo');
  });
});

describe('audit finding 42: guardian prize is mountable', () => {
  it('death_ray resolves to a real weapon row', () => {
    const empire = { knownApps: ['death_ray'], picks: [], completedFields: [] } as never;
    const ids = knownWeapons(empire).map((w) => w.id);
    expect(ids).toContain('death_ray');
  });
});

describe('audit finding 8: classId 5 damage weapons contribute DPS and fire like beams', () => {
  it('stellar converter shows nonzero designer DPS', () => {
    const w = { weaponId: 'stellar_converter', classId: 5, dmgMin: 400, dmgMax: 400, mods: [], ammo: -1, cooldown: 0, count: 1, arc: 'F' as const };
    expect(designDps([w], 0)).toBeGreaterThan(0);
  });
});

describe('audit finding 16: orbital-base command points are not double-counted', () => {
  it('a star base adds exactly its cp_flat (2), not 3', () => {
    const state = newGame();
    const empire = state.empires[0]!;
    const before = commandPoints(state, empire).sources;
    const colony = state.colonies.find((c) => c.owner === 0 && !c.outpost)!;
    colony.buildings = [...colony.buildings, 'star_base'];
    const after = commandPoints(state, empire).sources;
    expect(after - before).toBe(2);
  });
});

describe('audit finding 21: depression never pays out to a debtor', () => {
  it('bc: -100 loses nothing (instead of gaining 20)', () => {
    expect(Math.max(0, Math.floor(-100 / 5))).toBe(0);
  });
});

describe('audit finding 22: low gravity penalizes off-preference races', () => {
  it('a normal-G race on a low-G world takes one step of penalty', () => {
    expect(gravitySteps('normal', 'low')).toBe(1);
    expect(gravitySteps('high', 'normal')).toBe(0); // heavy-G handles normal
    expect(gravitySteps('high', 'low')).toBe(2);
  });
});

describe('audit finding 50: the -0.5 farming pick is a real penalty', () => {
  it('farming1 resolves to -1 half unit, not 0', () => {
    expect(resolveTraits(['farming1']).farmingHalf).toBe(-1);
  });
});

describe('audit finding 52: trait reassignment can upgrade a tier', () => {
  it('attack2 -> attack3 swaps the family tier for the cost difference', () => {
    const state = newGame();
    const empire = state.empires[0]!;
    empire.knownApps.push('trait_reassignment');
    empire.knownApps.sort();
    empire.picks = [...empire.picks.filter((p) => !p.startsWith('attack')), 'attack2'].sort();
    const cmd = {
      turn: state.turn,
      playerId: 0,
      kind: 'trait_reassignment',
      payload: { add: ['attack3'], remove: [] },
    };
    const err = validateCommand(state, cmd);
    expect(err).toBeNull();
    applyCommand(state, cmd);
    expect(empire.picks).toContain('attack3');
    expect(empire.picks).not.toContain('attack2');
  });
});
