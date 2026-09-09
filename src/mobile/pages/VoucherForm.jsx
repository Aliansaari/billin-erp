/* ─────────────────────────────────────────────────────────────────────
 * VoucherForm — shared mobile form for /receipt/new and /payment/new
 *
 * Per the editorial mockup: party pill, big Fraunces hero amount with
 * quick pills, "Apply to bills" allocation list, sticky footer with
 * mode tabs (Cash/UPI/Bank/Cheque) and Save. `type` switches the
 * direction (Receipt vs Payment), accent color, party kind, bill kind,
 * and create endpoint label.
 * ─────────────────────────────────────────────────────────────────── */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Toast } from 'antd-mobile';
import { Capacitor } from '@capacitor/core';
import { paymentAPI, bankAPI } from '../../api';
import { formatINR } from '../utils/format';
import PartySheet from '../components/PartySheet';
import './VoucherForm.css';
import { success as hapticSuccess, warn as hapticWarn } from '../utils/haptics';

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
  const [selected, setSelected]   = useState(() => new Set());
  const [amount, setAmount]       = useState('');
  const [txDate, setTxDate]       = useState(todayISO());
  const [mode, setMode]           = useState(isReceipt ? 'Cash' : 'UPI');
  const [banks, setBanks]         = useState([]);
  const [bankId, setBankId]       = useState(null);
  const [chequeNo, setChequeNo]   = useState('');
  const [chequeDate, setChequeDate] = useState('');
  const [partyOpen, setPartyOpen] = useState(false);
  const [saving, setSaving]       = useState(false);
  // Set the instant the server accepts the voucher. Survives a failed
  // navigation, a failed toast, and a re-render — a second tap can never
  // post a second receipt.
  const committedRef = useRef(false);
  const [voucherNo, setVoucherNo] = useState('');
  // { id, number } for the voucher that was just committed. Drives the
  // confirmation strip; cleared on a timer or by the ×.
  const [justSaved, setJustSaved] = useState(null);

  useEffect(() => {
    if (!justSaved) return undefined;
    const t = setTimeout(() => setJustSaved(null), 6000);
    return () => clearTimeout(t);
  }, [justSaved]);

  // Voucher number (Rec / Pay). Also called again after a save, so the form
  // shows the number the NEXT voucher will get rather than the one just used.
  const loadNextNumber = useCallback(() => {
    paymentAPI.nextNumber(type)
      // Server returns { next: 'REC-000001' }; the other two keys are kept
      // as fallbacks in case an older build is on the other end of the tunnel.
      .then((r) => setVoucherNo(r.data?.next || r.data?.next_number || r.data?.number || ''))
      .catch(() => {});
  }, [type]);

  useEffect(() => { loadNextNumber(); }, [loadNextNumber]);

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

  // When party changes, fetch unpaid bills and mark ALL of them as
  // selected by default. Amount stays empty — the operator types it.
  // As they type, FIFO walks the selected bills oldest-first. If they
  // uncheck a bill, that bill is skipped and the next selected one
  // gets the money instead.
  useEffect(() => {
    if (!party) {
      setBills([]); setAllocs({}); setSelected(new Set()); setAmount('');
      return;
    }
    paymentAPI.getUnpaidBills({ party_id: party.party_id, type: billType })
      .then((r) => {
        const rows = Array.isArray(r.data) ? r.data : (r.data?.data || r.data?.bills || []);
        setBills(rows);
        // Pre-select every bill with a positive balance.
        const sel = new Set();
        for (const b of rows) {
          if (Number(b.balance_amount) > 0) sel.add(b[billKey]);
        }
        setSelected(sel);
        setAllocs({});
        setAmount('');
      })
      .catch(() => {
        setBills([]); setAllocs({}); setSelected(new Set()); setAmount('');
      });
  }, [party, billType, billKey]);

  // FIFO across the SELECTED bills only. Re-runs whenever amount or
  // selection changes, and on initial bill load.
  const recompute = (amt, selSet, billList) => {
    let left = Number(amt) || 0;
    const next = {};
    const sorted = [...billList].sort(
      (a, b) => new Date(a.bill_date) - new Date(b.bill_date),
    );
    for (const b of sorted) {
      if (left <= 0) break;
      const id = b[billKey];
      if (!selSet.has(id)) continue;
      const bal = Number(b.balance_amount) || 0;
      const give = Math.min(bal, left);
      if (give > 0) {
        next[id] = +give.toFixed(2);
        left -= give;
      }
    }
    return next;
  };

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

  // Typing in the hero re-runs FIFO across the SELECTED bills and
  // clamps the amount to the sum of selected balances (so the operator
  // can never overpay).
  const onAmountChange = (raw) => {
    if (raw === '') {
      setAmount('');
      setAllocs({});
      return;
    }
    let n = Number(raw);
    if (!Number.isFinite(n) || n < 0) n = 0;
    const selectedCap = bills.reduce(
      (s, b) => s + (selected.has(b[billKey]) ? Number(b.balance_amount || 0) : 0),
      0,
    );
    if (selectedCap > 0 && n > selectedCap) n = selectedCap;
    setAmount(n === 0 ? '0' : String(+n.toFixed(2)));
    setAllocs(recompute(n, selected, bills));
  };

  const toggleSelected = (bill) => {
    const id = bill[billKey];
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      // Recompute allocs against the new selection. Also clamp the
      // amount if the unchecked bill made the selection cap shrink
      // below the typed amount.
      const cap = bills.reduce(
        (s, b) => s + (next.has(b[billKey]) ? Number(b.balance_amount || 0) : 0),
        0,
      );
      const amtNow = Number(amount) || 0;
      const newAmt = amtNow > cap ? cap : amtNow;
      if (newAmt !== amtNow) setAmount(newAmt === 0 ? '' : String(+newAmt.toFixed(2)));
      setAllocs(recompute(newAmt, next, bills));
      return next;
    });
  };

  // Manual "fill the typed amount across selected bills now" — most
  // operators won't need it (amount-typing already re-runs FIFO) but
  // it's a reassurance button matching the mockup.
  const autoFill = () => {
    if (amountN <= 0) {
      Toast.show({ content: 'Enter an amount first' });
      return;
    }
    setAllocs(recompute(amountN, selected, bills));
  };

  const handleSave = async () => {
    if (saving || committedRef.current) return;
    if (!party) {
      hapticWarn(); Toast.show({ icon: 'fail', content: `Pick a ${partyKind}` });
      return;
    }
    if (amountN <= 0) {
      hapticWarn(); Toast.show({ icon: 'fail', content: 'Enter an amount' });
      return;
    }
    if (mode !== 'Cash' && !bankId) {
      hapticWarn(); Toast.show({ icon: 'fail', content: 'Pick a bank' });
      return;
    }
    if (mode === 'Cheque' && !chequeNo.trim()) {
      hapticWarn(); Toast.show({ icon: 'fail', content: 'Enter cheque number' });
      return;
    }
    if (allocatedTotal > amountN + 0.01) {
      hapticWarn(); Toast.show({ icon: 'fail', content: 'Allocated exceeds amount' });
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
      transaction_date: txDate,
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

    /* Everything after the server's "yes" is arranged so it cannot strand the
     * button: the toast and haptic are decoration and are caught separately,
     * and `finally` — not either branch — is what re-enables it. What stops a
     * second tap from posting a second receipt is the emptied form plus
     * `committedRef`, a fact rather than a disabled attribute that some later
     * line has to reach. (Payments carry no server-side idempotency key,
     * unlike sales and purchases, so this is the only guard in the way.) */
    setSaving(true);
    try {
      const res = await paymentAPI.create(body);
      committedRef.current = true;
      // The create endpoint returns the PaymentReceipt row itself — the keys
      // are `transaction_id` / `transaction_number`. The older guesses here
      // matched nothing, so "View" never had an id and the number was blank.
      const d = res?.data?.data || res?.data || {};
      const savedId = d.transaction_id || d.payment_receipt_id || d.receipt_id || d.id || null;
      const savedNo = d.transaction_number || voucherNo || '';

      /* Stay on the form and clear it, exactly like the bill form.
       *
       * Navigating to the saved voucher used to be the only signal that the
       * save worked, so anything that stopped the navigation — or stopped the
       * code that ran before it — left the operator looking at a full form
       * with a dead button, and they tapped again. Now the proof is a strip
       * that cannot fail to render, and the next voucher is one tap away.
       *
       * The party IS cleared here (unlike the bill form, which keeps it):
       * receipts are collected party by party, and the outstanding bills held
       * in state are stale the moment this one is allocated. */
      setParty(null);
      setBills([]);
      setAllocs({});
      setSelected(new Set());
      setAmount('');
      setChequeNo('');
      setChequeDate('');
      setJustSaved({ id: savedId || null, number: savedNo });
      loadNextNumber();
      // The form is empty again, so the amount check is what blocks a stray
      // second tap from here on. Release the commit latch for the next one.
      committedRef.current = false;

      // Decoration only — never allowed to affect the outcome above.
      try {
        hapticSuccess();
        Toast.show({ icon: 'success', content: isReceipt ? 'Receipt saved' : 'Payment saved' });
      } catch { /* a toast that failed is still a saved voucher */ }
    } catch (e) {
      if (committedRef.current) {
        // The voucher is on the server and only the reset failed. Never
        // present that as a failure — it invites a duplicate.
        try { Toast.show({ icon: 'success', content: 'Saved' }); } catch {}
        navigate('/vouchers', { replace: true });
      } else {
        const msg = e?.response?.data?.error || e?.response?.data?.message || e?.message || 'Save failed';
        try {
          hapticWarn();
          Toast.show({ icon: 'fail', content: msg });
        } catch { /* see above */ }
      }
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

  // Label for the big amount field. "Receiving from" / "Paying to" left a
  // dangling preposition (the party is already named in the pill above), so
  // this now reads as a complete, correct label for the amount being entered.
  const heroVerb = 'Amount';
  const heroDir  = isReceipt ? 'received' : 'paid';
  const balanceLabel = isReceipt ? 'outstanding' : 'payable';

  return (
    <div className={`vf-screen ${isReceipt ? 'vf-in' : 'vf-out'}`}>
      {/* Header */}
      <div className="vf-header">
        <button className="vf-icon-btn" onClick={() => navigate(-1)} aria-label="Back">
          <BackIcon />
        </button>
        <div className="vf-header-meta">
          <span className="vf-voucher-no">{isReceipt ? 'RECEIPT' : 'PAYMENT'} <span className="strong">{voucherNo || '—'}</span></span>
          <label className="vf-date">
            <svg className="vf-date-ico" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="4" width="18" height="18" rx="2"/><path d="M16 2v4M8 2v4M3 10h18"/></svg>
            <span className="vf-date-text">{fmtDate(txDate)}</span>
            <input
              type="date"
              className="vf-date-native"
              value={txDate}
              onChange={(e) => setTxDate(e.target.value || todayISO())}
              aria-label="Transaction date"
            />
          </label>
        </div>
        <button className="vf-icon-btn" aria-label="More">
          <MoreIcon />
        </button>
      </div>

      {/* Proof the voucher saved. Sits BELOW the header, which is what carries
          `env(safe-area-inset-top)` — above it the strip lands under the
          notch and overlaps the clock. */}
      {justSaved && (
        <div className="vf-saved" role="status">
          <span className="vf-saved-tick" aria-hidden>
            <svg viewBox="0 0 16 16" width="12" height="12" fill="none">
              <path d="M3.2 8.4l3.1 3.1 6.5-6.9" stroke="currentColor" strokeWidth="2.1"
                    strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </span>
          <span className="vf-saved-text">
            <span className="vf-saved-label">{isReceipt ? 'Receipt saved' : 'Payment saved'}</span>
            {justSaved.number && <span className="vf-saved-num">{justSaved.number}</span>}
          </span>
          {justSaved.id && (
            <button
              type="button"
              className="vf-saved-view"
              onClick={() => navigate(`/vouchers/${isReceipt ? 'receipt' : 'payment'}/${justSaved.id}`)}
            >
              View
            </button>
          )}
          <button
            type="button"
            className="vf-saved-x"
            onClick={() => setJustSaved(null)}
            aria-label="Dismiss"
          >
            <svg viewBox="0 0 16 16" width="13" height="13" fill="none">
              <path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
            </svg>
          </button>
        </div>
      )}

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
              onChange={(e) => onAmountChange(e.target.value)}
              onFocus={(e) => {
                // After the iOS keyboard finishes animating (~250 ms)
                // the footer has translated up and may cover the hero;
                // scroll it into view so it lands above the footer.
                setTimeout(() => {
                  try { e.target.scrollIntoView({ block: 'center', behavior: 'smooth' }); } catch {}
                }, 280);
              }}
            />
          </div>
          {party && quickPills.length > 0 && (
            <div className="vf-hero-quick">
              {quickPills.map((v) => (
                <button
                  key={v}
                  type="button"
                  className="vf-quick-pill"
                  onClick={() => onAmountChange(String((amountN || 0) + v))}
                >+ ₹{v >= 100000 ? `${v / 100000}L` : `${v / 1000}k`}</button>
              ))}
              <button
                type="button"
                className="vf-quick-pill vf-quick-full"
                onClick={() => onAmountChange(String(partyOutstanding))}
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
                const isSelected  = selected.has(id);
                const isAllocated = allocated > 0;
                const isFull = isAllocated && allocated >= balance - 0.01;
                const isPartial = isAllocated && !isFull;
                const age = daysSince(b.bill_date);
                const ageClass = age >= 60 ? 'crit' : age >= 30 ? 'warn' : '';
                // Check state:
                //   filled gradient + tick → bill paying in full
                //   coloured ring + minus  → bill paying partial
                //   coloured ring (empty)  → selected but waiting on amount
                //   muted ring             → user unchecked it
                const checkCls = isFull
                  ? ' vf-check--full'
                  : isPartial
                    ? ' vf-check--partial'
                    : isSelected
                      ? ' vf-check--selected'
                      : '';
                return (
                  <div
                    key={id}
                    className={`vf-bill${isAllocated ? ' vf-bill--alloc' : ''}${!isSelected ? ' vf-bill--dim' : ''}`}
                    onClick={() => toggleSelected(b)}
                  >
                    <div className={`vf-check${checkCls}`}>
                      {isFull ? <CheckIcon /> : (isPartial ? <PartialIcon /> : null)}
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

        {/* Bank picker — only when the mode is non-cash. If the firm
            only has one bank ledger, we render it as a static info row
            (no useless dropdown chrome); multi-bank firms get a real
            picker with balance preview alongside the name. */}
        {mode !== 'Cash' && banks.length > 0 && (() => {
          const pick = banks.find((b) => (b.ledger_id || b.id) === bankId) || banks[0];
          const bal = Number(pick.balance) || 0;
          if (banks.length === 1) {
            return (
              <div className="vf-bank-info">
                <span className="vf-bank-info-icon">
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M3 21h18M5 21V10l7-6 7 6v11M9 9h6"/>
                  </svg>
                </span>
                <span className="vf-bank-info-name">{pick.ledger_name || pick.name}</span>
                <span className="vf-bank-info-bal">₹{formatINR(bal)}</span>
              </div>
            );
          }
          return (
            <label className="vf-bank-select-wrap">
              <span className="vf-bank-select-text">
                {pick.ledger_name || pick.name}
                <span className="vf-bank-select-bal"> · ₹{formatINR(bal)}</span>
              </span>
              <svg className="vf-bank-select-chev" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M6 9l6 6 6-6"/></svg>
              <select
                className="vf-bank-select-native"
                value={bankId || ''}
                onChange={(e) => setBankId(Number(e.target.value))}
              >
                {banks.map((b) => (
                  <option key={b.ledger_id || b.id} value={b.ledger_id || b.id}>
                    {(b.ledger_name || b.name)} · ₹{formatINR(Number(b.balance) || 0)}
                  </option>
                ))}
              </select>
            </label>
          );
        })()}
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
