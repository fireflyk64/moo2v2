// Example-save factory + reconciliation tuning lab (bugs.md #6/#7):
//   1. 'saves'  — a DAY-ONE ASYNC game in a LARGE galaxy, five players on five
//      different species; each seat plays its own 500-turn async continuation
//      (its personality aggressive at home, balanced stand-ins elsewhere) and
//      the five .moo2save files land in ~/examplesaves.
//   2. 'recon'  — automatic reconciliation runs over those five saves: a
//      baseline, then tuning rounds where a challenger seat gets a new
//      doctrine parameter set (ReconcileBotParams) that tries to BEAT the
//      reigning champion; every seat adopts the champion set between rounds,
//      so each adopted set demonstrably beat the last. Verifies the produced
//      envelope is a true replay (mode 'replay', refolds, buildReplay works,
//      order-independent). Findings land in bugs/reconcile-tuning.md.
//   3. 'live'   — builds the interactive (live) reconciliation kickoff from
//      the same five saves, saves it beside them, and drives a headless
//      "human at seat 0" session against bot stand-ins to prove the game is
//      playable: fleet/war commands work, economy commands bounce with the
//      script message, turns advance, battles resolve.
//
// Opt-in:
//   MOO2_EXSAVES=1 EXSAVES_PHASE=saves EXSAVES_SEATS=0,1 npx vitest run tests/balance/examplesaves.test.ts
//   MOO2_EXSAVES=1 EXSAVES_PHASE=recon npx vitest run tests/balance/examplesaves.test.ts
//   MOO2_EXSAVES=1 EXSAVES_PHASE=live  npx vitest run tests/balance/examplesaves.test.ts
// Knobs: EXSAVES_SEED, EXSAVES_ASYNC_TURNS (500), EXSAVES_GALAXY (large),
//        EXSAVES_OUT (~/examplesaves), EXSAVES_SEATS (0,1,2,3,4), EXSAVES_ROUNDS (4)

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createGameEngine } from '@engine/adapter';
import { ENGINE_VERSION, selectors } from '@engine/index';
import { DATA_VERSION } from '@engine/data/index';
import type { GameState } from '@engine/types';
import type { EngineCommand } from '@engine/commands';
import { validateCommand } from '@engine/commands';
import type { GameSession } from '@protocol/session';
import { DEFAULT_SETTINGS } from '@protocol/messages';
import { buildReconciliationStart } from '@storage/reconcile';
import { decodeSaveFile, encodeSaveFile, verifySaveEnvelope, type SaveEnvelope } from '@storage/savefile';
import { buildDayOneAsync } from '@ui/asyncStart';
import { buildReconciliationKickoff, runReconciliation } from '@ui/reconcileRun';
import { buildReplay } from '@ui/replay';
import { freshOnionMemory, onionBattleOrders, onionTurn, type OnionMemory } from '@ui/onionBot';
import { DEFAULT_RECONCILE_PARAMS, freshReconcileMemory, reconcileBotTurn, type ReconcileBotParams, type ReconcileTactic } from '@ui/reconcileBot';
import type { BotPersonality } from '@ui/soloBot';

const RUN = process.env.MOO2_EXSAVES === '1';
const PHASE = process.env.EXSAVES_PHASE ?? 'saves';
const SEED = process.env.EXSAVES_SEED ?? '5eed5a7e5eed5a7e5eed5a7e5eed5a7e';
const ASYNC_TURNS = Number(process.env.EXSAVES_ASYNC_TURNS ?? 500);
const GALAXY = (process.env.EXSAVES_GALAXY ?? 'large') as 'small' | 'medium' | 'large' | 'huge';
const OUT_DIR = process.env.EXSAVES_OUT ?? join(homedir(), 'examplesaves');
const SEATS = (process.env.EXSAVES_SEATS ?? '0,1,2,3,4').split(',').map(Number);
const ROUNDS = Number(process.env.EXSAVES_ROUNDS ?? 4);

