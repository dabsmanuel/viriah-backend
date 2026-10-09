import { env, isLocal } from '../config/env';
import { AppError } from '../core/errors';
import { hmac512, randomToken } from '../lib/crypto';

/**
 * Paystack (Document 3, section 9). Subaccounts and split payments: online payments settle directly to the
 * school's bank account and any platform commission is taken as a split of the same transaction.
 * A fake provider is used when no secret key is set, so every flow can be exercised locally and in tests.
 */

export interface Bank {
  name: string;
  code: string;
}

export interface InitializeArgs {
  email: string;
  amountKobo: number;
  reference: string;
  callbackUrl: string;
  subaccount?: string;
  transactionChargeKobo?: number;
  bearer?: 'subaccount' | 'account';
  metadata: Record<string, unknown>;
}

export interface VerifyResult {
  status: 'success' | 'failed' | 'abandoned' | 'ongoing';
  amountKobo: number;
  currency: string;
  reference: string;
  id: string;
  channel?: string;
  paidAt?: string;
  feesKobo?: number;
  metadata?: Record<string, unknown>;
}

export interface PaystackClient {
  name: string;
  listBanks(): Promise<Bank[]>;
  resolveAccount(bankCode: string, accountNumber: string): Promise<{ accountName: string; accountNumber: string }>;
  createSubaccount(args: { businessName: string; bankCode: string; accountNumber: string }): Promise<{ subaccountCode: string }>;
  updateSubaccount(code: string, args: { businessName?: string; bankCode?: string; accountNumber?: string }): Promise<void>;
  initialize(args: InitializeArgs): Promise<{ authorizationUrl: string; accessCode: string; reference: string }>;
  verify(reference: string): Promise<VerifyResult>;
  refund(reference: string, amountKobo?: number): Promise<{ status: string; id?: string }>;
}

// ---------------------------------------------------------------- real client

async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`https://api.paystack.co${path}`, {
    method,
    headers: { Authorization: `Bearer ${env.PAYSTACK_SECRET_KEY}`, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined
  });
  const json = (await res.json().catch(() => ({}))) as { status?: boolean; message?: string; data?: T };
  if (!res.ok || json.status === false) throw new AppError('payment_provider_error', json.message ?? 'The payment provider did not accept the request.');
  return json.data as T;
}

const real: PaystackClient = {
  name: 'paystack',
  async listBanks() {
    const data = await call<Array<{ name: string; code: string }>>('GET', '/bank?country=nigeria&perPage=200&currency=NGN');
    return data.map((b) => ({ name: b.name, code: b.code }));
  },
  async resolveAccount(bankCode, accountNumber) {
    const d = await call<{ account_name: string; account_number: string }>('GET', `/bank/resolve?account_number=${encodeURIComponent(accountNumber)}&bank_code=${encodeURIComponent(bankCode)}`);
    return { accountName: d.account_name, accountNumber: d.account_number };
  },
  async createSubaccount({ businessName, bankCode, accountNumber }) {
    const d = await call<{ subaccount_code: string }>('POST', '/subaccount', {
      business_name: businessName,
      settlement_bank: bankCode,
      account_number: accountNumber,
      percentage_charge: 0
    });
    return { subaccountCode: d.subaccount_code };
  },
  async updateSubaccount(code, a) {
    await call('PUT', `/subaccount/${code}`, {
      ...(a.businessName ? { business_name: a.businessName } : {}),
      ...(a.bankCode ? { settlement_bank: a.bankCode } : {}),
      ...(a.accountNumber ? { account_number: a.accountNumber } : {})
    });
  },
  async initialize(a) {
    const d = await call<{ authorization_url: string; access_code: string; reference: string }>('POST', '/transaction/initialize', {
      email: a.email,
      amount: a.amountKobo,
      reference: a.reference,
      callback_url: a.callbackUrl,
      currency: 'NGN',
      metadata: a.metadata,
      ...(a.subaccount ? { subaccount: a.subaccount, bearer: a.bearer ?? 'subaccount', transaction_charge: a.transactionChargeKobo ?? 0 } : {})
    });
    return { authorizationUrl: d.authorization_url, accessCode: d.access_code, reference: d.reference };
  },
  async verify(reference) {
    const d = await call<{ status: VerifyResult['status']; amount: number; currency: string; reference: string; id: number; channel?: string; paid_at?: string; fees?: number; metadata?: Record<string, unknown> }>(
      'GET',
      `/transaction/verify/${encodeURIComponent(reference)}`
    );
    return { status: d.status, amountKobo: d.amount, currency: d.currency, reference: d.reference, id: String(d.id), channel: d.channel, paidAt: d.paid_at, feesKobo: d.fees, metadata: d.metadata };
  },
  async refund(reference, amountKobo) {
    const d = await call<{ status: string; id?: number }>('POST', '/refund', { transaction: reference, ...(amountKobo ? { amount: amountKobo } : {}) });
    return { status: d.status, id: d.id ? String(d.id) : undefined };
  }
};

