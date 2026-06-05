/*
 * printer.js — single entrypoint for all "print this document" calls.
 *
 * Responsibilities:
 *   1. Fetch the bill (already-loaded bill can be passed in)
 *   2. Resolve the print profile (passed profileId, or default for docType)
 *   3. Fetch company/system settings once (cached)
 *   4. Render HTML via printRenderer
 *   5. Print it:
 *        • Electron + silent_print  → IPC to main for silent direct print
 *        • Everything else          → iframe + window.print() fallback
 *
 * Existing inline print impls (SalesList.printBill, PurchaseList.printBill,
 * return-list printReturn, party-ledger printHTML) are being moved over to
 * this service so there's one place to change layout and printer logic.
 */

import { salesAPI, purchaseAPI, salesReturnAPI, purchaseReturnAPI, paymentAPI, settingsAPI, printAPI, whatsappAPI } from '../api';
import { renderBillHTML } from './printRenderer';
import { buildBillPdf, buildReceiptPdf } from '../utils/billPdf';
import { buildUpiQrDataUrl, fetchAsDataUrl, getSignatureUrl } from './printContext';
import { message } from 'antd';

let _companyCache = null;
let _companyAt = 0;
const COMPANY_TTL_MS = 60_000;

async function loadCompany() {
  if (_companyCache && Date.now() - _companyAt < COMPANY_TTL_MS) return _companyCache;
  try {
    const r = await settingsAPI.getSystem();
    _companyCache = r.data?.data || r.data || {};
    _companyAt = Date.now();
  } catch {
    _companyCache = {};
  }
  return _companyCache;
}

const LOADERS = {
  sales:           (id) => salesAPI.getById(id).then(r => r.data?.data || r.data),
  purchase:        (id) => purchaseAPI.getById(id).then(r => r.data?.data || r.data),
  sales_return:    (id) => salesReturnAPI.getById(id).then(r => r.data?.data || r.data),
  purchase_return: (id) => purchaseReturnAPI.getById(id).then(r => r.data?.data || r.data),
  receipt:         (id) => paymentAPI.getById(id).then(r => r.data?.data || r.data),
  payment:         (id) => paymentAPI.getById(id).then(r => r.data?.data || r.data),
};

async function resolveProfile(docType, profileId) {
  if (profileId) {
    const r = await printAPI.getById(profileId);
    return r.data?.data || r.data;
  }
  const r = await printAPI.getDefault(docType);
  return r.data?.data || r.data || null;
}

// Minimal profile used when no DB profiles exist yet — keeps print working
// on a brand-new install before the user visits Settings → Print.
// Receipts/payments default to thermal (80mm roll) — they're short docs with
// no items table, so thermal is the natural first-print experience. Sales &
// purchase default to A4 as before.
function fallbackProfile(docType) {
  const isThermalDoc = docType === 'receipt' || docType === 'payment';
  if (isThermalDoc) {
    return {
      name: 'Built-in Thermal', doc_type: docType, format: 'thermal',
      paper_width_mm: 80, paper_height_mm: null,
      margin_top_mm: 3, margin_right_mm: 3, margin_bottom_mm: 3, margin_left_mm: 3,
      font_family: "'Source Sans 3', system-ui, sans-serif", font_size_pt: 10, line_spacing: 1.3,
      thermal_style: 'simple', bold_level: 'bold',
      show_logo: false, header_align: 'center',
      show_hsn: false, show_batch: false, show_mrp: false, show_discount: false,
      show_tax_breakdown: false, show_barcode: false, show_qr_upi: false,
      show_signature: false, signature_label: 'Authorised Signatory',
      copies: 1, copy_labels: 'Original',
      currency_symbol: 'Rs ', locale_format: 'en-IN',
      printer_name: '', silent_print: true,
    };
  }
  return {
    name: 'Built-in A4', doc_type: docType, format: 'a4',
    paper_width_mm: 210, paper_height_mm: 297,
    margin_top_mm: 10, margin_right_mm: 10, margin_bottom_mm: 10, margin_left_mm: 10,
    font_family: "'Source Sans 3', system-ui, sans-serif", font_size_pt: 10, line_spacing: 1.35,
    show_logo: true, header_align: 'center',
    show_hsn: true, show_batch: false, show_mrp: true, show_discount: true,
    show_tax_breakdown: true, show_barcode: false, show_qr_upi: false,
    tax_summary_mode: 'consolidated',
    show_signature: true, signature_label: 'Authorised Signatory',
    copies: 1, copy_labels: 'Original',
    currency_symbol: 'Rs ', locale_format: 'en-IN',
    printer_name: '', silent_print: true,
  };
}

