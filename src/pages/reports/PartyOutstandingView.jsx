// ── PartyOutstandingView ────────────────────────────────────────────
//
// Party-grouped sibling of the bill-level view in BillsOutstanding.
// Renders one row per party (Customer / Supplier) — name + total
// outstanding + bill count — with a chevron that expands inline to
// show that party's individual bills. Same pattern Trial Balance and
// Balance Sheet use for primary-group expansion, so the report
// family reads as one app.
//
// Data flow
//   • Calls the same /api/reports/bills-receivable | bills-payable
//     endpoint as the bill-view, with a high `limit` so every bill
//     comes back in one shot (no virtualization). 10 000 is plenty
//     for any real firm — a hundred thousand open bills is a books-
//     are-broken signal, not a UX target.
//   • Aggregates by party_id client-side: total = Σ outstanding,
//     count = bills.length. Sum-of-rows matches the API summary
//     because both come from the same source.
//   • Drill targets mirror the bill-level view (bill row → edit
//     page; party-name link in expanded section → Customer or
//     Supplier Statement).
//
// Why a separate component instead of bolting onto BillsOutstanding?
//   The bill-view uses VirtualReportTable for O(viewport) DOM rows;
//   the party-view needs a markedly different table structure
//   (collapsible groups, computed totals, per-row chevron). Mixing
//   both into one renderer would tangle two layout models. Keep them
//   parallel; BillsOutstanding picks which to show via viewMode.

import React, { useEffect, useMemo, useRef, useState, useCallback } from 'react';
import { Spin, Empty, Tooltip, message } from 'antd';
import { useNavigate } from 'react-router-dom';
import dayjs from 'dayjs';

const fmt = (v) =>
  parseFloat(v || 0).toLocaleString('en-IN', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });

// Tally Dr/Cr suffix. For Receivable view the customer typically owes
// us (Dr); for Payable view we typically owe the supplier (Cr). The
// Outstanding column on the API is unsigned — we just label per side.
const sideSuffix = (side) => (side === 'receivable' ? 'Dr' : 'Cr');

