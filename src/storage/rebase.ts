// Rebase a save onto a chosen turn: build a fresh single-command envelope
// whose game_start embeds the state at that turn (resumeState). Used for
//  - "what-if" branches from an older turn of a same-version save, and
//  - loading a save written by a DIFFERENT engine/data version, where the
//    log cannot be replayed and the embedded snapshot is the load base.
// The branch gets a NEW public seed (=> new game id) so it never collides
// with the original game; the simulation's own RNG still flows from the
// seed inside the state, so the continuation stays deterministic.

import { ENGINE_VERSION, gameEngine } from '@engine/index';
import { DATA_VERSION } from '@engine/data/index';
import { canonicalParse, canonicalStringify, hashCanonical } from '@engine/canonical';
import type { SaveEnvelope, SaveSnapshot } from './repo';
import { SaveFileError } from './savefile';

export interface RebaseResult {
  envelope: SaveEnvelope;
  turn: number;
}

/** State JSON at the requested turn.
 *  replay mode: fold the log until the turn counter reaches `atTurn`.
 *  snapshot mode: nearest embedded snapshot at or before `atTurn`. */
function stateJsonAt(envelope: SaveEnvelope, mode: 'replay' | 'snapshot', atTurn: number | undefined): string {
  if (mode === 'replay') {
    let state: ReturnType<typeof gameEngine.init> | null = null;
    for (const c of envelope.commands) {
      if (atTurn !== undefined && state && gameEngine.turnOf(state) >= atTurn) break;
      const payload = JSON.parse(c.payload) as unknown;
      state = c.kind === 'game_start' ? gameEngine.init(payload as never) : gameEngine.apply(state!, { turn: c.turn, playerId: c.playerId, kind: c.kind, payload });
      gameEngine.takeEvents();
    }
    if (!state) throw new SaveFileError('replay', 'log produced no state');
    if (atTurn !== undefined && gameEngine.turnOf(state) < atTurn) {
      throw new SaveFileError('replay', `save ends at turn ${gameEngine.turnOf(state)}; cannot resume at ${atTurn}`);
    }
    return gameEngine.serialize(state);
  }
  const all: SaveSnapshot[] = [...(envelope.snapshots ?? []), ...(envelope.snapshot ? [envelope.snapshot] : [])].sort(
    (a, b) => a.turn - b.turn,
  );
  if (!all.length) throw new SaveFileError('snapshot', 'save has no snapshot to load from');
  const eligible = atTurn === undefined ? all : all.filter((s) => s.turn <= atTurn);
  if (!eligible.length) {
    throw new SaveFileError('snapshot', `no snapshot at or before turn ${atTurn} (available: ${all.map((s) => s.turn).join(', ')})`);
  }
  return eligible[eligible.length - 1]!.stateJson;
}

export function rebaseSave(
  envelope: SaveEnvelope,
  mode: 'replay' | 'snapshot',
  atTurn: number | undefined,
  newSeed: string,
): RebaseResult {
  const stateJson = stateJsonAt(envelope, mode, atTurn);
  const state = canonicalParse(stateJson) as { turn: number; settings: unknown };
  const startPayload = {
    seed: newSeed,
    settings: state.settings,
    players: envelope.players.map((p) => ({ id: p.player_id, name: p.name, raceJson: p.race_json })),
    dataVersion: DATA_VERSION,
    resumeState: stateJson,
  };
  const stateHash = hashCanonical(canonicalParse(stateJson) as Record<string, unknown>);
  const branch: SaveEnvelope = {
    format: 'moo2v2-save',
    version: 2,
    game: {
      ...envelope.game,
      game_id: `g-${newSeed.slice(0, 16)}`,
      seed: newSeed,
      engine_version: ENGINE_VERSION,
      data_version: DATA_VERSION,
      last_seq: 0,
      last_turn: state.turn,
    },
    players: envelope.players.map((p) => ({ ...p, game_id: `g-${newSeed.slice(0, 16)}` })),
    commands: [
      { seq: 0, turn: 0, playerId: -1, kind: 'game_start', payload: canonicalStringify(startPayload) },
    ],
    snapshot: { turn: state.turn, seq: 0, stateJson, stateHash },
    snapshots: [],
    history: false,
  };
  return { envelope: branch, turn: state.turn };
}
