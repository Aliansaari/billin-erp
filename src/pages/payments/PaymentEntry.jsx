import React, { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { Input, DatePicker, Select, Button, InputNumber, message, Checkbox, Modal, Tooltip } from 'antd';
import {
  ArrowLeftOutlined, ReloadOutlined, CheckCircleOutlined,
  CheckOutlined, MinusOutlined,
} from '@ant-design/icons';
import { useNavigate } from 'react-router-dom';
import dayjs from 'dayjs';
import { paymentAPI, partyAPI } from '../../api';
import { useUnsavedChangesWarning } from '../../hooks/useUnsavedChangesWarning';
import '../../styles/bill-entry.css';

const MODES = ['Cash', 'Card', 'UPI', 'Cheque', 'Bank Transfer'];

const fmt2 = (v) =>
  parseFloat(v || 0).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const rupee = (v) => '₹ ' + fmt2(v);

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

export default function PaymentEntry() {
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
  // Preview of the next PAY-* number. See ReceiptEntry for rationale.
  const [nextPayNo, setNextPayNo]         = useState('');

  const dirty = !!(selectedParty || payAmt);
  const confirmLeave = useUnsavedChangesWarning(dirty);

  const payAmtRef     = useRef(null);
  const handleSaveRef = useRef(null);
  const submittingRef = useRef(false);

  const refreshNextNumber = async () => {
    try {
      const { data } = await paymentAPI.nextNumber('Payment');
      setNextPayNo(data?.next || '');
    } catch (_) {}
  };

  useEffect(() => {
    loadParties();
    refreshNextNumber();
    setDueDaysMode(localStorage.getItem('purchase_due_days_mode') || 'bill_date');
    const onKey = (e) => {
      if (e.isComposing || e.keyCode === 229) return;
      const active = document.activeElement;
      if (active && active.closest(
        '.ant-modal, .ant-picker-dropdown, .ant-select-dropdown, .ant-popover'
      )) return;
      if (e.key === 'F1') { e.preventDefault(); handleSaveRef.current?.(); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const loadParties = async () => {
    try {
      const { data } = await partyAPI.getSuppliers({ limit: 1000 });
      setParties((data.data || []).filter(p => p.is_active !== false));
    } catch (_) {}
  };

  const handlePartyChange = async (partyId) => {
    const party = parties.find(p => p.party_id === partyId);
    setSelectedParty(party);
    setBills([]);
    setPayAmt(null);
    try {
      const { data } = await paymentAPI.getUnpaidBills({ party_id: partyId, type: 'Purchase' });
      const rows = (data || []).map(b => ({
        ...b,
        checked: true,
        dueDays: b.bill_date ? dayjs().diff(dayjs(b.bill_date), 'day') : 0,
      }));
      // Remaining opening balance row — Payable side. Same two guards as
      // ReceiptEntry, mirrored for opening_balance_type === 'Payable'.
      const billsTotal    = rows.reduce((s, b) => s + parseFloat(b.balance_amount || 0), 0);
      const partyBal      = parseFloat(party?.current_balance || 0); // -ve = we owe them
      const originalOB    = parseFloat(party?.opening_balance || 0);
      const obIsPayable   = party?.opening_balance_type === 'Payable' && originalOB > 0;
      const derivedOB     = Math.max(0, Math.abs(Math.min(0, partyBal)) - billsTotal);
      const remainingOB   = obIsPayable
        ? parseFloat(Math.min(originalOB, derivedOB).toFixed(2))
        : 0;
      if (remainingOB > 0) {
        rows.unshift({
          purchase_bill_id: '__ob__',
          bill_number:      'Opening Balance',
          bill_date:        party.created_date,
          total_amount:     remainingOB,
          balance_amount:   remainingOB,
          isOpening:        true,
          checked:          true,
          dueDays:          dayjs().diff(dayjs(party.created_date), 'day'),
        });
      }
      setBills(rows);
    } catch (_) {}
    setTimeout(() => payAmtRef.current?.focus(), 100);
  };

  const toggleBill = (idx, checked) => {
    setBills(prev => prev.map((b, i) => i === idx ? { ...b, checked } : b));
  };

  const allChecked = bills.length > 0 && bills.every(b => b.checked);
  const toggleAll = () => {
    const next = !allChecked;
    setBills(prev => prev.map(b => ({ ...b, checked: next })));
  };

  // Max Payable = min(sum of ticked bill balances, party's TRUE payable).
  // Payable appears as a negative current_balance for suppliers, so take abs.
  const maxPayAmt = useMemo(() => {
    const sumTicked = bills.filter(b => b.checked).reduce((s, b) => s + parseFloat(b.balance_amount || 0), 0);
    const partyBal  = parseFloat(selectedParty?.current_balance || 0);
    if (partyBal < 0) return Math.min(sumTicked, Math.abs(partyBal));
    return sumTicked;
  }, [bills, selectedParty]);

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
      message.warning(`Max payable: ₹ ${fmt2(maxPayAmt)}`);
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
    if (!selectedParty) { message.warning('Select a supplier first'); return; }
    if (!payAmt || payAmt <= 0) { message.warning('Enter a pay amount'); return; }
    if (netAmount <= 0) { message.warning('Net amount must be greater than 0'); return; }

    const refBill = checkedBills.find(b => !b.isOpening);
    const bill_allocations = billsWithAlloc
      .filter(b => !b.isOpening && b.allocated > 0)
      .map(b => ({ bill_id: b.purchase_bill_id, bill_type: 'Purchase', amount: b.allocated }));

    // On-account guard — same as ReceiptEntry, mirrored for payables.
    const obBill = checkedBills.find(b => b.isOpening);
    const obAlloc = obBill ? parseFloat(obBill.allocated) || 0 : 0;
    const sumAllocated = bill_allocations.reduce((s, a) => s + parseFloat(a.amount || 0), 0) + obAlloc;
    const surplus = +(netAmount - sumAllocated).toFixed(2);
    const hasSurplus = surplus > 0.01;
    const nothingTicked = bill_allocations.length === 0 && obAlloc <= 0;
    if (nothingTicked || hasSurplus) {
      const confirmed = await new Promise((resolve) => {
        Modal.confirm({
          title: 'Save as on-account credit?',
          content: nothingTicked
            ? `No bills are selected for allocation. ₹${fmt2(netAmount)} will be recorded ` +
              `against ${selectedParty.party_name} as an on-account credit (no bill will be marked paid). ` +
              `It will be auto-applied to the oldest unpaid bill(s). Continue?`
            : `Ticked bills cover ₹${fmt2(sumAllocated)}, but you are paying ₹${fmt2(netAmount)}. ` +
              `The ₹${fmt2(surplus)} surplus will be recorded as on-account credit and ` +
              `auto-applied to the oldest unpaid bill(s) for ${selectedParty.party_name}. Continue?`,
          okText: 'Save',
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
        transaction_type:    'Payment',
        transaction_date:    date.format('YYYY-MM-DD'),
        party_id:            selectedParty.party_id,
        total_amount:        netAmount,
        reference_bill_id:   refBill?.purchase_bill_id || null,
        reference_bill_type: refBill ? 'Purchase' : null,
        remarks:             selectedInvNos ? `Bills: ${selectedInvNos}` : payNo,
        splits:              [{ payment_mode: payMode, amount: netAmount }],
        bill_allocations,
      });
      message.success(`Payment ${result.transaction_number} saved! ✓`);
      handleReset();
      refreshNextNumber();
    } catch (e) {
      message.error(e.response?.data?.error || 'Failed to save payment');
    } finally {
      setLoading(false);
      submittingRef.current = false;
    }
  }, [selectedParty, payAmt, netAmount, date, payMode, payNo, checkedBills, selectedInvNos, billsWithAlloc]);

  handleSaveRef.current = handleSave;

  const renderAge = (bill) => {
    if (dueDaysMode === 'due_date' && bill.due_date) {
      const diff = dayjs(bill.due_date).diff(dayjs(), 'day');
      if (diff < 0) return <span className="be-age over">{Math.abs(diff)}d<span className="over-lbl">overdue</span></span>;
      return <span className={`be-age${diff <= 7 ? ' warn' : ''}`}>{diff}d</span>;
    }
    const age = bill.bill_date ? dayjs().diff(dayjs(bill.bill_date), 'day') : 0;
    return <span className={`be-age${age > 60 ? ' over' : age > 30 ? ' warn' : ''}`}>{age}d</span>;
  };

  return (
    <div className="be-page money-out">

      {/* ── COMPACT HEADER ── */}
      <div className="be-vh">
        <div className="be-vh-fld">
          <span className="be-k">Date <span className="hint">· F2</span></span>
          <div className="be-vh-date">
            <DatePicker
              value={date}
              onChange={(d) => d && setDate(d)}
              format="DD-MM-YYYY"
              allowClear={false}
              placeholder="d-m-yy or d-m-yyyy"
            />
          </div>
        </div>

        <div className="be-vh-fld">
          <span className="be-k">Payment # <span className="hint">· next auto</span></span>
          <Input
            className="be-vh-recpt"
            value={nextPayNo || 'Loading…'}
            readOnly
          />
        </div>

        <div className="be-vh-tag">
          <span className="dir">↑</span>
          <span className="t">Supplier Payment</span>
        </div>
      </div>

      {/* ── SPLIT BODY ── */}
      <div className="be-body">

        {/* LEFT FORM */}
        <div className="be-left">

          <div className="be-fld">
            <label className="be-lbl">Supplier <span className="hint">F4 to search</span></label>
            <Select
              showSearch
              placeholder="Search supplier..."
              optionFilterProp="children"
              style={{ width: '100%' }}
              onChange={handlePartyChange}
              value={selectedParty?.party_id}
            >
              {parties.map(p => (
                <Select.Option key={p.party_id} value={p.party_id}>{p.party_name}</Select.Option>
              ))}
            </Select>
          </div>

          {selectedParty && (
            <div className="be-bal-card">
              <span className="who">{selectedParty.party_name}</span>
              <div className="amt">
                {rupee(Math.abs(parseFloat(selectedParty.current_balance || 0)))}
                <span className="s">Payable</span>
              </div>
            </div>
          )}

          <div className="be-fld">
            <label className="be-lbl">Invoice Nos.</label>
            <Input value={selectedInvNos} readOnly placeholder="Auto-filled from selected bills →" />
          </div>

          <hr className="be-sep"/>

          <div className="be-fld">
            <label className="be-lbl">Pay Amount (₹)</label>
            <InputNumber
              ref={payAmtRef}
              className="be-big"
              keyboard={false}
              value={payAmt}
              onChange={handlePayAmtChange}
              min={0}
              max={maxPayAmt || undefined}
              placeholder="Enter amount"
              style={{ width: '100%' }}
              formatter={v => v != null && v !== '' ? `₹ ${v}`.replace(/\B(?=(\d{3})+(?!\d))/g, ',') : ''}
              parser={v => v.replace(/₹\s?|(,*)/g, '')}
            />
            {maxPayAmt > 0 && (
              <div className="be-hint-below">Max: ₹ {fmt2(maxPayAmt)}</div>
            )}
          </div>

          <div className="be-fld">
            <label className="be-lbl">Payment Mode</label>
            <Select value={payMode} onChange={setPayMode} style={{ width: '100%' }}>
              {MODES.map(m => <Select.Option key={m} value={m}>{m}</Select.Option>)}
            </Select>
          </div>

          <div className="be-row-2">
            <div className="be-fld">
              <label className="be-lbl">Discount Taken (₹)</label>
              <InputNumber
                keyboard={false}
                value={discAmt}
                onChange={v => setDiscAmt(v || 0)}
                min={0}
                style={{ width: '100%' }}
                formatter={v => `₹ ${v}`.replace(/\B(?=(\d{3})+(?!\d))/g, ',')}
                parser={v => v.replace(/₹\s?|(,*)/g, '')}
              />
            </div>
            <div className="be-fld">
              <label className="be-lbl">Ref / Pay No.</label>
              <Input value={payNo} onChange={e => setPayNo(e.target.value)} placeholder="Cheque / UTR / Ref no." />
            </div>
          </div>

        </div>

        {/* RIGHT — bills table */}
        <div className="be-right">

          <div className="be-grid-head">
            <span>Bill No.</span>
            <span>Date</span>
            <span className="r">Net Amt</span>
            <span className="r">Balance</span>
            <Tooltip title={allChecked ? 'Deselect all' : 'Select all'}>
              <button
                className={`be-toggle-all${allChecked ? ' on' : ''}`}
                onClick={toggleAll}
                disabled={bills.length === 0}
              >
                {allChecked ? <MinusOutlined /> : <CheckOutlined />}
              </button>
            </Tooltip>
            <span className="r">Paying Now</span>
            <span className="c">Age</span>
          </div>

          <div className="be-rows">
            {billsWithAlloc.length === 0 ? (
              <div className="be-empty">
                {selectedParty ? 'No outstanding bills for this supplier' : 'Select a supplier to see outstanding bills'}
              </div>
            ) : billsWithAlloc.map((bill, idx) => {
              const netAmt = parseFloat(bill.total_amount || 0);
              const balance = parseFloat(bill.balance_amount || 0);
              const isPartiallyPaid = netAmt > balance;
              const alloc = bill.allocated || 0;
              const rem = parseFloat((balance - alloc).toFixed(2));
              const fullPaid = bill.checked && alloc > 0 && rem === 0;
              const partial = bill.checked && alloc > 0 && rem > 0;
              const rowClass = [
                'be-row',
                bill.isOpening ? 'opening' : '',
                fullPaid ? 'checked' : partial ? 'partial' : '',
                idx % 2 === 1 && !bill.isOpening && !fullPaid && !partial ? 'alt' : '',
              ].filter(Boolean).join(' ');

              return (
                <div
                  key={bill.purchase_bill_id}
                  className={rowClass}
                  onClick={() => !bill.checked && toggleBill(idx, true)}
                >
                  <span className="bn">{bill.bill_number}</span>
                  <span className="dt">{dayjs(bill.bill_date || bill.created_at).format('DD-MM-YY')}</span>
                  <span className="amt">
                    ₹ {fmt2(netAmt)}
                    {isPartiallyPaid && (
                      <span className="sub" style={{ color: 'var(--success)' }}>Pd: ₹ {fmt2(netAmt - balance)}</span>
                    )}
                  </span>
                  <span className={`amt bal${partial ? ' partial' : ''}`}>
                    ₹ {fmt2(balance)}
                    {partial && <span className="sub">After: ₹ {fmt2(rem)}</span>}
                  </span>
                  <span style={{ display: 'flex', justifyContent: 'center' }} onClick={e => e.stopPropagation()}>
                    <Checkbox checked={bill.checked} onChange={e => toggleBill(idx, e.target.checked)} />
                  </span>
                  <span className={`amt${fullPaid ? ' paid' : partial ? ' partial' : ''}`}>
                    {bill.checked && alloc > 0
                      ? <>₹ {fmt2(alloc)}</>
                      : <span className="dash">—</span>}
                  </span>
                  {renderAge(bill)}
                </div>
              );
            })}
          </div>
        </div>
      </div>

      {/* ── BOTTOM ACTION BAR ── */}
      <div className="be-action-bar">
        <div className="totals">
          {checkedBills.length > 0 ? (
            <>
              <span><span className="k">Bills</span><b>{checkedBills.length}</b></span>
              <span><span className="k">Max</span><b>{rupee(maxPayAmt)}</b></span>
              {payAmt > 0 && <span><span className="k">Paying</span><b className="paid">{rupee(payAmt)}</b></span>}
              {discAmt > 0 && <span><span className="k">Disc</span><b className="disc">{rupee(discAmt)}</b></span>}
              <span><span className="k">Net</span><b className="net">{rupee(netAmount)}</b></span>
            </>
          ) : (
            <span style={{ color: 'var(--fg-tertiary)' }}>Tick bills to allocate this payment</span>
          )}
        </div>
        <div className="buttons">
          <Button
            className="be-btn"
            icon={<ArrowLeftOutlined />}
            onClick={() => confirmLeave(() => navigate('/payments'))}
          >
            Back
          </Button>
          <Button className="be-btn" icon={<ReloadOutlined />} onClick={handleReset}>Reset</Button>
          <Button
            className="be-btn be-primary"
            icon={<CheckCircleOutlined />}
            loading={loading}
            onClick={handleSave}
          >
            Save Payment<span className="kbd">F1</span>
          </Button>
        </div>
      </div>
    </div>
  );
}
