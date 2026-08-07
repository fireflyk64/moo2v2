<script lang="ts">
  // Replay screen: scrub a saved game turn by turn on the REAL map, through
  // any player's eyes. The banner strip switches perspective instantly —
  // vision is recomputed per (state, empire) by selectors.galaxyView, so a
  // click is all it costs. Animation mode steps the turns automatically.
  import { app } from '../state.svelte';
  import { getCurrentReplay, setCurrentReplay } from '../replay';
  import { playerColor, syncEmpireColors } from '../colors';
  import MapView from './MapView.svelte';
  import type { TurnEvent } from '@engine/types';

  const data = getCurrentReplay();

  let turnIdx = $state(0);
  let viewAs = $state(data?.empires[0]?.id ?? 0);
  let playing = $state(false);
  let turnsPerSec = $state(2);

  const lastIdx = $derived(data ? data.turns.length - 1 : 0);
  const turn = $derived(data ? data.turns[Math.min(turnIdx, lastIdx)]! : 1);
  const current = $derived(data ? (data.stateAt.get(turn) ?? null) : null);

  $effect(() => {
    if (current) syncEmpireColors(current.empires);
  });

  $effect(() => {
    if (!playing) return;
    const iv = setInterval(() => {
      if (turnIdx >= lastIdx) {
        playing = false;
        return;
      }
      turnIdx++;
    }, 1000 / turnsPerSec);
    return () => clearInterval(iv);
  });

  function close() {
    setCurrentReplay(null);
    app.screen = 'home';
  }

  function onKey(e: KeyboardEvent) {
    const t = e.target as HTMLElement | null;
    const typing = !!t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable);
    if (typing) return;
    if (e.key === 'Escape') {
      e.preventDefault();
      close();
    } else if (e.key === ' ') {
      e.preventDefault();
      if (!playing && turnIdx >= lastIdx) turnIdx = 0;
      playing = !playing;
    } else if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
      e.preventDefault();
      playing = false;
      turnIdx = Math.max(0, Math.min(lastIdx, turnIdx + (e.key === 'ArrowRight' ? 1 : -1)));
    }
  }

  /** the viewed player's slice of the resolution feed for this turn */
  const feed = $derived.by(() => {
    if (!data) return [] as TurnEvent[];
    return (data.eventsAt.get(turn) ?? []).filter((e) => e.visibleTo === -1 || e.visibleTo === viewAs);
  });

  function eventText(e: TurnEvent): string {
    const p = e.payload;
    const starName = (id: unknown) => current?.stars.find((s) => s.id === id)?.name ?? `star #${id}`;
    const empName = (id: unknown) => data?.empires.find((x) => x.id === id)?.name ?? `#${id}`;
    const bits: string[] = [e.kind.replaceAll('_', ' ')];
    if (typeof p['starId'] === 'number') bits.push(`@ ${starName(p['starId'])}`);
    if (typeof p['empireId'] === 'number') bits.push(`(${empName(p['empireId'])})`);
    if (typeof p['winner'] === 'number') bits.push(`— ${empName(p['winner'])} prevails`);
    return bits.join(' ');
  }

  const eliminatedNow = (id: number) => current?.empires.find((e) => e.id === id)?.eliminated ?? false;
</script>

<svelte:window onkeydown={onKey} />

