// Booking notifications by WhatsApp and email, triggered only by real backend events (verified payment, cancellation, modification, refund, check-in dates).
// Each notification is claimed once per reservation (WaNotice unique key), so duplicate Paystack webhooks or repeated cron runs can never send twice.
const D = require('../models'), hooks = require('../hooks'), mail = require('../mail'), E = require('../emails'), alerts = require('../alerts');
const W = require('./models'), send = require('./send'), receipt = require('./receipt'), nlu = require('./nlu'), templates = require('./templates');

const naira = (n, cur) => (!cur || cur === 'NGN' ? '₦' : cur + ' ') + Number(n || 0).toLocaleString('en-NG');
const first = (n) => String(n || '').trim().split(/\s+/)[0] || 'there';
const hd = (d) => nlu.human(d);
const okEmail = (e) => nlu.validEmail(e);

async function context(r) {
  const waId = nlu.normPhone(r.guest && r.guest.phone);
  const account = await W.WaAccount.findOne({ hotel: r.hotel, status: 'connected' });
  const conv = account && waId ? await W.WaConversation.findOne({ hotel: r.hotel, waId }) : null;
  return { account, conv, waId };
}
const claim = async (r, key) => { try { await W.WaNotice.create({ hotel: r.hotel, reservation: r._id, kind: key.split(':')[0], key: `${r._id}:${key}` }); return true; } catch (e) { if (e.code === 11000) return false; throw e; } };
const mark = (r, key, patch) => W.WaNotice.updateOne({ key: `${r._id}:${key}` }, patch).catch(() => {});
const allowed = (ctx, flag) => ctx.account && ctx.account.settings.automation !== false && ctx.account.settings[flag] !== false && ctx.conv && !ctx.conv.optedOut;

async function whatsapp(r, ctx, flag, key, payload, opts) {
  if (!allowed(ctx, flag)) return 'skipped';
  const res = await send.sendOne(ctx.account, ctx.conv, payload, { by: 'system', reservation: r._id, ...opts });
  return res.ok ? 'sent' : `failed: ${res.reason}`;
}

// ---- payment confirmed: WhatsApp message + email with the existing receipt (link, and the PDF attached)
async function confirmation(r, { whatsapp: wa = true, email = true, force = false } = {}) {
  const p = await receipt.payment(r);
  if (!p) return { error: 'No verified payment for this reservation' };   // never confirm or send a receipt for an unverified payment
  if (!force && !(await claim(r, 'confirmed'))) return { duplicate: true };
  const [h, t, ctx] = await Promise.all([D.Hotel.findById(r.hotel).lean(), D.RoomType.findById(r.roomType).lean(), context(r)]);
  const url = receipt.url(r), nights = Math.max(1, Math.round((r.checkOut - r.checkIn) / 864e5)), out = {};
  const hasEmail = okEmail(r.guest.email);
  if (email && hasEmail) {
    let attachments;
    try { attachments = [{ filename: `receipt-${p.reference}.pdf`, content: (await receipt.buffer(r, p)).toString('base64') }]; } catch (e) { console.error('receipt pdf:', e.message); }
    const m = E.guestConfirmed({ hotel: h, r, type: t, payment: p, receiptUrl: url });
    const to = (await alerts.recipients(r.hotel)).to[0];
    out.email = await mail.send(r.guest.email, m.subject, m.html, r.hotel, { replyTo: to, attachments });   // a failed email never touches the paid reservation
  }
  if (wa) {
    const body = [`Hello ${first(r.guest.name)}! 🎉`, '', 'Your payment has been confirmed and your reservation is now confirmed.', '', '🏨 BOOKING CONFIRMATION', '',
      `Property: ${h.name}`, `Booking Reference: ${r.reference}`, '', `Guest: ${r.guest.name}`, `Room: ${(t && t.name) || 'Room'}${r.qty > 1 ? ' × ' + r.qty : ''}`, '', `Check-in: ${hd(r.checkIn)}`, `Check-out: ${hd(r.checkOut)}`, `Duration: ${nights} night${nights > 1 ? 's' : ''}`, `Guests: ${r.adults || 1} adult${(r.adults || 1) > 1 ? 's' : ''}`, '',
      `Amount Paid: ${naira(p.amount, r.currency)}`, 'Payment Status: Successful', r.total > r.paid ? `Balance remaining: ${naira(r.total - r.paid, r.currency)}` : '', '',
      url ? '📄 Use the button below to download your payment receipt.' : '', hasEmail && email ? 'A copy of your booking confirmation and payment receipt will also be sent to your email address.' : '', '', 'Thank you for choosing us. We look forward to hosting you!'].filter((x, i, a) => x !== '' || a[i - 1] !== '').join('\n');
    out.whatsapp = await whatsapp(r, ctx, 'notifyPayment', 'confirmed', url ? { kind: 'cta', text: body.slice(0, 1024), label: 'Download receipt', url } : { kind: 'text', text: body },
      { notice: 'payment_confirmed', params: [first(r.guest.name), r.reference, h.name, hd(r.checkIn), url || 'available from the hotel'], preview: r.reference });
    if (ctx.conv && out.whatsapp === 'sent') await W.WaConversation.updateOne({ _id: ctx.conv._id }, { state: 'BOOKING_CONFIRMED', 'ctx.payUrl': null });
  }
  if (!force) await mark(r, 'confirmed', { whatsapp: out.whatsapp, email: out.email });
  return out;
}

const load = async (hotel, filter) => { const r = await D.Reservation.findOne({ hotel, ...filter }); return r && r.channel === 'whatsapp_auto' ? r : null; };

