// One-pass tactical combat (redesigned; deterministic; fixed-point integers).
//
// Field: 768x576 units (positions stored x256). 10 logical ticks/second, cap
// 400 ticks (~40s of playback). Range bands by pair distance:
//   short <= 96u (dmg 100%, hit +10), medium <= 224u (70%, +0),
//   long <= 448u (40%, -20); heavy mounts also fire out to 560u at long stats.
// The attacker enters at the left edge; a battle is one pass: it ends at the
// tick cap, when a side has no active ships, or when every surviving attacker
// has crossed the defender line or retreated. Survivors stay in the system,
// so sieges take multiple turns by design.

import { clamp, ceilDiv, roundDiv } from './imath';
import { idist } from './isqrt';
import type { Rng } from './rng';
import type { DesignStats } from './shipdesign';

export const FP = 256; // fixed-point scale
export const FIELD_W = 768 * FP;
export const FIELD_H = 576 * FP;
export const MAX_TICKS = 400;
/** master pace knob: percent of base rate-of-fire (tuned by the balance harness
 * to land equal-tech passes in the 20-40% fleet-damage envelope) */
export const COMBAT_PACE = 250;
/** A ship that survives this many ticks in evade_retreat warps out wherever it
 * stands (MOO2-style disengage countdown). Reaching a field edge still works
 * sooner; without this, ships flipped to retreat mid-brawl had to outrun the
 * whole enemy fleet stern-first and 0/34 probe retreaters ever escaped. */
export const RETREAT_WARP_TICKS = 25;

export type Stance = 'charge' | 'hold_range' | 'standoff' | 'evade_retreat' | 'formation' | 'passthrough';
export type TargetPriority = 'nearest' | 'biggest' | 'smallest' | 'warships' | 'bases' | 'deadliest';

/** Fleet formations (0.23.0): a per-side battle order that replaces the
 * massed movement policy of 'charge'/'hold_range' ships with deterministic
 * per-ship ROLES (see assignFormationRoles). evade_retreat, standoff,
 * passthrough and the warp-dissipater pinning rules are untouched. */
export type Formation = 'line' | 'flank' | 'pincer' | 'envelop';
/** hold = advance to weapon range and stand (the battle line);
 *  center = like hold at half speed (envelop's slow middle);
 *  wingA/wingB = swing wide to the top/bottom waypoint, then turn in. */
export type FormationRole = 'hold' | 'center' | 'wingA' | 'wingB';

/** Weapon firing arcs (relative to the ship's heading):
 *  F = forward 180°, FX = extended 270°, R = rear 180°, 360 = all around. */
export type WeaponArc = 'F' | 'FX' | 'R' | '360';

// ---- integer heading math: 32 compass directions, cos/sin scaled by 16384 ----
export const DIRS = 32;
const TRIG: ReadonlyArray<readonly [number, number]> = [
  [16384, 0], [16069, 3196], [15137, 6270], [13623, 9102], [11585, 11585], [9102, 13623], [6270, 15137], [3196, 16069],
  [0, 16384], [-3196, 16069], [-6270, 15137], [-9102, 13623], [-11585, 11585], [-13623, 9102], [-15137, 6270], [-16069, 3196],
  [-16384, 0], [-16069, -3196], [-15137, -6270], [-13623, -9102], [-11585, -11585], [-9102, -13623], [-6270, -15137], [-3196, -16069],
  [0, -16384], [3196, -16069], [6270, -15137], [9102, -13623], [11585, -11585], [13623, -9102], [15137, -6270], [16069, -3196],
];

/** heading (0..31) whose unit vector best matches (dx,dy) — integer argmax */
export function headingToward(dx: number, dy: number): number {
  let best = 0;
  let bestDot = -Infinity;
  for (let h = 0; h < DIRS; h++) {
    const dot = TRIG[h]![0] * dx + TRIG[h]![1] * dy;
    if (dot > bestDot) {
      bestDot = dot;
      best = h;
    }
  }
  return best;
}

/** signed shortest rotation from heading a to b, in [-16, 16) */
export function headingDelta(a: number, b: number): number {
  let d = (b - a) % DIRS;
  if (d > DIRS / 2) d -= DIRS;
  if (d < -DIRS / 2) d += DIRS;
  return d;
}

/** hull turn rate in headings/tick: small ships whip around, capitals lumber */
export function turnRateOf(hullIdx: number, isBase: boolean): number {
  if (isBase) return 2;
  if (hullIdx <= 2) return 4; // frigate, destroyer: 45°/tick
  if (hullIdx <= 3) return 3;
  if (hullIdx <= 4) return 2;
  return 1; // titan, doomstar
}

/** is a target bearing (0..31, relative to heading) inside the weapon's arc? */
export function inArc(arc: WeaponArc, headingToTarget: number, heading: number): boolean {
  if (arc === '360') return true;
  const d = Math.abs(headingDelta(heading, headingToTarget));
  if (arc === 'F') return d <= 8; // ±90°
  if (arc === 'FX') return d <= 12; // ±135°
  return d >= 8; // R: rear half ±90° around the tail
}

export interface BattleOrders {
  stance: Stance;
  priority: TargetPriority;
  /** fleet HP percent that flips survivors to evade_retreat */
  retreatThresholdPct: number;
  /** attacker only: bombard the colony after winning the pass */
  bombard: boolean;
  /** attacker only: land marine transports on the colony after winning the
   * pass. Invasion is a deliberate order — transports never auto-land after
   * a battle. Optional for wire/save compatibility; absent = false. */
  invade?: boolean;
  /** winner-side mercy: leave the loser's unarmed ships (colony/outpost
   * ships, transports) alive instead of capturing-and-scuttling them.
   * Optional for wire/save compatibility; absent = false (classic behavior). */
  spareNoncombatants?: boolean;
  /** WHERE the fight happens (0.22.0 engagement choice).
   * Attacker: planetId of a defender colony at the star to assault (that
   * colony's defenses join and take the bombardment/invasion), or null for a
   * deep-space fleet engagement away from any planet (no colony defenses, no
   * post-battle bombardment/landing).
   * Defender: only consulted when the attacker chose deep space — planetId
   * of an OWN colony to hold at (the battle then happens under its guns,
   * exactly like the classic behavior), or null to meet the fleet.
   * ABSENT = legacy semantics: the first defender colony's defenses join,
   * bombardment picks its classic target — old logs and timeout defaults
   * reproduce today's outcomes byte-for-byte. */
  engagePlanetId?: number | null;
  /** fleet FORMATION (0.23.0): line — the heaviest ~half walls up near its
   * own edge while the light half skirmishes forward; flank — the fastest
   * ~third swings wide around one (seeded) side; pincer — the fast wing
   * splits to BOTH sides; envelop — two wide wings plus a slow center try to
   * surround. ABSENT or null = classic single-mass behavior (old replays are
   * byte-exact). */
  formation?: Formation | null;
  /** attacker only: the ground tactic the landing force uses when `invade`
   * wins (groundTactics.ts ATTACK_TACTICS). Absent = standard assault. The
   * space sim never reads it — it rides the orders to landInvasion. */
  invadeTactic?: string;
}

export const DEFAULT_ORDERS: BattleOrders = {
  stance: 'charge',
  priority: 'nearest',
  retreatThresholdPct: 25,
  bombard: false,
};

export interface CombatWeapon {
  weaponId: string;
  classId: number; // 0 beam, 1 missile, 2 torpedo, 3 bomb
  dmgMin: number;
  dmgMax: number;
  mods: string[];
  ammo: number; // -1 unlimited
  cooldown: number; // ticks between shots
  count: number;
  /** firing arc relative to heading (absent = F; point defense is always 360) */
  arc?: WeaponArc;
}

export interface CombatShipInit {
  shipId: number; // GameState ship id (or synthetic for bases)
  side: 0 | 1; // 0 attacker, 1 defender
  hull: string;
  hullIdx: number; // 1..6 ships, 7..9 bases
  isBase: boolean;
  beamAttack: number;
  beamDefense: number;
  speed: number; // units/tick (0 for bases)
  armorHp: number;
  structureHp: number;
  shieldPool: number;
  shieldFlat: number;
  weapons: CombatWeapon[];
  /** structure carried over from previous battles (<= structureHp) */
  startingStructure: number;
  startingArmor: number;
  /** design specials with in-battle behavior (ecm, damper_field, ...) */
  specials?: string[];
  /** cosmetic: owning empire's fleet style id at battle time (shipstyles.ts).
   * Display-only — the sim never reads it. */
  style?: string;
  /** cosmetic: model variant within the style's hull class (viewer wraps by
   * the class's variant count). Display-only. */
  modelIdx?: number;
  /** cosmetic: overrides the art class ('scout' for designless scout hulls) */
  modelKind?: string;
}

export interface BattleInput {
  battleId: string;
  seedLabel: Array<string | number>;
  attacker: number; // empireId
  defender: number;
  /** the ENGAGED planet: where the fight happens (its colony's defenses are
   * in `ships`); null = deep space / no colony involved. Display-only for
   * the viewer backdrop — the sim itself never reads it. */
  planetId?: number | null;
  ships: CombatShipInit[];
  /** non-combat ships present at the star: display-only extras for the replay
   * viewer (they never enter the sim; the loser's are captured after the pass) */
  bystanders?: Array<{ shipId: number; side: 0 | 1; kind: string }>;
  ordersA: BattleOrders;
  ordersD: BattleOrders;
  /** SLEWING game option (0.23.0): when true, a ship whose forward-arc guns
   * do not bear on its target may rotate beyond its hull turn rate by
   * SPENDING movement (legacy sim; see runBattle's slew block for the exact
   * cost). Under `patterns` the option instead lets forward mounts FIRE in
   * off-axis pattern segments at a turn-rate-scaled cooldown penalty
   * (SLEW_FIRE_CD_PCT). Carried in the input so the replay viewer re-sims
   * identically; ABSENT or false = exact legacy behavior. */
  slewing?: boolean;
  /** SET-PIECE PATTERNS (0.24.0): when true the battle is a choreographed
   * rock-paper-scissors of doctrines instead of the free-movement sim — each
   * side's doctrine (doctrineOf) picks a matchup SCRIPT (matchupScript) whose
   * phases place every pattern-capable ship on parametric paths (wheels,
   * walls, pockets, nets); the geometry sets the range bands and which arcs
   * bear (patternInArc / fastForwardWindow). Lumbering ships (isLumbering)
   * and bases creep/stand instead, and their attackers orbit their rear arc.
   * Carried in the input so replays re-sim identically; ABSENT or false =
   * byte-exact 0.23 behavior. */
  patterns?: boolean;
}