{#if !data || !current}
  <main class="empty">
    <p>No replay is loaded.</p>
    <button onclick={close}>← back</button>
  </main>
{:else}
  <main class="replay" data-testid="replay-viewer">
    <header>
      <b>🎞 Replay</b>
      <span class="turn" data-testid="replay-turn">turn {turn} / {data.turns[lastIdx]}</span>
      {#if data.mode === 'snapshot'}
        <span class="dim" title="this save was written by a different build (or without history) — only its embedded snapshot turns can be shown">snapshot turns only</span>
      {/if}
      <input
        class="scrub"
        type="range"
        min="0"
        max={lastIdx}
        value={turnIdx}
        data-testid="replay-scrub"
        oninput={(e) => {
          playing = false;
          turnIdx = Number((e.target as HTMLInputElement).value);
        }}
      />
      <button
        data-testid="replay-play"
        onclick={() => {
          if (!playing && turnIdx >= lastIdx) turnIdx = 0;
          playing = !playing;
        }}
      >{playing ? '⏸ Pause' : '▶ Play'}</button>
      <button onclick={() => (turnsPerSec = turnsPerSec === 1 ? 2 : turnsPerSec === 2 ? 5 : turnsPerSec === 5 ? 10 : 1)}>{turnsPerSec} t/s</button>
      <button data-testid="replay-close" title="close (Esc) · Space play/pause · ←→ step" onclick={close}>✕ Close</button>
    </header>
    <div class="banners" data-testid="replay-banners">
      <span class="dim">viewing as</span>
      {#each data.empires as emp (emp.id)}
        <button
          class="banner"
          class:active={viewAs === emp.id}
          class:dead={eliminatedNow(emp.id)}
          style="--c:{playerColor(emp.id)}"
          data-testid="replay-banner-{emp.id}"
          title="{emp.name} — {emp.raceName}{eliminatedNow(emp.id) ? ' (eliminated by this turn)' : ''}"
          onclick={() => (viewAs = emp.id)}
        >
          <span class="swatch"></span>{emp.name}
        </button>
      {/each}
    </div>
    <div class="stage">
      <div class="map">
        <MapView replayState={current} replayViewAs={viewAs} />
      </div>
      {#if feed.length}
        <aside class="feed" data-testid="replay-feed">
          <b class="dim">this turn, as {data.empires.find((e) => e.id === viewAs)?.name}</b>
          <ul>
            {#each feed.slice(0, 40) as ev, i (i)}
              <li>{eventText(ev)}</li>
            {/each}
          </ul>
        </aside>
      {/if}
    </div>
  </main>
{/if}

<style>
  .replay {
    display: flex;
    flex-direction: column;
    height: 100vh;
    gap: 0.35rem;
    padding: 0.4rem 0.6rem;
    box-sizing: border-box;
  }
  header {
    display: flex;
    align-items: center;
    gap: 0.7rem;
  }
  .turn {
    font-variant-numeric: tabular-nums;
    color: var(--text-dim);
  }
  .scrub {
    flex: 1;
  }
  .dim {
    color: var(--text-dim);
    font-size: 0.82rem;
  }
  .banners {
    display: flex;
    align-items: center;
    gap: 0.4rem;
    flex-wrap: wrap;
  }
  .banner {
    display: inline-flex;
    align-items: center;
    gap: 0.35rem;
    border: 1px solid var(--line, #444);
    border-radius: 999px;
    padding: 0.15rem 0.65rem;
    background: transparent;
    cursor: pointer;
  }
  .banner .swatch {
    width: 0.7rem;
    height: 0.7rem;
    border-radius: 50%;
    background: var(--c);
    display: inline-block;
  }
  .banner.active {
    border-color: var(--c);
    box-shadow: 0 0 0 1px var(--c);
  }
  .banner.dead {
    opacity: 0.45;
    text-decoration: line-through;
  }
  .stage {
    flex: 1;
    min-height: 0;
    display: flex;
    gap: 0.5rem;
  }
  .map {
    flex: 1;
    min-width: 0;
    min-height: 0;
    overflow: auto;
  }
  .feed {
    width: 16rem;
    overflow-y: auto;
    font-size: 0.8rem;
    border-left: 1px solid var(--line, #333);
    padding-left: 0.5rem;
  }
  .feed ul {
    margin: 0.3rem 0 0;
    padding-left: 1rem;
  }
  .feed li {
    margin-bottom: 0.2rem;
  }
  .empty {
    display: grid;
    place-items: center;
    height: 100vh;
  }
</style>
