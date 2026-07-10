// TEMP diagnostic (deleted before commit): per-seed selfplay scores
import { describe, expect, it } from 'vitest';
import { MemoryHub } from '@protocol/memoryTransport';
import { createHostedGame, joinGame } from '@protocol/setup';
import { DEFAULT_SETTINGS } from '@protocol/messages';
import type { EngineAdapter } from '@protocol/engineAdapter';
import { gameEngine } from '@engine/adapter';
import type { GameState } from '@engine/types';
import { SoloBot, type BotBrain } from '@ui/soloBot';

const SEEDS = [
  '0123456789abcdef0123456789abcdef',
  'deadbeefdeadbeefdeadbeefdeadbeef',
  'cafef00dcafef00dcafef00dcafef00d',
  '11111111222222223333333344444444',
  'aaaaaaaabbbbbbbbccccccccdddddddd',
  '0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f',
  '99998888777766665555444433332222',
  'fedcba9876543210fedcba9876543210',
  '5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a',
] as const;
const TURN_CAP = 110;
function identity(name: string) {
  return { name, engineVersion: '0.1.0', dataVersion: 'dv-test', roomCode: 'AIVAI', lobbyServer: 'memory' };
}
function score(state: GameState, id: number): number {
  const empire = state.empires.find((e) => e.id === id)!;
  if (empire.eliminated) return -1000;
  const colonies = state.colonies.filter((c) => c.owner === id && !c.outpost).length;
  const pop = state.colonies.filter((c) => c.owner === id).reduce((n, c) => n + c.groups.reduce((m, g) => m + Math.floor(g.popK / 1000), 0), 0);
  const warships = state.ships.filter((s) => s.owner === id && s.shipKind === 'design').length;
  return colonies * 20 + pop * 3 + empire.knownApps.length + warships * 5 + Math.floor(empire.bc / 50);
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
  botA.setAggressive(true); botB.setAggressive(true);
  const stop = hosted.session.subscribe((ev) => { if (ev.type === 'turn-advanced' && ev.turn >= TURN_CAP) { botA.close(); botB.close(); } });
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
  const e0 = final.empires[0]!, e1 = final.empires[1]!;
  return { s0: score(final, 0), s1: score(final, 1), turn: final.turn,
    r0: e0.research.fieldNum, r1: e1.research.fieldNum, apps0: e0.knownApps.length, apps1: e1.knownApps.length,
    bc0: e0.bc, bc1: e1.bc };
}
describe('diag', () => {
  it('per-seed scores', async () => {
    for (const seed of SEEDS) {
      const a = await match(seed, 'v2', 'v1');
      console.log(seed.slice(0, 8), 'v2@0:', JSON.stringify(a), a.s0 > a.s1 ? 'v2 WIN' : 'v2 LOSS');
      const b = await match(seed, 'v1', 'v2');
      console.log(seed.slice(0, 8), 'v2@1:', JSON.stringify(b), b.s1 > b.s0 ? 'v2 WIN' : 'v2 LOSS');
    }
    expect(true).toBe(true);
  }, 600_000);
});
