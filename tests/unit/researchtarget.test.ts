// bug report 2026-07-18: "I researched soil enrichment and got population
// growth center. It seems to always default to the first tech." Root cause:
// applyResearch cleared research.targetApp BEFORE completeField read it, so a
// non-creative empire always received the field's first pickable application
// no matter what the player targeted.

import { describe, expect, it } from 'vitest';
import { gameEngine } from '@engine/index';
import { applyResearch, fieldCost } from '@engine/research';
import { rngFor } from '@engine/rng';
import { FIELD_ROWS, applicationsOfField } from '@engine/data/index';
import { fieldGrantsAll } from '@engine/research';
import type { GameState, TurnEvent } from '@engine/types';

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
      { id: 0, name: 'A', raceJson: JSON.stringify({ presetId: 'solari' }) }, // non-creative, non-uncreative
      { id: 1, name: 'B', raceJson: JSON.stringify({ presetId: 'solari' }) },
    ],
    dataVersion: 'test',
  });
}

/** every choice field (>=2 apps, no grant-all) whose apps are all unknown */
function choiceFields(state: GameState) {
  const empire = state.empires[0]!;
  return FIELD_ROWS.filter((f) => {
    if (f.id.startsWith('advf_') || fieldGrantsAll(f)) return false;
    const apps = applicationsOfField(f.id);
    return apps.length >= 2 && apps.every((a) => !empire.knownApps.includes(a.id));
  });
}

describe('research completion grants the TARGETED application', () => {
  it('a non-first target is granted, not the first app of the field', () => {
    const state = newGame();
    const empire = state.empires[0]!;
    // exercise several fields: before the fix, EVERY one granted apps[0]
    for (const field of choiceFields(state).slice(0, 5)) {
      const apps = applicationsOfField(field.id).filter((a) => !empire.knownApps.includes(a.id));
      if (apps.length < 2) continue;
      const target = apps[apps.length - 1]!.id;
      empire.research.fieldNum = field.num;
      empire.research.targetApp = target;
      empire.research.accumRP = 0;
      const events: TurnEvent[] = [];
      // the hidden discovery line never exceeds 2x listed: this always completes
      applyResearch(state, empire, fieldCost(state, empire, field), rngFor(SEED, state.turn, 'research', 0), events);
      expect(empire.research.fieldNum, field.id).toBeNull();
      expect(empire.knownApps, `${field.id} should grant ${target}`).toContain(target);
      expect(empire.knownApps, `${field.id} must not fall back to ${apps[0]!.id}`).not.toContain(apps[0]!.id);
      const done = events.find((e) => e.kind === 'research_complete');
      expect(done?.payload['granted']).toEqual([target]);
    }
  });

  it('no target set still falls back to the first pickable application', () => {
    const state = newGame();
    const empire = state.empires[0]!;
    const field = choiceFields(state)[0]!;
    const apps = applicationsOfField(field.id);
    empire.research.fieldNum = field.num;
    empire.research.targetApp = null;
    empire.research.accumRP = 0;
    const events: TurnEvent[] = [];
    applyResearch(state, empire, fieldCost(state, empire, field), rngFor(SEED, state.turn, 'research', 0), events);
    expect(empire.knownApps).toContain(apps[0]!.id);
  });

  it('the target is cleared after completion (no bleed into the next field)', () => {
    const state = newGame();
    const empire = state.empires[0]!;
    const field = choiceFields(state)[0]!;
    const apps = applicationsOfField(field.id);
    empire.research.fieldNum = field.num;
    empire.research.targetApp = apps[1]!.id;
    empire.research.accumRP = 0;
    applyResearch(state, empire, fieldCost(state, empire, field), rngFor(SEED, state.turn, 'research', 0), []);
    expect(empire.research.targetApp).toBeNull();
  });
});
