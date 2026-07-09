<script lang="ts">
  // Galaxy map v3 (SVG): proper star glyphs with glow, explored/unexplored fog,
  // fuel-range shading, in-flight fleet markers with travel progress, monster
  // lairs vs Antaran raids, blockade badges, move ordering with re-routing.
  import { selectors, inRange, isBlockaded, fuelRangeCp, supportStars, areAtWar } from '@engine/index';
  import { MAP_SIZE } from '@engine/galaxy';
  import { playerColor, STAR_COLORS } from '../colors';
  import { app, getActive } from '../state.svelte';

  const session = () => getActive()!.session;
  const gs = $derived.by(() => {
    void app.version;
    return session().getPlanned();
  });
  const me = () => session().playerId;
  const view = $derived.by(() => (gs ? selectors.galaxyView(gs, me()) : []));
  const fleets = $derived.by(() => (gs ? selectors.fleetRows(gs, me()) : []));
  const reachable = $derived.by(() => {
    if (!gs) return new Set<number>();
    const out = new Set<number>();
    for (const star of gs.stars) {
      if (inRange(gs, me(), star)) out.add(star.id);
    }
    return out;
  });
  const monstersByStar = $derived.by(() => {
    const m = new Map<number, string[]>();
    if (!gs) return m;
    for (const mon of gs.monsters) {
      m.set(mon.starId, [...(m.get(mon.starId) ?? []), mon.kind]);
    }
    return m;
  });
  const isRaid = (kinds: string[] | undefined) => (kinds ?? []).some((k) => k.startsWith('antaran_'));
  const blockadedStars = $derived.by(() => {
    const out = new Set<number>();
    if (!gs) return out;
    for (const c of gs.colonies) {
      if (c.owner !== me() || c.outpost) continue;
      if (isBlockaded(gs, c)) {
        const p = gs.planets.find((x) => x.id === c.planetId);
        if (p) out.add(p.starId);
      }
    }
    return out;
  });
  /** fuel-range envelope: circles around every colony/outpost star */
  let showRange = $state(true);
  const rangeCircles = $derived.by(() => {
    if (!gs || !showRange) return [];
    const empire = gs.empires.find((e) => e.id === me());
    if (!empire) return [];
    const r = Math.min(fuelRangeCp(empire), 4000);
    return supportStars(gs, me()).map((s) => ({ x: s.x, y: s.y, r }));
  });

  let selectedStarId = $state<number | null>(null);
  let selectedShipIds = $state<number[]>([]);

  const selected = $derived(view.find((v) => v.star.id === selectedStarId) ?? null);
  const shipsHere = $derived(fleets.filter((f) => f.atStarId === selectedStarId));
  const mapDims = $derived(gs ? MAP_SIZE[gs.settings.galaxySize] : { w: 2000, h: 1500 });

  /** own fleets in flight (or ordered this turn): marker at progress point */
  const transits = $derived.by(() => {
    if (!gs) return [];
    const starAt = (id: number) => gs.stars.find((s) => s.id === id);
    const out: Array<{
      id: number;
      name: string;
      x: number;
      y: number;
      tx: number;
      ty: number;
      angle: number;
      eta: number;
      reroutable: boolean;
    }> = [];
    let lane = 0;
    for (const f of fleets) {
      if (!f.transit) continue;
      const from = starAt(f.transit.fromStarId);
      const to = starAt(f.transit.toStarId);
      if (!from || !to) continue;
      const total = Math.max(1, f.transit.arrivalTurn - f.transit.departedTurn);
      const p = Math.max(0.06, Math.min(0.94, (gs.turn - f.transit.departedTurn) / total));
      // spread overlapping fleets on the same lane a little
      const off = (lane++ % 3) * 14 - 14;
      const dx = to.x - from.x;
      const dy = to.y - from.y;
      const len = Math.max(1, Math.hypot(dx, dy));
      const nx = -dy / len;
      const ny = dx / len;
      out.push({
        id: f.ship.id,
        name: f.name,
        x: from.x + dx * p + nx * off,
        y: from.y + dy * p + ny * off,
        tx: to.x,
        ty: to.y,
        angle: (Math.atan2(dy, dx) * 180) / Math.PI,
        eta: Math.max(1, f.transit.arrivalTurn - gs.turn),
        reroutable: f.reroutable,
      });
    }
    return out;
  });

  /** enemy empires with ships at the selected star that we are NOT at war with */
  const peacefulForeigners = $derived.by(() => {
    if (!gs || !selected) return [];
    const owners = [...new Set(selected.ships.map((s) => s.owner))].filter((o) => o !== me() && o >= 0);
    return owners
      .filter((o) => !areAtWar(gs, me(), o))
      .map((o) => gs.empires.find((e) => e.id === o)?.name ?? `#${o}`);
  });

  function clickStar(starId: number) {
    if (selectedShipIds.length > 0 && selectedStarId !== starId) {
      const res = session().submit('move_ships', { shipIds: selectedShipIds, destStarId: starId });
      if (!res.error) selectedShipIds = [];
      return;
    }
    selectedStarId = starId;
  }

  function toggleShip(id: number) {
    selectedShipIds = selectedShipIds.includes(id)
      ? selectedShipIds.filter((x) => x !== id)
      : [...selectedShipIds, id];
  }

  function colonize(shipId: number, planetId: number) {
    session().submit('colonize', { shipId, planetId });
  }
  function outpost(shipId: number, planetId: number) {
    session().submit('build_outpost', { shipId, planetId });
  }

  // ---- star rename (needs a settlement in the system) ----
  let renamingStar = $state(false);
  let renameStarText = $state('');
  const focusNow = (el: HTMLElement) => el.focus();
  const canRenameSelected = $derived.by(() => {
    if (!gs || !selected) return false;
    return gs.colonies.some((c) => {
      if (c.owner !== me()) return false;
      const p = gs.planets.find((x) => x.id === c.planetId);
      return p?.starId === selected.star.id;
    });
  });
  function startStarRename() {
    if (!selected) return;
    renamingStar = true;
    renameStarText = selected.star.name;
  }
  function commitStarRename() {
    if (!renamingStar || !selected) return;
    const name = renameStarText.trim();
    if (name && name !== selected.star.name) {
      session().submit('rename_star', { starId: selected.star.id, name });
    }
    renamingStar = false;
  }

  /** wormhole pairs (drawn once each) */
  const wormholeLinks = $derived.by(() => {
    if (!gs) return [];
    const out: Array<{ x1: number; y1: number; x2: number; y2: number }> = [];
    for (const s of gs.stars) {
      if (s.wormholeTo !== null && s.wormholeTo > s.id) {
        const t = gs.stars.find((x) => x.id === s.wormholeTo);
        if (t) out.push({ x1: s.x, y1: s.y, x2: t.x, y2: t.y });
      }
    }
    return out;
  });

  /** per-star fleet markers: military vs civilian, sized by ship count */
  function fleetMarks(ships: Array<{ owner: number; kind: string }>): Array<{ owner: number; mil: number; civ: number }> {
    const byOwner = new Map<number, { owner: number; mil: number; civ: number }>();
    for (const s of ships) {
      const e = byOwner.get(s.owner) ?? { owner: s.owner, mil: 0, civ: 0 };
      if (s.kind === 'design') e.mil++;
      else e.civ++;
      byOwner.set(s.owner, e);
    }
    return [...byOwner.values()].sort((a, b) => a.owner - b.owner);
  }
  const markSize = (n: number) => 10 + Math.round(5 * Math.sqrt(n));

  const CLIMATE_COLORS: Record<string, string> = {
    gaia: '#5ee08a', terran: '#6cc862', arid: '#d8bb6a', swamp: '#7aa85a', ocean: '#4da3ff',
    tundra: '#bcd7e8', desert: '#e0a35e', barren: '#8f8a80', energized: '#c78bff', hostile: '#ff6b5e',
  };
  function mineralRing(m: string): { stroke: string; width: number; dash: string } | null {
    if (m === 'ultra_rich') return { stroke: '#ffd75e', width: 2.5, dash: '' };
    if (m === 'rich') return { stroke: '#ffd75e', width: 1.5, dash: '' };
    if (m === 'poor') return { stroke: '#777f9d', width: 1.2, dash: '3 3' };
    if (m === 'ultra_poor') return { stroke: '#565d78', width: 1.2, dash: '2 4' };
    return null;
  }

  /** 5-point star polygon path centred on 0,0 */
  function starPath(outer: number): string {
    const inner = outer * 0.45;
    const pts: string[] = [];
    for (let i = 0; i < 10; i++) {
      const r = i % 2 === 0 ? outer : inner;
      const a = (Math.PI / 5) * i - Math.PI / 2;
      pts.push(`${(Math.cos(a) * r).toFixed(1)},${(Math.sin(a) * r).toFixed(1)}`);
    }
    return pts.join(' ');
  }
  const prettify = (id: string) => id.replaceAll('_', ' ');
