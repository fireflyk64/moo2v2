<script lang="ts">
  import StorageSmoke from './dev/StorageSmoke.svelte';
  import BattleLab from './screens/BattleLab.svelte';
  import Home from './screens/Home.svelte';
  import Lobby from './screens/Lobby.svelte';
  import GameShell from './screens/GameShell.svelte';
  import { app } from './state.svelte';

  let route = $state(location.hash);
  window.addEventListener('hashchange', () => (route = location.hash));

  // deployment update check: the served version.json changes on every build;
  // when it stops matching OUR build id, offer a reload (cache busting)
  let updateAvailable = $state(false);
  async function checkVersion() {
    if (import.meta.env.DEV || updateAvailable) return;
    try {
      const res = await fetch('version.json', { cache: 'no-store' });
      if (!res.ok) return;
      const v = (await res.json()) as { build?: string };
      if (v.build && v.build !== __BUILD_ID__) updateAvailable = true;
    } catch {
      // offline or host without version.json: nothing to do
    }
  }
  $effect(() => {
    void checkVersion();
    const iv = setInterval(() => void checkVersion(), 5 * 60_000);
    const onFocus = () => void checkVersion();
    window.addEventListener('focus', onFocus);
    return () => {
      clearInterval(iv);
      window.removeEventListener('focus', onFocus);
    };
  });

  $effect(() => {
    // Prevent browser/page zoom from Ctrl/Cmd+wheel across the app.
    // Specific widgets can opt in by setting data-allow-ctrl-wheel-zoom="true".
    const onWheel = (ev: WheelEvent) => {
      if (!ev.ctrlKey && !ev.metaKey) return;
      const target = ev.target as HTMLElement | null;
      if (target?.closest('[data-allow-ctrl-wheel-zoom="true"]')) return;
      ev.preventDefault();
    };
    window.addEventListener('wheel', onWheel, { capture: true, passive: false });
    return () => window.removeEventListener('wheel', onWheel, { capture: true } as EventListenerOptions);
  });
</script>

