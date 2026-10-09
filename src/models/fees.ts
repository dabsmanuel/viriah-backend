import { tenantModel, tenantSchema } from '../core/tenancy';
import { Mixed, ref, str, kobo, enumStr, dateStr } from './_helpers';

export const INVOICE_STATUS = ['draft', 'issued', 'part_paid', 'paid', 'void'] as const;
export const INVOICE_KINDS = ['term', 'admission', 'application', 'opening_balance', 'single'] as const;
export const PAYMENT_STATUS = ['initiated', 'successful', 'failed', 'abandoned', 'pending_confirmation', 'rejected', 'reversed', 'refunded'] as const;
export const PAYMENT_CHANNELS = ['paystack', 'cash', 'bank', 'pos', 'transfer', 'credit'] as const;

export const FeeItem = tenantModel(
  'FeeItem',
  tenantSchema({ name: str({ required: true }), optional: { type: Boolean, default: false }, active: { type: Boolean, default: true } }, [[{ name: 1 }, { unique: true }]])
);

export const FeeStructure = tenantModel(
  'FeeStructure',
  tenantSchema(
    {
      termId: { ...ref('Term'), required: true },
      classLevelId: { ...ref('ClassLevel'), required: true },
      lines: [{ feeItemId: ref('FeeItem'), amountKobo: kobo(), _id: false }]
    },
    [[{ termId: 1, classLevelId: 1 }, { unique: true }]]
  )
);

const invoiceSchema = tenantSchema(
    {
      number: str({ required: true }),
      studentId: ref('Student'),
      termId: ref('Term'),
      kind: { ...enumStr(INVOICE_KINDS, 'term'), required: true },
      lines: [{ feeItemId: ref('FeeItem'), label: String, amountKobo: kobo(), optional: Boolean, _id: false }],
      discounts: [{ label: String, amountKobo: kobo(), approvalId: ref('Approval'), _id: false }],
      adjustments: [{ label: String, amountKobo: Number, at: Date, by: ref('User'), _id: false }], // explicit lines on regenerated invoices
      totalKobo: kobo(),
      paidKobo: kobo(),
      balanceKobo: kobo(),
      dueOn: dateStr(),
      status: { ...enumStr(INVOICE_STATUS, 'issued'), index: true },
      applicationId: ref('Application'),
      payerName: str(),
      payerPhone: str(),
      importBatchId: ref('ImportBatch'),
      issuedAt: Date,
      voidedAt: Date,
      voidReason: str()
    },
    [
      [{ number: 1 }, { unique: true }],
      [{ studentId: 1 }],
      [{ termId: 1, status: 1 }],
      [{ applicationId: 1 }]
    ]
);
// One live term invoice per student per term: generating twice creates none.
invoiceSchema.index({ schoolId: 1, studentId: 1, termId: 1 }, { unique: true, partialFilterExpression: { kind: 'term', status: { $in: ['draft', 'issued', 'part_paid', 'paid'] } } });
export const Invoice = tenantModel('Invoice', invoiceSchema);

export const Payment = tenantModel(
  'Payment',
  tenantSchema(
    {
      reference: str({ required: true }),
      channel: { ...enumStr(PAYMENT_CHANNELS), required: true },
      status: { ...enumStr(PAYMENT_STATUS, 'initiated'), index: true },
      amountKobo: kobo(), // what the invoices were credited with
      chargeKobo: kobo(), // payment charge added when the parent bears it
      commissionKobo: kobo(),
      requestedTotalKobo: kobo(), // total the checkout asked Paystack for
      payerGuardianId: ref('Guardian'),
      payerName: str(),
      applicationId: ref('Application'),
      allocations: [{ invoiceId: ref('Invoice'), studentId: ref('Student'), amountKobo: kobo(), _id: false }],
      provider: { id: str(), channel: str(), paidAt: Date, fees: Number, receivedKobo: Number },
      proofFile: str(),
      bankReference: str(),
      paidOn: dateStr(),
      note: str(),
      recordedBy: ref('User'),
      confirmedBy: ref('User'),
      rejectReason: str(),
      flagged: { type: Boolean, default: false },
      flagReason: str(),
      reversal: { approvalId: ref('Approval'), at: Date, reason: str(), kind: enumStr(['reversal', 'refund']) },
      idempotencyKey: str(),
      purpose: enumStr(['fees', 'application', 'offer', 'sms_units'], 'fees')
    },
    [
      [{ reference: 1 }, { unique: true, noPrefix: true }],
      [{ status: 1, createdAt: -1 }],
      [{ bankReference: 1 }],
      [{ 'allocations.invoiceId': 1 }],
      [{ 'allocations.studentId': 1 }]
    ]
  )
);

export const Receipt = tenantModel(
  'Receipt',
  tenantSchema(
    {
      number: str({ required: true }),
      paymentId: { ...ref('Payment'), required: true },
      studentId: ref('Student'),
      payerName: str(),
      amountKobo: kobo(),
      balanceAfterKobo: kobo(),
      method: str(),
      paidOn: str(),
      lines: [{ invoiceNumber: String, label: String, amountKobo: kobo(), _id: false }],
      verificationCode: str({ required: true }),
      file: str(),
      voidedAt: Date
    },
    [[{ number: 1 }, { unique: true }], [{ verificationCode: 1 }, { unique: true, noPrefix: true }], [{ paymentId: 1 }], [{ studentId: 1 }]]
  )
);

/** Overpayments held for the next invoice. */
export const Credit = tenantModel(
  'Credit',
  tenantSchema(
    {
      studentId: { ...ref('Student'), required: true },
      amountKobo: kobo(),
      sourcePaymentId: ref('Payment'),
      appliedInvoiceId: ref('Invoice'),
      appliedAt: Date
    },
    [[{ studentId: 1, appliedInvoiceId: 1 }]]
  )
);

/** Discounts, reversals, refunds, results, promotion lists and contact changes all wait here for a second person. */
export const APPROVAL_TYPES = ['discount', 'reversal', 'refund', 'results', 'promotion', 'contact_change'] as const;
export const Approval = tenantModel(
  'Approval',
  tenantSchema(
    {
      type: { ...enumStr(APPROVAL_TYPES), required: true },
      payload: Mixed,
      summary: str(),
      requestedBy: ref('User'),
      status: enumStr(['pending', 'approved', 'declined'], 'pending'),
      decidedBy: ref('User'),
      decidedAt: Date,
      reason: str(),
      decisionNote: str()
    },
    [[{ status: 1, type: 1 }]]
  )
);
