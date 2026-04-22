/*
 * Party Ledger — Tally-style account statement.
 *
 * Fixed-window layout: the page itself doesn't scroll — only the table body
 * inside `.pl-scroll` scrolls. Header (party picker + period + columns),
 * context line, and action toolbar all stay pinned.
 *
 * Data source: `partyAPI.getLedger(id, { from_date, to_date })` returns
 *   { party, opening_balance, entries, closing_balance, total_debit, total_credit }
 * where each entry is
 *   { date, particulars, ref_number, voucher_type, voucher_no, debit, credit,
 *     type, id, balance, reference_bill? }
 *
 * Voucher types surfaced to the user:
 *   Sales            — `sales` (debit side)
 *   Purchase         — `purchase` (credit side)
 *   Receipt          — `payment` (receipt) + `sales_initial_payment`
 *   Payment          — `payment` (payment) + `purchase_initial_payment`
 *   Sales Return     — `sales_return` + `sales_return_amount`
 *   Purchase Return  — `purchase_return`
 */

import React, { useEffect, useMemo, useRef, useState } from 'react';
import { DatePicker, Spin, Tooltip, message } from 'antd';
import {
  SearchOutlined, ArrowLeftOutlined, ReloadOutlined,
  PrinterOutlined, FilePdfOutlined, FileExcelOutlined,
  WhatsAppOutlined, AppstoreOutlined, CalendarOutlined,
} from '@ant-design/icons';
import { useNavigate } from 'react-router-dom';
import dayjs from 'dayjs';
import { partyAPI } from '../../api';
import './party-ledger.css';

/* ──────────────────────────────────────────────────────────────── */
/* Formatters                                                       */
/* ──────────────────────────────────────────────────────────────── */