async function onEvent(hotel, event, data) {
  if (event === 'reservation.confirmed') { const r = await load(hotel, { reference: data.reference }); return r && confirmation(r); }
  if (event === 'payment.failed') {
    const r = await load(hotel, { _id: data.reservationId }); if (!r || !['pending'].includes(r.status) || !(await claim(r, `payissue:${data.paymentReference}`))) return;
    const [h, ctx] = await Promise.all([D.Hotel.findById(r.hotel).lean(), context(r)]), url = ctx.conv && ctx.conv.ctx && ctx.conv.ctx.payUrl;
    const text = `We could not confirm your payment for reservation ${r.reference}. Please contact the hotel or try the payment link again.`;
    return mark(r, `payissue:${data.paymentReference}`, { whatsapp: await whatsapp(r, ctx, 'notifyPayment', 'payissue', url ? { kind: 'cta', text, label: 'Try again', url } : { kind: 'text', text }, { notice: 'payment_issue', params: [first(r.guest.name), r.reference, h.name], preview: r.reference }) });
  }
  if (event === 'reservation.cancelled') {
    const r = await load(hotel, { reference: data.reference }); if (!r || !(await claim(r, 'cancelled'))) return; const [h, ctx] = await Promise.all([D.Hotel.findById(r.hotel).lean(), context(r)]);
    return mark(r, 'cancelled', { whatsapp: await whatsapp(r, ctx, 'notifyBooking', 'cancelled', { kind: 'text', text: `Your reservation ${r.reference} at ${h.name} has been cancelled.${r.paid > 0 ? ' If a refund applies, the hotel will update you.' : ''}` }, { notice: 'cancelled', params: [first(r.guest.name), r.reference, h.name], preview: r.reference }) });
  }
  if (event === 'reservation.modified') {
    const r = await load(hotel, { reference: data.reference }); if (!r) return; const key = `modified:${nlu.iso(r.checkIn)}:${nlu.iso(r.checkOut)}:${r.qty}:${r.total}`; if (!(await claim(r, key))) return;
    const [h, ctx] = await Promise.all([D.Hotel.findById(r.hotel).lean(), context(r)]);
    return mark(r, key, { whatsapp: await whatsapp(r, ctx, 'notifyBooking', 'modified', { kind: 'text', text: `Your booking details have been updated successfully.\n\nReservation: ${r.reference}\nCheck-in: ${hd(r.checkIn)}\nCheck-out: ${hd(r.checkOut)}\nTotal: ${naira(r.total, r.currency)}${r.total > r.paid ? `\nBalance: ${naira(r.total - r.paid, r.currency)}` : ''}` }, { notice: 'modified', params: [first(r.guest.name), r.reference, h.name, hd(r.checkIn), hd(r.checkOut)], preview: r.reference }) });
  }
  if (event === 'refund.processed') {
    const r = await load(hotel, { reference: data.reference }); if (!r || !data.refundReference) return; const key = `refund:${data.refundReference}`; if (!(await claim(r, key))) return;
    const [h, ctx] = await Promise.all([D.Hotel.findById(r.hotel).lean(), context(r)]);
    return mark(r, key, { whatsapp: await whatsapp(r, ctx, 'notifyPayment', 'refund', { kind: 'text', text: `Your refund of ${naira(data.amount, r.currency)} has been processed successfully. Reference: ${data.refundReference}.` }, { notice: 'refund', params: [first(r.guest.name), naira(data.amount, r.currency), r.reference, h.name, data.refundReference], preview: r.reference }) });
  }
}

// Reminders: once a day per hotel at the configured local hour. The day-before and same-day messages each go out once.
async function reminders() {
  const s = await W.settings();
  for (const account of await W.WaAccount.find({ status: 'connected', 'settings.notifyReminders': { $ne: false }, 'settings.automation': { $ne: false } }).limit(1000)) {
    const tz = account.settings.timezone || 'Africa/Lagos';
    let hour; try { hour = +new Intl.DateTimeFormat('en-GB', { timeZone: tz, hour: '2-digit', hour12: false }).format(new Date()); } catch { continue; }
    if (hour !== (s.reminderHour ?? 8)) continue;
    const today = nlu.todayIn(tz), tomorrow = nlu.addDays(today, 1);
    for (const [date, kind, tpl, text] of [[tomorrow, 'reminder', 'reminder', (r, h) => `Your check-in date is approaching. We look forward to welcoming you.\n\n${h.name}\nReservation: ${r.reference}\nCheck-in: ${hd(r.checkIn)}${h.policies && h.policies.checkInTime ? ' from ' + h.policies.checkInTime : ''}`], [today, 'checkin_today', 'checkin_today', (r, h) => `Your check-in is scheduled for today. Please contact the hotel if you need assistance.\n\n${h.name}${h.phone ? '\nPhone: ' + h.phone : ''}\nReservation: ${r.reference}`]]) {
      for (const r of await D.Reservation.find({ hotel: account.hotel, channel: 'whatsapp_auto', status: 'confirmed', checkIn: date }).limit(500)) {
        if (!(await claim(r, kind))) continue;
        const [h, ctx] = await Promise.all([D.Hotel.findById(r.hotel).lean(), context(r)]);
        const params = kind === 'reminder' ? [first(r.guest.name), h.name, hd(r.checkIn), r.reference] : [first(r.guest.name), h.name, r.reference];
        await mark(r, kind, { whatsapp: await whatsapp(r, ctx, 'notifyReminders', kind, { kind: 'text', text: text(r, h) }, { notice: tpl, params, preview: r.reference }) });
      }
    }
  }
}

exports.init = () => hooks.on((hotel, event, data) => onEvent(hotel, event, data));
exports.confirmation = confirmation;
exports.reminders = reminders;
exports._onEvent = onEvent;
