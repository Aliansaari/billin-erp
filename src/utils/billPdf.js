// ── Bill / Invoice → PDF ───────────────────────────────────────────────
//
// Replaces the Electron `webContents.printToPDF` route (which produced
// PDFs that some viewers couldn't render — the page object was valid
// but the content stream came out malformed because Chromium was being
// asked to render an HTML page that didn't match the offscreen window
// geometry, then squish that into a thermal page size).
//
// Uses jsPDF + jspdf-autotable in the renderer process — the SAME
// engine that's powering the working Customer / Supplier Statement
// exports. No Electron round-trip, no offscreen window, no font
// subsetting drama: we hand jsPDF plain text + autoTable hands it back
// a valid PDF blob.
//
// Layout (A4 portrait):
//   ┌─────────────────────────────────────────────────────┐
//   │ <Company name>                                       │ ← letterhead
//   │ <Address line>                                       │
//   │ GSTIN: ... · PAN: ...                                │
//   │                                       [TAX INVOICE]  │ ← doc-type chip
//   ├─────────────────────────────────────────────────────┤
//   │ Bill #..   Date: ..   Due: ..                        │ ← bill meta
//   │ Bill To:                                             │
//   │   Party Name | Address | City, State                 │
//   │   GSTIN | Mobile                                     │
//   ├─────────────────────────────────────────────────────┤
//   │ # | Item | HSN | Qty | Rate | MRP | Disc% | Amount   │ ← items table
//   ├─────────────────────────────────────────────────────┤
//   │                            Sub Total :  Σ items      │
//   │                            Discount  :  ...          │
//   │                            CGST      :  ...          │
//   │                            SGST      :  ...          │
//   │                            Round Off :  ...          │
//   │                       ┌─ GRAND TOTAL :  ___ ─┐      │
//   │ Amount in words: ...                                 │
//   ├─────────────────────────────────────────────────────┤
//   │ Bank: ...        Authorised Signatory                │ ← footer
//   └─────────────────────────────────────────────────────┘
//
// Thermal-paper sizes (80mm) are NOT supported by this generator —
// thermal prints don't go through "Export PDF" on a list, they go
// through the silent-print path on bill creation. If a user has set a
// thermal profile as their default for sales/purchase exports, we
// still produce A4 — better than the broken thermal printToPDF flow.

import dayjs from 'dayjs';

const PT_PER_MM = 2.834645669;

