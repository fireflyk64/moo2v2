// Reconciliation runner: plays the reconciliation game to its end, in the
// browser, with onion bots at every helm (alwaysWar — the goal is the goal:
// the victory stars if the base game runs the core-worlds variant, total
// domination otherwise). The scripted economy fires inside the engine
// (reconcile.ts); this driver only folds commands the way a host would —
// bot orders, advance_turn, the battle-orders sub-phase — and assembles a
// normal SaveEnvelope, so the result is savable and replayable like any game.

import { createGameEngine } from '@engine/adapter';
import { ENGINE_VERSION } from '@engine/index';
import { canonicalStringify } from '@engine/canonical';
import { validateCommand } from '@engine/commands';
import { DATA_VERSION } from '@engine/data/index';
import type { GameState } from '@engine/types';
import type { GameSession } from '@protocol/session';
import type { SaveEnvelope } from '@storage/repo';
import type { ReconcileStart } from '@storage/reconcile';
import { onionBattleOrders } from './onionBot';
import { freshReconcileMemory, reconcileBotTurn, type ReconcileTactic } from './reconcileBot';

/** safety slack past the scoring turn (the election decides AT endTurn) */
const AFTER_END_SLACK = 5;

export interface ReconcileRunResult {
  envelope: SaveEnvelope;
  finalState: GameState;
}

export async function runReconciliation(
  start: ReconcileStart,
  onProgress?: (turn: number, cap: number) => void,
  opts: { extraTurns?: number; tactics?: Record<number, ReconcileTactic> } = {},
): Promise<ReconcileRunResult> {
  const engine = createGameEngine();
  let state = engine.init(start.payload as never) as GameState;
  engine.takeEvents();

  const commands: SaveEnvelope['commands'] = [
    { seq: 0, turn: 0, playerId: -1, kind: 'game_start', payload: canonicalStringify(start.payload) },
  ];
  let seq = 1;
  const record = (turn: number, playerId: number, kind: string, payload: unknown) => {
    commands.push({ seq: seq++, turn, playerId, kind, payload: canonicalStringify(payload ?? {}) });
  };
  const applyCmd = (playerId: number, kind: string, payload: unknown): string | null => {
    const cmd = { turn: state.turn, playerId, kind, payload };
    const err = validateCommand(state, cmd);
    if (err) return err;
    state = engine.apply(state, cmd as never) as GameState;
    engine.takeEvents();
    record(cmd.turn, playerId, kind, payload);
    return null;
  };

  const memories = new Map(state.empires.map((e) => [e.id, freshReconcileMemory()]));
  const cap = start.endTurn + (opts.extraTurns ?? AFTER_END_SLACK);

  while (state.turn <= cap && state.winner === null) {
    // every living empire takes its planning turn (bots at every helm)
    for (const empire of [...state.empires].sort((a, b) => a.id - b.id)) {
      if (empire.eliminated) continue;
      const me = empire.id;
      const session = {
        submit: (kind: string, payload: unknown) => {
          const err = applyCmd(me, kind, payload);
          return err ? { error: err } : {};
        },
      } as unknown as GameSession<GameState>;
      reconcileBotTurn({
        session,
        state,
        me,
        tactic: opts.tactics?.[me] ?? 'split', // lab-measured default (bugs/reconcile-tactics.md)
        memory: memories.get(me)!,
      });
    }

    const before = state.turn;
    state = engine.apply(state, { turn: state.turn, playerId: -1, kind: 'advance_turn', payload: { fromTurn: state.turn } } as never) as GameState;
    engine.takeEvents();
    record(before, -1, 'advance_turn', { fromTurn: before });

    if (state.phase === 'battle_orders') {
      for (const battle of state.pendingBattles) {
        for (const side of [battle.attacker, battle.defender]) {
          if (side < 0) continue;
          const filled = side === battle.attacker ? battle.ordersA : battle.ordersD;
          if (filled) continue;
          const orders = onionBattleOrders(state, side, battle, 'balanced');
          applyCmd(side, 'battle_orders', { battleId: battle.id, orders });
        }
      }
      const t = state.turn;
      state = engine.apply(state, { turn: t, playerId: -1, kind: 'resolve_combat', payload: {} } as never) as GameState;
      engine.takeEvents();
      record(t, -1, 'resolve_combat', {});
    }

    onProgress?.(state.turn, cap);
    if (state.turn % 5 === 0) await new Promise((r) => setTimeout(r, 0)); // keep the UI breathing
  }

  const gameId = `g-${start.seed.slice(0, 16)}`;
  const envelope: SaveEnvelope = {
    format: 'moo2v2-save',
    version: 2,
    game: {
      game_id: gameId,
      created_at: new Date().toISOString(),
      engine_version: ENGINE_VERSION,
      data_version: DATA_VERSION,
      protocol_version: 1,
      settings_json: canonicalStringify(state.settings as unknown),
      seed: start.seed,
      local_player_id: 0,
      lobby_server: 'reconciliation',
      room_code: 'RECON',
      status: 'finished',
      last_turn: state.turn,
      last_seq: seq - 1,
    },
    players: start.players.map((p) => ({
      game_id: gameId,
      player_id: p.id,
      name: p.name,
      race_json: p.raceJson,
      is_host: p.id === 0 ? 1 : 0,
    })),
    commands,
    snapshot: {
      turn: state.turn,
      seq: seq - 1,
      stateJson: engine.serialize(state),
      stateHash: engine.hash(state),
    },
    snapshots: [],
    history: true,
  };
  return { envelope, finalState: state };
}

