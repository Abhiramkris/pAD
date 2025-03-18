const express = require('express');
const path = require('path');
const Razorpay = require('razorpay');
const crypto = require('crypto');
const nodemailer = require('nodemailer');
const bcrypt = require('bcrypt');
const mysql = require('mysql2/promise');
const session = require('express-session');
require('dotenv').config();

const app = express();

// Express middleware
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(session({
  secret: process.env.SESSION_SECRET || 'secret123',
  resave: false,
  saveUninitialized: true,
}));
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

// MySQL Connection Pool
const pool = mysql.createPool({
  host: process.env.MYSQL_HOST,
  port: process.env.MYSQL_PORT, 
  user: process.env.MYSQL_USER,
  password: process.env.MYSQL_PASSWORD,
  database: process.env.MYSQL_DB,
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0,
});

// Razorpay Setup
const razorpay = new Razorpay({
  key_id: process.env.RAZORPAY_KEY_ID,
  key_secret: process.env.RAZORPAY_KEY_SECRET,
});

// Email Transporter Setup
const transporter = nodemailer.createTransport({
  service: 'gmail',
  auth: {
    user: process.env.EMAIL_USER,
    pass: process.env.EMAIL_PASS,
  },
});

// In-memory state cache (will be synced with DB)
let systemState = {
  padCount: 0,
  currentOrderId: null,
  currentPaymentId: null,
  paymentStatus: 'ready',
  dispensing: false,
  transactionCompleted: false,
  inactiveSince: null,
};

// Helper: Get the current system state from the database
async function getSystemState() {
  const [rows] = await pool.execute('SELECT * FROM system_state WHERE id = 1');
  if (rows.length === 0) {
    // Create initial state if not found
    await pool.execute(
      'INSERT INTO system_state (id, pad_count, payment_status, dispensing, transaction_completed, inactive_since) VALUES (1, 20, "ready", false, false, NULL)'
    );
    return { 
      pad_count: 20, 
      payment_status: 'ready', 
      dispensing: false, 
      transaction_completed: false, 
      inactive_since: null 
    };
  }
  return rows[0];
}

// Helper: Update system state in DB and refresh the in-memory cache
async function updateSystemState(updates = {}) {
  // First, get the current state from the database
  const currentState = await getSystemState();
  
  // Apply updates to the current state
  const updatedState = { ...currentState, ...updates };
  
  // Update the database
  await pool.execute(
    'UPDATE system_state SET pad_count = ?, payment_status = ?, dispensing = ?, transaction_completed = ?, inactive_since = ? WHERE id = 1',
    [
      updatedState.pad_count, 
      updatedState.payment_status, 
      updatedState.dispensing, 
      updatedState.transaction_completed, 
      updatedState.inactive_since
    ]
  );
  
  // Update the in-memory cache
  systemState = {
    padCount: updatedState.pad_count,
    paymentStatus: updatedState.payment_status,
    dispensing: updatedState.dispensing,
    transactionCompleted: updatedState.transaction_completed,
    inactiveSince: updatedState.inactive_since,
    currentOrderId: systemState.currentOrderId,
    currentPaymentId: systemState.currentPaymentId
  };
  
  return systemState;
}

// Helper: Refresh the in-memory state from the database
async function refreshSystemState() {
  const dbState = await getSystemState();
  systemState = {
    padCount: dbState.pad_count,
    paymentStatus: dbState.payment_status,
    dispensing: dbState.dispensing,
    transactionCompleted: dbState.transaction_completed,
    inactiveSince: dbState.inactive_since,
    currentOrderId: systemState.currentOrderId,
    currentPaymentId: systemState.currentPaymentId
  };
  return systemState;
}

// Initialize the system state when the application starts
async function initializeSystemState() {
  await refreshSystemState();
  console.log('System state initialized:', systemState);
}

// Helper: Log events to DB
async function addLog(type, message) {
  try {
    await pool.execute(
      'INSERT INTO logs (type, message, created_at) VALUES (?, ?, NOW())',
      [type, message]
    );
  } catch (err) {
    console.error('Error logging event:', err);
  }
}