const fmt = (v) =>
  parseFloat(v || 0).toLocaleString('en-IN', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
const fmtShort = (v) =>
  Math.round(parseFloat(v || 0)).toLocaleString('en-IN');

const fmtDate = (d) => (d ? dayjs(d).format('DD-MM-YYYY') : '—');

/* ──────────────────────────────────────────────────────────────── */
/* Type catalog — how a backend `type`/`voucher_type` maps to a     */
/* user-facing voucher category and a coloured dot.                 */
/* ──────────────────────────────────────────────────────────────── */

const TYPE_CATEGORIES = [
  { key: 'Sales',             dot: 'td-sale',  label: 'Sales' },
  { key: 'Purchase',          dot: 'td-purch', label: 'Purchase' },
  { key: 'Receipt',           dot: 'td-recv',  label: 'Receipts' },
  { key: 'Payment',           dot: 'td-paym',  label: 'Payments' },
  { key: 'Sales Return',      dot: 'td-sret',  label: 'Sales Returns' },
  { key: 'Purchase Return',   dot: 'td-pret',  label: 'Purchase Returns' },
];

// Classify a backend entry into one of the filter categories above.
const categoryFor = (e) => {
  const t = e.type || '';
  if (t === 'sales')                    return 'Sales';
  if (t === 'purchase')                 return 'Purchase';
  if (t === 'sales_initial_payment')    return 'Receipt';
  if (t === 'purchase_initial_payment') return 'Payment';
  if (t === 'sales_return_amount')      return 'Sales Return';
  if (t === 'sales_return')             return 'Sales Return';
  if (t === 'purchase_return')          return 'Purchase Return';
  if (t === 'payment' && (e.voucher_type === 'Receipt' || e.credit > 0)) return 'Receipt';
  if (t === 'payment') return 'Payment';
  return 'Other';
};

// Short chip label shown in the Type column.
const typeChip = (e) => {
  const t = e.type || '';
  if (t === 'sales')                    return { label: 'Sales',            dot: 'td-sale' };
  if (t === 'purchase')                 return { label: 'Purchase',         dot: 'td-purch' };
  if (t === 'sales_initial_payment')    return { label: 'Receipt',          dot: 'td-recv' };
  if (t === 'purchase_initial_payment') return { label: 'Payment',          dot: 'td-paym' };
  if (t === 'sales_return_amount')      return { label: 'Return (at bill)', dot: 'td-sret' };
  if (t === 'sales_return')             return { label: e.particulars?.startsWith('Credit Note') ? 'Credit Note' : 'Sales Return', dot: 'td-sret' };
  if (t === 'purchase_return')          return { label: e.particulars?.startsWith('Debit Note')  ? 'Debit Note'  : 'Purchase Return', dot: 'td-pret' };
  if (t === 'payment' && (e.voucher_type === 'Receipt' || e.credit > 0)) return { label: 'Receipt', dot: 'td-recv' };
  if (t === 'payment') return { label: 'Payment', dot: 'td-paym' };
  return { label: e.particulars || 'Entry', dot: 'td-jrnl' };
};

/* ──────────────────────────────────────────────────────────────── */
/* Column (extras) options — persisted via localStorage             */
/* ──────────────────────────────────────────────────────────────── */

const COLS_STORAGE_KEY = 'partyLedger_cols_v1';
const DEFAULT_COLS = {
  narration: true,  // remark under the amount
  alloc:     true,  // "Against INV-xxx · ₹xxx"
  drcr:      true,  // Dr/Cr tag beside balance
  mode:      false, // Payment mode (cash/UPI/bank/cheque)
  due:       false, // Due date on each bill
};
const COLS_META = [
  { key: 'narration', label: 'Notes / narration',   desc: 'Remark stored with the voucher' },
  { key: 'alloc',     label: 'Payment depth',       desc: 'Which bills a receipt / payment covered' },
  { key: 'drcr',      label: 'Dr / Cr tag',         desc: 'Direction label beside every amount' },
  { key: 'mode',      label: 'Payment mode',        desc: 'Cash · UPI · Bank · Cheque reference' },
  { key: 'due',       label: 'Due date',            desc: 'Show due date on each bill' },
];

/* ──────────────────────────────────────────────────────────────── */
/* Period presets                                                   */
/* ──────────────────────────────────────────────────────────────── */

const PERIOD_PRESETS = [
  { key: 'fy',     label: 'This financial year', range: () => [dayjs().startOf('year'), dayjs()] },
  { key: 'lfy',    label: 'Last financial year', range: () => [dayjs().subtract(1, 'year').startOf('year'), dayjs().subtract(1, 'year').endOf('year')] },
  { key: 'month',  label: 'This month',          range: () => [dayjs().startOf('month'), dayjs().endOf('month')] },
  { key: 'lmonth', label: 'Last month',          range: () => [dayjs().subtract(1, 'month').startOf('month'), dayjs().subtract(1, 'month').endOf('month')] },
  { key: 'quarter',label: 'This quarter',        range: () => [dayjs().startOf('quarter'), dayjs().endOf('quarter')] },
];

const defaultPeriod = () => PERIOD_PRESETS[0].range();

/* ──────────────────────────────────────────────────────────────── */
/* Main component                                                   */
/* ──────────────────────────────────────────────────────────────── */

export default function PartyLedger() {
  const navigate = useNavigate();

  // Parties + selection
  const [parties, setParties]   = useState([]);
  const [partiesLoading, setPartiesLoading] = useState(false);
  const [partyFilter, setPartyFilter] = useState('all'); // 'all' | 'customer' | 'supplier'
  const [partyId, setPartyId] = useState(null);
  const [partySearch, setPartySearch] = useState('');
  const [partyPopOpen, setPartyPopOpen] = useState(false);

  // Date range
  const [dateRange, setDateRange] = useState(defaultPeriod());
  const [periodPopOpen, setPeriodPopOpen] = useState(false);
  const [customFrom, setCustomFrom] = useState(null);
  const [customTo,   setCustomTo]   = useState(null);

  // Column extras
  const [cols, setCols] = useState(() => {
    try {
      const saved = JSON.parse(localStorage.getItem(COLS_STORAGE_KEY) || 'null');
      return saved && typeof saved === 'object' ? { ...DEFAULT_COLS, ...saved } : DEFAULT_COLS;
    } catch { return DEFAULT_COLS; }
  });
  useEffect(() => {
    try { localStorage.setItem(COLS_STORAGE_KEY, JSON.stringify(cols)); } catch { /* ignore */ }
  }, [cols]);
  const extraCount = Object.values(cols).filter(Boolean).length;
  const [colsPopOpen, setColsPopOpen] = useState(false);

  // Type filter
  const [hiddenTypes, setHiddenTypes] = useState(new Set());
  const [typePopOpen, setTypePopOpen] = useState(false);

  // Ledger data
  const [ledger, setLedger] = useState(null);
  const [ledgerLoading, setLedgerLoading] = useState(false);

  // Load parties on mount
  useEffect(() => { loadParties(); }, []);

  const loadParties = async () => {
    setPartiesLoading(true);
    try {
      // Recalculate balances before listing so the current_balance badges in
      // the picker match what the ledger will actually render.
      await partyAPI.recalculateBalances().catch(() => {});
      const { data } = await partyAPI.getAll({ limit: 2000 });
      setParties(data?.data || data || []);
    } catch {
      message.error('Failed to load parties');
    }
    setPartiesLoading(false);
  };

  // Auto-select the first party with a non-zero balance on first load (so the
  // page has something meaningful to show without forcing the user to pick).
  useEffect(() => {
    if (!partyId && parties.length > 0) {
      const first = parties.find(p => Math.abs(parseFloat(p.current_balance || 0)) > 0.01) || parties[0];
      if (first) setPartyId(first.party_id);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [parties]);

  // Load ledger whenever party or date range changes
  useEffect(() => {
    if (partyId) loadLedger();
    else setLedger(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [partyId, dateRange[0]?.valueOf(), dateRange[1]?.valueOf()]);

  const loadLedger = async () => {
    setLedgerLoading(true);
    try {
      const params = {};
      if (dateRange[0]) params.from_date = dayjs(dateRange[0]).format('YYYY-MM-DD');
      if (dateRange[1]) params.to_date   = dayjs(dateRange[1]).format('YYYY-MM-DD');
      const { data } = await partyAPI.getLedger(partyId, params);
      setLedger(data);
    } catch (e) {
      message.error('Failed to load ledger');
      setLedger(null);
    }
    setLedgerLoading(false);
  };

  // Derived: selected party object, filter lists, counts per type
  const selected = useMemo(
    () => parties.find(p => p.party_id === partyId) || null,
    [parties, partyId]
  );

  const partiesByTab = useMemo(() => {
    const q = partySearch.trim().toLowerCase();
    return parties
      .filter(p => {
        if (partyFilter === 'customer' && p.party_type !== 'Customer') return false;
        if (partyFilter === 'supplier' && p.party_type !== 'Supplier') return false;
        if (!q) return true;
        return (
          (p.party_name || '').toLowerCase().includes(q) ||
          (p.mobile_1 || '').includes(q) ||
          (p.city || '').toLowerCase().includes(q) ||
          (p.gst_number || '').toLowerCase().includes(q)
        );
      });
  }, [parties, partyFilter, partySearch]);

  const allEntries = useMemo(() => {
    if (!ledger) return [];
    return (ledger.entries || []).map(e => ({ ...e, _cat: categoryFor(e) }));
  }, [ledger]);

  const typeCounts = useMemo(() => {
    const map = {};
    TYPE_CATEGORIES.forEach(t => { map[t.key] = 0; });
    allEntries.forEach(e => { if (map[e._cat] != null) map[e._cat]++; });
    return map;
  }, [allEntries]);

  const visibleEntries = useMemo(
    () => allEntries.filter(e => !hiddenTypes.has(e._cat)),
    [allEntries, hiddenTypes]
  );

  // Totals of the VISIBLE rows (what the user actually sees)
  const totals = useMemo(() => {
    return visibleEntries.reduce(
      (acc, e) => ({ debit: acc.debit + (e.debit || 0), credit: acc.credit + (e.credit || 0) }),
      { debit: 0, credit: 0 }
    );
  }, [visibleEntries]);

  const openingBalance = parseFloat(ledger?.opening_balance || 0);
  const closingBalance = parseFloat(ledger?.closing_balance || 0);

  /* ── Period helpers ── */

  const activePreset = useMemo(() => {
    if (!dateRange[0] || !dateRange[1]) return null;
    return PERIOD_PRESETS.find(p => {
      const [a, b] = p.range();
      return dayjs(a).isSame(dateRange[0], 'day') && dayjs(b).isSame(dateRange[1], 'day');
    })?.key || null;
  }, [dateRange]);

  const periodLabel = () => {
    if (!dateRange[0] || !dateRange[1]) return 'All time';
    return `${dayjs(dateRange[0]).format('DD MMM YY')} — ${dayjs(dateRange[1]).format('DD MMM YY')}`;
  };

  /* ── Toolbar handlers ── */

  const handleBack = () => navigate(-1);

  const handleReset = () => {
    setDateRange(defaultPeriod());
    setCustomFrom(null);
    setCustomTo(null);
    setHiddenTypes(new Set());
    setPartySearch('');
    setPartyFilter('all');
    setCols(DEFAULT_COLS);
    message.success('Filters reset');
  };

  // Build the data matrix that Print/PDF/Excel/WhatsApp all share.
  // Pure function — no side effects — so it can be called from any handler.
  const buildReport = () => {
    if (!selected || !ledger) return null;

    const headers = ['Date', 'Type', 'Ref / Voucher', 'Debit (₹)', 'Credit (₹)', 'Balance (₹)'];

    const rows = [];
    // Opening as first row
    rows.push({
      date: dateRange[0] ? fmtDate(dateRange[0]) : '—',
      type: 'Opening Balance',
      ref:  '—',
      debit: '', credit: '',
      balance: openingBalance === 0
        ? '0.00'
        : `${fmt(Math.abs(openingBalance))} ${openingBalance >= 0 ? 'Dr' : 'Cr'}`,
      _open: true,
    });
    visibleEntries.forEach(e => {
      rows.push({
        date: fmtDate(e.date),
        type: typeChip(e).label,
        ref:  e.ref_number || '—',
        debit:  e.debit  > 0 ? fmt(e.debit)  : '',
        credit: e.credit > 0 ? fmt(e.credit) : '',
        balance: e.balance === 0
          ? '0.00'
          : `${fmt(Math.abs(e.balance))} ${e.balance >= 0 ? 'Dr' : 'Cr'}`,
      });
    });
    // Closing as last row
    rows.push({
      date: dateRange[1] ? fmtDate(dateRange[1]) : fmtDate(dayjs()),
      type: 'Closing Balance',
      ref:  '—',
      debit: '', credit: '',
      balance: closingBalance === 0
        ? '0.00'
        : `${fmt(Math.abs(closingBalance))} ${closingBalance >= 0 ? 'Dr' : 'Cr'}`,
      _close: true,
    });

    const footer = {
      type: 'Total',
      debit:  fmt(totals.debit),
      credit: fmt(totals.credit),
      balance: closingBalance === 0
        ? '0.00'
        : `${fmt(Math.abs(closingBalance))} ${closingBalance >= 0 ? 'Dr' : 'Cr'}`,
    };

    return {
      title: `Party Ledger — ${selected.party_name}`,
      subtitle: `${periodLabel()} · Generated ${dayjs().format('DD MMM YYYY hh:mm A')}`,
      headers,
      rows,
      footer,
    };
  };

  const handlePrint = () => {
    const r = buildReport();
    if (!r) { message.warning('Select a party first'); return; }
    const tableRows = r.rows.map(row => {
      const cls = row._open ? 'open-row' : row._close ? 'close-row' : '';
      return `<tr class="${cls}">
        <td>${row.date}</td>
        <td>${row.type}</td>
        <td>${row.ref}</td>
        <td class="r">${row.debit}</td>
        <td class="r">${row.credit}</td>
        <td class="r b">${row.balance}</td>
      </tr>`;
    }).join('');
    const html = `<!DOCTYPE html><html><head><meta charset="utf-8">
      <title>${r.title}</title>
      <style>
        @page { margin: 14mm; }
        * { margin: 0; padding: 0; box-sizing: border-box; }
        body { font-family: Arial, sans-serif; color: #111; font-size: 12px; }
        h1 { font-size: 20px; margin-bottom: 2px; }
        .sub { font-size: 11px; color: #666; margin-bottom: 10px; }
        .meta { font-size: 11px; margin-bottom: 12px; display: flex; justify-content: space-between; }
        .meta b { font-weight: 600; }
        table { width: 100%; border-collapse: collapse; margin-top: 6px; }
        th { background: #f3f4f6; padding: 7px 8px; border: 1px solid #ccc; font-size: 10.5px; text-transform: uppercase; letter-spacing: .4px; color: #555; text-align: left; }
        td { padding: 6px 8px; border: 1px solid #e5e7eb; font-size: 11.5px; vertical-align: top; }
        td.r, th.r { text-align: right; }
        td.b { font-weight: 700; }
        tr.open-row td, tr.close-row td { background: #fafafa; font-style: italic; font-weight: 600; }
        tr.open-row td.b, tr.close-row td.b { font-style: normal; }
        tfoot td { background: #fef3c7; font-weight: 700; border-top: 2px solid #aaa; }
        .footer { margin-top: 14px; font-size: 10px; color: #999; text-align: right; }
      </style></head><body>
      <h1>${r.title}</h1>
      <div class="sub">${r.subtitle}</div>
      <div class="meta">
        <div>
          <b>Party:</b> ${selected.party_name}${selected.party_type ? ` (${selected.party_type})` : ''}<br>
          ${selected.mobile_1 ? `<b>Phone:</b> ${selected.mobile_1}<br>` : ''}
          ${selected.gst_number ? `<b>GSTIN:</b> ${selected.gst_number}<br>` : ''}
        </div>
        <div style="text-align:right">
          <b>Period:</b> ${periodLabel()}<br>
          <b>Opening:</b> ${fmt(Math.abs(openingBalance))} ${openingBalance >= 0 ? 'Dr' : 'Cr'}<br>
          <b>Closing:</b> ${fmt(Math.abs(closingBalance))} ${closingBalance >= 0 ? 'Dr' : 'Cr'}
        </div>
      </div>
      <table>
        <thead><tr>
          <th>Date</th><th>Type</th><th>Ref / Voucher</th>
          <th class="r">Debit (₹)</th><th class="r">Credit (₹)</th><th class="r">Balance (₹)</th>
        </tr></thead>
        <tbody>${tableRows}</tbody>
        <tfoot><tr>
          <td colspan="3" class="r">Period Total</td>
          <td class="r">${r.footer.debit}</td>
          <td class="r">${r.footer.credit}</td>
          <td class="r">${r.footer.balance}</td>
        </tr></tfoot>
      </table>
      <div class="footer">Generated by Billing ERP · ${dayjs().format('DD MMM YYYY hh:mm A')}</div>
      </body></html>`;
    // Hidden iframe keeps the current tab focus and doesn't flash a new window
    const iframe = document.createElement('iframe');
    iframe.style.cssText = 'position:fixed;top:0;left:0;width:0;height:0;border:none;visibility:hidden;';
    document.body.appendChild(iframe);
    iframe.contentDocument.open();
    iframe.contentDocument.write(html);
    iframe.contentDocument.close();
    setTimeout(() => {
      try { iframe.contentWindow.focus(); iframe.contentWindow.print(); } catch { /* ignore */ }
      setTimeout(() => document.body.removeChild(iframe), 2000);
    }, 350);
  };

  const handlePDF = async () => {
    const r = buildReport();
    if (!r) { message.warning('Select a party first'); return; }
    try {
      const [{ default: jsPDF }, { default: autoTable }] = await Promise.all([
        import('jspdf'),
        import('jspdf-autotable'),
      ]);
      const doc = new jsPDF({ unit: 'pt', format: 'a4' });
      const pageW = doc.internal.pageSize.getWidth();

      doc.setFontSize(16); doc.setFont('helvetica', 'bold');
      doc.text(r.title, 40, 48);
      doc.setFontSize(10); doc.setFont('helvetica', 'normal'); doc.setTextColor(120);
      doc.text(r.subtitle, 40, 64);

      // Meta block (party | period/open/close)
      doc.setTextColor(40);
      doc.setFontSize(10);
      const lines = [
        `Party: ${selected.party_name}${selected.party_type ? ` (${selected.party_type})` : ''}`,
        selected.mobile_1 ? `Phone: ${selected.mobile_1}` : '',
        selected.gst_number ? `GSTIN: ${selected.gst_number}` : '',
      ].filter(Boolean);
      lines.forEach((t, i) => doc.text(t, 40, 86 + i * 13));

      const metaR = [
        `Period: ${periodLabel()}`,
        `Opening: ${fmt(Math.abs(openingBalance))} ${openingBalance >= 0 ? 'Dr' : 'Cr'}`,
        `Closing: ${fmt(Math.abs(closingBalance))} ${closingBalance >= 0 ? 'Dr' : 'Cr'}`,
      ];
      metaR.forEach((t, i) => doc.text(t, pageW - 40, 86 + i * 13, { align: 'right' }));

      autoTable(doc, {
        startY: 86 + Math.max(lines.length, metaR.length) * 13 + 10,
        head: [r.headers],
        body: r.rows.map(row => [row.date, row.type, row.ref, row.debit, row.credit, row.balance]),
        foot: [[{ content: 'Period Total', colSpan: 3, styles: { halign: 'right' } }, r.footer.debit, r.footer.credit, r.footer.balance]],
        styles: { fontSize: 9, cellPadding: 5 },
        headStyles: { fillColor: [243, 244, 246], textColor: 60, fontStyle: 'bold', fontSize: 8.5 },
        footStyles: { fillColor: [254, 243, 199], textColor: 40, fontStyle: 'bold' },
        columnStyles: {
          3: { halign: 'right' },
          4: { halign: 'right' },
          5: { halign: 'right', fontStyle: 'bold' },
        },
        didParseCell: (hook) => {
          // Highlight opening & closing balance rows
          if (hook.section === 'body') {
            const row = r.rows[hook.row.index];
            if (row && (row._open || row._close)) {
              hook.cell.styles.fillColor = [250, 250, 250];
              hook.cell.styles.fontStyle = 'italic';
              if (hook.column.index === 5) hook.cell.styles.fontStyle = 'bold';
            }
          }
        },
      });

      doc.setFontSize(8); doc.setTextColor(150);
      doc.text(
        `Generated by Billing ERP · ${dayjs().format('DD MMM YYYY hh:mm A')}`,
        pageW - 40, doc.internal.pageSize.getHeight() - 20, { align: 'right' }
      );

      const fname = `party-ledger_${selected.party_name.replace(/[^a-zA-Z0-9]/g, '_')}_${dayjs().format('YYYY-MM-DD')}.pdf`;
      doc.save(fname);
      message.success('PDF downloaded');
    } catch (err) {
      console.error('PDF export failed', err);
      message.error('PDF export failed');
    }
  };

  const handleExcel = async () => {
    const r = buildReport();
    if (!r) { message.warning('Select a party first'); return; }
    try {
      const ExcelJS = (await import('exceljs')).default;
      const wb = new ExcelJS.Workbook();
      wb.creator = 'Billing ERP';
      wb.created = new Date();

      const ws = wb.addWorksheet('Ledger', {
        views: [{ state: 'frozen', ySplit: 6 }],
      });

      // Header
      ws.mergeCells('A1:F1');
      ws.getCell('A1').value = r.title;
      ws.getCell('A1').font = { name: 'Calibri', size: 16, bold: true };
      ws.getCell('A1').alignment = { horizontal: 'left', vertical: 'middle' };

      ws.mergeCells('A2:F2');
      ws.getCell('A2').value = r.subtitle;
      ws.getCell('A2').font = { name: 'Calibri', size: 10, color: { argb: 'FF888888' } };

      ws.mergeCells('A3:C3');
      ws.getCell('A3').value =
        `Party: ${selected.party_name}${selected.mobile_1 ? ' · ' + selected.mobile_1 : ''}${selected.gst_number ? ' · GSTIN ' + selected.gst_number : ''}`;
      ws.getCell('A3').font = { name: 'Calibri', size: 10 };

      ws.mergeCells('D3:F3');
      ws.getCell('D3').value =
        `Opening: ${fmt(Math.abs(openingBalance))} ${openingBalance >= 0 ? 'Dr' : 'Cr'}  ·  Closing: ${fmt(Math.abs(closingBalance))} ${closingBalance >= 0 ? 'Dr' : 'Cr'}`;
      ws.getCell('D3').alignment = { horizontal: 'right' };
      ws.getCell('D3').font = { name: 'Calibri', size: 10, bold: true };

      // Row 5 = header row
      const headerRow = ws.addRow([]); // row 4 spacer
      headerRow.height = 4;
      const hdr = ws.addRow(r.headers);
      hdr.font = { bold: true, size: 10.5 };
      hdr.alignment = { horizontal: 'left' };
      hdr.eachCell((cell, i) => {
        cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF3F4F6' } };
        cell.border = {
          top:    { style: 'thin', color: { argb: 'FFCCCCCC' } },
          bottom: { style: 'thin', color: { argb: 'FFCCCCCC' } },
        };
        if (i >= 4) cell.alignment = { horizontal: 'right' };
      });

      // Body rows
      r.rows.forEach(row => {
        const xrow = ws.addRow([row.date, row.type, row.ref, row.debit, row.credit, row.balance]);
        if (row._open || row._close) {
          xrow.font = { italic: true, bold: true, color: { argb: 'FF5A6072' } };
          xrow.eachCell(c => {
            c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFAFAFA' } };
          });
        }
        xrow.getCell(4).alignment = { horizontal: 'right' };
        xrow.getCell(5).alignment = { horizontal: 'right' };
        xrow.getCell(6).alignment = { horizontal: 'right' };
        xrow.getCell(6).font = { ...(xrow.getCell(6).font || {}), bold: true };
      });

      // Footer total row
      const foot = ws.addRow(['', '', 'Period Total', r.footer.debit, r.footer.credit, r.footer.balance]);
      foot.font = { bold: true };
      foot.eachCell((c, i) => {
        c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFEF3C7' } };
        c.border = { top: { style: 'medium' } };
        if (i >= 3) c.alignment = { horizontal: 'right' };
      });

      // Column widths
      ws.getColumn(1).width = 14;
      ws.getColumn(2).width = 22;
      ws.getColumn(3).width = 22;
      ws.getColumn(4).width = 18;
      ws.getColumn(5).width = 18;
      ws.getColumn(6).width = 22;

      const buf = await wb.xlsx.writeBuffer();
      const blob = new Blob([buf], {
        type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `party-ledger_${selected.party_name.replace(/[^a-zA-Z0-9]/g, '_')}_${dayjs().format('YYYY-MM-DD')}.xlsx`;
      a.click();
      URL.revokeObjectURL(url);
      message.success('Excel downloaded');
    } catch (err) {
      console.error('Excel export failed', err);
      message.error('Excel export failed');
    }
  };

  const handleWhatsApp = () => {
    if (!selected) { message.warning('Select a party first'); return; }
    if (!selected.mobile_1) {
      message.warning('This party has no mobile number saved');
      return;
    }
    // Keep the message short — WhatsApp URL-encodes the whole thing and long
    // summaries make the phone app hang. Send a concise statement and a note
    // that a PDF/Excel is being shared separately.
    const lines = [
      `*Account Statement*`,
      `${selected.party_name}`,
      periodLabel(),
      '',
      `Opening:  ${fmt(Math.abs(openingBalance))} ${openingBalance >= 0 ? 'Dr' : 'Cr'}`,
      `Debit:    ${fmt(totals.debit)}`,
      `Credit:   ${fmt(totals.credit)}`,
      `*Closing: ${fmt(Math.abs(closingBalance))} ${closingBalance >= 0 ? 'Dr' : 'Cr'}*`,
      '',
      `Please find the detailed ledger PDF attached.`,
    ];
    const text = encodeURIComponent(lines.join('\n'));
    const phone = String(selected.mobile_1).replace(/\D/g, '').slice(-10);
    const url = `https://wa.me/91${phone}?text=${text}`;
    window.open(url, '_blank');
  };

  /* ── Popover close-on-outside ── */
  const pageRef = useRef(null);
  useEffect(() => {
    const onDocClick = (e) => {
      if (!pageRef.current) return;
      if (!e.target.closest('[data-popover]')) {
        setPartyPopOpen(false);
        setPeriodPopOpen(false);
        setColsPopOpen(false);
        setTypePopOpen(false);
      }
    };
    document.addEventListener('mousedown', onDocClick);
    return () => document.removeEventListener('mousedown', onDocClick);
  }, []);

  /* ── Open a bill from a ref-number click ── */
  const openEntry = (e) => {
    if (e.type === 'sales' || e.type === 'sales_initial_payment' || e.type === 'sales_return_amount') {
      return navigate(`/sale/edit/${e.id}`);
    }
    if (e.type === 'purchase' || e.type === 'purchase_initial_payment') {
      return navigate(`/purchase/edit/${e.id}`);
    }
    if (e.type === 'sales_return')    return navigate('/sales-returns');
    if (e.type === 'purchase_return') return navigate('/purchase-returns');
    // Payment/Receipt: jump to the payments list (no deep edit page yet)
    if (e.type === 'payment') return navigate('/payments');
  };

  /* ══════════════════════════════════════════════════════════════ */
  /* Render                                                         */
  /* ══════════════════════════════════════════════════════════════ */

  const hasRows = visibleEntries.length > 0;

  return (
    <div ref={pageRef} className="pl-page">

      {/* ── HEADER ── */}
      <div className="pl-hd">

        {/* Party picker (left) */}
        <div className="pl-party" data-popover>
          <button
            className={`pl-party-btn${partyPopOpen ? ' open' : ''}`}
            type="button"
            onClick={(e) => { e.stopPropagation(); setPartyPopOpen(o => !o); setPeriodPopOpen(false); setColsPopOpen(false); setTypePopOpen(false); }}
          >
            <div className="pl-party-body">
              <span className="pl-party-kick">
                {selected
                  ? `Ledger · ${selected.party_type === 'Customer' ? 'Sundry Debtors' : selected.party_type === 'Supplier' ? 'Sundry Creditors' : 'Party'}`
                  : 'Party Ledger'}
              </span>
              {selected
                ? <span className="pl-party-name">{selected.party_name}</span>
                : <span className="pl-party-empty">Select a party…</span>}
              {selected && (
                <span className="pl-party-meta">
                  {selected.party_type && <span>{selected.party_type}</span>}
                  {selected.mobile_1 && <><span className="sep">·</span><span>{selected.mobile_1}</span></>}
                  {ledger && closingBalance !== 0 && (
                    <span className={`pl-party-pill ${closingBalance > 0 ? 'rcv' : 'pay'}`}>
                      {closingBalance > 0 ? 'Receivable' : 'Payable'} ₹{fmtShort(Math.abs(closingBalance))}
                    </span>
                  )}
                </span>
              )}
            </div>
            <span className="pl-party-caret">▾</span>
          </button>

          {partyPopOpen && (
            <div className="pl-party-pop open">
              <div className="pl-party-pop-search">
                <SearchOutlined />
                <input
                  autoFocus
                  type="text"
                  placeholder="Search by name, phone, city, GSTIN…"
                  value={partySearch}
                  onChange={e => setPartySearch(e.target.value)}
                />
              </div>
              <div className="pl-party-pop-tabs">
                <button className={partyFilter === 'all'      ? 'on' : ''} onClick={() => setPartyFilter('all')}>All ({parties.length})</button>
                <button className={partyFilter === 'customer' ? 'on' : ''} onClick={() => setPartyFilter('customer')}>Customers</button>
                <button className={partyFilter === 'supplier' ? 'on' : ''} onClick={() => setPartyFilter('supplier')}>Suppliers</button>
              </div>
              <div className="pl-party-pop-list">
                {partiesLoading ? (
                  <div style={{ display: 'grid', placeItems: 'center', padding: 30 }}><Spin /></div>
                ) : partiesByTab.length === 0 ? (
                  <div className="pl-party-pop-empty">No parties match your search</div>
                ) : partiesByTab.map(p => {
                  const bal = parseFloat(p.current_balance || 0);
                  return (
                    <div
                      key={p.party_id}
                      className={`pl-party-pop-item${partyId === p.party_id ? ' active' : ''}`}
                      onClick={() => { setPartyId(p.party_id); setPartyPopOpen(false); }}
                    >
                      <div>
                        <div className="n">{p.party_name}</div>
                        <div className="s">{[p.city, p.mobile_1].filter(Boolean).join(' · ') || (p.party_type || 'Party')}</div>
                      </div>
                      <div className={`b ${bal > 0 ? 'dr' : bal < 0 ? 'cr' : 'zero'}`}>
                        {Math.abs(bal) < 0.01 ? 'Settled' : `${fmtShort(Math.abs(bal))} ${bal > 0 ? 'Dr' : 'Cr'}`}
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          )}
        </div>

        {/* Period + columns (right) */}
        <div className="pl-hd-right">

          <div style={{ position: 'relative' }} data-popover>
            <button
              className={`pl-hd-btn${periodPopOpen ? ' open' : ''}`}
              type="button"
              onClick={(e) => { e.stopPropagation(); setPeriodPopOpen(o => !o); setPartyPopOpen(false); setColsPopOpen(false); setTypePopOpen(false); }}
            >
              <CalendarOutlined />
              <span className="k">Period</span>
              <span className="v">{periodLabel()}</span>
              <span className="caret">▾</span>
            </button>
            {periodPopOpen && (
              <div className="pl-pop open">
                {PERIOD_PRESETS.map(p => (
                  <button
                    key={p.key}
                    type="button"
                    className={`pl-pop-row${activePreset === p.key ? ' active' : ''}`}
                    onClick={() => { setDateRange(p.range()); setPeriodPopOpen(false); }}
                  >
                    {p.label}
                  </button>
                ))}
                <div className="pl-pop-custom">
                  <span className="lbl">Custom range</span>
                  <DatePicker.RangePicker
                    value={[customFrom || dateRange[0], customTo || dateRange[1]]}
                    onChange={(v) => {
                      setCustomFrom(v?.[0] || null);
                      setCustomTo(v?.[1] || null);
                      if (v?.[0] && v?.[1]) {
                        setDateRange([v[0], v[1]]);
                        setPeriodPopOpen(false);
                      }
                    }}
                    format="DD MMM YYYY"
                    style={{ width: '100%' }}
                    allowClear={false}
                  />
                </div>
              </div>
            )}
          </div>

          <div style={{ position: 'relative' }} data-popover>
            <Tooltip title="Show extra columns">
              <button
                className={`pl-hd-btn icon-only${colsPopOpen ? ' open' : ''}`}
                type="button"
                onClick={(e) => { e.stopPropagation(); setColsPopOpen(o => !o); setPartyPopOpen(false); setPeriodPopOpen(false); setTypePopOpen(false); }}
              >
                <AppstoreOutlined />
                {extraCount > 0 && <span className="badge">{extraCount}</span>}
              </button>
            </Tooltip>
            {colsPopOpen && (
              <div className="pl-pop pl-cols open">
                <div className="pl-cols-head">
                  <span>Show extra in list</span>
                  <span className="count">{extraCount} / {COLS_META.length}</span>
                </div>
                <div className="pl-cols-list">
                  {COLS_META.map(c => (
                    <label key={c.key} className="pl-cols-opt">
                      <input
                        type="checkbox"
                        checked={!!cols[c.key]}
                        onChange={(e) => setCols(prev => ({ ...prev, [c.key]: e.target.checked }))}
                      />
                      <div>
                        <div className="main">{c.label}</div>
                        <div className="desc">{c.desc}</div>
                      </div>
                    </label>
                  ))}
                </div>
                <div className="pl-cols-foot">
                  <button type="button" onClick={() => setCols(DEFAULT_COLS)}>Reset to default</button>
                  <span>Click any option to toggle</span>
                </div>
              </div>
            )}
          </div>
        </div>
      </div>

      {/* ── TOOLBAR ── */}
      <div className="pl-toolbar">
        <button className="pl-tool-ghost" type="button" onClick={handleBack}>
          <ArrowLeftOutlined /> Back
        </button>
        <button className="pl-tool-ghost" type="button" onClick={handleReset}>
          <ReloadOutlined /> Reset
        </button>
        <span className="pl-tool-spacer"></span>
        <Tooltip title="Print ledger (Ctrl+P)">
          <button className="pl-tool-ghost" type="button" onClick={handlePrint} disabled={!selected}>
            <PrinterOutlined /> Print
          </button>
        </Tooltip>
        <Tooltip title="Download PDF">
          <button className="pl-tool-ghost pdf" type="button" onClick={handlePDF} disabled={!selected}>
            <FilePdfOutlined /> PDF
          </button>
        </Tooltip>
        <Tooltip title="Send via WhatsApp">
          <button className="pl-tool-ghost wa" type="button" onClick={handleWhatsApp} disabled={!selected || !selected.mobile_1}>
            <WhatsAppOutlined /> WhatsApp
          </button>
        </Tooltip>
        <Tooltip title="Download Excel workbook">
          <button className="pl-tool-ghost excel" type="button" onClick={handleExcel} disabled={!selected}>
            <FileExcelOutlined /> Excel
          </button>
        </Tooltip>
      </div>

      {/* ── TABLE ── */}
      <div className="pl-wrap">
        <div className="pl-box">
          {!selected ? (
            <div className="pl-empty">
              <div className="icon">📒</div>
              <div className="title">Select a party</div>
              <div>Pick a customer or supplier to see their account statement.</div>
            </div>
          ) : ledgerLoading ? (
            <div className="pl-loading"><Spin /></div>
          ) : !ledger ? (
            <div className="pl-empty">
              <div className="icon">⚠️</div>
              <div className="title">Could not load ledger</div>
              <div>Try a different period or refresh the page.</div>
            </div>
          ) : (
            <div className="pl-scroll">
              <table className="pl-tbl">
                <thead>
                  <tr>
                    <th>Date</th>
                    <th
                      className={`fc${hiddenTypes.size > 0 ? ' active' : ''}`}
                      onClick={(e) => { e.stopPropagation(); setTypePopOpen(o => !o); setPartyPopOpen(false); setPeriodPopOpen(false); setColsPopOpen(false); }}
                      style={{ position: 'relative' }}
                      data-popover
                    >
                      Type <span className="hint">▾</span>
                      {hiddenTypes.size > 0 && (
                        <span className="badge-inline">{TYPE_CATEGORIES.length - hiddenTypes.size}</span>
                      )}
                      {typePopOpen && (
                        <div className="pl-type-pop open">
                          <div className="pl-type-pop-head">
                            <span>Show types</span>
                            <button
                              type="button"
                              onClick={(e) => { e.stopPropagation(); setHiddenTypes(new Set()); }}
                            >Show all</button>
                          </div>
                          {TYPE_CATEGORIES.map(t => (
                            <label
                              key={t.key}
                              className="pl-type-opt"
                              onClick={(e) => e.stopPropagation()}
                            >
                              <input
                                type="checkbox"
                                checked={!hiddenTypes.has(t.key)}
                                onChange={(ev) => {
                                  const next = new Set(hiddenTypes);
                                  if (ev.target.checked) next.delete(t.key);
                                  else next.add(t.key);
                                  setHiddenTypes(next);
                                }}
                              />
                              <span className="lbl">
                                <span className={`tdot ${t.dot}`}></span>{t.label}
                              </span>
                              <span className="cnt">{typeCounts[t.key] || 0}</span>
                            </label>
                          ))}
                        </div>
                      )}
                    </th>
                    <th>Ref / Voucher</th>
                    <th className="r">Debit (₹)</th>
                    <th className="r">Credit (₹)</th>
                    <th className="r">Balance (₹)</th>
                  </tr>
                </thead>

                <tbody>
                  {/* Opening balance — Tally convention */}
                  <tr className="balance">
                    <td className="date">{dateRange[0] ? fmtDate(dateRange[0]) : '—'}</td>
                    <td className="type"><span className="tdot td-open"></span>Opening Balance</td>
                    <td className="ref">—</td>
                    <td className="num zero">—</td>
                    <td className="num zero">—</td>
                    <td className={`bal ${openingBalance > 0 ? 'dr' : openingBalance < 0 ? 'cr' : ''}`}>
                      {openingBalance === 0
                        ? <span className="num zero">—</span>
                        : <>{fmt(Math.abs(openingBalance))}{cols.drcr && <span className="tag">{openingBalance > 0 ? 'Dr' : 'Cr'}</span>}</>}
                    </td>
                  </tr>

                  {!hasRows && (
                    <tr>
                      <td colSpan={6} style={{ textAlign: 'center', padding: '40px 16px', color: 'var(--fg-tertiary)', fontStyle: 'italic' }}>
                        No transactions in this period{hiddenTypes.size > 0 ? ' matching the selected types' : ''}.
                      </td>
                    </tr>
                  )}

                  {visibleEntries.map((e, i) => {
                    const chip = typeChip(e);
                    // A ref/voucher click should navigate only for kinds we have an edit route for.
                    const clickable = ['sales','purchase','sales_initial_payment','purchase_initial_payment','sales_return_amount','sales_return','purchase_return','payment'].includes(e.type);
                    // Auto-built narration / alloc sub-lines from what the backend gave us
                    const allocText  = e.reference_bill ? `Against ${e.reference_bill}` : null;
                    const isOpening  = false; // backend never returns an opening row now

                    return (
                      <tr key={`${e.type || 'x'}-${e.id || 'x'}-${i}`}>
                        <td className="date">{fmtDate(e.date)}</td>
                        <td className="type">
                          <span className={`tdot ${chip.dot}`}></span>{chip.label}
                        </td>
                        <td className="ref">
                          {clickable
                            ? <a onClick={() => openEntry(e)}>{e.ref_number || '—'}</a>
                            : <span>{e.ref_number || '—'}</span>}
                          {e.voucher_type === 'Payment at Billing' || e.type === 'sales_initial_payment' || e.type === 'purchase_initial_payment'
                            ? <span className="dim">(at billing)</span> : null}
                        </td>
                        <td className={`num ${e.debit > 0 ? 'dr' : 'zero'}`}>
                          {e.debit > 0 ? fmt(e.debit) : '—'}
                          {e.debit > 0 && cols.alloc && allocText && (
                            <span className="sub">{allocText}</span>
                          )}
                        </td>
                        <td className={`num ${e.credit > 0 ? 'cr' : 'zero'}`}>
                          {e.credit > 0 ? fmt(e.credit) : '—'}
                          {e.credit > 0 && cols.alloc && allocText && (
                            <span className="sub">{allocText}</span>
                          )}
                          {/* particulars-level narration (e.g. "Credit Note (amount-only)") */}
                          {cols.narration && e.particulars && !/^(Sales Bill|Purchase Bill|Receipt|Payment|Sales Return|Purchase Return|Payment at Billing|Return Amount)$/.test(e.particulars) && e.particulars !== chip.label && (e.credit > 0) && (
                            <span className="sub">{e.particulars}</span>
                          )}
                        </td>
                        <td className={`bal ${e.balance > 0 ? 'dr' : e.balance < 0 ? 'cr' : ''}`}>
                          {e.balance === 0
                            ? <span className="num zero">—</span>
                            : <>{fmt(Math.abs(e.balance))}{cols.drcr && <span className="tag">{e.balance > 0 ? 'Dr' : 'Cr'}</span>}</>}
                        </td>
                      </tr>
                    );
                  })}

                  {/* Closing balance — Tally convention */}
                  <tr className="balance">
                    <td className="date">{dateRange[1] ? fmtDate(dateRange[1]) : fmtDate(dayjs())}</td>
                    <td className="type"><span className="tdot td-open"></span>Closing Balance</td>
                    <td className="ref">—</td>
                    <td className="num zero">—</td>
                    <td className="num zero">—</td>
                    <td className={`bal ${closingBalance > 0 ? 'dr' : closingBalance < 0 ? 'cr' : ''}`}>
                      {closingBalance === 0
                        ? <span className="num zero">—</span>
                        : <>{fmt(Math.abs(closingBalance))}{cols.drcr && <span className="tag">{closingBalance > 0 ? 'Dr' : 'Cr'}</span>}</>}
                    </td>
                  </tr>
                </tbody>
              </table>
            </div>
          )}
          {/* Period-total bar lives OUTSIDE .pl-scroll so it's pinned to the
              bottom of the card regardless of list length — neither sticky
              over content nor floating with the last row. */}
          {selected && !ledgerLoading && ledger && (
            <div className="pl-totbar">
              <span className="label">Period Total</span>
              <span className="num dr">{fmt(totals.debit)}</span>
              <span className="num cr">{fmt(totals.credit)}</span>
              <span className={`bal ${closingBalance > 0 ? 'dr' : closingBalance < 0 ? 'cr' : ''}`}>
                {closingBalance === 0
                  ? '—'
                  : <>{fmt(Math.abs(closingBalance))}{cols.drcr && <span className="tag">{closingBalance > 0 ? 'Dr' : 'Cr'}</span>}</>}
              </span>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
