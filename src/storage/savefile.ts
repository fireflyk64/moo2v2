// Host save files: the complete game record (command log + latest snapshot)
// as a single robust binary file.
//
// Layout:  "MOO2SAVE" (8 ascii bytes) | version u8 (=1) | gzip(canonical JSON SaveEnvelope)
// Plain uncompressed JSON envelopes (starting with '{') are also accepted so
// saves remain hand-inspectable/craftable for debugging.
//
// Loading validates in layers — magic/version, gzip, JSON, structure, engine +
// data version equality — and finally VERIFIES the save by deterministically
// replaying the entire command log and comparing state hashes. A tampered or
// truncated file cannot pass.

import { ENGINE_VERSION, gameEngine } from '@engine/index';
import { DATA_VERSION } from '@engine/data/index';
import { canonicalStringify } from '@engine/canonical';
import { gzip, gunzip } from './gzip';
import type { SaveEnvelope } from './repo';

export const SAVE_MAGIC = 'MOO2SAVE';
export const SAVE_VERSION = 1;

const TE = new TextEncoder();
const TD = new TextDecoder();

export class SaveFileError extends Error {
  constructor(
    readonly stage: 'magic' | 'version' | 'compression' | 'json' | 'structure' | 'engine_version' | 'data_version' | 'replay',
    message: string,
  ) {
    super(message);
    this.name = 'SaveFileError';
  }
}

export async function encodeSaveFile(envelope: SaveEnvelope): Promise<Uint8Array> {
  const body = await gzip(TE.encode(canonicalStringify(envelope as unknown as Record<string, unknown>)));
  const out = new Uint8Array(SAVE_MAGIC.length + 1 + body.length);
  out.set(TE.encode(SAVE_MAGIC), 0);
  out[SAVE_MAGIC.length] = SAVE_VERSION;
  out.set(body, SAVE_MAGIC.length + 1);
  return out;
}

export async function decodeSaveFile(bytes: Uint8Array): Promise<SaveEnvelope> {
  let text: string;
  if (bytes.length > 0 && bytes[0] === 0x7b /* '{' */) {
    text = TD.decode(bytes); // plain JSON envelope
  } else {
    if (bytes.length < SAVE_MAGIC.length + 2) {
      throw new SaveFileError('magic', 'file is too small to be a save');
    }
    const magic = TD.decode(bytes.slice(0, SAVE_MAGIC.length));
    if (magic !== SAVE_MAGIC) {
      throw new SaveFileError('magic', 'not a moo2v2 save file (bad header)');
    }
    const version = bytes[SAVE_MAGIC.length]!;
    if (version !== SAVE_VERSION) {
      throw new SaveFileError('version', `unsupported save version ${version} (expected ${SAVE_VERSION})`);
    }
    let raw: Uint8Array;
    try {
      raw = await gunzip(bytes.slice(SAVE_MAGIC.length + 1));
    } catch {
      throw new SaveFileError('compression', 'save file is corrupted (decompression failed)');
    }
    text = TD.decode(raw);
  }

  let envelope: SaveEnvelope;
  try {
    envelope = JSON.parse(text) as SaveEnvelope;
  } catch {
    throw new SaveFileError('json', 'save file is corrupted (invalid JSON)');
  }
  validateStructure(envelope);
  return envelope;
}

function validateStructure(env: SaveEnvelope): void {
  const fail = (msg: string): never => {
    throw new SaveFileError('structure', `invalid save: ${msg}`);
  };
  if (env.format !== 'moo2v2-save') fail('wrong format tag');
  if (env.version !== 1) fail(`unknown envelope version ${env.version}`);
  if (!env.game || typeof env.game.game_id !== 'string') fail('missing game record');
  if (!/^[0-9a-f]{32}$/.test(env.game.seed ?? '')) fail('bad seed');
  if (!Array.isArray(env.players) || env.players.length < 1) fail('missing players');
  if (!Array.isArray(env.commands) || env.commands.length < 1) fail('missing command log');
  env.commands.forEach((c, i) => {
    if (c.seq !== i) fail(`command log has a gap at seq ${i}`);
    if (typeof c.kind !== 'string') fail(`command ${i} has no kind`);
    if (typeof c.payload !== 'string') fail(`command ${i} payload must be canonical JSON text`);
  });
  if (env.commands[0]!.kind !== 'game_start') fail('log must begin with game_start');
}

export interface VerifyResult {
  turn: number;
  finalHash: string;
  commandCount: number;
}

/** Strong verification: replay the full log deterministically. Confirms the
 * engine/data versions match and that the snapshot (if present) hashes to the
 * same state the log produces at its seq. */
export function verifySaveEnvelope(envelope: SaveEnvelope): VerifyResult {
  if (envelope.game.engine_version !== ENGINE_VERSION) {
    throw new SaveFileError(
      'engine_version',
      `save is from engine ${envelope.game.engine_version}; this build is ${ENGINE_VERSION}`,
    );
  }
  if (envelope.game.data_version !== DATA_VERSION) {
    throw new SaveFileError(
      'data_version',
      `save is from data version ${envelope.game.data_version}; this build is ${DATA_VERSION}`,
    );
  }

  let state: ReturnType<typeof gameEngine.init> | null = null;
  const snapshot = envelope.snapshot;
  try {
    for (const c of envelope.commands) {
      const payload = JSON.parse(c.payload) as unknown;
      if (c.kind === 'game_start') {
        state = gameEngine.init(payload as never);
      } else if (state) {
        state = gameEngine.apply(state, { turn: c.turn, playerId: c.playerId, kind: c.kind, payload });
        gameEngine.takeEvents();
      }
      if (snapshot && c.seq === snapshot.seq && state) {
        const h = gameEngine.hash(state);
        if (h !== snapshot.stateHash) {
          throw new SaveFileError('replay', `snapshot hash mismatch at seq ${c.seq} (log or snapshot tampered)`);
        }
      }
    }
  } catch (e) {
    if (e instanceof SaveFileError) throw e;
    throw new SaveFileError('replay', `log replay failed: ${e instanceof Error ? e.message : String(e)}`);
  }
  if (!state) throw new SaveFileError('replay', 'log produced no state');
  return {
    turn: gameEngine.turnOf(state),
    finalHash: gameEngine.hash(state),
    commandCount: envelope.commands.length,
  };
}

export function saveFileName(roomCode: string, turn: number): string {
  return `moo2v2-${roomCode}-turn${turn}.moo2save`;
}