export interface ShotEvent {
  tick: number;
  from: number;
  to: number;
  weaponId: string;
  classId: number;
  hit: boolean;
  dmg: number;
  /** this hit destroyed the target (viewer highlights the killing blow) */
  kill?: boolean;
  /** damage points soaked by the target's shield (viewer draws the fizzle) */
  sh?: number;
  /** point-defense intercepts (to === -1): field position of the downed
   * projectile, so the viewer can draw the tracer and the pop */
  ix?: number;
  iy?: number;
}

export interface BattleTickFrame {
  tick: number;
  ships: Array<{
    id: number;
    x: number;
    y: number;
    /** heading 0..31 (0 = +x): the sprite rotation */
    h: number;
    alive: boolean;
    retreated: boolean;
    crossed: boolean;
    structPct: number;
    shieldPct: number;
    /** knocked-out systems this tick: d(rive) c(omputer) s(hields) */
    sys: string;
  }>;
  shots: ShotEvent[];
  /** guided munitions in flight this tick (missiles classId 1, torpedoes 2,
   * strike craft 4). id is stable across ticks (launch order) so the viewer
   * can track headings and draw trails; w = weapon id; from = launcher. */
  projectiles: Array<{ id: number; x: number; y: number; classId: number; w: string; from: number }>;
  deaths: number[];
}

export interface ShipOutcome {
  shipId: number;
  side: 0 | 1;
  destroyed: boolean;
  retreated: boolean;
  crossed: boolean;
  structureLeft: number;
  armorLeft: number;
  structureMax: number;
}

export interface BattleResult {
  ticks: number;
  outcomes: ShipOutcome[];
  /** side that still has active (non-retreated) ships when the other doesn't; null = stalemate */
  winner: 0 | 1 | null;
  attackerDamagePct: number; // fleet HP lost by attacker
  defenderDamagePct: number;
}

interface Sim {
  init: CombatShipInit;
  x: number;
  y: number;
  /** facing, 0..31 (0 = +x toward the defender side) */
  heading: number;
  /** deployment row (formation keeps this lane) */
  homeY: number;
  alive: boolean;
  retreated: boolean;
  crossed: boolean;
  /** passthrough: this ship has punched past the enemy line */
  passedThrough: boolean;
  shield: number;
  shieldRegenAcc: number;
  armor: number;
  structure: number;
  targetIdx: number;
  cds: number[]; // cooldown per weapon slot
  ammo: number[];
  stance: Stance;
  priority: TargetPriority;
  specials: Set<string>;
  missileEvasion: number; // % chance an arriving missile/torpedo misses
  repairAcc: number; // automated repair unit accumulator
  /** transient system knockouts (battle-local; never persisted) */
  sysDrive: boolean;
  sysComputer: boolean;
  sysShield: boolean;
  /** consecutive ticks spent disengaging (evade_retreat warp-out countdown) */
  retreatTicks: number;
  /** formation role (0.23.0); null = classic massed movement */
  role: FormationRole | null;
  /** wing ships: waypoint reached (or engaged early) — now turning in */
  wingDone: boolean;
  /** mounts any non-360° gun (slewing is pointless for all-turret ships) */
  slews: boolean;
}

/** chance (%) that a structure hit knocks out a random ship system */
export const SYSTEM_KNOCKOUT_PCT = 20;

interface Projectile {
  from: number; // sim index
  targetIdx: number;
  x: number;
  y: number;
  dmg: number;
  speed: number; // units/tick
  classId: number;
  weaponId: string;
  hp: number;
  mods: string[];
}

const BAND_SHORT = 96 * FP;
const BAND_MED = 224 * FP;
const BAND_LONG = 448 * FP;
const BAND_HV = 560 * FP;

function bandOf(dist: number): 0 | 1 | 2 | 3 {
  if (dist <= BAND_SHORT) return 0;
  if (dist <= BAND_MED) return 1;
  if (dist <= BAND_LONG) return 2;
  return 3;
}

const BAND_DMG = [100, 70, 40, 40];
const BAND_HIT = [10, 0, -20, -20];

// ---- formation geometry (0.23.0) ----
/** wing waypoint: this far from the top/bottom field edge */
export const WING_EDGE_Y = 48 * FP;
/** wing waypoint X as % of field width, measured from the wing's own edge */
export const WING_X_PCT = 62;
/** line-holders advance only until their target is inside the medium band */
export const HOLD_ENGAGE = 224 * FP;
/** 'line' formation: the wall stands this far from the fleet's own edge */
export const LINE_WALL_X = 168 * FP;

/** Deterministic per-ship formation roles for one side. Bases and immobile
 * ships never get a role; ships without a role keep their ordered stance's
 * classic movement (the 'line' skirmishers deliberately stay role-less).
 * Ordering is stable: hull weight (hullIdx) / speed with shipId tiebreaks.
 * flankWing picks which side of the field a 'flank' wing swings around
 * (seeded by the caller). */
export function assignFormationRoles(
  ships: Array<{ shipId: number; hullIdx: number; speed: number; isBase: boolean }>,
  formation: Formation,
  flankWing: 'wingA' | 'wingB',
): Map<number, FormationRole> {
  const roles = new Map<number, FormationRole>();
  const mobile = ships.filter((s) => !s.isBase && s.speed > 0);
  const n = mobile.length;
  if (n === 0) return roles;
  if (formation === 'line') {
    // the heaviest ~half holds the wall; the light half skirmishes forward
    const byWeight = [...mobile].sort((a, b) => b.hullIdx - a.hullIdx || a.shipId - b.shipId);
    for (const s of byWeight.slice(0, Math.ceil(n / 2))) roles.set(s.shipId, 'hold');
    return roles;
  }
  // fastest first; lighter hulls break speed ties (they make better flankers)
  const bySpeed = [...mobile].sort((a, b) => b.speed - a.speed || a.hullIdx - b.hullIdx || a.shipId - b.shipId);
  const wingCount = Math.floor(n / 3); // the fastest ~third per wing
  if (formation === 'flank') {
    bySpeed.slice(0, wingCount).forEach((s) => roles.set(s.shipId, flankWing));
    for (const s of bySpeed.slice(wingCount)) roles.set(s.shipId, 'hold');
  } else if (formation === 'pincer') {
    bySpeed.slice(0, wingCount).forEach((s, i) => roles.set(s.shipId, i % 2 === 0 ? 'wingA' : 'wingB'));
    for (const s of bySpeed.slice(wingCount)) roles.set(s.shipId, 'hold');
  } else {
    // envelop: two fast wings wide + everything else a slow center
    for (const s of bySpeed.slice(0, wingCount)) roles.set(s.shipId, 'wingA');
    for (const s of bySpeed.slice(wingCount, wingCount * 2)) roles.set(s.shipId, 'wingB');
    for (const s of bySpeed.slice(wingCount * 2)) roles.set(s.shipId, 'center');
  }
  return roles;
}

// ---- set-piece pattern battles (0.24.0) ----
// Doctrine = the side's battle-order intent, collapsed to five flavors. The
// pair of doctrines picks a SCRIPT: a choreographed set of parametric paths
// every pattern-capable ship flies. Free movement is gone under `patterns`;
// what a doctrine buys is WHERE its ships stand (range band) and WHICH arcs
// bear during each segment of the dance.
export type Doctrine = 'charge' | 'line' | 'flank' | 'pincer' | 'envelop';
/** wheel: charge-vs-charge — both fleets close, then circle each other on one
 *  shared close-range wheel. split: charge vs any formed doctrine — the
 *  formed side herds the chargers into TWO pocket circles and stands around
 *  them at its preferred band. grand_wheel: envelop vs envelop — two nets
 *  with nothing inside collapse into one wide rotating wheel. maneuvers:
 *  every other formed pair — each side flies its own doctrine's choreography
 *  (walls pummel, wings sweep the corners, nets tighten). */
export type PatternScript = 'wheel' | 'split' | 'grand_wheel' | 'maneuvers';

/** A side's doctrine: an explicit formation order wins; otherwise stand-off
 * stances read as 'line' and every committed stance as 'charge'. */
export function doctrineOf(orders: BattleOrders): Doctrine {
  if (orders.formation) return orders.formation;
  return orders.stance === 'hold_range' || orders.stance === 'standoff' ? 'line' : 'charge';
}

export function matchupScript(a: Doctrine, d: Doctrine): PatternScript {
  if (a === 'charge' && d === 'charge') return 'wheel';
  if (a === 'charge' || d === 'charge') return 'split';
  if (a === 'envelop' && d === 'envelop') return 'grand_wheel';
  return 'maneuvers';
}

/** Lumbering ships sit the dance out: they creep at their own drives and
 * fire from wherever they are, and enemies choreograph around/behind them.
 * Mobility = combat speed + hull turn rate; big hulls with mostly-forward
 * armament lumber a step earlier (the classic slow all-F titan). */
export function isLumbering(s: {
  speed: number;
  hullIdx: number;
  isBase: boolean;
  weapons: Array<{ classId: number; mods: string[]; arc?: WeaponArc }>;
}): boolean {
  if (s.isBase || s.speed <= 0) return true;
  const mobility = s.speed + turnRateOf(s.hullIdx, false);
  if (mobility <= 6) return true;
  if (mobility <= 7 && s.hullIdx >= 4) {
    const armed = s.weapons.filter((w) => w.classId !== 3 && !w.mods.includes('pd'));
    const fwd = armed.filter((w) => (w.arc ?? 'F') === 'F');
    if (armed.length > 0 && fwd.length * 2 >= armed.length) return true;
  }
  return false;
}

/** Engine power buys forward shots: in pattern segments where a ship's F/FX
 * mounts do not bear, the mount may still fire during a deterministic window
 * whose duty cycle scales with combat speed (speed/16 of the off-axis ticks,
 * capped at 14/16 — even the hottest drives miss some segments). The pattern
 * SHAPE never changes; only which guns fire during which segment. */
export function fastForwardWindow(tick: number, shipId: number, speed: number): boolean {
  return (tick * 5 + shipId * 7) % 16 < clamp(speed, 0, 14);
}

/** Slewing under patterns: an off-axis F/FX mount outside its fast window may
 * still fire by wrenching the hull around — at a cooldown penalty scaled by
 * hull turn rate (frigates near-free, titans harsh). Keyed by turnRateOf. */
export const SLEW_FIRE_CD_PCT: Record<number, number> = { 4: 120, 3: 160, 2: 220, 1: 300 };

/** Doctrine fire discipline for DIRECT-FIRE mounts under patterns: the
 * highest range band (bandOf: 0 short, 1 medium, 2 long, 3 heavy-long) the
 * doctrine's pattern ships will fire guns in. 'line' pummels from anywhere —
 * the long bands are its monopoly; every other doctrine holds fire until
 * medium (their tactic IS closing). Guided munitions (missiles, torpedoes,
 * strike craft) are exempt — the classic run-in weapons — and so are
 * lumbering ships and bases, which fire from wherever they are. Rangemaster
 * counts a band closer here too, so fire-control tech opens up early. */
