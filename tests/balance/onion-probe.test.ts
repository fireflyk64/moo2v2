// Diagnostic probe for the OnionAI improvement loop: one onion-vs-v2 match
// under tournament settings, logging both empires' development and the onion
// brain's live constraint plan every few turns. Run:
//   MOO2_PROBE=1 npx vitest run tests/balance/onion-probe.test.ts
// Knobs: PROBE_TURNS (297), PROBE_SEED (SOLO seed), PROBE_PERS (balanced),
//        PROBE_SEAT (0 = onion hosts; 1 = v2 hosts)
import { appendFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'vitest';
import { MemoryHub } from '@protocol/memoryTransport';
import { createHostedGame, joinGame } from '@protocol/setup';
import { DEFAULT_SETTINGS } from '@protocol/messages';
import type { EngineAdapter } from '@protocol/engineAdapter';
import { gameEngine } from '@engine/adapter';
import type { GameState } from '@engine/types';
import { SoloBot, type BotPersonality } from '@ui/soloBot';

const enabled = process.env['MOO2_PROBE'] === '1';
const SEED = process.env['PROBE_SEED'] ?? '393fb1637b94ab1c3bab42a890abd11f';
const TURNS = Number(process.env['PROBE_TURNS'] ?? 297);
const PERS = (process.env['PROBE_PERS'] ?? 'balanced') as BotPersonality;
const ONION_SEAT = Number(process.env['PROBE_SEAT'] ?? 0);
const OUT = join(__dirname, '../../bugs/tournament/onion-probe.log');

const identity = (name: string) => ({
  name,
  engineVersion: '0.1.0',
  dataVersion: 'dv-test',
  roomCode: 'PROBE',
  lobbyServer: 'memory',
});

describe.runIf(enabled)('onion probe', () => {
  it(
    'logs onion-vs-v2 development and the live plan',
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
      const brains = ONION_SEAT === 0 ? (['onion', 'v2'] as const) : (['v2', 'onion'] as const);
      const botA = new SoloBot({ session: hosted.session, mode: 'fair', brain: brains[0], personality: PERS, race: 'solari' });
      const botB = new SoloBot({ session: client, mode: 'fair', brain: brains[1], personality: PERS, race: 'solari' });
      botA.setAggressive(true);
      botB.setAggressive(true);
      const onionBot = brains[0] === 'onion' ? botA : botB;

      writeFileSync(OUT, `seed=${SEED} pers=${PERS} onionSeat=${ONION_SEAT}\n`);
      const stop = hosted.session.subscribe((ev) => {
        if (ev.type !== 'turn-advanced') return;
        const st = hosted.session.getState();
        if (!st) return;
        if (ev.turn % 10 === 0 || ev.turn >= TURNS) {
          const seat = (id: number) => {
            const e = st.empires.find((x) => x.id === id)!;
            const col = st.colonies.filter((c) => c.owner === id && !c.outpost).length;
            const pop = st.colonies
              .filter((c) => c.owner === id)
              .reduce((n, c) => n + c.groups.reduce((m, g) => m + Math.floor(g.popK / 1000), 0), 0);
            const war = st.ships.filter((s) => s.owner === id && s.shipKind === 'design').length;
            const cships = st.ships.filter((s) => s.owner === id && s.shipKind === 'colony_ship').length;
            const labs = st.colonies.filter((c) => c.owner === id && c.buildings.includes('research_lab')).length;
            const sci = st.colonies
              .filter((c) => c.owner === id)
              .reduce((n, c) => n + c.groups.reduce((m, g) => m + g.scientists, 0), 0);
            return `${col}c/${e.knownApps.length}a/${e.completedFields.length}f/${labs}L/${sci}sci/${pop}p/${war}w/${cships}cs/${e.bc}bc${e.eliminated ? ' ELIM' : ''}`;
          };
          const rel = st.relations.find((r) => r.a === 0 && r.b === 1)?.status ?? 'none';
          appendFileSync(
            OUT,
            `t${ev.turn} plan=${onionBot.onionPlan ?? '-'} ${rel} onion[${ONION_SEAT}]=${seat(ONION_SEAT)} v2[${1 - ONION_SEAT}]=${seat(1 - ONION_SEAT)}\n`,
          );
        }
        if (ev.turn >= TURNS) {
          botA.close();
          botB.close();
        }
      });

      await hub.settle();
      hosted.host.startGame(SEED);
      let last = -1;
      for (let i = 0; i < TURNS * 4; i++) {
        await hub.settle();
        const st = hosted.session.getState();
        if (!st) continue;
        if (st.winner !== null || st.turn >= TURNS) break;
        if (st.turn === last) break;
        last = st.turn;
      }
      stop();
      botA.close();
      botB.close();
      const fin = hosted.session.getState()!;
      appendFileSync(OUT, `FINAL t${fin.turn} winner=${fin.winner ?? '-'}\n`);
    },
    60 * 60 * 1000,
  );
});
