<script lang="ts">
  import type { DesignStats, WeaponArc } from '@engine/index';
  import ShipPreview from '../battle/ShipPreview.svelte';
  import type { ArtClass } from '../battle/shipart';

  interface WeaponChoice {
    id: string;
    label?: string;
    classId: number;
    tacticalDamage: { min: number; max: number };
    availableMods: string[];
  }

  interface EditableWeapon {
    weapon: string;
    count: number;
    mods: string[];
    arc: WeaponArc;
  }

  interface HullOption {
    id: string;
    label: string;
    disabled?: boolean;
    title?: string;
  }

  interface Props {
    driveName: string;
    armorName: string;
    driveTier?: number;
    armorTier?: number;
    maxDrive?: number;
    maxArmor?: number;
    shipStyle?: string;
    shipClass?: string;
    shipVariant?: number;
    shipColor?: string;
    shipPx?: number;
    previewSpecials?: string[];
    previewHeavyBeams?: boolean;
    previewMissileTubes?: number;
    modelLabel?: string;
    canPrevModel?: boolean;
    canNextModel?: boolean;
    onPrevModel?: () => void;
    onNextModel?: () => void;
    hullOptions?: HullOption[];
    selectedHull?: string;
    hullSelectTestId?: string;
    onSelectHull?: (hull: string) => void;
    designName?: string;
    nameLabel?: string;
    nameTestId?: string;
    onNameInput?: (name: string) => void;
    computerName: string;
    shieldName: string;
    maxComputer: number;
    maxShield: number;
    missileEvasion: number;
    stats: DesignStats | string | null;
    availableSpecials: string[];
    specials: string[];
    specialName?: (id: string) => string;
    specialDescription?: (id: string) => string;
    specialSpacePct?: (id: string) => number;
    hullSpace?: number;
    weapons: EditableWeapon[];
    weaponChoices: WeaponChoice[];
    modTooltip: (mod: string) => string;
    isModLocked?: (weaponId: string, mod: string) => boolean;
    onClickDriveField?: (ev: MouseEvent) => void;
    onClickArmorField?: (ev: MouseEvent) => void;
    onClickComputerField: (ev: MouseEvent) => void;
    onClickShieldField: (ev: MouseEvent) => void;
    onToggleSpecial: (sp: string) => void;
    onToggleMod: (wi: number, mod: string) => void;
    onAddWeapon: () => void;
    onRemoveWeapon: (wi: number) => void;
  }

  let {
    driveName,
    armorName,
    driveTier = 1,
    armorTier = 1,
    maxDrive = 1,
    maxArmor = 1,
    shipStyle,
    shipClass,
    shipVariant = 0,
    shipColor,
    shipPx = 3,
    previewSpecials = [],
    previewHeavyBeams = false,
    previewMissileTubes = 0,
    modelLabel = '',
    canPrevModel = true,
    canNextModel = true,
    onPrevModel,
    onNextModel,
    hullOptions = [],
    selectedHull,
    hullSelectTestId = 'loadout-hull',
    onSelectHull,
    designName = '',
    nameLabel = 'Name',
    nameTestId = 'loadout-name',
    onNameInput,
    computerName,
    shieldName,
    maxComputer,
    maxShield,
    missileEvasion,
    stats,
    availableSpecials,
    specials,
    specialName = (id: string) => id.replaceAll('_', ' '),
    specialDescription = (id: string) => id.replaceAll('_', ' '),
    specialSpacePct = () => 0,
    hullSpace = 0,
    weapons,
    weaponChoices,
    modTooltip,
    isModLocked = () => false,
    onClickDriveField,
    onClickArmorField,
    onClickComputerField,
    onClickShieldField,
    onToggleSpecial,
    onToggleMod,
    onAddWeapon,
    onRemoveWeapon,
  }: Props = $props();

  const ARCS: Array<{ id: WeaponArc; label: string; help: string }> = [
    { id: 'F', label: 'F', help: 'forward 180 deg (standard mount)' },
    { id: 'FX', label: 'FX', help: 'extended forward 270 deg (+20% space)' },
    { id: 'R', label: 'R', help: 'rear 180 deg (-10% space)' },
    { id: '360', label: '360', help: 'full turret coverage (+40% space)' },
  ];

  const driveEditable = $derived(!!onClickDriveField && maxDrive > 1);
  const armorEditable = $derived(!!onClickArmorField && maxArmor > 1);
  const showIdentity = $derived(!!shipStyle && !!shipClass && !!shipColor && !!selectedHull && hullOptions.length > 0);
  let specialsModalOpen = $state(false);
  const addableSpecials = $derived(availableSpecials.filter((sp) => !specials.includes(sp)));

  function removeSpecial(sp: string) {
    if (specials.includes(sp)) onToggleSpecial(sp);
  }

  function addSpecial(sp: string) {
    if (!specials.includes(sp)) onToggleSpecial(sp);
    specialsModalOpen = false;
  }

  function specialSpaceDeltaLabel(id: string): string {
    const pct = specialSpacePct(id);
    const amount = Math.round((hullSpace * pct) / 100);
    if (amount > 0) return `+${amount}`;
    if (amount < 0) return `${amount}`;
    return '0';
  }