export const DOCTRINE_FIRE_BAND: Record<Doctrine, number> = { charge: 1, line: 3, flank: 1, pincer: 1, envelop: 1 };

/** Pattern-mode arc bearing: F counts only when the pattern genuinely points
 * the ship AT its target (±45°, half the free-sim F arc — abeam is not
 * pointing); FX covers the oblique segments (±135°); R the rear half; 360
 * everything. The free-mover semantics (inArc) are unchanged for legacy. */
export function patternInArc(arc: WeaponArc, headingToTarget: number, heading: number): boolean {
  if (arc === '360') return true;
  const d = Math.abs(headingDelta(heading, headingToTarget));
  if (arc === 'F') return d <= 4;
  if (arc === 'FX') return d <= 12;
  return d >= 8;
}

/** charge-vs-formed: the tick the formed side splits the chargers into the
 * two pockets (phase 1 before it is the massed rush at the wall — kept short
 * so the symmetric head-on closure never decides the battle by itself) */
export const PATTERN_SPLIT_TICK = 36;
/** pocket centers, in field units (y of the top and bottom pocket) */
export const PATTERN_POCKET_YS: readonly [number, number] = [158, 418];
/** line-vs-line: walls step from the long band down to medium at this tick */
export const PATTERN_LINE_STEP_TICK = 160;
/** maneuvers: wings are on station and pounce from this tick */
export const PATTERN_WING_TICK = 80;
/** charging melee: inside this range a charge-doctrine ship noses onto its
 * target freely (F/FX count as bearing) — under the enemy's guns is exactly
 * where a charger wants to be. Field units ×FP. */
export const PATTERN_MELEE = 48 * FP;

export interface PatternSlot {
  /** 0 = main body/wall/wheel, 1 = wingA/top pocket, 2 = wingB/bottom pocket,
   *  3 = envelopment ring */
  g: 0 | 1 | 2 | 3;
  /** index within the group / group size */
  i: number;
  n: number;
  /** index within the side's whole pattern roster / roster size */
  si: number;
  sn: number;
}

/** Deterministic pattern-group assignment for one side's pattern-capable
 * ships (caller filters out bases and lumbering hulls). Stable ordering:
 * shipId for halves and walls, speed-first (lighter hulls break ties) for
 * wings, mirroring assignFormationRoles. `wing` picks the flank doctrine's
 * side of the field (1 = top, 2 = bottom). */
export function assignPatternGroups(
  ships: Array<{ shipId: number; hullIdx: number; speed: number }>,
  doctrine: Doctrine,
  script: PatternScript,
  wing: 1 | 2,
): Map<number, PatternSlot> {
  const out = new Map<number, PatternSlot>();
  const byId = [...ships].sort((a, b) => a.shipId - b.shipId);
  const sn = byId.length;
  if (sn === 0) return out;
  const sideIdx = new Map(byId.map((s, k) => [s.shipId, k]));
  const put = (shipId: number, g: 0 | 1 | 2 | 3, i: number, n: number) =>
    out.set(shipId, { g, i, n, si: sideIdx.get(shipId)!, sn });
  if (script === 'wheel' || script === 'grand_wheel') {
    byId.forEach((s, k) => put(s.shipId, 0, k, sn));
    return out;
  }
  if (script === 'split') {
    // both the chargers and their captors split into a top and bottom half
    const half = Math.ceil(sn / 2);
    byId.forEach((s, k) => (k < half ? put(s.shipId, 1, k, half) : put(s.shipId, 2, k - half, sn - half)));
    return out;
  }
  // maneuvers: the side flies its own doctrine's choreography
  if (doctrine === 'line') {
    byId.forEach((s, k) => put(s.shipId, 0, k, sn));
    return out;
  }
  if (doctrine === 'envelop') {
    byId.forEach((s, k) => put(s.shipId, 3, k, sn));
    return out;
  }
  const bySpeed = [...byId].sort((a, b) => b.speed - a.speed || a.hullIdx - b.hullIdx || a.shipId - b.shipId);
  const wingCount = Math.floor(sn / 3);
  const groups: number[][] = [[], [], []]; // [main, wingA, wingB] shipIds
  bySpeed.forEach((s, k) => {
    if (k >= wingCount) groups[0]!.push(s.shipId);
    else if (doctrine === 'flank') groups[wing]!.push(s.shipId);
    else groups[k % 2 === 0 ? 1 : 2]!.push(s.shipId);
  });
  for (const [g, ids] of groups.entries()) {
    ids.sort((a, b) => a - b);
    ids.forEach((id, i) => put(id, g as 0 | 1 | 2, i, ids.length));
  }
  return out;
}

