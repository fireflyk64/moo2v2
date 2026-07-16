// Opt-in AI tournament harness (bugs.md 2026-07-15: "pit some strategies
// against one another ... improve the AI based on who comes up top").
//
//   MOO2_TOURNEY=1 npx vitest run tests/balance/tournament.test.ts
//
// Phases (TOURNEY_PHASES, default "races,rr"):
//   races — lithovore (lithor), cybernetic (ferron), standard (solari) and
//           hivex each play the balanced solari baseline on the SOLO game's
//           own seed/map (pre-warp, medium) to the SOLO game's 297 turns.
//   rr    — personality round-robin (balanced/techer/rusher/industrialist/
//           expander/militarist), both seatings, same map.
//
// Every match appends a JSON line to bugs/tournament/results-<runid>.jsonl as
// it finishes (a killed run still leaves data), and a human-readable report
// lands in bugs/tournament/results-<runid>.md at the end. The human's actual
// turn-297 empire (decoded from bugs/moo2v2-SOLO-turn297.moo2save) is printed
// as the competitiveness benchmark. Iteration protocol: bugs/tournament/README.md.
//
// Knobs: TOURNEY_TURNS (297), TOURNEY_SEEDS (SOLO seed, comma-separated),
//        TOURNEY_RACES (solari,ferron,lithor,hivex), TOURNEY_PHASES,
//        TOURNEY_SEATINGS (2; 1 = single seating per pair — iteration mode),
//        TOURNEY_SHARD (k/n: run only matches with index % n == k so several
//        workers split a round; runid gets a .k suffix, merge the jsonl).

import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { MemoryHub } from '@protocol/memoryTransport';
import { createHostedGame, joinGame } from '@protocol/setup';
import { DEFAULT_SETTINGS } from '@protocol/messages';
import type { EngineAdapter } from '@protocol/engineAdapter';
import { gameEngine } from '@engine/adapter';
import type { GameState } from '@engine/types';
import { decodeSaveFile } from '@storage/savefile';
import { SoloBot, type BotPersonality } from '@ui/soloBot';

const enabled = process.env['MOO2_TOURNEY'] === '1';

const SOLO_SEED = '393fb1637b94ab1c3bab42a890abd11f';
const SOLO_SAVE = join(__dirname, '../../bugs/moo2v2-SOLO-turn297.moo2save');
const OUT_DIR = process.env['TOURNEY_OUT'] ?? join(__dirname, '../../bugs/tournament');
const TURNS = Number(process.env['TOURNEY_TURNS'] ?? 297);
const SEEDS = (process.env['TOURNEY_SEEDS'] ?? SOLO_SEED).split(',');
const PHASES = (process.env['TOURNEY_PHASES'] ?? 'races,rr').split(',');
const RACES = (process.env['TOURNEY_RACES'] ?? 'solari,ferron,lithor,hivex').split(',');
// pick-point budget for every match; the arch phase is where it matters
const PICKS = Number(process.env['TOURNEY_PICKS'] ?? 10);
// budget-scaling bot archetypes (botRaces.ts) for the 'arch' phase
const ARCHS = (process.env['TOURNEY_ARCHS'] ?? 'forgers,scholars,lithovores,cyborgs,creatives').split(',');
const CHECKPOINTS = [...new Set([100, 200, 297, 500, TURNS])].filter((t) => t <= TURNS);
const SEATINGS = Number(process.env['TOURNEY_SEATINGS'] ?? 2);
const [SHARD_K, SHARD_N] = (process.env['TOURNEY_SHARD'] ?? '0/1').split('/').map(Number) as [number, number];
const PERSONALITIES: BotPersonality[] = ['balanced', 'techer', 'rusher', 'industrialist', 'expander', 'militarist'];

interface SeatCfg {
  personality: BotPersonality;
  race: string; // stock preset id OR bot archetype id (botRaces.ts)
}

interface SeatStats {
  colonies: number;
  apps: number;
  pop: number;
  warships: number;
  bc: number;
  score: number;
  eliminated: boolean;
}

interface MatchResult {
  phase: string;
  seed: string;
  a: SeatCfg;
  b: SeatCfg;
  finalTurn: number;
  stalled: boolean;
  ms: number;
  winner: number | null;
  checkpoints: Record<number, [SeatStats, SeatStats]>;
  final: [SeatStats, SeatStats];
  /** % of the galaxy's planets claimed (colonies + outposts) at game end —
   * the design goal is a pretty much FULL map by the time a game concludes */
  mapFullPct: number;
}

