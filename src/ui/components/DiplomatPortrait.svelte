<script lang="ts">
  // Pixel-art envoy portrait (diplomatart.ts) — the diplomatic twin of
  // ShipPreview: deterministic per seed, tinted with the empire color.
  import { renderDiplomatToCanvas } from '../diplomatart';

  interface Props {
    /** stable string — same seed, same face (e.g. `${gameSeed}/${raceName}/${empireId}`) */
    seed: string;
    colorHex: string;
    /** CSS display height in px */
    size?: number;
  }
  let { seed, colorHex, size = 90 }: Props = $props();

  let host = $state<HTMLDivElement | null>(null);
  $effect(() => {
    if (!host) return;
    const px = Math.max(1, Math.ceil(size / 30));
    const canvas = renderDiplomatToCanvas(seed, colorHex, px);
    canvas.style.width = `${Math.round((size * 26) / 30)}px`;
    canvas.style.height = `${size}px`;
    canvas.style.imageRendering = 'pixelated';
    host.replaceChildren(canvas);
  });
</script>

<div bind:this={host} class="portrait-host" style:height="{size}px" aria-hidden="true"></div>

<style>
  .portrait-host {
    display: inline-flex;
    align-items: flex-end;
    justify-content: center;
    flex: none;
  }
</style>
