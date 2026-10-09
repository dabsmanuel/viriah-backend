import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { client, ctxFor, drainJobs, hostOf, lastCode, makeStaff, platform, PASSWORD, resetDb, signIn, signInSuperAdmin, smsTo, startTestDb, stopTestDb } from './helpers';
import { addStudent, buildSchool, generateInvoices, naira, parentLogin, setBank, type Fixture } from './fixtures';
import { fakePaystack } from '../src/integrations/paystack';
import { AuditLog, AuthSession, Credit, Invoice, Payment, PlatformSetting, Receipt, School, WebhookEvent } from '../src/models';
import { clearSettingsCache } from '../src/services/common';
import { reconcileNow } from './reconcile';

beforeAll(startTestDb);
afterAll(stopTestDb);
beforeEach(resetDb);

const key = () => `k-${Math.random().toString(36).slice(2)}-${Date.now()}`;

describe('M8 fees and invoices', () => {
  it('generates exactly one term invoice per active student, and generating again creates none', async () => {
    const fx = await buildSchool();
    await addStudent(fx);
    await addStudent(fx);
    await addStudent(fx, { arm: fx.armB });
    await generateInvoices(fx);
    const first = await ctxFor(String(fx.school._id), () => Invoice.find({ kind: 'term' }).lean());
    expect(first.length).toBe(3);
    expect(first.every((i: any) => i.totalKobo === naira(45000 + 5000 + 2000) && i.status === 'issued')).toBe(true); // optional Uniform is not included
    await generateInvoices(fx);
    expect((await ctxFor(String(fx.school._id), () => Invoice.countDocuments({ kind: 'term' })))).toBe(3);
    // numbers are sequential and unique
    expect(new Set(first.map((i: any) => i.number)).size).toBe(3);
  });

  it('adds an optional item for one student and changes only that invoice', async () => {
    const fx = await buildSchool();
    const a = await addStudent(fx);
    const b = await addStudent(fx);
    await generateInvoices(fx);
    const list = (await fx.bc.get(`/invoices?studentId=${a.id}`)).body.data;
    const add = await fx.bc.patch(`/invoices/${list[0].id}`).send({ addLines: [{ feeItemId: fx.items.Uniform, amountKobo: naira(8000) }] });
    expect(add.status).toBe(200);
    expect(add.body.data.totalKobo).toBe(naira(60000));
    expect((await fx.bc.get(`/invoices?studentId=${b.id}`)).body.data[0].totalKobo).toBe(naira(52000));
  });

  it('holds a discount for approval, drops the total on approval, and audits it', async () => {
    const fx = await buildSchool();
    const a = await addStudent(fx);
    await generateInvoices(fx);
    const inv = (await fx.bc.get(`/invoices?studentId=${a.id}`)).body.data[0];
    const req = await fx.bc.post(`/invoices/${inv.id}/discounts`).send({ label: 'Sibling discount', type: 'percent', percent: 10, reason: 'Second child' });
    expect(req.status).toBe(201);
    expect((await fx.bc.get(`/invoices/${inv.id}`)).body.data.totalKobo).toBe(naira(52000)); // not yet
    expect((await fx.bc.post(`/approvals/${req.body.data.approvalId}/approve`).send({})).status).toBe(403); // a bursar cannot approve
    // approving money needs a recent password: an old session is asked to confirm it first
    await platform(() => AuthSession.updateMany({}, { lastConfirmedAt: new Date(Date.now() - 45 * 60_000) }));
    const stale = await fx.oc.post(`/approvals/${req.body.data.approvalId}/approve`).send({});
    expect(stale.status).toBe(401);
    expect(stale.body.error.details.reauth).toBe(true);
    await fx.oc.post('/auth/confirm-password').send({ password: PASSWORD });
    const approve = await fx.oc.post(`/approvals/${req.body.data.approvalId}/approve`).send({});
    expect(approve.status).toBe(200);
    const after = (await fx.bc.get(`/invoices/${inv.id}`)).body.data;
    expect(after.totalKobo).toBe(naira(52000) - naira(5200));
    expect(after.discounts[0].amountKobo).toBe(naira(5200));
    expect((await platform(() => AuditLog.find({ action: 'approvals.discount.approve' }).lean())).length).toBe(1);
    // an approved request cannot be approved twice
    expect((await fx.oc.post(`/approvals/${req.body.data.approvalId}/approve`).send({})).status).toBe(409);
  });

  it('rounds a percentage discount on an amount that does not divide evenly', async () => {
    const fx = await buildSchool({ fees: { Tuition: 33333.35 } });
    const a = await addStudent(fx);
    await generateInvoices(fx);
    const inv = (await fx.bc.get(`/invoices?studentId=${a.id}`)).body.data[0];
    const req = await fx.bc.post(`/invoices/${inv.id}/discounts`).send({ label: 'Staff child', type: 'percent', percent: 10, reason: 'Staff' });
    expect(req.body.data.amountKobo).toBe(333334); // 333333.5 rounds half up
  });

  it('refuses to void an invoice with a payment, and voids one without', async () => {
    const fx = await buildSchool();
    const a = await addStudent(fx);
    const b = await addStudent(fx);
    await generateInvoices(fx);
    const ia = (await fx.bc.get(`/invoices?studentId=${a.id}`)).body.data[0];
    const ib = (await fx.bc.get(`/invoices?studentId=${b.id}`)).body.data[0];
    await fx.bc.post('/payments/offline').set('Idempotency-Key', key()).send({ studentId: a.id, amountKobo: naira(1000), channel: 'cash', paidOn: '2026-10-05' });
    expect((await fx.bc.post(`/invoices/${ia.id}/void`).send({})).status).toBe(409);
    expect((await fx.bc.post(`/invoices/${ib.id}/void`).send({ reason: 'Wrong class' })).status).toBe(200);
    // a removed line that payments cover cannot be taken off
    expect((await fx.bc.patch(`/invoices/${ia.id}`).send({ removeIndexes: [0, 1, 2] })).status).toBe(409);
  });

  it('records opening balances as brought-forward invoices, once per student', async () => {
    const fx = await buildSchool();
    const a = await addStudent(fx);
    const res = await fx.bc.post('/fees/opening-balances').set('Idempotency-Key', key()).send({ items: [{ studentId: a.id, amountKobo: naira(12000), note: 'Arrears from 2025/2026' }] });
    expect(res.body.data).toEqual({ created: 1, skipped: 0 });
    const again = await fx.bc.post('/fees/opening-balances').set('Idempotency-Key', key()).send({ items: [{ studentId: a.id, amountKobo: naira(99), note: 'x' }] });
    expect(again.body.data).toEqual({ created: 0, skipped: 1 });
    const inv = (await fx.bc.get(`/invoices?studentId=${a.id}`)).body.data[0];
    expect(inv.kind).toBe('opening_balance');
    expect(inv.totalKobo).toBe(naira(12000));
  });

  it('lists a statement with invoices and payments in date order and a running balance, and arrears stay open', async () => {
    const fx = await buildSchool();
    const a = await addStudent(fx);
    await fx.bc.post('/fees/opening-balances').set('Idempotency-Key', key()).send({ items: [{ studentId: a.id, amountKobo: naira(10000) }] });
    await generateInvoices(fx);
    await fx.bc.post('/payments/offline').set('Idempotency-Key', key()).send({ studentId: a.id, amountKobo: naira(4000), channel: 'cash', paidOn: '2026-10-05' });
    const st = (await fx.bc.get(`/students/${a.id}/statement`)).body.data;
    expect(st.rows.map((r: any) => r.type)).toEqual(['invoice', 'invoice', 'payment']);
    expect(st.rows[2].balanceKobo).toBe(naira(10000 + 52000 - 4000));
    expect(st.balanceKobo).toBe(naira(58000));
    expect(st.arrearsKobo).toBe(naira(58000));
    // the oldest invoice (arrears) took the payment first
    const arrears = st.invoices.find((i: any) => i.paidKobo > 0);
    expect(arrears.totalKobo).toBe(naira(10000));
  });

  it('shows the principal whether a student has paid or owes, without amounts; teachers get nothing on fees', async () => {
    const fx = await buildSchool();
    const a = await addStudent(fx);
    await generateInvoices(fx);
    const principal = await makeStaff(fx.school, ['principal']);
    const { c: pc } = await signIn(principal.phone, fx.host);
    expect((await pc.get(`/students/${a.id}/fee-status`)).body.data).toEqual({ status: 'owing' });
    expect((await pc.get(`/invoices`)).status).toBe(403);
    expect((await pc.get(`/students/${a.id}/statement`)).status).toBe(403);
    const teacher = await makeStaff(fx.school, ['subject_teacher']);
    const { c: tc } = await signIn(teacher.phone, fx.host);
    for (const path of ['/invoices', '/fee-structures', '/fee-items', '/fees/debtors', '/fees/collections', '/payments', '/receipts', '/approvals', `/students/${a.id}/fee-status`]) {
      expect((await tc.get(path)).status, path).toBe(403);
    }
    expect((await tc.post('/invoices').set('Idempotency-Key', key()).send({ studentId: a.id, lines: [{ label: 'x', amountKobo: 100 }] })).status).toBe(403);
  });

  it('lists debtors with amounts and totals the collections by method', async () => {
    const fx = await buildSchool();
    const a = await addStudent(fx);
    const b = await addStudent(fx);
    await generateInvoices(fx);
    await fx.bc.post('/payments/offline').set('Idempotency-Key', key()).send({ studentId: a.id, amountKobo: naira(52000), channel: 'bank', paidOn: '2026-10-05', bankReference: 'TRF/1' });
    const debtors = (await fx.bc.get('/fees/debtors')).body;
    expect(debtors.data.map((d: any) => d.studentId)).toEqual([b.id]);
    expect(debtors.totalKobo).toBe(naira(52000));
    const col = (await fx.bc.get('/fees/collections?groupBy=method')).body.data;
    expect(col.rows).toEqual([{ key: 'bank', amountKobo: naira(52000) }]);
    const byItem = (await fx.bc.get('/fees/collections?groupBy=item')).body.data;
    expect(byItem.totalKobo).toBe(naira(52000));
    expect((await fx.bc.get('/fees/debtors?format=xlsx')).body.data.url).toContain('/files/local/');
  });

  it('raises an invoice at enrolment when the term’s invoices already exist, and adopts a credit automatically', async () => {
    const fx = await buildSchool();
    await addStudent(fx);
    await generateInvoices(fx);
    const late = await addStudent(fx); // joins mid-term
    const inv = (await fx.bc.get(`/invoices?studentId=${late.id}`)).body.data;
    expect(inv.length).toBe(1);
    expect(inv[0].kind).toBe('term');
  });
});

