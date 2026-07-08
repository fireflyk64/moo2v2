<script lang="ts">
  import { DEFAULT_SERVER, enterRoom } from '../net';
  import { app, bindActive } from '../state.svelte';

  const q = new URLSearchParams(location.search);
  let server = $state(q.get('server') ?? DEFAULT_SERVER);
  let code = $state(q.get('room') ?? '');
  let name = $state(q.get('name') ?? '');
  let playerCount = $state(Number(q.get('players') ?? '2'));

  async function go() {
    if (!code || !name) {
      app.error = 'name and room code are required';
      return;
    }
    app.error = '';
    app.connecting = true;
    try {
      const active = await enterRoom({ server, code, name, playerCount });
      bindActive(active);
    } catch (e) {
      app.error = e instanceof Error ? e.message : String(e);
    } finally {
      app.connecting = false;
    }
  }

  // auto-join when arriving with a full URL (also the reload/resume path)
  $effect(() => {
    if (q.get('room') && q.get('name') && app.screen === 'home' && !app.connecting && !app.error) {
      void go();
    }
  });
</script>

<h1>MOO2v2</h1>
<div class="form">
  <label>Name <input data-testid="name" bind:value={name} /></label>
  <label>Room code <input data-testid="room" bind:value={code} /></label>
  <label>Players
    <select data-testid="players" bind:value={playerCount}>
      {#each [2, 3, 4, 5, 6, 7, 8] as n (n)}<option value={n}>{n}</option>{/each}
    </select>
  </label>
  <label>Server <input data-testid="server" bind:value={server} size="40" /></label>
  <button data-testid="enter" onclick={go} disabled={app.connecting}>
    {app.connecting ? 'Connecting…' : 'Create / Join'}
  </button>
  {#if app.error}<p class="error" data-testid="error">{app.error}</p>{/if}
</div>

<style>
  .form {
    display: flex;
    flex-direction: column;
    gap: 0.6rem;
    max-width: 28rem;
  }
  label {
    display: flex;
    justify-content: space-between;
    gap: 0.5rem;
  }
  .error {
    color: #ff7b7b;
  }
</style>
