// Race strings: a player's name + race picks as a copyable base64 token, so
// a day-one async game can be assembled without anyone sharing a lobby. Copy
// yours from the Lobby (pre-game) or the Empires screen (mid-game); the async
// host pastes everyone's and gets a working save file.

import { racePresetById, validatePicks } from '@engine/data/index';

export const RACE_STRING_PREFIX = 'moo2race1:';

export interface RaceStringPayload {
  name: string;
  /** the raceJson the lobby/engine already speak: {presetId,color?} or {picks,raceName,color?} */
  raceJson: string;
}

function toB64(s: string): string {
  const bytes = new TextEncoder().encode(s);
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

function fromB64(b64: string): string {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}

export function encodeRaceString(payload: RaceStringPayload): string {
  return RACE_STRING_PREFIX + toB64(JSON.stringify({ v: 1, name: payload.name, race: payload.raceJson }));
}

export function decodeRaceString(input: string): RaceStringPayload {
  const s = input.trim();
  if (!s.startsWith(RACE_STRING_PREFIX)) throw new Error('not a race string (expected moo2race1:…)');
  let parsed: { v?: number; name?: unknown; race?: unknown };
  try {
    parsed = JSON.parse(fromB64(s.slice(RACE_STRING_PREFIX.length))) as typeof parsed;
  } catch {
    throw new Error('race string is corrupted (bad base64/JSON)');
  }
  if (parsed.v !== 1 || typeof parsed.name !== 'string' || typeof parsed.race !== 'string') {
    throw new Error('race string has an unknown format');
  }
  return { name: parsed.name, raceJson: parsed.race };
}

export interface RaceStringCheck {
  errors: string[];
  warnings: string[];
  /** short human summary, e.g. "Custom (14/14 picks)" or "preset Solari" */
  summary: string;
}

/** Sanity-check a pasted race string against the async game's options. */
export function checkRaceString(
  payload: RaceStringPayload,
  opts: { pickPoints: number; outOfBoxThinking: boolean },
): RaceStringCheck {
  const errors: string[] = [];
  const warnings: string[] = [];
  let summary = '';
  const name = payload.name.trim();
  if (!name) errors.push('empty player name');
  if (name.length > 40) errors.push('player name too long');

  let race: { presetId?: unknown; picks?: unknown; raceName?: unknown };
  try {
    race = JSON.parse(payload.raceJson) as typeof race;
  } catch {
    return { errors: [...errors, 'race data is not valid JSON'], warnings, summary: '?' };
  }

  if (typeof race.presetId === 'string') {
    const preset = racePresetById.get(race.presetId);
    if (!preset) {
      errors.push(`unknown preset: ${race.presetId}`);
      summary = `preset ${race.presetId}?`;
    } else {
      const v = validatePicks(preset.picks, opts.pickPoints);
      errors.push(...v.errors);
      summary = `preset ${preset.name} (${v.cost}/${opts.pickPoints} picks)`;
    }
  } else if (Array.isArray(race.picks) && race.picks.every((p) => typeof p === 'string')) {
    const picks = race.picks as string[];
    const v = validatePicks(picks, opts.pickPoints);
    errors.push(...v.errors);
    // the classic mismatch: a 10-point race in a 14-point game leaves value
    // on the table — legal, but the player should probably re-spec
    if (v.ok && v.cost < opts.pickPoints) {
      warnings.push(`only ${v.cost} of ${opts.pickPoints} pick points spent — re-spec for this game?`);
    }
    if (picks.includes('out_of_box_thinking') && !opts.outOfBoxThinking) {
      errors.push('race takes out_of_box_thinking but the game does not enable that mode');
    }
    summary = `${typeof race.raceName === 'string' ? race.raceName : 'Custom'} (${v.cost}/${opts.pickPoints} picks)`;
  } else {
    errors.push('race data carries neither a preset nor a pick list');
    summary = '?';
  }
  return { errors, warnings, summary };
}
