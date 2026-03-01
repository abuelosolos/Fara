require('dotenv').config();

const express    = require('express');
const cors       = require('cors');
const fetch      = require('node-fetch');
const mongoose   = require('mongoose');
const { Resend } = require('resend');
const path       = require('path');

const app = express();
app.use(cors({ origin: '*' }));
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

/* ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
   CONFIG
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ */
const PAYSTACK_SECRET = process.env.PAYSTACK_SECRET;
const RESEND_API_KEY  = process.env.RESEND_API_KEY;
const FROM_EMAIL      = process.env.FROM_EMAIL;
const OWNER_EMAIL     = process.env.OWNER_EMAIL;
const MONGO_URI       = process.env.MONGO_URI;
const ADMIN_PASSWORD  = process.env.ADMIN_PASSWORD;

const TEST_MODE  = true;                    // ← set false when you have a real domain
const TEST_EMAIL = 'kbatomate@gmail.com';   // ← your Resend signup email

const resend = new Resend(RESEND_API_KEY);
function toEmail(email) { return TEST_MODE ? TEST_EMAIL : email; }

/* ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
   DATABASE
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ */
mongoose.connect(MONGO_URI)
  .then(() => console.log('✅ MongoDB connected'))
  .catch(err => console.error('❌ MongoDB error:', err));

/* ── Order Schema ── */
const orderSchema = new mongoose.Schema({
  reference:         { type: String, unique: true, required: true },
  name:              String,
  email:             String,
  phone:             String,
  address:           String,
  product:           String,
  qty:               Number,
  total:             Number,
  status:            { type: String, default: 'received', enum: ['received','dispatched','delayed','delivered'] },
  estimatedDelivery: { type: String, default: '' },
  delayReason:       { type: String, default: '' },
  createdAt:         { type: Date, default: Date.now }
});
const Order = mongoose.model('Order', orderSchema);

/* ── Day Override Schema ──
   Every day is open by default with DEFAULT_SLOTS.
   You can:
   - Block an entire day (blocked: true)
   - Override slots for a specific day (slots: [...])
   Booked+confirmed slots are excluded dynamically from bookings collection.
*/
// Working hours: 9 AM to 6 PM (in minutes from midnight)
const DAY_START_MINS = 9 * 60;   // 9:00 AM
const DAY_END_MINS   = 18 * 60;  // 6:00 PM

// Legacy — kept for admin override compatibility
const DEFAULT_SLOTS = ['9:00 AM','10:00 AM','11:00 AM','12:00 PM','1:00 PM','2:00 PM','3:00 PM','4:00 PM','5:00 PM'];

/* ── SERVICE DURATIONS (single source of truth) ──
   Update durations here and slot blocking updates automatically everywhere.
   Format: minutes as a number.
*/
const SERVICE_DURATIONS = {
  'Hair Grooming':            120,
  'Retouching':               150,
  'Hair Breakage Treatment':  180,
  'Dandruff Treatment':       130,
  'Braiding — Large':         240,
  'Braiding — Medium':        180,
  'Braiding — Small':         120,
  'Wig Revamp':               120,
  'Wig Installation':         90,
};

// Resolve duration in minutes for a booking
// Uses SERVICE_DURATIONS as source of truth, falls back to saved duration string
function resolveDurationMins(serviceName, savedDuration) {
  // Always prefer live service definition so duration changes take effect immediately
  if (SERVICE_DURATIONS[serviceName] !== undefined) {
    return SERVICE_DURATIONS[serviceName];
  }
  // Fallback for unknown/custom services: parse saved duration string
  if (!savedDuration) return 60;
  if (savedDuration.includes('hr')) return Math.round(parseFloat(savedDuration) * 60);
  return Math.round(parseFloat(savedDuration));
}

const dayOverrideSchema = new mongoose.Schema({
  date:    { type: String, required: true, unique: true }, // "2026-03-01"
  blocked: { type: Boolean, default: false },
  slots:   { type: [String], default: null }               // null = use DEFAULT_SLOTS
});
const DayOverride = mongoose.model('DayOverride', dayOverrideSchema);

/* ── Booking Schema ── */
const bookingSchema = new mongoose.Schema({
  reference:     { type: String, unique: true, required: true },
  name:          String,
  email:         String,
  phone:         String,
  address:       String,
  service:       String,
  date:          String,   // "2026-03-01"
  time:          String,   // "10:00 AM"
  endTime:       String,   // "1:00 PM"  (start + duration)
  duration:      String,   // "90 min"
  paymentMethod: { type: String, default: 'now', enum: ['now','after'] },
  price:         Number,
  fee:           Number,
  total:         Number,
  // pay-now + confirmed = slot immediately blocked
  // pay-after + pending = awaiting your call, slot still open
  // confirmed (from admin) = slot blocked
  // cancelled = slot opens back up
  // completed = done
  status:        { type: String, default: 'pending', enum: ['pending','confirmed','cancelled','completed'] },
  createdAt:     { type: Date, default: Date.now }
});
const Booking = mongoose.model('Booking', bookingSchema);

/* ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
   EMAIL HELPERS
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ */
function emailWrapper(content) {
  return `<!DOCTYPE html>
<html><body style="margin:0;padding:0;background:#faf9f7;font-family:Arial,sans-serif;">
  <div style="max-width:560px;margin:40px auto;background:#fff;border-radius:16px;overflow:hidden;box-shadow:0 4px 24px rgba(0,0,0,0.06);">
    <div style="background:linear-gradient(135deg,#3d1a5e,#6b3fa0);padding:36px 32px;text-align:center;">
      <h1 style="color:#fff;font-size:28px;font-weight:300;letter-spacing:0.1em;margin:0;">Pharahs</h1>
      <p style="color:rgba(255,255,255,0.7);font-size:13px;margin:6px 0 0;">Premium Salon & Beauty</p>
    </div>
    <div style="padding:32px;">${content}</div>
    <div style="padding:20px 32px;border-top:1px solid rgba(107,63,160,0.08);text-align:center;">
      <p style="font-size:12px;color:rgba(15,10,20,0.35);margin:0;">© 2026 Pharahs Salon · Questions? Call +234 800 000 0000</p>
    </div>
  </div>
</body></html>`;
}

function summaryBlock(order) {
  return `
  <div style="background:#f0ebf7;border-radius:12px;padding:20px;margin:20px 0;">
    <p style="font-size:11px;letter-spacing:0.15em;text-transform:uppercase;color:#6b3fa0;margin:0 0 12px;">Order Summary</p>
    <table style="width:100%;border-collapse:collapse;font-size:14px;">
      <tr><td style="padding:5px 0;color:rgba(15,10,20,0.55);">Reference</td><td style="text-align:right;color:#0f0a14;font-weight:500;">${order.reference}</td></tr>
      <tr><td style="padding:5px 0;color:rgba(15,10,20,0.55);">Product</td><td style="text-align:right;color:#0f0a14;">${order.product} × ${order.qty}</td></tr>
      <tr><td style="padding:5px 0;color:rgba(15,10,20,0.55);">Delivery To</td><td style="text-align:right;color:#0f0a14;">${order.address}</td></tr>
      <tr style="border-top:1px solid rgba(107,63,160,0.15);">
        <td style="padding:10px 0 0;color:#0f0a14;font-weight:500;">Total Paid</td>
        <td style="padding:10px 0 0;text-align:right;color:#3d1a5e;font-size:18px;font-weight:600;">&#x20A6;${order.total.toLocaleString()}</td>
      </tr>
    </table>
  </div>`;
}

function bookingSummaryBlock(b) {
  const dateLabel  = new Date(b.date + 'T00:00:00').toLocaleDateString('en-GB',{weekday:'long',day:'numeric',month:'long',year:'numeric'});
  const timeRange  = b.endTime ? `${b.time} – ${b.endTime}` : b.time;
  const payLabel   = b.paymentMethod === 'after' ? 'Pay After Service' : 'Paid via Card';
  return `
  <div style="background:#f0ebf7;border-radius:12px;padding:20px;margin:20px 0;">
    <p style="font-size:11px;letter-spacing:0.15em;text-transform:uppercase;color:#6b3fa0;margin:0 0 12px;">Appointment Details</p>
    <table style="width:100%;border-collapse:collapse;font-size:14px;">
      <tr><td style="padding:5px 0;color:rgba(15,10,20,0.55);">Service</td><td style="text-align:right;color:#0f0a14;font-weight:500;">${b.service}</td></tr>
      <tr><td style="padding:5px 0;color:rgba(15,10,20,0.55);">Date</td><td style="text-align:right;color:#0f0a14;">${dateLabel}</td></tr>
      <tr><td style="padding:5px 0;color:rgba(15,10,20,0.55);">Time</td><td style="text-align:right;color:#0f0a14;">${timeRange}</td></tr>
      <tr><td style="padding:5px 0;color:rgba(15,10,20,0.55);">Duration</td><td style="text-align:right;color:#0f0a14;">${b.duration || '—'}</td></tr>
      <tr><td style="padding:5px 0;color:rgba(15,10,20,0.55);">Location</td><td style="text-align:right;color:#0f0a14;">${b.address}</td></tr>
      <tr><td style="padding:5px 0;color:rgba(15,10,20,0.55);">Payment</td><td style="text-align:right;color:#0f0a14;">${payLabel}</td></tr>
      <tr style="border-top:1px solid rgba(107,63,160,0.15);">
        <td style="padding:10px 0 0;color:#0f0a14;font-weight:500;">Total</td>
        <td style="padding:10px 0 0;text-align:right;color:#3d1a5e;font-size:18px;font-weight:600;">&#x20A6;${b.total.toLocaleString()}</td>
      </tr>
    </table>
  </div>`;
}