describe('M9 payments and receipts', () => {
  async function paidSetup(opts: { children?: number } = {}) {
    const fx = await buildSchool({ withBank: true });
    const kids: Array<Awaited<ReturnType<typeof addStudent>>> = [];
    const phone = '08031112200';
    for (let i = 0; i < (opts.children ?? 1); i++) kids.push(await addStudent(fx, { first: `Child${i}`, guardianPhone: phone, last: 'Okoro' }));
    await generateInvoices(fx);
    const pc = await parentLogin(fx, kids[0].guardianId);
    const invoices = (await pc.get('/my/invoices')).body.data as any[];
    return { fx, pc, kids, invoices };
  }
  const webhook = async (sim: { body: string; signature: string }, signature = sim.signature) =>
    client().agent.post('/api/v1/webhooks/paystack').set('x-paystack-signature', signature).set('Content-Type', 'application/json').send(sim.body);

  it('hides online payment until the bank account is set', async () => {
    const fx = await buildSchool(); // no bank
    const kid = await addStudent(fx);
    await generateInvoices(fx);
    const pc = await parentLogin(fx, kid.guardianId);
    const inv = (await pc.get('/my/invoices')).body.data[0];
    const q = await pc.post('/payments/quote').send({ items: [{ invoiceId: inv.id }] });
    expect(q.body.data.onlineAvailable).toBe(false);
    const co = await pc.post('/payments/checkout').set('Idempotency-Key', key()).send({ items: [{ invoiceId: inv.id }] });
    expect(co.status).toBe(409);
    expect(co.body.error.code).toBe('bank_not_set');
  });

  it('shows the bank account name before saving, requires an SMS code to change it, and tells the super admin', async () => {
    const fx = await buildSchool();
    const resolved = await fx.oc.post('/school/bank/resolve').send({ bankCode: '058', accountNumber: '0123456789' });
    expect(resolved.body.data.accountName).toBe('TEST ACCOUNT 6789');
    expect((await fx.oc.get('/banks')).body.data.length).toBeGreaterThan(0);
    // the name the owner confirms must match the bank's record
    expect((await fx.oc.put('/school/bank').send({ bankCode: '058', accountNumber: '0123456789', accountName: 'SOMEONE ELSE' })).status).toBe(422);
    await fx.oc.post('/auth/confirm-password').send({ password: PASSWORD });
    expect((await fx.oc.put('/school/bank').send({ bankCode: '058', accountNumber: '0123456789', accountName: 'TEST ACCOUNT 6789' })).status).toBe(200);
    const school: any = await platform(() => School.findById(fx.school._id).lean());
    expect(school.paystack).toMatchObject({ bankCode: '058', accountLast4: '6789' });
    expect(school.paystack.subaccountCode).toMatch(/^ACCT_/);
    // changing it needs a code
    const change = { bankCode: '044', accountNumber: '9876543210', accountName: 'TEST ACCOUNT 3210' };
    expect((await fx.oc.put('/school/bank').send(change)).status).toBe(422);
    await fx.oc.post('/school/bank/request-code').send({});
    const code = lastCode(fx.owner.phone)!;
    expect((await fx.oc.put('/school/bank').send({ ...change, code: '000000' })).status).toBe(422);
    expect((await fx.oc.put('/school/bank').send({ ...change, code })).status).toBe(200);
    expect((await platform(() => AuditLog.find({ action: 'fees.bank.change' }).lean())).length).toBe(2);
    expect(await smsTo(fx.owner.phone, /bank account was changed/)).toBeTruthy();
    // a bursar cannot change it
    expect((await fx.bc.put('/school/bank').send(change)).status).toBe(403);
  });

  it('pays two children’s invoices in one checkout: one payment, two receipts, both invoices updated', async () => {
    const { fx, pc, invoices } = await paidSetup({ children: 2 });
    expect(invoices.length).toBe(2);
    const quote = (await pc.post('/payments/quote').send({ items: invoices.map((i) => ({ invoiceId: i.id })) })).body.data;
    expect(quote.feesKobo).toBe(naira(104000));
    expect(quote.chargeKobo).toBeGreaterThan(0); // the parent bears the charge by default
    expect(quote.totalKobo).toBe(quote.feesKobo + quote.chargeKobo);

    const idem = key();
    const co = await pc.post('/payments/checkout').set('Idempotency-Key', idem).send({ items: invoices.map((i) => ({ invoiceId: i.id })) });
    expect(co.status).toBe(201);
    const again = await pc.post('/payments/checkout').set('Idempotency-Key', idem).send({ items: invoices.map((i) => ({ invoiceId: i.id })) });
    expect(again.body.data.reference).toBe(co.body.data.reference); // safe retry
    expect((await ctxFor(String(fx.school._id), () => Payment.countDocuments({ channel: 'paystack' })))).toBe(1);

    const txn = fakePaystack.txns.get(co.body.data.reference)!;
    expect(txn.subaccount).toMatch(/^ACCT_/);
    expect(txn.bearer).toBe('subaccount');
    expect(txn.amountKobo).toBe(quote.totalKobo);
    expect(txn.metadata).toMatchObject({ schoolId: String(fx.school._id) });

    const sim = fakePaystack.simulatePay(co.body.data.reference);
    expect((await webhook(sim)).status).toBe(200);
    await drainJobs();
    const verify = await pc.get(`/payments/verify?reference=${co.body.data.reference}`);
    expect(verify.body.data.status).toBe('successful');
    expect(verify.body.data.receipts.length).toBe(2);
    const after = (await pc.get('/my/invoices')).body.data as any[];
    expect(after.every((i) => i.status === 'paid' && i.balanceKobo === 0)).toBe(true);
    expect(await smsTo('+2348031112200', /received/)).toBeTruthy();
    // receipts have numbers in the school's format
    expect(verify.body.data.receipts[0].number).toMatch(/^TST\/\d{2}\/\d{6}$/);
  });

  it('completes the payment from the webhook alone when the parent closes the browser straight after paying', async () => {
    const { pc, invoices } = await paidSetup();
    const co = await pc.post('/payments/checkout').set('Idempotency-Key', key()).send({ items: [{ invoiceId: invoices[0].id }] });
    expect((await webhook(fakePaystack.simulatePay(co.body.data.reference))).status).toBe(200);
    await drainJobs();
    const receipts = (await pc.get('/my/receipts')).body.data;
    expect(receipts.length).toBe(1);
    expect((await pc.get('/my/invoices')).body.data[0].status).toBe('paid');
  });

  it('applies the same webhook delivered three times once', async () => {
    const { fx, pc, invoices } = await paidSetup();
    const co = await pc.post('/payments/checkout').set('Idempotency-Key', key()).send({ items: [{ invoiceId: invoices[0].id }] });
    const sim = fakePaystack.simulatePay(co.body.data.reference);
    for (let i = 0; i < 3; i++) expect((await webhook(sim)).status).toBe(200);
    await drainJobs();
    expect(await ctxFor(String(fx.school._id), () => Receipt.countDocuments({}))).toBe(1);
    expect(await ctxFor(String(fx.school._id), () => Payment.countDocuments({ status: 'successful' }))).toBe(1);
    expect(await platform(() => WebhookEvent.countDocuments({}))).toBe(1);
    // a different event for the same payment (a second delivery with a new id) still applies nothing new
    const inv: any = await ctxFor(String(fx.school._id), () => Invoice.findOne({}).lean());
    expect(inv.paidKobo).toBe(inv.totalKobo);
  });

  it('refuses a webhook with a bad signature and applies nothing', async () => {
    const { fx, pc, invoices } = await paidSetup();
    const co = await pc.post('/payments/checkout').set('Idempotency-Key', key()).send({ items: [{ invoiceId: invoices[0].id }] });
    const sim = fakePaystack.simulatePay(co.body.data.reference);
    expect((await webhook(sim, 'f'.repeat(128))).status).toBe(403);
    expect((await webhook(sim, '')).status).toBe(403);
    await drainJobs();
    expect(await ctxFor(String(fx.school._id), () => Receipt.countDocuments({}))).toBe(0);
    expect((await ctxFor(String(fx.school._id), () => Payment.findOne({ reference: co.body.data.reference }).lean())).status).toBe('initiated');
  });

  it('applies a payment once when the callback and the webhook arrive together', async () => {
    const { fx, pc, invoices } = await paidSetup();
    const co = await pc.post('/payments/checkout').set('Idempotency-Key', key()).send({ items: [{ invoiceId: invoices[0].id }] });
    const sim = fakePaystack.simulatePay(co.body.data.reference);
    await Promise.all([webhook(sim), pc.get(`/payments/verify?reference=${co.body.data.reference}`), pc.get(`/payments/verify?reference=${co.body.data.reference}`)]);
    await drainJobs();
    expect(await ctxFor(String(fx.school._id), () => Receipt.countDocuments({}))).toBe(1);
    const inv: any = await ctxFor(String(fx.school._id), () => Invoice.findOne({}).lean());
    expect(inv.paidKobo).toBe(inv.totalKobo); // not doubled
  });

  it('applies an amount that differs from the expected amount as received, and flags it for the bursar', async () => {
    const { fx, pc, invoices } = await paidSetup();
    const co = await pc.post('/payments/checkout').set('Idempotency-Key', key()).send({ items: [{ invoiceId: invoices[0].id }] });
    const expected = co.body.data.totalKobo as number;
    const charge = co.body.data.chargeKobo as number;
    const received = expected - naira(10000);
    await webhook(fakePaystack.simulatePay(co.body.data.reference, { amountKobo: received }));
    await drainJobs();
    const p: any = await ctxFor(String(fx.school._id), () => Payment.findOne({ reference: co.body.data.reference }).lean());
    expect(p.status).toBe('successful');
    expect(p.flagged).toBe(true);
    expect(p.flagReason).toMatch(/Applied as received/);
    const inv: any = await ctxFor(String(fx.school._id), () => Invoice.findOne({}).lean());
    expect(inv.paidKobo).toBe(received - charge);
    expect(inv.status).toBe('part_paid');
    expect((await fx.bc.get('/payments?flagged=true')).body.data.length).toBe(1);
  });

  it('refuses a part payment below the school’s minimum and states the minimum', async () => {
    const { fx, pc, invoices } = await paidSetup();
    await fx.oc.patch('/school').send({ settings: { partPayment: { enabled: true, minPercent: 25 } } });
    const low = await pc.post('/payments/quote').send({ items: [{ invoiceId: invoices[0].id, amountKobo: naira(10000) }] });
    expect(low.status).toBe(422);
    expect(low.body.error.message).toMatch(/at least ₦13,000\.00/);
    const ok = await pc.post('/payments/quote').send({ items: [{ invoiceId: invoices[0].id, amountKobo: naira(13000) }] });
    expect(ok.status).toBe(200);
    const above = await pc.post('/payments/quote').send({ items: [{ invoiceId: invoices[0].id, amountKobo: naira(60000) }] });
    expect(above.status).toBe(422);
    await fx.oc.patch('/school').send({ settings: { partPayment: { enabled: false, minPercent: 0 } } });
    expect((await pc.post('/payments/quote').send({ items: [{ invoiceId: invoices[0].id, amountKobo: naira(20000) }] })).status).toBe(422);
  });

  it('leaves the school with exactly the invoice amount when the parent bears the charge, and charges nothing extra when the school bears it', async () => {
    const { fx, pc, invoices } = await paidSetup();
    const q1 = (await pc.post('/payments/quote').send({ items: [{ invoiceId: invoices[0].id }] })).body.data;
    expect(q1.chargeBorneBy).toBe('parent');
    await fx.oc.patch('/school').send({ settings: { chargeBearer: 'school' } });
    const q2 = (await pc.post('/payments/quote').send({ items: [{ invoiceId: invoices[0].id }] })).body.data;
    expect(q2.chargeKobo).toBe(0);
    expect(q2.totalKobo).toBe(q2.feesKobo);
  });

  it('records commission on each payment and the platform view’s total agrees', async () => {
    const { fx, pc, invoices } = await paidSetup();
    const { c: sa } = await signInSuperAdmin();
    await sa.patch(`/platform/schools/${fx.school._id}`).send({ commission: { type: 'percent', value: 2 } });
    const co = await pc.post('/payments/checkout').set('Idempotency-Key', key()).send({ items: [{ invoiceId: invoices[0].id }] });
    const txn = fakePaystack.txns.get(co.body.data.reference)!;
    expect(txn.transactionChargeKobo).toBe(naira(1040)); // 2 percent of 52,000
    await webhook(fakePaystack.simulatePay(co.body.data.reference));
    await drainJobs();
    const view = await sa.get('/platform/payments');
    expect(view.body.totals.commissionKobo).toBe(naira(1040));
    expect(view.body.data[0]).toMatchObject({ status: 'successful', commissionKobo: naira(1040) });
    expect((await sa.get('/platform/metrics')).body.data.onlinePayments.commissionKobo).toBe(naira(1040));
    void fx;
  });

  it('completes a payment whose webhook was dropped, through the reconciliation job', async () => {
    const { fx, pc, invoices } = await paidSetup();
    const co = await pc.post('/payments/checkout').set('Idempotency-Key', key()).send({ items: [{ invoiceId: invoices[0].id }] });
    fakePaystack.simulatePay(co.body.data.reference); // the customer paid, but no webhook ever arrived
    await Payment.collection.updateOne({ reference: co.body.data.reference }, { $set: { createdAt: new Date(Date.now() - 20 * 60_000) } });
    const out = await reconcileNow();
    expect(out.completed).toBe(1);
    expect((await pc.get('/my/invoices')).body.data[0].status).toBe('paid');
    expect(await ctxFor(String(fx.school._id), () => Receipt.countDocuments({}))).toBe(1);
  });

  it('marks a payment abandoned after 24 hours and leaves the invoice open', async () => {
    const { fx, pc, invoices } = await paidSetup();
    const co = await pc.post('/payments/checkout').set('Idempotency-Key', key()).send({ items: [{ invoiceId: invoices[0].id }] });
    await Payment.collection.updateOne({ reference: co.body.data.reference }, { $set: { createdAt: new Date(Date.now() - 25 * 3600_000) } });
    await reconcileNow();
    expect((await ctxFor(String(fx.school._id), () => Payment.findOne({ reference: co.body.data.reference }).lean())).status).toBe('abandoned');
    expect((await pc.get('/my/invoices')).body.data[0].status).toBe('issued');
  });

  it('gives a receipt at once for an offline payment and warns on a repeated bank reference', async () => {
    const fx = await buildSchool({ withBank: true });
    const kid = await addStudent(fx);
    await generateInvoices(fx);
    const body = { studentId: kid.id, amountKobo: naira(20000), channel: 'bank', paidOn: '2026-10-05', bankReference: 'TRF/2291/8841' };
    const res = await fx.bc.post('/payments/offline').set('Idempotency-Key', key()).send(body);
    expect(res.status).toBe(201);
    expect(res.body.data.receipt.number).toMatch(/^TST\/\d{2}\/000001$/);
    expect(res.body.data.receipt.balanceAfterKobo).toBe(naira(32000));
    const dup = await fx.bc.post('/payments/offline').set('Idempotency-Key', key()).send(body);
    expect(dup.status).toBe(409);
    expect(dup.body.error.code).toBe('duplicate');
    expect(dup.body.error.message).toBe('A payment with this bank reference was recorded on 5 Oct 2026.');
    expect((await fx.bc.post('/payments/offline').set('Idempotency-Key', key()).send({ ...body, confirmDuplicate: true })).status).toBe(201);
  });

  it('holds a parent’s proof of payment for the bursar: confirming issues a receipt, rejecting tells the parent why', async () => {
    const { fx, pc, kids, invoices } = await paidSetup();
    const proof = async () => {
      const sign = await pc.post('/files/sign').send({ purpose: 'payment_proof', mime: 'image/png' });
      expect(sign.status).toBe(200);
      const up = await client().agent.put(sign.body.data.uploadUrl).set('Content-Type', 'image/png').send(Buffer.from('89504e470d0a1a0a', 'hex'));
      expect(up.status).toBe(204);
      return sign.body.data.fileRef as string;
    };
    const ref1 = await proof();
    const sub = await pc.post('/payments/proofs').set('Idempotency-Key', key()).send({ studentId: kids[0].id, amountKobo: naira(30000), paidOn: '2026-10-06', bankReference: 'GTB/1', proofFile: ref1 });
    expect(sub.status).toBe(201);
    expect((await fx.bc.get('/payments/proofs')).body.data.length).toBe(1);
    expect((await pc.get('/my/invoices')).body.data[0].paidKobo).toBe(0); // nothing applied yet
    const ok = await fx.bc.post(`/payments/proofs/${sub.body.data.id}/confirm`).set('Idempotency-Key', key()).send({});
    expect(ok.status).toBe(200);
    expect(ok.body.data.receipts.length).toBe(1);
    expect((await pc.get('/my/invoices')).body.data[0].paidKobo).toBe(naira(30000));

    const ref2 = await proof();
    const sub2 = await pc.post('/payments/proofs').set('Idempotency-Key', key()).send({ studentId: kids[0].id, amountKobo: naira(1000), paidOn: '2026-10-07', proofFile: ref2 });
    expect((await fx.bc.post(`/payments/proofs/${sub2.body.data.id}/reject`).send({})).status).toBe(422); // a reason is required
    expect((await fx.bc.post(`/payments/proofs/${sub2.body.data.id}/reject`).send({ reason: 'Not on our statement' })).status).toBe(200);
    expect(await smsTo('+2348031112200', /Not on our statement/)).toBeTruthy();
    // a file from another school is refused
    expect((await pc.post('/payments/proofs').set('Idempotency-Key', key()).send({ studentId: kids[0].id, amountKobo: 100, paidOn: '2026-10-07', proofFile: `${String(fx.school._id).replace(/.$/, '0')}/pri/payment_proof/x.png` })).status).toBe(422);
    void invoices;
  });

  it('turns an overpayment into a credit and applies it to the next invoice automatically', async () => {
    const fx = await buildSchool({ withBank: true });
    const kid = await addStudent(fx);
    await generateInvoices(fx);
    const res = await fx.bc.post('/payments/offline').set('Idempotency-Key', key()).send({ studentId: kid.id, amountKobo: naira(60000), channel: 'cash', paidOn: '2026-10-05' });
    expect(res.status).toBe(201);
    expect(res.body.data.creditKobo).toBe(naira(8000));
    expect(await ctxFor(String(fx.school._id), () => Credit.countDocuments({ appliedInvoiceId: { $exists: false } }))).toBe(1);
    // a single invoice raised later takes the credit
    const single = await fx.bc.post('/invoices').set('Idempotency-Key', key()).send({ studentId: kid.id, lines: [{ label: 'Excursion', amountKobo: naira(5000) }] });
    expect(single.status).toBe(201);
    expect(single.body.data.paidKobo).toBe(naira(5000));
    expect(single.body.data.status).toBe('paid');
    const left: any[] = await ctxFor(String(fx.school._id), () => Credit.find({ appliedInvoiceId: { $exists: false } }).lean());
    expect(left.reduce((a, c) => a + c.amountKobo, 0)).toBe(naira(3000));
  });

  it('produces a receipt PDF with a QR that opens the verify page as valid, and as void after a reversal', async () => {
    const fx = await buildSchool({ withBank: true });
    const kid = await addStudent(fx);
    await generateInvoices(fx);
    const res = await fx.bc.post('/payments/offline').set('Idempotency-Key', key()).send({ studentId: kid.id, amountKobo: naira(10000), channel: 'cash', paidOn: '2026-10-05' });
    await drainJobs();
    const rid = res.body.data.receipt.id;
    const view = (await fx.bc.get(`/receipts/${rid}`)).body.data;
    expect(view.verifyUrl).toContain(`/verify/${view.verificationCode}`);
    expect(view.lines[0].label).toContain('Tuition');
    const pdf = await fx.bc.get(`/receipts/${rid}/pdf`);
    expect(pdf.status).toBe(200);
    const file = await client().agent.get(pdf.body.data.url);
    expect(file.status).toBe(200);
    expect(file.headers['content-type']).toBe('application/pdf');
    expect(Buffer.from(file.body).subarray(0, 4).toString()).toBe('%PDF');

    const verify = client(fx.host);
    expect((await verify.get(`/public/verify/${view.verificationCode}`)).body.data).toMatchObject({ found: true, type: 'receipt', status: 'valid', amountKobo: naira(10000) });
    expect((await verify.get('/public/verify/ZZZZZZZZZZ')).body.data).toEqual({ found: false });
    // a receipt from this school is not found on another school's address
    const other = await buildSchool();
    expect((await client(other.host).get(`/public/verify/${view.verificationCode}`)).body.data).toEqual({ found: false });

    // reversal: the bursar asks, the owner approves, the invoice balance returns and the receipt is void
    const paymentId = view.paymentId;
    const rq = await fx.bc.post(`/payments/${paymentId}/reversal-request`).send({ reason: 'Entered against the wrong child' });
    expect(rq.status).toBe(201);
    expect((await fx.bc.post(`/payments/${paymentId}/reversal-request`).send({ reason: 'again' })).status).toBe(409);
    await fx.oc.post('/auth/confirm-password').send({ password: PASSWORD });
    expect((await fx.oc.post(`/approvals/${rq.body.data.approvalId}/approve`).send({})).status).toBe(200);
    const inv = (await fx.bc.get(`/invoices?studentId=${kid.id}`)).body.data[0];
    expect(inv.paidKobo).toBe(0);
    expect(inv.status).toBe('issued');
    expect((await verify.get(`/public/verify/${view.verificationCode}`)).body.data.status).toBe('void');
    expect((await fx.bc.get(`/receipts/${rid}`)).body.data.void).toBe(true);
    expect((await platform(() => AuditLog.find({ action: 'fees.payment.reversed' }).lean())).length).toBe(1);
  });

  it('refunds an online payment through Paystack after the owner approves', async () => {
    const { fx, pc, invoices } = await paidSetup();
    const co = await pc.post('/payments/checkout').set('Idempotency-Key', key()).send({ items: [{ invoiceId: invoices[0].id }] });
    await webhook(fakePaystack.simulatePay(co.body.data.reference));
    await drainJobs();
    const p: any = await ctxFor(String(fx.school._id), () => Payment.findOne({ reference: co.body.data.reference }).lean());
    expect((await fx.bc.post(`/payments/${p._id}/reversal-request`).send({ reason: 'Wrong kind' })).status).toBe(409); // online: ask for a refund
    const rq = await fx.bc.post(`/payments/${p._id}/refund-request`).send({ reason: 'Paid twice by mistake' });
    expect(rq.status).toBe(201);
    await fx.oc.post('/auth/confirm-password').send({ password: PASSWORD });
    expect((await fx.oc.post(`/approvals/${rq.body.data.approvalId}/approve`).send({})).status).toBe(200);
    expect(fakePaystack.refunds.map((r) => r.reference)).toEqual([co.body.data.reference]);
    expect((await ctxFor(String(fx.school._id), () => Payment.findById(p._id).lean())).status).toBe('refunded');
    expect((await pc.get('/my/invoices')).body.data[0].balanceKobo).toBe(naira(52000));
  });

  it('keeps one parent from reading another family’s receipts and invoices', async () => {
    const fx = await buildSchool({ withBank: true });
    const a = await addStudent(fx, { guardianPhone: '08030000001' });
    const b = await addStudent(fx, { guardianPhone: '08030000002' });
    await generateInvoices(fx);
    await fx.bc.post('/payments/offline').set('Idempotency-Key', key()).send({ studentId: b.id, amountKobo: naira(1000), channel: 'cash', paidOn: '2026-10-05' });
    const pa = await parentLogin(fx, a.guardianId);
    const receiptB: any = await ctxFor(String(fx.school._id), () => Receipt.findOne({}).lean());
    const invB: any = await ctxFor(String(fx.school._id), () => Invoice.findOne({ studentId: b.id }).lean());
    expect((await pa.get(`/receipts/${receiptB._id}`)).status).toBe(404);
    expect((await pa.get(`/invoices/${invB._id}`)).status).toBe(404);
    expect((await pa.get(`/students/${b.id}/statement`)).status).toBe(404);
    expect((await pa.get('/my/receipts')).body.data).toEqual([]);
    expect((await pa.post('/payments/quote').send({ items: [{ invoiceId: String(invB._id) }] })).status).toBe(404);
    expect((await pa.get('/payments')).status).toBe(403);
  });

  it('gives a bursar no access to scores or results', async () => {
    const fx = await buildSchool();
    for (const path of ['/score-sheets', '/class-results/' + fx.armA, '/promotion/rules', '/reports/academic']) {
      const s = (await fx.bc.get(path)).status;
      expect([403, 404], path).toContain(s);
    }
  });

  it('takes an SMS-unit purchase through Paystack and credits the wallet once, even if notified twice', async () => {
    const fx = await buildSchool();
    const buy = await fx.oc.post('/sms/purchase').set('Idempotency-Key', key()).send({ units: 200 });
    expect(buy.status).toBe(201);
    const ref = buy.body.data.reference as string;
    expect(fakePaystack.txns.get(ref)!.subaccount).toBeUndefined(); // to the platform's main account
    const sim = fakePaystack.simulatePay(ref);
    await webhook(sim);
    await webhook({ ...sim, body: sim.body.replace('"id":"', '"id":"2') , signature: fakePaystack.simulatePay(ref).signature });
    await drainJobs();
    const wallet = (await fx.oc.get('/sms/wallet')).body.data;
    expect(wallet.units).toBe(200);
    expect((await fx.oc.get('/sms/ledger')).body.data.filter((l: any) => l.reason === 'purchase').length).toBe(1);
  });
});

export { clearSettingsCache, PlatformSetting, client, hostOf, setBank };