<div class="starfield" aria-hidden="true"></div>
<div class="crt" aria-hidden="true"></div>
{#if updateAvailable}
  <div class="updatebar" data-testid="update-available">
    ⬆ A new version of the game was deployed.
    <button onclick={() => location.reload()}>Reload now</button>
    <span class="dim">(finish and 💾 save your turn first if you're mid-game)</span>
  </div>
{/if}
<main>
  {#if route === '#storage-smoke'}
    <StorageSmoke />
  {:else if route === '#battle-lab' && app.screen !== 'game'}
    <BattleLab />
  {:else if app.screen === 'home'}
    <Home />
  {:else if app.screen === 'lobby'}
    <Lobby />
  {:else}
    <GameShell />
    {#if route === '#battle-lab'}
      <!-- mid-game the lab overlays the shell instead of unmounting it, so the
           commit bar and battle-orders dialogs keep working underneath -->
      <div class="lab-overlay">
        <BattleLab />
      </div>
    {/if}
  {/if}
</main>

<style>
  .updatebar {
    position: sticky;
    top: 0;
    z-index: 90;
    background: color-mix(in srgb, var(--gold) 16%, var(--bg));
    border-bottom: 1px solid var(--gold);
    color: var(--gold);
    padding: 0.35rem 0.8rem;
    font-size: 0.9rem;
  }
  .updatebar .dim {
    opacity: 0.7;
    font-size: 0.8rem;
  }
  /* below the battle-orders dialog (40) and auto-turn banner (30/35): a battle
     popping while the lab is open must still reach the player */
  .lab-overlay {
    position: fixed;
    inset: 0;
    z-index: 20;
    overflow: auto;
    background: var(--bg);
  }

  /* all theme tokens live in src/ui/theme.css (imported by main.ts) */
  :global(body) {
    margin: 0;
    background: radial-gradient(120% 90% at 20% -10%, var(--bg-glow-a) 0%, var(--bg-glow-b) 45%, var(--bg) 100%) fixed;
    color: var(--text);
    font-family: var(--font-ui);
    line-height: 1.45;
  }
  /* retro terminal finish: faint scanlines + corner vignette. Strength comes
     from the theme (--scanline-alpha: 0 turns it off entirely). */
  .crt {
    position: fixed;
    inset: 0;
    pointer-events: none;
    z-index: 80;
    background-image: repeating-linear-gradient(
        0deg,
        rgba(0, 0, 0, var(--scanline-alpha)) 0px,
        rgba(0, 0, 0, var(--scanline-alpha)) 1px,
        transparent 1px,
        transparent 3px
      ),
      radial-gradient(ellipse 120% 120% at 50% 45%, transparent 65%, rgba(0, 0, 0, 0.28) 100%);
  }
  .starfield {
    position: fixed;
    inset: 0;
    pointer-events: none;
    z-index: 0;
    background-image:
      radial-gradient(1px 1px at 12% 22%, rgba(255, 255, 255, 0.55) 50%, transparent 51%),
      radial-gradient(1px 1px at 34% 68%, rgba(190, 210, 255, 0.4) 50%, transparent 51%),
      radial-gradient(1.5px 1.5px at 56% 14%, rgba(255, 255, 255, 0.45) 50%, transparent 51%),
      radial-gradient(1px 1px at 71% 47%, rgba(255, 230, 190, 0.4) 50%, transparent 51%),
      radial-gradient(1px 1px at 86% 79%, rgba(255, 255, 255, 0.35) 50%, transparent 51%),
      radial-gradient(1.5px 1.5px at 8% 84%, rgba(170, 200, 255, 0.4) 50%, transparent 51%),
      radial-gradient(1px 1px at 45% 91%, rgba(255, 255, 255, 0.3) 50%, transparent 51%),
      radial-gradient(1px 1px at 92% 9%, rgba(255, 255, 255, 0.45) 50%, transparent 51%),
      radial-gradient(1.2px 1.2px at 63% 33%, rgba(255, 255, 255, 0.3) 50%, transparent 51%),
      radial-gradient(1px 1px at 25% 45%, rgba(255, 255, 255, 0.25) 50%, transparent 51%);
    background-size:
      1100px 700px, 900px 600px, 1300px 800px, 1000px 750px, 1200px 900px,
      950px 650px, 1150px 850px, 1050px 700px, 850px 550px, 1250px 950px;
  }
  main {
    position: relative;
    z-index: 1;
    padding: 0;
    min-height: 100vh;
    /* column flex so the game shell's <section> can grow and push the sticky
       chat footer to the true bottom — otherwise short pages leave an
       unsightly dead strip below the chat */
    display: flex;
    flex-direction: column;
  }

  /* ---------- shared control styling (global design system) ---------- */
  /* buttons are DEVICE controls: bright machined-gray faces with a noise
     texture and a top bevel, pressed into the dark screen chrome */
  :global(button) {
    background: var(--device-texture), linear-gradient(180deg, var(--device-hi), var(--device-mid) 45%, var(--device-lo));
    color: var(--device-text);
    border: 1px solid var(--device-edge);
    border-radius: var(--radius);
    padding: 0.28rem 0.7rem;
    font: inherit;
    font-size: 0.84rem;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    cursor: pointer;
    box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.22), inset 0 -1px 0 rgba(0, 0, 0, 0.45);
    text-shadow: 0 1px 0 rgba(0, 0, 0, 0.4);
    transition: border-color 0.15s, box-shadow 0.15s, transform 0.08s, background 0.15s, filter 0.15s;
  }
  :global(button:hover:not(:disabled)) {
    border-color: var(--accent);
    box-shadow: var(--glow), inset 0 1px 0 rgba(255, 255, 255, 0.22), inset 0 -1px 0 rgba(0, 0, 0, 0.45);
    filter: brightness(1.12);
  }
  :global(button:active:not(:disabled)) {
    transform: translateY(1px);
    filter: brightness(0.92);
  }
  :global(button:disabled) {
    opacity: 0.45;
    cursor: default;
  }
  /* inputs are SCREEN wells: flat dark glass, no glow (bugs.md: no bleed) */
  :global(input),
  :global(select) {
    background: var(--input-bg);
    color: var(--text);
    border: 1px solid var(--line);
    border-radius: var(--radius);
    padding: 0.26rem 0.5rem;
    font: inherit;
    font-size: 0.88rem;
  }
  :global(input:focus),
  :global(select:focus),
  :global(button:focus-visible) {
    outline: none;
    border-color: var(--accent);
    box-shadow: var(--focus-ring);
  }
  :global(input[type='checkbox']),
  :global(input[type='radio']) {
    accent-color: var(--accent);
  }
  :global(input[type='range']) {
    accent-color: var(--accent);
    padding: 0;
  }
  :global(h1),
  :global(h2),
  :global(h3),
  :global(h4) {
    letter-spacing: 0.04em;
  }
  :global(table) {
    border-collapse: collapse;
  }
  /* column headers are DEVICE rails: textured gray strips over the glass */
  :global(thead th) {
    background: var(--device-texture), linear-gradient(180deg, var(--device-mid), var(--device-lo));
    color: var(--device-text);
    text-transform: uppercase;
    font-size: 0.72rem;
    letter-spacing: 0.08em;
    box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.14), inset 0 -1px 0 rgba(0, 0, 0, 0.4);
    text-shadow: 0 1px 0 rgba(0, 0, 0, 0.4);
  }
  :global(tbody tr:hover td) {
    background: color-mix(in srgb, var(--accent) 6%, transparent);
  }
  :global(::-webkit-scrollbar) {
    width: 10px;
    height: 10px;
  }
  :global(::-webkit-scrollbar-thumb) {
    background: var(--panel-3);
    border-radius: 6px;
    border: 2px solid var(--bg);
  }
  :global(::-webkit-scrollbar-track) {
    background: transparent;
  }
</style>
