// Space-combat DOCTRINES: the data behind the choreography (round 9, 0.26.0).
//
// Rounds 6-8 gave every battle a set-piece pattern, but the patterns all
// converged on the same range band, so the doctrine a player picked barely
// moved the result. This module is the fix, and it is deliberately a TABLE:
// each doctrine is six numbers describing WHERE its ships stand relative to
// the enemy mass, WHICH range band its guns speak in, and WHAT its fast
// element does. combat.ts flies the geometry; everything tunable lives here.
//
// The doctrines are enemy-RELATIVE, so the fights are decided by physics
// rather than by a script:
//
//   standoff  hold the long band and give ground — full-strength warheads and
//             heavy mounts, beams at 40%; works only while your drives can
//             keep the range open, and the field edge is behind you.
//   line      a gun wall at the medium band, bows on, never chasing — the
//             steadiest platform for forward-arc guns, and the doctrine a
//             slow fleet can actually execute. Blind to its own flanks.
//   charge    dive onto individual targets at knife range: full damage, +10
//             to hit, and the only band where strike craft and boarding
//             shuttles are worth carrying. You eat the whole approach.
//   flank     the main body fixes them at medium range while the fastest
//             third stages off their beam and then dives on the REAR arc of
//             whatever it targets, where forward guns cannot answer.
//   pincer    the same trade with a bigger, earlier wing split to both sides:
//             more rear-arc pressure, a thinner main body.
//   envelop   the whole fleet closes a rotating ring — every bow bears and
//             nobody has a safe quarter, but the net is thin everywhere and
//             it must survive the closing.
//
// Speed is the currency: an anchor is a place in the world, so a fleet that
// cannot cover the ground simply never arrives, and a fleet that cannot back
// away faster than it is chased loses the range it was counting on. Turn rate
// is the second currency: combat.ts rotates hulls toward their choreographed
// heading at the hull turn rate, so a lumbering capital's forward guns spend
// a maneuver doctrine pointing at empty space.

import type { BattleOrders, TargetPriority } from './combat';

export type Doctrine = 'charge' | 'standoff' | 'line' | 'flank' | 'pincer' | 'envelop';

export const DOCTRINES: readonly Doctrine[] = ['charge', 'standoff', 'line', 'flank', 'pincer', 'envelop'];

export interface DoctrineProfile {
  /** where the main body wants to sit, measured from the enemy mass (or, for
   * 'charge', from the ship it is diving on). Field units. */
  standU: number;
  /** the ring's OPENING radius for closing figures; equals standU for the
   * doctrines that hold a fixed distance. Field units. */
  openU: number;
  /** ticks the closing figure takes to shrink from openU to standU */
  closeTicks: number;
  /** percent of the pattern roster committed to the fast strike element */
  strikePct: number;
  /** how far off the enemy mass the strike element stages before it commits */
  stageU: number;
  /** the tick the strike element leaves its staging point and dives */
  commitTick: number;
  /** how close the strike element gets to the ship it dives on */
  strikeU: number;
  /** highest range band direct-fire mounts will use (bandOf: 0 short,
   * 1 medium, 2 long, 3 heavy-long). Guided munitions are never gated. */
  fireBand: number;
  /** the main body's angular half-span around the enemy mass, heading steps
   * (32 steps = a full turn), or 16 for a closed ring */
  span: number;
  /** figure rotation in 1/16 heading steps per tick (0 = a standing wall).
   * This is not decoration: a ship only earns motion evasion (combat.ts
   * EVASION_PER_MP) for movement it actually spends, so a doctrine whose
   * figure keeps turning is a doctrine whose ships are hard to hit — and a
   * wall that stands to work its guns is the easiest target on the field.
   * It is also the movement a ship is NOT banking for jukes. */
  spin16: number;
  /** what the strike element hunts. Wings exist to get into a rear arc, and
   * a rear arc is worth most against a hull that cannot swing its bow back
   * around — so flanking wings go for the capitals and leave the escorts to
   * the main body. Absent = the fleet's ordered target priority. */
  strikePriority?: TargetPriority;
  /** percent of full speed a giving-ground fleet makes while running, ON TOP
   * of what the abeam withdrawal course already costs it (combat.ts charges
   * a quarter of the way for holding the broadside on the pursuer). 100 =
   * the oblique course is the whole price. Either way a standoff bleeds
   * ground to an equal-speed pursuer, which is what turns it from a free win
   * into a bet on your drives. */
  runPct: number;
  /** once inside its band, does the main body STOP — holding the exact spot
   * it reached rather than dressing the line again every tick? A wall that
   * stands is a wall with its whole movement allowance free for jukes and
   * none of it buying evasion; that trade is the point. */
  holdsStation: boolean;
  /** does this doctrine BACK AWAY when the enemy is already inside its band?
   * Only a standoff does. Everything else stands and fights where it is
   * caught — otherwise every doctrine kites, and none of them mean anything.
   * Backing away is half speed (combat.ts), so it costs a real drive edge. */
  giveGround: boolean;
}

