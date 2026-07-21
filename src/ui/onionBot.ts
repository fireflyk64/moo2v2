// Masters of Onions CPU — the constraint-driven "Tech Fortress Doctrine" bot
// (spec: bugs/ai_plan.md). Core loop: find the dominant constraint → spend the
// turn removing it → re-evaluate. Research is the default tool, not the goal;
// every subsystem (research field choice, per-colony builds, leaders, fleet
// sizing, strikes) keys off the same dominant-constraint verdict, with
// hysteresis and minimum commitments so the empire never thrashes.
//
// Deliberately SELF-CONTAINED: the OnionAI and the v2 brain are tournament
// rivals — tuning one must never nudge the other. SoloBot stays the shared
// session shell (commit timing, lobby echo, surrender hygiene) and delegates
// all strategy here when brain === 'onion'. Everything below issues ordinary
// logged commands through the session; the sim never special-cases it.
//
// All tunables live in the tables at the top — the tournament improvement
// loop edits weights, not control flow.

import { HULL_WEIGHT, MONSTER_CLEAR_WEIGHT, marinesOf, selectors, shipMarines, starDistance } from '@engine/index';
import { itemCost, SHIP_BUILDABLES, PROJECT_BUILDABLES } from '@engine/items';
import { leaderById } from '@engine/leaders';
import type { Empire, GameState, Planet } from '@engine/types';
import type { GameSession } from '@protocol/session';
import type { BotPersonality } from './soloBot';

export type Constraint =
  | 'expansion' // good planets unclaimed, pipeline empty
  | 'range' // wanted stars outside the fuel bubble
  | 'research' // labs starved, rival out-teching
  | 'production' // yards too weak to finish anything
  | 'food' // farmer share strangling the economy
  | 'treasury' // cannot rush/hire/react
  | 'military' // cannot beat the threat/target class
  | 'defense'; // enemy at the gates

/** cross-turn state (per bot instance): the hysteresis + min-commitment
 * memory the spec's anti-thrash section requires */
export interface OnionMemory {
  plan: Constraint | null;
  planSince: number;
  /** committed strike star (enemy colony or guarded prize) — held until it
   * falls, the force dies, or the commitment window lapses */
  attackStar: number | null;
  attackSince: number;
  wasAtWar: boolean;
}

export const freshOnionMemory = (): OnionMemory => ({
  plan: null,
  planSince: 0,
  attackStar: null,
  attackSince: 0,
  wasAtWar: false,
});

export interface OnionCtx {
  session: GameSession<GameState>;
  state: GameState;
  planned: GameState;
  me: number;
  personality: BotPersonality;
  /** aggression toggle or warlike personality — permission to fight, not an
   * order to attack regardless of odds */
  alwaysWar: boolean;
  memory: OnionMemory;
}

// ---------------------------------------------------------------- tunables

/** personality modifiers (spec): weight deltas on the shared engine */
const PERSONALITY_MULT: Record<BotPersonality, Partial<Record<Constraint, number>>> = {
  balanced: {},
  techer: { research: 1.2, military: 0.9 },
  rusher: { military: 1.2, research: 0.85 },
  industrialist: { production: 1.2, treasury: 1.1 },
  expander: { expansion: 1.2, range: 1.15, military: 0.9 },
  militarist: { military: 1.2, defense: 1.15, research: 0.9 },
};

/** hysteresis: switch plans only when the challenger clears current × this */
const PIVOT: Record<BotPersonality, number> = {
  balanced: 1.15,
  techer: 1.25,
  rusher: 1.08,
  industrialist: 1.15,
  expander: 1.12,
  militarist: 1.12,
};

/** research-subject fit per binding constraint (spec §Research priority) */
const SUBJECT_FIT: Record<Constraint, Record<string, number>> = {
  expansion: { power: 8, chemistry: 6, ecology: 6, construction: 5, computers: 4, sociology: 3, physics: 2, force_fields: 1 },
  range: { chemistry: 9, power: 8, construction: 3, computers: 2, ecology: 2, sociology: 1, physics: 1, force_fields: 1 },
  research: { computers: 9, physics: 5, construction: 4, sociology: 4, power: 3, chemistry: 3, ecology: 3, force_fields: 1 },
  production: { construction: 9, chemistry: 5, power: 5, computers: 4, sociology: 3, ecology: 3, physics: 2, force_fields: 1 },
  food: { ecology: 9, chemistry: 4, construction: 3, computers: 3, sociology: 2, power: 2, physics: 1, force_fields: 1 },
  treasury: { sociology: 9, construction: 6, computers: 4, ecology: 3, chemistry: 2, power: 2, physics: 1, force_fields: 1 },
  military: { physics: 8, power: 7, force_fields: 7, computers: 7, construction: 6, chemistry: 5, sociology: 1, ecology: 1 },
  defense: { force_fields: 8, construction: 8, physics: 6, computers: 5, power: 4, chemistry: 3, sociology: 1, ecology: 1 },
};

/** applications worth targeting first inside a chosen field, per constraint */
const WANTED_APPS: Record<Constraint, string[]> = {
  expansion: ['colony_ship', 'outpost_ship', 'deuterium_fuel_cells', 'iridium_fuel_cells', 'hydroponic_farm', 'automated_factory'],
  range: ['deuterium_fuel_cells', 'iridium_fuel_cells', 'uridium_fuel_cells', 'outpost_ship', 'fusion_drive', 'ion_drive'],
  research: ['research_lab', 'supercomputer', 'holo_simulator', 'autolab'],
  production: ['automated_factory', 'robo_miner_plant', 'pollution_processor', 'robotic_factory'],
  food: ['hydroponic_farm', 'soil_enrichment', 'weather_controller', 'subterranean_farms'],
  treasury: ['space_port', 'stock_exchange', 'planetary_currency_exchange'],
  military: ['battle_pods', 'reinforced_hull', 'fusion_beam', 'mass_driver', 'tritanium_armor'],
  defense: ['star_base', 'class_i_shield', 'reinforced_hull', 'battle_pods'],
};

/** building fit per constraint (spec §Planets: build choice = marginal
 * payoff). Values are the plan bonus; intrinsic colony-state terms and a
 * cost/turns penalty are added in scoreBuild(). */
const BUILD_FIT: Record<string, Partial<Record<Constraint, number>>> = {
  colony_base: { expansion: 9 },
  colony_ship: { expansion: 8 },
  research_lab: { research: 9, expansion: 3 },
  supercomputer: { research: 8 },
  holo_simulator: { research: 4, treasury: 3 },
  astro_university: { research: 5, production: 3 },
  automated_factory: { production: 9, expansion: 4, military: 3, research: 2 },
  robo_miner_plant: { production: 7 },
  pollution_processor: { production: 4 },
  hydroponic_farm: { food: 9, expansion: 3 },
  soil_enrichment: { food: 7 },
  space_port: { treasury: 9 },
  stock_exchange: { treasury: 8 },
  star_base: { defense: 8, military: 4, treasury: 2 },
  marine_barracks: { defense: 3 },
  habitat_domes: { expansion: 3 },
  population_growth_center: { expansion: 3, food: 2 },
};

/** planet acquisition weights (spec: colonize priority artifact > ultra rich
 * > rich > gaia > large terran/ocean > … > poor/tiny only if required) */