function getOrderEmailTemplate(order, status, delayReason = '') {
  const { name, product, estimatedDelivery } = order;
  const templates = {
    received: {
      subject: `Order Confirmed! 🎉 — Ref: ${order.reference}`,
      body: `
        <h2 style="color:#0f0a14;font-size:22px;font-weight:400;margin:0 0 8px;">Order Confirmed! 🎉</h2>
        <p style="color:rgba(15,10,20,0.6);font-size:14px;line-height:1.75;margin:0 0 4px;">Hi <strong>${name}</strong>, thank you for your order!</p>
        <p style="color:rgba(15,10,20,0.6);font-size:14px;line-height:1.75;margin:0 0 16px;">We've received your payment and are preparing your <strong>${product}</strong> for dispatch.</p>
        ${summaryBlock(order)}
        <p style="color:rgba(15,10,20,0.6);font-size:13px;line-height:1.7;margin:0;">📦 Estimated delivery: <strong>${estimatedDelivery || '2–5 business days'}</strong><br>We'll send you updates every step of the way. 💜</p>`
    },
    dispatched: {
      subject: `Your Pharahs order is on its way! 🚚 — Ref: ${order.reference}`,
      body: `
        <h2 style="color:#0f0a14;font-size:22px;font-weight:400;margin:0 0 8px;">It's on its way! 🚚</h2>
        <p style="color:rgba(15,10,20,0.6);font-size:14px;line-height:1.75;margin:0 0 4px;">Great news, <strong>${name}</strong>!</p>
        <p style="color:rgba(15,10,20,0.6);font-size:14px;line-height:1.75;margin:0 0 16px;">Your <strong>${product}</strong> has been dispatched and is heading your way.</p>
        <div style="background:#f0ebf7;border-radius:12px;padding:18px 20px;margin-bottom:20px;text-align:center;">
          <p style="font-size:11px;letter-spacing:0.15em;text-transform:uppercase;color:#6b3fa0;margin:0 0 6px;">Expected Delivery Date</p>
          <p style="font-size:24px;color:#3d1a5e;font-weight:600;margin:0;">${estimatedDelivery}</p>
        </div>
        ${summaryBlock(order)}
        <p style="color:rgba(15,10,20,0.6);font-size:13px;line-height:1.7;margin:0;">Please ensure someone is available to receive the package. 💜</p>`
    },
    delayed: {
      subject: `Update on your Pharahs order ⚠️ — Ref: ${order.reference}`,
      body: `
        <h2 style="color:#0f0a14;font-size:22px;font-weight:400;margin:0 0 8px;">Delivery Update ⚠️</h2>
        <p style="color:rgba(15,10,20,0.6);font-size:14px;line-height:1.75;margin:0 0 4px;">Hi <strong>${name}</strong>, we sincerely apologise for this update.</p>
        <p style="color:rgba(15,10,20,0.6);font-size:14px;line-height:1.75;margin:0 0 16px;">Your <strong>${product}</strong> has experienced a slight delay.</p>
        <div style="background:#fff4e5;border-radius:12px;padding:18px 20px;margin-bottom:16px;border-left:4px solid #d4a96a;">
          <p style="font-size:11px;letter-spacing:0.12em;text-transform:uppercase;color:#b8860b;margin:0 0 6px;">Reason for Delay</p>
          <p style="font-size:14px;color:#0f0a14;margin:0;">${delayReason || 'Unforeseen logistics circumstances'}</p>
        </div>
        <div style="background:#f0ebf7;border-radius:12px;padding:18px 20px;margin-bottom:20px;text-align:center;">
          <p style="font-size:11px;letter-spacing:0.15em;text-transform:uppercase;color:#6b3fa0;margin:0 0 6px;">New Expected Delivery</p>
          <p style="font-size:24px;color:#3d1a5e;font-weight:600;margin:0;">${estimatedDelivery}</p>
        </div>
        ${summaryBlock(order)}
        <p style="color:rgba(15,10,20,0.6);font-size:13px;line-height:1.7;margin:0;">We truly appreciate your patience. Reach out for a discount on your next order. 💜</p>`
    },
    delivered: {
      subject: `Your Pharahs order has been delivered! 🎉 — Ref: ${order.reference}`,
      body: `
        <h2 style="color:#0f0a14;font-size:22px;font-weight:400;margin:0 0 8px;">Delivered! 🎉</h2>
        <p style="color:rgba(15,10,20,0.6);font-size:14px;line-height:1.75;margin:0 0 4px;">Hi <strong>${name}</strong>, your order has arrived!</p>
        <p style="color:rgba(15,10,20,0.6);font-size:14px;line-height:1.75;margin:0 0 16px;">Your <strong>${product}</strong> has been successfully delivered to your address.</p>
        <div style="background:#f0ebf7;border-radius:12px;padding:24px 20px;margin-bottom:20px;text-align:center;">
          <p style="font-size:36px;margin:0;">💜</p>
          <p style="font-size:15px;color:#3d1a5e;font-weight:500;margin:10px 0 0;">Thank you for choosing Pharahs!</p>
        </div>
        ${summaryBlock(order)}
        <p style="color:rgba(15,10,20,0.6);font-size:13px;line-height:1.7;margin:0;">Any issues? Reply to this email within 7 days. 💜</p>`
    }
  };
  return templates[status];
}

/* ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
   HEALTH CHECK
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ */
app.get('/ping', (req, res) => res.json({ success: true, message: 'Pharahs backend running ✅' }));

// Public — frontend reads this to show correct duration on booking page
app.get('/booking/service-durations', (req, res) => {
  res.json({ success: true, durations: SERVICE_DURATIONS });
});

