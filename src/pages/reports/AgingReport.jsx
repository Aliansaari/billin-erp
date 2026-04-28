/*
 * Aging Report — receivables (from customers) or payables (to suppliers),
 * every open bill bucketed by days overdue.
 *
 * Bucket math lives in the backend util (server/utils/aging.js) and is
 * exhaustively unit-tested. This page is just a thin view on top of the
 * JSON response, with search / bucket filtering / drill-down to individual
 * bills, plus an Excel export that re-uses the same aggregation.
 */

import React, { useEffect, useMemo, useState, useRef } from 'react';
import { message, Spin, Checkbox } from 'antd';
import {
  SearchOutlined, FileExcelOutlined, ReloadOutlined,
  RightOutlined, SettingOutlined, PhoneOutlined,
  WhatsAppOutlined, CheckOutlined, EyeOutlined,
  ThunderboltOutlined, UnorderedListOutlined, FileTextOutlined,
  AppstoreOutlined,
} from '@ant-design/icons';
import { useNavigate } from 'react-router-dom';
import dayjs from 'dayjs';
import { reportAPI } from '../../api';
import './aging-report.css';

/* ──────────────────────────── formatting ───────────────────────────── */

const fmt = (v) =>
  parseFloat(v || 0).toLocaleString('en-IN', {
    minimumFractionDigits: 2, maximumFractionDigits: 2,
  });
const fmtInt = (v) => Math.round(parseFloat(v || 0)).toLocaleString('en-IN');
const fmtDate = (d) => (d ? dayjs(d).format('DD-MM-YYYY') : '—');

/* The five bucket keys and their display order. bucket_labels come from
 * the server so renaming the bounds (30/60/90 → anything else) works
 * automatically without frontend changes. */
const BUCKET_KEYS = ['current', 'b1', 'b2', 'b3', 'b4'];

/* User-configurable display flags — persisted to localStorage. The
 * "Customize" popover toggles these; they control which optional columns
 * and panels render. Kept minimal on purpose: only things a user would
 * actually want to hide (not core data). */
const DISPLAY_KEYS = [
  { k: 'kpis',        label: 'KPI cards (Total, Overdue, Oldest, Action Queue)' },
  { k: 'strip',       label: 'Aging distribution strip (per party, Priority view)' },
  { k: 'context',     label: 'Credit + risk context panel (Priority view)' },
  { k: 'actions',     label: 'Quick actions: Call / WhatsApp / Record / View' },
  { k: 'lastContact', label: 'Status badges (last contact, promises)' },
  { k: 'partyCity',   label: 'City column (party-wise view)' },
  { k: 'partyBills',  label: 'Bills / Oldest columns (party-wise view)' },
  { k: 'billMobile',  label: 'Mobile column (bill-wise view)' },
];
const DEFAULT_DISPLAY = DISPLAY_KEYS.reduce((o, d) => ({ ...o, [d.k]: true }), {});
const DISPLAY_STORAGE_KEY = 'agingReport_display_v1';

/* Priority score — orders the Priority Queue. Larger score = chase first.
 *   base   : √balance  (sub-linear so a ₹10L and ₹50L party don't crush
 *            the list; a big but-not-too-old bill can still rank high)
 *   age    : overdue_days  (longer = worse)
 *   risk   : 1.0 (good) / 1.4 (fair) / 1.8 (poor) — see riskGrade()
 */
function priorityScore(row) {
  const base = Math.sqrt(Math.max(0, row.total));
  const age  = Math.max(1, row.oldest_days);
  const mult = { good: 1.0, fair: 1.4, poor: 1.8 }[riskGrade(row)] || 1.0;
  return base * age * mult;
}

/* Risk grade — coarse signal combining overdue severity and exposure-vs-
 * credit-limit. No-limit parties fall back to overdue-only grading. */
function riskGrade(row) {
  const overLimit = row.credit_limit > 0 && row.total > row.credit_limit;
  if (row.oldest_days > 90 && overLimit) return 'poor';
  if (row.oldest_days > 90)              return 'poor';
  if (row.oldest_days > 60 || overLimit) return 'fair';
  return 'good';
}

