// Trait Reassignment (docs mechanics/tech/ecology.md): researching it grants
// 4 extra pick points to remove disadvantages or add advantages, once per
// game. Traits resolve dynamically from empire.picks, so the respec takes
// effect immediately.

import { describe, expect, it } from 'vitest';
import { gameEngine } from '@engine/index';
import { applyCommand, validateCommand } from '@engine/commands';
import { pickById, GOVERNMENTS } from '@engine/data/index';
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
      debugCommands: true,
    },
    players: [
      { id: 0, name: 'A', raceJson: JSON.stringify({ presetId: 'lithor' }) }, // has 'repulsive' (a flaw)
      { id: 1, name: 'B', raceJson: JSON.stringify({ presetId: 'solari' }) },
    ],
    dataVersion: 'test',
  });
}

const cmd = (state: GameState, payload: unknown) => ({
  turn: state.turn,
  playerId: 0,
  kind: 'trait_reassignment',
  payload,
});

function grant(state: GameState) {
  applyCommand(state, { turn: state.turn, playerId: 0, kind: 'debug_grant_app', payload: { appId: 'trait_reassignment' } });
}

/** any advantage with the exact cost, not already picked, no exclusive clash */
function findAdvantage(state: GameState, maxCost: number): string {
  const held = new Set(state.empires[0]!.picks);
  for (const [id, row] of pickById) {
    if (row.cost > 0 && row.cost <= maxCost && !held.has(id) && !(GOVERNMENTS as readonly string[]).includes(id)) {
      const probe = validateCommand(state, cmd(state, { add: [id], remove: [] }));
      if (probe === null) return id;
    }
  }
  throw new Error('no candidate advantage found');
}

describe('trait reassignment (+4 pick points, once)', () => {
  it('is locked until researched', () => {
    const state = newGame();
    expect(validateCommand(state, cmd(state, { add: [], remove: ['repulsive'] }))).toContain('not researched');
  });

  it('spends up to 4 points on new advantages and removing flaws — once', () => {
    const state = newGame();
    grant(state);
    // removing a flaw costs its refund: pick one that fits the 4-point budget
    const affordableFlaw = state.empires[0]!.picks.find((id) => {
      const cost = pickById.get(id)?.cost ?? 0;
      return cost < 0 && -cost <= 4;
    });
    const budgetLeft = 4 - (affordableFlaw ? -pickById.get(affordableFlaw)!.cost : 0);
    const addId = budgetLeft > 0 ? findAdvantage(state, budgetLeft) : null;

    const payload = { add: addId ? [addId] : [], remove: affordableFlaw ? [affordableFlaw] : [] };
    const c = cmd(state, payload);
    expect(validateCommand(state, c)).toBeNull();
    applyCommand(state, c);
    if (affordableFlaw) expect(state.empires[0]!.picks).not.toContain(affordableFlaw);
    if (addId) expect(state.empires[0]!.picks).toContain(addId);
    expect(state.empires[0]!.traitReassigned).toBe(true);

    // once per game
    expect(validateCommand(state, cmd(state, { add: [], remove: [] }))).toContain('already');

    // an expensive flaw like repulsive (−6) can never fit the 4-point budget
    expect(-pickById.get('repulsive')!.cost).toBeGreaterThan(4);
  });

  it('rejects overspending, governments, non-flaw removals and duplicates', () => {
    const state = newGame();
    grant(state);
    // pile on advantages beyond 4 points
    const expensive = [...pickById.values()].filter((p) => p.cost >= 3 && !(GOVERNMENTS as readonly string[]).includes(p.id) && !state.empires[0]!.picks.includes(p.id)).slice(0, 2).map((p) => p.id);
    expect(validateCommand(state, cmd(state, { add: expensive, remove: [] }))).toContain('points');
    // governments are untouchable
    expect(validateCommand(state, cmd(state, { add: ['democracy'], remove: [] }))).toBeTruthy();
    // cannot "remove" an advantage for refund
    const anAdvantage = state.empires[0]!.picks.find((id) => (pickById.get(id)?.cost ?? 0) > 0);
    if (anAdvantage) {
      expect(validateCommand(state, cmd(state, { add: [], remove: [anAdvantage] }))).toContain('not a disadvantage');
    }
    // cannot add something already held
    const held = state.empires[0]!.picks.find((id) => (pickById.get(id)?.cost ?? 0) > 0);
    if (held) expect(validateCommand(state, cmd(state, { add: [held], remove: [] }))).toBeTruthy();
  });
});
