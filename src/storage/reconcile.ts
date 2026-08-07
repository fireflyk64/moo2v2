// Reconciliation harvest: turn a set of async-played saves (one per player,
// all continuing the SAME shared save) into the reconciliation start payload —
// the shared base state plus each player's recorded per-turn script.
//
// The base is the longest common command prefix of the inputs (everyone
// resumed the same file, so their logs agree up to the moment they went their
// own ways). Each save's script is harvested for its OWN seat only
// (game.local_player_id — the seat the async player occupied) by diffing that
// empire's state at every turn boundary after the base turn: tech invented,
// fields completed, ships produced (hull class + the star they popped out
// at), worlds newly colonized (conquests excluded — those are combat, not
// production), positive population deltas, buildings raised, garrison
// changes, spy-roster changes.

import { gameEngine } from '@engine/adapter';
import { hashString } from '@engine/hash';
import { canonicalStringify } from '@engine/canonical';
import { DATA_VERSION } from '@engine/data/index';
import type { GameState, ReconcileSchedule, ReconcileState } from '@engine/types';
import type { SaveEnvelope } from './repo';
import { SaveFileError, verifySaveEnvelope } from './savefile';

export interface ReconcileInput {
  envelope: SaveEnvelope;
  /** the seat this save's human played (game.local_player_id) */
  seat: number;
}

export interface ReconcileStart {
  /** game_start payload for the reconciliation game (resumeState embeds the
   * base state with the reconcile scripts injected) */
  payload: Record<string, unknown>;
  seed: string;
  baseTurn: number;
  players: Array<{ id: number; name: string; raceJson: string | null }>;
  settings: GameState['settings'];
  /** highest scheduled turn across all scripts */
  lastScheduledTurn: number;
  /** the scoring turn: min last-turn across the submitted saves */
  endTurn: number;
  /** e.g. players whose save is missing — they play as plain CPUs off the base */
  warnings: string[];
}

function foldLog(envelope: SaveEnvelope, upToIndex?: number): GameState {
  let state: GameState | null = null;
  const end = upToIndex ?? envelope.commands.length;
  for (let i = 0; i < end; i++) {
    const c = envelope.commands[i]!;
    const payload = JSON.parse(c.payload) as unknown;
    state =
      c.kind === 'game_start'
        ? (gameEngine.init(payload as never) as GameState)
        : (gameEngine.apply(state!, { turn: c.turn, playerId: c.playerId, kind: c.kind, payload } as never) as GameState);
    gameEngine.takeEvents();
  }
  if (!state) throw new SaveFileError('replay', 'log produced no state');
  return state;
}

/** longest common command prefix across the inputs (seq + kind + payload) */
export function commonPrefixLength(envelopes: SaveEnvelope[]): number {
  const first = envelopes[0]!;
  let n = first.commands.length;
  for (const env of envelopes.slice(1)) {
    n = Math.min(n, env.commands.length);
    for (let i = 0; i < n; i++) {
      const a = first.commands[i]!;
      const b = env.commands[i]!;
      if (a.kind !== b.kind || a.playerId !== b.playerId || a.turn !== b.turn || a.payload !== b.payload) {
        n = i;
        break;
      }
    }
  }
  return n;
}

interface EmpireSnapshot {
  apps: Set<string>;
  fields: Set<number>;
  shipIds: Set<number>;
  /** planetId -> owned colony summary */
  colonies: Map<number, { units: number; buildings: Set<string>; marines: number; outpost: boolean; climate: string; steps: number }>;
  /** every planet that held ANY colony (to tell conquest from colonization) */
  settledPlanets: Set<number>;
  spies: number;
}

