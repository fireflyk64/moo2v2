// Replay mode: reconstruct a saved game's full state at every turn so the
// viewer can scrub time and look through ANY player's eyes. Fog is a pure
// function of (state, empireId) — selectors.galaxyView — so per-perspective
// vision costs nothing beyond keeping the boundary states.
//
// Same-version saves with history fold the command log (replay(log) == state,
// the engine invariant); cross-version or history-stripped saves degrade to
// the embedded snapshot turns.

import { createGameEngine } from '@engine/adapter';
import type { GameState, TurnEvent } from '@engine/types';
import type { SavePreview } from './saveload';

export interface ReplayEmpireMeta {
  id: number;
  name: string;
  raceName: string;
  color?: string;
}

export interface ReplayData {
  /** turns with a stored state, ascending (replay mode: every turn) */
  turns: number[];
  stateAt: Map<number, GameState>;
  /** the resolution events that PRODUCED each stored turn's state */
  eventsAt: Map<number, TurnEvent[]>;
  empires: ReplayEmpireMeta[];
  mode: 'replay' | 'snapshot';
}

export async function buildReplay(
  preview: SavePreview,
  onProgress?: (pct: number) => void,
): Promise<ReplayData> {
  const { envelope, verified } = preview;
  const stateAt = new Map<number, GameState>();
  const eventsAt = new Map<number, TurnEvent[]>();
  let last: GameState | null = null;

  if (verified.mode === 'replay' && envelope.commands.length > 0) {
    const engine = createGameEngine();
    let state: GameState | null = null;
    let pending: TurnEvent[] = [];
    for (let i = 0; i < envelope.commands.length; i++) {
      const c = envelope.commands[i]!;
      const payload = JSON.parse(c.payload) as unknown;
      const prevTurn = state?.turn ?? 0;
      state =
        c.kind === 'game_start'
          ? (engine.init(payload as never) as GameState)
          : (engine.apply(state!, { turn: c.turn, playerId: c.playerId, kind: c.kind, payload } as never) as GameState);
      pending.push(...(engine.takeEvents() as TurnEvent[]));
      if (state.turn > prevTurn || !stateAt.size) {
        // the state as each turn OPENS (post-resolution) — every apply clones,
        // so storing the reference is free and immutable
        stateAt.set(state.turn, state);
        if (pending.length) eventsAt.set(state.turn, pending);
        pending = [];
      }
      if (i % 25 === 0) {
        onProgress?.(Math.floor((i * 100) / envelope.commands.length));
        await new Promise((r) => setTimeout(r, 0)); // keep the UI breathing
      }
    }
    // the final frame matches the save exactly (incl. same-turn tail commands)
    if (state) {
      stateAt.set(state.turn, state);
      last = state;
    }
  } else {
    // snapshot-first: scrub over the embedded snapshot turns only
    const engine = createGameEngine();
    const all = [...(envelope.snapshots ?? []), ...(envelope.snapshot ? [envelope.snapshot] : [])].sort(
      (a, b) => a.turn - b.turn,
    );
    for (const snap of all) {
      const state = engine.deserialize(snap.stateJson) as GameState;
      stateAt.set(state.turn, state);
      last = state;
    }
  }
  onProgress?.(100);
  if (!last) throw new Error('this save holds no viewable state (no log and no snapshot)');

  return {
    turns: [...stateAt.keys()].sort((a, b) => a - b),
    stateAt,
    eventsAt,
    empires: last.empires.map((e) => ({ id: e.id, name: e.name, raceName: e.raceName, color: e.color })),
    mode: verified.mode,
  };
}

// ---- hand-off between the Home loader and the viewer screen ----

let current: ReplayData | null = null;

export function setCurrentReplay(d: ReplayData | null): void {
  current = d;
}

export function getCurrentReplay(): ReplayData | null {
  return current;
}
