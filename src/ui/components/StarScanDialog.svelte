<script lang="ts">
  // First-reveal system scan: when one of our ships charts a new star, this
  // takes over the screen for a beat — the orbital plan, every body at a
  // glance, and the survey's notable findings — before play continues.
  // Deliberately cinematic (radar sweep, staggered reveal) but text-first:
  // everything worth knowing is in the survey list, the art is garnish.
  import { app, getActive } from '../state.svelte';
  import PixelPlanet from '../PixelPlanet.svelte';
  import { STAR_COLORS, playerColor } from '../colors';
  import type { Planet, StarColor } from '@engine/types';

  interface Props {
    starId: number;
    /** more scans queued behind this one */
    pending?: number;
    onclose: () => void;
    onviewmap: () => void;
    onskipall?: () => void;
  }
  let { starId, pending = 0, onclose, onviewmap, onskipall }: Props = $props();

  const gs = $derived.by(() => {
    void app.version;
    return getActive()!.session.getPlanned();
  });
  const star = $derived(gs?.stars.find((s) => s.id === starId) ?? null);
  const planets = $derived(
    gs ? gs.planets.filter((p) => p.starId === starId).sort((a, b) => a.orbit - b.orbit) : [],
  );
  const coloniesHere = $derived(
    gs
      ? gs.colonies
          .map((c) => ({ c, planet: gs.planets.find((p) => p.id === c.planetId) }))
          .filter((x) => x.planet?.starId === starId)
      : [],
  );
  const guardians = $derived(
    gs ? gs.ships.filter((s) => s.location.kind === 'star' && s.location.starId === starId && s.owner <= -2) : [],
  );

  const STAR_TEXT: Record<StarColor, string> = {
    blue: 'class O/B — blue giant',
    white: 'class A/F — white main sequence',
    yellow: 'class G — yellow dwarf',
    orange: 'class K — orange dwarf',
    red: 'class M — red dwarf',
    brown: 'class L/T — brown dwarf',
    black_hole: 'collapsed singularity',
  };

  const ROMAN = ['', 'I', 'II', 'III', 'IV', 'V'];
  const SIZE_TEXT = ['', 'tiny', 'small', 'medium', 'large', 'huge'];
  const CLIMATE_RANK: Record<string, number> = {
    gaia: 9, terran: 8, ocean: 7, swamp: 6, arid: 5, tundra: 4, desert: 3, barren: 2, energized: 1, hostile: 0,
  };
  const SPECIAL_TEXT: Record<string, string> = {
    gold_deposits: '✦ gold deposits',
    gem_deposits: '✦ gem deposits',
    space_debris: '✦ salvageable debris',
    ancient_artifacts: '✦ ancient artifacts',
    natives: '✦ native population',
    splinter_colony: '✦ splinter colony',
  };

  // ---- orbital plan geometry (560 × 380 design space, scales with panel) ----
  const W = 560;
  const H = 380;
  const CX = W / 2;
  const CY = H / 2 + 8;
  const orbitRx = (orbit: number) => 38 + orbit * 44;
  const orbitRy = (orbit: number) => orbitRx(orbit) * 0.34;
  function angleOf(p: Planet): number {
    // deterministic per planet — the same world always sits at the same spot
    return ((((p.id * 2654435761) >>> 0) % 360) * Math.PI) / 180;
  }
  function posOf(p: Planet): { x: number; y: number } {
    const th = angleOf(p);
    return { x: CX + orbitRx(p.orbit) * Math.cos(th), y: CY + orbitRy(p.orbit) * Math.sin(th) };
  }
  function spriteSize(p: Planet): number {
    if (p.body === 'gas_giant') return 30;
    if (p.body === 'asteroids') return 22;
    return 12 + p.sizeClass * 4;
  }
  function ringOf(p: Planet): { ring: string | null; dashed: boolean } {
    if (p.body !== 'planet') return { ring: null, dashed: false };
    if (p.minerals === 'ultra_rich' || p.minerals === 'rich') return { ring: '#ffd75e', dashed: false };
    if (p.minerals === 'poor' || p.minerals === 'ultra_poor') return { ring: '#777f9d', dashed: true };
    return { ring: null, dashed: false };
  }

  const bestWorld = $derived.by(() => {
    let best: Planet | null = null;
    let bestScore = -1;
    for (const p of planets) {
      if (p.body !== 'planet') continue;
      const score = (CLIMATE_RANK[p.climate] ?? 0) * 2 + p.sizeClass;
      if (score > bestScore) {
        bestScore = score;
        best = p;
      }
    }
    return best && (CLIMATE_RANK[best.climate] ?? 0) >= 3 ? best : null;
  });

  const notables = $derived.by(() => {
    const out: string[] = [];
    const worlds = planets.filter((p) => p.body === 'planet');
    const gas = planets.filter((p) => p.body === 'gas_giant').length;
    const belts = planets.filter((p) => p.body === 'asteroids').length;
    if (worlds.length) out.push(`${worlds.length} world${worlds.length > 1 ? 's' : ''}`);
    if (gas) out.push(`${gas} gas giant${gas > 1 ? 's' : ''}`);
    if (belts) out.push(`${belts} asteroid belt${belts > 1 ? 's' : ''}`);
    if (star?.wormholeTo !== null && star?.wormholeTo !== undefined) out.push('wormhole terminus');
    return out;
  });

  const selfId = $derived(getActive()!.session.playerId);