// Middleware for Admin Authentication Check
function adminAuth(req, res, next) {
  if (req.session && req.session.admin) {
    next();
  } else {
    res.redirect('/admin/login');
  }
}

// -----------------------
// ADMIN ROUTES
// -----------------------

// Admin Login Page
app.get('/admin/login', (req, res) => {
  res.render('admin_login'); // Create a view 'admin_login.ejs'
});

// Handle Admin Login
app.post('/admin/login', async (req, res) => {
  const { username, password } = req.body;
  try {
    const [rows] = await pool.execute('SELECT * FROM admins WHERE username = ?', [username]);
    if (rows.length > 0) {
      const admin = rows[0];
      const match = await bcrypt.compare(password, admin.hashed_password);
      if (match) {
        req.session.admin = { id: admin.id, username: admin.username };
        await addLog('admin', `Admin ${admin.username} logged in`);
        return res.redirect('/admin');
      }
    }
    res.render('admin_login', { error: 'Invalid credentials' });
  } catch (error) {
    console.error('Admin Login Error:', error);
    await addLog('error', `Admin login error: ${error.message}`);
    res.status(500).send('Internal Server Error');
  }
});

// Admin Dashboard
app.get('/admin', adminAuth, async (req, res) => {
  try {
    // Refresh system state from DB
    await refreshSystemState();
    
    // Fetch logs and payments
    const [logRows] = await pool.execute('SELECT * FROM logs ORDER BY created_at DESC LIMIT 50');
    const [paymentRows] = await pool.execute('SELECT * FROM payments ORDER BY created_at DESC LIMIT 50');

    res.render('admin_dashboard', { 
      systemState, 
      logs: logRows, 
      payments: paymentRows, 
      admin: req.session.admin 
    });
  } catch (error) {
    console.error('Error loading admin dashboard:', error);
    await addLog('error', `Dashboard load error: ${error.message}`);
    res.status(500).send('Error loading admin dashboard');
  }
});

// Admin: State Reset / Switch On/Off
app.post('/admin/state', adminAuth, async (req, res) => {
  const { action } = req.body; // action: 'reset', 'switch_on', 'switch_off'
  try {
    if (action === 'reset') {
      await updateSystemState({
        pad_count: 20,
        payment_status: 'ready',
        dispensing: false,
        transaction_completed: false,
        inactive_since: null
      });
      systemState.currentOrderId = null;
      systemState.currentPaymentId = null;
      await addLog('state', 'System reset to default state');
    } else if (action === 'switch_off') {
      const inactiveDate = new Date(Date.now()).toISOString().slice(0, 19).replace('T', ' ');
      await updateSystemState({
        payment_status: 'inactive',
        inactive_since: inactiveDate
      });
      await addLog('state', 'System switched off');
    } else if (action === 'switch_on') {
      await updateSystemState({
        payment_status: 'ready',
        inactive_since: null
      });
      await addLog('state', 'System switched on');
    }
    res.json({ success: true, systemState: await refreshSystemState() });
  } catch (error) {
    console.error('Error updating system state:', error);
    await addLog('error', `State update error: ${error.message}`);
    res.status(500).json({ error: 'Error updating system state' });
  }
});

// Admin: Update Pad Count
app.post('/update-pad-count', adminAuth, async (req, res) => {
  const { count } = req.body;
  
  // Convert to number and validate
  const numericCount = Number(count);
  
  if (!isNaN(numericCount) && numericCount >= 0) {
    await updateSystemState({ pad_count: numericCount });
    await addLog('state', `Pad count updated to ${numericCount}`);
    res.json({ success: true, padCount: numericCount });
  } else {
    res.status(400).json({ error: 'Invalid pad count value - must be a non-negative number' });
  }
});

// -----------------------
// CLIENT / DEVICE ROUTES
// -----------------------

// Home Route: Redirect based on transaction status
app.get('/', async (req, res) => {
  const state = await getSystemState();
  if (state.transaction_completed && state.dispensing) {
    return res.redirect('/dispensing');
  }
  res.redirect('/payment');
});

