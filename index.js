require('dotenv').config();
const express = require('express');
const cors = require('cors');
const multer = require('multer');
const crypto = require('crypto');
const Razorpay = require('razorpay');
const nodemailer = require('nodemailer');
const { google } = require('googleapis');
const { Readable } = require('stream');
//const credentials = require('./cred/Student.json');
const credentials = JSON.parse(process.env.GOOGLE_CREDENTIALS); // ✅ Works with Render env var



const app = express();
app.use(cors());
app.use(express.json());
const upload = multer({ storage: multer.memoryStorage() });

const SHEET_ID = '1o96plm64lrlSJlRG3vEF2xYnvnXMVYjfGrVOhFcAuhk';
const DRIVE_FOLDER_ID = '1I_vStm-truGPJwqFCaFRKsL68__JwiQL';

const auth = new google.auth.GoogleAuth({
  credentials,
  scopes: ['https://www.googleapis.com/auth/spreadsheets', 'https://www.googleapis.com/auth/drive'],
});

const razorpay = new Razorpay({
  key_id: process.env.RAZORPAY_KEY_ID,
  key_secret: process.env.RAZORPAY_SECRET,
});

const transporter = nodemailer.createTransport({
  host: 'smtp.zoho.in',
  port: 465,
  secure: true,
  auth: {
    user: process.env.ZOHO_EMAIL,
    pass: process.env.ZOHO_APP_PASSWORD,
  },
});

// ✅ Safe Log Endpoint (works even if name/email not provided)
app.post('/log', async (req, res) => {
  const { name, email } = req.body;

  if (!name || !email) {
    return res.status(200).send({ status: 'skipped', message: 'Missing name or email' });
  }

  try {
    const client = await auth.getClient();
    const sheets = google.sheets({ version: 'v4', auth: client });

    await sheets.spreadsheets.values.append({
      spreadsheetId: SHEET_ID,
      range: 'user_log!A:C',
      valueInputOption: 'RAW',
      requestBody: {
        values: [[new Date().toISOString(), name, email]],
      },
    });

    res.status(200).send({ status: 'success' });
  } catch (err) {
    res.status(500).send({ error: 'Failed to log' });
  }
});

// ✅ Razorpay Order
app.post('/create-order', async (req, res) => {
  const { amount } = req.body;
  try {
    const order = await razorpay.orders.create({
      amount: amount * 100,
      currency: 'INR',
      receipt: `rcpt_${Date.now()}`
    });
    res.status(200).json(order);
  } catch (err) {
    res.status(500).json({ error: 'Unable to create order' });
  }
});

// ✅ Payment Verification
app.post('/verify', async (req, res) => {
  const {
    name, email, phone, position, duration,
    enrollmentId, order_id, payment_id, signature, userEmail
  } = req.body;

  const expectedSignature = crypto
    .createHmac('sha256', process.env.RAZORPAY_SECRET)
    .update(`${order_id}|${payment_id}`)
    .digest('hex');

  if (expectedSignature !== signature) {
    return res.status(400).json({ status: 'error', message: 'Invalid signature' });
  }

  try {
    const client = await auth.getClient();
    const sheets = google.sheets({ version: 'v4', auth: client });

    const screeningRes = await sheets.spreadsheets.values.get({
      spreadsheetId: SHEET_ID,
      range: 'screening!A2:J',
    });

    const rows = screeningRes.data.values;
    const match = rows.find(row => row[6] === enrollmentId);
    const resumeLink = match ? match[7] : 'N/A';

    await sheets.spreadsheets.values.append({
      spreadsheetId: SHEET_ID,
      range: 'Enrollments!A:J',
      valueInputOption: 'RAW',
      requestBody: {
        values: [[
          new Date().toISOString(),
          name, email, phone, position, duration,
          payment_id,
          resumeLink,
          enrollmentId,
          userEmail || email
        ]]
      }
    });

    await transporter.sendMail({
      from: `AgentPi <${process.env.ZOHO_EMAIL}>`,
      to: email,
      cc: ['hr@agentpi.in', 'rohit.rajbhar@agentpi.in'],
      subject: '🎉 Payment Received - AgentPi Internship',
      html: `
        <h3>Hi ${name},</h3>
        <p>✅ Your payment has been successfully received for the <strong>${position}</strong> internship.</p>
        <p>🔑 Enrollment ID: ${enrollmentId}</p>
        <p>💳 Payment ID: ${payment_id}</p>
        <p>🕐 Our HR team will reach out to you shortly with the next steps.</p>
        <br><p>Regards,<br><strong>AgentPi Team</strong></p>
      `,
    });

    return res.status(200).json({ status: 'success' });
  } catch (err) {
    console.error('❌ Error in /verify:', err);
    res.status(500).json({ status: 'error', message: err.message });
  }
});