/** short default clocks for the LIVE reconciliation (human tactics): the
 * realtime timer keeps the finale moving; commit early to go faster */
export const LIVE_RECON_REALTIME_SECONDS = 20;
export const LIVE_RECON_AUTOTURN_SECONDS = 45;

/** Build the LIVE reconciliation kickoff: a normal save at the base turn
 * whose state carries the scripts. Load it as host and everyone joins by
 * name (or ⏳ Play async vs bot stand-ins) — humans fly the fleets, the
 * engine replays the economy, and the same end-of-scripts scoring applies. */
export function buildReconciliationKickoff(start: ReconcileStart): SaveEnvelope {
  const engine = createGameEngine();
  const resumeJson = (start.payload as { resumeState?: string }).resumeState;
  if (!resumeJson) throw new Error('reconciliation start carries no state');
  const base = engine.deserialize(resumeJson) as GameState;
  const settings = {
    ...(base.settings as unknown as Record<string, unknown>),
    realtimeTurnSeconds: LIVE_RECON_REALTIME_SECONDS,
    autoTurnSeconds: LIVE_RECON_AUTOTURN_SECONDS,
  };
  const state: GameState = { ...base, settings: settings as unknown as GameState['settings'] };
  const startPayload = {
    ...(start.payload as Record<string, unknown>),
    settings,
    resumeState: engine.serialize(state),
  };
  const checked = engine.init(startPayload as never) as GameState; // sanity: it loads
  engine.takeEvents();
  const gameId = `g-${start.seed.slice(0, 16)}`;
  const envelope: SaveEnvelope = {
    format: 'moo2v2-save',
    version: 2,
    game: {
      game_id: gameId,
      created_at: new Date().toISOString(),
      engine_version: ENGINE_VERSION,
      data_version: DATA_VERSION,
      protocol_version: 1,
      settings_json: canonicalStringify(settings),
      seed: start.seed,
      local_player_id: 0,
      lobby_server: 'reconciliation-live',
      room_code: 'RECONL',
      status: 'active',
      last_turn: checked.turn,
      last_seq: 0,
    },
    players: start.players.map((p) => ({
      game_id: gameId,
      player_id: p.id,
      name: p.name,
      race_json: p.raceJson,
      is_host: p.id === 0 ? 1 : 0,
    })),
    commands: [{ seq: 0, turn: 0, playerId: -1, kind: 'game_start', payload: canonicalStringify(startPayload) }],
    snapshot: {
      turn: checked.turn,
      seq: 0,
      stateJson: engine.serialize(checked),
      stateHash: engine.hash(checked),
    },
    snapshots: [],
    history: true,
  };
  return envelope;
}
