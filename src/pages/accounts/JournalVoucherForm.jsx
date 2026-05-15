// Manual Journal Voucher entry. Multi-leg with searchable ledger dropdown
// per line. Submit is disabled until total debits = total credits.

import React, { useEffect, useMemo, useState } from 'react';
import { Card, Form, DatePicker, Input, Select, Button, Space, Typography, Table, message, InputNumber, Tag } from 'antd';
import { PlusOutlined, DeleteOutlined } from '@ant-design/icons';
import { useNavigate, useParams } from 'react-router-dom';
import dayjs from 'dayjs';
import { journalAPI, ledgerAPI } from '../../api';
import ActionStrip from '../../components/keyboard/ActionStrip';
import { useDatePopup } from '../../components/keyboard/DatePopup';
import { useFiscalLockGuard, isFiscalLockCancel } from '../../hooks/useFiscalLockGuard';
import FiscalLockOverrideModal from '../../components/FiscalLockOverrideModal';

const { Title, Text } = Typography;
const fmt = (v) =>
  parseFloat(v || 0).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

const blankLine = () => ({ ledger_id: null, debit: 0, credit: 0 });

export default function JournalVoucherForm() {
  const navigate = useNavigate();
  const { id } = useParams();
  const isEdit = !!id;

  const [voucherDate, setVoucherDate] = useState(dayjs());
  const [narration, setNarration]     = useState('');
  const [lines, setLines]             = useState([blankLine(), blankLine()]);
  const [ledgers, setLedgers]         = useState([]);
  const [loading, setLoading]         = useState(false);
  const [saving, setSaving]           = useState(false);

  useEffect(() => {
    (async () => {
      try {
        const res = await ledgerAPI.listAccounts();
        setLedgers(res.data.data || []);
      } catch (e) {
        message.error('Failed to load chart of accounts.');
      }
      if (isEdit) {
        setLoading(true);
        try {
          const r = await journalAPI.getById(id);
          const v = r.data;
          setVoucherDate(dayjs(v.voucher_date));
          setNarration(v.narration || '');
          setLines((v.lines || []).map((ln) => ({
            ledger_id: ln.ledger_id,
            debit: Number(ln.debit_amount) || 0,
            credit: Number(ln.credit_amount) || 0,
          })));
        } catch (e) {
          message.error('Failed to load voucher.');
        }
        setLoading(false);
      }
    })();
  }, [id]);

  const totals = useMemo(() => {
    let dr = 0, cr = 0;
    for (const ln of lines) {
      dr += Number(ln.debit)  || 0;
      cr += Number(ln.credit) || 0;
    }
    return { dr, cr, diff: Math.round((dr - cr) * 100) / 100 };
  }, [lines]);

  const balanced = Math.abs(totals.diff) < 0.005 && totals.dr > 0;
  const { openDate } = useDatePopup();

  // Fiscal-lock guard for backdated saves.
  const { lockModal, guardedSave } = useFiscalLockGuard({
    onBlocked: (msg) => message.error(msg),
  });

  const updateLine = (idx, patch) => {
    setLines((prev) => {
      const next = prev.slice();
      next[idx] = { ...next[idx], ...patch };
      return next;
    });
  };

  const addLine    = () => setLines((p) => [...p, blankLine()]);
  const removeLine = (idx) => setLines((p) => p.length <= 2 ? p : p.filter((_, i) => i !== idx));

  const handleSave = async () => {
    if (!balanced) return message.error('Debits must equal credits before saving.');
    if (lines.some((ln) => !ln.ledger_id)) return message.error('Pick a ledger on every line.');
    setSaving(true);
    try {
      const payload = {
        voucher_date: voucherDate.format('YYYY-MM-DD'),
        narration: narration.trim() || null,
        lines: lines.map((ln) => ({
          ledger_id: ln.ledger_id,
          debit:  Number(ln.debit)  || 0,
          credit: Number(ln.credit) || 0,
        })),
      };
      await guardedSave(payload, (b) => (
        isEdit ? journalAPI.update(id, b) : journalAPI.create(b)
      ));
      message.success(isEdit ? 'Voucher updated.' : 'Voucher posted.');
      navigate('/accounts/journal');
    } catch (e) {
      if (!isFiscalLockCancel(e)) {
        message.error(e.response?.data?.message || e.response?.data?.error || 'Save failed.');
      }
    }
    setSaving(false);
  };

  const cols = [
    {
      title: 'Ledger', dataIndex: 'ledger_id', key: 'ledger',
      render: (_, row, idx) => (
        <Select
          showSearch
          placeholder="Select ledger"
          value={row.ledger_id}
          onChange={(v) => updateLine(idx, { ledger_id: v })}
          style={{ width: '100%', minWidth: 240 }}
          optionFilterProp="label"
          filterOption={(input, opt) => String(opt?.label ?? '').toLowerCase().includes(input.toLowerCase())}
        >
          {ledgers.map((lg) => {
            // Audit (UI live test) — pre-fix filterOption read opt?.children
            // which is a JSX array (ledger_name + text + tag), not a string.
            // Typing into the ledger search threw
            //   "((intermediate value) ?? '').toLowerCase is not a function"
            // and crashed the whole form into ErrorBoundary. Build a single
            // string `label` on each option and filter against that.
            const label = `${lg.ledger_name}${lg.is_party_ledger ? ' · party' : (lg.is_system_ledger ? ' · system' : '')}`;
            return (
              <Select.Option key={lg.ledger_id} value={lg.ledger_id} label={label}>
                {label}
              </Select.Option>
            );
          })}
        </Select>
      ),
    },
    {
      title: 'Debit', dataIndex: 'debit', key: 'debit', width: 160, align: 'right',
      render: (_, row, idx) => (
        <InputNumber
          value={row.debit}
          min={0}
          precision={2}
          style={{ width: '100%', fontFamily: 'Geist Mono, monospace' }}
          onChange={(v) => updateLine(idx, { debit: v || 0, credit: v ? 0 : row.credit })}
        />
      ),
    },
    {
      title: 'Credit', dataIndex: 'credit', key: 'credit', width: 160, align: 'right',
      render: (_, row, idx) => (
        <InputNumber
          value={row.credit}
          min={0}
          precision={2}
          style={{ width: '100%', fontFamily: 'Geist Mono, monospace' }}
          onChange={(v) => updateLine(idx, { credit: v || 0, debit: v ? 0 : row.debit })}
        />
      ),
    },
    {
      title: '', key: 'actions', width: 60, align: 'right',
      render: (_, _row, idx) => (
        <Button type="text" danger icon={<DeleteOutlined />} onClick={() => removeLine(idx)} disabled={lines.length <= 2} />
      ),
    },
  ];

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 }}>
      <Card loading={loading} style={{ flex: 1, minHeight: 0, overflow: 'auto' }}>
      <Title level={4} style={{ margin: '0 0 16px' }}>{isEdit ? 'Edit Journal Voucher' : 'New Journal Voucher'}</Title>

      <Form layout="vertical">
        <Space size="large" style={{ marginBottom: 16 }}>
          <Form.Item label="Voucher Date" required>
            <DatePicker value={voucherDate} onChange={(d) => d && setVoucherDate(d)} format="YYYY-MM-DD" />
          </Form.Item>
          <Form.Item label="Narration" style={{ minWidth: 480 }}>
            <Input
              placeholder="What is this voucher for?"
              value={narration}
              onChange={(e) => setNarration(e.target.value)}
            />
          </Form.Item>
        </Space>
      </Form>

      <Table
        rowKey={(_r, i) => i}
        columns={cols}
        dataSource={lines}
        pagination={false}
        size="small"
        footer={() => (
          <Space style={{ width: '100%', justifyContent: 'space-between' }}>
            <Button icon={<PlusOutlined />} onClick={addLine}>Add line</Button>
            <Space size="large">
              <Text>Total Debits: <span style={{ fontFamily: 'Geist Mono, monospace' }}>{fmt(totals.dr)}</span></Text>
              <Text>Total Credits: <span style={{ fontFamily: 'Geist Mono, monospace' }}>{fmt(totals.cr)}</span></Text>
              {balanced
                ? <Tag color="green">Balanced</Tag>
                : <Tag color="red">Diff {fmt(totals.diff)}</Tag>}
            </Space>
          </Space>
        )}
      />

      {!balanced && (
        <Text type="danger" style={{ display: 'block', marginTop: 8 }}>
          Debits must equal credits before this voucher can be posted.
        </Text>
      )}
      </Card>

      {/* ── Action strip — Esc Back, F1 Post / Save (primary, disabled
          until debits = credits). No drafts on JVs; either it's
          balanced or it stays in the form. */}
      <ActionStrip
        actions={[
          {
            id: 'back', key: 'Esc', label: 'Back',
            onAction: () => navigate('/accounts/journal'),
          },
          {
            id: 'date', key: 'F2', label: 'Date',
            onAction: () => openDate({
              title: 'Voucher Date',
              value: voucherDate || dayjs(),
              onConfirm: (d) => setVoucherDate(d),
            }),
            title: 'Open the smart-input date popup',
          },
          {
            id: 'save', key: 'F1', label: isEdit ? 'Save Changes' : 'Post Voucher',
            tone: 'primary',
            disabled: saving || !balanced,
            onAction: handleSave,
          },
          // Hidden Ctrl+Enter alias for the muscle-memory user.
          {
            id: 'save-alt', key: 'Ctrl+Enter', label: '',
            hidden: true, disabled: saving || !balanced,
            onAction: handleSave,
          },
        ]}
      />

      <FiscalLockOverrideModal
        open={!!lockModal}
        lock={lockModal?.lock}
        billDate={voucherDate}
        vouchTypeLabel="Journal"
        onConfirm={lockModal?.onConfirm}
        onCancel={lockModal?.onCancel}
      />
    </div>
  );
}
