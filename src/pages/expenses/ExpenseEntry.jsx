// ── Expense Voucher Entry ──────────────────────────────────────────
//
// Visually mirrors Journal Voucher Form so the operator opens it and
// sees a familiar ERP entry screen:
//
//   ┌─ Card ────────────────────────────────────────────────────┐
//   │  New Expense Voucher                       [next # · …]   │
//   │                                                            │
//   │  Voucher Date · Mode · Vendor · Bank · Bill No.           │   <- Form header
//   │  Narration                                                 │
//   │                                                            │
//   │  ┌── Expense Lines (Table) ──────────────────────────┐    │
//   │  │ Head │ Desc │ Amount │ GST │ Tax │ Total │ ×      │    │
//   │  │  …   │  …   │   …    │  …  │  …  │   …   │ …      │    │
//   │  └────────────────────────────────────────────────────┘    │
//   │  + Add line              Subtotal · GST · Total · Round   │
//   │                                                            │
//   └────────────────────────────────────────────────────────────┘
//   ActionStrip · F1 Post · F2 Date · F3 Add Line · F4 Vendor · Esc Back
//
// Same Card chrome, same Form.Item labels with red asterisks, same
// Antd Table with editable cells, same Geist Mono for numbers, same
// ActionStrip at the bottom. Operators trained on Journal / Sales /
// Purchase forms can use this without learning a new visual language.
//
// Easy-entry features kept:
//   • Auto-focus first amount cell on mount
//   • Enter on amount → adds a new line (no mouse needed)
//   • Recent-head chips below the head picker (last 6 used)
//   • Voucher-wide GST chips (one click) instead of per-line typing
//   • Smart defaults (Cash mode, today, no GST)
//
// Posting wiring (Dr expense legs · Dr GST · Cr cash/bank/vendor)
// is unchanged — every save still goes through ledgerPostingService.

import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  Card, Form, DatePicker, Input, Select, Button, Space, Typography,
  Table, message, InputNumber, Tag, Tooltip, Modal,
} from 'antd';
import {
  PlusOutlined, DeleteOutlined, ArrowLeftOutlined, SwapOutlined,
} from '@ant-design/icons';
import { useNavigate, useParams } from 'react-router-dom';
import dayjs from 'dayjs';
import { expenseAPI, ledgerAPI, partyAPI, bankAPI } from '../../api';
import ActionStrip from '../../components/keyboard/ActionStrip';
import { useDatePopup } from '../../components/keyboard/DatePopup';
import { useUnsavedChangesWarning } from '../../hooks/useUnsavedChangesWarning';
import useBack from '../../hooks/useBack';
import { useFiscalLockGuard, isFiscalLockCancel } from '../../hooks/useFiscalLockGuard';
import FiscalLockOverrideModal from '../../components/FiscalLockOverrideModal';

const { Title, Text } = Typography;
const MONO = 'Geist Mono, ui-monospace, monospace';

const fmt = (v) =>
  parseFloat(v || 0).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const rupee = (v) => '₹ ' + fmt(v);
const r2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

const blankLine = () => ({
  expense_ledger_id: null,
  description: '',
  taxable_amount: null,
});

// Voucher-wide GST options. Each preset translates to per-line cgst/
// sgst/igst on save. Operators almost always have ONE rate per voucher;
// the rare multi-rate bill can be split into two vouchers. This trade
// keeps the form a single dropdown instead of one per line.
const GST_OPTIONS = [
  { value: '0',          label: 'No GST',        cgst: 0,   sgst: 0,   igst: 0 },
  { value: '5_intra',    label: '5%  · CGST+SGST', cgst: 2.5, sgst: 2.5, igst: 0 },
  { value: '5_inter',    label: '5%  · IGST',     cgst: 0,   sgst: 0,   igst: 5 },
  { value: '12_intra',   label: '12% · CGST+SGST', cgst: 6,   sgst: 6,   igst: 0 },
  { value: '12_inter',   label: '12% · IGST',     cgst: 0,   sgst: 0,   igst: 12 },
  { value: '18_intra',   label: '18% · CGST+SGST', cgst: 9,   sgst: 9,   igst: 0 },
  { value: '18_inter',   label: '18% · IGST',     cgst: 0,   sgst: 0,   igst: 18 },
  { value: '28_intra',   label: '28% · CGST+SGST', cgst: 14,  sgst: 14,  igst: 0 },
  { value: '28_inter',   label: '28% · IGST',     cgst: 0,   sgst: 0,   igst: 28 },
];

