<script lang="ts">
  import { PICK_ROWS, RACE_PRESETS, validatePicks, MAX_POSITIVE_PICKS, pickById, GOVERNMENTS } from '@engine/data/index';
  import type { GameSettings } from '@protocol/messages';
  import { app, getActive } from '../state.svelte';

  let ready = $state(false);
  let autoTurnTarget = $state(60);
  let presetId = $state('solari');
  let custom = $state(false);
  let customPicks = $state<string[]>(['dictatorship']);
  let raceName = $state('Custom');

  const roster = $derived.by(() => {
    void app.version;
    return getActive()?.session.getRoster() ?? [];
  });
  const selfId = $derived.by(() => getActive()?.session.playerId ?? -1);
  const settings = $derived.by(() => {
    void app.version;
    return getActive()?.session.getSettings() ?? null;
  });
  const allReady = $derived(roster.length >= 2 && roster.every((p) => p.ready || p.id === 0));
  const preset = $derived(RACE_PRESETS.find((r) => r.id === presetId));
  const validation = $derived(validatePicks(customPicks));

  // ---- sealed-bid pick auction (pick-bidding mode) ----
  const auction = $derived.by(() => {
    void app.version;
    return getActive()?.session.getAuction() ?? null;
  });
  const myContested = $derived.by(() => {
    if (!auction) return [];
    return Object.entries(auction.contested)
      .filter(([, holders]) => holders.includes(selfId))
      .map(([pickId]) => ({ pickId, base: pickById.get(pickId)?.cost ?? 0 }));
  });
  let bids = $state<Record<string, number>>({});
  function sendBids() {
    const out: Record<string, number> = {};
    for (const c of myContested) out[c.pickId] = Math.max(c.base, Math.floor(bids[c.pickId] ?? c.base));
    getActive()?.session.submitBids(out);
  }
  function empireName(id: number): string {
    return roster.find((p) => p.id === id)?.name ?? `#${id}`;
  }

  // picks grouped for the custom builder (governments first, then by cost desc)
  const governments = PICK_ROWS.filter((p) => (GOVERNMENTS as readonly string[]).includes(p.id));
  const traits = PICK_ROWS.filter((p) => !(GOVERNMENTS as readonly string[]).includes(p.id)).sort(
    (a, b) => b.cost - a.cost || a.id.localeCompare(b.id),
  );

  function pushConfig() {
    const raceJson = custom
      ? JSON.stringify({ picks: [...customPicks].sort(), raceName })
      : JSON.stringify({ presetId });
    getActive()?.session.setRaceConfig(raceJson, ready);
  }
  function toggleReady() {
    ready = !ready;
    pushConfig();
  }
  function togglePick(id: string) {
    if ((GOVERNMENTS as readonly string[]).includes(id)) {
      customPicks = [id, ...customPicks.filter((p) => !(GOVERNMENTS as readonly string[]).includes(p))];
    } else if (customPicks.includes(id)) {
      customPicks = customPicks.filter((p) => p !== id);
    } else {
      customPicks = [...customPicks, id];
    }
    pushConfig();
  }
  function start() {
    pushConfig();
    getActive()?.startGame();
  }

  function updateMode<K extends keyof GameSettings['modes']>(key: K, value: boolean) {
    const host = getActive()?.host;
    if (!host || !settings) return;
    host.updateSettings({ ...settings, modes: { ...settings.modes, [key]: value } });
  }
  function updateSetting<K extends keyof GameSettings>(key: K, value: GameSettings[K]) {
    const host = getActive()?.host;
    if (!host || !settings) return;
    host.updateSettings({ ...settings, [key]: value });
  }

  function describe(raceJson: string | null): string {
    if (!raceJson) return '';
    try {
      const cfg = JSON.parse(raceJson) as { presetId?: string; raceName?: string; picks?: string[] };
      if (cfg.presetId) return RACE_PRESETS.find((r) => r.id === cfg.presetId)?.name ?? 'custom';
      return cfg.raceName ?? 'custom';
    } catch {
      return '';
    }
  }

  const MODE_HELP: Array<{ key: keyof GameSettings['modes']; label: string; help: string }> = [
    { key: 'creativeVariant', label: 'Creative variant', help: 'Creative races research each application individually instead of getting whole fields free.' },
    { key: 'pickBidding', label: 'Pick bidding', help: 'Contested race picks go to sealed-bid auction; winners pay their bid in pick points.' },
    { key: 'stickyBuild', label: 'Sticky build', help: 'Switching build items parks invested production on the old item instead of carrying it over.' },
    { key: 'antarans', label: 'Antaran attacks', help: 'Raiders from another dimension strike the largest empire; build the portal to strike back and win.' },
    { key: 'randomEvents', label: 'Random events', help: 'Galactic windfalls and disasters. Lucky races dodge the bad ones.' },
  ];
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

