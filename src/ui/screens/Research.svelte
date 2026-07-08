<script lang="ts">
  import { selectors } from '@engine/index';
  import { app, getActive } from '../state.svelte';

  const session = () => getActive()!.session;
  const state = $derived.by(() => {
    void app.version;
    return session().getPlanned();
  });
  const summary = $derived.by(() =>
    state ? selectors.empireSummary(state, session().playerId) : null,
  );
  const choices = $derived.by(() =>
    state ? selectors.researchChoices(state, session().playerId) : [],
  );
  const empire = $derived(state?.empires.find((e) => e.id === session().playerId) ?? null);

  const bySubject = $derived.by(() => {
    const map = new Map<string, typeof choices>();
    for (const c of choices) {
      const list = map.get(c.subject) ?? [];
      list.push(c);
      map.set(c.subject, list);
    }
    return [...map.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  });

  let pendingTarget = $state<Record<number, string>>({});

  function start(fieldNum: number, target: string | null) {
    session().submit('set_research', { fieldNum, targetApp: target });
  }
</script>

{#if empire && summary}
  <p data-testid="research-status">
    Current: <b>{summary.researching ?? 'none'}</b>
    {#if empire.research.fieldNum !== null}
      — {empire.research.accumRP} RP accumulated, +{summary.researchPerTurn}/turn
      {#if summary.researchTarget}(target: {summary.researchTarget}){/if}
    {:else if empire.research.accumRP > 0}
      — {empire.research.accumRP} RP banked
    {/if}
  </p>

  <div class="subjects">
    {#each bySubject as [subject, fields] (subject)}
      <div class="subject">
        <h3>{subject.replace('_', ' ')}</h3>
        {#each fields as choice (choice.field.num)}
          <div class="field" class:current={empire.research.fieldNum === choice.field.num}>
            <div class="head">
              <b>{choice.field.id.replaceAll('_', ' ')}</b>
              <span class="dim">{choice.cost} RP</span>
            </div>
            {#each choice.apps as appRow (appRow.id)}
              <label class:known={appRow.known}>
                <input
                  type="radio"
                  name="target-{choice.field.num}"
                  disabled={appRow.known}
                  checked={pendingTarget[choice.field.num] === appRow.id ||
                    (empire.research.fieldNum === choice.field.num && empire.research.targetApp === appRow.id)}
                  onchange={() => (pendingTarget = { ...pendingTarget, [choice.field.num]: appRow.id })}
                />
                {appRow.name}{appRow.known ? ' ✓' : ''}
              </label>
            {/each}
            <button
              data-testid="research-{choice.field.id}"
              onclick={() =>
                start(choice.field.num, pendingTarget[choice.field.num] ?? choice.apps.find((a) => !a.known)?.id ?? null)}
            >
              {empire.research.fieldNum === choice.field.num ? 'Change target' : 'Research this'}
            </button>
          </div>
        {/each}
      </div>
    {/each}
  </div>
{/if}

<style>
  .subjects {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(17rem, 1fr));
    gap: 0.8rem;
  }
  .subject h3 {
    margin: 0.2rem 0;
    text-transform: capitalize;
    color: #8fb8ff;
  }
  .field {
    border: 1px solid #26304f;
    padding: 0.45rem 0.6rem;
    margin-bottom: 0.5rem;
    border-radius: 6px;
  }
  .field.current {
    border-color: #5ee08a;
  }
  .head {
    display: flex;
    justify-content: space-between;
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
</style>
