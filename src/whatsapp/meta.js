// Thin client for the official Meta WhatsApp Cloud API (https://developers.facebook.com/docs/whatsapp/cloud-api/).
// Messages are delivered by Meta; KeyKonnec only calls these endpoints with the hotel's own token.
const crypto = require('crypto');
const secret = require('./secret');

const ver = () => process.env.WA_GRAPH_VERSION || 'v21.0';
const base = () => `https://graph.facebook.com/${ver()}`;
let fetchImpl = (...a) => fetch(...a);

class MetaError extends Error {
  constructor(res, body) {
    const e = (body && body.error) || {};
    super(e.error_data && e.error_data.details ? `${e.message}: ${e.error_data.details}` : e.message || `Meta request failed (${res && res.status})`);
    this.status = res && res.status; this.code = e.code; this.subcode = e.error_subcode; this.fbtrace = e.fbtrace_id;
  }
  // Errors that will not fix themselves, so the message is not retried and its credit is released.
  get permanent() { return [131026, 131047, 131049, 131051, 131052, 131053, 132000, 132001, 132005, 132007, 132012, 133010, 100].includes(this.code) || (this.status >= 400 && this.status < 500 && this.status !== 429); }
  get windowClosed() { return this.code === 131047 || this.code === 131049; }
  get tokenInvalid() { return this.code === 190 || this.status === 401; }
}

async function graph(path, { method = 'GET', token, body, query, timeout = 15000 } = {}) {
  const qs = query ? '?' + new URLSearchParams(query).toString() : '';
  const ctl = new AbortController(), t = setTimeout(() => ctl.abort(), timeout);
  try {
    const res = await fetchImpl(`${base()}/${path}${qs}`, { method, signal: ctl.signal, headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new MetaError(res, data);
    return data;
  } finally { clearTimeout(t); }
}

const tokenOf = (acc) => secret.decrypt(acc.tokenEnc);
const msgUrl = (acc) => `${acc.phoneNumberId}/messages`;
const idOf = (r) => r && r.messages && r.messages[0] && r.messages[0].id;
const to = (n) => String(n).replace(/\D/g, '');

exports.MetaError = MetaError;
exports.sendText = async (acc, dest, text) => idOf(await graph(msgUrl(acc), { method: 'POST', token: tokenOf(acc), body: { messaging_product: 'whatsapp', recipient_type: 'individual', to: to(dest), type: 'text', text: { preview_url: true, body: String(text).slice(0, 4000) } } }));
exports.sendImage = async (acc, dest, link, caption) => idOf(await graph(msgUrl(acc), { method: 'POST', token: tokenOf(acc), body: { messaging_product: 'whatsapp', to: to(dest), type: 'image', image: { link, ...(caption ? { caption: String(caption).slice(0, 1000) } : {}) } } }));
// Reply buttons: at most 3, titles up to 20 characters.
exports.sendButtons = async (acc, dest, text, buttons) => idOf(await graph(msgUrl(acc), { method: 'POST', token: tokenOf(acc), body: { messaging_product: 'whatsapp', to: to(dest), type: 'interactive', interactive: { type: 'button', body: { text: String(text).slice(0, 1024) }, action: { buttons: buttons.slice(0, 3).map((b) => ({ type: 'reply', reply: { id: String(b.id).slice(0, 256), title: String(b.title).slice(0, 20) } })) } } } }));
// A message with one tappable link button (payment link, receipt).
exports.sendCta = async (acc, dest, text, label, url) => idOf(await graph(msgUrl(acc), { method: 'POST', token: tokenOf(acc), body: { messaging_product: 'whatsapp', to: to(dest), type: 'interactive', interactive: { type: 'cta_url', body: { text: String(text).slice(0, 1024) }, action: { name: 'cta_url', parameters: { display_text: String(label).slice(0, 20), url } } } } }));
exports.sendTemplate = async (acc, dest, name, language, params = []) => idOf(await graph(msgUrl(acc), { method: 'POST', token: tokenOf(acc), body: { messaging_product: 'whatsapp', to: to(dest), type: 'template', template: { name, language: { code: language || 'en' }, ...(params.length ? { components: [{ type: 'body', parameters: params.map((p) => ({ type: 'text', text: String(p).replace(/[\n\t]+/g, ' ').slice(0, 900) })) }] } : {}) } } }));
exports.markRead = (acc, messageId) => graph(msgUrl(acc), { method: 'POST', token: tokenOf(acc), body: { messaging_product: 'whatsapp', status: 'read', message_id: messageId } }).catch(() => {});

// ---- onboarding (Embedded Signup returns a short-lived code plus the WABA and phone number ids)
exports.exchangeCode = async (code) => { const r = await graph('oauth/access_token', { query: { client_id: process.env.META_APP_ID, client_secret: process.env.WHATSAPP_APP_SECRET, code } }); if (!r.access_token) throw new Error('Meta did not return an access token'); return r.access_token; };
exports.subscribeApp = (wabaId, token) => graph(`${wabaId}/subscribed_apps`, { method: 'POST', token });
exports.unsubscribeApp = (wabaId, token) => graph(`${wabaId}/subscribed_apps`, { method: 'DELETE', token });
// Registering is needed for a Cloud API number. Numbers onboarded through the WhatsApp Business app (coexistence) are already live and must not be re-registered.
exports.registerPhone = (phoneId, token, pin) => graph(`${phoneId}/register`, { method: 'POST', token, body: { messaging_product: 'whatsapp', pin } });
exports.phoneInfo = (phoneId, token) => graph(phoneId, { token, query: { fields: 'display_phone_number,verified_name,quality_rating,code_verification_status,platform_type' } });
exports.randomPin = () => String(crypto.randomInt(0, 1e6)).padStart(6, '0');
exports.listTemplates = async (wabaId, token) => (await graph(`${wabaId}/message_templates`, { token, query: { fields: 'name,status,language,rejected_reason', limit: '200' } })).data || [];
exports.createTemplate = (wabaId, token, tpl) => graph(`${wabaId}/message_templates`, { method: 'POST', token, body: tpl });
exports._test = { setFetch: (f) => { fetchImpl = f; }, graph };
