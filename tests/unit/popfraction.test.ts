// User hypothesis (bugs report, save 0a3b3533): population at 1.95 grows to
// 2.05, a food shortage then subtracts — and the player suspects a FULL unit
// is wrongly removed ("you're back to 1"). VERDICT: the engine only ever
// subtracts the fractional starvation nudge (50 popK = 0.05 units per food
// unit short, economy.ts groupGrowthK); what the player saw is the DISPLAY
// flooring integer units: 2.05 → "2", starve 0.10 → 1.95 → "1". These tests
// pin the arithmetic so a real full-unit regression can never hide behind
// the rounding again.
import { describe, expect, it } from 'vitest';
import { gameEngine } from '@engine/index';
import { colonyPopUnits, groupGrowthK } from '@engine/economy';
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

function advance(state: GameState): GameState {
  const next = gameEngine.apply(state, { turn: state.turn, playerId: -1, kind: 'advance_turn', payload: {} });
  if (next.phase === 'battle_orders') {
    return gameEngine.apply(next, { turn: next.turn, playerId: -1, kind: 'resolve_combat', payload: {} });
  }
  return next;
}

describe('fractional population vs food shortage (the 1.95 → 2.05 → shortage case)', () => {
  it('a 1-food shortage costs at most 0.05 pop units, never a whole unit', () => {
    const state = newGame();
    const home = state.colonies.find((c) => c.owner === 0 && !c.outpost)!;
    // exactly the reported shape: just crossed 2.0 (2.05 units)
    home.groups = [{ race: 0, popK: 2050, farmers: 0, workers: 2, scientists: 0, unrest: false }];
    home.foodLackPrev = 1; // one food unit short last turn
    const planet = state.planets.find((p) => p.id === home.planetId)!;
    const maxPop = 12;
    const inc = groupGrowthK(state, home, home.groups[0]!, maxPop, colonyPopUnits(home));
    // growth minus the 50-popK starvation nudge — the penalty term is -50,
    // so even with ZERO growth the group can only drop to 2000 (2.00), not 1050
    expect(inc).toBeGreaterThanOrEqual(-50);
    void planet;
  });

  it('a full engine turn under a mild shortage never drops a whole unit', () => {
    const state = newGame();
    const home = state.colonies.find((c) => c.owner === 0 && !c.outpost)!;
    home.groups = [{ race: 0, popK: 2050, farmers: 0, workers: 2, scientists: 0, unrest: false }];
    home.foodLackPrev = 1;
    const after = advance(state);
    const still = after.colonies.find((c) => c.id === home.id)!;
    const popK = still.groups.reduce((n, g) => n + g.popK, 0);
    // worst case: zero growth and the -50 nudge → 2000. A full-unit bug
    // would land at ~1050; the clamp floor (never below 1000) is 1000.
    expect(popK).toBeGreaterThanOrEqual(2000);
    expect(popK).toBeLessThanOrEqual(2050 + 500); // sanity: no runaway either
  });

  it('the "lost a full pop" illusion is display flooring, not the model', () => {
    // 2.05 renders as 2; a 0.10 starvation dip to 1.95 renders as 1 — the
    // screen reads "2 → 1" while the model moved a tenth of a unit
    const at205 = { groups: [{ race: 0, popK: 2050, farmers: 0, workers: 2, scientists: 0, unrest: false }] };
    const at195 = { groups: [{ race: 0, popK: 1950, farmers: 0, workers: 1, scientists: 0, unrest: false }] };
    expect(colonyPopUnits(at205 as never)).toBe(2);
    expect(colonyPopUnits(at195 as never)).toBe(1);
  });
});
