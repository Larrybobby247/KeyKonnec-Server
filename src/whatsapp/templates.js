// Message templates for events that can happen after Meta's 24 hour customer-service window has closed (reminders, a payment that clears later).
// KeyKonnec submits these (utility category) to each hotel's own WhatsApp Business account; Meta approves them. Until approved, those messages are not sent by WhatsApp
// (the email still goes out) and the gap is logged. Inside the 24 hour window the richer free-form text from notify.js is used instead.
const NAMES = {
  payment_pending: 'kk_payment_pending', payment_confirmed: 'kk_payment_confirmed', payment_issue: 'kk_payment_issue', reminder: 'kk_checkin_reminder',
  checkin_today: 'kk_checkin_today', modified: 'kk_booking_updated', cancel_requested: 'kk_cancellation_received', cancelled: 'kk_booking_cancelled', refund: 'kk_refund_processed',
};
// {{n}} placeholders; `example` values are required by Meta when a template has variables.
const DEFS = [
  ['payment_pending', 'Hello {{1}}, your reservation {{2}} at {{3}} has been created. Please complete your payment to confirm it: {{4}}', ['Ada', 'KK-1A2B3C4D', 'Example Hotel', 'https://example.com/pay']],
  ['payment_confirmed', 'Hello {{1}}, your payment has been confirmed and your reservation {{2}} at {{3}} is now confirmed. Check-in: {{4}}. Your receipt: {{5}}', ['Ada', 'KK-1A2B3C4D', 'Example Hotel', '10 December 2026', 'https://example.com/receipt']],
  ['payment_issue', 'Hello {{1}}, we could not confirm your payment for reservation {{2}} at {{3}}. Please contact the hotel or try your payment link again.', ['Ada', 'KK-1A2B3C4D', 'Example Hotel']],
  ['reminder', 'Hello {{1}}, your check-in at {{2}} is on {{3}} (reservation {{4}}). We look forward to welcoming you.', ['Ada', 'Example Hotel', '10 December 2026', 'KK-1A2B3C4D']],
  ['checkin_today', 'Hello {{1}}, your check-in at {{2}} is scheduled for today (reservation {{3}}). Please contact the hotel if you need assistance.', ['Ada', 'Example Hotel', 'KK-1A2B3C4D']],
  ['modified', 'Hello {{1}}, your reservation {{2}} at {{3}} has been updated. New dates: {{4}} to {{5}}.', ['Ada', 'KK-1A2B3C4D', 'Example Hotel', '10 December 2026', '13 December 2026']],
  ['cancel_requested', 'Hello {{1}}, your cancellation request for reservation {{2}} at {{3}} has been received. Our team will update you once it has been processed.', ['Ada', 'KK-1A2B3C4D', 'Example Hotel']],
  ['cancelled', 'Hello {{1}}, your reservation {{2}} at {{3}} has been cancelled.', ['Ada', 'KK-1A2B3C4D', 'Example Hotel']],
  ['refund', 'Hello {{1}}, your refund of {{2}} for reservation {{3}} at {{4}} has been processed. Reference: {{5}}', ['Ada', 'NGN 195,000', 'KK-1A2B3C4D', 'Example Hotel', 'rf_123abc']],
];
exports.NAMES = NAMES;
exports.definitions = (language = 'en') => DEFS.map(([key, text, example]) => ({ key, name: NAMES[key], language, category: 'UTILITY', components: [{ type: 'BODY', text, example: { body_text: [example] } }] }));
exports.approved = (account, key) => (account.templates || []).some((t) => t.name === NAMES[key] && t.status === 'APPROVED');
exports.languageOf = (account, key) => ((account.templates || []).find((t) => t.name === NAMES[key] && t.status === 'APPROVED') || {}).language || 'en';
