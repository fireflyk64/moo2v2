<script lang="ts">
  import { appPickableBy, selectors, traitsOf } from '@engine/index';
  import { applicationsOfField, applicationById, fieldByNum, fieldById } from '@engine/data/index';
  import { EFFECTS, EFFECT_ALIASES } from '@engine/data/effectsMap';
  import { app, getActive } from '../state.svelte';

  const session = () => getActive()!.session;
  const gs = $derived.by(() => {
    void app.version;
    return session().getPlanned();
  });
  const summary = $derived.by(() =>
    gs ? selectors.empireSummary(gs, session().playerId) : null,
  );
  const choices = $derived.by(() =>
    gs ? selectors.researchChoices(gs, session().playerId) : [],
  );
  const empire = $derived(gs?.empires.find((e) => e.id === session().playerId) ?? null);
  const idle = $derived(!!empire && empire.research.fieldNum === null && empire.research.extraQueue.length === 0);
  const currentPct = $derived.by(() => {
    if (!empire || empire.research.fieldNum === null) return 0;
    const choice = choices.find((c) => c.field.num === empire.research.fieldNum);
    if (!choice || choice.cost <= 0) return 0;
    return Math.min(100, Math.floor((empire.research.accumRP * 100) / choice.cost));
  });

  const bySubject = $derived.by(() => {
    const map = new Map<string, typeof choices>();
    for (const c of choices) {
      const list = map.get(c.subject) ?? [];
      list.push(c);
      map.set(c.subject, list);
    }
    return [...map.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  });

  /** research category emojis (bugs.md) */
  const SUBJECT_EMOJI: Record<string, string> = {
    construction: '🏗️',
    power: '⚡',
    chemistry: '🧪',
    sociology: '🏛️',
    computers: '💻',
    ecology: '🌿',
    physics: '⚛️',
    force_fields: '🛡️',
  };

  let pendingTarget = $state<Record<number, string>>({});

  let researchNote = $state('');
  let researchNoteTimer: ReturnType<typeof setTimeout> | null = null;
  function start(fieldNum: number, target: string | null) {
    const res = session().submit('set_research', { fieldNum, targetApp: target });
    if (res.error) {
      // a silently rejected pick leaves the UI face desynced from the engine
      researchNote = `⛔ ${res.error}`;
      if (researchNoteTimer) clearTimeout(researchNoteTimer);
      researchNoteTimer = setTimeout(() => (researchNote = ''), 6000);
    }
  }

  const pretty = (id: string) => id.replaceAll('_', ' ');

  /** hover text for an application: its effect summary, with an honest
   * "(not implemented yet)" tag for tracked stubs and a fallback for the few
   * source rows whose summary is empty — a blank tooltip reads as a bug */
  function appTitle(appId: string): string {
    const summary = applicationById.get(appId)?.effectSummary || pretty(appId);
    const spec = EFFECTS[EFFECT_ALIASES[appId] ?? appId];
    return spec?.stub ? `${summary}\n⚠ not implemented yet: ${spec.stub}` : summary;
  }

  // buy skipped applications from completed fields, one at a time:
  // creative races under creative-variant mode, or any race with the
  // out_of_box_thinking pick under its game option
  const creativeVariant = $derived(gs?.settings.modes.creativeVariant === true && !!empire && traitsOf(empire).creative);
  const outOfBoxThinking = $derived(gs?.settings.modes.outOfBoxThinking === true && !!empire && traitsOf(empire).outOfBoxThinking);
  const canBuyExtra = $derived(creativeVariant || outOfBoxThinking);
  const purchasable = $derived.by(() => {
    if (!canBuyExtra || !empire || !gs) return [];
    const out: Array<{ id: string; name: string; fieldId: string; cost: number }> = [];
    for (const num of empire.completedFields) {
      const field = fieldByNum.get(num);
      if (!field) continue;
      for (const a of applicationsOfField(field.id)) {
        if (empire.knownApps.includes(a.id) || empire.research.extraQueue.includes(a.id)) continue;
        if (!appPickableBy(empire, a.id)) continue; // dead pick (Unification)
        out.push({ id: a.id, name: a.name, fieldId: field.id, cost: fieldById.get(field.id)?.cost ?? 0 });
      }
    }
    return out.sort((x, y) => x.cost - y.cost || x.id.localeCompare(y.id));
  });
  function queueExtra(appId: string, remove = false) {
    session().submit('queue_extra_research', { appId, remove });
  }
</script>

{#if empire && summary}
  {#if researchNote}
    <div class="idlebanner" data-testid="research-note">{researchNote}</div>
  {/if}
  {#if idle}
    <div class="idlebanner" data-testid="research-idle">
      ⚠ Your labs are idle! Pick a field below — research points are banking up unspent
      ({empire.research.accumRP} RP banked, +{summary.researchPerTurn}/turn).
    </div>
  {/if}
  <p data-testid="research-status" class="status">
    Current: <b>{summary.researching ? pretty(summary.researching) : 'none'}</b>
    {#if empire.research.fieldNum !== null}
      — {empire.research.accumRP}/{summary.researchListedCost} RP, +{summary.researchPerTurn}/turn
      {#if summary.researchTarget}(target: {pretty(summary.researchTarget)}){/if}
      {#if summary.researchOddsPct > 0}
        <b data-testid="research-odds" title="The real discovery point is hidden somewhere between the listed cost and twice the listed cost — the same for every empire this game. This is the chance your accumulated research reaches it by the beginning of next turn.">({summary.researchOddsPct}% chance to discover)</b>
      {:else if summary.researchTurnsLeft !== null}
        <span class="dim" title="estimate to the expected discovery point (~1.5× the listed cost — the real point is hidden)">~{summary.researchTurnsLeft} turns</span>
      {/if}
      <span class="pbar"><span class="pfill" style="width:{currentPct}%"></span></span>
    {:else if empire.research.accumRP > 0}
      — {empire.research.accumRP} RP banked
    {/if}
  </p>

  {#if canBuyExtra}
    <div class="field" data-testid="creative-variant">
      <b>{creativeVariant ? 'Creative applications' : 'Out-of-the-Box Thinking'}</b>
      <p class="dim">
        Buy skipped applications from completed fields — each costs the full field price, one per turn.
        {#if empire.research.extraQueue.length}
          Queue: {empire.research.extraQueue.join(' → ')} ({empire.research.extraAccumRP} RP toward the first)
        {/if}
      </p>
      {#each empire.research.extraQueue as q (q)}
        <button class="mini" onclick={() => queueExtra(q, true)}>✕ {q}</button>
      {/each}
      <select
        data-testid="extra-research"
        value=""
        onchange={(e) => {
          const v = (e.target as HTMLSelectElement).value;
          if (v) queueExtra(v);
          (e.target as HTMLSelectElement).value = '';
        }}
      >
        <option value="">+ buy application…</option>
        {#each purchasable as p (p.id)}
          <option value={p.id}>{p.name} ({p.cost} RP, {pretty(p.fieldId)})</option>
        {/each}
      </select>
    </div>
  {/if}

  <div class="subjects">
    {#each bySubject as [subject, fields] (subject)}
      <div class="subject">
        <h3>{SUBJECT_EMOJI[subject] ?? '🔬'} {subject.replace('_', ' ')}</h3>
        {#each fields as choice (choice.field.num)}
          {@const isCurrent = empire.research.fieldNum === choice.field.num}
          <div class="field" class:current={isCurrent}>
            <div class="head">
              <b>{pretty(choice.field.id)}</b>
              <span
                class="dim"
                title={choice.cost > choice.field.cost
                  ? `base ${choice.field.cost} RP + hyper-advanced level surcharge`
                  : 'Discovery lands somewhere between this cost and twice it — the same hidden point for every empire this game.'}
              >{choice.cost} RP{choice.cost > choice.field.cost ? ' ▲' : ''}</span>
            </div>
            {#if choice.grantsAll}
              <p class="all" title="Basic fields deliver every application at once">✦ researches all applications</p>
              <ul class="applist">
                {#each choice.apps as appRow (appRow.id)}
                  <li class:known={appRow.known} title={appTitle(appRow.id)}>{appRow.name}{appRow.known ? ' ✓' : ''}</li>
                {/each}
              </ul>
            {:else}
              <!-- dead picks (morale tech under Unification) stay off the list -->
              {#each choice.apps.filter((a) => !a.dead) as appRow (appRow.id)}
                <label class:known={appRow.known} title={appTitle(appRow.id)}>
                  <input
                    type="radio"
                    name="target-{choice.field.num}"
                    disabled={appRow.known}
                    checked={pendingTarget[choice.field.num] === appRow.id ||
                      (isCurrent && empire.research.targetApp === appRow.id)}
                    onchange={() => (pendingTarget = { ...pendingTarget, [choice.field.num]: appRow.id })}
                  />
                  {appRow.name}{appRow.known ? ' ✓' : ''}
                </label>
              {/each}
            {/if}
            {#if isCurrent}
              <div class="fieldbar"><div class="fieldfill" style="width:{currentPct}%"></div></div>
            {/if}
            <button
              data-testid="research-{choice.field.id}"
              class:primary={!isCurrent}
              onclick={() =>
                start(
                  choice.field.num,
                  choice.grantsAll
                    ? null
                    : (pendingTarget[choice.field.num] ??
                      (choice.apps.find((a) => !a.known && !a.dead) ?? choice.apps.find((a) => !a.known))?.id ??
                      null),
                )}
            >
              {isCurrent ? (choice.grantsAll ? 'Researching…' : 'Change target') : 'Research this'}
            </button>
          </div>
        {/each}
      </div>
    {/each}
  </div>
{/if}

<style>
  .idlebanner {
    background: linear-gradient(180deg, #6a5424, #54431c);
    border: 1px solid var(--gold);
    color: #ffe9b8;
    border-radius: 8px;
    padding: 0.5rem 0.9rem;
    margin-bottom: 0.6rem;
    font-weight: 600;
    animation: idlepulse 1.8s ease-in-out infinite;
  }
  @keyframes idlepulse {
    0%, 100% { box-shadow: 0 0 0 rgba(255, 212, 121, 0); }
    50% { box-shadow: 0 0 16px rgba(255, 212, 121, 0.4); }
  }
  .status {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    flex-wrap: wrap;
  }
  .pbar {
    display: inline-block;
    width: 10rem;
    height: 0.5rem;
    background: var(--panel);
    border: 1px solid var(--line);
    border-radius: 4px;
    overflow: hidden;
  }
  .pfill,
  .fieldfill {
    display: block;
    height: 100%;
    background: linear-gradient(90deg, #2c7a4e, var(--good));
    transition: width 0.4s ease;
  }
  .subjects {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(17rem, 1fr));
    gap: 0.8rem;
  }
  .subject h3 {
    margin: 0.2rem 0;
    text-transform: capitalize;
    color: var(--accent-soft);
  }
  .field {
    border: 1px solid var(--line);
    background: linear-gradient(180deg, rgba(21, 29, 63, 0.6), rgba(15, 21, 48, 0.6));
    padding: 0.5rem 0.7rem;
    margin-bottom: 0.5rem;
    border-radius: 8px;
    transition: border-color 0.15s, box-shadow 0.15s;
  }
  .field:hover {
    border-color: var(--line-bright);
  }
  .field.current {
    border-color: var(--good);
    box-shadow: 0 0 14px rgba(94, 224, 138, 0.18);
  }
  .fieldbar {
    height: 0.35rem;
    background: var(--panel);
    border-radius: 3px;
    overflow: hidden;
    margin: 0.35rem 0 0.1rem;
  }
  .head {
    display: flex;
    justify-content: space-between;
  }
  .head b {
    text-transform: capitalize;
  }
  .all {
    color: var(--gold);
    font-size: 0.8rem;
    margin: 0.25rem 0 0.1rem;
    font-weight: 600;
  }
  .applist {
    margin: 0.15rem 0 0.3rem;
    padding-left: 1.1rem;
    font-size: 0.85rem;
  }
  .applist li.known {
    opacity: 0.5;
  }
  label {
    display: block;
    font-size: 0.85rem;
    margin: 0.15rem 0;
  }
  label.known {
    opacity: 0.5;
  }
  .dim {
    opacity: 0.65;
  }
  button {
    margin-top: 0.3rem;
  }
  button.primary {
    background: linear-gradient(180deg, #24418a, #1b2f66);
    border-color: #4a6ab8;
  }
</style>
