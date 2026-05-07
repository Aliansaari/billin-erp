// ── Bank Statement ────────────────────────────────────────────────────
//
// Bank-flavoured ledger statement with reconciliation. Same source data
// as the regular Ledger Statement (ledger_entries), just presented for
// bank-account semantics:
//
//   • Withdrawal / Deposit columns instead of Debit / Credit
//   • Cheque/UTR ref pulled from payment_splits
//   • Cleared/Uncleared status per row (cleared_at on payment_receipts)
//   • Reconciliation banner at the foot:
//       book balance ± net uncleared = expected bank balance
//
// Tick the cleared checkbox to mark a row as cleared. The reconciliation
// number updates instantly. When all rows are cleared, the banner turns
// green and reads "Reconciled — book balance equals expected bank balance".
//
// Tier 3 (CSV import + auto-match) is NOT implemented in this MVP. See
// the comment at the foot of this file for the intended shape.

import React, { useEffect, useMemo, useState, useCallback } from 'react';
import { Button, DatePicker, message } from 'antd';
import {
  ReloadOutlined, PrinterOutlined, ArrowLeftOutlined,
  CheckCircleFilled,
} from '@ant-design/icons';
import { useNavigate, useParams, useSearchParams } from 'react-router-dom';
import dayjs from 'dayjs';
import { bankAPI } from '../../api';
import { useFinancialYear } from '../../hooks/useFinancialYear';
import ActionStrip from '../../components/keyboard/ActionStrip';
import { useDatePopup } from '../../components/keyboard/DatePopup';
import './banks.css';

const fmtN = (v) => Number(v || 0).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const fmtRupees = (v) => {
  const n = Number(v) || 0;
  if (Math.abs(n) >= 1e7) return `₹ ${(n / 1e7).toFixed(2)} Cr`;
  if (Math.abs(n) >= 1e5) return `₹ ${(n / 1e5).toFixed(2)} L`;
  return `₹ ${n.toLocaleString('en-IN', { minimumFractionDigits: 0, maximumFractionDigits: 0 })}`;
};
const fmtDate = (s) => s ? dayjs(s).format('DD MMM YYYY') : '—';

