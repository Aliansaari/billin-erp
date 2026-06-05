/**
 * Server-side BILL + RECEIPT PDFs for the WhatsApp bot (jsPDF in Node).
 *
 * A customer can message their own bill / receipt number and the bot replies
 * with the document as a PDF. These builders are deliberately self-contained
 * (no renderer printContext / autotable / theme deps) so they run in the
 * bundled Node server. Styling matches statementPdf.js: terracotta accent,
 * "Rs " amounts (jsPDF core fonts can't render the ₹ glyph).
 */
const A = [177, 71, 47];          // terracotta accent
const INK = 40, MUTE = 110, FAINT = 150;

function money(n, withRs = true) {
  const v = Math.abs(Number(n) || 0).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return withRs ? 'Rs ' + v : v;
}
function dt(d) {
  if (!d) return '';
  const x = new Date(d);
  return isNaN(x.getTime()) ? '' : x.toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' });
}
function safeName(s) { return String(s || 'document').replace(/[^a-z0-9]+/gi, '-').replace(/^-+|-+$/g, '') || 'document'; }

// Company letterhead lines shared by both documents.
function companyLines(company) {
  const c = company || {};
  const addr = [c.address_line_1 || c.company_address, [c.city, c.state, c.pincode].filter(Boolean).join(', ')]
    .filter(Boolean);
  const meta = [];
  if (c.phone) meta.push('Ph: ' + c.phone);
  if (c.gstin) meta.push('GSTIN: ' + c.gstin);
  return { addr, meta };
}

/**
 * A4 tax-invoice / bill.
 * @param {object} o { shop, company, bill, items, party }
 *   bill: { bill_number, bill_date, sub_total, discount_amount, cgst_amount,
 *           sgst_amount, igst_amount, round_off, total_amount, paid_amount,
 *           balance_amount }
 *   items: [{ product_name, size, hsn_code, quantity, unit_type, rate,
 *             discount_amount, gst_rate, taxable_amount, amount/total }]
 * @returns {Buffer}
 */
