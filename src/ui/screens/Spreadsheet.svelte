<script lang="ts">
  // The system-wide colonies spreadsheet: the primary way to run your empire.
  // Every edit is an optimistic command; dirty cells resolve on host accept.
  import { selectors, itemLabel, explainOutput, COLONY_TAGS } from '@engine/index';
  import { app, getActive } from '../state.svelte';

  const session = () => getActive()!.session;
  const allRowsWithOutposts = $derived.by(() => {
    void app.version;
    const s = session().getPlanned();
    return s ? selectors.colonyRows(s, session().playerId) : [];
  });
  // outposts are fuel stops, not economies: they live on the map, not here
  const allRows = $derived(allRowsWithOutposts.filter((r) => !r.outpost));
  const outpostCount = $derived(allRowsWithOutposts.length - allRows.length);
  const stickyMode = $derived.by(() => {
    void app.version;
    return session().getPlanned()?.settings.modes.stickyBuild === true;
  });
  const label = (item: string) => {
    const s = session().getPlanned();
    return s ? itemLabel(s, session().playerId, item) : item;
  };
  const pretty = (id: string) => id.replaceAll('_', ' ');

  /** what each planet feature means for production (hover on the planet cell) */
  const MINERAL_PROD_INFO: Record<string, string> = {
    ultra_poor: '1 production per worker',
    poor: '2 production per worker',
    abundant: '3 production per worker',
    rich: '5 production per worker',
    ultra_rich: '8 production per worker',
  };
  const SPECIAL_INFO: Record<string, { icon: string; text: string }> = {
    gold_deposits: { icon: '🥇', text: 'gold deposits: +5 BC per turn' },
    gem_deposits: { icon: '💎', text: 'gem deposits: +10 BC per turn' },
    ancient_artifacts: { icon: '🏺', text: 'ancient artifacts: +2 research per scientist' },
  };
  function planetTitle(row: selectors.ColonyRow): string {
    const p = row.planet;
    const lines = [
      `${p.climate} · size ${p.sizeClass}`,
      `${pretty(p.minerals)} minerals — ${MINERAL_PROD_INFO[p.minerals] ?? ''}`,
      p.gravity === 'normal' ? 'normal gravity' : `${p.gravity} gravity — −25% output per step without a gravity generator`,
    ];
    if (p.special && SPECIAL_INFO[p.special]) lines.push(`${SPECIAL_INFO[p.special]!.icon} ${SPECIAL_INFO[p.special]!.text}`);
    return lines.join('\n');
  }

  // ---- filter + sort ----
  let filter = $state('');
  let showTags = $state(localStorage.getItem('moo2.showTags') !== '0');
  function toggleTags() {
    showTags = !showTags;
    localStorage.setItem('moo2.showTags', showTags ? '1' : '0');
  }
  type SortKey = 'name' | 'pop' | 'food' | 'prod' | 'sci' | 'bc' | 'morale' | 'building';
  let sortKey = $state<SortKey>('name');
  let sortDir = $state(1);
  function sortBy(k: SortKey) {
    if (sortKey === k) sortDir = -sortDir;
    else {
      sortKey = k;
      sortDir = k === 'name' || k === 'building' ? 1 : -1;
    }
  }
  const keyFns: Record<SortKey, (r: selectors.ColonyRow) => string | number> = {
    name: (r) => r.name,
    pop: (r) => r.popUnits,
    food: (r) => r.output.foodNet,
    prod: (r) => r.output.prodToQueue || r.output.prod,
    sci: (r) => r.output.research,
    bc: (r) => r.output.bcIncome,
    morale: (r) => r.output.moralePct,
    building: (r) => r.activeItem ?? '',
  };
  const rows = $derived.by(() => {
    let out = allRows;
    const f = filter.trim().toLowerCase();
    if (f) {
      out = out.filter(
        (r) =>
          r.name.toLowerCase().includes(f) ||
          r.starName.toLowerCase().includes(f) ||
          r.planet.climate.includes(f) ||
          (r.activeItem ?? '').includes(f) ||
          r.tags.some((t) => t.includes(f)),
      );
    }
    const fn = keyFns[sortKey];
    return [...out].sort((a, b) => {
      const x = fn(a);
      const y = fn(b);
      const c = typeof x === 'string' ? x.localeCompare(y as string) : (x as number) - (y as number);
      return c !== 0 ? c * sortDir : a.id - b.id;
    });
  });
  const totals = $derived.by(() => {
    const t = { pop: 0, growthK: 0, food: 0, prod: 0, sci: 0, bc: 0, pollution: 0 };
    for (const r of allRows) {
      if (r.outpost) continue;
      t.pop += r.popUnits;
      t.growthK += r.growthK;
      t.food += r.output.foodNet;
      t.prod += r.output.prodToQueue || r.output.prod;
      t.sci += r.output.research;
      t.bc += r.output.bcIncome;
      t.pollution += r.output.pollution;
    }
    return t;
  });
  const growthLabel = (k: number) => {
    const v = k / 1000;
    // tiny-but-nonzero growth still reads as growth (+0.04, not +0.0)
    const s = v !== 0 && Math.abs(v) < 0.1 ? v.toFixed(2) : v.toFixed(1);
    return `${v >= 0 ? '+' : ''}${s}`;
  };

  /** hover breakdown per output column: every coefficient and where it's from */
  function explain(rowId: number): { farm: string; prod: string; sci: string; bc: string } {
    const s = session().getPlanned();
    const c = s?.colonies.find((x) => x.id === rowId);
    if (!s || !c || c.outpost) return { farm: '', prod: '', sci: '', bc: '' };
    const ex = explainOutput(s, c);
    return {
      farm: ex.farm.join('\n'),
      prod: ex.prod.join('\n'),
      sci: ex.sci.join('\n'),
      bc: ex.bc.join('\n'),
    };
  }

  // ---- bulk ops ----
  let selected = $state<Set<number>>(new Set());
  function toggleSelect(id: number) {
    const next = new Set(selected);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    selected = next;
  }
  function bulkBuild(item: string) {
    if (!item) return;
    for (const row of rows) {
      if (!selected.has(row.id) || !row.buildable.includes(item)) continue;
      const items = row.queue.length ? [item, ...row.queue.slice(1)] : [item];
      submitNoted('set_build_queue', { colonyId: row.id, items });
    }
  }
  /** queue an item on every selected colony: 'front' = right after the item
   * being built (nothing invested is lost), 'back' = end of the queue */
  function bulkQueue(item: string, where: 'front' | 'back') {
    if (!item) return;
    for (const row of rows) {
      if (!selected.has(row.id) || !row.buildable.includes(item)) continue;
      const items =
        where === 'back' || row.queue.length === 0
          ? [...row.queue, item]
          : [row.queue[0]!, item, ...row.queue.slice(1)];
      submitNoted('set_build_queue', { colonyId: row.id, items });
    }
  }
  const bulkOptions = $derived.by(() => {
    const chosen = rows.filter((r) => selected.has(r.id));
    if (!chosen.length) return [];
    const common = new Set(chosen[0]!.buildable);
    for (const r of chosen.slice(1)) {
      for (const item of [...common]) if (!r.buildable.includes(item)) common.delete(item);
    }
    return [...common].sort();
  });
  const selectableRows = $derived(rows.filter((r) => !r.outpost));
  function selectAllFiltered() {
    selected = new Set(selectableRows.map((r) => r.id));
  }
  /** quick job configurations for every selected colony */
  function applyPreset(preset: selectors.JobPreset) {
    const s = session().getPlanned();
    if (!s) return;
    for (const row of rows) {
      if (!selected.has(row.id) || row.outpost) continue;
      const groups = selectors.presetJobs(s, row.id, preset);
      if (groups) session().submit('set_jobs', { colonyId: row.id, groups });
    }
  }

  type Job = 'farmers' | 'workers' | 'scientists';
  /** reassign within ONE race group — captured colonists keep their own
   * group, so a multi-race colony never gets its groups overwritten */
  function moveJob(row: selectors.ColonyRow, race: number, fromJob: Job, toJob: Job, count = 1) {
    const grp = row.groups.find((g) => g.race === race);
    if (!grp) return;
    const n = Math.min(count, grp[fromJob]);
    if (fromJob === toJob || n <= 0) return;
    const jobs = { race: grp.race, farmers: grp.farmers, workers: grp.workers, scientists: grp.scientists };
    jobs[fromJob] -= n;
    jobs[toJob] += n;
    session().submit('set_jobs', { colonyId: row.id, groups: [jobs] });
  }

  // (the old +/- buttons are gone: dragging citizens replaced them)

  // ---- drag colonists: between job columns, or onto a same-system colony ----
  // Clicking citizen i selects it AND everyone to its right in its own race
  // group; a drag then carries the whole selection (dragging without clicking
  // first does the same from the grabbed icon).
  const JOB_ICONS: Record<Job, string> = { farmers: '🌾', workers: '🔨', scientists: '🧪' };
  let picked = $state<{ colonyId: number; job: Job; race: number; from: number } | null>(null);
  function pickFrom(row: selectors.ColonyRow, job: Job, race: number, i: number) {
    if (picked && picked.colonyId === row.id && picked.job === job && picked.race === race && picked.from === i) {
      picked = null;
    } else {
      picked = { colonyId: row.id, job, race, from: i };
    }
  }
  const isPicked = (row: selectors.ColonyRow, job: Job, race: number, i: number): boolean =>
    !!picked && picked.colonyId === row.id && picked.job === job && picked.race === race && i >= picked.from;
  /** how many citizens a drag starting at icon i of a group carries */
  function grabCount(row: selectors.ColonyRow, job: Job, race: number, i: number): number {
    const grp = row.groups.find((g) => g.race === race);
    if (!grp) return 1;
    const from =
      picked && picked.colonyId === row.id && picked.job === job && picked.race === race && picked.from <= i
        ? picked.from
        : i;
    return grp[job] - from;
  }
  /** icons always overlap a bit (negative kerning), tighter as counts grow */
  const overlapPx = (count: number): number => (count <= 4 ? 3 : count <= 8 ? 6 : count <= 14 ? 8 : 10);
  let drag = $state<{ colonyId: number; job: Job; race: number; count: number } | null>(null);
  let dragOver = $state<{ colonyId: number; job: Job } | null>(null);
  let dragOverColony = $state<number | null>(null);
  let moveNote = $state('');
  let moveNoteTimer: ReturnType<typeof setTimeout> | null = null;
  function note(text: string) {
    moveNote = text;
    if (moveNoteTimer) clearTimeout(moveNoteTimer);
    moveNoteTimer = setTimeout(() => (moveNote = ''), 5000);
  }
  function onDragStart(row: selectors.ColonyRow, job: Job, race: number, i: number, ev: DragEvent) {
    drag = { colonyId: row.id, job, race, count: Math.max(1, grabCount(row, job, race, i)) };
    ev.dataTransfer?.setData('text/plain', `${row.id}:${job}:${race}:${drag.count}`);
    if (ev.dataTransfer) ev.dataTransfer.effectAllowed = 'move';
  }
  function onDrop(row: selectors.ColonyRow, job: Job) {
    if (drag && drag.colonyId === row.id) moveJob(row, drag.race, drag.job, job, drag.count);
    else if (drag && drag.colonyId !== row.id) dropOnColony(row); // job cell of another colony works too
    drag = null;
    picked = null;
    dragOver = null;
    dragOverColony = null;
  }
  /** citizens dropped on a different colony: instant in-system shuttle, or a
   * freighter convoy between systems (5 freighters per colonist, travel time) */
  function dropOnColony(row: selectors.ColonyRow) {
    if (!drag || drag.colonyId === row.id) return;
    const src = allRows.find((r) => r.id === drag!.colonyId);
    if (!src) return;
    const n = drag.count;
    const sameSystem = src.planet.starId === row.planet.starId;
    const res = session().submit('move_colonists', {
      fromColonyId: src.id,
      toColonyId: row.id,
      race: drag.race,
      count: n,
      fromJob: drag.job, // the grabbed citizens leave THEIR job, not scientists
    });
    if (res.error) note(`⛔ ${res.error}`);
    else if (sameSystem) note(`🚚 ${n} colonist${n > 1 ? 's' : ''} shuttled ${src.name} → ${row.name}`);
    else note(`🚚 ${n} colonist${n > 1 ? 's' : ''} boarded freighters ${src.name} → ${row.name} (${5 * n} freighters busy until arrival)`);
  }
  const canDropColony = (row: selectors.ColonyRow): boolean => {
    if (!drag || drag.colonyId === row.id || row.outpost) return false;
    return allRows.some((r) => r.id === drag!.colonyId);
  };

  /** every queue edit surfaces the engine's rejection — a silently ignored
   * error leaves the dropdown face desynced from what is actually building */
  function submitNoted(kind: string, payload: unknown) {
    const res = session().submit(kind, payload);
    if (res.error) note(`⛔ ${res.error}`);
    return res;
  }

  function setBuild(row: selectors.ColonyRow, item: string) {
    if (!item) return;
    // choosing something already queued PROMOTES one instance of it to the
    // active slot — repeats (ships, projects) are preserved, not collapsed
    const idx = row.queue.indexOf(item);
    const items =
      idx >= 0
        ? [item, ...row.queue.slice(0, idx), ...row.queue.slice(idx + 1)]
        : row.queue.length
          ? [item, ...row.queue.slice(1)]
          : [item];
    submitNoted('set_build_queue', { colonyId: row.id, items });
  }

  function removeQueued(row: selectors.ColonyRow, index: number) {
    submitNoted('set_build_queue', {
      colonyId: row.id,
      items: row.queue.filter((_, i) => i !== index),
    });
  }

  function appendBuild(row: selectors.ColonyRow, item: string) {
    if (!item) return;
    submitNoted('set_build_queue', { colonyId: row.id, items: [...row.queue, item] });
  }

  function buy(row: selectors.ColonyRow) {
    submitNoted('buy_production', { colonyId: row.id });
  }

  function sell(row: selectors.ColonyRow, buildingId: string) {
    submitNoted('sell_building', { colonyId: row.id, buildingId });
  }

  let openBuildings = $state<Set<number>>(new Set());
  function toggleBuildings(id: number) {
    const next = new Set(openBuildings);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    openBuildings = next;
  }

  function parked(row: selectors.ColonyRow): string {
    const entries = Object.entries(row.stickyInvested).filter(([, v]) => v > 0);
    if (!entries.length) return '';
    return entries.map(([k, v]) => `${label(k)}: ${v}`).join(', ');
  }

  // ---- rename + tags ----
  let renaming = $state<number | null>(null);
  let renameText = $state('');
  const focusNow = (el: HTMLElement) => el.focus();
  function startRename(row: selectors.ColonyRow) {
    renaming = row.id;
    renameText = row.name;
  }
  function commitRename(row: selectors.ColonyRow) {
    if (renaming !== row.id) return;
    const name = renameText.trim();
    if (name && name !== row.name) session().submit('rename_colony', { colonyId: row.id, name });
    renaming = null;
  }
  function setTags(row: selectors.ColonyRow, tags: string[]) {
    session().submit('set_colony_tags', { colonyId: row.id, tags });
  }