export function runBattle(
  input: BattleInput,
  rng: Rng,
  onFrame?: (frame: BattleTickFrame) => void,
): BattleResult {
  const sims: Sim[] = input.ships.map((init) => ({
    init,
    x: 0,
    y: 0,
    heading: init.side === 0 ? 0 : DIRS / 2, // face the enemy line
    homeY: 0,
    alive: true,
    retreated: false,
    crossed: false,
    passedThrough: false,
    shield: init.shieldPool,
    shieldRegenAcc: 0,
    armor: init.startingArmor,
    structure: init.startingStructure,
    targetIdx: -1,
    cds: init.weapons.map(() => 0),
    ammo: init.weapons.map((w) => (w.ammo < 0 ? -1 : w.ammo * w.count)),
    stance: init.side === 0 ? input.ordersA.stance : input.ordersD.stance,
    priority: init.side === 0 ? input.ordersA.priority : input.ordersD.priority,
    specials: new Set(init.specials ?? []),
    missileEvasion: 0,
    repairAcc: 0,
    sysDrive: false,
    sysComputer: false,
    sysShield: false,
    retreatTicks: 0,
    role: null,
    wingDone: false,
    slews: init.weapons.some((w) => w.classId !== 3 && !w.mods.includes('pd') && (w.arc ?? 'F') !== '360'),
  }));
  // ECM: personal jammers, plus fleet-wide wide-area jammers
  const fleetJam = [false, false];
  for (const s of sims) if (s.specials.has('wide_area_jammer')) fleetJam[s.init.side] = true;
  for (const s of sims) {
    let ev = 0;
    if (s.specials.has('ecm_jammer')) ev = 40;
    if (s.specials.has('multi_wave_ecm_jammer')) ev = 70;
    if (fleetJam[s.init.side]) ev = Math.max(ev, 40);
    s.missileEvasion = ev;
  }
  // warp dissipater pins the OTHER side on the field
  const noRetreat = [false, false];
  for (const s of sims) {
    if (s.specials.has('warp_dissipater')) noRetreat[1 - s.init.side] = true;
  }

  // deployment: attackers along left edge, defenders along right
  let ai = 0;
  let di = 0;
  const countA = sims.filter((s) => s.init.side === 0).length;
  const countD = sims.length - countA;
  for (const s of sims) {
    if (s.init.side === 0) {
      s.x = 24 * FP;
      s.y = Math.floor(((ai + 1) * FIELD_H) / (countA + 1));
      ai++;
    } else {
      s.x = s.init.isBase ? FIELD_W - 24 * FP : FIELD_W - 52 * FP;
      s.y = Math.floor(((di + 1) * FIELD_H) / (countD + 1));
      di++;
    }
    s.homeY = s.y;
  }

  const patterns = input.patterns === true;
  // --- formations (0.23.0): assign per-ship roles; one seeded coin decides
  // which side of the field a 'flank' wing swings around. Sides draw in fixed
  // order (attacker first) so replays reproduce; an absent/null formation
  // draws NOTHING from the rng — legacy inputs replay byte-exact. Pattern
  // battles (0.24.0) skip the roles AND the coin: choreography replaces them.
  const formations: ReadonlyArray<Formation | null> = [input.ordersA.formation ?? null, input.ordersD.formation ?? null];
  if (!patterns) {
    for (const side of [0, 1] as const) {
      const f = formations[side];
      if (!f) continue;
      const flankWing = f === 'flank' ? (rng.int(2) === 0 ? 'wingA' : 'wingB') : 'wingA';
      const roles = assignFormationRoles(
        sims
          .filter((s) => s.init.side === side)
          .map((s) => ({ shipId: s.init.shipId, hullIdx: s.init.hullIdx, speed: s.init.speed, isBase: s.init.isBase })),
        f,
        flankWing,
      );
      for (const s of sims) {
        if (s.init.side === side) s.role = roles.get(s.init.shipId) ?? null;
      }
    }
  }
  const slewing = input.slewing === true;

  // --- set-piece patterns (0.24.0): doctrines, script, groups, geometry ---
  const docs: readonly [Doctrine, Doctrine] = [doctrineOf(input.ordersA), doctrineOf(input.ordersD)];
  const script: PatternScript = matchupScript(docs[0], docs[1]);
  const lumber: boolean[] = sims.map((s) => isLumbering(s.init));
  const slots = new Map<number, PatternSlot>(); // sim index -> slot
  if (patterns) {
    for (const side of [0, 1] as const) {
      const roster = sims
        .map((s, idx) => ({ s, idx }))
        .filter(({ s, idx }) => s.init.side === side && !lumber[idx]);
      const groups = assignPatternGroups(
        roster.map(({ s }) => ({ shipId: s.init.shipId, hullIdx: s.init.hullIdx, speed: s.init.speed })),
        docs[side],
        script,
        side === 0 ? 1 : 2, // flank wings: attacker sweeps the top, defender the bottom
      );
      for (const { s, idx } of roster) {
        const slot = groups.get(s.init.shipId);
        if (slot) slots.set(idx, slot);
      }
    }
  }
  const norm32 = (a: number) => ((a % DIRS) + DIRS) % DIRS;
  const ringX = (cx: number, r: number, a: number) => cx + roundDiv(TRIG[norm32(a)]![0] * r, 16384);
  const ringY = (cy: number, r: number, a: number) => cy + roundDiv(TRIG[norm32(a)]![1] * r, 16384);
  /** map slot i of m onto [-span..+span] heading steps around an arc center */
  const arcOffset = (i: number, m: number, span: number) => (m > 1 ? roundDiv(span * (2 * i - (m - 1)), m - 1) : 0);
  const bowTo = (fromX: number, fromY: number, toX: number, toY: number, fallback: number) =>
    toX === fromX && toY === fromY ? fallback : headingToward(toX - fromX, toY - fromY);
  const clampAnchor = (x: number, y: number, h: number) => ({
    x: clamp(x, 12 * FP, FIELD_W - 12 * FP),
    y: clamp(y, 12 * FP, FIELD_H - 12 * FP),
    h: norm32(h),
  });
  // live centroids (per side), refreshed at the top of every tick
  const cent: Array<{ x: number; y: number }> = [
    { x: FIELD_W / 2, y: FIELD_H / 2 },
    { x: FIELD_W / 2, y: FIELD_H / 2 },
  ];

  const projectiles: Projectile[] = [];
  const initialHp = [0, 0];
  for (const s of sims) initialHp[s.init.side]! += s.structure + s.armor;

  const active = (s: Sim) => s.alive && !s.retreated && !s.crossed;

  // --- pattern choreography (0.24.0): parametric anchors per ship per tick.
  // All integer math on the 32-spoke TRIG table; no rng is ever drawn. ---
  const chargerSide: 0 | 1 = docs[0] === 'charge' ? 0 : 1; // meaningful under 'split' only
  const formedSide: 0 | 1 = chargerSide === 0 ? 1 : 0;
  const MIDX = FIELD_W / 2;
  const anchorOf = (s: Sim, si: number, tick: number): { x: number; y: number; h: number } => {
    const side = s.init.side;
    const foe = (1 - side) as 0 | 1;
    const fwd = side === 0 ? 1 : -1;
    const bow = side === 0 ? 0 : DIRS / 2;
    const target = s.targetIdx >= 0 ? sims[s.targetIdx] : undefined;
    // lumbering prey (incl. bases): choreograph around/behind it — the whole
    // group targeting it fans across its rear arc, out of its F guns. The fan
    // is anchored on the target's PREDICTED heading (it will keep grinding
    // its bow toward whoever it targets), so the orbiters lead the spin.
    if (target && active(target) && s.targetIdx >= 0 && lumber[s.targetIdx]) {
      let m = 0;
      let k = 0;
      for (let j = 0; j < sims.length; j++) {
        const o = sims[j]!;
        if (o.init.side !== side || !active(o) || o.stance === 'evade_retreat' || !slots.has(j) || o.targetIdx !== s.targetIdx) continue;
        if (j === si) k = m;
        m++;
      }
      const tRate = turnRateOf(target.init.hullIdx, target.init.isBase);
      const prey = target.targetIdx >= 0 ? sims[target.targetIdx] : undefined;
      let pred = target.heading;
      if (prey && active(prey)) {
        const wantT = headingToward(prey.x - target.x, prey.y - target.y);
        pred = norm32(target.heading + clamp(headingDelta(target.heading, wantT), -3 * tRate, 3 * tRate));
      }
      const rear = norm32(pred + DIRS / 2);
      const a = rear + arcOffset(k, m, 5); // ±56° around dead astern
      const R = (docs[side] === 'line' ? 140 : 65) * FP;
      const ax = ringX(target.x, R, a);
      const ay = ringY(target.y, R, a);
      return clampAnchor(ax, ay, bowTo(ax, ay, target.x, target.y, bow));
    }
    const slot = slots.get(si)!;
    if (script === 'wheel' || script === 'grand_wheel') {
      // charge-vs-charge: everyone joins one wheel that tightens to knife
      // range; envelop-vs-envelop: the same figure, wider and statelier
      const grand = script === 'grand_wheel';
      const r = (grand ? Math.max(110, 190 - tick) : Math.max(65, 160 - tick)) * FP;
      const a = (side === 0 ? Math.floor((32 * slot.i) / slot.n) : Math.floor((32 * slot.i + 16) / slot.n)) + Math.floor(tick / (grand ? 4 : 3));
      const ax = ringX(MIDX, r, a);
      const ay = ringY(FIELD_H / 2, r, a);
      return clampAnchor(ax, ay, a + 8); // tangent: the wheel actually turns
    }
    if (script === 'split') {
      const isCharger = side === chargerSide;
      const chargerFwd = chargerSide === 0 ? 1 : -1;
      if (tick < PATTERN_SPLIT_TICK) {
        if (isCharger) {
          // massed rush at the enemy's center of gravity
          const ax = cent[foe]!.x;
          const ay = clamp(cent[foe]!.y + (2 * slot.si - (slot.sn - 1)) * 10 * FP, 12 * FP, FIELD_H - 12 * FP);
          return clampAnchor(ax, ay, bowTo(s.x, s.y, ax, ay, bow));
        }
        // the formed side receives the rush as a medium-band wall
        return clampAnchor(MIDX - fwd * 105 * FP, Math.floor(((slot.si + 1) * FIELD_H) / (slot.sn + 1)), bow);
      }
      // phase 2: the chargers are herded into TWO pocket circles; the formed
      // side stands around each pocket at its doctrine's band. A triangle
      // wave surges the pockets out and back — against a line that keeps its
      // distance the chargers periodically lunge to knife range and recoil.
      const g = slot.g === 2 ? 1 : 0; // 0 = top pocket, 1 = bottom
      const ph = (tick - PATTERN_SPLIT_TICK) % 96;
      const tri = ph < 48 ? ph : 96 - ph; // 0..48
      const amp = docs[formedSide] === 'line' ? 60 : 18;
      const pcx = MIDX - chargerFwd * 30 * FP + chargerFwd * roundDiv(tri * amp, 48) * FP;
      const pcy = PATTERN_POCKET_YS[g]! * FP;
      if (isCharger) {
        const vsLine = docs[formedSide] === 'line';
        const r = Math.max(38, 5 * slot.n) * FP;
        const a = Math.floor((32 * slot.i) / slot.n) + Math.floor(tick / 2);
        if (tri >= 30 && vsLine && target && active(target)) {
          // surge peak against a stand-off wall: SLAM home — a strafing run
          // to the captor's rear quarter that ends point-blank under its
          // guns (the charging-melee rule), where the wall's strict forward
          // cones cannot answer. A closed-in net leaves no room to dive:
          // against flank/pincer/envelop the chargers only nose out below.
          const aBehind = norm32(target.heading + DIRS / 2 + (slot.i % 2 === 0 ? -4 : 4));
          const ax = ringX(target.x, 20 * FP, aBehind);
          const ay = ringY(target.y, 20 * FP, aBehind);
          return clampAnchor(ax, ay, bowTo(ax, ay, target.x, target.y, bow));
        }
        const ax = ringX(pcx, r, a);
        const ay = ringY(pcy, r, a);
        if (tri >= 34 && target && active(target)) {
          // lesser surge: stay on the wheel but nose out at the captors
          return clampAnchor(ax, ay, bowTo(ax, ay, target.x, target.y, bow));
        }
        return clampAnchor(ax, ay, a + 8);
      }
      const doc = docs[side];
      const baseA = side === 0 ? DIRS / 2 : 0; // between the pocket and our own edge
      let a: number;
      let R: number;
      if (doc === 'envelop') {
        R = 100 * FP; // full ring: every bow bears — envelop punishes charge
        a = Math.floor((32 * slot.i) / slot.n) + Math.floor(tick / 4);
      } else if (doc === 'pincer') {
        R = 100 * FP; // the arms pinch each pocket from above/below
        a = (g === 0 ? 24 : 8) + arcOffset(slot.i, slot.n, 8);
      } else if (doc === 'flank') {
        R = 100 * FP; // a wide crescent rolled around the pocket's shoulder
        a = baseA + (g === 0 ? -5 : 5) + arcOffset(slot.i, slot.n, 10);
      } else {
        R = 170 * FP; // line: hold the medium band; only surges close it
        a = baseA + arcOffset(slot.i, slot.n, 6);
      }
      const ax = ringX(pcx, R, a);
      const ay = ringY(pcy, R, a);
      return clampAnchor(ax, ay, bowTo(ax, ay, pcx, pcy, bow));
    }
    // maneuvers: each side flies its own doctrine's figure
    const doc = docs[side];
    if (doc === 'envelop') {
      const R = Math.max(100, 230 - Math.floor((3 * tick) / 4)) * FP; // the net closes
      const a = Math.floor((32 * slot.i) / slot.n) + Math.floor(tick / 4);
      const ax = ringX(cent[foe]!.x, R, a);
      const ay = ringY(cent[foe]!.y, R, a);
      return clampAnchor(ax, ay, bowTo(ax, ay, cent[foe]!.x, cent[foe]!.y, bow));
    }
    if (slot.g === 1 || slot.g === 2) {
      // wing: sprint the wide corner first, then pounce the enemy mass from
      // above/below at knife range — where its walls' F guns do not bear
      if (tick < PATTERN_WING_TICK) {
        return clampAnchor(MIDX + fwd * 140 * FP, (slot.g === 1 ? 40 : 536) * FP, bow);
      }
      const a = (slot.g === 1 ? 24 : 8) + arcOffset(slot.i, slot.n, 4);
      const ax = ringX(cent[foe]!.x, 100 * FP, a);
      const ay = ringY(cent[foe]!.y, 100 * FP, a);
      return clampAnchor(ax, ay, bowTo(ax, ay, cent[foe]!.x, cent[foe]!.y, bow));
    }
    // wall: line pummels from the long band then steps in; flank and pincer
    // mains stand a band closer to fix the enemy for their wings. Phase-2
    // walls stand 105u out so any two walls sit 210u apart — inside the
    // medium band, where every doctrine's guns are cleared to speak.
    const dist = doc === 'line' ? (tick < PATTERN_LINE_STEP_TICK ? 190 : 105) : tick < PATTERN_WING_TICK ? 170 : 105;
    return clampAnchor(MIDX - fwd * dist * FP, Math.floor(((slot.i + 1) * FIELD_H) / (slot.n + 1)), bow);
  };
  /** physical (turn-rate-limited) steering for the ships that sit the dance
   * out: lumbering hulls creeping in and evaders running for the edge */
  const physTurn = (s: Sim, tx: number, ty: number): number => {
    const want = headingToward(tx - s.x, ty - s.y);
    const delta = headingDelta(s.heading, want);
    const rate = turnRateOf(s.init.hullIdx, s.init.isBase);
    if (delta !== 0) s.heading = norm32(s.heading + clamp(delta, -rate, rate));
    return Math.abs(headingDelta(s.heading, want));
  };
  const physMove = (s: Sim, tx: number, ty: number, stopAt: number, speedFP: number, turnThisTick = true) => {
    const off = turnThisTick
      ? physTurn(s, tx, ty)
      : Math.abs(headingDelta(s.heading, headingToward(tx - s.x, ty - s.y)));
    const d = Math.max(1, idist(Math.abs(tx - s.x), Math.abs(ty - s.y)));
    let travel = Math.min(speedFP, Math.max(0, d - stopAt));
    if (off > 8) travel = 0;
    else if (off > 4) travel = Math.floor(travel / 2);
    if (travel > 0) {
      s.x += roundDiv(TRIG[s.heading]![0] * travel, 16384);
      s.y = clamp(s.y + roundDiv(TRIG[s.heading]![1] * travel, 16384), 8 * FP, FIELD_H - 8 * FP);
    }
  };
  const movePattern = (s: Sim, si: number, tick: number) => {
    if (s.init.speed === 0 || s.sysDrive) return;
    const crippled = s.structure * 3 < s.init.structureHp;
    const speedFP = Math.max(1, crippled ? Math.floor(s.init.speed / 2) : s.init.speed) * FP;
    const target = s.targetIdx >= 0 ? sims[s.targetIdx] : undefined;
    if (s.stance === 'evade_retreat') {
      if (noRetreat[s.init.side]) {
        // pinned by a dissipater: stand and fight, bow on target (legacy rule)
        if (target && active(target)) physTurn(s, target.x, target.y);
        return;
      }
      const dl = s.x;
      const dr = FIELD_W - s.x;
      const dt = s.y;
      const db = FIELD_H - s.y;
      const m = Math.min(dl, dr, dt, db);
      if (m === dl) physMove(s, s.x - FIELD_W, s.y, 0, speedFP);
      else if (m === dr) physMove(s, s.x + FIELD_W, s.y, 0, speedFP);
      else if (m === dt) physMove(s, s.x, s.y - FIELD_H, 0, speedFP);
      else physMove(s, s.x, s.y + FIELD_H, 0, speedFP);
      if (s.x <= 4 * FP || s.x >= FIELD_W - 4 * FP || s.y <= 9 * FP || s.y >= FIELD_H - 9 * FP) s.retreated = true;
      s.x = clamp(s.x, 2 * FP, FIELD_W - 2 * FP);
      return;
    }
    if (!slots.has(si)) {
      // lumbering: creep in at its own drives and fire from wherever it is —
      // and lumber the helm too (it answers only every OTHER tick), so
      // nimble attackers genuinely can live in its baffles
      if (target && active(target)) physMove(s, target.x, target.y, 30 * FP, speedFP, tick % 2 === 0);
      else physMove(s, s.x + (s.init.side === 0 ? FIELD_W : -FIELD_W), s.y, 0, speedFP, tick % 2 === 0);
      s.x = clamp(s.x, 2 * FP, FIELD_W - 2 * FP);
      return;
    }
    const a = anchorOf(s, si, tick);
    const dx = a.x - s.x;
    const dy = a.y - s.y;
    const d = idist(Math.abs(dx), Math.abs(dy));
    if (d <= speedFP) {
      s.x = a.x;
      s.y = a.y;
      s.heading = a.h;
    } else {
      s.heading = headingToward(dx, dy);
      s.x += roundDiv(TRIG[s.heading]![0] * speedFP, 16384);
      s.y = clamp(s.y + roundDiv(TRIG[s.heading]![1] * speedFP, 16384), 8 * FP, FIELD_H - 8 * FP);
    }
    s.x = clamp(s.x, 2 * FP, FIELD_W - 2 * FP);
  };
  /** pattern-mode mount eligibility: geometry first (patternInArc against the
   * choreographed heading), then the speed-scaled forward window, then — with
   * the slewing option on — a wrenched off-axis shot at a cooldown penalty */
  const patternMountOk = (s: Sim, w: CombatWeapon, bearing: number, tick: number, dist: number): 'in' | 'fast' | 'slew' | null => {
    const arc = w.arc ?? 'F';
    if (patternInArc(arc, bearing, s.heading)) return 'in';
    if (arc === '360' || arc === 'R') return null;
    if (s.init.isBase || s.init.speed <= 0) return null;
    // charging melee: point-blank, the charger's guns are simply ON you
    if (docs[s.init.side] === 'charge' && dist <= PATTERN_MELEE) return 'in';
    if (fastForwardWindow(tick, s.init.shipId, s.init.speed)) return 'fast';
    if (slewing && s.slews) return 'slew';
    return null;
  };

  let tick = 0;
  for (tick = 0; tick < MAX_TICKS; tick++) {
    const frameShots: ShotEvent[] = [];
    const frameDeaths: number[] = [];

    // --- pattern centroids: the enemy mass the nets and wings key on ---
    if (patterns) {
      for (const side of [0, 1] as const) {
        let n = 0;
        let sx = 0;
        let sy = 0;
        for (const s of sims) {
          if (s.init.side === side && active(s)) {
            n++;
            sx += s.x;
            sy += s.y;
          }
        }
        if (n > 0) cent[side] = { x: Math.floor(sx / n), y: Math.floor(sy / n) };
      }
    }

    // --- retreat thresholds ---
    for (const side of [0, 1] as const) {
      const orders = side === 0 ? input.ordersA : input.ordersD;
      let hp = 0;
      for (const s of sims) if (s.init.side === side && s.alive) hp += s.structure + s.armor;
      if (initialHp[side]! > 0 && hp * 100 < initialHp[side]! * orders.retreatThresholdPct) {
        for (const s of sims) {
          // a warp-dissipater-pinned side cannot leave: flipping to
          // evade_retreat just made ships grind the field edge until dead —
          // pinned means keep fighting
          if (s.init.side === side && active(s) && !s.init.isBase && !noRetreat[side]) s.stance = 'evade_retreat';
        }
      }
    }

    // --- targeting ---
    for (const s of sims) {
      if (!active(s)) continue;
      const t = sims[s.targetIdx];
      if (s.targetIdx >= 0 && t && active(t)) continue;
      s.targetIdx = pickTarget(sims, s);
    }

    // --- passthrough cohesion: once EVERY raider has punched past the enemy
    // line, the whole group wheels around and withdraws together (legacy sim
    // only — under patterns 'passthrough' reads as the charge doctrine) ---
    if (!patterns) for (const side of [0, 1] as const) {
      const raiders = sims.filter((s) => s.init.side === side && s.stance === 'passthrough' && active(s));
      if (!raiders.length) continue;
      const enemies = sims.filter((s) => s.init.side !== side && active(s));
      const lineX = enemies.length
        ? side === 0
          ? Math.max(...enemies.map((e) => e.x))
          : Math.min(...enemies.map((e) => e.x))
        : side === 0
          ? FIELD_W
          : 0;
      for (const s of raiders) {
        if (side === 0 ? s.x > lineX + 20 * FP : s.x < lineX - 20 * FP) s.passedThrough = true;
      }
      if (raiders.every((s) => s.passedThrough)) {
        for (const s of raiders) s.stance = 'evade_retreat'; // cohesive withdrawal
      }
    }

    // --- formation pacing: the line advances at the slowest member's speed ---
    const formationSpeed: number[] = [0, 0];
    if (!patterns) for (const side of [0, 1] as const) {
      const line = sims.filter((s) => s.init.side === side && s.stance === 'formation' && active(s) && !s.init.isBase);
      if (line.length) {
        formationSpeed[side] = Math.min(...line.map((s) => (s.sysDrive ? 0 : Math.max(1, s.init.speed))));
      }
    }

    // --- movement (patterns): every pattern-capable ship chases its
    // choreographed anchor; lumbering hulls creep, evaders run for the edge ---
    if (patterns) {
      for (let si = 0; si < sims.length; si++) {
        const s = sims[si]!;
        if (!active(s)) continue;
        movePattern(s, si, tick);
      }
    }
    // --- movement (legacy): turn toward the desired course (hull turn rate),
    // then move along the current heading — capitals answer the helm slowly ---
    else for (const s of sims) {
      if (!active(s) || s.init.speed === 0 || s.sysDrive) continue;
      const crippled = s.structure * 3 < s.init.structureHp;
      let speed = Math.max(1, crippled ? Math.floor(s.init.speed / 2) : s.init.speed) * FP;
      const dir = s.init.side === 0 ? 1 : -1;
      const target = s.targetIdx >= 0 ? sims[s.targetIdx] : undefined;
      let desiredX = 0;
      let desiredY = 0;
      let travel = speed;
      const BRAWL = 30 * FP; // charge closes to point-blank and holds, no overshoot
      const steer = (tx: number, ty: number, sign: 1 | -1, stopAt = 0) => {
        const ddx = (tx - s.x) * sign;
        const ddy = (ty - s.y) * sign;
        const d = Math.max(1, idist(Math.abs(tx - s.x), Math.abs(ty - s.y)));
        desiredX = ddx;
        desiredY = ddy;
        travel = sign === 1 ? Math.min(speed, Math.max(0, d - stopAt)) : speed;
      };
      // back away from (tx,ty) without grinding into a wall: when the field
      // edge blocks the line of withdrawal, strafe ALONG the edge; when
      // cornered, punch out toward open field. Shared by standoff AND
      // formation — the fix originally went into standoff only and formation
      // lines kept parking themselves in corners.
      const backAwayFrom = (tx: number, ty: number) => {
        const nearLeft = s.x <= 40 * FP && tx > s.x;
        const nearRight = s.x >= FIELD_W - 40 * FP && tx < s.x;
        const nearTop = s.y <= 40 * FP && ty > s.y;
        const nearBottom = s.y >= FIELD_H - 40 * FP && ty < s.y;
        const inCorner = (s.x <= 40 * FP || s.x >= FIELD_W - 40 * FP) && (s.y <= 40 * FP || s.y >= FIELD_H - 40 * FP);
        if (inCorner) {
          // cornered: the old strafe pointed BACK INTO the corner and ships
          // parked there forever — punch out toward open field
          steer(FIELD_W / 2, FIELD_H / 2, 1);
        } else if (nearLeft || nearRight) {
          // strafe vertically toward the side with more room
          steer(s.x, s.y <= FIELD_H / 2 ? s.y + FIELD_H : s.y - FIELD_H, 1);
        } else if (nearTop || nearBottom) {
          steer(s.x <= FIELD_W / 2 ? s.x + FIELD_W : s.x - FIELD_W, s.y, 1);
        } else {
          steer(tx, ty, -1);
        }
      };
      // FORMATION role movement (0.23.0): replaces the massed movement of
      // charge/hold_range ships only. Any other stance — evade_retreat after
      // the threshold flip, standoff, passthrough, the classic 'formation'
      // line — keeps its exact legacy behavior; retreat and warp-dissipater
      // pinning rules are untouched.
      const role = formations[s.init.side] !== null && (s.stance === 'charge' || s.stance === 'hold_range') ? s.role : null;
      if (role === 'hold' || role === 'center') {
        // battle line: advance in lane only to weapon range, then stand fast
        // and swing the bow on target. 'line' walls up near its own edge and
        // never advances past the wall; envelop's center advances at half
        // speed so the wings have time to get around.
        const wallStop =
          formations[s.init.side] === 'line' &&
          (s.init.side === 0 ? s.x >= LINE_WALL_X : s.x <= FIELD_W - LINE_WALL_X);
        const nearest = target && active(target) ? idist(Math.abs(target.x - s.x), Math.abs(target.y - s.y)) : Infinity;
        if (nearest > HOLD_ENGAGE && !wallStop) {
          steer(s.x + dir * FIELD_W, s.homeY, 1); // advance in lane
          if (role === 'center') travel = Math.floor(travel / 2);
        } else if (target && active(target)) {
          desiredX = target.x - s.x; // hold the line, bow on target
          desiredY = target.y - s.y;
          travel = 0;
        } else travel = 0;
      } else if (role === 'wingA' || role === 'wingB') {
        // wing: run wide to the side waypoint first, then turn in and attack
        // from the flank (charge movement once committed)
        if (!s.wingDone) {
          const wx = s.init.side === 0 ? roundDiv(FIELD_W * WING_X_PCT, 100) : FIELD_W - roundDiv(FIELD_W * WING_X_PCT, 100);
          const wy = role === 'wingA' ? WING_EDGE_Y : FIELD_H - WING_EDGE_Y;
          const dWp = idist(Math.abs(wx - s.x), Math.abs(wy - s.y));
          const bounced = target && active(target) && idist(Math.abs(target.x - s.x), Math.abs(target.y - s.y)) <= 150 * FP;
          if (dWp <= 32 * FP || bounced) s.wingDone = true; // arrived (or intercepted en route)
          else steer(wx, wy, 1);
        }
        if (s.wingDone) {
          if (target && active(target)) steer(target.x, target.y, 1, BRAWL);
          else steer(s.x + dir * FIELD_W, s.y, 1);
        }
      } else switch (s.stance) {
        case 'charge':
          if (target && active(target)) steer(target.x, target.y, 1, BRAWL);
          else steer(s.x + dir * FIELD_W, s.y, 1);
          break;
        case 'passthrough':
          // raiders punch THROUGH the line: run the target's lane to the far
          // side (guns fire on the way past), never stopping to brawl
          if (target && active(target) && !s.passedThrough) steer(s.x + dir * FIELD_W, target.y, 1);
          else steer(s.x + dir * FIELD_W, s.homeY, 1);
          break;
        case 'formation': {
          speed = Math.max(1, formationSpeed[s.init.side]!) * FP;
          travel = speed;
          const nearest = target && active(target) ? idist(Math.abs(target.x - s.x), Math.abs(target.y - s.y)) : Infinity;
          if (nearest > 210 * FP) steer(s.x + dir * FIELD_W, s.homeY, 1); // advance in lane
          else if (nearest < 140 * FP && target) backAwayFrom(target.x, target.y);
          else travel = 0; // hold the line and fire
          break;
        }
        case 'hold_range': {
          // HOLD POSITION (renamed in the UI): stand fast and swing the bow
          // onto the target so the forward arcs bear — the old "keep 150-200u"
          // behavior made ships literally turn tail and grind into the field
          // edge whenever the enemy closed (bugs.md)
          if (target && active(target)) {
            desiredX = target.x - s.x;
            desiredY = target.y - s.y;
            travel = 0;
          } else travel = 0;
          break;
        }
        case 'standoff': {
          if (target && active(target)) {
            const d = idist(Math.abs(target.x - s.x), Math.abs(target.y - s.y));
            // backing away means turning tail: no reverse thrust, no return
            // fire. Against a FASTER pursuer that is a pure stern-chase death
            // spiral (probes: 60-75% of ticks spent facing away, zero shots)
            // — if we cannot actually keep the range open, stand and swing
            // the bow onto the target instead.
            const canOutrun = s.init.speed > (target.sysDrive ? 0 : target.init.speed);
            if (d > 430 * FP) steer(target.x, target.y, 1);
            else if (d < 360 * FP && canOutrun) {
              backAwayFrom(target.x, target.y);
            } else if (d < 360 * FP) {
              desiredX = target.x - s.x; // stand fast, bow on target, fight
              desiredY = target.y - s.y;
              travel = 0;
            } else travel = 0;
          } else travel = 0;
          break;
        }
        case 'evade_retreat': {
          if (noRetreat[s.init.side]) {
            // pinned by a warp dissipater: there IS no way out — grinding the
            // field edge until dead helps nobody. Stand and fight like hold.
            if (target && active(target)) {
              desiredX = target.x - s.x;
              desiredY = target.y - s.y;
            }
            travel = 0;
            break;
          }
          // run for the NEAREST edge — a fleeing ship may leave the field
          // from any side, so nobody gets cornered (bug fix)
          const dl = s.x;
          const dr = FIELD_W - s.x;
          const dt = s.y;
          const db = FIELD_H - s.y;
          const m = Math.min(dl, dr, dt, db);
          if (m === dl) steer(s.x - FIELD_W, s.y, 1);
          else if (m === dr) steer(s.x + FIELD_W, s.y, 1);
          else if (m === dt) steer(s.x, s.y - FIELD_H, 1);
          else steer(s.x, s.y + FIELD_H, 1);
          break;
        }
      }

      if (desiredX !== 0 || desiredY !== 0) {
        const want = headingToward(desiredX, desiredY);
        const delta = headingDelta(s.heading, want);
        const rate = turnRateOf(s.init.hullIdx, s.init.isBase);
        if (delta !== 0) {
          s.heading = (s.heading + clamp(delta, -rate, rate) + DIRS) % DIRS;
        }
        // SLEWING (0.23.0 game option): when the free turn still leaves the
        // target outside the forward arc, keep rotating by SPENDING movement.
        // Cost per extra 11.25° step = speed/(2*turnRate) MP — i.e. half a
        // tick's travel buys turnRate extra steps, so a frigate (rate 4)
        // whips its nose around nearly free while a titan (rate 1) trades
        // half its move per step. Fires only when the stance is already
        // trying to face the target (want === bearing): waypoint runs and
        // withdrawals never spin. All-360°-armed ships skip it entirely.
        if (slewing && s.slews && !s.init.isBase && target && active(target)) {
          const bearing = headingToward(target.x - s.x, target.y - s.y);
          if (bearing === want) {
            const stepCost = Math.max(1, ceilDiv(speed, 2 * rate));
            let spent = 0;
            // rotate until the target sits inside the F arc (±90°)
            while (Math.abs(headingDelta(s.heading, want)) > 8 && spent + stepCost <= speed) {
              s.heading = (s.heading + (headingDelta(s.heading, want) > 0 ? 1 : -1) + DIRS) % DIRS;
              spent += stepCost;
            }
            if (spent > 0) travel = Math.max(0, Math.min(travel, speed - spent));
          }
        }
        // hard turns bleed speed; near-aligned courses run at full burn
        const off = Math.abs(headingDelta(s.heading, want));
        if (off > 8) travel = 0; // pointing the wrong way: come about first
        else if (off > 4) travel = Math.floor(travel / 2);
      }
      if (travel > 0) {
        s.x += roundDiv(TRIG[s.heading]![0] * travel, 16384);
        s.y = clamp(s.y + roundDiv(TRIG[s.heading]![1] * travel, 16384), 8 * FP, FIELD_H - 8 * FP);
      }
      // edges (warp dissipaters pin the enemy on the field): ANY edge works
      if (s.stance === 'evade_retreat' && !noRetreat[s.init.side]) {
        if (s.x <= 4 * FP || s.x >= FIELD_W - 4 * FP || s.y <= 9 * FP || s.y >= FIELD_H - 9 * FP) {
          s.retreated = true;
        }
      }
      // "crossed" = an attacker with no remaining target drifting off the far edge
      if (s.init.side === 0 && s.x >= FIELD_W - 8 * FP && (s.targetIdx < 0 || !sims[s.targetIdx] || !active(sims[s.targetIdx]!))) {
        s.crossed = true;
      }
      s.x = clamp(s.x, 2 * FP, FIELD_W - 2 * FP);
    }

    // --- disengage countdown: a retreater that survives long enough warps out
    // wherever it stands (reaching an edge above still works sooner). A
    // dissipater-pinned side cannot warp, and neither can a fried drive. ---
    for (const s of sims) {
      if (!active(s) || s.stance !== 'evade_retreat' || s.init.isBase) continue;
      if (noRetreat[s.init.side] || s.sysDrive || s.init.speed === 0) continue;
      s.retreatTicks++;
      if (s.retreatTicks >= RETREAT_WARP_TICKS) s.retreated = true;
    }

    // --- projectiles fly ---
    for (const p of projectiles) {
      if (p.hp <= 0) continue;
      const t = sims[p.targetIdx];
      if (!t || !active(t)) {
        p.hp = 0;
        continue;
      }
      const ddx = t.x - p.x;
      const ddy = t.y - p.y;
      const d = idist(Math.abs(ddx), Math.abs(ddy));
      const step = p.speed * FP;
      if (d <= step) {
        // impact: lightning field, then ECM evasion, then damage
        if (t.specials.has('lightning_field') && rng.chancePct(50)) {
          frameShots.push({ tick, from: p.from, to: t.init.shipId, weaponId: p.weaponId, classId: p.classId, hit: false, dmg: 0 });
          p.hp = 0;
          continue;
        }
        if (!p.mods.includes('eccm') && t.missileEvasion > 0 && rng.chancePct(t.missileEvasion)) {
          frameShots.push({ tick, from: p.from, to: t.init.shipId, weaponId: p.weaponId, classId: p.classId, hit: false, dmg: 0 });
          p.hp = 0;
          continue;
        }
        applyDamage(t, p.dmg, ['guided', ...p.mods], frameShots, tick, p.from, p.targetIdx, p.weaponId, p.classId, frameDeaths, sims, rng);
        p.hp = 0;
      } else {
        p.x += roundDiv(ddx * step, d);
        p.y += roundDiv(ddy * step, d);
      }
    }

    // --- firing (deterministic ship order) ---
    // overkill spread: damage already dealt this tick plus warheads in flight;
    // a weapon whose target is already dead-on-paper picks a fresh one.
    // (in-flight totals are folded ONCE per tick — this path is hot)
    const hurtThisTick = new Map<number, number>();
    for (const p of projectiles) {
      if (p.hp > 0) hurtThisTick.set(p.targetIdx, (hurtThisTick.get(p.targetIdx) ?? 0) + p.dmg);
    }
    const overkilled = (idx: number): boolean => {
      const t2 = sims[idx];
      if (!t2) return true;
      const incoming = hurtThisTick.get(idx) ?? 0;
      // switch once the volley is ~80% certain to finish the target: the
      // last few shots walk on instead of pulverizing a corpse, but focused
      // fire on a live target keeps its full value
      return incoming * 10 >= (t2.shield + t2.armor + t2.structure) * 8;
    };
    for (let si = 0; si < sims.length; si++) {
      const s = sims[si]!;
      if (!active(s)) continue;
      const crippled = s.structure * 3 < s.init.structureHp;
      for (let wi = 0; wi < s.init.weapons.length; wi++) {
        const w = s.init.weapons[wi]!;
        if (w.classId === 3) continue; // bombs are for bombardment, not the pass
        if (s.cds[wi]! > 0) {
          s.cds[wi]!--;
          continue;
        }
        if (s.ammo[wi] === 0) continue;

        const isPd = w.mods.includes('pd');
        const isAmr = w.weaponId === 'anti_missile_rocket'; // classId 5 interceptor
        // point defense priority: shoot an incoming projectile aimed at our side
        if (isPd || isAmr) {
          const incoming = projectiles.find(
            (p) => p.hp > 0 && sims[p.targetIdx] && sims[p.targetIdx]!.init.side === s.init.side &&
              idist(Math.abs(p.x - s.x), Math.abs(p.y - s.y)) <= BAND_SHORT * 2,
          );
          if (incoming) {
            const hit = rng.chancePct(isAmr ? 85 : 70);
            frameShots.push({ tick, from: s.init.shipId, to: -1, weaponId: w.weaponId, classId: 0, hit, dmg: 0, ix: incoming.x, iy: incoming.y });
            // armored missiles take two intercepts to bring down
            if (hit) incoming.hp -= incoming.mods.includes('arm') ? 1 : incoming.hp;
            if (isAmr && s.ammo[wi]! > 0) s.ammo[wi] = s.ammo[wi]! - 1;
            s.cds[wi] = cooldownOf(w, crippled, s.specials);
            continue;
          }
          if (isAmr) continue; // rockets only engage missiles, never ships
        }

        let t = s.targetIdx >= 0 ? sims[s.targetIdx] : undefined;
        if (t && active(t) && overkilled(s.targetIdx)) {
          const alt = pickTarget(sims, s, (i) => !overkilled(i));
          if (alt >= 0) {
            s.targetIdx = alt;
            t = sims[alt];
          }
        }
        if (!t || !active(t)) continue;
        const dist = idist(Math.abs(t.x - s.x), Math.abs(t.y - s.y));
        // firing arc: the mount must bear on the target (PD turrets track
        // 360°). Patterns mode judges bearing against the choreography —
        // patternMountOk — with the fast-forward window and slew shots.
        const bearing = headingToward(t.x - s.x, t.y - s.y);
        let slewShot = false;
        if (!isPd) {
          if (patterns) {
            const elig = patternMountOk(s, w, bearing, tick, dist);
            if (elig === null) continue;
            slewShot = elig === 'slew';
          } else if (!inArc(w.arc ?? 'F', bearing, s.heading)) continue;
        }
        // slew shots wrench the hull off-pattern: the mount pays a turn-rate-
        // scaled cooldown penalty (frigates near-free, titans harsh)
        const shotCd = (): number => {
          const base = cooldownOf(w, crippled, s.specials);
          if (!slewShot) return base;
          return ceilDiv(base * (SLEW_FIRE_CD_PCT[turnRateOf(s.init.hullIdx, s.init.isBase)] ?? 200), 100);
        };
        // rangemaster treats the band one step closer
        let band = bandOf(dist);
        if (band > 0 && s.specials.has('rangemaster_target_unit')) band = (band - 1) as 0 | 1 | 2;

        if (w.classId === 0 || w.classId === 5) {
          // classId 5 direct-fire specials (stellar converter, pulsar, plasma
          // web, ...) fire like beams: auto-hit, no band falloff
          const maxBand = isPd ? BAND_SHORT : w.mods.includes('hv') ? BAND_HV : BAND_LONG;
          if (dist > maxBand) continue;
          // doctrine fire discipline (patterns): guns hold until the band the
          // tactic fights in — 'line' owns the long game; chargers, wings and
          // nets speak at medium and short. Lumbering hulls and bases fire
          // from wherever they are; missiles/strike craft are never gated.
          if (patterns && !s.init.isBase && !lumber[si] && band > DOCTRINE_FIRE_BAND[docs[s.init.side]]!) continue;
          const shots = w.mods.includes('af') ? 3 : 1;
          const attack = s.sysComputer ? 0 : s.init.beamAttack; // fried targeting computer
          // volley bookkeeping: once the current target is dead-on-paper the
          // REST of the volley walks to the next victim (overkill spread)
          let ti = s.targetIdx;
          let tt: Sim | undefined = t;
          const retarget = (): boolean => {
            if (tt && active(tt) && !overkilled(ti)) return true;
            const alt = pickTarget(sims, s, (i) => !overkilled(i) && withinVolley(i));
            // pickTarget's saturation fallback can hand back an enemy outside
            // this mount's range/arc — never fire at an illegal solution
            if (alt >= 0 && withinVolley(alt)) {
              ti = alt;
              tt = sims[alt]!;
              s.targetIdx = alt;
              return true;
            }
            // everyone fresh is out of reach: keep pounding the last live
            // target, but only while it remains a legal solution itself
            return tt !== undefined && active(tt) && withinVolley(ti);
          };
          const withinVolley = (i: number): boolean => {
            const e = sims[i]!;
            const d2 = idist(Math.abs(e.x - s.x), Math.abs(e.y - s.y));
            if (d2 > maxBand) return false;
            if (isPd) return true;
            const b2 = headingToward(e.x - s.x, e.y - s.y);
            return patterns ? patternMountOk(s, w, b2, tick, d2) !== null : inArc(w.arc ?? 'F', b2, s.heading);
          };
          for (let burst = 0; burst < shots; burst++) {
            for (let n = 0; n < w.count; n++) {
              if (!retarget() || !tt || !active(tt)) break;
              const d2 = idist(Math.abs(tt.x - s.x), Math.abs(tt.y - s.y));
              let band2 = bandOf(d2);
              if (band2 > 0 && s.specials.has('rangemaster_target_unit')) band2 = (band2 - 1) as 0 | 1 | 2;
              let hitPct = clamp(
                50 + attack - tt.init.beamDefense + BAND_HIT[band2]! +
                  (w.mods.includes('co') ? 25 : 0) + (w.mods.includes('af') ? -20 : 0),
                5,
                95,
              );
              if (tt.specials.has('displacement_device')) hitPct = Math.floor((hitPct * 67) / 100);
              if (w.mods.includes('hit') || w.classId === 5) hitPct = 100; // mauler device / field weapons: never miss
              const hit = rng.chancePct(hitPct);
              if (!hit) {
                frameShots.push({ tick, from: s.init.shipId, to: tt.init.shipId, weaponId: w.weaponId, classId: 0, hit: false, dmg: 0 });
                continue;
              }
              let dmg = w.dmgMin + rng.int(w.dmgMax - w.dmgMin + 1);
              const dmgPct = w.mods.includes('nr') || w.classId === 5 ? 100 : BAND_DMG[band2]!;
              dmg = Math.max(1, roundDiv(dmg * dmgPct, 100));
              if (w.mods.includes('hv')) dmg = roundDiv(dmg * 150, 100);
              if (w.mods.includes('ovr')) dmg = roundDiv(dmg * 150, 100); // overloaded mount
              if (w.mods.includes('env')) dmg *= 2; // enveloping: wraps the shields
              if (isPd) dmg = Math.max(1, roundDiv(dmg * 50, 100));
              if (s.specials.has('high_energy_focus')) dmg = roundDiv(dmg * 150, 100);
              if (s.specials.has('structural_analyzer')) dmg *= 2;
              const mods = s.specials.has('achilles_targeting_unit') ? [...w.mods, 'achilles'] : w.mods;
              applyDamage(tt, dmg, mods, frameShots, tick, s.init.shipId, ti, w.weaponId, 0, frameDeaths, sims, rng);
              // NOTE: applied beam damage is already reflected in the target's
              // live pools — adding it to hurtThisTick would double-count and
              // declare targets dead-on-paper at ~half HP (fleet fire dithers)
            }
          }
          s.cds[wi] = shotCd();
        } else if (w.classId === 1 || w.classId === 2) {
          const launchRange = w.classId === 1 ? 600 * FP : 500 * FP;
          if (dist > launchRange) continue;
          const volley = Math.min(w.count, s.ammo[wi]! < 0 ? w.count : s.ammo[wi]!);
          // MIRV missiles split into four independent warheads (each can be
          // point-defensed and each pays shield flat separately, like MOO2)
          const warheads = w.classId === 1 && w.mods.includes('mv') ? 4 : 1;
          for (let n = 0; n < volley * warheads; n++) {
            let dmg = w.dmgMin + rng.int(w.dmgMax - w.dmgMin + 1);
            if (w.mods.includes('ovr')) dmg = roundDiv(dmg * 150, 100); // overloaded warhead
            if (w.mods.includes('env')) dmg *= 2; // enveloping: wraps the shields
            projectiles.push({
              from: s.init.shipId,
              targetIdx: s.targetIdx,
              x: s.x,
              y: s.y,
              dmg,
              // fst (fast) drives push the munition half again as fast
              speed: (w.classId === 1 ? 12 : 8) + (w.mods.includes('fst') ? (w.classId === 1 ? 6 : 4) : 0),
              classId: w.classId,
              weaponId: w.weaponId,
              hp: w.mods.includes('arm') ? 2 : 1, // armored: survives one intercept
              mods: w.mods,
            });
            hurtThisTick.set(s.targetIdx, (hurtThisTick.get(s.targetIdx) ?? 0) + dmg);
          }
          if (s.ammo[wi]! > 0) s.ammo[wi] = Math.max(0, s.ammo[wi]! - volley);
          s.cds[wi] = shotCd();
        } else if (w.classId === 4) {
          // fighter bays / assault shuttles: strike craft fly out like guided
          // munitions (point defense can splash them) and hit with their
          // strategic payload; boarding craft cripple systems instead
          const launchRange = 450 * FP;
          if (dist > launchRange) continue;
          const volley = Math.min(w.count, s.ammo[wi]! < 0 ? w.count : s.ammo[wi]!);
          for (let n = 0; n < volley; n++) {
            const boarding = w.dmgMax <= 0; // assault shuttles carry marines, not bombs
            projectiles.push({
              from: s.init.shipId,
              targetIdx: s.targetIdx,
              x: s.x,
              y: s.y,
              dmg: boarding ? 6 : w.dmgMin + rng.int(w.dmgMax - w.dmgMin + 1),
              speed: 6,
              classId: 4,
              weaponId: w.weaponId,
              hp: 1,
              mods: boarding ? [...w.mods, 'board', 'sp', 'ap'] : w.mods,
            });
          }
          if (s.ammo[wi]! > 0) s.ammo[wi] = Math.max(0, s.ammo[wi]! - volley);
          s.cds[wi] = shotCd();
        }
      }
    }

    // --- shield regen (3%/tick; 5% with a capacitor) + automated repair ---
    for (const s of sims) {
      if (s.alive && !s.sysShield && s.init.shieldPool > 0 && s.shield < s.init.shieldPool) {
        const rate = s.specials.has('shield_capacitor') ? 5 : 3;
        s.shieldRegenAcc += s.init.shieldPool * rate;
        if (s.shieldRegenAcc >= 100) {
          const whole = Math.floor(s.shieldRegenAcc / 100);
          s.shieldRegenAcc -= whole * 100;
          s.shield = Math.min(s.init.shieldPool, s.shield + whole);
        }
      }
      if (s.alive && s.specials.has('automated_repair_unit') && s.structure < s.init.structureHp) {
        s.repairAcc += s.init.structureHp; // 0.5%/tick => x200 accumulator
        if (s.repairAcc >= 200) {
          const whole = Math.floor(s.repairAcc / 200);
          s.repairAcc -= whole * 200;
          s.structure = Math.min(s.init.structureHp, s.structure + whole);
        }
      }
    }

    if (onFrame) {
      onFrame({
        tick,
        projectiles: projectiles
          .map((p, pi) => ({ id: pi, x: p.x, y: p.y, classId: p.classId, w: p.weaponId, from: p.from, hp: p.hp }))
          .filter((p) => p.hp > 0)
          .map(({ hp: _hp, ...p }) => p),
        ships: sims.map((s) => ({
          id: s.init.shipId,
          x: s.x,
          y: s.y,
          h: s.heading,
          alive: s.alive,
          retreated: s.retreated,
          crossed: s.crossed,
          structPct: s.init.structureHp > 0 ? Math.floor((s.structure * 100) / s.init.structureHp) : 0,
          shieldPct: s.init.shieldPool > 0 ? Math.floor((s.shield * 100) / s.init.shieldPool) : 0,
          sys: `${s.sysDrive ? 'd' : ''}${s.sysComputer ? 'c' : ''}${s.sysShield ? 's' : ''}`,
        })),
        shots: frameShots,
        deaths: frameDeaths,
      });
    }

    const aActive = sims.some((s) => s.init.side === 0 && active(s));
    const dActive = sims.some((s) => s.init.side === 1 && active(s));
    if (!aActive || !dActive) {
      tick++;
      break;
    }
  }

  // --- outcome ---
  const outcomes: ShipOutcome[] = sims.map((s) => ({
    shipId: s.init.shipId,
    side: s.init.side,
    destroyed: !s.alive,
    retreated: s.retreated,
    crossed: s.crossed,
    structureLeft: s.structure,
    armorLeft: s.armor,
    structureMax: s.init.structureHp,
  }));
  const endHp = [0, 0];
  for (const s of sims) if (s.alive) endHp[s.init.side]! += s.structure + s.armor;
  const dmgPct = (side: 0 | 1) =>
    initialHp[side]! > 0 ? Math.floor(((initialHp[side]! - endHp[side]!) * 100) / initialHp[side]!) : 0;
  const aAlive = sims.some((s) => s.init.side === 0 && s.alive && !s.retreated);
  const dAlive = sims.some((s) => s.init.side === 1 && s.alive && !s.retreated);
  const winner = aAlive && !dAlive ? 0 : dAlive && !aAlive ? 1 : null;

  return {
    ticks: tick,
    outcomes,
    winner,
    attackerDamagePct: dmgPct(0),
    defenderDamagePct: dmgPct(1),
  };
}

