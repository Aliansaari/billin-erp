/*
 * printRenderer.js — turns a (bill, profile, company) tuple into a complete
 * printable HTML document. Three format paths (a4 / a5 / thermal) share one
 * row renderer but layout/widths/padding differ.
 *
 * The HTML produced is self-contained (inline CSS, no external assets except
 * optional logo URL) so it can be fed straight to Electron's silent print or
 * dumped into an iframe for window.print() fallback.
 *
 * Data sources:
 *   - bill     = the loaded document (sale/purchase/return/receipt/payment)
 *   - profile  = per-doctype print profile (font, paper, toggles, etc.)
 *   - company  = system_settings row — structured address / banking /
 *                statutory IDs / branding paths. See printContext.js for
 *                the helpers that turn raw columns into render-ready strings.
 */

import {
  buildAddressLines, buildContactLine, buildStatutoryLines,
  hasBankDetails, buildBankRows,
  getSignatureUrl, getInvoiceFooter,
} from './printContext';

/* ── utility fmtters ────────────────────────────────────────────────── */

const esc = (s) => String(s == null ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

const fmtMoney = (n, profile) => {
  const num = Number(n || 0);
  const locale = profile?.locale_format || 'en-IN';
  const sym = profile?.currency_symbol ?? 'Rs ';
  return sym + num.toLocaleString(locale, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
};

const fmtQty = (n) => Number(n || 0).toLocaleString('en-IN', { maximumFractionDigits: 3 });

const fmtDate = (d) => {
  if (!d) return '';
  const x = new Date(d);
  if (isNaN(x.getTime())) return String(d);
  return x.toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' });
};

// Number → words for the grand-total line on A4/A5 (thermal skips this).
const numberToWords = (num) => {
  const a = ['', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight',
             'Nine', 'Ten', 'Eleven', 'Twelve', 'Thirteen', 'Fourteen', 'Fifteen',
             'Sixteen', 'Seventeen', 'Eighteen', 'Nineteen'];
  const b = ['', '', 'Twenty', 'Thirty', 'Forty', 'Fifty', 'Sixty', 'Seventy', 'Eighty', 'Ninety'];
  const inWords = (n) => {
    if (n < 20) return a[n];
    if (n < 100) return b[Math.floor(n / 10)] + (n % 10 ? ' ' + a[n % 10] : '');
    if (n < 1000) return a[Math.floor(n / 100)] + ' Hundred' + (n % 100 ? ' ' + inWords(n % 100) : '');
    if (n < 100000) return inWords(Math.floor(n / 1000)) + ' Thousand' + (n % 1000 ? ' ' + inWords(n % 1000) : '');
    if (n < 10000000) return inWords(Math.floor(n / 100000)) + ' Lakh' + (n % 100000 ? ' ' + inWords(n % 100000) : '');
    return inWords(Math.floor(n / 10000000)) + ' Crore' + (n % 10000000 ? ' ' + inWords(n % 10000000) : '');
  };
  const n = Math.floor(Math.abs(Number(num || 0)));
  const paise = Math.round((Math.abs(Number(num || 0)) - n) * 100);
  let s = n === 0 ? 'Zero' : inWords(n);
  if (paise) s += ' and ' + inWords(paise) + ' Paise';
  return s + ' Only';
};

/* ── document-type labels ───────────────────────────────────────────── */

const DOC_LABEL = {
  sales:           'TAX INVOICE',
  purchase:        'PURCHASE BILL',
  sales_return:    'CREDIT NOTE',
  purchase_return: 'DEBIT NOTE',
  receipt:         'RECEIPT',
  payment:         'PAYMENT VOUCHER',
  quotation:       'QUOTATION',
  challan:         'DELIVERY CHALLAN',
};

/* ── header / footer partials (shared) ──────────────────────────────── */

const renderHeader = (profile, company, doc) => {
  const title = esc(profile?.header_title || company?.company_name || 'Company Name');
  const align = profile?.header_align || 'center';
  const logo = profile?.show_logo && company?.logo_path
    ? `<img src="${esc(company.logo_path)}" alt="logo" class="logo" />`
    : '';
  // Multi-line address from the structured onboarding columns (with legacy
  // company_address fallback handled inside buildAddressLines).
  const addressLines = buildAddressLines(company);
  const addressHtml = addressLines.length
    ? `<div class="hdr-sub">${addressLines.map(esc).join('<br/>')}</div>`
    : '';
  // Phone / email / website on one quiet line below the address.
  const contactLine = buildContactLine(company);
  const contactHtml = contactLine
    ? `<div class="hdr-sub">${esc(contactLine)}</div>`
    : '';
  // GSTIN/PAN on row 1, TAN/CIN/MSME/Drug/FSSAI on row 2 — whichever are set.
  const statHtml = buildStatutoryLines(company)
    .map(line => `<div class="hdr-sub">${esc(line)}</div>`)
    .join('');
  return `
    <div class="hdr" style="text-align:${align}">
      ${logo}
      <div class="hdr-name">${title}</div>
      ${addressHtml}
      ${contactHtml}
      ${statHtml}
      ${profile?.header_html ? `<div class="hdr-extra">${profile.header_html}</div>` : ''}
      <div class="doc-type">${esc((profile?.doc_label || '').trim() || DOC_LABEL[doc.__doctype] || 'DOCUMENT')}${doc.__copyLabel ? ` · ${esc(doc.__copyLabel)}` : ''}</div>
    </div>
  `;
};

const renderFooter = (profile, company, opts = {}) => {
  const parts = [];

  // ── Bank block ──
  // Prefer the structured banking columns from system_settings; fall back to
  // the legacy free-text profile.bank_details so older profiles still print.
  if (hasBankDetails(company)) {
    const rows = buildBankRows(company);
    const inner = rows
      .map(([k, v]) => `<div><b>${esc(k)}:</b> ${esc(v)}</div>`)
      .join('');
    // QR (data URL pre-computed in printer.js so this renderer stays sync).
    // Sits to the RIGHT of the bank rows so the printout reads "details
    // here, scan to pay there" — natural eye-flow on a customer copy.
    const qrHtml = opts.upiQrDataUrl
      ? `<div class="fb-qr">
           <img src="${esc(opts.upiQrDataUrl)}" alt="UPI QR" />
           <div class="fb-qr-cap">Scan to pay (UPI)</div>
         </div>`
      : '';
    parts.push(
      `<div class="fb-bank">
        <div class="fb-bank-rows"><b>Bank Details</b>${inner}</div>
        ${qrHtml}
      </div>`
    );
  } else if (profile?.bank_details) {
    // Legacy: free-text bank block on the profile (still works for installs
    // that haven't moved their banking info into Company Profile yet).
    parts.push(`<div class="fb-bank"><b>Bank Details:</b><br/>${profile.bank_details.replace(/\n/g, '<br/>')}</div>`);
  }

  if (profile?.terms_and_conditions) parts.push(`<div class="fb-tc"><b>Terms &amp; Conditions:</b><br/>${profile.terms_and_conditions.replace(/\n/g, '<br/>')}</div>`);

  // Company-wide invoice footer (system_settings.invoice_footer) — distinct
  // from the per-profile footer_html. Renders just above signature.
  const invoiceFooter = getInvoiceFooter(company);
  if (invoiceFooter) parts.push(`<div class="fb-legal">${esc(invoiceFooter)}</div>`);
  if (profile?.footer_html) parts.push(`<div class="fb-extra">${profile.footer_html}</div>`);

  // ── Signature ──
  // If the company has uploaded a signature image, render it above the line;
  // otherwise fall back to the empty-line placeholder for hand-signing.
  let sig = '';
  if (profile?.show_signature) {
    const sigUrl = getSignatureUrl(company);
    const sigImg = sigUrl
      ? `<img src="${esc(sigUrl)}" alt="signature" class="fb-sig-img" />`
      : '';
    sig = `<div class="fb-sig">${sigImg}<div class="sig-line"></div><div>${esc(profile.signature_label || 'Authorised Signatory')}</div></div>`;
  }
  return `<div class="fb">${parts.join('')}${sig}</div>`;
};

/* ── item rows for A4 / A5 ──────────────────────────────────────────── */

const renderItemsTable = (items, profile) => {
  const cols = [
    { k: 'sn', h: '#',       cls: 'c-sn' },
    { k: 'name', h: 'Item',  cls: 'c-name' },
  ];
  if (profile.show_hsn)            cols.push({ k: 'hsn',  h: 'HSN',      cls: 'c-hsn' });
  if (profile.show_batch)          cols.push({ k: 'batch',h: 'Batch',    cls: 'c-batch' });
  cols.push({ k: 'qty',  h: 'Qty', cls: 'c-qty' });
  cols.push({ k: 'rate', h: 'Rate', cls: 'c-rate' });
  if (profile.show_mrp)            cols.push({ k: 'mrp',  h: 'MRP',      cls: 'c-mrp' });
  if (profile.show_discount)       cols.push({ k: 'disc', h: 'Disc%',    cls: 'c-disc' });
  if (profile.show_tax_breakdown && profile.tax_summary_mode === 'lineWise') {
    cols.push({ k: 'cgst', h: 'CGST', cls: 'c-tax' });
    cols.push({ k: 'sgst', h: 'SGST', cls: 'c-tax' });
    cols.push({ k: 'igst', h: 'IGST', cls: 'c-tax' });
  }
  cols.push({ k: 'amt',  h: 'Amount', cls: 'c-amt' });

  const head = cols.map(c => `<th class="${c.cls}">${c.h}</th>`).join('');
  // Batch sub-line (Commit 5) — for any line carrying batch metadata
  // (lot number / mfg date / expiry date), emit a second row spanning
  // every column with `Lot: … · Mfd: … · Exp: …`. Format gracefully
  // omits parts that aren't present, so a line with only Lot+Exp shows
  // "Lot: LOT-2401 · Exp: 31 May 2026" rather than empty separators.
  // Renders for both A4 and thermal templates because both call this
  // helper. The `show_batch` profile column above continues to render
  // a dedicated Batch column when set; the sub-line is additive and
  // shows even when that column is hidden so per-lot identity always
  // prints on every customer copy.
  const renderBatchSubLine = (it) => {
    // Source values from either the item's own field (if a controller
    // hand-rolls them) or the included `batch` association (Sequelize
    // shape: it.batch.batch_number etc., emitted by the *.getById
    // includes after Commit 5). Either resolves to the same string.
    const lot = it.batch_number    || it.batch?.batch_number;
    const mfd = it.manufacture_date || it.batch?.manufacture_date;
    const exp = it.expiry_date     || it.batch?.expiry_date;
    const parts = [];
    if (lot) parts.push(`Lot: ${esc(lot)}`);
    if (mfd) parts.push(`Mfd: ${esc(fmtDate(mfd))}`);
    if (exp) parts.push(`Exp: ${esc(fmtDate(exp))}`);
    if (parts.length === 0) return '';
    return `<tr class="batch-subline"><td colspan="${cols.length}" style="font-size:0.85em;color:#6b7280;padding:2px 8px 6px;font-style:italic">${parts.join(' · ')}</td></tr>`;
  };

  const body = items.map((it, i) => {
    const row = {
      sn: i + 1,
      name: esc(it.product_name || ''),
      hsn: esc(it.hsn_code || ''),
      batch: esc(it.batch_number || ''),
      qty: fmtQty(it.quantity),
      rate: fmtMoney(it.rate || it.purchase_rate, profile),
      mrp: fmtMoney(it.mrp, profile),
      disc: Number(it.discount_percentage || 0).toFixed(2) + '%',
      cgst: fmtMoney(it.cgst_amount, profile),
      sgst: fmtMoney(it.sgst_amount, profile),
      igst: fmtMoney(it.igst_amount, profile),
      amt:  fmtMoney(it.total_amount, profile),
    };
    return `<tr>${cols.map(c => `<td class="${c.cls}">${row[c.k]}</td>`).join('')}</tr>${renderBatchSubLine(it)}`;
  }).join('');
  return `<table class="items"><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table>`;
};

/* ── totals block for A4 / A5 ───────────────────────────────────────── */

const renderTotals = (bill, profile) => {
  // Defaults: when a profile predates a toggle field, treat undefined as the
  // historical default. show_previous_balance defaults OFF (opt-in); the
  // others default ON (backwards compatible).
  const showDisc   = profile?.show_discount !== false;
  const showGst    = profile?.show_gst !== false;
  const showReturn = profile?.show_return_amount !== false;
  const showPrev   = profile?.show_previous_balance !== false;
  const party = bill.customer || bill.supplier || bill.party || {};
  const prev = bill.previous_balance != null
    ? Number(bill.previous_balance)
    : Math.max(0, Number(party.current_balance || 0) - Number(bill.balance_amount || 0));
  const rows = [];
  if (showPrev && prev > 0) rows.push(['Previous Bal', fmtMoney(prev, profile)]);
  rows.push(['Sub Total', fmtMoney(bill.sub_total, profile)]);
  if (showDisc && Number(bill.discount_amount || 0)) rows.push(['Discount', '-' + fmtMoney(bill.discount_amount, profile)]);
  if (showGst  && Number(bill.cgst_amount || 0)) rows.push(['CGST', fmtMoney(bill.cgst_amount, profile)]);
  if (showGst  && Number(bill.sgst_amount || 0)) rows.push(['SGST', fmtMoney(bill.sgst_amount, profile)]);
  if (showGst  && Number(bill.igst_amount || 0)) rows.push(['IGST', fmtMoney(bill.igst_amount, profile)]);
  if (Number(bill.other_charges || 0)) rows.push(['Other', fmtMoney(bill.other_charges, profile)]);
  if (Number(bill.freight_charges || 0)) rows.push(['Freight', fmtMoney(bill.freight_charges, profile)]);
  if (Number(bill.round_off || 0)) rows.push(['Round Off', fmtMoney(bill.round_off, profile)]);
  const grand = Number(bill.total_amount || 0);
  const html = rows.map(([l, v]) => `<div class="tot-row"><span>${l}</span><span>${v}</span></div>`).join('');
  // Post-TOTAL rows: return credit (items returned in this sale), paid, balance.
  const tail = [];
  if (showReturn && Number(bill.return_amount || 0) > 0)
    tail.push(['Return', '-' + fmtMoney(bill.return_amount, profile)]);
  if (Number(bill.paid_amount || 0) > 0)
    tail.push(['Paid', fmtMoney(bill.paid_amount, profile)]);
  if (Number(bill.balance_amount || 0) > 0)
    tail.push(['Balance Due', fmtMoney(bill.balance_amount, profile)]);
  const tailHtml = tail.map(([l, v]) => `<div class="tot-row"><span>${l}</span><span>${v}</span></div>`).join('');
  return `
    <div class="totals">
      ${html}
      <div class="tot-grand">
        <span>TOTAL</span><span>${fmtMoney(grand, profile)}</span>
      </div>
      ${tailHtml}
      <div class="tot-words">${esc(numberToWords(grand))}</div>
    </div>
  `;
};

const renderPartyBlock = (bill) => {
  const p = bill.customer || bill.supplier || bill.party || {};
  const isCash = !p.party_name || p.is_system_cash;
  const walkIn = String(bill.walk_in_name || '').trim();
  const lines = [];
  if (isCash) {
    // System Cash party prints as "Cash" with the operator-typed walk-in
    // name on a second line (when present). Skip mobile/GSTIN — they're
    // sentinel values on the system party (mobile_1 = "CASH").
    lines.push('<b>Cash</b>');
    if (walkIn) lines.push(esc(walkIn));
  } else {
    lines.push(`<b>${esc(p.party_name)}</b>`);
    if (p.address_line1) lines.push(esc(p.address_line1));
    if (p.city || p.state) lines.push(esc([p.city, p.state].filter(Boolean).join(', ')));
    if (p.gstin) lines.push(`GSTIN: ${esc(p.gstin)}`);
    if (p.mobile_1) lines.push(`Mobile: ${esc(p.mobile_1)}`);
  }
  return `<div class="party">${lines.join('<br/>')}</div>`;
};

/* ── styles ─────────────────────────────────────────────────────────── */

/* ── theme overlays ──────────────────────────────────────────────────
 *  Themes don't change LAYOUT (what fields print, columns, totals) — only
 *  borders, fonts, spacing, colors. Base CSS handles layout; each theme
 *  below contributes a small override block appended after it.
 * ──────────────────────────────────────────────────────────────────── */

const themeCSS = (profile) => {
  const t = profile?.theme || 'classic';
  const accent = profile?.accent_color || '#111111';
  if (t === 'modern') return `
    body { font-family: ${profile?.font_family || "'Source Sans 3', 'Segoe UI', system-ui, sans-serif"}; }
    .hdr-name { font-weight: 800; color: ${accent}; letter-spacing: -0.5px; }
    .doc-type { border: none; background: ${accent}; color: #fff; padding: 5px 14px; border-radius: 4px; display: inline-block; letter-spacing: 3px; }
    table.items th, table.items td { border: none; border-bottom: 1px solid #e5e7eb; }
    table.items th { background: transparent; color: #6b7280; font-size: .75em; text-transform: uppercase; letter-spacing: 1px; border-bottom: 2px solid ${accent}; }
    .tot-grand { border-top: 2px solid ${accent}; border-bottom: none; color: ${accent}; }
  `;
  if (t === 'minimal') return `
    body { font-family: ${profile?.font_family || "'Source Sans 3', system-ui, sans-serif"}; color: #1f2937; }
    .hdr-name { font-weight: 600; font-size: 1.3em; }
    .doc-type { border: none; color: ${accent}; font-size: .85em; letter-spacing: 4px; margin-top: 4mm; }
    table.items th, table.items td { border: none; padding: 6px 8px; }
    table.items th { background: transparent; color: #9ca3af; font-weight: 500; font-size: .75em; text-transform: uppercase; letter-spacing: 1.5px; border-bottom: 1px solid #e5e7eb; }
    table.items tbody tr { border-bottom: 1px solid #f3f4f6; }
    .tot-grand { border-top: 1px solid #d1d5db; border-bottom: none; padding-top: 8px; font-size: 1.2em; }
    .sig-line { border-color: #d1d5db; }
  `;
  if (t === 'elegant') return `
    body { font-family: ${profile?.font_family || "'Source Sans 3', sans-serif"}; }
    .hdr-name { font-family: 'Source Sans 3', sans-serif; font-weight: 600; font-style: italic; font-size: 1.9em; color: ${accent}; }
    .hdr-sub { font-style: italic; letter-spacing: .5px; }
    .doc-type { font-family: 'Source Sans 3', sans-serif; font-size: .8em; letter-spacing: 4px; border: none; color: ${accent};
      border-top: 1px solid ${accent}; border-bottom: 1px solid ${accent}; padding: 4px 0; margin: 4mm auto; max-width: 40%; }
    table.items th { background: transparent; font-family: 'Source Sans 3', sans-serif; font-size: .75em; letter-spacing: 1.5px; text-transform: uppercase; border: none; border-bottom: 1.5px solid ${accent}; color: ${accent}; }
    table.items td { border: none; border-bottom: 1px solid #e5e7eb; padding: 8px 6px; }
    .tot-grand { font-family: 'Source Sans 3', sans-serif; font-size: 1.3em; border-top: 1.5px solid ${accent}; border-bottom: 1.5px solid ${accent}; color: ${accent}; }
  `;
  if (t === 'boxed') return `
    body { font-family: ${profile?.font_family || "'Source Sans 3', system-ui, sans-serif"}; }
    .page { border: 2px solid ${accent}; padding: 6mm; }
    .hdr { background: ${accent}; color: #fff; padding: 5mm; margin: -6mm -6mm 6mm; }
    .hdr-name, .hdr-sub, .doc-type { color: #fff; }
    .hdr-sub { opacity: 0.9; }
    .doc-type { border: 1px solid rgba(255,255,255,0.3); padding: 3px 10px; display: inline-block; margin-top: 3mm; }
    table.items th { background: ${accent}; color: #fff; border-color: ${accent}; }
    table.items td { border-color: #d1d5db; }
    .tot-grand { background: ${accent}; color: #fff; padding: 8px 10px; border: none; margin-top: 4mm; }
    .fb-bank, .fb-tc { background: #f9fafb; padding: 4mm; border-radius: 4px; }
  `;
  // Studio — modern editorial spread. Title carries an accent-coloured
  // left rule, doc-type sits as quiet uppercase eyebrow text, table
  // is borderless with a single accent rule under the head row, generous
  // whitespace throughout. The "default" theme for new installs going
  // forward — feels current without being aggressively styled.
  if (t === 'studio') return `
    body { font-family: ${profile?.font_family || "'Source Sans 3', 'Inter', system-ui, sans-serif"}; color: #1f2937; }
    .hdr { padding-left: 14px; border-left: 4px solid ${accent}; margin-left: -14px; }
    .hdr-name { font-size: 1.6em; font-weight: 700; letter-spacing: -0.4px; color: #111; }
    .hdr-sub { font-size: .88em; color: #6b7280; }
    .doc-type { border: none; padding: 0; font-size: .72em; letter-spacing: 2px; text-transform: uppercase; color: ${accent}; font-weight: 600; margin-top: 4mm; }
    table.items { font-size: .92em; }
    table.items th, table.items td { border: none; padding: 7px 8px; }
    table.items th { background: transparent; color: #9ca3af; font-weight: 600; font-size: .72em; text-transform: uppercase; letter-spacing: 1.2px; border-bottom: 1.5px solid ${accent}; }
    table.items tbody tr + tr { border-top: 1px solid #f3f4f6; }
    .tot-grand { border-top: 2px solid ${accent}; border-bottom: none; color: ${accent}; padding: 6px 0 0; font-size: 1.25em; }
    .tot-words { color: #6b7280; }
    .fb { border-top: none; padding-top: 5mm; }
    .sig-line { border-color: ${accent}; }
  `;
  // Cash Memo — classic Indian retail cash-memo print. Full-page hairline
  // frame, large centered serif shop name, dedicated "CASH MEMO" box
  // pinned to the top-right (with bill number + date inside), bordered
  // ruled items table, and a hairline-bordered totals strip flush with
  // the page frame. The doc-subtitle in the right cell reads from the
  // meta-block's `data-doc` attribute (emitted by renderA4) so the user's
  // Print-Settings override (or the per-doc-type default) flows through
  // automatically — leave doc_label blank for "TAX INVOICE" /
  // "PURCHASE BILL", or set "CASH MEMO", "ESTIMATE", "BILL OF SUPPLY", etc.
  if (t === 'cashmemo') return `
    body { color: #000; font-family: ${profile?.font_family || "'Source Sans 3', system-ui, sans-serif"}; }
    .page { border: 1px solid #000; padding: 0; }

    /* Header band — centered, large serif shop name, hairline rule below. */
    .hdr { text-align: center; padding: 5mm 8mm 4mm; border-bottom: 1px solid #000; margin: 0; }
    .hdr-name { font-family: 'Times New Roman', Georgia, serif; font-size: 2.4em; font-weight: 800;
                letter-spacing: 1.5px; line-height: 1.05; }
    .hdr-sub { font-size: .9em; color: #000; margin-top: 1px; }
    .hdr-extra { font-size: .85em; margin-top: 2px; }
    .logo { max-height: 48px; }
    /* Doc-type lives inside the right meta box — hide the header copy. */
    .hdr .doc-type { display: none; }

    /* Two-cell meta band: bill-meta cell visually on the right (the
       CASH-MEMO box), party block on the left. Renderer emits bill-meta
       first then party, so flex-direction: row-reverse swaps them. */
    .meta { display: flex; flex-direction: row-reverse; margin: 0; gap: 0;
            border-bottom: 1px solid #000; min-height: 18mm; }
    .meta-block { padding: 0; flex: 1 1 0; min-width: 0; }

    /* Visually-RIGHT cell (DOM-first child) — title bar above, No/Date below. */
    .meta-block:first-child { border-left: 1px solid #000; display: flex; flex-direction: column; }
    .meta-block:first-child::before {
      content: attr(data-doc);
      display: block;
      text-align: left;
      font-weight: 700;
      font-size: 1em;
      letter-spacing: 1.2px;
      text-transform: uppercase;
      border-bottom: 1px solid #000;
      padding: 2.2mm 5mm;
    }
    .meta-block:first-child > div { padding: 1mm 5mm; }
    .meta-block:first-child > div:first-of-type { padding-top: 2mm; }
    .meta-block:first-child b { display: inline-block; min-width: 56px; font-weight: 400; color: #000; }

    /* Visually-LEFT cell — party. Drop the existing 'BILL TO' eyebrow
       (the cash-memo style names parties inline rather than under a label). */
    .meta-block:last-child { padding: 3mm 5mm; }
    .meta-block:last-child > div:first-child { display: none; }
    .party { line-height: 1.6; font-size: .96em; }

    /* Items table — hairline borders all the way through, uppercase head row,
       no shaded fill. Outer columns lose their left/right border so the
       table sits flush against the page frame. */
    table.items { margin: 0; border: none; }
    table.items th, table.items td { border: 1px solid #000; padding: 4px 7px; }
    table.items thead tr th { border-top: none; }
    table.items th:first-child, table.items td:first-child { border-left: none; }
    table.items th:last-child,  table.items td:last-child  { border-right: none; }
    table.items th { background: transparent; text-transform: uppercase; font-weight: 700;
                     font-size: .9em; letter-spacing: 0.4px; }

    /* Totals — full width, hairline rules between rows, flush with the frame. */
    .totals { width: 100%; margin: 0; border-top: 1px solid #000; }
    .tot-row { padding: 4px 8mm; border-bottom: 1px solid #000; }
    .tot-grand { padding: 5px 8mm; border: none; border-bottom: 1px solid #000; font-weight: 700;
                 font-size: 1.05em; letter-spacing: 0.5px; }
    .tot-words { padding: 4mm 8mm; font-style: normal; font-size: .92em;
                 border-bottom: 1px solid #000; }

    /* Footer — signature anchored to the bottom-left of the frame. */
    .fb { padding: 4mm 8mm 6mm; margin: 0; grid-template-columns: 1fr 1fr; }
    .fb-bank, .fb-tc, .fb-extra { padding: 2mm 0; }
    .fb-sig { grid-column: 1; text-align: left; margin-top: 6mm; }
    .sig-line { border-color: #000; max-width: 60mm; margin-bottom: 1mm; }
  `;
  // Wholesale — dense tabular B2B. Mono numerics so columns align
  // optically across rows, subtle row stripes, solid total banner. Built
  // for trade where the operator scans columns of numbers fast.
  if (t === 'wholesale') return `
    body { font-family: ${profile?.font_family || "'Source Sans 3', system-ui, sans-serif"}; color: #111; }
    .hdr-name { font-weight: 800; letter-spacing: -0.2px; font-size: 1.35em; }
    .doc-type { border: 1.5px solid #111; padding: 3px 10px; display: inline-block; font-weight: 700; letter-spacing: 1.5px; font-size: .85em; }
    table.items { font-variant-numeric: tabular-nums; }
    table.items th { background: #f3f4f6; color: #111; font-weight: 700; font-size: .8em; text-transform: uppercase; letter-spacing: 0.8px; border: 1px solid #d1d5db; }
    table.items td { border: 1px solid #e5e7eb; padding: 4px 6px; }
    table.items tbody tr:nth-child(even) td { background: #fafafa; }
    .c-qty, .c-rate, .c-mrp, .c-disc, .c-tax, .c-amt {
      font-family: 'JetBrains Mono', 'Consolas', 'Menlo', 'Courier New', monospace;
      font-feature-settings: 'tnum';
    }
    .tot-grand { background: #111; color: #fff; border: none; padding: 8px 12px; margin-top: 3mm; font-size: 1.15em; letter-spacing: 0.5px; }
    .tot-words { font-style: normal; font-weight: 600; }
  `;
  return '';  // classic = base CSS only
};

const baseCSS = (profile) => `
  * { box-sizing: border-box; }
  html, body { background: #fff; color: #111; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
  body {
    margin: 0;
    /* Always lead with Source Sans 3 (the software's UI font) so prints
       visually match the app. Profile-specific font_family — including
       legacy Courier values from older saved profiles — falls in as a
       later option after the system sans-serif chain. Modern themes
       (studio / wholesale / elegant) override the body font-family in
       their own theme block when they want a different look. */
    font-family: 'Source Sans 3', 'Source Sans 3 Variable', 'Segoe UI', system-ui, -apple-system, ${profile?.font_family || ''}, 'Helvetica Neue', Arial, sans-serif;
    font-size: ${profile?.font_size_pt || 10}pt;
    line-height: ${profile?.line_spacing || 1.35};
  }
  .page { padding: 0; }
  .hdr { margin-bottom: 8mm; }
  .hdr-name { font-size: 1.5em; font-weight: 700; letter-spacing: .3px; }
  .hdr-sub { font-size: .9em; color: #444; }
  .hdr-extra { margin-top: 4px; font-size: .9em; }
  .logo { max-height: 60px; margin-bottom: 4px; }
  .doc-type { margin-top: 8px; font-weight: 700; letter-spacing: 2px; font-size: 1.1em; }
  .meta { display: flex; justify-content: space-between; margin: 6mm 0; gap: 8mm; }
  .meta-block b { display: inline-block; min-width: 80px; }
  .party { line-height: 1.4; }
  table.items { width: 100%; border-collapse: collapse; margin: 4mm 0; font-size: .9em; }
  table.items th, table.items td { border: 1px solid #666; padding: 4px 6px; }
  table.items th { background: #f0f0f0; text-align: left; }
  .c-qty, .c-rate, .c-mrp, .c-disc, .c-tax, .c-amt { text-align: right; white-space: nowrap; }
  .c-sn { width: 28px; text-align: center; }
  .totals { margin-top: 4mm; margin-left: auto; width: 60%; }
  .tot-row { display: flex; justify-content: space-between; padding: 2px 0; }
  .tot-grand { display: flex; justify-content: space-between; font-weight: 700; font-size: 1.1em;
    border-top: 2px solid #000; border-bottom: 2px solid #000; padding: 4px 0; margin-top: 3mm; }
  .tot-words { margin-top: 2mm; font-style: italic; font-size: .9em; }
  .fb { margin-top: 8mm; display: grid; grid-template-columns: 1fr 1fr; gap: 6mm; font-size: .85em; }
  .fb-bank, .fb-tc, .fb-extra, .fb-legal { grid-column: 1 / -1; }
  /* Bank-with-QR layout: rows on the left, QR on the right (only when a UPI
     QR is present; otherwise the rows take full width). */
  .fb-bank { display: flex; gap: 6mm; align-items: flex-start; justify-content: space-between; }
  .fb-bank-rows { flex: 1; line-height: 1.4; }
  .fb-bank-rows > b { display: block; margin-bottom: 1mm; }
  .fb-qr { text-align: center; flex: 0 0 auto; }
  .fb-qr img { width: 28mm; height: 28mm; display: block; }
  .fb-qr-cap { font-size: .75em; color: #444; margin-top: 1mm; letter-spacing: .3px; }
  .fb-legal { font-size: .82em; font-style: italic; color: #333; text-align: center;
              border-top: 1px dashed #d1d5db; padding-top: 2mm; }
  .fb-sig { grid-column: 2; text-align: center; margin-top: 16mm; }
  .fb-sig-img { max-height: 14mm; max-width: 50mm; display: block; margin: 0 auto 1mm; }
  .sig-line { border-top: 1px solid #000; margin-bottom: 2mm; }
  @media print {
    .page { page-break-after: always; }
    .page:last-child { page-break-after: auto; }
  }
  ${themeCSS(profile)}
`;

/* ── thermal styles ───────────────────────────────────────────────────
 * Five layouts tuned for 58/80mm rolls. They only vary typography, borders,
 * spacing — field set stays constant so a profile swap is always safe.
 *   • standard  — classic POS receipt, dashed separators
 *   • compact   — tight spacing for long bills, solid hairlines
 *   • bold      — all-caps headers, heavy rules — maximum impact on faint printers
 *   • spacious  — larger item rows, generous padding for clarity
 *   • modern    — inverted doc-type chip, thin underlines, sans-serif
 * ──────────────────────────────────────────────────────────────────── */
const thermalStyleCSS = (style, accent) => {
  switch (style) {
    case 'simple': return `
      /* Inspired by the classic POS credit-memo print — zero decoration,
         tabular item rows, dashed separators only. Optimized for legibility
         on a 3-inch thermal roll. */
      .hdr { margin-bottom: 2mm; }
      .hdr-name { font-size: 1.2em; letter-spacing: 1px; }
      .hdr-sub { font-size: .85em; margin-top: 0.5mm; }
      .doc-type { margin-top: 1mm; border: none; padding: 0; letter-spacing: 1.5px; font-size: 1em; }
      .s-meta { font-size: .92em; margin: 1.5mm 0; }
      .s-row { display: flex; justify-content: space-between; padding: 0.3mm 0; }
      .s-row span:only-child { flex: 1; }
      table.s-items { width: 100%; border-collapse: collapse; font-size: .88em;
                      table-layout: fixed; font-variant-numeric: tabular-nums; }
      /* overflow:hidden on every cell stops column content from visually
         bleeding into the neighbour when the chosen font is wider than the
         column can fit. Without this, right-aligned numeric columns end up
         mashed together (e.g. "250.001181.25"). */
      table.s-items th,
      table.s-items td { overflow: hidden; vertical-align: top; padding: 0.4mm 2px;
                         line-height: 1.25; }
      table.s-items th { text-align: left; font-weight: inherit; letter-spacing: 0.3px; }
      table.s-items .s-sr { width: 8%;  text-align: left;  padding-left: 0; white-space: nowrap; }
      table.s-items .s-nm { width: 44%; text-align: left;  word-wrap: break-word;
                            overflow-wrap: anywhere; padding-right: 3px; }
      table.s-items .s-qt { width: 12%; text-align: right; white-space: nowrap; padding-right: 3px; }
      table.s-items .s-rt { width: 17%; text-align: right; white-space: nowrap; padding-right: 3px; }
      table.s-items .s-am { width: 19%; text-align: right; white-space: nowrap; padding-right: 0; }
      .s-summary { font-size: .95em; margin: 0.5mm 0; }
      .s-total { text-align: right; font-size: 1.15em; padding: 0.5mm 0; letter-spacing: 0.5px; }
      .fb { text-align: center; border-top: none; padding-top: 2mm; font-size: .9em;
            letter-spacing: 0.3px; }
    `;
    case 'compact': return `
      .hdr { margin-bottom: 1.5mm; }
      .hdr-name { font-size: 1.05em; }
      .hdr-sub { font-size: .78em; }
      .doc-type { margin-top: 1mm; border: 1px solid #000; padding: 0.5mm 2mm; letter-spacing: 1px; }
      .party { margin: 1mm 0; padding: 1mm 0; }
      table.items { margin: 1mm 0; font-size: .82em; }
      table.items td { padding: 0.5px 0; line-height: 1.15; }
      .hrb { margin: 1mm 0; }
      .t-row { font-size: .85em; line-height: 1.2; }
      .t-grand { font-size: 1em; padding: 0.5mm 0; margin: 0.5mm 0; }
    `;
    case 'bold': return `
      .hdr { margin-bottom: 3mm; }
      .hdr-name { font-size: 1.35em; text-transform: uppercase; letter-spacing: 1px; }
      .doc-type { font-size: .95em; border: 2px solid #000; padding: 1mm 3mm; letter-spacing: 2px; text-transform: uppercase; }
      .party { border-width: 2px; border-style: solid none; padding: 2.5mm 0; font-weight: 700; }
      .hrb { border-top-width: 2px; border-top-style: solid; }
      .it-name { font-weight: 800; text-transform: uppercase; letter-spacing: 0.2px; }
      .t-grand { font-size: 1.25em; border-width: 2px 0; padding: 1.5mm 0; }
      table.items th, table.items td { font-weight: 700; }
    `;
    case 'spacious': return `
      body { line-height: 1.5; }
      .hdr { margin-bottom: 5mm; }
      .hdr-name { font-size: 1.25em; margin-bottom: 1mm; }
      .doc-type { margin-top: 3mm; padding: 1.5mm 3mm; letter-spacing: 3px; }
      .meta-row { margin: 3mm 0; }
      .party { margin: 3mm 0; padding: 3mm 0; }
      table.items { margin: 3mm 0; }
      table.items td { padding: 2px 0; }
      .hrb { margin: 3mm 0; }
      .t-row { padding: 1mm 0; }
      .t-grand { font-size: 1.2em; padding: 2mm 0; margin: 2mm 0; }
      .fb { margin-top: 5mm; }
    `;
    case 'editorial': return `
      /* Editorial — magazine-style receipt. Big display-serif title,
         italic labels, bold body text, hairline separators. The boutique
         look. Inherits the Simple table structure (s-items / s-nm / etc.)
         and re-skins it with editorial typography. */
      body { font-family: 'Source Sans 3', 'Segoe UI', system-ui, sans-serif;
             color: #1a1a1a; line-height: 1.45; }
      .hdr { text-align: center; margin-bottom: 5mm; padding-bottom: 3mm; }
      .hdr-name { font-family: 'Playfair Display', 'Bodoni Moda', Georgia, 'Times New Roman', serif;
                   font-weight: 800; font-size: 2em; letter-spacing: -1px;
                   line-height: 1; margin-bottom: 1mm; }
      .hdr-sub { font-size: .75em; letter-spacing: 2px; text-transform: uppercase;
                  color: #666; font-weight: 500; }
      .doc-type { font-size: .65em; letter-spacing: 4px; text-transform: uppercase;
                   color: #666; border: none; padding: 0; margin-top: 2mm;
                   font-weight: 500; }
      /* Meta block — italic "Bill No :" "Date :" labels in the s-row spans */
      .s-meta { margin: 4mm 0 3mm; padding: 0; border: none; font-size: .92em; }
      .s-row { padding: 0.6mm 0; }
      .s-row span { font-weight: 700; }
      /* Re-style "Bill No :" / "Date :" / "Time :" / "Name :" prefixes via
         a font-style trick — the label sits left of the colon. CSS can't
         split text at ":", but in renderThermalSimple each s-row span is a
         "Label : Value" string. Italicize the whole thing softly, then
         the eye reads the label as italic-prefix + value. */
      .s-row span:first-child { font-weight: 400; }
      .hrb { border-top: 1px solid #c8c8c8; margin: 2mm 0; }
      table.s-items { margin: 4mm 0 2mm; }
      table.s-items th { font-style: italic; font-weight: 400;
                          color: #666; font-size: .82em; text-transform: none;
                          letter-spacing: 0.2px; padding-bottom: 2mm;
                          border-bottom: 1px solid #c8c8c8; }
      table.s-items td { padding: 2.5mm 1px; vertical-align: top;
                          border-bottom: 1px solid #ececec; }
      table.s-items .s-nm { font-weight: 700; color: #1a1a1a; }
      table.s-items .s-qt, table.s-items .s-rt, table.s-items .s-am {
        font-weight: 600; color: #333;
      }
      .s-summary { font-size: .82em; color: #888; padding: 2mm 0;
                    font-style: italic; text-align: center; }
      .s-total { text-align: right; font-size: 1em; padding: 3mm 0;
                  border-top: 1px solid #c8c8c8; margin-top: 2mm;
                  letter-spacing: 0.3px; font-style: italic; font-weight: 400;
                  color: #666; }
      .fb { margin-top: 5mm; padding-top: 3mm; border-top: 1px solid #ececec;
            font-size: .82em; color: #666; text-align: center; line-height: 1.5; }
    `;
    case 'ruled': return `
      /* Ruled — clean rows with a hairline below each item. Inherits
         Simple's table structure and adds bottom-border on each row.
         Great when the operator wants visible row separation without
         the boxed-table look. */
      body { font-family: 'Source Sans 3', 'Segoe UI', system-ui, sans-serif;
             color: #1a1a1a; }
      .hdr { margin-bottom: 3mm; padding-bottom: 2mm; text-align: center;
              border-bottom: 1px solid #c8c8c8; }
      .hdr-name { font-size: 1.25em; font-weight: 800; letter-spacing: -0.2px; }
      .hdr-sub { font-size: .82em; color: #555; }
      .doc-type { font-size: .75em; letter-spacing: 2px; text-transform: uppercase;
                   color: #666; padding: 0; border: none; margin-top: 1.5mm;
                   font-weight: 600; }
      .s-meta { margin: 3mm 0; padding: 2mm 0;
                 border-top: 1px solid #d8d8d8; border-bottom: 1px solid #d8d8d8;
                 font-size: .9em; }
      .s-row { padding: 0.4mm 0; }
      table.s-items { margin: 3mm 0 2mm; font-size: .92em; }
      table.s-items th { background: transparent; color: #555; font-weight: 700;
                          font-size: .76em; letter-spacing: 0.6px; text-transform: uppercase;
                          border: none; border-bottom: 1.5px solid #1a1a1a;
                          padding: 2mm 1px; }
      table.s-items td { border: none; border-bottom: 1px solid #d8d8d8;
                          padding: 2mm 1px; vertical-align: top; }
      table.s-items tbody tr:last-child td { border-bottom: 1.5px solid #1a1a1a; }
      table.s-items .s-nm { font-weight: 600; }
      .hrb { display: none; }
      .s-summary { padding: 2mm 0; font-size: .85em; color: #555; }
      .s-total { border-top: 2px solid #1a1a1a; border-bottom: 2px solid #1a1a1a;
                  padding: 2.5mm 0; margin-top: 2mm; font-size: 1.15em;
                  font-weight: 800; text-align: right; letter-spacing: 0.3px; }
      .fb { margin-top: 4mm; padding-top: 3mm;
             border-top: 1px solid #c8c8c8; font-size: .85em; color: #555;
             text-align: center; }
    `;
    case 'modern': return `
      body { font-family: 'Source Sans 3', 'Helvetica Neue', Arial, sans-serif; }
      .hdr { margin-bottom: 3mm; }
      .hdr-name { font-size: 1.2em; letter-spacing: -0.3px; color: ${accent}; }
      .doc-type { background: ${accent}; color: #fff; border: none; padding: 1mm 3mm; border-radius: 2px;
                   font-size: .8em; letter-spacing: 2.5px; display: inline-block; }
      .party { border-top: 1px solid #000; border-bottom: 1px solid #000; border-style: solid; }
      table.items { font-size: .88em; }
      .it-name { letter-spacing: 0.1px; }
      .hrb { border-top: 1px solid #000; }
      .t-grand { border: none; background: #000; color: #fff; padding: 1.5mm 2mm; margin: 2mm 0;
                 border-radius: 2px; letter-spacing: 0.5px; }
      .t-grand * { color: #fff; }
    `;
    default: return '';  // standard = base CSS only
  }
};

// Bold/darkness preset. Thermal paper reproduces black as a function of heat
// energy delivered — a low font-weight translates into thin, faint characters
// no matter how good the printer is. These weights are tuned empirically so
// 'bold' (the default) is readable on a cheap 58mm printer.
const boldLevelCSS = (level) => {
  const presets = {
    light:  { body: 400, header: 600, total: 700, stroke: 0 },
    normal: { body: 500, header: 700, total: 800, stroke: 0 },
    bold:   { body: 600, header: 800, total: 900, stroke: 0 },
    heavy:  { body: 700, header: 900, total: 900, stroke: 0.25 },
  };
  const p = presets[level] || presets.bold;
  return `
    body { font-weight: ${p.body}; }
    .hdr-name { font-weight: ${p.header}; }
    .doc-type, .it-name, .party b { font-weight: ${p.header}; }
    .t-grand, .t-grand * { font-weight: ${p.total}; }
    ${p.stroke ? `body { -webkit-text-stroke: ${p.stroke}px #000; }` : ''}
  `;
};

const thermalCSS = (profile) => {
  const accent = profile?.accent_color || '#000';
  const style  = profile?.thermal_style || 'standard';
  const bold   = profile?.bold_level    || 'bold';
  // Thermal default font now matches the software's Editorial typography
  // (Source Sans 3 → Segoe UI → system) with tabular numerals for clean
  // column alignment. The previous Courier monospace default felt dated
  // and didn't match the on-screen experience. Operators who want the
  // classic POS look can still pick Courier from the Font preset list.
  return `
  * { box-sizing: border-box; }
  /* Pure black text + explicit white background. Thermal drivers otherwise
     skip any element without a declared color and produce a blank roll;
     accent color is NEVER applied to body text on thermal because even
     "dark" hex values render as mid-gray through the thermal head. */
  html, body { background: #fff !important; color: #000 !important;
    -webkit-print-color-adjust: exact; print-color-adjust: exact;
    text-rendering: geometricPrecision; }
  body {
    margin: 0;
    /* Source Sans 3 is ALWAYS the primary font for thermal — matches the
       software UI typography. The profile-saved font_family (which on
       legacy installs may still be Courier monospace) acts as a
       fallback only, after the system sans-serif chain. This means an
       operator never has to manually update old profiles to get the
       refreshed look; their existing saved settings still apply if the
       sans-serif chain is not available, but on any modern browser /
       Electron build Source Sans 3 (or Segoe UI on Windows) wins. */
    font-family: 'Source Sans 3', 'Source Sans 3 Variable', 'Segoe UI', system-ui, -apple-system, 'Helvetica Neue', Arial, ${profile?.font_family || ''}, sans-serif;
    font-size: ${profile?.font_size_pt || 10}pt;
    line-height: 1.3;
    width: ${profile?.paper_width_mm || 80}mm;
    /* Tabular numerals so digits column-align even with a proportional
       sans-serif body font — keeps Qty/Rate/Amount columns reading
       cleanly without forcing Courier on the whole document. */
    font-variant-numeric: tabular-nums;
    font-feature-settings: 'tnum';
    -webkit-font-smoothing: antialiased;
  }
  /* Two-column layout for label/value rows in the meta block AND the
     totals breakdown - declared at the base level so every simple-style
     receipt (simple / editorial / ruled) gets the same alignment. Without
     this, the label and value spans collapse inline and read as
     "Sub TotalRs 4,230" instead of "Sub Total ........... Rs 4,230". */
  .s-row { display: flex; justify-content: space-between; gap: 6px; padding: 0.4mm 0; }
  .s-row > span { flex: 0 0 auto; }
  .s-row > span:only-child { flex: 1; }
  /* Items table - full width with fixed column proportions. Declared at
     the base level so simple / editorial / ruled all share the SAME
     layout (just different chrome). Earlier these rules lived only in
     the simple-style block, so editorial / ruled rendered the table
     at content-width - squishing all five columns into the left half of
     the receipt and leaving the right half empty. */
  table.s-items { width: 100%; border-collapse: collapse;
                  table-layout: fixed; font-variant-numeric: tabular-nums; }
  table.s-items th,
  table.s-items td { overflow: hidden; vertical-align: top; padding: 0.4mm 2px;
                     line-height: 1.25; }
  table.s-items th { text-align: left; font-weight: inherit; letter-spacing: 0.3px; }
  table.s-items .s-sr { width: 8%;  text-align: left;  padding-left: 0; white-space: nowrap; }
  table.s-items .s-nm { width: 44%; text-align: left;  word-wrap: break-word;
                        overflow-wrap: anywhere; padding-right: 3px; }
  table.s-items .s-qt { width: 12%; text-align: right; white-space: nowrap; padding-right: 3px; }
  table.s-items .s-rt { width: 17%; text-align: right; white-space: nowrap; padding-right: 3px; }
  table.s-items .s-am { width: 19%; text-align: right; white-space: nowrap; padding-right: 0; }
  /* Numeric cells reinforce tabular nums explicitly so even profiles that
     override body font (back to Courier, etc.) keep numeric alignment. */
  .c-qty, .c-rate, .c-mrp, .c-disc, .c-tax, .c-amt,
  .s-qt, .s-rt, .s-am,
  .t-grand, .s-total, .meta-row {
    font-variant-numeric: tabular-nums;
    font-feature-settings: 'tnum';
  }
  /* Force black ink on every text node inside the receipt. Authors of
     custom header/footer HTML can override by inlining styles, but the
     default must always be readable. */
  .page, .page * { color: #000 !important; }
  .page { padding: 0; }
  .hdr { text-align: center; margin-bottom: 3mm; }
  .hdr-name { font-size: 1.18em; letter-spacing: .3px; }
  .hdr-sub { font-size: .85em; }
  .doc-type { margin-top: 2mm; border: 1px dashed #000; padding: 1mm 2mm; letter-spacing: 1.5px;
              display: inline-block; }
  .meta-row { display: flex; justify-content: space-between; font-size: .88em; margin: 2mm 0; }
  .party { font-size: .92em; margin: 2mm 0; border-top: 1px dashed #000; border-bottom: 1px dashed #000;
           padding: 2mm 0; }
  table.items { width: 100%; border-collapse: collapse; margin: 2mm 0; font-size: .92em; }
  table.items td { padding: 1px 0; }
  .it-qty { text-align: right; font-variant-numeric: tabular-nums; }
  .hrb { border-top: 1px dashed #000; margin: 2mm 0; }
  .t-row { display: flex; justify-content: space-between; font-size: .95em; }
  .t-grand { font-size: 1.15em; border-top: 1.5px solid #000; border-bottom: 1.5px solid #000;
             padding: 1mm 0; margin: 1mm 0; }
  .fb { margin-top: 3mm; text-align: center; font-size: .82em; white-space: pre-wrap;
        border-top: 1px dashed #000; padding-top: 2mm; }
  @media print { .page { page-break-after: always; } .page:last-child { page-break-after: auto; } }
  ${thermalStyleCSS(style, accent)}
  ${boldLevelCSS(bold)}
`;
};

/* ── renderers per format ───────────────────────────────────────────── */

function renderA4(bill, profile, company, opts = {}) {
  const items = bill.items || [];
  // Doc subtitle exposed to CSS via data-doc on the bill-meta block. The
  // cashmemo theme reads it through `content: attr(data-doc)` to render
  // the boxed CASH-MEMO header on the right side of the page; every
  // other theme ignores the attribute. Resolution chain matches the
  // header doc-type chip: explicit profile override first, then the
  // per-doc-type default, then "BILL".
  const docLabel = (profile?.doc_label || '').trim()
    || DOC_LABEL[bill.__doctype]
    || 'BILL';
  return `
    <div class="page">
      ${renderHeader(profile, company, bill)}
      <div class="meta">
        <div class="meta-block" data-doc="${esc(docLabel)}">
          <div><b>Bill #:</b> ${esc(bill.bill_number || bill.transaction_number || '')}</div>
          <div><b>Date:</b> ${esc(fmtDate(bill.bill_date || bill.transaction_date))}</div>
          ${bill.sale_type ? `<div><b>Type:</b> ${esc(bill.sale_type)}</div>` : ''}
        </div>
        <div class="meta-block">
          <div style="font-size:.75em;letter-spacing:1px;color:#666">BILL TO</div>
          ${renderPartyBlock(bill)}
        </div>
      </div>
      ${items.length ? renderItemsTable(items, profile) : ''}
      ${bill.total_amount != null ? renderTotals(bill, profile) : ''}
      ${renderFooter(profile, company, opts)}
    </div>
  `;
}

function renderA5(bill, profile, company, opts) {
  // A5 is identical structure but smaller default font + single-column totals
  return renderA4(bill, profile, company, opts);
}

/* Simple style — matches the classic POS credit-memo print: a tabular
 * Sr.No | ITEMS | QTY RATE AMT layout with one row per item, summary line
 * showing item / qty counts, and a single TOTAL at the bottom. No GST
 * breakdown, no sub-total — just the final number. */
function renderThermalSimple(bill, profile, company) {
  const items = bill.items || [];
  const totalQty = items.reduce((s, it) => s + Number(it.quantity || 0), 0);
  const party = bill.customer || bill.supplier || bill.party || {};
  const partyName = party.party_name || 'CASH';
  const fmtTime = (d) => {
    if (!d) return '';
    const x = new Date(d);
    if (isNaN(x.getTime())) return '';
    return x.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', hour12: true });
  };
  // Integer-rounded — decimals are removed for the clean POS look. Thousands
  // separator uses profile locale so 12500 stays '12,500' (en-IN) / '12500'
  // depending on setting; columns stay narrow either way.
  const fmtInt = (n) => Math.round(Number(n || 0)).toLocaleString(profile?.locale_format || 'en-IN');
  const qtyInt = (n) => {
    const v = Number(n || 0);
    return Number.isInteger(v) ? String(v) : v.toLocaleString('en-IN', { maximumFractionDigits: 2 });
  };
  const rows = items.map((it, i) => {
    const qtyCell = qtyInt(it.quantity) + (it.unit ? esc(it.unit) : '');
    return `
      <tr>
        <td class="s-sr">${i + 1}</td>
        <td class="s-nm">${esc(it.product_name || '')}</td>
        <td class="s-qt">${qtyCell}</td>
        <td class="s-rt">${fmtInt(it.rate || it.purchase_rate)}</td>
        <td class="s-am">${fmtInt(it.total_amount)}</td>
      </tr>
    `;
  }).join('');
  // Thermal: structured address but compact — collapse multi-line into a
  // single comma-joined line so a 58mm/80mm receipt doesn't burn 4 lines
  // on the header. Still falls back to the legacy blob inside buildAddressLines.
  const thermalAddr = buildAddressLines(company).join(', ');
  return `
    <div class="page">
      <div class="hdr">
        <div class="hdr-name">${esc(profile?.header_title || company?.company_name || 'Shop')}</div>
        ${thermalAddr ? `<div class="hdr-sub">${esc(thermalAddr)}</div>` : ''}
        ${company?.gstin ? `<div class="hdr-sub">GSTIN: ${esc(company.gstin)}</div>` : ''}
        ${company?.company_phone ? `<div class="hdr-sub">Ph: ${esc(company.company_phone)}</div>` : ''}
        <div class="doc-type">${esc(DOC_LABEL[bill.__doctype] || 'BILL')}${bill.__copyLabel ? ` - ${esc(bill.__copyLabel)}` : ''}</div>
      </div>
      <div class="s-meta">
        <div class="s-row">
          <span>Bill No : ${esc(bill.bill_number || bill.transaction_number || '')}</span>
          <span>Date : ${esc(fmtDate(bill.bill_date || bill.transaction_date))}</span>
        </div>
        ${fmtTime(bill.bill_date || bill.transaction_date)
          ? `<div class="s-row"><span>Time : ${esc(fmtTime(bill.bill_date || bill.transaction_date))}</span></div>`
          : ''}
        <div class="s-row"><span>Name : ${esc(partyName)}</span></div>
      </div>
      <div class="hrb"></div>
      <table class="s-items">
        <thead>
          <tr>
            <th class="s-sr">#</th>
            <th class="s-nm">ITEMS</th>
            <th class="s-qt">QTY</th>
            <th class="s-rt">RATE</th>
            <th class="s-am">AMT</th>
          </tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>
      <div class="hrb"></div>
      <div class="s-summary">Items= ${items.length}&nbsp;&nbsp;&nbsp;Qty= ${qtyInt(totalQty)}</div>
      <div class="hrb"></div>
      ${renderSimpleBreakdown(bill, profile, fmtInt)}
      <div class="s-total">TOTAL : ${(profile?.currency_symbol ?? 'Rs ')}${fmtInt(bill.total_amount)}</div>
      ${renderSimpleTail(bill, profile, fmtInt)}
      <div class="hrb"></div>
      ${profile?.footer_html
        ? `<div class="fb">${profile.footer_html}</div>`
        : `<div class="fb">Thank You !!!  Come Again. :)</div>`}
    </div>
  `;
}

/* Optional breakdown lines between the Items= summary and the grand TOTAL.
 * Each line is gated on its toggle AND a non-zero value — so turning a
 * toggle off OR the amount being zero means nothing prints. Keeps the
 * receipt uncluttered when there's nothing to report. */
function renderSimpleBreakdown(bill, profile, fmtInt) {
  const showDisc = profile?.show_discount !== false;
  const showGst  = profile?.show_gst !== false;
  const showPrev = profile?.show_previous_balance === true;   // off by default
  const sym      = profile?.currency_symbol ?? 'Rs ';
  const sub      = Number(bill.sub_total || 0);
  const disc     = Number(bill.discount_amount || 0);
  const gst      = Number(bill.cgst_amount||0) + Number(bill.sgst_amount||0) + Number(bill.igst_amount||0);
  const round    = Number(bill.round_off || 0);
  // Previous balance: prefer an API-supplied snapshot; fall back to deriving
  // from party's current_balance minus the contribution of THIS bill.
  const party    = bill.customer || bill.supplier || bill.party || {};
  const prev = bill.previous_balance != null
    ? Number(bill.previous_balance)
    : Math.max(0, Number(party.current_balance || 0) - Number(bill.balance_amount || 0));
  const rows = [];
  if (showPrev && prev > 0)     rows.push(['Previous Bal', fmtInt(prev)]);
  // Always show sub-total when ANY breakdown row is about to render — a bare
  // Sub Total next to TOTAL without any intermediate rows is clutter.
  const hasBreakdown = (showDisc && disc) || (showGst && gst) || round;
  if (hasBreakdown)             rows.push(['Sub Total',    fmtInt(sub)]);
  if (showDisc && disc)         rows.push(['Discount', '-' + fmtInt(disc)]);
  if (showGst  && gst)          rows.push(['GST',          fmtInt(gst)]);
  if (round)                    rows.push(['Round Off',    fmtInt(round)]);
  if (!rows.length) return '';
  return rows.map(([l, v]) =>
    `<div class="s-row"><span>${l}</span><span>${sym}${v}</span></div>`
  ).join('') + '<div class="hrb"></div>';
}

/* Post-TOTAL rows: Return credit (items the customer brought back in THIS
 * transaction — stored on bill.return_amount), Paid, and Balance Due. Each
 * line is gated on presence of a value. */
function renderSimpleTail(bill, profile, fmtInt) {
  const showReturn = profile?.show_return_amount !== false;
  const sym     = profile?.currency_symbol ?? 'Rs ';
  const retAmt  = Number(bill.return_amount || 0);
  const paid    = Number(bill.paid_amount || 0);
  const balance = Number(bill.balance_amount || 0);
  const rows = [];
  if (showReturn && retAmt > 0) rows.push(['Return',      '-' + fmtInt(retAmt)]);
  if (paid > 0)                 rows.push(['Paid',              fmtInt(paid)]);
  if (balance > 0)              rows.push(['Balance Due',       fmtInt(balance)]);
  if (!rows.length) return '';
  return '<div class="hrb"></div>' + rows.map(([l, v]) =>
    `<div class="s-row"><span>${l}</span><span>${sym}${v}</span></div>`
  ).join('');
}

function renderThermal(bill, profile, company) {
  // Three styles route through the cleaner Simple table-based renderer:
  //   simple    — the original clean credit-memo layout
  //   editorial — magazine-style serif title + italic labels (uses Simple's
  //               table structure for clarity, then layers editorial CSS)
  //   ruled     — Simple's table with a hairline below every row
  // Other styles (standard / compact / bold / spacious / modern) use the
  // legacy two-line item layout below.
  const style = profile?.thermal_style || 'standard';
  if (style === 'simple' || style === 'editorial' || style === 'ruled') {
    return renderThermalSimple(bill, profile, company);
  }
  const items = bill.items || [];
  const showDisc   = profile?.show_discount !== false;
  const showGst    = profile?.show_gst !== false;
  const showReturn = profile?.show_return_amount !== false;
  const showPrev   = profile?.show_previous_balance !== false;
  const party      = bill.customer || bill.supplier || bill.party || {};
  const prev = bill.previous_balance != null
    ? Number(bill.previous_balance)
    : Math.max(0, Number(party.current_balance || 0) - Number(bill.balance_amount || 0));
  const line = (a, b) => `<div class="t-row"><span>${a}</span><span>${b}</span></div>`;
  const itemsHtml = items.map((it, i) => `
    <tr>
      <td colspan="3" class="it-name">${i + 1}. ${esc(it.product_name || '')}</td>
    </tr>
    <tr>
      <td>${fmtQty(it.quantity)} x ${fmtMoney(it.rate || it.purchase_rate, profile)}</td>
      <td class="it-qty"></td>
      <td class="it-qty">${fmtMoney(it.total_amount, profile)}</td>
    </tr>
  `).join('');
  // Thermal address: collapse the structured columns into a single line for
  // the narrow paper. Same fallback chain as renderThermalSimple.
  const thermalAddr2 = buildAddressLines(company).join(', ');
  return `
    <div class="page">
      <div class="hdr">
        <div class="hdr-name">${esc(profile?.header_title || company?.company_name || 'Shop')}</div>
        ${thermalAddr2 ? `<div class="hdr-sub">${esc(thermalAddr2)}</div>` : ''}
        ${company?.gstin ? `<div class="hdr-sub">GSTIN: ${esc(company.gstin)}</div>` : ''}
        ${company?.company_phone ? `<div class="hdr-sub">Ph: ${esc(company.company_phone)}</div>` : ''}
        <div class="doc-type">${esc(DOC_LABEL[bill.__doctype] || 'BILL')}${bill.__copyLabel ? ` - ${esc(bill.__copyLabel)}` : ''}</div>
      </div>
      <div class="meta-row"><span>${esc(bill.bill_number || bill.transaction_number || '')}</span><span>${esc(fmtDate(bill.bill_date || bill.transaction_date))}</span></div>
      ${(() => {
        // Thermal-format party block. Mirrors renderPartyBlock's cash logic:
        // system Cash party prints as "Cash" + walk-in name on a 2nd line,
        // never the sentinel mobile_1 / GSTIN.
        const p = bill.customer || bill.supplier || bill.party || {};
        const isCash = !p.party_name || p.is_system_cash;
        const walkIn = String(bill.walk_in_name || '').trim();
        if (isCash) {
          return `<div class="party">Cash${walkIn ? '<br/>' + esc(walkIn) : ''}</div>`;
        }
        const phone = p.mobile_1 ? '<br/>' + esc(p.mobile_1) : '';
        return `<div class="party">${esc(p.party_name)}${phone}</div>`;
      })()}
      ${items.length ? `<table class="items"><tbody>${itemsHtml}</tbody></table>` : ''}
      <div class="hrb"></div>
      ${showPrev && prev > 0 ? line('Previous Bal', fmtMoney(prev, profile)) : ''}
      ${line('Sub Total', fmtMoney(bill.sub_total, profile))}
      ${showDisc && Number(bill.discount_amount||0) ? line('Disc', '-' + fmtMoney(bill.discount_amount, profile)) : ''}
      ${showGst && (Number(bill.cgst_amount||0) + Number(bill.sgst_amount||0) + Number(bill.igst_amount||0)) ?
        line('GST', fmtMoney(Number(bill.cgst_amount||0) + Number(bill.sgst_amount||0) + Number(bill.igst_amount||0), profile)) : ''}
      ${Number(bill.round_off||0) ? line('Round Off', fmtMoney(bill.round_off, profile)) : ''}
      <div class="t-grand"><span>TOTAL</span><span>${fmtMoney(bill.total_amount, profile)}</span></div>
      ${showReturn && Number(bill.return_amount||0) > 0
        ? line('Return', '-' + fmtMoney(bill.return_amount, profile)) : ''}
      ${bill.paid_amount != null && Number(bill.paid_amount) ? line('Paid', fmtMoney(bill.paid_amount, profile)) : ''}
      ${bill.balance_amount != null && Number(bill.balance_amount) > 0 ? line('Balance Due', fmtMoney(bill.balance_amount, profile)) : ''}
      ${profile?.footer_html ? `<div class="fb">${profile.footer_html}</div>` : ''}
      ${profile?.terms_and_conditions ? `<div class="fb">${esc(profile.terms_and_conditions)}</div>` : ''}
    </div>
  `;
}

/* ── top-level: produce a full HTML document ────────────────────────── */

export function renderBillHTML({ bill, profile, company, docType, upiQrDataUrl }) {
  // Tag the bill object so header/footer know what doc it is without a
  // separate parameter thread through every partial.
  const tagged = { ...bill, __doctype: docType };
  const css = profile.format === 'thermal' ? thermalCSS(profile) : baseCSS(profile);
  // Multi-copy: render N pages with different __copyLabel each.
  const rawLabels = (profile.copy_labels || 'Original').split(',').map(s => s.trim()).filter(Boolean);
  const n = Math.max(1, Number(profile.copies || 1));
  const labels = [];
  for (let i = 0; i < n; i++) labels.push(rawLabels[i] || rawLabels[rawLabels.length - 1] || '');

  const render =
    profile.format === 'thermal' ? renderThermal :
    profile.format === 'a5'      ? renderA5 :
                                   renderA4;
  // Pass the pre-computed UPI-QR data URL through to the A4/A5 renderers
  // via opts so the footer can embed it next to the bank rows. Thermal
  // skips it — too narrow to fit a usable QR.
  const opts = { upiQrDataUrl };
  const pages = labels.map(lbl => render({ ...tagged, __copyLabel: lbl }, profile, company, opts)).join('');

  // Page size directives for browser print fallback. Electron silent print
  // uses IPC-supplied dimensions, so @page is best-effort for the iframe.
  const pageRule = profile.format === 'thermal'
    ? `@page { size: ${profile.paper_width_mm || 80}mm auto; margin: ${profile.margin_top_mm || 3}mm ${profile.margin_right_mm || 3}mm ${profile.margin_bottom_mm || 3}mm ${profile.margin_left_mm || 3}mm; }`
    : `@page { size: ${profile.paper_width_mm || 210}mm ${profile.paper_height_mm || 297}mm; margin: ${profile.margin_top_mm || 10}mm ${profile.margin_right_mm || 10}mm ${profile.margin_bottom_mm || 10}mm ${profile.margin_left_mm || 10}mm; }`;

  // Always pull Source Sans 3 from Google Fonts so every print HTML
  // (silent print, iframe preview, PDF render) has the actual font
  // available — the on-screen app loads it via @fontsource, but the
  // print iframe and Electron silent-print offscreen window are
  // separate document contexts that don't inherit those font assets.
  // Including the link unconditionally keeps thermal AND A4 prints
  // visually consistent with the software UI, regardless of what the
  // operator's profile saved as font_family. preconnect makes the
  // first print fast; subsequent prints hit the disk cache.
  // Always pull Source Sans 3 (the software UI font). Also pull Playfair
  // Display whenever the active profile is the Editorial thermal style —
  // its display-serif title relies on it; without the font the title
  // falls back to Bodoni / Georgia / Times, which still reads cleanly
  // but doesn't match the editorial look. Loaded conditionally so other
  // styles don't pay the extra ~30KB font request.
  const wantsPlayfair = profile?.format === 'thermal' && profile?.thermal_style === 'editorial';
  const playfairImport = wantsPlayfair
    ? `<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Playfair+Display:wght@700;800;900&display=swap">`
    : '';
  const fontImport = `
    <link rel="preconnect" href="https://fonts.googleapis.com">
    <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
    <link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Source+Sans+3:wght@400;500;600;700;800&display=swap">
    ${playfairImport}`;

  return `<!doctype html>
<html><head><meta charset="utf-8"/>
<title>${esc((bill.bill_number || bill.transaction_number || 'Document'))}</title>
${fontImport}
<style>${pageRule}\n${css}</style>
</head><body>${pages}</body></html>`;
}