// Payment Page
app.get('/payment', async (req, res) => {
  const state = await getSystemState();
  if (state.transaction_completed && state.dispensing) {
    return res.redirect('/dispensing');
  }
  res.render('payment', {
    padCount: state.pad_count,
    key_id: process.env.RAZORPAY_KEY_ID,
  });
});

// Dispensing Page (shown when a transaction is complete)
app.get('/dispensing', async (req, res) => {
  const state = await getSystemState();
  if (state.transaction_completed && state.dispensing) {
    res.render('dispensing', { padCount: state.pad_count });
  } else {
    res.redirect('/payment');
  }
});

// -----------------------
// PAYMENT PROCESSING
// -----------------------

// Create Razorpay Order
app.post('/create-order', async (req, res) => {
  try {
    const options = { amount: 530, currency: 'INR', receipt: `order_${Date.now()}` };
    const order = await razorpay.orders.create(options);
    systemState.currentOrderId = order.id;
    await pool.execute(
      'INSERT INTO payments (order_id, amount, status, created_at) VALUES (?, ?, ?, NOW())',
      [order.id, 600, 'pending']
    );
    res.json(order);
  } catch (error) {
    console.error('Error creating order:', error);
    await addLog('error', `Order creation failed: ${error.message}`);
    res.status(500).json({ error: error.message });
  }
});

// Verify Payment
app.post('/verify-payment', async (req, res) => {
  const { razorpay_payment_id, razorpay_order_id, razorpay_signature } = req.body;
  const generated_signature = crypto
    .createHmac('sha256', process.env.RAZORPAY_KEY_SECRET)
    .update(`${systemState.currentOrderId}|${razorpay_payment_id}`)
    .digest('hex');

  if (generated_signature === razorpay_signature) {
    // Update system state
    systemState.currentPaymentId = razorpay_payment_id;
    await updateSystemState({
      payment_status: 'success',
      dispensing: true,
      transaction_completed: true
    });
    
    await pool.execute(
      'UPDATE payments SET payment_id = ?, status = ? WHERE order_id = ?',
      [razorpay_payment_id, 'success', systemState.currentOrderId]
    );
    
    await addLog('payment', `Payment verified: ${razorpay_payment_id}`);
    res.json({ status: 'success' });
  } else {
    await addLog('error', 'Payment verification failed: Signature mismatch');
    res.status(400).json({ status: 'failed' });
  }
});

// Check Motor Status (for hardware control)
app.get('/check-motor', async (req, res) => {
  const { authCode } = req.query;
  if (authCode !== process.env.AUTH_CODE) {
    return res.status(401).json({ status: 'unauthorized' });
  }
  
  const state = await getSystemState();
  if (state.payment_status === 'success' && !state.dispensing) {
    res.json({ motor: 'start' });
  } else {
    res.json({ motor: 'stop' });
  }
});

// Refund Endpoint – Only allowed if payment is successful and transaction completed
app.post('/refund', async (req, res) => {
  const { paymentId, reason } = req.body;

  if (!paymentId) {
    await addLog('error', 'Refund error: Invalid Payment ID');
    return res.status(400).json({ error: 'Invalid Payment ID' });
  }

  // Get current state
  const currentState = await getSystemState();

  // Prevent duplicate refunds
  if (currentState.payment_status === 'refunded' && systemState.currentPaymentId === paymentId) {
    await addLog('error', `Refund error: Duplicate refund for Payment ID ${paymentId}`);
    return res.status(400).json({ error: 'Refund has already been processed for this payment.' });
  }

  try {
    // Update state
    systemState.currentPaymentId = paymentId;
    await updateSystemState({
      payment_status: 'refunded'
    });

    const refund = await razorpay.payments.refund(paymentId);
    console.log('Refund successful:', refund);
    await addLog('refund', `Refund processed for Payment ID: ${paymentId} with reason: ${reason}`);

    // Re-fetch to get the latest state including inactiveSince
    const updatedState = await getSystemState();
    
    // Check inactivity: if system is inactive and inactiveSince is set for at least 30 mins.
    if (updatedState.payment_status === 'refunded' && updatedState.inactive_since) {
      const now = Date.now();
      const inactiveTime = new Date(updatedState.inactive_since).getTime();
      const inactiveDuration = now - inactiveTime;
      
      if (inactiveDuration >= 30 * 60 * 1000) {
        const mailOptions = {
          from: process.env.EMAIL_USER,
          to: process.env.NOTIFICATION_EMAIL,
          subject: 'Critical Alert: System Inactive After Refund',
          text: `Refund initiated for Payment ID: ${paymentId}.\nThe system has been inactive for over 30 minutes. Please check the system immediately.`,
        };
        transporter.sendMail(mailOptions, (err, info) => {
          if (err) {
            console.error('Error sending inactive system email:', err);
            addLog('error', `Inactive system email error: ${err.message}`);
          } else {
            console.log('Inactive system email sent:', info.response);
            addLog('notification', 'Inactive system email sent');
          }
        });
      }
    }

    res.json({ success: true, message: 'Refund issued successfully', refund });
  } catch (error) {
    console.error('Error processing refund:', error);
    await addLog('error', `Refund processing failed: ${error.message}`);
    res.status(500).json({ error: 'Refund processing failed', details: error.message });
  }
});

