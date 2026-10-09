import { describe, expect, it } from 'vitest';
import { rank } from '../src/calc/ranking';
import {
  attendancePercent,
  attendanceTotals,
  checkComponentScore,
  computeSubject,
  computeTermResults,
  gradeFor,
  subjectPositions,
  subjectStats,
  validateBands,
  validateStructure
} from '../src/calc/results';
import { annualAverage, computeAnnualSubjects } from '../src/calc/annual';
import { propose } from '../src/calc/promotion';
import { suggestComment } from '../src/calc/comments';
import { allocateRoundAmount, commissionFor, discountAmount, invoiceBalance, invoiceStatus, invoiceTotal, minimumPartPayment, paystackFee, quote } from '../src/calc/fees';
import { brandTokens, contrastColour, contrastRatio, parseHex, textOnWhite } from '../src/calc/contrast';
import { formatKobo, nairaToKobo, percentOfKobo } from '../src/lib/money';
import { roundHalfUp } from '../src/lib/rounding';
import { formatDate, lagosDate, addDays } from '../src/lib/dates';
import { normalizePhone, formatPhoneLocal } from '../src/lib/phone';

const SCALE = {
  passMark: 40,
  bands: [
    { min: 70, max: 100, grade: 'A', remark: 'Excellent' },
    { min: 60, max: 69, grade: 'B', remark: 'Very good' },
    { min: 50, max: 59, grade: 'C', remark: 'Good' },
    { min: 45, max: 49, grade: 'D', remark: 'Fair' },
    { min: 40, max: 44, grade: 'E', remark: 'Pass' },
    { min: 0, max: 39, grade: 'F', remark: 'Fail' }
  ]
};
const COMPONENTS = [
  { key: 'ca1', max: 20 },
  { key: 'ca2', max: 20 },
  { key: 'exam', max: 60 }
];

describe('money helpers', () => {
  it('formats 125000000 kobo as 1,250,000.00', () => {
    expect(formatKobo(125000000)).toBe('1,250,000.00');
    expect(formatKobo(5)).toBe('0.05');
    expect(formatKobo(0)).toBe('0.00');
  });
  it('parses naira to kobo without floating point', () => {
    expect(nairaToKobo('1,250.50')).toBe(125050);
    expect(nairaToKobo('0.30')).toBe(30);
    expect(() => nairaToKobo(0.1 + 0.2)).toThrow(); // a float with stray digits is refused, not rounded
    expect(() => nairaToKobo('1.234')).toThrow();
  });
  it('rounds a percentage on an amount that does not divide evenly, half up', () => {
    expect(percentOfKobo(1001, 10)).toBe(100); // 100.1
    expect(percentOfKobo(1005, 10)).toBe(101); // 100.5 rounds up
    expect(percentOfKobo(333, 33.33)).toBe(111);
  });
});

describe('dates and phones', () => {
  it('uses Africa/Lagos for calendar dates', () => {
    expect(lagosDate(new Date('2026-10-07T23:30:00Z'))).toBe('2026-10-08');
    expect(formatDate('2026-10-07')).toBe('7 Oct 2026');
    expect(addDays('2026-02-27', 2)).toBe('2026-03-01');
  });
  it('normalises Nigerian numbers to international format', () => {
    expect(normalizePhone('0803 123 4567')).toBe('+2348031234567');
    expect(normalizePhone('2348031234567')).toBe('+2348031234567');
    expect(normalizePhone('+2348031234567')).toBe('+2348031234567');
    expect(normalizePhone('12345')).toBeNull();
    expect(formatPhoneLocal('+2348031234567')).toBe('08031234567');
  });
});

describe('ranking', () => {
  it('shares positions and skips the next (standard competition ranking)', () => {
    const r = rank([78.4, 75.0, 75.0, 71.2], (v) => v);
    expect(r.map((x) => x.position)).toEqual([1, 2, 2, 4]);
  });
  it('ranks unrounded values', () => {
    const r = rank([{ a: 71.5 }, { a: 71.4999 }], (x) => x.a);
    expect(r.map((x) => x.position)).toEqual([1, 2]);
  });
});

