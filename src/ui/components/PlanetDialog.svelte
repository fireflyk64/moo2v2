<script lang="ts">
  // One-world popup from the map (bugs.md: "click on the planet to open up the
  // planet screen and manage some production there"): planet facts for any
  // world, and for YOUR colony the full production picture — jobs, output,
  // progress, buy, and the same build-queue menu the colonies screen uses —
  // without leaving the map or hunting the row down on the Colonies tab.
  import { selectors, itemLabel } from '@engine/index';
  import { itemDescription } from '@engine/data/index';
  import { app, getActive, savePerGame } from '../state.svelte';
  import PixelPlanet from '../PixelPlanet.svelte';
  import { playerColor } from '../colors';
  import BuildQueueMenu from './BuildQueueMenu.svelte';

  interface Props {
    planetId: number;
    /** replay/spectate: everything display-only */
    readonly?: boolean;
    onclose: () => void;
  }
  let { planetId, readonly = false, onclose }: Props = $props();

  const session = () => getActive()!.session;
  const gs = $derived.by(() => {
    void app.version;
    return session().getPlanned();
  });
  const planet = $derived(gs?.planets.find((p) => p.id === planetId) ?? null);
  const star = $derived(gs && planet ? gs.stars.find((s) => s.id === planet.starId) : null);
  const colony = $derived(gs ? (gs.colonies.find((c) => c.planetId === planetId) ?? null) : null);
  const me = $derived(session().playerId);
  const mine = $derived(colony !== null && colony.owner === me);
  const row = $derived(gs && colony && mine && !colony.outpost ? selectors.colonyRow(gs, colony) : null);
  /** reconciliation: the economy follows the recorded script */
  const scripted = $derived(gs?.reconcile !== undefined);
  const canEdit = $derived(mine && !readonly && !scripted && row !== null);
  let note = $state('');

  function submitQueue(items: Array<{ item: string; repeat?: boolean }>) {
    if (!row) return;
    const res = session().submit('set_build_queue', { colonyId: row.id, items });
    if (res.error) note = `⛔ ${res.error}`;
    else {
      note = '';
      // hand-edited queues are player-owned: pin them so the governor keeps
      // its hands off (same lifecycle as the colonies screen / map pins)
      const ids = items.map((it) => it.item);
      if (ids.length) app.pins[row.id] = ids;
      else delete app.pins[row.id];
      savePerGame();
    }
  }
  function buy() {
    if (!row) return;
    const res = session().submit('buy_production', { colonyId: row.id });
    note = res.error ? `⛔ ${res.error}` : '';
  }
  const label = (item: string) => (gs ? itemLabel(gs, me, item) : item);
  const pretty = (id: string) => id.replaceAll('_', ' ');
  function onKey(ev: KeyboardEvent) {
    if (ev.key === 'Escape') onclose();
  }
</script>

<svelte:window onkeydown={onKey} />

<div
  class="pd-overlay"
  data-testid="planet-dialog"
  role="dialog"
  aria-modal="true"
  tabindex="-1"
  onclick={(e) => e.target === e.currentTarget && onclose()}
  onkeydown={(e) => e.key === 'Escape' && onclose()}
