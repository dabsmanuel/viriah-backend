import { tenantModel, tenantSchema } from '../core/tenancy';
import { Mixed, ref, str, enumStr, dateStr } from './_helpers';

export const STUDENT_STATUS = ['active', 'suspended', 'withdrawn', 'transferred', 'graduated'] as const;

export const Staff = tenantModel(
  'Staff',
  tenantSchema(
    {
      userId: ref('User'),
      firstName: str({ required: true }),
      lastName: str({ required: true }),
      phone: str({ required: true }),
      email: str({ lowercase: true }),
      photo: str(),
      roles: [String],
      qualifications: str(),
      employedOn: dateStr(),
      status: enumStr(['invited', 'active', 'deactivated'], 'active'),
      importBatchId: ref('ImportBatch')
    },
    [[{ phone: 1 }, { unique: true }], [{ status: 1 }], [{ userId: 1 }]]
  )
);

export const Student = tenantModel(
  'Student',
  tenantSchema(
    {
      admissionNumber: str({ required: true }),
      firstName: str({ required: true }),
      middleName: str(),
      lastName: str({ required: true }),
      dob: dateStr({ required: true }),
      gender: enumStr(['male', 'female'], 'male'),
      photo: str(),
      address: str(),
      stateOfOrigin: str(),
      religion: str(),
      medical: { notes: str(), allergies: str(), emergencyName: str(), emergencyPhone: str() },
      status: { ...enumStr(STUDENT_STATUS, 'active'), index: true },
      statusHistory: [{ status: String, at: Date, date: String, reason: String, by: ref('User'), _id: false }],
      admittedOn: dateStr(),
      currentEnrolmentId: ref('Enrolment'),
      userId: ref('User'),
      importBatchId: ref('ImportBatch'),
      applicationId: ref('Application'),
      consentOnFile: { type: Boolean, default: false },
      consent: { text: str(), at: Date, ip: str(), source: enumStr(['application', 'paper', 'import']) },
      alumni: { type: Boolean, default: false }
    },
    [[{ admissionNumber: 1 }, { unique: true }], [{ lastName: 1, firstName: 1 }], [{ status: 1 }], [{ importBatchId: 1 }], [{ dob: 1, firstName: 1 }]]
  )
);

export const Guardian = tenantModel(
  'Guardian',
  tenantSchema(
    {
      userId: ref('User'),
      firstName: str({ required: true }),
      lastName: str({ required: true }),
      phone: str({ required: true }),
      email: str({ lowercase: true }),
      address: str(),
      occupation: str(),
      importBatchId: ref('ImportBatch'),
      lastInvitedAt: Date
    },
    [[{ phone: 1 }, { unique: true }], [{ userId: 1 }]]
  )
);

export const StudentGuardian = tenantModel(
  'StudentGuardian',
  tenantSchema(
    {
      studentId: { ...ref('Student'), required: true },
      guardianId: { ...ref('Guardian'), required: true },
      relationship: str({ default: 'parent' }),
      isPrimary: { type: Boolean, default: false },
      isFeePayer: { type: Boolean, default: false },
      access: enumStr(['full', 'view', 'none'], 'full'),
      accessReason: str(),
      importBatchId: ref('ImportBatch')
    },
    [[{ studentId: 1, guardianId: 1 }, { unique: true }], [{ guardianId: 1 }]]
  )
);

/** The class and arm a student was in for each session, kept permanently. */
export const Enrolment = tenantModel(
  'Enrolment',
  tenantSchema(
    {
      studentId: { ...ref('Student'), required: true },
      sessionId: { ...ref('AcademicSession'), required: true },
      classLevelId: { ...ref('ClassLevel'), required: true },
      classArmId: { ...ref('ClassArm'), required: true },
      from: dateStr(),
      to: dateStr(),
      outcome: enumStr(['promoted', 'promoted_on_trial', 'repeat', 'graduated', 'left']),
      imported: { type: Boolean, default: false }
    },
    [[{ studentId: 1, sessionId: 1 }, { unique: true }], [{ sessionId: 1, classArmId: 1 }], [{ sessionId: 1, classLevelId: 1 }]]
  )
);

export const StudentDocument = tenantModel(
  'Document',
  tenantSchema(
    {
      ownerType: enumStr(['student', 'application', 'staff'], 'student'),
      ownerId: { ...ref('Student'), required: true },
      title: str({ required: true }),
      file: str({ required: true }),
      mime: str(),
      visibleToGuardian: { type: Boolean, default: false },
      uploadedBy: ref('User')
    },
    [[{ ownerType: 1, ownerId: 1 }]]
  )
);

/** Contact detail changes a parent or student asks for (POR-06). */
export const ChangeRequest = tenantModel(
  'ChangeRequest',
  tenantSchema(
    {
      userId: { ...ref('User'), required: true },
      target: enumStr(['guardian', 'student']),
      targetId: ref('Guardian'),
      changes: Mixed,
      status: enumStr(['pending', 'approved', 'declined'], 'pending'),
      decidedBy: ref('User'),
      decidedAt: Date,
      reason: str()
    },
    [[{ status: 1 }], [{ userId: 1 }]]
  )
);
