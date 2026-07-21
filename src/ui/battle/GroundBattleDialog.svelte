<script lang="ts">
  // Invasion playback, tabletop edition (bugs.md rounds 6-7): a TOP-DOWN
  // theater map in the language of classic battle cartography — hand-drawn
  // terrain glyphs that spill over the grid, NATO battalion boxes (crossed =
  // marines, single slash = militia), tactic arrows, and tracer fire between
  // engaged battalions. The defense HOLDS ITS LINE and only falls back toward
  // the colony while it is losing; attackers press up to contact in front of
  // (or around) that line and advance as it yields. Terrain is the planet's
  // one deterministic map; participants-only data (GroundBattleEntry).
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
  /** payload carries the exact map since 0.23.0; older entries approximate
   * from (colonyId, climate) — same generator, plausible stand-in */
  const terrain = $derived(
    (p as { terrain?: string[] }).terrain ?? generateTerrain(p.colonyId, p.climate ?? 'barren'),
  );
  const atkTactic = $derived((p as { atkTactic?: string }).atkTactic ?? 'charge');
  const defTactic = $derived((p as { defTactic?: string }).defTactic ?? 'long_line');
  const pretty = (id: string) => id.replaceAll('_', ' ');
  /** terrain kinds present, for the legend */
  const legend = $derived.by(() => {
    const seen = new Map<string, number>();
    for (const row of terrain) for (const ch of row) seen.set(ch, (seen.get(ch) ?? 0) + 1);
    return [...seen.entries()].sort((a, b) => b[1] - a[1]).map(([ch]) => TERRAIN_INFO[ch]!).filter(Boolean);
  });

  const rng = (i: number, salt: number): number => (((i * 7919 + salt * 104729 + p.colonyId * 31) % 233) / 233);

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
  function planArrow(b: Battalion): string {
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
    return arrowD(pts.map(([x, y]) => cc(x, y)));
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
        {#each legend as t (t.id)}
          <span class="lg"><i style="background:{t.color}"></i>{t.name}{t.defBonus ? ` +${Math.round(t.defBonus * 100)}%` : ''}</span>
        {/each}
      </span>
    </p>

    <svg viewBox="0 0 {MW} {MH}" class="scene" aria-hidden="true">
      <!-- terrain zones: the planet's one true map -->
      {#each terrain as row, ty (ty)}
        {#each row.split('') as ch, tx (tx)}
          <rect x={tx * CELL} y={ty * CELL} width={CELL} height={CELL} fill={TERRAIN_INFO[ch]?.color ?? '#666'} class="cell" />
        {/each}
      {/each}
      {#each Array(TERRAIN_W + 1) as _, gx (gx)}
        <line x1={gx * CELL} y1="0" x2={gx * CELL} y2={MH} class="grid" />
      {/each}
      {#each Array(TERRAIN_H + 1) as _, gy (gy)}
        <line x1="0" y1={gy * CELL} x2={MW} y2={gy * CELL} class="grid" />
      {/each}

      <!-- terrain glyphs: map symbols that stray past their squares -->
      {#each glyphs as g, i (i)}
        <g transform="translate({g.x},{g.y}) scale({g.s})" class="tg tg-{g.k}">
          {#if g.k === 'r'}
            <path d="M-11,6 L-4,-7 L3,6 M-1,6 L6,-5 L13,6" />
          {:else if g.k === 'h'}
            <path d="M-9,4 Q0,-8 9,4" />
          {:else if g.k === 'c'}
            <circle r={5 + g.r * 5} />
            <path d="M-3,{2 + g.r * 2} a5,2.5 0 0 0 7,0.5" class="rim" />
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

      <!-- the colony: fortress mark at its urban anchor -->
      <g transform="translate({cc(colonyAnchor[0], colonyAnchor[1])[0]},{cc(colonyAnchor[0], colonyAnchor[1])[1]})">
        <rect x="-16" y="-16" width="32" height="32" class="fort" style="stroke:{defColor}" />
        <rect x="-9" y="-9" width="18" height="18" class="fort" style="stroke:{defColor}" />
        <line x1="0" y1="-16" x2="0" y2="-30" style="stroke:{defColor};stroke-width:2" />
        <path d="M0,-30 l12,4 l-12,4 z" fill={done && p.captured ? atkColor : defColor} />
      </g>

      <!-- tactic arrows: each side's plan, cartography style -->
      {#each model.atk as b (b.id)}
        <path d={planArrow(b)} class="arrow" style="stroke:{atkColor}" />
      {/each}
      {#each model.def as b (b.id)}
        <path d={planArrow(b)} class="arrow" style="stroke:{defColor}" />
      {/each}

      <!-- tracer fire between engaged battalions -->
      {#key stepNow}
        <g>
          {#each fire.shots as sh, i (i)}
            <line x1={sh.x1} y1={sh.y1} x2={sh.x2} y2={sh.y2} class="shot" style="stroke:{sh.side === 'atk' ? atkColor : defColor}" />
          {/each}
          {#each fire.impacts as [ix, iy], i (i)}
            <g transform="translate({ix},{iy})" class="impact">
              <circle r="10" />
              <circle r="4" />
            </g>
          {/each}
        </g>
      {/key}

      <!-- battalions: NATO boxes; dead ones leave an ✕ where they fell -->
      {#each [...model.def, ...model.atk] as b (b.side + b.id)}
        {@const alive = stepNow < b.deathStep}
        {@const [bx, by] = posAt(b, stepNow)}
        {#if alive}
          <g transform="translate({bx},{by})" class="bn">
            <rect x="-21" y="-13" width="42" height="26" fill={b.side === 'atk' ? atkColor : defColor} class="bnbox" />
            {#if b.kind === 'marine'}
              <line x1="-21" y1="-13" x2="21" y2="13" class="bnmark" />
              <line x1="-21" y1="13" x2="21" y2="-13" class="bnmark" />
            {:else}
              <line x1="-21" y1="13" x2="21" y2="-13" class="bnmark" />
            {/if}
            <rect x="-21" y="-13" width="42" height="26" fill="none" class="bnframe" />
          </g>
        {:else if Number.isFinite(b.deathStep)}
          <g transform="translate({bx},{by})" class="fallen">
            <line x1="-8" y1="-8" x2="8" y2="8" />
            <line x1="-8" y1="8" x2="8" y2="-8" />
          </g>
        {/if}
      {/each}

      <!-- combat flashes where a battalion breaks this step -->
      {#each bursts as [fx, fy], i (i)}
        <g transform="translate({fx},{fy})" class="burst">
          <circle r="13" />
          <circle r="6" />
        </g>
      {/each}
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
    max-width: 900px;
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
  .scene {
    display: block;
    width: 100%;
    border: 1px solid var(--line);
    border-radius: 4px;
    background: #0a0c08;
  }
  .cell {
    filter: brightness(0.62) saturate(0.85);
  }
  .grid {
    stroke: rgba(0, 0, 0, 0.25);
    stroke-width: 1;
  }
  /* hand-drawn terrain symbols (dimmed to sit under the action) */
  .tg path {
    fill: none;
    stroke-width: 2.2;
    stroke-linecap: round;
    stroke-linejoin: round;
    opacity: 0.55;
  }
  .tg circle {
    fill: none;
    stroke-width: 2;
    opacity: 0.5;
  }
  .tg-r path { stroke: #3c342c; }
  .tg-h path { stroke: #4e4428; }
  .tg-c circle, .tg-c path { stroke: #322d24; }
  .tg-c .rim { stroke-width: 1.4; opacity: 0.4; }
  .tg-d path { stroke: #7a5e2c; }
  .tg-f .tree { fill: #24401f; stroke: #1a3018; stroke-width: 1.2; opacity: 0.8; }
  .tg-m path { stroke: #2c473d; }
  .tg-i path { stroke: #dbeef6; opacity: 0.5; }
  .tg-l path { stroke: #e05a2c; opacity: 0.7; }
  .tg-p path { stroke: #55613a; opacity: 0.5; }
  .tg-u .bld { fill: #565664; stroke: #26262e; stroke-width: 1.2; opacity: 0.9; }
  .tg-u .win { fill: #cfd67a; stroke: none; opacity: 0.8; }
  .fort {
    fill: rgba(0, 0, 0, 0.35);
    stroke-width: 2.5;
  }
  .arrow {
    fill: none;
    stroke-width: 7;
    opacity: 0.22;
    stroke-linecap: round;
  }
  .shot {
    stroke-width: 2.2;
    stroke-dasharray: 7 5;
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
    stroke: #ffe08a;
    stroke-width: 2.5;
    animation: burst 0.3s ease-out;
  }
  .bnbox {
    opacity: 0.92;
  }
  .bnframe {
    stroke: #10120c;
    stroke-width: 2;
  }
  .bnmark {
    stroke: #10120c;
    stroke-width: 2.4;
  }
  .bn {
    transition: transform 0.18s linear;
  }
  .fallen line {
    stroke: #d8d2c0;
    stroke-width: 3;
    opacity: 0.6;
  }
  .burst circle {
    fill: none;
    stroke: #ffd061;
    stroke-width: 3;
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