// System Error Notification (e.g. IR sensor error)
app.post('/system-error', async (req, res) => {
  const { paymentId, reason } = req.body;
  if (paymentId && reason === 'IR interrupt not detected') {
    await updateSystemState({
      payment_status: 'refunded',
      dispensing: false
    });
    
    try {
      const refund = await razorpay.payments.refund(paymentId);
      await addLog('refund', `Refund processed for system error for Payment ID: ${paymentId}`);
      const mailOptions = {
        from: process.env.EMAIL_USER,
        to: process.env.NOTIFICATION_EMAIL,
        subject: 'Refund Issued for System Error',
        text: `Refund issued for Payment ID: ${paymentId}.\nReason: IR interrupt not detected.\nRefund Details: ${JSON.stringify(refund)}`,
      };
      transporter.sendMail(mailOptions, (err, info) => {
        if (err) {
          console.error('Error sending refund email:', err);
          addLog('error', `Refund email error: ${err.message}`);
        } else {
          console.log('Refund email sent:', info.response);
          addLog('notification', 'Refund email sent for system error');
        }
      });
      res.json({ success: true, message: 'Refund processed successfully' });
    } catch (error) {
      console.error('Error processing refund:', error);
      await addLog('error', `System error refund failed: ${error.message}`);
      res.status(500).json({ error: 'Refund processing failed' });
    }
  } else {
    await addLog('error', 'System error endpoint received invalid details');
    res.status(400).json({ error: 'Invalid error details' });
  }
});

