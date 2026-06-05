/**
 * Server-side account-statement PDF (jsPDF in Node — works on Node 20).
 *
 * Used by the WhatsApp bot when a customer (or the owner) asks for a
 * statement. The data MUST come from the real ledger — services/
 * ledgerStatementService.getLedgerStatement() — NOT a bills+receipts plug.
 * That service is the single source of truth behind the app's own Customer
 * Statement page, so the PDF the customer receives matches what the shop
 * sees on screen exactly: correct opening balance, every voucher type
 * (sales, receipts, returns, journals, opening entries), reversal-aware,
 * and a correct signed running balance per row.
 *
 * Note: jsPDF's built-in fonts can't render the ₹ glyph, so amounts use "Rs ".
 */
function money(n) {
  return 'Rs ' + Math.abs(Number(n) || 0).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}
// Signed balance label: +ve = Dr (owes us), -ve = Cr (advance/credit).
function balStr(v) {
  const n = Number(v) || 0;
  if (Math.abs(n) < 0.01) return 'Settled';
  return money(n) + ' ' + (n >= 0 ? 'Dr' : 'Cr');
}
function dt(d) {
  if (!d) return '';
  const x = new Date(d);
  return isNaN(x.getTime()) ? '' : x.toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' });
}

/**
 * @param {object} o
 * @param {string} o.shop        Company name
 * @param {object} o.party       { party_name, mobile_1 }
 * @param {object} o.statement   getLedgerStatement() output:
 *                                { opening_balance, entries:[{date, voucher_type,
 *                                  voucher_no, narration, debit, credit, balance}],
 *                                  closing_balance, period:{from,to} }
 * @returns {Buffer} PDF bytes
 */
function buildStatementPdf({ shop, party, statement }) {
  const { jsPDF } = require('jspdf');
  const A = [177, 71, 47]; // terracotta accent
  const doc = new jsPDF({ unit: 'pt', format: 'a4' });
  const W = doc.internal.pageSize.getWidth();
  const H = doc.internal.pageSize.getHeight();
  const M = 40;
  let y = M;

  const allEntries = (statement && Array.isArray(statement.entries)) ? statement.entries : [];
  // Cap rows so a heavy account stays a tidy one/two-pager; show the most
  // recent. The running balances are already correct per row, so when we
  // slice we derive the window's opening from the first shown row's real
  // balance — no re-plugging, still exact.
  const MAX = 40;
  const shown = allEntries.slice(-MAX);
  const truncated = shown.length < allEntries.length;
  let openBal;
  if (truncated && shown.length) {
    const f = shown[0];
    openBal = +(((Number(f.balance) || 0) - ((Number(f.debit) || 0) - (Number(f.credit) || 0)))).toFixed(2);
  } else {
    openBal = Number((statement && statement.opening_balance) || 0);
  }
  const closing = Number((statement && statement.closing_balance != null)
    ? statement.closing_balance : 0);

  // Column geometry.
  const cDate = M, cPart = M + 74, cDr = W - M - 220, cCr = W - M - 115, cBal = W - M;
  function tableHead() {
    doc.setFillColor(247, 240, 236).rect(M - 4, y - 11, W - 2 * M + 8, 18, 'F');
    doc.setFont('helvetica', 'bold').setFontSize(8.5).setTextColor(A[0], A[1], A[2]);
    doc.text('DATE', cDate, y);
    doc.text('PARTICULARS', cPart, y);
    doc.text('DEBIT', cDr, y, { align: 'right' });
    doc.text('CREDIT', cCr, y, { align: 'right' });
    doc.text('BALANCE', cBal, y, { align: 'right' });
    y += 16;
  }

  // ── Header ──
  doc.setFillColor(A[0], A[1], A[2]).rect(0, 0, W, 6, 'F');
  doc.setFont('helvetica', 'bold').setFontSize(18).setTextColor(A[0], A[1], A[2]);
  doc.text(shop || 'Statement', M, y + 14);
  doc.setFont('helvetica', 'normal').setFontSize(10).setTextColor(110);
  doc.text('ACCOUNT STATEMENT', W - M, y + 13, { align: 'right' });
  y += 30;
  doc.setDrawColor(220).setLineWidth(0.5).line(M, y, W - M, y);
  y += 18;

  // ── Party + meta ──
  doc.setFont('helvetica', 'bold').setFontSize(12).setTextColor(30);
  doc.text(party.party_name || 'Customer', M, y);
  doc.setFont('helvetica', 'normal').setFontSize(9).setTextColor(110);
  if (party.mobile_1) { doc.text(`Mobile: ${party.mobile_1}`, M, y + 13); }
  doc.text(`Generated: ${dt(new Date())}`, W - M, y, { align: 'right' });
  const pFrom = statement && statement.period && statement.period.from;
  if (pFrom) doc.text(`Period: ${dt(pFrom)} – ${dt(new Date())}`, W - M, y + 13, { align: 'right' });
  y += 26;

  // ── Table ──
  tableHead();

  // Opening row.
  doc.setFont('helvetica', 'italic').setFontSize(8.5).setTextColor(90);
  doc.text(truncated ? 'Opening (brought forward)' : 'Opening balance', cPart, y);
  doc.text(balStr(openBal), cBal, y, { align: 'right' });
  y += 15;

  // Rows — use each entry's real running balance directly.
  doc.setFont('helvetica', 'normal').setFontSize(9).setTextColor(40);
  if (!shown.length) {
    doc.setTextColor(120).text('No transactions in this period.', cPart, y);
    y += 14;
  }
  for (const e of shown) {
    if (y > H - 70) { doc.addPage(); y = M + 10; tableHead(); doc.setFont('helvetica', 'normal').setFontSize(9); }
    doc.setTextColor(40);
    doc.text(dt(e.date), cDate, y);
    const particulars = [e.voucher_type, e.voucher_no].filter(Boolean).join(' ') || e.narration || '—';
    doc.text(doc.splitTextToSize(particulars, cDr - cPart - 50)[0] || particulars, cPart, y);
    const debit = Number(e.debit) || 0, credit = Number(e.credit) || 0;
    if (debit) doc.text(money(debit), cDr, y, { align: 'right' });
    if (credit) { doc.setTextColor(20, 120, 70); doc.text(money(credit), cCr, y, { align: 'right' }); doc.setTextColor(40); }
    doc.text(balStr(e.balance), cBal, y, { align: 'right' });
    y += 14;
  }

  // ── Closing ──
  y += 6;
  doc.setDrawColor(A[0], A[1], A[2]).setLineWidth(1).line(M, y, W - M, y);
  y += 16;
  doc.setFont('helvetica', 'bold').setFontSize(11).setTextColor(A[0], A[1], A[2]);
  doc.text('Closing Balance', cPart, y);
  doc.text(Math.abs(closing) < 0.01 ? 'Settled' : balStr(closing), cBal, y, { align: 'right' });
  y += 24;
  doc.setFont('helvetica', 'normal').setFontSize(8).setTextColor(140);
  doc.text('Dr = amount due to us · Cr = advance/credit. This is a system-generated statement.', M, y);

  return Buffer.from(doc.output('arraybuffer'));
}

module.exports = { buildStatementPdf };
