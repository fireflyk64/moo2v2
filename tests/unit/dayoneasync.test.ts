// Day-one async: race-string tokens round-trip, the sanity checks catch the
// classic mismatches (budget, out-of-box without the mode), and the host's
// generated save verifies and seats everyone correctly.

import { describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS } from '@protocol/messages';
import { verifySaveEnvelope } from '@storage/savefile';
import { buildDayOneAsync } from '@ui/asyncStart';
import { checkRaceString, decodeRaceString, encodeRaceString } from '@ui/raceString';

const SEED = '00112233445566778899aabbccddeeff';

describe('race strings', () => {
  it('round-trips names and race json (unicode included)', () => {
    const payload = { name: 'Ær Ünger 🚀', raceJson: JSON.stringify({ picks: ['industry2', 'dictatorship'], raceName: 'Førge' }) };
    const token = encodeRaceString(payload);
    expect(token.startsWith('moo2race1:')).toBe(true);
    expect(decodeRaceString(`  ${token}  `)).toEqual(payload);
  });

  it('rejects garbage and foreign strings', () => {
    expect(() => decodeRaceString('hello')).toThrow(/not a race string/);
    expect(() => decodeRaceString('moo2race1:!!!!')).toThrow(/corrupted/);
  });

  it('sanity checks: budget overrun, underspend warning, out-of-box gating', () => {
    const custom = (picks: string[]) => ({ name: 'X', raceJson: JSON.stringify({ picks, raceName: 'X' }) });
    // a fat 14-point race in a 10-point game: error
    const fat = checkRaceString(custom(['industry3', 'science3', 'dictatorship']), { pickPoints: 10, outOfBoxThinking: false });
    expect(fat.errors.some((e) => e.includes('exceeds'))).toBe(true);
    // the same race in a 14-point game: fine
    const fit = checkRaceString(custom(['industry3', 'science3', 'dictatorship']), { pickPoints: 14, outOfBoxThinking: false });
    expect(fit.errors).toEqual([]);
    // a thin 10-point race in a 14-point game: warned, not blocked
    const thin = checkRaceString(custom(['industry2', 'science2', 'dictatorship']), { pickPoints: 14, outOfBoxThinking: false });
    expect(thin.errors).toEqual([]);
    expect(thin.warnings.some((w) => w.includes('pick points'))).toBe(true);
    // out_of_box_thinking without the mode: error; with it: allowed
    const oob = ['out_of_box_thinking', 'industry2', 'science1', 'dictatorship'];
    expect(checkRaceString(custom(oob), { pickPoints: 10, outOfBoxThinking: false }).errors.some((e) => e.includes('out_of_box'))).toBe(true);
    expect(checkRaceString(custom(oob), { pickPoints: 10, outOfBoxThinking: true }).errors.some((e) => e.includes('out_of_box'))).toBe(false);
    // presets and unknown picks
    expect(checkRaceString({ name: 'P', raceJson: JSON.stringify({ presetId: 'solari' }) }, { pickPoints: 10, outOfBoxThinking: false }).errors).toEqual([]);
    expect(checkRaceString(custom(['no_such_pick', 'dictatorship']), { pickPoints: 10, outOfBoxThinking: false }).errors.some((e) => e.includes('unknown'))).toBe(true);
  });
});

describe('day-one async save', () => {
  const settings = { ...DEFAULT_SETTINGS, pickPoints: 10, coreWorlds: 'central' as const };

  it('builds a verified, loadable save with everyone seated by name', () => {
    const { envelope, state, warnings } = buildDayOneAsync({
      host: { name: 'Hosta', raceJson: JSON.stringify({ presetId: 'solari' }) },
      guests: [
        { name: 'Guestov', raceJson: JSON.stringify({ picks: ['industry2', 'science1', 'dictatorship'], raceName: 'Forge' }) },
        { name: 'Guestina', raceJson: JSON.stringify({ presetId: 'hivex' }) },
      ],
      settings,
      seed: SEED,
    });
    expect(verifySaveEnvelope(envelope).mode).toBe('replay');
    expect(envelope.players.map((p) => p.name)).toEqual(['Hosta', 'Guestov', 'Guestina']);
    expect(envelope.game.local_player_id).toBe(0);
    expect(state.empires.length).toBe(3);
    expect(state.empires[1]!.picks).toContain('industry2');
    expect(state.coreWorlds?.length).toBe(5); // players+2 — the option carried
    expect(warnings.some((w) => w.includes('Guestov'))).toBe(true); // underspent race warned
  });

  it('refuses budget violations, mode mismatches and duplicate names', () => {
    const host = { name: 'H', raceJson: JSON.stringify({ presetId: 'solari' }) };
    expect(() =>
      buildDayOneAsync({
        host,
        guests: [{ name: 'G', raceJson: JSON.stringify({ picks: ['industry3', 'science3', 'dictatorship'] }) }],
        settings,
        seed: SEED,
      }),
    ).toThrow(/exceeds/);
    expect(() =>
      buildDayOneAsync({
        host,
        guests: [{ name: 'G', raceJson: JSON.stringify({ picks: ['out_of_box_thinking', 'industry1', 'dictatorship'] }) }],
        settings,
        seed: SEED,
      }),
    ).toThrow(/out_of_box/);
    expect(() =>
      buildDayOneAsync({
        host,
        guests: [{ name: 'h', raceJson: JSON.stringify({ presetId: 'hivex' }) }],
        settings,
        seed: SEED,
      }),
    ).toThrow(/duplicate/);
  });
});
