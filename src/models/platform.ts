import { platformModel, platformSchema, tenantModel, tenantSchema } from '../core/tenancy';
import { OID, Mixed, ref, str, kobo, enumStr } from './_helpers';

export const SCHOOL_STATUS = ['pending', 'active', 'suspended', 'rejected', 'closed'] as const;
export const SCHOOL_TYPES = ['nursery', 'primary', 'secondary'] as const;

/** Not a tenant collection. One document per school. */
export const School = platformModel(
  'School',
  platformSchema(
    {
      name: str({ required: true }),
      slug: str({ required: true, lowercase: true }),
      types: [enumStr(SCHOOL_TYPES)],
      address: { street: str(), town: str(), lga: str(), state: str() },
      phone: str(),
      email: str({ lowercase: true }),
      motto: str(),
      registrationNumber: str(), // government approval or CAC number (optional)
      status: { ...enumStr(SCHOOL_STATUS, 'pending'), index: true },
      statusReason: str(),
      statusHistory: [{ status: String, at: Date, by: OID, reason: String, _id: false }],
      resubmissions: { type: Number, default: 0 },
      ownerUserId: ref('User'),
      createdVia: enumStr(['self', 'assisted'], 'self'),
      possibleDuplicate: { type: Boolean, default: false },
      branding: {
        logo: str(),
        primary: str({ default: '#1d4ed8' }),
        secondary: str({ default: '#0f766e' }),
        favicon: str(),
        stamp: str(),
        signature: str()
      },
      settings: {
        admissionNumberFormat: str({ default: 'ADM/{YY}/{SEQ:4}' }),
        receiptPrefix: str({ default: 'RCT' }),
        positionScope: enumStr(['arm', 'level'], 'arm'),
        annualMethod: enumStr(['mean_of_terms', 'third_term_only'], 'mean_of_terms'),
        resultBlock: { enabled: { type: Boolean, default: false }, thresholdKobo: kobo() },
        partPayment: { enabled: { type: Boolean, default: true }, minPercent: { type: Number, default: 0 } },
        chargeBearer: enumStr(['parent', 'school'], 'parent'),
        allowEnrolBeforePayment: { type: Boolean, default: false },
        absenceSms: { type: Boolean, default: false },
        registerSessions: enumStr(['day', 'am_pm'], 'day'),
        rollbackDays: { type: Number, default: 14 },
        showFeesToStudents: { type: Boolean, default: false },
        parentAccessEndsAfterDays: { type: Number, default: 0 },
        reminderSchedule: {
          enabled: { type: Boolean, default: false },
          everyDays: { type: Number, default: 7 },
          sms: { type: Boolean, default: false },
          email: { type: Boolean, default: false },
          lastRunOn: str()
        },
        showFeesOnWebsite: { type: Boolean, default: false }
      },
      paystack: { subaccountCode: str(), bankCode: str(), accountLast4: str(), accountName: str(), bankName: str() },
      commission: { type: enumStr(['none', 'flat', 'percent'], 'none'), value: { type: Number, default: 0 } },
      plan: { name: str({ default: 'pilot' }), status: enumStr(['trial', 'active', 'past_due', 'cancelled'], 'trial'), renewsOn: str() },
      setupProgress: { type: Mixed, default: {} },
      dpaAcceptedAt: Date,
      termsAcceptedAt: Date,
      notes: str(),
      lastActivityAt: Date,
      closedAt: Date
    },
    [[{ slug: 1 }, { unique: true }], [{ status: 1, createdAt: -1 }], [{ name: 'text', slug: 'text' }], [{ 'address.state': 1 }], [{ ownerUserId: 1 }]]
  )
);

/** P2: a school's own domain. */
export const Domain = platformModel(
  'Domain',
  platformSchema(
    { schoolId: { ...ref('School'), required: true }, host: str({ required: true, lowercase: true }), verifiedAt: Date, dnsToken: str() },
    [[{ host: 1 }, { unique: true }]]
  )
);

/** Platform-owned starting data that schools copy. */
export const PRESET_KINDS = [
  'class_levels',
  'subjects',
  'grading_scales',
  'assessment_structures',
  'report_layouts',
  'behaviour_traits',
  'fee_items',
  'comment_bank'
] as const;
export const Preset = platformModel(
  'Preset',
  platformSchema(
    { kind: enumStr(PRESET_KINDS), name: str({ required: true }), data: Mixed, active: { type: Boolean, default: true }, order: { type: Number, default: 0 } },
    [[{ kind: 1, order: 1 }]]
  )
);

