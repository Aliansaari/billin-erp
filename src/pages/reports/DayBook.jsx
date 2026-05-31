import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { DatePicker, Button, message, Checkbox, Popover, Input, Segmented } from 'antd';
import { SettingOutlined, SearchOutlined, SortAscendingOutlined, SortDescendingOutlined, BookOutlined, ShopOutlined } from '@ant-design/icons';
import dayjs from 'dayjs';
import { reportAPI } from '../../api';
import { useFinancialYear } from '../../hooks/useFinancialYear';
import useListSelection from '../../hooks/useListSelection';
import VirtualReportTable from '../../components/VirtualReportTable';
import ActionStrip from '../../components/keyboard/ActionStrip';
import { useDatePopup } from '../../components/keyboard/DatePopup';

/*
 * Day Book — classic accounting-style chronological voucher list.
 *
 * Data is loaded in one shot (the dayBook endpoint returns the full set
 * for the date range — no server-side pagination yet); voucher-type
 * filtering, free-text search, and the bottom Total are all computed
 * client-side over the loaded set. Virtualization in the wrapper keeps
 * the DOM bounded even when a wide date range loads tens of thousands
 * of vouchers.
 */

const VOUCHER_TYPES = [
  'Sales', 'Purchase', 'Sales Return', 'Purchase Return',
  'Receipt', 'Payment', 'Journal', 'Contra',
];

const ALL_COLS = [
  { key: 'sr_no',     label: 'Sr No',           default: true  },
  { key: 'date',      label: 'Date',            default: true  },
  { key: 'type',      label: 'Voucher Type',    default: true  },
  { key: 'no',        label: 'Voucher No',      default: true  },
  { key: 'party',     label: 'Party / Account', default: true  },
  { key: 'debit',     label: 'Debit',           default: true  },
  { key: 'credit',    label: 'Credit',          default: true  },
  { key: 'narration', label: 'Narration',       default: false },
];
const COLS_STORAGE_KEY = 'dayBook_cols_v1';
const DEFAULT_COLS = ALL_COLS.reduce((o, c) => ({ ...o, [c.key]: c.default }), {});

// KPI cards user can toggle via Customize. `tone` maps to the same theme CSS
// vars Sales Report uses, so the cards re-skin automatically across themes.
const ALL_KPIS = [
  { key: 'vouchers', label: 'Total Vouchers', tone: 'info',    default: true,
    value: (s) => String(s.voucher_count || 0) },
  { key: 'debit',    label: 'Total Debit',    tone: 'success', default: true,
    value: (s) => `₹ ${parseFloat(s.total_debit || 0).toLocaleString('en-IN', { minimumFractionDigits: 2 })}` },
  { key: 'credit',   label: 'Total Credit',   tone: 'warning', default: true,
    value: (s) => `₹ ${parseFloat(s.total_credit || 0).toLocaleString('en-IN', { minimumFractionDigits: 2 })}` },
  { key: 'sales',    label: 'Sales',          tone: 'success', default: true,
    value: (s) => String((s.counts_by_type || {})['Sales'] || 0) },
  { key: 'purchases',label: 'Purchases',      tone: 'accent',  default: true,
    value: (s) => String((s.counts_by_type || {})['Purchase'] || 0) },
  { key: 'returns',  label: 'Returns',        tone: 'warning', default: true,
    value: (s) => String(((s.counts_by_type || {})['Sales Return'] || 0) + ((s.counts_by_type || {})['Purchase Return'] || 0)) },
  { key: 'receipts', label: 'Receipts',       tone: 'success', default: false,
    value: (s) => String((s.counts_by_type || {})['Receipt'] || 0) },
  { key: 'payments', label: 'Payments',       tone: 'danger',  default: false,
    value: (s) => String((s.counts_by_type || {})['Payment'] || 0) },
  { key: 'journal',  label: 'Journal',        tone: 'info',    default: false,
    value: (s) => String((s.counts_by_type || {})['Journal'] || 0) },
  { key: 'contra',   label: 'Contra',         tone: 'neutral', default: false,
    value: (s) => String((s.counts_by_type || {})['Contra'] || 0) },
];
const KPIS_STORAGE_KEY = 'dayBook_kpis_v1';
const DEFAULT_KPIS = ALL_KPIS.reduce((o, k) => ({ ...o, [k.key]: k.default }), {});

