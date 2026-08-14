// ============================================================
// STRAIGHT FIN FARMS — BOOKING WORKFLOW (Google Apps Script)
// ============================================================
// Deploy as: Web App → Execute as: Me → Access: Anyone
// ============================================================

// ===== CONFIGURATION =====
const CONFIG = {
  HOST_EMAIL: 'straightfinfarms@gmail.com',
  HOST_NAME: 'Deniz',
  PROPERTY_NAME: 'Straight Fin Farms',
  PROPERTY_ADDRESS: '1091 County Road 24, Dunsford, ON K0M 1L0',
  ETRANSFER_EMAIL: 'straightfinfarms@gmail.com',
  SPREADSHEET_ID: '1jELy1ekK2TzdJIbtH56RFEnA_q-E-q5igWF4Iygl73U',
  SHEET_NAME: 'Bookings',
  // Pricing (keep in sync with book-direct.html)
  NIGHTLY_RATE: 650,
  CLEANING_FEE_SHORT: 340,         // up to 7 adults+children
  CLEANING_FEE_LONG: 440,          // 8+ adults+children (infants excluded)
  BASE_GUESTS: 8,                  // cleaning fee tier threshold (adults + children)
  ADULT_FEE_THRESHOLD: 10,         // extra-adult surcharge kicks in above this many adults
  EXTRA_GUEST_FEE: 50,             // per additional adult per night above ADULT_FEE_THRESHOLD
  PET_FEE: 50,
  HST_RATE: 0.13,
  // Web App URL (stable deployment URL — no /u/N/ account selector)
  SCRIPT_URL: 'https://script.google.com/macros/s/AKfycby8pOYvYJBPvaTFD4ldcUnxtB5XGE81TrP70cBH2ap3QAGeOVWC0CefochRrxM97INo/exec',
  // Stripe
  // Stripe key is read from Script Properties (Project Settings → Script Properties).
  // STRIPE_MODE = 'test' or 'live' — picks STRIPE_SECRET_KEY_TEST or STRIPE_SECRET_KEY_LIVE.
  // Falls back to STRIPE_SECRET_KEY (legacy property) if the mode-specific one isn't set.
  STRIPE_SECRET_KEY: (function() {
    const props = PropertiesService.getScriptProperties();
    const mode = (props.getProperty('STRIPE_MODE') || 'test').toUpperCase();
    return props.getProperty('STRIPE_SECRET_KEY_' + mode) || props.getProperty('STRIPE_SECRET_KEY') || '';
  })(),
};

// ============================================================
// ===== SITE MODE (TEST vs LIVE) ==============================
// ============================================================
// Single source of truth for whether we're in production. Drives:
//   - Stripe key selection (test vs live)
//   - Whether the bookings_ics feed exposes blocks to Airbnb
//   - Other future "production-only" wiring (real emails to suppliers, etc.)
// Stored in PropertiesService under 'SITE_MODE'. Defaults to 'test' for safety.
// Backward-compat: if SITE_MODE is unset, falls back to STRIPE_MODE (legacy).

function getSiteMode() {
  const props = PropertiesService.getScriptProperties();
  const raw = (props.getProperty('SITE_MODE') || props.getProperty('STRIPE_MODE') || 'test').toString().toLowerCase();
  return raw === 'live' ? 'live' : 'test';
}

function setSiteMode(mode) {
  const m = String(mode || '').toLowerCase() === 'live' ? 'live' : 'test';
  const props = PropertiesService.getScriptProperties();
  props.setProperty('SITE_MODE', m);
  // Keep STRIPE_MODE in sync so the existing CONFIG.STRIPE_SECRET_KEY lookup picks
  // up the matching key without anyone having to edit two properties.
  props.setProperty('STRIPE_MODE', m);
  return m;
}

function isLiveMode() { return getSiteMode() === 'live'; }

// ===== ADMIN SETTINGS (toggleable from the admin dashboard) =====
// Persists across deploys via PropertiesService. Defaults are FALSE so a fresh
// deploy keeps the existing request-to-book flow until the host opts in.
//
// Settings shape:
//   {
//     directBookingStay:   bool — when true, book-direct.html guests can pay immediately
//                                (no host accept step). Booking lands in 'Awaiting Confirmation'.
//     directBookingCourse: bool — same idea for the Permaculture course flow.
//   }

const SETTINGS_PROP_KEY = 'sff_booking_settings_v1';
const SETTINGS_DEFAULT = {
  directBookingStay: false,
  directBookingCourse: false,
};

function getBookingSettings() {
  try {
    const raw = PropertiesService.getScriptProperties().getProperty(SETTINGS_PROP_KEY);
    if (!raw) return Object.assign({}, SETTINGS_DEFAULT);
    const parsed = JSON.parse(raw);
    return Object.assign({}, SETTINGS_DEFAULT, parsed || {});
  } catch (err) {
    Logger.log('getBookingSettings parse error: ' + err.toString());
    return Object.assign({}, SETTINGS_DEFAULT);
  }
}

function setBookingSettings(updates) {
  const current = getBookingSettings();
  const merged = Object.assign({}, current, updates || {});
  // Coerce booleans defensively — JSON could come in with truthy strings, etc.
  merged.directBookingStay = !!merged.directBookingStay;
  merged.directBookingCourse = !!merged.directBookingCourse;
  PropertiesService.getScriptProperties().setProperty(SETTINGS_PROP_KEY, JSON.stringify(merged));
  return merged;
}

// ============================================================
// ===== PERMACULTURE PHONE NUMBERS (admin-editable) ==========
// ============================================================
// Three phones displayed on permaculture-course.html's "call directly" card.
// The page picks one based on the visitor's current Toronto time:
//   Mon–Fri 9am–5pm EST → business
//   Mon–Fri after 5pm EST → afterHours
//   Saturday + Sunday    → weekend
// Editable via admin Settings tab → "Permaculture — Call Numbers" card.
const PERMA_PHONES_PROP_KEY = 'sff_permaculture_phones_v1';
const PERMA_PHONES_DEFAULT = {
  business:   '416-254-7104',
  afterHours: '416-254-7104',
  weekend:    '416-254-7104',
};

function getPermaculturePhones() {
  try {
    const raw = PropertiesService.getScriptProperties().getProperty(PERMA_PHONES_PROP_KEY);
    if (!raw) return Object.assign({}, PERMA_PHONES_DEFAULT);
    const parsed = JSON.parse(raw);
    return Object.assign({}, PERMA_PHONES_DEFAULT, parsed || {});
  } catch (err) {
    Logger.log('getPermaculturePhones parse error: ' + err.toString());
    return Object.assign({}, PERMA_PHONES_DEFAULT);
  }
}

function setPermaculturePhones(updates) {
  const current = getPermaculturePhones();
  const merged = Object.assign({}, current, updates || {});
  merged.business   = String(merged.business   || PERMA_PHONES_DEFAULT.business).trim();
  merged.afterHours = String(merged.afterHours || PERMA_PHONES_DEFAULT.afterHours).trim();
  merged.weekend    = String(merged.weekend    || PERMA_PHONES_DEFAULT.weekend).trim();
  PropertiesService.getScriptProperties().setProperty(PERMA_PHONES_PROP_KEY, JSON.stringify(merged));
  return merged;
}

// ============================================================
// ===== PRICING MATRIX (admin-editable) =======================
// ============================================================
// Stay nightly rates by month × day-of-week, plus per-date overrides (holidays /
// long-weekends / ad-hoc), plus a weekly-stay discount applied at 7+ nights.
//
// Shape:
//   {
//     version: 1,
//     baseRates: { '0'..'11': [Sun, Mon, Tue, Wed, Thu, Fri, Sat] },
//     overrides: [ { date: 'YYYY-MM-DD', price: number, label: string } ],
//     weeklyDiscount: { thresholdNights: 7, percentOff: 15 }
//   }
//
// Defaults: every cell = CONFIG.NIGHTLY_RATE (current $650), no overrides,
// 7+ nights = 15% off the nightly subtotal.

const PRICING_PROP_KEY = 'sff_pricing_v1';

function _defaultBaseRates() {
  const base = CONFIG.NIGHTLY_RATE;
  const months = {};
  for (let m = 0; m < 12; m++) {
    months[String(m)] = [base, base, base, base, base, base, base];
  }
  return months;
}

function getPricingConfig() {
  try {
    const raw = PropertiesService.getScriptProperties().getProperty(PRICING_PROP_KEY);
    if (!raw) return _defaultPricingConfig();
    const parsed = JSON.parse(raw);
    return _normalizePricingConfig(parsed);
  } catch (err) {
    Logger.log('getPricingConfig parse error: ' + err.toString());
    return _defaultPricingConfig();
  }
}

function _defaultPricingConfig() {
  return {
    version: 1,
    baseRates: _defaultBaseRates(),
    overrides: [],
    weeklyDiscount: { thresholdNights: 7, percentOff: 15 },
  };
}

function _normalizePricingConfig(cfg) {
  const out = _defaultPricingConfig();
  if (cfg && typeof cfg === 'object') {
    if (cfg.baseRates && typeof cfg.baseRates === 'object') {
      for (let m = 0; m < 12; m++) {
        const row = cfg.baseRates[String(m)];
        if (Array.isArray(row) && row.length === 7) {
          out.baseRates[String(m)] = row.map(v => Math.max(0, Number(v) || 0));
        }
      }
    }
    if (Array.isArray(cfg.overrides)) {
      out.overrides = cfg.overrides
        .filter(o => o && typeof o.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(o.date))
        .map(o => ({
          date: o.date,
          price: Math.max(0, Number(o.price) || 0),
          label: String(o.label || '').trim(),
        }))
        .sort((a, b) => a.date.localeCompare(b.date));
    }
    if (cfg.weeklyDiscount && typeof cfg.weeklyDiscount === 'object') {
      const t = parseInt(cfg.weeklyDiscount.thresholdNights, 10);
      const p = parseFloat(cfg.weeklyDiscount.percentOff);
      if (!isNaN(t) && t >= 1) out.weeklyDiscount.thresholdNights = t;
      if (!isNaN(p) && p >= 0 && p <= 100) out.weeklyDiscount.percentOff = p;
    }
  }
  return out;
}

function setPricingConfig(updates) {
  const current = getPricingConfig();
  const merged = _normalizePricingConfig(Object.assign({}, current, updates || {}));
  PropertiesService.getScriptProperties().setProperty(PRICING_PROP_KEY, JSON.stringify(merged));
  return merged;
}

// ============================================================
// ===== EXTRAS / ADD-ON FEES (admin-editable) =================
// ============================================================
// Per-line configurable fees on top of nightly pricing. Each item has:
//   enabled  : bool   — whether the fee applies at all
//   threshold: number — quantity at/above which the fee starts charging
//                       (extra-adult uses this; pets/bunkie/tent typically 0)
//   price    : number — $ amount per billable unit
//   perNight : bool   — true → price × billable × nights; false → price × billable (flat per stay)
//   label    : string — display label used in admin + email breakdowns
//
// Defaults match the values hardcoded prior to 2026-05-12:
//   adult  : threshold 10, price $50,  perNight true  (was ADULT_FEE_THRESHOLD=10, EXTRA_GUEST_FEE=50)
//   pet    : threshold 0,  price $50,  perNight false (was PET_FEE=50 per stay)
//   bunkie : threshold 0,  price $100, perNight true  (was BUNKIE_FEE=100/night in book-direct.html)
//   tent   : threshold 0,  price $50,  perNight true  (was BELL_TENT_FEE=50/night per tent)

const EXTRAS_PROP_KEY = 'sff_extras_v1';
const EXTRAS_KEYS = ['adult', 'pet', 'bunkie', 'tent'];
const EXTRAS_DEFAULT = {
  version: 1,
  adult:  { enabled: true, threshold: 10, price: 50,  perNight: true,  label: 'Extra adults' },
  pet:    { enabled: true, threshold: 0,  price: 50,  perNight: false, label: 'Pet fee' },
  bunkie: { enabled: true, threshold: 0,  price: 100, perNight: true,  label: 'Forest Bunkie' },
  tent:   { enabled: true, threshold: 0,  price: 50,  perNight: true,  label: 'Bell Tent' },
};

function _cloneExtras(src) {
  const out = { version: (src && src.version) || 1 };
  EXTRAS_KEYS.forEach(function (k) {
    out[k] = Object.assign({}, EXTRAS_DEFAULT[k], (src && src[k]) || {});
  });
  return out;
}

function _normalizeExtras(cfg) {
  const out = _cloneExtras(EXTRAS_DEFAULT);
  if (!cfg || typeof cfg !== 'object') return out;
  EXTRAS_KEYS.forEach(function (k) {
    const incoming = cfg[k];
    if (!incoming || typeof incoming !== 'object') return;
    if (typeof incoming.enabled === 'boolean') out[k].enabled = incoming.enabled;
    const t = parseInt(incoming.threshold, 10);
    if (!isNaN(t) && t >= 0) out[k].threshold = t;
    const p = Number(incoming.price);
    if (!isNaN(p) && p >= 0) out[k].price = p;
    if (typeof incoming.perNight === 'boolean') out[k].perNight = incoming.perNight;
    if (typeof incoming.label === 'string' && incoming.label.trim()) out[k].label = incoming.label.trim();
  });
  return out;
}

function getExtrasConfig() {
  try {
    const raw = PropertiesService.getScriptProperties().getProperty(EXTRAS_PROP_KEY);
    if (!raw) return _cloneExtras(EXTRAS_DEFAULT);
    return _normalizeExtras(JSON.parse(raw));
  } catch (err) {
    Logger.log('getExtrasConfig parse error: ' + err.toString());
    return _cloneExtras(EXTRAS_DEFAULT);
  }
}

function setExtrasConfig(updates) {
  const current = getExtrasConfig();
  const merged = _normalizeExtras(Object.assign({}, current, updates || {}));
  PropertiesService.getScriptProperties().setProperty(EXTRAS_PROP_KEY, JSON.stringify(merged));
  return merged;
}

// Apply a single extras line's pricing rule.
//   line:     { enabled, threshold, price, perNight }
//   quantity: how many adults / pets / bunkies / tents the booking requested
//   nights:   number of nights (only used when perNight=true)
// Returns { billable, cost, perNight, unitPrice }
//   billable  = quantity above the threshold (or 0 if quantity <= threshold)
//   cost      = $ to add to the booking subtotal
function _computeExtraLine(line, quantity, nights) {
  const q = Math.max(0, parseInt(quantity, 10) || 0);
  if (!line || !line.enabled) return { billable: 0, cost: 0, perNight: !!(line && line.perNight), unitPrice: 0 };
  const threshold = Math.max(0, parseInt(line.threshold, 10) || 0);
  const billable = Math.max(0, q - threshold);
  const price = Math.max(0, Number(line.price) || 0);
  if (billable === 0) return { billable: 0, cost: 0, perNight: !!line.perNight, unitPrice: price };
  const cost = line.perNight ? (billable * price * Math.max(1, nights || 0)) : (billable * price);
  return { billable: billable, cost: cost, perNight: !!line.perNight, unitPrice: price };
}

// Look up the rate for a single date (YYYY-MM-DD or Date). Returns { rate, source, label }
// where source is 'override' or 'matrix'.
function getNightlyRateForDate(dateInput) {
  const cfg = getPricingConfig();
  let dateStr;
  if (dateInput instanceof Date) {
    dateStr = Utilities.formatDate(dateInput, 'America/Toronto', 'yyyy-MM-dd');
  } else {
    dateStr = String(dateInput).slice(0, 10);
  }
  // Override match (highest priority)
  const ov = cfg.overrides.find(o => o.date === dateStr);
  if (ov) return { rate: ov.price, source: 'override', label: ov.label || 'Special date' };
  // Matrix lookup
  const m = dateStr.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return { rate: CONFIG.NIGHTLY_RATE, source: 'fallback', label: '' };
  const month = parseInt(m[2], 10) - 1;
  const day = parseInt(m[3], 10);
  // JS getDay: 0=Sun..6=Sat. Construct a Date that respects the literal date (avoid TZ drift).
  const dt = new Date(parseInt(m[1], 10), month, day);
  const dow = dt.getDay();
  const row = cfg.baseRates[String(month)] || [];
  const rate = (typeof row[dow] === 'number' && row[dow] > 0) ? row[dow] : CONFIG.NIGHTLY_RATE;
  return { rate: rate, source: 'matrix', label: '' };
}

// Per-night breakdown for a stay. Returns an array of {date, dayOfWeek, rate, source, label}
// plus subtotal + weekly-discount-applied amount.
function computeNightlyBreakdown(checkin, checkout) {
  const out = { nights: 0, days: [], nightlySubtotal: 0, weeklyDiscount: 0, weeklyDiscountPercent: 0, weeklyDiscountApplied: false, nightlyAfterDiscount: 0 };
  if (!checkin || !checkout) return out;
  const cfg = getPricingConfig();
  const nights = calculateNights(checkin, checkout);
  out.nights = nights;
  if (nights <= 0) return out;
  const start = (checkin instanceof Date) ? new Date(checkin.getTime()) : (function () {
    const m = String(checkin).match(/^(\d{4})-(\d{2})-(\d{2})/);
    if (m) return new Date(parseInt(m[1], 10), parseInt(m[2], 10) - 1, parseInt(m[3], 10));
    return new Date(checkin);
  })();
  const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  for (let i = 0; i < nights; i++) {
    const d = new Date(start.getTime());
    d.setDate(start.getDate() + i);
    const dateStr = Utilities.formatDate(d, 'America/Toronto', 'yyyy-MM-dd');
    const r = getNightlyRateForDate(dateStr);
    out.days.push({
      date: dateStr,
      dayOfWeek: DAY_NAMES[d.getDay()],
      rate: r.rate,
      source: r.source,
      label: r.label,
    });
    out.nightlySubtotal += r.rate;
  }
  // Weekly discount
  if (nights >= cfg.weeklyDiscount.thresholdNights && cfg.weeklyDiscount.percentOff > 0) {
    const pct = cfg.weeklyDiscount.percentOff;
    out.weeklyDiscount = Math.round(out.nightlySubtotal * (pct / 100) * 100) / 100;
    out.weeklyDiscountPercent = pct;
    out.weeklyDiscountApplied = true;
  }
  out.nightlyAfterDiscount = Math.max(0, out.nightlySubtotal - out.weeklyDiscount);
  return out;
}

// ===== GUEST-BREAKDOWN HELPERS =====
// Backward-compat: treats old bookings (only `guests` field) as all-adults.

function _hasAgeBreakdown(data) {
  return data && data.adults !== undefined && data.adults !== null && data.adults !== '';
}

// Plain text like "2 adults, 1 child, 1 infant"
function formatGuestSummary(data) {
  if (!_hasAgeBreakdown(data)) {
    const g = parseInt(data.guests) || 1;
    return g + ' guest' + (g !== 1 ? 's' : '');
  }
  const adults = parseInt(data.adults) || 0;
  const children = parseInt(data.children) || 0;
  const infants = parseInt(data.infants) || 0;
  const parts = [];
  parts.push(adults + ' adult' + (adults !== 1 ? 's' : ''));
  if (children > 0) parts.push(children + ' ' + (children === 1 ? 'child' : 'children'));
  if (infants > 0) parts.push(infants + ' infant' + (infants !== 1 ? 's' : ''));
  return parts.join(', ');
}

// Inline HTML (<div class="row"> ...) for a styled breakdown block
function guestRowsHtml(data) {
  if (!_hasAgeBreakdown(data)) {
    return '<div class="row"><span>Guests</span><span>' + (parseInt(data.guests) || 1) + '</span></div>';
  }
  const adults = parseInt(data.adults) || 0;
  const children = parseInt(data.children) || 0;
  const infants = parseInt(data.infants) || 0;
  let html = '<div class="row"><span>Adults (13+)</span><span>' + adults + '</span></div>';
  html += '<div class="row"><span>Children (2&ndash;12)</span><span>' + children + '</span></div>';
  html += '<div class="row"><span>Infants (under 2)</span><span>' + infants + '</span></div>';
  return html;
}

// <p> paragraphs for email body style
function guestParagraphsHtml(data) {
  if (!_hasAgeBreakdown(data)) {
    return '<p style="margin: 4px 0;"><strong>Guests:</strong> ' + (parseInt(data.guests) || 1) + '</p>';
  }
  const adults = parseInt(data.adults) || 0;
  const children = parseInt(data.children) || 0;
  const infants = parseInt(data.infants) || 0;
  let html = '<p style="margin: 4px 0;"><strong>Adults (13+):</strong> ' + adults + '</p>';
  html += '<p style="margin: 4px 0;"><strong>Children (2&ndash;12):</strong> ' + children + '</p>';
  html += '<p style="margin: 4px 0;"><strong>Infants (under 2):</strong> ' + infants + '</p>';
  return html;
}

// <tr> rows for table-style layouts
function guestTableRowsHtml(data) {
  const cellLabel = 'padding: 6px 0; color: #888;';
  const cellValue = 'padding: 6px 0;';
  if (!_hasAgeBreakdown(data)) {
    return '<tr><td style="' + cellLabel + '">Guests</td><td style="' + cellValue + '">' + (parseInt(data.guests) || 1) + '</td></tr>';
  }
  const adults = parseInt(data.adults) || 0;
  const children = parseInt(data.children) || 0;
  const infants = parseInt(data.infants) || 0;
  let rows = '<tr><td style="' + cellLabel + '">Adults (13+)</td><td style="' + cellValue + '">' + adults + '</td></tr>';
  rows += '<tr><td style="' + cellLabel + '">Children (2&ndash;12)</td><td style="' + cellValue + '">' + children + '</td></tr>';
  rows += '<tr><td style="' + cellLabel + '">Infants (under 2)</td><td style="' + cellValue + '">' + infants + '</td></tr>';
  return rows;
}

// ===== WEB APP ENTRY POINTS =====

// Handle POST (new booking request from website)
function doPost(e) {
  try {
    const data = JSON.parse(e.postData.contents);
    const settings = getBookingSettings();

    // Free consultation requests from permaculture-course.html
    if (data.type === 'consultation') {
      return handleConsultation(data);
    }

    // Course bookings — direct or request flow
    if (data.type === 'course') {
      if (data.directBooking && settings.directBookingCourse) {
        return handleCourseDirectBookingPost(data);
      }
      return handleCourseBookingPost(data);
    }

    // Stay bookings — direct or request flow
    if (data.directBooking && settings.directBookingStay) {
      return handleStayDirectBookingPost(data);
    }

    const row = logBooking(data);
    sendGuestAutoReply(data);
    sendHostNotification(data, row);
    return jsonResponse({ status: 'ok', message: 'Booking request received' });
  } catch (err) {
    Logger.log('doPost error: ' + err.toString());
    return jsonResponse({ status: 'error', message: err.toString() });
  }
}

// ===== COURSE BOOKINGS =====
// Course bookings reuse the same sheet, with course details packed into Occasion/Message.
// Host gets a tailored email; guest gets a tailored auto-reply.
function handleCourseBookingPost(data) {
  // Build a descriptive Occasion so the booking is obvious in the sheet + admin UI
  const occasion = 'COURSE · ' + (data.courseName || data.course || 'Permaculture');
  const messageDetails = [
    'Course: ' + (data.courseName || ''),
    'Dates: ' + (data.courseDates || ''),
    _formatCourseAccommodationLine(data),
    'Participants: ' + (data.adults || 1) + (data.isCouple ? ' (couple — 25% off tuition)' : ''),
    data.dietary ? 'Dietary: ' + data.dietary : '',
    'Tuition subtotal: $' + Number(data.tuitionSubtotal || 0).toFixed(2),
    data.couplesDiscount > 0 ? 'Couples discount: -$' + Number(data.couplesDiscount).toFixed(2) : '',
    'Accommodation cost: $' + Number(data.stayCost || 0).toFixed(2),
    'HST: $' + Number(data.hst || 0).toFixed(2),
    '',
    data.message ? 'Guest note: ' + data.message : '',
  ].filter(Boolean).join('\n');

  const sheetData = {
    firstName: data.firstName,
    lastName: data.lastName,
    email: data.email,
    phone: data.phone || '',
    checkin: data.checkin,
    checkout: data.checkout,
    guests: data.adults || 1,
    adults: data.adults || 1,
    children: 0,
    infants: 0,
    pets: 0,
    occasion: occasion,
    message: messageDetails,
  };
  // logBooking uses calculateTotal for Estimated Total — but course total is different.
  // Write the row, then overwrite Estimated Total with the course-specific total.
  const rowId = logBooking(sheetData);
  const sheet = getSheet();
  sheet.getRange(rowId, getColIndex('Estimated Total')).setValue(Number(data.estimatedTotal || 0));

  // Send course-specific emails
  sendCourseGuestAutoReply(data);
  sendCourseHostNotification(data, rowId);
  return jsonResponse({ status: 'ok', message: 'Course enrollment received' });
}

function sendCourseGuestAutoReply(data) {
  const subject = 'Enrollment request received — ' + (data.courseName || 'Permaculture Course');
  const html = `
<div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; max-width: 560px; margin: 0 auto; color: #1a1a1a;">
  <div style="background: #2b4a1f; padding: 28px 32px;">
    <h1 style="color: #fff; font-size: 20px; margin: 0;">We got your enrollment request!</h1>
  </div>
  <div style="padding: 28px 32px; background: #fff;">
    <p style="font-size:15px;line-height:1.7;">Hi ${data.firstName},</p>
    <p style="font-size:15px;line-height:1.7;">Thanks for your interest in our permaculture course. Here's what you submitted:</p>
    <div style="background:#f5f3ee;border-radius:8px;padding:16px 20px;margin:16px 0;">
      <p style="margin:4px 0;"><strong>Course:</strong> ${data.courseName || ''}</p>
      <p style="margin:4px 0;"><strong>Dates:</strong> ${data.courseDates || ''}</p>
      <p style="margin:4px 0;"><strong>Accommodation:</strong> ${data.stayName || ''}</p>
      <p style="margin:4px 0;"><strong>Participants:</strong> ${data.adults}${data.isCouple ? ' (couple — 25% off tuition)' : ''}</p>
      <p style="margin:4px 0;"><strong>Estimated total:</strong> $${Number(data.estimatedTotal || 0).toLocaleString('en-CA', {minimumFractionDigits:2, maximumFractionDigits:2})} CAD</p>
    </div>
    <p style="font-size:15px;line-height:1.7;">${CONFIG.HOST_NAME} will review your request and confirm your spot within a few hours. Because cohorts are intentionally small, we'll let you know right away if it's a fit — and send a secure payment link to lock it in.</p>
    <p style="font-size:14px;color:#888;">Questions? Just reply to this email.</p>
    <p style="font-size:14px;">— ${CONFIG.HOST_NAME}, ${CONFIG.PROPERTY_NAME}</p>
  </div>
</div>`;
  MailApp.sendEmail({
    to: data.email,
    subject: subject,
    htmlBody: html,
    replyTo: CONFIG.HOST_EMAIL,
    name: CONFIG.PROPERTY_NAME,
  });
}

function sendCourseHostNotification(data, rowId) {
  const subject = '🌱 New Course Enrollment — ' + (data.firstName || '') + ' ' + (data.lastName || '');
  const html = `
<div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; max-width: 560px; margin: 0 auto; color: #1a1a1a;">
  <div style="background: #3d8c40; padding: 24px 32px;">
    <h1 style="color: #fff; font-size: 18px; margin: 0;">New Permaculture Course Enrollment</h1>
  </div>
  <div style="padding: 28px 32px; background: #fff;">
    <p style="font-size:15px;line-height:1.7;"><strong>${data.firstName} ${data.lastName}</strong> (${data.email}${data.phone ? ' · ' + data.phone : ''}) wants to enroll.</p>
    <div style="background:#f5f3ee;border-radius:8px;padding:16px 20px;margin:16px 0;">
      <p style="margin:4px 0;"><strong>Course:</strong> ${data.courseName || ''}</p>
      <p style="margin:4px 0;"><strong>Dates:</strong> ${data.courseDates || ''}</p>
      <p style="margin:4px 0;"><strong>Accommodation:</strong> ${data.stayName || ''}</p>
      <p style="margin:4px 0;"><strong>Participants:</strong> ${data.adults}${data.isCouple ? ' (couple — 25% off tuition)' : ''}</p>
    </div>
    <div style="background:#fff8e1;border:1px solid #f1c232;border-radius:8px;padding:14px 18px;margin:16px 0;">
      <p style="margin:4px 0;font-weight:600;">Pricing breakdown</p>
      <p style="margin:4px 0;">Tuition (${data.adults} × $${(data.tuitionSubtotal/data.adults).toFixed(0)}): $${Number(data.tuitionSubtotal).toLocaleString('en-CA',{minimumFractionDigits:2})}</p>
      ${data.couplesDiscount > 0 ? '<p style="margin:4px 0;color:#2e6e31;">Couples discount (-25%): -$' + Number(data.couplesDiscount).toLocaleString('en-CA',{minimumFractionDigits:2}) + '</p>' : ''}
      <p style="margin:4px 0;">Accommodation: $${Number(data.stayCost || 0).toLocaleString('en-CA',{minimumFractionDigits:2})}</p>
      <p style="margin:4px 0;">HST (13%): $${Number(data.hst || 0).toLocaleString('en-CA',{minimumFractionDigits:2})}</p>
      <p style="margin:8px 0 4px;font-weight:600;">Total: $${Number(data.estimatedTotal || 0).toLocaleString('en-CA',{minimumFractionDigits:2})} CAD</p>
    </div>
    ${data.dietary ? '<div style="background:#f0f7ee;border-left:3px solid #3d8c40;padding:12px 16px;margin:14px 0;"><p style="margin:0;font-size:14px;"><strong>Dietary / accessibility:</strong> ' + String(data.dietary).replace(/</g,'&lt;') + '</p></div>' : ''}
    ${data.message ? '<div style="background:#f9f9f6;border-left:3px solid #888;padding:12px 16px;margin:14px 0;"><p style="margin:0;font-size:14px;font-style:italic;">"' + String(data.message).replace(/</g,'&lt;') + '"</p></div>' : ''}
    <p style="font-size:14px;color:#555;margin-top:20px;">Open the <a href="${CONFIG.SCRIPT_URL}?action=admin">admin dashboard</a> to accept / decline. The booking is in row ${rowId} of the Bookings sheet.</p>
  </div>
</div>`;
  MailApp.sendEmail({
    to: CONFIG.HOST_EMAIL,
    subject: subject,
    htmlBody: html,
    replyTo: data.email,
    name: 'SFF Booking System',
  });
}

// ============================================================
// ===== DIRECT BOOKING (host-toggleable in admin Settings) ===
// ============================================================
// When the host flips Settings → "Direct booking — Stay" or "— Course" ON,
// the guest's submission skips the host-accept step and lands as
// "Awaiting Confirmation". The host's only remaining job is to verify the
// payment landed (Stripe dashboard or Interac e-Transfer inbox) and click
// Mark Paid in admin, which sends the welcome email + check-in instructions.

// Status: 'Awaiting Confirmation' is treated like 'Awaiting Payment' for
// downstream actions (admin Mark Paid, iCal blocking, etc.) but distinguishes
// in the UI between "host accepted, waiting on guest payment" (Awaiting Payment)
// and "guest paid, waiting on host verify+welcome" (Awaiting Confirmation).

function handleStayDirectBookingPost(data) {
  // Recompute total server-side. Trust but verify the client's number.
  const serverTotal = calculateTotal(data);
  const clientTotal = Number(data.finalTotal || (data.quote && data.quote.grandTotal) || 0);
  const finalTotal = serverTotal > 0 ? serverTotal : clientTotal;

  // Tolerance check — log a warning if they diverge by more than $1
  if (clientTotal > 0 && Math.abs(serverTotal - clientTotal) > 1) {
    Logger.log('Direct-book stay total mismatch — server ' + serverTotal + ' vs client ' + clientTotal);
  }

  const paymentMethod = (data.paymentMethod || 'stripe').toString().toLowerCase();
  const sheet = getSheet();
  const rowId = logBooking(data);

  // Override status + finalTotal — direct bookings skip the "Pending → Accept" stage.
  sheet.getRange(rowId, getColIndex('Status')).setValue('Awaiting Confirmation');
  sheet.getRange(rowId, getColIndex('Status')).setBackground('#cce5ff').setFontColor('#004085');
  sheet.getRange(rowId, getColIndex('Final Total')).setValue(finalTotal);
  sheet.getRange(rowId, getColIndex('Responded')).setValue(new Date());
  // Mark intent — actual receipt of payment is verified later by host
  sheet.getRange(rowId, getColIndex('Payment Method')).setValue(
    paymentMethod === 'etransfer' ? 'e-Transfer (pending)' : 'Stripe (pending)'
  );

  const bookingData = getBookingData(sheet, rowId);

  if (paymentMethod === 'etransfer') {
    // e-Transfer flow: dates held for 48h, host verifies inbox + clicks Mark Paid
    sendGuestDirectETransferInstructions(bookingData, finalTotal);
    sendHostDirectBookingAlert(bookingData, rowId, 'e-Transfer', finalTotal);
    return jsonResponse({
      status: 'ok',
      mode: 'direct-etransfer',
      message: 'Booking received. Check your email for e-Transfer instructions.',
      bookingId: bookingData.id,
    });
  }

  // Default: Stripe — create checkout session, return URL for the page to redirect to
  let stripeUrl = '';
  try {
    stripeUrl = createStripeCheckoutSession(bookingData, finalTotal, bookingData.id);
  } catch (err) {
    Logger.log('Direct-book Stripe session creation failed: ' + err.toString());
    // Roll back so the guest isn't left with an undecidable booking
    sheet.getRange(rowId, getColIndex('Status')).setValue('Pending');
    sheet.getRange(rowId, getColIndex('Status')).setBackground('#fff3cd').setFontColor('#000');
    sheet.getRange(rowId, getColIndex('Final Total')).setValue('');
    sheet.getRange(rowId, getColIndex('Payment Method')).setValue('');
    sendHostNotification(data, rowId);
    return jsonResponse({
      status: 'error',
      message: 'Could not create payment session. Your dates have been held — Deniz will follow up directly.',
    });
  }

  sendHostDirectBookingAlert(bookingData, rowId, 'Stripe', finalTotal);
  return jsonResponse({
    status: 'ok',
    mode: 'direct-stripe',
    stripeUrl: stripeUrl,
    bookingId: bookingData.id,
  });
}

function handleCourseDirectBookingPost(data) {
  // Course pricing is computed client-side in book-course.html (tuition + couples
  // discount + accommodation + HST). We trust data.estimatedTotal as the final
  // amount because the formula is non-trivial to recompute here without duplicating it.
  const finalTotal = Number(data.estimatedTotal || 0);
  if (finalTotal <= 0) {
    return jsonResponse({ status: 'error', message: 'Invalid total.' });
  }

  // Server-side inventory check — rejects double-bookings even if the client missed the
  // sold-out flag (e.g. two guests submitted simultaneously and one got there first).
  // Validates against the full stays map (multi-accommodation) or the legacy single stay.
  try {
    if (data.stays && typeof data.stays === 'object' && Object.keys(data.stays).length > 0) {
      _assertCourseStayAvailable(data.course, data.stays);
    } else {
      _assertCourseStayAvailable(data.course, data.stay, data.stayBeds);
    }
  } catch (err) {
    return jsonResponse({ status: 'error', message: err.message });
  }

  // Build the same packed Occasion/Message structure handleCourseBookingPost uses,
  // so the row looks consistent in the sheet + admin UI.
  const occasion = 'COURSE · ' + (data.courseName || data.course || 'Permaculture');
  const messageDetails = [
    'Course: ' + (data.courseName || ''),
    'Dates: ' + (data.courseDates || ''),
    _formatCourseAccommodationLine(data),
    'Participants: ' + (data.adults || 1) + (data.isCouple ? ' (couple — 25% off tuition)' : ''),
    data.dietary ? 'Dietary: ' + data.dietary : '',
    'Tuition subtotal: $' + Number(data.tuitionSubtotal || 0).toFixed(2),
    data.couplesDiscount > 0 ? 'Couples discount: -$' + Number(data.couplesDiscount).toFixed(2) : '',
    'Accommodation cost: $' + Number(data.stayCost || 0).toFixed(2),
    'HST: $' + Number(data.hst || 0).toFixed(2),
    '',
    data.message ? 'Guest note: ' + data.message : '',
  ].filter(Boolean).join('\n');

  const sheetData = {
    firstName: data.firstName,
    lastName: data.lastName,
    email: data.email,
    phone: data.phone || '',
    checkin: data.checkin,
    checkout: data.checkout,
    guests: data.adults || 1,
    adults: data.adults || 1,
    children: 0,
    infants: 0,
    pets: 0,
    occasion: occasion,
    message: messageDetails,
  };

  const paymentMethod = (data.paymentMethod || 'stripe').toString().toLowerCase();
  const sheet = getSheet();
  const rowId = logBooking(sheetData);

  // Course-specific Estimated Total override (calculateTotal in logBooking uses stay pricing)
  sheet.getRange(rowId, getColIndex('Estimated Total')).setValue(finalTotal);
  sheet.getRange(rowId, getColIndex('Status')).setValue('Awaiting Confirmation');
  sheet.getRange(rowId, getColIndex('Status')).setBackground('#cce5ff').setFontColor('#004085');
  sheet.getRange(rowId, getColIndex('Final Total')).setValue(finalTotal);
  sheet.getRange(rowId, getColIndex('Responded')).setValue(new Date());
  sheet.getRange(rowId, getColIndex('Payment Method')).setValue(
    paymentMethod === 'etransfer' ? 'e-Transfer (pending)' : 'Stripe (pending)'
  );

  const bookingData = getBookingData(sheet, rowId);
  // Tag the bookingData with the original course payload bits so emails read well
  bookingData._courseName = data.courseName || '';
  bookingData._courseDates = data.courseDates || '';
  bookingData._stayName = data.stayName || '';
  bookingData._isCouple = !!data.isCouple;
  bookingData._directCourse = true;

  if (paymentMethod === 'etransfer') {
    sendGuestDirectETransferInstructions(bookingData, finalTotal);
    sendHostDirectBookingAlert(bookingData, rowId, 'e-Transfer', finalTotal);
    return jsonResponse({
      status: 'ok',
      mode: 'direct-etransfer',
      message: 'Enrollment received. Check your email for e-Transfer instructions.',
      bookingId: bookingData.id,
    });
  }

  let stripeUrl = '';
  try {
    stripeUrl = createStripeCheckoutSession(bookingData, finalTotal, bookingData.id);
  } catch (err) {
    Logger.log('Direct-book course Stripe session failed: ' + err.toString());
    sheet.getRange(rowId, getColIndex('Status')).setValue('Pending');
    sheet.getRange(rowId, getColIndex('Status')).setBackground('#fff3cd').setFontColor('#000');
    sheet.getRange(rowId, getColIndex('Final Total')).setValue('');
    sheet.getRange(rowId, getColIndex('Payment Method')).setValue('');
    sendCourseHostNotification(data, rowId);
    return jsonResponse({
      status: 'error',
      message: 'Could not create payment session. Your dates have been held — Deniz will follow up directly.',
    });
  }

  sendHostDirectBookingAlert(bookingData, rowId, 'Stripe', finalTotal);
  return jsonResponse({
    status: 'ok',
    mode: 'direct-stripe',
    stripeUrl: stripeUrl,
    bookingId: bookingData.id,
  });
}

// Email — guest, after picking e-Transfer in a direct booking
function sendGuestDirectETransferInstructions(data, finalTotal) {
  const isCourse = !!data._directCourse;
  const subjectLabel = isCourse ? 'enrollment' : 'booking';
  const subject = `Your ${subjectLabel} is reserved — complete e-Transfer to confirm — ${CONFIG.PROPERTY_NAME}`;

  const datesLine = isCourse
    ? `<p style="margin:4px 0;"><strong>Course:</strong> ${data._courseName || ''}</p><p style="margin:4px 0;"><strong>Dates:</strong> ${data._courseDates || (data.checkin + ' → ' + data.checkout)}</p>`
    : `<p style="margin:4px 0;"><strong>Check-in:</strong> ${data.checkin} (3:00 PM)</p><p style="margin:4px 0;"><strong>Checkout:</strong> ${data.checkout} (11:00 AM)</p>`;

  const html = `
<div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; max-width: 560px; margin: 0 auto; color: #1a1a1a;">
  <div style="background: #2b4a1f; padding: 32px; text-align: center;">
    <h1 style="color: #fff; font-size: 22px; margin: 0;">You're Booked — Just Confirm Payment</h1>
  </div>
  <div style="padding: 32px; background: #fff;">
    <p style="font-size: 16px; line-height: 1.7;">Hi ${data.firstName},</p>
    <p style="font-size: 16px; line-height: 1.7;">Your dates at ${CONFIG.PROPERTY_NAME} are reserved. To finalize, send your e-Transfer within <strong>48 hours</strong> — otherwise the dates will be released.</p>

    <div style="background: #f9f9f6; border: 1px solid #e0ddd6; border-radius: 8px; padding: 20px; margin: 24px 0;">
      <h3 style="margin: 0 0 12px; font-size: 15px; color: #888; text-transform: uppercase; letter-spacing: 0.05em;">Reservation</h3>
      ${datesLine}
      ${!isCourse ? guestParagraphsHtml(data) : ''}
      ${(!isCourse && data.pets > 0) ? `<p style="margin: 4px 0;"><strong>Pets:</strong> ${data.pets}</p>` : ''}
      <p style="margin: 12px 0 0; font-size: 18px; font-weight: 700;"><strong>Total: $${Number(finalTotal).toLocaleString('en-CA', {minimumFractionDigits:2, maximumFractionDigits:2})} CAD</strong> <span style="font-size:13px;font-weight:400;color:#888;">(HST included)</span></p>
    </div>

    <div style="background: #f0f7ee; border: 1px solid #3d8c40; border-radius: 8px; padding: 24px; margin: 24px 0;">
      <h3 style="margin: 0 0 12px; font-size: 16px; color: #2e6e31;">Send via Interac e-Transfer</h3>
      <p style="margin: 0 0 6px;">Send <strong>$${Number(finalTotal).toLocaleString('en-CA', {minimumFractionDigits:2, maximumFractionDigits:2})} CAD</strong> to:</p>
      <p style="margin: 0 0 12px; font-size: 17px; font-weight: 600; color: #2b4a1f;">${CONFIG.ETRANSFER_EMAIL}</p>
      <p style="margin: 0; font-size: 13px; color: #666;">Memo: <strong>${data.id} — ${data.firstName} ${data.lastName}</strong></p>
    </div>

    <div style="background: #fff3cd; border: 1px solid #ffc107; border-radius: 8px; padding: 16px 20px; margin: 24px 0;">
      <p style="margin: 0; font-size: 14px;"><strong>⏳ 48-hour hold:</strong> If we don't see your e-Transfer within 48 hours, the dates are released automatically.</p>
    </div>

    <h3 style="font-size: 16px; margin: 24px 0 12px;">What happens next</h3>
    <p style="font-size: 14px; line-height: 1.7; color: #444;">Once Deniz confirms the e-Transfer landed, you'll get the final ${subjectLabel} confirmation with self check-in instructions, the property guide, and everything you need. Questions? Just reply.</p>

    <p style="font-size: 14px; color: #1a1a1a; margin-top: 24px;">— ${CONFIG.HOST_NAME}, ${CONFIG.PROPERTY_NAME}</p>
  </div>
  <div style="background: #f5f3ee; padding: 20px 32px; font-size: 13px; color: #888; text-align: center;">
    ${CONFIG.PROPERTY_NAME}
  </div>
</div>`;

  MailApp.sendEmail({
    to: data.email,
    subject: subject,
    htmlBody: html,
    replyTo: CONFIG.HOST_EMAIL,
    name: CONFIG.PROPERTY_NAME,
  });
}

// Email — host, on a new direct booking (Stripe pending OR e-Transfer pending)
function sendHostDirectBookingAlert(data, rowId, paymentMethod, finalTotal) {
  const isCourse = !!data._directCourse;
  const isStripe = (paymentMethod || '').toString().toLowerCase() === 'stripe';
  const headline = isCourse ? 'New Direct Course Enrollment' : 'New Direct Booking';
  const subject = `🟢 ${headline} — ${data.firstName || ''} ${data.lastName || ''} (${data.checkin} → ${data.checkout})`;

  const verifyHint = isStripe
    ? 'Verify the charge in your <a href="https://dashboard.stripe.com/payments">Stripe Dashboard</a>, then click <strong>Mark Paid</strong> in the admin to send the welcome email + check-in instructions.'
    : `Watch your inbox at <strong>${CONFIG.ETRANSFER_EMAIL}</strong> for the Interac e-Transfer (memo: ${data.id} — ${data.firstName} ${data.lastName}). Once it arrives, click <strong>Mark Paid</strong> in the admin to send the welcome email + check-in instructions.`;

  const datesLine = isCourse
    ? `<p style="margin:4px 0;"><strong>Course:</strong> ${data._courseName || ''}</p><p style="margin:4px 0;"><strong>Dates:</strong> ${data._courseDates || (data.checkin + ' → ' + data.checkout)}</p>`
    : `<p style="margin:4px 0;"><strong>Dates:</strong> ${data.checkin} → ${data.checkout} (${data.nights} night${data.nights === 1 ? '' : 's'})</p>${guestParagraphsHtml(data)}${data.pets > 0 ? `<p style="margin:4px 0;"><strong>Pets:</strong> ${data.pets}</p>` : ''}`;

  const html = `
<div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;max-width:560px;margin:0 auto;color:#1a1a1a;">
  <div style="background:#3d8c40;padding:24px 32px;">
    <h1 style="color:#fff;font-size:18px;margin:0;">${headline}</h1>
    <p style="color:#d6efd8;font-size:13px;margin:6px 0 0;">Direct booking — guest is paying via ${paymentMethod}.</p>
  </div>
  <div style="padding:28px 32px;background:#fff;">
    <p style="font-size:15px;line-height:1.7;"><strong>${data.firstName} ${data.lastName}</strong> &middot; ${data.email}${data.phone ? ' &middot; ' + data.phone : ''}</p>
    <div style="background:#f9f9f6;border-radius:8px;padding:16px 20px;margin:16px 0;">
      ${datesLine}
      <p style="margin:8px 0 0;font-size:16px;font-weight:600;">Total: $${Number(finalTotal).toLocaleString('en-CA',{minimumFractionDigits:2,maximumFractionDigits:2})} CAD</p>
    </div>
    <div style="background:#fff8e1;border:1px solid #f1c232;border-radius:8px;padding:14px 18px;margin:16px 0;">
      <p style="margin:0;font-size:14px;line-height:1.7;">${verifyHint}</p>
    </div>
    ${(function () {
      const ups = _parseUpsellsFromMessage(typeof data.message === 'string' ? data.message : '');
      if (!ups.chef.present && !ups.course.present) return '';
      let block = '<div style="background:#f0f7ee;border:1px solid #3d8c40;border-radius:8px;padding:14px 18px;margin:14px 0;"><p style="margin:0 0 8px;font-size:13px;font-weight:600;color:#2b4a1f;text-transform:uppercase;letter-spacing:0.06em;">⚡ Optional add-ons requested</p>';
      if (ups.chef.present) block += '<p style="margin:6px 0;font-size:14px;"><strong>🍽️ Add a private chef</strong>' + (ups.chef.details ? '<br><span style="color:#444;font-size:13px;">"' + ups.chef.details.replace(/</g, '&lt;') + '"</span>' : '') + '</p>';
      if (ups.course.present) block += '<p style="margin:6px 0;font-size:14px;"><strong>🌱 Add a permaculture experience</strong>' + (ups.course.details ? '<br><span style="color:#444;font-size:13px;">"' + ups.course.details.replace(/</g, '&lt;') + '"</span>' : '') + '</p>';
      block += '<p style="margin:10px 0 0;font-size:12px;color:#666;">Reply directly to the guest with availability + pricing.</p></div>';
      return block;
    })()}
    ${data.message ? '<div style="background:#f9f9f6;border-left:3px solid #888;padding:12px 16px;margin:14px 0;"><p style="margin:0;font-size:14px;font-style:italic;">' + (typeof data.message === 'string' ? data.message.replace(/</g, '&lt;') : '') + '</p></div>' : ''}
    <p style="font-size:14px;color:#555;margin-top:20px;">Open the <a href="${CONFIG.SCRIPT_URL}?action=admin">admin dashboard</a>. The booking is in row ${rowId} of the Bookings sheet.</p>
  </div>
</div>`;

  try {
    MailApp.sendEmail({
      to: CONFIG.HOST_EMAIL,
      subject: subject,
      htmlBody: html,
      replyTo: data.email,
      name: 'SFF Booking System',
    });
  } catch (err) {
    Logger.log('sendHostDirectBookingAlert error: ' + err.toString());
  }
}

// ============================================================
// ===== COURSE ACCOMMODATION INVENTORY ========================
// ============================================================
// Counts how many *Confirmed* bookings have claimed each accommodation type for a
// given course occurrence (3day-aug / 3day-sep / 7day). Used by the website on the
// enroll page to mark sold-out rooms and show remaining dorm beds.

const COURSE_STAY_CAPACITY = {
  bell: 1,
  bunkie: 1,
  dorm: 3,
  shared: 1,    // Mushroom Room (key kept stable for backward-compat with older bookings)
  ensuite: 1,   // Pond View Room
};

// Accept legacy stay-name strings (e.g. "Bell Tent Glamping") in pre-2026-05-06 bookings
// where the [stay=KEY,beds=N] tag wasn't yet embedded in Message.
const COURSE_STAY_NAME_LEGACY = {
  'Bell Tent Glamping': 'bell',
  'Bunkie Cabin': 'bunkie',
  'King Room Dorm Bed': 'dorm',
  'King Room Dorm': 'dorm',
  'Private Farmhouse Room (shared bath)': 'shared',
  'Mushroom Room': 'shared',
  'Pond View Room (Ensuite)': 'ensuite',
};

// Parse ALL [stay=KEY,beds=N] tags from a Message field. Returns an array of
// {key, beds}. Falls back to legacy "Accommodation: <Name>" parsing if no tags found.
function _parseStaysFromMessage(msg) {
  if (!msg) return [];
  const out = [];
  const re = /\[stay=([a-z\-]+),beds=(\d+)\]/g;
  let m;
  while ((m = re.exec(String(msg))) !== null) {
    out.push({ key: m[1], beds: parseInt(m[2], 10) || 1 });
  }
  if (out.length > 0) return out;
  // Legacy fallback — single "Accommodation: <Name>" line, no tag
  const nameMatch = String(msg).match(/Accommodation:\s*([^\n]+?)(\s*\[|$)/);
  if (nameMatch) {
    const trimmed = nameMatch[1].trim();
    const key = COURSE_STAY_NAME_LEGACY[trimmed];
    if (key) return [{ key: key, beds: 1 }];
  }
  return [];
}

// Backward-compat single-stay accessor (returns first parsed stay or {key:null, beds:0})
function _parseStayFromMessage(msg) {
  const all = _parseStaysFromMessage(msg);
  return all[0] || { key: null, beds: 0 };
}

// Build the human-readable + machine-tagged Accommodation line(s) for the Message column.
// Accepts either the new shape (data.stays = {key:count}) or the legacy shape
// (data.stay + data.stayBeds + data.stayName).
function _formatCourseAccommodationLine(data) {
  // Prefer the new multi-accommodation map if present
  if (data && data.stays && typeof data.stays === 'object') {
    const parts = [];
    Object.keys(data.stays).forEach(key => {
      const count = parseInt(data.stays[key], 10) || 0;
      if (count <= 0) return;
      const isDorm = key === 'dorm';
      const name = (data.staysList || []).find(s => s.key === key);
      const displayName = (name && name.name) ? name.name : key;
      const tag = '[stay=' + key + ',beds=' + count + ']';
      parts.push(count + '× ' + displayName + (isDorm ? ' (' + count + ' bed' + (count > 1 ? 's' : '') + ')' : '') + ' ' + tag);
    });
    if (parts.length > 0) return 'Accommodation: ' + parts.join(' + ');
  }
  // Legacy single-stay payload
  const stayKey = data && data.stay ? String(data.stay) : '';
  const stayName = data && (data.stayName || data.stay) ? (data.stayName || data.stay) : '';
  const beds = parseInt((data && data.stayBeds) || 0, 10) || 1;
  if (!stayKey) return 'Accommodation: ' + stayName;
  return 'Accommodation: ' + stayName + ' [stay=' + stayKey + ',beds=' + beds + ']';
}

// Match a sheet row to a course occurrence by checkin/checkout. Course occurrences are
// fixed dates set by COURSE_OCCURRENCES below; we treat a row as belonging to one if its
// check-in matches.
const COURSE_OCCURRENCES = {
  '3day-aug': { checkin: '2026-08-14', checkout: '2026-08-16' },
  '3day-sep': { checkin: '2026-09-04', checkout: '2026-09-07' },
  '7day':     { checkin: '2026-08-24', checkout: '2026-08-30' },
};

function _normalizeDate(val) {
  if (!val) return '';
  if (val instanceof Date) return Utilities.formatDate(val, 'America/Toronto', 'yyyy-MM-dd');
  const s = String(val);
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  return m ? m[0] : s;
}

function getCourseAvailability(courseKey) {
  const out = {
    course: courseKey,
    stays: {},
  };
  Object.keys(COURSE_STAY_CAPACITY).forEach(k => {
    out.stays[k] = { booked: 0, capacity: COURSE_STAY_CAPACITY[k] };
  });
  const occ = COURSE_OCCURRENCES[courseKey];
  if (!occ) return out;

  try {
    const sheet = getSheet();
    const lastRow = sheet.getLastRow();
    if (lastRow < 2) return out;

    const data = sheet.getRange(2, 1, lastRow - 1, 23).getValues();
    for (let i = 0; i < data.length; i++) {
      const row = data[i];
      const status = row[2];           // Status
      const checkin = _normalizeDate(row[7]);  // Check-in
      const message = row[13];         // Message
      // Only count Confirmed bookings (per the user's spec — pending/awaiting do NOT block)
      if (status !== 'Confirmed') continue;
      if (checkin !== occ.checkin) continue;

      const parsedAll = _parseStaysFromMessage(message);
      parsedAll.forEach(p => {
        if (!p.key || !out.stays[p.key]) return;  // unknown stay key
        out.stays[p.key].booked += p.beds || 1;
      });
    }
  } catch (err) {
    Logger.log('getCourseAvailability error: ' + err.toString());
  }
  return out;
}

// Throws if any requested stay would oversell its capacity. Accepts either:
//   - a stays map ({key: count}, new multi-accommodation shape), OR
//   - a single (stayKey, beds) pair for legacy callers
// Used by direct-booking handlers to reject submissions that would oversell.
function _assertCourseStayAvailable(courseKey, stayKeyOrMap, bedsRequested) {
  // Normalize input to a stays map
  let staysMap;
  if (stayKeyOrMap && typeof stayKeyOrMap === 'object') {
    staysMap = stayKeyOrMap;
  } else {
    staysMap = {};
    if (stayKeyOrMap) staysMap[stayKeyOrMap] = parseInt(bedsRequested, 10) || 1;
  }
  // Filter unlimited / unknown keys
  const checkKeys = Object.keys(staysMap).filter(k => {
    if (k === 'commuter' || k === 'byo') return false;
    return !!COURSE_STAY_CAPACITY[k];
  });
  if (checkKeys.length === 0) return;

  const avail = getCourseAvailability(courseKey);
  checkKeys.forEach(k => {
    const info = avail.stays[k];
    const wanted = Math.max(1, parseInt(staysMap[k], 10) || 1);
    const remaining = Math.max(0, info.capacity - info.booked);
    if (remaining < wanted) {
      throw new Error('Accommodation "' + k + '" is sold out (only ' + remaining + ' of ' + info.capacity + ' left, you asked for ' + wanted + '). Please refresh the enrollment page and pick another option.');
    }
  });
}

// ============================================================
// ===== FREE CONSULTATION INTAKE (Permaculture page) ==========
// ============================================================
// Triggered by permaculture-course.html's "Book a Free Consultation" form.
// Appends to a "Consultation Leads" sheet (auto-created on first use) and
// emails straightfinfarms@gmail.com with the lead's info.
function handleConsultation(data) {
  try {
    const firstName = String(data.firstName || '').trim();
    const lastName  = String(data.lastName  || '').trim();
    const email     = String(data.email     || '').trim();
    const phone     = String(data.phone     || '').trim();
    const reason    = String(data.reason    || '').trim();
    const source    = String(data.source    || 'website').trim();
    const pageUrl   = String(data.pageUrl   || '').trim();

    if (!firstName || !lastName) return jsonResponse({ status: 'error', message: 'Missing name.' });
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return jsonResponse({ status: 'error', message: 'Invalid email.' });
    if (phone.replace(/\D/g, '').length < 7) return jsonResponse({ status: 'error', message: 'Invalid phone.' });

    // Log to a "Consultation Leads" sheet (auto-created with header on first use).
    const ss = SpreadsheetApp.openById(CONFIG.SPREADSHEET_ID);
    let sheet = ss.getSheetByName('Consultation Leads');
    if (!sheet) {
      sheet = ss.insertSheet('Consultation Leads');
      sheet.appendRow([
        'Timestamp', 'First Name', 'Last Name', 'Email', 'Phone',
        'Reason', 'Source', 'Page URL', 'Status'
      ]);
      sheet.getRange(1, 1, 1, 9)
        .setFontWeight('bold')
        .setBackground('#2b4a1f')
        .setFontColor('#ffffff');
      sheet.setFrozenRows(1);
      sheet.setColumnWidths(1, 9, 160);
    }
    sheet.appendRow([
      new Date(), firstName, lastName, email, phone,
      reason, source, pageUrl, 'New'
    ]);

    // Notify host inbox. straightfinfarms@gmail.com is the project owner, so
    // MailApp.sendEmail delivers via the script-owner's quota.
    const fullName = firstName + ' ' + lastName;
    const subject = '🌱 New consultation request — ' + fullName;
    const bodyText =
      'New free-consultation request from the permaculture page.\n\n' +
      'Name:   ' + fullName + '\n' +
      'Email:  ' + email + '\n' +
      'Phone:  ' + phone + '\n' +
      'Source: ' + source + '\n' +
      'Page:   ' + pageUrl + '\n\n' +
      'Why interested:\n' + (reason || '(not provided)') + '\n\n' +
      '— Submitted ' + new Date().toString();

    const bodyHtml =
      '<div style="font-family:Inter,Arial,sans-serif;color:#1a1a1a;max-width:560px;">' +
        '<h2 style="font-family:Georgia,serif;color:#2b4a1f;margin:0 0 14px;">' +
          '🌱 New consultation request' +
        '</h2>' +
        '<p style="color:#555;margin:0 0 20px;">From the permaculture page.</p>' +
        '<table cellpadding="8" cellspacing="0" style="border-collapse:collapse;font-size:14px;">' +
          '<tr><td style="color:#888;">Name</td><td><strong>' + fullName + '</strong></td></tr>' +
          '<tr><td style="color:#888;">Email</td><td><a href="mailto:' + email + '">' + email + '</a></td></tr>' +
          '<tr><td style="color:#888;">Phone</td><td><a href="tel:' + phone + '">' + phone + '</a></td></tr>' +
          '<tr><td style="color:#888;">Source</td><td>' + source + '</td></tr>' +
        '</table>' +
        (reason
          ? '<h3 style="margin:24px 0 6px;color:#1a1a1a;">Why interested</h3>' +
            '<p style="color:#444;line-height:1.6;background:#f5f3ee;padding:14px;border-radius:6px;">' +
              reason.replace(/</g, '&lt;').replace(/\n/g, '<br>') +
            '</p>'
          : '<p style="color:#999;margin-top:24px;"><em>No reason provided.</em></p>'
        ) +
        '<p style="margin-top:28px;font-size:12px;color:#999;">Logged to <em>Consultation Leads</em> sheet · ' + new Date().toString() + '</p>' +
      '</div>';

    MailApp.sendEmail({
      to: 'straightfinfarms@gmail.com',
      replyTo: email,
      subject: subject,
      body: bodyText,
      htmlBody: bodyHtml
    });

    return jsonResponse({ status: 'ok', message: 'Consultation request received.' });
  } catch (err) {
    Logger.log('handleConsultation error: ' + err.toString());
    return jsonResponse({ status: 'error', message: err.toString() });
  }
}

// Handle GET (accept/decline/confirm-payment actions from email links)
function doGet(e) {
  // Google Reviews JSON endpoint — fetched by the homepage
  if (e && e.parameter && e.parameter.action === 'reviews') {
    return serveReviewsJson_();
  }

  const action = e.parameter.action;

  // Stripe callbacks (no token needed — verified via Stripe API)
  if (action === 'stripe_success') {
    return handleStripeSuccess(e.parameter);
  } else if (action === 'stripe_cancel') {
    return HtmlService.createHtmlOutput(stripeCancelPage()).setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
  }

  // Airbnb iCal proxy (no token needed)
  if (action === 'ical') {
    return proxyAirbnbCalendar();
  }

  if (action === 'bookings_ics') {
    // ?for=airbnb → only Confirmed bookings, AND empty when in TEST mode (so Airbnb
    // doesn't block dates while we're testing). Without that flag = host's full feed.
    const forAirbnb = String(e.parameter.for || '').toLowerCase() === 'airbnb';
    return generateBookingsICal({ forAirbnb: forAirbnb });
  }

  if (action === 'admin') {
    return buildAdminDashboard();
  }

  // Public course-availability endpoint — used by book-course.html on course select
  // to mark sold-out rooms and show remaining dorm beds. Counts Confirmed bookings only.
  if (action === 'course_availability') {
    const courseKey = String(e.parameter.course || '').trim();
    const result = getCourseAvailability(courseKey);
    return ContentService
      .createTextOutput(JSON.stringify(result))
      .setMimeType(ContentService.MimeType.JSON);
  }

  // Public pricing endpoint — used by book-direct.html on date pick to get the
  // server's authoritative per-night breakdown + weekly discount.
  // Two modes:
  //   ?action=get_pricing                       → return the full pricing config (matrix + overrides)
  //   ?action=get_pricing&checkin=...&checkout=... → return per-night breakdown for that range
  if (action === 'get_pricing') {
    const cfg = getPricingConfig();
    if (e.parameter.checkin && e.parameter.checkout) {
      const breakdown = computeNightlyBreakdown(e.parameter.checkin, e.parameter.checkout);
      return ContentService
        .createTextOutput(JSON.stringify({
          mode: 'breakdown',
          nights: breakdown.nights,
          days: breakdown.days,
          nightlySubtotal: breakdown.nightlySubtotal,
          weeklyDiscount: breakdown.weeklyDiscount,
          weeklyDiscountPercent: breakdown.weeklyDiscountPercent,
          weeklyDiscountApplied: breakdown.weeklyDiscountApplied,
          nightlyAfterDiscount: breakdown.nightlyAfterDiscount,
          weeklyDiscountThresholdNights: cfg.weeklyDiscount.thresholdNights,
        }))
        .setMimeType(ContentService.MimeType.JSON);
    }
    return ContentService
      .createTextOutput(JSON.stringify({ mode: 'config', pricing: cfg, extras: getExtrasConfig() }))
      .setMimeType(ContentService.MimeType.JSON);
  }

  // Public settings endpoint — used by website pages on load to know which
  // booking mode to display. Non-secret booleans only; no auth required.
  if (action === 'get_settings') {
    const s = getBookingSettings();
    return ContentService
      .createTextOutput(JSON.stringify({
        directBookingStay: !!s.directBookingStay,
        directBookingCourse: !!s.directBookingCourse,
        permaculturePhones: getPermaculturePhones(),
      }))
      .setMimeType(ContentService.MimeType.JSON);
  }

  const rowId = parseInt(e.parameter.id);
  const token = e.parameter.token;

  if (!action || !rowId || !token) {
    return HtmlService.createHtmlOutput(errorPage('Invalid or missing parameters.')).setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
  }

  // Verify token
  const sheet = getSheet();
  const storedToken = sheet.getRange(rowId, getColIndex('Token')).getValue();
  if (token !== storedToken) {
    return HtmlService.createHtmlOutput(errorPage('Invalid or expired link.')).setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
  }

  const currentStatus = sheet.getRange(rowId, getColIndex('Status')).getValue();

  // Route based on action + valid status
  if (action === 'accept' && currentStatus === 'Pending') {
    return handleAccept(sheet, rowId);
  } else if (action === 'decline' && (currentStatus === 'Pending' || currentStatus === 'Awaiting Payment' || currentStatus === 'Awaiting Confirmation')) {
    return handleDecline(sheet, rowId);
  } else if (action === 'accept_confirm' && currentStatus === 'Pending') {
    return handleAcceptConfirm(sheet, rowId, e.parameter);
  } else if (action === 'decline_confirm' && (currentStatus === 'Pending' || currentStatus === 'Awaiting Payment' || currentStatus === 'Awaiting Confirmation')) {
    return handleDeclineConfirm(sheet, rowId, e.parameter);
  } else if (action === 'confirm_payment' && (currentStatus === 'Awaiting Payment' || currentStatus === 'Awaiting Confirmation')) {
    return handleConfirmPayment(sheet, rowId);
  } else if (action === 'confirm_payment_final' && (currentStatus === 'Awaiting Payment' || currentStatus === 'Awaiting Confirmation')) {
    return handleConfirmPaymentFinal(sheet, rowId, e.parameter);
  } else if (action === 'expire_booking' && (currentStatus === 'Awaiting Payment' || currentStatus === 'Awaiting Confirmation')) {
    return handleExpireBooking(sheet, rowId);
  } else if (action === 'expire_confirm' && (currentStatus === 'Awaiting Payment' || currentStatus === 'Awaiting Confirmation')) {
    return handleExpireConfirm(sheet, rowId);
  } else if (action === 'guest_manage') {
    // Guest self-service page — available for Confirmed bookings (and Awaiting Payment as view-only)
    return buildGuestManagePage(sheet, rowId);
  } else if (action === 'guest_change_form') {
    return buildGuestChangeRequestForm(sheet, rowId);
  }

  return HtmlService.createHtmlOutput(alreadyHandledPage(currentStatus)).setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
}

// ===== SERVER-SIDE FORM HANDLER (called via google.script.run) =====
function processFormSubmission(formData) {
  const sheet = getSheet();
  const rowId = parseInt(formData.id);
  const token = formData.token;
  const action = formData.action;

  // Verify token
  const storedToken = sheet.getRange(rowId, getColIndex('Token')).getValue();
  if (token !== storedToken) {
    throw new Error('Invalid or expired link.');
  }

  if (action === 'accept_confirm') {
    const data = getBookingData(sheet, rowId);
    const finalTotal = formData.finalTotal || calculateTotal(data);
    const customMessage = formData.customMessage || '';
    const scriptUrl = CONFIG.SCRIPT_URL;
    const tkn = sheet.getRange(rowId, getColIndex('Token')).getValue();

    sheet.getRange(rowId, getColIndex('Status')).setValue('Awaiting Payment');
    sheet.getRange(rowId, getColIndex('Status')).setBackground('#d4edda');
    sheet.getRange(rowId, getColIndex('Final Total')).setValue(finalTotal);
    sheet.getRange(rowId, getColIndex('Responded')).setValue(new Date());

    // Generate Stripe payment link
    let stripeUrl = '';
    try {
      stripeUrl = createStripeCheckoutSession(data, finalTotal, data.id);
    } catch (err) {
      Logger.log('Stripe checkout creation failed: ' + err.toString());
    }

    sendGuestConditionalAcceptance(data, finalTotal, customMessage, stripeUrl);
    sendHostPaymentReminder(data, finalTotal, rowId, tkn);
    return 'ok';

  } else if (action === 'decline_confirm') {
    const data = getBookingData(sheet, rowId);
    const declineMessage = formData.declineMessage || '';
    sheet.getRange(rowId, getColIndex('Status')).setValue('Declined');
    sheet.getRange(rowId, getColIndex('Responded')).setValue(new Date());
    sendGuestDecline(data, declineMessage);
    return 'ok';

  } else if (action === 'confirm_payment_final') {
    const data = getBookingData(sheet, rowId);
    const paymentMethod = formData.paymentMethod || 'e-Transfer';
    const checkinInstructions = formData.checkinInstructions || '';
    const confirmMessage = formData.confirmMessage || '';
    sheet.getRange(rowId, getColIndex('Status')).setValue('Confirmed');
    sheet.getRange(rowId, getColIndex('Status')).setBackground('#28a745').setFontColor('#fff');
    sheet.getRange(rowId, getColIndex('Payment Method')).setValue(paymentMethod);
    sheet.getRange(rowId, getColIndex('Payment Confirmed')).setValue(new Date());
    sendGuestFinalConfirmation(data, checkinInstructions, confirmMessage, paymentMethod);
    return 'ok';

  } else if (action === 'expire_confirm') {
    const data = getBookingData(sheet, rowId);
    sheet.getRange(rowId, getColIndex('Status')).setValue('Expired');
    sheet.getRange(rowId, getColIndex('Status')).setBackground('#ffc107');
    sheet.getRange(rowId, getColIndex('Payment Confirmed')).setValue('Not received');
    sendGuestExpired(data);
    return 'ok';

  } else if (action === 'guest_cancel_submit') {
    return handleGuestCancelSubmit(sheet, rowId);

  } else if (action === 'guest_change_submit') {
    return handleGuestChangeSubmit(sheet, rowId, formData);
  }

  throw new Error('Unknown action: ' + action);
}

// ===== ACCEPT / DECLINE HANDLERS =====

function handleAccept(sheet, rowId) {
  const data = getBookingData(sheet, rowId);
  const total = calculateTotal(data);
  const scriptUrl = CONFIG.SCRIPT_URL;
  const token = sheet.getRange(rowId, getColIndex('Token')).getValue();

  const html = `<!DOCTYPE html>
<html><head>
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; max-width: 600px; margin: 40px auto; padding: 20px; color: #1a1a1a; }
  h1 { color: #3d8c40; font-size: 24px; }
  .summary { background: #f9f9f6; border: 1px solid #e0ddd6; border-radius: 8px; padding: 20px; margin: 20px 0; }
  .row { display: flex; justify-content: space-between; padding: 6px 0; border-bottom: 1px solid #eee; }
  .row:last-child { border: none; font-weight: 600; }
  label { display: block; font-weight: 500; margin: 16px 0 4px; }
  textarea { width: 100%; padding: 10px; border: 1px solid #ddd; border-radius: 6px; font-size: 14px; min-height: 80px; box-sizing: border-box; }
  .btn { background: #3d8c40; color: #fff; border: none; border-radius: 50px; padding: 14px 36px; font-size: 14px; cursor: pointer; margin-top: 20px; }
  .btn:hover { background: #2e6e31; }
</style>
</head><body>
  <h1>Accept Booking</h1>
  <div class="summary">
    <div class="row"><span>Guest</span><span>${data.firstName} ${data.lastName}</span></div>
    <div class="row"><span>Email</span><span>${data.email}</span></div>
    <div class="row"><span>Check-in</span><span>${data.checkin}</span></div>
    <div class="row"><span>Checkout</span><span>${data.checkout}</span></div>
    ${guestRowsHtml(data)}
    <div class="row"><span>Pets</span><span>${data.pets || 0}</span></div>
    <div class="row"><span>Estimated Total</span><span>$${total.toLocaleString()} CAD (HST incl.)</span></div>
  </div>
  <form id="actionForm">
    <label>Final total (CAD, HST included):</label>
    <input type="text" id="finalTotal" value="${total}" style="width:100%; padding:10px; border:1px solid #ddd; border-radius:6px; font-size:14px; box-sizing:border-box;">
    <label>Personal message to guest (optional):</label>
    <textarea id="customMessage" placeholder="E.g., Looking forward to hosting you! The hot tub will be ready..."></textarea>
    <br>
    <button type="submit" class="btn">Confirm & Send Acceptance Email</button>
  </form>
  <script>
  document.getElementById('actionForm').addEventListener('submit', function(e) {
    e.preventDefault();
    var btn = this.querySelector('button');
    btn.disabled = true;
    btn.textContent = 'Processing...';
    var formData = {
      action: 'accept_confirm',
      id: '${rowId}',
      token: '${token}',
      finalTotal: document.getElementById('finalTotal').value,
      customMessage: document.getElementById('customMessage').value
    };
    google.script.run
      .withSuccessHandler(function() {
        document.body.innerHTML = '<div style="max-width:500px;margin:80px auto;padding:20px;text-align:center;font-family:-apple-system,sans-serif;"><div style="font-size:48px;margin-bottom:16px;">📨</div><h1 style="color:#3d8c40;">Payment Instructions Sent!</h1><p style="color:#555;line-height:1.6;">The guest has been sent payment instructions. You will receive a separate email with <strong>Confirm Payment</strong> and <strong>Release Dates</strong> links.</p><p style="font-size:14px;color:#888;margin-top:24px;">You can close this tab.</p></div>';
      })
      .withFailureHandler(function(err) {
        btn.disabled = false;
        btn.textContent = 'Confirm & Send Acceptance Email';
        alert('Error: ' + err.message + '. Please try again.');
      })
      .processFormSubmission(formData);
  });
  </script>
</body></html>`;

  return HtmlService.createHtmlOutput(html).setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
}

function handleAcceptConfirm(sheet, rowId, params) {
  const data = getBookingData(sheet, rowId);
  const finalTotal = params.finalTotal || calculateTotal(data);
  const customMessage = params.customMessage || '';
  const token = sheet.getRange(rowId, getColIndex('Token')).getValue();
  const scriptUrl = CONFIG.SCRIPT_URL;

  // Update sheet — status is now "Awaiting Payment" (not confirmed yet)
  sheet.getRange(rowId, getColIndex('Status')).setValue('Awaiting Payment');
  sheet.getRange(rowId, getColIndex('Status')).setBackground('#d4edda');
  sheet.getRange(rowId, getColIndex('Final Total')).setValue(finalTotal);
  sheet.getRange(rowId, getColIndex('Responded')).setValue(new Date());

  // Send guest the conditional acceptance with payment instructions
  sendGuestConditionalAcceptance(data, finalTotal, customMessage);

  // Build confirm-payment and expire links for the host
  const confirmPaymentUrl = `${scriptUrl}?action=confirm_payment&id=${rowId}&token=${token}`;
  const expireUrl = `${scriptUrl}?action=expire_booking&id=${rowId}&token=${token}`;

  // Send host a follow-up email with Confirm Payment / Expire links
  sendHostPaymentReminder(data, finalTotal, rowId, token);

  const html = `<!DOCTYPE html>
<html><head>
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; max-width: 560px; margin: 40px auto; padding: 20px; color: #1a1a1a; }
  .check { font-size: 48px; margin-bottom: 16px; text-align: center; }
  h1 { color: #3d8c40; text-align: center; }
  p { color: #555; line-height: 1.6; text-align: center; }
  .next-steps { background: #f9f9f6; border: 1px solid #e0ddd6; border-radius: 8px; padding: 20px; margin: 24px 0; text-align: left; }
  .next-steps h3 { margin: 0 0 12px; font-size: 15px; }
  .next-steps ol { margin: 0; padding-left: 20px; }
  .next-steps li { margin-bottom: 8px; font-size: 14px; line-height: 1.6; }
  .actions { text-align: center; margin: 28px 0; }
  .btn-confirm { display: inline-block; background: #3d8c40; color: #fff; padding: 14px 36px; border-radius: 50px; text-decoration: none; font-weight: 500; font-size: 14px; margin-right: 12px; }
  .btn-expire { display: inline-block; background: #fff; color: #888; padding: 14px 36px; border-radius: 50px; text-decoration: none; font-weight: 500; font-size: 14px; border: 1px solid #ccc; }
</style>
</head><body>
  <div class="check">📨</div>
  <h1>Payment Instructions Sent</h1>
  <p><strong>${data.firstName} ${data.lastName}</strong> has been sent payment instructions for <strong>$${Number(finalTotal).toLocaleString('en-CA', {minimumFractionDigits: 2, maximumFractionDigits: 2})} CAD</strong>.</p>
  <p>The booking is <strong>not confirmed</strong> until you verify payment has been received.</p>

  <div class="next-steps">
    <h3>What happens next:</h3>
    <ol>
      <li>Guest sends payment via Interac e-Transfer or requests a credit card link</li>
      <li>You verify the payment landed in your account</li>
      <li>Click <strong>Confirm Payment</strong> below (or from the email you'll receive)</li>
      <li>Guest gets their final confirmation with check-in details</li>
    </ol>
  </div>

  <div class="actions">
    <a href="${confirmPaymentUrl}" class="btn-confirm">Confirm Payment Received</a>
    <a href="${expireUrl}" class="btn-expire">Payment Not Received — Release Dates</a>
  </div>

  <p style="font-size: 13px; color: #888; margin-top: 24px;">You'll also receive an email with these links. The spreadsheet status is now "Awaiting Payment."</p>
</body></html>`;

  return HtmlService.createHtmlOutput(html).setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
}

function handleDecline(sheet, rowId) {
  const data = getBookingData(sheet, rowId);
  const scriptUrl = CONFIG.SCRIPT_URL;
  const token = sheet.getRange(rowId, getColIndex('Token')).getValue();

  const html = `<!DOCTYPE html>
<html><head>
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; max-width: 600px; margin: 40px auto; padding: 20px; color: #1a1a1a; }
  h1 { color: #c0392b; font-size: 24px; }
  .summary { background: #fef9f8; border: 1px solid #f0d6d3; border-radius: 8px; padding: 20px; margin: 20px 0; }
  .row { display: flex; justify-content: space-between; padding: 6px 0; border-bottom: 1px solid #eee; }
  .row:last-child { border: none; }
  label { display: block; font-weight: 500; margin: 16px 0 4px; }
  textarea { width: 100%; padding: 10px; border: 1px solid #ddd; border-radius: 6px; font-size: 14px; min-height: 80px; box-sizing: border-box; }
  .btn { background: #c0392b; color: #fff; border: none; border-radius: 50px; padding: 14px 36px; font-size: 14px; cursor: pointer; margin-top: 20px; }
  .btn:hover { background: #a93226; }
</style>
</head><body>
  <h1>Decline Booking</h1>
  <div class="summary">
    <div class="row"><span>Guest</span><span>${data.firstName} ${data.lastName}</span></div>
    <div class="row"><span>Dates</span><span>${data.checkin} → ${data.checkout}</span></div>
    ${guestRowsHtml(data)}
  </div>
  <form id="actionForm">
    <label>Reason / message to guest (optional):</label>
    <textarea id="declineMessage" placeholder="E.g., Unfortunately those dates are already booked. Would love to host you another time!"></textarea>
    <br>
    <button type="submit" class="btn">Confirm & Send Decline Email</button>
  </form>
  <script>
  document.getElementById('actionForm').addEventListener('submit', function(e) {
    e.preventDefault();
    var btn = this.querySelector('button');
    btn.disabled = true;
    btn.textContent = 'Processing...';
    var formData = {
      action: 'decline_confirm',
      id: '${rowId}',
      token: '${token}',
      declineMessage: document.getElementById('declineMessage').value
    };
    google.script.run
      .withSuccessHandler(function() {
        document.body.innerHTML = '<div style="max-width:500px;margin:80px auto;padding:20px;text-align:center;font-family:-apple-system,sans-serif;"><h1 style="color:#c0392b;">Booking Declined</h1><p style="color:#555;line-height:1.6;">The guest has been notified and the spreadsheet has been updated.</p><p style="font-size:14px;color:#888;margin-top:24px;">You can close this tab.</p></div>';
      })
      .withFailureHandler(function(err) {
        btn.disabled = false;
        btn.textContent = 'Confirm & Send Decline Email';
        alert('Error: ' + err.message + '. Please try again.');
      })
      .processFormSubmission(formData);
  });
  </script>
</body></html>`;

  return HtmlService.createHtmlOutput(html).setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
}

function handleDeclineConfirm(sheet, rowId, params) {
  const data = getBookingData(sheet, rowId);
  const declineMessage = params.declineMessage || '';

  // Update sheet
  sheet.getRange(rowId, getColIndex('Status')).setValue('Declined');
  sheet.getRange(rowId, getColIndex('Responded')).setValue(new Date());

  // Send guest decline email
  sendGuestDecline(data, declineMessage);

  const html = `<!DOCTYPE html>
<html><head>
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; max-width: 500px; margin: 80px auto; padding: 20px; text-align: center; color: #1a1a1a; }
  h1 { color: #c0392b; }
  p { color: #555; line-height: 1.6; }
</style>
</head><body>
  <h1>Booking Declined</h1>
  <p><strong>${data.firstName} ${data.lastName}</strong> has been notified. The spreadsheet has been updated.</p>
  <p style="margin-top: 24px; font-size: 14px; color: #888;">You can close this tab.</p>
</body></html>`;

  return HtmlService.createHtmlOutput(html).setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
}

// ===== CONFIRM PAYMENT HANDLERS =====

function handleConfirmPayment(sheet, rowId) {
  const data = getBookingData(sheet, rowId);
  const scriptUrl = CONFIG.SCRIPT_URL;
  const token = sheet.getRange(rowId, getColIndex('Token')).getValue();

  const html = `<!DOCTYPE html>
<html><head>
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; max-width: 600px; margin: 40px auto; padding: 20px; color: #1a1a1a; }
  h1 { color: #3d8c40; font-size: 24px; }
  .summary { background: #f9f9f6; border: 1px solid #e0ddd6; border-radius: 8px; padding: 20px; margin: 20px 0; }
  .row { display: flex; justify-content: space-between; padding: 6px 0; border-bottom: 1px solid #eee; }
  .row:last-child { border: none; font-weight: 600; }
  label { display: block; font-weight: 500; margin: 16px 0 4px; }
  input, textarea { width: 100%; padding: 10px; border: 1px solid #ddd; border-radius: 6px; font-size: 14px; box-sizing: border-box; }
  textarea { min-height: 80px; }
  .btn { background: #3d8c40; color: #fff; border: none; border-radius: 50px; padding: 14px 36px; font-size: 14px; cursor: pointer; margin-top: 20px; }
  .btn:hover { background: #2e6e31; }
  .warning { background: #fff3cd; border: 1px solid #ffc107; border-radius: 8px; padding: 16px; margin: 20px 0; font-size: 14px; }
</style>
</head><body>
  <h1>Confirm Payment Received</h1>
  <div class="warning">
    <strong>This will finalize the booking.</strong> Only confirm once you've verified the payment has landed in your account.
  </div>
  <div class="summary">
    <div class="row"><span>Guest</span><span>${data.firstName} ${data.lastName}</span></div>
    <div class="row"><span>Email</span><span>${data.email}</span></div>
    <div class="row"><span>Check-in</span><span>${data.checkin}</span></div>
    <div class="row"><span>Checkout</span><span>${data.checkout}</span></div>
    ${guestRowsHtml(data)}
    <div class="row"><span>Pets</span><span>${data.pets || 0}</span></div>
    <div class="row"><span>Amount Due</span><span>$${Number(data.finalTotal).toLocaleString('en-CA', {minimumFractionDigits: 2, maximumFractionDigits: 2})} CAD</span></div>
  </div>
  <form id="actionForm">
    <label>Payment method received:</label>
    <select id="paymentMethod" style="width:100%; padding:10px; border:1px solid #ddd; border-radius:6px; font-size:14px;">
      <option value="e-Transfer">Interac e-Transfer</option>
      <option value="Credit Card">Credit Card (Visa/MC/AMEX)</option>
      <option value="Other">Other</option>
    </select>
    <label>Check-in instructions for the guest:</label>
    <textarea id="checkinInstructions" placeholder="E.g., The lockbox code is 1234. Park in the main driveway. The key is inside the front door lockbox...">The lockbox code will be shared 24 hours before your check-in. Park in the main gravel driveway. Please remove shoes inside.</textarea>
    <label>Additional message (optional):</label>
    <textarea id="confirmMessage" placeholder="E.g., We're all set! Looking forward to having you..."></textarea>
    <br>
    <button type="submit" class="btn">Confirm Payment & Send Final Booking Confirmation</button>
  </form>
  <script>
  document.getElementById('actionForm').addEventListener('submit', function(e) {
    e.preventDefault();
    var btn = this.querySelector('button');
    btn.disabled = true;
    btn.textContent = 'Processing...';
    var formData = {
      action: 'confirm_payment_final',
      id: '${rowId}',
      token: '${token}',
      paymentMethod: document.getElementById('paymentMethod').value,
      checkinInstructions: document.getElementById('checkinInstructions').value,
      confirmMessage: document.getElementById('confirmMessage').value
    };
    google.script.run
      .withSuccessHandler(function() {
        document.body.innerHTML = '<div style="max-width:500px;margin:80px auto;padding:20px;text-align:center;font-family:-apple-system,sans-serif;"><div style="font-size:48px;margin-bottom:16px;">✅</div><h1 style="color:#3d8c40;">Booking Confirmed!</h1><p style="color:#555;line-height:1.6;">The guest has been sent their final confirmation with check-in instructions. The spreadsheet status is now "Confirmed."</p><p style="font-size:14px;color:#888;margin-top:24px;">You can close this tab.</p></div>';
      })
      .withFailureHandler(function(err) {
        btn.disabled = false;
        btn.textContent = 'Confirm Payment & Send Final Booking Confirmation';
        alert('Error: ' + err.message + '. Please try again.');
      })
      .processFormSubmission(formData);
  });
  </script>
</body></html>`;

  return HtmlService.createHtmlOutput(html).setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
}

function handleConfirmPaymentFinal(sheet, rowId, params) {
  const data = getBookingData(sheet, rowId);
  const paymentMethod = params.paymentMethod || 'e-Transfer';
  const checkinInstructions = params.checkinInstructions || '';
  const confirmMessage = params.confirmMessage || '';

  // Update sheet — NOW the booking is truly confirmed
  sheet.getRange(rowId, getColIndex('Status')).setValue('Confirmed');
  sheet.getRange(rowId, getColIndex('Status')).setBackground('#28a745').setFontColor('#fff');
  sheet.getRange(rowId, getColIndex('Payment Method')).setValue(paymentMethod);
  sheet.getRange(rowId, getColIndex('Payment Confirmed')).setValue(new Date());

  // Send guest the FINAL confirmation with check-in details
  sendGuestFinalConfirmation(data, checkinInstructions, confirmMessage, paymentMethod);

  const html = `<!DOCTYPE html>
<html><head>
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; max-width: 500px; margin: 80px auto; padding: 20px; text-align: center; color: #1a1a1a; }
  .check { font-size: 48px; margin-bottom: 16px; }
  h1 { color: #3d8c40; }
  p { color: #555; line-height: 1.6; }
</style>
</head><body>
  <div class="check">✅</div>
  <h1>Booking Confirmed!</h1>
  <p><strong>${data.firstName} ${data.lastName}</strong> has been sent their final confirmation with check-in instructions.</p>
  <p style="margin-top: 12px;"><strong>${data.checkin} → ${data.checkout}</strong> &middot; ${formatGuestSummary(data)} &middot; $${Number(data.finalTotal).toLocaleString('en-CA', {minimumFractionDigits: 2, maximumFractionDigits: 2})} CAD via ${paymentMethod}</p>
  <p style="margin-top: 24px; font-size: 14px; color: #888;">The spreadsheet status is now "Confirmed." You can close this tab.</p>
</body></html>`;

  return HtmlService.createHtmlOutput(html).setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
}

// ===== EXPIRE BOOKING HANDLERS =====

function handleExpireBooking(sheet, rowId) {
  const data = getBookingData(sheet, rowId);
  const scriptUrl = CONFIG.SCRIPT_URL;
  const token = sheet.getRange(rowId, getColIndex('Token')).getValue();

  const html = `<!DOCTYPE html>
<html><head>
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; max-width: 600px; margin: 40px auto; padding: 20px; color: #1a1a1a; }
  h1 { color: #e67e22; font-size: 24px; }
  .summary { background: #fef9f4; border: 1px solid #f5dcc0; border-radius: 8px; padding: 20px; margin: 20px 0; }
  .row { display: flex; justify-content: space-between; padding: 6px 0; }
  label { display: block; font-weight: 500; margin: 16px 0 4px; }
  textarea { width: 100%; padding: 10px; border: 1px solid #ddd; border-radius: 6px; font-size: 14px; min-height: 80px; box-sizing: border-box; }
  .btn { background: #e67e22; color: #fff; border: none; border-radius: 50px; padding: 14px 36px; font-size: 14px; cursor: pointer; margin-top: 20px; }
  .btn:hover { background: #cf6d17; }
</style>
</head><body>
  <h1>Release Dates — Payment Not Received</h1>
  <div class="summary">
    <div class="row"><span>Guest</span><span>${data.firstName} ${data.lastName}</span></div>
    <div class="row"><span>Dates</span><span>${data.checkin} → ${data.checkout}</span></div>
    <div class="row"><span>Amount Due</span><span>$${Number(data.finalTotal).toLocaleString('en-CA', {minimumFractionDigits: 2, maximumFractionDigits: 2})} CAD</span></div>
  </div>
  <p>This will mark the booking as expired and notify the guest that their hold has been released because payment was not received.</p>
  <form id="actionForm">
    <label>Message to guest (optional):</label>
    <textarea id="expireMessage" placeholder="E.g., We didn't receive payment within the 48-hour window, so the dates have been released. If you're still interested, feel free to submit a new request!"></textarea>
    <br>
    <button type="submit" class="btn">Release Dates & Notify Guest</button>
  </form>
  <script>
  document.getElementById('actionForm').addEventListener('submit', function(e) {
    e.preventDefault();
    var btn = this.querySelector('button');
    btn.disabled = true;
    btn.textContent = 'Processing...';
    var formData = {
      action: 'expire_confirm',
      id: '${rowId}',
      token: '${token}',
      expireMessage: document.getElementById('expireMessage').value
    };
    google.script.run
      .withSuccessHandler(function() {
        document.body.innerHTML = '<div style="max-width:500px;margin:80px auto;padding:20px;text-align:center;font-family:-apple-system,sans-serif;"><h1 style="color:#e67e22;">Dates Released</h1><p style="color:#555;line-height:1.6;">The guest has been notified that their booking hold has expired. The dates are now available for other guests.</p><p style="font-size:14px;color:#888;margin-top:24px;">You can close this tab.</p></div>';
      })
      .withFailureHandler(function(err) {
        btn.disabled = false;
        btn.textContent = 'Release Dates & Notify Guest';
        alert('Error: ' + err.message + '. Please try again.');
      })
      .processFormSubmission(formData);
  });
  </script>
</body></html>`;

  return HtmlService.createHtmlOutput(html).setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
}

function handleExpireConfirm(sheet, rowId) {
  // Note: params come from e.parameter in doGet, but we access via sheet
  const data = getBookingData(sheet, rowId);

  // Update sheet
  sheet.getRange(rowId, getColIndex('Status')).setValue('Expired');
  sheet.getRange(rowId, getColIndex('Status')).setBackground('#ffc107');
  sheet.getRange(rowId, getColIndex('Payment Confirmed')).setValue('Not received');

  // Send guest expiry notice
  sendGuestExpired(data);

  const html = `<!DOCTYPE html>
<html><head>
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; max-width: 500px; margin: 80px auto; padding: 20px; text-align: center; color: #1a1a1a; }
  h1 { color: #e67e22; }
  p { color: #555; line-height: 1.6; }
</style>
</head><body>
  <h1>Dates Released</h1>
  <p><strong>${data.firstName} ${data.lastName}</strong> has been notified that their booking hold for <strong>${data.checkin} → ${data.checkout}</strong> has expired.</p>
  <p style="margin-top: 24px; font-size: 14px; color: #888;">The dates are now available for other guests. Spreadsheet updated.</p>
</body></html>`;

  return HtmlService.createHtmlOutput(html).setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
}

// ===== STRIPE CALLBACK HANDLERS =====

function handleStripeSuccess(params) {
  // For direct bookings, the success_url includes booking_id + session_id so we can:
  //   1. Verify with Stripe that the session was actually paid
  //   2. Flag the matching row as "Stripe (received)" to nudge the host to verify + Mark Paid
  // For legacy bookings (Stripe link sent from email), neither param is present and we just
  // fall back to the original generic notification.
  const bookingId = params && params.booking_id ? String(params.booking_id) : '';
  const sessionId = params && params.session_id ? String(params.session_id) : '';
  let verifiedAmount = '';
  let stripeOk = false;

  if (sessionId && CONFIG.STRIPE_SECRET_KEY) {
    try {
      const resp = UrlFetchApp.fetch(
        'https://api.stripe.com/v1/checkout/sessions/' + encodeURIComponent(sessionId),
        {
          method: 'get',
          headers: { 'Authorization': 'Bearer ' + CONFIG.STRIPE_SECRET_KEY },
          muteHttpExceptions: true,
        }
      );
      const sess = JSON.parse(resp.getContentText());
      if (sess && sess.payment_status === 'paid') {
        stripeOk = true;
        if (typeof sess.amount_total === 'number') {
          verifiedAmount = (sess.amount_total / 100).toFixed(2);
        }
      } else {
        Logger.log('Stripe session not paid: ' + JSON.stringify(sess && sess.payment_status));
      }
    } catch (err) {
      Logger.log('Stripe verify error: ' + err.toString());
    }
  }

  // Try to flag the matching row in the sheet so the admin sees the payment came through
  let flaggedRowId = null;
  if (bookingId) {
    try {
      const sheet = getSheet();
      const lastRow = sheet.getLastRow();
      if (lastRow >= 2) {
        const ids = sheet.getRange(2, getColIndex('ID'), lastRow - 1, 1).getValues();
        for (let i = 0; i < ids.length; i++) {
          if (String(ids[i][0]) === bookingId) {
            flaggedRowId = i + 2;
            const newPaymentMethod = stripeOk ? 'Stripe (received)' : 'Stripe (claimed)';
            sheet.getRange(flaggedRowId, getColIndex('Payment Method')).setValue(newPaymentMethod);
            break;
          }
        }
      }
    } catch (err) {
      Logger.log('Stripe row-flag error: ' + err.toString());
    }
  }

  // Host email — tighter when we verified via Stripe API, generic otherwise
  try {
    const headlineSuffix = stripeOk ? ' ✓ verified' : '';
    const verifyLine = stripeOk
      ? 'We verified the charge against the Stripe API (payment_status = paid' + (verifiedAmount ? ', amount $' + verifiedAmount : '') + ').'
      : 'A guest reports they completed Stripe checkout. Verify the charge in your Stripe Dashboard before clicking Mark Paid.';
    const rowLine = flaggedRowId ? `<p style="font-size:14px;color:#555;">Booking <strong>${bookingId}</strong> is in row ${flaggedRowId} of the Bookings sheet.</p>` : '';

    MailApp.sendEmail({
      to: CONFIG.HOST_EMAIL,
      subject: '💳 Stripe Payment Received' + headlineSuffix + ' — ' + (bookingId ? bookingId + ' · ' : '') + 'click Mark Paid in admin',
      htmlBody: `<div style="font-family:-apple-system,sans-serif;max-width:560px;margin:0 auto;color:#1a1a1a;">
        <div style="background:#3d8c40;padding:24px 32px;"><h1 style="color:#fff;font-size:18px;margin:0;">Payment Received via Stripe${headlineSuffix}</h1></div>
        <div style="padding:32px;background:#fff;">
          <p style="font-size:16px;line-height:1.7;">${verifyLine}</p>
          <p style="font-size:16px;line-height:1.7;">Open the <a href="${CONFIG.SCRIPT_URL}?action=admin">admin dashboard</a> and click <strong>Mark Paid</strong> on the matching booking — that sends the welcome email + check-in instructions to the guest.</p>
          ${rowLine}
          <p style="font-size:13px;color:#888;margin-top:24px;">Stripe Dashboard: <a href="https://dashboard.stripe.com/payments">https://dashboard.stripe.com/payments</a></p>
        </div></div>`,
      name: 'SFF Booking System',
    });
  } catch (err) {
    Logger.log('Email error on stripe success: ' + err.toString());
  }

  const html = '<!DOCTYPE html><html><head><meta name="viewport" content="width=device-width, initial-scale=1"><style>body{font-family:-apple-system,BlinkMacSystemFont,sans-serif;max-width:500px;margin:80px auto;padding:20px;text-align:center;color:#1a1a1a;}.check{font-size:48px;margin-bottom:16px;}h1{color:#3d8c40;}p{color:#555;line-height:1.6;}</style></head><body><div class="check">✅</div><h1>Payment Received!</h1><p>Thank you! Your payment has been received. ' + CONFIG.HOST_NAME + ' will send you a final confirmation with check-in details shortly.</p><p style="margin-top:24px;font-size:14px;color:#888;">You can close this tab. Questions? Email <a href="mailto:' + CONFIG.HOST_EMAIL + '">' + CONFIG.HOST_EMAIL + '</a></p></body></html>';

  return HtmlService.createHtmlOutput(html).setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
}

function stripeCancelPage() {
  return `<!DOCTYPE html>
<html><head>
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; max-width: 500px; margin: 80px auto; padding: 20px; text-align: center; color: #1a1a1a; }
  h1 { color: #e67e22; }
  p { color: #555; line-height: 1.6; }
</style>
</head><body>
  <h1>Payment Cancelled</h1>
  <p>No worries — your payment was not processed. You can return to the payment link in your email to try again, or use Interac e-Transfer instead.</p>
  <p style="margin-top: 16px;">Questions? Email <a href="mailto:${CONFIG.HOST_EMAIL}">${CONFIG.HOST_EMAIL}</a></p>
</body></html>`;
}

// ===== AIRBNB ICAL PROXY =====
function proxyAirbnbCalendar() {
  try {
    const icalUrl = 'https://www.airbnb.ca/calendar/ical/1616735096393630004.ics?t=484c63ee55484b46b22f9877233147f1';
    const response = UrlFetchApp.fetch(icalUrl, { muteHttpExceptions: true });
    const icalText = response.getContentText();
    return ContentService.createTextOutput(icalText)
      .setMimeType(ContentService.MimeType.TEXT);
  } catch (err) {
    Logger.log('iCal proxy error: ' + err.toString());
    return ContentService.createTextOutput('ERROR: ' + err.toString())
      .setMimeType(ContentService.MimeType.TEXT);
  }
}

// Export confirmed/pending direct bookings as an iCal feed, so Airbnb (and other channels)
// can poll it and block those dates on their side. Prevents double-booking.
// Published at: <SCRIPT_URL>?action=bookings_ics
//
// Includes every booking with status in {Pending, Awaiting Payment, Awaiting Confirmation, Confirmed}.
// - Pending: block optimistically while host decides (avoids double-booking while reviewing).
// - Awaiting Payment / Awaiting Confirmation / Confirmed: definitely blocked.
// - Declined / Expired: excluded.
//
// iCal spec: DTEND is the first day that becomes available again (= check-out date),
// so a checkin of May 1 with 3 nights → DTSTART 20260501, DTEND 20260504.
function generateBookingsICal(opts) {
  try {
    opts = opts || {};
    const sheet = getSheet();
    const lastRow = sheet.getLastRow();
    // SAFETY: when called as the public Airbnb-facing feed (forAirbnb=true) AND we're
    // in TEST mode, return an empty calendar. This stops test bookings from blocking
    // dates on Airbnb. The host's personal feed (forAirbnb=false) always shows everything.
    const isAirbnbFeed = !!opts.forAirbnb;
    const blockingStatuses = isAirbnbFeed
      ? { 'Confirmed': true }                                                                          // Airbnb: only Confirmed
      : { 'Pending': true, 'Awaiting Payment': true, 'Awaiting Confirmation': true, 'Confirmed': true }; // Host calendar: everything in-flight

    // Fold long text lines per RFC 5545 (>75 chars)
    const fold = (line) => {
      if (line.length <= 73) return line;
      let out = line.slice(0, 73);
      let rest = line.slice(73);
      while (rest.length > 72) {
        out += '\r\n ' + rest.slice(0, 72);
        rest = rest.slice(72);
      }
      if (rest.length) out += '\r\n ' + rest;
      return out;
    };

    const icsLines = [];
    icsLines.push('BEGIN:VCALENDAR');
    icsLines.push('VERSION:2.0');
    icsLines.push('PRODID:-//Straight Fin Farms//Direct Bookings//EN');
    icsLines.push('CALSCALE:GREGORIAN');
    icsLines.push('METHOD:PUBLISH');
    icsLines.push(fold('X-WR-CALNAME:Straight Fin Farms — ' + (isAirbnbFeed ? 'Airbnb Sync' : 'Direct Bookings')));
    icsLines.push('X-WR-TIMEZONE:America/Toronto');

    const stampNow = Utilities.formatDate(new Date(), 'UTC', "yyyyMMdd'T'HHmmss'Z'");

    // Mode gate: Airbnb-facing feed is empty in TEST so we never accidentally block
    // Airbnb dates with stub test bookings.
    const liveMode = isLiveMode();
    const skipAllEvents = isAirbnbFeed && !liveMode;

    if (lastRow >= 2 && !skipAllEvents) {
      const data = sheet.getRange(2, 1, lastRow - 1, 23).getValues();
      for (let i = 0; i < data.length; i++) {
        const row = data[i];
        const id = row[0];
        const status = row[2];
        const checkin = row[7];
        const checkout = row[8];

        if (!blockingStatuses[status]) continue;
        if (!checkin || !checkout) continue;

        const dtstart = formatDateForICal(checkin);
        const dtend = formatDateForICal(checkout);
        if (!dtstart || !dtend) continue;

        icsLines.push('BEGIN:VEVENT');
        icsLines.push('UID:booking-' + id + '@straightfinfarms.com');
        icsLines.push('DTSTAMP:' + stampNow);
        icsLines.push('DTSTART;VALUE=DATE:' + dtstart);
        icsLines.push('DTEND;VALUE=DATE:' + dtend);
        icsLines.push('SUMMARY:' + (status === 'Confirmed' ? 'Confirmed booking' : (status === 'Awaiting Payment' ? 'Awaiting payment' : (status === 'Awaiting Confirmation' ? 'Awaiting confirmation' : 'Pending request'))));
        icsLines.push('STATUS:' + (status === 'Confirmed' ? 'CONFIRMED' : 'TENTATIVE'));
        icsLines.push('TRANSP:OPAQUE');
        icsLines.push('END:VEVENT');
      }
    }

    icsLines.push('END:VCALENDAR');
    const ics = icsLines.join('\r\n') + '\r\n';

    return ContentService.createTextOutput(ics)
      .setMimeType(ContentService.MimeType.ICAL);
  } catch (err) {
    Logger.log('bookings_ics error: ' + err.toString());
    return ContentService.createTextOutput('ERROR: ' + err.toString())
      .setMimeType(ContentService.MimeType.TEXT);
  }
}

// Accept a Date object OR a string like "2026-05-01" or "May 1, 2026" and return YYYYMMDD for iCal DATE values.
function formatDateForICal(d) {
  try {
    if (!d) return null;
    let dateObj;
    if (d instanceof Date) {
      dateObj = d;
    } else if (typeof d === 'string') {
      // Try ISO first (YYYY-MM-DD); fall back to Date parse
      const isoMatch = d.match(/^(\d{4})-(\d{2})-(\d{2})/);
      if (isoMatch) {
        dateObj = new Date(parseInt(isoMatch[1]), parseInt(isoMatch[2]) - 1, parseInt(isoMatch[3]));
      } else {
        dateObj = new Date(d);
      }
    } else {
      return null;
    }
    if (isNaN(dateObj.getTime())) return null;
    const y = dateObj.getFullYear();
    const m = String(dateObj.getMonth() + 1).padStart(2, '0');
    const day = String(dateObj.getDate()).padStart(2, '0');
    return y + m + day;
  } catch (e) {
    return null;
  }
}

// ===== ADMIN DASHBOARD =====
// Hosted at <SCRIPT_URL>/exec?action=admin
// Auth is done via Google account: only the script owner (CONFIG.HOST_EMAIL, e.g. straightfinfarms@gmail.com)
// will see the dashboard. Anyone else gets a "please sign in as the host" page.

function _isAdminAuthorized() {
  try {
    const email = Session.getActiveUser().getEmail();
    return !!email && email.toLowerCase() === (CONFIG.HOST_EMAIL || '').toLowerCase();
  } catch (e) {
    return false;
  }
}

function buildAdminDashboard() {
  if (!_isAdminAuthorized()) {
    return HtmlService.createHtmlOutput(`
<!DOCTYPE html><html><head><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Sign in — SFF Admin</title>
<style>
body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;max-width:480px;margin:80px auto;padding:24px;color:#1a1a1a;text-align:center}
h1{font-size:22px;margin:0 0 12px}
p{color:#555;line-height:1.6}
.box{background:#fff;border-radius:12px;padding:28px;box-shadow:0 2px 12px rgba(0,0,0,0.06)}
.email{background:#f5f3ee;padding:8px 14px;border-radius:6px;display:inline-block;font-family:monospace;font-size:14px}
</style></head><body>
<div class="box">
  <h1>Admin Access Required</h1>
  <p>This dashboard is only accessible when you're signed into Google as <span class="email">${CONFIG.HOST_EMAIL || 'the host account'}</span>.</p>
  <p style="font-size:14px;color:#888;margin-top:20px;">If you're signed into a different Google account, <a href="https://accounts.google.com/Logout" target="_blank">sign out of that one</a> and sign in with the host account, then reload this page.</p>
</div>
</body></html>
    `).setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
  }

  const html = HtmlService.createHtmlOutput(buildAdminDashboardHtml())
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL)
    .setTitle('SFF Bookings Admin');
  return html;
}

function buildAdminDashboardHtml() {
  // The page loads and then fetches bookings via google.script.run
  return `<!DOCTYPE html>
<html><head>
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Bookings Admin — ${CONFIG.PROPERTY_NAME}</title>
<style>
:root { --green:#2e6e31; --green-dark:#1f5022; --amber:#b45309; --red:#dc3545; --gray:#6c757d; --bg:#f5f3ee; --card-bg:#fff; }
*{box-sizing:border-box}
body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;margin:0;background:var(--bg);color:#1a1a1a}
header{background:var(--green-dark);color:#fff;padding:20px 24px;display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:12px}
header h1{margin:0;font-size:20px;font-weight:500}
header .host{font-size:13px;opacity:0.8}
.container{max-width:1100px;margin:0 auto;padding:20px 24px}
.stats{display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:12px;margin:0 0 24px}
.stat{background:var(--card-bg);padding:14px 18px;border-radius:10px;box-shadow:0 1px 4px rgba(0,0,0,0.05)}
.stat .label{font-size:12px;text-transform:uppercase;letter-spacing:0.05em;color:#888;margin:0 0 4px}
.stat .value{font-size:20px;font-weight:600;margin:0}
.stat .sub{font-size:12px;color:#888;margin-top:2px}
.tabs{display:flex;gap:2px;margin:0 0 16px;border-bottom:1px solid #e0ddd6}
.tab{padding:10px 16px;background:none;border:none;border-bottom:3px solid transparent;font-size:14px;font-weight:500;color:#666;cursor:pointer}
.tab.active{color:var(--green);border-bottom-color:var(--green)}
.tab .count{background:#e0ddd6;color:#555;padding:2px 8px;border-radius:10px;font-size:12px;margin-left:6px}
.tab.active .count{background:var(--green);color:#fff}
.bookings{display:flex;flex-direction:column;gap:12px}
.card{background:var(--card-bg);border-radius:10px;padding:18px 20px;box-shadow:0 1px 4px rgba(0,0,0,0.05)}
.card .row1{display:flex;justify-content:space-between;align-items:start;gap:12px;flex-wrap:wrap;margin-bottom:10px}
.card .name{font-weight:600;font-size:16px}
.card .id{font-size:11px;color:#888;font-family:monospace}
.badge{font-size:11px;padding:3px 10px;border-radius:10px;font-weight:500;text-transform:uppercase;letter-spacing:0.03em}
.badge-Pending{background:#fff3cd;color:#856404}
.badge-Awaiting{background:#d4edda;color:#155724}
.badge-AwaitingConfirm{background:#cce5ff;color:#004085}
.badge-Confirmed{background:var(--green);color:#fff}
.badge-Declined{background:#e2e3e5;color:var(--gray)}
.badge-Cancelled{background:#e2e3e5;color:var(--gray)}
.badge-Expired{background:#ffc107;color:#7a5d02}
.details{display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:6px 20px;font-size:14px;color:#444;margin-bottom:14px;line-height:1.5}
.details strong{color:#666;margin-right:6px}
.actions{display:flex;gap:8px;flex-wrap:wrap}
.btn{padding:7px 14px;border-radius:6px;font-size:13px;font-weight:500;cursor:pointer;border:1px solid #ddd;background:#fff;color:#333}
.btn:hover{background:#f5f3ee}
.btn-primary{background:var(--green);color:#fff;border-color:var(--green)}
.btn-primary:hover{background:var(--green-dark)}
.btn-danger{background:var(--red);color:#fff;border-color:var(--red)}
.btn-danger:hover{background:#b02a37}
.btn-amber{background:var(--amber);color:#fff;border-color:var(--amber)}
.empty{text-align:center;padding:40px;color:#888;font-size:14px;background:var(--card-bg);border-radius:10px}
.loading{text-align:center;padding:40px;color:#888}
.modal-overlay{position:fixed;inset:0;background:rgba(0,0,0,0.5);display:none;align-items:center;justify-content:center;z-index:1000;padding:20px}
.modal-overlay.open{display:flex}
.modal{background:var(--card-bg);border-radius:12px;padding:28px;max-width:480px;width:100%;max-height:90vh;overflow-y:auto}
.modal h2{margin:0 0 6px;font-size:18px}
.modal .sub{color:#666;font-size:13px;margin:0 0 20px}
.modal label{display:block;margin-top:14px;font-size:13px;color:#555;font-weight:500}
.modal input,.modal textarea,.modal select{width:100%;padding:9px 11px;border:1px solid #ddd;border-radius:6px;font-size:14px;font-family:inherit;margin-top:4px}
.modal textarea{min-height:80px;resize:vertical}
.modal .row2{display:grid;grid-template-columns:1fr 1fr;gap:10px}
.modal-actions{display:flex;justify-content:flex-end;gap:8px;margin-top:20px}
.msg{margin-top:12px;padding:10px 14px;border-radius:6px;font-size:13px}
.msg-success{background:#d4edda;color:#155724}
.msg-error{background:#f8d7da;color:#721c24}
.refresh-btn{background:rgba(255,255,255,0.15);color:#fff;border:1px solid rgba(255,255,255,0.3);padding:6px 14px;border-radius:6px;cursor:pointer;font-size:13px}
.refresh-btn:hover{background:rgba(255,255,255,0.25)}
.chart-row{display:grid;grid-template-columns:1fr;gap:16px}
@media(min-width:900px){.chart-row{grid-template-columns:1fr 1fr}}
.chart-card{background:var(--card-bg);border-radius:10px;padding:20px;box-shadow:0 1px 4px rgba(0,0,0,0.05)}
/* Chart.js needs a fixed-height parent when maintainAspectRatio:false, otherwise the canvas expands infinitely on each redraw.
   Inside the Apps Script iframe (auto-resizes to fit content), a ResizeObserver feedback loop will grow the canvas → grow the
   iframe → grow the canvas → … unless the canvas is taken OUT of document flow. We do that with position:absolute on the
   canvas inside a position:relative wrap, and clip with overflow:hidden as belt-and-suspenders. */
.chart-canvas-wrap{position:relative;width:100%;height:300px;overflow:hidden;contain:strict}
.chart-canvas-wrap.tall{height:320px}
.chart-canvas-wrap.short{height:260px}
.chart-canvas-wrap canvas{position:absolute!important;top:0;left:0;display:block;max-width:100%;max-height:100%}
.chart-card{min-width:0}
.chart-header{margin:0 0 14px}
.chart-header h3{margin:0 0 4px;font-size:15px;font-weight:600}
.chart-sub{font-size:12px;color:#888;line-height:1.5}
.year-select{display:flex;gap:4px;margin:0 0 12px}
.year-btn{padding:4px 10px;border:1px solid #ddd;background:#fff;border-radius:6px;font-size:12px;cursor:pointer;color:#555}
.year-btn.active{background:var(--green);color:#fff;border-color:var(--green)}
.card-type-header{display:flex;flex-wrap:wrap;gap:6px;margin:0 0 10px;padding:0 0 10px;border-bottom:1px solid #f0eee8}
.type-label{display:inline-flex;align-items:center;gap:4px;font-size:11px;font-weight:600;letter-spacing:0.06em;text-transform:uppercase;padding:3px 10px;border-radius:999px;line-height:1.4}
.type-label.type-stay{background:#e6f4ea;color:#2e6e31}
.type-label.type-course{background:#fff4d6;color:#8a6500}
.type-label.type-upsell{background:#eef0ff;color:#4047a0}
.site-mode-badge{display:inline-block;padding:3px 10px;border-radius:999px;font-size:11px;font-weight:700;letter-spacing:0.08em;text-transform:uppercase}
.site-mode-badge.is-test{background:#fff3cd;color:#856404}
.site-mode-badge.is-live{background:#d4edda;color:#155724}
.settings-card{background:var(--card-bg);border-radius:10px;padding:18px 22px;box-shadow:0 1px 4px rgba(0,0,0,0.05);display:flex;align-items:center;justify-content:space-between;gap:24px}
.settings-card-text{flex:1;min-width:0}
.settings-card-title{font-weight:600;font-size:15px;margin-bottom:4px}
.settings-card-sub{font-size:13px;color:#666;line-height:1.55}
.settings-card-state{font-size:12px;color:#888;margin-top:8px;font-style:italic}
.settings-card-state.is-on{color:#2e6e31;font-style:normal;font-weight:600}
.settings-card-state.is-off{color:#888}
.toggle{position:relative;display:inline-block;width:48px;height:26px;flex-shrink:0}
.toggle input{opacity:0;width:0;height:0}
.toggle-slider{position:absolute;cursor:pointer;top:0;left:0;right:0;bottom:0;background:#ccc;border-radius:26px;transition:.18s}
.toggle-slider:before{position:absolute;content:"";height:20px;width:20px;left:3px;top:3px;background:#fff;border-radius:50%;transition:.18s;box-shadow:0 1px 2px rgba(0,0,0,0.2)}
.toggle input:checked + .toggle-slider{background:var(--green)}
.toggle input:checked + .toggle-slider:before{transform:translateX(22px)}
.toggle input:disabled + .toggle-slider{opacity:0.55;cursor:wait}
</style>
<script src="https://cdn.jsdelivr.net/npm/chart.js@4.4.0/dist/chart.umd.min.js"></script>
</head>
<body>
<header>
  <div>
    <h1>Bookings Admin</h1>
    <div class="host" id="hostInfo">${CONFIG.PROPERTY_NAME}</div>
  </div>
  <button class="refresh-btn" onclick="loadBookings()">↻ Refresh</button>
</header>

<div class="container">
  <div class="stats" id="stats"></div>

  <div class="tabs">
    <button class="tab active" data-tab="inflight">In flight <span class="count" id="count-inflight">0</span></button>
    <button class="tab" data-tab="confirmed">Confirmed <span class="count" id="count-confirmed">0</span></button>
    <button class="tab" data-tab="history">History <span class="count" id="count-history">0</span></button>
    <button class="tab" data-tab="analytics">📊 Analytics</button>
    <button class="tab" data-tab="webtraffic">🌐 Web Traffic</button>
    <button class="tab" data-tab="pricing">💰 Pricing</button>
    <button class="tab" data-tab="settings">⚙️ Settings</button>
  </div>

  <div id="bookings" class="bookings"><div class="loading">Loading bookings…</div></div>

  <div id="analytics" style="display:none">
    <div class="chart-row">
      <div class="chart-card">
        <div class="chart-header">
          <h3>Monthly revenue by check-in month</h3>
          <div class="chart-sub">Stacked: <span style="color:var(--green)">Confirmed</span> (actuals) · <span style="color:#7dc97f">Awaiting payment</span> (probable) · <span style="color:#f1c232">Pending</span> (in review)</div>
        </div>
        <div class="year-select">
          <button class="year-btn active" data-year-offset="0">This year</button>
          <button class="year-btn" data-year-offset="-1">Last year</button>
          <button class="year-btn" data-year-offset="1">Next year</button>
        </div>
        <div class="chart-canvas-wrap"><canvas id="monthlyChart"></canvas></div>
      </div>
      <div class="chart-card">
        <div class="chart-header">
          <h3>12-month forward projection</h3>
          <div class="chart-sub">Cumulative <span style="color:var(--green)">committed</span> (paid + awaiting) and <span style="color:#f1c232">potential</span> (pending) revenue by month</div>
        </div>
        <div class="chart-canvas-wrap"><canvas id="projectionChart"></canvas></div>
      </div>
      <div class="chart-card">
        <div class="chart-header">
          <h3>Occupancy — nights booked per month</h3>
          <div class="chart-sub">Night-count by check-in month (confirmed only)</div>
        </div>
        <div class="chart-canvas-wrap short"><canvas id="occupancyChart"></canvas></div>
      </div>
      <div class="chart-card">
        <div class="chart-header">
          <h3>Booking pipeline</h3>
          <div class="chart-sub">Count of bookings at each stage</div>
        </div>
        <div class="chart-canvas-wrap short"><canvas id="pipelineChart"></canvas></div>
      </div>
    </div>
  </div>

  <div id="webtraffic" style="display:none">
    <div style="background:var(--card-bg);border-radius:10px;padding:16px 20px;box-shadow:0 1px 4px rgba(0,0,0,0.05);margin-bottom:12px;display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:8px">
      <div>
        <div style="font-weight:600;font-size:15px;margin-bottom:2px">Web Traffic — straightfinfarms.com</div>
        <div style="font-size:12px;color:#888;line-height:1.5">Live Google Analytics 4 dashboard. Pageviews, traffic sources, top pages, conversions. Refreshes every ~12 hours.</div>
      </div>
      <div style="display:flex;gap:8px;flex-wrap:wrap">
        <a class="btn" href="https://analytics.google.com/analytics/web/#/p410378106/reports/intelligenthome" target="_blank" rel="noopener">Open in GA4 ↗</a>
        <a class="btn btn-primary" href="https://lookerstudio.google.com/u/1/reporting/e025fbb1-9d59-4ae6-a7af-7b3c28552f09" target="_blank" rel="noopener">Open dashboard ↗</a>
      </div>
    </div>
    <div style="background:var(--card-bg);border-radius:10px;padding:0;box-shadow:0 1px 4px rgba(0,0,0,0.05);overflow:hidden">
      <iframe src="https://lookerstudio.google.com/embed/reporting/e025fbb1-9d59-4ae6-a7af-7b3c28552f09/page/kIV1C" style="width:100%;height:2200px;border:0;display:block" allowfullscreen></iframe>
    </div>
  </div>

  <div id="pricing" style="display:none">
    <div style="background:var(--card-bg);border-radius:10px;padding:24px 28px;box-shadow:0 1px 4px rgba(0,0,0,0.05);margin-bottom:14px">
      <div style="font-weight:600;font-size:17px;margin-bottom:6px">Stay nightly rates</div>
      <div style="font-size:13px;color:#666;line-height:1.6;max-width:680px">
        Set the base rate for any month and day-of-week combination below — these are the per-night prices the booking page uses. Add specific date overrides for holidays and long weekends. Stays of 7+ nights automatically get a discount you can adjust below.
      </div>
    </div>

    <!-- Base rate matrix: 12 months × 7 days -->
    <div style="background:var(--card-bg);border-radius:10px;padding:18px 22px;box-shadow:0 1px 4px rgba(0,0,0,0.05);margin-bottom:14px">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:14px;flex-wrap:wrap;gap:8px">
        <div>
          <div style="font-weight:600;font-size:15px">Base rate matrix · $ per night</div>
          <div style="font-size:12px;color:#888">Click any cell to edit. Changes save when you hit Save All.</div>
        </div>
        <div style="display:flex;gap:8px">
          <button class="btn" onclick="resetPricingMatrix()">Reset to default</button>
          <button class="btn btn-primary" onclick="saveAllBaseRates()" id="savePricingBtn">Save All</button>
        </div>
      </div>
      <div style="overflow-x:auto">
        <table id="pricingMatrix" style="border-collapse:collapse;width:100%;min-width:680px;font-size:13px">
          <thead>
            <tr>
              <th style="text-align:left;padding:8px 10px;border-bottom:2px solid #ddd;color:#888;font-weight:600">Month</th>
              <th style="padding:8px 6px;border-bottom:2px solid #ddd;color:#888;font-weight:600">Sun</th>
              <th style="padding:8px 6px;border-bottom:2px solid #ddd;color:#888;font-weight:600">Mon</th>
              <th style="padding:8px 6px;border-bottom:2px solid #ddd;color:#888;font-weight:600">Tue</th>
              <th style="padding:8px 6px;border-bottom:2px solid #ddd;color:#888;font-weight:600">Wed</th>
              <th style="padding:8px 6px;border-bottom:2px solid #ddd;color:#888;font-weight:600">Thu</th>
              <th style="padding:8px 6px;border-bottom:2px solid #ddd;color:#888;font-weight:600">Fri</th>
              <th style="padding:8px 6px;border-bottom:2px solid #ddd;color:#888;font-weight:600">Sat</th>
            </tr>
          </thead>
          <tbody id="pricingMatrixBody"><!-- rendered by JS --></tbody>
        </table>
      </div>
    </div>

    <!-- Date overrides: holidays / long weekends / ad-hoc -->
    <div style="background:var(--card-bg);border-radius:10px;padding:18px 22px;box-shadow:0 1px 4px rgba(0,0,0,0.05);margin-bottom:14px">
      <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:12px;flex-wrap:wrap;margin-bottom:6px">
        <div>
          <div style="font-weight:600;font-size:15px">Date overrides</div>
          <div style="font-size:12px;color:#888;margin-top:2px">Per-date prices (holidays, long weekends, ad-hoc events). Override prices replace the base matrix for that specific date.</div>
        </div>
        <div style="display:flex;gap:8px;flex-wrap:wrap">
          <button class="btn" onclick="seedOntarioHolidays()" id="seedHolidaysBtn">+ Seed Ontario holidays</button>
          <button class="btn btn-primary" onclick="saveAllOverrides()" id="saveAllOverridesBtn">Save All Overrides</button>
        </div>
      </div>
      <div id="overridesList" style="margin-top:14px"><!-- rendered by JS --></div>
      <div style="display:flex;gap:8px;flex-wrap:wrap;align-items:flex-end;padding-top:14px;border-top:1px dashed #e0ddd6;margin-top:14px">
        <div style="flex:1;min-width:140px"><label style="display:block;font-size:12px;color:#666;margin-bottom:3px">Date</label><input type="date" id="newOverrideDate" style="width:100%;padding:8px;border:1px solid #ddd;border-radius:6px"></div>
        <div style="flex:1;min-width:120px"><label style="display:block;font-size:12px;color:#666;margin-bottom:3px">Price ($)</label><input type="number" id="newOverridePrice" min="0" step="10" placeholder="850" style="width:100%;padding:8px;border:1px solid #ddd;border-radius:6px"></div>
        <div style="flex:2;min-width:200px"><label style="display:block;font-size:12px;color:#666;margin-bottom:3px">Label (optional)</label><input type="text" id="newOverrideLabel" placeholder="Christmas Day, Labour Day, etc." style="width:100%;padding:8px;border:1px solid #ddd;border-radius:6px"></div>
        <button class="btn btn-primary" onclick="addOverride()">Add</button>
      </div>
    </div>

    <!-- Copy date overrides from one year to the next -->
    <div style="background:var(--card-bg);border-radius:10px;padding:18px 22px;box-shadow:0 1px 4px rgba(0,0,0,0.05);margin-bottom:14px">
      <div style="font-weight:600;font-size:15px;margin-bottom:6px">Copy overrides to another year</div>
      <div style="font-size:12px;color:#888;margin-bottom:14px">Rolls your date overrides forward into a new year. Holidays move to their new date &mdash; Labour Day weekend stays a long weekend, Christmas stays on the 25th. The base rate matrix has no year, so it carries over on its own. Preview before anything is written.</div>
      <div style="display:flex;gap:14px;flex-wrap:wrap;align-items:flex-end">
        <div style="flex:1;min-width:150px"><label style="display:block;font-size:12px;color:#666;margin-bottom:3px">Copy from</label><select id="copyFromYear" style="width:100%;padding:8px;border:1px solid #ddd;border-radius:6px;background:#fff"><option value="">Loading…</option></select></div>
        <div style="flex:1;min-width:130px"><label style="display:block;font-size:12px;color:#666;margin-bottom:3px">Copy to (year)</label><input type="number" id="copyToYear" min="2000" max="2100" step="1" placeholder="2027" style="width:100%;padding:8px;border:1px solid #ddd;border-radius:6px"></div>
        <div style="flex:1;min-width:130px"><label style="display:block;font-size:12px;color:#666;margin-bottom:3px">Price change (%)</label><input type="number" id="copyPercent" min="-100" max="500" step="0.5" value="0" style="width:100%;padding:8px;border:1px solid #ddd;border-radius:6px"></div>
        <div style="flex:1;min-width:130px"><label style="display:block;font-size:12px;color:#666;margin-bottom:3px">Round to nearest</label><select id="copyRoundTo" style="width:100%;padding:8px;border:1px solid #ddd;border-radius:6px;background:#fff"><option value="1">$1</option><option value="5" selected>$5</option><option value="10">$10</option><option value="25">$25</option></select></div>
        <button class="btn btn-primary" onclick="previewCopyYear()" id="copyPreviewBtn">Preview copy</button>
      </div>
      <label style="display:flex;align-items:center;gap:7px;font-size:12px;color:#666;margin-top:12px;cursor:pointer"><input type="checkbox" id="copyClearOthers" style="margin:0"> Also remove existing overrides in the target year that aren&rsquo;t part of this copy</label>
      <div id="copyYearPreview"></div>
      <div style="margin-top:12px"><button class="btn btn-primary" onclick="applyCopyYear()" id="copyApplyBtn" style="display:none">Apply</button></div>
    </div>

    <!-- Weekly discount config -->
    <div style="background:var(--card-bg);border-radius:10px;padding:18px 22px;box-shadow:0 1px 4px rgba(0,0,0,0.05);margin-bottom:14px">
      <div style="font-weight:600;font-size:15px;margin-bottom:6px">Weekly stay discount</div>
      <div style="font-size:12px;color:#888;margin-bottom:14px">Stays at or above this many nights get a percentage off the nightly subtotal. Advertised on the booking page.</div>
      <div style="display:flex;gap:14px;flex-wrap:wrap;align-items:flex-end">
        <div style="flex:1;min-width:140px"><label style="display:block;font-size:12px;color:#666;margin-bottom:3px">Threshold (nights)</label><input type="number" id="weeklyDiscountThreshold" min="1" step="1" style="width:100%;padding:8px;border:1px solid #ddd;border-radius:6px"></div>
        <div style="flex:1;min-width:140px"><label style="display:block;font-size:12px;color:#666;margin-bottom:3px">Discount (%)</label><input type="number" id="weeklyDiscountPercent" min="0" max="100" step="1" style="width:100%;padding:8px;border:1px solid #ddd;border-radius:6px"></div>
        <button class="btn btn-primary" onclick="saveWeeklyDiscount()">Save</button>
      </div>
    </div>

    <!-- Extras / add-on fees: extra adults, pets, bunkie, bell tent -->
    <div style="background:var(--card-bg);border-radius:10px;padding:18px 22px;box-shadow:0 1px 4px rgba(0,0,0,0.05);margin-bottom:14px">
      <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:12px;flex-wrap:wrap;margin-bottom:6px">
        <div>
          <div style="font-weight:600;font-size:15px">Extras &amp; add-on fees</div>
          <div style="font-size:12px;color:#888;margin-top:2px;max-width:680px;line-height:1.5">
            Per-line configurable fees added on top of the nightly rate. <strong>Threshold</strong> = the quantity at which the fee starts charging (e.g. set adults to <code>10</code> to charge only for the 11th adult and beyond; set pets/bunkie/tent to <code>0</code> to charge for every one). <strong>Per</strong> controls whether the price multiplies by nights or is a flat per-stay amount. Each line saves independently.
          </div>
        </div>
        <div style="display:flex;gap:8px;flex-wrap:wrap">
          <button class="btn" onclick="resetAllExtras()">Reset all to defaults</button>
        </div>
      </div>
      <div id="extrasList" style="margin-top:14px;display:flex;flex-direction:column;gap:10px"><!-- rendered by JS --></div>
    </div>

    <div id="pricingMsg" style="margin-top:14px;font-size:13px;color:#666;min-height:18px"></div>
  </div>

  <div id="settings" style="display:none">
    <!-- SITE MODE — controls Stripe key (TEST/LIVE) and the Airbnb-facing iCal feed.
         When TEST: Airbnb feed (?for=airbnb) returns empty, so test bookings don't block real dates. -->
    <div id="siteModeCard" style="background:var(--card-bg);border-radius:10px;padding:20px 24px;box-shadow:0 1px 4px rgba(0,0,0,0.05);margin-bottom:14px;border-left:4px solid #999">
      <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:16px;flex-wrap:wrap">
        <div style="flex:1;min-width:280px">
          <div style="display:flex;align-items:center;gap:10px;margin-bottom:4px">
            <div style="font-weight:600;font-size:17px">Site mode</div>
            <span id="siteModeBadge" class="site-mode-badge">…</span>
          </div>
          <div style="font-size:13px;color:#666;line-height:1.6;max-width:560px">
            <strong>TEST</strong> = use Stripe test keys, and the Airbnb-facing iCal feed returns no events (so test bookings don't accidentally block real dates on Airbnb). <strong>LIVE</strong> = real Stripe charges, real Airbnb sync.
          </div>
          <div id="siteModeIcalUrls" style="font-size:12px;color:#888;margin-top:10px;line-height:1.6"></div>
        </div>
        <div style="display:flex;gap:8px;flex-shrink:0">
          <button id="modeBtnTest" class="btn" onclick="setMode('test')">Switch to TEST</button>
          <button id="modeBtnLive" class="btn btn-danger" onclick="setMode('live')">Switch to LIVE</button>
        </div>
      </div>
    </div>

    <div style="background:var(--card-bg);border-radius:10px;padding:24px 28px;box-shadow:0 1px 4px rgba(0,0,0,0.05);margin-bottom:14px">
      <div style="font-weight:600;font-size:17px;margin-bottom:6px">Booking mode</div>
      <div style="font-size:13px;color:#666;line-height:1.6;max-width:680px">
        With these toggles <strong>OFF</strong>, every guest booking comes in as a <em>request</em> and you accept or decline it before payment. With one ON, that booking type becomes <em>direct</em> — the guest pays at submission and the row lands in <span style="display:inline-block;padding:2px 8px;border-radius:6px;background:#cce5ff;color:#004085;font-size:12px;font-weight:600;">Awaiting Confirmation</span>. You verify the payment landed (Stripe Dashboard or your inbox for e-Transfer), then click Mark Paid to send the welcome email + check-in instructions. Flip back to OFF anytime — existing bookings keep their current status.
      </div>
    </div>

    <div id="settingsCards" style="display:flex;flex-direction:column;gap:12px">
      <div class="settings-card" data-key="directBookingStay">
        <div class="settings-card-text">
          <div class="settings-card-title">Direct booking — Farm Stay</div>
          <div class="settings-card-sub">When ON, <strong>book-direct.html</strong> guests can pay immediately (Stripe credit card OR Interac e-Transfer with 48-hour hold).</div>
          <div class="settings-card-state" id="state-directBookingStay">Loading…</div>
        </div>
        <label class="toggle">
          <input type="checkbox" id="toggle-directBookingStay" disabled>
          <span class="toggle-slider"></span>
        </label>
      </div>

      <div class="settings-card" data-key="directBookingCourse">
        <div class="settings-card-text">
          <div class="settings-card-title">Direct booking — Permaculture Course</div>
          <div class="settings-card-sub">When ON, <strong>book-course.html</strong> enrollments can be paid immediately (Stripe credit card OR Interac e-Transfer with 48-hour hold).</div>
          <div class="settings-card-state" id="state-directBookingCourse">Loading…</div>
        </div>
        <label class="toggle">
          <input type="checkbox" id="toggle-directBookingCourse" disabled>
          <span class="toggle-slider"></span>
        </label>
      </div>
    </div>

    <!-- PERMACULTURE — Call Numbers (admin-editable phone numbers for permaculture-course.html) -->
    <div id="permaPhonesCard" style="background:var(--card-bg);border-radius:10px;padding:20px 24px;box-shadow:0 1px 4px rgba(0,0,0,0.05);margin-top:14px;border-left:4px solid #3d8c40">
      <div style="display:flex;align-items:center;gap:10px;margin-bottom:4px">
        <div style="font-weight:600;font-size:17px">Permaculture — Call Numbers</div>
        <span style="font-size:11px;background:#3d8c40;color:#fff;padding:3px 8px;border-radius:999px;letter-spacing:0.06em;">3 windows</span>
      </div>
      <div style="font-size:13px;color:#666;line-height:1.6;max-width:680px;margin-bottom:14px">
        Phone numbers shown on the permaculture page's "call directly" button. The page picks the right one based on the visitor's current Eastern Time; all three are listed under the button so people can plan ahead.
      </div>
      <div style="display:grid;grid-template-columns:repeat(3,1fr);gap:14px">
        <div>
          <label style="display:block;font-size:11px;letter-spacing:0.06em;text-transform:uppercase;color:#888;margin-bottom:4px">9 am – 5 pm EST</label>
          <input type="tel" id="permaPhoneBusiness" placeholder="416-254-7104"
                 style="width:100%;padding:10px 12px;border:1px solid #d8d4cb;border-radius:6px;font-size:14px;background:#fafaf7" disabled>
        </div>
        <div>
          <label style="display:block;font-size:11px;letter-spacing:0.06em;text-transform:uppercase;color:#888;margin-bottom:4px">After 5 pm EST</label>
          <input type="tel" id="permaPhoneAfterHours" placeholder="416-254-7104"
                 style="width:100%;padding:10px 12px;border:1px solid #d8d4cb;border-radius:6px;font-size:14px;background:#fafaf7" disabled>
        </div>
        <div>
          <label style="display:block;font-size:11px;letter-spacing:0.06em;text-transform:uppercase;color:#888;margin-bottom:4px">Weekends</label>
          <input type="tel" id="permaPhoneWeekend" placeholder="416-254-7104"
                 style="width:100%;padding:10px 12px;border:1px solid #d8d4cb;border-radius:6px;font-size:14px;background:#fafaf7" disabled>
        </div>
      </div>
      <div style="display:flex;align-items:center;gap:14px;margin-top:14px">
        <button id="permaPhonesSaveBtn" type="button" class="btn" onclick="savePermaculturePhones()" disabled>Save phones</button>
        <span id="permaPhonesStatus" style="font-size:13px;color:#888"></span>
      </div>
    </div>

    <div id="settingsMsg" style="margin-top:14px;font-size:13px;color:#666;min-height:18px"></div>
  </div>
</div>

<div class="modal-overlay" id="modal">
  <div class="modal" id="modalContent"></div>
</div>

<script>
let allBookings = [];
let currentTab = 'inflight';

function fmtCurrency(n) {
  return '$' + Number(n || 0).toLocaleString('en-CA', {minimumFractionDigits: 2, maximumFractionDigits: 2});
}
function fmtDate(d) {
  if (!d) return '';
  // Accept ISO strings, Date objects, or YYYY-MM-DD; pass through anything else (e.g. "Not received")
  const date = new Date(d);
  if (isNaN(date.getTime())) return String(d);
  return date.toLocaleDateString('en-CA', { year: 'numeric', month: 'short', day: 'numeric' });
}
function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }

function loadBookings() {
  document.getElementById('bookings').innerHTML = '<div class="loading">Loading bookings…</div>';
  google.script.run.withSuccessHandler(onData).withFailureHandler(onErr).adminListBookings();
}
function onData(data) {
  allBookings = data.bookings;
  renderStats(data.stats);
  renderBookings();
}
function onErr(err) {
  document.getElementById('bookings').innerHTML = '<div class="empty">Error: ' + esc(err.message) + '</div>';
}

function renderStats(s) {
  const statsEl = document.getElementById('stats');
  statsEl.innerHTML = \`
    <div class="stat"><p class="label">Confirmed revenue (YTD)</p><p class="value">\${fmtCurrency(s.ytdConfirmedRevenue)}</p><div class="sub">\${s.ytdConfirmedCount} booking\${s.ytdConfirmedCount===1?'':'s'}</div></div>
    <div class="stat"><p class="label">Awaiting payment (potential)</p><p class="value">\${fmtCurrency(s.awaitingPaymentRevenue)}</p><div class="sub">\${s.awaitingPaymentCount} pending payment</div></div>
    <div class="stat"><p class="label">Pending review</p><p class="value">\${s.pendingCount}</p><div class="sub">\${fmtCurrency(s.pendingRevenue)} est. value</div></div>
    <div class="stat"><p class="label">Upcoming nights</p><p class="value">\${s.upcomingNights}</p><div class="sub">\${s.upcomingBookings} confirmed booking\${s.upcomingBookings===1?'':'s'}</div></div>
  \`;
}

// Detect a course booking by the Occasion prefix. doPost packs course bookings as
// 'COURSE · <Course Name>'. A future hybrid booking (stay + course on the same row)
// can set b.hybridStayCourse = true and we'll render BOTH labels at the top of the card.
function isCourseBooking(b) {
  return !!(b && b.occasion && String(b.occasion).indexOf('COURSE') === 0);
}

function renderBookings() {
  const groups = {
    inflight: allBookings.filter(b => b.status === 'Pending' || b.status === 'Awaiting Payment' || b.status === 'Awaiting Confirmation'),
    confirmed: allBookings.filter(b => b.status === 'Confirmed'),
    history: allBookings.filter(b => ['Declined','Cancelled','Cancelled — No refund','Expired'].indexOf(b.status) > -1),
  };
  document.getElementById('count-inflight').textContent = groups.inflight.length;
  document.getElementById('count-confirmed').textContent = groups.confirmed.length;
  document.getElementById('count-history').textContent = groups.history.length;

  const list = groups[currentTab] || [];
  const el = document.getElementById('bookings');
  if (!list.length) {
    el.innerHTML = '<div class="empty">No bookings in this tab.</div>';
    return;
  }
  el.innerHTML = list.map(renderCard).join('');
}

function renderCard(b) {
  const guestParts = [];
  if (b.adults) guestParts.push(b.adults + ' adult' + (b.adults !== 1 ? 's' : ''));
  else if (b.guests) guestParts.push(b.guests + ' guest' + (b.guests !== 1 ? 's' : ''));
  if (b.children > 0) guestParts.push(b.children + (b.children === 1 ? ' child' : ' children'));
  if (b.infants > 0) guestParts.push(b.infants + ' infant' + (b.infants !== 1 ? 's' : ''));
  if (b.pets > 0) guestParts.push(b.pets + ' pet' + (b.pets !== 1 ? 's' : ''));
  const totalDisplay = b.finalTotal
    ? '<strong>Final:</strong> ' + fmtCurrency(b.finalTotal)
    : '<strong>Est:</strong> ' + fmtCurrency(b.estimatedTotal);

  // Action buttons vary by status
  let actions = '';
  if (b.status === 'Pending') {
    actions = \`
      <button class="btn btn-primary" onclick="openAcceptModal(\${b.rowId})">Accept</button>
      <button class="btn btn-danger" onclick="openDeclineModal(\${b.rowId})">Decline</button>
      <button class="btn" onclick="openRescheduleModal(\${b.rowId})">Reschedule</button>
    \`;
  } else if (b.status === 'Awaiting Payment') {
    actions = \`
      <button class="btn btn-primary" onclick="openMarkPaidModal(\${b.rowId})">Mark Paid</button>
      <button class="btn" onclick="adminResendLink(\${b.rowId})">Resend payment link</button>
      <button class="btn" onclick="openRescheduleModal(\${b.rowId})">Reschedule</button>
      <button class="btn btn-danger" onclick="openCancelModal(\${b.rowId})">Cancel</button>
    \`;
  } else if (b.status === 'Awaiting Confirmation') {
    // Direct booking: guest already paid (or claimed to). Host's only job is to verify
    // payment landed and click Mark Paid to send the welcome email.
    actions = \`
      <button class="btn btn-primary" onclick="openMarkPaidModal(\${b.rowId})">Mark Paid</button>
      <button class="btn" onclick="openRescheduleModal(\${b.rowId})">Reschedule</button>
      <button class="btn btn-danger" onclick="openCancelModal(\${b.rowId})">Cancel</button>
    \`;
  } else if (b.status === 'Confirmed') {
    actions = \`
      <button class="btn" onclick="openRescheduleModal(\${b.rowId})">Reschedule</button>
      <button class="btn btn-danger" onclick="openCancelModal(\${b.rowId})">Cancel</button>
    \`;
  }

  // Type label inside the card — shows what's being paid for. Hybrid stay+course
  // bookings render BOTH labels. Optional upsells (chef / permaculture experience)
  // also appear as small chips so the host sees them at a glance.
  const isCourse = isCourseBooking(b);
  const isHybrid = !!b.hybridStayCourse;
  const typeLabels = [];
  if (isHybrid || !isCourse) typeLabels.push('<span class="type-label type-stay">🏡 Farm Stay</span>');
  if (isHybrid || isCourse) typeLabels.push('<span class="type-label type-course">🌱 Course Registration</span>');
  if (b.upsellChef) typeLabels.push('<span class="type-label type-upsell">🍽️ Chef Requested</span>');
  if (b.upsellCourse) typeLabels.push('<span class="type-label type-upsell">🌱 Permaculture Experience Requested</span>');
  const typeHeader = '<div class="card-type-header">' + typeLabels.join('') + '</div>';

  return \`
    <div class="card">
      \${typeHeader}
      <div class="row1">
        <div>
          <div class="name">\${esc(b.firstName)} \${esc(b.lastName)} <span class="id">#\${esc(b.id)}</span></div>
          <div style="font-size:13px;color:#888;margin-top:2px">\${esc(b.email)}\${b.phone ? ' · ' + esc(b.phone) : ''}</div>
        </div>
        <span class="badge badge-\${statusKey(b.status)}">\${esc(b.status)}</span>
      </div>
      <div class="details">
        <div><strong>Dates:</strong> \${esc(b.checkin)} → \${esc(b.checkout)} · \${b.nights} night\${b.nights===1?'':'s'}</div>
        <div><strong>Guests:</strong> \${esc(guestParts.join(', '))}</div>
        <div>\${totalDisplay}</div>
        <div><strong>Occasion:</strong> \${esc(b.occasion || '—')}</div>
        \${b.submitted ? '<div><strong>Booked:</strong> ' + esc(fmtDate(b.submitted)) + '</div>' : ''}
        \${b.status === 'Confirmed' && b.paymentConfirmed && fmtDate(b.paymentConfirmed) !== String(b.paymentConfirmed) ? '<div><strong>Confirmed:</strong> ' + esc(fmtDate(b.paymentConfirmed)) + '</div>' : ''}
        \${b.message ? '<div style="grid-column:1/-1;"><strong>Note:</strong> ' + esc(b.message) + '</div>' : ''}
      </div>
      <div class="actions">\${actions}</div>
    </div>
  \`;
}

function statusKey(status) {
  if (status === 'Awaiting Payment') return 'Awaiting';
  if (status === 'Awaiting Confirmation') return 'AwaitingConfirm';
  if (status === 'Cancelled' || status === 'Cancelled — No refund') return 'Cancelled';
  return status;
}

// Tabs
document.querySelectorAll('.tab').forEach(t => {
  t.addEventListener('click', () => {
    document.querySelectorAll('.tab').forEach(x => x.classList.remove('active'));
    t.classList.add('active');
    currentTab = t.dataset.tab;
    var bookingsEl = document.getElementById('bookings');
    var analyticsEl = document.getElementById('analytics');
    var webtrafficEl = document.getElementById('webtraffic');
    var settingsEl = document.getElementById('settings');
    var pricingEl = document.getElementById('pricing');
    var hideAll = () => {
      bookingsEl.style.display = 'none';
      analyticsEl.style.display = 'none';
      webtrafficEl.style.display = 'none';
      if (settingsEl) settingsEl.style.display = 'none';
      if (pricingEl) pricingEl.style.display = 'none';
    };
    if (currentTab === 'analytics') {
      hideAll();
      analyticsEl.style.display = 'block';
      renderAnalytics();
    } else if (currentTab === 'webtraffic') {
      hideAll();
      webtrafficEl.style.display = 'block';
    } else if (currentTab === 'settings') {
      hideAll();
      if (settingsEl) settingsEl.style.display = 'block';
      loadSettings();
    } else if (currentTab === 'pricing') {
      hideAll();
      if (pricingEl) pricingEl.style.display = 'block';
      loadPricing();
    } else {
      hideAll();
      bookingsEl.style.display = 'flex';
      renderBookings();
    }
  });
});

// ===== SETTINGS TAB =====
function loadSettings() {
  var msg = document.getElementById('settingsMsg');
  if (msg) msg.textContent = 'Loading current settings…';
  setSettingsToggleEnabled(false);
  google.script.run
    .withSuccessHandler(function (s) {
      if (msg) msg.textContent = '';
      applySettingsToUI(s);
      setSettingsToggleEnabled(true);
    })
    .withFailureHandler(function (err) {
      if (msg) msg.textContent = 'Error loading settings: ' + (err && err.message ? err.message : err);
      setSettingsToggleEnabled(false);
    })
    .adminGetSettings();
  // Site mode also loads here
  google.script.run
    .withSuccessHandler(applySiteModeToUI)
    .withFailureHandler(function (err) { console.warn('Site mode load error:', err); })
    .adminGetSiteMode();
}

function applySiteModeToUI(info) {
  if (!info) return;
  var mode = info.mode || 'test';
  var badge = document.getElementById('siteModeBadge');
  var card = document.getElementById('siteModeCard');
  var btnTest = document.getElementById('modeBtnTest');
  var btnLive = document.getElementById('modeBtnLive');
  var urlsEl = document.getElementById('siteModeIcalUrls');
  if (badge) {
    badge.textContent = mode;
    badge.className = 'site-mode-badge is-' + mode;
  }
  if (card) card.style.borderLeftColor = (mode === 'live') ? '#28a745' : '#f1c232';
  if (btnTest) btnTest.disabled = (mode === 'test');
  if (btnLive) btnLive.disabled = (mode === 'live');
  if (urlsEl && info.bookingsIcsAirbnbUrl) {
    var note = (mode === 'live')
      ? 'Currently active. Airbnb is pulling Confirmed bookings from this feed.'
      : 'Inactive in TEST mode (returns empty). Switch to LIVE to start blocking dates on Airbnb.';
    urlsEl.innerHTML = 'Airbnb sync URL: <a href="' + info.bookingsIcsAirbnbUrl + '" target="_blank" rel="noopener" style="color:#3d8c40">' + info.bookingsIcsAirbnbUrl + '</a><br><span>' + note + '</span>';
  }
}

function setMode(mode) {
  var verb = (mode === 'live') ? 'switch to LIVE' : 'switch to TEST';
  var warning = (mode === 'live')
    ? 'Are you sure you want to switch to LIVE? This will charge real cards via Stripe and start pushing confirmed bookings to Airbnb (block dates).'
    : 'Switch to TEST mode? Stripe goes back to test keys and the Airbnb sync feed returns empty.';
  if (!confirm(warning)) return;
  var btnT = document.getElementById('modeBtnTest');
  var btnL = document.getElementById('modeBtnLive');
  if (btnT) btnT.disabled = true;
  if (btnL) btnL.disabled = true;
  var msg = document.getElementById('settingsMsg');
  if (msg) msg.textContent = 'Saving mode…';
  google.script.run
    .withSuccessHandler(function (info) {
      // Re-fetch the full mode info (URLs, etc.)
      google.script.run
        .withSuccessHandler(applySiteModeToUI)
        .adminGetSiteMode();
      if (msg) msg.textContent = 'Site mode is now ' + (info && info.mode ? info.mode.toUpperCase() : '?') + '.';
      setTimeout(function () { if (msg && msg.textContent.indexOf('Site mode') === 0) msg.textContent = ''; }, 4000);
    })
    .withFailureHandler(function (err) {
      if (msg) msg.textContent = 'Mode change failed: ' + (err && err.message ? err.message : err);
      if (btnT) btnT.disabled = false;
      if (btnL) btnL.disabled = false;
    })
    .adminSetSiteMode(mode);
}

function applySettingsToUI(s) {
  s = s || {};
  ['directBookingStay', 'directBookingCourse'].forEach(function (k) {
    var checkbox = document.getElementById('toggle-' + k);
    var state = document.getElementById('state-' + k);
    var on = !!s[k];
    if (checkbox) checkbox.checked = on;
    if (state) {
      state.textContent = on ? 'ON — guests can book + pay directly' : 'OFF — guests submit a request, you accept';
      state.classList.toggle('is-on', on);
      state.classList.toggle('is-off', !on);
    }
  });
  // Permaculture phone numbers
  var phones = s.permaculturePhones || {};
  var bus = document.getElementById('permaPhoneBusiness');
  var aft = document.getElementById('permaPhoneAfterHours');
  var wk  = document.getElementById('permaPhoneWeekend');
  if (bus) { bus.value = phones.business   || '416-254-7104'; bus.disabled = false; }
  if (aft) { aft.value = phones.afterHours || '416-254-7104'; aft.disabled = false; }
  if (wk)  { wk.value  = phones.weekend    || '416-254-7104'; wk.disabled  = false; }
  var btn = document.getElementById('permaPhonesSaveBtn');
  if (btn) btn.disabled = false;
}

function setSettingsToggleEnabled(enabled) {
  ['directBookingStay', 'directBookingCourse'].forEach(function (k) {
    var checkbox = document.getElementById('toggle-' + k);
    if (checkbox) checkbox.disabled = !enabled;
  });
}

function savePermaculturePhones() {
  var bus = document.getElementById('permaPhoneBusiness');
  var aft = document.getElementById('permaPhoneAfterHours');
  var wk  = document.getElementById('permaPhoneWeekend');
  var btn = document.getElementById('permaPhonesSaveBtn');
  var msg = document.getElementById('permaPhonesStatus');
  if (!bus || !aft || !wk) return;
  var payload = {
    permaculturePhones: {
      business:   bus.value.trim(),
      afterHours: aft.value.trim(),
      weekend:    wk.value.trim()
    }
  };
  if (btn) btn.disabled = true;
  if (msg) { msg.textContent = 'Saving…'; msg.style.color = '#888'; }
  google.script.run
    .withSuccessHandler(function (s) {
      applySettingsToUI(s);
      if (btn) btn.disabled = false;
      if (msg) { msg.textContent = '✓ Saved · ' + new Date().toLocaleTimeString(); msg.style.color = '#3d8c40'; }
      setTimeout(function () { if (msg && msg.textContent.indexOf('✓') === 0) msg.textContent = ''; }, 4000);
    })
    .withFailureHandler(function (err) {
      if (btn) btn.disabled = false;
      if (msg) { msg.textContent = '⚠ Save failed: ' + (err && err.message ? err.message : err); msg.style.color = '#b71c1c'; }
    })
    .adminUpdateSettings(payload);
}

// ===== PRICING TAB =====
const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
let pricingCache = null;

function loadPricing() {
  var msg = document.getElementById('pricingMsg');
  if (msg) msg.textContent = 'Loading pricing…';
  google.script.run
    .withSuccessHandler(function (cfg) {
      pricingCache = cfg;
      renderPricingMatrix(cfg);
      renderOverrides(cfg);
      renderWeeklyDiscount(cfg);
      refreshCopyYearOptions();
      if (msg) msg.textContent = '';
    })
    .withFailureHandler(function (err) { if (msg) msg.textContent = 'Error: ' + (err && err.message ? err.message : err); })
    .adminGetPricing();
  // Extras config loads in parallel so the editor renders alongside the pricing matrix.
  loadExtras();
}

// ----- Extras editor -----
var extrasCache = null;
var EXTRAS_META = [
  { key: 'adult',  title: 'Extra adult surcharge', sub: 'Charged on adults above the threshold (e.g. 10 ⇒ start charging the 11th adult).', thresholdLabel: 'Start charging above (# of adults)' },
  { key: 'pet',    title: 'Pet fee',               sub: 'Charged per pet on the booking.',                                                  thresholdLabel: 'Start charging above (# of pets)' },
  { key: 'bunkie', title: 'Forest Bunkie add-on',  sub: 'Optional Forest Bunkie cabin attached to the stay.',                                thresholdLabel: 'Start charging above (#)' },
  { key: 'tent',   title: 'Bell Tent add-on',      sub: 'Optional 13ft White Duck bell tents (up to 4).',                                    thresholdLabel: 'Start charging above (# of tents)' },
];

function loadExtras() {
  var wrap = document.getElementById('extrasList');
  if (!wrap) return;
  wrap.innerHTML = '<div style="font-size:13px;color:#888;font-style:italic;padding:8px 0">Loading extras…</div>';
  google.script.run
    .withSuccessHandler(function (cfg) {
      extrasCache = cfg;
      renderExtras(cfg);
    })
    .withFailureHandler(function (err) {
      wrap.innerHTML = '<div style="font-size:13px;color:#c00">Error loading extras: ' + esc(err && err.message ? err.message : err) + '</div>';
    })
    .adminGetExtras();
}

function renderExtras(cfg) {
  var wrap = document.getElementById('extrasList');
  if (!wrap) return;
  wrap.innerHTML = EXTRAS_META.map(function (meta) {
    var line = (cfg && cfg[meta.key]) || {};
    var enabled = line.enabled !== false;
    var perNight = line.perNight !== false;
    var price = (line.price != null) ? line.price : 0;
    var threshold = (line.threshold != null) ? line.threshold : 0;
    var label = line.label || meta.title;
    return ''
      + '<div data-extras-key="' + meta.key + '" style="padding:14px 16px;background:#f9f9f6;border:1px solid #e0ddd6;border-radius:10px">'
      +   '<div style="display:flex;justify-content:space-between;align-items:flex-start;gap:10px;flex-wrap:wrap;margin-bottom:10px">'
      +     '<div style="flex:1;min-width:220px">'
      +       '<div style="font-weight:600;font-size:14px;display:flex;align-items:center;gap:8px">'
      +         esc(meta.title)
      +         '<span class="extras-saved-msg" style="font-size:12px;color:#2e6e31;display:none;font-weight:500">✓ Saved</span>'
      +       '</div>'
      +       '<div style="font-size:12px;color:#888;margin-top:2px">' + esc(meta.sub) + '</div>'
      +     '</div>'
      +     '<label style="display:flex;align-items:center;gap:6px;font-size:12px;color:#666;cursor:pointer">'
      +       '<input type="checkbox" data-field="enabled"' + (enabled ? ' checked' : '') + ' style="cursor:pointer">'
      +       'Active'
      +     '</label>'
      +   '</div>'
      +   '<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(170px,1fr));gap:10px;align-items:end">'
      +     '<div>'
      +       '<label style="display:block;font-size:11px;color:#666;margin-bottom:3px">' + esc(meta.thresholdLabel) + '</label>'
      +       '<input type="number" data-field="threshold" min="0" step="1" value="' + Number(threshold) + '" style="width:100%;padding:8px;border:1px solid #ddd;border-radius:6px;font-size:13px;font-variant-numeric:tabular-nums">'
      +     '</div>'
      +     '<div>'
      +       '<label style="display:block;font-size:11px;color:#666;margin-bottom:3px">Price ($)</label>'
      +       '<input type="number" data-field="price" min="0" step="1" value="' + Number(price) + '" style="width:100%;padding:8px;border:1px solid #ddd;border-radius:6px;font-size:13px;text-align:right;font-variant-numeric:tabular-nums">'
      +     '</div>'
      +     '<div>'
      +       '<label style="display:block;font-size:11px;color:#666;margin-bottom:3px">Per</label>'
      +       '<select data-field="perNight" style="width:100%;padding:8px;border:1px solid #ddd;border-radius:6px;font-size:13px;background:#fff">'
      +         '<option value="night"' + (perNight ? ' selected' : '') + '>Per night</option>'
      +         '<option value="stay"'  + (!perNight ? ' selected' : '') + '>Per stay (flat)</option>'
      +       '</select>'
      +     '</div>'
      +     '<div>'
      +       '<label style="display:block;font-size:11px;color:#666;margin-bottom:3px">Display label</label>'
      +       '<input type="text" data-field="label" value="' + esc(label) + '" style="width:100%;padding:8px;border:1px solid #ddd;border-radius:6px;font-size:13px">'
      +     '</div>'
      +     '<div style="display:flex;gap:6px;align-items:end">'
      +       '<button class="btn btn-primary" style="flex:1" onclick="saveExtraLine(\\'' + meta.key + '\\', this)">Save</button>'
      +       '<button class="btn" title="Reset this line to default" onclick="resetExtraLine(\\'' + meta.key + '\\')">↺</button>'
      +     '</div>'
      +   '</div>'
      + '</div>';
  }).join('');
}

function _readExtraRow(key) {
  var row = document.querySelector('[data-extras-key="' + key + '"]');
  if (!row) return null;
  var enabledEl   = row.querySelector('input[data-field="enabled"]');
  var thresholdEl = row.querySelector('input[data-field="threshold"]');
  var priceEl     = row.querySelector('input[data-field="price"]');
  var perNightEl  = row.querySelector('select[data-field="perNight"]');
  var labelEl     = row.querySelector('input[data-field="label"]');
  return {
    key: key,
    enabled: !!(enabledEl && enabledEl.checked),
    threshold: Math.max(0, parseInt((thresholdEl && thresholdEl.value) || 0, 10) || 0),
    price: Math.max(0, Number((priceEl && priceEl.value) || 0) || 0),
    perNight: perNightEl ? (perNightEl.value === 'night') : true,
    label: (labelEl && labelEl.value || '').trim(),
  };
}

function saveExtraLine(key, btn) {
  var payload = _readExtraRow(key);
  if (!payload) return;
  var row = btn ? btn.closest('[data-extras-key]') : null;
  var savedMsg = row && row.querySelector('.extras-saved-msg');
  if (btn) { btn.disabled = true; btn.textContent = 'Saving…'; }
  if (savedMsg) savedMsg.style.display = 'none';
  google.script.run
    .withSuccessHandler(function (cfg) {
      extrasCache = cfg;
      if (btn) { btn.disabled = false; btn.textContent = 'Save'; }
      if (savedMsg) {
        savedMsg.style.display = '';
        setTimeout(function () { savedMsg.style.display = 'none'; }, 2500);
      }
    })
    .withFailureHandler(function (err) {
      if (btn) { btn.disabled = false; btn.textContent = 'Save'; }
      var msg = document.getElementById('pricingMsg');
      if (msg) msg.textContent = 'Save failed: ' + (err && err.message ? err.message : err);
    })
    .adminUpdateExtraLine(payload);
}

function resetExtraLine(key) {
  if (!confirm('Reset the "' + key + '" line back to its default values?')) return;
  var msg = document.getElementById('pricingMsg');
  google.script.run
    .withSuccessHandler(function (cfg) {
      extrasCache = cfg;
      renderExtras(cfg);
      if (msg) msg.textContent = 'Reset to default.';
      setTimeout(function () { if (msg && msg.textContent === 'Reset to default.') msg.textContent = ''; }, 2500);
    })
    .withFailureHandler(function (err) { if (msg) msg.textContent = 'Reset failed: ' + (err && err.message ? err.message : err); })
    .adminResetExtras(key);
}

function resetAllExtras() {
  if (!confirm('Reset ALL extras (Adult, Pet, Bunkie, Tent) back to factory defaults?')) return;
  var msg = document.getElementById('pricingMsg');
  google.script.run
    .withSuccessHandler(function (cfg) {
      extrasCache = cfg;
      renderExtras(cfg);
      if (msg) msg.textContent = 'All extras reset to default.';
      setTimeout(function () { if (msg && msg.textContent === 'All extras reset to default.') msg.textContent = ''; }, 3000);
    })
    .withFailureHandler(function (err) { if (msg) msg.textContent = 'Reset failed: ' + (err && err.message ? err.message : err); })
    .adminResetExtras();
}

function renderPricingMatrix(cfg) {
  var tbody = document.getElementById('pricingMatrixBody');
  if (!tbody) return;
  var html = '';
  for (var m = 0; m < 12; m++) {
    var row = (cfg.baseRates && cfg.baseRates[String(m)]) || [0, 0, 0, 0, 0, 0, 0];
    html += '<tr>';
    html += '<td style="padding:8px 10px;border-bottom:1px solid #eee;font-weight:600">' + MONTH_NAMES[m] + '</td>';
    for (var d = 0; d < 7; d++) {
      var rate = row[d] || 0;
      var isWeekend = (d === 0 || d === 5 || d === 6);
      html += '<td style="padding:6px 4px;border-bottom:1px solid #eee;background:' + (isWeekend ? '#faf8f3' : '#fff') + '">' +
        '<input type="number" min="0" step="10" data-month="' + m + '" data-day="' + d + '" value="' + rate + '" ' +
        'style="width:100%;padding:6px 8px;border:1px solid #ddd;border-radius:6px;font-size:13px;text-align:right;font-variant-numeric:tabular-nums">' +
        '</td>';
    }
    html += '</tr>';
  }
  tbody.innerHTML = html;
}

function saveAllBaseRates() {
  var btn = document.getElementById('savePricingBtn');
  if (btn) { btn.disabled = true; btn.textContent = 'Saving…'; }
  var matrix = {};
  document.querySelectorAll('#pricingMatrixBody input[type="number"]').forEach(function (input) {
    var m = input.dataset.month;
    var d = parseInt(input.dataset.day, 10);
    if (!matrix[m]) matrix[m] = [0, 0, 0, 0, 0, 0, 0];
    matrix[m][d] = Math.max(0, Number(input.value) || 0);
  });
  var msg = document.getElementById('pricingMsg');
  google.script.run
    .withSuccessHandler(function (cfg) {
      pricingCache = cfg;
      if (msg) msg.textContent = 'Pricing matrix saved.';
      setTimeout(function () { if (msg && msg.textContent === 'Pricing matrix saved.') msg.textContent = ''; }, 3000);
      if (btn) { btn.disabled = false; btn.textContent = 'Save All'; }
    })
    .withFailureHandler(function (err) {
      if (msg) msg.textContent = 'Save failed: ' + (err && err.message ? err.message : err);
      if (btn) { btn.disabled = false; btn.textContent = 'Save All'; }
    })
    .adminUpdateAllBaseRates(matrix);
}

function resetPricingMatrix() {
  if (!confirm('Reset all 84 cells to the default $650/night? Date overrides and the weekly discount stay as-is.')) return;
  var matrix = {};
  for (var m = 0; m < 12; m++) {
    matrix[String(m)] = [650, 650, 650, 650, 650, 650, 650];
  }
  var msg = document.getElementById('pricingMsg');
  google.script.run
    .withSuccessHandler(function (cfg) {
      pricingCache = cfg;
      renderPricingMatrix(cfg);
      if (msg) msg.textContent = 'Reset to default.';
      setTimeout(function () { if (msg && msg.textContent === 'Reset to default.') msg.textContent = ''; }, 3000);
    })
    .withFailureHandler(function (err) { if (msg) msg.textContent = 'Reset failed: ' + (err && err.message ? err.message : err); })
    .adminUpdateAllBaseRates(matrix);
}

function renderOverrides(cfg) {
  var wrap = document.getElementById('overridesList');
  if (!wrap) return;
  var overrides = (cfg && cfg.overrides) || [];
  if (overrides.length === 0) {
    wrap.innerHTML = '<div style="font-size:13px;color:#888;font-style:italic;padding:8px 0">No overrides yet. Add a holiday or long-weekend override below.</div>';
    return;
  }
  // Editable rows — price and label are inline inputs. Save writes via adminUpsertOverride
  // (which updates by date), Remove deletes via adminDeleteOverride.
  wrap.innerHTML = '<div style="display:flex;flex-direction:column;gap:8px">' +
    overrides.map(function (o) {
      var safeDate = esc(o.date);
      return '<div data-override-date="' + safeDate + '" style="display:flex;align-items:center;gap:10px;padding:10px 14px;background:#f9f9f6;border:1px solid #e0ddd6;border-radius:8px;flex-wrap:wrap">' +
        '<div style="font-weight:600;min-width:110px;font-variant-numeric:tabular-nums">' + safeDate + '</div>' +
        '<div style="display:flex;align-items:center;gap:4px">' +
          '<span style="color:#888;font-size:13px">$</span>' +
          '<input type="number" min="0" step="10" data-field="price" value="' + Number(o.price) + '" style="width:90px;padding:6px 8px;border:1px solid #ddd;border-radius:6px;font-size:13px;text-align:right;font-variant-numeric:tabular-nums">' +
        '</div>' +
        '<input type="text" data-field="label" value="' + esc(o.label || '') + '" placeholder="Label (e.g. Christmas Day)" style="flex:1;min-width:160px;padding:6px 10px;border:1px solid #ddd;border-radius:6px;font-size:13px">' +
        '<button class="btn btn-primary" onclick="saveOverride(\\'' + safeDate + '\\', this)">Save</button>' +
        '<button class="btn btn-danger" onclick="deleteOverride(\\'' + safeDate + '\\')">Remove</button>' +
        '<span class="override-saved-msg" style="font-size:12px;color:#2e6e31;display:none">✓ Saved</span>' +
        '</div>';
    }).join('') +
    '</div>';
}

// Bulk-save every override row at once. Reads each row's current price + label inputs
// and writes them all in a single server call. Useful after seeding Ontario holidays
// at $650 then bumping a bunch in place.
function saveAllOverrides() {
  var btn = document.getElementById('saveAllOverridesBtn');
  if (btn) { btn.disabled = true; btn.textContent = 'Saving…'; }
  var msg = document.getElementById('pricingMsg');
  var rows = document.querySelectorAll('#overridesList [data-override-date]');
  var payload = [];
  rows.forEach(function (row) {
    var date = row.getAttribute('data-override-date');
    var priceInput = row.querySelector('input[data-field="price"]');
    var labelInput = row.querySelector('input[data-field="label"]');
    if (!date || !priceInput) return;
    payload.push({
      date: date,
      price: Math.max(0, Number(priceInput.value) || 0),
      label: (labelInput && labelInput.value || '').trim(),
    });
  });
  google.script.run
    .withSuccessHandler(function (cfg) {
      pricingCache = cfg;
      renderOverrides(cfg);
      if (btn) { btn.disabled = false; btn.textContent = 'Save All Overrides'; }
      if (msg) msg.textContent = 'Saved ' + payload.length + ' override' + (payload.length === 1 ? '' : 's') + '.';
      setTimeout(function () { if (msg && msg.textContent.indexOf('Saved') === 0) msg.textContent = ''; }, 4000);
    })
    .withFailureHandler(function (err) {
      if (btn) { btn.disabled = false; btn.textContent = 'Save All Overrides'; }
      if (msg) msg.textContent = 'Save failed: ' + (err && err.message ? err.message : err);
    })
    .adminUpdateAllOverrides(payload);
}

// Save edits to one override row in place (price + label). Date is the immutable key.
function saveOverride(date, btn) {
  var row = btn ? btn.closest('[data-override-date]') : null;
  if (!row) return;
  var priceInput = row.querySelector('input[data-field="price"]');
  var labelInput = row.querySelector('input[data-field="label"]');
  var savedMsg = row.querySelector('.override-saved-msg');
  var price = Math.max(0, Number(priceInput.value) || 0);
  var label = (labelInput.value || '').trim();
  btn.disabled = true; btn.textContent = 'Saving…';
  if (savedMsg) savedMsg.style.display = 'none';
  google.script.run
    .withSuccessHandler(function (cfg) {
      pricingCache = cfg;
      btn.disabled = false; btn.textContent = 'Save';
      if (savedMsg) {
        savedMsg.style.display = '';
        setTimeout(function () { savedMsg.style.display = 'none'; }, 2500);
      }
    })
    .withFailureHandler(function (err) {
      btn.disabled = false; btn.textContent = 'Save';
      var msg = document.getElementById('pricingMsg');
      if (msg) msg.textContent = 'Save failed: ' + (err && err.message ? err.message : err);
    })
    .adminUpsertOverride({ date: date, price: price, label: label });
}

function addOverride() {
  var date = (document.getElementById('newOverrideDate') || {}).value;
  var price = (document.getElementById('newOverridePrice') || {}).value;
  var label = (document.getElementById('newOverrideLabel') || {}).value;
  var msg = document.getElementById('pricingMsg');
  if (!date || !price) {
    if (msg) msg.textContent = 'Date and price are required.';
    return;
  }
  google.script.run
    .withSuccessHandler(function (cfg) {
      pricingCache = cfg;
      renderOverrides(cfg);
      document.getElementById('newOverrideDate').value = '';
      document.getElementById('newOverridePrice').value = '';
      document.getElementById('newOverrideLabel').value = '';
      if (msg) msg.textContent = 'Override saved.';
      setTimeout(function () { if (msg && msg.textContent === 'Override saved.') msg.textContent = ''; }, 3000);
    })
    .withFailureHandler(function (err) { if (msg) msg.textContent = 'Save failed: ' + (err && err.message ? err.message : err); })
    .adminUpsertOverride({ date: date, price: Number(price), label: label });
}

function seedOntarioHolidays() {
  var thisYear = new Date().getFullYear();
  var years = [thisYear, thisYear + 1];
  var yearLabel = years.join(' + ');
  if (!confirm('Add the Ontario holiday + long-weekend calendar for ' + yearLabel + ' at $650 each?\\n\\nDates that already have an override will be left untouched. You can edit any of them after.')) return;
  var btn = document.getElementById('seedHolidaysBtn');
  varseedLabel = '+ Seed Ontario holidays';
  if (btn) { btn.disabled = true; btn.textContent = 'Seeding…'; }
  var msg = document.getElementById('pricingMsg');
  google.script.run
    .withSuccessHandler(function (result) {
      pricingCache = result.config;
      renderOverrides(result.config);
      refreshCopyYearOptions();
      if (msg) msg.textContent = 'Added ' + result.added + ' holiday' + (result.added === 1 ? '' : 's') + ' for ' + result.years.join(' + ') + (result.skipped > 0 ? ' (' + result.skipped + ' already existed, skipped)' : '') + '.';
      setTimeout(function () { if (msg && msg.textContent.indexOf('Added') === 0) msg.textContent = ''; }, 6000);
      if (btn) { btn.disabled = false; btn.textContent = seedLabel; }
    })
    .withFailureHandler(function (err) {
      if (msg) msg.textContent = 'Seed failed: ' + (err && err.message ? err.message : err);
      if (btn) { btn.disabled = false; btn.textContent = seedLabel; }
    })
    .adminSeedOntarioHolidays(650, years);
}

function deleteOverride(date) {
  if (!confirm('Remove the override for ' + date + '?')) return;
  var msg = document.getElementById('pricingMsg');
  google.script.run
    .withSuccessHandler(function (cfg) {
      pricingCache = cfg;
      renderOverrides(cfg);
      if (msg) msg.textContent = 'Override removed.';
      setTimeout(function () { if (msg && msg.textContent === 'Override removed.') msg.textContent = ''; }, 3000);
    })
    .withFailureHandler(function (err) { if (msg) msg.textContent = 'Remove failed: ' + (err && err.message ? err.message : err); })
    .adminDeleteOverride(date);
}

// ----- Copy overrides from one year to another -----
// Preview first, then apply. The server recomputes the plan on apply, so what
// is confirmed is exactly what gets written.
var copyYearPlan = null;

function _copyYearInputs() {
  var g = function (id) { return document.getElementById(id); };
  return {
    fromYear: parseInt((g('copyFromYear') || {}).value, 10),
    toYear: parseInt((g('copyToYear') || {}).value, 10),
    percentIncrease: Number((g('copyPercent') || {}).value || 0),
    roundTo: parseInt((g('copyRoundTo') || {}).value, 10) || 1,
    clearOthers: !!((g('copyClearOthers') || {}).checked),
  };
}

function previewCopyYear() {
  var btn = document.getElementById('copyPreviewBtn');
  var out = document.getElementById('copyYearPreview');
  var applyBtn = document.getElementById('copyApplyBtn');
  if (applyBtn) applyBtn.style.display = 'none';
  copyYearPlan = null;
  if (btn) { btn.disabled = true; btn.textContent = 'Checking…'; }
  if (out) out.innerHTML = '<div style="font-size:13px;color:#888;font-style:italic;padding:8px 0">Building preview…</div>';
  google.script.run
    .withSuccessHandler(function (plan) {
      copyYearPlan = plan;
      renderCopyYearPreview(plan);
      if (btn) { btn.disabled = false; btn.textContent = 'Preview copy'; }
    })
    .withFailureHandler(function (err) {
      if (btn) { btn.disabled = false; btn.textContent = 'Preview copy'; }
      if (out) out.innerHTML = '<div style="font-size:13px;color:#dc3545;padding:8px 0">' + esc(err && err.message ? err.message : String(err)) + '</div>';
    })
    .adminPreviewCopyOverridesToYear(_copyYearInputs());
}

function renderCopyYearPreview(plan) {
  var out = document.getElementById('copyYearPreview');
  var applyBtn = document.getElementById('copyApplyBtn');
  if (!out) return;
  if (!plan || !plan.entries || plan.entries.length === 0) {
    out.innerHTML = '<div style="font-size:13px;color:#b45309;padding:8px 0">No overrides found for ' + plan.fromYear + ' — nothing to copy.</div>';
    return;
  }

  var summary = plan.entries.length + ' override' + (plan.entries.length === 1 ? '' : 's') +
    ' &rarr; ' + plan.toYear + ' &middot; ' + plan.createCount + ' new, ' + plan.replaceCount + ' replaced';
  if (plan.shiftedCount > 0) summary += ' &middot; ' + plan.shiftedCount + ' moved to follow the holiday';
  if (plan.unmatchedCount > 0) summary += ' &middot; ' + plan.unmatchedCount + ' copied by date';

  var rows = plan.entries.map(function (e) {
    var note = '';
    if (e.matchedBy === 'holiday' && e.shifted) {
      note = '<span style="color:#2e6e31;font-size:11px">follows ' + esc(e.holiday) + '</span>';
    } else if (e.matchedBy === 'date') {
      note = '<span style="color:#b45309;font-size:11px">not a holiday &mdash; same date, check the weekday</span>';
    }
    var priceCell = '$' + Number(e.fromPrice) + ' &rarr; <strong>$' + Number(e.toPrice) + '</strong>';
    if (e.replacesExisting) {
      priceCell += ' <span style="color:#dc3545;font-size:11px">(replaces $' + Number(e.existingPrice) + ')</span>';
    }
    return '<tr>' +
      '<td style="padding:5px 8px;border-bottom:1px solid #f0eee8;font-variant-numeric:tabular-nums;white-space:nowrap">' + esc(e.fromDate) + '</td>' +
      '<td style="padding:5px 8px;border-bottom:1px solid #f0eee8;font-variant-numeric:tabular-nums;white-space:nowrap;font-weight:600">' + esc(e.toDate) + '</td>' +
      '<td style="padding:5px 8px;border-bottom:1px solid #f0eee8">' + esc(e.label || '') + ' ' + note + '</td>' +
      '<td style="padding:5px 8px;border-bottom:1px solid #f0eee8;text-align:right;white-space:nowrap;font-variant-numeric:tabular-nums">' + priceCell + '</td>' +
      '</tr>';
  }).join('');

  var orphanHtml = '';
  if (plan.orphans && plan.orphans.length > 0) {
    var list = plan.orphans.map(function (o) {
      return esc(o.date) + ' ($' + Number(o.price) + (o.label ? ' &middot; ' + esc(o.label) : '') + ')';
    }).join(', ');
    orphanHtml = '<div style="margin-top:10px;padding:9px 12px;background:#fdf6e7;border:1px solid #f0e0b8;border-radius:6px;font-size:12px;color:#7a5a12">' +
      '<strong>' + plan.orphans.length + ' existing ' + plan.toYear + ' override' + (plan.orphans.length === 1 ? '' : 's') + ' not part of this copy:</strong> ' + list +
      '<br>' + (plan.clearOthers
        ? 'These <strong>will be deleted</strong> because "remove other overrides" is ticked.'
        : 'These will be left alone. Tick "remove other overrides" above to clear them.') +
      '</div>';
  }

  out.innerHTML =
    '<div style="font-size:13px;color:#444;margin:12px 0 8px">' + summary + '</div>' +
    '<div style="max-height:320px;overflow:auto;border:1px solid #e0ddd6;border-radius:8px">' +
      '<table style="width:100%;border-collapse:collapse;font-size:12.5px">' +
        '<thead><tr style="background:#f5f3ee">' +
          '<th style="padding:6px 8px;text-align:left;color:#888;font-weight:600;white-space:nowrap">From</th>' +
          '<th style="padding:6px 8px;text-align:left;color:#888;font-weight:600;white-space:nowrap">To</th>' +
          '<th style="padding:6px 8px;text-align:left;color:#888;font-weight:600">Label</th>' +
          '<th style="padding:6px 8px;text-align:right;color:#888;font-weight:600">Price</th>' +
        '</tr></thead>' + +
        '<tbody>' + rows + '</tbody>' +
      '</table>' +
    '</div>' + orphanHtml;

  if (applyBtn) {
    applyBtn.style.display = '';
    applyBtn.textContent = 'Apply — write ' + plan.entries.length + ' override' + (plan.entries.length === 1 ? '' : 's') + ' to ' + plan.toYear;
  }
}

function applyCopyYear() {
  if (!copyYearPlan) return;
  var plan = copyYearPlan;
  var warn = plan.replaceCount > 0
    ? '\\n\\n' + plan.replaceCount + ' existing ' + plan.toYear + ' override' + (plan.replaceCount === 1 ? '' : 's') + ' will be overwritten.'
    : '';
  if (plan.clearOthers && plan.orphans.length > 0) {
    warn += '\\n' + plan.orphans.length + ' other ' + plan.toYear + ' override' + (plan.orphans.length === 1 ? '' : 's') + ' will be deleted.';
  }
  if (!confirm('Copy ' + plan.entries.length + ' override' + (plan.entries.length === 1 ? '' : 's') +
      ' from ' + plan.fromYear + ' to ' + plan.toYear +
      (plan.percentIncrease ? ' with a ' + plan.percentIncrease + '% change' : ' at the same prices') + '?' + warn)) return;

  var btn = document.getElementById('copyApplyBtn');
  var msg = document.getElementById('pricingMsg');
  if (btn) { btn.disabled = true; btn.textContent = 'Writing…'; }
  google.script.run
    .withSuccessHandler(function (res) {
      pricingCache = res.config;
      renderOverrides(res.config);
      refreshCopyYearOptions();
      copyYearPlan = null;
      var out = document.getElementById('copyYearPreview');
      if (out) out.innerHTML = '';
      if (btn) { btn.disabled = false; btn.style.display = 'none'; }
      if (msg) {
        msg.textContent = 'Copied ' + res.written + ' override' + (res.written === 1 ? '' : 's') + ' to ' + res.toYear +
          ' (' + res.created + ' new, ' + res.replaced + ' replaced' + (res.removed ? ', ' + res.removed + ' removed' : '') + ').';
        setTimeout(function () { if (msg && msg.textContent.indexOf('Copied') === 0) msg.textContent = ''; }, 8000);
      }
    })
    .withFailureHandler(function (err) {
      if (btn) { btn.disabled = false; btn.textContent = 'Apply'; }
      if (msg) msg.textContent = 'Copy failed: ' + (err && err.message ? err.message : err);
    })
    .adminApplyCopyOverridesToYear(_copyYearInputs());
}

// Populates the From-year dropdown with the years that actually have overrides.
function refreshCopyYearOptions() {
  var sel = document.getElementById('copyFromYear');
  var to = document.getElementById('copyToYear');
  if (!sel) return;
  google.script.run
    .withSuccessHandler(function (years) {
      var current = sel.value;
      if (!years || years.length === 0) {
        sel.innerHTML = '<option value="">No overrides yet</option>';
        return;
      }
      sel.innerHTML = years.map(function (y) {
        return '<option value="' + y.year + '">' + y.year + ' (' + y.count + ')</option>';
      }).join('');
      var pick = current && years.some(function (y) { return String(y.year) === current; })
        ? current
        : String(years[0].year);
      sel.value = pick;
      if (to && !to.value) to.value = String(parseInt(pick, 10) + 1);
    })
    .withFailureHandler(function () {})
    .adminGetOverrideYears();
}


function renderWeeklyDiscount(cfg) {
  var wd = (cfg && cfg.weeklyDiscount) || { thresholdNights: 7, percentOff: 15 };
  var t = document.getElementById('weeklyDiscountThreshold');
  var p = document.getElementById('weeklyDiscountPercent');
  if (t) t.value = wd.thresholdNights;
  if (p) p.value = wd.percentOff;
}

function saveWeeklyDiscount() {
  var t = document.getElementById('weeklyDiscountThreshold');
  var p = document.getElementById('weeklyDiscountPercent');
  var threshold = t ? parseInt(t.value, 10) : 7;
  var percent = p ? Number(p.value) : 15;
  var msg = document.getElementById('pricingMsg');
  google.script.run
    .withSuccessHandler(function (cfg) {
      pricingCache = cfg;
      renderWeeklyDiscount(cfg);
      if (msg) msg.textContent = 'Weekly discount saved.';
      setTimeout(function () { if (msg && msg.textContent === 'Weekly discount saved.') msg.textContent = ''; }, 3000);
    })
    .withFailureHandler(function (err) { if (msg) msg.textContent = 'Save failed: ' + (err && err.message ? err.message : err); })
    .adminUpdateWeeklyDiscount({ thresholdNights: threshold, percentOff: percent });
}

document.addEventListener('change', function (e) {
  var t = e.target;
  if (!t || !t.id || t.id.indexOf('toggle-') !== 0) return;
  var key = t.id.replace('toggle-', '');
  if (key !== 'directBookingStay' && key !== 'directBookingCourse') return;
  var msg = document.getElementById('settingsMsg');
  var newVal = !!t.checked;
  setSettingsToggleEnabled(false);
  if (msg) msg.textContent = 'Saving…';
  var update = {}; update[key] = newVal;
  google.script.run
    .withSuccessHandler(function (s) {
      applySettingsToUI(s);
      setSettingsToggleEnabled(true);
      if (msg) msg.textContent = 'Saved. ' + (newVal ? 'Direct booking is now ON for ' + (key === 'directBookingStay' ? 'farm stays' : 'courses') + '.' : 'Direct booking is now OFF for ' + (key === 'directBookingStay' ? 'farm stays' : 'courses') + '.');
      setTimeout(function () { if (msg && msg.textContent.indexOf('Saved') === 0) msg.textContent = ''; }, 4000);
    })
    .withFailureHandler(function (err) {
      // Revert UI to last known server state on failure
      t.checked = !newVal;
      setSettingsToggleEnabled(true);
      if (msg) msg.textContent = 'Save failed: ' + (err && err.message ? err.message : err);
    })
    .adminUpdateSettings(update);
});

// Year selector on monthly chart
document.querySelectorAll('.year-btn').forEach(b => {
  b.addEventListener('click', () => {
    document.querySelectorAll('.year-btn').forEach(x => x.classList.remove('active'));
    b.classList.add('active');
    renderMonthlyChart(parseInt(b.dataset.yearOffset));
  });
});

// ===== ANALYTICS =====
let monthlyChartInstance = null;
let projectionChartInstance = null;
let occupancyChartInstance = null;
let pipelineChartInstance = null;

// Lock the canvas to its wrapper's pixel size BEFORE creating the chart, so we can run with
// responsive:false. This is the only reliable way to stop the ResizeObserver feedback loop
// inside the Apps Script auto-resizing iframe — CSS clipping alone doesn't stop Chart.js from
// growing the canvas internally on each redraw.
function sizeChartCanvas(canvasId) {
  const c = document.getElementById(canvasId);
  if (!c) return;
  const wrap = c.parentElement;
  const w = wrap.clientWidth || 600;
  const h = wrap.clientHeight || 300;
  const dpr = window.devicePixelRatio || 1;
  c.style.width = w + 'px';
  c.style.height = h + 'px';
  c.width = Math.round(w * dpr);
  c.height = Math.round(h * dpr);
}

function renderAnalytics() {
  renderMonthlyChart(0);
  renderProjectionChart();
  renderOccupancyChart();
  renderPipelineChart();
}

function parseDateSafe(s) {
  if (!s) return null;
  const m = String(s).match(/^(\\d{4})-(\\d{2})-(\\d{2})/);
  if (m) return new Date(+m[1], +m[2]-1, +m[3]);
  const d = new Date(s);
  return isNaN(d.getTime()) ? null : d;
}

function monthBucket(date) {
  return date.getFullYear() + '-' + String(date.getMonth()+1).padStart(2,'0');
}

function amountOf(b) {
  return Number(b.finalTotal) || Number(b.estimatedTotal) || 0;
}

function renderMonthlyChart(yearOffset) {
  if (!window.Chart) return;
  const year = new Date().getFullYear() + (yearOffset || 0);
  const months = [];
  const labels = [];
  for (let m = 0; m < 12; m++) {
    months.push(year + '-' + String(m+1).padStart(2,'0'));
    labels.push(new Date(year, m, 1).toLocaleDateString('en-US', {month:'short'}));
  }
  const confirmed = new Array(12).fill(0);
  const awaiting = new Array(12).fill(0);
  const pending = new Array(12).fill(0);
  allBookings.forEach(b => {
    const ci = parseDateSafe(b.checkin);
    if (!ci || ci.getFullYear() !== year) return;
    const idx = ci.getMonth();
    const amt = amountOf(b);
    if (b.status === 'Confirmed') confirmed[idx] += amt;
    else if (b.status === 'Awaiting Payment' || b.status === 'Awaiting Confirmation') awaiting[idx] += amt;
    else if (b.status === 'Pending') pending[idx] += amt;
  });

  if (monthlyChartInstance) monthlyChartInstance.destroy();
  sizeChartCanvas('monthlyChart');
  const ctx = document.getElementById('monthlyChart').getContext('2d');
  monthlyChartInstance = new Chart(ctx, {
    type: 'bar',
    data: {
      labels: labels,
      datasets: [
        { label: 'Confirmed', data: confirmed, backgroundColor: '#2e6e31' },
        { label: 'Awaiting payment', data: awaiting, backgroundColor: '#7dc97f' },
        { label: 'Pending', data: pending, backgroundColor: '#f1c232' },
      ]
    },
    options: {
      responsive: false, maintainAspectRatio: false,
      scales: {
        x: { stacked: true, grid: { display: false } },
        y: { stacked: true, beginAtZero: true, ticks: { callback: v => '$' + v.toLocaleString() } }
      },
      plugins: {
        legend: { position: 'bottom', labels: { boxWidth: 12, font: { size: 12 } } },
        tooltip: { callbacks: { label: c => c.dataset.label + ': $' + (c.raw || 0).toLocaleString('en-CA', {minimumFractionDigits: 0, maximumFractionDigits: 0}) } }
      }
    }
  });
}

function renderProjectionChart() {
  if (!window.Chart) return;
  const now = new Date();
  const labels = [];
  const months = [];
  for (let i = 0; i < 12; i++) {
    const d = new Date(now.getFullYear(), now.getMonth() + i, 1);
    labels.push(d.toLocaleDateString('en-US', {month:'short', year:'2-digit'}));
    months.push(d.getFullYear() + '-' + String(d.getMonth()+1).padStart(2,'0'));
  }
  const committed = new Array(12).fill(0);
  const potential = new Array(12).fill(0);
  allBookings.forEach(b => {
    const ci = parseDateSafe(b.checkin);
    if (!ci) return;
    const key = monthBucket(ci);
    const idx = months.indexOf(key);
    if (idx === -1) return;
    const amt = amountOf(b);
    if (b.status === 'Confirmed' || b.status === 'Awaiting Payment' || b.status === 'Awaiting Confirmation') committed[idx] += amt;
    else if (b.status === 'Pending') potential[idx] += amt;
  });
  // Cumulative
  for (let i = 1; i < 12; i++) {
    committed[i] += committed[i-1];
    potential[i] += potential[i-1];
  }

  if (projectionChartInstance) projectionChartInstance.destroy();
  sizeChartCanvas('projectionChart');
  const ctx = document.getElementById('projectionChart').getContext('2d');
  projectionChartInstance = new Chart(ctx, {
    type: 'line',
    data: {
      labels: labels,
      datasets: [
        { label: 'Committed (cumulative)', data: committed, borderColor: '#2e6e31', backgroundColor: 'rgba(46,110,49,0.1)', fill: true, tension: 0.3 },
        { label: 'Committed + potential', data: committed.map((c,i) => c + potential[i]), borderColor: '#f1c232', backgroundColor: 'rgba(241,194,50,0.08)', fill: '-1', tension: 0.3, borderDash: [5,5] },
      ]
    },
    options: {
      responsive: false, maintainAspectRatio: false,
      scales: {
        x: { grid: { display: false } },
        y: { beginAtZero: true, ticks: { callback: v => '$' + v.toLocaleString() } }
      },
      plugins: {
        legend: { position: 'bottom', labels: { boxWidth: 12, font: { size: 12 } } },
        tooltip: { callbacks: { label: c => c.dataset.label + ': $' + (c.raw || 0).toLocaleString('en-CA', {minimumFractionDigits: 0, maximumFractionDigits: 0}) } }
      }
    }
  });
}

function renderOccupancyChart() {
  if (!window.Chart) return;
  const now = new Date();
  const labels = [];
  const months = [];
  for (let i = -2; i < 10; i++) {
    const d = new Date(now.getFullYear(), now.getMonth() + i, 1);
    labels.push(d.toLocaleDateString('en-US', {month:'short', year:'2-digit'}));
    months.push(d.getFullYear() + '-' + String(d.getMonth()+1).padStart(2,'0'));
  }
  const nights = new Array(12).fill(0);
  allBookings.forEach(b => {
    if (b.status !== 'Confirmed') return;
    const ci = parseDateSafe(b.checkin);
    if (!ci) return;
    const idx = months.indexOf(monthBucket(ci));
    if (idx === -1) return;
    nights[idx] += Number(b.nights) || 0;
  });

  if (occupancyChartInstance) occupancyChartInstance.destroy();
  sizeChartCanvas('occupancyChart');
  const ctx = document.getElementById('occupancyChart').getContext('2d');
  occupancyChartInstance = new Chart(ctx, {
    type: 'bar',
    data: { labels: labels, datasets: [{ label: 'Nights booked', data: nights, backgroundColor: '#4a9e56' }] },
    options: {
      responsive: false, maintainAspectRatio: false,
      scales: { x: { grid: { display: false } }, y: { beginAtZero: true, ticks: { stepSize: 1 } } },
      plugins: { legend: { display: false } }
    }
  });
}

function renderPipelineChart() {
  if (!window.Chart) return;
  const counts = { 'Pending': 0, 'Awaiting Payment': 0, 'Awaiting Confirmation': 0, 'Confirmed': 0, 'Declined': 0, 'Cancelled': 0, 'Expired': 0 };
  allBookings.forEach(b => {
    const key = (b.status === 'Cancelled — No refund') ? 'Cancelled' : b.status;
    if (counts[key] !== undefined) counts[key]++;
  });
  const labels = Object.keys(counts);
  const data = labels.map(k => counts[k]);
  const colors = ['#f1c232','#7dc97f','#2e6e31','#6c757d','#6c757d','#b45309'];

  if (pipelineChartInstance) pipelineChartInstance.destroy();
  sizeChartCanvas('pipelineChart');
  const ctx = document.getElementById('pipelineChart').getContext('2d');
  pipelineChartInstance = new Chart(ctx, {
    type: 'bar',
    data: { labels: labels, datasets: [{ data: data, backgroundColor: colors }] },
    options: {
      indexAxis: 'y',
      responsive: false, maintainAspectRatio: false,
      scales: { x: { beginAtZero: true, ticks: { stepSize: 1 } }, y: { grid: { display: false } } },
      plugins: { legend: { display: false } }
    }
  });
}

// Modals
function openModal(html) {
  document.getElementById('modalContent').innerHTML = html;
  document.getElementById('modal').classList.add('open');
}
function closeModal() { document.getElementById('modal').classList.remove('open'); }
document.getElementById('modal').addEventListener('click', e => { if (e.target.id === 'modal') closeModal(); });

function openAcceptModal(rowId) {
  const b = allBookings.find(x => x.rowId === rowId);
  openModal(\`
    <h2>Accept booking</h2>
    <p class="sub">\${esc(b.firstName)} \${esc(b.lastName)} · \${esc(b.checkin)} → \${esc(b.checkout)} · Estimated: \${fmtCurrency(b.estimatedTotal)}</p>
    <label>Final total (CAD, HST included)</label>
    <input type="number" id="fld-finalTotal" value="\${b.estimatedTotal}" step="0.01">
    <label>Optional message to guest</label>
    <textarea id="fld-customMessage" placeholder="Anything special to tell them…"></textarea>
    <div class="modal-actions">
      <button class="btn" onclick="closeModal()">Cancel</button>
      <button class="btn btn-primary" id="submitBtn" onclick="doAccept(\${rowId})">Accept & send</button>
    </div>
    <div id="modalMsg"></div>
  \`);
}
function doAccept(rowId) {
  const finalTotal = parseFloat(document.getElementById('fld-finalTotal').value);
  const customMessage = document.getElementById('fld-customMessage').value;
  submitAction(() => google.script.run.adminAccept(rowId, finalTotal, customMessage));
}

function openDeclineModal(rowId) {
  const b = allBookings.find(x => x.rowId === rowId);
  openModal(\`
    <h2>Decline booking</h2>
    <p class="sub">\${esc(b.firstName)} \${esc(b.lastName)} · \${esc(b.checkin)} → \${esc(b.checkout)}</p>
    <label>Message to guest (reason / alternative suggestion)</label>
    <textarea id="fld-declineMessage" placeholder="e.g. Those dates aren't available, but we have…"></textarea>
    <div class="modal-actions">
      <button class="btn" onclick="closeModal()">Back</button>
      <button class="btn btn-danger" id="submitBtn" onclick="doDecline(\${rowId})">Decline</button>
    </div>
    <div id="modalMsg"></div>
  \`);
}
function doDecline(rowId) {
  const msg = document.getElementById('fld-declineMessage').value;
  submitAction(() => google.script.run.adminDecline(rowId, msg));
}

function openMarkPaidModal(rowId) {
  const b = allBookings.find(x => x.rowId === rowId);
  openModal(\`
    <h2>Mark as Paid</h2>
    <p class="sub">\${esc(b.firstName)} \${esc(b.lastName)} · \${fmtCurrency(b.finalTotal)}</p>
    <label>Payment method</label>
    <select id="fld-paymentMethod">
      <option value="Stripe">Stripe (credit card)</option>
      <option value="e-Transfer">Interac e-Transfer</option>
      <option value="Manual">Manual / Other</option>
    </select>
    <label>Check-in instructions (this goes in the guest's confirmation email)</label>
    <textarea id="fld-checkinInstructions" placeholder="Arrival details, lockbox code, parking info…"></textarea>
    <label>Optional confirmation message</label>
    <textarea id="fld-confirmMessage" placeholder="See you soon!"></textarea>
    <div class="modal-actions">
      <button class="btn" onclick="closeModal()">Cancel</button>
      <button class="btn btn-primary" id="submitBtn" onclick="doMarkPaid(\${rowId})">Confirm & send final email</button>
    </div>
    <div id="modalMsg"></div>
  \`);
}
function doMarkPaid(rowId) {
  const paymentMethod = document.getElementById('fld-paymentMethod').value;
  const checkinInstructions = document.getElementById('fld-checkinInstructions').value;
  const confirmMessage = document.getElementById('fld-confirmMessage').value;
  submitAction(() => google.script.run.adminMarkPaid(rowId, paymentMethod, checkinInstructions, confirmMessage));
}

function openRescheduleModal(rowId) {
  const b = allBookings.find(x => x.rowId === rowId);
  openModal(\`
    <h2>Reschedule booking</h2>
    <p class="sub">\${esc(b.firstName)} \${esc(b.lastName)} · Current: \${esc(b.checkin)} → \${esc(b.checkout)}</p>
    <div class="row2">
      <div><label>New check-in</label><input type="date" id="fld-newCheckin" value="\${dateForInput(b.checkin)}"></div>
      <div><label>New checkout</label><input type="date" id="fld-newCheckout" value="\${dateForInput(b.checkout)}"></div>
    </div>
    <div class="row2">
      <div><label>Adults</label><input type="number" id="fld-newAdults" min="1" max="20" value="\${b.adults || b.guests || 1}"></div>
      <div><label>Children</label><input type="number" id="fld-newChildren" min="0" max="20" value="\${b.children || 0}"></div>
    </div>
    <div class="row2">
      <div><label>Infants</label><input type="number" id="fld-newInfants" min="0" max="10" value="\${b.infants || 0}"></div>
      <div><label>Pets</label><input type="number" id="fld-newPets" min="0" max="5" value="\${b.pets || 0}"></div>
    </div>
    <p style="font-size:12px;color:#888;margin-top:12px">The system will recalculate the new total. If the guest has already paid and the total changed, you'll need to settle the difference via Stripe manually.</p>
    <div class="modal-actions">
      <button class="btn" onclick="closeModal()">Cancel</button>
      <button class="btn btn-primary" id="submitBtn" onclick="doReschedule(\${rowId})">Apply changes</button>
    </div>
    <div id="modalMsg"></div>
  \`);
}
function dateForInput(s) {
  // Accept YYYY-MM-DD directly, or parse other formats
  if (!s) return '';
  const m = String(s).match(/^(\\d{4})-(\\d{2})-(\\d{2})/);
  if (m) return s.slice(0, 10);
  const d = new Date(s);
  if (isNaN(d.getTime())) return '';
  return d.getFullYear() + '-' + String(d.getMonth()+1).padStart(2,'0') + '-' + String(d.getDate()).padStart(2,'0');
}
function doReschedule(rowId) {
  const p = {
    newCheckin: document.getElementById('fld-newCheckin').value,
    newCheckout: document.getElementById('fld-newCheckout').value,
    newAdults: parseInt(document.getElementById('fld-newAdults').value) || 1,
    newChildren: parseInt(document.getElementById('fld-newChildren').value) || 0,
    newInfants: parseInt(document.getElementById('fld-newInfants').value) || 0,
    newPets: parseInt(document.getElementById('fld-newPets').value) || 0,
  };
  submitAction(() => google.script.run.adminReschedule(rowId, p));
}

function openCancelModal(rowId) {
  const b = allBookings.find(x => x.rowId === rowId);
  const days = daysFromNow(b.checkin);
  // Direct bookings in "Awaiting Confirmation" may have an in-flight Stripe charge —
  // surface that risk in the modal so the host knows to manually refund if needed.
  const isDirectAwaiting = b.status === 'Awaiting Confirmation';
  const directRefundNote = isDirectAwaiting
    ? ' <strong>This is a direct booking</strong> — if the guest already paid via Stripe, you\\'ll need to manually refund the charge in your Stripe Dashboard.'
    : '';
  const policyMsg = b.status !== 'Confirmed'
    ? 'This booking has not been Mark-Paid yet, so no refund is automatically processed — just confirming the cancellation.' + directRefundNote
    : (days > 30
        ? '✅ Over 30 days until check-in (' + days + ' days). Per the strict cancellation policy, the guest is entitled to a full refund of ' + fmtCurrency(b.finalTotal) + '. You will need to process the refund manually in Stripe.'
        : '🚫 Under 30 days until check-in (' + days + ' days). Per the strict cancellation policy, cancellations inside 30 days are NOT allowed from here. Please contact the guest directly to discuss next steps.');
  const canProceed = b.status !== 'Confirmed' || days > 30;
  openModal(\`
    <h2>Cancel booking</h2>
    <p class="sub">\${esc(b.firstName)} \${esc(b.lastName)} · \${esc(b.checkin)} → \${esc(b.checkout)}</p>
    <div style="background:\${canProceed ? '#f0f7ee' : '#fef3f2'};padding:12px 16px;border-radius:6px;font-size:13px;line-height:1.5;margin:12px 0">\${policyMsg}</div>
    <div class="modal-actions">
      <button class="btn" onclick="closeModal()">Back</button>
      \${canProceed ? '<button class="btn btn-danger" id="submitBtn" onclick="doCancel(' + rowId + ')">Confirm cancellation</button>' : ''}
    </div>
    <div id="modalMsg"></div>
  \`);
}
function daysFromNow(d) {
  if (!d) return null;
  const m = String(d).match(/^(\\d{4})-(\\d{2})-(\\d{2})/);
  const dt = m ? new Date(+m[1], +m[2]-1, +m[3]) : new Date(d);
  if (isNaN(dt.getTime())) return null;
  const today = new Date(); today.setHours(0,0,0,0); dt.setHours(0,0,0,0);
  return Math.round((dt - today) / (24*60*60*1000));
}
function doCancel(rowId) {
  submitAction(() => google.script.run.adminCancel(rowId));
}
function adminResendLink(rowId) {
  if (!confirm('Resend the payment link email to this guest?')) return;
  google.script.run.withSuccessHandler(() => { alert('Payment link resent.'); loadBookings(); }).withFailureHandler(e => alert('Error: ' + e.message)).adminResendLink(rowId);
}

// Generic submit helper
function submitAction(fn) {
  const btn = document.getElementById('submitBtn');
  if (btn) { btn.disabled = true; btn.textContent = 'Working…'; }
  fn()
    .withSuccessHandler(() => {
      closeModal();
      loadBookings();
    })
    .withFailureHandler(err => {
      const msg = document.getElementById('modalMsg');
      if (msg) { msg.className = 'msg msg-error'; msg.textContent = 'Error: ' + err.message; }
      if (btn) { btn.disabled = false; btn.textContent = 'Retry'; }
    });
}

// Monkey-patch: our helper uses fn() which returns a Runner, so call with handlers — rewrite
function submitAction(fn) {
  const btn = document.getElementById('submitBtn');
  if (btn) { btn.disabled = true; btn.textContent = 'Working…'; }
  // fn() returns a Runner; chain handlers
  const runner = google.script.run
    .withSuccessHandler(() => { closeModal(); loadBookings(); })
    .withFailureHandler(err => {
      const msg = document.getElementById('modalMsg');
      if (msg) { msg.className = 'msg msg-error'; msg.textContent = 'Error: ' + err.message; }
      if (btn) { btn.disabled = false; btn.textContent = 'Retry'; }
    });
  // Replace the inline google.script.run in fn() with our runner: we just call fn()
  // Simpler: fn should call the method on whatever runner; we pass runner via global
  window.__runner = runner;
  fn();
}
// adjust: our fn uses google.script.run directly — rewrite using window.__runner
function _gsr() { return window.__runner || google.script.run; }
// Re-bind: the fns already reference google.script.run.adminXxx, which starts fresh runners.
// Simplest fix: instead of fancy runner magic, each fn does its own chain. Rewrite:
function submitAction(runCall) { runCall(); }
function wrapRunner(runner, btn) {
  return runner
    .withSuccessHandler(() => { if (btn) btn.disabled = false; closeModal(); loadBookings(); })
    .withFailureHandler(err => {
      const msg = document.getElementById('modalMsg');
      if (msg) { msg.className = 'msg msg-error'; msg.textContent = 'Error: ' + err.message; }
      if (btn) { btn.disabled = false; btn.textContent = 'Retry'; }
    });
}
// Final (clean) helpers
function runAccept(rowId) {
  const btn = document.getElementById('submitBtn');
  btn.disabled = true; btn.textContent = 'Working…';
  wrapRunner(google.script.run, btn).adminAccept(rowId, parseFloat(document.getElementById('fld-finalTotal').value), document.getElementById('fld-customMessage').value);
}
function runDecline(rowId) {
  const btn = document.getElementById('submitBtn');
  btn.disabled = true; btn.textContent = 'Working…';
  wrapRunner(google.script.run, btn).adminDecline(rowId, document.getElementById('fld-declineMessage').value);
}
function runMarkPaid(rowId) {
  const btn = document.getElementById('submitBtn');
  btn.disabled = true; btn.textContent = 'Working…';
  wrapRunner(google.script.run, btn).adminMarkPaid(rowId, document.getElementById('fld-paymentMethod').value, document.getElementById('fld-checkinInstructions').value, document.getElementById('fld-confirmMessage').value);
}
function runReschedule(rowId) {
  const btn = document.getElementById('submitBtn');
  btn.disabled = true; btn.textContent = 'Working…';
  const p = {
    newCheckin: document.getElementById('fld-newCheckin').value,
    newCheckout: document.getElementById('fld-newCheckout').value,
    newAdults: parseInt(document.getElementById('fld-newAdults').value) || 1,
    newChildren: parseInt(document.getElementById('fld-newChildren').value) || 0,
    newInfants: parseInt(document.getElementById('fld-newInfants').value) || 0,
    newPets: parseInt(document.getElementById('fld-newPets').value) || 0,
  };
  wrapRunner(google.script.run, btn).adminReschedule(rowId, p);
}
function runCancel(rowId) {
  const btn = document.getElementById('submitBtn');
  btn.disabled = true; btn.textContent = 'Working…';
  wrapRunner(google.script.run, btn).adminCancel(rowId);
}
// Override the do* handlers to use the clean helpers
function doAccept(rowId) { runAccept(rowId); }
function doDecline(rowId) { runDecline(rowId); }
function doMarkPaid(rowId) { runMarkPaid(rowId); }
function doReschedule(rowId) { runReschedule(rowId); }
function doCancel(rowId) { runCancel(rowId); }

loadBookings();
</script>
</body></html>`;
}

// ===== ADMIN API (called via google.script.run from the dashboard) =====

function adminListBookings() {
  if (!_isAdminAuthorized()) throw new Error('Not authorized.');
  const sheet = getSheet();
  const lastRow = sheet.getLastRow();
  const bookings = [];
  if (lastRow < 2) return { bookings: [], stats: _emptyStats() };

  const data = sheet.getRange(2, 1, lastRow - 1, 23).getValues();
  for (let i = 0; i < data.length; i++) {
    const r = data[i];
    const message = r[13];
    const occasion = r[12];
    // Parse upsell tags so the admin card can show 🍽️/🌱 chips and (for the
    // permaculture upsell) flag the booking as hybrid stay+course.
    const upsells = _parseUpsellsFromMessage(message);
    bookings.push({
      rowId: i + 2,
      id: r[0],
      submitted: r[1] instanceof Date ? r[1].toISOString() : r[1],
      status: r[2],
      firstName: r[3],
      lastName: r[4],
      email: r[5],
      phone: r[6],
      checkin: formatDateValue(r[7]),
      checkout: formatDateValue(r[8]),
      nights: r[9],
      guests: r[10],
      pets: r[11],
      occasion: occasion,
      message: message,
      estimatedTotal: r[14],
      finalTotal: r[15],
      responded: r[16] instanceof Date ? r[16].toISOString() : r[16],
      paymentMethod: r[17],
      paymentConfirmed: r[18] instanceof Date ? r[18].toISOString() : r[18],
      adults: r[20],
      children: r[21],
      infants: r[22],
      upsellChef: upsells.chef.present,
      upsellChefDetails: upsells.chef.details,
      upsellCourse: upsells.course.present,
      upsellCourseDetails: upsells.course.details,
      // Hybrid = a stay booking that also includes a course/permaculture upsell.
      // Renders both 🏡 Farm Stay and 🌱 Course Registration pills on the card.
      hybridStayCourse: upsells.course.present && String(occasion || '').indexOf('COURSE') !== 0,
    });
  }

  // Compute stats
  const thisYear = new Date().getFullYear();
  const today = new Date(); today.setHours(0,0,0,0);
  let stats = {
    ytdConfirmedRevenue: 0, ytdConfirmedCount: 0,
    awaitingPaymentRevenue: 0, awaitingPaymentCount: 0,
    pendingCount: 0, pendingRevenue: 0,
    upcomingNights: 0, upcomingBookings: 0,
  };
  bookings.forEach(b => {
    const ciYear = b.checkin ? new Date(b.checkin).getFullYear() : null;
    const amount = Number(b.finalTotal) || Number(b.estimatedTotal) || 0;
    if (b.status === 'Confirmed') {
      if (ciYear === thisYear) { stats.ytdConfirmedRevenue += amount; stats.ytdConfirmedCount++; }
      const ci = b.checkin ? new Date(b.checkin) : null;
      if (ci && ci >= today) { stats.upcomingNights += Number(b.nights) || 0; stats.upcomingBookings++; }
    } else if (b.status === 'Awaiting Payment' || b.status === 'Awaiting Confirmation') {
      // Both feed the "awaiting payment (potential)" stat — to the host they're indistinguishable
      // for revenue forecasting, even though the workflow differs.
      stats.awaitingPaymentRevenue += amount; stats.awaitingPaymentCount++;
    } else if (b.status === 'Pending') {
      stats.pendingCount++; stats.pendingRevenue += amount;
    }
  });

  // Sort: newest first by submitted date
  bookings.sort((a, b) => String(b.submitted).localeCompare(String(a.submitted)));
  return { bookings: bookings, stats: stats };
}

function _emptyStats() {
  return {
    ytdConfirmedRevenue: 0, ytdConfirmedCount: 0,
    awaitingPaymentRevenue: 0, awaitingPaymentCount: 0,
    pendingCount: 0, pendingRevenue: 0,
    upcomingNights: 0, upcomingBookings: 0,
  };
}

// ----- Settings (Direct booking toggles + Permaculture phones) -----
function adminGetSettings() {
  if (!_isAdminAuthorized()) throw new Error('Not authorized.');
  return Object.assign({}, getBookingSettings(), {
    permaculturePhones: getPermaculturePhones(),
  });
}

function adminUpdateSettings(updates) {
  if (!_isAdminAuthorized()) throw new Error('Not authorized.');
  if (!updates || typeof updates !== 'object') throw new Error('Invalid updates payload.');
  // Whitelist allowed keys to avoid storing arbitrary props from the client
  const allowed = ['directBookingStay', 'directBookingCourse'];
  const sanitized = {};
  allowed.forEach(function (k) {
    if (Object.prototype.hasOwnProperty.call(updates, k)) sanitized[k] = !!updates[k];
  });
  const savedBooking = setBookingSettings(sanitized);
  // Optional nested update for the 3 Permaculture phone numbers.
  if (updates.permaculturePhones && typeof updates.permaculturePhones === 'object') {
    setPermaculturePhones(updates.permaculturePhones);
  }
  return Object.assign({}, savedBooking, {
    permaculturePhones: getPermaculturePhones(),
  });
}

// ----- Site mode (TEST vs LIVE) -----
function adminGetSiteMode() {
  if (!_isAdminAuthorized()) throw new Error('Not authorized.');
  return {
    mode: getSiteMode(),
    bookingsIcsAirbnbUrl: CONFIG.SCRIPT_URL + '?action=bookings_ics&for=airbnb',
    bookingsIcsHostUrl: CONFIG.SCRIPT_URL + '?action=bookings_ics',
  };
}

function adminSetSiteMode(mode) {
  if (!_isAdminAuthorized()) throw new Error('Not authorized.');
  return { mode: setSiteMode(mode) };
}

// ----- Pricing tab -----
function adminGetPricing() {
  if (!_isAdminAuthorized()) throw new Error('Not authorized.');
  return getPricingConfig();
}

// Update one cell in the matrix: { month: 0..11, dayOfWeek: 0..6, rate: number }
function adminUpdateBaseRate(p) {
  if (!_isAdminAuthorized()) throw new Error('Not authorized.');
  const month = parseInt(p && p.month, 10);
  const dow = parseInt(p && p.dayOfWeek, 10);
  const rate = Math.max(0, Number(p && p.rate));
  if (isNaN(month) || month < 0 || month > 11) throw new Error('Invalid month.');
  if (isNaN(dow) || dow < 0 || dow > 6) throw new Error('Invalid day of week.');
  if (isNaN(rate)) throw new Error('Invalid rate.');
  const cfg = getPricingConfig();
  if (!cfg.baseRates[String(month)]) cfg.baseRates[String(month)] = [0, 0, 0, 0, 0, 0, 0];
  cfg.baseRates[String(month)][dow] = rate;
  return setPricingConfig(cfg);
}

// Bulk overwrite of the entire matrix (used for save-all)
function adminUpdateAllBaseRates(matrix) {
  if (!_isAdminAuthorized()) throw new Error('Not authorized.');
  if (!matrix || typeof matrix !== 'object') throw new Error('Invalid matrix.');
  const cfg = getPricingConfig();
  cfg.baseRates = matrix;
  return setPricingConfig(cfg);
}

// Add or update a date override: { date: 'YYYY-MM-DD', price: number, label: string }
function adminUpsertOverride(p) {
  if (!_isAdminAuthorized()) throw new Error('Not authorized.');
  if (!p || !/^\d{4}-\d{2}-\d{2}$/.test(String(p.date || ''))) throw new Error('Invalid date (use YYYY-MM-DD).');
  const cfg = getPricingConfig();
  const existing = cfg.overrides.findIndex(o => o.date === p.date);
  const entry = {
    date: p.date,
    price: Math.max(0, Number(p.price) || 0),
    label: String(p.label || '').trim(),
  };
  if (existing >= 0) cfg.overrides[existing] = entry;
  else cfg.overrides.push(entry);
  return setPricingConfig(cfg);
}

function adminDeleteOverride(date) {
  if (!_isAdminAuthorized()) throw new Error('Not authorized.');
  const cfg = getPricingConfig();
  cfg.overrides = cfg.overrides.filter(o => o.date !== String(date));
  return setPricingConfig(cfg);
}

// Bulk-replace the entire overrides list. Used by the Save All button so the host can
// edit dozens of rows and persist them in one round-trip.
function adminUpdateAllOverrides(overrides) {
  if (!_isAdminAuthorized()) throw new Error('Not authorized.');
  if (!Array.isArray(overrides)) throw new Error('Overrides must be an array.');
  const cfg = getPricingConfig();
  // _normalizePricingConfig will coerce/sanitize each entry (date format check, price >= 0, etc.)
  cfg.overrides = overrides;
  return setPricingConfig(cfg);
}

// Update weekly discount params: { thresholdNights, percentOff }
function adminUpdateWeeklyDiscount(p) {
  if (!_isAdminAuthorized()) throw new Error('Not authorized.');
  const cfg = getPricingConfig();
  cfg.weeklyDiscount = {
    thresholdNights: Math.max(1, parseInt(p && p.thresholdNights, 10) || cfg.weeklyDiscount.thresholdNights),
    percentOff: Math.max(0, Math.min(100, Number(p && p.percentOff) || 0)),
  };
  return setPricingConfig(cfg);
}

// ----- Extras / add-on fees -----
function adminGetExtras() {
  if (!_isAdminAuthorized()) throw new Error('Not authorized.');
  return getExtrasConfig();
}

// Update one extras line in place. Payload: { key: 'adult'|'pet'|'bunkie'|'tent',
//   enabled?: bool, threshold?: number, price?: number, perNight?: bool, label?: string }
// Only the supplied fields are touched; the rest stay as-is.
function adminUpdateExtraLine(p) {
  if (!_isAdminAuthorized()) throw new Error('Not authorized.');
  const key = p && p.key;
  if (EXTRAS_KEYS.indexOf(key) === -1) throw new Error('Unknown extras line: ' + key);
  const cfg = getExtrasConfig();
  const line = Object.assign({}, cfg[key]);
  if (typeof p.enabled === 'boolean') line.enabled = p.enabled;
  if (p.threshold !== undefined && p.threshold !== null && p.threshold !== '') {
    const t = parseInt(p.threshold, 10);
    if (isNaN(t) || t < 0) throw new Error('Threshold must be a non-negative integer.');
    line.threshold = t;
  }
  if (p.price !== undefined && p.price !== null && p.price !== '') {
    const pr = Number(p.price);
    if (isNaN(pr) || pr < 0) throw new Error('Price must be a non-negative number.');
    line.price = pr;
  }
  if (typeof p.perNight === 'boolean') line.perNight = p.perNight;
  if (typeof p.label === 'string' && p.label.trim()) line.label = p.label.trim();
  cfg[key] = line;
  return setExtrasConfig(cfg);
}

// Bulk save — payload: { adult?: {...}, pet?: {...}, bunkie?: {...}, tent?: {...} }
function adminUpdateAllExtras(payload) {
  if (!_isAdminAuthorized()) throw new Error('Not authorized.');
  const cfg = getExtrasConfig();
  EXTRAS_KEYS.forEach(function (k) {
    if (payload && payload[k] && typeof payload[k] === 'object') {
      cfg[k] = Object.assign({}, cfg[k], payload[k]);
    }
  });
  return setExtrasConfig(cfg);
}

// Reset one or all extras lines back to factory defaults.
//   key omitted → reset everything
function adminResetExtras(key) {
  if (!_isAdminAuthorized()) throw new Error('Not authorized.');
  if (key && EXTRAS_KEYS.indexOf(key) === -1) throw new Error('Unknown extras line: ' + key);
  const cfg = getExtrasConfig();
  if (key) {
    cfg[key] = Object.assign({}, EXTRAS_DEFAULT[key]);
  } else {
    EXTRAS_KEYS.forEach(function (k) { cfg[k] = Object.assign({}, EXTRAS_DEFAULT[k]); });
  }
  return setExtrasConfig(cfg);
}

// Pre-populate Ontario stat holidays + long-weekend dates for 2026 and 2027 at the
// base rate, so the host has a ready-made framework to bump prices on. Idempotent —
// dates that already have an override are left untouched.
// Seed the Ontario holiday calendar for one or more years at a flat price.
// Dates that already have an override are left untouched.
// Years default to the current year and the next one.
function adminSeedOntarioHolidays(seedPrice, years) {
  if (!_isAdminAuthorized()) throw new Error('Not authorized.');
  const price = Math.max(0, Number(seedPrice) || CONFIG.NIGHTLY_RATE);
  let yearList = Array.isArray(years) ? years.map(y => parseInt(y, 10)).filter(y => !isNaN(y)) : [];
  if (yearList.length === 0) {
    const thisYear = new Date().getFullYear();
    yearList = [thisYear, thisYear + 1];
  }
  const holidays = [];
  yearList.forEach(y => { _ontarioHolidaysForYear(y).forEach(h => holidays.push(h)); });

  const cfg = getPricingConfig();
  const existingDates = new Set(cfg.overrides.map(o => o.date));
  let added = 0, skipped = 0;
  holidays.forEach(h => {
    if (existingDates.has(h.date)) { skipped++; return; }
    cfg.overrides.push({ date: h.date, price: price, label: h.label });
    existingDates.add(h.date);
    added++;
  });
  return {
    config: setPricingConfig(cfg),
    added: added,
    skipped: skipped,
    total: holidays.length,
    years: yearList,
  };
}

// ============================================================
// ===== HOLIDAY CALENDAR (computed, any year) =================
// ============================================================
// Ontario statutory holidays plus the surrounding weekend days that drive peak
// pricing, computed for any year rather than hardcoded. Each entry carries a
// stable `key` that is the same across years — that key is what the year-copy
// feature matches on, so "Labour Day weekend (Sat)" follows Labour Day to
// whatever date it lands on, instead of copying the raw number.

function _pcUtc(y, m, d) { return new Date(Date.UTC(y, m, d)); }
function _pcAddDays(d, n) { return new Date(d.getTime() + n * 86400000); }
function _pcYmd(d) {
  return d.getUTCFullYear() + '-' +
    String(d.getUTCMonth() + 1).padStart(2, '0') + '-' +
    String(d.getUTCDate()).padStart(2, '0');
}

// nth (1-based) occurrence of `weekday` (0=Sun) in month m (0-based) of year y
function _pcNthWeekday(y, m, weekday, n) {
  const first = _pcUtc(y, m, 1);
  const shift = (weekday - first.getUTCDay() + 7) % 7;
  return _pcUtc(y, m, 1 + shift + (n - 1) * 7);
}

// Last `weekday` falling on or before y-m-d
function _pcWeekdayOnOrBefore(y, m, d, weekday) {
  const target = _pcUtc(y, m, d);
  return _pcAddDays(target, -((target.getUTCDay() - weekday + 7) % 7));
}

// Easter Sunday, Gregorian — Meeus/Jones/Butcher algorithm
function _pcEasterSunday(y) {
  const a = y % 19, b = Math.floor(y / 100), c = y % 100;
  const d = Math.floor(b / 4), e = b % 4;
  const f = Math.floor((b + 8) / 25), g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4), k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31);
  const day = ((h + l - 7 * m + 114) % 31) + 1;
  return _pcUtc(y, month - 1, day);
}

function _ontarioHolidaysForYear(year) {
  const y = parseInt(year, 10);
  if (isNaN(y)) return [];
  const out = [];
  const push = (key, date, label) => out.push({ key: key, date: _pcYmd(date), label: label });

  push('new_years_day', _pcUtc(y, 0, 1), "New Year's Day");

  const familyDay = _pcNthWeekday(y, 1, 1, 3);                 // 3rd Monday of February
  push('family_day_sat', _pcAddDays(familyDay, -2), 'Family Day weekend (Sat)');
  push('family_day_sun', _pcAddDays(familyDay, -1), 'Family Day weekend (Sun)');
  push('family_day', familyDay, 'Family Day');

  const easter = _pcEasterSunday(y);
  push('good_friday', _pcAddDays(easter, -2), 'Good Friday');
  push('easter_saturday', _pcAddDays(easter, -1), 'Easter Saturday');
  push('easter_sunday', easter, 'Easter Sunday');
  push('easter_monday', _pcAddDays(easter, 1), 'Easter Monday');

  const victoria = _pcWeekdayOnOrBefore(y, 4, 24, 1);          // Monday on or before May 24
  push('victoria_day_sat', _pcAddDays(victoria, -2), 'Victoria Day weekend (Sat)');
  push('victoria_day_sun', _pcAddDays(victoria, -1), 'Victoria Day weekend (Sun)');
  push('victoria_day', victoria, 'Victoria Day');

  push('canada_day', _pcUtc(y, 6, 1), 'Canada Day');

  const civic = _pcNthWeekday(y, 7, 1, 1);                     // 1st Monday of August
  push('civic_sat', _pcAddDays(civic, -2), 'Civic Holiday weekend (Sat)');
  push('civic_sun', _pcAddDays(civic, -1), 'Civic Holiday weekend (Sun)');
  push('civic_day', civic, 'Civic Holiday (Simcoe Day)');

  const labour = _pcNthWeekday(y, 8, 1, 1);                    // 1st Monday of September
  push('labour_day_sat', _pcAddDays(labour, -2), 'Labour Day weekend (Sat)');
  push('labour_day_sun', _pcAddDays(labour, -1), 'Labour Day weekend (Sun)');
  push('labour_day', labour, 'Labour Day');

  push('truth_reconciliation', _pcUtc(y, 8, 30), 'Truth & Reconciliation Day');

  const thanksgiving = _pcNthWeekday(y, 9, 1, 2);              // 2nd Monday of October
  push('thanksgiving_sat', _pcAddDays(thanksgiving, -2), 'Thanksgiving weekend (Sat)');
  push('thanksgiving_sun', _pcAddDays(thanksgiving, -1), 'Thanksgiving weekend (Sun)');
  push('thanksgiving', thanksgiving, 'Thanksgiving');

  push('remembrance_day', _pcUtc(y, 10, 11), 'Remembrance Day');

  push('christmas_eve', _pcUtc(y, 11, 24), 'Christmas Eve');
  push('christmas_day', _pcUtc(y, 11, 25), 'Christmas Day');
  push('boxing_day', _pcUtc(y, 11, 26), 'Boxing Day');
  push('christmas_week_27', _pcUtc(y, 11, 27), 'Christmas week');
  push('christmas_week_28', _pcUtc(y, 11, 28), 'Christmas week');
  push('christmas_week_29', _pcUtc(y, 11, 29), 'Christmas week');
  push('christmas_week_30', _pcUtc(y, 11, 30), 'Christmas week');
  push('new_years_eve', _pcUtc(y, 11, 31), "New Year's Eve");

  return out.sort((a, b) => a.date.localeCompare(b.date));
}

// ============================================================
// ===== COPY OVERRIDES TO ANOTHER YEAR =======================
// ============================================================
// Duplicates the date-override list from one year into another. baseRates is a
// month x day-of-week matrix with no year dimension, so it carries forward on
// its own — overrides are the only year-specific pricing data.
//
// Each source override is matched to a holiday in the source year. If it is
// one, it moves to that same holiday's date in the target year (so Labour Day
// weekend stays a long weekend). If it is not a recognised holiday, it copies
// to the same calendar date, clamped to the end of the month when the day
// doesn't exist (Feb 29 -> Feb 28).

function _pcRoundPrice(value, roundTo) {
  const step = Math.max(1, parseInt(roundTo, 10) || 1);
  return Math.max(0, Math.round((Number(value) || 0) / step) * step);
}

// Same month/day in a different year, clamped to the last valid day of that month.
function _pcSameCalendarDate(dateStr, toYear) {
  const m = parseInt(dateStr.slice(5, 7), 10);
  const d = parseInt(dateStr.slice(8, 10), 10);
  const lastDay = new Date(Date.UTC(toYear, m, 0)).getUTCDate();
  return _pcYmd(_pcUtc(toYear, m - 1, Math.min(d, lastDay)));
}

// Builds the plan without writing anything. Both preview and apply call this,
// so what you confirm is exactly what gets written.
function _planOverrideYearCopy(p) {
  const fromYear = parseInt(p && p.fromYear, 10);
  const toYear = parseInt(p && p.toYear, 10);
  const pct = Number((p && p.percentIncrease) || 0);
  const roundTo = Math.max(1, parseInt(p && p.roundTo, 10) || 1);
  const clearOthers = !!(p && p.clearOthers);

  if (isNaN(fromYear) || fromYear < 2000 || fromYear > 2100) throw new Error('Invalid source year.');
  if (isNaN(toYear) || toYear < 2000 || toYear > 2100) throw new Error('Invalid target year.');
  if (fromYear === toYear) throw new Error('Source and target year must be different.');
  if (isNaN(pct) || pct < -100 || pct > 500) throw new Error('Increase must be between -100% and 500%.');

  const cfg = getPricingConfig();
  const fromPrefix = String(fromYear) + '-';
  const toPrefix = String(toYear) + '-';

  const source = cfg.overrides.filter(o => o.date.indexOf(fromPrefix) === 0);
  const existingTarget = {};
  cfg.overrides.forEach(o => { if (o.date.indexOf(toPrefix) === 0) existingTarget[o.date] = o; });

  const holidayByFromDate = {};
  _ontarioHolidaysForYear(fromYear).forEach(h => { holidayByFromDate[h.date] = h; });
  const holidayByKeyTo = {};
  _ontarioHolidaysForYear(toYear).forEach(h => { holidayByKeyTo[h.key] = h; });

  const entries = [];
  const seenTarget = {};
  source.forEach(o => {
    const srcHoliday = holidayByFromDate[o.date];
    const dstHoliday = srcHoliday ? holidayByKeyTo[srcHoliday.key] : null;
    const toDate = dstHoliday ? dstHoliday.date : _pcSameCalendarDate(o.date, toYear);
    const existing = existingTarget[toDate];
    const entry = {
      fromDate: o.date,
      toDate: toDate,
      label: (o.label || (dstHoliday ? dstHoliday.label : '')),
      holiday: dstHoliday ? dstHoliday.label : '',
      matchedBy: dstHoliday ? 'holiday' : 'date',
      shifted: dstHoliday ? (_pcSameCalendarDate(o.date, toYear) !== toDate) : false,
      fromPrice: o.price,
      toPrice: _pcRoundPrice(o.price * (1 + pct / 100), roundTo),
      replacesExisting: !!existing,
      existingPrice: existing ? existing.price : null,
      duplicateTarget: !!seenTarget[toDate],
    };
    seenTarget[toDate] = true;
    entries.push(entry);
  });
  entries.sort((a, b) => a.toDate.localeCompare(b.toDate));

  // Existing target-year overrides this copy does not touch.
  const orphans = Object.keys(existingTarget)
    .filter(d => !seenTarget[d])
    .sort()
    .map(d => ({ date: d, price: existingTarget[d].price, label: existingTarget[d].label }));

  return {
    fromYear: fromYear,
    toYear: toYear,
    percentIncrease: pct,
    roundTo: roundTo,
    clearOthers: clearOthers,
    entries: entries,
    orphans: orphans,
    sourceCount: source.length,
    createCount: entries.filter(e => !e.replacesExisting).length,
    replaceCount: entries.filter(e => e.replacesExisting).length,
    shiftedCount: entries.filter(e => e.shifted).length,
    unmatchedCount: entries.filter(e => e.matchedBy === 'date').length,
  };
}

function adminPreviewCopyOverridesToYear(p) {
  if (!_isAdminAuthorized()) throw new Error('Not authorized.');
  return _planOverrideYearCopy(p);
}

function adminApplyCopyOverridesToYear(p) {
  if (!_isAdminAuthorized()) throw new Error('Not authorized.');
  const plan = _planOverrideYearCopy(p);
  if (plan.entries.length === 0) throw new Error('No overrides found for ' + plan.fromYear + ' — nothing to copy.');

  const cfg = getPricingConfig();
  const toPrefix = String(plan.toYear) + '-';
  const written = {};
  plan.entries.forEach(e => {
    written[e.toDate] = { date: e.toDate, price: e.toPrice, label: e.label };
  });

  const kept = cfg.overrides.filter(o => {
    if (o.date.indexOf(toPrefix) !== 0) return true;   // other years are never touched
    if (plan.clearOthers) return false;                 // wipe the whole target year
    return !written[o.date];                            // otherwise drop only what we overwrite
  });

  cfg.overrides = kept.concat(Object.keys(written).sort().map(d => written[d]));
  return {
    config: setPricingConfig(cfg),
    written: Object.keys(written).length,
    created: plan.createCount,
    replaced: plan.replaceCount,
    removed: plan.clearOthers ? plan.orphans.length : 0,
    toYear: plan.toYear,
    fromYear: plan.fromYear,
  };
}

// Years that currently have at least one override — used to populate the
// From/To dropdowns so the host picks from what actually exists.
function adminGetOverrideYears() {
  if (!_isAdminAuthorized()) throw new Error('Not authorized.');
  const cfg = getPricingConfig();
  const counts = {};
  cfg.overrides.forEach(o => {
    const y = o.date.slice(0, 4);
    counts[y] = (counts[y] || 0) + 1;
  });
  return Object.keys(counts).sort().map(y => ({ year: parseInt(y, 10), count: counts[y] }));
}


function adminAccept(rowId, finalTotal, customMessage) {
  if (!_isAdminAuthorized()) throw new Error('Not authorized.');
  const sheet = getSheet();
  return processFormSubmission({
    action: 'accept_confirm',
    id: rowId,
    token: sheet.getRange(rowId, getColIndex('Token')).getValue(),
    finalTotal: finalTotal,
    customMessage: customMessage || '',
  });
}

function adminDecline(rowId, message) {
  if (!_isAdminAuthorized()) throw new Error('Not authorized.');
  const sheet = getSheet();
  return processFormSubmission({
    action: 'decline_confirm',
    id: rowId,
    token: sheet.getRange(rowId, getColIndex('Token')).getValue(),
    declineMessage: message || '',
  });
}

function adminMarkPaid(rowId, paymentMethod, checkinInstructions, confirmMessage) {
  if (!_isAdminAuthorized()) throw new Error('Not authorized.');
  const sheet = getSheet();
  return processFormSubmission({
    action: 'confirm_payment_final',
    id: rowId,
    token: sheet.getRange(rowId, getColIndex('Token')).getValue(),
    paymentMethod: paymentMethod || 'Manual',
    checkinInstructions: checkinInstructions || '',
    confirmMessage: confirmMessage || '',
  });
}

function adminReschedule(rowId, p) {
  if (!_isAdminAuthorized()) throw new Error('Not authorized.');
  const sheet = getSheet();
  const data = getBookingData(sheet, rowId);
  if (['Pending','Awaiting Payment','Awaiting Confirmation','Confirmed'].indexOf(data.status) === -1) {
    throw new Error('Cannot reschedule a booking with status: ' + data.status);
  }
  const newNights = calculateNights(p.newCheckin, p.newCheckout);
  if (!newNights || newNights < 1) throw new Error('Invalid new dates.');
  const newData = {
    checkin: p.newCheckin,
    checkout: p.newCheckout,
    adults: p.newAdults, children: p.newChildren, infants: p.newInfants,
    pets: p.newPets,
    guests: (p.newAdults || 0) + (p.newChildren || 0) + (p.newInfants || 0),
  };
  const newTotal = calculateTotal(newData);
  const oldTotal = data.finalTotal || data.estimatedTotal || 0;

  sheet.getRange(rowId, getColIndex('Check-in')).setValue(p.newCheckin);
  sheet.getRange(rowId, getColIndex('Checkout')).setValue(p.newCheckout);
  sheet.getRange(rowId, getColIndex('Nights')).setValue(newNights);
  sheet.getRange(rowId, getColIndex('Guests')).setValue(newData.guests);
  sheet.getRange(rowId, getColIndex('Pets')).setValue(p.newPets);
  sheet.getRange(rowId, getColIndex('Estimated Total')).setValue(newTotal);
  sheet.getRange(rowId, getColIndex('Adults')).setValue(p.newAdults);
  sheet.getRange(rowId, getColIndex('Children')).setValue(p.newChildren);
  sheet.getRange(rowId, getColIndex('Infants')).setValue(p.newInfants);
  if (data.finalTotal) sheet.getRange(rowId, getColIndex('Final Total')).setValue(newTotal);

  sendGuestRescheduleConfirmed(getBookingData(sheet, rowId), oldTotal, newTotal);
  return 'ok';
}

function adminCancel(rowId) {
  if (!_isAdminAuthorized()) throw new Error('Not authorized.');
  const sheet = getSheet();
  const data = getBookingData(sheet, rowId);
  if (data.status === 'Confirmed') {
    const days = daysUntilCheckin(data.checkin);
    if (days === null || days <= 30) {
      throw new Error('Under 30 days to check-in — cancellation is not allowed by policy.');
    }
    // Over 30 days: free cancel, trigger refund
    sheet.getRange(rowId, getColIndex('Status')).setValue('Cancelled');
    sheet.getRange(rowId, getColIndex('Status')).setBackground('#e2e3e5').setFontColor('#6c757d');
    sheet.getRange(rowId, getColIndex('Responded')).setValue(new Date());
    const paidAmount = data.finalTotal || 0;
    sendGuestCancellationConfirmed(data, true, paidAmount);
    sendHostCancellationAlert(data, rowId, true, paidAmount, days);
    return 'ok';
  }
  // Not confirmed yet — just decline/cancel without refund notification
  sheet.getRange(rowId, getColIndex('Status')).setValue(data.status === 'Awaiting Payment' ? 'Declined' : 'Declined');
  sheet.getRange(rowId, getColIndex('Status')).setBackground('#e2e3e5').setFontColor('#6c757d');
  sheet.getRange(rowId, getColIndex('Responded')).setValue(new Date());
  return 'ok';
}

function adminResendLink(rowId) {
  if (!_isAdminAuthorized()) throw new Error('Not authorized.');
  const sheet = getSheet();
  const data = getBookingData(sheet, rowId);
  if (data.status !== 'Awaiting Payment') throw new Error('Not in Awaiting Payment status.');
  const finalTotal = data.finalTotal || data.estimatedTotal;
  const stripeUrl = createStripeCheckoutSession(data, finalTotal, data.id);
  sendGuestConditionalAcceptance(data, finalTotal, '', stripeUrl);
  return 'ok';
}

// ===== GUEST SELF-SERVICE (manage / cancel / request change) =====

// Returns integer number of days from "now" to checkin. Positive = future, 0 = today, negative = past.
function daysUntilCheckin(checkin) {
  if (!checkin) return null;
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  let ci;
  if (checkin instanceof Date) {
    ci = new Date(checkin.getFullYear(), checkin.getMonth(), checkin.getDate());
  } else {
    const m = String(checkin).match(/^(\d{4})-(\d{2})-(\d{2})/);
    if (m) ci = new Date(parseInt(m[1]), parseInt(m[2]) - 1, parseInt(m[3]));
    else ci = new Date(checkin);
  }
  if (isNaN(ci.getTime())) return null;
  const msPerDay = 1000 * 60 * 60 * 24;
  return Math.round((ci.getTime() - today.getTime()) / msPerDay);
}

function buildGuestManagePage(sheet, rowId) {
  const data = getBookingData(sheet, rowId);
  const status = data.status;
  const days = daysUntilCheckin(data.checkin);
  const refundEligible = days !== null && days > 30;
  const guestSummary = formatGuestSummary(data);
  const paidAmount = data.finalTotal || data.estimatedTotal || 0;

  // Bookings that can be managed
  const manageableStatuses = ['Confirmed', 'Awaiting Payment', 'Awaiting Confirmation'];
  if (manageableStatuses.indexOf(status) === -1) {
    const friendlyMsg = (status === 'Cancelled' || status === 'Cancelled — No refund')
      ? 'This booking has already been cancelled.'
      : 'This booking is currently ' + status + ' and cannot be managed here. Please contact ' + CONFIG.HOST_EMAIL + ' for help.';
    return HtmlService.createHtmlOutput(errorPage(friendlyMsg)).setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
  }

  const scriptUrl = CONFIG.SCRIPT_URL;
  const tkn = data.token;

  const daysLine = days !== null
    ? (days > 0
        ? '<strong>' + days + ' day' + (days !== 1 ? 's' : '') + '</strong> until check-in'
        : (days === 0 ? '<strong>Check-in is today</strong>' : '<strong>Check-in was ' + Math.abs(days) + ' day' + (Math.abs(days) !== 1 ? 's' : '') + ' ago</strong>'))
    : '';

  const cancelRefundNote = refundEligible
    ? '<span style="color:#2e6e31;">More than 30 days out — full refund available per our cancellation policy.</span>'
    : '<span style="color:#b45309;">Less than 30 days out — per our strict cancellation policy, cancelling now means no refund. You can still cancel to free up the dates, but the payment is non-refundable.</span>';

  const html = `<!DOCTYPE html>
<html><head>
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Manage your booking — ${CONFIG.PROPERTY_NAME}</title>
<style>
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; max-width: 600px; margin: 32px auto; padding: 20px; color: #1a1a1a; background: #f9f9f6; }
  .card { background: #fff; border-radius: 12px; padding: 28px; box-shadow: 0 2px 12px rgba(0,0,0,0.06); }
  h1 { font-size: 22px; margin: 0 0 4px; }
  .sub { color: #888; font-size: 14px; margin: 0 0 24px; }
  .summary { background: #f5f3ee; border-radius: 8px; padding: 16px 20px; margin: 16px 0 24px; font-size: 14px; line-height: 1.7; }
  .summary strong { display: inline-block; min-width: 90px; color: #555; }
  .policy { background: #fff8e1; border: 1px solid #f1c232; border-radius: 8px; padding: 14px 18px; font-size: 13px; line-height: 1.6; margin: 0 0 24px; }
  .actions { display: flex; gap: 12px; flex-wrap: wrap; margin-top: 16px; }
  .btn { display: inline-block; padding: 12px 20px; border-radius: 8px; font-size: 14px; font-weight: 500; cursor: pointer; border: none; text-decoration: none; text-align: center; }
  .btn-danger { background: #dc3545; color: #fff; }
  .btn-danger:hover { background: #b02a37; }
  .btn-secondary { background: #fff; color: #2e6e31; border: 1.5px solid #2e6e31; }
  .btn-secondary:hover { background: #f0f7ee; }
  .btn-disabled { background: #e2e3e5; color: #6c757d; cursor: not-allowed; }
  .status-line { font-size: 14px; color: #555; margin: 8px 0 0; }
  #msg { margin-top: 16px; padding: 12px; border-radius: 8px; font-size: 14px; display: none; }
  .msg-success { background: #d4edda; color: #155724; border: 1px solid #c3e6cb; }
  .msg-error { background: #f8d7da; color: #721c24; border: 1px solid #f5c6cb; }
</style>
</head><body>
<div class="card">
  <h1>Manage your booking</h1>
  <p class="sub">Booking ${data.id} · ${CONFIG.PROPERTY_NAME}</p>

  <div class="summary">
    <div><strong>Check-in:</strong> ${data.checkin}</div>
    <div><strong>Checkout:</strong> ${data.checkout}</div>
    <div><strong>Nights:</strong> ${data.nights}</div>
    <div><strong>Guests:</strong> ${guestSummary}${data.pets > 0 ? ' · ' + data.pets + ' pet' + (data.pets > 1 ? 's' : '') : ''}</div>
    <div><strong>Status:</strong> ${status}</div>
    <div><strong>Total:</strong> $${Number(paidAmount).toLocaleString('en-CA', {minimumFractionDigits: 2, maximumFractionDigits: 2})} CAD</div>
    <div class="status-line">${daysLine}</div>
  </div>

  <div class="policy">
    <strong>Cancellation policy (Strict):</strong><br>
    ${cancelRefundNote}
  </div>

  <p style="font-size:14px; line-height:1.6; color:#444;">Changes to dates or guest counts are reviewed by your host. If you'd like to request a change, use the button below and ${CONFIG.HOST_NAME} will get back to you by email.</p>

  <div class="actions">
    <a class="btn btn-secondary" href="${scriptUrl}?action=guest_change_form&id=${rowId}&token=${tkn}">Request a change</a>
    <button class="btn btn-danger" id="cancelBtn" onclick="confirmCancel()">Cancel booking</button>
  </div>

  <div id="msg"></div>
</div>

<script>
function confirmCancel() {
  const refundMsg = ${refundEligible}
    ? 'This will cancel your booking and trigger a full refund. Continue?'
    : 'This will cancel your booking. Per the strict cancellation policy, no refund is issued since check-in is less than 30 days away. Continue?';
  if (!confirm(refundMsg)) return;

  const btn = document.getElementById('cancelBtn');
  btn.textContent = 'Cancelling…';
  btn.disabled = true;
  btn.className = 'btn btn-disabled';

  google.script.run
    .withSuccessHandler(function() {
      const msg = document.getElementById('msg');
      msg.className = 'msg-success';
      msg.style.display = 'block';
      msg.textContent = ${refundEligible}
        ? 'Your booking is cancelled. ${CONFIG.HOST_NAME} will process your refund via Stripe and you will receive a confirmation email shortly.'
        : 'Your booking is cancelled. The dates have been freed up. We hope to see you another time.';
    })
    .withFailureHandler(function(err) {
      const msg = document.getElementById('msg');
      msg.className = 'msg-error';
      msg.style.display = 'block';
      msg.textContent = 'Error: ' + err.message;
      btn.textContent = 'Cancel booking';
      btn.disabled = false;
      btn.className = 'btn btn-danger';
    })
    .processFormSubmission({ action: 'guest_cancel_submit', id: '${rowId}', token: '${tkn}' });
}
</script>
</body></html>`;

  return HtmlService.createHtmlOutput(html).setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
}

function handleGuestCancelSubmit(sheet, rowId) {
  const data = getBookingData(sheet, rowId);
  const status = data.status;
  if (status !== 'Confirmed' && status !== 'Awaiting Payment' && status !== 'Awaiting Confirmation') {
    throw new Error('This booking cannot be cancelled (status: ' + status + ').');
  }
  const days = daysUntilCheckin(data.checkin);
  const refundEligible = days !== null && days > 30;
  const paidAmount = data.finalTotal || data.estimatedTotal || 0;

  const newStatus = refundEligible ? 'Cancelled' : 'Cancelled — No refund';
  sheet.getRange(rowId, getColIndex('Status')).setValue(newStatus);
  sheet.getRange(rowId, getColIndex('Status')).setBackground('#e2e3e5').setFontColor('#6c757d');
  sheet.getRange(rowId, getColIndex('Responded')).setValue(new Date());

  sendGuestCancellationConfirmed(data, refundEligible, paidAmount);
  sendHostCancellationAlert(data, rowId, refundEligible, paidAmount, days);
  return 'ok';
}

function buildGuestChangeRequestForm(sheet, rowId) {
  const data = getBookingData(sheet, rowId);
  const status = data.status;
  if (status !== 'Confirmed' && status !== 'Awaiting Payment') {
    return HtmlService.createHtmlOutput(errorPage('This booking cannot be modified here.')).setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
  }
  const tkn = data.token;
  const html = `<!DOCTYPE html>
<html><head>
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Request a change — ${CONFIG.PROPERTY_NAME}</title>
<style>
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; max-width: 600px; margin: 32px auto; padding: 20px; color: #1a1a1a; background: #f9f9f6; }
  .card { background: #fff; border-radius: 12px; padding: 28px; box-shadow: 0 2px 12px rgba(0,0,0,0.06); }
  h1 { font-size: 22px; margin: 0 0 4px; }
  .sub { color: #888; font-size: 14px; margin: 0 0 20px; }
  .summary { background: #f5f3ee; border-radius: 8px; padding: 12px 16px; margin: 0 0 20px; font-size: 13px; line-height: 1.6; color: #555; }
  label { display: block; margin-top: 16px; font-size: 13px; color: #555; font-weight: 500; }
  input, textarea { width: 100%; padding: 10px 12px; border: 1px solid #ddd; border-radius: 6px; font-size: 14px; font-family: inherit; margin-top: 4px; box-sizing: border-box; }
  textarea { resize: vertical; min-height: 100px; }
  .row { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
  .btn { display: inline-block; padding: 12px 20px; border-radius: 8px; font-size: 14px; font-weight: 500; cursor: pointer; border: none; margin-top: 20px; background: #2e6e31; color: #fff; }
  .btn-cancel { background: transparent; color: #666; border: 1px solid #ddd; margin-left: 8px; }
  #msg { margin-top: 16px; padding: 12px; border-radius: 8px; font-size: 14px; display: none; }
  .msg-success { background: #d4edda; color: #155724; }
  .msg-error { background: #f8d7da; color: #721c24; }
</style>
</head><body>
<div class="card">
  <h1>Request a change</h1>
  <p class="sub">Booking ${data.id} · ${CONFIG.PROPERTY_NAME}</p>

  <div class="summary">
    <strong>Current:</strong> ${data.checkin} → ${data.checkout} · ${data.nights} nights · ${formatGuestSummary(data)}${data.pets > 0 ? ' · ' + data.pets + ' pet(s)' : ''}
  </div>

  <p style="font-size:14px; line-height:1.6;">Changes are at ${CONFIG.HOST_NAME}'s discretion. Fill in whatever needs to change below — leave anything blank to keep it the same. ${CONFIG.HOST_NAME} will reply to you by email with a yes or no.</p>

  <form id="changeForm" onsubmit="submitChange(event)">
    <div class="row">
      <div>
        <label for="newCheckin">New check-in</label>
        <input type="date" id="newCheckin" name="newCheckin">
      </div>
      <div>
        <label for="newCheckout">New checkout</label>
        <input type="date" id="newCheckout" name="newCheckout">
      </div>
    </div>
    <div class="row">
      <div>
        <label for="newAdults">New adults</label>
        <input type="number" id="newAdults" name="newAdults" min="0" max="20">
      </div>
      <div>
        <label for="newChildren">New children</label>
        <input type="number" id="newChildren" name="newChildren" min="0" max="20">
      </div>
    </div>
    <div class="row">
      <div>
        <label for="newInfants">New infants</label>
        <input type="number" id="newInfants" name="newInfants" min="0" max="10">
      </div>
      <div>
        <label for="newPets">New pets</label>
        <input type="number" id="newPets" name="newPets" min="0" max="5">
      </div>
    </div>
    <label for="note">Message to ${CONFIG.HOST_NAME} (reason, context)</label>
    <textarea id="note" name="note" placeholder="e.g. We'd like to extend by two nights…"></textarea>

    <button type="submit" class="btn">Send change request</button>
    <a href="javascript:history.back()" class="btn btn-cancel">Cancel</a>
  </form>

  <div id="msg"></div>
</div>

<script>
function submitChange(e) {
  e.preventDefault();
  const msg = document.getElementById('msg');
  const payload = {
    action: 'guest_change_submit',
    id: '${rowId}',
    token: '${tkn}',
    newCheckin: document.getElementById('newCheckin').value || '',
    newCheckout: document.getElementById('newCheckout').value || '',
    newAdults: document.getElementById('newAdults').value || '',
    newChildren: document.getElementById('newChildren').value || '',
    newInfants: document.getElementById('newInfants').value || '',
    newPets: document.getElementById('newPets').value || '',
    note: document.getElementById('note').value || '',
  };
  google.script.run
    .withSuccessHandler(function() {
      document.getElementById('changeForm').style.display = 'none';
      msg.className = 'msg-success';
      msg.style.display = 'block';
      msg.textContent = 'Your change request has been sent to ${CONFIG.HOST_NAME}. You should receive a reply by email soon.';
    })
    .withFailureHandler(function(err) {
      msg.className = 'msg-error';
      msg.style.display = 'block';
      msg.textContent = 'Error: ' + err.message;
    })
    .processFormSubmission(payload);
}
</script>
</body></html>`;
  return HtmlService.createHtmlOutput(html).setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
}

function handleGuestChangeSubmit(sheet, rowId, formData) {
  const data = getBookingData(sheet, rowId);
  sendHostChangeRequest(data, rowId, formData);
  // Keep status unchanged — host reviews and replies by email / uses the Reschedule menu action.
  return 'ok';
}

function sendGuestCancellationConfirmed(data, refundEligible, paidAmount) {
  const subject = 'Booking cancelled — ' + CONFIG.PROPERTY_NAME;
  const amountText = '$' + Number(paidAmount).toLocaleString('en-CA', {minimumFractionDigits: 2, maximumFractionDigits: 2}) + ' CAD';
  const refundSection = refundEligible
    ? '<p style="font-size:16px;line-height:1.7;">You are eligible for a full refund of <strong>' + amountText + '</strong> under our cancellation policy (more than 30 days from check-in). ' + CONFIG.HOST_NAME + ' will process your refund via Stripe within 1–2 business days. Refunds typically take 5–10 business days to appear on your statement.</p>'
    : '<p style="font-size:16px;line-height:1.7;">Per our strict cancellation policy, no refund is issued for cancellations within 30 days of check-in. We understand plans change and hope to welcome you another time.</p>';
  const html = `
<div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; max-width: 560px; margin: 0 auto; color: #1a1a1a;">
  <div style="background: #6c757d; padding: 28px 32px;">
    <h1 style="color: #fff; font-size: 20px; margin: 0;">Booking Cancelled</h1>
  </div>
  <div style="padding: 32px; background: #fff;">
    <p style="font-size:16px;line-height:1.7;">Hi ${data.firstName},</p>
    <p style="font-size:16px;line-height:1.7;">Your booking at ${CONFIG.PROPERTY_NAME} has been cancelled as requested.</p>
    <div style="background:#f5f3ee;border-radius:8px;padding:16px 20px;margin:20px 0;">
      <p style="margin:4px 0;"><strong>Booking:</strong> ${data.id}</p>
      <p style="margin:4px 0;"><strong>Dates:</strong> ${data.checkin} → ${data.checkout}</p>
      <p style="margin:4px 0;"><strong>Guests:</strong> ${formatGuestSummary(data)}</p>
    </div>
    ${refundSection}
    <p style="font-size:14px;color:#1a1a1a;">Questions? Reply to this email.</p>
    <p style="font-size:14px;color:#1a1a1a;">— ${CONFIG.HOST_NAME}, ${CONFIG.PROPERTY_NAME}</p>
  </div>
</div>`;
  MailApp.sendEmail({
    to: data.email,
    subject: subject,
    htmlBody: html,
    replyTo: CONFIG.HOST_EMAIL,
    name: CONFIG.PROPERTY_NAME,
  });
}

function sendHostCancellationAlert(data, rowId, refundEligible, paidAmount, days) {
  const subject = refundEligible
    ? '🔔 Cancellation + REFUND NEEDED — ' + (data.firstName || '') + ' ' + (data.lastName || '')
    : '🔔 Cancellation (no refund) — ' + (data.firstName || '') + ' ' + (data.lastName || '');
  const amountText = '$' + Number(paidAmount).toLocaleString('en-CA', {minimumFractionDigits: 2, maximumFractionDigits: 2}) + ' CAD';
  const refundSection = refundEligible
    ? `<div style="background:#fff8e1;border:1px solid #f1c232;border-radius:8px;padding:16px 20px;margin:20px 0;">
        <p style="margin:0 0 8px;font-weight:600;">Refund required: ${amountText}</p>
        <p style="margin:0 0 12px;font-size:14px;">Cancellation was more than 30 days out (${days} days).</p>
        <p style="margin:0;font-size:14px;">
          <a href="https://dashboard.stripe.com/payments?query=${encodeURIComponent(data.email || '')}" style="color:#5469d4;">Open Stripe Dashboard</a> → find the charge for ${data.firstName} ${data.lastName} (${data.email}) → click <strong>Refund</strong> → Full refund.
        </p>
      </div>`
    : `<div style="background:#f5f3ee;border-radius:8px;padding:16px 20px;margin:20px 0;">
        <p style="margin:0;font-size:14px;">Cancellation was within 30 days (${days} days) — no refund per the strict policy. No action required.</p>
      </div>`;
  const html = `
<div style="font-family:-apple-system,sans-serif;max-width:560px;margin:0 auto;color:#1a1a1a;">
  <div style="background:#b45309;padding:24px 32px;">
    <h1 style="color:#fff;font-size:18px;margin:0;">Guest Cancellation</h1>
  </div>
  <div style="padding:28px 32px;background:#fff;">
    <p style="font-size:15px;line-height:1.7;">${data.firstName} ${data.lastName} (${data.email}) has cancelled their booking.</p>
    <div style="background:#f5f3ee;border-radius:8px;padding:16px 20px;margin:16px 0;">
      <p style="margin:4px 0;"><strong>Booking:</strong> ${data.id} (row ${rowId})</p>
      <p style="margin:4px 0;"><strong>Dates:</strong> ${data.checkin} → ${data.checkout}</p>
      <p style="margin:4px 0;"><strong>Nights:</strong> ${data.nights}</p>
      <p style="margin:4px 0;"><strong>Guests:</strong> ${formatGuestSummary(data)}</p>
      <p style="margin:4px 0;"><strong>Paid:</strong> ${amountText}${data.paymentMethod ? ' via ' + data.paymentMethod : ''}</p>
    </div>
    ${refundSection}
  </div>
</div>`;
  MailApp.sendEmail({
    to: CONFIG.HOST_EMAIL,
    subject: subject,
    htmlBody: html,
    name: 'SFF Booking System',
  });
}

function sendHostChangeRequest(data, rowId, formData) {
  const parts = [];
  if (formData.newCheckin) parts.push('<li><strong>Check-in:</strong> ' + formData.newCheckin + ' <span style="color:#888">(was ' + data.checkin + ')</span></li>');
  if (formData.newCheckout) parts.push('<li><strong>Checkout:</strong> ' + formData.newCheckout + ' <span style="color:#888">(was ' + data.checkout + ')</span></li>');
  if (formData.newAdults !== '') parts.push('<li><strong>Adults:</strong> ' + formData.newAdults + ' <span style="color:#888">(was ' + (data.adults || data.guests) + ')</span></li>');
  if (formData.newChildren !== '') parts.push('<li><strong>Children:</strong> ' + formData.newChildren + ' <span style="color:#888">(was ' + (data.children || 0) + ')</span></li>');
  if (formData.newInfants !== '') parts.push('<li><strong>Infants:</strong> ' + formData.newInfants + ' <span style="color:#888">(was ' + (data.infants || 0) + ')</span></li>');
  if (formData.newPets !== '') parts.push('<li><strong>Pets:</strong> ' + formData.newPets + ' <span style="color:#888">(was ' + (data.pets || 0) + ')</span></li>');
  const changesHtml = parts.length
    ? '<ul style="font-size:14px;line-height:1.8;padding-left:20px;">' + parts.join('') + '</ul>'
    : '<p style="font-size:14px;color:#888;">No specific fields filled in — see guest message below.</p>';
  const noteHtml = formData.note
    ? '<div style="background:#f0f7ee;border-left:3px solid #3d8c40;padding:12px 16px;margin:16px 0;font-style:italic;font-size:14px;">' + formData.note.replace(/</g,'&lt;') + '</div>'
    : '';
  const subject = '📝 Change request — ' + (data.firstName || '') + ' ' + (data.lastName || '') + ' (' + data.id + ')';
  const html = `
<div style="font-family:-apple-system,sans-serif;max-width:560px;margin:0 auto;color:#1a1a1a;">
  <div style="background:#2e6e31;padding:24px 32px;">
    <h1 style="color:#fff;font-size:18px;margin:0;">Guest Change Request</h1>
  </div>
  <div style="padding:28px 32px;background:#fff;">
    <p style="font-size:15px;line-height:1.7;">${data.firstName} ${data.lastName} (${data.email}, ${data.phone || 'no phone'}) is asking to change their booking.</p>

    <div style="background:#f5f3ee;border-radius:8px;padding:16px 20px;margin:16px 0;">
      <p style="margin:4px 0;"><strong>Current booking:</strong> ${data.id} (row ${rowId})</p>
      <p style="margin:4px 0;">${data.checkin} → ${data.checkout} · ${data.nights} nights · ${formatGuestSummary(data)}${data.pets > 0 ? ' · ' + data.pets + ' pet(s)' : ''}</p>
      <p style="margin:4px 0;">Status: ${data.status} · Paid: $${Number(data.finalTotal || data.estimatedTotal || 0).toLocaleString('en-CA', {minimumFractionDigits: 2, maximumFractionDigits: 2})}</p>
    </div>

    <h3 style="font-size:15px;margin:20px 0 8px;">Requested changes</h3>
    ${changesHtml}
    ${noteHtml}

    <div style="background:#fff8e1;border:1px solid #f1c232;border-radius:8px;padding:14px 18px;margin:20px 0;font-size:14px;line-height:1.6;">
      <strong>How to respond:</strong><br>
      1. Reply to this email to the guest directly (their email is <a href="mailto:${data.email}">${data.email}</a>) with your yes / no and any details.<br>
      2. If approved, open the Bookings sheet → select row ${rowId} → <strong>Bookings menu → Reschedule selected booking</strong> to apply the new dates/counts and recalculate the total.
    </div>
  </div>
</div>`;
  MailApp.sendEmail({
    to: CONFIG.HOST_EMAIL,
    subject: subject,
    htmlBody: html,
    replyTo: data.email,
    name: 'SFF Booking System',
  });
}

// ===== SPREADSHEET FUNCTIONS =====

// ===== IN-SHEET MENU =====
// Adds a "Bookings" menu to the spreadsheet when it opens. Simple trigger.
function onOpen() {
  SpreadsheetApp.getUi()
    .createMenu('Bookings')
    .addItem('Mark selected row as Paid (Manual)', 'menuMarkPaid')
    .addItem('Reschedule selected booking', 'menuRescheduleBooking')
    .addItem('Cancel selected booking', 'menuCancelBooking')
    .addSeparator()
    .addItem('Resend payment link to selected guest', 'menuResendPaymentLink')
    .addSeparator()
    .addItem('Refresh Summary tab', 'menuRefreshSummary')
    .addItem('Re-apply status formatting', 'setupSheetFormatting')
    .addToUi();
}

function _getSelectedBookingRowId() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const active = ss.getActiveSheet();
  if (active.getName() !== CONFIG.SHEET_NAME) {
    throw new Error('Select a row in the "' + CONFIG.SHEET_NAME + '" tab first.');
  }
  const row = active.getActiveRange().getRow();
  if (row < 2) throw new Error('Select a data row (not the header).');
  return row;
}

function menuMarkPaid() {
  const ui = SpreadsheetApp.getUi();
  try {
    const rowId = _getSelectedBookingRowId();
    const sheet = getSheet();
    const data = getBookingData(sheet, rowId);
    if (data.status === 'Confirmed') {
      ui.alert('This booking is already Confirmed.');
      return;
    }
    const resp = ui.alert('Mark as Paid',
      'Set booking ' + data.id + ' (' + data.firstName + ' ' + data.lastName + ', ' + data.checkin + '→' + data.checkout + ') to Confirmed with payment method "Manual"?',
      ui.ButtonSet.YES_NO);
    if (resp !== ui.Button.YES) return;
    sheet.getRange(rowId, getColIndex('Status')).setValue('Confirmed');
    sheet.getRange(rowId, getColIndex('Status')).setBackground('#28a745').setFontColor('#fff');
    sheet.getRange(rowId, getColIndex('Payment Method')).setValue('Manual');
    sheet.getRange(rowId, getColIndex('Payment Confirmed')).setValue(new Date());
    ui.alert('Marked as Paid.');
  } catch (e) {
    ui.alert('Error: ' + e.message);
  }
}

function menuCancelBooking() {
  const ui = SpreadsheetApp.getUi();
  try {
    const rowId = _getSelectedBookingRowId();
    const sheet = getSheet();
    const data = getBookingData(sheet, rowId);
    const resp = ui.alert('Cancel booking',
      'Cancel booking ' + data.id + ' (' + data.firstName + ' ' + data.lastName + ', ' + data.checkin + '→' + data.checkout + ')? This sets status to Declined.',
      ui.ButtonSet.YES_NO);
    if (resp !== ui.Button.YES) return;
    sheet.getRange(rowId, getColIndex('Status')).setValue('Declined');
    sheet.getRange(rowId, getColIndex('Status')).setBackground('#e2e3e5').setFontColor('#6c757d');
    sheet.getRange(rowId, getColIndex('Responded')).setValue(new Date());
    ui.alert('Booking cancelled.');
  } catch (e) {
    ui.alert('Error: ' + e.message);
  }
}

function menuRescheduleBooking() {
  const ui = SpreadsheetApp.getUi();
  try {
    const rowId = _getSelectedBookingRowId();
    const sheet = getSheet();
    const data = getBookingData(sheet, rowId);
    if (data.status !== 'Confirmed' && data.status !== 'Awaiting Payment' && data.status !== 'Awaiting Confirmation' && data.status !== 'Pending') {
      ui.alert('This booking cannot be rescheduled (status: ' + data.status + ').');
      return;
    }
    const prompt = (label, defaultVal) => {
      const r = ui.prompt('Reschedule — ' + data.id, label + ' (leave blank to keep current: ' + defaultVal + ')', ui.ButtonSet.OK_CANCEL);
      if (r.getSelectedButton() !== ui.Button.OK) return null;
      const v = r.getResponseText().trim();
      return v === '' ? String(defaultVal) : v;
    };
    const newCheckin = prompt('New check-in date (YYYY-MM-DD)', data.checkin);
    if (newCheckin === null) return;
    const newCheckout = prompt('New checkout date (YYYY-MM-DD)', data.checkout);
    if (newCheckout === null) return;
    const newAdults = prompt('New adults count', data.adults || data.guests || 1);
    if (newAdults === null) return;
    const newChildren = prompt('New children count', data.children || 0);
    if (newChildren === null) return;
    const newInfants = prompt('New infants count', data.infants || 0);
    if (newInfants === null) return;
    const newPets = prompt('New pets count', data.pets || 0);
    if (newPets === null) return;

    // Compute new totals
    const newData = {
      checkin: newCheckin,
      checkout: newCheckout,
      adults: parseInt(newAdults) || 1,
      children: parseInt(newChildren) || 0,
      infants: parseInt(newInfants) || 0,
      pets: parseInt(newPets) || 0,
      guests: (parseInt(newAdults) || 1) + (parseInt(newChildren) || 0) + (parseInt(newInfants) || 0),
    };
    const newNights = calculateNights(newCheckin, newCheckout);
    const newTotal = calculateTotal(newData);
    const oldTotal = data.finalTotal || data.estimatedTotal || 0;
    const diff = newTotal - oldTotal;

    const resp = ui.alert('Confirm reschedule',
      'New dates: ' + newCheckin + ' → ' + newCheckout + ' (' + newNights + ' nights)\n' +
      'New guests: ' + newData.adults + ' adults, ' + newData.children + ' children, ' + newData.infants + ' infants\n' +
      'New pets: ' + newData.pets + '\n\n' +
      'Old total: $' + Number(oldTotal).toFixed(2) + '\n' +
      'New total: $' + Number(newTotal).toFixed(2) + '\n' +
      'Difference: ' + (diff >= 0 ? '+' : '') + '$' + Number(diff).toFixed(2) + '\n\n' +
      'Apply changes and email guest? (You will handle any refund / additional charge manually via Stripe.)',
      ui.ButtonSet.YES_NO);
    if (resp !== ui.Button.YES) return;

    // Write new values
    sheet.getRange(rowId, getColIndex('Check-in')).setValue(newCheckin);
    sheet.getRange(rowId, getColIndex('Checkout')).setValue(newCheckout);
    sheet.getRange(rowId, getColIndex('Nights')).setValue(newNights);
    sheet.getRange(rowId, getColIndex('Guests')).setValue(newData.guests);
    sheet.getRange(rowId, getColIndex('Pets')).setValue(newData.pets);
    sheet.getRange(rowId, getColIndex('Estimated Total')).setValue(newTotal);
    sheet.getRange(rowId, getColIndex('Adults')).setValue(newData.adults);
    sheet.getRange(rowId, getColIndex('Children')).setValue(newData.children);
    sheet.getRange(rowId, getColIndex('Infants')).setValue(newData.infants);
    // Only update Final Total if it was set (paid/confirmed bookings)
    if (data.finalTotal) {
      sheet.getRange(rowId, getColIndex('Final Total')).setValue(newTotal);
    }

    // Email guest
    const refreshed = getBookingData(sheet, rowId);
    sendGuestRescheduleConfirmed(refreshed, oldTotal, newTotal);
    ui.alert('Booking rescheduled. Email sent to ' + data.email + '. Differences in payment should be handled manually in Stripe.');
  } catch (e) {
    ui.alert('Error: ' + e.message);
  }
}

function sendGuestRescheduleConfirmed(data, oldTotal, newTotal) {
  const diff = newTotal - oldTotal;
  const subject = 'Your booking has been updated — ' + CONFIG.PROPERTY_NAME;
  const diffLine = diff > 0
    ? '<p style="font-size:15px;line-height:1.7;">The new total is <strong>$' + Number(newTotal).toFixed(2) + ' CAD</strong>, which is $' + Number(diff).toFixed(2) + ' more than your original booking. ' + CONFIG.HOST_NAME + ' will send a follow-up for the balance.</p>'
    : diff < 0
      ? '<p style="font-size:15px;line-height:1.7;">The new total is <strong>$' + Number(newTotal).toFixed(2) + ' CAD</strong>, which is $' + Number(Math.abs(diff)).toFixed(2) + ' less than your original booking. ' + CONFIG.HOST_NAME + ' will issue a refund for the difference via Stripe within 1–2 business days.</p>'
      : '<p style="font-size:15px;line-height:1.7;">The total remains unchanged at <strong>$' + Number(newTotal).toFixed(2) + ' CAD</strong>.</p>';
  const html = `
<div style="font-family:-apple-system,sans-serif;max-width:560px;margin:0 auto;color:#1a1a1a;">
  <div style="background:#2e6e31;padding:24px 32px;">
    <h1 style="color:#fff;font-size:20px;margin:0;">Booking Updated</h1>
  </div>
  <div style="padding:28px 32px;background:#fff;">
    <p style="font-size:15px;line-height:1.7;">Hi ${data.firstName},</p>
    <p style="font-size:15px;line-height:1.7;">Your booking at ${CONFIG.PROPERTY_NAME} has been updated. Here are the new details:</p>
    <div style="background:#f5f3ee;border-radius:8px;padding:16px 20px;margin:16px 0;">
      <p style="margin:4px 0;"><strong>Check-in:</strong> ${data.checkin}</p>
      <p style="margin:4px 0;"><strong>Checkout:</strong> ${data.checkout}</p>
      <p style="margin:4px 0;"><strong>Nights:</strong> ${data.nights}</p>
      <p style="margin:4px 0;"><strong>Guests:</strong> ${formatGuestSummary(data)}</p>
      ${data.pets > 0 ? `<p style="margin:4px 0;"><strong>Pets:</strong> ${data.pets}</p>` : ''}
    </div>
    ${diffLine}
    <p style="font-size:14px;color:#1a1a1a;">Questions? Just reply to this email.</p>
    <p style="font-size:14px;color:#1a1a1a;">— ${CONFIG.HOST_NAME}, ${CONFIG.PROPERTY_NAME}</p>
  </div>
</div>`;
  MailApp.sendEmail({
    to: data.email,
    subject: subject,
    htmlBody: html,
    replyTo: CONFIG.HOST_EMAIL,
    name: CONFIG.PROPERTY_NAME,
  });
}

function menuResendPaymentLink() {
  const ui = SpreadsheetApp.getUi();
  try {
    const rowId = _getSelectedBookingRowId();
    const sheet = getSheet();
    const data = getBookingData(sheet, rowId);
    if (data.status !== 'Awaiting Payment') {
      ui.alert('This row is not in "Awaiting Payment" status (currently: ' + data.status + ').');
      return;
    }
    const finalTotal = data.finalTotal || data.estimatedTotal;
    const resp = ui.alert('Resend payment link',
      'Resend the payment link email to ' + data.email + ' for booking ' + data.id + ' ($' + finalTotal + ')?',
      ui.ButtonSet.YES_NO);
    if (resp !== ui.Button.YES) return;
    const stripeUrl = createStripeCheckoutSession(data, finalTotal, data.id);
    sendGuestConditionalAcceptance(data, finalTotal, '', stripeUrl);
    ui.alert('Payment link email resent to ' + data.email + '.');
  } catch (e) {
    ui.alert('Error: ' + e.message);
  }
}

function menuRefreshSummary() {
  const ui = SpreadsheetApp.getUi();
  try {
    const msg = setupSummaryTab();
    ui.alert(msg);
  } catch (e) {
    ui.alert('Error: ' + e.message);
  }
}

// ONE-TIME SETUP: apply conditional formatting to the Status column so at-a-glance
// review of the Bookings sheet is easier. Run once from the Apps Script editor.
// Idempotent — rebuilds the ruleset every run, so safe to re-run after schema changes.
function setupSheetFormatting() {
  const sheet = getSheet();
  const statusCol = getColIndex('Status');
  const lastRow = Math.max(1000, sheet.getMaxRows());
  const range = sheet.getRange(2, statusCol, lastRow - 1, 1);
  const existingRules = sheet.getConditionalFormatRules();
  const otherRules = existingRules.filter(r => {
    const ranges = r.getRanges();
    return !ranges.some(rg => rg.getColumn() === statusCol);
  });
  const statusStyles = [
    { value: 'Pending', bg: '#fff3cd', fg: '#856404' },
    { value: 'Awaiting Payment', bg: '#d4edda', fg: '#155724' },
    { value: 'Awaiting Confirmation', bg: '#cce5ff', fg: '#004085' },
    { value: 'Confirmed', bg: '#28a745', fg: '#ffffff', bold: true },
    { value: 'Declined', bg: '#e2e3e5', fg: '#6c757d' },
    { value: 'Expired', bg: '#ffc107', fg: '#7a5d02' },
  ];
  const newStatusRules = statusStyles.map(s => {
    let b = SpreadsheetApp.newConditionalFormatRule()
      .whenTextEqualTo(s.value)
      .setBackground(s.bg)
      .setFontColor(s.fg)
      .setRanges([range]);
    if (s.bold) b = b.setBold(true);
    return b.build();
  });
  sheet.setConditionalFormatRules(otherRules.concat(newStatusRules));
  sheet.setFrozenRows(1);
  return 'Applied ' + newStatusRules.length + ' conditional format rules to Status column (' + statusCol + ').';
}

// ONE-TIME SETUP: create/refresh a "Summary" tab in the same spreadsheet with YTD and
// lifetime metrics driven by formulas (stays live as new bookings arrive). Safe to re-run.
function setupSummaryTab() {
  const ss = SpreadsheetApp.openById(CONFIG.SPREADSHEET_ID);
  const bookingsName = CONFIG.SHEET_NAME;
  let summary = ss.getSheetByName('Summary');
  if (!summary) {
    summary = ss.insertSheet('Summary', 0);  // Insert as first tab
  } else {
    summary.clear();
  }
  const today = 'TODAY()';
  const yearRef = 'YEAR(' + today + ')';
  const statusCol = "'" + bookingsName + "'!C:C";
  const checkinCol = "'" + bookingsName + "'!H:H";
  const finalTotalCol = "'" + bookingsName + "'!P:P";
  const nightsCol = "'" + bookingsName + "'!J:J";
  const estimatedCol = "'" + bookingsName + "'!O:O";
  const rows = [
    ['Straight Fin Farms — Booking Summary', '', 'Last refreshed:', today],
    ['', '', '', ''],
    ['Metric', 'Value', '', ''],
    ['YTD confirmed revenue ($)', '=IFERROR(SUMIFS(' + finalTotalCol + ',' + statusCol + ',"Confirmed",' + checkinCol + ',">="&DATE(' + yearRef + ',1,1)),0)', '', ''],
    ['YTD confirmed bookings', '=COUNTIFS(' + statusCol + ',"Confirmed",' + checkinCol + ',">="&DATE(' + yearRef + ',1,1))', '', ''],
    ['YTD nights booked', '=IFERROR(SUMIFS(' + nightsCol + ',' + statusCol + ',"Confirmed",' + checkinCol + ',">="&DATE(' + yearRef + ',1,1)),0)', '', ''],
    ['Upcoming confirmed bookings', '=COUNTIFS(' + statusCol + ',"Confirmed",' + checkinCol + ',">="&' + today + ')', '', ''],
    ['Upcoming nights', '=IFERROR(SUMIFS(' + nightsCol + ',' + statusCol + ',"Confirmed",' + checkinCol + ',">="&' + today + '),0)', '', ''],
    ['Currently awaiting payment', '=COUNTIF(' + statusCol + ',"Awaiting Payment")', '', ''],
    ['Pending review', '=COUNTIF(' + statusCol + ',"Pending")', '', ''],
    ['Lifetime confirmed revenue ($)', '=IFERROR(SUMIF(' + statusCol + ',"Confirmed",' + finalTotalCol + '),0)', '', ''],
    ['Lifetime confirmed bookings', '=COUNTIF(' + statusCol + ',"Confirmed")', '', ''],
    ['Lifetime estimated (inc. pending) ($)', '=IFERROR(SUMIF(' + statusCol + ',"<>Declined",' + estimatedCol + '),0) - IFERROR(SUMIF(' + statusCol + ',"Expired",' + estimatedCol + '),0)', '', ''],
  ];
  summary.getRange(1, 1, rows.length, 4).setValues(rows);
  summary.getRange(1, 1).setFontWeight('bold').setFontSize(16);
  summary.getRange(1, 3, 1, 2).setFontStyle('italic').setFontColor('#888');
  summary.getRange(3, 1, 1, 2).setFontWeight('bold').setBackground('#e8e4dc');
  summary.getRange(4, 2, rows.length - 3, 1).setNumberFormat('#,##0.00');
  // Integer counts rather than decimals for count-type rows
  summary.getRange('B5').setNumberFormat('0');
  summary.getRange('B7:B10').setNumberFormat('0');
  summary.getRange('B12').setNumberFormat('0');
  summary.setColumnWidth(1, 260);
  summary.setColumnWidth(2, 140);
  summary.setFrozenRows(3);
  return 'Summary tab created/refreshed with ' + (rows.length - 3) + ' metrics.';
}

// ONE-TIME MIGRATION: run this once from the Apps Script editor (select from dropdown → Run)
// to add Adults/Children/Infants header cells to the existing Bookings sheet.
// Idempotent — safe to run multiple times; won't overwrite existing values.
function migrateAddAgeColumns() {
  const ss = SpreadsheetApp.openById(CONFIG.SPREADSHEET_ID);
  const sheet = ss.getSheetByName(CONFIG.SHEET_NAME);
  if (!sheet) {
    Logger.log('Sheet not found: ' + CONFIG.SHEET_NAME);
    return 'Sheet not found';
  }
  const headersRange = sheet.getRange(1, 1, 1, 23);
  const headers = headersRange.getValues()[0];
  const wanted = { 20: 'Adults', 21: 'Children', 22: 'Infants' };
  const added = [];
  const skipped = [];
  for (const col of Object.keys(wanted)) {
    const i = parseInt(col);
    if (!headers[i] || headers[i] === '') {
      sheet.getRange(1, i + 1).setValue(wanted[col]).setFontWeight('bold').setBackground('#e8e4dc');
      sheet.autoResizeColumn(i + 1);
      added.push(wanted[col] + ' → column ' + String.fromCharCode(65 + i));
    } else {
      skipped.push(wanted[col] + ' (already = "' + headers[i] + '")');
    }
  }
  const summary = 'Added: ' + (added.join(', ') || 'none') + '\nSkipped: ' + (skipped.join(', ') || 'none');
  Logger.log(summary);
  return summary;
}

function getSheet() {
  const ss = SpreadsheetApp.openById(CONFIG.SPREADSHEET_ID);
  let sheet = ss.getSheetByName(CONFIG.SHEET_NAME);
  if (!sheet) {
    sheet = ss.insertSheet(CONFIG.SHEET_NAME);
    sheet.appendRow([
      'ID', 'Submitted', 'Status', 'First Name', 'Last Name', 'Email', 'Phone',
      'Check-in', 'Checkout', 'Nights', 'Guests', 'Pets', 'Occasion', 'Message',
      'Estimated Total', 'Final Total', 'Responded', 'Payment Method', 'Payment Confirmed', 'Token',
      'Adults', 'Children', 'Infants'
    ]);
    sheet.setFrozenRows(1);
    sheet.getRange(1, 1, 1, 23).setFontWeight('bold').setBackground('#e8e4dc');
    // Auto-size
    for (let i = 1; i <= 23; i++) sheet.autoResizeColumn(i);
  }
  return sheet;
}

// Column name → column number
function getColIndex(colName) {
  const headers = ['ID', 'Submitted', 'Status', 'First Name', 'Last Name', 'Email', 'Phone',
    'Check-in', 'Checkout', 'Nights', 'Guests', 'Pets', 'Occasion', 'Message',
    'Estimated Total', 'Final Total', 'Responded', 'Payment Method', 'Payment Confirmed', 'Token',
    'Adults', 'Children', 'Infants'];
  return headers.indexOf(colName) + 1;
}

// Build the Message field, appending optional upsell info as parseable tags. The
// admin dashboard reads these tags to flag the booking as a hybrid stay+course
// (when the permaculture experience upsell is checked) and to surface the upsells
// prominently on the card.
function _buildMessageWithUpsells(data) {
  let msg = String(data.message || '').trim();
  const parts = [];
  if (data.upsellChef) {
    const detail = String(data.upsellChefDetails || '').trim();
    parts.push('[upsell-chef] Add a private chef' + (detail ? ' — ' + detail : ''));
  }
  if (data.upsellCourse) {
    const detail = String(data.upsellCourseDetails || '').trim();
    parts.push('[upsell-course] Add a permaculture experience' + (detail ? ' — ' + detail : ''));
  }
  if (parts.length === 0) return msg;
  return (msg ? msg + '\n\n' : '') + parts.join('\n');
}

// Pull upsell info back out of the Message field (for host emails / admin display).
// Returns { chef: {present, details}, course: {present, details} }.
function _parseUpsellsFromMessage(msg) {
  const out = { chef: { present: false, details: '' }, course: { present: false, details: '' } };
  if (!msg) return out;
  const chefM = String(msg).match(/\[upsell-chef\]\s*([^\n]*)/);
  if (chefM) {
    out.chef.present = true;
    // Strip the boilerplate "Add a private chef" prefix to leave just the details
    out.chef.details = chefM[1].replace(/^Add a private chef(\s*[—-]\s*)?/, '').trim();
  }
  const courseM = String(msg).match(/\[upsell-course\]\s*([^\n]*)/);
  if (courseM) {
    out.course.present = true;
    out.course.details = courseM[1].replace(/^Add a permaculture experience(\s*[—-]\s*)?/, '').trim();
  }
  return out;
}

function logBooking(data) {
  const sheet = getSheet();
  const id = Utilities.getUuid().substring(0, 8).toUpperCase();
  const token = Utilities.getUuid();
  const nights = calculateNights(data.checkin, data.checkout);
  const total = calculateTotal(data);
  const messageWithUpsells = _buildMessageWithUpsells(data);

  sheet.appendRow([
    id,
    new Date(),
    'Pending',
    data.firstName || '',
    data.lastName || '',
    data.email || '',
    data.phone || '',
    data.checkin || '',
    data.checkout || '',
    nights,
    data.guests || 1,
    data.pets || 0,
    data.occasion || '',
    messageWithUpsells,
    total,
    '',  // Final Total (set on accept)
    '',  // Responded
    '',  // Payment Method
    '',  // Payment Confirmed
    token,
    parseInt(data.adults) || '',
    parseInt(data.children) || '',
    parseInt(data.infants) || ''
  ]);

  // Color the status cell yellow for Pending
  const lastRow = sheet.getLastRow();
  sheet.getRange(lastRow, getColIndex('Status')).setBackground('#fff3cd');

  return lastRow;
}

function getBookingData(sheet, rowId) {
  const row = sheet.getRange(rowId, 1, 1, 23).getValues()[0];
  return {
    id: row[0],
    submitted: row[1],
    status: row[2],
    firstName: row[3],
    lastName: row[4],
    email: row[5],
    phone: row[6],
    checkin: formatDateValue(row[7]),
    checkout: formatDateValue(row[8]),
    nights: row[9],
    guests: row[10],
    pets: row[11],
    occasion: row[12],
    message: row[13],
    estimatedTotal: row[14],
    finalTotal: row[15],
    responded: row[16],
    paymentMethod: row[17],
    paymentConfirmed: row[18],
    token: row[19],
    adults: row[20],
    children: row[21],
    infants: row[22],
  };
}

// ===== PRICING =====

function calculateNights(checkin, checkout) {
  if (!checkin || !checkout) return 0;
  const d1 = new Date(checkin);
  const d2 = new Date(checkout);
  return Math.max(1, Math.round((d2 - d1) / (1000 * 60 * 60 * 24)));
}

function calculateTotal(data) {
  const breakdown = getPricingBreakdown(data);
  return breakdown.total;
}

function getPricingBreakdown(data) {
  const nights = calculateNights(data.checkin, data.checkout);
  // Backward compat: old bookings sent only `guests`; treat that as adults with no children/infants
  const hasBreakdown = data.adults !== undefined && data.adults !== null && data.adults !== '';
  const adults = hasBreakdown ? (parseInt(data.adults) || 0) : (parseInt(data.guests) || 1);
  const children = hasBreakdown ? (parseInt(data.children) || 0) : 0;
  const infants = hasBreakdown ? (parseInt(data.infants) || 0) : 0;
  const guests = adults + children + infants;
  const pets = parseInt(data.pets) || 0;
  // Add-on accommodations sent from book-direct.html
  const bellTents = parseInt(data.bellTents) || 0;
  const bunkies = (data.addBunkie === true || data.addBunkie === 'true' || data.addBunkie === 1)
    ? 1
    : (parseInt(data.bunkies) || 0);

  // Per-night pricing from the admin matrix (fallback: CONFIG.NIGHTLY_RATE for every day).
  const nightly = computeNightlyBreakdown(data.checkin, data.checkout);
  const accommodationBeforeDiscount = nightly.nightlySubtotal;
  const weeklyDiscount = nightly.weeklyDiscount;
  const accommodationTotal = nightly.nightlyAfterDiscount;

  // Cleaning fee bumps up when adults+children reach BASE_GUESTS (infants excluded)
  const cleaningFee = (adults + children) >= CONFIG.BASE_GUESTS ? CONFIG.CLEANING_FEE_LONG : CONFIG.CLEANING_FEE_SHORT;

  // Admin-editable extras config (adult surcharge, pets, bunkie, bell tent)
  const extras = getExtrasConfig();
  const adultLine  = _computeExtraLine(extras.adult,  adults,    nights);
  const petLine    = _computeExtraLine(extras.pet,    pets,      nights);
  const bunkieLine = _computeExtraLine(extras.bunkie, bunkies,   nights);
  const tentLine   = _computeExtraLine(extras.tent,   bellTents, nights);

  // Legacy field names kept for backward-compat with downstream callers (email templates, etc.)
  const extraGuests = adultLine.billable;
  const extraGuestCost = adultLine.cost;
  const petCost = petLine.cost;
  const bunkieCost = bunkieLine.cost;
  const bellTentCost = tentLine.cost;

  const subtotal = accommodationTotal + cleaningFee + extraGuestCost + petCost + bunkieCost + bellTentCost;
  const hst = Math.round(subtotal * CONFIG.HST_RATE * 100) / 100;
  const total = subtotal + hst;

  // Per-night date labels (kept for buildBreakdownHtml compatibility) — the daily rates
  // are also exposed via `nightlyDays` so emails can show varied per-day pricing.
  const dateLabels = nightly.days.map(d => {
    const dt = new Date(d.date + 'T12:00:00');
    return dt.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
  });
  // Average effective rate (after weekly discount) — used by callers that want a single number.
  const effectiveNightlyRate = nights > 0 ? Math.round(accommodationTotal / nights) : CONFIG.NIGHTLY_RATE;

  return {
    nights,
    guests,
    adults,
    children,
    infants,
    pets,
    bellTents,
    bunkies,
    nightlyRate: effectiveNightlyRate,
    dateLabels,
    nightlyDays: nightly.days,                 // [{date, dayOfWeek, rate, source, label}, ...]
    accommodationBeforeDiscount,
    weeklyDiscount,
    weeklyDiscountPercent: nightly.weeklyDiscountPercent,
    weeklyDiscountApplied: nightly.weeklyDiscountApplied,
    accommodationTotal,
    cleaningFee,
    cleaningLabel: 'Cleaning fee',
    extraGuests,
    extraGuestCost,
    petCost,
    bunkieCost,
    bellTentCost,
    // Full extras config + per-line snapshots so email/admin templates can render them.
    extrasConfig: extras,
    extrasLines: {
      adult:  Object.assign({}, adultLine,  { quantity: adults }),
      pet:    Object.assign({}, petLine,    { quantity: pets }),
      bunkie: Object.assign({}, bunkieLine, { quantity: bunkies }),
      tent:   Object.assign({}, tentLine,   { quantity: bellTents }),
    },
    subtotal,
    hstRate: CONFIG.HST_RATE,
    hst,
    total,
  };
}

function buildBreakdownHtml(breakdown) {
  const fmt = (n) => '$' + Number(n).toLocaleString('en-CA', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const rowStyle = 'padding: 5px 0; font-size: 14px;';
  const labelStyle = rowStyle + ' color: #555;';
  const amountStyle = rowStyle + ' text-align: right; font-variant-numeric: tabular-nums;';

  let rows = '';

  // Per-night rows — render each day's actual rate (varies with the matrix + overrides)
  const days = breakdown.nightlyDays || [];
  if (days.length > 0) {
    days.forEach((d, i) => {
      const label = breakdown.dateLabels[i] || d.date;
      const tag = d.source === 'override' && d.label ? ' <span style="color:#888;font-size:11px;">· ' + d.label + '</span>' : '';
      rows += `<tr><td style="${labelStyle}">${label}${tag}</td><td style="${amountStyle}">${fmt(d.rate)}</td></tr>`;
    });
  } else {
    breakdown.dateLabels.forEach((label) => {
      rows += `<tr><td style="${labelStyle}">${label}</td><td style="${amountStyle}">${fmt(breakdown.nightlyRate)}</td></tr>`;
    });
  }

  // Pre-discount nightly subtotal (shown when discount applies OR rates vary across the stay)
  const preDiscount = breakdown.accommodationBeforeDiscount || breakdown.accommodationTotal;
  if (breakdown.nights > 1 && breakdown.weeklyDiscountApplied) {
    rows += `<tr><td style="${labelStyle} font-weight: 600;">${breakdown.nights} night subtotal</td><td style="${amountStyle} font-weight: 600;">${fmt(preDiscount)}</td></tr>`;
  } else if (breakdown.nights > 1 && days.length === 0) {
    rows += `<tr><td style="${labelStyle} font-weight: 600;">${breakdown.nights} nights × ${fmt(breakdown.nightlyRate)}</td><td style="${amountStyle} font-weight: 600;">${fmt(breakdown.accommodationTotal)}</td></tr>`;
  }

  // Weekly stay discount
  if (breakdown.weeklyDiscountApplied && breakdown.weeklyDiscount > 0) {
    rows += `<tr><td style="${labelStyle} color:#2e6e31;">Weekly stay discount (−${breakdown.weeklyDiscountPercent}% on ${breakdown.nights}+ nights)</td><td style="${amountStyle} color:#2e6e31;">−${fmt(breakdown.weeklyDiscount)}</td></tr>`;
  }

  // Cleaning fee
  rows += `<tr><td style="${labelStyle}">${breakdown.cleaningLabel}</td><td style="${amountStyle}">${fmt(breakdown.cleaningFee)}</td></tr>`;

  // Extras — adult surcharge, pet fee, bunkie add-on, bell tent add-on.
  // Each row uses the admin-editable line config (price + per-night vs per-stay).
  const extrasCfg = breakdown.extrasConfig || getExtrasConfig();
  const lines = breakdown.extrasLines || {};

  // Extra adult surcharge
  if (lines.adult && lines.adult.cost > 0) {
    const a = extrasCfg.adult || {};
    const desc = a.perNight
      ? `${lines.adult.billable} × ${fmt(a.price)}/night × ${breakdown.nights} night${breakdown.nights === 1 ? '' : 's'}`
      : `${lines.adult.billable} × ${fmt(a.price)}`;
    rows += `<tr><td style="${labelStyle}">${a.label || 'Extra adults'} (${desc})</td><td style="${amountStyle}">${fmt(lines.adult.cost)}</td></tr>`;
  }

  // Pet fee
  if (lines.pet && lines.pet.cost > 0) {
    const p = extrasCfg.pet || {};
    const desc = p.perNight
      ? `${breakdown.pets} pet${breakdown.pets > 1 ? 's' : ''} × ${fmt(p.price)}/night × ${breakdown.nights} night${breakdown.nights === 1 ? '' : 's'}`
      : `${breakdown.pets} pet${breakdown.pets > 1 ? 's' : ''} × ${fmt(p.price)}`;
    rows += `<tr><td style="${labelStyle}">${p.label || 'Pet fee'} (${desc})</td><td style="${amountStyle}">${fmt(lines.pet.cost)}</td></tr>`;
  }

  // Forest Bunkie add-on
  if (lines.bunkie && lines.bunkie.cost > 0) {
    const b = extrasCfg.bunkie || {};
    const desc = b.perNight
      ? `${fmt(b.price)}/night × ${breakdown.nights} night${breakdown.nights === 1 ? '' : 's'}`
      : `${fmt(b.price)}`;
    rows += `<tr><td style="${labelStyle}">${b.label || 'Forest Bunkie'} (${desc})</td><td style="${amountStyle}">${fmt(lines.bunkie.cost)}</td></tr>`;
  }

  // Bell Tent add-on
  if (lines.tent && lines.tent.cost > 0) {
    const t = extrasCfg.tent || {};
    const qty = breakdown.bellTents || lines.tent.billable;
    const desc = t.perNight
      ? `${qty} × ${fmt(t.price)}/night × ${breakdown.nights} night${breakdown.nights === 1 ? '' : 's'}`
      : `${qty} × ${fmt(t.price)}`;
    rows += `<tr><td style="${labelStyle}">${t.label || 'Bell Tent'} (${desc})</td><td style="${amountStyle}">${fmt(lines.tent.cost)}</td></tr>`;
  }

  // Subtotal
  rows += `<tr style="border-top: 1px solid #e0ddd6;"><td style="${labelStyle} padding-top: 10px; font-weight: 600;">Subtotal</td><td style="${amountStyle} padding-top: 10px; font-weight: 600;">${fmt(breakdown.subtotal)}</td></tr>`;

  // HST
  rows += `<tr><td style="${labelStyle}">HST (${(breakdown.hstRate * 100).toFixed(0)}%)</td><td style="${amountStyle}">${fmt(breakdown.hst)}</td></tr>`;

  // Total
  rows += `<tr style="border-top: 2px solid #2b4a1f;"><td style="${rowStyle} padding-top: 10px; font-weight: 700; font-size: 16px;">Total</td><td style="${amountStyle} padding-top: 10px; font-weight: 700; font-size: 16px; color: #2b4a1f;">${fmt(breakdown.total)}</td></tr>`;

  return `<table style="width: 100%; border-collapse: collapse;">${rows}</table>`;
}

// ===== STRIPE INTEGRATION =====

function createStripeCheckoutSession(data, finalTotal, bookingId) {
  const amountInCents = Math.round(Number(finalTotal) * 100);
  const nights = calculateNights(data.checkin, data.checkout);

  const params = {
    'payment_method_types[]': 'card',
    'mode': 'payment',
    'currency': 'cad',
    'line_items[0][price_data][currency]': 'cad',
    'line_items[0][price_data][unit_amount]': amountInCents.toString(),
    'line_items[0][price_data][product_data][name]': `${CONFIG.PROPERTY_NAME} — ${nights}-Night Stay`,
    'line_items[0][price_data][product_data][description]': `${data.checkin} to ${data.checkout} · ${formatGuestSummary(data)}${data.pets > 0 ? ' · ' + data.pets + ' pet(s)' : ''} · HST included`,
    'line_items[0][quantity]': '1',
    'customer_email': data.email,
    'metadata[booking_id]': bookingId || data.id || '',
    'metadata[guest_name]': `${data.firstName} ${data.lastName}`,
    'metadata[checkin]': data.checkin,
    'metadata[checkout]': data.checkout,
    // Stripe redirects guests to the static GitHub Pages success page after payment.
    // Routing this through the Apps Script directly is unreliable because Chrome
    // injects /u/N/ for whatever Google account is signed in, and Apps Script web
    // apps reject that path even when access is "Anyone". The static page may be
    // upgraded later to call handleStripeSuccess via fetch (booking_id + session_id
    // are passed through as query params for that future hookup).
    'success_url': 'https://straightfinfarms.com/payment-success.html?booking_id=' + encodeURIComponent(bookingId || data.id || '') + '&session_id={CHECKOUT_SESSION_ID}',
    'cancel_url': 'https://straightfinfarms.com/book-direct.html',
  };

  // Build form-encoded body
  const payload = Object.keys(params).map(k => encodeURIComponent(k) + '=' + encodeURIComponent(params[k])).join('&');

  const response = UrlFetchApp.fetch('https://api.stripe.com/v1/checkout/sessions', {
    method: 'post',
    headers: {
      'Authorization': 'Bearer ' + CONFIG.STRIPE_SECRET_KEY,
    },
    payload: payload,
    muteHttpExceptions: true,
  });

  const result = JSON.parse(response.getContentText());

  if (result.error) {
    Logger.log('Stripe error: ' + JSON.stringify(result.error));
    throw new Error('Stripe error: ' + result.error.message);
  }

  return result.url; // The checkout page URL
}

// ===== PROGRESS TRACKER =====

function buildProgressTracker(currentStep, declined) {
  // Steps in the happy path
  const steps = [
    { num: 1, label: 'Request Received' },
    { num: 2, label: 'Host Reviewing' },
    { num: 3, label: 'Accepted' },
    { num: 4, label: 'Payment Sent' },
    { num: 5, label: 'Payment Confirmed' },
    { num: 6, label: 'Booking Confirmed' },
    { num: 7, label: 'Check-in Ready' },
  ];

  // Colors
  const green = '#3d8c40';
  const grey = '#ccc';
  const activeGreen = '#2b4a1f';
  const red = '#c0392b';
  const orange = '#e67e22';

  let html = '<div style="max-width:560px;margin:0 auto 24px;padding:0 16px;">';
  html += '<table cellpadding="0" cellspacing="0" border="0" style="width:100%;border-collapse:collapse;">';

  // Row 1: circles and connecting lines
  html += '<tr>';
  steps.forEach((step, i) => {
    let bgColor, textColor, borderColor;

    if (declined && currentStep === step.num) {
      // Declined or expired step
      bgColor = declined === 'expired' ? orange : red;
      textColor = '#fff';
      borderColor = bgColor;
    } else if (step.num < currentStep) {
      // Completed
      bgColor = green;
      textColor = '#fff';
      borderColor = green;
    } else if (step.num === currentStep) {
      // Current step
      bgColor = activeGreen;
      textColor = '#fff';
      borderColor = activeGreen;
    } else {
      // Future step
      bgColor = '#f5f3ee';
      textColor = '#aaa';
      borderColor = grey;
    }

    // Circle cell
    html += '<td style="text-align:center;width:' + (100/7).toFixed(1) + '%;vertical-align:top;padding:0;">';
    html += '<div style="width:28px;height:28px;border-radius:50%;background:' + bgColor + ';border:2px solid ' + borderColor + ';color:' + textColor + ';font-size:12px;font-weight:700;line-height:28px;text-align:center;margin:0 auto;font-family:-apple-system,BlinkMacSystemFont,sans-serif;">';
    if (step.num < currentStep && !declined) {
      html += '✓';
    } else if (declined && step.num === currentStep) {
      html += step.num < 4 ? '✗' : '!';
    } else {
      html += step.num;
    }
    html += '</div>';
    html += '</td>';

    // Connector line (between circles, not after last)
    if (i < steps.length - 1) {
      const lineColor = step.num < currentStep ? green : grey;
      html += '<td style="vertical-align:top;padding:14px 0 0 0;"><div style="height:2px;background:' + lineColor + ';width:100%;"></div></td>';
    }
  });
  html += '</tr>';

  // Row 2: labels
  html += '<tr>';
  steps.forEach((step, i) => {
    let labelColor = step.num <= currentStep ? '#333' : '#aaa';
    let fontWeight = step.num === currentStep ? '600' : '400';

    if (declined && step.num === currentStep) {
      labelColor = declined === 'expired' ? orange : red;
      fontWeight = '600';
    }

    html += '<td style="text-align:center;vertical-align:top;padding:4px 0 0;">';
    html += '<span style="font-family:-apple-system,BlinkMacSystemFont,sans-serif;font-size:9px;color:' + labelColor + ';font-weight:' + fontWeight + ';line-height:1.2;display:block;">';

    // Override labels for declined/expired
    if (declined === 'declined' && step.num === currentStep) {
      html += 'Declined';
    } else if (declined === 'expired' && step.num === currentStep) {
      html += 'Expired';
    } else {
      html += step.label;
    }
    html += '</span></td>';

    if (i < steps.length - 1) {
      html += '<td></td>'; // spacer for connector column
    }
  });
  html += '</tr>';

  html += '</table></div>';
  return html;
}

// ===== EMAIL TEMPLATES =====

function sendGuestAutoReply(data) {
  const subject = `We received your booking request — ${CONFIG.PROPERTY_NAME}`;
  const html = `
<div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; max-width: 560px; margin: 0 auto; color: #1a1a1a;">
  <div style="background: #2b4a1f; padding: 32px; text-align: center;">
    <h1 style="color: #fff; font-size: 22px; margin: 0;">${CONFIG.PROPERTY_NAME}</h1>
  </div>
  ${buildProgressTracker(1)}
  <div style="padding: 32px; background: #fff;">
    <p style="font-size: 16px; line-height: 1.7;">Hi ${data.firstName},</p>
    <p style="font-size: 16px; line-height: 1.7;">Thank you for your booking request! We've received your inquiry and ${CONFIG.HOST_NAME} will review it shortly. You can expect to hear back within a few hours with confirmed availability, pricing, and next steps.</p>

    <div style="background: #f9f9f6; border: 1px solid #e0ddd6; border-radius: 8px; padding: 20px; margin: 24px 0;">
      <h3 style="margin: 0 0 12px; font-size: 15px; color: #888; text-transform: uppercase; letter-spacing: 0.05em;">Your Request</h3>
      <p style="margin: 4px 0;"><strong>Check-in:</strong> ${data.checkin}</p>
      <p style="margin: 4px 0;"><strong>Checkout:</strong> ${data.checkout}</p>
      ${guestParagraphsHtml(data)}
      ${data.pets > 0 ? `<p style="margin: 4px 0;"><strong>Pets:</strong> ${data.pets}</p>` : ''}
      ${data.occasion ? `<p style="margin: 4px 0;"><strong>Occasion:</strong> ${data.occasion}</p>` : ''}
    </div>

    <p style="font-size: 14px; color: #888; line-height: 1.7;">If you have any questions in the meantime, just reply to this email.</p>
  </div>
  <div style="background: #f5f3ee; padding: 20px 32px; font-size: 13px; color: #888; text-align: center;">
    ${CONFIG.PROPERTY_NAME}
  </div>
</div>`;

  MailApp.sendEmail({
    to: data.email,
    subject: subject,
    htmlBody: html,
    replyTo: CONFIG.HOST_EMAIL,
    name: CONFIG.PROPERTY_NAME,
  });
}

function sendHostNotification(data, rowId) {
  const sheet = getSheet();
  const token = sheet.getRange(rowId, getColIndex('Token')).getValue();
  const scriptUrl = CONFIG.SCRIPT_URL;
  const breakdown = getPricingBreakdown(data);
  const nights = breakdown.nights;

  const acceptUrl = `${scriptUrl}?action=accept&id=${rowId}&token=${token}`;
  const declineUrl = `${scriptUrl}?action=decline&id=${rowId}&token=${token}`;

  const subject = `New Booking Request — ${data.firstName} ${data.lastName} (${data.checkin} → ${data.checkout})`;
  const html = `
<div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; max-width: 560px; margin: 0 auto; color: #1a1a1a;">
  <div style="background: #2b4a1f; padding: 24px 32px;">
    <h1 style="color: #fff; font-size: 18px; margin: 0;">New Booking Request</h1>
  </div>
  ${buildProgressTracker(2)}
  <div style="padding: 32px; background: #fff;">
    <div style="background: #f9f9f6; border: 1px solid #e0ddd6; border-radius: 8px; padding: 20px; margin-bottom: 24px;">
      <h3 style="margin: 0 0 16px; font-size: 18px;">${data.firstName} ${data.lastName}</h3>
      <table style="width: 100%; font-size: 14px; border-collapse: collapse;">
        <tr><td style="padding: 6px 0; color: #888;">Email</td><td style="padding: 6px 0;"><a href="mailto:${data.email}">${data.email}</a></td></tr>
        ${data.phone ? `<tr><td style="padding: 6px 0; color: #888;">Phone</td><td style="padding: 6px 0;">${data.phone}</td></tr>` : ''}
        <tr><td style="padding: 6px 0; color: #888;">Check-in</td><td style="padding: 6px 0; font-weight: 600;">${data.checkin}</td></tr>
        <tr><td style="padding: 6px 0; color: #888;">Checkout</td><td style="padding: 6px 0; font-weight: 600;">${data.checkout}</td></tr>
        <tr><td style="padding: 6px 0; color: #888;">Nights</td><td style="padding: 6px 0;">${nights}</td></tr>
        ${guestTableRowsHtml(data)}
        <tr><td style="padding: 6px 0; color: #888;">Pets</td><td style="padding: 6px 0;">${data.pets || 0}</td></tr>
        ${data.occasion ? `<tr><td style="padding: 6px 0; color: #888;">Occasion</td><td style="padding: 6px 0;">${data.occasion}</td></tr>` : ''}
      </table>
      ${data.message ? `<div style="margin-top: 16px; padding-top: 16px; border-top: 1px solid #e0ddd6;"><p style="font-size: 13px; color: #888; margin: 0 0 4px;">Guest message:</p><p style="margin: 0; font-style: italic;">"${data.message}"</p></div>` : ''}
    </div>

    ${(data.upsellChef || data.upsellCourse) ? `
    <div style="background: #f0f7ee; border: 1px solid #3d8c40; border-radius: 8px; padding: 18px 20px; margin-bottom: 24px;">
      <h3 style="margin: 0 0 12px; font-size: 14px; color: #2b4a1f; text-transform: uppercase; letter-spacing: 0.06em;">⚡ Optional add-ons requested</h3>
      ${data.upsellChef ? `
        <p style="margin: 6px 0; font-size: 14px;"><strong>🍽️ Add a private chef</strong>${data.upsellChefDetails ? `<br><span style="color:#444; font-size:13px;">"${String(data.upsellChefDetails).replace(/</g, '&lt;')}"</span>` : ''}</p>
      ` : ''}
      ${data.upsellCourse ? `
        <p style="margin: 6px 0; font-size: 14px;"><strong>🌱 Add a permaculture experience</strong>${data.upsellCourseDetails ? `<br><span style="color:#444; font-size:13px;">"${String(data.upsellCourseDetails).replace(/</g, '&lt;')}"</span>` : ''}</p>
      ` : ''}
      <p style="margin: 12px 0 0; font-size: 12px; color: #666;">Reply directly to the guest with availability + pricing — these aren't auto-charged.</p>
    </div>` : ''}

    <div style="background: #fff; border: 1px solid #e0ddd6; border-radius: 8px; padding: 20px; margin-bottom: 24px;">
      <h3 style="margin: 0 0 16px; font-size: 15px; color: #888; text-transform: uppercase; letter-spacing: 0.05em;">Cost Breakdown</h3>
      ${buildBreakdownHtml(breakdown)}
    </div>

    <div style="text-align: center; margin: 32px 0;">
      <a href="${acceptUrl}" style="display: inline-block; background: #3d8c40; color: #fff; padding: 14px 40px; border-radius: 50px; text-decoration: none; font-weight: 500; font-size: 14px; margin-right: 12px;">Accept Booking</a>
      <a href="${declineUrl}" style="display: inline-block; background: #fff; color: #c0392b; padding: 14px 40px; border-radius: 50px; text-decoration: none; font-weight: 500; font-size: 14px; border: 1px solid #c0392b;">Decline</a>
    </div>

    <p style="font-size: 13px; color: #888; text-align: center;">Or manage all bookings in your <a href="${SpreadsheetApp.openById(CONFIG.SPREADSHEET_ID).getUrl()}">Google Sheet</a></p>
  </div>
</div>`;

  MailApp.sendEmail({
    to: CONFIG.HOST_EMAIL,
    subject: subject,
    htmlBody: html,
    name: 'SFF Booking System',
  });
}

function sendGuestConditionalAcceptance(data, finalTotal, customMessage, stripeUrl) {
  const subject = `Your dates are available! Payment needed to confirm — ${CONFIG.PROPERTY_NAME}`;
  const nights = calculateNights(data.checkin, data.checkout);

  const html = `
<div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; max-width: 560px; margin: 0 auto; color: #1a1a1a;">
  <div style="background: #2b4a1f; padding: 32px; text-align: center;">
    <h1 style="color: #fff; font-size: 22px; margin: 0;">Your Dates Are Available!</h1>
  </div>
  ${buildProgressTracker(4)}
  <div style="padding: 32px; background: #fff;">
    <p style="font-size: 16px; line-height: 1.7;">Hi ${data.firstName},</p>
    <p style="font-size: 16px; line-height: 1.7;">Great news — your requested dates at ${CONFIG.PROPERTY_NAME} are available! To secure your booking, please complete payment within <strong>48 hours</strong>. Your dates will be held until then.</p>

    ${customMessage ? `<div style="background: #f0f7ee; border-left: 3px solid #3d8c40; padding: 16px 20px; margin: 20px 0; border-radius: 0 8px 8px 0;"><p style="margin: 0; font-style: italic;">"${customMessage}"</p><p style="margin: 8px 0 0; font-size: 13px; color: #888;">— ${CONFIG.HOST_NAME}</p></div>` : ''}

    <div style="background: #f9f9f6; border: 1px solid #e0ddd6; border-radius: 8px; padding: 20px; margin: 24px 0;">
      <h3 style="margin: 0 0 12px; font-size: 15px; color: #888; text-transform: uppercase; letter-spacing: 0.05em;">Stay Details</h3>
      <p style="margin: 4px 0;"><strong>Check-in:</strong> ${data.checkin} (3:00 PM)</p>
      <p style="margin: 4px 0;"><strong>Checkout:</strong> ${data.checkout} (11:00 AM)</p>
      <p style="margin: 4px 0;"><strong>Nights:</strong> ${nights}</p>
      ${guestParagraphsHtml(data)}
      ${data.pets > 0 ? `<p style="margin: 4px 0;"><strong>Pets:</strong> ${data.pets}</p>` : ''}
      <p style="margin: 12px 0 0; font-size: 18px; font-weight: 700;"><strong>Total: $${Number(finalTotal).toLocaleString('en-CA', {minimumFractionDigits: 2, maximumFractionDigits: 2})} CAD</strong> <span style="font-size: 13px; font-weight: 400; color: #888;">(HST included)</span></p>
    </div>

    ${stripeUrl ? `
    <div style="text-align: center; margin: 28px 0;">
      <a href="${stripeUrl}" style="display: inline-block; background: #3d8c40; color: #fff; padding: 16px 48px; border-radius: 50px; text-decoration: none; font-weight: 600; font-size: 16px;">Pay $${Number(finalTotal).toLocaleString('en-CA', {minimumFractionDigits: 2, maximumFractionDigits: 2})} CAD Now</a>
      <p style="font-size: 13px; color: #888; margin-top: 8px;">Secure payment via Stripe — Visa, Mastercard, AMEX accepted</p>
    </div>
    <div style="text-align: center; margin: 16px 0 24px; font-size: 14px; color: #888;">— or —</div>` : ''}

    <div style="background: #f9f9f6; border: 1px solid #e0ddd6; border-radius: 8px; padding: 24px; margin: 0 0 24px;">
      <h3 style="margin: 0 0 12px; font-size: 15px; color: #555;">Pay via Interac e-Transfer</h3>
      <p style="margin: 0 0 4px;">Send <strong>$${Number(finalTotal).toLocaleString('en-CA', {minimumFractionDigits: 2, maximumFractionDigits: 2})} CAD</strong> to:</p>
      <p style="margin: 0; font-size: 16px; font-weight: 600; color: #3d8c40;">${CONFIG.ETRANSFER_EMAIL}</p>
    </div>

    <div style="background: #fff3cd; border: 1px solid #ffc107; border-radius: 8px; padding: 16px 20px; margin: 24px 0;">
      <p style="margin: 0; font-size: 14px;"><strong>⏳ Payment deadline:</strong> Please complete payment within 48 hours. If payment is not received, your dates will be released and made available to other guests.</p>
    </div>

    <div style="margin: 24px 0;">
      <h3 style="font-size: 16px; margin-bottom: 12px;">What Happens Next</h3>
      <p style="font-size: 14px; line-height: 1.7; color: #444;">Once we confirm your payment, you'll receive a final booking confirmation with self check-in instructions, property guide, and everything you need for your stay. If you have any questions, just reply to this email.</p>
    </div>

    <p style="font-size: 14px; color: #1a1a1a;">— ${CONFIG.HOST_NAME}, ${CONFIG.PROPERTY_NAME}</p>
  </div>
  <div style="background: #f5f3ee; padding: 20px 32px; font-size: 13px; color: #888; text-align: center;">
    ${CONFIG.PROPERTY_NAME}
  </div>
</div>`;

  MailApp.sendEmail({
    to: data.email,
    subject: subject,
    htmlBody: html,
    replyTo: CONFIG.HOST_EMAIL,
    name: CONFIG.PROPERTY_NAME,
  });
}

function sendHostPaymentReminder(data, finalTotal, rowId, token) {
  const scriptUrl = CONFIG.SCRIPT_URL;
  const confirmPaymentUrl = `${scriptUrl}?action=confirm_payment&id=${rowId}&token=${token}`;
  const expireUrl = `${scriptUrl}?action=expire_booking&id=${rowId}&token=${token}`;
  const declineUrl = `${scriptUrl}?action=decline&id=${rowId}&token=${token}`;

  const subject = `⏳ Awaiting Payment — ${data.firstName} ${data.lastName} (${data.checkin} → ${data.checkout})`;
  const html = `
<div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; max-width: 560px; margin: 0 auto; color: #1a1a1a;">
  <div style="background: #e67e22; padding: 24px 32px;">
    <h1 style="color: #fff; font-size: 18px; margin: 0;">Awaiting Payment</h1>
  </div>
  ${buildProgressTracker(4)}
  <div style="padding: 32px; background: #fff;">
    <p style="font-size: 15px; line-height: 1.7;">Payment instructions have been sent to <strong>${data.firstName} ${data.lastName}</strong> (${data.email}) for <strong>$${Number(finalTotal).toLocaleString('en-CA', {minimumFractionDigits: 2, maximumFractionDigits: 2})} CAD</strong>.</p>
    <p style="font-size: 15px; line-height: 1.7;">Once you've verified the payment has landed in your account, click the button below to finalize the booking and send the guest their check-in instructions.</p>

    <div style="text-align: center; margin: 32px 0;">
      <a href="${confirmPaymentUrl}" style="display: inline-block; background: #3d8c40; color: #fff; padding: 14px 40px; border-radius: 50px; text-decoration: none; font-weight: 500; font-size: 14px;">Confirm Payment Received</a>
    </div>
    <div style="text-align: center; margin: 16px 0;">
      <a href="${expireUrl}" style="display: inline-block; color: #e67e22; font-size: 13px; text-decoration: underline;">Payment not received — release dates</a>
      &nbsp;&nbsp;·&nbsp;&nbsp;
      <a href="${declineUrl}" style="display: inline-block; color: #c0392b; font-size: 13px; text-decoration: underline;">Decline booking</a>
    </div>

    <p style="font-size: 13px; color: #888; text-align: center; margin-top: 24px;">Or manage in your <a href="${SpreadsheetApp.openById(CONFIG.SPREADSHEET_ID).getUrl()}">Google Sheet</a></p>
  </div>
</div>`;

  MailApp.sendEmail({
    to: CONFIG.HOST_EMAIL,
    subject: subject,
    htmlBody: html,
    name: 'SFF Booking System',
  });
}

function sendGuestFinalConfirmation(data, checkinInstructions, confirmMessage, paymentMethod) {
  const subject = `You're all set! Final booking confirmation — ${CONFIG.PROPERTY_NAME}`;
  const nights = calculateNights(data.checkin, data.checkout);
  const scriptUrl = CONFIG.SCRIPT_URL;
  const rowId = data.rowId || '';
  // If rowId is missing from data, look it up
  let effectiveRowId = rowId;
  if (!effectiveRowId) {
    try {
      const sheet = getSheet();
      const lastRow = sheet.getLastRow();
      if (lastRow >= 2) {
        const ids = sheet.getRange(2, 1, lastRow - 1, 1).getValues();
        for (let i = 0; i < ids.length; i++) {
          if (ids[i][0] === data.id) { effectiveRowId = i + 2; break; }
        }
      }
    } catch (e) { Logger.log('rowId lookup failed: ' + e.toString()); }
  }
  const manageUrl = effectiveRowId && data.token
    ? scriptUrl + '?action=guest_manage&id=' + effectiveRowId + '&token=' + data.token
    : '';

  const html = `
<div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; max-width: 560px; margin: 0 auto; color: #1a1a1a;">
  <div style="background: #2b4a1f; padding: 32px; text-align: center;">
    <h1 style="color: #fff; font-size: 22px; margin: 0;">You're All Set! ✅</h1>
  </div>
  ${buildProgressTracker(7)}
  <div style="padding: 32px; background: #fff;">
    <p style="font-size: 16px; line-height: 1.7;">Hi ${data.firstName},</p>
    <p style="font-size: 16px; line-height: 1.7;">Your payment has been received and your booking at ${CONFIG.PROPERTY_NAME} is now <strong>fully confirmed</strong>. We can't wait to host you!</p>

    ${confirmMessage ? `<div style="background: #f0f7ee; border-left: 3px solid #3d8c40; padding: 16px 20px; margin: 20px 0; border-radius: 0 8px 8px 0;"><p style="margin: 0; font-style: italic;">"${confirmMessage}"</p><p style="margin: 8px 0 0; font-size: 13px; color: #888;">— ${CONFIG.HOST_NAME}</p></div>` : ''}

    <div style="background: #f9f9f6; border: 1px solid #e0ddd6; border-radius: 8px; padding: 20px; margin: 24px 0;">
      <h3 style="margin: 0 0 12px; font-size: 15px; color: #888; text-transform: uppercase; letter-spacing: 0.05em;">Confirmed Stay</h3>
      <p style="margin: 4px 0;"><strong>Check-in:</strong> ${data.checkin} (3:00 PM)</p>
      <p style="margin: 4px 0;"><strong>Checkout:</strong> ${data.checkout} (11:00 AM)</p>
      <p style="margin: 4px 0;"><strong>Nights:</strong> ${nights}</p>
      ${guestParagraphsHtml(data)}
      ${data.pets > 0 ? `<p style="margin: 4px 0;"><strong>Pets:</strong> ${data.pets}</p>` : ''}
      <p style="margin: 4px 0;"><strong>Payment:</strong> $${Number(data.finalTotal).toLocaleString('en-CA', {minimumFractionDigits: 2, maximumFractionDigits: 2})} CAD via ${paymentMethod} ✓</p>
    </div>

    ${checkinInstructions ? `
    <div style="background: #fff; border: 2px solid #3d8c40; border-radius: 8px; padding: 24px; margin: 24px 0;">
      <h3 style="margin: 0 0 16px; font-size: 16px; color: #3d8c40;">Check-In Instructions</h3>
      <p style="font-size: 14px; line-height: 1.8; color: #333; white-space: pre-line;">${checkinInstructions}</p>
    </div>` : ''}

    <div style="margin: 24px 0;">
      <h3 style="font-size: 16px; margin-bottom: 12px;">Property Address</h3>
      <p style="font-size: 14px; line-height: 1.7; color: #444;">${CONFIG.PROPERTY_ADDRESS}</p>
      <a href="https://www.google.com/maps/search/?api=1&query=Straight+Fin+Farms" style="font-size: 14px; color: #3d8c40; text-decoration: underline;">Open in Google Maps</a>
    </div>

    <div style="margin: 24px 0;">
      <h3 style="font-size: 16px; margin-bottom: 12px;">House Rules Reminder</h3>
      <p style="font-size: 14px; line-height: 1.7; color: #444;">Check-in: 3:00 PM · Checkout: 11:00 AM · No smoking indoors · Quiet hours: 11 PM – 7 AM · Events allowed with notice</p>
    </div>

    <p style="font-size: 14px; line-height: 1.7; color: #444;">If you have any questions before your stay, just reply to this email. We're here to help make your trip perfect.</p>

    ${manageUrl ? `
    <div style="margin: 24px 0 8px; padding-top: 20px; border-top: 1px solid #e0ddd6;">
      <h3 style="font-size: 15px; margin: 0 0 8px; color: #555;">Need to make changes?</h3>
      <p style="font-size: 14px; line-height: 1.6; color: #555; margin: 0 0 12px;">You can request a change or cancel your booking anytime. Cancellations more than 30 days before check-in are fully refundable; inside 30 days is non-refundable per our strict policy.</p>
      <a href="${manageUrl}" style="display: inline-block; padding: 10px 18px; background: #fff; color: #2e6e31; border: 1.5px solid #2e6e31; border-radius: 8px; text-decoration: none; font-size: 14px; font-weight: 500;">Manage your booking</a>
    </div>` : ''}

    <p style="font-size: 14px; color: #1a1a1a;">See you soon!<br>— ${CONFIG.HOST_NAME}, ${CONFIG.PROPERTY_NAME}</p>
  </div>
  <div style="background: #f5f3ee; padding: 20px 32px; font-size: 13px; color: #888; text-align: center;">
    ${CONFIG.PROPERTY_NAME} &middot; ${CONFIG.PROPERTY_ADDRESS}
  </div>
</div>`;

  MailApp.sendEmail({
    to: data.email,
    subject: subject,
    htmlBody: html,
    replyTo: CONFIG.HOST_EMAIL,
    name: CONFIG.PROPERTY_NAME,
  });
}

function sendGuestExpired(data) {
  const subject = `Update on your booking hold — ${CONFIG.PROPERTY_NAME}`;

  const html = `
<div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; max-width: 560px; margin: 0 auto; color: #1a1a1a;">
  <div style="background: #2b4a1f; padding: 32px; text-align: center;">
    <h1 style="color: #fff; font-size: 22px; margin: 0;">${CONFIG.PROPERTY_NAME}</h1>
  </div>
  ${buildProgressTracker(4, 'expired')}
  <div style="padding: 32px; background: #fff;">
    <p style="font-size: 16px; line-height: 1.7;">Hi ${data.firstName},</p>
    <p style="font-size: 16px; line-height: 1.7;">We're writing to let you know that your date hold for <strong>${data.checkin} → ${data.checkout}</strong> at ${CONFIG.PROPERTY_NAME} has been released, as we didn't receive payment within the 48-hour window.</p>
    <p style="font-size: 16px; line-height: 1.7;">If you're still interested in staying with us, you're welcome to submit a new booking request — we'd love to host you!</p>

    <div style="text-align: center; margin: 32px 0;">
      <a href="https://airbnb.ca/h/straightfinfarms" style="display: inline-block; background: #3d8c40; color: #fff; padding: 14px 40px; border-radius: 50px; text-decoration: none; font-weight: 500; font-size: 14px;">Check Available Dates</a>
    </div>

    <p style="font-size: 14px; color: #888; line-height: 1.7;">Warm regards,<br>${CONFIG.HOST_NAME}, ${CONFIG.PROPERTY_NAME}</p>
  </div>
  <div style="background: #f5f3ee; padding: 20px 32px; font-size: 13px; color: #888; text-align: center;">
    ${CONFIG.PROPERTY_NAME}
  </div>
</div>`;

  MailApp.sendEmail({
    to: data.email,
    subject: subject,
    htmlBody: html,
    replyTo: CONFIG.HOST_EMAIL,
    name: CONFIG.PROPERTY_NAME,
  });
}

function sendGuestDecline(data, declineMessage) {
  const subject = `Update on your booking request — ${CONFIG.PROPERTY_NAME}`;

  const defaultMsg = "Unfortunately, the dates you requested aren't available. We'd love to host you another time — feel free to check our calendar for open dates and send a new request!";
  const message = declineMessage || defaultMsg;

  const html = `
<div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; max-width: 560px; margin: 0 auto; color: #1a1a1a;">
  <div style="background: #2b4a1f; padding: 32px; text-align: center;">
    <h1 style="color: #fff; font-size: 22px; margin: 0;">${CONFIG.PROPERTY_NAME}</h1>
  </div>
  ${buildProgressTracker(3, 'declined')}
  <div style="padding: 32px; background: #fff;">
    <p style="font-size: 16px; line-height: 1.7;">Hi ${data.firstName},</p>
    <p style="font-size: 16px; line-height: 1.7;">Thank you for your interest in staying at ${CONFIG.PROPERTY_NAME}. Unfortunately, we're unable to accommodate your request for <strong>${data.checkin} → ${data.checkout}</strong> at this time.</p>

    ${declineMessage ? `<div style="background: #f9f9f6; border-left: 3px solid #e0ddd6; padding: 16px 20px; margin: 20px 0; border-radius: 0 8px 8px 0;"><p style="margin: 0; font-style: italic;">"${declineMessage}"</p><p style="margin: 8px 0 0; font-size: 13px; color: #888;">— ${CONFIG.HOST_NAME}</p></div>` : ''}

    <p style="font-size: 16px; line-height: 1.7;">If you'd like to try different dates, you're always welcome to visit our booking page and submit a new request. We'd love to host you in the future.</p>

    <div style="text-align: center; margin: 32px 0;">
      <a href="https://airbnb.ca/h/straightfinfarms" style="display: inline-block; background: #3d8c40; color: #fff; padding: 14px 40px; border-radius: 50px; text-decoration: none; font-weight: 500; font-size: 14px;">Check Available Dates</a>
    </div>

    <p style="font-size: 14px; color: #888; line-height: 1.7;">Warm regards,<br>${CONFIG.HOST_NAME}, ${CONFIG.PROPERTY_NAME}</p>
  </div>
  <div style="background: #f5f3ee; padding: 20px 32px; font-size: 13px; color: #888; text-align: center;">
    ${CONFIG.PROPERTY_NAME}
  </div>
</div>`;

  MailApp.sendEmail({
    to: data.email,
    subject: subject,
    htmlBody: html,
    replyTo: CONFIG.HOST_EMAIL,
    name: CONFIG.PROPERTY_NAME,
  });
}

// ===== UTILITIES =====

function formatDateValue(val) {
  if (!val) return '';
  if (val instanceof Date) {
    const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
    return days[val.getDay()] + ', ' + months[val.getMonth()] + ' ' + val.getDate() + ', ' + val.getFullYear();
  }
  // If it's already a string like "2026-08-15", format it nicely
  if (typeof val === 'string' && val.match(/^\d{4}-\d{2}-\d{2}$/)) {
    const d = new Date(val + 'T12:00:00');
    const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
    return days[d.getDay()] + ', ' + months[d.getMonth()] + ' ' + d.getDate() + ', ' + d.getFullYear();
  }
  return String(val);
}

function jsonResponse(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

function errorPage(msg) {
  return `<!DOCTYPE html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><style>body{font-family:-apple-system,sans-serif;max-width:500px;margin:80px auto;padding:20px;text-align:center;}h1{color:#c0392b;}</style></head><body><h1>Error</h1><p>${msg}</p></body></html>`;
}

function alreadyHandledPage(status) {
  return `<!DOCTYPE html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><style>body{font-family:-apple-system,sans-serif;max-width:500px;margin:80px auto;padding:20px;text-align:center;}h1{color:#888;}</style></head><body><h1>Already Handled</h1><p>This booking has already been <strong>${status.toLowerCase()}</strong>. No further action needed.</p></body></html>`;
}

// ===== TEST: Run this to test Stripe API connection =====
function testStripe() {
  const response = UrlFetchApp.fetch('https://api.stripe.com/v1/checkout/sessions', {
    method: 'post',
    headers: {
      'Authorization': 'Bearer ' + CONFIG.STRIPE_SECRET_KEY,
    },
    payload: 'payment_method_types[]=card&mode=payment&currency=cad&line_items[0][price_data][currency]=cad&line_items[0][price_data][unit_amount]=100&line_items[0][price_data][product_data][name]=Test&line_items[0][quantity]=1&success_url=https://example.com/success&cancel_url=https://example.com/cancel',
    muteHttpExceptions: true,
  });
  const result = JSON.parse(response.getContentText());
  Logger.log('Result: ' + JSON.stringify(result.url || result.error));
}

// ===== SETUP: Run this once to create the sheet =====
function setup() {
  getSheet();
  Logger.log('Bookings sheet created. Now deploy as web app:');
  Logger.log('Deploy → New deployment → Web app → Execute as Me → Anyone can access');
}