// Update Payment Status Endpoint (for ESP32)
app.post('/update-payment-status', async (req, res) => {
  const { paymentStatus, authCode } = req.body;

  // Authentication check
  if (authCode !== process.env.AUTH_CODE) {
    await addLog('error', 'Unauthorized payment status update attempt');
    return res.status(401).json({ error: 'Unauthorized' });
  }

  // Validate payment status
  const validStatuses = ['ready', 'success', 'refunded', 'failed'];
  if (!validStatuses.includes(paymentStatus)) {
    return res.status(400).json({ error: 'Invalid payment status' });
  }

  try {
    // Get the current state directly from the database
    const currentState = await getSystemState();
    const previousStatus = currentState.payment_status;
    
    // Calculate the new pad count
    let newPadCount = currentState.pad_count;
    
    // Only reduce count when transitioning from success->ready
    if (paymentStatus === 'ready' && previousStatus === 'success') {
      newPadCount = Math.max(0, currentState.pad_count - 1);
      await addLog('inventory', `Pad dispensed. New count: ${newPadCount}`);
    }

    // Update system state
    await updateSystemState({
      pad_count: newPadCount,
      payment_status: paymentStatus,
      dispensing: false,
      transaction_completed: false
    });

    // Reset the transaction IDs in memory
    systemState.currentOrderId = null;
    systemState.currentPaymentId = null;

    await addLog('dispense', `Pad dispensed. New count: ${newPadCount}`);
    
    res.json({ 
      success: true, 
      newStatus: paymentStatus,
      padCount: newPadCount
    });
  } catch (error) {
    console.error('Status update error:', error);
    await addLog('error', `Status update failed: ${error.message}`);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Check System Status (for device monitoring)
app.get('/check', async (req, res) => {
  const authCodeParam = req.query.authCode;
  if (authCodeParam !== process.env.AUTH_CODE) {
    return res.status(401).json({ status: 'unauthorized' });
  }
  const state = await getSystemState();
  res.json({
    padCount: state.pad_count,
    paymentStatus: state.payment_status,
    systemStatus: state.pad_count > 0 ? 'active' : 'inactive',
    dispensing: state.dispensing,
  });
});

app.get('/display', async (req, res) => {
  const authCodeParam = req.query.authCode;
  if (authCodeParam !== process.env.AUTH_CODE) {
    return res.status(401).json({ status: 'unauthorized' });
  }
  
  const state = await getSystemState();
  
  // Force "dispensing" to be true if payment is successful and the transaction is completed.
  let dispensing = false;
  if (state.payment_status === 'success' && state.transaction_completed) {
    dispensing = true;
  }
  
  res.json({
    padCount: state.pad_count,
    paymentStatus: state.payment_status,
    systemStatus: state.pad_count > 0 ? 'active' : 'inactive',
    dispensing: state.dispensing  // Make sure this is included
  });
});

// Add this route to your server code to handle payment button state
app.get('/payment-button-state', async (req, res) => {
  try {
    const state = await getSystemState();
    
    // Payment button should be disabled if:
    // 1. padCount is 0
    // 2. payment_status is 'inactive'
    // 3. dispensing is true (a transaction is in progress)
    const disableButton = 
      state.pad_count === 0 || 
      state.payment_status === 'inactive' || 
      state.dispensing === true;
    
    res.json({
      disableButton: disableButton,
      reason: state.pad_count === 0 ? 'Out of stock' : 
              state.payment_status === 'inactive' ? 'System offline' : 
              state.dispensing === true ? 'Transaction in progress' : ''
    });
  } catch (error) {
    console.error('Error fetching payment button state:', error);
    await addLog('error', `Payment button state error: ${error.message}`);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// New Route: /currentpaymentid
app.get('/currentpaymentid', async (req, res) => {
  const authCodeParam = req.query.authCode;
  if (authCodeParam !== process.env.AUTH_CODE) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  
  // Get current state from database
  const state = await getSystemState();
  
  // If the transaction is completed and dispensing is false,
  // reset currentPaymentId to null.
  if (state.transaction_completed && !state.dispensing) {
    systemState.currentPaymentId = null;
    // Optionally, log this event for debugging
    await addLog('currentpaymentid', 'Transaction completed and dispensing false. currentPaymentId reset to null.');
  }
  
  res.json({ currentPaymentId: systemState.currentPaymentId });
});

// Endpoint to send a custom email to the admin
app.post('/send-custom-email', async (req, res) => {
  const { subject, message, authCode: providedAuth } = req.body;
  if (providedAuth !== process.env.AUTH_CODE) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  if (!subject || !message) {
    return res.status(400).json({ error: 'Subject and message are required' });
  }
  try {
    const mailOptions = {
      from: process.env.EMAIL_USER,
      to: process.env.NOTIFICATION_EMAIL,
      subject: subject,
      text: message,
    };
    transporter.sendMail(mailOptions, async (err, info) => {
      if (err) {
        console.error('Error sending custom email:', err);
        await addLog('error', `Custom email send error: ${err.message}`);
        return res.status(500).json({ error: 'Failed to send email' });
      } else {
        console.log('Custom email sent:', info.response);
        await addLog('custom-email', `Subject: ${subject}; Message: ${message}`);
        return res.json({ success: true, message: 'Custom email sent successfully' });
      }
    });
  } catch (error) {
    console.error('Error in /send-custom-email endpoint:', error);
    await addLog('error', `Send custom email endpoint error: ${error.message}`);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// Initialize the system when the server starts
initializeSystemState().catch(error => {
  console.error('Failed to initialize system state:', error);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));