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
  const rows = [];
  rows.push(['Sub Total', fmtMoney(bill.sub_total, profile)]);
  if (Number(bill.discount_amount || 0)) rows.push(['Discount', '-' + fmtMoney(bill.discount_amount, profile)]);
  if (Number(bill.cgst_amount || 0)) rows.push(['CGST', fmtMoney(bill.cgst_amount, profile)]);
  if (Number(bill.sgst_amount || 0)) rows.push(['SGST', fmtMoney(bill.sgst_amount, profile)]);
  if (Number(bill.igst_amount || 0)) rows.push(['IGST', fmtMoney(bill.igst_amount, profile)]);
  if (Number(bill.other_charges || 0)) rows.push(['Other', fmtMoney(bill.other_charges, profile)]);
  if (Number(bill.freight_charges || 0)) rows.push(['Freight', fmtMoney(bill.freight_charges, profile)]);
  if (Number(bill.round_off || 0)) rows.push(['Round Off', fmtMoney(bill.round_off, profile)]);
  const grand = Number(bill.total_amount || 0);
  const html = rows.map(([l, v]) => `<div class="tot-row"><span>${l}</span><span>${v}</span></div>`).join('');
  return `
    <div class="totals">
      ${html}
      <div class="tot-grand">
        <span>TOTAL</span><span>${fmtMoney(grand, profile)}</span>
      </div>
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

const baseCSS = (profile) => `
  * { box-sizing: border-box; }
  body {
    margin: 0;
    font-family: ${profile?.font_family || 'Inter, system-ui, sans-serif'};
    font-size: ${profile?.font_size_pt || 10}pt;
    line-height: ${profile?.line_spacing || 1.35};
    color: #111;
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
`;

const thermalCSS = (profile) => `
  * { box-sizing: border-box; }
  body {
    margin: 0;
    font-family: 'Courier New', ${profile?.font_family || 'monospace'};
    font-size: ${profile?.font_size_pt || 9}pt;
    line-height: 1.25;
    color: #000;
    width: ${profile?.paper_width_mm || 80}mm;
  }
  .page { padding: 0; }
  .hdr { text-align: center; margin-bottom: 3mm; }
  .hdr-name { font-size: 1.15em; font-weight: 700; }
  .hdr-sub { font-size: .85em; }
  .doc-type { margin-top: 2mm; font-weight: 700; border: 1px dashed #000; padding: 1mm; }
  .meta-row { display: flex; justify-content: space-between; font-size: .85em; margin: 2mm 0; }
  .party { font-size: .9em; margin: 2mm 0; border-top: 1px dashed #000; border-bottom: 1px dashed #000; padding: 2mm 0; }
  table.items { width: 100%; border-collapse: collapse; margin: 2mm 0; font-size: .85em; }
  table.items td { padding: 1px 0; }
  .it-name { font-weight: 600; }
  .it-qty { text-align: right; font-variant-numeric: tabular-nums; }
  .hrb { border-top: 1px dashed #000; margin: 2mm 0; }
  .t-row { display: flex; justify-content: space-between; font-size: .9em; }
  .t-grand { font-weight: 700; font-size: 1.1em; border-top: 1px solid #000; border-bottom: 1px solid #000; padding: 1mm 0; margin: 1mm 0; }
  .fb { margin-top: 3mm; text-align: center; font-size: .8em; white-space: pre-wrap; }
  @media print { .page { page-break-after: always; } .page:last-child { page-break-after: auto; } }
`;

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

function renderThermal(bill, profile, company) {
  const items = bill.items || [];
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
      ${line('Sub Total', fmtMoney(bill.sub_total, profile))}
      ${Number(bill.discount_amount||0) ? line('Disc', '-' + fmtMoney(bill.discount_amount, profile)) : ''}
      ${Number(bill.cgst_amount||0) + Number(bill.sgst_amount||0) + Number(bill.igst_amount||0) ?
        line('GST', fmtMoney(Number(bill.cgst_amount||0) + Number(bill.sgst_amount||0) + Number(bill.igst_amount||0), profile)) : ''}
      ${Number(bill.round_off||0) ? line('Round Off', fmtMoney(bill.round_off, profile)) : ''}
      <div class="t-grand"><span>TOTAL</span><span>${fmtMoney(bill.total_amount, profile)}</span></div>
      ${bill.paid_amount != null && Number(bill.paid_amount) ? line('Paid', fmtMoney(bill.paid_amount, profile)) : ''}
      ${bill.balance_amount != null && Number(bill.balance_amount) ? line('Balance', fmtMoney(bill.balance_amount, profile)) : ''}
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
