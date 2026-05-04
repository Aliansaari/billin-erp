// Ledger Integrity admin screen.
//
// Layout (post v2 redesign):
//   • Page header — title + Refresh + Run Reconciliation (with unposted-
//     count Badge so the admin sees the size of the job up-front).
//   • Status banner — 4-cell single-line headline: tie-out, source coverage,
//     auto-receipt invariants, stock drift.
//   • Four collapsible Cards, one per concern. Healthy sections start
//     collapsed (just the green status pill in the header); broken sections
//     auto-expand on first data load. User can toggle either way after.
//
// Sections inside the Cards:
//   1. Books Tie-Out: Σ debits, Σ credits, difference (must be 0). Active
//      and Lifetime layers, 4 stats each.
//   2. Source Posting Coverage: per-source-type breakdown of vouchers that
//      have (or are missing) ledger entries, plus the View-Unposted drill-in.
//   3. Auto-Receipt Integrity (I1–I6 R8 invariants). The I5/I6 6-term
//      reconciliation now renders as a proper plus/minus equation rather
//      than a plain-text dump.
//   4. Stock Drift: products where current_stock disagrees with the
//      Σ(quantity_in − quantity_out) on stock_ledger.

import React, { useEffect, useState, useMemo } from 'react';
import {
  Card, Button, Space, Typography, Table, Tag, message, Alert,
  Row, Col, Statistic, Collapse, Modal, Badge,
} from 'antd';
import {
  ReloadOutlined, EyeOutlined, SyncOutlined,
  CheckCircleFilled, WarningFilled, CloseCircleFilled,
  CaretRightOutlined, BookOutlined, InboxOutlined,
  SafetyCertificateOutlined, DatabaseOutlined, AppstoreOutlined,
} from '@ant-design/icons';
import { ledgerAPI } from '../../api';

const { Title, Text } = Typography;
const fmt = (v) =>
  parseFloat(v || 0).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

// Numbers don't get a separate font — they inherit Source Sans 3 from
// the app shell (loaded in main.jsx) and rely on `font-variant-numeric:
// tabular-nums` to keep digits column-aligned. Using a monospace stack
// would visually divorce this page from the rest of the software.

const LABEL = {
  sales_bill: 'Sales Bills',
  purchase_bill: 'Purchase Bills',
  sales_return_bill: 'Sales Returns',
  purchase_return_bill: 'Purchase Returns',
  payment_receipt: 'Payments / Receipts',
  journal_voucher: 'Journal Vouchers',
  party_opening: 'Opening Balances',
};

// Auto-receipt invariant row formatter — one row per invariant card,
// matching the existing per-source-type Table row visual weight.
const I_LABEL_HINT = {
  'I1.sales':    'Per Sales bill — what we say is paid should match what is allocated.',
  'I1.purchase': 'Per Purchase bill — same equality on the supplier side.',
  'I2':          'Each auto-generated Receipt/Payment should map to exactly one bill at exactly the receipt amount.',
  'I3.sales':    'Auto-generated Receipt must mirror its source bill on party, date, and cancel-status.',
  'I3.purchase': 'Auto-generated Payment must mirror its source purchase bill on party, date, cancel-status.',
  'I4':          'Every auto-generated row must point at a real bill — no orphan source_bill_id values.',
  'I5':          '6-term reconciliation between Sundry Debtors ledger and the bill side.',
  'I6':          '6-term reconciliation between Sundry Creditors ledger and the bill side.',
  // Batch invariants (Commit 5) — surfaced under the Batch Integrity
  // section. I7/I8 keep their numbering so existing test scripts stay
  // valid; B3..B5 are batch-specific and only meaningful with the
  // global toggle on.
  'I7':          'For every batch-tracked product, Σ per-batch on-hand across godowns must equal product on-hand.',
  'I8':          'For every batch-tracked product, Σ per-batch on-hand must equal Σ batch-tagged ledger movements.',
  'B3':          'Every stock_ledger row whose product is batch-tracked must carry a non-NULL batch_id.',
  'B4':          'Every product_batches row must reference a real products row (FK).',
  'B5':          'No batch may have negative current_stock at any godown.',
};

