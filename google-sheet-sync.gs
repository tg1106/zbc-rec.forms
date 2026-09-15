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
  * 3. Set your tokens below.
  *    Copy the same values into your .env file:
  *      GAS_SUBMIT_TOKEN=...
  *      GAS_ADMIN_TOKEN=...
  *    Generate strong tokens at: https://randomkeygen.com
  *    (use the "Fort Knox Passwords" section — aim for 40+ chars)
  *
  * 4. Deploy → New deployment
  *      Type          : Web app
  *      Execute as    : Me
  *      Who can access: Anyone
  *    Click Deploy → Authorize → copy the Web App URL.
  *    Paste it into your .env file:  GAS_URL=https://script.google.com/...
  *
  * 5. Every time you edit this file you must re-deploy:
  *    Deploy → Manage deployments → pencil icon → Version: New version → Deploy.
  *    The URL does NOT change between versions.
  *
  * ── TOKEN SECURITY MODEL ───────────────────────────────────────────
  * • SUBMIT_TOKEN  — used by the Node server for /api/slots,
  *                   /api/check-email, and /api/submit
  * • ADMIN_TOKEN   — used only for /api/admin/responses
  * Both tokens travel only between your Node server and Google's
  * servers (HTTPS). They are never sent to or stored in any browser.
  */

  // ── Change both tokens before deploying ────────────────────────────
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

  /** Constant-time string comparison — prevents timing-based token guessing */
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
    return typeof val === 'string' && val.trim().length >= (min||1) && val.length <= (max||500);
  }

  // ═══════════════════════════════════════════════════════════════════
  //  doGet
  //  ?action=checkEmail  &token=SUBMIT_TOKEN  &email=x@vitstudent.ac.in
  //  ?action=getSlots    &token=SUBMIT_TOKEN
  //  ?action=getResponses&token=ADMIN_TOKEN
  // ═══════════════════════════════════════════════════════════════════
  function doGet(e) {
    var p      = e.parameter;
    var action = p.action || '';
    var token  = p.token  || '';

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

    if (action === 'getResponses') {
      if (!safeEqual(token, ADMIN_TOKEN)) return errOut('Unauthorized');
      var sheet    = getSheet();
      var lastRow  = sheet.getLastRow();
      // Only 1 row means just the header — return empty immediately
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
  //  doPost — form submission
  //  Body JSON: { token, fullName, regNo, email, dept, slotId, slotLabel }
  // ═══════════════════════════════════════════════════════════════════
  function doPost(e) {
    var data;
    try { data = JSON.parse(e.postData.contents); }
    catch (ex) { return errOut('Invalid JSON'); }

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

      // Duplicate email check
      for (var i = 0; i < existing.length; i++) {
        if (sanitizeEmail(String(existing[i][COL.EMAIL - 1])) === email) {
          return jsonOut({ ok: false, error: 'duplicate_email' });
        }
      }

      // Slot already taken check
      for (var i = 0; i < existing.length; i++) {
        if (String(existing[i][COL.SLOT_ID - 1]).trim() === data.slotId) {
          return jsonOut({ ok: false, error: 'slot_taken' });
        }
      }
    }

    // Write row
    sheet.appendRow([
      new Date().toISOString(),
      data.fullName.trim(),
      data.regNo.trim(),
      email,
      data.dept.trim(),
      data.slotId,
      data.slotLabel.trim()
    ]);

    // Alternate row shading for readability
    var lastRow = sheet.getLastRow();
    if (lastRow % 2 === 0) {
      sheet.getRange(lastRow, 1, 1, 7).setBackground('#f8f9fa');
    }

    return jsonOut({ ok: true });
  }
