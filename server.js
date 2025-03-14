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

// In-memory state mirror (will be synced with DB)
// Added inactiveSince to track when the system became inactive.
// systemStatus is derived: if padCount > 0 then 'active' else 'inactive'.
let systemState = {
  padCount: 20,
  currentOrderId: null,
  currentPaymentId: null,
  paymentStatus: 'ready', // "ready", "success", "refunded", "inactive"
  dispensing: false,
  transactionCompleted: false,
  inactiveSince: null,  // timestamp when system became inactive
};

// Helper: Update system state in DB
async function updateSystemState() {
  await pool.execute(
    'UPDATE system_state SET pad_count = ?, payment_status = ?, dispensing = ?, transaction_completed = ?, inactive_since = ? WHERE id = 1',
    [systemState.padCount, systemState.paymentStatus, systemState.dispensing, systemState.transactionCompleted, systemState.inactiveSince]
  );
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
    // Sync system state from DB
    const [stateRows] = await pool.execute('SELECT * FROM system_state WHERE id = 1');
    const dbState = stateRows[0];
    systemState.padCount = dbState.pad_count;
    systemState.paymentStatus = dbState.payment_status;
    systemState.dispensing = dbState.dispensing;
    systemState.transactionCompleted = dbState.transaction_completed;
    systemState.inactiveSince = dbState.inactive_since;

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
      systemState = {
        padCount: 20,
        currentOrderId: null,
        currentPaymentId: null,
        paymentStatus: 'ready',
        dispensing: false,
        transactionCompleted: false,
        inactiveSince: null,
      };
      await pool.execute(
        'UPDATE system_state SET pad_count = ?, payment_status = ?, dispensing = ?, transaction_completed = ?, inactive_since = ? WHERE id = 1',
        [20, 'ready', false, false, null]
      );
      await addLog('state', 'System reset to default state');
    } else if (action === 'switch_off') {
      systemState.paymentStatus = 'inactive';
      // Convert timestamp to MySQL datetime format
      const inactiveDate = new Date(Date.now()).toISOString().slice(0, 19).replace('T', ' ');
      
      await pool.execute(
        'UPDATE system_state SET payment_status = ?, inactive_since = ? WHERE id = 1', 
        ['inactive', inactiveDate]
      );
      await addLog('state', 'System switched off');
    } else if (action === 'switch_on') {
      systemState.paymentStatus = 'ready';
      systemState.inactiveSince = null;
      await pool.execute('UPDATE system_state SET payment_status = ?, inactive_since = ? WHERE id = 1', ['ready', null]);
      await addLog('state', 'System switched on');
    }
    res.json({ success: true, systemState });
  } catch (error) {
    console.error('Error updating system state:', error);
    await addLog('error', `State update error: ${error.message}`);
    res.status(500).json({ error: 'Error updating system state' });
  }
});

// Admin: Update Pad Count
app.post('/update-pad-count', adminAuth, async (req, res) => {
  const { count } = req.body;
  if (typeof count === 'number' && count >= 0) {
    systemState.padCount = count;
    await pool.execute('UPDATE system_state SET pad_count = ? WHERE id = 1', [count]);
    await addLog('state', `Pad count updated to ${count}`);
    res.json({ success: true, padCount: systemState.padCount });
  } else {
    res.status(400).json({ error: 'Invalid pad count value' });
  }
});

// -----------------------
// CLIENT / DEVICE ROUTES
// -----------------------

// Home Route: Redirect based on transaction status
app.get('/', async (req, res) => {
  const [rows] = await pool.execute('SELECT * FROM system_state WHERE id = 1');
  const state = rows[0];
  if (state.transaction_completed && state.dispensing) {
    return res.redirect('/dispensing');
  }
  res.redirect('/payment');
});

