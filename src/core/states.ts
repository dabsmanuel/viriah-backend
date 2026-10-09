import { stateConflict } from './errors';

/**
 * Status fields and the only changes allowed (Document 2, section 4). The API refuses any other change
 * with state_conflict.
 */
export const TRANSITIONS = {
  school: {
    pending: ['active', 'rejected'],
    active: ['suspended', 'closed'],
    suspended: ['active', 'closed'],
    rejected: ['pending'], // one resubmission
    closed: []
  },
  website: {
    draft: ['published'],
    published: ['unpublished', 'taken_down'],
    unpublished: ['published'],
    taken_down: ['unpublished']
  },
  membership: {
    invited: ['active'],
    active: ['deactivated'],
    deactivated: ['active']
  },
  application: {
    draft: ['submitted', 'withdrawn'],
    submitted: ['under_review', 'withdrawn'],
    under_review: ['assessment_scheduled', 'offered', 'waitlisted', 'rejected', 'withdrawn'],
    assessment_scheduled: ['offered', 'waitlisted', 'rejected', 'withdrawn'],
    waitlisted: ['offered', 'rejected', 'withdrawn'],
    offered: ['accepted', 'expired', 'withdrawn'],
    expired: ['offered', 'withdrawn'],
    accepted: ['enrolled', 'withdrawn'],
    enrolled: [],
    rejected: [],
    withdrawn: []
  },
  student: {
    active: ['suspended', 'withdrawn', 'transferred', 'graduated'],
    suspended: ['active', 'withdrawn'],
    withdrawn: ['active'], // readmission, by admin
    transferred: ['active'],
    graduated: []
  },
  period: {
    upcoming: ['current'],
    current: ['closed'],
    closed: ['current'] // reopen: owner or principal, logged
  },
  task: {
    draft: ['published'],
    published: ['closed'],
    closed: ['published'] // extend
  },
  submission: {
    submitted: ['returned', 'marked'],
    returned: ['submitted'],
    marked: ['returned'] // before scores are pushed
  },
  scoreSheet: {
    draft: ['submitted'],
    submitted: ['returned'],
    returned: ['submitted']
  },
  classResult: {
    open: ['compiled'],
    compiled: ['awaiting_approval', 'open'],
    awaiting_approval: ['approved', 'open'],
    approved: ['published'],
    published: ['reopened'],
    reopened: ['compiled']
  },
  promotionList: {
    proposed: ['reviewed'],
    reviewed: ['approved', 'proposed'],
    approved: ['applied'],
    applied: []
  },
  invoice: {
    draft: ['issued'],
    issued: ['part_paid', 'paid', 'void'],
    part_paid: ['paid', 'issued'],
    paid: ['part_paid', 'issued'], // back when a payment is reversed
    void: []
  },
  payment: {
    initiated: ['successful', 'failed', 'abandoned'],
    abandoned: ['successful'], // a late notification for money that was really received
    pending_confirmation: ['successful', 'rejected'],
    successful: ['reversed', 'refunded'],
    failed: [],
    rejected: [],
    reversed: [],
    refunded: []
  },
  approval: {
    pending: ['approved', 'declined'],
    approved: [],
    declined: []
  },
  importBatch: {
    validating: ['ready', 'failed'],
    ready: ['committed'],
    committed: ['rolled_back'],
    rolled_back: [],
    failed: []
  }
} as const satisfies Record<string, Record<string, readonly string[]>>;

export type StateKind = keyof typeof TRANSITIONS;

export const canTransition = (kind: StateKind, from: string, to: string): boolean =>
  ((TRANSITIONS[kind] as Record<string, readonly string[]>)[from] ?? []).includes(to);

export function assertTransition(kind: StateKind, from: string, to: string, what = 'This record') {
  if (!canTransition(kind, from, to)) {
    throw stateConflict(`${what} is ${from.replace(/_/g, ' ')}. It cannot change to ${to.replace(/_/g, ' ')}.`, { from, to });
  }
}