/* ── the public entry points ───────────────────────────────────────── */

export async function printDocument({ docType, id, bill: presetBill, profileId, silent, preview }) {
  try {
    const bill = presetBill || (LOADERS[docType] ? await LOADERS[docType](id) : null);
    if (!bill) { message.error('Could not load document'); return; }

    const profile = (await resolveProfile(docType, profileId)) || fallbackProfile(docType);
    const company = await loadCompany();

    // Pre-compute the UPI QR data URL so renderBillHTML can stay sync.
    // Gated on both the profile toggle and the company having a UPI ID.
    const upiQrDataUrl = profile?.show_qr_upi
      ? await buildUpiQrDataUrl({ company, bill })
      : null;

    const html = renderBillHTML({ bill, profile, company, docType, upiQrDataUrl });

    // Preview mode: always use the visible iframe route, skip silent.
    if (preview) return openPreview(html);

    // Decide silent vs dialog. `silent` arg wins; else profile.silent_print.
    const shouldSilent = silent !== undefined ? silent : !!profile.silent_print;

    if (shouldSilent && window.electronAPI?.printSilent) {
      const result = await window.electronAPI.printSilent({
        html,
        deviceName: profile.printer_name || undefined,
        copies: 1, // N copies already baked into the HTML as N pages
        paperWidthMm: profile.paper_width_mm,
        paperHeightMm: profile.paper_height_mm,
        marginsMm: {
          top: profile.margin_top_mm, right: profile.margin_right_mm,
          bottom: profile.margin_bottom_mm, left: profile.margin_left_mm,
        },
      });
      if (result?.error) message.error('Print failed: ' + result.error);
      else if (result?.success === false) message.warning('Print cancelled: ' + (result.failureReason || 'unknown'));
      else message.success('Printed');
      return;
    }

    // Fallback path: iframe + browser print dialog.
    return printViaIframe(html);
  } catch (e) {
    console.error('printDocument error', e);
    message.error('Print error: ' + (e?.response?.data?.error || e.message));
  }
}

/**
 * Print arbitrary HTML (not a bill) — used by reports, ledger, barcode
 * sheets. Skips the renderer; goes straight to silent-print or iframe.
 */
export async function printRawHTML(html, { silent = true, deviceName } = {}) {
  if (silent && window.electronAPI?.printSilent) {
    const r = await window.electronAPI.printSilent({ html, deviceName });
    if (r?.error) message.error('Print failed: ' + r.error);
    return;
  }
  printViaIframe(html);
}

/* ── fallback iframe print (non-Electron, or silent off) ───────────── */

function printViaIframe(html) {
  const iframe = document.createElement('iframe');
  iframe.style.cssText = 'position:fixed;right:0;bottom:0;width:0;height:0;border:0;visibility:hidden;';
  document.body.appendChild(iframe);
  iframe.srcdoc = html;
  iframe.onload = () => {
    try {
      iframe.contentWindow.focus();
      iframe.contentWindow.print();
    } finally {
      // Remove after the print dialog cycle. Short delay lets the browser
      // grab the print job; 3s is ample for local printers.
      setTimeout(() => iframe.remove(), 3000);
    }
  };
}

/* ── preview window (explicit user-requested "show before printing") ─ */