const MINERAL_SCORE: Record<Planet['minerals'], number> = {
  ultra_rich: 22,
  rich: 16,
  abundant: 10,
  poor: 4,
  ultra_poor: 0,
};
const CLIMATE_SCORE: Record<Planet['climate'], number> = {
  gaia: 24,
  terran: 20,
  ocean: 16,
  arid: 12,
  swamp: 12,
  tundra: 8,
  desert: 8,
  barren: 4,
  energized: 2,
  hostile: 1,
};

/** minimum acquisition score a planet must clear to justify a colony ship
 * (expander lowers the bar per the spec's planet-quality-bar delta) */
const COLONIZE_BAR: Record<BotPersonality, number> = {
  balanced: 24,
  techer: 26,
  rusher: 22,
  industrialist: 24,
  expander: 16,
  militarist: 24,
};

/** hull WEIGHT a monster class demands before the fleet may try it. Ordinary
 * lairs use the engine's deterministic-clear bar (12 frigate-equivalents =
 * guaranteed no-loss win, battles.ts MONSTER_CLEAR_WEIGHT); the Guardian is
 * exempt from auto-clears and takes a real fleet; the Antarans are never
 * worth chasing. */
const MONSTER_PRICE: Record<string, number> = {
  eel: MONSTER_CLEAR_WEIGHT,
  crystal: MONSTER_CLEAR_WEIGHT,
  amoeba: MONSTER_CLEAR_WEIGHT,
  hydra: MONSTER_CLEAR_WEIGHT,
  dragon: MONSTER_CLEAR_WEIGHT,
  guardian: MONSTER_CLEAR_WEIGHT * 2,
  antaran_raider: 999,
  antaran_marauder: 999,
  antaran_intruder: 999,
  antaran_fortress: 999,
};

/** leader-skill fit per constraint (spec §Leaders: constraint_fit dominates;
 * megawealth is transformational, early spy leaders are a waste) */
const SKILL_FIT: Record<string, Partial<Record<Constraint, number>>> = {
  science_leader: { research: 8 },
  researcher: { research: 6 },
  labor_leader: { production: 8 },
  instructor: { military: 4, production: 3 },
  financial_leader: { treasury: 8 },
  megawealth: { treasury: 9, expansion: 4, research: 4, production: 4, military: 3 },
  farming_leader: { food: 8 },
  environmentalist: { food: 5, expansion: 3 },
  navigator: { range: 7, expansion: 4, military: 4 },
  helmsman: { military: 6, defense: 4 },
  weaponry: { military: 7, defense: 5 },
  ordnance: { military: 6, defense: 4 },
  fighter_pilot: { military: 4 },
  tactics: { military: 6, defense: 5 },
  commando: { military: 4 },
  operations: { military: 4, defense: 4 },
  galactic_lore: { research: 3 },
  engineer: { military: 3, defense: 3, production: 2 },
  medicine: { food: 2, expansion: 2 },
  famous: {},
  diplomat: {},
  security: { defense: 2 },
  telepath: {},
  spiritual_leader: { treasury: 3, production: 2 },
  assassin: { defense: 2 },
};

// ------------------------------------------------------------------ intel

interface FreeTarget {
  planet: Planet;
  starId: number;
  score: number;
  reachable: boolean;
  atMyStar: boolean;
  guarded: boolean;
}

interface Intel {
  bot: Empire;
  summary: selectors.EmpireSummary;
  rows: selectors.ColonyRow[]; // my real colonies, strongest yard first
  rival: Empire | null;
  atWar: boolean;
  myWar: number;
  theirWar: number;
  myStars: Set<number>;
  rivalStars: Set<number>;
  anchorStarId: number | null;
  reach: Set<number>;
  freeTargets: FreeTarget[]; // sorted best first (includes sub-bar planets)
  era: 'early' | 'mid' | 'late';
  reserve: number;
  enemyAtMyStars: number;
  farmerShare: number;
  cpHeadroom: number;
}

/** acquisition score 0..100 (spec §Planets) */
export function planetScore(planet: Planet, atMyStar: boolean, guarded: boolean): number {
  let s =
    CLIMATE_SCORE[planet.climate] +
    MINERAL_SCORE[planet.minerals] +
    planet.sizeClass * 6 +
    (planet.special === 'ancient_artifacts' ? 22 : planet.special ? 6 : 0) +
    (atMyStar ? 8 : 0);
  if (planet.gravity === 'low') s -= 3;
  if (planet.gravity === 'high') s -= 5;
  if (guarded) s -= 12; // denied until the fleet crosses the threshold
  return Math.max(0, Math.min(100, s));
}

function gatherIntel(ctx: OnionCtx): Intel | null {
  const { planned, me } = ctx;
  const bot = planned.empires.find((e) => e.id === me);
  if (!bot || bot.eliminated) return null;
  const rows = planned.colonies
    .filter((c) => c.owner === me && !c.outpost)
    .map((c) => selectors.colonyRow(planned, c))
    .sort((a, b) => b.output.prodToQueue - a.output.prodToQueue || a.id - b.id);
  const summary = selectors.empireSummary(planned, me);

  const starOf = new Map(planned.planets.map((p) => [p.id, p.starId]));
  const myStars = new Set<number>();
  for (const c of planned.colonies) {
    if (c.owner !== me) continue;
    const sid = starOf.get(c.planetId);
    if (sid !== undefined) myStars.add(sid);
  }

  // rival: the nearest other living empire (single-front doctrine; the spec's
  // multi-enemy modelling can come later — every current mode is 1-vs-1 per
  // front anyway)
  const others = planned.empires.filter((e) => e.id !== me && !e.eliminated);
  const starById = new Map(planned.stars.map((s) => [s.id, s]));
  const myStarObjs = [...myStars].map((id) => starById.get(id)!).filter(Boolean);
  const distToMe = (e: Empire): number => {
    let best = Infinity;
    for (const c of planned.colonies) {
      if (c.owner !== e.id) continue;
      const sid = starOf.get(c.planetId);
      const star = sid !== undefined ? starById.get(sid) : undefined;
      if (!star) continue;
      for (const mine of myStarObjs) best = Math.min(best, starDistance(mine, star));
    }
    return best;
  };
  const rival = others.sort((a, b) => distToMe(a) - distToMe(b) || a.id - b.id)[0] ?? null;

  const rivalStars = new Set<number>();
  if (rival) {
    for (const c of planned.colonies) {
      if (c.owner !== rival.id) continue;
      const sid = starOf.get(c.planetId);
      if (sid !== undefined) rivalStars.add(sid);
    }
  }
  const warRel = rival
    ? planned.relations.find((r) => r.a === Math.min(me, rival.id) && r.b === Math.max(me, rival.id))
    : undefined;
  const atWar = warRel?.status === 'war';

  let myWar = 0;
  let theirWar = 0;
  let enemyAtMyStars = 0;
  for (const s of planned.ships) {
    if (s.shipKind !== 'design') continue;
    if (s.owner === me) myWar++;
    if (rival && s.owner === rival.id) {
      theirWar++;
      if (s.location.kind === 'star' && myStars.has(s.location.starId)) enemyAtMyStars++;
    }
  }

  const anchorStarId = rows.length ? (starOf.get(rows[0]!.planet.id) ?? null) : null;
  const reach = new Set<number>();
  if (anchorStarId !== null) {
    for (const o of selectors.moveOptions(planned, me, anchorStarId)) {
      if (o.reachable) reach.add(o.starId);
    }
  }

  const guardedStars = new Set(planned.monsters.map((m) => m.starId));
  const freeTargets: FreeTarget[] = planned.planets
    .filter((p) => p.body === 'planet' && !planned.colonies.some((c) => c.planetId === p.id))
    .map((p) => {
      const atMyStar = myStars.has(p.starId);
      const guarded = guardedStars.has(p.starId);
      return {
        planet: p,
        starId: p.starId,
        score: planetScore(p, atMyStar, guarded),
        reachable: reach.has(p.starId) || atMyStar,
        atMyStar,
        guarded,
      };
    })
    .sort((a, b) => b.score - a.score || a.planet.id - b.planet.id);

  const era: Intel['era'] = planned.turn <= 60 ? 'early' : planned.turn <= 140 ? 'mid' : 'late';
  // opportunity + emergency reserve, scaled to the game's BC economy
  const reserve = Math.min(150 + planned.turn * 2, 600);

  let farmers = 0;
  let units = 0;
  for (const r of rows) {
    farmers += r.jobs.farmers;
    units += r.popUnits;
  }

  return {
    bot,
    summary,
    rows,
    rival,
    atWar,
    myWar,
    theirWar,
    myStars,
    rivalStars,
    anchorStarId,
    reach,
    freeTargets,
    era,
    reserve,
    enemyAtMyStars,
    farmerShare: units > 0 ? farmers / units : 0,
    cpHeadroom: summary.cpSources - summary.cpUsage,
  };
}

