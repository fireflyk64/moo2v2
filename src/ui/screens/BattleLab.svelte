<script lang="ts">
  // Battle Lab: single-player balance-debug sandbox. Build fleets for BOTH
  // sides with every technology unlocked, run the deterministic combat sim,
  // and watch the replay. Pure client-side — touches no game state.
  import {
    designStats,
    runBattle,
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
  import { APPLICATION_ROWS, FIELD_ROWS, WEAPON_ROWS, hullById } from '@engine/data/index';
  import BattleViewer from '../battle/BattleViewer.svelte';
  import type { ReplayEntry } from '../state.svelte';

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
    specials: string[];
    weapons: Array<{ weapon: string; count: number; mods: string[]; arc: 'F' | 'FX' | 'R' | '360' }>;
    count: number;
  }
  interface LabSide {
    groups: LabGroup[];
    orders: BattleOrders;
  }

  const weaponChoices = WEAPON_ROWS.filter((w) => w.techId !== 0 && w.classId <= 2);
  const newGroup = (): LabGroup => ({
    hull: 'cruiser',
    computer: 3,
    shield: 3,
    specials: [],
    weapons: [{ weapon: 'laser_cannon', count: 4, mods: [], arc: 'F' }],
    count: 2,
  });

  let sides = $state<[LabSide, LabSide]>([
    { groups: [newGroup()], orders: { ...DEFAULT_ORDERS } },
    { groups: [newGroup()], orders: { ...DEFAULT_ORDERS, stance: 'hold_range' } },
  ]);
  let seed = $state('battle-lab-0001');
  let viewing = $state<ReplayEntry | null>(null);
  let error = $state('');

  function groupStats(side: 0 | 1, g: LabGroup): DesignStats | string {
    return designStats(stubState, empires[side]!, {
      name: 'lab',
      hull: g.hull,
      computer: g.computer,
      shield: g.shield,
      specials: g.specials,
      weapons: g.weapons,
    });
  }

  function toCombat(side: 0 | 1, g: LabGroup, idx: number, n: number): CombatShipInit | string {
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
        dmgMin: w.row.tacticalDamage.min,
        dmgMax: w.row.tacticalDamage.max,
        mods: w.mods,
        ammo: w.row.ammo,
        cooldown: 0,
        count: w.count,
        arc: w.arc,
      })),
      startingStructure: stats.structureHp,
      startingArmor: stats.armorHp,
      specials: g.specials,
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
          const cs = toCombat(side, g, gi, n);
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
    };
    // master seeds must be 32 hex chars: encode the free-text seed as hex
    const padded = [...seed]
      .map((c) => c.charCodeAt(0).toString(16).padStart(2, '0'))
      .join('')
      .padEnd(32, '0')
      .slice(0, 32);
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
</script>

<div class="lab">
  <header>
    <h2>⚗ Battle Lab</h2>
    <p class="dim">Balance sandbox — every tech unlocked, both fleets yours. Same seed + same fleets = same battle, every time.</p>
    <div class="runbar">
      <label>seed <input bind:value={seed} size="16" /></label>
      <button class="primary" data-testid="lab-run" onclick={run}>▶ Run battle</button>
      {#if error}<span class="error">{error}</span>{/if}
      <a href="#top" onclick={(e) => { e.preventDefault(); location.hash = ''; }}>← back</a>
    </div>
  </header>

  <div class="sides">
    {#each [0, 1] as const as side (side)}
      {@const s = sides[side]}
      <section class:red={side === 1}>
        <h3>{side === 0 ? '🔵 Side A — attacker' : '🔴 Side B — defender'}</h3>
        <div class="orders">
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
          <label>targets
            <select bind:value={s.orders.priority}>
              <option value="nearest">nearest</option>
              <option value="biggest">biggest</option>
              <option value="smallest">smallest</option>
              <option value="warships">warships</option>
              <option value="bases">bases</option>
            </select>
          </label>
          <label>retreat &lt; {s.orders.retreatThresholdPct}%
            <input type="range" min="0" max="90" step="5" bind:value={s.orders.retreatThresholdPct} />
          </label>
        </div>
        {#each s.groups as g, gi (gi)}
          {@const st = groupStats(side, g)}
          <div class="group">
            <div class="row">
              <input type="number" min="1" max="12" bind:value={g.count} title="ships in this group" />×
              <select bind:value={g.hull}>
                {#each HULLS_BUILDABLE as h (h)}<option value={h}>{h} ({maxHullSpace(h)} space)</option>{/each}
              </select>
              <label>comp <input type="number" min="0" max="6" bind:value={g.computer} /></label>
              <label>shield <input type="number" min="0" max="7" bind:value={g.shield} /></label>
              <button class="mini" data-testid="clone-{side}-{gi}" title="clone this ship type" onclick={() => (s.groups = [...s.groups.slice(0, gi + 1), structuredClone($state.snapshot(g)) as typeof g, ...s.groups.slice(gi + 1)])}>⎘ clone</button>
              <button class="mini" onclick={() => (s.groups = s.groups.filter((_, x) => x !== gi))}>✕</button>
            </div>
            {#each g.weapons as w, wi (wi)}
              <div class="row weap">
                <select bind:value={w.weapon}>
                  {#each weaponChoices as wc (wc.id)}<option value={wc.id}>{pretty(wc.id)}</option>{/each}
                </select>
                <input type="number" min="1" max="40" bind:value={w.count} />
                <select bind:value={w.arc} title="firing arc: F forward 180° · FX 270° (+20% space) · R rear 180° (−10%) · 360 turret (+40%)">
                  <option value="F">F</option>
                  <option value="FX">FX</option>
                  <option value="R">R</option>
                  <option value="360">360</option>
                </select>
                {#each weaponChoices.find((wc) => wc.id === w.weapon)?.availableMods ?? [] as mod (mod)}
                  <label class="mod"><input type="checkbox" checked={w.mods.includes(mod)} onchange={() => toggleMod(g, wi, mod)} />{mod}</label>
                {/each}
                <button class="mini" onclick={() => (g.weapons = g.weapons.filter((_, x) => x !== wi))}>✕</button>
              </div>
            {/each}
            <div class="row">
              <button class="mini" onclick={() => addWeapon(g)}>+ weapon</button>
              <details>
                <summary>specials ({g.specials.length})</summary>
                <div class="specials">
                  {#each Object.keys(SPECIALS) as sp (sp)}
                    <label class="mod"><input type="checkbox" checked={g.specials.includes(sp)} onchange={() => toggleSpecial(g, sp)} />{pretty(sp)}</label>
                  {/each}
                </div>
              </details>
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
    border: 1px solid #35548f;
    border-radius: 10px;
    padding: 0.7rem 0.9rem;
    background: linear-gradient(180deg, rgba(21, 29, 63, 0.7), rgba(15, 21, 48, 0.7));
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
  .row {
    display: flex;
    gap: 0.4rem;
    align-items: center;
    flex-wrap: wrap;
    margin-bottom: 0.3rem;
  }
  .row input[type='number'] {
    width: 3.4rem;
  }
  .weap {
    margin-left: 0.6rem;
  }
  .mod {
    font-size: 0.75rem;
    display: inline-flex;
    gap: 0.15rem;
  }
  .specials {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(12rem, 1fr));
    gap: 0.15rem 0.6rem;
    padding: 0.3rem 0;
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
