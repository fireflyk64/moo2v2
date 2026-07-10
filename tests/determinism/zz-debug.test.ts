import { MemoryHub } from '@protocol/memoryTransport';
import { createHostedGame, joinGame } from '@protocol/setup';
import { DEFAULT_SETTINGS } from '@protocol/messages';
import type { EngineAdapter } from '@protocol/engineAdapter';
import { gameEngine } from '@engine/adapter';
import type { GameState } from '@engine/types';
import { SoloBot, type BotBrain } from '@ui/soloBot';

import { it } from 'vitest';

it('debug self-play', async () => {
const SEEDS = [
  '0123456789abcdef0123456789abcdef',
  'deadbeefdeadbeefdeadbeefdeadbeef',
  'cafef00dcafef00dcafef00dcafef00d',
];
const TURN_CAP = 110;

const identity = (name: string) => ({ name, engineVersion: '0.1.0', dataVersion: 'dv-test', roomCode: 'AIVAI', lobbyServer: 'memory' });

function stats(state: GameState, id: number) {
  const empire = state.empires.find((e) => e.id === id)!;
  const colonies = state.colonies.filter((c) => c.owner === id && !c.outpost).length;
  const pop = state.colonies.filter((c) => c.owner === id).reduce((n, c) => n + c.groups.reduce((m, g) => m + Math.floor(g.popK / 1000), 0), 0);
  const warships = state.ships.filter((s) => s.owner === id && s.shipKind === 'design').length;
  const score = empire.eliminated ? -1000 : colonies * 20 + pop * 3 + empire.knownApps.length + warships * 5 + Math.floor(empire.bc / 50);
  return { colonies, pop, apps: empire.knownApps.length, warships, bc: empire.bc, elim: empire.eliminated, score };
}

async function match(seed: string, brain0: BotBrain, brain1: BotBrain) {
  const hub = new MemoryHub(2);
  const engine = gameEngine as unknown as EngineAdapter<GameState>;
  const hosted = createHostedGame<GameState>({
    transport: hub.join(), engine, store: null,
    settings: { ...DEFAULT_SETTINGS, playerCount: 2, debugCommands: false, galaxySize: 'small', startMode: 'average' },
    identity: identity('BotA'),
  });
  const clientSession = joinGame<GameState>({ transport: hub.join(), engine, store: null, identity: identity('BotB') });
  const botA = new SoloBot({ session: hosted.session, mode: 'fair', brain: brain0 });
  const botB = new SoloBot({ session: clientSession, mode: 'fair', brain: brain1 });
  botA.setAggressive(true);
  botB.setAggressive(true);
  const stop = hosted.session.subscribe((ev) => {
    if (ev.type === 'turn-advanced' && ev.turn >= TURN_CAP) { botA.close(); botB.close(); }
  });
  await hub.settle();
  hosted.host.startGame(seed);
  let lastTurn = -1;
  for (let i = 0; i < 300; i++) {
    await hub.settle();
    const st = hosted.session.getState();
    if (!st) continue;
    if (st.winner !== null || st.turn >= TURN_CAP) break;
    if (st.turn === lastTurn) break;
    lastTurn = st.turn;
  }
  stop(); botA.close(); botB.close();
  const final = hosted.session.getState()!;
  return { turn: final.turn, s0: stats(final, 0), s1: stats(final, 1) };
}

for (const seed of SEEDS) {
  for (const [b0, b1] of [['v2', 'v1'], ['v1', 'v2']] as const) {
    const r = await match(seed, b0, b1);
    console.log(`${seed.slice(0, 6)} ${b0}(0) vs ${b1}(1) turn=${r.turn}`);
    console.log(`   seat0 ${b0}:`, JSON.stringify(r.s0));
    console.log(`   seat1 ${b1}:`, JSON.stringify(r.s1));
  }
}

}, 600_000);
