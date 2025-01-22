const express = require('express');
const path = require('path');
const Razorpay = require('razorpay');
require('dotenv').config();  // To load .env variables

const app = express();

// Setup Razorpay API keys from .env file
const api = new Razorpay({
  key_id: process.env.RAZORPAY_KEY_ID,
  key_secret: process.env.RAZORPAY_KEY_SECRET,
});

// Middleware to parse form data
app.use(express.urlencoded({ extended: true }));

// Set up the view engine as EJS
app.set('view engine', 'ejs');

// Set the views directory
app.set('views', path.join(__dirname, 'views'));

// Serve static files (if needed for CSS, JS, images)
app.use(express.static(path.join(__dirname, 'public')));
app.get('/payment', (req, res) => {
    const orderData = {
      amount: 600,  // Amount in paise (600 INR)
      currency: 'INR',
      receipt: 'order_rcptid_1234',
      payment_capture: 1, // Auto-capture the payment
    };
  
    api.orders.create(orderData, (err, order) => {
      if (err) {
        return res.status(500).send('Error creating Razorpay order');
      }
  
      // Pass Razorpay key, order details, and other required data to EJS template
      res.render('payment', {
        razorpayKey: process.env.RAZORPAY_KEY_ID, // Pass Razorpay key from the .env file
        orderId: order.id,
        amount: order.amount,
      });
    });
  });
  

// Route to verify payment after Razorpay returns data
app.post('/verify-payment', (req, res) => {
  const { razorpay_payment_id, razorpay_order_id, razorpay_signature } = req.body;

  const generated_signature = api.utility.verifyPaymentSignature({
    razorpay_order_id,
    razorpay_payment_id,
    razorpay_signature,
  });

  if (generated_signature) {
    // Payment verified successfully
    res.send('Payment successful');
  } else {
    // Payment verification failed
    res.send('Payment verification failed');
  }
});

// Start the server
const port = process.env.PORT || 3000;
app.listen(port, () => {
  console.log(`Server running on port ${port}`);
});
