<script lang="ts">
  // Battle Lab: single-player balance-debug sandbox. Build fleets for BOTH
  // sides with every technology unlocked, run the deterministic combat sim,
  // and watch the replay. Pure client-side — touches no game state.
  import {
    ARMOR_MULT,
    COMPUTER_APPS,
    SHIELD_APPS,
    designStats,
    runBattle,
    specialSystemInfo,
    DEFAULT_ORDERS,
    HULLS_BUILDABLE,
    SPECIALS,
    type BattleInput,
    type BattleOrders,
    type CombatShipInit,
    type DesignStats,
    type Empire,
    type GameState,
  } from '@engine/index';
  import { rngFor } from '@engine/rng';
  import {
    ATTACK_TACTICS,
    DEFENSE_TACTICS,
    fightGroundRounds,
    generateTerrain,
    groundModifiers,
    type AttackTactic,
    type DefenseTactic,
  } from '@engine/groundTactics';
  import { SHIP_STYLES } from '@engine/index';
  import { appForWeapon, APPLICATION_ROWS, FIELD_ROWS, WEAPON_ROWS, hullById } from '@engine/data/index';
  import BattleViewer from '../battle/BattleViewer.svelte';
  import GroundBattleDialog from '../battle/GroundBattleDialog.svelte';
  import ShipPreview from '../battle/ShipPreview.svelte';
  import ShipLoadoutEditor from '../components/ShipLoadoutEditor.svelte';
  import {
    armorNameForTier,
    computerNameForTier,
    driveNameForTier,
    armorTierOptions,
    shieldNameForTier,
    weaponModTooltip,
  } from '../components/shipLoadoutShared';
  import { variantsFor, wrapVariant, type ArtClass } from '../battle/shipart';
  import { playerColor } from '../colors';
  import { takeLabSeed } from '../labSeed';
  import type { GroundBattleEntry, ReplayEntry } from '../state.svelte';

  // a laboratory empire that has researched absolutely everything
  function labEmpire(id: number): Empire {
    return {
      id,
      name: id === 0 ? 'Blue Lab' : 'Red Lab',
      raceName: 'laboratory',
      picks: [],
      government: 'dictatorship',
      bc: 0,
      freighters: 0,
      research: { fieldNum: null, targetApp: null, accumRP: 0, extraQueue: [], extraAccumRP: 0, hyperLevels: {} },
      knownApps: APPLICATION_ROWS.map((a) => a.id).sort(),
      completedFields: FIELD_ROWS.map((f) => f.num).sort((a, b) => a - b),
      exploredStars: [],
      designs: [],
      spies: { count: 0, target: null, mode: 'steal' },
      leaders: [],
      eliminated: false,
    };
  }
  // designStats/fitWeapon never read game state; a stub keeps the API happy
  const stubState = { settings: { modes: {} } } as unknown as GameState;
  const empires = [labEmpire(0), labEmpire(1)];

  interface LabGroup {
    hull: string;
    computer: number;
    shield: number;
    /** group armor tier 1..6 (titanium..xentronium) */
    armor: number;
    specials: string[];
    weapons: Array<{ weapon: string; count: number; mods: string[]; arc: 'F' | 'FX' | 'R' | '360' }>;
    count: number;
    /** cosmetic model variant within the side's ship style */
    model?: number;
  }
  interface LabSide {
    groups: LabGroup[];
    orders: BattleOrders;
    /** cosmetic fleet style for this side's sprites */
    style: string;
  }

  // every mountable weapon, bombs and strike craft included — filtering to
  // classId <= 2 left e.g. a design's nuclear-bomb slot BLANK when a real
  // battle was loaded into the lab (bugs.md)
  const weaponChoices = WEAPON_ROWS.filter((w) => w.techId !== 0).map((w) => ({
    ...w,
    label: appForWeapon(w.id)?.name ?? w.id.replaceAll('_', ' '),
  }));
  const armorOptions = armorTierOptions();
  const newGroup = (): LabGroup => ({
    hull: 'cruiser',
    computer: 3,
    shield: 3,
    armor: 3,
    specials: [],
    weapons: [{ weapon: 'laser_cannon', count: 4, mods: [], arc: 'F' }],
    count: 2,
  });

  // a live game can hand its ship types over (Empires tab -> battle simulator)
  const seeded = takeLabSeed();
  const seedGroups = (list: Array<Partial<LabGroup>> | undefined): LabGroup[] | null =>
    list && list.length
      ? list.map((g) => ({
          hull: g.hull ?? 'cruiser',
          computer: g.computer ?? 3,
          shield: g.shield ?? 3,
          armor: Math.max(1, Math.min(6, g.armor ?? 3)),
          specials: [...(g.specials ?? [])],
          weapons: (g.weapons ?? [{ weapon: 'laser_cannon', count: 4, mods: [], arc: 'F' }]).map((w) => ({ ...w, mods: [...w.mods] })),
          count: g.count ?? 2,
        }))
      : null;

  let sides = $state<[LabSide, LabSide]>([
    {
      groups: seedGroups(seeded?.a) ?? [newGroup()],
      orders: { ...DEFAULT_ORDERS, ...((seeded?.ordersA as Partial<BattleOrders> | undefined) ?? {}) },
      style: seeded?.styleA ?? 'raptor',
    },
    {
      groups: seedGroups(seeded?.d) ?? [newGroup()],
      orders: { ...DEFAULT_ORDERS, ...((seeded?.ordersD as Partial<BattleOrders> | undefined) ?? {}) },
      style: seeded?.styleD ?? 'lattice',
    },
  ]);
  const fromGame = seeded !== null;
  let seed = $state(seeded?.seed ?? 'battle-lab-0001');
  let viewing = $state<ReplayEntry | null>(null);
  let labSlewing = $state(false);
  let error = $state('');
  let editing = $state<{ side: 0 | 1; gi: number } | null>(null);

  function applyLabOverrides(stats: DesignStats, g: LabGroup): DesignStats {
    const out = { ...stats };
    const armorTier = Math.max(1, Math.min(6, g.armor));

    // designStats is computed with a max-tech lab empire (tier 6 drive/armor).
    // Keep drive behavior at max-tech and only rescale armor/structure.
    const bestArmorMult = ARMOR_MULT[5]!;
    const armorMult = ARMOR_MULT[armorTier - 1]!;
    out.armorHp = Math.max(1, Math.round((out.armorHp * armorMult) / bestArmorMult));
    out.structureHp = Math.max(1, Math.round((out.structureHp * armorMult) / bestArmorMult));
    return out;
  }

  function groupStats(side: 0 | 1, g: LabGroup): DesignStats | string {
    const base = designStats(stubState, empires[side]!, {
      name: 'lab',
      hull: g.hull,
      computer: g.computer,
      shield: g.shield,
      specials: g.specials,
      weapons: g.weapons,
    });
    return typeof base === 'string' ? base : applyLabOverrides(base, g);
  }

  function toCombat(side: 0 | 1, g: LabGroup, idx: number, n: number, style: string): CombatShipInit | string {
    const stats = groupStats(side, g);
    if (typeof stats === 'string') return stats;
    return {
      shipId: (side + 1) * 1000 + idx * 100 + n,
      side,
      hull: g.hull,
      hullIdx: (HULLS_BUILDABLE as readonly string[]).indexOf(g.hull) + 1,
      isBase: false,
      beamAttack: stats.beamAttack,
      beamDefense: stats.beamDefense,
      speed: stats.combatSpeed,
      armorHp: stats.armorHp,
      structureHp: stats.structureHp,
      shieldPool: stats.shieldPool,
      shieldFlat: stats.shieldFlat,
      weapons: stats.weapons.map((w) => ({
        weaponId: w.row.id,
        classId: w.row.classId,
        dmgMin: w.row.classId === 4 ? w.row.strategicDamage.min : w.row.tacticalDamage.min,
        dmgMax: w.row.classId === 4 ? w.row.strategicDamage.max : w.row.tacticalDamage.max,
        mods: [...new Set([...w.mods, ...w.row.naturalMods])],
        ammo: w.row.ammo,
        cooldown: 0,
        count: w.count,
        arc: w.arc,
      })),
      startingStructure: stats.structureHp,
      startingArmor: stats.armorHp,
      specials: g.specials,
      style,
      modelIdx: g.model ?? 0,
    };
  }

  function run() {
    error = '';
    // plain data only: the sim + structuredClone must never see $state proxies
    const snap = $state.snapshot(sides) as unknown as [LabSide, LabSide];
    const ships: CombatShipInit[] = [];
    for (const side of [0, 1] as const) {
      snap[side].groups.forEach((g, gi) => {
        for (let n = 0; n < Math.min(g.count, 12); n++) {
          const cs = toCombat(side, g, gi, n, snap[side].style);
          if (typeof cs === 'string') {
            error = `side ${side === 0 ? 'A' : 'B'} group ${gi + 1}: ${cs}`;
            return;
          }
          ships.push(cs);
        }
      });
    }
    if (error) return;
    if (!ships.some((s) => s.side === 0) || !ships.some((s) => s.side === 1)) {
      error = 'both sides need at least one ship';
      return;
    }
    const input: BattleInput = {
      battleId: `lab-${seed}`,
      seedLabel: [0, 'battle', `lab-${seed}`],
      attacker: 0,
      defender: 1,
      ships: ships.sort((a, b) => a.shipId - b.shipId),
      ordersA: { ...snap[0].orders },
      ordersD: { ...snap[1].orders },
      // sandbox slewing toggle: the sim honors it purely from the input
      ...(labSlewing ? { slewing: true } : {}),
      // lab battles fight the 0.24 set-piece patterns, same as live games
      patterns: true,
    };
    const padded = hexSeed(seed);
    const result = runBattle(structuredClone(input), rngFor(padded, ...input.seedLabel));
    viewing = {
      battleId: input.battleId,
      seed: padded,
      input,
      summary: {
        battleId: input.battleId,
        winner: result.winner === null ? null : result.winner === 0 ? 0 : 1,
        ticks: result.ticks,
        attackerDamagePct: result.attackerDamagePct,
        defenderDamagePct: result.defenderDamagePct,
      },
      turn: 0,
      watched: true,
    };
  }

  function addWeapon(g: LabGroup) {
    g.weapons = [...g.weapons, { weapon: weaponChoices[0]!.id, count: 1, mods: [], arc: 'F' }];
  }
  function toggleMod(g: LabGroup, wi: number, mod: string) {
    const w = g.weapons[wi]!;
    w.mods = w.mods.includes(mod) ? w.mods.filter((m) => m !== mod) : [...w.mods, mod];
    g.weapons = [...g.weapons];
  }
  function toggleSpecial(g: LabGroup, sp: string) {
    g.specials = g.specials.includes(sp) ? g.specials.filter((s) => s !== sp) : [...g.specials, sp];
  }
  const pretty = (id: string) => id.replaceAll('_', ' ');
  const maxHullSpace = (h: string) => hullById.get(h)?.space ?? 0;
  function clickField(ev: MouseEvent, value: number, lo: number, hi: number): number {
    const el = ev.currentTarget as HTMLElement;
    const r = el.getBoundingClientRect();
    const dir = ev.clientX - r.left < r.width / 2 ? -1 : 1;
    return Math.max(lo, Math.min(hi, value + dir));
  }
  function missileEvasionOf(g: LabGroup): number {
    if (g.specials.includes('multi_wave_ecm_jammer')) return 70;
    if (g.specials.includes('ecm_jammer') || g.specials.includes('wide_area_jammer')) return 40;
    return 0;
  }
  function openEditor(side: 0 | 1, gi: number) {
    editing = { side, gi };
  }
  function removeGroup(side: 0 | 1, gi: number) {
    sides[side].groups = sides[side].groups.filter((_, x) => x !== gi);
    if (editing?.side === side && editing.gi === gi) editing = null;
  }
  function groupSummary(g: LabGroup): string {
    const wep = g.weapons
      .slice(0, 3)
      .map((w) => `${w.count}x ${pretty(w.weapon)}`)
      .join(', ');
    const more = g.weapons.length > 3 ? ` +${g.weapons.length - 3} more` : '';
    return `${pretty(g.hull)} | comp ${g.computer} | shield ${g.shield} | ${wep}${more}`;
  }
  const specialName = (id: string) => specialSystemInfo(id).name;
  const specialDescription = (id: string) => specialSystemInfo(id).description;
  const specialSpacePct = (id: string) => specialSystemInfo(id).spacePct;

  // ---- 🪖 ground assault lab: run the REAL invasion math (terrain +
  // RPS tactics + the engine's round loop) on a hypothetical world, so you
  // can flip tactics and watch how the same battle swings. Deterministic:
  // same seed + same setup = same battle. ----
  const GROUND_CLIMATES = ['gaia', 'terran', 'ocean', 'swamp', 'arid', 'desert', 'tundra', 'barren', 'hostile', 'energized'] as const;
  const GROUND_NAMES: Record<string, string> = {
    gaia: 'Elysium Vale', terran: 'Harvest Home', ocean: 'Meridian Deep', swamp: 'Mirkfen',
    arid: 'Dustwall', desert: 'Kiln Reach', tundra: 'Whitefall', barren: 'Dome City Alpha',
    hostile: 'Cinderholm', energized: 'Stormglass',
  };
  let labGround = $state<GroundBattleEntry | null>(null);
  let gClimate = $state<(typeof GROUND_CLIMATES)[number]>('barren');
  let gWorld = $state(42); // terrain seed: every world always fights on ITS map
  let gAtkTactic = $state<AttackTactic>('charge');
  let gDefTactic = $state<DefenseTactic>('long_line');
  let gTroops = $state(20);
  let gGarrison = $state(6);
  let gMilitia = $state(8);
  let gMods = $state<{ atkMult: number; defMult: number } | null>(null);
  /** master seeds must be 32 hex chars: encode the free-text seed as hex */
  const hexSeed = (text: string): string =>
    [...text]
      .map((c) => c.charCodeAt(0).toString(16).padStart(2, '0'))
      .join('')
      .padEnd(32, '0')
      .slice(0, 32);
  function resolveGround() {
    const t0 = Math.max(1, Math.min(400, Math.round(gTroops)));
    const gar = Math.max(0, Math.min(100, Math.round(gGarrison)));
    const mil = Math.max(1, Math.min(400, Math.round(gMilitia)));
    const world = Math.max(0, Math.round(gWorld));
    const terrain = generateTerrain(world, gClimate);
    const mods = groundModifiers(gAtkTactic, gDefTactic, terrain);
    gMods = mods;
    // base unit strength 20 both sides (no race picks / barracks in the lab)
    const atkStr = Math.max(1, Math.round(20 * mods.atkMult));
    const defStr = Math.max(1, Math.round(20 * mods.defMult));
    const pop = Math.ceil(mil * 2); // militia = ceil(pop/2) in the engine
    const rng = rngFor(hexSeed(seed), 0, 'ground-lab', world);
    const res = fightGroundRounds(t0, gar, mil, atkStr, defStr, pop, rng);
    labGround = {
      turn: 0,
      watched: true,
      payload: {
        colonyId: world,
        colonyName: GROUND_NAMES[gClimate] ?? 'Firebase Ophion',
        starId: -1,
        attacker: 0,
        defender: 1,
        captured: res.troops > 0,
        civilianLosses: res.civilianLosses,
        startTroops: t0,
        startMilitia: gar + mil,
        startGarrison: gar,
        climate: gClimate,
        farming: ['gaia', 'terran', 'ocean', 'swamp'].includes(gClimate),
        rounds: res.rounds,
        terrain,
        atkTactic: gAtkTactic,
        defTactic: gDefTactic,
      },
    };
  }