function openPreview(html) {
  const w = window.open('', '_blank', 'width=820,height=960');
  if (!w) { message.warning('Allow popups to preview'); return; }
  w.document.open();
  w.document.write(html);
  w.document.close();
}

/* ── PDF export + WhatsApp share ───────────────────────────────────── */

// Sanitize a free-text customer / party name for use as a filesystem name.
// Strips path separators, control chars, and trims trailing dots/spaces —
// Windows rejects names ending in '.', and both OSes choke on '/ \\ : * ? " < > |'.
function sanitizeFileName(s) {
  return String(s || '')
    .replace(/[\\/:*?"<>|\x00-\x1f]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[. ]+$/, '');
}

// Build "{Customer}-{BillNo}.pdf" with both parts sanitized. Falls back to
// "Bill-{id}.pdf" when the customer is a walk-in (no name).
function pdfFileName(bill) {
  const party = bill.customer || bill.supplier || bill.party;
  const name  = sanitizeFileName(party?.party_name) || 'Cash';
  const num   = sanitizeFileName(bill.bill_number || bill.transaction_number) || bill.id || 'bill';
  return `${name}-${num}.pdf`;
}

// Normalize an Indian phone number to wa.me's expected format (country code
// + digits, no +, no spaces). Accepts: "9876543210", "+91 98765 43210",
// "091-98765-43210". Rejects empty input so the caller can show an error.
function waNormalize(phone) {
  const digits = String(phone || '').replace(/\D+/g, '');
  if (!digits) return null;
  // If user typed a 10-digit Indian mobile, prepend 91. Longer numbers
  // already include a country code.
  if (digits.length === 10) return '91' + digits;
  return digits;
}

// Convert a Blob to a base64 string (no `data:` prefix) for the WhatsApp send API.
function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onloadend = () => resolve(String(r.result).split(',')[1] || '');
    r.onerror = reject;
    r.readAsDataURL(blob);
  });
}

// Build the invoice/document PDF blob. Shared by exportBillPDF (save to disk)
// and the WhatsApp send path (base64 → API). Returns { blob, fileName, bill }
// or null if the bill can't be loaded.
async function buildBillBlob({ docType, id, bill: presetBill, profileId }) {
  let bill = presetBill;
  if (!bill || !Array.isArray(bill.items) || bill.items.length === 0) {
    const billId = id || presetBill?.sales_bill_id || presetBill?.purchase_bill_id
      || presetBill?.return_bill_id || presetBill?.transaction_id;
    if (billId && LOADERS[docType]) { try { bill = await LOADERS[docType](billId); } catch { /* fall through */ } }
  }
  if (!bill) return null;
  const profile = (await resolveProfile(docType, profileId)) || fallbackProfile(docType);
  const baseCompany = await loadCompany();
  const fileName = pdfFileName(bill);
  // Pre-fetch the signature as a data URL so jsPDF can embed it inline.
  const sigUrl = getSignatureUrl(baseCompany);
  const signature_data_url = sigUrl ? await fetchAsDataUrl(sigUrl) : null;
  const company = { ...baseCompany, signature_data_url };
  // Receipts / payment vouchers get the narrow coloured thermal-style PDF;
  // everything else gets the A4 invoice layout.
  const blob = (docType === 'receipt' || docType === 'payment')
    ? await buildReceiptPdf({ docType, bill, profile, company, fileName })
    : await buildBillPdf({ docType, bill, profile, company, fileName });
  return { blob, fileName, bill };
}

// Is a WhatsApp provider connected + enabled right now (web linked OR official
// configured)? The send surfaces use this to decide auto-send vs. deep-link.
export async function whatsappReady() {
  try {
    const { data } = await whatsappAPI.status();
    return !!(data && data.enabled && data.state === 'connected');
  } catch { return false; }
}

