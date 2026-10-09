import { tenantModel, tenantSchema } from '../core/tenancy';
import { Mixed, ref, str, kobo, enumStr, dateStr } from './_helpers';

export const APPLICATION_STATUS = [
  'draft',
  'submitted',
  'under_review',
  'assessment_scheduled',
  'offered',
  'accepted',
  'enrolled',
  'waitlisted',
  'rejected',
  'withdrawn',
  'expired'
] as const;

export const AdmissionSettings = tenantModel(
  'AdmissionSettings',
  tenantSchema(
    {
      sessionId: { ...ref('AcademicSession'), required: true },
      open: { type: Boolean, default: false },
      opensOn: dateStr(),
      closesOn: dateStr(),
      classLevelIds: [ref('ClassLevel')],
      requiredFields: [String], // optional fields the school makes required
      requiredDocuments: [String], // birth_certificate, last_result, passport
      applicationFeeKobo: kobo(),
      offerValidDays: { type: Number, default: 14 },
      consentText: str({
        default:
          'I consent to the school and the platform holding my child’s personal data for admission and academic records, as described in the privacy notice.'
      })
    },
    [[{ sessionId: 1 }, { unique: true }]]
  )
);

const person = {
  firstName: str(),
  middleName: str(),
  lastName: str(),
  dob: dateStr(),
  gender: enumStr(['male', 'female']),
  phone: str(),
  email: str({ lowercase: true }),
  address: str(),
  relationship: str(),
  stateOfOrigin: str(),
  religion: str()
};

export const Application = tenantModel(
  'Application',
  tenantSchema(
    {
      sessionId: { ...ref('AcademicSession'), required: true },
      number: str(), // assigned on submit
      child: person,
      guardian: person,
      classLevelId: ref('ClassLevel'),
      previousSchool: str(),
      documents: [{ kind: String, file: String, name: String, _id: false }],
      consent: { text: str(), at: Date, ip: str() },
      status: { ...enumStr(APPLICATION_STATUS, 'draft'), index: true },
      statusHistory: [{ status: String, at: Date, by: ref('User'), note: String, _id: false }],
      assessment: { kind: enumStr(['test', 'interview']), at: Date, notes: str(), result: str() },
      offer: { classLevelId: ref('ClassLevel'), invoiceId: ref('Invoice'), expiresOn: dateStr(), offeredAt: Date, tokenHash: str() },
      applicationInvoiceId: ref('Invoice'),
      feePaid: { type: Boolean, default: false },
      studentId: ref('Student'),
      draftPhone: str(), // the phone number the draft is tied to (SMS code check)
      submittedAt: Date,
      possibleDuplicate: { type: Boolean, default: false },
      notes: str()
    },
    [
      [{ number: 1 }, { unique: true, partialFilterExpression: { number: { $type: 'string' } } }],
      [{ status: 1 }],
      [{ 'guardian.phone': 1 }],
      [{ draftPhone: 1, status: 1 }],
      [{ 'offer.tokenHash': 1 }]
    ]
  )
);

export { Mixed };
