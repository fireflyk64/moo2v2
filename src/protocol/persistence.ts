// Structural persistence interface for sessions. @storage's GameStore
// satisfies this shape; defining it here keeps protocol free of storage
// imports (the ui/headless layers inject the concrete store).

export interface SessionCommandRecord {
  seq: number;
  turn: number;
  playerId: number;
  kind: string;
  payload: unknown;
}

export interface SessionStore {
  getGame(gameId: string): Promise<{ seed: string } | undefined>;
  deleteGame(gameId: string): Promise<void>;
  createGame(
    meta: {
      gameId: string;
      engineVersion: string;
      dataVersion: string;
      protocolVersion: number;
      settings: unknown;
      seed: string;
      localPlayerId: number;
      lobbyServer: string;
      roomCode: string;
    },
    players: Array<{ id: number; name: string }>,
  ): Promise<void>;
  setGameStatus(gameId: string, status: 'setup' | 'active' | 'finished' | 'abandoned'): Promise<void>;
  appendCommands(gameId: string, records: SessionCommandRecord[]): Promise<void>;
  saveTurnHash(gameId: string, turn: number, stateHash: string): Promise<void>;
  saveSnapshot(gameId: string, turn: number, seq: number, stateJson: string, stateHash: string): Promise<void>;
  appendChat(
    gameId: string,
    msg: { id: number; turn: number; from: number; to: number; text: string; sentAt: string },
  ): Promise<void>;
  appendTurnEvents(
    gameId: string,
    turn: number,
    events: Array<{ idx: number; visibleTo: number; kind: string; payload: unknown }>,
  ): Promise<void>;
  saveBattleReplay(gameId: string, battleId: string, turn: number, replayJson: string, summary: unknown): Promise<void>;
}
