// ── Ledger statement → PDF ──────────────────────────────────────────────
//
// Shared PDF generator for Customer Statement / Supplier Statement /
// COA Ledger. Uses the already-bundled jsPDF + jspdf-autotable so we
// don't add a new dependency. Lazy-loaded so the cold path doesn't pay
// the ~150KB at app start.
//
// Layout (A4 portrait):
//   ┌─────────────────────────────────────────────────────┐
//   │ <Company name>                                       │ ← letterhead
//   │ Customer Statement | <Party / Ledger Name>           │
//   │ Period: <from> → <to>                                │
//   ├─────────────────────────────────────────────────────┤
//   │ Date | Type | Voucher No | Particulars | Dr | Cr | Bal│ ← head
//   │ Opening Balance                                      │
//   │ ... entry rows ...                                   │
//   │ Closing Balance      Σ Dr   Σ Cr     <closing>       │ ← strip
//   └─────────────────────────────────────────────────────┘
//
// Mirrors the on-screen layout closely so a printed-and-emailed PDF
// reads the same as the live page.

import dayjs from 'dayjs';
import { deriveCategory } from '../components/LedgerStatement';

const fmt = (v) =>
  parseFloat(v || 0).toLocaleString('en-IN', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });

const fmtDate = (d) => (d ? dayjs(d).format('DD-MM-YYYY') : '—');

// Tally sign suffix for balance cells. Positive = Dr (we owe / asset),
// negative = Cr (they owe / liability). Mirrors the on-screen pill.
const sign = (v) => {
  const n = parseFloat(v) || 0;
  if (n === 0) return '0.00';
  return `${fmt(Math.abs(n))} ${n >= 0 ? 'Dr' : 'Cr'}`;
};

/**
 * @param {object}  opts
 * @param {string}  opts.title      "Customer Statement" | "Supplier Statement" | "Ledger"
 * @param {string}  opts.subtitle   Party name OR ledger name (whichever applies)
 * @param {object}  opts.statement  ledgerAPI.statement response shape
 * @param {Set?}    opts.voucherFilter Optional category filter (matches LedgerStatement)
 * @param {object?} opts.party      Party record — included for party statements so
 *                                  the PDF carries city / mobile / GSTIN under the
 *                                  subtitle (the statement is mailed externally).
 * @param {string?} opts.companyName Override for the letterhead. Falls back to
 *                                  window.__APP_COMPANY_NAME__ then to a generic
 *                                  "Statement of Account".
 */
