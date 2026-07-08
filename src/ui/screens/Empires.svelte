<script lang="ts">
  import { areAtWar } from '@engine/index';
  import { playerColor } from '../colors';
  import { app, getActive } from '../state.svelte';

  const session = () => getActive()!.session;
  const gs = $derived.by(() => {
    void app.version;
    return session().getPlanned();
  });
  const selfId = $derived(session().playerId);
  const others = $derived(gs ? gs.empires.filter((e) => e.id !== selfId) : []);

  function relation(other: number): { status: string; offered: boolean; theyOffered: boolean } {
    if (!gs) return { status: 'peace', offered: false, theyOffered: false };
    const [a, b] = other < selfId ? [other, selfId] : [selfId, other];
    const rel = gs.relations.find((r) => r.a === a && r.b === b);
    return {
      status: rel?.status ?? 'peace',
      offered: rel?.peaceOfferedBy.includes(selfId) ?? false,
      theyOffered: rel?.peaceOfferedBy.includes(other) ?? false,
    };
  }

  function declareWar(target: number) {
    session().submit('declare_war', { target });
  }
  function offerPeace(target: number) {
    session().submit('offer_peace', { target });
  }
</script>

{#if gs}
  <table>
    <thead>
      <tr><th>Empire</th><th>Race</th><th>Status</th><th>Actions</th></tr>
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
          <td>
            {#if !e.eliminated}
              {#if rel.status === 'peace'}
                <button data-testid="declare-war-{e.id}" onclick={() => declareWar(e.id)}>Declare war</button>
              {:else if !rel.offered}
                <button data-testid="offer-peace-{e.id}" onclick={() => offerPeace(e.id)}>Offer peace</button>
              {/if}
            {/if}
          </td>
        </tr>
      {/each}
    </tbody>
  </table>
  {#if app.replays.length}
    <h3>Battle replays</h3>
    <ul>
      {#each app.replays as r (r.battleId)}
        <li>
          turn {r.turn}: {r.battleId} {r.watched ? '(watched)' : ''}
          <button data-testid="watch-{r.battleId}" onclick={() => (app.viewing = r)}>watch</button>
        </li>
      {/each}
    </ul>
  {/if}
{/if}

<style>
  table {
    border-collapse: collapse;
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
</style>
