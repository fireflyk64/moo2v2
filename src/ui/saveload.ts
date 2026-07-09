// Host save/load glue for the browser: download the game record as a binary
// .moo2save file (or the raw sqlite database), and import an uploaded save
// into a room's database so the resume path re-hosts it.

import {
  decodeSaveFile,
  encodeSaveFile,
  saveFileName,
  verifySaveEnvelope,
  resumePoints,
  SaveFileError,
  type SaveEnvelope,
  type VerifyResult,
} from '@storage/index';
import { rebaseSave } from '@storage/rebase';
import { openBrowserStore } from '@storage/browser';
import { generateSeed } from '@protocol/setup';
import type { ActiveGame } from './net';

function downloadBlob(name: string, blob: Blob): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

/** Download the full game record as a verified binary save file (any seat).
 * A snapshot of the current state is embedded first, so the file stays
 * loadable snapshot-first on every future build. `history: false` strips the
 * command log and older snapshots (final state only). */
export async function downloadSave(active: ActiveGame, opts: { history?: boolean } = {}): Promise<string> {
  if (!active.store || !active.session.gameId) throw new Error('no persistent game to save');
  await active.session.flush(); // ensure every accepted command reached the database
  await active.session.snapshotNow(); // save-time snapshot: the future-proof load base
  const envelope = await active.store.exportGame(active.session.gameId, opts);
  verifySaveEnvelope(envelope); // never write a save we could not load back
  const bytes = await encodeSaveFile(envelope);
  const turn = active.session.getState()?.turn ?? 0;
  const name = saveFileName(active.params.code, turn);
  downloadBlob(name, new Blob([bytes as BlobPart], { type: 'application/octet-stream' }));
  return name;
}

/** Host: download the raw per-room sqlite database (backup/inspection). */
export async function downloadRawDatabase(active: ActiveGame): Promise<string> {
  if (!active.sqlocal) throw new Error('persistence unavailable');
  const file = await active.sqlocal.getDatabaseFile();
  const name = `moo2v2-room-${active.params.code}.sqlite3`;
  downloadBlob(name, file);
  return name;
}

export interface SavePreview {
  envelope: SaveEnvelope;
  verified: VerifyResult;
  players: string[];
  /** turns the save can branch from (replay mode: any logged turn) */
  resumeTurns: number[];
}

/** Decode + verify an uploaded save without importing (drives the load UI). */
export async function previewSave(bytes: Uint8Array): Promise<SavePreview> {
  const envelope: SaveEnvelope = await decodeSaveFile(bytes);
  const verified = verifySaveEnvelope(envelope);
  return {
    envelope,
    verified,
    players: envelope.players.map((p) => p.name),
    resumeTurns: resumePoints(envelope, verified.mode),
  };
}

export interface LoadResult {
  gameId: string;
  turn: number;
  commandCount: number;
  players: string[];
  mode: 'replay' | 'snapshot';
  warnings: string[];
}

/** Import a decoded + verified save into the given room's database (as host,
 * seat 0); the normal resume path picks it up on connect.
 *  - replay mode, latest turn: imported as-is (identity + full history kept).
 *  - older turn or snapshot mode: rebased onto a fresh branch whose
 *    game_start embeds the chosen state (new game id). */
export async function importSaveIntoRoom(
  preview: SavePreview,
  roomCode: string,
  server: string,
  atTurn?: number,
): Promise<LoadResult> {
  const { envelope, verified } = preview;
  let toImport = envelope;
  let turn = verified.turn;
  const wantsBranch = atTurn !== undefined && atTurn !== verified.turn;
  if (verified.mode === 'snapshot' || wantsBranch) {
    const rebased = rebaseSave(envelope, verified.mode, wantsBranch ? atTurn : undefined, generateSeed());
    toImport = rebased.envelope;
    turn = rebased.turn;
  }

  const rehomed: SaveEnvelope = {
    ...toImport,
    game: {
      ...toImport.game,
      room_code: roomCode,
      lobby_server: server,
      local_player_id: 0, // loading machine becomes the host
      status: 'active',
    },
  };

  const { store } = await openBrowserStore(`moo2v2-room-${roomCode}.sqlite3`);
  try {
    // a stale copy of the same game (e.g. rolling back) is replaced wholesale
    await store.importGame(rehomed, true);
    // any other 'active' games in this room would shadow the resume lookup
    for (const g of await store.listGames()) {
      if (g.room_code === roomCode && g.game_id !== rehomed.game.game_id && g.status === 'active') {
        await store.setGameStatus(g.game_id, 'abandoned');
      }
    }
  } finally {
    await store.destroy(); // release the OPFS handle before enterRoom reopens it
  }

  return {
    gameId: rehomed.game.game_id,
    turn,
    commandCount: toImport.commands.length,
    players: envelope.players.map((p) => p.name),
    mode: verified.mode,
    warnings: verified.warnings,
  };
}

export function describeSaveError(e: unknown): string {
  if (e instanceof SaveFileError) return `${e.message} [${e.stage}]`;
  return e instanceof Error ? e.message : String(e);
}
