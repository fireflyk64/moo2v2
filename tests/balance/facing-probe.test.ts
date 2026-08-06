// FACING PROBE (the "tumbling leaves" report, 2026-08-05): does the battle
// LOOK like a fight? Replays showed ships pointing anywhere but at the enemy
// and spinning as they chased their choreography. This probe runs tactics
// battles across doctrine matchups (plus a screenshot-shaped 11-vs-2-with-a-
// base assault) and reduces each side to three readability numbers:
//
//   faceOn%    ship-ticks with the bow within ±45° of the nearest enemy
//   faceAway%  ship-ticks pointed MORE than 135° off — visibly fleeing/backward
//   churn      mean |heading change| per ship-tick, in 11.25° steps — the
//              tumble metric (a smooth arc turns rarely; a leaf turns always)
//
// Diagnostic only, nothing asserted beyond "battles ran":
//   MOO2_FACING=1 npx vitest run tests/balance/facing-probe.test.ts
import { describe, expect, it } from 'vitest';
import { DEFAULT_ORDERS, headingDelta, headingToward, runBattle, type BattleInput, type BattleTickFrame, type CombatShipInit } from '@engine/index';
import { rngFor } from '@engine/rng';
import { ARCHETYPE_BY_ID } from './lib/spacefleets';
import { buildInput, type SimDoctrine } from './lib/spacesim';

const enabled = process.env['MOO2_FACING'] === '1';
const SEED = 'c0ffee00c0ffee00c0ffee00c0ffee00';

interface FacingStats {
  n: number;
  faceOn: number;
  faceAway: number;
  churnSum: number;
  churnN: number;
}
const empty = (): FacingStats => ({ n: 0, faceOn: 0, faceAway: 0, churnSum: 0, churnN: 0 });

function measure(input: BattleInput): [FacingStats, FacingStats, number] {
  const frames: BattleTickFrame[] = [];
  const result = runBattle(input, rngFor(SEED, ...input.seedLabel), (f) => frames.push(structuredClone(f)));
  const side = new Map(input.ships.map((s) => [s.shipId, s.side]));
  const mobile = new Map(input.ships.map((s) => [s.shipId, !s.isBase && s.speed > 0]));
  const stats: [FacingStats, FacingStats] = [empty(), empty()];
  const prevH = new Map<number, number>();
  for (const f of frames) {
    const active = f.ships.filter((s) => s.alive && !s.retreated && !s.crossed);
    for (const s of active) {
      if (!mobile.get(s.id)) continue;
      const mySide = side.get(s.id)!;
      let best = -1;
      let bx = 0;
      let by = 0;
      for (const e of active) {
        if (side.get(e.id) === mySide) continue;
        const d = (e.x - s.x) * (e.x - s.x) + (e.y - s.y) * (e.y - s.y);
        if (best < 0 || d < best) {
          best = d;
          bx = e.x;
          by = e.y;
        }
      }
      if (best < 0) continue;
      const st = stats[mySide]!;
      const off = Math.abs(headingDelta(s.h, headingToward(bx - s.x, by - s.y)));
      st.n++;
      if (off <= 4) st.faceOn++;
      if (off >= 12) st.faceAway++;
      const ph = prevH.get(s.id);
      if (ph !== undefined) {
        st.churnSum += Math.abs(headingDelta(ph, s.h));
        st.churnN++;
      }
      prevH.set(s.id, s.h);
    }
  }
  return [stats[0], stats[1], result.ticks];
}

const fmt = (st: FacingStats) =>
  st.n === 0
    ? '(no ship-ticks)'
    : `faceOn ${((100 * st.faceOn) / st.n).toFixed(0)}%  faceAway ${((100 * st.faceAway) / st.n).toFixed(0)}%  churn ${(st.churnSum / Math.max(1, st.churnN)).toFixed(2)}`;

/** the screenshot battle: 11 attacking beam frigates vs 2 defenders (one a
 * star base) — the assault-on-a-colony shape where the report came from */
function assaultInput(): BattleInput {
  const ship = (shipId: number, side: 0 | 1, opts?: Partial<CombatShipInit>): CombatShipInit => ({
    shipId,
    side,
    hull: 'frigate',
    hullIdx: 1,
    isBase: false,
    beamAttack: 30,
    beamDefense: 25,
    speed: 7,
    armorHp: 25,
    structureHp: 50,
    shieldPool: 20,
    shieldFlat: 1,
    weapons: [{ weaponId: 'laser_cannon', classId: 0, dmgMin: 2, dmgMax: 5, mods: [], ammo: -1, cooldown: 2, count: 3 }],
    startingStructure: 50,
    startingArmor: 25,
    ...(opts ?? {}),
  });
  const ships: CombatShipInit[] = [];
  for (let i = 0; i < 11; i++) ships.push(ship(100 + i, 0));
  ships.push(ship(200, 1, { hull: 'destroyer', hullIdx: 2, speed: 6, structureHp: 90, startingStructure: 90 }));
  ships.push(
    ship(201, 1, {
      hull: 'star_base',
      hullIdx: 7,
      isBase: true,
      speed: 0,
      structureHp: 200,
      startingStructure: 200,
      weapons: [{ weaponId: 'laser_cannon', classId: 0, dmgMin: 2, dmgMax: 5, mods: [], ammo: -1, cooldown: 2, count: 5, arc: '360' }],
    }),
  );
  return {
    battleId: 'facing-assault',
    seedLabel: ['facing', 'assault'],
    attacker: 0,
    defender: 1,
    ships,
    ordersA: { ...DEFAULT_ORDERS, retreatThresholdPct: 0, stance: 'charge', formation: 'envelop' },
    ordersD: { ...DEFAULT_ORDERS, retreatThresholdPct: 0 },
    patterns: true,
    tactics: true,
  };
}

describe.skipIf(!enabled)('facing probe (MOO2_FACING=1)', () => {
  it('measures bow-on-enemy time across doctrine matchups', () => {
    const beam = ARCHETYPE_BY_ID.get('beam_skirmisher')!;
    const rows: string[] = [];
    const [as, ds, ticks] = measure(assaultInput());
    rows.push(`assault 11v2+base (A envelop / D charge, ${ticks}t)  A: ${fmt(as)}   D: ${fmt(ds)}`);
    const docs: SimDoctrine[] = ['charge', 'line', 'standoff', 'flank', 'pincer', 'envelop'];
    for (const docA of docs) {
      for (const docD of ['charge', 'line'] as SimDoctrine[]) {
        const input = buildInput(beam, docA, beam, docD, 0, { tactics: true });
        const [a, d, t] = measure(input);
        rows.push(`${docA.padEnd(8)} vs ${docD.padEnd(6)} (${String(t).padStart(3)}t)  A: ${fmt(a)}   D: ${fmt(d)}`);
      }
    }
    // eslint-disable-next-line no-console
    console.log(`\n${rows.join('\n')}\n`);
    expect(rows.length).toBeGreaterThan(0);
  });
});
