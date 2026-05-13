/*
 * printContext.js — small helpers that turn the raw `company` payload
 * (returned by GET /api/settings/system, i.e. the system_settings row)
 * into the small derived strings + assets that the print templates
 * actually render.
 *
 * Why a separate file: both printRenderer.js (HTML) and billPdf.js (jsPDF)
 * consume the same fields. Keeping address-building, bank-block, QR-data-URL
 * etc. in one place means a tweak (e.g. "always include country") lands on
 * both formats automatically and there's no chance of A4-HTML and A4-PDF
 * drifting apart.
 *
 * Field map — driven by the new onboarding columns:
 *   company_address_line_1, company_address_line_2,
 *   company_city, company_state, company_pincode, company_country
 *   company_phone, company_phone_2, company_email, company_website
 *   gstin, pan_number, tan_number, cin_number, msme_udyam, drug_license, fssai_license
 *   bank_name, bank_account_holder, bank_account_number, bank_ifsc, bank_branch, bank_upi_id
 *   logo_path, signature_path, invoice_footer
 *
 * Backwards compat: the legacy `company_address` blob is honoured as a fall-
 * back when none of the structured fields are populated, so installs that
 * haven't migrated their data through Settings → Company Profile still print.
 */

import QRCode from 'qrcode';

/* ── address ─────────────────────────────────────────────────────────── */

/**
 * Build the company address as an array of clean lines from the structured
 * columns. Returns at most 4 lines: street1 / street2 / "city, state pincode"
 * / country. Empty fields are skipped. If no structured fields are set, falls
 * back to splitting the legacy `company_address` blob on commas / newlines.
 *
 * Returns: string[]  (never null; always at least an empty array)
 */
export function buildAddressLines(company) {
  if (!company) return [];
  const c = company;
  const has =
    c.company_address_line_1 || c.company_address_line_2 ||
    c.company_city || c.company_state || c.company_pincode || c.company_country;
  if (!has) {
    // Legacy fallback — keep whatever the operator typed into the old single-
    // line column rendering. Split on newlines OR commas so a typical
    // "Line1, Line2, City - 400001" still wraps sensibly.
    const blob = (c.company_address || '').trim();
    if (!blob) return [];
    return blob.split(/\r?\n|,\s*/).map(s => s.trim()).filter(Boolean);
  }
  const lines = [];
  if (c.company_address_line_1) lines.push(String(c.company_address_line_1).trim());
  if (c.company_address_line_2) lines.push(String(c.company_address_line_2).trim());
  // City / State / Pincode all on one line if any of them are present.
  const cityLine = [
    c.company_city  ? String(c.company_city).trim()  : '',
    c.company_state ? String(c.company_state).trim() : '',
    c.company_pincode ? String(c.company_pincode).trim() : '',
  ];
  // Join "City, State Pincode" — comma between city and state, space before
  // pincode. Whichever parts are missing drop out cleanly.
  let cityStr = '';
  if (cityLine[0] && cityLine[1])      cityStr = `${cityLine[0]}, ${cityLine[1]}`;
  else if (cityLine[0])                cityStr = cityLine[0];
  else if (cityLine[1])                cityStr = cityLine[1];
  if (cityLine[2])                     cityStr = cityStr ? `${cityStr} ${cityLine[2]}` : cityLine[2];
  if (cityStr) lines.push(cityStr);
  if (c.company_country) lines.push(String(c.company_country).trim());
  return lines.filter(Boolean);
}

/* ── contact + statutory IDs ────────────────────────────────────────── */

/**
 * Build the contact line — phone(s) / email / website. Returns a single
 * string with " · " separators, or null when nothing is set. Designed to
 * fit the address block below the company name.
 */
export function buildContactLine(company) {
  if (!company) return null;
  const parts = [];
  const phone = [company.company_phone, company.company_phone_2].filter(Boolean).join(' / ');
  if (phone) parts.push(`Ph: ${phone}`);
  if (company.company_email)   parts.push(company.company_email);
  if (company.company_website) parts.push(company.company_website);
  return parts.length ? parts.join('  ·  ') : null;
}

/**
 * Build the statutory-IDs line(s). GSTIN / PAN go on the first; the
 * second carries TAN / CIN / MSME / Drug / FSSAI (whichever are populated).
 * Returns string[] — caller stitches them together.
 */
export function buildStatutoryLines(company) {
  if (!company) return [];
  const out = [];
  const primary = [];
  if (company.gstin)      primary.push(`GSTIN: ${company.gstin}`);
  if (company.pan_number) primary.push(`PAN: ${company.pan_number}`);
  if (primary.length) out.push(primary.join('  ·  '));

  const secondary = [];
  if (company.tan_number)    secondary.push(`TAN: ${company.tan_number}`);
  if (company.cin_number)    secondary.push(`CIN: ${company.cin_number}`);
  if (company.msme_udyam)    secondary.push(`MSME/Udyam: ${company.msme_udyam}`);
  if (company.drug_license)  secondary.push(`Drug Lic: ${company.drug_license}`);
  if (company.fssai_license) secondary.push(`FSSAI: ${company.fssai_license}`);
  if (secondary.length) out.push(secondary.join('  ·  '));

  return out;
}

