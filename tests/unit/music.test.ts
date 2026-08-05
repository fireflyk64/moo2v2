import { describe, expect, it } from 'vitest';
import { buildParts, PART_COUNTS } from '@ui/music';

describe('generative music part pool', () => {
  it('really is hundreds of parts', () => {
    const p = buildParts(1234);
    const total = p.phrases.length + p.pads.length + p.basses.length + p.ornaments.length;
    expect(p.phrases.length).toBe(PART_COUNTS.phrases);
    expect(p.pads.length).toBe(PART_COUNTS.pads);
    expect(p.basses.length).toBe(PART_COUNTS.basses);
    expect(p.ornaments.length).toBe(PART_COUNTS.ornaments);
    expect(total).toBeGreaterThanOrEqual(250);
  });

  it('is deterministic per seed and varies across seeds', () => {
    const a = buildParts(42);
    const b = buildParts(42);
    const c = buildParts(43);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
    expect(JSON.stringify(a)).not.toBe(JSON.stringify(c));
  });

  it('produces well-formed parts (playable durations, 4-chord progressions)', () => {
    const p = buildParts(7);
    for (const ph of p.phrases) {
      expect(ph.steps.length).toBeGreaterThanOrEqual(3);
      for (const s of ph.steps) {
        expect(s.dur).toBeGreaterThan(0);
        expect(s.gap).toBeGreaterThanOrEqual(0);
        expect(Number.isFinite(s.deg)).toBe(true);
      }
    }
    for (const prog of p.pads) {
      expect(prog.length).toBe(4);
      for (const chord of prog) expect(chord.degs.length).toBeGreaterThanOrEqual(3);
    }
    for (const run of p.ornaments) expect(run.every((s) => s.dur > 0)).toBe(true);
  });
});