// Admin — update a service duration (takes effect immediately on all future slot checks)
app.post('/admin/set-service-duration', adminAuth, async (req, res) => {
  const { service, minutes } = req.body;
  if (!service || typeof minutes !== 'number') {
    return res.status(400).json({ success: false, message: 'Provide service name and minutes' });
  }
  SERVICE_DURATIONS[service] = minutes;
  console.log(`✅ Duration updated: ${service} = ${minutes} mins`);
  res.json({ success: true, durations: SERVICE_DURATIONS });
});

/* ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
   ORDERS — Verify Payment + Save + Email
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ */
app.post('/verify-payment', async (req, res) => {
  const { reference, orderDetails } = req.body;
  try {
    const paystackRes  = await fetch(`https://api.paystack.co/transaction/verify/${reference}`, {
      headers: { Authorization: `Bearer ${PAYSTACK_SECRET}` }
    });
    const paystackData = await paystackRes.json();
    if (!paystackData.status || paystackData.data.status !== 'success') {
      return res.json({ success: false, message: 'Payment verification failed' });
    }
    const order = await Order.create({ reference, ...orderDetails, status: 'received', estimatedDelivery: '2–5 business days' });
    console.log('✅ Order saved:', order._id);
    const template = getOrderEmailTemplate(order, 'received');
    await resend.emails.send({ from: FROM_EMAIL, to: toEmail(order.email), subject: template.subject, html: emailWrapper(template.body) });
    await resend.emails.send({
      from: FROM_EMAIL, to: OWNER_EMAIL,
      subject: `🛍️ New Order — ${order.product} (${reference})`,
      html: emailWrapper(`
        <h2 style="color:#0f0a14;margin:0 0 16px;">New Order!</h2>
        <table style="width:100%;font-size:14px;border-collapse:collapse;">
          <tr><td style="padding:6px 0;color:rgba(15,10,20,0.55);">Customer</td><td style="text-align:right;font-weight:500;">${order.name}</td></tr>
          <tr><td style="padding:6px 0;color:rgba(15,10,20,0.55);">Email</td><td style="text-align:right;">${order.email}</td></tr>
          <tr><td style="padding:6px 0;color:rgba(15,10,20,0.55);">Phone</td><td style="text-align:right;">${order.phone}</td></tr>
          <tr><td style="padding:6px 0;color:rgba(15,10,20,0.55);">Product</td><td style="text-align:right;">${order.product} × ${order.qty}</td></tr>
          <tr><td style="padding:6px 0;color:rgba(15,10,20,0.55);">Address</td><td style="text-align:right;">${order.address}</td></tr>
          <tr style="border-top:1px solid rgba(107,63,160,0.15);">
            <td style="padding:10px 0 0;font-weight:500;">Total</td>
            <td style="padding:10px 0 0;text-align:right;color:#3d1a5e;font-size:18px;font-weight:600;">&#x20A6;${order.total.toLocaleString()}</td>
          </tr>
        </table>`)
    });
    res.json({ success: true });
  } catch (err) {
    console.error('❌ Verify error:', err);
    res.status(500).json({ success: false, message: err.message });
  }
});

/* ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
   BOOKINGS — Public Routes
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ */

// Server-side duration slot helper
function getSlotsForBookingServer(startTime, durationMins, allSlots) {
  function timeToMins(t) {
    const [time, period] = t.split(' ');
    let [h, m] = time.split(':').map(Number);
    if (period === 'PM' && h !== 12) h += 12;
    if (period === 'AM' && h === 12) h = 0;
    return h * 60 + m;
  }
  const start = timeToMins(startTime);
  const end   = start + durationMins;
  return allSlots.filter(s => {
    const sm = timeToMins(s);
    return sm >= start && sm < end;
  });
}

// ── Time helpers (module-level so reusable) ──────────────────────
function minsToTimeStr(mins) {
  let h = Math.floor(mins / 60) % 24;
  const m = mins % 60;
  const period = h >= 12 ? 'PM' : 'AM';
  if (h > 12) h -= 12;
  if (h === 0) h = 12;
  return `${h}:${m.toString().padStart(2,'0')} ${period}`;
}
function timeStrToMins(t) {
  const [time, period] = t.split(' ');
  let [h, m] = time.split(':').map(Number);
  if (period === 'PM' && h !== 12) h += 12;
  if (period === 'AM' && h === 12) h = 0;
  return h * 60 + m;
}

