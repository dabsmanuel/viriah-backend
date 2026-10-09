/**
 * Promotion proposal (Document 3, section 8.5). The engine takes a student's annual result, the active rule
 * for their class level and the grading scale's pass mark. It returns an outcome and the list of checks.
 * The same inputs always give the same outcome, and the reasons are listed.
 */

export type Outcome = 'promoted' | 'promoted_on_trial' | 'repeat' | 'graduated' | 'undecided';

export interface PromotionRuleInput {
  minAnnualAverage?: number | null;
  mustPassSubjectIds?: string[];
  minSubjectsPassed?: number | null;
  minAttendancePercent?: number | null;
  trial?: { enabled?: boolean; minAnnualAverage?: number | null; maxFailedMustPass?: number | null };
}

export interface AnnualInput {
  average: number | null;
  attendancePercent: number | null;
  subjects: Array<{ subjectId: string; average: number | null }>;
}

export interface Check {
  condition: string;
  required: number;
  actual: number | null;
  passed: boolean;
}

export interface Proposal {
  outcome: Outcome;
  checks: Check[];
}

const isSet = (v: unknown): v is number => v !== null && v !== undefined;

export function propose(annual: AnnualInput, rule: PromotionRuleInput | null | undefined, passMark: number, level: { isFinal: boolean }): Proposal {
  if (!rule) return { outcome: 'undecided', checks: [] };

  const checks: Check[] = [];
  if (isSet(rule.minAnnualAverage)) {
    checks.push({
      condition: 'annual_average',
      required: rule.minAnnualAverage,
      actual: annual.average,
      passed: annual.average !== null && annual.average >= rule.minAnnualAverage
    });
  }
  for (const subjectId of rule.mustPassSubjectIds ?? []) {
    const score = annual.subjects.find((s) => s.subjectId === subjectId)?.average ?? null; // missing counts as failed
    checks.push({ condition: `must_pass:${subjectId}`, required: passMark, actual: score, passed: score !== null && score >= passMark });
  }
  if (isSet(rule.minSubjectsPassed)) {
    const n = annual.subjects.filter((s) => s.average !== null && s.average >= passMark).length;
    checks.push({ condition: 'subjects_passed', required: rule.minSubjectsPassed, actual: n, passed: n >= rule.minSubjectsPassed });
  }
  if (isSet(rule.minAttendancePercent)) {
    checks.push({
      condition: 'attendance',
      required: rule.minAttendancePercent,
      actual: annual.attendancePercent,
      passed: annual.attendancePercent !== null && annual.attendancePercent >= rule.minAttendancePercent
    });
  }

  if (checks.every((c) => c.passed)) return { outcome: level.isFinal ? 'graduated' : 'promoted', checks };

  const trial = rule.trial;
  if (trial?.enabled && !level.isFinal) {
    const failedMust = checks.filter((c) => c.condition.startsWith('must_pass:') && !c.passed).length;
    const attendanceCheck = checks.find((c) => c.condition === 'attendance');
    if (
      isSet(trial.minAnnualAverage) &&
      annual.average !== null &&
      annual.average >= trial.minAnnualAverage &&
      failedMust <= (trial.maxFailedMustPass ?? 0) &&
      (!attendanceCheck || attendanceCheck.passed)
    ) {
      return { outcome: 'promoted_on_trial', checks };
    }
  }
  return { outcome: 'repeat', checks };
}
