// ── Bank List ─────────────────────────────────────────────────────────
//
// Landing page for everything bank-related. One row per ledger account
// under sub_group 'Bank Accounts' or 'Bank OD A/c' with the metrics an
// operator wants to see at a glance:
//
//   • Current balance + Dr/Cr side
//   • 30-day inflow + outflow
//   • Uncleared count + ₹ value (cheques in transit)
//   • Last activity date
//
// Click any card → drill into Bank Statement for that bank, scoped to
// the current FY by default.
//
// Layout shares the .rpt-* chrome with every other report, so the page
// reads as a sibling of Cash Flow / Trial Balance / Stock Movers.
// Banks are presented as cards (not a table) because the relevant
// per-bank info doesn't fit one row neatly — and a 5-bank business
// has 5 rows, not 500. Cards scale better when the list is short.

import React, { useEffect, useState } from 'react';
import { Button, Dropdown, Modal, message } from 'antd';
import {
  ReloadOutlined, BankOutlined, PlusOutlined, MoreOutlined,
  EditOutlined, DeleteOutlined, EyeInvisibleOutlined, CheckCircleOutlined,
  WarningOutlined,
} from '@ant-design/icons';
import { useNavigate } from 'react-router-dom';
import dayjs from 'dayjs';
import { bankAPI } from '../../api';
import BankAccountModal from './BankAccountModal';
import './banks.css';

const fmtN = (v) => Number(v || 0).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const fmtRupees = (v) => {
  const n = Number(v) || 0;
  if (Math.abs(n) >= 1e7) return `₹ ${(n / 1e7).toFixed(2)} Cr`;
  if (Math.abs(n) >= 1e5) return `₹ ${(n / 1e5).toFixed(2)} L`;
  return `₹ ${n.toLocaleString('en-IN', { minimumFractionDigits: 0, maximumFractionDigits: 0 })}`;
};

