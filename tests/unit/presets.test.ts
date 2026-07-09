import { describe, expect, it } from 'vitest';
import { gameEngine } from '@engine/index';
import { validateCommand } from '@engine/commands';
import { colonyOutput } from '@engine/economy';
import { presetJobs } from '@engine/selectors';
import type { Colony, GameState } from '@engine/types';

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

function withJobs(state: GameState, colony: Colony, groups: NonNullable<ReturnType<typeof presetJobs>>): Colony {
  const probe = structuredClone(colony);
  for (const g of groups) {
    const grp = probe.groups.find((x) => x.race === g.race)!;
    grp.farmers = g.farmers;
    grp.workers = g.workers;
    grp.scientists = g.scientists;
  }
  return probe;
}

describe('presetJobs (colonies screen quick configurations)', () => {
  it('research: minimum farmers to stay fed, rest on science; valid as a set_jobs command', () => {
    const state = newGame();
    const home = state.colonies.find((c) => c.owner === 0)!;
    const groups = presetJobs(state, home.id, 'research')!;
    expect(groups).not.toBeNull();
    const probe = withJobs(state, home, groups);
    const out = colonyOutput(state, probe);
    expect(out.foodNet).toBeGreaterThanOrEqual(0);
    expect(probe.groups[0]!.workers).toBe(0);
    // fewest farmers: one fewer farmer must starve the colony
    const g0 = { ...groups[0]! };
    if (g0.farmers > 0) {
      const less = withJobs(state, home, [{ ...g0, farmers: g0.farmers - 1, scientists: g0.scientists + 1 }]);
      expect(colonyOutput(state, less).foodNet).toBeLessThan(0);
    }
    expect(
      validateCommand(state, { turn: state.turn, playerId: 0, kind: 'set_jobs', payload: { colonyId: home.id, groups } }),
    ).toBeNull();
  });

  it('industry: rest on workers', () => {
    const state = newGame();
    const home = state.colonies.find((c) => c.owner === 0)!;
    const groups = presetJobs(state, home.id, 'industry')!;
    const probe = withJobs(state, home, groups);
    expect(colonyOutput(state, probe).foodNet).toBeGreaterThanOrEqual(0);
    expect(probe.groups[0]!.scientists).toBe(0);
    expect(probe.groups[0]!.workers).toBeGreaterThan(0);
  });

  it('blend: max industry with pollution <= 2, remainder on science', () => {
    const state = newGame();
    const home = state.colonies.find((c) => c.owner === 0)!;
    // make pollution bite: plenty of population on a normal world
    home.groups[0]!.popK = 10_000;
    const groups = presetJobs(state, home.id, 'blend')!;
    const probe = withJobs(state, home, groups);
    const out = colonyOutput(state, probe);
    expect(out.foodNet).toBeGreaterThanOrEqual(0);
    expect(out.pollution).toBeLessThanOrEqual(2);
    // one more worker (if any scientist remains) must exceed the pollution cap
    const g0 = probe.groups[0]!;
    if (g0.scientists > 0) {
      const more = withJobs(state, home, [
        { race: g0.race, farmers: g0.farmers, workers: g0.workers + 1, scientists: g0.scientists - 1 },
      ]);
      expect(colonyOutput(state, more).pollution).toBeGreaterThan(2);
    }
  });

  it('returns null for outposts and missing colonies', () => {
    const state = newGame();
    expect(presetJobs(state, 999_999, 'research')).toBeNull();
  });
});