// ---------------------------------------------------------------- fake client (local and tests)

interface FakeTxn extends InitializeArgs {
  status: VerifyResult['status'];
  paidAmountKobo?: number;
  id: string;
  channel: string;
}

export class FakePaystack implements PaystackClient {
  name = 'fake';
  txns = new Map<string, FakeTxn>();
  subaccounts = new Map<string, { businessName: string; bankCode: string; accountNumber: string }>();
  refunds: Array<{ reference: string; amountKobo?: number }> = [];
  failNextInitialize = false;
  banks: Bank[] = [
    { name: 'Access Bank', code: '044' },
    { name: 'Guaranty Trust Bank', code: '058' },
    { name: 'First Bank of Nigeria', code: '011' },
    { name: 'Zenith Bank', code: '057' }
  ];

  async listBanks() {
    return this.banks;
  }
  async resolveAccount(bankCode: string, accountNumber: string) {
    if (!/^\d{10}$/.test(accountNumber)) throw new AppError('payment_provider_error', 'Could not resolve the account. Check the number and the bank.');
    return { accountName: `TEST ACCOUNT ${accountNumber.slice(-4)}`, accountNumber };
  }
  async createSubaccount(a: { businessName: string; bankCode: string; accountNumber: string }) {
    const code = `ACCT_${randomToken(6).replace(/[-_]/g, 'x')}`;
    this.subaccounts.set(code, a);
    return { subaccountCode: code };
  }
  async updateSubaccount(code: string, a: { businessName?: string; bankCode?: string; accountNumber?: string }) {
    const cur = this.subaccounts.get(code);
    if (!cur) throw new AppError('payment_provider_error', 'Unknown subaccount.');
    this.subaccounts.set(code, { ...cur, ...a } as { businessName: string; bankCode: string; accountNumber: string });
  }
  async initialize(a: InitializeArgs) {
    if (this.failNextInitialize) {
      this.failNextInitialize = false;
      throw new AppError('payment_provider_error', 'The payment provider did not answer. Try again.');
    }
    this.txns.set(a.reference, { ...a, status: 'ongoing', id: String(Date.now()), channel: 'card' });
    return { authorizationUrl: `${env.WEB_ORIGIN}/dev/paystack?reference=${a.reference}&callback=${encodeURIComponent(a.callbackUrl)}`, accessCode: `AC_${randomToken(5)}`, reference: a.reference };
  }
  async verify(reference: string): Promise<VerifyResult> {
    const t = this.txns.get(reference);
    if (!t) throw new AppError('payment_provider_error', 'Transaction not found.');
    return {
      status: t.status,
      amountKobo: t.paidAmountKobo ?? t.amountKobo,
      currency: 'NGN',
      reference,
      id: t.id,
      channel: t.channel,
      paidAt: new Date().toISOString(),
      feesKobo: 0,
      metadata: t.metadata
    };
  }
  async refund(reference: string, amountKobo?: number) {
    this.refunds.push({ reference, amountKobo });
    return { status: 'processed', id: String(Date.now()) };
  }

  /** Test and dev helper: the customer pays. Returns the webhook body and signature Paystack would send. */
  simulatePay(reference: string, opts: { amountKobo?: number; status?: 'success' | 'failed' } = {}) {
    const t = this.txns.get(reference);
    if (!t) throw new Error(`No fake transaction ${reference}`);
    t.status = opts.status ?? 'success';
    if (opts.amountKobo !== undefined) t.paidAmountKobo = opts.amountKobo;
    const body = JSON.stringify({
      event: t.status === 'success' ? 'charge.success' : 'charge.failed',
      data: { id: t.id, reference, amount: t.paidAmountKobo ?? t.amountKobo, currency: 'NGN', status: t.status, metadata: t.metadata }
    });
    return { body, signature: signWebhook(body) };
  }
  abandon(reference: string) {
    const t = this.txns.get(reference);
    if (t) t.status = 'abandoned';
  }
}

export const fakePaystack = new FakePaystack();

let client: PaystackClient = env.PAYSTACK_SECRET_KEY ? real : fakePaystack;
export const paystack = () => client;
export const setPaystack = (c: PaystackClient) => (client = c);
export const usingFakePaystack = () => client === fakePaystack;

/** The secret used to sign and verify webhooks. With the fake provider a fixed local secret is used. */
export const webhookSecret = () => env.PAYSTACK_SECRET_KEY || 'fake-paystack-secret-for-local-use';

/** x-paystack-signature is an HMAC SHA-512 of the raw request body made with the secret key. */
export const signWebhook = (rawBody: string | Buffer) => hmac512(rawBody, webhookSecret());

export const paystackEnabledForDev = isLocal;
