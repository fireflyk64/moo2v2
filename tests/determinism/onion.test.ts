// OnionAI viability gate: the constraint-driven brain (onionBot.ts,
// bugs/ai_plan.md) must play full games against the v2 brain without
// stalling and develop a real empire. This is the fast regression gate the
// tournament improvement loop leans on; the score floor is deliberately
// permissive — cross-brain BALANCE is judged by the tournament's score
// tables, not here (win counts at N=2 are coin flips; see selfplay.test.ts).

import { describe, expect, it } from 'vitest';
import { MemoryHub } from '@protocol/memoryTransport';
import { createHostedGame, joinGame } from '@protocol/setup';
import { DEFAULT_SETTINGS } from '@protocol/messages';
import type { EngineAdapter } from '@protocol/engineAdapter';
import { gameEngine } from '@engine/adapter';
import type { GameState } from '@engine/types';
import { SoloBot, type BotBrain } from '@ui/soloBot';

const SEED = '0123456789abcdef0123456789abcdef';
const TURN_CAP = 110;

function identity(name: string) {
  return { name, engineVersion: '0.1.0', dataVersion: 'dv-test', roomCode: 'ONION', lobbyServer: 'memory' };
}

interface Dev {
  score: number;
  colonies: number;
  apps: number;
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
  return { score, colonies, apps: empire.knownApps.length };
}

async function match(seed: string, brain0: BotBrain, brain1: BotBrain): Promise<{ d0: Dev; d1: Dev; turn: number }> {
  const hub = new MemoryHub(2);
  const engine = gameEngine as unknown as EngineAdapter<GameState>;
  const hosted = createHostedGame<GameState>({
    transport: hub.join(),
    engine,
    store: null,
    settings: { ...DEFAULT_SETTINGS, playerCount: 2, debugCommands: false, galaxySize: 'small', startMode: 'average' },
    identity: identity('BotA'),
  });
  const clientSession = joinGame<GameState>({ transport: hub.join(), engine, store: null, identity: identity('BotB') });
  const botA = new SoloBot({ session: hosted.session, mode: 'fair', brain: brain0 });
  const botB = new SoloBot({ session: clientSession, mode: 'fair', brain: brain1 });
  botA.setAggressive(true);
  botB.setAggressive(true);
  const stop = hosted.session.subscribe((ev) => {
    if (ev.type === 'turn-advanced' && ev.turn >= TURN_CAP) {
      botA.close();
      botB.close();
    }
  });
  await hub.settle();
  hosted.host.startGame(seed);
  let lastTurn = -1;
  for (let i = 0; i < 300; i++) {
    await hub.settle();
    const st = hosted.session.getState();
    if (!st) continue;
    if (st.winner !== null || st.turn >= TURN_CAP) break;
    if (st.turn === lastTurn) break; // bots idle: stall
    lastTurn = st.turn;
  }
  stop();
  botA.close();
  botB.close();
  const final = hosted.session.getState()!;
  return { d0: dev(final, 0), d1: dev(final, 1), turn: final.turn };
}

describe('OnionAI viability', () => {
  it(
    'onion vs v2 plays full games from both seats and develops',
    async () => {
      const a = await match(SEED, 'onion', 'v2');
      const b = await match(SEED, 'v2', 'onion');
      // games ran to the cap or a victory — never a silent stall
      expect(a.turn).toBeGreaterThanOrEqual(Math.min(TURN_CAP, 100));
      expect(b.turn).toBeGreaterThanOrEqual(Math.min(TURN_CAP, 100));
      // the onion empire is alive and building something real by t110
      for (const onion of [a.d0, b.d1]) {
        expect(onion.score).toBeGreaterThan(0);
        expect(onion.colonies).toBeGreaterThanOrEqual(2);
        expect(onion.apps).toBeGreaterThanOrEqual(8);
      }
      // permissive cross-brain floor: catches a collapsed onion economy
      // without turning seed noise into flakes
      const onionTotal = a.d0.score + b.d1.score;
      const v2Total = a.d1.score + b.d0.score;
      expect(onionTotal).toBeGreaterThanOrEqual(Math.floor(v2Total * 0.5));
    },
    600_000,
  );
});
