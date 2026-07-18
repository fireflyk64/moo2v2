<script lang="ts">
  // Campaign timelapse viewer: an unfogged mini-map scrubbing through one
  // frame per turn — borders ebb, battles flash, the empire strip tallies
  // colonies/pop/fleets/techs. Data comes from replaying the command log
  // (timelapse.ts); this component only renders.
  import { playerColor, STAR_COLORS } from '../colors';
  import type { TimelapseData } from '../timelapse';
  import type { StarColor } from '@engine/types';

  const { data, onclose }: { data: TimelapseData; onclose: () => void } = $props();

  let frameIdx = $state(0);
  let playing = $state(true);
  let turnsPerSec = $state(8);
  const frame = $derived(data.frames[Math.min(frameIdx, data.frames.length - 1)]!);
  const lastIdx = $derived(data.frames.length - 1);

  $effect(() => {
    if (!playing) return;
    const iv = setInterval(() => {
      if (frameIdx >= lastIdx) {
        playing = false;
        return;
      }
      frameIdx++;
    }, 1000 / turnsPerSec);
    return () => clearInterval(iv);
  });

  function onKey(e: KeyboardEvent) {
    if (e.key === 'Escape') {
      e.preventDefault();
      onclose();
    } else if (e.key === ' ') {
      e.preventDefault();
      if (!playing && frameIdx >= lastIdx) frameIdx = 0;
      playing = !playing;
    } else if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
      e.preventDefault();
      playing = false;
      frameIdx = Math.max(0, Math.min(lastIdx, frameIdx + (e.key === 'ArrowRight' ? 1 : -1)));
    }
  }

  const starFill = (color: string) => (color === 'black_hole' ? '#241a33' : (STAR_COLORS[color as StarColor] ?? '#ccc'));
  const ownersOf = (starId: number) => frame.owners.find((o) => o[0] === starId)?.[1] ?? [];
</script>

<svelte:window onkeydown={onKey} />

<div class="overlay">
  <div class="viewer" data-testid="timelapse-viewer">
    <div class="bar">
      <b>🎬 Campaign timelapse</b>
      <span class="turn" data-testid="timelapse-turn">turn {frame.turn} / {data.frames[lastIdx]!.turn}</span>
      <button
        onclick={() => {
          if (!playing && frameIdx >= lastIdx) frameIdx = 0;
          playing = !playing;
        }}
      >{playing ? '⏸ Pause' : '▶ Play'}</button>
      <button onclick={() => (turnsPerSec = turnsPerSec === 4 ? 8 : turnsPerSec === 8 ? 20 : 4)}>{turnsPerSec} t/s</button>
      <button data-testid="timelapse-close" title="close (Esc) · Space play/pause · ←→ step" onclick={onclose}>Close (Esc)</button>
    </div>
    <input
      class="scrub"
      type="range"
      min="0"
      max={lastIdx}
      value={frameIdx}
      oninput={(e) => {
        playing = false;
        frameIdx = Number((e.target as HTMLInputElement).value);
      }}
    />
    <svg viewBox="0 0 {data.w} {data.h}" preserveAspectRatio="xMidYMid meet">
      <rect x="0" y="0" width={data.w} height={data.h} fill="#04060f" />
      {#each data.stars as s (s.id)}
        {@const owners = ownersOf(s.id)}
        <circle cx={s.x} cy={s.y} r="7" fill={starFill(s.color)} />
        {#each owners as o, oi (o)}
          <circle cx={s.x} cy={s.y} r={16 + oi * 8} fill={oi === 0 ? playerColor(o) : 'none'} fill-opacity={oi === 0 ? 0.28 : 0} stroke={playerColor(o)} stroke-width="3.5" />
        {/each}
      {/each}
      {#each frame.battles as b, bi (bi)}
        {@const s = data.stars.find((x) => x.id === b.starId)}
        {#if s}
          <circle cx={s.x} cy={s.y} r="30" fill="none" stroke="#ffb454" stroke-width="4" opacity="0.9" />
          <text x={s.x} y={s.y - 34} text-anchor="middle" class="clash">⚔</text>
        {/if}
      {/each}
    </svg>
    <div class="strip">
      {#each frame.stats as st (st.empire)}
        {@const emp = data.empires.find((e) => e.id === st.empire)}
        <span class="emp" class:dead={st.colonies === 0} style="color:{playerColor(st.empire)}">
          <b>{emp?.name ?? `#${st.empire}`}</b>
          🏙 {st.colonies} · 👥 {st.pop} · ⚔ {st.warships} · 🔬 {st.apps}
        </span>
      {/each}
    </div>
  </div>
</div>

<style>
  .overlay {
    position: fixed;
    inset: 0;
    background: rgba(4, 6, 14, 0.88);
    display: flex;
    align-items: center;
    justify-content: center;
    z-index: 55;
  }
  .viewer {
    background: #10142a;
    border: 1px solid #3a4a80;
    border-radius: 10px;
    padding: 0.7rem 0.9rem;
    width: min(92vw, 70rem);
    display: flex;
    flex-direction: column;
    gap: 0.4rem;
  }
  .bar {
    display: flex;
    align-items: center;
    gap: 0.7rem;
  }
  .turn {
    font-variant-numeric: tabular-nums;
    color: var(--text-dim, #9aa3c0);
    margin-right: auto;
  }
  svg {
    width: 100%;
    max-height: 62vh;
    border: 1px solid var(--line, #26304f);
    border-radius: 8px;
  }
  .scrub {
    width: 100%;
  }
  .clash {
    font-size: 26px;
    fill: #ffb454;
  }
  .strip {
    display: flex;
    gap: 1.2rem;
    flex-wrap: wrap;
    font-size: 0.82rem;
  }
  .emp.dead {
    opacity: 0.45;
    text-decoration: line-through;
  }
</style>
