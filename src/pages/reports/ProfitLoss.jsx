// ── Profit & Loss ──────────────────────────────────────────────────────
//
// TallyPrime-shape two-column statement.
//
//   Left  side (Dr):  Opening Stock · Purchase Accounts · Direct Exp ·
//                     Gross Profit c/o · Indirect Exp · Net Profit
//   Right side (Cr):  Sales Accounts · Closing Stock · Direct Income ·
//                     Gross Profit b/d · Indirect Income · Net Loss
//
//   Total bar  : pinned at the bottom; both sides equal (I1) when the
//                journal is balanced.
//
// All numbers come from /api/reports/profit-loss which sources from
// ledger_entries (single source of truth). The new controller
// (financialReportsController.profitLoss) returns a structured
// two-column response with optional comparative-period column.
//
// Drill-down conventions:
//   · Click on a Sales / Purchase / Direct / Indirect ledger row →
//     Trial Balance ledger view filtered to the same period (shared
//     drill destination across reports for muscle-memory consistency).
//   · Click on Opening Stock / Closing Stock                     →
//     Stock Summary (the inventory-side report).
//   · Click on a balancing figure (GP, NP, GL, NL)               →
//     no-op (computed, not a real ledger).
//
// Reuses balance-sheet.css for the editorial shell so the visual
// treatment is identical between BS and P&L. profit-loss.css adds the
// P&L-specific overrides (stage divider, sub-rows for returns netting,
// comparative-column sizing, banner styles).

import React, { useEffect, useMemo, useState, useCallback } from 'react';
import { message, Spin, DatePicker, Dropdown } from 'antd';
import {
  ReloadOutlined,
  CalendarOutlined, DownOutlined, WhatsAppOutlined,
} from '@ant-design/icons';
import { useNavigate, useSearchParams } from 'react-router-dom';
import dayjs from 'dayjs';
import { reportAPI } from '../../api';
import { useFinancialYear } from '../../hooks/useFinancialYear';
import ActionStrip from '../../components/keyboard/ActionStrip';
import { useDatePopup } from '../../components/keyboard/DatePopup';
import './balance-sheet.css';
import './profit-loss.css';

const { RangePicker } = DatePicker;

const fmtINR = (v) =>
  Number(v || 0).toLocaleString('en-IN', {
    minimumFractionDigits: 2, maximumFractionDigits: 2,
  });

// Show a dash for sub-paisa values so empty rows don't shout zeros at
// the reader. Threshold mirrors the controller's r2 rounding.
const fmtMaybe = (v) => (Math.abs(Number(v) || 0) < 0.005 ? '—' : fmtINR(v));

// Union the lines of a Sales/Purchase Accounts bucket across current
// and comparative periods, filtered by a kind ('sale'|'purchase'|'return').
// Returns one entry per unique ledger_id with both period amounts so the
// row stays visible even when only one period has activity for that
// ledger. compAmount defaults to 0 when there's no comparative match —
// so a ledger that exists only in the current period still renders the
// 0 value in its previous-period column (rather than blank).
function unionByLedger(curLines, cmpLines, kind) {
  const cur = (curLines || []).filter((l) => l.kind === kind);
  const cmp = (cmpLines || []).filter((l) => l.kind === kind);
  const byId = new Map();
  for (const l of cur) byId.set(l.ledger_id, { ...l, compAmount: 0 });
  for (const l of cmp) {
    const existing = byId.get(l.ledger_id);
    if (existing) existing.compAmount = l.amount;
    else byId.set(l.ledger_id, { ...l, amount: 0, compAmount: l.amount });
  }
  return [...byId.values()];
}

// ── Period presets ────────────────────────────────────────────────────
//
// Quick options: This FY, Last FY, This Quarter, This Month, Custom.
// "FY" boundaries come from the company-configured FY (useFinancialYear)
// rather than hardcoded April–March, so installations on a different
// fiscal calendar get correct presets.
// Persistent expand/collapse preference shared with Balance Sheet +
// Trial Balance (single key so all three reports follow the same
// preference). 'collapsed' = only show aggregate Net rows; 'expanded'
// = show all the constituent ledger sub-rows.
const EXPAND_PREF_KEY = 'erp_report_expand_default';
function loadExpandPref() {
  try { return localStorage.getItem(EXPAND_PREF_KEY) === 'expanded'; } catch { return false; }
}
function saveExpandPref(v) {
  try { localStorage.setItem(EXPAND_PREF_KEY, v ? 'expanded' : 'collapsed'); } catch {}
}

function buildPresets(fyStart, fyEnd) {
  const today = dayjs();
  const fy   = fyStart && fyEnd ? { from: dayjs(fyStart), to: dayjs(fyEnd) } : null;
  const lastFy = fy ? { from: fy.from.subtract(1, 'year'), to: fy.to.subtract(1, 'year') } : null;
  return {
    this_fy:    fy && { label: 'This Financial Year',     from: fy.from,     to: fy.to },
    last_fy:    lastFy && { label: 'Last Financial Year', from: lastFy.from, to: lastFy.to },
    this_q:     { label: 'This Quarter',                  from: today.startOf('quarter'), to: today.endOf('quarter') },
    this_month: { label: 'This Month',                    from: today.startOf('month'),   to: today.endOf('month') },
  };
}

