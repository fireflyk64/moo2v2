// End-to-end reconciliation: a shared base game, two independent async
// continuations, harvest, the bot-driven reconciliation run — and the
// resulting save must pass full deterministic replay verification (the
// "compatible with replay mode" requirement is literal: verifySaveEnvelope
// refolds the whole log and hash-checks the final snapshot).

import { describe, expect, it } from 'vitest';
import { ENGINE_VERSION, gameEngine } from '@engine/index';
import { DATA_VERSION } from '@engine/data/index';
import type { GameState } from '@engine/types';
import type { EngineCommand } from '@engine/commands';
import { verifySaveEnvelope, type SaveEnvelope } from '@storage/savefile';
import { buildReconciliationStart, commonPrefixLength, harvestSchedule } from '@storage/reconcile';
import { runReconciliation } from '@ui/reconcileRun';
import { buildReplay } from '@ui/replay';
import { expanderBot, runHeadlessGame, type BotPolicy } from '../../src/headless/bots';

const SEED = 'fedcba9876543210fedcba9876543210';
const PLAYERS = [
  { id: 0, name: 'Alice', raceJson: JSON.stringify({ presetId: 'cerebri' }) },
  { id: 1, name: 'Bob', raceJson: JSON.stringify({ presetId: 'hivex' }) },
];

/** continue a base log for more turns with bots on every seat, exactly the
 * async single-player flow (the local player + stand-in bots) */
function continueGame(
  baseLog: Array<{ seq: number; turn: number; playerId: number; kind: string; payload: string }>,
  turns: number,
  policies: Record<number, BotPolicy>,
): Array<{ seq: number; turn: number; playerId: number; kind: string; payload: string }> {
  let state: GameState | null = null;
  for (const c of baseLog) {
    const payload = JSON.parse(c.payload) as unknown;
    state = c.kind === 'game_start' ? gameEngine.init(payload as never) : gameEngine.apply(state!, { turn: c.turn, playerId: c.playerId, kind: c.kind, payload } as never);
    gameEngine.takeEvents();
  }
  const log = [...baseLog];
  let seq = baseLog.length;
  const push = (cmd: EngineCommand) => log.push({ seq: seq++, turn: cmd.turn, playerId: cmd.playerId, kind: cmd.kind, payload: JSON.stringify(cmd.payload ?? {}) });
  for (let t = 0; t < turns; t++) {
    for (const [idStr, policy] of Object.entries(policies)) {
      const id = Number(idStr);
      for (const d of policy(state!, id)) {
        const cmd: EngineCommand = { turn: state!.turn, playerId: id, kind: d.kind, payload: d.payload };
        try {
          const next = gameEngine.apply(state!, cmd);
          state = next;
          push(cmd);
        } catch {
          // invalid orders are skipped like host rejects
        }
      }
    }
    const adv: EngineCommand = { turn: state!.turn, playerId: -1, kind: 'advance_turn', payload: {} };
    state = gameEngine.apply(state!, adv);
    gameEngine.takeEvents();
    push(adv);
    if (state.phase === 'battle_orders') {
      for (const battle of state.pendingBattles) {
        for (const side of [battle.attacker, battle.defender]) {
          if (side < 0) continue;
          const filled = side === battle.attacker ? battle.ordersA : battle.ordersD;
          if (filled) continue;
          const cmd: EngineCommand = {
            turn: state.turn,
            playerId: side,
            kind: 'battle_orders',
            payload: { battleId: battle.id, orders: { stance: 'charge', priority: 'nearest', retreatThresholdPct: 25, bombard: false, invade: false } },
          };
          state = gameEngine.apply(state, cmd);
          push(cmd);
        }
      }
      const resolve: EngineCommand = { turn: state.turn, playerId: -1, kind: 'resolve_combat', payload: {} };
      state = gameEngine.apply(state, resolve);
      gameEngine.takeEvents();
      push(resolve);
    }
  }
  return log;
}