// ------------------------------------------------------------- constraints

function scoreConstraints(ctx: OnionCtx, intel: Intel): Record<Constraint, number> {
  const { planned } = ctx;
  const { rows, summary, freeTargets, atWar, myWar, theirWar, era, reserve, bot } = intel;
  const colonies = rows.length || 1;
  const bar = COLONIZE_BAR[ctx.personality];
  const settleable = freeTargets.filter((t) => t.score >= bar && !t.guarded);
  const reachableSettles = settleable.filter((t) => t.reachable);
  const pipeline =
    planned.ships.filter((s) => s.owner === ctx.me && s.shipKind === 'colony_ship').length +
    rows.reduce((n, r) => n + r.queue.filter((q) => q === 'colony_ship').length, 0);

  const s: Record<Constraint, number> = {
    expansion: 0,
    range: 0,
    research: 0,
    production: 0,
    food: 0,
    treasury: 0,
    military: 0,
    defense: 0,
  };

  // expansion: good reachable planets unclaimed and the pipeline is thin.
  // Urgency DECAYS with empire size (spec: pivot off pure expansion when the
  // window narrows) — without the decay a big free map keeps expansion at
  // ~91 forever, which no other constraint can displace through the 1.15×
  // hysteresis under the 100 cap (the t297 probe ended 16 colonies/17 apps).
  if (reachableSettles.length) {
    s.expansion =
      Math.min(95, 35 + 14 * Math.min(reachableSettles.length, 4)) *
      Math.max(0.45, 1 - 0.05 * rows.length);
    if (pipeline >= Math.min(3, reachableSettles.length)) s.expansion *= 0.45; // being handled
  }
  // range: worthwhile planets exist but none reachable — or the war target is
  // out of the bubble with nothing left to settle
  if (settleable.length && !reachableSettles.length) s.range = 70;
  else if (
    ctx.alwaysWar &&
    !settleable.length &&
    intel.rival &&
    intel.rivalStars.size &&
    ![...intel.rivalStars].some((id) => intel.reach.has(id))
  ) {
    s.range = 60;
  }

  // research: RP per colony below par for the era, or the rival is out-teching
  const rpPar = era === 'early' ? 4 : era === 'mid' ? 8 : 12;
  if (summary.researchPerTurn < colonies * rpPar) {
    s.research = Math.min(80, 40 + (colonies * rpPar - summary.researchPerTurn) * 2);
  }
  if (intel.rival && intel.rival.knownApps.length > bot.knownApps.length + 5) {
    s.research = Math.max(s.research, 55) + 10;
  }
  if (!selectors.researchChoices(planned, ctx.me).some((c) => c.apps.some((a) => !a.known))) s.research = 0;

  // production: the middle yard cannot finish anything in reasonable time
  const prods = rows.map((r) => r.output.prodToQueue).sort((a, b) => a - b);
  const median = prods.length ? prods[Math.floor(prods.length / 2)]! : 0;
  const prodPar = era === 'early' ? 6 : 10;
  if (median < prodPar) s.production = Math.min(70, 35 + (prodPar - median) * 5);

  // food: farmer share strangling everything else (lithovores read 0)
  if (intel.farmerShare > 0.4) s.food = Math.min(70, 30 + (intel.farmerShare - 0.4) * 150);

  // treasury: reserves are the ability to respond (spec §Treasury)
  if (bot.bc < 0) s.treasury = 95;
  else if (bot.bc < reserve * 0.5) s.treasury = 60;
  else if (bot.bc < reserve) s.treasury = 35;
  if (summary.bcDelta < 0 && bot.bc < reserve * 2) s.treasury = Math.max(s.treasury, 45);

  // military: sized against the actual threat, not a temperament quota
  if (atWar) {
    const ratio = theirWar / (myWar + 1);
    s.military = ratio > 1.5 ? 90 : ratio > 1 ? 70 : ratio > 0.7 ? 45 : 25;
  } else if (ctx.alwaysWar && intel.rival) {
    s.military = myWar < wantFleet(ctx, intel) ? 50 : 30;
  } else if (intel.rival && theirWar > myWar * 1.5 + 2) {
    s.military = 35; // peaceful but napping under a shadow
  }

  // defense: enemy hulls parked at my colony stars is an emergency
  if (intel.enemyAtMyStars > 0) s.defense = 85;
  else if (atWar && theirWar > myWar * 2 + 2) s.defense = 60;

  // personality deltas (spec §Personality modifiers)
  const mult = PERSONALITY_MULT[ctx.personality];
  for (const k of Object.keys(s) as Constraint[]) {
    s[k] = Math.min(100, s[k] * (mult[k] ?? 1));
  }
  return s;
}

/** hysteresis + emergency overrides (spec §Anti-thrash) */
function pickPlan(ctx: OnionCtx, scores: Record<Constraint, number>): Constraint {
  const mem = ctx.memory;
  const ranked = (Object.entries(scores) as Array<[Constraint, number]>).sort(
    (a, b) => b[1] - a[1] || a[0].localeCompare(b[0]),
  );
  const best = ranked[0]!;
  const current = mem.plan;
  const emergency =
    scores.defense >= 80 ||
    scores.treasury >= 90 ||
    (ctx.state.turn > 1 && !mem.wasAtWar && isAtWarNow(ctx)); // war just broke out
  if (
    current === null ||
    emergency ||
    scores[current] < 15 ||
    best[1] >= scores[current] * PIVOT[ctx.personality]
  ) {
    if (mem.plan !== best[0]) {
      mem.plan = best[0];
      mem.planSince = ctx.state.turn;
    }
  }
  return mem.plan ?? best[0];
}

function isAtWarNow(ctx: OnionCtx): boolean {
  const me = ctx.me;
  return ctx.planned.relations.some((r) => (r.a === me || r.b === me) && r.status === 'war');
}

// ---------------------------------------------------------------- research

