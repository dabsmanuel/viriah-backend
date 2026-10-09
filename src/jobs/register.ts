/**
 * Importing a module registers its job processors. Both the API (inline mode) and the worker import this file.
 * Keep the list in sync with Document 3, section 12.2.
 */
import '../services/notify'; // send-sms, send-email
import '../services/setup'; // go-live
import '../services/fees'; // generate-invoices, notify-invoices
import '../services/comms'; // fee-reminders
import '../services/admissions'; // expire-offers
import '../services/results'; // compile-class-result, generate-report-cards
import '../services/tasks';
import '../services/exports'; // export-data
import '../services/retention'; // cleanup
import '../services/imports'; // import-validate, import-commit
import '../services/promotion'; // build-annual-results, session-rollover
import '../services/payments'; // paystack-event, reconcile-payments, generate-receipt-pdf
