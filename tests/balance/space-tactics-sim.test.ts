// Space-tactics simulator (bugs.md round 9): a Monte Carlo over fleet
// ARCHETYPES x DOCTRINE pairs that answers three questions the set-piece
// pattern engine has never been measured against:
//
//   1. LEVERAGE — inside one fixed matchup, does picking a different tactic
//      change the result at all? (leverage ~ 0 = the picker is decoration)
//   2. DOMINANCE — is one doctrine simply the right answer everywhere?
//   3. IDENTITY — does each weapon system prefer a DIFFERENT tactic, so a
//      player can recognise "slow missile fleet -> standoff", "fast carrier
//      -> close", "nimble beam fleet -> outflank"?
//
// Plus a DRIVE RACE sweep: the same fleets fought at a range of engine
// deltas, to see whether speed decides which maneuver is victorious.
//
// Run (slow — minutes):
//   MOO2_SPACE=1 npx vitest run tests/balance/space-tactics-sim.test.ts
// Knobs:
//   MOO2_SPACE_TRIALS=n   seeds per doctrine cell (default 3)
//   MOO2_SPACE_TACTICS=0  measure the OLD (pre-0.26) pattern engine instead
//   MOO2_SPACE_RETREAT=n  retreat threshold percent (default 0 = to the death)
//   MOO2_SPACE_QUICK=1    a 4-archetype subset for a fast look
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ARCHETYPES, ARCHETYPE_BY_ID, fleetPower } from './lib/spacefleets';
import {
  DOCTRINES,
  addCell,
  doctrineMeans,
  edgeTable,
  emptyCell,
  fightProfiled,
  leverage,
  matchupSweep,
  maximin,
  meanEdge,
  meanTicks,
  num,
  pad,
  padL,
  winPct,
  type Cell,
  type MatchOpts,
  type SimDoctrine,
} from './lib/spacesim';

const enabled = process.env['MOO2_SPACE'] === '1';
const TRIALS = Number(process.env['MOO2_SPACE_TRIALS'] ?? 3);
const TACTICS = process.env['MOO2_SPACE_TACTICS'] !== '0';
const RETREAT = Number(process.env['MOO2_SPACE_RETREAT'] ?? 0);
const QUICK = process.env['MOO2_SPACE_QUICK'] === '1';

const QUICK_SET = ['slow_missile', 'fast_carrier', 'beam_skirmisher', 'heavy_line'];
const PANEL = QUICK ? ARCHETYPES.filter((a) => QUICK_SET.includes(a.id)) : ARCHETYPES;

const OPTS: MatchOpts = { retreatPct: RETREAT, tactics: TACTICS };

/** short column head for the wide archetype matrix */
const padHead = (id: string): string => padL(id.split('_').map((p) => p.slice(0, 4)).join('_').slice(0, 8), 9);

