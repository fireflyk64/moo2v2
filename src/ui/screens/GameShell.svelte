<script lang="ts">
  import { selectors, gameEngine } from '@engine/index';
  import { app, getActive } from '../state.svelte';
  import { describeSaveError, downloadRawDatabase, downloadSave } from '../saveload';
  import Spreadsheet from './Spreadsheet.svelte';
  import MapView from './MapView.svelte';
  import Research from './Research.svelte';
  import Fleets from './Fleets.svelte';
  import Designer from './Designer.svelte';
  import Empires from './Empires.svelte';
  import BattleOrdersDialog from '../battle/BattleOrdersDialog.svelte';
  import BattleViewer from '../battle/BattleViewer.svelte';

  let tab = $state<'colonies' | 'map' | 'research' | 'fleets' | 'designer' | 'empires'>('colonies');
  let chatText = $state('');

  const session = () => getActive()!.session;
  const gs = $derived.by(() => {
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
  const winner = $derived(gs?.winner ?? null);
  const authHash = $derived.by(() => {
    void app.version;
    const auth = session().getState();
    return auth ? gameEngine.hash(auth) : '';
  });
  /** the battle this player must currently order (dialog), if any */
  const myBattle = $derived.by(() => {
    void app.version;
    const auth = session().getState();
    if (!auth || auth.phase !== 'battle_orders') return null;
    const me = session().playerId;
    return auth.pendingBattles.find((b) => b.attacker === me || b.defender === me) ?? null;
  });
  const battlePhaseInfo = $derived.by(() => {
    void app.version;
    const auth = session().getState();
    if (!auth || auth.phase !== 'battle_orders') return null;
    return auth.pendingBattles.map((b) => b.id).join(', ');
  });

  function toggleCommit() {
    if (iCommitted) session().uncommitTurn();
    else session().commitTurn();
  }
  function sendChat() {
    if (chatText.trim()) session().sendChat(chatText.trim());
    chatText = '';
  }

  let saveNote = $state('');
  async function saveGame() {
    try {
      const name = await downloadSave(getActive()!);
      saveNote = `saved ${name}`;
    } catch (e) {
      saveNote = describeSaveError(e);
    }
  }
  async function saveDb() {
    try {
      await downloadRawDatabase(getActive()!);
      saveNote = 'database downloaded';
    } catch (e) {
      saveNote = describeSaveError(e);
    }
  }
</script>

{#if gs && summary}
  <header>
    <span class="title">MOO2v2</span>
    <span data-testid="turn">Turn {gs.turn}</span>
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
    {#if session().playerId === 0}
      <span class="saves">
        <button data-testid="save-game" disabled={!getActive()?.store} onclick={saveGame}
          title={getActive()?.store ? 'Download the full game as a save file' : 'persistence unavailable'}>
          💾 Save
        </button>
        <button data-testid="save-db" disabled={!getActive()?.sqlocal} onclick={saveDb}
          title="Download the raw sqlite database">DB</button>
        {#if saveNote}<span class="dim" data-testid="save-note">{saveNote}</span>{/if}
      </span>
    {/if}
  </header>
  {#if winner !== null}
    <div class="banner" data-testid="victory">Victory: {roster.find((p) => p.id === winner)?.name ?? winner} wins by conquest!</div>
  {/if}
  <nav>
    <button class:active={tab === 'colonies'} data-testid="tab-colonies" onclick={() => (tab = 'colonies')}>Colonies</button>
    <button class:active={tab === 'map'} data-testid="tab-map" onclick={() => (tab = 'map')}>Map</button>
    <button class:active={tab === 'research'} data-testid="tab-research" onclick={() => (tab = 'research')}>Research</button>
    <button class:active={tab === 'fleets'} data-testid="tab-fleets" onclick={() => (tab = 'fleets')}>Fleets</button>
    <button class:active={tab === 'designer'} data-testid="tab-designer" onclick={() => (tab = 'designer')}>Designer</button>
    <button class:active={tab === 'empires'} data-testid="tab-empires" onclick={() => (tab = 'empires')}>Empires</button>
    {#if app.replays.some((r) => !r.watched)}
      <button class="replays" data-testid="new-replays" onclick={() => (tab = 'empires')}>
        ⚔ {app.replays.filter((r) => !r.watched).length} new battle{app.replays.filter((r) => !r.watched).length > 1 ? 's' : ''}
      </button>
    {/if}
  </nav>
  {#if battlePhaseInfo && !myBattle}
    <div class="banner dim" data-testid="battle-spectate">Battles in progress elsewhere: {battlePhaseInfo}</div>
  {/if}
  <section>
    {#if tab === 'colonies'}
      <Spreadsheet />
    {:else if tab === 'map'}
      <MapView />
    {:else if tab === 'research'}
      <Research />
    {:else if tab === 'fleets'}
      <Fleets />
    {:else if tab === 'designer'}
      <Designer />
    {:else}
      <Empires />
    {/if}
  </section>
  {#if myBattle}
    <BattleOrdersDialog battle={myBattle} />
  {/if}
  {#if app.viewing}
    <BattleViewer replay={app.viewing} onclose={() => (app.viewing = null)} />
  {/if}
  <footer>
    <input data-testid="chat-input" bind:value={chatText} placeholder="chat…" onkeydown={(e) => e.key === 'Enter' && sendChat()} />
    <button data-testid="chat-send" onclick={sendChat}>Send</button>
    <span class="chatlog" data-testid="chat-log">
      {#each app.chat.slice(-3) as m (m.id)}
        <span>#{m.from}: {m.text}</span>
      {/each}
    </span>
    <span class="hash" data-testid="state-hash">{authHash}</span>
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
  .hash {
    margin-left: auto;
    opacity: 0.35;
    font-family: monospace;
    font-size: 0.75rem;
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
