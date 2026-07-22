// Space-tactics Monte Carlo harness (bugs.md round 9).
//
// Fights fleet ARCHETYPES (spacefleets.ts) against each other under every
// DOCTRINE pair, many seeds deep, and reduces the results to the four numbers
// that tell us whether tactics matter:
//
//   edge      material advantage of the chooser (foe damage% - own damage%)
//   winPct    outright wins
//   leverage  how much the DOCTRINE CHOICE moves the result inside one
//             fixed matchup (max edge - min edge over own doctrines).
//             leverage ~ 0 means the tactic picker is decoration.
//   dominance spread of mean edge across doctrines. One doctrine far above
//             the rest means there is a single right answer — also a failure.
//
// Pure harness: no engine changes live here, and nothing is asserted. The
// test files that import it decide what to print and what to gate on.
import { DEFAULT_ORDERS, runBattle, type BattleInput, type BattleOrders, type BattleResult } from '@engine/index';
import { rngFor } from '@engine/rng';
import { ARCHETYPE_BY_ID, type Archetype, type ArchetypeOpts } from './spacefleets';

/** every doctrine a player can pick. 'standoff' resolves to 'line' on engines
 * before the 0.26 tactics rework — the sim reports it either way, which is
 * exactly how we detect that the two are not yet distinct. */
export const DOCTRINES = ['charge', 'line', 'standoff', 'flank', 'pincer', 'envelop'] as const;
export type SimDoctrine = (typeof DOCTRINES)[number];

/** Battle orders that express one doctrine. Formation carries the doctrine
 * where the engine understands it; stance carries the rest (and stays
 * meaningful on older engines, where standoff/hold_range collapse to line). */
export function ordersFor(doc: SimDoctrine, retreatPct: number, tacticsEngine: boolean): BattleOrders {
  const base: BattleOrders = { ...DEFAULT_ORDERS, retreatThresholdPct: retreatPct, priority: 'nearest' };
  switch (doc) {
    case 'charge':
      return { ...base, stance: 'charge' };
    case 'line':
      return { ...base, stance: 'hold_range', formation: 'line' };
    case 'standoff':
      // pre-rework engines have no 'standoff' formation: the stance is the
      // only handle, and it collapses to the line doctrine.
      return tacticsEngine
        ? { ...base, stance: 'standoff', formation: 'standoff' as BattleOrders['formation'] }
        : { ...base, stance: 'standoff' };
    default:
      return { ...base, stance: 'charge', formation: doc };
  }
}

export interface MatchOpts {
  retreatPct?: number;
  slewing?: boolean;
  /** stamp BattleInput.tactics (the 0.26 doctrine engine) */
  tactics?: boolean;
  /** per-side archetype tweaks (drive sweeps) */
  optsA?: ArchetypeOpts;
  optsD?: ArchetypeOpts;
}

const SEED = 'c0ffee00c0ffee00c0ffee00c0ffee00';

export function buildInput(
  a: Archetype,
  docA: SimDoctrine,
  d: Archetype,
  docD: SimDoctrine,
  trial: number,
  o: MatchOpts = {},
): BattleInput {
  const retreat = o.retreatPct ?? 0;
  const tactics = o.tactics === true;
  const battleId = `${a.id}:${docA}/${d.id}:${docD}#${trial}`;
  return {
    battleId,
    seedLabel: ['spacesim', battleId],
    attacker: 0,
    defender: 1,
    ships: [...a.build(0, o.optsA), ...d.build(1, o.optsD)],
    ordersA: ordersFor(docA, retreat, tactics),
    ordersD: ordersFor(docD, retreat, tactics),
    patterns: true,
    ...(o.slewing ? { slewing: true } : {}),
    ...(tactics ? { tactics: true } : {}),
  };
}

export interface MatchOutcome {
  /** material edge for side A: defenderDamagePct - attackerDamagePct */
  edge: number;
  /** 1 A won, 0 D won, 0.5 stalemate */
  win: number;
  ticks: number;
  result: BattleResult;
}

export function fight(
  a: Archetype,
  docA: SimDoctrine,
  d: Archetype,
  docD: SimDoctrine,
  trial: number,
  o: MatchOpts = {},
): MatchOutcome {
  const input = buildInput(a, docA, d, docD, trial, o);
  const result = runBattle(input, rngFor(SEED, ...input.seedLabel));
  return {
    edge: result.defenderDamagePct - result.attackerDamagePct,
    win: result.winner === 0 ? 1 : result.winner === 1 ? 0 : 0.5,
    ticks: result.ticks,
    result,
  };
}

