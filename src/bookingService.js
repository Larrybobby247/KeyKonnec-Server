// Booking and availability logic that used to live inside the public website's route handlers, moved here unchanged so the website
// and WhatsApp share ONE booking engine: same pricing, same inventory allocation, same holds, same Paystack checkout, same commission split.
// The routes in extra2.js now call these functions; nothing here is specific to WhatsApp except the optional `channel` label on the reservation.
const crypto = require('crypto');
const D = require('./models'), inv = require('./inventory'), bill = require('./billing'), pricing = require('./pricing'), hooks = require('./hooks'), alerts = require('./alerts');
const hex = (n) => crypto.randomBytes(n).toString('hex'), r2 = (n) => Math.round(n * 100) / 100;
const fail = (status, message) => Object.assign(new Error(message), { status });
exports.fail = fail;

// Is the hotel able to take card payments online (plan + payout account)?
exports.isOnline = (h, ent) => ent.plan.features.includes('online_payments') && !!h.payout && !!h.payout.subaccountCode;

// Every active room type with the price for the stay and how many are genuinely free. A type that breaks a stay rule reports why instead.
exports.listAvailability = async ({ h, ent, checkIn, checkOut, branch }) => {
  if (checkOut <= checkIn) throw fail(400, 'Check-out must be after check-in');
  const f = { hotel: h.id, active: true }; if (branch) f.branch = branch;
  return Promise.all((await D.RoomType.find(f)).map(async (t) => {
    const o = { id: t.id, name: t.name, capacity: t.capacity, description: t.description, images: t.images, featured: t.featured };
    try { const k = await pricing.quote({ hotel: h, plan: ent.plan, type: t, checkIn, checkOut }); return { ...o, nights: k.nights, unitTotal: k.total, available: await inv.freeRooms(t._id, checkIn, checkOut) }; }
    catch (e) { if (e.status !== 400) throw e; return { ...o, available: 0, restriction: e.message }; }
  }));
};

// Creates the reservation, reserves inventory, starts the hold and (when the hotel takes online payments) the Paystack checkout.
// b: {roomType, checkIn, checkOut, adults, qty, promo, recover, marketingConsent, guest:{name,email,phone}}   opts: {channel}
exports.createBooking = async ({ h, ent, b, channel }) => {
  const t = await D.RoomType.findOne({ _id: b.roomType, hotel: h.id, active: true });
  if (!t || b.checkIn < new Date(Date.now() - 864e5)) throw fail(400, 'Invalid request');
  if (b.adults > t.capacity * b.qty) throw fail(400, 'Too many guests for this room');
  const { plan, sub } = ent, online = exports.isOnline(h, ent);
  if (plan.monthlyBookings) { const m = new Date(); m.setUTCDate(1); m.setUTCHours(0, 0, 0, 0); if (await D.Reservation.countDocuments({ hotel: h.id, createdAt: { $gte: m } }) >= plan.monthlyBookings) throw fail(402, 'This hotel is not accepting new online bookings right now. Please contact the hotel.'); }
  const k = await pricing.quote({ hotel: h, plan, type: t, checkIn: b.checkIn, checkOut: b.checkOut, qty: b.qty, promo: b.promo });
  try { await inv.reserve(t._id, b.checkIn, b.checkOut, b.qty); } catch (e) { throw e.message === 'SOLD_OUT' ? fail(409, 'Sorry, that room was just taken. Try other dates or another room.') : e; }
  if (k.promoId && !await D.Promo.findOneAndUpdate({ _id: k.promoId, $expr: { $or: [{ $not: ['$maxUses'] }, { $lt: ['$used', '$maxUses'] }] } }, { $inc: { used: 1 } })) { await inv.release(t._id, inv.nightsOf(b.checkIn, b.checkOut), b.qty); throw fail(409, 'That code has just run out'); }
  const ref = 'KK-' + hex(4).toUpperCase(), token = hex(24);
  const r = await D.Reservation.create({ hotel: h.id, branch: t.branch, roomType: t.id, guest: b.guest, checkIn: b.checkIn, checkOut: b.checkOut, adults: b.adults, qty: b.qty, accommodation: k.accommodation, discount: k.discount, promoCode: k.promoCode, tax: k.tax, total: k.total, deposit: k.deposit, balanceDue: k.dueDate, currency: h.currency, reference: ref, manageToken: token, commissionRate: sub.status === 'trialing' ? 0 : (plan.commissionRate || 0), marketingConsent: b.marketingConsent, status: online ? 'pending' : 'requested', ...(channel ? { channel } : {}), ...(b.notes ? { notes: b.notes } : {}) });
  if (b.recover) await D.Enquiry.updateOne({ token: b.recover, hotel: h.id }, { status: 'converted', reservation: r.id });
  hooks.emit(h.id, 'reservation.created', { reference: ref });
  const hold = { hotel: h.id, branch: t.branch, roomType: t.id, checkIn: b.checkIn, checkOut: b.checkOut, qty: b.qty, reservation: r.id };
  if (!online) {
    await D.Hold.create({ ...hold, expiresAt: new Date('2999-01-01'), status: 'converted' }); alerts.bookingRequest(r);
    return { reference: ref, token, status: 'requested', message: 'Booking request sent. The hotel will contact you with payment instructions. No payment has been taken.', reservation: r, quote: k };
  }
  const expiresAt = new Date(Date.now() + h.holdMinutes * 6e4);
  await D.Hold.create({ ...hold, expiresAt }); const pr = 'PAY-' + hex(8);
  const charge = r2((r.commissionRate || 0) * k.accommodation * (k.deposit / k.total)), sa = h.payout.subaccountCode;
  const init = await bill.initialize(b.guest.email, k.deposit, pr, `${process.env.CLIENT_URL}/booking/${ref}?token=${token}`, { subaccount: sa, charge });
  const payment = await D.Payment.create({ hotel: h.id, branch: t.branch, reservation: r.id, amount: k.deposit, currency: h.currency, source: 'platform', method: 'paystack', reference: pr, commission: charge, subaccount: sa });
  return { reference: ref, token, status: 'pending', checkoutUrl: init.authorization_url, reservation: r, payment, quote: k, expiresAt };
};