/**
 * The whole tactical balance in one table.
 *
 * Read the bands off `standU` against combat.ts's range bands (short <= 96u,
 * medium <= 224u, long <= 448u): charge fights inside the short band at 100%
 * damage and +10 to hit, line at medium for 70%, standoff at long for 40% —
 * which is exactly why standoff belongs to missiles and strike craft belong
 * to charge. `fireBand` says how far out a doctrine's gunners will take a
 * shot at all: only a STANDOFF works the extreme bands, which is the whole of
 * its offer, and a wall holds its fire for the band it chose to fight in.
 */
export const DOCTRINE_PROFILE: Record<Doctrine, DoctrineProfile> = {
  charge: {
    standU: 34,
    openU: 34,
    closeTicks: 1,
    strikePct: 0,
    stageU: 0,
    commitTick: 0,
    strikeU: 34,
    fireBand: 2,
    span: 8,
    spin16: 16,
    holdsStation: false,
    runPct: 100,
    giveGround: false,
  },
  standoff: {
    standU: 320,
    openU: 320,
    closeTicks: 1,
    strikePct: 0,
    stageU: 0,
    commitTick: 0,
    strikeU: 320,
    fireBand: 3,
    span: 5,
    spin16: 0,
    holdsStation: false,
    runPct: 100,
    giveGround: true,
  },
  line: {
    standU: 186,
    openU: 186,
    closeTicks: 1,
    strikePct: 0,
    stageU: 0,
    commitTick: 0,
    strikeU: 186,
    fireBand: 1,
    span: 6,
    spin16: 0,
    holdsStation: true,
    runPct: 100,
    giveGround: false,
  },
  flank: {
    standU: 150,
    openU: 150,
    closeTicks: 1,
    strikePct: 36,
    stageU: 210,
    commitTick: 24,
    strikeU: 45,
    fireBand: 2,
    span: 5,
    spin16: 0,
    strikePriority: 'biggest',
    holdsStation: true,
    runPct: 100,
    giveGround: false,
  },
  pincer: {
    standU: 150,
    openU: 150,
    closeTicks: 1,
    strikePct: 48,
    stageU: 210,
    commitTick: 18,
    strikeU: 45,
    fireBand: 2,
    span: 5,
    spin16: 0,
    strikePriority: 'biggest',
    holdsStation: true,
    runPct: 100,
    giveGround: false,
  },
  envelop: {
    standU: 70,
    openU: 150,
    closeTicks: 40,
    strikePct: 0,
    stageU: 0,
    commitTick: 0,
    strikeU: 70,
    fireBand: 2,
    span: 16,
    spin16: 12,
    holdsStation: false,
    runPct: 100,
    giveGround: false,
  },
};

/** doctrines whose main body dives on an individual TARGET rather than
 * holding a station relative to the enemy mass */
export const focusesTarget = (d: Doctrine): boolean => d === 'charge';

/** doctrines that split off a fast strike element */
export const hasStrikeWing = (d: Doctrine): boolean => DOCTRINE_PROFILE[d].strikePct > 0;

/** doctrines that close a ring instead of facing the enemy from one side */
export const isRing = (d: Doctrine): boolean => DOCTRINE_PROFILE[d].span >= 16 && !focusesTarget(d);