describe.runIf(enabled)('space tactics simulator', () => {
  it(
    'sweeps archetypes x doctrines and reports leverage, dominance and identity',
    { timeout: 3_600_000 },
    () => {
      const lines: string[] = [];
      const P = (s: string) => lines.push(s);

      P(`=== space-tactics Monte Carlo — engine: ${TACTICS ? '0.26 tactics' : 'legacy patterns'}, trials/cell ${TRIALS}, retreat ${RETREAT}% ===`);

      // ---- fleet readout -------------------------------------------------
      P('\n=== fleet archetypes ===');
      P(pad('archetype', 20) + pad('hulls', 7) + pad('hp', 8) + pad('dps', 8) + pad('power', 8) + 'identity');
      for (const a of PANEL) {
        const ships = a.build(0);
        const p = fleetPower(ships);
        P(
          pad(a.id, 20) + pad(String(ships.length), 7) + pad(String(p.hp), 8) +
            pad(p.dps.toFixed(0), 8) + pad(String(p.power), 8) + a.identity,
        );
      }

      // ---- the sweep -----------------------------------------------------
      // every unordered archetype pair (including the mirror) x every
      // doctrine pair x TRIALS seeds x both deployment orientations
      const pairs: Array<[string, string]> = [];
      for (let i = 0; i < PANEL.length; i++) {
        for (let j = i; j < PANEL.length; j++) pairs.push([PANEL[i]!.id, PANEL[j]!.id]);
      }

      const sweeps = new Map<string, Map<SimDoctrine, Map<SimDoctrine, Cell>>>();
      for (const [x, y] of pairs) {
        sweeps.set(`${x}|${y}`, matchupSweep(x, y, TRIALS, OPTS));
      }

      // ---- 1. leverage: does the choice move the needle? ------------------
      P('\n=== LEVERAGE — how far the doctrine choice moves the material edge, per matchup ===');
      P('(edge = own damage taken subtracted from foe damage taken, in points; both orientations averaged)');
      P(pad('matchup', 40) + pad('leverage', 10) + pad('best', 10) + pad('worst', 10) + pad('ticks', 8));
      const levs: Array<{ pair: string; lev: number }> = [];
      for (const [x, y] of pairs) {
        const cells = sweeps.get(`${x}|${y}`)!;
        const means = doctrineMeans(cells);
        const sorted = [...means.entries()].sort((a, b) => b[1] - a[1]);
        const lev = leverage(cells);
        levs.push({ pair: `${x} vs ${y}`, lev });
        let tk = 0;
        let n = 0;
        for (const da of DOCTRINES) for (const db of DOCTRINES) { tk += meanTicks(cells.get(da)!.get(db)!); n++; }
        P(
          pad(`${x} vs ${y}`, 40) + num(lev, 10) +
            pad(` ${sorted[0]![0]}`, 10) + pad(` ${sorted.at(-1)![0]}`, 10) + num(tk / n, 8, 0),
        );
      }
      levs.sort((a, b) => a.lev - b.lev);
      const meanLev = levs.reduce((s, l) => s + l.lev, 0) / levs.length;
      P(`\nmean leverage ${meanLev.toFixed(1)}  |  flattest: ${levs[0]!.pair} (${levs[0]!.lev.toFixed(1)})  |  sharpest: ${levs.at(-1)!.pair} (${levs.at(-1)!.lev.toFixed(1)})`);

      // ---- 2. dominance: aggregate doctrine strength ----------------------
      const global = new Map<SimDoctrine, Map<SimDoctrine, Cell>>();
      for (const da of DOCTRINES) {
        const row = new Map<SimDoctrine, Cell>();
        global.set(da, row);
        for (const db of DOCTRINES) row.set(db, emptyCell());
      }
      for (const [x, y] of pairs) {
        const cells = sweeps.get(`${x}|${y}`)!;
        for (const da of DOCTRINES) {
          for (const db of DOCTRINES) {
            const src = cells.get(da)!.get(db)!;
            const dst = global.get(da)!.get(db)!;
            dst.n += src.n;
            dst.edge += src.edge;
            dst.wins += src.wins;
            dst.ticks += src.ticks;
            // ...and the mirror entry, so the aggregate table is symmetric
            const mirror = global.get(db)!.get(da)!;
            mirror.n += src.n;
            mirror.edge -= src.edge;
            mirror.wins += src.n - src.wins;
            mirror.ticks += src.ticks;
          }
        }
      }
      P('\n' + edgeTable(global, '=== DOMINANCE — doctrine vs doctrine, all archetypes pooled (mean edge) ==='));
      P('\n' + pad('doctrine', 12) + pad('mean edge', 12) + pad('win%', 10) + 'worst reply');
      const domRank: Array<{ d: SimDoctrine; mean: number }> = [];
      for (const da of DOCTRINES) {
        let sum = 0;
        let w = emptyCell();
        let worst: { d: SimDoctrine; v: number } = { d: DOCTRINES[0], v: Infinity };
        for (const db of DOCTRINES) {
          const c = global.get(da)!.get(db)!;
          sum += meanEdge(c);
          w = { n: w.n + c.n, edge: w.edge + c.edge, wins: w.wins + c.wins, ticks: w.ticks + c.ticks };
          if (meanEdge(c) < worst.v) worst = { d: db, v: meanEdge(c) };
        }
        const mean = sum / DOCTRINES.length;
        domRank.push({ d: da, mean });
        P(pad(da, 12) + num(mean, 12) + num(winPct(w), 10) + ` ${worst.d} (${worst.v.toFixed(1)})`);
      }
      domRank.sort((a, b) => b.mean - a.mean);
      P(`\ndominance spread ${(domRank[0]!.mean - domRank.at(-1)!.mean).toFixed(1)}  (${domRank[0]!.d} strongest, ${domRank.at(-1)!.d} weakest)`);

      // ---- 3. identity: the best doctrine per archetype --------------------
      P('\n=== IDENTITY — mean edge per doctrine, by fleet archetype (pooled over every foe and foe doctrine) ===');
      P(pad('archetype', 20) + DOCTRINES.map((d) => pad(d.slice(0, 8), 9)).join('') + '  best      wanted');
      const identity = new Map<string, Map<SimDoctrine, Cell>>();
      for (const a of PANEL) {
        const per = new Map<SimDoctrine, Cell>();
        identity.set(a.id, per);
        for (const d of DOCTRINES) per.set(d, emptyCell());
      }
      for (const [x, y] of pairs) {
        const cells = sweeps.get(`${x}|${y}`)!;
        for (const da of DOCTRINES) {
          for (const db of DOCTRINES) {
            const src = cells.get(da)!.get(db)!;
            const px = identity.get(x)!.get(da)!;
            px.n += src.n;
            px.edge += src.edge;
            px.wins += src.wins;
            px.ticks += src.ticks;
            if (x !== y) {
              const py = identity.get(y)!.get(db)!;
              py.n += src.n;
              py.edge -= src.edge;
              py.wins += src.n - src.wins;
              py.ticks += src.ticks;
            }
          }
        }
      }
      const bestOf = new Map<string, SimDoctrine>();
      for (const a of PANEL) {
        const per = identity.get(a.id)!;
        const row = DOCTRINES.map((d) => meanEdge(per.get(d)!));
        const best = DOCTRINES[row.indexOf(Math.max(...row))]!;
        bestOf.set(a.id, best);
        P(
          pad(a.id, 20) + row.map((v) => num(v, 9)).join('') +
            pad(`  ${best}`, 12) + a.wants.join('/'),
        );
      }
      const distinct = new Set(bestOf.values());
      P(`\ndistinct preferred doctrines across ${PANEL.length} archetypes: ${distinct.size} (${[...distinct].join(', ')})`);
      const wantHits = PANEL.filter((a) => a.wants.includes(bestOf.get(a.id)!)).length;
      P(`archetypes whose measured best is one they were DESIGNED to want: ${wantHits}/${PANEL.length}`);

      // ---- 3b. archetype balance: the sanity check under everything -------
      // Doctrine effects are only readable when the FLEETS are close to even.
      // A row far from zero means that archetype's roster needs retuning, not
      // that its tactics are broken.
      P('\n=== ARCHETYPE BALANCE — mean edge of row fleet vs column fleet (pooled over all doctrine pairs) ===');
      P(pad('fleet', 20) + PANEL.map((a) => padHead(a.id)).join('') + '   mean');
      for (const x of PANEL) {
        const row: number[] = [];
        for (const y of PANEL) {
          const key = pairs.some(([p, q]) => p === x.id && q === y.id) ? `${x.id}|${y.id}` : `${y.id}|${x.id}`;
          const cells = sweeps.get(key)!;
          let sum = 0;
          let n = 0;
          for (const da of DOCTRINES) {
            for (const db of DOCTRINES) {
              const c = cells.get(da)!.get(db)!;
              sum += key.startsWith(`${x.id}|`) ? meanEdge(c) : -meanEdge(c);
              n++;
            }
          }
          row.push(sum / n);
        }
        P(pad(x.id, 20) + row.map((v) => num(v, 9)).join('') + num(row.reduce((s, v) => s + v, 0) / row.length, 9));
      }

      // ---- 3c. identity BY MATCHUP ----------------------------------------
      // The pooled table above hides the interesting half of the answer: a
      // good tactic is one that is right against SOME opponents, not all. If
      // this table is one doctrine repeated, the picker is still decoration.
      P('\n=== IDENTITY BY MATCHUP — the row fleet\'s best doctrine against each column fleet ===');
      P(pad('fleet', 20) + PANEL.map((a) => padHead(a.id)).join(''));
      const bestCount = new Map<SimDoctrine, number>(DOCTRINES.map((d) => [d, 0]));
      for (const x of PANEL) {
        const row: string[] = [];
        for (const y of PANEL) {
          const key = pairs.some(([p, q]) => p === x.id && q === y.id) ? `${x.id}|${y.id}` : `${y.id}|${x.id}`;
          const cells = sweeps.get(key)!;
          const forward = key.startsWith(`${x.id}|`);
          let best: SimDoctrine = DOCTRINES[0];
          let bestV = -Infinity;
          for (const da of DOCTRINES) {
            let sum = 0;
            for (const db of DOCTRINES) {
              // when x is the column side of the stored sweep, its doctrine
              // is the FOE axis and the edge sign flips
              sum += forward ? meanEdge(cells.get(da)!.get(db)!) : -meanEdge(cells.get(db)!.get(da)!);
            }
            if (sum / DOCTRINES.length > bestV) {
              bestV = sum / DOCTRINES.length;
              best = da;
            }
          }
          bestCount.set(best, bestCount.get(best)! + 1);
          row.push(best);
        }
        P(pad(x.id, 20) + row.map((d) => padL(d.slice(0, 8), 9)).join(''));
      }
      P('\nhow often each doctrine is the right answer: ' +
        DOCTRINES.map((d) => `${d} ${bestCount.get(d)!}`).join(', '));

      // ---- 4. maximin: the tactic that is hardest to punish ---------------
      P('\n=== MAXIMIN — per matchup, the doctrine with the best worst-case reply ===');
      P(pad('matchup', 40) + pad('A picks', 12) + pad('worst-case', 12));
      for (const [x, y] of pairs) {
        const mm = maximin(sweeps.get(`${x}|${y}`)!);
        P(pad(`${x} vs ${y}`, 40) + pad(mm.doc, 12) + num(mm.worst, 12));
      }

      // ---- 5. per-matchup detail for the three signature fleets ------------
      const SIGNATURE: Array<[string, string]> = [
        ['slow_missile', 'beam_skirmisher'],
        ['slow_missile', 'fast_carrier'],
        ['fast_carrier', 'beam_skirmisher'],
        ['heavy_line', 'beam_skirmisher'],
        ['heavy_line', 'slow_missile'],
      ];
      P('\n=== SIGNATURE MATCHUPS (full doctrine x doctrine tables) ===');
      for (const [x, y] of SIGNATURE) {
        const key = pairs.some(([a, b]) => a === x && b === y) ? `${x}|${y}` : `${y}|${x}`;
        const cells = sweeps.get(key);
        if (!cells) continue;
        const [ax, ay] = key.split('|') as [string, string];
        P('\n' + edgeTable(cells, `--- ${ax} (rows) vs ${ay} (cols) — edge for ${ax} ---`));
      }

      // ---- 6. the drive race ----------------------------------------------
      // Same fleets, one side's engines tuned up and down: which maneuver
      // wins should follow the drive, not the doctrine table.
      P('\n=== DRIVE RACE — best doctrine as one side gains/loses engine speed ===');
      P('(A is the side whose drives change; edge is A\'s. Foe always plays its own best doctrine.)');
      const DRIVE_PAIRS: Array<[string, string]> = [
        ['slow_missile', 'beam_skirmisher'],
        ['beam_skirmisher', 'turret_cruiser'],
        ['fast_carrier', 'pd_escort'],
      ];
      const DELTAS = [-4, -2, 0, 2, 4];
      for (const [x, y] of DRIVE_PAIRS) {
        if (!ARCHETYPE_BY_ID.has(x) || !ARCHETYPE_BY_ID.has(y)) continue;
        P(`\n${x} (drive delta) vs ${y}`);
        P(pad('delta', 8) + DOCTRINES.map((d) => pad(d.slice(0, 8), 9)).join('') + '  best');
        for (const delta of DELTAS) {
          const cells = matchupSweep(x, y, Math.max(1, Math.ceil(TRIALS / 2)), {
            ...OPTS,
            optsA: { speedDelta: delta },
          });
          const means = doctrineMeans(cells);
          const row = DOCTRINES.map((d) => means.get(d)!);
          const best = DOCTRINES[row.indexOf(Math.max(...row))]!;
          P(pad(delta > 0 ? `+${delta}` : String(delta), 8) + row.map((v) => num(v, 9)).join('') + `  ${best}`);
        }
      }

      // ---- 7. range-band forensics ----------------------------------------
      // WHY a doctrine behaves the way it does: where its shots actually land.
      // A doctrine with no distinct firing distance cannot have a distinct
      // weapon-system identity, whatever the win tables say.
      P('\n=== BAND FORENSICS — where each doctrine actually fights ===');
      P('(one fleet flies the row doctrine against every foe doctrine; distances in field units)');
      for (const aid of ['beam_skirmisher', 'slow_missile', 'fast_carrier'] as const) {
        const a = ARCHETYPE_BY_ID.get(aid);
        if (!a) continue;
        P(`\n-- ${aid} --`);
        P(pad('doctrine', 12) + pad('fleet sep', 10) + pad('fire dist', 10) + pad('short%', 8) + pad('med%', 8) + pad('long%', 8) +
          pad('u/tick', 8) + pad('shots', 8) + pad('hit%', 7) + pad('taken', 8) + pad('theirhit%', 10) + pad('ticks', 7));
        for (const da of DOCTRINES) {
          let sep = 0;
          let dist = 0;
          let shots = 0;
          let hits = 0;
          let taken = 0;
          let tHits = 0;
          let move = 0;
          let moveN = 0;
          let ticks = 0;
          let n = 0;
          const bands = [0, 0, 0, 0];
          for (const db of DOCTRINES) {
            for (const foe of PANEL) {
              const r = fightProfiled(a, da, foe, db, 0, OPTS);
              const p = r.profiles[0]!;
              const q = r.profiles[1]!;
              sep += r.meanSep;
              shots += p.shots;
              hits += p.hits;
              taken += q.shots;
              tHits += q.hits;
              move += p.moveSum;
              moveN += p.moveN;
              dist += p.distSum;
              for (let b = 0; b < 4; b++) bands[b] = bands[b]! + p.band[b]!;
              ticks += r.outcome.ticks;
              n++;
            }
          }
          const tot = Math.max(1, bands[0]! + bands[1]! + bands[2]! + bands[3]!);
          P(
            pad(da, 12) + num(sep / n, 10, 0) + num(dist / Math.max(1, shots), 10, 0) +
              num((100 * bands[0]!) / tot, 8, 0) + num((100 * bands[1]!) / tot, 8, 0) +
              num((100 * (bands[2]! + bands[3]!)) / tot, 8, 0) +
              num(move / Math.max(1, moveN), 8, 1) +
              num(shots / n, 8, 0) + num((100 * hits) / Math.max(1, shots), 7, 0) +
              num(taken / n, 8, 0) + num((100 * tHits) / Math.max(1, taken), 10, 0) + num(ticks / n, 7, 0),
          );
        }
      }

      const outDir = join(__dirname, '../../bugs/space-sim');
      mkdirSync(outDir, { recursive: true });
      writeFileSync(join(outDir, TACTICS ? 'report.txt' : 'report-legacy.txt'), lines.join('\n') + '\n');
      console.log(lines.join('\n'));

      expect(levs.length).toBeGreaterThan(0);
    },
  );
});

// keep the aggregate helpers referenced even in the quick configuration
void addCell;