function cooldownOf(w: CombatWeapon, crippled: boolean, specials?: Set<string>): number {
  let base = w.classId === 0 ? 12 : w.classId === 1 ? 25 : 30;
  if (w.mods.includes('af')) base = roundDiv(base * 60, 100);
  if (specials) {
    if (w.classId === 0 && specials.has('hyper_x_capacitors')) base = Math.max(1, roundDiv(base, 2));
    if ((w.classId === 1 || w.classId === 2) && specials.has('fast_missile_racks')) base = Math.max(1, roundDiv(base, 2));
  }
  base = roundDiv(base * 100, COMBAT_PACE);
  return crippled ? base * 2 : base;
}

function pickTarget(sims: Sim[], s: Sim, accept?: (idx: number) => boolean): number {
  let enemies: number[] = [];
  for (let i = 0; i < sims.length; i++) {
    const e = sims[i]!;
    if (e.init.side !== s.init.side && e.alive && !e.retreated && !e.crossed) enemies.push(i);
  }
  if (accept) {
    const filtered = enemies.filter(accept);
    if (filtered.length) enemies = filtered; // else: everyone is saturated, keep firing
  }
  if (!enemies.length) return -1;
  const priority = s.priority;
  const dist = (i: number) => idist(Math.abs(sims[i]!.x - s.x), Math.abs(sims[i]!.y - s.y));
  const threat = (i: number) => {
    // sustained output: Σ expected damage / cooldown — the "most damage" ship
    let total = 0;
    for (const w of sims[i]!.init.weapons) {
      if (w.classId === 3) continue;
      const expected = w.dmgMin + w.dmgMax; // ×2, constant factor cancels
      total += Math.floor((expected * w.count * 100) / Math.max(1, cooldownOf(w, false)));
    }
    return total;
  };
  switch (priority) {
    case 'biggest':
      return enemies.sort((a, b) => sims[b]!.init.hullIdx - sims[a]!.init.hullIdx || dist(a) - dist(b) || a - b)[0]!;
    case 'smallest':
      return enemies.sort((a, b) => sims[a]!.init.hullIdx - sims[b]!.init.hullIdx || dist(a) - dist(b) || a - b)[0]!;
    case 'warships':
      return enemies.sort((a, b) => Number(sims[a]!.init.isBase) - Number(sims[b]!.init.isBase) || dist(a) - dist(b) || a - b)[0]!;
    case 'bases':
      return enemies.sort((a, b) => Number(sims[b]!.init.isBase) - Number(sims[a]!.init.isBase) || dist(a) - dist(b) || a - b)[0]!;
    case 'deadliest':
      return enemies.sort((a, b) => threat(b) - threat(a) || dist(a) - dist(b) || a - b)[0]!;
    default:
      return enemies.sort((a, b) => dist(a) - dist(b) || a - b)[0]!;
  }
}

