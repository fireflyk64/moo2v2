// Host save/load glue for the browser: download the game record as a binary
// .moo2save file (or the raw sqlite database), and import an uploaded save
// into a room's database so the resume path re-hosts it.

import {
  decodeSaveFile,
  encodeSaveFile,
  saveFileName,
  verifySaveEnvelope,
  SaveFileError,
  type SaveEnvelope,
} from '@storage/index';
import { openBrowserStore } from '@storage/browser';
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

/** Host: download the full game record as a verified binary save file. */
export async function downloadSave(active: ActiveGame): Promise<string> {
  if (!active.store || !active.session.gameId) throw new Error('no persistent game to save');
  await active.session.flush(); // ensure every accepted command reached the database
  const envelope = await active.store.exportGame(active.session.gameId);
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

export interface LoadResult {
  gameId: string;
  turn: number;
  commandCount: number;
  players: string[];
}

/** Decode + verify an uploaded save, then import it into the given room's
 * database (as host, seat 0). The normal resume path picks it up on connect. */
export async function importSaveIntoRoom(
  bytes: Uint8Array,
  roomCode: string,
  server: string,
): Promise<LoadResult> {
  const envelope: SaveEnvelope = await decodeSaveFile(bytes);
  const verified = verifySaveEnvelope(envelope);

  const rehomed: SaveEnvelope = {
    ...envelope,
    game: {
      ...envelope.game,
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
    turn: verified.turn,
    commandCount: verified.commandCount,
    players: envelope.players.map((p) => p.name),
  };
}

export function describeSaveError(e: unknown): string {
  if (e instanceof SaveFileError) return `${e.message} [${e.stage}]`;
  return e instanceof Error ? e.message : String(e);
}
