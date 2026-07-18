// Campaign-timelapse ballot (types.ts timelapseVotes): every living empire
// must opt in; the last vote latches timelapseReadyTurn and resets the ballot
// so the table can run it again next session. Plus the frame generator:
// replaying a headless game's log yields one unfogged frame per turn.

import { describe, expect, it } from 'vitest';
import { gameEngine } from '@engine/adapter';
import { applyCommand, validateCommand } from '@engine/commands';
import type { GameState, TurnEvent } from '@engine/types';
import { expanderBot, runHeadlessGame } from '../../src/headless/bots';
import { framesFromLog } from '../../src/ui/timelapse';

const SEED = 'aaaabbbbccccddddeeeeffff00001111';

function freshState(): GameState {
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

const vote = (playerId: number, turn: number) => ({ turn, playerId, kind: 'timelapse_vote', payload: {} });

describe('timelapse ballot', () => {
  it('latches when every living empire opts in, then resets', () => {
    const s = freshState();
    const events: TurnEvent[] = [];
    expect(validateCommand(s, vote(0, s.turn))).toBeNull();
    applyCommand(s, vote(0, s.turn), events);
    expect(s.timelapseVotes).toEqual([0]);
    expect(s.timelapseReadyTurn ?? null).toBeNull();
    expect(events.some((e) => e.kind === 'timelapse_vote')).toBe(true);

    // double vote is rejected
    expect(validateCommand(s, vote(0, s.turn))).not.toBeNull();

    applyCommand(s, vote(1, s.turn), events);
    expect(s.timelapseReadyTurn).toBe(s.turn);
    expect(s.timelapseVotes).toEqual([]); // ballot reset — repeatable next session
    expect(events.some((e) => e.kind === 'timelapse_ready')).toBe(true);

    // the same table can vote again later
    expect(validateCommand(s, vote(0, s.turn))).toBeNull();
  });

  it('eliminated empires neither vote nor block the ballot', () => {
    const s = freshState();
    s.empires[1]!.eliminated = true;
    expect(validateCommand(s, vote(1, s.turn))).not.toBeNull();
    applyCommand(s, vote(0, s.turn));
    expect(s.timelapseReadyTurn).toBe(s.turn); // the sole living empire suffices
  });
});

describe('timelapse frame generator', () => {
  it('replays a headless log into one frame per turn with owners and stats', async () => {
    const TURNS = 12;
    const players = [
      { id: 0, name: 'A', raceJson: JSON.stringify({ presetId: 'solari' }) },
      { id: 1, name: 'B', raceJson: JSON.stringify({ presetId: 'solari' }) },
    ];
    const { state, log } = runHeadlessGame({
      seed: SEED,
      turns: TURNS,
      players: players.map((p) => ({ ...p, policy: expanderBot })),
    });
    // the stored record always begins with the seq-0 game_start; the headless
    // harness inits directly, so prepend the equivalent
    const gameStart = {
      turn: 0,
      playerId: -1,
      kind: 'game_start',
      payload: { seed: SEED, settings: state.settings, players, dataVersion: 'test' },
    };
    const data = await framesFromLog([gameStart, ...log]);
    expect(data.stars.length).toBeGreaterThan(5);
    expect(data.empires.map((e) => e.id)).toEqual([0, 1]);
    expect(data.frames[0]!.turn).toBe(1);
    expect(data.frames[data.frames.length - 1]!.turn).toBe(state.turn);
    // consecutive turns, no gaps
    for (let i = 1; i < data.frames.length; i++) {
      expect(data.frames[i]!.turn).toBe(data.frames[i - 1]!.turn + 1);
    }
    // every frame shows both homeworlds owned and live stats
    for (const f of data.frames) {
      const owners = new Set(f.owners.flatMap(([, os]) => os));
      expect(owners.has(0)).toBe(true);
      expect(owners.has(1)).toBe(true);
      expect(f.stats).toHaveLength(2);
      expect(f.stats[0]!.pop).toBeGreaterThan(0);
    }
  });
});
