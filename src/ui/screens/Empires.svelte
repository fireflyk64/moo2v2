<script lang="ts">
  import { leaderById, salaryOf, MAX_LEADERS_PER_KIND, countKind } from '@engine/leaders';
  import { selectors, HULLS_BUILDABLE, type BattleInput } from '@engine/index';
  import { weaponById } from '@engine/data/index';
  import type { ProposalKind } from '@engine/types';
  import { ownerName, playerColor } from '../colors';
  import { setLabSeed, type LabSeedGroup } from '../labSeed';
  import { app, getActive } from '../state.svelte';

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

  let note = $state('');
  function submit(kind: string, payload: unknown) {
    note = '';
    const res = session().submit(kind, payload);
    if (res.error) note = res.error;
  }

  // ---------- battle lab hand-off: my designs + designs met in battle ----------
  const SHIELD_FLAT_TIERS = [0, 1, 3, 5, 7, 10];
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
    // encountered: enemy hulls seen across the battles we hold replays for
    const seen = new Map<string, LabSeedGroup>();
    for (const r of app.replays) {
      const input = r.input as BattleInput;
      const mynSide = input.attacker === selfId ? 0 : input.defender === selfId ? 1 : -1;
      for (const s of input.ships) {
        if (s.side === mynSide || s.isBase) continue;
        if (!(HULLS_BUILDABLE as readonly string[]).includes(s.hull)) continue; // monsters stay wild
        const weapons = s.weapons
          .filter((w) => w.classId <= 2 && weaponById.has(w.weaponId))
          .map((w) => ({ weapon: w.weaponId, count: w.count, mods: [...w.mods], arc: (w.arc ?? 'F') as LabSeedGroup['weapons'][number]['arc'] }));
        const key = JSON.stringify([s.hull, weapons, s.specials ?? []]);
        const existing = seen.get(key);
        if (existing) {
          existing.count += 1;
          continue;
        }
        seen.set(key, {
          label: `encountered ${s.hull}`,
          hull: s.hull,
          computer: Math.max(0, Math.min(6, Math.round(s.beamAttack / 25))),
          shield: Math.max(0, SHIELD_FLAT_TIERS.findIndex((f) => f >= s.shieldFlat)),
          specials: [...(s.specials ?? [])],
          weapons,
          count: 1,
        });
      }
    }
    setLabSeed(mine, [...seen.values()]);
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
</script>

{#if gs && me}
  {#if note}<p class="error" data-testid="empire-note">{note}</p>{/if}

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

  <h3>Leaders ({countKind(me, 'colony')}/{MAX_LEADERS_PER_KIND} colony, {countKind(me, 'ship')}/{MAX_LEADERS_PER_KIND} ship)</h3>
  {#if myOffers.length}
    <ul data-testid="leader-offers">
      {#each myOffers as o (o.leaderId)}
        {@const row = leaderById.get(o.leaderId)}
        <li>
          <b>{row?.name}</b> {row?.title} — {row?.kind} leader,
          {row?.skills.map((s) => `${s.skill.replaceAll('_', ' ')}${s.enhanced ? '★' : ''}`).join(', ')}
          — {o.priceBc} BC (expires turn {o.expiresTurn})
          <button data-testid="hire-{o.leaderId}" onclick={() => submit('hire_leader', { leaderId: o.leaderId })}>Hire</button>
        </li>
      {/each}
    </ul>
  {/if}
  {#if me.leaders.length}
    <table data-testid="leader-roster">
      <thead><tr><th>Leader</th><th>Level</th><th>Skills</th><th>Salary</th><th>Assignment</th><th></th></tr></thead>
      <tbody>
        {#each me.leaders as l (l.leaderId)}
          {@const row = leaderById.get(l.leaderId)}
          <tr>
            <td>{row?.name} <span class="dim">{row?.title}</span></td>
            <td>{l.level} <span class="dim">({l.xp} xp)</span></td>
            <td>{row?.skills.map((s) => `${s.skill.replaceAll('_', ' ')}${s.enhanced ? '★' : ''}`).join(', ')}</td>
            <td>{row ? salaryOf(row) : 0} BC/t</td>
            <td>
              {#if row?.kind === 'colony'}
                <select
                  data-testid="assign-{l.leaderId}"
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
                fleet-wide
              {/if}
            </td>
            <td><button onclick={() => submit('dismiss_leader', { leaderId: l.leaderId })}>Dismiss</button></td>
          </tr>
        {/each}
      </tbody>
    </table>
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
        title={portalColony ? 'Send the fleet at your portal through to the Antaran home' : 'requires a dimensional portal'}
        onclick={() => portalColony && submit('attack_antarans', { colonyId: portalColony.id })}
      >⚔ Attack the Antarans</button>
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