describe('grading scale and structure validation', () => {
  it('accepts a full scale', () => expect(validateBands(SCALE.bands)).toBeNull());
  it('names a gap', () => {
    const bad = SCALE.bands.map((b) => (b.grade === 'C' ? { ...b, min: 52 } : b));
    expect(validateBands(bad)).toMatch(/gap between 49 and 52/);
  });
  it('names an overlap', () => {
    const bad = SCALE.bands.map((b) => (b.grade === 'B' ? { ...b, min: 58 } : b));
    expect(validateBands(bad)).toMatch(/overlap/);
  });
  it('requires the scale to run from 0 to 100', () => {
    expect(validateBands([{ min: 1, max: 100, grade: 'A', remark: '' }])).toMatch(/start at 0/);
    expect(validateBands([{ min: 0, max: 90, grade: 'A', remark: '' }])).toMatch(/end at 100/);
  });
  it('requires component maximums to total 100', () => {
    expect(validateStructure(COMPONENTS)).toBeNull();
    expect(validateStructure([{ key: 'ca', max: 30 }, { key: 'exam', max: 60 }])).toMatch(/add up to 90/);
  });
});

describe('subject results', () => {
  it('rounds half up for the grade lookup: 77.5 is 78 and grades A', () => {
    expect(roundHalfUp(77.5)).toBe(78);
    expect(gradeFor(77.5, SCALE)).toEqual({ grade: 'A', remark: 'Excellent' });
    expect(gradeFor(69.5, SCALE).grade).toBe('A'); // 69.5 rounds to 70
    expect(gradeFor(39.4, SCALE).grade).toBe('F');
  });
  it('validates a component score', () => {
    expect(checkComponentScore(21, 20)).toBe('Marked out of 20.');
    expect(checkComponentScore(14.25, 20)).toMatch(/one decimal/);
    expect(checkComponentScore(-1, 20)).toMatch(/negative/);
    expect(checkComponentScore(14.5, 20)).toBeNull();
  });
  it('counts an absent component as 0 and still completes the subject', () => {
    const r = computeSubject({ components: { ca1: 12, exam: 39 }, absent: ['ca2'] }, COMPONENTS, SCALE);
    expect(r).toMatchObject({ complete: true, total: 51, grade: 'C' });
  });
  it('is incomplete while a component has neither a score nor an absent flag', () => {
    const r = computeSubject({ components: { ca1: 12 } }, COMPONENTS, SCALE);
    expect(r.complete).toBe(false);
    expect(r.missing).toEqual(['ca2', 'exam']);
  });
  it('leaves an exempt subject out', () => {
    expect(computeSubject({ exempt: true }, COMPONENTS, SCALE)).toMatchObject({ exempt: true, total: null });
  });
  it('computes class statistics and subject positions', () => {
    expect(subjectStats([50, 60, 70])).toMatchObject({ average: 60, highest: 70, lowest: 50, count: 3 });
    const pos = subjectPositions([
      { studentId: 'a', total: 80 },
      { studentId: 'b', total: 80 },
      { studentId: 'c', total: 60 }
    ]);
    expect([pos.get('a'), pos.get('b'), pos.get('c')]).toEqual([1, 1, 3]);
  });
});

