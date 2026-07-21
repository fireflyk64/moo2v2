// Single-player bot: a deliberately simple opponent driven entirely through
// the normal command log, so the simulation never special-cases it.
//
// Two modes:
//   'parity' — keeps up via visible, replayable debug-command grants:
//     research parity (learns whatever the human knows), expansion parity
//     (founds the nearest free colony when the human expands), and a 100 BC
//     stipend when broke. Copies the human's ship designs.
//   'fair'   — no help at all: researches on its own, builds colony ships and
//     settles free planets with ordinary commands, spends its own money.
// Everything else is ordinary play in both modes: the tuned build brain (v2)
// keeps colonies fed and working, expands with real colony ships, keeps a
// fleet, occasionally buys production, and — in aggressive mode — throws half
// its warfleet at the human's nearest systems. (Before the v2 brain applied
// to parity, that bot built RANDOM items and never sailed the colony ships it
// happened to build, so it sat on one system all game.)

import { marinesOf, selectors, shipMarines, starDistance } from '@engine/index';
import { itemCost, SHIP_BUILDABLES, PROJECT_BUILDABLES } from '@engine/items';
import type { Empire, GameState } from '@engine/types';
import type { GameSession } from '@protocol/session';
import { botRaceById, botRacePicks } from './botRaces';
import { freshOnionMemory, onionBattleOrders, onionTurn, planetScore, type OnionMemory } from './onionBot';

export type BotMode = 'parity' | 'fair';
/** fair-bot strategy generation: v1 = the original random-build brain (kept
 * as the self-play benchmark), v2 = the tuned brain that beats it, onion =
 * the constraint-driven Tech Fortress doctrine (onionBot.ts, bugs/ai_plan.md) */
export type BotBrain = 'v1' | 'v2' | 'onion';
/** deterministic play-style profiles so the bots don't all play the same */
export type BotPersonality = 'balanced' | 'techer' | 'rusher' | 'industrialist' | 'expander' | 'militarist';

interface Profile {
  /** min scientists forced per developed colony (research emphasis) */
  scienceBias: number;
  /** target warships as a fraction of colonies */
  fleetRatio: number;
  /** colony-ship pipeline depth */
  expand: number;
  /** always aggressive regardless of the toggle */
  warlike: boolean;
  /** prefers buying production */
  buyEager: boolean;
}

const PROFILES: Record<BotPersonality, Profile> = {
  balanced: { scienceBias: 1, fleetRatio: 1, expand: 3, warlike: false, buyEager: false },
  // (onion round 5 tried techer scienceBias 2 — the bias-≥2 blend flip at 3
  // buildings starves the opening, techer fell another −38; reverted)
  techer: { scienceBias: 1, fleetRatio: 0.6, expand: 3, warlike: false, buyEager: false },
  // rusher/militarist expand raised 1→2 / 2→3 after the onion round-1
  // tournament: both war personalities lost every mirror to the OnionAI by
  // colony starvation (7-10c vs 12-15c) while their aggression achieved no
  // conquest — a war economy still needs settlers. Rusher 2→3 (07-21, same
  // lever): the r7 log left it as v2's designated loser mirror (−89, still
  // starved at 8c vs the onion's 18c on the 0.20 re-baseline), so it now
  // matches the militarist's kept depth — see bugs/tournament/LOG.md
  rusher: { scienceBias: 0, fleetRatio: 1.5, expand: 3, warlike: true, buyEager: true },
  industrialist: { scienceBias: 0, fleetRatio: 1, expand: 2, warlike: false, buyEager: true },
  expander: { scienceBias: 1, fleetRatio: 0.7, expand: 6, warlike: false, buyEager: true },
  militarist: { scienceBias: 0, fleetRatio: 2, expand: 3, warlike: true, buyEager: true },
};

const PERSONALITIES: BotPersonality[] = ['techer', 'rusher', 'industrialist', 'expander', 'militarist'];

/** Mirror catch-up pacing. Escorts per turn stays well under the engine's
 * 20-per-command cap — a big deficit closes over a few turns instead of
 * materializing as a wall. The DEADBAND/SURPLUS pair is load-bearing:
 * the first mirror proof run used a naive deficit>0 trigger and LOST its
 * control match 374-417 with identical hull counts — petty ±1 grants bled
 * upkeep while exact parity never crossed the brains' own attack thresholds
 * (the onion strikes at 1.15×). Now only a >DEADBAND deficit triggers, and
 * the refill overshoots to +SURPLUS so the escorts can escort and hunt.
 * SURPLUS <= DEADBAND keeps two catch-up bots from ratcheting each other:
 * at +2 surplus neither is 3 behind, so both go quiet. */
const MIRROR_ESCORTS_PER_TURN = 5;
const MIRROR_WAR_DEADBAND = 2;
const MIRROR_WAR_SURPLUS = 2;
const MIRROR_SETTLER_EVERY = 5;

/** building priority for the v2 brain, taken from the opening a winning human
 * game actually played (bugs/moo2v2-SOLO-turn297.moo2save, turns 1–120);
 * anything not listed falls back to cheapest-first */
export const BUILD_ORDER = [
  'automated_factory',
  'research_lab',
  'hydroponic_farm',
  'soil_enrichment',
  'habitat_domes',
  'population_growth_center',
  'star_base',
  'supercomputer',
  'holo_simulator',
  'pollution_processor',
  'robo_miner_plant',
  'stock_exchange',
  'astro_university',
];

export interface SoloBotOptions {
  session: GameSession<GameState>;
  /** explicit race config: wins over `race`; never rescaled to the budget */
  raceJson?: string;
  /** 'parity' (default) uses logged debug grants; 'fair' never cheats */
  mode?: BotMode;
  /** strategy version (fair mode); default v2 */
  brain?: BotBrain;
  /** play-style; 'auto' picks one deterministically from the seat */
  personality?: BotPersonality | 'auto';
  /** bot race: an archetype id (botRaces.ts, rescales to the lobby's pick
   * budget) or a stock preset id; default the hivex preset */
  race?: string;
  /** banner color (#rrggbb) — rides the raceJson like a human's choice */
  color?: string;
  /** fleet silhouette (shipstyles.ts id) — submitted as set_ship_style on
   * the bot's first turn, exactly like a human using the Empires screen */
  shipStyle?: string;
  /** mirror-mode catch-up grants (default true). The grants only ever fire
   * when the game's settings have BOTH mirror and debugCommands on; this
   * flag exists so tests can field a control bot with the catch-up off. */
  mirrorCatchUp?: boolean;
}

/** deterministic-enough tiny PRNG for bot whims (commands are logged anyway) */
function whim(seedA: number, seedB: number): () => number {
  let s = (seedA * 2654435761 + seedB * 40503 + 1) >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 0x100000000;
  };
}

