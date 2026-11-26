// The only functions the conversation engine (and Groq, indirectly) can use to read or change anything. Each one is bound to ONE hotel when created,
// every query filters by that hotel, and every number (availability, price, payment state) comes from the existing KeyKonnec services.
const D = require('../models'), inv = require('../inventory'), bill = require('../billing'), pricing = require('../pricing'), alerts = require('../alerts'), mail = require('../mail');
const bookings = require('../bookingService'), W = require('./models'), nlu = require('./nlu'), receipt = require('./receipt');

const toDate = (iso) => new Date(iso + 'T00:00:00Z');
const phoneKey = (p) => String(p || '').replace(/\D/g, '').slice(-10);

exports.make = (account) => {
  const hotelId = account.hotel;
  const load = async () => {
    const [h, ent] = await Promise.all([D.Hotel.findById(hotelId), bill.entitlements(hotelId)]);
    if (!h || h.status !== 'active') throw bookings.fail(403, 'Hotel unavailable');
    return { h, ent };
  };
  const typeView = (t) => ({ id: String(t._id), name: t.name, capacity: t.capacity, price: t.price, description: t.description, amenities: t.amenities || [], images: (t.images || []).map((i) => i.url).filter((u) => /^https:\/\//.test(u || '')), minStay: t.minStay, maxStay: t.maxStay, category: t.category, bedType: t.bedType, beds: t.beds, size: t.size });
  const tools = {
    async bookingAllowed() { const { ent, h } = await load(); return ent.plan.features.includes('whatsapp_automation') && account.settings.booking !== false && !!h; },
    async hotelInfo() {
      const { h, ent } = await load(), site = (h.website && h.website.status === 'published' && h.website.published) || {}, c = site.contact || {};
      return { id: String(h._id), name: h.name, address: c.address || h.address, phone: c.phone || h.phone, email: c.email, whatsapp: c.whatsapp, hours: c.hours, description: site.about && site.about.body, amenities: site.amenities || [], policies: { ...(h.policies && (h.policies.toObject ? h.policies.toObject() : h.policies)), cancellation: (site.policies && site.policies.cancellation) || (h.policies && h.policies.cancellation) }, currency: h.currency, online: bookings.isOnline(h, ent), holdMinutes: h.holdMinutes, slug: h.slug, siteUrl: process.env.CLIENT_URL ? `${String(process.env.CLIENT_URL).replace(/\/+$/, '')}/h/${h.slug}` : null };
    },
    async listRoomTypes() { return (await D.RoomType.find({ hotel: hotelId, active: true }).sort({ price: 1 }).limit(50).lean()).map(typeView); },
    async getRoomDetails(typeId) { const t = await D.RoomType.findOne({ _id: typeId, hotel: hotelId, active: true }).lean(); return t ? typeView(t) : null; },
    // Genuinely available room types for the stay, priced by the existing pricing engine. Never cached.
    async searchAvailableRooms({ checkIn, checkOut, adults = 1, children = 0, rooms = null, suggest = true }) {
      const { h, ent } = await load(), a = toDate(checkIn), b = toDate(checkOut), persons = adults + (children || 0);
      const run = async (from, to) => {
        const list = await bookings.listAvailability({ h, ent, checkIn: from, checkOut: to }), options = [], restricted = [];
        for (const t of list) {
          const need = rooms || Math.max(1, Math.ceil(persons / (t.capacity || 1)));
          if (t.restriction) { restricted.push({ name: t.name, reason: t.restriction }); continue; }
          if (need > 5 || t.capacity * need < persons || t.available < need) continue;
          const type = await D.RoomType.findById(t.id).lean();
          const k = await pricing.quote({ hotel: h, plan: ent.plan, type, checkIn: from, checkOut: to, qty: need });
          options.push({ typeId: t.id, name: t.name, capacity: t.capacity, qty: need, left: t.available, nights: k.nights, total: k.total, perNight: Math.round(k.subtotal / k.nights / need), description: t.description, images: (t.images || []).map((i) => i.url).filter((u) => /^https:\/\//.test(u || '')) });
        }
        return { options, restricted };
      };
      const res = await run(a, b);
      if (res.options.length || !suggest) return res;
      const nights = Math.round((b - a) / 864e5), alternatives = [];
      for (let d = 1; d <= 7 && alternatives.length < 3; d++) { const f = new Date(+a + d * 864e5), t2 = new Date(+f + nights * 864e5); const r2 = await run(f, t2); if (r2.options.length) alternatives.push({ checkIn: nlu.iso(f), checkOut: nlu.iso(t2), from: Math.min(...r2.options.map((o) => o.total)) }); }
      return { ...res, alternatives };
    },
    // The authoritative price for one room type and stay (same function the website uses).
    async calculateBookingPrice({ typeId, checkIn, checkOut, qty = 1 }) {
      const { h, ent } = await load(), type = await D.RoomType.findOne({ _id: typeId, hotel: hotelId, active: true });
      if (!type) return null;
      const k = await pricing.quote({ hotel: h, plan: ent.plan, type, checkIn: toDate(checkIn), checkOut: toDate(checkOut), qty });
      return { ...k, left: await inv.freeRooms(type._id, toDate(checkIn), toDate(checkOut)), currency: h.currency, hotelName: h.name, typeName: type.name, capacity: type.capacity, dueDate: undefined, promoId: undefined };
    },
    // A guest's own bookings: matched on the WhatsApp number WhatsApp itself verified, plus bookings made in this conversation or verified by reference + email.
    async getGuestBookings(waId, linkedIds = []) {
      const k = phoneKey(waId), re = new RegExp(k.split('').join('\\D*') + '\\D*$');
      const rows = await D.Reservation.find({ hotel: hotelId, $or: [{ 'guest.phone': re }, ...(linkedIds.length ? [{ _id: { $in: linkedIds } }] : [])] }).sort({ createdAt: -1 }).limit(12).lean();
      const linked = new Set(linkedIds.map(String));
      return rows.filter((r) => linked.has(String(r._id)) || nlu.normPhone(r.guest && r.guest.phone) === waId);
    },
    async getGuestProfile(waId) {
      const r = (await tools.getGuestBookings(waId)).find((x) => x.guest && x.guest.name && x.guest.email);
      return r ? { name: r.guest.name, email: r.guest.email, roomTypeId: String(r.roomType) } : null;
    },
    async getBookingStatus(reservationId) {
      const r = await D.Reservation.findOne({ _id: reservationId, hotel: hotelId });
      if (!r) return null;
      const [t, p, rp] = await Promise.all([D.RoomType.findById(r.roomType).select('name').lean(), D.Payment.findOne({ reservation: r._id }).sort({ createdAt: -1 }).lean(), receipt.payment(r)]);
      return { id: String(r._id), reference: r.reference, status: r.status, paymentStatus: r.paymentStatus, paid: r.paid, total: r.total, currency: r.currency, checkIn: nlu.iso(r.checkIn), checkOut: nlu.iso(r.checkOut), adults: r.adults, qty: r.qty, typeName: t && t.name, guestName: r.guest.name, paymentRef: p && p.reference, receiptUrl: rp ? receipt.url(r) : null, balance: Math.max(0, r.total - r.paid) };
    },
    // Looks up a booking by reference for verification: the guest must also give the email on the booking.
    async verifyByReference(reference, email) {
      const r = await D.Reservation.findOne({ hotel: hotelId, reference });
      return r && r.guest && r.guest.email && r.guest.email.toLowerCase() === String(email || '').toLowerCase() ? String(r._id) : null;
    },
    async createPendingBooking(d) {
      const { h, ent } = await load();
      const notes = [d.children ? `Children: ${d.children}` : '', d.special ? `Special requests: ${d.special}` : '', d.arrival ? `Arrival: ${d.arrival}` : '', d.altPhone ? `Alt phone: ${d.altPhone}` : '', 'Booked via WhatsApp'].filter(Boolean).join('. ');
      const out = await bookings.createBooking({ h, ent, channel: 'whatsapp_auto', b: { roomType: d.typeId, checkIn: toDate(d.checkIn), checkOut: toDate(d.checkOut), adults: d.adults, qty: d.qty || 1, marketingConsent: false, notes, guest: { name: d.name, email: d.email, phone: '+' + d.phone } } });
      return { id: String(out.reservation._id), reference: out.reference, status: out.status, payUrl: out.checkoutUrl || null, payRef: out.payment && out.payment.reference, total: out.quote.total, deposit: out.quote.deposit, expiresAt: out.expiresAt || null, message: out.message };
    },
    // Asks Paystack directly. Only a verified successful payment settles the booking (the same settle() the webhook uses); a guest's claim never does.
    async verifyPayment(reservationId) {
      const r0 = await D.Reservation.findOne({ _id: reservationId, hotel: hotelId });
      if (!r0) return null;
      const p = await D.Payment.findOne({ reservation: r0._id, source: 'platform', status: { $in: ['pending', 'flagged', 'failed'] } }).sort({ createdAt: -1 });
      if (p) { try { await bill.settle(p.reference, await bill.verify(p.reference)); } catch { /* Paystack has no record yet */ } }
      const r = await D.Reservation.findById(r0._id);
      return { confirmed: ['confirmed', 'checked_in'].includes(r.status) && r.paid > 0, status: r.status, expired: ['expired', 'cancelled'].includes(r.status) };
    },
    async cancelPending(reservationId) { return !!(await bookings.cancelUnpaid(reservationId, hotelId)); },
    // Cancelling a paid booking is never automatic: it becomes an approval for the owner, exactly like a staff cancellation of a paid booking.
    async requestCancellation(reservationId) {
      const r = await D.Reservation.findOne({ _id: reservationId, hotel: hotelId });
      if (!r) return { error: 'not_found' };
      if (['cancelled', 'expired', 'no_show', 'checked_out'].includes(r.status)) return { error: 'closed', status: r.status };
      if (r.paid === 0 && ['pending', 'requested'].includes(r.status)) return { done: await bookings.cancelUnpaid(r._id, hotelId) ? true : false };
      const dup = await D.Approval.findOne({ hotel: hotelId, action: 'cancel', status: 'pending', 'payload.reservation': r._id });
      if (!dup) await D.Approval.create({ hotel: hotelId, action: 'cancel', payload: { reservation: r._id, via: 'whatsapp' } });
      await alerts.inapp(hotelId, r._id, 'booking', `Cancellation requested on WhatsApp: ${r.guest.name}`, `${r.reference} · open Integrations to approve or reject. Refunds follow your cancellation policy.`, '/dashboard/settings?tab=integrations').catch(() => {});
      const { to } = await alerts.recipients(hotelId); if (to.length) mail.send(to, 'A guest asked to cancel on WhatsApp', mail.tpl('Cancellation request', [`${r.guest.name} asked to cancel ${r.reference} through WhatsApp.`, 'Open Integrations in your dashboard to approve or reject it.']), hotelId);
      return { pendingApproval: true };
    },
    // Preview of a date change using the existing pricing and inventory, and (once the guest confirms) an approval for staff to apply it with the existing modify logic.
    async previewModification(reservationId, checkIn, checkOut) {
      const { h, ent } = await load(), r = await D.Reservation.findOne({ _id: reservationId, hotel: hotelId });
      if (!r || !['confirmed', 'requested'].includes(r.status)) return { error: 'not_modifiable' };
      const type = await D.RoomType.findById(r.roomType), a = toDate(checkIn), b = toDate(checkOut);
      let k; try { k = await pricing.quote({ hotel: h, plan: ent.plan, type, checkIn: a, checkOut: b, qty: r.qty, manual: true }); } catch (e) { return { error: 'rule', message: e.message }; }
      const old = new Set(inv.nightsOf(r.checkIn, r.checkOut).map((d) => +d));
      for (const d of inv.nightsOf(a, b)) if (!old.has(+d) && await inv.freeRooms(type._id, d, new Date(+d + 864e5)) < r.qty) return { error: 'unavailable' };
      return { newTotal: k.total, oldTotal: r.total, diff: Math.round((k.total - r.total) * 100) / 100, nights: k.nights, currency: r.currency, paid: r.paid };
    },
    async requestModification(reservationId, checkIn, checkOut) {
      const r = await D.Reservation.findOne({ _id: reservationId, hotel: hotelId });
      if (!r) return { error: 'not_found' };
      await D.Approval.create({ hotel: hotelId, action: 'modify', payload: { reservation: r._id, checkIn, checkOut, qty: r.qty, notes: 'Requested by guest on WhatsApp', via: 'whatsapp' } });
      await alerts.inapp(hotelId, r._id, 'booking', `Date change requested on WhatsApp: ${r.guest.name}`, `${r.reference} · ${checkIn} to ${checkOut}. Open Integrations to approve or reject.`, '/dashboard/settings?tab=integrations').catch(() => {});
      const { to } = await alerts.recipients(hotelId); if (to.length) mail.send(to, 'A guest asked to change dates on WhatsApp', mail.tpl('Date change request', [`${r.guest.name} asked to move ${r.reference} to ${checkIn} – ${checkOut}.`, 'Open Integrations in your dashboard to approve or reject it.']), hotelId);
      return { pendingApproval: true };
    },
    // Hands the guest to a person: flags the conversation and alerts the hotel (the engine flips the conversation to human mode).
    async requestHumanAssistance(conv, reason) {
      await alerts.inapp(hotelId, null, 'whatsapp', 'A guest on WhatsApp needs a person', `${conv.profileName || '+' + conv.waId}: ${reason || 'asked to speak with someone'}`, '/dashboard/whatsapp/inbox').catch(() => {});
      const { to } = await alerts.recipients(hotelId); if (to.length) mail.send(to, 'A WhatsApp guest is waiting for you', mail.tpl('Guest needs a person', [`${conv.profileName || '+' + conv.waId} asked to speak with the team on WhatsApp.`, { button: ['Open the inbox', `${process.env.CLIENT_URL}/dashboard/whatsapp/inbox`] }]), hotelId);
    },
    // One notification of each kind per reservation, ever. Claiming it first stops the event listener from repeating what the chat already told the guest.
    async claimNotice(reservationId, kind) { try { await W.WaNotice.create({ hotel: hotelId, reservation: reservationId, kind, key: `${reservationId}:${kind}` }); return true; } catch (e) { if (e.code === 11000) return false; throw e; } },
    receiptUrl: receipt.url,
  };
  return tools;
};
