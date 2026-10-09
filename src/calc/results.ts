import { roundHalfUp, round1 } from '../lib/rounding';
import { rank } from './ranking';

/** Score and result rules from Document 3, section 8. Pure functions: no I/O, same inputs give the same output. */

export interface Band {
  min: number;
  max: number;
  grade: string;
  remark: string;
}
export interface GradingScale {
  passMark: number;
  bands: Band[];
}
export interface Component {
  key: string;
  name?: string;
  max: number;
  order?: number;
}

/** Bands must cover 0 to 100 with no gap or overlap. Returns a message naming the first problem, or null. */
export function validateBands(bands: Band[]): string | null {
  if (!bands.length) return 'Add at least one grade band.';
  const sorted = [...bands].sort((a, b) => a.min - b.min);
  for (const b of sorted) {
    if (!Number.isInteger(b.min) || !Number.isInteger(b.max)) return `Band ${b.grade || ''} must use whole numbers.`;
    if (b.min > b.max) return `Band ${b.grade}: the lowest score ${b.min} is above the highest score ${b.max}.`;
  }
  if (sorted[0].min !== 0) return `Bands must start at 0. The first band starts at ${sorted[0].min}.`;
  for (let i = 1; i < sorted.length; i++) {
    const prev = sorted[i - 1];
    const cur = sorted[i];
    if (cur.min > prev.max + 1) return `There is a gap between ${prev.max} and ${cur.min}. Scores ${prev.max + 1} to ${cur.min - 1} have no grade.`;
    if (cur.min <= prev.max) return `Bands ${prev.grade} and ${cur.grade} overlap at ${cur.min} to ${Math.min(prev.max, cur.max)}.`;
  }
  const last = sorted[sorted.length - 1];
  if (last.max !== 100) return `Bands must end at 100. The last band ends at ${last.max}.`;
  return null;
}

/** Component maximums must total 100. */
export function validateStructure(components: Component[]): string | null {
  if (!components.length) return 'Add at least one assessment component.';
  const keys = new Set<string>();
  for (const c of components) {
    if (!c.key) return 'Every component needs a key.';
    if (keys.has(c.key)) return `Two components use the key ${c.key}.`;
    keys.add(c.key);
    if (!(c.max > 0)) return `${c.name || c.key} needs a maximum above zero.`;
  }
  const total = components.reduce((a, c) => a + c.max, 0);
  if (Math.abs(total - 100) > 1e-9) return `The maximum scores add up to ${total}. They must add up to 100.`;
  return null;
}

/** Grade lookup uses the total rounded half up to a whole number. */
export function gradeFor(total: number, scale: GradingScale): { grade: string; remark: string } {
  const n = Math.min(100, Math.max(0, roundHalfUp(total, 0)));
  const band = scale.bands.find((b) => n >= b.min && n <= b.max);
  return { grade: band?.grade ?? '-', remark: band?.remark ?? '' };
}

export interface ScoreCell {
  components?: Record<string, number | null | undefined>;
  absent?: string[];
  exempt?: boolean;
}

/** A component score has at most one decimal place and lies between 0 and the component maximum. */
export function checkComponentScore(value: number, max: number): string | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) return 'Enter a number.';
  if (value < 0) return 'A score cannot be negative.';
  if (value > max) return `Marked out of ${max}.`;
  if (Math.abs(value * 10 - Math.round(value * 10)) > 1e-9) return 'Use at most one decimal place.';
  return null;
}

export interface SubjectResult {
  complete: boolean;
  exempt: boolean;
  total: number | null;
  grade: string | null;
  remark: string | null;
  missing: string[];
}

/** A subject is complete when every component has a score or an absent flag. Absent counts as 0. */
export function computeSubject(cell: ScoreCell, components: Component[], scale: GradingScale): SubjectResult {
  if (cell.exempt) return { complete: true, exempt: true, total: null, grade: null, remark: null, missing: [] };
  const absent = new Set(cell.absent ?? []);
  const missing: string[] = [];
  let sum = 0;
  for (const c of components) {
    const v = cell.components?.[c.key];
    if (absent.has(c.key)) continue;
    if (v === null || v === undefined) {
      missing.push(c.key);
      continue;
    }
    sum += v;
  }
  const total = round1(sum);
  const complete = missing.length === 0;
  if (!complete) return { complete, exempt: false, total: null, grade: null, remark: null, missing };
  const { grade, remark } = gradeFor(total, scale);
  return { complete, exempt: false, total, grade, remark, missing };
}

export interface SubjectStats {
  average: number;
  highest: number;
  lowest: number;
  count: number;
}

export function subjectStats(totals: number[]): SubjectStats | null {
  if (!totals.length) return null;
  const sum = totals.reduce((a, b) => a + b, 0);
  return { average: sum / totals.length, highest: Math.max(...totals), lowest: Math.min(...totals), count: totals.length };
}

/** Subject positions for students that have a total, highest first. */
export function subjectPositions(rows: Array<{ studentId: string; total: number }>): Map<string, number> {
  return new Map(rank(rows, (r) => r.total).map((r) => [r.item.studentId, r.position]));
}

export interface TermResultInput {
  studentId: string;
  /** totals of the student's non exempt subjects that have a total */
  totals: number[];
}
export interface TermResultOut {
  studentId: string;
  subjectsCount: number;
  total: number;
  average: number; // unrounded
  position: number | null;
  classSize: number;
}

/**
 * subjectsCount = non-exempt subjects with a total. average = total / subjectsCount (unrounded, shown to 2 d.p.).
 * Position ranks by average, not total, because students may offer different numbers of subjects.
 */
export function computeTermResults(rows: TermResultInput[], withPositions: boolean): TermResultOut[] {
  const base = rows
    .filter((r) => r.totals.length > 0)
    .map((r) => {
      const total = round1(r.totals.reduce((a, b) => a + b, 0));
      return { studentId: r.studentId, subjectsCount: r.totals.length, total, average: total / r.totals.length };
    });
  const positions = withPositions ? new Map(rank(base, (b) => b.average).map((r) => [r.item.studentId, r.position])) : new Map<string, number>();
  return base.map((b) => ({ ...b, position: positions.get(b.studentId) ?? null, classSize: base.length }));
}

/** Attendance: opened = days with a register, present = present or late, absent = opened minus present. */
export function attendanceTotals(daysByStatus: Array<'present' | 'absent' | 'late' | 'excused' | undefined>) {
  const opened = daysByStatus.length;
  const present = daysByStatus.filter((s) => s === 'present' || s === 'late').length;
  return { opened, present, absent: opened - present };
}

export const attendancePercent = (present: number, opened: number): number | null => (opened > 0 ? (present / opened) * 100 : null);
