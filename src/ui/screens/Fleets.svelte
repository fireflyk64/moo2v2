<script lang="ts">
  import { selectors, shipStyleOf, shortEntityId, type EmpireDesign } from '@engine/index';
  import { app, getActive } from '../state.svelte';
  import { playerColor } from '../colors';
  import ShipPreview from '../battle/ShipPreview.svelte';
  import type { ArtClass } from '../battle/shipart';

  const session = () => getActive()!.session;
  const gs = $derived.by(() => {
    void app.version;
    return session().getPlanned();
  });
  const fleets = $derived.by(() => (gs ? selectors.fleetRows(gs, session().playerId) : []));
  const empire = $derived(gs?.empires.find((e) => e.id === session().playerId) ?? null);
  const myStyle = $derived(empire ? shipStyleOf(empire) : 'raptor');
  const myColor = $derived(playerColor(session().playerId));
  const designOf = (id: number | null): EmpireDesign | null => empire?.designs.find((d) => d.id === id) ?? null;

  let note = $state('');
  function submit(kind: string, payload: unknown) {
    note = '';
    const res = session().submit(kind, payload);
    if (res.error) note = res.error;
  }
  function move(shipId: number, destStarId: number) {
    if (destStarId >= -1) submit('move_ships', { shipIds: [shipId], destStarId });
  }
  function colonize(shipId: number, planetId: number) {
    submit('colonize', { shipId, planetId });
  }
  function outpost(shipId: number, planetId: number) {
    submit('build_outpost', { shipId, planetId });
  }
  function scrap(shipId: number) {
    submit('scrap_ship', { shipId });
  }
  function colonyName(id: number | null): string {
    return gs?.colonies.find((c) => c.id === id)?.name ?? '';
  }
  const starName = (id: number) => gs?.stars.find((s) => s.id === id)?.name ?? `star ${id}`;
</script>

