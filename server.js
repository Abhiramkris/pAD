const express = require('express');
const path = require('path');
const Razorpay = require('razorpay');
const crypto = require('crypto');
const nodemailer = require('nodemailer');
const bcrypt = require('bcrypt');
const mysql = require('mysql2/promise');
const cron = require('node-cron');
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

const MONITORING_CONFIG = {
  MIN_PAD_COUNT: 5,  // Minimum pad count threshold
  NOTIFICATION_INTERVAL: '0 */30 * * * *', // Every 30 minutes
  MAX_OFFLINE_DURATION: 30 * 60 * 1000, // 30 minutes in milliseconds
};

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

// System Check Admin Route - For receiving system metrics from ESP32
app.post('/systemcheckadmin', async (req, res) => {
  // Check authorization from query parameters or request body
  const authCode = req.query.authCode || req.body.authCode;
  
  if (authCode !== process.env.AUTH_CODE) {
    await addLog('error', 'Unauthorized system metrics reporting attempt');
    return res.status(401).json({ error: 'Unauthorized' });
  }

  try {
    // Extract system metrics from request body
    const {
      freeHeap,
      totalHeap,
      heapPercentage,
      cpuTemperature,
      uptime,
      cpuFrequencyMHz,
      wifiRSSI,
      wifiIP,
      macAddress
    } = req.body;

    // Log the received metrics
    const metricsLog = `System metrics - Free Heap: ${freeHeap || 'N/A'} bytes, ` +
                       `Heap Usage: ${(heapPercentage || 0).toFixed(2)}%, ` +
                       `CPU Temp: ${(cpuTemperature || 0).toFixed(2)}°C, ` +
                       `Uptime: ${Math.floor((uptime || 0) / 3600)}h ${Math.floor(((uptime || 0) % 3600) / 60)}m, ` +
                       `WiFi RSSI: ${wifiRSSI || 'N/A'}dBm, ` +
                       `IP: ${wifiIP || 'N/A'}`;
    
    await addLog('system', metricsLog);

    // Check for critical conditions that might need attention
    let criticalConditions = [];
    
    if (heapPercentage && heapPercentage < 20) {
      criticalConditions.push(`Low memory: ${heapPercentage.toFixed(2)}% free`);
    }
    
    if (cpuTemperature && cpuTemperature > 70) {
      criticalConditions.push(`High CPU temperature: ${cpuTemperature.toFixed(2)}°C`);
    }
    
    if (wifiRSSI && wifiRSSI < -80) {
      criticalConditions.push(`Poor WiFi signal: ${wifiRSSI}dBm`);
    }

    // If there are critical conditions, send notification email
    if (criticalConditions.length > 0) {
      const subject = 'System Health Alert: Critical Conditions Detected';
      const message = `The following critical conditions were detected on the pad dispenser:\n\n` +
                      `${criticalConditions.join('\n')}\n\n` +
                      `Full system metrics:\n` +
                      `- Free Heap: ${freeHeap || 'N/A'} bytes / ${totalHeap || 'N/A'} bytes (${(heapPercentage || 0).toFixed(2)}%)\n` +
                      `- CPU Temperature: ${(cpuTemperature || 0).toFixed(2)}°C\n` +
                      `- CPU Frequency: ${cpuFrequencyMHz || 'N/A'} MHz\n` +
                      `- Uptime: ${Math.floor((uptime || 0) / 3600)}h ${Math.floor(((uptime || 0) % 3600) / 60)}m\n` +
                      `- WiFi Signal Strength: ${wifiRSSI || 'N/A'}dBm\n` +
                      `- IP Address: ${wifiIP || 'N/A'}\n` +
                      `- MAC Address: ${macAddress || 'N/A'}\n`;
      
      try {
        await sendEmail(subject, message);
      } catch (emailError) {
        console.error('Failed to send system metrics alert email:', emailError);
        await addLog('error', `Metrics alert email error: ${emailError.message}`);
      }
    }

    res.json({ 
      success: true, 
      message: 'System metrics received and processed',
      criticalIssues: criticalConditions.length > 0 ? criticalConditions : null
    });
  } catch (error) {
    console.error('Error processing system metrics:', error);
    await addLog('error', `System metrics processing error: ${error.message}`);
    res.status(500).json({ error: 'Failed to process system metrics' });
  }
});