/**
 * A side's doctrine under the 0.26 tactics engine. The battle order's
 * `formation` IS the doctrine when one was given; otherwise the stance still
 * speaks for it, and — unlike the 0.24 pattern engine, which folded standoff
 * into line — a standoff stance now means standoff.
 */
export function tacticalDoctrineOf(orders: BattleOrders): Doctrine {
  const f = orders.formation;
  if (f && (DOCTRINES as readonly string[]).includes(f)) return f as Doctrine;
  if (orders.stance === 'standoff') return 'standoff';
  if (orders.stance === 'hold_range' || orders.stance === 'formation') return 'line';
  return 'charge';
}

/** the doctrine's own summary, for the orders UI and the battle log */
export const DOCTRINE_BLURB: Record<Doctrine, string> = {
  charge: 'Charge — dive to knife range: full damage, and the only band where strike craft and boarding shuttles pay',
  standoff: 'Standoff — hold the long band and give ground: warheads at full strength, beams at 40%, and only while your drives keep the range',
  line: 'Line — a gun wall at medium range, bows on: the steadiest platform for forward arcs, and blind to its own flanks',
  flank: 'Flank — the wall fixes them while the fastest third stages wide and dives on their rear arcs',
  pincer: 'Pincer — a bigger wing split to both sides: more rear-arc pressure, a thinner wall',
  envelop: 'Envelop — the whole fleet closes a rotating ring: every bow bears, and no quarter is safe for either side',
};

// ---- choosing a doctrine ---------------------------------------------------

/** What a fleet is made of, as far as picking a tactic is concerned. Built
 * from a side's OWN designs only — nobody gets to read the enemy's blueprints
 * to choose a formation. */
export interface FleetProfile {
  /** mobile hulls present */
  hulls: number;
  /** percent of mounts that are guided munitions (missiles, torpedoes) */
  guidedPct: number;
  /** percent of mounts that are strike craft or boarding shuttles */
  strikePct: number;
  /** mean combat speed of the mobile hulls */
  speed: number;
  /** mean hull index (1 frigate .. 6 doomstar): the turn-rate proxy */
  hullIdx: number;
}

export interface DoctrineSituation {
  /** we are the defender in this battle */
  defending: boolean;
  /** our own orbital defenses are in the fight (they cannot maneuver) */
  ownBases: boolean;
  /** the enemy is fighting under orbital defenses (which cannot maneuver) */
  enemyBases: boolean;
}

/**
 * Pick a doctrine for a fleet. The rules are the ones the Monte Carlo
 * harness found (tests/balance/space-tactics-sim.test.ts), in the order a
 * player would reason through them:
 *
 *   1. Fighting alongside your own orbital defenses means standing with them.
 *   2. Strike craft and boarding shuttles only reach a target you closed on.
 *   3. Warheads ignore range falloff, so a warhead fleet holds the range —
 *      but only a fleet quick enough to hold it should try.
 *   4. Bases cannot answer the helm, and neither can a slow fleet's bows:
 *      close a net on them.
 *   5. Fast, light hulls earn their keep in somebody's rear arc.
 *   6. Everything else stands at medium range and shoots straight.
 */
export function pickDoctrine(mine: FleetProfile, sit: DoctrineSituation): Doctrine {
  if (mine.hulls === 0) return 'line';
  if (sit.ownBases) return 'line';
  if (mine.strikePct >= 25) return mine.speed >= 7 && mine.hullIdx <= 4 ? 'envelop' : 'charge';
  if (mine.guidedPct >= 45 && mine.speed >= 5) return 'standoff';
  if (sit.enemyBases) return mine.speed >= 6 ? 'envelop' : 'charge';
  if (mine.speed >= 8 && mine.hullIdx <= 3 && mine.hulls >= 6) return mine.hulls >= 10 ? 'pincer' : 'flank';
  if (mine.speed >= 7 && mine.hullIdx <= 3) return 'charge';
  if (sit.defending) return 'line';
  return mine.hullIdx >= 4 ? 'line' : 'envelop';
}
