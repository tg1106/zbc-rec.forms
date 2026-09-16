'use strict';

require('dotenv').config();

const express      = require('express');
const session      = require('express-session');
const helmet       = require('helmet');
const rateLimit    = require('express-rate-limit');
const crypto       = require('crypto');
const path         = require('path');
const axios        = require('axios');

/* ═══════════════════════════════════════════════════════════════
   STARTUP VALIDATION
   Crash early with a clear message if .env is incomplete.
═══════════════════════════════════════════════════════════════ */
const REQUIRED_ENV = [
  'SESSION_SECRET',
  'GAS_URL',
  'GAS_SUBMIT_TOKEN',
  'GAS_ADMIN_TOKEN',
  'ADMIN_PASSWORD',
];
const missing = REQUIRED_ENV.filter((k) => !process.env[k] || process.env[k].startsWith('CHANGE_ME'));
if (missing.length) {
  console.error('\n[FATAL] Missing or unconfigured .env variables:', missing.join(', '));
  console.error('Current values:', missing.map(k => k + '=' + (process.env[k] ? '"'+process.env[k].slice(0,10)+'..."' : 'undefined')).join(', '));
  console.error('Copy .env.example → .env and fill in every value.\n');
  process.exit(1);
}

const GAS_URL          = process.env.GAS_URL;
const GAS_SUBMIT_TOKEN = process.env.GAS_SUBMIT_TOKEN;
const GAS_ADMIN_TOKEN  = process.env.GAS_ADMIN_TOKEN;
const PORT             = parseInt(process.env.PORT, 10) || 3000;
const IS_PROD          = process.env.NODE_ENV === 'production';

/* Pre-compute the SHA-256 hash of the admin password at startup.
   The plaintext never leaves the server after this point.        */
const ADMIN_HASH = crypto
  .createHash('sha256')
  .update(process.env.ADMIN_PASSWORD)
  .digest('hex');

/* ═══════════════════════════════════════════════════════════════
   EXPRESS SETUP
═══════════════════════════════════════════════════════════════ */
const app = express();

/* ── Trust proxy — required on Railway/Render/Heroku (sit behind nginx)
   Without this, express-rate-limit throws ERR_ERL_UNEXPECTED_X_FORWARDED_FOR
   and sessions don't get secure cookies correctly.                        ── */
app.set('trust proxy', 1);

/* ── Security headers (helmet) ── */
app.use(
  helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc:  ["'self'"],
        scriptSrc:   ["'self'", "'unsafe-inline'"],
        styleSrc:    ["'self'", "'unsafe-inline'", 'fonts.googleapis.com', 'fonts.gstatic.com'],
        fontSrc:     ["'self'", 'fonts.gstatic.com'],
        imgSrc:      ["'self'", 'data:'],
        connectSrc:  ["'self'"],
        frameSrc:    ["'none'"],
        objectSrc:   ["'none'"],
        // Only upgrade insecure requests in production (HTTPS)
        // In development (HTTP) this breaks all fetch() calls
        ...(IS_PROD ? { upgradeInsecureRequests: [] } : { upgradeInsecureRequests: null }),
      },
      // Don't add upgrade-insecure-requests automatically
      useDefaults: false,
    },
    crossOriginEmbedderPolicy: false,
  })
);

/* ── Body parsing ── */
app.use(express.json({ limit: '16kb' }));
app.use(express.urlencoded({ extended: false, limit: '16kb' }));

/* ── Session ── */
app.use(
  session({
    secret:            process.env.SESSION_SECRET,
    resave:            false,
    saveUninitialized: false,
    cookie: {
      httpOnly: true,
      secure:   IS_PROD,   // HTTPS-only in production
      sameSite: 'lax',
      maxAge:   4 * 60 * 60 * 1000, // 4 hours
    },
    name: 'zbcsid',        // don't leak default 'connect.sid' name
  })
);

/* ── Static assets (SheetJS shipped from node_modules) ── */
app.use('/static', express.static(path.join(__dirname, 'public')));

/* ── Views ── */
const VIEWS = path.join(__dirname, 'views');

/* ═══════════════════════════════════════════════════════════════
   RATE LIMITERS
═══════════════════════════════════════════════════════════════ */

/* General API: 60 req / 1 min per IP */
const apiLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
  message: { ok: false, error: 'Too many requests. Please slow down.' },
});

/* Submit endpoint: 3 submissions / 10 min per IP (prevents spam) */
const submitLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  max: 3,
  standardHeaders: true,
  legacyHeaders: false,
  message: { ok: false, error: 'Too many submissions from this IP. Try again later.' },
});