// System Check Admin Route - For receiving system metrics from ESP32
app.post('/systemcheckadmin', async (req, res) => {
  // Check authorization from query parameters or request body
  const authCode = req.query.authCode || req.body.authCode;
  
  if (authCode !== process.env.AUTH_CODE) {
    await addLog('error', 'Unauthorized system metrics reporting attempt');
    return res.status(401).json({ error: 'Unauthorized' });
  }
  
  try {
    // Extract system metrics from request body
    const metrics = {
      freeHeap: req.body.freeHeap,
      totalHeap: req.body.totalHeap,
      heapPercentage: req.body.heapPercentage,
      cpuTemperature: req.body.cpuTemperature,
      uptime: req.body.uptime,
      cpuFrequencyMHz: req.body.cpuFrequencyMHz,
      wifiRSSI: req.body.wifiRSSI,
      wifiIP: req.body.wifiIP,
      macAddress: req.body.macAddress,
      flashSizeBytes: req.body.flashSizeBytes,
      timestamp: new Date()
    };
    
    // Store metrics for GET endpoint access
    global.latestMetrics = metrics;
    global.latestMetricsTimestamp = new Date();
    
    // Option: Store in database for persistence
    // await db.collection('systemMetrics').insertOne(metrics);
    
    // Log the received metrics
    const metricsLog = `System metrics - Free Heap: ${metrics.freeHeap || 'N/A'} bytes, ` +
                      `Heap Usage: ${(metrics.heapPercentage || 0).toFixed(2)}%, ` +
                      `CPU Temp: ${(metrics.cpuTemperature || 0).toFixed(2)}°C, ` +
                      `Uptime: ${Math.floor((metrics.uptime || 0) / 3600)}h ${Math.floor(((metrics.uptime || 0) % 3600) / 60)}m, ` +
                      `WiFi RSSI: ${metrics.wifiRSSI || 'N/A'}dBm, ` +
                      `IP: ${metrics.wifiIP || 'N/A'}`;
        
    await addLog('system', metricsLog);
    
    // Check for critical conditions that might need attention
    let criticalConditions = [];
        
    if (metrics.heapPercentage && metrics.heapPercentage < 20) {
      criticalConditions.push(`Low memory: ${metrics.heapPercentage.toFixed(2)}% free`);
    }
        
    if (metrics.cpuTemperature && metrics.cpuTemperature > 70) {
      criticalConditions.push(`High CPU temperature: ${metrics.cpuTemperature.toFixed(2)}°C`);
    }
        
    if (metrics.wifiRSSI && metrics.wifiRSSI < -80) {
      criticalConditions.push(`Poor WiFi signal: ${metrics.wifiRSSI}dBm`);
    }
    
    // If there are critical conditions, send notification email
    if (criticalConditions.length > 0) {
      const subject = 'System Health Alert: Critical Conditions Detected';
      const message = `The following critical conditions were detected on the pad dispenser:\n\n` +
                     `${criticalConditions.join('\n')}\n\n` +
                     `Full system metrics:\n` +
                     `- Free Heap: ${metrics.freeHeap || 'N/A'} bytes / ${metrics.totalHeap || 'N/A'} bytes (${(metrics.heapPercentage || 0).toFixed(2)}%)\n` +
                     `- CPU Temperature: ${(metrics.cpuTemperature || 0).toFixed(2)}°C\n` +
                     `- CPU Frequency: ${metrics.cpuFrequencyMHz || 'N/A'} MHz\n` +
                     `- Uptime: ${Math.floor((metrics.uptime || 0) / 3600)}h ${Math.floor(((metrics.uptime || 0) % 3600) / 60)}m\n` +
                     `- WiFi Signal Strength: ${metrics.wifiRSSI || 'N/A'}dBm\n` +
                     `- IP Address: ${metrics.wifiIP || 'N/A'}\n` +
                     `- MAC Address: ${metrics.macAddress || 'N/A'}\n`;
            
      try {
        await sendEmail(subject, message);
      } catch (emailError) {
        console.error('Failed to send system metrics alert email:', emailError);
        await addLog('error', `Metrics alert email error: ${emailError.message}`);
      }
    }
    
    res.json({
      success: true,
      message: 'System metrics received and processed',
      criticalIssues: criticalConditions.length > 0 ? criticalConditions : null
    });
  } catch (error) {
    console.error('Error processing system metrics:', error);
    await addLog('error', `System metrics processing error: ${error.message}`);
    res.status(500).json({ error: 'Failed to process system metrics' });
  }
});

