/* ─────────────────────────────────────────────────────────────────────
 * VoucherForm — shared mobile form for /receipt/new and /payment/new
 *
 * Per the editorial mockup: party pill, big Fraunces hero amount with
 * quick pills, "Apply to bills" allocation list, sticky footer with
 * mode tabs (Cash/UPI/Bank/Cheque) and Save. `type` switches the
 * direction (Receipt vs Payment), accent color, party kind, bill kind,
 * and create endpoint label.
 * ─────────────────────────────────────────────────────────────────── */
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Toast } from 'antd-mobile';
import { Capacitor } from '@capacitor/core';
import { paymentAPI, bankAPI } from '../../api';
import { formatINR } from '../utils/format';
import PartySheet from '../components/PartySheet';
import './VoucherForm.css';

const BackIcon = () => (
  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M19 12H5M12 19l-7-7 7-7"/></svg>
);
const MoreIcon = () => (
  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round"><circle cx="12" cy="5" r="1.5"/><circle cx="12" cy="12" r="1.5"/><circle cx="12" cy="19" r="1.5"/></svg>
);
const ChevR = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M9 18l6-6-6-6"/></svg>
);
const CheckIcon = () => (
  <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3.5" strokeLinecap="round" strokeLinejoin="round"><path d="M20 6L9 17l-5-5"/></svg>
);
const PartialIcon = () => (
  <svg width="9" height="9" viewBox="0 0 24 24" fill="currentColor"><rect x="5" y="11" width="14" height="2" rx="1"/></svg>
);
const ArrowRight = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><path d="M5 12h14M13 6l6 6-6 6"/></svg>
);

function todayISO() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function daysSince(dateStr) {
  if (!dateStr) return 0;
  const d = new Date(dateStr);
  const now = new Date();
  return Math.floor((now - d) / (1000 * 60 * 60 * 24));
}

function fmtDate(dateStr) {
  if (!dateStr) return '';
  const d = new Date(dateStr);
  const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  return `${d.getDate()} ${months[d.getMonth()]} ${d.getFullYear() % 100}`;
}

const MODES = ['Cash', 'UPI', 'Bank Transfer', 'Cheque'];
const MODE_LABELS = { 'Cash': 'Cash', 'UPI': 'UPI', 'Bank Transfer': 'Bank', 'Cheque': 'Cheque' };

