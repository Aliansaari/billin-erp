// ── Ledger (Chart of Accounts) ─────────────────────────────────────────
//
// Voucher-level statement for ANY chart-of-accounts ledger — Sales A/c,
// Bank A/c, Office Rent, Salaries, Capital, etc. Excludes party-backed
// ledgers (those have their own Customer / Supplier Statement pages
// with letterhead + WhatsApp + outstanding-only flow).
//
// Picker is a grouped Select rather than the big PartyPicker bar —
// COA accounts are a fixed set (~20-50 per firm) and naturally sort
// into Tally's five groups (Assets / Liabilities / Income /
// Expenses / Capital), so a hierarchical dropdown reads cleaner than
// a flat search. The user's mental model is "I want to see Office
// Rent" → group → name; PartyPicker's autocomplete-by-typing UI is
// overkill here.
//
// Reuses the same <LedgerStatement> table as the party flavors, so
// totals / drill / opening / closing all behave identically. No
// letterhead block (this is an internal accountant view, not a
// document mailed to anyone).

import React, { useEffect, useMemo, useState } from 'react';
import { Button, Checkbox, DatePicker, Popover, Select, message, Tooltip } from 'antd';
import {
  FilePdfOutlined, ReloadOutlined,
  ArrowLeftOutlined, SettingOutlined,
} from '@ant-design/icons';
import { useNavigate, useSearchParams } from 'react-router-dom';
import dayjs from 'dayjs';
import { ledgerAPI } from '../../api';
import { useFinancialYear } from '../../hooks/useFinancialYear';
import { downloadStatementPdf } from '../../utils/ledgerPdf';
import LedgerStatement, { ALL_COLUMNS } from '../../components/LedgerStatement';
import ActionStrip from '../../components/keyboard/ActionStrip';
import { useDatePopup } from '../../components/keyboard/DatePopup';
import '../../components/ledger-statement.css';
import '../../components/party-statement-page.css';
import './ledger.css';

const { RangePicker } = DatePicker;

// Tally group order — assets first, capital last. Mirrors what
// Trial Balance and the chart-of-accounts UI already use.
const GROUP_ORDER = ['Assets', 'Liabilities', 'Income', 'Expenses', 'Capital'];

