// Webhook, hotel dashboard API, admin API and background jobs for WhatsApp.
const crypto = require('crypto'), cron = require('node-cron'), rate = require('express-rate-limit'), { z } = require('zod');
const D = require('../models'), bill = require('../billing'), alerts = require('../alerts');
const W = require('./models'), meta = require('./meta'), secret = require('./secret'), send = require('./send'), credits = require('./credits'), templates = require('./templates');
const engine = require('./engine'), groq = require('./groq'), tools = require('./tools'), notify = require('./notify'), receipt = require('./receipt'), nlu = require('./nlu');

const hex = (n) => crypto.randomBytes(n).toString('hex');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const day = (d = new Date()) => d.toISOString().slice(0, 10);
const dayStart = (n = 0) => { const d = new Date(); d.setUTCHours(0, 0, 0, 0); return new Date(+d - n * 864e5); };
const tzOk = (z0) => { try { new Intl.DateTimeFormat('en', { timeZone: z0 }); return true; } catch { return false; } };

groq.onEvent((e) => { W.log(null, 'groq_' + e.type, e.reason || e.detail || '', e); });

// ---------------------------------------------------------------- webhook (one Meta app, every hotel's number)
exports.verify = (q, s) => q.query['hub.mode'] === 'subscribe' && q.query['hub.verify_token'] && q.query['hub.verify_token'] === process.env.WHATSAPP_VERIFY_TOKEN ? s.status(200).send(String(q.query['hub.challenge'])) : s.sendStatus(403);

exports.events = async (q, s) => {
  if (!secret.validMetaSignature(q.body, q.headers['x-hub-signature-256'])) return s.sendStatus(401);
  let body; try { body = JSON.parse(q.body); } catch { return s.sendStatus(400); }
  const work = (async () => {
    for (const en of body.entry || []) for (const c of en.changes || []) {
      try { await handleChange(c, en); } catch (e) { console.error('whatsapp webhook:', e.message); W.log(null, 'webhook_error', e.message, { field: c.field }); }
    }
  })();
  // Meta retries slow webhooks, so answer within a few seconds; duplicates are harmless because every message id is stored once.
  await Promise.race([work, sleep(8000)]);
  s.sendStatus(200);
};

async function handleChange(c, en) {
  const v = c.value || {};
  if (c.field === 'message_template_status_update') {
    const acc = await W.WaAccount.findOne({ wabaId: String(en.id) });
    if (acc) await W.WaAccount.updateOne({ _id: acc._id, 'templates.name': v.message_template_name }, { $set: { 'templates.$.status': String(v.event || '').toUpperCase(), 'templates.$.reason': v.reason, 'templates.$.checkedAt': new Date() } });
    return;
  }
  if (c.field === 'phone_number_quality_update' || c.field === 'account_update') {
    const acc = await W.WaAccount.findOne({ $or: [{ phoneNumberId: v.phone_number_id }, { wabaId: String(en.id) }] });
    if (acc && v.current_limit !== undefined) await W.WaAccount.updateOne({ _id: acc._id }, { qualityRating: v.event || acc.qualityRating });
    return;
  }
  if (c.field !== 'messages') return;
  const pid = v.metadata && v.metadata.phone_number_id;
  const account = pid && await W.WaAccount.findOne({ phoneNumberId: String(pid) });
  if (!account || account.status === 'disconnected') { W.log(null, 'webhook_unknown_number', `No active hotel for phone number id ${pid}`); return; }   // tenant is decided ONLY by the number Meta says the message was sent to
  await W.WaAccount.updateOne({ _id: account._id }, { lastWebhookAt: new Date() });
  for (const st of v.statuses || []) {
    await send.onStatus(st);
    await D.Notification.updateOne({ providerId: st.id }, { status: st.status, ...(st.errors ? { error: st.errors[0].title } : {}) }).catch(() => {});   // the older shared-number log, unchanged
  }
  for (const m of v.messages || []) {
    const contact = (v.contacts || []).find((x) => x.wa_id === m.from);
    await serial(`${account.hotel}:${m.from}`, () => inbound(account, m, contact));
  }
}