/** Where a side's shots actually land: the diagnostic that explains WHY a
 * doctrine suits a weapon system. Distances are field units (not fixed point)
 * measured between shooter and target at the tick the shot was resolved. */
export interface FireProfile {
  shots: number;
  hits: number;
  dmg: number;
  /** shots per range band: 0 short (<=96u), 1 medium (<=224u), 2 long (<=448u), 3 beyond */
  band: [number, number, number, number];
  /** shots by weapon class: beams(0) missiles(1) torpedoes(2) strike craft(4) */
  byClass: Map<number, number>;
  distSum: number;
  /** point-defense intercepts credited to this side */
  intercepts: number;
  /** mean per-tick displacement of this side's live ships, field units — the
   * motion-evasion pool made visible (0 = standing still and easy to hit) */
  moveSum: number;
  moveN: number;
}

const emptyProfile = (): FireProfile => ({
  shots: 0,
  hits: 0,
  dmg: 0,
  band: [0, 0, 0, 0],
  byClass: new Map(),
  distSum: 0,
  intercepts: 0,
  moveSum: 0,
  moveN: 0,
});

const bandIdx = (u: number): 0 | 1 | 2 | 3 => (u <= 96 ? 0 : u <= 224 ? 1 : u <= 448 ? 2 : 3);

/** Same fight, with per-side firing forensics collected from the frames. */
export function fightProfiled(
  a: Archetype,
  docA: SimDoctrine,
  d: Archetype,
  docD: SimDoctrine,
  trial: number,
  o: MatchOpts = {},
): { outcome: MatchOutcome; profiles: [FireProfile, FireProfile]; meanSep: number } {
  const input = buildInput(a, docA, d, docD, trial, o);
  const sideOf = new Map<number, 0 | 1>(input.ships.map((s) => [s.shipId, s.side]));
  const profiles: [FireProfile, FireProfile] = [emptyProfile(), emptyProfile()];
  let sepSum = 0;
  let sepN = 0;
  let prev: Map<number, { x: number; y: number }> | null = null;
  const result = runBattle(input, rngFor(SEED, ...input.seedLabel), (f) => {
    const pos = new Map(f.ships.map((s) => [s.id, s]));
    // how far each live ship actually travelled since the last tick
    if (prev) {
      for (const s of f.ships) {
        if (!s.alive || s.retreated) continue;
        const p = prev.get(s.id);
        const side = sideOf.get(s.id);
        if (!p || side === undefined) continue;
        const pr = profiles[side]!;
        pr.moveSum += Math.hypot(s.x - p.x, s.y - p.y) / 256;
        pr.moveN++;
      }
    }
    prev = new Map(f.ships.map((s) => [s.id, { x: s.x, y: s.y }]));
    // fleet separation: distance between the two live centroids
    let n0 = 0;
    let n1 = 0;
    let x0 = 0;
    let y0 = 0;
    let x1 = 0;
    let y1 = 0;
    for (const s of f.ships) {
      if (!s.alive || s.retreated) continue;
      if (sideOf.get(s.id) === 0) { n0++; x0 += s.x; y0 += s.y; } else { n1++; x1 += s.x; y1 += s.y; }
    }
    if (n0 > 0 && n1 > 0) {
      sepSum += Math.hypot(x0 / n0 - x1 / n1, y0 / n0 - y1 / n1) / 256;
      sepN++;
    }
    for (const shot of f.shots) {
      const side = sideOf.get(shot.from);
      if (side === undefined) continue;
      const p = profiles[side]!;
      if (shot.to === -1) {
        p.intercepts++;
        continue;
      }
      const from = pos.get(shot.from);
      const to = pos.get(shot.to);
      p.shots++;
      p.byClass.set(shot.classId, (p.byClass.get(shot.classId) ?? 0) + 1);
      if (shot.hit) {
        p.hits++;
        p.dmg += shot.dmg;
      }
      if (from && to) {
        const u = Math.hypot(to.x - from.x, to.y - from.y) / 256;
        p.distSum += u;
        p.band[bandIdx(u)]++;
      }
    }
  });
  return {
    outcome: {
      edge: result.defenderDamagePct - result.attackerDamagePct,
      win: result.winner === 0 ? 1 : result.winner === 1 ? 0 : 0.5,
      ticks: result.ticks,
      result,
    },
    profiles,
    meanSep: sepN ? sepSum / sepN : 0,
  };
}

export interface Cell {
  n: number;
  edge: number;
  wins: number;
  ticks: number;
}

