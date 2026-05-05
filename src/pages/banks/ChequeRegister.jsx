// ── Cheque Register ───────────────────────────────────────────────
//
// Lives at /banks/cheques. The bookkeeper's at-a-glance dashboard for
// every cheque the business is dealing with — inward + outward, in
// every state of its lifecycle.
//
// Layout, top to bottom:
//
//   1. .rpt-page-hd     — title strip + "Refresh / + Record cheque"
//   2. .rpt-kpis        — four-up KPI strip (Pending In, Deposited In,
//                         Outstanding Out, PDC). Each tile filters the
//                         table when clicked, mirroring the BankList
//                         and Reconciliation patterns.
//   3. .chq-filters     — chip strip: direction tabs, status chips,
//                         search box, date range, bank, PDC toggle
//   4. .chq-tbl         — the register itself (sortable column-fixed
//                         table sharing the .bank-tbl chrome)
//   5. .chq-foot        — footer summary line
//
// All data flows through chequeAPI.list(), which returns both the
// paginated rows AND a `kpis` rollup over the FULL filtered set so
// the strip reads the right population numbers regardless of page.

import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  Button, Dropdown, Modal, Drawer, Tooltip, Select, DatePicker, Input, message,
} from 'antd';
import {
  ReloadOutlined, PlusOutlined, MoreOutlined, EditOutlined, EyeOutlined,
  ArrowDownOutlined, ArrowUpOutlined, FileDoneOutlined,
  WalletOutlined, CheckCircleOutlined, WarningOutlined, StopOutlined,
  RedoOutlined, FieldTimeOutlined,
  SearchOutlined,
} from '@ant-design/icons';

// Reopening a CANCELLED cheque is a "redo" of its lifecycle; visually
// distinct from the page-Refresh ReloadOutlined to avoid conflating
// the two in the per-row dropdown.
const ReopenIcon = RedoOutlined;
import dayjs from 'dayjs';
import { chequeAPI, bankAPI } from '../../api';
import ChequeForm from './ChequeForm';
import {
  DepositModal, ClearModal, BounceModal, CancelModal,
} from './ChequeActionModals';
import './banks.css';
import './cheques.css';

const { RangePicker } = DatePicker;

const fmtN = (v) => Number(v || 0).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const fmtRupees = (v) => {
  const n = Number(v) || 0;
  if (Math.abs(n) >= 1e7) return `₹ ${(n / 1e7).toFixed(2)} Cr`;
  if (Math.abs(n) >= 1e5) return `₹ ${(n / 1e5).toFixed(2)} L`;
  return `₹ ${n.toLocaleString('en-IN', { minimumFractionDigits: 0, maximumFractionDigits: 0 })}`;
};

const STATUS_LABELS = {
  PENDING:   'Pending',
  DEPOSITED: 'In Transit',
  CLEARED:   'Cleared',
  BOUNCED:   'Bounced',
  CANCELLED: 'Cancelled',
};

// Tone for the aging pill — same buckets as BankReconciliation so the
// operator's mental model carries between pages. Days-since-cheque-date
// is the natural proxy for "how stale is this".
function agingTone(days) {
  if (days <= 7)  return 'tone-fresh';
  if (days <= 30) return 'tone-warm';
  if (days <= 90) return 'tone-warn';
  return 'tone-danger';
}

