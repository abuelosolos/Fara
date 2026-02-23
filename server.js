require('dotenv').config();

const express    = require('express');
const cors       = require('cors');
const fetch      = require('node-fetch');
const mongoose   = require('mongoose');
const { Resend } = require('resend');
const path       = require('path');

const app = express();

// ── CORS: allow requests from any frontend during testing
app.use(cors({ origin: '*' }));
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

/* ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
   CONFIG — all secrets loaded from .env file
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ */
const PAYSTACK_SECRET = process.env.PAYSTACK_SECRET;
const RESEND_API_KEY  = process.env.RESEND_API_KEY;
const FROM_EMAIL      = process.env.FROM_EMAIL;
const OWNER_EMAIL     = process.env.OWNER_EMAIL;
const MONGO_URI       = process.env.MONGO_URI;
const ADMIN_PASSWORD  = process.env.ADMIN_PASSWORD;

// ── TEST MODE: Resend free tier only delivers to your own email
// When you verify a domain on Resend, remove this and use order.email directly
const TEST_MODE       = true;
const TEST_EMAIL      = 'kbatomate@gmail.com'; // your Resend signup email

const resend = new Resend(RESEND_API_KEY);

/* ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
   DATABASE
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ */
mongoose.connect(MONGO_URI)
  .then(() => console.log('✅ MongoDB connected'))
  .catch(err => console.error('❌ MongoDB error:', err));

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

/* ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
   HELPERS
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ */

// In test mode all emails go to your own inbox regardless of customer email
function toEmail(customerEmail) {
  return TEST_MODE ? TEST_EMAIL : customerEmail;
}

