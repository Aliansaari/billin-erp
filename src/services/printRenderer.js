/*
 * printRenderer.js — turns a (bill, profile, company) tuple into a complete
 * printable HTML document. Three format paths (a4 / a5 / thermal) share one
 * row renderer but layout/widths/padding differ.
 *
 * The HTML produced is self-contained (inline CSS, no external assets except
 * optional logo URL) so it can be fed straight to Electron's silent print or
 * dumped into an iframe for window.print() fallback.
 */

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
  return `
    <div class="hdr" style="text-align:${align}">
      ${logo}
      <div class="hdr-name">${title}</div>
      ${company?.company_address ? `<div class="hdr-sub">${esc(company.company_address)}</div>` : ''}
      ${company?.gstin ? `<div class="hdr-sub">GSTIN: ${esc(company.gstin)}${company?.pan_number ? ' · PAN: ' + esc(company.pan_number) : ''}</div>` : ''}
      ${profile?.header_html ? `<div class="hdr-extra">${profile.header_html}</div>` : ''}
      <div class="doc-type">${esc(DOC_LABEL[doc.__doctype] || 'DOCUMENT')}${doc.__copyLabel ? ` · ${esc(doc.__copyLabel)}` : ''}</div>
    </div>
  `;
};

const renderFooter = (profile) => {
  const parts = [];
  if (profile?.bank_details) parts.push(`<div class="fb-bank"><b>Bank Details:</b><br/>${profile.bank_details.replace(/\n/g, '<br/>')}</div>`);
  if (profile?.terms_and_conditions) parts.push(`<div class="fb-tc"><b>Terms &amp; Conditions:</b><br/>${profile.terms_and_conditions.replace(/\n/g, '<br/>')}</div>`);
  if (profile?.footer_html) parts.push(`<div class="fb-extra">${profile.footer_html}</div>`);
  const sig = profile?.show_signature
    ? `<div class="fb-sig"><div class="sig-line"></div><div>${esc(profile.signature_label || 'Authorised Signatory')}</div></div>`
    : '';
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
    return `<tr>${cols.map(c => `<td class="${c.cls}">${row[c.k]}</td>`).join('')}</tr>`;
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
  const showPrev   = profile?.show_previous_balance === true;
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
  const lines = [];
  if (p.party_name) lines.push(`<b>${esc(p.party_name)}</b>`);
  if (p.address_line1) lines.push(esc(p.address_line1));
  if (p.city || p.state) lines.push(esc([p.city, p.state].filter(Boolean).join(', ')));
  if (p.gstin) lines.push(`GSTIN: ${esc(p.gstin)}`);
  if (p.mobile_1) lines.push(`Mobile: ${esc(p.mobile_1)}`);
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
    body { font-family: ${profile?.font_family || "'Inter', 'Segoe UI', system-ui, sans-serif"}; }
    .hdr-name { font-weight: 800; color: ${accent}; letter-spacing: -0.5px; }
    .doc-type { border: none; background: ${accent}; color: #fff; padding: 5px 14px; border-radius: 4px; display: inline-block; letter-spacing: 3px; }
    table.items th, table.items td { border: none; border-bottom: 1px solid #e5e7eb; }
    table.items th { background: transparent; color: #6b7280; font-size: .75em; text-transform: uppercase; letter-spacing: 1px; border-bottom: 2px solid ${accent}; }
    .tot-grand { border-top: 2px solid ${accent}; border-bottom: none; color: ${accent}; }
  `;
  if (t === 'minimal') return `
    body { font-family: ${profile?.font_family || "'Inter', system-ui, sans-serif"}; color: #1f2937; }
    .hdr-name { font-weight: 600; font-size: 1.3em; }
    .doc-type { border: none; color: ${accent}; font-size: .85em; letter-spacing: 4px; margin-top: 4mm; }
    table.items th, table.items td { border: none; padding: 6px 8px; }
    table.items th { background: transparent; color: #9ca3af; font-weight: 500; font-size: .75em; text-transform: uppercase; letter-spacing: 1.5px; border-bottom: 1px solid #e5e7eb; }
    table.items tbody tr { border-bottom: 1px solid #f3f4f6; }
    .tot-grand { border-top: 1px solid #d1d5db; border-bottom: none; padding-top: 8px; font-size: 1.2em; }
    .sig-line { border-color: #d1d5db; }
  `;
  if (t === 'elegant') return `
    body { font-family: ${profile?.font_family || "'Fraunces', 'Georgia', serif"}; }
    .hdr-name { font-family: 'Fraunces', 'Georgia', serif; font-weight: 600; font-style: italic; font-size: 1.9em; color: ${accent}; }
    .hdr-sub { font-style: italic; letter-spacing: .5px; }
    .doc-type { font-family: 'Inter', sans-serif; font-size: .8em; letter-spacing: 4px; border: none; color: ${accent};
      border-top: 1px solid ${accent}; border-bottom: 1px solid ${accent}; padding: 4px 0; margin: 4mm auto; max-width: 40%; }
    table.items th { background: transparent; font-family: 'Inter', sans-serif; font-size: .75em; letter-spacing: 1.5px; text-transform: uppercase; border: none; border-bottom: 1.5px solid ${accent}; color: ${accent}; }
    table.items td { border: none; border-bottom: 1px solid #e5e7eb; padding: 8px 6px; }
    .tot-grand { font-family: 'Fraunces', 'Georgia', serif; font-size: 1.3em; border-top: 1.5px solid ${accent}; border-bottom: 1.5px solid ${accent}; color: ${accent}; }
  `;
  if (t === 'boxed') return `
    body { font-family: ${profile?.font_family || "'Inter', system-ui, sans-serif"}; }
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
  return '';  // classic = base CSS only
};

const baseCSS = (profile) => `
  * { box-sizing: border-box; }
  html, body { background: #fff; color: #111; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
  body {
    margin: 0;
    font-family: ${profile?.font_family || 'Inter, system-ui, sans-serif'};
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
  .fb-bank, .fb-tc, .fb-extra { grid-column: 1 / -1; }
  .fb-sig { grid-column: 2; text-align: center; margin-top: 16mm; }
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
    case 'modern': return `
      body { font-family: 'Inter', 'Helvetica Neue', Arial, sans-serif; }
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
    font-family: ${profile?.font_family || "'Courier New', 'Consolas', monospace"};
    font-size: ${profile?.font_size_pt || 10}pt;
    line-height: 1.3;
    width: ${profile?.paper_width_mm || 80}mm;
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

function renderA4(bill, profile, company) {
  const items = bill.items || [];
  return `
    <div class="page">
      ${renderHeader(profile, company, bill)}
      <div class="meta">
        <div class="meta-block">
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
      ${renderFooter(profile)}
    </div>
  `;
}

function renderA5(bill, profile, company) {
  // A5 is identical structure but smaller default font + single-column totals
  return renderA4(bill, profile, company);
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
  return `
    <div class="page">
      <div class="hdr">
        <div class="hdr-name">${esc(profile?.header_title || company?.company_name || 'Shop')}</div>
        ${company?.company_address ? `<div class="hdr-sub">${esc(company.company_address)}</div>` : ''}
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
  if ((profile?.thermal_style || 'standard') === 'simple') return renderThermalSimple(bill, profile, company);
  const items = bill.items || [];
  const showDisc   = profile?.show_discount !== false;
  const showGst    = profile?.show_gst !== false;
  const showReturn = profile?.show_return_amount !== false;
  const showPrev   = profile?.show_previous_balance === true;
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
  return `
    <div class="page">
      <div class="hdr">
        <div class="hdr-name">${esc(profile?.header_title || company?.company_name || 'Shop')}</div>
        ${company?.company_address ? `<div class="hdr-sub">${esc(company.company_address)}</div>` : ''}
        ${company?.gstin ? `<div class="hdr-sub">GSTIN: ${esc(company.gstin)}</div>` : ''}
        <div class="doc-type">${esc(DOC_LABEL[bill.__doctype] || 'BILL')}${bill.__copyLabel ? ` - ${esc(bill.__copyLabel)}` : ''}</div>
      </div>
      <div class="meta-row"><span>${esc(bill.bill_number || bill.transaction_number || '')}</span><span>${esc(fmtDate(bill.bill_date || bill.transaction_date))}</span></div>
      <div class="party">
        ${bill.customer?.party_name || bill.supplier?.party_name || bill.party?.party_name || 'Walk-in'}
        ${bill.customer?.mobile_1 || bill.supplier?.mobile_1 ? '<br/>' + esc(bill.customer?.mobile_1 || bill.supplier?.mobile_1) : ''}
      </div>
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

export function renderBillHTML({ bill, profile, company, docType }) {
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
  const pages = labels.map(lbl => render({ ...tagged, __copyLabel: lbl }, profile, company)).join('');

  // Page size directives for browser print fallback. Electron silent print
  // uses IPC-supplied dimensions, so @page is best-effort for the iframe.
  const pageRule = profile.format === 'thermal'
    ? `@page { size: ${profile.paper_width_mm || 80}mm auto; margin: ${profile.margin_top_mm || 3}mm ${profile.margin_right_mm || 3}mm ${profile.margin_bottom_mm || 3}mm ${profile.margin_left_mm || 3}mm; }`
    : `@page { size: ${profile.paper_width_mm || 210}mm ${profile.paper_height_mm || 297}mm; margin: ${profile.margin_top_mm || 10}mm ${profile.margin_right_mm || 10}mm ${profile.margin_bottom_mm || 10}mm ${profile.margin_left_mm || 10}mm; }`;

  return `<!doctype html>
<html><head><meta charset="utf-8"/>
<title>${esc((bill.bill_number || bill.transaction_number || 'Document'))}</title>
<style>${pageRule}\n${css}</style>
</head><body>${pages}</body></html>`;
}