/** five seats, five species, five temperaments — the async cast */
const CAST: Array<{ name: string; preset: string; personality: BotPersonality }> = [
  { name: 'Solari', preset: 'solari', personality: 'balanced' },
  { name: 'Hivex', preset: 'hivex', personality: 'expander' },
  { name: 'Ferron', preset: 'ferron', personality: 'industrialist' },
  { name: 'Cerebri', preset: 'cerebri', personality: 'techer' },
  { name: 'Korrath', preset: 'korrath', personality: 'militarist' },
];
const PLAYERS = CAST.map((c, i) => ({ id: i, name: c.name, raceJson: JSON.stringify({ presetId: c.preset }) }));

type Cmd = { seq: number; turn: number; playerId: number; kind: string; payload: string };

function dayOne(): SaveEnvelope {
  const { envelope } = buildDayOneAsync({
    host: { name: CAST[0]!.name, raceJson: PLAYERS[0]!.raceJson },
    guests: CAST.slice(1).map((c, i) => ({ name: c.name, raceJson: PLAYERS[i + 1]!.raceJson })),
    settings: {
      ...DEFAULT_SETTINGS,
      galaxySize: GALAXY,
      startMode: 'average',
      playerCount: PLAYERS.length,
      modes: { ...DEFAULT_SETTINGS.modes, randomEvents: false },
    },
    seed: SEED,
  });
  return envelope;
}

/** the async continuation fold: onion at every seat, own seat aggressive.
 * Victory does not stop the clock — any live empire continues the game, so
 * every save reaches the full turn count (reconciliation needs the shared
 * clock: scoring is at the SHORTEST save). */
function playTurns(startLog: Cmd[], turns: number, personalityOf: (seat: number) => BotPersonality, aggressiveSeat: number): { log: Cmd[]; final: GameState } {
  const engine = createGameEngine();
  let state: GameState | null = null;
  for (const c of startLog) {
    const payload = JSON.parse(c.payload) as unknown;
    state = c.kind === 'game_start' ? (engine.init(payload as never) as GameState) : (engine.apply(state!, { turn: c.turn, playerId: c.playerId, kind: c.kind, payload } as never) as GameState);
    engine.takeEvents();
  }
  const log = [...startLog];
  let seq = log.length;
  const applyCmd = (playerId: number, kind: string, payload: unknown): boolean => {
    const cmd: EngineCommand = { turn: state!.turn, playerId, kind, payload };
    if (playerId >= 0 && validateCommand(state!, cmd) !== null) return false;
    try {
      state = engine.apply(state!, cmd as never) as GameState;
    } catch {
      return false;
    }
    engine.takeEvents();
    log.push({ seq: seq++, turn: cmd.turn, playerId, kind, payload: JSON.stringify(payload ?? {}) });
    return true;
  };
  const memories = new Map<number, OnionMemory>(PLAYERS.map((p) => [p.id, freshOnionMemory()]));
  for (let t = 0; t < turns; t++) {
    // a declared win must not end the save early: the async clock runs on
    if (state!.winner !== null && !state!.victoryContinued) {
      const live = state!.empires.find((e) => !e.eliminated);
      if (!live || !applyCmd(live.id, 'continue_game', {})) break;
    }
    for (const empire of [...state!.empires].sort((a, b) => a.id - b.id)) {
      if (empire.eliminated) continue;
      const me = empire.id;
      const session = {
        submit: (kind: string, payload: unknown) => (applyCmd(me, kind, payload) ? {} : { error: 'rejected' }),
      } as unknown as GameSession<GameState>;
      onionTurn({ session, state: state!, planned: state!, me, personality: personalityOf(me), alwaysWar: me === aggressiveSeat, memory: memories.get(me)! });
    }
    applyCmd(-1, 'advance_turn', { fromTurn: state!.turn });
    if (state!.phase === 'battle_orders') {
      for (const battle of state!.pendingBattles) {
        for (const side of [battle.attacker, battle.defender]) {
          if (side < 0) continue;
          const filled = side === battle.attacker ? battle.ordersA : battle.ordersD;
          if (filled) continue;
          applyCmd(side, 'battle_orders', { battleId: battle.id, orders: onionBattleOrders(state!, side, battle, personalityOf(side)) });
        }
      }
      applyCmd(-1, 'resolve_combat', {});
    }
  }
  return { log, final: state! };
}

