// ── LedgerStatement ─────────────────────────────────────────────────────
//
// Pure renderer for a voucher-level account statement. Backs three
// report pages — Customer Statement, Supplier Statement, COA Ledger —
// each of which provides its own picker, header, and print chrome
// around this component.
//
// PROPS
//   statement       Result of ledgerAPI.statement(...) — see
//                   server/services/ledgerStatementService.js for the
//                   full shape. The component never fetches; the parent
//                   owns loading + refresh.
//   loading         Boolean — show overlay spinner.
//   columns         Array of column keys to render (in order). Falls
//                   back to DEFAULT_COLUMNS. Page-specific columns
//                   (e.g. supplier_bill_no on Supplier Statement) live
//                   in COLUMN_DEFS below; pages opt-in by passing the
//                   key in `columns`.
//   onRowClick      (row) => void — drill into source bill/voucher.
//                   Page decides where based on row.source_type.
//   outstandingOnly Filter to rows that contribute to the closing
//                   balance (rough heuristic — we keep bill rows whose
//                   matching receipt/payment hasn't fully cleared).
//                   Page-controlled toggle.
//   emptyHint       String shown when the API returns no entries.
//                   Helps disambiguate "no party selected" vs "no
//                   activity in period" without rendering an empty
//                   table.
//
// LAYOUT
//   Sticky thead at the top of the inner scroller (`.ls-scroll`).
//   Pinned bottom totals row inside the same scroller — always
//   visible no matter how long the entry list gets, mirroring the
//   chrome of Day Book / Sales Report / Trial Balance.
//
// FORMATTING
//   Indian numbering with 2dp; date as DD-MM-YYYY (the format every
//   downstream Indian accountant + GST workflow expects). Empty cells
//   render as "—" rather than "0.00" so the eye finds non-zero
//   numbers faster on a long statement.

import React, { useMemo } from 'react';
import { Spin, Empty } from 'antd';
import dayjs from 'dayjs';

const fmt = (v) =>
  parseFloat(v || 0).toLocaleString('en-IN', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });

const fmtDate = (d) => (d ? dayjs(d).format('DD-MM-YYYY') : '—');

// Column registry. Each page passes the keys it wants in the order it
// wants. Adding a column = add an entry here, no change to consumers.
const COLUMN_DEFS = {
  date: {
    label:  'Date',
    width:  100,
    render: r => fmtDate(r.date),
  },
  voucher_type: {
    label:  'Type',
    width:  110,
    render: r => (
      <span className={`ls-vt ls-vt--${(r.voucher_type || '').toLowerCase().replace(/\s+/g, '-')}`}>
        {r.voucher_type || '—'}
      </span>
    ),
  },
  voucher_no: {
    label:  'Voucher No',
    width:  130,
    render: r => r.voucher_no || '—',
  },
  particulars: {
    label:  'Particulars',
    width:  'auto',          // flex-fill — narration carries the long text
    render: r => r.narration || '—',
    cls:    'ls-particulars',
  },
  debit: {
    label:  'Debit',
    width:  120,
    align:  'right',
    render: r => (r.debit > 0 ? fmt(r.debit) : '—'),
    cls:    'ls-num',
  },
  credit: {
    label:  'Credit',
    width:  120,
    align:  'right',
    render: r => (r.credit > 0 ? fmt(r.credit) : '—'),
    cls:    'ls-num',
  },
  balance: {
    label:  'Balance',
    width:  140,
    align:  'right',
    // Tally convention: negative = Cr, positive = Dr. We surface the
    // sign with a tiny suffix so a printed statement is unambiguous.
    render: r => {
      const v = parseFloat(r.balance) || 0;
      if (v === 0) return '0.00';
      const sign = v >= 0 ? 'Dr' : 'Cr';
      return <span><b>{fmt(Math.abs(v))}</b> <span className="ls-drcr">{sign}</span></span>;
    },
    cls:    'ls-num ls-balance',
  },
};

const DEFAULT_COLUMNS = ['date', 'voucher_type', 'voucher_no', 'particulars', 'debit', 'credit', 'balance'];