function runResearch(ctx: OnionCtx, intel: Intel, plan: Constraint): void {
  const { planned, me } = ctx;
  const choices = selectors.researchChoices(planned, me);
  const open = choices.filter((c) => c.apps.some((a) => !a.known));
  if (!open.length) return;
  const current = choices.find((c) => c.field.num === intel.bot.research.fieldNum);
  const stale =
    intel.bot.research.fieldNum === null || !current || !current.apps.some((a) => !a.known);
  const fit = SUBJECT_FIT[plan];
  const wantedNow = WANTED_APPS[plan];
  // research toward the RESOLVER first: a field offering an app the plan is
  // actually blocked on (e.g. expansion pre-warp → cold_fusion's colony_ship)
  // outranks generic subject affinity
  const resolves = (c: (typeof open)[number]): number => {
    let best = 99;
    for (const a of c.apps) {
      if (a.known || a.dead) continue;
      const ix = wantedNow.indexOf(a.id);
      if (ix !== -1) best = Math.min(best, ix);
    }
    return best;
  };
  // min commitment: research until the tech completes — EXCEPT when the plan
  // is blocked on an app another field offers and this one is barely started
  // (spec: pivot when something else resolves the constraint better; the 25%
  // line is the disruption penalty)
  const pivotable =
    current &&
    resolves(current) === 99 &&
    open.some((c) => resolves(c) < 99) &&
    intel.bot.research.accumRP < current.cost * 0.25;
  if (!stale && !pivotable) return;
  // fit-per-RP: value = fit / listed cost, so a cheap medium-fit field beats
  // a deep expensive perfect-fit one until the cheap pool drains. The
  // instrumented probe caught strict fit ordering completing HALF of v2's
  // fields on equal research input (13f/23a vs 27f/42a at t297, 16 vs 23
  // scientists) — every subject's ladder gets pricier per rung, so a
  // constraint tunnel is also a cost tunnel. Resolver picks stay absolute:
  // a blocked plan buys its unlock at any price.
  const pick = open.sort((a, b) => {
    const r = resolves(a) - resolves(b);
    if (r !== 0) return r;
    const va = (fit[a.subject] ?? 2) / Math.max(1, a.cost);
    const vb = (fit[b.subject] ?? 2) / Math.max(1, b.cost);
    return vb - va || a.cost - b.cost || a.field.num - b.field.num;
  })[0]!;
  const live = pick.apps.filter((a) => !a.known && !a.dead);
  const wanted = WANTED_APPS[plan];
  const target = pick.grantsAll
    ? null
    : (live.sort((a, b) => {
        const ia = wanted.indexOf(a.id);
        const ib = wanted.indexOf(b.id);
        return (ia === -1 ? 99 : ia) - (ib === -1 ? 99 : ib);
      })[0]?.id ??
      pick.apps.find((a) => !a.known)?.id ??
      null);
  ctx.session.submit('set_research', { fieldNum: pick.field.num, targetApp: target });
}

// ----------------------------------------------------------------- leaders

function runLeaders(ctx: OnionCtx, intel: Intel, plan: Constraint): void {
  const { planned, me } = ctx;
  const offers = planned.leaderOffers.filter((o) => o.empireId === me && o.expiresTurn > planned.turn);
  for (const offer of offers) {
    const row = leaderById.get(offer.leaderId);
    if (!row) continue;
    let fit = 0;
    for (const sk of row.skills) {
      fit = Math.max(fit, SKILL_FIT[sk.skill]?.[plan] ?? 0);
    }
    const megawealth = row.skills.some((sk) => sk.skill === 'megawealth');
    const floor = megawealth ? intel.reserve * 0.4 : intel.reserve;
    // never hire just because BC exists (spec) — the offer must fit the
    // dominant constraint and leave the reserve standing
    if (fit >= 5 && intel.bot.bc - offer.priceBc >= floor) {
      ctx.session.submit('hire_leader', { leaderId: offer.leaderId });
    }
  }
  // colony leaders administer systems (0.16.0): seat every unassigned one at
  // the biggest colony without a governor
  for (const hired of intel.bot.leaders) {
    const row = leaderById.get(hired.leaderId);
    if (!row || row.kind !== 'colony' || hired.colonyId !== null) continue;
    const seat = intel.rows
      .filter((r) => r.leaderName === null)
      .sort((a, b) => b.popUnits - a.popUnits || a.id - b.id)[0];
    if (seat) ctx.session.submit('assign_leader', { leaderId: hired.leaderId, colonyId: seat.id });
  }
}

// ---------------------------------------------------- colonies: jobs+builds

function wantFleet(ctx: OnionCtx, intel: Intel): number {
  // smallest fleet that reliably crosses the required threshold (spec §Ships)
  const colonies = intel.rows.length;
  let want: number;
  if (intel.atWar) want = Math.max(3, Math.ceil(intel.theirWar * 1.15) + 1);
  else if (ctx.alwaysWar && intel.rival) want = Math.max(3, Math.ceil(colonies * 0.75));
  else if (intel.rival) want = Math.max(2, Math.ceil(colonies / 3));
  else want = Math.min(2, colonies); // nobody met: token patrol only
  if (ctx.personality === 'militarist') want = Math.ceil(want * 1.25);
  if (ctx.personality === 'techer') want = Math.max(2, Math.floor(want * 0.8));
  // a 2-colony economy cannot pay for a 6-hull navy: the probe watched that
  // exact fleet bleed −16 BC/turn into a −2700 BC death spiral. Threat sizing
  // only applies once the economy exists.
  if (colonies <= 3) want = Math.min(want, colonies + 1);
  return Math.min(want, Math.max(4, colonies * 3));
}

function scoreBuild(
  item: string,
  row: selectors.ColonyRow,
  plan: Constraint,
  scores: Record<Constraint, number>,
  planned: GameState,
  me: number,
): number {
  const fits = BUILD_FIT[item];
  let v = 0;
  if (fits) {
    // dominant constraint dominates; secondary constraints still pull a bit
    for (const [c, f] of Object.entries(fits) as Array<[Constraint, number]>) {
      v += f * (c === plan ? 10 : Math.min(4, scores[c] / 20));
    }
  }
  // intrinsic colony-state terms (marginal payoff, not a fixed order)
  if (item === 'automated_factory' && row.buildings.length < 2) v += 25;
  if (item === 'research_lab' && row.popUnits >= 4) v += 8;
  if (item === 'hydroponic_farm' && row.foodLack > 0) v += 30;
  if (item === 'marine_barracks') v -= 15; // militia insurance, rarely the best use of a yard
  // affordability: anything the yard cannot finish inside ~25 turns is a trap
  const cost = itemCost(planned, me, item, undefined) ?? 9999;
  const turns = cost / Math.max(1, row.output.prodToQueue);
  v -= Math.min(40, turns * 1.6);
  return v;
}

