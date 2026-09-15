/**
 * ╔══════════════════════════════════════════════════════════════════╗
 * ║  ZBC Round 2 — Google Apps Script Backend                       ║
 * ║  Handles: submit, email-check, slot-map, admin read             ║
 * ╚══════════════════════════════════════════════════════════════════╝
 *
 * SETUP (do this once):
 * ─────────────────────
 * 1. Create a new Google Sheet with these exact column headers in Row 1:
 *      Timestamp | Full Name | Registration Number | Email | Department | Slot ID | Slot Label
 *
 * 2. Open Extensions > Apps Script, paste this whole file, save.
 *
 * 3. Change the two secrets below:
 *      SUBMIT_TOKEN  — a long random string, paste the same into index.html
 *      ADMIN_TOKEN   — a different long random string, paste into admin.html
 *    Generate them at: https://randomkeygen.com  (use "Fort Knox Passwords")
 *
 * 4. Deploy > New deployment
 *      Type:         Web app
 *      Execute as:   Me
 *      Who can access: Anyone
 *    Click Deploy → copy the Web App URL.
 *    Paste that URL into SCRIPT_URL in both index.html and admin.html.
 *
 * 5. Every time you edit this file, do Deploy > Manage deployments >
 *    click the pencil on your deployment > Version: New version > Deploy.
 *    (The URL stays the same.)
 */

// ── Secrets ────────────────────────────────────────────────────────────────
// These act as API keys. Anyone with the URL but without the right token
// gets a 403 back. Change both before deploying.
var SUBMIT_TOKEN = 'CHANGE_ME_SUBMIT_TOKEN_MIN_32_CHARS';
var ADMIN_TOKEN  = 'CHANGE_ME_ADMIN_TOKEN_MIN_32_CHARS';

// ── Sheet config ────────────────────────────────────────────────────────────
var SHEET_NAME = 'Responses'; // name of the tab inside your spreadsheet

// Column positions (1-indexed) — must match the headers you created
var COL = {
  TIMESTAMP : 1,
  FULL_NAME : 2,
  REG_NO    : 3,
  EMAIL     : 4,
  DEPT      : 5,
  SLOT_ID   : 6,
  SLOT_LABEL: 7
};

// ── CORS helper ─────────────────────────────────────────────────────────────
function jsonResponse(obj, code) {
  var out = ContentService
    .createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
  return out;
}

function err(msg, code) {
  return jsonResponse({ ok: false, error: msg });
}

// ── Sheet accessor ──────────────────────────────────────────────────────────
function getSheet() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sh = ss.getSheetByName(SHEET_NAME);
  if (!sh) {
    // Auto-create the sheet with headers if it doesn't exist
    sh = ss.insertSheet(SHEET_NAME);
    sh.getRange(1, 1, 1, 7).setValues([[
      'Timestamp', 'Full Name', 'Registration Number',
      'Email', 'Department', 'Slot ID', 'Slot Label'
    ]]);
    sh.setFrozenRows(1);
    sh.getRange(1, 1, 1, 7).setFontWeight('bold');
  }
  return sh;
}

// ── Sanitise email to a consistent key ─────────────────────────────────────
function sanitizeEmail(email) {
  return email.toLowerCase().trim();
}

// ── Constant-time string comparison (avoids timing attacks) ────────────────
function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  if (a.length !== b.length) return false;
  var result = 0;
  for (var i = 0; i < a.length; i++) {
    result |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return result === 0;
}

// ── Input validation helpers ────────────────────────────────────────────────
function isValidEmail(email) {
  return typeof email === 'string' &&
         email.length < 200 &&
         /^[a-z0-9._%+\-]+@vitstudent\.ac\.in$/.test(email.toLowerCase().trim());
}

function isValidSlotId(slotId) {
  // Format: YYYY-MM-DD_HHMM  e.g. 2026-09-17_2000
  return typeof slotId === 'string' && /^\d{4}-\d{2}-\d{2}_\d{4}$/.test(slotId);
}

function isNonEmptyString(val, maxLen) {
  return typeof val === 'string' && val.trim().length > 0 && val.length <= (maxLen || 500);
}