// Verify Payment with Amount Validation
app.post('/verify-payment', async (req, res) => {
  const { razorpay_payment_id, razorpay_order_id, razorpay_signature } = req.body;
  
  // Validate the signature
  const generated_signature = crypto
    .createHmac('sha256', process.env.RAZORPAY_KEY_SECRET)
    .update(`${systemState.currentOrderId}|${razorpay_payment_id}`)
    .digest('hex');

  if (generated_signature !== razorpay_signature) {
    await addLog('error', 'Payment verification failed: Signature mismatch');
    return res.status(400).json({ status: 'failed', error: 'Invalid payment signature' });
  }

  try {
    // Fetch payment details from Razorpay to verify the amount
    const paymentDetails = await razorpay.payments.fetch(razorpay_payment_id);
    
    // Check if the payment amount matches the expected amount (530 paise = ₹5.30)
    const expectedAmount = 530;
    if (paymentDetails.amount < expectedAmount) {
      await addLog('error', `Payment amount verification failed: Expected ₹${expectedAmount/100} but received ₹${paymentDetails.amount/100}`);
      return res.status(400).json({ 
        status: 'failed', 
        error: 'Payment amount does not match the expected amount' 
      });
    }
    
    // Payment verified and amount matches - update system state
    systemState.currentPaymentId = razorpay_payment_id;
    await updateSystemState({
      payment_status: 'success',
      dispensing: true,
      transaction_completed: true
    });
    
    await pool.execute(
      'UPDATE payments SET payment_id = ?, status = ?, amount_paid = ? WHERE order_id = ?',
      [razorpay_payment_id, 'success', paymentDetails.amount, systemState.currentOrderId]
    );
    
    await addLog('payment', `Payment verified: ${razorpay_payment_id}, Amount: ₹${paymentDetails.amount/100}`);
    res.json({ status: 'success' });
  } catch (error) {
    console.error('Payment verification error:', error);
    await addLog('error', `Payment verification error: ${error.message}`);
    res.status(500).json({ status: 'failed', error: 'Payment verification process failed' });
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
// Add this route for the refund in progress page
app.get('/refund-in-progress', async (req, res) => {
  try {
    const state = await getSystemState();
    
    // Check if the system is in a refunded state
    if (state.payment_status === 'refunded') {
      res.render('refund_in_progress', {
        padCount: state.pad_count
      });
    } else {
      // If not in refund state, redirect to payment
      res.redirect('/payment');
    }
  } catch (error) {
    console.error('Error rendering refund in progress page:', error);
    await addLog('error', `Refund in progress page error: ${error.message}`);
    res.status(500).send('Internal Server Error');
  }
});

// Modify the refund endpoint to redirect to refund-in-progress page
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
    // Update state to refunded before processing
    await updateSystemState({
      payment_status: 'refunded'
    });

    const refund = await razorpay.payments.refund(paymentId);
    console.log('Refund successful:', refund);
    await addLog('refund', `Refund processed for Payment ID: ${paymentId} with reason: ${reason}`);

    // Return a success response that includes a redirect to refund-in-progress page
    res.json({ 
      success: true, 
      message: 'Refund processed successfully', 
      redirectUrl: '/refund-in-progress' 
    });

    // Rest of the existing refund processing code remains the same...
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

// Add this route to handle Wi-Fi status reports from the ESP8266
app.post('/inactiveduetowifi', async (req, res) => {
  const { status, authCode } = req.body;
  
  // Validate auth code
  if (authCode !== process.env.AUTH_CODE) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  
  try {
    // Log the Wi-Fi status update
    await addLog('wifi', `Wi-Fi status update: ${status}`);
    
    // If Wi-Fi is disconnected, update system state to inactive
    if (status === 'disconnected') {
      const inactiveDate = new Date(Date.now()).toISOString().slice(0, 19).replace('T', ' ');
      await updateSystemState({
        payment_status: 'inactive',
        inactive_since: inactiveDate
      });
      
      await addLog('state', 'System marked inactive due to Wi-Fi disconnection');
      
      // Send notification email if Wi-Fi has been disconnected
      const mailOptions = {
        from: process.env.EMAIL_USER,
        to: process.env.NOTIFICATION_EMAIL,
        subject: 'Alert: Wi-Fi Disconnected on Pad Dispenser',
        text: `The pad dispenser has reported a Wi-Fi disconnection at ${inactiveDate}. The system has been marked as inactive.`
      };
      
      transporter.sendMail(mailOptions, (err, info) => {
        if (err) {
          console.error('Error sending Wi-Fi disconnection email:', err);
          addLog('error', `Wi-Fi disconnection email error: ${err.message}`);
        } else {
          console.log('Wi-Fi disconnection email sent:', info.response);
          addLog('notification', 'Wi-Fi disconnection email sent');
        }
      });
    } 
    // If Wi-Fi is reconnected, update system state to ready
    else if (status === 'connected') {
      // Only update if system was previously inactive due to Wi-Fi
      const currentState = await getSystemState();
      if (currentState.payment_status === 'inactive') {
        await updateSystemState({
          payment_status: 'ready',
          inactive_since: null
        });
        await addLog('state', 'System restored to ready state after Wi-Fi reconnection');
      }
    }
    
    res.json({ success: true, message: `Wi-Fi status updated: ${status}` });
  } catch (error) {
    console.error('Error handling Wi-Fi status update:', error);
    await addLog('error', `Wi-Fi status update error: ${error.message}`);
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

// Function to send email
async function sendEmail(subject, message) {
  return new Promise((resolve, reject) => {
    const mailOptions = {
      from: process.env.EMAIL_USER,
      to: process.env.NOTIFICATION_EMAIL,
      subject: subject,
      text: message,
    };

    transporter.sendMail(mailOptions, async (err, info) => {
      if (err) {
        console.error('Error sending email:', err);
        await addLog('error', `Email send error: ${err.message}`);
        reject(err);
      } else {
        console.log('Email sent:', info.response);
        await addLog('notification', `Email sent: ${subject}`);
        resolve(info);
      }
    });
  });
}

// Comprehensive system status check
async function checkSystemStatusAndNotify() {
  try {
    // Fetch system state directly from database
    const [stateRows] = await pool.execute(
      'SELECT * FROM system_state WHERE id = 1'
    );

    if (stateRows.length === 0) {
      throw new Error('No system state found');
    }

    const systemState = stateRows[0];
    const now = new Date();

    // Prepare email notifications
    const emailNotifications = [];

    // 1. Check Offline Status
    if (systemState.payment_status === 'inactive' && systemState.inactive_since) {
      const inactiveSince = new Date(systemState.inactive_since);
      const offlineDuration = now - inactiveSince;

      if (offlineDuration >= MONITORING_CONFIG.MAX_OFFLINE_DURATION) {
        emailNotifications.push({
          subject: 'System Offline Alert',
          message: `System has been offline since ${inactiveSince.toISOString()}.
Current Status: ${systemState.payment_status}
Inactive Duration: ${Math.floor(offlineDuration / 60000)} minutes`
        });
      }
    }

    // 2. Check Pad Count
    const padCount = systemState.pad_count;
    if (padCount <= 0) {
      emailNotifications.push({
        subject: 'CRITICAL: No Pads Left',
        message: 'The system has run out of pads. Please refill immediately.'
      });
    } else if (padCount <= MONITORING_CONFIG.MIN_PAD_COUNT) {
      emailNotifications.push({
        subject: 'Low Pad Count Alert',
        message: `Pad count is low. 
Current Pad Count: ${padCount}
Minimum Threshold: ${MONITORING_CONFIG.MIN_PAD_COUNT}
Please refill soon.`
      });
    }

    // 3. Check Recent Payment Failures (last 24 hours)
    const [failedPayments] = await pool.execute(`
      SELECT COUNT(*) as failedCount 
      FROM payments 
      WHERE status = 'failed' 
      AND created_at >= DATE_SUB(NOW(), INTERVAL 24 HOUR)
    `);

    if (failedPayments[0].failedCount > 3) {
      emailNotifications.push({
        subject: 'Multiple Payment Failures Detected',
        message: `${failedPayments[0].failedCount} payment failures detected in the last 24 hours.
Please investigate potential system or payment gateway issues.`
      });
    }

    // Send emails for all notifications
    for (const notification of emailNotifications) {
      try {
        await sendEmail(notification.subject, notification.message);
      } catch (emailError) {
        console.error('Failed to send email:', emailError);
      }
    }

    // Log the monitoring check
    await addLog('monitoring', `System status check completed. Pad Count: ${padCount}, Status: ${systemState.payment_status}`);

  } catch (error) {
    console.error('System monitoring error:', error);
    
    // Send error notification email
    try {
      await sendEmail(
        'System Monitoring Error', 
        `An error occurred during system monitoring:
${error.message}

Please investigate the monitoring system and database connection.`
      );
    } catch (emailError) {
      console.error('Failed to send error notification email:', emailError);
    }
  }
}

// Set up periodic system monitoring
function setupSystemMonitoring() {
  // Check system status every 30 minutes
  cron.schedule(MONITORING_CONFIG.NOTIFICATION_INTERVAL, () => {
    checkSystemStatusAndNotify();
  });

  console.log('System monitoring initialized');
}

// Initialize monitoring when the script starts
setupSystemMonitoring();

module.exports = {
  checkSystemStatusAndNotify,
  setupSystemMonitoring
};

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