export const emptyCell = (): Cell => ({ n: 0, edge: 0, wins: 0, ticks: 0 });
export const addCell = (c: Cell, edge: number, win: number, ticks: number): void => {
  c.n++;
  c.edge += edge;
  c.wins += win;
  c.ticks += ticks;
};
export const meanEdge = (c: Cell): number => (c.n ? c.edge / c.n : 0);
export const winPct = (c: Cell): number => (c.n ? (100 * c.wins) / c.n : 0);
export const meanTicks = (c: Cell): number => (c.n ? c.ticks / c.n : 0);

/**
 * Fight one archetype pair over every doctrine pair, BOTH ORIENTATIONS
 * (each archetype takes a turn as the attacker, which is the side that
 * deploys on the left), so deployment bias cancels.
 *
 * Returns cells[ownDoc][foeDoc] holding the edge from the perspective of
 * archetype `a`, whichever side it was deployed on.
 */
export function matchupSweep(
  aId: string,
  bId: string,
  trials: number,
  o: MatchOpts = {},
): Map<SimDoctrine, Map<SimDoctrine, Cell>> {
  const a = ARCHETYPE_BY_ID.get(aId)!;
  const b = ARCHETYPE_BY_ID.get(bId)!;
  const cells = new Map<SimDoctrine, Map<SimDoctrine, Cell>>();
  for (const da of DOCTRINES) {
    const row = new Map<SimDoctrine, Cell>();
    cells.set(da, row);
    for (const db of DOCTRINES) row.set(db, emptyCell());
  }
  for (const da of DOCTRINES) {
    for (const db of DOCTRINES) {
      const cell = cells.get(da)!.get(db)!;
      for (let t = 0; t < trials; t++) {
        // a as attacker
        const f1 = fight(a, da, b, db, t, o);
        addCell(cell, f1.edge, f1.win, f1.ticks);
        // a as defender (swap the per-side archetype opts too)
        const swapped: MatchOpts = { ...o, optsA: o.optsD, optsD: o.optsA };
        const f2 = fight(b, db, a, da, t, swapped);
        addCell(cell, -f2.edge, 1 - f2.win, f2.ticks);
      }
    }
  }
  return cells;
}

/** best doctrine for `a` in this matchup assuming the foe plays its own best
 * reply (maximin): the tactic that is hardest to punish. */
export function maximin(cells: Map<SimDoctrine, Map<SimDoctrine, Cell>>): { doc: SimDoctrine; worst: number } {
  let best: { doc: SimDoctrine; worst: number } = { doc: DOCTRINES[0], worst: -Infinity };
  for (const da of DOCTRINES) {
    let worst = Infinity;
    for (const db of DOCTRINES) worst = Math.min(worst, meanEdge(cells.get(da)!.get(db)!));
    if (worst > best.worst) best = { doc: da, worst };
  }
  return best;
}

/** how much the doctrine choice moves the result: the spread of a doctrine's
 * mean edge (averaged over foe replies) inside one matchup */
export function leverage(cells: Map<SimDoctrine, Map<SimDoctrine, Cell>>): number {
  const means = DOCTRINES.map((da) => {
    let sum = 0;
    for (const db of DOCTRINES) sum += meanEdge(cells.get(da)!.get(db)!);
    return sum / DOCTRINES.length;
  });
  return Math.max(...means) - Math.min(...means);
}

/** mean edge per own-doctrine (averaged over the foe's replies) */
export function doctrineMeans(cells: Map<SimDoctrine, Map<SimDoctrine, Cell>>): Map<SimDoctrine, number> {
  const out = new Map<SimDoctrine, number>();
  for (const da of DOCTRINES) {
    let sum = 0;
    for (const db of DOCTRINES) sum += meanEdge(cells.get(da)!.get(db)!);
    out.set(da, sum / DOCTRINES.length);
  }
  return out;
}

// ---- reporting helpers ---------------------------------------------------

export const pad = (s: string, w: number): string => (s.length >= w ? s.slice(0, w) : s + ' '.repeat(w - s.length));
export const padL = (s: string, w: number): string => (s.length >= w ? s.slice(0, w) : ' '.repeat(w - s.length) + s);
export const num = (v: number, w = 6, dp = 1): string => padL(v.toFixed(dp), w);

/** doctrine x doctrine table of mean edge (rows = the chooser's doctrine) */
export function edgeTable(cells: Map<SimDoctrine, Map<SimDoctrine, Cell>>, title: string): string {
  const lines: string[] = [title];
  lines.push(pad('own \\ foe', 12) + DOCTRINES.map((d) => padL(d.slice(0, 8), 9)).join(''));
  for (const da of DOCTRINES) {
    const row = DOCTRINES.map((db) => num(meanEdge(cells.get(da)!.get(db)!), 9));
    lines.push(pad(da, 12) + row.join(''));
  }
  return lines.join('\n');
}