function runColonies(
  ctx: OnionCtx,
  intel: Intel,
  plan: Constraint,
  scores: Record<Constraint, number>,
): void {
  const { planned, me, session } = ctx;
  const bot = intel.bot;
  const bar = COLONIZE_BAR[ctx.personality];

  // v2-proven debt levers, shared doctrine: tax while insolvent, flip the
  // strongest yards to trade goods scaled to the hole
  const wantTax = bot.bc < -100 ? 30 : bot.bc < 0 ? 15 : 0;
  if ((bot.taxRatePct ?? 0) !== wantTax) session.submit('set_tax_rate', { pct: wantTax });
  const rescueYards = bot.bc < 0 ? Math.min(3, 1 + Math.floor(-bot.bc / 500)) : 0;
  // deep insolvency: the fleet itself is usually the bleed (upkeep + command
  // overage) — scrap the cheapest hull each turn until the books recover,
  // keeping a 2-ship token guard. Optionality (spec §Treasury) beats hulls.
  if (bot.bc < -100) {
    const hulls = planned.ships
      .filter((s) => s.owner === me && s.shipKind === 'design')
      .sort(
        (a, b) =>
          (itemCost(planned, me, `design:${a.designId}`, undefined) ?? 0) -
            (itemCost(planned, me, `design:${b.designId}`, undefined) ?? 0) || a.id - b.id,
      );
    if (hulls.length > 2) session.submit('scrap_ship', { shipId: hulls[0]!.id });
  }

  const myWarships = planned.ships.filter((s) => s.owner === me && s.shipKind === 'design').length;
  let warOrders =
    myWarships +
    intel.rows.reduce((n, r) => n + r.queue.filter((q) => q.startsWith('design:')).length, 0);
  const fleetTarget = wantFleet(ctx, intel);
  const wantMilitary = scores.military >= 25 || scores.defense >= 40 || intel.atWar;

  const settleable = intel.freeTargets.filter((t) => t.score >= bar && !t.guarded && t.reachable);
  let pipeline =
    planned.ships.filter((s) => s.owner === me && s.shipKind === 'colony_ship').length +
    intel.rows.reduce((n, r) => n + r.queue.filter((q) => q === 'colony_ship').length, 0);
  // pipeline depth scales with the actual opportunity: a rich map (many
  // reachable worthwhile worlds) runs 3-4 settlers in flight, not the flat 2
  // — rounds 1-4 lost the cafef00d rich seat every time (onion 9-13c where
  // v2 snowballed to 19-30c, twice into eliminating the onion outright)
  const wantPipeline =
    plan === 'expansion' || scores.expansion >= 40
      ? Math.min(
          2 + Math.floor(settleable.length / 4) + (ctx.personality === 'expander' ? 1 : 0),
          settleable.length,
        )
      : Math.min(1, settleable.length);

  let rank = 0;
  for (const row of intel.rows) {
    const yardRank = rank++;
    const head = row.queue[0];

    // ---- jobs: preset + scientist shifts by constraint pressure. Tuning
    // history (rounds 2-3): both scientist-allocation levers failed — full
    // 'research' at 4 buildings tanked the economy (techer −123), blend-at-4
    // was neutral on score and coincided with the tournament's only
    // elimination. The apps gap lives in FIELD CHOICE, not job share; this
    // is the round-1 allocation, kept ----
    const buildingShips = !!head && (head.startsWith('design:') || SHIP_BUILDABLES.has(head));
    const developed = row.buildings.length >= 5;
    const preset: selectors.JobPreset =
      developed && !buildingShips && (plan === 'research' || scores.research >= 40)
        ? 'research'
        : row.buildings.length >= 4 && (plan === 'research' || plan === 'treasury')
          ? 'blend'
          : 'industry';
    const jobs = selectors.presetJobs(planned, row.id, preset);
    if (jobs) {
      const units = jobs.reduce((n, g) => n + g.farmers + g.workers + g.scientists, 0);
      const shifts =
        preset === 'research'
          ? 0
          : 1 + (plan === 'research' ? 1 : 0) + Math.max(0, Math.floor((units - 10) / 6));
      for (let k = 0; k < shifts; k++) {
        const g = jobs.find((x) => x.workers > 0);
        if (g) {
          g.workers--;
          g.scientists++;
        }
      }
      session.submit('set_jobs', { colonyId: row.id, groups: jobs });
    }

    // ---- debt rescue yards mint money until solvent (but never wipe a
    // nearly finished hull — the probe lost a 90%-built colony ship to this
    // and stayed cordoned at 2 colonies for the rest of the game) ----
    if (yardRank < rescueYards) {
      const nearlyDone = row.turnsLeft !== null && row.turnsLeft <= 8;
      if (bot.bc < 0 && head !== 'trade_goods' && !nearlyDone && row.buildable.includes('trade_goods')) {
        session.submit('set_build_queue', { colonyId: row.id, items: ['trade_goods'] });
      }
      continue;
    }
    if (head === 'trade_goods' && bot.bc <= 50) continue; // still digging out

    // ---- settle our own system first: colony_base needs no ship, no fuel —
    // but only a yard that can FINISH one in ~25 turns gets it prepended (the
    // probe's 4-prod pre-warp homeworld ground on a 50-turn base while the
    // whole opening stalled behind it) ----
    const baseCost = itemCost(planned, me, 'colony_base', undefined) ?? 9999;
    if (
      row.output.prodToQueue >= 4 &&
      baseCost <= row.output.prodToQueue * 45 &&
      row.queue.length < 12 &&
      row.buildable.includes('colony_base') &&
      !row.queue.includes('colony_base') &&
      intel.freeTargets.some((t) => t.atMyStar && t.score >= bar - 8)
    ) {
      session.submit('set_build_queue', { colonyId: row.id, items: ['colony_base', ...row.queue] });
      continue;
    }

    // ---- queue decisions when the yard is free OR the head is a trap the
    // yard cannot finish in ~30 turns (min commitment protects committed
    // work, not multi-decade stalls; an unchanged verdict resubmits nothing) ----
    const stalledHead =
      !!head &&
      (row.turnsLeft === null || (row.turnsLeft > 30 && head !== 'colony_ship'));
    const redecidable = !head || head === 'trade_goods' || head === 'housing' || stalledHead;
    if (!redecidable) {
      maybeBuy(ctx, intel, row, plan, scores);
      continue;
    }

    const options = row.buildable.filter((b) => b !== 'housing' && b !== 'trade_goods' && b !== 'spy');
    if (!options.length) continue;
    const designs = options
      .filter((b) => b.startsWith('design:'))
      .sort((a, b) => (itemCost(planned, me, a, undefined) ?? 9999) - (itemCost(planned, me, b, undefined) ?? 9999));

    let item: string | undefined;

    // colony ships ride the strongest yards while the expansion window is open
    if (
      pipeline < wantPipeline &&
      yardRank < 2 &&
      row.buildable.includes('colony_ship') &&
      !row.queue.includes('colony_ship')
    ) {
      item = 'colony_ship';
      pipeline++;
    } else if (
      wantMilitary &&
      warOrders < fleetTarget &&
      designs.length &&
      row.output.prodToQueue >= 5 &&
      // never order hulls the books cannot carry: solvent, and the treasury
      // escape past command-point overage needs a real (4+ colony) economy.
      // EXCEPTION: enemies parked over our colonies suspend the accounting —
      // round 3's only elimination was an expander that kept refusing
      // warships on solvency grounds while being overrun
      (intel.enemyAtMyStars > 0 ||
        (bot.bc >= 0 && !(intel.summary.bcDelta < 0 && bot.bc < intel.reserve))) &&
      (intel.cpHeadroom > warOrders - myWarships ||
        (bot.bc > 400 && intel.rows.length >= 4) ||
        intel.enemyAtMyStars > 0)
    ) {
      // biggest hull this yard finishes in ~12 turns (frigate spam loses wars)
      const budget = (row.output.prodToQueue || 1) * 12;
      const affordable = designs.filter((d) => (itemCost(planned, me, d, undefined) ?? Infinity) <= budget);
      item = affordable[affordable.length - 1] ?? designs[0];
      warOrders++;
    } else {
      // buildings by marginal payoff under the current constraint
      const buildings = options.filter(
        (b) =>
          !SHIP_BUILDABLES.has(b) &&
          !PROJECT_BUILDABLES.has(b) &&
          !b.startsWith('design:') &&
          !b.startsWith('refit:'),
      );
      const scored = buildings
        .map((b) => ({ b, v: scoreBuild(b, row, plan, scores, planned, me) }))
        .sort((x, y) => y.v - x.v || x.b.localeCompare(y.b));
      const best = scored[0];
      const underPop = row.popUnits * 10 < row.maxPop * 7;
      if (best && best.v > 0) {
        // people first once the core stands: an underpopulated world with 4+
        // buildings grows before it gold-plates
        if (underPop && row.buildings.length >= 4 && row.buildable.includes('housing') && best.v < 12) {
          item = 'housing';
        } else {
          item = best.b;
        }
      } else if (row.buildable.includes('housing') && row.popUnits + 2 < row.maxPop) {
        item = 'housing';
      } else if (intel.cpHeadroom > warOrders - myWarships && designs.length && wantMilitary) {
        item = designs[0];
        warOrders++;
      } else {
        item = row.buildable.includes('trade_goods') ? 'trade_goods' : options[0];
      }
    }
    if (item && row.queue[0] !== item) {
      session.submit('set_build_queue', { colonyId: row.id, items: [item] });
    }
    maybeBuy(ctx, intel, row, plan, scores);
  }
}