export default function LedgerStatement({
  statement,
  loading = false,
  columns = DEFAULT_COLUMNS,
  onRowClick,
  outstandingOnly = false,
  emptyHint = 'Select a ledger to load the statement.',
}) {
  // Resolve column defs once per render. Unknown keys are skipped
  // rather than thrown — pages can pass an experimental column without
  // a backend change crashing the renderer.
  const cols = useMemo(
    () => columns.map(k => COLUMN_DEFS[k]).filter(Boolean).map((d, i) => ({ ...d, key: columns[i] })),
    [columns],
  );

  // Optional outstanding filter. The bill→receipt linkage isn't always
  // 1:1 (one receipt can clear multiple bills via PaymentSplit), so the
  // perfectly correct filter is non-trivial. As a first cut we hide
  // rows whose voucher_type indicates a settled receipt/payment — the
  // remaining rows show what STILL contributes to the closing balance.
  // Pages can switch this off if the user wants the full audit trail.
  const visibleEntries = useMemo(() => {
    if (!statement?.entries?.length) return [];
    if (!outstandingOnly) return statement.entries;
    return statement.entries.filter(e => {
      // Keep bills (Sales / Purchase) and returns; hide cleared
      // receipts/payments. Approximation; refine when PaymentSplit
      // joins are wired through.
      if (e.voucher_type === 'Receipt' || e.voucher_type === 'Payment') return false;
      return true;
    });
  }, [statement, outstandingOnly]);

  // No statement yet — picker is empty / not selected.
  if (!statement && !loading) {
    return (
      <div className="ls-empty">
        <Empty description={emptyHint} />
      </div>
    );
  }

  return (
    <div className={'ls-wrap' + (loading ? ' is-loading' : '')}>
      {loading && (
        <div className="ls-overlay">
          <Spin size="large" />
        </div>
      )}
      <div className="ls-scroll">
        <table className="ls-table">
          <thead>
            <tr>
              {cols.map(c => (
                <th
                  key={c.key}
                  className={c.align === 'right' ? 'right' : ''}
                  style={c.width !== 'auto' ? { width: c.width } : undefined}
                >
                  {c.label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {/* Opening balance row — always present, even at 0. Reads
                like a Tally statement, anchors the running balance. */}
            {statement && (
              <tr className="ls-opening">
                {cols.map(c => {
                  if (c.key === 'particulars') {
                    return <td key={c.key} className="ls-particulars"><i>Opening Balance</i></td>;
                  }
                  if (c.key === 'balance') {
                    const v = parseFloat(statement.opening_balance) || 0;
                    const sign = v >= 0 ? 'Dr' : 'Cr';
                    return (
                      <td key={c.key} className="ls-num ls-balance">
                        {v === 0 ? '0.00' : (
                          <span><b>{fmt(Math.abs(v))}</b> <span className="ls-drcr">{sign}</span></span>
                        )}
                      </td>
                    );
                  }
                  return <td key={c.key} className={c.cls || ''}>{c.key === 'date' ? fmtDate(statement.period?.from) : ''}</td>;
                })}
              </tr>
            )}

            {visibleEntries.map((row, i) => (
              <tr
                key={row.entry_id || i}
                className={'ls-row' + (onRowClick ? ' ls-clickable' : '')}
                onClick={onRowClick ? () => onRowClick(row) : undefined}
              >
                {cols.map(c => (
                  <td
                    key={c.key}
                    className={
                      [c.cls, c.align === 'right' ? 'right' : ''].filter(Boolean).join(' ')
                    }
                  >
                    {c.render(row)}
                  </td>
                ))}
              </tr>
            ))}

            {!loading && visibleEntries.length === 0 && statement && (
              <tr className="ls-no-activity">
                <td colSpan={cols.length}>
                  <i>No activity in this period.</i>
                </td>
              </tr>
            )}
          </tbody>

          {/* Pinned totals + closing balance row. Stays at the bottom
              of the scrolling container thanks to position: sticky on
              the <tfoot> rows in CSS. */}
          {statement && (
            <tfoot>
              <tr className="ls-totals">
                {cols.map(c => {
                  if (c.key === 'particulars') return <td key={c.key} className="ls-particulars"><b>Period totals</b></td>;
                  if (c.key === 'debit')  return <td key={c.key} className="ls-num"><b>{fmt(statement.total_debit)}</b></td>;
                  if (c.key === 'credit') return <td key={c.key} className="ls-num"><b>{fmt(statement.total_credit)}</b></td>;
                  return <td key={c.key} />;
                })}
              </tr>
              <tr className="ls-closing">
                {cols.map(c => {
                  if (c.key === 'particulars') return <td key={c.key} className="ls-particulars"><b>Closing Balance</b></td>;
                  if (c.key === 'balance') {
                    const v = parseFloat(statement.closing_balance) || 0;
                    const sign = v >= 0 ? 'Dr' : 'Cr';
                    return (
                      <td key={c.key} className="ls-num ls-balance">
                        {v === 0 ? <b>0.00</b> : (
                          <span><b>{fmt(Math.abs(v))}</b> <span className="ls-drcr">{sign}</span></span>
                        )}
                      </td>
                    );
                  }
                  if (c.key === 'date') return <td key={c.key}>{fmtDate(statement.period?.to)}</td>;
                  return <td key={c.key} />;
                })}
              </tr>
            </tfoot>
          )}
        </table>
      </div>
    </div>
  );
}