/* ── banking block ──────────────────────────────────────────────────── */

/**
 * Whether the company has populated banking fields. Drives whether the
 * footer renders a Bank Details block at all.
 */
export function hasBankDetails(company) {
  if (!company) return false;
  return !!(
    company.bank_name || company.bank_account_holder ||
    company.bank_account_number || company.bank_ifsc ||
    company.bank_branch || company.bank_upi_id
  );
}

/**
 * Returns banking info as a list of "label: value" rows. The renderer
 * stitches them as `<br/>` lines in HTML or `text()` in jsPDF.
 */
export function buildBankRows(company) {
  if (!company) return [];
  const out = [];
  if (company.bank_name)           out.push(['Bank',           company.bank_name]);
  if (company.bank_account_holder) out.push(['A/c Holder',     company.bank_account_holder]);
  if (company.bank_account_number) out.push(['A/c No',         company.bank_account_number]);
  if (company.bank_ifsc)           out.push(['IFSC',           company.bank_ifsc]);
  if (company.bank_branch)         out.push(['Branch',         company.bank_branch]);
  if (company.bank_upi_id)         out.push(['UPI',            company.bank_upi_id]);
  return out;
}

/* ── UPI QR code ────────────────────────────────────────────────────── */

/**
 * Build the standard UPI deep-link URL (the `upi://pay?...` scheme). When
 * encoded as a QR, any UPI app (GPay/PhonePe/Paytm/BHIM) opens with the
 * payee/amount/note pre-filled. Reference:
 *   https://www.npci.org.in/what-we-do/upi/product-overview
 *
 *   pa = payee VPA (required)
 *   pn = payee name (required for app to label the transaction)
 *   am = amount (optional — leaving it blank lets the customer type their own)
 *   tn = transaction note (we put the bill number for reconciliation)
 *   cu = currency, always INR
 */
export function buildUpiUri({ vpa, name, amount, note }) {
  if (!vpa) return null;
  const params = new URLSearchParams();
  params.set('pa', vpa);
  if (name)   params.set('pn', name);
  if (amount && Number(amount) > 0) params.set('am', String(Number(amount).toFixed(2)));
  if (note)   params.set('tn', note);
  params.set('cu', 'INR');
  // URLSearchParams renders `pa=...&pn=...` which is exactly what the UPI
  // intent expects. The leading `upi://pay?` is the documented scheme.
  return `upi://pay?${params.toString()}`;
}

/**
 * Generate a QR data URL for the UPI deep-link. `size` is the pixel
 * dimension (square). Returns null when no VPA configured.
 *
 * Async because qrcode.toDataURL is async — callers must await.
 */
export async function buildUpiQrDataUrl({ company, bill, size = 140 } = {}) {
  if (!company?.bank_upi_id) return null;
  const uri = buildUpiUri({
    vpa: company.bank_upi_id,
    name: company.bank_account_holder || company.company_name,
    amount: bill?.total_amount,
    note: bill?.bill_number || bill?.transaction_number,
  });
  if (!uri) return null;
  try {
    return await QRCode.toDataURL(uri, {
      width: size,
      margin: 1,
      errorCorrectionLevel: 'M',
    });
  } catch {
    return null;
  }
}

/* ── signature image ────────────────────────────────────────────────── */

/**
 * Returns the signature image URL or null. The path stored in
 * system_settings.signature_path is server-relative (e.g.
 * `/branding/signature-abc.png`); we trust it as-is so the same URL
 * works in both the browser print iframe and Electron's silent print.
 */
export function getSignatureUrl(company) {
  if (!company?.signature_path) return null;
  const p = String(company.signature_path).trim();
  return p || null;
}

/* ── image pre-load (for jsPDF) ─────────────────────────────────────── */

/**
 * jsPDF needs a base64 data URL for `addImage`, but the company's signature
 * lives at a server-relative path (e.g. `/branding/signature-abc.png`).
 * Fetch the image and read it as a data URL. Returns null on any failure
 * (network, CORS, missing file) — the PDF then falls back to the blank
 * signature line, which is the safe behaviour.
 */
export async function fetchAsDataUrl(url) {
  if (!url) return null;
  try {
    const r = await fetch(url, { credentials: 'include' });
    if (!r.ok) return null;
    const blob = await r.blob();
    return await new Promise((resolve, reject) => {
      const fr = new FileReader();
      fr.onload = () => resolve(fr.result);
      fr.onerror = reject;
      fr.readAsDataURL(blob);
    });
  } catch {
    return null;
  }
}

/* ── invoice footer text ────────────────────────────────────────────── */

/**
 * Returns the company-wide invoice footer string (e.g. "Goods once sold
 * will not be taken back"). Distinct from the per-profile `footer_html` —
 * this is the firm-level legal/T&C line that prints on every doc type.
 */
export function getInvoiceFooter(company) {
  return company?.invoice_footer ? String(company.invoice_footer).trim() : null;
}
