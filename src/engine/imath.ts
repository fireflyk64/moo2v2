// Integer rounding helpers matching the classic engine's spreadsheet-style
// semantics (ROUND = half-up, ROUNDDOWN = trunc toward zero, ROUNDUP = away
// from zero). All inputs/outputs are safe integers; division is expressed as
// (numerator, denominator) pairs so no floats ever appear.

export function floorDiv(n: number, d: number): number {
  if (d <= 0) throw new Error(`floorDiv: bad denominator ${d}`);
  return Math.floor(n / d);
}

export function ceilDiv(n: number, d: number): number {
  if (d <= 0) throw new Error(`ceilDiv: bad denominator ${d}`);
  return Math.ceil(n / d);
}

/** Round-half-up division (works for negative numerators too: -2.5 -> -2). */
export function roundDiv(n: number, d: number): number {
  if (d <= 0) throw new Error(`roundDiv: bad denominator ${d}`);
  return Math.floor((2 * n + d) / (2 * d));
}

/** trunc toward zero (spreadsheet ROUNDDOWN for possibly-negative values) */
export function truncDiv(n: number, d: number): number {
  if (d <= 0) throw new Error(`truncDiv: bad denominator ${d}`);
  const q = n / d;
  return q < 0 ? -Math.floor(-q) : Math.floor(q);
}

export function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

export function sum(xs: readonly number[]): number {
  let s = 0;
  for (const x of xs) s += x;
  return s;
}
