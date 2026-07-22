// Fleet archetypes for the space-tactics Monte Carlo (bugs.md round 9).
//
// Each archetype is a WEAPON-SYSTEM IDENTITY expressed as a small fleet of
// CombatShipInit rosters: slow missile boats, fast carriers, nimble beam
// skirmishers, lumbering heavy-beam capitals, turret cruisers, point-defense
// escorts, shield walls, torpedo raiders, boarding shuttles. The simulator
// fights every archetype under every doctrine so we can ask the only question
// that matters: does the CHOSEN TACTIC change who wins, and does each weapon
// system have a tactic it genuinely prefers?
//
// Nothing here touches the engine — these are plain sim inputs. Deliberately
// front-arc heavy (the common case) with FX and 360 variants mixed in.
import { designDps, type CombatShipInit, type CombatWeapon, type WeaponArc } from '@engine/index';

export interface ArchetypeOpts {
  /** additive drive tweak applied to every hull (the drive-race sweep) */
  speedDelta?: number;
  /** scale the roster size (rounded, min 1) */
  sizePct?: number;
}

export interface Archetype {
  id: string;
  /** the one-line identity a player should be able to feel */
  identity: string;
  /** doctrines this fleet is DESIGNED to want (the sim checks we delivered) */
  wants: readonly string[];
  build(side: 0 | 1, opts?: ArchetypeOpts): CombatShipInit[];
}

// ---- weapon kit ----------------------------------------------------------

const beam = (
  weaponId: string,
  dmgMin: number,
  dmgMax: number,
  count: number,
  arc: WeaponArc,
  mods: string[] = [],
): CombatWeapon => ({ weaponId, classId: 0, dmgMin, dmgMax, mods, ammo: -1, cooldown: 0, count, arc });

const missile = (weaponId: string, dmg: number, count: number, ammo: number, mods: string[] = []): CombatWeapon => ({
  weaponId,
  classId: 1,
  dmgMin: dmg,
  dmgMax: dmg,
  mods,
  ammo,
  cooldown: 0,
  count,
  arc: 'F',
});

const torpedo = (weaponId: string, dmg: number, count: number, ammo: number): CombatWeapon => ({
  weaponId,
  classId: 2,
  dmgMin: dmg,
  dmgMax: dmg + 4,
  mods: [],
  ammo,
  cooldown: 0,
  count,
  arc: 'F',
});

/** fighter bay: strike craft fly out and hit with a strategic payload */
const bay = (weaponId: string, dmgMin: number, dmgMax: number, count: number, ammo: number): CombatWeapon => ({
  weaponId,
  classId: 4,
  dmgMin,
  dmgMax,
  mods: [],
  ammo,
  cooldown: 0,
  count,
  arc: '360',
});

/** assault shuttle: dmgMax <= 0 marks a boarding craft (cripples systems) */
const shuttle = (count: number, ammo: number): CombatWeapon => ({
  weaponId: 'assault_shuttle',
  classId: 4,
  dmgMin: 0,
  dmgMax: 0,
  mods: [],
  ammo,
  cooldown: 0,
  count,
  arc: '360',
});

const pd = (count: number): CombatWeapon => beam('point_defense', 1, 3, count, '360', ['pd']);
const amr = (count: number, ammo: number): CombatWeapon => ({
  weaponId: 'anti_missile_rocket',
  classId: 5,
  dmgMin: 0,
  dmgMax: 0,
  mods: [],
  ammo,
  cooldown: 0,
  count,
  arc: '360',
});

// ---- hull chassis --------------------------------------------------------

interface Chassis {
  hull: string;
  hullIdx: number;
  speed: number;
  structureHp: number;
  armorHp: number;
  beamAttack: number;
  beamDefense: number;
}

