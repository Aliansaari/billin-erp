// ── Loan List ──────────────────────────────────────────────────────
//
// Mirror of BankList. Card grid; each card shows the loan's name,
// outstanding balance, principal/interest paid, EMI progress bar,
// next-due date with overdue marker, 3-dot menu for lifecycle.
//
// Click a card → drill into Loan Statement (with Schedule tab).

import React, { useEffect, useState } from 'react';
import { Button, Dropdown, Modal, message, Progress } from 'antd';
import {
  ReloadOutlined, BankOutlined, PlusOutlined, MoreOutlined,
  EditOutlined, DeleteOutlined, EyeInvisibleOutlined, CheckCircleOutlined,
  WarningOutlined, RiseOutlined, FallOutlined, DollarOutlined,
} from '@ant-design/icons';
import { useNavigate } from 'react-router-dom';
import dayjs from 'dayjs';
import { loanAPI } from '../../api';
import useListSelection from '../../hooks/useListSelection';
import ActionStrip from '../../components/keyboard/ActionStrip';
import LoanAccountModal from './LoanAccountModal';
import RecordEMIModal from './RecordEMIModal';
import './loans.css';

const fmtN = (v) => Number(v || 0).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const fmtRupees = (v) => {
  const n = Number(v) || 0;
  if (Math.abs(n) >= 1e7) return `₹ ${(n / 1e7).toFixed(2)} Cr`;
  if (Math.abs(n) >= 1e5) return `₹ ${(n / 1e5).toFixed(2)} L`;
  return `₹ ${n.toLocaleString('en-IN', { minimumFractionDigits: 0, maximumFractionDigits: 0 })}`;
};

