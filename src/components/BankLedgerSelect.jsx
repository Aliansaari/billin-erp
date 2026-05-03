// ── BankLedgerSelect ──────────────────────────────────────────────────
//
// Shared bank-picker for the entry forms (Payment / Receipt / Sales
// Bill). Wraps an Ant Design Select around bankAPI.list(). Emits the
// chosen ledger_id (number) via onChange — never an internal id, so the
// caller can stuff it straight into a payload as `bank_ledger_id`.
//
// UX choices made here on purpose:
//
//   • Smart default. If the user has exactly one bank ledger, we
//     auto-select it on mount (and tell the parent via onChange) so
//     the cashier doesn't have to click anything for the common
//     single-bank business. If they have many, we restore the
//     last-used pick from localStorage.
//   • Disabled / hidden by mode. The parent passes `mode` (the payment
//     mode string). For Cash, the picker is irrelevant — the parent
//     should hide the whole row, but if it doesn't, this component
//     disables itself and reports value=null so the backend knows it's
//     a cash leg.
//   • Balance display in the option label. Each option shows the bank
//     name + current balance; helps the cashier pick "the bank with
//     enough money" for a payment (or just confirm they're posting to
//     the right account).
//   • Quick-add link. When zero banks exist, shows a "Create a bank
//     ledger →" link that drops the operator into Settings → Banks
//     (or wherever bank ledgers are created).  Today that's the
//     /settings/ledgers page; if you build a dedicated bank-create
//     flow, point it there.
//
// Loads once per mount; refreshes via the `refreshKey` prop so the
// parent can force a reload after creating a bank from a modal.

import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Select, Spin, Typography } from 'antd';
import { BankOutlined, PlusOutlined } from '@ant-design/icons';
import { bankAPI } from '../api';

const LAST_USED_KEY = 'bank_ledger_select__last_used';

const fmtRupees = (v) => {
  const n = Number(v) || 0;
  if (Math.abs(n) >= 1e7) return `₹${(n / 1e7).toFixed(2)}Cr`;
  if (Math.abs(n) >= 1e5) return `₹${(n / 1e5).toFixed(2)}L`;
  return '₹' + n.toLocaleString('en-IN', { maximumFractionDigits: 0 });
};

/**
 * @param {object} props
 * @param {number|null} props.value          — selected bank ledger_id
 * @param {(id:number|null) => void} props.onChange
 * @param {string} [props.mode]              — current payment mode; if 'Cash', component is disabled
 * @param {boolean} [props.autoDefault=true] — auto-pick a default on mount
 * @param {object} [props.style]             — passthrough for the Select
 * @param {string} [props.placeholder='Select bank']
 * @param {number} [props.refreshKey]        — bump to force a reload
 */
export default function BankLedgerSelect({
  value,
  onChange,
  mode,
  autoDefault = true,
  style,
  placeholder = 'Select bank',
  refreshKey = 0,
}) {
  const [banks, setBanks]   = useState([]);
  const [loading, setLd]    = useState(true);
  const initRef = useRef(false);

  const isCash = String(mode || '').toLowerCase() === 'cash';

  // Load once + when refreshKey changes.
  useEffect(() => {
    let cancelled = false;
    setLd(true);
    bankAPI.list()
      .then((r) => {
        if (cancelled) return;
        const list = r.data?.banks || [];
        setBanks(list);
      })
      .catch(() => { if (!cancelled) setBanks([]); })
      .finally(() => { if (!cancelled) setLd(false); });
    return () => { cancelled = true; };
  }, [refreshKey]);

  // Smart default on first non-cash render after banks load.
  // Order: existing value (don't override) → last-used → first bank.
  useEffect(() => {
    if (!autoDefault || initRef.current || isCash || loading || banks.length === 0) return;
    if (value) { initRef.current = true; return; }

    const lastUsed = parseInt(localStorage.getItem(LAST_USED_KEY) || '0', 10);
    const lastUsedExists = lastUsed && banks.some((b) => b.ledger_id === lastUsed);
    const pick = lastUsedExists ? lastUsed : banks[0].ledger_id;
    onChange?.(pick);
    initRef.current = true;
  }, [autoDefault, isCash, loading, banks, value, onChange]);

  // When user switches to Cash, surface null to the parent so payload
  // stays clean. We don't clear in the other direction — switching from
  // Cash → Cheque should snap back to the last default.
  useEffect(() => {
    if (isCash && value != null) onChange?.(null);
  }, [isCash, value, onChange]);

  const options = useMemo(() => banks.map((b) => ({
    value: b.ledger_id,
    label: (
      <span style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <BankOutlined style={{ color: '#6B7280', fontSize: 12 }} />
        <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis' }}>
          {b.name}
          {b.is_overdraft && (
            <span style={{
              marginLeft: 6, fontSize: 10, fontWeight: 700, letterSpacing: 0.4,
              color: '#F59E0B', padding: '0 5px', borderRadius: 4,
              background: 'rgba(245,158,11,0.10)',
            }}>OD</span>
          )}
        </span>
        <span style={{
          fontSize: 11.5, fontWeight: 600,
          color: b.balance >= 0 ? '#10B981' : '#EF4444',
          fontVariantNumeric: 'tabular-nums',
        }}>
          {fmtRupees(Math.abs(b.balance))} {b.balance_side}
        </span>
      </span>
    ),
    // searchable label — AntD optionFilterProp uses this:
    searchText: b.name,
  })), [banks]);

  // The "no banks set up" empty state. Keeping the affordance close to
  // the picker (rather than throwing the cashier into Settings) is what
  // makes the form feel finished.
  if (!loading && banks.length === 0) {
    return (
      <div style={{
        padding: '6px 10px',
        border: '1px dashed #d1d5db',
        borderRadius: 6,
        fontSize: 12,
        color: '#6B7280',
      }}>
        <BankOutlined style={{ marginRight: 6 }} />
        No bank ledgers yet.{' '}
        <Typography.Link
          onClick={() => window.open('/banks', '_blank')}
          style={{ fontSize: 12 }}
        >
          <PlusOutlined style={{ fontSize: 11 }} /> Create one
        </Typography.Link>
      </div>
    );
  }

  return (
    <Select
      value={value || undefined}
      onChange={(v) => {
        onChange?.(v ?? null);
        if (v) localStorage.setItem(LAST_USED_KEY, String(v));
      }}
      options={options}
      placeholder={placeholder}
      disabled={isCash}
      loading={loading}
      style={style}
      showSearch
      optionFilterProp="searchText"
      notFoundContent={loading ? <Spin size="small" /> : 'No banks found'}
      // Render the selected option a bit more compactly than the dropdown
      // row. Using optionLabelProp would lose the custom JSX, so we just
      // override the trigger via labelRender (AntD v5).
      labelRender={(opt) => {
        const b = banks.find((x) => x.ledger_id === opt.value);
        if (!b) return opt.label;
        return (
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
            <BankOutlined style={{ color: '#6B7280', fontSize: 12 }} />
            <span>{b.name}</span>
          </span>
        );
      }}
    />
  );
}