/** rush-buy rules (spec §Planets): windows, defense, short paybacks — never
 * below the emergency reserve except to save a colony */
function maybeBuy(
  ctx: OnionCtx,
  intel: Intel,
  row: selectors.ColonyRow,
  plan: Constraint,
  scores: Record<Constraint, number>,
): void {
  if (!row.canBuy || row.buyPrice === null) return;
  const bc = intel.bot.bc;
  const price = row.buyPrice;
  const head = row.queue[0];
  if (head === undefined) return;
  const after = bc - price;
  const defenseEmergency = intel.enemyAtMyStars > 0 && (head.startsWith('design:') || head === 'star_base');
  const fits = head !== undefined ? (BUILD_FIT[head]?.[plan] ?? 0) : 0;
  if (
    (head === 'colony_ship' && after >= intel.reserve * 0.5) ||
    (defenseEmergency && after >= 0) ||
    (fits >= 6 && after >= intel.reserve) ||
    (price <= 40 && after >= intel.reserve)
  ) {
    ctx.session.submit('buy_production', { colonyId: row.id });
  }
  void scores;
}

// ------------------------------------------------------- expansion + range

function runExpansionMoves(ctx: OnionCtx, intel: Intel): void {
  const { planned, me, session } = ctx;
  const bar = COLONIZE_BAR[ctx.personality];

  // scouts chart the nearest unexplored reachable star
  const explored = new Set(intel.bot.exploredStars);
  for (const scout of planned.ships) {
    if (scout.owner !== me || scout.shipKind !== 'scout' || scout.location.kind !== 'star') continue;
    const dest = selectors
      .moveOptions(planned, me, scout.location.starId)
      .find((o) => o.reachable && !explored.has(o.starId));
    if (dest) session.submit('move_ships', { shipIds: [scout.id], destStarId: dest.starId });
  }

  // colony ships settle the BEST target, not the nearest: score first,
  // distance breaks ties (spec: a closer weaker target can beat a distant
  // better one — the cost term inside score handles guarded/poor worlds)
  const starById = new Map(planned.stars.map((s) => [s.id, s]));
  for (const ship of planned.ships) {
    if (ship.owner !== me || ship.shipKind !== 'colony_ship' || ship.location.kind !== 'star') continue;
    const here = ship.location.starId;
    const local = intel.freeTargets
      .filter((t) => t.starId === here && !t.guarded)
      .sort((a, b) => b.score - a.score)[0];
    if (local && local.score >= bar - 8) {
      session.submit('colonize', { shipId: ship.id, planetId: local.planet.id });
      continue;
    }
    const from = starById.get(here);
    const options = selectors.moveOptions(planned, me, here);
    const reachable = new Set(options.filter((o) => o.reachable).map((o) => o.starId));
    const dest = intel.freeTargets
      .filter((t) => !t.guarded && t.score >= bar - 8 && reachable.has(t.starId) && t.starId !== here)
      .sort((a, b) => {
        const da = from ? starDistance(from, starById.get(a.starId)!) : 0;
        const db = from ? starDistance(from, starById.get(b.starId)!) : 0;
        return b.score - a.score || da - db || a.starId - b.starId;
      })[0];
    if (dest) session.submit('move_ships', { shipIds: [ship.id], destStarId: dest.starId });
  }

  // outpost chain when cordoned: one ship stepping toward the best wanted
  // star (spec: range-extension colonies are a constraint fix, not a habit)
  runOutpostChain(ctx, intel);
}

function runOutpostChain(ctx: OnionCtx, intel: Intel): void {
  const { planned, me, session } = ctx;
  const bar = COLONIZE_BAR[ctx.personality];
  const settleable = intel.freeTargets.filter((t) => t.score >= bar && !t.guarded);
  const freeBlocked = settleable.length > 0 && !settleable.some((t) => t.reachable);
  const enemyBlocked =
    ctx.alwaysWar &&
    settleable.length === 0 &&
    intel.rivalStars.size > 0 &&
    ![...intel.rivalStars].some((id) => intel.reach.has(id));
  const starById = new Map(planned.stars.map((s) => [s.id, s]));
  const wantedStars = freeBlocked
    ? new Set(settleable.map((t) => t.starId))
    : enemyBlocked
      ? intel.rivalStars
      : new Set<number>();
  const goalId = wantedStars.size ? [...wantedStars].sort((a, b) => a - b)[0]! : intel.anchorStarId;
  const goal = goalId !== null ? starById.get(goalId) : undefined;

  let active = 0;
  for (const row of selectors.fleetRows(planned, me)) {
    if (row.kind !== 'outpost_ship') continue;
    if (row.canOutpostHere.length && row.atStarId !== null && !intel.myStars.has(row.atStarId)) {
      session.submit('build_outpost', { shipId: row.ship.id, planetId: row.canOutpostHere[0] });
      active++;
      continue;
    }
    if (row.atStarId === null) {
      active++;
      continue;
    }
    const dest = selectors
      .moveOptions(planned, me, row.atStarId)
      .filter(
        (o) =>
          o.reachable &&
          !intel.myStars.has(o.starId) &&
          planned.planets.some(
            (p) => p.starId === o.starId && !planned.colonies.some((c) => c.planetId === p.id),
          ) &&
          !planned.monsters.some((m) => m.starId === o.starId),
      )
      .sort((a, b) => {
        if (!goal) return a.starId - b.starId;
        const sa = starById.get(a.starId)!;
        const sb = starById.get(b.starId)!;
        return starDistance(sa, goal) - starDistance(sb, goal) || a.starId - b.starId;
      })[0];
    if (dest) {
      session.submit('move_ships', { shipIds: [row.ship.id], destStarId: dest.starId });
      active++;
    }
  }
  if (active > 0 || (!freeBlocked && !enemyBlocked)) return;
  const queued = intel.rows.some((r) => r.queue.includes('outpost_ship'));
  if (queued) return;
  const yard = intel.rows.find((r) => r.buildable.includes('outpost_ship'));
  if (yard) session.submit('set_build_queue', { colonyId: yard.id, items: ['outpost_ship', ...yard.queue] });
}

// -------------------------------------------------------------- military