export default function ProfitLoss() {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const { fyStart, fyEnd } = useFinancialYear();

  // Drill-from-URL — when navigated to via ?from_date=&to_date= (eg. from
  // Fund Flow's "Net Profit" row drilling into P&L for a single month),
  // honour those bounds AS the initial period and skip the FY-snap that
  // would otherwise overwrite them. Validation is lax-on-purpose: any
  // ISO-shaped date passes; bad input falls back to the FY default.
  const initialFrom = (() => {
    const q = searchParams.get('from_date');
    return /^\d{4}-\d{2}-\d{2}$/.test(q) ? q : null;
  })();
  const initialTo = (() => {
    const q = searchParams.get('to_date');
    return /^\d{4}-\d{2}-\d{2}$/.test(q) ? q : null;
  })();
  // Sticky URL-driven flag — once set, the FY-snap effect below treats
  // it like a user pick and stays out of the way.
  const drilledFromUrl = !!(initialFrom && initialTo);

  const [data, setData]    = useState(null);
  const [loading, setLoad] = useState(true);
  // Audit P2-O — distinct error state. Pre-fix, a 500 from the server
  // only flashed a toast; the table fell through to the empty-state
  // ("no expense activity"), which looked indistinguishable from a
  // genuinely empty period. The banner below tells the operator the
  // server failed and offers a retry.
  const [loadError, setLoadError] = useState(null);

  // Period state — defaults to current FY once the hook resolves, unless
  // we were navigated to with explicit ?from_date/to_date (drill).
  const [from, setFrom] = useState(initialFrom || fyStart || dayjs().startOf('year').format('YYYY-MM-DD'));
  const [to,   setTo]   = useState(initialTo   || fyEnd   || dayjs().format('YYYY-MM-DD'));
  const [presetKey, setPresetKey] = useState(drilledFromUrl ? 'custom' : 'this_fy');
  const [userPicked, setUserPicked] = useState(drilledFromUrl);

  // Comparative column toggle. Default off — P&L is single-period most
  // of the time; the toggle is one click for users who want YoY/QoQ.
  const [showComparative, setShowComparative] = useState(false);

  // Expand/Collapse preference (synced with BS + TB via shared key).
  // Collapsed = only show the aggregate Net rows for Sales / Purchase
  // sections (Net Sales, Net Purchases). Constituent ledger rows and
  // the section header are hidden.
  const [expandAllDefault, setExpandAllDefault] = useState(loadExpandPref);

  // Snap to FY when it arrives (if user hasn't manually picked yet).
  useEffect(() => {
    if (fyStart && fyEnd && !userPicked) {
      setFrom(fyStart); setTo(fyEnd); setPresetKey('this_fy');
    }
  }, [fyStart, fyEnd, userPicked]);

  const presets = useMemo(() => buildPresets(fyStart, fyEnd), [fyStart, fyEnd]);

  // Apply a preset by key. 'custom' is handled inline (RangePicker).
  const applyPreset = useCallback((key) => {
    const p = presets[key];
    if (!p) return;
    setFrom(p.from.format('YYYY-MM-DD'));
    setTo(p.to.format('YYYY-MM-DD'));
    setPresetKey(key);
    setUserPicked(true);
  }, [presets]);

  // Keyboard navigation: per-side cursor, ↑/↓ within side, ←/→ jumps
  // sides. Mirrors BalanceSheet's pattern so the muscle-memory carries
  // over for accountants who switch between the two reports.
  const [activeSide, setActiveSide] = useState('D'); // 'D' debit | 'C' credit
  const [activeIdx,  setActiveIdx]  = useState(-1);

  const loadData = useCallback(() => {
    if (!from || !to) return;
    setLoad(true);
    setLoadError(null);
    const params = { from_date: from, to_date: to };
    if (showComparative) params.comparative = 'auto';
    reportAPI.profitLoss(params)
      .then((r) => { setData(r.data); setLoadError(null); })
      .catch((e) => {
        const msg = e.response?.data?.error || e.message || 'Failed to load Profit & Loss';
        message.error(msg);
        setLoadError(msg);
        setData(null);
      })
      .finally(() => setLoad(false));
  }, [from, to, showComparative]);

  useEffect(() => { loadData(); }, [loadData]);

  // Drill helpers — kept as functions the row builder closes over.
  // Per-section destinations:
  //   · Sales Account / Sales Return     →  /reports/sales
  //   · Purchase Account / Purchase Ret. →  /reports/purchases
  //   · Opening Stock / Closing Stock    →  /stock-report (inventory)
  //   · Anything else (Direct/Indirect Income/Expense ledgers, Round
  //     Off, Discount Allowed/Received)  →  /reports/day-book
  //
  // Period (from/to) is propagated as a query string on every drill so
  // the destination report can preserve the same window. Destination
  // reports that don't yet parse these params will just open at their
  // default period — non-fatal.
  const periodQs = useCallback(() => {
    return new URLSearchParams({ from, to }).toString();
  }, [from, to]);

  const drillSales    = useCallback(() => navigate(`/reports/sales?${periodQs()}`), [navigate, periodQs]);
  const drillPurchase = useCallback(() => navigate(`/reports/purchases?${periodQs()}`), [navigate, periodQs]);
  const drillStock    = useCallback(() => navigate(`/stock-report`), [navigate]);

  // Generic ledger drill — for ledgers without a dedicated report
  // (Round Off, Discount Allowed/Received, Direct/Indirect Income/
  // Expense). Lands on Day Book filtered to this ledger over the same
  // period; that's the chronological voucher list (Tally calls it
  // "Ledger Vouchers").
  const drillLedger = useCallback((ledgerId, ledgerName) => {
    const qs = new URLSearchParams({
      ledger_id: String(ledgerId),
      ledger_name: ledgerName,
      from, to,
    });
    navigate(`/reports/day-book?${qs.toString()}`);
  }, [from, to, navigate]);

  // Build per-side row arrays. Each row carries:
  //   { kind, label, amount, compAmount?, computed?, drill? }
  // Order matches Tally's layout and the column-totals formula.
  const sides = useMemo(() => {
    if (!data?.current) return { debit: [], credit: [] };
    const cur = data.current;
    const cmp = data.comparative;
    const N = (v) => Number(v || 0);

    const D = []; // debit rows
    const C = []; // credit rows

    // Debit side (Dr / Expenses) ────────────────────────────────────
    D.push({
      kind: 'simple',
      label: 'Opening Stock',
      amount: N(cur.debit.opening_stock),
      compAmount: cmp ? N(cmp.debit.opening_stock) : null,
      drill: drillStock,
    });

    // Purchase Accounts — gross, less returns, net (Tally three-line block).
    // Union ledgers from current + comparative so rows that exist in only
    // one period still appear (with 0 in the other column) — important for
    // the comparative view; single-period view degenerates correctly.
    const pa = cur.debit.purchase_accounts;
    const cmpPa = cmp ? cmp.debit.purchase_accounts : null;
    if (pa.gross > 0 || pa.returns > 0 || (cmpPa && (cmpPa.gross > 0 || cmpPa.returns > 0))) {
      D.push({ kind: 'aggregate-header', label: 'Purchase Accounts' });
      const purchUnion = unionByLedger(pa.lines, cmpPa?.lines, 'purchase');
      for (const u of purchUnion) {
        D.push({
          kind: 'sub',
          label: u.ledger_name,
          amount: N(u.amount),
          compAmount: cmp ? N(u.compAmount) : null,
          drill: drillPurchase,
        });
      }
      const retUnion = unionByLedger(pa.lines, cmpPa?.lines, 'return');
      for (const u of retUnion) {
        D.push({
          kind: 'sub-deduction',
          label: `Less: ${u.ledger_name}`,
          amount: N(u.amount),
          compAmount: cmp ? N(u.compAmount) : null,
          drill: drillPurchase,
        });
      }
      D.push({
        kind: 'aggregate-net',
        label: 'Net Purchases',
        amount: N(pa.net),
        compAmount: cmpPa ? N(cmpPa.net) : null,
        drill: drillPurchase,
      });
    }

    // Direct Expenses — one line per ledger.
    const de = cur.debit.direct_expenses;
    const cmpDe = cmp ? cmp.debit.direct_expenses : null;
    if (de.total > 0 || (cmpDe && cmpDe.total > 0)) {
      for (const line of de.lines) {
        const cmpLine = cmpDe ? cmpDe.lines.find((l) => l.ledger_id === line.ledger_id) : null;
        D.push({
          kind: 'simple',
          label: line.ledger_name,
          amount: N(line.amount),
          compAmount: cmpLine ? N(cmpLine.amount) : 0,
          drill: () => drillLedger(line.ledger_id, line.ledger_name),
        });
      }
      if (de.lines.length > 1) {
        D.push({
          kind: 'subtotal',
          label: 'Direct Expenses (subtotal)',
          amount: N(de.total),
          compAmount: cmpDe ? N(cmpDe.total) : null,
        });
      }
    }

    // Stage-1 close (Gross Profit c/o or Gross Loss b/d).
    if (cur.debit.gross_profit_co > 0 || (cmp && cmp.debit.gross_profit_co > 0)) {
      D.push({
        kind: 'balancing',
        label: 'Gross Profit c/o',
        amount: N(cur.debit.gross_profit_co),
        compAmount: cmp ? N(cmp.debit.gross_profit_co) : null,
      });
    }
    if (cur.debit.gross_loss_bd > 0 || (cmp && cmp.debit.gross_loss_bd > 0)) {
      D.push({
        kind: 'balancing',
        label: 'Gross Loss b/d',
        amount: N(cur.debit.gross_loss_bd),
        compAmount: cmp ? N(cmp.debit.gross_loss_bd) : null,
      });
    }
    D.push({ kind: 'stage-divider' });

    // Indirect Expenses — one line per ledger.
    const ie = cur.debit.indirect_expenses;
    const cmpIe = cmp ? cmp.debit.indirect_expenses : null;
    if (ie.total > 0 || (cmpIe && cmpIe.total > 0)) {
      for (const line of ie.lines) {
        const cmpLine = cmpIe ? cmpIe.lines.find((l) => l.ledger_id === line.ledger_id) : null;
        D.push({
          kind: 'simple',
          label: line.ledger_name,
          amount: N(line.amount),
          compAmount: cmpLine ? N(cmpLine.amount) : 0,
          drill: () => drillLedger(line.ledger_id, line.ledger_name),
        });
      }
    }

    // Stage-2 close — Net Profit (debit side).
    if (cur.debit.net_profit > 0 || (cmp && cmp.debit.net_profit > 0)) {
      D.push({
        kind: 'final',
        label: 'Net Profit',
        amount: N(cur.debit.net_profit),
        compAmount: cmp ? N(cmp.debit.net_profit) : null,
      });
    }

    // Credit side (Cr / Income) ─────────────────────────────────────
    const sa = cur.credit.sales_accounts;
    const cmpSa = cmp ? cmp.credit.sales_accounts : null;
    if (sa.gross > 0 || sa.returns > 0 || (cmpSa && (cmpSa.gross > 0 || cmpSa.returns > 0))) {
      C.push({ kind: 'aggregate-header', label: 'Sales Accounts' });
      const salesUnion = unionByLedger(sa.lines, cmpSa?.lines, 'sale');
      for (const u of salesUnion) {
        C.push({
          kind: 'sub',
          label: u.ledger_name,
          amount: N(u.amount),
          compAmount: cmp ? N(u.compAmount) : null,
          drill: drillSales,
        });
      }
      const retUnion = unionByLedger(sa.lines, cmpSa?.lines, 'return');
      for (const u of retUnion) {
        C.push({
          kind: 'sub-deduction',
          label: `Less: ${u.ledger_name}`,
          amount: N(u.amount),
          compAmount: cmp ? N(u.compAmount) : null,
          drill: drillSales,
        });
      }
      C.push({
        kind: 'aggregate-net',
        label: 'Net Sales',
        amount: N(sa.net),
        compAmount: cmpSa ? N(cmpSa.net) : null,
        drill: drillSales,
      });
    }

    C.push({
      kind: 'simple',
      label: 'Closing Stock',
      amount: N(cur.credit.closing_stock),
      compAmount: cmp ? N(cmp.credit.closing_stock) : null,
      drill: drillStock,
    });

    // Direct Income — usually empty on a wholesale book; render only if present.
    const di = cur.credit.direct_income;
    const cmpDi = cmp ? cmp.credit.direct_income : null;
    if (di.total > 0 || (cmpDi && cmpDi.total > 0)) {
      for (const line of di.lines) {
        const cmpLine = cmpDi ? cmpDi.lines.find((l) => l.ledger_id === line.ledger_id) : null;
        C.push({
          kind: 'simple',
          label: line.ledger_name,
          amount: N(line.amount),
          compAmount: cmpLine ? N(cmpLine.amount) : 0,
          drill: () => drillLedger(line.ledger_id, line.ledger_name),
        });
      }
    }

    // Stage-1 close on the Cr side (Gross Loss b/f) and stage-2 open
    // on the Cr side (Gross Profit b/d). Exactly one is non-zero.
    if (cur.credit.gross_loss_bf > 0 || (cmp && cmp.credit.gross_loss_bf > 0)) {
      C.push({
        kind: 'balancing',
        label: 'Gross Loss b/f',
        amount: N(cur.credit.gross_loss_bf),
        compAmount: cmp ? N(cmp.credit.gross_loss_bf) : null,
      });
    }
    if (cur.credit.gross_profit_bd > 0 || (cmp && cmp.credit.gross_profit_bd > 0)) {
      C.push({
        kind: 'balancing',
        label: 'Gross Profit b/d',
        amount: N(cur.credit.gross_profit_bd),
        compAmount: cmp ? N(cmp.credit.gross_profit_bd) : null,
      });
    }
    C.push({ kind: 'stage-divider' });

    // Indirect Income — one line per ledger.
    const ii = cur.credit.indirect_income;
    const cmpIi = cmp ? cmp.credit.indirect_income : null;
    if (ii.total > 0 || (cmpIi && cmpIi.total > 0)) {
      for (const line of ii.lines) {
        const cmpLine = cmpIi ? cmpIi.lines.find((l) => l.ledger_id === line.ledger_id) : null;
        C.push({
          kind: 'simple',
          label: line.ledger_name,
          amount: N(line.amount),
          compAmount: cmpLine ? N(cmpLine.amount) : 0,
          drill: () => drillLedger(line.ledger_id, line.ledger_name),
        });
      }
    }

    // Stage-2 close — Net Loss (credit side).
    if (cur.credit.net_loss > 0 || (cmp && cmp.credit.net_loss > 0)) {
      C.push({
        kind: 'final',
        label: 'Net Loss',
        amount: N(cur.credit.net_loss),
        compAmount: cmp ? N(cmp.credit.net_loss) : null,
      });
    }

    // Collapse pass — when expandAllDefault=false, drop the constituent
    // ledger rows + section headers under Sales/Purchase Accounts so
    // only the aggregate Net rows remain. Stage divider, balancing
    // figures, and Direct/Indirect single lines are always kept (they
    // carry the report's headline numbers).
    if (!expandAllDefault) {
      const drop = (k) => k === 'sub' || k === 'sub-deduction' || k === 'aggregate-header';
      return {
        debit:  D.filter((r) => !drop(r.kind)),
        credit: C.filter((r) => !drop(r.kind)),
      };
    }
    return { debit: D, credit: C };
  }, [data, expandAllDefault, drillLedger, drillStock, drillSales, drillPurchase]);

  // Per-side navigable index for keyboard nav. Skips dividers and
  // headers so Enter always lands on something useful.
  const navD = useMemo(() => sides.debit
    .map((r, i) => ({ ...r, idx: i }))
    .filter((r) => r.kind !== 'stage-divider' && r.kind !== 'aggregate-header')
  , [sides.debit]);
  const navC = useMemo(() => sides.credit
    .map((r, i) => ({ ...r, idx: i }))
    .filter((r) => r.kind !== 'stage-divider' && r.kind !== 'aggregate-header')
  , [sides.credit]);

  useEffect(() => {
    sessionStorage.setItem('reports_hub_back', '1');
    const onKey = (e) => {
      const tag = (document.activeElement?.tagName || '').toLowerCase();
      if (tag === 'input' || tag === 'textarea' || tag === 'select') return;

      if (e.key === 'F5') {
        e.preventDefault();
        const next = !expandAllDefault;
        setExpandAllDefault(next);
        saveExpandPref(next);
        return;
      }
      const list = activeSide === 'D' ? navD : navC;
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setActiveIdx((i) => Math.min((i < 0 ? -1 : i) + 1, list.length - 1));
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        setActiveIdx((i) => Math.max(i - 1, 0));
      } else if (e.key === 'ArrowRight') {
        e.preventDefault();
        if (navC.length > 0) {
          setActiveSide('C');
          setActiveIdx((i) => Math.min(Math.max(i, 0), navC.length - 1));
        }
      } else if (e.key === 'ArrowLeft') {
        e.preventDefault();
        if (navD.length > 0) {
          setActiveSide('D');
          setActiveIdx((i) => Math.min(Math.max(i, 0), navD.length - 1));
        }
      } else if (e.key === 'Home') {
        e.preventDefault();
        setActiveIdx(list.length > 0 ? 0 : -1);
      } else if (e.key === 'End') {
        e.preventDefault();
        setActiveIdx(list.length - 1);
      } else if (e.key === 'Enter') {
        if (activeIdx >= 0 && list[activeIdx]?.drill) {
          e.preventDefault();
          list[activeIdx].drill();
        }
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [navD, navC, activeSide, activeIdx, expandAllDefault]);

  // Period label for the picker button.
  const periodLabel = useMemo(() => {
    if (presetKey === 'custom')         return 'Custom range';
    if (presetKey && presets[presetKey]) return presets[presetKey].label;
    return 'Period';
  }, [presetKey, presets]);

  const periodMenu = useMemo(() => ({
    items: [
      ...['this_fy', 'last_fy', 'this_q', 'this_month']
        .filter((k) => presets[k])
        .map((k) => ({ key: k, label: presets[k].label })),
      { type: 'divider' },
      { key: 'custom', label: 'Custom range…' },
    ],
    onClick: ({ key }) => {
      if (key === 'custom') { setPresetKey('custom'); return; }
      applyPreset(key);
    },
  }), [presets, applyPreset]);

  // Render a single row across both sides' shared layout (1 + (1|2) cols).
  const renderRow = (row, sideKey, sideRowIdx) => {
    if (row.kind === 'stage-divider') {
      // Stage 1 / Stage 2 boundary — drawn as a thin line only. The
      // GP c/o (Dr) + GP b/d (Cr) rows above already announce the
      // stage transition; an extra label is jargon-clutter.
      return (
        <tr key={`${sideKey}-divider-${sideRowIdx}`} className="pl-stage-divider">
          <td colSpan={showComparative ? 3 : 2}></td>
        </tr>
      );
    }
    const isThisSide = sideKey === activeSide;
    const list = sideKey === 'D' ? navD : navC;
    const navIdx = list.findIndex((r) => r.idx === sideRowIdx);
    const isActive = isThisSide && navIdx >= 0 && navIdx === activeIdx;

    const cls =
      'pl-row pl-row-' + row.kind
      + (isActive ? ' pl-active' : '')
      + (row.computed ? ' pl-row-computed' : '');

    const action = row.drill;
    return (
      <tr key={`${sideKey}-${sideRowIdx}-${row.label}`}
          className={cls}
          onClick={action}>
        <td className="pl-cell-label">
          <div className={'pl-name ' + (row.kind === 'sub' || row.kind === 'sub-deduction' ? 'pl-name-sub' : '')}>
            <span>{row.label}</span>
            {row.computed && <span className="pl-tag">Computed</span>}
            {action && <span className="pl-arrow">→</span>}
          </div>
        </td>
        <td className="pl-cell-num pl-cell-current">
          {row.amount === null || row.amount === undefined ? '' : fmtMaybe(row.amount)}
        </td>
        {showComparative && (
          <td className="pl-cell-num pl-cell-comp">
            {row.compAmount === null || row.compAmount === undefined ? '' : fmtMaybe(row.compAmount)}
          </td>
        )}
      </tr>
    );
  };

  // Final totals for the bottom bar.
  const debitTotal      = Number(data?.current?.debit?.total)      || 0;
  const creditTotal     = Number(data?.current?.credit?.total)     || 0;
  const compDebitTotal  = Number(data?.comparative?.debit?.total)  || 0;
  const compCreditTotal = Number(data?.comparative?.credit?.total) || 0;
  const recon = data?.current?.reconciliation;

  return (
    <div className="bs-page">

      {/* Title bar */}
      <div className="bs-hd">
        <div className="bs-title">
          <h1>Profit &amp; Loss</h1>
        </div>
        <div className="bs-actions">
          <button className={'bs-btn ' + (!expandAllDefault ? 'on' : '')}
                  onClick={() => { setExpandAllDefault(false); saveExpandPref(false); }}
                  title="Show only the aggregate Net rows (Net Sales, Net Purchases)">
            Collapsed
          </button>
          <button className={'bs-btn ' + (expandAllDefault ? 'on' : '')}
                  onClick={() => { setExpandAllDefault(true); saveExpandPref(true); }}
                  title="Show all sub-rows (sale/return ledgers under Sales/Purchase Accounts)">
            Expanded
          </button>
          <button className={'bs-btn ' + (showComparative ? 'on' : '')}
                  onClick={() => setShowComparative((v) => !v)}
                  title="Toggle previous-period comparison column">
            Comparative
          </button>
          <Dropdown menu={periodMenu} trigger={['click']}>
            <button className="bs-btn">
              {periodLabel} <DownOutlined style={{ fontSize: 9 }} />
            </button>
          </Dropdown>
          {/* Always-visible range picker. Reflects the current period,
              regardless of whether it came from a preset or a manual
              pick. Editing the dates here flips the preset to 'custom'
              so the dropdown label reads honestly. */}
          <RangePicker
            size="small"
            format="DD-MMM-YY"
            suffixIcon={<CalendarOutlined />}
            allowClear={false}
            value={[from ? dayjs(from) : null, to ? dayjs(to) : null]}
            onChange={(v) => {
              if (!v || !v[0] || !v[1]) return;
              setFrom(v[0].format('YYYY-MM-DD'));
              setTo(v[1].format('YYYY-MM-DD'));
              setPresetKey('custom');
              setUserPicked(true);
            }}
          />
          <button className="bs-btn bs-btn-icon" onClick={loadData} title="Refresh">
            <ReloadOutlined />
          </button>
          <button className="bs-btn bs-btn-icon" onClick={() => shareWhatsApp(data, from, to)} title="Share summary via WhatsApp">
            <WhatsAppOutlined />
          </button>
          {/* Print + Excel moved to the bottom strip (F9 / F10). */}
        </div>
      </div>

      {/* Reconciliation banner — only shown when an invariant is broken */}
      {recon && !recon.balanced && (
        <div className="pl-banner pl-banner-error">
          <strong>P&amp;L does not balance.</strong>
          &nbsp;Total Debit (₹{fmtINR(recon.total_debit)}) ≠ Total Credit (₹{fmtINR(recon.total_credit)}) — difference ₹{fmtINR(Math.abs(recon.difference))}.
        </div>
      )}
      {recon && recon.balanced && (!recon.tb_match || !recon.bs_match) && (
        <div className="pl-banner pl-banner-warn">
          <strong>Cross-check drift detected.</strong>
          {!recon.tb_match && <> Trial Balance net (₹{fmtINR(recon.tb_pl_net)}) differs from P&amp;L net by ₹{fmtINR(Math.abs(recon.tb_diff))}.</>}
          {!recon.bs_match && <> Balance Sheet P&amp;L A/c (₹{fmtINR(recon.bs_pl_account)}) differs by ₹{fmtINR(Math.abs(recon.bs_diff))}.</>}
        </div>
      )}

      {/* Header bar — single continuous underline across both sides */}
      <div className={'bs-headbar' + (showComparative ? ' pl-headbar-comp' : '')}>
        <div className="bs-side">
          <div className="hh">
            <span>Particulars</span>
            <span className="r">
              {showComparative ? 'Current Period' : 'Amount'}
              <span className="sub">{from && to ? `${dayjs(from).format('D-MMM-YY')} to ${dayjs(to).format('D-MMM-YY')}` : ''}</span>
            </span>
            {showComparative && data?.comparative && (
              <span className="r">
                Previous Period
                <span className="sub">{`${dayjs(data.comparative.period.from).format('D-MMM-YY')} to ${dayjs(data.comparative.period.to).format('D-MMM-YY')}`}</span>
              </span>
            )}
          </div>
        </div>
        <div className="bs-side">
          <div className="hh">
            <span>Particulars</span>
            <span className="r">
              {showComparative ? 'Current Period' : 'Amount'}
              <span className="sub">{from && to ? `${dayjs(from).format('D-MMM-YY')} to ${dayjs(to).format('D-MMM-YY')}` : ''}</span>
            </span>
            {showComparative && data?.comparative && (
              <span className="r">
                Previous Period
                <span className="sub">{`${dayjs(data.comparative.period.from).format('D-MMM-YY')} to ${dayjs(data.comparative.period.to).format('D-MMM-YY')}`}</span>
              </span>
            )}
          </div>
        </div>
      </div>

      {/* Two-column body */}
      <div className="bs-body">
        <div className="bs-side">
          <table className={'bs-table pl-table' + (showComparative ? ' pl-table-comp' : '')}>
            <colgroup>
              <col />
              <col style={{ width: showComparative ? 150 : 200 }} />
              {showComparative && <col style={{ width: 150 }} />}
            </colgroup>
            <tbody>
              {loading ? (
                <tr><td colSpan={showComparative ? 3 : 2} className="bs-loading"><Spin /> Loading…</td></tr>
              ) : !data || sides.debit.length === 0 ? (
                <tr><td colSpan={showComparative ? 3 : 2} className="bs-empty">No expense activity in this period.</td></tr>
              ) : (
                sides.debit.map((row, i) => renderRow(row, 'D', i))
              )}
            </tbody>
          </table>
        </div>
        <div className="bs-side">
          <table className={'bs-table pl-table' + (showComparative ? ' pl-table-comp' : '')}>
            <colgroup>
              <col />
              <col style={{ width: showComparative ? 150 : 200 }} />
              {showComparative && <col style={{ width: 150 }} />}
            </colgroup>
            <tbody>
              {loading ? (
                <tr><td colSpan={showComparative ? 3 : 2} className="bs-loading"><Spin /> Loading…</td></tr>
              ) : !data || sides.credit.length === 0 ? (
                <tr><td colSpan={showComparative ? 3 : 2} className="bs-empty">No income activity in this period.</td></tr>
              ) : (
                sides.credit.map((row, i) => renderRow(row, 'C', i))
              )}
            </tbody>
          </table>
        </div>
      </div>

      {/* Total bar */}
      {data && (
        <div className={'bs-totalbar' + (showComparative ? ' pl-totalbar-comp' : '')}>
          <div className="bs-side">
            <table>
              <colgroup>
                <col />
                <col style={{ width: showComparative ? 150 : 200 }} />
                {showComparative && <col style={{ width: 150 }} />}
              </colgroup>
              <tbody>
                <tr className="bs-row-total">
                  <td><span className="label">Total · Debit</span></td>
                  <td className="num">{fmtINR(debitTotal)}</td>
                  {showComparative && <td className="num">{fmtINR(compDebitTotal)}</td>}
                </tr>
              </tbody>
            </table>
          </div>
          <div className="bs-side">
            <table>
              <colgroup>
                <col />
                <col style={{ width: showComparative ? 150 : 200 }} />
                {showComparative && <col style={{ width: 150 }} />}
              </colgroup>
              <tbody>
                <tr className="bs-row-total">
                  <td><span className="label">Total · Credit</span></td>
                  <td className="num">{fmtINR(creditTotal)}</td>
                  {showComparative && <td className="num">{fmtINR(compCreditTotal)}</td>}
                </tr>
              </tbody>
            </table>
          </div>
        </div>
      )}

      <ProfitLossStrip
        navigate={navigate}
        from={from}
        to={to}
        setFrom={setFrom}
        setTo={setTo}
        setPresetKey={setPresetKey}
        setUserPicked={setUserPicked}
        loadData={loadData}
        data={data}
        showComparative={showComparative}
        expandAllDefault={expandAllDefault}
        setExpandAllDefault={setExpandAllDefault}
        activeSide={activeSide}
        navD={navD}
        navC={navC}
        activeIdx={activeIdx}
      />
    </div>
  );
}

function ProfitLossStrip({ navigate, from, to, setFrom, setTo, setPresetKey, setUserPicked, loadData, data, showComparative, expandAllDefault, setExpandAllDefault, activeSide, navD, navC, activeIdx }) {
  const { openDate } = useDatePopup();
  const list = activeSide === 'D' ? navD : navC;
  const cursored = list[activeIdx];
  return (
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
              setPresetKey('custom');
              setUserPicked(true);
            },
          }) },
        { id: 'view', key: 'F5', label: expandAllDefault ? 'Collapsed' : 'Expanded',
          onAction: () => {
            const next = !expandAllDefault;
            setExpandAllDefault(next);
            saveExpandPref(next);
          },
          title: 'Toggle Collapsed / Expanded' },
        { id: 'refresh', key: 'F4', label: 'Refresh',
          onAction: () => loadData() },
        { id: 'print', key: 'F9', label: 'Print',
          onAction: () => window.print() },
        { id: 'export', key: 'F10', label: 'Export',
          onAction: () => exportExcel(data, from, to, showComparative) },
        { id: 'drill', key: 'F1', label: 'Drill', tone: 'primary',
          disabled: !cursored?.drill,
          onAction: () => cursored?.drill?.() },
      ]}
    />
  );
}