const CHASSIS: Record<string, Chassis> = {
  frigate: { hull: 'frigate', hullIdx: 1, speed: 11, structureHp: 16, armorHp: 8, beamAttack: 35, beamDefense: 40 },
  destroyer: { hull: 'destroyer', hullIdx: 2, speed: 9, structureHp: 30, armorHp: 16, beamAttack: 40, beamDefense: 30 },
  cruiser: { hull: 'cruiser', hullIdx: 3, speed: 7, structureHp: 60, armorHp: 32, beamAttack: 45, beamDefense: 20 },
  battleship: { hull: 'battleship', hullIdx: 4, speed: 5, structureHp: 120, armorHp: 64, beamAttack: 50, beamDefense: 10 },
  titan: { hull: 'titan', hullIdx: 5, speed: 4, structureHp: 260, armorHp: 130, beamAttack: 55, beamDefense: 0 },
};

interface ShipSpec {
  chassis: keyof typeof CHASSIS;
  n: number;
  weapons: CombatWeapon[];
  speed?: number;
  shieldPool?: number;
  shieldFlat?: number;
  specials?: string[];
}

/** ship ids: attacker 1.., defender 101.. (matches the engine's test fixtures) */
function roster(specs: ShipSpec[], side: 0 | 1, opts: ArchetypeOpts | undefined): CombatShipInit[] {
  const sizePct = opts?.sizePct ?? 100;
  const dSpeed = opts?.speedDelta ?? 0;
  const out: CombatShipInit[] = [];
  let id = side === 0 ? 1 : 101;
  for (const spec of specs) {
    const c = CHASSIS[spec.chassis]!;
    const n = Math.max(1, Math.round((spec.n * sizePct) / 100));
    for (let i = 0; i < n; i++) {
      out.push({
        shipId: id++,
        side,
        hull: c.hull,
        hullIdx: c.hullIdx,
        isBase: false,
        beamAttack: c.beamAttack,
        beamDefense: c.beamDefense,
        speed: Math.max(1, (spec.speed ?? c.speed) + dSpeed),
        armorHp: c.armorHp,
        structureHp: c.structureHp,
        shieldPool: spec.shieldPool ?? 0,
        shieldFlat: spec.shieldFlat ?? 0,
        weapons: spec.weapons.map((w) => ({ ...w, mods: [...w.mods] })),
        startingStructure: c.structureHp,
        startingArmor: c.armorHp,
        ...(spec.specials ? { specials: [...spec.specials] } : {}),
      });
    }
  }
  return out;
}

const arch = (
  id: string,
  identity: string,
  wants: readonly string[],
  specs: ShipSpec[],
): Archetype => ({
  id,
  identity,
  wants,
  build: (side, opts) => roster(specs, side, opts),
});

// ---- the archetypes ------------------------------------------------------

