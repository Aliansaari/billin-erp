// One-shot: export the ZEHEN completion audit as xlsx + pdf.
// Uses project-local exceljs + jspdf (already declared deps); drops both
// files in the user's Downloads folder.

const path = require('path');
const fs = require('fs');
const ExcelJS = require('exceljs');
const { jsPDF } = require('jspdf');
require('jspdf-autotable');

const OUT_DIR = 'C:/Users/Ali/Downloads';
const STAMP = new Date().toISOString().slice(0, 10);
const XLSX_PATH = path.join(OUT_DIR, `ERP_Completion_Audit_${STAMP}.xlsx`);
const PDF_PATH  = path.join(OUT_DIR, `ERP_Completion_Audit_${STAMP}.pdf`);

const modules = [
  { name: 'Authentication',          weight: 4,  done: 85, remaining: '"Remember Me", auto-logout timer, forgot-password/email reset. Rate limiter is in-memory (not DB-backed). No account-lock flag on users table.' },
  { name: 'Users / Roles',           weight: 4,  done: 70, remaining: 'No per-role permission-matrix UI for fine-grained rules (cap discount %, rate edit, backdate, etc.). No per-user permission override UI. No audit of permission changes.' },
  { name: 'Parties',                 weight: 9,  done: 90, remaining: 'party_status (Regular/Priority/VIP/Blacklist) only partial UI filtering. Interest-rate field exists but no interest calculation. Credit limit is warning-only, no hard block on bill save.' },
  { name: 'Inventory / Barcode',     weight: 10, done: 85, remaining: 'Barcode type switch (CODE128/CODE39/EAN13) not honored. MOD-10 check digit not implemented. No standalone Stock Adjustment page (only via product edit).' },
  { name: 'Sales',                   weight: 12, done: 90, remaining: 'Hold-bill / Recall-draft flow. Quick Sale Mode toggle. Salesperson role filter is loose.' },
  { name: 'Purchase',                weight: 10, done: 90, remaining: 'Supplier credit-limit enforcement. "Save & Pay" multi-mode split less extensive than spec describes.' },
  { name: 'Returns (Sales/Purchase)',weight: 5,  done: 95, remaining: 'Minor: reason-code dropdown not standardized across both return types.' },
  { name: 'Payments & Receipts',     weight: 8,  done: 85, remaining: 'Multi-bill multi-select allocation is JSON-driven but lacks polished UI. Cheque Pending/Cleared/Bounced lifecycle stored, no reconciliation UI. No SMS/Email receipt send.' },
  { name: 'Reports',                 weight: 14, done: 55, remaining: 'Balance Sheet. Cash Flow Statement. Trial Balance. GSTR-1 / GSTR-3B / HSN summary. ITC report. Sales-by-salesperson. Hourly/peak-hour analysis. Fast/slow movers. Drill-down stock movement per product. Aging endpoint exists — no dedicated Aging page.' },
  { name: 'GST / Tax',               weight: 5,  done: 40, remaining: 'GSTR-1 JSON export. GSTR-3B summary. HSN-wise summary report. ITC report. GST-payable screen. Everything past data-capture.' },
  { name: 'Accounting / Ledgers',    weight: 6,  done: 20, remaining: 'LedgerEntry model exists but no controller posts entries — sales/purchase/payment flows DO NOT write double-entry ledger lines. No Voucher Entries UI. No Ledger Accounts management UI. No Journal / Contra vouchers. Ledger groups invisible in UI.' },
  { name: 'Settings',                weight: 5,  done: 65, remaining: 'Module toggles (warehouse, batch, expiry, serial, audit, interest, bank-recon, manufacturing) only flip flags — no backing implementation. Email/SMS settings. Dashboard-widget customization UI. Terms-and-Conditions / invoice-format editor. HSN management UI.' },
  { name: 'Backup & Restore',        weight: 3,  done: 95, remaining: 'Cloud/remote backup target (current is local JSON). Schedule-health alerts.' },
  { name: 'Import / Export',         weight: 3,  done: 95, remaining: 'Return-voucher Excel round-trip template.' },
  { name: 'Accounting XML Integration',  weight: 2,  done: 90, remaining: 'Conflict-resolution UI when the same voucher differs between this ERP and the accounting system. Auto-poll scheduler (currently manual Pull Now).' },
  { name: 'Dashboard',               weight: 3,  done: 70, remaining: 'Sparklines are faked — need real 30-day series. Upcoming-due-payments widget. Top customers / top products. Hourly trend. Drag-drop widget customization.' },
  { name: 'Optional Advanced Modules', weight: 10, done: 0,  remaining: 'All zero-built, UI toggles exist but no code: Multi-Warehouse, Batch & Expiry, Serial tracking, Manufacturing / BOM / Work Order / Production, Bank Accounts + Reconciliation, Interest on overdue, Audit Trail table.' },
  { name: 'Printing / Invoice Fmts', weight: 3,  done: 40, remaining: 'Server-side PDF invoice generation. Thermal-printer layouts (58/80 mm). Template editor for invoice header/footer/terms. Per-series custom prefixes/format.' },
  { name: 'Infrastructure / Stack',  weight: 4,  done: 55, remaining: 'First-time setup wizard. Packaged .exe/.dmg installer. WebSocket live-sync across LAN clients. In-app help/docs. audit_log DB table. Socket.io imported but unused.' },
];