function mapFullPct(state: GameState): number {
  // real planets only, both sides of the ratio — outposts on asteroid belts
  // and gas giants otherwise push a full map past 100%
  const planetIds = new Set(state.planets.filter((p) => p.body === 'planet').map((p) => p.id));
  const claimed = state.colonies.filter((c) => planetIds.has(c.planetId)).length;
  return planetIds.size ? Math.round((claimed * 100) / planetIds.size) : 0;
}

function seatStats(state: GameState, id: number): SeatStats {
  const empire = state.empires.find((e) => e.id === id)!;
  const colonies = state.colonies.filter((c) => c.owner === id && !c.outpost).length;
  const pop = state.colonies
    .filter((c) => c.owner === id)
    .reduce((n, c) => n + c.groups.reduce((m, g) => m + Math.floor(g.popK / 1000), 0), 0);
  const warships = state.ships.filter((s) => s.owner === id && s.shipKind === 'design').length;
  // the selfplay score: expansion-heavy with tech/military/treasury terms
  const score = empire.eliminated
    ? -1000
    : colonies * 20 + pop * 3 + empire.knownApps.length + warships * 5 + Math.floor(empire.bc / 50);
  return { colonies, apps: empire.knownApps.length, pop, warships, bc: empire.bc, score, eliminated: empire.eliminated };
}

const identity = (name: string) => ({
  name,
  engineVersion: '0.1.0',
  dataVersion: 'dv-test',
  roomCode: 'TRNY',
  lobbyServer: 'memory',
});

async function runMatch(phase: string, seed: string, a: SeatCfg, b: SeatCfg): Promise<MatchResult> {
  const started = Date.now();
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
      pickPoints: PICKS,
    },
    identity: identity('A'),
  });
  const client = joinGame<GameState>({ transport: hub.join(), engine, store: null, identity: identity('B') });
  // race goes through the SoloBot `race` option (the production code path):
  // archetype ids rescale to the match's pickPoints, preset ids stay fixed
  const botA = new SoloBot({
    session: hosted.session,
    mode: 'fair',
    brain: 'v2',
    personality: a.personality,
    race: a.race,
  });
  const botB = new SoloBot({
    session: client,
    mode: 'fair',
    brain: 'v2',
    personality: b.personality,
    race: b.race,
  });
  botA.setAggressive(true);
  botB.setAggressive(true);

  const checkpoints: Record<number, [SeatStats, SeatStats]> = {};
  const stop = hosted.session.subscribe((ev) => {
    if (ev.type !== 'turn-advanced') return;
    const st = hosted.session.getState();
    if (st && CHECKPOINTS.includes(ev.turn)) checkpoints[ev.turn] = [seatStats(st, 0), seatStats(st, 1)];
    if (ev.turn >= TURNS) {
      botA.close();
      botB.close();
    }
  });

  await hub.settle();
  hosted.host.startGame(seed);
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
  return {
    phase,
    seed,
    a,
    b,
    finalTurn: final.turn,
    stalled: final.winner === null && final.turn < TURNS,
    ms: Date.now() - started,
    winner: final.winner,
    checkpoints,
    final: [seatStats(final, 0), seatStats(final, 1)],
    mapFullPct: mapFullPct(final),
  };
}

/** the human's actual turn-297 empire from the bug-report save (benchmark) */
async function humanBenchmark(): Promise<SeatStats | null> {
  if (!existsSync(SOLO_SAVE)) return null;
  const env = await decodeSaveFile(new Uint8Array(readFileSync(SOLO_SAVE)));
  if (!env.snapshot) return null;
  const state = JSON.parse(env.snapshot.stateJson) as GameState;
  return seatStats(state, 0);
}

const fmt = (s: SeatStats) => `${s.colonies}c/${s.apps}a/${s.pop}p/${s.warships}w/${s.score}pts${s.eliminated ? ' ELIM' : ''}`;