export async function downloadStatementPdf({
  title,
  subtitle,
  statement,
  voucherFilter = null,
  party = null,
  companyName,
}) {
  if (!statement) return;

  // Lazy-load the heavy deps. jsPDF ships its own PDF engine; the
  // autoTable plugin attaches itself to the prototype as a side
  // effect of the import.
  const { default: jsPDF } = await import('jspdf');
  await import('jspdf-autotable');

  const doc = new jsPDF({ unit: 'pt', format: 'a4' });
  const pageW = doc.internal.pageSize.getWidth();

  // ── Letterhead ────────────────────────────────────────────────────
  const company = companyName || window.__APP_COMPANY_NAME__ || 'Statement of Account';
  doc.setFont('helvetica', 'bold').setFontSize(16).setTextColor(0, 0, 0);
  doc.text(company, 40, 50);

  doc.setFont('helvetica', 'normal').setFontSize(11).setTextColor(80);
  doc.text(`${title} · ${subtitle || ''}`.trim(), 40, 70);

  // Optional party block — three short lines under the subtitle.
  let cursor = 88;
  if (party) {
    const lines = [];
    if (party.address_line_1) lines.push(party.address_line_1);
    const cityState = [party.city, party.state].filter(Boolean).join(', ');
    if (cityState) lines.push(cityState);
    // Plain "Mobile:" prefix instead of the 📞 glyph — jsPDF's default
    // Helvetica has no emoji table, so the screen-friendly icon paints
    // as garbage on the PDF (e.g. "Ø=ÜP 9820001112"). The screen UI
    // keeps the emoji; the PDF gets ASCII so it's mail-ready.
    if (party.mobile_1) lines.push(`Mobile: ${party.mobile_1}`);
    if (party.gstin)    lines.push(`GSTIN: ${party.gstin}`);
    doc.setFontSize(9).setTextColor(110);
    for (const ln of lines) {
      doc.text(ln, 40, cursor);
      cursor += 12;
    }
  }

  // ASCII "to" for the same reason — Helvetica has no → arrow.
  const period = `Period: ${statement.period?.from || 'inception'} to ${statement.period?.to || 'today'}`;
  doc.setFontSize(9).setTextColor(120);
  doc.text(period, 40, cursor);
  cursor += 6;

  // ── Build table rows ──────────────────────────────────────────────
  const decorated = (statement.entries || []).map(e => ({ ...e, category: deriveCategory(e) }));
  const filtered = voucherFilter && voucherFilter.size > 0
    ? decorated.filter(e => voucherFilter.has(e.category))
    : decorated;

  // Recompute closing across the visible set when filtering. Same
  // logic LedgerStatement uses on screen — the PDF and the page agree.
  let dr = 0, cr = 0;
  for (const e of filtered) {
    dr += parseFloat(e.debit)  || 0;
    cr += parseFloat(e.credit) || 0;
  }
  const visibleClosing = (voucherFilter && voucherFilter.size > 0)
    ? (parseFloat(statement.opening_balance) || 0) + dr - cr
    : parseFloat(statement.closing_balance);
  const visibleDebit  = (voucherFilter && voucherFilter.size > 0) ? dr : statement.total_debit;
  const visibleCredit = (voucherFilter && voucherFilter.size > 0) ? cr : statement.total_credit;

  const head = [['Date', 'Type', 'Voucher No', 'Particulars', 'Debit', 'Credit', 'Balance']];

  const body = [
    // Opening balance
    [
      fmtDate(statement.period?.from), '', '', 'Opening Balance', '', '', sign(statement.opening_balance),
    ],
    // Entries
    ...filtered.map(e => [
      fmtDate(e.date),
      e.category || '',
      e.voucher_no || '',
      e.narration || '',
      e.debit  > 0 ? fmt(e.debit)  : '',
      e.credit > 0 ? fmt(e.credit) : '',
      sign(e.balance),
    ]),
  ];

  const foot = [[
    '',
    '',
    '',
    voucherFilter && voucherFilter.size > 0 ? 'Closing Balance (filtered)' : 'Closing Balance',
    fmt(visibleDebit),
    fmt(visibleCredit),
    sign(visibleClosing),
  ]];

  doc.autoTable({
    startY: cursor + 14,
    head,
    body,
    foot,
    theme: 'grid',
    styles:      { fontSize: 8.5, cellPadding: 4, lineColor: [220, 220, 220], lineWidth: 0.4 },
    headStyles:  { fillColor: [248, 245, 240], textColor: [70, 70, 70], fontStyle: 'bold', fontSize: 8 },
    footStyles:  { fillColor: [248, 245, 240], textColor: [0, 0, 0], fontStyle: 'bold', fontSize: 9.5 },
    columnStyles: {
      0: { cellWidth: 60 },                                     // Date
      1: { cellWidth: 70 },                                     // Type
      2: { cellWidth: 70 },                                     // Voucher No
      3: { cellWidth: 'auto' },                                 // Particulars
      4: { cellWidth: 65, halign: 'right' },                    // Debit
      5: { cellWidth: 65, halign: 'right' },                    // Credit
      6: { cellWidth: 80, halign: 'right' },                    // Balance
    },
    // Soft tint on the Opening Balance row (first body row) so it
    // reads as a section anchor, the same way it does on screen.
    didParseCell: (data) => {
      if (data.section === 'body' && data.row.index === 0) {
        data.cell.styles.fillColor   = [253, 250, 246];
        data.cell.styles.textColor   = [110, 110, 110];
        data.cell.styles.fontStyle   = 'italic';
      }
    },
    margin: { left: 40, right: 40 },
  });

  // ── Footer + filename ─────────────────────────────────────────────
  const generatedAt = dayjs().format('DD MMM YYYY · HH:mm');
  const totalPages = doc.internal.getNumberOfPages();
  for (let i = 1; i <= totalPages; i++) {
    doc.setPage(i);
    doc.setFontSize(8).setTextColor(150);
    doc.text(`Generated ${generatedAt}`, 40, doc.internal.pageSize.getHeight() - 20);
    doc.text(
      `Page ${i} of ${totalPages}`,
      pageW - 40,
      doc.internal.pageSize.getHeight() - 20,
      { align: 'right' },
    );
  }

  const safe = (subtitle || 'statement').replace(/[^a-z0-9]+/gi, '-').toLowerCase();
  const filename = `${title.replace(/\s+/g, '-').toLowerCase()}-${safe}.pdf`;
  doc.save(filename);
}

