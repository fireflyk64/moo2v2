<script lang="ts">
  // Pre-battle orders: the only input combat takes. The pass itself is an
  // automatic cinematic once both sides have ordered (or the timeout fires).
  import type { PendingBattle } from '@engine/types';
  import { fleetBombardDamage, planetShieldBlock } from '@engine/battles';
  import { colonyPopUnits, marinesOf, shipMarines } from '@engine/economy';
  import { ownerName } from '../colors';
  import { app, getActive } from '../state.svelte';

  const { battle }: { battle: PendingBattle } = $props();

  const session = () => getActive()!.session;
  const isAttacker = $derived(battle.attacker === session().playerId);
  const alreadyOrdered = $derived.by(() => {
    void app.version;
    const b = session().getState()?.pendingBattles.find((x) => x.id === battle.id);
    return b ? (isAttacker ? b.ordersA !== null : b.ordersD !== null) : false;
  });

  let stance = $state('charge'); // charge is the default for BOTH sides (bugs.md)
  let priority = $state('nearest');
  let retreatThresholdPct = $state(25);
  let bombard = $state(false);
  let invade = $state(false);
  let spareNoncombatants = $state(false);

  const STANCES = ['charge', 'hold_range', 'standoff', 'formation', 'passthrough', 'evade_retreat'];
  const PRIORITIES = ['nearest', 'biggest', 'smallest', 'warships', 'bases', 'deadliest'];

  // the host resolves with default orders when this clock runs out — in
  // realtime games it is the SAME length as the turn timer (see HostCore),
  // so battles never stall the cadence. The countdown is client-estimated
  // from when the dialog opened; the host armed its timer moments earlier.
  const timeoutMs = (() => {
    const st = session().getSettings();
    const rt = st?.realtimeTurnSeconds ?? 0;
    return rt > 0 ? rt * 1000 : st?.battleOrdersTimeoutMs || 60_000;
  })();
  const deadline = Date.now() + timeoutMs;
  let nowTick = $state(Date.now());
  $effect(() => {
    const iv = setInterval(() => (nowTick = Date.now()), 1000);
    return () => clearInterval(iv);
  });
  const secondsLeft = $derived(Math.max(0, Math.ceil((deadline - nowTick) / 1000)));

  // keyboard flow: pick everything without touching the mouse
  function onKey(e: KeyboardEvent) {
    if (alreadyOrdered) return;
    const t = e.target as HTMLElement | null;
    const typing = !!t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable);
    if (typing || e.metaKey || e.ctrlKey || e.altKey) return;
    const key = e.key.toLowerCase();
    const cycle = (list: string[], cur: string, dir: number) =>
      list[(list.indexOf(cur) + dir + list.length) % list.length]!;
    if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
      e.preventDefault();
      stance = cycle(STANCES, stance, e.key === 'ArrowDown' ? 1 : -1);
    } else if (e.key.length === 1 && e.key >= '1' && e.key <= '6') {
      e.preventDefault();
      stance = STANCES[Number(e.key) - 1]!;
    } else if (key === 't') {
      e.preventDefault();
      priority = cycle(PRIORITIES, priority, e.shiftKey ? -1 : 1);
    } else if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
      e.preventDefault();
      retreatThresholdPct = Math.max(0, Math.min(90, retreatThresholdPct + (e.key === 'ArrowRight' ? 5 : -5)));
    } else if (key === 'b' && isAttacker) {
      e.preventDefault();
      bombard = !bombard;
    } else if (key === 'i' && isAttacker && invadePreview !== null) {
      e.preventDefault();
      invade = !invade;
    } else if (key === 'n') {
      e.preventDefault();
      spareNoncombatants = !spareNoncombatants;
    } else if (e.key === 'Enter') {
      e.preventDefault();
      submit();
    }
  }

  const roster = $derived.by(() => {
    void app.version;
    return session().getRoster();
  });
  const nameOf = (id: number) => ownerName(id, (x) => roster.find((p) => p.id === x)?.name);
  const starName = $derived.by(() => {
    const gs = session().getState();
    return gs?.stars.find((s) => s.id === battle.starId)?.name ?? '?';
  });
  const fleetCounts = $derived.by(() => {
    const gs = session().getState();
    if (!gs) return { mine: 0, theirs: 0, theirBase: false };
    const count = (owner: number) => {
      if (owner < 0) {
        // NPC side: monsters / Andromedans at this star
        return gs.monsters.filter(
          (m) => m.starId === battle.starId && (owner === -3) === m.kind.startsWith('antaran_'),
        ).length;
      }
      return gs.ships.filter(
        (s) => s.owner === owner && s.shipKind === 'design' && s.location.kind === 'star' && s.location.starId === battle.starId,
      ).length;
    };
    const enemy = isAttacker ? battle.defender : battle.attacker;
    const theirBase =
      enemy >= 0 &&
      gs.colonies.some(
        (c) =>
          c.owner === enemy &&
          gs.planets.some((p) => p.id === c.planetId && p.starId === battle.starId) &&
          c.buildings.some((b) => ['star_base', 'battle_station', 'star_fortress', 'missile_base', 'ground_batteries'].includes(b)),
      );
    return isAttacker
      ? { mine: count(battle.attacker), theirs: count(battle.defender), theirBase }
      : { mine: count(battle.defender), theirs: count(battle.attacker), theirBase };
  });

  // when the defender holds ONLY outposts here, the bombard order is really
  // "destroy the outpost" — any winning fleet levels the dome, no bombs needed
  const outpostTarget = $derived.by(() => {
    const gs = session().getState();
    if (!gs || battle.defender < 0) return false;
    const holdings = gs.colonies.filter(
      (c) => c.owner === battle.defender && gs.planets.some((p) => p.id === c.planetId && p.starId === battle.starId),
    );
    return holdings.length > 0 && holdings.every((c) => c.outpost);
  });

  // preview the barrage with the engine's own bombardment math so a fleet
  // that cannot hurt the colony is warned up front instead of the order
  // silently doing nothing after the win. null = no populated colony to bomb.
  const bombardPreview = $derived.by(() => {
    const gs = session().getState();
    if (!gs || battle.defender < 0) return null;
    const colony = gs.colonies.find(
      (c) =>
        c.owner === battle.defender &&
        !c.outpost &&
        gs.planets.some((p) => p.id === c.planetId && p.starId === battle.starId),
    );
    if (!colony) return null;
    return {
      damage: fleetBombardDamage(gs, battle.attacker, battle.starId, planetShieldBlock(colony)),
      unshielded: fleetBombardDamage(gs, battle.attacker, battle.starId, 0),
    };
  });

  // marine landing: only offered when the attacker actually has marines in
  // orbit and the defender has a populated colony to take
  const invadePreview = $derived.by(() => {
    const gs = session().getState();
    if (!gs || !isAttacker || battle.defender < 0) return null;
    const colony = gs.colonies.find(
      (c) =>
        c.owner === battle.defender &&
        !c.outpost &&
        gs.planets.some((p) => p.id === c.planetId && p.starId === battle.starId),
    );
    if (!colony) return null;
    const marines = gs.ships
      .filter(
        (s) =>
          s.owner === battle.attacker &&
          s.shipKind === 'transport' &&
          s.location.kind === 'star' &&
          s.location.starId === battle.starId,
      )
      .reduce((n, s) => n + shipMarines(s), 0);
    if (marines === 0) return null;
    return { marines, defenders: marinesOf(colony) + Math.ceil(colonyPopUnits(colony) / 2) };
  });

  function submit() {
    session().submit('battle_orders', {
      battleId: battle.id,
      orders: {
        stance,
        priority,
        retreatThresholdPct,
        bombard: isAttacker ? bombard : false,
        invade: isAttacker && invadePreview !== null ? invade : false,
        spareNoncombatants,
      },
    });
  }