// ✅ Screening Form
app.post('/screening', upload.single('resume'), async (req, res) => {
  const { name, email, phone, position, duration, userEmail } = req.body;
  const resumeFile = req.file;

  if (!resumeFile) return res.status(400).json({ status: 'error', message: 'Resume missing' });

  try {
    const client = await auth.getClient();
    const sheets = google.sheets({ version: 'v4', auth: client });
    const drive = google.drive({ version: 'v3', auth: client });

    const checkRes = await sheets.spreadsheets.values.get({
      spreadsheetId: SHEET_ID,
      range: 'screening!A2:J',
    });

    const rows = checkRes.data.values || [];
    const alreadySubmitted = rows.find(row => row[2]?.toLowerCase() === email.toLowerCase());

    if (alreadySubmitted) return res.json({ status: 'duplicate' });

    const enrollmentId = 'AGP' + Date.now().toString().slice(-6);
    const stream = Readable.from(resumeFile.buffer);

    const uploadRes = await drive.files.create({
      requestBody: {
        name: `${name}_resume_${Date.now()}.pdf`,
        mimeType: resumeFile.mimetype,
        parents: [DRIVE_FOLDER_ID],
      },
      media: {
        mimeType: resumeFile.mimetype,
        body: stream,
      },
    });

    const fileId = uploadRes.data.id;
    await drive.permissions.create({ fileId, requestBody: { role: 'reader', type: 'anyone' } });

    const resumeLink = `https://drive.google.com/file/d/${fileId}/view?usp=sharing`;

    await sheets.spreadsheets.values.append({
      spreadsheetId: SHEET_ID,
      range: 'screening!A:J',
      valueInputOption: 'RAW',
      requestBody: {
        values: [[
          new Date().toISOString(),
          name, email, phone, position, duration,
          enrollmentId, resumeLink, '', userEmail || email
        ]]
      }
    });

    await transporter.sendMail({
      from: `AgentPi <${process.env.ZOHO_EMAIL}>`,
      to: email,
      cc: 'hr@agentpi.in',
      subject: '✅ Screening Submitted - AgentPi',
      html: `
        <p>Hi ${name},</p>
        <p>✅ Your screening for the <strong>${position}</strong> internship has been received.</p>
        <p>🔑 Your Enrollment ID: <strong>${enrollmentId}</strong></p>
        <p>📎 Resume: <a href="${resumeLink}" target="_blank">View Resume</a></p>
        <p>🕐 Our HR team will review your submission and contact you if you're selected.</p>
        <br><p>Regards,<br><strong>AgentPi Team</strong></p>
      `,
    });

    return res.status(200).json({ status: 'success', enrollmentId });
  } catch (err) {
    console.error('❌ Error in /screening:', err);
    res.status(500).json({ status: 'error', message: err.message });
  }
});

// ✅ Get all screenings for email
app.get('/all-screenings/:email', async (req, res) => {
  const email = req.params.email.toLowerCase();
  try {
    const client = await auth.getClient();
    const sheets = google.sheets({ version: 'v4', auth: client });

    const result = await sheets.spreadsheets.values.get({
      spreadsheetId: SHEET_ID,
      range: 'screening!A2:J',
    });

    const rows = result.data.values || [];
    const matches = rows.filter(row => row[9]?.toLowerCase() === email);

    if (matches.length > 0) {
      const data = matches.map(row => ({
        name: row[1],
        email: row[2],
        phone: row[3],
        position: row[4],
        duration: row[5],
        enrollmentId: row[6],
        resumeLink: row[7],
        status: row[8],
      }));
      return res.status(200).json({ status: 'found', data });
    }

    return res.status(404).json({ status: 'not_found' });
  } catch (err) {
    console.error('❌ Error in /all-screenings:', err);
    res.status(500).json({ status: 'error', message: err.message });
  }
});

// ✅ Check Enrollments by Email
app.get('/check-enrollment/:email', async (req, res) => {
  const email = decodeURIComponent(req.params.email).toLowerCase();
  try {
    const client = await auth.getClient();
    const sheets = google.sheets({ version: 'v4', auth: client });

    const response = await sheets.spreadsheets.values.get({
      spreadsheetId: SHEET_ID,
      range: 'Enrollments!A2:J',
    });

    const rows = response.data.values || [];
    const matches = rows.filter(row => row[9]?.toLowerCase() === email);

    if (matches.length > 0) {
      const enrollments = matches.map(row => ({
        date: row[0],
        name: row[1],
        email: row[2],
        phone: row[3],
        position: row[4],
        duration: row[5],
        paymentId: row[6],
        resumeLink: row[7],
        enrollmentId: row[8],
      }));
      return res.status(200).json({ status: 'enrolled', data: enrollments });
    }

    return res.status(404).json({ status: 'not_enrolled' });
  } catch (err) {
    console.error('❌ Error in /check-enrollment:', err);
    res.status(500).json({ status: 'error', message: err.message });
  }
});

// ✅ Get Student Details for Payment
app.get('/get-student/:id', async (req, res) => {
  const enrollmentId = req.params.id;

  try {
    const client = await auth.getClient();
    const sheets = google.sheets({ version: 'v4', auth: client });

    const response = await sheets.spreadsheets.values.get({
      spreadsheetId: SHEET_ID,
      range: 'screening!A2:J',
    });

    const rows = response.data.values;
    if (!rows || rows.length === 0) return res.status(404).json({ status: 'not_found' });

    const match = rows.find(row => row[6] === enrollmentId);
    if (!match) return res.status(404).json({ status: 'not_found' });

    const status = (match[8] || '').toLowerCase();
    if (status !== 'approved') return res.status(403).json({ status: 'not_approved' });

    return res.status(200).json({
      status: 'approved',
      data: {
        name: match[1],
        email: match[2],
        phone: match[3],
        position: match[4],
        duration: match[5],
        enrollmentId: match[6],
        resumeLink: match[7],
      }
    });

  } catch (err) {
    console.error('❌ Error in /get-student:', err);
    return res.status(500).json({ status: 'error', message: err.message });
  }
});

// ✅ Start Server
app.listen(5000, () => {
  console.log('✅ Backend server running at http://localhost:5000');
});