</script>

<div class="bar">
  <input data-testid="colony-filter" placeholder="filter colonies or tags…" bind:value={filter} style="width:12rem" />
  <button data-testid="select-filtered" title="select every colony matching the current filter" onclick={selectAllFiltered}>
    select all ({selectableRows.length})
  </button>
  <button
    class="mini"
    class:dimoff={!showTags}
    data-testid="toggle-tags"
    title={showTags ? 'hide colony tags' : 'show colony tags'}
    onclick={toggleTags}
  >🏷</button>
  {#if selected.size > 0}
    <span>{selected.size} selected:</span>
    <select
      data-testid="bulk-build"
      value=""
      onchange={(e) => {
        bulkBuild((e.target as HTMLSelectElement).value);
        (e.target as HTMLSelectElement).value = '';
      }}
    >
      <option value="">set build for all…</option>
      {#each bulkOptions as item (item)}<option value={item}>{label(item)}</option>{/each}
    </select>
    <select
      data-testid="bulk-queue-front"
      value=""
      title="insert right after each colony's current build (nothing invested is lost)"
      onchange={(e) => {
        bulkQueue((e.target as HTMLSelectElement).value, 'front');
        (e.target as HTMLSelectElement).value = '';
      }}
    >
      <option value="">⤴ queue next for all…</option>
      {#each bulkOptions as item (item)}<option value={item}>{label(item)}</option>{/each}
    </select>
    <select
      data-testid="bulk-queue-back"
      value=""
      title="append to the end of each selected colony's queue"
      onchange={(e) => {
        bulkQueue((e.target as HTMLSelectElement).value, 'back');
        (e.target as HTMLSelectElement).value = '';
      }}
    >
      <option value="">⤵ queue last for all…</option>
      {#each bulkOptions as item (item)}<option value={item}>{label(item)}</option>{/each}
    </select>
    <span class="presets">
      jobs:
      <button data-testid="preset-research" title="minimum farmers to stay fed; everyone else does research" onclick={() => applyPreset('research')}>⚗ research</button>
      <button data-testid="preset-industry" title="minimum farmers to stay fed; everyone else works industry" onclick={() => applyPreset('industry')}>⚒ industry</button>
      <button data-testid="preset-blend" title="industry capped at ≤2 pollution; the rest research" onclick={() => applyPreset('blend')}>⚗⚒ blend</button>
    </span>
    <button onclick={() => (selected = new Set())}>clear selection</button>
  {:else}
    <span class="dim">💡 drag citizens between jobs or onto another colony · ☑ tick rows for bulk builds &amp; presets</span>
  {/if}
  {#if moveNote}
    <span class="movenote" data-testid="move-note">{moveNote}</span>
  {/if}
</div>

<table data-testid="colony-table">
  <thead>
    <tr>
      <th></th>
      <th class="sortable" onclick={() => sortBy('name')}>Colony {sortKey === 'name' ? (sortDir > 0 ? '▲' : '▼') : ''}</th>
      <th>Planet</th>
      <th class="sortable" onclick={() => sortBy('pop')} title="population / capacity (projected growth per turn)">Pop {sortKey === 'pop' ? (sortDir > 0 ? '▲' : '▼') : ''}</th>
      <th class="sortable" onclick={() => sortBy('morale')}>Morale {sortKey === 'morale' ? (sortDir > 0 ? '▲' : '▼') : ''}</th>
      <th title="farmers">🌱</th>
      <th title="workers">⚒</th>
      <th title="scientists">⚗</th>
      <th class="sortable" onclick={() => sortBy('food')} title="net food">🌾 {sortKey === 'food' ? (sortDir > 0 ? '▲' : '▼') : ''}</th>
      <th class="sortable" onclick={() => sortBy('prod')} title="production to the build queue (after pollution)">🔧 {sortKey === 'prod' ? (sortDir > 0 ? '▲' : '▼') : ''}</th>
      <th class="sortable" onclick={() => sortBy('sci')} title="research">🔬 {sortKey === 'sci' ? (sortDir > 0 ? '▲' : '▼') : ''}</th>
      <th class="sortable" onclick={() => sortBy('bc')} title="income">💰 {sortKey === 'bc' ? (sortDir > 0 ? '▲' : '▼') : ''}</th>
      <th title="pollution — lost production this turn">☁️</th>
      <th class="sortable" onclick={() => sortBy('building')}>Building {sortKey === 'building' ? (sortDir > 0 ? '▲' : '▼') : ''}</th>
      <th>Progress</th>
      <th>Buy</th>
      <th>Queue</th>
      <th title="buildings — click 🏛 to inspect and sell">🏛</th>
    </tr>
  </thead>
  <tbody>
    {#each rows as row (row.id)}
      {@const ex = explain(row.id)}
      <tr data-testid="colony-row-{row.id}" class:outpost={row.outpost}>
        <td><input type="checkbox" checked={selected.has(row.id)} onchange={() => toggleSelect(row.id)} /></td>
        <td
          class="name"
          class:shipok={dragOverColony === row.id}
          ondragover={(e) => {
            if (canDropColony(row)) {
              e.preventDefault();
              dragOverColony = row.id;
            }
          }}
          ondragleave={() => {
            if (dragOverColony === row.id) dragOverColony = null;
          }}
          ondrop={(e) => {
            e.preventDefault();
            dropOnColony(row);
            drag = null;
            picked = null;
            dragOver = null;
            dragOverColony = null;
          }}
        >
          {#if renaming === row.id}
            <input
              class="rename"
              data-testid="rename-input-{row.id}"
              bind:value={renameText}
              use:focusNow
              onkeydown={(e) => {
                if (e.key === 'Enter') commitRename(row);
                else if (e.key === 'Escape') renaming = null;
              }}
              onblur={() => commitRename(row)}
              maxlength="24"
            />
          {:else}
            <span
              role="button"
              tabindex="-1"
              title="double-click to rename"
              ondblclick={() => startRename(row)}
              data-testid="colony-name-{row.id}">{row.name}</span>{row.outpost ? ' (outpost)' : ''}
            <button class="mini ghost" data-testid="rename-{row.id}" title="rename colony" onclick={() => startRename(row)}>✏️</button>
            {#if row.leaderName}
              <span class="leader" data-testid="leader-{row.id}" title="governor assigned to this colony (Empires tab)">{row.leaderName}</span>
            {/if}
          {/if}
          {#if showTags}
            <span class="tagsline">
              {#each row.tags as t (t)}
                <button class="tag" data-testid="tag-{row.id}-{t}" title="remove tag {t}" onclick={() => setTags(row, row.tags.filter((x) => x !== t))}>{t}✕</button>
              {/each}
              <select
                class="tagadd"
                data-testid="tag-add-{row.id}"
                value=""
                title="tag this colony"
                onchange={(e) => {
                  const t = (e.target as HTMLSelectElement).value;
                  if (t) setTags(row, [...row.tags, t]);
                  (e.target as HTMLSelectElement).value = '';
                }}
              >
                <option value="">+</option>
                {#each COLONY_TAGS.filter((t) => !row.tags.includes(t)) as t (t)}
                  <option value={t}>{t}</option>
                {/each}
              </select>
            </span>
          {/if}
        </td>
        <td
          class="dim planet"
          title={planetTitle(row)}
        >{#if row.planet.special && SPECIAL_INFO[row.planet.special]}{SPECIAL_INFO[row.planet.special]!.icon} {/if}{row.planet.climate} {pretty(row.planet.minerals)} {row.planet.gravity}-g s{row.planet.sizeClass}</td>
        <td data-testid="pop-{row.id}" title="projected growth next turn: {growthLabel(row.growthK)}">
          {row.popUnits}/{row.maxPop}
          {#if !row.outpost}
            <span class="growth" class:neg={row.growthK < 0}>{growthLabel(row.growthK)}</span>
          {/if}
        </td>
        <td>{row.output.moralePct}%</td>
        {#each ['farmers', 'workers', 'scientists'] as const as job (job)}
          <td
            class="jobs"
            class:dropping={dragOver?.colonyId === row.id && dragOver?.job === job}
            ondragover={(e) => {
              if ((drag?.colonyId === row.id || canDropColony(row)) && (job !== 'farmers' || row.farmable)) {
                e.preventDefault();
                dragOver = { colonyId: row.id, job };
              }
            }}
            ondragleave={() => {
              if (dragOver?.colonyId === row.id && dragOver?.job === job) dragOver = null;
            }}
            ondrop={(e) => {
              e.preventDefault();
              onDrop(row, job);
            }}
          >
            <span
              class="citizens"
              role="group"
              data-testid="{job}-{row.id}"
              data-count={row.jobs[job]}
              title="{row.jobs[job]} {job} — click a citizen to grab them plus everyone to their right, then drag onto another job or any other colony (freighters carry them between systems)"
            >
              {#if job === 'farmers' && !row.farmable}
                <span class="zero" title="nothing grows here — farming is impossible on this world">🚫</span>
              {:else if row.jobs[job] === 0}
                <span class="zero">0</span>
              {/if}
              {#each row.groups as grp (grp.race)}
                {#each Array(grp[job]) as _, i (i)}
                  <span
                    class="citizen"
                    class:foreign={grp.race !== session().playerId}
                    class:unrest={grp.unrest}
                    class:sel={isPicked(row, job, grp.race, i)}
                    style={i > 0 ? `margin-left:-${overlapPx(row.jobs[job])}px` : ''}
                    draggable="true"
                    role="button"
                    tabindex="-1"
                    title={grp.race !== session().playerId
                      ? `captured ${grp.raceName} colonist${grp.unrest ? ' — in unrest (−25% output until assimilated)' : ''}`
                      : grp.unrest
                        ? 'in unrest (−25% output until assimilated)'
                        : ''}
                    onclick={() => pickFrom(row, job, grp.race, i)}
                    onkeydown={(e) => e.key === 'Enter' && pickFrom(row, job, grp.race, i)}
                    ondragstart={(e) => onDragStart(row, job, grp.race, i, e)}
                  >{JOB_ICONS[job]}</span>
                {/each}
              {/each}
            </span>
          </td>
        {/each}
        <td class:neg={row.output.foodNet < 0} data-testid="foodnet-{row.id}" title={ex.farm}>{row.output.foodNet >= 0 ? '+' : ''}{row.output.foodNet}</td>
        <td data-testid="prod-{row.id}" title={ex.prod}>
          {row.output.prodToQueue || row.output.prod}{#if row.output.pollution > 0}<span class="poll">−{row.output.pollution}☁</span>{/if}
        </td>
        <td title={ex.sci}>{row.output.research}</td>
        <td title={ex.bc}>{row.output.bcIncome}</td>
        <td class:neg={row.output.pollution > 0} title="production lost to pollution">{row.output.pollution}</td>
        <td>
          <select
            data-testid="build-{row.id}"
            value={row.activeItem ?? ''}
            onchange={(e) => setBuild(row, (e.target as HTMLSelectElement).value)}
          >
            <option value="" disabled>— build —</option>
            {#if row.activeItem && !row.buildable.includes(row.activeItem)}
              <option value={row.activeItem}>{label(row.activeItem)}</option>
            {/if}
            <!-- keyed by index: the same non-buildable item can legitimately
                 appear twice (repeat refits, spy past the roster cap) and a
                 duplicate string key crashes the whole table -->
            {#each row.queue.slice(1).filter((q) => !row.buildable.includes(q)) as q, qi (qi)}
              <option value={q}>{label(q)} (queued)</option>
            {/each}
            {#each row.buildable as item (item)}
              <option value={item}>{label(item)}</option>
            {/each}
          </select>
        </td>
        <td data-testid="progress-{row.id}">
          {#if row.activeItem === 'housing' || row.activeItem === 'trade_goods'}
            ∞
          {:else if row.activeItem}
            <span class="cellbar" title="{row.storedProd}/{row.activeCost}">
              <span class="cellfill" style="width:{row.activeCost > 0 ? Math.min(100, Math.floor((row.storedProd * 100) / row.activeCost)) : 0}%"></span>
            </span>
            {row.storedProd}/{row.activeCost}{row.turnsLeft !== null ? ` (${row.turnsLeft}t)` : ''}
          {:else}
            idle
          {/if}
          {#if stickyMode && parked(row)}
            <span class="parked" title="sticky build: production parked on switched-away items" data-testid="parked-{row.id}">⏸ {parked(row)}</span>
          {/if}
        </td>
        <td>
          {#if row.buyPrice !== null}
            <button data-testid="buy-{row.id}" disabled={!row.canBuy} onclick={() => buy(row)}>
              {row.buyPrice} BC
            </button>
          {/if}
        </td>
        <td>
          {#each row.queue.slice(1) as q, qi (qi)}
            <button
              class="queuechip"
              data-testid="queued-{row.id}-{qi + 1}"
              title="{label(q)} — click ✕ to remove, or pick it in the build column to build it now"
              onclick={() => removeQueued(row, qi + 1)}
            >{label(q)} ✕</button>
          {/each}
          <select data-testid="queue-add-{row.id}" value="" onchange={(e) => { appendBuild(row, (e.target as HTMLSelectElement).value); (e.target as HTMLSelectElement).value = ''; }}>
            <option value="">+ queue</option>
            {#each row.buildable as item (item)}
              <option value={item}>{label(item)}</option>
            {/each}
          </select>
        </td>
        <td>
          {#if row.buildings.length}
            <button class="mini" data-testid="buildings-{row.id}" onclick={() => toggleBuildings(row.id)}>
              🏛{row.buildings.length}
            </button>
          {/if}
        </td>
      </tr>
      {#if openBuildings.has(row.id)}
        <tr class="buildingsrow" data-testid="buildings-panel-{row.id}">
          <td colspan="18">
            <div class="chips">
              {#each row.sellables as s (s.id)}
                <span class="chip">
                  {pretty(s.id)}
                  <button
                    class="mini sellbtn"
                    disabled={!row.canSell || s.refund <= 0}
                    title={row.canSell ? `sell for ${s.refund} BC (one sale per colony per turn)` : 'already sold a building here this turn'}
                    data-testid="sell-{row.id}-{s.id}"
                    onclick={() => sell(row, s.id)}
                  >sell {s.refund} BC</button>
                </span>
              {/each}
              {#if !row.canSell}
                <span class="dim">one sale per colony per turn — done for this turn</span>
              {/if}
            </div>
          </td>
        </tr>
      {/if}
    {/each}
  </tbody>
  <tfoot>
    <tr data-testid="totals">
      <td></td>
      <td class="name">Σ {allRows.length} colonies{outpostCount > 0 ? ` · ${outpostCount} outpost${outpostCount > 1 ? 's' : ''} (map)` : ''}</td>
      <td></td>
      <td>{totals.pop} <span class="growth" class:neg={totals.growthK < 0}>{growthLabel(totals.growthK)}</span></td>
      <td></td>
      <td colspan="3"></td>
      <td class:neg={totals.food < 0}>{totals.food >= 0 ? '+' : ''}{totals.food}</td>
      <td>{totals.prod}</td>
      <td>{totals.sci}</td>
      <td>{totals.bc}</td>
      <td class:neg={totals.pollution > 0}>{totals.pollution}</td>
      <td colspan="5"></td>
    </tr>
  </tfoot>
</table>

<style>
  .bar {
    display: flex;
    gap: 0.6rem;
    align-items: center;
    margin-bottom: 0.4rem;
    flex-wrap: wrap;
  }
  .presets {
    display: inline-flex;
    gap: 0.25rem;
    align-items: center;
  }
  .presets button {
    font-size: 0.78rem;
  }
  table {
    border-collapse: collapse;
    width: 100%;
    font-size: 0.85rem;
  }
  td,
  th {
    border: 1px solid var(--line);
    padding: 0.25rem 0.45rem;
    text-align: left;
    white-space: nowrap;
  }
  th.sortable {
    cursor: pointer;
    user-select: none;
  }
  tfoot td {
    background: var(--panel-2);
    font-weight: 600;
  }
  .jobs {
    white-space: nowrap;
  }
  .jobs.dropping {
    background: rgba(94, 224, 138, 0.18);
    outline: 1px dashed var(--good);
  }
  .citizens {
    display: inline-flex;
    align-items: center;
    gap: 0;
    min-width: 1.3rem;
    justify-content: center;
  }
  .citizen {
    cursor: grab;
    font-size: 0.85rem;
    line-height: 1;
    position: relative;
  }
  .citizen:hover {
    transform: scale(1.25);
    z-index: 2;
  }
  .citizen.sel {
    filter: drop-shadow(0 0 3px var(--accent)) brightness(1.3);
    z-index: 1;
  }
  /* captured colonists of another race: violet ring so they stand apart */
  .citizen.foreign {
    filter: drop-shadow(0 0 2px #c084fc) hue-rotate(45deg);
  }
  .citizen.foreign.sel {
    filter: drop-shadow(0 0 3px var(--accent)) hue-rotate(45deg) brightness(1.3);
  }
  .citizen.unrest {
    filter: drop-shadow(0 0 3px var(--bad)) grayscale(0.5);
  }
  .zero {
    color: var(--text-dim);
    opacity: 0.5;
    padding: 0 0.2rem;
  }
  .name.shipok {
    background: rgba(110, 168, 255, 0.16);
    outline: 1px dashed var(--accent);
  }
  .queuechip {
    font-size: 0.72rem;
    padding: 0 0.3rem;
    margin-right: 0.15rem;
    background: var(--panel-3);
    border: 1px solid var(--line);
    border-radius: 8px;
    opacity: 0.85;
  }
  .queuechip:hover {
    border-color: var(--bad);
  }
  .movenote {
    font-size: 0.8rem;
    color: var(--accent-soft);
  }
  .mini {
    padding: 0 0.35rem;
    margin: 0 0.1rem;
  }
  .neg {
    color: var(--bad);
  }
  .growth {
    font-size: 0.75rem;
    color: var(--good);
    margin-left: 0.2rem;
  }
  .growth.neg {
    color: var(--bad);
  }
  .poll {
    font-size: 0.72rem;
    color: var(--bad);
    margin-left: 0.25rem;
    opacity: 0.9;
  }
  .cellbar {
    display: inline-block;
    vertical-align: middle;
    width: 3.2rem;
    height: 0.4rem;
    background: var(--panel);
    border: 1px solid var(--line);
    border-radius: 3px;
    overflow: hidden;
    margin-right: 0.3rem;
  }
  .cellfill {
    display: block;
    height: 100%;
    background: linear-gradient(90deg, #24418a, var(--accent));
  }
  .dim {
    opacity: 0.65;
  }
  /* planet specs: tiny and cut off — hover for the full description */
  td.planet {
    font-size: 0.58rem;
    max-width: 5.5rem;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .parked {
    display: block;
    color: var(--gold);
    font-size: 0.75rem;
  }
  .name {
    font-weight: 600;
  }
  .name .ghost {
    opacity: 0;
    border: none;
    background: transparent;
  }
  .leader {
    color: #8b93a7;
    font-weight: 400;
    font-size: 0.72rem;
    margin-left: 0.3rem;
  }
  .name:hover .ghost {
    opacity: 0.7;
  }
  .rename {
    width: 8rem;
  }
  .tagsline {
    display: inline-flex;
    gap: 0.2rem;
    margin-left: 0.3rem;
    align-items: center;
  }
  .tag {
    font-size: 0.68rem;
    padding: 0 0.3rem;
    background: var(--panel-3);
    border: 1px solid var(--line);
    border-radius: 8px;
    color: var(--accent-soft);
  }
  .tagadd {
    font-size: 0.6rem;
    max-width: 1.5rem;
    padding: 0 0.1rem;
    border: none;
    background: transparent;
    opacity: 0.4;
  }
  .tagadd:hover {
    opacity: 1;
  }
  .dimoff {
    opacity: 0.35;
  }
  .outpost {
    opacity: 0.6;
  }
  select {
    max-width: 11rem;
  }
  .buildingsrow td {
    background: var(--panel);
  }
  .chips {
    display: flex;
    gap: 0.5rem;
    flex-wrap: wrap;
    align-items: center;
  }
  .chip {
    background: var(--panel-3);
    border: 1px solid var(--line);
    border-radius: 6px;
    padding: 0.15rem 0.45rem;
    text-transform: capitalize;
  }
  .sellbtn {
    margin-left: 0.35rem;
    font-size: 0.75rem;
  }
</style>
