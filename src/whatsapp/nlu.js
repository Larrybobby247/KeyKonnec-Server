// Deterministic message reader for WhatsApp guests. No network, no AI, no database: pure functions, easy to test.
// It understands common English and Nigerian English/pidgin, dates in the hotel's own timezone, counts, emails and phone numbers.
// Anything it is not confident about is reported as low confidence so the engine can ask the guest (or, optionally, Groq can help).

const MONTHS = { january: 1, jan: 1, february: 2, feb: 2, march: 3, mar: 3, april: 4, apr: 4, may: 5, june: 6, jun: 6, july: 7, jul: 7, august: 8, aug: 8, september: 9, sept: 9, sep: 9, october: 10, oct: 10, november: 11, nov: 11, december: 12, dec: 12 };
const WEEKDAYS = { sunday: 0, sun: 0, monday: 1, mon: 1, tuesday: 2, tue: 2, tues: 2, wednesday: 3, wed: 3, thursday: 4, thu: 4, thur: 4, thurs: 4, friday: 5, fri: 5, saturday: 6, sat: 6 };
const NUMWORDS = { zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19, twenty: 20 };
const MONTH_RE = Object.keys(MONTHS).sort((a, b) => b.length - a.length).join('|');
const WEEKDAY_RE = Object.keys(WEEKDAYS).sort((a, b) => b.length - a.length).join('|');

