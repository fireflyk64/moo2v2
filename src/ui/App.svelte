<script lang="ts">
  import StorageSmoke from './dev/StorageSmoke.svelte';
  import Home from './screens/Home.svelte';
  import Lobby from './screens/Lobby.svelte';
  import GameShell from './screens/GameShell.svelte';
  import { app } from './state.svelte';

  let route = $state(location.hash);
  window.addEventListener('hashchange', () => (route = location.hash));
</script>

<main>
  {#if route === '#storage-smoke'}
    <StorageSmoke />
  {:else if app.screen === 'home'}
    <Home />
  {:else if app.screen === 'lobby'}
    <Lobby />
  {:else}
    <GameShell />
  {/if}
</main>

<style>
  :global(body) {
    margin: 0;
    background: #0b0e1a;
    color: #d8dcf0;
    font-family: system-ui, sans-serif;
  }
  main {
    padding: 2rem;
  }
</style>