function runMilitary(ctx: OnionCtx, intel: Intel, scores: Record<Constraint, number>): void {
  const { planned, me, session, memory } = ctx;
  const rival = intel.rival;
  const warships = planned.ships.filter(
    (s) => s.owner === me && s.shipKind === 'design' && s.location.kind === 'star',
  );
  // frigate-equivalent mass of one hull (monster prices are weights now)
  const myEmpire = planned.empires.find((e) => e.id === me);
  const weightOf = (s: (typeof warships)[number]): number => {
    const d = myEmpire?.designs.find((x) => x.id === s.designId);
    return d ? (HULL_WEIGHT[d.hull] ?? 0) : 0;
  };
  const myWeight = warships.reduce((n, s) => n + weightOf(s), 0);

  // guarded-prize ops (spec: attack a guardian when the win is affordable and
  // the protected system is worth it — never merely because it is beatable)
  const guardTargets = planned.monsters
    .map((m) => {
      const prize = intel.freeTargets
        .filter((t) => t.starId === m.starId)
        .reduce((n, t) => Math.max(n, planetScore(t.planet, false, false)), 0);
      return { starId: m.starId, need: MONSTER_PRICE[m.kind] ?? 12, prize };
    })
    .filter((g) => g.prize >= 55 && intel.reach.has(g.starId))
    .sort((a, b) => b.prize - a.prize || a.starId - b.starId);

  const outgunned = intel.atWar && rival && intel.theirWar > intel.myWar * 1.5 + 2;

  // -------- commitment bookkeeping: hold the strike until resolved --------
  if (memory.attackStar !== null) {
    const stillRival = rival && intel.rivalStars.has(memory.attackStar);
    const stillGuarded = planned.monsters.some((m) => m.starId === memory.attackStar);
    const lapsed = planned.turn - memory.attackSince > 25;
    if ((!stillRival && !stillGuarded) || lapsed || outgunned) memory.attackStar = null;
  }

  if (outgunned) {
    // survival: mass everything at one defended home star (v2's round-11
    // lesson holds for any brain: piecemeal hulls just feed the enemy)
    rally(ctx, intel, warships);
    runInvasions(ctx, intel); // loaded lifts still exploit any cleared sky
    return;
  }

  const fleetReady = intel.myWar >= wantFleet(ctx, intel);
  const advantage = rival ? intel.myWar / (intel.theirWar + 1) : 99;

  // declare + strike only past the threshold (spec §Aggression: 85-100
  // attack; 70-84 attack when the window closes; below — prepare)
  if (ctx.alwaysWar && rival && !intel.atWar && fleetReady && advantage >= 1.25) {
    session.submit('declare_war', { target: rival.id });
  }

  if (memory.attackStar === null) {
    if (intel.atWar && rival && fleetReady && advantage >= 1.15) {
      // pick ONE target: weakest defended, valuable, reachable
      const enemyAt = new Map<number, number>();
      for (const s of planned.ships) {
        if (s.owner === rival.id && s.shipKind === 'design' && s.location.kind === 'star') {
          enemyAt.set(s.location.starId, (enemyAt.get(s.location.starId) ?? 0) + 1);
        }
      }
      const starOf = new Map(planned.planets.map((p) => [p.id, p.starId]));
      const value = new Map<number, number>();
      for (const c of planned.colonies) {
        if (c.owner !== rival.id || c.outpost) continue;
        const sid = starOf.get(c.planetId);
        if (sid === undefined) continue;
        const pop = c.groups.reduce((n, g) => n + Math.floor(g.popK / 1000), 0);
        value.set(sid, (value.get(sid) ?? 0) + pop);
      }
      const target = [...value.entries()]
        .filter(([sid]) => intel.reach.has(sid) || warships.some((s) => s.location.kind === 'star' && s.location.starId === sid))
        .sort((a, b) => {
          const da = enemyAt.get(a[0]) ?? 0;
          const db = enemyAt.get(b[0]) ?? 0;
          return da - db || b[1] - a[1] || a[0] - b[0];
        })[0];
      if (target) {
        memory.attackStar = target[0];
        memory.attackSince = planned.turn;
      }
    } else if (!intel.atWar && guardTargets.length && myWeight >= guardTargets[0]!.need && intel.myWar >= wantFleet(ctx, intel) + 1) {
      memory.attackStar = guardTargets[0]!.starId;
      memory.attackSince = planned.turn;
    }
  }

  // execute the committed strike: 80% of the fleet converges on the one star
  // — except an ordinary lair, which gets a MINIMAL detachment meeting the
  // 12-weight deterministic-clear bar (heaviest hulls first; the rest of the
  // navy stays on station). Guardian/rival strikes keep the 80% doctrine.
  if (memory.attackStar !== null && warships.length) {
    const lairKinds = planned.monsters.filter((m) => m.starId === memory.attackStar).map((m) => m.kind);
    const ordinaryLair = lairKinds.length > 0 && lairKinds.every((k) => MONSTER_PRICE[k] === MONSTER_CLEAR_WEIGHT);
    let strike: typeof warships;
    if (ordinaryLair) {
      strike = [];
      let w = 0;
      for (const s of [...warships].sort((a, b) => weightOf(b) - weightOf(a) || a.id - b.id)) {
        if (w >= MONSTER_CLEAR_WEIGHT) break;
        strike.push(s);
        w += weightOf(s);
      }
      if (w < MONSTER_CLEAR_WEIGHT) strike = []; // cannot make the bar yet: hold and build
    } else {
      strike = warships
        .sort((a, b) => a.id - b.id)
        .slice(0, Math.max(1, Math.floor(warships.length * 0.8)));
    }
    const byStar = new Map<number, number[]>();
    for (const s of strike) {
      const from = (s.location as { starId: number }).starId;
      if (from === memory.attackStar) continue;
      (byStar.get(from) ?? byStar.set(from, []).get(from)!).push(s.id);
    }
    for (const [from, ids] of byStar) {
      const ok = selectors.moveOptions(planned, me, from).some((o) => o.reachable && o.starId === memory.attackStar);
      if (ok) session.submit('move_ships', { shipIds: ids, destStarId: memory.attackStar });
    }
  }

  runInvasions(ctx, intel);
  void scores;
}

function rally(ctx: OnionCtx, intel: Intel, warships: GameState['ships']): void {
  const { planned, me, session } = ctx;
  if (!warships.length || !intel.myStars.size) return;
  const enemyAt = new Map<number, number>();
  const mineAt = new Map<number, number>();
  for (const s of planned.ships) {
    if (s.shipKind !== 'design' || s.location.kind !== 'star') continue;
    if (s.owner === me) mineAt.set(s.location.starId, (mineAt.get(s.location.starId) ?? 0) + 1);
    else if (intel.rival && s.owner === intel.rival.id)
      enemyAt.set(s.location.starId, (enemyAt.get(s.location.starId) ?? 0) + 1);
  }
  const muster = [...intel.myStars].sort(
    (a, b) => (enemyAt.get(a) ?? 0) - (enemyAt.get(b) ?? 0) || (mineAt.get(b) ?? 0) - (mineAt.get(a) ?? 0) || a - b,
  )[0]!;
  const byStar = new Map<number, number[]>();
  for (const s of warships) {
    const from = (s.location as { starId: number }).starId;
    if (from === muster) continue;
    (byStar.get(from) ?? byStar.set(from, []).get(from)!).push(s.id);
  }
  for (const [from, ids] of byStar) {
    const ok = selectors.moveOptions(planned, me, from).some((o) => o.reachable && o.starId === muster);
    if (ok) session.submit('move_ships', { shipIds: ids, destStarId: muster });
  }
}