// Sample table columns — different shape per invariant family.
function sampleColumns(invariantId) {
  if (invariantId.startsWith('I1')) return [
    { title: 'Bill #',        dataIndex: 'bill_number', width: 140 },
    { title: 'paid_amount',   dataIndex: 'paid_amount', align: 'right', width: 130, render: (v) => fmt(v) },
    { title: 'SUM(allocs)',   dataIndex: 'alloc_sum',   align: 'right', width: 130, render: (v) => fmt(v) },
    { title: 'Diff',          align: 'right', width: 130,
      render: (_, r) => <Tag color="red">{fmt((r.paid_amount || 0) - (r.alloc_sum || 0))}</Tag> },
  ];
  if (invariantId === 'I2') return [
    { title: 'Receipt #',     dataIndex: 'transaction_number', width: 160 },
    { title: 'Type',          dataIndex: 'transaction_type', width: 90 },
    { title: 'total_amount',  dataIndex: 'total_amount', align: 'right', width: 130, render: (v) => fmt(v) },
    { title: 'SUM(allocs)',   dataIndex: 'alloc_sum',    align: 'right', width: 130, render: (v) => fmt(v) },
    { title: '# allocs',      dataIndex: 'alloc_count',  align: 'right', width: 90 },
  ];
  if (invariantId.startsWith('I3')) return [
    { title: 'Receipt #', dataIndex: 'transaction_number', width: 160 },
    { title: 'Receipt party', dataIndex: 'r_party',  align: 'right', width: 110 },
    { title: 'Bill party',    dataIndex: 'b_party',  align: 'right', width: 110 },
    { title: 'Receipt date',  dataIndex: 'r_date',   width: 120 },
    { title: 'Bill date',     dataIndex: 'b_date',   width: 120 },
    { title: 'R cancelled',   dataIndex: 'r_cancelled', width: 100, render: (v) => String(v) },
    { title: 'B cancelled',   dataIndex: 'b_cancelled', width: 100, render: (v) => String(v) },
  ];
  if (invariantId === 'I4') return [
    { title: 'Receipt #',      dataIndex: 'transaction_number', width: 160 },
    { title: 'Type',           dataIndex: 'transaction_type', width: 90 },
    { title: 'source_bill_id', dataIndex: 'source_bill_id', align: 'right', width: 130 },
  ];
  // I7 / I8 — batch-vs-product / batch-vs-ledger drift. Sample row carries
  // product_id, product_name, the two compared totals, and the drift.
  if (invariantId === 'I7') return [
    { title: 'Product', dataIndex: 'product_name' },
    { title: 'Product stock', dataIndex: 'product_stock', align: 'right', width: 130, render: (v) => fmt(v) },
    { title: 'Σ batch stock', dataIndex: 'batch_total',  align: 'right', width: 130, render: (v) => fmt(v) },
    { title: 'Drift',         dataIndex: 'drift',        align: 'right', width: 110, render: (v) => <Tag color="red">{fmt(v)}</Tag> },
  ];
  if (invariantId === 'I8') return [
    { title: 'Product', dataIndex: 'product_name' },
    { title: 'Σ batch stock', dataIndex: 'batch_total',  align: 'right', width: 130, render: (v) => fmt(v) },
    { title: 'Σ ledger qty',  dataIndex: 'ledger_net',   align: 'right', width: 130, render: (v) => fmt(v) },
    { title: 'Drift',         dataIndex: 'drift',        align: 'right', width: 110, render: (v) => <Tag color="red">{fmt(v)}</Tag> },
  ];
  // B3 — stock_ledger rows on a batch-tracked product with NULL batch_id.
  if (invariantId === 'B3') return [
    { title: 'Ledger ID', dataIndex: 'ledger_id', width: 110 },
    { title: 'Product',   dataIndex: 'product_name' },
    { title: 'Type',      dataIndex: 'transaction_type', width: 130 },
    { title: 'Date',      dataIndex: 'transaction_date', width: 110 },
    { title: 'Reference', dataIndex: 'reference_number', width: 130 },
    { title: 'In',  dataIndex: 'quantity_in',  align: 'right', width: 80, render: (v) => fmt(v) },
    { title: 'Out', dataIndex: 'quantity_out', align: 'right', width: 80, render: (v) => fmt(v) },
  ];
  // B4 — orphan ProductBatch rows with no matching products row.
  if (invariantId === 'B4') return [
    { title: 'Batch ID',     dataIndex: 'batch_id', width: 110 },
    { title: 'Batch Number', dataIndex: 'batch_number', width: 200 },
    { title: 'Product ID',   dataIndex: 'product_id', width: 110 },
  ];
  // B5 — (batch, godown) pairs with negative on-hand.
  if (invariantId === 'B5') return [
    { title: 'Batch',         dataIndex: 'batch_number', width: 180 },
    { title: 'Product',       dataIndex: 'product_name' },
    { title: 'Godown',        dataIndex: 'godown_name', width: 160 },
    { title: 'Current stock', dataIndex: 'current_stock', align: 'right', width: 130, render: (v) => <Tag color="red">{fmt(v)}</Tag> },
  ];
  // I5 / I6 don't return a row sample — the breakdown panel shows the
  // 6 terms explicitly instead of a violator list.
  return null;
}

// ── Status palette ─────────────────────────────────────────────────────
// Three statuses drive every header tag, banner cell, and card border on
// the page. Tokens lifted from src/theme/themes.css so the screen reads
// visually consistent with the rest of the app.
const STATUS = {
  ok:   { color: '#10B981', bg: 'rgba(16,185,129,0.10)',  border: 'rgba(16,185,129,0.40)',  Icon: CheckCircleFilled },
  warn: { color: '#F59E0B', bg: 'rgba(245,158,11,0.10)',  border: 'rgba(245,158,11,0.40)',  Icon: WarningFilled },
  bad:  { color: '#EF4444', bg: 'rgba(239,68,68,0.10)',   border: 'rgba(239,68,68,0.40)',   Icon: CloseCircleFilled },
};

function StatusPill({ status, children }) {
  const s = STATUS[status] || STATUS.ok;
  const Icon = s.Icon;
  return (
    <span style={{
      display: 'inline-flex', alignItems: 'center', gap: 5,
      padding: '3px 9px', borderRadius: 999,
      background: s.bg, color: s.color,
      fontSize: 12, fontWeight: 600,
      border: `1px solid ${s.border}`,
    }}>
      <Icon style={{ fontSize: 11 }} /> {children}
    </span>
  );
}

