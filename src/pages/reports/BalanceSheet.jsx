// ── Balance Sheet ──────────────────────────────────────────────────────
//
// TallyPrime-style two-column Balance Sheet with drill-by-page.
//
//   Left  side: Liabilities + Capital (incl. synthetic Profit & Loss A/c)
//   Right side: Assets (incl. synthetic Stock-in-Hand)
//   Total bar  : pinned at the bottom, both sides equal when books balance
//
// Each side's primaries are the Tally intermediate groups (Capital
// Account, Loans, Current Liabilities | Fixed Assets, Investments,
// Current Assets). Default-collapsed; click expands inline. Click on a
// sub-group drills into the shared Group Summary at
// /reports/trial-balance?group=… so the drill destination is consistent
// across both reports.

import React, { useEffect, useMemo, useState, useCallback } from 'react';
import { message, Spin, DatePicker } from 'antd';
import {
  PrinterOutlined, FileExcelOutlined, ReloadOutlined,
  CalendarOutlined,
} from '@ant-design/icons';
import { useNavigate } from 'react-router-dom';
import dayjs from 'dayjs';
import { reportAPI } from '../../api';
import { useFinancialYear } from '../../hooks/useFinancialYear';
import './balance-sheet.css';

const fmtINR = (v) =>
  Number(v || 0).toLocaleString('en-IN', {
    minimumFractionDigits: 2, maximumFractionDigits: 2,
  });

// ── Tally intermediate group mapping ──────────────────────────────────
// Same convention as TrialBalance.jsx: keyed by primary so the same
// sub_group name classifies correctly under each side. Anything not
// listed falls back to using the sub_group itself as its own primary.
const SUB_TO_MID = {
  Assets: {
    'Sundry Debtors':            'Current Assets',
    'Cash-in-Hand':              'Current Assets',
    'Bank Accounts':             'Current Assets',
    'Bank Account':              'Current Assets',
    'Stock-in-Hand':             'Current Assets',
    'Loans & Advances (Asset)':  'Current Assets',
    'Loans and Advances (Asset)':'Current Assets',
    'Deposits (Asset)':          'Current Assets',
    'Other Current Assets':      'Current Assets',
    'Duties & Taxes':            'Current Assets',
    'Input GST':                 'Current Assets',
    'Fixed Assets':              'Fixed Assets',
    'Plant & Machinery':         'Fixed Assets',
    'Furniture & Fixtures':      'Fixed Assets',
    'Vehicles':                  'Fixed Assets',
    'Office Equipment':          'Fixed Assets',
    'Computer & Equipment':      'Fixed Assets',
    'Buildings':                 'Fixed Assets',
    'Land':                      'Fixed Assets',
    'Investments':               'Investments',
    'Misc. Expenses (Asset)':    'Misc. Expenses (Asset)',
  },
  Liabilities: {
    'Sundry Creditors':          'Current Liabilities',
    'Duties & Taxes':            'Current Liabilities',
    'Duties and Taxes':          'Current Liabilities',
    'Output GST':                'Current Liabilities',
    'Provisions':                'Current Liabilities',
    'Other Current Liabilities': 'Current Liabilities',
    'Loans (Liability)':         'Loans (Liability)',
    'Bank OD/CC':                'Loans (Liability)',
    'Bank OD A/c':               'Loans (Liability)',
    'Secured Loans':             'Loans (Liability)',
    'Unsecured Loans':           'Loans (Liability)',
  },
  Capital: {
    "Owner's Capital":           'Capital Account',
    "Owner's Funds":             'Capital Account',
    'Capital':                   'Capital Account',
    'Drawings':                  'Capital Account',
    'Reserves & Surplus':        'Capital Account',
    'Reserves and Surplus':      'Capital Account',
  },
};
function midFor(primary, sub) {
  return (SUB_TO_MID[primary] && SUB_TO_MID[primary][sub]) || sub;
}

