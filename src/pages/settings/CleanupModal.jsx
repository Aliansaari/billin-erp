import React, { useState } from 'react';
import { Modal, Button, Input, Checkbox, Alert, message } from 'antd';
import { DeleteOutlined, WarningOutlined } from '@ant-design/icons';
import { settingsAPI } from '../../api';

/**
 * CleanupModal — destructive bulk-data cleanup picker.
 *
 * Lives separately from any single page so multiple settings pages
 * can open the same modal (currently Backup & Recovery; previously
 * Modules). Uses the system cleanup endpoint, requires the admin
 * password and a typed DELETE confirmation before firing.
 */
const CLEANUP_ITEMS = [
  {
    key: 'sales',
    label: 'Sales Bills & Items',
    desc: 'All sales invoices, line items, and customer balances will be reset to zero.',
    color: '#10b981',
  },
  {
    key: 'purchases',
    label: 'Purchase Bills & Items',
    desc: 'All purchase invoices, line items, and supplier balances will be reset to zero.',
    color: '#3b82f6',
  },
  {
    key: 'sales_returns',
    label: 'Sales Returns',
    desc: 'All sales return notes and their stock movements will be deleted (sales bills kept).',
    color: '#14b8a6',
  },
  {
    key: 'purchase_returns',
    label: 'Purchase Returns',
    desc: 'All purchase return notes and their stock movements will be deleted (purchase bills kept).',
    color: '#0ea5e9',
  },
  {
    key: 'payments',
    label: 'Payments & Receipts',
    desc: 'All payment and receipt entries will be deleted.',
    color: '#f59e0b',
  },
  {
    key: 'journal_vouchers',
    label: 'Journal Vouchers',
    desc: 'All manual journal vouchers and their ledger entries will be deleted (opening-balance JVs are tied to parties and stay).',
    color: '#a855f7',
  },
  {
    key: 'stock_ledger',
    label: 'Stock History (Ledger)',
    desc: 'All stock movement entries will be deleted and product stock quantities reset to 0.',
    color: '#8b5cf6',
  },
  {
    key: 'products',
    label: 'Products',
    desc: 'All products and their entire stock history will be permanently deleted.',
    color: '#ef4444',
  },
  {
    key: 'parties',
    label: 'Parties (Customers & Suppliers)',
    desc: 'All parties and all their linked bills, payments will be deleted.',
    color: '#f97316',
  },
  {
    key: 'categories',
    label: 'Categories',
    desc: 'All product categories will be deleted (products will be uncategorised).',
    color: '#6366f1',
  },
];

export default function CleanupModal({ open, onClose }) {
  const [selected, setSelected] = useState([]);
  const [confirmText, setConfirmText] = useState('');
  const [password, setPassword] = useState('');
  const [loading, setLoading] = useState(false);

  const reset = () => { setSelected([]); setConfirmText(''); setPassword(''); };

  const handleClose = () => { reset(); onClose(); };

  const toggleAll = (checked) => setSelected(checked ? CLEANUP_ITEMS.map((i) => i.key) : []);

  const toggle = (key) =>
    setSelected((prev) => (prev.includes(key) ? prev.filter((k) => k !== key) : [...prev, key]));

  const handleDelete = async () => {
    if (selected.length === 0) return message.warning('Select at least one category');
    if (confirmText !== 'DELETE') return message.error('Type DELETE to confirm');
    if (!password) return message.error('Enter your admin password to confirm');
    setLoading(true);
    try {
      await settingsAPI.cleanupData({
        categories: selected,
        confirmation: confirmText,
        password,
      });
      message.success('Selected data deleted successfully');
      handleClose();
    } catch (e) {
      message.error(e.response?.data?.error || 'Cleanup failed');
    }
    setLoading(false);
  };

  const allSelected = selected.length === CLEANUP_ITEMS.length;

  return (
    <Modal
      open={open}
      onCancel={handleClose}
      width={620}
      title={
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <WarningOutlined style={{ color: '#ef4444', fontSize: 20 }} />
          <span style={{ color: '#ef4444', fontWeight: 700, fontSize: 16 }}>Clean / Reset Data</span>
        </div>
      }
      footer={null}
      destroyOnClose
    >
      <Alert
        type="error"
        showIcon
        message="This action is permanent and cannot be undone."
        description="Deleted data cannot be recovered. Make sure you have a backup before proceeding."
        style={{ marginBottom: 20 }}
      />

      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 }}>
        <span style={{ fontWeight: 600, color: 'var(--fg-primary)', fontSize: 13 }}>Select data to delete:</span>
        <button
          onClick={() => toggleAll(!allSelected)}
          style={{ background: 'none', border: '1px solid var(--border)', borderRadius: 6, padding: '4px 12px', cursor: 'pointer', fontSize: 12, color: 'var(--fg-secondary)', fontWeight: 500 }}
        >
          {allSelected ? 'Deselect All' : 'Select All'}
        </button>
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginBottom: 24 }}>
        {CLEANUP_ITEMS.map((item) => {
          const checked = selected.includes(item.key);
          return (
            <div
              key={item.key}
              onClick={() => toggle(item.key)}
              style={{
                display: 'flex', alignItems: 'flex-start', gap: 12,
                padding: '12px 14px', borderRadius: 8, cursor: 'pointer',
                border: checked ? `1.5px solid ${item.color}` : '1.5px solid var(--border)',
                background: checked ? `${item.color}1A` : 'var(--bg-muted)',
                transition: 'all .15s',
              }}
            >
              <Checkbox checked={checked} style={{ marginTop: 2, flexShrink: 0 }} onChange={() => toggle(item.key)} />
              <div>
                <div style={{ fontWeight: 600, fontSize: 13, color: checked ? item.color : 'var(--fg-primary)' }}>{item.label}</div>
                <div style={{ fontSize: 12, color: 'var(--fg-secondary)', marginTop: 2 }}>{item.desc}</div>
              </div>
            </div>
          );
        })}
      </div>

      <div style={{ background: 'var(--danger-bg)', border: '1px solid var(--danger)', borderColor: 'rgba(239, 68, 68, 0.30)', borderRadius: 8, padding: '14px 16px', marginBottom: 20 }}>
        <div style={{ fontSize: 13, color: 'var(--danger)', fontWeight: 500, marginBottom: 8 }}>
          Type <strong>DELETE</strong> below to confirm permanent deletion of{' '}
          <strong>
            {selected.length === 0
              ? 'nothing selected'
              : selected.length === CLEANUP_ITEMS.length
                ? 'ALL data'
                : `${selected.length} category${selected.length > 1 ? 's' : ''}`}
          </strong>
          :
        </div>
        <Input
          value={confirmText}
          onChange={(e) => setConfirmText(e.target.value.toUpperCase())}
          placeholder="Type DELETE here"
          style={{ fontFamily: 'monospace', fontWeight: 700, letterSpacing: 2, marginBottom: 12 }}
          status={confirmText && confirmText !== 'DELETE' ? 'error' : ''}
        />
        <div style={{ fontSize: 13, color: 'var(--danger)', fontWeight: 500, marginBottom: 8 }}>
          Re-enter your admin password:
        </div>
        <Input.Password
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          placeholder="Your admin password"
          autoComplete="current-password"
        />
      </div>

      <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end' }}>
        <Button onClick={handleClose}>Cancel</Button>
        <Button
          danger type="primary"
          icon={<DeleteOutlined />}
          loading={loading}
          disabled={selected.length === 0 || confirmText !== 'DELETE' || !password}
          onClick={handleDelete}
        >
          Delete Selected Data
        </Button>
      </div>
    </Modal>
  );
}