function emailWrapper(content) {
  return `<!DOCTYPE html>
<html>
<body style="margin:0;padding:0;background:#faf9f7;font-family:Arial,sans-serif;">
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
</body>
</html>`;
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

function getEmailTemplate(order, status, delayReason = '') {
  const { name, product, estimatedDelivery } = order;

  const templates = {
    received: {
      subject: `Order Confirmed! 🎉 — Ref: ${order.reference}`,
      body: `
        <h2 style="color:#0f0a14;font-size:22px;font-weight:400;margin:0 0 8px;">Order Confirmed! 🎉</h2>
        <p style="color:rgba(15,10,20,0.6);font-size:14px;line-height:1.75;margin:0 0 4px;">Hi <strong>${name}</strong>, thank you for your order!</p>
        <p style="color:rgba(15,10,20,0.6);font-size:14px;line-height:1.75;margin:0 0 16px;">
          We've received your payment and are preparing your <strong>${product}</strong> for dispatch.
        </p>
        ${summaryBlock(order)}
        <p style="color:rgba(15,10,20,0.6);font-size:13px;line-height:1.7;margin:0;">
          📦 Estimated delivery: <strong>${estimatedDelivery || '2–5 business days'}</strong><br>
          We'll send you updates every step of the way. 💜
        </p>`
    },
    dispatched: {
      subject: `Your Pharahs order is on its way! 🚚 — Ref: ${order.reference}`,
      body: `
        <h2 style="color:#0f0a14;font-size:22px;font-weight:400;margin:0 0 8px;">It's on its way! 🚚</h2>
        <p style="color:rgba(15,10,20,0.6);font-size:14px;line-height:1.75;margin:0 0 4px;">Great news, <strong>${name}</strong>!</p>
        <p style="color:rgba(15,10,20,0.6);font-size:14px;line-height:1.75;margin:0 0 16px;">
          Your <strong>${product}</strong> has been dispatched and is heading your way.
        </p>
        <div style="background:#f0ebf7;border-radius:12px;padding:18px 20px;margin-bottom:20px;text-align:center;">
          <p style="font-size:11px;letter-spacing:0.15em;text-transform:uppercase;color:#6b3fa0;margin:0 0 6px;">Expected Delivery Date</p>
          <p style="font-size:24px;color:#3d1a5e;font-weight:600;margin:0;">${estimatedDelivery}</p>
        </div>
        ${summaryBlock(order)}
        <p style="color:rgba(15,10,20,0.6);font-size:13px;line-height:1.7;margin:0;">
          Please ensure someone is available to receive the package. 💜
        </p>`
    },
    delayed: {
      subject: `Update on your Pharahs order ⚠️ — Ref: ${order.reference}`,
      body: `
        <h2 style="color:#0f0a14;font-size:22px;font-weight:400;margin:0 0 8px;">Delivery Update ⚠️</h2>
        <p style="color:rgba(15,10,20,0.6);font-size:14px;line-height:1.75;margin:0 0 4px;">Hi <strong>${name}</strong>, we sincerely apologise for this update.</p>
        <p style="color:rgba(15,10,20,0.6);font-size:14px;line-height:1.75;margin:0 0 16px;">
          Your <strong>${product}</strong> has experienced a slight delay.
        </p>
        <div style="background:#fff4e5;border-radius:12px;padding:18px 20px;margin-bottom:16px;border-left:4px solid #d4a96a;">
          <p style="font-size:11px;letter-spacing:0.12em;text-transform:uppercase;color:#b8860b;margin:0 0 6px;">Reason for Delay</p>
          <p style="font-size:14px;color:#0f0a14;margin:0;">${delayReason || 'Unforeseen logistics circumstances'}</p>
        </div>
        <div style="background:#f0ebf7;border-radius:12px;padding:18px 20px;margin-bottom:20px;text-align:center;">
          <p style="font-size:11px;letter-spacing:0.15em;text-transform:uppercase;color:#6b3fa0;margin:0 0 6px;">New Expected Delivery</p>
          <p style="font-size:24px;color:#3d1a5e;font-weight:600;margin:0;">${estimatedDelivery}</p>
        </div>
        ${summaryBlock(order)}
        <p style="color:rgba(15,10,20,0.6);font-size:13px;line-height:1.7;margin:0;">
          We truly appreciate your patience. Reach out for a discount on your next order. 💜
        </p>`
    },
    delivered: {
      subject: `Your Pharahs order has been delivered! 🎉 — Ref: ${order.reference}`,
      body: `
        <h2 style="color:#0f0a14;font-size:22px;font-weight:400;margin:0 0 8px;">Delivered! 🎉</h2>
        <p style="color:rgba(15,10,20,0.6);font-size:14px;line-height:1.75;margin:0 0 4px;">Hi <strong>${name}</strong>, your order has arrived!</p>
        <p style="color:rgba(15,10,20,0.6);font-size:14px;line-height:1.75;margin:0 0 16px;">
          Your <strong>${product}</strong> has been successfully delivered to your address.
        </p>
        <div style="background:#f0ebf7;border-radius:12px;padding:24px 20px;margin-bottom:20px;text-align:center;">
          <p style="font-size:36px;margin:0;">💜</p>
          <p style="font-size:15px;color:#3d1a5e;font-weight:500;margin:10px 0 0;">Thank you for choosing Pharahs!</p>
        </div>
        ${summaryBlock(order)}
        <p style="color:rgba(15,10,20,0.6);font-size:13px;line-height:1.7;margin:0;">
          We hope you love it! Any issues? Reply to this email within 7 days. 💜
        </p>`
    }
  };

  return templates[status];
}

/* ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
   HEALTH CHECK — visit /ping to confirm server is up
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ */
app.get('/ping', (req, res) => res.json({ success: true, message: 'Pharahs backend is running ✅' }));

/* ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
   ROUTE: Verify Payment + Save Order + Email
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ */
app.post('/verify-payment', async (req, res) => {
  const { reference, orderDetails } = req.body;

  try {
    // 1. Verify with Paystack
    const paystackRes  = await fetch(`https://api.paystack.co/transaction/verify/${reference}`, {
      headers: { Authorization: `Bearer ${PAYSTACK_SECRET}` }
    });
    const paystackData = await paystackRes.json();

    if (!paystackData.status || paystackData.data.status !== 'success') {
      console.log('❌ Paystack verification failed:', paystackData);
      return res.json({ success: false, message: 'Payment verification failed' });
    }

    console.log('✅ Paystack verified:', reference);

    // 2. Save order to MongoDB
    const order = await Order.create({
      reference,
      ...orderDetails,
      status: 'received',
      estimatedDelivery: '2–5 business days'
    });

    console.log('✅ Order saved:', order._id);

    // 3. Email customer (goes to TEST_EMAIL in test mode)
    const template = getEmailTemplate(order, 'received');
    const customerEmailResult = await resend.emails.send({
      from:    FROM_EMAIL,
      to:      toEmail(order.email), // TEST MODE: always kbatomate@gmail.com
      subject: template.subject,
      html:    emailWrapper(template.body)
    });
    console.log('✅ Customer email sent:', customerEmailResult);

    // 4. Notify owner
    const ownerEmailResult = await resend.emails.send({
      from:    FROM_EMAIL,
      to:      OWNER_EMAIL,
      subject: `🛍️ New Order — ${order.product} (${reference})`,
      html: emailWrapper(`
        <h2 style="color:#0f0a14;margin:0 0 16px;">New Order!</h2>
        ${TEST_MODE ? '<p style="background:#fff4e5;padding:10px;border-radius:8px;font-size:12px;">⚠️ TEST MODE: Customer email was redirected to your inbox</p>' : ''}
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
    console.log('✅ Owner email sent:', ownerEmailResult);

    res.json({ success: true });

  } catch (err) {
    console.error('❌ Verify error:', err);
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

// Get all orders
app.get('/admin/orders', adminAuth, async (req, res) => {
  try {
    const orders = await Order.find().sort({ createdAt: -1 });
    res.json({ success: true, orders });
  } catch (err) {
    console.error('❌ Get orders error:', err);
    res.status(500).json({ success: false });
  }
});

// Update order status + trigger email
app.post('/admin/update-order', adminAuth, async (req, res) => {
  const { reference, status, estimatedDelivery, delayReason } = req.body;
  try {
    const order = await Order.findOneAndUpdate(
      { reference },
      { status, estimatedDelivery: estimatedDelivery || '', delayReason: delayReason || '' },
      { new: true }
    );
    if (!order) return res.json({ success: false, message: 'Order not found' });

    const template = getEmailTemplate(order, status, delayReason);
    if (template) {
      await resend.emails.send({
        from:    FROM_EMAIL,
        to:      toEmail(order.email), // TEST MODE: always kbatomate@gmail.com
        subject: template.subject,
        html:    emailWrapper(template.body)
      });
      console.log(`✅ Status email sent for ${reference}: ${status}`);
    }

    res.json({ success: true, order });
  } catch (err) {
    console.error('❌ Update error:', err);
    res.status(500).json({ success: false, message: err.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`✅ Pharahs backend running on port ${PORT}`));