// Intermediate ordering on each side (mirrors what an accountant
// expects to read top-to-bottom).
const LIAB_ORDER = ['Capital Account', 'Loans (Liability)', 'Current Liabilities'];
const ASSET_ORDER = ['Fixed Assets', 'Investments', 'Current Assets', 'Misc. Expenses (Asset)'];

// Build a side's tree from the API's per-sub_group buckets. The server
// returns sub_groups as an ARRAY of { sub_group, total, rows } (see
// `bucketBySubGroup` in financialReportsController.js); we accept
// either array or keyed-object and normalise on the way in. Returns
// [{ name, total, subs: [{ name, total }, …] }, …] grouped by Tally
// intermediate, ordered per the ORDER arrays above.
function buildSide(rawSubGroups, primarySide, orderHints) {
  if (!rawSubGroups) return [];
  const list = Array.isArray(rawSubGroups) ? rawSubGroups : Object.values(rawSubGroups);
  const buckets = new Map();
  for (const raw of list) {
    if (!raw) continue;
    const subName = raw.sub_group || raw.name || '(Uncategorised)';
    const subTotal = Number(raw.total) || 0;
    const ledgers = raw.rows || raw.ledgers || [];
    const mid = midFor(primarySide, subName);
    if (!buckets.has(mid)) buckets.set(mid, { name: mid, total: 0, subs: [] });
    const b = buckets.get(mid);
    b.subs.push({ name: subName, total: subTotal, ledgers });
    b.total += subTotal;
  }
  const result = [];
  for (const name of orderHints) {
    if (buckets.has(name)) {
      result.push(buckets.get(name));
      buckets.delete(name);
    }
  }
  for (const remaining of [...buckets.values()].sort((a, b) => a.name.localeCompare(b.name))) {
    result.push(remaining);
  }
  for (const b of result) b.subs.sort((a, b2) => a.name.localeCompare(b2.name));
  return result;
}

// Build a per-side navigation list for keyboard nav. Order matches
// what gets rendered in renderSide() so activeIdx maps 1:1 onto the
// visible rows on that side.
function buildNav(sidePrimaries, sideKey, collapsedSet, handlers) {
  const { drillSub, drillSynthetic, togglePrimary } = handlers;
  const list = [];
  for (const p of sidePrimaries) {
    const pKey = `${sideKey}:${p.name}`;
    list.push({
      kind: 'primary',
      side: sideKey,
      name: p.name,
      synthetic: p.synthetic,
      action: () => {
        if (p.synthetic) drillSynthetic(p.synthetic);
        else togglePrimary(pKey);
      },
    });
    if (p.synthetic) continue;
    if (collapsedSet.has(pKey)) continue;
    for (const sub of p.subs) {
      list.push({
        kind: 'sub',
        side: sideKey,
        name: sub.name,
        parent: p.name,
        action: () => drillSub(sub, p.name, sideKey),
      });
    }
  }
  return list;
}

// Persistent expand/collapse preference shared with Trial Balance.
const EXPAND_PREF_KEY = 'erp_report_expand_default';
function loadExpandPref() {
  try { return localStorage.getItem(EXPAND_PREF_KEY) === 'expanded'; } catch { return false; }
}
function saveExpandPref(v) {
  try { localStorage.setItem(EXPAND_PREF_KEY, v ? 'expanded' : 'collapsed'); } catch {}
}

