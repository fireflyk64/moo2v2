<script lang="ts">
  import {
    bestComputer,
    bestShield,
    designStats,
    knownWeapons,
    HULLS_BUILDABLE,
    SPECIALS,
    type DesignStats,
  } from '@engine/index';
  import { app, getActive } from '../state.svelte';

  const session = () => getActive()!.session;
  const gs = $derived.by(() => {
    void app.version;
    return session().getPlanned();
  });
  const empire = $derived(gs?.empires.find((e) => e.id === session().playerId) ?? null);

  let name = $state('New Design');
  let hull = $state('frigate');
  let computer = $state(0);
  let shield = $state(0);
  let specials = $state<string[]>([]);
  let weapons = $state<Array<{ weapon: string; count: number; mods: string[] }>>([
    { weapon: 'laser_cannon', count: 2, mods: [] },
  ]);

  const maxComputer = $derived(empire ? bestComputer(empire) : 0);
  const maxShield = $derived(empire ? bestShield(empire) : 0);
  const weaponChoices = $derived(empire ? knownWeapons(empire).filter((w) => w.techId !== 0) : []);
  const availableSpecials = $derived(
    empire ? Object.keys(SPECIALS).filter((s) => empire.knownApps.includes(s)) : [],
  );

  const stats = $derived.by((): DesignStats | string | null => {
    if (!gs || !empire) return null;
    return designStats(gs, empire, { name, hull, computer, shield, specials, weapons });
  });

  function addWeapon() {
    const first = weaponChoices[0];
    if (first) weapons = [...weapons, { weapon: first.id, count: 1, mods: [] }];
  }
  function removeWeapon(i: number) {
    weapons = weapons.filter((_, x) => x !== i);
  }
  function toggleMod(i: number, mod: string) {
    const w = weapons[i]!;
    w.mods = w.mods.includes(mod) ? w.mods.filter((m) => m !== mod) : [...w.mods, mod];
    weapons = [...weapons];
  }
  function toggleSpecial(sp: string) {
    specials = specials.includes(sp) ? specials.filter((s) => s !== sp) : [...specials, sp];
  }
  function save() {
    const res = session().submit('save_design', { name, hull, computer, shield, specials, weapons });
    if (!res.error) name = 'New Design';
  }
  function obsolete(designId: number) {
    session().submit('obsolete_design', { designId });
  }
</script>

{#if gs && empire}
  <div class="wrap">
    <div class="form">
      <h3>New warship design</h3>
      <label>Name <input data-testid="design-name" bind:value={name} /></label>
      <label>Hull
        <select data-testid="design-hull" bind:value={hull}>
          {#each HULLS_BUILDABLE as h (h)}
            <option value={h}>{h}</option>
          {/each}
        </select>
      </label>
      <label>Computer (tier ≤ {maxComputer})
        <input type="number" min="0" max={maxComputer} bind:value={computer} />
      </label>
      <label>Shield (tier ≤ {maxShield})
        <input type="number" min="0" max={maxShield} bind:value={shield} />
      </label>
      {#if availableSpecials.length}
        <fieldset>
          <legend>Specials</legend>
          {#each availableSpecials as sp (sp)}
            <label class="row">
              <input type="checkbox" checked={specials.includes(sp)} onchange={() => toggleSpecial(sp)} />
              {sp.replaceAll('_', ' ')}
            </label>
          {/each}
        </fieldset>
      {/if}
      <fieldset>
        <legend>Weapons</legend>
        {#each weapons as w, i (i)}
          <div class="weapon">
            <select bind:value={w.weapon}>
              {#each weaponChoices as wc (wc.id)}
                <option value={wc.id}>{wc.id.replaceAll('_', ' ')}</option>
              {/each}
            </select>
            <input type="number" min="1" max="50" bind:value={w.count} />
            {#each weaponChoices.find((wc) => wc.id === w.weapon)?.availableMods ?? [] as mod (mod)}
              <label class="mod">
                <input type="checkbox" checked={w.mods.includes(mod)} onchange={() => toggleMod(i, mod)} />{mod}
              </label>
            {/each}
            <button onclick={() => removeWeapon(i)}>✕</button>
          </div>
        {/each}
        <button onclick={addWeapon}>+ weapon</button>
      </fieldset>

      {#if typeof stats === 'string'}
        <p class="error" data-testid="design-error">{stats}</p>
      {:else if stats}
        <p data-testid="design-stats">
          space {stats.spaceUsed}/{stats.spaceTotal} · cost {stats.cost} · CP {stats.cpUsage} ·
          atk +{stats.beamAttack} · def +{stats.beamDefense} · speed {stats.combatSpeed} ·
          armor {stats.armorHp} · struct {stats.structureHp} · shields {stats.shieldPool}
        </p>
      {/if}
      <button data-testid="design-save" disabled={typeof stats === 'string'} onclick={save}>Save design</button>
    </div>

    <div class="list">
      <h3>Your designs</h3>
      <ul>
        {#each empire.designs as d (d.id)}
          <li class:obsolete={d.obsolete} data-testid="design-{d.id}">
            <b>{d.name}</b> ({d.hull}) — {d.weapons.map((w) => `${w.count}×${w.weapon}`).join(', ') || 'unarmed'}
            {#if !d.obsolete}
              <button onclick={() => obsolete(d.id)}>obsolete</button>
            {:else}
              <span class="dim">obsolete</span>
            {/if}
          </li>
        {/each}
      </ul>
      <p class="dim">Queue warships from the Colonies tab build dropdown (⚔ entries).</p>
    </div>
  </div>
{/if}

<style>
  .wrap {
    display: flex;
    gap: 1.5rem;
    align-items: flex-start;
  }
  .form,
  .list {
    flex: 1;
  }
  label {
    display: flex;
    justify-content: space-between;
    gap: 0.5rem;
    margin: 0.3rem 0;
    max-width: 26rem;
  }
  fieldset {
    border: 1px solid #26304f;
    margin: 0.5rem 0;
    max-width: 30rem;
  }
  .weapon {
    display: flex;
    gap: 0.4rem;
    align-items: center;
    flex-wrap: wrap;
    margin-bottom: 0.35rem;
  }
  .weapon input[type='number'] {
    width: 3.5rem;
  }
  .mod {
    font-size: 0.75rem;
    display: inline-flex;
    gap: 0.15rem;
    margin: 0;
  }
  .row {
    justify-content: flex-start;
  }
  .error {
    color: #ff8a7a;
  }
  .dim {
    opacity: 0.6;
  }
  li.obsolete {
    opacity: 0.5;
  }
  li {
    margin-bottom: 0.4rem;
  }
</style>
