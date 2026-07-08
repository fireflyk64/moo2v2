<script lang="ts">
  import { app, getActive } from '../state.svelte';

  let ready = $state(false);

  const roster = $derived.by(() => {
    void app.version;
    return getActive()?.session.getRoster() ?? [];
  });
  const selfId = $derived.by(() => getActive()?.session.playerId ?? -1);
  const allReady = $derived(roster.length >= 2 && roster.every((p) => p.ready || p.id === 0));

  function toggleReady() {
    ready = !ready;
    getActive()?.session.setRaceConfig(null, ready);
  }

  function start() {
    getActive()?.startGame();
  }
</script>

<h2>Lobby — room {getActive()?.params.code}</h2>
<ul data-testid="roster">
  {#each roster as p (p.id)}
    <li>
      #{p.id} {p.name}
      {p.id === 0 ? '(host)' : ''}
      {p.ready ? '✓ ready' : ''}
      {p.connected ? '' : '(disconnected)'}
    </li>
  {/each}
</ul>
<p data-testid="roster-count">{roster.length} joined</p>

{#if selfId !== 0}
  <button data-testid="ready" onclick={toggleReady}>{ready ? 'Unready' : 'Ready'}</button>
{:else}
  <button data-testid="start" onclick={start} disabled={!allReady}>Start game</button>
  <p class="hint">start enables when all other players are ready</p>
{/if}

<style>
  .hint {
    opacity: 0.6;
    font-size: 0.85rem;
  }
</style>