describe('term result: the worked example in Document 3 section 8.3', () => {
  it('reproduces total 214.5 and average 71.50 with Fine Art exempt', () => {
    const english = computeSubject({ components: { ca1: 15, ca2: 14.5, exam: 48 } }, COMPONENTS, SCALE);
    const maths = computeSubject({ components: { ca1: 12, exam: 39 }, absent: ['ca2'] }, COMPONENTS, SCALE);
    const science = computeSubject({ components: { ca1: 18, ca2: 17, exam: 51 } }, COMPONENTS, SCALE);
    const art = computeSubject({ exempt: true }, COMPONENTS, SCALE);
    expect(english).toMatchObject({ total: 77.5, grade: 'A' });
    expect(maths).toMatchObject({ total: 51, grade: 'C' });
    expect(science).toMatchObject({ total: 86, grade: 'A' });
    const totals = [english, maths, science, art].filter((s) => !s.exempt && s.total !== null).map((s) => s.total as number);
    const [res] = computeTermResults([{ studentId: 's1', totals }], true);
    expect(res.subjectsCount).toBe(3);
    expect(res.total).toBe(214.5);
    expect(res.average).toBeCloseTo(71.5, 10);
    expect(res.average.toFixed(2)).toBe('71.50');
  });
  it('ranks by average, not total, so students with fewer subjects are not penalised', () => {
    const rows = computeTermResults(
      [
        { studentId: 'a', totals: [70, 70, 70] }, // total 210, average 70
        { studentId: 'b', totals: [80, 80] } // total 160, average 80
      ],
      true
    );
    expect(rows.find((r) => r.studentId === 'b')!.position).toBe(1);
    expect(rows.find((r) => r.studentId === 'a')!.position).toBe(2);
  });
  it('gives tied averages positions 1, 2, 2, 4', () => {
    const rows = computeTermResults(
      [
        { studentId: 'a', totals: [78.4] },
        { studentId: 'b', totals: [75] },
        { studentId: 'c', totals: [75] },
        { studentId: 'd', totals: [71.2] }
      ],
      true
    );
    const pos = (id: string) => rows.find((r) => r.studentId === id)!.position;
    expect([pos('a'), pos('b'), pos('c'), pos('d')]).toEqual([1, 2, 2, 4]);
  });
  it('stores no positions when the level group has positions off', () => {
    const rows = computeTermResults([{ studentId: 'a', totals: [60] }], false);
    expect(rows[0].position).toBeNull();
  });
  it('counts attendance: present or late is present, opened is days with a register', () => {
    expect(attendanceTotals(['present', 'late', 'absent', 'excused', 'present'])).toEqual({ opened: 5, present: 3, absent: 2 });
    expect(attendancePercent(3, 5)).toBe(60);
    expect(attendancePercent(0, 0)).toBeNull();
  });
});

describe('annual result', () => {
  it('uses the mean of the term totals that exist', () => {
    const subs = computeAnnualSubjects(
      [
        { subjectId: 'm', terms: { 1: 60, 2: 70, 3: 80 } },
        { subjectId: 'e', terms: { 2: 50, 3: 70 } } // joined in second term
      ],
      SCALE
    );
    expect(subs[0].average).toBe(70);
    expect(subs[1]).toMatchObject({ t1: null, average: 60, grade: 'B' });
    expect(annualAverage(subs)).toBe(65);
  });
  it('supports third term only', () => {
    const [s] = computeAnnualSubjects([{ subjectId: 'm', terms: { 1: 10, 3: 90 } }], SCALE, 'third_term_only');
    expect(s.average).toBe(90);
  });
});

