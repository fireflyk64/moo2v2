<script lang="ts">
  import { leaderById, salaryOf, MAX_LEADERS_PER_KIND, countKind } from '@engine/leaders';
  import { selectors, shipStyleOf, SHIP_STYLES, HULLS_BUILDABLE } from '@engine/index';
  import { PICK_ROWS, GOVERNMENTS, pickById } from '@engine/data/index';
  import type { ProposalKind } from '@engine/types';
  import { ownerName, playerColor } from '../colors';
  import ShipPreview from '../battle/ShipPreview.svelte';
  import type { ArtClass } from '../battle/shipart';
  import { battleToLabSeed, enemySeedsFromReplays, setLabSeed, type LabSeedGroup } from '../labSeed';
  import GroundBattleDialog from '../battle/GroundBattleDialog.svelte';
  import type { GroundBattleEntry } from '../state.svelte';
  import { app, getActive } from '../state.svelte';
  import { addBotForSeat, removeBotForSeat } from '../net';

  const session = () => getActive()!.session;
  const gs = $derived.by(() => {
    void app.version;
    return session().getPlanned();
  });
  const selfId = $derived(session().playerId);
  const me = $derived(gs ? gs.empires.find((e) => e.id === selfId) : undefined);
  /** race discovery: only empires you have actually met show up */
  const met = $derived.by(() => (gs ? selectors.metEmpireIds(gs, selfId) : new Set<number>()));
  const others = $derived(gs ? gs.empires.filter((e) => e.id !== selfId && met.has(e.id)) : []);
  const livingOthers = $derived(others.filter((e) => !e.eliminated));
  const unmetCount = $derived(gs ? gs.empires.filter((e) => e.id !== selfId && !met.has(e.id)).length : 0);
  const PREVIEW_CLASSES: ArtClass[] = ['scout', 'frigate', 'destroyer', 'cruiser', 'battleship', 'titan', 'doomstar', 'star_base'];
  const currentStyle = $derived(me ? shipStyleOf(me) : SHIP_STYLES[0]!.id);
  let styleSel = $state<string | null>(null);
  const shownStyle = $derived(styleSel ?? currentStyle);
  const shownStyleInfo = $derived(SHIP_STYLES.find((s) => s.id === shownStyle) ?? SHIP_STYLES[0]!);

  function cycleStyle(dir: 1 | -1) {
    const i = SHIP_STYLES.findIndex((s) => s.id === shownStyle);
    styleSel = SHIP_STYLES[(i + dir + SHIP_STYLES.length) % SHIP_STYLES.length]!.id;
  }
  function applyStyle() {
    if (shownStyle === currentStyle) return;
    const res = submit('set_ship_style', { style: shownStyle });
    if (!res.error) styleSel = null;
  }

  let note = $state('');
  let viewingGround = $state<GroundBattleEntry | null>(null);
  function submit(kind: string, payload: unknown) {
    note = '';
    const res = session().submit(kind, payload);
    if (res.error) note = res.error;
    return res;
  }

  // ---------- trait reassignment: the one-time +4-pick respec ----------
  const respecOpen = $derived(!!me && me.knownApps.includes('trait_reassignment') && !me.traitReassigned);
  let respecAdd = $state<string[]>([]);
  let respecRemove = $state<string[]>([]);
  const respecAddable = $derived(
    me
      ? PICK_ROWS.filter(
          (p) => p.cost > 0 && !(GOVERNMENTS as readonly string[]).includes(p.id) && !me.picks.includes(p.id),
        ).sort((a, b) => a.cost - b.cost || a.id.localeCompare(b.id))
      : [],
  );
  const respecRemovable = $derived(me ? me.picks.filter((id) => (pickById.get(id)?.cost ?? 0) < 0) : []);
  const respecSpent = $derived(
    respecAdd.reduce((s, id) => s + (pickById.get(id)?.cost ?? 0), 0) +
      respecRemove.reduce((s, id) => s - (pickById.get(id)?.cost ?? 0), 0),
  );
  function toggleRespec(list: 'add' | 'remove', id: string) {
    if (list === 'add') respecAdd = respecAdd.includes(id) ? respecAdd.filter((x) => x !== id) : [...respecAdd, id];
    else respecRemove = respecRemove.includes(id) ? respecRemove.filter((x) => x !== id) : [...respecRemove, id];
  }
  function applyRespec() {
    note = '';
    const res = session().submit('trait_reassignment', { add: respecAdd, remove: respecRemove });
    if (res.error) note = res.error;
    else {
      respecAdd = [];
      respecRemove = [];
    }
  }

  // ---------- battle lab hand-off: my designs + designs met in battle ----------
  function openLabWithGameShips() {
    if (!gs || !me) return;
    const mine: LabSeedGroup[] = me.designs
      .filter((d) => !d.obsolete && (HULLS_BUILDABLE as readonly string[]).includes(d.hull))
      .map((d) => ({
        label: d.name,
        hull: d.hull,
        computer: d.computer,
        shield: d.shield,
        specials: [...d.specials],
        weapons: d.weapons.map((w) => ({ weapon: w.weapon, count: w.count, mods: [...w.mods], arc: w.arc ?? 'F' })),
        count: 1,
      }));
    setLabSeed(mine, enemySeedsFromReplays(app.replays, selfId));
    location.hash = '#battle-lab';
  }

  // ---------- relations ----------
  function relation(other: number): { status: string; offered: boolean; theyOffered: boolean; treaties: string } {
    if (!gs) return { status: 'peace', offered: false, theyOffered: false, treaties: '' };
    const [a, b] = other < selfId ? [other, selfId] : [selfId, other];
    const rel = gs.relations.find((r) => r.a === a && r.b === b);
    const t: string[] = [];
    if (rel?.treaties.nap) t.push('non-aggression');
    if (rel?.treaties.alliance) t.push('alliance');
    if (rel?.treaties.trade) t.push('trade');
    if (rel?.treaties.research) t.push('research');
    return {
      status: rel?.status ?? 'peace',
      offered: rel?.peaceOfferedBy.includes(selfId) ?? false,
      theyOffered: rel?.peaceOfferedBy.includes(other) ?? false,
      treaties: t.join(', '),
    };
  }

  // ---------- proposals ----------
  let proposalTo = $state(-1);
  let proposalKind = $state<ProposalKind>('trade');
  let giftBc = $state(100);
  let giveApp = $state('');
  let wantApp = $state('');
  const PROPOSALS: Array<{ kind: ProposalKind; label: string }> = [
    { kind: 'peace', label: 'Peace' },
    { kind: 'non_aggression', label: 'Non-aggression pact' },
    { kind: 'alliance', label: 'Alliance' },
    { kind: 'trade', label: 'Trade treaty' },
    { kind: 'research', label: 'Research treaty' },
    { kind: 'gift_bc', label: 'Gift (BC)' },
    { kind: 'tech_exchange', label: 'Technology exchange' },
    { kind: 'surrender', label: 'Surrender to them' },
  ];
  const partner = $derived(gs && proposalTo >= 0 ? gs.empires.find((e) => e.id === proposalTo) : undefined);
  const incoming = $derived(gs ? gs.proposals.filter((p) => p.to === selfId) : []);
  const outgoing = $derived(gs ? gs.proposals.filter((p) => p.from === selfId) : []);

  function sendProposal() {
    const payload: Record<string, unknown> = { to: proposalTo, kind: proposalKind };
    if (proposalKind === 'gift_bc') payload['giveBc'] = giftBc;
    if (proposalKind === 'tech_exchange') {
      payload['giveApp'] = giveApp;
      payload['wantApp'] = wantApp;
    }
    submit('diplo_propose', payload);
  }
  function nameOf(id: number): string {
    return gs?.empires.find((e) => e.id === id)?.name ?? `#${id}`;
  }
  function describeProposal(p: (typeof incoming)[number]): string {
    const label = PROPOSALS.find((x) => x.kind === p.kind)?.label ?? p.kind;
    if (p.kind === 'gift_bc') return `${label}: ${p.giveBc} BC`;
    if (p.kind === 'tech_exchange') return `${label}: their ${p.giveApp} for your ${p.wantApp}`;
    return label;
  }

  // ---------- council ----------
  const council = $derived(gs?.council.pending ?? null);
  const myVote = $derived(council ? council.votes[String(selfId)] : undefined);

  // ---------- leaders ----------
  const myOffers = $derived.by(() => {
    if (!gs) return [];
    return gs.leaderOffers.filter((o) => o.empireId === selfId && o.expiresTurn > gs.turn);
  });
  const myColonies = $derived(gs ? gs.colonies.filter((c) => c.owner === selfId && !c.outpost) : []);

  // ---------- spies ----------
  let spyTarget = $state<number | null>(null);
  let spyMode = $state<'steal' | 'sabotage'>('steal');

  // ---------- antarans ----------
  const portalColony = $derived(myColonies.find((c) => c.buildings.includes('dimensional_portal')));

  // ---------- seat issues (moved off the main screen; bugs.md) ----------
  const roster = $derived.by(() => {
    void app.version;
    return getActive()?.session.getRoster() ?? [];
  });
  const botOnSeat = (seatId: number) => getActive()?.bots.find((b) => b.seatId === seatId) ?? null;
  const seatIssues = $derived.by(() => {
    void app.version;
    if (!getActive()?.host) return [];
    return roster
      .map((p) => ({ p, bot: botOnSeat(p.id) }))
      .filter(({ p, bot }) => p.id !== selfId && (!p.connected || bot));
  });

  // ---------- leader card portraits (deterministic per leader) ----------
  const COLONY_FACES = ['🧑‍🔬', '👩‍💼', '🧕', '👨‍🌾', '🧙', '👳', '👩‍⚖️', '🤴'];
  const SHIP_FACES = ['🧑‍✈️', '👨‍🚀', '👩‍✈️', '🫡', '🦾', '🏴‍☠️', '👽', '🤖'];
  function portraitOf(leaderId: string, kind: string | undefined): string {
    let h = 0;
    for (let i = 0; i < leaderId.length; i++) h = (h * 31 + leaderId.charCodeAt(i)) >>> 0;
    const faces = kind === 'ship' ? SHIP_FACES : COLONY_FACES;
    return faces[h % faces.length]!;
  }