export default function BalanceSheet() {
  const navigate = useNavigate();
  const { fyEnd } = useFinancialYear();

  const [data, setData]    = useState(null);
  const [loading, setLoad] = useState(true);
  const [asOf, setAsOf]    = useState(fyEnd || dayjs().format('YYYY-MM-DD'));
  const [userPicked, setUserPicked] = useState(false);

  // Default-expand preference (synced with Trial Balance via shared key).
  const [expandAllDefault, setExpandAllDefault] = useState(loadExpandPref);

  // Collapsed primary keys. Reseeded whenever data / preference changes.
  const [collapsed, setCollapsed] = useState(() => new Set());

  // Keyboard navigation: which side the cursor is on, and which row
  // within that side. ↑/↓ navigates within the active side; ←/→ jumps
  // to the same row position on the OTHER side (clamped if that side
  // is shorter).
  const [activeSide, setActiveSide] = useState('L');  // 'L' | 'A'
  const [activeIdx, setActiveIdx]   = useState(-1);   // index within activeSide

  useEffect(() => {
    if (fyEnd && !userPicked) setAsOf(fyEnd);
  }, [fyEnd, userPicked]);

  const loadData = useCallback(() => {
    if (!asOf) return;
    setLoad(true);
    reportAPI.balanceSheet({ to_date: asOf })
      .then((r) => setData(r.data))
      .catch((e) => message.error(e.response?.data?.error || 'Failed to load Balance Sheet'))
      .finally(() => setLoad(false));
  }, [asOf]);

  useEffect(() => { loadData(); }, [loadData]);

  // Build the two sides + synthetic rows (P&L A/c, Stock-in-Hand).
  const sides = useMemo(() => {
    if (!data) return { liab: [], assets: [] };

    const liabReal = buildSide(data.liabilities?.sub_groups || {}, 'Liabilities', LIAB_ORDER);
    const capital  = buildSide(data.liabilities?.capital_sub_groups || {}, 'Capital', ['Capital Account']);
    // Liab side stacking: Capital → Loans → Current Liabilities → P&L A/c
    const liab = [...capital, ...liabReal];
    const netProfit = Number(data.liabilities?.net_profit) || 0;
    if (netProfit > 0.01) {
      liab.push({
        name: 'Profit & Loss A/c',
        total: netProfit,
        subs: [],
        synthetic: 'pnl',
      });
    }

    const assets = buildSide(data.assets?.sub_groups || {}, 'Assets', ASSET_ORDER);
    const stockValue = Number(data.stock_value) || 0;
    if (stockValue > 0.01) {
      assets.push({
        name: 'Stock-in-Hand',
        total: stockValue,
        subs: [],
        synthetic: 'stock',
      });
    }
    const netLoss = Number(data.assets?.net_loss) || 0;
    if (netLoss > 0.01) {
      assets.push({
        name: 'Net Loss A/c',
        total: netLoss,
        subs: [],
        synthetic: 'pnl',
      });
    }

    return { liab, assets };
  }, [data]);

  // Default-collapse / -expand whenever data or the preference changes.
  useEffect(() => {
    if (!data) return;
    if (expandAllDefault) {
      setCollapsed(new Set());
    } else {
      const keys = new Set();
      for (const p of sides.liab)   keys.add(`L:${p.name}`);
      for (const p of sides.assets) keys.add(`A:${p.name}`);
      setCollapsed(keys);
    }
  }, [data, expandAllDefault]); // eslint-disable-line react-hooks/exhaustive-deps

  // Toggle one primary's collapse state.
  const togglePrimary = (key) => {
    setCollapsed(prev => {
      const next = new Set(prev);
      next.has(key) ? next.delete(key) : next.add(key);
      return next;
    });
  };

  // Drill into a sub-group: route to the shared Group Summary view on
  // the Trial Balance page so users get the same destination from both
  // reports.
  const drillSub = (sub, parent, side) => {
    const drcr = side === 'L' ? 'cr' : 'dr';
    const qs = new URLSearchParams({
      group: sub.name,
      parent,
      drcr,
      amount: String(sub.total ?? ''),
    });
    navigate(`/reports/trial-balance?${qs.toString()}`);
  };

  // Synthetic primaries (P&L A/c, Stock-in-Hand): clicking drills into
  // a meaningful related view rather than a Group Summary that would be
  // empty (these aren't real ledger groups).
  const drillSynthetic = (kind) => {
    if (kind === 'pnl')   navigate('/reports/profit-loss');
    if (kind === 'stock') navigate('/stock-report');
  };

  // Build per-side navigable lists for keyboard navigation. Each side
  // is independent — ↑/↓ stays within the active side, ←/→ jumps to
  // the same row position on the other side. Children are interleaved
  // when their primary is expanded.
  const navL = useMemo(() => buildNav(sides.liab, 'L', collapsed, { drillSub, drillSynthetic, togglePrimary }),
    [sides.liab, collapsed]); // eslint-disable-line react-hooks/exhaustive-deps
  const navR = useMemo(() => buildNav(sides.assets, 'A', collapsed, { drillSub, drillSynthetic, togglePrimary }),
    [sides.assets, collapsed]); // eslint-disable-line react-hooks/exhaustive-deps

  // Keep (activeSide, activeIdx) valid as the lists grow/shrink.
  useEffect(() => {
    const list = activeSide === 'L' ? navL : navR;
    setActiveIdx(prev => {
      if (list.length === 0) {
        // Fall back to whichever side has rows.
        const other = activeSide === 'L' ? navR : navL;
        if (other.length > 0) { setActiveSide(activeSide === 'L' ? 'A' : 'L'); return 0; }
        return -1;
      }
      if (prev < 0)             return 0;
      if (prev >= list.length)  return list.length - 1;
      return prev;
    });
  }, [navL.length, navR.length, activeSide]);

  // ── Keyboard ──
  // Esc is intentionally NOT handled here — AppLayout owns Esc →
  // history.back() which Just Works given our URL-driven drill flow.
  useEffect(() => {
    sessionStorage.setItem('reports_hub_back', '1');
    const onKey = (e) => {
      const tag = (document.activeElement?.tagName || '').toLowerCase();
      const inField = tag === 'input' || tag === 'textarea' || tag === 'select';
      if (inField) return;

      if (e.key === 'F5') {
        e.preventDefault();
        const next = !expandAllDefault;
        setExpandAllDefault(next);
        saveExpandPref(next);
        return;
      }
      const list = activeSide === 'L' ? navL : navR;
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setActiveIdx(i => Math.min((i < 0 ? -1 : i) + 1, list.length - 1));
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        setActiveIdx(i => Math.max(i - 1, 0));
      } else if (e.key === 'ArrowRight') {
        // Jump to the Assets side, keeping same row position (clamped).
        e.preventDefault();
        if (navR.length > 0) {
          setActiveSide('A');
          setActiveIdx(i => Math.min(Math.max(i, 0), navR.length - 1));
        }
      } else if (e.key === 'ArrowLeft') {
        // Jump back to Liabilities side at the same row position.
        e.preventDefault();
        if (navL.length > 0) {
          setActiveSide('L');
          setActiveIdx(i => Math.min(Math.max(i, 0), navL.length - 1));
        }
      } else if (e.key === 'Home') {
        e.preventDefault();
        setActiveIdx(list.length > 0 ? 0 : -1);
      } else if (e.key === 'End') {
        e.preventDefault();
        setActiveIdx(list.length - 1);
      } else if (e.key === 'Enter') {
        if (activeIdx >= 0 && list[activeIdx]) {
          e.preventDefault();
          list[activeIdx].action();
        }
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [navL, navR, activeSide, activeIdx, expandAllDefault]);

  // Helper: side renderer. Walks the same order as navRows so the
  // active-index highlights line up with arrow-key navigation.
  const renderSide = (primaries, sideKey, idxRef) => {
    const out = [];
    const isThisSide = sideKey === activeSide;
    for (const p of primaries) {
      const pKey = `${sideKey}:${p.name}`;
      const pCollapsed = collapsed.has(pKey);
      const myIdx = idxRef.value++;
      const isActive = isThisSide && myIdx === activeIdx;
      out.push(
        <tr key={pKey}
            className={
              'bs-row-group'
              + (p.synthetic === 'pnl' ? ' bs-row-pnl' : '')
              + (p.synthetic === 'stock' ? ' bs-row-info' : '')
              + (isActive ? ' bs-active' : '')
            }
            onClick={() => p.synthetic ? drillSynthetic(p.synthetic) : togglePrimary(pKey)}>
          <td>
            <div className="gh">
              <span className={'bs-chev ' + (p.synthetic ? 'hidden' : (pCollapsed ? 'collapsed' : ''))}>▾</span>
              <span className="name">
                {p.name}
                {/* COMPUTED badges removed — redundant (everything in
                    a software is computed). The accent / warning row
                    tint still differentiates synthetic rows from real
                    ledger groups at a glance. */}
              </span>
              {p.synthetic && <span className="arrow">→</span>}
            </div>
          </td>
          <td className="num">{p.total ? fmtINR(p.total) : '—'}</td>
        </tr>
      );
      if (p.synthetic) continue;
      if (pCollapsed) continue;
      for (const sub of p.subs) {
        const sIdx = idxRef.value++;
        const sActive = isThisSide && sIdx === activeIdx;
        out.push(
          <tr key={`${pKey}::${sub.name}`}
              className={'bs-row-sub' + (sActive ? ' bs-active' : '')}
              onClick={() => drillSub(sub, p.name, sideKey)}>
            <td>
              <div className="sh">
                <span className="name">{sub.name}</span>
                <span className="arrow">→</span>
              </div>
            </td>
            <td className="num">{sub.total ? fmtINR(sub.total) : '—'}</td>
          </tr>
        );
      }
    }
    return out;
  };

  // Fresh idx counters PER SIDE — activeIdx is per-side now, so each
  // side's render must reset to 0 (matches buildNav() per-side ordering).
  const liabRows   = data ? renderSide(sides.liab,   'L', { value: 0 }) : null;
  const assetsRows = data ? renderSide(sides.assets, 'A', { value: 0 }) : null;

  const lTotal = Number(data?.totals?.total_liabilities) || 0;
  const aTotal = Number(data?.totals?.total_assets)      || 0;

  return (
    <div className="bs-page">

      {/* Title bar */}
      <div className="bs-hd">
        <div className="bs-title">
          <h1>Balance Sheet</h1>
        </div>
        <div className="bs-actions">
          <button className={'bs-btn ' + (!expandAllDefault ? 'on' : '')}
                  onClick={() => { setExpandAllDefault(false); saveExpandPref(false); }}
                  title="Show only top-level groups">
            Collapsed
          </button>
          <button className={'bs-btn ' + (expandAllDefault ? 'on' : '')}
                  onClick={() => { setExpandAllDefault(true); saveExpandPref(true); }}
                  title="Show all sub-groups expanded">
            Expanded
          </button>
          <button className="bs-btn bs-btn-icon" onClick={loadData} title="Refresh">
            <ReloadOutlined />
          </button>
          <button className="bs-btn bs-btn-icon" onClick={() => window.print()} title="Print">
            <PrinterOutlined />
          </button>
          <button className="bs-btn bs-btn-icon" onClick={() => exportExcel(data, asOf)} title="Excel">
            <FileExcelOutlined />
          </button>
          <div className="bs-dp">
            <span className="lbl">As on</span>
            <DatePicker
              size="small"
              format="DD-MMM-YY"
              suffixIcon={<CalendarOutlined />}
              allowClear={false}
              value={asOf ? dayjs(asOf) : null}
              onChange={(v) => {
                if (!v) return;
                setAsOf(v.format('YYYY-MM-DD'));
                setUserPicked(true);
              }}
              variant="borderless"
            />
          </div>
        </div>
      </div>

      {/* Header bar — single continuous underline across both sides */}
      <div className="bs-headbar">
        <div className="bs-side">
          <div className="hh">
            <span>Liabilities</span>
            <span className="r">
              Closing Balance
              <span className="sub">as on {asOf ? dayjs(asOf).format('D-MMM-YY') : '—'}</span>
            </span>
          </div>
        </div>
        <div className="bs-side">
          <div className="hh">
            <span>Assets</span>
            <span className="r">
              Closing Balance
              <span className="sub">as on {asOf ? dayjs(asOf).format('D-MMM-YY') : '—'}</span>
            </span>
          </div>
        </div>
      </div>

      {/* Two-column body */}
      <div className="bs-body">
        <div className="bs-side">
          <table className="bs-table">
            <colgroup><col /><col style={{ width: 200 }} /></colgroup>
            <tbody>
              {loading ? (
                <tr><td colSpan={2} className="bs-loading"><Spin /> Loading…</td></tr>
              ) : !data || sides.liab.length === 0 ? (
                <tr><td colSpan={2} className="bs-empty">No liabilities recorded.</td></tr>
              ) : liabRows}
            </tbody>
          </table>
        </div>

        <div className="bs-side">
          <table className="bs-table">
            <colgroup><col /><col style={{ width: 200 }} /></colgroup>
            <tbody>
              {loading ? (
                <tr><td colSpan={2} className="bs-loading"><Spin /> Loading…</td></tr>
              ) : !data || sides.assets.length === 0 ? (
                <tr><td colSpan={2} className="bs-empty">No assets recorded.</td></tr>
              ) : assetsRows}
            </tbody>
          </table>
        </div>
      </div>

      {/* Total bar (sticky bottom) */}
      {data && (
        <div className="bs-totalbar">
          <div className="bs-side">
            <table>
              <colgroup><col /><col style={{ width: 200 }} /></colgroup>
              <tbody>
                <tr className="bs-row-total">
                  <td><span className="label">Total · Liabilities</span></td>
                  <td className="num">{fmtINR(lTotal)}</td>
                </tr>
              </tbody>
            </table>
          </div>
          <div className="bs-side">
            <table>
              <colgroup><col /><col style={{ width: 200 }} /></colgroup>
              <tbody>
                <tr className="bs-row-total">
                  <td><span className="label">Total · Assets</span></td>
                  <td className="num">{fmtINR(aTotal)}</td>
                </tr>
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* F-bar */}
      <div className="bs-fbar">
        <span className="fkey"><kbd>F5</kbd> Collapse / Expand all</span>
        <span className="fkey"><kbd>↑</kbd> <kbd>↓</kbd> Navigate</span>
        <span className="fkey"><kbd>Enter</kbd> Drill into group</span>
        <span className="fkey"><kbd>Esc</kbd> Back</span>
        <span className="grow"></span>
      </div>
    </div>
  );
}

async function exportExcel(data, asOf) {
  if (!data) return;
  const ExcelJS = (await import('exceljs')).default;
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Balance Sheet');
  ws.columns = [
    { header: 'Side',        key: 's',  width: 14 },
    { header: 'Group',       key: 'g',  width: 24 },
    { header: 'Sub-group',   key: 'sg', width: 28 },
    { header: 'Amount',      key: 'a',  width: 18 },
  ];
  const dump = (sideName, raw, primarySide) => {
    if (!raw) return;
    const list = Array.isArray(raw) ? raw : Object.values(raw);
    for (const sub of list) {
      if (!sub) continue;
      const subName = sub.sub_group || sub.name || '(Uncategorised)';
      const mid = midFor(primarySide, subName);
      ws.addRow({ s: sideName, g: mid, sg: subName, a: Number(sub.total) || 0 });
    }
  };
  dump('Liabilities', data.liabilities?.sub_groups, 'Liabilities');
  dump('Liabilities', data.liabilities?.capital_sub_groups, 'Capital');
  if ((data.liabilities?.net_profit || 0) > 0) {
    ws.addRow({ s: 'Liabilities', g: 'Profit & Loss A/c', sg: '(computed)', a: data.liabilities.net_profit });
  }
  dump('Assets', data.assets?.sub_groups, 'Assets');
  if ((data.stock_value || 0) > 0) {
    ws.addRow({ s: 'Assets', g: 'Stock-in-Hand', sg: '(computed)', a: data.stock_value });
  }
  ws.addRow({});
  ws.addRow({ s: 'TOTAL', g: 'Liabilities', sg: '', a: data.totals?.total_liabilities || 0 });
  ws.addRow({ s: 'TOTAL', g: 'Assets',      sg: '', a: data.totals?.total_assets      || 0 });

  const buf = await wb.xlsx.writeBuffer();
  const url = URL.createObjectURL(new Blob([buf], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = `balance-sheet-as-on-${asOf}.xlsx`;
  document.body.appendChild(a); a.click(); document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
