import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  Table, Button, Select, Tooltip, message, Segmented, Input, DatePicker,
} from 'antd';
import {
  ReloadOutlined, SearchOutlined, TeamOutlined, FileExcelOutlined,
  RiseOutlined, FallOutlined,
} from '@ant-design/icons';
import { useNavigate, useSearchParams } from 'react-router-dom';
import dayjs from 'dayjs';
import { reportAPI } from '../../api';
import { useFinancialYear } from '../../hooks/useFinancialYear';
import ActionStrip from '../../components/keyboard/ActionStrip';
// Same editorial-report skin the Expiry / Sales reports use.
import '../inventory/stock-transfer-form.css';

/*
 * Top Parties — the league table.
 *
 *   Customers → who buys the most, and which of them actually earn
 *               money (gross profit + margin per customer).
 *   Suppliers → who you buy the most from, and whether they bring
 *               breadth (styles) or depth (units per style).
 *
 * Every figure is over a user-chosen date range, compared against the
 * same number of days immediately before it, so "is this party growing
 * or shrinking" is answerable without exporting anything.
 *
 * The concentration tiles (top 3 / 5 / 10 share) are measured on the
 * value ranking over the FULL party set, not the visible top-N — the
 * question "how much of my book rides on a handful of names" would be
 * meaningless if it only counted the rows on screen.
 */

const fmtL = (v) => {
  const n = Math.round(parseFloat(v || 0));
  if (Math.abs(n) >= 10000000) return `₹${(n / 10000000).toFixed(2)} Cr`;
  if (Math.abs(n) >= 100000)   return `₹${(n / 100000).toFixed(2)} L`;
  return `₹${n.toLocaleString('en-IN')}`;
};
const fmtInt = (v) => `₹ ${Math.round(parseFloat(v || 0)).toLocaleString('en-IN')}`;
const fmtN   = (v) => Math.round(parseFloat(v || 0)).toLocaleString('en-IN');

const PRESETS = [
  { value: 'this_fy',   label: 'This FY' },
  { value: 'last_fy',   label: 'Last FY' },
  { value: 'this_cy',   label: 'This Year' },
  { value: 'last_cy',   label: 'Last Year' },
  { value: 'last_12m',  label: 'Last 12 Months' },
  { value: 'this_q',    label: 'This Quarter' },
  { value: 'this_month',label: 'This Month' },
  { value: 'custom',    label: 'Custom' },
];

function presetRange(key, fyStart, fyEnd) {
  const today = dayjs();
  if (key === 'this_fy')    return [dayjs(fyStart), dayjs(fyEnd)];
  if (key === 'last_fy')    return [dayjs(fyStart).subtract(1, 'year'), dayjs(fyEnd).subtract(1, 'year')];
  if (key === 'this_cy')    return [today.startOf('year'), today.endOf('year')];
  if (key === 'last_cy')    return [today.subtract(1, 'year').startOf('year'), today.subtract(1, 'year').endOf('year')];
  if (key === 'last_12m')   return [today.subtract(12, 'month').add(1, 'day'), today];
  if (key === 'this_q')     return [today.startOf('quarter'), today.endOf('quarter')];
  if (key === 'this_month') return [today.startOf('month'), today.endOf('month')];
  return null;
}

// Growth cell — null means the party did not trade in the comparison
// window at all, which is "new", not "+0%".
function ChangeCell({ value }) {
  if (value == null) {
    return <Tooltip title="No trade in the comparison period"><span className="rpt-pill type-accent">New</span></Tooltip>;
  }
  const up = value >= 0;
  return (
    <span style={{
      color: up ? 'var(--success)' : 'var(--danger)',
      fontWeight: 700, fontVariantNumeric: 'tabular-nums',
    }}>
      {up ? <RiseOutlined /> : <FallOutlined />} {up ? '+' : ''}{value}%
    </span>
  );
}

