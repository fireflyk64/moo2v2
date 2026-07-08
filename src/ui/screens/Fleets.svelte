<script lang="ts">
  import { selectors } from '@engine/index';
  import { app, getActive } from '../state.svelte';

  const session = () => getActive()!.session;
  const state = $derived.by(() => {
    void app.version;
    return session().getPlanned();
  });
  const fleets = $derived.by(() => (state ? selectors.fleetRows(state, session().playerId) : []));

  function move(shipId: number, destStarId: number) {
    if (destStarId >= 0) session().submit('move_ships', { shipIds: [shipId], destStarId });
  }
  function colonize(shipId: number, planetId: number) {
    session().submit('colonize', { shipId, planetId });
  }
  function outpost(shipId: number, planetId: number) {
    session().submit('build_outpost', { shipId, planetId });
  }
  function scrap(shipId: number) {
    session().submit('scrap_ship', { shipId });
  }
</script>

<table>
  <thead>
    <tr><th>Ship</th><th>Type</th><th>Location</th><th>Actions</th></tr>
  </thead>
  <tbody>
    {#each fleets as f (f.ship.id)}
      <tr data-testid="fleet-{f.ship.id}">
        <td>#{f.ship.id}</td>
        <td>{f.kind}</td>
        <td>{f.location}</td>
        <td class="actions">
          {#if f.atStarId !== null && state}
            <select value={-1} onchange={(e) => move(f.ship.id, Number((e.target as HTMLSelectElement).value))}>
              <option value={-1}>move to…</option>
              {#each selectors.moveOptions(state, session().playerId, f.atStarId).filter((o) => o.reachable) as o (o.starId)}
                <option value={o.starId}>{o.name} ({o.turns}t)</option>
              {/each}
            </select>
            {#each f.canColonizeHere.slice(0, 1) as pid (pid)}
              <button data-testid="colonize-btn-{f.ship.id}" onclick={() => colonize(f.ship.id, pid)}>colonize</button>
            {/each}
            {#each f.canOutpostHere.slice(0, 1) as pid (pid)}
              <button onclick={() => outpost(f.ship.id, pid)}>outpost</button>
            {/each}
          {/if}
          <button class="dim" onclick={() => scrap(f.ship.id)}>scrap</button>
        </td>
      </tr>
    {/each}
  </tbody>
</table>

<style>
  table {
    border-collapse: collapse;
    width: 100%;
    font-size: 0.9rem;
  }
  td,
  th {
    border: 1px solid #26304f;
    padding: 0.3rem 0.6rem;
    text-align: left;
  }
  .actions {
    display: flex;
    gap: 0.4rem;
  }
  .dim {
    opacity: 0.65;
  }
</style>
