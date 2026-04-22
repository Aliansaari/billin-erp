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

import { salesAPI, purchaseAPI, salesReturnAPI, purchaseReturnAPI, paymentAPI, settingsAPI, printAPI } from '../api';
import { renderBillHTML } from './printRenderer';
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
function fallbackProfile(docType) {
  return {
    name: 'Built-in A4', doc_type: docType, format: 'a4',
    paper_width_mm: 210, paper_height_mm: 297,
    margin_top_mm: 10, margin_right_mm: 10, margin_bottom_mm: 10, margin_left_mm: 10,
    font_family: 'Inter, system-ui, sans-serif', font_size_pt: 10, line_spacing: 1.35,
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

    const html = renderBillHTML({ bill, profile, company, docType });

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
