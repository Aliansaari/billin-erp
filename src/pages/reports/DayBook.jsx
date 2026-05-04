import React, { useEffect, useMemo, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { DatePicker, Button, message, Checkbox, Popover, Input } from 'antd';
import { SettingOutlined, PrinterOutlined, DownloadOutlined, SearchOutlined, SortAscendingOutlined, SortDescendingOutlined } from '@ant-design/icons';
import dayjs from 'dayjs';
import { reportAPI } from '../../api';
import { useFinancialYear } from '../../hooks/useFinancialYear';
import VirtualReportTable from '../../components/VirtualReportTable';

/*
 * Day Book — Tally-style chronological voucher list.
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

  const [filters, setFilters] = useState({
    from_date: initialFrom || fyStart || dayjs().startOf('month').format('YYYY-MM-DD'),
    to_date:   initialTo   || fyEnd   || dayjs().endOf('month').format('YYYY-MM-DD'),
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

  // Hydrate the date window from FY when it arrives async (first paint may
  // happen before the settings call resolves; pickers default to "today" then).
  useEffect(() => {
    if (!fyStart || !fyEnd) return;
    setFilters((f) => {
      const todayMonthStart = dayjs().startOf('month').format('YYYY-MM-DD');
      const todayMonthEnd   = dayjs().endOf('month').format('YYYY-MM-DD');
      if (f.from_date === todayMonthStart && f.to_date === todayMonthEnd) {
        return { ...f, from_date: fyStart, to_date: fyEnd };
      }
      return f;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fyStart, fyEnd]);

  useEffect(() => {
    try { localStorage.setItem(COLS_STORAGE_KEY, JSON.stringify(colsVisible)); } catch {}
  }, [colsVisible]);
  useEffect(() => {
    try { localStorage.setItem(KPIS_STORAGE_KEY, JSON.stringify(kpisVisible)); } catch {}
  }, [kpisVisible]);

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

  const filteredTotals = useMemo(() => {
    let dr = 0, cr = 0;
    for (const r of filteredData) { dr += parseFloat(r.debit || 0); cr += parseFloat(r.credit || 0); }
    return { dr, cr };
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
          </div>
        </div>
        <div className="rpt-hd-ctrl">
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
          <Popover content={customizePopoverContent} title="Customize" trigger="click" placement="bottomRight">
            <Button icon={<SettingOutlined />} className="rpt-btn">Customize</Button>
          </Popover>
          <Button icon={<DownloadOutlined />} onClick={handleExport} className="rpt-btn">Excel</Button>
          <Button icon={<PrinterOutlined />}  onClick={handlePrint}  className="rpt-btn">Print</Button>
        </div>
      </div>

      {ALL_KPIS.some((k) => kpisVisible[k.key]) && (
        <div className="rpt-kpis">
          {ALL_KPIS.filter((k) => kpisVisible[k.key]).map((k) => (
            <div key={k.key} className={`rpt-kpi tone-${k.tone}`}>
              <div className="rpt-kpi-k">{k.label}</div>
              <div className="rpt-kpi-v">{k.value(summary)}</div>
            </div>
          ))}
        </div>
      )}

      <div className="rpt-filter">
        <Input
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
          columns={columns}
          rows={filteredData}
          totalCount={filteredData.length}
          loading={loading}
          rowKey="entry_number"
          scroll={{ x: 1100 }}
          summaryCells={summaryCells}
          summaryColSpan={summaryColSpan}
          onRow={(record) => ({
            onClick: () => { if (record && record.drill_route) navigate(record.drill_route); },
            style: record && record.drill_route ? { cursor: 'pointer' } : undefined,
          })}
        />
      </div>
    </div>
  );
}