</script>

<div class="scan-overlay" role="alertdialog" aria-label="system scan" data-testid="star-scan">
  {#if star && gs}
    <div class="scan-box">
      <div class="scan-head">
        <span class="scan-tag">SYSTEM SCAN</span>
        <h2>{star.name}</h2>
        <span class="spectral" style:color={STAR_COLORS[star.color]}>{STAR_TEXT[star.color]}</span>
      </div>

      <div class="plan" style:aspect-ratio={`${W} / ${H}`}>
        <svg viewBox="0 0 {W} {H}" class="orbits" aria-hidden="true">
          {#each [1, 2, 3, 4, 5] as orbit (orbit)}
            <ellipse cx={CX} cy={CY} rx={orbitRx(orbit)} ry={orbitRy(orbit)} fill="none" stroke="#26304f" stroke-width="1" />
          {/each}
          {#if star.color === 'black_hole'}
            <ellipse cx={CX} cy={CY} rx="30" ry="9" fill="none" stroke="#6c4f8e" stroke-width="3.5" opacity="0.7" />
            <circle cx={CX} cy={CY} r="14" fill="#02030a" stroke="#8a76b5" stroke-width="2.5" />
            <circle cx={CX} cy={CY} r="7" fill="#000" />
          {:else}
            <circle cx={CX} cy={CY} r="26" fill={STAR_COLORS[star.color]} opacity="0.18" />
            <circle cx={CX} cy={CY} r="15" fill={STAR_COLORS[star.color]} opacity="0.95" />
            <circle cx={CX} cy={CY} r="8" fill="#ffffff" opacity="0.55" />
          {/if}
          <g class="sweep">
            <line x1={CX} y1={CY} x2={CX + 250} y2={CY} stroke="#7fd0a0" stroke-width="1.5" opacity="0.5" />
          </g>
        </svg>
        {#each planets as p, pi (p.id)}
          {@const pos = posOf(p)}
          {@const r = ringOf(p)}
          <div
            class="body"
            style:left="{(pos.x / W) * 100}%"
            style:top="{(pos.y / H) * 100}%"
            style:animation-delay="{0.25 + pi * 0.3}s"
            title="orbit {ROMAN[p.orbit]} — {p.body === 'planet' ? `${SIZE_TEXT[p.sizeClass]} ${p.climate}` : p.body.replaceAll('_', ' ')}"
          >
            <PixelPlanet seed={p.id} climate={p.climate} body={p.body} size={spriteSize(p)} ring={r.ring} ringDashed={r.dashed} />
            <span class="orbitlabel">{ROMAN[p.orbit]}</span>
          </div>
        {/each}
      </div>

      {#if notables.length}
        <p class="notables">{notables.join(' · ')}</p>
      {/if}

      <ul class="survey">
        {#each planets as p (p.id)}
          {@const colony = coloniesHere.find((x) => x.planet?.id === p.id)}
          <li>
            <span class="orbitcol">{ROMAN[p.orbit]}</span>
            {#if p.body === 'asteroids'}
              <span>asteroid belt — {p.minerals.replaceAll('_', ' ')} minerals</span>
            {:else if p.body === 'gas_giant'}
              <span>gas giant — no solid surface</span>
            {:else}
              <span>
                {SIZE_TEXT[p.sizeClass]} <b>{p.climate}</b> world — {p.minerals.replaceAll('_', ' ')} minerals, {p.gravity} gravity
                {#if p.special && SPECIAL_TEXT[p.special]}
                  <span class="special">{SPECIAL_TEXT[p.special]}</span>
                {/if}
                {#if bestWorld?.id === p.id}
                  <span class="prime">★ standout world</span>
                {/if}
              </span>
            {/if}
            {#if colony}
              <span class="inhabited" style:color={playerColor(colony.c.owner)}>
                ● {colony.c.owner === selfId ? 'our colony' : `inhabited: ${gs.empires.find((e) => e.id === colony.c.owner)?.name ?? 'unknown'}`}
              </span>
            {/if}
          </li>
        {:else}
          <li><span class="orbitcol">—</span><span>no planetary bodies detected</span></li>
        {/each}
      </ul>

      {#if guardians.length}
        <p class="danger">⚠ hostile presence detected — {guardians.length} unidentified vessel{guardians.length > 1 ? 's' : ''} in-system</p>
      {/if}

      <div class="scan-actions">
        <button data-testid="star-scan-map" onclick={onviewmap}>🗺 View on map</button>
        {#if pending > 0 && onskipall}
          <button data-testid="star-scan-skipall" onclick={onskipall}>skip all ({pending + 1})</button>
        {/if}
        <button class="primary" data-testid="star-scan-continue" onclick={onclose}>
          {pending > 0 ? `Next scan ▶ (${pending} more)` : 'Continue ▶'}
        </button>
      </div>
    </div>
  {/if}
</div>

<style>
  .scan-overlay {
    position: fixed;
    inset: 0;
    z-index: 58;
    background: rgba(2, 4, 10, 0.82);
    display: grid;
    place-items: center;
    padding: 1rem;
  }
  .scan-box {
    width: min(92vw, 640px);
    max-height: 92vh;
    overflow-y: auto;
    background: var(--panel);
    border: 1px solid var(--line-bright);
    border-radius: 10px;
    padding: 1rem 1.2rem;
    box-shadow: 0 0 60px rgba(80, 200, 160, 0.12);
  }
  .scan-head {
    display: flex;
    align-items: baseline;
    gap: 0.7rem;
    flex-wrap: wrap;
  }
  .scan-tag {
    font-size: 0.7rem;
    letter-spacing: 0.25em;
    color: var(--accent);
    border: 1px solid var(--accent);
    border-radius: 4px;
    padding: 0.1rem 0.4rem;
    animation: scanblink 1.6s ease-in-out infinite alternate;
  }
  @keyframes scanblink {
    from { opacity: 0.55; }
    to { opacity: 1; }
  }
  .scan-head h2 {
    margin: 0;
    font-size: 1.4rem;
  }
  .spectral {
    font-size: 0.8rem;
    opacity: 0.85;
  }
  .plan {
    position: relative;
    width: 100%;
    margin: 0.4rem 0;
  }
  .orbits {
    position: absolute;
    inset: 0;
    width: 100%;
    height: 100%;
  }
  .sweep {
    transform-origin: 50% 51.5%;
    animation: sweepturn 7s linear infinite;
  }
  @keyframes sweepturn {
    from { transform: rotate(0deg); }
    to { transform: rotate(360deg); }
  }
  .body {
    position: absolute;
    transform: translate(-50%, -50%);
    display: grid;
    justify-items: center;
    gap: 0.1rem;
    animation: bodyfade 0.6s ease-out backwards;
  }
  @keyframes bodyfade {
    from { opacity: 0; filter: brightness(3); }
    to { opacity: 1; filter: none; }
  }
  .orbitlabel {
    font-size: 0.62rem;
    color: var(--line-bright);
  }
  .notables {
    margin: 0.2rem 0;
    font-size: 0.85rem;
    color: var(--accent-soft);
  }
  .survey {
    list-style: none;
    margin: 0.3rem 0;
    padding: 0;
    font-size: 0.85rem;
  }
  .survey li {
    display: flex;
    gap: 0.5rem;
    align-items: baseline;
    padding: 0.15rem 0;
    border-bottom: 1px solid color-mix(in srgb, var(--line) 40%, transparent);
  }
  .orbitcol {
    width: 1.6rem;
    text-align: right;
    color: var(--line-bright);
    flex: none;
  }
  .special {
    color: var(--gold, #ffd75e);
    margin-left: 0.35rem;
  }
  .prime {
    color: var(--accent);
    margin-left: 0.35rem;
  }
  .inhabited {
    margin-left: auto;
    white-space: nowrap;
  }
  .danger {
    color: var(--bad, #ff6b5e);
    font-size: 0.85rem;
    margin: 0.3rem 0;
  }
  .scan-actions {
    display: flex;
    gap: 0.5rem;
    justify-content: flex-end;
    margin-top: 0.6rem;
  }
  .scan-actions .primary {
    border-color: var(--accent);
    color: var(--accent-soft);
  }
</style>