{#if note}<p class="error">{note}</p>{/if}
{#if fleets.length === 0}
  <p class="dim">No ships yet — build scouts, colony ships, or warship designs from the Colonies tab.</p>
{:else}
  <table>
    <thead>
      <tr><th>Ship</th><th>Type</th><th>Location</th><th>Cargo / status</th><th>Actions</th></tr>
    </thead>
    <tbody>
      {#each fleets as f (f.ship.id)}
        <tr data-testid="fleet-{f.ship.id}">
          <td class="shipname">
            {#if f.ship.shipKind === 'design' && designOf(f.ship.designId)}
              {@const d = designOf(f.ship.designId)!}
              <ShipPreview style={myStyle} cls={d.hull as ArtClass} variant={d.modelIdx ?? d.id} color={myColor} specials={[...d.specials]} px={1} />
            {:else if f.ship.shipKind === 'scout'}
              <ShipPreview style={myStyle} cls="scout" variant={f.ship.id} color={myColor} px={1} />
            {/if}
            {f.name} <span class="dim">#{shortEntityId(f.ship.id)}</span></td>
          <td class="dim">{f.kind === 'design' ? 'warship' : f.kind.replaceAll('_', ' ')}</td>
          <td>
            {#if f.transit}
              <span class="transit">
                {starName(f.transit.fromStarId)} ➤ <b>{starName(f.transit.toStarId)}</b>
                <span class="etabar" title="arrives in {f.etaTurns}t">
                  <span
                    class="etafill"
                    style="width:{Math.min(100, Math.max(6, Math.floor(((gs!.turn - f.transit.departedTurn) * 100) / Math.max(1, f.transit.arrivalTurn - f.transit.departedTurn))))}%"
                  ></span>
                </span>
                {f.etaTurns}t
              </span>
            {:else}
              {f.location}
            {/if}
          </td>
          <td>
            {#if f.ship.cargoPopUnits > 0}
              👥 {f.ship.cargoPopUnits} colonists aboard
            {/if}
            {#if f.ship.dmgStructure > 0 || f.ship.dmgArmor > 0}
              <span class="neg" title="repairs automatically at your colonies">🔧 damaged</span>
            {/if}
            {#if f.reroutable}
              <span class="gold" title="this order was placed this turn — you can still change it">↩ re-routable</span>
            {/if}
          </td>
          <td class="actions">
            {#if gs && (f.atStarId !== null || f.reroutable)}
              {@const origin = f.atStarId ?? f.transit!.fromStarId}
              <select value={-2} onchange={(e) => move(f.ship.id, Number((e.target as HTMLSelectElement).value))}>
                <option value={-2}>{f.reroutable ? 're-route to…' : 'move to…'}</option>
                {#if f.reroutable}
                  <option value={f.transit!.fromStarId}>✕ cancel — stay at {starName(f.transit!.fromStarId)}</option>
                {/if}
                {#each selectors.moveOptions(gs, session().playerId, origin) as o (o.starId)}
                  <option value={o.starId} disabled={!o.reachable}>
                    {o.name} ({o.turns}t){o.reachable ? '' : ' — out of range'}
                  </option>
                {/each}
              </select>
            {/if}
            {#each f.canColonizeHere.slice(0, 1) as pid (pid)}
              <button class="primary" data-testid="colonize-btn-{f.ship.id}" onclick={() => colonize(f.ship.id, pid)}>colonize</button>
            {/each}
            {#each f.canOutpostHere.slice(0, 1) as pid (pid)}
              <button onclick={() => outpost(f.ship.id, pid)}>outpost</button>
            {/each}
            {#each f.canConstructHere.slice(0, 1) as pid (pid)}
              <button
                title="rebuild the asteroid belt / gas giant here into a barren world (consumes the ship)"
                onclick={() => submit('construct_planet', { shipId: f.ship.id, planetId: pid })}
              >construct planet</button>
            {/each}
            {#if f.canLoadFromColonyId !== null}
              <button
                title="load 2 colonists from {colonyName(f.canLoadFromColonyId)}"
                onclick={() => submit('load_transports', { colonyId: f.canLoadFromColonyId, shipId: f.ship.id })}
              >⬆ load colonists</button>
            {/if}
            {#if f.canUnloadToColonyId !== null}
              <button
                title="land the colonists at {colonyName(f.canUnloadToColonyId)}"
                onclick={() => submit('unload_transports', { colonyId: f.canUnloadToColonyId, shipId: f.ship.id })}
              >⬇ unload</button>
            {/if}
            {#if f.ship.shipKind === 'design' && f.atStarId !== null}
              {@const refit = selectors.refitOptions(gs!, session().playerId, f.ship.id)}
              {#if refit.options.length}
                <select
                  class="refitsel"
                  data-testid="refit-{f.ship.id}"
                  value=""
                  disabled={refit.colonyId === null}
                  title={refit.colonyId === null
                    ? 'refits need one of your colonies with a star base (or better) in this system'
                    : 'rebuild this ship to another design of the same hull class — MOO2 price: cost difference, minimum ¼ of the new design; queued at the shipyard colony'}
                  onchange={(e) => {
                    const designId = Number((e.target as HTMLSelectElement).value);
                    (e.target as HTMLSelectElement).value = '';
                    if (!designId || refit.colonyId === null) return;
                    const colony = gs!.colonies.find((c) => c.id === refit.colonyId)!;
                    submit('set_build_queue', {
                      colonyId: refit.colonyId,
                      items: [...colony.queue.map((q) => q.item), `refit:${f.ship.id}:${designId}`],
                    });
                  }}
                >
                  <option value="">⟳ retrofit…</option>
                  {#each refit.options as o (o.designId)}
                    <option value={o.designId}>{o.name} ({o.cost} prod)</option>
                  {/each}
                </select>
              {/if}
            {/if}
            <button class="dimbtn" title="scrap for a quarter of the build cost in BC" onclick={() => scrap(f.ship.id)}>scrap</button>
          </td>
        </tr>
      {/each}
    </tbody>
  </table>
  <p class="dim hint">
    👥 To move colonists: build a <b>transport</b>, load it at a colony (needs &gt;2 of your people), fly it, unload.
    Colony ships found new colonies; outpost ships extend fuel range. Move orders placed this turn can be re-routed or cancelled until the turn resolves.
  </p>
{/if}

<style>
  table {
    border-collapse: collapse;
    width: 100%;
    font-size: 0.9rem;
  }
  td,
  th {
    border: 1px solid var(--line);
    padding: 0.3rem 0.6rem;
    text-align: left;
  }
  .shipname {
    font-weight: 600;
  }
  .actions {
    display: flex;
    gap: 0.4rem;
    flex-wrap: wrap;
    align-items: center;
  }
  .transit {
    display: inline-flex;
    gap: 0.4rem;
    align-items: center;
  }
  .etabar {
    display: inline-block;
    width: 4rem;
    height: 0.45rem;
    background: var(--panel);
    border: 1px solid var(--line);
    border-radius: 3px;
    overflow: hidden;
  }
  .etafill {
    display: block;
    height: 100%;
    background: linear-gradient(90deg, #24418a, var(--accent));
  }
  .dim {
    opacity: 0.65;
  }
  .refitsel {
    max-width: 8.5rem;
    font-size: 0.78rem;
  }
  .dimbtn {
    opacity: 0.65;
  }
  .neg {
    color: var(--bad);
  }
  .gold {
    color: var(--gold);
  }
  .error {
    color: var(--bad);
  }
  .hint {
    margin-top: 0.6rem;
    max-width: 60rem;
  }
  button.primary {
    background: linear-gradient(180deg, #1f6a38, #175028);
    border-color: var(--good);
  }
</style>
