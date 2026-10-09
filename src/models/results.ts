import { tenantModel, tenantSchema } from '../core/tenancy';
import { Mixed, ref, str, enumStr } from './_helpers';

export const SHEET_STATUS = ['draft', 'submitted', 'returned'] as const;
export const CLASS_RESULT_STATUS = ['open', 'compiled', 'awaiting_approval', 'approved', 'published', 'reopened'] as const;
export const PROMOTION_LIST_STATUS = ['proposed', 'reviewed', 'approved', 'applied'] as const;
export const PROMOTION_OUTCOMES = ['promoted', 'promoted_on_trial', 'repeat', 'graduated', 'undecided'] as const;

export const ScoreSheet = tenantModel(
  'ScoreSheet',
  tenantSchema(
    {
      termId: { ...ref('Term'), required: true },
      classArmId: { ...ref('ClassArm'), required: true },
      subjectId: { ...ref('Subject'), required: true },
      staffId: ref('Staff'),
      status: enumStr(SHEET_STATUS, 'draft'),
      submittedBy: ref('User'),
      submittedAt: Date,
      returnNote: str(),
      returnedBy: ref('User')
    },
    [[{ termId: 1, classArmId: 1, subjectId: 1 }, { unique: true }]]
  )
);

/** One document per student per subject per term: the cells of the score grid and the calculated subject result. */
export const Score = tenantModel(
  'Score',
  tenantSchema(
    {
      termId: { ...ref('Term'), required: true },
      classArmId: ref('ClassArm'), // the arm the student was in when entered
      subjectId: { ...ref('Subject'), required: true },
      studentId: { ...ref('Student'), required: true },
      components: { type: Mixed, default: {} }, // { ca1: 15, ca2: 14.5, exam: 48 }
      absent: [String], // component keys flagged absent (count as 0, print ABS)
      exempt: { type: Boolean, default: false },
      total: Number,
      grade: str(),
      remark: str(),
      subjectPosition: Number,
      classAverage: Number,
      highest: Number,
      lowest: Number,
      source: enumStr(['entered', 'imported'], 'entered'),
      enteredBy: ref('User'),
      onBehalfOf: ref('Staff'), // entered by an admin on behalf of the subject teacher
      importBatchId: ref('ImportBatch')
    },
    [[{ termId: 1, subjectId: 1, studentId: 1 }, { unique: true }], [{ termId: 1, classArmId: 1 }], [{ studentId: 1 }]]
  )
);

export const ClassResult = tenantModel(
  'ClassResult',
  tenantSchema(
    {
      termId: { ...ref('Term'), required: true },
      classArmId: { ...ref('ClassArm'), required: true },
      status: enumStr(CLASS_RESULT_STATUS, 'open'),
      compiledBy: ref('User'),
      compiledAt: Date,
      submittedBy: ref('User'),
      submittedAt: Date,
      approvedBy: ref('User'),
      approvedAt: Date,
      publishedBy: ref('User'),
      publishedAt: Date,
      rejectNote: str(),
      cardsFile: str(), // all report cards of the class as one PDF, ready to print
      cardsGeneratedAt: Date,
      enteredAndApprovedBySame: { type: Boolean, default: false },
      reopenLog: [{ at: Date, by: ref('User'), reason: String, studentIds: [String], _id: false }],
      revision: { type: Number, default: 0 }
    },
    [[{ termId: 1, classArmId: 1 }, { unique: true }]]
  )
);

export const TermResult = tenantModel(
  'TermResult',
  tenantSchema(
    {
      termId: { ...ref('Term'), required: true },
      classArmId: { ...ref('ClassArm'), required: true },
      studentId: { ...ref('Student'), required: true },
      subjectsCount: Number,
      total: Number,
      average: Number, // unrounded
      position: Number,
      classSize: Number,
      attendance: { opened: Number, present: Number, absent: Number },
      ratings: [{ traitId: ref('Trait'), name: String, value: Number, remark: String, _id: false }],
      teacherComment: str(),
      principalComment: str(),
      promotionOutcome: str(),
      verificationCode: str(),
      reportCard: {
        file: str(),
        generatedAt: Date,
        superseded: [{ file: String, at: Date, _id: false }]
      },
      published: { type: Boolean, default: false },
      blockLifted: { type: Boolean, default: false }, // staff lifted the fee block for this student and term (FEE-14)
      blockLiftedBy: ref('User'),
      revision: { type: Number, default: 0 },
      revisedAt: Date,
      source: enumStr(['entered', 'imported'], 'entered'),
      importBatchId: ref('ImportBatch')
    },
    [
      [{ termId: 1, studentId: 1 }, { unique: true }],
      [{ termId: 1, classArmId: 1 }],
      [{ verificationCode: 1 }, { unique: true, sparse: true, noPrefix: true }],
      [{ studentId: 1 }]
    ]
  )
);

