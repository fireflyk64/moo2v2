# Getting to contact faster: speed-of-play ideas (no rule changes)

The complaint: reaching turn 60–100 before first contact takes too long. The
new **⚡ fast start** mode (async turns until contact, host sim as truth,
CONTACT rewind) attacks the biggest cost — waiting for the other player — but
it is not the only lever. Everything below keeps the game rules identical;
these are pacing, batching and ergonomics ideas, roughly ordered by expected
payoff. Items marked ✅ already exist (some shipped with this batch).

## Synchronization / pacing

1. ✅ **Fast start (async until contact).** Shipped: players end turns freely,
   the host advances the authoritative sim at the slowest player's pace,
   buffered orders replay into it, NPC battles auto-resolve, first contact
   flashes CONTACT and rewinds everyone to the synced turn (max +10 ahead).
2. ✅ **Auto-turn timer.** Once everyone but one player has committed, the turn
   advances after N seconds. Already in lobby settings — consider defaulting it
   to 60s instead of "off" for new multiplayer rooms; it is the single best
   anti-stall tool in classic (post-contact) play.
3. **Commit-by-default ("nothing to do" detection).** If a player has issued
   no orders and has no pending decisions (no idle labs, no unqueued yards, no
   arrived colony ship), offer a one-key "commit and repeat until something
   happens" — a personal fast-forward that stops on any report addressed to
   you (research done, ship arrived, battle, contact). Solo already feels like
   this because the bot commits instantly; multiplayer would pair it with fast
   start naturally. Cheap to build: the engine already emits exactly the
   events that should interrupt (`research_complete`, `colony_ship_arrived`,
   `battle_pending`, …).
4. **Pre-contact turn batching for PBM.** In play-by-mail, let the active
   player bank SEVERAL committed turns in one sitting (the fast-start buffer
   already supports this server-side); the next player's session then replays
   through them. Turns the mail cadence from 1 turn/day into ~10/day before
   contact.
5. **Presence-aware pacing.** When both players are online and both commit
   within a few seconds repeatedly, drop the end-of-turn fanfare (skip the
   commit-status round-trip animation, fold bursts of `cmd_accept` before
   re-rendering). The protocol allows it today; it is purely a client render
   batching change.

## Fewer clicks per turn (the real cost of 60 turns is 60× the UI overhead)

6. **Idle-work guardrails on End Turn.** The commit button already warns on
   idle research; extend the same one-glance treatment to: colonies with an
   empty queue (✅ badge shipped on the Colonies tab), colony ships sitting at
   a colonizable planet (✅ arrival alert shipped), and scouts with no orders.
   A single "review 3 idle things" popover beats hunting through tabs.
7. **Build-queue templates.** "New colony opens with: colony base → housing"
   as a per-empire preset applied automatically to freshly founded colonies
   (an ordinary logged command issued by the client, so no rules/engine
   change). The spreadsheet's bulk-build already covers mid-game; templates
   cover the founding moment.
8. **Repeat-last-turn for jobs.** After a colony grows a unit, the new citizen
   lands in `workers`; a "keep last ratio" toggle per colony (client-issued
   `set_jobs` after growth events) removes the most common per-turn fiddling.
9. **Scout auto-explore.** A client-side order loop: when a scout arrives and
   the system is charted, automatically issue a move to the nearest unexplored
   star in fuel range (ordinary `move_ships` commands, cancellable). Exploring
   is 80% of pre-contact clicks.
10. **Keyboard flow.** `E` = end turn, `Space` = next alert, `1..7` = tabs.
    A 60-turn opening at 5 seconds saved per turn is 5 minutes back.

## Perceived speed

11. **Instant optimistic UI everywhere** (already largely true via the planned
    state) — audit any remaining spots that wait for `cmd_accept` before
    reflecting a change; none should.
12. **Turn-resolution toasts, not modals.** Keep resolution feedback ambient
    (the report feed + celebration toasts) so nothing blocks the next turn's
    input. The only modal should be battle orders and CONTACT.
13. **Background tab catch-up.** When a backgrounded tab receives a burst of
    turns (fast start), fold them without rendering intermediate frames, then
    render once — keeps catch-up under a second even 10 turns behind.

## Setup-level shortcuts (rule-preserving options that already exist)

14. ✅ **Average start** (skip the pre-warp tech grind), ✅ **Big empires
    start** (skip the first 30 turns of expansion), ✅ **Advanced start**
    (identical developed empires covering ~1/3 of the map, half-full worlds,
    freighters, frontier scouts — skips straight to the interesting part), ✅
    **Mirror galaxy** (fair, known distances — contact predictably early), ✅
    **good home system**. A lobby "quick game" preset bundling advanced start
    + fast start + 60s auto-turn would get a table from lobby to first
    contact in minutes without touching a single rule.

## Explicitly rejected (they would change the rules)

- Shrinking pre-contact distances or boosting early drive speeds.
- Auto-resolving human-vs-human battles.
- Skipping turns wholesale (every turn must still resolve through the same
  deterministic pipeline — fast start only changes WHO waits, never what a
  turn computes).
