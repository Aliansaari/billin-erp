import React, { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { Input, DatePicker, Select, Button, InputNumber, Typography, message, Checkbox, Tag, Tooltip, Divider, Modal } from 'antd';
import {
  ArrowLeftOutlined, ReloadOutlined, MessageOutlined,
  CheckCircleOutlined, UserOutlined, CalendarOutlined,
} from '@ant-design/icons';
import { useNavigate } from 'react-router-dom';
import dayjs from 'dayjs';
import { paymentAPI, partyAPI } from '../../api';

const { Text } = Typography;
const MODES = ['Cash', 'Card', 'UPI', 'Cheque', 'Bank Transfer'];

const fmt2 = (v) =>
  parseFloat(v || 0).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const rupee = (v) => '₹ ' + fmt2(v);

const accent   = '#059669';
const accentMd = '#10b981';
const grad     = 'linear-gradient(135deg,#059669,#10b981)';

const parseDateInput = (str) => {
  if (!str) return null;
  const parts = str.trim().replace(/[\/\.]/g, '-').split('-');
  if (parts.length < 2) return null;
  const d = parseInt(parts[0], 10);
  const m = parseInt(parts[1], 10);
  let y   = parts[2] !== undefined ? parseInt(parts[2], 10) : dayjs().year();
  if (y < 100) y += 2000;
  if (!d || !m || d < 1 || d > 31 || m < 1 || m > 12) return null;
  const parsed = dayjs(`${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`);
  return parsed.isValid() ? parsed : null;
};

export default function ReceiptEntry() {
  const navigate = useNavigate();
  const [parties, setParties]             = useState([]);
  const [selectedParty, setSelectedParty] = useState(null);
  const [bills, setBills]                 = useState([]);
  const [date, setDate]                   = useState(dayjs());
  const [payMode, setPayMode]             = useState('Cash');
  const [payNo, setPayNo]                 = useState('');
  const [payAmt, setPayAmt]               = useState(null);
  const [discAmt, setDiscAmt]             = useState(0);
  const [loading, setLoading]             = useState(false);
  const [dueDaysMode, setDueDaysMode]     = useState('bill_date');

  const payAmtRef        = useRef(null);
  const handleSaveRef    = useRef(null);
  const dateInputRef     = useRef(null);
  const submittingRef    = useRef(false);
  const openDateEditRef  = useRef(null);  // ref-based so F2 handler sees fresh closure

  const [dateEditMode, setDateEditMode] = useState(false);
  const [dateInputVal, setDateInputVal] = useState('');

  const openDateEdit = () => {
    setDateInputVal(date.format('D-M-YYYY'));
    setDateEditMode(true);
    setTimeout(() => { dateInputRef.current?.select(); }, 30);
  };
  // Kept in sync each render so the mount-time F2 listener picks up the
  // current closure (needed because `date` is captured). Equivalent to the
  // handleSaveRef pattern used below.
  openDateEditRef.current = openDateEdit;

  const commitDateInput = () => {
    const parsed = parseDateInput(dateInputVal);
    if (parsed) { setDate(parsed); message.success(`Date set to ${parsed.format('DD-MM-YYYY')}`); }
    else if (dateInputVal) message.warning('Invalid date — use d-m-yy or d-m-yyyy');
    setDateEditMode(false);
  };

  useEffect(() => {
    loadParties();
    setDueDaysMode(localStorage.getItem('sale_due_days_mode') || 'bill_date');
    const onKey = (e) => {
      // Ignore F-keys while focus is inside an AntD modal or a floating
      // picker dropdown (e.g. party-select list) — otherwise F1 submits the
      // parent form while the user is mid-interaction inside a popup.
      // Also ignore during IME composition so CJK input isn't interrupted.
      if (e.isComposing || e.keyCode === 229) return;
      const active = document.activeElement;
      if (active && active.closest(
        '.ant-modal, .ant-picker-dropdown, .ant-select-dropdown, .ant-popover'
      )) return;
      if (e.key === 'F1') { e.preventDefault(); handleSaveRef.current?.(); }
      if (e.key === 'F2') { e.preventDefault(); openDateEditRef.current?.(); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const loadParties = async () => {
    try {
      const { data } = await partyAPI.getCustomers({ limit: 1000 });
      setParties((data.data || []).filter(p => p.is_active !== false));
    } catch (_) {}
  };

  const handlePartyChange = async (partyId) => {
    const party = parties.find(p => p.party_id === partyId);
    setSelectedParty(party);
    setBills([]);
    setPayAmt(null);
    try {
      const { data } = await paymentAPI.getUnpaidBills({ party_id: partyId, type: 'Sales' });
      const rows = (data || []).map(b => ({
        ...b,
        checked: true,
        dueDays: b.bill_date ? dayjs().diff(dayjs(b.bill_date), 'day') : 0,
      }));
      // Remaining opening balance row — only shown when the party actually has
      // a Receivable opening balance and some of it is still unpaid.
      //
      // Two guards to prevent "phantom OB" double-allocation:
      //   1. opening_balance_type must be 'Receivable' — otherwise the OB isn't
      //      owed on this side of the ledger (e.g. a Payable OB would never
      //      appear under customer receipts).
      //   2. remainingOB is capped at the party's original opening_balance. If
      //      current_balance has drifted (manual edit, legacy data), we never
      //      invent more OB than the party actually started with.
      const billsTotal    = rows.reduce((s, b) => s + parseFloat(b.balance_amount || 0), 0);
      const partyBal      = parseFloat(party?.current_balance || 0);  // +ve = they owe us
      const originalOB    = parseFloat(party?.opening_balance || 0);
      const obIsReceivable = party?.opening_balance_type === 'Receivable' && originalOB > 0;
      const derivedOB     = Math.max(0, partyBal - billsTotal);
      const remainingOB   = obIsReceivable
        ? parseFloat(Math.min(originalOB, derivedOB).toFixed(2))
        : 0;
      if (remainingOB > 0) {
        rows.unshift({
          sales_bill_id:  '__ob__',
          bill_number:    'Opening Balance',
          bill_date:      party.created_date,
          total_amount:   remainingOB,   // what remains of OB — not the original full amount
          balance_amount: remainingOB,
          isOpening:      true,
          checked:        true,
          dueDays:        dayjs().diff(dayjs(party.created_date), 'day'),
        });
      }
      setBills(rows);
    } catch (_) {}
    setTimeout(() => payAmtRef.current?.focus(), 100);
  };

  const toggleBill = (idx, checked) => {
    setBills(prev => prev.map((b, i) => i === idx ? { ...b, checked } : b));
  };

  const maxPayAmt = useMemo(
    () => bills.filter(b => b.checked).reduce((s, b) => s + parseFloat(b.balance_amount || 0), 0),
    [bills]
  );

  // Fix: compute netAmount first so allocations use the actual amount being received (after discount)
  const netAmount = Math.max(0, (payAmt || 0) - (discAmt || 0));

  const billsWithAlloc = useMemo(() => {
    let remaining = netAmount || 0;
    return bills.map(b => {
      if (!b.checked || remaining <= 0) return { ...b, allocated: 0 };
      const alloc = Math.min(remaining, parseFloat(b.balance_amount || 0));
      remaining = parseFloat((remaining - alloc).toFixed(2));
      return { ...b, allocated: alloc };
    });
  }, [bills, netAmount]);

  const checkedBills   = billsWithAlloc.filter(b => b.checked);
  const selectedInvNos = checkedBills.map(b => b.bill_number).join(', ');

  const handlePayAmtChange = (val) => {
    const v = val || 0;
    if (v > maxPayAmt) {
      message.warning(`Max receivable: ₹ ${fmt2(maxPayAmt)}`);
      setPayAmt(maxPayAmt);
    } else {
      setPayAmt(v || null);
    }
  };

  const handleReset = () => {
    setSelectedParty(null);
    setBills([]);
    setDate(dayjs());
    setPayMode('Cash');
    setPayNo('');
    setPayAmt(null);
    setDiscAmt(0);
  };

  const handleSave = useCallback(async () => {
    if (submittingRef.current) return;
    if (!selectedParty) { message.warning('Select a customer first'); return; }
    if (!payAmt || payAmt <= 0) { message.warning('Enter an amount'); return; }
    if (netAmount <= 0) { message.warning('Net amount must be greater than 0'); return; }

    const refBill = checkedBills.find(b => !b.isOpening);
    // Build per-bill allocations so each bill's balance gets updated correctly
    const bill_allocations = billsWithAlloc
      .filter(b => !b.isOpening && b.allocated > 0)
      .map(b => ({ bill_id: b.sales_bill_id, bill_type: 'Sales', amount: b.allocated }));

    // ── Silent-on-account guard ─────────────────────────────────────────────
    // If the cashier entered an amount but no bills are ticked (and no OB is
    // being cleared), the receipt would save as "on-account credit" with no
    // warning. The cashier thinks the bill is settled — it's not. Force an
    // explicit confirmation before going ahead.
    const obBill = checkedBills.find(b => b.isOpening);
    const obAlloc = obBill ? parseFloat(obBill.allocated) || 0 : 0;
    if (bill_allocations.length === 0 && obAlloc <= 0) {
      const confirmed = await new Promise((resolve) => {
        Modal.confirm({
          title: 'Save as on-account credit?',
          content:
            `No bills are selected for allocation. ₹${fmt2(netAmount)} will be recorded ` +
            `against ${selectedParty.party_name} as an on-account credit (no bill will be marked paid). ` +
            `Continue?`,
          okText: 'Save on-account',
          okButtonProps: { style: { background: accent, borderColor: accent } },
          cancelText: 'Go back',
          onOk:     () => resolve(true),
          onCancel: () => resolve(false),
        });
      });
      if (!confirmed) return;
    }

    submittingRef.current = true;
    setLoading(true);
    try {
      const { data: result } = await paymentAPI.create({
        transaction_type:    'Receipt',
        transaction_date:    date.format('YYYY-MM-DD'),
        party_id:            selectedParty.party_id,
        total_amount:        netAmount,
        reference_bill_id:   refBill?.sales_bill_id || null,
        reference_bill_type: refBill ? 'Sales' : null,
        remarks:             selectedInvNos ? `Bills: ${selectedInvNos}` : payNo,
        splits:              [{ payment_mode: payMode, amount: netAmount }],
        bill_allocations,
      });
      message.success(`Receipt ${result.transaction_number} saved! ✓`);
      handleReset();
    } catch (e) {
      message.error(e.response?.data?.error || 'Failed to save receipt');
    } finally {
      setLoading(false);
      submittingRef.current = false;
    }
  }, [selectedParty, payAmt, netAmount, date, payMode, payNo, checkedBills, selectedInvNos]);

  handleSaveRef.current = handleSave;

  const renderDueDays = (bill) => {
    if (dueDaysMode === 'due_date' && bill.due_date) {
      const diff = dayjs(bill.due_date).diff(dayjs(), 'day');
      if (diff < 0) return <span style={{ color: '#dc2626', fontWeight: 700, fontSize: 12 }}>Overdue<br />{Math.abs(diff)}d</span>;
      return <span style={{ color: diff <= 7 ? '#f59e0b' : accent, fontWeight: 600, fontSize: 12 }}>Due in<br />{diff}d</span>;
    }
    const age = bill.bill_date ? dayjs().diff(dayjs(bill.bill_date), 'day') : 0;
    return (
      <span style={{ color: age > 60 ? '#dc2626' : age > 30 ? '#f59e0b' : '#64748b', fontWeight: age > 30 ? 700 : 400, fontSize: 13 }}>
        {age}d
      </span>
    );
  };

  // Label style — readable size, not all-caps
  const lbl = { fontSize: 13, fontWeight: 600, color: '#374151', marginBottom: 5, display: 'block' };
  const row = { marginBottom: 14 };

  return (
    <div style={{ height: '100%', display: 'flex', flexDirection: 'column', background: '#f1f5f9', overflow: 'hidden' }}>

      {/* HEADER */}
      <div style={{ flexShrink: 0, background: 'white', borderBottom: '1px solid #e2e8f0', padding: '0 20px', height: 56, display: 'flex', alignItems: 'center', gap: 12, boxShadow: '0 1px 4px rgba(0,0,0,0.06)' }}>
        <div style={{ width: 36, height: 36, borderRadius: 8, background: grad, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          <CheckCircleOutlined style={{ color: 'white', fontSize: 17 }} />
        </div>
        <div>
          <div style={{ fontWeight: 700, fontSize: 16, color: '#1e293b', lineHeight: 1.2 }}>Customer Receipt</div>
          <div style={{ fontSize: 12, color: '#94a3b8' }}>Money In · From Customer</div>
        </div>
        <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 8 }}>
          <Tag color="green" style={{ borderRadius: 6, fontSize: 13, padding: '2px 10px' }}>Receipt #: Auto</Tag>
          <Tooltip title="F1 — Save Receipt">
            <Button type="primary" icon={<CheckCircleOutlined />} loading={loading} onClick={handleSave}
              style={{ background: grad, border: 'none', fontWeight: 600, borderRadius: 8, height: 36, fontSize: 14 }}>
              RECEIPT &nbsp;<span style={{ opacity: 0.75, fontSize: 12 }}>F1</span>
            </Button>
          </Tooltip>
          <Button icon={<ReloadOutlined />} onClick={handleReset} style={{ borderRadius: 8, height: 36 }}>Reset</Button>
          <Button icon={<ArrowLeftOutlined />} onClick={() => navigate('/payments')} style={{ borderRadius: 8, height: 36 }}>Back</Button>
        </div>
      </div>

      {/* SPLIT */}
      <div style={{ flex: 1, display: 'flex', overflow: 'hidden' }}>

        {/* LEFT PANEL */}
        <div style={{ width: 300, flexShrink: 0, background: 'white', borderRight: '1px solid #e2e8f0', padding: '18px 16px', overflowY: 'auto', display: 'flex', flexDirection: 'column' }}>

          <div style={row}>
            <span style={lbl}><CalendarOutlined style={{ marginRight: 6 }} />Date <span style={{ fontSize: 11, fontWeight: 400, color: '#9ca3af' }}>— F2 to type</span></span>
            {dateEditMode ? (
              <Input
                ref={dateInputRef}
                value={dateInputVal}
                onChange={e => setDateInputVal(e.target.value)}
                placeholder="d-m-yy  or  d-m-yyyy"
                style={{ borderColor: accentMd, fontWeight: 600, fontSize: 14, height: 36 }}
                onKeyDown={e => {
                  if (e.key === 'Enter') { e.preventDefault(); commitDateInput(); }
                  if (e.key === 'Escape') { setDateEditMode(false); }
                }}
                onBlur={commitDateInput}
                suffix={<span style={{ fontSize: 11, color: '#94a3b8' }}>Enter ↵</span>}
              />
            ) : (
              <DatePicker value={date} onChange={setDate} format="DD-MM-YYYY" style={{ width: '100%', height: 36 }} />
            )}
          </div>

          <div style={row}>
            <span style={lbl}><UserOutlined style={{ marginRight: 6 }} />Customer</span>
            <Select showSearch placeholder="Search customer..." optionFilterProp="children" style={{ width: '100%' }}
              onChange={handlePartyChange} value={selectedParty?.party_id}>
              {parties.map(p => <Select.Option key={p.party_id} value={p.party_id}>{p.party_name}</Select.Option>)}
            </Select>
          </div>

          {selectedParty && (
            <div style={{ marginBottom: 14, padding: '10px 14px', borderRadius: 10, background: 'linear-gradient(135deg,#f0fdf4,#dcfce7)', border: '1px solid #86efac', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <span style={{ fontSize: 13, fontWeight: 600, color: '#166534' }}>Balance (Receivable)</span>
              <span style={{ fontSize: 15, fontWeight: 800, color: accent }}>{rupee(selectedParty.current_balance)}</span>
            </div>
          )}

          <div style={row}>
            <span style={lbl}>Invoice Nos.</span>
            <Input value={selectedInvNos} readOnly placeholder="Auto-filled from selected bills →"
              style={{ background: '#f8fafc', fontSize: 13, height: 36 }} />
          </div>

          <Divider style={{ margin: '10px 0', borderColor: '#e2e8f0' }} />

          <div style={row}>
            <span style={lbl}>Payment Mode</span>
            <Select value={payMode} onChange={setPayMode} style={{ width: '100%' }}>
              {MODES.map(m => <Select.Option key={m} value={m}>{m}</Select.Option>)}
            </Select>
          </div>

          <div style={row}>
            <span style={{ ...lbl, color: '#065f46' }}>Receive Amount (₹)</span>
            <InputNumber
              ref={payAmtRef}
              keyboard={false}
              value={payAmt}
              onChange={handlePayAmtChange}
              min={0}
              max={maxPayAmt || undefined}
              placeholder="Enter amount"
              style={{ width: '100%', fontWeight: 700, borderColor: accentMd, height: 36 }}
              formatter={v => v != null && v !== '' ? `₹ ${v}`.replace(/\B(?=(\d{3})+(?!\d))/g, ',') : ''}
              parser={v => v.replace(/₹\s?|(,*)/g, '')}
            />
            {maxPayAmt > 0 && (
              <div style={{ fontSize: 12, color: accent, marginTop: 3 }}>Max: ₹ {fmt2(maxPayAmt)}</div>
            )}
          </div>

          <div style={row}>
            <span style={lbl}>Discount Amount (₹)</span>
            <InputNumber keyboard={false} value={discAmt} onChange={v => setDiscAmt(v || 0)} min={0}
              style={{ width: '100%', height: 36 }}
              formatter={v => `₹ ${v}`.replace(/\B(?=(\d{3})+(?!\d))/g, ',')}
              parser={v => v.replace(/₹\s?|(,*)/g, '')} />
          </div>

          <div style={row}>
            <span style={lbl}>Ref / Pay No.</span>
            <Input value={payNo} onChange={e => setPayNo(e.target.value)} placeholder="Cheque / UTR / Ref no." style={{ height: 36 }} />
          </div>

          <div style={{ marginTop: 4, marginBottom: 14, padding: '12px 16px', borderRadius: 10, background: grad, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <span style={{ color: 'rgba(255,255,255,0.85)', fontWeight: 600, fontSize: 14 }}>Net Amount</span>
            <span style={{ color: 'white', fontWeight: 800, fontSize: 18 }}>{rupee(netAmount)}</span>
          </div>

          <Tooltip title="Send SMS to customer">
            <Button icon={<MessageOutlined />} style={{ width: '100%', borderRadius: 8, marginBottom: 10, height: 36, fontSize: 14 }}>Send SMS</Button>
          </Tooltip>
          <Button type="primary" icon={<CheckCircleOutlined />} loading={loading} onClick={handleSave}
            style={{ width: '100%', borderRadius: 10, fontWeight: 700, fontSize: 15, height: 46, background: grad, border: 'none', boxShadow: '0 4px 14px rgba(5,150,105,0.35)' }}>
            RECEIPT &nbsp;<span style={{ opacity: 0.7, fontSize: 12 }}>F1</span>
          </Button>
        </div>

        {/* RIGHT PANEL */}
        <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden', background: '#f8fafc' }}>

          {/* Table header */}
          <div style={{ flexShrink: 0, display: 'grid', gridTemplateColumns: '1fr 90px 120px 130px 50px 130px 80px', background: grad, color: 'white', fontWeight: 700, fontSize: 12, padding: '10px 16px', letterSpacing: 0.3 }}>
            <span>Bill No.</span>
            <span>Date</span>
            <span style={{ textAlign: 'right' }}>Net Amt</span>
            <span style={{ textAlign: 'right' }}>Balance</span>
            <span style={{ textAlign: 'center' }}>Pay</span>
            <span style={{ textAlign: 'right' }}>Paying Now</span>
            <span style={{ textAlign: 'center' }}>Age</span>
          </div>

          {/* Rows */}
          <div style={{ flex: 1, overflowY: 'auto' }}>
            {billsWithAlloc.length === 0 ? (
              <div style={{ padding: '80px 20px', textAlign: 'center', color: '#94a3b8', fontSize: 14 }}>
                {selectedParty ? 'No outstanding bills for this customer' : 'Select a customer to see outstanding bills'}
              </div>
            ) : billsWithAlloc.map((bill, idx) => {
              const netAmt   = parseFloat(bill.total_amount || 0);
              const balance  = parseFloat(bill.balance_amount || 0);
              const isPartiallyPaid = netAmt > balance;
              const alloc    = bill.allocated || 0;
              const rem      = parseFloat((balance - alloc).toFixed(2));
              const fullPaid = bill.checked && alloc > 0 && rem === 0;
              const partial  = bill.checked && alloc > 0 && rem > 0;

              return (
                <div
                  key={bill.sales_bill_id}
                  onClick={() => !bill.checked && toggleBill(idx, true)}
                  style={{
                    display: 'grid',
                    gridTemplateColumns: '1fr 90px 120px 130px 50px 130px 80px',
                    padding: '9px 16px',
                    borderBottom: '1px solid #e2e8f0',
                    alignItems: 'center',
                    background: fullPaid
                      ? 'linear-gradient(135deg,#f0fdf4,#dcfce7)'
                      : partial
                      ? 'linear-gradient(135deg,#fffbeb,#fef9c3)'
                      : bill.isOpening
                      ? 'linear-gradient(135deg,#eff6ff,#dbeafe)'
                      : idx % 2 === 0 ? 'white' : '#fafbfc',
                    cursor: bill.checked ? 'default' : 'pointer',
                    transition: 'background 0.15s',
                    borderLeft: fullPaid ? `3px solid ${accent}` : partial ? '3px solid #f59e0b' : bill.isOpening ? '3px solid #6366f1' : '3px solid transparent',
                  }}
                >
                  <span style={{ fontWeight: 700, fontSize: 13, color: bill.isOpening ? '#4338ca' : '#1e40af', fontStyle: bill.isOpening ? 'italic' : 'normal' }}>
                    {bill.bill_number}
                  </span>
                  <span style={{ fontSize: 12, color: '#64748b' }}>
                    {dayjs(bill.bill_date || bill.created_at).format('DD-MM-YY')}
                  </span>
                  {/* Net Amount (original bill total) */}
                  <div style={{ textAlign: 'right' }}>
                    <div style={{ fontSize: 13, color: '#475569' }}>₹ {fmt2(netAmt)}</div>
                    {isPartiallyPaid && (
                      <div style={{ fontSize: 10, color: '#16a34a', fontWeight: 600 }}>
                        Pd: ₹ {fmt2(netAmt - balance)}
                      </div>
                    )}
                  </div>
                  {/* Balance (remaining) */}
                  <div style={{ textAlign: 'right' }}>
                    <div style={{
                      fontSize: 13, fontWeight: 700,
                      color: isPartiallyPaid ? '#d97706' : '#dc2626',
                    }}>
                      ₹ {fmt2(balance)}
                    </div>
                    {partial && <div style={{ fontSize: 10, color: '#92400e' }}>After: ₹ {fmt2(rem)}</div>}
                  </div>
                  <div style={{ display: 'flex', justifyContent: 'center' }} onClick={e => e.stopPropagation()}>
                    <Checkbox checked={bill.checked} onChange={e => toggleBill(idx, e.target.checked)} />
                  </div>
                  <div style={{ textAlign: 'right' }}>
                    {bill.checked && alloc > 0 ? (
                      <span style={{ fontSize: 13, fontWeight: 700, color: fullPaid ? accent : '#d97706' }}>₹ {fmt2(alloc)}</span>
                    ) : (
                      <span style={{ color: '#cbd5e1', fontSize: 13 }}>—</span>
                    )}
                  </div>
                  <div style={{ textAlign: 'center' }}>{renderDueDays(bill)}</div>
                </div>
              );
            })}
          </div>

          {/* Footer */}
          <div style={{ flexShrink: 0, borderTop: '2px solid #e2e8f0', padding: '10px 18px', background: 'white', display: 'flex', justifyContent: 'flex-end', alignItems: 'center', gap: 24 }}>
            {checkedBills.length > 0 ? (
              <>
                <Text style={{ fontSize: 13, color: '#64748b' }}>Bills: <b style={{ color: '#1e293b' }}>{checkedBills.length}</b></Text>
                <Text style={{ fontSize: 13, color: '#64748b' }}>Max Receivable: <b style={{ color: accent }}>{rupee(maxPayAmt)}</b></Text>
                {payAmt > 0 && <Text style={{ fontSize: 13, color: '#64748b' }}>Receiving: <b style={{ color: '#065f46', fontSize: 15 }}>{rupee(payAmt)}</b></Text>}
                {discAmt > 0 && <Text style={{ fontSize: 13, color: '#64748b' }}>Disc: <b style={{ color: '#dc2626' }}>{rupee(discAmt)}</b></Text>}
                {discAmt > 0 && <Text style={{ fontSize: 13, color: '#64748b' }}>Net: <b style={{ color: accent, fontSize: 15 }}>{rupee(netAmount)}</b></Text>}
              </>
            ) : (
              <Text style={{ color: '#94a3b8', fontSize: 13 }}>Check the Pay box on bills to select them</Text>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
