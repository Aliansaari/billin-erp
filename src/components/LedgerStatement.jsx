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
//                   back to DEFAULT_COLUMNS.
//   onRowClick      (row) => void — drill into source bill/voucher.
//   voucherFilter   Set<string> | null. When a Set, only entries whose
//                   derived category is in the set are shown. null
//                   shows everything. The filter applies AFTER the
//                   API fetch, so toggling chips is instant.
//   emptyHint       String shown when the API returns no entries.
//
// LAYOUT — two tables: a scrolling body, and a pinned-bottom strip
//   that always sits flush against the wrapper bottom regardless of
//   how many rows are loaded. Same colgroup is applied to both so
//   columns line up perfectly.

import React, { useMemo } from 'react';
import { Spin, Empty } from 'antd';
import dayjs from 'dayjs';

const fmt = (v) =>
  parseFloat(v || 0).toLocaleString('en-IN', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });

const fmtDate = (d) => (d ? dayjs(d).format('DD-MM-YYYY') : '—');

// ── Category derivation ──────────────────────────────────────────────
// `voucher_type` in the DB is one of six values (Sales / Purchase /
// Receipt / Payment / Journal / Contra) but real activity comes
// through with finer distinctions: a sales-return posts as Journal
// from source_type='sales_return_bill', a payment-at-billing posts
// as Receipt from source_type='sales_bill_receipt', etc. The UI
// wants those user-facing categories surfaced cleanly so the chip
// filter ("show me all Sales Returns") matches the operator's mental
// model. We derive the display category from source_type first, then
// fall back to voucher_type.
//
// This MUST stay consistent with the chip class names in
// ledger-statement.css (.ls-vt--sales, .ls-vt--sales-return, etc.) —
// the slug is computed from this string.
export function deriveCategory(entry) {
  const st = entry.source_type;
  const vt = entry.voucher_type;
  if (st === 'sales_bill')           return 'Sales';
  if (st === 'purchase_bill')        return 'Purchase';
  if (st === 'sales_return_bill')    return 'Sales Return';
  if (st === 'purchase_return_bill') return 'Purchase Return';
  if (st === 'sales_bill_receipt')   return 'Receipt';
  if (st === 'payment_receipt')      return vt === 'Payment' ? 'Payment' : 'Receipt';
  if (st === 'party_opening')        return 'Opening Adj.';
  if (st === 'journal_voucher')      return 'Journal';
  if (vt === 'Contra')               return 'Contra';
  return vt || 'Journal';
}