export const AnnualResult = tenantModel(
  'AnnualResult',
  tenantSchema(
    {
      sessionId: { ...ref('AcademicSession'), required: true },
      classArmId: { ...ref('ClassArm'), required: true },
      studentId: { ...ref('Student'), required: true },
      subjects: [{ subjectId: ref('Subject'), name: String, t1: Number, t2: Number, t3: Number, average: Number, grade: String, remark: String, _id: false }],
      average: Number,
      position: Number,
      classSize: Number,
      termsCounted: [Number],
      attendancePercent: Number
    },
    [[{ sessionId: 1, studentId: 1 }, { unique: true }], [{ sessionId: 1, classArmId: 1 }]]
  )
);

export const PromotionRule = tenantModel(
  'PromotionRule',
  tenantSchema(
    {
      classLevelId: { ...ref('ClassLevel'), required: true },
      version: { type: Number, required: true },
      active: { type: Boolean, default: true },
      minAnnualAverage: Number,
      mustPassSubjectIds: [ref('Subject')],
      minSubjectsPassed: Number,
      minAttendancePercent: Number,
      trial: { enabled: { type: Boolean, default: false }, minAnnualAverage: Number, maxFailedMustPass: { type: Number, default: 0 } }
    },
    [
      [{ classLevelId: 1, version: 1 }, { unique: true }],
      [{ classLevelId: 1 }, { unique: true, partialFilterExpression: { active: true } }]
    ]
  )
);

export const PromotionList = tenantModel(
  'PromotionList',
  tenantSchema(
    {
      sessionId: { ...ref('AcademicSession'), required: true },
      classArmId: { ...ref('ClassArm'), required: true },
      status: enumStr(PROMOTION_LIST_STATUS, 'proposed'),
      reviewedBy: ref('User'),
      reviewedAt: Date,
      approvedBy: ref('User'),
      approvedAt: Date,
      returnNote: str()
    },
    [[{ sessionId: 1, classArmId: 1 }, { unique: true }]]
  )
);

export const PromotionDecision = tenantModel(
  'PromotionDecision',
  tenantSchema(
    {
      sessionId: { ...ref('AcademicSession'), required: true },
      classArmId: { ...ref('ClassArm'), required: true },
      studentId: { ...ref('Student'), required: true },
      ruleId: ref('PromotionRule'),
      ruleVersion: Number,
      proposed: {
        outcome: enumStr(PROMOTION_OUTCOMES),
        checks: [{ condition: String, required: Number, actual: Number, passed: Boolean, _id: false }]
      },
      final: { outcome: enumStr(PROMOTION_OUTCOMES), by: ref('User'), reason: str(), at: Date },
      note: str() // for example "joined in second term: annual average uses two terms"
    },
    [[{ sessionId: 1, studentId: 1 }, { unique: true }], [{ sessionId: 1, classArmId: 1 }]]
  )
);

/** Rollover runs record what they did so an undo is possible while nothing happened in the new session. */
export const RolloverRun = tenantModel(
  'RolloverRun',
  tenantSchema(
    {
      fromSessionId: { ...ref('AcademicSession'), required: true },
      toSessionId: { ...ref('AcademicSession'), required: true },
      status: enumStr(['done', 'undone'], 'done'),
      armMode: enumStr(['keep', 'manual'], 'keep'),
      moves: [{ studentId: ref('Student'), toLevelId: ref('ClassLevel'), toArmId: ref('ClassArm'), outcome: String, enrolmentId: ref('Enrolment'), _id: false }],
      createdBy: ref('User')
    },
    [[{ fromSessionId: 1 }]]
  )
);
