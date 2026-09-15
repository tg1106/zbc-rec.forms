'use strict';

require('dotenv').config();

const express      = require('express');
const session      = require('express-session');
const helmet       = require('helmet');
const rateLimit    = require('express-rate-limit');
const crypto       = require('crypto');
const path         = require('path');
const https        = require('https');
const http         = require('http');
const { URL }      = require('url');

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

/* ── Native HTTP/HTTPS request helper ──
   Replaces node-fetch which hangs following GAS cross-domain redirects.
   Manually follows up to 5 redirects using Node's built-in https module. */
function httpsGet(urlStr, options = {}) {
  return new Promise((resolve, reject) => {
    let redirects = 0;

    function doRequest(currentUrl) {
      const parsed   = new URL(currentUrl);
      const lib      = parsed.protocol === 'https:' ? https : http;
      const reqOpts  = {
        hostname: parsed.hostname,
        port:     parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
        path:     parsed.pathname + parsed.search,
        method:   options.method || 'GET',
        headers:  Object.assign({ 'User-Agent': 'ZBC-Form-Server/1.0' }, options.headers || {}),
      };

      const req = lib.request(reqOpts, (res) => {
        // Follow redirects (301, 302, 303, 307, 308)
        if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) {
          if (++redirects > 5) return reject(new Error('Too many redirects'));
          // Resolve relative redirects
          const next = new URL(res.headers.location, currentUrl).toString();
          res.resume(); // discard body
          return doRequest(next);
        }

        let body = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => { body += chunk; });
        res.on('end', () => {
          if (res.statusCode < 200 || res.statusCode >= 300) {
            return reject(new Error(`HTTP ${res.statusCode}: ${body.slice(0, 200)}`));
          }
          try { resolve(JSON.parse(body)); }
          catch (e) { reject(new Error('Invalid JSON from GAS: ' + body.slice(0, 200))); }
        });
      });

      req.on('error', reject);
      req.setTimeout(15000, () => { req.destroy(new Error('GAS request timed out')); });

      if (options.body) req.write(options.body);
      req.end();
    }

    doRequest(urlStr);
  });
}

/* GAS GET proxy */
function gasGet(params) {
  const qs = new URLSearchParams(params).toString();
  return httpsGet(`${GAS_URL}?${qs}`);
}

/* GAS POST proxy */
function gasPost(body) {
  const payload = JSON.stringify(body);
  return httpsGet(GAS_URL, {
    method:  'POST',
    headers: {
      'Content-Type':   'text/plain;charset=utf-8',
      'Content-Length': Buffer.byteLength(payload),
    },
    body: payload,
  });
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
