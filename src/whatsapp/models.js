// New collections for the WhatsApp feature. Hotels, rooms, reservations, payments, guests and receipts stay in the existing models.
const m = require('mongoose'), { Schema } = m, id = Schema.Types.ObjectId, Mixed = Schema.Types.Mixed;
const M = (n, d, f) => { const s = new Schema(d, { timestamps: true }); f && f(s); return m.models[n] || m.model(n, s); };

// One WhatsApp Business number per hotel. The access token is only ever stored encrypted.
exports.WaAccount = M('WaAccount', {
  hotel: { type: id, required: true, unique: true }, phoneNumberId: { type: String, unique: true, sparse: true }, wabaId: String,
  displayPhone: String, verifiedName: String, qualityRating: String, mode: { type: String, default: 'cloud' }, // cloud | coexistence
  tokenEnc: String, tokenKind: { type: String, default: 'embedded' }, status: { type: String, default: 'pending' }, // pending | connected | disconnected | error
  connectedAt: Date, disconnectedAt: Date, lastError: String, lastWebhookAt: Date,
  settings: {
    automation: { type: Boolean, default: true }, booking: { type: Boolean, default: true }, autoReply: { type: Boolean, default: true },
    notifyBooking: { type: Boolean, default: true }, notifyPayment: { type: Boolean, default: true }, notifyReminders: { type: Boolean, default: true },
    ai: { type: Boolean, default: true }, timezone: { type: String, default: 'Africa/Lagos' }, takeoverMinutes: { type: Number, default: 0 }, greeting: String,
  },
  templates: [{ name: String, status: String, language: String, reason: String, checkedAt: Date }],
});

// One conversation per guest per hotel. `ctx` holds everything the engine needs to continue without asking twice.
exports.WaConversation = M('WaConversation', {
  hotel: { type: id, required: true }, account: id, waId: { type: String, required: true }, profileName: String, state: { type: String, default: 'GREETING' }, ctx: { type: Mixed, default: {} },
  mode: { type: String, default: 'auto' }, // auto | human
  handledBy: { type: id }, handledByName: String, takeoverAt: Date, status: { type: String, default: 'open' }, // open | resolved
  lastInboundAt: Date, lastMessageAt: Date, lastPreview: String, unread: { type: Number, default: 0 }, optedOut: { type: Boolean, default: false },
  reservations: [{ type: id }], needsStaff: { type: Boolean, default: false }, staffReason: String, lockUntil: Date,
}, (s) => { s.index({ hotel: 1, waId: 1 }, { unique: true }); s.index({ hotel: 1, lastMessageAt: -1 }); s.index({ hotel: 1, status: 1, mode: 1 }); });

exports.WaMessage = M('WaMessage', {
  hotel: { type: id, required: true }, conversation: { type: id, required: true }, direction: String, from: String, // guest | bot | staff | system
  waMessageId: { type: String, unique: true, sparse: true }, type: { type: String, default: 'text' }, text: String, media: [String], kind: String, template: String,
  staff: { type: id }, status: { type: String, default: 'queued' }, error: String, credit: { type: String, default: 'none' }, // none | reserved | settled | released
  reservation: id,
}, (s) => { s.index({ conversation: 1, createdAt: 1 }); s.index({ hotel: 1, createdAt: -1 }); });

// Message credits are KeyKonnec's own allowance, separate from anything Meta charges.
exports.WaWallet = M('WaWallet', { hotel: { type: id, unique: true }, periodKey: String, allowance: { type: Number, default: 0 }, granted: { type: Number, default: 0 }, purchased: { type: Number, default: 0 }, reserved: { type: Number, default: 0 }, used: { type: Number, default: 0 }, lowNoticeAt: Date });
exports.WaLedger = M('WaLedger', { hotel: id, kind: String, credits: Number, message: id, ref: String, key: { type: String, unique: true, sparse: true }, note: String }, (s) => s.index({ hotel: 1, createdAt: -1 }));
exports.WaPurchase = M('WaPurchase', { hotel: id, pack: String, name: String, credits: Number, amount: Number, reference: { type: String, unique: true }, status: { type: String, default: 'pending' }, flagReason: String }, (s) => s.index({ hotel: 1, createdAt: -1 }));

// One row per notification we have sent for a reservation, so retried webhooks and repeated cron runs never send twice.
exports.WaNotice = M('WaNotice', { hotel: id, reservation: id, kind: String, key: { type: String, unique: true }, whatsapp: String, email: String, error: String });

exports.WaSettings = M('WaSettings', {
  key: { type: String, unique: true }, aiEnabled: { type: Boolean, default: true }, chargeManual: { type: Boolean, default: false },
  planAllowance: { type: Mixed, default: { growth: 500, professional: 2500 } }, // monthly credits per plan key; plans not listed get 0
  packs: { type: Mixed, default: [{ key: 'p500', name: '500 messages', credits: 500, price: 3000, active: true }, { key: 'p2000', name: '2,000 messages', credits: 2000, price: 10000, active: true }, { key: 'p5000', name: '5,000 messages', credits: 5000, price: 22500, active: true }] },
  reminderHour: { type: Number, default: 8 }, templateLanguage: { type: String, default: 'en' },
});

// Operational log for the admin monitor. Expires after 30 days.
exports.WaEvent = M('WaEvent', { hotel: id, kind: String, detail: String, data: Mixed }, (s) => { s.index({ createdAt: -1 }); s.index({ kind: 1, createdAt: -1 }); s.index({ createdAt: 1 }, { expireAfterSeconds: 30 * 86400 }); });
// AI usage is counted per hotel per day, apart from message credits.
exports.WaAiUsage = M('WaAiUsage', { hotel: id, day: String, calls: { type: Number, default: 0 }, tokens: { type: Number, default: 0 }, fallbacks: { type: Number, default: 0 }, errors: { type: Number, default: 0 }, rateLimited: { type: Number, default: 0 } }, (s) => s.index({ hotel: 1, day: 1 }, { unique: true }));

exports.settings = () => exports.WaSettings.findOneAndUpdate({ key: 'main' }, { $setOnInsert: { key: 'main' } }, { upsert: true, new: true, setDefaultsOnInsert: true });
exports.log = (hotel, kind, detail, data) => exports.WaEvent.create({ hotel, kind, detail: String(detail || '').slice(0, 300), data }).catch(() => {});
