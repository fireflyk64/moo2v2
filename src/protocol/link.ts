// HostLink: how a GameSession talks to the sequencer. Remote players go over
// the transport to player 0; the host player short-circuits into its own
// HostCore via direct callbacks (single code path for both).

import type { ClientToHost, HostToClient } from './messages';
import type { NetTransport } from './transport';

export interface HostLink {
  send(msg: ClientToHost): void;
  onMessage(cb: (msg: HostToClient) => void): () => void;
}

export class RemoteHostLink implements HostLink {
  private cbs: Array<(msg: HostToClient) => void> = [];
  private unsub: () => void;

  constructor(private readonly transport: NetTransport) {
    this.unsub = transport.onMessage((from, msg) => {
      if (from !== 0) return;
      for (const cb of [...this.cbs]) cb(msg as HostToClient);
    });
  }

  send(msg: ClientToHost): void {
    void this.transport.send(0, msg).catch(() => {
      // host unreachable; session-level connection events handle recovery
    });
  }

  onMessage(cb: (msg: HostToClient) => void): () => void {
    this.cbs.push(cb);
    return () => {
      this.cbs = this.cbs.filter((c) => c !== cb);
    };
  }

  close(): void {
    this.unsub();
  }
}

/** Created by HostCore for the host's own session. */
export class LocalHostLink implements HostLink {
  private cbs: Array<(msg: HostToClient) => void> = [];

  constructor(private readonly deliverToHost: (msg: ClientToHost) => void) {}

  send(msg: ClientToHost): void {
    // async hop so local and remote submissions interleave the same way
    queueMicrotask(() => this.deliverToHost(msg));
  }

  onMessage(cb: (msg: HostToClient) => void): () => void {
    this.cbs.push(cb);
    return () => {
      this.cbs = this.cbs.filter((c) => c !== cb);
    };
  }

  /** @internal HostCore delivers host-to-client messages for player 0 here. */
  _deliver(msg: HostToClient): void {
    queueMicrotask(() => {
      for (const cb of [...this.cbs]) cb(msg);
    });
  }
}
