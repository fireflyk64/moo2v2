// Play-by-mail client glue. The PBM server (the lobbylink server started with
// --pbm-config) stores the authoritative save per room code plus who has
// committed this turn, and hands out a single expiring lock so one player at
// a time hosts. Flow:
//   login (shared password -> token, remembered)  ->  take the room lock  ->
//   download save  ->  import into the room  ->  host it over the SAME
//   lobbylink server. Every commit / turn advance re-uploads the save with the
//   commit meta, so the next player to log in continues exactly there — and
//   because the game is hosted on a real room, a second player logging in
//   while the lock is held simply joins the live game instead.
// This coordinates honest friends; it is not a security barrier beyond the
// shared password.

import { encodeSaveFile } from '@storage/index';
import { enterRoom, type ActiveGame } from './net';
import { importSaveIntoRoom, previewSave, type SavePreview } from './saveload';
import { app } from './state.svelte';

const TOKEN_KEY = (server: string) => `moo2.pbmToken.${server}`;
const HEARTBEAT_MS = 60_000; // lock TTL defaults to 180s server-side
const UPLOAD_DEBOUNCE_MS = 800;

export interface PbmEnterParams {
  /** lobbylink server base URL (the PBM API lives under <server>/pbm/) */
  server: string;
  code: string;
  name: string;
  /** shared PBM password; optional when a token is already remembered */
  password?: string;
  /** per-seat protection password, if that player set one */
  playerPassword?: string;
  /** a previewed save file: creates the PBM game when the room is new */
  createFrom?: SavePreview | null;
}

function b64encode(bytes: Uint8Array): string {
  let s = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    s += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(s);
}