function applyDamage(
  t: Sim,
  raw: number,
  mods: string[],
  shots: ShotEvent[],
  tick: number,
  fromId: number,
  targetIdx: number,
  weaponId: string,
  classId: number,
  deaths: number[],
  sims: Sim[],
  rng: Rng,
): number {
  let dmg = raw;
  // damper field (Antaran tech): incoming damage reduced by 3/4
  if (t.specials.has('damper_field')) dmg = Math.max(1, Math.floor(dmg / 4));
  // energy absorber (monster trait): quarter of the damage is drunk
  if (t.specials.has('energy_absorber')) dmg = Math.max(1, Math.floor((dmg * 3) / 4));
  // emissions-guided munitions ride the drive plume straight through shields
  const pierces = (mods.includes('sp') || mods.includes('emg')) && !t.specials.has('hard_shields');
  let soaked = 0; // shield-stopped damage (flat + pool) — the viewer's fizzle cue
  if (!pierces) {
    // flat per-hit reduction then pool absorption — none once the generator
    // is knocked out (a dead generator deflects nothing)
    if (!mods.includes('ap') && !t.sysShield) {
      const flat = Math.min(dmg, t.init.shieldFlat);
      if (t.shield > 0) soaked += flat; // a collapsed shield deflects nothing visible
      dmg = Math.max(0, dmg - t.init.shieldFlat);
    }
    const absorbed = Math.min(t.shield, dmg);
    t.shield -= absorbed;
    dmg -= absorbed;
    soaked += absorbed;
  }
  let structDmg = 0;
  if (dmg > 0) {
    if (mods.includes('ap') || mods.includes('achilles')) {
      t.structure -= dmg;
      structDmg = dmg;
    } else {
      const toArmor = Math.min(t.armor, dmg);
      t.armor -= toArmor;
      structDmg = dmg - toArmor;
      t.structure -= structDmg;
    }
  }
  const killed = t.structure <= 0 && t.alive;
  shots.push({ tick, from: fromId, to: t.init.shipId, weaponId, classId, hit: true, dmg: raw, ...(killed ? { kill: true } : {}), ...(soaked > 0 ? { sh: soaked } : {}) });
  if (killed) {
    t.alive = false;
    t.structure = 0;
    deaths.push(t.init.shipId);
  }
  // internal hits can knock out systems for the rest of the fight (transient:
  // only structure/armor percentages persist after the battle). Boarding
  // craft (assault shuttles) ALWAYS cripple something they reach.
  if (structDmg > 0 && t.alive && (mods.includes('board') || mods.includes('emg') || rng.chancePct(SYSTEM_KNOCKOUT_PCT))) {
    const knockable: Array<'drive' | 'computer' | 'shield'> = [];
    if (!t.sysDrive && t.init.speed > 0) knockable.push('drive');
    if (!t.sysComputer && t.init.beamAttack > 0) knockable.push('computer');
    if (!t.sysShield && t.init.shieldPool > 0) knockable.push('shield');
    if (knockable.length) {
      // emissions guidance homes on the engines: the drive goes first
      const hit = mods.includes('emg') && knockable.includes('drive') ? 'drive' : knockable[rng.int(knockable.length)]!;
      if (hit === 'drive') t.sysDrive = true;
      else if (hit === 'computer') t.sysComputer = true;
      else {
        t.sysShield = true;
        t.shield = 0;
      }
    }
  }
  void targetIdx;
  void sims;
  return dmg;
}

