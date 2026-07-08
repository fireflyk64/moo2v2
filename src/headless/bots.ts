// Scripted test bots (no NPCs ship in the game; these exist for automated
// testing only). A bot inspects state through the same selectors the UI uses
// and returns commands; the driver validates/applies them like a host would.

import {
  gameEngine,
  selectors,
  validateCommand,
  type EngineCommand,
  type GameState,
} from '@engine/index';
import { rngFor } from '@engine/rng';

export interface BotDecision {
  kind: string;
  payload: unknown;
}

export type BotPolicy = (state: GameState, empireId: number) => BotDecision[];

/** Balanced expander: feeds itself, builds economy, explores, colonizes. */
export const expanderBot: BotPolicy = (state, empireId) => {
  const out: BotDecision[] = [];
  const summary = selectors.empireSummary(state, empireId);

  // research: always keep a field selected
  if (summary.researching === null) {
    const choices = selectors.researchChoices(state, empireId);
    if (choices.length) {
      const choice = choices[0]!;
      const target = choice.apps.find((a) => !a.known);
      out.push({
        kind: 'set_research',
        payload: { fieldNum: choice.field.num, targetApp: target?.id ?? null },
      });
    }
  }

  for (const row of selectors.colonyRows(state, empireId)) {
    if (row.outpost) continue;
    // jobs: enough farmers to break even, 25% scientists, rest workers
    const units = row.popUnits;
    if (units > 0) {
      const foodPerFarmer = row.jobs.farmers > 0 ? Math.max(1, Math.floor(row.output.food / Math.max(1, row.jobs.farmers))) : 2;
      const needFood = row.output.foodConsumed;
      let farmers = Math.min(units, Math.ceil(needFood / Math.max(1, foodPerFarmer)));
      if (row.output.food === 0 && row.output.foodConsumed === 0) farmers = 0; // lithovore
      const scientists = Math.min(units - farmers, Math.max(0, Math.floor((units - farmers) / 3)));
      const workers = units - farmers - scientists;
      if (farmers !== row.jobs.farmers || workers !== row.jobs.workers || scientists !== row.jobs.scientists) {
        out.push({
          kind: 'set_jobs',
          payload: { colonyId: row.id, groups: [{ race: empireId, farmers, workers, scientists }] },
        });
      }
    }
    // build order: factory -> farm -> lab -> colony ship (repeat)
    if (row.queue.length === 0) {
      const wish = ['automated_factory', 'hydroponic_farm', 'research_lab', 'colony_ship'];
      const next = wish.find((w) => row.buildable.includes(w)) ?? (row.buildable.includes('trade_goods') ? 'trade_goods' : null);
      if (next) out.push({ kind: 'set_build_queue', payload: { colonyId: row.id, items: [next] } });
    }
  }

  // ships: colonize here if possible, otherwise push outward deterministically
  const rng = rngFor(state.seed, state.turn, 'bot', empireId);
  for (const fleet of selectors.fleetRows(state, empireId)) {
    if (fleet.canColonizeHere.length > 0) {
      out.push({ kind: 'colonize', payload: { shipId: fleet.ship.id, planetId: fleet.canColonizeHere[0] } });
      continue;
    }
    if (fleet.canOutpostHere.length > 0) {
      out.push({ kind: 'build_outpost', payload: { shipId: fleet.ship.id, planetId: fleet.canOutpostHere[0] } });
      continue;
    }
    if (fleet.atStarId !== null) {
      const empire = state.empires.find((e) => e.id === empireId)!;
      const options = selectors
        .moveOptions(state, empireId, fleet.atStarId)
        .filter((o) => o.reachable);
      const unexplored = options.filter((o) => !empire.exploredStars.includes(o.starId));
      const pool = unexplored.length ? unexplored : [];
      if (pool.length && (fleet.kind === 'scout' || fleet.kind === 'colony_ship' || fleet.kind === 'outpost_ship')) {
        const target = fleet.kind === 'scout' ? pool[rng.int(Math.min(3, pool.length))]! : pool[0]!;
        out.push({ kind: 'move_ships', payload: { shipIds: [fleet.ship.id], destStarId: target.starId } });
      }
    }
  }

  return out;
};

