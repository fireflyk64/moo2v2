<script lang="ts">
  import { RACE_PRESETS } from '@engine/data/index';
  import { SHIP_STYLES } from '@engine/shipstyles';
  import { BOT_RACES } from '../botRaces';
  import { PLAYER_COLORS } from '../colors';
  import { DEFAULT_SERVER, enterRoom, enterSoloGame, type SoloBotSpec } from '../net';
  import { enterPbmGame, pbmToken } from '../pbm';
  import { describeSaveError, downloadBlob, importSaveIntoRoom, previewSave, type SavePreview } from '../saveload';
  import { buildReplay, setCurrentReplay } from '../replay';
  import { enterAsyncGame } from '../net';
  import { runReconciliation } from '../reconcileRun';
  import { buildReconciliationStart } from '@storage/reconcile';
  import { encodeSaveFile, verifySaveEnvelope, type SaveEnvelope } from '@storage/index';
  import { generateSeed } from '@protocol/setup';
  import { DEFAULT_SETTINGS, type GameSettings } from '@protocol/messages';
  import { buildDayOneAsync } from '../asyncStart';
  import { checkRaceString, decodeRaceString, type RaceStringPayload } from '../raceString';
  import { app, bindActive } from '../state.svelte';
  import { BRAND } from '../brand';
  import { THEMES, applyTheme, currentTheme } from '../themes';
  import { musicEnabled, toggleMusic } from '../music';
  import ManualDialog from '../components/ManualDialog.svelte';

  let themeId = $state(currentTheme());
  let manualOpen = $state(false);
  let musicOn = $state(musicEnabled());

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

  // OnionAI default: the tournament-winning brain (bugs.md: "AI too weak")
  let botMode = $state<'parity' | 'fair' | 'onion'>('onion');

  // per-bot scenario config: play style, race (archetype or stock preset),
  // fleet silhouette and banner color — 'auto' keeps the seat defaults
  interface BotRow {
    personality: 'auto' | 'techer' | 'rusher' | 'industrialist' | 'expander' | 'militarist';
    race: string; // archetype/preset id, or 'auto' (hivex)
    shipStyle: string; // style id or 'auto'
    color: string; // #rrggbb or 'auto'
  }
  const COLOR_NAMES = ['blue', 'red', 'green', 'yellow', 'purple', 'cyan', 'orange', 'pink'];
  const defaultBot = (): BotRow => ({ personality: 'militarist', race: 'forgers', shipStyle: 'auto', color: 'auto' });
  let botRows = $state<BotRow[]>([defaultBot()]);

  async function goSolo() {
    if (!name) {
      app.error = 'enter a name first';
      return;
    }
    app.error = '';
    app.connecting = true;
    try {
      const specs: SoloBotSpec[] = botRows.map((r) => ({
        personality: r.personality,
        ...(r.race !== 'auto' ? { race: r.race } : {}),
        ...(r.shipStyle !== 'auto' ? { shipStyle: r.shipStyle } : {}),
        ...(r.color !== 'auto' ? { color: r.color } : {}),
      }));
      // the room code differentiates bot campaigns (blank = the classic SOLO
      // room), so several single-player games can run in different tabs
      const active = await enterSoloGame(name, botMode, specs[0]?.personality ?? 'militarist', specs, { code });
      bindActive(active);
    } catch (e) {
      app.error = e instanceof Error ? e.message : String(e);
    } finally {
      app.connecting = false;
    }
  }

  let preview = $state<SavePreview | null>(null);
  let resumeTurn = $state<number | 'latest'>('latest');

  // ---- play by mail ----
  let pbmPassword = $state('');
  let pbmSeatPassword = $state('');
  const pbmLoggedIn = $derived(server ? pbmToken(server) !== null : false);

  async function goPbm() {
    if (!code || !name) {
      app.error = 'name and room code are required';
      return;
    }
    if (!pbmLoggedIn && !pbmPassword) {
      app.error = 'enter the shared play-by-mail password once to log in';
      return;
    }
    app.error = '';
    app.connecting = true;
    try {
      const active = await enterPbmGame({
        server,
        code,
        name,
        ...(pbmPassword ? { password: pbmPassword } : {}),
        ...(pbmSeatPassword ? { playerPassword: pbmSeatPassword } : {}),
        createFrom: preview,
      });
      preview = null;
      pbmPassword = '';
      bindActive(active);
    } catch (e) {
      app.error = describeSaveError(e);
    } finally {
      app.connecting = false;
    }
  }

  async function onLoadFile(ev: Event) {
    const input = ev.target as HTMLInputElement;
    const file = input.files?.[0];
    input.value = '';
    if (!file) return;
    app.error = '';
    loadNote = 'verifying save…';
    preview = null;
    try {
      preview = await previewSave(new Uint8Array(await file.arrayBuffer()));
      resumeTurn = 'latest';
      asyncSeat = preview.envelope.game.local_player_id ?? preview.envelope.players[0]?.player_id ?? 0;
      loadNote = '';
    } catch (e) {
      loadNote = '';
      app.error = describeSaveError(e);
    }
  }

  /** replay mode: no room, no import — reconstruct the save's history and
   * open the viewer (any player's perspective, any turn) */
  async function watchReplay() {
    if (!preview) return;
    app.error = '';
    loadNote = 'rebuilding history…';
    try {
      const data = await buildReplay(preview, (pct) => (loadNote = `rebuilding history… ${pct}%`));
      setCurrentReplay(data);
      preview = null;
      loadNote = '';
      app.screen = 'replay';
    } catch (e) {
      loadNote = '';
      app.error = describeSaveError(e);
    }
  }

  // ---- async mode: resume the shared save solo, bots on every other seat ----
  let asyncSeat = $state(0);
  async function playAsync() {
    if (!preview) return;
    const env = preview.envelope;
    const seatName = env.players.find((p) => p.player_id === asyncSeat)?.name;
    if (!seatName) {
      app.error = 'pick which empire you play';
      return;
    }
    app.error = '';
    loadNote = 'importing async save…';
    try {
      const codeAsync = 'ASY' + env.game.game_id.replace(/[^a-zA-Z0-9]/g, '').slice(-5).toUpperCase();
      const at = resumeTurn === 'latest' ? undefined : resumeTurn;
      await importSaveIntoRoom(preview, codeAsync, 'local', at, asyncSeat);
      const others = env.players.filter((p) => p.player_id !== asyncSeat).map((p) => p.name);
      const active = await enterAsyncGame(codeAsync, seatName, others);
      preview = null;
      loadNote = '';
      bindActive(active);
    } catch (e) {
      loadNote = '';
      app.error = describeSaveError(e);
    }
  }

  // ---- day-one async: assemble a fresh game from pasted race strings ----
  let d1HostName = $state('');
  let d1HostPreset = $state('solari');
  let d1HostToken = $state('');
  let d1GuestTokens = $state('');
  let d1Galaxy = $state<GameSettings['galaxySize']>('medium');
  let d1StartMode = $state<GameSettings['startMode']>('average');
  let d1PickPoints = $state(10);
  let d1CoreWorlds = $state<'off' | 'central' | 'random'>('off');
  let d1OutOfBox = $state(false);
  let d1Note = $state('');

  interface D1Row {
    payload: RaceStringPayload | null;
    raw: string;
    summary: string;
    errors: string[];
    warnings: string[];
  }
  const d1Opts = $derived({ pickPoints: d1PickPoints, outOfBoxThinking: d1OutOfBox });
  const d1Guests = $derived.by((): D1Row[] =>
    d1GuestTokens
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l.length > 0)
      .map((raw) => {
        try {
          const payload = decodeRaceString(raw);
          const check = checkRaceString(payload, d1Opts);
          return { payload, raw, summary: `${payload.name} — ${check.summary}`, errors: check.errors, warnings: check.warnings };
        } catch (e) {
          return { payload: null, raw, summary: raw.slice(0, 24) + '…', errors: [e instanceof Error ? e.message : String(e)], warnings: [] };
        }
      }),
  );
  const d1Host = $derived.by((): RaceStringPayload => {
    if (d1HostToken.trim()) {
      try {
        const p = decodeRaceString(d1HostToken);
        return { name: d1HostName.trim() || p.name, raceJson: p.raceJson };
      } catch {
        /* fall through to the preset */
      }
    }
    return { name: d1HostName.trim() || name || 'Host', raceJson: JSON.stringify({ presetId: d1HostPreset }) };
  });
  const d1HostCheck = $derived(checkRaceString(d1Host, d1Opts));

  async function startDayOneAsync() {
    app.error = '';
    d1Note = '';
    try {
      const settings: GameSettings = {
        ...DEFAULT_SETTINGS,
        galaxySize: d1Galaxy,
        startMode: d1StartMode,
        pickPoints: d1PickPoints,
        coreWorlds: d1CoreWorlds,
        modes: { ...DEFAULT_SETTINGS.modes, outOfBoxThinking: d1OutOfBox },
      };
      const guests = d1Guests.map((g) => {
        if (!g.payload || g.errors.length) throw new Error(`fix ${g.summary}: ${g.errors.join('; ')}`);
        return g.payload;
      });
      const seed = generateSeed();
      const res = buildDayOneAsync({ host: d1Host, guests, settings, seed });
      const bytes = await encodeSaveFile(res.envelope);
      const fname = `moo2v2-async-day1-${seed.slice(0, 8)}.moo2save`;
      downloadBlob(fname, new Blob([bytes as BlobPart], { type: 'application/octet-stream' }));
      // load it straight into the preview so the host can ⏳ Play async now
      preview = await previewSave(bytes);
      resumeTurn = 'latest';
      asyncSeat = 0;
      d1Note = `✓ ${fname} downloaded — share it with everyone (${res.envelope.players.map((p) => p.name).join(', ')}); each player loads it and presses ⏳ Play async as themselves.` + (res.warnings.length ? ` ⚠ ${res.warnings.join(' · ')}` : '');
    } catch (e) {
      app.error = describeSaveError(e);
    }
  }

  // ---- reconciliation: merge everyone's async saves into what really happened ----
  interface ReconRow {
    file: string;
    seat: number;
    seatName: string;
    turn: number;
    preview: SavePreview;
  }
  let reconRows = $state<ReconRow[]>([]);
  let reconNote = $state('');
  let reconWarnings = $state<string[]>([]);
  let reconEnvelope = $state<SaveEnvelope | null>(null);
  let reconFileInput: HTMLInputElement;

  async function onReconFiles(ev: Event) {
    const input = ev.target as HTMLInputElement;
    const files = [...(input.files ?? [])];
    input.value = '';
    app.error = '';
    for (const f of files) {
      try {
        const p = await previewSave(new Uint8Array(await f.arrayBuffer()));
        const seat = p.envelope.game.local_player_id;
        const seatName = p.envelope.players.find((x) => x.player_id === seat)?.name ?? `#${seat}`;
        reconRows = [...reconRows.filter((r) => r.seat !== seat), { file: f.name, seat, seatName, turn: p.verified.turn, preview: p }].sort((a, b) => a.seat - b.seat);
      } catch (e) {
        app.error = describeSaveError(e);
      }
    }
  }

  async function reconcileNow() {
    if (!reconRows.length) return;
    app.error = '';
    reconEnvelope = null;
    try {
      reconNote = 'building the shared base…';
      await new Promise((r) => setTimeout(r, 0));
      const start = buildReconciliationStart(reconRows.map((r) => ({ envelope: r.preview.envelope, seat: r.seat })));
      reconWarnings = start.warnings;
      const res = await runReconciliation(start, (turn, cap) => {
        reconNote = `⚖ reconciling… turn ${turn} / ~${cap}`;
      });
      reconEnvelope = res.envelope;
      const w = res.finalState.winner;
      reconNote =
        `done at turn ${res.finalState.turn}` +
        (w !== null
          ? ` — ${res.envelope.players.find((p) => p.player_id === w)?.name ?? w} wins (${res.finalState.winType})`
          : ' — undecided when the scripts ran dry');
    } catch (e) {
      reconNote = '';
      app.error = describeSaveError(e);
    }
  }

  async function watchReconciliation() {
    if (!reconEnvelope) return;
    reconNote = 'rebuilding history…';
    try {
      const verified = verifySaveEnvelope(reconEnvelope);
      const data = await buildReplay(
        { envelope: reconEnvelope, verified, players: reconEnvelope.players.map((p) => p.name), resumeTurns: [] },
        (pct) => (reconNote = `rebuilding history… ${pct}%`),
      );
      setCurrentReplay(data);
      reconNote = '';
      app.screen = 'replay';
    } catch (e) {
      reconNote = '';
      app.error = describeSaveError(e);
    }
  }

  async function downloadReconciliation() {
    if (!reconEnvelope) return;
    const bytes = await encodeSaveFile(reconEnvelope);
    downloadBlob(`moo2v2-reconciliation-turn${reconEnvelope.game.last_turn}.moo2save`, new Blob([bytes as BlobPart], { type: 'application/octet-stream' }));
  }

  async function loadPreviewed() {
    if (!preview) return;
    if (!code || !name) {
      app.error = 'enter your name and a room code before loading a save';
      return;
    }
    app.error = '';
    loadNote = 'importing save…';
    try {
      const at = resumeTurn === 'latest' ? undefined : resumeTurn;
      const res = await importSaveIntoRoom(preview, code, server, at);
      loadNote = `loaded turn ${res.turn} (players: ${res.players.join(', ')}) — connecting as host…`;
      preview = null;
      await go();
    } catch (e) {
      loadNote = '';
      app.error = describeSaveError(e);
    }
  }

  // auto-join when arriving with a full URL (also the reload/resume path);
  // runs once so leaving a room doesn't bounce straight back in
  $effect(() => {
    if (q.get('room') && q.get('name') && app.screen === 'home' && !app.connecting && !app.error && !app.autoJoined) {
      app.autoJoined = true;
      void go();
    }
  });