export default function TopPartiesReport() {
  const nav = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const { fyStart, fyEnd } = useFinancialYear();

  // URL-backed so each side is separately bookmarkable and the hub can
  // deep-link either one.
  const direction = searchParams.get('direction') === 'supplier' ? 'supplier' : 'customer';
  const isCustomer = direction === 'customer';

  const [rows, setRows]       = useState([]);
  const [totals, setTotals]   = useState({});
  const [period, setPeriod]   = useState({});
  const [prevPeriod, setPrev] = useState({});
  const [loading, setLoading] = useState(false);
  const [exporting, setExporting] = useState(false);

  const [preset, setPreset] = useState('this_fy');
  const [from, setFrom]     = useState(null);
  const [to, setTo]         = useState(null);
  const [limit, setLimit]   = useState(25);
  const [sort, setSort]     = useState('value_desc');
  const [q, setQ]           = useState('');
  // Counter cash is included by default — on a retail book it is most
  // of the sales, so hiding it would understate the totals. It is not a
  // party you can call, though, so it can be dropped for a true
  // named-account ranking.
  const [excludeCash, setExcludeCash] = useState(false);
  const searchInputRef = useRef(null);

  // Resolve preset → concrete dates. Custom leaves whatever the picker set.
  useEffect(() => {
    if (preset === 'custom' || !fyStart || !fyEnd) return;
    const r = presetRange(preset, fyStart, fyEnd);
    if (r) { setFrom(r[0].format('YYYY-MM-DD')); setTo(r[1].format('YYYY-MM-DD')); }
  }, [preset, fyStart, fyEnd]);

  const buildParams = () => ({
    direction,
    from_date: from,
    to_date:   to,
    limit,
    sort,
    ...(q ? { search: q } : {}),
    ...(excludeCash ? { exclude_cash: 1 } : {}),
  });

  const load = async () => {
    if (!from || !to) return;
    setLoading(true);
    try {
      const { data } = await reportAPI.topParties(buildParams());
      setRows(data?.rows || []);
      setTotals(data?.totals || {});
      setPeriod(data?.period || {});
      setPrev(data?.prev_period || {});
    } catch (err) {
      message.error(err?.response?.data?.error || 'Failed to load report');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(); /* eslint-disable-next-line */ },
    [direction, from, to, limit, sort, q, excludeCash]);

  const exportExcel = async () => {
    if (!rows.length) { message.info('Nothing to export'); return; }
    setExporting(true);
    try {
      const res = await reportAPI.exportTopParties(buildParams());
      const url = window.URL.createObjectURL(new Blob([res.data], {
        type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      }));
      const a = document.createElement('a');
      a.href = url;
      a.download = `top_${isCustomer ? 'customers' : 'suppliers'}_${from}_to_${to}.xlsx`;
      a.click();
      window.URL.revokeObjectURL(url);
    } catch {
      message.error('Export failed');
    } finally {
      setExporting(false);
    }
  };

  const setDirection = (d) => {
    const next = new URLSearchParams(searchParams);
    next.set('direction', d);
    setSearchParams(next, { replace: true });
  };

  const openParty = (id) => {
    nav(`${isCustomer ? '/reports/customer-statement' : '/reports/supplier-statement'}?id=${id}`);
  };

  const columns = useMemo(() => {
    const cols = [
      {
        title: '#', dataIndex: 'rank', width: 48, align: 'center', fixed: 'left',
        render: (v) => <span style={{ color: 'var(--fg-tertiary)', fontVariantNumeric: 'tabular-nums' }}>{v}</span>,
      },
      {
        title: isCustomer ? 'Customer' : 'Supplier', dataIndex: 'party_name',
        width: 210, fixed: 'left',
        render: (v, r) => (
          <div>
            <Tooltip title="Open statement">
              <a onClick={() => openParty(r.party_id)} className="rpt-bill-no" style={{ cursor: 'pointer', fontWeight: 600 }}>
                {v || '—'}
              </a>
            </Tooltip>
            {r.is_cash_counter ? (
              <div style={{ fontSize: 11, color: 'var(--fg-tertiary)', marginTop: 2 }}>
                <span className="rpt-pill type-neutral">counter / walk-in</span>
              </div>
            ) : (r.mobile_1 || r.city) && (
              <div style={{ fontSize: 11, color: 'var(--fg-tertiary)', marginTop: 2 }}>
                {[r.mobile_1, r.city].filter(Boolean).join(' · ')}
              </div>
            )}
          </div>
        ),
      },
      {
        title: isCustomer ? 'Sales' : 'Purchases', dataIndex: 'value', width: 128, align: 'right',
        render: (v) => <span style={{ fontVariantNumeric: 'tabular-nums', fontWeight: 700 }}>{fmtInt(v)}</span>,
      },
      {
        title: '% of total', dataIndex: 'pct_of_total', width: 92, align: 'right',
        render: (v) => <span style={{ fontVariantNumeric: 'tabular-nums', color: 'var(--fg-secondary)' }}>{v}%</span>,
      },
      {
        title: 'Bills', dataIndex: 'bills', width: 70, align: 'right',
        render: (v) => <span style={{ fontVariantNumeric: 'tabular-nums' }}>{v}</span>,
      },
      {
        title: 'Avg bill', dataIndex: 'avg_bill', width: 112, align: 'right',
        render: (v) => <span style={{ fontVariantNumeric: 'tabular-nums' }}>{fmtInt(v)}</span>,
      },
      {
        title: 'Styles', dataIndex: 'styles', width: 78, align: 'right',
        render: (v) => <span style={{ fontVariantNumeric: 'tabular-nums' }}>{fmtN(v)}</span>,
      },
      {
        title: 'Units', dataIndex: 'units', width: 88, align: 'right',
        render: (v) => <span style={{ fontVariantNumeric: 'tabular-nums' }}>{fmtN(v)}</span>,
      },
    ];

    // Gross profit only exists on the sales side.
    if (isCustomer) {
      cols.push(
        {
          title: 'Gross profit', dataIndex: 'gross_profit', width: 126, align: 'right',
          render: (v) => (v == null
            ? <span style={{ color: 'var(--fg-tertiary)' }}>—</span>
            : <span style={{ fontVariantNumeric: 'tabular-nums', fontWeight: 700 }}>{fmtInt(v)}</span>),
        },
        {
          title: 'Margin', dataIndex: 'margin_pct', width: 92, align: 'right',
          render: (v, r) => {
            if (v == null) return <span style={{ color: 'var(--fg-tertiary)' }}>—</span>;
            // Flag rows where a big slice of revenue had no cost on the
            // line — the margin there is computed on a subset and will
            // read better than reality.
            const thin = r.costed_value && r.value
              ? (r.costed_value / r.value) < 0.8 : false;
            const cell = (
              <span style={{
                fontVariantNumeric: 'tabular-nums', fontWeight: 700,
                color: v >= 20 ? 'var(--success)' : v >= 12 ? 'var(--fg-primary)' : 'var(--warning)',
              }}>
                {v}%{thin ? ' *' : ''}
              </span>
            );
            return thin
              ? <Tooltip title={`Only ${fmtInt(r.costed_value)} of ${fmtInt(r.value)} has a recorded cost — margin covers part of the sales`}>{cell}</Tooltip>
              : cell;
          },
        },
      );
    }

    cols.push(
      {
        title: 'Prev period', dataIndex: 'prev_value', width: 122, align: 'right',
        render: (v) => <span style={{ fontVariantNumeric: 'tabular-nums', color: 'var(--fg-secondary)' }}>{fmtInt(v)}</span>,
      },
      {
        title: 'Change', dataIndex: 'change_pct', width: 106, align: 'right',
        render: (v) => <ChangeCell value={v} />,
      },
      {
        title: 'First bill', dataIndex: 'first_bill', width: 106,
        render: (v) => (v ? dayjs(v).format('DD/MM/YY') : '—'),
      },
      {
        title: isCustomer ? 'Last sale' : 'Last purchase', dataIndex: 'last_bill', width: 118,
        render: (v, r) => (
          <div style={{ lineHeight: 1.25 }}>
            <div>{v ? dayjs(v).format('DD/MM/YY') : '—'}</div>
            <div style={{
              fontSize: 10,
              color: r.days_since > 180 ? 'var(--danger)'
                : r.days_since > 90 ? 'var(--warning)' : 'var(--fg-tertiary)',
            }}>
              {r.days_since}d ago
            </div>
          </div>
        ),
      },
      {
        title: 'Balance', dataIndex: 'current_balance', width: 140, align: 'right',
        render: (v) => {
          const n = parseFloat(v || 0);
          if (!n) return <span style={{ color: 'var(--fg-tertiary)' }}>—</span>;
          const youOwe = n < 0;
          return (
            <div style={{ lineHeight: 1.25 }}>
              <span style={{
                fontVariantNumeric: 'tabular-nums', fontWeight: 700,
                color: youOwe ? 'var(--danger)' : 'var(--fg-primary)',
              }}>{fmtInt(Math.abs(n))}</span>
              <div style={{ fontSize: 10, color: 'var(--fg-tertiary)' }}>{youOwe ? 'you owe' : 'owes you'}</div>
            </div>
          );
        },
      },
    );
    return cols;
  }, [isCustomer, nav]);

  const changeTone = totals.change_pct == null ? 'tone-neutral'
    : totals.change_pct >= 0 ? 'tone-success' : 'tone-danger';

  return (
    <div className="report-editorial stf-list" style={{ height: '100%', display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
      {/* ─── HEADER ─── */}
      <div className="rpt-page-hd">
        <div className="rpt-title">
          <h1>{isCustomer ? 'Top Customers' : 'Top Suppliers'}</h1>
          <div className="rpt-sub">
            {period.from ? `${dayjs(period.from).format('DD MMM YY')} – ${dayjs(period.to).format('DD MMM YY')}` : '—'}
            <span className="sep">·</span>
            <b>{totals.parties || 0}</b> {isCustomer ? 'customers' : 'suppliers'}
            {prevPeriod.from && (
              <>
                <span className="sep">·</span>
                vs {dayjs(prevPeriod.from).format('DD MMM YY')} – {dayjs(prevPeriod.to).format('DD MMM YY')}
              </>
            )}
          </div>
        </div>
        <div className="rpt-hd-ctrl">
          <Segmented
            value={direction}
            onChange={setDirection}
            options={[
              { label: 'Customers', value: 'customer' },
              { label: 'Suppliers', value: 'supplier' },
            ]}
          />
          <Button icon={<FileExcelOutlined />} onClick={exportExcel} loading={exporting} className="rpt-btn">Export</Button>
          <Button icon={<ReloadOutlined />} onClick={load} className="rpt-btn">Refresh</Button>
        </div>
      </div>

      {/* ─── KPI STRIP ─── */}
      <div className="rpt-kpis">
        <div className="rpt-kpi tone-accent">
          <div className="rpt-kpi-k">{isCustomer ? 'Total Sales' : 'Total Purchases'}</div>
          <div className="rpt-kpi-v">{fmtL(totals.value)}</div>
          <div style={{ fontSize: 11, color: 'var(--fg-tertiary)', marginTop: 4 }}>
            {fmtN(totals.bills)} bills · avg {fmtInt(totals.avg_bill)}
          </div>
        </div>
        <div className={`rpt-kpi ${changeTone}`}>
          <div className="rpt-kpi-k">vs Previous Period</div>
          <div className="rpt-kpi-v">
            {totals.change_pct == null ? '—' : `${totals.change_pct >= 0 ? '+' : ''}${totals.change_pct}%`}
          </div>
          <div style={{ fontSize: 11, color: 'var(--fg-tertiary)', marginTop: 4 }}>
            was {fmtL(totals.prev_value)}
          </div>
        </div>
        <div className="rpt-kpi tone-warning">
          <div className="rpt-kpi-k">Top 10 Share</div>
          <div className="rpt-kpi-v">{totals.top10_pct || 0}%</div>
          <div style={{ fontSize: 11, color: 'var(--fg-tertiary)', marginTop: 4 }}>
            {fmtL(totals.top10_value)} · top 3 = {totals.top3_pct || 0}%
          </div>
        </div>
        {isCustomer ? (
          <div className="rpt-kpi tone-success">
            <div className="rpt-kpi-k">Gross Profit</div>
            <div className="rpt-kpi-v">{fmtL(totals.gross_profit)}</div>
            <div style={{ fontSize: 11, color: 'var(--fg-tertiary)', marginTop: 4 }}>
              {totals.margin_pct == null ? '—' : `${totals.margin_pct}% margin`}
              {totals.uncosted_value > 0 && ` · ${fmtL(totals.uncosted_value)} uncosted`}
            </div>
          </div>
        ) : (
          <div className="rpt-kpi tone-success">
            <div className="rpt-kpi-k">Suppliers Used</div>
            <div className="rpt-kpi-v">{totals.parties || 0}</div>
            <div style={{ fontSize: 11, color: 'var(--fg-tertiary)', marginTop: 4 }}>
              in the selected period
            </div>
          </div>
        )}
      </div>

      {/* ─── FILTER BAR ─── */}
      <div className="rpt-filter">
        <Input
          ref={searchInputRef}
          className="rpt-search"
          prefix={<SearchOutlined />}
          placeholder={isCustomer ? 'Search customer or mobile' : 'Search supplier or mobile'}
          value={q}
          onChange={(e) => setQ(e.target.value)}
          allowClear
        />
        <span className="rpt-sep" />
        <Select
          value={preset} onChange={setPreset} options={PRESETS}
          style={{ minWidth: 150 }} size="middle"
        />
        <DatePicker.RangePicker
          value={from && to ? [dayjs(from), dayjs(to)] : null}
          onChange={(r) => {
            if (r && r[0] && r[1]) {
              setPreset('custom');
              setFrom(r[0].format('YYYY-MM-DD'));
              setTo(r[1].format('YYYY-MM-DD'));
            }
          }}
          format="DD/MM/YYYY"
          allowClear={false}
          size="middle"
        />
        <span className="rpt-sep" />
        <Tooltip title="Counter/walk-in trade is booked against the built-in Cash party. It counts in the totals by default; turn this on for a named-accounts-only ranking.">
          <button
            className={`rpt-chip ${excludeCash ? 'on' : ''}`}
            onClick={() => setExcludeCash((v) => !v)}
          >
            <span className="rpt-dot tone-neutral" />Exclude counter cash
          </button>
        </Tooltip>
        <span className="rpt-sep" />
        <Select
          value={limit} onChange={setLimit}
          options={[
            { value: 10, label: 'Top 10' },
            { value: 25, label: 'Top 25' },
            { value: 50, label: 'Top 50' },
            { value: 100, label: 'Top 100' },
            { value: 10000, label: 'All' },
          ]}
          style={{ minWidth: 110 }} size="middle"
        />
        <Select
          value={sort} onChange={setSort}
          options={[
            { value: 'value_desc',  label: isCustomer ? 'Highest sales' : 'Highest purchases' },
            ...(isCustomer ? [
              { value: 'gp_desc',     label: 'Highest gross profit' },
              { value: 'margin_desc', label: 'Best margin' },
            ] : [
              { value: 'styles_desc', label: 'Most styles' },
            ]),
            { value: 'bills_desc',  label: 'Most bills' },
            { value: 'growth_desc', label: 'Fastest growing' },
            { value: 'growth_asc',  label: 'Fastest declining' },
            { value: 'stale_desc',  label: 'Longest since last bill' },
            { value: 'name_asc',    label: 'Name (A-Z)' },
          ]}
          style={{ minWidth: 190 }} size="middle"
        />
      </div>

      {/* ─── TABLE ─── */}
      <div className="rpt-tbl-wrap">
        <div className="rpt-tbl report-table-scroll stf-tbl-card">
          <Table
            rowKey="party_id"
            loading={loading}
            dataSource={rows}
            columns={columns}
            pagination={false}
            size="middle"
            scroll={{ x: 1600 }}
            sticky
            locale={{ emptyText: (
              <div style={{ padding: '32px 16px', textAlign: 'center', color: 'var(--fg-tertiary)' }}>
                <TeamOutlined style={{ fontSize: 32, opacity: 0.4 }} />
                <div style={{ marginTop: 8, fontSize: 14, fontWeight: 600, color: 'var(--fg-secondary)' }}>
                  No trade in this period
                </div>
                <div style={{ fontSize: 12 }}>Widen the date range above.</div>
              </div>
            ) }}
          />
          {rows.length > 0 && (
            <div className="stf-tbl-foot">
              <span className="stf-tbl-foot-lbl">
                Showing {rows.length} of {totals.parties} · {fmtL(rows.reduce((s, r) => s + parseFloat(r.value || 0), 0))} of {fmtL(totals.value)}
              </span>
              <span className="stf-tbl-foot-spacer" />
              <span className="stf-tbl-foot-pad" />
            </div>
          )}
        </div>
      </div>

      <ActionStrip
        actions={[
          { id: 'back', key: 'Esc', label: 'Back', onAction: () => nav('/reports') },
          { id: 'find', key: 'F4', label: 'Find', onAction: () => searchInputRef.current?.focus?.() },
          { id: 'refresh', key: 'F5', label: 'Refresh', onAction: () => load() },
          {
            id: 'flip', key: 'F6', label: isCustomer ? 'Suppliers' : 'Customers',
            onAction: () => setDirection(isCustomer ? 'supplier' : 'customer'),
          },
          { id: 'export', key: 'F7', label: 'Export', onAction: () => exportExcel() },
          { id: 'print', key: 'F9', label: 'Print', onAction: () => window.print() },
        ]}
      />
    </div>
  );
}