// Returns next 60 days with interval slots per service.
//
// Logic:
// - Day runs DAY_START_MINS → DAY_END_MINS (9 AM – 6 PM)
// - Each confirmed booking occupies [startMins, startMins + durMins)
// - For each service, we generate clean non-overlapping start times
//   stepping by that service's duration (9→12→3→6 for 3hr, 9→10:30→12→... for 90min)
// - A start time is available if its full range [start, start+dur) does NOT
//   overlap any confirmed booking on that day
// - Cross-service blocking: a Facial booked 9-10AM blocks any other service
//   whose interval overlaps 9-10AM
app.get('/booking/available-dates', async (req, res) => {
  try {
    const overrides = await DayOverride.find({});
    const confirmed = await Booking.find({ status: 'confirmed' });

    const overrideMap = {};
    overrides.forEach(o => { overrideMap[o.date] = o; });

    // Build list of busy ranges per date: [{start, end}] in minutes
    const busyMap = {};
    confirmed.forEach(b => {
      if (!busyMap[b.date]) busyMap[b.date] = [];
      const startMins = timeStrToMins(b.time);
      const durMins   = resolveDurationMins(b.service, b.duration);
      busyMap[b.date].push({ start: startMins, end: startMins + durMins });
    });

    // Check if a range [startMins, startMins+durMins) overlaps any busy range
    function isRangeFree(busyRanges, startMins, durMins) {
      const endMins = startMins + durMins;
      return !busyRanges.some(r => startMins < r.end && endMins > r.start);
    }

    const result = [];
    const now     = new Date();

    // Accept optional ?localMins=NNN from frontend (minutes since midnight in user's timezone)
    // e.g. 12:30 PM = 750. Falls back to server time if not provided.
    const localMinsParam = parseInt(req.query.localMins);
    const nowMinsToday   = !isNaN(localMinsParam) ? localMinsParam : (now.getHours() * 60 + now.getMinutes());

    // Today's date string using the optional ?localDate=YYYY-MM-DD from frontend
    // so the "today" cutoff matches the user's timezone, not the server's
    const localDateParam = req.query.localDate;
    const todayStr       = localDateParam || now.toISOString().split('T')[0];

    const today = new Date(todayStr + 'T00:00:00');

    // Include today + next 60 days (i=0 is today)
    for (let i = 0; i <= 60; i++) {
      const d = new Date(today);
      d.setDate(today.getDate() + i);
      const dateStr  = d.toISOString().split('T')[0];

      // Never show past dates — belt-and-suspenders guard
      if (dateStr < todayStr) continue;

      const override = overrideMap[dateStr];
      const isToday  = dateStr === todayStr;

      if (override && override.blocked) continue;

      // Day boundaries — use override if set
      let dayStart = DAY_START_MINS;
      let dayEnd   = DAY_END_MINS;
      if (override && override.slots && override.slots.length) {
        dayStart = timeStrToMins(override.slots[0]);
        dayEnd   = timeStrToMins(override.slots[override.slots.length - 1]) + 60;
      }

      // For today: effective start is the later of dayStart and current time
      // Add a 30-min buffer so nobody books a slot that's already starting
      // Then round UP to the nearest 10 minutes (e.g. 9:07 → 9:10)
      function roundUpTo10(mins) {
        return Math.ceil(mins / 10) * 10;
      }

      let rawEffectiveStart = isToday ? Math.max(dayStart, nowMinsToday + 30) : dayStart;
      const effectiveDayStart = isToday ? roundUpTo10(rawEffectiveStart) : dayStart;

      // Skip today entirely if nothing fits before close
      if (effectiveDayStart >= dayEnd) continue;

      const busyRanges = busyMap[dateStr] || [];
      const intervalSlots = {};
      let hasAny = false;

      Object.entries(SERVICE_DURATIONS).forEach(([serviceName, durMins]) => {
        const available = [];

        // Build full set of candidate start points:
        // 1. Step through the whole day in durMins chunks from effectiveDayStart
        // 2. Also add every confirmed booking's end time (so slots open right after a booking ends)
        const candidateStarts = new Set();

        // Fill day with regular intervals
        for (let t = effectiveDayStart; t + durMins <= dayEnd; t += durMins) {
          candidateStarts.add(t);
        }

        // Also add booking end times as candidate starts (rounded to nearest 10)
        busyRanges.forEach(r => {
          const roundedEnd = roundUpTo10(r.end);
          if (roundedEnd >= effectiveDayStart && roundedEnd + durMins <= dayEnd) {
            candidateStarts.add(roundedEnd);
            // Continue stepping forward from this end time to fill remaining day
            for (let t = roundedEnd + durMins; t + durMins <= dayEnd; t += durMins) {
              candidateStarts.add(t);
            }
          }
        });

        // Test each candidate — only include if the full range is free and not in the past
        Array.from(candidateStarts).sort((a, b) => a - b).forEach(start => {
          if (start + durMins > dayEnd) return;
          if (isToday && start < effectiveDayStart) return;
          if (!isRangeFree(busyRanges, start, durMins)) return;
          available.push({
            start: minsToTimeStr(start),
            end:   minsToTimeStr(start + durMins)
          });
        });

        if (available.length) {
          intervalSlots[serviceName] = available;
          hasAny = true;
        }
      });

      if (hasAny) result.push({ date: dateStr, intervalSlots });
    }

    res.json({ success: true, dates: result });
  } catch (err) {
    console.error('Available dates error:', err);
    res.status(500).json({ success: false });
  }
});

// Compute all slot strings covered by a booking given start time + duration mins
function getSlotsForBooking(startTime, durationMins, allSlots) {
  function timeToMins(t) {
    const [time, period] = t.split(' ');
    let [h, m] = time.split(':').map(Number);
    if (period === 'PM' && h !== 12) h += 12;
    if (period === 'AM' && h === 12) h = 0;
    return h * 60 + m;
  }
  const start = timeToMins(startTime);
  const end   = start + durationMins;
  return allSlots.filter(s => {
    const sm = timeToMins(s);
    return sm >= start && sm < end;
  });
}

