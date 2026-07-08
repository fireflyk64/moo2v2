<script lang="ts">
  // The system-wide colonies spreadsheet: the primary way to run your empire.
  // Every edit is an optimistic command; dirty cells resolve on host accept.
  import { selectors } from '@engine/index';
  import { app, getActive } from '../state.svelte';

  const session = () => getActive()!.session;
  const rows = $derived.by(() => {
    void app.version;
    const s = session().getPlanned();
    return s ? selectors.colonyRows(s, session().playerId) : [];
  });

  function adjustJob(row: selectors.ColonyRow, job: 'farmers' | 'workers' | 'scientists', delta: number) {
    const jobs = { ...row.jobs };
    if (delta > 0) {
      // take a unit from the largest other pool
      const donors = (['workers', 'scientists', 'farmers'] as const).filter((j) => j !== job && jobs[j] > 0);
      if (!donors.length) return;
      const donor = donors.sort((a, b) => jobs[b] - jobs[a])[0]!;
      jobs[donor]--;
      jobs[job]++;
    } else {
      if (jobs[job] <= 0) return;
      jobs[job]--;
      // give to workers by default, else farmers
      const target = job === 'workers' ? 'farmers' : 'workers';
      jobs[target]++;
    }
    session().submit('set_jobs', {
      colonyId: row.id,
      groups: [{ race: session().playerId, ...jobs }],
    });
  }

  function setBuild(row: selectors.ColonyRow, item: string) {
    if (!item) return;
    const items = row.queue.length ? [item, ...row.queue.slice(1)] : [item];
    session().submit('set_build_queue', { colonyId: row.id, items });
  }

  function appendBuild(row: selectors.ColonyRow, item: string) {
    if (!item) return;
    session().submit('set_build_queue', { colonyId: row.id, items: [...row.queue, item] });
  }

  function buy(row: selectors.ColonyRow) {
    session().submit('buy_production', { colonyId: row.id });
  }
</script>

<table data-testid="colony-table">
  <thead>
    <tr>
      <th>Colony</th>
      <th>Planet</th>
      <th>Pop</th>
      <th>Morale</th>
      <th>Farm</th>
      <th>Work</th>
      <th>Sci</th>
      <th>🌾</th>
      <th>🔧</th>
      <th>🔬</th>
      <th>💰</th>
      <th>☁️</th>
      <th>Building</th>
      <th>Progress</th>
      <th>Buy</th>
      <th>Queue</th>
    </tr>
  </thead>
  <tbody>
    {#each rows as row (row.id)}
      <tr data-testid="colony-row-{row.id}" class:outpost={row.outpost}>
        <td class="name">{row.name}{row.outpost ? ' (outpost)' : ''}</td>
        <td class="dim">{row.planet.climate} {row.planet.minerals} {row.planet.gravity}-g s{row.planet.sizeClass}</td>
        <td data-testid="pop-{row.id}">{row.popUnits}/{row.maxPop}</td>
        <td>{row.output.moralePct}%</td>
        {#each ['farmers', 'workers', 'scientists'] as const as job (job)}
          <td class="jobs">
            <button class="mini" onclick={() => adjustJob(row, job, -1)}>-</button>
            <span data-testid="{job}-{row.id}">{row.jobs[job]}</span>
            <button class="mini" onclick={() => adjustJob(row, job, +1)}>+</button>
          </td>
        {/each}
        <td class:neg={row.output.foodNet < 0} data-testid="foodnet-{row.id}">{row.output.foodNet >= 0 ? '+' : ''}{row.output.foodNet}</td>
        <td data-testid="prod-{row.id}">{row.output.prodToQueue || row.output.prod}</td>
        <td>{row.output.research}</td>
        <td>{row.output.bcIncome}</td>
        <td class:neg={row.output.pollution > 0}>{row.output.pollution}</td>
        <td>
          <select
            data-testid="build-{row.id}"
            value={row.activeItem ?? ''}
            onchange={(e) => setBuild(row, (e.target as HTMLSelectElement).value)}
          >
            <option value="" disabled>— build —</option>
            {#if row.activeItem && !row.buildable.includes(row.activeItem)}
              <option value={row.activeItem}>{row.activeItem}</option>
            {/if}
            {#each row.buildable as item (item)}
              <option value={item}>{item}</option>
            {/each}
          </select>
        </td>
        <td data-testid="progress-{row.id}">
          {#if row.activeItem === 'housing' || row.activeItem === 'trade_goods'}
            ∞
          {:else if row.activeItem}
            {row.storedProd}/{row.activeCost}{row.turnsLeft !== null ? ` (${row.turnsLeft}t)` : ''}
          {:else}
            idle
          {/if}
        </td>
        <td>
          {#if row.buyPrice !== null}
            <button data-testid="buy-{row.id}" disabled={!row.canBuy} onclick={() => buy(row)}>
              {row.buyPrice} BC
            </button>
          {/if}
        </td>
        <td>
          <span class="dim">{row.queue.slice(1).join(', ')}</span>
          <select data-testid="queue-add-{row.id}" value="" onchange={(e) => { appendBuild(row, (e.target as HTMLSelectElement).value); (e.target as HTMLSelectElement).value = ''; }}>
            <option value="">+ queue</option>
            {#each row.buildable as item (item)}
              <option value={item}>{item}</option>
            {/each}
          </select>
        </td>
      </tr>
    {/each}
  </tbody>
</table>

<style>
  table {
    border-collapse: collapse;
    width: 100%;
    font-size: 0.85rem;
  }
  td,
  th {
    border: 1px solid #26304f;
    padding: 0.25rem 0.45rem;
    text-align: left;
    white-space: nowrap;
  }
  .jobs {
    white-space: nowrap;
  }
  .mini {
    padding: 0 0.35rem;
    margin: 0 0.15rem;
  }
  .neg {
    color: #ff8a7a;
  }
  .dim {
    opacity: 0.65;
  }
  .name {
    font-weight: 600;
  }
  .outpost {
    opacity: 0.6;
  }
  select {
    max-width: 11rem;
  }
</style>
