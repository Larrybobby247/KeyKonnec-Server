// The single outbound path for WhatsApp. Everything that sends a message (bot, notifications, staff) goes through here, so the same rules always apply:
// connected account, Meta's 24 hour window, template fallback, credit reserve/release, delivery logging.
const W = require('./models'), meta = require('./meta'), credits = require('./credits'), templates = require('./templates');
const alerts = require('../alerts');

const WINDOW = 24 * 3600e3;
const windowOpen = (conv, now = Date.now()) => !!(conv.lastInboundAt && now - new Date(conv.lastInboundAt) < WINDOW);
const preview = (p) => String(p.text || (p.kind === 'images' ? '[photo]' : '')).replace(/\s+/g, ' ').slice(0, 120);
const RANK = { queued: 0, sent: 1, delivered: 2, read: 3 };

async function lowCreditNotice(hotel) {
  const w = await credits.wallet(hotel);
  if (credits.available(w) > 0) return;
  const recent = w.lowNoticeAt && Date.now() - new Date(w.lowNoticeAt) < 864e5;
  if (recent) return;
  await W.WaWallet.updateOne({ hotel }, { lowNoticeAt: new Date() });
  await alerts.inapp(hotel, null, 'whatsapp', 'WhatsApp message credits are used up', 'Automatic WhatsApp replies and notifications are paused. Buy more credits in WhatsApp settings. You can still reply to guests yourself.', '/dashboard/whatsapp').catch(() => {});
  W.log(hotel, 'credits_exhausted', 'No message credits left');
}

// payload: {kind:'text',text} | {kind:'images',items:[{url,caption}]} | {kind:'cta',text,label,url} | {kind:'buttons',text,buttons:[{id,title}]}
// opts: {by:'bot'|'staff'|'system', notice:'payment_confirmed' (template key), params:[...], staff:userId, reservation, tag}
async function sendOne(account, conv, payload, opts = {}) {
  const by = opts.by || 'bot';
  if (!account || account.status !== 'connected') return { ok: false, reason: 'not_connected' };
  const settings = await W.settings();
  const charged = by !== 'staff' || settings.chargeManual;
  const open = windowOpen(conv);
  let useTemplate = null;
  if (!open) {
    if (opts.notice && templates.approved(account, opts.notice) && opts.params) useTemplate = { name: templates.NAMES[opts.notice], language: templates.languageOf(account, opts.notice), params: opts.params };
    else { W.log(account.hotel, 'window_closed', `${opts.notice || 'message'} not sent: 24h window closed and no approved template`, { conversation: conv._id }); return { ok: false, reason: opts.notice ? 'no_template' : 'window_closed' }; }
  }
  const text = payload.kind === 'cta' && !useTemplate ? `${payload.text}\n${payload.url}` : payload.text;
  const msg = await W.WaMessage.create({ hotel: account.hotel, conversation: conv._id, direction: 'out', from: by, type: useTemplate ? 'template' : payload.kind === 'images' ? 'image' : payload.kind, text: useTemplate ? `[template ${useTemplate.name}] ${opts.preview || ''}`.trim() : (payload.kind === 'images' ? (payload.items[0] || {}).caption : text), media: payload.kind === 'images' ? payload.items.map((i) => i.url) : undefined, kind: opts.notice || opts.tag, template: useTemplate && useTemplate.name, staff: opts.staff, reservation: opts.reservation, status: 'queued' });
  if (charged) {
    if (!(await credits.reserve(account.hotel, msg._id))) { await W.WaMessage.updateOne({ _id: msg._id }, { status: 'failed', error: 'No message credits left' }); lowCreditNotice(account.hotel).catch(() => {}); return { ok: false, reason: 'no_credits', id: msg._id }; }
    await W.WaMessage.updateOne({ _id: msg._id }, { credit: 'reserved' });
  }
  const to = conv.waId;
  const go = async () => {
    if (useTemplate) return meta.sendTemplate(account, to, useTemplate.name, useTemplate.language, useTemplate.params);
    if (payload.kind === 'images') { let last; for (const it of payload.items) last = await meta.sendImage(account, to, it.url, it.caption); return last; }
    if (payload.kind === 'cta') { try { return await meta.sendCta(account, to, payload.text, payload.label, payload.url); } catch (e) { if (e instanceof meta.MetaError && e.permanent) return meta.sendText(account, to, text); throw e; } }
    if (payload.kind === 'buttons') { try { return await meta.sendButtons(account, to, payload.text, payload.buttons); } catch (e) { if (e instanceof meta.MetaError && e.permanent) return meta.sendText(account, to, `${payload.text}\n\n${payload.buttons.map((b) => b.title).join(' / ')}`); throw e; } }
    return meta.sendText(account, to, text);
  };
  let id, err;
  for (let attempt = 0; attempt < 2; attempt++) {
    try { id = await go(); err = null; break; } catch (e) { err = e; if ((e instanceof meta.MetaError && e.permanent) || attempt === 1) break; await new Promise((r) => setTimeout(r, 600)); }
  }
  if (id) {
    await W.WaMessage.updateOne({ _id: msg._id }, { waMessageId: id, status: 'sent' });
    await W.WaConversation.updateOne({ _id: conv._id }, { lastMessageAt: new Date(), lastPreview: preview(payload) });
    return { ok: true, id: msg._id, waId: id };
  }
  const reason = err && err.message ? String(err.message).slice(0, 300) : 'send failed';
  await W.WaMessage.updateOne({ _id: msg._id }, { status: 'failed', error: reason });
  if (charged) await credits.release(msg._id, 'send failed');
  if (err instanceof meta.MetaError && err.tokenInvalid) await W.WaAccount.updateOne({ _id: account._id }, { status: 'error', lastError: 'WhatsApp access was revoked or expired. Reconnect your number.' });
  W.log(account.hotel, 'delivery_failed', reason, { conversation: conv._id, code: err && err.code });
  return { ok: false, reason: err && err.windowClosed ? 'window_closed' : 'failed', error: reason, id: msg._id };
}

async function sendAll(account, conv, items, opts) {
  const out = [];
  for (const it of items) { const r = await sendOne(account, conv, it, opts); out.push(r); if (!r.ok && ['not_connected', 'no_credits', 'window_closed', 'no_template'].includes(r.reason)) break; }
  return out;
}

// Meta delivery status webhook. Statuses only move forward; credits settle once on delivery and are released once on failure.
async function onStatus(st) {
  const msg = await W.WaMessage.findOne({ waMessageId: st.id });
  if (!msg) return false;
  const s = st.status;
  if (s === 'failed') {
    const why = st.errors && st.errors[0] ? `${st.errors[0].title || st.errors[0].message || 'Failed'}${st.errors[0].code ? ' (' + st.errors[0].code + ')' : ''}` : 'Delivery failed';
    await W.WaMessage.updateOne({ _id: msg._id }, { status: 'failed', error: why });
    if (msg.credit === 'reserved') await credits.release(msg._id, why);
    W.log(msg.hotel, 'delivery_failed', why, { conversation: msg.conversation });
    return true;
  }
  if (!(s in RANK) || RANK[s] <= (RANK[msg.status] ?? -1)) return true;
  await W.WaMessage.updateOne({ _id: msg._id }, { status: s });
  if ((s === 'delivered' || s === 'read') && msg.credit === 'reserved') await credits.settle(msg._id);
  return true;
}

module.exports = { sendOne, sendAll, onStatus, windowOpen, WINDOW };