describe('promotion proposal', () => {
  const level = { isFinal: false };
  const annual = { average: 55, attendancePercent: 90, subjects: [{ subjectId: 'maths', average: 52 }, { subjectId: 'eng', average: 45 }] };
  const rule = { minAnnualAverage: 50, mustPassSubjectIds: ['maths', 'eng'], minSubjectsPassed: 2, minAttendancePercent: 75 };

  it('is undecided when no rule exists', () => {
    expect(propose(annual, null, 40, level)).toEqual({ outcome: 'undecided', checks: [] });
  });
  it('promotes when every condition is met, listing the checks', () => {
    const p = propose(annual, rule, 40, level);
    expect(p.outcome).toBe('promoted');
    expect(p.checks.map((c) => c.condition)).toEqual(['annual_average', 'must_pass:maths', 'must_pass:eng', 'subjects_passed', 'attendance']);
    expect(p.checks.every((c) => c.passed)).toBe(true);
  });
  it('graduates in the final class', () => {
    expect(propose(annual, rule, 40, { isFinal: true }).outcome).toBe('graduated');
  });
  it('asks to repeat when a condition fails', () => {
    const p = propose({ ...annual, average: 48 }, rule, 40, level);
    expect(p.outcome).toBe('repeat');
    expect(p.checks.find((c) => c.condition === 'annual_average')).toMatchObject({ required: 50, actual: 48, passed: false });
  });
  it('counts a missing must-pass subject as failed', () => {
    const p = propose({ ...annual, subjects: [{ subjectId: 'maths', average: 52 }] }, { mustPassSubjectIds: ['maths', 'eng'] }, 40, level);
    expect(p.outcome).toBe('repeat');
    expect(p.checks.find((c) => c.condition === 'must_pass:eng')).toMatchObject({ actual: null, passed: false });
  });
  it('promotes on trial when the trial rule allows it', () => {
    const trialRule = { ...rule, trial: { enabled: true, minAnnualAverage: 45, maxFailedMustPass: 1 } };
    const weak = { average: 47, attendancePercent: 90, subjects: [{ subjectId: 'maths', average: 52 }, { subjectId: 'eng', average: 30 }] };
    expect(propose(weak, trialRule, 40, level).outcome).toBe('promoted_on_trial');
    // trial never applies to the final class
    expect(propose(weak, trialRule, 40, { isFinal: true }).outcome).toBe('repeat');
    // and not when attendance failed
    expect(propose({ ...weak, attendancePercent: 60 }, trialRule, 40, level).outcome).toBe('repeat');
  });
  it('lets any condition be switched off', () => {
    expect(propose({ average: 10, attendancePercent: null, subjects: [] }, { minAnnualAverage: null }, 40, level).outcome).toBe('promoted');
  });
  it('is deterministic', () => {
    expect(propose(annual, rule, 40, level)).toEqual(propose(annual, rule, 40, level));
  });
});

describe('suggested comments', () => {
  const bank = [
    { author: 'class_teacher', minAverage: 70, maxAverage: 100, text: 'Excellent work.' },
    { author: 'class_teacher', minAverage: 70, maxAverage: 100, text: 'A brilliant term.' },
    { author: 'class_teacher', minAverage: 0, maxAverage: 69.99, text: 'Keep trying.' },
    { author: 'principal', minAverage: 0, maxAverage: 100, text: 'Well done.' }
  ];
  it('picks repeatably by position in the class list', () => {
    expect(suggestComment(bank, 'class_teacher', 80, 0)).toBe('Excellent work.');
    expect(suggestComment(bank, 'class_teacher', 80, 1)).toBe('A brilliant term.');
    expect(suggestComment(bank, 'class_teacher', 80, 2)).toBe('Excellent work.');
    expect(suggestComment(bank, 'class_teacher', 40, 5)).toBe('Keep trying.');
    expect(suggestComment(bank, 'principal', 40, 0)).toBe('Well done.');
    expect(suggestComment(bank, 'class_teacher', null, 0)).toBeNull();
  });
});

describe('invoice arithmetic', () => {
  it('computes totals, balance and status from the numbers', () => {
    const total = invoiceTotal([{ amountKobo: 5000000 }, { amountKobo: 1000000 }], [{ amountKobo: 500000 }]);
    expect(total).toBe(5500000);
    expect(invoiceStatus(total, 0)).toBe('issued');
    expect(invoiceStatus(total, 100)).toBe('part_paid');
    expect(invoiceStatus(total, total)).toBe('paid');
    expect(invoiceStatus(total, total, 'void')).toBe('void');
    expect(invoiceBalance(total, 1000000)).toBe(4500000);
  });
  it('applies a percentage discount on an amount that does not divide evenly', () => {
    expect(discountAmount(1000001, { type: 'percent', percent: 15 })).toBe(150000); // 150000.15
    expect(discountAmount(333335, { type: 'percent', percent: 10 })).toBe(33334); // 33333.5 rounds up
    expect(discountAmount(1000, { type: 'fixed', amountKobo: 5000 })).toBe(1000); // never above the base
  });
  it('allocates a round amount to the oldest invoice first and holds the rest as credit', () => {
    const r = allocateRoundAmount(1500, [
      { invoiceId: 'new', studentId: 's', balanceKobo: 1000, createdAt: '2026-09-01' },
      { invoiceId: 'old', studentId: 's', balanceKobo: 800, createdAt: '2026-01-01' }
    ]);
    expect(r.allocations).toEqual([
      { invoiceId: 'old', studentId: 's', amountKobo: 800 },
      { invoiceId: 'new', studentId: 's', amountKobo: 700 }
    ]);
    expect(r.creditKobo).toBe(0);
    expect(allocateRoundAmount(3000, [{ invoiceId: 'a', studentId: 's', balanceKobo: 1000 }]).creditKobo).toBe(2000);
  });
  it('applies the minimum part payment to the first payment only', () => {
    expect(minimumPartPayment(1000000, 0, 25)).toBe(250000);
    expect(minimumPartPayment(1000000, 1, 25)).toBe(0);
    expect(minimumPartPayment(1000000, 0, 0)).toBe(0);
  });
});