/* Login endpoint: 10 attempts / 15 min per IP */
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { ok: false, error: 'Too many login attempts. Try again later.' },
});

/* ═══════════════════════════════════════════════════════════════
   HELPERS
═══════════════════════════════════════════════════════════════ */

/* Constant-time string comparison — prevents timing attacks */
function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  if (a.length !== b.length) {
    // Still do a dummy comparison to keep timing consistent
    crypto.timingSafeEqual(Buffer.alloc(1), Buffer.alloc(1));
    return false;
  }
  return crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));
}

/* Auth middleware — protects /admin routes */
function requireAuth(req, res, next) {
  if (req.session && req.session.adminAuthed) return next();
  return res.status(401).json({ ok: false, error: 'Not authenticated' });
}

/* ── GAS HTTP client using axios ──────────────────────────────────
   axios handles GAS's cross-domain redirects (302 → googleusercontent)
   correctly on all platforms including Railway.
   Timeout: 30 s to account for GAS cold-start + script execution.  */
const gasClient = axios.create({
  timeout:          30000,
  maxRedirects:     5,
  validateStatus:   () => true,   // handle all status codes ourselves
});

async function gasGet(params) {
  const res = await gasClient.get(GAS_URL, { params });
  if (res.status !== 200) throw new Error(`GAS GET responded ${res.status}`);
  if (!res.data || typeof res.data !== 'object') {
    throw new Error('Invalid JSON from GAS: ' + String(res.data).slice(0, 100));
  }
  return res.data;
}

async function gasPost(body) {
  // text/plain avoids CORS preflight; GAS accepts it fine
  const res = await gasClient.post(GAS_URL, JSON.stringify(body), {
    headers: { 'Content-Type': 'text/plain;charset=utf-8' },
  });
  if (res.status !== 200) throw new Error(`GAS POST responded ${res.status}`);
  if (!res.data || typeof res.data !== 'object') {
    throw new Error('Invalid JSON from GAS: ' + String(res.data).slice(0, 100));
  }
  return res.data;
}

/* Input validators */
const EMAIL_RE  = /^[a-z0-9._%+\-]+@vitstudent\.ac\.in$/i;
const SLOT_RE   = /^\d{4}-\d{2}-\d{2}_\d{4}$/;

function validateSubmission(body) {
  const errors = [];
  if (!body.fullName  || typeof body.fullName  !== 'string' || body.fullName.trim().length   < 2)   errors.push('fullName');
  if (!body.regNo     || typeof body.regNo     !== 'string' || body.regNo.trim().length       < 4)   errors.push('regNo');
  if (!body.email     || !EMAIL_RE.test(body.email.trim()))                                          errors.push('email');
  if (!body.dept      || !['HR','Design','Events','Outreach'].includes(body.dept))                   errors.push('dept');
  if (!body.slotId    || !SLOT_RE.test(body.slotId))                                                 errors.push('slotId');
  if (!body.slotLabel || typeof body.slotLabel !== 'string' || body.slotLabel.trim().length   < 2)   errors.push('slotLabel');
  return errors;
}

/* ═══════════════════════════════════════════════════════════════
   PAGE ROUTES
═══════════════════════════════════════════════════════════════ */

/* Public form */
app.get('/', (req, res) => {
  res.sendFile(path.join(VIEWS, 'index.html'));
});

/* Admin dashboard — serves the HTML shell; actual data loaded via API */
app.get('/admin', (req, res) => {
  res.sendFile(path.join(VIEWS, 'admin.html'));
});

/* ═══════════════════════════════════════════════════════════════
   PUBLIC API  (/api/*)
   Tokens stay on the server — the browser never sees them.
═══════════════════════════════════════════════════════════════ */
app.use('/api', apiLimiter);

/* GET /api/slots
   Returns { ok, slots: { slotId: email } } */
app.get('/api/slots', async (req, res) => {
  try {
    const data = await gasGet({ action: 'getSlots', token: GAS_SUBMIT_TOKEN });
    return res.json(data);
  } catch (err) {
    console.error('[/api/slots]', err.message);
    return res.status(502).json({ ok: false, error: 'Could not fetch slots. Try again.' });
  }
});

/* GET /api/check-email?email=x@vitstudent.ac.in
   Returns { ok, taken: bool } */
app.get('/api/check-email', async (req, res) => {
  const email = (req.query.email || '').trim().toLowerCase();
  if (!EMAIL_RE.test(email)) {
    return res.status(400).json({ ok: false, error: 'Invalid email format.' });
  }
  try {
    const data = await gasGet({ action: 'checkEmail', token: GAS_SUBMIT_TOKEN, email });
    return res.json(data);
  } catch (err) {
    console.error('[/api/check-email]', err.message);
    return res.status(502).json({ ok: false, error: 'Could not verify email. Try again.' });
  }
});

