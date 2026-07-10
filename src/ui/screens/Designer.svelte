<script lang="ts">
  import {
    availableHulls,
    bestComputer,
    bestShield,
    designDps,
    designStats,
    modUnlocked,
    knownWeapons,
    shipStyleOf,
    HULLS_BUILDABLE,
    SHIP_STYLES,
    SPECIALS,
    type DesignStats,
    type EmpireDesign,
    type WeaponArc,
  } from '@engine/index';
  import { weaponById } from '@engine/data/index';
  import { app, getActive } from '../state.svelte';
  import { playerColor } from '../colors';
  import ShipPreview from '../battle/ShipPreview.svelte';
  import { variantsFor, wrapVariant, type ArtClass } from '../battle/shipart';
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

  // default design names follow the hull class ("Destroyer", then
  // "Destroyer II"...) until the player types their own
  const ROMAN_SUFFIX = ['', ' II', ' III', ' IV', ' V', ' VI', ' VII', ' VIII', ' IX', ' X'];
  function autoName(h: string): string {
    const base = h.split('_').map((w) => (w[0] ?? '').toUpperCase() + w.slice(1)).join(' ');
    const taken = new Set((empire?.designs ?? []).filter((d) => !d.obsolete).map((d) => d.name));
    for (const suffix of ROMAN_SUFFIX) {
      if (!taken.has(base + suffix)) return base + suffix;
    }
    return `${base} ${taken.size + 1}`;
  }
  let nameAuto = $state(true);
  let name = $state('Frigate');
  let hull = $state('frigate');
  $effect(() => {
    void hull;
    void empire?.designs.length;
    if (nameAuto) name = autoName(hull);
  });
  let computer = $state(0);
  let shield = $state(0);
  let specials = $state<string[]>([]);
  let weapons = $state<Array<{ weapon: string; count: number; mods: string[]; arc: WeaponArc }>>([
    { weapon: 'laser_cannon', count: 2, mods: [], arc: 'F' },
  ]);
  /** cosmetic model variant within the hull class (scroll with ◀ ▶) */
  let modelIdx = $state(0);

  // ---- fleet appearance (cosmetic; visible to everyone in battle replays) ----
  const myColor = $derived(playerColor(session().playerId));
  const currentStyle = $derived(empire ? shipStyleOf(empire) : SHIP_STYLES[0]!.id);
  let styleSel = $state<string | null>(null); // null = the applied style
  const shownStyle = $derived(styleSel ?? currentStyle);
  const shownStyleInfo = $derived(SHIP_STYLES.find((s) => s.id === shownStyle) ?? SHIP_STYLES[0]!);
  const PREVIEW_CLASSES: ArtClass[] = ['scout', 'frigate', 'destroyer', 'cruiser', 'battleship', 'titan', 'doomstar', 'star_base'];
  function cycleStyle(dir: 1 | -1) {
    const i = SHIP_STYLES.findIndex((s) => s.id === shownStyle);
    styleSel = SHIP_STYLES[(i + dir + SHIP_STYLES.length) % SHIP_STYLES.length]!.id;
  }
  function applyStyle() {
    if (shownStyle === currentStyle) return;
    const res = session().submit('set_ship_style', { style: shownStyle });
    if (!res.error) styleSel = null;
  }
  // model previews bake in the fit: heavy mounts and missile racks show on the hull
  const previewHeavy = $derived(weapons.some((w) => w.mods.includes('hv')));
  const previewMissiles = $derived(
    weapons.reduce((n, w) => n + ((weaponById.get(w.weapon)?.classId ?? 0) === 1 ? w.count : 0), 0),
  );
  function cycleModel(dir: 1 | -1) {
    const n = variantsFor(hull as ArtClass);
    modelIdx = (wrapVariant(hull as ArtClass, modelIdx) + dir + n) % n;
  }

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
    const res = session().submit('save_design', {
      name, hull, computer, shield, specials, weapons,
      modelIdx: wrapVariant(hull as ArtClass, modelIdx),
    });
    if (!res.error) nameAuto = true; // next default: "Destroyer II" etc.
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
    nameAuto = false;
    name = `${d.name} II`;
    hull = d.hull;
    computer = d.computer;
    shield = d.shield;
    specials = [...d.specials];
    weapons = d.weapons.map((w) => ({ weapon: w.weapon, count: w.count, mods: [...w.mods], arc: w.arc ?? 'F' }));
    modelIdx = wrapVariant(d.hull as ArtClass, d.modelIdx ?? d.id);
  }
  function statsOf(d: EmpireDesign): DesignStats | string | null {
    if (!gs || !empire) return null;
    return designStats(gs, empire, d);
  }
</script>