// One message at a time per guest (in this process and, with a short database lock, across processes).
const chains = new Map();
function serial(key, fn) {
  const run = (chains.get(key) || Promise.resolve()).catch(() => {}).then(fn);
  chains.set(key, run);
  run.catch(() => {}).finally(() => { if (chains.get(key) === run) chains.delete(key); });
  return run.catch((e) => { console.error('whatsapp inbound:', e.message); W.log(null, 'webhook_error', e.message); });
}
async function lock(id) {
  for (let i = 0; i < 12; i++) {
    const now = new Date(), got = await W.WaConversation.findOneAndUpdate({ _id: id, $or: [{ lockUntil: null }, { lockUntil: { $lt: now } }] }, { lockUntil: new Date(+now + 30000) });
    if (got) return true; await sleep(500);
  }
  return false;
}
const unlock = (id) => W.WaConversation.updateOne({ _id: id }, { lockUntil: null }).catch(() => {});

const inboundText = (m) => {
  if (m.type === 'text') return { text: m.text.body };
  if (m.type === 'interactive' && m.interactive) { const r = m.interactive.button_reply || m.interactive.list_reply || {}; return { text: r.title || '', buttonId: r.id }; }
  if (m.type === 'button') return { text: m.button.text || '' };
  return { text: '', other: m.type };
};

async function inbound(account, m, contact) {
  if (await W.WaMessage.exists({ waMessageId: m.id })) return;   // duplicate delivery from Meta
  const waId = String(m.from).replace(/\D/g, ''), body = inboundText(m);
  const conv0 = await W.WaConversation.findOneAndUpdate({ hotel: account.hotel, waId }, { $setOnInsert: { account: account._id, state: 'GREETING', ctx: {} }, $set: { profileName: contact && contact.profile && contact.profile.name, lastInboundAt: new Date(), lastMessageAt: new Date(), lastPreview: (body.text || `[${body.other}]`).slice(0, 120), status: 'open' }, $inc: { unread: 1 } }, { upsert: true, new: true });
  try { await W.WaMessage.create({ hotel: account.hotel, conversation: conv0._id, direction: 'in', from: 'guest', waMessageId: m.id, type: m.type, text: body.text || `[${body.other || m.type}]`, status: 'delivered' }); }
  catch (e) { if (e.code === 11000) return; throw e; }
  meta.markRead(account, m.id);
  if (!(await lock(conv0._id))) W.log(account.hotel, 'webhook_error', 'conversation lock timeout; continuing');
  try { await respond(account, conv0._id, body); } finally { await unlock(conv0._id); }
}

async function respond(account, convId, body) {
  const [conv, acc, ent, gs] = await Promise.all([W.WaConversation.findById(convId), W.WaAccount.findById(account._id), bill.entitlements(account.hotel), W.settings()]);
  if (!conv || !acc) return;
  const S = acc.settings, hasPlan = ent.plan.features.includes('whatsapp_automation') && ent.plan.features.includes('whatsapp');
  if (conv.mode === 'human') {   // a person is handling this chat: automation stays silent, staff are nudged
    if (!conv.needsStaff) await W.WaConversation.updateOne({ _id: conv._id }, { needsStaff: true });
    return;
  }
  if (!hasPlan || acc.status !== 'connected' || S.automation === false || S.autoReply === false) { await W.WaConversation.updateOne({ _id: conv._id }, { needsStaff: true, staffReason: 'Automation is off' }); return; }
  if (body.other) { await send.sendAll(acc, conv, [{ kind: 'text', text: "I can only read text messages. Please type your request, or type STAFF to speak with our team." }], { by: 'bot' }); return; }
  const aiOn = gs.aiEnabled && S.ai !== false && groq.available().ok;
  const ai = aiOn ? async (args) => {
    const day0 = day();
    try { const out = await groq.interpret(args); await W.WaAiUsage.updateOne({ hotel: acc.hotel, day: day0 }, { $inc: { calls: 1, tokens: (out.usage && out.usage.total_tokens) || 0 } }, { upsert: true }); return out; }
    catch (e) { await W.WaAiUsage.updateOne({ hotel: acc.hotel, day: day0 }, { $inc: { errors: 1, fallbacks: 1, ...(e.code === 'rate_limited' ? { rateLimited: 1 } : {}) } }, { upsert: true }).catch(() => {}); throw e; }
  } : null;
  const t = tools.make(acc);
  const plain = { waId: conv.waId, state: conv.state, ctx: conv.ctx || {}, reservations: (conv.reservations || []).map(String), optedOut: conv.optedOut, profileName: conv.profileName };
  const bookingEnabled = ent.plan.features.includes('whatsapp_automation') && S.booking !== false;
  let out;
  try { out = await engine.handle({ conv: plain, msg: body, tools: t, settings: { timezone: S.timezone, greeting: S.greeting, bookingEnabled }, ai }); }
  catch (e) { console.error('whatsapp engine:', e); W.log(acc.hotel, 'webhook_error', 'engine: ' + e.message); out = { replies: [{ kind: 'text', text: "Sorry, something went wrong on our side. Please try again in a moment, or type STAFF to speak with our team." }], state: conv.state, ctx: conv.ctx, effects: [], info: {} }; }
  const set = { state: out.state, ctx: out.ctx }, push = {};
  for (const e of out.effects) {
    if (e.t === 'handover') { Object.assign(set, { mode: 'human', needsStaff: true, staffReason: e.reason, takeoverAt: new Date(), handledBy: null, handledByName: 'Waiting for staff' }); await W.WaMessage.create({ hotel: acc.hotel, conversation: conv._id, direction: 'out', from: 'system', type: 'note', text: `Handed to staff: ${e.reason}`, status: 'delivered' }); await D.Audit.create({ hotel: acc.hotel, action: 'whatsapp.handover', entity: 'WaConversation', entityId: conv._id, detail: { reason: e.reason } }); t.requestHumanAssistance(conv, e.reason).catch(() => {}); }
    if (e.t === 'flag') Object.assign(set, { needsStaff: true, staffReason: e.reason });
    if (e.t === 'link') push.reservations = new (require('mongoose').Types.ObjectId)(e.reservationId);
    if (e.t === 'optout') set.optedOut = true;
    if (e.t === 'optin') set.optedOut = false;
  }
  if (out.info && out.info.aiFailed) W.log(acc.hotel, 'ai_fallback', 'Groq unavailable; deterministic reader used');
  await W.WaConversation.updateOne({ _id: conv._id }, { $set: set, ...(push.reservations ? { $addToSet: { reservations: push.reservations } } : {}) });
  const fresh = await W.WaConversation.findById(conv._id);
  await send.sendAll(acc, fresh, out.replies, { by: 'bot' });
}