function snapshotEmpire(state: GameState, empireId: number): EmpireSnapshot {
  const empire = state.empires.find((e) => e.id === empireId);
  const colonies = new Map<number, { units: number; buildings: Set<string>; marines: number; outpost: boolean; climate: string; steps: number }>();
  const settledPlanets = new Set<number>();
  for (const c of state.colonies) {
    settledPlanets.add(c.planetId);
    if (c.owner !== empireId) continue;
    // the player's own race AND their built androids count toward the pop
    // script — natives and captured aliens are combat/discovery, not production
    const units = c.groups
      .filter((g) => g.race === empireId || g.race === -2)
      .reduce((n, g) => n + Math.floor(g.popK / 1000), 0);
    const planet = state.planets.find((p) => p.id === c.planetId);
    colonies.set(c.planetId, {
      units,
      buildings: new Set(c.buildings),
      marines: c.marines ?? 0,
      outpost: c.outpost,
      climate: planet?.climate ?? 'barren',
      steps: planet?.terraformSteps ?? 0,
    });
  }
  return {
    apps: new Set(empire?.knownApps ?? []),
    fields: new Set(empire?.completedFields ?? []),
    shipIds: new Set(state.ships.filter((s) => s.owner === empireId).map((s) => s.id)),
    colonies,
    settledPlanets,
    spies: empire?.spies.count ?? 0,
  };
}

/** fold one save past the base and record its seat's per-turn script */
export function harvestSchedule(envelope: SaveEnvelope, seat: number, basePrefix: number): ReconcileSchedule {
  const sched: ReconcileSchedule = {
    empireId: seat,
    research: [],
    fields: [],
    ships: [],
    colonize: [],
    pop: [],
    buildings: [],
    marines: [],
    spies: [],
  };
  let state = foldLog(envelope, basePrefix);
  let prev = snapshotEmpire(state, seat);
  let prevTurn = state.turn;
  for (let i = basePrefix; i < envelope.commands.length; i++) {
    const c = envelope.commands[i]!;
    const payload = JSON.parse(c.payload) as unknown;
    state = gameEngine.apply(state, { turn: c.turn, playerId: c.playerId, kind: c.kind, payload } as never) as GameState;
    gameEngine.takeEvents();
    const isLast = i === envelope.commands.length - 1;
    if (state.turn === prevTurn && !isLast) continue;
    const turn = state.turn;
    const now = snapshotEmpire(state, seat);
    for (const app of now.apps) if (!prev.apps.has(app)) sched.research.push({ turn, app });
    for (const f of now.fields) if (!prev.fields.has(f)) sched.fields.push({ turn, fieldNum: f });
    for (const ship of state.ships) {
      if (ship.owner !== seat || prev.shipIds.has(ship.id)) continue;
      // settlement hulls are pointless under scripted colonization (the
      // colonize/outpost/construct commands are blocked in reconciliation)
      if (ship.shipKind === 'colony_ship' || ship.shipKind === 'outpost_ship' || ship.shipKind === 'construction_ship') continue;
      const starId = ship.location.kind === 'star' ? ship.location.starId : ship.location.from;
      const kind =
        ship.shipKind === 'design'
          ? `design:${state.empires.find((e) => e.id === seat)?.designs.find((d) => d.id === ship.designId)?.hull ?? 'frigate'}`
          : ship.shipKind;
      sched.ships.push({ turn, starId, kind });
    }
    for (const [planetId, col] of now.colonies) {
      const before = prev.colonies.get(planetId);
      if (!before) {
        // brand-new settlement vs conquered: a planet that already held a
        // colony last boundary changed hands in combat — not production
        if (!prev.settledPlanets.has(planetId)) {
          sched.colonize.push({ turn, planetId, ...(col.outpost ? { outpost: true } : {}), ...(col.units > 1 ? { units: col.units } : {}) });
          if (col.marines > 0) sched.marines.push({ turn, planetId, count: col.marines });
        }
        continue;
      }
      const dUnits = col.units - before.units;
      if (dUnits > 0) sched.pop.push({ turn, planetId, units: dUnits });
      for (const b of col.buildings) if (!before.buildings.has(b)) sched.buildings.push({ turn, planetId, building: b });
      if (col.marines !== before.marines) sched.marines.push({ turn, planetId, count: col.marines });
      if (col.climate !== before.climate || col.steps !== before.steps) {
        (sched.terraform ??= []).push({ turn, planetId, climate: col.climate as never, steps: col.steps });
      }
    }
    if (now.spies !== prev.spies) sched.spies.push({ turn, count: now.spies });
    prev = now;
    prevTurn = turn;
  }
  return sched;
}

