import { describe, expect, it } from 'vitest';
import { diplomatModel, diplomatPalette } from '@ui/diplomatart';

const SEEDS = ['abc/Veilkin Syndics/2', 'abc/Urgok Clans/3', 'xyz/Veilkin Syndics/2', 'abc/Skyshear Flock/5'];

describe('procedural diplomat portraits', () => {
  it('is deterministic: same seed, same face', () => {
    for (const s of SEEDS) {
      const a = diplomatModel(s);
      const b = diplomatModel(s);
      expect(Buffer.from(a.px).equals(Buffer.from(b.px))).toBe(true);
      expect(diplomatPalette(s, '#ff0000')).toEqual(diplomatPalette(s, '#ff0000'));
    }
  });

  it('differs across seeds', () => {
    const a = diplomatModel(SEEDS[0]!);
    const b = diplomatModel(SEEDS[1]!);
    expect(Buffer.from(a.px).equals(Buffer.from(b.px))).toBe(false);
  });

  it('has a vertically symmetric silhouette and a bust that reaches the frame bottom', () => {
    for (const s of SEEDS) {
      const m = diplomatModel(s);
      for (let y = 0; y < m.h; y++) {
        for (let x = 0; x < m.w; x++) {
          const l = m.px[y * m.w + x]! !== 0;
          const r = m.px[y * m.w + (m.w - 1 - x)]! !== 0;
          expect(l).toBe(r);
        }
      }
      const lastRow = m.px.slice((m.h - 1) * m.w);
      expect(lastRow.some((v) => v !== 0)).toBe(true);
    }
  });

  it('always has at least one glowing eye pixel and only valid roles', () => {
    for (const s of SEEDS) {
      const m = diplomatModel(s);
      expect(m.px.some((v) => v === 4)).toBe(true);
      for (const v of m.px) expect(v).toBeLessThanOrEqual(8);
    }
  });
});