// Generic: queue ANY PDF blob for paced WhatsApp delivery (used by bills,
// statements, receipts). Pass `vars` ({ name, billno, amount, date }) and the
// server fills the configurable message template (adding the shop name);
// `caption` still works for a fully pre-built message. Throws on API error so
// callers can fall back.
export async function sendPdfViaWhatsApp({ to, blob, fileName, caption, vars, party_id, doc_type, doc_id }) {
  const pdfBase64 = await blobToBase64(blob);
  await whatsappAPI.send({ to, pdfBase64, fileName, caption, vars, party_id, doc_type, doc_id });
  return true;
}

/**
 * Generate a PDF for `{ docType, id }` or a preloaded `bill`.
 *
 * In Electron: the PDF is written to the user's Downloads folder in main
 * (see electron/main.js `pdf:save`) and the returned `filePath` is used
 * for subsequent actions (open / show-in-folder). Writing in main
 * eliminated an IPC round-trip that was producing corrupted bytes
 * ("cannot render" in Acrobat).
 *
 * In a plain browser: we fall back to the print dialog — there's no
 * reliable offscreen HTML→PDF path without a native helper.
 *
 * Options:
 *   openAfterSave   — true by default: opens the saved PDF in the default
 *                     PDF viewer so the user can visually confirm it.
 */
export async function exportBillPDF({ docType, id, bill: presetBill, profileId, openAfterSave = true }) {
  try {
    // List rows pass a SUMMARY bill (no items[]); buildBillBlob fetches the
    // full bill by id when needed so the PDF has line items + GST splits.
    const built = await buildBillBlob({ docType, id, bill: presetBill, profileId });
    if (!built) { message.error('Could not load document'); return null; }
    const { blob, fileName } = built;

    if (window.electronAPI?.saveBlobToDownloads) {
      // Electron preferred path — main process writes the bytes to
      // Downloads and offers to open them.
      const ab = await blob.arrayBuffer();
      const res = await window.electronAPI.saveBlobToDownloads({ fileName, bytes: new Uint8Array(ab) });
      if (res?.error) { message.error('PDF export failed: ' + res.error); return null; }
      if (openAfterSave) window.electronAPI.openPath?.(res.filePath).catch(() => {});
      message.success('Saved to Downloads: ' + fileName);
      return { filePath: res.filePath, fileName };
    }

    // Browser / Electron-without-helper fallback — anchor download.
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = fileName;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 4000);
    message.success('Downloaded: ' + fileName);
    return { fileName };
  } catch (e) {
    console.error('exportBillPDF error', e);
    message.error('PDF export error: ' + (e?.response?.data?.error || e.message));
    return null;
  }
}

/**
 * Send a bill to the customer on WhatsApp.
 *
 * If a WhatsApp provider is connected (Settings → WhatsApp — Web link or the
 * official Cloud-API), the PDF is queued for paced, automatic delivery — no
 * manual step. Otherwise we fall back to the legacy self-serve flow: save the
 * PDF to Downloads, reveal it in Explorer, and open a wa.me chat with
 * pre-filled text for the operator to drag the file in (deep links can't
 * attach a file).
 */
