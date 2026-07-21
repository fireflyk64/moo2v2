<script lang="ts">
  // Cinematic invasion playback: a line-art battlefield where the attacker's
  // marines charge in from the left toward the defenders bunched behind a
  // barricade on the right, figures falling where they die as the recorded
  // rounds play out. Scenery follows the world: ocean water, farm buildings,
  // or domed cities. Participants-only data (GroundBattleEntry).
  import { playerColor } from '../colors';
  import type { GroundBattleEntry } from '../state.svelte';

  let { battle, onclose }: { battle: GroundBattleEntry; onclose: () => void } = $props();

  const p = $derived(battle.payload);
  const rounds = $derived(p.rounds.length ? p.rounds : [{ t: p.startTroops, m: p.startMilitia }]);
  const S = $derived(rounds.length);

  let step = $state(0);
  let playing = $state(true);
  $effect(() => {
    // a different battle in the same dialog restarts the playback
    void battle;
    step = 0;
    playing = true;
  });
  $effect(() => {
    if (!playing) return;
    const iv = setInterval(() => {
      if (step < S - 1) step++;
      else playing = false;
    }, 170);
    return () => clearInterval(iv);
  });

  const cur = $derived(rounds[Math.min(step, S - 1)]!);
  const done = $derived(step >= S - 1);
  const atkColor = $derived(playerColor(p.attacker));
  const defColor = $derived(playerColor(p.defender));
  const scene = $derived(p.climate === 'ocean' ? 'ocean' : p.farming ? 'farm' : 'domes');

  // ---- battlefield geometry ----
  const START_X = 46; // attacker staging anchor
  const LINE_X = 528; // where the charge stops and the firefight holds
  const BARR_X = 576; // defender barricade
  const MAXF = 18; // figures drawn per side (bigger armies scale down)

  // deterministic jitter so formations look organic but never flicker
  const jig = (i: number, salt: number): number => (((i * 7919 + salt * 104729) % 233) / 233 - 0.5) * 2;

  interface Fig {
    id: number; // alive while id < displayed-count for the step
    xOff: number; // attackers: offset from the advancing anchor
    x: number; // defenders: fixed slot
    y: number;
    kind: 'marine' | 'militia';
    deathStep: number; // Infinity = survives
    deathX: number;
    ph: number; // gait phase
  }

  const model = $derived.by(() => {
    const startT = rounds[0]!.t;
    const startM = rounds[0]!.m;
    const aScale = Math.max(1, startT / MAXF);
    const dScale = Math.max(1, startM / MAXF);
    const dispT = rounds.map((r) => (r.t <= 0 ? 0 : Math.max(1, Math.round(r.t / aScale))));
    const dispM = rounds.map((r) => (r.m <= 0 ? 0 : Math.max(1, Math.round(r.m / dScale))));
    for (let i = 1; i < S; i++) {
      // rounding safety: displayed strength never rises
      dispT[i] = Math.min(dispT[i]!, dispT[i - 1]!);
      dispM[i] = Math.min(dispM[i]!, dispM[i - 1]!);
    }
    const arrival = Math.max(1, Math.min(10, S - 1));
    const anchorAt = (s: number): number => {
      const t = Math.min(1, s / arrival);
      const e = 1 - (1 - t) * (1 - t); // ease-out: the charge slows as it closes
      return START_X + e * (LINE_X - START_X);
    };
    const deathOf = (disp: number[], id: number): number => {
      for (let s = 0; s < disp.length; s++) if (disp[s]! <= id) return s;
      return Infinity;
    };

    // attackers: a wedge whose highest ids run point (they die first)
    const nAtk = dispT[0]!;
    const atk: Fig[] = [];
    for (let i = 0; i < nAtk; i++) {
      const k = nAtk - 1 - i; // 0 = frontmost
      const row = k % 3;
      const xOff = -(Math.floor(k / 3) * 24 + row * 8) + jig(i, 1) * 4;
      const y = 258 + row * 15 + jig(i, 2) * 4;
      const ds = deathOf(dispT, i);
      atk.push({ id: i, xOff, x: 0, y, kind: 'marine', deathStep: ds, deathX: Number.isFinite(ds) ? Math.max(24, anchorAt(ds) + xOff) : 0, ph: i % 2 });
    }

    // defenders: garrison marines hold the barricade (high ids, die first);
    // civilian militia bunch up behind them
    const nDef = dispM[0]!;
    const garrison = Math.min(p.startGarrison ?? 0, startM);
    const nGar = Math.min(nDef, Math.round(garrison / dScale));
    const nMil = nDef - nGar;
    const def: Fig[] = [];
    for (let i = 0; i < nDef; i++) {
      const isGar = i >= nMil;
      let x: number, y: number;
      if (isGar) {
        const k = nDef - 1 - i; // 0 = most forward
        x = BARR_X + 14 + Math.floor(k / 4) * 15 + jig(i, 3) * 3;
        y = 250 + (k % 4) * 15 + jig(i, 4) * 3;
      } else {
        const k = nMil - 1 - i;
        x = 660 + Math.floor(k / 4) * 19 + jig(i, 5) * 6;
        y = 248 + (k % 4) * 16 + jig(i, 6) * 4;
      }
      const ds = deathOf(dispM, i);
      def.push({ id: i, xOff: 0, x, y, kind: isGar ? 'marine' : 'militia', deathStep: ds, deathX: x, ph: i % 2 });
    }
    // painter's order: farther ranks (smaller y) draw first
    atk.sort((a, b) => a.y - b.y);
    def.sort((a, b) => a.y - b.y);
    return { dispT, dispM, atk, def, anchorAt, militiaCiv: startM - garrison };
  });

  const stepNow = $derived(Math.min(step, S - 1));
  const anchorX = $derived(model.anchorAt(stepNow));
  const arrived = $derived(anchorX >= LINE_X - 1);
  const bursts = $derived([
    ...model.atk.filter((f) => f.deathStep === stepNow && stepNow > 0).map((f) => ({ x: f.deathX, y: f.y })),
    ...model.def.filter((f) => f.deathStep === stepNow && stepNow > 0).map((f) => ({ x: f.deathX, y: f.y })),
  ]);
  const garAlive = $derived(Math.max(0, cur.m - model.militiaCiv));
  const milAlive = $derived(cur.m - garAlive);
  const winColor = $derived(p.captured ? atkColor : defColor);
  const flagColor = $derived(done && p.captured ? atkColor : defColor);

  // ---- figure art (feet at 0,0; drawn facing +x, defenders mirror) ----
  const LEGS = [
    'M0,-4.5 L-3.4,-0.2 M0,-4.5 L2.2,0', // stride A
    'M0,-4.5 L-1.6,0 M0,-4.5 L3.6,-0.8', // stride B
    'M0,-4.5 L-2.2,0 M0,-4.5 L2.2,0', // braced
  ];
  const ARM = 'M0,-9.2 L4.4,-7.8';
  const RIFLE = 'M0.6,-8.8 L7,-7.2';
  const PITCHFORK = 'M2.4,0 L4.1,-12.2 M2.9,-10.6 l-1.4,-2.6 M3.7,-10.8 l0,-2.8 M4.5,-11 l1.5,-2.4';
  const HELMET = 'M-2.8,-12.3 a3.2,3.2 0 0 1 6.4,0';

  // ---- scenery helpers ----
  function wavePath(y: number, amp: number, seg: number): string {
    let d = `M-10,${y}`;
    let s = 1;
    for (let x = -10; x < 810; x += seg) {
      d += ` q${seg / 2},${-amp * s} ${seg},0`;
      s = -s;
    }
    return d;
  }
  function cropRow(y: number, x0: number, x1: number, r: number): string {
    let d = '';
    for (let x = x0; x < x1; x += r * 2.6) d += `M${x},${y} a${r},${r} 0 0 1 ${r * 2},0 `;
    return d;
  }
  const STARS: Array<[number, number]> = Array.from({ length: 26 }, (_, i) => [((i * 173) % 79) * 10.1 + 4, (((i * 97) % 47) / 47) * 150 + 8]);
  const DOME_SKYLINE = Array.from({ length: 7 }, (_, i) => ({ x: 626 + i * 22, w: 13, h: 26 + (((i * 53) % 31) / 31) * 44 }));