// Payment Page
app.get('/payment', async (req, res) => {
  const [rows] = await pool.execute('SELECT * FROM system_state WHERE id = 1');
  const state = rows[0];
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
  let [rows] = await pool.execute('SELECT * FROM system_state WHERE id = 1');
  let state = rows[0];
  if (!state) {
    // Create initial state if not found
    await pool.execute(
      'INSERT INTO system_state (id, pad_count, payment_status, dispensing, transaction_completed, inactive_since) VALUES (1, 20, "ready", false, false, NULL)'
    );
    state = { pad_count: 20, payment_status: 'ready', dispensing: false, transaction_completed: false, inactive_since: null };
  }
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
    systemState.paymentStatus = 'success';
    systemState.currentPaymentId = razorpay_payment_id;
    systemState.dispensing = true;
    systemState.transactionCompleted = true;
    await pool.execute(
      'UPDATE payments SET payment_id = ?, status = ? WHERE order_id = ?',
      [razorpay_payment_id, 'success', systemState.currentOrderId]
    );
    await updateSystemState();
    await addLog('payment', `Payment verified: ${razorpay_payment_id}`);
    res.json({ status: 'success' });
  } else {
    await addLog('error', 'Payment verification failed: Signature mismatch');
    res.status(400).json({ status: 'failed' });
  }
});

// Check Motor Status (for hardware control)
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

  

// Refund Endpoint – Only allowed if payment is successful and transaction completed
app.post('/refund', async (req, res) => {
  const { paymentId, reason } = req.body;

  if (!paymentId) {
    await addLog('error', 'Refund error: Invalid Payment ID');
    return res.status(400).json({ error: 'Invalid Payment ID' });
  }

  // Prevent duplicate refunds
  if (systemState.paymentStatus === 'refunded' && systemState.currentPaymentId === paymentId) {
    await addLog('error', `Refund error: Duplicate refund for Payment ID ${paymentId}`);
    return res.status(400).json({ error: 'Refund has already been processed for this payment.' });
  }

  try {
    systemState.paymentStatus = 'refunded';
    systemState.currentPaymentId = paymentId;

    const refund = await razorpay.payments.refund(paymentId);
    console.log('Refund successful:', refund);
    await addLog('refund', `Refund processed for Payment ID: ${paymentId} with reason: ${reason}`);

    // Check inactivity: if system is inactive and inactiveSince is set for at least 30 mins.
    if (systemState.paymentStatus === 'refunded' && systemState.inactiveSince) {
      const now = Date.now();
      const inactiveDuration = now - systemState.inactiveSince;
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
    systemState.paymentStatus = 'refunded';
    systemState.dispensing = false;
    await updateSystemState();
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
    const previousStatus = systemState.paymentStatus;
    
    // Only reduce count when transitioning from success->ready
    if (paymentStatus === 'ready' && previousStatus === 'success') {
      systemState.padCount = Math.max(0, systemState.padCount - 1);
      await addLog('inventory', `Pad dispensed. New count: ${systemState.padCount}`);
    }

    // Update full system state
    systemState.paymentStatus = paymentStatus;
    systemState.currentOrderId = null;
    systemState.currentPaymentId = null;
    systemState.dispensing = false;
    systemState.transactionCompleted = false;

    // Update database
    await pool.execute(
      'UPDATE system_state SET pad_count = ?, payment_status = ?, dispensing = ?, transaction_completed = ? WHERE id = 1',
      [systemState.padCount, paymentStatus, false, false]
    );

    await addLog('dispense', `Pad dispensed. New count: ${systemState.padCount}`);
    
    res.json({ 
      success: true, 
      newStatus: paymentStatus,
      padCount: systemState.padCount
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
  const [rows] = await pool.execute('SELECT * FROM system_state WHERE id = 1');
  const state = rows[0];
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
  
  const [rows] = await pool.execute('SELECT * FROM system_state WHERE id = 1');
  const state = rows[0];
  
  // Force "dispensing" to be true if payment is successful and the transaction is completed.
  // This change is intended to signal the ESP32 to start the motor.
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


const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
