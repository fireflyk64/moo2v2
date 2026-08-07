<script lang="ts">
  // The game manual: every mode explained where players pick them (Home and
  // Lobby), with the reconciliation board-game rules spelled out in full.
  const { onclose }: { onclose: () => void } = $props();

  function onKey(e: KeyboardEvent) {
    if (e.key === 'Escape') {
      e.preventDefault();
      onclose();
    }
  }
</script>

<svelte:window onkeydown={onKey} />

<div class="overlay" role="dialog" aria-label="game manual">
  <div class="manual" data-testid="manual">
    <div class="bar">
      <b>📖 Manual — game modes &amp; rules</b>
      <button data-testid="manual-close" onclick={onclose}>✕ Close (Esc)</button>
    </div>
    <div class="body">
      <nav>
        <a href="#man-basics">Basics</a> · <a href="#man-galaxy">Galaxy options</a> ·
        <a href="#man-core">🟢 Core worlds</a> · <a href="#man-fast">⚡ Fast start</a> ·
        <a href="#man-replay">🎞 Replay</a> · <a href="#man-async">⏳ Async</a> ·
        <a href="#man-recon">⚖ Reconciliation</a> · <a href="#man-pbm">📬 Play by mail</a>
      </nav>

      <h3 id="man-basics">Basics</h3>
      <p>
        A MOO2-compatible 4X: explore, colonize, research, build fleets, fight in one-pass visual
        battles, and win by conquest, council election, the Andromedan assault — or the core-worlds
        race below. Multiplayer is peer-to-peer WEGO (everyone plans, then the turn resolves at
        once); single-player seats onion-brain bots. Every game is an event-sourced command log:
        💾 saves carry the whole history, which is what powers replay, async play and
        reconciliation.
      </p>

      <h3 id="man-galaxy">Galaxy options (lobby)</h3>
      <ul>
        <li><b>Start mode</b> — pre-warp (research nearly everything), average (classic opening), advanced (big identical developed empires).</li>
        <li><b>Mirror galaxy</b> — identical rotated wedges; every player starts on the edge with the same neighborhood.</li>
        <li><b>Big empires start</b> — everyone begins with a 10–20 colony bubble.</li>
        <li><b>Home system / pick points / bidding / creative</b> — race and economy variants; hover any control for details.</li>
      </ul>

      <h3 id="man-core">🟢 Core worlds (victory stars)</h3>
      <p>
        The galaxy gains <b>players + 2 green stars</b> — a color no natural star wears — each
        guaranteed at least one real world, with one <b>designated core world</b> per star (its
        biggest). <i>central</i> rings them around the exact middle of the map; <i>scattered</i>
        drops them anywhere. Green stars never host homeworlds, wormholes or monster keepers.
      </p>
      <p>
        <b>Victory:</b> hold a colony with at least 1 population unit on <b>every</b> designated
        core world at once. The win is announced immediately — and the table may press
        <i>▶ keep playing</i> to continue with the victory on record. The AI knows the rules: bots
        race for free core worlds, extend range toward unreachable ones, and treat a rival squatting
        on a victory star as a standing cause for war.
      </p>

      <h3 id="man-fast">⚡ Fast start &amp; timers</h3>
      <p>
        Fast start lets everyone end turns at their own pace until two empires meet — then CONTACT
        pulls the table back into lockstep. Auto-turn and realtime timers keep a slow table moving;
        all three are lobby options.
      </p>

      <h3 id="man-replay">🎞 Replay mode</h3>
      <p>
        Load any save on the Home screen and press <i>🎞 Watch replay</i>: the whole game on the
        real map, scrubbed turn by turn, through <b>any player's eyes</b> — click a banner to switch
        fog instantly, press ▶ to animate, ←/→ to step. Nothing is imported; the save is read-only.
        Saves from the same build replay every turn; saves from older builds show their snapshot
        turns.
      </p>

      <h3 id="man-async">⏳ Async mode</h3>
      <p>
        Asynchronous multiplayer without a shared clock:
      </p>
      <p>
        <b>From day one:</b> no shared game needed. Everyone copies their <b>📋 race string</b>
        (Lobby or Empires screen) and sends it to the host, who pastes them into
        <i>⏳ Start async game from day one</i> on the Home screen, picks the options and their own
        race, and generates the shared save — with sanity checks on pick budgets and mode-gated
        picks. Or fork any existing game:
      </p>
      <ol>
        <li>One player 💾 saves the game (any point works — even before first contact) and shares the file.</li>
        <li><b>Everyone</b> loads the SAME file, picks <i>play as</i> their own empire, and presses <i>⏳ Play async</i>. The game resumes solo: onion bots stand in for every other player.</li>
        <li>Play and expand for as many turns as you see fit, then 💾 save. Your file remembers which seat you played.</li>
        <li>When everyone is done, any player runs <b>⚖ Reconciliation</b> on all the files together.</li>
      </ol>

      <h3 id="man-recon">⚖ Reconciliation — the board-game rules</h3>
      <p>
        Reconciliation merges everyone's async games into <b>what really happened</b>. It is a
        different simulation from the normal game — closer to a board game: your economy is not
        re-simulated, it is <b>replayed from the record</b>, while movement and war stay fully live.
      </p>
      <ul>
        <li><b>The shared base.</b> The common history of all the files (the shared save everyone started from) is the opening position.</li>
        <li><b>Recorded scripts.</b> From each player's file, their empire's per-turn record is extracted: tech invented, research fields completed, ships produced (and where), planets colonized, population growth, buildings raised, garrisons trained, spies hired. <b>There is no production beyond recorded production.</b></li>
        <li><b>Ships</b> pop out at your colony <i>closest to where they were actually produced</i> — if the recorded yard is lost, the nearest surviving colony builds them instead. A player eliminated in the reconciliation stops producing entirely; anyone else's script keeps delivering however badly the war goes, so a strong recorded game can flood the front from the homeworld.</li>
        <li><b>Colonization is predetermined and first-come.</b> If you took Sirius II on turn 4 and a rival's file shows them taking it on turn 5, your claim wins and theirs goes <i>on hold</i>. If you later lose the world (turn 65, say), their claim activates on turn 66 — and instantly catches up all their recorded population growth and buildings for it up to that turn. Claims are one-shot.</li>
        <li><b>Population &amp; buildings</b> arrive on their recorded turns only while the recorded owner still holds the world; a colony bombed to nothing collects nothing.</li>
        <li><b>War is real.</b> Fleet movement, fuel range, space battles, orbital bombardment, starbases and ground batteries, marine invasions against garrisons and militia — all resolve under the exact main-game rules, with AI bots commanding every fleet toward the goal (the core worlds if the base game runs that variant, domination otherwise). Camping an uncontested fleet on a victory star works precisely because colonies are predetermined.</li>
        <li><b>Reach insurance.</b> Wars can burn colonies faster than any script replaces them. Every 5th turn, an empire without an outpost ship gets one from its strongest world, so bots can re-anchor fuel range across razed space. A scheduled colonization claim landing on such an outpost evicts it.</li>
        <li><b>Monsters bow to the record.</b> A scripted colony landing on a keeper-guarded world kills the monster outright — the player's own game proves the fight was already won.</li>
        <li><b>Spies</b> follow a reconciliation doctrine: sabotage hits <i>defensive structures</i>; espionage can only copy <i>passive</i> technologies (armor class, drives, fuel range), and only with a large offensive advantage or against a democracy — if the rolls land.</li>
        <li><b>Scoring.</b> The game is scored when the save files run out of turns (the shortest file sets the clock). If nobody has won outright by then, the population that remains elects a leader — the biggest empire by people takes the crown. In a core-worlds game the election counts the people living on the green stars' worlds (total population breaks ties).</li>
        <li><b>Bot fleet doctrine.</b> The reconciliation bots mass into a small number of strike groups, price starbases and batteries into every target, strike only when the assembled group clearly wins, and send small groups at soft targets while the main fleet hunts the big prizes.</li>
        <li><b>🎮 Human tactics.</b> Prefer to fly the fleets yourselves? <i>Live reconciliation</i> generates a kickoff save at the shared base turn: load it as host and everyone rejoins by name (bot stand-ins cover the missing) under a short realtime turn clock. The colony and research screens gray out — the economy still follows the script — but the fleets, the wars and the invasions are yours. Same scoring.</li>
        <li><b>Determinism.</b> The same set of files produces the identical reconciliation for every player who runs it, in any order. A missing player's file is allowed: that empire fights on as a plain CPU from the shared base (you'll see a warning).</li>
      </ul>
      <p>
        The result is a normal save: press <i>🎬 Watch what really happened</i> for the cinematic
        replay through any player's eyes, or download it like any other game.
      </p>

      <h3 id="man-pbm">📬 Play by mail</h3>
      <p>
        A server holds the authoritative save and who has committed; one player at a time hosts the
        room, and the game advances whenever the last player mails in their turn. Unlike async mode,
        play-by-mail is still one shared timeline — reconciliation is not involved.
      </p>
    </div>
  </div>
</div>

<style>
  .overlay {
    position: fixed;
    inset: 0;
    background: rgba(0, 0, 0, 0.82);
    display: flex;
    align-items: center;
    justify-content: center;
    z-index: 60;
  }
  .manual {
    background: var(--panel);
    border: 1px solid var(--line-bright);
    border-radius: 10px;
    width: min(94vw, 52rem);
    max-height: 88vh;
    display: flex;
    flex-direction: column;
  }
  .bar {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 0.6rem 0.9rem;
    border-bottom: 1px solid var(--line, #333);
  }
  .body {
    overflow-y: auto;
    padding: 0.4rem 1.1rem 1.1rem;
    font-size: 0.92rem;
  }
  nav {
    position: sticky;
    top: 0;
    background: var(--panel);
    padding: 0.4rem 0;
    font-size: 0.85rem;
  }
  h3 {
    margin: 1.1rem 0 0.35rem;
    color: var(--accent, inherit);
  }
  ul,
  ol {
    margin: 0.25rem 0 0.6rem;
    padding-left: 1.3rem;
  }
  li {
    margin-bottom: 0.3rem;
  }
</style>
