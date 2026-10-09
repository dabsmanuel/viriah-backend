/** All money is stored and moved as whole kobo. No floating point arithmetic on money (NFR-13). */

export const assertKobo = (n: number, label = 'amount') => {
  if (!Number.isSafeInteger(n)) throw new Error(`${label} must be a whole number of kobo`);
  return n;
};

/** 125000000 -> "1,250,000.00" */
export function formatKobo(kobo: number): string {
  assertKobo(kobo);
  const neg = kobo < 0;
  const abs = Math.abs(kobo);
  const naira = Math.trunc(abs / 100);
  const frac = String(abs % 100).padStart(2, '0');
  const grouped = String(naira).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return `${neg ? '-' : ''}${grouped}.${frac}`;
}

/** "1,250.50" or 1250.5 (naira) -> kobo. Rejects more than two decimals. */
export function nairaToKobo(input: string | number): number {
  const s = String(input).replace(/[,\s₦]/g, '');
  if (!/^-?\d+(\.\d{1,2})?$/.test(s)) throw new Error('Invalid naira amount');
  const [whole, frac = ''] = s.replace('-', '').split('.');
  const kobo = Number(whole) * 100 + Number(frac.padEnd(2, '0'));
  return s.startsWith('-') ? -kobo : kobo;
}

/** percent has at most two decimals. Rounds half up. Integer arithmetic only. */
export function percentOfKobo(amountKobo: number, percent: number): number {
  assertKobo(amountKobo);
  const bps = Math.round(percent * 100); // basis points
  return Math.floor((amountKobo * bps + 5000) / 10000);
}

export const sumKobo = (xs: number[]): number => xs.reduce((a, b) => a + assertKobo(b), 0);
export const minKobo = (a: number, b: number) => (a < b ? a : b);