// ── StatusBanner ───────────────────────────────────────────────────────
// 4-cell, one-line headline. Visible above the fold on every visit. On a
// healthy install this is the entire answer the admin needed.
function StatusBanner({ data, autoData, unpostedTotal }) {
  const active   = data?.totals?.active;
  const lifetime = data?.totals?.lifetime || data?.totals;

  // Tie-out is OK only if BOTH layers balance.
  const tieoutOk = active?.balanced !== false && lifetime?.balanced !== false;

  const cells = [
    {
      key: 'tieout',
      label: 'Books tie-out',
      status: tieoutOk ? 'ok' : 'bad',
      value: tieoutOk ? 'Balanced' : 'Out of balance',
    },
    {
      key: 'coverage',
      label: 'Source coverage',
      status: unpostedTotal === 0 ? 'ok' : 'warn',
      value: unpostedTotal === 0
        ? '100% posted'
        : `${unpostedTotal} unposted`,
    },
    {
      key: 'invariants',
      label: 'Auto-receipt invariants',
      status: !autoData
        ? 'ok'
        : autoData.all_pass
          ? 'ok'
          : (autoData.invariants || []).some(
              (i) => !i.ok && typeof i.difference === 'number' && Math.abs(i.difference) > 0.01,
            )
            ? 'bad'
            : 'warn',
      value: !autoData
        ? '—'
        : autoData.all_pass
          ? `${autoData.invariants.length} of ${autoData.invariants.length} green`
          : `${autoData.invariants.filter((i) => !i.ok).length} violated`,
    },
    {
      key: 'stock',
      label: 'Stock drift',
      status: data?.stock?.balanced === false ? 'bad' : 'ok',
      value: data?.stock?.drifted_count
        ? `${data.stock.drifted_count} SKUs`
        : '0 SKUs',
    },
  ];

  return (
    <div style={{
      display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)',
      background: '#fff', border: '1px solid #e5e7eb',
      borderRadius: 10, marginBottom: 16, overflow: 'hidden',
      boxShadow: '0 1px 2px rgba(0,0,0,0.04)',
    }}>
      {cells.map((c, i) => {
        const s = STATUS[c.status];
        const Icon = s.Icon;
        return (
          <div key={c.key} style={{
            padding: '14px 18px',
            display: 'flex', alignItems: 'center', gap: 12,
            borderRight: i < cells.length - 1 ? '1px solid #f0f0f0' : 'none',
          }}>
            <span style={{
              width: 32, height: 32, borderRadius: 8,
              display: 'grid', placeItems: 'center', flexShrink: 0,
              background: s.bg, color: s.color,
            }}>
              <Icon style={{ fontSize: 16 }} />
            </span>
            <div>
              <div style={{ fontSize: 11.5, color: '#6b7280', fontWeight: 500 }}>{c.label}</div>
              <div style={{
                fontSize: 14.5, fontWeight: 600, marginTop: 1,
                color: s.color,
              }}>{c.value}</div>
            </div>
          </div>
        );
      })}
    </div>
  );
}

// ── CollapsibleCard ────────────────────────────────────────────────────
// Each section is a Card with a clickable header that toggles its body.
// Header layout: icon · title/sub · optional `extra` slot · status pill ·
// chevron. Default-open is data-driven; user toggles win after that.
function CollapsibleCard({
  icon, title, subtitle, status, statusLabel,
  defaultOpen = false, extra, children, style,
}) {
  const [open, setOpen] = useState(defaultOpen);
  const s = STATUS[status] || STATUS.ok;

  return (
    <Card
      bodyStyle={{ padding: 0 }}
      style={{
        marginBottom: 12,
        borderColor: status === 'bad' ? s.border : undefined,
        ...style,
      }}
    >
      <div
        onClick={() => setOpen((v) => !v)}
        style={{
          display: 'flex', alignItems: 'center', gap: 12,
          padding: '14px 16px',
          cursor: 'pointer',
          borderBottom: open ? '1px solid #f0f0f0' : 'none',
          userSelect: 'none',
        }}
      >
        <span style={{
          width: 32, height: 32, borderRadius: 8,
          display: 'grid', placeItems: 'center', flexShrink: 0,
          background: s.bg, color: s.color,
          fontSize: 15,
        }}>
          {icon}
        </span>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 14.5, fontWeight: 600, color: '#1f2937' }}>{title}</div>
          {subtitle && (
            <div style={{ fontSize: 12, color: '#6b7280', marginTop: 2 }}>{subtitle}</div>
          )}
        </div>
        {extra && <span onClick={(e) => e.stopPropagation()}>{extra}</span>}
        {statusLabel && <StatusPill status={status}>{statusLabel}</StatusPill>}
        <CaretRightOutlined style={{
          fontSize: 12, color: '#9ca3af',
          transition: 'transform 0.15s',
          transform: open ? 'rotate(90deg)' : 'rotate(0)',
        }} />
      </div>
      {open && <div style={{ padding: '16px' }}>{children}</div>}
    </Card>
  );
}

