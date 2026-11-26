// WhatsApp message credits (KeyKonnec's own allowance; Meta's charges are separate and billed by Meta).
// Lifecycle of one outbound message: reserve -> (delivered: settle | permanently failed or never delivered: release).
// Every transition is guarded on the message's own credit state, so a repeated Meta status webhook can never charge twice.
const W = require('./models');
const bill = require('../billing');

const periodKey = (d = new Date()) => d.toISOString().slice(0, 7);

async function allowanceFor(hotel) {
  const [{ plan }, s] = await Promise.all([bill.entitlements(hotel), W.settings()]);
  if (!plan.features.includes('whatsapp')) return 0;
  return Math.max(0, +(s.planAllowance || {})[plan.key] || 0);
}
// Creates the wallet on first use and applies the monthly reset lazily: unused monthly allowance does not roll over, purchased credits do.
async function wallet(hotel) {
  const pk = periodKey();
  let w = await W.WaWallet.findOne({ hotel });
  if (w && w.periodKey === pk) return w;
  const grant = await allowanceFor(hotel);
  if (!w) { try { w = await W.WaWallet.create({ hotel, periodKey: pk, allowance: grant, granted: grant }); await W.WaLedger.create({ hotel, kind: 'grant', credits: grant, key: `grant:${hotel}:${pk}`, note: 'Monthly allowance' }).catch(() => {}); return w; } catch (e) { if (e.code !== 11000) throw e; return W.WaWallet.findOne({ hotel }); } }
  const r = await W.WaWallet.findOneAndUpdate({ hotel, periodKey: { $ne: pk } }, { $set: { periodKey: pk, allowance: grant, granted: grant, used: 0 } }, { new: true });
  if (r) await W.WaLedger.create({ hotel, kind: 'reset', credits: grant, key: `grant:${hotel}:${pk}`, note: 'Monthly allowance reset' }).catch(() => {});
  return r || W.WaWallet.findOne({ hotel });
}
const available = (w) => Math.max(0, w.allowance + w.purchased - w.reserved);
exports.wallet = wallet; exports.available = available; exports.periodKey = periodKey;

// Holds one credit for a message. Atomic: two simultaneous sends cannot both take the last credit.
exports.reserve = async (hotel, messageId) => {
  await wallet(hotel);
  const w = await W.WaWallet.findOneAndUpdate({ hotel, $expr: { $gt: [{ $subtract: [{ $add: ['$allowance', '$purchased'] }, '$reserved'] }, 0] } }, { $inc: { reserved: 1 } }, { new: true });
  if (!w) return false;
  await W.WaLedger.create({ hotel, kind: 'reserve', credits: -1, message: messageId, key: `reserve:${messageId}` }).catch(() => {});
  return true;
};
// Delivered: the credit is spent (monthly allowance first, then purchased credits).
exports.settle = async (messageId) => {
  const msg = await W.WaMessage.findOneAndUpdate({ _id: messageId, credit: 'reserved' }, { credit: 'settled' }, { new: true });
  if (!msg) return false;
  const hotel = msg.hotel;
  const a = await W.WaWallet.findOneAndUpdate({ hotel, allowance: { $gt: 0 } }, { $inc: { allowance: -1, reserved: -1, used: 1 } });
  if (!a) await W.WaWallet.updateOne({ hotel }, { $inc: { purchased: -1, reserved: -1, used: 1 } });
  await W.WaLedger.create({ hotel, kind: 'settle', credits: 0, message: msg._id, key: `settle:${msg._id}` }).catch(() => {});
  return true;
};
// Permanently failed, or never delivered: the reservation is returned.
exports.release = async (messageId, why) => {
  const msg = await W.WaMessage.findOneAndUpdate({ _id: messageId, credit: 'reserved' }, { credit: 'released' }, { new: true });
  if (!msg) return false;
  await W.WaWallet.updateOne({ hotel: msg.hotel, reserved: { $gt: 0 } }, { $inc: { reserved: -1 } });
  await W.WaLedger.create({ hotel: msg.hotel, kind: 'release', credits: 1, message: msg._id, key: `release:${msg._id}`, note: why }).catch(() => {});
  return true;
};
// Messages Meta accepted but never confirmed as delivered (phone off for days) are released after 7 days so credits are not held forever.
exports.sweep = async () => {
  let n = 0;
  for (const m of await W.WaMessage.find({ credit: 'reserved', createdAt: { $lt: new Date(Date.now() - 7 * 864e5) } }).limit(500)) if (await exports.release(m._id, 'not delivered within 7 days')) n++;
  return n;
};
// A purchase is credited once, only after Paystack verified the exact amount (same pending -> processing guard as every other payment).
exports.creditPurchase = async (reference, d) => {
  const p = await W.WaPurchase.findOneAndUpdate({ reference, status: { $in: ['pending', 'flagged'] } }, { status: 'processing' });
  if (!p) return null;
  try {
    if (d.status !== 'success') { await W.WaPurchase.updateOne({ _id: p._id }, { status: bill.isFailure(d) ? 'failed' : 'pending' }); return null; }
    if (!bill.amountMatches(d, p.amount) || !bill.currencyMatches(d, 'NGN')) { await W.WaPurchase.updateOne({ _id: p._id }, { status: 'flagged', flagReason: bill.mismatchReason(d, p.amount, 'NGN') }); return null; }
    await wallet(p.hotel);
    await W.WaWallet.updateOne({ hotel: p.hotel }, { $inc: { purchased: p.credits } });
    await W.WaLedger.create({ hotel: p.hotel, kind: 'purchase', credits: p.credits, ref: reference, key: `purchase:${reference}`, note: p.name });
    await W.WaPurchase.updateOne({ _id: p._id }, { status: 'success', flagReason: null });
    return p;
  } catch (e) { await W.WaPurchase.updateOne({ _id: p._id, status: 'processing' }, { status: p.status }); throw e; }
};
