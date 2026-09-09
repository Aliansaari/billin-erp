// ── Trial Balance ──────────────────────────────────────────────────────
//
// Classic accounting-style hierarchical Trial Balance with drill-into-page.
//
//   Page 1 — Trial Balance      → primary groups + intermediate
//                                 groups (Current Assets / Fixed Assets
//                                 / Current Liabilities / Loans / etc.)
//                                 + sub-groups, no leaf ledgers inline.
//   Page 2 — Group Summary      → opens when user clicks any sub-group.
//                                 Lists every ledger under that group.
//                                 Click a ledger → existing PartyLedger.
//
// The intermediate level is derived client-side from `sub_group`
// — no schema change. See SUB_TO_MID below.
//
// Reconciliation banner renders only when totals.balanced is false OR
// the server's filter-drift integrity check fails.

import React, { useEffect, useMemo, useState, useCallback } from 'react';
import { message, Spin, DatePicker } from 'antd';
import {
  SearchOutlined, ArrowLeftOutlined, CalendarOutlined, PrinterOutlined, FileExcelOutlined,
} from '@ant-design/icons';
import { useNavigate, useSearchParams } from 'react-router-dom';
import ActionStrip from '../../components/keyboard/ActionStrip';
import { useDatePopup } from '../../components/keyboard/DatePopup';
import dayjs from 'dayjs';
import { reportAPI } from '../../api';
import { useFinancialYear } from '../../hooks/useFinancialYear';
import './trial-balance.css';

const fmtINR = (v) =>
  Number(v || 0).toLocaleString('en-IN', {
    minimumFractionDigits: 2, maximumFractionDigits: 2,
  });

// ── Intermediate group mapping ───────────────────────────────────────
//
// `sub_group` (free text) + `ledger_group` (primary) → an intermediate
// account group. Adds the Current/Fixed/Loans distinction experienced
// accounting-software users expect, without touching the schema.
//
// Keyed by primary so the same sub_group name (e.g., "Duties & Taxes" —
// which can be Input GST under Assets OR Output GST under Liabilities)
// classifies correctly under each primary. Anything not listed falls
// back to using the sub_group itself as its own mid node.
const SUB_TO_MID = {
  Assets: {
    // Current Assets
    'Sundry Debtors':            'Current Assets',
    'Cash-in-Hand':              'Current Assets',
    'Bank Accounts':             'Current Assets',
    'Bank Account':              'Current Assets',
    'Stock-in-Hand':             'Current Assets',
    'Loans & Advances (Asset)':  'Current Assets',
    'Loans and Advances (Asset)':'Current Assets',
    'Deposits (Asset)':          'Current Assets',
    'Other Current Assets':      'Current Assets',
    // Input GST and similar lives on the asset side as recoverable tax
    'Duties & Taxes':            'Current Assets',
    'Input GST':                 'Current Assets',
    // Fixed Assets
    'Fixed Assets':              'Fixed Assets',
    'Plant & Machinery':         'Fixed Assets',
    'Furniture & Fixtures':      'Fixed Assets',
    'Vehicles':                  'Fixed Assets',
    'Office Equipment':          'Fixed Assets',
    'Computer & Equipment':      'Fixed Assets',
    'Buildings':                 'Fixed Assets',
    'Land':                      'Fixed Assets',
    // Investments
    'Investments':               'Investments',
    // Misc
    'Misc. Expenses (Asset)':    'Misc. Expenses (Asset)',
  },
  Liabilities: {
    // Current Liabilities
    'Sundry Creditors':          'Current Liabilities',
    'Duties & Taxes':            'Current Liabilities',
    'Duties and Taxes':          'Current Liabilities',
    'Output GST':                'Current Liabilities',
    'Provisions':                'Current Liabilities',
    'Other Current Liabilities': 'Current Liabilities',
    // Loans (Liability)
    'Loans (Liability)':         'Loans (Liability)',
    'Bank OD/CC':                'Loans (Liability)',
    'Bank OD A/c':               'Loans (Liability)',
    'Secured Loans':             'Loans (Liability)',
    'Unsecured Loans':           'Loans (Liability)',
  },
  Income: {
    'Sales Account':             'Direct Income',
    'Sales Accounts':            'Direct Income',
    'Direct Income':             'Direct Income',
    'Indirect Income':           'Indirect Income',
  },
  Expenses: {
    'Direct Expenses':           'Direct Expenses',
    'Purchase Account':          'Direct Expenses',
    'Purchase Accounts':         'Direct Expenses',
    'Purchases':                 'Direct Expenses',
    'Indirect Expenses':         'Indirect Expenses',
    'Bank Charges & Interest':   'Indirect Expenses',
    'Bank Charges':              'Indirect Expenses',
  },
  Capital: {
    "Owner's Capital":           'Capital Account',
    "Owner's Funds":             'Capital Account',
    'Capital':                   'Capital Account',
    'Drawings':                  'Capital Account',
    'Reserves & Surplus':        'Reserves & Surplus',
    'Reserves and Surplus':      'Reserves & Surplus',
  },
};