export class SoloBot {
  private readonly session: GameSession<GameState>;
  readonly mode: BotMode;
  readonly brain: BotBrain;
  personality: BotPersonality;
  private requestedPersonality: BotPersonality | 'auto';
  private profile: Profile;
  private aggressive = false;
  private lastPlayedTurn = 0;
  private orderedBattles = new Set<string>();
  private unsub: (() => void) | null = null;
  private readonly explicitRaceJson: string | null;
  private readonly race: string | null;
  private readonly color: string | null;
  private readonly shipStyle: string | null;
  private styleSubmitted = false;
  private readonly mirrorCatchUp: boolean;
  /** turn of the last mirror catch-up colony-ship grant (rate limiter) */
  private lastSettlerGrantTurn = -99;
  /** diagnostics for the mirror proof test: totals of catch-up grants */
  mirrorEscortsGranted = 0;
  mirrorSettlersGranted = 0;
  /** cross-turn plan/commitment state for the onion brain */
  private onionMemory: OnionMemory = freshOnionMemory();

  constructor(opts: SoloBotOptions) {
    this.session = opts.session;
    this.mode = opts.mode ?? 'parity';
    this.brain = opts.brain ?? 'v2';
    this.requestedPersonality = opts.personality ?? 'balanced';
    // resolved lazily once the seat is assigned (auto varies by seat)
    this.personality = this.requestedPersonality === 'auto' ? 'balanced' : this.requestedPersonality;
    this.profile = PROFILES[this.personality];
    this.explicitRaceJson = opts.raceJson ?? null;
    this.race = opts.race ?? null;
    this.color = opts.color ?? null;
    this.shipStyle = opts.shipStyle ?? null;
    this.mirrorCatchUp = opts.mirrorCatchUp ?? true;
    this.session.setRaceConfig(this.desiredRaceJson(), true);
    this.unsub = this.session.subscribe((ev) => {
      if (ev.type === 'lobby') {
        // re-send only while the roster disagrees with what we want — an
        // unconditional send here would echo lobby updates forever. The
        // comparison also rescales archetype picks whenever the host changes
        // the pick-point setting (desiredRaceJson reads the live settings).
        const self = this.session.getRoster().find((p) => p.id === this.session.playerId);
        const desired = this.desiredRaceJson();
        if (self && (!self.ready || self.raceJson !== desired)) this.session.setRaceConfig(desired, true);
      }
      if (ev.type === 'started' || ev.type === 'turn-advanced' || ev.type === 'state' || ev.type === 'commit-status') {
        this.maybePlay();
      }
    });
  }

  /** The raceJson this bot wants right now: an explicit raceJson verbatim-ish
   * (color/style merged in), an archetype scaled to the CURRENT pick budget,
   * or a stock preset — always the same string for the same inputs, so the
   * lobby-echo guard above can compare against the roster. */
  private desiredRaceJson(): string {
    const cfg: Record<string, unknown> = this.explicitRaceJson
      ? (JSON.parse(this.explicitRaceJson) as Record<string, unknown>)
      : {};
    if (!this.explicitRaceJson) {
      const budget = this.session.getSettings()?.pickPoints ?? 10;
      const archetype = this.race ? botRaceById.get(this.race) : undefined;
      const picks = this.race ? botRacePicks(this.race, budget) : null;
      if (archetype && picks) {
        cfg['picks'] = picks;
        cfg['raceName'] = archetype.name;
      } else {
        cfg['presetId'] = this.race ?? 'hivex';
      }
    }
    if (this.color) cfg['color'] = this.color;
    return JSON.stringify(cfg);
  }

  close(): void {
    this.unsub?.();
    this.unsub = null;
  }

  /** the empire seat this bot plays (assigned by the host's welcome) */
  get seatId(): number {
    return this.session.playerId;
  }

  setAggressive(on: boolean): void {
    this.aggressive = on;
    // new stance applies immediately on the current turn
    if (this.session.getState()) this.lastPlayedTurn = 0;
    this.maybePlay();
  }

  isAggressive(): boolean {
    return this.aggressive;
  }

  /** diagnostic peek for probes/tests: the onion brain's current plan */
  get onionPlan(): string | null {
    return this.brain === 'onion' ? this.onionMemory.plan : null;
  }

  /** Play the current turn once: issue orders, then commit. */
  private maybePlay(): void {
    const state = this.session.getState();
    if (!state || state.winner !== null) return;
    if (state.phase !== 'planning') {
      this.orderBattles(state);
      return;
    }
    // campaign timelapse: a bot has no secrets — the moment any human opts
    // in, the bot seconds the motion so tables only ever wait on humans
    const votes = state.timelapseVotes ?? [];
    if (votes.length > 0 && !votes.includes(this.session.playerId)) this.submit('timelapse_vote', {});
    if (state.turn === this.lastPlayedTurn) return;
    this.lastPlayedTurn = state.turn;
    this.orderedBattles.clear();
    try {
      this.playTurn(state);
    } finally {
      this.session.commitTurn();
    }
  }

  private submit(kind: string, payload: unknown): { error?: string } {
    return this.session.submit(kind, payload); // rejections are fine — the bot shrugs
  }

