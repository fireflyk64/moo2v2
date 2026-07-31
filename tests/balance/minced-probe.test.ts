// Per-turn trace of one minced-vs-onion mirror (opt-in):
//
//   MOO2_MPROBE=1 npx vitest run tests/balance/minced-probe.test.ts
//
// Knobs: MPROBE_TURNS (420), MPROBE_PERS (rusher), MPROBE_SEAT (1 = minced
// in the client seat), MPROBE_SEED (SOLO seed). Writes one line per turn to
// bugs/tournament/minced-probe.log: colonies/warships/bc for both seats,
// war state, and each brain's current plan. Used by the tournament
// improvement loop to see WHERE a persistent mirror loss actually breaks.

import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { MemoryHub } from '@protocol/memoryTransport';
import { createHostedGame, joinGame } from '@protocol/setup';
import { DEFAULT_SETTINGS } from '@protocol/messages';
import type { EngineAdapter } from '@protocol/engineAdapter';
import { gameEngine } from '@engine/adapter';
import type { GameState } from '@engine/types';
import { HULL_WEIGHT } from '@engine/index';
import { SoloBot, type BotPersonality } from '@ui/soloBot';

const enabled = process.env['MOO2_MPROBE'] === '1';
const TURNS = Number(process.env['MPROBE_TURNS'] ?? 420);
const PERS = (process.env['MPROBE_PERS'] ?? 'rusher') as BotPersonality;
const SEAT = Number(process.env['MPROBE_SEAT'] ?? 1);
const SEED = process.env['MPROBE_SEED'] ?? '393fb1637b94ab1c3bab42a890abd11f';
const OUT = join(__dirname, '../../bugs/tournament/minced-probe.log');

const identity = (name: string) => ({
  name,
  engineVersion: '0.1.0',
  dataVersion: 'dv-test',
  roomCode: 'MPRB',
  lobbyServer: 'memory',
});

function snap(state: GameState, id: number): string {
  const e = state.empires.find((x) => x.id === id)!;
  const col = state.colonies.filter((c) => c.owner === id && !c.outpost).length;
  let war = 0;
  let weight = 0;
  const dw = new Map(e.designs.map((d) => [d.id, HULL_WEIGHT[d.hull] ?? 1]));
  for (const s of state.ships) {
    if (s.owner !== id || s.shipKind !== 'design') continue;
    war++;
    weight += Math.max(1, dw.get(s.designId ?? -1) ?? 1);
  }
  return `${col}c/${war}w/${weight}wt/${e.knownApps.length}a/${Math.round(e.bc)}bc${e.eliminated ? '/ELIM' : ''}`;
}

describe.runIf(enabled)('minced mirror probe', () => {
  it(
    'traces one mirror per-turn',
    async () => {
      mkdirSync(join(__dirname, '../../bugs/tournament'), { recursive: true });
      writeFileSync(OUT, `# minced probe pers=${PERS} mincedSeat=${SEAT} seed=${SEED.slice(0, 8)} turns=${TURNS}\n`);
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
      const brains = SEAT === 0 ? (['minced', 'onion'] as const) : (['onion', 'minced'] as const);
      const botA = new SoloBot({ session: hosted.session, mode: 'fair', brain: brains[0], personality: PERS, race: 'solari' });
      const botB = new SoloBot({ session: client, mode: 'fair', brain: brains[1], personality: PERS, race: 'solari' });
      botA.setAggressive(true);
      botB.setAggressive(true);

      const stop = hosted.session.subscribe((ev) => {
        if (ev.type !== 'turn-advanced') return;
        const st = hosted.session.getState();
        if (!st) return;
        const atWar = st.relations.some((r) => r.status === 'war');
        appendFileSync(
          OUT,
          `t${String(ev.turn).padStart(3)} ${brains[0]}[${botA.onionPlan ?? '-'}]=${snap(st, 0)} ` +
            `${brains[1]}[${botB.onionPlan ?? '-'}]=${snap(st, 1)}${atWar ? ' WAR' : ''}` +
            ` battles=${st.pendingBattles.length}\n`,
        );
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
      const final = hosted.session.getState()!;
      appendFileSync(OUT, `# final t${final.turn} winner=${final.winner ?? '-'} A=${snap(final, 0)} B=${snap(final, 1)}\n`);
      console.log(`probe log: ${OUT}`);
      expect(final.turn).toBeGreaterThan(50);
    },
    3_600_000,
  );
});