// ── WhatsApp share ────────────────────────────────────────────────────
//
// Opens wa.me with a pre-filled summary (period, gross profit, net
// profit, top revenue + expense lines). User picks the recipient in the
// WhatsApp UI. PartyLedger uses the same `wa.me/91<phone>?text=…`
// pattern when a party-specific phone is available; for P&L we don't
// have a single recipient, so we emit `wa.me/?text=…` and let the user
// choose. URL-encoded; WhatsApp truncates very long messages so we keep
// the summary intentionally short.
function shareWhatsApp(data, from, to) {
  if (!data?.current) return;
  const cur = data.current;
  const fmt = (v) => Number(v || 0).toLocaleString('en-IN', {
    minimumFractionDigits: 2, maximumFractionDigits: 2,
  });
  const lines = [
    `*Profit & Loss · ${from} to ${to}*`,
    `Net Sales: ₹${fmt(cur.credit.sales_accounts.net)}`,
    `Net Purchases: ₹${fmt(cur.debit.purchase_accounts.net)}`,
    `Opening Stock: ₹${fmt(cur.debit.opening_stock)}`,
    `Closing Stock: ₹${fmt(cur.credit.closing_stock)}`,
    `Gross Profit: ₹${fmt(cur.summary.gross_profit)}`,
    `Net Profit: ₹${fmt(cur.summary.net_profit)}`,
  ].join('\n');
  const url = `https://wa.me/?text=${encodeURIComponent(lines)}`;
  window.open(url, '_blank', 'noopener,noreferrer');
}

