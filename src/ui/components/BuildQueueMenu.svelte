<script lang="ts">
  // The build menu: ONE control that shows what a colony is building, the
  // whole queue in order, and everything it could build next (bugs.md: "when
  // you click on the dropdown, you can see the current queue and add or move
  // things around there"). Used by the colonies spreadsheet and the map's
  // planet popup. Every edit calls submitQueue with the full new list — the
  // parent owns the set_build_queue command (and its pinning side effects).
  import { itemMayRepeat } from '@engine/index';

  interface Entry {
    item: string;
    repeat?: boolean;
  }
  let {
    colonyId,
    colonyName,
    entries,
    buildable,
    label,
    describe = () => '',
    disabled = false,
    disabledNote = '',
    submitQueue,
  }: {
    colonyId: number;
    colonyName: string;
    entries: Entry[];
    buildable: string[];
    label: (item: string) => string;
    describe?: (item: string) => string;
    disabled?: boolean;
    disabledNote?: string;
    submitQueue: (items: Entry[]) => void;
  } = $props();

  let open = $state(false);
  let filter = $state('');
  let triggerEl = $state<HTMLButtonElement | null>(null);
  let panelEl = $state<HTMLDivElement | null>(null);
  let panelStyle = $state('');

  const activeLabel = $derived(entries.length ? `${entries[0]!.repeat ? '⟳ ' : ''}${label(entries[0]!.item)}` : '— build —');
  const options = $derived(
    filter.trim() ? buildable.filter((id) => label(id).toLowerCase().includes(filter.trim().toLowerCase())) : buildable,
  );

  /** the panel is position:fixed so it escapes the table's scroll container;
   * it opens under the trigger, or above it when the footer is too close */
  function openMenu() {
    if (disabled || !triggerEl) return;
    const r = triggerEl.getBoundingClientRect();
    const panelW = 340;
    const margin = 8;
    const left = Math.max(margin, Math.min(r.left, window.innerWidth - panelW - margin));
    const below = window.innerHeight - r.bottom - margin;
    const above = r.top - margin;
    panelStyle =
      below >= 300 || below >= above
        ? `left:${left}px; top:${r.bottom + 4}px; max-height:${Math.min(480, below)}px`
        : `left:${left}px; bottom:${window.innerHeight - r.top + 4}px; max-height:${Math.min(480, above)}px`;
    filter = '';
    open = true;
  }
  function toggleMenu() {
    if (open) open = false;
    else openMenu();
  }
  function onWindowPointerDown(ev: PointerEvent) {
    if (!open) return;
    const t = ev.target as Node;
    if (panelEl?.contains(t) || triggerEl?.contains(t)) return;
    open = false;
  }
  function onWindowKey(ev: KeyboardEvent) {
    if (open && ev.key === 'Escape') open = false;
  }

  function move(i: number, d: number) {
    const j = i + d;
    if (j < 0 || j >= entries.length) return;
    const next = [...entries];
    [next[i], next[j]] = [next[j]!, next[i]!];
    submitQueue(next);
  }
  function front(i: number) {
    if (i <= 0) return;
    submitQueue([entries[i]!, ...entries.slice(0, i), ...entries.slice(i + 1)]);
  }
  function remove(i: number) {
    submitQueue(entries.filter((_, k) => k !== i));
  }
  function toggleRepeat(i: number) {
    const e = entries[i]!;
    const next = [...entries];
    next[i] = { item: e.item, ...(e.repeat ? {} : { repeat: true }) };
    submitQueue(next);
  }
  function add(item: string, where: 'front' | 'back') {
    submitQueue(where === 'front' ? [{ item }, ...entries] : [...entries, { item }]);
  }
</script>

<svelte:window onpointerdown={onWindowPointerDown} onkeydown={onWindowKey} />

<button
  class="qtrigger"
  class:idle={entries.length === 0}
  bind:this={triggerEl}
  data-testid="build-{colonyId}"
  {disabled}
  title={disabled
    ? disabledNote
    : entries.length
      ? `${colonyName} — ${label(entries[0]!.item)}${describe(entries[0]!.item) ? `: ${describe(entries[0]!.item)}` : ''} — click to see and edit the whole queue`
      : `${colonyName} — nothing queued: click to pick a build`}
  onclick={toggleMenu}
