# Save-game forward compatibility (the contract)

Every `.moo2save` written from now on must load in every future build. This
document is the methodology that makes that true — read it before changing
engine state, game data, or the save pipeline.

## How loading works (savefile.ts v2)

A save carries three layers:

1. **Final snapshot** — canonical JSON of the full `GameState` at save time,
   with an integrity hash. `downloadSave` always embeds one (`snapshotNow()`).
2. **History snapshots** — every periodic (10-turn) snapshot, unless the user
   checked *no history*.
3. **Command log** — the complete event-sourced history from `game_start`.

`verifySaveEnvelope` picks the loading mode:

| Situation | Mode | What happens |
|---|---|---|
| Same `ENGINE_VERSION` + `DATA_VERSION`, log present | `replay` | Full deterministic replay, hash-checked against every embedded snapshot. Strongest check; any tampering fails. |
| Any version difference (i.e. any FUTURE build), or history stripped | `snapshot` | The final snapshot is re-hashed and becomes the load base. The log is provenance only — it is **never** replayed across versions. |

Loading an old save (or branching from an older turn) **rebases** it
(`rebase.ts`): a fresh log is created whose single `game_start` command embeds
the chosen state (`resumeState`), under a new seed/game id. The invariant
`replay(log) == state` still holds — the log simply *starts* at that state.

## Rules for future changes

State schema (`src/engine/types.ts`):

- **New fields must be optional with an "absent" default** (`tags?: string[]`,
  `sym?: number`, `autoTurnUntil?: number` are the pattern). Old snapshots then
  parse cleanly and hash consistently once re-saved.
- **Never rename, remove, or change the meaning of an existing field.** If a
  concept changes shape, add a new field and keep reading the old one.
- Reading code must tolerate absence (`colony.tags ?? []`).

Commands:

- New command kinds may be added freely (old logs never contain them).
- Never change what an existing command kind does to old payload shapes; add
  optional payload fields with defaults instead.

Rule/balance changes (tech tree fixes, formula changes, combat changes):

- Allowed — they bump `DATA_VERSION`/`ENGINE_VERSION`, which switches old saves
  to snapshot-mode loading. The player keeps their empire exactly as saved and
  continues under the new rules. Cross-version *joining* is still refused
  (lockstep needs identical engines), but saves survive.

Save format (`savefile.ts`):

- The envelope may only grow optional fields. Bump `SAVE_VERSION` when it does
  and keep accepting every older version byte (`1..SAVE_VERSION`).
- `tests/storage/golden.test.ts` holds a frozen fixture from this version; it
  must keep loading (snapshot mode) forever. **Never edit the fixture.** When
  a new format version ships, add a new fixture beside it.

Local browser database:

- `net.ts` auto-resume replays the stored log only when the stored
  `engine_version`/`data_version` match the build; otherwise it declines and
  the save-file loader (which knows how to rebase) is the recovery path.
- SQLite schema migrations remain append-only (`migrations.ts`).

## What-if branching

The load screen offers "resume at turn N": same-version saves can branch at any
logged turn (replayed to that boundary); cross-version saves at any embedded
snapshot turn. A branch becomes a new game (new seed/id) so the original save
stays intact.