const slug = (s) => (s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

// Column registry. Each page passes the keys it wants in the order it
// wants. Adding a column = add an entry here, no change to consumers.
const COLUMN_DEFS = {
  date: {
    label:  'Date',
    width:  110,
    render: r => fmtDate(r.date),
    cls:    'ls-nowrap',
  },
  voucher_type: {
    label:  'Type',
    width:  120,
    render: r => (
      <span className={`ls-vt ls-vt--${slug(r.category)}`}>
        {r.category || '—'}
      </span>
    ),
    cls:    'ls-nowrap',
  },
  voucher_no: {
    label:  'Voucher No',
    width:  140,
    render: r => r.voucher_no || '—',
    cls:    'ls-nowrap',
  },
  particulars: {
    label:  'Particulars',
    width:  'auto',          // flex-fill — narration carries the long text
    render: r => r.narration || '—',
    cls:    'ls-particulars',
  },
  debit: {
    label:  'Debit',
    width:  130,
    align:  'right',
    render: r => (r.debit > 0 ? fmt(r.debit) : '—'),
    cls:    'ls-num',
  },
  credit: {
    label:  'Credit',
    width:  130,
    align:  'right',
    render: r => (r.credit > 0 ? fmt(r.credit) : '—'),
    cls:    'ls-num',
  },
  balance: {
    label:  'Balance',
    width:  150,
    align:  'right',
    // Tally convention: positive = Dr, negative = Cr. Surface the sign
    // with a small suffix so a printed statement is unambiguous.
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
  voucherFilter = null,
  emptyHint = 'Select a ledger to load the statement.',
}) {
  // Resolve column defs once per render. Unknown keys are skipped
  // rather than thrown — pages can add an experimental column without
  // a backend change crashing the renderer.
  const cols = useMemo(
    () => columns.map(k => COLUMN_DEFS[k]).filter(Boolean).map((d, i) => ({ ...d, key: columns[i] })),
    [columns],
  );

  // Decorate entries with their derived category up-front. The chip
  // pill + the filter both consume row.category, so doing this once
  // keeps the per-row render fast.
  const decoratedEntries = useMemo(() => {
    if (!statement?.entries?.length) return [];
    return statement.entries.map(e => ({ ...e, category: deriveCategory(e) }));
  }, [statement]);

  // Voucher-type filter — the filter is over the *displayed* category,
  // not the raw voucher_type, so chips read "Sales Return" rather than
  // "Journal" (since sales-return posts as Journal under the hood).
  const visibleEntries = useMemo(() => {
    if (!voucherFilter || voucherFilter.size === 0) return decoratedEntries;
    return decoratedEntries.filter(e => voucherFilter.has(e.category));
  }, [decoratedEntries, voucherFilter]);

  // Recompute Period totals / Closing across the *visible* set when a
  // filter is active. Without this, hiding (say) Receipts would show
  // a closing balance that doesn't match the visible Dr − Cr running
  // sum — confusing rather than helpful. When no filter is active we
  // use the API totals directly so any rounding stays exact.
  const recomputed = useMemo(() => {
    if (!statement) return null;
    if (!voucherFilter || voucherFilter.size === 0) {
      return {
        opening: statement.opening_balance,
        debit:   statement.total_debit,
        credit:  statement.total_credit,
        closing: statement.closing_balance,
      };
    }
    let dr = 0, cr = 0;
    for (const e of visibleEntries) {
      dr += parseFloat(e.debit)  || 0;
      cr += parseFloat(e.credit) || 0;
    }
    // Visible closing = period opening + (Σ Dr − Σ Cr) over visible set.
    const closing = parseFloat(statement.opening_balance || 0) + dr - cr;
    return {
      opening: statement.opening_balance,
      debit:   +dr.toFixed(2),
      credit:  +cr.toFixed(2),
      closing: +closing.toFixed(2),
    };
  }, [statement, visibleEntries, voucherFilter]);

  // Shared <colgroup> for the body table and the pinned-bottom footer
  // table. table-layout: fixed (in CSS) reads from these widths so
  // both tables align column-for-column even though they're separate
  // elements.
  const colgroup = (
    <colgroup>
      {cols.map(c => (
        <col key={c.key} style={c.width !== 'auto' ? { width: c.width } : undefined} />
      ))}
    </colgroup>
  );

  // The chrome (rounded card + thead) renders identically whether or
  // not a party/ledger is selected. When nothing is picked we show an
  // in-table empty message — same visual rhythm as Sales Report's
  // empty state, no separate dashed-border placeholder. This keeps
  // the page stable as the user picks parties: the table doesn't
  // jump around, just its content fills in.
  const empty = !statement;

  return (
    <div className={'ls-wrap' + (loading ? ' is-loading' : '')}>
      {loading && (
        <div className="ls-overlay">
          <Spin size="large" />
        </div>
      )}

      <div className="ls-scroll">
        <table className="ls-table ls-table--body">
          {colgroup}
          <thead>
            <tr>
              {cols.map(c => (
                <th key={c.key} className={c.align === 'right' ? 'right' : ''}>
                  {c.label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {/* No party picked — single message row spanning the full
                width. Same chrome as the populated state, just no
                rows. */}
            {empty && !loading && (
              <tr className="ls-no-activity">
                <td colSpan={cols.length}>
                  <Empty
                    image={Empty.PRESENTED_IMAGE_SIMPLE}
                    description={emptyHint}
                    style={{ margin: 0 }}
                  />
                </td>
              </tr>
            )}

            {/* Opening balance row — always present, even at 0. */}
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
        </table>
      </div>

      {/* ── Pinned bottom strip — ONE row carrying both Period totals
            (Dr / Cr columns) AND Closing Balance (Balance column). The
            user sees Σ Dr, Σ Cr, AND the resulting close all at once
            without scanning two stacked rows. */}
      {statement && recomputed && (
        <table className="ls-table ls-table--footer">
          {colgroup}
          <tbody>
            <tr className="ls-closing">
              {cols.map(c => {
                if (c.key === 'particulars') {
                  return (
                    <td key={c.key} className="ls-particulars">
                      <b>Closing Balance</b>
                      {voucherFilter && voucherFilter.size > 0 && (
                        <span className="ls-filtered-note"> (filtered)</span>
                      )}
                    </td>
                  );
                }
                if (c.key === 'debit')  return <td key={c.key} className="ls-num"><b>{fmt(recomputed.debit)}</b></td>;
                if (c.key === 'credit') return <td key={c.key} className="ls-num"><b>{fmt(recomputed.credit)}</b></td>;
                if (c.key === 'balance') {
                  const v = parseFloat(recomputed.closing) || 0;
                  const sign = v >= 0 ? 'Dr' : 'Cr';
                  return (
                    <td key={c.key} className="ls-num ls-balance">
                      {v === 0 ? <b>0.00</b> : (
                        <span><b>{fmt(Math.abs(v))}</b> <span className="ls-drcr">{sign}</span></span>
                      )}
                    </td>
                  );
                }
                return <td key={c.key} />;
              })}
            </tr>
          </tbody>
        </table>
      )}
    </div>
  );
}