  private playTurn(state: GameState): void {
    const me = this.session.playerId;
    if (this.requestedPersonality === 'auto' && me >= 0) {
      this.personality = PERSONALITIES[me % PERSONALITIES.length]!;
      this.profile = PROFILES[this.personality];
      this.requestedPersonality = this.personality; // resolved once
    }
    // chosen fleet look: one ordinary set_ship_style, same as a human would
    // send from the Empires screen (cosmetic only — no engine special case)
    if (this.shipStyle && !this.styleSubmitted) {
      this.styleSubmitted = true;
      this.submit('set_ship_style', { style: this.shipStyle });
    }
    const prof = this.profile;
    const alwaysWar = this.aggressive || prof.warlike;
    const human = state.empires.find((e) => e.id !== me && !e.eliminated);
    const bot = state.empires.find((e) => e.id === me);
    if (!bot || !human) return;
    const rand = whim(state.turn, me);
    const warRel = state.relations.find(
      (r) => r.a === Math.min(me, human.id) && r.b === Math.max(me, human.id),
    );
    const atWar = warRel?.status === 'war';
    // threat-responsive defense: peacetime fleet appetite is a personality
    // trait, but an empire at war AND OUTGUNNED keeps a real navy no matter
    // its temperament — the round-3 tournament fed the expander (fleetRatio
    // 0.5, ~10 hulls guarding 25 colonies) to anyone who declared: eliminated
    // twice, last place. Round 4 floored the ratio for anyone merely at war
    // and that homogenized the personalities (tournament bots declare on turn
    // 1, so balanced and techer played identical games) and sank every
    // economy — hence the outgunned gate.
    const myWarCount = state.ships.filter((s) => s.owner === me && s.shipKind === 'design').length;
    const theirWarCount = state.ships.filter((s) => s.owner === human.id && s.shipKind === 'design').length;
    const outgunned = atWar && theirWarCount > myWarCount * 1.2 + 2;
    const fleetRatio = outgunned ? Math.max(this.profile.fleetRatio, 1.25) : this.profile.fleetRatio;

    // ---- concession: wars must be able to END. Bombard spares the last pop
    // unit and invasions grind, so a truly beaten empire offers formal
    // surrender (the winner absorbs the realm) instead of dragging a decided
    // game out for hundreds of turns. Thresholds are deliberately brutal —
    // a satisfying opponent fights hard and concedes only when crushed. ----
    for (const prop of state.proposals ?? []) {
      if (prop.to === me && prop.kind === 'surrender') {
        this.submit('diplo_respond', { proposalId: prop.id, accept: true });
      }
    }
    if (state.turn >= 250) {
      const myCol = state.colonies.filter((c) => c.owner === me && !c.outpost).length;
      const theirCol = state.colonies.filter((c) => c.owner === human.id && !c.outpost).length;
      // 2×+4 warships, not the old 4×+8: the round-11 survival brain flees
      // doomed battles, so a crushed empire keeps a token fleet forever and
      // the 4× deficit never arrives — every round-11 rr game timed out with
      // the winner 2-3× ahead on everything else
      const hopeless = atWar && theirCol >= myCol * 2 + 5 && theirWarCount >= myWarCount * 2 + 4;
      const alreadyOffered = (state.proposals ?? []).some((p) => p.from === me && p.kind === 'surrender');
      if (hopeless && !alreadyOffered) this.submit('diplo_propose', { to: human.id, kind: 'surrender' });
    }

    if (this.mode === 'parity') {
      // ---- stipend: broke bots get 100 BC (logged, no sim special case) ----
      if (bot.bc <= 0) this.submit('debug_add_bc', { amount: 100 });

      // ---- research parity: learn everything the human knows ----
      for (const app of human.knownApps) {
        if (!bot.knownApps.includes(app)) this.submit('debug_grant_app', { appId: app });
      }
    }

    // ---- mirror catch-up (bugs.md: "mirror AI mode should be quite
    // difficult since it can play catch-up if it falls behind"): in a mirror
    // game with debugCommands on, a bot that is outgunned tops its warfleet
    // up toward the strongest enemy's with logged debug_spawn_ships escorts
    // (its best current design, at its strongest colony, a few per turn)
    // and gets a colony ship every few turns while behind on colonies/pop.
    // The granted hulls are ordinary ships: whichever brain runs below
    // rallies, strikes and settles with them ("fly around and cause
    // havoc"). Gated purely on the game settings, so it works for fair and
    // onion bots alike; net.ts switches debugCommands on for solo mirror
    // games. ----
    if (this.mirrorCatchUp && state.settings.mirror && state.settings.debugCommands) {
      this.mirrorTopUp(state, me, bot);
    }

    // ---- onion brain: the constraint-driven doctrine owns the whole turn
    // (research, colonies, expansion, military) — shared shell above (lobby,
    // commit, concession hygiene, parity grants) stays identical for A/B
    // fairness against the v2 brain ----
    if (this.brain === 'onion') {
      onionTurn({
        session: this.session,
        state,
        planned: this.session.getPlanned() ?? state,
        me,
        personality: this.personality,
        alwaysWar,
        memory: this.onionMemory,
      });
      return;
    }
    // keep the labs pointed somewhere so banked RP is not wasted. Re-pick
    // whenever the current selection has nothing left to teach — the old
    // null-only gate let a turn-1 pick go stale for the whole game (the
    // turn-297 save's bot sat on one field with zero scientists for 296
    // turns and never learned a single app).
    {
      const planned = this.session.getPlanned() ?? state;
      const choices = selectors.researchChoices(planned, me);
      const open = choices.filter((c) => c.apps.some((a) => !a.known));
      const current = choices.find((c) => c.field.num === bot.research.fieldNum);
      const stale = bot.research.fieldNum === null || !current || !current.apps.some((a) => !a.known);
      if (open.length && stale) {
        // v2: cheapest field first — quick breakthroughs compound; techers
        // still take the cheapest (fast tech throughput); v1: random
        const pick =
          this.brain === 'v2'
            ? open.sort((a, b) => a.cost - b.cost || a.field.num - b.field.num)[0]!
            : open[Math.floor(rand() * open.length)]!;
        // dead picks (morale tech under Unification) would be rejected —
        // target the first LIVE unknown app, falling back only if none exist
        const target = pick.grantsAll
          ? null
          : (pick.apps.find((a) => !a.known && !a.dead)?.id ?? pick.apps.find((a) => !a.known)?.id ?? null);
        this.submit('set_research', { fieldNum: pick.field.num, targetApp: target });
      }
    }

    if (this.mode === 'parity') {
      // ---- expansion parity: human has more colonies -> found the nearest free planet ----
      const humanColonies = state.colonies.filter((c) => c.owner === human.id && !c.outpost).length;
      const botColonies = state.colonies.filter((c) => c.owner === me && !c.outpost).length;
      if (humanColonies > botColonies) {
        const target = this.nearestFreePlanet(state, me);
        if (target !== null) this.submit('debug_found_colony', { planetId: target });
      }

      // ---- copy the human's ship designs (post-parity, components are known) ----
      const botDesignNames = new Set(bot.designs.filter((d) => !d.obsolete).map((d) => d.name));
      for (const d of human.designs) {
        if (d.obsolete || botDesignNames.has(d.name)) continue;
        this.submit('save_design', {
          name: d.name,
          hull: d.hull,
          computer: d.computer,
          shield: d.shield,
          specials: [...d.specials],
          weapons: d.weapons.map((w) => ({ weapon: w.weapon, count: w.count, mods: [...w.mods] })),
        });
      }
    }

    // ---- per-colony: jobs, builds, buys ----
    const planned = this.session.getPlanned() ?? state;
    const v2 = this.brain === 'v2';
    const myWarships = planned.ships.filter((s) => s.owner === me && s.shipKind === 'design').length;
    const queuedWarships = planned.colonies.reduce(
      (n, c) => n + (c.owner === me ? c.queue.filter((q) => q.item.startsWith('design:')).length : 0),
      0,
    );
    let warOrders = myWarships + queuedWarships;
    const myColonies = planned.colonies.filter((c) => c.owner === me && !c.outpost).length;
    // command-point headroom: overage bleeds 10 BC/point/turn, and the
    // tournament probe showed bots at cp 8/3 rebuilding dead warships into a
    // permanent −30 BC/turn spiral. Only a rich treasury may run a deficit.
    const cpSummary = selectors.empireSummary(planned, me);
    // warlike profiles pay for menace: up to 4 points of overage (−40 BC/turn)
    // is acceptable while the books are healthy — a hard gate left the
    // militarist with zero warships (personalities distinctness gate)
    const cpHeadroom =
      cpSummary.cpSources - cpSummary.cpUsage + ((prof.warlike || outgunned) && bot.bc > 100 ? 4 : 0);
    // v2 walks colonies by production so the shipyards get the military work
    const ordered = v2
      ? [...planned.colonies].sort((a, b) => {
          if (a.owner !== me || a.outpost) return 1;
          if (b.owner !== me || b.outpost) return -1;
          const pa = selectors.colonyRow(planned, a).output.prodToQueue;
          const pb = selectors.colonyRow(planned, b).output.prodToQueue;
          return pb - pa || a.id - b.id;
        })
      : planned.colonies;
    // v2 debt handling. Two levers, both reclaimed once solvent:
    //   1. empire tax (prod -> BC at 2:1) while the treasury is negative —
    //      the human's own fix in the benchmark game (set_tax_rate);
    //   2. the strongest yards flip to trade goods, SCALED to the hole: the
    //      297-turn tournament baseline showed one yard cannot out-earn an
    //      empire-wide bleed (bots finished at −2000..−4600 BC, no fleet).
    if (v2) {
      const wantTax = bot.bc < -100 ? 30 : bot.bc < 0 ? 15 : 0;
      if ((bot.taxRatePct ?? 0) !== wantTax) this.submit('set_tax_rate', { pct: wantTax });
    }
    const rescueYards = v2 && bot.bc < 0 ? Math.min(3, 1 + Math.floor(-bot.bc / 500)) : 0;
    let yardRank = 0;
    for (const colony of ordered) {
      if (colony.owner !== me || colony.outpost) continue;
      const rank = yardRank++;
      const head0 = colony.queue[0]?.item;
      // jobs: shipyard work keeps hands on the tools; developed worlds with
      // nothing important to build flip to pure research (the tournament
      // baseline plateaued at ~30 apps by turn 297 vs the human's 131 —
      // industry/blend presets never freed the labs)
      const buildingShips = !!head0 && (head0.startsWith('design:') || SHIP_BUILDABLES.has(head0));
      const developed = colony.buildings.length >= 5;
      // high-bias profiles flip to blend a building earlier — from turn 1
      // ("scienceBias >= 2" unconditionally) fails the 120-turn viability
      // gate: pure blend before the factory exists starves the whole opening
      const techy = v2 && colony.buildings.length >= (prof.scienceBias >= 2 ? 3 : 4);
      const preset = v2 && developed && !buildingShips ? 'research' : techy ? 'blend' : 'industry';
      const jobs = selectors.presetJobs(planned, colony.id, preset);
      if (jobs) {
        // shift workers into research (kept fed). Every profile keeps at
        // least one scientist — and GROWN colonies staff real labs (extra
        // per 6 pop beyond the first 10): the tournament plateaued at ~38
        // apps by turn 297 on token science, but front-loading scientists
        // instead tanks the early economy (selfplay gate caught that).
        const units = jobs.reduce((n, g) => n + g.farmers + g.workers + g.scientists, 0);
        const shifts =
          preset === 'research'
            ? 0
            : v2
              ? Math.max(1, prof.scienceBias) + Math.max(0, Math.floor((units - 10) / 6))
              : 1;
        for (let k = 0; k < shifts; k++) {
          const g = jobs.find((x) => x.workers > 0);
          if (g) {
            g.workers--;
            g.scientists++;
          }
        }
        this.submit('set_jobs', { colonyId: colony.id, groups: jobs });
      }
      if (v2 && rank < rescueYards) {
        if (bot.bc < 0 && head0 !== 'trade_goods') {
          this.submit('set_build_queue', { colonyId: colony.id, items: ['trade_goods'] });
          continue;
        }
      }
      if (v2 && head0 === 'trade_goods' && bot.bc <= 50) continue; // still digging out
      if (colony.queue.length === 0 || (v2 && colony.queue[0]?.item === 'trade_goods' && bot.bc > 50)) {
        const row = selectors.colonyRow(planned, colony);
        const options = row.buildable.filter((b) => b !== 'housing' && b !== 'trade_goods' && b !== 'spy');
        if (!options.length) continue;
        if (v2) {
          // priorities: keep a real fleet (≥1 warship per colony — the wars
          // are lost without one), then buildings in the opening order a
          // winning human game actually used (turn-297 save: factory, lab,
          // farm, then growth/economy), then the cheapest of the rest
          const buildings = options
            .filter((b) => !SHIP_BUILDABLES.has(b) && !PROJECT_BUILDABLES.has(b) && !b.startsWith('design:') && !b.startsWith('refit:'))
            .sort((a, b) => {
              const pa = BUILD_ORDER.indexOf(a);
              const pb = BUILD_ORDER.indexOf(b);
              if (pa !== pb) return (pa === -1 ? 99 : pa) - (pb === -1 ? 99 : pb);
              return (itemCost(planned, me, a, colony) ?? 9999) - (itemCost(planned, me, b, colony) ?? 9999);
            });
          const designs = options
            .filter((b) => b.startsWith('design:'))
            .sort((a, b) => (itemCost(planned, me, a, colony) ?? 9999) - (itemCost(planned, me, b, colony) ?? 9999));
          const wantFleet = Math.ceil(myColonies * fleetRatio);
          let item: string | undefined;
          if (warOrders < wantFleet && designs.length && (cpHeadroom > warOrders - myWarships || bot.bc > 500)) {
            // biggest hull this yard can finish in ~12 turns — cheapest-first
            // meant frigate spam forever while the human fielded titans
            const budget = (selectors.colonyRow(planned, colony).output.prodToQueue || 1) * 12;
            const affordable = designs.filter((d) => (itemCost(planned, me, d, colony) ?? Infinity) <= budget);
            item = affordable[affordable.length - 1] ?? designs[0];
            warOrders++;
          } else if (
            colony.buildings.length >= 4 &&
            row.buildable.includes('housing') &&
            row.popUnits * 10 < row.maxPop * 7
          ) {
            // people first: the benchmark human ran 197 pop by turn 297 vs
            // the baseline bots' ~34 — pop drives prod, RP and BC, so an
            // underpopulated world with its core built grows before it
            // gold-plates (housing yields fade as the colony fills)
            item = 'housing';
          } else if (buildings.length) {
            item = buildings[0];
          } else if (row.buildable.includes('housing') && row.popUnits + 2 < row.maxPop) {
            item = 'housing'; // fully built world with room: grow people
          } else if (cpHeadroom > warOrders - myWarships && designs.length) {
            item = designs[0];
            warOrders++;
          } else {
            // nothing to build and no command headroom: mint money instead —
            // the ungated old fallback here queued (and bought!) a warship
            // every single turn on tech-starved worlds, straight into the
            // 10 BC/point CP-overage bleed
            item = row.buildable.includes('trade_goods') ? 'trade_goods' : options[Math.floor(rand() * options.length)];
          }
          if (item && colony.queue[0]?.item !== item) this.submit('set_build_queue', { colonyId: colony.id, items: [item] });
        } else {
          const item = options[Math.floor(rand() * options.length)]!;
          this.submit('set_build_queue', { colonyId: colony.id, items: [item] });
        }
      } else if (v2) {
        // money is for spending: colony ships get bought outright when the
        // treasury covers them with a small buffer; everything else at 2:1
        const row = selectors.colonyRow(planned, colony);
        const head = colony.queue[0]?.item;
        const limit = head === 'colony_ship' ? bot.bc - 60 : Math.floor(bot.bc / (prof.buyEager ? 1.3 : 2));
        if (row.canBuy && row.buyPrice !== null && row.buyPrice <= limit) {
          this.submit('buy_production', { colonyId: colony.id });
        }
      } else if (bot.bc > 150 && rand() < 0.3) {
        // surplus money gets spent on whatever is on the slipway
        const row = selectors.colonyRow(planned, colony);
        if (row.canBuy) this.submit('buy_production', { colonyId: colony.id });
      }
    }

    // ---- real expansion (both modes): build/sail/settle colony ships. The
    // parity bot's debug catch-up above only fires when the human is AHEAD;
    // without this it never used the colony ships it built and sat on one
    // system while the human matched its colony count. ----
    this.fairExpansion(me, alwaysWar);

    // ---- aggression: strike fleets + ground invasions. Bombard softens a
    // colony but never kills the last pop unit — the 1000-turn tournament
    // proved fleets of 100+ cannot END a war without boots: every one of 38
    // matches timed out. Landings auto-resolve when loaded transports reach
    // an enemy colony star with no defending warships. ----
    if (alwaysWar) {
      if (outgunned) this.rally(state, me, human.id);
      else this.attack(state, me, human.id);
      this.invade(planned, me, human.id, myWarships);
    }
  }

