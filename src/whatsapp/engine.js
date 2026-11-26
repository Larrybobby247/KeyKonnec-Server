// The guest conversation engine. It talks only to `tools` (tenant-bound backend functions) and never touches the database or Meta directly,
// so the whole booking flow can run, and be tested, with no AI. Groq (optional) can only relabel a message the reader did not understand.
const nlu = require('./nlu');

const STATES = ['GREETING', 'PROPERTY_INFORMATION', 'ROOM_DISCOVERY', 'COLLECTING_CHECK_IN', 'COLLECTING_CHECK_OUT', 'COLLECTING_GUEST_COUNT', 'CHECKING_AVAILABILITY', 'SELECTING_ROOM', 'SHOWING_ROOM_DETAILS', 'BOOKING_SUMMARY', 'COLLECTING_GUEST_INFORMATION', 'AWAITING_PAYMENT', 'PAYMENT_VERIFICATION', 'BOOKING_CONFIRMED', 'BOOKING_MANAGEMENT', 'HUMAN_HANDOVER'];
const FALLBACK = "Sorry, I couldn't quite understand your request. You can type BOOK to start a reservation, ROOMS to see available rooms or STAFF to speak with our team.";
const BUTTON_WORDS = { confirm: 'yes', edit: 'edit', proceed: 'yes', other: 'rooms', cancelb: 'cancel booking', yes: 'yes', no: 'no' };
const naira = (n, cur) => (!cur || cur === 'NGN' ? '₦' : cur + ' ') + Number(n || 0).toLocaleString('en-NG');
const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;
const first = (n) => String(n || '').trim().split(/\s+/)[0];
const BOOKING_STATES = ['COLLECTING_CHECK_IN', 'COLLECTING_CHECK_OUT', 'COLLECTING_GUEST_COUNT', 'CHECKING_AVAILABILITY', 'SELECTING_ROOM', 'SHOWING_ROOM_DETAILS', 'BOOKING_SUMMARY', 'COLLECTING_GUEST_INFORMATION'];

// The free-text we show for hotel facts comes only from what the hotel supplied. Missing facts are never invented.
const TOPIC_WORDS = { pool: /pool/i, restaurant: /restaurant|dining|bar\b|lounge|kitchen/i, gym: /gym|fitness/i, wifi: /wi-?fi|internet/i, parking: /parking/i, breakfast: /breakfast/i };
const NEAR = /(near|close to|minutes? (from|to|away)|walking distance|next to|opposite|beside|landmark)/i;

