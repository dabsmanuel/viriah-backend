/** Round half up everywhere (Document 3, section 8.7). Works for negative numbers symmetrically away from zero is NOT needed: scores are non negative. */
export function roundHalfUp(n: number, dp = 0): number {
  if (!Number.isFinite(n)) return n;
  const shifted = Number(`${Math.abs(n)}e${dp}`);
  const rounded = Math.round(shifted);
  const out = Number(`${rounded}e-${dp}`);
  return n < 0 ? -out : out;
}

/** Score values keep one decimal place. */
export const round1 = (n: number) => roundHalfUp(n, 1);
export const round2 = (n: number) => roundHalfUp(n, 2);
