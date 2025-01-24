const express = require('express');
const path = require('path');
const Razorpay = require('razorpay');
const session = require('express-session');
const crypto = require('crypto');
const nodemailer = require('nodemailer'); // Added for email alerts
require('dotenv').config();

const app = express();

// Middleware setup (same as before)
app.use(
  session({
    secret: process.env.SESSION_SECRET || 'your_secret_key',
    resave: false,
    saveUninitialized: true,
    cookie: {
      secure: process.env.NODE_ENV === 'production',
      maxAge: 24 * 60 * 60 * 1000,
    },
  })
);

app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.use(express.static(path.join(__dirname, 'public')));

// Razorpay setup
const api = new Razorpay({
  key_id: process.env.RAZORPAY_KEY_ID,
  key_secret: process.env.RAZORPAY_KEY_SECRET,
});

// Email configuration for alerts
const transporter = nodemailer.createTransport({
  service: 'gmail',
  auth: {
    user: process.env.EMAIL_USER,
    pass: process.env.EMAIL_PASS
  }
});

// Enhanced system state variables
let systemState = {
  padCount: 10,
  paymentStatus: 'ready',
  systemStatus: 'online',
  lastUpdated: new Date().toISOString(),
  alerts: []
};

// Maximum pad threshold for alerts
const MAX_PAD_COUNT = 20;
const MIN_PAD_COUNT = 2;

// Send email alert
async function sendAlert(message) {
  try {
    await transporter.sendMail({
      from: process.env.EMAIL_USER,
      to: process.env.ALERT_RECIPIENT,
      subject: 'System Alert',
      text: message
    });
    systemState.alerts.push({
      message,
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    console.error('Failed to send alert:', error);
  }
}

// System status endpoint with enhanced error handling
app.get('/system-status', async (req, res) => {
  try {
    // Check Razorpay connection
    await api.orders.all();
    
    // Update system status
    systemState.systemStatus = 'online';
    systemState.lastUpdated = new Date().toISOString();

    // Check pad count for alerts
    if (systemState.padCount <= MIN_PAD_COUNT) {
      await sendAlert(`Low pad count: ${systemState.padCount} pads remaining`);
    }

    res.json(systemState);
  } catch (error) {
    systemState.systemStatus = 'payment_system_error';
    systemState.alerts.push({
      message: 'Payment system error',
      timestamp: new Date().toISOString()
    });
    
    res.status(500).json({
      ...systemState,
      error: error.message
    });
  }
});

// Update pad count with validation and alerts
app.post('/update-pad-count', async (req, res) => {
  const { count } = req.body;

  if (typeof count === 'number' && count >= 0) {
    systemState.padCount = count;
    
    // Send alerts for threshold conditions
    if (count > MAX_PAD_COUNT) {
      await sendAlert(`Pad count exceeded maximum: ${count} pads`);
    }
    if (count <= MIN_PAD_COUNT) {
      await sendAlert(`Low pad count: ${count} pads remaining`);
    }

    res.json({
      success: true,
      newPadCount: systemState.padCount,
      alerts: systemState.alerts
    });
  } else {
    res.status(400).json({
      success: false,
      message: 'Invalid pad count'
    });
  }
});

// Existing payment and order endpoints remain the same...

const port = process.env.PORT || 3000;
app.listen(port, () => {
  console.log(`Server running on port ${port}`);
});