  /** Mirror-mode catch-up grants (see the call site in playTurn for the
   * doctrine). Uses the authoritative state — each turn grants at most
   * MIRROR_ESCORTS_PER_TURN escorts (chunked to the engine's 20-per-command
   * cap) plus at most one rate-limited colony ship, so a big deficit closes
   * over several turns rather than instantly. */
  private mirrorTopUp(state: GameState, me: number, bot: Empire): void {
    const warOf = (id: number) => state.ships.filter((s) => s.owner === id && s.shipKind === 'design').length;
    const colOf = (id: number) => state.colonies.filter((c) => c.owner === id && !c.outpost).length;
    const popOf = (id: number) =>
      state.colonies
        .filter((c) => c.owner === id)
        .reduce((n, c) => n + c.groups.reduce((m, g) => m + Math.floor(g.popK / 1000), 0), 0);
    const strongest = state.empires
      .filter((e) => e.id !== me && !e.eliminated)
      .map((e) => ({ id: e.id, war: warOf(e.id), col: colOf(e.id), pop: popOf(e.id) }))
      .sort((a, b) => b.war - a.war || b.col - a.col || a.id - b.id)[0];
    if (!strongest) return;
    // spawn point: the strongest colony's star (same yard the brains favor)
    const home = state.colonies
      .filter((c) => c.owner === me && !c.outpost)
      .map((c) => selectors.colonyRow(state, c))
      .sort((a, b) => b.output.prodToQueue - a.output.prodToQueue || a.id - b.id)[0];
    const starId = home ? (state.planets.find((p) => p.id === home.planet.id)?.starId ?? null) : null;
    if (starId === null) return;

    // escorts: only a meaningful deficit triggers (dead-band), then top up
    // past parity to a small surplus — see the MIRROR_* constants for why.
    // Two hard brakes keep the grants from poisoning their owner (run 2 of
    // the mirror proof: an at-war onion sizes its fleet at 1.15× OURS, so
    // ungated surplus grants fed a mutual ratchet — 240 granted hulls died
    // piecemeal while their upkeep dug a −28k BC hole, final score −119):
    //   1. solvency — a broke empire gets no hulls it cannot pay for; the
    //      brain's own debt levers (tax, scrap, trade goods) recover first;
    //   2. the same colonies×3 affordability ceiling the onion applies to
    //      its own fleet appetite (wantFleet).
    const myWar = warOf(me);
    const ceiling = Math.max(4, colOf(me) * 3);
    const target = Math.min(strongest.war + MIRROR_WAR_SURPLUS, ceiling);
    if (bot.bc >= 0 && strongest.war > myWar + MIRROR_WAR_DEADBAND && target > myWar) {
      const designs = bot.designs.filter((d) => !d.obsolete);
      const best = [...designs].sort(
        (a, b) =>
          (itemCost(state, me, `design:${b.id}`) ?? 0) - (itemCost(state, me, `design:${a.id}`) ?? 0) ||
          b.id - a.id,
      )[0];
      let grant = Math.min(target - myWar, MIRROR_ESCORTS_PER_TURN);
      while (best && grant > 0) {
        const n = Math.min(grant, 20); // engine hard-caps one command at 20
        this.submit('debug_spawn_ships', { starId, designId: best.id, count: n });
        this.mirrorEscortsGranted += n;
        grant -= n;
      }
    }

    // settlers: behind on colonies — or >10% behind on population, the slow
    // economic drift escorts cannot fix — earns one colony ship every few
    // turns, but ONLY while a world the brain will actually take is in reach
    // (an idle granted hull is pure upkeep, the same drag the dead-band
    // exists to avoid; 16 = the onion's lowest settle gate, bar−8)
    const behindEconomy = strongest.col > colOf(me) || strongest.pop * 10 > popOf(me) * 11;
    if (behindEconomy && state.turn - this.lastSettlerGrantTurn >= MIRROR_SETTLER_EVERY) {
      const myStars = new Set<number>();
      for (const c of state.colonies) {
        if (c.owner !== me) continue;
        const p = state.planets.find((x) => x.id === c.planetId);
        if (p) myStars.add(p.starId);
      }
      const reach = new Set(
        selectors
          .moveOptions(state, me, starId)
          .filter((o) => o.reachable)
          .map((o) => o.starId),
      );
      const worthSettling = state.planets.some(
        (p) =>
          p.body === 'planet' &&
          !state.colonies.some((c) => c.planetId === p.id) &&
          !state.monsters.some((m) => m.starId === p.starId) &&
          (reach.has(p.starId) || myStars.has(p.starId)) &&
          planetScore(p, myStars.has(p.starId), false) >= 16,
      );
      if (worthSettling) {
        this.lastSettlerGrantTurn = state.turn;
        this.mirrorSettlersGranted += 1;
        this.submit('debug_spawn_ships', { starId, designId: null, count: 1, shipKind: 'colony_ship' });
      }
    }
  }

