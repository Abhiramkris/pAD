const express = require('express');
const path = require('path');
const Razorpay = require('razorpay');
const session = require('express-session');
require('dotenv').config();

const app = express();

// Middleware
app.use(session({
  secret: process.env.SESSION_SECRET || 'your_secret_key',
  resave: false,
  saveUninitialized: true,
  cookie: { 
    secure: process.env.NODE_ENV === 'production',
    maxAge: 24 * 60 * 60 * 1000 
  }
}));

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

// System state management
let padCount = 10;
let paymentStatus = "ready";
let systemStatus = "online";

// System status endpoint for comprehensive tracking
app.get('/system-status', (req, res) => {
  try {
    api.orders.all().then(() => {
      systemStatus = "online";
      res.json({
        status: systemStatus,
        payment_system: "online",
        pad_count: padCount,
        payment_status: paymentStatus,
        last_updated: new Date().toISOString()
      });
    }).catch((error) => {
      systemStatus = "payment_system_error";
      res.json({
        status: "error",
        payment_system: "offline",
        error: error.message,
        pad_count: padCount,
        payment_status: paymentStatus
      });
    });
  } catch (error) {
    res.json({
      status: "error",
      error: error.message,
      pad_count: padCount,
      payment_status: paymentStatus
    });
  }
});

// Pad management endpoints
app.get('/pad-count', (req, res) => {
  res.json({
    padCount: padCount,
    status: paymentStatus,
    systemStatus: systemStatus
  });
});

app.post('/update-pad-count', (req, res) => {
  const { count } = req.body;
  if (typeof count === 'number' && count >= 0) {
    padCount = count;
    res.json({
      success: true,
      newPadCount: padCount
    });
  } else {
    res.status(400).json({
      success: false,
      message: 'Invalid pad count'
    });
  }
});

// Existing payment routes remain the same...

const port = process.env.PORT || 3000;
app.listen(port, () => {
  console.log(`Server running on port ${port}`);
});