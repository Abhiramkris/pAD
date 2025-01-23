const express = require('express');
const path = require('path');
const Razorpay = require('razorpay');
require('dotenv').config();

const app = express();

// Setup Razorpay API keys
const api = new Razorpay({
  key_id: process.env.RAZORPAY_KEY_ID,
  key_secret: process.env.RAZORPAY_KEY_SECRET,
});

// Middleware
app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.use(express.static(path.join(__dirname, 'public')));

// In-memory storage
let padCount = 1;
let paymentStatus = "ready";
let systemStatus = "online";

// Health check endpoint for ESP32
app.get('/system-status', (req, res) => {
  try {
    // Verify Razorpay connection
    api.orders.all().then(() => {
      systemStatus = "online";
      res.json({
        status: systemStatus,
        payment_system: "online",
        pad_count: padCount
      });
    }).catch((error) => {
      systemStatus = "payment_system_error";
      res.json({
        status: "error",
        payment_system: "offline",
        error: error.message,
        pad_count: padCount
      });
    });
  } catch (error) {
    res.json({
      status: "error",
      error: error.message,
      pad_count: padCount
    });
  }
});

// Pad count endpoint
app.get('/pad-count', (req, res) => {
  res.json({
    padCount: padCount,
    status: paymentStatus,
    systemStatus: systemStatus
  });
});

app.get('/', (req, res) => {
  if (padCount < 1) {
    return res.render('error', { message: 'No pads available' });
  }

  const orderData = {
    amount: 600,
    currency: 'INR',
    receipt: 'order_rcptid_' + Date.now(),
    payment_capture: 1,
  };

  api.orders.create(orderData, (err, order) => {
    if (err) {
      systemStatus = "payment_error";
      return res.status(500).send('Error creating Razorpay order');
    }

    paymentStatus = "processing";
    res.render('payment', {
      razorpayKey: process.env.RAZORPAY_KEY_ID,
      orderId: order.id,
      amount: order.amount,
      padCount: padCount
    });
  });
});

app.post('/verify-payment', (req, res) => {
  const { razorpay_payment_id, razorpay_order_id, razorpay_signature } = req.body;

  try {
    const generated_signature = api.utility.verifyPaymentSignature({
      razorpay_order_id,
      razorpay_payment_id,
      razorpay_signature,
    });

    if (generated_signature) {
      if (padCount > 0) {
        padCount--;
        paymentStatus = "dispensing";
        setTimeout(() => {
          paymentStatus = "ready";
        }, 10000); // Reset status after 10 seconds
        res.send('Payment successful. Pad dispensing.');
      } else {
        res.send('Error: No pads available');
      }
    } else {
      paymentStatus = "failed";
      setTimeout(() => {
        paymentStatus = "ready";
      }, 5000);
      res.send('Payment verification failed');
    }
  } catch (error) {
    systemStatus = "payment_error";
    res.status(500).send('Payment system error');
  }
});

const port = process.env.PORT || 3000;
app.listen(port, () => {
  console.log(`Server running on port ${port}`);
});