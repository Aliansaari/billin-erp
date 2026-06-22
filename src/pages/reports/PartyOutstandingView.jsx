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
import { reportAPI } from '../../api';

const fmt = (v) =>
  parseFloat(v || 0).toLocaleString('en-IN', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });

// Accounting Dr/Cr suffix. For Receivable view the customer typically owes
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
  isVisible = true, // false when the parent toggled to bill-view; pauses the global keydown handler so the two views don't fight over arrow keys
  expanded,       // Set of party_ids currently expanded — owned by parent so the header's Expand-all toggle can read + write it
  setExpanded,    // (Set) => void — parent's setter, used by row clicks + keyboard nav
  onGroupCount,   // (n: number) => void — parent uses this to know how many parties are loaded so its header toggle can decide "Expand all" vs "Collapse all"
  onSummary,      // ({ total, parties }) => void — pushes the ledger-anchored grand total up so the parent's KPI tiles match this view
  expandAllRequest = 0, // counter — every increment from the parent triggers an "expand every loaded party" action
}) {
  const navigate = useNavigate();
  const [billRows, setBillRows] = useState([]);   // open-bill rows — drill-down detail only
  const [balRows,  setBalRows]  = useState([]);   // per-party LEDGER balance — the authoritative total
  const [loading,  setLoading]  = useState(false);

  // ── Two data sources, fetched together ───────────────────────────────
  //   • getPartyOutstanding → one row per owing party with its ledger
  //     balance (current_balance). This is the SAME figure the Dashboard
  //     tiles and the Customers / Suppliers list show, so anchoring each
  //     party's total here makes all three agree (the bill-level sum used
  //     to fall short by the on-account / opening money that isn't tied to
  //     a specific open bill).
  //   • cfg.fetcher (bills-receivable/payable) → the individual open bills,
  //     used only to populate each party's expandable bill list and to
  //     split the balance into "against open bills" vs "on-account /
  //     opening". Fetched by as-of + scope only (not the bill-level
  //     bucket/city/amount chips) so the split is computed against EVERY
  //     open bill, not a filtered subset.
  useEffect(() => {
    let stale = false;
    setLoading(true);
    Promise.all([
      cfg.fetcher({ as_of: filters?.as_of, limit: 10000, offset: 0 }),
      reportAPI.getPartyOutstanding({ party_type: cfg.partyTypeQuery }),
    ])
      .then(([billsRes, balRes]) => {
        if (stale) return;
        const bills = Array.isArray(billsRes.data) ? billsRes.data : (billsRes.data?.data || []);
        const bals  = balRes?.data?.data || [];
        setBillRows(bills);
        setBalRows(bals);
      })
      .catch(err => {
        if (stale) return;
        message.error(err?.response?.data?.error || `Failed to load ${cfg.title}.`);
        setBillRows([]); setBalRows([]);
      })
      .finally(() => { if (!stale) setLoading(false); });
    return () => { stale = true; };
  }, [cfg, filters?.as_of]);

  // Party-level filters applied client-side (the universally-expected ones
  // for a "who owes what" report). Bill-level chips (bucket / city /
  // amount) stay on the Bill Wise view; this view is anchored to the
  // ledger balance.
  const partyIdFilter = useMemo(() => {
    const raw = filters?.party_ids;
    if (!raw) return null;
    const ids = String(raw).split(',').map((s) => parseInt(s, 10)).filter(Number.isFinite);
    return ids.length ? new Set(ids) : null;
  }, [filters?.party_ids]);
  const searchFilter = (filters?.search || '').trim().toLowerCase();

  // Build one group per owing party, anchored to its ledger balance, with
  // its open bills attached for the drill-down + the on-account split.
  const groups = useMemo(() => {
    const billsByParty = new Map();
    for (const b of billRows) {
      if (!billsByParty.has(b.party_id)) billsByParty.set(b.party_id, []);
      billsByParty.get(b.party_id).push(b);
    }

    const out = [];
    for (const p of balRows) {
      // getPartyOutstanding already restricts to the owing side (customers
      // current_balance > 0, suppliers < 0); the magnitude is owed.
      const total = Math.abs(parseFloat(p.current_balance) || 0);
      if (total < 0.01) continue;
      if (partyIdFilter && !partyIdFilter.has(p.party_id)) continue;
      if (searchFilter) {
        const hay = `${p.party_name || ''} ${p.mobile_1 || ''}`.toLowerCase();
        if (!hay.includes(searchFilter)) continue;
      }

      const bills = billsByParty.get(p.party_id) || [];
      let billOutstanding = 0, overdue = 0, oldestDays = 0;
      let city = '', mobile = p.mobile_1 || '';
      for (const b of bills) {
        const o = parseFloat(b.outstanding) || 0;
        billOutstanding += o;
        const od = parseInt(b.overdue_days || 0, 10);
        if (od > 0) overdue += o;
        if (od > oldestDays) oldestDays = od;
        if (!city && b.party_city) city = b.party_city;
        if (!mobile && b.party_mobile) mobile = b.party_mobile;
      }
      // The slice of the ledger balance not tied to an open bill: opening
      // balance / on-account receipts (positive), or a net credit when
      // open bills exceed the balance (negative). bills + onaccount = total.
      const onaccount = parseFloat((total - billOutstanding).toFixed(2));

      out.push({
        party_id:     p.party_id,
        party_name:   p.party_name || '—',
        party_city:   city,
        party_mobile: mobile,
        total,
        bills,
        onaccount,
        overdue,
        oldestDays,
      });
    }
    return out.sort((a, b) => b.total - a.total);
  }, [balRows, billRows, partyIdFilter, searchFilter]);

  const grandTotal = useMemo(
    () => groups.reduce((s, g) => s + g.total, 0),
    [groups],
  );
  const totalBills = useMemo(
    () => groups.reduce((s, g) => s + g.bills.length, 0),
    [groups],
  );

  const togglePartyExpand = useCallback((key) => {
    setExpanded(prev => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key); else next.add(key);
      return next;
    });
  }, [setExpanded]);

  // Tell the parent how many groups (parties) are loaded so the
  // Expand-all / Collapse-all button in the header can decide its
  // current label state. Skip when count is 0 (loading / empty) so
  // the toggle button doesn't flicker its label on first load.
  useEffect(() => {
    if (typeof onGroupCount === 'function') onGroupCount(groups.length);
  }, [groups.length, onGroupCount]);

  // Push the ledger-anchored grand total up so the parent's KPI tiles
  // (Total Outstanding / Parties) show the same figure as this view —
  // which equals the Dashboard receivable/payable and the party lists.
  useEffect(() => {
    if (typeof onSummary === 'function') onSummary({ total: grandTotal, parties: groups.length });
  }, [grandTotal, groups.length, onSummary]);

  // Parent ticked the expand-all counter — open every loaded party.
  // Skip the initial mount (counter still at its default 0) so an
  // accidental first-render expand doesn't happen.
  const lastExpandAllRequest = useRef(0);
  useEffect(() => {
    if (expandAllRequest === lastExpandAllRequest.current) return;
    lastExpandAllRequest.current = expandAllRequest;
    if (expandAllRequest === 0) return;        // initial render
    setExpanded(new Set(groups.map(g => g.party_id ?? `cash:${g.party_name}`)));
  }, [expandAllRequest, groups, setExpanded]);

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
        // Reconciling line so the bills under a party visibly add up to its
        // ledger total (opening / on-account money not tied to a bill).
        if (Math.abs(g.onaccount) >= 1) list.push({ kind: 'onaccount', key: `oa:${key}`, group: g, parentKey: key });
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
      // Skip while the bill view is in front — both views are mounted
      // simultaneously (for instant view-mode toggle), so without this
      // gate they'd both react to the same arrow keys.
      if (!isVisible) return;
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
        if (row.kind === 'bill' || row.kind === 'onaccount') {
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
        if (row.kind === 'party')      togglePartyExpand(row.key);
        else if (row.kind === 'bill')  onDrillBill(row.bill);
        // onaccount rows are informational — Enter is a no-op.
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [navRows, activeIdx, expanded, togglePartyExpand, onDrillBill, isVisible]);

  // Drill into the party's statement. The newer Customer / Supplier
  // Statement pages handle the full ledger view. as-of date carries
  // through so the operator lands at the same period scope.
  const drillStatement = useCallback((party) => {
    if (!party.party_id) return;
    const route = side === 'payable' ? '/reports/supplier-statement' : '/reports/customer-statement';
    navigate(`${route}?id=${party.party_id}&to=${asOf}`);
  }, [navigate, side, asOf]);

  if (!loading && groups.length === 0) {
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

      <div className="po-scroll" ref={scrollRef}>
        <table className="po-table po-table--body">
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
              // On-account / opening reconciling line inside an expanded
              // party — the balance not tied to a specific open bill.
              if (row.kind === 'onaccount') {
                const g = row.group;
                const amt = g.onaccount;
                return (
                  <tr
                    key={row.key}
                    className={'po-nav-row po-bill-row po-onaccount-row' + (isActive ? ' is-active' : '')}
                    onClick={() => setActiveIdx(idx)}
                  >
                    <td />
                    <td className="po-bill-cell">
                      <span className="po-bill-no" style={{ fontStyle: 'italic' }}>On account / opening</span>
                      <span className="po-bill-meta">not against a specific bill</span>
                    </td>
                    <td className="po-num" style={{ fontStyle: 'italic' }}>
                      {fmt(amt)} <span className="po-drcr">{amt >= 0 ? sideSuffix(side) : (side === 'receivable' ? 'Cr' : 'Dr')}</span>
                    </td>
                    <td className="po-num" colSpan={2} />
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
        </table>
      </div>

      {/* ── Pinned Grand Total ──────────────────────────────────────
          Separate <table> outside .po-scroll so the strip is always
          flush against the viewport bottom regardless of how many
          parties are loaded — matching the Closing Balance strip on
          Customer / Supplier Statement. The shared colgroup keeps
          column widths aligned with the body table. */}
      <table className="po-table po-table--footer">
        <colgroup>
          <col style={{ width: 36 }} />
          <col />
          <col style={{ width: 140 }} />
          <col style={{ width: 110 }} />
          <col style={{ width: 110 }} />
        </colgroup>
        <tbody>
          <tr className="po-total-row">
            <td />
            <td><b>Grand Total</b></td>
            <td className="po-num"><b>{fmt(grandTotal)}</b> <span className="po-drcr">{sideSuffix(side)}</span></td>
            <td className="po-num"><b>{totalBills}</b></td>
            <td />
          </tr>
        </tbody>
      </table>
    </div>
  );
}
