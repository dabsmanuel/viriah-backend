import { platformModel, platformSchema, tenantModel, tenantSchema } from '../core/tenancy';
import { Mixed, ref, str, enumStr } from './_helpers';

export const SITE_STATUS = ['draft', 'published', 'unpublished', 'taken_down'] as const;

export const Site = tenantModel(
  'Site',
  tenantSchema(
    {
      status: enumStr(SITE_STATUS, 'draft'),
      templateVersion: { type: Number, default: 1 },
      draft: { type: Mixed, default: {} },
      published: { type: Mixed, default: null },
      publishedAt: Date,
      publishedBy: ref('User'),
      takedown: { reason: str(), by: ref('User'), at: Date }
    },
    [[{}, { unique: true }]]
  )
);

export const Post = tenantModel(
  'Post',
  tenantSchema(
    {
      kind: enumStr(['news', 'event'], 'news'),
      title: str({ required: true }),
      body: str(),
      image: str(),
      eventDate: str(),
      published: { type: Boolean, default: false }
    },
    [[{ published: 1, createdAt: -1 }]]
  )
);

export const GalleryItem = tenantModel(
  'GalleryItem',
  tenantSchema({ image: str({ required: true }), caption: str(), order: { type: Number, default: 0 } }, [[{ order: 1 }]])
);

export const Enquiry = tenantModel(
  'Enquiry',
  tenantSchema(
    { name: str({ required: true }), phone: str(), email: str(), message: str({ required: true }), status: enumStr(['new', 'read', 'handled'], 'new'), ip: str() },
    [[{ status: 1, createdAt: -1 }]]
  )
);

export const Announcement = tenantModel(
  'Announcement',
  tenantSchema(
    {
      title: str({ required: true }),
      body: str({ required: true }),
      audience: { roles: [String], classArmIds: [ref('ClassArm')], all: { type: Boolean, default: false } },
      channels: [enumStr(['in_app', 'sms', 'email'])],
      sentBy: ref('User'),
      sentAt: Date,
      counts: { recipients: Number, sms: Number, email: Number, inApp: Number, smsUnits: Number, skipped: Number }
    },
    [[{ sentAt: -1 }]]
  )
);

export const Notification = tenantModel(
  'Notification',
  tenantSchema(
    { userId: { ...ref('User'), required: true }, type: str(), title: str(), body: str(), link: str(), readAt: Date },
    [[{ userId: 1, readAt: 1, createdAt: -1 }]]
  )
);

export const NotificationPref = tenantModel(
  'NotificationPref',
  tenantSchema({ userId: { ...ref('User'), required: true }, prefs: { type: Mixed, default: {} } }, [[{ userId: 1 }, { unique: true }]])
);

/** schoolId null is the platform default, so this is not a strict tenant model. */
export const MessageTemplate = platformModel(
  'MessageTemplate',
  platformSchema(
    { schoolId: ref('School'), key: str({ required: true }), channel: enumStr(['sms', 'email', 'in_app'], 'sms'), subject: str(), body: str({ required: true }) },
    [[{ schoolId: 1, key: 1, channel: 1 }, { unique: true }]]
  )
);

export const MessageLog = tenantModel(
  'MessageLog',
  tenantSchema(
    {
      channel: enumStr(['sms', 'email']),
      to: str(),
      templateKey: str(),
      status: enumStr(['queued', 'sent', 'delivered', 'failed', 'skipped'], 'queued'),
      providerRef: str(),
      units: { type: Number, default: 0 },
      error: str(),
      essential: { type: Boolean, default: false }
    },
    [[{ createdAt: -1 }], [{ providerRef: 1 }]]
  )
);

export const SmsWallet = tenantModel(
  'SmsWallet',
  tenantSchema({ units: { type: Number, default: 0 }, lowBalanceAlertOn: str() }, [[{}, { unique: true }]])
);

export const SmsLedger = tenantModel(
  'SmsLedger',
  tenantSchema({ delta: { type: Number, required: true }, reason: str(), ref: str(), balanceAfter: Number }, [[{ createdAt: -1 }], [{ ref: 1 }]])
);

export const ImportBatch = tenantModel(
  'ImportBatch',
  tenantSchema(
    {
      kind: enumStr(['students', 'staff', 'past_results', 'opening_balances', 'scores']),
      file: str(),
      status: enumStr(['validating', 'ready', 'committed', 'rolled_back', 'failed'], 'validating'),
      counts: { total: Number, ready: Number, errors: Number, duplicates: Number, committed: Number },
      rows: { type: Mixed, default: [] }, // parsed rows with their validation outcome
      issues: [{ row: Number, field: String, message: String, _id: false }],
      options: Mixed,
      createdIds: { type: Mixed, default: {} },
      committedAt: Date,
      rolledBackAt: Date,
      createdBy: ref('User')
    },
    [[{ createdAt: -1 }], [{ status: 1 }]]
  )
);

export const ExportJob = tenantModel(
  'ExportJob',
  tenantSchema(
    { kind: str({ default: 'full' }), status: enumStr(['queued', 'running', 'ready', 'failed', 'expired'], 'queued'), file: str(), requestedBy: ref('User'), expiresAt: Date },
    [[{ createdAt: -1 }]]
  )
);
