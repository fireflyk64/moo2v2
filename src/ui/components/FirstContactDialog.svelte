<script lang="ts">
  // First contact with a civilization mid-game: their envoy appears and the
  // diplomacy channel opens. (The fast-start CONTACT overlay handles the very
  // first any-pair meeting; this covers every later first meeting, which
  // previously passed with no fanfare at all.)
  import { app, getActive } from '../state.svelte';
  import { playerColor } from '../colors';
  import DiplomatPortrait from './DiplomatPortrait.svelte';

  interface Props {
    empireId: number;
    onclose: () => void;
    ondiplomacy: () => void;
  }
  let { empireId, onclose, ondiplomacy }: Props = $props();

  const gs = $derived.by(() => {
    void app.version;
    return getActive()!.session.getPlanned();
  });
  const emp = $derived(gs?.empires.find((e) => e.id === empireId) ?? null);
</script>

<div class="fc-overlay" role="alertdialog" aria-label="first contact" data-testid="first-contact">
  {#if gs && emp}
    <div class="fc-box">
      <div class="fc-title">FIRST CONTACT</div>
      <div class="fc-envoy">
        <DiplomatPortrait seed={`${gs.seed}/${emp.raceName}/${emp.id}`} colorHex={playerColor(emp.id)} size={110} />
        <b style:color={playerColor(emp.id)}>{emp.name}</b>
        <span class="fc-race">{emp.raceName}</span>
      </div>
      <p class="fc-sub">An envoy of the {emp.raceName} requests an audience. First impressions go a long way.</p>
      <div class="fc-actions">
        <button class="primary" data-testid="first-contact-diplomacy" onclick={ondiplomacy}>🤝 Open diplomacy</button>
        <button data-testid="first-contact-continue" onclick={onclose}>Continue ▶</button>
      </div>
    </div>
  {/if}
</div>

<style>
  .fc-overlay {
    position: fixed;
    inset: 0;
    z-index: 59;
    background: rgba(2, 4, 10, 0.82);
    display: grid;
    place-items: center;
    padding: 1rem;
    animation: fc-flash 0.9s ease;
  }
  @keyframes fc-flash {
    0% { background: rgba(255, 230, 160, 0.55); }
    100% { background: rgba(2, 4, 10, 0.82); }
  }
  .fc-box {
    max-width: 26rem;
    background: linear-gradient(180deg, var(--panel-3), var(--panel));
    border: 2px solid var(--gold);
    border-radius: 14px;
    padding: 1.2rem 1.6rem;
    text-align: center;
    box-shadow: 0 0 80px color-mix(in srgb, var(--gold) 30%, transparent);
  }
  .fc-title {
    font-size: 1.6rem;
    font-weight: 900;
    letter-spacing: 0.3em;
    color: var(--gold);
    text-shadow: 0 0 20px color-mix(in srgb, var(--gold) 70%, transparent);
  }
  .fc-envoy {
    display: grid;
    justify-items: center;
    gap: 0.15rem;
    margin: 0.6rem 0 0.2rem;
    animation: fc-in 0.7s ease-out backwards;
    animation-delay: 0.3s;
  }
  @keyframes fc-in {
    from { opacity: 0; transform: translateY(8px); filter: brightness(2.5); }
    to { opacity: 1; transform: none; filter: none; }
  }
  .fc-race {
    font-size: 0.75rem;
    color: var(--text-dim);
  }
  .fc-sub {
    color: var(--text-dim);
    font-size: 0.9rem;
  }
  .fc-actions {
    display: flex;
    gap: 0.6rem;
    justify-content: center;
    margin-top: 0.6rem;
  }
  .fc-actions .primary {
    border-color: var(--gold);
    font-weight: 700;
  }
</style>
