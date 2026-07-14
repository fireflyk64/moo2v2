// Out-of-the-Box Thinking: a 2-point race pick (gated by the outOfBoxThinking game
// mode) that lets a race buy technologies it skipped in already-completed
// fields, each at the full listed field price, paid in research points via
// the same one-at-a-time queue the creative-variant purchases use.
import { describe, expect, it } from 'vitest';
import { gameEngine } from '@engine/index';
import { applyCommand, validateCommand } from '@engine/commands';
import { applyResearch } from '@engine/research';
import { applicationsOfField, fieldByNum, pickById } from '@engine/data/index';
import { resolveTraits } from '@engine/race';
import { rngFor } from '@engine/rng';
import type { GameState, TurnEvent } from '@engine/types';

const SEED = 'aaaabbbbccccddddeeeeffff00001111';

function newGame(outOfBoxThinkingMode: boolean, picks: string[]): GameState {
  return gameEngine.init({
    seed: SEED,
    settings: {
      galaxySize: 'small',
      startMode: 'average',
      playerCount: 2,
      modes: {
        creativeVariant: false,
        pickBidding: false,
        stickyBuild: false,
        antarans: false,
        randomEvents: false,
        outOfBoxThinking: outOfBoxThinkingMode,
      },
      battleOrdersTimeoutMs: 1000,
      debugCommands: true,
    },
    players: [
      { id: 0, name: 'A', raceJson: JSON.stringify({ picks, raceName: 'Persisters' }) },
      { id: 1, name: 'B', raceJson: JSON.stringify({ presetId: 'solari' }) },
    ],
    dataVersion: 'test',
  });
}

const extra = (state: GameState, appId: string, remove = false) => ({
  turn: state.turn,
  playerId: 0,
  kind: 'queue_extra_research',
  payload: { appId, remove },
});

describe('tech persistence', () => {
  it('the pick exists, costs 2, and resolves into the trait', () => {
    expect(pickById.get('out_of_box_thinking')?.cost).toBe(2);
    expect(resolveTraits(['dictatorship', 'out_of_box_thinking']).outOfBoxThinking).toBe(true);
    expect(resolveTraits(['dictatorship']).outOfBoxThinking).toBe(false);
  });

  it('the pick is stripped at init when the game mode is off', () => {
    const off = newGame(false, ['dictatorship', 'out_of_box_thinking']);
    const on = newGame(true, ['dictatorship', 'out_of_box_thinking']);
    expect(off.empires[0]!.picks).not.toContain('out_of_box_thinking');
    expect(on.empires[0]!.picks).toContain('out_of_box_thinking');
  });

  it('gates queue_extra_research on mode + pick, field completed, app unknown', () => {
    const noPick = newGame(true, ['dictatorship']);
    expect(validateCommand(noPick, extra(noPick, 'x'))).toContain('creative');

    const state = newGame(true, ['dictatorship', 'out_of_box_thinking']);
    // field not completed yet
    expect(validateCommand(state, extra(state, 'optronic_computer'))).toBeTruthy();
    const emp = state.empires[0]!;
    const fieldNum = 30;
    emp.completedFields.push(fieldNum);
    // now a skipped app of the completed field can be queued
    const apps = applicationsOfField(fieldByNum.get(fieldNum)!.id);
    const skipped = apps.find((a) => !emp.knownApps.includes(a.id))!.id;
    expect(validateCommand(state, extra(state, skipped))).toBeNull();
    applyCommand(state, extra(state, skipped));
    expect(emp.research.extraQueue).toContain(skipped);
  });

  it('a queued skipped tech completes once its full field price is paid in RP', () => {
    const state = newGame(true, ['dictatorship', 'out_of_box_thinking']);
    const emp = state.empires[0]!;
    emp.completedFields.push(30);
    const skipped = applicationsOfField(fieldByNum.get(30)!.id).find((a) => !emp.knownApps.includes(a.id))!.id;
    applyCommand(state, extra(state, skipped));
    const events: TurnEvent[] = [];
    const rng = rngFor(state.seed, 'test');
    // pay in small installments: must not complete before the full price
    applyResearch(state, emp, 10, rng, events);
    expect(emp.knownApps.includes(skipped)).toBe(false);
    for (let i = 0; i < 100 && !emp.knownApps.includes(skipped); i++) {
      applyResearch(state, emp, 100, rng, events);
    }
    expect(emp.knownApps).toContain(skipped);
    expect(events.some((e) => e.kind === 'research_complete')).toBe(true);
  });
});
