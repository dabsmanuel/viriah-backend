import { rank } from './ranking';
import { gradeFor, type GradingScale } from './results';

export interface AnnualSubjectInput {
  subjectId: string;
  name?: string;
  /** term totals that exist, keyed by term number */
  terms: Partial<Record<1 | 2 | 3, number | null>>;
}

export type AnnualMethod = 'mean_of_terms' | 'third_term_only';

export interface AnnualSubjectOut {
  subjectId: string;
  name?: string;
  t1: number | null;
  t2: number | null;
  t3: number | null;
  average: number | null;
  grade: string | null;
  remark: string | null;
}

/**
 * Annual subject score is the mean of the term totals that exist (default), or the third term only.
 * A student with fewer than three terms still gets a result. Missing terms are blank.
 */
export function computeAnnualSubjects(subjects: AnnualSubjectInput[], scale: GradingScale, method: AnnualMethod = 'mean_of_terms'): AnnualSubjectOut[] {
  return subjects.map((s) => {
    const t1 = s.terms[1] ?? null;
    const t2 = s.terms[2] ?? null;
    const t3 = s.terms[3] ?? null;
    const present = [t1, t2, t3].filter((v): v is number => v !== null);
    let average: number | null = null;
    if (method === 'third_term_only') average = t3;
    else if (present.length) average = present.reduce((a, b) => a + b, 0) / present.length;
    const g = average === null ? null : gradeFor(average, scale);
    return { subjectId: s.subjectId, name: s.name, t1, t2, t3, average, grade: g?.grade ?? null, remark: g?.remark ?? null };
  });
}

/** The annual average is the mean of the annual subject scores. */
export function annualAverage(subjects: AnnualSubjectOut[]): number | null {
  const vals = subjects.map((s) => s.average).filter((v): v is number => v !== null);
  return vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : null;
}

export function annualPositions<T extends { studentId: string; average: number | null }>(rows: T[], enabled: boolean): Map<string, number> {
  if (!enabled) return new Map();
  const ranked = rank(
    rows.filter((r): r is T & { average: number } => r.average !== null),
    (r) => r.average
  );
  return new Map(ranked.map((r) => [r.item.studentId, r.position]));
}