export default function AgingReport() {
  const navigate = useNavigate();
  const [partyType, setPartyType] = useState('Customer');
  // Three rendering modes sharing the same JSON payload:
  //   'priority' — prioritized work queue; ranked rows with inline actions
  //   'party'    — one row per party with expandable bill drill-down
  //   'bill'     — flat list of every outstanding bill (Tally-style)
  const [viewMode, setViewMode]   = useState('priority');

  // User-tunable display flags — persisted so the layout someone prefers
  // survives reload (and per-browser, so two users at the same install can
  // each have their own customization).
  const [display, setDisplay] = useState(() => {
    try {
      const saved = JSON.parse(localStorage.getItem(DISPLAY_STORAGE_KEY) || 'null');
      return saved && typeof saved === 'object'
        ? { ...DEFAULT_DISPLAY, ...saved }
        : DEFAULT_DISPLAY;
    } catch { return DEFAULT_DISPLAY; }
  });
  useEffect(() => {
    try { localStorage.setItem(DISPLAY_STORAGE_KEY, JSON.stringify(display)); } catch {}
  }, [display]);
  const [displayOpen, setDisplayOpen] = useState(false);
  const displayBtnRef = useRef(null);
  // Close the popover on outside click / Escape.
  useEffect(() => {
    if (!displayOpen) return;
    const close = (e) => { if (displayBtnRef.current && !displayBtnRef.current.contains(e.target)) setDisplayOpen(false); };
    const esc = (e) => { if (e.key === 'Escape') setDisplayOpen(false); };
    document.addEventListener('click', close);
    document.addEventListener('keydown', esc);
    return () => {
      document.removeEventListener('click', close);
      document.removeEventListener('keydown', esc);
    };
  }, [displayOpen]);
  const [loading, setLoading]     = useState(false);
  const [data, setData]           = useState(null);
  const [search, setSearch]       = useState('');
  const [activeBuckets, setActiveBuckets] = useState(new Set()); // empty = show all
  const [expanded, setExpanded]   = useState(new Set());
  // Bill-wise sort: the party-wise view is always sorted by total desc (math),
  // but bill-wise has multiple useful orderings and the user picks.
  const [billSort, setBillSort]   = useState({ key: 'overdue_days', dir: 'desc' });

  /* ────── load on tab change ────── */
  useEffect(() => {
    loadReport();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [partyType]);

  const loadReport = async () => {
    setLoading(true);
    try {
      const { data: res } = await reportAPI.getAging({ party_type: partyType });
      setData(res);
      setExpanded(new Set());
    } catch (e) {
      message.error('Failed to load aging report');
      setData(null);
    }
    setLoading(false);
  };

  const handleExport = async () => {
    try {
      const res = await reportAPI.exportAging({ party_type: partyType });
      const blob = new Blob([res.data], {
        type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      });
      const url = window.URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `aging_${partyType.toLowerCase()}_${dayjs().format('YYYY-MM-DD')}.xlsx`;
      a.click();
      window.URL.revokeObjectURL(url);
    } catch {
      message.error('Export failed');
    }
  };

  /* ────── derived: filtered rows + bucket counts ────── */

  const rows = data?.rows || [];
  const grand = data?.grand || { total: 0, current: 0, b1: 0, b2: 0, b3: 0, b4: 0 };
  const labels = data?.bucket_labels || {
    current: 'Not Due', b1: '1–30', b2: '31–60', b3: '61–90', b4: '90+',
  };

  const bucketCounts = useMemo(() => {
    const c = { current: 0, b1: 0, b2: 0, b3: 0, b4: 0 };
    rows.forEach(r => BUCKET_KEYS.forEach(k => { if (r[k] > 0) c[k]++; }));
    return c;
  }, [rows]);

  const visibleRows = useMemo(() => {
    const q = search.trim().toLowerCase();
    return rows.filter(r => {
      // Search filter
      if (q && !(
        (r.party_name || '').toLowerCase().includes(q) ||
        (r.mobile_1 || '').includes(q) ||
        (r.city || '').toLowerCase().includes(q)
      )) return false;
      // Bucket filter — show parties that have ANY amount in the active buckets
      if (activeBuckets.size > 0) {
        const hasActive = Array.from(activeBuckets).some(k => r[k] > 0);
        if (!hasActive) return false;
      }
      return true;
    });
  }, [rows, search, activeBuckets]);

  /* Sum of the visible rows' totals — what the user actually sees at the
   * foot, independent of global grand. Useful when filtering. */
  const visibleTotals = useMemo(() => {
    return visibleRows.reduce(
      (g, r) => ({
        total:   g.total   + r.total,
        current: g.current + r.current,
        b1:      g.b1      + r.b1,
        b2:      g.b2      + r.b2,
        b3:      g.b3      + r.b3,
        b4:      g.b4      + r.b4,
      }),
      { total: 0, current: 0, b1: 0, b2: 0, b3: 0, b4: 0 }
    );
  }, [visibleRows]);

  /* Priority Queue rows — the filtered party list, re-sorted by the
   * priority score and decorated with each row's score + rank so the
   * view can render "1 · 2 · 3…" badges without a second pass. */
  const priorityRows = useMemo(() => {
    const out = visibleRows.map(r => ({
      ...r,
      _risk: riskGrade(r),
      _score: priorityScore(r),
    }));
    out.sort((a, b) => b._score - a._score);
    return out;
  }, [visibleRows]);

  /* Bill-wise flat list — one row per outstanding bill, with party info
   * inlined so the table is readable without expanding. Filters run on the
   * flat bill (by bucket + search on party/mobile/bill_number) so the
   * totals row reflects exactly what the user sees. */
  const flatBills = useMemo(() => {
    if (!data?.rows) return [];
    const q = search.trim().toLowerCase();
    const out = [];
    for (const r of data.rows) {
      for (const b of r.bills) {
        if (activeBuckets.size > 0 && !activeBuckets.has(b.bucket)) continue;
        if (q && !(
          (r.party_name || '').toLowerCase().includes(q) ||
          (r.mobile_1 || '').includes(q) ||
          (r.city || '').toLowerCase().includes(q) ||
          (b.bill_number || '').toLowerCase().includes(q)
        )) continue;
        out.push({ ...b, party_id: r.party_id, party_name: r.party_name,
                   mobile_1: r.mobile_1, city: r.city });
      }
    }
    // Sort
    const { key, dir } = billSort;
    const mul = dir === 'asc' ? 1 : -1;
    out.sort((a, b) => {
      const av = a[key], bv = b[key];
      if (typeof av === 'string') return av.localeCompare(bv) * mul;
      return ((av || 0) - (bv || 0)) * mul;
    });
    return out;
  }, [data, search, activeBuckets, billSort]);

  const billTotals = useMemo(() => {
    return flatBills.reduce((a, b) => {
      a.total   += b.balance_amount;
      a.count   += 1;
      a[b.bucket] = (a[b.bucket] || 0) + b.balance_amount;
      return a;
    }, { total: 0, count: 0, current: 0, b1: 0, b2: 0, b3: 0, b4: 0 });
  }, [flatBills]);

  const toggleBillSort = (key) => {
    setBillSort(prev => prev.key === key
      ? { key, dir: prev.dir === 'asc' ? 'desc' : 'asc' }
      : { key, dir: 'desc' });
  };
  const sortIndicator = (key) => billSort.key === key
    ? (billSort.dir === 'asc' ? ' ▲' : ' ▼') : '';

  /* KPI derivations — computed from grand totals (not visible) so the
   * numbers don't flicker on every search keystroke. */
  const kpi = useMemo(() => {
    const overdue = grand.b1 + grand.b2 + grand.b3 + grand.b4;
    const pctOverdue = grand.total > 0 ? (overdue / grand.total * 100) : 0;
    const parties = rows.length;
    const oldestDays = rows.reduce((m, r) => Math.max(m, r.oldest_days || 0), 0);
    return { total: grand.total, overdue, pctOverdue, parties, oldestDays };
  }, [grand, rows]);

  /* ────── interactions ────── */

  const toggleBucket = (k) => {
    setActiveBuckets(prev => {
      const next = new Set(prev);
      next.has(k) ? next.delete(k) : next.add(k);
      return next;
    });
  };

  const toggleExpanded = (pid) => {
    setExpanded(prev => {
      const next = new Set(prev);
      next.has(pid) ? next.delete(pid) : next.add(pid);
      return next;
    });
  };

  /* ────── render ────── */

  const isCustomer = partyType === 'Customer';
  const partyCol = isCustomer ? 'Customer' : 'Supplier';
  const title = isCustomer ? 'Receivables Aging' : 'Payables Aging';
  const asOfLabel = data?.as_of_date ? dayjs(data.as_of_date).format('DD MMM YYYY') : dayjs().format('DD MMM YYYY');

  return (
    <div className="ar-page">
      {/* Header */}
      <div className="ar-hd">
        <div className="ar-title">
          <h1>{title}</h1>
        </div>

        <div className="ar-tabs" role="tablist">
          <button
            role="tab"
            className={`ar-tab ${isCustomer ? 'active' : ''}`}
            onClick={() => setPartyType('Customer')}
          >Receivables</button>
          <button
            role="tab"
            className={`ar-tab ${!isCustomer ? 'active' : ''}`}
            onClick={() => setPartyType('Supplier')}
          >Payables</button>
        </div>

        <div className="ar-hd-actions">
          <div className="ar-customize" ref={displayBtnRef}>
            <button
              className={`ar-btn ${displayOpen ? 'active' : ''}`}
              onClick={(e) => { e.stopPropagation(); setDisplayOpen(o => !o); }}
              title="Customize what to see"
            >
              <SettingOutlined /> Customize
            </button>
            {displayOpen && (
              <div className="ar-customize-pop" onClick={(e) => e.stopPropagation()}>
                <div className="ar-customize-hd">
                  <span>Show on this page</span>
                  <button
                    className="ar-link-btn"
                    onClick={() => setDisplay(DEFAULT_DISPLAY)}
                  >Reset</button>
                </div>
                <div className="ar-customize-list">
                  {DISPLAY_KEYS.map(d => (
                    <label key={d.k} className="ar-customize-row">
                      <Checkbox
                        checked={!!display[d.k]}
                        onChange={(e) => setDisplay(s => ({ ...s, [d.k]: e.target.checked }))}
                      />
                      <span>{d.label}</span>
                    </label>
                  ))}
                </div>
                <div className="ar-customize-ft">
                  Preferences saved for this browser.
                </div>
              </div>
            )}
          </div>
          <button className="ar-btn" onClick={loadReport} title="Refresh">
            <ReloadOutlined /> Refresh
          </button>
          <button className="ar-btn primary" onClick={handleExport} title="Download Excel">
            <FileExcelOutlined /> Excel
          </button>
        </div>
      </div>

      {/* Ledger reconciliation — fires only when the ledger doesn't
          match the bill side after accounting for the four legitimate
          gaps (paid-in-bills, unallocated receipts, returns, openings).
          The banner shows the formula so any future drift is
          diagnosable from the screen. Pre-Phase R5 this banner showed
          ₹19,320 (receivables) / ₹15,500 (payables) drift on seeded
          data — now balanced paisa-exact. */}
      {data?.reconciliation && !data.reconciliation.balanced && (() => {
        const r = data.reconciliation;
        return (
          <div className="ar-recon-banner">
            <div className="ar-recon-title">
              {isCustomer ? 'Receivables' : 'Payables'} ledger does not reconcile to bills
            </div>
            <div className="ar-recon-formula">
              bill ₹{fmt(r.bill_outstanding)}
              {' + paid '}₹{fmt(r.paid_in_bills)}
              {' − receipts '}₹{fmt(r.unallocated_receipts)}
              {' − returns '}₹{fmt(r.returns_offset)}
              {' + opening Dr '}₹{fmt(r.opening_dr)}
              {' − opening Cr '}₹{fmt(r.opening_cr)}
              {' = expected '}<b>₹{fmt(r.expected_ledger_outstanding)}</b>
              {' vs ledger '}<b>₹{fmt(r.ledger_outstanding)}</b>
              {' → diff '}<b style={{ color: '#ff4d4f' }}>₹{fmt(r.difference)}</b>
            </div>
          </div>
        );
      })()}

      {/* KPIs (toggle via Customize). Four themed cards mirroring the
          mockup: Total (with bucket distribution bar), Overdue (red),
          Oldest Overdue (amber), Action Queue Today (indigo CTA). */}
      {display.kpis && (() => {
        // Derive bucket split as percentages of the grand total for the
        // mini distribution bar. If grand.total is 0 each segment is 0%.
        const pct = (v) => grand.total > 0 ? (v / grand.total * 100) : 0;
        const bucketPcts = {
          current: pct(grand.current),
          b1:      pct(grand.b1),
          b2:      pct(grand.b2),
          b3:      pct(grand.b3),
          b4:      pct(grand.b4),
        };
        // Action Queue Today = top-5 overdue parties by priority; the
        // "estimated collectable" heuristic is 40% of their total balance
        // (reasonable collection rate in the 1-month window).
        const top5 = priorityRows.slice(0, 5);
        const actionCount = Math.min(top5.length, priorityRows.length);
        const actionSum = top5.reduce((a, r) => a + r.total, 0);
        const actionEst = actionSum * 0.4;

        return (
          <div className="ar-kpis">
            {/* ── Total Outstanding ── with bucket distribution bar */}
            <div className="ar-kpi tot">
              <span className="k">Total Outstanding</span>
              <span className="v">₹ {fmtInt(kpi.total)}</span>
              <span className="sub">
                <b>{kpi.parties}</b> {partyCol.toLowerCase()}{kpi.parties !== 1 ? 's' : ''}
                {' · '}<b>{priorityRows.reduce((a, r) => a + r.bill_count, 0)}</b> bills
              </span>
              <div className="ar-kpi-bar" title="Distribution across buckets">
                <span style={{ width: `${bucketPcts.current}%`, background: '#10b981' }} />
                <span style={{ width: `${bucketPcts.b1}%`,      background: '#84cc16' }} />
                <span style={{ width: `${bucketPcts.b2}%`,      background: '#f59e0b' }} />
                <span style={{ width: `${bucketPcts.b3}%`,      background: '#f97316' }} />
                <span style={{ width: `${bucketPcts.b4}%`,      background: '#dc2626' }} />
              </div>
              <div className="ar-kpi-legend">
                <span><i style={{ background: '#10b981' }} />{bucketPcts.current.toFixed(1)}%</span>
                <span><i style={{ background: '#84cc16' }} />{bucketPcts.b1.toFixed(1)}%</span>
                <span><i style={{ background: '#f59e0b' }} />{bucketPcts.b2.toFixed(1)}%</span>
                <span><i style={{ background: '#f97316' }} />{bucketPcts.b3.toFixed(1)}%</span>
                <span><i style={{ background: '#dc2626' }} />{bucketPcts.b4.toFixed(1)}%</span>
              </div>
            </div>

            {/* ── Overdue ── red card */}
            <div className="ar-kpi due">
              <span className="k">Overdue</span>
              <span className="v">₹ {fmtInt(kpi.overdue)}</span>
              <span className="sub">
                {kpi.pctOverdue.toFixed(1)}% of total
                {grand.b4 > 0 && <> · <b>₹ {fmtInt(grand.b4)}</b> over {data?.buckets?.b3 ?? 90} days</>}
              </span>
            </div>

            {/* ── Action Queue Today ── indigo card with CTA */}
            <div className="ar-kpi today" onClick={() => setViewMode('priority')}>
              <span className="k">Action Queue Today</span>
              <span className="v">{actionCount} {actionCount === 1 ? 'party' : 'parties'}</span>
              <span className="sub">Est. collectable <b>₹ {fmtInt(actionEst)}</b></span>
              <span className="ar-kpi-cta">Open Queue <RightOutlined style={{ fontSize: 10 }} /></span>
            </div>
          </div>
        );
      })()}

      {/* View tabs — dedicated row below KPIs, with Sort on the right */}
      <div className="ar-viewbar">
        <div className="ar-tabs" role="tablist" title="View mode">
          <button
            role="tab"
            className={`ar-tab ${viewMode === 'priority' ? 'active' : ''}`}
            onClick={() => setViewMode('priority')}
          ><ThunderboltOutlined /> Priority Queue</button>
          <button
            role="tab"
            className={`ar-tab ${viewMode === 'party' ? 'active' : ''}`}
            onClick={() => setViewMode('party')}
          ><AppstoreOutlined /> Party-wise</button>
          <button
            role="tab"
            className={`ar-tab ${viewMode === 'bill' ? 'active' : ''}`}
            onClick={() => setViewMode('bill')}
          ><FileTextOutlined /> Bill-wise</button>
        </div>
      </div>

      {/* Filters */}
      <div className="ar-filters">
        <div className="ar-search">
          <SearchOutlined style={{ color: 'var(--fg-tertiary)' }} />
          <input
            placeholder={`Search ${partyCol.toLowerCase()}, mobile, city…`}
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>
        {BUCKET_KEYS.map(k => (
          <button
            key={k}
            className={`ar-chip ${activeBuckets.has(k) ? 'on' : ''}`}
            onClick={() => toggleBucket(k)}
            title={`Filter: parties with amount in ${labels[k]}`}
          >
            <span className={`ar-dot ${k}`} />
            {labels[k]}
            <span className="n">{bucketCounts[k]}</span>
          </button>
        ))}
        {activeBuckets.size > 0 && (
          <button className="ar-chip" onClick={() => setActiveBuckets(new Set())}>
            Clear
          </button>
        )}
      </div>

      {/* Table */}
      <div className="ar-wrap">
        <div className="ar-scroll">
          {loading ? (
            <div className="ar-empty"><Spin /></div>
          ) : viewMode === 'priority' ? (
            /* ── Priority Queue — ranked collections worklist ── */
            priorityRows.length === 0 ? (
              <div className="ar-empty">
                <div className="big">
                  {rows.length === 0
                    ? (isCustomer ? 'No outstanding receivables' : 'No outstanding payables')
                    : 'No parties match the filter'}
                </div>
              </div>
            ) : (
              <div className="ar-pq-panel">
                <div className="ar-pq-panel-hd">
                  <div className="ar-pq-panel-title">
                    Priority Queue
                    <span className="ar-pq-panel-pill">Sorted by risk score</span>
                  </div>
                  <div className="ar-pq-panel-hdr">
                    <span className="ar-pq-panel-help">
                      Showing {priorityRows.length} of {rows.length}
                      {' · '}score = overdue × √balance × risk
                    </span>
                    {priorityRows.some(r => r.mobile_1) && (
                      <button
                        className="ar-pq-bulk"
                        onClick={() => {
                          const names = priorityRows.slice(0, 5).map(r => r.party_name).join(', ');
                          message.info(`Draft reminder prepared for top-5 ${isCustomer ? 'customers' : 'suppliers'}: ${names}…`);
                        }}
                        title="Draft WhatsApp reminders for the top-ranked parties"
                      >
                        <WhatsAppOutlined /> Bulk WhatsApp
                      </button>
                    )}
                  </div>
                </div>
                <div className="ar-pq">
                {priorityRows.map((r, i) => {
                  const stripSegments = BUCKET_KEYS
                    .filter(k => r[k] > 0)
                    .map(k => ({
                      key: k,
                      pct: r.total > 0 ? (r[k] / r.total) * 100 : 0,
                      label: labels[k],
                      amt: r[k],
                    }));
                  const riskLabel = r._risk[0].toUpperCase() + r._risk.slice(1);
                  const overLimit = r.credit_limit > 0 && r.total > r.credit_limit;
                  const overdueTotal = +(r.b1 + r.b2 + r.b3 + r.b4).toFixed(2);
                  const over90 = r.b4;
                  const phone = (r.mobile_1 || '').replace(/\D/g, '');
                  const waNumber = phone.length === 10 ? `91${phone}` : phone;

                  return (
                    <div
                      key={r.party_id}
                      className={`ar-pq-row ${expanded.has(r.party_id) ? 'expanded' : ''}`}
                      onClick={() => toggleExpanded(r.party_id)}
                    >
                      <div className={`ar-pq-rank rank-${Math.min(i + 1, 5)}`}>
                        {i + 1}
                        {i === 0 && r._risk === 'poor' && <span className="ar-hot-tag">HOT</span>}
                      </div>

                      <div className="ar-pq-party">
                        <div className="ar-pq-name">{r.party_name}</div>
                        <div className="ar-pq-meta">
                          {r.mobile_1 && <span className="ar-mobile-chip">{r.mobile_1}</span>}
                          {r.city && <><span className="sep">·</span><span>{r.city}{r.state ? `, ${r.state}` : ''}</span></>}
                          <span className="sep">·</span>
                          <span>{r.bill_count} {r.bill_count === 1 ? 'bill' : 'bills'}</span>
                          <span className="sep">·</span>
                          <span>Oldest <b className={r.oldest_days > (data?.buckets?.b3 ?? 90) ? 'ar-danger' : ''}>{r.oldest_days}d</b></span>
                        </div>
                        {display.lastContact && overLimit && (
                          <div className="ar-pq-badges">
                            <span className="ar-pq-note stale">
                              Over credit limit (₹{fmtInt(r.credit_limit)})
                            </span>
                          </div>
                        )}
                      </div>

                      {display.strip && (
                        <div className="ar-pq-strip-wrap">
                          <div className="ar-pq-strip-lbl">Aging Distribution</div>
                          <div className="ar-pq-strip">
                            {stripSegments.map(seg => (
                              <span
                                key={seg.key}
                                className={`ar-pq-seg seg-${seg.key}`}
                                style={{ width: `${seg.pct}%` }}
                                title={`${seg.label}: ₹${fmt(seg.amt)}`}
                              >
                                {seg.pct >= 10 ? `${Math.round(seg.pct)}%` : ''}
                              </span>
                            ))}
                          </div>
                        </div>
                      )}

                      {display.context && (
                        <div className="ar-pq-ctx">
                          <div className="ar-pq-ctx-row">
                            <span className="k">Credit limit</span>
                            <span className="v">{r.credit_limit > 0 ? `₹ ${fmtInt(r.credit_limit)}` : '—'}</span>
                          </div>
                          <div className="ar-pq-ctx-row">
                            <span className="k">Credit days</span>
                            <span className="v">{r.credit_days || 0} d</span>
                          </div>
                          <div className="ar-pq-ctx-row">
                            <span className="k">Risk</span>
                            <span className={`ar-pq-risk ${r._risk}`}>● {riskLabel}</span>
                          </div>
                        </div>
                      )}

                      <div className="ar-pq-right">
                        <div className="ar-pq-total">
                          <span className="cur">₹</span>{fmtInt(r.total)}
                        </div>
                        <div className="ar-pq-total-sub">
                          {over90 > 0 ? <>of which <b className="ar-danger">₹{fmtInt(over90)}</b> {labels.b4}</>
                                     : <>Overdue <b>₹{fmtInt(overdueTotal)}</b></>}
                        </div>
                        {display.actions && (
                          <div className="ar-pq-actions" onClick={(e) => e.stopPropagation()}>
                            {phone && (
                              <a className="ar-pq-act call" href={`tel:${phone}`} title="Call">
                                <PhoneOutlined />
                              </a>
                            )}
                            {phone && (
                              <a className="ar-pq-act wa" target="_blank" rel="noopener noreferrer"
                                 href={`https://wa.me/${waNumber}?text=${encodeURIComponent(
                                   `Hi ${r.party_name}, this is a gentle reminder — your outstanding balance is ₹ ${fmtInt(r.total)}. Please let us know when we can expect payment. Thanks!`
                                 )}`}
                                 title="WhatsApp">
                                <WhatsAppOutlined />
                              </a>
                            )}
                            <button
                              className="ar-pq-act record"
                              title="Record payment"
                              onClick={() => navigate(
                                isCustomer
                                  ? `/receipt/new?party_id=${r.party_id}`
                                  : `/payment/new?party_id=${r.party_id}`
                              )}
                            ><CheckOutlined /></button>
                            <button
                              className="ar-pq-act"
                              title="Expand bills"
                              onClick={() => toggleExpanded(r.party_id)}
                            ><EyeOutlined /></button>
                          </div>
                        )}
                      </div>

                      {expanded.has(r.party_id) && (
                        <div className="ar-pq-bills">
                          <div className="ar-pq-bills-hd">
                            <span>Bill No.</span>
                            <span>Date</span>
                            <span>Due</span>
                            <span>Overdue</span>
                            <span>Bucket</span>
                            <span>Balance</span>
                          </div>
                          {r.bills.map(b => (
                            <div key={b.bill_id} className="ar-pq-bill">
                              <span className="ar-bill-no">{b.bill_number}</span>
                              <span>{fmtDate(b.bill_date)}</span>
                              <span>{fmtDate(b.due_date)}</span>
                              <span>{b.overdue_days} d</span>
                              <span><span className={`ar-dot ${b.bucket}`} /> {labels[b.bucket]}</span>
                              <span className="ar-amt-total">₹ {fmt(b.balance_amount)}</span>
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  );
                })}
                </div>
                <div className="ar-pq-panel-ft">
                  <span>Parties shown<b>{priorityRows.length} of {rows.length}</b></span>
                  <span>Overdue bills<b>
                    {priorityRows.reduce((a, r) => a + r.bills.filter(b => b.bucket !== 'current').length, 0)}
                  </b></span>
                  {priorityRows.length >= 5 && (
                    <span>Top-5 share<b>
                      {(priorityRows.slice(0, 5).reduce((a, r) => a + r.total, 0) / Math.max(1, priorityRows.reduce((a, r) => a + r.total, 0)) * 100).toFixed(1)}%
                    </b></span>
                  )}
                  <span className="grand">Priority sum<b>₹ {fmtInt(priorityRows.reduce((a, r) => a + r.total, 0))}</b></span>
                </div>
              </div>
            )
          ) : viewMode === 'party' ? (
            visibleRows.length === 0 ? (
              <div className="ar-empty">
                <div className="big">
                  {rows.length === 0
                    ? (isCustomer ? 'No outstanding receivables' : 'No outstanding payables')
                    : 'No parties match the filter'}
                </div>
                {rows.length === 0 && (
                  <div>Every {partyCol.toLowerCase()} is settled as of {asOfLabel}.</div>
                )}
              </div>
            ) : (
              <table className="ar-tbl">
                <thead>
                  <tr>
                    <th>{partyCol}</th>
                    <th>Mobile</th>
                    {display.partyCity && <th>City</th>}
                    {display.partyBills && <th>Bills</th>}
                    {display.partyBills && <th>Oldest</th>}
                    <th>{labels.current}</th>
                    <th>{labels.b1}</th>
                    <th>{labels.b2}</th>
                    <th>{labels.b3}</th>
                    <th>{labels.b4}</th>
                    <th>Total</th>
                  </tr>
                </thead>
                <tbody>
                  {visibleRows.map(r => (
                    <React.Fragment key={r.party_id}>
                      <tr
                        className={`party-row ar-party-row ${expanded.has(r.party_id) ? 'expanded' : ''}`}
                        onClick={() => toggleExpanded(r.party_id)}
                      >
                        <td>
                          <span className="ar-party-name">
                            <span className="ar-expand-ico"><RightOutlined style={{ fontSize: 10 }} /></span>
                            {r.party_name}
                          </span>
                        </td>
                        <td><span className="ar-mobile-chip">{r.mobile_1 || '—'}</span></td>
                        {display.partyCity && <td>{r.city || '—'}</td>}
                        {display.partyBills && <td>{r.bill_count}</td>}
                        {display.partyBills && <td>{r.oldest_days} d</td>}
                        {BUCKET_KEYS.map(k => (
                          <td key={k} className={`ar-amt ${k} ${r[k] === 0 ? 'ar-amt-zero' : ''}`}>
                            {r[k] === 0 ? '—' : fmt(r[k])}
                          </td>
                        ))}
                        <td className="ar-amt-total">{fmt(r.total)}</td>
                      </tr>

                      {expanded.has(r.party_id) && r.bills.map(b => (
                        /* Expanded bill row — one cell per column so values
                         * stay aligned with the header. Balance is placed
                         * ONLY in the matching bucket column (Tally style),
                         * with the total replicated in the Total column. */
                        <tr key={`${r.party_id}-${b.bill_id}`} className="ar-bill-row">
                          <td>
                            <span className="ar-bill-no">{b.bill_number}</span>
                            &nbsp;·&nbsp; {fmtDate(b.bill_date)}
                          </td>
                          <td className="ar-bill-row-meta">{b.due_date ? `due ${fmtDate(b.due_date)}` : '—'}</td>
                          {display.partyCity && <td></td>}
                          {display.partyBills && <td></td>}
                          {display.partyBills && <td className="ar-bill-row-meta">{b.overdue_days} d</td>}
                          {BUCKET_KEYS.map(k => (
                            <td key={k} className={`ar-amt ${k} ${b.bucket !== k ? 'ar-amt-zero' : ''}`}>
                              {b.bucket === k ? fmt(b.balance_amount) : ''}
                            </td>
                          ))}
                          <td className="ar-amt-total">{fmt(b.balance_amount)}</td>
                        </tr>
                      ))}
                    </React.Fragment>
                  ))}
                </tbody>
                <tfoot>
                  <tr className="ar-bill-total-row">
                    <td colSpan={
                      2
                      + (display.partyCity ? 1 : 0)
                      + (display.partyBills ? 2 : 0)
                    } style={{textAlign:'right', fontWeight: 600, color: 'var(--fg-secondary)'}}>
                      {visibleRows.length} {visibleRows.length === 1 ? 'party' : 'parties'}
                    </td>
                    {BUCKET_KEYS.map(k => (
                      <td key={k} className={`ar-amt ${k}`}>
                        {visibleTotals[k] > 0 ? fmt(visibleTotals[k]) : ''}
                      </td>
                    ))}
                    <td className="ar-amt-total">{fmt(visibleTotals.total)}</td>
                  </tr>
                </tfoot>
              </table>
            )
          ) : (
            /* ── Bill-wise view ── Tally Prime style. One row per open bill,
                 the pending amount appears in the appropriate bucket column
                 (and ONLY there) so each row "lights up" exactly one bucket.
                 Columns match Tally's Bills Receivable / Payable layout. ── */
            flatBills.length === 0 ? (
              <div className="ar-empty">
                <div className="big">
                  {rows.length === 0
                    ? (isCustomer ? 'No outstanding receivables' : 'No outstanding payables')
                    : 'No bills match the filter'}
                </div>
              </div>
            ) : (
              <table className="ar-tbl ar-tbl-bills">
                <thead>
                  <tr>
                    <th className="ar-rownum">#</th>
                    <th style={{cursor:'pointer'}} onClick={() => toggleBillSort('bill_date')}>Date{sortIndicator('bill_date')}</th>
                    <th style={{cursor:'pointer'}} onClick={() => toggleBillSort('bill_number')}>Ref. No.{sortIndicator('bill_number')}</th>
                    <th style={{cursor:'pointer'}} onClick={() => toggleBillSort('party_name')}>{isCustomer ? "Party's Name" : "Supplier's Name"}{sortIndicator('party_name')}</th>
                    {display.billMobile && (
                      <th style={{cursor:'pointer'}} onClick={() => toggleBillSort('mobile_1')}>Mobile{sortIndicator('mobile_1')}</th>
                    )}
                    <th style={{cursor:'pointer'}} onClick={() => toggleBillSort('balance_amount')}>Pending Amount{sortIndicator('balance_amount')}</th>
                    <th>{labels.current}</th>
                    <th>{labels.b1}</th>
                    <th>{labels.b2}</th>
                    <th>{labels.b3}</th>
                    <th>{labels.b4}</th>
                    <th style={{cursor:'pointer'}} onClick={() => toggleBillSort('due_date')}>Due On{sortIndicator('due_date')}</th>
                  </tr>
                </thead>
                <tbody>
                  {flatBills.map((b, i) => (
                    <tr key={`${b.party_id}-${b.bill_id}`}>
                      <td className="ar-rownum">{i + 1}</td>
                      <td>{fmtDate(b.bill_date)}</td>
                      <td><span className="ar-bill-no">{b.bill_number}</span></td>
                      <td>{b.party_name}</td>
                      {display.billMobile && (
                        <td><span className="ar-mobile-chip">{b.mobile_1 || '—'}</span></td>
                      )}
                      <td className="ar-amt-total">{fmt(b.balance_amount)}</td>
                      {BUCKET_KEYS.map(k => (
                        <td key={k} className={`ar-amt ${k} ${b.bucket !== k ? 'ar-amt-zero' : ''}`}>
                          {b.bucket === k ? fmt(b.balance_amount) : ''}
                        </td>
                      ))}
                      <td>{fmtDate(b.due_date)}</td>
                    </tr>
                  ))}
                </tbody>
                <tfoot>
                  <tr className="ar-bill-total-row">
                    <td colSpan={4 + (display.billMobile ? 1 : 0)} style={{textAlign:'right', fontWeight: 600, color: 'var(--fg-secondary)'}}>
                      {billTotals.count} bills
                    </td>
                    <td className="ar-amt-total">{fmt(billTotals.total)}</td>
                    {BUCKET_KEYS.map(k => (
                      <td key={k} className={`ar-amt ${k}`}>
                        {billTotals[k] > 0 ? fmt(billTotals[k]) : ''}
                      </td>
                    ))}
                    <td></td>
                  </tr>
                </tfoot>
              </table>
            )
          )}
        </div>

        {/* Footer totals — party-wise shows bucket split, bill-wise shows count + total */}
        {/* Party-wise now uses an in-table tfoot (aligned with bucket
            columns, same pattern as bill-wise). No separate footer strip. */}
        {/* Bill-wise mode puts totals in a tfoot row so they align under their
            bucket columns (Tally-style). No separate footer strip needed. */}
      </div>
    </div>
  );
}
