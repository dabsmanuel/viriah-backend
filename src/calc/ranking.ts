/**
 * Standard competition ranking on unrounded values (Document 3, section 8.2).
 * Equal values share a position and the next position is skipped.
 * Averages 78.4, 75.0, 75.0, 71.2 give positions 1, 2, 2, 4.
 */
const EPS = 1e-9;

export interface Ranked<T> {
  item: T;
  value: number;
  position: number;
}

export function rank<T>(items: T[], valueOf: (t: T) => number): Ranked<T>[] {
  const sorted = items.map((item) => ({ item, value: valueOf(item) })).sort((a, b) => b.value - a.value);
  const out: Ranked<T>[] = [];
  sorted.forEach((row, i) => {
    const prev = out[i - 1];
    const position = prev && Math.abs(prev.value - row.value) < EPS ? prev.position : i + 1;
    out.push({ ...row, position });
  });
  return out;
}