function midFor(primary, sub) {
  return (SUB_TO_MID[primary] && SUB_TO_MID[primary][sub]) || sub;
}

// Persistent expand/collapse preference, shared with Balance Sheet
// (same localStorage key) so flipping the toggle on one report is
// remembered by the other.
const EXPAND_PREF_KEY = 'erp_report_expand_default';
function loadExpandPref() {
  try { return localStorage.getItem(EXPAND_PREF_KEY) === 'expanded'; } catch { return false; }
}
function saveExpandPref(v) {
  try { localStorage.setItem(EXPAND_PREF_KEY, v ? 'expanded' : 'collapsed'); } catch {}
}

const PRIMARY_ORDER = ['Assets', 'Liabilities', 'Income', 'Expenses', 'Capital'];

function presetRange(key, fyStart, fyEnd) {
  const today = dayjs();
  if (key === 'this_fy')    return [dayjs(fyStart),                  dayjs(fyEnd)];
  if (key === 'last_fy')    return [dayjs(fyStart).subtract(1, 'year'), dayjs(fyEnd).subtract(1, 'year')];
  if (key === 'this_q')     return [today.startOf('quarter'),        today.endOf('quarter')];
  if (key === 'this_month') return [today.startOf('month'),          today.endOf('month')];
  return null;
}

