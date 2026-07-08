<script lang="ts">
  // Pre-battle orders: the only input combat takes. The pass itself is an
  // automatic cinematic once both sides have ordered (or the timeout fires).
  import type { PendingBattle } from '@engine/types';
  import { app, getActive } from '../state.svelte';

  const { battle }: { battle: PendingBattle } = $props();

  const session = () => getActive()!.session;
  const isAttacker = $derived(battle.attacker === session().playerId);
  const alreadyOrdered = $derived.by(() => {
    void app.version;
    const b = session().getState()?.pendingBattles.find((x) => x.id === battle.id);
    return b ? (isAttacker ? b.ordersA !== null : b.ordersD !== null) : false;
  });

  let stance = $state(isAttacker ? 'charge' : 'hold_range');
  let priority = $state('nearest');
  let retreatThresholdPct = $state(25);
  let bombard = $state(false);

  const roster = $derived.by(() => {
    void app.version;
    return session().getRoster();
  });
  const nameOf = (id: number) => roster.find((p) => p.id === id)?.name ?? `#${id}`;
  const starName = $derived.by(() => {
    const gs = session().getState();
    return gs?.stars.find((s) => s.id === battle.starId)?.name ?? '?';
  });
  const fleetCounts = $derived.by(() => {
    const gs = session().getState();
    if (!gs) return { mine: 0, theirs: 0 };
    const count = (owner: number) =>
      gs.ships.filter(
        (s) => s.owner === owner && s.shipKind === 'design' && s.location.kind === 'star' && s.location.starId === battle.starId,
      ).length;
    return isAttacker
      ? { mine: count(battle.attacker), theirs: count(battle.defender) }
      : { mine: count(battle.defender), theirs: count(battle.attacker) };
  });

  function submit() {
    session().submit('battle_orders', {
      battleId: battle.id,
      orders: {
        stance,
        priority,
        retreatThresholdPct,
        bombard: isAttacker ? bombard : false,
      },
    });
  }
</script>

<div class="overlay">
  <div class="dialog" data-testid="battle-dialog">
    <h3>Battle at {starName}</h3>
    <p>
      {nameOf(battle.attacker)} attacks {nameOf(battle.defender)} — you are the
      <b>{isAttacker ? 'attacker' : 'defender'}</b> ({fleetCounts.mine} warships vs {fleetCounts.theirs}).
    </p>
    {#if alreadyOrdered}
      <p data-testid="battle-waiting">Orders locked. Waiting for the enemy…</p>
    {:else}
      <div class="grid">
        <label>Stance
          <select data-testid="battle-stance" bind:value={stance}>
            <option value="charge">Charge — close to point-blank</option>
            <option value="hold_range">Hold range — fight at medium band</option>
            <option value="standoff">Standoff — stay at long range</option>
            <option value="evade_retreat">Evade & retreat</option>
          </select>
        </label>
        <label>Target priority
          <select bind:value={priority}>
            <option value="nearest">Nearest</option>
            <option value="biggest">Biggest hulls</option>
            <option value="smallest">Smallest hulls</option>
            <option value="warships">Warships first</option>
            <option value="bases">Bases first</option>
          </select>
        </label>
        <label>Retreat below {retreatThresholdPct}% fleet HP
          <input type="range" min="0" max="90" step="5" bind:value={retreatThresholdPct} />
        </label>
        {#if isAttacker}
          <label class="row">
            <input type="checkbox" bind:checked={bombard} />
            Bombard the colony if the pass is won
          </label>
        {/if}
      </div>
      <button data-testid="battle-submit" onclick={submit}>Lock in orders</button>
    {/if}
  </div>
</div>

<style>
  .overlay {
    position: fixed;
    inset: 0;
    background: rgba(4, 6, 14, 0.8);
    display: flex;
    align-items: center;
    justify-content: center;
    z-index: 40;
  }
  .dialog {
    background: #141830;
    border: 1px solid #3a4a80;
    border-radius: 10px;
    padding: 1.2rem 1.5rem;
    max-width: 30rem;
  }
  .grid {
    display: flex;
    flex-direction: column;
    gap: 0.7rem;
    margin: 0.8rem 0;
  }
  label {
    display: flex;
    flex-direction: column;
    gap: 0.25rem;
  }
  label.row {
    flex-direction: row;
    align-items: center;
    gap: 0.5rem;
  }
</style>
