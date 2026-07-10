// One-pass tactical combat (redesigned; deterministic; fixed-point integers).
//
// Field: 512x384 units (positions stored x256). 10 logical ticks/second, cap
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
export const FIELD_W = 512 * FP;
export const FIELD_H = 384 * FP;
export const MAX_TICKS = 400;
/** master pace knob: percent of base rate-of-fire (tuned by the balance harness
 * to land equal-tech passes in the 20-40% fleet-damage envelope) */
export const COMBAT_PACE = 250;

export type Stance = 'charge' | 'hold_range' | 'standoff' | 'evade_retreat' | 'formation' | 'passthrough';
export type TargetPriority = 'nearest' | 'biggest' | 'smallest' | 'warships' | 'bases';

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
}

export interface BattleInput {
  battleId: string;
  seedLabel: Array<string | number>;
  attacker: number; // empireId
  defender: number;
  ships: CombatShipInit[];
  /** non-combat ships present at the star: display-only extras for the replay
   * viewer (they never enter the sim; the loser's are captured after the pass) */
  bystanders?: Array<{ shipId: number; side: 0 | 1; kind: string }>;
  ordersA: BattleOrders;
  ordersD: BattleOrders;
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
  /** guided munitions in flight this tick (missiles classId 1, torpedoes 2) */
  projectiles: Array<{ x: number; y: number; classId: number }>;
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
      s.x = s.init.isBase ? 488 * FP : 460 * FP;
      s.y = Math.floor(((di + 1) * FIELD_H) / (countD + 1));
      di++;
    }
    s.homeY = s.y;
  }

  const projectiles: Projectile[] = [];
  const initialHp = [0, 0];
  for (const s of sims) initialHp[s.init.side]! += s.structure + s.armor;

  const active = (s: Sim) => s.alive && !s.retreated && !s.crossed;

  let tick = 0;
  for (tick = 0; tick < MAX_TICKS; tick++) {
    const frameShots: ShotEvent[] = [];
    const frameDeaths: number[] = [];

    // --- retreat thresholds ---
    for (const side of [0, 1] as const) {
      const orders = side === 0 ? input.ordersA : input.ordersD;
      let hp = 0;
      for (const s of sims) if (s.init.side === side && s.alive) hp += s.structure + s.armor;
      if (initialHp[side]! > 0 && hp * 100 < initialHp[side]! * orders.retreatThresholdPct) {
        for (const s of sims) {
          if (s.init.side === side && active(s) && !s.init.isBase) s.stance = 'evade_retreat';
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
    // line, the whole group wheels around and withdraws together ---
    for (const side of [0, 1] as const) {
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
    for (const side of [0, 1] as const) {
      const line = sims.filter((s) => s.init.side === side && s.stance === 'formation' && active(s) && !s.init.isBase);
      if (line.length) {
        formationSpeed[side] = Math.min(...line.map((s) => (s.sysDrive ? 0 : Math.max(1, s.init.speed))));
      }
    }

    // --- movement: turn toward the desired course (hull turn rate), then move
    // along the current heading — capitals answer the helm slowly ---
    for (const s of sims) {
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
      switch (s.stance) {
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
          else if (nearest < 140 * FP && target) steer(target.x, target.y, -1);
          else travel = 0; // hold the line and fire
          break;
        }
        case 'hold_range': {
          if (target && active(target)) {
            const d = idist(Math.abs(target.x - s.x), Math.abs(target.y - s.y));
            if (d > 200 * FP) steer(target.x, target.y, 1, 200 * FP);
            else if (d < 150 * FP) steer(target.x, target.y, -1);
            else travel = 0;
          } else steer(s.x + dir * FIELD_W, s.y, 1);
          break;
        }
        case 'standoff': {
          if (target && active(target)) {
            const d = idist(Math.abs(target.x - s.x), Math.abs(target.y - s.y));
            if (d > 430 * FP) steer(target.x, target.y, 1);
            else if (d < 360 * FP) steer(target.x, target.y, -1);
            else travel = 0;
          } else travel = 0;
          break;
        }
        case 'evade_retreat': {
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
    // a weapon whose target is already dead-on-paper picks a fresh one
    const hurtThisTick = new Map<number, number>();
    const overkilled = (idx: number): boolean => {
      const t2 = sims[idx];
      if (!t2) return true;
      let incoming = hurtThisTick.get(idx) ?? 0;
      for (const p of projectiles) if (p.hp > 0 && p.targetIdx === idx) incoming += p.dmg;
      return incoming >= t2.shield + t2.armor + t2.structure;
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
        // point defense priority: shoot an incoming projectile aimed at our side
        if (isPd) {
          const incoming = projectiles.find(
            (p) => p.hp > 0 && sims[p.targetIdx] && sims[p.targetIdx]!.init.side === s.init.side &&
              idist(Math.abs(p.x - s.x), Math.abs(p.y - s.y)) <= BAND_SHORT * 2,
          );
          if (incoming) {
            const hit = rng.chancePct(70);
            frameShots.push({ tick, from: s.init.shipId, to: -1, weaponId: w.weaponId, classId: 0, hit, dmg: 0 });
            if (hit) incoming.hp = 0;
            s.cds[wi] = cooldownOf(w, crippled, s.specials);
            continue;
          }
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
        // firing arc: the mount must bear on the target (PD turrets track 360°)
        const bearing = headingToward(t.x - s.x, t.y - s.y);
        if (!isPd && !inArc(w.arc ?? 'F', bearing, s.heading)) continue;
        // rangemaster treats the band one step closer
        let band = bandOf(dist);
        if (band > 0 && s.specials.has('rangemaster_target_unit')) band = (band - 1) as 0 | 1 | 2;

        if (w.classId === 0) {
          const maxBand = isPd ? BAND_SHORT : w.mods.includes('hv') ? BAND_HV : BAND_LONG;
          if (dist > maxBand) continue;
          const shots = w.mods.includes('af') ? 3 : 1;
          const attack = s.sysComputer ? 0 : s.init.beamAttack; // fried targeting computer
          // volley bookkeeping: once the current target is dead-on-paper the
          // REST of the volley walks to the next victim (overkill spread)
          let ti = s.targetIdx;
          let tt: Sim | undefined = t;
          const retarget = (): boolean => {
            if (tt && active(tt) && !overkilled(ti)) return true;
            const alt = pickTarget(sims, s, (i) => !overkilled(i) && withinVolley(i));
            if (alt < 0) return tt !== undefined && active(tt); // keep pounding the last live target
            ti = alt;
            tt = sims[alt]!;
            s.targetIdx = alt;
            return true;
          };
          const withinVolley = (i: number): boolean => {
            const e = sims[i]!;
            const d2 = idist(Math.abs(e.x - s.x), Math.abs(e.y - s.y));
            if (d2 > maxBand) return false;
            if (isPd) return true;
            return inArc(w.arc ?? 'F', headingToward(e.x - s.x, e.y - s.y), s.heading);
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
              if (w.mods.includes('hit')) hitPct = 100; // mauler device: never misses
              const hit = rng.chancePct(hitPct);
              if (!hit) {
                frameShots.push({ tick, from: s.init.shipId, to: tt.init.shipId, weaponId: w.weaponId, classId: 0, hit: false, dmg: 0 });
                continue;
              }
              let dmg = w.dmgMin + rng.int(w.dmgMax - w.dmgMin + 1);
              const dmgPct = w.mods.includes('nr') ? 100 : BAND_DMG[band2]!;
              dmg = Math.max(1, roundDiv(dmg * dmgPct, 100));
              if (w.mods.includes('hv')) dmg = roundDiv(dmg * 150, 100);
              if (isPd) dmg = Math.max(1, roundDiv(dmg * 50, 100));
              if (s.specials.has('high_energy_focus')) dmg = roundDiv(dmg * 150, 100);
              if (s.specials.has('structural_analyzer')) dmg *= 2;
              const mods = s.specials.has('achilles_targeting_unit') ? [...w.mods, 'achilles'] : w.mods;
              applyDamage(tt, dmg, mods, frameShots, tick, s.init.shipId, ti, w.weaponId, 0, frameDeaths, sims, rng);
              hurtThisTick.set(ti, (hurtThisTick.get(ti) ?? 0) + dmg);
            }
          }
          s.cds[wi] = cooldownOf(w, crippled, s.specials);
        } else if (w.classId === 1 || w.classId === 2) {
          const launchRange = w.classId === 1 ? 600 * FP : 500 * FP;
          if (dist > launchRange) continue;
          const volley = Math.min(w.count, s.ammo[wi]! < 0 ? w.count : s.ammo[wi]!);
          // MIRV missiles split into four independent warheads (each can be
          // point-defensed and each pays shield flat separately, like MOO2)
          const warheads = w.classId === 1 && w.mods.includes('mv') ? 4 : 1;
          for (let n = 0; n < volley * warheads; n++) {
            projectiles.push({
              from: s.init.shipId,
              targetIdx: s.targetIdx,
              x: s.x,
              y: s.y,
              dmg: w.dmgMin + rng.int(w.dmgMax - w.dmgMin + 1),
              speed: w.classId === 1 ? 12 : 8,
              classId: w.classId,
              weaponId: w.weaponId,
              hp: 1,
              mods: w.mods,
            });
          }
          if (s.ammo[wi]! > 0) s.ammo[wi] = Math.max(0, s.ammo[wi]! - volley);
          s.cds[wi] = cooldownOf(w, crippled, s.specials);
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
          s.cds[wi] = cooldownOf(w, crippled, s.specials);
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
          .filter((p) => p.hp > 0)
          .map((p) => ({ x: p.x, y: p.y, classId: p.classId })),
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
  switch (priority) {
    case 'biggest':
      return enemies.sort((a, b) => sims[b]!.init.hullIdx - sims[a]!.init.hullIdx || dist(a) - dist(b) || a - b)[0]!;
    case 'smallest':
      return enemies.sort((a, b) => sims[a]!.init.hullIdx - sims[b]!.init.hullIdx || dist(a) - dist(b) || a - b)[0]!;
    case 'warships':
      return enemies.sort((a, b) => Number(sims[a]!.init.isBase) - Number(sims[b]!.init.isBase) || dist(a) - dist(b) || a - b)[0]!;
    case 'bases':
      return enemies.sort((a, b) => Number(sims[b]!.init.isBase) - Number(sims[a]!.init.isBase) || dist(a) - dist(b) || a - b)[0]!;
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
  const pierces = mods.includes('sp') && !t.specials.has('hard_shields');
  if (!pierces) {
    // flat per-hit reduction then pool absorption
    if (!mods.includes('ap')) dmg = Math.max(0, dmg - t.init.shieldFlat);
    const absorbed = Math.min(t.shield, dmg);
    t.shield -= absorbed;
    dmg -= absorbed;
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
  shots.push({ tick, from: fromId, to: t.init.shipId, weaponId, classId, hit: true, dmg: raw, ...(killed ? { kill: true } : {}) });
  if (killed) {
    t.alive = false;
    t.structure = 0;
    deaths.push(t.init.shipId);
  }
  // internal hits can knock out systems for the rest of the fight (transient:
  // only structure/armor percentages persist after the battle). Boarding
  // craft (assault shuttles) ALWAYS cripple something they reach.
  if (structDmg > 0 && t.alive && (mods.includes('board') || rng.chancePct(SYSTEM_KNOCKOUT_PCT))) {
    const knockable: Array<'drive' | 'computer' | 'shield'> = [];
    if (!t.sysDrive && t.init.speed > 0) knockable.push('drive');
    if (!t.sysComputer && t.init.beamAttack > 0) knockable.push('computer');
    if (!t.sysShield && t.init.shieldPool > 0) knockable.push('shield');
    if (knockable.length) {
      const hit = knockable[rng.int(knockable.length)]!;
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
    const expected = roundDiv(w.dmgMin + w.dmgMax, 2);
    const perShot = w.classId === 0 ? roundDiv(expected * (50 + clamp(beamAttack, 0, 100)), 100) : expected;
    let shots = w.classId === 0 && w.mods.includes('af') ? 3 : 1;
    if (w.classId === 1 && w.mods.includes('mv')) shots *= 4; // MIRV: four warheads
    const cd = Math.max(1, cooldownOf(w, false));
    total += roundDiv(perShot * shots * w.count * 10 * 100, cd); // 10 ticks/sec
  }
  return roundDiv(total, 100);
}
