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
  import Reports from './Reports.svelte';
  import BattleOrdersDialog from '../battle/BattleOrdersDialog.svelte';
  import BattleViewer from '../battle/BattleViewer.svelte';

  let tab = $state<'colonies' | 'map' | 'research' | 'fleets' | 'designer' | 'empires' | 'reports'>('colonies');
  let seenReports = $state(0);
  let chatText = $state('');
  let chatTo = $state(-1); // -1 = everyone, else a playerId (DM)
  let showHelp = $state(false);

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
    if (chatText.trim()) session().sendChat(chatText.trim(), chatTo);
    chatText = '';
  }
  const chatVisible = $derived.by(() => {
    void app.version;
    const me = session().playerId;
    return app.chat.filter((m) => (chatTo === -1 ? m.to === -1 : m.to !== -1 && (m.from === chatTo || m.to === chatTo || m.from === me)));
  });

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
  {#if !app.hostConnected}
    <div class="banner warn" data-testid="host-offline">
      ⚠ Host offline — the game is paused. It resumes when the host returns (or load their save file to re-host).
    </div>
  {/if}
  {#if !getActive()?.store}
    <div class="banner warn" data-testid="no-persistence">
      ⚠ Persistence unavailable (another tab holds this room's database?) — the game plays but cannot be saved from this tab.
    </div>
  {/if}
  {#if winner !== null}
    {@const winLabel = gs.winType === 'council' ? 'is elected supreme ruler of the council' : gs.winType === 'antaran' ? 'has conquered the Antaran home' : 'wins by conquest'}
    <div class="banner" data-testid="victory">Victory: {roster.find((p) => p.id === winner)?.name ?? winner} {winLabel}!</div>
  {/if}
  <nav>
    <button class:active={tab === 'colonies'} data-testid="tab-colonies" onclick={() => (tab = 'colonies')}>Colonies</button>
    <button class:active={tab === 'map'} data-testid="tab-map" onclick={() => (tab = 'map')}>Map</button>
    <button class:active={tab === 'research'} data-testid="tab-research" onclick={() => (tab = 'research')}>Research</button>
    <button class:active={tab === 'fleets'} data-testid="tab-fleets" onclick={() => (tab = 'fleets')}>Fleets</button>
    <button class:active={tab === 'designer'} data-testid="tab-designer" onclick={() => (tab = 'designer')}>Designer</button>
    <button class:active={tab === 'empires'} data-testid="tab-empires" onclick={() => (tab = 'empires')}>Empires</button>
    <button
      class:active={tab === 'reports'}
      data-testid="tab-reports"
      onclick={() => {
        tab = 'reports';
        seenReports = app.reports.length;
      }}
    >Reports{app.reports.length > seenReports ? ` (${app.reports.length - seenReports})` : ''}</button>
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
    {:else if tab === 'reports'}
      <Reports />
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
    <select data-testid="chat-to" bind:value={chatTo} title="everyone or a direct message">
      <option value={-1}>all</option>
      {#each roster.filter((p) => p.id !== session().playerId) as p (p.id)}
        <option value={p.id}>DM {p.name}</option>
      {/each}
    </select>
    <input data-testid="chat-input" bind:value={chatText} placeholder={chatTo === -1 ? 'chat…' : 'direct message…'} onkeydown={(e) => e.key === 'Enter' && sendChat()} />
    <button data-testid="chat-send" onclick={sendChat}>Send</button>
    <span class="chatlog" data-testid="chat-log">
      {#each chatVisible.slice(-3) as m (m.id)}
        <span class:dm={m.to !== -1}>#{m.from}{m.to !== -1 ? '→' + m.to : ''}: {m.text}</span>
      {/each}
    </span>
    <button class="helpbtn" data-testid="help" onclick={() => (showHelp = !showHelp)}>?</button>
    <span class="hash" data-testid="state-hash">{authHash}</span>
  </footer>
  {#if showHelp}
    <div class="help" data-testid="help-panel">
      <h3>Quick reference <button onclick={() => (showHelp = false)}>✕</button></h3>
      <ul>
        <li><b>Colonies</b> — the spreadsheet runs your empire: assign jobs (±), pick builds, buy with BC. Click headers to sort; tick rows for bulk builds.</li>
        <li><b>Turns</b> are simultaneous: everything resolves when every player commits. Uncommit any time before the last player commits.</li>
        <li><b>Food</b> feeds colonists (2 per unit ×½); shortages starve growth. Freighters move surplus between colonies — blockades cut deliveries.</li>
        <li><b>Research</b> works one field at a time; pick the application before it completes. Creative races take whole fields (or buy applications in the variant mode).</li>
        <li><b>Ships</b> travel star-to-star within fuel range (shaded on the map). Battles are a single pass: set stance/targeting/retreat before the clash.</li>
        <li><b>☠ stars</b> are guarded by monsters — clear the keeper to colonize. Orion holds the Guardian and the best worlds in the galaxy.</li>
        <li><b>Leaders</b> offer their services on the Empires tab; colony leaders boost one colony, ship officers the whole fleet.</li>
        <li><b>Victory</b>: conquer everyone, win the council vote (⅔ of population), or build the dimensional portal and beat the Antarans at home.</li>
      </ul>
    </div>
  {/if}
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
  .banner.warn {
    background: #5a442c;
  }
  button.committed {
    background: #2c5a2c;
  }
  .dm {
    color: #d7a7ff;
  }
  .helpbtn {
    margin-left: 0.5rem;
  }
  .help {
    position: fixed;
    bottom: 3rem;
    right: 1rem;
    width: 28rem;
    max-height: 60vh;
    overflow-y: auto;
    background: #141830;
    border: 1px solid #26304f;
    border-radius: 8px;
    padding: 0.6rem 1rem;
    font-size: 0.85rem;
    z-index: 20;
  }
  .help h3 {
    display: flex;
    justify-content: space-between;
    margin: 0.2rem 0 0.5rem;
  }
</style>