// A guest backing out of a booking that has not been paid: the room goes straight back on sale instead of waiting for the hold to lapse.
exports.cancelUnpaid = async (reservationId, hotel) => {
  const r = await D.Reservation.findOneAndUpdate({ _id: reservationId, hotel, status: { $in: ['pending', 'requested'] }, paid: 0 }, { status: 'cancelled' }, { new: true });
  if (!r) return null;
  await exports.releaseHold(r);
  hooks.emit(hotel, 'reservation.cancelled', { reference: r.reference });
  return r;
};

// Gives the rooms of a cancelled or no-show reservation back to the public booking page straight away.
// A paid booking holds its rooms under a 'converted' hold; an unpaid checkout holds them under an 'active' one (until it times out).
// The hold is claimed atomically, so the rooms are released exactly once even if the timeout job runs at the same moment.
exports.releaseHold = async (r) => {
  const h = await D.Hold.findOneAndUpdate({ reservation: r._id, status: { $in: ['active', 'converted'] } }, { status: 'released' });
  if (h) await inv.release(r.roomType, inv.nightsOf(r.checkIn, r.checkOut), r.qty);
  return !!h;
};

// A guest who did not finish paying can come back later and pay for the SAME booking at the SAME price.
// Allowed for a pending checkout, or one that lapsed (status 'expired'), while nothing was paid, the hotel has not cancelled it, the dates are
// still ahead and the room can still be had. Rooms are taken again through the normal inventory check, so a room someone else booked meanwhile is never double sold.
exports.resumePayment = async ({ reference, token }) => {
  const r = await D.Reservation.findOne({ reference, manageToken: String(token) });
  if (!r) throw fail(404, 'Booking not found');
  if (!['pending', 'expired'].includes(r.status) || r.paid > 0) throw fail(409, r.status === 'cancelled' ? 'This booking was cancelled. Please make a new booking.' : 'There is nothing to pay for this booking.');
  if (!r.guest.email) throw fail(409, 'This booking has no email address for the payment.');
  if (r.checkIn < new Date(Date.now() - 864e5)) throw fail(409, 'The dates of this booking have passed. Please make a new booking.');
  const [h, ent] = await Promise.all([D.Hotel.findById(r.hotel), bill.entitlements(r.hotel)]);
  if (!h || !exports.isOnline(h, ent)) throw fail(409, 'Online payment is not available. Please contact the hotel.');
  const live = await D.Hold.findOne({ reservation: r._id, status: 'active', expiresAt: { $gt: new Date() } });
  let holdExpires;
  if (live) { holdExpires = new Date(Date.now() + h.holdMinutes * 6e4); await D.Hold.updateOne({ _id: live._id, status: 'active' }, { expiresAt: holdExpires }); }
  else {
    // only one of several simultaneous clicks may take the rooms again
    const claim = await D.Reservation.findOneAndUpdate({ _id: r._id, status: { $in: ['pending', 'expired'] }, paid: 0, resumeLock: { $ne: true } }, { $set: { resumeLock: true } });
    if (!claim) throw fail(409, 'Please wait a moment and try again.');
    try {
      try { await inv.reserve(r.roomType, r.checkIn, r.checkOut, r.qty); } catch (e) { throw e.message === 'SOLD_OUT' ? fail(409, 'Sorry, that room has been taken in the meantime. Please choose other dates or another room.') : e; }
      holdExpires = new Date(Date.now() + h.holdMinutes * 6e4);
      await D.Hold.updateMany({ reservation: r._id, status: 'expired' }, { status: 'superseded' });
      await D.Hold.create({ hotel: r.hotel, branch: r.branch, roomType: r.roomType, checkIn: r.checkIn, checkOut: r.checkOut, qty: r.qty, reservation: r._id, expiresAt: holdExpires });
      await D.Reservation.updateOne({ _id: r._id }, { status: 'pending', abandonLogged: false });
    } finally { await D.Reservation.updateOne({ _id: r._id }, { $unset: { resumeLock: 1 } }); }
  }
  const amount = r.deposit > 0 ? r.deposit : r.total, ref = 'PAY-' + hex(8), charge = r2((r.commissionRate || 0) * r.accommodation * (amount / r.total)), sa = h.payout.subaccountCode;
  const init = await bill.initialize(r.guest.email, amount, ref, `${process.env.CLIENT_URL}/booking/${r.reference}?token=${r.manageToken}`, { subaccount: sa, charge });
  await D.Payment.create({ hotel: r.hotel, branch: r.branch, reservation: r._id, amount, currency: r.currency, source: 'platform', method: 'paystack', reference: ref, commission: charge, subaccount: sa });
  return { checkoutUrl: init.authorization_url, holdExpiresAt: holdExpires };
};

// For the booking page: can this guest still pay for it?
exports.canResume = async (r) => {
  if (!['pending', 'expired'].includes(r.status) || r.paid > 0 || !r.guest.email || r.checkIn < new Date(Date.now() - 864e5)) return false;
  const [h, ent] = await Promise.all([D.Hotel.findById(r.hotel), bill.entitlements(r.hotel)]);
  return !!h && exports.isOnline(h, ent);
};
