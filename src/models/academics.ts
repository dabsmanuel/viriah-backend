import { tenantModel, tenantSchema } from '../core/tenancy';
import { ref, str, enumStr, dateStr } from './_helpers';

export const PERIOD_STATUS = ['upcoming', 'current', 'closed'] as const;

/** Academic session (for example 2026/2027). Model name AcademicSession, collection "sessions". */
export const AcademicSession = tenantModel(
  'AcademicSession',
  tenantSchema(
    {
      name: str({ required: true }),
      startDate: dateStr(),
      endDate: dateStr(),
      status: { ...enumStr(PERIOD_STATUS, 'upcoming'), index: true },
      importedOnly: { type: Boolean, default: false } // past sessions created for imported records only
    },
    [[{ name: 1 }, { unique: true }]]
  ),
  'sessions'
);

const termSchema = tenantSchema(
    {
      sessionId: { ...ref('AcademicSession'), required: true },
      number: { type: Number, min: 1, max: 3, required: true },
      startDate: dateStr(),
      endDate: dateStr(),
      nextTermBegins: dateStr(),
      status: { ...enumStr(PERIOD_STATUS, 'upcoming'), index: true },
      closedAt: Date,
      reopenLog: [{ at: Date, by: ref('User'), reason: String, _id: false }]
    },
    [[{ sessionId: 1, number: 1 }, { unique: true }]]
);
// At most one current term per school: partial unique index.
termSchema.index({ schoolId: 1, status: 1 }, { unique: true, partialFilterExpression: { status: 'current' } });
export const Term = tenantModel('Term', termSchema);

export const LevelGroup = tenantModel(
  'LevelGroup',
  tenantSchema(
    {
      name: str({ required: true }), // Nursery, Primary, Junior Secondary, Senior Secondary
      key: enumStr(['nursery', 'primary', 'junior_secondary', 'senior_secondary']),
      order: { type: Number, default: 0 },
      gradingScaleId: ref('GradingScale'),
      assessmentStructureId: ref('AssessmentStructure'),
      reportLayout: enumStr(['scores', 'ratings'], 'scores'),
      showPositions: { type: Boolean, default: true }
    },
    [[{ name: 1 }, { unique: true }]]
  )
);

export const ClassLevel = tenantModel(
  'ClassLevel',
  tenantSchema(
    {
      name: str({ required: true }),
      presetKey: str(), // creche, nursery_1, primary_1 ... so renamed levels still map to presets
      order: { type: Number, default: 0 },
      levelGroupId: { ...ref('LevelGroup'), required: true },
      nextLevelId: ref('ClassLevel'), // the progression map (PRO-07)
      isFinal: { type: Boolean, default: false },
      studentLogin: { type: Boolean, default: false },
      active: { type: Boolean, default: true }
    },
    [[{ name: 1 }, { unique: true }], [{ order: 1 }]]
  )
);

export const ClassArm = tenantModel(
  'ClassArm',
  tenantSchema(
    {
      classLevelId: { ...ref('ClassLevel'), required: true },
      name: str({ required: true }),
      active: { type: Boolean, default: true }
    },
    [[{ classLevelId: 1, name: 1 }, { unique: true }]]
  )
);

export const Subject = tenantModel(
  'Subject',
  tenantSchema({ name: str({ required: true }), shortName: str(), active: { type: Boolean, default: true } }, [[{ name: 1 }, { unique: true }]])
);

export const ClassSubject = tenantModel(
  'ClassSubject',
  tenantSchema(
    {
      classLevelId: { ...ref('ClassLevel'), required: true },
      subjectId: { ...ref('Subject'), required: true },
      compulsory: { type: Boolean, default: true },
      department: enumStr(['science', 'arts', 'commercial'])
    },
    [[{ classLevelId: 1, subjectId: 1 }, { unique: true }]]
  )
);

/** Electives a student offers in a term. Copied forward each term. */
export const StudentSubject = tenantModel(
  'StudentSubject',
  tenantSchema(
    {
      studentId: { ...ref('Student'), required: true },
      termId: { ...ref('Term'), required: true },
      subjectIds: [ref('Subject')]
    },
    [[{ studentId: 1, termId: 1 }, { unique: true }], [{ termId: 1 }]]
  )
);

export const TeachingAssignment = tenantModel(
  'TeachingAssignment',
  tenantSchema(
    {
      sessionId: { ...ref('AcademicSession'), required: true },
      classArmId: { ...ref('ClassArm'), required: true },
      subjectId: ref('Subject'), // absent for a class teacher assignment
      staffId: { ...ref('Staff'), required: true },
      kind: { ...enumStr(['class_teacher', 'subject_teacher']), required: true },
      draft: { type: Boolean, default: false } // copied forward at rollover for the admin to confirm
    },
    [
      [{ sessionId: 1, classArmId: 1, subjectId: 1, kind: 1 }, { unique: true }],
      [{ sessionId: 1, staffId: 1 }]
    ]
  )
);

export const GradingScale = tenantModel(
  'GradingScale',
  tenantSchema(
    {
      name: str({ required: true }),
      passMark: { type: Number, default: 40 },
      bands: [{ min: Number, max: Number, grade: String, remark: String, _id: false }]
    },
    [[{ name: 1 }, { unique: true }]]
  )
);

export const AssessmentStructure = tenantModel(
  'AssessmentStructure',
  tenantSchema(
    {
      name: str({ required: true }),
      components: [{ key: String, name: String, max: Number, order: Number, _id: false }]
    },
    [[{ name: 1 }, { unique: true }]]
  )
);

/** Behaviour and skills ratings, and nursery learning areas. */
export const Trait = tenantModel(
  'Trait',
  tenantSchema(
    {
      levelGroupId: ref('LevelGroup'),
      name: str({ required: true }),
      category: enumStr(['behaviour', 'skill', 'learning_area'], 'behaviour'),
      scale: [{ value: Number, label: String, _id: false }],
      order: { type: Number, default: 0 },
      active: { type: Boolean, default: true }
    },
    [[{ levelGroupId: 1, name: 1 }]]
  )
);

export const CommentBank = tenantModel(
  'CommentBank',
  tenantSchema(
    {
      author: enumStr(['class_teacher', 'principal']),
      minAverage: Number,
      maxAverage: Number,
      text: str({ required: true })
    },
    [[{ author: 1, minAverage: 1 }]]
  )
);
