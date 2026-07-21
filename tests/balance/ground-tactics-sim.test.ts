// Ground-tactics simulator (bugs.md round 8): sweeps the REAL invasion math —
// generateTerrain + groundModifiers + fightGroundRounds — over climates, maps,
// tactic pairs and defender compositions, at CLOSE odds (equal counts), and
// prints capture-rate tables. The question it answers: do tactic choices and
// terrain actually change outcomes when the fight is close, and does the best
// doctrine depend on whether the defense is civilian militia or trained
// garrison? Run:
//   MOO2_GROUND=1 npx vitest run tests/balance/ground-tactics-sim.test.ts
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  ATTACK_TACTICS,
  DEFENSE_TACTICS,
  fightGroundRounds,
  generateTerrain,
  groundCompFactors,
  groundModifiers,
  type AttackTactic,
  type DefenseTactic,
} from '@engine/groundTactics';
import { rngFor } from '@engine/rng';

const enabled = process.env['MOO2_GROUND'] === '1';
const SEED = 'c0ffee00c0ffee00c0ffee00c0ffee00';

const CLIMATES = ['terran', 'ocean', 'swamp', 'desert', 'barren', 'hostile'] as const;
const MAPS_PER_CLIMATE = 6;
const TRIALS = 250;
const BASE_STR = 20;

/** defender composition archetypes, 12 units total both ways */
const COMPS = [
  { name: 'militia-heavy', garrison: 2, militia: 10, pop: 20 },
  { name: 'garrison-heavy', garrison: 9, militia: 3, pop: 6 },
] as const;

interface CellResult {
  captures: number;
  trials: number;
  civLosses: number;
}

function fight(
  atk: AttackTactic,
  def: DefenseTactic,
  terrain: string[],
  comp: (typeof COMPS)[number],
  trial: number,
  cellId: number,
): { captured: boolean; civLosses: number } {
  const mods = groundModifiers(atk, def, terrain);
  const atkStr = Math.max(1, Math.round(BASE_STR * mods.atkMult));
  const defStr = Math.max(1, Math.round(BASE_STR * mods.defMult));
  const troops = comp.garrison + comp.militia; // equal counts = a close fight
  const rng = rngFor(SEED, trial, 'groundsim', cellId);
  const res = fightGroundRounds(troops, comp.garrison, comp.militia, atkStr, defStr, comp.pop, rng, groundCompFactors(def));
  return { captured: res.defMarines + res.militia <= 0 && res.troops > 0, civLosses: res.civilianLosses };
}

const pct = (c: CellResult) => (100 * c.captures) / Math.max(1, c.trials);
const fmt = (v: number) => v.toFixed(0).padStart(4);