// ── Excel export ──────────────────────────────────────────────────────
//
// Single-sheet workbook mirroring the on-screen layout: Particulars,
// Current Period, [Previous Period if comparative]. Sales/Purchase
// returns appear as separate negatively-signed rows so the netting is
// auditable in the exported file (rather than just collapsed to "Net
// Sales"). PDF uses the browser's print engine via window.print() and
// the @media print rules in profit-loss.css; no separate PDF generator
// needed for the A4 two-column layout.
async function exportExcel(data, from, to, comparative) {
  if (!data?.current) return;
  const ExcelJS = (await import('exceljs')).default;
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Profit & Loss');

  const cols = [
    { header: 'Side',         key: 'side', width: 10 },
    { header: 'Particulars',  key: 'p',    width: 36 },
    { header: 'Current',      key: 'c',    width: 16 },
  ];
  if (comparative) cols.push({ header: 'Previous', key: 'p2', width: 16 });
  ws.columns = cols;

  const cur = data.current, cmp = data.comparative;
  const N = (v) => Number(v) || 0;

  // Header row identifying the period(s).
  ws.addRow({});
  ws.getCell(`A${ws.rowCount}`).value = `Profit & Loss · ${from} to ${to}`;
  if (comparative && cmp) {
    ws.addRow({});
    ws.getCell(`A${ws.rowCount}`).value = `Comparative · ${cmp.period.from} to ${cmp.period.to}`;
  }
  ws.addRow({});

  const dump = (sideName, side, sideCmp) => {
    const isDr = sideName === 'Debit';
    const row = (p, c, c2) => ws.addRow(comparative
      ? { side: sideName, p, c, p2: c2 ?? '' }
      : { side: sideName, p, c });

    if (isDr) {
      row('Opening Stock',
          N(side.opening_stock),
          sideCmp ? N(sideCmp.opening_stock) : '');
      const pa = side.purchase_accounts, paC = sideCmp?.purchase_accounts;
      if (pa.gross > 0 || pa.returns > 0) {
        for (const line of pa.lines.filter((l) => l.kind === 'purchase')) {
          const cmpLine = paC?.lines?.find?.((l) => l.ledger_id === line.ledger_id);
          row(`  ${line.ledger_name}`, N(line.amount), cmpLine ? N(cmpLine.amount) : '');
        }
        for (const line of pa.lines.filter((l) => l.kind === 'return')) {
          const cmpLine = paC?.lines?.find?.((l) => l.ledger_id === line.ledger_id);
          row(`  Less: ${line.ledger_name}`, -N(line.amount), cmpLine ? -N(cmpLine.amount) : '');
        }
        row('Net Purchases', N(pa.net), paC ? N(paC.net) : '');
      }
      for (const line of side.direct_expenses.lines) {
        const cmpLine = sideCmp?.direct_expenses?.lines?.find?.((l) => l.ledger_id === line.ledger_id);
        row(line.ledger_name, N(line.amount), cmpLine ? N(cmpLine.amount) : '');
      }
      if (side.gross_profit_co > 0) row('Gross Profit c/o', N(side.gross_profit_co), sideCmp ? N(sideCmp.gross_profit_co) : '');
      if (side.gross_loss_bd   > 0) row('Gross Loss b/d',   N(side.gross_loss_bd),   sideCmp ? N(sideCmp.gross_loss_bd)   : '');
      for (const line of side.indirect_expenses.lines) {
        const cmpLine = sideCmp?.indirect_expenses?.lines?.find?.((l) => l.ledger_id === line.ledger_id);
        row(line.ledger_name, N(line.amount), cmpLine ? N(cmpLine.amount) : '');
      }
      if (side.net_profit > 0) row('Net Profit', N(side.net_profit), sideCmp ? N(sideCmp.net_profit) : '');
    } else {
      const sa = side.sales_accounts, saC = sideCmp?.sales_accounts;
      if (sa.gross > 0 || sa.returns > 0) {
        for (const line of sa.lines.filter((l) => l.kind === 'sale')) {
          const cmpLine = saC?.lines?.find?.((l) => l.ledger_id === line.ledger_id);
          row(`  ${line.ledger_name}`, N(line.amount), cmpLine ? N(cmpLine.amount) : '');
        }
        for (const line of sa.lines.filter((l) => l.kind === 'return')) {
          const cmpLine = saC?.lines?.find?.((l) => l.ledger_id === line.ledger_id);
          row(`  Less: ${line.ledger_name}`, -N(line.amount), cmpLine ? -N(cmpLine.amount) : '');
        }
        row('Net Sales', N(sa.net), saC ? N(saC.net) : '');
      }
      row('Closing Stock', N(side.closing_stock), sideCmp ? N(sideCmp.closing_stock) : '');
      for (const line of side.direct_income.lines) {
        const cmpLine = sideCmp?.direct_income?.lines?.find?.((l) => l.ledger_id === line.ledger_id);
        row(line.ledger_name, N(line.amount), cmpLine ? N(cmpLine.amount) : '');
      }
      if (side.gross_loss_bf   > 0) row('Gross Loss b/f',   N(side.gross_loss_bf),   sideCmp ? N(sideCmp.gross_loss_bf)   : '');
      if (side.gross_profit_bd > 0) row('Gross Profit b/d', N(side.gross_profit_bd), sideCmp ? N(sideCmp.gross_profit_bd) : '');
      for (const line of side.indirect_income.lines) {
        const cmpLine = sideCmp?.indirect_income?.lines?.find?.((l) => l.ledger_id === line.ledger_id);
        row(line.ledger_name, N(line.amount), cmpLine ? N(cmpLine.amount) : '');
      }
      if (side.net_loss > 0) row('Net Loss', N(side.net_loss), sideCmp ? N(sideCmp.net_loss) : '');
    }
  };

  dump('Debit',  cur.debit,  cmp?.debit);
  ws.addRow({});
  dump('Credit', cur.credit, cmp?.credit);
  ws.addRow({});
  const totalRow = (side, c, c2) => ws.addRow(comparative
    ? { side: 'TOTAL', p: side, c, p2: c2 ?? '' }
    : { side: 'TOTAL', p: side, c });
  totalRow('Debit',  N(cur.debit.total),  cmp ? N(cmp.debit.total)  : '');
  totalRow('Credit', N(cur.credit.total), cmp ? N(cmp.credit.total) : '');
  ws.addRow(comparative
    ? { side: 'GP', p: 'Gross Profit', c: N(cur.summary.gross_profit), p2: cmp ? N(cmp.summary.gross_profit) : '' }
    : { side: 'GP', p: 'Gross Profit', c: N(cur.summary.gross_profit) });
  ws.addRow(comparative
    ? { side: 'NP', p: 'Net Profit',   c: N(cur.summary.net_profit),   p2: cmp ? N(cmp.summary.net_profit) : '' }
    : { side: 'NP', p: 'Net Profit',   c: N(cur.summary.net_profit) });

  const buf = await wb.xlsx.writeBuffer();
  const url = URL.createObjectURL(new Blob([buf], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = `profit-loss-${from}-to-${to}.xlsx`;
  document.body.appendChild(a); a.click(); document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