export interface DriverResult {
  state: GameState;
  log: EngineCommand[];
  hashes: string[];
}

/** Run a full headless game: bots decide, engine validates/applies, then the
 * turn advances — exactly the fold a host performs. */
export function runHeadlessGame(opts: {
  seed: string;
  players: Array<{ id: number; name: string; raceJson: string | null; policy: BotPolicy }>;
  turns: number;
  settings?: Partial<GameState['settings']>;
  /** keep resolving after a victory (soak tests) */
  stopOnVictory?: boolean;
}): DriverResult {
  const settings: GameState['settings'] = {
    galaxySize: 'small',
    startMode: 'average',
    playerCount: opts.players.length,
    modes: {
      creativeVariant: false,
      pickBidding: false,
      stickyBuild: false,
      antarans: false,
      randomEvents: false,
    },
    battleOrdersTimeoutMs: 1000,
    debugCommands: false,
    ...(opts.settings ?? {}),
  };

  let state = gameEngine.init({
    seed: opts.seed,
    settings,
    players: opts.players.map((p) => ({ id: p.id, name: p.name, raceJson: p.raceJson })),
    dataVersion: 'test',
  });

  const log: EngineCommand[] = [];
  const hashes: string[] = [];

  for (let t = 0; t < opts.turns; t++) {
    for (const p of opts.players) {
      const decisions = p.policy(state, p.id);
      for (const d of decisions) {
        const cmd: EngineCommand = { turn: state.turn, playerId: p.id, kind: d.kind, payload: d.payload };
        const err = validateCommand(state, cmd);
        if (err) continue; // bots may race stale reads; invalid orders are skipped like host rejects
        state = gameEngine.apply(state, cmd);
        log.push(cmd);
      }
    }
    const adv: EngineCommand = { turn: state.turn, playerId: -1, kind: 'advance_turn', payload: {} };
    state = gameEngine.apply(state, adv);
    gameEngine.takeEvents();
    log.push(adv);
    // battle-orders sub-phase: every human side files default orders, then the
    // host emits resolve_combat — the same sequence HostCore performs
    if (state.phase === 'battle_orders') {
      for (const battle of state.pendingBattles) {
        for (const side of [battle.attacker, battle.defender]) {
          if (side < 0) continue; // NPC orders are prefilled
          const filled = side === battle.attacker ? battle.ordersA : battle.ordersD;
          if (filled) continue;
          const cmd: EngineCommand = {
            turn: state.turn,
            playerId: side,
            kind: 'battle_orders',
            payload: {
              battleId: battle.id,
              orders: { stance: side === battle.attacker ? 'charge' : 'hold_range', priority: 'nearest', retreatThresholdPct: 25, bombard: false },
            },
          };
          if (validateCommand(state, cmd) === null) {
            state = gameEngine.apply(state, cmd);
            log.push(cmd);
          }
        }
      }
      const resolve: EngineCommand = { turn: state.turn, playerId: -1, kind: 'resolve_combat', payload: {} };
      state = gameEngine.apply(state, resolve);
      gameEngine.takeEvents();
      log.push(resolve);
    }
    hashes.push(gameEngine.hash(state));
    if (state.winner !== null && (opts.stopOnVictory ?? true)) break;
  }

  return { state, log, hashes };
}

/** Replay a recorded log over a fresh init; must converge to identical state. */
export function replayGame(
  seed: string,
  players: Array<{ id: number; name: string; raceJson: string | null }>,
  settings: GameState['settings'],
  log: EngineCommand[],
): GameState {
  let state = gameEngine.init({ seed, settings, players, dataVersion: 'test' });
  for (const cmd of log) {
    state = gameEngine.apply(state, cmd);
    gameEngine.takeEvents();
  }
  return state;
}