function buildBillPdf({ shop, company, bill, items, party }) {
  const { jsPDF } = require('jspdf');
  const doc = new jsPDF({ unit: 'pt', format: 'a4' });
  const W = doc.internal.pageSize.getWidth();
  const H = doc.internal.pageSize.getHeight();
  const M = 40;
  let y = M;

  // Header band
  doc.setFillColor(A[0], A[1], A[2]).rect(0, 0, W, 6, 'F');
  doc.setFont('helvetica', 'bold').setFontSize(17).setTextColor(A[0], A[1], A[2]);
  doc.text(shop || company?.name || 'Invoice', M, y + 14);
  doc.setFont('helvetica', 'bold').setFontSize(11).setTextColor(MUTE);
  doc.text('TAX INVOICE', W - M, y + 13, { align: 'right' });
  y += 22;
  const { addr, meta } = companyLines(company);
  doc.setFont('helvetica', 'normal').setFontSize(8.5).setTextColor(MUTE);
  for (const line of addr) { doc.text(line, M, y); y += 11; }
  if (meta.length) { doc.text(meta.join('   ·   '), M, y); y += 11; }
  y += 6;
  doc.setDrawColor(220).setLineWidth(0.5).line(M, y, W - M, y);
  y += 18;

  // Bill meta + party
  doc.setFont('helvetica', 'bold').setFontSize(10).setTextColor(INK);
  doc.text(`Bill #${bill.bill_number || ''}`, M, y);
  doc.setFont('helvetica', 'normal').setTextColor(MUTE);
  doc.text(`Date: ${dt(bill.bill_date)}`, W - M, y, { align: 'right' });
  y += 16;
  doc.setFont('helvetica', 'bold').setFontSize(9).setTextColor(FAINT).text('BILL TO', M, y);
  y += 13;
  doc.setFont('helvetica', 'bold').setFontSize(11).setTextColor(INK).text(party?.party_name || 'Customer', M, y);
  y += 13;
  doc.setFont('helvetica', 'normal').setFontSize(9).setTextColor(MUTE);
  const pmeta = [party?.mobile_1, party?.gstin && ('GSTIN: ' + party.gstin)].filter(Boolean).join('   ·   ');
  if (pmeta) { doc.text(pmeta, M, y); y += 13; }
  y += 6;

  // Items table
  const cNo = M, cItem = M + 24, cQty = W - M - 230, cRate = W - M - 150, cGst = W - M - 78, cAmt = W - M;
  function head() {
    doc.setFillColor(247, 240, 236).rect(M - 4, y - 11, W - 2 * M + 8, 18, 'F');
    doc.setFont('helvetica', 'bold').setFontSize(8.5).setTextColor(A[0], A[1], A[2]);
    doc.text('#', cNo, y);
    doc.text('ITEM', cItem, y);
    doc.text('QTY', cQty, y, { align: 'right' });
    doc.text('RATE', cRate, y, { align: 'right' });
    doc.text('GST', cGst, y, { align: 'right' });
    doc.text('AMOUNT', cAmt, y, { align: 'right' });
    y += 16;
  }
  head();
  doc.setFont('helvetica', 'normal').setFontSize(9).setTextColor(INK);
  (items || []).forEach((it, i) => {
    if (y > H - 150) { doc.addPage(); y = M + 10; head(); doc.setFont('helvetica', 'normal').setFontSize(9).setTextColor(INK); }
    const name = [it.product_name, it.size && `(${it.size})`].filter(Boolean).join(' ');
    const amt = Number(it.amount != null ? it.amount : (it.total != null ? it.total : (Number(it.taxable_amount || 0) + Number(it.cgst_amount || 0) + Number(it.sgst_amount || 0) + Number(it.igst_amount || 0)))) || 0;
    doc.setTextColor(INK);
    doc.text(String(i + 1), cNo, y);
    doc.text(doc.splitTextToSize(name || '-', cQty - cItem - 8)[0] || '-', cItem, y);
    doc.text(money(it.quantity, false), cQty, y, { align: 'right' });
    doc.text(money(it.rate, false), cRate, y, { align: 'right' });
    doc.text((Number(it.gst_rate) || 0) + '%', cGst, y, { align: 'right' });
    doc.text(money(amt, false), cAmt, y, { align: 'right' });
    y += 14;
  });
  y += 4;
  doc.setDrawColor(225).line(M, y, W - M, y);
  y += 16;

  // Totals (right column)
  const lx = W - M - 200, rx = W - M;
  function row(label, val, opts = {}) {
    doc.setFont('helvetica', opts.bold ? 'bold' : 'normal').setFontSize(opts.bold ? 11 : 9.5)
      .setTextColor(opts.accent ? A[0] : INK, opts.accent ? A[1] : INK, opts.accent ? A[2] : INK);
    if (opts.accent) doc.setTextColor(A[0], A[1], A[2]); else doc.setTextColor(opts.bold ? INK : MUTE);
    doc.text(label, lx, y);
    doc.text(money(val), rx, y, { align: 'right' });
    y += opts.bold ? 18 : 14;
  }
  row('Sub Total', bill.sub_total);
  if (Number(bill.discount_amount) > 0) row('Discount', bill.discount_amount);
  if (Number(bill.cgst_amount) > 0) row('CGST', bill.cgst_amount);
  if (Number(bill.sgst_amount) > 0) row('SGST', bill.sgst_amount);
  if (Number(bill.igst_amount) > 0) row('IGST', bill.igst_amount);
  if (Number(bill.round_off) !== 0) row('Round Off', bill.round_off);
  doc.setDrawColor(A[0], A[1], A[2]).setLineWidth(1).line(lx, y - 4, rx, y - 4);
  y += 8;
  row('GRAND TOTAL', bill.total_amount, { bold: true, accent: true });
  if (Number(bill.paid_amount) > 0) row('Paid', bill.paid_amount);
  const due = Number(bill.balance_amount != null ? bill.balance_amount : (Number(bill.total_amount || 0) - Number(bill.paid_amount || 0)));
  if (Math.abs(due) > 0.01) row('Balance Due', due, { bold: true });

  // Footer
  doc.setFont('helvetica', 'normal').setFontSize(8).setTextColor(FAINT);
  doc.text('This is a system-generated invoice. Thank you for your business!', M, H - 30);

  return Buffer.from(doc.output('arraybuffer'));
}