// ── ReconciliationDetail ───────────────────────────────────────────────
// Renders the 6-term invariant for I5/I6 as a math-style equation rather
// than a plain-text block. Three columns: operator, term, value, plus a
// trailing description column. Plus terms are green, minus terms are red.
function ReconciliationDetail({ inv }) {
  const isCustomer = inv.id === 'I5';
  const subGroup = isCustomer ? 'Sundry Debtors' : 'Sundry Creditors';

  const baseCell = { fontSize: 12.5, color: '#1f2937', fontVariantNumeric: 'tabular-nums' };
  const opCell   = { ...baseCell, color: '#9ca3af', fontWeight: 500, textAlign: 'center' };
  const termCell = { ...baseCell, color: '#6b7280' };
  // Numbers in the equation — bolder than the terms so the values pop
  // when the eye scans down the right-hand column.
  const numCell  = { ...baseCell, textAlign: 'right', fontWeight: 700 };
  const descCell = { fontSize: 11.5, color: '#9ca3af', fontStyle: 'italic' };

  const rows = [
    { op: '',  term: 'bill_outstanding',     val: inv.bill_outstanding,    sign: 'plus',  desc: 'non-cancelled bill balance' },
    { op: '+', term: 'paid_in_bills',        val: inv.paid_in_bills,       sign: 'plus',  desc: 'already-collected portion' },
    { op: '−', term: 'unallocated_receipts', val: inv.unallocated_receipts,sign: 'minus', desc: `on-account credits in ${subGroup}` },
    { op: '−', term: 'returns_offset',       val: inv.returns_offset,      sign: 'minus', desc: 'return contra entries' },
    { op: '+', term: 'opening_dr',           val: inv.opening_dr,          sign: 'plus',  desc: 'migration opening (debit side)' },
    { op: '−', term: 'opening_cr',           val: inv.opening_cr,          sign: 'minus', desc: 'migration opening (credit side)' },
  ];

  return (
    <div style={{
      marginTop: 10, padding: '14px 16px',
      background: '#f9fafb', border: '1px dashed #e5e7eb',
      borderRadius: 6,
      display: 'grid',
      gridTemplateColumns: '24px 220px 140px 1fr',
      columnGap: 12, rowGap: 6,
      alignItems: 'center',
    }}>
      {rows.map((r, i) => (
        <React.Fragment key={i}>
          <span style={opCell}>{r.op}</span>
          <span style={termCell}>{r.term}</span>
          <span style={{ ...numCell, color: r.sign === 'plus' ? '#10B981' : '#EF4444' }}>
            ₹ {fmt(r.val)}
          </span>
          <span style={descCell}>{r.desc}</span>
        </React.Fragment>
      ))}
      <span style={{ gridColumn: '1 / -1', height: 1, background: '#e5e7eb', margin: '4px 0' }} />
      <span style={opCell}>=</span>
      <span style={{ ...termCell, color: '#1f2937', fontWeight: 600 }}>expected_ledger</span>
      <span style={{ ...numCell, fontWeight: 600 }}>₹ {fmt(inv.expected_ledger)}</span>
      <span style={descCell}>computed from bill side</span>

      <span style={opCell} />
      <span style={termCell}>vs ledger_outstanding</span>
      <span style={numCell}>₹ {fmt(inv.ledger_outstanding)}</span>
      <span style={descCell}>SUM(Dr − Cr) on {subGroup}</span>

      <span style={{ gridColumn: '1 / -1', height: 1, background: '#e5e7eb', margin: '4px 0' }} />
      <span style={opCell} />
      <span style={{ ...termCell, color: '#1f2937', fontWeight: 700 }}>Δ difference</span>
      <span style={{
        ...numCell, fontWeight: 700, fontSize: 13.5,
        color: Math.abs(inv.difference || 0) < 0.01 ? '#10B981' : '#EF4444',
      }}>
        ₹ {fmt(inv.difference)}
      </span>
      <span style={{ ...descCell, color: Math.abs(inv.difference || 0) < 0.01 ? '#10B981' : '#EF4444' }}>
        tolerance ±0.01
      </span>
    </div>
  );
}

