<script lang="ts">
  // Galaxy map v1 (SVG): pan/zoom, star selection, fleet movement, colonize.
  import { selectors } from '@engine/index';
  import { MAP_SIZE } from '@engine/galaxy';
  import { playerColor, STAR_COLORS } from '../colors';
  import { app, getActive } from '../state.svelte';

  const session = () => getActive()!.session;
  const gs = $derived.by(() => {
    void app.version;
    return session().getPlanned();
  });
  const view = $derived.by(() => (gs ? selectors.galaxyView(gs, session().playerId) : []));
  const fleets = $derived.by(() => (gs ? selectors.fleetRows(gs, session().playerId) : []));

  let selectedStarId = $state<number | null>(null);
  let selectedShipIds = $state<number[]>([]);

  const selected = $derived(view.find((v) => v.star.id === selectedStarId) ?? null);
  const shipsHere = $derived(fleets.filter((f) => f.atStarId === selectedStarId));
  const mapDims = $derived(gs ? MAP_SIZE[gs.settings.galaxySize] : { w: 2000, h: 1500 });

  function clickStar(starId: number) {
    if (selectedShipIds.length > 0 && selectedStarId !== starId) {
      session().submit('move_ships', { shipIds: selectedShipIds, destStarId: starId });
      selectedShipIds = [];
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
</script>

<div class="wrap">
  <svg viewBox="0 0 {mapDims.w} {mapDims.h}" data-testid="galaxy-map">
    {#each view as v (v.star.id)}
      <g
        class="star"
        role="button"
        tabindex="0"
        onclick={() => clickStar(v.star.id)}
        onkeydown={(e) => e.key === 'Enter' && clickStar(v.star.id)}
        transform="translate({v.star.x},{v.star.y})"
      >
        {#if v.star.id === selectedStarId}
          <circle r="34" fill="none" stroke="#8fb8ff" stroke-width="3" />
        {/if}
        <circle r="14" fill={STAR_COLORS[v.star.color]} opacity={v.explored ? 1 : 0.45} />
        {#each v.colonies.filter((c) => !c.outpost) as c, i (c.id)}
          <circle r={20 + i * 5} fill="none" stroke={playerColor(c.owner)} stroke-width="3" />
        {/each}
        {#each [...new Set(v.ships.map((s) => s.owner))] as owner, i (owner)}
          <rect x={18} y={-16 + i * 12} width="10" height="8" fill={playerColor(owner)} />
        {/each}
        <text y="34" text-anchor="middle">{v.star.name}</text>
      </g>
    {/each}
    {#each fleets.filter((f) => f.ship.location.kind === 'transit') as f (f.ship.id)}
      {@const from = view.find((v) => v.star.id === (f.ship.location as { from: number }).from)}
      {@const to = view.find((v) => v.star.id === (f.ship.location as { to: number }).to)}
      {#if from && to}
        <line
          x1={from.star.x}
          y1={from.star.y}
          x2={to.star.x}
          y2={to.star.y}
          stroke={playerColor(session().playerId)}
          stroke-dasharray="8 8"
          opacity="0.6"
        />
      {/if}
    {/each}
  </svg>

  <aside>
    {#if selected}
      <h3 data-testid="selected-star">{selected.star.name} <span class="dim">({selected.star.color})</span></h3>
      {#if !selected.explored}
        <p class="dim">unexplored</p>
      {/if}
      {#if selected.star.wormholeTo !== null}
        <p class="dim">wormhole link</p>
      {/if}
      <ul>
        {#each selected.planets as p (p.id)}
          <li data-testid="planet-{p.id}">
            orbit {p.orbit}: {p.body === 'planet' ? `${p.climate} s${p.sizeClass} ${p.minerals} ${p.gravity}-g` : p.body}
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
        <ul>
          {#each shipsHere as f (f.ship.id)}
            <li>
              <label>
                <input type="checkbox" checked={selectedShipIds.includes(f.ship.id)} onchange={() => toggleShip(f.ship.id)} />
                #{f.ship.id} {f.kind}
              </label>
            </li>
          {/each}
        </ul>
        {#if selectedShipIds.length}
          <p class="dim">click a destination star to move {selectedShipIds.length} ship(s)</p>
        {/if}
      {/if}
    {:else}
      <p class="dim">select a star</p>
    {/if}
  </aside>
</div>

<style>
  .wrap {
    display: flex;
    gap: 0.8rem;
  }
  svg {
    flex: 1;
    background: #05070f;
    border: 1px solid #26304f;
    min-height: 420px;
  }
  .star {
    cursor: pointer;
  }
  text {
    fill: #aab3d0;
    font-size: 22px;
  }
  aside {
    width: 21rem;
    font-size: 0.9rem;
  }
  .dim {
    opacity: 0.65;
  }
  li {
    margin-bottom: 0.25rem;
  }
</style>