function b64decode(s: string): Uint8Array {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export function pbmToken(server: string): string | null {
  return localStorage.getItem(TOKEN_KEY(server));
}

async function api(
  server: string,
  method: string,
  path: string,
  token: string | null,
  body?: unknown,
): Promise<{ status: number; data: Record<string, unknown> }> {
  const res = await fetch(`${server}${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { 'X-PBM-Auth': token } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  return { status: res.status, data };
}

/** Log in with the shared password; the token is remembered per server. */
export async function pbmLogin(server: string, password: string): Promise<string> {
  const { status, data } = await api(server, 'POST', '/pbm/login', null, { password });
  if (status !== 200) throw new Error((data['error'] as string) ?? `PBM login failed (${status})`);
  const token = data['token'] as string;
  localStorage.setItem(TOKEN_KEY(server), token);
  return token;
}

/** Set / change / clear a seat's protection password. */
export async function pbmProtect(
  server: string,
  code: string,
  playerName: string,
  password: string,
  oldPassword?: string,
): Promise<void> {
  const token = pbmToken(server);
  const { status, data } = await api(server, 'POST', `/pbm/rooms/${code}/protect`, token, {
    playerName,
    password,
    oldPassword: oldPassword ?? '',
  });
  if (status !== 200) throw new Error((data['error'] as string) ?? `protect failed (${status})`);
}

interface PbmMeta {
  turn: number;
  committed: number[];
  players: Array<{ id: number; name: string }>;
}

/** Enter a play-by-mail game (see module comment for the whole dance). */
export async function enterPbmGame(params: PbmEnterParams): Promise<ActiveGame> {
  const { server, code, name } = params;
  let token = pbmToken(server);
  if (params.password) token = await pbmLogin(server, params.password);
  if (!token) throw new Error('enter the shared play-by-mail password once to log in');

  // ---- the lock decides our role ----
  const lock = await api(server, 'POST', `/pbm/rooms/${code}/lock`, token, {
    name,
    playerName: name,
    playerPassword: params.playerPassword ?? '',
  });
  if (lock.status === 401) {
    localStorage.removeItem(TOKEN_KEY(server));
    throw new Error('play-by-mail login expired or wrong — enter the shared password again');
  }
  if (lock.status === 403) throw new Error((lock.data['error'] as string) ?? 'that player is password-protected');

  if (lock.status === 423) {
    // someone is playing RIGHT NOW: join their live game on the same server
    const holder = (lock.data['holder'] as string) ?? 'someone';
    const room = await api(server, 'GET', `/pbm/rooms/${code}`, token);
    const players = ((room.data['meta'] as PbmMeta | undefined)?.players ?? []).length || 8;
    const active = await enterRoom({ server, code, name, playerCount: players });
    if (active.transport.selfId === 0) {
      // nobody is actually in the room: the holder's tab died and their lock
      // has not timed out yet — hosting now would fork the game
      active.transport.close();
      await active.store?.destroy().catch(() => undefined);
      throw new Error(
        `${holder} holds the room lock but is not online — try again in a few minutes (locks time out)`,
      );
    }
    active.pbm = {
      role: 'guest',
      note: `${holder} holds the room — joined their live game`,
      stop: () => Promise.resolve(),
    };
    return active;
  }
  if (lock.status !== 200) throw new Error((lock.data['error'] as string) ?? `PBM lock failed (${lock.status})`);

  const releaseLock = () =>
    api(server, 'DELETE', `/pbm/rooms/${code}/lock`, token, { name }).catch(() => undefined);

  try {
    // ---- fetch (or create) the authoritative save ----
    const room = await api(server, 'GET', `/pbm/rooms/${code}`, token);
    let preview: SavePreview;
    let meta: PbmMeta | null = null;
    if (room.status === 404) {
      if (!params.createFrom) {
        throw new Error(`no play-by-mail game in room ${code} yet — load a save file first to create it`);
      }
      preview = params.createFrom;
      const bytes = await encodeSaveFile(preview.envelope);
      const create = await api(server, 'POST', `/pbm/rooms/${code}/save`, token, {
        name,
        save: b64encode(bytes),
        turn: preview.verified.turn,
        committed: [],
        players: preview.envelope.players.map((p) => ({ id: p.player_id, name: p.name })),
      });
      if (create.status !== 200) throw new Error((create.data['error'] as string) ?? 'creating the PBM game failed');
    } else if (room.status === 200) {
      preview = await previewSave(b64decode(room.data['save'] as string));
      meta = room.data['meta'] as PbmMeta;
    } else {
      throw new Error((room.data['error'] as string) ?? `PBM download failed (${room.status})`);
    }

    // ---- import + host over the same lobbylink server ----
    await importSaveIntoRoom(preview, code, server);
    const active = await enterRoom({ server, code, name, playerCount: preview.envelope.players.length });
    if (!active.host) {
      throw new Error('someone already hosts this room outside play-by-mail — join them normally instead');
    }
    const knownName = preview.envelope.players.some((p) => p.name.trim().toLowerCase() === name.trim().toLowerCase());

    // stored commits from earlier mail sessions still count (same turn only)
    const st = active.session.getState();
    if (meta && st && meta.turn === (st as { turn?: number }).turn) {
      active.host.seedCommitted(meta.committed);
    }

    // ---- auto-upload on progress + lock heartbeat ----
    let uploadTimer: ReturnType<typeof setTimeout> | null = null;
    let uploadChain: Promise<boolean> = Promise.resolve(true);
    let retriesLeft = 5;
    let noteTimer: ReturnType<typeof setTimeout> | null = null;
    const setNote = (note: string, sticky = false) => {
      if (active.pbm) active.pbm.note = note;
      app.version++;
      // success notes auto-clear like the local save toast; warnings stay
      // until replaced (a pinned "uploaded turn N ✓" was the sticky-dialog bug)
      if (noteTimer) clearTimeout(noteTimer);
      if (!sticky) {
        noteTimer = setTimeout(() => {
          if (active.pbm && active.pbm.note === note) {
            active.pbm.note = '';
            app.version++;
          }
        }, 6000);
      }
    };
    const uploadNow = (): Promise<boolean> => {
      uploadChain = uploadChain.then(async () => {
        try {
          await active.session.flush();
          await active.session.snapshotNow();
          const envelope = await active.store!.exportGame(active.session.gameId!, {});
          const bytes = await encodeSaveFile(envelope);
          const state = active.session.getState() as { turn: number } | null;
          const res = await api(server, 'POST', `/pbm/rooms/${code}/save`, token, {
            name,
            save: b64encode(bytes),
            turn: state?.turn ?? 0,
            committed: active.host!.getCommittedSeats(),
            players: envelope.players.map((p) => ({ id: p.player_id, name: p.name })),
          });
          if (res.status === 200) {
            retriesLeft = 5;
            setNote(`uploaded turn ${state?.turn} ✓`);
            return true;
          }
          // non-2xx (lock lost / auth expired) must not pass silently: the
          // next player would resume a stale save while this session forks
          setNote(`⚠ upload rejected (${res.status}): ${res.data['error'] ?? 'lock lost?'} — will retry`, true);
        } catch (e) {
          setNote(`⚠ upload failed: ${e instanceof Error ? e.message : e} — will retry`, true);
        }
        if (retriesLeft > 0) {
          retriesLeft--;
          if (uploadTimer) clearTimeout(uploadTimer);
          uploadTimer = setTimeout(() => void uploadNow(), 5000);
        }
        return false;
      });
      return uploadChain;
    };
    const scheduleUpload = () => {
      if (uploadTimer) clearTimeout(uploadTimer);
      uploadTimer = setTimeout(() => void uploadNow(), UPLOAD_DEBOUNCE_MS);
    };
    const unsub = active.session.subscribe((ev) => {
      if (ev.type === 'commit-status' || ev.type === 'turn-advanced') scheduleUpload();
    });
    const heartbeat = setInterval(() => {
      void api(server, 'POST', `/pbm/rooms/${code}/lock`, token, { name })
        .then((hb) => {
          // a 423/401 heartbeat means the lock is gone (laptop slept past the
          // TTL): the player must know before playing an orphaned branch
          if (hb.status !== 200) {
            setNote(`⚠ room lock lost (${hb.status}): ${hb.data['error'] ?? 'another player may have taken over'}`, true);
          }
        })
        .catch(() => undefined);
    }, HEARTBEAT_MS);

    active.pbm = {
      role: 'host',
      note: knownName
        ? `progress uploads on commit — leave any time`
        : `⚠ "${name}" matches no empire in this save — you were given a free seat`,
      stop: async () => {
        unsub();
        clearInterval(heartbeat);
        if (uploadTimer) clearTimeout(uploadTimer);
        retriesLeft = 0; // final attempt only — stop() must not self-reschedule
        const ok = await uploadNow(); // final state, incl. an uncommitted half-turn
        // keep the lock if the final upload failed: releasing it would hand
        // the next player a stale save and silently discard this session
        if (ok) await releaseLock();
      },
    };
    return active;
  } catch (e) {
    await releaseLock();
    throw e;
  }
}