</script>

<div class="lab">
  <header>
    <h2>⚗ Battle Lab</h2>
    <p class="dim">Balance sandbox — every tech unlocked, both fleets yours. Same seed + same fleets = same battle, every time.</p>
    {#if fromGame}
      <p class="dim" data-testid="lab-seeded">⚗ loaded from your game: side A = your designs, side B = enemy types you have met in battle. Edit freely — this sandbox never touches the real game.</p>
    {/if}
    <div class="runbar">
      <label>seed <input bind:value={seed} size="16" /></label>
      <label title="game option preview: F-arc ships may spend movement to rotate their guns onto off-axis targets (big hulls pay more); 360-arc mounts never need it">
        <input type="checkbox" data-testid="lab-slewing" bind:checked={labSlewing} /> slewing
      </label>
      <button class="primary" data-testid="lab-run" onclick={run}>▶ Run battle</button>
      {#if error}<span class="error">{error}</span>{/if}
      <a href="#top" onclick={(e) => { e.preventDefault(); location.hash = ''; }}>← back</a>
    </div>
    <div class="runbar groundbar" data-testid="lab-ground">
      <span title="the REAL invasion math: the planet's fixed terrain + the tactics matchup scale each side's strength, then the engine's round loop fights it out. Same seed + same setup = same battle — flip one tactic and compare.">🪖 ground assault lab</span>
      <label>world
        <select bind:value={gClimate} data-testid="lab-ground-climate">
          {#each GROUND_CLIMATES as c (c)}
            <option value={c}>{c}</option>
          {/each}
        </select>
      </label>
      <label title="terrain seed: every world always fights on its one fixed map">map # <input type="number" min="0" max="9999" bind:value={gWorld} data-testid="lab-ground-world" /></label>
      <label>⚔ tactic
        <select bind:value={gAtkTactic} data-testid="lab-ground-atk">
          {#each ATTACK_TACTICS as t (t)}
            <option value={t}>{pretty(t)}</option>
          {/each}
        </select>
      </label>
      <label>🛡 doctrine
        <select bind:value={gDefTactic} data-testid="lab-ground-def">
          {#each DEFENSE_TACTICS as t (t)}
            <option value={t}>{pretty(t)}</option>
          {/each}
        </select>
      </label>
      <label>marines <input type="number" min="1" max="400" bind:value={gTroops} /></label>
      <label>garrison <input type="number" min="0" max="100" bind:value={gGarrison} /></label>
      <label>militia <input type="number" min="1" max="400" bind:value={gMilitia} /></label>
      <button data-testid="lab-ground-run" onclick={resolveGround}>⚔ resolve invasion</button>
      {#if gMods}
        <span class="dim" data-testid="lab-ground-mods" title="strength multipliers from the tactics matchup + terrain fit">tactics: ⚔ ×{gMods.atkMult.toFixed(2)} vs 🛡 ×{gMods.defMult.toFixed(2)}</span>
      {/if}
    </div>
  </header>

  <div class="sides">
    {#each [0, 1] as const as side (side)}
      {@const s = sides[side]}
      <section class:red={side === 1}>
        <h3>{side === 0 ? '🔵 Side A — attacker' : '🔴 Side B — defender'}</h3>
        <div class="orders">
          <label>ship style
            <select bind:value={s.style} data-testid="lab-style-{side}">
              {#each SHIP_STYLES as st (st.id)}
                <option value={st.id}>{st.name}</option>
              {/each}
            </select>
          </label>
          <label>stance
            <select bind:value={s.orders.stance}>
              <option value="charge">charge</option>
              <option value="hold_range">hold range</option>
              <option value="standoff">standoff</option>
              <option value="formation">formation</option>
              <option value="passthrough">passthrough (raid)</option>
              <option value="evade_retreat">evade & retreat</option>
            </select>
          </label>
          <label title="fleet plan: line holds the heavies back as a wall; flank/pincer/envelop send the fast wing(s) wide LOGH-style">fleet plan
            <select data-testid="lab-formation-{side}" bind:value={s.orders.formation}>
              <option value={undefined}>massed (classic)</option>
              <option value="line">line — heavies hold</option>
              <option value="flank">flank — one wing wide</option>
              <option value="pincer">pincer — both wings</option>
              <option value="envelop">envelop — 3 groups</option>
            </select>
          </label>
          <label>targets
            <select bind:value={s.orders.priority}>
              <option value="nearest">nearest</option>
              <option value="biggest">biggest</option>
              <option value="smallest">smallest</option>
              <option value="warships">warships</option>
              <option value="bases">bases</option>
              <option value="deadliest">deadliest</option>
            </select>
          </label>
          <label>retreat &lt; {s.orders.retreatThresholdPct}%
            <input type="range" min="0" max="90" step="5" bind:value={s.orders.retreatThresholdPct} />
          </label>
        </div>
        {#each s.groups as g, gi (gi)}
          {@const st = groupStats(side, g)}
          <div class="group">
            <div class="row groupHead">
              <ShipPreview
                style={s.style}
                cls={g.hull as ArtClass}
                variant={g.model ?? 0}
                color={playerColor(side)}
                specials={[...g.specials]}
                heavyBeams={g.weapons.some((w) => w.mods.includes('hv'))}
                missileTubes={g.weapons.reduce((t, w) => t + ((weaponChoices.find((wc) => wc.id === w.weapon)?.classId ?? 0) === 1 ? w.count : 0), 0)}
                px={2}
              />
              <div class="groupMeta">
                <b>{groupSummary(g)}</b>
                <span class="dim">model {wrapVariant(g.hull as ArtClass, g.model ?? 0) + 1}/{variantsFor(g.hull as ArtClass)} · drive 6 · armor {g.armor} · weapons {g.weapons.length} · specials {g.specials.length}</span>
              </div>
              <label>armor
                <select bind:value={g.armor} title="group armor tier">
                  {#each armorOptions as o (o.tier)}
                    <option value={o.tier}>{o.label}</option>
                  {/each}
                </select>
              </label>
              <label>count <input type="number" min="1" max="12" bind:value={g.count} title="ships in this group" /></label>
              <button class="mini" data-testid="lab-edit-{side}-{gi}" onclick={() => openEditor(side, gi)}>Edit</button>
              <button class="mini" data-testid="clone-{side}-{gi}" title="clone this ship type" onclick={() => (s.groups = [...s.groups.slice(0, gi + 1), structuredClone($state.snapshot(g)) as typeof g, ...s.groups.slice(gi + 1)])}>⎘ clone</button>
              <button class="mini" onclick={() => removeGroup(side, gi)}>✕</button>
            </div>
            {#if typeof st === 'string'}
              <p class="error">{st}</p>
            {:else}
              <p class="stats">space {st.spaceUsed}/{st.spaceTotal} · atk +{st.beamAttack} · def +{st.beamDefense} · speed {st.combatSpeed} · armor {st.armorHp} · struct {st.structureHp} · shields {st.shieldPool}</p>
            {/if}
          </div>
        {/each}
        <button onclick={() => (s.groups = [...s.groups, newGroup()])}>+ add ship group</button>
      </section>
    {/each}
  </div>
</div>

{#if viewing}
  <BattleViewer replay={viewing} onclose={() => (viewing = null)} />
{/if}

{#if labGround}
  <GroundBattleDialog battle={labGround} onclose={() => (labGround = null)} />
{/if}

{#if editing}
  {@const s = sides[editing.side]}
  {@const g = s.groups[editing.gi]}
  {#if g}
    <div class="overlay" role="dialog" aria-label="Edit ship group">
      <div class="editorModal">
        <header class="modalHead">
          <h3>Edit Ship Group</h3>
          <button class="mini" onclick={() => (editing = null)}>Close</button>
        </header>
        <ShipLoadoutEditor
          driveName={driveNameForTier(6)}
          armorName={armorNameForTier(Math.max(1, Math.min(6, g.armor)))}
          shipStyle={s.style}
          shipClass={g.hull}
          shipVariant={g.model ?? 0}
          shipColor={playerColor(editing.side)}
          shipPx={2}
          previewSpecials={g.specials}
          previewHeavyBeams={g.weapons.some((w) => w.mods.includes('hv'))}
          previewMissileTubes={g.weapons.reduce((t, w) => t + ((weaponChoices.find((wc) => wc.id === w.weapon)?.classId ?? 0) === 1 ? w.count : 0), 0)}
          modelLabel={`model ${wrapVariant(g.hull as ArtClass, g.model ?? 0) + 1}/${variantsFor(g.hull as ArtClass)}`}
          canPrevModel={variantsFor(g.hull as ArtClass) >= 2}
          canNextModel={variantsFor(g.hull as ArtClass) >= 2}
          onPrevModel={() => (g.model = (wrapVariant(g.hull as ArtClass, g.model ?? 0) - 1 + variantsFor(g.hull as ArtClass)) % variantsFor(g.hull as ArtClass))}
          onNextModel={() => (g.model = (wrapVariant(g.hull as ArtClass, g.model ?? 0) + 1) % variantsFor(g.hull as ArtClass))}
          hullOptions={HULLS_BUILDABLE.map((h) => ({ id: h, label: `${h} (${maxHullSpace(h)} space)` }))}
          selectedHull={g.hull}
          hullSpace={maxHullSpace(g.hull)}
          hullSelectTestId="lab-hull"
          onSelectHull={(h) => (g.hull = h)}
          driveTier={6}
          armorTier={Math.max(1, Math.min(6, g.armor))}
          computerName={computerNameForTier(g.computer)}
          shieldName={shieldNameForTier(g.shield)}
          maxComputer={COMPUTER_APPS.length}
          maxShield={SHIELD_APPS.length}
          missileEvasion={missileEvasionOf(g)}
          stats={groupStats(editing.side, g)}
          availableSpecials={Object.keys(SPECIALS)}
          specials={g.specials}
          specialName={specialName}
          specialDescription={specialDescription}
          specialSpacePct={specialSpacePct}
          weapons={g.weapons}
          weaponChoices={weaponChoices}
          modTooltip={weaponModTooltip}
          onClickComputerField={(ev) => (g.computer = clickField(ev, g.computer, 0, COMPUTER_APPS.length))}
          onClickShieldField={(ev) => (g.shield = clickField(ev, g.shield, 0, SHIELD_APPS.length))}
          onToggleSpecial={(sp) => toggleSpecial(g, sp)}
          onToggleMod={(wi, mod) => toggleMod(g, wi, mod)}
          onAddWeapon={() => addWeapon(g)}
          onRemoveWeapon={(wi) => (g.weapons = g.weapons.filter((_, x) => x !== wi))}
        />
      </div>
    </div>
  {/if}
{/if}

<style>
  .lab {
    padding: 1rem 1.4rem;
    max-width: 90rem;
    margin: 0 auto;
  }
  h2 {
    color: var(--accent-soft);
    margin: 0.2rem 0;
  }
  .runbar {
    display: flex;
    gap: 0.8rem;
    align-items: center;
    margin: 0.6rem 0 1rem;
  }
  .groundbar {
    flex-wrap: wrap;
    font-size: 0.85rem;
    opacity: 0.95;
    margin-top: -0.4rem;
  }
  .groundbar input[type='number'] {
    width: 4.2rem;
  }
  .runbar .primary {
    background: linear-gradient(180deg, #1f6a38, #175028);
    border-color: var(--good);
    font-weight: 700;
  }
  .sides {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 1rem;
  }
  section {
    border: 1px solid var(--line-bright);
    border-radius: 10px;
    padding: 0.7rem 0.9rem;
    background: linear-gradient(180deg, color-mix(in srgb, var(--panel-2) 70%, transparent), color-mix(in srgb, var(--panel) 70%, transparent));
  }
  section.red {
    border-color: #8f4040;
  }
  .orders {
    display: flex;
    gap: 0.8rem;
    flex-wrap: wrap;
    margin-bottom: 0.6rem;
    font-size: 0.85rem;
  }
  .orders label {
    display: flex;
    flex-direction: column;
    gap: 0.15rem;
  }
  .group {
    border: 1px solid var(--line);
    border-radius: 8px;
    padding: 0.5rem 0.6rem;
    margin-bottom: 0.6rem;
  }
  .groupHead {
    align-items: flex-start;
  }
  .groupMeta {
    display: flex;
    flex-direction: column;
    gap: 0.15rem;
    min-width: 18rem;
    flex: 1;
  }
  .row {
    display: flex;
    gap: 0.4rem;
    align-items: center;
    flex-wrap: wrap;
    margin-bottom: 0.3rem;
  }
  .overlay {
    position: fixed;
    inset: 0;
    background: rgba(0, 0, 0, 0.75);
    display: grid;
    place-items: center;
    z-index: 60;
    padding: 1rem;
  }
  .editorModal {
    width: min(74rem, 96vw);
    max-height: 88vh;
    overflow: auto;
    border: 1px solid var(--line-bright);
    border-radius: 10px;
    padding: 0.8rem 0.9rem;
    background: linear-gradient(180deg, color-mix(in srgb, var(--panel-2) 96%, transparent), color-mix(in srgb, var(--panel) 96%, transparent));
  }
  .modalHead {
    display: flex;
    justify-content: space-between;
    align-items: center;
    margin-bottom: 0.5rem;
  }
  .modalHead h3 {
    margin: 0;
    color: var(--accent-soft);
  }
  .row input[type='number'] {
    width: 3.4rem;
  }
  .stats {
    font-size: 0.78rem;
    color: var(--text-dim);
    margin: 0.2rem 0 0;
  }
  .error {
    color: var(--bad);
    font-size: 0.85rem;
  }
  .dim {
    color: var(--text-dim);
  }
</style>
