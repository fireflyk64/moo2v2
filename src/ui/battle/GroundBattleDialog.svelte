<script lang="ts">
  // Invasion playback, war-table edition (bugs.md rounds 6-8): a TOP-DOWN
  // theater map drawn as a PAPER CAMPAIGN MAP on a wooden table — parchment,
  // watercolor terrain washes under a ruled survey grid, hachured canyons and
  // meandering rivers (per climate), compass rose, scale bar, coordinate
  // letters, and small NATO battalion counters (crossed = marines, single
  // slash = militia) with tactic arrows and tracer fire. The defense HOLDS
  // ITS LINE and only falls back toward the colony while it is losing;
  // attackers press up to contact in front of (or around) that line and
  // advance as it yields. Terrain is the planet's one deterministic map;
  // rivers/canyons are seeded per colony but PURELY VISUAL — combat math
  // never reads them (engine terrain untouched, no ENGINE_VERSION concern).
  import { generateTerrain, TERRAIN_INFO, TERRAIN_W, TERRAIN_H } from '@engine/groundTactics';
  import { playerColor } from '../colors';
  import type { GroundBattleEntry } from '../state.svelte';

  let { battle, onclose }: { battle: GroundBattleEntry; onclose: () => void } = $props();

  const p = $derived(battle.payload);
  const rounds = $derived(p.rounds.length ? p.rounds : [{ t: p.startTroops, m: p.startMilitia }]);
  const S = $derived(rounds.length);

  let step = $state(0);
  let playing = $state(true);
  $effect(() => {
    void battle; // a different battle in the same dialog restarts the playback
    step = 0;
    playing = true;
  });
  $effect(() => {
    if (!playing) return;
    const iv = setInterval(() => {
      if (step < S - 1) step++;
      else playing = false;
    }, 200);
    return () => clearInterval(iv);
  });

  const stepNow = $derived(Math.min(step, S - 1));
  const cur = $derived(rounds[stepNow]!);
  const done = $derived(step >= S - 1);
  const atkColor = $derived(playerColor(p.attacker));
  const defColor = $derived(playerColor(p.defender));

  // ---- the theater map ----
  const CELL = 60;
  const MW = TERRAIN_W * CELL; // 720
  const MH = TERRAIN_H * CELL; // 480
  // paper margins: room for coordinate labels, scale bar, survey caption
  const PAD_L = 30;
  const PAD_T = 30;
  const PAD_R = 30;
  const PAD_B = 44;
  const VW = MW + PAD_L + PAD_R;
  const VH = MH + PAD_T + PAD_B;
  const COLS = 'ABCDEFGHIJKLMNOP';
  /** payload carries the exact map since 0.23.0; older entries approximate
   * from (colonyId, climate) — same generator, plausible stand-in */
  const terrain = $derived(
    (p as { terrain?: string[] }).terrain ?? generateTerrain(p.colonyId, p.climate ?? 'barren'),
  );
  const atkTactic = $derived((p as { atkTactic?: string }).atkTactic ?? 'charge');
  const defTactic = $derived((p as { defTactic?: string }).defTactic ?? 'long_line');
  const pretty = (id: string) => id.replaceAll('_', ' ');

  /** UI-side watercolor washes per zone char — TERRAIN_INFO colors are tuned
   * for dark chrome; these are mixed for parchment */
  const WASH: Record<string, string> = {
    p: 'rgba(148,158,94,0.42)',
    f: 'rgba(62,108,56,0.5)',
    h: 'rgba(151,120,62,0.46)',
    m: 'rgba(88,128,102,0.5)',
    d: 'rgba(199,158,84,0.5)',
    r: 'rgba(128,102,80,0.52)',
    c: 'rgba(110,96,76,0.5)',
    i: 'rgba(148,180,205,0.55)',
    u: 'rgba(118,110,128,0.5)',
    l: 'rgba(150,60,42,0.5)',
  };
  /** terrain kinds present, for the legend (sorted by coverage) */
  const legend = $derived.by(() => {
    const seen = new Map<string, number>();
    for (const row of terrain) for (const ch of row) seen.set(ch, (seen.get(ch) ?? 0) + 1);
    return [...seen.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([ch]) => ({ ch, info: TERRAIN_INFO[ch] }))
      .filter((e) => e.info);
  });
  const baseWash = $derived(WASH[legend[0]?.ch ?? 'p'] ?? WASH['p']!);
  const seed = $derived((p.colonyId % 89) + 1);

  const rng = (i: number, salt: number): number => (((i * 7919 + salt * 104729 + p.colonyId * 31) % 233) / 233);

  // ---- linear features: rivers, canyons, lava flows. The paper-map
  // centerpieces — meandering seeded polylines with rims/hachures. Purely
  // visual: no defBonus, engine never sees them. ----
  type P = [number, number];

  function chaikin(pts: P[], iters: number): P[] {
    let cur2 = pts;
    for (let k = 0; k < iters; k++) {
      const next: P[] = [cur2[0]!];
      for (let i = 0; i < cur2.length - 1; i++) {
        const a = cur2[i]!;
        const b = cur2[i + 1]!;
        next.push(
          [a[0] * 0.75 + b[0] * 0.25, a[1] * 0.75 + b[1] * 0.25],
          [a[0] * 0.25 + b[0] * 0.75, a[1] * 0.25 + b[1] * 0.75],
        );
      }
      next.push(cur2[cur2.length - 1]!);
      cur2 = next;
    }
    return cur2;
  }
  function smoothPath(pts: P[]): string {
    let d = `M${pts[0]![0].toFixed(1)},${pts[0]![1].toFixed(1)}`;
    for (let i = 1; i < pts.length - 1; i++) {
      const mx = (pts[i]![0] + pts[i + 1]![0]) / 2;
      const my = (pts[i]![1] + pts[i + 1]![1]) / 2;
      d += ` Q${pts[i]![0].toFixed(1)},${pts[i]![1].toFixed(1)} ${mx.toFixed(1)},${my.toFixed(1)}`;
    }
    const last = pts[pts.length - 1]!;
    return d + ` L${last[0].toFixed(1)},${last[1].toFixed(1)}`;
  }
  function polyPath(pts: P[]): string {
    return 'M' + pts.map(([x, y]) => `${x.toFixed(1)},${y.toFixed(1)}`).join(' L');
  }
  function offsetPoly(pts: P[], d: number): P[] {
    return pts.map((pt, i) => {
      const a = pts[Math.max(0, i - 1)]!;
      const b = pts[Math.min(pts.length - 1, i + 1)]!;
      const dx = b[0] - a[0];
      const dy = b[1] - a[1];
      const l = Math.hypot(dx, dy) || 1;
      return [pt[0] - (dy / l) * d, pt[1] + (dx / l) * d];
    });
  }
  /** short strokes from offset d back toward d-len, every ~`every` px along
   * the line — classic depression hachures (and ice cracks, with d<0<d-len) */
  function tickMarks(pts: P[], d: number, len: number, every: number): Array<[number, number, number, number]> {
    const out: Array<[number, number, number, number]> = [];
    let acc = 0;
    for (let i = 1; i < pts.length; i++) {
      const a = pts[i - 1]!;
      const b = pts[i]!;
      acc += Math.hypot(b[0] - a[0], b[1] - a[1]);
      if (acc < every) continue;
      acc = 0;
      const dx = b[0] - a[0];
      const dy = b[1] - a[1];
      const l = Math.hypot(dx, dy) || 1;
      const nx = -dy / l;
      const ny = dx / l;
      out.push([b[0] + nx * d, b[1] + ny * d, b[0] + nx * (d - len), b[1] + ny * (d - len)]);
    }
    return out;
  }
  function meander(salt: number, x0: number, y0: number, x1: number, y1: number, wob: number): P[] {
    const N = 8;
    const dx = x1 - x0;
    const dy = y1 - y0;
    const L = Math.hypot(dx, dy) || 1;
    const nx = -dy / L;
    const ny = dx / L;
    const ph = rng(salt, 61) * Math.PI * 2;
    const fr = 1.6 + rng(salt, 62) * 1.4;
    const out: P[] = [];
    for (let i = 0; i <= N; i++) {
      const t = i / N;
      const amp = (Math.sin(t * Math.PI * fr + ph) * 0.55 + (rng(salt * 31 + i, 63) - 0.5)) * wob * CELL;
      out.push([x0 + dx * t + nx * amp, y0 + dy * t + ny * amp]);
    }
    return chaikin(out, 2);
  }

  interface LinearFeature {
    kind: 'river' | 'canyon' | 'lava' | 'ice';
    glowing: boolean;
    w: number;
    d: string;
    rims: [string, string];
    ticks: Array<[number, number, number, number]>;
  }
  const features = $derived.by(() => {
    const cl = p.climate ?? 'barren';
    const out: LinearFeature[] = [];
    const mk = (kind: LinearFeature['kind'], salt: number, x0: number, y0: number, x1: number, y1: number, wob: number, w: number, glowing = false): P[] => {
      const pts = meander(salt, x0, y0, x1, y1, wob);
      const rim = w / 2 + 1.5;
      out.push({
        kind,
        glowing,
        w,
        d: smoothPath(pts),
        rims: [polyPath(offsetPoly(pts, rim)), polyPath(offsetPoly(pts, -rim))],
        ticks:
          kind === 'canyon'
            ? [...tickMarks(pts, rim, 6, 13), ...tickMarks(pts, -rim, -6, 13)]
            : kind === 'ice'
              ? tickMarks(pts, w * 0.3, w * 0.6, 26)
              : [],
      });
      return pts;
    };
    // features cross the approach zone (left/middle), never the colony
    const xTop = (0.26 + rng(1, 71) * 0.36) * MW;
    const xBot = (0.26 + rng(2, 71) * 0.36) * MW;
    if (['ocean', 'swamp', 'gaia', 'terran'].includes(cl)) {
      const w = cl === 'ocean' ? 15 : cl === 'swamp' ? 13 : 10;
      const main = mk('river', 5, xTop, -26, xBot, MH + 26, 0.95, w);
      if (cl === 'ocean' || cl === 'gaia') {
        // a tributary joins the main river partway down
        const j = main[Math.floor(main.length * (0.4 + rng(3, 72) * 0.35))]!;
        mk('river', 6, -26, (0.15 + rng(4, 73) * 0.7) * MH, j[0], j[1], 0.55, 6);
      }
    } else if (cl === 'tundra') {
      mk('ice', 5, xTop, -26, xBot, MH + 26, 0.8, 12);
    } else if (cl === 'hostile') {
      mk('lava', 5, xTop, -26, xBot, MH + 26, 0.9, 11);
    } else {
      // arid / desert / barren / energized: a canyon rift
      const w = cl === 'desert' ? 16 : cl === 'barren' ? 13 : 11;
      mk('canyon', 5, xTop, -26, xBot, MH + 26, 1.05, w, cl === 'energized');
    }
    return out;
  });
  /** ocean worlds: the attackers wade in off a sea along the left edge */
  const sea = $derived.by(() => {
    if ((p.climate ?? '') !== 'ocean') return null;
    const coast = meander(9, CELL * 1.0, -26, CELL * (0.65 + rng(4, 74) * 0.55), MH + 26, 0.32);
    return {
      d: smoothPath(coast) + ` L-30,${MH + 26} L-30,-26 Z`,
      coastD: smoothPath(coast),
      shallowsD: polyPath(offsetPoly(coast, 5)),
      waves: Array.from({ length: 7 }, (_, i): P => [10 + rng(i, 75) * 26, ((i + 0.35 + rng(i, 76) * 0.5) / 7.3) * MH]),
    };
  });
  const stains = $derived(
    Array.from({ length: 4 }, (_, i) => ({
      x: 20 + rng(i, 81) * (VW - 40),
      y: 20 + rng(i, 82) * (VH - 40),
      rx: 55 + rng(i, 83) * 80,
      ry: 35 + rng(i, 84) * 55,
    })),
  );

  // ---- map furniture: compass rose, star-fort citadel ----
  function star(n: number, rOut: number, rIn: number, rot: number): string {
    const pts: string[] = [];
    for (let i = 0; i < n * 2; i++) {
      const r = i % 2 === 0 ? rOut : rIn;
      const a = rot + (i * Math.PI) / n;
      pts.push(`${(Math.cos(a) * r).toFixed(2)},${(Math.sin(a) * r).toFixed(2)}`);
    }
    return `M${pts.join(' L')} Z`;
  }
  const ROSE_MAIN = star(4, 17, 4.2, -Math.PI / 2);
  const ROSE_DIAG = star(4, 10, 3.4, -Math.PI / 4);
  const FORT = star(5, 18, 9.5, -Math.PI / 2);

  // ---- terrain glyphs: hand-drawn map symbols, deliberately jittered so
  // they spill past their cell into the neighbors (bugs.md round 7) ----
  /** airless/hostile worlds build under domes instead of open towers */
  const domed = $derived(['barren', 'hostile', 'energized', 'tundra'].includes(p.climate ?? 'barren'));
  interface Glyph {
    k: string;
    x: number;
    y: number;
    s: number;
    r: number;
  }
  const glyphs = $derived.by(() => {
    const out: Glyph[] = [];
    terrain.forEach((row, ty) => {
      [...row].forEach((ch, tx) => {
        const base = tx * 131 + ty * 17;
        const n =
          ch === 'p'
            ? rng(base, 21) < 0.4
              ? 1
              : 0
            : ch === 'u'
              ? 2
              : 1 + (rng(base, 22) < 0.45 ? 1 : 0);
        for (let g = 0; g < n; g++) {
          out.push({
            k: ch,
            // centers roam a 1.4-cell window so symbols escape their square
            x: (tx + rng(base + g * 7, 23) * 1.4 - 0.2) * CELL + CELL / 2,
            y: (ty + rng(base + g * 7, 24) * 1.4 - 0.2) * CELL + CELL / 2,
            s: 0.75 + rng(base + g * 7, 25) * 0.6,
            r: rng(base + g * 7, 26),
          });
        }
      });
    });
    return out;
  });

  // ---- battalions: up to 6 boxes per side sharing the units evenly ----
  interface DefPost {
    base: [number, number];
    back: [number, number]; // where a broken line rallies (toward the colony)
    sally: [number, number] | null; // charge doctrine storms out first
  }
  interface AtkPlan {
    entry: Array<[number, number]>; // tactic-flavored approach waypoints
    target: number; // defender battalion this one presses
    off: [number, number]; // contact offset from the target (cells)
  }
  interface Battalion {
    id: number;
    side: 'atk' | 'def';
    kind: 'marine' | 'militia';
    deathStep: number; // Infinity = survives
    post?: DefPost;
    plan?: AtkPlan;
  }

  /** cell center in px */
  const cc = (x: number, y: number): [number, number] => [(x + 0.5) * CELL, (y + 0.5) * CELL];
  const clampCell = (c: [number, number]): [number, number] => [
    Math.max(0.35, Math.min(TERRAIN_W - 0.65, c[0])),
    Math.max(0.35, Math.min(TERRAIN_H - 0.65, c[1])),
  ];

  /** first step at which this battalion's share of units is gone; battalion 0
   * dies LAST (higher ids are the lead elements) */
  function deathOf(perStep: number[], nBns: number, id: number): number {
    const per = perStep[0]! / nBns;
    const floor = (nBns - 1 - id) * per + 0.01;
    for (let s = 0; s < perStep.length; s++) if (perStep[s]! <= floor) return s;
    return Infinity;
  }

  const colonyAnchor: [number, number] = [TERRAIN_W - 1.2, TERRAIN_H / 2 - 0.5];

  /** how far the defense has been driven back by step s (monotonic 0..1);
   * a defense that is winning the exchange never yields ground */
  const pushArr = $derived.by(() => {
    const t0 = Math.max(1, rounds[0]!.t);
    const m0 = Math.max(1, rounds[0]!.m);
    let hi = 0;
    return rounds.map((r) => {
      const fA = 1 - r.t / t0;
      const fD = 1 - r.m / m0;
      hi = Math.max(hi, Math.min(1, Math.max(0, fD * 1.35 - fA * 0.6)));
      return hi;
    });
  });
  const pushAt = (s: number): number => pushArr[Math.max(0, Math.min(s, pushArr.length - 1))] ?? 0;

  /** defender line posts per doctrine (front battalions hold, broken lines
   * rally back toward the colony) */
  function defPosts(n: number, tactic: string): DefPost[] {
    const [gx, gy] = colonyAnchor;
    const out: DefPost[] = [];
    for (let i = 0; i < n; i++) {
      switch (tactic) {
        case 'fortress': {
          const th = -Math.PI / 2 + (Math.PI * (i + 0.5)) / n;
          out.push({
            base: [gx - 0.7 + Math.cos(th) * 1.2, gy + Math.sin(th) * 1.5],
            back: [gx - 0.5 + Math.cos(th) * 0.75, gy + Math.sin(th) * 0.95],
            sally: null,
          });
          break;
        }
        case 'long_line': {
          const y = 0.7 + ((i + 0.5) * (TERRAIN_H - 1.4)) / n;
          out.push({ base: [gx - 2.6, y], back: [gx - 1.1, gy + (y - gy) * 0.55], sally: null });
          break;
        }
        case 'charge': {
          const y = 1 + ((i + 0.5) * (TERRAIN_H - 2)) / n;
          out.push({ base: [gx - 1.5, y], back: [gx - 0.9, gy + (y - gy) * 0.6], sally: [TERRAIN_W * 0.5, y] });
          break;
        }
        default: {
          // defense_in_depth: two echelons; the front trades ground for time
          const half = Math.ceil(n / 2);
          const front = i < half;
          const k = front ? i : i - half;
          const rowsN = front ? half : n - half;
          const y = 1 + ((k + 0.5) * (TERRAIN_H - 2)) / Math.max(1, rowsN);
          out.push(
            front
              ? { base: [gx - 3.4, y], back: [gx - 1.7, y], sally: null }
              : { base: [gx - 1.7, y], back: [gx - 0.9, gy + (y - gy) * 0.6], sally: null },
          );
        }
      }
    }
    return out;
  }

  /** attacker plans: tactic-flavored approach, then press an assigned
   * defender battalion at a contact offset — IN FRONT of or AROUND the line,
   * never idling behind it */
  function atkPlans(n: number, nDef: number, tactic: string): AtkPlan[] {
    const lane = (i: number) => 0.8 + ((i + 0.5) * (TERRAIN_H - 1.6)) / n;
    const tgt = (i: number) => Math.min(nDef - 1, Math.floor((i * nDef) / n));
    const spread = (i: number) => (i - (n - 1) / 2) * 0.3;
    const plans: AtkPlan[] = [];
    for (let i = 0; i < n; i++) {
      const y0 = lane(i);
      const start: [number, number] = [0.4, y0];
      const mid: [number, number] = [TERRAIN_W * 0.4, y0];
      switch (tactic) {
        case 'flank': {
          if (i >= Math.ceil(n * 0.66) && n > 1) {
            const top = rng(1, 9) < 0.5; // seeded wing side
            const edgeY = top ? 0.5 : TERRAIN_H - 0.5;
            plans.push({
              entry: [start, [TERRAIN_W * 0.45, edgeY], [TERRAIN_W * 0.72, edgeY]],
              target: top ? 0 : nDef - 1,
              off: [0.15, top ? -1.25 : 1.25],
            });
          } else plans.push({ entry: [start, mid], target: tgt(i), off: [-1.25, spread(i) * 0.5] });
          break;
        }
        case 'pincer': {
          if (i === 0 && n > 1) plans.push({ entry: [start, [TERRAIN_W * 0.5, 0.5]], target: 0, off: [-0.3, -1.25] });
          else if (i === n - 1 && n > 1)
            plans.push({ entry: [start, [TERRAIN_W * 0.5, TERRAIN_H - 0.5]], target: nDef - 1, off: [-0.3, 1.25] });
          else plans.push({ entry: [start, mid], target: tgt(i), off: [-1.3, spread(i) * 0.5] });
          break;
        }
        case 'surround': {
          const a = (-0.62 + (1.24 * (i + 0.5)) / n) * Math.PI; // wrap -112°..112° around the line
          plans.push({ entry: [start, [TERRAIN_W * 0.45, y0]], target: tgt(i), off: [-Math.cos(a) * 1.5, Math.sin(a) * 1.7] });
          break;
        }
        case 'infiltrate': {
          const wob: [number, number] = [TERRAIN_W * (0.3 + rng(i, 3) * 0.35), 0.6 + rng(i, 4) * (TERRAIN_H - 1.2)];
          plans.push({ entry: [start, wob], target: tgt(i), off: [-0.85, (rng(i, 5) - 0.5) * 1.6] });
          break;
        }
        case 'hammer_and_anvil': {
          if (i < Math.ceil(n / 2))
            plans.push({ entry: [start, mid], target: tgt(i), off: [-2.3, spread(i)] }); // the anvil fixes them at range
          else
            plans.push({ entry: [start, [TERRAIN_W * 0.35, 0.7], [TERRAIN_W * 0.7, 0.7]], target: 0, off: [0.1, -1.3] }); // the hammer swings high
          break;
        }
        case 'pinning': {
          plans.push({ entry: [start, mid], target: tgt(i), off: [-2.1, spread(i)] }); // fix them, stand off
          break;
        }
        case 'bounding_overwatch': {
          const near = i % 2 === 0; // pairs leapfrog: one bounds, one overwatches
          plans.push({ entry: [start, [TERRAIN_W * (near ? 0.35 : 0.28), y0]], target: tgt(i), off: [near ? -1.05 : -1.9, spread(i) * 0.6] });
          break;
        }
        default: // charge: straight at them
          plans.push({ entry: [start, mid], target: tgt(i), off: [-1.15, spread(i) * 0.5] });
      }
    }
    return plans;
  }

  const model = $derived.by(() => {
    const perT = rounds.map((r) => Math.max(0, r.t));
    const perM = rounds.map((r) => Math.max(0, r.m));
    const nAtk = Math.max(1, Math.min(6, Math.ceil(perT[0]! / 4)));
    const nDef = Math.max(1, Math.min(6, Math.ceil(perM[0]! / 4)));
    const garrison = Math.min(p.startGarrison ?? 0, perM[0]!);
    const garBns = Math.round((garrison / Math.max(1, perM[0]!)) * nDef);
    const posts = defPosts(nDef, defTactic);
    const plans = atkPlans(nAtk, nDef, atkTactic);
    const atk: Battalion[] = plans.map((plan, i) => ({
      id: i,
      side: 'atk',
      kind: 'marine',
      plan,
      deathStep: deathOf(perT, nAtk, i),
    }));
    const def: Battalion[] = posts.map((post, i) => ({
      id: i,
      side: 'def',
      // lead battalions (high ids die first) are the garrison marines
      kind: i >= nDef - garBns ? 'marine' : 'militia',
      post,
      deathStep: deathOf(perM, nDef, i),
    }));
    return { atk, def, posts };
  });

  /** approach completes over the first ~third of the recorded rounds */
  const arrival = $derived(Math.max(1, Math.min(8, Math.floor(S / 3)) || 1));

  function defCellAt(post: DefPost, s: number): [number, number] {
    const push = pushAt(s);
    if (post.sally) {
      // storm out over the approach, then get driven home while losing
      const q = Math.min(1, s / arrival);
      const ox = post.base[0] + (post.sally[0] - post.base[0]) * q;
      const oy = post.base[1] + (post.sally[1] - post.base[1]) * q;
      return [ox + (post.back[0] - ox) * push, oy + (post.back[1] - oy) * push];
    }
    return [
      post.base[0] + (post.back[0] - post.base[0]) * push,
      post.base[1] + (post.back[1] - post.base[1]) * push,
    ];
  }
  function atkCellAt(plan: AtkPlan, s: number): [number, number] {
    const post = model.posts[plan.target] ?? model.posts[0]!;
    const [dx, dy] = defCellAt(post, s);
    const goal = clampCell([dx + plan.off[0], dy + plan.off[1]]);
    const pts = [...plan.entry, goal];
    const q = Math.min(1, s / arrival); // after arrival they TRACK the line
    const segs = pts.length - 1;
    const ft = q * segs;
    const i = Math.min(segs - 1, Math.floor(ft));
    const f = ft - i;
    return [pts[i]![0] + (pts[i + 1]![0] - pts[i]![0]) * f, pts[i]![1] + (pts[i + 1]![1] - pts[i]![1]) * f];
  }
  function posAt(b: Battalion, s: number): [number, number] {
    const at = Number.isFinite(b.deathStep) ? Math.min(s, b.deathStep) : s;
    const cell = b.side === 'def' ? defCellAt(b.post!, at) : atkCellAt(b.plan!, at);
    return cc(cell[0], cell[1]);
  }

  /** the drawn PLAN (cartography arrows): approach + initial contact point */
  function planPts(b: Battalion): Array<[number, number]> {
    const pts =
      b.side === 'def'
        ? b.post!.sally
          ? [b.post!.base, b.post!.sally]
          : [b.post!.base, b.post!.base]
        : (() => {
            const post = model.posts[b.plan!.target] ?? model.posts[0]!;
            const goal = clampCell([post.base[0] + b.plan!.off[0], post.base[1] + b.plan!.off[1]]);
            return [...b.plan!.entry, goal];
          })();
    return pts.map(([x, y]) => cc(x, y));
  }
  function arrowD(path: Array<[number, number]>): string {
    if (path.length < 2 || (path[0]![0] === path[1]![0] && path[0]![1] === path[1]![1])) return '';
    let d = `M${path[0]![0]},${path[0]![1]}`;
    for (let i = 1; i < path.length; i++) {
      const [px, py] = path[i - 1]!;
      const [x, y] = path[i]!;
      d += ` Q${(px + x) / 2 + (y - py) * 0.15},${(py + y) / 2 - (x - px) * 0.15} ${x},${y}`;
    }
    return d;
  }
  /** arrowhead at the plan's end, oriented along the final curve tangent */
  function headOf(pts: Array<[number, number]>): { x: number; y: number; deg: number } | null {
    if (pts.length < 2) return null;
    const [x2, y2] = pts[pts.length - 1]!;
    const [x1, y1] = pts[pts.length - 2]!;
    if (x1 === x2 && y1 === y2) return null;
    const dx = x2 - x1;
    const dy = y2 - y1;
    return { x: x2, y: y2, deg: (Math.atan2(dy / 2 + dx * 0.15, dx / 2 - dy * 0.15) * 180) / Math.PI };
  }

  // ---- tracer fire: engaged battalions exchange shots every round; the
  // battalion about to break takes a visible impact ----
  interface Shot {
    x1: number;
    y1: number;
    x2: number;
    y2: number;
    side: 'atk' | 'def';
  }
  const fire = $derived.by(() => {
    const s = stepNow;
    const shots: Shot[] = [];
    const impacts: Array<[number, number]> = [];
    if (s < 1) return { shots, impacts };
    const aliveA = model.atk.filter((b) => s < b.deathStep);
    const aliveD = model.def.filter((b) => s < b.deathStep);
    if (!aliveA.length || !aliveD.length) return { shots, impacts };
    const posA = aliveA.map((b) => posAt(b, s));
    const posD = aliveD.map((b) => posAt(b, s));
    const prev = rounds[s - 1]!;
    const lostA = prev.t - cur.t > 0; // attackers took the hit this round
    const lostD = prev.m - cur.m > 0;
    // the next battalion to break (highest id alive) is the one under fire
    const victimA = posA.length - 1;
    const victimD = posD.length - 1;
    const exchange = (
      from: Array<[number, number]>,
      to: Array<[number, number]>,
      side: 'atk' | 'def',
      reach: number,
      victim: number,
      scored: boolean,
    ) => {
      from.forEach(([x1, y1], i) => {
        let bi = 0;
        let bd = Infinity;
        to.forEach(([x, y], j) => {
          const d2 = (x - x1) ** 2 + (y - y1) ** 2;
          if (d2 < bd) {
            bd = d2;
            bi = j;
          }
        });
        const hitsVictim = scored && bi === victim;
        if (Math.sqrt(bd) > reach * CELL) return;
        if (hitsVictim || rng(i * 13 + s, side === 'atk' ? 41 : 43) < 0.72) {
          shots.push({ x1, y1, x2: to[bi]![0], y2: to[bi]![1], side });
        }
      });
    };
    exchange(posA, posD, 'atk', 3.0, victimD, lostD);
    exchange(posD, posA, 'def', 3.3, victimA, lostA); // prepared fields of fire
    if (lostD) impacts.push(posD[victimD]!);
    if (lostA) impacts.push(posA[victimA]!);
    return { shots, impacts };
  });

  const bursts = $derived(
    [...model.atk, ...model.def]
      .filter((b) => b.deathStep === stepNow && stepNow > 0)
      .map((b) => posAt(b, b.deathStep)),
  );
  const garAlive = $derived(Math.max(0, cur.m - (p.startMilitia - Math.min(p.startGarrison ?? 0, p.startMilitia))));
