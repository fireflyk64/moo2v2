// Reconciliation field experiment (complextask.md): four onion bots play the
// SAME shared base solo — each with a different personality on its own seat,
// balanced stand-ins on the rest, exactly the async flow — then the four
// saves reconcile. Question: does the player with the strongest OWN game win
// the merged timeline? Findings land in bugs/reconcile-experiment.md.
//
// Opt-in like the other balance harnesses:
//   MOO2_BALANCE=1 MOO2_RECONX=1 npx vitest run tests/balance/reconcile-experiment.test.ts
// Knobs: RECONX_SEED, RECONX_BASE_TURNS (12), RECONX_ASYNC_TURNS (110), RECONX_GALAXY (medium)

import { writeFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { ENGINE_VERSION, gameEngine } from '@engine/index';
import { DATA_VERSION } from '@engine/data/index';
import type { GameState } from '@engine/types';
import type { EngineCommand } from '@engine/commands';
import type { GameSession } from '@protocol/session';
import { buildReconciliationStart } from '@storage/reconcile';
import type { SaveEnvelope } from '@storage/savefile';
import { runReconciliation } from '@ui/reconcileRun';
import { freshOnionMemory, onionBattleOrders, onionTurn, type OnionMemory } from '@ui/onionBot';
import type { BotPersonality } from '@ui/soloBot';

const RUN = process.env.MOO2_RECONX === '1';
const SEED = process.env.RECONX_SEED ?? 'fedcba9876543210fedcba9876543210';
const BASE_TURNS = Number(process.env.RECONX_BASE_TURNS ?? 12);
const ASYNC_TURNS = Number(process.env.RECONX_ASYNC_TURNS ?? 110);
const GALAXY = (process.env.RECONX_GALAXY ?? 'medium') as 'small' | 'medium';

const PERSONALITIES: BotPersonality[] = ['expander', 'techer', 'militarist', 'industrialist'];
const PLAYERS = PERSONALITIES.map((p, i) => ({
  id: i,
  name: `${p[0]!.toUpperCase()}${p.slice(1)}`,
  raceJson: JSON.stringify({ presetId: 'solari' }),
}));

type Cmd = { seq: number; turn: number; playerId: number; kind: string; payload: string };

/** the same host fold reconcileRun performs, but for the NORMAL rules — one
 * onion at every seat, personalities per seat */
function playTurns(
  startLog: Cmd[],
  turns: number,
  personalityOf: (seat: number) => BotPersonality,
  memories: Map<number, OnionMemory>,
  aggressiveSeat: number | null = null,
): Cmd[] {
  let state: GameState | null = null;
  for (const c of startLog) {
    const payload = JSON.parse(c.payload) as unknown;
    state = c.kind === 'game_start' ? gameEngine.init(payload as never) : gameEngine.apply(state!, { turn: c.turn, playerId: c.playerId, kind: c.kind, payload } as never);
    gameEngine.takeEvents();
  }
  const log = [...startLog];
  let seq = log.length;
  const applyCmd = (playerId: number, kind: string, payload: unknown): boolean => {
    const cmd: EngineCommand = { turn: state!.turn, playerId, kind, payload };
    try {
      state = gameEngine.apply(state!, cmd);
    } catch {
      return false;
    }
    gameEngine.takeEvents();
    log.push({ seq: seq++, turn: cmd.turn, playerId, kind, payload: JSON.stringify(payload ?? {}) });
    return true;
  };
  for (let t = 0; t < turns && state!.winner === null; t++) {
    for (const empire of [...state!.empires].sort((a, b) => a.id - b.id)) {
      if (empire.eliminated) continue;
      const me = empire.id;
      const session = {
        submit: (kind: string, payload: unknown) => (applyCmd(me, kind, payload) ? {} : { error: 'rejected' }),
      } as unknown as GameSession<GameState>;
      onionTurn({
        session,
        state: state!,
        planned: state!,
        me,
        personality: personalityOf(me),
        // the async "human" plays to WIN against the stand-ins
        alwaysWar: me === aggressiveSeat,
        memory: memories.get(me)!,
      });
    }
    applyCmd(-1, 'advance_turn', { fromTurn: state!.turn });
    if (state!.phase === 'battle_orders') {
      for (const battle of state!.pendingBattles) {
        for (const side of [battle.attacker, battle.defender]) {
          if (side < 0) continue;
          const filled = side === battle.attacker ? battle.ordersA : battle.ordersD;
          if (filled) continue;
          const orders = onionBattleOrders(state!, side, battle, personalityOf(side));
          applyCmd(side, 'battle_orders', { battleId: battle.id, orders });
        }
      }
      applyCmd(-1, 'resolve_combat', {});
    }
  }
  return log;
}

function foldLog(log: Cmd[]): GameState {
  let state: GameState | null = null;
  for (const c of log) {
    const payload = JSON.parse(c.payload) as unknown;
    state = c.kind === 'game_start' ? gameEngine.init(payload as never) : gameEngine.apply(state!, { turn: c.turn, playerId: c.playerId, kind: c.kind, payload } as never);
    gameEngine.takeEvents();
  }
  return state!;
}

interface Dev {
  score: number;
  colonies: number;
  pop: number;
  apps: number;
  warships: number;
  eliminated: boolean;
}

function dev(state: GameState, id: number): Dev {
  const empire = state.empires.find((e) => e.id === id)!;
  const colonies = state.colonies.filter((c) => c.owner === id && !c.outpost).length;
  const pop = state.colonies
    .filter((c) => c.owner === id)
    .reduce((n, c) => n + c.groups.reduce((m, g) => m + Math.floor(g.popK / 1000), 0), 0);
  const warships = state.ships.filter((s) => s.owner === id && s.shipKind === 'design').length;
  const score = empire.eliminated
    ? -1000
    : colonies * 20 + pop * 3 + empire.knownApps.length + warships * 5 + Math.floor(empire.bc / 50);
  return { score, colonies, pop, apps: empire.knownApps.length, warships, eliminated: empire.eliminated };
}

function envelopeOf(log: Cmd[], seat: number, state: GameState): SaveEnvelope {
  const gameId = `g-reconx-${seat}`;
  return {
    format: 'moo2v2-save',
    version: 2,
    game: {
      game_id: gameId,
      created_at: 't',
      engine_version: ENGINE_VERSION,
      data_version: DATA_VERSION,
      protocol_version: 1,
      settings_json: JSON.stringify(state.settings),
      seed: SEED,
      local_player_id: seat,
      lobby_server: 'x',
      room_code: 'RECONX',
      status: 'active',
      last_turn: state.turn,
      last_seq: log.length - 1,
    },
    players: PLAYERS.map((p) => ({ game_id: gameId, player_id: p.id, name: p.name, race_json: p.raceJson, is_host: p.id === 0 ? 1 : 0 })),
    commands: log,
    snapshot: { turn: state.turn, seq: log.length - 1, stateJson: gameEngine.serialize(state), stateHash: gameEngine.hash(state) },
    snapshots: [],
    history: true,
  };
}

(RUN ? describe : describe.skip)('reconciliation field experiment', () => {
  it(
    'four personalities async, one reconciliation — did the best game win?',
    async () => {
      // shared base: everyone balanced (the pre-fork lobby state)
      const gameStart: Cmd = {
        seq: 0,
        turn: 0,
        playerId: -1,
        kind: 'game_start',
        payload: JSON.stringify({
          seed: SEED,
          settings: {
            galaxySize: GALAXY,
            startMode: 'average',
            playerCount: PLAYERS.length,
            modes: { creativeVariant: false, pickBidding: false, stickyBuild: false, antarans: false, randomEvents: false },
            battleOrdersTimeoutMs: 1000,
            debugCommands: false,
          },
          players: PLAYERS,
          dataVersion: DATA_VERSION,
        }),
      };
      const baseMem = new Map(PLAYERS.map((p) => [p.id, freshOnionMemory()]));
      const baseLog = playTurns([gameStart], BASE_TURNS, () => 'balanced', baseMem);

      // each player continues the SAME base solo with their OWN personality
      const results = PLAYERS.map((p) => {
        const memories = new Map(PLAYERS.map((q) => [q.id, freshOnionMemory()]));
        const log = playTurns(baseLog, ASYNC_TURNS, (seat) => (seat === p.id ? PERSONALITIES[p.id]! : 'balanced'), memories, p.id);
        const final = foldLog(log);
        return { seat: p.id, name: p.name, log, final, own: dev(final, p.id) };
      });

      // reconcile all four
      const start = buildReconciliationStart(results.map((r) => ({ envelope: envelopeOf(r.log, r.seat, r.final), seat: r.seat })));
      const { finalState } = await runReconciliation(start);
      expect(finalState.winner).not.toBeNull();
      const schedules = (JSON.parse(start.payload['resumeState'] as string) as GameState).reconcile!.schedules;
      const wars = finalState.relations.filter((r) => r.status === 'war').length;

      const bestOwn = [...results].sort((a, b) => b.own.score - a.own.score)[0]!;
      const winner = finalState.winner!;
      const reconDev = PLAYERS.map((p) => ({ name: p.name, seat: p.id, ...dev(finalState, p.id) }));

      const lines: string[] = [];
      lines.push('# Reconciliation field experiment');
      lines.push('');
      lines.push(`Seed \`${SEED}\`, ${GALAXY} galaxy, base ${BASE_TURNS} turns (all balanced), async +${ASYNC_TURNS} turns each`);
      lines.push(`(own seat plays its personality AGGRESSIVELY — the human analog; stand-ins balanced/passive), engine ${ENGINE_VERSION}.`);
      lines.push('');
      lines.push('## Own async games (how well each player did at home)');
      lines.push('');
      lines.push('| player | own score | colonies | pop | apps | warships |');
      lines.push('|---|---|---|---|---|---|');
      for (const r of [...results].sort((a, b) => b.own.score - a.own.score)) {
        lines.push(`| ${r.name} (seat ${r.seat}) | ${r.own.score} | ${r.own.colonies} | ${r.own.pop} | ${r.own.apps} | ${r.own.warships} |`);
      }
      lines.push('');
      lines.push('## Recorded scripts (what each save contributed)');
      lines.push('');
      lines.push('| player | ships | colonize | pop entries | buildings | research |');
      lines.push('|---|---|---|---|---|---|');
      for (const sc of schedules) {
        lines.push(`| ${PLAYERS[sc.empireId]?.name} | ${sc.ships.length} | ${sc.colonize.length} | ${sc.pop.length} | ${sc.buildings.length} | ${sc.research.length} |`);
      }
      lines.push('');
      lines.push('## Reconciliation outcome');
      lines.push('');
      lines.push(`Ended turn ${finalState.turn} — winner: **${PLAYERS[winner]?.name ?? winner}** (${finalState.winType}); ${wars} war relation(s) standing at the end.`);
      lines.push('');
      lines.push('| player | recon score | colonies | pop | apps | warships | eliminated |');
      lines.push('|---|---|---|---|---|---|---|');
      for (const d of [...reconDev].sort((a, b) => b.score - a.score)) {
        lines.push(`| ${d.name} | ${d.score} | ${d.colonies} | ${d.pop} | ${d.apps} | ${d.warships} | ${d.eliminated ? 'yes' : ''} |`);
      }
      lines.push('');
      lines.push('## Verdict');
      lines.push('');
      lines.push(
        bestOwn.seat === winner
          ? `✅ The strongest own game (${bestOwn.name}) also won the reconciliation — the recorded engine carried.`
          : `❌ The strongest own game was ${bestOwn.name} (score ${bestOwn.own.score}) but ${PLAYERS[winner]?.name} won the reconciliation.`,
      );
      lines.push('');
      // NOTE: a rerun OVERWRITES the generated tables; the hand-written
      // "What happened" analysis in bugs/reconcile-experiment.md is appended
      // after runs — re-append it if you regenerate.
      writeFileSync('bugs/reconcile-experiment.md', lines.join('\n'));
      // eslint-disable-next-line no-console
      console.log(lines.join('\n'));
    },
    1_800_000,
  );
});