/** assemble the reconciliation game_start from the loaded saves.
 * Deterministic and ORDER-INDEPENDENT: the same set of saves produces the
 * identical start (same seed, same scripts) for every player who runs it,
 * however the files were presented. Players whose save is missing take part
 * as plain CPU empires from the shared base (with a warning). */
export function buildReconciliationStart(inputsIn: ReconcileInput[]): ReconcileStart {
  const inputs = [...inputsIn].sort((a, b) => a.seat - b.seat);
  if (!inputs.length) throw new SaveFileError('structure', 'reconciliation needs at least one save');
  const seats = new Set<number>();
  for (const inp of inputs) {
    const verified = verifySaveEnvelope(inp.envelope);
    if (verified.mode !== 'replay') {
      throw new SaveFileError('replay', 'reconciliation needs same-build saves with full history (this one loads snapshot-first)');
    }
    if (seats.has(inp.seat)) throw new SaveFileError('structure', `two saves claim seat ${inp.seat}`);
    seats.add(inp.seat);
  }
  const startA = inputs[0]!.envelope.commands[0];
  for (const inp of inputs.slice(1)) {
    if (inp.envelope.commands[0]?.payload !== startA?.payload) {
      throw new SaveFileError('structure', 'these saves do not continue the same game (their openings differ)');
    }
  }
  const prefix = commonPrefixLength(inputs.map((i) => i.envelope));
  if (prefix < 1) throw new SaveFileError('structure', 'the saves share no common history');
  const base = foldLog(inputs[0]!.envelope, prefix);
  // scripts are harvested from each save's own continuation past the base
  const schedules = inputs
    .map((inp) => harvestSchedule(inp.envelope, inp.seat, prefix))
    .sort((a, b) => a.empireId - b.empireId);
  const endTurn = Math.min(...inputs.map((i) => i.envelope.game.last_turn));
  const reconcile: ReconcileState = { schedules, usedClaims: [], endTurn };
  const baseWithScripts: GameState = { ...base, phase: 'planning', pendingBattles: [], reconcile };

  // deterministic seed: everyone who reconciles the same saves sees the SAME
  // "what really happened"
  const fingerprint = canonicalStringify(
    inputs
      .map((i) => ({ id: i.envelope.game.game_id, seat: i.seat, n: i.envelope.commands.length }))
      .sort((a, b) => a.seat - b.seat),
  );
  const seed = hashString(`reconcile:${fingerprint}`) + hashString(`reconcile2:${fingerprint}`);

  const players = inputs[0]!.envelope.players
    .map((p) => ({ id: p.player_id, name: p.name, raceJson: p.race_json }))
    .sort((a, b) => a.id - b.id);
  const warnings = players
    .filter((p) => !seats.has(p.id) && base.empires.some((e) => e.id === p.id && !e.eliminated))
    .map((p) => `${p.name} has no save file — that empire plays as a plain CPU from the shared base (no recorded production)`);
  // scoring ends at the SHORTEST save: a much longer game loses its tail
  const maxTurn = Math.max(...inputs.map((i) => i.envelope.game.last_turn));
  if (maxTurn > endTurn + 10) {
    warnings.push(`the saves end at different turns — scoring stops at turn ${endTurn} (the shortest save); recorded turns beyond that are ignored`);
  }

  const lastScheduledTurn = schedules.reduce((n, s) => {
    const turns = [
      ...s.research.map((x) => x.turn),
      ...s.ships.map((x) => x.turn),
      ...s.colonize.map((x) => x.turn),
      ...s.pop.map((x) => x.turn),
      ...s.buildings.map((x) => x.turn),
    ];
    return Math.max(n, ...turns, 0);
  }, base.turn);

  return {
    payload: {
      seed,
      settings: base.settings as unknown,
      players,
      dataVersion: DATA_VERSION,
      resumeState: gameEngine.serialize(baseWithScripts),
    } as Record<string, unknown>,
    seed,
    baseTurn: base.turn,
    players,
    settings: base.settings,
    lastScheduledTurn,
    endTurn,
    warnings,
  };
}
