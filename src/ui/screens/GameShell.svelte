<script lang="ts">
  import { selectors, gameEngine } from '@engine/index';
  import { app, getActive } from '../state.svelte';
  import { latchEdge, type EdgeLatch, type EdgeLevel } from '../commitEdge';
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
  /** labs idle: no field selected and nothing queued — RP is being banked */
  const researchIdle = $derived(summary !== null && summary.researching === null);
  /** commit urgency: red = everyone else committed and they are waiting on you;
   * green = others have started committing. Latched one-way per turn so an
   * opponent cycling commit/uncommit cannot flash the screen. */
  const othersTotal = $derived(roster.length - 1);
  const othersCommitted = $derived(committed.filter((id) => id !== session().playerId).length);
  const commitEdge = $derived<EdgeLevel>(
    iCommitted || othersTotal <= 0 || othersCommitted === 0
      ? ''
      : othersCommitted === othersTotal
        ? 'red'
        : 'green',
  );
  let edgeLatch = $state<EdgeLatch>({ turn: 0, level: '' });
  $effect(() => {
    const next = latchEdge(edgeLatch, gs?.turn ?? 0, gs?.phase ?? 'planning', commitEdge);
    if (next !== edgeLatch) edgeLatch = next;
  });
  const edgeShown = $derived(iCommitted || (gs?.turn ?? 0) !== edgeLatch.turn ? '' : edgeLatch.level);
  const memoryOnly = $derived.by(() => {
    void app.version;
    return getActive()?.memoryOnly ?? false;
  });
  let memoryNoteDismissed = $state(false);
  const autoTurnUntil = $derived.by(() => {
    void app.version;
    return session().getSettings()?.autoTurnUntil ?? 0;
  });
  /** live leader offers for this player (drives the nav badge) */
  const leaderOfferCount = $derived.by(() => {
    if (!gs) return 0;
    const me = session().playerId;
    return gs.leaderOffers.filter((o) => o.empireId === me && o.expiresTurn > gs.turn).length;
  });

  // ---- research breakthrough celebration ----
  let celebration = $state<{ field: string; granted: string[] } | null>(null);
  let celebrationTimer: ReturnType<typeof setTimeout> | null = null;
  let processedReports = 0;
  $effect(() => {
    const reports = app.reports;
    if (reports.length < processedReports) processedReports = 0; // cleared
    for (let i = processedReports; i < reports.length; i++) {
      const r = reports[i]!;
      if (r.kind === 'research_complete') {
        celebration = {
          field: String(r.payload['field'] ?? ''),
          granted: (r.payload['granted'] as string[] | undefined) ?? [],
        };
        if (celebrationTimer) clearTimeout(celebrationTimer);
        celebrationTimer = setTimeout(() => (celebration = null), 8000);
      }
    }
    processedReports = reports.length;
  });
  const pretty = (id: string) => id.replaceAll('_', ' ');

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
  let saveNoHistory = $state(false);
  let botAggressive = $state(getActive()?.solo?.isAggressive() ?? false);
  async function saveGame() {
    try {
      const name = await downloadSave(getActive()!, { history: !saveNoHistory });
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
    <span class="title">MOO2<span class="v2">v2</span></span>
    <span class="stat" data-testid="turn"><span class="lbl">Turn</span> {gs.turn}</span>
    <span class="stat" data-testid="bc" title="treasury (change per turn)">💰 {summary.bc} <span class="delta" class:neg={summary.bcDelta < 0}>({summary.bcDelta >= 0 ? '+' : ''}{summary.bcDelta})</span></span>
    <span class="stat" data-testid="food" title="empire food surplus" class:neg={summary.foodNet < 0}>🌾 {summary.foodNet >= 0 ? '+' : ''}{summary.foodNet}</span>
    <span class="stat" data-testid="rp" title="research points per turn">🔬 {summary.researchPerTurn}</span>
    <span
      class="stat"
      data-testid="cp"
      class:neg={summary.cpUsage > summary.cpSources}
      title="command points: fleet upkeep {summary.cpUsage} vs support {summary.cpSources} (colonies, star bases, tech, officers). Every point over costs 10 BC per turn."
    >⚓ {summary.cpUsage}/{summary.cpSources}</span>
    <label class="tax" title="empire tax: converts this % of every colony's queue production into BC (2 prod → 1 BC)">
      🏛 tax
      <select
        data-testid="tax-rate"
        value={summary.taxRatePct}
        onchange={(e) => session().submit('set_tax_rate', { pct: Number((e.target as HTMLSelectElement).value) })}
      >
        {#each [0, 5, 10, 15, 20, 25, 30, 35, 40, 45, 50] as pct (pct)}
          <option value={pct}>{pct}%</option>
        {/each}
      </select>
    </label>
    <button
      class="researching"
      class:idle={researchIdle}
      data-testid="researching"
      title={researchIdle ? 'No research selected — your labs are idle! Click to choose.' : 'current research (click to view)'}
      onclick={() => (tab = 'research')}
    >
      {#if researchIdle}
        ⚠ no research!
      {:else}
        {pretty(summary.researching ?? '')}{summary.researchProgressPct !== null
          ? ` (${summary.researchProgressPct}%${summary.researchTurnsLeft !== null ? ` · ${summary.researchTurnsLeft}t` : ''})`
          : summary.researchTurnsLeft !== null
            ? ` (${summary.researchTurnsLeft}t)`
            : ''}
      {/if}
    </button>
    <button
      data-testid="commit"
      class="commit"
      class:committed={iCommitted}
      class:warn={researchIdle && !iCommitted}
      title={researchIdle && !iCommitted ? 'Warning: no research selected — RP will be banked unspent' : ''}
      onclick={toggleCommit}
    >{iCommitted ? 'Committed ✓' : researchIdle ? '⚠ Commit turn' : 'Commit turn'} ({committed.length}/{roster.length})</button>
    {#if getActive()?.solo}
      <label class="aggro" title="aggressive: the bot declares war and throws half its fleet at your nearest systems">
        <input
          type="checkbox"
          data-testid="bot-aggressive"
          checked={botAggressive}
          onchange={(e) => {
            getActive()?.solo?.setAggressive((e.target as HTMLInputElement).checked);
            botAggressive = (e.target as HTMLInputElement).checked;
          }}
        />
        🗡 aggressive bot
      </label>
    {/if}
    <span class="saves">
      <button data-testid="save-game" disabled={!getActive()?.store} onclick={saveGame}
        title={getActive()?.store ? 'Download the full game as a save file (works in any tab)' : 'persistence unavailable'}>
        💾 Save
      </button>
      <label class="dim nohist" title="strip the turn-by-turn history: final state only, smaller file, no what-if branching">
        <input type="checkbox" data-testid="save-no-history" bind:checked={saveNoHistory} /> no history
      </label>
      {#if session().playerId === 0}
        <button data-testid="save-db" disabled={!getActive()?.sqlocal} onclick={saveDb}
          title="Download the raw sqlite database">DB</button>
      {/if}
      {#if saveNote}<span class="dim" data-testid="save-note">{saveNote}</span>{/if}
    </span>
  </header>
  {#if edgeShown}
    <div class="edge {edgeShown}" aria-hidden="true"></div>
  {/if}
  {#if edgeShown === 'red'}
    <div class="banner urgent" data-testid="all-waiting">⏳ Everyone else has committed — the galaxy waits on you!</div>
  {/if}
  {#if !app.hostConnected}
    <div class="banner warn" data-testid="host-offline">
      ⚠ Host offline — the game is paused. It resumes when the host returns (or load their save file to re-host).
    </div>
  {/if}
  {#if autoTurnUntil > 0 && gs.turn < autoTurnUntil}
    <div class="banner dim" data-testid="auto-turn-banner">
      ⏩ Auto-turn: once everyone commits, turns fast-forward to turn {autoTurnUntil}.
    </div>
  {/if}
  {#if winner !== null}
    {@const winLabel = gs.winType === 'council' ? 'is elected supreme ruler of the council' : gs.winType === 'antaran' ? 'has conquered the Antaran home' : 'wins by conquest'}
    <div class="banner" data-testid="victory">Victory: {roster.find((p) => p.id === winner)?.name ?? winner} {winLabel}!</div>
  {/if}
  <nav>
    <button class:active={tab === 'colonies'} data-testid="tab-colonies" onclick={() => (tab = 'colonies')}>Colonies</button>
    <button class:active={tab === 'map'} data-testid="tab-map" onclick={() => (tab = 'map')}>Map</button>
    <button class:active={tab === 'research'} class:pulse={researchIdle} data-testid="tab-research" onclick={() => (tab = 'research')}>Research</button>
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
    {#if leaderOfferCount > 0 && tab !== 'empires'}
      <button class="offers" data-testid="leader-offer-badge" title="a leader is waiting for your answer on the Empires tab" onclick={() => (tab = 'empires')}>
        🎖 {leaderOfferCount} leader offer{leaderOfferCount > 1 ? 's' : ''}
      </button>
    {/if}
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
  {#if celebration}
    <div class="celebration" data-testid="research-celebration" role="status">
      <div class="burst">🎉</div>
      <div>
        <b>Breakthrough: {pretty(celebration.field)}!</b>
        {#if celebration.granted.length}
          <div class="apps">unlocked: {celebration.granted.map(pretty).join(' · ')}</div>
        {/if}
        {#if researchIdle}
          <button class="next" onclick={() => { tab = 'research'; celebration = null; }}>Choose next research →</button>
        {/if}
      </div>
      <button class="x" onclick={() => (celebration = null)}>✕</button>
    </div>
  {/if}
  {#if myBattle}
    <BattleOrdersDialog battle={myBattle} />
  {/if}
  {#if app.viewing}
    <BattleViewer replay={app.viewing} onclose={() => (app.viewing = null)} />
  {/if}
  {#if memoryOnly && !memoryNoteDismissed}
    <div class="banner warn" data-testid="memory-only">
      ⚠ Make sure to 💾 save every turn — the browser database is not accessible, so this tab won't survive a reload on its own.
      <button class="x" data-testid="memory-only-dismiss" title="dismiss" onclick={() => (memoryNoteDismissed = true)}>✕</button>
    </div>
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
        <li><b>Colonies</b> — the spreadsheet runs your empire: assign jobs (± or drag a job count onto another job), pick builds, buy with BC. Click headers to sort; tick rows for bulk builds; 🏛 lists buildings (sell for half price).</li>
        <li><b>Turns</b> are simultaneous: everything resolves when every player commits. Uncommit any time before the last player commits.</li>
        <li><b>Food</b> feeds colonists (2 per unit ×½); shortages starve growth. Freighters move surplus between colonies — blockades cut deliveries.</li>
        <li><b>Research</b> works one field at a time; basic fields and Cold Fusion (marked ✦) grant <i>all</i> their applications — Cold Fusion delivers colony ships, outposts, transports and freighters together. Never leave research idle — points bank but nothing finishes.</li>
        <li><b>Ships</b> travel star-to-star within fuel range (unreachable stars are dashed red on the map). Move orders can be re-routed until you commit.</li>
        <li><b>Colonists</b> move on transports: build one, "load" at a colony, fly it, "unload" (Fleets tab). Colony bases settle other planets in the same system.</li>
        <li><b>Battles</b> only happen between empires at <b>war</b> — declare it on the Empires tab. A battle is a single pass; set stance/targeting/retreat before the clash.</li>
        <li><b>☠ stars</b> are guarded by monsters — clear the keeper to colonize. Orion holds the Guardian and the best worlds in the galaxy.</li>
        <li><b>Leaders</b> offer their services on the Empires tab; colony leaders boost one colony, ship officers the whole fleet.</li>
        <li><b>Victory</b>: conquer everyone, win the council vote (⅔ of population), or build the dimensional portal and beat the Antarans at home.</li>
      </ul>
    </div>
  {/if}
{:else}
  <p class="loading">waiting for game state…</p>
{/if}

<style>
  header {
    display: flex;
    gap: 1rem;
    align-items: center;
    padding: 0.45rem 1rem;
    background: linear-gradient(180deg, rgba(23, 31, 66, 0.97), rgba(15, 21, 48, 0.97));
    border-bottom: 1px solid var(--line-bright);
    position: sticky;
    top: 0;
    flex-wrap: wrap;
    z-index: 10;
    backdrop-filter: blur(6px);
    box-shadow: 0 2px 18px rgba(0, 0, 0, 0.45);
  }
  .title {
    font-weight: 800;
    font-size: 1.1rem;
    color: var(--accent-soft);
    text-shadow: 0 0 16px rgba(110, 168, 255, 0.6);
    letter-spacing: 0.05em;
  }
  .title .v2 {
    color: var(--gold);
    font-size: 0.8rem;
    vertical-align: super;
  }
  .stat {
    font-variant-numeric: tabular-nums;
    white-space: nowrap;
  }
  .stat .lbl {
    color: var(--text-dim);
    font-size: 0.8rem;
    text-transform: uppercase;
    letter-spacing: 0.06em;
  }
  .delta {
    color: var(--good);
    font-size: 0.85rem;
  }
  .delta.neg,
  .stat.neg {
    color: var(--bad);
  }
  .researching {
    font-size: 0.85rem;
    border-color: var(--line);
  }
  .researching.idle {
    background: linear-gradient(180deg, #5a4a20, #4a3a16);
    border-color: var(--gold);
    color: var(--gold);
    animation: pulse-warn 1.6s ease-in-out infinite;
  }
  .commit {
    font-weight: 700;
    background: linear-gradient(180deg, #24418a, #1b2f66);
    border-color: #4a6ab8;
  }
  .commit.warn {
    background: linear-gradient(180deg, #8a6a1c, #6e5312);
    border-color: var(--gold);
    color: #fff2cf;
    animation: pulse-warn 1.6s ease-in-out infinite;
  }
  .commit.committed {
    background: linear-gradient(180deg, #1f6a38, #175028);
    border-color: var(--good);
  }
  @keyframes pulse-warn {
    0%, 100% { box-shadow: 0 0 0 rgba(255, 212, 121, 0); }
    50% { box-shadow: 0 0 14px rgba(255, 212, 121, 0.55); }
  }
  nav {
    display: flex;
    gap: 0.35rem;
    padding: 0.5rem 1rem 0.2rem;
  }
  nav button {
    border-radius: 8px 8px 0 0;
    border-bottom: 2px solid transparent;
    background: transparent;
    border-color: transparent;
    color: var(--text-dim);
  }
  nav button:hover:not(:disabled) {
    box-shadow: none;
    color: var(--text);
    border-color: transparent;
  }
  nav button.active {
    background: linear-gradient(180deg, var(--panel-3), var(--panel-2));
    color: var(--accent-soft);
    border: 1px solid var(--line-bright);
    border-bottom: 2px solid var(--accent);
    box-shadow: 0 -2px 14px rgba(110, 168, 255, 0.12);
  }
  nav button.pulse:not(.active) {
    color: var(--gold);
    animation: pulse-warn 1.6s ease-in-out infinite;
  }
  nav .replays {
    margin-left: auto;
    background: linear-gradient(180deg, #6e2a2a, #521d1d);
    border: 1px solid #a05050;
    color: #ffd9d0;
  }
  nav .offers {
    margin-left: auto;
    background: linear-gradient(180deg, #6a5424, #54431c);
    border: 1px solid var(--gold);
    color: #ffe9b0;
    animation: pulse-warn 1.6s ease-in-out infinite;
  }
  nav .offers + .replays {
    margin-left: 0.35rem;
  }
  section {
    padding: 0.6rem 1rem 1.2rem;
  }
  footer {
    position: sticky;
    bottom: 0;
    background: linear-gradient(0deg, rgba(15, 21, 48, 0.97), rgba(20, 27, 58, 0.97));
    border-top: 1px solid var(--line);
    padding: 0.35rem 1rem;
    display: flex;
    gap: 0.5rem;
    align-items: center;
    z-index: 10;
  }
  .chatlog {
    display: flex;
    gap: 1rem;
    opacity: 0.8;
    font-size: 0.85rem;
    overflow: hidden;
    white-space: nowrap;
  }
  .hash {
    margin-left: auto;
    opacity: 0.3;
    font-family: monospace;
    font-size: 0.72rem;
  }
  .banner {
    background: linear-gradient(180deg, #2c6a3c, #235430);
    padding: 0.5rem 1rem;
    font-weight: 700;
  }
  .banner.warn {
    background: linear-gradient(180deg, #6a5424, #54431c);
  }
  .banner.dim {
    background: var(--panel-2);
    font-weight: 400;
    color: var(--text-dim);
  }
  .banner.urgent {
    background: linear-gradient(180deg, #7a2c24, #5e211b);
    color: #ffe3dd;
  }
  .tax {
    display: inline-flex;
    align-items: center;
    gap: 0.3rem;
    font-size: 0.85rem;
    color: var(--text-dim);
  }
  .nohist {
    font-size: 0.75rem;
    display: inline-flex;
    align-items: center;
    gap: 0.2rem;
  }
  .aggro {
    font-size: 0.8rem;
    display: inline-flex;
    align-items: center;
    gap: 0.25rem;
    color: #ffb0a6;
  }
  .edge {
    position: fixed;
    inset: 0;
    pointer-events: none;
    z-index: 35;
    border-radius: 2px;
  }
  .edge.green {
    box-shadow: inset 0 0 0 3px rgba(94, 224, 138, 0.55), inset 0 0 26px rgba(94, 224, 138, 0.18);
  }
  .edge.red {
    animation: edgepulse 1.2s ease-in-out infinite;
  }
  @keyframes edgepulse {
    0%, 100% { box-shadow: inset 0 0 0 3px rgba(255, 107, 94, 0.55), inset 0 0 26px rgba(255, 107, 94, 0.16); }
    50% { box-shadow: inset 0 0 0 5px rgba(255, 107, 94, 0.95), inset 0 0 44px rgba(255, 107, 94, 0.3); }
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
    width: 30rem;
    max-height: 65vh;
    overflow-y: auto;
    background: linear-gradient(180deg, var(--panel-2), var(--panel));
    border: 1px solid var(--line-bright);
    border-radius: 10px;
    padding: 0.6rem 1rem;
    font-size: 0.85rem;
    z-index: 30;
    box-shadow: 0 12px 48px rgba(0, 0, 0, 0.6);
  }
  .help h3 {
    display: flex;
    justify-content: space-between;
    margin: 0.2rem 0 0.5rem;
  }
  .help li {
    margin-bottom: 0.35rem;
  }
  .celebration {
    position: fixed;
    top: 4rem;
    left: 50%;
    transform: translateX(-50%);
    display: flex;
    gap: 0.8rem;
    align-items: center;
    background: linear-gradient(135deg, #23408a, #1a2c5e 60%, #182450);
    border: 1px solid var(--accent);
    border-radius: 12px;
    padding: 0.7rem 1.1rem;
    z-index: 45;
    box-shadow: 0 0 40px rgba(110, 168, 255, 0.45), 0 10px 40px rgba(0, 0, 0, 0.5);
    animation: drop-in 0.45s cubic-bezier(0.2, 1.4, 0.4, 1);
  }
  @keyframes drop-in {
    from { transform: translate(-50%, -140%); opacity: 0; }
    to { transform: translate(-50%, 0); opacity: 1; }
  }
  .celebration .burst {
    font-size: 1.8rem;
    animation: spin-pop 0.8s ease;
  }
  @keyframes spin-pop {
    0% { transform: scale(0.2) rotate(-120deg); }
    70% { transform: scale(1.25) rotate(10deg); }
    100% { transform: scale(1) rotate(0); }
  }
  .celebration .apps {
    font-size: 0.85rem;
    color: var(--accent-soft);
    text-transform: capitalize;
  }
  .celebration .next {
    margin-top: 0.3rem;
    background: linear-gradient(180deg, #8a6a1c, #6e5312);
    border-color: var(--gold);
  }
  .celebration .x {
    background: transparent;
    border: none;
    color: var(--text-dim);
  }
  .loading {
    padding: 2rem;
    color: var(--text-dim);
  }
</style>
