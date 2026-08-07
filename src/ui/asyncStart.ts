// Day-one async: assemble a brand-new game from pasted race strings — no
// shared lobby, no server. The host picks the options and their own race,
// pastes everyone else's moo2race1: tokens, and gets a normal save file at
// turn 1 that every player then continues via ⏳ Play async.

import { createGameEngine } from '@engine/adapter';
import { canonicalStringify } from '@engine/canonical';
import { ENGINE_VERSION } from '@engine/index';
import { DATA_VERSION } from '@engine/data/index';
import type { GameState } from '@engine/types';
import type { GameSettings } from '@protocol/messages';
import { verifySaveEnvelope, type SaveEnvelope } from '@storage/index';
import { checkRaceString, type RaceStringPayload } from './raceString';

export interface DayOneAsyncInput {
  host: RaceStringPayload;
  guests: RaceStringPayload[];
  settings: GameSettings;
  seed: string;
}

export interface DayOneAsyncResult {
  envelope: SaveEnvelope;
  state: GameState;
  warnings: string[];
}

/** Build and VERIFY the day-one async save. Throws on any sanity-check error
 * (bad race string, budget violation, mode mismatch, duplicate names). */
export function buildDayOneAsync(input: DayOneAsyncInput): DayOneAsyncResult {
  const players = [input.host, ...input.guests].map((p, i) => ({
    id: i,
    name: p.name.trim(),
    raceJson: p.raceJson,
  }));
  if (players.length < 2) throw new Error('an async game needs at least two players');

  const warnings: string[] = [];
  const seen = new Set<string>();
  for (const p of players) {
    const key = p.name.toLowerCase();
    if (seen.has(key)) {
      // seats are claimed BY NAME on resume — duplicates would collide
      throw new Error(`duplicate player name: ${p.name}`);
    }
    seen.add(key);
    const check = checkRaceString(
      { name: p.name, raceJson: p.raceJson },
      {
        pickPoints: input.settings.pickPoints ?? 10,
        outOfBoxThinking: input.settings.modes.outOfBoxThinking === true,
      },
    );
    if (check.errors.length) throw new Error(`${p.name}: ${check.errors.join('; ')}`);
    warnings.push(...check.warnings.map((w) => `${p.name}: ${w}`));
  }

  const settings: GameSettings = { ...input.settings, playerCount: players.length };
  const startPayload = {
    seed: input.seed,
    settings,
    players,
    dataVersion: DATA_VERSION,
  };
  const engine = createGameEngine();
  const state = engine.init(startPayload as never) as GameState;
  engine.takeEvents();

  const gameId = `g-${input.seed.slice(0, 16)}`;
  const envelope: SaveEnvelope = {
    format: 'moo2v2-save',
    version: 2,
    game: {
      game_id: gameId,
      created_at: new Date().toISOString(),
      engine_version: ENGINE_VERSION,
      data_version: DATA_VERSION,
      protocol_version: 1,
      settings_json: canonicalStringify(settings as unknown),
      seed: input.seed,
      local_player_id: 0,
      lobby_server: 'async-day1',
      room_code: 'ASYNC0',
      status: 'active',
      last_turn: state.turn,
      last_seq: 0,
    },
    players: players.map((p) => ({
      game_id: gameId,
      player_id: p.id,
      name: p.name,
      race_json: p.raceJson,
      is_host: p.id === 0 ? 1 : 0,
    })),
    commands: [{ seq: 0, turn: 0, playerId: -1, kind: 'game_start', payload: canonicalStringify(startPayload) }],
    snapshot: {
      turn: state.turn,
      seq: 0,
      stateJson: engine.serialize(state),
      stateHash: engine.hash(state),
    },
    snapshots: [],
    history: true,
  };
  verifySaveEnvelope(envelope); // never hand out a save we could not load back
  return { envelope, state, warnings };
}