// ═══════════════════════════════════════════════════════════════════════════
//  doGet — handles read-only queries
//  ?action=checkEmail&email=x@vitstudent.ac.in&token=SUBMIT_TOKEN
//  ?action=getSlots&token=SUBMIT_TOKEN
//  ?action=getResponses&token=ADMIN_TOKEN
// ═══════════════════════════════════════════════════════════════════════════
function doGet(e) {
  var params = e.parameter;
  var action = params.action || '';
  var token  = params.token  || '';

  // ── checkEmail ───────────────────────────────────────────────────────────
  if (action === 'checkEmail') {
    if (!safeEqual(token, SUBMIT_TOKEN)) return err('Unauthorized');
    var email = sanitizeEmail(params.email || '');
    if (!isValidEmail(email)) return err('Invalid email');

    var sheet = getSheet();
    var data  = sheet.getDataRange().getValues();
    for (var i = 1; i < data.length; i++) {
      if (sanitizeEmail(String(data[i][COL.EMAIL - 1])) === email) {
        return jsonResponse({ ok: true, taken: true });
      }
    }
    return jsonResponse({ ok: true, taken: false });
  }

  // ── getSlots ─────────────────────────────────────────────────────────────
  // Returns a map of { slotId: email } for taken slots
  if (action === 'getSlots') {
    if (!safeEqual(token, SUBMIT_TOKEN)) return err('Unauthorized');

    var sheet = getSheet();
    var data  = sheet.getDataRange().getValues();
    var slotMap = {};
    for (var i = 1; i < data.length; i++) {
      var slotId = String(data[i][COL.SLOT_ID - 1]).trim();
      var email  = String(data[i][COL.EMAIL  - 1]).trim();
      if (slotId) slotMap[slotId] = email;
    }
    return jsonResponse({ ok: true, slots: slotMap });
  }

  // ── getResponses (admin only) ─────────────────────────────────────────────
  if (action === 'getResponses') {
    if (!safeEqual(token, ADMIN_TOKEN)) return err('Unauthorized');

    var sheet = getSheet();
    var data  = sheet.getDataRange().getValues();
    var rows  = [];
    for (var i = 1; i < data.length; i++) {
      var row = data[i];
      if (!row[COL.EMAIL - 1]) continue; // skip blank rows
      rows.push({
        timestamp : String(row[COL.TIMESTAMP  - 1]),
        fullName  : String(row[COL.FULL_NAME  - 1]),
        regNo     : String(row[COL.REG_NO     - 1]),
        email     : String(row[COL.EMAIL      - 1]),
        dept      : String(row[COL.DEPT       - 1]),
        slotId    : String(row[COL.SLOT_ID    - 1]),
        slotLabel : String(row[COL.SLOT_LABEL - 1])
      });
    }
    return jsonResponse({ ok: true, responses: rows });
  }

  return err('Unknown action');
}

// ═══════════════════════════════════════════════════════════════════════════
//  doPost — handles form submission
//  Body (JSON): { token, fullName, regNo, email, dept, slotId, slotLabel }
// ═══════════════════════════════════════════════════════════════════════════
function doPost(e) {
  var data;
  try {
    data = JSON.parse(e.postData.contents);
  } catch (ex) {
    return err('Invalid JSON');
  }

  // ── Auth ─────────────────────────────────────────────────────────────────
  if (!safeEqual(data.token || '', SUBMIT_TOKEN)) return err('Unauthorized');

  // ── Validate every field ─────────────────────────────────────────────────
  var email = sanitizeEmail(data.email || '');
  if (!isNonEmptyString(data.fullName, 200))  return err('Invalid fullName');
  if (!isNonEmptyString(data.regNo,    50))   return err('Invalid regNo');
  if (!isValidEmail(email))                   return err('Invalid email');
  if (!isNonEmptyString(data.dept, 50))       return err('Invalid dept');
  if (!isValidSlotId(data.slotId))            return err('Invalid slotId');
  if (!isNonEmptyString(data.slotLabel, 200)) return err('Invalid slotLabel');

  var sheet = getSheet();
  var existing = sheet.getDataRange().getValues();

  // ── Duplicate email check ─────────────────────────────────────────────────
  for (var i = 1; i < existing.length; i++) {
    if (sanitizeEmail(String(existing[i][COL.EMAIL - 1])) === email) {
      return jsonResponse({ ok: false, error: 'duplicate_email' });
    }
  }

  // ── Slot already taken check ──────────────────────────────────────────────
  for (var i = 1; i < existing.length; i++) {
    if (String(existing[i][COL.SLOT_ID - 1]).trim() === data.slotId) {
      return jsonResponse({ ok: false, error: 'slot_taken' });
    }
  }

  // ── Write the row ─────────────────────────────────────────────────────────
  sheet.appendRow([
    new Date().toISOString(),
    data.fullName.trim(),
    data.regNo.trim(),
    email,
    data.dept.trim(),
    data.slotId,
    data.slotLabel.trim()
  ]);

  // ── Auto-format: freeze header, colour new row alternately ───────────────
  var lastRow = sheet.getLastRow();
  if (lastRow % 2 === 0) {
    sheet.getRange(lastRow, 1, 1, 7).setBackground('#f8f9fa');
  }

  return jsonResponse({ ok: true });
}