function envelopeOf(base: SaveEnvelope, log: Cmd[], seat: number, state: GameState): SaveEnvelope {
  const engine = createGameEngine();
  const gameId = `g-exsave-${seat}`;
  return {
    format: 'moo2v2-save',
    version: 2,
    game: {
      ...base.game,
      game_id: gameId,
      local_player_id: seat,
      room_code: 'EXSAVE',
      status: 'active',
      last_turn: state.turn,
      last_seq: log.length - 1,
    },
    players: base.players.map((p) => ({ ...p, game_id: gameId })),
    commands: log,
    snapshot: { turn: state.turn, seq: log.length - 1, stateJson: engine.serialize(state), stateHash: engine.hash(state) },
    snapshots: [],
    history: true,
  };
}

interface Dev {
  score: number;
  colonies: number;
  pop: number;
  apps: number;
  warships: number;
  eliminated: boolean;
}
function dev(state: GameState, id: number): Dev {
  const empire = state.empires.find((e) => e.id === id)!;
  const colonies = state.colonies.filter((c) => c.owner === id && !c.outpost).length;
  const pop = state.colonies.filter((c) => c.owner === id).reduce((n, c) => n + c.groups.reduce((m, g) => m + Math.floor(g.popK / 1000), 0), 0);
  const warships = state.ships.filter((s) => s.owner === id && s.shipKind === 'design').length;
  const score = empire.eliminated ? -1000 : colonies * 20 + pop * 3 + empire.knownApps.length + warships * 5 + Math.floor(empire.bc / 50);
  return { score, colonies, pop, apps: empire.knownApps.length, warships, eliminated: empire.eliminated };
}

const savePath = (seat: number) => join(OUT_DIR, `moo2v2-async-${CAST[seat]!.name.toLowerCase()}-seat${seat}.moo2save`);

async function loadSeatEnvelopes(): Promise<Array<{ envelope: SaveEnvelope; seat: number }>> {
  const inputs: Array<{ envelope: SaveEnvelope; seat: number }> = [];
  for (let seat = 0; seat < PLAYERS.length; seat++) {
    const bytes = readFileSync(savePath(seat));
    inputs.push({ envelope: await decodeSaveFile(new Uint8Array(bytes)), seat });
  }
  return inputs;
}

/** hand-designed challenger doctrines, one new strategy per tuning round */
const VARIANTS: Array<{ label: string; tactic: ReconcileTactic; params: Partial<ReconcileBotParams> }> = [
  {
    label: 'decisive-mass (consolidated, lower win bar, earlier jumps)',
    tactic: 'consolidated',
    params: { winRatioNum: 9, winRatioDen: 8, assemblePct: 75, battlePersonality: 'militarist' },
  },
  {
    label: 'blitz-raiders (hybrid 50% main, early wars, fast retargeting)',
    tactic: 'hybrid',
    params: { hybridMainPct: 50, warParityPct: 70, targetLapse: 12, battlePersonality: 'rusher' },
  },
  {
    label: 'siege-respect (split, defenses priced high, only sure wins)',
    tactic: 'split',
    params: { baseWeight: 6, winRatioNum: 3, winRatioDen: 2, transportMargin: 4 },
  },
  {
    label: 'opportunist (3 groups early, patient sieges, core focus)',
    tactic: 'split',
    params: { splitThirdAt: 16, coreBonus: 100, targetLapse: 30, battlePersonality: 'militarist' },
  },
];

