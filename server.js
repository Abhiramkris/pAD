const express = require('express');
const path = require('path');
const Razorpay = require('razorpay');
const crypto = require('crypto');
const nodemailer = require('nodemailer');
require('dotenv').config();

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

// Razorpay Setup
const razorpay = new Razorpay({
  key_id: process.env.RAZORPAY_KEY_ID,
  key_secret: process.env.RAZORPAY_KEY_SECRET,
});

// Email Transporter
const transporter = nodemailer.createTransport({
  service: 'gmail',
  auth: {
    user: process.env.EMAIL_USER,
    pass: process.env.EMAIL_PASS,
  },
});

// System State
let systemState = {
  padCount: 20, // Initial pad count stored in memory
  currentOrderId: null,
  currentPaymentId: null,
  paymentStatus: 'ready',
  dispensing: false,
};

// Home Route
app.get('/', (req, res) => {
  res.redirect('/payment');
});
app.get('/admin', (req, res) => {
  res.redirect('/admin-dashboard');
});

app.get('/reset', (req, res) => {
  res.redirect('/admin');
});

app.get('/display', (req, res) => {
  res.json({
    padCount: systemState.padCount,
    paymentStatus: systemState.paymentStatus,
    systemStatus: systemState.padCount > 0 ? 'active' : 'inactive',
    dispensing: systemState.dispensing,
  });
});

// Payment Page
app.get('/payment', (req, res) => {
  res.render('payment', { 
    padCount: systemState.padCount, 
    key_id: process.env.RAZORPAY_KEY_ID 
  });
});

// Create Razorpay Order
app.post('/create-order', async (req, res) => {
  const options = {
    amount: 600, // Amount in paisa (₹1.00)
    currency: 'INR',
    receipt: `order_${Date.now()}`,
  };

  try {
    const order = await razorpay.orders.create(options);
    systemState.currentOrderId = order.id;
    res.json(order);
  } catch (error) {
    console.error('Error creating order:', error);
    res.status(500).json({ error: error.message });
  }
});

// Verify Payment
app.post('/verify-payment', (req, res) => {
  const { razorpay_payment_id, razorpay_order_id, razorpay_signature } = req.body;

  const generated_signature = crypto
    .createHmac('sha256', process.env.RAZORPAY_KEY_SECRET)
    .update(`${systemState.currentOrderId}|${razorpay_payment_id}`)
    .digest('hex');

  if (generated_signature === razorpay_signature) {
    systemState.paymentStatus = 'success';
    systemState.padCount = Math.max(0, systemState.padCount - 1); // Deduct pad count
    systemState.currentPaymentId = razorpay_payment_id;
    systemState.dispensing = true;

    // Send Email Notification
    const mailOptions = {
      from: process.env.EMAIL_USER,
      to: process.env.NOTIFICATION_EMAIL,
      subject: 'Pad Dispensed',
      text: `A pad was dispensed successfully. Remaining pads: ${systemState.padCount}`,
    };

    transporter.sendMail(mailOptions, (err, info) => {
      if (err) console.error('Error sending email:', err);
      else console.log('Email sent:', info.response);
    });

    res.json({ status: 'success', padCount: systemState.padCount });
  } else {
    res.status(400).json({ status: 'failed' });
  }
});

// Refund System (if dispensing fails)
app.post('/refund', (req, res) => {
  const { paymentId, reason } = req.body;

  if (paymentId) {
    // Refund logic (mocked for simplicity)
    systemState.paymentStatus = 'refunded';
    console.log(`Refund processed for Payment ID: ${paymentId}, Reason: ${reason}`);

    // Email Notification for Refund
    const mailOptions = {
      from: process.env.EMAIL_USER,
      to: process.env.NOTIFICATION_EMAIL,
      subject: 'Refund Issued',
      text: `A refund was issued for Payment ID: ${paymentId}. Reason: ${reason}`,
    };

    transporter.sendMail(mailOptions, (err, info) => {
      if (err) console.error('Error sending refund email:', err);
      else console.log('Refund email sent:', info.response);
    });

    res.json({ success: true, message: 'Refund issued successfully' });
  } else {
    res.status(400).json({ error: 'Invalid Payment ID' });
  }
});

// Check System Status
app.get('/check', (req, res) => {
  res.json({
    padCount: systemState.padCount,
    paymentStatus: systemState.paymentStatus,
    dispensing: systemState.dispensing,
  });
});

// Update Pad Count (Admin)
app.post('/update-pad-count', (req, res) => {
  const { count } = req.body;
  if (typeof count === 'number' && count >= 0) {
    systemState.padCount = count;
    res.json({ success: true, padCount: systemState.padCount });
  } else {
    res.status(400).json({ error: 'Invalid pad count value' });
  }
});
// Reset Pad Count
app.post('/reset-pad-count', (req, res) => {
  systemState.padCount = 20; // Reset pad count to 20
  res.json({ success: true, padCount: systemState.padCount });
});

// Reset Payment Status
app.post('/reset-payment-status', (req, res) => {
  systemState.paymentStatus = 'ready'; // Reset payment status to 'ready'
  res.json({ success: true, paymentStatus: systemState.paymentStatus });
});

// Reset Dispensing Status
app.post('/reset-dispensing', (req, res) => {
  systemState.dispensing = false; // Reset dispensing status to false
  res.json({ success: true, dispensing: systemState.dispensing });
});


// Start Server
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
