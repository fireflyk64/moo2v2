<script lang="ts">
  import { DEFAULT_SERVER, enterRoom } from '../net';
  import { describeSaveError, importSaveIntoRoom } from '../saveload';
  import { app, bindActive } from '../state.svelte';

  const q = new URLSearchParams(location.search);
  let server = $state(q.get('server') ?? DEFAULT_SERVER);
  let code = $state(q.get('room') ?? '');
  let name = $state(q.get('name') ?? '');
  let playerCount = $state(Number(q.get('players') ?? '2'));
  let loadNote = $state('');
  let fileInput: HTMLInputElement;

  async function go() {
    if (!code || !name) {
      app.error = 'name and room code are required';
      return;
    }
    app.error = '';
    app.connecting = true;
    try {
      const active = await enterRoom({ server, code, name, playerCount, debug: q.get('debug') === '1' });
      bindActive(active);
    } catch (e) {
      app.error = e instanceof Error ? e.message : String(e);
    } finally {
      app.connecting = false;
    }
  }

  async function onLoadFile(ev: Event) {
    const input = ev.target as HTMLInputElement;
    const file = input.files?.[0];
    input.value = '';
    if (!file) return;
    if (!code || !name) {
      app.error = 'enter your name and a room code before loading a save';
      return;
    }
    app.error = '';
    loadNote = 'verifying save…';
    try {
      const res = await importSaveIntoRoom(new Uint8Array(await file.arrayBuffer()), code, server);
      loadNote = `loaded turn ${res.turn} (${res.commandCount} commands, players: ${res.players.join(', ')}) — connecting as host…`;
      await go();
    } catch (e) {
      loadNote = '';
      app.error = describeSaveError(e);
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
  <button data-testid="load-save" onclick={() => fileInput.click()} disabled={app.connecting}>
    Load saved game…
  </button>
  <input
    bind:this={fileInput}
    data-testid="load-file"
    type="file"
    accept=".moo2save,.json,application/octet-stream"
    style="display:none"
    onchange={onLoadFile}
  />
  {#if loadNote}<p class="dim" data-testid="load-note">{loadNote}</p>{/if}
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