// ── InvariantRow ───────────────────────────────────────────────────────
// One row per invariant. Click anywhere to expand the detail panel —
// 6-term equation for I5/I6, sample violator table for I1–I4.
function InvariantRow({ inv }) {
  const [open, setOpen] = useState(false);
  const cols = sampleColumns(inv.id);
  const isReconciliation = inv.id === 'I5' || inv.id === 'I6';

  // A drift > 0.01 paisa or > 5 violators is an actual problem (red);
  // anything smaller is a soft warning that often clears on the next run.
  const status = inv.ok
    ? 'ok'
    : Math.abs(inv.difference || 0) > 0.01 || (inv.violation_count || 0) > 5
      ? 'bad'
      : 'warn';

  const rightLabel = inv.ok
    ? isReconciliation ? '₹ 0.00 drift' : '0 violators'
    : isReconciliation
      ? `Drift ₹ ${fmt(Math.abs(inv.difference || 0))}`
      : `${inv.violation_count} violator${inv.violation_count === 1 ? '' : 's'}`;

  return (
    <div
      onClick={() => setOpen((v) => !v)}
      style={{
        display: 'grid',
        gridTemplateColumns: '90px 90px 1fr auto',
        gap: 14, alignItems: 'flex-start',
        padding: '12px 4px',
        borderBottom: '1px solid #f0f0f0',
        cursor: 'pointer',
      }}
    >
      <span style={{
        fontVariantNumeric: 'tabular-nums',
        fontSize: 11.5, fontWeight: 500,
        padding: '3px 8px', borderRadius: 4,
        background: '#f9fafb', color: '#6b7280',
        border: '1px solid #f0f0f0',
        textAlign: 'center', alignSelf: 'flex-start',
      }}>
        {inv.id}
      </span>
      <StatusPill status={status}>{inv.ok ? '✓ Clean' : '✗ Failed'}</StatusPill>
      <div>
        <div style={{ fontSize: 13.5, fontWeight: 500, color: '#1f2937' }}>{inv.name}</div>
        <div style={{ fontSize: 12, color: '#6b7280', marginTop: 2 }}>
          {I_LABEL_HINT[inv.id] || ''}
        </div>
        {open && isReconciliation && <ReconciliationDetail inv={inv} />}
        {open && !isReconciliation && cols && inv.sample && inv.sample.length > 0 && (
          <Table
            size="small"
            style={{ marginTop: 8 }}
            pagination={false}
            rowKey={(r, i) => r.bill_id ?? r.transaction_id ?? i}
            dataSource={inv.sample.slice(0, 10)}
            columns={cols}
          />
        )}
        {open && inv.ok && (
          <Text type="secondary" style={{ fontSize: 12, marginTop: 6, display: 'block' }}>
            No violations to show.
          </Text>
        )}
      </div>
      <div style={{
        textAlign: 'right',
        fontVariantNumeric: 'tabular-nums',
        fontSize: 12.5,
        fontWeight: 600,
        color: status === 'ok' ? '#10B981' : status === 'bad' ? '#EF4444' : '#F59E0B',
      }}>
        {rightLabel}
      </div>
    </div>
  );
}