</script>

<div class="hero">
<h1>{BRAND.title}</h1>
<p class="subtitle">{BRAND.subtitle}</p>
<p class="tag">Conquer the stars with friends — peer-to-peer, in your browser.</p>
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
  <span class="solorow">
    <button data-testid="solo" onclick={goSolo} disabled={app.connecting}
      title="offline game against local bots — no server needed. The room code names the campaign (blank = SOLO): use different codes to keep several bot games going in different tabs, and re-enter a code to resume that campaign">
      🤖 Single player vs {botRows.length > 1 ? `${botRows.length} bots` : 'bot'}{code.trim() ? ` · ${code.trim()}` : ''}
    </button>
    <select data-testid="bot-mode" bind:value={botMode} title="parity: bots keep up via visible logged grants · fair: bots play with no help at all · onion: the constraint-driven Masters-of-Onions doctrine, no help either">
      <option value="parity">parity bots (keep up)</option>
      <option value="fair">fair bots (no cheats)</option>
      <option value="onion">🧅 OnionAI (constraint bot)</option>
    </select>
  </span>
  {#each botRows as bot, i (i)}
    <span class="botrow" data-testid="bot-row-{i}">
      <span class="botlabel">Bot {i + 1}</span>
      <select data-testid="bot-personality-{i}" bind:value={bot.personality}
        title="play style: expander grabs planets, rusher/militarist come at you early, techer out-researches, industrialist out-builds">
        <option value="auto">random style</option>
        <option value="techer">techer</option>
        <option value="rusher">rusher</option>
        <option value="industrialist">industrialist</option>
        <option value="expander">expander</option>
        <option value="militarist">militarist</option>
      </select>
      <select data-testid="bot-race-{i}" bind:value={bot.race}
        title="bot archetypes rescale their race picks to the lobby's pick-point setting (repulsive + stacked traits); stock races use the fixed presets">
        <optgroup label="bot archetypes (scale with picks)">
          {#each BOT_RACES as r (r.id)}<option value={r.id}>{r.name}</option>{/each}
        </optgroup>
        <optgroup label="stock races">
          <option value="auto">Hivex Commune (default)</option>
          {#each RACE_PRESETS.filter((p) => p.id !== 'hivex') as p (p.id)}<option value={p.id}>{p.name}</option>{/each}
        </optgroup>
      </select>
      <select data-testid="bot-style-{i}" bind:value={bot.shipStyle} title="fleet silhouette family in battles">
        <option value="auto">any hulls</option>
        {#each SHIP_STYLES as s (s.id)}<option value={s.id}>{s.name} hulls</option>{/each}
      </select>
      <select data-testid="bot-color-{i}" bind:value={bot.color} title="banner color"
        style="color:{bot.color === 'auto' ? 'inherit' : bot.color}">
        <option value="auto">seat color</option>
        {#each PLAYER_COLORS as c, ci (c)}<option value={c} style="color:{c}">■ {COLOR_NAMES[ci]}</option>{/each}
      </select>
      {#if botRows.length > 1}
        <button class="botx" data-testid="bot-remove-{i}" title="remove this bot"
          onclick={() => (botRows = botRows.filter((_, j) => j !== i))}>✕</button>
      {/if}
    </span>
  {/each}
  {#if botRows.length < 7}
    <button class="botadd" data-testid="bot-add" onclick={() => (botRows = [...botRows, defaultBot()])}>
      ＋ add another bot
    </button>
  {/if}
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
  {#if preview}
    <div class="preview" data-testid="save-preview">
      <p>
        <b>Save verified:</b> turn {preview.verified.turn}, players {preview.players.join(', ')}
        {#if preview.verified.mode === 'snapshot'}
          <span class="warnline" data-testid="save-compat">⚠ from an older build — loads from its snapshot ({preview.verified.warnings.join('; ')})</span>
        {/if}
      </p>
      <label>
        Resume at turn
        <select data-testid="resume-turn" bind:value={resumeTurn}>
          <option value="latest">latest (turn {preview.verified.turn})</option>
          {#each preview.resumeTurns.filter((t) => t > 0 && t < preview!.verified.turn) as t (t)}
            <option value={t}>turn {t} (what-if branch)</option>
          {/each}
        </select>
      </label>
      <span>
        <button data-testid="confirm-load" onclick={loadPreviewed} disabled={app.connecting}>Load as host</button>
        <button data-testid="watch-replay" title="scrub the whole game turn by turn through any player's eyes — nothing is imported or resumed" onclick={watchReplay} disabled={app.connecting}>
          🎞 Watch replay
        </button>
        <button onclick={() => (preview = null)}>Cancel</button>
      </span>
      <span title="everyone loads the SAME shared save and plays their own empire solo — onion bots stand in for the other players. Save when you're done; the reconciliation below merges everyone's files into what really happened.">
        ⏳ Async:
        <label>
          play as
          <select data-testid="async-seat" bind:value={asyncSeat}>
            {#each preview.envelope.players as p (p.player_id)}
              <option value={p.player_id}>{p.name}</option>
            {/each}
          </select>
        </label>
        <button data-testid="play-async" onclick={playAsync} disabled={app.connecting}>⏳ Play async (bots stand in)</button>
      </span>
      <p class="dim">
        Players joining the room get their old empire back by using the same name they played under
        ({preview.players.join(', ')}); in-game 🤖 controls let a bot stand in for anyone missing.
      </p>
    </div>
  {/if}
  <details class="pbmbox">
    <summary>📬 Play by mail</summary>
    <label>PBM password
      <input type="password" data-testid="pbm-password" bind:value={pbmPassword}
        placeholder={pbmLoggedIn ? 'remembered ✓' : 'shared password'} />
    </label>
    <label>Seat password
      <input type="password" data-testid="pbm-seat-password" bind:value={pbmSeatPassword} placeholder="optional" />
    </label>
    <button data-testid="pbm-enter" onclick={goPbm} disabled={app.connecting}>
      {app.connecting ? 'Connecting…' : '📬 Enter play-by-mail game'}
    </button>
    <p class="dim">
      Uses your name and room code above. One player at a time holds the room; every commit uploads
      your progress, so the game advances whenever the last player mails in their turn. To
      <b>create</b> a play-by-mail game, load a save file above first — it becomes the room's game.
      If someone is playing right now, you join their live game instead. Any downloaded 💾 save of a
      PBM game also resumes normally, so a game can move between play-by-mail and live play freely.
    </p>
  </details>
  <details class="pbmbox">
    <summary>⏳ Start async game from day one</summary>
    <p class="dim">
      No shared lobby needed: everyone copies their <b>📋 race string</b> (Lobby or Empires screen)
      and sends it to the async host. The host pastes them all below, picks the options and their
      own race, and generates the shared save — then every player loads that file and presses
      ⏳ Play async as themselves.
    </p>
    <label>Your name <input data-testid="d1-host-name" bind:value={d1HostName} placeholder={name || 'Host'} /></label>
    <label>Your race:
      <select data-testid="d1-host-preset" bind:value={d1HostPreset} disabled={!!d1HostToken.trim()}>
        {#each RACE_PRESETS as r (r.id)}<option value={r.id}>{r.name}</option>{/each}
      </select>
      or paste your own race string
      <input data-testid="d1-host-token" bind:value={d1HostToken} placeholder="moo2race1:… (optional)" />
    </label>
    {#if d1HostCheck.errors.length}<p class="warnline">⚠ you: {d1HostCheck.errors.join('; ')}</p>{/if}
    <label>Player race strings (one per line)
      <textarea data-testid="d1-guests" rows="4" bind:value={d1GuestTokens} placeholder="moo2race1:…&#10;moo2race1:…"></textarea>
    </label>
    {#each d1Guests as g, i (i)}
      <p class="dim" data-testid="d1-guest-row">
        {g.errors.length ? '⛔' : g.warnings.length ? '⚠' : '✓'} {g.summary}
        {#if g.errors.length}<span class="warnline"> — {g.errors.join('; ')}</span>{/if}
        {#if g.warnings.length}<span class="warnline"> — {g.warnings.join('; ')}</span>{/if}
      </p>
    {/each}
    <span>
      Galaxy
      <select data-testid="d1-galaxy" bind:value={d1Galaxy}>{#each ['small', 'medium', 'large', 'huge'] as g (g)}<option value={g}>{g}</option>{/each}</select>
      Start
      <select data-testid="d1-start" bind:value={d1StartMode}>
        <option value="pre_warp">pre-warp</option><option value="average">average</option><option value="advanced">advanced</option>
      </select>
      Picks
      <select data-testid="d1-picks" bind:value={d1PickPoints}>{#each [10, 12, 14, 16] as ppv (ppv)}<option value={ppv}>{ppv}</option>{/each}</select>
      🟢 Core worlds
      <select data-testid="d1-coreworlds" bind:value={d1CoreWorlds}>
        <option value="off">off</option><option value="central">central</option><option value="random">scattered</option>
      </select>
      <label><input type="checkbox" data-testid="d1-oob" bind:checked={d1OutOfBox} /> out-of-box picks</label>
    </span>
    <button
      data-testid="d1-start-btn"
      onclick={startDayOneAsync}
      disabled={d1Guests.length === 0 || d1Guests.some((g) => g.errors.length > 0) || d1HostCheck.errors.length > 0}
    >⏳ Create the shared async save</button>
    {#if d1Note}<p class="dim" data-testid="d1-note">{d1Note}</p>{/if}
  </details>
  <details class="pbmbox">
    <summary>⚖ Reconciliation (merge async saves)</summary>
    <p class="dim">
      Everyone played the same save solo (⏳ async) — load ALL the resulting save files here. Each
      empire's recorded production (tech, ships, colonies, population, buildings, garrisons, spies)
      replays on one shared timeline under board-game rules while bots fight the fleets toward the
      goal ({'{'}core worlds or domination{'}'}). Deterministic: the same files give every player the
      identical outcome. A missing player's empire fights on as a plain CPU from the shared base.
    </p>
    <button data-testid="recon-add" onclick={() => reconFileInput.click()}>＋ Add save files…</button>
    <input bind:this={reconFileInput} type="file" multiple accept=".moo2save,.json,application/octet-stream" style="display:none" data-testid="recon-files" onchange={onReconFiles} />
    {#each reconRows as r (r.seat)}
      <p class="dim" data-testid="recon-row-{r.seat}">
        📄 {r.file} — <b>{r.seatName}</b> (seat {r.seat}), turn {r.turn}
        <button onclick={() => (reconRows = reconRows.filter((x) => x.seat !== r.seat))}>✕</button>
      </p>
    {/each}
    {#each reconWarnings as w, i (i)}
      <p class="warnline" data-testid="recon-warning">⚠ {w}</p>
    {/each}
    <button data-testid="recon-run" onclick={reconcileNow} disabled={!reconRows.length || app.connecting}>⚖ Reconcile</button>
    {#if reconNote}<p class="dim" data-testid="recon-note">{reconNote}</p>{/if}
    {#if reconEnvelope}
      <span>
        <button data-testid="recon-watch" onclick={watchReconciliation}>🎬 Watch what really happened</button>
        <button data-testid="recon-download" onclick={downloadReconciliation}>💾 Download reconciliation save</button>
      </span>
    {/if}
  </details>
  {#if loadNote}<p class="dim" data-testid="load-note">{loadNote}</p>{/if}
  {#if app.error}<p class="error" data-testid="error">{app.error}</p>{/if}
</div>
<p class="labline">
  <a href="#battle-lab">⚗ Battle Lab</a> — build fleets for both sides and watch them fight (balance sandbox)
  · <button class="manualbtn" data-testid="open-manual" onclick={() => (manualOpen = true)}>📖 Manual — how every mode works</button>
</p>
{#if manualOpen}<ManualDialog onclose={() => (manualOpen = false)} />{/if}
<label class="themerow" title="cosmetic only — switch any time here or on the Empires screen; game colors (players, stars, planets) never change">
  🎨 UI theme
  <select data-testid="ui-theme" bind:value={themeId} onchange={() => applyTheme(themeId)}>
    {#each THEMES as t (t.id)}
      <option value={t.id}>{t.label}</option>
    {/each}
  </select>
  <span class="themedots">
    {#each THEMES.find((t) => t.id === themeId)?.dots ?? [] as c (c)}
      <i style="background:{c}"></i>
    {/each}
  </span>
</label>
<label class="themerow" title="a generative space score, synthesized in the browser — never on unless you turn it on">
  🎵 music
  <input type="checkbox" data-testid="music-toggle" checked={musicOn} onchange={() => (musicOn = toggleMusic())} />
</label>
</div>

<style>
  .hero {
    max-width: 30rem;
    margin: 12vh auto 0;
    padding: 1.6rem 2rem 1.8rem;
    background: linear-gradient(180deg, color-mix(in srgb, var(--panel-2) 92%, transparent), color-mix(in srgb, var(--panel) 92%, transparent));
    border: 1px solid var(--line-bright);
    border-radius: 14px;
    box-shadow: 0 8px 40px rgba(0, 0, 0, 0.5), var(--halo);
  }
  h1 {
    margin: 0;
    font-size: 2.1rem;
    text-transform: uppercase;
    letter-spacing: 0.08em;
    color: var(--accent-soft);
    text-shadow: 0 0 24px color-mix(in srgb, var(--accent) 50%, transparent);
  }
  .subtitle {
    margin: 0.1rem 0 0;
    text-transform: uppercase;
    letter-spacing: 0.3em;
    font-size: 0.78rem;
    color: var(--gold);
  }
  .tag {
    margin: 0.5rem 0 1.2rem;
    color: var(--text-dim);
  }
  .form {
    display: flex;
    flex-direction: column;
    gap: 0.6rem;
  }
  label {
    display: flex;
    justify-content: space-between;
    gap: 0.5rem;
    align-items: center;
  }
  .error {
    color: var(--bad);
  }
  .dim {
    color: var(--text-dim);
  }
  .preview {
    border: 1px solid var(--line-bright);
    border-radius: 8px;
    padding: 0.5rem 0.8rem;
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
    font-size: 0.9rem;
  }
  .warnline {
    display: block;
    color: var(--gold);
    font-size: 0.82rem;
  }
  .solorow {
    display: flex;
    gap: 0.5rem;
    align-items: center;
  }
  .pbmbox {
    border: 1px solid var(--line);
    border-radius: 8px;
    padding: 0.4rem 0.8rem;
  }
  .pbmbox summary {
    cursor: pointer;
    color: var(--accent-soft);
  }
  .pbmbox label {
    margin-top: 0.4rem;
  }
  .pbmbox button {
    margin-top: 0.5rem;
    width: 100%;
  }
  .pbmbox .dim {
    font-size: 0.8rem;
  }
  .solorow button {
    flex: 1;
  }
  .botrow {
    display: flex;
    gap: 0.35rem;
    align-items: center;
    font-size: 0.85rem;
  }
  .botrow select {
    flex: 1;
    min-width: 0;
  }
  .botlabel {
    color: var(--text-dim);
    white-space: nowrap;
  }
  .botx {
    padding: 0.1rem 0.4rem;
  }
  .botadd {
    align-self: flex-start;
    font-size: 0.8rem;
    padding: 0.15rem 0.6rem;
  }
  .labline {
    margin: 1rem 0 0;
    font-size: 0.85rem;
    color: var(--text-dim);
  }
  .themerow {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    margin-top: 0.9rem;
    font-size: 0.85rem;
    color: var(--text-dim);
  }
  .themedots {
    display: flex;
    gap: 0.25rem;
  }
  .themedots i {
    width: 0.7rem;
    height: 0.7rem;
    border-radius: 50%;
    border: 1px solid rgba(255, 255, 255, 0.3);
  }
  .labline a {
    color: var(--accent-soft);
  }
</style>
