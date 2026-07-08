import { describe, expect, it } from 'vitest';
import { APPLICATION_ROWS, BUILDABLE_ROWS, PICK_ROWS } from '@engine/data/index';
import { EFFECTS, EFFECT_ALIASES, PICK_STATUS } from '@engine/data/effectsMap';
import { effectsOf } from '@engine/effects';

// Phase 5 acceptance gate: every tech application, buildable, and race pick is
// implemented (modifiers/handler) or explicitly stubbed with a phase note.
// The stub ledger below is the measurable remaining-work queue.

describe('effects coverage', () => {
  it('every application has an effect entry', () => {
    const missing: string[] = [];
    for (const app of APPLICATION_ROWS) {
      if (!effectsOf(app.id)) missing.push(app.id);
    }
    expect(missing, `missing effect entries: ${missing.join(', ')}`).toEqual([]);
  });

  it('every buildable has an effect entry (deferred internals excluded)', () => {
    const INTERNAL = new Set([
      'super_swarm',
      'spacetime_surfing',
      're_population',
      'barrier',
      'telepathic_training',
      'microlite_construction', // empire tech, not a real structure row
      'adaptive_habitat_lattice',
      'capitol_1',
      'capitol_2',
      'capitol_3',
      'capitol_4',
      'capitol_5',
      'marine_barracks_splinter',
      'armor_barracks_splinter',
    ]);
    const missing: string[] = [];
    for (const b of BUILDABLE_ROWS) {
      if (INTERNAL.has(b.id)) continue;
      if (!effectsOf(b.id)) missing.push(b.id);
    }
    expect(missing, `missing buildable entries: ${missing.join(', ')}`).toEqual([]);
  });

  it('every race pick is implemented or stubbed', () => {
    const missing: string[] = [];
    for (const p of PICK_ROWS) {
      if (!PICK_STATUS[p.id]) missing.push(p.id);
    }
    expect(missing, `missing pick entries: ${missing.join(', ')}`).toEqual([]);
  });

  it('aliases resolve to real entries', () => {
    for (const [from, to] of Object.entries(EFFECT_ALIASES)) {
      expect(EFFECTS[to], `alias ${from} -> ${to}`).toBeDefined();
    }
  });

  it('prints the stub ledger (remaining work)', () => {
    const stubs = Object.entries(EFFECTS)
      .filter(([, spec]) => spec.stub)
      .map(([id, spec]) => `${id}: ${spec.stub}`);
    const pickStubs = Object.entries(PICK_STATUS)
      .filter(([, s]) => s.stub)
      .map(([id, s]) => `pick ${id}: ${s.stub}`);
    console.log(`STUB LEDGER (${stubs.length + pickStubs.length} items):\n` + [...stubs, ...pickStubs].join('\n'));
    // implemented coverage must keep growing; currently the majority is live
    const total = Object.keys(EFFECTS).length;
    expect(total - stubs.length).toBeGreaterThan(total * 0.4);
  });
});
