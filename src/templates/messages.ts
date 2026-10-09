/**
 * Default message texts, with named placeholders like {{name}}. A school can edit its own copy of the optional ones.
 * Plain words, short sentences, no em dashes, no hype (Document 1, section 8.3).
 */

export const PLATFORM_NAME = 'Viriah';

export type EventKey =
  | 'login_code'
  | 'signup_received'
  | 'school_decision'
  | 'staff_invite'
  | 'application_received'
  | 'application_status'
  | 'offer_made'
  | 'enrolled'
  | 'invoice_issued'
  | 'payment_success'
  | 'proof_uploaded'
  | 'proof_decided'
  | 'fee_reminder'
  | 'child_absent'
  | 'task_published'
  | 'work_marked'
  | 'sheet_returned'
  | 'result_awaiting_approval'
  | 'results_published'
  | 'result_revised'
  | 'approval_event'
  | 'announcement'
  | 'bank_changed'
  | 'password_changed'
  | 'school_status'
  | 'low_sms_units'
  | 'contact_change'
  | 'enquiry_received'
  | 'parent_access_ended'
  | 'temp_password';

export interface Template {
  sms?: string;
  emailSubject?: string;
  email?: string;
  inAppTitle?: string;
  inApp?: string;
  /** placeholders that must stay in an edited copy */
  required?: string[];
}