async function handle({ conv, msg, tools, settings = {}, now = new Date(), ai = null }) {
  const tz = settings.timezone || 'Africa/Lagos', today = nlu.todayIn(tz, now);
  const ctx = JSON.parse(JSON.stringify(conv.ctx || {}));
  ctx.known = ctx.known || {}; ctx.guest = ctx.guest || {};
  let state = conv.state || 'GREETING';
  const R = [], effects = [], info = { aiUsed: false, aiFailed: false };
  const say = (text) => R.push({ kind: 'text', text });
  const cta = (text, label, url) => R.push({ kind: 'cta', text, label, url });
  const buttons = (text, b) => R.push({ kind: 'buttons', text, buttons: b });
  const images = (items) => items.length && R.push({ kind: 'images', items });
  const done = () => ({ replies: R, state, ctx, effects, info });
  let _info, _types;
  const hotel = async () => _info || (_info = await tools.hotelInfo());
  const types = async () => _types || (_types = await tools.listRoomTypes());
  const D = (iso, wd) => nlu.human(nlu.utc(+iso.slice(0, 4), +iso.slice(5, 7), +iso.slice(8, 10)), wd);
  const nights = () => ctx.known.checkIn && ctx.known.checkOut ? Math.round((new Date(ctx.known.checkOut) - new Date(ctx.known.checkIn)) / 864e5) : 0;
  const guestsText = () => { const a = ctx.known.adults || 1, c = ctx.known.children || 0; return plural(a, 'adult') + (c ? ` and ${plural(c, 'child')}`.replace('childs', 'children') : ''); };
  const resetBooking = (keepGuest = true) => { ctx.known = {}; ctx.pending = null; ctx.offered = null; ctx.options = null; ctx.roomTypeId = null; ctx.quote = null; ctx.expect = null; ctx.step = null; ctx.summaryStage = null; ctx.reservationId = null; ctx.reference = null; ctx.payUrl = null; ctx.payRef = null; ctx.confirm = null; ctx.manage = null; ctx.preferred = null; if (!keepGuest) ctx.guest = {}; };

  let text = String(msg.text || '').trim();
  if (msg.buttonId && BUTTON_WORDS[msg.buttonId]) text = BUTTON_WORDS[msg.buttonId];
  if (/^(stop|unsubscribe)$/i.test(text)) { effects.push({ t: 'optout' }); say('You have been unsubscribed from WhatsApp updates. Reply START any time to hear from us again.'); return done(); }
  if (/^start$/i.test(text) && conv.optedOut) { effects.push({ t: 'optin' }); say('Welcome back! You will receive our WhatsApp updates again.'); return done(); }

  // ---- understand the message
  const expectDate = ctx.expect === 'checkIn' || ctx.expect === 'checkOut' ? ctx.expect : null;
  const expectCount = ctx.expect === 'guests' ? 'guests' : ctx.expect === 'rooms' ? 'rooms' : null;
  const known = { checkIn: ctx.known.checkIn && new Date(ctx.known.checkIn), checkOut: ctx.known.checkOut && new Date(ctx.known.checkOut) };
  let u = nlu.read(text, { today, expectDate, expectCount, known });
  const strict = (state === 'COLLECTING_GUEST_INFORMATION' && ['name', 'email', 'phone', 'extras', 'returning'].includes(ctx.step)) || ctx.pending || ctx.confirm || (ctx.manage && ctx.manage.step);
  const gaveEntities = Object.keys(u.dates).length || Object.keys(u.counts).length || u.email || u.phone || u.reference;
  const vague = (u.confidence < 0.55 && u.words.length >= 3) || (u.words.length >= 8 && ['BOOK', 'ROOMS'].includes(u.intent));// a long descriptive request the reader only half understood
  if (vague && !gaveEntities && !strict && ai) {
    try {
      const out = await ai({ message: text, stage: state, today: nlu.iso(today), known: { checkIn: ctx.known.checkIn, checkOut: ctx.known.checkOut, adults: ctx.known.adults }, roomTypes: (await types()).map((t) => t.name) });
      info.aiUsed = true;
      if (out && out.confidence >= 0.5 && out.intent !== 'UNKNOWN') {
        u = fromAi(u, out, today);
      } else if (out && out.needsClarification) u.clarify = out.clarificationTopic;
    } catch { info.aiFailed = true; }
  }

  // ---- shared steps
  const reprompt = async () => {
    if (state === 'AWAITING_PAYMENT' && ctx.payUrl) return cta('Your payment link is still active:', 'Pay now', ctx.payUrl);
    if (BOOKING_STATES.includes(state)) {
      if (state === 'COLLECTING_GUEST_INFORMATION') return askGuestStep();
      if (state === 'BOOKING_SUMMARY') return ctx.summaryStage === 'final' ? showFinal() : showPrelim();
      if (state === 'SELECTING_ROOM' && ctx.options) return listOptions();
      return askNext();
    }
  };
  const askNext = async () => {
    const k = ctx.known;
    if (!k.checkIn) { state = 'COLLECTING_CHECK_IN'; ctx.expect = 'checkIn'; return say('What date would you like to check in?'); }
    if (!k.checkOut) { state = 'COLLECTING_CHECK_OUT'; ctx.expect = 'checkOut'; return say(`Check-in: ${D(k.checkIn, true)}.\nWhat date would you like to check out? (You can also tell me how many nights.)`); }
    if (!k.adults) { state = 'COLLECTING_GUEST_COUNT'; ctx.expect = 'guests'; return say('How many adults will be staying? Please mention any children too.'); }
    ctx.expect = null; return search();
  };
  // Dates the reader flagged as ambiguous are always confirmed with the guest before they are used.
  const applyDates = async (d) => {
    const items = [];
    for (const f of ['checkIn', 'checkOut']) {
      const x = d[f]; if (!x) continue;
      if (x.ambiguous) items.push({ field: f, iso: nlu.iso(x.date), alt: x.alt ? nlu.iso(x.alt) : null, reason: x.reason });
      else setDate(f, nlu.iso(x.date), x);
    }
    if (d.needsExact) { say(`Which exact date would you like to ${ctx.known.checkIn ? 'check out' : 'check in'}? For example "12 December".`); return true; }
    if (items.length) {
      ctx.pending = { items };
      const parts = items.map((i) => `${i.field === 'checkIn' ? 'check in' : 'check out'} on ${D(i.iso, true)}`);
      const alt = items.length === 1 && items[0].alt ? ` (If you meant ${D(items[0].alt, true)}, please send that date.)` : '';
      say(`Just to confirm, you would like to ${parts.join(' and ')}?${alt} Reply YES to confirm, or send the date you want.`);
      return true;
    }
    return false;
  };
  const setDate = (f, iso, meta = {}) => {
    const k = ctx.known;
    if (f === 'checkIn') {
      if (new Date(iso) < today) { say(`That date (${D(iso)}) has already passed. What date would you like to check in?`); ctx.expect = 'checkIn'; return false; }
      k.checkIn = iso; if (k.checkOut && new Date(k.checkOut) <= new Date(iso)) k.checkOut = null;
    } else {
      if (!k.checkIn || new Date(iso) <= new Date(k.checkIn)) { say(k.checkIn ? `Check-out must be after your check-in date (${D(k.checkIn)}). What date will you check out?` : 'Please tell me your check-in date first.'); ctx.expect = k.checkIn ? 'checkOut' : 'checkIn'; return false; }
      if ((new Date(iso) - new Date(k.checkIn)) / 864e5 > 90) { say('Sorry, I can only book stays of up to 90 nights here. Please send a shorter stay, or type STAFF to speak with our team.'); return false; }
      k.checkOut = iso;
    }
    ctx.quote = null; ctx.options = null; return true;
  };
  const applyCounts = (c) => { const k = ctx.known; if (c.adults) k.adults = c.adults; if (c.children != null) k.children = c.children; if (c.rooms) k.rooms = c.rooms; if (Object.keys(c).length) { ctx.quote = null; ctx.options = null; } };
  const applyType = async (text0) => {
    const ts = await types(), m = nlu.matchRoomType(text0, ts, ctx.offered || []);
    return m;
  };

  const listOptions = async () => {
    const k = ctx.known, o = ctx.options || [];
    state = 'SELECTING_ROOM';
    const lines = o.map((x, i) => `${i + 1}. *${x.name}*${x.qty > 1 ? ` × ${x.qty}` : ''}\n    ${naira(x.perNight, ctx.currency)} per night · ${naira(x.total, ctx.currency)} total`).join('\n');
    say(`Available for ${D(k.checkIn)} to ${D(k.checkOut)} (${plural(nights(), 'night')}), ${guestsText()}:\n\n${lines}\n\nReply with the number or name of the room you'd like. Type PHOTOS to see pictures.`);
  };
  const search = async () => {
    const k = ctx.known; state = 'CHECKING_AVAILABILITY';
    let res;
    try { res = await tools.searchAvailableRooms({ checkIn: k.checkIn, checkOut: k.checkOut, adults: k.adults, children: k.children || 0, rooms: k.rooms || null }); }
    catch (e) { say(e.status && e.status < 500 ? `${e.message}. Please send different dates.` : "Sorry, I couldn't check availability just now. Please try again in a moment, or type STAFF to speak with our team."); if (e.status && e.status < 500) { state = 'COLLECTING_CHECK_IN'; ctx.expect = 'checkIn'; ctx.known.checkIn = null; ctx.known.checkOut = null; } return; }
    if (!res.options.length) {
      const why = (res.restricted || []).map((r) => `• ${r.name}: ${r.reason}`).join('\n');
      const alt = (res.alternatives || []).map((a) => `• ${D(a.checkIn)} to ${D(a.checkOut)} (from ${naira(a.from)})`).join('\n');
      say(`Sorry, we have no room available for ${D(k.checkIn)} to ${D(k.checkOut)} for ${guestsText()}.${why ? `\n\n${why}` : ''}${alt ? `\n\nSimilar stays that are open:\n${alt}\n\nSend the dates you prefer, or type STAFF to speak with our team.` : '\n\nYou can send different dates, or type STAFF to speak with our team.'}`);
      state = 'COLLECTING_CHECK_IN'; ctx.known.checkIn = null; ctx.known.checkOut = null; ctx.expect = 'checkIn'; return;
    }
    ctx.options = res.options.map((x) => ({ typeId: x.typeId, name: x.name, qty: x.qty, total: x.total, perNight: x.perNight, nights: x.nights })); ctx.offered = ctx.options.map((x) => x.typeId); ctx.currency = (await hotel()).currency;
    const pref = ctx.preferred && ctx.options.find((x) => x.typeId === ctx.preferred);
    if (pref) { ctx.preferred = null; return select(pref); }
    if (ctx.preferred) { ctx.preferred = null; say("That room isn't available for those dates, but these are:"); }
    if (ctx.prefs && ctx.prefs.length) ctx.options.sort((a, b) => (ctx.prefs.includes('budget') ? a.total - b.total : 0) || ((res.options.find((x) => x.typeId === b.typeId).capacity) - (res.options.find((x) => x.typeId === a.typeId).capacity)));
    ctx.offered = ctx.options.map((x) => x.typeId);
    return listOptions();
  };
  const select = async (opt) => {
    const k = ctx.known; state = 'SHOWING_ROOM_DETAILS';
    const [q, det] = await Promise.all([tools.calculateBookingPrice({ typeId: opt.typeId, checkIn: k.checkIn, checkOut: k.checkOut, qty: opt.qty }), tools.getRoomDetails(opt.typeId)]);
    if (!q || !det) { say("Sorry, that room is no longer available. Let me check again."); return search(); }
    if (q.left < opt.qty) { say('Sorry, that room was just taken.'); return search(); }
    ctx.roomTypeId = opt.typeId; ctx.qty = opt.qty; ctx.quote = { total: q.total, nights: q.nights, subtotal: q.subtotal, discount: q.discount, tax: q.tax, accommodation: q.accommodation, deposit: q.deposit, perNight: Math.round(q.subtotal / q.nights / opt.qty), currency: q.currency, typeName: q.typeName, hotelName: q.hotelName };
    const facts = [det.description && det.description.slice(0, 400), `Sleeps up to ${det.capacity}${det.bedType ? ` · ${det.beds || 1} ${det.bedType}` : ''}${det.size ? ` · ${det.size} sqm` : ''}`, det.amenities.length ? `Amenities: ${det.amenities.slice(0, 8).join(', ')}` : ''].filter(Boolean).join('\n');
    say(`*${det.name}*\n${facts}`);
    images(det.images.slice(0, 3).map((u2, i) => ({ url: u2, caption: i === 0 ? det.name : '' })));
    return showPrelim();
  };
  const summaryLines = (g) => {
    const q = ctx.quote, k = ctx.known, h = _info;
    return [`Property: ${q.hotelName}`, g && `Guest: ${ctx.guest.name}`, g && `Email: ${ctx.guest.email}`, g && `Phone: +${ctx.guest.phone || conv.waId}`, `Room: ${q.typeName}${ctx.qty > 1 ? ` × ${ctx.qty}` : ''}`, `Check-in: ${D(k.checkIn)}`, `Check-out: ${D(k.checkOut)}`, `Duration: ${plural(q.nights, 'night')}`, `Guests: ${guestsText()}`, `Room rate: ${naira(q.perNight, q.currency)} per night`,
      q.discount > 0 && `Discount: -${naira(q.discount, q.currency)}`, q.tax > 0 && `Taxes and fees: ${naira(q.tax, q.currency)}`, `Total: ${naira(q.total, q.currency)}`, q.deposit < q.total && `Payable now: ${naira(q.deposit, q.currency)} (balance ${naira(q.total - q.deposit, q.currency)} later)`].filter(Boolean).join('\n');
  };
  const showPrelim = async () => { if (settings.bookingEnabled === false) { state = 'ROOM_DISCOVERY'; return say('Booking through WhatsApp is not available right now, but our team can reserve this room for you. Type STAFF and they will take it from here.'); }
    state = 'BOOKING_SUMMARY'; ctx.summaryStage = 'prelim'; buttons(`Here is your booking summary:\n\n${summaryLines(false)}\n\nWould you like to proceed with this reservation?`, [{ id: 'proceed', title: 'Yes, proceed' }, { id: 'other', title: 'Other rooms' }]); };
  const showFinal = async () => { state = 'BOOKING_SUMMARY'; ctx.summaryStage = 'final'; buttons(`BOOKING SUMMARY\n\n${summaryLines(true)}\n\nPlease confirm that everything is correct. You can also tap Edit to change a detail.`, [{ id: 'confirm', title: 'Confirm' }, { id: 'edit', title: 'Edit' }, { id: 'cancelb', title: 'Cancel' }]); };

  // ---- guest details, one field at a time
  const askGuestStep = async () => {
    state = 'COLLECTING_GUEST_INFORMATION';
    const s = ctx.step, g = ctx.guest;
    if (s === 'returning') return say(`Welcome back${ctx.returning ? ', ' + first(ctx.returning.name) : ''}! Should I use these details?\nName: ${ctx.returning.name}\nEmail: ${ctx.returning.email}\n\nReply YES to confirm, or NO to enter new details.`);
    if (s === 'name') return say(g.name && !g.nameFull ? `Thanks. Please send your full name (first name and surname).` : 'Great! What is your full name?');
    if (s === 'email') return say(`Thank you${g.name ? ', ' + first(g.name) : ''}. What email address should we use to send your booking confirmation and payment receipt?`);
    if (s === 'phone') return say(`We have your WhatsApp number as +${conv.waId}. Is this the best number to contact you on? Reply YES, or send a different number.`);
    if (s === 'extras') return say('Do you have any special requests or an expected arrival time? Reply with the details, or NO if not.');
    return showFinal();
  };
  const startGuestInfo = async () => {
    state = 'COLLECTING_GUEST_INFORMATION'; ctx.summaryStage = null;
    if (!ctx.guest.confirmed && !ctx.guest.name) { const p = await tools.getGuestProfile(conv.waId).catch(() => null); if (p) { ctx.returning = { name: p.name, email: p.email }; ctx.step = 'returning'; return askGuestStep(); } }
    ctx.step = !ctx.guest.name ? 'name' : !ctx.guest.email ? 'email' : !ctx.guest.phoneOk ? 'phone' : ctx.guest.extrasDone ? 'review' : 'extras';
    return askGuestStep();
  };
  const guestInput = async () => {
    const s = ctx.step, g = ctx.guest, yes = u.intent === 'YES', no = u.intent === 'NO';
    const before = ctx.step; await guestStep(s, g, yes, no);
    // when the guest is only correcting one detail, go straight back to the summary
    if (ctx.editing && ctx.step !== before) { ctx.editing = false; ctx.step = 'review'; R.length = 0; return showFinal(); }
  };
  const guestStep = async (s, g, yes, no) => {
    if (s === 'returning') {
      if (yes) { Object.assign(g, { name: ctx.returning.name, nameFull: true, email: ctx.returning.email, confirmed: true }); ctx.step = 'phone'; return askGuestStep(); }
      ctx.returning = null; ctx.step = 'name'; return askGuestStep();
    }
    if (s === 'name') {
      const n = nlu.readName(text);
      if (!n) { say("I didn't catch that as a name. Please send your full name, for example: Ada Okafor."); return; }
      if (!n.full && !g.nameTried) { g.nameTried = true; g.name = n.value; g.nameFull = false; return askGuestStep(); }
      g.name = n.value; g.nameFull = true; ctx.step = g.email ? 'phone' : 'email'; return askGuestStep();
    }
    if (s === 'email') {
      const e = u.email;
      if (!e) { say('Please send a valid email address, for example name@example.com.'); return; }
      if (!e.valid) { say(`"${e.value}" doesn't look like a valid email address. Please check it and send it again.`); return; }
      g.email = e.value; ctx.step = 'phone'; return askGuestStep();
    }
    if (s === 'phone') {
      if (yes) { g.phone = conv.waId; g.phoneOk = true; ctx.step = 'extras'; return askGuestStep(); }
      const p = u.phone || nlu.normPhone(text);
      if (p) { g.phone = p; g.phoneOk = true; ctx.step = 'extras'; return askGuestStep(); }
      say(no ? 'No problem. Please send the number you would like us to use, for example 08031234567.' : "That doesn't look like a valid phone number. Reply YES to use your WhatsApp number, or send another number.");
      return;
    }
    if (s === 'extras') {
      if (!(no || /^(none|nothing|nil|no thanks|nope)\b/i.test(text))) { const arr = text.slice(0, 300); g.special = arr; }
      g.extrasDone = true; ctx.step = 'review'; return showFinal();
    }
  };
  const editGuest = async () => {
    const t = u.text; state = 'COLLECTING_GUEST_INFORMATION'; ctx.editing = true;
    if (/\b(name)\b/.test(t)) { ctx.step = 'name'; ctx.guest.name = null; ctx.guest.nameTried = false; }
    else if (/\b(email|mail)\b/.test(t)) { ctx.step = 'email'; }
    else if (/\b(phone|number|contact|whatsapp)\b/.test(t)) { ctx.step = 'phone'; }
    else if (/\b(request|arrival|note)\b/.test(t)) { ctx.step = 'extras'; }
    else if (/\b(date|dates|checkin|checkout|night|nights|stay)\b/.test(t)) { ctx.editing = false; ctx.known.checkIn = null; ctx.known.checkOut = null; ctx.options = null; return askNext(); }
    else if (/\b(room|apartment|suite)\b/.test(t)) { ctx.quote = null; return search(); }
    else if (/\b(guest|guests|people|adults?|children|kids?)\b/.test(t)) { ctx.known.adults = null; ctx.options = null; return askNext(); }
    else { buttons('What would you like to change?\nReply with: name, email, phone, dates, room or guests.', [{ id: 'confirm', title: 'Nothing, confirm' }]); return; }
    return askGuestStep();
  };

  // ---- creating the booking: availability and price are rechecked, then the existing booking engine does the work
  const book = async () => {
    if (!(await tools.bookingAllowed())) { say("Sorry, online booking through WhatsApp isn't available right now. I'll let our team know so they can help you."); effects.push({ t: 'handover', reason: 'WhatsApp booking disabled; guest wanted to book' }); state = 'HUMAN_HANDOVER'; return; }
    if (ctx.reservationId && state !== 'BOOKING_SUMMARY') return;
    const k = ctx.known, g = ctx.guest;
    let q;
    try { q = await tools.calculateBookingPrice({ typeId: ctx.roomTypeId, checkIn: k.checkIn, checkOut: k.checkOut, qty: ctx.qty || 1 }); } catch (e) { say(`${e.message}. Please choose different dates.`); k.checkIn = null; k.checkOut = null; return askNext(); }
    if (!q || q.left < (ctx.qty || 1)) { say('Sorry, that room has just been taken. Let me show you what is still available.'); ctx.roomTypeId = null; return search(); }
    if (Math.round(q.total * 100) !== Math.round(ctx.quote.total * 100)) { ctx.quote = { ...ctx.quote, total: q.total, nights: q.nights, subtotal: q.subtotal, discount: q.discount, tax: q.tax, accommodation: q.accommodation, deposit: q.deposit, perNight: Math.round(q.subtotal / q.nights / (ctx.qty || 1)) }; say('The price for these dates has changed since I last checked, so please review the updated summary.'); return showFinal(); }
    let out;
    try { out = await tools.createPendingBooking({ typeId: ctx.roomTypeId, checkIn: k.checkIn, checkOut: k.checkOut, adults: k.adults, children: k.children || 0, qty: ctx.qty || 1, name: g.name, email: g.email, phone: g.phone || conv.waId, special: g.special }); }
    catch (e) {
      if (e.status === 409) { say(`${e.message}`); ctx.roomTypeId = null; return search(); }
      if (e.status && e.status < 500) { say(`${e.message}`); effects.push({ t: 'handover', reason: e.message }); state = 'HUMAN_HANDOVER'; return; }
      say("Sorry, I couldn't create your reservation just now. Nothing has been charged. Please try again in a moment, or type STAFF to speak with our team."); return;
    }
    ctx.reservationId = out.id; ctx.reference = out.reference; ctx.payUrl = out.payUrl; ctx.payRef = out.payRef; ctx.expiresAt = out.expiresAt;
    effects.push({ t: 'link', reservationId: out.id });
    if (out.status === 'requested') { state = 'BOOKING_MANAGEMENT'; say(`Thank you, ${first(g.name)}. Your booking request ${out.reference} has been sent to the hotel. They will contact you with confirmation and payment instructions. No payment has been taken.`); return; }
    state = 'AWAITING_PAYMENT';
    const mins = (await hotel()).holdMinutes;
    cta(`Your reservation has been created. Reference: ${out.reference}\n\nAmount to pay: ${naira(out.deposit, ctx.quote.currency)}\nYour room is held for ${mins} minutes. Please complete payment using the link below to confirm your booking.`, 'Pay now', out.payUrl);
  };

  // ---- managing existing bookings (identity is the WhatsApp number, or reference plus the email on the booking)
  const bookingText = (b) => `*${b.reference}* · ${b.typeName}${b.qty > 1 ? ' × ' + b.qty : ''}\n${D(b.checkIn)} to ${D(b.checkOut)}\nStatus: ${b.status.replace('_', ' ')} · Payment: ${b.paymentStatus} (${naira(b.paid, b.currency)} of ${naira(b.total, b.currency)})`;
  const manage = async (action) => {
    state = 'BOOKING_MANAGEMENT';
    const linked = (conv.reservations || []).map(String);
    if (u.reference && !ctx.manageVerified) {
      const mine = await tools.getGuestBookings(conv.waId, linked);
      const hit = mine.find((r) => r.reference === u.reference);
      if (hit) { ctx.manage = { action, id: String(hit._id), step: 'selected' }; return continueManage(); }
      ctx.manage = { action, ref: u.reference, step: 'email' }; say('For your security, please send the email address used for that booking.'); return;
    }
    const list = await tools.getGuestBookings(conv.waId, linked);
    const live = list.filter((r) => action === 'receipt' || action === 'status' || !['cancelled', 'expired', 'checked_out', 'no_show'].includes(r.status));
    if (!live.length) { ctx.manage = { action, step: 'ref' }; say("I couldn't find a booking linked to this WhatsApp number. If you booked with a different number, please send your booking reference (like KK-1A2B3C4D) and I'll verify it."); return; }
    if (live.length === 1) { ctx.manage = { action, id: String(live[0]._id), step: 'selected' }; return continueManage(); }
    ctx.manage = { action, step: 'pick', list: live.slice(0, 5).map((r) => String(r._id)) };
    const rows = await Promise.all(ctx.manage.list.map((id) => tools.getBookingStatus(id)));
    say(`I found ${live.length} bookings. Which one do you mean?\n\n${rows.map((b, i) => `${i + 1}. ${b.reference} · ${D(b.checkIn)} to ${D(b.checkOut)} · ${b.status.replace('_', ' ')}`).join('\n')}\n\nReply with the number or the reference.`);
  };
  const continueManage = async () => {
    const m = ctx.manage, b = await tools.getBookingStatus(m.id);
    if (!b) { ctx.manage = null; say("Sorry, I couldn't find that booking."); return; }
    if (m.action === 'status') { ctx.manage = null; return say(bookingText(b) + (b.balance > 0 && ['confirmed', 'checked_in'].includes(b.status) ? `\nBalance: ${naira(b.balance, b.currency)}` : '')); }
    if (m.action === 'receipt') {
      ctx.manage = null;
      if (b.receiptUrl) return cta(`Here is your payment receipt for ${b.reference}. It opens on your phone or computer, no login needed.`, 'Download receipt', b.receiptUrl);
      return say(`There is no payment receipt for ${b.reference} yet because we haven't verified a payment for it.`);
    }
    if (m.action === 'cancel') {
      m.step = 'confirm'; ctx.confirm = 'cancel_booking'; const pol = (await hotel()).policies.cancellation;
      return say(`${bookingText(b)}\n\n${pol ? `Cancellation policy: ${pol}\n\n` : ''}Do you want to request cancellation of ${b.reference}? Reply YES to confirm or NO to keep it.${b.paid > 0 ? '\nBecause a payment was made, our team will review your request and any refund according to the hotel policy.' : ''}`);
    }
    if (m.action === 'modify') {
      if (!['confirmed', 'requested'].includes(b.status)) { ctx.manage = null; return say(`${b.reference} can't be changed while it is ${b.status.replace('_', ' ')}.`); }
      m.step = 'dates'; ctx.expect = 'checkIn'; ctx.known = {}; return say(`${bookingText(b)}\n\nWhat new check-in and check-out dates would you like? (To change the room type instead, type STAFF.)`);
    }
  };

  // ================================================================ routing
  // 0. a date we asked the guest to confirm
  if (ctx.pending) {
    if (u.intent === 'YES') { for (const i of ctx.pending.items) if (!setDate(i.field, i.iso)) break; ctx.pending = null; ctx.expect = null; return afterSlots(); }
    if (u.intent === 'NO') { const f = ctx.pending.items[0].field; ctx.pending = null; ctx.expect = f; return say(`No problem. What date would you like to ${f === 'checkIn' ? 'check in' : 'check out'}?`), done(); }
    ctx.pending = null;
  }
  async function afterSlots() {
    if (ctx.manage && ctx.manage.step === 'dates') return modifyDates();
    if (state === 'BOOKING_SUMMARY' && ctx.summaryStage === 'final' && ctx.roomTypeId && ctx.known.checkIn && ctx.known.checkOut && ctx.known.adults) { return search().then(done); }
    await askNext(); return done();
  }
  async function modifyDates() {
    const k = ctx.known;
    if (!k.checkIn || !k.checkOut) { await askNext2(); return done(); }
    const p = await tools.previewModification(ctx.manage.id, k.checkIn, k.checkOut);
    if (p.error) { ctx.manage.step = 'dates'; ctx.known = {}; ctx.expect = 'checkIn'; say(p.error === 'unavailable' ? 'Sorry, those dates are not available. Please send different dates.' : p.error === 'rule' ? `${p.message}. Please send different dates.` : "This booking can't be changed online."); return done(); }
    ctx.manage.step = 'confirm_modify'; ctx.manage.checkIn = k.checkIn; ctx.manage.checkOut = k.checkOut; ctx.confirm = 'modify_booking';
    say(`New dates: ${D(k.checkIn)} to ${D(k.checkOut)} (${plural(p.nights, 'night')}).\nNew total: ${naira(p.newTotal, p.currency)} (currently ${naira(p.oldTotal, p.currency)}${p.diff ? `, ${p.diff > 0 ? '+' : '-'}${naira(Math.abs(p.diff), p.currency)}` : ''}).\n\nReply YES to send this change to the hotel for approval, or NO to keep your booking as it is.`);
    return done();
  }
  async function askNext2() { const k = ctx.known; if (!k.checkIn) { ctx.expect = 'checkIn'; return say('What new check-in date would you like?'); } ctx.expect = 'checkOut'; return say('And the new check-out date?'); }

  // 1. confirmations that are waiting for YES / NO
  if (ctx.confirm) {
    const c = ctx.confirm;
    if (u.intent === 'YES') {
      ctx.confirm = null;
      if (c === 'cancel_pending') {
        const claimed = await tools.claimNotice(ctx.reservationId, 'cancelled'); const ok = await tools.cancelPending(ctx.reservationId);
        say(ok ? `Your reservation ${ctx.reference} has been cancelled and nothing was charged. Type BOOK any time to start a new one.` : "That reservation can't be cancelled here any more. Please type STAFF to speak with our team.");
        void claimed; resetBooking(); state = 'GREETING'; return done();
      }
      if (c === 'cancel_booking') {
        const id = ctx.manage.id, b = await tools.getBookingStatus(id);
        if (b.paid === 0) await tools.claimNotice(id, 'cancelled');
        const r = await tools.requestCancellation(id); ctx.manage = null;
        if (r.done) say(`Your reservation ${b.reference} has been cancelled.`);
        else if (r.pendingApproval) { await tools.claimNotice(id, 'cancel_requested'); say('Your cancellation request has been received. Our team will update you once it has been processed.'); }
        else say(`Sorry, ${b.reference} can't be cancelled (${(r.status || 'it is closed').replace('_', ' ')}).`);
        return done();
      }
      if (c === 'modify_booking') {
        const m = ctx.manage, r = await tools.requestModification(m.id, m.checkIn, m.checkOut); ctx.manage = null; ctx.known = {}; ctx.expect = null;
        say(r.pendingApproval ? 'Your change request has been sent to the hotel team. We will update you here as soon as it has been reviewed. Your current booking stays as it is until then.' : "Sorry, I couldn't send that request. Please type STAFF to speak with our team."); return done();
      }
    }
    if (u.intent === 'NO') { ctx.confirm = null; ctx.manage = null; say(c === 'cancel_pending' ? 'No problem, your payment link is still active.' : 'No problem, nothing has been changed.'); if (c === 'cancel_pending' && ctx.payUrl) cta('Pay when you are ready:', 'Pay now', ctx.payUrl); return done(); }
    ctx.confirm = null;
  }
  // 2. waiting for the booking reference / email / which booking
  if (ctx.manage && ctx.manage.step === 'email') {
    const e = u.email;
    if (!e || !e.valid) { say('Please send the email address used for the booking.'); return done(); }
    const id = await tools.verifyByReference(ctx.manage.ref, e.value);
    ctx.verifyFails = (ctx.verifyFails || 0) + (id ? 0 : 1);
    if (!id) { if (ctx.verifyFails >= 3) { ctx.manage = null; ctx.verifyFails = 0; say("I couldn't verify that booking. I'll ask our team to help you."); effects.push({ t: 'handover', reason: 'Could not verify booking ownership' }); state = 'HUMAN_HANDOVER'; return done(); } say("That email doesn't match the booking reference. Please check and try again."); return done(); }
    effects.push({ t: 'link', reservationId: id }); ctx.manage = { action: ctx.manage.action, id, step: 'selected' }; await continueManage(); return done();
  }
  if (ctx.manage && ctx.manage.step === 'ref') {
    if (u.reference) { await manage(ctx.manage.action); return done(); }
    if (['NO', 'MENU', 'GREETING'].includes(u.intent)) { ctx.manage = null; say('No problem. How else can I help? You can type BOOK, ROOMS or STAFF.'); return done(); }
    say('Please send your booking reference, for example KK-1A2B3C4D.'); return done();
  }
  if (ctx.manage && ctx.manage.step === 'pick') {
    const n = (text.match(/^\s*(\d)\s*$/) || [])[1], refHit = u.reference;
    let id = n ? ctx.manage.list[+n - 1] : null;
    if (!id && refHit) { const rows = await Promise.all(ctx.manage.list.map((x) => tools.getBookingStatus(x))); const m = rows.find((b) => b.reference === refHit); id = m && m.id; }
    if (id) { ctx.manage.id = id; ctx.manage.step = 'selected'; await continueManage(); return done(); }
    say('Please reply with the number of the booking, for example 1.'); return done();
  }

  // 3. intents that work in every state
  const hotelFacts = async () => {
    const h = await hotel(), ts = await types(), out = [];
    for (const t of u.topics) {
      const hay = [...h.amenities, ...ts.flatMap((x) => x.amenities)];
      const has = (re) => hay.filter((a) => re.test(a));
      if (TOPIC_WORDS[t]) { const f = has(TOPIC_WORDS[t]); out.push(f.length ? `Yes, we have: ${[...new Set(f)].join(', ')}.` : `I don't have ${t === 'wifi' ? 'Wi-Fi' : t} details listed. Our team can confirm if you type STAFF.`); }
      else if (t === 'checkin_time') out.push(h.policies.checkInTime ? `Check-in is from ${h.policies.checkInTime}.` : "I don't have the check-in time listed. Our team can confirm it if you type STAFF.");
      else if (t === 'checkout_time') out.push(h.policies.checkOutTime ? `Check-out is by ${h.policies.checkOutTime}.` : "I don't have the check-out time listed. Our team can confirm it if you type STAFF.");
      else if (t === 'policies') out.push(h.policies.cancellation ? `Cancellation policy: ${h.policies.cancellation}` : "The hotel hasn't published its policies here. Our team can explain them if you type STAFF.");
      else if (t === 'contact') out.push([h.phone && `Phone: ${h.phone}`, h.email && `Email: ${h.email}`, h.hours && `Hours: ${h.hours}`].filter(Boolean).join('\n') || 'Our team can share contact details if you type STAFF.');
      else if (t === 'location') out.push(h.address ? `${h.name} is at ${h.address}.${h.address ? '\nMap: https://www.google.com/maps/search/?api=1&query=' + encodeURIComponent(h.name + ' ' + h.address) : ''}` : "I don't have the address listed. Our team can help if you type STAFF.");
      else if (t === 'landmarks') { const s = (h.description || '').split(/(?<=[.!?])\s+/).filter((x) => NEAR.test(x)).slice(0, 2).join(' '); out.push(s || "I don't have nearby landmarks listed. Our team can help if you type STAFF."); }
      else if (t === 'amenities') out.push(hay.length ? `Amenities: ${[...new Set(hay)].slice(0, 15).join(', ')}.` : "I don't have an amenities list. Our team can help if you type STAFF.");
      else if (t === 'description') out.push(h.description ? h.description.slice(0, 600) : `${h.name}${h.address ? ', ' + h.address : ''}. Type ROOMS to see what is available.`);
      else if (t === 'name') out.push(`You are chatting with ${h.name}.`);
    }
    return out.join('\n\n');
  };
  const sendPhotos = async () => {
    const ts = await types(), pick = ctx.roomTypeId ? ts.filter((t) => t.id === ctx.roomTypeId) : ts.filter((t) => t.images.length).slice(0, 4);
    const items = pick.flatMap((t) => t.images.slice(0, ctx.roomTypeId ? 4 : 1).map((u2, i) => ({ url: u2, caption: i === 0 ? `${t.name} · ${naira(t.price)} per night` : '' }))).slice(0, 4);
    return items.length ? images(items) : say("I don't have photos to share yet. Our team can send some if you type STAFF.");
  };

  const I = u.intent;
  if (I === 'HUMAN') { state = 'HUMAN_HANDOVER'; effects.push({ t: 'handover', reason: 'Guest asked to speak with someone' }); say("Of course. I'm connecting you with our team. They'll reply here as soon as they can."); return done(); }
  if (I === 'RESTART' || (I === 'CANCEL' && BOOKING_STATES.includes(state))) { resetBooking(); state = 'GREETING'; say(I === 'CANCEL' ? 'No problem, I have cancelled this booking request. Type BOOK whenever you are ready.' : 'Okay, let us start again. What would you like to do? Type BOOK, ROOMS or STAFF.'); return done(); }
  if (I === 'CANCEL' && state === 'AWAITING_PAYMENT') { ctx.confirm = 'cancel_pending'; say(`Do you want to cancel reservation ${ctx.reference}? Nothing has been charged. Reply YES to cancel or NO to keep it.`); return done(); }
  if (I === 'MENU') { say('I can help you check rooms and prices, make a booking, find your reservation or get your receipt. Type BOOK, ROOMS, MY BOOKING, RECEIPT or STAFF.'); return done(); }
  if (I === 'CANCEL') { await manage('cancel'); return done(); }
  if (I === 'MODIFY') { await manage('modify'); return done(); }
  if (I === 'RECEIPT') { await manage('receipt'); return done(); }
  if (I === 'MY_BOOKING') { await manage('status'); return done(); }
  if (I === 'REBOOK_LAST') {
    const p = await tools.getGuestProfile(conv.waId).catch(() => null);
    if (p && p.roomTypeId) { ctx.preferred = p.roomTypeId; say("I can look for the same type of room again. Past dates and requests won't be reused."); await askNext(); return done(); }
    say("I couldn't find an earlier booking for this number. Let me help you find a room."); await askNext(); return done();
  }
  if (I === 'PAID_CLAIM' || (state === 'AWAITING_PAYMENT' && /\b(paid|payment)\b/.test(u.text) && I !== 'PAY')) {
    if (!ctx.reservationId) { await manage('status'); return done(); }
    state = 'PAYMENT_VERIFICATION';
    const v = await tools.verifyPayment(ctx.reservationId);
    if (v && v.confirmed) { state = 'BOOKING_CONFIRMED'; say('Thank you! Paystack has confirmed your payment. Your booking confirmation and receipt are on their way.'); return done(); }
    if (v && v.expired) { state = 'GREETING'; say('Your payment hold has expired, so the room was released. Type BOOK to start again.'); resetBooking(); return done(); }
    state = 'AWAITING_PAYMENT';
    say("We haven't received a payment confirmation from Paystack yet. If you just paid, please wait a minute and tell me again. A screenshot can't confirm a booking, only a verified payment can.");
    if (ctx.payUrl) cta('If you have not completed payment yet, use this link:', 'Pay now', ctx.payUrl);
    return done();
  }
  if (I === 'PAY') {
    if (state === 'AWAITING_PAYMENT' && ctx.payUrl) { cta(`Here is your payment link for ${ctx.reference}:`, 'Pay now', ctx.payUrl); return done(); }
    if (state === 'BOOKING_SUMMARY' && ctx.summaryStage === 'final') { await book(); return done(); }
    if (ctx.roomTypeId && ctx.quote) { await startGuestInfo(); return done(); }
    say("Let's get your booking ready first. What date would you like to check in?"); ctx.expect = 'checkIn'; state = 'COLLECTING_CHECK_IN'; return done();
  }
  if (I === 'PHOTOS') { await sendPhotos(); await reprompt(); return done(); }
  if (I === 'THANKS' && !BOOKING_STATES.includes(state)) { say("You're welcome! Let us know if you need anything else."); return done(); }
  if (I === 'GREETING' && !gaveEntities) {
    const h = await hotel();
    if (BOOKING_STATES.includes(state) || state === 'AWAITING_PAYMENT') { say(`Hello again! Let's continue.`); await reprompt(); return done(); }
    state = 'GREETING'; say(`${settings.greeting || `Hello! Welcome to ${h.name}.`}\n\nI can help you check rooms and prices, make a booking, or find your reservation. Type BOOK to start, ROOMS to see rooms, or STAFF to speak with our team.`); return done();
  }
  if (u.topics.length && (I === 'INFO' || !['BOOK', 'ROOMS', 'DETAILS', 'PRICE'].includes(I))) {
    const f = await hotelFacts(); if (f) { if (state === 'GREETING') state = 'PROPERTY_INFORMATION'; say(f); await reprompt(); return done(); }
  }
  if (I === 'PRICE' && !ctx.quote) {
    const ts = await types();
    if (!ts.length) { say("I don't have room prices listed. Our team can help if you type STAFF."); return done(); }
    if (ctx.known.checkIn && ctx.known.checkOut && ctx.known.adults) { await search(); return done(); }
    say(`Our rooms:\n\n${ts.slice(0, 8).map((t) => `• *${t.name}* from ${naira(t.price)} per night (sleeps ${t.capacity})`).join('\n')}\n\nSend your dates and number of guests and I'll check availability and your exact total.`);
    state = 'ROOM_DISCOVERY'; if (!ctx.known.checkIn) { ctx.expect = 'checkIn'; }
    return done();
  }

  // 4. booking flow: fill whatever the guest told us, wherever we are
  const inFlow = BOOKING_STATES.includes(state) || ['GREETING', 'PROPERTY_INFORMATION', 'ROOM_DISCOVERY', 'BOOKING_CONFIRMED', 'BOOKING_MANAGEMENT', 'HUMAN_HANDOVER', 'PAYMENT_VERIFICATION', 'AWAITING_PAYMENT'].includes(state);
  if (state === 'COLLECTING_GUEST_INFORMATION' && ['name', 'email', 'phone', 'extras', 'returning'].includes(ctx.step) && !(I === 'EDIT')) { await guestInput(); return done(); }
  if (state === 'BOOKING_SUMMARY') {
    if (ctx.summaryStage === 'prelim') {
      if (I === 'YES') { await startGuestInfo(); return done(); }
      if (I === 'NO' || /\b(other|different|another)\b/.test(u.text) || I === 'ROOMS') { ctx.roomTypeId = null; ctx.quote = null; if (ctx.options) await listOptions(); else await askNext(); return done(); }
    } else if (ctx.summaryStage === 'final') {
      if (I === 'YES') { await book(); return done(); }
      if (I === 'EDIT' || I === 'NO') { await editGuest(); return done(); }
    }
  }
  if (state === 'AWAITING_PAYMENT' && !['BOOK'].includes(I)) { say(ctx.payUrl ? 'Your reservation is waiting for payment. You can type PAY for the link again, PAID once you have paid, or CANCEL to release the room.' : 'Your booking request is with the hotel team.'); return done(); }
  if (I === 'BOOK' && ['BOOKING_CONFIRMED', 'BOOKING_MANAGEMENT', 'AWAITING_PAYMENT', 'HUMAN_HANDOVER', 'GREETING'].includes(state) && (ctx.reservationId || state !== 'GREETING')) resetBooking(true);

  const prevType = await (async () => { if (ctx.options || I === 'BOOK' || I === 'ROOMS' || state === 'SELECTING_ROOM') return applyType(text); return { type: null }; })();
  // choosing a room from the list
  if (state === 'SELECTING_ROOM' && ctx.options && !Object.keys(u.dates).length) {
    if (prevType.type) { const opt = ctx.options.find((x) => x.typeId === String(prevType.type.id)); if (opt) { await select(opt); return done(); } }
    if (prevType.ambiguous) { say(`Did you mean ${prevType.candidates.map((c) => c.name).join(' or ')}? Please reply with the number from the list.`); return done(); }
  }
  if (prevType.type && !ctx.roomTypeId) ctx.preferred = String(prevType.type.id);
  if (u.dates.nights) ctx.known.nights = u.dates.nights;
  const askedDates = await applyDates(u.dates);
  applyCounts(u.counts);
  if (u.prefs) ctx.prefs = u.prefs;
  if (ctx.expect === 'guests' && !u.counts.adults && !gaveEntities && !askedDates) { say('How many adults will be staying? For example "2 adults and 1 child".'); return done(); }
  if (askedDates) return done();
  if (['BOOK', 'ROOMS', 'DETAILS', 'PRICE', 'EDIT', 'NO', 'YES'].includes(I) || gaveEntities || u.clarify) {
    if (I === 'NO' || I === 'YES') { if (!BOOKING_STATES.includes(state)) { say('How can I help? You can type BOOK, ROOMS or STAFF.'); return done(); } }
    if (ctx.known.checkIn && ctx.known.checkOut && ctx.known.adults && ctx.roomTypeId && ctx.quote && ['SELECTING_ROOM', 'SHOWING_ROOM_DETAILS'].includes(state) && !Object.keys(u.dates).length && !Object.keys(u.counts).length) { await showPrelim(); return done(); }
    if (!ctx.roomTypeId || !ctx.quote || Object.keys(u.dates).length || Object.keys(u.counts).length) { ctx.roomTypeId = null; await askNext(); return done(); }
    await reprompt(); return done();
  }
  // nothing understood
  ctx.fallbacks = (ctx.fallbacks || 0) + 1;
  say(FALLBACK);
  if (ctx.fallbacks >= 3) { ctx.fallbacks = 0; effects.push({ t: 'flag', reason: 'Guest message was not understood three times' }); say('I can also ask a team member to take over. Just type STAFF.'); }
  return done();
}

// Groq's labels are mapped onto the reader's own output. Dates it supplies are always treated as "needs confirming".
function fromAi(u, out, today) {
  const map = { ROOM_SEARCH: 'ROOMS', SELECT_ROOM: 'BOOK' };
  const dates = {}; const e = out.entities || {};
  if (e.checkIn) dates.checkIn = { date: new Date(e.checkIn + 'T00:00:00Z'), ambiguous: true, reason: 'ai' };
  if (e.checkOut) dates.checkOut = { date: new Date(e.checkOut + 'T00:00:00Z'), ambiguous: true, reason: 'ai' };
  if (e.nights) dates.nights = e.nights;
  const counts = {}; if (e.adults) counts.adults = e.adults; if (e.children != null) counts.children = e.children; if (e.rooms) counts.rooms = e.rooms;
  return { ...u, intent: map[out.intent] || out.intent, confidence: out.confidence, topics: e.topic ? [e.topic] : u.topics, dates, counts, prefs: e.preferences && e.preferences.length ? e.preferences : undefined, aiName: e.roomTypeName };
}

module.exports = { handle, STATES, FALLBACK };
