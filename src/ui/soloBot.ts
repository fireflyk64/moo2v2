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

import { selectors, starDistance } from '@engine/index';
import { itemCost, SHIP_BUILDABLES, PROJECT_BUILDABLES } from '@engine/items';
import type { GameState } from '@engine/types';
import type { GameSession } from '@protocol/session';
import { botRaceById, botRacePicks } from './botRaces';

export type BotMode = 'parity' | 'fair';
/** fair-bot strategy generation: v1 = the original random-build brain (kept
 * as the self-play benchmark), v2 = the tuned brain that beats it */
export type BotBrain = 'v1' | 'v2';
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
  techer: { scienceBias: 1, fleetRatio: 0.6, expand: 3, warlike: false, buyEager: false },
  rusher: { scienceBias: 0, fleetRatio: 1.5, expand: 1, warlike: true, buyEager: true },
  industrialist: { scienceBias: 0, fleetRatio: 1, expand: 2, warlike: false, buyEager: true },
  expander: { scienceBias: 1, fleetRatio: 0.7, expand: 6, warlike: false, buyEager: true },
  militarist: { scienceBias: 0, fleetRatio: 2, expand: 2, warlike: true, buyEager: true },
};

const PERSONALITIES: BotPersonality[] = ['techer', 'rusher', 'industrialist', 'expander', 'militarist'];

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

  /** Play the current turn once: issue orders, then commit. */
  private maybePlay(): void {
    const state = this.session.getState();
    if (!state || state.winner !== null) return;
    if (state.phase !== 'planning') {
      this.orderBattles(state);
      return;
    }
    if (state.turn === this.lastPlayedTurn) return;
    this.lastPlayedTurn = state.turn;
    this.orderedBattles.clear();
    try {
      this.playTurn(state);
    } finally {
      this.session.commitTurn();
    }
  }

  private submit(kind: string, payload: unknown): void {
    this.session.submit(kind, payload); // rejections are fine — the bot shrugs
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
      const hopeless = atWar && theirCol >= myCol * 2 + 5 && theirWarCount >= myWarCount * 4 + 8;
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
      this.attack(state, me, human.id);
      this.invade(planned, me, human.id, myWarships);
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
    const wantPipeline = this.brain === 'v2' ? Math.min(this.profile.expand, freePlanets.length) : 1;
    let pipeline = colonyShips.length + queued;
    if (freePlanets.length && pipeline < wantPipeline) {
      const rows = planned.colonies
        .filter((c) => c.owner === me && !c.outpost)
        .map((c) => selectors.colonyRow(planned, c))
        .filter((r) => r.buildable.includes('colony_ship') && !r.queue.includes('colony_ship'))
        .sort((a, b) => (b.output.prodToQueue || b.output.prod) - (a.output.prodToQueue || a.output.prod));
      for (const best of rows) {
        if (pipeline >= wantPipeline) break;
        this.submit('set_build_queue', { colonyId: best.id, items: ['colony_ship', ...best.queue] });
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

  /** Ground war: keep a small troop lift, load 2-unit marine detachments at
   * big rear colonies, and land them wherever the warfleet has cleared the
   * sky over an enemy colony (landings resolve automatically). */
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
    // cleared targets, weakest militia first — landings must arrive as ONE
    // wave big enough to win (piecemeal 2-troop drops just get repelled and
    // burn the marines; the 600-turn mirror took 100 turns per colony that way)
    const clearedTargets = enemyColonies
      .map((c) => {
        const sid = starOf(c.planetId);
        const pop = c.groups.reduce((n, g) => n + Math.floor(g.popK / 1000), 0);
        const militia = Math.ceil(pop / 2) + (c.buildings.includes('marine_barracks') ? 2 : 0);
        return { starId: sid, militia };
      })
      .filter((t): t is { starId: number; militia: number } => t.starId !== null && myWarAt.has(t.starId!) && !theirGuardAt.has(t.starId!))
      .sort((a, b) => a.militia - b.militia || a.starId - b.starId);
    const targetStars = new Set(clearedTargets.map((t) => t.starId));
    const best = clearedTargets[0] ?? null;

    const transports = planned.ships.filter((s) => s.owner === me && s.shipKind === 'transport');
    const loadedIdle = transports.filter(
      (t) => t.cargoPopUnits > 0 && t.location.kind === 'star' && !targetStars.has(t.location.starId),
    );
    const waveTroops = loadedIdle.reduce((n, t) => n + t.cargoPopUnits, 0);
    if (best && waveTroops > best.militia + 2) {
      // launch the whole wave at the weakest cleared colony
      for (const t of loadedIdle) {
        if (t.location.kind === 'star' && t.location.starId === best.starId) continue;
        this.submit('move_ships', { shipIds: [t.id], destStarId: best.starId });
      }
    }
    for (const t of transports) {
      if (t.location.kind !== 'star') continue;
      const here = t.location.starId;
      if (t.cargoPopUnits > 0) continue; // loaded lifts wait for the wave
      // empty lift: draft marines from a big colony here, else head home
      const source = planned.colonies.find((c) => {
        if (c.owner !== me || c.outpost || starOf(c.planetId) !== here) return false;
        const own = c.groups.find((g) => g.race === me && !g.unrest);
        return !!own && Math.floor(own.popK / 1000) > 6;
      });
      if (source) {
        this.submit('load_transports', { colonyId: source.id, shipId: t.id });
        continue;
      }
      const dest = selectors.moveOptions(planned, me, here).find(
        (o) =>
          o.reachable &&
          planned.colonies.some((c) => {
            if (c.owner !== me || c.outpost || starOf(c.planetId) !== o.starId) return false;
            const own = c.groups.find((g) => g.race === me && !g.unrest);
            return !!own && Math.floor(own.popK / 1000) > 6;
          }),
      );
      if (dest) this.submit('move_ships', { shipIds: [t.id], destStarId: dest.starId });
    }

    // troop-lift pipeline: sized to storm the weakest cleared target in one
    // wave (2 troops per hull), only once a real fleet exists (transports
    // are helpless alone), appended so it never starves the slipway
    const wantLift = Math.min(8, Math.max(3, Math.ceil(((best?.militia ?? 8) + 3) / 2)));
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

  /** battles: charge when aggressive, otherwise hold the line */
  private orderBattles(state: GameState): void {
    const me = this.session.playerId;
    for (const b of state.pendingBattles) {
      if (b.attacker !== me && b.defender !== me) continue;
      const mine = b.attacker === me ? b.ordersA : b.ordersD;
      if (mine !== null || this.orderedBattles.has(b.id)) continue;
      this.orderedBattles.add(b.id); // once — resubmitting on every event would echo forever
      this.submit('battle_orders', {
        battleId: b.id,
        orders: {
          stance: this.aggressive || this.profile.warlike ? 'charge' : 'hold_range',
          priority: this.profile.fleetRatio >= 1.5 ? 'deadliest' : 'nearest',
          retreatThresholdPct: this.profile.warlike ? 15 : 25,
          bombard: (this.aggressive || this.profile.warlike) && b.attacker === me,
        },
      });
    }
  }
}
