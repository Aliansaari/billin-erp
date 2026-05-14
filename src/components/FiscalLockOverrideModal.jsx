import React, { useEffect, useRef, useState } from 'react';
import { Modal, Input, Form, Alert } from 'antd';
import { WarningOutlined, LockOutlined } from '@ant-design/icons';
import dayjs from 'dayjs';
import './fiscal-lock-override-modal.css';

/* ──────────────────────────────────────────────────────────────────────────
 * FiscalLockOverrideModal — confirmation modal shown when the operator
 * tries to save a voucher dated on or before the soft/hard lock date.
 *
 * Renders WHEN the form's onSave handler has called useFiscalLock(date)
 * and got back { requiresOverride: true }. The modal asks for:
 *   · A free-text reason (required, ≥ 8 chars, logged in audit trail)
 *   · The user's current password (only when requiresPassword === true)
 *
 * On confirm, onConfirm({ reason, password }) is called — the parent's
 * save handler re-runs with these added to the POST body. The server
 * validates the password (if present), logs the event, and saves.
 *
 * Two visual flavours match the two lock types:
 *   · soft  → amber chrome, neutral OK button
 *   · hard  → red chrome, "OK — Super Admin override" button, badge
 *
 * Esc cancels. Enter in the reason field doesn't submit (would conflict
 * with multi-line input); the button submits.
 * ────────────────────────────────────────────────────────────────────── */

export default function FiscalLockOverrideModal({
  open,
  lock,                  // result object from useFiscalLock()
  billDate,              // the voucher date that triggered the lock
  vouchTypeLabel,        // e.g. "Sale", "Purchase", "Receipt"
  onConfirm,             // ({ reason, password }) => void
  onCancel,              // () => void
}) {
  const [reason,   setReason]   = useState('');
  const [password, setPassword] = useState('');
  const [reasonErr, setReasonErr] = useState('');
  const [pwErr,     setPwErr]     = useState('');
  const reasonRef = useRef(null);

  // Reset state every time the modal opens — never carry the previous
  // reason / password into a new override session.
  useEffect(() => {
    if (open) {
      setReason(''); setPassword(''); setReasonErr(''); setPwErr('');
      setTimeout(() => reasonRef.current?.focus(), 40);
    }
  }, [open]);

  if (!open || !lock) return null;

  const isHard      = lock.status === 'hard';
  const tone        = isHard ? 'hard' : 'soft';
  const needsPw     = !!lock.requiresPassword;
  const okText      = isHard ? 'Override — Super Admin' : 'Save with override';
  const billStr     = billDate ? dayjs(billDate).format('DD MMM YYYY') : '';
  const lockStr     = lock.lockDate ? dayjs(lock.lockDate).format('DD MMM YYYY') : '';

  const handleSubmit = () => {
    const r = reason.trim();
    if (r.length < 8) {
      setReasonErr('Please provide a clear reason (at least 8 characters). This is logged in the audit trail.');
      reasonRef.current?.focus();
      return;
    }
    if (needsPw && password.length < 1) {
      setPwErr('Your password is required to override.');
      return;
    }
    onConfirm({ reason: r, password: needsPw ? password : undefined });
  };

  return (
    <Modal
      open={open}
      onCancel={onCancel}
      onOk={handleSubmit}
      okText={okText}
      cancelText="Cancel"
      okButtonProps={{ danger: isHard }}
      width={520}
      className={`erp-fl-modal erp-fl-modal-${tone}`}
      title={
        <span className="erp-fl-title">
          {isHard
            ? <LockOutlined className="erp-fl-icon hard" />
            : <WarningOutlined className="erp-fl-icon soft" />}
          {isHard ? 'Hard lock override' : 'Backdated entry'}
          {vouchTypeLabel && <span className="erp-fl-subtitle">{vouchTypeLabel}</span>}
        </span>
      }
    >
      <Alert
        type={isHard ? 'error' : 'warning'}
        showIcon
        message={
          <span>
            You're saving a <strong>{vouchTypeLabel || 'voucher'}</strong> dated{' '}
            <strong>{billStr}</strong>, which falls on or before the{' '}
            <strong>{isHard ? 'hard' : 'soft'}-lock date</strong> ({lockStr}).
          </span>
        }
        description={
          <span style={{ fontSize: 12.5 }}>
            {isHard
              ? <>This period is closed post-filing. Your override will be recorded in the audit log with <strong>hard_override</strong> flag for the firm's CA / external auditor.</>
              : <>Your override will be recorded in the audit log with the reason below.</>}
          </span>
        }
        className="erp-fl-alert"
      />

      <Form layout="vertical" className="erp-fl-form" onFinish={handleSubmit}>
        <Form.Item
          label={<span>Reason for backdating <span className="erp-fl-required">*</span></span>}
          validateStatus={reasonErr ? 'error' : ''}
          help={reasonErr || `Logged in the audit trail. Be specific — "Late entry from physical bill #43" is better than "Backdated".`}
          required
        >
          <Input.TextArea
            ref={reasonRef}
            rows={3}
            value={reason}
            onChange={(e) => { setReason(e.target.value); if (reasonErr) setReasonErr(''); }}
            placeholder="e.g. Customer signed bill on 30 Mar but invoice book mislaid — entering now"
            maxLength={500}
            showCount
          />
        </Form.Item>

        {needsPw && (
          <Form.Item
            label={<span>Your password <span className="erp-fl-required">*</span></span>}
            validateStatus={pwErr ? 'error' : ''}
            help={pwErr || 'Required by your firm\'s policy (Settings → Financial Year → "Require password on override").'}
            required
          >
            <Input.Password
              value={password}
              onChange={(e) => { setPassword(e.target.value); if (pwErr) setPwErr(''); }}
              placeholder="Enter your account password"
              autoComplete="current-password"
            />
          </Form.Item>
        )}
      </Form>
    </Modal>
  );
}
