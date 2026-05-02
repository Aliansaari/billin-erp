// ── PartyStatementPage ─────────────────────────────────────────────────
//
// Shared shell for Customer Statement and Supplier Statement. Owns:
//
//   • URL ↔ state sync (?id=<party_id>&from=<date>&to=<date>)
//   • Picker → API → LedgerStatement render pipeline
//   • Period preset chips (This Month / This Quarter / FY / Custom)
//   • Outstanding-only toggle
//   • Print, Excel, WhatsApp actions
//   • Letterhead block for the printed statement
//
// Customer / Supplier pages just pass:
//   • partyType            'Customer' | 'Supplier'
//   • title                'Customer Statement' | 'Supplier Statement'
//   • headerHint           Subtitle text under the title
//   • showWhatsApp         true on Customer (collection follow-up
//                          flow); false on Supplier (we don't WhatsApp
//                          our own ledger to suppliers — suppliers
//                          send US theirs)
//   • columnsExtra         Optional extra columns to render — Supplier
//                          Statement enables 'voucher_no' (already
//                          there) but a future variant could show our
//                          internal bill number side-by-side with the
//                          supplier's own bill number.
//
// Anything more report-specific (different defaults, different print
// header copy) goes here behind partyType branches; the wrapper pages
// remain trivial.

import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Button, DatePicker, message, Tooltip } from 'antd';
import {
  PrinterOutlined, FileExcelOutlined, FilePdfOutlined, ReloadOutlined,
  WhatsAppOutlined, ArrowLeftOutlined,
} from '@ant-design/icons';
import { useNavigate, useSearchParams } from 'react-router-dom';
import dayjs from 'dayjs';
import { ledgerAPI, partyAPI } from '../api';
import { useFinancialYear } from '../hooks/useFinancialYear';
import { downloadStatementPdf } from '../utils/ledgerPdf';
import PartyPicker from './PartyPicker';
import LedgerStatement from './LedgerStatement';
import './ledger-statement.css';
import './party-picker.css';
import './party-statement-page.css';

const { RangePicker } = DatePicker;

// Period presets — same labels and behaviour as Sales Report /
// Day Book / Trial Balance, so the period picker reads identically
// across the report family. "Custom" is the implicit fallback:
// the moment the user touches the RangePicker, none of the chips
// are highlighted (handled in the activePreset memo).
function presets(fyStart, fyEnd) {
  const today = dayjs();
  // FY anchor — last 1 Apr → next 31 Mar. Falls back to a sensible
  // current-FY guess when useFinancialYear hasn't loaded yet (cold
  // page, no localStorage cache).
  const thisFyStart = fyStart ? dayjs(fyStart) : today.month(3).startOf('month').subtract(today.month() < 3 ? 1 : 0, 'year');
  const thisFyEnd   = fyEnd   ? dayjs(fyEnd)   : thisFyStart.add(1, 'year').subtract(1, 'day');
  const lastFyStart = thisFyStart.subtract(1, 'year');
  const lastFyEnd   = thisFyEnd.subtract(1, 'year');
  return [
    { v: 'this_fy',    l: 'This FY',    from: thisFyStart, to: thisFyEnd  },
    { v: 'last_fy',    l: 'Last FY',    from: lastFyStart, to: lastFyEnd  },
    { v: 'this_q',     l: 'This Q',     from: today.startOf('quarter'), to: today.endOf('quarter') },
    { v: 'this_month', l: 'This Month', from: today.startOf('month'),   to: today.endOf('month')   },
    { v: 'custom',     l: 'Custom',     from: null,        to: null     },
  ];
}