</script>

{#if gs && me}
  {#if note}<p class="error" data-testid="empire-note">{note}</p>{/if}

  {#each seatIssues as { p, bot } (p.id)}
    <div class="banner" class:warn={!bot} class:dim={!!bot} data-testid="seat-issue-{p.id}">
      {#if bot}
        <!-- "The bot is playing Bot" read like a stutter when the seat itself
             is the built-in bot — name the empire only when it adds anything -->
        🤖 A bot runs seat #{p.id}{p.name && p.name.toLowerCase() !== 'bot' ? ' for ' : ''}{#if p.name && p.name.toLowerCase() !== 'bot'}<b>{p.name}</b>{/if}.
        <button data-testid="bot-release-{p.id}" title="retire the bot; the player gets the empire back by rejoining with their name"
          onclick={() => bot && removeBotForSeat(getActive()!, bot)}>✕ hand the seat back</button>
      {:else}
        ⏳ <b>{p.name}</b> (seat #{p.id}) is not connected — the game waits for their commit.
        <button data-testid="bot-sub-{p.id}" title="a fair (non-cheating) bot plays their empire until they rejoin with the same name"
          onclick={() => addBotForSeat(getActive()!, p.name)}>🤖 let the bot play {p.name}</button>
      {/if}
    </div>
  {/each}

  <!-- your own race's traits, shown for PRESET races too (bugs.md) -->
  <h3>Your race — {me.raceName}</h3>
  <p class="pickrow" data-testid="my-race-picks">
    {#each me.picks as p (p)}
      {@const row = pickById.get(p)}
      <span
        class="pickchip"
        class:flaw={(row?.cost ?? 0) < 0}
        class:gov={(GOVERNMENTS as readonly string[]).includes(p)}
        title={row?.meaning ?? p}
      >{p.replaceAll('_', ' ')}{row && row.cost !== 0 ? ` (${row.cost > 0 ? '+' : ''}${row.cost})` : ''}</span>
    {/each}
    {#if me.picks.length === 0}<span class="dim">no racial modifiers</span>{/if}
  </p>

  <div class="appearance" data-testid="fleet-style-panel">
    <div class="stylebar">
      <h3>Fleet look</h3>
      <button class="mini" data-testid="style-prev" onclick={() => cycleStyle(-1)} title="previous style">◀</button>
      <b class="stylename">{shownStyleInfo.name}</b>
      <button class="mini" data-testid="style-next" onclick={() => cycleStyle(1)} title="next style">▶</button>
      <span class="dim">{shownStyleInfo.blurb}</span>
      {#if shownStyle !== currentStyle}
        <button data-testid="style-apply" onclick={applyStyle}>Adopt this style</button>
      {:else}
        <span class="current">current fleet style</span>
      {/if}
    </div>
    <div class="stylestrip">
      {#each PREVIEW_CLASSES as pc (pc)}
        <span class="cell">
          <ShipPreview style={shownStyle} cls={pc} variant={0} color={playerColor(selfId)} px={2} title={pc.replaceAll('_', ' ')} />
          <small>{pc === 'star_base' ? 'base' : pc}</small>
        </span>
      {/each}
    </div>
    <p class="dim finePrint">Cosmetic only. This changes how your fleets look in battles and replays.</p>
  </div>

  <h3>Relations</h3>
  {#if unmetCount > 0}
    <p class="dim" data-testid="unmet">🔭 {unmetCount} empire{unmetCount > 1 ? 's' : ''} not yet encountered — explore toward their stars to make contact.</p>
  {/if}
  {#if others.length === 0}
    <p class="dim">No known empires yet.</p>
  {/if}
  <table>
    <thead>
      <tr><th>Empire</th><th>Race</th><th>Status</th><th>Treaties</th><th>Actions</th></tr>
    </thead>
    <tbody>
      {#each others as e (e.id)}
        {@const rel = relation(e.id)}
        <tr data-testid="empire-{e.id}">
          <td><span class="chip" style="background:{playerColor(e.id)}"></span> {e.name}</td>
          <td>{e.raceName}{e.eliminated ? ' (eliminated)' : ''}</td>
          <td data-testid="relation-{e.id}">
            {rel.status}
            {rel.offered ? ' (peace offered)' : ''}
            {rel.theyOffered ? ' (they seek peace)' : ''}
          </td>
          <td>{rel.treaties}</td>
          <td>
            {#if !e.eliminated}
              {#if rel.status === 'peace'}
                <button data-testid="declare-war-{e.id}" onclick={() => submit('declare_war', { target: e.id })}>Declare war</button>
              {:else if !rel.offered}
                <button data-testid="offer-peace-{e.id}" onclick={() => submit('offer_peace', { target: e.id })}>Offer peace</button>
              {/if}
            {/if}
          </td>
        </tr>
      {/each}
    </tbody>
  </table>

  <h3>Diplomacy</h3>
  {#if incoming.length}
    <ul data-testid="incoming-proposals">
      {#each incoming as p (p.id)}
        <li>
          {nameOf(p.from)} proposes: {describeProposal(p)} (expires turn {p.expiresTurn})
          <button data-testid="accept-{p.id}" onclick={() => submit('diplo_respond', { proposalId: p.id, accept: true })}>Accept</button>
          <button data-testid="reject-{p.id}" onclick={() => submit('diplo_respond', { proposalId: p.id, accept: false })}>Reject</button>
        </li>
      {/each}
    </ul>
  {/if}
  {#if livingOthers.length}
    <div class="compose">
      <select data-testid="proposal-to" bind:value={proposalTo}>
        <option value={-1}>choose empire…</option>
        {#each livingOthers as e (e.id)}<option value={e.id}>{e.name}</option>{/each}
      </select>
      <select data-testid="proposal-kind" bind:value={proposalKind}>
        {#each PROPOSALS as p (p.kind)}<option value={p.kind}>{p.label}</option>{/each}
      </select>
      {#if proposalKind === 'gift_bc'}
        <input type="number" min="1" bind:value={giftBc} style="width:6rem" />
      {/if}
      {#if proposalKind === 'tech_exchange' && partner}
        <select bind:value={giveApp}>
          <option value="">give…</option>
          {#each me.knownApps.filter((a) => !partner.knownApps.includes(a)) as a (a)}<option value={a}>{a}</option>{/each}
        </select>
        <select bind:value={wantApp}>
          <option value="">want…</option>
          {#each partner.knownApps.filter((a) => !me.knownApps.includes(a)) as a (a)}<option value={a}>{a}</option>{/each}
        </select>
      {/if}
      <button data-testid="send-proposal" disabled={proposalTo < 0} onclick={sendProposal}>Propose</button>
    </div>
  {/if}
  {#if outgoing.length}
    <p class="dim">outstanding: {outgoing.map((p) => `${describeProposal(p)} → ${nameOf(p.to)}`).join('; ')}</p>
  {/if}

  {#if council}
    <h3>Galactic Council</h3>
    <p data-testid="council">
      The council convenes! Candidates: {council.candidates.map(nameOf).join(' and ')}.
      {myVote !== undefined ? `You voted: ${myVote === -1 ? 'abstain' : nameOf(myVote)}` : ''}
    </p>
    {#each council.candidates as c (c)}
      <button data-testid="vote-{c}" onclick={() => submit('cast_vote', { candidate: c })}>Vote {nameOf(c)}</button>
    {/each}
    <button data-testid="vote-abstain" onclick={() => submit('cast_vote', { candidate: -1 })}>Abstain</button>
  {/if}

  {#if respecOpen}
    <fieldset class="respec" data-testid="trait-reassignment">
      <legend>🧬 Trait Reassignment — spend up to 4 pick points (once per game)</legend>
      <div class="respec-cols">
        <div class="respec-col">
          <b>Add advantages</b>
          {#each respecAddable as p (p.id)}
            <label title={p.meaning}>
              <input type="checkbox" data-testid="respec-add-{p.id}" checked={respecAdd.includes(p.id)} onchange={() => toggleRespec('add', p.id)} />
              {p.id} (+{p.cost})
            </label>
          {/each}
        </div>
        <div class="respec-col">
          <b>Remove disadvantages</b>
          {#if respecRemovable.length === 0}<span class="dim">none — your race has no flaws to shed</span>{/if}
          {#each respecRemovable as id (id)}
            <label>
              <input type="checkbox" data-testid="respec-remove-{id}" checked={respecRemove.includes(id)} onchange={() => toggleRespec('remove', id)} />
              {id} ({pickById.get(id)?.cost})
            </label>
          {/each}
        </div>
      </div>
      <p class:bad={respecSpent > 4}>
        spending {respecSpent}/4 points
        <button data-testid="respec-apply" disabled={respecSpent === 0 || respecSpent > 4} onclick={applyRespec}>Apply</button>
      </p>
    </fieldset>
  {/if}

  {#if gs.empires.some((emp) => emp.telemetry && Object.keys(emp.telemetry).length)}
    <details class="timespent">
      <summary>⏱ Time spent per screen (all empires)</summary>
      <table>
        <thead><tr><th>empire</th><th>screen</th><th>time</th><th>visits</th><th>avg</th></tr></thead>
        <tbody>
          {#each gs.empires.filter((emp) => emp.telemetry) as emp (emp.id)}
            {#each Object.entries(emp.telemetry ?? {})
              .filter(([k]) => !k.startsWith('visits:'))
              .sort((a, b) => b[1] - a[1]) as [screen, secs] (screen)}
              {@const v = emp.telemetry?.[`visits:${screen}`] ?? 0}
              <tr>
                <td>{emp.raceName}</td>
                <td>{screen}</td>
                <td>{Math.floor(secs / 60)}m {secs % 60}s</td>
                <td>{v > 0 ? v : '—'}</td>
                <td>{v > 0 ? `${Math.round(secs / v)}s` : '—'}</td>
              </tr>
            {/each}
          {/each}
        </tbody>
      </table>
    </details>
  {/if}

  <h3>Leaders ({countKind(me, 'colony')}/{MAX_LEADERS_PER_KIND} colony, {countKind(me, 'ship')}/{MAX_LEADERS_PER_KIND} ship)</h3>
  {#if myOffers.length}
    <div class="cards" data-testid="leader-offers">
      {#each myOffers as o (o.leaderId)}
        {@const row = leaderById.get(o.leaderId)}
        {@const turnsLeft = o.expiresTurn - gs.turn}
        <div class="leadercard offer" class:ship={row?.kind === 'ship'}>
          <div class="portrait">{portraitOf(o.leaderId, row?.kind)}</div>
          <div class="who">
            <b>{row?.name}</b>
            <span class="title">{row?.title}</span>
            <span class="kind" title={row?.kind === 'ship' ? 'bonuses apply to the whole fleet' : 'system administrator: colony bonuses apply to every colony in the assigned star system'}>{row?.kind === 'ship' ? '🚀 ship officer' : '🏛 colony leader'}</span>
          </div>
          <div class="skills">
            {#each row?.skills ?? [] as s (s.skill)}
              <span class="skill" class:enh={s.enhanced}>{s.skill.replaceAll('_', ' ')}{s.enhanced ? ' ★' : ''}</span>
            {/each}
          </div>
          <div class="foot">
            <span class="price">{o.priceBc} BC</span>
            <span class="dim" title="the offer expires turn {o.expiresTurn}">⏳ {turnsLeft} turn{turnsLeft === 1 ? '' : 's'}</span>
            <button data-testid="hire-{o.leaderId}" onclick={() => submit('hire_leader', { leaderId: o.leaderId })}>Hire</button>
          </div>
        </div>
      {/each}
    </div>
  {/if}
  {#if me.leaders.length}
    <div class="cards" data-testid="leader-roster">
      {#each me.leaders as l (l.leaderId)}
        {@const row = leaderById.get(l.leaderId)}
        <div class="leadercard" class:ship={row?.kind === 'ship'}>
          <div class="portrait">{portraitOf(l.leaderId, row?.kind)}</div>
          <div class="who">
            <b>{row?.name}</b>
            <span class="title">{row?.title}</span>
            <span class="kind" title={row?.kind === 'ship' ? 'bonuses apply to the whole fleet' : 'system administrator: colony bonuses apply to every colony in the assigned star system'}>{row?.kind === 'ship' ? '🚀 ship officer' : '🏛 colony leader'}</span>
          </div>
          <div class="levelrow" title="{l.xp} xp">
            <span>lvl {l.level}</span>
            <span class="xpbar"><span class="xpfill" style="width:{Math.min(100, l.xp % 100)}%"></span></span>
            <span class="dim">{row ? salaryOf(row) : 0} BC/t</span>
          </div>
          <div class="skills">
            {#each row?.skills ?? [] as s (s.skill)}
              <span class="skill" class:enh={s.enhanced}>{s.skill.replaceAll('_', ' ')}{s.enhanced ? ' ★' : ''}</span>
            {/each}
          </div>
          <div class="foot">
            {#if row?.kind === 'colony'}
              <select
                data-testid="assign-{l.leaderId}"
                title="seat of office — bonuses cover every colony in that star system"
                value={l.colonyId ?? -1}
                onchange={(e) => {
                  const v = Number((e.target as HTMLSelectElement).value);
                  submit('assign_leader', { leaderId: l.leaderId, colonyId: v < 0 ? null : v });
                }}
              >
                <option value={-1}>unassigned</option>
                {#each myColonies as c (c.id)}<option value={c.id}>{c.name}</option>{/each}
              </select>
            {:else}
              <span class="dim">fleet-wide</span>
            {/if}
            <button class="dismiss" onclick={() => submit('dismiss_leader', { leaderId: l.leaderId })}>Dismiss</button>
          </div>
        </div>
      {/each}
    </div>
  {:else}
    <p class="dim">No leaders in your employ. Offers arrive from time to time — Famous and charismatic help.</p>
  {/if}

  <h3>Agents ({me.spies.count}/10)</h3>
  <div class="compose">
    <select data-testid="spy-target" bind:value={spyTarget}>
      <option value={null}>all defensive</option>
      {#each livingOthers as e (e.id)}<option value={e.id}>vs {e.name}</option>{/each}
    </select>
    <select data-testid="spy-mode" bind:value={spyMode}>
      <option value="steal">steal technology</option>
      <option value="sabotage">sabotage</option>
    </select>
    <button data-testid="spy-apply" onclick={() => submit('set_spy_orders', { target: spyTarget, mode: spyMode })}>Set orders</button>
    <span class="dim">
      current: {me.spies.target === null ? 'defensive' : `${me.spies.mode} vs ${nameOf(me.spies.target)}`}
      — train more agents from the colony build list
    </span>
  </div>

  <h3>Battle simulator</h3>
  <p>
    <button data-testid="lab-from-game" onclick={openLabWithGameShips}
      title="open the Battle Lab pre-loaded with your ship designs and every enemy design you have met in battle">
      ⚗ Simulate with this game's ships
    </button>
    <span class="dim">your designs vs the enemy types you have encountered — sandbox only, the real game is untouched</span>
  </p>

  {#if app.groundBattles.length}
    <h3>Ground assaults</h3>
    <ul>
      {#each app.groundBattles as gb, gi (gi)}
        <li>
          Turn {gb.turn} — {gb.payload.captured ? '🏳' : '🛡'} {gb.payload.colonyName}:
          {gb.payload.startTroops} troops vs {gb.payload.startMilitia} militia
          <button data-testid="ground-watch-{gi}" onclick={() => (viewingGround = gb)}>▶ watch</button>
        </li>
      {/each}
    </ul>
  {/if}
  {#if viewingGround}
    <GroundBattleDialog battle={viewingGround} onclose={() => (viewingGround = null)} />
  {/if}

  {#if app.replays.length}
    <h3>Battle replays</h3>
    <ul>
      {#each app.replays as r (r.battleId)}
        {@const s = r.summary as Record<string, unknown>}
        {@const starName = gs.stars.find((x) => x.id === s['starId'])?.name ?? `star ${s['starId']}`}
        <li>
          <b>Turn {r.turn}</b> — battle at {starName}:
          {ownerName(Number(s['attacker']), (x) => gs.empires.find((e) => e.id === x)?.name)} vs
          {ownerName(Number(s['defender']), (x) => gs.empires.find((e) => e.id === x)?.name)}
          {r.watched ? ' (watched)' : ''}
          <button data-testid="watch-{r.battleId}" onclick={() => (app.viewing = r)}>▶ watch</button>
          <button
            data-testid="simulate-{r.battleId}"
            title="open the battle simulator preloaded with this exact battle — both fleets, both sides' orders"
            onclick={() => {
              const s = battleToLabSeed(r.input as never);
              setLabSeed(s.a, s.d, s);
              location.hash = '#battle-lab';
            }}
          >⚗ simulate</button>
        </li>
      {/each}
    </ul>
  {/if}

  <h3>Danger zone</h3>
  <div class="compose">
    {#if gs.settings.modes.antarans}
      <button
        data-testid="attack-antarans"
        disabled={!portalColony || gs.antarans.assaultBy !== null}
        title={portalColony ? 'Send the fleet at your portal through to the Andromedan home' : 'requires a dimensional portal'}
        onclick={() => portalColony && submit('attack_antarans', { colonyId: portalColony.id })}
      >⚔ Attack the Andromedans</button>
    {/if}
    <button
      data-testid="resign"
      onclick={() => {
        if (confirm('Concede the game? Your empire dissolves permanently.')) submit('resign', {});
      }}
    >🏳 Resign</button>
  </div>
{/if}

<style>
  .appearance {
    border: 1px solid #26304f;
    border-radius: 10px;
    padding: 0.5rem 0.9rem 0.35rem;
    margin-bottom: 1rem;
    background: linear-gradient(180deg, rgba(15, 21, 48, 0.65), rgba(10, 14, 34, 0.65));
    max-width: 64rem;
  }
  .stylebar {
    display: flex;
    align-items: center;
    gap: 0.55rem;
    flex-wrap: wrap;
  }
  .stylebar h3 {
    margin: 0;
  }
  .stylename {
    min-width: 6rem;
    text-align: center;
    color: var(--accent-soft);
  }
  .current {
    color: var(--good, #5ee08a);
    font-size: 0.85rem;
  }
  .stylestrip {
    display: flex;
    gap: 0.95rem;
    align-items: center;
    flex-wrap: wrap;
    margin-top: 0.45rem;
  }
  .stylestrip .cell {
    display: inline-flex;
    flex-direction: column;
    align-items: center;
    gap: 0.12rem;
  }
  .stylestrip small {
    color: var(--text-dim);
    font-size: 0.68rem;
  }
  .mini {
    padding: 0.1rem 0.45rem;
  }
  .finePrint {
    margin: 0.2rem 0 0;
    font-size: 0.78rem;
  }
  .pickrow {
    display: flex;
    flex-wrap: wrap;
    gap: 0.35rem;
    max-width: 60rem;
  }
  .pickchip {
    border: 1px solid #3a4a80;
    background: #1a2140;
    border-radius: 999px;
    padding: 0.1rem 0.6rem;
    font-size: 0.82rem;
    cursor: default;
  }
  .pickchip.gov {
    border-color: var(--gold, #d8b653);
    background: #2c2612;
  }
  .pickchip.flaw {
    border-color: #7a3a3a;
    background: #2c1616;
    color: #e0a9a2;
  }
  /* seat-issue banners (moved here from the main shell; bugs.md) */
  .banner {
    border: 1px solid #3a4a80;
    border-radius: 8px;
    background: #141830;
    padding: 0.4rem 0.8rem;
    margin-bottom: 0.5rem;
    max-width: 60rem;
  }
  .banner.warn {
    border-color: var(--gold, #d8b653);
    background: #2c2612;
    color: #ffe9b0;
  }
  .banner.dim {
    opacity: 0.85;
  }
  /* ---- leader cards (bugs.md: "Leaders to look like cards") ---- */
  .cards {
    display: flex;
    flex-wrap: wrap;
    gap: 0.7rem;
    margin-bottom: 0.8rem;
  }
  .leadercard {
    width: 15.5rem;
    border: 1px solid #3a4a80;
    border-radius: 10px;
    background: linear-gradient(180deg, #182046, #10142c);
    padding: 0.6rem 0.7rem;
    display: flex;
    flex-direction: column;
    gap: 0.4rem;
    box-shadow: 0 4px 14px rgba(0, 0, 0, 0.35);
  }
  .leadercard.ship {
    border-color: #806a3a;
    background: linear-gradient(180deg, #2a2246, #140f2c);
  }
  .leadercard.offer {
    border-style: dashed;
  }
  .leadercard .portrait {
    font-size: 2.2rem;
    line-height: 1;
    width: 3.2rem;
    height: 3.2rem;
    display: flex;
    align-items: center;
    justify-content: center;
    border-radius: 50%;
    background: radial-gradient(circle at 35% 30%, #31407c, #10142c 75%);
    border: 1px solid #4a5a90;
    align-self: center;
  }
  .leadercard.ship .portrait {
    background: radial-gradient(circle at 35% 30%, #6a5424, #140f2c 75%);
    border-color: #806a3a;
  }
  .leadercard .who {
    display: flex;
    flex-direction: column;
    align-items: center;
    text-align: center;
  }
  .leadercard .who .title {
    font-size: 0.8rem;
    opacity: 0.75;
    font-style: italic;
  }
  .leadercard .who .kind {
    font-size: 0.75rem;
    opacity: 0.6;
  }
  .leadercard .levelrow {
    display: flex;
    align-items: center;
    gap: 0.4rem;
    font-size: 0.82rem;
  }
  .leadercard .xpbar {
    flex: 1;
    height: 0.35rem;
    border-radius: 999px;
    background: #0a0e22;
    border: 1px solid #26304f;
    overflow: hidden;
  }
  .leadercard .xpfill {
    display: block;
    height: 100%;
    background: linear-gradient(90deg, #4da3ff, #5ee6e0);
  }
  .leadercard .skills {
    display: flex;
    flex-wrap: wrap;
    gap: 0.25rem;
    justify-content: center;
  }
  .leadercard .skill {
    border: 1px solid #26304f;
    background: #0e1330;
    border-radius: 999px;
    padding: 0.05rem 0.5rem;
    font-size: 0.75rem;
  }
  .leadercard .skill.enh {
    border-color: var(--gold, #d8b653);
    color: #ffe9b0;
  }
  .leadercard .foot {
    margin-top: auto;
    display: flex;
    align-items: center;
    gap: 0.4rem;
    justify-content: space-between;
  }
  .leadercard .price {
    font-weight: 700;
    color: #ffe9b0;
  }
  .leadercard .dismiss {
    opacity: 0.75;
  }
  table {
    border-collapse: collapse;
    margin-bottom: 0.6rem;
  }
  td,
  th {
    border: 1px solid #26304f;
    padding: 0.3rem 0.7rem;
    text-align: left;
  }
  .chip {
    display: inline-block;
    width: 0.7rem;
    height: 0.7rem;
    border-radius: 50%;
    margin-right: 0.3rem;
  }
  .compose {
    display: flex;
    gap: 0.5rem;
    align-items: center;
    flex-wrap: wrap;
    margin-bottom: 0.5rem;
  }
  .timespent {
    margin: 0.6rem 0;
    font-size: 0.85rem;
  }
  .timespent table {
    border-collapse: collapse;
  }
  .timespent td,
  .timespent th {
    border: 1px solid var(--line);
    padding: 0.15rem 0.5rem;
  }
  .respec {
    border: 1px solid var(--line);
    border-radius: 8px;
    margin: 0.6rem 0;
    max-width: 60rem;
  }
  .respec-cols {
    display: flex;
    gap: 2rem;
  }
  .respec-col {
    display: flex;
    flex-direction: column;
    gap: 0.1rem;
    font-size: 0.82rem;
    max-height: 14rem;
    overflow-y: auto;
    flex-wrap: wrap;
    column-gap: 1.2rem;
  }
  .bad {
    color: var(--bad);
  }
  .dim {
    opacity: 0.6;
    font-size: 0.85rem;
  }
  .error {
    color: #ff7b7b;
  }
  h3 {
    margin: 1rem 0 0.4rem;
  }
</style>