</script>

<svelte:window onkeydown={onKey} />

<div class="overlay">
  <div class="dialog" data-testid="battle-dialog">
    <h3>⚔ Battle at {starName}</h3>
    {#if !alreadyOrdered}
      <p class="countdown" class:urgent={secondsLeft <= 10} data-testid="battle-countdown">
        ⏱ auto-resolves with the current strategy in ~{secondsLeft}s
      </p>
    {/if}
    <p>
      {nameOf(battle.attacker)} attacks {nameOf(battle.defender)} — you are the
      <b>{isAttacker ? 'attacker' : 'defender'}</b>
      ({fleetCounts.mine} warship{fleetCounts.mine === 1 ? '' : 's'} vs
      {fleetCounts.theirs}{fleetCounts.theirBase ? ' + orbital defenses' : ''}).
    </p>
    {#if alreadyOrdered}
      <p data-testid="battle-waiting">Orders locked. Waiting for the enemy…</p>
    {:else}
      <div class="grid">
        <label>Stance
          <select data-testid="battle-stance" bind:value={stance}>
            <option value="charge">Charge — close to point-blank</option>
            <option value="hold_range">Hold position — stand fast and fight</option>
            <option value="standoff">Standoff — stay at long range</option>
            <option value="formation">Formation — advance as one line at fleet speed</option>
            <option value="passthrough">Passthrough — punch through, then withdraw together (raid)</option>
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
            <option value="deadliest">Deadliest — highest weapon output first</option>
          </select>
        </label>
        <label>Retreat below {retreatThresholdPct}% fleet HP
          <input type="range" min="0" max="90" step="5" bind:value={retreatThresholdPct} />
        </label>
        {#if isAttacker}
          <label class="row" title={outpostTarget ? 'an outpost has no population to protect it — a winning fleet destroys it outright' : undefined}>
            <input type="checkbox" data-testid="battle-bombard" bind:checked={bombard} />
            {outpostTarget ? '💥 Destroy the outpost if the pass is won' : 'Bombard the colony if the pass is won'}
          </label>
          {#if !outpostTarget && bombardPreview !== null}
            {#if bombardPreview.damage === 0 && bombardPreview.unshielded === 0}
              <p class="warn" data-testid="battle-no-bombs">⚠ This fleet mounts no weapons capable of orbital bombardment — the barrage will do no damage. Bring marine transports and invade instead.</p>
            {:else if bombardPreview.damage === 0}
              <p class="warn" data-testid="battle-no-bombs">⚠ The colony's planetary shield blocks every hit this fleet can land — the barrage will do no damage. Bring heavier or shield-piercing weapons, or marines to invade.</p>
            {:else}
              <p class="hint" data-testid="battle-bombard-preview">expected barrage: ~{bombardPreview.damage} damage (≈{Math.floor(bombardPreview.damage / 20)} pop/building hit{Math.floor(bombardPreview.damage / 20) === 1 ? '' : 's'})</p>
            {/if}
          {/if}
        {/if}
        {#if isAttacker && invadePreview !== null}
          <label class="row" title="a monumental step: your marine transports land after the pass is won — the landing force is spent whether or not the colony falls">
            <input type="checkbox" data-testid="battle-invade" bind:checked={invade} />
            🪖 Invade the colony if the pass is won ({invadePreview.marines} marine{invadePreview.marines === 1 ? '' : 's'} vs ~{invadePreview.defenders} defender{invadePreview.defenders === 1 ? '' : 's'})
          </label>
        {/if}
        <label class="row" title="if you win the field, the enemy's unarmed ships (colony/outpost ships, transports) are normally captured and destroyed — check to let them go">
          <input type="checkbox" data-testid="battle-spare" bind:checked={spareNoncombatants} />
          Spare non-combatant ships if the pass is won
        </label>
      </div>
      <button data-testid="battle-submit" onclick={submit}>Lock in orders (Enter)</button>
      <p class="keys">⌨ ↑↓/1-6 stance · T target · ←→ retreat · {isAttacker ? (outpostTarget ? 'B destroy outpost · ' : 'B bombard · ') : ''}{isAttacker && invadePreview !== null ? 'I invade · ' : ''}N spare civilians · Enter lock in</p>
    {/if}
  </div>
</div>

<style>
  .overlay {
    position: fixed;
    inset: 0;
    background: rgba(0, 0, 0, 0.8);
    display: flex;
    align-items: center;
    justify-content: center;
    z-index: 40;
  }
  .dialog {
    background: var(--panel-2);
    border: 1px solid var(--line-bright);
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
  .countdown {
    font-size: 0.85rem;
    color: var(--text-dim, var(--text-dim));
    margin: 0.2rem 0 0;
  }
  .countdown.urgent {
    color: var(--bad, #ff7b7b);
    font-weight: 600;
  }
  .keys {
    font-size: 0.72rem;
    opacity: 0.65;
    margin: 0.4rem 0 0;
  }
  .warn {
    font-size: 0.78rem;
    color: var(--bad, #ff7b7b);
    margin: -0.35rem 0 0;
  }
  .hint {
    font-size: 0.75rem;
    opacity: 0.7;
    margin: -0.35rem 0 0;
  }
</style>