describe('payment charge gross up', () => {
  const N = (naira: number) => naira * 100;
  const cases = [1000, 2400, 2500, 50000, 200000];

  it('computes the Paystack fee: 1.5 percent plus 100, 100 waived below 2,500, capped at 2,000', () => {
    expect(paystackFee(N(2400))).toBe(3600); // no flat fee
    expect(paystackFee(N(2500))).toBe(Math.ceil(N(2500) * 0.015) + 10000);
    expect(paystackFee(N(500000))).toBe(200000); // capped
  });

  for (const naira of cases) {
    it(`leaves the school with exactly the invoice amount when the parent bears the charge (${naira})`, () => {
      const q = quote(N(naira), 'parent', { type: 'none', value: 0 });
      expect(q.schoolReceivesKobo).toBe(N(naira));
      expect(q.totalKobo).toBe(q.feesKobo + q.chargeKobo);
      // it is the smallest total that does so
      const lessByOne = q.totalKobo - 1 - paystackFee(q.totalKobo - 1);
      expect(lessByOne).toBeLessThan(N(naira));
    });
    it(`includes the platform commission in the gross up (${naira})`, () => {
      const q = quote(N(naira), 'parent', { type: 'percent', value: 1 });
      expect(q.commissionKobo).toBe(commissionFor(N(naira), { type: 'percent', value: 1 }));
      expect(q.schoolReceivesKobo).toBe(N(naira));
    });
  }

  it('charges the parent nothing extra when the school bears it', () => {
    const q = quote(N(50000), 'school', { type: 'flat', value: 5000 });
    expect(q.totalKobo).toBe(N(50000));
    expect(q.chargeKobo).toBe(0);
    expect(q.schoolReceivesKobo).toBe(N(50000) - q.paystackFeeKobo - 5000);
  });
});

describe('colour tokens', () => {
  const TEN = ['#facc15', '#fde047', '#eab308', '#22c55e', '#38bdf8', '#f97316', '#1d4ed8', '#7c3aed', '#be123c', '#0f172a'];
  it('gives a yellow primary dark button text', () => {
    expect(contrastColour(parseHex('#facc15')!)).toBe('#000000');
    expect(contrastColour(parseHex('#1d4ed8')!)).toBe('#ffffff');
  });
  it('derives text and link colours that meet 4.5 to 1 on white across ten colours', () => {
    for (const hex of TEN) {
      const text = textOnWhite(parseHex(hex)!);
      expect(contrastRatio(text, [255, 255, 255])).toBeGreaterThanOrEqual(4.5);
    }
  });
  it('picks a contrast colour with at least 4.5 to 1 where either black or white can', () => {
    for (const hex of TEN) {
      const bg = parseHex(hex)!;
      const text = parseHex(contrastColour(bg))!;
      expect(contrastRatio(bg, text)).toBeGreaterThanOrEqual(4.5);
    }
  });
  it('warns when the two colours are too close to tell apart', () => {
    expect(brandTokens('#1d4ed8', '#1e50d8').warnings.join(' ')).toMatch(/too close/);
    expect(brandTokens('#1d4ed8', '#facc15').warnings.join(' ')).not.toMatch(/too close/);
  });
});