export default function VoucherForm({ type }) {
  const navigate = useNavigate();
  const isReceipt = type === 'Receipt';
  const partyKind = isReceipt ? 'customer' : 'supplier';
  const billKey   = isReceipt ? 'sales_bill_id' : 'purchase_bill_id';
  const billType  = isReceipt ? 'Sales' : 'Purchase';

  const [party, setParty]         = useState(null);
  const [bills, setBills]         = useState([]);
  const [allocs, setAllocs]       = useState({}); // {bill_id: amount}
  const [amount, setAmount]       = useState('');
  const [mode, setMode]           = useState(isReceipt ? 'Cash' : 'UPI');
  const [banks, setBanks]         = useState([]);
  const [bankId, setBankId]       = useState(null);
  const [chequeNo, setChequeNo]   = useState('');
  const [chequeDate, setChequeDate] = useState('');
  const [partyOpen, setPartyOpen] = useState(false);
  const [saving, setSaving]       = useState(false);
  const [voucherNo, setVoucherNo] = useState('');

  // Voucher number (Rec / Pay)
  useEffect(() => {
    paymentAPI.nextNumber(type)
      .then((r) => setVoucherNo(r.data?.next_number || r.data?.number || ''))
      .catch(() => {});
  }, [type]);

  // Load banks once — used when mode is non-cash.
  useEffect(() => {
    bankAPI.list()
      .then((r) => {
        const list = r.data?.banks || (Array.isArray(r.data) ? r.data : r.data?.data) || [];
        setBanks(list);
        if (list[0]) setBankId(list[0].ledger_id || list[0].id);
      })
      .catch(() => {});
  }, []);

  // When party changes, fetch their unpaid bills.
  useEffect(() => {
    if (!party) { setBills([]); setAllocs({}); return; }
    paymentAPI.getUnpaidBills({ party_id: party.party_id, type: billType })
      .then((r) => {
        const rows = Array.isArray(r.data) ? r.data : (r.data?.data || r.data?.bills || []);
        setBills(rows);
        setAllocs({});
      })
      .catch(() => { setBills([]); setAllocs({}); });
  }, [party, billType]);

  const partyOutstanding = useMemo(
    () => bills.reduce((s, b) => s + Number(b.balance_amount || 0), 0),
    [bills],
  );

  const allocatedTotal = useMemo(
    () => Object.values(allocs).reduce((s, v) => s + (Number(v) || 0), 0),
    [allocs],
  );

  const amountN = Number(amount) || 0;
  const allocatedCount = Object.values(allocs).filter((v) => Number(v) > 0).length;
  const remaining = Math.max(0, amountN - allocatedTotal);

  const setAlloc = (billId, val) => {
    setAllocs((prev) => {
      const next = { ...prev };
      const n = Number(val) || 0;
      if (n <= 0) delete next[billId];
      else next[billId] = n;
      return next;
    });
  };

  const toggleAlloc = (bill) => {
    const id = bill[billKey];
    const balance = Number(bill.balance_amount) || 0;
    if (allocs[id] != null) {
      setAlloc(id, 0);
      return;
    }
    // First-tap = allocate full bill balance up to whatever's left of the
    // typed amount. If amount hasn't been entered, just queue the bill balance
    // and bump the amount.
    const free = amountN > 0 ? Math.max(0, amountN - allocatedTotal) : balance;
    const give = amountN > 0 ? Math.min(balance, free) : balance;
    if (give > 0) {
      setAlloc(id, give);
      if (amountN === 0) setAmount(String(balance));
    } else {
      // amount fully consumed — allow allocation anyway (user can adjust)
      setAlloc(id, balance);
      setAmount(String(amountN + balance));
    }
  };

  // FIFO auto-fill — distribute the typed amount across oldest bills first.
  const autoFill = () => {
    if (amountN <= 0) {
      Toast.show({ content: 'Enter an amount first' });
      return;
    }
    let left = amountN;
    const next = {};
    const sorted = [...bills].sort(
      (a, b) => new Date(a.bill_date) - new Date(b.bill_date),
    );
    for (const b of sorted) {
      if (left <= 0) break;
      const id = b[billKey];
      const bal = Number(b.balance_amount) || 0;
      const give = Math.min(bal, left);
      if (give > 0) {
        next[id] = +give.toFixed(2);
        left -= give;
      }
    }
    setAllocs(next);
  };

  const handleSave = async () => {
    if (saving) return;
    if (!party) {
      Toast.show({ icon: 'fail', content: `Pick a ${partyKind}` });
      return;
    }
    if (amountN <= 0) {
      Toast.show({ icon: 'fail', content: 'Enter an amount' });
      return;
    }
    if (mode !== 'Cash' && !bankId) {
      Toast.show({ icon: 'fail', content: 'Pick a bank' });
      return;
    }
    if (mode === 'Cheque' && !chequeNo.trim()) {
      Toast.show({ icon: 'fail', content: 'Enter cheque number' });
      return;
    }
    if (allocatedTotal > amountN + 0.01) {
      Toast.show({ icon: 'fail', content: 'Allocated exceeds amount' });
      return;
    }

    const bill_allocations = Object.entries(allocs)
      .filter(([, v]) => Number(v) > 0)
      .map(([bill_id, amt]) => ({
        bill_id: Number(bill_id),
        bill_type: billType,
        amount: Number(amt),
      }));

    const body = {
      transaction_type: type,
      transaction_date: todayISO(),
      party_id: party.party_id,
      total_amount: amountN,
      remarks: '',
      splits: [{
        payment_mode: mode,
        amount: amountN,
        ...(mode !== 'Cash' && bankId ? { bank_ledger_id: bankId } : {}),
        ...(mode === 'Cheque' && chequeNo.trim() ? {
          cheque_number: chequeNo.trim(),
          cheque_date: chequeDate || todayISO(),
        } : {}),
      }],
      ...(bill_allocations.length ? { bill_allocations } : {}),
    };

    setSaving(true);
    try {
      const res = await paymentAPI.create(body);
      Toast.show({ icon: 'success', content: 'Saved' });
      const savedId = res.data?.payment_receipt_id || res.data?.id;
      if (savedId) {
        navigate(`/vouchers/${isReceipt ? 'receipt' : 'payment'}/${savedId}`, { replace: true });
      } else {
        navigate(-1);
      }
    } catch (e) {
      const msg = e?.response?.data?.error || e?.response?.data?.message || e?.message || 'Save failed';
      Toast.show({ icon: 'fail', content: msg });
    } finally {
      setSaving(false);
    }
  };

  // Lift footer above the iOS keyboard.
  useEffect(() => {
    const root = document.documentElement;
    const setKbd = (px) => root.style.setProperty('--vf-kbd-h', `${Math.max(0, px)}px`);
    let cleanup = () => {};
    if (Capacitor.isNativePlatform()) {
      let showH = null, hideH = null;
      import('@capacitor/keyboard').then(({ Keyboard }) => {
        Keyboard.addListener('keyboardWillShow', (info) => setKbd(info.keyboardHeight)).then((h) => { showH = h; });
        Keyboard.addListener('keyboardWillHide', () => setKbd(0)).then((h) => { hideH = h; });
      }).catch(() => {});
      cleanup = () => { showH?.remove?.(); hideH?.remove?.(); setKbd(0); };
    } else if (window.visualViewport) {
      const vv = window.visualViewport;
      const apply = () => setKbd(window.innerHeight - vv.height - vv.offsetTop);
      apply();
      vv.addEventListener('resize', apply);
      vv.addEventListener('scroll', apply);
      cleanup = () => { vv.removeEventListener('resize', apply); vv.removeEventListener('scroll', apply); setKbd(0); };
    }
    return cleanup;
  }, []);

  // Quick pills derived from outstanding balance.
  const quickPills = useMemo(() => {
    const pills = [];
    if (partyOutstanding >= 10000) pills.push(10000);
    if (partyOutstanding >= 50000) pills.push(50000);
    if (partyOutstanding >= 100000) pills.push(100000);
    return pills;
  }, [partyOutstanding]);

  const heroVerb = isReceipt ? 'Receiving' : 'Paying';
  const heroDir  = isReceipt ? 'from' : 'to';
  const balanceLabel = isReceipt ? 'outstanding' : 'payable';

  return (
    <div className={`vf-screen ${isReceipt ? 'vf-in' : 'vf-out'}`}>
      {/* Header */}
      <div className="vf-header">
        <button className="vf-icon-btn" onClick={() => navigate(-1)} aria-label="Back">
          <BackIcon />
        </button>
        <div className="vf-header-meta">
          {isReceipt ? 'REC' : 'PAY'} <span className="strong">{voucherNo || '—'}</span>
        </div>
        <button className="vf-icon-btn" aria-label="More">
          <MoreIcon />
        </button>
      </div>

      <div className="vf-content">
        {/* Party pill */}
        <button className="vf-party" onClick={() => setPartyOpen(true)}>
          <div className="vf-party-avatar">
            {party ? (party.party_name || '?').charAt(0).toUpperCase() : (isReceipt ? 'C' : 'S')}
          </div>
          <div className="vf-party-info">
            <div className="vf-party-name">
              {party ? party.party_name : `Tap to choose ${partyKind}`}
            </div>
            <div className="vf-party-balance">
              {party
                ? <><span className="strong">₹{formatINR(partyOutstanding)}</span> {balanceLabel} · {bills.length} bill{bills.length === 1 ? '' : 's'}</>
                : 'No party selected'}
            </div>
          </div>
          <div className="vf-party-chev"><ChevR /></div>
        </button>

        {/* Hero amount */}
        <div className="vf-hero">
          <div className="vf-hero-title">{heroVerb} <em>{heroDir}</em></div>
          <div className="vf-hero-amount-wrap">
            <input
              className="vf-hero-input"
              type="number"
              inputMode="decimal"
              placeholder="0"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
            />
          </div>
          {party && quickPills.length > 0 && (
            <div className="vf-hero-quick">
              {quickPills.map((v) => (
                <button
                  key={v}
                  type="button"
                  className="vf-quick-pill"
                  onClick={() => setAmount(String((amountN || 0) + v))}
                >+ ₹{v >= 100000 ? `${v / 100000}L` : `${v / 1000}k`}</button>
              ))}
              <button
                type="button"
                className="vf-quick-pill vf-quick-full"
                onClick={() => setAmount(String(partyOutstanding))}
              >All ₹{partyOutstanding >= 100000 ? `${(partyOutstanding / 100000).toFixed(2)}L` : formatINR(partyOutstanding)}</button>
            </div>
          )}
        </div>

        {/* Allocation */}
        {party && (
          <>
            <div className="vf-section-head">
              <h3 className="vf-section-title">Apply <em>to bills</em></h3>
              <button className="vf-section-action" onClick={autoFill}>Auto-fill</button>
            </div>

            <div className="vf-bills">
              {bills.length === 0 && (
                <div className="vf-empty">No unpaid {isReceipt ? 'invoices' : 'bills'} for this {partyKind}</div>
              )}
              {bills.map((b) => {
                const id = b[billKey];
                const balance = Number(b.balance_amount) || 0;
                const allocated = Number(allocs[id]) || 0;
                const isAllocated = allocated > 0;
                const isFull = allocated >= balance - 0.01;
                const age = daysSince(b.bill_date);
                const ageClass = age >= 60 ? 'crit' : age >= 30 ? 'warn' : '';
                return (
                  <div
                    key={id}
                    className={`vf-bill${isAllocated ? ' vf-bill--alloc' : ''}`}
                    onClick={() => toggleAlloc(b)}
                  >
                    <div className={`vf-check${isAllocated ? (isFull ? ' vf-check--full' : ' vf-check--partial') : ''}`}>
                      {isAllocated && (isFull ? <CheckIcon /> : <PartialIcon />)}
                    </div>
                    <div className="vf-bill-info">
                      <div className="vf-bill-row1">
                        <span className="vf-bill-num">{b.bill_number}</span>
                        {age > 0 && <span className={`vf-bill-age ${ageClass}`}>{age} day{age === 1 ? '' : 's'}</span>}
                      </div>
                      <div className="vf-bill-meta">{fmtDate(b.bill_date)}</div>
                    </div>
                    <div className="vf-bill-amts">
                      <div className="vf-bill-amount"><span className="cur">₹</span>{formatINR(balance)}</div>
                      {isAllocated && (
                        <div className="vf-bill-paying">paying ₹{formatINR(allocated)}</div>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          </>
        )}
      </div>

      {/* Sticky footer */}
      <div className="vf-footer">
        <div className="vf-footer-summary">
          <span className="vf-summary-label">
            {allocatedCount > 0
              ? <>Allocated to <span className="strong">{allocatedCount} bill{allocatedCount === 1 ? '' : 's'}</span></>
              : (remaining > 0 && amountN > 0
                ? <>On account <span className="strong">₹{formatINR(remaining)}</span></>
                : <>No allocation</>)}
          </span>
          <span className="vf-summary-value">
            <span className="cur">₹</span>{formatINR(allocatedTotal)}{allocatedTotal === Math.floor(allocatedTotal) ? '.00' : ''}
          </span>
        </div>

        <div className="vf-mode-tabs">
          {MODES.map((m) => (
            <button
              key={m}
              className={`vf-mode-tab${mode === m ? ' vf-mode-tab--active' : ''}`}
              onClick={() => setMode(m)}
            >{MODE_LABELS[m]}</button>
          ))}
        </div>

        {/* Bank picker / cheque fields when relevant */}
        {mode !== 'Cash' && banks.length > 0 && (
          <select
            className="vf-bank-select"
            value={bankId || ''}
            onChange={(e) => setBankId(Number(e.target.value))}
          >
            {banks.map((b) => (
              <option key={b.ledger_id || b.id} value={b.ledger_id || b.id}>
                {b.ledger_name || b.name}
              </option>
            ))}
          </select>
        )}
        {mode === 'Cheque' && (
          <div className="vf-cheque-row">
            <input
              className="vf-cheque-input"
              placeholder="Cheque #"
              value={chequeNo}
              onChange={(e) => setChequeNo(e.target.value)}
              autoCorrect="off"
              autoCapitalize="characters"
              spellCheck="false"
            />
            <input
              className="vf-cheque-input"
              type="date"
              value={chequeDate}
              onChange={(e) => setChequeDate(e.target.value)}
            />
          </div>
        )}

        <button className="vf-save" onClick={handleSave} disabled={saving}>
          {saving ? 'Saving…' : (isReceipt ? 'Save receipt' : 'Save payment')}
          <ArrowRight />
        </button>
      </div>

      {partyOpen && (
        <PartySheet
          type={partyKind}
          onClose={() => setPartyOpen(false)}
          onPick={(p) => { setParty(p); setPartyOpen(false); }}
        />
      )}
    </div>
  );
}