/**
 * Compact 80mm thermal-style RECEIPT (money-in acknowledgement).
 * @param {object} o { shop, company, receipt, party, balanceAfter }
 *   receipt: { transaction_number, transaction_date, total_amount,
 *              payment_method, remarks }
 * @returns {Buffer}
 */
function buildReceiptPdf({ shop, company, receipt, party, balanceAfter }) {
  const { jsPDF } = require('jspdf');
  const Wmm = 80;
  // Two-pass height so the page fits the content snugly.
  const lineH = 14, base = 230;
  const extra = (receipt.remarks ? 16 : 0);
  const doc = new jsPDF({ unit: 'mm', format: [Wmm, 150] });
  // switch to pt-like drawing via mm coords
  const W = Wmm, M = 6;
  let y = 10;
  const ptText = (s, x, opts = {}) => {
    doc.setFont('helvetica', opts.bold ? 'bold' : 'normal');
    doc.setFontSize(opts.size || 9);
    if (opts.accent) doc.setTextColor(A[0], A[1], A[2]); else doc.setTextColor(opts.mute ? MUTE : INK);
    doc.text(String(s), opts.center ? W / 2 : (opts.right ? W - M : M), y, { align: opts.center ? 'center' : (opts.right ? 'right' : 'left') });
  };

  doc.setFillColor(A[0], A[1], A[2]).rect(0, 0, W, 2, 'F');
  ptText(shop || company?.name || 'Receipt', null, { bold: true, size: 12, accent: true, center: true }); y += 5;
  if (company?.phone) { ptText('Ph: ' + company.phone, null, { size: 7.5, mute: true, center: true }); y += 4; }
  ptText('PAYMENT RECEIPT', null, { size: 8, mute: true, center: true }); y += 6;
  doc.setDrawColor(210).setLineWidth(0.3).line(M, y, W - M, y); y += 6;

  ptText('Receipt #' + (receipt.transaction_number || ''), M, { size: 8.5, bold: true });
  ptText(dt(receipt.transaction_date), null, { size: 8.5, mute: true, right: true }); y += 5;
  ptText('Received from', M, { size: 7.5, mute: true }); y += 4.5;
  ptText(party?.party_name || 'Customer', M, { size: 10, bold: true }); y += 7;

  // Amount block
  doc.setFillColor(247, 240, 236).roundedRect(M, y - 5, W - 2 * M, 16, 1.5, 1.5, 'F');
  ptText('Amount received', M + 2, { size: 7.5, mute: true }); y += 6;
  ptText(money(receipt.total_amount), M + 2, { size: 13, bold: true, accent: true }); y += 8;

  if (receipt.payment_method) { ptText('Mode: ' + receipt.payment_method, M, { size: 8.5, mute: true }); y += 5; }
  if (balanceAfter != null) {
    const b = Number(balanceAfter) || 0;
    ptText('Remaining balance: ' + money(b) + (Math.abs(b) < 0.01 ? '' : (b > 0 ? ' Dr' : ' Cr')), M, { size: 8.5, bold: true }); y += 5;
  }
  if (receipt.remarks) { ptText(String(receipt.remarks).slice(0, 60), M, { size: 7.5, mute: true }); y += 5; }

  y += 3;
  doc.setDrawColor(210).line(M, y, W - M, y); y += 6;
  ptText('Thank you!', null, { size: 9, bold: true, accent: true, center: true });

  return Buffer.from(doc.output('arraybuffer'));
}

module.exports = { buildBillPdf, buildReceiptPdf, safeName };
