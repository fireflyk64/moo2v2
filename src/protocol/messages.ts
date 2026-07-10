// Protocol message catalog. Every message travels as canonical JSON text over
// the lobbylink reliable channel (ordered per peer pair). The host (player 0)
// is the single sequencer: clients submit, the host assigns gapless global
// sequence numbers and broadcasts cmd_accept; every peer folds identically.

export const PROTOCOL_VERSION = 1;

/** A command in the authoritative log. playerId -1 = system (host-emitted). */
export interface LogCommand {
  seq: number;
  turn: number;
  playerId: number;
  kind: string;
  payload: unknown;
}

export interface PlayerRoster {
  id: number;
  name: string;
  ready: boolean;
  connected: boolean;
  raceJson: string | null;
}

export interface GameSettings {
  galaxySize: 'small' | 'medium' | 'large' | 'huge';
  startMode: 'pre_warp' | 'average';
  playerCount: number;
  modes: {
    creativeVariant: boolean;
    pickBidding: boolean;
    stickyBuild: boolean;
    antarans: boolean;
    randomEvents: boolean;
  };
  /** ms for the battle-orders sub-phase before host applies defaults */
  battleOrdersTimeoutMs: number;
  /** enable logged debug commands (testing) */
  debugCommands: boolean;
  /** DEPRECATED (kept so old saves parse): the old fast-forward-to-turn-N
   * behavior. Ignored by current hosts — see autoTurnSeconds. */
  autoTurnUntil?: number;
  /** auto-turn timer: once every player except one has committed, the host
   * advances the turn after this many seconds (0 = off) */
  autoTurnSeconds?: number;
  /** mirror galaxy: identical rotated wedges, every player on the map edge */
  mirror?: boolean;
  /** home-system sibling world: 'good' = ultra-rich, 'min' = abundant */
  homeStart?: 'good' | 'min';
}

export type ClientToHost =
  | {
      t: 'hello';
      protocolVersion: number;
      engineVersion: string;
      dataVersion: string;
      name: string;
      /** highest seq already persisted locally (-1 if none) */
      haveSeq: number;
    }
  | { t: 'race_config'; raceJson: string | null; ready: boolean; name: string }
  | { t: 'cmd_submit'; clientId: string; turn: number; kind: string; payload: unknown }
  | { t: 'commit_turn'; turn: number }
  | { t: 'uncommit_turn'; turn: number }
  | { t: 'hash_report'; turn: number; hash: string }
  | { t: 'resync_request'; haveSeq: number }
  | { t: 'chat_send'; text: string; to: number }
  | { t: 'auction_commit'; hash: string }
  | { t: 'auction_reveal'; bids: Record<string, number>; nonce: string };

export type HostToClient =
  | {
      t: 'welcome';
      gameId: string;
      settings: GameSettings;
      players: PlayerRoster[];
      lastSeq: number;
      started: boolean;
      /** the empire seat this connection plays: normally your join order, but
       * a game resumed from a save matches you to a saved empire by name */
      seat: number;
    }
  | { t: 'version_reject'; reason: string }
  | { t: 'lobby_update'; players: PlayerRoster[]; settings: GameSettings }
  | { t: 'cmd_accept'; cmd: LogCommand; clientId?: string }
  | { t: 'cmd_reject'; clientId: string; reason: string }
  | {
      t: 'commit_status';
      turn: number;
      committed: number[];
      /** ms until the host force-advances (auto-turn timer armed) */
      autoTurnInMs?: number;
    }
  | { t: 'desync_notice'; turn: number; expected: string }
  | {
      t: 'resync_data';
      snapshot: { turn: number; seq: number; stateJson: string; hash: string } | null;
      commands: LogCommand[];
    }
  | { t: 'chat_deliver'; id: number; turn: number; from: number; to: number; text: string }
  | {
      t: 'auction_begin';
      /** contested pick ids -> holders (playerIds) */
      contested: Record<string, number[]>;
      /** players expected to commit a sealed bid */
      bidders: number[];
      deadlineMs: number;
    }
  | { t: 'auction_commits'; hashes: Record<string, string>; deadlineMs: number }
  | {
      t: 'auction_result';
      outcomes: Array<{ pickId: string; winner: number | null; price: number }>;
      /** playerId -> final raceJson after contested-pick removal */
      players: Record<string, string>;
    };

export type ProtocolMessage = ClientToHost | HostToClient;

export const DEFAULT_SETTINGS: GameSettings = {
  galaxySize: 'medium',
  startMode: 'pre_warp', // early tech age by default: research the basics yourself
  playerCount: 2,
  modes: {
    creativeVariant: false,
    pickBidding: false,
    stickyBuild: false,
    antarans: true,
    randomEvents: true,
  },
  battleOrdersTimeoutMs: 60_000,
  debugCommands: false,
  autoTurnUntil: 0,
  autoTurnSeconds: 0,
  mirror: false,
  homeStart: 'good',
};

const TE = new TextEncoder();
const TD = new TextDecoder();

export function encodeMessage(msg: ProtocolMessage): Uint8Array {
  return TE.encode(JSON.stringify(msg));
}

export function decodeMessage(bytes: Uint8Array): ProtocolMessage {
  return JSON.parse(TD.decode(bytes)) as ProtocolMessage;
}
