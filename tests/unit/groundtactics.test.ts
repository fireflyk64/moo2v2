import { describe, expect, it } from 'vitest';
import { gameEngine } from '@engine/index';
import { validateCommand, applyCommand } from '@engine/commands';
import {
  ATTACK_TACTICS,
  DEFENSE_TACTICS,
  generateTerrain,
  groundModifiers,
  terrainFractions,
  TERRAIN_H,
  TERRAIN_W,
} from '@engine/groundTactics';
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

describe('planet terrain', () => {
  it('is deterministic per (planetId, climate) and correctly sized', () => {
    const a = generateTerrain(42, 'desert');
    const b = generateTerrain(42, 'desert');
    expect(a).toEqual(b);
    expect(a).toHaveLength(TERRAIN_H);
    for (const row of a) expect(row).toHaveLength(TERRAIN_W);
    // different worlds get different maps
    expect(generateTerrain(43, 'desert')).not.toEqual(a);
  });

  it('anchors the colony with urban blocks at the right edge', () => {
    const rows = generateTerrain(7, 'terran');
    const rightEdge = rows.map((r) => r[TERRAIN_W - 1]).join('');
    expect(rightEdge).toContain('u');
  });

  it('rocky climates carry the defensive cover (ridge/craters)', () => {
    const rocky = terrainFractions(generateTerrain(11, 'barren'));
    const lush = terrainFractions(generateTerrain(11, 'gaia'));
    expect((rocky['r'] ?? 0) + (rocky['c'] ?? 0)).toBeGreaterThan((lush['r'] ?? 0) + (lush['c'] ?? 0));
  });
});

describe('ground tactic modifiers', () => {
  const plains = Array(TERRAIN_H).fill('p'.repeat(TERRAIN_W));
  const craters = Array(TERRAIN_H).fill('c'.repeat(TERRAIN_W));

  it('both tactics absent = exact legacy neutrality', () => {
    expect(groundModifiers(undefined, undefined, null)).toEqual({ atkMult: 1, defMult: 1 });
  });

  it('applies the RPS matchup: charge breaks lines, dies on fortresses', () => {
    const vsLine = groundModifiers('charge', 'long_line', plains);
    const vsFort = groundModifiers('charge', 'fortress', plains);
    expect(vsLine.atkMult).toBeGreaterThan(vsFort.atkMult);
    expect(vsFort.atkMult).toBeLessThan(1);
  });

  it('terrain fit matters: a charge across craters is worse than across plains', () => {
    const open = groundModifiers('charge', 'long_line', plains);
    const rough = groundModifiers('charge', 'long_line', craters);
    expect(open.atkMult).toBeGreaterThan(rough.atkMult);
    // while infiltrators prefer it the other way (craters are not cover, so
    // compare against a forest map for the cover case)
    const forest = Array(TERRAIN_H).fill('f'.repeat(TERRAIN_W));
    expect(groundModifiers('infiltrate', 'long_line', forest).atkMult).toBeGreaterThan(
      groundModifiers('infiltrate', 'long_line', plains).atkMult,
    );
  });

  it('defenders mine the ground: crater cover beats open plains', () => {
    const open = groundModifiers('charge', 'defense_in_depth', plains);
    const rough = groundModifiers('charge', 'defense_in_depth', craters);
    expect(rough.defMult).toBeGreaterThan(open.defMult);
  });

  it('every tactic pair yields sane bounded multipliers', () => {
    for (const atk of ATTACK_TACTICS) {
      for (const def of DEFENSE_TACTICS) {
        const m = groundModifiers(atk, def, craters);
        expect(m.atkMult).toBeGreaterThanOrEqual(0.4);
        expect(m.atkMult).toBeLessThanOrEqual(2);
        expect(m.defMult).toBeGreaterThanOrEqual(0.4);
        expect(m.defMult).toBeLessThanOrEqual(2.5);
      }
    }
  });
});

describe('set_ground_tactic command', () => {
  it('sets, clears, and validates the standing doctrine', () => {
    const state = newGame();
    const colony = state.colonies.find((c) => c.owner === 0 && !c.outpost)!;
    const cmd = (playerId: number, payload: unknown) => ({ kind: 'set_ground_tactic', playerId, seq: 1, turn: state.turn, payload });

    expect(validateCommand(state, cmd(0, { colonyId: colony.id, tactic: 'fortress' }))).toBeNull();
    applyCommand(state, cmd(0, { colonyId: colony.id, tactic: 'fortress' }));
    expect(colony.groundTactic).toBe('fortress');

    applyCommand(state, cmd(0, { colonyId: colony.id, tactic: null }));
    expect(colony.groundTactic).toBeUndefined();

    expect(validateCommand(state, cmd(1, { colonyId: colony.id, tactic: 'fortress' }))).toMatch(/not your colony/);
    expect(validateCommand(state, cmd(0, { colonyId: colony.id, tactic: 'banzai' }))).toMatch(/unknown doctrine/);
    expect(validateCommand(state, cmd(0, { colonyId: 999999, tactic: 'fortress' }))).toMatch(/no colony/);
  });
});
