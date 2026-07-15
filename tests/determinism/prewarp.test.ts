// Regression: bugs/moo2v2-SOLO-turn297.moo2save — a fair-mode militarist bot
// in a pre-warp start sat on ONE planet for 297 turns. Chain of causes, each
// fixed in soloBot.ts and pinned here:
//   - scienceBias 0 profiles assigned zero scientists -> zero RP -> the 7
//     starting apps forever (no colony ships, no hulls, no range tech);
//   - research was only (re)picked while fieldNum was null, so the turn-1
//     pick went stale for the rest of the game;
//   - colony_base (known from turn 1, needs no ship) was never queued — the
//     brain skipped all projects — leaving a free planet in the home system;
//   - scouts never moved (explored exactly the home star in 297 turns);
//   - attack() aimed move_ships at out-of-fuel-range stars every turn, all
//     silently rejected, with no outpost chain to close the gap.
// The average-start suites never caught it because average starts begin with
// colony ships already researched.

import { describe, expect, it } from 'vitest';
import { MemoryHub } from '@protocol/memoryTransport';
import { createHostedGame, joinGame } from '@protocol/setup';
import { DEFAULT_SETTINGS } from '@protocol/messages';
import type { EngineAdapter } from '@protocol/engineAdapter';
import { gameEngine } from '@engine/adapter';
import type { GameState } from '@engine/types';
import { SoloBot } from '@ui/soloBot';

const SEED = '393fb1637b94ab1c3bab42a890abd11f'; // the bug report's own seed
const TURN_CAP = 90;

const identity = (name: string) => ({
  name,
  engineVersion: '0.1.0',
  dataVersion: 'dv-test',
  roomCode: 'PREW',
  lobbyServer: 'memory',
});

describe('pre-warp fair bot is not cordoned to one planet', () => {
  it(
    'a zero-scienceBias personality still researches, expands and sails',
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
        },
        identity: identity('Militarist'),
      });
      const client = joinGame<GameState>({ transport: hub.join(), engine, store: null, identity: identity('Balanced') });
      const botM = new SoloBot({ session: hosted.session, mode: 'fair', brain: 'v2', personality: 'militarist' });
      const botB = new SoloBot({ session: client, mode: 'fair', brain: 'v2', personality: 'balanced' });
      const stop = hosted.session.subscribe((ev) => {
        if (ev.type === 'turn-advanced' && ev.turn >= TURN_CAP) {
          botM.close();
          botB.close();
        }
      });
      await hub.settle();
      const startApps = () => {
        const st = hosted.session.getState();
        return st ? st.empires.map((e) => e.knownApps.length) : [];
      };
      hosted.host.startGame(SEED);
      await hub.settle();
      const initialApps = startApps();
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
      botM.close();
      botB.close();
      const final = hosted.session.getState()!;
      for (const seat of [0, 1]) {
        const empire = final.empires.find((e) => e.id === seat)!;
        const colonies = final.colonies.filter((c) => c.owner === seat && !c.outpost).length;
        // researched something beyond the starting apps (the bug: stuck at 7)
        expect(empire.knownApps.length, `seat ${seat} never researched`).toBeGreaterThan(initialApps[seat] ?? 7);
        // expanded past the homeworld (colony_base alone guarantees this on
        // any start with a second planet in either home system; colony
        // ships/outposts cover the rest)
        expect(colonies, `seat ${seat} cordoned to one planet`).toBeGreaterThan(1);
        // explored beyond the home star
        expect(empire.exploredStars.length, `seat ${seat} never scouted`).toBeGreaterThan(1);
      }
    },
    600_000,
  );
});
