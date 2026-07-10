<script lang="ts">
  import {
    availableHulls,
    bestComputer,
    bestShield,
    designDps,
    designStats,
    knownWeapons,
    HULLS_BUILDABLE,
    SPECIALS,
    type DesignStats,
    type EmpireDesign,
    type WeaponArc,
  } from '@engine/index';
  import { app, getActive } from '../state.svelte';
  import { enemySeedsFromReplays, setLabSeed, type LabSeedGroup } from '../labSeed';

  const ARCS: Array<{ id: WeaponArc; label: string; help: string }> = [
    { id: 'F', label: 'F', help: 'forward 180° (standard mount)' },
    { id: 'FX', label: 'FX', help: 'extended forward 270° (+20% space)' },
    { id: 'R', label: 'R', help: 'rear 180° (−10% space — raiders fire while withdrawing)' },
    { id: '360', label: '360', help: 'full turret coverage (+40% space)' },
  ];
  /** designer readout: expected damage/sec at short range for the current fit */
  function dpsOf(st: DesignStats): number {
    return designDps(
      st.weapons.map((w) => ({
        weaponId: w.row.id,
        classId: w.row.classId,
        dmgMin: w.row.tacticalDamage.min,
        dmgMax: w.row.tacticalDamage.max,
        mods: w.mods,
        ammo: w.row.ammo,
        cooldown: 0,
        count: w.count,
        arc: w.arc,
      })),
      st.beamAttack,
    );
  }

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
  let weapons = $state<Array<{ weapon: string; count: number; mods: string[]; arc: WeaponArc }>>([
    { weapon: 'laser_cannon', count: 2, mods: [], arc: 'F' },
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
    if (first) weapons = [...weapons, { weapon: first.id, count: 1, mods: [], arc: 'F' }];
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

  /** try the design on the battlefield BEFORE saving it: opens the Battle Lab
   * with the work-in-progress fit vs every enemy type met in battle (or a
   * mirror of itself when nothing has been encountered yet) */
  function simulate() {
    const wip: LabSeedGroup = {
      label: name || 'WIP design',
      hull,
      computer,
      shield,
      specials: [...specials],
      weapons: weapons.map((w) => ({ weapon: w.weapon, count: w.count, mods: [...w.mods], arc: w.arc })),
      count: 3,
    };
    let enemies = enemySeedsFromReplays(app.replays, session().playerId);
    if (!enemies.length) enemies = [{ ...wip, label: `mirror ${wip.label}` }];
    setLabSeed([wip], enemies);
    location.hash = '#battle-lab';
  }
  function obsolete(designId: number) {
    session().submit('obsolete_design', { designId });
  }

  const hullsOpen = $derived(empire ? availableHulls(empire) : []);
  const HULL_REQS: Record<string, string> = {
    cruiser: 'requires Capsule Construction',
    battleship: 'requires Astro Construction',
    titan: 'requires Titan Construction',
    doomstar: 'requires Doom Star Construction',
  };

  // design inspector: expand a saved design to see exactly how it was built
  let inspecting = $state<number | null>(null);
  function inspect(d: EmpireDesign) {
    inspecting = inspecting === d.id ? null : d.id;
  }
  function loadIntoEditor(d: EmpireDesign) {
    name = `${d.name} II`;
    hull = d.hull;
    computer = d.computer;
    shield = d.shield;
    specials = [...d.specials];
    weapons = d.weapons.map((w) => ({ weapon: w.weapon, count: w.count, mods: [...w.mods], arc: w.arc ?? 'F' }));
  }
  function statsOf(d: EmpireDesign): DesignStats | string | null {
    if (!gs || !empire) return null;
    return designStats(gs, empire, d);
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
            <option value={h} disabled={!hullsOpen.includes(h)}>
              {h}{hullsOpen.includes(h) ? '' : ` — 🔒 ${HULL_REQS[h] ?? 'locked'}`}
            </option>
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
            <select class="arc" bind:value={w.arc} title={ARCS.find((a) => a.id === w.arc)?.help}>
              {#each ARCS as a (a.id)}
                <option value={a.id} title={a.help}>{a.label}</option>
              {/each}
            </select>
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
        <p class="battlestats" data-testid="design-battle-stats" title="DPS = expected damage/second at short range · evasion = enemy to-hit is reduced by this · beams fall to 70% damage at medium and 40% at long range">
          ⚔ DPS ~{dpsOf(stats)} · 🛰 evasion {stats.beamDefense} · 🚀 speed {stats.combatSpeed} ·
          📏 beams to 448u{stats.weapons.some((w) => w.mods.includes('hv')) ? ' (heavy 560u)' : ''} · missiles 600u · torpedoes 500u
        </p>
      {/if}
      <button data-testid="design-save" disabled={typeof stats === 'string'} onclick={save}>Save design</button>
      <button
        data-testid="design-simulate"
        disabled={typeof stats === 'string'}
        onclick={simulate}
        title="open the Battle Lab with this exact fit (unsaved is fine) vs every enemy type you have met — sandbox only"
      >⚗ Simulate</button>
    </div>

    <div class="list">
      <h3>Your designs</h3>
      <ul>
        {#each empire.designs as d (d.id)}
          <li class:obsolete={d.obsolete} data-testid="design-{d.id}">
            <button class="linklike" onclick={() => inspect(d)}>{inspecting === d.id ? '▾' : '▸'} <b>{d.name}</b></button>
            ({d.hull}) — {d.weapons.map((w) => `${w.count}×${w.weapon.replaceAll('_', ' ')}${w.arc && w.arc !== 'F' ? `⟨${w.arc}⟩` : ''}${w.mods.length ? ` [${w.mods.join(',')}]` : ''}`).join(', ') || 'unarmed'}
            {#if !d.obsolete}
              <button onclick={() => obsolete(d.id)}>obsolete</button>
            {:else}
              <span class="dim">obsolete</span>
            {/if}
            {#if inspecting === d.id}
              {@const st = statsOf(d)}
              <div class="inspect">
                <div>computer tier {d.computer} · shield tier {d.shield}{d.specials.length ? ` · specials: ${d.specials.map((s) => s.replaceAll('_', ' ')).join(', ')}` : ''}</div>
                {#if st && typeof st !== 'string'}
                  <div class="dim">
                    space {st.spaceUsed}/{st.spaceTotal} · cost {st.cost} · CP {st.cpUsage} ·
                    atk +{st.beamAttack} · def +{st.beamDefense} · speed {st.combatSpeed} ·
                    armor {st.armorHp} · struct {st.structureHp} · shields {st.shieldPool}
                  </div>
                {:else if typeof st === 'string'}
                  <div class="error">no longer valid: {st}</div>
                {/if}
                <button onclick={() => loadIntoEditor(d)}>⎘ copy into editor</button>
              </div>
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
  .arc {
    width: 4rem;
  }
  .battlestats {
    color: var(--accent-soft);
    font-size: 0.9rem;
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
  .linklike {
    background: none;
    border: none;
    padding: 0;
    color: var(--accent-soft);
    cursor: pointer;
  }
  .inspect {
    margin: 0.3rem 0 0.2rem 1.1rem;
    padding: 0.4rem 0.6rem;
    border: 1px solid var(--line);
    border-radius: 6px;
    background: rgba(15, 21, 48, 0.6);
    font-size: 0.85rem;
    display: flex;
    flex-direction: column;
    gap: 0.25rem;
    align-items: flex-start;
  }
</style>