export default function BankStatement() {
  const navigate = useNavigate();
  const { ledger_id } = useParams();
  const [searchParams, setSearchParams] = useSearchParams();
  const { fyStart, fyEnd } = useFinancialYear();

  // Period — defaults to current FY when the hook resolves.
  const [fromDate, setFromDate] = useState(() => searchParams.get('from_date') || '');
  const [toDate,   setToDate]   = useState(() => searchParams.get('to_date')   || '');
  useEffect(() => {
    if (!fromDate && !toDate && fyStart && fyEnd) {
      setFromDate(fyStart);
      setToDate(fyEnd);
    }
  }, [fyStart, fyEnd]); // eslint-disable-line react-hooks/exhaustive-deps

  // URL sync
  useEffect(() => {
    const next = {};
    if (fromDate) next.from_date = fromDate;
    if (toDate)   next.to_date   = toDate;
    setSearchParams(next, { replace: true });
  }, [fromDate, toDate, setSearchParams]);

  const [data, setData]   = useState(null);
  const [loading, setLd]  = useState(true);
  const [filter, setFilter] = useState('all'); // 'all' | 'cleared' | 'uncleared'

  const load = useCallback(() => {
    if (!ledger_id) return;
    setLd(true);
    bankAPI.statement(ledger_id, {
      ...(fromDate ? { from_date: fromDate } : {}),
      ...(toDate   ? { to_date:   toDate   } : {}),
    })
      .then((r) => setData(r.data))
      .catch((e) => message.error(e.response?.data?.error || 'Failed to load bank statement'))
      .finally(() => setLd(false));
  }, [ledger_id, fromDate, toDate]);
  useEffect(load, [load]);

  // Toggle clearance for a row. Optimistic — the row flips state
  // immediately, then the server call reconciles. On failure, revert
  // and surface the error.
  const toggleCleared = useCallback(async (entry) => {
    if (!entry.clearable || !entry.transaction_id) return;
    const wasCleared = !!entry.cleared_at;

    // Optimistic update — flip local state, then call server.
    setData((d) => ({
      ...d,
      entries: d.entries.map((e) =>
        e.transaction_id === entry.transaction_id
          ? { ...e, cleared_at: wasCleared ? null : new Date().toISOString() }
          : e,
      ),
    }));

    try {
      if (wasCleared) {
        await bankAPI.markUncleared(entry.transaction_id);
      } else {
        await bankAPI.markCleared(entry.transaction_id);
      }
      // Reload to refresh the reconciliation totals from server truth.
      load();
    } catch (e) {
      message.error(e.response?.data?.error || 'Failed to update clearance');
      // Revert.
      setData((d) => ({
        ...d,
        entries: d.entries.map((e2) =>
          e2.transaction_id === entry.transaction_id
            ? { ...e2, cleared_at: wasCleared ? entry.cleared_at : null }
            : e2,
        ),
      }));
    }
  }, [load]);

  // Filter rows by clearance for the visual surface. Reconciliation
  // totals always reflect the FULL dataset.
  const visibleEntries = useMemo(() => {
    if (!data) return [];
    if (filter === 'all') return data.entries;
    if (filter === 'cleared')   return data.entries.filter((e) => e.cleared_at);
    if (filter === 'uncleared') return data.entries.filter((e) => e.clearable && !e.cleared_at);
    return data.entries;
  }, [data, filter]);

  const recon = data?.reconciliation;
  const { openDate } = useDatePopup();

  // CSV export of the visible entries — minimal header row + data row
  // per visibleEntry. Same shape as the Excel export on PartyStatement,
  // simpler since this page doesn't carry a full LedgerStatement model.
  const handleExport = () => {
    if (!data?.entries?.length) { message.info('Nothing to export.'); return; }
    const headers = ['Date', 'Particulars', 'Cheque/UTR', 'Withdrawal', 'Deposit', 'Balance', 'Cleared'];
    const rows = visibleEntries.map((e) => [
      e.date,
      e.party || e.narration || e.voucher_type || '',
      e.cheque || '',
      e.withdrawal || '',
      e.deposit || '',
      e.balance,
      e.cleared_at ? 'Yes' : '',
    ]);
    const escape = (v) => {
      const s = String(v ?? '');
      return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    const csv = [headers, ...rows].map(r => r.map(escape).join(',')).join('\n');
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `bank-statement-${data?.account?.ledger_name || 'bank'}-${(fromDate || 'all')}-to-${(toDate || 'today')}.csv`.replace(/\s+/g, '-').toLowerCase();
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div className="bank-page">

      {/* ─── Title strip ────────────────────────────────────────────── */}
      <header className="rpt-page-hd">
        <div className="rpt-title">
          <button className="bank-back" onClick={() => navigate('/banks')}>
            <ArrowLeftOutlined /> Banks
          </button>
          <h1>{data?.account?.ledger_name || 'Bank Statement'}</h1>
          {data?.account && (
            <div className="rpt-sub">
              {data.account.sub_group}
              {data.account.is_overdraft && <span className="od-badge">OD</span>}
              <span className="sep">·</span>
              {fromDate && toDate
                ? `${dayjs(fromDate).format('DD MMM YYYY')} — ${dayjs(toDate).format('DD MMM YYYY')}`
                : 'All time'}
            </div>
          )}
        </div>
        <div className="rpt-hd-ctrl">
          <DatePicker.RangePicker
            className="rpt-date"
            value={[fromDate ? dayjs(fromDate) : null, toDate ? dayjs(toDate) : null]}
            onChange={(vals) => {
              if (!vals) { setFromDate(''); setToDate(''); return; }
              setFromDate(vals[0].format('YYYY-MM-DD'));
              setToDate(vals[1].format('YYYY-MM-DD'));
            }}
            format="DD MMM YYYY"
          />
          <Button className="rpt-btn" icon={<ReloadOutlined />} loading={loading} onClick={load}>
            Refresh
          </Button>
          <Button className="rpt-btn" type="primary" icon={<PrinterOutlined />} onClick={() => window.print()}>
            Print
          </Button>
        </div>
      </header>

      {/* ─── KPI strip — standard .rpt-kpi tone-* design (matches the
              cards on Bank list, Loan list, every report hub page).
              Four cards: closing balance, cleared total, uncleared
              total, expected bank balance. The last one is the
              reconciliation identity made visible:
                  expected bank = book ± uncleared. */}
      {recon && data && (
        <section className="rpt-kpis">
          <div className="rpt-kpi tone-accent">
            <div className="rpt-kpi-k">Closing Balance</div>
            <div className="rpt-kpi-v">
              {fmtRupees(Math.abs(data.totals.closing_balance))}
              <span style={{ fontSize: '0.55em', color: 'var(--fg-tertiary)', fontWeight: 700, letterSpacing: '0.4px', marginLeft: 6 }}>
                {data.totals.balance_side}
              </span>
            </div>
            <div className="bank-kpi-sub">
              Opening ₹{fmtN(data.opening_balance)} → today
            </div>
          </div>
          <div className="rpt-kpi tone-success">
            <div className="rpt-kpi-k">Cleared</div>
            <div className="rpt-kpi-v">{fmtRupees(Math.max(0, data.totals.total_deposit - recon.uncleared_deposit))}</div>
            <div className="bank-kpi-sub">
              Σ deposits already settled by the bank
            </div>
          </div>
          <div className={`rpt-kpi ${recon.uncleared_count > 0 ? 'tone-warning' : 'tone-success'}`}>
            <div className="rpt-kpi-k">Uncleared</div>
            <div className="rpt-kpi-v">{fmtRupees(Math.abs(recon.net_uncleared))}</div>
            <div className="bank-kpi-sub">
              {recon.uncleared_count > 0
                ? `${recon.uncleared_count} entr${recon.uncleared_count === 1 ? 'y' : 'ies'} in transit`
                : 'Nothing in transit'}
            </div>
          </div>
          <div className="rpt-kpi tone-info">
            <div className="rpt-kpi-k">Expected Bank Balance</div>
            <div className="rpt-kpi-v">{fmtRupees(Math.abs(recon.expected_bank_bal))}</div>
            <div className="bank-kpi-sub">
              Book{recon.net_uncleared > 0 ? ' − ' : recon.net_uncleared < 0 ? ' + ' : ' ± '}uncleared
            </div>
          </div>
        </section>
      )}

      {/* ─── Filter chips ─────────────────────────────────────────── */}
      <nav className="bank-tabs">
        <button className={filter === 'all' ? 'on' : ''} onClick={() => setFilter('all')}>
          All <span className="count">{data?.entries.length || 0}</span>
        </button>
        <button className={filter === 'cleared' ? 'on' : ''} onClick={() => setFilter('cleared')}>
          Cleared
          <span className="count">
            {data?.entries.filter((e) => e.cleared_at).length || 0}
          </span>
        </button>
        <button className={filter === 'uncleared' ? 'on' : ''} onClick={() => setFilter('uncleared')}>
          Uncleared
          <span className="count">
            {data?.entries.filter((e) => e.clearable && !e.cleared_at).length || 0}
          </span>
        </button>
        <span className="grow"></span>
        {data && (
          <span className="bank-tabs-meta">
            Opening <b>{fmtN(data.opening_balance)}</b>
            <span className="sep">·</span>
            Closing <b>{fmtN(data.totals.closing_balance)}</b>
            {' '}<span className="bank-side">{data.totals.balance_side}</span>
          </span>
        )}
      </nav>

      {/* ─── Statement table ─────────────────────────────────────── */}
      <div className="bank-tbl-wrap stmt-scroll">
        <table className="bank-tbl stmt-tbl">
          {/* Shared colgroup with the totals bar — see BankStatement-
              TotalsBar below. table-layout:fixed (in banks.css) makes
              these widths authoritative so the totals row's cells
              line up exactly with the data row cells above. */}
          <colgroup>
            <col className="bstmt-col-date" />
            <col className="bstmt-col-particulars" />
            <col className="bstmt-col-cheque" />
            <col className="bstmt-col-num" />
            <col className="bstmt-col-num" />
            <col className="bstmt-col-num" />
            <col className="bstmt-col-cleared" />
          </colgroup>
          <thead>
            <tr>
              <th className="l">Date</th>
              <th className="l">Particulars</th>
              <th className="l">Cheque / UTR</th>
              <th>Withdrawal</th>
              <th>Deposit</th>
              <th>Balance</th>
              <th className="c">Cleared</th>
            </tr>
          </thead>
          <tbody>
            {!data ? (
              <tr><td colSpan={7} className="bank-empty">{loading ? 'Loading…' : 'Pick a period.'}</td></tr>
            ) : visibleEntries.length === 0 ? (
              <tr><td colSpan={7} className="bank-empty">
                No {filter === 'all' ? '' : filter + ' '}entries in this period.
              </td></tr>
            ) : visibleEntries.map((e, i) => {
              const isCleared = !!e.cleared_at;
              return (
                <tr key={e.entry_id || i} className={isCleared ? 'cleared' : ''}>
                  <td className="l"><span className="bank-num">{fmtDate(e.date)}</span></td>
                  <td className="l">
                    <div className="bank-particulars">
                      <span className="primary">
                        {e.party || e.narration || e.voucher_type}
                      </span>
                      {e.voucher_no && (
                        <span className="meta">
                          {e.voucher_type} {e.voucher_no}
                          {e.mode && <span className="mode-pill">{e.mode}</span>}
                        </span>
                      )}
                    </div>
                  </td>
                  <td className="l">
                    {e.cheque
                      ? <span className="bank-cheque">{e.cheque}</span>
                      : <span className="bank-dash">—</span>}
                  </td>
                  <td>
                    {e.withdrawal > 0
                      ? <span className="bank-num neg">{fmtN(e.withdrawal)}</span>
                      : <span className="bank-dash">—</span>}
                  </td>
                  <td>
                    {e.deposit > 0
                      ? <span className="bank-num pos">{fmtN(e.deposit)}</span>
                      : <span className="bank-dash">—</span>}
                  </td>
                  <td>
                    <span className="bank-num bold">{fmtN(e.balance)}</span>
                  </td>
                  <td className="c">
                    {e.clearable ? (
                      <button
                        className={'bank-tick' + (isCleared ? ' on' : '')}
                        onClick={() => toggleCleared(e)}
                        title={isCleared
                          ? `Cleared on ${fmtDate(e.cleared_at)}`
                          : 'Mark as cleared on the bank'}
                      >
                        {isCleared && <CheckCircleFilled />}
                      </button>
                    ) : (
                      <span className="bank-dash" title="Non-payment entry — not clearable in this view (e.g. JV / contra)">
                        —
                      </span>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {/* ─── Totals bar — pinned below the scroll area, never below
              the last row. Mirrors LoanStatement's pattern: shared
              colgroup widths with the table above so each total cell
              lands directly under its column header. */}
      {data && data.entries.length > 0 && (
        <BankStatementTotalsBar data={data} />
      )}

      {/* Footer summary */}
      <footer className="bank-foot">
        <span>
          Showing <b>{visibleEntries.length}</b>
          {' '}of <b>{data?.entries.length || 0}</b> entries
        </span>
        <span className="bank-foot-keys">
          <span>Click the <b>○</b> in the Cleared column to mark a row as cleared on the bank.</span>
        </span>
      </footer>

      <ActionStrip
        actions={[
          {
            id: 'back', key: 'Esc', label: 'Back',
            onAction: () => navigate('/banks'),
          },
          {
            id: 'period', key: 'F2', label: 'Period',
            onAction: () => openDate({
              mode: 'range', title: 'Period',
              value: [fromDate ? dayjs(fromDate) : null, toDate ? dayjs(toDate) : null],
              onConfirm: ([f, t]) => {
                setFromDate(f.format('YYYY-MM-DD'));
                setToDate(t.format('YYYY-MM-DD'));
              },
            }),
          },
          {
            id: 'refresh', key: 'F5', label: 'Refresh',
            onAction: load,
          },
          {
            id: 'print', key: 'F9', label: 'Print',
            onAction: () => window.print(),
          },
          {
            id: 'export', key: 'F10', label: 'Export',
            disabled: !data?.entries?.length,
            onAction: handleExport,
          },
        ]}
      />
    </div>
  );
}

// ── Bank Statement Totals Bar ──────────────────────────────────────
//
// Pinned at the bottom of the page (sibling of the scroll area, NOT
// a <tfoot> inside the table) so it's always visible regardless of
// row count. Same pattern as LoanStatement's totals bar — shares the
// .stmt-tbl table-layout:fixed + colgroup widths so the cells line
// up exactly under their column headers.
//
// Cells:
//   • "TOTALS" label spans Date+Particulars+Cheque (cols 1–3)
//   • Total Withdrawal (col 4)
//   • Total Deposit (col 5)
//   • Closing balance (col 6) — same number as the running balance
//     on the last row, but useful to see at a glance even when the
//     last row has scrolled out of view
//   • Cleared col left blank — totals don't make sense for a toggle
function BankStatementTotalsBar({ data }) {
  const t = data?.totals || {};
  return (
    <div className="stmt-totals-bar">
      <table className="bank-tbl stmt-tbl stmt-foot-tbl">
        <colgroup>
          <col className="bstmt-col-date" />
          <col className="bstmt-col-particulars" />
          <col className="bstmt-col-cheque" />
          <col className="bstmt-col-num" />
          <col className="bstmt-col-num" />
          <col className="bstmt-col-num" />
          <col className="bstmt-col-cleared" />
        </colgroup>
        <tbody>
          <tr className="stmt-foot">
            <td className="l" colSpan={3}><b>Totals</b></td>
            <td><span className="bank-num bold neg">{fmtN(t.total_withdrawal || 0)}</span></td>
            <td><span className="bank-num bold pos">{fmtN(t.total_deposit || 0)}</span></td>
            <td>
              <span className="bank-num bold">{fmtN(Math.abs(t.closing_balance || 0))}</span>
              <span style={{ fontSize: 10, fontWeight: 700, color: 'var(--fg-tertiary)', marginLeft: 4 }}>
                {t.balance_side}
              </span>
            </td>
            <td className="c"></td>
          </tr>
        </tbody>
      </table>
    </div>
  );
}

// ── Tier 3: CSV import + auto-match ─────────────────────────────────
//
// NOT IMPLEMENTED in this MVP. The intended shape (for future work):
//
//   1. POST /api/banks/:id/import — accepts a CSV upload (HDFC, ICICI,
//      SBI, Axis layouts). Server parses (column-name detection +
//      DD/MM/YYYY normalisation), stages rows in a temp table.
//   2. GET /api/banks/:id/import/:job_id/match — fuzzy-match staged
//      rows against payment_receipts by amount + date (±2 days) +
//      cheque/UTR (exact when present, fuzzy on narration otherwise).
//      Returns:
//        - exact matches  → auto-mark cleared with bank's date
//        - candidate matches → operator review
//        - unmatched      → "create JV" prompt (bank charges, interest)
//   3. POST /api/banks/:id/import/:job_id/apply — commit the
//      reviewed match decisions in one transaction.
//
// Genuinely 1–2 weeks of work to do well; out of scope for the current
// session. The cleared_at column we just added is forward-compatible
// (the import path will set the same field).
