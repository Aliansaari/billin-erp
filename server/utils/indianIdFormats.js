/*
 * Indian business-ID format validators.
 *
 * Used by the Company Profile settings endpoint to reject malformed
 * IDs at the API boundary instead of letting them propagate to invoice
 * prints where they cause downstream problems (GSTR-1 upload failures,
 * bounced NEFT transfers, etc.).
 *
 * Each helper returns either { ok: true } or { ok: false, error }.
 * Empty/null input is considered VALID (the field is optional); only
 * non-empty values are pattern-checked.
 */

'use strict';

// GSTIN — 15 chars: 2-digit state + 10-char PAN + entity code + Z + checksum.
// We pattern-check the structure; we DON'T verify the checksum (would
// require carrying the GST commission's check-table, and a bad checksum
// is a rare data-entry error vs the structural typos this catches).
function validateGstin(s) {
  if (!s) return { ok: true };
  const v = String(s).trim().toUpperCase();
  if (!/^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][0-9A-Z]Z[0-9A-Z]$/.test(v)) {
    return { ok: false, error: 'GSTIN must be 15 chars (e.g. 27ABCDE1234F1Z5).' };
  }
  return { ok: true };
}

// PAN — 10 chars: 5 letters + 4 digits + 1 letter. The 4th letter
// encodes the entity type (P=Individual, C=Company, etc.) — we don't
// enforce that, just the shape.
function validatePan(s) {
  if (!s) return { ok: true };
  const v = String(s).trim().toUpperCase();
  if (!/^[A-Z]{5}[0-9]{4}[A-Z]$/.test(v)) {
    return { ok: false, error: 'PAN must be 10 chars (e.g. ABCDE1234F).' };
  }
  return { ok: true };
}

// TAN — 10 chars: 4 letters + 5 digits + 1 letter. Same pattern shape
// as PAN, distinguished by content (TAN's leading letters encode the
// jurisdiction; PAN's encode name fragments).
function validateTan(s) {
  if (!s) return { ok: true };
  const v = String(s).trim().toUpperCase();
  if (!/^[A-Z]{4}[0-9]{5}[A-Z]$/.test(v)) {
    return { ok: false, error: 'TAN must be 10 chars (e.g. DELI12345E).' };
  }
  return { ok: true };
}

// CIN — 21 chars: 1-letter listing flag + 5-digit sector + 2-letter state
// + 4-digit year + 3-letter entity-type + 6-digit serial.
function validateCin(s) {
  if (!s) return { ok: true };
  const v = String(s).trim().toUpperCase();
  if (!/^[LUF][0-9]{5}[A-Z]{2}[0-9]{4}[A-Z]{3}[0-9]{6}$/.test(v)) {
    return { ok: false, error: 'CIN must be 21 chars (e.g. L17110MH1973PLC019786).' };
  }
  return { ok: true };
}

// IFSC — 11 chars: 4-letter bank code + 0 + 6-char branch code.
function validateIfsc(s) {
  if (!s) return { ok: true };
  const v = String(s).trim().toUpperCase();
  if (!/^[A-Z]{4}0[A-Z0-9]{6}$/.test(v)) {
    return { ok: false, error: 'IFSC must be 11 chars (e.g. HDFC0001234).' };
  }
  return { ok: true };
}

// Indian pincode — 6 digits, first digit 1-9 (postal regions).
function validatePincode(s) {
  if (!s) return { ok: true };
  const v = String(s).trim();
  if (!/^[1-9][0-9]{5}$/.test(v)) {
    return { ok: false, error: 'Pincode must be 6 digits and not start with 0.' };
  }
  return { ok: true };
}

// Email — simple RFC-ish check. Strict RFC 5322 isn't worth the
// regex; this catches the typos that actually happen.
function validateEmail(s) {
  if (!s) return { ok: true };
  const v = String(s).trim();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(v) || v.length > 120) {
    return { ok: false, error: 'Email looks invalid.' };
  }
  return { ok: true };
}

// Indian mobile — 10 digits starting 6-9. Accepts +91 / 91 prefix,
// strips whitespace + hyphens. Returns the digits-only form via .normalized
// (caller can store it consistently).
function validateMobile(s) {
  if (!s) return { ok: true, normalized: '' };
  const v = String(s).trim().replace(/[\s\-()+]/g, '').replace(/^91/, '');
  if (!/^[6-9][0-9]{9}$/.test(v)) {
    return { ok: false, error: 'Mobile must be a 10-digit Indian number starting with 6-9.' };
  }
  return { ok: true, normalized: v };
}

// UPI VPA — handle@psp. Loose pattern; PSPs use varied formats.
function validateUpi(s) {
  if (!s) return { ok: true };
  const v = String(s).trim();
  if (!/^[A-Za-z0-9._\-]{3,}@[A-Za-z][A-Za-z0-9.\-]{1,}$/.test(v) || v.length > 80) {
    return { ok: false, error: 'UPI ID must be in handle@psp format (e.g. shop@hdfcbank).' };
  }
  return { ok: true };
}

// Account number — 6-20 digits, no special chars. Banks vary widely
// in length; this is the safe band.
function validateBankAccount(s) {
  if (!s) return { ok: true };
  const v = String(s).trim();
  if (!/^[0-9]{6,20}$/.test(v)) {
    return { ok: false, error: 'Bank account number must be 6-20 digits.' };
  }
  return { ok: true };
}

// Indian state names — used for the dropdown / validation on
// company_state. Same list customers will see on the form.
const INDIAN_STATES = [
  'Andhra Pradesh', 'Arunachal Pradesh', 'Assam', 'Bihar', 'Chhattisgarh',
  'Goa', 'Gujarat', 'Haryana', 'Himachal Pradesh', 'Jharkhand',
  'Karnataka', 'Kerala', 'Madhya Pradesh', 'Maharashtra', 'Manipur',
  'Meghalaya', 'Mizoram', 'Nagaland', 'Odisha', 'Punjab',
  'Rajasthan', 'Sikkim', 'Tamil Nadu', 'Telangana', 'Tripura',
  'Uttar Pradesh', 'Uttarakhand', 'West Bengal',
  // Union territories
  'Andaman and Nicobar Islands', 'Chandigarh',
  'Dadra and Nagar Haveli and Daman and Diu', 'Delhi',
  'Jammu and Kashmir', 'Ladakh', 'Lakshadweep', 'Puducherry',
];
const STATE_SET = new Set(INDIAN_STATES.map((s) => s.toLowerCase()));
function validateState(s) {
  if (!s) return { ok: true };
  if (STATE_SET.has(String(s).trim().toLowerCase())) return { ok: true };
  return { ok: false, error: `State must be one of the recognised Indian states. Got: "${s}".` };
}

module.exports = {
  validateGstin,
  validatePan,
  validateTan,
  validateCin,
  validateIfsc,
  validatePincode,
  validateEmail,
  validateMobile,
  validateUpi,
  validateBankAccount,
  validateState,
  INDIAN_STATES,
};
