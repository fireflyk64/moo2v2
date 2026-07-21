<script lang="ts">
  import {
    availableHulls,
    bestArmor,
    bestComputer,
    bestDrive,
    bestShield,
    designDps,
    designStats,
    modUnlocked,
    knownWeapons,
    specialSystemInfo,
    shipStyleOf,
    HULLS_BUILDABLE,
    SPECIALS,
    type DesignStats,
    type EmpireDesign,
    type WeaponArc,
  } from '@engine/index';
  import { appForWeapon, hullById, weaponById } from '@engine/data/index';
  import { app, getActive } from '../state.svelte';
  import { playerColor } from '../colors';
  import ShipPreview from '../battle/ShipPreview.svelte';
  import ShipLoadoutEditor from '../components/ShipLoadoutEditor.svelte';
  import { armorNameForTier, computerNameForTier, driveNameForTier, shieldNameForTier, weaponModTooltip } from '../components/shipLoadoutShared';
  import { variantsFor, wrapVariant, type ArtClass } from '../battle/shipart';
  import { enemySeedsFromReplays, setLabSeed, type LabSeedGroup } from '../labSeed';
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
  // the editor opens pre-filled with the best fit known WHEN IT OPENS (a
  // deliberate snapshot, not reactive — the engine keeps the buildable
  // default designs themselves refreshed as research lands)
  const fitAtOpen = ((): { computer: number; shield: number; beam: string } => {
    const e = session().getPlanned()?.empires.find((x) => x.id === session().playerId) ?? null;
    if (!e) return { computer: 0, shield: 0, beam: 'laser_cannon' };
    const beams = knownWeapons(e)
      .filter((w) => w.classId === 0 && w.techId !== 0)
      .sort((a, b) => b.tacticalDamage.max - a.tacticalDamage.max);
    return { computer: bestComputer(e), shield: bestShield(e), beam: beams[0]?.id ?? 'laser_cannon' };
  })();
  let computer = $state(fitAtOpen.computer);
  let shield = $state(fitAtOpen.shield);
  let specials = $state<string[]>([]);
  let weapons = $state<Array<{ weapon: string; count: number; mods: string[]; arc: WeaponArc }>>([
    { weapon: fitAtOpen.beam, count: 2, mods: [], arc: 'F' },
  ]);
  /** cosmetic model variant within the hull class (scroll with ◀ ▶) */
  let modelIdx = $state(0);

  // ---- fleet appearance (cosmetic; selected in Empires, previewed here) ----
  const myColor = $derived(playerColor(session().playerId));
  const currentStyle = $derived(empire ? shipStyleOf(empire) : 'raptor');
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
  const driveTier = $derived(empire ? bestDrive(empire) : 1);
  const armorTier = $derived(empire ? bestArmor(empire) : 1);
  const driveName = $derived(driveNameForTier(driveTier));
  const armorName = $derived(armorNameForTier(armorTier));
  const computerName = $derived(computerNameForTier(computer));
  const shieldName = $derived(shieldNameForTier(shield));
  const missileEvasion = $derived.by(() => {
    if (specials.includes('multi_wave_ecm_jammer')) return 70;
    if (specials.includes('ecm_jammer') || specials.includes('wide_area_jammer')) return 40;
    return 0;
  });
  const weaponChoices = $derived(
    empire
      ? knownWeapons(empire)
          .filter((w) => w.techId !== 0)
          .map((w) => ({ ...w, label: appForWeapon(w.id)?.name ?? w.id.replaceAll('_', ' ') }))
      : [],
  );
  const availableSpecials = $derived(
    empire ? Object.keys(SPECIALS).filter((s) => empire.knownApps.includes(s)) : [],
  );
  const specialName = (id: string) => specialSystemInfo(id).name;
  const specialDescription = (id: string) => specialSystemInfo(id).description;
  const specialSpacePct = (id: string) => specialSystemInfo(id).spacePct;

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
  function isModLocked(weaponId: string, mod: string): boolean {
    return empire ? !modUnlocked(empire, weaponId, mod) : false;
  }
  function cycleComputer(dir: 1 | -1) {
    computer = Math.max(0, Math.min(maxComputer, computer + dir));
  }
  function cycleShield(dir: 1 | -1) {
    shield = Math.max(0, Math.min(maxShield, shield + dir));
  }
  function clickComputerField(ev: MouseEvent) {
    const el = ev.currentTarget as HTMLElement;
    const r = el.getBoundingClientRect();
    cycleComputer(ev.clientX - r.left < r.width / 2 ? -1 : 1);
  }
  function clickShieldField(ev: MouseEvent) {
    const el = ev.currentTarget as HTMLElement;
    const r = el.getBoundingClientRect();
    cycleShield(ev.clientX - r.left < r.width / 2 ? -1 : 1);
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
      armor: armorTier,
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

  // ---- design files: download the current fit / upload one into the editor ----
  let importNote = $state('');
  function exportDesign() {
    const data = {
      format: 'moo2v2-design',
      version: 1,
      name, hull, computer, shield,
      specials: [...specials],
      weapons: weapons.map((w) => ({ weapon: w.weapon, count: w.count, mods: [...w.mods], arc: w.arc })),
      modelIdx: wrapVariant(hull as ArtClass, modelIdx),
    };
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `${(name || 'design').replace(/[^\w-]+/g, '_')}.moo2design.json`;
    a.click();
    URL.revokeObjectURL(a.href);
  }
  async function importDesign(ev: Event) {
    const inputEl = ev.target as HTMLInputElement;
    const file = inputEl.files?.[0];
    inputEl.value = '';
    if (!file) return;
    try {
      const cfg = JSON.parse(await file.text()) as {
        format?: string;
        name?: unknown; hull?: unknown; computer?: unknown; shield?: unknown;
        specials?: unknown; weapons?: unknown; modelIdx?: unknown;
      };
      if (cfg.format !== 'moo2v2-design') throw new Error('not a moo2v2 design file');
      const int = (v: unknown, lo: number, hi: number, dflt: number) =>
        typeof v === 'number' && Number.isSafeInteger(v) ? Math.max(lo, Math.min(hi, v)) : dflt;
      // load into the EDITOR (not straight to save): the live stats panel
      // re-validates against this empire's tech and flags anything unknown
      nameAuto = false;
      name = typeof cfg.name === 'string' ? cfg.name.slice(0, 30) : 'Imported';
      hull = typeof cfg.hull === 'string' ? cfg.hull : 'frigate';
      computer = int(cfg.computer, 0, 6, 0);
      shield = int(cfg.shield, 0, 6, 0);
      specials = Array.isArray(cfg.specials) ? cfg.specials.filter((s): s is string => typeof s === 'string') : [];
      weapons = Array.isArray(cfg.weapons)
        ? cfg.weapons
            .filter((w): w is { weapon: string } & Record<string, unknown> => !!w && typeof (w as Record<string, unknown>)['weapon'] === 'string')
            .map((w) => ({
              weapon: w['weapon'] as string,
              count: int(w['count'], 1, 200, 1),
              mods: Array.isArray(w['mods']) ? (w['mods'] as unknown[]).filter((m): m is string => typeof m === 'string') : [],
              arc: (['F', 'FX', 'R', '360'] as const).includes(w['arc'] as never) ? (w['arc'] as WeaponArc) : 'F',
            }))
        : [];
      modelIdx = int(cfg.modelIdx, 0, 8, 0);
      importNote = `“${name}” loaded — check the stats, then Save`;
    } catch (e) {
      importNote = `⛔ import failed: ${e instanceof Error ? e.message : String(e)}`;
    }
  }

  const hullsOpen = $derived(empire ? availableHulls(empire) : []);
  const HULL_REQS: Record<string, string> = {
    cruiser: 'requires Capsule Construction',
    battleship: 'requires Astro Construction',
    titan: 'requires Titan Construction',
    doomstar: 'requires Doom Star Construction',
  };
  function hullLabel(id: string): string {
    return id
      .split('_')
      .map((w) => (w[0] ?? '').toUpperCase() + w.slice(1))
      .join(' ');
  }
  const hullOptions = $derived(
    HULLS_BUILDABLE.map((h) => ({
      id: h,
      label: hullLabel(h),
      disabled: !hullsOpen.includes(h),
      title: hullsOpen.includes(h) ? `select ${hullLabel(h)}` : HULL_REQS[h] ?? 'locked',
    })),
  );
  const hullSpace = $derived(hullById.get(hull)?.space ?? 0);
  function selectHull(h: string) {
    if (!hullsOpen.includes(h)) return;
    hull = h;
  }
  function clearEditor() {
    nameAuto = true;
    specials = [];
    weapons = weaponChoices[0] ? [{ weapon: weaponChoices[0].id, count: 1, mods: [], arc: 'F' }] : [];
  }
  function cancelEditor() {
    clearEditor();
    nameAuto = true;
    name = autoName(hull);
    importNote = '';
  }

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
  <div class="mooDesigner">
    <div class="titleBar">
      <span class="empire">{name || 'Design'} | {hullLabel(hull)}</span>
      <h2>SHIP DESIGN</h2>
      <span class="buildState">{typeof stats === 'string' ? 'invalid fit' : 'ready to build'}</span>
    </div>

    <div class="topDeck">
      <ShipLoadoutEditor
        driveName={driveName}
        armorName={armorName}
        shipStyle={currentStyle}
        shipClass={hull}
        shipVariant={modelIdx}
        shipColor={myColor}
        shipPx={4}
        previewSpecials={specials}
        previewHeavyBeams={previewHeavy}
        previewMissileTubes={previewMissiles}
        modelLabel={`Model ${wrapVariant(hull as ArtClass, modelIdx) + 1}/${variantsFor(hull as ArtClass)}`}
        canPrevModel={variantsFor(hull as ArtClass) >= 2}
        canNextModel={variantsFor(hull as ArtClass) >= 2}
        onPrevModel={() => cycleModel(-1)}
        onNextModel={() => cycleModel(1)}
        hullOptions={hullOptions}
        selectedHull={hull}
        hullSpace={hullSpace}
        hullSelectTestId="design-hull"
        onSelectHull={selectHull}
        designName={name}
        nameLabel="Name"
        nameTestId="design-name"
        onNameInput={(v) => {
          name = v;
          nameAuto = false;
        }}
        computerName={computerName}
        shieldName={shieldName}
        maxComputer={maxComputer}
        maxShield={maxShield}
        missileEvasion={missileEvasion}
        stats={stats}
        availableSpecials={availableSpecials}
        specials={specials}
        specialName={specialName}
        specialDescription={specialDescription}
        specialSpacePct={specialSpacePct}
        weapons={weapons}
        weaponChoices={weaponChoices}
        modTooltip={weaponModTooltip}
        isModLocked={isModLocked}
        onClickComputerField={clickComputerField}
        onClickShieldField={clickShieldField}
        onToggleSpecial={toggleSpecial}
        onToggleMod={toggleMod}
        onAddWeapon={addWeapon}
        onRemoveWeapon={removeWeapon}
      />
    </div>
    {#if !hullsOpen.includes(hull)}
      <p class="dim">locked: {HULL_REQS[hull] ?? 'requires research'}</p>
    {/if}


    <div class="commandBar">
      <div class="metric"><span>Cost</span><b>{stats && typeof stats !== 'string' ? stats.cost : '--'}</b></div>
      <div class="metric"><span>Space Available</span><b>{stats && typeof stats !== 'string' ? stats.spaceTotal - stats.spaceUsed : '--'}</b></div>
      {#if stats && typeof stats !== 'string'}
        <span class="battleBrief" data-testid="design-battle-stats">DPS {dpsOf(stats)} | Evasion +{stats.beamDefense} | Speed {stats.combatSpeed}</span>
      {/if}
      <div class="actions">
        <button onclick={clearEditor}>Clear</button>
        <button onclick={cancelEditor}>Cancel</button>
        <button data-testid="design-save" disabled={typeof stats === 'string'} onclick={save}>Build</button>
      </div>
    </div>
    {#if importNote}<p class="dim" data-testid="design-import-note">{importNote}</p>{/if}

    <div class="fileTools">
      <button
        data-testid="design-simulate"
        disabled={typeof stats === 'string'}
        onclick={simulate}
        title="open the Battle Lab with this exact fit against enemies you have met"
      >Simulate</button>
      <button data-testid="design-export" onclick={exportDesign} title="download this fit as a .moo2design.json file">Download</button>
      <label class="importbtn" title="load a .moo2design.json file into the editor">
        Upload<input
          data-testid="design-import"
          type="file"
          accept=".json,.moo2design,application/json"
          onchange={importDesign}
          style="display:none"
        />
      </label>
    </div>
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
          ({d.hull}) - {d.weapons.map((w) => `${w.count}x${w.weapon.replaceAll('_', ' ')}${w.arc && w.arc !== 'F' ? ` <${w.arc}>` : ''}${w.mods.length ? ` [${w.mods.join(',')}]` : ''}`).join(', ') || 'unarmed'}
          {#if !d.obsolete}
            <button onclick={() => obsolete(d.id)}>obsolete</button>
          {:else}
            <span class="dim">obsolete</span>
          {/if}
          {#if inspecting === d.id}
            {@const st = statsOf(d)}
            <div class="inspect">
              <div>computer tier {d.computer} | shield tier {d.shield}{d.specials.length ? ` | specials: ${d.specials.map((s) => s.replaceAll('_', ' ')).join(', ')}` : ''}</div>
              {#if st && typeof st !== 'string'}
                <div class="dim">
                  space {st.spaceUsed}/{st.spaceTotal} | cost {st.cost} | CP {st.cpUsage} |
                  atk +{st.beamAttack} | def +{st.beamDefense} | speed {st.combatSpeed} |
                  armor {st.armorHp} | struct {st.structureHp} | shields {st.shieldPool}
                </div>
              {:else if typeof st === 'string'}
                <div class="error">no longer valid: {st}</div>
              {/if}
              <button onclick={() => loadIntoEditor(d)}>copy into editor</button>
            </div>
          {/if}
        </li>
      {/each}
    </ul>
    <p class="dim">Queue warships from the Colonies tab build dropdown (combat entries).</p>
  </div>
{/if}

<style>
  .mooDesigner {
    border: 2px solid var(--line-bright);
    background: var(--bg);
    box-shadow: inset 0 0 0 2px var(--panel-2);
    padding: 0.5rem;
    margin-bottom: 1rem;
    font-family: Verdana, Tahoma, sans-serif;
  }
  .titleBar {
    display: grid;
    grid-template-columns: 1fr auto 1fr;
    align-items: center;
    border: 1px solid var(--line-bright);
    background: linear-gradient(180deg, var(--panel-3), var(--panel));
    color: var(--text);
    padding: 0.35rem 0.6rem;
    margin-bottom: 0.5rem;
    text-transform: uppercase;
    letter-spacing: 0.08em;
  }
  .titleBar h2 {
    margin: 0;
    text-align: center;
    font-size: 1.15rem;
  }
  .empire,
  .buildState {
    color: #d58a35;
    font-size: 0.76rem;
  }
  .buildState {
    text-align: right;
  }
  .topDeck {
    display: block;
    gap: 0.45rem;
    margin-bottom: 0.45rem;
  }
  .commandBar {
    margin-top: 0.45rem;
    border: 1px solid var(--line-bright);
    background: linear-gradient(180deg, var(--panel-3), var(--panel-2));
    padding: 0.35rem 0.45rem;
    display: grid;
    grid-template-columns: auto auto 1fr auto;
    align-items: center;
    gap: 0.55rem;
  }
  .metric {
    display: flex;
    align-items: center;
    gap: 0.35rem;
    border: 1px solid var(--line-bright);
    background: var(--panel);
    padding: 0.2rem 0.42rem;
    min-width: 130px;
  }
  .metric span {
    color: #d58a35;
    font-size: 0.76rem;
  }
  .metric b {
    color: var(--text);
    font-size: 1rem;
  }
  .battleBrief {
    color: #cf985a;
    font-size: 0.79rem;
  }
  .actions {
    display: flex;
    gap: 0.35rem;
  }
  .fileTools {
    margin-top: 0.4rem;
    display: flex;
    flex-wrap: wrap;
    gap: 0.35rem;
    align-items: center;
  }
  .importbtn {
    display: inline-block;
    border: 1px solid var(--line, var(--panel-3));
    border-radius: 6px;
    background: var(--panel-2);
    padding: 0.22rem 0.55rem;
    cursor: pointer;
    font-size: 0.88rem;
  }
  .importbtn:hover {
    background: var(--panel-3);
  }
  .list {
    border: 1px solid var(--line-bright);
    background: var(--panel);
    padding: 0.5rem;
  }
  .error {
    color: var(--bad);
  }
  .dim {
    opacity: 0.65;
  }
  li.obsolete {
    opacity: 0.5;
  }
  li {
    margin-bottom: 0.45rem;
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
    background: color-mix(in srgb, var(--panel) 60%, transparent);
    font-size: 0.85rem;
    display: flex;
    flex-direction: column;
    gap: 0.25rem;
    align-items: flex-start;
  }

  @media (max-width: 1100px) {
    .topDeck {
      grid-template-columns: 1fr;
    }
    .commandBar {
      grid-template-columns: 1fr;
      align-items: stretch;
    }
    .actions {
      justify-content: flex-end;
    }
  }
</style>