// Create booking — pay now = auto-confirmed, pay after = pending (needs your call)
app.post('/booking/create', async (req, res) => {
  const { reference, bookingDetails, paymentMethod } = req.body;
  const isPayNow = paymentMethod === 'now';
  try {
    // Verify Paystack payment only for pay-now
    if (isPayNow) {
      const paystackRes  = await fetch(`https://api.paystack.co/transaction/verify/${reference}`, {
        headers: { Authorization: `Bearer ${PAYSTACK_SECRET}` }
      });
      const paystackData = await paystackRes.json();
      if (!paystackData.status || paystackData.data.status !== 'success') {
        return res.json({ success: false, message: 'Payment verification failed' });
      }
    }

    const status  = isPayNow ? 'confirmed' : 'pending';
    const booking = await Booking.create({ reference, ...bookingDetails, status });
    console.log(`✅ Booking saved (${status}):`, booking._id);

    const timeRange = booking.endTime ? `${booking.time} – ${booking.endTime}` : booking.time;

    if (isPayNow) {
      // Pay now — confirmed instantly
      await resend.emails.send({
        from:    FROM_EMAIL,
        to:      toEmail(booking.email),
        subject: `Booking Confirmed! 💜 — Ref: ${reference}`,
        html:    emailWrapper(`
          <h2 style="color:#0f0a14;font-size:22px;font-weight:400;margin:0 0 8px;">Booking Confirmed! 💜</h2>
          <p style="color:rgba(15,10,20,0.6);font-size:14px;line-height:1.75;margin:0 0 4px;">Hi <strong>${booking.name}</strong>, your appointment is confirmed!</p>
          <p style="color:rgba(15,10,20,0.6);font-size:14px;line-height:1.75;margin:0 0 16px;">Payment received. Your slot is locked in.</p>
          ${bookingSummaryBlock(booking)}
          <div style="background:#f0ebf7;border-radius:12px;padding:16px 20px;margin-bottom:16px;text-align:center;">
            <p style="font-size:11px;letter-spacing:0.15em;text-transform:uppercase;color:#6b3fa0;margin:0 0 4px;">Your Appointment Time</p>
            <p style="font-size:18px;color:#3d1a5e;font-weight:600;margin:0;">${timeRange}</p>
          </div>
          <div style="background:#f0ebf7;border-radius:12px;padding:16px 20px;">
            <p style="font-size:11px;letter-spacing:0.15em;text-transform:uppercase;color:#6b3fa0;margin:0 0 6px;">Booking Reference</p>
            <p style="font-size:15px;color:#0f0a14;margin:0;font-weight:500;">${reference}</p>
          </div>`)
      });
      await resend.emails.send({
        from:    FROM_EMAIL,
        to:      OWNER_EMAIL,
        subject: `💳 New Booking (Paid) — ${booking.service} · ${booking.date}`,
        html: emailWrapper(`
          <h2 style="color:#0f0a14;margin:0 0 8px;">New Confirmed Booking!</h2>
          <div style="background:#f0fdf4;border-radius:12px;padding:14px 16px;margin-bottom:16px;border-left:4px solid #22c55e;">
            <p style="font-size:13px;color:#0f0a14;margin:0;">💳 Payment confirmed. Slot is locked in automatically.</p>
          </div>
          <table style="width:100%;font-size:14px;border-collapse:collapse;">
            <tr><td style="padding:6px 0;color:rgba(15,10,20,0.55);">Customer</td><td style="text-align:right;font-weight:500;">${booking.name}</td></tr>
            <tr><td style="padding:6px 0;color:rgba(15,10,20,0.55);">Phone</td><td style="text-align:right;">${booking.phone}</td></tr>
            <tr><td style="padding:6px 0;color:rgba(15,10,20,0.55);">Service</td><td style="text-align:right;">${booking.service} (${booking.duration})</td></tr>
            <tr><td style="padding:6px 0;color:rgba(15,10,20,0.55);">Date</td><td style="text-align:right;">${booking.date}</td></tr>
            <tr><td style="padding:6px 0;color:rgba(15,10,20,0.55);">Time</td><td style="text-align:right;">${timeRange}</td></tr>
            <tr><td style="padding:6px 0;color:rgba(15,10,20,0.55);">Address</td><td style="text-align:right;">${booking.address}</td></tr>
            <tr style="border-top:1px solid rgba(107,63,160,0.15);">
              <td style="padding:10px 0 0;font-weight:500;">Total Paid</td>
              <td style="padding:10px 0 0;text-align:right;color:#3d1a5e;font-size:18px;font-weight:600;">&#x20A6;${booking.total.toLocaleString()}</td>
            </tr>
          </table>`)
      });
    } else {
      // Pay after — pending, needs your call
      await resend.emails.send({
        from:    FROM_EMAIL,
        to:      toEmail(booking.email),
        subject: `Booking Request Received! 📅 — Ref: ${reference}`,
        html:    emailWrapper(`
          <h2 style="color:#0f0a14;font-size:22px;font-weight:400;margin:0 0 8px;">Booking Request Received! 📅</h2>
          <p style="color:rgba(15,10,20,0.6);font-size:14px;line-height:1.75;margin:0 0 4px;">Hi <strong>${booking.name}</strong>, we've received your appointment request!</p>
          <p style="color:rgba(15,10,20,0.6);font-size:14px;line-height:1.75;margin:0 0 16px;">
            We will <strong>call you shortly</strong> to confirm. Payment will be collected after your service.
          </p>
          ${bookingSummaryBlock(booking)}
          <div style="background:#fff4e5;border-radius:12px;padding:16px 20px;margin-bottom:20px;border-left:4px solid #d4a96a;">
            <p style="font-size:13px;color:#0f0a14;margin:0;">⏳ <strong>Not yet confirmed</strong> — we'll call you to lock in this slot. You'll receive a confirmation email once confirmed.</p>
          </div>
          <div style="background:#f0ebf7;border-radius:12px;padding:16px 20px;">
            <p style="font-size:11px;letter-spacing:0.15em;text-transform:uppercase;color:#6b3fa0;margin:0 0 6px;">Booking Reference</p>
            <p style="font-size:15px;color:#0f0a14;margin:0;font-weight:500;">${reference}</p>
          </div>`)
      });
      await resend.emails.send({
        from:    FROM_EMAIL,
        to:      OWNER_EMAIL,
        subject: `📞 Call to Confirm Booking — ${booking.name} · ${booking.date}`,
        html: emailWrapper(`
          <h2 style="color:#0f0a14;margin:0 0 8px;">New Pay-After Booking!</h2>
          <div style="background:#fff4e5;border-radius:12px;padding:14px 16px;margin-bottom:16px;border-left:4px solid #d4a96a;">
            <p style="font-size:13px;color:#0f0a14;margin:0;">📞 Call <strong>${booking.phone}</strong> to confirm, then mark as Confirmed in admin. Slot is NOT blocked until you confirm.</p>
          </div>
          <table style="width:100%;font-size:14px;border-collapse:collapse;">
            <tr><td style="padding:6px 0;color:rgba(15,10,20,0.55);">Customer</td><td style="text-align:right;font-weight:500;">${booking.name}</td></tr>
            <tr><td style="padding:6px 0;color:rgba(15,10,20,0.55);">Phone</td><td style="text-align:right;">${booking.phone}</td></tr>
            <tr><td style="padding:6px 0;color:rgba(15,10,20,0.55);">Email</td><td style="text-align:right;">${booking.email}</td></tr>
            <tr><td style="padding:6px 0;color:rgba(15,10,20,0.55);">Service</td><td style="text-align:right;">${booking.service} (${booking.duration})</td></tr>
            <tr><td style="padding:6px 0;color:rgba(15,10,20,0.55);">Date</td><td style="text-align:right;">${booking.date}</td></tr>
            <tr><td style="padding:6px 0;color:rgba(15,10,20,0.55);">Time</td><td style="text-align:right;">${timeRange}</td></tr>
            <tr><td style="padding:6px 0;color:rgba(15,10,20,0.55);">Address</td><td style="text-align:right;">${booking.address}</td></tr>
            <tr><td style="padding:6px 0;color:rgba(15,10,20,0.55);">Payment</td><td style="text-align:right;color:#b8860b;font-weight:500;">Pay After Service</td></tr>
          </table>`)
      });
    }

    res.json({ success: true, booking });
  } catch (err) {
    console.error('❌ Booking error:', err);
    res.status(500).json({ success: false, message: err.message });
  }
});

/* ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
   ADMIN MIDDLEWARE
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ */
function adminAuth(req, res, next) {
  if (req.headers['x-admin-password'] !== ADMIN_PASSWORD) {
    return res.status(401).json({ success: false, message: 'Unauthorized' });
  }
  next();
}

/* ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
   ADMIN — Orders
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ */
app.get('/admin/orders', adminAuth, async (req, res) => {
  try {
    const orders = await Order.find().sort({ createdAt: -1 });
    res.json({ success: true, orders });
  } catch (err) {
    console.error('❌ Get orders error:', err);
    res.status(500).json({ success: false });
  }
});

app.post('/admin/update-order', adminAuth, async (req, res) => {
  const { reference, status, estimatedDelivery, delayReason } = req.body;
  try {
    const order = await Order.findOneAndUpdate(
      { reference },
      { status, estimatedDelivery: estimatedDelivery || '', delayReason: delayReason || '' },
      { new: true }
    );
    if (!order) return res.json({ success: false, message: 'Order not found' });
    const template = getOrderEmailTemplate(order, status, delayReason);
    if (template) {
      await resend.emails.send({ from: FROM_EMAIL, to: toEmail(order.email), subject: template.subject, html: emailWrapper(template.body) });
    }
    res.json({ success: true, order });
  } catch (err) {
    console.error('❌ Update error:', err);
    res.status(500).json({ success: false, message: err.message });
  }
});

/* ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
   ADMIN — Bookings
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ */
app.get('/admin/bookings', adminAuth, async (req, res) => {
  try {
    const bookings = await Booking.find().sort({ createdAt: -1 });
    res.json({ success: true, bookings });
  } catch (err) {
    res.status(500).json({ success: false });
  }
});