(RUN ? describe : describe.skip)('example saves + reconciliation tuning', () => {
  (PHASE === 'saves' ? it : it.skip)(
    `generates async continuations for seats ${SEATS.join(',')}`,
    async () => {
      mkdirSync(OUT_DIR, { recursive: true });
      const base = dayOne();
      // the shared day-one file everyone loads before playing their seat
      writeFileSync(join(OUT_DIR, 'moo2v2-async-day1-shared.moo2save'), await encodeSaveFile(base));
      for (const seat of SEATS) {
        const t0 = Date.now();
        const { log, final } = playTurns(base.commands as Cmd[], ASYNC_TURNS, (s) => (s === seat ? CAST[s]!.personality : 'balanced'), seat);
        const env = envelopeOf(base, log, seat, final);
        expect(verifySaveEnvelope(env).mode).toBe('replay');
        writeFileSync(savePath(seat), await encodeSaveFile(env));
        // eslint-disable-next-line no-console
        console.log(`seat ${seat} (${CAST[seat]!.name}) played to turn ${final.turn} in ${Math.round((Date.now() - t0) / 1000)}s — own score ${dev(final, seat).score}`);
      }
    },
    14_400_000,
  );

  (PHASE === 'recon' ? it : it.skip)(
    'reconciliation tuning rounds: each champion beat the last',
    async () => {
      mkdirSync(OUT_DIR, { recursive: true });
      const inputs = await loadSeatEnvelopes();
      const start = buildReconciliationStart(inputs);
      // determinism: any submission order produces the same start
      const shuffled = buildReconciliationStart([...inputs].reverse());
      expect(shuffled.seed).toBe(start.seed);
      expect(JSON.stringify(shuffled.payload)).toBe(JSON.stringify(start.payload));

      const lines: string[] = [];
      lines.push('# Reconciliation tuning lab (bugs.md #6)');
      lines.push('');
      lines.push(`Seed \`${SEED}\`, ${GALAXY} galaxy, 5 species, async +${ASYNC_TURNS} turns each, scoring at turn ${start.endTurn}, engine ${ENGINE_VERSION}.`);
      lines.push('');
      lines.push('Each round, one challenger seat runs a NEW doctrine parameter set against the');
      lines.push('reigning champion set (all other seats). A challenger that outscores the champion');
      lines.push('is adopted by everyone next round — every adopted set beat the last.');
      lines.push('');

      let champion: { label: string; tactic: ReconcileTactic; params: Partial<ReconcileBotParams> } = {
        label: 'shipped default (split, lab-measured)',
        tactic: 'split',
        params: {},
      };
      let lastResult: Awaited<ReturnType<typeof runReconciliation>> | null = null;

      for (let round = 0; round <= Math.min(ROUNDS, VARIANTS.length); round++) {
        const challengerSeat = round === 0 ? null : (round - 1) % PLAYERS.length;
        const variant = round === 0 ? null : VARIANTS[round - 1]!;
        const tactics: Record<number, ReconcileTactic> = {};
        const params: Record<number, Partial<ReconcileBotParams>> = {};
        for (const p of PLAYERS) {
          const spec = p.id === challengerSeat && variant ? variant : champion;
          tactics[p.id] = spec.tactic;
          params[p.id] = spec.params;
        }
        const t0 = Date.now();
        const result = await runReconciliation(start, undefined, { tactics, params });
        lastResult = result;
        const fin = result.finalState;
        const scores = PLAYERS.map((p) => ({ name: p.name, seat: p.id, ...dev(fin, p.id) })).sort((a, b) => b.score - a.score);
        const winnerName = fin.winner !== null ? (PLAYERS[fin.winner]?.name ?? String(fin.winner)) : 'none';
        lines.push(`## Round ${round}${variant ? ` — challenger seat ${challengerSeat} (${PLAYERS[challengerSeat!]!.name}): ${variant.label}` : ' — baseline (all seats on the shipped default)'}`);
        lines.push('');
        lines.push(`Ended turn ${fin.turn} in ${Math.round((Date.now() - t0) / 1000)}s — winner **${winnerName}** (${fin.winType ?? '—'}).`);
        lines.push('');
        lines.push('| seat | player | doctrine | score | colonies | pop | warships | eliminated |');
        lines.push('|---|---|---|---|---|---|---|---|');
        for (const s of scores) {
          const doctrine = s.seat === challengerSeat && variant ? `⚔ ${variant.label.split(' ')[0]}` : 'champion';
          lines.push(`| ${s.seat} | ${s.name} | ${doctrine} | ${s.score} | ${s.colonies} | ${s.pop} | ${s.warships} | ${s.eliminated ? 'yes' : ''} |`);
        }
        lines.push('');
        if (variant && challengerSeat !== null) {
          const challengerScore = scores.find((s) => s.seat === challengerSeat)!.score;
          const bestOtherScore = Math.max(...scores.filter((s) => s.seat !== challengerSeat).map((s) => s.score));
          const won = fin.winner === challengerSeat || challengerScore > bestOtherScore;
          lines.push(won ? `**Adopted**: the challenger beat the champion set (${challengerScore} vs best-other ${bestOtherScore}).` : `Rejected: the champion held (challenger ${challengerScore} vs best-other ${bestOtherScore}).`);
          lines.push('');
          if (won) champion = variant;
        }
      }
      lines.push(`## Final champion doctrine`);
      lines.push('');
      lines.push(`**${champion.label}** — tactic \`${champion.tactic}\`, overrides \`${JSON.stringify(champion.params)}\``);
      lines.push(`(defaults: \`${JSON.stringify(DEFAULT_RECONCILE_PARAMS)}\`)`);
      lines.push('');

      // ---- the automated reconciliation IS a replay (bugs.md follow-up) ----
      const envelope = lastResult!.envelope;
      const verified = verifySaveEnvelope(envelope); // refolds the whole log against the snapshot hash
      expect(verified.mode).toBe('replay');
      const replay = await buildReplay({ envelope, verified, players: envelope.players.map((p) => p.name), resumeTurns: [] });
      expect(replay.mode).toBe('replay');
      expect(replay.turns[0]).toBe(start.baseTurn);
      expect(replay.turns[replay.turns.length - 1]).toBe(lastResult!.finalState.turn);
      lines.push(`Replay check: the final run's envelope verifies in replay mode and rebuilds ${replay.turns.length} viewable turns (${start.baseTurn}→${lastResult!.finalState.turn}).`);
      writeFileSync(join(OUT_DIR, `moo2v2-reconciliation-turn${envelope.game.last_turn}.moo2save`), await encodeSaveFile(envelope));

      writeFileSync('bugs/reconcile-tuning.md', lines.join('\n'));
      writeFileSync(
        join(OUT_DIR, 'README.md'),
        [
          '# moo2v2 example saves',
          '',
          `A five-player day-one ASYNC game (seed \`${SEED}\`, ${GALAXY} galaxy, engine ${ENGINE_VERSION}):`,
          'five species each played their own solo continuation of the same shared save.',
          '',
          '| file | what it is |',
          '|---|---|',
          '| `moo2v2-async-day1-shared.moo2save` | the shared day-one save everyone loaded |',
          ...CAST.map((c, i) => `| \`moo2v2-async-${c.name.toLowerCase()}-seat${i}.moo2save\` | ${c.name} (${c.preset}, ${c.personality}) played seat ${i} for ${ASYNC_TURNS} turns |`),
          '| `moo2v2-reconciliation-turn*.moo2save` | the merged "what really happened" timeline (final tuned run) — 🎞 watch it as a replay |',
          '| `moo2v2-reconciliation-live-turn*.moo2save` | the LIVE kickoff: load it and fly the fleets yourself |',
          '',
          'To reconcile in the app: Home → ⚖ Reconciliation → add the five seat saves →',
          '▶ run (automatic) or 🧑‍🚀 live kickoff (interactive). To play a seat solo:',
          'load the shared day-one save → ⏳ Play async. Tuning notes: `bugs/reconcile-tuning.md`.',
        ].join('\n'),
      );
      // eslint-disable-next-line no-console
      console.log(lines.join('\n'));
    },
    14_400_000,
  );

  (PHASE === 'live' ? it : it.skip)(
    'interactive (live) reconciliation kickoff is playable',
    async () => {
      mkdirSync(OUT_DIR, { recursive: true });
      const inputs = await loadSeatEnvelopes();
      const start = buildReconciliationStart(inputs);
      const kickoff = buildReconciliationKickoff(start);
      expect(verifySaveEnvelope(kickoff).mode).toBe('replay');
      writeFileSync(join(OUT_DIR, `moo2v2-reconciliation-live-turn${kickoff.game.last_turn}.moo2save`), await encodeSaveFile(kickoff));

      // ---- headless "human at seat 0" session: the exact ⏳ Play async flow ----
      const engine = createGameEngine();
      const payload = JSON.parse(kickoff.commands[0]!.payload) as unknown;
      let state = engine.init(payload as never) as GameState;
      engine.takeEvents();
      expect(state.reconcile).toBeDefined();
      expect(state.phase).toBe('planning');
      // the live clocks ride the kickoff settings (a protocol-level field the
      // engine's own settings type does not declare)
      expect((state.settings as { realtimeTurnSeconds?: number }).realtimeTurnSeconds ?? 0).toBeGreaterThan(0);

      const apply = (playerId: number, kind: string, payload2: unknown): string | null => {
        const cmd = { turn: state.turn, playerId, kind, payload: payload2 };
        if (playerId >= 0) {
          const err = validateCommand(state, cmd as never);
          if (err) return err;
        }
        state = engine.apply(state, cmd as never) as GameState;
        engine.takeEvents();
        return null;
      };

      // the colony/research screens are locked to the script — enforced at the
      // ENGINE, so no UI path (map quick-build, governor, hotkeys) can leak
      const myColony = state.colonies.find((c) => c.owner === 0 && !c.outpost);
      expect(myColony).toBeDefined();
      expect(apply(0, 'set_build_queue', { colonyId: myColony!.id, items: ['housing'] })).toMatch(/recorded script/);
      expect(apply(0, 'buy_production', { colonyId: myColony!.id })).toMatch(/recorded script/);
      expect(apply(0, 'set_research', { fieldNum: 1, targetApp: null })).toMatch(/recorded script/);
      expect(apply(0, 'colonize', { shipId: 1, planetId: 1 })).toMatch(/recorded script/);

      // ...but the WAR game is open: play 30 turns, human-ish moves at seat 0,
      // reconcile stand-ins at seats 1-4, battles ordered and resolved
      const memories = new Map(state.empires.map((e) => [e.id, freshReconcileMemory()]));
      let humanMoves = 0;
      let battles = 0;
      const startTurn = state.turn;
      for (let t = 0; t < 30 && state.winner === null; t++) {
        // "human": issue a plain move order with whatever is in port — scouts
        // at the base turn, script-spawned warships later
        const mine = state.ships.filter((s) => s.owner === 0 && s.location.kind === 'star');
        if (mine.length) {
          const from = (mine[0]!.location as { starId: number }).starId;
          const opt = selectors.moveOptions(state, 0, from).filter((o) => o.reachable && o.starId !== from)[0];
          if (opt && apply(0, 'move_ships', { shipIds: [mine[0]!.id], destStarId: opt.starId }) === null) humanMoves++;
        }
        for (const empire of state.empires.filter((e) => e.id > 0 && !e.eliminated)) {
          const me = empire.id;
          const session = {
            submit: (kind: string, payload2: unknown) => {
              const err = apply(me, kind, payload2);
              return err ? { error: err } : {};
            },
          } as unknown as GameSession<GameState>;
          reconcileBotTurn({ session, state, me, tactic: 'split', memory: memories.get(me)! });
        }
        expect(apply(-1, 'advance_turn', { fromTurn: state.turn })).toBeNull();
        if (state.phase === 'battle_orders') {
          battles += state.pendingBattles.length;
          for (const battle of state.pendingBattles) {
            for (const side of [battle.attacker, battle.defender]) {
              if (side < 0) continue;
              const filled = side === battle.attacker ? battle.ordersA : battle.ordersD;
              if (filled) continue;
              apply(side, 'battle_orders', { battleId: battle.id, orders: onionBattleOrders(state, side, battle, 'balanced') });
            }
          }
          expect(apply(-1, 'resolve_combat', {})).toBeNull();
        }
      }
      expect(state.turn).toBeGreaterThan(startTurn); // the clock actually ran
      expect(humanMoves).toBeGreaterThan(0); // the human's orders were accepted
      // eslint-disable-next-line no-console
      console.log(`live kickoff playable: ${state.turn - startTurn} turns, ${humanMoves} human move orders, ${battles} battles, scripts ${state.reconcile!.schedules.length}, endTurn ${state.reconcile!.endTurn}`);
    },
    3_600_000,
  );
});
