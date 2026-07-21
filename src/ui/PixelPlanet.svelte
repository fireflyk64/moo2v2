<script lang="ts">
  // Pixel-art world sprite (bugs.md reskin: "pixelated iconic worlds" instead
  // of bare "desert rich high-g s4" text). Deterministic per seed — the same
  // planet always renders the same sprite. Drawn once on a tiny canvas and
  // scaled up with image-rendering: pixelated for the retro look.
  const G = 14; // sprite grid — small enough to stay chunky at any scale

  interface Props {
    /** planet id (or any stable number) — picks the deterministic variant */
    seed: number;
    climate?: string;
    /** 'planet' | 'gas_giant' | 'asteroids' — non-planets get their own art */
    body?: string;
    /** CSS display size in px */
    size?: number;
    /** optional ring hint (rich/poor minerals): a colored square outline */
    ring?: string | null;
    ringDashed?: boolean;
  }
  let { seed, climate = 'barren', body = 'planet', size = 24, ring = null, ringDashed = false }: Props = $props();

  // chunkier-than-CSS palette per climate: [water/base, land/detail, light, dark]
  const PAL: Record<string, [string, string, string, string]> = {
    gaia: ['#2c8fd0', '#4fd06a', '#a8f0b8', '#1a5a38'],
    terran: ['#2c6cc0', '#5cb455', '#b8e8a8', '#274a7a'],
    ocean: ['#1f6ad0', '#3f9ae8', '#a8d8ff', '#123a78'],
    swamp: ['#4a6a3a', '#7aa85a', '#c0d890', '#2c4020'],
    arid: ['#c09a50', '#d8bb6a', '#f0e0a0', '#7a5c28'],
    desert: ['#c08040', '#e0a35e', '#f8d8a0', '#7a4a20'],
    tundra: ['#88a8c0', '#bcd7e8', '#f0f8ff', '#4a6a88'],
    barren: ['#6f6a62', '#8f8a80', '#c0bab0', '#3f3b35'],
    energized: ['#8a50c0', '#c78bff', '#e8d0ff', '#4a2878'],
    hostile: ['#b04030', '#ff6b5e', '#ffb0a0', '#601810'],
  };
  const GAS: [string, string, string, string] = ['#b08850', '#e8c894', '#f8e8c0', '#6e5432'];

  // deterministic PRNG — no Math.random, sprites must not shimmer on rerender
  function mulberry32(a: number) {
    return () => {
      a |= 0;
      a = (a + 0x6d2b79f5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  function draw(cv: HTMLCanvasElement) {
    const ctx = cv.getContext('2d');
    if (!ctx) return;
    ctx.clearRect(0, 0, G, G);
    const rnd = mulberry32((seed | 0) * 2654435761 + 7);
    const pal = body === 'gas_giant' ? GAS : (PAL[climate] ?? PAL.barren!);
    const [base, detail, light, dark] = pal;
    const c = (G - 1) / 2;
    const r = c + 0.2;

    if (body === 'asteroids') {
      // a loose scatter of gray chunks, no disc
      for (let i = 0; i < 14; i++) {
        const x = 1 + Math.floor(rnd() * (G - 2));
        const y = 1 + Math.floor(rnd() * (G - 2));
        ctx.fillStyle = rnd() < 0.3 ? '#c0bab0' : rnd() < 0.6 ? '#8f8a80' : '#5d5a52';
        ctx.fillRect(x, y, 1, 1);
        if (rnd() < 0.35) ctx.fillRect(x + 1, y, 1, 1);
      }
      return;
    }

    const inside = (x: number, y: number) => (x - c) ** 2 + (y - c) ** 2 <= r * r;
    const banded = body === 'gas_giant' || climate === 'arid' || climate === 'desert' || climate === 'energized';
    const cratered = climate === 'barren' || climate === 'hostile' || climate === 'tundra';
    const capped = climate === 'gaia' || climate === 'terran' || climate === 'tundra';

    // land/cloud blob seeds grown one step in each direction
    const blob = new Set<number>();
    if (!banded) {
      const n = 4 + Math.floor(rnd() * 3);
      for (let i = 0; i < n; i++) {
        let x = 2 + Math.floor(rnd() * (G - 4));
        let y = 2 + Math.floor(rnd() * (G - 4));
        for (let s = 0; s < 5 + rnd() * 5; s++) {
          blob.add(y * G + x);
          x = Math.min(G - 2, Math.max(1, x + Math.floor(rnd() * 3) - 1));
          y = Math.min(G - 2, Math.max(1, y + Math.floor(rnd() * 3) - 1));
        }
      }
    }
    const bandShift = Math.floor(rnd() * 3);

    for (let y = 0; y < G; y++) {
      for (let x = 0; x < G; x++) {
        if (!inside(x, y)) continue;
        let col = base;
        if (banded) {
          const band = (y + bandShift) % 4;
          col = band === 0 ? detail : band === 2 && rnd() < 0.7 ? dark : base;
          if (rnd() < 0.08) col = light; // storm flecks
        } else if (blob.has(y * G + x)) {
          col = detail;
        } else if (cratered && rnd() < 0.07) {
          col = dark;
        }
        if (capped && (y <= 1 || y >= G - 2)) col = light; // polar ice
        // lighting: sun from the top-left, hard pixel terminator bottom-right
        const d = ((x - c) * 0.7 + (y - c) * 0.7) / r;
        if (d > 0.55) col = dark;
        else if (d < -0.75 && rnd() < 0.8) col = light;
        ctx.fillStyle = col;
        ctx.fillRect(x, y, 1, 1);
      }
    }
  }

  let canvas = $state<HTMLCanvasElement | null>(null);
  $effect(() => {
    void seed;
    void climate;
    void body;
    if (canvas) draw(canvas);
  });
</script>

<canvas
  bind:this={canvas}
  width={G}
  height={G}
  class="pixel-planet"
  style:width="{size}px"
  style:height="{size}px"
  style:outline={ring ? `1px ${ringDashed ? 'dashed' : 'solid'} ${ring}` : 'none'}
  style:outline-offset="1px"
  aria-hidden="true"
></canvas>

<style>
  .pixel-planet {
    image-rendering: pixelated;
    display: inline-block;
    vertical-align: middle;
    flex: none;
  }
</style>