// Every roster is built to roughly 740 hull points and a comparable total
// throw-weight, so that inside a matchup the only thing left moving the
// result is the DOCTRINE. (Perfect parity is impossible and unnecessary —
// archetype imbalance is a constant offset inside a fixed matchup — but a
// 3:1 mismatch drowns the tactical signal entirely, so it is worth the
// tuning. The ARCHETYPE BALANCE table in the report keeps us honest.)
export const ARCHETYPES: readonly Archetype[] = [
  arch(
    'slow_missile',
    'lumbering missile boats — warheads ignore range falloff, hulls cannot run',
    ['standoff', 'line'],
    [
      { chassis: 'battleship', n: 3, weapons: [missile('merculite_missile', 9, 3, 7), pd(1)] },
      { chassis: 'cruiser', n: 2, weapons: [missile('nuclear_missile', 7, 2, 7), pd(1)] },
    ],
  ),
  arch(
    'fast_carrier',
    'fast fighter carriers — strike craft must be launched from close in',
    ['charge', 'envelop'],
    [
      { chassis: 'battleship', n: 3, speed: 8, weapons: [bay('interceptor_bay', 6, 10, 4, 14), pd(2)] },
      { chassis: 'destroyer', n: 4, speed: 11, weapons: [beam('laser_cannon', 2, 5, 2, 'F'), pd(1)] },
    ],
  ),
  arch(
    'beam_skirmisher',
    'nimble forward-beam frigates — every gun is a front arc, every hull turns fast',
    ['flank', 'pincer'],
    [
      { chassis: 'frigate', n: 14, weapons: [beam('fusion_beam', 2, 5, 1, 'F')] },
      { chassis: 'destroyer', n: 8, weapons: [beam('fusion_beam', 2, 5, 1, 'F')] },
    ],
  ),
  arch(
    'heavy_line',
    'lumbering heavy-mount capitals — enormous reach, cannot answer the helm',
    ['line', 'standoff'],
    [
      { chassis: 'titan', n: 1, weapons: [beam('graviton_beam', 5, 12, 3, 'F', ['hv'])] },
      { chassis: 'battleship', n: 2, weapons: [beam('graviton_beam', 4, 10, 2, 'F', ['hv'])] },
    ],
  ),
  arch(
    'turret_cruiser',
    'all-round turret cruisers — weaker guns that never care where the bow points',
    ['envelop', 'charge'],
    [
      { chassis: 'cruiser', n: 6, weapons: [beam('ion_pulse_cannon', 2, 5, 3, '360')] },
      { chassis: 'destroyer', n: 4, weapons: [beam('ion_pulse_cannon', 2, 4, 2, '360')] },
    ],
  ),
  arch(
    'fx_destroyer',
    'oblique-mount destroyers — 270° arcs that bear through most of a turn',
    ['pincer', 'flank'],
    [
      { chassis: 'destroyer', n: 10, weapons: [beam('fusion_beam', 2, 4, 2, 'FX')] },
      { chassis: 'cruiser', n: 3, weapons: [beam('fusion_beam', 2, 4, 2, 'FX')] },
    ],
  ),
  arch(
    'pd_escort',
    'interceptor screens — point defense and rockets that eat guided munitions',
    ['line', 'envelop'],
    [
      { chassis: 'cruiser', n: 4, weapons: [pd(2), amr(1, 8), beam('laser_cannon', 2, 5, 2, 'F')] },
      { chassis: 'destroyer', n: 8, weapons: [pd(1), amr(1, 6), beam('laser_cannon', 2, 5, 1, 'F')] },
    ],
  ),
  arch(
    'shield_wall',
    'shielded gun wall — flat deflection blunts every small hit',
    ['line', 'charge'],
    [
      {
        chassis: 'battleship',
        n: 4,
        weapons: [beam('fusion_beam', 2, 6, 2, 'F')],
        shieldPool: 14,
        shieldFlat: 1,
      },
    ],
  ),
  arch(
    'torpedo_raider',
    'fast torpedo boats — heavy warheads, thin hulls, short legs',
    ['charge', 'flank'],
    [
      { chassis: 'destroyer', n: 12, speed: 11, weapons: [torpedo('plasma_torpedo', 10, 1, 5)] },
      { chassis: 'frigate', n: 8, weapons: [torpedo('plasma_torpedo', 7, 1, 5)] },
    ],
  ),
  arch(
    'boarding_assault',
    'assault-shuttle boarders — marines that cripple systems, only from knife range',
    ['charge', 'envelop'],
    [
      { chassis: 'battleship', n: 4, speed: 7, weapons: [shuttle(3, 6), beam('laser_cannon', 2, 5, 1, 'F')] },
      { chassis: 'destroyer', n: 4, weapons: [beam('laser_cannon', 2, 5, 2, 'F'), pd(1)] },
    ],
  ),
];

export const ARCHETYPE_BY_ID = new Map(ARCHETYPES.map((a) => [a.id, a]));

/** crude fleet strength readout for the report: total HP x total DPS.
 * Not a balance guarantee — the sim compares DOCTRINES inside a fixed
 * matchup, where any archetype imbalance is a constant that cancels. */
export function fleetPower(ships: CombatShipInit[]): { hp: number; dps: number; power: number } {
  let hp = 0;
  let dps = 0;
  for (const s of ships) {
    hp += s.structureHp + s.armorHp + s.shieldPool;
    dps += designDps(s.weapons, s.beamAttack);
  }
  return { hp, dps, power: Math.round((hp * dps) / 1000) };
}
