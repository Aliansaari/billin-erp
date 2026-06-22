import React, { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { Input, DatePicker, Select, Button, InputNumber, message, Checkbox, Modal, Tooltip } from 'antd';
import {
  CheckOutlined, MinusOutlined,
} from '@ant-design/icons';
import { inrFormatter, inrParser } from '../../utils/indianFormat';
import { useLocation, useNavigate, useParams } from 'react-router-dom';
import dayjs from 'dayjs';
import { paymentAPI, partyAPI, whatsappAPI } from '../../api';
import { printDocument, shareBillViaWhatsApp } from '../../services/printer';
import confirmPrint, { confirmPrintWithSend } from '../../utils/confirmPrint';
import { useUnsavedChangesWarning } from '../../hooks/useUnsavedChangesWarning';
import useBack from '../../hooks/useBack';
import BankLedgerSelect from '../../components/BankLedgerSelect';
import ActionStrip from '../../components/keyboard/ActionStrip';
import { useDatePopup } from '../../components/keyboard/DatePopup';
import { useFiscalLockGuard, isFiscalLockCancel } from '../../hooks/useFiscalLockGuard';
import FiscalLockOverrideModal from '../../components/FiscalLockOverrideModal';
import { partySelectProps } from '../../utils/partySelectProps';
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
  // Edit mode — when /receipt/edit/:id is the route, load the receipt and
  // switch the save action to paymentAPI.update() (Audit C4 endpoint).
  const { id: editId } = useParams();
  const isEdit = !!editId;
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
  // Cheque date — only meaningful when payMode === 'Cheque'. Defaults
  // to the receipt date so a same-day cheque doesn't need an extra
  // click; future-dated cheques (PDCs) override this.
  const [chequeDate, setChequeDate]       = useState(null);
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
  const goBack = useBack('/payments');
  const { openDate } = useDatePopup();

  // Fiscal-lock override flow — same hook the Payment form uses.
  const { lockModal, guardedSave } = useFiscalLockGuard({
    onBlocked: (msg) => message.error(msg),
  });

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

  // Edit mode load — when /receipt/edit/:id, hydrate the form from the
  // existing receipt so the operator can adjust fields and re-save.
  // Re-uses the same handlePartyChange + checkedBills state machinery
  // the create-flow uses; on Save we route to paymentAPI.update() instead
  // of create(). The cancelled-or-auto guards on the backend (audit C4)
  // also surface as 400s if a stale tab tries to edit an auto-receipt.
  const editLoadedRef = useRef(false);
  useEffect(() => {
    if (!isEdit) return;
    if (editLoadedRef.current) return;
    if (!parties.length) return;
    editLoadedRef.current = true;
    (async () => {
      try {
        const { data: r } = await paymentAPI.getById(editId);
        if (r.is_cancelled) {
          message.error('This receipt is cancelled. Create a new one instead of editing.');
          navigate('/payments');
          return;
        }
        if (r.source === 'auto_from_bill') {
          message.error('Auto-receipts are managed by the source bill. Edit the bill instead.');
          navigate('/payments');
          return;
        }
        // Hydrate header fields.
        setDate(dayjs(r.transaction_date));
        setPayNo(r.transaction_number || '');
        // Pick the primary split if there are multiple modes (rare).
        const split = (r.splits || [])[0] || {};
        setPayMode(split.payment_mode || r.payment_method || 'Cash');
        setBankLedgerId(split.bank_ledger_id || r.bank_ledger_id || null);
        if (split.cheque_date) setChequeDate(dayjs(split.cheque_date));
        setPayAmt(parseFloat(r.total_amount) || 0);
        // Trigger party flow so bills load and we can re-tick allocations.
        await handlePartyChange(r.party_id);
        // The allocations on the saved receipt are restored after the
        // unpaid-bills list arrives. We let handlePartyChange resolve first,
        // then a follow-up effect (below) re-ticks based on r.bill_allocations.
        if (Array.isArray(r.bill_allocations)) {
          // Store the saved allocations on a ref so the bills-loaded effect
          // can pick them up exactly once.
          savedAllocsRef.current = r.bill_allocations;
        }
      } catch (e) {
        message.error(e.response?.data?.error || 'Failed to load receipt');
        navigate('/payments');
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isEdit, editId, parties]);
  const savedAllocsRef = useRef(null);

  const handlePartyChange = async (partyId) => {
    // Optimistic: show the party name immediately from local cache.
    const localParty = parties.find(p => p.party_id === partyId) || null;
    setSelectedParty(localParty);
    setBills([]);
    setPayAmt(null);
    try {
      // Fetch fresh party data and unpaid bills in parallel.
      // Fresh party is needed so current_balance reflects the server state
      // AFTER the last save — the local `parties` array is only loaded once
      // on mount and would show a stale balance otherwise (Bug #1 fix).
      const [partyRes, billsRes] = await Promise.all([
        partyAPI.getById(partyId),
        paymentAPI.getUnpaidBills({ party_id: partyId, type: 'Sales' }),
      ]);
      const party = partyRes.data || localParty;
      setSelectedParty(party);

      // Audit L4 — in edit mode, re-tick only the bills that were previously
      // allocated by this receipt (read from savedAllocsRef.current). New-
      // receipt flow keeps the default-check-all behaviour. Allocations
      // store amounts; we also pin those amounts as the "tick value" so
      // the operator sees what was originally allocated.
      const savedAllocs = savedAllocsRef.current; // Map[bill_id => amount] or array
      const isEditFlow = isEdit && Array.isArray(savedAllocs) && savedAllocs.length > 0;
      const allocLookup = {};
      if (isEditFlow) {
        for (const a of savedAllocs) {
          if (a && a.bill_id) {
            allocLookup[Number(a.bill_id)] = parseFloat(a.amount) || 0;
          }
        }
        // Consume so a subsequent party-change doesn't re-apply old allocs.
        savedAllocsRef.current = null;
      }
      const rows = (billsRes.data || []).map(b => {
        const hadAlloc = isEditFlow ? allocLookup[Number(b.sales_bill_id)] : undefined;
        return {
          ...b,
          // In edit mode: tick only the bills the original receipt allocated.
          checked: isEditFlow ? hadAlloc > 0 : true,
          // Surface the original allocation amount so the operator can see
          // how the receipt was distributed before changing it.
          alloc_amount: hadAlloc || 0,
          dueDays: b.bill_date ? dayjs().diff(dayjs(b.bill_date), 'day') : 0,
        };
      });
      // Remaining opening balance row — only shown when the party has a
      // Receivable opening balance with some still unpaid. Two guards:
      //   1. opening_balance_type must be 'Receivable'
      //   2. remainingOB capped at the party's original opening_balance
      // derivedOB = current_balance − sum(open bill balances). This is the
      // plug that keeps (bills + OB row) === current_balance, so MAX always
      // equals the party's true receivable. Receipts the user applied to the
      // opening balance reduce current_balance, which correctly shrinks this.
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
  const selectedInvNos = billsWithAlloc
    .filter(b => b.allocated > 0 && !b.isOpening)
    .map(b => b.bill_number).join(', ');

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
    setChequeDate(null);
    setPayAmt(null);
    setDiscAmt(0);
    // Ready for the next receipt — focus the customer box, not the amount.
    setTimeout(() => partyRef.current?.focus(), 60);
  };

  const handleSave = useCallback(async () => {
    if (submittingRef.current) return;
    if (!selectedParty) { message.warning('Select a customer first'); return; }
    if (!payAmt || payAmt <= 0) { message.warning('Enter an amount'); return; }
    if (netAmount <= 0) { message.warning('Net amount must be greater than 0'); return; }

    const refBill = checkedBills.find(b => !b.isOpening);
    const bill_allocations = billsWithAlloc
      .filter(b => !b.isOpening && b.allocated > 0)
      .map(b => ({ bill_id: b.sales_bill_id, bill_type: 'Sales', amount: b.allocated, bill_number: b.bill_number }));

    // Opening balance allocation — include as a sentinel entry so the server's
    // reconcileBillsForParty absorbs this amount without FIFO-applying it to
    // regular bills. Without this, the receipt would be distributed to the
    // oldest bills even when the user explicitly chose the opening balance row.
    const obBill = checkedBills.find(b => b.isOpening);
    const obAlloc = obBill ? parseFloat(obBill.allocated) || 0 : 0;
    if (obAlloc > 0) {
      bill_allocations.push({ bill_id: null, bill_type: 'OpeningBalance', amount: obAlloc });
    }
    // obAlloc is now included in bill_allocations (as the OpeningBalance sentinel),
    // so don't add it again — the reduce already covers it.
    const sumAllocated = bill_allocations.reduce((s, a) => s + parseFloat(a.amount || 0), 0);
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
      const body = {
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
          // Cheque-mode receipts persist the cheque number AND date so
          // the bank reconciliation / cheque register can flag PDCs
          // and reconcile clearance. Cheque date defaults to today.
          ...(payMode === 'Cheque' && payNo
            ? { cheque_number: payNo, cheque_date: (chequeDate || date).format('YYYY-MM-DD') }
            : {}),
        }],
        bill_allocations,
      };
      const result = await guardedSave(body, (b) => (
        isEdit ? paymentAPI.update(editId, b).then(r => r.data) : paymentAPI.create(b).then(r => r.data)
      ));
      const txnNum = result.transaction_number;
      const txnId  = result.transaction_id;
      message.success(
        isEdit
          ? `Receipt updated → new number ${txnNum} (original cancelled in audit trail). ✓`
          : `Receipt ${txnNum} saved! ✓`,
      );

      // ── Print prompt: show the customer's remaining balance + offer to
      // send the receipt on WhatsApp (same pattern as the sales bill). The
      // balance is fetched fresh so it reflects the server's post-receipt
      // figure (after allocation / on-account surplus). ──
      let remaining = '';
      try {
        const resp = await partyAPI.getById(selectedParty.party_id);
        const p = resp.data?.data || resp.data;
        const bal = Number(p?.current_balance || 0);
        const amt = Math.abs(bal).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
        remaining = Math.abs(bal) < 0.01
          ? 'Account fully settled ✓'
          : (bal > 0 ? `Remaining balance: ₹${amt} Dr (still due)` : `Now in credit: ₹${amt} Cr (advance)`);
      } catch { /* balance line is optional */ }

      let waEnabled = false, waDefault = false;
      try {
        const { data: st } = await whatsappAPI.status();
        waEnabled = !!(st && st.enabled && st.state === 'connected');
        waDefault = !!(st && st.auto_send_default);
      } catch { /* WhatsApp off / unreachable — prompt stays print-only */ }

      const { print, whatsapp } = await confirmPrintWithSend(
        `Print Receipt ${txnNum}?`,
        { content: remaining || 'Do you want to print it now?', whatsappEnabled: waEnabled, whatsappDefault: waDefault },
      );
      if (print) printDocument({ docType: 'receipt', id: txnId });
      if (whatsapp) shareBillViaWhatsApp({ docType: 'receipt', id: txnId });

      if (isEdit) {
        // replace (not push) so the saved receipt isn't left in history —
        // stops Back from the list looping back into this edit form.
        navigate('/payments', { replace: true });
      } else {
        handleReset();
        refreshNextNumber();
        // Refresh the customer list so the dropdown's Balance column shows
        // the post-receipt figure. Without this the list (loaded once on
        // mount) keeps showing the pre-receipt balance until the page is
        // reopened — re-selecting the same customer looked "not updated".
        loadParties();
      }
    } catch (e) {
      if (isFiscalLockCancel(e)) return;
      message.error(e.response?.data?.message || e.response?.data?.error || 'Failed to save receipt');
    } finally {
      setLoading(false);
      submittingRef.current = false;
    }
  }, [selectedParty, payAmt, netAmount, date, payMode, bankLedgerId, payNo, chequeDate, checkedBills, selectedInvNos, billsWithAlloc, isEdit, editId, navigate]);

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
              optionFilterProp="label"
              style={{ width: '100%' }}
              onChange={handlePartyChange}
              value={selectedParty?.party_id}
              {...partySelectProps(parties, 'Customer')}
            />
          </div>

          {selectedParty && (() => {
            const bal = parseFloat(selectedParty.current_balance || 0);
            return (
              <div className="be-bal-card">
                <span className="who">{selectedParty.party_name}</span>
                <div className="amt">
                  {rupee(Math.abs(bal))}
                  <span className="s">{bal >= 0 ? 'Receivable' : 'Payable'}</span>
                </div>
              </div>
            );
          })()}

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
              formatter={v => v != null && v !== '' ? inrFormatter(v) : ''}
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
                formatter={v => inrFormatter(v)}
                parser={v => v.replace(/₹\s?|(,*)/g, '')}
              />
            </div>
            <div className="be-fld">
              <label className="be-lbl">
                {payMode === 'Cheque' ? 'Cheque No.' : 'Ref / Pay No.'}
              </label>
              <Input
                value={payNo}
                onChange={e => setPayNo(e.target.value)}
                placeholder={payMode === 'Cheque' ? 'Cheque number' : 'UTR / Ref no.'}
              />
            </div>
          </div>

          {/* Cheque date — appears only when payment mode is Cheque.
              Persisted on the payment_split row so bank reconciliation
              + the cheque register show the cheque-face date and can
              flag PDCs at a glance. Defaults to receipt date so
              same-day cheques save with one less keystroke. */}
          {payMode === 'Cheque' && (
            <div className="be-fld">
              <label className="be-lbl">
                Cheque Date
                {chequeDate && date && chequeDate.isAfter(date, 'day') && (
                  <span style={{
                    marginLeft: 8,
                    padding: '1px 7px',
                    borderRadius: 4,
                    background: 'rgba(168, 85, 247, 0.12)',
                    color: '#7E22CE',
                    border: '1px solid rgba(168, 85, 247, 0.20)',
                    fontSize: 10,
                    fontWeight: 700,
                    letterSpacing: '0.5px',
                  }}>PDC</span>
                )}
              </label>
              <DatePicker
                value={chequeDate || date}
                onChange={(d) => setChequeDate(d)}
                format="DD-MM-YYYY"
                allowClear={false}
                style={{ width: '100%' }}
                placeholder="d-m-yy or d-m-yyyy"
              />
            </div>
          )}

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
          { id: 'back', key: 'Esc', label: 'Back', historyBack: false,
            onAction: () => confirmLeave(goBack) },
          { id: 'reset', key: 'F5', label: 'Reset',
            onAction: handleReset },
          { id: 'date', key: 'F2', label: 'Date',
            onAction: () => openDate({
              title: 'Receipt Date',
              value: date,
              onConfirm: (d) => setDate(d),
            }),
            title: 'Open the smart-input date popup' },
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

      <FiscalLockOverrideModal
        open={!!lockModal}
        lock={lockModal?.lock}
        billDate={date}
        vouchTypeLabel="Receipt"
        onConfirm={lockModal?.onConfirm}
        onCancel={lockModal?.onCancel}
      />
    </div>
  );
}
