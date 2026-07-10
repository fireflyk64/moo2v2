<script lang="ts">
  import { app, getActive } from '../state.svelte';

  const session = () => getActive()!.session;
  const gs = $derived.by(() => {
    void app.version;
    return session().getPlanned();
  });

  let filter = $state('');
  const rows = $derived.by(() => {
    const all = [...app.reports].reverse(); // newest first
    if (!filter.trim()) return all;
    const f = filter.trim().toLowerCase();
    return all.filter((r) => r.kind.includes(f) || JSON.stringify(r.payload).toLowerCase().includes(f));
  });

  function nameOf(id: unknown): string {
    if (typeof id !== 'number') return String(id);
    if (id === -2) return 'Monsters';
    if (id === -3) return 'Andromedans';
    return gs?.empires.find((e) => e.id === id)?.name ?? `#${id}`;
  }
  function colonyOf(id: unknown): string {
    return gs?.colonies.find((c) => c.id === id)?.name ?? `colony ${id}`;
  }
  function starOf(id: unknown): string {
    return gs?.stars.find((s) => s.id === id)?.name ?? `star ${id}`;
  }

  function describe(kind: string, p: Record<string, unknown>): string {
    switch (kind) {
      case 'building_complete': return `${colonyOf(p['colonyId'])} completed ${p['item']}`;
      case 'ship_built': return `${colonyOf(p['colonyId'])} launched ${p['item']}`;
      case 'freighters_built': return `${colonyOf(p['colonyId'])} commissioned a freighter fleet`;
      case 'colony_founded': return `a new colony was founded`;
      case 'star_explored': return `a new star system was charted`;
      case 'ship_arrived': return `a fleet arrived at its destination`;
      case 'starvation': return `${colonyOf(p['colonyId'])} is starving (${p['lack']} short)`;
      case 'food_chartered': return `chartered civilian haulers moved ${p['units']} food beyond freighter capacity (−${p['bc']} BC)`;
      case 'population_lost': return `${colonyOf(p['colonyId'])} lost population`;
      case 'colony_died': return `a colony has perished`;
      case 'research_complete': {
        const granted = Array.isArray(p['granted']) ? (p['granted'] as string[]) : [];
        const what = granted.length ? granted.map((g) => String(g).replaceAll('_', ' ')).join(', ') : String(p['field'] ?? '').replaceAll('_', ' ');
        return `🎉 research breakthrough: ${what}${p['extra'] ? ' (purchased application)' : ''}`;
      }
      case 'battle_pending': return `battle brewing: ${nameOf(p['attacker'])} vs ${nameOf(p['defender'])}`;
      case 'battle_resolved': return `battle at ${starOf(p['starId'])}: winner ${p['winner'] === null ? 'none' : nameOf(p['winner'])}`;
      case 'bombardment': return `${colonyOf(p['colonyId'])} was bombarded (${p['popKilled']} pop lost)`;
      case 'colony_captured': return `${colonyOf(p['colonyId'])} captured by ${nameOf(p['to'])}`;
      case 'invasion_repelled': return `invasion repelled at ${colonyOf(p['colonyId'])}`;
      case 'assimilated': return `conquered citizens of ${colonyOf(p['colonyId'])} have settled in`;
      case 'tech_stolen': return `our spies stole ${p['app']} from ${nameOf(p['from'])}`;
      case 'tech_theft_suffered': return `enemy agents stole ${p['app']}!`;
      case 'sabotage_success': return `our agents sabotaged a ${p['building']}`;
      case 'sabotage_suffered': return `saboteurs destroyed our ${p['building']} at ${colonyOf(p['colonyId'])}`;
      case 'spy_lost': return `an agent was lost on assignment`;
      case 'spy_caught': return `we caught a spy from ${nameOf(p['from'])}`;
      case 'spy_assassinated': return `our assassin eliminated an enemy agent`;
      case 'spy_trained': return `a new agent reported for duty (${p['count']}/10)`;
      case 'leader_offer': return `${p['name']} offers their services (${p['price']} BC)`;
      case 'leader_level': return `${p['leaderId']} advanced to level ${p['level']}`;
      case 'leader_quit': return `${p['leaderId']} quit over unpaid wages`;
      case 'treaty_signed': return `treaty signed: ${p['kind']} between ${nameOf(p['a'])} and ${nameOf(p['b'])}`;
      case 'surrender': return `${nameOf(p['from'])} surrendered to ${nameOf(p['to'])}`;
      case 'council_convened': return `the Galactic Council convenes: ${(p['candidates'] as number[]).map(nameOf).join(' vs ')}`;
      case 'council_result': return `council result: ${p['winner'] === null ? 'no ruler elected' : `${nameOf(p['winner'])} elected!`}`;
      case 'terraformed': return `${colonyOf(p['colonyId'])} terraformed to ${p['climate']}`;
      case 'monster_slain': return `the ${p['kind']} at ${starOf(p['starId'])} was slain`;
      case 'guardian_defeated': return `${nameOf(p['empireId'])} defeated the Guardian of Orion!`;
      case 'antaran_raid': return `Andromedan raiders strike ${nameOf(p['empireId'])}!`;
      case 'antarans_withdraw': return `the Andromedans withdraw to their dimension`;
      case 'colony_razed': return `${colonyOf(p['colonyId'])} was razed by the Andromedans`;
      case 'cp_overage': return `fleet over command limit: -${p['bc']} BC`;
      case 'treasury_deficit': return `treasury in deficit!`;
      case 'empire_eliminated': return `${nameOf(p['empireId'])} has been eliminated`;
      case 'victory': return `VICTORY: ${nameOf(p['empireId'])} (${p['type']})`;
      case 'event_donation': return `windfall: ${nameOf(p['empireId'])} received ${p['bc']} BC`;
      case 'event_boom': return `population boom at ${colonyOf(p['colonyId'])}`;
      case 'event_minerals': return `rich veins found at ${colonyOf(p['colonyId'])} (${p['minerals']})`;
      case 'event_climate': return `climate shift blesses ${colonyOf(p['colonyId'])} (${p['climate']})`;
      case 'event_depression': return `economic depression hits ${nameOf(p['empireId'])} (-${p['bc']} BC)`;
      case 'event_pirates': return `pirates raided ${nameOf(p['empireId'])}'s freighters`;
      case 'event_meteor': return `meteor strike destroyed a ${p['building']} at ${colonyOf(p['colonyId'])}`;
      case 'event_plague': return `plague at ${colonyOf(p['colonyId'])}`;
      default: return `${kind} ${JSON.stringify(p)}`;
    }
  }