export const TemplateVersion = platformModel(
  'TemplateVersion',
  platformSchema(
    { version: { type: Number, required: true }, notes: str(), releasedAt: Date, isCurrent: { type: Boolean, default: false } },
    [[{ version: 1 }, { unique: true }]]
  )
);

/** Single document. */
export const PlatformSetting = platformModel(
  'PlatformSetting',
  platformSchema({
    key: { type: String, default: 'platform', unique: true },
    defaultCommission: { type: { type: String, enum: ['none', 'flat', 'percent'], default: 'none' }, value: { type: Number, default: 0 } },
    // Paystack rates live here, not in code, because the provider can change them.
    paymentRates: {
      percent: { type: Number, default: 1.5 },
      flatKobo: { type: Number, default: 10000 },
      flatWaivedBelowKobo: { type: Number, default: 250000 },
      capKobo: { type: Number, default: 200000 }
    },
    smsUnitPriceKobo: { type: Number, default: 500 },
    reservedSlugs: [String],
    legalTexts: { terms: String, privacy: String, dpa: String, consent: String, refundPolicy: String, contentRules: String },
    superAdminSecurity: { requireTwoStep: { type: Boolean, default: true } }
  })
);

/** Append only. The application has no update or delete path (NFR-09). */
const auditSchema = platformSchema(
  {
    schoolId: ref('School'),
    actorUserId: ref('User'),
    actorRoles: [String],
    supportSession: { type: Boolean, default: false },
    action: str({ required: true }),
    entityType: str(),
    entityId: str(),
    before: Mixed,
    after: Mixed,
    reason: str(),
    ip: str(),
    requestId: str(),
    at: { type: Date, default: Date.now }
  },
  [[{ schoolId: 1, at: -1 }], [{ entityType: 1, entityId: 1 }], [{ action: 1, at: -1 }], [{ actorUserId: 1, at: -1 }]]
);
const refuseAuditChange = () => {
  throw new Error('Audit records are append only.');
};
auditSchema.pre(
  ['updateOne', 'updateMany', 'findOneAndUpdate', 'findOneAndReplace', 'replaceOne', 'deleteOne', 'deleteMany', 'findOneAndDelete'] as any,
  refuseAuditChange
);
auditSchema.pre('save', function () {
  if (!this.isNew) refuseAuditChange();
});
export const AuditLog = platformModel('AuditLog', auditSchema);

export const WebhookEvent = platformModel(
  'WebhookEvent',
  platformSchema(
    {
      provider: str({ required: true }),
      eventKey: str({ required: true }),
      type: str(),
      payload: Mixed,
      status: enumStr(['received', 'queued', 'processed', 'failed', 'ignored'], 'received'),
      processedAt: Date,
      error: str()
    },
    [[{ provider: 1, eventKey: 1 }, { unique: true }]]
  )
);

/** Job status for polling (GET /jobs/{id}) and the super admin failed jobs view. */
export const Job = platformModel(
  'Job',
  platformSchema(
    {
      kind: str({ required: true }),
      schoolId: ref('School'),
      payload: Mixed,
      status: { ...enumStr(['queued', 'running', 'done', 'failed'], 'queued'), index: true },
      progress: { type: Number, default: 0 },
      attempts: { type: Number, default: 0 },
      result: Mixed,
      error: str(),
      startedAt: Date,
      finishedAt: Date,
      userId: ref('User'),
      uniqueKey: str() // optional: makes a job safe to enqueue twice
    },
    [
      [{ status: 1, createdAt: -1 }],
      [{ uniqueKey: 1 }, { unique: true, partialFilterExpression: { uniqueKey: { $type: 'string' } } }],
      [{ createdAt: 1 }, { expireAfterSeconds: 60 * 60 * 24 * 30 }]
    ]
  )
);

/** Safe retries: the server stores the key with the response for 24 hours (API 1.7). */
export const IdempotencyKey = platformModel(
  'IdempotencyKey',
  platformSchema(
    {
      scope: str({ required: true }),
      key: str({ required: true }),
      route: str({ required: true }),
      bodyHash: str({ required: true }),
      state: enumStr(['processing', 'done'], 'processing'),
      response: { status: Number, body: Mixed },
      expiresAt: { type: Date, required: true }
    },
    [[{ scope: 1, key: 1, route: 1 }, { unique: true }], [{ expiresAt: 1 }, { expireAfterSeconds: 0 }]]
  )
);

/** Per-school atomic sequences: receipt, invoice, admission and application numbers. */
export const Counter = tenantModel(
  'Counter',
  tenantSchema({ key: str({ required: true }), seq: { type: Number, default: 0 } }, [[{ key: 1 }, { unique: true }]])
);