export async function buildStatementPdf(opts) {
  if (!opts.statement) return null;
  const { default: jsPDF } = await import('jspdf');
  await import('jspdf-autotable');

  const doc = new jsPDF({ unit: 'pt', format: 'a4' });
  const pageW = doc.internal.pageSize.getWidth();
  const { title, subtitle, statement, voucherFilter = null, party = null, companyName } = opts;

  const company = companyName || window.__APP_COMPANY_NAME__ || 'Statement of Account';
  doc.setFont('helvetica', 'bold').setFontSize(16).setTextColor(0, 0, 0);
  doc.text(company, 40, 50);
  doc.setFont('helvetica', 'normal').setFontSize(11).setTextColor(80);
  doc.text(`${title} · ${subtitle || ''}`.trim(), 40, 70);

  let cursor = 88;
  if (party) {
    const lines = [];
    if (party.address_line_1) lines.push(party.address_line_1);
    const cityState = [party.city, party.state].filter(Boolean).join(', ');
    if (cityState) lines.push(cityState);
    if (party.mobile_1) lines.push(`Mobile: ${party.mobile_1}`);
    if (party.gstin)    lines.push(`GSTIN: ${party.gstin}`);
    doc.setFontSize(9).setTextColor(110);
    for (const ln of lines) { doc.text(ln, 40, cursor); cursor += 12; }
  }

  const period = `Period: ${statement.period?.from || 'inception'} to ${statement.period?.to || 'today'}`;
  doc.setFontSize(9).setTextColor(120);
  doc.text(period, 40, cursor);
  cursor += 6;

  const decorated = (statement.entries || []).map(e => ({ ...e, category: deriveCategory(e) }));
  const filtered = voucherFilter && voucherFilter.size > 0
    ? decorated.filter(e => voucherFilter.has(e.category)) : decorated;

  let dr = 0, cr = 0;
  for (const e of filtered) { dr += parseFloat(e.debit) || 0; cr += parseFloat(e.credit) || 0; }
  const visibleClosing = (voucherFilter && voucherFilter.size > 0)
    ? (parseFloat(statement.opening_balance) || 0) + dr - cr
    : parseFloat(statement.closing_balance);

  const head = [['Date', 'Type', 'Voucher No', 'Particulars', 'Debit', 'Credit', 'Balance']];
  const body = [
    [fmtDate(statement.period?.from), '', '', 'Opening Balance', '', '', sign(statement.opening_balance)],
    ...filtered.map(e => [
      fmtDate(e.date), e.category || '', e.voucher_no || '', e.narration || '',
      e.debit  > 0 ? fmt(e.debit)  : '',
      e.credit > 0 ? fmt(e.credit) : '',
      sign(e.balance),
    ]),
  ];
  const foot = [['', '', '', 'Closing Balance', fmt(voucherFilter && voucherFilter.size > 0 ? dr : statement.total_debit), fmt(voucherFilter && voucherFilter.size > 0 ? cr : statement.total_credit), sign(visibleClosing)]];

  doc.autoTable({
    startY: cursor + 14, head, body, foot, theme: 'grid',
    styles:      { fontSize: 8.5, cellPadding: 4, lineColor: [220, 220, 220], lineWidth: 0.4 },
    headStyles:  { fillColor: [248, 245, 240], textColor: [70, 70, 70], fontStyle: 'bold', fontSize: 8 },
    footStyles:  { fillColor: [248, 245, 240], textColor: [0, 0, 0], fontStyle: 'bold', fontSize: 9.5 },
    columnStyles: { 0:{cellWidth:60}, 1:{cellWidth:70}, 2:{cellWidth:70}, 3:{cellWidth:'auto'}, 4:{cellWidth:65,halign:'right'}, 5:{cellWidth:65,halign:'right'}, 6:{cellWidth:80,halign:'right'} },
    didParseCell: (data) => {
      if (data.section === 'body' && data.row.index === 0) {
        data.cell.styles.fillColor = [253, 250, 246];
        data.cell.styles.textColor = [110, 110, 110];
        data.cell.styles.fontStyle = 'italic';
      }
    },
    margin: { left: 40, right: 40 },
  });

  const { default: dayjs2 } = await import('dayjs');
  const generatedAt = dayjs2().format('DD MMM YYYY · HH:mm');
  const totalPages = doc.internal.getNumberOfPages();
  for (let i = 1; i <= totalPages; i++) {
    doc.setPage(i);
    doc.setFontSize(8).setTextColor(150);
    doc.text(`Generated ${generatedAt}`, 40, doc.internal.pageSize.getHeight() - 20);
    doc.text(`Page ${i} of ${totalPages}`, pageW - 40, doc.internal.pageSize.getHeight() - 20, { align: 'right' });
  }

  const safe2 = (subtitle || 'statement').replace(/[^a-z0-9]+/gi, '-').toLowerCase();
  const filename = `${(title || 'statement').replace(/\s+/g, '-').toLowerCase()}-${safe2}.pdf`;
  return { blob: doc.output('blob'), filename };
}