export default function ChequeRegister() {
  const [data, setData]       = useState(null);
  const [loading, setLoading] = useState(true);
  const [banks, setBanks]     = useState([]);

  // Filter state. Default direction=ALL so the operator sees the full
  // pipeline at first paint. Most-recent-first ordering is the
  // server's responsibility.
  const [direction, setDirection]       = useState('ALL');
  const [statusFilters, setStatusFilters] = useState([]);   // multi
  const [bankFilter, setBankFilter]     = useState('');
  const [pdcFilter, setPdcFilter]       = useState('');     // '', 'true', 'false'
  const [search, setSearch]             = useState('');
  const [dateRange, setDateRange]       = useState([null, null]);

  // Modal state.
  const [formOpen,    setFormOpen]    = useState(false);
  const [editing,     setEditing]     = useState(null);
  const [actionOpen,  setActionOpen]  = useState(null);   // 'deposit' | 'clear' | 'bounce' | 'cancel'
  const [actionRow,   setActionRow]   = useState(null);
  const [detailRow,   setDetailRow]   = useState(null);

  // Debounce search so every keystroke doesn't fan out to the server.
  const searchDebounce = useRef(null);
  const [debouncedSearch, setDebouncedSearch] = useState('');
  useEffect(() => {
    clearTimeout(searchDebounce.current);
    searchDebounce.current = setTimeout(() => setDebouncedSearch(search.trim()), 250);
    return () => clearTimeout(searchDebounce.current);
  }, [search]);

  const load = () => {
    setLoading(true);
    const params = { limit: 500 };
    if (direction !== 'ALL') params.direction = direction;
    if (statusFilters.length > 0) params.status = statusFilters.join(',');
    if (bankFilter) params.bank_id = bankFilter;
    if (pdcFilter) params.is_pdc = pdcFilter;
    if (debouncedSearch) params.search = debouncedSearch;
    if (dateRange[0] && dateRange[1]) {
      params.from_date = dateRange[0].format('YYYY-MM-DD');
      params.to_date   = dateRange[1].format('YYYY-MM-DD');
    }
    chequeAPI.list(params)
      .then((r) => setData(r.data))
      .catch((e) => message.error(e.response?.data?.error || 'Failed to load cheques'))
      .finally(() => setLoading(false));
  };

  useEffect(load, [direction, statusFilters, bankFilter, pdcFilter, debouncedSearch, dateRange]);

  useEffect(() => {
    bankAPI.list({ include_inactive: false })
      .then((r) => setBanks(r.data?.banks || []))
      .catch(() => setBanks([]));
  }, []);

  const rows = data?.data || [];
  const kpis = data?.kpis || {};

  const openCreate = () => { setEditing(null); setFormOpen(true); };
  const openEdit   = (row) => { setEditing(row); setFormOpen(true); };
  const openAction = (kind, row) => { setActionRow(row); setActionOpen(kind); };
  const closeAction = () => { setActionOpen(null); setActionRow(null); };

  // KPI tile click → narrow the table to that population. Click the
  // same tile again to clear (toggles).
  const setQuickFilter = (preset) => {
    if (preset === 'pending_inward') {
      const want = JSON.stringify(['INWARD', ['PENDING']]);
      const cur  = JSON.stringify([direction, statusFilters]);
      if (want === cur) { setDirection('ALL'); setStatusFilters([]); }
      else { setDirection('INWARD'); setStatusFilters(['PENDING']); }
    } else if (preset === 'deposited_inward') {
      const want = JSON.stringify(['INWARD', ['DEPOSITED']]);
      const cur  = JSON.stringify([direction, statusFilters]);
      if (want === cur) { setDirection('ALL'); setStatusFilters([]); }
      else { setDirection('INWARD'); setStatusFilters(['DEPOSITED']); }
    } else if (preset === 'outstanding_outward') {
      const want = JSON.stringify(['OUTWARD', ['PENDING']]);
      const cur  = JSON.stringify([direction, statusFilters]);
      if (want === cur) { setDirection('ALL'); setStatusFilters([]); }
      else { setDirection('OUTWARD'); setStatusFilters(['PENDING']); }
    } else if (preset === 'pdc') {
      const flip = pdcFilter === 'true' ? '' : 'true';
      setPdcFilter(flip);
    }
  };

  const toggleStatus = (s) => {
    setStatusFilters((prev) => prev.includes(s)
      ? prev.filter((x) => x !== s)
      : [...prev, s]);
  };

  // Confirm reopen — only for CANCELLED. Wrapped in Modal.confirm
  // because re-posting vouchers is a meaningful action (not a typo
  // recovery), and we want one extra "are you sure".
  const handleReopen = (row) => {
    Modal.confirm({
      title: 'Reopen this cheque?',
      icon: <ReopenIcon style={{ color: '#4F46E5' }} />,
      content: 'The cheque goes back to PENDING and the receipt/issue voucher gets re-posted.',
      okText: 'Reopen',
      cancelText: 'Cancel',
      onOk: async () => {
        try {
          await chequeAPI.reopen(row.cheque_id);
          message.success('Cheque reopened');
          load();
        } catch (e) {
          message.error(e.response?.data?.error || 'Failed to reopen');
        }
      },
    });
  };

  // ── Render ──
  return (
    <div className="chq-page">

      {/* ─── Title strip ───────────────────────────────────────── */}
      <header className="rpt-page-hd">
        <div className="rpt-title">
          <h1>Cheques</h1>
          <div className="rpt-sub">
            {kpis.total?.count || 0} on file
            {kpis.pdc?.count > 0 && (
              <>
                <span className="sep">·</span>
                <span>{kpis.pdc.count} PDC</span>
              </>
            )}
          </div>
        </div>
        <div className="rpt-hd-ctrl">
          <Button className="rpt-btn" icon={<ReloadOutlined />} loading={loading} onClick={load}>
            Refresh
          </Button>
          <Button className="rpt-btn" type="primary" icon={<PlusOutlined />} onClick={openCreate}>
            Record cheque
          </Button>
        </div>
      </header>

      {/* ─── KPI strip ─────────────────────────────────────────── */}
      <section className="rpt-kpis">
        <KpiTile
          tone="accent"
          label="Pending Inward"
          value={fmtRupees(kpis.pending_inward?.value)}
          sub={`${kpis.pending_inward?.count || 0} in your drawer`}
          icon={<ArrowDownOutlined />}
          active={direction === 'INWARD' && statusFilters.length === 1 && statusFilters[0] === 'PENDING'}
          onClick={() => setQuickFilter('pending_inward')}
        />
        <KpiTile
          tone="warning"
          label="In Transit (Deposited)"
          value={fmtRupees(kpis.deposited_inward?.value)}
          sub={`${kpis.deposited_inward?.count || 0} awaiting clearance`}
          icon={<WalletOutlined />}
          active={direction === 'INWARD' && statusFilters.length === 1 && statusFilters[0] === 'DEPOSITED'}
          onClick={() => setQuickFilter('deposited_inward')}
        />
        <KpiTile
          tone="info"
          label="Outstanding Outward"
          value={fmtRupees(kpis.outstanding_outward?.value)}
          sub={`${kpis.outstanding_outward?.count || 0} awaiting presentation`}
          icon={<ArrowUpOutlined />}
          active={direction === 'OUTWARD' && statusFilters.length === 1 && statusFilters[0] === 'PENDING'}
          onClick={() => setQuickFilter('outstanding_outward')}
        />
        <KpiTile
          tone={kpis.pdc?.count > 0 ? 'warning' : 'success'}
          label="Post-dated Cheques"
          value={fmtRupees(kpis.pdc?.value)}
          sub={`${kpis.pdc?.count || 0} not yet matured`}
          icon={<FieldTimeOutlined />}
          active={pdcFilter === 'true'}
          onClick={() => setQuickFilter('pdc')}
        />
      </section>

      {/* ─── Filter strip ──────────────────────────────────────── */}
      <div className="chq-filters">
        {/* Direction segmented chips */}
        <div className="chq-filter-group">
          {['ALL', 'INWARD', 'OUTWARD'].map((d) => (
            <button
              key={d}
              className={`chq-filter-chip${direction === d ? ' on' : ''}`}
              onClick={() => setDirection(d)}
            >
              {d === 'ALL' ? 'All' : d === 'INWARD' ? 'Inward' : 'Outward'}
            </button>
          ))}
        </div>

        {/* Status multi-select chips */}
        <div className="chq-filter-group">
          {Object.keys(STATUS_LABELS).map((s) => (
            <button
              key={s}
              className={`chq-filter-chip${statusFilters.includes(s) ? ' on' : ''}`}
              onClick={() => toggleStatus(s)}
            >
              {STATUS_LABELS[s]}
            </button>
          ))}
        </div>

        <Input
          className="chq-filter-search"
          allowClear
          prefix={<SearchOutlined />}
          placeholder="Cheque #"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />

        <RangePicker
          format="DD MMM YYYY"
          value={dateRange[0] ? dateRange : null}
          onChange={(v) => setDateRange(v || [null, null])}
          allowClear
          style={{ height: 32 }}
        />

        <Select
          allowClear
          placeholder="All banks"
          value={bankFilter || undefined}
          onChange={(v) => setBankFilter(v || '')}
          style={{ minWidth: 180 }}
          options={banks.map((b) => ({
            value: b.ledger_id,
            label: b.name + (b.is_overdraft ? ' (OD)' : ''),
          }))}
        />

        <div className="chq-filter-grow" />
        <span style={{ fontSize: 12.5, color: 'var(--fg-tertiary)' }}>
          Showing <b style={{ color: 'var(--fg-primary)' }}>{rows.length}</b> of {data?.total || 0}
        </span>
      </div>

      {/* ─── Body — table or empty ──────────────────────────────── */}
      <div className="chq-body">
        {loading && !data ? (
          <div className="chq-empty">Loading…</div>
        ) : rows.length === 0 ? (
          <div className="chq-empty">
            <FileDoneOutlined className="ic" />
            No cheques match these filters.
            <div style={{ fontSize: 13, marginTop: 8, fontWeight: 400, color: 'var(--fg-secondary)' }}>
              {data?.total === 0
                ? <>Click <b>+ Record cheque</b> to enter your first one.</>
                : 'Try clearing some filters.'}
            </div>
          </div>
        ) : (
          <table className="chq-tbl">
            <thead>
              <tr>
                <th className="l">Cheque</th>
                <th className="l">Direction</th>
                <th className="l">Party</th>
                <th className="l">Bank</th>
                <th>Amount</th>
                <th className="c">Status</th>
                <th className="c">Aging</th>
                <th className="c">Actions</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <ChequeRow
                  key={r.cheque_id}
                  row={r}
                  onView={() => setDetailRow(r)}
                  onEdit={() => openEdit(r)}
                  onDeposit={() => openAction('deposit', r)}
                  onClear={() => openAction('clear', r)}
                  onBounce={() => openAction('bounce', r)}
                  onCancel={() => openAction('cancel', r)}
                  onReopen={() => handleReopen(r)}
                />
              ))}
            </tbody>
          </table>
        )}
      </div>

      {/* ─── Footer summary ─────────────────────────────────────── */}
      <div className="chq-foot">
        <div>
          <b>{kpis.total?.count || 0}</b> total cheques · <b>{fmtRupees(kpis.total?.value)}</b> on the books
        </div>
        <div>
          {kpis.bounced?.count > 0 && (
            <span style={{ color: '#B91C1C', fontWeight: 600 }}>
              {kpis.bounced.count} bounced ({fmtRupees(kpis.bounced.value)})
            </span>
          )}
        </div>
      </div>

      {/* ─── Modals ─────────────────────────────────────────────── */}
      <ChequeForm
        open={formOpen}
        cheque={editing}
        onClose={() => setFormOpen(false)}
        onSaved={load}
      />
      <DepositModal
        open={actionOpen === 'deposit'}
        cheque={actionRow}
        onClose={closeAction}
        onSaved={load}
      />
      <ClearModal
        open={actionOpen === 'clear'}
        cheque={actionRow}
        onClose={closeAction}
        onSaved={load}
      />
      <BounceModal
        open={actionOpen === 'bounce'}
        cheque={actionRow}
        onClose={closeAction}
        onSaved={load}
      />
      <CancelModal
        open={actionOpen === 'cancel'}
        cheque={actionRow}
        onClose={closeAction}
        onSaved={load}
      />

      <ChequeDetailDrawer
        open={!!detailRow}
        chequeId={detailRow?.cheque_id}
        onClose={() => setDetailRow(null)}
      />
    </div>
  );
}

