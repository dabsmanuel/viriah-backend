import { platformModel, platformSchema, tenantModel, tenantSchema } from '../core/tenancy';
import { Mixed, ref, str, enumStr } from './_helpers';

/** Platform-wide: one document per person, identified by phone (unique) and optionally email. Not a tenant collection. */
export const User = platformModel(
  'User',
  platformSchema(
    {
      firstName: str(),
      lastName: str(),
      phone: str(),
      email: str({ lowercase: true }),
      passwordHash: { type: String, select: false },
      mustChangePassword: { type: Boolean, default: false },
      tempPasswordExpiresAt: Date,
      twoFactor: {
        type: { type: String, enum: ['totp', 'sms'] },
        secret: { type: String, select: false },
        pendingSecret: { type: String, select: false },
        recoveryHashes: { type: [String], select: false },
        enabledAt: Date
      },
      platformRole: enumStr(['super_admin', 'support', 'finance']),
      status: enumStr(['active', 'deactivated'], 'active'),
      failedLogins: { type: Number, default: 0 },
      lockedUntil: Date,
      lockoutLog: [Date], // repeated lockouts alert the school admin
      lastLoginAt: Date,
      privacyAcceptedAt: Date,
      emailVerifiedAt: Date,
      phoneVerifiedAt: Date
    },
    [
      [{ phone: 1 }, { unique: true, partialFilterExpression: { phone: { $type: 'string' } } }],
      [{ email: 1 }, { unique: true, partialFilterExpression: { email: { $type: 'string' } } }]
    ]
  )
);

export const MEMBERSHIP_KINDS = ['staff', 'guardian', 'student'] as const;

/**
 * Links a user to a school with roles, and to the staff, guardian or student record they are in that school.
 * A person can hold one membership per kind in a school, so a teacher who is also a parent has two
 * (and sees a role switcher). Staff reach never extends to their own child's record.
 */
export const Membership = platformModel(
  'Membership',
  platformSchema(
    {
      userId: { ...ref('User'), required: true },
      schoolId: { ...ref('School'), required: true },
      kind: { ...enumStr(MEMBERSHIP_KINDS), required: true },
      roles: [String],
      extraPermissions: [String],
      status: enumStr(['invited', 'active', 'deactivated'], 'active'),
      staffId: ref('Staff'),
      guardianId: ref('Guardian'),
      studentId: ref('Student'),
      permVersion: { type: Number, default: 1 },
      invitedAt: Date,
      acceptedAt: Date,
      privacyAcceptedAt: Date
    },
    [
      [{ userId: 1, schoolId: 1, kind: 1 }, { unique: true }],
      [{ schoolId: 1, status: 1 }],
      [{ studentId: 1 }],
      [{ guardianId: 1 }],
      [{ staffId: 1 }]
    ]
  )
);

/** Login sessions with rotating refresh tokens. Named authSessions to avoid clashing with academic sessions. */
export const AuthSession = platformModel(
  'AuthSession',
  platformSchema(
    {
      userId: { ...ref('User'), required: true },
      membershipId: ref('Membership'),
      schoolId: ref('School'),
      refreshHash: str({ required: true }),
      previousHashes: [String], // reuse of an old token revokes the whole chain
      chainId: str({ required: true }),
      userAgent: str(),
      ip: str(),
      support: { type: Boolean, default: false },
      lastConfirmedAt: { type: Date, default: Date.now }, // password re-entry for sensitive actions
      lastUsedAt: { type: Date, default: Date.now },
      expiresAt: { type: Date, required: true },
      revokedAt: Date
    },
    [[{ refreshHash: 1 }], [{ previousHashes: 1 }], [{ chainId: 1 }], [{ userId: 1, revokedAt: 1 }], [{ expiresAt: 1 }, { expireAfterSeconds: 0 }]]
  )
);

/** One-time codes. Stored hashed. TTL on expiresAt. */
export const Otp = platformModel(
  'Otp',
  platformSchema(
    {
      target: str({ required: true }), // phone, email, or userId for two step
      purpose: str({ required: true }),
      codeHash: str({ required: true }),
      attempts: { type: Number, default: 0 },
      data: Mixed,
      expiresAt: { type: Date, required: true },
      consumedAt: Date
    },
    [[{ target: 1, purpose: 1, createdAt: -1 }], [{ expiresAt: 1 }, { expireAfterSeconds: 0 }]]
  )
);

export const Invite = tenantModel(
  'Invite',
  tenantSchema(
    {
      phone: str(),
      email: str({ lowercase: true }),
      roles: [String],
      staffId: ref('Staff'),
      tokenHash: str({ required: true }),
      expiresAt: { type: Date, required: true },
      acceptedAt: Date
    },
    [[{ phone: 1 }], [{ tokenHash: 1 }, { unique: true, noPrefix: true }], [{ expiresAt: 1 }, { expireAfterSeconds: 60 * 60 * 24 * 30, noPrefix: true }]]
  )
);

export { Mixed };