const RECENT_KEY = 'exp_recent_heads_v1';
const RECENT_MAX = 6;
const loadRecent = () => {
  try { return JSON.parse(localStorage.getItem(RECENT_KEY) || '[]'); } catch { return []; }
};
const pushRecent = (ids) => {
  try {
    const merged = [...new Set([...ids, ...loadRecent()])].slice(0, RECENT_MAX);
    localStorage.setItem(RECENT_KEY, JSON.stringify(merged));
  } catch { /* quota — ignore */ }
};

export default function ExpenseEntry() {
  const navigate = useNavigate();
  const { id } = useParams();
  const isEdit = !!id;

  const [voucherDate, setVoucherDate]   = useState(dayjs());
  const [paymentMode, setPaymentMode]   = useState('Cash');
  const [bankLedgerId, setBankLedgerId] = useState(null);
  const [partyId, setPartyId]           = useState(null);
  const [referenceNumber, setReferenceNo] = useState('');
  const [paymentRef, setPaymentRef]       = useState('');
  const [narration, setNarration]         = useState('');
  const [roundOff, setRoundOff]           = useState(0);
  const [gstPreset, setGstPreset]         = useState('0');
  const [paidAmountOverride, setPaidOverride] = useState(null);
  const [lines, setLines]                 = useState([blankLine()]);

  const [expenseLedgers, setExpenseLedgers] = useState([]);
  const [bankLedgers, setBankLedgers]       = useState([]);
  const [parties, setParties]               = useState([]);
  const [recentHeadIds]                     = useState(() => loadRecent());

  const [voucherNumber, setVoucherNumber]   = useState('');
  const [nextNumber, setNextNumber]         = useState('');
  const [isCancelled, setIsCancelled]       = useState(false);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving]   = useState(false);

  const dirty = !!(lines[0]?.expense_ledger_id || lines[0]?.taxable_amount);
  const confirmLeave = useUnsavedChangesWarning(dirty);
  const goBack = useBack('/expenses');
  const { openDate } = useDatePopup();

  // Fiscal-lock override flow (compliance mode). Same hook as Sales /
  // Payment / Receipt. The modal is rendered at the bottom of this
  // component.
  const { lockModal, guardedSave } = useFiscalLockGuard({
    onBlocked: (msg) => message.error(msg),
  });

  const partyRef = useRef(null);
  const firstAmtRef = useRef(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const [lg, bk, pt] = await Promise.all([
          ledgerAPI.listAccounts(),
          bankAPI.list(),
          partyAPI.getAll({ limit: 5000 }),
        ]);
        if (cancelled) return;
        setExpenseLedgers((lg.data?.data || []).filter((l) => l.ledger_group === 'Expenses' && l.is_active !== false));
        const bankList = bk.data?.banks || bk.data?.data || (Array.isArray(bk.data) ? bk.data : []);
        setBankLedgers(bankList.filter((b) => b.is_active !== false));
        setParties((pt.data?.data || []).filter((p) => p.is_active !== false && !p.is_system_cash));
      } catch (e) {
        message.error('Failed to load expense form data.');
      }
      if (isEdit) {
        setLoading(true);
        try {
          const r = await expenseAPI.getById(id);
          const v = r.data;
          if (cancelled) return;
          setVoucherNumber(v.voucher_number || '');
          setVoucherDate(dayjs(v.voucher_date));
          setPaymentMode(v.payment_mode);
          setBankLedgerId(v.bank_ledger_id || null);
          setPartyId(v.party_id || null);
          setReferenceNo(v.reference_number || '');
          setPaymentRef(v.payment_ref || '');
          setNarration(v.narration || '');
          setRoundOff(Number(v.round_off) || 0);
          // Reverse-engineer voucher-wide GST preset from the first taxed line
          const taxLine = (v.items || []).find((it) => Number(it.cgst_rate) + Number(it.sgst_rate) + Number(it.igst_rate) > 0);
          if (taxLine) {
            const total = Number(taxLine.cgst_rate) + Number(taxLine.sgst_rate) + Number(taxLine.igst_rate);
            const isInter = Number(taxLine.igst_rate) > 0;
            const matched = GST_OPTIONS.find((p) =>
              Math.round(p.cgst + p.sgst + p.igst) === Math.round(total) &&
              (p.igst > 0) === isInter,
            );
            if (matched) setGstPreset(matched.value);
          }
          const total = Number(v.total_amount) || 0;
          const paid  = Number(v.paid_amount)  || 0;
          const natural = v.payment_mode === 'Credit' ? 0 : total;
          setPaidOverride(Math.abs(paid - natural) > 0.005 ? paid : null);
          setIsCancelled(!!v.is_cancelled);
          setLines(((v.items || []).length ? v.items : [blankLine()]).map((it) => ({
            expense_ledger_id: it.expense_ledger_id,
            description:       it.description || '',
            taxable_amount:    Number(it.taxable_amount) || 0,
          })));
        } catch (e) {
          message.error('Failed to load voucher.');
        }
        setLoading(false);
      } else {
        try {
          const { data } = await expenseAPI.nextNumber(dayjs().format('YYYY-MM-DD'));
          if (!cancelled) setNextNumber(data?.next || '');
        } catch (_) { /* preview is best-effort */ }
        setTimeout(() => firstAmtRef.current?.focus?.(), 120);
      }
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  useEffect(() => {
    if (isEdit) return;
    expenseAPI.nextNumber(voucherDate.format('YYYY-MM-DD'))
      .then((r) => setNextNumber(r.data?.next || ''))
      .catch(() => {});
  }, [voucherDate, isEdit]);

  const gstSelected = useMemo(
    () => GST_OPTIONS.find((p) => p.value === gstPreset) || GST_OPTIONS[0],
    [gstPreset],
  );

  const computed = useMemo(() => {
    const subtotal = r2(lines.reduce((s, ln) => s + r2(ln.taxable_amount), 0));
    const totalRate = gstSelected.cgst + gstSelected.sgst + gstSelected.igst;
    const gstAmount = r2((subtotal * totalRate) / 100);
    const cgst = r2((subtotal * gstSelected.cgst) / 100);
    const sgst = r2((subtotal * gstSelected.sgst) / 100);
    const igst = r2((subtotal * gstSelected.igst) / 100);
    const ro = r2(roundOff);
    const total = r2(subtotal + gstAmount + ro);
    const naturalPaid = paymentMode === 'Credit' ? 0 : total;
    const paid = paidAmountOverride != null ? r2(paidAmountOverride) : naturalPaid;
    const unpaid = r2(total - paid);
    return { subtotal, gst_amount: gstAmount, cgst, sgst, igst, round_off: ro, total_amount: total, paid_amount: paid, unpaid_amount: unpaid };
  }, [lines, gstSelected, roundOff, paymentMode, paidAmountOverride]);

  const updateLine = (idx, patch) => {
    setLines((prev) => {
      const next = prev.slice();
      next[idx] = { ...next[idx], ...patch };
      return next;
    });
  };
  const addLine    = () => setLines((p) => [...p, blankLine()]);
  const removeLine = (idx) => setLines((p) => p.length <= 1 ? p : p.filter((_, i) => i !== idx));

  const recentHeads = useMemo(() => {
    if (recentHeadIds.length === 0 || expenseLedgers.length === 0) return [];
    const byId = new Map(expenseLedgers.map((l) => [l.ledger_id, l]));
    return recentHeadIds.map((id) => byId.get(id)).filter(Boolean);
  }, [recentHeadIds, expenseLedgers]);

  const validate = () => {
    if (computed.total_amount <= 0) return 'Enter at least one line with an amount.';
    for (let i = 0; i < lines.length; i++) {
      const ln = lines[i];
      if (!ln.expense_ledger_id) return `Line ${i + 1}: pick an expense head.`;
      if (r2(ln.taxable_amount) <= 0) return `Line ${i + 1}: enter an amount.`;
    }
    if (paymentMode === 'Bank' && !bankLedgerId) return 'Pick a bank account for Bank mode.';
    if (paymentMode === 'Credit' && !partyId) return 'Pick a vendor for Credit mode.';
    if (computed.unpaid_amount > 0.005 && !partyId) {
      return 'Unpaid balance requires a vendor party.';
    }
    return null;
  };

  const handleSave = async () => {
    const err = validate();
    if (err) { message.warning(err); return; }
    setSaving(true);
    try {
      // Distribute voucher-wide GST proportionally across lines so the
      // per-line totals tie to the voucher GST without sub-paisa drift.
      const totalSub = computed.subtotal;
      const acc = { cgst: 0, sgst: 0, igst: 0 };
      const items = lines.map((ln, i) => {
        const taxable = r2(ln.taxable_amount);
        const isLast = i === lines.length - 1;
        let lc, ls, lig;
        if (totalSub <= 0) lc = ls = lig = 0;
        else if (isLast) {
          lc = r2(computed.cgst - acc.cgst);
          ls = r2(computed.sgst - acc.sgst);
          lig = r2(computed.igst - acc.igst);
        } else {
          const share = taxable / totalSub;
          lc = r2(computed.cgst * share);
          ls = r2(computed.sgst * share);
          lig = r2(computed.igst * share);
          acc.cgst += lc; acc.sgst += ls; acc.igst += lig;
        }
        return {
          expense_ledger_id: ln.expense_ledger_id,
          description: ln.description || null,
          taxable_amount: taxable,
          cgst_rate: gstSelected.cgst,
          sgst_rate: gstSelected.sgst,
          igst_rate: gstSelected.igst,
        };
      });

      const payload = {
        voucher_date: voucherDate.format('YYYY-MM-DD'),
        payment_mode: paymentMode,
        bank_ledger_id: paymentMode === 'Bank' ? bankLedgerId : null,
        party_id: partyId || null,
        reference_number: referenceNumber.trim() || null,
        payment_ref: paymentRef.trim() || null,
        narration: narration.trim() || null,
        round_off: computed.round_off,
        paid_amount: paidAmountOverride != null ? r2(paidAmountOverride) : undefined,
        items,
      };
      const result = await guardedSave(payload, (b) => (
        isEdit ? expenseAPI.update(id, b).then(r => r.data) : expenseAPI.create(b).then(r => r.data)
      ));

      pushRecent(items.map((it) => it.expense_ledger_id));

      message.success(isEdit
        ? `Expense ${result.voucher_number} updated.`
        : `Expense ${result.voucher_number} posted.`);
      navigate('/expenses');
    } catch (e) {
      if (!isFiscalLockCancel(e)) {
        message.error(e.response?.data?.message || e.response?.data?.error || 'Save failed.');
      }
    }
    setSaving(false);
  };

  const handleCancelVoucher = async () => {
    if (!isEdit || isCancelled) return;
    let reason = '';
    Modal.confirm({
      title: `Cancel expense ${voucherNumber}?`,
      content: (
        <div>
          <p>This posts a reversing entry. The original voucher and its line breakdown are preserved for audit.</p>
          <Input.TextArea rows={2} placeholder="Reason (optional)" onChange={(e) => { reason = e.target.value; }} />
        </div>
      ),
      okText: 'Cancel voucher',
      okButtonProps: { danger: true },
      cancelText: 'Go back',
      onOk: async () => {
        try {
          await expenseAPI.cancel(id, reason);
          message.success('Expense voucher cancelled.');
          navigate('/expenses');
        } catch (e) {
          message.error(e.response?.data?.error || 'Cancel failed.');
        }
      },
    });
  };

  // ── Lines table columns ─────────────────────────────────────
  const cols = [
    {
      title: 'Expense Head', dataIndex: 'expense_ledger_id', key: 'head', width: 240,
      render: (_, row, idx) => (
        <Select
          showSearch
          placeholder="Select head"
          value={row.expense_ledger_id}
          onChange={(v) => updateLine(idx, { expense_ledger_id: v })}
          style={{ width: '100%' }}
          optionFilterProp="label"
          filterSort={(a, b) => a.label.localeCompare(b.label)}
          disabled={isCancelled}
          popupMatchSelectWidth={false}
          options={expenseLedgers.map((lg) => ({
            value: lg.ledger_id,
            label: lg.ledger_name,
            sub: lg.sub_group,
          }))}
          optionRender={(o) => (
            <div style={{ display: 'flex', justifyContent: 'space-between', gap: 14 }}>
              <span>{o.data.label}</span>
              <span style={{ fontSize: 11, color: '#9ca3af' }}>{o.data.sub}</span>
            </div>
          )}
        />
      ),
    },
    {
      title: 'Description', dataIndex: 'description', key: 'desc',
      render: (_, row, idx) => (
        <Input
          placeholder="Optional note"
          value={row.description}
          disabled={isCancelled}
          onChange={(e) => updateLine(idx, { description: e.target.value })}
        />
      ),
    },
    {
      title: 'Amount', dataIndex: 'taxable_amount', key: 'amount', width: 140, align: 'right',
      render: (_, row, idx) => (
        <InputNumber
          ref={idx === 0 ? firstAmtRef : null}
          value={row.taxable_amount}
          min={0}
          precision={2}
          keyboard={false}
          disabled={isCancelled}
          style={{ width: '100%', fontFamily: MONO }}
          onChange={(v) => updateLine(idx, { taxable_amount: v ?? 0 })}
          formatter={(v) => v != null && v !== '' ? Number(v).toLocaleString('en-IN', { minimumFractionDigits: 0, maximumFractionDigits: 2 }) : ''}
          parser={(v) => v.replace(/,/g, '')}
          onPressEnter={() => {
            if (idx === lines.length - 1 && row.expense_ledger_id && r2(row.taxable_amount) > 0) {
              addLine();
            }
          }}
        />
      ),
    },
    {
      title: 'Tax', key: 'tax', width: 110, align: 'right',
      render: (_, row) => {
        const taxable = r2(row.taxable_amount);
        const totalRate = gstSelected.cgst + gstSelected.sgst + gstSelected.igst;
        const tax = r2((taxable * totalRate) / 100);
        return (
          <span style={{ fontFamily: MONO, color: tax > 0 ? '#1f2937' : '#9ca3af' }}>
            {tax > 0 ? fmt(tax) : '—'}
          </span>
        );
      },
    },
    {
      title: 'Total', key: 'total', width: 130, align: 'right',
      render: (_, row) => {
        const taxable = r2(row.taxable_amount);
        const totalRate = gstSelected.cgst + gstSelected.sgst + gstSelected.igst;
        const total = r2(taxable + (taxable * totalRate) / 100);
        return <strong style={{ fontFamily: MONO }}>{fmt(total)}</strong>;
      },
    },
    {
      title: '', key: 'actions', width: 50, align: 'right',
      render: (_, _row, idx) => (
        <Tooltip title={lines.length <= 1 ? 'At least one line is required' : 'Remove line'}>
          <Button
            type="text" danger
            disabled={lines.length <= 1 || isCancelled}
            icon={<DeleteOutlined />}
            onClick={() => removeLine(idx)}
          />
        </Tooltip>
      ),
    },
  ];

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 }}>
      <Card
        loading={loading}
        style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}
        styles={{ body: { flex: 1, minHeight: 0, overflow: 'auto', padding: 20 } }}
      >
        <Space style={{ width: '100%', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
          <Space size={12} align="center">
            <Button type="text" icon={<ArrowLeftOutlined />} onClick={() => confirmLeave(() => navigate('/expenses'))} />
            <Title level={4} style={{ margin: 0 }}>
              {isEdit ? `Edit Expense ${voucherNumber}` : 'New Expense Voucher'}
            </Title>
            {isCancelled && <Tag color="default">Cancelled</Tag>}
          </Space>
          {!isEdit && nextNumber && (
            <Text type="secondary" style={{ fontFamily: MONO }}>Next #: {nextNumber}</Text>
          )}
        </Space>

        {/* ── Form header — Date · Mode · Bank · Vendor · Reference ── */}
        <Form layout="vertical" disabled={isCancelled}>
          <Space size="large" wrap style={{ marginBottom: 12, rowGap: 0 }}>
            <Form.Item label="Voucher Date" required style={{ marginBottom: 8 }}>
              <DatePicker
                value={voucherDate}
                onChange={(d) => d && setVoucherDate(d)}
                format="DD-MM-YYYY"
                allowClear={false}
                style={{ width: 160 }}
              />
            </Form.Item>

            <Form.Item label="Payment Mode" required style={{ marginBottom: 8 }}>
              <Select
                value={paymentMode}
                onChange={(v) => {
                  setPaymentMode(v);
                  if (v !== 'Bank')   setBankLedgerId(null);
                  if (v !== 'Credit') setPaidOverride(null);
                }}
                style={{ width: 160 }}
                options={[
                  { value: 'Cash',   label: 'Cash' },
                  { value: 'Bank',   label: 'Bank' },
                  { value: 'Credit', label: 'Credit' },
                ]}
              />
            </Form.Item>

            {paymentMode === 'Bank' && (
              <Form.Item label="Bank Account" required style={{ marginBottom: 8 }}>
                <Select
                  value={bankLedgerId}
                  onChange={setBankLedgerId}
                  showSearch
                  optionFilterProp="label"
                  placeholder="Pick a bank"
                  style={{ width: 220 }}
                  options={bankLedgers.map((b) => ({ value: b.ledger_id, label: b.ledger_name }))}
                />
              </Form.Item>
            )}

            <Form.Item
              label={paymentMode === 'Credit' ? 'Vendor' : 'Vendor (optional)'}
              required={paymentMode === 'Credit'}
              style={{ marginBottom: 8 }}
            >
              <Select
                ref={partyRef}
                value={partyId}
                onChange={setPartyId}
                showSearch
                allowClear={paymentMode !== 'Credit'}
                optionFilterProp="label"
                placeholder="Search vendor"
                style={{ width: 240 }}
                options={parties.map((p) => ({ value: p.party_id, label: p.party_name }))}
              />
            </Form.Item>

            <Form.Item label="GST" style={{ marginBottom: 8 }}>
              <Select
                value={gstPreset}
                onChange={setGstPreset}
                style={{ width: 200 }}
                popupMatchSelectWidth={false}
                options={GST_OPTIONS.map((p) => ({ value: p.value, label: p.label }))}
              />
            </Form.Item>

            <Form.Item label="Bill / Ref No." style={{ marginBottom: 8 }}>
              <Input
                value={referenceNumber}
                onChange={(e) => setReferenceNo(e.target.value)}
                placeholder="Vendor invoice"
                style={{ width: 180 }}
              />
            </Form.Item>

            {paymentMode === 'Bank' && (
              <Form.Item label="Cheque / UTR" style={{ marginBottom: 8 }}>
                <Input
                  value={paymentRef}
                  onChange={(e) => setPaymentRef(e.target.value)}
                  placeholder="Optional"
                  style={{ width: 180 }}
                />
              </Form.Item>
            )}
          </Space>

          <Form.Item label="Narration" style={{ marginBottom: 12 }}>
            <Input
              placeholder="What is this expense for? (carried onto every Dr/Cr leg)"
              value={narration}
              onChange={(e) => setNarration(e.target.value)}
            />
          </Form.Item>
        </Form>

        {/* ── Lines table ───────────────────────────────────────── */}
        <Table
          rowKey={(_r, i) => i}
          columns={cols}
          dataSource={lines}
          pagination={false}
          size="small"
          footer={() => (
            <Space style={{ width: '100%', justifyContent: 'space-between' }} wrap>
              <Button
                icon={<PlusOutlined />}
                onClick={addLine}
                disabled={isCancelled}
              >
                Add line
              </Button>
              <Space size="large" wrap>
                <Text>Subtotal: <span style={{ fontFamily: MONO }}>{fmt(computed.subtotal)}</span></Text>
                {computed.gst_amount > 0 && (
                  <Text>
                    {gstSelected.igst > 0 ? `IGST` : `CGST+SGST`}: <span style={{ fontFamily: MONO }}>{fmt(computed.gst_amount)}</span>
                  </Text>
                )}
                <Space size={6} align="center">
                  <Text>Round Off:</Text>
                  <InputNumber
                    value={roundOff}
                    onChange={(v) => setRoundOff(v ?? 0)}
                    precision={2}
                    keyboard={false}
                    size="small"
                    disabled={isCancelled}
                    style={{ width: 100, fontFamily: MONO, textAlign: 'right' }}
                  />
                </Space>
                <Text strong style={{ fontSize: 16 }}>
                  Total: <span style={{ fontFamily: MONO, color: '#dc2626' }}>{rupee(computed.total_amount)}</span>
                </Text>
              </Space>
            </Space>
          )}
        />

        {/* Recent-head chips below the table — quick-pick helpers
            mirror the same pattern as the global search recents.
            Hidden when editing or when there's nothing to suggest. */}
        {!isEdit && recentHeads.length > 0 && (
          <Space wrap size={[6, 6]} style={{ marginTop: 12, alignItems: 'center' }}>
            <Text type="secondary" style={{ fontSize: 11, fontWeight: 600, letterSpacing: 0.8, textTransform: 'uppercase' }}>
              Recent heads:
            </Text>
            {recentHeads.map((lg) => (
              <Tag
                key={lg.ledger_id}
                style={{ cursor: 'pointer', padding: '2px 10px', fontSize: 12 }}
                onClick={() => {
                  // Apply to first empty line, else last line
                  const idx = lines.findIndex((ln) => !ln.expense_ledger_id);
                  updateLine(idx >= 0 ? idx : lines.length - 1, { expense_ledger_id: lg.ledger_id });
                }}
              >
                {lg.ledger_name}
              </Tag>
            ))}
          </Space>
        )}

        {/* Optional: Paid Now override — only meaningful for Cash/Bank
            with a vendor (so the unpaid balance has somewhere to go). */}
        {paymentMode !== 'Credit' && partyId && (
          <Form layout="vertical" style={{ marginTop: 12 }}>
            <Form.Item
              label="Paid Now (override)"
              help={
                paidAmountOverride == null
                  ? `Defaults to total — ${rupee(computed.total_amount)}. Override to record a partial payment.`
                  : computed.unpaid_amount > 0
                    ? `Vendor will carry ${rupee(computed.unpaid_amount)} as Payable.`
                    : 'Fully paid.'
              }
              style={{ marginBottom: 0, maxWidth: 360 }}
            >
              <InputNumber
                value={paidAmountOverride}
                onChange={(v) => setPaidOverride(v)}
                min={0}
                max={computed.total_amount}
                precision={2}
                keyboard={false}
                placeholder={`auto · ${fmt(computed.total_amount)}`}
                disabled={isCancelled}
                style={{ width: 220, fontFamily: MONO }}
                formatter={(v) => v != null && v !== '' ? '₹ ' + Number(v).toLocaleString('en-IN', { minimumFractionDigits: 0, maximumFractionDigits: 2 }) : ''}
                parser={(v) => v.replace(/[₹,\s]/g, '')}
              />
            </Form.Item>
          </Form>
        )}
      </Card>

      <ActionStrip
        actions={[
          { id: 'back', key: 'Esc', label: 'Back', historyBack: false,
            onAction: () => confirmLeave(goBack) },
          { id: 'date', key: 'F2', label: 'Date',
            onAction: () => openDate({
              title: 'Voucher Date',
              value: voucherDate || dayjs(),
              onConfirm: (d) => setVoucherDate(d),
            }),
            title: 'Open the smart-input date popup',
            disabled: isCancelled,
          },
          { id: 'addline', key: 'F3', label: 'Add Line',
            onAction: addLine, disabled: isCancelled,
            title: 'Append a new expense line' },
          { id: 'find', key: 'F4', label: 'Vendor',
            onAction: () => partyRef.current?.focus?.(),
            title: 'Focus the vendor picker' },
          ...(isEdit ? [{
            id: 'cancel-voucher', key: 'F8', label: 'Cancel Voucher', tone: 'danger',
            disabled: isCancelled,
            onAction: handleCancelVoucher,
          }] : []),
          { id: 'save', key: 'F1', label: isEdit ? 'Save Changes' : 'Post Expense', tone: 'primary',
            disabled: saving || isCancelled || computed.total_amount <= 0,
            onAction: handleSave },
          { id: 'save-alt', key: 'Ctrl+Enter', label: '', hidden: true,
            disabled: saving || isCancelled, onAction: handleSave },
        ]}
      />

      <FiscalLockOverrideModal
        open={!!lockModal}
        lock={lockModal?.lock}
        billDate={voucherDate}
        vouchTypeLabel="Expense"
        onConfirm={lockModal?.onConfirm}
        onCancel={lockModal?.onCancel}
      />
    </div>
  );
}