// ── Main component ─────────────────────────────────────────────────────
export default function LedgerIntegrity() {
  const [data, setData]         = useState(null);
  const [unposted, setUnposted] = useState(null);
  const [loading, setLoading]   = useState(false);
  const [reconciling, setReconciling] = useState(false);

  // ── Auto-receipt integrity (R8 invariants) ──
  const [autoData, setAutoData]         = useState(null);
  const [autoLoading, setAutoLoading]   = useState(false);
  const [autoLastChecked, setAutoLastChecked] = useState(null);

  const load = async () => {
    setLoading(true);
    try {
      const r = await ledgerAPI.integrity();
      setData(r.data);
    } catch (e) {
      message.error('Failed to load integrity report.');
    }
    setLoading(false);
  };
  // Section-level refresh — fires only the auto-receipt endpoint, so the
  // top-of-page financial check (which can be slow on large data) isn't
  // re-pulled when the admin only wants this section's truth.
  const loadAutoReceipt = async () => {
    setAutoLoading(true);
    try {
      const r = await ledgerAPI.autoReceiptIntegrity();
      setAutoData(r.data);
      setAutoLastChecked(new Date());
    } catch (e) {
      message.error('Failed to load auto-receipt integrity.');
    }
    setAutoLoading(false);
  };
  useEffect(() => { load(); loadAutoReceipt(); }, []);

  // Run the backfill on the server, then refresh the integrity report so
  // the per-source-type counts reflect the new state. The backend wraps
  // each voucher in its own transaction, so partial success is normal —
  // surface failures in a modal for triage rather than a toast (errors
  // can run into the dozens on legacy imports with bad party links).
  const runReconcile = async () => {
    setReconciling(true);
    try {
      const r = await ledgerAPI.reconcile();
      const summary = r.data?.summary || {};
      const errors  = r.data?.errors  || [];
      const totals = Object.values(summary).reduce(
        (acc, s) => ({
          found:  acc.found  + (s.found  || 0),
          posted: acc.posted + (s.posted || 0),
          failed: acc.failed + (s.failed || 0),
        }),
        { found: 0, posted: 0, failed: 0 },
      );

      if (totals.found === 0) {
        message.success('Books are already reconciled — nothing to post.');
      } else if (totals.failed === 0) {
        message.success(`Reconciled ${totals.posted} voucher${totals.posted === 1 ? '' : 's'}.`);
      } else {
        Modal.warning({
          title: 'Reconciliation finished with errors',
          width: 720,
          content: (
            <div>
              <p style={{ marginTop: 0 }}>
                Posted <b>{totals.posted}</b> of <b>{totals.found}</b> unposted vouchers.{' '}
                <b>{totals.failed}</b> failed (showing first {Math.min(errors.length, 100)}):
              </p>
              <pre style={{
                maxHeight: 320, overflow: 'auto', background: '#fafafa',
                padding: 12, fontSize: 12, fontVariantNumeric: 'tabular-nums',
                border: '1px solid #f0f0f0', borderRadius: 4,
              }}>
                {errors.map((e) => `${e.source_type}#${e.source_id}: ${e.reason}`).join('\n')}
              </pre>
            </div>
          ),
        });
      }
      await load();
      await loadAutoReceipt();
    } catch (e) {
      message.error(e.response?.data?.error || 'Reconciliation failed.');
    }
    setReconciling(false);
  };

  const loadUnposted = async () => {
    try {
      const r = await ledgerAPI.unposted();
      setUnposted(r.data.data);
    } catch (e) {
      message.error('Failed to load unposted vouchers.');
    }
  };

  // ── Derived summaries ───────────────────────────────────────────────
  const totals    = data?.totals;
  const lifetime  = totals?.lifetime || totals; // back-compat for old shape
  const active    = totals?.active   || null;
  const breakdown = data?.breakdown || [];
  const stock     = data?.stock     || null;

  const unpostedTotal = useMemo(
    () => breakdown.reduce((sum, r) => sum + (r.unposted || 0), 0),
    [breakdown],
  );

  // ── Status summaries (drive header pills + default-open behavior) ───
  const tieoutOk    = active?.balanced !== false && lifetime?.balanced !== false;
  const coverageOk  = unpostedTotal === 0;
  const invariantsOk = autoData ? !!autoData.all_pass : true;
  const stockOk     = stock?.balanced !== false;

  // Status colour logic for the invariants pill mirrors the cell-level
  // rule used inside the InvariantRow — anything > 0.01 paisa drift or
  // > 5 violators is a real problem (red), smaller is a soft warning.
  const invariantsStatus = useMemo(() => {
    if (!autoData) return 'ok';
    if (autoData.all_pass) return 'ok';
    const hasLargeDrift = (autoData.invariants || []).some(
      (i) => !i.ok && typeof i.difference === 'number' && Math.abs(i.difference) > 0.01,
    );
    return hasLargeDrift ? 'bad' : 'warn';
  }, [autoData]);

  // ── Source-coverage table columns ───────────────────────────────────
  const cols = [
    { title: 'Source', dataIndex: 'source_type', key: 'source',
      render: (v) => <Text>{LABEL[v] || v}</Text>,
    },
    { title: 'Total Records', dataIndex: 'total', key: 'total', align: 'right', width: 140,
      render: (v) => <span style={{ fontVariantNumeric: 'tabular-nums', fontWeight: 600 }}>{v}</span>,
    },
    { title: 'Posted to Ledger', dataIndex: 'posted', key: 'posted', align: 'right', width: 140,
      render: (v) => <span style={{ fontVariantNumeric: 'tabular-nums', fontWeight: 600 }}>{v}</span>,
    },
    { title: 'Unposted', dataIndex: 'unposted', key: 'unposted', align: 'right', width: 140,
      render: (v) => v === 0
        ? <Tag color="green" style={{ fontVariantNumeric: 'tabular-nums', fontWeight: 600 }}>0</Tag>
        : <Tag color="orange" style={{ fontVariantNumeric: 'tabular-nums', fontWeight: 600 }}>{v}</Tag>,
    },
  ];

  return (
    // Page shell — pinned-header pattern: outer is a 100%-height flex
    // column with hidden overflow; the header is flex-shrink:0; the body
    // is flex:1 with its own scrollbar. AppLayout marks
    // /accounts/integrity as `isFullPage` so the parent gives us a
    // viewport-tall container to fill. Mirrors trial-balance.css /
    // bills-outstanding.css.
    <div style={{
      height: '100%',
      display: 'flex',
      flexDirection: 'column',
      overflow: 'hidden',
      background: 'var(--bg-app, #f5f7fa)',
    }}>
      {/* ── Page header (sticky) ────────────────────────────────────── */}
      <div style={{
        flexShrink: 0,
        padding: '14px 24px 12px',
        borderBottom: '1px solid var(--border-subtle, #f0f0f0)',
        background: 'var(--bg-app, #f5f7fa)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: 12,
        flexWrap: 'wrap',
      }}>
        <div>
          <Title level={4} style={{ margin: 0 }}>Ledger Integrity</Title>
          <Text type="secondary" style={{ fontSize: 12.5 }}>
            Read-only diagnostic of the financial source of truth
            {autoLastChecked && (
              <>
                {' · '}
                last checked {autoLastChecked.toLocaleTimeString([], {
                  hour: '2-digit', minute: '2-digit', second: '2-digit',
                })}
              </>
            )}
          </Text>
        </div>
        <Space>
          <Button
            icon={<ReloadOutlined />}
            loading={loading || autoLoading}
            onClick={() => { load(); loadAutoReceipt(); }}
            disabled={reconciling}
          >
            Refresh
          </Button>
          {/* Reconcile button shows the unposted count up-front so the admin
              sees the size of the job before clicking. Badge hides at 0. */}
          <Badge count={unpostedTotal} offset={[-4, 4]} overflowCount={999}>
            <Button
              icon={<SyncOutlined />}
              type="primary"
              loading={reconciling}
              onClick={runReconcile}
              disabled={loading}
            >
              Run Reconciliation
            </Button>
          </Badge>
        </Space>
      </div>

      {/* ── Scrollable body ─────────────────────────────────────────── */}
      <div style={{
        flex: 1,
        minHeight: 0,
        overflowY: 'auto',
        padding: '16px 24px 24px',
      }}>

      {/* ── Status banner ───────────────────────────────────────────── */}
      {data && (
        <StatusBanner data={data} autoData={autoData} unpostedTotal={unpostedTotal} />
      )}

      {/* ── Critical alerts (always-on, can't be collapsed away) ───── */}
      {(active && !active.balanced) && (
        <Alert
          type="error"
          showIcon
          message="Active books are out of balance"
          description={`Active debits and credits differ by ₹${fmt(active.difference)}. Investigate immediately.`}
          style={{ marginBottom: 12 }}
        />
      )}
      {lifetime && !lifetime.balanced && (
        <Alert
          type="error"
          showIcon
          message="Lifetime ledger is out of balance"
          description={`Lifetime debits and credits differ by ₹${fmt(lifetime.difference)}. This is a real integrity issue — reversal pairs should always sum to zero.`}
          style={{ marginBottom: 12 }}
        />
      )}

      {/* ── Section 1: Books Tie-Out ──────────────────────────────────
          Two layers (Active + Lifetime), four columns each — collapsed
          into a single 2-row Table rather than 8 large Statistic cards.
          The whole section is information-dense by nature: 8 numbers and
          two "balanced" flags. The previous 8-card grid pushed the rest
          of the page below the fold without adding any signal. */}
      {data && (
        <CollapsibleCard
          icon={<BookOutlined />}
          title="Books Tie-Out"
          subtitle="Σ debits must equal Σ credits across both layers"
          status={tieoutOk ? 'ok' : 'bad'}
          statusLabel={tieoutOk ? 'Balanced' : 'Out of balance'}
          defaultOpen={!tieoutOk}
        >
          <Table
            size="small"
            pagination={false}
            rowKey="layer"
            dataSource={[
              active && {
                layer: 'Active',
                hint: 'reversal pairs excluded',
                ...active,
              },
              lifetime && {
                layer: 'Lifetime',
                hint: 'includes reversal mirrors (audit trail)',
                ...lifetime,
              },
            ].filter(Boolean)}
            columns={[
              {
                title: 'Layer', dataIndex: 'layer', key: 'layer',
                render: (v, r) => (
                  <div>
                    <div style={{ fontWeight: 600, color: '#1f2937' }}>{v}</div>
                    <Text type="secondary" style={{ fontSize: 11.5 }}>{r.hint}</Text>
                  </div>
                ),
              },
              {
                title: 'Entries', dataIndex: 'rows', align: 'right', width: 110,
                render: (v) => <span style={{ fontVariantNumeric: 'tabular-nums', fontWeight: 600 }}>{v?.toLocaleString('en-IN')}</span>,
              },
              {
                title: 'Σ Debits', dataIndex: 'debits', align: 'right', width: 180,
                render: (v) => <span style={{ fontVariantNumeric: 'tabular-nums', fontWeight: 600 }}>₹ {fmt(v)}</span>,
              },
              {
                title: 'Σ Credits', dataIndex: 'credits', align: 'right', width: 180,
                render: (v) => <span style={{ fontVariantNumeric: 'tabular-nums', fontWeight: 600 }}>₹ {fmt(v)}</span>,
              },
              {
                title: 'Δ Difference', dataIndex: 'difference', align: 'right', width: 140,
                render: (v, r) => (
                  <span style={{
                    fontVariantNumeric: 'tabular-nums',
                    fontWeight: 600,
                    color: r.balanced ? '#10B981' : '#EF4444',
                  }}>
                    ₹ {fmt(v)}
                  </span>
                ),
              },
              {
                title: 'Status', dataIndex: 'balanced', align: 'center', width: 110,
                render: (v) => (
                  <StatusPill status={v ? 'ok' : 'bad'}>
                    {v ? 'Balanced' : 'Out of balance'}
                  </StatusPill>
                ),
              },
            ]}
          />
        </CollapsibleCard>
      )}

      {/* ── Section 2: Source Posting Coverage ────────────────────── */}
      {data && (
        <CollapsibleCard
          icon={<InboxOutlined />}
          title="Source Posting Coverage"
          subtitle="Every voucher in the source tables must have a live ledger entry"
          status={coverageOk ? 'ok' : 'warn'}
          statusLabel={coverageOk ? '100% posted' : `${unpostedTotal} unposted`}
          defaultOpen={!coverageOk}
        >
          <Table
            rowKey="source_type"
            columns={cols}
            dataSource={breakdown}
            pagination={false}
            size="small"
            loading={loading}
          />

          <div style={{ marginTop: 12 }}>
            <Button icon={<EyeOutlined />} onClick={loadUnposted} size="small">
              View Unposted Vouchers
            </Button>
          </div>

          {unposted && (
            <Collapse style={{ marginTop: 12 }}>
              {Object.entries(unposted).map(([k, rows]) => (
                <Collapse.Panel
                  key={k}
                  header={
                    <span>{LABEL[k] || k}{' '}<Tag color={rows.length === 0 ? 'green' : 'orange'}>{rows.length}</Tag></span>
                  }
                >
                  {rows.length === 0
                    ? <Text type="secondary">All posted.</Text>
                    : <Table
                        size="small"
                        pagination={false}
                        rowKey="id"
                        dataSource={rows}
                        columns={[
                          { title: 'Number', dataIndex: 'number' },
                          { title: 'Date',   dataIndex: 'date' },
                        ]}
                      />}
                </Collapse.Panel>
              ))}
            </Collapse>
          )}
        </CollapsibleCard>
      )}

      {/* ── Section 3: Auto-Receipt Invariants ────────────────────── */}
      {data && (
        <CollapsibleCard
          icon={<SafetyCertificateOutlined />}
          title="Auto-Receipt Invariants"
          subtitle="Internal-consistency rules over the bill ↔ allocation ↔ ledger triangle"
          status={invariantsStatus}
          statusLabel={
            !autoData
              ? 'Loading…'
              : autoData.all_pass
                ? `${autoData.invariants.length} of ${autoData.invariants.length} green`
                : `${autoData.invariants.filter((i) => !i.ok).length} of ${autoData.invariants.length} violated`
          }
          defaultOpen={!invariantsOk}
          extra={
            <Button
              size="small"
              icon={<ReloadOutlined />}
              loading={autoLoading}
              onClick={loadAutoReceipt}
            >
              Refresh
            </Button>
          }
        >
          {!autoData && <Text type="secondary">Loading invariants…</Text>}
          {/* Auto-receipt section shows I1..I6 only; the batch
              invariants (I7/I8/B*) live in their own section below so
              the admin can find them without scrolling through every
              receipt-side rule. */}
          {autoData && autoData.invariants
            .filter((i) => !/^I[78]$|^B/.test(i.id))
            .map((inv) => <InvariantRow key={inv.id} inv={inv} />)}
        </CollapsibleCard>
      )}

      {/* ── Section 4: Stock Drift ────────────────────────────────── */}
      {data && stock && (
        <CollapsibleCard
          icon={<DatabaseOutlined />}
          title="Stock Drift"
          subtitle="Product on-hand must equal Σ(in − out) across the stock ledger"
          status={stockOk ? 'ok' : 'bad'}
          statusLabel={stockOk ? 'No drift' : `${stock.drifted_count} SKUs drifted`}
          defaultOpen={!stockOk}
        >
          {stockOk ? (
            <div style={{
              display: 'flex', alignItems: 'center', gap: 12,
              padding: '14px 16px',
              background: 'rgba(16,185,129,0.08)',
              border: '1px solid rgba(16,185,129,0.30)',
              borderRadius: 6,
            }}>
              <span style={{
                width: 32, height: 32, borderRadius: 8,
                background: '#10B981', color: '#fff',
                display: 'grid', placeItems: 'center', flexShrink: 0,
              }}>
                <CheckCircleFilled style={{ fontSize: 16 }} />
              </span>
              <div>
                <div style={{ fontWeight: 600, fontSize: 13.5, color: '#1f2937' }}>
                  All products match the stock ledger
                </div>
                <div style={{ fontSize: 12, color: '#6b7280', marginTop: 1 }}>
                  Tolerance ±0.005 units · {stock.sample?.length === 0 ? 'no sample to show' : 'no drift detected'}
                </div>
              </div>
            </div>
          ) : (
            <>
              <Alert
                type="warning"
                showIcon
                message={`${stock.drifted_count} SKU${stock.drifted_count === 1 ? '' : 's'} disagree with the stock ledger`}
                description="Listed below are the worst offenders (top 50). Drift indicates a write-side bug or a manual edit that bypassed both sides."
                style={{ marginBottom: 12 }}
              />
              <Table
                size="small"
                pagination={false}
                rowKey="product_id"
                dataSource={stock.sample || []}
                columns={[
                  { title: 'Product', dataIndex: 'product_name' },
                  { title: 'Barcode', dataIndex: 'barcode', width: 140,
                    render: (v) => <span style={{ fontVariantNumeric: 'tabular-nums', fontWeight: 600 }}>{v || '—'}</span> },
                  { title: 'On Hand', dataIndex: 'current_stock', align: 'right', width: 110,
                    render: (v) => <span style={{ fontVariantNumeric: 'tabular-nums', fontWeight: 600 }}>{fmt(v)}</span> },
                  { title: 'Stock Ledger', dataIndex: 'ledger_balance', align: 'right', width: 130,
                    render: (v) => <span style={{ fontVariantNumeric: 'tabular-nums', fontWeight: 600 }}>{fmt(v)}</span> },
                  { title: 'Drift', dataIndex: 'drift', align: 'right', width: 110,
                    render: (v) => <Tag color="red" style={{ fontVariantNumeric: 'tabular-nums', fontWeight: 600 }}>{fmt(v)}</Tag> },
                ]}
              />
            </>
          )}
        </CollapsibleCard>
      )}
      {/* ── Section 5: Batch Integrity (Commit 5) ──────────────────
          Renders only when the auto-receipt response contains any of
          the batch invariants (I7, I8, B3..B5) — those only fire when
          the global batch toggle is on, so the section auto-hides on
          installs that never enabled batch tracking. Auto-expands when
          any batch invariant fails. */}
      {(() => {
        if (!autoData) return null;
        const batchInvs = autoData.invariants.filter((i) => /^I[78]$|^B/.test(i.id));
        if (batchInvs.length === 0) return null;
        const allOk        = batchInvs.every((i) => i.ok);
        const violatedCount = batchInvs.filter((i) => !i.ok).length;
        return (
          <CollapsibleCard
            icon={<AppstoreOutlined />}
            title="Batch Integrity"
            subtitle="Per-batch on-hand must agree with product totals, the ledger, and the schema's NOT-NULL contract."
            status={allOk ? 'ok' : 'bad'}
            statusLabel={allOk
              ? `${batchInvs.length} of ${batchInvs.length} green`
              : `${violatedCount} of ${batchInvs.length} violated`}
            defaultOpen={!allOk}
            extra={
              <Button size="small" icon={<ReloadOutlined />} loading={autoLoading} onClick={loadAutoReceipt}>
                Refresh
              </Button>
            }
          >
            {batchInvs.map((inv) => <InvariantRow key={inv.id} inv={inv} />)}
          </CollapsibleCard>
        );
      })()}

      </div>{/* /scrollable body */}
    </div>
  );
}
