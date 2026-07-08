<script lang="ts">
  import { selectors } from '@engine/index';
  import { app, getActive } from '../state.svelte';
  import Spreadsheet from './Spreadsheet.svelte';
  import MapView from './MapView.svelte';
  import Research from './Research.svelte';
  import Fleets from './Fleets.svelte';

  let tab = $state<'colonies' | 'map' | 'research' | 'fleets'>('colonies');
  let chatText = $state('');

  const session = () => getActive()!.session;
  const state = $derived.by(() => {
    void app.version;
    return session().getPlanned();
  });
  const summary = $derived.by(() => {
    void app.version;
    const s = session().getPlanned();
    return s ? selectors.empireSummary(s, session().playerId) : null;
  });
  const committed = $derived.by(() => {
    void app.version;
    return session().getCommitted();
  });
  const roster = $derived.by(() => {
    void app.version;
    return session().getRoster();
  });
  const iCommitted = $derived(committed.includes(session().playerId));
  const winner = $derived(state?.winner ?? null);

  function toggleCommit() {
    if (iCommitted) session().uncommitTurn();
    else session().commitTurn();
  }
  function sendChat() {
    if (chatText.trim()) session().sendChat(chatText.trim());
    chatText = '';
  }
</script>

{#if state && summary}
  <header>
    <span class="title">MOO2v2</span>
    <span data-testid="turn">Turn {state.turn}</span>
    <span data-testid="bc">{summary.bc} BC ({summary.bcDelta >= 0 ? '+' : ''}{summary.bcDelta})</span>
    <span data-testid="food">🌾 {summary.foodNet >= 0 ? '+' : ''}{summary.foodNet}</span>
    <span data-testid="rp">🔬 {summary.researchPerTurn}</span>
    <span data-testid="researching">
      {summary.researching ?? 'no research!'}
      {summary.researchTurnsLeft !== null ? ` (${summary.researchTurnsLeft}t)` : ''}
    </span>
    <button
      data-testid="commit"
      class:committed={iCommitted}
      onclick={toggleCommit}
    >{iCommitted ? 'Committed ✓' : 'Commit turn'} ({committed.length}/{roster.length})</button>
  </header>
  {#if winner !== null}
    <div class="banner" data-testid="victory">Victory: {roster.find((p) => p.id === winner)?.name ?? winner} wins by conquest!</div>
  {/if}
  <nav>
    <button class:active={tab === 'colonies'} data-testid="tab-colonies" onclick={() => (tab = 'colonies')}>Colonies</button>
    <button class:active={tab === 'map'} data-testid="tab-map" onclick={() => (tab = 'map')}>Map</button>
    <button class:active={tab === 'research'} data-testid="tab-research" onclick={() => (tab = 'research')}>Research</button>
    <button class:active={tab === 'fleets'} data-testid="tab-fleets" onclick={() => (tab = 'fleets')}>Fleets</button>
  </nav>
  <section>
    {#if tab === 'colonies'}
      <Spreadsheet />
    {:else if tab === 'map'}
      <MapView />
    {:else if tab === 'research'}
      <Research />
    {:else}
      <Fleets />
    {/if}
  </section>
  <footer>
    <input data-testid="chat-input" bind:value={chatText} placeholder="chat…" onkeydown={(e) => e.key === 'Enter' && sendChat()} />
    <button data-testid="chat-send" onclick={sendChat}>Send</button>
    <span class="chatlog" data-testid="chat-log">
      {#each app.chat.slice(-3) as m (m.id)}
        <span>#{m.from}: {m.text}</span>
      {/each}
    </span>
  </footer>
{:else}
  <p>waiting for game state…</p>
{/if}

<style>
  header {
    display: flex;
    gap: 1.2rem;
    align-items: center;
    padding: 0.4rem 0.8rem;
    background: #141830;
    position: sticky;
    top: 0;
    flex-wrap: wrap;
  }
  .title {
    font-weight: 700;
    color: #8fb8ff;
  }
  nav {
    display: flex;
    gap: 0.3rem;
    padding: 0.4rem 0.8rem;
  }
  nav button.active {
    background: #2c3a6e;
  }
  section {
    padding: 0 0.8rem 1rem;
  }
  footer {
    position: sticky;
    bottom: 0;
    background: #141830;
    padding: 0.3rem 0.8rem;
    display: flex;
    gap: 0.5rem;
    align-items: center;
  }
  .chatlog {
    display: flex;
    gap: 1rem;
    opacity: 0.8;
    font-size: 0.85rem;
  }
  .banner {
    background: #2c5a2c;
    padding: 0.5rem 0.8rem;
    font-weight: 700;
  }
  button.committed {
    background: #2c5a2c;
  }
</style>