// ── KPI tile — clickable so the operator can drill in. ─────────────
function KpiTile({ tone, label, value, sub, icon, active, onClick }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`rpt-kpi tone-${tone}${active ? ' on' : ''}`}
      style={{
        position: 'relative',
        textAlign: 'left',
        font: 'inherit',
        cursor: 'pointer',
        outline: active ? '2px solid var(--accent)' : 'none',
        outlineOffset: -2,
      }}
    >
      <div className="rpt-kpi-k">{label}</div>
      <div className="rpt-kpi-v">{value}</div>
      <div className="chq-kpi-sub">{sub}</div>
      <div className="chq-kpi-icon">{icon}</div>
    </button>
  );
}

// ── Single row in the register ────────────────────────────────────
function ChequeRow({ row, onView, onEdit, onDeposit, onClear, onBounce, onCancel, onReopen }) {
  const status = row.status;
  const dir = row.direction;
  const isInward = dir === 'INWARD';
  const isOutward = dir === 'OUTWARD';

  const days = dayjs().diff(dayjs(row.cheque_date), 'day');

  // Synced-from-payment rows are owned by the Payment entry — bounce,
  // cancel, reopen, and deposit all belong on the Payments page so
  // the bill allocations stay consistent. Clear (flag flip) is still
  // safe here because it just sets the cleared_at marker, mirroring
  // the bank reconciliation toggle.
  const isSynced = !!row.source_payment_id;

  // Build the per-row dropdown menu items based on the current state.
  // The lifecycle is one-way; only the legal next steps are listed.
  const menuItems = [
    { key: 'view', icon: <EyeOutlined />, label: 'View entries' },
    ...(['PENDING', 'DEPOSITED'].includes(status)
      ? [{ key: 'edit', icon: <EditOutlined />, label: isSynced ? 'Edit notes' : 'Edit' }]
      : ['CLEARED', 'BOUNCED'].includes(status)
        ? [{ key: 'edit', icon: <EditOutlined />, label: 'Edit notes' }]
        : []),
    { type: 'divider' },
    ...(isInward && status === 'PENDING' && !isSynced ? [
      { key: 'deposit', icon: <WalletOutlined />, label: 'Deposit' },
    ] : []),
    ...((isInward && status === 'DEPOSITED') || (isOutward && status === 'PENDING') ? [
      { key: 'clear', icon: <CheckCircleOutlined style={{ color: '#10B981' }} />, label: 'Mark cleared' },
    ] : []),
    ...(['PENDING', 'DEPOSITED'].includes(status) && !isSynced ? [
      { key: 'bounce', icon: <WarningOutlined style={{ color: '#EF4444' }} />, label: 'Mark bounced' },
    ] : []),
    ...(['PENDING', 'DEPOSITED'].includes(status) && !isSynced ? [
      { type: 'divider' },
      { key: 'cancel', icon: <StopOutlined />, label: 'Cancel cheque', danger: true },
    ] : []),
    ...(status === 'CANCELLED' && !isSynced ? [
      { key: 'reopen', icon: <ReopenIcon />, label: 'Reopen' },
    ] : []),
  ];

  const onMenuClick = ({ key }) => {
    if (key === 'view') onView();
    if (key === 'edit') onEdit();
    if (key === 'deposit') onDeposit();
    if (key === 'clear') onClear();
    if (key === 'bounce') onBounce();
    if (key === 'cancel') onCancel();
    if (key === 'reopen') onReopen();
  };

  // Primary CTA — the most-likely-next action shown as a chip so the
  // operator doesn't always have to open the menu. Suppress the
  // primary CTA on synced rows that don't have a sensible default
  // (deposit / reopen are payments-page-side concerns).
  let primaryCta = null;
  if (isInward && status === 'PENDING' && !isSynced) {
    primaryCta = <button className="chq-action-chip primary" onClick={onDeposit}>Deposit</button>;
  } else if ((isInward && status === 'DEPOSITED') || (isOutward && status === 'PENDING')) {
    primaryCta = <button className="chq-action-chip primary" onClick={onClear}>Clear</button>;
  } else if (status === 'CANCELLED' && !isSynced) {
    primaryCta = <button className="chq-action-chip" onClick={onReopen}>Reopen</button>;
  }

  return (
    <tr
      className={
        status === 'BOUNCED' ? 'tone-bounced' :
        status === 'CANCELLED' ? 'tone-cancelled' :
        status === 'CLEARED' ? 'tone-cleared' : ''
      }
      onDoubleClick={onView}
    >
      <td className="l">
        <div className="chq-num">
          #{row.cheque_number}
          <div className="meta">
            <span>{dayjs(row.cheque_date).format('DD MMM YYYY')}</span>
            {row.is_pdc && (
              <Tooltip title="Post-dated cheque">
                <span className="chq-pdc">PDC</span>
              </Tooltip>
            )}
            {row.sourcePayment?.transaction_number && (
              <Tooltip title={`Auto-recorded from ${row.sourcePayment.transaction_number}. Edit / void on the Payments page.`}>
                <span className="chq-from-pay">
                  from {row.sourcePayment.transaction_number}
                </span>
              </Tooltip>
            )}
          </div>
        </div>
      </td>

      <td className="l">
        <span className={`chq-dir ${isInward ? 'in' : 'out'}`}>
          {isInward ? <ArrowDownOutlined /> : <ArrowUpOutlined />}
          {isInward ? 'In' : 'Out'}
        </span>
      </td>

      <td className="l">
        <div style={{ fontWeight: 600 }}>{row.party?.party_name || '—'}</div>
        {row.drawee_bank_name && (
          <div style={{ fontSize: 11.5, color: 'var(--fg-tertiary)' }}>
            via {row.drawee_bank_name}
          </div>
        )}
      </td>

      <td className="l">
        {row.bank?.ledger_name || (
          <span style={{ color: 'var(--fg-quaternary)' }}>—</span>
        )}
        {row.bank?.sub_group === 'Bank OD A/c' && (
          <span style={{
            marginLeft: 6,
            padding: '0 5px',
            borderRadius: 3,
            fontSize: 9.5,
            background: 'rgba(245,158,11,0.12)',
            color: '#F59E0B',
            fontWeight: 700,
          }}>OD</span>
        )}
      </td>

      <td>
        <span className="chq-amt-val">{fmtN(row.amount)}</span>
      </td>

      <td className="c">
        <span className={`chq-status s-${status.toLowerCase()}`}>
          <span className="dot" />
          {STATUS_LABELS[status]}
        </span>
      </td>

      <td className="c">
        {['CANCELLED', 'CLEARED', 'BOUNCED'].includes(status) ? (
          <span style={{ color: 'var(--fg-quaternary)' }}>—</span>
        ) : (
          <span className={`chq-aging ${agingTone(days)}`}>
            {days}d
          </span>
        )}
      </td>

      <td className="c">
        <div className="chq-actions" style={{ justifyContent: 'flex-end' }}>
          {primaryCta}
          <Dropdown
            menu={{ items: menuItems, onClick: onMenuClick }}
            trigger={['click']}
            placement="bottomRight"
          >
            <button
              className="chq-row-menu"
              aria-label="More actions"
              onClick={(e) => e.stopPropagation()}
            >
              <MoreOutlined />
            </button>
          </Dropdown>
        </div>
      </td>
    </tr>
  );
}

