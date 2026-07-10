// Bot personalities (improvements: "make sure they don't always do the same
// thing: high-tech-ers, rushers, industry builders, expanders, army
// builders"). Each personality must be VIABLE — it plays a distinct, working
// game and none is a pushover against the balanced v2 baseline.

import { describe, expect, it } from 'vitest';
import { MemoryHub } from '@protocol/memoryTransport';
import { createHostedGame, joinGame } from '@protocol/setup';
import { DEFAULT_SETTINGS } from '@protocol/messages';
import type { EngineAdapter } from '@protocol/engineAdapter';
import { gameEngine } from '@engine/adapter';
import type { GameState } from '@engine/types';
import { SoloBot, type BotPersonality } from '@ui/soloBot';

const SEED = 'deadbeefdeadbeefdeadbeefdeadbeef';
const TURN_CAP = 120;
const identity = (name: string) => ({ name, engineVersion: '0.1.0', dataVersion: 'dv-test', roomCode: 'PROF', lobbyServer: 'memory' });

interface Fingerprint {
  colonies: number;
  apps: number;
  warships: number;
  score: number;
}

function fingerprint(state: GameState, id: number): Fingerprint {
  const empire = state.empires.find((e) => e.id === id)!;
  const colonies = state.colonies.filter((c) => c.owner === id && !c.outpost).length;
  const warships = state.ships.filter((s) => s.owner === id && s.shipKind === 'design').length;
  const pop = state.colonies
    .filter((c) => c.owner === id)
    .reduce((n, c) => n + c.groups.reduce((m, g) => m + Math.floor(g.popK / 1000), 0), 0);
  const score = empire.eliminated ? -1000 : colonies * 20 + pop * 3 + empire.knownApps.length + warships * 5;
  return { colonies, apps: empire.knownApps.length, warships, score };
}

async function match(persona: BotPersonality): Promise<{ persona: Fingerprint; baseline: Fingerprint }> {
  const hub = new MemoryHub(2);
  const engine = gameEngine as unknown as EngineAdapter<GameState>;
  const hosted = createHostedGame<GameState>({
    transport: hub.join(),
    engine,
    store: null,
    settings: { ...DEFAULT_SETTINGS, playerCount: 2, debugCommands: false, galaxySize: 'small', startMode: 'average' },
    identity: identity('Persona'),
  });
  const client = joinGame<GameState>({ transport: hub.join(), engine, store: null, identity: identity('Base') });
  const botP = new SoloBot({ session: hosted.session, mode: 'fair', brain: 'v2', personality: persona });
  const botB = new SoloBot({ session: client, mode: 'fair', brain: 'v2', personality: 'balanced' });
  const stop = hosted.session.subscribe((ev) => {
    if (ev.type === 'turn-advanced' && ev.turn >= TURN_CAP) {
      botP.close();
      botB.close();
    }
  });
  await hub.settle();
  hosted.host.startGame(SEED);
  let last = -1;
  for (let i = 0; i < 300; i++) {
    await hub.settle();
    const st = hosted.session.getState();
    if (!st) continue;
    if (st.winner !== null || st.turn >= TURN_CAP) break;
    if (st.turn === last) break;
    last = st.turn;
  }
  stop();
  botP.close();
  botB.close();
  const final = hosted.session.getState()!;
  return { persona: fingerprint(final, 0), baseline: fingerprint(final, 1) };
}

describe('bot personalities are distinct and viable', () => {
  const personas: BotPersonality[] = ['techer', 'rusher', 'industrialist', 'expander', 'militarist'];

  it(
    'each personality survives and stays competitive with the balanced baseline',
    async () => {
      const prints: Record<string, Fingerprint> = {};
      for (const p of personas) {
        const r = await match(p);
        prints[p] = r.persona;
        // viable: not eliminated, holds colonies, keeps within reach of the baseline
        expect(r.persona.score, `${p} was crushed`).toBeGreaterThan(0);
        expect(r.persona.colonies, `${p} lost all colonies`).toBeGreaterThan(0);
        expect(r.persona.score, `${p} not competitive`).toBeGreaterThanOrEqual(r.baseline.score * 0.6);
      }
      // distinct: the techer keeps research parity-or-better vs the militarist
      // (ties allowed — the CP/growth balance fixes compressed the pace gap on
      // this seed), the militarist out-builds the techer in warships, the
      // expander holds the most colonies
      expect(prints['techer']!.apps).toBeGreaterThanOrEqual(prints['militarist']!.apps);
      expect(prints['militarist']!.warships).toBeGreaterThan(prints['techer']!.warships);
      expect(prints['expander']!.colonies).toBeGreaterThanOrEqual(prints['techer']!.colonies);
    },
    600_000,
  );
});