  /** Survival mode while outgunned: piecemeal strikes (and newborn hulls
   * trickling out of camped shipyards one at a time) just feed the enemy —
   * the round-10 probe watched a creative build 38 warships across 300 turns
   * and field 0, every single hull dying within 3 turns of launch. Instead,
   * mass everything at ONE defended home star (preferring stars free of
   * enemy campers, then wherever most of the fleet already sits) and stay
   * there until the odds recover; doomed battles are fled, not fought (see
   * orderBattles). */
  private rally(state: GameState, me: number, humanId: number): void {
    const warships = state.ships.filter((s) => s.owner === me && s.shipKind === 'design' && s.location.kind === 'star');
    if (!warships.length) return;
    const starOf = (planetId: number) => state.planets.find((p) => p.id === planetId)?.starId ?? null;
    const myStars = [...new Set(state.colonies.filter((c) => c.owner === me).map((c) => starOf(c.planetId)))].filter(
      (id): id is number => id !== null,
    );
    if (!myStars.length) return;
    const enemyAt = new Map<number, number>();
    const mineAt = new Map<number, number>();
    for (const s of state.ships) {
      if (s.shipKind !== 'design' || s.location.kind !== 'star') continue;
      const at = s.location.starId;
      if (s.owner === humanId) enemyAt.set(at, (enemyAt.get(at) ?? 0) + 1);
      if (s.owner === me) mineAt.set(at, (mineAt.get(at) ?? 0) + 1);
    }
    const muster = [...myStars].sort(
      (a, b) =>
        (enemyAt.get(a) ?? 0) - (enemyAt.get(b) ?? 0) ||
        (mineAt.get(b) ?? 0) - (mineAt.get(a) ?? 0) ||
        a - b,
    )[0]!;
    const movers = warships.filter((s) => (s.location as { starId: number }).starId !== muster);
    if (!movers.length) return;
    // fuel range still applies: unreachable strays hold position (they are
    // already at, or fleeing toward, some colony of ours)
    const byStar = new Map<number, number[]>();
    for (const s of movers) {
      const from = (s.location as { starId: number }).starId;
      (byStar.get(from) ?? byStar.set(from, []).get(from)!).push(s.id);
    }
    for (const [from, ids] of byStar) {
      const reachable = selectors.moveOptions(state, me, from).some((o) => o.reachable && o.starId === muster);
      if (reachable) this.submit('move_ships', { shipIds: ids, destStarId: muster });
    }
  }

