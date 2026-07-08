<script lang="ts">
  // Phase 2 scaffolding screen: exercises the full lockstep loop (submit,
  // optimistic planned state, commit, advance, hashes, chat) over the stub
  // engine. Replaced by the real game screens in Phase 3.
  import { stubEngine } from '@protocol/engineAdapter';
  import { app, getActive } from '../state.svelte';

  let chatText = $state('');

  const session = () => getActive()!.session;
  const planned = $derived.by(() => {
    void app.version;
    return session().getPlanned();
  });
  const auth = $derived.by(() => {
    void app.version;
    return session().getState();
  });
  const committed = $derived.by(() => {
    void app.version;
    return session().getCommitted();
  });
  const roster = $derived.by(() => {
    void app.version;
    return session().getRoster();
  });
  const hash = $derived(auth ? stubEngine.hash(auth) : '');
  const iCommitted = $derived(committed.includes(session().playerId));

  function inc(n: number) {
    session().submit('increment', { n });
  }
  function toggleCommit() {
    if (iCommitted) session().uncommitTurn();
    else session().commitTurn();
  }
  function sendChat() {
    if (chatText.trim()) session().sendChat(chatText.trim());
    chatText = '';
  }
</script>

<h2>Lockstep stub game</h2>
<p>
  You are player <b data-testid="self-id">{session().playerId}</b> — turn
  <b data-testid="turn">{auth?.turn ?? 0}</b> — pending
  <span data-testid="pending">{session().getPendingCount()}</span>
</p>
<table>
  <thead><tr><th>player</th><th>counter (planned)</th><th>committed</th></tr></thead>
  <tbody>
    {#each roster as p (p.id)}
      <tr>
        <td>#{p.id} {p.name}</td>
        <td data-testid="counter-{p.id}">{planned?.counters[String(p.id)] ?? 0}</td>
        <td>{committed.includes(p.id) ? '✓' : ''}</td>
      </tr>
    {/each}
  </tbody>
</table>
<div class="row">
  <button data-testid="inc1" onclick={() => inc(1)}>+1</button>
  <button data-testid="inc5" onclick={() => inc(5)}>+5</button>
  <button data-testid="commit" onclick={toggleCommit}>{iCommitted ? 'Uncommit' : 'Commit turn'}</button>
</div>
<p>state hash: <code data-testid="state-hash">{hash}</code></p>

<div class="chat">
  <input data-testid="chat-input" bind:value={chatText} placeholder="chat…" onkeydown={(e) => e.key === 'Enter' && sendChat()} />
  <button data-testid="chat-send" onclick={sendChat}>Send</button>
  <ul data-testid="chat-log">
    {#each app.chat.slice(-5) as m (m.id)}
      <li>#{m.from}: {m.text}</li>
    {/each}
  </ul>
</div>

<style>
  table {
    border-collapse: collapse;
    margin: 0.5rem 0;
  }
  td,
  th {
    border: 1px solid #334;
    padding: 0.3rem 0.7rem;
  }
  .row {
    display: flex;
    gap: 0.5rem;
  }
  .chat {
    margin-top: 1rem;
  }
</style>
