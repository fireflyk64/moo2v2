// The frozen golden save: written by the FIRST v2-format build and committed.
// Every future build must keep loading it — in replay mode while versions
// still match, and in snapshot mode forever after. NEVER regenerate or edit
// the fixture (that would defeat its purpose); add new fixtures beside it
// when the format grows. See docs/save-compatibility.md.

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { gameEngine } from '@engine/index';
import { decodeSaveFile, verifySaveEnvelope } from '@storage/savefile';
import { rebaseSave } from '@storage/rebase';

const BYTES = new Uint8Array(readFileSync(new URL('./fixtures/golden-v2.moo2save.json', import.meta.url)));
const BRANCH_SEED = 'aaaa1111bbbb2222cccc3333dddd4444';

describe('golden save fixture stays loadable forever', () => {
  it('decodes, verifies (replay or snapshot mode), and yields a playable state', async () => {
    const envelope = await decodeSaveFile(BYTES);
    const verified = verifySaveEnvelope(envelope); // must not throw on ANY future build
    expect(verified.turn).toBeGreaterThan(1);
    expect(envelope.snapshot).not.toBeNull();

    // the universal load path every future build takes: rebase onto the snapshot
    const { envelope: branch, turn } = rebaseSave(envelope, 'snapshot', undefined, BRANCH_SEED);
    expect(turn).toBe(verified.turn);
    const state = gameEngine.init(JSON.parse(branch.commands[0]!.payload) as never);
    expect(gameEngine.turnOf(state)).toBe(turn);

    // the resumed game must actually play: advance one turn
    let s = gameEngine.apply(state, { turn: state.turn, playerId: -1, kind: 'advance_turn', payload: {} });
    gameEngine.takeEvents();
    if (s.phase === 'battle_orders') {
      s = gameEngine.apply(s, { turn: s.turn, playerId: -1, kind: 'resolve_combat', payload: {} });
      gameEngine.takeEvents();
    }
    expect(s.turn).toBe(turn + 1);
  });
});