  /** Non-cheating expansion: settle with real colony ships. Colony ships at a
   * star colonize the best free planet there or sail to the nearest reachable
   * free system; while free planets exist, one colony ship stays queued.
   * Before any of that, settle our OWN systems with colony_base — it is known
   * from the start, needs no ship and no fuel range (the human's very first
   * build in the turn-297 save was a colony_base; the old brain never queued
   * projects at all and left a free planet sitting in its home system). */
  private fairExpansion(me: number, alwaysWar = false): void {
    const planned = this.session.getPlanned();
    if (!planned) return;
    for (const colony of planned.colonies) {
      if (colony.owner !== me || colony.outpost) continue;
      const row = selectors.colonyRow(planned, colony);
      if (row.buildable.includes('colony_base') && !row.queue.includes('colony_base')) {
        this.submit('set_build_queue', { colonyId: colony.id, items: ['colony_base', ...row.queue] });
      }
    }

    // scouts chart the nearest unexplored reachable star (the old brain never
    // moved them: the turn-297 bot had explored exactly its home star)
    const bot = planned.empires.find((e) => e.id === me);
    const explored = new Set(bot?.exploredStars ?? []);
    for (const scout of planned.ships) {
      if (scout.owner !== me || scout.shipKind !== 'scout' || scout.location.kind !== 'star') continue;
      const dest = selectors
        .moveOptions(planned, me, scout.location.starId)
        .find((o) => o.reachable && !explored.has(o.starId));
      if (dest) this.submit('move_ships', { shipIds: [scout.id], destStarId: dest.starId });
    }

    const freePlanets = planned.planets.filter(
      (p) =>
        p.body === 'planet' &&
        !planned.colonies.some((c) => c.planetId === p.id) &&
        !planned.monsters.some((m) => m.starId === p.starId),
    );
    const colonyShips = planned.ships.filter((s) => s.owner === me && s.shipKind === 'colony_ship');
    for (const ship of colonyShips) {
      if (ship.location.kind !== 'star') continue; // already sailing
      const starId = ship.location.starId;
      const here = freePlanets
        .filter((p) => p.starId === starId)
        .sort((a, b) => b.sizeClass - a.sizeClass);
      if (here.length) {
        this.submit('colonize', { shipId: ship.id, planetId: here[0]!.id });
        continue;
      }
      const dest = selectors
        .moveOptions(planned, me, starId)
        .find((o) => o.reachable && freePlanets.some((p) => p.starId === o.starId));
      if (dest) this.submit('move_ships', { shipIds: [ship.id], destStarId: dest.starId });
    }

    // outpost ships extend the fuel network — but only when actually cordoned
    // (no reachable free system, or nothing left to settle and the enemy is
    // out of range). An unconditional chain starved the shipyards: a new
    // outpost/colony prepend every few turns kept the queued warship third
    // in line forever (militarist finished with zero warships).
    this.extendRange(planned, me, freePlanets, alwaysWar);
    // keep colony ships in the pipeline while there is room to grow —
    // the tuned brain runs TWO yards at once (expansion wins games)
    const queued = planned.colonies.reduce(
      (n, c) => n + (c.owner === me ? c.queue.filter((q) => q.item === 'colony_ship').length : 0),
      0,
    );
    // Depth is capped by REACHABLE free planets, not the global count (onion
    // round 6 proved the global count builds 500-cost settlers for worlds a
    // faster rival already claimed; the onion's reachable counting won the
    // tournament). This is the conservative half of that port — it can only
    // shrink the pipeline, never inflate it; when everything worthwhile is
    // out of range the settler yards stop and extendRange's outpost chain
    // takes over. Profile depth itself stays the round-2 flat value.
    const myAnchorStars = new Set<number>();
    for (const c of planned.colonies) {
      if (c.owner !== me) continue;
      const p = planned.planets.find((x) => x.id === c.planetId);
      if (p) myAnchorStars.add(p.starId);
    }
    const anchorCol = planned.colonies.find((c) => c.owner === me && !c.outpost);
    const anchorStar = anchorCol ? planned.planets.find((p) => p.id === anchorCol.planetId)?.starId : undefined;
    const reachableStars = new Set<number>(
      anchorStar !== undefined
        ? selectors
            .moveOptions(planned, me, anchorStar)
            .filter((o) => o.reachable)
            .map((o) => o.starId)
        : [],
    );
    const reachableFree = freePlanets.filter((p) => reachableStars.has(p.starId) || myAnchorStars.has(p.starId)).length;
    // floor at 1 while ANY free world exists: early game the whole galaxy can
    // sit outside base fuel range for a few turns, but range grows (tech,
    // outposts) and a bot with zero settlers underway stops expanding at all
    // (tests/protocol/solobot.test.ts locks this)
    const minPipeline = Math.min(1, freePlanets.length);
    // v1 keeps the old global count untouched — it is the frozen benchmark
    const wantPipeline =
      this.brain === 'v2' ? Math.min(this.profile.expand, Math.max(reachableFree, minPipeline)) : minPipeline;
    let pipeline = colonyShips.length + queued;
    if (pipeline < wantPipeline) {
      const rows = planned.colonies
        .filter((c) => c.owner === me && !c.outpost)
        .map((c) => selectors.colonyRow(planned, c))
        .filter((r) => r.buildable.includes('colony_ship') && !r.queue.includes('colony_ship'))
        .sort((a, b) => (b.output.prodToQueue || b.output.prod) - (a.output.prodToQueue || a.output.prod));
      for (const best of rows) {
        if (pipeline >= wantPipeline) break;
        const res = this.submit('set_build_queue', { colonyId: best.id, items: ['colony_ship', ...best.queue] });
        if (res.error) {
          // a production buy earlier this turn pins the active item — slot the
          // settler in right behind it instead of silently skipping the turn
          // (a buyEager bot buys most turns, so "try again next turn" never
          // came; tests/protocol/solobot.test.ts locks this)
          if (!best.queue.length) continue;
          const retry = this.submit('set_build_queue', {
            colonyId: best.id,
            items: [best.queue[0]!, 'colony_ship', ...best.queue.slice(1)],
          });
          if (retry.error) continue;
        }
        pipeline++;
      }
    }
  }

