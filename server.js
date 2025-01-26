const express = require('express');
const path = require('path');
const Razorpay = require('razorpay');
const crypto = require('crypto');
const nodemailer = require('nodemailer');
const axios = require('axios');
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
  paymentStatus: 'ready', // Default to 'ready' when the server starts
  dispensing: false,      // Ensure dispensing is false when the server starts
  rotations: 0,           // Reset rotation count to 0
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

// Display Endpoint (ESP32)
app.get('/display', (req, res) => {
  const authCode = req.query.authCode;

  if (authCode !== process.env.AUTH_CODE) {
    return res.status(401).json({ status: 'unauthorized' });
  }

  res.json({
    padCount: systemState.padCount,
    paymentStatus: systemState.paymentStatus,
    systemStatus: systemState.padCount > 0 ? 'active' : 'inactive',
    dispensing: systemState.dispensing,
    messages: {
      wifi: "Connecting to WiFi...",
      server: "Connecting to server...",
      payment: "Payment successful.",
      transaction: "DB transaction written.",
      attempt: "Attempt 1/2/3",
      complete: "Dispense complete. Thank you!",
    },
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


// Verify Payment (No Pad Reduction)
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

    motorActivationRequested = true; // Set flag to indicate motor activation
    res.json({ status: 'success' });  // No pad count reduction here
  } else {
    res.status(400).json({ status: 'failed' });
  }
});

app.get('/check-motor', (req, res) => {
  const { authCode } = req.query;

  // Validate authCode to ensure the request is authorized
  if (authCode !== process.env.AUTH_CODE) {
    return res.status(401).json({ status: 'unauthorized' });
  }

  // Logic to determine if the motor should start
  // You can customize this to fit your requirements (e.g., check if payment was successful or if dispensing is ready)
  if (systemState.paymentStatus === 'success' && !systemState.dispensing) {
    res.json({ motor: 'start' }); // Motor can be activated
  } else {
    res.json({ motor: 'stop' });  // Motor should not be activated
  }
});

// Endpoint to handle IR sensor interrupt (update pad count)
app.post('/sensor-interrupt', (req, res) => {
  const { sensorTriggered } = req.body;

  if (sensorTriggered && systemState.padCount > 0) {
    // Reduce the pad count only when the sensor is triggered
    systemState.padCount = Math.max(0, systemState.padCount - 1);

    // Send email notification for pad dispensing
    // const mailOptions = {
    //   from: process.env.EMAIL_USER,
    //   to: process.env.NOTIFICATION_EMAIL,
    //   subject: 'Pad Dispensed',
    //   text: `Pad dispensed successfully. Remaining pads: ${systemState.padCount}`,
    // };

    // transporter.sendMail(mailOptions, (err, info) => {
    //   if (err) console.error('Error sending email:', err);
    //   else console.log('Email sent:', info.response);
    // });

    res.json({ success: true, padCount: systemState.padCount });
  } else {
    res.status(400).json({ error: 'Invalid sensor data or no pads left' });
  }
});



// Refund System
app.post('/refund', (req, res) => {
  const { paymentId, reason } = req.body;

  // Check if paymentId is provided
  if (paymentId) {
    // Check if the payment has already been refunded
    if (systemState.paymentStatus === 'refunded' && systemState.currentPaymentId === paymentId) {
      // If payment status is 'refunded' and paymentId matches, reject multiple refunds
      return res.status(400).json({ error: 'Refund has already been processed for this payment.' });
    }

    // If payment is not refunded yet, set payment status to 'refunded'
    systemState.paymentStatus = 'refunded';
    systemState.currentPaymentId = paymentId; // Store the paymentId of the refunded payment

    // Handle refund logic here (e.g., Razorpay refund)
    // Example: razorpay.payments.refund(paymentId);

    // Send the refund email notification
    const mailOptions = {
      from: process.env.EMAIL_USER,
      to: process.env.NOTIFICATION_EMAIL,
      subject: 'Refund Issued',
      text: `Refund issued for Payment ID: ${paymentId}. Reason: ${reason}`,
    };

    transporter.sendMail(mailOptions, (err, info) => {
      if (err) {
        console.error('Error sending refund email:', err);
      } else {
        console.log('Refund email sent:', info.response);
      }
    });

    // Respond with success
    res.json({ success: true, message: 'Refund issued successfully' });
  } else {
    res.status(400).json({ error: 'Invalid Payment ID' });
  }
});


// System Status Check
app.get('/check', (req, res) => {
  const authCode = req.query.authCode;

  if (authCode !== process.env.AUTH_CODE) {
    return res.status(401).json({ status: 'unauthorized' });
  }

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

// Endpoint to handle system error (e.g., IR interrupt not happening)
app.post('/system-error', async (req, res) => {
  const { paymentId, reason } = req.body;

  // Logic to handle system error and initiate refund process
  if (paymentId && reason === 'IR interrupt not detected') {
    systemState.paymentStatus = 'refunded';
    systemState.systemStatus = 'inactive';  // Set system status to inactive

    // Logic to initiate the refund with Razorpay (example below, modify as needed)
    try {
      const refund = await razorpay.payments.refund(paymentId);
      const mailOptions = {
        from: process.env.EMAIL_USER,
        to: process.env.NOTIFICATION_EMAIL,
        subject: 'Refund Issued for System Error',
        text: `Refund issued for Payment ID: ${paymentId}. Reason: IR interrupt not detected. Refund Details: ${refund}`,
      };

      transporter.sendMail(mailOptions, (err, info) => {
        if (err) {
          console.error('Error sending refund email:', err);
        } else {
          console.log('Refund email sent:', info.response);
        }
      });

      res.json({ success: true, message: 'Refund issued due to system error' });
    } catch (error) {
      console.error('Error processing refund:', error);
      res.status(500).json({ error: 'Error processing refund' });
    }
  } else {
    res.status(400).json({ error: 'Invalid payment ID or reason' });
  }
});


// Handle Dispensing with Hall Sensor
app.post('/dispense', (req, res) => {
  const { rotation } = req.body;
  systemState.rotations += rotation;

  if (systemState.rotations > 3) {
    systemState.paymentStatus = 'error';
    systemState.rotations = 0; // Reset rotation count

    const mailOptions = {
      from: process.env.EMAIL_USER,
      to: process.env.NOTIFICATION_EMAIL,
      subject: 'System Error',
      text: `Motor rotation exceeded limit. Check the system.`,
    };

    transporter.sendMail(mailOptions, (err, info) => {
      if (err) console.error('Error sending email:', err);
      else console.log('Error email sent:', info.response);
    });

    res.status(400).json({ error: 'Rotation limit exceeded', padCount: systemState.padCount });
  } else {
    res.json({ success: true, padCount: systemState.padCount });
  }
});

// Server Start
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