</script>

<div class="wrap">
  <div class="mapcol">
    <svg viewBox="0 0 {mapDims.w} {mapDims.h}" data-testid="galaxy-map">
      <defs>
        <filter id="starglow" x="-80%" y="-80%" width="260%" height="260%">
          <feGaussianBlur stdDeviation="6" result="blur" />
          <feMerge>
            <feMergeNode in="blur" />
            <feMergeNode in="SourceGraphic" />
          </feMerge>
        </filter>
      </defs>

      {#each rangeCircles as rc, i (i)}
        <circle cx={rc.x} cy={rc.y} r={rc.r} class="range" />
      {/each}

      {#each wormholeLinks as wl, i (i)}
        <line x1={wl.x1} y1={wl.y1} x2={wl.x2} y2={wl.y2} class="wormhole">
          <title>wormhole — 1 turn transit either way</title>
        </line>
      {/each}

      {#each transits as t (t.id)}
        <line x1={t.x} y1={t.y} x2={t.tx} y2={t.ty} class="route" />
        <g transform="translate({t.x},{t.y}) rotate({t.angle})">
          <polygon points="18,0 -12,-11 -6,0 -12,11" class="fleetmark" class:reroutable={t.reroutable} />
        </g>
        <text x={t.x} y={t.y - 18} text-anchor="middle" class="eta">{t.name} · {t.eta}t</text>
      {/each}

      {#each view as v (v.star.id)}
        {@const kinds = monstersByStar.get(v.star.id)}
        <g
          class="star"
          role="button"
          tabindex="0"
          onclick={() => clickStar(v.star.id)}
          onkeydown={(e) => e.key === 'Enter' && clickStar(v.star.id)}
          transform="translate({v.star.x},{v.star.y})"
        >
          <title>
            {v.star.name}
            {v.explored ? '' : ' — unexplored'}
            {reachable.has(v.star.id) ? '' : ' — out of fuel range'}
          </title>
          <!-- invisible hit target so the whole star area is clickable -->
          <circle r="30" fill="transparent" stroke="none" />
          {#if v.star.id === selectedStarId}
            <circle r="36" class="selring" />
          {/if}
          {#if selectedShipIds.length > 0 && v.star.id !== selectedStarId && reachable.has(v.star.id)}
            <circle r="30" class="target" />
          {/if}
          {#if !reachable.has(v.star.id)}
            <circle r="26" class="norange" />
          {/if}
          {#if v.star.color === 'black_hole'}
            <circle r="10" fill="#05070f" stroke="#8a76b5" stroke-width="3" opacity={v.explored ? 1 : 0.4} />
            <circle r="16" fill="none" stroke="#5b4a75" stroke-width="2" opacity="0.6" />
          {:else}
            <polygon
              points={starPath(v.explored ? 15 : 12)}
              fill={STAR_COLORS[v.star.color]}
              opacity={v.explored ? 1 : 0.35}
              filter={v.explored ? 'url(#starglow)' : undefined}
            />
          {/if}
          {#if !v.explored}
            <circle r="21" class="fog" />
            <text y="7" text-anchor="middle" class="unknown">?</text>
          {/if}
          {#each v.colonies.filter((c) => !c.outpost) as c, i (c.id)}
            <circle r={22 + i * 5} fill="none" stroke={playerColor(c.owner)} stroke-width="3" opacity="0.9" />
          {/each}
          {#each fleetMarks(v.ships) as fm, i (fm.owner)}
            {@const y0 = -14 + i * 26}
            {#if fm.mil > 0}
              {@const s = markSize(fm.mil)}
              <polygon
                points="20,{y0} {20 + s},{y0 + s / 2} 20,{y0 + s}"
                fill={playerColor(fm.owner)}
                stroke="#05070f"
                stroke-width="1.5"
              >
                <title>{fm.mil} warship{fm.mil > 1 ? 's' : ''}</title>
              </polygon>
              {#if fm.mil > 1}
                <text x={22 + s} y={y0 + s / 2 + 6} class="count" fill={playerColor(fm.owner)}>{fm.mil}</text>
              {/if}
            {/if}
            {#if fm.civ > 0}
              {@const s = markSize(fm.civ)}
              {@const yc = y0 + (fm.mil > 0 ? 16 : 0)}
              <polygon
                points="20,{yc} {20 + s},{yc + s / 2} 20,{yc + s}"
                fill="none"
                stroke={playerColor(fm.owner)}
                stroke-width="2.5"
              >
                <title>{fm.civ} civilian ship{fm.civ > 1 ? 's' : ''} (scouts/colony/transport)</title>
              </polygon>
              {#if fm.civ > 1}
                <text x={22 + s} y={yc + s / 2 + 6} class="count" fill={playerColor(fm.owner)}>{fm.civ}</text>
              {/if}
            {/if}
          {/each}
          {#if v.explored && kinds}
            {#if isRaid(kinds)}
              <text y="-24" text-anchor="middle" class="raid">⚠</text>
            {:else}
              <text y="-24" text-anchor="middle" class="monster">☠</text>
            {/if}
          {/if}
          {#if blockadedStars.has(v.star.id)}
            <text x="-32" y="7" text-anchor="middle" class="blockade">⚓</text>
          {/if}
          <text y="38" text-anchor="middle" class="label" class:dimlabel={!v.explored}>{v.star.name}</text>
          {#if v.explored && v.planets.length}
            <text y="52" text-anchor="middle" class="pips">{'●'.repeat(Math.min(5, v.planets.filter((p) => p.body === 'planet').length))}</text>
          {/if}
        </g>
      {/each}
    </svg>
    <div class="legend">
      <label><input type="checkbox" bind:checked={showRange} /> fuel range</label>
      <span><span class="sw" style="border-color:#5a3030"></span> dashed ring = out of range</span>
      <span class="dimtext">◐ faded star = unexplored</span>
      <span><span class="monster">☠</span> monster lair</span>
      <span><span class="raid">⚠</span> Antaran raid</span>
      <span>▶ fleet under way (label shows ETA)</span>
      <span>▲ solid = warships · △ hollow = civilians</span>
      <span style="color:#b78bff">┈ wormhole</span>
    </div>
  </div>

  <aside>
    {#if selected}
      <h3 data-testid="selected-star">
        {#if renamingStar}
          <input
            class="renamestar"
            data-testid="rename-star-input"
            bind:value={renameStarText}
            use:focusNow
            maxlength="24"
            onkeydown={(e) => {
              if (e.key === 'Enter') commitStarRename();
              else if (e.key === 'Escape') renamingStar = false;
            }}
            onblur={commitStarRename}
          />
        {:else}
          {selected.star.name} <span class="dim">({selected.star.color.replaceAll('_', ' ')})</span>
          {#if canRenameSelected}
            <button class="mini ghost" data-testid="rename-star" title="rename star (needs a settlement here)" onclick={startStarRename}>✏️</button>
          {/if}
        {/if}
      </h3>
      {#if !selected.explored}
        <p class="dim">unexplored — send a ship to chart this system</p>
      {/if}
      {#if selected.star.wormholeTo !== null}
        <p class="dim">🌀 wormhole link — 1 turn transit</p>
      {/if}
      {#if !reachable.has(selected.star.id)}
        <p class="warn">⛽ out of fuel range — extend range with fuel-cell tech or a closer colony/outpost</p>
      {/if}
      {#if selected.explored && monstersByStar.has(selected.star.id)}
        {@const kinds = monstersByStar.get(selected.star.id)!}
        {#if isRaid(kinds)}
          <p class="raid" data-testid="monster-warning">⚠ Antaran raid in progress: {kinds.map(prettify).join(', ')}</p>
        {:else}
          <p class="monster" data-testid="monster-warning">☠ guarded by: {kinds.map(prettify).join(', ')} — destroy the keeper to settle here</p>
        {/if}
      {/if}
      {#if blockadedStars.has(selected.star.id)}
        <p class="blockade">⚓ blockaded — output halved, no freighter food</p>
      {/if}
      {#if peacefulForeigners.length}
        <p class="dim">🕊 {peacefulForeigners.join(', ')} ships present — you are at peace. Declare war on the Empires tab to engage.</p>
      {/if}
      {#if selected.explored && selected.planets.length}
        <!-- classic system view: star + orbit arcs, planet size/climate/richness at a glance -->
        <svg class="system" viewBox="0 0 330 92" aria-label="system view">
          <circle cx="-26" cy="46" r="44" fill={STAR_COLORS[selected.star.color]} opacity="0.9" />
          <circle cx="-26" cy="46" r="52" fill="none" stroke={STAR_COLORS[selected.star.color]} opacity="0.35" />
          {#each [1, 2, 3, 4, 5] as orbit (orbit)}
            {@const ox = 30 + orbit * 56}
            <circle cx="-26" cy="46" r={ox + 26} fill="none" stroke="#26304f" stroke-width="1" />
            {#each selected.planets.filter((p) => p.orbit === orbit) as p (p.id)}
              {@const px = ox + 4}
              {#if p.body === 'asteroids'}
                {#each [-8, -3, 2, 7, 12] as off, ai (ai)}
                  <circle cx={px + off} cy={46 + ((ai * 7) % 11) - 5} r="1.6" fill="#8f8a80" />
                {/each}
              {:else if p.body === 'gas_giant'}
                <circle cx={px} cy="46" r="13" fill="#c9a06a" opacity="0.85" />
                <ellipse cx={px} cy="46" rx="17" ry="4" fill="none" stroke="#e0c090" stroke-width="1.2" opacity="0.7" />
              {:else}
                {@const ring = mineralRing(p.minerals)}
                <circle cx={px} cy="46" r={4 + p.sizeClass * 1.8} fill={CLIMATE_COLORS[p.climate] ?? '#999'} />
                {#if ring}
                  <circle cx={px} cy="46" r={7 + p.sizeClass * 1.8} fill="none" stroke={ring.stroke} stroke-width={ring.width} stroke-dasharray={ring.dash} />
                {/if}
                {#each selected.colonies.filter((c) => gs?.colonies.find((x) => x.id === c.id)?.planetId === p.id) as c (c.id)}
                  <circle cx={px} cy="46" r={10 + p.sizeClass * 1.8} fill="none" stroke={playerColor(c.owner)} stroke-width="1.8" />
                {/each}
              {/if}
            {/each}
          {/each}
        </svg>
        <p class="syskey">size = circle · color = climate · gold ring = rich · dashed = poor · player ring = colony</p>
      {/if}
      <ul class="planets">
        {#each selected.planets as p (p.id)}
          <li data-testid="planet-{p.id}">
            <span class="orbit">{p.orbit}</span>
            {p.body === 'planet' ? `${p.climate} · size ${p.sizeClass} · ${prettify(p.minerals)} · ${p.gravity}-g` : prettify(p.body)}
            {#each selected.colonies.filter((c) => gs?.colonies.find((x) => x.id === c.id)?.planetId === p.id) as c (c.id)}
              <b style="color:{playerColor(c.owner)}"> — {c.name}</b>
            {/each}
            {#each shipsHere as f (f.ship.id)}
              {#if f.canColonizeHere.includes(p.id)}
                <button data-testid="colonize-{p.id}" onclick={() => colonize(f.ship.id, p.id)}>colonize</button>
              {:else if f.canOutpostHere.includes(p.id)}
                <button onclick={() => outpost(f.ship.id, p.id)}>outpost</button>
              {/if}
            {/each}
          </li>
        {/each}
      </ul>
      {#if shipsHere.length}
        <h4>Your ships here</h4>
        <ul class="ships">
          {#each shipsHere as f (f.ship.id)}
            <li>
              <label>
                <input type="checkbox" checked={selectedShipIds.includes(f.ship.id)} onchange={() => toggleShip(f.ship.id)} />
                {f.name} <span class="dim">#{f.ship.id}</span>
              </label>
            </li>
          {/each}
        </ul>
        {#if selectedShipIds.length}
          <p class="go">➤ click a destination star to move {selectedShipIds.length} ship{selectedShipIds.length > 1 ? 's' : ''} — green halo = in range</p>
        {/if}
      {/if}
      {#if fleets.some((f) => f.reroutable)}
        <p class="dim">↩ fleets ordered this turn can still be re-routed from the Fleets tab.</p>
      {/if}
    {:else}
      <p class="dim">select a star</p>
      <p class="dim">Your ships travel star-to-star within fuel range. Fleets under way show as ▶ markers with their ETA.</p>
    {/if}
  </aside>
</div>

<style>
  .wrap {
    display: flex;
    gap: 0.8rem;
  }
  .mapcol {
    flex: 1;
    min-width: 0;
  }
  svg {
    width: 100%;
    background:
      radial-gradient(70% 60% at 60% 30%, rgba(38, 48, 95, 0.35) 0%, transparent 70%),
      #05070f;
    border: 1px solid var(--line);
    border-radius: 10px;
    min-height: 420px;
    display: block;
  }
  .star {
    cursor: pointer;
  }
  .star:focus {
    outline: none;
  }
  text {
    fill: #aab3d0;
    font-size: 22px;
  }
  .label {
    fill: #c7d0ee;
    text-shadow: 0 0 6px #05070f;
  }
  .dimlabel {
    fill: #5d6788;
  }
  .pips {
    font-size: 13px;
    fill: #6ea8ff;
    letter-spacing: 2px;
    opacity: 0.8;
  }
  .unknown {
    fill: #5d6788;
    font-size: 20px;
    pointer-events: none;
  }
  .fog {
    fill: none;
    stroke: #39415f;
    stroke-width: 1.5;
    stroke-dasharray: 3 5;
  }
  .selring {
    fill: none;
    stroke: #8fb8ff;
    stroke-width: 3;
    animation: selpulse 1.6s ease-in-out infinite;
  }
  @keyframes selpulse {
    0%, 100% { stroke-opacity: 1; r: 36; }
    50% { stroke-opacity: 0.5; r: 40; }
  }
  .target {
    fill: rgba(94, 224, 138, 0.08);
    stroke: #5ee08a;
    stroke-width: 1.5;
    stroke-dasharray: 6 6;
  }
  .norange {
    fill: none;
    stroke: #5a3030;
    stroke-width: 2;
    stroke-dasharray: 4 6;
  }
  .range {
    fill: rgba(110, 168, 255, 0.03);
    stroke: rgba(110, 168, 255, 0.14);
    stroke-width: 2;
    pointer-events: none;
  }
  .route {
    stroke: #6ea8ff;
    stroke-width: 2;
    stroke-dasharray: 10 10;
    opacity: 0.5;
    pointer-events: none;
    animation: routeflow 1.2s linear infinite;
  }
  @keyframes routeflow {
    to { stroke-dashoffset: -20; }
  }
  .fleetmark {
    fill: #8fb8ff;
    stroke: #05070f;
    stroke-width: 1.5;
    filter: drop-shadow(0 0 6px rgba(110, 168, 255, 0.8));
  }
  .fleetmark.reroutable {
    fill: #ffd75e;
  }
  .eta {
    font-size: 17px;
    fill: #8fb8ff;
    pointer-events: none;
  }
  aside {
    width: 22rem;
    font-size: 0.9rem;
    background: linear-gradient(180deg, var(--panel-2), var(--panel));
    border: 1px solid var(--line);
    border-radius: 10px;
    padding: 0.6rem 0.9rem;
    align-self: flex-start;
  }
  aside h3 {
    margin: 0.2rem 0 0.5rem;
    color: var(--accent-soft);
  }
  aside h3 .ghost {
    opacity: 0.35;
    border: none;
    background: transparent;
    padding: 0 0.2rem;
    font-size: 0.8rem;
  }
  aside h3 .ghost:hover {
    opacity: 1;
  }
  .renamestar {
    width: 11rem;
  }
  .dim,
  .dimtext {
    opacity: 0.65;
  }
  .warn {
    color: var(--gold);
  }
  .go {
    color: var(--good);
  }
  ul {
    padding-left: 1rem;
    list-style: none;
    margin: 0.3rem 0;
  }
  li {
    margin-bottom: 0.3rem;
  }
  .orbit {
    display: inline-block;
    width: 1.2rem;
    height: 1.2rem;
    line-height: 1.2rem;
    text-align: center;
    background: var(--panel-3);
    border-radius: 50%;
    font-size: 0.75rem;
    margin-right: 0.3rem;
    color: var(--accent-soft);
  }
  .monster {
    fill: #ff8a7a;
    color: #ff8a7a;
    font-size: 24px;
  }
  .raid {
    fill: #ffd75e;
    color: #ffd75e;
    font-size: 26px;
    font-weight: 700;
  }
  .blockade {
    fill: #ffd479;
    color: #ffd479;
    font-size: 24px;
  }
  aside .monster,
  aside .raid,
  aside .blockade {
    font-size: 0.9rem;
  }
  .legend {
    display: flex;
    gap: 1rem;
    flex-wrap: wrap;
    font-size: 0.78rem;
    color: var(--text-dim);
    padding: 0.4rem 0.2rem 0;
    align-items: center;
  }
  .legend .monster,
  .legend .raid {
    font-size: 0.85rem;
  }
  .legend .sw {
    display: inline-block;
    width: 0.8rem;
    height: 0.8rem;
    border: 2px dashed #5a3030;
    border-radius: 50%;
    vertical-align: middle;
  }
  .legend label {
    display: flex;
    gap: 0.3rem;
    align-items: center;
    color: var(--text);
  }
  .wormhole {
    stroke: #b78bff;
    stroke-width: 2;
    stroke-dasharray: 3 9;
    opacity: 0.55;
    pointer-events: stroke;
  }
  .count {
    font-size: 15px;
    font-weight: 700;
  }
  .system {
    width: 100%;
    background: #05070f;
    border: 1px solid var(--line);
    border-radius: 8px;
    margin: 0.3rem 0 0.1rem;
  }
  .syskey {
    font-size: 0.68rem;
    color: var(--text-dim);
    margin: 0.15rem 0 0.4rem;
  }
</style>
