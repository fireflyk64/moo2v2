import { describe, expect, it } from 'vitest';
import { gameEngine } from '@engine/index';
import { validateCommand, applyCommand } from '@engine/commands';
import {
  ATTACK_TACTICS,
  DEFENSE_TACTICS,
  fightGroundRounds,
  generateTerrain,
  groundModifiers,
  pickGroundAttack,
  pickGroundDefense,
  terrainFractions,
  TERRAIN_H,
  TERRAIN_W,
  type AttackTactic,
  type DefenseTactic,
} from '@engine/groundTactics';
import { rngFor } from '@engine/rng';
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
    // on a REALISTIC mixed map (no real climate is 100% open) the fortress
    // matchup penalty dominates the open-ground fit bonus
    const mixed = [...Array<string>(TERRAIN_H / 2).fill('p'.repeat(TERRAIN_W)), ...Array<string>(TERRAIN_H / 2).fill('c'.repeat(TERRAIN_W))];
    expect(groundModifiers('charge', 'fortress', mixed).atkMult).toBeLessThan(1);
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

describe('fightGroundRounds (shared with the battle lab)', () => {
  it('is deterministic and conserves the books', () => {
    const a = fightGroundRounds(20, 6, 8, 24, 22, 16, rngFor(SEED, 0, 'ground-lab', 42));
    const b = fightGroundRounds(20, 6, 8, 24, 22, 16, rngFor(SEED, 0, 'ground-lab', 42));
    expect(a).toEqual(b);
    // one side is annihilated, the other keeps its survivors
    expect(a.troops === 0 || a.defMarines + a.militia === 0).toBe(true);
    const last = a.rounds[a.rounds.length - 1]!;
    expect(last.t).toBe(a.troops);
    expect(last.m).toBe(a.defMarines + a.militia);
    // marines die before militia, civilians only fall with militia (1:1, floor 1 pop)
    expect(a.civilianLosses).toBeLessThanOrEqual(8 - a.militia);
    expect(a.rounds[0]).toEqual({ t: 20, m: 14 });
  });

  it('thins long sieges to ~60 replay rounds', () => {
    const big = fightGroundRounds(300, 100, 200, 20, 20, 400, rngFor(SEED, 0, 'ground-lab', 7));
    expect(big.rounds.length).toBeLessThanOrEqual(61);
    expect(big.rounds[big.rounds.length - 1]!.t).toBe(big.troops);
  });
});

// pure terrain of one zone char, for scoring the pickers against a known map
const flat = (ch: string): string[] => Array.from({ length: TERRAIN_H }, () => ch.repeat(TERRAIN_W));

describe('pickGroundAttack', () => {
  it('never picks a tactic the resolver would score below its best', () => {
    // the pick IS the argmax of the resolver's own atkMult, so it can never
    // be beaten by another tactic on the same ground
    for (const ch of ['p', 'f', 'r', 'c', 'm', 'u', 'd', 'i', 'l', 'h']) {
      const terrain = flat(ch);
      const best = pickGroundAttack(terrain);
      const bestMult = groundModifiers(best, undefined, terrain).atkMult;
      for (const atk of ATTACK_TACTICS) {
        expect(groundModifiers(atk, undefined, terrain).atkMult).toBeLessThanOrEqual(bestMult + 1e-9);
      }
    }
  });

  it('reads the ground: cover wants infiltration, broken rock wants overwatch, open wants shock', () => {
    // forest/marsh/urban = cover -> an infiltration
    expect(pickGroundAttack(flat('f'))).toBe('infiltrate');
    expect(pickGroundAttack(flat('u'))).toBe('infiltrate');
    // ridge/craters/lava = broken rock -> fire-and-move
    expect(pickGroundAttack(flat('r'))).toBe('bounding_overwatch');
    expect(pickGroundAttack(flat('l'))).toBe('bounding_overwatch');
    // plains/dunes = open -> a charge or a flank, never an infiltration
    expect(['charge', 'flank', 'hammer_and_anvil']).toContain(pickGroundAttack(flat('p')));
    expect(pickGroundAttack(flat('f'))).not.toBe(pickGroundAttack(flat('r')));
  });

  it('folds in the RPS matchup when the defender doctrine is known', () => {
    // on neutral ground the pick is driven purely by the matrix row
    const neutral: string[] | null = null;
    for (const def of DEFENSE_TACTICS) {
      const pick = pickGroundAttack(neutral, def);
      let bestMult = -Infinity;
      let best: AttackTactic = 'charge';
      for (const atk of ATTACK_TACTICS) {
        const m = groundModifiers(atk, def, neutral).atkMult;
        if (m > bestMult) { bestMult = m; best = atk; }
      }
      expect(pick).toBe(best);
    }
  });
});

describe('pickGroundDefense', () => {
  it('a militia-heavy colony forts up; a marine-heavy garrison maneuvers', () => {
    const terran = generateTerrain(4242, 'terran');
    // almost all civilians: fortress lets them fight full strength behind walls
    expect(pickGroundDefense(0.1, terran)).toBe('fortress');
    // almost all trained marines: a maneuver doctrine leverages them
    const marineHeavy = pickGroundDefense(0.85, terran);
    expect(['defense_in_depth', 'charge']).toContain(marineHeavy);
    expect(marineHeavy).not.toBe('fortress');
  });

  it('never picks a doctrine the composition-weighted resolver would beat', () => {
    for (const climate of ['terran', 'desert', 'swamp', 'hostile']) {
      const terrain = generateTerrain(99, climate);
      for (const share of [0, 0.3, 0.6, 1]) {
        const pick = pickGroundDefense(share, terrain);
        const score = (def: DefenseTactic) => {
          const defMult = groundModifiers(undefined, def, terrain).defMult;
          const comp = { fortress: [1, 1], long_line: [1, 0.95], defense_in_depth: [1.3, 0.7], charge: [1.6, 0.5] }[def]!;
          return defMult * (share * comp[0]! + (1 - share) * comp[1]!);
        };
        for (const def of DEFENSE_TACTICS) {
          expect(score(pick)).toBeGreaterThanOrEqual(score(def) - 1e-9);
        }
      }
    }
  });

  it('is monotone in composition: more marines never pushes it back toward fortress', () => {
    // as the garrison trains up, the pick moves from walls toward maneuver,
    // never the other way — the compFactors are ordered that way
    const terrain = generateTerrain(7, 'terran');
    const order: Record<string, number> = { fortress: 0, long_line: 1, defense_in_depth: 2, charge: 3 };
    let prev = -1;
    for (const share of [0, 0.25, 0.5, 0.75, 1]) {
      const rank = order[pickGroundDefense(share, terrain)]!;
      expect(rank).toBeGreaterThanOrEqual(prev);
      prev = rank;
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