export async function shareBillViaWhatsApp({ docType, id, bill: presetBill, profileId, silent = false, noFallback = false }) {
  try {
    const bill = presetBill || (LOADERS[docType] ? await LOADERS[docType](id) : null);
    if (!bill) { if (!silent) message.error('Could not load document'); return; }

    const party = bill.customer || bill.supplier || bill.party;
    const phone = waNormalize(party?.mobile_1 || party?.phone);
    if (!phone) { if (!silent) message.warning('No phone number on the customer record'); return; }

    const total = Number(bill.total_amount || 0).toLocaleString('en-IN',
      { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    const billNo = bill.bill_number || bill.transaction_number || '';
    const docId = id || bill.sales_bill_id || bill.purchase_bill_id
      || bill.return_bill_id || bill.transaction_id || null;

    // ── Connected provider → automatic, paced send (no manual attach) ──
    if (await whatsappReady()) {
      const built = await buildBillBlob({ docType, id, bill: presetBill, profileId });
      if (built) {
        const billDate = bill.bill_date || bill.transaction_date;
        // Balance figures (Dr/Cr). Empty string when nil → the server drops that
        // line from the message, so cash-paid bills stay clean.
        const fmtBal = (v) => {
          const n = Number(v) || 0;
          if (Math.abs(n) < 0.01) return '';
          const a = '₹' + Math.abs(n).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
          return n > 0 ? `${a} Dr` : `${a} Cr`;
        };
        const totalOutstanding = Number(party?.current_balance || 0);
        const billBal = Number(bill.balance_amount || 0);
        const prevBal = bill.previous_balance != null
          ? Number(bill.previous_balance)
          : Math.max(0, totalOutstanding - billBal);
        const isReceipt = docType === 'receipt' || docType === 'payment';
        const vars = {
          name: party?.party_name || 'Customer',
          billno: billNo,
          amount: `₹${total}`,
          date: billDate ? new Date(billDate).toLocaleDateString('en-IN') : '',
        };
        if (isReceipt) {
          // Receipt: always show the remaining balance (clearly labelled).
          vars.balance = fmtBal(totalOutstanding) || 'Settled ✓';
        } else {
          // Bill: previous balance (only if any) + total outstanding (only if any).
          vars.previous = fmtBal(prevBal);
          vars.outstanding = fmtBal(totalOutstanding);
        }
        try {
          await sendPdfViaWhatsApp({
            to: phone, blob: built.blob, fileName: built.fileName, vars,
            party_id: party?.party_id || null, doc_type: docType, doc_id: docId,
          });
          if (!silent) message.success('Queued on WhatsApp — it will be delivered shortly');
          return;
        } catch (e) {
          console.error('WhatsApp auto-send failed', e);
          if (noFallback) throw e;   // bulk: surface to caller, don't open a chat window
          if (!silent) message.warning('Auto-send unavailable — opening WhatsApp to share manually');
        }
      } else if (noFallback) {
        // Connected but the PDF didn't build — don't silently open a chat in bulk.
        throw new Error('Could not build the PDF');
      }
    } else if (noFallback) {
      // Bulk path requires a connected provider — never open N chat windows.
      throw new Error('WhatsApp is not connected');
    }

    // ── Fallback: save + reveal + open chat (manual drag-and-drop) ──
    const saved = await exportBillPDF({ docType, bill, profileId, openAfterSave: false });
    // Hard-failure guard in Electron — if the renderer-built PDF didn't make
    // it to disk, bail before opening WhatsApp so the operator isn't left
    // dragging an absent file.
    if (!saved?.filePath && window.electronAPI?.saveBlobToDownloads) return;
    if (saved?.filePath && window.electronAPI?.showItemInFolder) {
      window.electronAPI.showItemInFolder(saved.filePath).catch(() => {});
    }
    const text = encodeURIComponent(
      `Hello ${party?.party_name || 'Customer'},\n\n` +
      `Please find your bill ${billNo} for ₹ ${total}. PDF attached.\n\nThank you.`
    );
    window.open(`https://wa.me/${phone}?text=${text}`, '_blank', 'noopener');
    message.success('Chat opened — drag the highlighted PDF from Explorer into the chat');
  } catch (e) {
    console.error('shareBillViaWhatsApp error', e);
    message.error('WhatsApp share failed: ' + (e?.response?.data?.error || e.message));
  }
}

/* ── printer enumeration (Electron only) ───────────────────────────── */

export async function listPrinters() {
  if (!window.electronAPI?.listPrinters) {
    return { printers: [], error: 'not running in Electron — printer enumeration requires the desktop build (npm run electron:dev)' };
  }
  try {
    const res = await window.electronAPI.listPrinters();
    // New shape: { printers, error? }. Legacy shape: bare array. Handle both.
    if (Array.isArray(res)) return { printers: res };
    return res || { printers: [] };
  } catch (e) {
    return { printers: [], error: e.message };
  }
}