describe.runIf(enabled)('AI tournament', () => {
  it(
    'runs the configured phases and writes the report',
    async () => {
      mkdirSync(OUT_DIR, { recursive: true });
      const runId =
        (process.env['TOURNEY_RUNID'] ?? new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)) +
        (SHARD_N > 1 ? `.${SHARD_K}` : '');
      const jsonl = join(OUT_DIR, `results-${runId}.jsonl`);
      const results: MatchResult[] = [];
      let matchIndex = 0;
      const play = async (phase: string, seed: string, a: SeatCfg, b: SeatCfg) => {
        if (matchIndex++ % SHARD_N !== SHARD_K) return null;
        const r = await runMatch(phase, seed, a, b);
        results.push(r);
        appendFileSync(jsonl, JSON.stringify(r) + '\n');
        console.log(
          `[${phase}] ${a.personality}/${a.race} vs ${b.personality}/${b.race} seed=${seed.slice(0, 8)} ` +
            `t${r.finalTurn}${r.stalled ? ' STALL' : ''} winner=${r.winner ?? '-'} ` +
            `A=${fmt(r.final[0])} B=${fmt(r.final[1])} map=${r.mapFullPct}% ${(r.ms / 1000).toFixed(0)}s`,
        );
        return r;
      };

      const baseline: SeatCfg = { personality: 'balanced', race: 'solari' };
      if (PHASES.includes('races')) {
        for (const seed of SEEDS) {
          for (const race of RACES) {
            const cfg: SeatCfg = { personality: 'balanced', race };
            await play('races', seed, cfg, baseline); // race in the human's seat
            if (SEATINGS > 1) await play('races', seed, baseline, cfg); // race in the bot's seat
          }
        }
      }
      if (PHASES.includes('arch')) {
        // budget-scaling archetypes vs the stock baseline, at PICKS points
        for (const seed of SEEDS) {
          for (const arch of ARCHS) {
            const cfg: SeatCfg = { personality: 'balanced', race: arch };
            await play('arch', seed, cfg, baseline);
            if (SEATINGS > 1) await play('arch', seed, baseline, cfg);
          }
        }
      }
      if (PHASES.includes('rr')) {
        for (const seed of SEEDS) {
          for (let i = 0; i < PERSONALITIES.length; i++) {
            for (let j = i + 1; j < PERSONALITIES.length; j++) {
              const pa: SeatCfg = { personality: PERSONALITIES[i]!, race: 'solari' };
              const pb: SeatCfg = { personality: PERSONALITIES[j]!, race: 'solari' };
              await play('rr', seed, pa, pb);
              if (SEATINGS > 1) await play('rr', seed, pb, pa);
            }
          }
        }
      }

      // ---- report ----
      const human = await humanBenchmark();
      const lines: string[] = [
        `# AI tournament ${runId}`,
        '',
        `turns=${TURNS} seeds=${SEEDS.map((s) => s.slice(0, 8)).join(',')} phases=${PHASES.join(',')} matches=${results.length}`,
        human ? `human benchmark (SOLO save, turn 297, seat 0): ${fmt(human)}` : 'human benchmark unavailable',
        '',
      ];
      const violations: string[] = [];
      if (PHASES.includes('races')) {
        lines.push('## Race gauntlet (vs balanced solari, SOLO map)', '');
        lines.push('| race | seat | t100 | t200 | final | result |', '|---|---|---|---|---|---|');
        for (const r of results.filter((x) => x.phase === 'races')) {
          const raceSeat = r.a.race !== 'solari' || r.b.race === r.a.race ? 0 : 1;
          const s = (t: number) => (r.checkpoints[t] ? fmt(r.checkpoints[t]![raceSeat as 0 | 1]) : '—');
          const fin = r.final[raceSeat as 0 | 1];
          const race = raceSeat === 0 ? r.a.race : r.b.race;
          const outcome = r.winner === null ? 'timeout' : r.winner === raceSeat ? 'WIN' : 'loss';
          lines.push(`| ${race} | ${raceSeat} | ${s(100)} | ${s(200)} | ${fmt(fin)} | ${outcome} |`);
          // competitive floor: developing by mid-game, and not a total collapse
          const mid = r.checkpoints[200]?.[raceSeat as 0 | 1];
          if (mid && (mid.colonies < 3 || mid.apps < 20)) {
            violations.push(`races: ${race} (seat ${raceSeat}) underdeveloped at t200: ${fmt(mid)}`);
          }
          if (r.stalled) violations.push(`races: ${race} (seat ${raceSeat}) match stalled at t${r.finalTurn}`);
        }
        lines.push('');
      }
      if (PHASES.includes('arch')) {
        lines.push(`## Archetype gauntlet (vs balanced solari, ${PICKS} pick points)`, '');
        lines.push('| archetype | seat | t100 | t200 | final | map | result |', '|---|---|---|---|---|---|---|');
        for (const r of results.filter((x) => x.phase === 'arch')) {
          const archSeat = r.a.race !== 'solari' ? 0 : 1;
          const s = (t: number) => (r.checkpoints[t] ? fmt(r.checkpoints[t]![archSeat as 0 | 1]) : '—');
          const fin = r.final[archSeat as 0 | 1];
          const arch = archSeat === 0 ? r.a.race : r.b.race;
          const outcome = r.winner === null ? 'timeout' : r.winner === archSeat ? 'WIN' : 'loss';
          lines.push(`| ${arch} | ${archSeat} | ${s(100)} | ${s(200)} | ${fmt(fin)} | ${r.mapFullPct}% | ${outcome} |`);
          const mid = r.checkpoints[200]?.[archSeat as 0 | 1];
          if (mid && (mid.colonies < 3 || mid.apps < 20)) {
            violations.push(`arch: ${arch} (seat ${archSeat}) underdeveloped at t200: ${fmt(mid)}`);
          }
          if (r.stalled) violations.push(`arch: ${arch} (seat ${archSeat}) match stalled at t${r.finalTurn}`);
        }
        lines.push('');
      }
      if (PHASES.includes('rr')) {
        lines.push('## Personality round-robin (solari mirror)', '');
        const table = new Map<string, { pts: number; wins: number; games: number; score: number }>();
        for (const p of PERSONALITIES) table.set(p, { pts: 0, wins: 0, games: 0, score: 0 });
        for (const r of results.filter((x) => x.phase === 'rr')) {
          for (const seat of [0, 1] as const) {
            const p = seat === 0 ? r.a.personality : r.b.personality;
            const row = table.get(p)!;
            row.games++;
            row.score += r.final[seat].score;
            if (r.winner === seat) {
              row.wins++;
              row.pts += 2;
            } else if (r.winner === null) {
              // unfinished: score decides the point
              row.pts += r.final[seat].score >= r.final[seat === 0 ? 1 : 0].score ? 1 : 0;
            }
          }
          if (r.stalled) violations.push(`rr: ${r.a.personality} vs ${r.b.personality} stalled at t${r.finalTurn}`);
        }
        const ranked = [...table.entries()].sort((x, y) => y[1].pts - x[1].pts || y[1].score - x[1].score);
        lines.push('| rank | personality | pts | wins | games | avg score |', '|---|---|---|---|---|---|');
        ranked.forEach(([p, s], i) =>
          lines.push(`| ${i + 1} | ${p} | ${s.pts} | ${s.wins} | ${s.games} | ${Math.round(s.score / Math.max(1, s.games))} |`),
        );
        lines.push('', '### Pairwise', '');
        for (const r of results.filter((x) => x.phase === 'rr')) {
          lines.push(
            `- ${r.a.personality} vs ${r.b.personality} (seed ${r.seed.slice(0, 8)}): winner=${
              r.winner === null ? 'none' : r.winner === 0 ? r.a.personality : r.b.personality
            } A=${fmt(r.final[0])} B=${fmt(r.final[1])}`,
          );
        }
        lines.push('');
      }
      // map fullness: games should end on a PRETTY MUCH FULL map — a low
      // average says the bots stopped expanding, not that the galaxy ran out
      if (results.length) {
        const avgFull = Math.round(results.reduce((n, r) => n + r.mapFullPct, 0) / results.length);
        lines.push(`## Map fullness`, '', `average ${avgFull}% of planets claimed at game end (per-match min ${Math.min(...results.map((r) => r.mapFullPct))}%, max ${Math.max(...results.map((r) => r.mapFullPct))}%)`, '');
      }
      if (violations.length) {
        lines.push('## Violations', '', ...violations.map((v) => `- ${v}`), '');
      }
      const md = join(OUT_DIR, `results-${runId}.md`);
      writeFileSync(md, lines.join('\n'));
      console.log(`report: ${md}`);

      // soft-collected so the report always exists before any failure surfaces
      expect(violations, violations.join('; ')).toEqual([]);
    },
    14_400_000, // 4h ceiling — a full 297-turn double round-robin takes a while
  );
});