const weighted = modules.reduce((s, m) => s + m.weight * m.done / 100, 0);
const totalWeight = modules.reduce((s, m) => s + m.weight, 0);
const overallPct = Math.round(weighted / totalWeight * 100 * 10) / 10;

/* ────────────────── XLSX ────────────────── */
(async () => {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'ZEHEN Audit';
  wb.created = new Date();

  // Sheet 1 — Module completion
  const s1 = wb.addWorksheet('Module Completion');
  s1.columns = [
    { header: '#',          key: 'idx',       width: 5 },
    { header: 'Module',     key: 'name',      width: 32 },
    { header: 'Weight %',   key: 'weight',    width: 12 },
    { header: 'Done %',     key: 'done',      width: 12 },
    { header: 'Status',     key: 'status',    width: 14 },
  ];
  modules.forEach((m, i) => {
    const status = m.done >= 90 ? 'Solid' : m.done >= 60 ? 'Partial' : m.done >= 30 ? 'Gaps' : 'Minimal';
    s1.addRow({ idx: i + 1, name: m.name, weight: m.weight, done: m.done, status });
  });
  s1.addRow({});
  const total = s1.addRow({ name: 'OVERALL (weighted)', weight: totalWeight, done: overallPct, status: '' });
  total.font = { bold: true };
  total.getCell('weight').numFmt = '0';
  total.getCell('done').numFmt = '0.0';

  // Header style
  s1.getRow(1).eachCell(c => {
    c.font = { bold: true, color: { argb: 'FFFFFFFF' } };
    c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF4F46E5' } };
    c.alignment = { vertical: 'middle', horizontal: 'left' };
  });
  // Colour the Done % cell
  s1.eachRow((row, n) => {
    if (n === 1 || n === s1.rowCount) return;
    const doneCell = row.getCell('done');
    const v = Number(doneCell.value);
    const argb = v >= 90 ? 'FFDCFCE7' : v >= 60 ? 'FFFEF3C7' : v >= 30 ? 'FFFED7AA' : 'FFFECACA';
    doneCell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb } };
    doneCell.alignment = { horizontal: 'center' };
  });

  // Sheet 2 — What's left
  const s2 = wb.addWorksheet('Whats Left');
  s2.columns = [
    { header: 'Module',         key: 'name',      width: 32 },
    { header: 'Done %',         key: 'done',      width: 10 },
    { header: "What's Missing", key: 'remaining', width: 120 },
  ];
  modules.forEach(m => {
    const r = s2.addRow({ name: m.name, done: m.done, remaining: m.remaining });
    r.getCell('remaining').alignment = { wrapText: true, vertical: 'top' };
    r.getCell('done').alignment = { horizontal: 'center' };
    r.height = Math.max(18, Math.ceil(m.remaining.length / 70) * 15);
  });
  s2.getRow(1).eachCell(c => {
    c.font = { bold: true, color: { argb: 'FFFFFFFF' } };
    c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFB1472F' } };
  });

  // Sheet 3 — Summary + priorities
  const s3 = wb.addWorksheet('Summary');
  s3.columns = [{ width: 4 }, { width: 90 }];
  const addLine = (text, opts = {}) => {
    const row = s3.addRow([ '', text ]);
    if (opts.bold) row.getCell(2).font = { bold: true, size: opts.size || 11 };
    if (opts.size) row.getCell(2).font = { ...(row.getCell(2).font || {}), size: opts.size };
  };
  addLine('ZEHEN — Completion Audit', { bold: true, size: 16 });
  addLine(`Generated ${new Date().toLocaleString()}`);
  addLine('');
  addLine(`Overall completion: ${overallPct}%`, { bold: true, size: 14 });
  addLine('');
  addLine('Core transactional ERP is production-ready:', { bold: true });
  addLine('   Sales, Purchase, Returns, Parties, Payments, Inventory + Barcode, Backup, Import/Export, Accounting sync.');
  addLine('');
  addLine('Priority gaps to push past 85%:', { bold: true });
  addLine('   1. Statutory GST reports — GSTR-1, GSTR-3B, HSN-wise summary, ITC.');
  addLine('   2. Double-entry ledger engine — wire LedgerEntry into bill/payment create paths.');
  addLine('   3. Balance Sheet + Trial Balance + Cash Flow.');
  addLine('   4. Bank Accounts + Reconciliation module.');
  addLine('');
  addLine('Biggest zero-built bucket (10% of total weight):', { bold: true });
  addLine('   Multi-Warehouse, Batch & Expiry, Serial tracking, Manufacturing/BOM,');
  addLine('   Bank Reconciliation, Interest on overdue, Audit Trail. UI toggles exist but no code.');

  await wb.xlsx.writeFile(XLSX_PATH);
  console.log('wrote', XLSX_PATH);

  /* ────────────────── PDF ────────────────── */
  const doc = new jsPDF({ unit: 'pt', format: 'a4' });
  doc.setFontSize(20);
  doc.setFont(undefined, 'bold');
  doc.text('ZEHEN — Completion Audit', 40, 54);
  doc.setFont(undefined, 'normal');
  doc.setFontSize(10);
  doc.setTextColor(90);
  doc.text(`Generated ${new Date().toLocaleString()}`, 40, 72);
  doc.setTextColor(0);

  // Overall KPI box
  doc.setFillColor(79, 70, 229);
  doc.roundedRect(40, 90, 515, 50, 6, 6, 'F');
  doc.setTextColor(255);
  doc.setFontSize(13);
  doc.text('Overall Completion', 60, 115);
  doc.setFontSize(28);
  doc.setFont(undefined, 'bold');
  doc.text(`${overallPct}%`, 470, 126, { align: 'right' });
  doc.setFont(undefined, 'normal');
  doc.setTextColor(0);

  // Table 1 — Module completion
  doc.autoTable({
    startY: 160,
    head: [[ '#', 'Module', 'Weight %', 'Done %', 'Status' ]],
    body: modules.map((m, i) => {
      const status = m.done >= 90 ? 'Solid' : m.done >= 60 ? 'Partial' : m.done >= 30 ? 'Gaps' : 'Minimal';
      return [ i + 1, m.name, m.weight, `${m.done}%`, status ];
    }).concat([[ '', 'OVERALL (weighted)', totalWeight, `${overallPct}%`, '' ]]),
    theme: 'striped',
    headStyles: { fillColor: [79, 70, 229], textColor: 255, fontStyle: 'bold' },
    styles: { fontSize: 9, cellPadding: 5 },
    columnStyles: {
      0: { cellWidth: 28, halign: 'center' },
      2: { cellWidth: 60, halign: 'center' },
      3: { cellWidth: 60, halign: 'center' },
      4: { cellWidth: 60, halign: 'center' },
    },
    didParseCell: (data) => {
      // Colour the last (OVERALL) row
      if (data.row.index === modules.length && data.section === 'body') {
        data.cell.styles.fontStyle = 'bold';
        data.cell.styles.fillColor = [226, 232, 240];
      }
      // Status tint
      if (data.column.index === 4 && data.section === 'body' && data.row.index < modules.length) {
        const v = modules[data.row.index].done;
        const c = v >= 90 ? [220, 252, 231] : v >= 60 ? [254, 243, 199] : v >= 30 ? [254, 215, 170] : [254, 202, 202];
        data.cell.styles.fillColor = c;
      }
    },
  });

  // Table 2 — What's left
  doc.addPage();
  doc.setFontSize(16);
  doc.setFont(undefined, 'bold');
  doc.text("What's Left", 40, 54);
  doc.setFont(undefined, 'normal');
  doc.setFontSize(9);
  doc.setTextColor(90);
  doc.text('Specific items still to build, grouped by module.', 40, 70);
  doc.setTextColor(0);

  doc.autoTable({
    startY: 90,
    head: [[ 'Module', 'Done %', "What's Missing" ]],
    body: modules.map(m => [ m.name, `${m.done}%`, m.remaining ]),
    theme: 'grid',
    headStyles: { fillColor: [177, 71, 47], textColor: 255, fontStyle: 'bold' },
    styles: { fontSize: 8.5, cellPadding: 5, valign: 'top' },
    columnStyles: {
      0: { cellWidth: 110, fontStyle: 'bold' },
      1: { cellWidth: 45, halign: 'center' },
      2: { cellWidth: 360 },
    },
  });

  // Recommendations page
  doc.addPage();
  doc.setFontSize(16);
  doc.setFont(undefined, 'bold');
  doc.text('Priority roadmap', 40, 54);
  doc.setFont(undefined, 'normal');
  const lines = [
    '',
    'Solid today (day-to-day billing is production-ready):',
    '  Sales, Purchase, Returns, Parties, Payments, Inventory + Barcode,',
    '  Backup, Import/Export, Accounting XML integration.',
    '',
    'To push past 85%:',
    '  1. Statutory GST reports — GSTR-1, GSTR-3B, HSN-wise summary, ITC.',
    '  2. Wire LedgerEntry into bill/payment flows for true double-entry.',
    '  3. Balance Sheet + Trial Balance + Cash Flow.',
    '  4. Bank Accounts + Reconciliation.',
    '',
    'Biggest zero-built bucket (10% of total weight):',
    '  Multi-Warehouse, Batch & Expiry, Serial tracking,',
    '  Manufacturing / BOM, Bank Reconciliation, Interest on overdue,',
    '  Audit Trail. UI toggles exist but no code.',
    '',
    'Low-hanging UI polish:',
    '  Thermal-printer invoice layout. PDF server-side invoice.',
    '  Aging report page. Dashboard real sparklines.',
    '  Per-role permission matrix UI.',
  ];
  doc.setFontSize(11);
  let y = 90;
  for (const l of lines) {
    if (l.endsWith(':') && !l.startsWith(' ')) {
      doc.setFont(undefined, 'bold');
    } else {
      doc.setFont(undefined, 'normal');
    }
    doc.text(l, 40, y);
    y += 16;
  }

  doc.save(PDF_PATH);
  console.log('wrote', PDF_PATH);
})().catch(e => { console.error(e); process.exit(1); });
