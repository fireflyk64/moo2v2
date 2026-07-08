// The seam between the lockstep protocol and the deterministic simulation.
// Phase 2 ships a stub adapter (counter game); Phase 3 swaps in the real engine
// behind the same interface without touching host/session code.

import { canonicalParse, canonicalStringify, hashCanonical } from '@engine/canonical';
import type { GameSettings, LogCommand } from './messages';

export interface GameStartPayload {
  seed: string;
  settings: GameSettings;
  players: Array<{ id: number; name: string; raceJson: string | null }>;
  dataVersion: string;
}

export interface EngineAdapter<S = unknown> {
  /** Fold seq-0 game_start into the initial state. */
  init(start: GameStartPayload): S;
  /** Host-side validation before acceptance. null = ok, else reject reason. */
  validate(state: S, cmd: LogCommand): string | null;
  /** Pure fold; must be deterministic and never throw for accepted commands. */
  apply(state: S, cmd: LogCommand): S;
  /** True when every seated player must have committed before advance_turn. */
  turnOf(state: S): number;
  hash(state: S): string;
  serialize(state: S): string;
  deserialize(json: string): S;
  /** Build the advance_turn system command payload for the current state. */
  advancePayload(state: S): unknown;
}

// ---------- Phase 2 stub: a lockstep counter game ----------

export interface StubState {
  turn: number;
  counters: Record<string, number>; // playerId -> count (string keys for canonical)
  totalCommands: number;
}

export const stubEngine: EngineAdapter<StubState> = {
  init(start) {
    const counters: Record<string, number> = {};
    for (const p of start.players) counters[String(p.id)] = 0;
    return { turn: 1, counters, totalCommands: 0 };
  },

  validate(state, cmd) {
    if (cmd.playerId === -1) return null;
    if (cmd.turn !== state.turn) return `command for turn ${cmd.turn}, current is ${state.turn}`;
    if (cmd.kind === 'increment') {
      const n = (cmd.payload as { n?: unknown })?.n;
      if (!Number.isSafeInteger(n)) return 'increment.n must be an integer';
      return null;
    }
    return `unknown command kind: ${cmd.kind}`;
  },

  apply(state, cmd) {
    if (cmd.kind === 'game_start') return state;
    if (cmd.kind === 'increment') {
      const n = (cmd.payload as { n: number }).n;
      const key = String(cmd.playerId);
      return {
        ...state,
        counters: { ...state.counters, [key]: (state.counters[key] ?? 0) + n },
        totalCommands: state.totalCommands + 1,
      };
    }
    if (cmd.kind === 'advance_turn') {
      return { ...state, turn: state.turn + 1, totalCommands: state.totalCommands + 1 };
    }
    return state;
  },

  turnOf(state) {
    return state.turn;
  },

  hash(state) {
    return hashCanonical(state);
  },

  serialize(state) {
    return canonicalStringify(state);
  },

  deserialize(json) {
    return canonicalParse(json) as unknown as StubState;
  },

  advancePayload(state) {
    return { fromTurn: state.turn };
  },
};