// Excel export — keep it dependency-free here. ExcelJS is already
// in the bundle (used by Day Book / Sales Report); reusing the same
// thin generator pattern means the file format is consistent across
// reports (one sheet, one header row, totals at bottom).
async function downloadExcel({ filename, rows, headers }) {
  const ExcelJS = await import('exceljs').then(m => m.default || m);
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Statement');
  ws.addRow(headers);
  rows.forEach(r => ws.addRow(r));
  ws.getRow(1).font = { bold: true };
  const buf = await wb.xlsx.writeBuffer();
  const blob = new Blob([buf], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

export default function PartyStatementPage({
  partyType,
  title,
  showWhatsApp = false,
}) {
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const { fyStart, fyEnd } = useFinancialYear();

  // Selected party. Hydrated from URL on mount so deep links work
  // (e.g. clicking a party from the Aging Report opens this page
  // pre-loaded). Without a stable URL contract, the redirect from
  // the deprecated /reports/party-ledger wouldn't have a landing.
  const [party, setParty] = useState(null);
  const [loading, setLoading] = useState(false);
  const [statement, setStatement] = useState(null);

  // Voucher-type chip filter. Empty Set = "show all" (no filter).
  // Categories come from LedgerStatement.deriveCategory — matches what
  // the renderer paints on each row's pill, so chip ↔ row identity is
  // 1:1.
  const [voucherFilter, setVoucherFilter] = useState(() => new Set());

  // Period state — defaults to FY. RangePicker writes here; preset
  // chips also write here. Both also push to URL so refresh + share
  // preserve the view.
  const [from, setFrom] = useState(searchParams.get('from') || fyStart || null);
  const [to,   setTo]   = useState(searchParams.get('to')   || fyEnd   || null);

  // ── URL hydration ──────────────────────────────────────────────────
  // Runs ONCE on mount: if ?id=<party_id> is in the URL, fetch + set
  // the party. After that, the user's picker drives state and state
  // drives the URL — there's no need to re-read the URL on every
  // render. The hydratedRef guard prevents the hydration effect from
  // racing with the URL-writeback effect (both are triggered by
  // searchParams changing in react-router-dom v6, which would cause
  // a feedback flicker).
  const hydratedRef = useRef(false);
  useEffect(() => {
    if (hydratedRef.current) return;
    const id = searchParams.get('id');
    if (!id) { hydratedRef.current = true; return; }
    hydratedRef.current = true;
    partyAPI.getById(id)
      .then(res => {
        const p = res.data?.data || res.data;
        if (p && p.party_type === partyType) setParty(p);
        else if (p) {
          // Wrong-type id (e.g. a supplier id landed on customer
          // statement). Bounce so the legacy /reports/party-ledger
          // redirect lands cleanly even when the caller didn't know
          // the type.
          const otherRoute = p.party_type === 'Customer' ? '/reports/customer-statement' : '/reports/supplier-statement';
          navigate(`${otherRoute}?id=${p.party_id}`, { replace: true });
        }
      })
      .catch(() => message.error('Could not load that party.'));
    // eslint-disable-next-line react-hooks/exhaustive-deps -- intentionally mount-only; searchParams read once at start
  }, [partyType]);

  // ── Statement fetch ────────────────────────────────────────────────
  // Fires whenever the picked party or the period changes. Cancels
  // earlier in-flight requests (race-safety: pick A, period change,
  // pick B — only B's response should land).
  useEffect(() => {
    if (!party) { setStatement(null); return; }
    let stale = false;
    setLoading(true);
    ledgerAPI.statementByParty(party.party_id, {
      from_date: from || undefined,
      to_date:   to   || undefined,
    })
      .then(res => {
        if (stale) return;
        setStatement(res.data?.data || res.data);
      })
      .catch(err => {
        if (stale) return;
        message.error(err?.response?.data?.error || 'Failed to load statement.');
        setStatement(null);
      })
      .finally(() => { if (!stale) setLoading(false); });
    return () => { stale = true; };
  }, [party, from, to]);

  // ── URL writeback ──────────────────────────────────────────────────
  // Mirror picker + period into the URL so refresh / bookmarks work.
  //
  // Two anti-flicker guards:
  //  1. setSearchParams is NOT in the deps. In react-router-dom v6
  //     its reference changes on every searchParams update — including
  //     the one this effect itself triggers — which would re-fire the
  //     effect every render, looking visually like a constant repaint
  //     ("page giggling"). Reading via closure is safe; the ref always
  //     points at the latest setter.
  //  2. Compare against the live URL before writing. Even with stable
  //     deps, calling setSearchParams with the SAME query string still
  //     triggers a route re-render — wasted work + potential paint.
  //     Bail when the URL is already what we want.
  useEffect(() => {
    const next = new URLSearchParams();
    if (party) next.set('id', String(party.party_id));
    if (from)  next.set('from', from);
    if (to)    next.set('to',   to);
    const current = new URLSearchParams(window.location.search).toString();
    if (next.toString() === current) return;
    setSearchParams(next, { replace: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [party, from, to]);

  // Active preset highlight — derived, not stored. "custom" wins
  // when nothing else matches, keeping at least one chip lit at all
  // times. Mirrors Sales Report / Day Book's preset behavior.
  const activePreset = useMemo(() => {
    const prs = presets(fyStart, fyEnd);
    const hit = prs.find(p =>
      ((p.from?.format('YYYY-MM-DD') || null) === (from || null)) &&
      ((p.to?.format('YYYY-MM-DD')   || null) === (to   || null))
    );
    return hit?.v || 'custom';
  }, [from, to, fyStart, fyEnd]);

  const setPreset = (p) => {
    if (p.v === 'custom') return;          // chip is informational; date pick triggers Custom
    setFrom(p.from?.format('YYYY-MM-DD') || null);
    setTo  (p.to?.format('YYYY-MM-DD')   || null);
  };

  // Voucher-type chips. Customer Statement defaults to the categories
  // a customer can transact in (sales-side), Supplier Statement to the
  // purchase-side. "Journal" + "Opening Adj." surface here too because
  // any party can have a manual JV or an opening-balance adjustment
  // posted against them.
  const voucherCategories = useMemo(() => (
    partyType === 'Supplier'
      ? ['Purchase', 'Payment', 'Purchase Return', 'Journal', 'Opening Adj.']
      : ['Sales',    'Receipt', 'Sales Return',    'Journal', 'Opening Adj.']
  ), [partyType]);

  const toggleVoucher = (cat) => {
    setVoucherFilter(prev => {
      const next = new Set(prev);
      if (next.has(cat)) next.delete(cat); else next.add(cat);
      return next;
    });
  };
  const clearVoucherFilter = () => setVoucherFilter(new Set());

  // ── Actions ────────────────────────────────────────────────────────
  const onPrint = () => window.print();

  const onWhatsApp = () => {
    if (!party?.mobile_1) {
      message.warning('No mobile number on this party.');
      return;
    }
    // Clean to digits, prepend +91 if no country code (the app's
    // operating market is India; matches the Sales bill WhatsApp
    // share behaviour).
    let phone = String(party.mobile_1).replace(/\D/g, '');
    if (phone.length === 10) phone = '91' + phone;
    const closing = parseFloat(statement?.closing_balance || 0);
    const sign = closing >= 0 ? 'Dr (you owe)' : 'Cr (we owe)';
    const text = encodeURIComponent(
      `Statement of Account — ${party.party_name}\n` +
      `Period: ${from || 'inception'} to ${to || 'today'}\n` +
      `Closing balance: ₹${Math.abs(closing).toLocaleString('en-IN', { minimumFractionDigits: 2 })} ${sign}\n\n` +
      `Sent from ${(window.__APP_COMPANY_NAME__ || 'our books')}.`
    );
    window.open(`https://wa.me/${phone}?text=${text}`, '_blank');
  };

  const onExcel = () => {
    if (!statement?.entries?.length) { message.info('Nothing to export.'); return; }
    const fileSuffix = (party?.party_name || 'party').replace(/[^a-z0-9]+/gi, '-').toLowerCase();
    const headers = ['Date', 'Type', 'Voucher No', 'Particulars', 'Debit', 'Credit', 'Balance'];
    const opening = [from || '', '', '', 'Opening Balance', '', '', statement.opening_balance];
    const rows = [
      opening,
      ...statement.entries.map(e => [
        e.date, e.voucher_type, e.voucher_no || '', e.narration || '',
        e.debit || '', e.credit || '', e.balance,
      ]),
      ['', '', '', 'Period Totals', statement.total_debit, statement.total_credit, ''],
      [to || '', '', '', 'Closing Balance', '', '', statement.closing_balance],
    ];
    downloadExcel({
      filename: `${title.replace(/\s+/g, '-').toLowerCase()}-${fileSuffix}.xlsx`,
      rows, headers,
    });
  };

  // PDF export — same data shape as Excel, but rendered through jsPDF
  // with a printable letterhead so the file is mail-ready. Honours
  // the active voucher-type filter so the PDF reflects what the user
  // sees on screen.
  const onPdf = async () => {
    if (!statement) { message.info('Nothing to export.'); return; }
    try {
      await downloadStatementPdf({
        title,
        subtitle: party?.party_name,
        statement,
        voucherFilter,
        party,
      });
    } catch (err) {
      console.error(err);
      message.error('PDF export failed.');
    }
  };

  const onDrill = (row) => {
    // Source-type → edit URL mapping. Mirrors the drill behaviour
    // PartyLedger had; centralised here so adding a new voucher type
    // (e.g. journal_voucher) is a one-line add.
    const id = row.reference_id;
    if (!id) return;
    switch (row.source_type) {
      case 'sales_bill':           navigate(`/sale/edit/${id}`);            break;
      case 'sales_bill_receipt':   navigate(`/sale/edit/${id}`);            break;
      case 'purchase_bill':        navigate(`/purchase/edit/${id}`);        break;
      case 'sales_return_bill':    navigate(`/sales-return/edit/${id}`);    break;
      case 'purchase_return_bill': navigate(`/purchase-return/edit/${id}`); break;
      case 'payment_receipt':
        navigate(row.voucher_type === 'Receipt' ? `/receipt/edit/${id}` : `/payment/edit/${id}`);
        break;
      case 'journal_voucher':      navigate(`/accounts/journals/edit/${id}`); break;
      default: /* no-op */         break;
    }
  };

  return (
    <div className="psp-page">
      {/* ── Header strip ─────────────────────────────────────────── */}
      <div className="psp-header">
        <div className="psp-titles">
          <Button
            type="text" icon={<ArrowLeftOutlined />}
            onClick={() => navigate(-1)}
            className="psp-back"
          />
          <h1 className="psp-title">{title}</h1>
        </div>
        <div className="psp-actions">
          <Tooltip title="Refresh">
            <Button icon={<ReloadOutlined />} onClick={() => party && setParty({ ...party })} disabled={!party} />
          </Tooltip>
          <Button icon={<FileExcelOutlined />} onClick={onExcel} disabled={!statement?.entries?.length}>Excel</Button>
          <Button icon={<FilePdfOutlined />}   onClick={onPdf}   disabled={!statement}>PDF</Button>
          {showWhatsApp && (
            <Button icon={<WhatsAppOutlined />} onClick={onWhatsApp} disabled={!party}>WhatsApp</Button>
          )}
          <Button type="primary" icon={<PrinterOutlined />} onClick={onPrint} disabled={!statement}>Print</Button>
        </div>
      </div>

      {/* ── Picker + period + voucher-type chips ─────────────────────
          Same chrome shape as Sales Report / Day Book — uses the
          shared rpt-period / rpt-date classes from global.css so the
          report family looks like one app, not five. */}
      <div className="psp-sticky">
        <PartyPicker partyType={partyType} value={party} onChange={setParty} />

        <div className="psp-controls">
          <div className="rpt-period">
            {presets(fyStart, fyEnd).map(p => (
              <button
                key={p.v}
                className={activePreset === p.v ? 'on' : ''}
                onClick={() => setPreset(p)}
              >
                {p.l}
              </button>
            ))}
          </div>
          <RangePicker
            className="rpt-date"
            value={[from ? dayjs(from) : null, to ? dayjs(to) : null]}
            onChange={(range) => {
              setFrom(range?.[0]?.format('YYYY-MM-DD') || null);
              setTo  (range?.[1]?.format('YYYY-MM-DD') || null);
            }}
            format="DD/MM/YYYY"
            allowClear={false}
          />
        </div>

        {/* Voucher-type chip filter. Click a chip to scope the
            statement to that category; click again to release. The
            "All" chip is implicit — when nothing is selected, every
            row is shown. Categories per partyType, defined above. */}
        <div className="psp-vt-chips">
          <button
            className={'psp-vt-chip' + (voucherFilter.size === 0 ? ' on' : '')}
            onClick={clearVoucherFilter}
          >
            All
          </button>
          {voucherCategories.map(cat => (
            <button
              key={cat}
              className={'psp-vt-chip' + (voucherFilter.has(cat) ? ' on' : '')}
              onClick={() => toggleVoucher(cat)}
            >
              {cat}
            </button>
          ))}
        </div>
      </div>

      {/* ── Print-only letterhead block ───────────────────────────── */}
      {party && (
        <div className="psp-print-letter">
          <div className="psp-letter-from">
            <h2>{window.__APP_COMPANY_NAME__ || 'Statement of Account'}</h2>
          </div>
          <div className="psp-letter-to">
            <div className="psp-letter-to-lbl">
              {partyType === 'Customer' ? 'To:' : 'From:'}
            </div>
            <div className="psp-letter-to-name">{party.party_name}</div>
            {party.address_line_1 && <div>{party.address_line_1}</div>}
            {party.city && <div>{party.city}{party.state ? `, ${party.state}` : ''}</div>}
            {party.gstin && <div>GSTIN: {party.gstin}</div>}
          </div>
          <div className="psp-letter-period">
            Period: {from || 'inception'} to {to || 'today'}
          </div>
        </div>
      )}

      {/* ── Statement body ───────────────────────────────────────── */}
      <div className="psp-body">
        <LedgerStatement
          statement={statement}
          loading={loading}
          onRowClick={onDrill}
          voucherFilter={voucherFilter}
          emptyHint={`Pick a ${partyType.toLowerCase()} above to load the statement. Press / to focus the search.`}
        />
      </div>
    </div>
  );
}
