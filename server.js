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

let systemState = {
  padCount: 20, // Initial pad count stored in memory
  currentOrderId: null,
  currentPaymentId: null,
  paymentStatus: 'ready',
  dispensing: false,
  rotations: 0,
};

// Middleware for Authentication (ESP32)
function authMiddleware(req, res, next) {
  const token = req.headers.authorization;
  if (token === process.env.ESP_AUTH_TOKEN) {
    next();
  } else {
    res.status(401).json({ error: 'Unauthorized' });
  }
}

// Home Route
app.get('/', (req, res) => res.redirect('/payment'));
app.get('/reset', (req, res) => res.redirect('/admin'));
// Admin Dashboard
app.get('/admin', async (req, res) => {
  try {
    const transactions = [
      { order_id: '1', payment_id: '1001', amount: 600, status: 'success', pad_count: systemState.padCount, created_at: '2025-01-01' },
    ];
    res.render('admin_dashboard', { systemState, transactions });
  } catch (error) {
    console.error('Error:', error);
    res.status(500).send('Error loading admin dashboard');
  }
});

// Update Payment Status
app.post('/update-payment-status', (req, res) => {
  const { paymentStatus, authCode } = req.body;

  // Verify the authCode (replace with your own logic)
  if (authCode !== process.env.AUTH_CODE) {
    return res.status(401).json({ message: 'Unauthorized' });
  }

  // Update the payment status (Replace with actual DB logic)
  systemState.paymentStatus = paymentStatus;

  // Respond with the updated status
  res.status(200).json({ message: 'Payment status updated', paymentStatus });
});

// Display Endpoint (ESP32)
app.get('/display', (req, res) => {
  const authCode = req.query.authCode;

  if (authCode !== process.env.AUTH_CODE) {
    return res.status(401).json({ status: 'unauthorized' });
  }

  res.setHeader('Content-Type', 'application/json');
  res.json({
    padCount: systemState.padCount,
    paymentStatus: systemState.paymentStatus,
    systemStatus: systemState.padCount > 0 ? 'active' : 'inactive',
    dispensing: systemState.dispensing,
    // messages: {
    //   wifi: "Connecting to WiFi...",
    //   server: "Connecting to server...",
    //   payment: "Payment successful.",
    //   transaction: "DB transaction written.",
    //   attempt: "Attempt 1/2/3",
    //   complete: "Dispense complete. Thank you!",
    // },
  });
});

// Payment Page
app.get('/payment', (req, res) => {
  res.render('payment', {
    padCount: systemState.padCount,
    key_id: process.env.RAZORPAY_KEY_ID,
  });
});

// Create Razorpay Order
app.post('/create-order', async (req, res) => {
  try {
    const options = { amount: 600, currency: 'INR', receipt: `order_${Date.now()}` };
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
    systemState.currentPaymentId = razorpay_payment_id;
    systemState.dispensing = true;

    res.json({ status: 'success' });
  } else {
    res.status(400).json({ status: 'failed' });
  }
});

// Check Motor Status
app.get('/check-motor', (req, res) => {
  const { authCode } = req.query;

  if (authCode !== process.env.AUTH_CODE) {
    return res.status(401).json({ status: 'unauthorized' });
  }

  if (systemState.paymentStatus === 'success' && !systemState.dispensing) {
    res.json({ motor: 'start' });
  } else {
    res.json({ motor: 'stop' });
  }
});

// IR Sensor Interrupt
app.post('/sensor-interrupt', (req, res) => {
  const { sensorTriggered } = req.body;

  if (sensorTriggered && systemState.padCount > 0) {
    systemState.padCount = Math.max(0, systemState.padCount - 1);
    res.json({ success: true, padCount: systemState.padCount });
  } else {
    res.status(400).json({ error: 'Invalid sensor data or no pads left' });
  }
});

// Refund System// Refund System
app.post('/refund', async (req, res) => {
  const { paymentId, reason } = req.body;

  if (paymentId) {
    // Check if payment has already been refunded
    if (systemState.paymentStatus === 'refunded' && systemState.currentPaymentId === paymentId) {
      return res.status(400).json({ error: 'Refund has already been processed for this payment.' });
    }

    try {
      // If payment is not refunded yet, set payment status to 'refunded'
      systemState.paymentStatus = 'refunded';
      systemState.currentPaymentId = paymentId; // Store the paymentId of the refunded payment

      // Handle the Razorpay refund
      const refund = await razorpay.payments.refund(paymentId);
      console.log('Refund successful:', refund);

      // Send the refund email notification
      const mailOptions = {
        from: process.env.EMAIL_USER,
        to: process.env.NOTIFICATION_EMAIL,
        subject: 'Refund Issued',
        text: `Refund issued for Payment ID: ${paymentId}. Reason: ${reason}. Refund Details: ${JSON.stringify(refund)}`,
      };

      transporter.sendMail(mailOptions, (err, info) => {
        if (err) {
          console.error('Error sending refund email:', err);
        } else {
          console.log('Refund email sent:', info.response);
        }
      });

      // Respond with success
      res.json({ success: true, message: 'Refund issued successfully', refund });
    } catch (error) {
      console.error('Error processing refund:', error);
      res.status(500).json({ error: 'Refund processing failed', details: error.message });
    }
  } else {
    res.status(400).json({ error: 'Invalid Payment ID' });
  }
});


// Check System Status
app.get('/check', (req, res) => {
  const authCode = req.query.authCode;

  if (authCode !== process.env.AUTH_CODE) {
    return res.status(401).json({ status: 'unauthorized' });
  }
res.setHeader('Content-Type', 'application/json');
  res.json({
    padCount: systemState.padCount,
    paymentStatus: systemState.paymentStatus,
    systemStatus: systemState.padCount > 0 ? 'active' : 'inactive',
    dispensing: systemState.dispensing,
  });
});

// Update Pad Count
app.post('/update-pad-count', (req, res) => {
  const { count } = req.body;
  if (typeof count === 'number' && count >= 0) {
    systemState.padCount = count;
    res.json({ success: true, padCount: systemState.padCount });
  } else {
    res.status(400).json({ error: 'Invalid pad count value' });
  }
});
// System Error Notification
app.post('/system-error', async (req, res) => {
  const { paymentId, reason } = req.body;

  if (paymentId && reason === 'IR interrupt not detected') {
    systemState.paymentStatus = 'refunded';
    systemState.systemStatus = 'inactive';

    try {
      const refund = await razorpay.payments.refund(paymentId);
      const mailOptions = {
        from: process.env.EMAIL_USER,
        to: process.env.NOTIFICATION_EMAIL,
        subject: 'Refund Issued for System Error',
        text: `Refund issued for Payment ID: ${paymentId}. Reason: IR interrupt not detected. Refund Details: ${JSON.stringify(refund)}`,
      };

      transporter.sendMail(mailOptions, (err, info) => {
        if (err) console.error('Error sending refund email:', err);
        else console.log('Refund email sent:', info.response);
      });

      res.json({ success: true, message: 'Refund processed successfully' });
    } catch (error) {
      console.error('Error processing refund:', error);
      res.status(500).json({ error: 'Refund processing failed' });
    }
  } else {
    res.status(400).json({ error: 'Invalid error details' });
  }
});


// System Error Notification


// Start Server
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