export default function TrialBalance() {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const { fyStart, fyEnd } = useFinancialYear();

  const [data, setData]     = useState(null);
  const [loading, setLoad]  = useState(true);
  const [preset]            = useState('this_fy');
  const [from, setFrom]     = useState(null);
  const [to, setTo]         = useState(null);

  // 'closing' (default — only closing Dr/Cr columns) | 'tally' (Opening + Tx + Closing)
  const [view, setView]     = useState('closing');

  // Page-swap: 'tb' = trial balance, 'group' = group summary drill
  const [page, setPage]     = useState('tb');
  const [activeGroup, setActiveGroup] = useState(null); // { name, parent, drcr, amount }

  // Group-summary search filter
  const [groupSearch, setGroupSearch] = useState('');

  // Collapsed mid/sub-groups (set of names)
  const [collapsed, setCollapsed] = useState(() => new Set());

  // Default-expand preference (shared with Balance Sheet via localStorage).
  // Drives whether new data lands all-collapsed or all-expanded; users can
  // still click individual chevrons to toggle one row.
  const [expandAllDefault, setExpandAllDefault] = useState(loadExpandPref);

  // Keyboard-navigation: index of the currently focused row (within
  // navigable rows on the active page). -1 = no focus.
  const [activeIdx, setActiveIdx] = useState(-1);
  const scrollRef = React.useRef(null);

  // ── Period plumbing ──
  useEffect(() => {
    if (!fyStart || !fyEnd) return;
    if (preset === 'custom') return;
    const r = presetRange(preset, fyStart, fyEnd);
    if (r) { setFrom(r[0].format('YYYY-MM-DD')); setTo(r[1].format('YYYY-MM-DD')); }
  }, [preset, fyStart, fyEnd]);

  const loadData = useCallback(() => {
    if (!from || !to) return;
    setLoad(true);
    reportAPI.trialBalance({ from_date: from, to_date: to })
      .then((r) => setData(r.data))
      .catch((e) => message.error(e.response?.data?.error || 'Failed to load Trial Balance'))
      .finally(() => setLoad(false));
  }, [from, to]);

  useEffect(() => { loadData(); }, [loadData]);

  // ── Build the 3-level tree: primary → mid → sub → ledgers ──
  const tree = useMemo(() => {
    if (!data?.ledgers) return [];

    // Map<primary, Map<mid, Map<sub, { rows, dr, cr, opening, txDr, txCr }>>>
    const primaries = new Map();

    for (const r of data.ledgers) {
      const primary = r.ledger_group;
      const sub     = r.sub_group || '(Uncategorised)';
      const mid     = midFor(primary, sub);

      if (!primaries.has(primary)) primaries.set(primary, new Map());
      const midMap = primaries.get(primary);

      if (!midMap.has(mid)) midMap.set(mid, new Map());
      const subMap = midMap.get(mid);

      if (!subMap.has(sub)) {
        subMap.set(sub, { name: sub, rows: [], dr: 0, cr: 0 });
      }
      const subBucket = subMap.get(sub);
      subBucket.rows.push(r);
      subBucket.dr += Number(r.debit)  || 0;
      subBucket.cr += Number(r.credit) || 0;
    }

    // Convert to ordered arrays + roll up totals
    const result = [];
    for (const primary of PRIMARY_ORDER) {
      const midMap = primaries.get(primary);
      if (!midMap) continue;
      const mids = [];
      let pDr = 0, pCr = 0, pCount = 0;

      for (const [midName, subMap] of midMap.entries()) {
        const subs = [...subMap.values()].sort((a, b) => a.name.localeCompare(b.name));
        const mDr = subs.reduce((s, x) => s + x.dr, 0);
        const mCr = subs.reduce((s, x) => s + x.cr, 0);
        const mCount = subs.reduce((s, x) => s + x.rows.length, 0);
        mids.push({ name: midName, subs, dr: mDr, cr: mCr, count: mCount });
        pDr += mDr; pCr += mCr; pCount += mCount;
      }

      mids.sort((a, b) => a.name.localeCompare(b.name));
      result.push({ name: primary, mids, dr: pDr, cr: pCr, count: pCount });
    }
    // Catch any unknown primary (shouldn't happen given the enum)
    for (const [p, midMap] of primaries.entries()) {
      if (PRIMARY_ORDER.includes(p)) continue;
      const mids = [];
      let pDr = 0, pCr = 0, pCount = 0;
      for (const [midName, subMap] of midMap.entries()) {
        const subs = [...subMap.values()].sort((a, b) => a.name.localeCompare(b.name));
        const mDr = subs.reduce((s, x) => s + x.dr, 0);
        const mCr = subs.reduce((s, x) => s + x.cr, 0);
        mids.push({ name: midName, subs, dr: mDr, cr: mCr, count: subs.reduce((s, x) => s + x.rows.length, 0) });
        pDr += mDr; pCr += mCr; pCount += mids.at(-1).count;
      }
      result.push({ name: p, mids, dr: pDr, cr: pCr, count: pCount });
    }
    return result;
  }, [data]);

  // ── Drill helpers ──
  // Drilling into a group pushes the group context onto the URL as
  // query params. This way the back stack works naturally:
  //   /reports/trial-balance               (TB page)
  //   /reports/trial-balance?group=…       (group page — pushed on drill)
  //   /reports/party-ledger?…              (ledger detail — pushed on click)
  // Pressing Esc anywhere walks history.back() exactly one step, so:
  // ledger → group → TB → /reports — without losing context at any layer.
  const openGroup = (name, parent, drcr, amount) => {
    const qs = new URLSearchParams({
      group: name,
      parent: parent || '',
      drcr,
      amount: String(amount ?? ''),
    });
    navigate(`/reports/trial-balance?${qs.toString()}`);
  };
  const goBack = () => navigate(-1);

  // The ledger rows shown in Group Summary, filtered by search.
  // activeGroup.name can be:
  //   • a primary group name      (e.g., "Assets")        → all ledgers in primary
  //   • an intermediate group name (e.g., "Current Assets")→ all ledgers in that mid
  //   • a sub_group name          (e.g., "Sundry Debtors")→ only that sub-group
  // Most-specific match wins.
  const groupLedgers = useMemo(() => {
    if (!activeGroup || !data?.ledgers) return [];
    const subMatches = data.ledgers.filter(r => (r.sub_group || '(Uncategorised)') === activeGroup.name);
    let rows;
    if (subMatches.length) {
      rows = subMatches;
    } else {
      const midMatches = data.ledgers.filter(r => midFor(r.ledger_group, r.sub_group || '(Uncategorised)') === activeGroup.name);
      rows = midMatches.length
        ? midMatches
        : data.ledgers.filter(r => r.ledger_group === activeGroup.name);
    }
    const q = groupSearch.trim().toLowerCase();
    if (!q) return rows;
    return rows.filter(r => (r.ledger_name || '').toLowerCase().includes(q));
  }, [activeGroup, data, groupSearch]);

  const groupTotals = useMemo(() => {
    let dr = 0, cr = 0;
    for (const r of groupLedgers) { dr += Number(r.debit) || 0; cr += Number(r.credit) || 0; }
    return { dr, cr, count: groupLedgers.length };
  }, [groupLedgers]);

  // ── Ledger drill ──
  // Party rows → Customer / Supplier Statement (the page picks the
  // flavour from party.party_type once it loads). COA rows (Sales A/c,
  // Bank, Office Rent, etc.) → /reports/ledger directly. Both
  // destinations share the same <LedgerStatement> renderer, so the
  // visual experience is identical aside from the page chrome.
  const openLedger = (row) => {
    if (row.is_party_ledger && row.party_id) {
      // Trial Balance doesn't carry party_type on the row, so we
      // route through the legacy redirect. It looks up the type once
      // and bounces — adds 100ms on first hit, free thereafter.
      // Updating the TB SQL to surface party_type is a TODO that
      // would skip the hop entirely.
      navigate(`/reports/party-ledger?party_id=${row.party_id}&from=${from}&to=${to}`);
    } else {
      navigate(`/reports/ledger?id=${row.ledger_id}&from=${from}&to=${to}`);
    }
  };

  // ── Toggle collapse on a mid or sub row ──
  const toggleCollapse = (key, e) => {
    e?.stopPropagation();
    setCollapsed(prev => {
      const next = new Set(prev);
      next.has(key) ? next.delete(key) : next.add(key);
      return next;
    });
  };

  // ── Build a flat list of navigable rows for arrow-key navigation ──
  // Order matches DOM render order so activeIdx maps 1:1 onto the
  // visible rows (skipping the primary group row, which expands the
  // whole bucket and isn't a meaningful drill target by itself).
  const navRows = useMemo(() => {
    if (page === 'group') {
      return groupLedgers.map(r => ({
        kind: 'ledger',
        row: r,
        action: () => openLedger(r),
      }));
    }
    const list = [];
    for (const primary of tree) {
      // Primary group is navigable — Enter toggles its expand/collapse
      // (matches click behavior). Once expanded, the user can keyboard
      // down into the mids/subs and Enter on those to drill.
      list.push({
        kind: 'primary',
        name: primary.name,
        parent: 'Trial Balance',
        action: () => toggleCollapse(`p:${primary.name}`),
      });
      if (collapsed.has(`p:${primary.name}`)) continue;
      for (const mid of primary.mids) {
        const mDr = mid.dr > mid.cr ? (mid.dr - mid.cr) : 0;
        const mCr = mid.cr > mid.dr ? (mid.cr - mid.dr) : 0;
        const drcr = mDr ? 'dr' : 'cr';
        list.push({
          kind: 'mid',
          name: mid.name,
          parent: primary.name,
          action: () => openGroup(mid.name, primary.name, drcr, drcr === 'dr' ? mDr : mCr),
        });
        if (collapsed.has(`m:${primary.name}:${mid.name}`)) continue;
        for (const sub of mid.subs) {
          const sDr = sub.dr > sub.cr ? (sub.dr - sub.cr) : 0;
          const sCr = sub.cr > sub.dr ? (sub.cr - sub.dr) : 0;
          const sDrcr = sDr ? 'dr' : 'cr';
          list.push({
            kind: 'sub',
            name: sub.name,
            parent: mid.name,
            action: () => openGroup(sub.name, mid.name, sDrcr, sDrcr === 'dr' ? sDr : sCr),
          });
        }
      }
    }
    return list;
  }, [tree, collapsed, page, groupLedgers]);

  // Reset selection only when the page swaps — NOT when navRows.length
  // changes due to expand/collapse. Expanding a primary group shouldn't
  // jump the highlight back to the first row; the user just acted on
  // their current row, and they expect to keep navigating from there.
  useEffect(() => { setActiveIdx(navRows.length > 0 ? 0 : -1); }, [page]); // eslint-disable-line react-hooks/exhaustive-deps

  // When the navigable list shrinks (e.g., user collapsed a parent),
  // clamp activeIdx to a still-valid row instead of leaving it
  // pointing past the end. When it grows from zero (initial data
  // arrival), seed to 0. Otherwise leave it alone — the user's
  // current selection is preserved across expand/collapse.
  useEffect(() => {
    setActiveIdx(prev => {
      if (navRows.length === 0) return -1;
      if (prev < 0) return 0;
      if (prev >= navRows.length) return navRows.length - 1;
      return prev;
    });
  }, [navRows.length]);

  // Reseed `collapsed` whenever data lands or the user flips the
  // Collapsed/Expanded preference. Default = collapsed (classic
  // accounting-style: only the 5 primary groups visible). Setting the preference to
  // "Expanded" clears the set so every primary opens at once.
  useEffect(() => {
    if (!data || tree.length === 0) return;
    if (expandAllDefault) {
      setCollapsed(new Set());
    } else {
      setCollapsed(new Set(tree.map(p => `p:${p.name}`)));
    }
  }, [data, expandAllDefault]); // eslint-disable-line react-hooks/exhaustive-deps

  // Derive page state from the URL. `?group=Sundry+Debtors&parent=…&drcr=dr
  // &amount=…` puts us on the Group Summary; no params puts us on the
  // top-level TB page. This makes the browser back-button (and Esc, which
  // AppLayout maps to history.back()) Just Work — going back from a
  // ledger drill returns the user to the group they came from, not the
  // top-level TB.
  useEffect(() => {
    const groupName = searchParams.get('group');
    if (groupName) {
      const amt = parseFloat(searchParams.get('amount') || '0');
      setActiveGroup({
        name: groupName,
        parent: searchParams.get('parent') || '',
        drcr: searchParams.get('drcr') || 'dr',
        amount: Number.isFinite(amt) ? amt : 0,
      });
      setPage('group');
      setGroupSearch('');
    } else {
      setActiveGroup(null);
      setPage('tb');
    }
    window.scrollTo(0, 0);
  }, [searchParams]);

  // Keep the highlighted row in view while arrow-key navigating.
  useEffect(() => {
    if (activeIdx < 0 || !scrollRef.current) return;
    const rows = scrollRef.current.querySelectorAll(
      page === 'group' ? '.tb-row-ledger' : '.tb-row-group, .tb-row-mid, .tb-row-sub'
    );
    rows[activeIdx]?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }, [activeIdx, page]);

  // ── Keyboard nav for the group rows ──
  // F5 (toggle view), F1 (drill), Esc (back) are owned by the bottom
  // ActionStrip. This listener only handles the up/down / home/end
  // navigation through navRows + Enter for the inline drill (Enter
  // is more convenient than F1 here because both rows the operator
  // is reading and the keyboard hand are already on the keyboard).
  useEffect(() => {
    const onKey = (e) => {
      const tag = (document.activeElement?.tagName || '').toLowerCase();
      const inField = tag === 'input' || tag === 'textarea' || tag === 'select';
      if (inField) return;

      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setActiveIdx(i => Math.min((i < 0 ? -1 : i) + 1, navRows.length - 1));
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        setActiveIdx(i => Math.max(i - 1, 0));
      } else if (e.key === 'Home') {
        e.preventDefault();
        setActiveIdx(navRows.length > 0 ? 0 : -1);
      } else if (e.key === 'End') {
        e.preventDefault();
        setActiveIdx(navRows.length - 1);
      } else if (e.key === 'Enter') {
        if (activeIdx >= 0 && navRows[activeIdx]) {
          e.preventDefault();
          navRows[activeIdx].action();
        }
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [page, navRows, activeIdx]);

  // F2 = Date popup (range). Opens the classic accounting-style smart-input popup
  // wired to the from / to state.
  const { openDate } = useDatePopup();

  const t = data?.totals || {};
  const reco = data?.reconciliation;
  const recoBad = (data && t.balanced === false) || (reco && reco.balanced === false);

  // Index counter for arrow-key navigation. Reset on every render and
  // incremented inline by mid/sub row renders so the rendered DOM index
  // matches `activeIdx`. (Closure-captured by the map callbacks below.)
  let __idx = -1;

  return (
    <div className="tb-page" data-page={page} data-view={view}>

      {/* ════════════ PAGE 1: Trial Balance ════════════ */}
      {page === 'tb' && <>
        <div className="tb-hd">
          <div className="tb-title">
            <h1>Trial Balance</h1>
            {t.balanced === false && (
              <span className="meta">
                <b style={{ color: 'var(--danger)' }}>Off by ₹{fmtINR(t.difference)}</b>
              </span>
            )}
          </div>
          <div className="tb-actions">
            <button className={'tb-btn ' + (!expandAllDefault ? 'on' : '')}
                    onClick={() => { setExpandAllDefault(false); saveExpandPref(false); }}
                    title="Show only top-level groups">
              Collapsed
            </button>
            <button className={'tb-btn ' + (expandAllDefault ? 'on' : '')}
                    onClick={() => { setExpandAllDefault(true); saveExpandPref(true); }}
                    title="Show all sub-groups expanded">
              Expanded
            </button>
            {/* Period picker — Trial Balance is "as on" a date, so this
                drives both the closing snapshot and the opening/tx range
                used in Detailed view. F2 from the bottom strip opens
                the smart-input range popup over this. */}
            <DatePicker.RangePicker
              size="small"
              format="DD-MMM-YY"
              suffixIcon={<CalendarOutlined />}
              allowClear={false}
              value={from && to ? [dayjs(from), dayjs(to)] : null}
              onChange={(v) => {
                if (!v?.[0] || !v?.[1]) return;
                setFrom(v[0].format('YYYY-MM-DD'));
                setTo(v[1].format('YYYY-MM-DD'));
              }}
              style={{ height: 30 }}
            />
          </div>
        </div>

        {recoBad && (
          <div className="tb-reco">
            <div className="tb-reco-icon">!</div>
            <div className="tb-reco-msg">
              {t.balanced === false && (
                <>
                  Trial balance does not tie out — Debits − Credits = <b>₹{fmtINR(t.difference)}</b>.&nbsp;
                </>
              )}
              {reco && reco.balanced === false && (
                <>
                  Filter-drift detected — drift Dr <b>₹{fmtINR(reco.drift_dr)}</b>, Cr <b>₹{fmtINR(reco.drift_cr)}</b>.&nbsp;
                </>
              )}
              <a onClick={() => navigate('/accounts/integrity')} style={{ color: 'var(--accent)', cursor: 'pointer', fontWeight: 600 }}>
                Open Integrity →
              </a>
            </div>
          </div>
        )}

        <div className="tb-scroll" ref={scrollRef}>
          {loading ? (
            <div className="tb-loading"><Spin /> &nbsp;Loading Trial Balance…</div>
          ) : tree.length === 0 ? (
            <div className="tb-empty">No ledger activity in this period.</div>
          ) : (
            <table className="tb-table">
              <colgroup>
                <col />
                <col className="col-opening" />
                <col className="col-tx-dr" />
                <col className="col-tx-cr" />
                <col />
                <col />
              </colgroup>
              <thead>
                <tr>
                  <th className="l">Particulars</th>
                  <th className="col-opening">Opening Balance<span className="sub">as on {fyStart ? dayjs(fyStart).format('D-MMM-YY') : '—'}</span></th>
                  <th className="col-tx-dr">Transactions<span className="sub">Debit</span></th>
                  <th className="col-tx-cr">Transactions<span className="sub">Credit</span></th>
                  <th>Closing Balance<span className="sub">Debit</span></th>
                  <th>Closing Balance<span className="sub">Credit</span></th>
                </tr>
              </thead>
              <tbody>
                {tree.map((primary) => {
                  const pKey = `p:${primary.name}`;
                  const pCollapsed = collapsed.has(pKey);
                  // Pick which side the primary's net balance falls on
                  const primaryDr = primary.dr > primary.cr ? (primary.dr - primary.cr) : 0;
                  const primaryCr = primary.cr > primary.dr ? (primary.cr - primary.dr) : 0;
                  const pIdx  = ++__idx;
                  return (
                    <React.Fragment key={primary.name}>
                      <tr className={'tb-row-group' + (pIdx === activeIdx ? ' tb-active' : '')}
                          onClick={(e) => toggleCollapse(pKey, e)}>
                        <td className="l">
                          <div className="gh">
                            <span className={'tb-chev' + (pCollapsed ? ' collapsed' : '')}>▾</span>
                            <span className="name">{primary.name}</span>
                          </div>
                        </td>
                        <td className="col-opening num"></td>
                        <td className="col-tx-dr num dr">{primary.dr ? fmtINR(primary.dr) : ''}</td>
                        <td className="col-tx-cr num cr">{primary.cr ? fmtINR(primary.cr) : ''}</td>
                        <td className="num dr">{primaryDr ? fmtINR(primaryDr) : ''}</td>
                        <td className="num cr">{primaryCr ? fmtINR(primaryCr) : ''}</td>
                      </tr>

                      {!pCollapsed && primary.mids.map((mid) => {
                        const mKey = `m:${primary.name}:${mid.name}`;
                        const mCollapsed = collapsed.has(mKey);
                        const midDr = mid.dr > mid.cr ? (mid.dr - mid.cr) : 0;
                        const midCr = mid.cr > mid.dr ? (mid.cr - mid.dr) : 0;
                        const drcr = midDr ? 'dr' : 'cr';
                        const amt  = drcr === 'dr' ? midDr : midCr;
                        const midIdx = ++__idx;
                        return (
                          <React.Fragment key={mKey}>
                            <tr className={'tb-row-mid' + (midIdx === activeIdx ? ' tb-active' : '')}
                                onClick={() => openGroup(mid.name, primary.name, drcr, amt)}>
                              <td className="l">
                                <div className="mh">
                                  <span className={'tb-chev' + (mCollapsed ? ' collapsed' : '')}
                                        onClick={(e) => toggleCollapse(mKey, e)}>▾</span>
                                  <span className="name">{mid.name}</span>
                                  <span className="tb-arrow">→</span>
                                </div>
                              </td>
                              <td className="col-opening num"></td>
                              <td className="col-tx-dr num dr">{mid.dr ? fmtINR(mid.dr) : ''}</td>
                              <td className="col-tx-cr num cr">{mid.cr ? fmtINR(mid.cr) : ''}</td>
                              <td className="num dr">{midDr ? fmtINR(midDr) : ''}</td>
                              <td className="num cr">{midCr ? fmtINR(midCr) : ''}</td>
                            </tr>

                            {!mCollapsed && mid.subs.map((sub) => {
                              const sDr = sub.dr > sub.cr ? (sub.dr - sub.cr) : 0;
                              const sCr = sub.cr > sub.dr ? (sub.cr - sub.dr) : 0;
                              const sDrcr = sDr ? 'dr' : 'cr';
                              const sAmt  = sDrcr === 'dr' ? sDr : sCr;
                              const sIdx  = ++__idx;
                              return (
                                <tr key={`s:${primary.name}:${mid.name}:${sub.name}`}
                                    className={'tb-row-sub' + (sIdx === activeIdx ? ' tb-active' : '')}
                                    onClick={() => openGroup(sub.name, mid.name, sDrcr, sAmt)}>
                                  <td className="l">
                                    <div className="sh">
                                      <span className="name">{sub.name}</span>
                                      <span className="tb-arrow">→</span>
                                    </div>
                                  </td>
                                  <td className="col-opening num"></td>
                                  <td className="col-tx-dr num dr">{sub.dr ? fmtINR(sub.dr) : ''}</td>
                                  <td className="col-tx-cr num cr">{sub.cr ? fmtINR(sub.cr) : ''}</td>
                                  <td className="num dr">{sDr ? fmtINR(sDr) : ''}</td>
                                  <td className="num cr">{sCr ? fmtINR(sCr) : ''}</td>
                                </tr>
                              );
                            })}
                          </React.Fragment>
                        );
                      })}
                    </React.Fragment>
                  );
                })}
              </tbody>
            </table>
          )}
        </div>

        {/* Grand Total — fixed strip above the F-bar. Uses a separate
            table with the same colgroup widths so the Particulars/Dr/Cr
            columns line up exactly with the scrolling table above. */}
        {!loading && tree.length > 0 && (
          <div className="tb-totalbar">
            <table className="tb-table">
              <colgroup>
                <col />
                <col className="col-opening" />
                <col className="col-tx-dr" />
                <col className="col-tx-cr" />
                <col />
                <col />
              </colgroup>
              <tbody>
                <tr className="tb-row-total">
                  <td className="l"><span className="label">Grand Total</span></td>
                  <td className="col-opening num"></td>
                  <td className="col-tx-dr num dr">{fmtINR(t.debit)}</td>
                  <td className="col-tx-cr num cr">{fmtINR(t.credit)}</td>
                  <td className="num dr">{fmtINR(t.debit)}</td>
                  <td className="num cr">{fmtINR(t.credit)}</td>
                </tr>
              </tbody>
            </table>
          </div>
        )}

        <div className="tb-fbar">
          <span className="fkey"><kbd>F5</kbd> Detailed / Condensed</span>
          <span className="fkey"><kbd>Enter</kbd> Drill into group</span>
          <span className="fkey"><kbd>Esc</kbd> Back</span>
        </div>

        {/* ── ACTION STRIP — canonical "balance-style" report pattern.
            F2 opens the smart-input range popup; F5 toggles the
            Condensed / Detailed view (replaces the existing window
            keydown listener — strip is single source of truth);
            F9 prints; F10 exports to Excel; F1 drills into the
            cursored group. */}
        <ActionStrip
          actions={[
            { id: 'back', key: 'Esc', label: 'Back',
              onAction: () => navigate('/reports') },
            { id: 'period', key: 'F2', label: 'Period',
              onAction: () => openDate({
                mode: 'range',
                title: 'Trial Balance Period',
                value: from && to ? [dayjs(from), dayjs(to)] : null,
                onConfirm: ([f, t]) => { setFrom(f.format('YYYY-MM-DD')); setTo(t.format('YYYY-MM-DD')); },
              }) },
            { id: 'view', key: 'F5', label: view === 'closing' ? 'Detailed' : 'Condensed',
              onAction: () => setView(v => v === 'closing' ? 'tally' : 'closing'),
              title: 'Toggle Condensed / Detailed view' },
            { id: 'refresh', key: 'F4', label: 'Refresh',
              onAction: () => loadData() },
            { id: 'print', key: 'F9', label: 'Print',
              onAction: () => window.print() },
            { id: 'export', key: 'F10', label: 'Export',
              onAction: () => exportExcel(data) },
            { id: 'drill', key: 'F1', label: 'Drill', tone: 'primary',
              disabled: activeIdx < 0 || !navRows[activeIdx],
              onAction: () => navRows[activeIdx]?.action?.() },
          ]}
        />
      </>}

      {/* ════════════ PAGE 2: Group Summary ════════════ */}
      {page === 'group' && activeGroup && (
        <>
          <div className="tb-hd tb-hd-group">
            <div className="tb-title">
              <h1>{activeGroup.name}</h1>
            </div>
            <div className="tb-search">
              <SearchOutlined />
              <input
                placeholder="Filter ledgers in this group…"
                value={groupSearch}
                onChange={(e) => setGroupSearch(e.target.value)}
              />
            </div>
            <div className="tb-actions">
              <button className={'tb-btn ' + (view === 'closing' ? 'on' : '')} onClick={() => setView('closing')}>
                <span className="fk">F5</span> Condensed
              </button>
              <button className={'tb-btn ' + (view === 'tally' ? 'on' : '')} onClick={() => setView('tally')}>
                <span className="fk">F5</span> Detailed
              </button>
              <button className="tb-btn tb-btn-icon" onClick={() => window.print()} title="Print"><PrinterOutlined /></button>
              <button className="tb-btn tb-btn-icon" onClick={() => exportExcel(data, activeGroup)} title="Excel"><FileExcelOutlined /></button>
              <DatePicker.RangePicker
                size="small"
                format="DD-MMM-YY"
                suffixIcon={<CalendarOutlined />}
                allowClear={false}
                value={from && to ? [dayjs(from), dayjs(to)] : null}
                onChange={(v) => {
                  if (!v?.[0] || !v?.[1]) return;
                  setFrom(v[0].format('YYYY-MM-DD'));
                  setTo(v[1].format('YYYY-MM-DD'));
                }}
                style={{ height: 30 }}
              />
            </div>
          </div>

          <div className="tb-scroll" ref={scrollRef}>
            {groupLedgers.length === 0 ? (
              <div className="tb-empty">
                {groupSearch ? `No ledgers match "${groupSearch}".` : 'No ledgers in this group.'}
              </div>
            ) : (
              <table className="tb-table">
                <colgroup>
                  <col />
                  <col className="col-opening" />
                  <col className="col-tx-dr" />
                  <col className="col-tx-cr" />
                  <col />
                  <col />
                </colgroup>
                <thead>
                  <tr>
                    <th className="l">Particulars</th>
                    <th className="col-opening">Opening Balance<span className="sub">as on {fyStart ? dayjs(fyStart).format('D-MMM-YY') : '—'}</span></th>
                    <th className="col-tx-dr">Transactions<span className="sub">Debit</span></th>
                    <th className="col-tx-cr">Transactions<span className="sub">Credit</span></th>
                    <th>Closing Balance<span className="sub">Debit</span></th>
                    <th>Closing Balance<span className="sub">Credit</span></th>
                  </tr>
                </thead>
                <tbody>
                  {groupLedgers.map((row, i) => (
                    <tr key={row.ledger_id}
                        className={'tb-row-ledger' + (i === activeIdx ? ' tb-active' : '')}
                        onClick={() => openLedger(row)}>
                      <td className="l">
                        <div className="lh">
                          <span className="name">{row.ledger_name}</span>
                          {row.is_party_ledger && <span className="pill">Party</span>}
                          <span className="tb-arrow">→</span>
                        </div>
                      </td>
                      <td className="col-opening num"></td>
                      <td className="col-tx-dr num dr">{row.debit  ? fmtINR(row.debit)  : ''}</td>
                      <td className="col-tx-cr num cr">{row.credit ? fmtINR(row.credit) : ''}</td>
                      <td className={'num dr' + (row.debit  ? '' : ' zero')}>{row.debit  ? fmtINR(row.debit)  : '—'}</td>
                      <td className={'num cr' + (row.credit ? '' : ' zero')}>{row.credit ? fmtINR(row.credit) : '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>

          {/* Group Total — fixed strip above the F-bar */}
          {groupLedgers.length > 0 && (
            <div className="tb-totalbar">
              <table className="tb-table">
                <colgroup>
                  <col />
                  <col className="col-opening" />
                  <col className="col-tx-dr" />
                  <col className="col-tx-cr" />
                  <col />
                  <col />
                </colgroup>
                <tbody>
                  <tr className="tb-row-total">
                    <td className="l"><span className="label">Group Total — {activeGroup.name}</span></td>
                    <td className="col-opening num"></td>
                    <td className="col-tx-dr num dr">{fmtINR(groupTotals.dr)}</td>
                    <td className="col-tx-cr num cr">{fmtINR(groupTotals.cr)}</td>
                    <td className="num dr">{groupTotals.dr > groupTotals.cr ? fmtINR(groupTotals.dr - groupTotals.cr) : ''}</td>
                    <td className="num cr">{groupTotals.cr > groupTotals.dr ? fmtINR(groupTotals.cr - groupTotals.dr) : ''}</td>
                  </tr>
                </tbody>
              </table>
            </div>
          )}

          <div className="tb-fbar">
            <span className="fkey" onClick={goBack}><kbd>Esc</kbd> Back to Trial Balance</span>
            <span className="fkey"><kbd>F5</kbd> Detailed / Condensed</span>
            <span className="fkey"><kbd>Enter</kbd> Drill into ledger</span>
          </div>
        </>
      )}
    </div>
  );
}

function fmtCount(v) {
  return Number(v || 0).toLocaleString('en-IN');
}

async function exportExcel(data, scope) {
  if (!data?.ledgers) return;
  const ExcelJS = (await import('exceljs')).default;
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet(scope ? `TB · ${scope.name}` : 'Trial Balance');
  ws.columns = [
    { header: 'Group',     key: 'g',  width: 16 },
    { header: 'Sub-group', key: 'sg', width: 24 },
    { header: 'Account',   key: 'n',  width: 36 },
    { header: 'Debit',     key: 'dr', width: 18 },
    { header: 'Credit',    key: 'cr', width: 18 },
  ];
  const rows = scope
    ? data.ledgers.filter(r => {
        const sub = r.sub_group || '(Uncategorised)';
        return sub === scope.name
            || midFor(r.ledger_group, sub) === scope.name
            || r.ledger_group === scope.name;
      })
    : data.ledgers;
  for (const r of rows) {
    ws.addRow({ g: r.ledger_group, sg: r.sub_group || '', n: r.ledger_name, dr: r.debit || '', cr: r.credit || '' });
  }
  const t = data.totals || {};
  ws.addRow({});
  ws.addRow({ n: 'TOTAL', dr: t.debit || 0, cr: t.credit || 0 });
  const buf = await wb.xlsx.writeBuffer();
  const url = URL.createObjectURL(new Blob([buf], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = scope
    ? `trial-balance-${scope.name.replace(/[^a-z0-9]+/gi, '-').toLowerCase()}-${data.period?.from}-to-${data.period?.to}.xlsx`
    : `trial-balance-${data.period?.from}-to-${data.period?.to}.xlsx`;
  document.body.appendChild(a); a.click(); document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
