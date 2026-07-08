// In-process transport hub for protocol tests: same interface as the lobbylink
// adapter, ordered async delivery per pair, controllable disconnects.

import type { NetTransport, TransportEvent, TransportPlayer } from './transport';
import type { ProtocolMessage } from './messages';
import { decodeMessage, encodeMessage } from './messages';

class MemoryEndpoint implements NetTransport {
  readonly selfId: number;
  private msgCbs: Array<(from: number, msg: ProtocolMessage) => void> = [];
  private evCbs: Array<(ev: TransportEvent) => void> = [];

  constructor(
    private readonly hub: MemoryHub,
    selfId: number,
  ) {
    this.selfId = selfId;
  }

  get maxPlayers(): number {
    return this.hub.maxPlayers;
  }

  players(): readonly TransportPlayer[] {
    return this.hub.roster();
  }

  async send(to: number, msg: ProtocolMessage): Promise<void> {
    this.hub.deliver(this.selfId, to, msg);
  }

  async broadcast(msg: ProtocolMessage): Promise<void> {
    for (const p of this.hub.roster()) {
      if (p.id !== this.selfId && p.occupied) this.hub.deliver(this.selfId, p.id, msg);
    }
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
    this.hub.leave(this.selfId);
  }

  /** @internal */
  _receive(from: number, msg: ProtocolMessage): void {
    for (const cb of [...this.msgCbs]) cb(from, msg);
  }

  /** @internal */
  _event(ev: TransportEvent): void {
    for (const cb of [...this.evCbs]) cb(ev);
  }
}

export class MemoryHub {
  private endpoints = new Map<number, MemoryEndpoint>();
  private connected = new Map<number, boolean>();
  private queue: Array<() => void> = [];
  private flushing = false;

  constructor(readonly maxPlayers: number) {}

  join(): MemoryEndpoint {
    for (let id = 0; id < this.maxPlayers; id++) {
      if (!this.endpoints.has(id)) {
        const ep = new MemoryEndpoint(this, id);
        this.endpoints.set(id, ep);
        this.connected.set(id, true);
        this.emitAllExcept(id, { type: 'player-joined', playerId: id });
        return ep;
      }
    }
    throw new Error('room full');
  }

  /** Simulate a peer dropping (slot stays occupied, like lobbylink). */
  disconnect(id: number): void {
    this.connected.set(id, false);
    this.emitAllExcept(id, { type: 'player-left', playerId: id, reason: 'disconnected' });
  }

  reconnect(id: number): MemoryEndpoint {
    const ep = this.endpoints.get(id);
    if (!ep) throw new Error(`no endpoint ${id}`);
    this.connected.set(id, true);
    this.emitAllExcept(id, { type: 'player-rejoined', playerId: id });
    return ep;
  }

  /** Re-occupy a vacated slot with a fresh endpoint (host/page restart). */
  rejoinSlot(id: number): MemoryEndpoint {
    if (this.endpoints.has(id)) throw new Error(`slot ${id} still occupied`);
    const ep = new MemoryEndpoint(this, id);
    this.endpoints.set(id, ep);
    this.connected.set(id, true);
    this.emitAllExcept(id, { type: 'player-rejoined', playerId: id });
    return ep;
  }

  leave(id: number): void {
    if (!this.endpoints.delete(id)) return;
    this.connected.delete(id);
    this.emitAllExcept(id, { type: 'player-left', playerId: id, reason: 'explicit-leave' });
  }

  roster(): TransportPlayer[] {
    const out: TransportPlayer[] = [];
    for (let id = 0; id < this.maxPlayers; id++) {
      out.push({
        id,
        occupied: this.endpoints.has(id),
        connected: this.connected.get(id) ?? false,
      });
    }
    return out;
  }

  deliver(from: number, to: number, msg: ProtocolMessage): void {
    // encode/decode round-trip to mirror the wire (catches non-JSON payloads)
    const bytes = encodeMessage(msg);
    this.queue.push(() => {
      const target = this.endpoints.get(to);
      if (!target || !this.connected.get(to) || !this.connected.get(from)) return;
      target._receive(from, decodeMessage(bytes));
    });
    this.flush();
  }

  private emitAllExcept(id: number, ev: TransportEvent): void {
    this.queue.push(() => {
      for (const [pid, ep] of this.endpoints) {
        if (pid !== id && this.connected.get(pid)) ep._event(ev);
      }
    });
    this.flush();
  }

  private flush(): void {
    if (this.flushing) return;
    this.flushing = true;
    queueMicrotask(() => {
      this.flushing = false;
      const batch = this.queue.splice(0);
      for (const fn of batch) fn();
      if (this.queue.length) this.flush();
    });
  }

  /** Await until all queued deliveries (including cascades) settle. */
  async settle(): Promise<void> {
    for (let i = 0; i < 50 && this.queue.length; i++) {
      await new Promise<void>((r) => queueMicrotask(r));
    }
    // a few extra microtask hops for handlers that themselves enqueue
    for (let i = 0; i < 20; i++) await new Promise<void>((r) => queueMicrotask(r));
  }
}