const esc = (s) => (s == null ? '' : String(s));
const fmt = (v) =>
  parseFloat(v || 0).toLocaleString('en-IN', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
const fmtQty = (v) => {
  const n = Number(v) || 0;
  return Number.isInteger(n) ? String(n) : n.toLocaleString('en-IN', { maximumFractionDigits: 3 });
};
const fmtDate = (d) => (d ? dayjs(d).format('DD-MM-YYYY') : '');

// Indian-system number-to-words. Mirrors printRenderer.numberToWords so
// the PDF and on-screen render read the same.
function numberToWords(num) {
  const ones = ['', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine',
                'Ten', 'Eleven', 'Twelve', 'Thirteen', 'Fourteen', 'Fifteen', 'Sixteen',
                'Seventeen', 'Eighteen', 'Nineteen'];
  const tens = ['', '', 'Twenty', 'Thirty', 'Forty', 'Fifty', 'Sixty', 'Seventy', 'Eighty', 'Ninety'];
  const conv = (n) => {
    if (n === 0) return '';
    if (n < 20) return ones[n] + ' ';
    if (n < 100) return tens[Math.floor(n / 10)] + ' ' + conv(n % 10);
    return ones[Math.floor(n / 100)] + ' Hundred ' + conv(n % 100);
  };
  const n = Math.floor(Math.abs(Number(num) || 0));
  if (n === 0) return 'Zero Rupees Only';
  let s = '';
  if (Math.floor(n / 10000000)) { s += conv(Math.floor(n / 10000000)) + 'Crore '; }
  if (Math.floor((n % 10000000) / 100000)) { s += conv(Math.floor((n % 10000000) / 100000)) + 'Lakh '; }
  if (Math.floor((n % 100000) / 1000)) { s += conv(Math.floor((n % 100000) / 1000)) + 'Thousand '; }
  if (Math.floor((n % 1000))) { s += conv(n % 1000); }
  return 'Rupees ' + s.trim() + ' Only';
}

const DOC_LABEL = {
  sales:           'TAX INVOICE',
  purchase:        'PURCHASE BILL',
  sales_return:    'CREDIT NOTE',
  purchase_return: 'DEBIT NOTE',
  receipt:         'RECEIPT',
  payment:         'PAYMENT VOUCHER',
};

/**
 * Build a PDF blob for the given bill and trigger a download.
 *
 * @param {object} opts
 * @param {string} opts.docType   sales | purchase | sales_return | purchase_return
 * @param {object} opts.bill      Full bill (with items[] and *_amount fields)
 * @param {object} opts.profile   Print profile (paper size, toggles, header html, …)
 * @param {object} opts.company   System settings (company_name, gstin, …)
 * @param {string} opts.fileName  Suggested file name (e.g. "Cash-25-261677.pdf")
 *
 * Returns the produced Blob. The caller is responsible for saving / sharing
 * (we expose the blob so an Electron path can write it to Downloads while
 * a plain-browser path can fall back to a navigator-blob download).
 */
export async function buildBillPdf({ docType, bill, profile, company, fileName }) {
  if (!bill) throw new Error('bill is required');

  const { default: jsPDF } = await import('jspdf');
  await import('jspdf-autotable');

  // A4 portrait. We always emit A4 — the print profile may say "thermal"
  // for the silent-print pipeline, but Export PDF deliberately ignores
  // that and produces a proper office-doc.
  const doc = new jsPDF({ unit: 'pt', format: 'a4' });
  const pageW = doc.internal.pageSize.getWidth();
  const pageH = doc.internal.pageSize.getHeight();
  const M = 40;             // page margin
  let y = M;

  /* ── Letterhead ─────────────────────────────────────────────────── */
  doc.setFont('helvetica', 'bold').setFontSize(15).setTextColor(20, 20, 20);
  const companyName = profile?.header_title || company?.company_name || 'Company Name';
  doc.text(companyName, M, y);
  y += 18;

  doc.setFont('helvetica', 'normal').setFontSize(9).setTextColor(80);
  if (company?.company_address) {
    const addrLines = doc.splitTextToSize(company.company_address, pageW - 2 * M - 140);
    for (const ln of addrLines) {
      doc.text(ln, M, y);
      y += 11;
    }
  }
  if (company?.gstin) {
    const taxLine = `GSTIN: ${company.gstin}` + (company?.pan_number ? ` | PAN: ${company.pan_number}` : '');
    doc.text(taxLine, M, y);
    y += 11;
  }

  /* Doc-type chip pinned to the top-right. Larger and bold so it reads
   * as a proper invoice header rather than a side note. */
  const docLabel = DOC_LABEL[docType] || 'DOCUMENT';
  doc.setFont('helvetica', 'bold').setFontSize(11).setTextColor(80, 80, 80);
  doc.text(docLabel, pageW - M, M + 4, { align: 'right' });

  // Light hairline under the letterhead.
  y += 6;
  doc.setDrawColor(220).setLineWidth(0.5);
  doc.line(M, y, pageW - M, y);
  y += 14;

  /* ── Bill meta + party block (two columns) ──────────────────────── */
  const metaX = M;
  const partyX = pageW / 2 + 10;
  const metaY = y;

  // Left column: bill meta
  doc.setFont('helvetica', 'normal').setFontSize(9).setTextColor(110);
  doc.text(docLabel === 'TAX INVOICE' ? 'Invoice No:' : 'Bill No:', metaX, y);
  doc.setFont('helvetica', 'bold').setTextColor(20);
  doc.text(esc(bill.bill_number || bill.transaction_number || '—'), metaX + 70, y);

  doc.setFont('helvetica', 'normal').setTextColor(110);
  doc.text('Date:', metaX, y + 14);
  doc.setFont('helvetica', 'bold').setTextColor(20);
  doc.text(fmtDate(bill.bill_date || bill.transaction_date), metaX + 70, y + 14);

  if (bill.due_date) {
    doc.setFont('helvetica', 'normal').setTextColor(110);
    doc.text('Due Date:', metaX, y + 28);
    doc.setFont('helvetica', 'bold').setTextColor(20);
    doc.text(fmtDate(bill.due_date), metaX + 70, y + 28);
  }

  // Right column: party block
  const party = bill.customer || bill.supplier || bill.party || {};
  const isCash = !party.party_name || party.is_system_cash;
  const walkIn = String(bill.walk_in_name || '').trim();

  doc.setFont('helvetica', 'normal').setFontSize(9).setTextColor(110);
  const billToLabel = (docType === 'purchase' || docType === 'purchase_return') ? 'Supplier:' : 'Bill To:';
  doc.text(billToLabel, partyX, metaY);
  let py = metaY + 14;
  doc.setFont('helvetica', 'bold').setFontSize(10).setTextColor(20);
  if (isCash) {
    doc.text('Cash', partyX, py);
    py += 12;
    if (walkIn) {
      doc.setFont('helvetica', 'normal').setFontSize(9).setTextColor(60);
      const wraps = doc.splitTextToSize(walkIn, pageW - partyX - M);
      for (const ln of wraps) { doc.text(ln, partyX, py); py += 11; }
    }
  } else {
    const wraps = doc.splitTextToSize(party.party_name, pageW - partyX - M);
    for (const ln of wraps) { doc.text(ln, partyX, py); py += 12; }

    doc.setFont('helvetica', 'normal').setFontSize(9).setTextColor(80);
    const addrParts = [party.address_line1, [party.city, party.state].filter(Boolean).join(', ')]
      .filter(Boolean);
    for (const ap of addrParts) {
      const wraps2 = doc.splitTextToSize(ap, pageW - partyX - M);
      for (const ln of wraps2) { doc.text(ln, partyX, py); py += 11; }
    }
    if (party.gstin)    { doc.text(`GSTIN: ${party.gstin}`, partyX, py); py += 11; }
    if (party.mobile_1) { doc.text(`Mobile: ${party.mobile_1}`, partyX, py); py += 11; }
  }

  y = Math.max(y + 42, py + 6);
  doc.setDrawColor(220).setLineWidth(0.5);
  doc.line(M, y, pageW - M, y);
  y += 8;

  /* ── Items table ────────────────────────────────────────────────── */
  const showHsn      = profile?.show_hsn      !== false;
  const showMrp      = profile?.show_mrp      !== false;
  const showDiscount = profile?.show_discount !== false;
  const showBatch    = !!profile?.show_batch;

  const cols = ['#', 'Item'];
  if (showHsn)      cols.push('HSN');
  if (showBatch)    cols.push('Batch');
  cols.push('Qty', 'Rate');
  if (showMrp)      cols.push('MRP');
  if (showDiscount) cols.push('Disc%');
  cols.push('Amount');

  const items = Array.isArray(bill.items) ? bill.items : [];
  const body = items.map((it, i) => {
    const row = [
      String(i + 1),
      esc(it.product_name || ''),
    ];
    if (showHsn)      row.push(esc(it.hsn_code || ''));
    if (showBatch)    row.push(esc(it.batch_number || it.batch?.batch_number || ''));
    row.push(fmtQty(it.quantity));
    row.push(fmt(it.rate || it.purchase_rate));
    if (showMrp)      row.push(fmt(it.mrp));
    if (showDiscount) row.push((Number(it.discount_percentage || 0)).toFixed(2));
    row.push(fmt(it.total_amount));
    return row;
  });

  // Build column styles by index so right-align is applied to numeric
  // columns regardless of which optional columns are present.
  const colStyles = {};
  let idx = 0;
  colStyles[idx++] = { cellWidth: 22, halign: 'center' };       // #
  colStyles[idx++] = { cellWidth: 'auto' };                      // Item
  if (showHsn)   { colStyles[idx++] = { cellWidth: 50 }; }
  if (showBatch) { colStyles[idx++] = { cellWidth: 60 }; }
  colStyles[idx++] = { cellWidth: 50, halign: 'right' };         // Qty
  colStyles[idx++] = { cellWidth: 60, halign: 'right' };         // Rate
  if (showMrp)      { colStyles[idx++] = { cellWidth: 55, halign: 'right' }; }
  if (showDiscount) { colStyles[idx++] = { cellWidth: 45, halign: 'right' }; }
  colStyles[idx++] = { cellWidth: 70, halign: 'right' };         // Amount

  doc.autoTable({
    startY: y,
    head: [cols],
    body: body.length ? body : [['', items.length === 0 ? '(no items)' : '', ...new Array(cols.length - 2).fill('')]],
    theme: 'grid',
    styles:     { fontSize: 9, cellPadding: 5, lineColor: [225, 225, 225], lineWidth: 0.4 },
    headStyles: { fillColor: [248, 245, 240], textColor: [60, 60, 60], fontStyle: 'bold', fontSize: 8.5 },
    columnStyles: colStyles,
    margin: { left: M, right: M },
  });

  y = doc.lastAutoTable.finalY + 8;

  /* ── Totals block (right column) ────────────────────────────────── */
  const totals = [];
  const sub = Number(bill.sub_total || 0);
  const disc = Number(bill.discount_amount || 0);
  const cgst = Number(bill.cgst_amount || 0);
  const sgst = Number(bill.sgst_amount || 0);
  const igst = Number(bill.igst_amount || 0);
  const cess = Number(bill.cess_amount || 0);
  const freight = Number(bill.freight_charges || 0);
  const sd      = Number(bill.special_discount || 0);
  const ro      = Number(bill.round_off || 0);
  const grand   = Number(bill.total_amount || 0);
  const ret     = Number(bill.return_amount || 0);
  const bal     = Number(bill.balance_amount != null ? bill.balance_amount : 0);

  if (sub)           totals.push(['Sub Total', fmt(sub)]);
  if (disc)          totals.push(['Discount',  '-' + fmt(disc)]);
  if (cgst)          totals.push(['CGST',      fmt(cgst)]);
  if (sgst)          totals.push(['SGST',      fmt(sgst)]);
  if (igst)          totals.push(['IGST',      fmt(igst)]);
  if (cess)          totals.push(['Cess',      fmt(cess)]);
  if (freight)       totals.push(['Freight',   fmt(freight)]);
  if (sd)            totals.push(['Special Disc', '-' + fmt(sd)]);
  if (ro)            totals.push(['Round Off', (ro >= 0 ? '+' : '') + fmt(Math.abs(ro))]);

  const totalsX = pageW - M - 200;
  const labelX  = totalsX;
  const valueX  = pageW - M;

  doc.setFont('helvetica', 'normal').setFontSize(9).setTextColor(60);
  for (const [label, value] of totals) {
    if (y > pageH - 100) { doc.addPage(); y = M; }
    doc.text(label, labelX, y);
    doc.text(value, valueX, y, { align: 'right' });
    y += 13;
  }

  // Grand total bar
  if (y > pageH - 80) { doc.addPage(); y = M; }
  doc.setDrawColor(80).setLineWidth(0.8);
  doc.line(totalsX, y, valueX, y);
  y += 14;
  doc.setFont('helvetica', 'bold').setFontSize(11).setTextColor(20);
  doc.text('GRAND TOTAL', labelX, y);
  doc.text(fmt(grand), valueX, y, { align: 'right' });
  y += 4;
  doc.setLineWidth(0.8);
  doc.line(totalsX, y + 2, valueX, y + 2);
  y += 16;

  // Balance / paid (sales side)
  if (ret) {
    doc.setFont('helvetica', 'normal').setFontSize(9).setTextColor(60);
    doc.text('Return Credit', labelX, y);
    doc.text('-' + fmt(ret), valueX, y, { align: 'right' });
    y += 13;
  }
  if (bal !== grand && bal !== 0) {
    const paid = Math.max(0, grand - ret - bal);
    if (paid > 0) {
      doc.setFont('helvetica', 'normal').setFontSize(9).setTextColor(60);
      doc.text('Paid', labelX, y);
      doc.text(fmt(paid), valueX, y, { align: 'right' });
      y += 13;
    }
    doc.setFont('helvetica', 'bold').setFontSize(10).setTextColor(180, 50, 50);
    doc.text('Balance Due', labelX, y);
    doc.text(fmt(bal), valueX, y, { align: 'right' });
    doc.setTextColor(20);
    y += 14;
  }

  /* ── Amount in words ────────────────────────────────────────────── */
  if (y > pageH - 70) { doc.addPage(); y = M; }
  y += 8;
  doc.setFont('helvetica', 'italic').setFontSize(9).setTextColor(80);
  const words = numberToWords(grand);
  const wordWraps = doc.splitTextToSize(words, pageW - 2 * M);
  for (const ln of wordWraps) {
    doc.text(ln, M, y);
    y += 11;
  }

  /* ── Footer (bank / terms / signature) ──────────────────────────── */
  const footerY = pageH - M - 60;
  doc.setDrawColor(220).setLineWidth(0.4);
  doc.line(M, footerY, pageW - M, footerY);

  const bankText = profile?.bank_details ? String(profile.bank_details) : '';
  const tcText   = profile?.terms_and_conditions ? String(profile.terms_and_conditions) : '';
  let ftY = footerY + 14;
  if (bankText) {
    doc.setFont('helvetica', 'bold').setFontSize(8.5).setTextColor(80);
    doc.text('Bank Details', M, ftY);
    doc.setFont('helvetica', 'normal').setFontSize(8).setTextColor(100);
    const lines = doc.splitTextToSize(bankText, pageW / 2 - M - 10);
    let by = ftY + 11;
    for (const ln of lines.slice(0, 3)) {
      doc.text(ln, M, by);
      by += 10;
    }
  }
  if (tcText) {
    doc.setFont('helvetica', 'bold').setFontSize(8.5).setTextColor(80);
    doc.text('Terms & Conditions', M, ftY + 38);
    doc.setFont('helvetica', 'normal').setFontSize(7.5).setTextColor(110);
    const lines = doc.splitTextToSize(tcText, pageW / 2 - M - 10);
    let ty = ftY + 49;
    for (const ln of lines.slice(0, 2)) {
      doc.text(ln, M, ty);
      ty += 9;
    }
  }

  // Signature block on the right.
  if (profile?.show_signature !== false) {
    const sigW = 130;
    const sigX = pageW - M - sigW;
    doc.setFont('helvetica', 'normal').setFontSize(9).setTextColor(60);
    doc.text('For ' + (profile?.header_title || company?.company_name || ''), sigX + sigW, ftY, { align: 'right' });
    doc.setDrawColor(120).setLineWidth(0.4);
    doc.line(sigX, footerY + 48, pageW - M, footerY + 48);
    doc.setFontSize(8).setTextColor(110);
    doc.text(profile?.signature_label || 'Authorised Signatory', pageW - M, footerY + 58, { align: 'right' });
  }

  /* ── Page number footers ────────────────────────────────────────── */
  const generatedAt = dayjs().format('DD MMM YYYY · HH:mm');
  const totalPages = doc.internal.getNumberOfPages();
  for (let i = 1; i <= totalPages; i++) {
    doc.setPage(i);
    doc.setFont('helvetica', 'normal').setFontSize(7).setTextColor(150);
    doc.text(`Generated ${generatedAt}`, M, pageH - 12);
    if (totalPages > 1) {
      doc.text(`Page ${i} of ${totalPages}`, pageW - M, pageH - 12, { align: 'right' });
    }
  }

  return doc.output('blob');
}