const fmt = (v) => `₹ ${parseFloat(v || 0).toLocaleString('en-IN', { minimumFractionDigits: 2 })}`;

const TYPE_TONE = {
  'Sales':           'success',
  'Sales Return':    'warning',
  'Purchase':        'accent',
  'Purchase Return': 'warning',
  'Receipt':         'success',
  'Payment':         'danger',
  'Journal':         'info',
  'Contra':          'neutral',
};

// ── Shop-owner ("Simple") view ───────────────────────────────────────
// A friendlier re-presentation of the SAME vouchers for non-accountants.
// CRITICAL: "Money In" means money ACTUALLY received and "Money Out"
// money actually paid — driven by the cash/bank movement the server
// derived per voucher (cash_in / cash_out). A credit sale (nothing
// received yet) therefore lands in "On Credit", NOT in Money In; a cash
// sale and a customer receipt land in Money In. Nothing is recomputed —
// each row's amounts already exist; we only bucket them:
//   · cash_in   → Money In   (received: cash sales, receipts, cash refunds)
//   · cash_out  → Money Out  (paid: cash purchases, payments, expenses)
//   · remainder of a Sale/Purchase not settled in cash → On Credit
// The chosen view is remembered across logins/sessions (localStorage).
const VIEW_STORAGE_KEY = 'dayBook_view_v1';
// The voucher's billed value = the primary leg's non-zero side
// (a ledger leg is either a debit OR a credit, never both).
const rowAmount = (r) => Math.max(parseFloat(r.debit || 0), parseFloat(r.credit || 0));
function classifySimple(r) {
  const t = r.voucher_type;
  const cashIn  = Math.max(0, parseFloat(r.cash_in  || 0));   // server-derived
  const cashOut = Math.max(0, parseFloat(r.cash_out || 0));
  const amt = rowAmount(r);
  // The portion of a trade voucher NOT settled in cash = sold/bought on
  // credit (a receivable or payable). For a fully-credit sale this is the
  // whole bill; for a cash sale it's zero; for a partial, the balance.
  let credit = 0;
  if (t === 'Sales' || t === 'Purchase' || t === 'Sales Return' || t === 'Purchase Return') {
    credit = Math.max(0, amt - cashIn - cashOut);
  }
  // Plain-language label — spell out cash vs credit where it matters most.
  let label = t || '—';
  if (t === 'Receipt')              label = 'Payment received';
  else if (t === 'Payment')         label = 'Payment made';
  else if (t === 'Sales')           label = credit > 0 ? (cashIn  > 0 ? 'Sale (part credit)'     : 'Credit sale')     : 'Cash sale';
  else if (t === 'Purchase')        label = credit > 0 ? (cashOut > 0 ? 'Purchase (part credit)' : 'Credit purchase') : 'Cash purchase';
  else if (t === 'Sales Return')    label = 'Sales return';
  else if (t === 'Purchase Return') label = 'Purchase return';
  else if (t === 'Contra')          label = 'Cash / bank transfer';
  else if (t === 'Journal')         label = 'Adjustment';
  // Pill tone reflects the dominant effect of the row.
  let tone = 'neutral';
  if (cashIn > 0)       tone = 'success';
  else if (cashOut > 0) tone = 'danger';
  else if (credit > 0)  tone = 'warning';
  return { label, tone, cashIn, cashOut, credit };
}

