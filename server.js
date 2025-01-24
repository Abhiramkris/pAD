const express = require('express');
const path = require('path');
const Razorpay = require('razorpay');
const crypto = require('crypto');
const mongoose = require('mongoose');
const nodemailer = require('nodemailer');
require('dotenv').config();

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.set('view engine', 'ejs');

// MongoDB Schema for Transactions
const TransactionSchema = new mongoose.Schema({
  order_id: String,
  payment_id: String,
  amount: Number,
  status: String,
  pad_count: Number,
  created_at: { type: Date, default: Date.now }
});
const Transaction = mongoose.model('Transaction', TransactionSchema);

// Email Transporter
const transporter = nodemailer.createTransport({
  service: 'gmail',
  auth: {
    user: process.env.EMAIL_USER,
    pass: process.env.EMAIL_PASS
  }
});

// Razorpay and Authentication Setup
const razorpay = new Razorpay({
  key_id: process.env.RAZORPAY_KEY_ID,
  key_secret: process.env.RAZORPAY_KEY_SECRET
});

// System State Management
let systemState = {
  padCount: 10,
  paymentStatus: 'ready',
  systemStatus: 'online',
  dispensing: false,
  currentOrderId: null,
  currentPaymentId: null,
  authToken: null
};

// Authentication Generator
function generateAuthToken(deviceId) {
  return crypto
    .createHmac('sha256', process.env.AUTH_SECRET)
    .update(deviceId)
    .digest('hex');
}

// Email Notification Function
async function sendEmail(subject, body) {
  try {
    await transporter.sendMail({
      from: process.env.EMAIL_USER,
      to: process.env.ALERT_RECIPIENT,
      subject,
      text: body
    });
  } catch (error) {
    console.error('Email sending failed:', error);
  }
}

// Routes
app.get('/', (req, res) => {
  res.render('payment', { 
    key_id: process.env.RAZORPAY_KEY_ID,
    amount: 100
  });
});

// Create Razorpay Order
app.post('/create-order', async (req, res) => {
  const options = {
    amount: 100,
    currency: 'INR',
    receipt: `order_${Date.now()}`
  };

  try {
    const order = await razorpay.orders.create(options);
    systemState.currentOrderId = order.id;
    res.json(order);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Payment Verification
app.post('/verify-payment', async (req, res) => {
  const { razorpay_payment_id, razorpay_order_id, razorpay_signature } = req.body;

  const generated_signature = crypto
    .createHmac('sha256', process.env.RAZORPAY_KEY_SECRET)
    .update(`${systemState.currentOrderId}|${razorpay_payment_id}`)
    .digest('hex');

  if (generated_signature === razorpay_signature) {
    const transaction = new Transaction({
      order_id: razorpay_order_id,
      payment_id: razorpay_payment_id,
      amount: 100,
      status: 'success',
      pad_count: systemState.padCount
    });
    await transaction.save();

    systemState.paymentStatus = 'dispensing';
    systemState.dispensing = true;
    systemState.currentPaymentId = razorpay_payment_id;

    res.json({ status: 'success' });
  } else {
    res.status(400).json({ status: 'failed' });
  }
});

// Motor Status and Refund Endpoint
app.post('/motor-status', async (req, res) => {
  const { deviceId, token, hallSensorTriggered } = req.body;

  if (token !== generateAuthToken(deviceId)) {
    return res.status(403).json({ error: 'Unauthorized' });
  }

  if (!hallSensorTriggered) {
    await sendEmail(
      'Motor Malfunction Alert', 
      'Hall effect sensor not triggered. Motor may be non-functional.'
    );

    try {
      await razorpay.payments.refund(systemState.currentPaymentId, {
        amount: 100,
        speed: 'normal'
      });

      systemState.paymentStatus = 'refunded';
      systemState.dispensing = false;

      res.json({ 
        status: 'refund_triggered', 
        reason: 'Motor malfunction' 
      });
    } catch (error) {
      res.status(500).json({ error: 'Refund failed' });
    }
  } else {
    res.json({ status: 'motor_functional' });
  }
});

// System Status Endpoint
app.get('/display', (req, res) => {
  const deviceId = process.env.ESP32_DEVICE_ID;
  systemState.authToken = generateAuthToken(deviceId);

  // Low pad count check
  if (systemState.padCount < 5) {
    sendEmail(
      'Low Pad Count Alert', 
      `Pad count is critically low: ${systemState.padCount} pads remaining.`
    );
  }

  res.json({
    ...systemState,
    authToken: systemState.authToken
  });
});

// Pad Count Update
app.post('/update-pad-count', (req, res) => {
  const { count, deviceId, token } = req.body;

  if (token !== generateAuthToken(deviceId)) {
    return res.status(403).json({ error: 'Unauthorized' });
  }

  systemState.padCount = count >= 0 ? count : systemState.padCount;
  
  res.json({ 
    success: true, 
    padCount: systemState.padCount 
  });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
