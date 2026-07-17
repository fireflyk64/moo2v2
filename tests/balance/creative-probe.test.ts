// TEMPORARY diagnostic probe (round 10 analysis): replay the creatives@10 vs
// solari arch match and log the creative seat's warship pipeline per turn —
// verifying whether it queues warships that die on spawn (camped shipyards)
// or never queues them at all. Run:
//   MOO2_PROBE=1 npx vitest run tests/balance/creative-probe.test.ts
import { appendFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'vitest';
import { MemoryHub } from '@protocol/memoryTransport';
import { createHostedGame, joinGame } from '@protocol/setup';
import { DEFAULT_SETTINGS } from '@protocol/messages';
import type { EngineAdapter } from '@protocol/engineAdapter';
import { gameEngine } from '@engine/adapter';
import type { GameState } from '@engine/types';
import { SoloBot } from '@ui/soloBot';

const enabled = process.env['MOO2_PROBE'] === '1';
const SOLO_SEED = '393fb1637b94ab1c3bab42a890abd11f';
const OUT = join(__dirname, '../../bugs/tournament/creative-probe.log');

const identity = (name: string) => ({
  name,
  engineVersion: '0.1.0',
  dataVersion: 'dv-test',
  roomCode: 'PROBE',
  lobbyServer: 'memory',
});

describe.runIf(enabled)('creative probe', () => {
  it(
    'logs the creative warship pipeline',
    async () => {
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
          galaxySize: 'medium',
          startMode: 'pre_warp',
          pickPoints: 10,
        },
        identity: identity('A'),
      });
      const client = joinGame<GameState>({ transport: hub.join(), engine, store: null, identity: identity('B') });
      const botA = new SoloBot({ session: hosted.session, mode: 'fair', brain: 'v2', personality: 'balanced', race: 'creatives' });
      const botB = new SoloBot({ session: client, mode: 'fair', brain: 'v2', personality: 'balanced', race: 'solari' });
      botA.setAggressive(true);
      botB.setAggressive(true);

      writeFileSync(OUT, '');
      let builtA = 0;
      let prevIds = new Set<number>();
      const stop = hosted.session.subscribe((ev) => {
        if (ev.type !== 'turn-advanced') return;
        const st = hosted.session.getState();
        if (!st) return;
        const me = 0;
        const ships = st.ships.filter((s) => s.owner === me && s.shipKind === 'design');
        const ids = new Set(ships.map((s) => s.id));
        const born = [...ids].filter((id) => !prevIds.has(id)).length;
        const died = [...prevIds].filter((id) => !ids.has(id)).length;
        builtA += born;
        prevIds = ids;
        const queued = st.colonies.reduce(
          (n, c) => n + (c.owner === me ? c.queue.filter((q) => q.item.startsWith('design:')).length : 0),
          0,
        );
        const empire = st.empires.find((e) => e.id === me)!;
        const designs = empire.designs.filter((d) => !d.obsolete).length;
        // enemy warships sitting at MY colony stars (camping)
        const myStars = new Set(
          st.colonies.filter((c) => c.owner === me).map((c) => st.planets.find((p) => p.id === c.planetId)?.starId),
        );
        const campers = st.ships.filter(
          (s) => s.owner === 1 && s.shipKind === 'design' && s.location.kind === 'star' && myStars.has(s.location.starId),
        ).length;
        const war = st.relations.find((r) => r.a === 0 && r.b === 1)?.status ?? 'none';
        if (born || died || ev.turn % 20 === 0) {
          appendFileSync(
            OUT,
            `t${ev.turn} war=${war} fleet=${ships.length} born=${born} died=${died} builtTotal=${builtA} queued=${queued} designs=${designs} bc=${empire.bc} campers=${campers} colonies=${st.colonies.filter((c) => c.owner === me && !c.outpost).length}\n`,
          );
        }
        if (ev.turn >= 600) {
          botA.close();
          botB.close();
        }
      });

      await hub.settle();
      hosted.host.startGame(SOLO_SEED);
      let last = -1;
      for (let i = 0; i < 600 * 4; i++) {
        await hub.settle();
        const st = hosted.session.getState();
        if (!st) continue;
        if (st.winner !== null || st.turn >= 600) break;
        if (st.turn === last) break;
        last = st.turn;
      }
      stop();
      botA.close();
      botB.close();
    },
    60 * 60 * 1000,
  );
});
