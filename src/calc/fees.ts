import { assertKobo, percentOfKobo, sumKobo } from '../lib/money';

/** Invoice arithmetic, allocation and the payment charge gross-up (Document 3, section 9). Money is whole kobo. */

export type InvoiceStatus = 'draft' | 'issued' | 'part_paid' | 'paid' | 'void';

export interface Line {
  amountKobo: number;
}

/** totalKobo = sum of line amounts minus sum of approved discounts. */
export function invoiceTotal(lines: Line[], discounts: Line[] = [], adjustments: Line[] = []): number {
  return Math.max(0, sumKobo(lines.map((l) => l.amountKobo)) + sumKobo(adjustments.map((a) => a.amountKobo)) - sumKobo(discounts.map((d) => d.amountKobo)));
}

/** paidKobo = sum of allocations from successful payments that are not reversed or refunded. Always recomputed, never adjusted. */
export function invoicePaid(allocations: Array<{ amountKobo: number; paymentStatus: string }>): number {
  return sumKobo(allocations.filter((a) => a.paymentStatus === 'successful').map((a) => a.amountKobo));
}

/** Status follows from the numbers: issued when paid is 0, part_paid when 0 < paid < total, paid when balance is 0. */
export function invoiceStatus(totalKobo: number, paidKobo: number, current: InvoiceStatus = 'issued'): InvoiceStatus {
  if (current === 'void' || current === 'draft') return current;
  if (paidKobo >= totalKobo) return 'paid';
  if (paidKobo > 0) return 'part_paid';
  return 'issued';
}

export const invoiceBalance = (totalKobo: number, paidKobo: number) => Math.max(0, totalKobo - paidKobo);

/** Overdue is not a stored status. It is true when dueOn has passed and the balance is above zero. */
export const isOverdue = (dueOn: string | undefined | null, balanceKobo: number, today: string) => !!dueOn && dueOn < today && balanceKobo > 0;

export type DiscountSpec = { type: 'fixed'; amountKobo: number } | { type: 'percent'; percent: number };

/** A percentage discount rounds half up to a whole kobo. It never exceeds the base. */
export function discountAmount(baseKobo: number, spec: DiscountSpec): number {
  const raw = spec.type === 'fixed' ? assertKobo(spec.amountKobo) : percentOfKobo(baseKobo, spec.percent);
  return Math.min(baseKobo, Math.max(0, raw));
}

export interface OpenInvoice {
  invoiceId: string;
  studentId: string;
  balanceKobo: number;
  createdAt?: Date | string | number;
}

export interface Allocation {
  invoiceId: string;
  studentId: string;
  amountKobo: number;
}

/**
 * A round amount is allocated to the oldest open invoice first. Anything left over becomes a credit
 * on the student (the first student's, when several children are paid for in one checkout).
 */
export function allocateRoundAmount(amountKobo: number, invoices: OpenInvoice[]): { allocations: Allocation[]; creditKobo: number } {
  assertKobo(amountKobo);
  const ordered = [...invoices].sort((a, b) => new Date(a.createdAt ?? 0).getTime() - new Date(b.createdAt ?? 0).getTime());
  let left = amountKobo;
  const allocations: Allocation[] = [];
  for (const inv of ordered) {
    if (left <= 0) break;
    const take = Math.min(left, inv.balanceKobo);
    if (take > 0) {
      allocations.push({ invoiceId: inv.invoiceId, studentId: inv.studentId, amountKobo: take });
      left -= take;
    }
  }
  return { allocations, creditKobo: left };
}

/** Where a school sets a minimum part payment, the first payment on an invoice must be at least that percentage of its total. */
export function minimumPartPayment(totalKobo: number, paidSoFarKobo: number, minPercent: number): number {
  if (paidSoFarKobo > 0 || minPercent <= 0) return 0;
  return Math.min(totalKobo, Math.ceil((totalKobo * minPercent) / 100));
}

export interface PaymentRates {
  percent: number; // 1.5 means 1.5 percent
  flatKobo: number;
  flatWaivedBelowKobo: number;
  capKobo: number;
}

export const DEFAULT_RATES: PaymentRates = { percent: 1.5, flatKobo: 10000, flatWaivedBelowKobo: 250000, capKobo: 200000 };

/** Paystack's fee on a transaction of totalKobo: percent plus a flat fee (waived below a threshold), capped. Rounded up. */
export function paystackFee(totalKobo: number, rates: PaymentRates = DEFAULT_RATES): number {
  const bps = Math.round(rates.percent * 100);
  const pct = Math.ceil((totalKobo * bps) / 10000);
  const flat = totalKobo >= rates.flatWaivedBelowKobo ? rates.flatKobo : 0;
  return Math.min(rates.capKobo, pct + flat);
}

export type CommissionSpec = { type: 'none' | 'flat' | 'percent'; value: number };

/** Commission is taken as a split of the same transaction. Flat value is in kobo, percent is of the fee amount. */
export function commissionFor(amountKobo: number, spec: CommissionSpec | undefined | null): number {
  if (!spec || spec.type === 'none' || !spec.value) return 0;
  if (spec.type === 'flat') return Math.max(0, Math.round(spec.value));
  return percentOfKobo(amountKobo, spec.value);
}

export interface Quote {
  feesKobo: number; // what the invoices are credited with
  chargeKobo: number; // added to what the parent pays (0 when the school bears it)
  totalKobo: number; // what Paystack is asked to collect
  commissionKobo: number; // platform share, sent as transaction_charge
  paystackFeeKobo: number;
  schoolReceivesKobo: number;
  chargeBorneBy: 'parent' | 'school';
}

/**
 * With bearer set to subaccount, Paystack's fee comes out of the school's share and the platform receives its commission whole.
 *
 * School bears the charge: the parent pays the invoice amount. The school receives the amount less Paystack's fee and the commission.
 * Parent bears the charge: the amount charged is grossed up so that the school receives the invoice amount after
 * Paystack's fee and the commission. The checkout shows the fee amount and the added charge as separate lines.
 *
 * Gross up solves T = A + C + fee(T). fee is non decreasing in T, so iterating from T0 = A + C converges to the
 * least solution, which is the smallest amount that leaves the school with A.
 */
export function quote(feesKobo: number, bearer: 'parent' | 'school', commission: CommissionSpec | undefined | null, rates: PaymentRates = DEFAULT_RATES): Quote {
  assertKobo(feesKobo);
  const c = commissionFor(feesKobo, commission);
  if (bearer === 'school') {
    const fee = paystackFee(feesKobo, rates);
    return { feesKobo, chargeKobo: 0, totalKobo: feesKobo, commissionKobo: c, paystackFeeKobo: fee, schoolReceivesKobo: feesKobo - fee - c, chargeBorneBy: 'school' };
  }
  let total = feesKobo + c;
  for (let i = 0; i < 20; i++) {
    const next = feesKobo + c + paystackFee(total, rates);
    if (next === total) break;
    total = next;
  }
  const fee = paystackFee(total, rates);
  return { feesKobo, chargeKobo: total - feesKobo, totalKobo: total, commissionKobo: c, paystackFeeKobo: fee, schoolReceivesKobo: total - fee - c, chargeBorneBy: 'parent' };
}
