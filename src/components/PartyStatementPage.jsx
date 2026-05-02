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

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Button, DatePicker, message, Switch, Tooltip } from 'antd';
import {
  PrinterOutlined, FileExcelOutlined, ReloadOutlined,
  WhatsAppOutlined, CalendarOutlined, ArrowLeftOutlined,
} from '@ant-design/icons';
import { useNavigate, useSearchParams } from 'react-router-dom';
import dayjs from 'dayjs';
import { ledgerAPI, partyAPI } from '../api';
import { useFinancialYear } from '../hooks/useFinancialYear';
import PartyPicker from './PartyPicker';
import LedgerStatement from './LedgerStatement';
import './ledger-statement.css';
import './party-picker.css';
import './party-statement-page.css';

const { RangePicker } = DatePicker;

// Period presets — the four ranges Indian accountants check most.
// Custom is the implicit fifth: the moment the user touches the
// RangePicker, none of these are highlighted.
function presets(fyStart, fyEnd) {
  const today = dayjs();
  return [
    { key: 'month',   label: 'This Month',   from: today.startOf('month'),   to: today.endOf('month')   },
    { key: 'quarter', label: 'This Quarter', from: today.startOf('quarter'), to: today.endOf('quarter') },
    { key: 'fy',      label: 'Financial Year',
      from: fyStart ? dayjs(fyStart) : today.month(3).startOf('month'),     // April 1 fallback
      to:   fyEnd   ? dayjs(fyEnd)   : today.month(2).endOf('month').add(1, 'year') },
    { key: 'all',     label: 'All',          from: null, to: null },
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
  const [outstandingOnly, setOutstandingOnly] = useState(false);

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

  // Active preset highlight — derived, not stored. Custom = nothing
  // matches any preset's exact range.
  const activePreset = useMemo(() => {
    const prs = presets(fyStart, fyEnd);
    return prs.find(p =>
      ((p.from?.format('YYYY-MM-DD') || null) === (from || null)) &&
      ((p.to?.format('YYYY-MM-DD')   || null) === (to   || null))
    )?.key || null;
  }, [from, to, fyStart, fyEnd]);

  const setPreset = (p) => {
    setFrom(p.from?.format('YYYY-MM-DD') || null);
    setTo  (p.to?.format('YYYY-MM-DD')   || null);
  };

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
          {showWhatsApp && (
            <Button icon={<WhatsAppOutlined />} onClick={onWhatsApp} disabled={!party}>WhatsApp</Button>
          )}
          <Button type="primary" icon={<PrinterOutlined />} onClick={onPrint} disabled={!statement}>Print</Button>
        </div>
      </div>

      {/* ── Sticky picker + period bar ────────────────────────────── */}
      <div className="psp-sticky">
        <PartyPicker partyType={partyType} value={party} onChange={setParty} loading={loading} />

        <div className="psp-period">
          <div className="psp-presets">
            {presets(fyStart, fyEnd).map(p => (
              <button
                type="button"
                key={p.key}
                className={'psp-preset' + (activePreset === p.key ? ' is-active' : '')}
                onClick={() => setPreset(p)}
              >
                {p.label}
              </button>
            ))}
          </div>
          <RangePicker
            value={[from ? dayjs(from) : null, to ? dayjs(to) : null]}
            onChange={(range) => {
              setFrom(range?.[0]?.format('YYYY-MM-DD') || null);
              setTo  (range?.[1]?.format('YYYY-MM-DD') || null);
            }}
            format="DD-MM-YYYY"
            allowClear
            suffixIcon={<CalendarOutlined />}
          />
          <div className="psp-toggle">
            <Switch
              size="small"
              checked={outstandingOnly}
              onChange={setOutstandingOnly}
              disabled={!statement}
            />
            <span>Outstanding only</span>
          </div>
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
          outstandingOnly={outstandingOnly}
          emptyHint={`Pick a ${partyType.toLowerCase()} above to load the statement. Press / to focus the search.`}
        />
      </div>
    </div>
  );
}