// ---------------------------------------------------------------- templates
async function ensureTemplates(account) {
  const token = secret.decrypt(account.tokenEnc), gs = await W.settings(), have = await meta.listTemplates(account.wabaId, token);
  for (const d of templates.definitions(gs.templateLanguage || 'en')) {
    if (have.some((x) => x.name === d.name && x.language === d.language)) continue;
    try { await meta.createTemplate(account.wabaId, token, { name: d.name, language: d.language, category: d.category, components: d.components }); } catch (e) { W.log(account.hotel, 'template_error', `${d.name}: ${e.message}`); }
  }
  const now = await meta.listTemplates(account.wabaId, token);
  const mine = Object.values(templates.NAMES);
  await W.WaAccount.updateOne({ _id: account._id }, { templates: now.filter((x) => mine.includes(x.name)).map((x) => ({ name: x.name, status: x.status, language: x.language, reason: x.rejected_reason, checkedAt: new Date() })) });
}

// ---------------------------------------------------------------- dashboard and admin API
exports.mount = ({ api, auth, need, admin, audit, parse, wrap }) => {
  const staff = need('owner', 'manager', 'receptionist'), mgr = need('owner', 'manager'), owner = need('owner');
  const gate = wrap(async (q, s, n) => (await bill.entitlements(q.hotelId)).plan.features.includes('whatsapp') ? n() : s.status(402).json({ error: 'WhatsApp is not included in your plan. Upgrade to use it.' }));
  const account = (q) => W.WaAccount.findOne({ hotel: q.hotelId });
  const safe = (a) => a && { status: a.status, displayPhone: a.displayPhone, verifiedName: a.verifiedName, qualityRating: a.qualityRating, mode: a.mode, connectedAt: a.connectedAt, lastError: a.lastError, lastWebhookAt: a.lastWebhookAt, settings: a.settings, templates: a.templates };
  notify.init();

  api.get('/whatsapp/status', auth, staff, gate, wrap(async (q, s) => {
    const [a, ent, gs, w, sent, ai] = await Promise.all([account(q), bill.entitlements(q.hotelId), W.settings(), credits.wallet(q.hotelId), W.WaMessage.aggregate([{ $match: { hotel: new (require('mongoose').Types.ObjectId)(q.hotelId), direction: 'out', createdAt: { $gte: new Date(new Date().getUTCFullYear(), new Date().getUTCMonth(), 1) } } }, { $group: { _id: '$status', n: { $sum: 1 } } }]), W.WaAiUsage.aggregate([{ $match: { hotel: new (require('mongoose').Types.ObjectId)(q.hotelId), day: { $gte: day().slice(0, 7) } } }, { $group: { _id: null, calls: { $sum: '$calls' }, tokens: { $sum: '$tokens' }, fallbacks: { $sum: '$fallbacks' } } }])]);
    const g = groq.status();
    s.json({ account: safe(a), automationIncluded: ent.plan.features.includes('whatsapp_automation'), wallet: { available: credits.available(w), allowance: w.allowance, granted: w.granted, purchased: w.purchased, reserved: w.reserved, used: w.used, period: w.periodKey }, packs: (gs.packs || []).filter((p) => p.active), messages: Object.fromEntries(sent.map((x) => [x._id, x.n])),
      ai: { platformEnabled: gs.aiEnabled && g.configured, hotelEnabled: !a || a.settings.ai !== false, state: !gs.aiEnabled || !g.configured ? 'off' : g.state === 'closed' ? 'ready' : 'fallback', usage: ai[0] || { calls: 0, tokens: 0, fallbacks: 0 } },
      signup: { appId: process.env.META_APP_ID || null, configId: process.env.META_EMBEDDED_CONFIG_ID || null, graphVersion: process.env.WA_GRAPH_VERSION || 'v21.0', manual: process.env.WA_ALLOW_MANUAL_CONNECT === 'true' }, webhookUrl: process.env.API_URL ? `${String(process.env.API_URL).replace(/\/+$/, '')}/api/whatsapp/webhook` : null });
  }));

  const connectCommon = async (q, { token, phoneNumberId, wabaId, coexistence, kind }) => {
    const other = await W.WaAccount.findOne({ phoneNumberId, hotel: { $ne: q.hotelId } });
    if (other) throw Object.assign(new Error('That WhatsApp number is already connected to another hotel.'), { status: 409 });
    let info; try { info = await meta.phoneInfo(phoneNumberId, token); } catch (e) { throw Object.assign(new Error(`Meta would not let us read that number: ${e.message}`), { status: 400 }); }
    try { await meta.subscribeApp(wabaId, token); } catch (e) { throw Object.assign(new Error(`Could not subscribe to WhatsApp events: ${e.message}`), { status: 400 }); }
    if (!coexistence) { try { await meta.registerPhone(phoneNumberId, token, meta.randomPin()); } catch (e) { if (!/already|registered/i.test(e.message)) W.log(q.hotelId, 'connection', `register: ${e.message}`); } }
    const a = await W.WaAccount.findOneAndUpdate({ hotel: q.hotelId }, { $set: { phoneNumberId, wabaId, displayPhone: info.display_phone_number, verifiedName: info.verified_name, qualityRating: info.quality_rating, mode: coexistence ? 'coexistence' : 'cloud', tokenEnc: secret.encrypt(token), tokenKind: kind, status: 'connected', connectedAt: new Date(), disconnectedAt: null, lastError: null } }, { upsert: true, new: true, setDefaultsOnInsert: true });
    ensureTemplates(a).catch((e) => W.log(q.hotelId, 'template_error', e.message));
    await credits.wallet(q.hotelId);
    await audit(q, 'whatsapp.connect', 'WaAccount', a.id, { phone: a.displayPhone, mode: a.mode });
    return a;
  };
  api.post('/whatsapp/connect', auth, owner, gate, rate({ windowMs: 36e5, limit: 20 }), wrap(async (q, s) => {
    const b = parse(z.object({ code: z.string().min(10).max(1000), phoneNumberId: z.string().regex(/^\d{5,30}$/), wabaId: z.string().regex(/^\d{5,30}$/), coexistence: z.boolean().optional() }), q.body);
    let token; try { token = await meta.exchangeCode(b.code); } catch (e) { return s.status(400).json({ error: `WhatsApp sign-up could not be completed: ${e.message}` }); }
    s.json(safe(await connectCommon(q, { token, phoneNumberId: b.phoneNumberId, wabaId: b.wabaId, coexistence: b.coexistence, kind: 'embedded' })));
  }));
  api.post('/whatsapp/connect-manual', auth, owner, gate, rate({ windowMs: 36e5, limit: 10 }), wrap(async (q, s) => {
    if (process.env.WA_ALLOW_MANUAL_CONNECT !== 'true') return s.status(404).json({ error: 'Not available' });
    const b = parse(z.object({ token: z.string().min(20).max(1000), phoneNumberId: z.string().regex(/^\d{5,30}$/), wabaId: z.string().regex(/^\d{5,30}$/), coexistence: z.boolean().optional() }), q.body);
    s.json(safe(await connectCommon(q, { ...b, kind: 'manual' })));
  }));
  // Disconnecting stops WhatsApp only. Bookings, guests, receipts and conversation history stay exactly as they are.
  api.post('/whatsapp/disconnect', auth, owner, gate, wrap(async (q, s) => {
    const a = await account(q); if (!a) return s.json({ ok: true });
    if (a.tokenEnc && a.wabaId) { try { await meta.unsubscribeApp(a.wabaId, secret.decrypt(a.tokenEnc)); } catch { /* the token may already be revoked */ } }
    await W.WaAccount.updateOne({ _id: a._id }, { status: 'disconnected', tokenEnc: null, disconnectedAt: new Date() });
    await audit(q, 'whatsapp.disconnect', 'WaAccount', a.id); s.json({ ok: true });
  }));
  api.patch('/whatsapp/settings', auth, mgr, gate, wrap(async (q, s) => {
    const b = parse(z.object({ automation: z.boolean(), booking: z.boolean(), autoReply: z.boolean(), notifyBooking: z.boolean(), notifyPayment: z.boolean(), notifyReminders: z.boolean(), ai: z.boolean(), timezone: z.string().max(60).refine(tzOk, 'Unknown timezone'), greeting: z.string().max(300) }).partial(), q.body);
    const set = Object.fromEntries(Object.entries(b).map(([k, v]) => [`settings.${k}`, v]));
    const a = await W.WaAccount.findOneAndUpdate({ hotel: q.hotelId }, { $set: set }, { new: true }); if (!a) return s.status(404).json({ error: 'Connect WhatsApp first' });
    await audit(q, 'whatsapp.settings', 'WaAccount', a.id, b); s.json(safe(a));
  }));
  api.post('/whatsapp/templates/sync', auth, mgr, gate, wrap(async (q, s) => { const a = await account(q); if (!a || a.status !== 'connected') return s.status(409).json({ error: 'Connect WhatsApp first' }); await ensureTemplates(a); s.json(safe(await account(q))); }));

  // ---- inbox
  const convView = (c) => ({ id: c.id, waId: c.waId, name: c.profileName, state: c.state, mode: c.mode, status: c.status, needsStaff: c.needsStaff, staffReason: c.staffReason, handledByName: c.handledByName, unread: c.unread, lastMessageAt: c.lastMessageAt, lastPreview: c.lastPreview, optedOut: c.optedOut, windowOpen: send.windowOpen(c), enquiry: ['COLLECTING_CHECK_IN', 'COLLECTING_CHECK_OUT', 'COLLECTING_GUEST_COUNT', 'CHECKING_AVAILABILITY', 'SELECTING_ROOM', 'SHOWING_ROOM_DETAILS', 'BOOKING_SUMMARY', 'COLLECTING_GUEST_INFORMATION', 'AWAITING_PAYMENT'].includes(c.state) });
  api.get('/whatsapp/conversations', auth, staff, gate, wrap(async (q, s) => {
    const f = { hotel: q.hotelId };
    if (['open', 'resolved'].includes(q.query.status)) f.status = q.query.status;
    if (['auto', 'human'].includes(q.query.mode)) f.mode = q.query.mode;
    if (q.query.needsStaff === '1') f.needsStaff = true;
    if (q.query.q) f.$or = [{ profileName: new RegExp(String(q.query.q).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i') }, { waId: new RegExp(String(q.query.q).replace(/\D/g, '') || '^$') }];
    s.json((await W.WaConversation.find(f).sort({ lastMessageAt: -1 }).limit(60)).map(convView));
  }));
  const conv = async (q) => W.WaConversation.findOne({ _id: q.params.id, hotel: q.hotelId });
  api.get('/whatsapp/conversations/:id', auth, staff, gate, wrap(async (q, s) => {
    const c = await conv(q); if (!c) return s.sendStatus(404);
    const [msgs, res] = await Promise.all([W.WaMessage.find({ conversation: c._id }).sort({ createdAt: -1 }).limit(150).lean(), D.Reservation.find({ _id: { $in: c.reservations }, hotel: q.hotelId }).populate('roomType', 'name').lean()]);
    if (c.unread) await W.WaConversation.updateOne({ _id: c._id }, { unread: 0 });
    s.json({ conversation: convView(c), guest: { phone: '+' + c.waId, name: c.profileName, draft: c.ctx && c.ctx.guest ? { name: c.ctx.guest.name, email: c.ctx.guest.email } : null }, messages: msgs.reverse().map((m) => ({ id: m._id, direction: m.direction, from: m.from, type: m.type, text: m.text, media: m.media, status: m.status, error: m.error, createdAt: m.createdAt })), bookings: res.map((r) => ({ id: r._id, reference: r.reference, status: r.status, paymentStatus: r.paymentStatus, total: r.total, paid: r.paid, checkIn: r.checkIn, checkOut: r.checkOut, room: r.roomType && r.roomType.name })) });
  }));
  api.post('/whatsapp/conversations/:id/reply', auth, staff, gate, rate({ windowMs: 60000, limit: 40 }), wrap(async (q, s) => {
    const b = parse(z.object({ text: z.string().min(1).max(2000) }), q.body), c = await conv(q), a = await account(q); if (!c || !a) return s.sendStatus(404);
    // answering manually is always allowed, whatever the automation settings are
    const r = await send.sendOne(a, c, { kind: 'text', text: b.text }, { by: 'staff', staff: q.user.id });
    if (!r.ok) return s.status(409).json({ error: r.reason === 'window_closed' ? 'More than 24 hours have passed since the guest last wrote, so WhatsApp only allows approved template messages now. Wait for the guest to message first.' : r.reason === 'no_credits' ? 'No message credits left. Buy more credits in WhatsApp settings.' : r.reason === 'not_connected' ? 'WhatsApp is not connected.' : `Message failed: ${r.error || r.reason}` });
    await W.WaConversation.updateOne({ _id: c._id }, { needsStaff: false }); s.json({ ok: true });
  }));
  const note = (c, text) => W.WaMessage.create({ hotel: c.hotel, conversation: c._id, direction: 'out', from: 'system', type: 'note', text, status: 'delivered' });
  api.post('/whatsapp/conversations/:id/takeover', auth, staff, gate, wrap(async (q, s) => {
    const c = await conv(q); if (!c) return s.sendStatus(404);
    await W.WaConversation.updateOne({ _id: c._id }, { mode: 'human', handledBy: q.user.id, handledByName: q.user.name, takeoverAt: new Date(), needsStaff: false });   // the conversation state and details are kept
    await note(c, `${q.user.name} took over the conversation`); await audit(q, 'whatsapp.takeover', 'WaConversation', c.id); s.json({ ok: true });
  }));
  api.post('/whatsapp/conversations/:id/release', auth, staff, gate, wrap(async (q, s) => {
    const c = await conv(q); if (!c) return s.sendStatus(404);
    await W.WaConversation.updateOne({ _id: c._id }, { mode: 'auto', handledBy: null, handledByName: null, needsStaff: false });
    await note(c, `${q.user.name} returned the conversation to automation`); await audit(q, 'whatsapp.release', 'WaConversation', c.id); s.json({ ok: true });
  }));
  api.post('/whatsapp/conversations/:id/resolve', auth, staff, gate, wrap(async (q, s) => {
    const c = await conv(q); if (!c) return s.sendStatus(404);
    await W.WaConversation.updateOne({ _id: c._id }, { status: 'resolved', needsStaff: false, unread: 0 }); await note(c, `${q.user.name} marked this resolved`); s.json({ ok: true });
  }));
  // Staff can send approved information: the public booking page, or a guest's own booking (with its existing receipt link when the payment is verified).
  api.post('/whatsapp/conversations/:id/send-info', auth, staff, gate, wrap(async (q, s) => {
    const b = parse(z.object({ kind: z.enum(['website', 'booking']), reservationId: z.string().optional() }), q.body), c = await conv(q), a = await account(q); if (!c || !a) return s.sendStatus(404);
    const t = tools.make(a); let payload;
    if (b.kind === 'website') { const h = await t.hotelInfo(); if (!h.siteUrl) return s.status(409).json({ error: 'Your booking page is not published yet.' }); payload = { kind: 'cta', text: `You can see our rooms and book online here:`, label: 'Open booking page', url: h.siteUrl }; }
    else {
      if (!c.reservations.map(String).includes(String(b.reservationId))) return s.status(403).json({ error: 'That booking does not belong to this guest.' });
      const x = await t.getBookingStatus(b.reservationId); if (!x) return s.sendStatus(404);
      const text = `Booking ${x.reference}\n${x.typeName}: ${nlu.human(x.checkIn)} to ${nlu.human(x.checkOut)}\nStatus: ${x.status.replace('_', ' ')} · Payment: ${x.paymentStatus}`;
      payload = x.receiptUrl ? { kind: 'cta', text: text + '\nYour payment receipt is below.', label: 'Download receipt', url: x.receiptUrl } : { kind: 'text', text };
    }
    const r = await send.sendOne(a, c, payload, { by: 'staff', staff: q.user.id }); r.ok ? s.json({ ok: true }) : s.status(409).json({ error: r.reason === 'window_closed' ? 'The 24 hour WhatsApp window is closed for this guest.' : `Message failed: ${r.error || r.reason}` });
  }));

  // ---- WhatsApp-created bookings, with delivery status and resend
  api.get('/whatsapp/bookings', auth, staff, gate, wrap(async (q, s) => {
    const rs = await D.Reservation.find({ hotel: q.hotelId, channel: 'whatsapp_auto' }).sort({ createdAt: -1 }).limit(50).populate('roomType', 'name').lean(), ids = rs.map((r) => r._id);
    const [notices, msgs, pays] = await Promise.all([W.WaNotice.find({ hotel: q.hotelId, reservation: { $in: ids }, kind: 'confirmed' }).lean(), W.WaMessage.find({ hotel: q.hotelId, reservation: { $in: ids }, kind: 'payment_confirmed' }).sort({ createdAt: -1 }).lean(), D.Payment.find({ reservation: { $in: ids }, status: 'success', verified: true }).select('reservation reference amount').lean()]);
    s.json(rs.map((r) => { const n = notices.find((x) => String(x.reservation) === String(r._id)), m = msgs.find((x) => String(x.reservation) === String(r._id)), p = pays.find((x) => String(x.reservation) === String(r._id)); return { id: r._id, reference: r.reference, guest: r.guest.name, email: r.guest.email, phone: r.guest.phone, room: r.roomType && r.roomType.name, checkIn: r.checkIn, checkOut: r.checkOut, status: r.status, paymentStatus: r.paymentStatus, total: r.total, paid: r.paid, paymentReference: p && p.reference, receiptUrl: p ? receipt.url(r) : null, emailStatus: n && n.email, whatsappStatus: m ? m.status : n && n.whatsapp, createdAt: r.createdAt }; }));
  }));
  api.post('/whatsapp/bookings/:id/resend', auth, staff, gate, rate({ windowMs: 60000, limit: 10 }), wrap(async (q, s) => {
    const b = parse(z.object({ channel: z.enum(['whatsapp', 'email', 'both']) }), q.body), r = await D.Reservation.findOne({ _id: q.params.id, hotel: q.hotelId });
    if (!r) return s.sendStatus(404);
    const out = await notify.confirmation(r, { force: true, whatsapp: b.channel !== 'email', email: b.channel !== 'whatsapp' });
    if (out.error) return s.status(409).json({ error: out.error });
    await audit(q, 'whatsapp.resend', 'Reservation', r.id, { channel: b.channel, result: out }); s.json(out);
  }));

  // ---- message credits
  api.get('/whatsapp/credits/ledger', auth, mgr, gate, wrap(async (q, s) => s.json(await W.WaLedger.find({ hotel: q.hotelId, kind: { $in: ['grant', 'reset', 'purchase'] } }).sort({ createdAt: -1 }).limit(40).lean())));
  api.post('/whatsapp/credits/checkout', auth, owner, gate, rate({ windowMs: 36e5, limit: 20 }), wrap(async (q, s) => {
    const gs = await W.settings(), pack = (gs.packs || []).find((p) => p.key === String(q.body.pack) && p.active);
    if (!pack) return s.status(400).json({ error: 'Choose a credit pack' });
    const ref = 'WAC-' + hex(8); await W.WaPurchase.create({ hotel: q.hotelId, pack: pack.key, name: pack.name, credits: pack.credits, amount: pack.price, reference: ref });
    const init = await bill.initialize(q.user.email, pack.price, ref, `${process.env.CLIENT_URL}/dashboard/whatsapp?credits=${ref}`);   // paid to the platform, no hotel split
    s.json({ checkoutUrl: init.authorization_url });
  }));
  api.get('/whatsapp/credits/verify/:ref', auth, owner, gate, wrap(async (q, s) => {
    const p = await W.WaPurchase.findOne({ reference: q.params.ref, hotel: q.hotelId }); if (!p) return s.sendStatus(404);
    if (['pending', 'flagged'].includes(p.status)) { try { await credits.creditPurchase(p.reference, await bill.verify(p.reference)); } catch { /* not paid yet */ } }
    const x = await W.WaPurchase.findById(p.id); s.json({ status: x.status, credits: x.credits });
  }));

  // ---- platform admin
  api.get('/admin/whatsapp/overview', ...admin, wrap(async (q, s) => {
    const since = dayStart(7), today = day();
    const [accts, msgs, ai, events, wa, ledger] = await Promise.all([W.WaAccount.aggregate([{ $group: { _id: '$status', n: { $sum: 1 } } }]), W.WaMessage.aggregate([{ $match: { direction: 'out', createdAt: { $gte: since } } }, { $group: { _id: '$status', n: { $sum: 1 } } }]), W.WaAiUsage.aggregate([{ $match: { day: { $gte: day(since) } } }, { $group: { _id: null, calls: { $sum: '$calls' }, tokens: { $sum: '$tokens' }, fallbacks: { $sum: '$fallbacks' }, errors: { $sum: '$errors' }, rateLimited: { $sum: '$rateLimited' } } }]), W.WaEvent.aggregate([{ $match: { createdAt: { $gte: since } } }, { $group: { _id: '$kind', n: { $sum: 1 } } }]), D.Reservation.countDocuments({ channel: 'whatsapp_auto' }), W.WaLedger.find({ kind: { $in: ['purchase', 'grant', 'reset'] } }).sort({ createdAt: -1 }).limit(15).lean()]);
    s.json({ accounts: Object.fromEntries(accts.map((x) => [x._id, x.n])), messages7d: Object.fromEntries(msgs.map((x) => [x._id, x.n])), ai7d: ai[0] || {}, events7d: Object.fromEntries(events.map((x) => [x._id, x.n])), whatsappBookings: wa, ledger, groq: groq.status(), today, settings: await W.settings() });
  }));
  api.get('/admin/whatsapp/accounts', ...admin, wrap(async (q, s) => {
    const as = await W.WaAccount.find().sort({ updatedAt: -1 }).limit(200).lean(), hs = await D.Hotel.find({ _id: { $in: as.map((a) => a.hotel) } }).select('name').lean();
    s.json(as.map((a) => ({ hotel: a.hotel, hotelName: (hs.find((h) => String(h._id) === String(a.hotel)) || {}).name, status: a.status, phone: a.displayPhone, mode: a.mode, quality: a.qualityRating, lastWebhookAt: a.lastWebhookAt, lastError: a.lastError, automation: a.settings && a.settings.automation, ai: a.settings && a.settings.ai })));
  }));
  api.get('/admin/whatsapp/events', ...admin, wrap(async (q, s) => s.json(await W.WaEvent.find(q.query.kind ? { kind: String(q.query.kind) } : {}).sort({ createdAt: -1 }).limit(100).lean())));
  api.patch('/admin/whatsapp/settings', ...admin, wrap(async (q, s) => {
    const b = parse(z.object({ aiEnabled: z.boolean(), chargeManual: z.boolean(), reminderHour: z.number().int().min(0).max(23), templateLanguage: z.string().max(10), planAllowance: z.record(z.number().int().min(0).max(1e6)), packs: z.array(z.object({ key: z.string().regex(/^[a-z0-9_]{2,20}$/), name: z.string().max(60), credits: z.number().int().min(1), price: z.number().min(100), active: z.boolean() })).max(12) }).partial(), q.body);
    const r = await W.WaSettings.findOneAndUpdate({ key: 'main' }, { $set: b }, { upsert: true, new: true }); await D.Audit.create({ user: q.user.id, action: 'admin.whatsapp.settings', entity: 'WaSettings', entityId: r.id, detail: b }); s.json(r);
  }));
  api.post('/admin/whatsapp/ai/reset', ...admin, wrap(async (q, s) => { groq.reset(); s.json(groq.status()); }));
};

exports.jobs = () => {
  cron.schedule('*/15 * * * *', () => notify.reminders().catch((e) => console.error('whatsapp reminders:', e.message)));
  cron.schedule('17 * * * *', () => credits.sweep().catch(() => {}));
};
exports.ensureTemplates = ensureTemplates;
exports._test = { handleChange, inbound };