// Period presets — same labels as Sales Report / Day Book / etc.
function presets(fyStart, fyEnd) {
  const today = dayjs();
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

// COA Ledger surfaces all eight categories — depending on which ledger
// the user picked, any subset can show up (Sales A/c only sees Sales
// + Sales Return; Bank A/c only Receipt + Payment + Contra; etc.).
const COA_VOUCHER_CATEGORIES = [
  'Sales', 'Purchase', 'Receipt', 'Payment',
  'Sales Return', 'Purchase Return', 'Journal', 'Contra', 'Opening Adj.',
];

async function downloadExcel({ filename, rows, headers }) {
  const ExcelJS = await import('exceljs').then(m => m.default || m);
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Ledger Statement');
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

export default function Ledger() {
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const { fyStart, fyEnd } = useFinancialYear();

  const [accounts, setAccounts] = useState([]);
  const [ledgerId, setLedgerId] = useState(searchParams.get('id') ? parseInt(searchParams.get('id'), 10) : null);
  const [statement, setStatement] = useState(null);
  const [loading,   setLoading]   = useState(false);
  const [from, setFrom] = useState(searchParams.get('from') || fyStart || null);
  const [to,   setTo]   = useState(searchParams.get('to')   || fyEnd   || null);

  // Fetch the COA list once on mount. Filter out party-backed entries
  // — Customer/Supplier Statement own those. The exclude flag is a
  // server-side filter so we don't ship 5000 party rows to the client.
  useEffect(() => {
    ledgerAPI.listAccounts({ exclude_party_ledgers: 1 })
      .then(res => setAccounts(res.data?.data || []))
      .catch(() => message.error('Failed to load chart of accounts.'));
  }, []);

  // Fetch statement on ledgerId / period change. Same race-safety
  // pattern as PartyStatementPage.
  useEffect(() => {
    if (!ledgerId) { setStatement(null); return; }
    let stale = false;
    setLoading(true);
    ledgerAPI.statement(ledgerId, {
      from_date: from || undefined,
      to_date:   to   || undefined,
    })
      .then(res => { if (!stale) setStatement(res.data?.data || res.data); })
      .catch(err => {
        if (stale) return;
        message.error(err?.response?.data?.error || 'Failed to load statement.');
        setStatement(null);
      })
      .finally(() => { if (!stale) setLoading(false); });
    return () => { stale = true; };
  }, [ledgerId, from, to]);

  // URL writeback. Skip-when-current + setSearchParams-not-in-deps to
  // avoid the react-router-dom v6 feedback flicker — see the matching
  // comment in PartyStatementPage for the long version.
  useEffect(() => {
    const next = new URLSearchParams();
    if (ledgerId) next.set('id', String(ledgerId));
    if (from)     next.set('from', from);
    if (to)       next.set('to',   to);
    const current = new URLSearchParams(window.location.search).toString();
    if (next.toString() === current) return;
    setSearchParams(next, { replace: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ledgerId, from, to]);

  // Group the accounts list into Tally's five primaries → grouped
  // Select options. AntD Select renders OptGroup natively, so this
  // gives us a tidy dropdown like the JV form's account picker.
  const groupedOptions = useMemo(() => {
    const buckets = new Map();
    for (const a of accounts) {
      const g = a.ledger_group || '(Uncategorised)';
      if (!buckets.has(g)) buckets.set(g, []);
      buckets.get(g).push(a);
    }
    const ordered = [
      ...GROUP_ORDER.filter(g => buckets.has(g)),
      ...[...buckets.keys()].filter(g => !GROUP_ORDER.includes(g)),
    ];
    return ordered.map(g => ({
      label: g,
      options: buckets.get(g)
        .sort((a, b) => a.ledger_name.localeCompare(b.ledger_name))
        .map(a => ({
          value: a.ledger_id,
          label: a.ledger_name,
          // Stash sub_group for an inline secondary line in the
          // dropdown — same pattern as the COA picker on JV.
          _sub: a.sub_group,
        })),
    }));
  }, [accounts]);

  const activePreset = useMemo(() => {
    const prs = presets(fyStart, fyEnd);
    const hit = prs.find(p =>
      ((p.from?.format('YYYY-MM-DD') || null) === (from || null)) &&
      ((p.to?.format('YYYY-MM-DD')   || null) === (to   || null))
    );
    return hit?.v || 'custom';
  }, [from, to, fyStart, fyEnd]);

  const setPreset = (p) => {
    if (p.v === 'custom') return;
    setFrom(p.from?.format('YYYY-MM-DD') || null);
    setTo  (p.to?.format('YYYY-MM-DD')   || null);
  };

  // Voucher-type filter — same behaviour as PartyStatementPage. Empty
  // Set = show every category.
  const [voucherFilter, setVoucherFilter] = useState(() => new Set());
  const toggleVoucher = (cat) => {
    setVoucherFilter(prev => {
      const next = new Set(prev);
      if (next.has(cat)) next.delete(cat); else next.add(cat);
      return next;
    });
  };
  const clearVoucherFilter = () => setVoucherFilter(new Set());

  // Column visibility — same key as PartyStatementPage so the
  // operator's preference flows across all three statement pages.
  const COLS_LS_KEY = 'psp_visible_cols_v1';
  const [colVis, setColVis] = useState(() => {
    try {
      const saved = JSON.parse(localStorage.getItem(COLS_LS_KEY) || 'null');
      if (saved && typeof saved === 'object') return saved;
    } catch { /* fall through */ }
    return ALL_COLUMNS.reduce((acc, c) => ({ ...acc, [c.key]: c.default }), {});
  });
  const toggleCol = (key) => {
    setColVis(prev => {
      const def = ALL_COLUMNS.find(c => c.key === key);
      if (def?.required) return prev;
      const next = { ...prev, [key]: !prev[key] };
      try { localStorage.setItem(COLS_LS_KEY, JSON.stringify(next)); } catch { /* ignore */ }
      return next;
    });
  };
  const visibleColumns = useMemo(
    () => ALL_COLUMNS.filter(c => c.required || colVis[c.key]).map(c => c.key),
    [colVis],
  );
  // Shared `.cols-menu` markup so the global customize-menu styles
  // (styles/global.css) drive the look — pill rows + accent rail when
  // checked. Required columns fade + get a "Required" pin.
  const customizeContent = (
    <div className="cols-menu">
      <div className="grp">
        <div className="mh">Columns</div>
        {ALL_COLUMNS.map(c => (
          <label key={c.key} className={`opt${c.required ? ' fixed' : ''}`}>
            <input
              type="checkbox"
              checked={c.required || !!colVis[c.key]}
              disabled={c.required}
              onChange={() => toggleCol(c.key)}
            />
            <span>{c.label}</span>
            {c.required && <span className="pin">Required</span>}
          </label>
        ))}
      </div>
    </div>
  );

  const onPrint = () => window.print();
  const { openDate } = useDatePopup();
  const refresh = () => ledgerId && setLedgerId(ledgerId);

  const onExcel = () => {
    if (!statement?.entries?.length) { message.info('Nothing to export.'); return; }
    const acct = statement.account?.ledger_name || 'ledger';
    const fileSuffix = acct.replace(/[^a-z0-9]+/gi, '-').toLowerCase();
    const headers = ['Date', 'Type', 'Voucher No', 'Particulars', 'Debit', 'Credit', 'Balance'];
    const rows = [
      [from || '', '', '', 'Opening Balance', '', '', statement.opening_balance],
      ...statement.entries.map(e => [
        e.date, e.voucher_type, e.voucher_no || '', e.narration || '',
        e.debit || '', e.credit || '', e.balance,
      ]),
      ['', '', '', 'Period Totals', statement.total_debit, statement.total_credit, ''],
      [to || '', '', '', 'Closing Balance', '', '', statement.closing_balance],
    ];
    downloadExcel({ filename: `ledger-${fileSuffix}.xlsx`, rows, headers });
  };

  const onPdf = async () => {
    if (!statement) { message.info('Nothing to export.'); return; }
    try {
      await downloadStatementPdf({
        title: 'Ledger Statement',
        subtitle: statement.account?.ledger_name,
        statement,
        voucherFilter,
      });
    } catch (err) {
      console.error(err);
      message.error('PDF export failed.');
    }
  };

  const onDrill = (row) => {
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
      default: break;
    }
  };

  return (
    <div className="psp-page">
      <div className="psp-header">
        <div className="psp-titles">
          <Button type="text" icon={<ArrowLeftOutlined />} onClick={() => navigate(-1)} className="psp-back" />
          <h1 className="psp-title">Ledger Statement</h1>
        </div>
        <div className="psp-header-period">
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
        <div className="psp-actions">
          {/* Refresh, Customize, and PDF stay in the header.
              Print + Excel moved to the bottom strip (F9 / F10). */}
          <Tooltip title="Refresh">
            <Button className="rpt-btn" icon={<ReloadOutlined />} onClick={refresh} disabled={!ledgerId} />
          </Tooltip>
          <Popover content={customizeContent} title="Show columns" trigger="click" placement="bottomRight">
            <Tooltip title="Customize columns">
              <Button className="rpt-btn" icon={<SettingOutlined />} />
            </Tooltip>
          </Popover>
          <Tooltip title="Export PDF">
            <Button className="rpt-btn" icon={<FilePdfOutlined />} onClick={onPdf} disabled={!statement} />
          </Tooltip>
        </div>
      </div>

      <div className="psp-sticky">
        <div className="ledger-picker-bar">
          <Select
            placeholder="Pick a ledger account — Sales A/c, Bank, Office Rent, …"
            value={ledgerId}
            onChange={setLedgerId}
            options={groupedOptions}
            showSearch
            // Match against the rendered label text. AntD's filterOption
            // gets the option's `label` (a string here) so a substring
            // match is enough for the in-memory list.
            filterOption={(input, opt) =>
              !input || (opt.label || '').toLowerCase().includes(input.toLowerCase())
            }
            allowClear
            size="large"
            style={{ width: 480, maxWidth: '100%' }}
            popupMatchSelectWidth={false}
          />
        </div>


        {/* Voucher-type chips. COA Ledger surfaces all eight
            categories; not all will be present for any single
            ledger, but having them all listed keeps the chip strip
            stable across ledger picks. */}
        <div className="psp-vt-chips">
          <button
            className={'psp-vt-chip' + (voucherFilter.size === 0 ? ' on' : '')}
            onClick={clearVoucherFilter}
          >
            All
          </button>
          {COA_VOUCHER_CATEGORIES.map(cat => (
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

      <div className="psp-body">
        <LedgerStatement
          statement={statement}
          loading={loading}
          onRowClick={onDrill}
          voucherFilter={voucherFilter}
          columns={visibleColumns}
          emptyHint="Pick a ledger above to load the statement."
        />
      </div>

      <ActionStrip
        actions={[
          { id: 'back', key: 'Esc', label: 'Back',
            onAction: () => navigate('/reports') },
          { id: 'period', key: 'F2', label: 'Period',
            onAction: () => openDate({
              mode: 'range', title: 'Period',
              value: [from ? dayjs(from) : null, to ? dayjs(to) : null],
              onConfirm: ([f, t]) => {
                setFrom(f.format('YYYY-MM-DD'));
                setTo(t.format('YYYY-MM-DD'));
              },
            }) },
          { id: 'refresh', key: 'F5', label: 'Refresh',
            onAction: refresh, disabled: !ledgerId },
          { id: 'print', key: 'F9', label: 'Print',
            onAction: onPrint, disabled: !statement },
          { id: 'export', key: 'F10', label: 'Export',
            onAction: onExcel, disabled: !statement?.entries?.length },
        ]}
      />
    </div>
  );
}