// ── Detail drawer: full meta + posted ledger entries ─────────────
function ChequeDetailDrawer({ open, chequeId, onClose }) {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!open || !chequeId) { setData(null); return; }
    setLoading(true);
    chequeAPI.getById(chequeId)
      .then((r) => setData(r.data))
      .catch((e) => message.error(e.response?.data?.error || 'Failed to load cheque'))
      .finally(() => setLoading(false));
  }, [open, chequeId]);

  if (!data) {
    return (
      <Drawer open={open} onClose={onClose} width={620} title="Cheque details">
        {loading ? 'Loading…' : '—'}
      </Drawer>
    );
  }

  const c = data;

  // Group ledger entries by entry_number so each voucher shows as
  // its own block. reversed-pair detection: if entry has reversal_of_id
  // it's a mirror; if its entry_id appears as another row's
  // reversal_of_id it's a reversed original.
  const entries = data.ledger_entries || [];
  const reversedIds = new Set(
    entries.filter((e) => e.reversal_of_id != null).map((e) => e.reversal_of_id),
  );
  const grouped = new Map();
  for (const e of entries) {
    const isReversed = reversedIds.has(e.entry_id) || e.reversal_of_id != null;
    const key = e.entry_number;
    if (!grouped.has(key)) {
      grouped.set(key, { entry_number: key, lines: [], type: e.voucher_type, source: e.source_type, date: e.entry_date, isReversed });
    }
    grouped.get(key).lines.push({ ...e, isReversedRow: e.reversal_of_id != null || reversedIds.has(e.entry_id) });
  }
  const voucherGroups = Array.from(grouped.values()).sort((a, b) => a.entry_number.localeCompare(b.entry_number));

  return (
    <Drawer
      open={open}
      onClose={onClose}
      width={680}
      title={
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
          <FileDoneOutlined style={{ color: '#4F46E5' }} />
          Cheque #{c.cheque_number}
        </span>
      }
    >
      {/* Meta strip */}
      <div className="chq-meta-grid" style={{ marginBottom: 14 }}>
        <div>
          <div className="lbl">Direction</div>
          <div className="val">
            <span className={`chq-dir ${c.direction === 'INWARD' ? 'in' : 'out'}`}>
              {c.direction === 'INWARD' ? <ArrowDownOutlined /> : <ArrowUpOutlined />}
              {c.direction === 'INWARD' ? 'Inward' : 'Outward'}
            </span>
          </div>
        </div>
        <div>
          <div className="lbl">Status</div>
          <div className="val">
            <span className={`chq-status s-${c.status.toLowerCase()}`}>
              <span className="dot" />
              {STATUS_LABELS[c.status]}
            </span>
          </div>
        </div>
        <div>
          <div className="lbl">Amount</div>
          <div className="val" style={{ fontVariantNumeric: 'tabular-nums', fontSize: 14 }}>{fmtRupees(c.amount)}</div>
        </div>
        <div>
          <div className="lbl">Cheque date</div>
          <div className="val">{dayjs(c.cheque_date).format('DD MMM YYYY')} {c.is_pdc && <span className="chq-pdc">PDC</span>}</div>
        </div>
        <div>
          <div className="lbl">{c.direction === 'INWARD' ? 'Received on' : 'Issued on'}</div>
          <div className="val">{dayjs(c.instrument_date).format('DD MMM YYYY')}</div>
        </div>
        {c.deposit_date && (
          <div>
            <div className="lbl">Deposited on</div>
            <div className="val">{dayjs(c.deposit_date).format('DD MMM YYYY')}</div>
          </div>
        )}
        {c.clearance_date && (
          <div>
            <div className="lbl">Cleared on</div>
            <div className="val">{dayjs(c.clearance_date).format('DD MMM YYYY')}</div>
          </div>
        )}
        {c.bounce_date && (
          <div>
            <div className="lbl">Bounced on</div>
            <div className="val">{dayjs(c.bounce_date).format('DD MMM YYYY')}</div>
          </div>
        )}
        <div>
          <div className="lbl">{c.direction === 'INWARD' ? 'From customer' : 'To supplier'}</div>
          <div className="val">{c.party?.party_name || '—'}</div>
        </div>
        {c.bank && (
          <div>
            <div className="lbl">Our bank</div>
            <div className="val">{c.bank.ledger_name}</div>
          </div>
        )}
        {c.drawee_bank_name && (
          <div>
            <div className="lbl">Drawee bank</div>
            <div className="val">{c.drawee_bank_name}</div>
          </div>
        )}
        {Number(c.bounce_charges) > 0 && (
          <div>
            <div className="lbl">Bounce charges</div>
            <div className="val" style={{ color: '#B91C1C' }}>{fmtRupees(c.bounce_charges)}</div>
          </div>
        )}
      </div>

      {(c.bounce_reason || c.notes) && (
        <div className="chq-detail-section">
          {c.bounce_reason && (
            <>
              <div className="chq-detail-hd">
                {c.status === 'BOUNCED' ? 'Bounce reason'
                  : c.status === 'CANCELLED' ? 'Cancellation reason'
                  : 'Reason'}
              </div>
              <div style={{ marginBottom: 10, whiteSpace: 'pre-wrap' }}>{c.bounce_reason}</div>
            </>
          )}
          {c.notes && (
            <>
              <div className="chq-detail-hd">Notes</div>
              <div style={{ whiteSpace: 'pre-wrap' }}>{c.notes}</div>
            </>
          )}
        </div>
      )}

      {/* Posted vouchers */}
      <div className="chq-detail-section">
        <div className="chq-detail-hd">Posted vouchers</div>
        {voucherGroups.length === 0 ? (
          <div style={{ color: 'var(--fg-tertiary)', fontStyle: 'italic' }}>
            No ledger entries posted yet.
          </div>
        ) : voucherGroups.map((g) => (
          <div key={g.entry_number} style={{ marginBottom: 12 }}>
            <div style={{ fontSize: 12, fontWeight: 700, color: 'var(--fg-secondary)', marginBottom: 4 }}>
              {g.entry_number} · {g.type} · {dayjs(g.date).format('DD MMM YYYY')}
              <span style={{ marginLeft: 8, color: 'var(--fg-tertiary)', fontWeight: 500 }}>
                ({g.source.replace(/_/g, ' ')})
              </span>
            </div>
            <table className="chq-detail-tbl">
              <thead>
                <tr>
                  <th>Ledger</th>
                  <th style={{ textAlign: 'right' }}>Debit</th>
                  <th style={{ textAlign: 'right' }}>Credit</th>
                </tr>
              </thead>
              <tbody>
                {g.lines.map((ln) => (
                  <tr key={ln.entry_id} className={ln.isReversedRow ? 'reversed' : ''}>
                    <td>{ln.LedgerAccount?.ledger_name || ln.ledger_id}</td>
                    <td className="num dr">{Number(ln.debit_amount) > 0 ? fmtN(ln.debit_amount) : ''}</td>
                    <td className="num cr">{Number(ln.credit_amount) > 0 ? fmtN(ln.credit_amount) : ''}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ))}
      </div>
    </Drawer>
  );
}