function envelopeOf(
  log: Array<{ seq: number; turn: number; playerId: number; kind: string; payload: string }>,
  seat: number,
): SaveEnvelope {
  let state: GameState | null = null;
  for (const c of log) {
    const payload = JSON.parse(c.payload) as unknown;
    state = c.kind === 'game_start' ? gameEngine.init(payload as never) : gameEngine.apply(state!, { turn: c.turn, playerId: c.playerId, kind: c.kind, payload } as never);
    gameEngine.takeEvents();
  }
  const gameId = `g-async-${seat}`;
  return {
    format: 'moo2v2-save',
    version: 2,
    game: {
      game_id: gameId,
      created_at: 't',
      engine_version: ENGINE_VERSION,
      data_version: DATA_VERSION,
      protocol_version: 1,
      settings_json: JSON.stringify(state!.settings),
      seed: SEED,
      local_player_id: seat,
      lobby_server: 'x',
      room_code: 'ASY',
      status: 'active',
      last_turn: state!.turn,
      last_seq: log.length - 1,
    },
    players: PLAYERS.map((p) => ({ game_id: gameId, player_id: p.id, name: p.name, race_json: p.raceJson, is_host: p.id === 0 ? 1 : 0 })),
    commands: log,
    snapshot: { turn: state!.turn, seq: log.length - 1, stateJson: gameEngine.serialize(state!), stateHash: gameEngine.hash(state!) },
    snapshots: [],
    history: true,
  };
}

describe('reconciliation end to end', () => {
  it(
    'two async continuations reconcile into a bot-fought, replay-verified save',
    async () => {
      // shared base: 8 turns of the standard headless fold
      const base = runHeadlessGame({
        seed: SEED,
        players: PLAYERS.map((p) => ({ ...p, policy: expanderBot })),
        turns: 8,
      });
      const gameStart = {
        seq: 0,
        turn: 0,
        playerId: -1,
        kind: 'game_start',
        payload: JSON.stringify({
          seed: SEED,
          settings: base.state.settings,
          players: PLAYERS,
          dataVersion: DATA_VERSION,
        }),
      };
      const baseLog = [gameStart, ...base.log.map((c, i) => ({ seq: i + 1, turn: c.turn, playerId: c.playerId, kind: c.kind, payload: JSON.stringify(c.payload ?? {}) }))];

      // each player continues the SAME save independently for 10 more turns
      // (the stand-in bot for the other seat idles so the two logs diverge —
      // deterministic identical bots would produce byte-identical files)
      const idle: BotPolicy = () => [];
      const contA = continueGame(baseLog, 10, { 0: expanderBot, 1: idle });
      const contB = continueGame(baseLog, 10, { 0: idle, 1: expanderBot });
      const envA = envelopeOf(contA, 0);
      const envB = envelopeOf(contB, 1);

      // the base is exactly the shared prefix
      const prefix = commonPrefixLength([envA, envB]);
      expect(prefix).toBeGreaterThanOrEqual(baseLog.length);

      // schedules exist and are seat-scoped
      const schedA = harvestSchedule(envA, 0, prefix);
      expect(schedA.empireId).toBe(0);
      const scheduled =
        schedA.research.length + schedA.ships.length + schedA.colonize.length + schedA.pop.length + schedA.buildings.length;
      expect(scheduled).toBeGreaterThan(0);

      // run the reconciliation with bots at every helm
      const start = buildReconciliationStart([
        { envelope: envA, seat: 0 },
        { envelope: envB, seat: 1 },
      ]);
      const { envelope, finalState } = await runReconciliation(start, undefined, { extraTurns: 10 });
      expect(finalState.turn).toBeGreaterThan(start.baseTurn);
      expect(finalState.reconcile).toBeDefined();
      // the saves ran out of turns: scored — somebody won (election at worst)
      expect(finalState.winner).not.toBeNull();

      // the reconciliation save is a REAL save: full deterministic replay
      // verification (refolds the log, hash-checks the snapshot)
      const verified = verifySaveEnvelope(envelope);
      expect(verified.mode).toBe('replay');
      expect(verified.turn).toBe(finalState.turn);

      // and the cinematic view is just replay mode on the result
      const replay = await buildReplay({ envelope, verified, players: PLAYERS.map((p) => p.name), resumeTurns: [] });
      expect(replay.turns[0]).toBe(start.baseTurn);
      expect(replay.turns[replay.turns.length - 1]).toBe(finalState.turn);

      // determinism + ORDER INDEPENDENCE: whoever runs it, however the files
      // are presented, the reconciliation is the identical game
      const again = buildReconciliationStart([
        { envelope: envB, seat: 1 },
        { envelope: envA, seat: 0 },
      ]);
      expect(again.seed).toBe(start.seed);
      expect(again.payload['resumeState']).toEqual(start.payload['resumeState']);
      const rerun = await runReconciliation(again, undefined, { extraTurns: 10 });
      expect(gameEngine.hash(rerun.finalState)).toBe(gameEngine.hash(finalState));

      // a missing save file: that empire joins as a plain CPU with a warning
      const partial = buildReconciliationStart([{ envelope: envA, seat: 0 }]);
      expect(partial.warnings.some((w) => w.includes('Bob'))).toBe(true);
    },
    600_000,
  );
});