// ---------------------------------------------------------------- normalization
function normalize(input) {
  let t = String(input == null ? '' : input).normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
  t = t.replace(/[\u2018\u2019`]/g, "'").replace(/[\u2013\u2014]/g, '-').replace(/\s+/g, ' ').trim();
  const rep = [
    [/\b(tmrw|tmr|tomorow|tommorow|tommorrow|2moro|2morrow|tomoro|tomorro)\b/g, 'tomorrow'],
    [/\b(tonite)\b/g, 'tonight'],
    [/\bnite(s?)\b/g, 'night$1'],
    [/\b(ppl|peeps|persons)\b/g, 'people'],
    [/\b(rms?)\b/g, 'room'],
    [/\b(apt|apts|appt|appartment|apartement)s?\b/g, 'apartment'],
    [/\b(avail|availble|avaliable|availabe)\b/g, 'available'],
    [/\bcheck[\s-]?in\b/g, 'checkin'],
    [/\bcheck[\s-]?out\b/g, 'checkout'],
    [/\bchk[\s-]?in\b/g, 'checkin'],
    [/\bchk[\s-]?out\b/g, 'checkout'],
    [/\bwanna\b/g, 'want to'],
    [/\bgonna\b/g, 'going to'],
    [/\bi wan\b/g, 'i want'],
    [/\bwan\b/g, 'want'],
    [/\bwetin\b/g, 'what'],
    [/\b(abeg|abegi|biko|pls|plz|please|kindly|oga|sha|abi)\b/g, ' '],
    [/\b(sir|madam|ma'am|maam)\b/g, ' '],
    [/\bhow much (be|is it)\b/g, 'how much'],
  ];
  for (const [re, to] of rep) t = t.replace(re, to);
  t = t.replace(/\b(zero|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty)\b/g, (m) => String(NUMWORDS[m]));
  return t.replace(/\s+/g, ' ').trim();
}
const words = (t) => t.split(/[^a-z0-9']+/).filter(Boolean);

// ---------------------------------------------------------------- calendar helpers (dates are UTC midnight, like the rest of KeyKonnec)
const utc = (y, m, d) => new Date(Date.UTC(y, m - 1, d));
const addDays = (d, n) => new Date(+d + n * 864e5);
const iso = (d) => new Date(d).toISOString().slice(0, 10);
const human = (d, weekday = false) => new Date(d).toLocaleDateString('en-GB', { ...(weekday ? { weekday: 'long' } : {}), day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' });
// "Today" in the hotel's timezone, expressed as UTC midnight of that calendar day.
function todayIn(tz = 'Africa/Lagos', now = new Date()) {
  let s;
  try { s = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(now); }
  catch { s = new Intl.DateTimeFormat('en-CA', { timeZone: 'Africa/Lagos', year: 'numeric', month: '2-digit', day: '2-digit' }).format(now); }
  const [y, m, d] = s.split('-').map(Number);
  return utc(y, m, d);
}
const validYMD = (y, m, d) => { if (m < 1 || m > 12 || d < 1 || d > 31) return null; const x = utc(y, m, d); return x.getUTCMonth() === m - 1 && x.getUTCDate() === d ? x : null; };
function yearless(m, d, today) {
  let x = validYMD(today.getUTCFullYear(), m, d), inferred = false;
  if (x && x < today) { x = validYMD(today.getUTCFullYear() + 1, m, d); inferred = true; }
  return { date: x, inferred };
}

// ---------------------------------------------------------------- date reading
// Finds every date mention, with where it is in the text. A matched span is blanked so it cannot match twice.
function findDateTokens(text) {
  let s = text;
  const out = [];
  const take = (re, build) => {
    s = s.replace(re, (...args) => {
      const idx = args[args.length - 2];
      const m = args.slice(0, args.length - 2);
      const toks = build(m, idx);
      if (!toks) return args[0];
      (Array.isArray(toks) ? toks : [toks]).forEach((t) => out.push({ index: idx, len: args[0].length, ...t }));
      return ' '.repeat(args[0].length);
    });
  };
  const yr = (v) => { if (v == null || v === '') return null; const n = +v; return n < 100 ? 2000 + n : n; };
  // 2026-12-10
  take(/\b(20\d{2})-(\d{1,2})-(\d{1,2})\b/g, (m) => ({ kind: 'abs', y: +m[1], m: +m[2], d: +m[3] }));
  // 10-13 december, 10 to 13 december, 10th - 13th of dec 2026
  take(new RegExp(`\\b(\\d{1,2})(?:st|nd|rd|th)?\\s*(?:-|to|until|till)\\s*(\\d{1,2})(?:st|nd|rd|th)?\\s*(?:of\\s+)?(${MONTH_RE})\\b(?:\\s*,?\\s*(\\d{4}))?`, 'g'),
    (m) => [{ kind: 'abs', m: MONTHS[m[3]], d: +m[1], y: yr(m[4]), role: 'in' }, { kind: 'abs', m: MONTHS[m[3]], d: +m[2], y: yr(m[4]), role: 'out' }]);
  // 10 december, 10th of dec 2026
  take(new RegExp(`\\b(\\d{1,2})(?:st|nd|rd|th)?\\s*(?:of\\s+)?(${MONTH_RE})\\b(?:\\s*,?\\s*(\\d{4}))?`, 'g'), (m) => ({ kind: 'abs', m: MONTHS[m[2]], d: +m[1], y: yr(m[3]) }));
  // december 10, dec 10th 2026
  take(new RegExp(`\\b(${MONTH_RE})\\s+(\\d{1,2})(?:st|nd|rd|th)?\\b(?:\\s*,?\\s*(\\d{4}))?`, 'g'), (m) => ({ kind: 'abs', m: MONTHS[m[1]], d: +m[2], y: yr(m[3]) }));
  // 10/12/2026, 10.12.26, 10/12 (a two-part date needs a slash; a dash or dot alone is too easily a range or a decimal)
  take(/\b(\d{1,2})[\/.\-](\d{1,2})[\/.\-](\d{2,4})\b/g, (m) => numeric(+m[1], +m[2], yr(m[3])));
  take(/\b(\d{1,2})\/(\d{1,2})\b/g, (m) => numeric(+m[1], +m[2], null));
  // relative words
  take(/\bday after tomorrow\b/g, () => ({ kind: 'rel', offset: 2 }));
  take(/\b(tomorrow)\b/g, () => ({ kind: 'rel', offset: 1 }));
  take(/\b(today|tonight)\b/g, () => ({ kind: 'rel', offset: 0 }));
  take(/\bin (\d{1,2}) days?\b/g, (m) => ({ kind: 'rel', offset: +m[1] }));
  take(/\b(next|this|coming)\s+weekend\b|\bthe weekend\b|\bweekend\b/g, (m) => ({ kind: 'weekend', next: /next/.test(m[0]) }));
  take(/\bnext week\b/g, () => ({ kind: 'nextweek' }));
  take(new RegExp(`\\b(?:(this|next|coming)\\s+)?(${WEEKDAY_RE})\\b`, 'g'), (m) => ({ kind: 'weekday', wd: WEEKDAYS[m[2]], mod: m[1] || '' }));
  return out.sort((a, b) => a.index - b.index);
}
// d/m/y is the Nigerian and UK order. If both numbers could be a month (10/12) we also remember the other reading so the engine can confirm.
function numeric(a, b, y) {
  if (a > 12 && b <= 12) return { kind: 'abs', d: a, m: b, y };
  if (b > 12 && a <= 12) return { kind: 'abs', d: b, m: a, y };
  if (a > 12 && b > 12) return null;
  return { kind: 'abs', d: a, m: b, y, ambiguous: a !== b, altDM: a !== b ? { d: b, m: a } : null };
}

const OUT_HINT = /(checkout|leave|leaving|depart\w*|vacate|return\w*|go(?:ing)? back|move out)\b[^.]*$/;
const IN_HINT = /(checkin|arriv\w*|com(?:e|ing)|land\w*|start\w*|begin\w*|from)\b[^.]*$/;
function roleOf(before) {
  if (/\b(to|till|until|-)\s*$/.test(before) && !/\bwant to\s*$|\bneed to\s*$|\bhow to\s*$/.test(before)) return 'out';
  const o = before.search(OUT_HINT), i = before.search(IN_HINT);
  if (o < 0 && i < 0) return null;
  if (o >= 0 && i < 0) return 'out';
  if (i >= 0 && o < 0) return 'in';
  return o > i ? 'out' : 'in';
}

function resolveToken(t, today, ref, role) {
  const res = { ambiguous: false };
  if (t.kind === 'abs') {
    let date, inferred = false;
    if (t.y) date = validYMD(t.y, t.m, t.d); else { const r = yearless(t.m, t.d, today); date = r.date; inferred = r.inferred; }
    if (!date) return null;
    res.date = date;
    if (t.ambiguous) { res.ambiguous = true; res.reason = 'format'; if (t.altDM) { const alt = t.y ? validYMD(t.y, t.altDM.m, t.altDM.d) : yearless(t.altDM.m, t.altDM.d, today).date; if (alt) res.alt = alt; } }
    if (inferred) res.inferredYear = true;
    return res;
  }
  if (t.kind === 'rel') { res.date = addDays(today, t.offset); return res; }
  if (t.kind === 'weekday') {
    const base = role === 'out' && ref ? ref : today;
    let delta = (t.wd - base.getUTCDay() + 7) % 7;
    if (t.mod === 'next') {
      const mondayNext = addDays(base, ((8 - base.getUTCDay()) % 7) || 7);
      delta = Math.round((addDays(mondayNext, (t.wd + 6) % 7) - base) / 864e5);
      res.ambiguous = true; res.reason = 'next-weekday';
    } else if (delta === 0) {
      if (role === 'out' && ref) { delta = 7; res.ambiguous = true; res.reason = 'week'; }
      else if (t.mod !== 'this') { res.ambiguous = true; res.reason = 'today-or-next-week'; res.alt = addDays(base, 7); }
    }
    res.date = addDays(base, delta);
    return res;
  }
  return null;
}

// readDates(text, {today, expect:'checkIn'|'checkOut'|null, known:{checkIn,checkOut}}) -> {checkIn, checkOut, nights, needsExact}
// checkIn/checkOut: {date, ambiguous, reason, alt, inferredYear}
function readDates(raw, { today, expect = null, known = {} } = {}) {
  const text = typeof raw === 'string' ? normalize(raw) : raw.text;
  const out = {};
  const toks = findDateTokens(text);
  // roles from the words just before each date
  let prevEnd = 0;
  for (const t of toks) { const before = text.slice(prevEnd, t.index); t.hint = t.role || roleOf(before); prevEnd = t.index + t.len; }
  const ins = toks.filter((t) => t.hint === 'in'), outs = toks.filter((t) => t.hint === 'out'), none = toks.filter((t) => !t.hint);
  let tIn = ins[0], tOut = outs[0];
  const weekend = toks.find((t) => t.kind === 'weekend');
  if (weekend && !tIn && !tOut) {
    const dow = today.getUTCDay();
    let fri = dow === 0 ? addDays(today, 5) : dow === 6 ? today : addDays(today, 5 - dow);
    if (weekend.next) fri = dow === 6 ? addDays(today, 6) : addDays(fri, 7);
    const sun = addDays(fri, fri.getUTCDay() === 6 ? 1 : 2);
    out.checkIn = { date: fri < today ? today : fri, ambiguous: true, reason: 'weekend' };
    out.checkOut = { date: sun, ambiguous: true, reason: 'weekend' };
  } else if (toks.some((t) => t.kind === 'nextweek') && !toks.some((t) => ['abs', 'rel', 'weekday'].includes(t.kind))) {
    out.needsExact = 'next week';
  } else {
    const real = none.filter((t) => ['abs', 'rel', 'weekday'].includes(t.kind));
    if (!tIn && !tOut) {
      if (real.length >= 2) { tIn = real[0]; tOut = real[1]; }
      else if (real.length === 1) { if (expect === 'checkOut' || (!expect && known.checkIn && !known.checkOut)) tOut = real[0]; else tIn = real[0]; }
    } else if (tIn && !tOut && real.length) tOut = real.find((t) => t.index > tIn.index) || undefined;
    else if (tOut && !tIn && real.length) tIn = real.find((t) => t.index < tOut.index) || undefined;
    let rin = tIn ? resolveToken(tIn, today, null, 'in') : null;
    if (rin) out.checkIn = rin;
    const refIn = (out.checkIn && out.checkIn.date) || known.checkIn || null;
    if (tOut) {
      let rout = resolveToken(tOut, today, refIn, 'out');
      if (rout) out.checkOut = rout;
    }
  }
  // number of nights: "for 2 nights", "a night", "for a week"
  let nights = null, m;
  if ((m = text.match(/\b(\d{1,2})\s*nights?\b/))) nights = +m[1];
  else if (/\b(a|one|1)\s*night\b|\bovernight\b/.test(text)) nights = 1;
  else if ((m = text.match(/\b(\d{1,2})\s*weeks?\b/))) nights = +m[1] * 7;
  else if (/\b(a|one)\s*week\b|\bfor a week\b/.test(text)) nights = 7;
  else if (/\bfortnight\b/.test(text)) nights = 14;
  else if ((m = text.match(/\b(?:for|stay(?:ing)?|about)\s+(\d{1,2})\s*days?\b/))) nights = +m[1];
  if (nights && nights >= 1 && nights <= 90) {
    out.nights = nights;
    const base = (out.checkIn && out.checkIn.date) || known.checkIn;
    if (base && !out.checkOut && !known.checkOut) out.checkOut = { date: addDays(base, nights), ambiguous: false, derived: true };
  }
  return out;
}

// ---------------------------------------------------------------- counts
function readCounts(raw, { expect = null } = {}) {
  const t = typeof raw === 'string' ? normalize(raw) : raw.text, r = {};
  let m;
  if (/\b(just me|only me|myself|alone|solo|by myself|for me)\b/.test(t)) r.adults = 1;
  if (/\b(couple|me and my (wife|husband|partner|spouse|girlfriend|boyfriend|fiance\w*|friend|bae))\b/.test(t)) r.adults = 2;
  if ((m = t.match(/\bfamily of (\d{1,2})\b/))) r.adults = +m[1];
  if ((m = t.match(/\b(\d{1,2})\s*(?:adults?|people|guests?|pax|of us|persons?|visitors?|friends?|colleagues?)\b/))) r.adults = +m[1];
  else if (!r.adults && (m = t.match(/\bfor (\d{1,2})(?!\s*(?:night|day|week|room|apartment|suite|st|nd|rd|th|\/|-))\b/))) r.adults = +m[1];
  if ((m = t.match(/\b(\d{1,2})\s*(?:kids?|child(?:ren)?|minors?|toddlers?|babies|infants?)\b/))) r.children = +m[1];
  else if (/\b(a|one|1) (kid|child|baby|toddler|infant)\b/.test(t)) r.children = 1;
  else if (/\b(no (kids?|child(?:ren)?)|without (kids?|children))\b/.test(t)) r.children = 0;
  if ((m = t.match(/\b(\d{1,2})\s*(?:rooms?|apartments?|suites?|units?|flats?)\b/)) && !/\bbedroom/.test(t.slice(m.index, m.index + m[0].length + 8))) r.rooms = +m[1];
  // a bare number is the answer to "how many guests?" when that is what we asked
  if (expect === 'guests' && r.adults == null && (m = t.match(/^\s*(\d{1,2})\s*$/))) r.adults = +m[1];
  if (expect === 'guests' && r.adults == null && (m = t.match(/^\s*(\d{1,2})\s*(?:and|\+|,|&)\s*(\d{1,2})\s*(?:kids?|child(?:ren)?)\b/))) { r.adults = +m[1]; r.children = +m[2]; }
  if (expect === 'rooms' && r.rooms == null && (m = t.match(/^\s*(\d{1,2})\s*$/))) r.rooms = +m[1];
  for (const k of Object.keys(r)) if (r[k] > 30 || r[k] < 0 || (k !== 'children' && r[k] < 1)) delete r[k];
  return r;
}

// ---------------------------------------------------------------- email, phone, name, booking reference
const EMAIL_RE = /[a-z0-9._%+\-]+@[a-z0-9\-]+(?:\.[a-z0-9\-]+)+/i;
function validEmail(e) {
  const s = String(e || '').trim();
  if (s.length > 254 || /\s/.test(s)) return false;
  const [local, domain, ...rest] = s.split('@');
  if (rest.length || !local || !domain || local.length > 64) return false;
  if (/^\.|\.$|\.\./.test(local) || /^\-|\-$|\.\./.test(domain) || /^\./.test(domain)) return false;
  const labels = domain.split('.');
  if (labels.length < 2 || labels.some((l) => !l || l.length > 63 || /^-|-$/.test(l))) return false;
  return /^[a-z]{2,24}$/i.test(labels[labels.length - 1]);
}
const readEmail = (raw) => { const m = String(raw || '').match(EMAIL_RE); return m ? { value: m[0].toLowerCase(), valid: validEmail(m[0]) } : null; };
// Nigerian numbers: 080..., +23480..., 23480...; other countries: + and 8 to 15 digits. Returns digits only (no plus), or null.
function normPhone(p) {
  let d = String(p || '').replace(/[^\d+]/g, '');
  const plus = d.startsWith('+'); d = d.replace(/\D/g, '');
  if (!d) return null;
  if (!plus && d.startsWith('0') && d.length === 11) d = '234' + d.slice(1);
  if (d.startsWith('234') && d.length === 13) return d;
  if (plus && d.length >= 8 && d.length <= 15) return d;
  if (!plus && !d.startsWith('0') && d.length >= 10 && d.length <= 15 && !d.startsWith('234')) return d;
  return null;
}
function readPhone(raw) {
  const s = String(raw || '');
  const m = s.match(/(?:\+\s*\d[\d\s\-()]{7,16}\d)|(?:\b0\s*[789][01]\d[\s\-]?\d{3}[\s\-]?\d{4}\b)|(?:\b234\s*[789][01]\d[\s\-]?\d{3}[\s\-]?\d{4}\b)/);
  return m ? normPhone(m[0]) : null;
}
const NAME_STOP = new Set(['yes', 'no', 'ok', 'okay', 'hello', 'hi', 'hey', 'thanks', 'thank', 'you', 'book', 'booking', 'cancel', 'staff', 'rooms', 'room', 'menu', 'help', 'stop', 'back', 'edit', 'confirm', 'proceed', 'pay', 'start', 'restart', 'tomorrow', 'today', 'friday', 'monday', 'sunday']);
const titleCase = (s) => s.toLowerCase().replace(/(^|[\s'\-])([a-z])/g, (m, a, b) => a + b.toUpperCase());
function readName(raw, { strict = false } = {}) {
  const s = String(raw || '').trim().replace(/\s+/g, ' ');
  const m = s.match(/\b(?:my (?:full )?name is|name is|name'?s|i am|i'm|im|this is|call me|it is|it's|full name[:\s]+|name[:\s]+)\s+([a-z][a-z'.\-]*(?:\s+[a-z][a-z'.\-]*){0,3})/i);
  let cand = m ? m[1] : (!strict || true) && /^[a-z][a-z'.\-]*(?:\s+[a-z][a-z'.\-]*){0,3}$/i.test(s) ? s : null;
  if (!cand) return null;
  const parts = cand.replace(/\.$/, '').split(' ').filter(Boolean).filter((w) => !/^(and|my|the|is|a)$/i.test(w));
  if (!parts.length || parts.length > 4 || parts.some((w) => NAME_STOP.has(w.toLowerCase()) || w.length < 2 || w.length > 30)) return null;
  return { value: titleCase(parts.join(' ')), full: parts.length >= 2 };
}
const readReference = (raw) => { const m = String(raw || '').toUpperCase().match(/\bKK-?([0-9A-F]{8})\b/); return m ? 'KK-' + m[1] : null; };

// ---------------------------------------------------------------- intent scoring
const RULES = [
  // greeting
  [/^(hi+|hello+|hey+|helo|hola|howdy|yo|sup|salam|assalam\w*|good (morning|afternoon|evening|day)|greetings|hi there|hello there|hey there)\b/, 'GREETING', 0.9],
  // booking
  [/\b(book|reserve|reservation|booking)\b/, 'BOOK', 0.7],
  [/\b(want|need|looking for|wish|like|searching for|in need of)\b.*\b(room|apartment|suite|place|accommodation|flat|shortlet|somewhere to (stay|sleep)|lodging|space)\b/, 'BOOK', 0.75],
  [/\bwant to (stay|sleep|lodge)\b/, 'BOOK', 0.7],
  [/\b(checkin|checkout|arriv\w+|arriving)\b/, 'BOOK', 0.5],
  // rooms and availability
  [/\b(available|availability|vacan\w+|vacant)\b/, 'ROOMS', 0.7],
  [/\b(show|see|view|list|send|share|check|what|which)\b.*\b(rooms?|apartments?|suites?|options|types)\b/, 'ROOMS', 0.75],
  [/\bdo you have\b.*\b(room|apartment|suite|space|place|flat|accommodation)\b/, 'ROOMS', 0.8],
  [/\b(any|got)\b.*\b(room|apartment|suite|space|flat)\b/, 'ROOMS', 0.6],
  [/\b(room types?|types of rooms?|rooms? (do you have|you have|available))\b/, 'ROOMS', 0.8],
  // price
  [/\b(how much|price|prices|cost|costs|rate|rates|charge|charges|per night|pricing|tariff|amount)\b/, 'PRICE', 0.8],
  // human
  [/\b(speak|talk|chat|connect)\b.*\b(someone|somebody|person|human|agent|staff|manager|receptionist|representative|reception|team)\b/, 'HUMAN', 0.95],
  [/\b(human|agent|staff|manager|customer (care|service|support)|receptionist|reception|representative|operator|real person)\b/, 'HUMAN', 0.75],
  [/\b(call me|can someone|someone call|speak with|talk to)\b/, 'HUMAN', 0.8],
  // my booking, receipts
  [/\b(my|the) (booking|reservation)s?\b|\bbooking (details|status|reference|number)\b|\breservation (details|status)\b|\b(check|show|view|get|see) (my )?(booking|reservation)\b/, 'MY_BOOKING', 0.9],
  [/\b(receipt|invoice|proof of payment|payment details|booking confirmation|confirmation (letter|email|document|message))\b/, 'RECEIPT', 0.9],
  [/\bpayment (status)\b/, 'MY_BOOKING', 0.8],
  // paying
  [/\b(i (have |already )?paid|i made (the )?payment|payment (done|made|sent|completed)|i (have )?(sent|transferred) (the )?money|done paying|i don pay|paid already|i just paid)\b/, 'PAID_CLAIM', 0.95],
  [/\b(pay|payment link|paylink|pay now|make payment|proceed to (pay|payment)|send (me )?(the |a )?(link|payment))\b/, 'PAY', 0.8],
  // cancel / modify
  [/\b(cancel|cancellation|call off)\b/, 'CANCEL', 0.85],
  [/\brefund\b/, 'CANCEL', 0.6],
  [/\b(change|modify|reschedule|extend|shorten|postpone|move|amend)\b.*\b(date|dates|booking|reservation|room|stay|checkin|checkout)\b/, 'MODIFY', 0.9],
  [/\b(change|switch|upgrade|downgrade)\b.*\b(room|apartment|suite)\b/, 'MODIFY', 0.85],
  // short answers and navigation
  [/^(y|yes+|yeah|yep|yea|yup|ya|sure|ok|okay|alright|correct|right|confirm(ed)?|proceed|go ahead|continue|sounds good|i agree|do it|exactly|oya|no wahala|that'?s (right|correct)|yes please)\b/, 'YES', 0.9],
  [/^(n|no+|nope|nah|not really|not yet|wrong|incorrect|negative)\b/, 'NO', 0.9],
  [/\b(thanks?|thank you|thx|tnx|appreciate|cheers)\b/, 'THANKS', 0.8],
  [/^(menu|help|options|\?|what can you do)\b/, 'MENU', 0.9],
  [/\b(start over|restart|reset|begin again|start again|new search)\b/, 'RESTART', 0.9],
  [/^(stop|unsubscribe|opt ?out)$/, 'STOP', 0.98],
  [/^(edit|correct|change|fix|update)\b/, 'EDIT', 0.8],
  [/\b(photos?|pictures?|pics|images?)\b/, 'PHOTOS', 0.8],
];
const TOPICS = [
  ['pool', /\b(swimming|pool)\b/], ['restaurant', /\b(restaurant|dining|food|bar|eat|lounge)\b/], ['gym', /\b(gym|fitness|workout)\b/],
  ['wifi', /\b(wifi|wi-fi|internet|wireless)\b/], ['parking', /\b(parking|car park|park (my|a) car)\b/], ['breakfast', /\bbreakfast\b/],
  ['checkin_time', /\b(checkin time|what time.*checkin|checkin hours|earliest checkin|time.*checkin)\b/], ['checkout_time', /\b(checkout time|what time.*checkout|latest checkout|time.*checkout)\b/],
  ['policies', /\b(polic(y|ies)|rules|pets?|smoking|cancellation policy|refund policy|terms)\b/], ['contact', /\b(contact|phone number|call (you|the hotel)|email address|reach (you|the hotel)|your number)\b/],
  ['location', /\b(location|address|where (are|is)|directions?|map|how (do i|to) get|situated|located)\b/], ['landmarks', /\b(landmarks?|nearby|near to|close to|around the hotel|what'?s around)\b/],
  ['amenities', /\b(amenit(y|ies)|facilit(y|ies)|what do you offer|what'?s included|services)\b/], ['description', /\b(tell me about|about (the |your )?(hotel|property|place|apartment)|describe|what is this place)\b/],
  ['name', /\b(hotel name|property name|your name|who are you|what hotel)\b/],
];

function classify(raw, { state = null } = {}) {
  const n = { text: normalize(raw) };
  n.words = words(n.text);
  const score = {};
  for (const [re, intent, w] of RULES) if (re.test(n.text)) score[intent] = Math.min(1, (score[intent] || 0) + w);
  // "my booking" beats a plain "book"
  if (score.MY_BOOKING && score.BOOK) score.BOOK *= 0.4;
  if (score.MY_BOOKING && (score.CANCEL || score.MODIFY || score.PAID_CLAIM)) score.MY_BOOKING *= 0.4;
  if (score.CANCEL && score.MODIFY) score.CANCEL *= 0.5;
  if (score.RECEIPT && score.MY_BOOKING) score.MY_BOOKING *= 0.7;
  if (score.PRICE && score.ROOMS && !/\b(available|availability)\b/.test(n.text)) score.ROOMS *= 0.6;
  // a long sentence that merely starts with "hi" is not just a greeting
  if (score.GREETING && n.words.length > 6) score.GREETING *= 0.5;
  if ((score.YES || score.NO) && n.words.length > 6) { if (score.YES) score.YES *= 0.4; if (score.NO) score.NO *= 0.4; }
  const topics = TOPICS.filter(([, re]) => re.test(n.text)).map(([k]) => k);
  if (topics.length && !score.INFO) score.INFO = topics.length ? 0.78 : 0;
  if (score.INFO && /\b(room|apartment|suite)\b/.test(n.text) && /\bdo you have (a |an |any )?(room|apartment|suite)/.test(n.text)) score.INFO *= 0.5;
  const ranked = Object.entries(score).sort((a, b) => b[1] - a[1]);
  const [intent, s1] = ranked[0] || ['UNKNOWN', 0];
  const s2 = ranked[1] ? ranked[1][1] : 0;
  const confidence = intent === 'UNKNOWN' ? 0 : Math.min(0.97, s1) * (s2 > 0 ? 1 - 0.3 * Math.min(1, s2 / s1) : 1);
  return { intent, confidence, scores: score, topics, text: n.text, words: n.words, secondary: ranked.slice(1).map(([k]) => k) };
}

// ---------------------------------------------------------------- picking a room type from a short reply
const FILLER = new Set(['room', 'rooms', 'the', 'a', 'an', 'i', 'want', 'to', 'book', 'take', 'need', 'please', 'with', 'for', 'one', 'option', 'number', 'no', 'choose', 'select', 'pick', 'like', 'would', 'go', 'will', 'my', 'me', 'that', 'this', 'of', 'in', 'and', 'on']);
const sig = (s) => words(normalize(s)).filter((w) => !FILLER.has(w) && w.length > 1);
// types: [{id, name}]; offered: ids in the order the guest was shown them (so "2" or "the second one" work)
function matchRoomType(raw, types, offered = []) {
  const t = normalize(raw);
  if (!types.length) return { type: null, candidates: [] };
  const ord = { first: 1, second: 2, third: 3, fourth: 4, fifth: 5, last: -1 };
  let idx = null, m;
  if ((m = t.match(/^\s*(?:option|number|no\.?|#|room)?\s*(\d{1,2})\s*$/))) idx = +m[1];
  else if ((m = t.match(/\b(first|second|third|fourth|fifth|last)\s*(?:one|option|room)?\b/))) idx = ord[m[1]];
  else if ((m = t.match(/\b(?:option|number|no\.?|#)\s*(\d{1,2})\b/))) idx = +m[1];
  if (idx != null && offered.length) {
    const id = idx === -1 ? offered[offered.length - 1] : offered[idx - 1];
    const type = types.find((x) => String(x.id) === String(id));
    if (type) return { type, candidates: [type], by: 'position' };
  }
  const qw = new Set(sig(t));
  if (!qw.size) return { type: null, candidates: [] };
  const scored = types.map((x) => {
    const nw = new Set(sig(x.name)); if (!nw.size) return { x, s: 0 };
    let hit = 0; for (const w of nw) if (qw.has(w) || [...qw].some((q) => q.length > 3 && (w.startsWith(q) || q.startsWith(w)))) hit++;
    const nameFull = normalize(x.name).split(' ').filter((w) => !FILLER.has(w)).join(' ');
    const exact = nameFull && t.includes(nameFull) ? 1 : 0;
    return { x, s: hit / nw.size + exact };
  }).filter((e) => e.s > 0).sort((a, b) => b.s - a.s);
  if (!scored.length) return { type: null, candidates: [] };
  const best = scored[0], tie = scored.filter((e) => Math.abs(e.s - best.s) < 1e-9);
  if (tie.length > 1) return { type: null, candidates: tie.map((e) => e.x), ambiguous: true };
  return { type: best.s >= 0.5 ? best.x : null, candidates: scored.slice(0, 3).map((e) => e.x), weak: best.s < 0.5 };
}

// Everything the reader can pull from one message, in one call.
function read(raw, ctx = {}) {
  const c = classify(raw, ctx);
  const dates = ctx.today ? readDates(c.text, { today: ctx.today, expect: ctx.expectDate || null, known: ctx.known || {} }) : {};
  const counts = readCounts(c.text, { expect: ctx.expectCount || null });
  const email = readEmail(raw), phone = readPhone(raw), reference = readReference(raw);
  // "Friday", "2 people", "tomorrow for 3 nights": no verb, but clearly details for a booking
  const gave = Object.keys(dates).some((k) => ['checkIn', 'checkOut', 'nights'].includes(k)) || Object.keys(counts).length > 0;
  if (c.intent === 'UNKNOWN' && gave) { c.intent = 'DETAILS'; c.confidence = 0.7; }
  return { ...c, dates, counts, email, phone, reference };
}

module.exports = { normalize, words, readDates, readCounts, readEmail, validEmail, readPhone, normPhone, readName, readReference, classify, matchRoomType, read, todayIn, utc, addDays, iso, human, MONTHS, WEEKDAYS };
