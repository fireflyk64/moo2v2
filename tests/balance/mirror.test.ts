// Opt-in mirror catch-up proof (bugs.md: "mirror AI mode should be quite
// difficult since it can play catch-up if it falls behind"). A MemoryHub
// match on a MIRROR galaxy with debugCommands on: the catch-up-enabled bot
// (mirrorCatchUp default) tops its fleet up with granted escorts + the odd
// colony ship, the control opponent plays plain fair with the catch-up off.
// Gate is SCORE (never win counts — they reshuffle on any rules change):
// the mirror bot must finish >= its opponent at the turn cap in the
// production seatings (bot seats), and >= 0.85x in the synthetic
// worst-case seating (see the case table for why).
//
//   MOO2_MIRROR=1 npx vitest run tests/balance/mirror.test.ts
//
// Knobs: MIRROR_TURNS (297), MIRROR_SEED (the SOLO seed), MIRROR_OUT (path
// to append one result line per match — vitest hides passing tests' logs).

import { appendFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { MemoryHub } from '@protocol/memoryTransport';
import { createHostedGame, joinGame } from '@protocol/setup';
import { DEFAULT_SETTINGS } from '@protocol/messages';
import type { EngineAdapter } from '@protocol/engineAdapter';
import { gameEngine } from '@engine/adapter';
import type { GameState } from '@engine/types';
import { SoloBot, type BotBrain } from '@ui/soloBot';

const enabled = process.env['MOO2_MIRROR'] === '1';
const TURNS = Number(process.env['MIRROR_TURNS'] ?? 297);
const SEED = process.env['MIRROR_SEED'] ?? '393fb1637b94ab1c3bab42a890abd11f';

const identity = (name: string) => ({
  name,
  engineVersion: '0.1.0',
  dataVersion: 'dv-test',
  roomCode: 'MIRR',
  lobbyServer: 'memory',
});

interface SeatStats {
  colonies: number;
  apps: number;
  pop: number;
  warships: number;
  score: number;
  eliminated: boolean;
}

function seatStats(state: GameState, id: number): SeatStats {
  const empire = state.empires.find((e) => e.id === id)!;
  const colonies = state.colonies.filter((c) => c.owner === id && !c.outpost).length;
  const pop = state.colonies
    .filter((c) => c.owner === id)
    .reduce((n, c) => n + c.groups.reduce((m, g) => m + Math.floor(g.popK / 1000), 0), 0);
  const warships = state.ships.filter((s) => s.owner === id && s.shipKind === 'design').length;
  const score = empire.eliminated
    ? -1000
    : colonies * 20 + pop * 3 + empire.knownApps.length + warships * 5 + Math.floor(empire.bc / 50);
  return { colonies, apps: empire.knownApps.length, pop, warships, score, eliminated: empire.eliminated };
}

const fmt = (s: SeatStats) =>
  `${s.colonies}c/${s.apps}a/${s.pop}p/${s.warships}w/${s.score}pts${s.eliminated ? ' ELIM' : ''}`;

/** one mirror-galaxy match; seat `catchSeat` runs the catch-up, the other is
 * the plain fair control (mirrorCatchUp off) */
async function runMirrorMatch(
  catchSeat: 0 | 1,
  catchBrain: BotBrain,
  controlBrain: BotBrain,
): Promise<{
  catch: SeatStats;
  control: SeatStats;
  finalTurn: number;
  escorts: number;
  settlers: number;
}> {
  const hub = new MemoryHub(2);
  const engine = gameEngine as unknown as EngineAdapter<GameState>;
  const hosted = createHostedGame<GameState>({
    transport: hub.join(),
    engine,
    store: null,
    settings: {
      ...DEFAULT_SETTINGS,
      playerCount: 2,
      galaxySize: 'medium',
      startMode: 'pre_warp',
      mirror: true,
      debugCommands: true, // the catch-up gate: settings.mirror && settings.debugCommands
    },
    identity: identity('A'),
  });
  const client = joinGame<GameState>({ transport: hub.join(), engine, store: null, identity: identity('B') });
  const mk = (seat: 0 | 1, session: typeof hosted.session) =>
    new SoloBot({
      session,
      mode: 'fair',
      brain: seat === catchSeat ? catchBrain : controlBrain,
      personality: 'balanced',
      race: 'solari',
      ...(seat === catchSeat ? {} : { mirrorCatchUp: false }),
    });
  const botA = mk(0, hosted.session);
  const botB = mk(1, client as typeof hosted.session);
  botA.setAggressive(true);
  botB.setAggressive(true);

  const stop = hosted.session.subscribe((ev) => {
    if (ev.type === 'turn-advanced' && ev.turn >= TURNS) {
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
    if (st.turn === last) break; // bots idle: stall
    last = st.turn;
  }
  stop();
  botA.close();
  botB.close();
  const final = hosted.session.getState()!;
  const catchBot = catchSeat === 0 ? botA : botB;
  return {
    catch: seatStats(final, catchSeat),
    control: seatStats(final, 1 - catchSeat),
    finalTurn: final.turn,
    escorts: catchBot.mirrorEscortsGranted,
    settlers: catchBot.mirrorSettlersGranted,
  };
}

describe.runIf(enabled)('mirror catch-up bot', () => {
  // Production topology: enterSoloGame always seats the HUMAN at 0 and the
  // bots at 1+, so a real mirror catch-up bot never plays seat 0 — the
  // seat-1 pairings are the product configuration and get the strict gate.
  // The synthetic seat-0-vs-own-twin case is the hardest matchup there is
  // (identical brain, host-seat drift against it, and cheats that its equal
  // twin converts into its own fleet appetite); it is kept as a soft-gated
  // regression guard: measured 0.93-0.95× across tuning runs, while the
  // pre-solvency-gate bug cratered it to −119 vs 468 (grant upkeep spiral).
  const cases: Array<{ name: string; seat: 0 | 1; catchBrain: BotBrain; control: BotBrain; gate: number }> = [
    { name: 'catchup-onion (bot seat 1) vs fair-onion', seat: 1, catchBrain: 'onion', control: 'onion', gate: 1 },
    { name: 'catchup-onion (bot seat 1) vs fair-v2', seat: 1, catchBrain: 'onion', control: 'v2', gate: 1 },
    { name: 'catchup-onion (worst case: seat 0) vs fair-onion', seat: 0, catchBrain: 'onion', control: 'onion', gate: 0.85 },
  ];
  for (const c of cases) {
    it(
      `${c.name}: score >= ${c.gate}x the control at t${TURNS}`,
      async () => {
        const r = await runMirrorMatch(c.seat, c.catchBrain, c.control);
        const line =
          `[mirror] ${c.name} t${r.finalTurn}: catchup=${fmt(r.catch)} control=${fmt(r.control)} ` +
          `grants=${r.escorts} escorts + ${r.settlers} settlers`;
        console.log(line);
        if (process.env['MIRROR_OUT']) appendFileSync(process.env['MIRROR_OUT'], line + '\n');
        expect(r.finalTurn).toBeGreaterThanOrEqual(TURNS);
        // score gate, not win count (selfplay re-baseline rule)
        expect(r.catch.score).toBeGreaterThanOrEqual(r.control.score * c.gate);
      },
      1_800_000,
    );
  }
});