>
  <div class="pd-box">
    {#if planet}
      <div class="pd-head">
        <PixelPlanet seed={planet.id} climate={planet.climate} body={planet.body} size={42} />
        <div class="pd-title">
          <h3>
            {#if colony}<b style="color:{playerColor(colony.owner)}">{colony.name}</b>{:else}{star?.name ?? '?'} {planet.orbit}{/if}
          </h3>
          <span class="pd-sub">
            {star?.name ?? '?'} · orbit {planet.orbit} ·
            {planet.body === 'planet'
              ? `${planet.climate} · size ${planet.sizeClass} · ${pretty(planet.minerals)} minerals · ${planet.gravity}-g${planet.special ? ` · ${pretty(planet.special)}` : ''}`
              : pretty(planet.body)}
          </span>
        </div>
        <button class="pd-close" data-testid="planet-dialog-close" title="close (Esc)" onclick={onclose}>✕</button>
      </div>

      {#if row}
        {#if scripted}
          <p class="pd-note">⚖ reconciliation: the economy follows the recorded script — production here is display-only</p>
        {/if}
        <table class="pd-table">
          <tbody>
            <tr>
              <th>population</th>
              <td>
                {(row.popK / 1000).toFixed(1)} / {row.maxPop}
                {#if row.growthK !== 0}<span class="dim">({row.growthK > 0 ? '+' : ''}{(row.growthK / 1000).toFixed(1)}/turn)</span>{/if}
                — 🌱{row.jobs.farmers} ⚒{row.jobs.workers} ⚗{row.jobs.scientists}
                <span class="dim">(reassign jobs on the Colonies screen)</span>
              </td>
            </tr>
            <tr>
              <th>output</th>
              <td>
                🌾 {row.output.foodNet >= 0 ? '+' : ''}{row.output.foodNet}
                · 🔧 {row.output.prodToQueue || row.output.prod}{#if row.output.pollution > 0}<span class="poll"> −{row.output.pollution}☁</span>{/if}
                · 🔬 {row.output.research} · 💰 {row.output.bcIncome}
              </td>
            </tr>
            <tr>
              <th>building</th>
              <td class="pd-buildcell">
                {#if canEdit}
                  <BuildQueueMenu
                    colonyId={row.id}
                    colonyName={row.name}
                    entries={row.queueEntries}
                    buildable={row.buildable}
                    {label}
                    describe={(item) => itemDescription(item) ?? ''}
                    {submitQueue}
                  />
                {:else}
                  <span>{row.activeItem ? label(row.activeItem) : '— nothing queued —'}</span>
                  {#if row.queue.length > 1}<span class="dim"> +{row.queue.length - 1} queued</span>{/if}
                {/if}
                {#if row.activeItem === 'housing' || row.activeItem === 'trade_goods'}
                  <span class="dim">∞</span>
                {:else if row.activeItem}
                  <span class="pd-bar" title="{row.storedProd}/{row.activeCost}">
                    <span class="pd-fill" style="width:{row.activeCost > 0 ? Math.min(100, Math.floor((row.storedProd * 100) / row.activeCost)) : 0}%"></span>
                  </span>
                  <span class="dim">{row.storedProd}/{row.activeCost}{row.turnsLeft !== null ? ` (${row.turnsLeft}t)` : ''}</span>
                  {#if canEdit && row.buyPrice !== null}
                    <button data-testid="planet-buy-{row.id}" disabled={!row.canBuy} title="buy the rest of this build with treasury BC" onclick={buy}>
                      buy {row.buyPrice} BC
                    </button>
                  {/if}
                {/if}
              </td>
            </tr>
            {#if row.buildings.length}
              <tr>
                <th>built</th>
                <td class="dim">{row.buildings.map((b) => pretty(b)).join(' · ')}</td>
              </tr>
            {/if}
          </tbody>
        </table>
        {#if note}<p class="pd-err">{note}</p>{/if}
      {:else if colony && colony.owner === me && colony.outpost}
        <p class="pd-note">your outpost — a fuel stop, not an economy (scrap it from the system panel)</p>
      {:else if colony}
        <p class="pd-note">
          colony of <b style="color:{playerColor(colony.owner)}">{gs?.empires.find((e) => e.id === colony.owner)?.name ?? '?'}</b>
        </p>
      {:else if planet.body === 'planet'}
        <p class="pd-note">uncolonized — bring a colony ship and settle it from the system panel</p>
      {:else}
        <p class="pd-note">{planet.body === 'asteroids' ? 'an asteroid belt' : 'a gas giant'} — only an artificial-planet project can make ground here</p>
      {/if}
    {:else}
      <p class="pd-note">planet unknown</p>
    {/if}
  </div>
</div>

<style>
  .pd-overlay {
    position: fixed;
    inset: 0;
    z-index: 58;
    background: rgba(2, 4, 10, 0.62);
    display: grid;
    place-items: center;
    padding: 1rem;
  }
  .pd-box {
    width: min(92vw, 560px);
    max-height: 88vh;
    overflow-y: auto;
    background: var(--panel);
    border: 1px solid var(--line-bright);
    border-radius: 10px;
    padding: 0.9rem 1.1rem;
  }
  .pd-head {
    display: flex;
    align-items: center;
    gap: 0.7rem;
  }
  .pd-title {
    flex: 1;
    min-width: 0;
  }
  .pd-title h3 {
    margin: 0;
    font-size: 1.05rem;
  }
  .pd-sub {
    color: var(--text-dim);
    font-size: 0.82rem;
  }
  .pd-close {
    align-self: flex-start;
  }
  .pd-table {
    width: 100%;
    margin-top: 0.6rem;
    border-collapse: collapse;
    font-size: 0.88rem;
  }
  .pd-table th {
    text-align: right;
    color: var(--text-dim);
    font-weight: 400;
    padding: 0.25rem 0.6rem 0.25rem 0;
    white-space: nowrap;
    vertical-align: top;
    width: 6.5rem;
  }
  .pd-table td {
    padding: 0.25rem 0;
  }
  .pd-buildcell {
    display: flex;
    align-items: center;
    gap: 0.4rem;
    flex-wrap: wrap;
  }
  .pd-bar {
    display: inline-block;
    width: 5.5rem;
    height: 0.55rem;
    background: var(--panel-3);
    border: 1px solid var(--line);
    border-radius: 4px;
    overflow: hidden;
    vertical-align: middle;
  }
  .pd-fill {
    display: block;
    height: 100%;
    background: var(--accent, #4a7);
  }
  .pd-note {
    color: var(--text-dim);
    margin: 0.6rem 0 0.2rem;
  }
  .pd-err {
    color: var(--bad, #e07b7b);
    margin: 0.4rem 0 0;
  }
  .dim {
    color: var(--text-dim);
  }
  .poll {
    color: var(--bad, #e07b7b);
  }
</style>
