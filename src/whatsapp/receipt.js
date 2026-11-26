// The receipt is the one KeyKonnec already issues: GET /api/public/booking/:ref/receipt?token=... (no login; the token is the booking's own manage token).
// This module only builds that existing URL and, for email, renders the existing PDF to a buffer using the existing generator. Nothing is generated differently.
const { PassThrough } = require('stream');
const D = require('../models'), pdf = require('../pdf');

const apiBase = () => String(process.env.API_URL || '').replace(/\/+$/, '');
exports.url = (r) => apiBase() ? `${apiBase()}/api/public/booking/${encodeURIComponent(r.reference)}/receipt?token=${r.manageToken}` : null;
// The payment the receipt is for: the newest one that is successful AND verified (Paystack-verified, or recorded by the hotel).
exports.payment = (r) => D.Payment.findOne({ reservation: r._id, status: 'success', verified: true }).sort({ createdAt: -1 });
exports.buffer = async (r, p) => {
  const [hotel, ctx] = await Promise.all([D.Hotel.findById(r.hotel), require('../extra2').rcx(r)]);
  const sink = new PassThrough(), chunks = []; sink.type = () => sink; sink.setHeader = () => {};
  const done = new Promise((res, rej) => { sink.on('data', (c) => chunks.push(c)); sink.on('end', () => res(Buffer.concat(chunks))); sink.on('error', rej); });
  pdf.receipt(sink, { hotel, r, p, ...ctx });
  return done;
};