</script>

<div class="overlay" role="dialog" aria-label="invasion playback">
  <div class="panel">
    <h3>
      <span>⚔ Invasion of {p.colonyName} <span class="dim">— turn {battle.turn}{p.climate ? ` · ${p.climate} world` : ''}</span></span>
      <button class="x" data-testid="ground-close" title="close" onclick={onclose}>✕</button>
    </h3>

    <svg viewBox="0 0 800 340" class="scene" aria-hidden="true">
      <!-- sky -->
      {#each STARS as [sx, sy], si (si)}
        <circle cx={sx} cy={sy} r={si % 3 ? 0.8 : 1.3} class="star" />
      {/each}
      <line x1="0" y1="186" x2="800" y2="186" class="horizon" />
      <circle cx="132" cy="60" r="17" class="moon" />
      <circle cx="126" cy="55" r="17" class="moonbite" />

      <!-- world scenery -->
      {#if scene === 'ocean'}
        <g class="bg ocean">
          <path d={wavePath(206, 4, 46)} />
          <path d={wavePath(222, 5, 60)} opacity="0.7" />
          <path d={wavePath(240, 6, 78)} opacity="0.45" />
          <path d="M150,204 q22,-14 46,0" class="islet" />
          <path d="M300,74 q7,-6 13,0 q7,-6 13,0 M356,96 q6,-5 11,0 q6,-5 11,0" class="gulls" />
          <!-- stilt colony platform the defenders hold -->
          <g class="structure">
            <line x1="612" y1="238" x2="796" y2="238" />
            <line x1="624" y1="238" x2="624" y2="298" />
            <line x1="700" y1="238" x2="700" y2="298" />
            <line x1="782" y1="238" x2="782" y2="298" />
            <path d="M648,238 a42,38 0 0 1 84,0" />
            <line x1="690" y1="200" x2="690" y2="184" />
          </g>
        </g>
      {:else if scene === 'farm'}
        <g class="bg farm">
          <!-- the charge crosses the crop fields -->
          <path d={cropRow(236, 30, 420, 5)} opacity="0.5" />
          <path d={cropRow(252, 16, 460, 6)} opacity="0.7" />
          <path d={cropRow(270, 4, 490, 7)} />
          {#each [70, 150, 230, 310, 390] as fx (fx)}
            <line x1={fx} y1="212" x2={fx} y2="224" class="fence" />
          {/each}
          <line x1="40" y1="216" x2="420" y2="216" class="fence" />
          <!-- barn + silo behind the defenders -->
          <g class="structure">
            <rect x="636" y="216" width="112" height="62" />
            <path d="M630,216 L692,182 L754,216 Z" />
            <rect x="676" y="244" width="30" height="34" />
            <path d="M676,244 L706,278 M706,244 L676,278" />
            <rect x="764" y="196" width="26" height="82" rx="3" />
            <path d="M764,196 a13,12 0 0 1 26,0" />
          </g>
        </g>
      {:else}
        <g class="bg domes">
          <!-- domed city the defenders hold -->
          <g class="structure">
            <path d="M600,298 a94,94 0 0 1 188,0" />
            {#each DOME_SKYLINE as b (b.x)}
              <rect x={b.x} y={298 - b.h} width={b.w} height={b.h} />
            {/each}
            <line x1="694" y1="204" x2="694" y2="182" />
            <circle cx="694" cy="179" r="2.4" class="beacon" />
            <path d="M506,298 a44,44 0 0 1 88,0" />
            <path d="M756,298 a40,40 0 0 1 80,0" opacity="0.6" />
          </g>
        </g>
      {/if}

      <!-- ground + barricade -->
      <line x1="0" y1="298" x2="800" y2="298" class="ground" />
      <path d="M40,304 h30 M120,306 h22 M250,305 h34 M430,304 h26 M600,306 h30 M720,304 h24" class="ground" opacity="0.35" />
      <g class="barricade">
        <path d="M562,298 a9,8 0 0 1 18,0 M572,290 a9,8 0 0 1 18,0 M582,298 a9,8 0 0 1 18,0" />
        <rect x="566" y="272" width="15" height="12" />
      </g>
      <!-- colony flag: the winner's colors fly when it's decided -->
      <g class="flag">
        <line x1="748" y1="298" x2="748" y2="252" />
        <path d="M748,252 L772,258 L748,264 Z" fill={flagColor} stroke="none" opacity={done ? 1 : 0.85} />
      </g>

      <!-- defenders (bunched, facing left) -->
      {#each model.def as f (f.id)}
        {#if f.deathStep <= stepNow}
          <g transform="translate({f.deathX},{f.y}) scale(-1,1) rotate(-76)" class="troop fallen" style="color:{defColor}">
            <circle cx="0.4" cy="-11.9" r="2.6" />
            <path d="M0,-9.6 L0,-4.5" class="torso" />
            <path d={LEGS[2]} />
          </g>
        {:else}
          <g transform="translate({f.x},{f.y}) scale(-1,1)" class="troop" style="color:{defColor}">
            <circle cx="0.4" cy="-11.9" r="2.6" />
            <path d="M0,-9.6 L0,-4.5" class="torso" />
            <path d={LEGS[2]} />
            {#if f.kind === 'marine'}
              <path d={HELMET} class="helm" />
              <path d={ARM} />
              <path d={RIFLE} class="rifle" />
            {:else}
              <path d="M0,-9.2 L2.6,-6.4" />
              <path d={PITCHFORK} class="tool" />
            {/if}
          </g>
        {/if}
      {/each}

      <!-- attackers (charging right; the fallen stay where they dropped) -->
      {#each model.atk as f (f.id)}
        {#if f.deathStep <= stepNow}
          <g transform="translate({f.deathX},{f.y}) rotate(-76)" class="troop fallen" style="color:{atkColor}">
            <circle cx="0.4" cy="-11.9" r="2.6" />
            <path d="M0,-9.6 L0,-4.5" class="torso" />
            <path d={LEGS[2]} />
          </g>
        {:else}
          <g transform="translate({Math.max(24, anchorX + f.xOff)},{f.y})" class="troop" style="color:{atkColor}">
            <circle cx="0.4" cy="-11.9" r="2.6" />
            <path d="M0,-9.6 L0,-4.5" class="torso" />
            <path d={LEGS[arrived ? 2 : (stepNow + f.ph) % 2]} />
            <path d={HELMET} class="helm" />
            <path d={ARM} />
            <path d={RIFLE} class="rifle" />
          </g>
        {/if}
      {/each}

      <!-- firefight tracers once the charge reaches the line -->
      {#if arrived && !done}
        {#if stepNow % 2 === 0}
          <line x1={LINE_X + 6} y1={262 + jig(stepNow, 7) * 8} x2={BARR_X + 26} y2={258 + jig(stepNow, 8) * 10} class="tracer" style="stroke:{atkColor}" />
        {:else}
          <line x1={BARR_X + 10} y1={260 + jig(stepNow, 9) * 8} x2={LINE_X - 14} y2={264 + jig(stepNow, 10) * 10} class="tracer" style="stroke:{defColor}" />
        {/if}
      {/if}
      {#each bursts as b, bi (bi)}
        <path d="M-4.5,0 L-1.2,-1.2 L0,-5.5 L1.2,-1.2 L4.5,0 L1.2,1.2 L0,4 L-1.2,1.2 Z" transform="translate({b.x},{b.y - 8})" class="burst" />
      {/each}

      <!-- outcome banner -->
      {#if done}
        <g>
          <rect x="168" y="82" width="464" height="70" rx="10" class="bannerBox" style="stroke:{winColor}" />
          <text x="400" y="112" text-anchor="middle" class="bannerTitle" fill={winColor} data-testid="ground-banner">
            {p.captured ? '🏳 COLONY CAPTURED' : '🛡 INVASION REPELLED'}
          </text>
          <text x="400" y="136" text-anchor="middle" class="bannerSub">
            invaders lost {p.startTroops - cur.t}/{p.startTroops} · defenders lost {p.startMilitia - cur.m}/{p.startMilitia}{p.civilianLosses > 0 ? ` · ${p.civilianLosses} civilian${p.civilianLosses > 1 ? 's' : ''} died` : ''}
          </text>
        </g>
      {/if}
    </svg>

    <div class="counts">
      <span data-testid="ground-attackers" style="color:{atkColor}">
        ⚔ invaders — {cur.t}/{p.startTroops} marines
      </span>
      <span class="dim">{playing ? 'fighting…' : done ? (p.captured ? 'the colony falls' : 'the assault breaks') : 'paused'}</span>
      <span data-testid="ground-defenders" style="color:{defColor}">
        {#if (p.startGarrison ?? 0) > 0}🛡 defenders — {garAlive} garrison + {milAlive} militia{:else}🛡 defenders — {cur.m}/{p.startMilitia} militia{/if}
      </span>
    </div>

    <div class="controls">
      <button title={playing ? 'pause' : 'play'} onclick={() => (playing = done ? ((step = 0), true) : !playing)}>{playing ? '⏸' : done ? '↻' : '▶'}</button>
      <input type="range" min="0" max={S - 1} bind:value={step} oninput={() => (playing = false)} />
    </div>
  </div>
</div>

<style>
  .overlay {
    position: fixed;
    inset: 0;
    background: rgba(0, 0, 0, 0.75);
    display: flex;
    align-items: center;
    justify-content: center;
    z-index: 60;
  }
  .panel {
    background: var(--panel, var(--panel));
    border: 1px solid var(--line-bright, var(--line));
    border-radius: 10px;
    padding: 0.9rem 1.2rem 1rem;
    width: min(94vw, 58rem);
  }
  h3 {
    margin: 0 0 0.5rem;
    display: flex;
    justify-content: space-between;
    align-items: baseline;
    gap: 1rem;
  }
  .dim {
    opacity: 0.6;
    font-weight: 400;
    font-size: 0.85em;
  }
  .x {
    border: none;
    background: transparent;
    color: inherit;
    cursor: pointer;
    font-size: 1rem;
  }
  .scene {
    display: block;
    width: 100%;
    background: linear-gradient(var(--bg) 60%, var(--panel) 100%);
    border: 1px solid var(--line, var(--panel-3));
    border-radius: 8px;
  }
  .star {
    fill: var(--text);
    opacity: 0.5;
  }
  .horizon {
    stroke: var(--panel-3);
    stroke-width: 1;
  }
  .moon {
    fill: none;
    stroke: var(--line-bright);
    stroke-width: 1;
  }
  .moonbite {
    fill: var(--bg);
    stroke: none;
  }
  .bg path,
  .bg line,
  .bg rect {
    fill: none;
    stroke-width: 1.2;
    stroke-linecap: round;
  }
  .ocean path {
    stroke: #4a89a6;
  }
  .ocean .islet {
    stroke: #3a5f74;
  }
  .ocean .gulls {
    stroke: var(--text-dim);
    stroke-width: 1;
  }
  .farm path,
  .farm line {
    stroke: #7f9058;
  }
  .farm .fence {
    stroke: #6b6f56;
  }
  .bg .structure path,
  .bg .structure rect,
  .bg .structure line {
    stroke: var(--text-dim);
    opacity: 0.9;
  }
  .domes .structure rect {
    opacity: 0.55;
  }
  .beacon {
    fill: #ff6b6b;
    stroke: none;
    opacity: 0.9;
  }
  .ground {
    stroke: var(--line);
    stroke-width: 1.4;
  }
  .barricade path,
  .barricade rect {
    fill: none;
    stroke: #9a8f76;
    stroke-width: 1.3;
  }
  .flag line {
    stroke: var(--text-dim);
    stroke-width: 1.4;
  }
  .troop {
    stroke: currentColor;
    stroke-width: 1.5;
    stroke-linecap: round;
    fill: none;
  }
  .troop circle {
    fill: var(--panel, var(--panel));
  }
  .troop .torso {
    stroke-width: 1.9;
  }
  .troop .helm {
    stroke-width: 2;
  }
  .troop .rifle {
    stroke-width: 1.1;
  }
  .troop .tool {
    stroke-width: 1;
    opacity: 0.85;
  }
  .fallen {
    opacity: 0.32;
  }
  .tracer {
    stroke-width: 1.2;
    stroke-dasharray: 7 9;
    opacity: 0.7;
  }
  .burst {
    fill: var(--gold);
    stroke: #ff9d3c;
    stroke-width: 0.8;
    opacity: 0.95;
  }
  .bannerBox {
    fill: rgba(0, 0, 0, 0.85);
    stroke-width: 1.4;
  }
  .bannerTitle {
    font-size: 23px;
    font-weight: 800;
    letter-spacing: 0.12em;
  }
  .bannerSub {
    font-size: 12.5px;
    fill: var(--text);
  }
  .counts {
    display: flex;
    justify-content: space-between;
    gap: 1rem;
    font-size: 0.82rem;
    margin-top: 0.5rem;
  }
  .controls {
    display: flex;
    align-items: center;
    gap: 0.6rem;
    margin-top: 0.35rem;
  }
  .controls button {
    background: transparent;
    border: 1px solid var(--line, var(--panel-3));
    border-radius: 6px;
    color: inherit;
    cursor: pointer;
    padding: 0.1rem 0.5rem;
  }
  .controls input[type='range'] {
    flex: 1;
  }
</style>
