/**
 * ╔══════════════════════════════════════════════════════════════════╗
 * ║  ZBC Round 2 — Google Apps Script Backend                       ║
 * ║                                                                  ║
 * ║  This script is called ONLY by the Node.js server (server.js).  ║
 * ║  Tokens are injected by the server from .env — they are never   ║
 * ║  visible in the browser or in the HTML files.                   ║
 * ╚══════════════════════════════════════════════════════════════════╝
 *
 * ── SETUP ──────────────────────────────────────────────────────────
 * 1. Create a new Google Sheet (any name you like).
 *    The script will auto-create a "Responses" tab with headers
 *    on the very first form submission — no manual setup needed.
 *
 * 2. In the sheet: Extensions → Apps Script
 *    Delete any starter code and paste this whole file. Save (Ctrl+S).
 *
 * 3. Set your tokens below — copy the same values into your .env:
 *      GAS_SUBMIT_TOKEN=...
 *      GAS_ADMIN_TOKEN=...
 *
 * 4. Deploy → New deployment
 *      Type: Web app · Execute as: Me · Who can access: Anyone
 *    Copy the Web App URL → paste into .env as GAS_URL=...
 *
 * 5. After every edit: Deploy → Manage deployments → pencil →
 *    Version: New version → Deploy.  URL stays the same.
 *
 * ── ACTIONS ────────────────────────────────────────────────────────
 * GET  ?action=checkEmail   &token=SUBMIT  &email=x@vitstudent.ac.in
 * GET  ?action=getSlots     &token=SUBMIT
 * GET  ?action=getResponses &token=ADMIN
 * POST body JSON { token:SUBMIT, fullName, regNo, email, dept, slotId, slotLabel }
 * POST body JSON { token:ADMIN,  action:'deleteResponse', email }
 */

// ── Tokens — change both before deploying ──────────────────────────
var SUBMIT_TOKEN = 'CHANGE_ME_SUBMIT_TOKEN_MIN_32_CHARS';
var ADMIN_TOKEN  = 'CHANGE_ME_ADMIN_TOKEN_MIN_32_CHARS';

// ── Sheet config ────────────────────────────────────────────────────
var SHEET_NAME = 'Responses';
var COL = {
  TIMESTAMP : 1,
  FULL_NAME : 2,
  REG_NO    : 3,
  EMAIL     : 4,
  DEPT      : 5,
  SLOT_ID   : 6,
  SLOT_LABEL: 7
};

// ── Helpers ─────────────────────────────────────────────────────────

function jsonOut(obj) {
  return ContentService
    .createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

function errOut(msg) {
  return jsonOut({ ok: false, error: msg });
}

function getSheet() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sh = ss.getSheetByName(SHEET_NAME);
  if (!sh) {
    sh = ss.insertSheet(SHEET_NAME);
    sh.getRange(1, 1, 1, 7).setValues([[
      'Timestamp', 'Full Name', 'Registration Number',
      'Email', 'Department', 'Slot ID', 'Slot Label'
    ]]);
    sh.setFrozenRows(1);
    sh.getRange(1, 1, 1, 7)
      .setFontWeight('bold')
      .setBackground('#673ab7')
      .setFontColor('#ffffff');
  }
  return sh;
}

function sanitizeEmail(email) {
  return String(email).toLowerCase().trim();
}

/** Constant-time comparison — prevents timing-based token guessing */
function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  if (a.length !== b.length) return false;
  var result = 0;
  for (var i = 0; i < a.length; i++) {
    result |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return result === 0;
}

function isValidEmail(email) {
  return /^[a-z0-9._%+\-]+@vitstudent\.ac\.in$/.test(email);
}

function isValidSlotId(id) {
  return /^\d{4}-\d{2}-\d{2}_\d{4}$/.test(id);
}

function isStr(val, min, max) {
  return typeof val === 'string' &&
         val.trim().length >= (min || 1) &&
         val.length <= (max || 500);
}