{#if settings && selfId === 0}
  <fieldset class="modes">
    <legend>Game setup (host)</legend>
    <label>
      Galaxy:
      <select
        data-testid="galaxy-size"
        value={settings.galaxySize}
        onchange={(e) => updateSetting('galaxySize', (e.target as HTMLSelectElement).value as GameSettings['galaxySize'])}
      >
        {#each ['small', 'medium', 'large', 'huge'] as g (g)}<option value={g}>{g}</option>{/each}
      </select>
    </label>
    <label>
      Start:
      <select
        data-testid="start-mode"
        value={settings.startMode}
        onchange={(e) => updateSetting('startMode', (e.target as HTMLSelectElement).value as GameSettings['startMode'])}
      >
        <option value="pre_warp">pre-warp</option>
        <option value="average">average</option>
      </select>
    </label>
    <label title="every player's home system gets the identical second world">
      Home system:
      <select
        data-testid="home-start"
        value={settings.homeStart ?? 'good'}
        onchange={(e) => updateSetting('homeStart', (e.target as HTMLSelectElement).value as GameSettings['homeStart'])}
      >
        <option value="good">good start (ultra-rich sibling)</option>
        <option value="min">min start (abundant sibling)</option>
      </select>
    </label>
    <label title="the galaxy is built from identical rotated wedges — every player starts on the edge with exactly the same nearby stars, planets and keepers">
      <input
        type="checkbox"
        data-testid="mode-mirror"
        checked={settings.mirror ?? false}
        onchange={(e) => updateSetting('mirror', (e.target as HTMLInputElement).checked)}
      />
      Mirror galaxy
    </label>
    {#each MODE_HELP as m (m.key)}
      <label title={m.help}>
        <input
          type="checkbox"
          data-testid="mode-{m.key}"
          checked={settings.modes[m.key]}
          onchange={(e) => updateMode(m.key, (e.target as HTMLInputElement).checked)}
        />
        {m.label}
      </label>
    {/each}
    <label title="Once everyone has committed the first turn, the host fast-forwards turns automatically up to this turn (battles still pause for orders).">
      <input
        type="checkbox"
        data-testid="auto-turn"
        checked={(settings.autoTurnUntil ?? 0) > 0}
        onchange={(e) => updateSetting('autoTurnUntil', (e.target as HTMLInputElement).checked ? autoTurnTarget : 0)}
      />
      Auto-turn to
      <input
        type="number"
        data-testid="auto-turn-until"
        min="2"
        max="500"
        value={(settings.autoTurnUntil ?? 0) > 0 ? settings.autoTurnUntil : autoTurnTarget}
        disabled={(settings.autoTurnUntil ?? 0) <= 0}
        oninput={(e) => {
          autoTurnTarget = Math.max(2, Math.floor(Number((e.target as HTMLInputElement).value) || 0));
          updateSetting('autoTurnUntil', autoTurnTarget);
        }}
        style="width:4rem"
      />
    </label>
  </fieldset>
{:else if settings}
  <p class="dim" data-testid="settings-view">
    {settings.galaxySize} galaxy, {settings.startMode} start —
    {MODE_HELP.filter((m) => settings.modes[m.key]).map((m) => m.label).join(', ') || 'no optional modes'}{(settings.autoTurnUntil ?? 0) > 0 ? ` — auto-turn to ${settings.autoTurnUntil}` : ''}
  </p>
{/if}

<div class="race">
  <label>
    <input type="radio" checked={!custom} onchange={() => { custom = false; pushConfig(); }} /> Preset:
    <select data-testid="race-select" bind:value={presetId} onchange={pushConfig} disabled={custom}>
      {#each RACE_PRESETS as r (r.id)}
        <option value={r.id}>{r.name}</option>
      {/each}
    </select>
  </label>
  {#if preset && !custom}
    <p class="dim">
      {preset.picks
        .map((p) => `${p}${(pickById.get(p)?.cost ?? 0) >= 0 ? '' : ' (flaw)'}`)
        .join(', ')}
    </p>
  {/if}

  <label>
    <input type="radio" data-testid="custom-race" checked={custom} onchange={() => { custom = true; pushConfig(); }} /> Custom race — empire name:
    <input data-testid="empire-name" bind:value={raceName} disabled={!custom} maxlength="20" style="width:9rem" placeholder="name your empire" onchange={pushConfig} />
  </label>
  {#if custom}
    <p data-testid="pick-budget" class:bad={!validation.ok}>
      {validation.cost}/{MAX_POSITIVE_PICKS} points spent
      {validation.errors.length ? ` — ${validation.errors.join('; ')}` : ' ✓'}
    </p>
    <div class="picks">
      <div class="col">
        <b>Government</b>
        {#each governments as g (g.id)}
          <label>
            <input type="radio" name="gov" checked={customPicks.includes(g.id)} onchange={() => togglePick(g.id)} />
            {g.id} ({g.cost >= 0 ? '+' : ''}{g.cost})
          </label>
        {/each}
      </div>
      <div class="col traits">
        <b>Traits</b>
        {#each traits as t (t.id)}
          <label title={t.meaning}>
            <input
              type="checkbox"
              data-testid="pick-{t.id}"
              checked={customPicks.includes(t.id)}
              onchange={() => togglePick(t.id)}
            />
            {t.id} ({t.cost >= 0 ? '+' : ''}{t.cost})
          </label>
        {/each}
      </div>
    </div>
  {/if}
</div>

{#if auction}
  <fieldset class="modes" data-testid="auction">
    <legend>Pick auction — sealed bids</legend>
    {#if auction.phase === 'commit'}
      {#if myContested.length && !auction.committed}
        <p>Contested picks you hold — bid pick points (minimum = base cost; the premium comes out of your budget). Losers forfeit the pick.</p>
        {#each myContested as c (c.pickId)}
          <label>
            {c.pickId} (base {c.base}):
            <input type="number" data-testid="bid-{c.pickId}" min={c.base} value={bids[c.pickId] ?? c.base}
              oninput={(e) => (bids = { ...bids, [c.pickId]: Number((e.target as HTMLInputElement).value) })} style="width:4rem" />
          </label>
        {/each}
        <button data-testid="submit-bids" onclick={sendBids}>Seal bids</button>
      {:else if auction.committed}
        <p data-testid="auction-waiting">Bids sealed — waiting for the other bidders…</p>
      {:else}
        <p data-testid="auction-waiting">None of your picks are contested — waiting for the auction…</p>
      {/if}
    {:else if auction.phase === 'reveal'}
      <p data-testid="auction-waiting">All bids sealed — revealing…</p>
    {:else if auction.outcomes}
      <ul data-testid="auction-results">
        {#each auction.outcomes as o (o.pickId)}
          <li>{o.pickId}: {o.winner === null ? 'no valid bids — everyone keeps it' : `${empireName(o.winner)} wins at ${o.price} points`}</li>
        {/each}
      </ul>
    {/if}
  </fieldset>
{/if}

{#if selfId !== 0}
  <button data-testid="ready" onclick={toggleReady} disabled={custom && !validation.ok}>{ready ? 'Unready' : 'Ready'}</button>
{:else}
  <button data-testid="start" onclick={start} disabled={!allReady || (custom && !validation.ok) || !!auction}>Start game</button>
  <p class="hint">start enables when all other players are ready</p>
{/if}

<style>
  .hint,
  .dim {
    opacity: 0.6;
    font-size: 0.85rem;
  }
  .modes {
    display: flex;
    gap: 0.9rem;
    flex-wrap: wrap;
    border: 1px solid #26304f;
    margin-bottom: 0.8rem;
    max-width: 60rem;
  }
  .race {
    margin: 0.6rem 0;
  }
  .picks {
    display: flex;
    gap: 2rem;
    max-height: 18rem;
    overflow-y: auto;
    border: 1px solid #26304f;
    padding: 0.5rem;
    max-width: 60rem;
  }
  .col {
    display: flex;
    flex-direction: column;
    gap: 0.15rem;
    font-size: 0.85rem;
  }
  .col.traits {
    flex-wrap: wrap;
    max-height: 17rem;
    column-gap: 1.4rem;
  }
  .bad {
    color: #ff7b7b;
  }
</style>
