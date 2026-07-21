<script lang="ts">
  // Invasion playback, tabletop edition (bugs.md round 6): a TOP-DOWN theater
  // map in the language of classic battle cartography — terrain zones, NATO
  // battalion boxes (crossed = marines, single slash = militia), and big
  // tactic arrows showing each side's plan, animated over the recorded
  // rounds. The terrain is the planet's one deterministic map; tactics shape
  // the approach paths. Participants-only data (GroundBattleEntry).
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

  // ---- battalions: up to 6 boxes per side sharing the units evenly ----
  interface Battalion {
    id: number;
    side: 'atk' | 'def';
    kind: 'marine' | 'militia';
    path: Array<[number, number]>; // px waypoints, index 0 = deployment
    deathStep: number; // Infinity = survives
  }

  /** cell center in px */
  const cc = (x: number, y: number): [number, number] => [(x + 0.5) * CELL, (y + 0.5) * CELL];

  /** first step at which this battalion's share of units is gone; battalion 0
   * dies LAST (higher ids are the lead elements) */
  function deathOf(perStep: number[], nBns: number, id: number): number {
    const per = perStep[0]! / nBns;
    const floor = (nBns - 1 - id) * per + 0.01;
    for (let s = 0; s < perStep.length; s++) if (perStep[s]! <= floor) return s;
    return Infinity;
  }

  const colonyAnchor: [number, number] = [TERRAIN_W - 1.2, TERRAIN_H / 2 - 0.5];

  /** attacker paths per tactic: from the left-edge staging to the colony */
  function atkPaths(n: number, tactic: string): Array<Array<[number, number]>> {
    const [gx, gy] = colonyAnchor;
    const out: Array<Array<[number, number]>> = [];
    const lane = (i: number) => 0.8 + ((i + 0.5) * (TERRAIN_H - 1.6)) / n;
    for (let i = 0; i < n; i++) {
      const y0 = lane(i);
      const start: [number, number] = [0.4, y0];
      const mid: [number, number] = [TERRAIN_W * 0.45, y0];
      const near: [number, number] = [gx - 1.6, gy + (i - (n - 1) / 2) * 0.8];
      switch (tactic) {
        case 'flank': {
          const side = rng(1, 9) < 0.5 ? 0.6 : TERRAIN_H - 0.6; // seeded wing side
          if (i >= Math.ceil(n * 0.66)) {
            out.push([start, [TERRAIN_W * 0.5, side], [gx - 0.6, side], [gx - 0.4, gy]]);
          } else out.push([start, mid, near]);
          break;
        }
        case 'pincer': {
          if (i === 0 && n > 1) out.push([start, [TERRAIN_W * 0.55, 0.5], [gx - 0.5, 0.6], [gx - 0.3, gy - 0.8]]);
          else if (i === n - 1 && n > 1)
            out.push([start, [TERRAIN_W * 0.55, TERRAIN_H - 0.5], [gx - 0.5, TERRAIN_H - 0.6], [gx - 0.3, gy + 0.8]]);
          else out.push([start, mid, near]);
          break;
        }
        case 'surround': {
          const th = -Math.PI / 2 + (Math.PI * (i + 0.5)) / n; // arc around the colony
          out.push([start, [TERRAIN_W * 0.5, y0], [gx - 1 + Math.cos(th) * 2.2, gy + Math.sin(th) * 2.6], [gx - 0.4, gy + Math.sin(th) * 1.2]]);
          break;
        }
        case 'infiltrate': {
          const wob: [number, number] = [TERRAIN_W * (0.3 + rng(i, 3) * 0.35), 0.6 + rng(i, 4) * (TERRAIN_H - 1.2)];
          out.push([start, wob, [gx - 1.2, gy + (rng(i, 5) - 0.5) * 3], near]);
          break;
        }
        case 'hammer_and_anvil': {
          if (i < Math.ceil(n / 2)) out.push([start, [TERRAIN_W * 0.55, y0], [TERRAIN_W * 0.62, gy + (i - n / 4) * 0.9]]); // the anvil holds
          else out.push([start, [TERRAIN_W * 0.35, 0.8], [gx - 1.2, 1], [gx - 0.5, gy - 0.6]]); // the hammer swings high
          break;
        }
        case 'pinning': {
          out.push([start, [TERRAIN_W * 0.6, y0], [TERRAIN_W * 0.68, y0]]); // fix them, stand off
          break;
        }
        case 'bounding_overwatch': {
          const stagger = i % 2 === 0 ? 0.5 : 0.62;
          out.push([start, [TERRAIN_W * 0.3, y0], [TERRAIN_W * stagger, y0], near]);
          break;
        }
        default:
          out.push([start, mid, near]); // charge: straight at them
      }
    }
    return out.map((path) => path.map(([x, y]) => cc(x, y)));
  }

  /** defender positions per doctrine (garrison forward, militia behind) */
  function defPaths(n: number, tactic: string): Array<Array<[number, number]>> {
    const [gx, gy] = colonyAnchor;
    const out: Array<Array<[number, number]>> = [];
    for (let i = 0; i < n; i++) {
      switch (tactic) {
        case 'fortress': {
          const th = -Math.PI / 2 + (Math.PI * (i + 0.5)) / n;
          const post: [number, number] = [gx - 0.6 + Math.cos(th) * 1.1, gy + Math.sin(th) * 1.4];
          out.push([post, post]);
          break;
        }
        case 'long_line': {
          const y = 0.7 + ((i + 0.5) * (TERRAIN_H - 1.4)) / n;
          out.push([[gx - 2.2, y], [gx - 2.2, y]]);
          break;
        }
        case 'charge': {
          const y = 1 + ((i + 0.5) * (TERRAIN_H - 2)) / n;
          out.push([[gx - 1.4, y], [TERRAIN_W * 0.55, y]]); // sally out
          break;
        }
        default: {
          // defense_in_depth: two echelons
          const half = Math.ceil(n / 2);
          const echelon = i < half ? gx - 3 : gx - 1.4;
          const k = i < half ? i : i - half;
          const rows = i < half ? half : n - half;
          const y = 1 + ((k + 0.5) * (TERRAIN_H - 2)) / Math.max(1, rows);
          out.push([[echelon, y], [echelon, y]]);
        }
      }
    }
    return out.map((path) => path.map(([x, y]) => cc(x, y)));
  }

  const model = $derived.by(() => {
    const perT = rounds.map((r) => Math.max(0, r.t));
    const perM = rounds.map((r) => Math.max(0, r.m));
    const nAtk = Math.max(1, Math.min(6, Math.ceil(perT[0]! / 4)));
    const nDef = Math.max(1, Math.min(6, Math.ceil(perM[0]! / 4)));
    const garrison = Math.min(p.startGarrison ?? 0, perM[0]!);
    const garBns = Math.round((garrison / Math.max(1, perM[0]!)) * nDef);
    const aPaths = atkPaths(nAtk, atkTactic);
    const dPaths = defPaths(nDef, defTactic);
    const atk: Battalion[] = aPaths.map((path, i) => ({
      id: i,
      side: 'atk',
      kind: 'marine',
      path,
      deathStep: deathOf(perT, nAtk, i),
    }));
    const def: Battalion[] = dPaths.map((path, i) => ({
      id: i,
      side: 'def',
      // lead battalions (high ids die first) are the garrison marines
      kind: i >= nDef - garBns ? 'marine' : 'militia',
      path,
      deathStep: deathOf(perM, nDef, i),
    }));
    return { atk, def, unitsPerAtkBn: perT[0]! / nAtk, unitsPerDefBn: perM[0]! / nDef };
  });

  /** approach completes over the first ~third of the recorded rounds */
  const arrival = $derived(Math.max(1, Math.min(8, Math.floor(S / 3)) || 1));
  function posOf(b: Battalion, s: number): [number, number] {
    const q = Math.min(1, s / arrival);
    const segs = b.path.length - 1;
    if (segs <= 0) return b.path[0]!;
    const ft = q * segs;
    const i = Math.min(segs - 1, Math.floor(ft));
    const f = ft - i;
    const [x0, y0] = b.path[i]!;
    const [x1, y1] = b.path[i + 1]!;
    return [x0 + (x1 - x0) * f, y0 + (y1 - y0) * f];
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
  const bursts = $derived(
    [...model.atk, ...model.def]
      .filter((b) => b.deathStep === stepNow && stepNow > 0)
      .map((b) => posOf(b, Math.min(b.deathStep, arrival + 999))),
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
          {#if rng(tx * 31 + ty, 7) < 0.5}
            <rect x={tx * CELL + rng(tx + ty, 8) * (CELL - 12)} y={ty * CELL + rng(tx * 3 + ty, 9) * (CELL - 12)} width="9" height="9" fill="#000" opacity="0.12" />
          {/if}
        {/each}
      {/each}
      {#each Array(TERRAIN_W + 1) as _, gx (gx)}
        <line x1={gx * CELL} y1="0" x2={gx * CELL} y2={MH} class="grid" />
      {/each}
      {#each Array(TERRAIN_H + 1) as _, gy (gy)}
        <line x1="0" y1={gy * CELL} x2={MW} y2={gy * CELL} class="grid" />
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
        <path d={arrowD(b.path)} class="arrow" style="stroke:{atkColor}" />
      {/each}
      {#each model.def as b (b.id)}
        <path d={arrowD(b.path)} class="arrow" style="stroke:{defColor}" />
      {/each}

      <!-- battalions: NATO boxes; dead ones leave an ✕ where they fell -->
      {#each [...model.def, ...model.atk] as b (b.side + b.id)}
        {@const alive = stepNow < b.deathStep}
        {@const [bx, by] = posOf(b, Math.min(stepNow, Number.isFinite(b.deathStep) ? b.deathStep : stepNow))}
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
    .burst circle {
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