describe.runIf(enabled)('ground tactics simulator', () => {
  it(
    'sweeps tactics x terrain x composition at close odds',
    { timeout: 300_000 },
    () => {
      // results[climate][comp][atk][def]
      const results = new Map<string, Map<string, Map<AttackTactic, Map<DefenseTactic, CellResult>>>>();
      let cellId = 0;
      for (const climate of CLIMATES) {
        const compMap = new Map<string, Map<AttackTactic, Map<DefenseTactic, CellResult>>>();
        results.set(climate, compMap);
        for (const comp of COMPS) {
          const atkMap = new Map<AttackTactic, Map<DefenseTactic, CellResult>>();
          compMap.set(comp.name, atkMap);
          for (const atk of ATTACK_TACTICS) {
            const defMap = new Map<DefenseTactic, CellResult>();
            atkMap.set(atk, defMap);
            for (const def of DEFENSE_TACTICS) {
              const cell: CellResult = { captures: 0, trials: 0, civLosses: 0 };
              defMap.set(def, cell);
              cellId++;
              for (let world = 0; world < MAPS_PER_CLIMATE; world++) {
                const terrain = generateTerrain(9000 + world * 17, climate);
                for (let t = 0; t < TRIALS; t++) {
                  const r = fight(atk, def, terrain, comp, t, cellId * 31 + world);
                  cell.trials++;
                  if (r.captured) cell.captures++;
                  cell.civLosses += r.civLosses;
                }
              }
            }
          }
        }
      }

      const lines: string[] = [];
      const P = (s: string) => lines.push(s);

      for (const climate of CLIMATES) {
        for (const comp of COMPS) {
          const atkMap = results.get(climate)!.get(comp.name)!;
          P(`\n=== ${climate} · ${comp.name} (${comp.garrison}g+${comp.militia}m vs ${comp.garrison + comp.militia} marines) — capture % ===`);
          P(`${'atk \\ def'.padEnd(20)}${DEFENSE_TACTICS.map((d) => d.slice(0, 8).padStart(9)).join('')}   avg`);
          for (const atk of ATTACK_TACTICS) {
            const row = DEFENSE_TACTICS.map((def) => pct(atkMap.get(atk)!.get(def)!));
            const avg = row.reduce((s, v) => s + v, 0) / row.length;
            P(`${atk.padEnd(20)}${row.map((v) => fmt(v).padStart(9)).join('')}  ${fmt(avg)}`);
          }
          const colAvg = DEFENSE_TACTICS.map((def) => {
            let s = 0;
            for (const atk of ATTACK_TACTICS) s += pct(atkMap.get(atk)!.get(def)!);
            return s / ATTACK_TACTICS.length;
          });
          P(`${'(def avg — lower=better)'.padEnd(20)}${colAvg.map((v) => fmt(v).padStart(9)).join('')}`);
        }
      }

      // ---- summaries ----
      P('\n=== summary: swing at close odds (best-worst per axis) ===');
      for (const climate of CLIMATES) {
        for (const comp of COMPS) {
          const atkMap = results.get(climate)!.get(comp.name)!;
          const atkAvgs = ATTACK_TACTICS.map((atk) => {
            let s = 0;
            for (const def of DEFENSE_TACTICS) s += pct(atkMap.get(atk)!.get(def)!);
            return { atk, v: s / DEFENSE_TACTICS.length };
          }).sort((a, b) => b.v - a.v);
          const defAvgs = DEFENSE_TACTICS.map((def) => {
            let s = 0;
            for (const atk of ATTACK_TACTICS) s += pct(atkMap.get(atk)!.get(def)!);
            return { def, v: s / ATTACK_TACTICS.length };
          }).sort((a, b) => a.v - b.v); // lower capture% = better defense
          P(
            `${climate.padEnd(8)} ${comp.name.padEnd(15)} atk: ${atkAvgs[0]!.atk}(${fmt(atkAvgs[0]!.v)}) > ${atkAvgs.at(-1)!.atk}(${fmt(atkAvgs.at(-1)!.v)}) swing ${fmt(atkAvgs[0]!.v - atkAvgs.at(-1)!.v)}pp | def: ${defAvgs[0]!.def}(${fmt(defAvgs[0]!.v)}) > ${defAvgs.at(-1)!.def}(${fmt(defAvgs.at(-1)!.v)}) swing ${fmt(defAvgs.at(-1)!.v - defAvgs[0]!.v)}pp`,
          );
        }
      }

      // ---- civilian losses: the other discovery surface — a doctrine that
      // spends militia spends CIVILIANS ----
      P('\n=== expected civilian cost of hosting an invasion, by doctrine (militia-heavy) ===');
      for (const def of DEFENSE_TACTICS) {
        let civ = 0;
        let n = 0;
        for (const climate of CLIMATES) {
          for (const atk of ATTACK_TACTICS) {
            const cell = results.get(climate)!.get('militia-heavy')!.get(atk)!.get(def)!;
            civ += cell.civLosses;
            n += cell.trials;
          }
        }
        P(`${def.padEnd(20)} ${(civ / Math.max(1, n)).toFixed(1)} pop per invasion`);
      }

      const outDir = join(__dirname, '../../bugs/ground-sim');
      mkdirSync(outDir, { recursive: true });
      writeFileSync(join(outDir, 'report.txt'), lines.join('\n') + '\n');
      console.log(lines.join('\n'));

      // ---- score gates (loose aggregate margins — a rules tweak should
      // retune numbers, not flake these; see selfplay re-baseline lesson) ----
      const cap = (climate: string, comp: string, atk: AttackTactic, def: DefenseTactic) =>
        pct(results.get(climate)!.get(comp)!.get(atk)!.get(def)!);
      const atkAvg = (climate: string, atk: AttackTactic) => {
        let s = 0;
        let n = 0;
        for (const comp of COMPS) for (const def of DEFENSE_TACTICS) { s += cap(climate, comp.name, atk, def); n++; }
        return s / n;
      };
      const defAvg = (climate: string, comp: string, def: DefenseTactic) => {
        let s = 0;
        for (const atk of ATTACK_TACTICS) s += cap(climate, comp, atk, def);
        return s / ATTACK_TACTICS.length;
      };

      // G1 — close fights are decided by tactics: every climate x composition
      // has >=25pp between its best and worst tactic PAIR
      for (const climate of CLIMATES) {
        for (const comp of COMPS) {
          let lo = 100;
          let hi = 0;
          for (const atk of ATTACK_TACTICS) {
            for (const def of DEFENSE_TACTICS) {
              const v = cap(climate, comp.name, atk, def);
              lo = Math.min(lo, v);
              hi = Math.max(hi, v);
            }
          }
          expect(hi - lo, `${climate}/${comp.name} pair swing`).toBeGreaterThanOrEqual(25);
        }
      }

      // G2 — the SURFACE changes which attack works: infiltrate is a cover
      // tactic, shock wants the open, overwatch wants broken rock
      expect(atkAvg('swamp', 'infiltrate') - atkAvg('barren', 'infiltrate'), 'infiltrate cover gap').toBeGreaterThanOrEqual(10);
      expect(atkAvg('terran', 'charge') - atkAvg('hostile', 'charge'), 'charge open gap').toBeGreaterThanOrEqual(5);
      const owGapHostile = atkAvg('hostile', 'bounding_overwatch') - atkAvg('hostile', 'charge');
      const owGapTerran = atkAvg('terran', 'bounding_overwatch') - atkAvg('terran', 'charge');
      expect(owGapHostile - owGapTerran, 'overwatch>charge grows on rock').toBeGreaterThanOrEqual(8);

      // G3 — composition discovery: a counter-charge is a trained-troop
      // doctrine (militia rout), a fortress serves both alike
      let chargeGap = 0;
      let fortGap = 0;
      for (const climate of CLIMATES) {
        chargeGap += defAvg(climate, 'militia-heavy', 'charge') - defAvg(climate, 'garrison-heavy', 'charge');
        fortGap += Math.abs(defAvg(climate, 'militia-heavy', 'fortress') - defAvg(climate, 'garrison-heavy', 'fortress'));
      }
      expect(chargeGap / CLIMATES.length, 'charge doctrine needs trained troops').toBeGreaterThanOrEqual(25);
      expect(fortGap / CLIMATES.length, 'fortress serves militia and marines alike').toBeLessThanOrEqual(8);
      // militia-heavy colonies should learn "man the walls": fortress best
      // nearly everywhere; garrison-heavy should find maneuver doctrines
      let fortBestMilitia = 0;
      let fortBestGarrison = 0;
      for (const climate of CLIMATES) {
        const rank = (comp: string) => [...DEFENSE_TACTICS].sort((a, b) => defAvg(climate, comp, a) - defAvg(climate, comp, b))[0];
        if (rank('militia-heavy') === 'fortress') fortBestMilitia++;
        if (rank('garrison-heavy') === 'fortress') fortBestGarrison++;
      }
      expect(fortBestMilitia, 'militia mans the walls').toBeGreaterThanOrEqual(4);
      expect(fortBestGarrison, 'a trained garrison prefers maneuver somewhere').toBeLessThanOrEqual(3);

      // G4 — defenders read the ground too: fortresses thrive on rock
      const fortRock = (defAvg('hostile', 'militia-heavy', 'fortress') + defAvg('hostile', 'garrison-heavy', 'fortress')) / 2;
      const fortSoft = (defAvg('terran', 'militia-heavy', 'fortress') + defAvg('terran', 'garrison-heavy', 'fortress')) / 2;
      expect(fortSoft - fortRock, 'fortress thrives on rock').toBeGreaterThanOrEqual(4);
    },
  );
});
