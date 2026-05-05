import React, { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { Input, DatePicker, Select, Button, InputNumber, message, Checkbox, Modal, Tooltip } from 'antd';
import {
  CheckOutlined, MinusOutlined,
} from '@ant-design/icons';
import { useLocation, useNavigate } from 'react-router-dom';
import dayjs from 'dayjs';
import { paymentAPI, partyAPI } from '../../api';
import { useUnsavedChangesWarning } from '../../hooks/useUnsavedChangesWarning';
import BankLedgerSelect from '../../components/BankLedgerSelect';
import ActionStrip from '../../components/keyboard/ActionStrip';
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

export default function ReceiptEntry() {
  const navigate = useNavigate();
  const location = useLocation();
  // Preselect payload from the Sales List "Record receipt" menu — arrives as
  // { party_id, bill_id }. We auto-pick the party once the parties list loads
  // and scroll/highlight the specific bill if present.
  const preselect = location.state?.preselect;
  const [parties, setParties]             = useState([]);
  const [selectedParty, setSelectedParty] = useState(null);
  const [bills, setBills]                 = useState([]);
  const [date, setDate]                   = useState(dayjs());
  const [payMode, setPayMode]             = useState('Cash');
  // Selected bank ledger ID — only meaningful for non-cash modes. See
  // BankLedgerSelect for the smart-default logic; the form simply
  // forwards the chosen id into the split payload.
  const [bankLedgerId, setBankLedgerId]   = useState(null);
  const [payNo, setPayNo]                 = useState('');
  const [payAmt, setPayAmt]               = useState(null);
  const [discAmt, setDiscAmt]             = useState(0);
  const [loading, setLoading]             = useState(false);
  const [dueDaysMode, setDueDaysMode]     = useState('bill_date');
  // Receipt number preview — fetched from the server on mount and refreshed
  // after each save so the user sees the real next number (REC-000046), not
  // a generic "Auto" placeholder. The actual number is still generated
  // atomically on the server inside the create() transaction.
  const [nextRecpt, setNextRecpt]         = useState('');

  const dirty = !!(selectedParty || payAmt);
  const confirmLeave = useUnsavedChangesWarning(dirty);

  const payAmtRef        = useRef(null);
  const partyRef         = useRef(null);
  // F2 = Date, F4 = Find (party). Wires up the previously-decorative
  // "Date · F2" and "F4 to search" UI hints to the bottom ActionStrip.
  const dateRef          = useRef(null);
  const handleSaveRef    = useRef(null);
  const submittingRef    = useRef(false);

  const refreshNextNumber = async () => {
    try {
      const { data } = await paymentAPI.nextNumber('Receipt');
      setNextRecpt(data?.next || '');
    } catch (_) {}
  };

  useEffect(() => {
    loadParties();
    refreshNextNumber();
    setDueDaysMode(localStorage.getItem('sale_due_days_mode') || 'bill_date');
    // Open with the customer search focused. Amount focus is moved later
    // inside handlePartyChange once a party is picked.
    setTimeout(() => partyRef.current?.focus(), 100);
    // F1 Save · F2 Date · F4 Find · F5 Reset · F6 Amount · Esc Back —
    // all owned by the bottom <ActionStrip>. The legacy F1 listener
    // here is replaced by the strip's registry-driven keyboard handler.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const loadParties = async () => {
    try {
      const { data } = await partyAPI.getCustomers({ limit: 1000 });
      setParties((data.data || []).filter(p => p.is_active !== false));
    } catch (_) {}
  };

  // Once parties load, apply the preselect from the Sales List "Record receipt"
  // action. handlePartyChange needs the parties array populated because it
  // does a .find() on it — so this effect runs after setParties resolves.
  // Guarded by a ref so a stale re-render can't re-trigger after the user
  // has manually changed the party.
  const preselectApplied = useRef(false);
  useEffect(() => {
    if (preselectApplied.current) return;
    if (!preselect?.party_id) return;
    if (!parties.length) return;
    preselectApplied.current = true;
    handlePartyChange(preselect.party_id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [parties, preselect]);

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
      // Remaining opening balance row — only shown when the party has a
      // Receivable opening balance with some still unpaid. Two guards:
      //   1. opening_balance_type must be 'Receivable'
      //   2. remainingOB capped at the party's original opening_balance
      const billsTotal    = rows.reduce((s, b) => s + parseFloat(b.balance_amount || 0), 0);
      const partyBal      = parseFloat(party?.current_balance || 0);
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
          total_amount:   remainingOB,
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

  // Master select/deselect — toggles every row in one click.
  const allChecked = bills.length > 0 && bills.every(b => b.checked);
  const toggleAll = () => {
    const next = !allChecked;
    setBills(prev => prev.map(b => ({ ...b, checked: next })));
  };

  // Max Receivable = min(sum of ticked bill balances, party's current
  // outstanding). Using party.current_balance as the upper bound prevents
  // the "phantom balance" case where bill.balance_amount drifted higher
  // than the party actually owes.
  const maxPayAmt = useMemo(() => {
    const sumTicked = bills.filter(b => b.checked).reduce((s, b) => s + parseFloat(b.balance_amount || 0), 0);
    const partyBal  = parseFloat(selectedParty?.current_balance || 0);
    if (partyBal > 0) return Math.min(sumTicked, partyBal);
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
    // Bank: snap to null on reset; BankLedgerSelect will re-pick the
    // last-used bank when the operator switches mode away from Cash.
    setBankLedgerId(null);
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
    const bill_allocations = billsWithAlloc
      .filter(b => !b.isOpening && b.allocated > 0)
      .map(b => ({ bill_id: b.sales_bill_id, bill_type: 'Sales', amount: b.allocated }));

    // On-account guard — either nothing ticked, or ticked bills < received.
    // Either way the server will FIFO-apply the surplus, but we warn first.
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
            : `Ticked bills cover ₹${fmt2(sumAllocated)}, but you are receiving ₹${fmt2(netAmount)}. ` +
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
        transaction_type:    'Receipt',
        transaction_date:    date.format('YYYY-MM-DD'),
        party_id:            selectedParty.party_id,
        total_amount:        netAmount,
        reference_bill_id:   refBill?.sales_bill_id || null,
        reference_bill_type: refBill ? 'Sales' : null,
        remarks:             selectedInvNos ? `Bills: ${selectedInvNos}` : payNo,
        splits: [{
          payment_mode:   payMode,
          amount:         netAmount,
          // Same convention as PaymentEntry — only attach the bank FK
          // for non-cash splits.
          ...(payMode !== 'Cash' && bankLedgerId ? { bank_ledger_id: bankLedgerId } : {}),
        }],
        bill_allocations,
      });
      message.success(`Receipt ${result.transaction_number} saved! ✓`);
      handleReset();
      refreshNextNumber();
    } catch (e) {
      message.error(e.response?.data?.error || 'Failed to save receipt');
    } finally {
      setLoading(false);
      submittingRef.current = false;
    }
  }, [selectedParty, payAmt, netAmount, date, payMode, bankLedgerId, payNo, checkedBills, selectedInvNos, billsWithAlloc]);

  handleSaveRef.current = handleSave;

  // ── Per-row age display ─────────────────────────────────────────────
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
    <div className="be-page">

      {/* ── COMPACT HEADER ── */}
      <div className="be-vh">
        <div className="be-vh-fld">
          <span className="be-k">Date</span>
          <div className="be-vh-date">
            <DatePicker
              ref={dateRef}
              value={date}
              onChange={(d) => d && setDate(d)}
              format="DD-MM-YYYY"
              allowClear={false}
              placeholder="d-m-yy or d-m-yyyy"
            />
          </div>
        </div>

        <div className="be-vh-fld">
          <span className="be-k">Receipt # <span className="hint">· next auto</span></span>
          <Input
            className="be-vh-recpt"
            value={nextRecpt || 'Loading…'}
            readOnly
          />
        </div>

        <div className="be-vh-tag">
          <span className="dir">↓</span>
          <span className="t">Customer Receipt</span>
        </div>
      </div>

      {/* ── SPLIT BODY ── */}
      <div className="be-body">

        {/* LEFT FORM */}
        <div className="be-left">

          <div className="be-fld">
            <label className="be-lbl">Customer</label>
            <Select
              ref={partyRef}
              showSearch
              placeholder="Search customer..."
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
                {rupee(selectedParty.current_balance)}
                <span className="s">Receivable</span>
              </div>
            </div>
          )}

          <div className="be-fld">
            <label className="be-lbl">Invoice Nos.</label>
            <Input value={selectedInvNos} readOnly placeholder="Auto-filled from selected bills →" />
          </div>

          <hr className="be-sep"/>

          <div className="be-fld">
            <label className="be-lbl">Receive Amount (₹)</label>
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

          {/* Bank picker — only for non-cash modes. The receipt posts to
              this bank's ledger so it surfaces in the bank's statement
              + reconciliation views. */}
          {payMode !== 'Cash' && (
            <div className="be-fld">
              <label className="be-lbl">Bank</label>
              <BankLedgerSelect
                value={bankLedgerId}
                onChange={setBankLedgerId}
                mode={payMode}
                style={{ width: '100%' }}
              />
            </div>
          )}

          <div className="be-row-2">
            <div className="be-fld">
              <label className="be-lbl">Discount (₹)</label>
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
                {selectedParty ? 'No outstanding bills for this customer' : 'Select a customer to see outstanding bills'}
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
                  key={bill.sales_bill_id}
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

      {/* ── TOTALS ROW ── visual-only summary above the strip. */}
      <div className="be-action-bar be-totals-only">
        <div className="totals">
          {checkedBills.length > 0 ? (
            <>
              <span><span className="k">Bills</span><b>{checkedBills.length}</b></span>
              <span><span className="k">Max</span><b>{rupee(maxPayAmt)}</b></span>
              {payAmt > 0 && <span><span className="k">Receiving</span><b className="paid">{rupee(payAmt)}</b></span>}
              {discAmt > 0 && <span><span className="k">Disc</span><b className="disc">{rupee(discAmt)}</b></span>}
              <span><span className="k">Net</span><b className="net">{rupee(netAmount)}</b></span>
            </>
          ) : (
            <span style={{ color: 'var(--fg-tertiary)' }}>Tick bills to allocate this receipt</span>
          )}
        </div>
      </div>

      {/* ── ACTION STRIP ── F2 Date / F4 Find finally wire the
          previously-decorative "Date · F2" and "F4 to search" hints
          to actual handlers via the bottom strip. */}
      <ActionStrip
        actions={[
          { id: 'back', key: 'Esc', label: 'Back',
            onAction: () => confirmLeave(() => navigate('/payments')) },
          { id: 'reset', key: 'F5', label: 'Reset',
            onAction: handleReset },
          { id: 'date', key: 'F2', label: 'Date',
            onAction: () => dateRef.current?.focus?.(),
            title: 'Focus the Date field' },
          { id: 'find', key: 'F4', label: 'Find',
            onAction: () => partyRef.current?.focus?.(),
            title: 'Focus the customer search' },
          { id: 'amount', key: 'F6', label: 'Amount',
            onAction: () => {
              const inst = payAmtRef.current;
              if (!inst) return;
              inst.focus?.();
              setTimeout(() => inst.select?.(), 0);
            },
            title: 'Jump to Receipt Amount' },
          { id: 'save', key: 'F1', label: 'Save Receipt', tone: 'primary',
            disabled: loading,
            onAction: handleSave },
          // Hidden alias: Ctrl+Enter mirrors F1.
          { id: 'save-alt', key: 'Ctrl+Enter', label: '',
            hidden: true, disabled: loading,
            onAction: handleSave },
        ]}
      />
    </div>
  );
}
