<script lang="ts">
  import { RACE_PRESETS, pickById } from '@engine/data/index';
  import { app, getActive } from '../state.svelte';

  let ready = $state(false);
  let presetId = $state('solari');

  const roster = $derived.by(() => {
    void app.version;
    return getActive()?.session.getRoster() ?? [];
  });
  const selfId = $derived.by(() => getActive()?.session.playerId ?? -1);
  const allReady = $derived(roster.length >= 2 && roster.every((p) => p.ready || p.id === 0));
  const preset = $derived(RACE_PRESETS.find((r) => r.id === presetId));

  function pushConfig() {
    getActive()?.session.setRaceConfig(JSON.stringify({ presetId }), ready);
  }
  function toggleReady() {
    ready = !ready;
    pushConfig();
  }
  function onPreset() {
    pushConfig();
  }
  function start() {
    // host locks in its own race on start
    pushConfig();
    getActive()?.startGame();
  }

  function describe(raceJson: string | null): string {
    if (!raceJson) return '';
    try {
      const cfg = JSON.parse(raceJson) as { presetId?: string };
      return RACE_PRESETS.find((r) => r.id === cfg.presetId)?.name ?? 'custom';
    } catch {
      return '';
    }
  }
</script>

<h2>Lobby — room {getActive()?.params.code}</h2>
<ul data-testid="roster">
  {#each roster as p (p.id)}
    <li>
      #{p.id} {p.name}
      {p.id === 0 ? '(host)' : ''}
      {describe(p.raceJson)}
      {p.ready ? '✓ ready' : ''}
      {p.connected ? '' : '(disconnected)'}
    </li>
  {/each}
</ul>
<p data-testid="roster-count">{roster.length} joined</p>

<label>
  Race:
  <select data-testid="race-select" bind:value={presetId} onchange={onPreset}>
    {#each RACE_PRESETS as r (r.id)}
      <option value={r.id}>{r.name}</option>
    {/each}
  </select>
</label>
{#if preset}
  <p class="dim">
    {preset.picks
      .map((p) => `${p}${(pickById.get(p)?.cost ?? 0) >= 0 ? '' : ' (flaw)'}`)
      .join(', ')}
  </p>
{/if}

{#if selfId !== 0}
  <button data-testid="ready" onclick={toggleReady}>{ready ? 'Unready' : 'Ready'}</button>
{:else}
  <button data-testid="start" onclick={start} disabled={!allReady}>Start game</button>
  <p class="hint">start enables when all other players are ready</p>
{/if}

<style>
  .hint,
  .dim {
    opacity: 0.6;
    font-size: 0.85rem;
  }
</style>