/** ground war: single decisive waves at cleared skies (doctrine shared with
 * v2 because it is physics, not preference: piecemeal drops get repelled) */
function runInvasions(ctx: OnionCtx, intel: Intel): void {
  const { planned, me, session } = ctx;
  const rival = intel.rival;
  if (!rival || !intel.atWar) return;
  const starOf = (planetId: number) => planned.planets.find((p) => p.id === planetId)?.starId ?? null;
  const myWarAt = new Set<number>();
  const theirGuardAt = new Set<number>();
  for (const s of planned.ships) {
    if (s.location.kind !== 'star') continue;
    if (s.owner === me && s.shipKind === 'design') myWarAt.add(s.location.starId);
    if (s.owner === rival.id && (s.shipKind === 'design' || s.shipKind === 'scout')) theirGuardAt.add(s.location.starId);
  }
  const cleared = planned.colonies
    .filter((c) => c.owner === rival.id && !c.outpost)
    .map((c) => {
      const sid = starOf(c.planetId);
      const pop = c.groups.reduce((n, g) => n + Math.floor(g.popK / 1000), 0);
      const militia = marinesOf(c) + Math.ceil(pop / 2);
      return { starId: sid, militia };
    })
    .filter((t): t is { starId: number; militia: number } => t.starId !== null && myWarAt.has(t.starId) && !theirGuardAt.has(t.starId))
    .sort((a, b) => a.militia - b.militia || a.starId - b.starId);
  const best = cleared[0] ?? null;

  // transports launch pre-boarded with a marine squad — no loading step;
  // the invade battle order (below) lands them after a won pass
  const transports = planned.ships.filter((s) => s.owner === me && s.shipKind === 'transport' && shipMarines(s) > 0);
  const readyWave = transports.filter((t) => t.location.kind === 'star');
  const waveTroops = readyWave.reduce((n, t) => n + shipMarines(t), 0);
  if (best && waveTroops > best.militia + 2) {
    for (const t of readyWave) {
      if (t.location.kind === 'star' && t.location.starId === best.starId) continue;
      session.submit('move_ships', { shipIds: [t.id], destStarId: best.starId });
    }
  }

  const wantLift = Math.min(8, Math.max(2, Math.ceil(((best?.militia ?? 8) + 3) / 4)));
  const queued = intel.rows.reduce((n, r) => n + r.queue.filter((q) => q === 'transport').length, 0);
  if (intel.myWar < 4 || transports.length + queued >= wantLift) return;
  const yard = intel.rows.find((r) => r.buildable.includes('transport') && !r.queue.includes('transport'));
  if (yard) session.submit('set_build_queue', { colonyId: yard.id, items: [...yard.queue, 'transport'] });
}

// ------------------------------------------------------------ entry points

/** one full planning turn (SoloBot delegates here when brain === 'onion') */
export function onionTurn(ctx: OnionCtx): void {
  const intel = gatherIntel(ctx);
  if (!intel) return;
  const scores = scoreConstraints(ctx, intel);
  const plan = pickPlan(ctx, scores);
  ctx.memory.wasAtWar = intel.atWar;

  runResearch(ctx, intel, plan);
  runLeaders(ctx, intel, plan);
  runColonies(ctx, intel, plan, scores);
  runExpansionMoves(ctx, intel);
  runMilitary(ctx, intel, scores);
}

/** battle orders for one pending battle (called from SoloBot.orderBattles) */
/** Attacker's engagement pick (0.22.0): assault the defender's weakest-
 * defended colony at the star (fewest defensive structures; populated
 * colonies before outposts), or null when the defender holds no colony there
 * — a pure deep-space fleet hunt. */
export function pickAssaultPlanet(state: GameState, defenderId: number, starId: number): number | null {
  if (defenderId < 0) return null;
  const DEFENSES = ['star_base', 'battle_station', 'star_fortress', 'missile_base', 'ground_batteries'];
  const holdings = state.colonies.filter(
    (c) => c.owner === defenderId && state.planets.some((p) => p.id === c.planetId && p.starId === starId),
  );
  if (!holdings.length) return null;
  const pool = holdings.some((c) => !c.outpost) ? holdings.filter((c) => !c.outpost) : holdings;
  return pool.sort(
    (a, b) =>
      a.buildings.filter((x) => DEFENSES.includes(x)).length - b.buildings.filter((x) => DEFENSES.includes(x)).length ||
      a.id - b.id,
  )[0]!.planetId;
}

/** Formation pick (0.23.0): attackers with big fleets (>= 8 hulls) flank or
 * envelop (seeded by battle id — no rng handle here), defenders with orbital
 * defenses form a line; everyone else stays massed (absent field = classic). */
export function pickFormation(
  state: GameState,
  me: number,
  battle: { id: string; starId: number; attacker: number; defender: number },
  myHulls: number,
): 'line' | 'flank' | 'envelop' | undefined {
  if (battle.attacker === me) {
    if (myHulls < 8) return undefined;
    let h = 0;
    for (let i = 0; i < battle.id.length; i++) h = (h * 31 + battle.id.charCodeAt(i)) >>> 0;
    return h % 2 === 0 ? 'flank' : 'envelop';
  }
  const DEFENSES = ['star_base', 'battle_station', 'star_fortress', 'missile_base', 'ground_batteries'];
  const hasBase = state.colonies.some(
    (c) =>
      c.owner === me &&
      state.planets.some((p) => p.id === c.planetId && p.starId === battle.starId) &&
      c.buildings.some((b) => DEFENSES.includes(b)),
  );
  return hasBase ? 'line' : undefined;
}

export function onionBattleOrders(
  state: GameState,
  me: number,
  battle: { id: string; starId: number; attacker: number; defender: number },
  personality: BotPersonality,
): {
  stance: string;
  priority: string;
  retreatThresholdPct: number;
  bombard: boolean;
  invade: boolean;
  engagePlanetId: number | null;
  formation?: string;
} {
  const foe = battle.attacker === me ? battle.defender : battle.attacker;
  const hullsAt = (owner: number) =>
    state.ships.filter(
      (s) => s.owner === owner && s.shipKind === 'design' && s.location.kind === 'star' && s.location.starId === battle.starId,
    ).length;
  const mine = hullsAt(me);
  const theirs = foe >= 0 ? hullsAt(foe) : 0;
  // a hopeless defense warps out and lives to mass with the rally
  const doomed = foe >= 0 && theirs > mine * 2 + 1;
  const advantage = mine / Math.max(1, theirs);
  const formation = doomed ? undefined : pickFormation(state, me, battle, mine);
  return {
    stance: doomed ? 'evade_retreat' : battle.attacker === me || advantage >= 1.2 ? 'charge' : 'hold_range',
    priority: advantage >= 1.5 ? 'deadliest' : 'nearest',
    retreatThresholdPct: personality === 'militarist' || personality === 'rusher' ? 15 : 25,
    bombard: !doomed && battle.attacker === me,
    // marines in orbit always land on a win — the lift was sent to invade
    invade: !doomed && battle.attacker === me,
    // engagement: an attacker meaning conquest assaults the weakest-defended
    // colony; a doomed attacker stays in deep space (it is fleeing anyway);
    // a defender always meets the fleet
    engagePlanetId:
      battle.attacker === me && !doomed ? pickAssaultPlanet(state, battle.defender, battle.starId) : null,
    // big attacking fleets flank/envelop; defenders with a base form a line
    ...(formation ? { formation } : {}),
  };
}