</script>

<div class="bar">
  <input data-testid="report-filter" placeholder="filter reports…" bind:value={filter} />
  <span class="dim">{app.reports.length} reports</span>
  <button onclick={() => (app.reports.length = 0)}>Clear</button>
</div>
{#if rows.length === 0}
  <p class="dim">Nothing to report yet — end a turn.</p>
{:else}
  <table data-testid="reports">
    <tbody>
      {#each rows as r, i (i)}
        <tr class:bad={['starvation', 'tech_theft_suffered', 'sabotage_suffered', 'bombardment', 'colony_razed', 'antaran_raid', 'event_plague', 'event_meteor', 'event_depression', 'event_pirates', 'treasury_deficit'].includes(r.kind)}>
          <td class="turn">t{r.turn}</td>
          <td>{describe(r.kind, r.payload)}</td>
        </tr>
      {/each}
    </tbody>
  </table>
{/if}

<style>
  .bar {
    display: flex;
    gap: 0.6rem;
    align-items: center;
    margin-bottom: 0.5rem;
  }
  table {
    border-collapse: collapse;
    width: 100%;
    max-width: 60rem;
  }
  td {
    border-bottom: 1px solid #1d2440;
    padding: 0.25rem 0.6rem;
  }
  .turn {
    opacity: 0.5;
    width: 3rem;
    font-family: monospace;
  }
  .bad td {
    color: #ff9d9d;
  }
  .dim {
    opacity: 0.6;
  }
</style>