export default function PartyOutstandingView({
  cfg,            // SIDE config from BillsOutstanding (title / partyLabel / fetcher / billRoute / receiptRoute)
  side,           // 'receivable' | 'payable'
  filters,        // current filter object (from parent)
  asOf,           // current as-of date (already in filters but parent surfaces it for the empty-state)
  bucketLabels,   // { current, b1, b2, b3, b4 } — surfaced for "X overdue" hint per party
  onDrillBill,    // (row) => void  (parent's handler — keeps drill behavior identical to bill-view)
}) {
  const navigate = useNavigate();
  const [rows, setRows]       = useState([]);   // raw bill-level rows from API
  const [loading, setLoading] = useState(false);
  const [expanded, setExpanded] = useState(() => new Set());   // party_ids currently expanded

  // Single-shot fetch — load every matching bill, aggregate locally.
  // The hook-driven virtualization in BillsOutstanding's bill-view
  // doesn't suit us here because aggregating needs the full set.
  useEffect(() => {
    let stale = false;
    setLoading(true);
    cfg.fetcher({ ...filters, limit: 10000, offset: 0 })
      .then(res => {
        if (stale) return;
        // The API returns either { data: [...] } or just [...]. Older
        // builds returned the array directly; the report router was
        // recently normalised to the wrapped shape, but tolerate both.
        const list = Array.isArray(res.data) ? res.data : (res.data?.data || []);
        setRows(list);
      })
      .catch(err => {
        if (stale) return;
        message.error(err?.response?.data?.error || `Failed to load ${cfg.title}.`);
        setRows([]);
      })
      .finally(() => { if (!stale) setLoading(false); });
    return () => { stale = true; };
  }, [cfg, filters]);

  // Group bills by party_id. Each group keeps every bill so the
  // expand-action can render rows directly without re-querying.
  const groups = useMemo(() => {
    const map = new Map();
    for (const r of rows) {
      const key = r.party_id ?? `cash:${r.party_name || ''}`;
      if (!map.has(key)) {
        map.set(key, {
          party_id:    r.party_id,
          party_name:  r.party_name || '—',
          party_city:  r.party_city || '',
          party_mobile:r.party_mobile || '',
          total:       0,
          bills:       [],
          overdue:     0,             // overdue total, for the per-row hint
          oldestDays:  0,
        });
      }
      const g = map.get(key);
      g.total      += parseFloat(r.outstanding) || 0;
      const od     = parseInt(r.overdue_days || 0, 10);
      if (od > 0) g.overdue += parseFloat(r.outstanding) || 0;
      if (od > g.oldestDays) g.oldestDays = od;
      g.bills.push(r);
    }
    return [...map.values()].sort((a, b) => b.total - a.total);
  }, [rows]);

  const grandTotal = useMemo(
    () => groups.reduce((s, g) => s + g.total, 0),
    [groups],
  );

  const togglePartyExpand = useCallback((key) => {
    setExpanded(prev => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key); else next.add(key);
      return next;
    });
  }, []);

  const expandAll = () => setExpanded(new Set(groups.map(g => g.party_id ?? `cash:${g.party_name}`)));
  const collapseAll = () => setExpanded(new Set());

  // ── Keyboard navigation ──────────────────────────────────────────
  // Same shape as Trial Balance: build a flat list of currently-
  // visible rows (parties + their bills when expanded), drive an
  // activeIdx with the arrow keys, and let Enter/←/→ act on the row
  // under the cursor. Re-uses the report-family conventions so a
  // user who knows TB / BS knows this page on first hit too.
  const [activeIdx, setActiveIdx] = useState(-1);
  const scrollRef = useRef(null);

  const navRows = useMemo(() => {
    const list = [];
    for (const g of groups) {
      const key = g.party_id ?? `cash:${g.party_name}`;
      list.push({ kind: 'party', key, group: g });
      if (expanded.has(key)) {
        for (const b of g.bills) list.push({ kind: 'bill', key: `bill:${b.bill_id}`, bill: b, parentKey: key });
      }
    }
    return list;
  }, [groups, expanded]);

  // Reset active row when the underlying group set changes (filter
  // change, period change, etc.). Better than leaving the cursor on
  // a row that no longer exists.
  useEffect(() => { setActiveIdx(navRows.length > 0 ? 0 : -1); }, [groups]); // eslint-disable-line react-hooks/exhaustive-deps

  // Clamp when navRows shrinks (e.g. operator collapsed a party that
  // had the cursor on one of its bills).
  useEffect(() => {
    setActiveIdx(prev => {
      if (prev < 0) return prev;
      return Math.min(prev, navRows.length - 1);
    });
  }, [navRows.length]);

  // Scroll the active row into view as the cursor moves. `nearest`
  // avoids jarring centerings when the row is already on screen.
  useEffect(() => {
    if (activeIdx < 0 || !scrollRef.current) return;
    const rows = scrollRef.current.querySelectorAll('tbody tr.po-nav-row');
    rows[activeIdx]?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }, [activeIdx]);

  useEffect(() => {
    const onKey = (e) => {
      // Don't fight inputs / search fields elsewhere on the page.
      const tag = (document.activeElement?.tagName || '').toLowerCase();
      if (tag === 'input' || tag === 'textarea' || tag === 'select') return;
      if (document.activeElement?.isContentEditable) return;
      // Bail when no rows yet (fetching / empty).
      if (!navRows.length) return;

      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setActiveIdx(i => Math.min((i < 0 ? -1 : i) + 1, navRows.length - 1));
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        setActiveIdx(i => Math.max(i - 1, 0));
      } else if (e.key === 'Home') {
        e.preventDefault();
        setActiveIdx(0);
      } else if (e.key === 'End') {
        e.preventDefault();
        setActiveIdx(navRows.length - 1);
      } else if (e.key === 'PageDown') {
        e.preventDefault();
        setActiveIdx(i => Math.min((i < 0 ? 0 : i) + 10, navRows.length - 1));
      } else if (e.key === 'PageUp') {
        e.preventDefault();
        setActiveIdx(i => Math.max(i - 10, 0));
      } else if (e.key === 'ArrowRight') {
        // Expand the active party. On a bill row, jump to the parent
        // party (which is already expanded, but moving the cursor
        // gives a sensible "navigate up the hierarchy" experience).
        const row = navRows[activeIdx];
        if (!row) return;
        if (row.kind === 'party' && !expanded.has(row.key)) {
          e.preventDefault();
          togglePartyExpand(row.key);
        }
      } else if (e.key === 'ArrowLeft') {
        // Collapse active party — or, on a bill row, collapse the
        // parent and re-anchor the cursor on the parent.
        const row = navRows[activeIdx];
        if (!row) return;
        if (row.kind === 'bill') {
          e.preventDefault();
          const parentIdx = navRows.findIndex(r => r.kind === 'party' && r.key === row.parentKey);
          togglePartyExpand(row.parentKey);
          if (parentIdx >= 0) setActiveIdx(parentIdx);
        } else if (row.kind === 'party' && expanded.has(row.key)) {
          e.preventDefault();
          togglePartyExpand(row.key);
        }
      } else if (e.key === 'Enter') {
        const row = navRows[activeIdx];
        if (!row) return;
        e.preventDefault();
        if (row.kind === 'party') togglePartyExpand(row.key);
        else                       onDrillBill(row.bill);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [navRows, activeIdx, expanded, togglePartyExpand, onDrillBill]);

  // Drill into the party's statement. The newer Customer / Supplier
  // Statement pages handle the full ledger view. as-of date carries
  // through so the operator lands at the same period scope.
  const drillStatement = useCallback((party) => {
    if (!party.party_id) return;
    const route = side === 'payable' ? '/reports/supplier-statement' : '/reports/customer-statement';
    navigate(`${route}?id=${party.party_id}&to=${asOf}`);
  }, [navigate, side, asOf]);

  if (!loading && rows.length === 0) {
    return (
      <div className="po-empty">
        <Empty description={`No ${cfg.partyLabel.toLowerCase()} outstanding as on ${dayjs(asOf).format('D MMM YYYY')}.`} />
      </div>
    );
  }

  return (
    <div className={'po-wrap' + (loading ? ' is-loading' : '')}>
      {loading && (
        <div className="po-overlay"><Spin size="large" /></div>
      )}

      <div className="po-toolbar">
        <span className="po-count">
          <b>{groups.length}</b> {cfg.partyLabel.toLowerCase()}{groups.length === 1 ? '' : 's'}
          <span className="sep">·</span>
          <b>{rows.length}</b> bill{rows.length === 1 ? '' : 's'}
        </span>
        <div className="po-toolbar-actions">
          <button className="po-link" onClick={expandAll}>Expand all</button>
          <span className="sep">·</span>
          <button className="po-link" onClick={collapseAll}>Collapse all</button>
        </div>
      </div>

      <div className="po-scroll" ref={scrollRef}>
        <table className="po-table">
          <colgroup>
            <col style={{ width: 36 }} />
            <col />
            <col style={{ width: 140 }} />
            <col style={{ width: 110 }} />
            <col style={{ width: 110 }} />
          </colgroup>
          <thead>
            <tr>
              <th />
              <th>{cfg.partyLabel}</th>
              <th className="right">Outstanding</th>
              <th className="right">Bills</th>
              <th className="right">Oldest</th>
            </tr>
          </thead>
          <tbody>
            {/* Render driven by navRows so DOM order ≡ keyboard order
                — activeIdx maps 1:1 onto a single .po-nav-row tr. */}
            {navRows.map((row, idx) => {
              const isActive = idx === activeIdx;
              if (row.kind === 'party') {
                const g = row.group;
                const isOpen = expanded.has(row.key);
                return (
                  <tr
                    key={row.key}
                    className={
                      'po-nav-row po-party-row'
                      + (isOpen   ? ' is-open'   : '')
                      + (isActive ? ' is-active' : '')
                    }
                    onClick={() => { setActiveIdx(idx); togglePartyExpand(row.key); }}
                  >
                    <td className="po-chev-cell">
                      <span className={'po-chev' + (isOpen ? '' : ' collapsed')}>▾</span>
                    </td>
                    <td className="po-party-name">
                      <a
                        onClick={(e) => { e.stopPropagation(); drillStatement(g); }}
                        title={`Open ${cfg.partyLabel} Statement`}
                      >
                        {g.party_name}
                      </a>
                      {g.party_city && <span className="po-meta-pill">{g.party_city}</span>}
                    </td>
                    <td className="po-num">
                      <b>{fmt(g.total)}</b> <span className="po-drcr">{sideSuffix(side)}</span>
                    </td>
                    <td className="po-num">{g.bills.length}</td>
                    <td className="po-num">
                      {g.oldestDays > 0
                        ? <Tooltip title="Oldest unpaid bill — days overdue"><span className="po-overdue">{g.oldestDays}d</span></Tooltip>
                        : <span style={{ color: 'var(--fg-tertiary)' }}>—</span>}
                    </td>
                  </tr>
                );
              }
              // Bill row inside an expanded party
              const b = row.bill;
              return (
                <tr
                  key={row.key}
                  className={'po-nav-row po-bill-row' + (isActive ? ' is-active' : '')}
                  onClick={() => { setActiveIdx(idx); onDrillBill(b); }}
                >
                  <td />
                  <td className="po-bill-cell">
                    <span className="po-bill-no">{b.bill_no}</span>
                    <span className="po-bill-meta">
                      {dayjs(b.bill_date).format('DD-MM-YYYY')}
                      {b.due_date && <> · due {dayjs(b.due_date).format('DD-MM-YYYY')}</>}
                      {b.overdue_days > 0 && <> · <span className="po-overdue">{b.overdue_days}d</span></>}
                    </span>
                  </td>
                  <td className="po-num">
                    {fmt(b.outstanding)} <span className="po-drcr">{sideSuffix(side)}</span>
                  </td>
                  <td className="po-num" colSpan={2} style={{ color: 'var(--fg-tertiary)', fontSize: 11 }}>
                    of {fmt(b.bill_amount)}
                  </td>
                </tr>
              );
            })}
          </tbody>
          <tfoot>
            <tr className="po-total-row">
              <td />
              <td><b>Grand Total</b></td>
              <td className="po-num"><b>{fmt(grandTotal)}</b> <span className="po-drcr">{sideSuffix(side)}</span></td>
              <td className="po-num"><b>{rows.length}</b></td>
              <td />
            </tr>
          </tfoot>
        </table>
      </div>
    </div>
  );
}
