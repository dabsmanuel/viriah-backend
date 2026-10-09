/** Locale: Africa/Lagos (UTC+1, no daylight saving). Times are stored in UTC. Dates with no time are YYYY-MM-DD strings. */

const LAGOS_OFFSET_MS = 60 * 60 * 1000;
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

export const isDateString = (s: unknown): s is string => {
  if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
};

/** The calendar date in Lagos for an instant. */
export function lagosDate(at: Date = new Date()): string {
  return new Date(at.getTime() + LAGOS_OFFSET_MS).toISOString().slice(0, 10);
}

export const todayLagos = () => lagosDate(new Date());

/** "2026-10-07" -> "7 Oct 2026" */
export function formatDate(input: string | Date): string {
  const s = typeof input === 'string' ? input.slice(0, 10) : lagosDate(input);
  const [y, m, d] = s.split('-').map(Number);
  return `${d} ${MONTHS[m - 1]} ${y}`;
}

export function addDays(dateStr: string, days: number): string {
  const d = new Date(`${dateStr}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

export function diffDays(a: string, b: string): number {
  return Math.round((new Date(`${a}T00:00:00Z`).getTime() - new Date(`${b}T00:00:00Z`).getTime()) / 86400000);
}

export const minutesFromNow = (m: number) => new Date(Date.now() + m * 60_000);
export const hoursFromNow = (h: number) => new Date(Date.now() + h * 3_600_000);
export const daysFromNow = (d: number) => new Date(Date.now() + d * 86_400_000);

/** Two digit year in Lagos, used in receipt numbers: GFS/26/000431 */
export const yy = (at: Date = new Date()) => lagosDate(at).slice(2, 4);

/** All dates (YYYY-MM-DD) from start to end inclusive. */
export function eachDate(start: string, end: string): string[] {
  const out: string[] = [];
  for (let d = start; d <= end; d = addDays(d, 1)) out.push(d);
  return out;
}

export const isWeekend = (dateStr: string) => {
  const day = new Date(`${dateStr}T00:00:00Z`).getUTCDay();
  return day === 0 || day === 6;
};