</script>

<div class="overlay" role="dialog" aria-label="invasion playback">
  <div class="panel">
    <h3>
      <span>⚔ Invasion of {p.colonyName} <span class="dim">— turn {battle.turn}{p.climate ? ` · ${p.climate} world` : ''}</span></span>
      <button class="x" data-testid="ground-close" title="close" onclick={onclose}>✕</button>
    </h3>
    <p class="tactics">
      <b style="color:{atkColor}">⚔ {pretty(atkTactic)}</b>
      <span class="dim">vs</span>
      <b style="color:{defColor}">🛡 {pretty(defTactic)}</b>
      <span class="legend">
        {#each legend as t (t.ch)}
          <span class="lg"
            ><i style="background-image: linear-gradient({WASH[t.ch] ?? baseWash}, {WASH[t.ch] ?? baseWash}), linear-gradient(#e8dcbe, #e8dcbe)"
            ></i>{t.info!.name}{t.info!.defBonus ? ` +${Math.round(t.info!.defBonus * 100)}%` : ''}</span>
        {/each}
      </span>
    </p>

    <svg viewBox="0 0 {VW} {VH}" class="scene" aria-hidden="true">
      <defs>
        <radialGradient id="gb-paper" cx="0.5" cy="0.42" r="0.75">
          <stop offset="0" stop-color="#f4ead0" />
          <stop offset="0.55" stop-color="#ead9b6" />
          <stop offset="1" stop-color="#d9c397" />
        </radialGradient>
        <radialGradient id="gb-stain">
          <stop offset="0" stop-color="#8a6a42" stop-opacity="0.14" />
          <stop offset="0.7" stop-color="#8a6a42" stop-opacity="0.05" />
          <stop offset="1" stop-color="#8a6a42" stop-opacity="0" />
        </radialGradient>
        <filter id="gb-soft" x="-20%" y="-20%" width="140%" height="140%">
          <feGaussianBlur stdDeviation="5" />
        </filter>
        <filter id="gb-deckle" x="-3%" y="-3%" width="106%" height="106%">
          <feTurbulence type="fractalNoise" baseFrequency="0.02" numOctaves="2" seed={seed} result="n" />
          <feDisplacementMap in="SourceGraphic" in2="n" scale="7" xChannelSelector="R" yChannelSelector="G" />
        </filter>
        <filter id="gb-wobble" x="-6%" y="-6%" width="112%" height="112%">
          <feTurbulence type="fractalNoise" baseFrequency="0.032" numOctaves="2" seed={seed + 3} result="n" />
          <feDisplacementMap in="SourceGraphic" in2="n" scale="13" xChannelSelector="R" yChannelSelector="G" />
        </filter>
        <filter id="gb-grain">
          <feTurbulence type="fractalNoise" baseFrequency="0.9" numOctaves="2" seed="7" />
          <feColorMatrix
            type="matrix"
            values="0 0 0 0 0.24  0 0 0 0 0.18  0 0 0 0 0.11  0.55 0.55 0.55 0 0"
          />
        </filter>
        <clipPath id="gb-field">
          <rect x="-1" y="-1" width={MW + 2} height={MH + 2} />
        </clipPath>
      </defs>

      <!-- the war table: paper sheet with shadow, stains -->
      <rect class="pshadow" x="10" y="14" width={VW - 20} height={VH - 22} rx="3" filter="url(#gb-soft)" />
      <rect class="paper" x="7" y="7" width={VW - 14} height={VH - 14} filter="url(#gb-deckle)" />
      {#each stains as st, i (i)}
        <ellipse cx={st.x} cy={st.y} rx={st.rx} ry={st.ry} fill="url(#gb-stain)" />
      {/each}

      <!-- the field: painted terrain under a ruled survey grid -->
      <g transform="translate({PAD_L},{PAD_T})" clip-path="url(#gb-field)">
        <g filter="url(#gb-wobble)">
          <rect x="-16" y="-16" width={MW + 32} height={MH + 32} fill={baseWash} />
          {#each terrain as row, ty (ty)}
            {#each row.split('') as ch, tx (tx)}
              <rect x={tx * CELL - 1} y={ty * CELL - 1} width={CELL + 2} height={CELL + 2} fill={WASH[ch] ?? baseWash} />
            {/each}
          {/each}
        </g>

        <!-- sea + rivers + canyons: the linear set-pieces -->
        {#if sea}
          <path d={sea.d} class="sea" />
          <path d={sea.shallowsD} class="shallows" />
          <path d={sea.coastD} class="coast" />
          {#each sea.waves as [wx, wy], i (i)}
            <path d="M-6,0 q3,-3.5 6,0 q3,3.5 6,0" transform="translate({wx},{wy})" class="wave" />
          {/each}
        {/if}
        {#each features as ft, fi (fi)}
          {#if ft.kind === 'river'}
            <path d={ft.d} class="riverbed" stroke-width={ft.w + 3} />
            <path d={ft.d} class="water" stroke-width={ft.w} />
            <path d={ft.rims[0]} class="bank" />
            <path d={ft.rims[1]} class="bank" />
          {:else if ft.kind === 'ice'}
            <path d={ft.d} class="icefloor" stroke-width={ft.w} />
            <path d={ft.rims[0]} class="icerim" />
            <path d={ft.rims[1]} class="icerim" />
            {#each ft.ticks as [x1, y1, x2, y2], ti (ti)}
              <line {x1} {y1} {x2} {y2} class="crack" />
            {/each}
          {:else if ft.kind === 'lava'}
            <path d={ft.d} class="lavaglow" stroke-width={ft.w + 7} />
            <path d={ft.d} class="lavafloor" stroke-width={ft.w} />
            <path d={ft.d} class="lavacore" stroke-width={ft.w * 0.4} />
            <path d={ft.rims[0]} class="lavarim" />
            <path d={ft.rims[1]} class="lavarim" />
          {:else}
            <path d={ft.d} class="canyonfloor" stroke-width={ft.w} />
            {#if ft.glowing}
              <path d={ft.d} class="fissureglow" stroke-width={ft.w + 5} />
              <path d={ft.d} class="fissure" stroke-width={ft.w * 0.45} />
            {/if}
            <path d={ft.rims[0]} class="rim" />
            <path d={ft.rims[1]} class="rim" />
            {#each ft.ticks as [x1, y1, x2, y2], ti (ti)}
              <line {x1} {y1} {x2} {y2} class="hachure" />
            {/each}
          {/if}
        {/each}

        <!-- survey grid, printed over the paint -->
        {#each Array(TERRAIN_W + 1) as _, gx (gx)}
          <line x1={gx * CELL} y1="0" x2={gx * CELL} y2={MH} class="grid" />
        {/each}
        {#each Array(TERRAIN_H + 1) as _, gy (gy)}
          <line x1="0" y1={gy * CELL} x2={MW} y2={gy * CELL} class="grid" />
        {/each}

        <!-- terrain glyphs: ink symbols that stray past their squares -->
        {#each glyphs as g, i (i)}
          <g transform="translate({g.x},{g.y}) scale({g.s})" class="tg tg-{g.k}">
            {#if g.k === 'r'}
              <path d="M-11,6 L-4,-7 L3,6 M-1,6 L6,-5 L13,6" />
            {:else if g.k === 'h'}
              <path d="M-9,4 Q0,-8 9,4" />
            {:else if g.k === 'c'}
              <circle r={5 + g.r * 5} />
              <path d="M-3,{2 + g.r * 2} a5,2.5 0 0 0 7,0.5" class="rimc" />
            {:else if g.k === 'd'}
              <path d="M-12,0 q4,-5 8,0 q4,5 8,0 q4,-5 8,0" />
            {:else if g.k === 'u'}
              {#if domed}
                <path d="M-8,5 a8,8 0 0 1 16,0 z" class="bld" />
                <rect x="-11" y="5" width="22" height="3" class="bld" />
                <circle cx={-2 + g.r * 4} cy="0" r="1.3" class="win" />
              {:else}
                <rect x="-10" y={-8 - g.r * 4} width="6" height={14 + g.r * 4} class="bld" />
                <rect x="-2" y={-14 - g.r * 4} width="6" height={20 + g.r * 4} class="bld" />
                <rect x="6" y="-5" width="5" height="11" class="bld" />
                <rect x="0" y={-11 - g.r * 4} width="2" height="2" class="win" />
                <rect x="-8" y={-5 - g.r * 4} width="2" height="2" class="win" />
              {/if}
            {:else if g.k === 'f'}
              <path d="M-5,5 L0,-6 L5,5 Z" class="tree" />
              <path d="M{4 + g.r * 6},7 L{8 + g.r * 6},-2 L{12 + g.r * 6},7 Z" class="tree" />
            {:else if g.k === 'm'}
              <path d="M-10,4 h6 M-1,6 h7 M-6,2 v-6 M-3,3 v-7 M0,2 v-6" />
            {:else if g.k === 'i'}
              <path d="M-8,4 L-1,-2 L4,2 L10,-4 M-1,-2 L2,-7" />
            {:else if g.k === 'l'}
              <path d="M-11,3 L-5,-3 L0,3 L6,-2 L11,4" />
            {:else}
              <path d="M-4,3 l2,-6 M2,4 l2,-6" />
            {/if}
          </g>
        {/each}

        <!-- compass rose, overprinted by the action like a real map -->
        <g transform="translate(46,{MH - 48})" class="rose">
          <circle r="16" />
          <circle r="12.5" class="rose2" />
          <path d={ROSE_DIAG} class="rosediag" />
          <path d={ROSE_MAIN} class="rosemain" />
          <circle r="1.6" class="rosedot" />
          <text y="-21" class="maptext rosen">N</text>
        </g>

        <!-- the colony: star-fort citadel + city label -->
        <g transform="translate({cc(colonyAnchor[0], colonyAnchor[1])[0]},{cc(colonyAnchor[0], colonyAnchor[1])[1]})">
          <path d={FORT} class="fort" style="stroke:{defColor}" />
          <circle r="4.5" class="keep" style="stroke:{defColor}" />
          <line x1="0" y1="-18" x2="0" y2="-31" style="stroke:{defColor};stroke-width:1.8" />
          <path d="M0,-31 l11,3.5 l-11,3.5 z" fill={done && p.captured ? atkColor : defColor} />
          <text x="18" y="30" class="maptext city" text-anchor="end">{p.colonyName}</text>
        </g>
      </g>

      <!-- neatline + margin furniture -->
      <rect x={PAD_L - 7} y={PAD_T - 7} width={MW + 14} height={MH + 14} class="neat" />
      <rect x={PAD_L - 3} y={PAD_T - 3} width={MW + 6} height={MH + 6} class="neat2" />
      {#each Array(TERRAIN_W) as _, i (i)}
        <text x={PAD_L + (i + 0.5) * CELL} y={PAD_T - 11} class="maptext coord">{COLS[i]}</text>
      {/each}
      {#each Array(TERRAIN_H) as _, i (i)}
        <text x={PAD_L - 13} y={PAD_T + (i + 0.5) * CELL + 3.5} class="maptext coord">{i + 1}</text>
      {/each}
      <g transform="translate({PAD_L},{VH - 26})" class="scalebar">
        {#each [0, 1, 2, 3] as i (i)}
          <rect x={i * 30} y="0" width="30" height="5" class={i % 2 === 0 ? 'segfill' : 'segopen'} />
        {/each}
        <text x="0" y="-3" class="maptext scalelab">0</text>
        <text x="60" y="-3" class="maptext scalelab">5</text>
        <text x="120" y="-3" class="maptext scalelab">10 km</text>
      </g>
      <text x={PAD_L + MW} y={VH - 18} class="maptext survey" text-anchor="end"
        >SURVEY OF {p.colonyName.toUpperCase()}{p.climate ? ` · ${p.climate.toUpperCase()} THEATRE` : ''}</text>

      <!-- paper grain + fold creases over everything printed -->
      <rect x="7" y="7" width={VW - 14} height={VH - 14} filter="url(#gb-grain)" class="grain" />
      <line x1={VW / 3} y1="8" x2={VW / 3} y2={VH - 8} class="fold" />
      <line x1={(2 * VW) / 3} y1="8" x2={(2 * VW) / 3} y2={VH - 8} class="fold" />
      <line x1="8" y1={VH / 2} x2={VW - 8} y2={VH / 2} class="fold" />

      <!-- the live action: grease-pencil arrows, fire, counters -->
      <g transform="translate({PAD_L},{PAD_T})" clip-path="url(#gb-field)">
        {#each [...model.atk, ...model.def] as b (b.side + b.id)}
          {@const pts = planPts(b)}
          {@const hd = headOf(pts)}
          <path d={arrowD(pts)} class="arrow" style="stroke:{b.side === 'atk' ? atkColor : defColor}" />
          {#if hd}
            <path
              d="M0,0 L-9,4.2 L-9,-4.2 Z"
              transform="translate({hd.x},{hd.y}) rotate({hd.deg})"
              class="ahead"
              style="fill:{b.side === 'atk' ? atkColor : defColor}"
            />
          {/if}
        {/each}

        <!-- tracer fire between engaged battalions -->
        {#key stepNow}
          <g>
            {#each fire.shots as sh, i (i)}
              <line x1={sh.x1} y1={sh.y1} x2={sh.x2} y2={sh.y2} class="shot" style="stroke:{sh.side === 'atk' ? atkColor : defColor}" />
            {/each}
            {#each fire.impacts as [ix, iy], i (i)}
              <g transform="translate({ix},{iy})" class="impact">
                <circle r="8" />
                <circle r="3.5" />
              </g>
            {/each}
          </g>
        {/key}

        <!-- battalions: small NATO counters; dead ones leave an ✕ -->
        {#each [...model.def, ...model.atk] as b (b.side + b.id)}
          {@const alive = stepNow < b.deathStep}
          {@const [bx, by] = posAt(b, stepNow)}
          {#if alive}
            <g transform="translate({bx},{by})" class="bn">
              <rect x="-12.8" y="-6.7" width="28" height="17" rx="1.5" class="bnshadow" />
              <rect x="-14" y="-8.5" width="28" height="17" rx="1.5" fill={b.side === 'atk' ? atkColor : defColor} class="bnbox" />
              {#if b.kind === 'marine'}
                <line x1="-14" y1="-8.5" x2="14" y2="8.5" class="bnmark" />
                <line x1="-14" y1="8.5" x2="14" y2="-8.5" class="bnmark" />
                <rect x="-3.6" y="-16.5" width="2.4" height="5.5" class="pip" />
                <rect x="1.2" y="-16.5" width="2.4" height="5.5" class="pip" />
              {:else}
                <line x1="-14" y1="8.5" x2="14" y2="-8.5" class="bnmark" />
                <rect x="-1.2" y="-16.5" width="2.4" height="5.5" class="pip" />
              {/if}
              <rect x="-14" y="-8.5" width="28" height="17" rx="1.5" fill="none" class="bnframe" />
            </g>
          {:else if Number.isFinite(b.deathStep)}
            <g transform="translate({bx},{by})" class="fallen">
              <line x1="-6" y1="-6" x2="6" y2="6" />
              <line x1="-6" y1="6" x2="6" y2="-6" />
            </g>
          {/if}
        {/each}

        <!-- combat flashes where a battalion breaks this step -->
        {#each bursts as [fx, fy], i (i)}
          <g transform="translate({fx},{fy})" class="burst">
            <circle r="11" />
            <circle r="5" />
          </g>
        {/each}
      </g>
    </svg>

    <div class="foot">
      <span style="color:{atkColor}">⚔ {cur.t} marine{cur.t === 1 ? '' : 's'}</span>
      <span style="color:{defColor}">🛡 {garAlive} garrison + {Math.max(0, cur.m - garAlive)} militia</span>
      <span class="spacer"></span>
      {#if done}
        <b class="outcome" style="color:{p.captured ? atkColor : defColor}" data-testid="ground-outcome">
          {p.captured ? `${p.colonyName} CAPTURED` : 'invasion repelled'}{p.civilianLosses ? ` · ${p.civilianLosses} civilian unit${p.civilianLosses > 1 ? 's' : ''} lost` : ''}
        </b>
        <button class="mini" onclick={() => { step = 0; playing = true; }}>↺ replay</button>
      {:else}
        <button class="mini" onclick={() => (playing = !playing)}>{playing ? '⏸' : '▶'}</button>
        <span class="dim">round {stepNow + 1}/{S}</span>
      {/if}
    </div>
  </div>
</div>

<style>
  .overlay {
    position: fixed;
    inset: 0;
    z-index: 46;
    background: rgba(0, 0, 0, 0.75);
    display: flex;
    align-items: center;
    justify-content: center;
  }
  .panel {
    background: var(--panel);
    border: 1px solid var(--line-bright);
    border-radius: 8px;
    padding: 0.7rem 0.9rem 0.8rem;
    max-width: 940px;
    width: 94vw;
    box-shadow: 0 14px 60px rgba(0, 0, 0, 0.65);
  }
  h3 {
    margin: 0 0 0.3rem;
    display: flex;
    justify-content: space-between;
    align-items: center;
    gap: 0.6rem;
  }
  .dim {
    color: var(--text-dim);
    font-weight: 400;
  }
  .x {
    padding: 0.05rem 0.45rem;
  }
  .tactics {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    margin: 0 0 0.45rem;
    font-size: 0.82rem;
    flex-wrap: wrap;
    text-transform: capitalize;
  }
  .legend {
    margin-left: auto;
    display: flex;
    gap: 0.55rem;
    flex-wrap: wrap;
    text-transform: none;
  }
  .lg {
    display: inline-flex;
    align-items: center;
    gap: 0.25rem;
    font-size: 0.68rem;
    color: var(--text-dim);
  }
  .lg i {
    width: 0.7rem;
    height: 0.7rem;
    border-radius: 2px;
    border: 1px solid rgba(0, 0, 0, 0.4);
  }
  /* the war table: dark planked wood under the chart */
  .scene {
    display: block;
    width: 100%;
    max-height: min(68vh, 640px);
    border: 1px solid #120d08;
    border-radius: 4px;
    background:
      repeating-linear-gradient(100deg, rgba(0, 0, 0, 0) 0 46px, rgba(0, 0, 0, 0.16) 46px 48px),
      linear-gradient(100deg, #3a2b1c, #241a10 55%, #2e2216);
  }
  .pshadow {
    fill: rgba(0, 0, 0, 0.55);
  }
  .paper {
    fill: url(#gb-paper);
    stroke: #b89e6e;
    stroke-width: 1.2;
  }
  .grain {
    opacity: 0.13;
    pointer-events: none;
  }
  .fold {
    stroke: rgba(70, 50, 25, 0.06);
    stroke-width: 2.5;
  }
  .neat {
    fill: none;
    stroke: #4a3a26;
    stroke-width: 1.8;
    opacity: 0.8;
  }
  .neat2 {
    fill: none;
    stroke: #4a3a26;
    stroke-width: 0.7;
    opacity: 0.7;
  }
  .maptext {
    font-family: Georgia, 'Times New Roman', serif;
    fill: #6b5638;
  }
  .coord {
    font-size: 10px;
    text-anchor: middle;
    opacity: 0.8;
  }
  .scalebar .segfill {
    fill: #4a3a26;
    stroke: #4a3a26;
    stroke-width: 0.8;
  }
  .scalebar .segopen {
    fill: none;
    stroke: #4a3a26;
    stroke-width: 0.8;
  }
  .scalelab {
    font-size: 8.5px;
    text-anchor: middle;
    opacity: 0.85;
  }
  .survey {
    font-size: 9px;
    font-style: italic;
    letter-spacing: 0.12em;
    opacity: 0.7;
  }
  .grid {
    stroke: #5c4a30;
    stroke-width: 1;
    opacity: 0.14;
  }
  /* linear features */
  .sea {
    fill: rgba(101, 146, 176, 0.62);
  }
  .shallows {
    fill: none;
    stroke: #b8d4e2;
    stroke-width: 5;
    opacity: 0.55;
  }
  .coast {
    fill: none;
    stroke: #3e627c;
    stroke-width: 1.8;
    opacity: 0.85;
  }
  .wave {
    fill: none;
    stroke: #3e627c;
    stroke-width: 1.2;
    opacity: 0.6;
  }
  .riverbed {
    fill: none;
    stroke: #4a708c;
    stroke-linecap: round;
    opacity: 0.35;
  }
  .water {
    fill: none;
    stroke: #a9c9da;
    stroke-linecap: round;
    opacity: 0.85;
  }
  .bank {
    fill: none;
    stroke: #4a708c;
    stroke-width: 1.3;
    opacity: 0.75;
  }
  .canyonfloor {
    fill: none;
    stroke: #6b5138;
    stroke-linecap: round;
    opacity: 0.45;
  }
  .rim {
    fill: none;
    stroke: #55432c;
    stroke-width: 1.4;
    opacity: 0.85;
  }
  .hachure {
    stroke: #55432c;
    stroke-width: 1.1;
    opacity: 0.6;
  }
  .fissureglow {
    fill: none;
    stroke: #59e0d8;
    stroke-linecap: round;
    opacity: 0.12;
  }
  .fissure {
    fill: none;
    stroke: #59e0d8;
    stroke-linecap: round;
    opacity: 0.4;
  }
  .lavaglow {
    fill: none;
    stroke: #ff9a4e;
    stroke-linecap: round;
    opacity: 0.2;
  }
  .lavafloor {
    fill: none;
    stroke: #cf4f24;
    stroke-linecap: round;
    opacity: 0.85;
  }
  .lavacore {
    fill: none;
    stroke: #ffb066;
    stroke-linecap: round;
    opacity: 0.5;
  }
  .lavarim {
    fill: none;
    stroke: #3c2018;
    stroke-width: 1.3;
    opacity: 0.7;
  }
  .icefloor {
    fill: none;
    stroke: #d8e8f2;
    stroke-linecap: round;
    opacity: 0.9;
  }
  .icerim {
    fill: none;
    stroke: #8fb2c8;
    stroke-width: 1.2;
    opacity: 0.8;
  }
  .crack {
    stroke: #8fb2c8;
    stroke-width: 1;
    opacity: 0.7;
  }
  /* hand-drawn terrain symbols in sepia ink */
  .tg path {
    fill: none;
    stroke-width: 1.7;
    stroke-linecap: round;
    stroke-linejoin: round;
    opacity: 0.7;
  }
  .tg circle {
    fill: none;
    stroke-width: 1.6;
    opacity: 0.65;
  }
  .tg-r path { stroke: #5c4a30; }
  .tg-h path { stroke: #77603a; }
  .tg-c circle, .tg-c path { stroke: #6b5b45; }
  .tg-c .rimc { stroke-width: 1.1; opacity: 0.5; }
  .tg-d path { stroke: #9a7038; }
  .tg-f .tree { fill: #4f7a44; stroke: #2e4f2a; stroke-width: 1; opacity: 0.85; }
  .tg-m path { stroke: #4d6b52; }
  .tg-i path { stroke: #7a9ab0; opacity: 0.8; }
  .tg-l path { stroke: #c0502a; opacity: 0.75; }
  .tg-p path { stroke: #7a7a4a; opacity: 0.6; }
  .tg-u .bld { fill: #6b6474; stroke: #3a3644; stroke-width: 1; opacity: 0.9; }
  .tg-u .win { fill: #e8d87c; stroke: none; opacity: 0.9; }
  /* compass rose */
  .rose {
    opacity: 0.55;
  }
  .rose circle {
    fill: none;
    stroke: #5c4a30;
    stroke-width: 1;
  }
  .rose .rose2 {
    stroke-width: 0.5;
  }
  .rose .rosediag {
    fill: #8a7350;
    stroke: none;
  }
  .rose .rosemain {
    fill: #5c4a30;
    stroke: none;
  }
  .rose .rosedot {
    fill: #ead9b6;
    stroke: #5c4a30;
    stroke-width: 0.7;
  }
  .rosen {
    font-size: 10px;
    text-anchor: middle;
    fill: #5c4a30;
  }
  /* the citadel + city label */
  .fort {
    fill: rgba(0, 0, 0, 0.15);
    stroke-width: 2;
    stroke-linejoin: round;
  }
  .keep {
    fill: rgba(0, 0, 0, 0.2);
    stroke-width: 1.3;
  }
  .city {
    font-size: 11.5px;
    font-weight: 600;
    fill: #3a3026;
    paint-order: stroke;
    stroke: #ecdfc0;
    stroke-width: 3px;
    stroke-linejoin: round;
  }
  /* grease-pencil plan arrows */
  .arrow {
    fill: none;
    stroke-width: 2.4;
    stroke-dasharray: 7 5;
    opacity: 0.45;
    stroke-linecap: round;
  }
  .ahead {
    opacity: 0.55;
  }
  .shot {
    stroke-width: 1.7;
    stroke-dasharray: 6 4.5;
    opacity: 0.35;
    animation: shot 0.24s linear;
  }
  @keyframes shot {
    from {
      opacity: 0.95;
      stroke-dashoffset: 24;
    }
    to {
      opacity: 0.35;
      stroke-dashoffset: 0;
    }
  }
  .impact circle {
    fill: none;
    stroke: #b8541e;
    stroke-width: 2.2;
    animation: burst 0.3s ease-out;
  }
  /* battalion counters: little cardboard chits */
  .bnshadow {
    fill: rgba(30, 20, 8, 0.35);
  }
  .bnbox {
    opacity: 0.95;
  }
  .bnframe {
    stroke: #1c150c;
    stroke-width: 1.6;
  }
  .bnmark {
    stroke: #1c150c;
    stroke-width: 1.8;
  }
  .pip {
    fill: #1c150c;
    opacity: 0.85;
  }
  .bn {
    transition: transform 0.18s linear;
  }
  .fallen line {
    stroke: #5c4a30;
    stroke-width: 2.2;
    opacity: 0.55;
  }
  .burst circle {
    fill: none;
    stroke: #d4691e;
    stroke-width: 2.6;
    animation: burst 0.4s ease-out;
  }
  @keyframes burst {
    from {
      opacity: 1;
      transform: scale(0.4);
    }
    to {
      opacity: 0.4;
      transform: scale(1);
    }
  }
  @media (prefers-reduced-motion: reduce) {
    .bn {
      transition: none;
    }
    .burst circle,
    .impact circle,
    .shot {
      animation: none;
    }
  }
  .foot {
    display: flex;
    align-items: center;
    gap: 1rem;
    margin-top: 0.5rem;
    font-size: 0.85rem;
  }
  .spacer {
    flex: 1;
  }
  .outcome {
    text-transform: uppercase;
    letter-spacing: 0.04em;
  }
  .mini {
    padding: 0.1rem 0.5rem;
  }
</style>
