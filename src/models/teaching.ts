import { tenantModel, tenantSchema } from '../core/tenancy';
import { Mixed, ref, str, enumStr, dateStr } from './_helpers';

export const TASK_TYPES = ['assignment', 'homework', 'project', 'test'] as const;
export const TASK_STATUS = ['draft', 'published', 'closed'] as const;

const fileRef = { ref: str(), name: str(), mime: str(), size: Number };

export const Task = tenantModel(
  'Task',
  tenantSchema(
    {
      termId: { ...ref('Term'), required: true },
      classArmId: { ...ref('ClassArm'), required: true },
      subjectId: { ...ref('Subject'), required: true },
      staffId: { ...ref('Staff'), required: true },
      type: { ...enumStr(TASK_TYPES), required: true },
      title: str({ required: true }),
      instructions: str(),
      attachments: [fileRef],
      dueAt: Date,
      maxScore: { type: Number, default: 10 },
      lateRule: enumStr(['allow', 'allow_flag', 'close'], 'allow_flag'),
      allowResubmit: { type: Boolean, default: true },
      countsTo: str(), // assessment component key
      status: { ...enumStr(TASK_STATUS, 'draft'), index: true },
      publishedAt: Date,
      paper: { type: Boolean, default: false } // scores recorded directly, no online submission
    },
    [[{ termId: 1, classArmId: 1, subjectId: 1 }], [{ staffId: 1, status: 1 }]]
  )
);

export const SUBMISSION_STATUS = ['submitted', 'returned', 'marked'] as const;
export const Submission = tenantModel(
  'Submission',
  tenantSchema(
    {
      taskId: { ...ref('Task'), required: true },
      studentId: { ...ref('Student'), required: true },
      submittedBy: ref('User'), // records who actually submitted (child view)
      submittedByRole: str(),
      text: str(),
      files: [fileRef],
      submittedAt: Date,
      isLate: { type: Boolean, default: false },
      status: enumStr(SUBMISSION_STATUS, 'submitted'),
      score: Number,
      feedback: str(),
      returnNote: str(),
      markedBy: ref('User'),
      markedAt: Date,
      pushed: { type: Boolean, default: false }
    },
    [[{ taskId: 1, studentId: 1 }, { unique: true }], [{ studentId: 1, status: 1 }]]
  )
);

export const AttendanceRegister = tenantModel(
  'AttendanceRegister',
  tenantSchema(
    {
      termId: { ...ref('Term'), required: true },
      classArmId: { ...ref('ClassArm'), required: true },
      date: dateStr({ required: true }),
      part: enumStr(['day', 'am', 'pm'], 'day'),
      takenBy: ref('User'),
      entries: [{ studentId: ref('Student'), status: enumStr(['present', 'absent', 'late', 'excused']), _id: false }],
      unlockedUntil: Date
    },
    [[{ classArmId: 1, date: 1, part: 1 }, { unique: true }], [{ termId: 1, classArmId: 1 }]]
  )
);

/** Holidays inside a term. */
export const NonSchoolDay = tenantModel(
  'NonSchoolDay',
  tenantSchema({ termId: { ...ref('Term'), required: true }, date: dateStr({ required: true }), reason: str() }, [[{ termId: 1, date: 1 }, { unique: true }]])
);

export { Mixed };
