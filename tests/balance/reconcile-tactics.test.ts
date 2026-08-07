// Reconciliation tactics lab (complextask.md): the SAME economy script, bot
// tactics varied — consolidated fleet vs 2-3 strike groups vs the hybrid.
// Every matchup runs both seatings (map position is not symmetric); mirrors
// are the control rows. Findings land in bugs/reconcile-tactics.md.
//
// Opt-in like the other balance harnesses:
//   MOO2_BALANCE=1 MOO2_RECONTAC=1 npx vitest run tests/balance/reconcile-tactics.test.ts

import { writeFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { gameEngine } from '@engine/index';
import { canonicalStringify } from '@engine/canonical';
import { DATA_VERSION } from '@engine/data/index';
import type { GameState, ReconcileSchedule } from '@engine/types';
import type { ReconcileStart } from '@storage/reconcile';
import { runReconciliation } from '@ui/reconcileRun';
import type { ReconcileTactic } from '@ui/reconcileBot';

const RUN = process.env.MOO2_RECONTAC === '1';
const SEED = process.env.RECONTAC_SEED ?? 'fedcba9876543210fedcba9876543210';
const END_TURN = Number(process.env.RECONTAC_END ?? 60);

const PLAYERS = [
  { id: 0, name: 'Alpha', raceJson: JSON.stringify({ presetId: 'solari' }) },
  { id: 1, name: 'Beta', raceJson: JSON.stringify({ presetId: 'solari' }) },
];

/** one fixed economy: identical scripts for both seats — frigate waves, a
 * destroyer squadron, missile bases on the homes, marine lifts, steady pop,
 * and TWO scripted frontier colonies each (soft targets: expansion is what
 * makes fleet tactics matter — a lone turtled home is a mutual standoff) */
function economyFor(state: GameState, empireId: number): ReconcileSchedule {
  const home = state.colonies.find((c) => c.owner === empireId)!;
  const homePlanet = state.planets.find((p) => p.id === home.planetId)!;
  const homeStar = state.stars.find((st) => st.id === homePlanet.starId)!;
  const dist2 = (a: { x: number; y: number }, b: { x: number; y: number }) => (a.x - b.x) ** 2 + (a.y - b.y) ** 2;
  const frontier = state.planets
    .filter(
      (pl) =>
        pl.body === 'planet' &&
        !state.colonies.some((c) => c.planetId === pl.id) &&
        !state.monsters.some((m) => m.starId === pl.starId),
    )
    .sort((a, b) => {
      const sa = state.stars.find((st) => st.id === a.starId)!;
      const sb = state.stars.find((st) => st.id === b.starId)!;
      return dist2(sa, homeStar) - dist2(sb, homeStar) || a.id - b.id;
    })
    // seat 1 claims from its own end of the list to keep the two scripts
    // from colliding on the same worlds
    .slice(0, 24)
    .filter((_, i) => i % 2 === empireId)
    .slice(0, 2);
  const sched: ReconcileSchedule = {
    empireId,
    research: [],
    fields: [],
    ships: [],
    colonize: [],
    pop: [],
    buildings: [],
    marines: [],
    spies: [],
  };
  for (let t = 3; t <= 25; t += 2) sched.ships.push({ turn: t, starId: homePlanet.starId, kind: 'design:frigate' });
  for (let t = 12; t <= 24; t += 4) sched.ships.push({ turn: t, starId: homePlanet.starId, kind: 'design:destroyer' });
  sched.buildings.push({ turn: 8, planetId: home.planetId, building: 'missile_base' });
  for (let t = 6; t <= 42; t += 6) sched.pop.push({ turn: t, planetId: home.planetId, units: 1 });
  frontier.forEach((pl, i) => {
    const founded = 4 + i * 4;
    sched.colonize.push({ turn: founded, planetId: pl.id, units: 2 });
    for (let t = founded + 4; t <= 48; t += 4) sched.pop.push({ turn: t, planetId: pl.id, units: 1 });
  });
  sched.colonize.sort((a, b) => a.turn - b.turn);
  sched.pop.sort((a, b) => a.turn - b.turn || a.planetId - b.planetId);
  for (const t of [19, 23, 27]) sched.marines.push({ turn: t, planetId: home.planetId, count: 4 });
  for (const t of [20, 24, 28]) sched.ships.push({ turn: t, starId: homePlanet.starId, kind: 'transport' });
  sched.ships.sort((a, b) => a.turn - b.turn);
  return sched;
}

function startFor(): ReconcileStart {
  const settings = {
    galaxySize: 'small',
    startMode: 'average',
    playerCount: 2,
    modes: { creativeVariant: false, pickBidding: false, stickyBuild: false, antarans: false, randomEvents: false },
    battleOrdersTimeoutMs: 1000,
    debugCommands: false,
  } as GameState['settings'];
  const base = gameEngine.init({ seed: SEED, settings, players: PLAYERS, dataVersion: DATA_VERSION });
  const withScripts: GameState = {
    ...base,
    reconcile: {
      schedules: [economyFor(base, 0), economyFor(base, 1)],
      usedClaims: [],
      endTurn: END_TURN,
    },
  };
  const payload = {
    seed: SEED,
    settings,
    players: PLAYERS,
    dataVersion: DATA_VERSION,
    resumeState: gameEngine.serialize(withScripts),
  };
  void canonicalStringify; // (payload is stringified inside the runner)
  return {
    payload: payload as unknown as Record<string, unknown>,
    seed: SEED,
    baseTurn: withScripts.turn,
    players: PLAYERS,
    settings,
    lastScheduledTurn: 42,
    endTurn: END_TURN,
    warnings: [],
  };
}

interface Row {
  a: ReconcileTactic;
  b: ReconcileTactic;
  winner: number | null;
  winType: string | null;
  turn: number;
  colonies: [number, number];
  pop: [number, number];
  warships: [number, number];
  eliminated: [boolean, boolean];
}

function statsOf(state: GameState, id: number): { colonies: number; pop: number; warships: number; eliminated: boolean } {
  return {
    colonies: state.colonies.filter((c) => c.owner === id && !c.outpost).length,
    pop: state.colonies.filter((c) => c.owner === id).reduce((n, c) => n + c.groups.reduce((m, g) => m + Math.floor(g.popK / 1000), 0), 0),
    warships: state.ships.filter((s) => s.owner === id && s.shipKind === 'design').length,
    eliminated: state.empires.find((e) => e.id === id)?.eliminated ?? false,
  };
}

(RUN ? describe : describe.skip)('reconciliation tactics lab', () => {
  it(
    'same economy, tactics varied — who converts a fixed script best?',
    async () => {
      const TACTICS: ReconcileTactic[] = ['consolidated', 'split', 'hybrid'];
      const matchups: Array<[ReconcileTactic, ReconcileTactic]> = [];
      for (const a of TACTICS) for (const b of TACTICS) matchups.push([a, b]);

      const rows: Row[] = [];
      for (const [a, b] of matchups) {
        const start = startFor();
        const { finalState } = await runReconciliation(start, undefined, { tactics: { 0: a, 1: b } });
        const s0 = statsOf(finalState, 0);
        const s1 = statsOf(finalState, 1);
        rows.push({
          a,
          b,
          winner: finalState.winner,
          winType: finalState.winType,
          turn: finalState.turn,
          colonies: [s0.colonies, s1.colonies],
          pop: [s0.pop, s1.pop],
          warships: [s0.warships, s1.warships],
          eliminated: [s0.eliminated, s1.eliminated],
        });
        expect(finalState.winner).not.toBeNull(); // scored at worst
      }

      // two leaderboards: election wins (pop-scored — dominated by the script
      // on an asymmetric map) and the MILITARY differential (surviving hulls
      // minus the opponent's, both seatings — the fair read on tactics)
      const points = new Map<ReconcileTactic, number>(TACTICS.map((t) => [t, 0]));
      const military = new Map<ReconcileTactic, number>(TACTICS.map((t) => [t, 0]));
      const flips = new Map<ReconcileTactic, number>(TACTICS.map((t) => [t, 0]));
      for (const r of rows) {
        if (r.winner === 0) points.set(r.a, (points.get(r.a) ?? 0) + 1);
        if (r.winner === 1) points.set(r.b, (points.get(r.b) ?? 0) + 1);
        military.set(r.a, (military.get(r.a) ?? 0) + (r.warships[0] - r.warships[1]));
        military.set(r.b, (military.get(r.b) ?? 0) + (r.warships[1] - r.warships[0]));
        flips.set(r.a, (flips.get(r.a) ?? 0) + (r.colonies[0] - 3));
        flips.set(r.b, (flips.get(r.b) ?? 0) + (r.colonies[1] - 3));
      }

      const lines: string[] = [];
      lines.push('# Reconciliation tactics lab');
      lines.push('');
      lines.push(`Seed \`${SEED}\`, small map, identical scripts both seats (12 frigates + 4 destroyers`);
      lines.push(`by t25, missile base t8, 3 marine transports, +1 pop/6t), scoring at turn ${END_TURN}.`);
      lines.push('Every cell is one full bot-run; seat position is part of the matchup (the map is not mirrored).');
      lines.push('');
      lines.push('| seat0 \\\\ seat1 | winner | type | turn | colonies | pop | warships | eliminated |');
      lines.push('|---|---|---|---|---|---|---|---|');
      for (const r of rows) {
        const w = r.winner === null ? '—' : r.winner === 0 ? `${r.a} (seat0)` : `${r.b} (seat1)`;
        lines.push(
          `| ${r.a} vs ${r.b} | ${w} | ${r.winType} | ${r.turn} | ${r.colonies.join(' / ')} | ${r.pop.join(' / ')} | ${r.warships.join(' / ')} | ${r.eliminated.map((e) => (e ? 'yes' : '-')).join(' / ')} |`,
        );
      }
      lines.push('');
      lines.push('## Election wins (pop-scored; the asymmetric map biases these to seat 1)');
      lines.push('');
      for (const [t, p] of [...points.entries()].sort((x, y) => y[1] - x[1])) lines.push(`- **${t}**: ${p}`);
      lines.push('');
      lines.push('## Military differential (surviving hulls − opponent, both seatings)');
      lines.push('');
      for (const [t, p] of [...military.entries()].sort((x, y) => y[1] - x[1])) lines.push(`- **${t}**: ${p >= 0 ? '+' : ''}${p}`);
      lines.push('');
      lines.push('## Colony delta vs the scripted 3 (conquests minus losses)');
      lines.push('');
      for (const [t, p] of [...flips.entries()].sort((x, y) => y[1] - x[1])) lines.push(`- **${t}**: ${p >= 0 ? '+' : ''}${p}`);
      lines.push('');
      writeFileSync('bugs/reconcile-tactics.md', lines.join('\n'));
    },
    1_800_000,
  );
});