// ═══════════════════════════════════════════════════════════════════
//  doGet — read-only queries
// ═══════════════════════════════════════════════════════════════════
function doGet(e) {
  var p      = e.parameter;
  var action = p.action || '';
  var token  = p.token  || '';

  // ── checkEmail ───────────────────────────────────────────────────
  if (action === 'checkEmail') {
    if (!safeEqual(token, SUBMIT_TOKEN)) return errOut('Unauthorized');
    var email = sanitizeEmail(p.email || '');
    if (!isValidEmail(email)) return errOut('Invalid email');

    var sheet   = getSheet();
    var lastRow = sheet.getLastRow();
    if (lastRow <= 1) return jsonOut({ ok: true, taken: false });
    var data = sheet.getRange(2, COL.EMAIL, lastRow - 1, 1).getValues();
    for (var i = 0; i < data.length; i++) {
      if (sanitizeEmail(String(data[i][0])) === email) {
        return jsonOut({ ok: true, taken: true });
      }
    }
    return jsonOut({ ok: true, taken: false });
  }

  // ── getSlots ─────────────────────────────────────────────────────
  if (action === 'getSlots') {
    if (!safeEqual(token, SUBMIT_TOKEN)) return errOut('Unauthorized');
    var sheet   = getSheet();
    var lastRow = sheet.getLastRow();
    if (lastRow <= 1) return jsonOut({ ok: true, slots: {} });
    var data    = sheet.getRange(2, 1, lastRow - 1, 7).getValues();
    var slotMap = {};
    for (var i = 0; i < data.length; i++) {
      var sid = String(data[i][COL.SLOT_ID - 1]).trim();
      if (sid) slotMap[sid] = String(data[i][COL.EMAIL - 1]).trim();
    }
    return jsonOut({ ok: true, slots: slotMap });
  }

  // ── getResponses ─────────────────────────────────────────────────
  if (action === 'getResponses') {
    if (!safeEqual(token, ADMIN_TOKEN)) return errOut('Unauthorized');
    var sheet   = getSheet();
    var lastRow = sheet.getLastRow();
    if (lastRow <= 1) return jsonOut({ ok: true, responses: [] });
    var data = sheet.getRange(2, 1, lastRow - 1, 7).getValues();
    var rows = [];
    for (var i = 0; i < data.length; i++) {
      if (!data[i][COL.EMAIL - 1]) continue;
      rows.push({
        timestamp : String(data[i][COL.TIMESTAMP  - 1]),
        fullName  : String(data[i][COL.FULL_NAME  - 1]),
        regNo     : String(data[i][COL.REG_NO     - 1]),
        email     : String(data[i][COL.EMAIL      - 1]),
        dept      : String(data[i][COL.DEPT       - 1]),
        slotId    : String(data[i][COL.SLOT_ID    - 1]),
        slotLabel : String(data[i][COL.SLOT_LABEL - 1])
      });
    }
    return jsonOut({ ok: true, responses: rows });
  }

  return errOut('Unknown action');
}

// ═══════════════════════════════════════════════════════════════════
//  doPost — form submission AND admin delete
//  Submit:  { token:SUBMIT, fullName, regNo, email, dept, slotId, slotLabel }
//  Delete:  { token:ADMIN,  action:'deleteResponse', email }
// ═══════════════════════════════════════════════════════════════════
function doPost(e) {
  var data;
  try { data = JSON.parse(e.postData.contents); }
  catch (ex) { return errOut('Invalid JSON'); }

  // ── deleteResponse (admin only) ──────────────────────────────────
  if (data.action === 'deleteResponse') {
    if (!safeEqual(data.token || '', ADMIN_TOKEN)) return errOut('Unauthorized');
    var email = sanitizeEmail(data.email || '');
    if (!isValidEmail(email)) return errOut('Invalid email');

    var sheet   = getSheet();
    var lastRow = sheet.getLastRow();
    if (lastRow <= 1) return jsonOut({ ok: false, error: 'not_found' });

    var rows = sheet.getRange(2, 1, lastRow - 1, 7).getValues();
    for (var i = 0; i < rows.length; i++) {
      if (sanitizeEmail(String(rows[i][COL.EMAIL - 1])) === email) {
        // +2 because: +1 for 1-based index, +1 for header row
        sheet.deleteRow(i + 2);
        return jsonOut({ ok: true, deleted: email });
      }
    }
    return jsonOut({ ok: false, error: 'not_found' });
  }

  // ── submit (public) ──────────────────────────────────────────────
  if (!safeEqual(data.token || '', SUBMIT_TOKEN)) return errOut('Unauthorized');

  var email = sanitizeEmail(data.email || '');
  if (!isStr(data.fullName, 2, 200))  return errOut('Invalid fullName');
  if (!isStr(data.regNo,    2, 50))   return errOut('Invalid regNo');
  if (!isValidEmail(email))           return errOut('Invalid email');
  if (!isStr(data.dept,     1, 50))   return errOut('Invalid dept');
  if (!isValidSlotId(data.slotId))    return errOut('Invalid slotId');
  if (!isStr(data.slotLabel, 2, 200)) return errOut('Invalid slotLabel');

  var sheet   = getSheet();
  var lastRow = sheet.getLastRow();

  if (lastRow > 1) {
    var existing = sheet.getRange(2, 1, lastRow - 1, 7).getValues();

    for (var i = 0; i < existing.length; i++) {
      if (sanitizeEmail(String(existing[i][COL.EMAIL - 1])) === email) {
        return jsonOut({ ok: false, error: 'duplicate_email' });
      }
    }
    for (var i = 0; i < existing.length; i++) {
      if (String(existing[i][COL.SLOT_ID - 1]).trim() === data.slotId) {
        return jsonOut({ ok: false, error: 'slot_taken' });
      }
    }
  }

  sheet.appendRow([
    new Date().toISOString(),
    data.fullName.trim(),
    data.regNo.trim(),
    email,
    data.dept.trim(),
    data.slotId,
    data.slotLabel.trim()
  ]);

  var newLastRow = sheet.getLastRow();
  if (newLastRow % 2 === 0) {
    sheet.getRange(newLastRow, 1, 1, 7).setBackground('#f8f9fa');
  }

  return jsonOut({ ok: true });
}