</script>

<section class="panel topPanels" class:withIdentity={showIdentity}>
  {#if showIdentity}
    <div class="identityPanel">
      <div class="visualCol">
        <div class="thumb">
          <ShipPreview
            style={shipStyle!}
            cls={shipClass! as ArtClass}
            variant={shipVariant}
            color={shipColor!}
            specials={[...previewSpecials]}
            heavyBeams={previewHeavyBeams}
            missileTubes={previewMissileTubes}
            px={shipPx}
          />
        </div>
        {#if onPrevModel && onNextModel && modelLabel}
          <div class="modelpick" data-testid="model-picker">
            <button class="mini" data-testid="model-prev" onclick={onPrevModel} disabled={!canPrevModel}>◀</button>
            <span>{modelLabel}</span>
            <button class="mini" data-testid="model-next" onclick={onNextModel} disabled={!canNextModel}>▶</button>
          </div>
        {/if}
      </div>
      <div class="identityMeta">
        {#if onNameInput}
          <label class="lineField nameField"
            >{nameLabel}
            <input
              data-testid={nameTestId}
              value={designName}
              oninput={(ev) => onNameInput?.((ev.currentTarget as HTMLInputElement).value)}
            />
          </label>
        {/if}
        <div class="hullSelectTitle">Hull Class</div>
        <div class="classList" aria-label="Hull class selector">
          {#each hullOptions as h (h.id)}
            <button
              type="button"
              class="hullBtn"
              class:activeClass={h.id === selectedHull}
              disabled={!!h.disabled}
              title={h.title ?? `select ${h.label}`}
              aria-pressed={h.id === selectedHull}
              onclick={() => onSelectHull?.(h.id)}
            >
              {h.label}
            </button>
          {/each}
        </div>
        <select
          data-testid={hullSelectTestId}
          value={selectedHull}
          class="srOnly"
          aria-hidden="true"
          tabindex="-1"
          onchange={(ev) => onSelectHull?.((ev.currentTarget as HTMLSelectElement).value)}
        >
          {#each hullOptions as h (h.id)}
            <option value={h.id} disabled={!!h.disabled}>{h.label}</option>
          {/each}
        </select>
      </div>
    </div>
  {/if}

  <div class="sysPanel" data-testid="systems-panel-drive-armor">
      <div class="sysPanelTitle">Drive / Armor</div>
      <div class="sysPicker" data-testid="drive-picker">
        <div class="sysRow">
          <span>Drive</span>
          {#if driveEditable}
            <button
              class="cycleField"
              data-testid="drive-field"
              onclick={onClickDriveField}
              disabled={maxDrive <= 1}
              title="click left half for previous, right half for next"
            >
              <span class="arr">◀</span>
              <b>{driveName}</b>
              <span class="arr">▶</span>
            </button>
          {:else}
            <span class="plainField" title="auto-equipped drive">{driveName}</span>
          {/if}
        </div>
        <small class="affect">{stats && typeof stats !== 'string' ? `combat speed ${stats.combatSpeed}` : 'combat speed --'}{driveEditable ? ` | tier ${driveTier}` : ''}</small>
      </div>
      <div class="sysPicker" data-testid="armor-picker">
        <div class="sysRow">
          <span>Armor</span>
          {#if armorEditable}
            <button
              class="cycleField"
              data-testid="armor-field"
              onclick={onClickArmorField}
              disabled={maxArmor <= 1}
              title="click left half for previous, right half for next"
            >
              <span class="arr">◀</span>
              <b>{armorName}</b>
              <span class="arr">▶</span>
            </button>
          {:else}
            <span class="plainField" title="armor selection">{armorName}</span>
          {/if}
        </div>
        <small class="affect">{stats && typeof stats !== 'string' ? `structure ${stats.structureHp} | armor ${stats.armorHp}` : 'structure -- | armor --'}{armorEditable ? ` | tier ${armorTier}` : ''}</small>
      </div>
  </div>

  <div class="sysPanel" data-testid="systems-panel-computer-shield">
      <div class="sysPanelTitle">Computer / Shield</div>
      <div class="sysPicker" data-testid="computer-picker">
        <div class="sysRow">
          <span>Computer</span>
          <button
            class="cycleField"
            data-testid="computer-field"
            onclick={onClickComputerField}
            disabled={maxComputer <= 0}
            title="click left half for previous, right half for next"
          >
            <span class="arr">◀</span>
            <b>{computerName}</b>
            <span class="arr">▶</span>
          </button>
        </div>
        <small class="affect">{stats && typeof stats !== 'string' ? `beam attack +${stats.beamAttack}` : 'beam attack --'}</small>
      </div>
      <div class="sysPicker" data-testid="shield-picker">
        <div class="sysRow">
          <span>Shield</span>
          <button
            class="cycleField"
            data-testid="shield-field"
            onclick={onClickShieldField}
            disabled={maxShield <= 0}
            title="click left half for previous, right half for next"
          >
            <span class="arr">◀</span>
            <b>{shieldName}</b>
            <span class="arr">▶</span>
          </button>
        </div>
        <small class="affect">{stats && typeof stats !== 'string' ? `shield ${stats.shieldPool} | block ${stats.shieldFlat}` : 'shield -- | block --'}</small>
      </div>
      <div class="sysPicker compact">
        <div class="sysRow">
          <span>Beam Defense</span>
          <b class="sysValue">{stats && typeof stats !== 'string' ? `+${stats.beamDefense}` : '--'}</b>
        </div>
        <div class="sysRow">
          <span>Missile Evasion</span>
          <b class="sysValue">{missileEvasion}%</b>
        </div>
      </div>
  </div>
  {#if typeof stats === 'string'}
    <p class="error" data-testid="design-error">{stats}</p>
  {/if}
</section>

<section class="panel weaponsPanel">
  <div class="panelTitle">Weapon</div>
  <div class="weaponHead">
    <span></span>
    <span>Qty</span>
    <span>Weapon Type</span>
    <span>Damage</span>
    <span>Arc</span>
    <span>Cost</span>
    <span>Space</span>
    <span>Modifications</span>
  </div>
  {#each weapons as w, i (i)}
    {@const wc = weaponChoices.find((x) => x.id === w.weapon)}
    {@const fitted = stats && typeof stats !== 'string' ? stats.weapons[i] : undefined}
    <div class="weaponRow">
      <button class="mini removeBtn" title="remove weapon" onclick={() => onRemoveWeapon(i)}>✕</button>
      <input class="qty" type="number" min="1" max="50" bind:value={w.count} />
      <select class="weaponSelect" bind:value={w.weapon}>
        {#each weaponChoices as c (c.id)}
          <option value={c.id}>{c.label ?? c.id.replaceAll('_', ' ')}</option>
        {/each}
      </select>
      <span class="mono">{wc ? `${wc.tacticalDamage.min}-${wc.tacticalDamage.max}` : '-'}</span>
      {#if wc?.classId === 5}
        <span class="pd360" title="point defense tracks 360 degrees">360</span>
      {:else}
        <select class="arc" bind:value={w.arc} title={ARCS.find((a) => a.id === w.arc)?.help}>
          {#each ARCS as a (a.id)}
            <option value={a.id} title={a.help}>{a.label}</option>
          {/each}
        </select>
      {/if}
      <span class="mono">{fitted ? fitted.costEach * fitted.count : '-'}</span>
      <span class="mono">{fitted ? fitted.spaceEach * fitted.count : '-'}</span>
      <div class="mods">
        {#each wc?.availableMods ?? [] as mod (mod)}
          {@const locked = isModLocked(w.weapon, mod)}
          <label class="mod" class:locked title={`${modTooltip(mod)}${locked ? ' Requires deeper research in this weapon field.' : ''}`}>
            <input type="checkbox" disabled={locked} checked={w.mods.includes(mod)} onchange={() => onToggleMod(i, mod)} />
            {mod}{locked ? ' lock' : ''}
          </label>
        {/each}
        {#if !(wc?.availableMods?.length)}<span class="dim">no modifications</span>{/if}
      </div>
    </div>
  {/each}
  <button onclick={onAddWeapon}>+ Add Weapon</button>
</section>

<section class="panel specialsPanel">
  <div class="specialHeaderRow">
    <div class="panelTitle">Special Systems</div>
    <button onclick={() => (specialsModalOpen = true)} disabled={!availableSpecials.length}>+ Add</button>
  </div>
  {#if specials.length}
    <table class="specialTable" data-testid="specials-table">
      <thead>
        <tr>
          <th>Name</th>
          <th>Description</th>
          <th>Space</th>
          <th></th>
        </tr>
      </thead>
      <tbody>
        {#each specials as sp (sp)}
          <tr>
            <td>{specialName(sp)}</td>
            <td>{specialDescription(sp)}</td>
            <td>{specialSpaceDeltaLabel(sp)}</td>
            <td class="specialActionCell"><button class="mini" onclick={() => removeSpecial(sp)}>Remove</button></td>
          </tr>
        {/each}
      </tbody>
    </table>
  {:else}
    <p class="dim">No special systems selected.</p>
  {/if}
</section>

{#if specialsModalOpen}
  <div class="overlay" role="dialog" aria-label="Add special system">
    <div class="specialModal">
      <header class="modalHead">
        <h3>Add Special System</h3>
        <button class="mini" onclick={() => (specialsModalOpen = false)}>Close</button>
      </header>
      {#if addableSpecials.length}
        <table class="specialTable addTable" data-testid="specials-add-table">
          <thead>
            <tr>
              <th>Name</th>
              <th>Description</th>
              <th>Space</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {#each addableSpecials as sp (sp)}
              <tr>
                <td>{specialName(sp)}</td>
                <td>{specialDescription(sp)}</td>
                <td>{specialSpaceDeltaLabel(sp)}</td>
                <td class="specialActionCell"><button class="mini" onclick={() => addSpecial(sp)}>Add</button></td>
              </tr>
            {/each}
          </tbody>
        </table>
      {:else}
        <p class="dim">All unlocked special systems are already added.</p>
      {/if}
    </div>
  </div>
{/if}

<style>
  .panel {
    border: 1px solid #4f596c;
    background: #081226;
    box-shadow: inset 0 0 0 1px #18243f;
    padding: 0.45rem;
  }
  .topPanels {
    display: grid;
    gap: 0.35rem;
    align-content: start;
  }
  .topPanels.withIdentity {
    grid-template-columns: minmax(250px, 1fr) minmax(280px, 1fr) minmax(280px, 1fr);
  }
  .topPanels:not(.withIdentity) {
    grid-template-columns: minmax(280px, 1fr) minmax(280px, 1fr);
  }
  .identityPanel {
    display: grid;
    grid-template-columns: 98px 1fr;
    gap: 0.55rem;
    border: 1px solid #344769;
    background: #06162d;
    padding: 0.2rem;
  }
  .visualCol {
    display: grid;
    grid-template-rows: auto auto;
    gap: 0.35rem;
    align-content: start;
  }
  .thumb {
    border: 1px solid #394258;
    background: #071025;
    min-height: 98px;
    display: grid;
    place-items: center;
  }
  .identityMeta {
    display: grid;
    gap: 0.3rem;
  }
  .lineField {
    display: flex;
    justify-content: space-between;
    gap: 0.35rem;
    color: #d58a35;
    font-size: 0.85rem;
    align-items: center;
  }
  .lineField input {
    min-width: 0;
    flex: 1;
  }
  .hullSelectTitle {
    color: #d58a35;
    font-size: 0.82rem;
    text-transform: uppercase;
    letter-spacing: 0.06em;
  }
  .classList {
    border: 1px solid #3c465a;
    background: #0b1427;
    display: grid;
    grid-template-columns: 1fr;
    font-size: 0.75rem;
  }
  .hullBtn {
    all: unset;
    box-sizing: border-box;
    cursor: pointer;
    padding: 0.13rem 0.35rem;
    color: #c2cadf;
    border: 1px solid transparent;
    border-radius: 3px;
  }
  .hullBtn:hover:not(:disabled) {
    border-color: #415782;
    background: #1a2946;
  }
  .hullBtn:disabled {
    opacity: 0.45;
    cursor: not-allowed;
  }
  .classList .activeClass {
    background: #2f4775;
    color: #f3f6ff;
    font-weight: 600;
  }
  .srOnly {
    position: absolute;
    width: 1px;
    height: 1px;
    padding: 0;
    margin: -1px;
    overflow: hidden;
    clip: rect(0, 0, 0, 0);
    white-space: nowrap;
    border: 0;
  }
  .modelpick {
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 0.3rem;
    color: #d58a35;
    font-size: 0.72rem;
    line-height: 1.1;
    border: 1px solid #2f415f;
    background: #08162c;
    padding: 0.2rem;
  }
  .sysPanel {
    border: 1px solid #344769;
    background: #06162d;
    padding: 0.2rem;
    display: grid;
    gap: 0.2rem;
  }
  .sysPanelTitle {
    color: #cc8d46;
    font-size: 0.72rem;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    border-bottom: 1px solid #2a3c5a;
    padding-bottom: 0.1rem;
  }
  .sysPicker {
    display: grid;
    gap: 0.08rem;
    font-size: 0.8rem;
    color: #d58a35;
    border: 1px solid #2f415f;
    background: #07162c;
    padding: 0.2rem 0.25rem;
  }
  .sysPicker.compact {
    gap: 0.2rem;
  }
  .sysRow {
    display: flex;
    justify-content: space-between;
    align-items: center;
    gap: 0.35rem;
  }
  .affect {
    color: #aeb9d8;
    font-size: 0.72rem;
    padding-left: 0.1rem;
  }
  .sysValue {
    color: #dde5fb;
    font-size: 0.82rem;
  }
  .cycleField {
    min-width: 13.2rem;
    display: inline-flex;
    align-items: center;
    justify-content: space-between;
    gap: 0.4rem;
    padding: 0.15rem 0.35rem;
  }
  .plainField {
    color: #dce4f7;
    font-size: 0.82rem;
    font-weight: 600;
  }
  .cycleField .arr {
    color: #d58a35;
    font-size: 0.74rem;
    width: 1rem;
    text-align: center;
  }
  .cycleField b {
    color: #dce4f7;
    text-align: center;
    flex: 1;
    font-size: 0.82rem;
  }
  .weaponsPanel {
    margin-bottom: 0.45rem;
  }
  .panelTitle {
    color: #d58a35;
    font-size: 1.05rem;
    font-weight: 600;
    margin-bottom: 0.2rem;
  }
  .weaponHead,
  .weaponRow {
    display: grid;
    grid-template-columns: 36px 54px minmax(160px, 1.4fr) 76px 70px 60px 60px minmax(220px, 2fr);
    align-items: center;
    gap: 0.25rem;
  }
  .weaponHead {
    color: #d58a35;
    font-size: 0.78rem;
    border-bottom: 1px solid #2f3a4f;
    padding-bottom: 0.2rem;
    margin-bottom: 0.2rem;
  }
  .weaponRow {
    padding: 0.15rem 0;
    border-bottom: 1px solid rgba(86, 100, 128, 0.35);
    color: #d29b58;
  }
  .mini {
    padding: 0.1rem 0.4rem;
    min-width: 2rem;
  }
  .removeBtn {
    width: 2rem;
  }
  .qty {
    width: 3.1rem;
  }
  .weaponSelect {
    width: 100%;
  }
  .mono {
    color: #d8deef;
    font-size: 0.82rem;
  }
  .arc {
    width: 4rem;
  }
  .pd360 {
    text-align: center;
    color: #e0b98a;
    font-size: 0.82rem;
  }
  .mods {
    display: flex;
    gap: 0.35rem;
    flex-wrap: wrap;
    align-items: center;
    min-height: 1.7rem;
  }
  .mod {
    font-size: 0.74rem;
    display: inline-flex;
    gap: 0.2rem;
    align-items: center;
  }
  .mod.locked {
    opacity: 0.45;
  }
  .specialHeaderRow {
    display: flex;
    justify-content: space-between;
    align-items: center;
    margin-bottom: 0.25rem;
    gap: 0.4rem;
  }
  .specialTable {
    width: 100%;
    border-collapse: collapse;
    font-size: 0.8rem;
    color: #d8deef;
  }
  .specialTable th,
  .specialTable td {
    border: 1px solid #324766;
    padding: 0.28rem 0.38rem;
    vertical-align: top;
  }
  .specialTable th {
    color: #d58a35;
    text-align: left;
    font-weight: 600;
    background: #0b1a32;
  }
  .specialActionCell {
    width: 1%;
    white-space: nowrap;
  }
  .overlay {
    position: fixed;
    inset: 0;
    background: rgba(4, 8, 20, 0.75);
    display: grid;
    place-items: center;
    z-index: 80;
    padding: 1rem;
  }
  .specialModal {
    width: min(64rem, 96vw);
    max-height: 80vh;
    overflow: auto;
    border: 1px solid #35548f;
    border-radius: 10px;
    padding: 0.7rem 0.8rem;
    background: linear-gradient(180deg, rgba(21, 29, 63, 0.97), rgba(15, 21, 48, 0.97));
  }
  .modalHead {
    display: flex;
    justify-content: space-between;
    align-items: center;
    margin-bottom: 0.45rem;
  }
  .modalHead h3 {
    margin: 0;
    color: #d58a35;
    font-size: 1rem;
  }
  .addTable {
    margin-top: 0.2rem;
  }
  .error {
    color: #ff8a7a;
  }
  .dim {
    opacity: 0.65;
  }

  @media (max-width: 1100px) {
    .topPanels.withIdentity,
    .topPanels:not(.withIdentity) {
      grid-template-columns: 1fr;
    }
    .identityPanel {
      grid-template-columns: 1fr;
    }
    .weaponHead,
    .weaponRow {
      grid-template-columns: 36px 54px minmax(140px, 1fr) 70px 66px 52px 52px minmax(170px, 1fr);
      font-size: 0.74rem;
    }
    .specialTable {
      font-size: 0.74rem;
    }
  }
</style>