  /** Outpost stepping-stones: when wanted stars (free systems, the enemy)
   * sit outside fuel range, keep one outpost ship working its way toward
   * them — each outpost anchors the fuel network and widens the bubble. */
  private extendRange(planned: GameState, me: number, freePlanets: Array<{ starId: number }>, wantWar: boolean): void {
    const anchor = planned.colonies.find((c) => c.owner === me && !c.outpost);
    if (!anchor) return;
    const anchorPlanet = planned.planets.find((p) => p.id === anchor.planetId);
    if (!anchorPlanet) return;
    const options = selectors.moveOptions(planned, me, anchorPlanet.starId);
    const reachable = new Set(options.filter((o) => o.reachable).map((o) => o.starId));
    const myAnchorStars = new Set<number>();
    for (const c of planned.colonies) {
      if (c.owner !== me) continue;
      const p = planned.planets.find((x) => x.id === c.planetId);
      if (p) myAnchorStars.add(p.starId);
    }
    // chain only when actually cordoned: settling blocked, or (warpath with
    // nothing left to settle) the enemy out of range — an unconditional
    // chain starved the shipyards with a fresh outpost prepend every cycle
    const freeBlocked =
      freePlanets.length > 0 &&
      !freePlanets.some((p) => reachable.has(p.starId) || myAnchorStars.has(p.starId));
    const enemyStars = new Set<number>();
    for (const c of planned.colonies) {
      if (c.owner === me) continue;
      const p = planned.planets.find((x) => x.id === c.planetId);
      if (p) enemyStars.add(p.starId);
    }
    const enemyBlocked =
      wantWar && freePlanets.length === 0 && enemyStars.size > 0 && ![...enemyStars].some((id) => reachable.has(id));
    const wanted = freeBlocked ? new Set(freePlanets.map((p) => p.starId)) : enemyStars;
    const unreachable = options.filter((o) => !o.reachable && wanted.has(o.starId));
    // already-built ships always plant or keep moving (an idle hull is pure
    // upkeep); the goal falls back to home so strays settle nearby
    const goal = unreachable.length
      ? planned.stars.find((s) => s.id === unreachable[0]!.starId)!
      : planned.stars.find((s) => s.id === anchorPlanet.starId)!;
    let sailing = 0;
    for (const row of selectors.fleetRows(planned, me)) {
      if (row.kind !== 'outpost_ship') continue;
      if (row.canOutpostHere.length && row.atStarId !== null && !myAnchorStars.has(row.atStarId)) {
        this.submit('build_outpost', { shipId: row.ship.id, planetId: row.canOutpostHere[0] });
        myAnchorStars.add(row.atStarId);
        sailing++;
        continue;
      }
      if (row.atStarId === null) {
        sailing++; // already in transit
        continue;
      }
      const dest = selectors
        .moveOptions(planned, me, row.atStarId)
        .filter(
          (o) =>
            o.reachable &&
            !myAnchorStars.has(o.starId) &&
            planned.planets.some(
              (p) => p.starId === o.starId && !planned.colonies.some((c) => c.planetId === p.id),
            ) &&
            !planned.monsters.some((m) => m.starId === o.starId),
        )
        .sort((a, b) => {
          const sa = planned.stars.find((s) => s.id === a.starId)!;
          const sb = planned.stars.find((s) => s.id === b.starId)!;
          return starDistance(sa, goal) - starDistance(sb, goal) || a.starId - b.starId;
        })[0];
      if (dest) {
        this.submit('move_ships', { shipIds: [row.ship.id], destStarId: dest.starId });
        sailing++;
      }
    }
    if (sailing > 0) return;
    if (!freeBlocked && !enemyBlocked) return; // not cordoned: build no new hulls

    // none in flight: put one on the strongest yard that can build it
    const queued = planned.colonies.some(
      (c) => c.owner === me && c.queue.some((q) => q.item === 'outpost_ship'),
    );
    if (queued) return;
    const yard = planned.colonies
      .filter((c) => c.owner === me && !c.outpost)
      .map((c) => selectors.colonyRow(planned, c))
      .filter((r) => r.buildable.includes('outpost_ship'))
      .sort((a, b) => (b.output.prodToQueue || b.output.prod) - (a.output.prodToQueue || a.output.prod))[0];
    if (yard) this.submit('set_build_queue', { colonyId: yard.id, items: ['outpost_ship', ...yard.queue] });
  }

  /** Ground war: keep a small marine lift (transports launch pre-boarded
   * with a 4-marine squad) and send it wherever the warfleet has cleared the
   * sky over an enemy colony; the battle-orders hook lands them via the
   * invade order (and S10 auto-lands naked-convoy arrivals). */
  private invade(planned: GameState, me: number, enemyId: number, myWarships: number): void {
    const starOf = (planetId: number) => planned.planets.find((p) => p.id === planetId)?.starId ?? null;
    const enemyColonies = planned.colonies.filter((c) => c.owner === enemyId && !c.outpost);
    if (!enemyColonies.length) return;
    const myWarAt = new Set<number>();
    const theirGuardAt = new Set<number>();
    for (const s of planned.ships) {
      if (s.location.kind !== 'star') continue;
      if (s.owner === me && s.shipKind === 'design') myWarAt.add(s.location.starId);
      if (s.owner === enemyId && (s.shipKind === 'design' || s.shipKind === 'scout')) theirGuardAt.add(s.location.starId);
    }
    // cleared targets, weakest garrison first — landings must arrive as ONE
    // wave big enough to win (piecemeal squad drops just get repelled and
    // burn the marines; the 600-turn mirror took 100 turns per colony that way)
    const clearedTargets = enemyColonies
      .map((c) => {
        const sid = starOf(c.planetId);
        const pop = c.groups.reduce((n, g) => n + Math.floor(g.popK / 1000), 0);
        const militia = marinesOf(c) + Math.ceil(pop / 2);
        return { starId: sid, militia };
      })
      .filter((t): t is { starId: number; militia: number } => t.starId !== null && myWarAt.has(t.starId!) && !theirGuardAt.has(t.starId!))
      .sort((a, b) => a.militia - b.militia || a.starId - b.starId);
    const best = clearedTargets[0] ?? null;

    const transports = planned.ships.filter((s) => s.owner === me && s.shipKind === 'transport' && shipMarines(s) > 0);
    const readyWave = transports.filter((t) => t.location.kind === 'star');
    const waveTroops = readyWave.reduce((n, t) => n + shipMarines(t), 0);
    if (best && waveTroops > best.militia + 2) {
      // launch the whole wave at the weakest cleared colony
      for (const t of readyWave) {
        if (t.location.kind === 'star' && t.location.starId === best.starId) continue;
        this.submit('move_ships', { shipIds: [t.id], destStarId: best.starId });
      }
    }

    // marine-lift pipeline: sized to storm the weakest cleared target in one
    // wave (4 marines per hull), only once a real fleet exists (transports
    // are helpless alone), appended so it never starves the slipway. The
    // transport buildable is marine-gated, so yards without a trained squad
    // simply don't offer it.
    const wantLift = Math.min(8, Math.max(2, Math.ceil(((best?.militia ?? 8) + 3) / 4)));
    const queued = planned.colonies.reduce(
      (n, c) => n + (c.owner === me ? c.queue.filter((q) => q.item === 'transport').length : 0),
      0,
    );
    if (myWarships < 4 || transports.length + queued >= wantLift) return;
    const yard = planned.colonies
      .filter((c) => c.owner === me && !c.outpost)
      .map((c) => selectors.colonyRow(planned, c))
      .filter((r) => r.buildable.includes('transport') && !r.queue.includes('transport'))
      .sort((a, b) => (b.output.prodToQueue || b.output.prod) - (a.output.prodToQueue || a.output.prod))[0];
    if (yard) this.submit('set_build_queue', { colonyId: yard.id, items: [...yard.queue, 'transport'] });
  }