/* POST /api/submit
   Body: { fullName, regNo, email, dept, slotId, slotLabel }
   Returns { ok } or { ok: false, error } */
app.post('/api/submit', submitLimiter, async (req, res) => {
  const errors = validateSubmission(req.body);
  if (errors.length) {
    return res.status(400).json({ ok: false, error: 'Invalid fields: ' + errors.join(', ') });
  }

  const payload = {
    token    : GAS_SUBMIT_TOKEN,       // injected server-side
    fullName : req.body.fullName.trim(),
    regNo    : req.body.regNo.trim(),
    email    : req.body.email.trim().toLowerCase(),
    dept     : req.body.dept,
    slotId   : req.body.slotId,
    slotLabel: req.body.slotLabel.trim(),
  };

  try {
    const data = await gasPost(payload);
    return res.json(data);
  } catch (err) {
    console.error('[/api/submit]', err.message);
    return res.status(502).json({ ok: false, error: 'Submission failed. Please try again.' });
  }
});

/* ═══════════════════════════════════════════════════════════════
   ADMIN API  (/api/admin/*)
   All routes require a valid session except /login.
═══════════════════════════════════════════════════════════════ */

/* POST /api/admin/login
   Body: { password }
   Sets session on success. */
app.post('/api/admin/login', loginLimiter, (req, res) => {
  const password = (req.body.password || '').toString();
  if (!password) {
    return res.status(400).json({ ok: false, error: 'Password required.' });
  }

  /* Hash the submitted password and compare with the pre-computed hash */
  const submittedHash = crypto.createHash('sha256').update(password).digest('hex');

  if (!safeEqual(submittedHash, ADMIN_HASH)) {
    return res.status(401).json({ ok: false, error: 'Incorrect password.' });
  }

  req.session.adminAuthed = true;
  req.session.loginTime   = Date.now();
  return res.json({ ok: true });
});

/* POST /api/admin/logout */
app.post('/api/admin/logout', (req, res) => {
  req.session.destroy(() => {
    res.clearCookie('zbcsid');
    return res.json({ ok: true });
  });
});

/* GET /api/admin/status — lets the frontend check if session is still alive */
app.get('/api/admin/status', requireAuth, (req, res) => {
  return res.json({ ok: true, authed: true });
});

/* GET /api/admin/responses
   Returns { ok, responses: [...] } — proxied from GAS with admin token */
app.get('/api/admin/responses', requireAuth, async (req, res) => {
  try {
    const data = await gasGet({ action: 'getResponses', token: GAS_ADMIN_TOKEN });
    return res.json(data);
  } catch (err) {
    console.error('[/api/admin/responses]', err.message);
    return res.status(502).json({ ok: false, error: 'Could not fetch responses. Try again.' });
  }
});

/* DELETE /api/admin/response
   Body: { email }
   Deletes the row from the Google Sheet by email.
   The slot automatically becomes available again since slots
   are derived live from the sheet on every getSlots call.    */
app.delete('/api/admin/response', requireAuth, async (req, res) => {
  const email = (req.body.email || '').trim().toLowerCase();
  if (!email || !/^[a-z0-9._%+\-]+@vitstudent\.ac\.in$/i.test(email)) {
    return res.status(400).json({ ok: false, error: 'Invalid email.' });
  }
  try {
    const data = await gasPost({
      action: 'deleteResponse',
      token:  GAS_ADMIN_TOKEN,
      email,
    });
    return res.json(data);
  } catch (err) {
    console.error('[DELETE /api/admin/response]', err.message);
    return res.status(502).json({ ok: false, error: 'Could not delete response. Try again.' });
  }
});

/* ═══════════════════════════════════════════════════════════════
   ERROR HANDLING
═══════════════════════════════════════════════════════════════ */
app.use((req, res) => {
  res.status(404).json({ ok: false, error: 'Not found.' });
});

// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  console.error('[Unhandled error]', err);
  res.status(500).json({ ok: false, error: 'Internal server error.' });
});

/* ═══════════════════════════════════════════════════════════════
   START
═══════════════════════════════════════════════════════════════ */
app.listen(PORT, () => {
  console.log(`\n  ZBC Form Server running`);
  console.log(`  Public form : http://localhost:${PORT}/`);
  console.log(`  Admin dash  : http://localhost:${PORT}/admin`);
  console.log(`  Environment : ${process.env.NODE_ENV || 'development'}\n`);
});