/** Expected damage per second of a design's broadside at SHORT band (both
 * sides in arc, targets at 50% base to-hit) — the designer's DPS readout. */
export function designDps(weapons: CombatWeapon[], beamAttack: number): number {
  let total = 0; // x100 fixed point
  for (const w of weapons) {
    if (w.classId === 3) continue; // bombs don't fire in the pass
    if (w.weaponId === 'anti_missile_rocket') continue; // interceptor: no ship damage
    let expected = roundDiv(w.dmgMin + w.dmgMax, 2);
    // mirror the sim's damage mods so the readout doesn't lie
    if (w.mods.includes('hv')) expected = roundDiv(expected * 150, 100);
    if (w.mods.includes('ovr')) expected = roundDiv(expected * 150, 100);
    if (w.mods.includes('env')) expected *= 2;
    if (w.classId === 0 && w.mods.includes('pd')) expected = roundDiv(expected * 50, 100);
    const perShot = w.classId === 0 ? roundDiv(expected * (50 + clamp(beamAttack, 0, 100)), 100) : expected;
    let shots = w.classId === 0 && w.mods.includes('af') ? 3 : 1;
    if (w.classId === 1 && w.mods.includes('mv')) shots *= 4; // MIRV: four warheads
    // decrement-then-fire: the real firing period is cooldown + 1 ticks
    const cd = Math.max(1, cooldownOf(w, false)) + 1;
    total += roundDiv(perShot * shots * w.count * 10 * 100, cd); // 10 ticks/sec
  }
  return roundDiv(total, 100);
}