export default function LoanList() {
  const navigate = useNavigate();
  const [data, setData]   = useState(null);
  const [loading, setLd]  = useState(true);

  const [modalOpen, setModalOpen] = useState(false);
  const [editing,   setEditing]   = useState(null);
  const [emiOpen,   setEmiOpen]   = useState(false);
  const [emiLoan,   setEmiLoan]   = useState(null);

  const load = () => {
    setLd(true);
    loanAPI.list({ include_inactive: true })
      .then((r) => setData(r.data))
      .catch((e) => message.error(e.response?.data?.error || 'Failed to load loans'))
      .finally(() => setLd(false));
  };
  useEffect(load, []);

  const loans  = data?.loans  || [];
  const totals = data?.totals || {};

  // Cursor + multi-select runs over the loan cards. The F-key strip
  // below acts on the cursored loan.
  const sel = useListSelection({ totalCount: loans.length, rows: loans });
  const single = sel.activeRow;

  const openAdd = () => { setEditing(null); setModalOpen(true); };
  const openEdit = (loan) => { setEditing(loan); setModalOpen(true); };
  const openEmi  = (loan) => { setEmiLoan(loan); setEmiOpen(true); };

  const toggleActive = async (loan) => {
    const target = !loan.is_active;
    const verb = target ? 'Activate' : 'Deactivate';
    Modal.confirm({
      title: `${verb} "${loan.name}"?`,
      content: target
        ? `"${loan.name}" will reappear in any loan-aware UI.`
        : `"${loan.name}" will be hidden from new transactions and the upcoming-EMI dashboard. ` +
          `Statement / schedule history stays accessible.`,
      okText: verb,
      icon: target ? <CheckCircleOutlined style={{ color: '#10B981' }} /> :
                     <EyeInvisibleOutlined style={{ color: '#F59E0B' }} />,
      onOk: async () => {
        try {
          await loanAPI.update(loan.ledger_id, { is_active: target });
          message.success(`"${loan.name}" ${target ? 'activated' : 'deactivated'}`);
          load();
        } catch (e) { message.error(e.response?.data?.error || `Failed to ${verb.toLowerCase()}`); }
      },
    });
  };

  const deleteLoan = async (loan) => {
    if ((loan.txn_count || 0) > 0) {
      Modal.confirm({
        title: `Cannot delete "${loan.name}"`,
        icon: <WarningOutlined style={{ color: '#F59E0B' }} />,
        content: (
          <div>
            This loan has <b>{loan.txn_count}</b> EMI{loan.txn_count === 1 ? '' : 's'} recorded against it.
            Deleting would corrupt the trial balance.
            <div style={{ marginTop: 12 }}>
              Deactivate instead? It hides the loan from new EMI / journal entries while keeping all history intact.
            </div>
          </div>
        ),
        okText: 'Deactivate',
        onOk: () => loanAPI.update(loan.ledger_id, { is_active: false }).then(() => {
          message.success(`"${loan.name}" deactivated`);
          load();
        }),
      });
      return;
    }
    Modal.confirm({
      title: `Delete "${loan.name}"?`,
      icon: <DeleteOutlined style={{ color: '#EF4444' }} />,
      content: 'This loan has no EMIs recorded and can be safely deleted. This cannot be undone.',
      okText: 'Delete permanently',
      okButtonProps: { danger: true },
      onOk: async () => {
        try {
          await loanAPI.remove(loan.ledger_id);
          message.success(`"${loan.name}" deleted`);
          load();
        } catch (e) {
          const r = e.response?.data;
          if (r?.suggest_deactivate) {
            Modal.confirm({
              title: `Cannot delete "${loan.name}"`,
              content: r.error,
              okText: 'Deactivate',
              onOk: () => loanAPI.update(loan.ledger_id, { is_active: false }).then(load),
            });
          } else {
            message.error(r?.error || 'Failed to delete');
          }
        }
      },
    });
  };

  return (
    <div className="bank-page loan-page">

      {/* ─── Title strip ────────────────────────────────────────────── */}
      <header className="rpt-page-hd">
        <div className="rpt-title">
          <h1>Loans</h1>
          <div className="rpt-sub">
            {totals.taken_count || 0} taken
            <span className="sep">·</span>
            {totals.given_count || 0} given
            {totals.overdue_count > 0 && (
              <>
                <span className="sep">·</span>
                <span style={{ color: '#EF4444', fontWeight: 600 }}>
                  {totals.overdue_count} overdue
                </span>
              </>
            )}
            {totals.inactive_count > 0 && (
              <>
                <span className="sep">·</span>
                <span>{totals.inactive_count} inactive</span>
              </>
            )}
          </div>
        </div>
        <div className="rpt-hd-ctrl">
          <Button className="rpt-btn" icon={<ReloadOutlined />} loading={loading} onClick={load}>
            Refresh
          </Button>
          <Button className="rpt-btn" type="primary" icon={<PlusOutlined />} onClick={openAdd}>
            Add Loan
          </Button>
        </div>
      </header>

      {/* ─── KPI strip ──────────────────────────────────────────────── */}
      <section className="rpt-kpis">
        <div className="rpt-kpi tone-accent">
          <div className="rpt-kpi-k">Active Loans</div>
          <div className="rpt-kpi-v">{totals.loan_count || 0}</div>
          <div className="bank-kpi-sub">Across all account types</div>
        </div>
        <div className="rpt-kpi tone-warning">
          <div className="rpt-kpi-k">Total Outstanding</div>
          <div className="rpt-kpi-v">{fmtRupees(totals.total_outstanding)}</div>
          <div className="bank-kpi-sub">Σ unpaid principal</div>
        </div>
        <div className="rpt-kpi tone-success">
          <div className="rpt-kpi-k">Principal Repaid</div>
          <div className="rpt-kpi-v">{fmtRupees(totals.total_principal_paid)}</div>
          <div className="bank-kpi-sub">of {fmtRupees(totals.total_principal)} borrowed/lent</div>
        </div>
        <div className="rpt-kpi tone-info">
          <div className="rpt-kpi-k">Interest Paid / Earned</div>
          <div className="rpt-kpi-v">{fmtRupees(totals.total_interest_paid)}</div>
          <div className="bank-kpi-sub">Cumulative across all loans</div>
        </div>
      </section>

      {/* ─── Loan cards ──────────────────────────────────────────── */}
      <div className="bank-body">
        {!data ? (
          <div className="bank-empty">{loading ? 'Loading…' : ''}</div>
        ) : loans.length === 0 ? (
          <div className="bank-empty">
            <BankOutlined style={{ fontSize: 32, marginBottom: 12, display: 'block' }} />
            No loans tracked yet.
            <div style={{ fontSize: 13, marginTop: 8, fontWeight: 400 }}>
              Click <b>+ Add Loan</b> to track your first one.
            </div>
            <div style={{ marginTop: 14 }}>
              <Button type="primary" icon={<PlusOutlined />} onClick={openAdd}>Add Loan</Button>
            </div>
          </div>
        ) : (
          <div className="bank-grid">
            {loans.map((l, idx) => (
              <LoanCard
                key={l.ledger_id}
                loan={l}
                isCursor={sel.cursorIdx === idx}
                isMultiSelected={sel.selectedSet.has(idx) && sel.cursorIdx !== idx}
                onClickCard={(e) => {
                  if (e.shiftKey)              sel.extendTo(idx);
                  else if (e.ctrlKey || e.metaKey) sel.toggleRow(idx);
                  else                            sel.setCursor(idx);
                }}
                onOpen={() => navigate(`/loans/${l.ledger_id}/statement`)}
                onEdit={() => openEdit(l)}
                onRecordEmi={() => openEmi(l)}
                onToggleActive={() => toggleActive(l)}
                onDelete={() => deleteLoan(l)}
              />
            ))}
          </div>
        )}
      </div>

      {/* ── Bottom action strip — cursor moves with arrow keys across
          loan cards. F1 opens statement; F6 opens the Record EMI
          modal for the cursored loan. */}
      <ActionStrip
        actions={[
          {
            id: 'edit', key: 'F2', label: 'Edit',
            disabled: !single,
            onAction: () => single && openEdit(single),
          },
          {
            id: 'new', key: 'F3', label: 'New',
            onAction: openAdd,
          },
          {
            id: 'refresh', key: 'F5', label: 'Refresh',
            onAction: load,
          },
          {
            id: 'emi', key: 'F6', label: 'Record EMI',
            disabled: !single || !single.is_active || single.is_closed,
            onAction: () => single && openEmi(single),
          },
          {
            id: 'deactivate', key: 'F8',
            label: (single && !single.is_active) ? 'Activate' : 'Deactivate',
            tone: 'danger',
            disabled: !single,
            onAction: () => single && toggleActive(single),
          },
          {
            id: 'open', key: 'F1', label: 'Open Statement', tone: 'primary',
            disabled: !single,
            onAction: () => single && navigate(`/loans/${single.ledger_id}/statement`),
          },
        ]}
      />

      <LoanAccountModal
        open={modalOpen}
        loan={editing}
        onClose={() => setModalOpen(false)}
        onSaved={load}
      />
      <RecordEMIModal
        open={emiOpen}
        loan={emiLoan}
        onClose={() => setEmiOpen(false)}
        onSaved={load}
      />
    </div>
  );
}

