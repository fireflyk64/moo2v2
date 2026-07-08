// NetTransport adapter over the vendored lobbylink WebRTC client.
// The room creator receives selfId 0 and is this game's permanent host.

import { P2PGame } from '@vendor/lobbylink/index';
import type { P2PEvent } from '@vendor/lobbylink/index';
import { decodeMessage, encodeMessage, type ProtocolMessage } from './messages';
import type { NetTransport, TransportEvent, TransportPlayer } from './transport';

export interface LobbylinkConnectOptions {
  server: string;
  code: string;
  maxPlayers: number;
  /** create-or-join (both creator and joiners pass the same options) */
  name?: string;
}

export class LobbylinkTransport implements NetTransport {
  readonly selfId: number;
  readonly maxPlayers: number;
  private msgCbs: Array<(from: number, msg: ProtocolMessage) => void> = [];
  private evCbs: Array<(ev: TransportEvent) => void> = [];

  private constructor(private readonly game: P2PGame) {
    this.selfId = game.selfId;
    this.maxPlayers = game.maxPlayers;
    game.onEvent((ev: P2PEvent) => this.route(ev));
  }

  static async connect(opts: LobbylinkConnectOptions): Promise<LobbylinkTransport> {
    const game = await P2PGame.connect({
      server: opts.server,
      code: opts.code,
      create: {
        maxPlayers: opts.maxPlayers,
        waitUntilFull: false,
        allowLateJoin: true,
        allowReconnect: true,
        claimAfterMs: 120_000,
      },
      storageKey: `moo2v2-${opts.code}`,
      storage: 'session', // per-tab so multiple tabs can test one machine
    });
    return new LobbylinkTransport(game);
  }

  private route(ev: P2PEvent): void {
    switch (ev.type) {
      case 'message': {
        if (ev.kind !== 'reliable') return;
        let msg: ProtocolMessage;
        try {
          msg = decodeMessage(ev.data);
        } catch {
          return;
        }
        for (const cb of [...this.msgCbs]) cb(ev.from, msg);
        return;
      }
      case 'player-joined':
        return this.emit({ type: 'player-joined', playerId: ev.playerId });
      case 'player-left':
        return this.emit({ type: 'player-left', playerId: ev.playerId, reason: ev.reason });
      case 'player-rejoined':
      case 'player-replaced':
        return this.emit({ type: 'player-rejoined', playerId: ev.playerId });
      case 'signaling-closed':
        return this.emit({ type: 'signaling-lost' });
      case 'lobby-error':
        return this.emit({ type: 'fatal', code: ev.code, message: ev.message });
      default:
        return;
    }
  }

  private emit(ev: TransportEvent): void {
    for (const cb of [...this.evCbs]) cb(ev);
  }

  players(): readonly TransportPlayer[] {
    return this.game.players.map((p) => ({ id: p.id, occupied: p.occupied, connected: p.connected }));
  }

  async send(to: number, msg: ProtocolMessage): Promise<void> {
    await this.game.sendReliable(to, encodeMessage(msg));
  }

  async broadcast(msg: ProtocolMessage): Promise<void> {
    const bytes = encodeMessage(msg);
    await Promise.all(
      this.game.players
        .filter((p) => p.id !== this.selfId && p.occupied)
        .map((p) => this.game.sendReliable(p.id, bytes).catch(() => undefined)),
    );
  }

  onMessage(cb: (from: number, msg: ProtocolMessage) => void): () => void {
    this.msgCbs.push(cb);
    return () => {
      this.msgCbs = this.msgCbs.filter((c) => c !== cb);
    };
  }

  onEvent(cb: (ev: TransportEvent) => void): () => void {
    this.evCbs.push(cb);
    return () => {
      this.evCbs = this.evCbs.filter((c) => c !== cb);
    };
  }

  close(): void {
    this.game.close();
  }
}