{#if gs && empire}
  <div class="appearance" data-testid="fleet-style-panel">
    <div class="stylebar">
      <h3>Fleet style</h3>
      <button class="mini" data-testid="style-prev" onclick={() => cycleStyle(-1)} title="previous style">◀</button>
      <b class="stylename">{shownStyleInfo.name}</b>
      <button class="mini" data-testid="style-next" onclick={() => cycleStyle(1)} title="next style">▶</button>
      <span class="dim">{shownStyleInfo.blurb}</span>
      {#if shownStyle !== currentStyle}
        <button data-testid="style-apply" onclick={applyStyle}>Adopt this style</button>
      {:else}
        <span class="current">✓ your fleet's style</span>
      {/if}
    </div>
    <div class="stylestrip">
      {#each PREVIEW_CLASSES as pc (pc)}
        <span class="cell">
          <ShipPreview style={shownStyle} cls={pc} variant={0} color={myColor} px={2} title={pc.replaceAll('_', ' ')} />
          <small>{pc === 'star_base' ? 'base' : pc}</small>
        </span>
      {/each}
    </div>
    <p class="dim finePrint">Cosmetic only — this is how your warships appear to everyone in battle replays. Each design also picks a model of its class below.</p>
  </div>
  <div class="wrap">
    <div class="form">
      <h3>New warship design</h3>
      <label>Name <input data-testid="design-name" bind:value={name} oninput={() => (nameAuto = false)} /></label>
      <label>Hull
        <select data-testid="design-hull" bind:value={hull}>
          {#each HULLS_BUILDABLE as h (h)}
            <option value={h} disabled={!hullsOpen.includes(h)}>
              {h}{hullsOpen.includes(h) ? '' : ` — 🔒 ${HULL_REQS[h] ?? 'locked'}`}
            </option>
          {/each}
        </select>
      </label>
      <div class="modelpick" data-testid="model-picker">
        <span>Model</span>
        <button class="mini" data-testid="model-prev" onclick={() => cycleModel(-1)} disabled={variantsFor(hull as ArtClass) < 2}>◀</button>
        <ShipPreview
          style={shownStyle}
          cls={hull as ArtClass}
          variant={modelIdx}
          color={myColor}
          specials={[...specials]}
          heavyBeams={previewHeavy}
          missileTubes={previewMissiles}
          px={3}
        />
        <button class="mini" data-testid="model-next" onclick={() => cycleModel(1)} disabled={variantsFor(hull as ArtClass) < 2}>▶</button>
        <span class="dim">{wrapVariant(hull as ArtClass, modelIdx) + 1}/{variantsFor(hull as ArtClass)}</span>
      </div>
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
            {#if weaponChoices.find((wc) => wc.id === w.weapon)?.classId === 5}
              <!-- point defense tracks all around regardless of mount: fixed
                   360° coverage at standard-mount space (no arc premium) -->
              <span class="arc pd360" title="point defense tracks 360° — full coverage at standard-mount space">360°</span>
            {:else}
              <select class="arc" bind:value={w.arc} title={ARCS.find((a) => a.id === w.arc)?.help}>
                {#each ARCS as a (a.id)}
                  <option value={a.id} title={a.help}>{a.label}</option>
                {/each}
              </select>
            {/if}
            {#each weaponChoices.find((wc) => wc.id === w.weapon)?.availableMods ?? [] as mod (mod)}
              {@const locked = empire ? !modUnlocked(empire, w.weapon, mod) : false}
              <label class="mod" class:locked title={locked ? `${mod}: requires research ${mod === 'pd' ? 'one level' : 'two levels'} deeper in this weapon's field` : ''}>
                <input type="checkbox" disabled={locked} checked={w.mods.includes(mod)} onchange={() => toggleMod(i, mod)} />{mod}{locked ? '🔒' : ''}
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
            <ShipPreview
              style={currentStyle}
              cls={d.hull as ArtClass}
              variant={d.modelIdx ?? d.id}
              color={myColor}
              specials={[...d.specials]}
              px={1}
            />
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
  .appearance {
    border: 1px solid #26304f;
    border-radius: 10px;
    padding: 0.5rem 0.9rem 0.2rem;
    margin-bottom: 1rem;
    background: linear-gradient(180deg, rgba(15, 21, 48, 0.65), rgba(10, 14, 34, 0.65));
  }
  .stylebar {
    display: flex;
    align-items: center;
    gap: 0.6rem;
    flex-wrap: wrap;
  }
  .stylebar h3 {
    margin: 0;
  }
  .stylename {
    min-width: 5.5rem;
    text-align: center;
    color: var(--accent-soft);
  }
  .current {
    color: var(--good, #5ee08a);
    font-size: 0.85rem;
  }
  .stylestrip {
    display: flex;
    gap: 1.1rem;
    align-items: center;
    padding: 0.55rem 0.2rem 0.25rem;
    flex-wrap: wrap;
  }
  .stylestrip .cell {
    display: inline-flex;
    flex-direction: column;
    align-items: center;
    gap: 0.15rem;
  }
  .stylestrip small {
    color: var(--text-dim);
    font-size: 0.68rem;
  }
  .finePrint {
    margin: 0.1rem 0 0.4rem;
    font-size: 0.78rem;
  }
  .modelpick {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    margin: 0.35rem 0;
    min-height: 45px;
  }
  .mini {
    padding: 0.1rem 0.45rem;
  }
  .mod.locked {
    opacity: 0.45;
  }
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
  .pd360 {
    display: inline-block;
    text-align: center;
    color: var(--accent-soft);
    font-size: 0.8rem;
    opacity: 0.9;
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