export default function BankList() {
  const navigate = useNavigate();
  const [data, setData]   = useState(null);
  const [loading, setLd]  = useState(true);

  // Modal state — shared between Add (bank=null) and Edit (bank=row).
  const [modalOpen, setModalOpen] = useState(false);
  const [editing,   setEditing]   = useState(null);

  // Pass include_inactive=true so the management page sees retired
  // banks too (with an "Inactive" badge); the picker (BankLedgerSelect)
  // omits the flag so transaction forms only see active banks.
  const load = () => {
    setLd(true);
    bankAPI.list({ include_inactive: true })
      .then((r) => setData(r.data))
      .catch((e) => message.error(e.response?.data?.error || 'Failed to load banks'))
      .finally(() => setLd(false));
  };
  useEffect(load, []);

  const banks  = data?.banks  || [];
  const totals = data?.totals || {};

  const openAdd = () => { setEditing(null); setModalOpen(true); };
  const openEdit = (bank) => { setEditing(bank); setModalOpen(true); };

  // Toggle active state. The same PATCH endpoint covers both directions.
  const toggleActive = async (bank) => {
    const targetState = !bank.is_active;
    const verb = targetState ? 'Activate' : 'Deactivate';
    const blurb = targetState
      ? `"${bank.name}" will reappear in payment / receipt / sales bill bank pickers.`
      : `"${bank.name}" will be hidden from new transaction pickers, but ` +
        `its history (statements, reconciliation entries) stays visible.`;
    Modal.confirm({
      title: `${verb} "${bank.name}"?`,
      content: blurb,
      okText: verb,
      cancelText: 'Cancel',
      icon: targetState ? <CheckCircleOutlined style={{ color: '#10B981' }} />
                        : <EyeInvisibleOutlined style={{ color: '#F59E0B' }} />,
      onOk: async () => {
        try {
          await bankAPI.update(bank.ledger_id, { is_active: targetState });
          message.success(`"${bank.name}" ${targetState ? 'activated' : 'deactivated'}`);
          load();
        } catch (e) {
          message.error(e.response?.data?.error || `Failed to ${verb.toLowerCase()}`);
        }
      },
    });
  };

  // Delete attempt. Server enforces the safety rule (zero references)
  // — we just translate its 409 into a "would you rather deactivate?"
  // prompt. If the bank IS clean, we still confirm because deletion is
  // permanent and there's no undo.
  const deleteBank = async (bank) => {
    if (bank.is_system_ledger) {
      message.warning('System ledgers cannot be deleted');
      return;
    }

    // Pre-flight check using the txn_count we already have. Saves a
    // round-trip in the common "this bank has history" case.
    if ((bank.txn_count || 0) > 0) {
      Modal.confirm({
        title: `Cannot delete "${bank.name}"`,
        icon: <WarningOutlined style={{ color: '#F59E0B' }} />,
        content: (
          <div>
            This bank has <b>{bank.txn_count}</b> transaction{bank.txn_count === 1 ? '' : 's'} posted to it.
            Deleting would corrupt the ledger and trial balance.
            <div style={{ marginTop: 12 }}>
              Deactivate instead? It hides the bank from new transaction
              forms while keeping all history intact.
            </div>
          </div>
        ),
        okText: 'Deactivate',
        cancelText: 'Cancel',
        onOk: async () => {
          try {
            await bankAPI.update(bank.ledger_id, { is_active: false });
            message.success(`"${bank.name}" deactivated`);
            load();
          } catch (e) {
            message.error(e.response?.data?.error || 'Failed to deactivate');
          }
        },
      });
      return;
    }

    // Clean bank — confirm + hard delete.
    Modal.confirm({
      title: `Delete "${bank.name}"?`,
      icon: <DeleteOutlined style={{ color: '#EF4444' }} />,
      content: 'This bank has no transactions and can be safely deleted. This cannot be undone.',
      okText: 'Delete permanently',
      okButtonProps: { danger: true },
      cancelText: 'Cancel',
      onOk: async () => {
        try {
          await bankAPI.remove(bank.ledger_id);
          message.success(`"${bank.name}" deleted`);
          load();
        } catch (e) {
          // Server may still reject (e.g. payment_splits FK that we
          // didn't pre-check). Translate to the deactivate prompt.
          const r = e.response?.data;
          if (r?.suggest_deactivate) {
            Modal.confirm({
              title: `Cannot delete "${bank.name}"`,
              icon: <WarningOutlined style={{ color: '#F59E0B' }} />,
              content: r.error,
              okText: 'Deactivate',
              cancelText: 'Cancel',
              onOk: async () => {
                await bankAPI.update(bank.ledger_id, { is_active: false });
                load();
              },
            });
          } else {
            message.error(r?.error || 'Failed to delete');
          }
        }
      },
    });
  };

  return (
    <div className="bank-page">

      {/* ─── Title strip ────────────────────────────────────────────── */}
      <header className="rpt-page-hd">
        <div className="rpt-title">
          <h1>Banks</h1>
          {totals.inactive_count > 0 && (
            <div className="rpt-sub">
              {totals.bank_count} active
              <span className="sep">·</span>
              <span>{totals.inactive_count} inactive</span>
            </div>
          )}
        </div>
        <div className="rpt-hd-ctrl">
          <Button className="rpt-btn" icon={<ReloadOutlined />} loading={loading} onClick={load}>
            Refresh
          </Button>
          <Button className="rpt-btn" type="primary" icon={<PlusOutlined />} onClick={openAdd}>
            Add Bank
          </Button>
        </div>
      </header>

      {/* ─── KPI strip ──────────────────────────────────────────────── */}
      <section className="rpt-kpis">
        <div className="rpt-kpi tone-accent">
          <div className="rpt-kpi-k">Active Banks</div>
          <div className="rpt-kpi-v">{totals.bank_count || 0}</div>
          <div className="bank-kpi-sub">Across all accounts</div>
        </div>
        <div className="rpt-kpi tone-success">
          <div className="rpt-kpi-k">Total Bank Balance</div>
          <div className="rpt-kpi-v">{fmtRupees(totals.total_balance)}</div>
          <div className="bank-kpi-sub">Σ current book balance</div>
        </div>
        <div className="rpt-kpi tone-info">
          <div className="rpt-kpi-k">30-day Net Flow</div>
          <div className="rpt-kpi-v">
            {fmtRupees((totals.total_inflow || 0) - (totals.total_outflow || 0))}
          </div>
          <div className="bank-kpi-sub">
            in {fmtRupees(totals.total_inflow)} · out {fmtRupees(totals.total_outflow)}
          </div>
        </div>
        <div className={`rpt-kpi ${totals.total_uncleared > 0 ? 'tone-warning' : 'tone-success'}`}>
          <div className="rpt-kpi-k">Uncleared</div>
          <div className="rpt-kpi-v">{fmtRupees(totals.total_uncleared)}</div>
          <div className="bank-kpi-sub">In-transit cheques + deposits</div>
        </div>
      </section>

      {/* ─── Bank cards ──────────────────────────────────────────── */}
      <div className="bank-body">
        {!data ? (
          <div className="bank-empty">{loading ? 'Loading…' : 'No banks set up yet.'}</div>
        ) : banks.length === 0 ? (
          <div className="bank-empty">
            <BankOutlined style={{ fontSize: 32, marginBottom: 12, display: 'block' }} />
            No bank ledgers yet.
            <div style={{ fontSize: 13, marginTop: 8, fontWeight: 400 }}>
              Click <b>+ Add Bank</b> to create your first one.
            </div>
            <div style={{ marginTop: 14 }}>
              <Button type="primary" icon={<PlusOutlined />} onClick={openAdd}>Add Bank</Button>
            </div>
          </div>
        ) : (
          <div className="bank-grid">
            {banks.map((b) => (
              <BankCard
                key={b.ledger_id}
                bank={b}
                onOpen={() => navigate(`/banks/${b.ledger_id}/statement`)}
                onEdit={() => openEdit(b)}
                onToggleActive={() => toggleActive(b)}
                onDelete={() => deleteBank(b)}
              />
            ))}
          </div>
        )}
      </div>

      <BankAccountModal
        open={modalOpen}
        bank={editing}
        onClose={() => setModalOpen(false)}
        onSaved={load}
      />
    </div>
  );
}