export const DEFAULT_TEMPLATES: Record<EventKey, Template> = {
  login_code: {
    sms: `Your ${PLATFORM_NAME} code is {{code}}. It works for 10 minutes. Do not share it.`,
    emailSubject: `Your ${PLATFORM_NAME} code`,
    email: 'Your code is {{code}}. It works for 10 minutes. If you did not ask for it, ignore this message.',
    required: ['code']
  },
  signup_received: {
    sms: 'We received the sign-up for {{school}}. We will check the details and tell you when it is approved.',
    emailSubject: 'We received your school sign-up',
    email: 'We received the sign-up for {{school}}. You can start the setup checklist now. We will tell you when the school is approved.',
    inAppTitle: 'New school sign-up',
    inApp: '{{school}} signed up and is waiting for approval.'
  },
  school_decision: {
    sms: '{{school}}: {{decision}}. {{note}}',
    emailSubject: '{{school}}: {{decision}}',
    email: '{{school}}: {{decision}}.\n{{note}}',
    inAppTitle: 'School {{decision}}',
    inApp: '{{note}}'
  },
  staff_invite: {
    sms: '{{school}} added you as {{role}}. Set your password here: {{link}} The link works for 72 hours.',
    emailSubject: 'You are invited to {{school}}',
    email: '{{school}} added you as {{role}}.\nSet your password: {{link}}\nThe link works for 72 hours.',
    required: ['link']
  },
  application_received: {
    sms: '{{school}}: we received the application for {{child}}. Your application number is {{number}}.',
    emailSubject: 'Application received: {{number}}',
    email: '{{school}} received the application for {{child}}.\nApplication number: {{number}}\nCheck the status on the school website with this number and your phone number.',
    inAppTitle: 'New application',
    inApp: '{{child}} applied for {{class}}. Number {{number}}.'
  },
  application_status: {
    sms: '{{school}}: the application {{number}} for {{child}} is now {{status}}. {{note}}',
    emailSubject: 'Application {{number}}: {{status}}',
    email: 'The application {{number}} for {{child}} is now {{status}}.\n{{note}}'
  },
  offer_made: {
    sms: '{{school}} offered {{child}} a place in {{class}}. Pay {{amount}} to accept: {{link}} Offer ends {{expires}}.',
    emailSubject: 'Offer of a place for {{child}}',
    email: '{{school}} offered {{child}} a place in {{class}}.\nPay {{amount}} to accept: {{link}}\nThe offer ends {{expires}}.'
  },
  enrolled: {
    sms: '{{school}}: {{child}} is enrolled. Sign in at {{link}} with {{login}} and the temporary password {{password}}. You will be asked to change it.',
    emailSubject: '{{child}} is enrolled at {{school}}',
    email: '{{child}} is enrolled at {{school}}.\nSign in at {{link}}\nLogin: {{login}}\nTemporary password: {{password}}\nYou will be asked to change it.'
  },
  invoice_issued: {
    sms: '{{school}}: the {{term}} invoice for {{child}} is {{amount}}. Pay at {{link}}',
    emailSubject: 'Invoice for {{child}}',
    email: 'The {{term}} invoice for {{child}} is {{amount}}.\nPay at {{link}}',
    inAppTitle: 'Invoice ready',
    inApp: '{{child}}: {{amount}} for {{term}}.'
  },
  payment_success: {
    sms: '{{school}}: we received {{amount}} for {{child}}. Receipt {{receipt}}. {{link}}',
    emailSubject: 'Receipt {{receipt}}',
    email: '{{school}} received {{amount}} for {{child}}.\nReceipt number: {{receipt}}\nDownload it here: {{link}}',
    inAppTitle: 'Payment received',
    inApp: '{{amount}} for {{child}}. Receipt {{receipt}}.'
  },
  proof_uploaded: { inAppTitle: 'Proof of payment to confirm', inApp: '{{parent}} uploaded proof for {{child}}: {{amount}}.' },
  proof_decided: {
    sms: '{{school}}: your proof of payment for {{child}} was {{decision}}. {{note}}',
    emailSubject: 'Proof of payment {{decision}}',
    email: 'Your proof of payment for {{child}} was {{decision}}.\n{{note}}',
    inAppTitle: 'Proof of payment {{decision}}',
    inApp: '{{child}}: {{note}}'
  },
  fee_reminder: {
    sms: '{{school}}: {{child}} has {{amount}} unpaid. Pay at {{link}}',
    emailSubject: 'Fee reminder for {{child}}',
    email: '{{child}} has {{amount}} unpaid at {{school}}.\nPay at {{link}}',
    inAppTitle: 'Fees due',
    inApp: '{{child}}: {{amount}} unpaid.'
  },
  child_absent: {
    sms: '{{school}}: {{child}} was marked absent today.',
    inAppTitle: 'Marked absent',
    inApp: '{{child}} was marked absent today.'
  },
  task_published: { inAppTitle: 'New {{type}}: {{title}}', inApp: '{{subject}}. Due {{due}}.' },
  work_marked: { inAppTitle: 'Work marked', inApp: '{{title}}: {{score}}. {{feedback}}' },
  sheet_returned: { inAppTitle: 'Score sheet returned', inApp: '{{subject}} for {{class}}: {{note}}' },
  result_awaiting_approval: {
    emailSubject: 'Class result waiting: {{class}}',
    email: 'The result for {{class}} is waiting for your approval.',
    inAppTitle: 'Result waiting for approval',
    inApp: '{{class}} is waiting for approval.'
  },
  results_published: {
    sms: '{{school}}: the {{term}} result for {{child}} is ready. {{link}}',
    emailSubject: '{{term}} result for {{child}}',
    email: 'The {{term}} result for {{child}} is ready.\nOpen it here: {{link}}',
    inAppTitle: 'Result ready',
    inApp: 'The {{term}} result for {{child}} is ready.'
  },
  result_revised: {
    sms: '{{school}}: the {{term}} result for {{child}} was revised. {{link}}',
    emailSubject: 'Revised {{term}} result for {{child}}',
    email: 'The {{term}} result for {{child}} was revised.\nOpen it here: {{link}}',
    inAppTitle: 'Result revised',
    inApp: 'The {{term}} result for {{child}} was revised.'
  },
  approval_event: {
    emailSubject: '{{title}}',
    email: '{{body}}',
    inAppTitle: '{{title}}',
    inApp: '{{body}}'
  },
  announcement: {
    sms: '{{school}}: {{title}}. {{body}}',
    emailSubject: '{{title}}',
    email: '{{body}}',
    inAppTitle: '{{title}}',
    inApp: '{{body}}'
  },
  bank_changed: {
    sms: '{{school}}: the settlement bank account was changed to {{account}}. If this was not you, contact us now.',
    emailSubject: 'Settlement bank account changed',
    email: 'The settlement bank account for {{school}} was changed to {{account}}.\nIf this was not you, contact us now.',
    inAppTitle: 'Bank account changed',
    inApp: 'The settlement account is now {{account}}.'
  },
  password_changed: {
    emailSubject: 'Your password changed',
    email: 'Your password was changed. If this was not you, reset it now and tell the school.',
    inAppTitle: 'Password changed',
    inApp: 'Your password was changed.'
  },
  school_status: {
    sms: '{{school}} is now {{status}}. {{note}}',
    emailSubject: '{{school}} is now {{status}}',
    email: '{{school}} is now {{status}}.\n{{note}}',
    inAppTitle: 'School {{status}}',
    inApp: '{{note}}'
  },
  low_sms_units: {
    emailSubject: 'Your SMS units are finished',
    email: 'Your school has no SMS units left. Optional text messages are skipped until you buy more. In-app messages still go out.',
    inAppTitle: 'No SMS units left',
    inApp: 'Optional text messages are skipped until you buy more units.'
  },
  contact_change: { inAppTitle: 'Contact change to review', inApp: '{{name}} asked to change their contact details.' },
  enquiry_received: { inAppTitle: 'New enquiry', inApp: '{{name}} sent a message from the website.' },
  parent_access_ended: { inAppTitle: 'Access ended', inApp: 'Your access to {{school}} has ended.' },
  temp_password: {
    sms: '{{school}}: your temporary password is {{password}}. Sign in at {{link}} and you will be asked to change it.',
    emailSubject: 'Your temporary password',
    email: 'Your temporary password for {{school}} is {{password}}.\nSign in at {{link}}. You will be asked to change it.',
    required: ['password']
  }
};

const PLACEHOLDER = /\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g;

export const placeholdersIn = (s: string): string[] => [...s.matchAll(PLACEHOLDER)].map((m) => m[1]);

export function render(body: string, vars: Record<string, string | number | undefined | null>): string {
  return body
    .replace(PLACEHOLDER, (_m, k: string) => (vars[k] === undefined || vars[k] === null ? '' : String(vars[k])))
    .replace(/[ \t]+\n/g, '\n')
    .replace(/ {2,}/g, ' ')
    .trim();
}

/** A template missing a required placeholder is refused on save. */
export function missingPlaceholders(key: EventKey, edited: string): string[] {
  const required = DEFAULT_TEMPLATES[key]?.required ?? [];
  const have = new Set(placeholdersIn(edited));
  return required.filter((r) => !have.has(r));
}

/** Optional templates a school may edit. Essential ones (codes, receipts, admission status) stay fixed in wording of meaning but can be reworded. */
export const EDITABLE_EVENTS: EventKey[] = [
  'invoice_issued',
  'fee_reminder',
  'child_absent',
  'results_published',
  'result_revised',
  'announcement',
  'application_status',
  'offer_made',
  'payment_success'
];