// Confirm booking → sends confirmation email, slot becomes unavailable to others
// Cancel booking → slot opens back up
app.post('/admin/update-booking', adminAuth, async (req, res) => {
  const { reference, status } = req.body;
  try {
    const booking = await Booking.findOneAndUpdate({ reference }, { status }, { new: true });
    if (!booking) return res.json({ success: false, message: 'Booking not found' });

    // Send email based on new status
    if (status === 'confirmed') {
      await resend.emails.send({
        from:    FROM_EMAIL,
        to:      toEmail(booking.email),
        subject: `Appointment Confirmed! 💜 — Ref: ${reference}`,
        html:    emailWrapper(`
          <h2 style="color:#0f0a14;font-size:22px;font-weight:400;margin:0 0 8px;">Appointment Confirmed! 💜</h2>
          <p style="color:rgba(15,10,20,0.6);font-size:14px;line-height:1.75;margin:0 0 4px;">Great news, <strong>${booking.name}</strong>!</p>
          <p style="color:rgba(15,10,20,0.6);font-size:14px;line-height:1.75;margin:0 0 16px;">Your appointment has been confirmed. We look forward to seeing you!</p>
          ${bookingSummaryBlock(booking)}
          <p style="color:rgba(15,10,20,0.6);font-size:13px;line-height:1.7;margin:0;">Please be at your address at the scheduled time. Our stylist will arrive within the slot. 💜</p>`)
      });
    }

    if (status === 'cancelled') {
      await resend.emails.send({
        from:    FROM_EMAIL,
        to:      toEmail(booking.email),
        subject: `Booking Cancelled — Ref: ${reference}`,
        html:    emailWrapper(`
          <h2 style="color:#0f0a14;font-size:22px;font-weight:400;margin:0 0 8px;">Booking Cancelled</h2>
          <p style="color:rgba(15,10,20,0.6);font-size:14px;line-height:1.75;margin:0 0 16px;">
            Hi <strong>${booking.name}</strong>, your booking for <strong>${booking.service}</strong> on ${booking.date} at ${booking.time} has been cancelled.
          </p>
          <p style="color:rgba(15,10,20,0.6);font-size:13px;line-height:1.7;margin:0;">
            If you have questions about your refund or wish to rebook, please call us or reply to this email. 💜
          </p>`)
      });
    }

    if (status === 'completed') {
      await resend.emails.send({
        from:    FROM_EMAIL,
        to:      toEmail(booking.email),
        subject: `Thank you for visiting Pharahs! 💜`,
        html:    emailWrapper(`
          <h2 style="color:#0f0a14;font-size:22px;font-weight:400;margin:0 0 8px;">Thank you! 💜</h2>
          <p style="color:rgba(15,10,20,0.6);font-size:14px;line-height:1.75;margin:0 0 16px;">
            Hi <strong>${booking.name}</strong>, thank you for your <strong>${booking.service}</strong> appointment today. We hope you loved it!
          </p>
          <p style="color:rgba(15,10,20,0.6);font-size:13px;line-height:1.7;margin:0;">We'd love to see you again — book your next session anytime. 💜</p>`)
      });
    }

    res.json({ success: true, booking });
  } catch (err) {
    console.error('❌ Update booking error:', err);
    res.status(500).json({ success: false });
  }
});

/* ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
   ADMIN — Availability (Day Overrides)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ */

// Get all overrides (blocked days + custom slot days)
app.get('/admin/overrides', adminAuth, async (req, res) => {
  try {
    const overrides = await DayOverride.find().sort({ date: 1 });
    res.json({ success: true, overrides, defaultSlots: DEFAULT_SLOTS });
  } catch (err) {
    res.status(500).json({ success: false });
  }
});

// Block an entire day
app.post('/admin/block-day', adminAuth, async (req, res) => {
  const { date } = req.body;
  try {
    const override = await DayOverride.findOneAndUpdate(
      { date },
      { blocked: true, slots: null },
      { upsert: true, new: true }
    );
    res.json({ success: true, override });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// Unblock a day
app.post('/admin/unblock-day', adminAuth, async (req, res) => {
  const { date } = req.body;
  try {
    await DayOverride.deleteOne({ date });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false });
  }
});

// Set custom slots for a specific day (overrides defaults)
app.post('/admin/set-slots', adminAuth, async (req, res) => {
  const { date, slots } = req.body;
  try {
    const override = await DayOverride.findOneAndUpdate(
      { date },
      { blocked: false, slots },
      { upsert: true, new: true }
    );
    res.json({ success: true, override });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// Reset a day back to default slots
app.post('/admin/reset-day', adminAuth, async (req, res) => {
  const { date } = req.body;
  try {
    await DayOverride.deleteOne({ date });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false });
  }
});

// Update default slots (applies to all days with no override)
app.post('/admin/set-default-slots', adminAuth, async (req, res) => {
  const { slots } = req.body;
  try {
    DEFAULT_SLOTS.length = 0;
    slots.forEach(s => DEFAULT_SLOTS.push(s));
    res.json({ success: true, defaultSlots: DEFAULT_SLOTS });
  } catch (err) {
    res.status(500).json({ success: false });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`✅ Pharahs backend running on port ${PORT}`));