// ── BankCard ──────────────────────────────────────────────────────
//
// One card per bank. Top row: name + sub_group badge + balance.
// Middle row: 30-day inflow + outflow with sparkline-style "deposit /
// withdrawal" colouring. Bottom strip: uncleared count + last activity.
//
// Inactive banks get a muted variant + an "Inactive" badge. The card is
// still clickable to view statement (history is intentionally still
// visible), but a 3-dot menu offers Activate / Delete (Edit too, for
// renames). Active banks show Edit / Deactivate / Delete.
function BankCard({ bank, onOpen, onEdit, onToggleActive, onDelete }) {
  const balanceColor = bank.balance >= 0 ? 'pos' : 'neg';
  const lastTxn = bank.last_txn_date
    ? dayjs(bank.last_txn_date).format('DD MMM YYYY')
    : '—';
  const lastTxnAge = bank.last_txn_date
    ? dayjs().diff(dayjs(bank.last_txn_date), 'day')
    : null;
  const dormant = lastTxnAge != null && lastTxnAge > 30;
  const isInactive = !bank.is_active;

  // Stop card clicks from drilling into the statement when the user
  // is interacting with the menu / triggers inside the card.
  const stop = (e) => e.stopPropagation();

  // Menu items — Edit always, Activate ↔ Deactivate, Delete last.
  // Delete is hidden for system ledgers (server would reject anyway).
  const menuItems = [
    { key: 'edit',   icon: <EditOutlined />,           label: 'Edit details' },
    { type: 'divider' },
    bank.is_active
      ? { key: 'deactivate', icon: <EyeInvisibleOutlined />, label: 'Deactivate' }
      : { key: 'activate',   icon: <CheckCircleOutlined style={{ color: '#10B981' }} />, label: 'Activate' },
    ...(bank.is_system_ledger ? [] : [
      { type: 'divider' },
      { key: 'delete', icon: <DeleteOutlined />, label: 'Delete', danger: true },
    ]),
  ];

  const onMenuClick = ({ key, domEvent }) => {
    domEvent?.stopPropagation();
    if (key === 'edit')        onEdit?.();
    if (key === 'activate' || key === 'deactivate') onToggleActive?.();
    if (key === 'delete')      onDelete?.();
  };

  return (
    <div
      className={`bank-card${isInactive ? ' bank-card-inactive' : ''}`}
      onClick={onOpen}
    >

      <div className="bank-card-hd">
        <div className="bank-card-id">
          <div className="ic">
            <BankOutlined />
          </div>
          <div className="bank-card-id-stack">
            <div className="name" title={bank.name}>{bank.name}</div>
            <div className="meta">
              <span className="meta-grp">{bank.sub_group}</span>
              {isInactive && <span className="bank-inactive-badge">Inactive</span>}
              {bank.is_overdraft && <span className="od-badge">OD</span>}
              {bank.is_system_ledger && <span className="bank-sys-badge" title="System ledger — used as fallback for legacy postings">System</span>}
            </div>
          </div>
        </div>
        <Dropdown
          menu={{ items: menuItems, onClick: onMenuClick }}
          trigger={['click']}
          placement="bottomRight"
        >
          <button
            className="bank-card-menu"
            onClick={stop}
            aria-label="More options"
          >
            <MoreOutlined />
          </button>
        </Dropdown>
      </div>

      <div className="bank-card-metrics">
        <div className={`metric-bal bal-${balanceColor}`}>
          <div className="lbl">Current Balance</div>
          <div className="row">
            <span className="amt">{fmtRupees(Math.abs(bank.balance))}</span>
            <span className="side">{bank.balance_side}</span>
          </div>
        </div>
        <div className="metric-flow">
          <div className="flow-cell">
            <div className="lbl">30-day Inflow</div>
            <div className="val pos">+{fmtRupees(bank.monthly_inflow)}</div>
          </div>
          <div className="flow-cell">
            <div className="lbl">30-day Outflow</div>
            <div className="val neg">−{fmtRupees(bank.monthly_outflow)}</div>
          </div>
        </div>
      </div>

      <div className="bank-card-foot">
        <div className="foot-l">
          {bank.uncleared_count > 0 ? (
            <span className="foot-uncl">
              <span className="dot"></span>
              <b>{bank.uncleared_count}</b> uncleared · {fmtRupees(bank.uncleared_value)}
            </span>
          ) : (
            <span className="foot-clear">
              <span className="dot ok"></span>
              All cleared
            </span>
          )}
        </div>
        <div className={'foot-r' + (dormant ? ' dormant' : '')}>
          Last activity {lastTxn}
        </div>
      </div>

      <div className="bank-card-cta">View Statement →</div>
    </div>
  );
}
