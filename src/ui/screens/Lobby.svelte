<script lang="ts">
  import { PICK_ROWS, PICK_EXCLUSIVE_GROUPS, RACE_PRESETS, validatePicks, pickById, GOVERNMENTS, type PickRow } from '@engine/data/index';
  import type { GameSettings } from '@protocol/messages';
  import { app, getActive } from '../state.svelte';
  import { PLAYER_COLORS } from '../colors';

  let ready = $state(false);
  let presetId = $state('solari');
  let custom = $state(false);
  let customPicks = $state<string[]>(['dictatorship']);
  let raceName = $state('Custom');
  let showDetails = $state(false);
  /** chosen banner color; null = the classic per-seat default */
  let bannerColor = $state<string | null>(null);

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
  const budget = $derived(settings?.pickPoints ?? 10);
  const validation = $derived(validatePicks(customPicks, budget));
  const remaining = $derived(budget - validation.cost);

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

  // ---- custom race pick catalog ----
  // 3-tier categories become radio fieldsets with an explicit "Normal" option;
  // governments are a radio fieldset; everything else is a Special Abilities checkbox.
  function signed(n: number): string {
    return n >= 0 ? `+${n}` : `−${-n}`;
  }
  function costLabel(cost: number): string {
    if (cost === 0) return 'Costs 0 picks';
    return cost > 0 ? `Costs ${cost} pick${cost === 1 ? '' : 's'}` : `Grants ${-cost} pick${cost === -1 ? '' : 's'}`;
  }

  const TIER_CATS: Array<{ key: string; label: string; name: (v: number) => string }> = [
    { key: 'growth', label: 'Population', name: (v) => `${signed(v)}% Growth` },
    { key: 'farming', label: 'Farming', name: (v) => `${signed(v)} Food` },
    { key: 'industry', label: 'Industry', name: (v) => `${signed(v)} Production` },
    { key: 'science', label: 'Science', name: (v) => `${signed(v)} Research` },
    { key: 'money', label: 'Money', name: (v) => `${signed(v)} BC` },
    { key: 'defense', label: 'Ship Defense', name: (v) => `${signed(v)} Ship Defense` },
    { key: 'attack', label: 'Ship Attack', name: (v) => `${signed(v)} Ship Attack` },
    { key: 'ground', label: 'Ground Combat', name: (v) => `${signed(v)} Ground Combat` },
    { key: 'spying', label: 'Spying', name: (v) => `${signed(v)} Spying` },
  ];

  const SPECIAL_NAMES: Record<string, string> = {
    lowg_world: 'Low-G World',
    highg_world: 'High-G World',
    large_hw: 'Large Home World',
    rich_hw: 'Rich Home World',
    poor_hw: 'Poor Home World',
    arti_world: 'Artifacts World',
    trans_dimensional: 'Trans-Dimensional',
    out_of_box_thinking: 'Out-of-the-Box Thinking',
  };
  function titleCase(id: string): string {
    return id
      .split('_')
      .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
      .join(' ');
  }
  function pickName(row: PickRow): string {
    const cat = TIER_CATS.find((c) => (PICK_EXCLUSIVE_GROUPS[c.key] ?? []).includes(row.id));
    if (cat && row.value !== null) return cat.name(row.value);
    return SPECIAL_NAMES[row.id] ?? titleCase(row.id);
  }

  const tierFieldsets = TIER_CATS.map((cat) => ({
    ...cat,
    picks: (PICK_EXCLUSIVE_GROUPS[cat.key] ?? [])
      .map((id) => pickById.get(id))
      .filter((p): p is PickRow => !!p)
      .slice()
      .sort((a, b) => a.cost - b.cost),
  }));
  const tierIds = new Set(tierFieldsets.flatMap((f) => f.picks.map((p) => p.id)));
  const governments = GOVERNMENTS.map((id) => pickById.get(id)).filter((p): p is PickRow => !!p);
  const specials = $derived(
    PICK_ROWS.filter(
      (p) =>
        !tierIds.has(p.id) &&
        !(GOVERNMENTS as readonly string[]).includes(p.id) &&
        // mode-gated pick: only offered when the game option is on
        (p.id !== 'out_of_box_thinking' || settings?.modes.outOfBoxThinking === true),
    )
      .slice()
      .sort((a, b) => pickName(a).localeCompare(pickName(b))),
  );

  // responsive columns like the mock: economy tiers | combat tiers + government | specials
  const columnA = tierFieldsets.slice(0, 5);
  const columnB = tierFieldsets.slice(5);

  function pushConfig() {
    const color = bannerColor ? { color: bannerColor } : {};
    const raceJson = custom
      ? JSON.stringify({ picks: [...customPicks].sort(), raceName, ...color })
      : JSON.stringify({ presetId, ...color });
    getActive()?.session.setRaceConfig(raceJson, ready);
  }
  /** the color each seat will play with (their pick, else the seat default) */
  function seatColor(p: { id: number; raceJson: string | null }): string {
    try {
      const c = p.raceJson ? (JSON.parse(p.raceJson) as { color?: string }).color : undefined;
      if (typeof c === 'string' && /^#[0-9a-f]{6}$/i.test(c)) return c.toLowerCase();
    } catch {
      /* fall through to the seat default */
    }
    return PLAYER_COLORS[p.id % PLAYER_COLORS.length]!;
  }
  const takenColors = $derived(new Set(roster.filter((p) => p.id !== selfId).map((p) => seatColor(p))));
  function chooseColor(c: string | null) {
    bannerColor = c;
    pushConfig();
  }
  function toggleReady() {
    ready = !ready;
    pushConfig();
  }
  /** Select a pick, clearing every other member of any exclusive group it belongs to. */
  function addPick(id: string) {
    let next = customPicks.filter((p) => p !== id);
    for (const members of Object.values(PICK_EXCLUSIVE_GROUPS)) {
      if (members.includes(id)) next = next.filter((p) => !members.includes(p));
    }
    customPicks = [...next, id];
    pushConfig();
  }
  /** The explicit "Normal" radio: clear all picks of a tier category. */
  function clearGroup(members: readonly string[]) {
    customPicks = customPicks.filter((p) => !members.includes(p));
    pushConfig();
  }
  function toggleSpecial(id: string, checked: boolean) {
    if (checked) {
      addPick(id);
    } else {
      customPicks = customPicks.filter((p) => p !== id);
      pushConfig();
    }
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
    { key: 'antarans', label: 'Andromedan attacks', help: 'Raiders from another dimension strike the largest empire; build the portal to strike back and win.' },
    { key: 'randomEvents', label: 'Random events', help: 'Galactic windfalls and disasters. Lucky races dodge the bad ones.' },
    { key: 'outOfBoxThinking', label: 'Out-of-the-box thinking', help: 'Unlocks a 2-point race pick: buy technologies you skipped in completed fields, each at the full field price in research points.' },
    { key: 'constructionShip', label: 'Construction ship', help: 'Endgame reward: once every construction field is researched you can build a planetary construction ship that flies to an asteroid belt or gas giant and rebuilds it into a barren world.' },
  ];
</script>

{#snippet pickOption(p: PickRow, kind: 'radio' | 'checkbox', groupName: string, onpick: () => void)}
  <label class="option" title={p.meaning}>
    {#if kind === 'radio'}
      <input
        type="radio"
        name={groupName}
        data-testid="pick-{p.id}"
        checked={customPicks.includes(p.id)}
        onchange={onpick}
        aria-describedby="pick-desc-{p.id}"
      />
    {:else}
      <input
        type="checkbox"
        data-testid="pick-{p.id}"
        checked={customPicks.includes(p.id)}
        onchange={(e) => toggleSpecial(p.id, (e.target as HTMLInputElement).checked)}
        aria-describedby="pick-desc-{p.id}"
      />
    {/if}
    <span class="option-name">{pickName(p)}</span>
    <span class="pick-cost" class:gain={p.cost < 0} aria-label={costLabel(p.cost)}>{signed(p.cost)}</span>
    <span class="detail" id="pick-desc-{p.id}" role="tooltip">{p.meaning}</span>
  </label>
{/snippet}

{#snippet tierFieldset(cat: (typeof tierFieldsets)[number])}
  <fieldset class="pick-group">
    <legend>{cat.label}</legend>
    <label class="option normal-option" title="No racial modifier.">
      <input
        type="radio"
        name="cat-{cat.key}"
        data-testid="pick-{cat.key}-normal"
        checked={!cat.picks.some((p) => customPicks.includes(p.id))}
        onchange={() => clearGroup(cat.picks.map((p) => p.id))}
        aria-describedby="pick-desc-{cat.key}-normal"
      />
      <span class="option-name">Normal</span>
      <span class="pick-cost" aria-label="Costs 0 picks">+0</span>
      <span class="detail" id="pick-desc-{cat.key}-normal" role="tooltip">No racial modifier.</span>
    </label>
    {#each cat.picks as p (p.id)}
      {@render pickOption(p, 'radio', `cat-${cat.key}`, () => addPick(p.id))}
    {/each}
  </fieldset>
{/snippet}

<div class="lobbywrap">
<h2>Lobby — room {getActive()?.params.code}</h2>
<ul data-testid="roster">
  {#each roster as p (p.id)}
    <li>
      <span class="colorchip" style="background:{seatColor(p)}"></span>
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
    <button
      class="preset"
      data-testid="quick-game-preset"
      title="One click to a game that finishes in well under an hour, with the rules untouched: small galaxy · advanced start (big identical developed empires) · ⚡ fast start (async turns until contact) · ⏱ 10-second realtime turns — battles run on the same 10s clock. Tweak anything below afterwards."
      onclick={() => {
        const host = getActive()?.host;
        if (!host || !settings) return;
        host.updateSettings({
          ...settings,
          galaxySize: 'small',
          startMode: 'advanced',
          fastStart: true,
          realtimeTurnSeconds: 10,
          autoTurnSeconds: 60,
        });
      }}
    >⚡ Blitz preset (~30-minute game)</button>
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
    <label title="pre-warp: the classic MOO2 primitive age — only the construction basics are known; the electronic computer, lasers, drives, fuel cells and colony ships must all be researched; one scout, no colony ship, star base built. average (default): the classic MOO2 opening — tier-1 basics plus a tech head start, two scouts + a colony ship, star base built. advanced: everyone begins with an identical developed empire — the players' regions together cover ~1/3 of the map with identical worlds system-for-system, every planet half full, freighters covering the food runs, and 5 scouts at the frontier.">
      Start:
      <select
        data-testid="start-mode"
        value={settings.startMode}
        onchange={(e) => updateSetting('startMode', (e.target as HTMLSelectElement).value as GameSettings['startMode'])}
      >
        <option value="pre_warp">pre-warp (research nearly everything)</option>
        <option value="average">average (classic opening)</option>
        <option value="advanced">advanced (big identical empires)</option>
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
    <label title="budget of points a custom race may spend on picks">
      Pick points:
      <select
        data-testid="pick-points"
        value={settings.pickPoints ?? 10}
        onchange={(e) => updateSetting('pickPoints', Number((e.target as HTMLSelectElement).value))}
      >
        <option value={10}>10 (classic)</option>
        <option value={12}>12</option>
        <option value={14}>14</option>
        <option value={16}>16</option>
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
    <label title={settings.startMode === 'advanced'
      ? 'the advanced start already builds the big empires — this toggle is superseded'
      : 'every player begins with a bubble of 10-20 colonies around their homeworld, each ~1/3-1/2 populated — a fast, sprawling start'}>
      <input
        type="checkbox"
        data-testid="mode-bigstart"
        disabled={settings.startMode === 'advanced'}
        checked={settings.startMode !== 'advanced' && (settings.bigStart ?? false)}
        onchange={(e) => updateSetting('bigStart', (e.target as HTMLInputElement).checked)}
      />
      Big empires start
    </label>
    <label title="End turns at your own pace — nobody waits for anybody until two empires meet. The host simulation advances with the slowest player; when CONTACT flashes, everyone is pulled back to the synced turn (you can save right there) and play continues turn-by-turn. Monster fights auto-resolve until then. You can never run more than 10 turns ahead of the slowest player.">
      <input
        type="checkbox"
        data-testid="mode-faststart"
        checked={settings.fastStart ?? false}
        onchange={(e) => updateSetting('fastStart', (e.target as HTMLInputElement).checked)}
      />
      ⚡ Fast start (async turns until contact)
    </label>
    {#if settings.debugCommands}
      <label title="DEBUG: every empire begins with the entire technology tree already researched — every application known, every field completed. For testing only.">
        <input
          type="checkbox"
          data-testid="mode-unlock-all-tech"
          checked={settings.unlockAllTech ?? false}
          onchange={(e) => updateSetting('unlockAllTech', (e.target as HTMLInputElement).checked)}
        />
        🐞 Start with all tech unlocked
      </label>
    {/if}
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
    <label title="Once every player except one has committed, the turn advances automatically after this long — nobody can hold the table hostage. Turns always advance one at a time.">
      Auto-turn timer:
      <select
        data-testid="auto-turn-seconds"
        value={settings.autoTurnSeconds ?? 0}
        onchange={(e) => updateSetting('autoTurnSeconds', Number((e.target as HTMLSelectElement).value))}
      >
        <option value={0}>off</option>
        <option value={30}>30s after all but one commit</option>
        <option value={60}>60s after all but one commit</option>
        <option value={120}>2min after all but one commit</option>
        <option value={300}>5min after all but one commit</option>
      </select>
    </label>
    <label title="Realtime: the turn clock starts ticking the moment each turn opens — commit sooner if you like, but when the timer runs out the turn advances without waiting for anyone. (The auto-turn timer above only starts once all but one player have committed.)">
      ⏱ Realtime turns:
      <select
        data-testid="realtime-turn-seconds"
        value={settings.realtimeTurnSeconds ?? 0}
        onchange={(e) => updateSetting('realtimeTurnSeconds', Number((e.target as HTMLSelectElement).value))}
      >
        <option value={0}>off</option>
        <option value={5}>5s per turn (blitz)</option>
        <option value={10}>10s per turn</option>
        <option value={15}>15s per turn</option>
        <option value={20}>20s per turn</option>
        <option value={30}>30s per turn</option>
        <option value={60}>60s per turn</option>
      </select>
    </label>
  </fieldset>
{:else if settings}
  <p class="dim" data-testid="settings-view">
    {settings.galaxySize} galaxy, {settings.startMode} start —
    {MODE_HELP.filter((m) => settings.modes[m.key]).map((m) => m.label).join(', ') || 'no optional modes'}{(settings.realtimeTurnSeconds ?? 0) > 0 ? ` — ⏱ REALTIME ${settings.realtimeTurnSeconds}s turns` : (settings.autoTurnSeconds ?? 0) > 0 ? ` — auto-turn ${settings.autoTurnSeconds}s after all but one commit` : ''}{(settings.pickPoints ?? 10) !== 10 ? ` — ${settings.pickPoints} pick points` : ''}
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

  <div class="colorpick" data-testid="color-pick">
    <span>Banner color:</span>
    <button
      type="button"
      class="swatch auto"
      class:active={bannerColor === null}
      title="automatic (seat color)"
      onclick={() => chooseColor(null)}
    >A</button>
    {#each PLAYER_COLORS as c (c)}
      <button
        type="button"
        class="swatch"
        class:active={bannerColor === c}
        class:taken={takenColors.has(c) && bannerColor !== c}
        style="background:{c}"
        title={takenColors.has(c) && bannerColor !== c ? `${c} — taken by another player` : c}
        disabled={takenColors.has(c) && bannerColor !== c}
        onclick={() => chooseColor(c)}
        aria-label="banner color {c}"
      ></button>
    {/each}
  </div>
  {#if custom}
    <div class="picks-toolbar">
      <div class="status" aria-live="polite" data-testid="pick-budget" class:bad={!validation.ok}>
        <span>Picks remaining</span>
        <strong>{remaining}</strong>
      </div>
      <label class="details-toggle">
        <input type="checkbox" bind:checked={showDetails} /> Show all descriptions
      </label>
    </div>
    {#if validation.errors.length}
      <p class="bad pick-errors" data-testid="pick-errors" aria-live="polite">{validation.errors.join('; ')}</p>
    {/if}
    <div class="picks" class:show-details={showDetails}>
      <div class="columns">
        <div class="column">
          {#each columnA as cat (cat.key)}
            {@render tierFieldset(cat)}
          {/each}
        </div>
        <div class="column">
          {#each columnB as cat (cat.key)}
            {@render tierFieldset(cat)}
          {/each}
          <fieldset class="pick-group">
            <legend>Government</legend>
            {#each governments as g (g.id)}
              {@render pickOption(g, 'radio', 'cat-government', () => addPick(g.id))}
            {/each}
          </fieldset>
        </div>
        <div class="column special-column">
          <fieldset class="pick-group">
            <legend>Special Abilities</legend>
            {#each specials as p (p.id)}
              {@render pickOption(p, 'checkbox', 'special', () => {})}
            {/each}
          </fieldset>
        </div>
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
</div>

<style>
  /* frame the lobby like the home hero — bare full-width text read as broken */
  .lobbywrap {
    max-width: 64rem;
    margin: 1.5rem auto;
    padding: 1.1rem 1.6rem 1.5rem;
    background: linear-gradient(
      180deg,
      color-mix(in srgb, var(--panel-2) 92%, transparent),
      color-mix(in srgb, var(--panel) 92%, transparent)
    );
    border: 1px solid var(--line-bright);
    border-radius: 8px;
    box-shadow: 0 8px 40px rgba(0, 0, 0, 0.5);
  }
  .lobbywrap h2 {
    margin-top: 0;
    text-transform: uppercase;
    letter-spacing: 0.08em;
    color: var(--accent-soft);
  }
  .hint,
  .dim {
    opacity: 0.6;
    font-size: 0.85rem;
  }
  .colorchip {
    display: inline-block;
    width: 0.8rem;
    height: 0.8rem;
    border-radius: 50%;
    border: 1px solid var(--bg);
    vertical-align: -1px;
    margin-right: 0.25rem;
  }
  .colorpick {
    display: flex;
    align-items: center;
    gap: 0.4rem;
    margin: 0.5rem 0;
  }
  .swatch {
    width: 1.4rem;
    height: 1.4rem;
    border-radius: 50%;
    border: 2px solid transparent;
    cursor: pointer;
    padding: 0;
  }
  .swatch.active {
    border-color: #fff;
    box-shadow: 0 0 6px rgba(255, 255, 255, 0.6);
  }
  .swatch.taken {
    opacity: 0.25;
    cursor: not-allowed;
  }
  .swatch.auto {
    background: conic-gradient(var(--accent), #ff6b5e, var(--good), var(--gold), var(--accent));
    color: var(--bg);
    font-size: 0.7rem;
    font-weight: 700;
    line-height: 1;
  }
  .modes {
    display: flex;
    gap: 0.9rem;
    flex-wrap: wrap;
    border: 1px solid var(--panel-3);
    margin-bottom: 0.8rem;
    max-width: 60rem;
  }
  .race {
    margin: 0.6rem 0;
  }
  .bad {
    color: var(--bad, #ff7b7b);
  }

  /* ---- custom race picks (accessible layout) ---- */
  .picks-toolbar {
    display: flex;
    flex-wrap: wrap;
    gap: 0.65rem 1.25rem;
    align-items: center;
    margin: 0.6rem 0 0.4rem;
  }
  .status {
    min-width: 8rem;
    background: var(--bg, var(--bg));
    border: 1px solid var(--line, var(--line));
    border-radius: 0.35rem;
    padding: 0.35rem 0.65rem;
    text-align: center;
    font-size: 0.85rem;
  }
  .status strong {
    display: block;
    color: var(--accent-soft, var(--accent-soft));
    font-size: 1.2rem;
    font-variant-numeric: tabular-nums;
  }
  .status.bad,
  .status.bad strong {
    color: var(--bad, var(--bad));
    border-color: var(--bad, var(--bad));
  }
  .details-toggle {
    display: inline-flex;
    align-items: center;
    gap: 0.45rem;
    font-size: 0.85rem;
  }
  .pick-errors {
    margin: 0.2rem 0 0.4rem;
    font-size: 0.85rem;
  }
  .picks {
    max-width: 72rem;
  }
  .columns {
    display: grid;
    grid-template-columns: 1fr 1fr 1.15fr;
    gap: 0.75rem;
    align-items: start;
  }
  .column {
    display: grid;
    gap: 0.75rem;
    min-width: 0;
  }
  fieldset.pick-group {
    min-width: 0;
    margin: 0;
    padding: 0.55rem;
    border: 1px solid var(--line, var(--line));
    border-radius: 0.65rem;
    background: linear-gradient(180deg, var(--panel, var(--panel)), var(--bg, var(--bg)));
  }
  fieldset.pick-group legend {
    padding: 0 0.45rem;
    color: var(--accent, var(--accent));
    font-size: 0.95rem;
    font-weight: 700;
  }
  .option {
    position: relative;
    display: grid;
    grid-template-columns: 1.1rem minmax(0, 1fr) auto;
    gap: 0.45rem;
    align-items: center;
    min-height: 1.7rem;
    padding: 0.2rem 0.35rem;
    border-radius: 0.35rem;
    cursor: pointer;
    font-size: 0.85rem;
  }
  .option:hover {
    background: var(--panel-2, var(--panel-2));
  }
  .option:has(input:checked) {
    background: var(--panel-3, var(--panel-3));
    color: var(--text, var(--text));
  }
  .option input {
    width: 0.9rem;
    height: 0.9rem;
    margin: 0;
    accent-color: var(--accent, var(--accent));
  }
  .option input:focus-visible {
    outline: 2px solid var(--accent-soft, var(--accent-soft));
    outline-offset: 2px;
  }
  .option-name {
    min-width: 0;
  }
  .pick-cost {
    min-width: 2rem;
    text-align: right;
    color: var(--good, var(--good));
    font-variant-numeric: tabular-nums;
    font-weight: 700;
  }
  .pick-cost.gain {
    color: var(--gold, var(--gold));
  }
  .normal-option {
    color: var(--text-dim, var(--text-dim));
  }
  .detail {
    position: absolute;
    z-index: 50;
    left: 1.7rem;
    right: 0.2rem;
    top: calc(100% + 0.15rem);
    padding: 0.6rem;
    border: 1px solid var(--line-bright, var(--line-bright));
    border-radius: 0.4rem;
    background: var(--bg, var(--bg));
    color: var(--text, var(--text));
    box-shadow: var(--glow, 0 0 12px color-mix(in srgb, var(--accent) 35%, transparent));
    opacity: 0;
    transform: translateY(-0.25rem);
    pointer-events: none;
    transition: opacity 0.12s ease, transform 0.12s ease;
    font-size: 0.8rem;
  }
  .option:hover .detail,
  .option:focus-within .detail {
    opacity: 1;
    transform: translateY(0);
  }
  .picks.show-details .detail {
    position: static;
    grid-column: 2 / 4;
    opacity: 1;
    transform: none;
    padding: 0.15rem 0 0.3rem 0.55rem;
    border: 0;
    border-left: 2px solid var(--line, var(--line));
    border-radius: 0;
    background: transparent;
    color: var(--text-dim, var(--text-dim));
    box-shadow: none;
    pointer-events: auto;
  }
  @media (max-width: 950px) {
    .columns {
      grid-template-columns: 1fr 1fr;
    }
    .special-column {
      grid-column: 1 / -1;
    }
  }
  @media (max-width: 650px) {
    .columns {
      grid-template-columns: 1fr;
    }
    .status {
      text-align: left;
    }
    .detail {
      left: 0.2rem;
    }
  }
  @media (prefers-reduced-motion: reduce) {
    .detail {
      transition: none;
    }
  }
</style>