// ── LoanCard ──────────────────────────────────────────────────────
function LoanCard({ loan, onOpen, onEdit, onRecordEmi, onToggleActive, onDelete, isCursor, isMultiSelected, onClickCard }) {
  const isInactive = !loan.is_active;
  const isClosed   = loan.is_closed;
  const isTaken    = loan.loan_type === 'taken';

  // EMI progress (paid / total).
  const pct = loan.emi_total > 0
    ? Math.min(100, Math.round((loan.emi_count / loan.emi_total) * 100))
    : 0;

  // Days until next EMI (negative = overdue).
  const daysUntil = loan.next_emi_date
    ? dayjs(loan.next_emi_date).diff(dayjs().startOf('day'), 'day')
    : null;

  const stop = (e) => e.stopPropagation();

  const menuItems = [
    { key: 'emi', icon: <DollarOutlined style={{ color: '#10B981' }} />,
      label: 'Record EMI', disabled: isInactive || isClosed },
    { type: 'divider' },
    { key: 'edit', icon: <EditOutlined />, label: 'Edit details' },
    loan.is_active
      ? { key: 'deactivate', icon: <EyeInvisibleOutlined />, label: 'Deactivate' }
      : { key: 'activate',   icon: <CheckCircleOutlined style={{ color: '#10B981' }} />, label: 'Activate' },
    { type: 'divider' },
    { key: 'delete', icon: <DeleteOutlined />, label: 'Delete', danger: true },
  ];

  const onMenuClick = ({ key, domEvent }) => {
    domEvent?.stopPropagation();
    if (key === 'emi')        onRecordEmi?.();
    if (key === 'edit')       onEdit?.();
    if (key === 'activate' || key === 'deactivate') onToggleActive?.();
    if (key === 'delete')     onDelete?.();
  };

  // Cursor / multi-select treatment reuses the .vrt-row-* classes.
  const cursorClass = isCursor ? ' vrt-row-active' : (isMultiSelected ? ' vrt-row-multi' : '');

  return (
    <div
      className={`bank-card loan-card${isInactive ? ' bank-card-inactive' : ''}${isClosed ? ' loan-card-closed' : ''}${cursorClass}`}
      onClick={(e) => {
        if (e.shiftKey || e.ctrlKey || e.metaKey) { onClickCard?.(e); return; }
        onClickCard?.(e);
      }}
      onDoubleClick={onOpen}
    >
      <div className="bank-card-hd">
        <div className="bank-card-id">
          <div className={`ic ${isTaken ? 'ic-taken' : 'ic-given'}`}>
            {isTaken ? <FallOutlined /> : <RiseOutlined />}
          </div>
          <div>
            <div className="name">
              {loan.name}
              {isInactive && <span className="bank-inactive-badge">Inactive</span>}
              {isClosed && !isInactive && <span className="loan-closed-badge">Closed</span>}
            </div>
            <div className="meta">
              {isTaken ? 'Loan Taken (Liability)' : 'Loan Given (Asset)'}
              {loan.party_name && <> <span style={{ color: '#9CA3AF' }}>·</span> {loan.party_name}</>}
            </div>
          </div>
        </div>
        <div className="bank-card-actions">
          <div className="bank-card-bal">
            <div className="amt" style={{ color: loan.outstanding > 0 ? (isTaken ? '#EF4444' : '#10B981') : '#9CA3AF' }}>
              {fmtRupees(loan.outstanding)}
            </div>
            <div className="side">Outstanding</div>
          </div>
          <Dropdown
            menu={{ items: menuItems, onClick: onMenuClick }}
            trigger={['click']}
            placement="bottomRight"
          >
            <button className="bank-card-menu" onClick={stop} aria-label="More options">
              <MoreOutlined />
            </button>
          </Dropdown>
        </div>
      </div>

      {/* EMI progress + breakdown */}
      <div className="loan-card-progress">
        <div className="loan-progress-stats">
          <span><b>{loan.emi_count}</b> / {loan.emi_total} EMIs</span>
          <span className="grow"></span>
          <span style={{ color: '#6B7280' }}>{pct}% paid</span>
        </div>
        <Progress
          percent={pct}
          showInfo={false}
          size="small"
          strokeColor={isClosed ? '#9CA3AF' : isTaken ? '#4F46E5' : '#10B981'}
          trailColor="#F3F4F6"
        />
      </div>

      {/* Principal vs interest grid */}
      <div className="bank-card-flow">
        <div className="flow-cell">
          <div className="lbl">Principal {isTaken ? 'Repaid' : 'Recovered'}</div>
          <div className="val pos">{fmtRupees(loan.principal_paid)}</div>
        </div>
        <div className="flow-cell">
          <div className="lbl">Interest {isTaken ? 'Paid' : 'Earned'}</div>
          <div className="val" style={{ color: isTaken ? '#EF4444' : '#10B981' }}>
            {fmtRupees(loan.interest_paid)}
          </div>
        </div>
      </div>

      {/* Next-due strip */}
      <div className="bank-card-foot">
        <div className="foot-l">
          {isClosed ? (
            <span className="foot-clear">
              <span className="dot ok"></span>
              Loan fully {isTaken ? 'repaid' : 'recovered'}
            </span>
          ) : loan.next_emi_date ? (
            <span className={loan.overdue ? 'foot-uncl' : 'foot-clear'} style={{
              color: loan.overdue ? '#EF4444' : (daysUntil != null && daysUntil <= 7 ? '#F59E0B' : '#10B981'),
            }}>
              <span className={'dot' + (loan.overdue ? '' : ' ok')}
                style={{ background: loan.overdue ? '#EF4444' : (daysUntil != null && daysUntil <= 7 ? '#F59E0B' : '#10B981') }}>
              </span>
              <b>{fmtRupees(loan.next_emi_amount)}</b> {loan.overdue ? 'overdue since' : 'due'} {dayjs(loan.next_emi_date).format('DD MMM YYYY')}
              {daysUntil != null && (
                <span style={{ color: '#9CA3AF', fontWeight: 400 }}>
                  &nbsp;({daysUntil < 0 ? `${-daysUntil}d ago` : daysUntil === 0 ? 'today' : `in ${daysUntil}d`})
                </span>
              )}
            </span>
          ) : (
            <span className="foot-clear">
              <span className="dot"></span>
              No EMI scheduled
            </span>
          )}
        </div>
      </div>

      <div className="bank-card-cta">
        {isClosed ? 'View Statement →' : (
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
            View Statement & Schedule →
          </span>
        )}
      </div>
    </div>
  );
}