>
  {activeLabel}{#if entries.length > 1}<span class="qcount" title="{entries.length - 1} more queued">+{entries.length - 1}</span>{/if}
  <span class="caret">▾</span>
</button>

{#if open}
  <div class="qmenu" data-testid="queue-menu-{colonyId}" style={panelStyle} bind:this={panelEl}>
    <div class="qhead">{colonyName} — build queue</div>
    {#if entries.length === 0}
      <div class="qempty">nothing queued — production would be wasted</div>
    {:else}
      <ol class="qlist">
        {#each entries as e, i (i)}
          <li data-testid="menu-q-{colonyId}-{i}">
            <span class="pos">{i === 0 ? '▶' : i + 1}</span>
            <span class="qlabel" title={describe(e.item)}>{e.repeat ? '⟳ ' : ''}{label(e.item)}</span>
            <span class="qacts">
              {#if itemMayRepeat(e.item)}
                <button
                  class="mini"
                  class:on={e.repeat === true}
                  data-testid="menu-repeat-{colonyId}-{i}"
                  title={e.repeat ? 'repeat is ON: another copy starts each time this completes — click to turn off' : 'repeat: keep building copies until you turn it off'}
                  onclick={() => toggleRepeat(i)}
                >⟳</button>
              {/if}
              <button class="mini" disabled={i === 0} data-testid="menu-up-{colonyId}-{i}" title="move up" onclick={() => move(i, -1)}>▲</button>
              <button class="mini" disabled={i === entries.length - 1} data-testid="menu-down-{colonyId}-{i}" title="move down" onclick={() => move(i, 1)}>▼</button>
              {#if i > 0}
                <button class="mini" data-testid="menu-front-{colonyId}-{i}" title="build NOW — everything else keeps its order" onclick={() => front(i)}>⏫</button>
              {/if}
              <button class="mini" data-testid="menu-remove-{colonyId}-{i}" title="remove from the queue" onclick={() => remove(i)}>✕</button>
            </span>
          </li>
        {/each}
      </ol>
    {/if}
    <div class="qaddhead">
      <span>add to the queue</span>
      <input placeholder="filter…" bind:value={filter} data-testid="menu-filter-{colonyId}" />
    </div>
    <ul class="qadd">
      {#each options as item (item)}
        <li>
          <button
            class="additem"
            data-testid="menu-add-{colonyId}-{item}"
            title="add {label(item)} to the BACK of the queue{describe(item) ? ` — ${describe(item)}` : ''}"
            onclick={() => add(item, 'back')}
          >＋ {label(item)}</button>
          <button
            class="mini now"
            data-testid="menu-now-{colonyId}-{item}"
            title="build {label(item)} NOW — it goes in front and nothing already invested is lost"
            onclick={() => add(item, 'front')}
          >⚡</button>
        </li>
      {/each}
      {#if options.length === 0}
        <li class="qempty">nothing matches</li>
      {/if}
    </ul>
  </div>
{/if}

<style>
  .qtrigger {
    display: inline-flex;
    align-items: center;
    gap: 0.3rem;
    max-width: 13rem;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-size: 0.82rem;
  }
  .qtrigger.idle {
    color: var(--text-dim);
  }
  .qcount {
    background: var(--panel-3);
    border-radius: 8px;
    padding: 0 0.3rem;
    font-size: 0.72rem;
  }
  .caret {
    opacity: 0.6;
    font-size: 0.7rem;
  }
  .qmenu {
    position: fixed;
    z-index: 60; /* above the sticky footer (10) and the edge overlay (35) */
    width: 340px;
    max-width: 92vw;
    overflow: auto;
    background: var(--panel-2);
    border: 1px solid var(--line);
    border-radius: 8px;
    box-shadow: 0 8px 28px rgba(0, 0, 0, 0.55);
    padding: 0.4rem;
    font-size: 0.84rem;
  }
  .qhead {
    font-weight: 600;
    padding: 0.15rem 0.25rem 0.35rem;
    border-bottom: 1px solid var(--line);
  }
  .qempty {
    color: var(--text-dim);
    padding: 0.35rem 0.25rem;
  }
  .qlist {
    list-style: none;
    margin: 0.25rem 0;
    padding: 0;
  }
  .qlist li {
    display: flex;
    align-items: center;
    gap: 0.35rem;
    padding: 0.14rem 0.15rem;
    border-radius: 5px;
  }
  .qlist li:hover {
    background: var(--panel-3);
  }
  .pos {
    width: 1.2rem;
    text-align: right;
    color: var(--text-dim);
    font-size: 0.75rem;
  }
  .qlabel {
    flex: 1;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .qacts {
    display: inline-flex;
    gap: 0.15rem;
  }
  .mini {
    font-size: 0.72rem;
    padding: 0.05rem 0.3rem;
    line-height: 1.3;
  }
  .mini.on {
    background: var(--accent, #4a7);
    color: var(--bg);
  }
  .qaddhead {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 0.5rem;
    margin-top: 0.3rem;
    padding: 0.25rem;
    border-top: 1px solid var(--line);
    color: var(--text-dim);
    font-size: 0.78rem;
  }
  .qaddhead input {
    width: 9rem;
    font-size: 0.78rem;
    padding: 0.1rem 0.3rem;
  }
  .qadd {
    list-style: none;
    margin: 0.15rem 0 0;
    padding: 0;
  }
  .qadd li {
    display: flex;
    align-items: center;
    gap: 0.3rem;
    padding: 0.06rem 0.15rem;
  }
  .additem {
    flex: 1;
    text-align: left;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-size: 0.8rem;
  }
  .now {
    flex: none;
  }
</style>
