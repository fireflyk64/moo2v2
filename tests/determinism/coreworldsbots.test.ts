// Core-worlds AI gate: in the variant, the onion/minced brains must actually
// chase the green stars — colonize designated worlds as they come into reach —
// and the new pop-logistics phase must ship colonists toward excellent worlds
// without stalling games. Permissive assertions (progress, not victory): a
// 2-bot small-map race to ALL core worlds can take hundreds of turns and win
// counts at N=1 are seed noise.

import { describe, expect, it } from 'vitest';
import { MemoryHub } from '@protocol/memoryTransport';
import { createHostedGame, joinGame } from '@protocol/setup';
import { DEFAULT_SETTINGS } from '@protocol/messages';
import type { EngineAdapter } from '@protocol/engineAdapter';
import { gameEngine } from '@engine/adapter';
import type { GameState } from '@engine/types';
import { SoloBot } from '@ui/soloBot';

const SEED = '0123456789abcdef0123456789abcdef';
const TURN_CAP = 110;

function identity(name: string) {
  return { name, engineVersion: '0.1.0', dataVersion: 'dv-test', roomCode: 'COREW', lobbyServer: 'memory' };
}

async function run(coreWorlds: 'central' | 'random'): Promise<GameState> {
  const hub = new MemoryHub(2);
  const engine = gameEngine as unknown as EngineAdapter<GameState>;
  const hosted = createHostedGame<GameState>({
    transport: hub.join(),
    engine,
    store: null,
    settings: {
      ...DEFAULT_SETTINGS,
      playerCount: 2,
      debugCommands: false,
      galaxySize: 'small',
      startMode: 'average',
      coreWorlds,
    },
    identity: identity('BotA'),
  });
  const clientSession = joinGame<GameState>({ transport: hub.join(), engine, store: null, identity: identity('BotB') });
  const botA = new SoloBot({ session: hosted.session, mode: 'fair', brain: 'onion' });
  const botB = new SoloBot({ session: clientSession, mode: 'fair', brain: 'minced' });
  const stop = hosted.session.subscribe((ev) => {
    if (ev.type === 'turn-advanced' && ev.turn >= TURN_CAP) {
      botA.close();
      botB.close();
    }
  });
  await hub.settle();
  hosted.host.startGame(SEED);
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
  return hosted.session.getState()!;
}

describe('core worlds AI pursuit', () => {
  it(
    'onion vs minced in the variant: no stall, and the bots take core worlds',
    async () => {
      const final = await run('central');
      const core = new Set(final.coreWorlds ?? []);
      expect(core.size).toBe(4);
      const held = final.colonies.filter((c) => core.has(c.planetId) && c.owner >= 0).length;
      if (final.winner !== null) {
        // a decided game before the cap is the variant working as designed
        // (this seed: onion closes all 4 core worlds by t90)
        expect(['core_worlds', 'conquest']).toContain(final.winType);
      } else {
        // no stall, and the race is visibly on by the cap
        expect(final.turn).toBeGreaterThanOrEqual(Math.min(TURN_CAP, 100));
        expect(held).toBeGreaterThanOrEqual(1);
      }
    },
    600_000,
  );
});