  private nearestFreePlanet(state: GameState, me: number): number | null {
    const myStars = new Set<number>();
    for (const c of state.colonies) {
      if (c.owner !== me) continue;
      const p = state.planets.find((x) => x.id === c.planetId);
      if (p) myStars.add(p.starId);
    }
    const anchors = state.stars.filter((s) => myStars.has(s.id));
    if (!anchors.length) return null;
    let best: { planetId: number; d: number } | null = null;
    for (const planet of state.planets) {
      if (planet.body !== 'planet') continue;
      if (state.colonies.some((c) => c.planetId === planet.id)) continue;
      const star = state.stars.find((s) => s.id === planet.starId)!;
      if (state.monsters.some((m) => m.starId === star.id)) continue; // keepers stay unpoked
      const d = Math.min(...anchors.map((a) => starDistance(a, star)));
      if (!best || d < best.d) best = { planetId: planet.id, d };
    }
    return best?.planetId ?? null;
  }

  private attack(state: GameState, me: number, humanId: number): void {
    // declare war first (no-op if already at war)
    const rel = state.relations.find(
      (r) => (r.a === Math.min(me, humanId) && r.b === Math.max(me, humanId)),
    );
    if (!rel || rel.status !== 'war') this.submit('declare_war', { target: humanId });

    const warships = state.ships.filter((s) => s.owner === me && s.shipKind === 'design' && s.location.kind === 'star');
    if (!warships.length) return;
    const humanStars = new Set<number>();
    for (const c of state.colonies) {
      if (c.owner !== humanId) continue;
      const p = state.planets.find((x) => x.id === c.planetId);
      if (p) humanStars.add(p.starId);
    }
    const myStars = state.stars.filter((s) =>
      state.colonies.some((c) => {
        if (c.owner !== me) return false;
        const p = state.planets.find((x) => x.id === c.planetId);
        return p?.starId === s.id;
      }),
    );
    const near = (starId: number) => {
      const star = state.stars.find((s) => s.id === starId)!;
      return myStars.length ? Math.min(...myStars.map((s) => starDistance(s, star))) : 0;
    };
    // only stars the fleet can actually reach — the old bot hurled the same
    // move at an out-of-range target every turn, every one silently
    // rejected, and never laid a single course in 297 turns. Unreachable
    // targets are extendRange's job (outpost chain), not the fleet's.
    const from = (warships[0]!.location as { kind: 'star'; starId: number }).starId;
    const reach = new Set(
      selectors
        .moveOptions(state, me, from)
        .filter((o) => o.reachable)
        .map((o) => o.starId),
    );
    const targets = [...humanStars]
      .filter((id) => reach.has(id) || warships.some((s) => s.location.kind === 'star' && s.location.starId === id))
      .sort((a, b) => near(a) - near(b))
      .slice(0, Math.min(4, 2 + Math.floor(warships.length / 12)));
    if (!targets.length) return;
    // commit three quarters of the fleet — half split across two targets
    // was too timid to ever crack a defended system
    const strike = warships.slice(0, Math.max(1, Math.floor((warships.length * 3) / 4)));
    const groups: Record<number, number[]> = {};
    strike.forEach((s, i) => {
      const t = targets[i % targets.length]!;
      (groups[t] ??= []).push(s.id);
    });
    for (const [starId, shipIds] of Object.entries(groups)) {
      const already = shipIds.filter((id) => {
        const s = state.ships.find((x) => x.id === id)!;
        return s.location.kind === 'star' && s.location.starId === Number(starId);
      });
      const moving = shipIds.filter((id) => !already.includes(id));
      if (moving.length) this.submit('move_ships', { shipIds: moving, destStarId: Number(starId) });
    }
  }

  /** battles: charge when aggressive, otherwise hold the line — but a
   * hopeless defense (enemy hulls > 2×mine + 1 on the field) warps out
   * instead of dying: retreated ships fall back to the nearest own colony
   * and live to mass with the rally (the alternative was the round-10
   * grinder: single newborn hulls fed one by one to a 9-ship camp). */
  private orderBattles(state: GameState): void {
    const me = this.session.playerId;
    for (const b of state.pendingBattles) {
      if (b.attacker !== me && b.defender !== me) continue;
      const mine = b.attacker === me ? b.ordersA : b.ordersD;
      if (mine !== null || this.orderedBattles.has(b.id)) continue;
      this.orderedBattles.add(b.id); // once — resubmitting on every event would echo forever
      if (this.brain === 'onion') {
        this.submit('battle_orders', {
          battleId: b.id,
          orders: onionBattleOrders(state, me, b, this.personality),
        });
        continue;
      }
      const foe = b.attacker === me ? b.defender : b.attacker;
      const hullsAt = (owner: number) =>
        state.ships.filter(
          (s) => s.owner === owner && s.shipKind === 'design' && s.location.kind === 'star' && s.location.starId === b.starId,
        ).length;
      // 2×+1, not lower: a 1.5× probe fled every defense, let the enemy eat
      // the undefended colonies one by one, and got ELIMINATED by t590
      const doomed = foe >= 0 && hullsAt(foe) > hullsAt(me) * 2 + 1;
      this.submit('battle_orders', {
        battleId: b.id,
        orders: {
          stance: doomed ? 'evade_retreat' : this.aggressive || this.profile.warlike ? 'charge' : 'hold_range',
          priority: this.profile.fleetRatio >= 1.5 ? 'deadliest' : 'nearest',
          retreatThresholdPct: this.profile.warlike ? 15 : 25,
          bombard: !doomed && (this.aggressive || this.profile.warlike) && b.attacker === me,
          // marines in orbit always land on a win — the lift was sent to invade
          invade: !doomed && b.attacker === me,
        },
      });
    }
  }
}
