// CptBio benchmark: replay the EXACT galaxy of bugs/cptbio-turn233.moo2save
// (same master seed, settings and race sheets) with OnionAI in every seat —
// including the human's — and compare the bots' curves against both the old
// recorded bot curves and the human's own. The human crushed the recorded
// bots (t200: pop 281 vs 117, techs 56 vs 37, 31 colonies vs 24 with 3 of
// them idle at 2 for 100 turns); this harness measures whether the improved
// doctrine closes that gap on the very map it was lost on.
//
//   MOO2_CPTBIO=1 npx vitest run tests/balance/cptbio-bench.test.ts
//
// Results append to bugs/tournament/cptbio-bench.jsonl (one line per run).
import { describe, expect, it } from 'vitest';
import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { MemoryHub } from '@protocol/memoryTransport';
import { createHostedGame, joinGame } from '@protocol/setup';
import { DEFAULT_SETTINGS } from '@protocol/messages';
import type { EngineAdapter } from '@protocol/engineAdapter';
import { gameEngine } from '@engine/adapter';
import type { GameState } from '@engine/types';
import { SoloBot } from '@ui/soloBot';

const SAVE = join(__dirname, '../../bugs/cptbio-turn233.moo2save');
const OUT = join(__dirname, '../../bugs/tournament/cptbio-bench.jsonl');
const RUN = process.env['MOO2_CPTBIO'] === '1';
const TURNS = Number(process.env['CPTBIO_TURNS'] ?? 200);
const CHECKPOINTS = [50, 100, 150, 200, 233].filter((t) => t <= TURNS);

interface Curve {
  colonies: number;
  pop: number;
  apps: number;
  warships: number;
  bc: number;
  freighters: number;
}

function curveOf(state: GameState, id: number): Curve {
  const empire = (state as unknown as { empires: Array<{ id: number; knownApps: string[]; bc: number; freighters: number }> }).empires.find((e) => e.id === id)!;
  const s = state as unknown as {
    colonies: Array<{ owner: number; outpost: boolean; groups: Array<{ popK: number }> }>;
    ships: Array<{ owner: number; shipKind: string }>;
  };
  const mine = s.colonies.filter((c) => c.owner === id && !c.outpost);
  return {
    colonies: mine.length,
    pop: mine.reduce((n, c) => n + c.groups.reduce((m, g) => m + Math.floor(g.popK / 1000), 0), 0),
    apps: empire.knownApps.length,
    warships: s.ships.filter((sh) => sh.owner === id && sh.shipKind === 'design').length,
    bc: empire.bc,
    freighters: empire.freighters,
  };
}

const identity = (name: string) => ({
  name,
  engineVersion: '0.1.0',
  dataVersion: 'dv-test',
  roomCode: 'CBIO',
  lobbyServer: 'memory',
});

describe.skipIf(!RUN || !existsSync(SAVE))('cptbio-map benchmark', () => {
  it('four improved onion bots on the recorded galaxy', async () => {
    const env = JSON.parse(gunzipSync(readFileSync(SAVE).subarray(9)).toString()) as {
      commands: Array<{ kind: string; payload: string }>;
      snapshots: Array<{ turn: number; stateJson: string }>;
    };
    const start = JSON.parse(env.commands.find((c) => c.kind === 'game_start')!.payload) as {
      seed: string;
      settings: Record<string, unknown>;
      players: Array<{ id: number; name: string; raceJson: string }>;
    };

    // the RECORDED curves at each checkpoint (human seat 0, old bots 1-3)
    const recorded: Record<number, Curve[]> = {};
    for (const t of CHECKPOINTS) {
      const snap = env.snapshots.find((s) => s.turn >= t - 1 && s.turn <= t + 2);
      if (!snap) continue;
      const st = JSON.parse(snap.stateJson) as GameState;
      recorded[t] = [0, 1, 2, 3].map((id) => curveOf(st, id));
    }

    const hub = new MemoryHub(4);
    const engine = gameEngine as unknown as EngineAdapter<GameState>;
    const hosted = createHostedGame<GameState>({
      transport: hub.join(),
      engine,
      store: null,
      settings: { ...DEFAULT_SETTINGS, ...(start.settings as object) },
      identity: identity(start.players[0]!.name),
    });
    const sessions = [
      hosted.session,
      ...start.players
        .slice(1)
        .map((p) => joinGame<GameState>({ transport: hub.join(), engine, store: null, identity: identity(p.name) })),
    ];
    const bots = sessions.map((session, i) => {
      const bot = new SoloBot({
        session,
        mode: 'fair',
        brain: 'onion',
        personality: 'auto',
        raceJson: start.players[i]!.raceJson,
      });
      bot.setAggressive(true);
      return bot;
    });

    const checkpoints: Record<number, Curve[]> = {};
    const stop = hosted.session.subscribe((ev) => {
      if (ev.type !== 'turn-advanced') return;
      const st = hosted.session.getState();
      if (st && CHECKPOINTS.includes(ev.turn)) checkpoints[ev.turn] = [0, 1, 2, 3].map((id) => curveOf(st, id));
    });

    await hub.settle();
    hosted.host.startGame(start.seed);
    let last = -1;
    let stalls = 0;
    for (let i = 0; i < TURNS * 6; i++) {
      await hub.settle();
      const st = hosted.session.getState();
      if (!st) continue;
      if (st.winner !== null || st.turn >= TURNS) break;
      if (st.turn === last && ++stalls > 12) break;
      if (st.turn !== last) stalls = 0;
      last = st.turn;
    }
    stop();
    for (const b of bots) b.close();
    const final = hosted.session.getState()!;
    const result = {
      when: 'cptbio-bench',
      finalTurn: final.turn,
      winner: final.winner,
      checkpoints,
      recorded,
    };
    appendFileSync(OUT, JSON.stringify(result) + '\n');
    expect(final.turn).toBeGreaterThan(40);
  }, 3_000_000);
});
