import { describe, expect, it } from 'vitest';
import { LEADERS } from '@engine/data/leaders';
import { rngFor } from '@engine/rng';
import { leaderDisplayName, spacify, styledLeaderRoster } from '@ui/leaderNames';

const SEED_A = '0123456789abcdef0123456789abcdef';
const SEED_B = 'fedcba9876543210fedcba9876543210';

describe('stylized leader names', () => {
  it('derives the same roster for the same seed on every call (peer agreement)', () => {
    const r1 = styledLeaderRoster(SEED_A);
    const r2 = styledLeaderRoster(SEED_A);
    for (const row of LEADERS) {
      expect(r2.get(row.id)!.full).toBe(r1.get(row.id)!.full);
    }
  });

  it('covers every leader and keeps person names unique within a game', () => {
    for (const seed of [SEED_A, SEED_B]) {
      const roster = styledLeaderRoster(seed);
      expect(roster.size).toBe(LEADERS.length);
      const persons = new Set([...roster.values()].map((n) => n.person));
      expect(persons.size).toBe(LEADERS.length);
    }
  });

  it('differs between seeds', () => {
    const a = styledLeaderRoster(SEED_A);
    const b = styledLeaderRoster(SEED_B);
    let differing = 0;
    for (const row of LEADERS) {
      if (a.get(row.id)!.full !== b.get(row.id)!.full) differing++;
    }
    expect(differing).toBeGreaterThan(LEADERS.length / 2);
  });

  it('preserves the rank prefix (rank encodes colony/ship kind)', () => {
    const roster = styledLeaderRoster(SEED_A);
    for (const row of LEADERS) {
      const rank = row.name.split(' ').slice(0, -1).join(' ');
      if (rank) expect(roster.get(row.id)!.full.startsWith(rank + ' ')).toBe(true);
    }
  });

  it('spacify always changes its input', () => {
    const rng = rngFor(SEED_A, 'spacify-test');
    const bases = ['Leland', 'Stanford', 'Montague', 'Strobridge', 'Judah', 'Watson', 'Ames', 'Ash'];
    for (const base of bases) {
      for (let i = 0; i < 50; i++) {
        const out = spacify(base, rng);
        expect(out).not.toBe(base);
        expect(out.length).toBeGreaterThan(2);
        expect(out[0]).toBe(out[0]!.toUpperCase());
      }
    }
  });

  it('falls back to the table name without a valid seed', () => {
    expect(leaderDisplayName(null, 'megatron', 'Commissioner Megatron')).toBe('Commissioner Megatron');
    expect(leaderDisplayName('not-a-seed', 'megatron', 'Commissioner Megatron')).toBe('Commissioner Megatron');
  });

  it('prints a sample roster (eyeball check)', () => {
    const roster = styledLeaderRoster(SEED_A);
    const sample = LEADERS.slice(0, 12).map((row) => `${row.id}: ${roster.get(row.id)!.full}`);
    // eslint-disable-next-line no-console
    console.log(sample.join('\n'));
    expect(sample.length).toBe(12);
  });
});