// Simple-view KPI cards — toggleable via Customize (mirrors the
// accounting view). `tone` is a fn of the totals so Net Cash can flip
// red when negative. Persisted so the operator's choice sticks.
const SIMPLE_KPIS = [
  { key: 'money_in',  label: 'Money In · Received',          tone: ()  => 'success' },
  { key: 'money_out', label: 'Money Out · Paid',             tone: ()  => 'danger'  },
  { key: 'net',       label: 'Net Cash (In − Out)',          tone: (t) => (t.net >= 0 ? 'success' : 'danger') },
  { key: 'on_credit', label: 'On Credit · To collect / pay', tone: ()  => 'warning' },
];
const SIMPLE_KPIS_STORAGE_KEY = 'dayBook_simpleKpis_v1';
const DEFAULT_SIMPLE_KPIS = SIMPLE_KPIS.reduce((o, k) => ({ ...o, [k.key]: true }), {});
const simpleKpiValue = (key, t) => {
  switch (key) {
    case 'money_in':  return fmt(t.inSum);
    case 'money_out': return fmt(t.outSum);
    case 'net':       return fmt(t.net);
    case 'on_credit': return fmt(t.creditSum);
    default:          return '';
  }
};

export default function DayBook() {
  const navigate = useNavigate();
  const { fyStart, fyEnd } = useFinancialYear();

  // URL search params — when reached via a P&L drill-down on a misc
  // ledger (Round Off, Discount Allowed/Received, Direct/Indirect
  // Income/Expense), `?from=…&to=…&ledger_id=…&ledger_name=…` carries
  // the source report's window + which ledger to focus on. The
  // ledger_id filter isn't yet supported by the backend; we honour
  // the period for now and the per-ledger filter is a follow-up.
  const [searchParams] = useSearchParams();
  const initialFrom = (() => {
    const q = searchParams.get('from');
    return q && dayjs(q).isValid() ? q : null;
  })();
  const initialTo = (() => {
    const q = searchParams.get('to');
    return q && dayjs(q).isValid() ? q : null;
  })();

  const [data, setData] = useState([]);
  const [summary, setSummary] = useState({});
  const [loading, setLoading] = useState(false);

  const today = dayjs().format('YYYY-MM-DD');
  const [filters, setFilters] = useState({
    from_date: initialFrom || today,
    to_date:   initialTo   || today,
    voucher_types: [],
    sort_dir: 'asc',
    search: '',
  });
  const [colsVisible, setColsVisible] = useState(() => {
    try {
      const saved = JSON.parse(localStorage.getItem(COLS_STORAGE_KEY) || 'null');
      return saved && typeof saved === 'object' ? { ...DEFAULT_COLS, ...saved } : DEFAULT_COLS;
    } catch { return DEFAULT_COLS; }
  });
  const [kpisVisible, setKpisVisible] = useState(() => {
    try {
      const saved = JSON.parse(localStorage.getItem(KPIS_STORAGE_KEY) || 'null');
      return saved && typeof saved === 'object' ? { ...DEFAULT_KPIS, ...saved } : DEFAULT_KPIS;
    } catch { return DEFAULT_KPIS; }
  });
  // Simple-view KPI card visibility — its own Customize-driven prefs.
  const [simpleKpisVisible, setSimpleKpisVisible] = useState(() => {
    try {
      const saved = JSON.parse(localStorage.getItem(SIMPLE_KPIS_STORAGE_KEY) || 'null');
      return saved && typeof saved === 'object' ? { ...DEFAULT_SIMPLE_KPIS, ...saved } : DEFAULT_SIMPLE_KPIS;
    } catch { return DEFAULT_SIMPLE_KPIS; }
  });


  useEffect(() => {
    try { localStorage.setItem(COLS_STORAGE_KEY, JSON.stringify(colsVisible)); } catch {}
  }, [colsVisible]);
  useEffect(() => {
    try { localStorage.setItem(KPIS_STORAGE_KEY, JSON.stringify(kpisVisible)); } catch {}
  }, [kpisVisible]);
  useEffect(() => {
    try { localStorage.setItem(SIMPLE_KPIS_STORAGE_KEY, JSON.stringify(simpleKpisVisible)); } catch {}
  }, [simpleKpisVisible]);

  // View mode — 'accounting' (classic Dr/Cr, default — unchanged for
  // existing users) or 'simple' (shop-owner Money In / Money Out).
  // Remembered across sessions so the operator's choice sticks.
  const [viewMode, setViewMode] = useState(() => {
    try { return localStorage.getItem(VIEW_STORAGE_KEY) === 'simple' ? 'simple' : 'accounting'; }
    catch { return 'accounting'; }
  });
  useEffect(() => {
    try { localStorage.setItem(VIEW_STORAGE_KEY, viewMode); } catch {}
  }, [viewMode]);
  const isSimple = viewMode === 'simple';

  useEffect(() => { load(); }, [filters.from_date, filters.to_date, filters.sort_dir]);

  const load = async () => {
    setLoading(true);
    try {
      const params = {
        from_date: filters.from_date,
        to_date:   filters.to_date,
        sort_dir:  filters.sort_dir,
      };
      const { data: res } = await reportAPI.dayBook(params);
      setData(res.data || []);
      setSummary(res.summary || {});
    } catch (e) {
      message.error('Failed to load Day Book');
    }
    setLoading(false);
  };

  const handlePrint = () => window.print();
  const handleExport = () => {
    const rows = filteredData;
    // Simple (shop-owner) view exports Money In / Money Out columns so the
    // file matches what's on screen. Same rows, friendlier headings.
    if (viewMode === 'simple') {
      const head = ['Date', 'Activity', 'Party / Account', 'Money In', 'Money Out', 'On Credit'];
      const csv = [head.join(',')]
        .concat(rows.map(r => {
          const { label, cashIn, cashOut, credit } = classifySimple(r);
          return [
            dayjs(r.entry_date).format('DD/MM/YYYY'),
            `"${label.replace(/"/g, '""')}"`,
            `"${(r.party_or_account || '').replace(/"/g, '""')}"`,
            cashIn  > 0 ? cashIn  : '',
            cashOut > 0 ? cashOut : '',
            credit  > 0 ? credit  : '',
          ].join(',');
        }))
        .join('\n');
      const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `daybook_money_in_out_${filters.from_date}_to_${filters.to_date}.csv`;
      a.click();
      URL.revokeObjectURL(url);
      return;
    }
    const head = ['Date', 'Type', 'Voucher No', 'Party / Account', 'Debit', 'Credit', 'Narration'];
    const csv = [head.join(',')]
      .concat(rows.map(r => [
        dayjs(r.entry_date).format('DD/MM/YYYY'),
        r.voucher_type,
        r.voucher_no,
        `"${(r.party_or_account || '').replace(/"/g, '""')}"`,
        r.debit || '',
        r.credit || '',
        `"${(r.narration || '').replace(/"/g, '""')}"`,
      ].join(',')))
      .join('\n');
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `daybook_${filters.from_date}_to_${filters.to_date}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const filteredData = useMemo(() => {
    let rows = data;
    if (filters.voucher_types.length > 0) {
      const set = new Set(filters.voucher_types);
      rows = rows.filter(r => set.has(r.voucher_type));
    }
    if (filters.search) {
      const q = filters.search.toLowerCase();
      rows = rows.filter(r =>
        (r.voucher_no || '').toLowerCase().includes(q) ||
        (r.party_or_account || '').toLowerCase().includes(q) ||
        (r.narration || '').toLowerCase().includes(q) ||
        String(r.debit || '').includes(q) ||
        String(r.credit || '').includes(q)
      );
    }
    return rows;
  }, [data, filters.voucher_types, filters.search]);

  // Cursor + multi-select for the rows; F-keys live in the bottom
  // ActionStrip and operate on the cursored row.
  const sel = useListSelection({ totalCount: filteredData.length, rows: filteredData });
  const single = sel.activeRow;
  const searchInputRef = useRef(null);
  const { openDate } = useDatePopup();

  const typeCounts = summary.counts_by_type || {};

  const COL_SPECS = useMemo(() => ({
    sr_no: { title: 'Sr', width: 56, align: 'center',
             render: (_v, _r, idx) => <span style={{ color: 'var(--fg-tertiary)', fontFamily: 'Geist Mono, monospace' }}>{idx + 1}</span> },
    date:  { title: 'Date', dataIndex: 'entry_date', width: 110,
             render: (v) => dayjs(v).format('DD/MM/YYYY') },
    type:  { title: 'Voucher Type', dataIndex: 'voucher_type', width: 130,
             render: (v) => <span className={`rpt-pill type-${(TYPE_TONE[v] || 'neutral')}`}>{v}</span> },
    no:    { title: 'Voucher No', dataIndex: 'voucher_no', width: 140,
             render: (v) => <span className="rpt-bill-no">{v}</span> },
    party: { title: 'Party / Account', dataIndex: 'party_or_account', width: 220,
             render: (v) => v || '—' },
    debit: { title: 'Debit', dataIndex: 'debit', width: 130, align: 'right',
             render: (v) => parseFloat(v || 0) > 0
               ? <span style={{ color: 'var(--success)', fontWeight: 600 }}>{fmt(v)}</span>
               : '—' },
    credit:{ title: 'Credit', dataIndex: 'credit', width: 130, align: 'right',
             render: (v) => parseFloat(v || 0) > 0
               ? <span style={{ color: 'var(--warning)', fontWeight: 600 }}>{fmt(v)}</span>
               : '—' },
    narration: { title: 'Narration', dataIndex: 'narration', width: 240,
                 render: (v) => <span style={{ color: 'var(--fg-secondary)', fontSize: 12 }}>{v || '—'}</span> },
  }), []);

  const columns = useMemo(() => {
    return ALL_COLS.filter(c => colsVisible[c.key]).map(c => ({ key: c.key, ...COL_SPECS[c.key] }));
  }, [colsVisible, COL_SPECS]);

  // Simple (shop-owner) columns — a fixed, curated layout: Date · what
  // happened · who · Money In · Money Out. One amount lands in exactly
  // one money column; the other shows a dash, so the eye scans each
  // column like a classic cash book (rokad).
  const simpleColumns = useMemo(() => ([
    { key: 'sr_no', title: 'Sr', width: 56, align: 'center',
      render: (_v, _r, idx) => <span style={{ color: 'var(--fg-tertiary)', fontFamily: 'Geist Mono, monospace' }}>{idx + 1}</span> },
    { key: 'date', title: 'Date', dataIndex: 'entry_date', width: 110,
      render: (v) => dayjs(v).format('DD/MM/YYYY') },
    { key: 'activity', title: 'Activity', width: 180,
      render: (_v, r) => {
        const { label, tone } = classifySimple(r);
        return <span className={`rpt-pill type-${tone}`}>{label}</span>;
      } },
    { key: 'party', title: 'Party / Account', dataIndex: 'party_or_account', width: 230,
      render: (v) => v || '—' },
    { key: 'money_in', title: 'Money In', width: 140, align: 'right',
      render: (_v, r) => { const { cashIn } = classifySimple(r); return cashIn > 0
        ? <span style={{ color: 'var(--success)', fontWeight: 700 }}>{fmt(cashIn)}</span>
        : <span style={{ color: 'var(--fg-tertiary)' }}>—</span>; } },
    { key: 'money_out', title: 'Money Out', width: 140, align: 'right',
      render: (_v, r) => { const { cashOut } = classifySimple(r); return cashOut > 0
        ? <span style={{ color: 'var(--danger)', fontWeight: 700 }}>{fmt(cashOut)}</span>
        : <span style={{ color: 'var(--fg-tertiary)' }}>—</span>; } },
    { key: 'on_credit', title: 'On Credit', width: 150, align: 'right',
      render: (_v, r) => { const { credit } = classifySimple(r); return credit > 0
        ? <span style={{ color: 'var(--warning)', fontWeight: 700 }} title="Billed on credit — not yet received / paid in cash">{fmt(credit)}</span>
        : <span style={{ color: 'var(--fg-tertiary)' }}>—</span>; } },
  ]), []);

  // Same markup shape as the SalesList / ProductList Customize popovers
  // so the shared `.cols-menu` styles in styles/global.css drive the look.
  // Functional state (kpisVisible / colsVisible) is unchanged — we just
  // swap AntD Checkbox + grid wrappers for native `<label class="opt">`
  // rows so the accent-rail-on-checked treatment lights up via :has().
  const customizePopoverContent = (
    <div className="cols-menu" style={{ width: 280, maxHeight: '70vh', overflowY: 'auto' }}>
      <div className="grp">
        <div className="mh">KPI Cards</div>
        {ALL_KPIS.map((k) => (
          <label key={k.key} className="opt">
            <input
              type="checkbox"
              checked={!!kpisVisible[k.key]}
              onChange={(e) => setKpisVisible((v) => ({ ...v, [k.key]: e.target.checked }))}
            />
            <span>{k.label}</span>
          </label>
        ))}
      </div>
      <div className="grp">
        <div className="mh">Columns</div>
        {ALL_COLS.map((c) => (
          <label key={c.key} className="opt">
            <input
              type="checkbox"
              checked={!!colsVisible[c.key]}
              onChange={(e) => setColsVisible((v) => ({ ...v, [c.key]: e.target.checked }))}
            />
            <span>{c.label}</span>
          </label>
        ))}
      </div>
    </div>
  );

  // Simple-view Customize — show/hide the Money In / Out / Net / On-Credit
  // summary cards. Same look as the accounting popover.
  const simpleCustomizePopoverContent = (
    <div className="cols-menu" style={{ width: 260 }}>
      <div className="grp">
        <div className="mh">KPI Cards</div>
        {SIMPLE_KPIS.map((k) => (
          <label key={k.key} className="opt">
            <input
              type="checkbox"
              checked={!!simpleKpisVisible[k.key]}
              onChange={(e) => setSimpleKpisVisible((v) => ({ ...v, [k.key]: e.target.checked }))}
            />
            <span>{k.label}</span>
          </label>
        ))}
      </div>
    </div>
  );

  const filteredTotals = useMemo(() => {
    let dr = 0, cr = 0;
    for (const r of filteredData) { dr += parseFloat(r.debit || 0); cr += parseFloat(r.credit || 0); }
    return { dr, cr };
  }, [filteredData]);

  // Money In / Out / Net over the currently-visible rows. Mirrors the
  // accounting filteredTotals above — it only sums amounts that already
  // exist on each row; it computes nothing new.
  const simpleTotals = useMemo(() => {
    let inSum = 0, outSum = 0, creditSum = 0;
    for (const r of filteredData) {
      const { cashIn, cashOut, credit } = classifySimple(r);
      inSum += cashIn; outSum += cashOut; creditSum += credit;
    }
    return { inSum, outSum, creditSum, net: inSum - outSum };
  }, [filteredData]);

  const toggleType = (t) => {
    setFilters(f => {
      const cur = new Set(f.voucher_types);
      if (cur.has(t)) cur.delete(t); else cur.add(t);
      return { ...f, voucher_types: [...cur] };
    });
  };

  // Bottom Total — uses client-filtered totals (totals reflect what's
  // currently visible, not the full loaded set). Same colSpan-merge
  // pattern as Sales/Purchase: leading non-aggregable columns merge
  // into one wide cell holding the "Total (N)" label.
  const SUMMABLE_KEYS = useMemo(() => new Set(['debit', 'credit']), []);
  const firstAggIdx = useMemo(() => {
    const idx = columns.findIndex((c) => SUMMABLE_KEYS.has(c.key));
    return idx === -1 ? columns.length : idx;
  }, [columns, SUMMABLE_KEYS]);

  const summaryCells = (col, idx) => {
    if (idx === 0) return filteredData.length > 0 ? `Total (${filteredData.length})` : null;
    if (idx > 0 && idx < firstAggIdx) return null;
    if (col.key === 'debit')  return fmt(filteredTotals.dr);
    if (col.key === 'credit') return fmt(filteredTotals.cr);
    return null;
  };

  const summaryColSpan = (col, idx) => {
    if (idx === 0) return Math.max(1, firstAggIdx);
    if (idx > 0 && idx < firstAggIdx) return 0;
    return 1;
  };

  // Simple-view bottom total — foots the two money columns separately.
  const simpleFirstAggIdx = useMemo(
    () => simpleColumns.findIndex((c) => c.key === 'money_in'),
    [simpleColumns],
  );
  const simpleSummaryCells = (col, idx) => {
    if (idx === 0) return filteredData.length > 0 ? `Total (${filteredData.length})` : null;
    if (idx > 0 && idx < simpleFirstAggIdx) return null;
    if (col.key === 'money_in')  return <span style={{ color: 'var(--success)', fontWeight: 700 }}>{fmt(simpleTotals.inSum)}</span>;
    if (col.key === 'money_out') return <span style={{ color: 'var(--danger)',  fontWeight: 700 }}>{fmt(simpleTotals.outSum)}</span>;
    if (col.key === 'on_credit') return <span style={{ color: 'var(--warning)', fontWeight: 700 }}>{fmt(simpleTotals.creditSum)}</span>;
    return null;
  };
  const simpleSummaryColSpan = (col, idx) => {
    if (idx === 0) return Math.max(1, simpleFirstAggIdx);
    if (idx > 0 && idx < simpleFirstAggIdx) return 0;
    return 1;
  };

  // Pick the active view's columns + footer so the table render stays
  // a single block regardless of mode.
  const activeColumns        = isSimple ? simpleColumns : columns;
  const activeSummaryCells   = isSimple ? simpleSummaryCells : summaryCells;
  const activeSummaryColSpan = isSimple ? simpleSummaryColSpan : summaryColSpan;

  const fyLabel = fyStart ? `FY ${dayjs(fyStart).format('YYYY')}-${dayjs(fyEnd).format('YY')}` : '';
  const voucherCount = summary.voucher_count || 0;

  return (
    <div className="report-editorial" style={{ height: '100%', display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
      <div className="rpt-page-hd" style={{ alignItems: 'center' }}>
        <div className="rpt-title">
          <h1>Day Book</h1>
          <div className="rpt-sub">
            <b>{voucherCount}</b> voucher{voucherCount === 1 ? '' : 's'}
            {fyLabel && <><span className="sep">·</span>{fyLabel}</>}
            {isSimple && <><span className="sep">·</span>Cash book view</>}
          </div>
        </div>
        <div className="rpt-hd-ctrl">
          {/* View switch — Accounting (classic Dr/Cr) ↔ Simple (shop-owner
              Money In / Out). Choice is remembered across sessions. */}
          <Segmented
            value={viewMode}
            onChange={(v) => setViewMode(v)}
            options={[
              { label: 'Accounting', value: 'accounting', icon: <BookOutlined /> },
              { label: 'Simple',     value: 'simple',     icon: <ShopOutlined /> },
            ]}
            title="Switch between the accounting view and the simple Money In / Out view"
          />
          <DatePicker.RangePicker
            format="DD/MM/YYYY" className="rpt-date"
            allowClear={false}
            value={[dayjs(filters.from_date), dayjs(filters.to_date)]}
            onChange={(v) => {
              const from = v?.[0]?.format('YYYY-MM-DD') || fyStart || dayjs().startOf('month').format('YYYY-MM-DD');
              const to   = v?.[1]?.format('YYYY-MM-DD') || fyEnd   || dayjs().endOf('month').format('YYYY-MM-DD');
              setFilters((f) => ({ ...f, from_date: from, to_date: to }));
            }}
          />
          <Button
            icon={filters.sort_dir === 'asc' ? <SortAscendingOutlined /> : <SortDescendingOutlined />}
            onClick={() => setFilters(f => ({ ...f, sort_dir: f.sort_dir === 'asc' ? 'desc' : 'asc' }))}
            className="rpt-btn"
          >
            {filters.sort_dir === 'asc' ? 'Oldest' : 'Newest'}
          </Button>
          {/* Customize — accounting view tunes KPI cards + columns; simple
              view tunes its Money In/Out/Net/On-Credit cards. */}
          <Popover content={isSimple ? simpleCustomizePopoverContent : customizePopoverContent} title="Customize" trigger="click" placement="bottomRight">
            <Button icon={<SettingOutlined />} className="rpt-btn">Customize</Button>
          </Popover>
          {/* Excel + Print moved to the bottom strip (F10 / F9). */}
        </div>
      </div>

      {isSimple ? (
        SIMPLE_KPIS.some((k) => simpleKpisVisible[k.key]) && (
          <div className="rpt-kpis">
            {SIMPLE_KPIS.filter((k) => simpleKpisVisible[k.key]).map((k) => (
              <div key={k.key} className={`rpt-kpi tone-${k.tone(simpleTotals)}`}>
                <div className="rpt-kpi-k">{k.label}</div>
                <div className="rpt-kpi-v">{simpleKpiValue(k.key, simpleTotals)}</div>
              </div>
            ))}
          </div>
        )
      ) : (
        ALL_KPIS.some((k) => kpisVisible[k.key]) && (
          <div className="rpt-kpis">
            {ALL_KPIS.filter((k) => kpisVisible[k.key]).map((k) => (
              <div key={k.key} className={`rpt-kpi tone-${k.tone}`}>
                <div className="rpt-kpi-k">{k.label}</div>
                <div className="rpt-kpi-v">{k.value(summary)}</div>
              </div>
            ))}
          </div>
        )
      )}

      <div className="rpt-filter">
        <Input
          ref={searchInputRef}
          className="rpt-search"
          prefix={<SearchOutlined />}
          placeholder="Search voucher no, party, narration, or amount…"
          value={filters.search}
          onChange={(e) => setFilters((f) => ({ ...f, search: e.target.value }))}
          allowClear
        />
        <span className="rpt-sep" />
        {VOUCHER_TYPES.map((t) => {
          const active = filters.voucher_types.includes(t);
          const tone = TYPE_TONE[t] || 'neutral';
          const count = typeCounts[t] || 0;
          return (
            <button
              key={t}
              className={`rpt-chip ${active ? 'on' : ''}`}
              onClick={() => toggleType(t)}
              disabled={count === 0 && !active}
              title={`${t} · ${count}`}
            >
              <span className={`rpt-dot tone-${tone}`} />{t}
              {count > 0 && <span style={{ marginLeft: 6, opacity: 0.7, fontSize: 11 }}>{count}</span>}
            </button>
          );
        })}
      </div>

      <div className="rpt-tbl-wrap">
        <VirtualReportTable
          columns={activeColumns}
          rows={filteredData}
          totalCount={filteredData.length}
          loading={loading}
          rowKey="entry_number"
          scroll={{ x: 1100 }}
          summaryCells={activeSummaryCells}
          summaryColSpan={activeSummaryColSpan}
          controlledCursorIdx={sel.cursorIdx}
          controlledSelectedSet={sel.selectedSet}
          onCursorMove={sel.setCursor}
          onShiftClickRow={sel.extendTo}
          onCtrlClickRow={sel.toggleRow}
          onRow={(record) => ({
            onDoubleClick: () => { if (record && record.drill_route) navigate(record.drill_route); },
            style: record && record.drill_route ? { cursor: 'pointer' } : undefined,
          })}
        />
      </div>

      <ActionStrip
        actions={[
          { id: 'back', key: 'Esc', label: 'Back',
            onAction: () => navigate('/reports') },
          { id: 'period', key: 'F2', label: 'Period',
            onAction: () => openDate({
              mode: 'range', title: 'Period',
              value: [dayjs(filters.from_date), dayjs(filters.to_date)],
              onConfirm: ([from, to]) => {
                setFilters((f) => ({
                  ...f,
                  from_date: from.format('YYYY-MM-DD'),
                  to_date:   to.format('YYYY-MM-DD'),
                }));
              },
            }) },
          { id: 'find', key: 'F4', label: 'Find',
            onAction: () => searchInputRef.current?.focus?.() },
          { id: 'refresh', key: 'F5', label: 'Refresh',
            onAction: () => load() },
          { id: 'print', key: 'F9', label: 'Print',
            onAction: () => handlePrint() },
          { id: 'export', key: 'F10', label: 'Export',
            onAction: () => handleExport() },
          { id: 'drill', key: 'F1', label: 'Open Voucher', tone: 'primary',
            disabled: !single || !single.drill_route,
            onAction: () => single?.drill_route && navigate(single.drill_route) },
        ]}
      />
    </div>
  );
}
