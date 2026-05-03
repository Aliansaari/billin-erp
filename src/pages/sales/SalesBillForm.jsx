import React, { useState, useRef, useEffect, useLayoutEffect, useCallback } from 'react';
import { Form, Input, DatePicker, Select, InputNumber, Table, message, Modal, Tag } from 'antd';
import { useNavigate, useParams, useLocation } from 'react-router-dom';
import dayjs from 'dayjs';
import { salesAPI, salesDraftAPI, partyAPI, productAPI, categoryAPI, settingsAPI, godownAPI } from '../../api';
import { printDocument } from '../../services/printer';
import { useCtrlEnterSubmit } from '../../hooks/useKeyboardShortcuts';
import { useUnsavedChangesWarning } from '../../hooks/useUnsavedChangesWarning';
import './sales-bill-form.css';

const fmtN = (v) => parseFloat(v || 0).toLocaleString('en-IN', { minimumFractionDigits: 2 });

const UNITS     = ['Pcs','Box','Set','Pair','Dozen','Mtr','Roll'];
const PAY_MODES = ['Cash','Card','UPI','Bank Transfer','Cheque','Credit'];

const EMPTY = {
  barcode:'', category_id:null, category_name:'', product_name:'', size:'',
  article_number:'', rate:0, quantity:0, discount_percentage:0,
  hsn_code:'', gst_rate:0, product_id:null, mrp:0, available_stock:0, unit_type:'Pcs',
  quantity_per_box:1,
  // Batch dimension — only meaningful when global batch_tracking_enabled
  // is ON AND the resolved product has is_batch_tracked=true. Picker
  // populates batch_id (auto-pick on product select); batch_number /
  // expiry_date / available_stock come along for the items-table chip
  // and per-batch stock guard. Defaults stay null/false so non-batch
  // sales don't carry stale batch metadata.
  is_batch_tracked:false, batch_id:null, batch_number:'',
  manufacture_date:null, expiry_date:null, batch_stock:0,
};

// Style helper for the bill-mode toggle pills (Itemised / Amount-only).
// Defined at module level so it doesn't re-allocate on every render.
const modePillStyle = (active) => ({
  padding: '5px 14px',
  borderRadius: 999,
  border: active ? '1px solid var(--accent-primary, #E26A4C)' : '1px solid var(--border-subtle)',
  background: active ? 'var(--accent-primary, #E26A4C)' : 'transparent',
  color: active ? '#fff' : 'var(--fg-secondary)',
  fontSize: 12,
  fontWeight: 600,
  cursor: 'pointer',
  transition: 'background .12s, color .12s, border-color .12s',
});

/* ════════════════════════════════════════════════════════════════════════════
 * SalesBillForm — Editorial v14 layout.
 *
 * Layout (top → bottom):
 *   1. TOP section (left-aligned, max-width 1500)
 *      — SALES INVOICE pill · Bill no. · company
 *      — Customer / Bill date / Due date
 *      — Party info strip (when a customer is selected)
 *      — Product entry row (barcode → +ADD)
 *   2. MIDDLE (full-bleed, edge-to-edge items table card)
 *   3. BOTTOM (Summary LEFT, Totals + Payment RIGHT)
 *      — Summary card: counters + Sale type + Salesman
 *      — Totals card:  Subtotal → CGST % · ₹ → SGST → IGST → Other → Freight → Bill Disc
 *      — Payment card: NET TOTAL hero (Fraunces) · Mode · Return · Cash Rcvd · Amt Paid · Status
 *   4. ACTION BAR (compact, all 4 buttons LEFT)
 *      — Esc Back · F5 Reset · F8 Save Credit · F1 Save & Rcv
 *
 * Business logic is unchanged from the prior version — every handler,
 * state variable, ref, and calculation is preserved verbatim. Only the
 * render tree + colors changed.
 * ════════════════════════════════════════════════════════════════════════════ */
export default function SalesBillForm() {
  const navigate = useNavigate();
  const location = useLocation();
  const { id }   = useParams();
  const isEdit   = Boolean(id);

  // Where Back / post-save returns to. Pages that link here can pass
  //   <Link to="/sale/edit/123" state={{ from: '/reports/gstr1?from=...' }}>
  // and the user lands back on the page they came from instead of always
  // dropping into the Sales list.
  const backTarget = location.state?.from || '/sales';

  const [form]    = Form.useForm();
  const [items, setItems]       = useState([]);
  const [parties, setParties]   = useState([]);
  const [cats, setCats]         = useState([]);
  // Active godowns the operator can issue from. Filtered to user's
  // allowed_godowns when the JWT carries that allowlist (the server
  // also enforces — this is just to keep the dropdown honest).
  const [godowns, setGodowns]   = useState([]);
  const [loading, setLoading]   = useState(false);
  const [pgLoading, setPgLoading] = useState(false);
  const [entry, setEntry]       = useState(EMPTY);
  const [prodOpts, setProdOpts] = useState([]);
  // Batch picker state — populated when entry.product_id changes for a
  // batch-tracked product at the selected godown. Server returns batches
  // already sorted FEFO/FIFO so the first row is the auto-pick winner.
  // batchTrackingOn / blockExpiredSales / batchAlertDays come from
  // SystemSettings on mount; the form silently falls back to non-batch
  // behaviour when batchTrackingOn is false.
  const [batchOpts, setBatchOpts]               = useState([]);
  const [batchOptsLoading, setBatchOptsLoading] = useState(false);
  const [batchTrackingOn, setBatchTrackingOn]   = useState(false);
  const [blockExpiredSales, setBlockExpiredSales] = useState(false);
  const [batchAlertDays, setBatchAlertDays]     = useState(30);
  const [company, setCompany]   = useState('');
  // Whether the operator can switch to Amount-only mode. Controlled by
  // SystemSettings.enable_amount_only_billing — when off, the Mode strip
  // hides and the form behaves exactly like before this feature shipped.
  const [amountOnlyEnabled, setAmountOnlyEnabled] = useState(true);
  const [billNo, setBillNo]     = useState('');
  // Preview of the next bill_number that the server will allocate when
  // we save. Optimistic — the server still atomically allocates inside
  // the create txn, so the actual saved number may differ if another
  // operator races us. Recomputed on mount and after each save.
  const [nextBillNoPreview, setNextBillNoPreview] = useState('');
  // gstMode defaults to the user's last choice (saved in localStorage) for
  // new bills, but flips to 'bill' when we load an existing bill that was
  // clearly stored as bill-wise — i.e. it has non-zero bill-level GST
  // percentages or amounts. Without this, Tally-imported bills (which are
  // always bill-wise and whose line items have gst_rate=0) would render
  // with zero tax in the edit form and disagree with the sales-list total.
  const [gstMode, setGstMode]   = useState(()=>localStorage.getItem('gst_mode')||'product');
  const [cgstPct, setCgstPct]   = useState(0);
  const [sgstPct, setSgstPct]   = useState(0);
  const [igstPct, setIgstPct]   = useState(0);
  const [selectedParty, setSelectedParty] = useState(null);
  const [discAmtVal, setDiscAmtVal]       = useState(0);
  const discAmtEditingRef                 = useRef(false);
  // Re-entrancy guard for Save — prevents duplicate-bill creation on rapid
  // Ctrl+Enter or double-click of Save buttons.
  const submittingRef                      = useRef(false);
  // Monotonic key for item rows. Date.now() collides with fast scanners.
  const nextKeyRef                         = useRef(1);

  // Prevents the auto paid_amount effect from overwriting loaded edit values
  const billLoadedRef = useRef(false);
  // Tracks if user manually typed in paid_amount — prevents auto-fill from overwriting credit customers
  const paidEditedRef = useRef(false);
  // Cash received state — for walk-in cash billing change calculation (not saved to DB)
  const [cashReceived, setCashReceived] = useState(0);

  // ── Hold/Recall + Amount-only state ────────────────────────────────
  // bill_mode: 'item' (default itemised) | 'amount' (single synthetic line).
  // Persisted to backend; affects which form fields are visible and which
  // payload shape we POST/PUT.
  const [billMode, setBillMode] = useState('item');
  // Amount-mode fields (only used when billMode === 'amount')
  const [amountVal,    setAmountVal]    = useState('');
  const [amountGstRate,setAmountGstRate]= useState(0);
  const [amountHsnCode,setAmountHsnCode]= useState('');
  const [amountDesc,   setAmountDesc]   = useState('');
  // Tracks the draft this form was recalled from. When set AND save
  // succeeds, the backend deletes that draft inside the create txn.
  const [recalledDraftId, setRecalledDraftId] = useState(null);
  // Hold operation in flight — disables the Hold button so two F4
  // presses don't create two duplicate drafts.
  const [holdLoading, setHoldLoading] = useState(false);

  // ── Inline-return state (customer brings goods back at counter) ──
  // The modal collects items into `inlineReturnItems`. On save the form
  // sends them as `inline_return` in the payload; backend creates a paired
  // SalesReturnBill in the same txn (stock restocks, party balance recomputes).
  // The modal's running total is mirrored into the form's `return_amount`
  // field so the Net total / Amt-paid math accounts for it automatically.
  const [returnModalOpen, setReturnModalOpen] = useState(false);
  const [inlineReturnItems, setInlineReturnItems] = useState([]);
  const [retEntry, setRetEntry] = useState({
    barcode:'', product_id:null, product_name:'', size:'', article_number:'',
    rate:0, quantity:1, discount_percentage:0, hsn_code:'', gst_rate:0,
    category_id:null, category_name:'', mrp:0, unit_type:'Pcs',
    quantity_per_box:1, available_stock:0,
  });
  // Return-modal scoped state — separate from the main entry row's
  // prodOpts/activeCatId/prodOpen so a search inside the modal doesn't
  // overwrite what the operator was about to pick on the main form.
  const [retProdOpts, setRetProdOpts] = useState([]);
  const [retActiveCatId, setRetActiveCatId] = useState(null);
  const [retProdOpen, setRetProdOpen] = useState(false);
  const retSearchTimerRef = useRef(null);
  const retSearchReqRef   = useRef(0);
  const retJustSelectedRef = useRef(false);
  const retBarcodeRef = useRef(null);
  const retCatRef     = useRef(null);
  const retProdRef    = useRef(null);
  const retSizeRef    = useRef(null);
  const retArtRef     = useRef(null);
  const retRateRef    = useRef(null);
  const retQtyRef     = useRef(null);
  const retDiscRef    = useRef(null);
  const retGstRef     = useRef(null);
  const retEntryRefs  = [retProdRef, retSizeRef, retArtRef, retRateRef, retQtyRef, retDiscRef, retGstRef];
  const retNextKeyRef = useRef(1);
  // Bump on each Add so the entry row's inputs fully remount — AntD's
  // InputNumber sometimes keeps its displayed value when the controlled
  // value flips from a number to undefined, and a key change is the
  // surest way to wipe that internal state.
  const [retEntryNonce, setRetEntryNonce] = useState(0);

  // Load products into the modal whenever the modal's active category changes
  // (mirror of the main form's pattern at line ~195).
  useEffect(() => {
    if (!retActiveCatId) { setRetProdOpts([]); return; }
    let cancelled = false;
    productAPI.search('', { category_id: retActiveCatId, name_only: 'true' })
      .then(({ data }) => {
        if (cancelled) return;
        setRetProdOpts(data.data || []);
        setTimeout(() => { retProdRef.current?.focus(); setRetProdOpen(true); }, 30);
      })
      .catch(() => { if (!cancelled) setRetProdOpts([]); });
    return () => { cancelled = true; };
  }, [retActiveCatId]);

  // Debounced product search inside the modal (mirrors handleProdSearch).
  const handleRetProdSearch = useCallback((v) => {
    if (retSearchTimerRef.current) clearTimeout(retSearchTimerRef.current);
    if (!v) { if (!retActiveCatId) setRetProdOpts([]); return; }
    retSearchTimerRef.current = setTimeout(async () => {
      const reqId = ++retSearchReqRef.current;
      try {
        const { data } = await productAPI.search(v, {
          name_only: 'true',
          ...(retActiveCatId ? { category_id: retActiveCatId } : {}),
        });
        if (reqId !== retSearchReqRef.current) return;
        setRetProdOpts(data.data || []);
      } catch {}
    }, 150);
  }, [retActiveCatId]);

  // Pick a product into the entry row (mirrors handleProdSel) — sets all
  // fields, then redirects focus to qty for fast keyboard entry.
  const handleRetProdSel = useCallback((val, opt) => {
    const p = opt?.product;
    if (!p) return;
    const qty = parseFloat(p.quantity_per_box) || 1;
    const unitType = qty > 1 ? 'Box' : 'Pcs';
    setRetActiveCatId(p.category_id || null);
    setRetEntry(prev => ({ ...prev,
      product_id: p.product_id, barcode: p.barcode,
      product_name: p.product_name,
      category_id: p.category_id, category_name: p.Category?.category_name || '',
      size: p.size_value || '', article_number: p.article_number || '',
      rate: parseFloat(p.sale_rate) || 0, mrp: parseFloat(p.mrp) || 0,
      hsn_code: p.hsn_code || '', gst_rate: parseFloat(p.gst_rate) || 0,
      available_stock: parseFloat(p.current_stock) || 0,
      quantity: qty, unit_type: unitType,
      quantity_per_box: parseFloat(p.quantity_per_box) || 1,
    }));
    retJustSelectedRef.current = true;
    requestAnimationFrame(() => { retProdRef.current?.blur(); retQtyRef.current?.focus(); });
  }, []);

  // Barcode scan inside the modal — looks up by barcode, adds the row
  // immediately (mirrors handleScan).
  const handleRetScan = useCallback(async (barcode) => {
    if (!barcode?.trim()) return;
    const code = barcode.trim();
    setRetEntry(p => ({ ...p, barcode: '' }));
    if (retBarcodeRef.current?.input) retBarcodeRef.current.input.value = '';
    retBarcodeRef.current?.focus();
    try {
      const { data } = await productAPI.getByBarcode(code);
      const rate = parseFloat(data.sale_rate) || 0;
      const gst  = parseFloat(data.gst_rate) || 0;
      const qty  = parseFloat(data.quantity_per_box) || 1;
      const unitType = qty > 1 ? 'Box' : 'Pcs';
      setInlineReturnItems(prev => [...prev, {
        key: retNextKeyRef.current++,
        product_id: data.product_id, barcode: data.barcode,
        category_id: data.category_id, category_name: data.Category?.category_name || '',
        product_name: data.product_name, size: data.size_value || '',
        article_number: data.article_number || '', unit_type: unitType,
        rate, quantity: qty, quantity_per_box: parseFloat(data.quantity_per_box) || 1,
        discount_percentage: 0,
        mrp: parseFloat(data.mrp) || 0,
        hsn_code: data.hsn_code || '', gst_rate: gst,
      }]);
      message.success(`${data.product_name} added`, 1);
    } catch {
      message.warning('Product not found');
    }
  }, []);

  // Update a single field on the entry-in-progress (mirrors `ue`).
  const retUpdateEntry = (field, value) => setRetEntry(p => ({ ...p, [field]: value }));

  // Keyboard nav across the entry row: Enter advances to the NEXT field.
  // Final field (GST%, idx=6) triggers Add. retEntryRefs is 0-indexed
  // [Product, Size, Art, Rate, Qty, Disc, GST] — `idx` is the field's own
  // position (Size=1 etc.), so `idx+1` is the next field.
  const retEntryKey = (e, idx) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      const next = retEntryRefs[idx + 1];
      if (next) {
        next.current?.focus();
        next.current?.select?.();
      } else {
        retAddItem();
      }
    }
  };

  // Add the current entry to the inline return list. Validates basics,
  // then bumps the entry-row nonce so all inputs remount with a clean slate.
  const retAddItem = () => {
    if (!retEntry.product_name) { message.warning('Pick a product first'); return; }
    if (!retEntry.quantity || retEntry.quantity <= 0) { message.warning('Enter quantity'); return; }
    if (!retEntry.rate || retEntry.rate <= 0) { message.warning('Enter rate'); return; }
    setInlineReturnItems(prev => [...prev, { ...retEntry, key: retNextKeyRef.current++ }]);
    setRetEntry({
      barcode:'', product_id:null, product_name:'', size:'', article_number:'',
      rate:0, quantity:1, discount_percentage:0, hsn_code:'', gst_rate:0,
      category_id:null, category_name:'', mrp:0, unit_type:'Pcs',
      quantity_per_box:1, available_stock:0,
    });
    setRetEntryNonce(n => n + 1);
    setTimeout(() => retBarcodeRef.current?.focus(), 30);
  };
  // Total of all return items (post-discount taxable + GST). GST applies
  // to the POST-DISCOUNT line value (transaction value) — not the gross —
  // so a 5% trade discount on a 18%-GST line doesn't overstate GST.
  const inlineReturnTotalRaw = inlineReturnItems.reduce((s, it) => {
    const lt = (it.quantity||0)*(it.rate||0);
    const disc = lt * ((it.discount_percentage||0)/100);
    const taxable = lt - disc;
    const gst = taxable * ((it.gst_rate||0)/100);
    return s + taxable + gst;
  }, 0);
  // Round to nearest rupee — matches the bill's roundedTotal convention so
  // Net total = bill - return doesn't end up with a stray paisa.
  const inlineReturnTotal = Math.round(inlineReturnTotalRaw);
  // Push the rounded total into form.return_amount whenever the operator
  // updates the return list. The Net total / Amt-paid math reads returnAmt
  // from the form, so this single mirror keeps everything in sync.
  useEffect(() => {
    if (inlineReturnItems.length === 0) return;
    form.setFieldValue('return_amount', inlineReturnTotal);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [inlineReturnItems, inlineReturnTotal]);

  const [activeCatId, setActiveCatId] = useState(null); // drives product list loading
  const [prodOpen, setProdOpen]       = useState(false); // controls product dropdown visibility
  const searchTimerRef  = useRef(null); // debounce timer for product search
  const searchReqRef    = useRef(0);   // stale-response guard for product search
  const justSelectedRef = useRef(false); // redirect focus to qty after product selection
  const barcodeRef   = useRef(null);
  const prodRef      = useRef(null);
  const prodWrapRef  = useRef(null);
  const sizeRef      = useRef(null);
  const artRef       = useRef(null);
  const rateRef      = useRef(null);
  const qtyRef       = useRef(null);
  const discRef      = useRef(null);
  const gstRef       = useRef(null);
  // Batch dropdown ref — used by handleProdSel + handleScan to focus
  // and open the picker right after the operator binds a batch-tracked
  // product, so the next keystroke lands on Lot selection rather than
  // qty. Open state is controlled separately so we can force-open
  // alongside the focus jump.
  //
  // pendingBatchFocusRef carries the "the operator just bound a batch-
  // tracked product, please open the Lot dropdown when batches finish
  // loading" intent across the async fetch. The Select is disabled
  // during fetch (would no-op focus + open), so we defer until the
  // batchOpts effect completes (watched by an effect below).
  const batchSelectRef = useRef(null);
  const [batchOpen, setBatchOpen] = useState(false);
  const pendingBatchFocusRef = useRef(false);
  const tableWrapRef = useRef(null);
  const [tblHeight, setTblHeight] = useState(300);
  // Tab/Enter/ArrowDown walk this array left → right; ArrowUp walks back.
  // Order MIRRORS the visual entry-row order: Product → Size → Art# →
  // Qty → Rate → Disc% → GST% → (+ADD via the addItem fall-through at
  // the end of `eKey`). After product selection we focus-jump straight
  // to qtyRef (a fast path) — qtyRef stays at index 3 so the index-based
  // walk continues to make sense from there.
  const eRefs = [prodRef,sizeRef,artRef,qtyRef,rateRef,discRef,gstRef];

  useLayoutEffect(()=>{
    const el = tableWrapRef.current;
    if(!el) return;
    // Measure immediately so first render has correct height (no shrink flash)
    setTblHeight(Math.max(100, el.clientHeight - 40));
    const ro = new ResizeObserver(([e])=>setTblHeight(Math.max(100, e.contentRect.height - 40)));
    ro.observe(el);
    return ()=>ro.disconnect();
  },[]);

  // Load products whenever the active category changes
  useEffect(()=>{
    if(!activeCatId){ setProdOpts([]); return; }
    let cancelled=false;
    productAPI.search('',{category_id:activeCatId,name_only:'true'})
      .then(({data})=>{
        if(cancelled) return;
        setProdOpts(data.data||[]);
        setTimeout(()=>{ prodRef.current?.focus(); setProdOpen(true); },30);
      })
      .catch(()=>{ if(!cancelled) setProdOpts([]); });
    return ()=>{ cancelled=true; };
  },[activeCatId]);

  useEffect(() => {
    partyAPI.getCustomers({limit:1000}).then(({data}) =>
      setParties((data.data||[]).filter(p=>p.is_active!==false))).catch(()=>{});
    categoryAPI.getAllFlat().then(({data})=>setCats(data||[])).catch(()=>{});
    // Active godowns. Pre-select the default godown on a new bill if the
    // form doesn't already have one (edit-mode hydrates from the bill).
    godownAPI.getAll().then(({data}) => {
      const list = (data || []).filter(g => g.is_active);
      const userAllowed = (() => {
        try {
          const u = JSON.parse(localStorage.getItem('user') || 'null');
          return Array.isArray(u?.allowed_godowns) ? u.allowed_godowns : null;
        } catch { return null; }
      })();
      const filtered = userAllowed ? list.filter(g => userAllowed.includes(g.godown_id)) : list;
      setGodowns(filtered);
      if (!isEdit && !form.getFieldValue('godown_id')) {
        const def = filtered.find(g => g.is_default) || filtered[0];
        if (def) form.setFieldsValue({ godown_id: def.godown_id });
      }
    }).catch(()=>{});
    settingsAPI.getSystem().then(({data}) => {
      setCompany(data?.data?.company_name || '');
      // Default to enabled when the column is missing (older DBs that
      // haven't run the migration yet). Treat literal `false` as off;
      // anything else (true / null / undefined) means the toggle is on.
      setAmountOnlyEnabled(data?.data?.enable_amount_only_billing !== false);
      // Batch picker gates: global toggle + expired-sales block + alert
      // days. Same column names the purchase form's batch strip reads.
      setBatchTrackingOn(!!data?.data?.batch_tracking_enabled);
      setBlockExpiredSales(!!data?.data?.block_expired_sales);
      const ad = parseInt(data?.data?.batch_expiry_alert_days, 10);
      setBatchAlertDays(Number.isFinite(ad) && ad > 0 ? ad : 30);
    }).catch(()=>{});
    // Predict the next bill number so the operator sees what they'll
    // get on save instead of "pending". Asks the server for the latest
    // bill, increments its trailing digits, prefixes with the configured
    // sales prefix. Optimistic — actual allocation is server-side under
    // a row lock, so this can drift if another operator races us.
    if (!isEdit) {
      Promise.all([
        salesAPI.getAll({ limit: 1, page: 1 }),
        settingsAPI.getSystem(),
      ]).then(([listRes, setRes]) => {
        const prefix = setRes?.data?.data?.sales_bill_prefix?.trim() || '';
        const latest = listRes?.data?.data?.[0]?.bill_number || '';
        const m = String(latest).match(/(\d+)(?!.*\d)/);
        const next = (m ? parseInt(m[1], 10) + 1 : 1);
        const padded = String(next).padStart(m ? m[1].length : 4, '0');
        setNextBillNoPreview((prefix ? prefix + '-' : '') + padded);
      }).catch(() => {});
    }
    if(isEdit){ loadBill(id); }
    else{
      form.setFieldsValue({ bill_date:dayjs(), payment_method:'Cash', sale_type:'Retail' });
      setTimeout(()=>barcodeRef.current?.focus(),100);
    }
  },[id]);

  const loadBill = async(bid)=>{
    setPgLoading(true);
    try{
      const{data}=await salesAPI.getById(bid);
      setBillNo(data.bill_number||'');
      form.setFieldsValue({
        godown_id:data.godown_id,
        customer_id:data.customer_id,
        walk_in_name:data.walk_in_name||'',
        bill_date:data.bill_date?dayjs(data.bill_date):dayjs(),
        due_date:data.due_date?dayjs(data.due_date):null,
        // If the stored bill has a discount_amount but pct=0 (old Tally
        // imports), derive pct from amount/sub_total so the total calc
        // actually subtracts the discount. Safety net for legacy data.
        discount_percentage: (() => {
          const pct = parseFloat(data.discount_percentage)||0;
          if (pct > 0) return pct;
          const amt = parseFloat(data.discount_amount)||0;
          const sub = parseFloat(data.sub_total)||0;
          return (amt > 0 && sub > 0) ? +(amt / sub * 100).toFixed(4) : 0;
        })(),
        paid_amount:parseFloat(data.paid_amount)||0,
        return_amount:parseFloat(data.return_amount)||0,
        sale_type:data.sale_type||'Retail',
        salesman_name:data.salesman_name||'',
        special_discount:parseFloat(data.special_discount)||0,
        other_charges:parseFloat(data.other_charges)||0,
        freight_charges:parseFloat(data.freight_charges)||0,
        payment_method:data.payment_method||'Cash',
        remarks:data.remarks||'',
      });
      const loadedCgstPct = parseFloat(data.cgst_pct)||0;
      const loadedSgstPct = parseFloat(data.sgst_pct)||0;
      const loadedIgstPct = parseFloat(data.igst_pct)||0;
      const loadedCgstAmt = parseFloat(data.cgst_amount)||0;
      const loadedSgstAmt = parseFloat(data.sgst_amount)||0;
      const loadedIgstAmt = parseFloat(data.igst_amount)||0;
      setCgstPct(loadedCgstPct);
      setSgstPct(loadedSgstPct);
      setIgstPct(loadedIgstPct);
      // Heuristic: if the bill has any bill-level GST (pct or amount), it
      // was stored bill-wise — flip the form's mode so the edit view
      // recomputes the total the same way the bill was originally saved.
      // Native product-wise bills leave all of these at 0 and keep the
      // user's localStorage preference.
      if (loadedCgstPct > 0 || loadedSgstPct > 0 || loadedIgstPct > 0
          || loadedCgstAmt > 0 || loadedSgstAmt > 0 || loadedIgstAmt > 0) {
        setGstMode('bill');
      }
      setDiscAmtVal(parseFloat(data.discount_amount)||0);
      const loaded=(data.items||[]).map((it,i)=>({
        key:it.item_id||i, item_id:it.item_id,
        product_id:it.product_id, barcode:it.barcode||'',
        category_id:it.category_id, category_name:it.category_name||'',
        product_name:it.product_name||'', size:it.size||'',
        article_number:it.article_number||'', unit_type:it.unit_type||'Pcs',
        rate:parseFloat(it.rate)||0, quantity:parseFloat(it.quantity)||0,
        quantity_per_box:parseFloat(it.quantity_per_box)||1,
        discount_percentage:parseFloat(it.discount_percentage)||0,
        discount_amount:parseFloat(it.discount_amount)||0,
        total_amount:parseFloat(it.total_amount)||0,
        mrp:parseFloat(it.mrp)||0, hsn_code:it.hsn_code||'',
        gst_rate:parseFloat(it.gst_rate)||0, available_stock:0,
        // Preserve batch identity on edit-load so the saved batch
        // round-trips through the form even when the operator only
        // changes a non-batch field (qty, rate). Server's update path
        // uses item.batch_id to (a) snapshot cost_rate and (b) restore /
        // re-deduct per-batch on-hand for the right lot.
        batch_id: it.batch_id || null,
        is_batch_tracked: !!(it.product?.is_batch_tracked || it.batch_id),
        batch_number: it.batch?.batch_number || '',
        manufacture_date: it.batch?.manufacture_date || null,
        expiry_date: it.batch?.expiry_date || null,
      }));
      // Advance monotonic key counter above any loaded row so new items
      // added in edit mode can't collide with existing keys.
      const maxLoadedKey = loaded.reduce((m,it)=>Math.max(m, it.key||0), 0);
      nextKeyRef.current = maxLoadedKey + 1;
      setItems(loaded);
      // Mark bill as loaded so auto paid_amount effect doesn't overwrite it
      billLoadedRef.current = true;
    }catch{ message.error('Failed to load bill'); navigate('/sales'); }
    finally{ setPgLoading(false); }
  };

  const updateItem=(key,field,value)=>{
    setItems(prev=>prev.map(it=>{
      if(it.key!==key) return it;
      const u={...it,[field]:value};
      const lt=(u.quantity||0)*(u.rate||0);
      u.discount_amount=+(lt*(u.discount_percentage||0)/100).toFixed(2);
      u.total_amount=+(lt-u.discount_amount).toFixed(2);
      return u;
    }));
  };

  const navTbl=(e,ri,ci)=>{
    if(e.key!=='ArrowUp'&&e.key!=='ArrowDown') return;
    e.preventDefault();
    const nr=e.key==='ArrowDown'?Math.min(ri+1,items.length-1):Math.max(ri-1,0);
    if(nr===ri) return;
    const cell=document.getElementById(`sc-${nr}-${ci}`);
    if(cell){const inp=cell.querySelector('input');inp?.focus();inp?.select?.();}
  };

  const handleScan=async(barcode)=>{
    if(!barcode?.trim()) return;
    const code=barcode.trim();
    // Clear the input field so the next scan chars land in a clean
    // box. We deliberately DON'T re-focus barcodeRef here — for
    // batch-tracked products the drainer will move focus to the Lot
    // dropdown, and an eager barcode.focus() would steal back from
    // it on the next animation frame. Non-batch / error paths
    // re-focus barcode at the bottom for fast repeat scanning.
    setEntry(EMPTY);
    if(barcodeRef.current?.input) barcodeRef.current.input.value='';
    try{
      const{data}=await productAPI.getByBarcode(code);
      const rate=parseFloat(data.sale_rate)||0;
      const gst=parseFloat(data.gst_rate)||0;
      const qty=parseFloat(data.quantity_per_box)||1;
      const unitType=qty>1?'Box':'Pcs';
      // Batch-tracked products with the global toggle ON cannot be
      // direct-pushed into items[] — the operator needs to pick a
      // specific batch via the entry-row Lot dropdown. Route the
      // scan through the entry row, then the batch-fetch effect
      // populates the dropdown and the drainer effect focuses it.
      // Operator picks a batch (Enter or click), the Select's
      // onChange advances focus to qty, and they press ADD.
      // Without this, scanned batch products went straight to
      // items[] with batch_id=null and the server rejected the save.
      if (batchTrackingOn && data.is_batch_tracked) {
        setEntry(prev => ({
          ...prev,
          product_id: data.product_id, barcode: data.barcode,
          category_id: data.category_id,
          category_name: data.Category?.category_name || '',
          product_name: data.product_name, size: data.size_value || '',
          article_number: data.article_number || '',
          rate, mrp: parseFloat(data.mrp) || 0,
          hsn_code: data.hsn_code || '', gst_rate: gst,
          available_stock: parseFloat(data.current_stock) || 0,
          quantity: qty, unit_type: unitType,
          quantity_per_box: parseFloat(data.quantity_per_box) || 1,
          is_batch_tracked: true,
          batch_id: null, batch_number: '',
          manufacture_date: null, expiry_date: null, batch_stock: 0,
        }));
        setActiveCatId(data.category_id || null);
        message.info(`${data.product_name} — pick a batch and press ADD`, 1.5);
        // Drainer effect (watches batchOptsLoading + batchOpts) will
        // focus + open the Lot dropdown once batches finish loading.
        pendingBatchFocusRef.current = true;
        return;
      }
      const lt=+(qty*rate).toFixed(2);
      setItems(prev=>[...prev,{
        key:nextKeyRef.current++,
        product_id:data.product_id, barcode:data.barcode,
        category_id:data.category_id, category_name:data.Category?.category_name||'',
        product_name:data.product_name, size:data.size_value||'',
        article_number:data.article_number||'', unit_type:unitType,
        rate, quantity:qty, quantity_per_box:parseFloat(data.quantity_per_box)||1,
        discount_percentage:0, discount_amount:0,
        total_amount:lt, mrp:parseFloat(data.mrp)||0,
        hsn_code:data.hsn_code||'', gst_rate:gst,
        available_stock:parseFloat(data.current_stock)||0,
        is_batch_tracked: !!data.is_batch_tracked,
        batch_id: null,
      }]);
      message.success(`${data.product_name} added`,1);
      // Re-focus barcode for the next scan (non-batch fast path).
      barcodeRef.current?.focus();
    }catch{
      message.warning('Product not found');
      barcodeRef.current?.focus();
    }
  };

  // handleProdSearch — fires when user types in the Select search box
  const handleProdSearch=useCallback((v)=>{
    if(searchTimerRef.current) clearTimeout(searchTimerRef.current);
    if(!v){ if(!activeCatId) setProdOpts([]); return; }
    searchTimerRef.current=setTimeout(async()=>{
      const reqId=++searchReqRef.current;
      try{
        const{data}=await productAPI.search(v,{name_only:'true',...(activeCatId?{category_id:activeCatId}:{})});
        if(reqId!==searchReqRef.current) return;
        setProdOpts(data.data||[]);
      }catch{}
    },150);
  },[activeCatId]);

  // handleProdSel — fires when user picks a product from the Select dropdown
  const handleProdSel=useCallback((val,opt)=>{
    const p=opt?.product;
    if(!p) return;
    // Auto-fill qty from the product's quantity_per_box — that's the value
    // the purchase form stored when the stock was bought in. Box-products
    // (qpb=12) default to "1 box of 12", piece-products (qpb=1) default
    // to 1 pc. Falls back to 1 when the product was bought without a
    // P/Box set, so the qty cell is never empty after a product pick.
    const qty=parseFloat(p.quantity_per_box)||1;
    const unitType=qty>1?'Box':'Pcs';
    setActiveCatId(p.category_id||null);
    setEntry(prev=>({...prev,product_id:p.product_id,barcode:p.barcode,product_name:p.product_name,
      category_id:p.category_id,category_name:p.Category?.category_name||'',
      size:p.size_value||'',article_number:p.article_number||'',
      rate:parseFloat(p.sale_rate)||0,mrp:parseFloat(p.mrp)||0,
      hsn_code:p.hsn_code||'',gst_rate:parseFloat(p.gst_rate)||0,
      available_stock:parseFloat(p.current_stock)||0,
      quantity:qty,unit_type:unitType,quantity_per_box:parseFloat(p.quantity_per_box)||1,
      is_batch_tracked:!!p.is_batch_tracked,
      // Reset batch dimension on every product pick — the picker effect
      // below (watching product_id + godown_id) re-fetches and auto-picks
      // when the new product is batch-tracked.
      batch_id:null, batch_number:'', manufacture_date:null, expiry_date:null,
      batch_stock:0,
    }));
    // For batch-tracked products with the global toggle on, jump to
    // the Lot dropdown and open it instead of qty — the operator's
    // first decision is "which batch", not "how many." Auto-pick has
    // already populated entry.batch_id from the FEFO/FIFO winner via
    // the fetch-batches effect, so the dropdown opens with the
    // default highlighted; pressing Enter accepts it and the picker's
    // onSelect handler advances focus to qty (see Select onChange
    // below). For non-batch products, keep the historical fast-path
    // straight to qty.
    //
    // CRITICAL: justSelectedRef must stay FALSE on the batch path —
    // setting it triggers the Product field's onFocus handler, which
    // redirects focus to qty on any focus restoration. AntD's Select
    // onSelect closes the dropdown and may briefly restore focus to
    // the trigger; that focus event would then steal our batch focus.
    if (batchTrackingOn && p.is_batch_tracked) {
      // Defer the focus + open until the batch fetch completes (the
      // Select is disabled while batchOptsLoading is true). The
      // effect on batchOpts below picks up the flag and fires.
      pendingBatchFocusRef.current = true;
      requestAnimationFrame(() => prodRef.current?.blur());
    } else {
      // Flag so onFocus intercepts any AntD focus-restore and
      // redirects to qty.
      justSelectedRef.current=true;
      requestAnimationFrame(() => { prodRef.current?.blur(); qtyRef.current?.focus(); });
    }
  },[batchTrackingOn]);

  // ── Batch picker — fetch + auto-pick ─────────────────────────────────
  // Watches (product_id, is_batch_tracked, godown_id, batchTrackingOn).
  // For a batch-tracked product at a known godown with the global toggle
  // ON, fetch the FEFO/FIFO-sorted batch list and auto-pick the top row
  // (the FEFO winner if any expiry exists, else the FIFO winner). The
  // operator can override by opening the dropdown — that path goes
  // through pickBatch() below. The effect's dep array intentionally
  // omits batchTrackingOn (a runtime-flippable setting) so the picker
  // always reflects the current toggle state at fetch time.
  const watchedGodownId = Form.useWatch('godown_id', form);
  useEffect(() => {
    if (!batchTrackingOn || !entry.is_batch_tracked
        || !entry.product_id || !watchedGodownId) {
      // Clear stale options when the gating conditions are not met.
      setBatchOpts([]);
      return;
    }
    let cancelled = false;
    setBatchOptsLoading(true);
    productAPI.getBatches(entry.product_id, { godown_id: watchedGodownId })
      .then(({ data }) => {
        if (cancelled) return;
        const rows = data?.data || [];
        setBatchOpts(rows);
        // Auto-pick: first row is the FEFO/FIFO winner per the server's
        // sort. We only auto-pick when no batch is already chosen — on
        // edit-load the pre-fill from the saved bill should win.
        if (rows.length > 0 && !entry.batch_id) {
          const top = rows[0];
          setEntry(p => ({
            ...p,
            batch_id: top.batch_id,
            batch_number: top.batch_number,
            manufacture_date: top.manufacture_date,
            expiry_date: top.expiry_date,
            batch_stock: parseFloat(top.current_stock || 0),
            // Per-batch on-hand replaces the godown-level available_stock
            // for the inline stock chip — operator sees what THIS batch
            // can actually sell.
            available_stock: parseFloat(top.current_stock || 0),
          }));
        }
      })
      .catch(() => { if (!cancelled) setBatchOpts([]); })
      .finally(() => { if (!cancelled) setBatchOptsLoading(false); });
    return () => { cancelled = true; };
  // Deliberately exclude entry.batch_id from deps — re-running on a manual
  // pick would re-trigger the auto-pick branch and wipe the user's choice.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [entry.product_id, entry.is_batch_tracked, watchedGodownId, batchTrackingOn]);

  // Pending-batch-focus drainer — the handleProdSel / handleScan path
  // sets pendingBatchFocusRef when the operator binds a batch-tracked
  // product. The batch-fetch effect above runs async; the Select is
  // disabled during fetch and ignores focus/open calls. This effect
  // waits for batchOpts to populate (or the loading flag to clear),
  // then focuses the Select and opens its dropdown so the operator's
  // next keystroke lands on Lot selection. Empty-batch case (no stock
  // at this godown) still focuses the disabled Select so Tab from
  // there walks to qty — better than stranding the cursor on Product.
  useEffect(() => {
    if (!pendingBatchFocusRef.current) return;
    // Wait for the fetch to settle. batchOptsLoading flips to false
    // when the request resolves; batchOpts is the list (possibly
    // empty if no batches at godown).
    if (batchOptsLoading) return;
    pendingBatchFocusRef.current = false;
    if (batchOpts.length === 0) {
      // No batches — fall through to qty so the operator isn't stuck
      // on a disabled dropdown. The picker still renders the
      // "No batches with stock" placeholder for context.
      requestAnimationFrame(() => qtyRef.current?.focus());
      return;
    }
    requestAnimationFrame(() => {
      batchSelectRef.current?.focus();
      setBatchOpen(true);
    });
  }, [batchOptsLoading, batchOpts]);

  // Manual override — fires when the operator opens the dropdown and
  // picks a different batch. We re-read available_stock from the picked
  // batch so the qty chip + addItem stock guard track the per-batch
  // on-hand rather than the godown total.
  const pickBatch = (batchId) => {
    const batch = batchOpts.find(b => b.batch_id === batchId);
    if (!batch) return;
    setEntry(p => ({
      ...p,
      batch_id: batch.batch_id,
      batch_number: batch.batch_number,
      manufacture_date: batch.manufacture_date,
      expiry_date: batch.expiry_date,
      batch_stock: parseFloat(batch.current_stock || 0),
      available_stock: parseFloat(batch.current_stock || 0),
    }));
  };

  // Days-until-expiry for chip rendering. null → no expiry on file →
  // no chip. Positive → days to go. Negative → expired N days ago.
  const daysUntilExpiry = (expiryDate) => {
    if (!expiryDate) return null;
    const today = dayjs().startOf('day');
    return dayjs(expiryDate).startOf('day').diff(today, 'day');
  };

  const ue=(f,v)=>setEntry(p=>({...p,[f]:v}));

  const eKey=(e,idx)=>{
    if(e.key==='Enter'||e.key==='ArrowDown'){
      e.preventDefault();
      if(idx>=eRefs.length-1){addItem();}
      else{const n=eRefs[idx+1];n?.current?.focus();n?.current?.select?.();}
    }else if(e.key==='ArrowUp'){
      e.preventDefault();
      if(idx>0){const p=eRefs[idx-1];p?.current?.focus();p?.current?.select?.();}
      else{barcodeRef.current?.focus();}
    }
  };

  const addItem=useCallback(()=>{
    if(!entry.product_name){message.warning('Enter product name');return;}
    if(!entry.quantity||entry.quantity<=0){message.warning('Enter quantity');return;}
    if(!entry.rate||entry.rate<=0){message.warning('Enter rate');return;}
    // Batch enforcement — mirror of the server-side guard. With the
    // global setting ON and the picked product batch-tracked, the line
    // MUST carry batch_id; otherwise the dropdown is disabled (no
    // batches with stock) and the operator should pick a different
    // product or wait for a purchase to land.
    if(batchTrackingOn && entry.is_batch_tracked && !entry.batch_id){
      if(batchOpts.length === 0){
        message.warning(`"${entry.product_name}" has no batches with stock at this godown.`);
      } else {
        message.warning(`"${entry.product_name}" is batch-tracked. Pick a batch.`);
      }
      return;
    }
    // Per-batch stock guard — overrides the godown-level chip when a
    // batch is picked. Allows the line to add but warns; server rejects
    // hard via validateBatchLine.
    if(entry.batch_id && entry.batch_stock > 0 && entry.quantity > entry.batch_stock){
      message.warning(`Batch ${entry.batch_number} has only ${entry.batch_stock} available at this godown. Reduce qty or pick another batch.`);
    } else if(entry.available_stock>0&&entry.quantity>entry.available_stock){
      message.warning(`Low stock! Available: ${entry.available_stock}`);
    }
    // Block expired sales pre-flight — server enforces too, but the
    // form-side check spares the user a round trip on the obvious case.
    if(blockExpiredSales && entry.batch_id && entry.expiry_date){
      const d = daysUntilExpiry(entry.expiry_date);
      if(d != null && d < 0){
        message.error(`Batch ${entry.batch_number} expired ${dayjs(entry.expiry_date).format('DD MMM YYYY')}. "Block sales of expired batches" is enabled in Settings.`);
        return;
      }
    }
    const lt=+(entry.quantity*entry.rate).toFixed(2);
    const da=+(lt*(entry.discount_percentage||0)/100).toFixed(2);
    setItems(prev=>[...prev,{...entry,key:nextKeyRef.current++,total_amount:lt-da,discount_amount:da}]);
    setActiveCatId(null); // triggers useEffect → clears prodOpts automatically
    setProdOpen(false);
    setEntry(EMPTY);
    setTimeout(()=>barcodeRef.current?.focus(),50);
  },[entry, batchTrackingOn, batchOpts, blockExpiredSales]);

  const removeItem=(key)=>setItems(prev=>prev.filter(i=>i.key!==key));

  /* ── totals ── */
  const discPct    = Form.useWatch('discount_percentage',form)||0;
  const paidAmt    = Form.useWatch('paid_amount',form)||0;
  const splDisc    = Form.useWatch('special_discount',form)||0;
  const otherChr   = Form.useWatch('other_charges',form)||0;
  const freightChr = Form.useWatch('freight_charges',form)||0;
  const returnAmt  = Form.useWatch('return_amount',form)||0;
  const customerId = Form.useWatch('customer_id',form);

  const paymentMethod = Form.useWatch('payment_method', form) || 'Cash';
  // In amount-only mode, treat the single amount as the line total —
  // skips discount math entirely (amount-mode disables those fields).
  const _amountModeBase = billMode === 'amount' ? (parseFloat(amountVal) || 0) : 0;
  const subTotal    = billMode === 'amount'
    ? _amountModeBase
    : items.reduce((s,i)=>s+(i.quantity||0)*(i.rate||0),0);
  const itemDiscTot = billMode === 'amount' ? 0 : items.reduce((s,i)=>s+(i.discount_amount||0),0);
  const billDiscAmt = billMode === 'amount' ? 0 : +(subTotal*discPct/100).toFixed(2);

  // Sync ₹ disc display when % changes (and user isn't mid-typing in ₹ box)
  useEffect(()=>{
    if(!discAmtEditingRef.current) setDiscAmtVal(billDiscAmt||0);
  },[billDiscAmt]);
  const taxableAmt  = +(subTotal-itemDiscTot-billDiscAmt).toFixed(2);
  // Pro-rate the bill-level (trade) discount across each already-item-discounted
  // line so GST applies to the fully discounted base (GST law "transaction
  // value"). Without this, a bill-level discount left GST unchanged and total
  // drifted from the backend's bill-wise calculation.
  const postItemBase = +(subTotal - itemDiscTot).toFixed(2);
  const billDiscRatio = postItemBase > 0 ? billDiscAmt / postItemBase : 0;
  // Amount-mode preview tax = amount × gst_rate. Server splits intra/
  // inter automatically based on customer state vs company state — for
  // the live preview, derive intra/inter heuristically from the selected
  // party so the displayed split matches what the bill will actually post.
  const _amountModeTax = billMode === 'amount'
    ? +((parseFloat(amountVal) || 0) * (parseFloat(amountGstRate) || 0) / 100).toFixed(2)
    : 0;
  const productGST  = billMode === 'amount'
    ? _amountModeTax
    : +items.reduce((s,i)=>{
        const lt=(i.quantity||0)*(i.rate||0)-(i.discount_amount||0);
        const lineTaxable = lt * (1 - billDiscRatio);
        return s+lineTaxable*((i.gst_rate||0)/100);
      },0).toFixed(2);
  // Inter-state heuristic for preview: customer state code != company
  // state code. Falls back to intra-state when unknown.
  const _isInterPreview = (() => {
    if (billMode !== 'amount') return false;   // only matters for amount-mode preview
    const custCode = selectedParty?.gstin?.slice(0, 2) || '';
    const companyCode = (company || '').match(/\b(\d{2})/)?.[1] || '';
    return custCode && companyCode && custCode !== companyCode;
  })();
  // In product-wise mode: derive effective % from item totals; in bill-wise: use manual inputs
  const effCgstPct  = billMode === 'amount'
    ? (_isInterPreview ? 0 : (parseFloat(amountGstRate) || 0) / 2)
    : (gstMode==='bill' ? (cgstPct||0) : (taxableAmt>0 ? +(productGST/2/taxableAmt*100).toFixed(2) : 0));
  const effSgstPct  = billMode === 'amount' ? effCgstPct
    : (gstMode==='bill' ? (sgstPct||0) : effCgstPct);
  const cgst        = billMode === 'amount'
    ? (_isInterPreview ? 0 : +(productGST/2).toFixed(2))
    : (gstMode==='bill' ? +(taxableAmt*(cgstPct||0)/100).toFixed(2) : +(productGST/2).toFixed(2));
  const sgst        = billMode === 'amount'
    ? (_isInterPreview ? 0 : +(productGST - cgst).toFixed(2))
    : (gstMode==='bill' ? +(taxableAmt*(sgstPct||0)/100).toFixed(2) : +(productGST/2).toFixed(2));
  const igstAmt     = billMode === 'amount'
    ? (_isInterPreview ? productGST : 0)
    : +(taxableAmt*(igstPct||0)/100).toFixed(2);
  const effectiveGST= +(cgst+sgst).toFixed(2);
  const totalGST    = +(effectiveGST+igstAmt).toFixed(2);
  const rawTotal    = taxableAmt+totalGST
    +parseFloat(otherChr||0)
    +parseFloat(freightChr||0);
  // Tally rounds every voucher to the nearest rupee and records the
  // residue as a round_off ledger. We mirror that: the displayed net
  // total is always an integer, and the fractional difference lands in
  // round_off automatically. This keeps the edit form total in lock-step
  // with the list total (which also shows the rounded value).
  const roundedTotal = Math.round(rawTotal);
  const roundOff     = +(roundedTotal - rawTotal).toFixed(2);
  const maxPaid     = Math.max(0, roundedTotal - parseFloat(returnAmt || 0));
  const balance     = +(roundedTotal - parseFloat(returnAmt||0) - Math.min(paidAmt, maxPaid)).toFixed(2);
  const changeDue   = paymentMethod === 'Cash' ? Math.max(0, +((cashReceived || 0) - roundedTotal).toFixed(2)) : 0;
  const totalQty = items.reduce((s,i)=>s+(i.quantity||0),0);
  // Box count: quantity is always stored as pieces, so boxes = qty / qpb
  const boxQty = items.reduce((s,i)=>{
    const qpb = parseFloat(i.quantity_per_box)||1;
    return s + (i.quantity||0) / qpb;
  },0);

  // Auto-scroll table body to bottom whenever a new item is added.
  // useLayoutEffect runs in the commit phase BEFORE paint, so the new
  // row is already at the bottom in the very first rendered frame —
  // no visible "stretch then snap back" flicker that a rAF-scheduled
  // scroll would cause (new row paints at frame 1, scroll catches up
  // at frame 2, producing a one-frame jitter with many rows).
  const prevItemsLenRef = useRef(0);
  useLayoutEffect(()=>{
    const prev = prevItemsLenRef.current;
    prevItemsLenRef.current = items.length;
    if(items.length > prev && items.length > 0){
      const body = tableWrapRef.current?.querySelector('.ant-table-body');
      if(body) body.scrollTop = body.scrollHeight;
    }
  },[items.length]);

  /* Sync selectedParty whenever customerId or parties list changes */
  useEffect(()=>{
    if(customerId && parties.length){
      setSelectedParty(parties.find(p=>p.party_id===customerId)||null);
    } else if(!customerId){
      setSelectedParty(null);
    }
  },[customerId, parties]);

  /* Reset paidEditedRef and cashReceived when customer changes so auto-fill works fresh */
  useEffect(()=>{
    paidEditedRef.current = false;
    setCashReceived(0);
  },[customerId]);

  /* Auto-fill paid amount based on credit policy.
     Fix: for credit customers, skip auto-fill if user already manually set paid_amount
     so that editing items doesn't overwrite their entry. */
  useEffect(()=>{
    // Skip auto-fill if we just loaded an existing bill
    if(isEdit && billLoadedRef.current){
      billLoadedRef.current = false;
      return;
    }
    const ret = parseFloat(returnAmt||0);
    const due = Math.max(0, +(roundedTotal - ret).toFixed(2));
    if(!customerId){
      // Walk-in cash sale — always track total (no credit involved)
      form.setFieldValue('paid_amount', due||0);
    } else {
      const party = parties.find(p=>p.party_id===customerId);
      if(party && !party.credit_allowed){
        // Credit NOT allowed — force full payment minus return
        form.setFieldValue('paid_amount', due||0);
      } else if(party && party.credit_allowed){
        // Credit allowed — only auto-set once when customer is first selected;
        // if user has manually edited paid_amount, leave it alone
        if(!paidEditedRef.current){
          form.setFieldValue('paid_amount', 0);
        }
      }
    }
  },[customerId, roundedTotal, returnAmt, parties]);

  /* ── save ── */
  const handleSave=useCallback(async(payFull=false)=>{
    // Re-entrancy guard — a second Ctrl+Enter / double-click during the API
    // round-trip would create a duplicate bill (duplicate stock outflow, wrong
    // customer balance, wrong GST totals).
    if(submittingRef.current) return;
    try{
      const vals=await form.validateFields();
      // Mode-specific validation
      if (billMode === 'amount') {
        const amt = parseFloat(amountVal);
        if (!isFinite(amt) || amt <= 0) { message.warning('Enter an amount greater than 0'); return; }
        const r = parseFloat(amountGstRate);
        if (!isFinite(r) || r < 0 || r > 100) { message.warning('Enter a valid GST rate (0-100)'); return; }
      } else {
        if(items.length===0){message.warning('Add at least one item');return;}
      }
      // Block save if credit not allowed and effective payment (paid + return) is less than total
      if(selectedParty && !selectedParty.credit_allowed){
        const paid = payFull ? roundedTotal : (parseFloat(vals.paid_amount)||0);
        const ret  = parseFloat(vals.return_amount||0);
        if(paid + ret < roundedTotal){
          message.error(`Credit is not allowed for "${selectedParty.party_name}". Full payment required (Paid + Return must equal Total).`);
          return;
        }
      }
      // Block over-payment (paid + return > total). Customer ledger must
      // never receive an un-authorised credit from a data-entry typo.
      {
        const paid = payFull ? roundedTotal : (parseFloat(vals.paid_amount)||0);
        const ret  = parseFloat(vals.return_amount||0);
        if(paid + ret > roundedTotal + 0.01){
          message.error(`Paid + Return (₹${(paid+ret).toFixed(2)}) exceeds bill total (₹${roundedTotal.toFixed(2)}).`);
          return;
        }
      }
      // Blacklist block (client-side fast-fail). Backend enforces this too,
      // but catching it here avoids a round-trip and keeps the offending
      // bill visible on screen so the operator can cancel or switch party.
      if (selectedParty?.party_status === 'Blacklist') {
        message.error(`"${selectedParty.party_name}" is Blacklisted. Remove the flag on the party record before transacting.`);
        return;
      }
      // Credit-limit pre-check. Computed against projected outstanding:
      //   current balance + (total − paid at billing − return).
      // Backend enforces as the last word; this is purely to warn before the
      // round-trip and let the operator adjust Paid / Discount first.
      if (selectedParty) {
        const limit = parseFloat(selectedParty.credit_limit || 0);
        if (limit > 0) {
          const currentBal = parseFloat(selectedParty.current_balance || 0);
          const paid = payFull ? roundedTotal : (parseFloat(vals.paid_amount) || 0);
          const ret  = parseFloat(vals.return_amount || 0);
          const thisBillOutstanding = +(roundedTotal - paid - ret).toFixed(2);
          const projected = +(currentBal + thisBillOutstanding).toFixed(2);
          if (projected > limit + 0.01) {
            message.error(
              `Credit limit exceeded for "${selectedParty.party_name}": ` +
              `₹${currentBal.toFixed(2)} of ₹${limit.toFixed(2)} already owed; this bill would take it to ₹${projected.toFixed(2)}. ` +
              `Take part-payment or raise the limit on the party record.`,
              6
            );
            return;
          }
        }
      }
      submittingRef.current=true;
      setLoading(true);
      // If the operator added counter-return items inline, send them so
      // the backend creates a paired SalesReturnBill in the same txn.
      // Walk-in cash sales (no customer_id) can't have a paired return —
      // there's no party ledger to credit — so block before save.
      const hasInlineReturn = inlineReturnItems.length > 0;
      if (hasInlineReturn && !vals.customer_id) {
        message.error('Inline returns require a customer (walk-in cash sales cannot have a paired return).');
        return;
      }
      // Common header fields used by BOTH modes
      // walk_in_name is only meaningful for the system Cash party (and
      // empty otherwise). Always send it so the backend column gets a
      // clean overwrite when the operator switches a non-cash bill back
      // to Cash mid-edit. Trim + cap at 120 chars (the column width).
      const walkIn = String(vals.walk_in_name || '').trim().slice(0, 120);
      const commonBody = {
        // Issuing godown — picked in the header strip; the controller
        // routes per-godown stock writes against this id and uses it for
        // GST place-of-supply (later phase).
        godown_id: vals.godown_id,
        customer_id:vals.customer_id||null,
        walk_in_name: walkIn || null,
        bill_date:vals.bill_date.format('YYYY-MM-DD'),
        due_date:vals.due_date?.format('YYYY-MM-DD'),
        sale_type:vals.sale_type||'Retail',
        salesman_name:vals.salesman_name||'',
        special_discount:parseFloat(splDisc)||0,
        other_charges:parseFloat(otherChr)||0,
        freight_charges:parseFloat(freightChr)||0,
        // When inline_return is sent the backend zeros this column anyway
        // (the SalesReturnBill is the single source of truth — see comment
        // in salesController.createInlineReturn). Sending 0 here keeps the
        // wire payload self-explanatory and avoids the double-counting
        // window even if a future migration reads the field directly.
        return_amount: hasInlineReturn ? 0 : (parseFloat(returnAmt)||0),
        payment_method:vals.payment_method||'Cash',
        remarks:(vals.remarks||'').trim(),
        // payFull = "Save & Receive": settle the bill in full. With inline
        // returns the customer's actual cash exchange is (total − return),
        // not the gross total — otherwise the validation `paid + return >
        // total` rejects the save and the customer's balance overstates.
        paid_amount: payFull
          ? Math.max(0, roundedTotal - (hasInlineReturn ? inlineReturnTotal : (parseFloat(returnAmt)||0)))
          : (vals.paid_amount||0),
        bill_mode: billMode,
        // If this form was recalled from a draft, pass the draft_id so the
        // backend deletes it inside the bill-creation transaction (race-safe).
        draft_id: recalledDraftId || undefined,
        // Inline return: paired SalesReturnBill created in same txn.
        inline_return: hasInlineReturn ? {
          items: inlineReturnItems.map(i => ({
            product_id: i.product_id, barcode: i.barcode,
            category_id: i.category_id, category_name: i.category_name,
            product_name: i.product_name, size: i.size,
            article_number: i.article_number, hsn_code: i.hsn_code,
            unit_type: i.unit_type || 'Pcs',
            quantity: i.quantity, rate: i.rate, mrp: i.mrp,
            gst_rate: i.gst_rate,
          })),
          reason: 'Return at counter (paired with sale)',
        } : undefined,
      };
      // Mode-specific body shape
      const body = billMode === 'amount' ? {
        ...commonBody,
        amount:      parseFloat(amountVal),
        gst_rate:    parseFloat(amountGstRate) || 0,
        hsn_code:    (amountHsnCode || '9999').trim(),
        description: (amountDesc || '').trim(),
      } : {
        ...commonBody,
        discount_percentage:discPct,
        discount_amount:billDiscAmt,
        // Explicit mode flag so backend treats 0% bill-wise GST (exempt items)
        // as bill-wise, not as accidental product-wise fallback.
        gst_mode:gstMode,
        cgst_pct:parseFloat(cgstPct)||0,
        sgst_pct:parseFloat(sgstPct)||0,
        igst_pct:parseFloat(igstPct)||0,
        items:items.map(i=>({
          product_id:i.product_id,barcode:i.barcode,
          category_id:i.category_id,category_name:i.category_name,
          product_name:i.product_name,size:i.size,
          article_number:i.article_number,hsn_code:i.hsn_code,
          unit_type:i.unit_type||'Pcs',
          quantity:i.quantity,rate:i.rate,mrp:i.mrp,
          discount_percentage:i.discount_percentage,gst_rate:i.gst_rate,
          quantity_per_box:parseFloat(i.quantity_per_box)||1,
          batch_id: i.batch_id || null,
        })),
      };
      const{data}=isEdit?await salesAPI.update(id,body):await salesAPI.create(body);
      message.success(`Bill ${data.bill_number} ${isEdit?'updated':'saved'}!`);
      if(isEdit){
        navigate(backTarget);
      } else {
        handleReset();
        setBillNo('');
      }
    }catch(e){message.error(e.response?.data?.error||'Failed to save');}
    finally{setLoading(false); submittingRef.current=false;}
  },[form,items,discPct,billDiscAmt,roundedTotal,splDisc,otherChr,freightChr,returnAmt,isEdit,id,navigate,backTarget,selectedParty,billMode,amountVal,amountGstRate,amountHsnCode,amountDesc,recalledDraftId,gstMode,cgstPct,sgstPct,igstPct]);

  const handleReset=()=>{
    setItems([]);setEntry(EMPTY);
    setActiveCatId(null); setProdOpen(false);
    form.resetFields(['customer_id','walk_in_name','due_date','discount_percentage','paid_amount','return_amount','special_discount','other_charges','freight_charges','salesman_name','remarks']);
    setAmountVal(''); setAmountGstRate(0); setAmountHsnCode(''); setAmountDesc('');
    setRecalledDraftId(null);
    setInlineReturnItems([]);
    setTimeout(()=>barcodeRef.current?.focus(),50);
  };

  /* ── Hold (save as draft) ──
   * Captures the entire form state into the sales_bill_drafts table.
   * No bill_number is consumed; no stock changes; no party balance
   * change; report-invisible. Recall reloads it into the form.
   *
   * Hold is intentionally permissive — it does NOT require items or
   * customer to be set, because the whole point is to mid-save when
   * the customer steps away. The only gate is: a held draft must have
   * SOMETHING worth holding (at least a customer OR items OR amount).
   */
  const handleHold = useCallback(async () => {
    if (holdLoading || submittingRef.current) return;
    if (isEdit) {
      message.warning('Editing an existing bill — Hold only applies to new bills. Use Back to discard changes.');
      return;
    }
    const vals = form.getFieldsValue();
    const hasItems = items.length > 0;
    const hasAmount = billMode === 'amount' && parseFloat(amountVal) > 0;
    const hasCustomer = !!vals.customer_id;
    if (!hasItems && !hasAmount && !hasCustomer) {
      message.warning('Nothing to hold — pick a customer, add an item, or enter an amount first.');
      return;
    }
    setHoldLoading(true);
    try {
      const payload = {
        // Reuse the same shape handleSave builds, so Recall can replay it
        // directly into the form's state setters. We don't validate here —
        // the user is mid-entry and the data may be incomplete by design.
        bill_mode: billMode,
        customer_id: vals.customer_id || null,
        walk_in_name: String(vals.walk_in_name || '').trim() || null,
        bill_date: vals.bill_date ? vals.bill_date.format('YYYY-MM-DD') : null,
        due_date: vals.due_date ? vals.due_date.format('YYYY-MM-DD') : null,
        sale_type: vals.sale_type || 'Retail',
        salesman_name: vals.salesman_name || '',
        special_discount: parseFloat(splDisc) || 0,
        other_charges: parseFloat(otherChr) || 0,
        freight_charges: parseFloat(freightChr) || 0,
        return_amount: parseFloat(returnAmt) || 0,
        payment_method: vals.payment_method || 'Cash',
        remarks: (vals.remarks || '').trim(),
        paid_amount: parseFloat(vals.paid_amount) || 0,
        discount_percentage: discPct,
        gst_mode: gstMode,
        cgst_pct: parseFloat(cgstPct) || 0,
        sgst_pct: parseFloat(sgstPct) || 0,
        igst_pct: parseFloat(igstPct) || 0,
        items: billMode === 'item' ? items.map(i => ({
          product_id: i.product_id, barcode: i.barcode,
          category_id: i.category_id, category_name: i.category_name,
          product_name: i.product_name, size: i.size,
          article_number: i.article_number, hsn_code: i.hsn_code,
          unit_type: i.unit_type || 'Pcs',
          quantity: i.quantity, rate: i.rate, mrp: i.mrp,
          discount_percentage: i.discount_percentage, gst_rate: i.gst_rate,
          quantity_per_box: parseFloat(i.quantity_per_box) || 1,
          batch_id: i.batch_id || null,
        })) : [],
        // Amount-mode echo
        amount: billMode === 'amount' ? parseFloat(amountVal) || 0 : null,
        gst_rate: billMode === 'amount' ? parseFloat(amountGstRate) || 0 : null,
        hsn_code: billMode === 'amount' ? (amountHsnCode || '9999') : null,
        description: billMode === 'amount' ? (amountDesc || '') : null,
        // Denormalised for the list UI
        _total_preview: roundedTotal || 0,
      };
      // If we're holding a recalled draft (operator hit Hold instead of
      // Save after editing), update in place instead of creating a copy.
      if (recalledDraftId) {
        await salesDraftAPI.update(recalledDraftId, payload);
        message.success('Draft updated — form cleared for next bill');
      } else {
        const { data } = await salesDraftAPI.create(payload);
        message.success(`Held as ${data.draft_number} — form cleared for next bill`);
      }
      // Clear the form so the operator can start the next bill, but
      // STAY on the bill form (per user request — don't navigate to /sales).
      handleReset();
      setBillMode('item');
      // Clear the recalled-draft binding too so the next Hold creates a
      // fresh draft (instead of updating the one we just held).
      setRecalledDraftId(null);
      // Refresh the local drafts list so the new entry appears in the
      // in-form Drafts modal immediately.
      loadDrafts();
    } catch (e) {
      message.error(e.response?.data?.error || 'Failed to hold');
    } finally {
      setHoldLoading(false);
    }
  }, [form, items, billMode, amountVal, amountGstRate, amountHsnCode, amountDesc, splDisc, otherChr, freightChr, returnAmt, discPct, gstMode, cgstPct, sgstPct, igstPct, roundedTotal, recalledDraftId, holdLoading, isEdit]);

  /* ── Recall logic — extracted as a callback so the in-form Drafts
   * modal can call it directly (without a route change). The mount
   * effect below also uses it for the URL-state path.
   *
   * The draft is NOT deleted here — it stays alive until the recalled
   * bill is successfully saved (handleSave passes draft_id to the
   * backend, which deletes it inside the same txn).
   */
  const recallDraft = useCallback(async (draftId) => {
    try {
      const { data: draft } = await salesDraftAPI.get(draftId);
      const p = draft.payload || {};
      // Restore mode FIRST so subsequent setters land in the right branch
      const mode = p.bill_mode === 'amount' ? 'amount' : 'item';
      setBillMode(mode);
      setRecalledDraftId(draft.draft_id);
      form.setFieldsValue({
        customer_id:        p.customer_id || undefined,
        walk_in_name:       p.walk_in_name || '',
        bill_date:          p.bill_date ? dayjs(p.bill_date) : dayjs(),
        due_date:           p.due_date  ? dayjs(p.due_date)  : undefined,
        sale_type:          p.sale_type || 'Retail',
        salesman_name:      p.salesman_name || '',
        payment_method:     p.payment_method || 'Cash',
        remarks:            p.remarks || '',
        paid_amount:        p.paid_amount || 0,
        return_amount:      p.return_amount || 0,
        discount_percentage:p.discount_percentage || 0,
        special_discount:   p.special_discount || 0,
        other_charges:      p.other_charges || 0,
        freight_charges:    p.freight_charges || 0,
      });
      if (mode === 'item') {
        setItems((p.items || []).map((it, idx) => ({ ...it, key: idx })));
        setGstMode(p.gst_mode || 'product');
        setCgstPct(p.cgst_pct || 0);
        setSgstPct(p.sgst_pct || 0);
        setIgstPct(p.igst_pct || 0);
      } else {
        setAmountVal(p.amount || '');
        setAmountGstRate(p.gst_rate || 0);
        setAmountHsnCode(p.hsn_code || '');
        setAmountDesc(p.description || '');
      }
      message.success(`Recalled ${draft.draft_number}`);
    } catch (e) {
      message.error('Failed to recall draft: ' + (e.response?.data?.error || e.message));
    }
  }, [form]);

  // Honour ?recallDraft state on mount (when navigated here from /sales).
  useEffect(() => {
    const draftId = location.state?.recallDraft;
    if (draftId) recallDraft(draftId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Warn on tab close/refresh when there's in-progress work. Declared
  // here (above the Drafts block) because handleRecallDraft depends on it.
  const dirty = items.length > 0 || (billMode === 'amount' && parseFloat(amountVal) > 0);
  const confirmLeave = useUnsavedChangesWarning(dirty);

  /* ── In-form Drafts list ─────────────────────────────────────
   * Operators want to see and recall held drafts without leaving
   * the bill form. This duplicates the SalesList Drafts modal but
   * scoped to the form so it's one click away during data entry.
   */
  const [drafts, setDrafts] = useState([]);
  const [draftsModalOpen, setDraftsModalOpen] = useState(false);
  // Index of the keyboard-selected draft card. Reset to 0 each time the
  // modal opens so Enter always recalls the top item by default.
  const [selectedDraftIdx, setSelectedDraftIdx] = useState(0);
  const draftCardRefs = useRef([]);
  const loadDrafts = useCallback(async () => {
    try {
      const { data } = await salesDraftAPI.list();
      setDrafts(data?.data || []);
    } catch { /* silent — drafts pill just shows 0 */ }
  }, []);
  useEffect(() => { loadDrafts(); }, [loadDrafts]);
  useEffect(() => { if (draftsModalOpen) setSelectedDraftIdx(0); }, [draftsModalOpen]);

  /* Recall a draft after the unsaved-work prompt. Shared by mouse click
     and Enter-key path so behaviour stays consistent. */
  const handleRecallDraft = useCallback(async (d) => {
    if (!d) return;
    if (dirty) {
      const proceed = await new Promise(res => {
        Modal.confirm({
          title: 'Replace current bill?',
          content: 'You have unsaved work in the form. Recalling will replace it. Continue?',
          okText: 'Recall', cancelText: 'Cancel',
          onOk: () => res(true), onCancel: () => res(false),
        });
      });
      if (!proceed) return;
    }
    setDraftsModalOpen(false);
    await recallDraft(d.draft_id);
  }, [dirty, recallDraft]);

  /* Keyboard navigation inside the Drafts modal — Up/Down to move,
     Enter to recall the selected card, Delete to discard it. */
  useEffect(() => {
    if (!draftsModalOpen || drafts.length === 0) return;
    const onKey = (e) => {
      // Don't hijack typing inside a child modal (e.g. confirm dialog).
      if (document.querySelector('.ant-modal-confirm')) return;
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setSelectedDraftIdx(i => Math.min(i + 1, drafts.length - 1));
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        setSelectedDraftIdx(i => Math.max(i - 1, 0));
      } else if (e.key === 'Home') {
        e.preventDefault();
        setSelectedDraftIdx(0);
      } else if (e.key === 'End') {
        e.preventDefault();
        setSelectedDraftIdx(drafts.length - 1);
      } else if (e.key === 'Enter') {
        e.preventDefault();
        const d = drafts[selectedDraftIdx];
        if (d) handleRecallDraft(d);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [draftsModalOpen, drafts, selectedDraftIdx, handleRecallDraft]);

  /* Scroll the selected card into view as the user moves with arrows. */
  useEffect(() => {
    if (!draftsModalOpen) return;
    const el = draftCardRefs.current[selectedDraftIdx];
    el?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }, [selectedDraftIdx, draftsModalOpen]);

  useCtrlEnterSubmit(()=>handleSave(true));

  // F4 = Hold draft (only on new bills, not edits).
  useEffect(() => {
    if (isEdit) return;
    const handler = (e) => {
      if (e.key === 'F4') { e.preventDefault(); handleHold(); }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [isEdit, handleHold]);

  /* ─── Table columns ─────────────────────────────────────────────────────── */
  /* Excel-style cells: inputs fill the whole cell (no floating pill).
     numCell/txtCell no longer accept a fixed width — CSS handles it.
     The wrapping div still carries id="sc-ri-ci" for arrow-key nav. */
  const numCell=(ri,ci,val,field,min)=>(
    <div id={`sc-${ri}-${ci}`}>
      <InputNumber keyboard={false} variant="borderless" value={val}
        onChange={v=>updateItem(items[ri]?.key,field,v??0)}
        onKeyDown={e=>navTbl(e,ri,ci)} min={min??0}
        size="small"/>
    </div>
  );
  const txtCell=(ri,ci,val,field)=>(
    <div id={`sc-${ri}-${ci}`}>
      <Input variant="borderless" value={val}
        onChange={e=>updateItem(items[ri]?.key,field,e.target.value)}
        onKeyDown={e=>navTbl(e,ri,ci)}
        size="small"/>
    </div>
  );

  const readCell=(v,style={})=>(
    <span style={{fontSize:13,fontWeight:500,...style}}>{v||'—'}</span>
  );

  const cols=[
    {title:'#',width:40,align:'center',render:(_,__,i)=><span style={{color:'var(--fg-tertiary)',fontSize:13,fontWeight:600,textAlign:'center'}}>{i+1}</span>},
    {title:'Barcode',dataIndex:'barcode',width:120,render:(v)=>readCell(v,{color:'var(--fg-secondary)'})},
    {title:'Product Name',dataIndex:'product_name',width:220,render:(v)=>readCell(v,{color:'var(--fg-primary)',fontWeight:600})},
    {title:'Size',dataIndex:'size',width:70,render:(v)=>readCell(v,{color:'var(--fg-tertiary)'})},
    {title:'Unit',dataIndex:'unit_type',width:70,align:'center',render:(v)=>(
      <span style={{fontSize:12,fontWeight:600,color:'var(--fg-secondary)',textAlign:'center'}}>{v||'Pcs'}</span>
    )},
    {title:'Art#',dataIndex:'article_number',width:80,render:(v)=>readCell(v,{color:'var(--fg-tertiary)'})},
    {title:'Qty',dataIndex:'quantity',width:80,align:'center',className:'num-cell',render:(v,r,ri)=>numCell(ri,5,v,'quantity',0)},
    {title:'Rate ₹',dataIndex:'rate',width:110,align:'right',className:'num-cell',render:(v,r,ri)=>numCell(ri,6,v,'rate',0)},
    {title:'Disc%',dataIndex:'discount_percentage',width:70,align:'right',className:'num-cell',render:(v,r,ri)=>numCell(ri,7,v,'discount_percentage',0)},
    {title:'GST%',dataIndex:'gst_rate',width:70,align:'right',className:'num-cell',render:(v,r,ri)=>numCell(ri,8,v,'gst_rate',0)},
    {title:'Amount ₹',width:120,align:'right',className:'num-cell',render:(_,r)=>{
      const lt=(r.quantity||0)*(r.rate||0);
      const da=lt*(r.discount_percentage||0)/100;
      return <span style={{color:'var(--fg-primary)',fontWeight:700,fontSize:13,fontFamily:'inherit',fontVariantNumeric:'tabular-nums',textAlign:'right'}}>{fmtN(lt-da)}</span>;
    }},
    {title:'',width:36,align:'center',render:(_,r)=>(
      <button onClick={()=>removeItem(r.key)}
        style={{background:'none',border:'none',cursor:'pointer',color:'var(--danger)',
          padding:'6px 8px',borderRadius:0,lineHeight:1,fontSize:16,width:'100%',height:'100%'}}>×</button>
    )},
  ];

  /* ─── Status badge (Paid / Balance / Overpaid) ───────────────────────── */
  const isOverpaid = balance < -0.001;
  const isDue      = balance > 0.001;
  const statusClass = isDue ? 'due' : isOverpaid ? 'over' : 'paid';
  const statusLabel = isDue ? 'Balance due' : isOverpaid ? 'Overpaid' : 'Paid in full';

  /* ─── render ─────────────────────────────────────────────────────────── */
  return (
    <Form form={form} component={false}>
      <div className="sbf-page">

        {/* ═══════════════════════════════ (1) TOP ════════════════════════════ */}
        <section className="sbf-top">
          {/* Compact header strip — full-width, single row.
              LEFT  : doc-type chip + Bill-no box + Mode toggle (inline)
              MIDDLE: company name (chipped — visually parallel to doc chip)
              RIGHT : bill date + due date (no labels, pinned to right edge) */}
          <div className="sbf-top-head sbf-top-head--compact">
            <div className="sbf-top-head-left">
              <span className="sbf-chip">
                {isEdit ? 'Edit Sales Bill' : 'Sales Invoice'}
              </span>
              {/* Bill number now sits in its own box. Label and value share
                  the SAME font size so the eye reads them as one unit. */}
              <span className="sbf-billno-box">
                <span className="sbf-billno-lbl">Bill no.</span>
                <span className="sbf-billno-val">{billNo || nextBillNoPreview || '…'}</span>
              </span>
              {/* Apple-style mode toggle — minimal pill, white sliding thumb
                  on a soft gray track. Hidden when amount-only is disabled. */}
              {amountOnlyEnabled && (
                <div className={`sbf-mode-apple ${billMode === 'amount' ? 'is-amount' : 'is-item'}`} role="tablist">
                  <span className="sbf-mode-apple-thumb" aria-hidden />
                  <button type="button" role="tab" aria-selected={billMode === 'item'}
                    className={`sbf-mode-apple-opt ${billMode === 'item' ? 'active' : ''}`}
                    onClick={() => { setBillMode('item'); setAmountVal(''); }}>
                    Items
                  </button>
                  <button type="button" role="tab" aria-selected={billMode === 'amount'}
                    className={`sbf-mode-apple-opt ${billMode === 'amount' ? 'active' : ''}`}
                    onClick={() => { setBillMode('amount'); setItems([]); setEntry(EMPTY); }}>
                    Amount
                  </button>
                </div>
              )}
              {recalledDraftId && (
                <span className="sbf-mode-recalled">Recalled draft</span>
              )}
            </div>
            {company && (
              <div className="sbf-top-head-center">
                <span className="sbf-chip sbf-chip-company" title={company}>{company}</span>
              </div>
            )}
            <div className="sbf-top-head-right">
              {/* Issuing godown lives in the header strip alongside the
                  date pickers — same height (size="small"), pinned to the
                  right of the row. Disabled on edit because moving
                  inventory between godowns is the Stock Transfer flow,
                  not bill-edit. */}
              <Form.Item name="godown_id" noStyle rules={[{ required: true, message: ' ' }]}>
                <Select
                  size="small"
                  style={{ width: 180 }}
                  placeholder="Godown *"
                  disabled={isEdit}
                  options={godowns.map(g => ({ value: g.godown_id, label: `${g.code} — ${g.name}` }))}
                />
              </Form.Item>
              {/* No labels — placeholders communicate the field's purpose. */}
              <Form.Item name="bill_date" noStyle rules={[{required:true,message:' '}]}>
                <DatePicker style={{width:140}} format="DD-MM-YYYY" placeholder="Bill date *" size="small"/>
              </Form.Item>
              <Form.Item name="due_date" noStyle>
                <DatePicker style={{width:140}} format="DD-MM-YYYY" placeholder="Due date" size="small"/>
              </Form.Item>
            </div>
          </div>

          <div className="sbf-top-inner">

            <div className="sbf-top-row">
              <div className="sbf-field" style={{flex:'1 1 auto'}}>
                {/* Customer is now hard-required. Cash sales select the
                    seeded system "Cash" party (pinned to the top of the
                    dropdown); a walk-in name field appears beside the
                    selector (cols 2+3 of the row's grid) when Cash is the
                    selection so the operator can capture the actual
                    person's name without creating a real party row. */}
                <Form.Item name="customer_id" noStyle
                  rules={[{ required: true, message: 'Select a customer (use Cash for walk-ins)' }]}>
                  <Select showSearch placeholder="Customer (required — pick Cash for walk-ins)"
                    optionFilterProp="label"
                    // After the operator picks a customer, jump straight to
                    // the barcode cell — sales is a POS-style flow ("who's
                    // buying" first, then scan items). Using onSelect (not
                    // onChange) keeps Form.Item's value binding intact;
                    // onSelect fires only on a real pick, never on the
                    // initial-load Form.Item hydration.
                    onSelect={() => setTimeout(() => barcodeRef.current?.focus(), 50)}
                    dropdownStyle={{minWidth:600,padding:0}}
                    dropdownRender={menu=>(
                      <div>
                        <div style={{display:'flex',gap:0,background:'var(--warning-bg)',padding:'5px 12px',
                          fontSize:11,fontWeight:700,color:'var(--fg-primary)',borderBottom:'1px solid var(--border)'}}>
                          <span style={{flex:'0 0 180px'}}>Customer Name</span>
                          <span style={{flex:'0 0 120px'}}>City</span>
                          <span style={{flex:'0 0 110px'}}>Contact</span>
                          <span style={{flex:'0 0 80px',textAlign:'right'}}>Balance</span>
                          <span style={{flex:'0 0 70px',textAlign:'center'}}>Credit</span>
                        </div>
                        {menu}
                      </div>
                    )}
                    options={parties.map(p=>({
                      value:p.party_id,
                      label:p.party_name,
                      party:p,
                    }))}
                    optionRender={(opt)=>{
                      const p=opt.data.party;
                      const bal=parseFloat(p.current_balance||0);
                      return (
                        <div style={{display:'flex',gap:0,alignItems:'center',fontSize:12,padding:'2px 0'}}>
                          <span style={{flex:'0 0 180px',fontWeight:600,overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap',paddingRight:6}}>{p.party_name}</span>
                          <span style={{flex:'0 0 120px',color:'var(--fg-tertiary)',overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap',paddingRight:6}}>{p.city||'—'}</span>
                          <span style={{flex:'0 0 110px',color:'var(--fg-secondary)'}}>{p.mobile_1||'—'}</span>
                          <span style={{flex:'0 0 80px',textAlign:'right',fontWeight:700,paddingRight:8,
                            color:bal>0?'var(--success)':bal<0?'var(--danger)':'var(--fg-tertiary)'}}>
                            {bal.toFixed(1)}
                          </span>
                          <span style={{flex:'0 0 70px',textAlign:'center'}}>
                            <span style={{background:p.credit_allowed?'var(--success-bg)':'var(--danger-bg)',
                              color:p.credit_allowed?'var(--success)':'var(--danger)',
                              borderRadius:4,padding:'1px 7px',fontSize:10,fontWeight:700}}>
                              {p.credit_allowed?'YES':'NO'}
                            </span>
                          </span>
                        </div>
                      );
                    }}
                  />
                </Form.Item>
              </div>
              {/* Col 2+3 of the row: ONE of two things depending on the
                  selected party.
                    • Cash → walk-in name input (sales_bills.walk_in_name)
                    • non-Cash → inline party-info strip (city · mobile ·
                      balance · credit pill), beside the dropdown rather
                      than below it
                  Both render in the same grid track range; exactly one is
                  `display:flex` based on selectedParty.is_system_cash, so
                  the row's track widths never reflow when toggling between
                  cash and a real customer. */}
              <div className="sbf-field"
                style={{
                  gridColumn: '2',
                  display: selectedParty && selectedParty.is_system_cash ? 'flex' : 'none',
                }}>
                <Form.Item name="walk_in_name" noStyle>
                  {/* No `allowClear` — that wraps the input in an
                      `.ant-input-affix-wrapper` which carries AntD's
                      default border, on top of our `.ant-input` border
                      override, giving a visible box-in-box. The customer
                      Select doesn't have a clear button either; matching
                      it keeps the row visually consistent. `width:100%`
                      so the Input fills the grid cell. */}
                  <Input
                    placeholder="Walk-in customer name (optional)"
                    maxLength={120}
                    style={{ width: '100%' }}
                  />
                </Form.Item>
              </div>

              {selectedParty && !selectedParty.is_system_cash && (() => {
                const bal = parseFloat(selectedParty.current_balance || 0);
                const limit = parseFloat(selectedParty.credit_limit || 0);
                const status = selectedParty.party_status || 'Regular';
                const isBlacklist = status === 'Blacklist';
                // Credit headroom is "limit minus current outstanding" — so a
                // user creating a bill can see at a glance how much more the
                // customer can owe before the server hard-blocks the save.
                const available = limit > 0 ? Math.max(0, +(limit - bal).toFixed(2)) : null;
                const overLimit = limit > 0 && bal > limit + 0.01;
                return (
                  <div className="sbf-party-info"
                    style={{
                      gridColumn: '2 / span 2',
                      margin: 0,
                      padding: '0 8px',
                      background: 'transparent',
                      border: 'none',
                      boxShadow: 'none',
                      alignSelf: 'center',
                    }}>
                    {selectedParty.city && <span>{selectedParty.city}</span>}
                    {selectedParty.mobile_1 && <span>📞 <b>{selectedParty.mobile_1}</b></span>}
                    <span>Balance <b className={bal >= 0 ? 'pos' : 'neg'}>
                      ₹{bal.toLocaleString('en-IN', { maximumFractionDigits: 0 })}
                    </b></span>
                    {limit > 0 && (
                      <span>
                        Limit <b>₹{limit.toFixed(2)}</b>{' '}
                        <span style={{ color: overLimit ? 'var(--danger)' : available === 0 ? 'var(--warning)' : 'var(--success)', fontWeight: 700 }}>
                          {overLimit ? `(₹${(bal - limit).toFixed(2)} over)` : `· ₹${available.toFixed(2)} available`}
                        </span>
                      </span>
                    )}
                    <span className={selectedParty.credit_allowed ? 'credit-ok' : 'credit-no'}>
                      {selectedParty.credit_allowed ? 'Credit allowed' : 'Credit blocked'}
                    </span>
                    {status !== 'Regular' && (
                      <span style={{
                        padding: '1px 8px', borderRadius: 4, fontSize: 11, fontWeight: 700,
                        background: isBlacklist ? 'var(--danger-bg)' : status === 'VIP' ? 'rgba(127,90,163,0.14)' : 'rgba(177,71,47,0.10)',
                        color:      isBlacklist ? 'var(--danger)'    : status === 'VIP' ? '#7F5AA3'                : 'var(--warning)',
                      }}>
                        {status}
                      </span>
                    )}
                  </div>
                );
              })()}
            </div>

            {/* ─── ENTRY ROW (Editorial Ledger) ──────────────────────────
             *
             *  One bordered strip — top + bottom hairlines, no internal
             *  rectangles. Each cell is a labelled stack: 9px uppercase
             *  caption above, AntD control below (border + bg stripped
             *  via the .sbf-entry-ledger overrides in sales-bill-form.css
             *  so the cell IS the visible boundary). Active cell warms to
             *  --bg-cell with a 2px accent under-rule — calm, low-paint,
             *  comfortable across 30+ line items.
             *
             *  Field order:
             *    Barcode · Category · Product · Size · Art# · QTY · RATE
             *    · Disc% · GST% · Unit · +ADD
             *
             *  Qty BEFORE Rate so the natural reading + typing rhythm is
             *  "size, art, how many, at what price". Matches the keyboard
             *  flow we already get from product-select → qtyRef focus
             *  jump (handleProdSel + the onFocus catch on prodRef).
             * ────────────────────────────────────────────────────────── */}
            {billMode === 'item' && (
            <div className="sbf-entry-ledger">
              <div className="sbf-entry-grid">
                <div className="sbf-cell">
                  <div className="sbf-cell-lbl">Barcode</div>
                  <Input ref={barcodeRef} value={entry.barcode} placeholder="Scan or type"
                    onChange={e=>setEntry(p=>({...p,barcode:e.target.value}))}
                    onPressEnter={e=>{
                      const val=e.target.value.trim();
                      if(val){ e.target.value=''; handleScan(val); }
                    }}
                    onKeyDown={e=>{if(e.key==='ArrowDown'){e.preventDefault();prodRef.current?.focus();}}}
                  />
                </div>
                <div className="sbf-cell has-arrow">
                  <div className="sbf-cell-lbl">Category</div>
                  <Select value={activeCatId}
                    onChange={(v,opt)=>{
                      justSelectedRef.current = false;
                      setActiveCatId(v||null);
                      setEntry(p=>({...p,category_id:v||null,category_name:opt?.children||'',product_name:'',product_id:null}));
                    }}
                    placeholder="Category" showSearch
                    filterOption={(input,opt)=>!input||opt.children.toLowerCase().includes(input.toLowerCase())}
                    allowClear notFoundContent={null} dropdownMatchSelectWidth={300}>
                    {cats.map(c=><Select.Option key={c.category_id} value={c.category_id}>{c.category_name}</Select.Option>)}
                  </Select>
                </div>
                <div className="sbf-cell has-arrow" ref={prodWrapRef}>
                  <div className="sbf-cell-lbl">Product</div>
                  <Select key={activeCatId??'no-cat'} ref={prodRef}
                    showSearch filterOption={false} optionLabelProp="label"
                    value={entry.product_id||undefined}
                    open={prodOpen}
                    onDropdownVisibleChange={v=>setProdOpen(v)}
                    onSearch={v=>{ setProdOpen(true); handleProdSearch(v); }}
                    onSelect={(val,opt)=>{ setProdOpen(false); handleProdSel(val,opt); }}
                    onFocus={()=>{
                      if(justSelectedRef.current){
                        justSelectedRef.current=false;
                        requestAnimationFrame(()=>{ prodRef.current?.blur(); qtyRef.current?.focus(); });
                      }
                    }}
                    onClear={()=>{ setProdOpen(false); setEntry(p=>({...p,product_id:null,product_name:''})); }}
                    allowClear
                    placeholder="Product name" notFoundContent={null}
                    listHeight={320} dropdownMatchSelectWidth={460}
                  >
                    {prodOpts.map(p=>{
                      const stock=parseFloat(p.current_stock||0);
                      const stockColor=stock<=0?'var(--danger)':stock<=5?'var(--warning)':'var(--fg-tertiary)';
                      return(
                      <Select.Option key={p.product_id} value={p.product_id} label={p.product_name} product={p}>
                        <div style={{display:'flex',justifyContent:'space-between',alignItems:'center',gap:8,padding:'2px 0'}}>
                          <div style={{minWidth:0,flex:1}}>
                            <div style={{fontWeight:600,fontSize:13,color:'var(--fg-primary)',whiteSpace:'nowrap',overflow:'hidden',textOverflow:'ellipsis'}}>{p.product_name}</div>
                            <div style={{fontSize:10,color:'var(--fg-tertiary)',marginTop:1}}>
                              {[p.Category?.category_name,p.article_number&&`Art# ${p.article_number}`,p.size_value&&`Size ${p.size_value}`].filter(Boolean).join(' · ')}
                            </div>
                          </div>
                          <div style={{display:'flex',flexDirection:'column',alignItems:'flex-end',gap:2,flexShrink:0}}>
                            <span style={{color:'var(--success)',fontWeight:700,fontSize:12}}>₹{parseFloat(p.sale_rate||0).toFixed(2)}</span>
                            <span style={{color:stockColor,fontSize:10,fontWeight:600}}>{stock<=0?'Out of stock':`Stock: ${stock}`}</span>
                          </div>
                        </div>
                      </Select.Option>
                    )})}
                  </Select>
                </div>
                {/* Batch picker — only renders for batch-tracked
                 *  products when the global setting is ON. Server
                 *  returns batches FEFO/FIFO sorted; auto-pick fires in
                 *  the effect above. Each option shows batch_number ·
                 *  qty available · expiry chip (red expired / amber
                 *  approaching / no chip when distant or unset).
                 *  Disabled state: empty list → "No batches with stock
                 *  at this godown" — the operator can't sell until a
                 *  purchase lands. */}
                {batchTrackingOn && entry.is_batch_tracked && (
                  <div className="sbf-cell has-arrow" style={{ minWidth: 180 }}>
                    <div className="sbf-cell-lbl">Batch</div>
                    <Select
                      ref={batchSelectRef}
                      value={entry.batch_id || undefined}
                      onChange={(val, opt) => {
                        pickBatch(val);
                        // After the operator confirms a batch (Enter
                        // on the highlighted row, or click), close the
                        // dropdown and advance focus to qty so the
                        // typing rhythm continues without a mouse
                        // detour. Same contract as a dropdown pick on
                        // the Product field.
                        setBatchOpen(false);
                        requestAnimationFrame(() => qtyRef.current?.focus());
                      }}
                      open={batchOpen}
                      onDropdownVisibleChange={(v) => setBatchOpen(v)}
                      disabled={!entry.product_id || batchOptsLoading || batchOpts.length === 0}
                      placeholder={batchOptsLoading
                        ? 'Loading…'
                        : (batchOpts.length === 0 ? 'No batches with stock at this godown' : 'Pick a batch')}
                      showSearch optionLabelProp="label"
                      filterOption={(input, opt) => !input || (opt.label || '').toLowerCase().includes(input.toLowerCase())}
                      dropdownMatchSelectWidth={380}
                    >
                      {batchOpts.map((b) => {
                        const d = daysUntilExpiry(b.expiry_date);
                        // Expiry status chip — red expired / amber
                        // approaching / no chip when distant or unset.
                        const expChip = d == null
                          ? null
                          : d < 0
                            ? <Tag color="red">Expired</Tag>
                            : d <= batchAlertDays
                              ? <Tag color="orange">{d}d left</Tag>
                              : null;
                        // Date metadata — both mfg and exp shown when
                        // available so the operator can verify FEFO
                        // ordering at a glance. Format DD MMM YY keeps
                        // the option compact.
                        const dateMeta = [
                          b.manufacture_date ? `Mfd ${dayjs(b.manufacture_date).format('DD MMM YY')}` : null,
                          b.expiry_date     ? `Exp ${dayjs(b.expiry_date).format('DD MMM YY')}` : null,
                        ].filter(Boolean).join(' · ');
                        return (
                          <Select.Option
                            key={b.batch_id} value={b.batch_id}
                            label={b.batch_number}
                          >
                            <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center', gap:8, padding:'2px 0' }}>
                              <div style={{ minWidth:0, flex:1 }}>
                                <div style={{ fontWeight:600, fontSize:13, color:'var(--fg-primary)' }}>{b.batch_number}</div>
                                <div style={{ fontSize:10, color:'var(--fg-tertiary)', marginTop:1 }}>
                                  Stock: {b.current_stock}{dateMeta ? ` · ${dateMeta}` : ''}
                                </div>
                              </div>
                              <div style={{ flexShrink:0 }}>{expChip}</div>
                            </div>
                          </Select.Option>
                        );
                      })}
                    </Select>
                  </div>
                )}
                {/* Field array: Size · Art# · QTY · RATE · Disc% · GST%.
                 *  Indices 1–6 line up with eRefs[1..6] so eKey's
                 *  ArrowUp/Down/Enter walk maps cell-position to ref. */}
                {[
                  {l:'Size',  ref:sizeRef, f:'size',               v:entry.size,                          i:1,t:'txt'},
                  {l:'Art #', ref:artRef,  f:'article_number',     v:entry.article_number,                i:2,t:'txt'},
                  {l:'Qty',   ref:qtyRef,  f:'quantity',           v:entry.quantity||undefined,           i:3,t:'num',min:0},
                  {l:'Rate ₹',ref:rateRef, f:'rate',               v:entry.rate||undefined,               i:4,t:'num',min:0},
                  {l:'Disc%', ref:discRef, f:'discount_percentage',v:entry.discount_percentage||undefined,i:5,t:'num',min:0},
                  {l:'GST%',  ref:gstRef,  f:'gst_rate',           v:entry.gst_rate||undefined,           i:6,t:'num',min:0},
                ].map(({l,ref,f,v,i,t,min})=>(
                  <div key={f} className={`sbf-cell ${t==='num'?'numeric':''}`}>
                    <div className="sbf-cell-lbl">{l}</div>
                    {t==='txt'
                      ?<Input ref={ref} value={v} placeholder=""
                          onChange={e=>ue(f,e.target.value)} onKeyDown={e=>eKey(e,i)}/>
                      :<InputNumber keyboard={false} ref={ref} value={v} style={{width:'100%'}} min={min} placeholder=""
                          onChange={vv=>ue(f,vv||0)} onKeyDown={e=>eKey(e,i)}/>
                    }
                  </div>
                ))}
                <div className="sbf-cell has-arrow">
                  <div className="sbf-cell-lbl">Unit</div>
                  <Select value={entry.unit_type||'Pcs'} placeholder=""
                    onChange={v=>ue('unit_type',v)}>
                    {UNITS.map(u=><Select.Option key={u} value={u}>{u}</Select.Option>)}
                  </Select>
                </div>
                <button onClick={addItem} className="sbf-cell add" type="button">
                  <span className="sbf-cell-add-text">ADD</span>
                </button>
              </div>
              {entry.available_stock>0 && (
                <span className={`sbf-stock-chip ${entry.quantity>entry.available_stock?'low':'ok'}`}>
                  Stock: {entry.available_stock}
                </span>
              )}
            </div>
            )}

            {/* Amount-only entry panel */}
            {billMode === 'amount' && (
              <div className="sbf-amount-panel" style={{
                margin:'10px 0 4px', padding:'18px 20px',
                background:'rgba(226,106,76,.06)',
                border:'1px solid rgba(226,106,76,.20)',
                borderRadius:10,
                display:'grid',
                gridTemplateColumns:'2fr 1fr 1fr 1fr',
                gap:14,
                alignItems:'end',
              }}>
                <div style={{display:'flex',flexDirection:'column',gap:4}}>
                  <label style={{fontSize:11,color:'var(--fg-tertiary)',letterSpacing:'.04em',textTransform:'uppercase',fontWeight:600}}>Description</label>
                  <Input value={amountDesc}
                    onChange={e=>setAmountDesc(e.target.value)}
                    placeholder="Service / labour / freight charge..."
                    autoFocus />
                </div>
                <div style={{display:'flex',flexDirection:'column',gap:4}}>
                  <label style={{fontSize:11,color:'var(--fg-tertiary)',letterSpacing:'.04em',textTransform:'uppercase',fontWeight:600}}>HSN/SAC</label>
                  <Input value={amountHsnCode}
                    onChange={e=>setAmountHsnCode(e.target.value)}
                    placeholder="HSN / SAC"
                    maxLength={10} />
                </div>
                <div style={{display:'flex',flexDirection:'column',gap:4}}>
                  <label style={{fontSize:11,color:'var(--fg-tertiary)',letterSpacing:'.04em',textTransform:'uppercase',fontWeight:600}}>GST %</label>
                  <Select value={amountGstRate} onChange={setAmountGstRate} style={{width:'100%'}}>
                    {[0, 5, 12, 18, 28].map(r => <Select.Option key={r} value={r}>{r}%</Select.Option>)}
                  </Select>
                </div>
                <div style={{display:'flex',flexDirection:'column',gap:4}}>
                  <label style={{fontSize:11,color:'var(--fg-tertiary)',letterSpacing:'.04em',textTransform:'uppercase',fontWeight:600}}>Amount (Taxable)</label>
                  <InputNumber keyboard={false} value={amountVal}
                    onChange={v=>setAmountVal(v||'')}
                    placeholder="0.00" min={0} style={{width:'100%'}}
                    formatter={v => v ? `₹ ${v}`.replace(/\B(?=(\d{3})+(?!\d))/g, ',') : ''}
                    parser={v => v ? v.replace(/[₹,\s]/g, '') : ''} />
                </div>
              </div>
            )}
          </div>
        </section>

        {/* ═══════════════════════════════ (2) MIDDLE ══════════════════════════
           Always render the middle section so the page-grid's flex row stays
           occupied — otherwise the bottom totals/payment cards collapse upward
           in Amount mode. The table itself is only mounted in Items mode. */}
        <section className="sbf-mid">
          {billMode === 'item' && (
            <div className="sbf-mid-card">
              <div ref={tableWrapRef} className="sbf-tbl-wrap">
                <Table
                  columns={cols} dataSource={items} rowKey="key"
                  size="small" pagination={false} loading={pgLoading}
                  scroll={items.length?{x:1086,y:tblHeight}:{y:tblHeight}}
                  // Empty state intentionally blank — the entry row above
                  // already tells the operator what to do; another hero
                  // copy block under the header just adds noise. AntD's
                  // Table needs *something* in emptyText so we render an
                  // empty span — keeps the table layout stable, paints
                  // nothing.
                  locale={{ emptyText: <span /> }}
                />
              </div>
            </div>
          )}
        </section>

        {/* ═══════════════════════════════ (3) BOTTOM ══════════════════════════ */}
        <section className="sbf-bottom">
          <div className="sbf-bottom-inner">

            {/* LEFT: Summary */}
            <div className="sbf-bb-left">
              <div className="sbf-card sbf-summary">
                <div className="sbf-counters">
                  <div className="sbf-counter items">
                    <div className="k">Items</div>
                    <div className="v">{items.length}</div>
                  </div>
                  <div className="sbf-counter qty">
                    <div className="k">Qty</div>
                    <div className="v">{totalQty.toFixed(1)}</div>
                  </div>
                  <div className="sbf-counter box">
                    <div className="k">Box</div>
                    <div className="v">{boxQty.toFixed(1)}</div>
                  </div>
                </div>
                <div className="sbf-summary-fields">
                  <div className="sbf-field">
                    <span className="sbf-lbl">Sale type</span>
                    <Form.Item name="sale_type" noStyle initialValue="Retail">
                      <Select>
                        <Select.Option value="Retail">Retail</Select.Option>
                        <Select.Option value="Wholesale">Wholesale</Select.Option>
                      </Select>
                    </Form.Item>
                  </div>
                  <div className="sbf-field">
                    <span className="sbf-lbl">Salesman</span>
                    <Form.Item name="salesman_name" noStyle>
                      <Input placeholder="Name"/>
                    </Form.Item>
                  </div>
                </div>
                <div className="sbf-summary-notes">
                  <span className="sbf-lbl">Notes</span>
                  <Form.Item name="remarks" noStyle>
                    <Input.TextArea
                      rows={5}
                      maxLength={1000}
                      placeholder="Add remarks, delivery instructions, reference…"
                      className="sbf-notes-ta"
                    />
                  </Form.Item>
                </div>
              </div>
            </div>

            {/* RIGHT: Totals + Payment */}
            <div className="sbf-bb-right">

              {/* Totals card — 6 rows to match Payment card height.
                    CGST+SGST share a single % input (they're always equal in
                    intra-state GST; user always typed the same value in both).
                    Internally we still save cgst_pct and sgst_pct separately
                    so nothing downstream changes. Other + Freight share one
                    row with two compact side-by-side inputs. */}
              <div className="sbf-card sbf-totals">
                <div className="sbf-tot-lines">
                  <div className="sbf-tot-line total-row">
                    <span className="k">Total</span>
                    <span className="sbf-val-box">{fmtN(taxableAmt)}</span>
                  </div>
                  <div className="sbf-tot-line with-pct">
                    <span className="k" title="Combined CGST + SGST rate. Typed value is split half/half into the two columns on save.">GST (C+S)</span>
                    <InputNumber keyboard={false} size="small" min={0} max={100}
                      className="sbf-pct-in" style={{width:'100%'}}
                      // Show the COMBINED rate (5%) not just the CGST half (2.5%)
                      // so the label and the amount column agree. The input is
                      // the user's mental "GST rate" — the split into equal
                      // CGST/SGST halves happens on save, transparently.
                      value={(effCgstPct + effSgstPct)||undefined} disabled={gstMode==='product'}
                      onChange={v=>{ const half = (v||0) / 2; setCgstPct(half); setSgstPct(half); }}
                      formatter={v=>v?`${v}%`:''} parser={v=>v?.replace('%','')||''}
                      placeholder="%"/>
                    <span className="sbf-val-box">{fmtN(cgst + sgst)}</span>
                  </div>
                  <div className="sbf-tot-line with-pct">
                    <span className="k">IGST</span>
                    <InputNumber keyboard={false} size="small" min={0} max={100}
                      className="sbf-pct-in" style={{width:'100%'}}
                      value={igstPct||undefined}
                      onChange={v=>setIgstPct(v||0)}
                      formatter={v=>v?`${v}%`:''} parser={v=>v?.replace('%','')||''}
                      placeholder="%"/>
                    <span className="sbf-val-box">{fmtN(igstAmt)}</span>
                  </div>
                  <div className="sbf-tot-line gst-total">
                    <span className="k">Total GST</span>
                    <span className="sbf-val-box gst-val">{fmtN(totalGST)}</span>
                  </div>
                  <div className="sbf-tot-line extras">
                    <span className="k">Extras</span>
                    <Form.Item name="other_charges" noStyle>
                      <InputNumber keyboard={false} size="small" min={0} placeholder="Other"
                        className="sbf-amt-in" style={{width:'100%'}}/>
                    </Form.Item>
                    <Form.Item name="freight_charges" noStyle>
                      <InputNumber keyboard={false} size="small" min={0} placeholder="Freight"
                        className="sbf-amt-in" style={{width:'100%'}}/>
                    </Form.Item>
                  </div>
                  <div className="sbf-tot-line with-pct">
                    <span className="k">Bill Disc</span>
                    <Form.Item name="discount_percentage" noStyle>
                      <InputNumber keyboard={false} size="small" min={0} max={100} placeholder="%"
                        className="sbf-pct-in" style={{width:'100%'}}
                        formatter={v=>v?`${v}%`:''} parser={v=>v?.replace('%','')||''}
                        onChange={pct=>{
                          discAmtEditingRef.current=false;
                          setDiscAmtVal(+(subTotal*(pct||0)/100).toFixed(2));
                        }}/>
                    </Form.Item>
                    <InputNumber keyboard={false} size="small" min={0} placeholder="₹ amt"
                      className="sbf-amt-in" style={{width:'100%'}}
                      value={discAmtVal||undefined}
                      onFocus={()=>{ discAmtEditingRef.current=true; }}
                      onBlur={()=>{ discAmtEditingRef.current=false; }}
                      onChange={amt=>{
                        discAmtEditingRef.current=true;
                        setDiscAmtVal(amt||0);
                        // Keep 4-decimal precision so the derived pct can
                        // round-trip back to the same amount. Truncating
                        // to 2dp turns 4.7619% into 4.76%, which re-derives
                        // the amount as 2239.10 instead of 2240 — the ~₹1
                        // drift you'd otherwise see on every imported bill.
                        const pct = subTotal>0 ? +((amt||0)/subTotal*100).toFixed(4) : 0;
                        form.setFieldValue('discount_percentage', pct);
                      }}/>
                  </div>
                </div>
              </div>

              {/* Payment card */}
              <div className="sbf-card sbf-payment">
                <div className="sbf-net-hero">
                  <span className="k">Net total ₹</span>
                  <span className="v">{roundedTotal.toLocaleString('en-IN')}</span>
                </div>

                <div className="sbf-pay-line">
                  <span className="k">Mode</span>
                  <Form.Item name="payment_method" noStyle initialValue="Cash">
                    <Select>
                      {PAY_MODES.map(m=><Select.Option key={m} value={m}>{m}</Select.Option>)}
                    </Select>
                  </Form.Item>
                </div>
                {/* 3-column row so the Return button sits BETWEEN the
                    "Return ₹" label and the amount box (visible by default
                    so the operator notices it without hovering). Smaller
                    gap so the amount box can stretch wider. */}
                <div className="sbf-pay-line" style={{gridTemplateColumns:'96px auto 1fr', gap:6}}>
                  <span className="k">Return ₹</span>
                  {/* "Return at counter" — opens a mini sales-return modal so
                      the operator can scan/search items the customer is
                      bringing back during this same sale. The modal's total
                      mirrors into Return ₹ and a paired SalesReturnBill is
                      created server-side in the same transaction. */}
                  <button
                    type="button"
                    className={`sbf-ret-btn ${inlineReturnItems.length > 0 ? 'has-items' : ''}`}
                    onClick={() => setReturnModalOpen(true)}
                    title="Return items at counter (creates a paired sales return bill)"
                  >
                    <span className="sbf-ret-btn-ico" aria-hidden>↶</span>
                    <span>Return</span>
                    {inlineReturnItems.length > 0 && (
                      <span className="sbf-ret-btn-badge">{inlineReturnItems.length}</span>
                    )}
                  </button>
                  <Form.Item name="return_amount" noStyle>
                    <InputNumber keyboard={false} min={0} max={roundedTotal} placeholder="0.00"
                      style={{width:'100%'}}
                      className="sbf-ret-amount-in"
                      // Disable manual edit when inline-return items are
                      // present — the field is driven by the modal's total.
                      disabled={inlineReturnItems.length > 0}/>
                  </Form.Item>
                </div>
                {paymentMethod === 'Cash' && (
                  <div className="sbf-pay-line">
                    <span className="k">Cash Rcvd</span>
                    <InputNumber keyboard={false} min={0} placeholder="0.00"
                      value={cashReceived||null}
                      style={{width:'100%'}}
                      onChange={v=>{
                        const val = v || 0;
                        setCashReceived(val);
                        form.setFieldValue('paid_amount', Math.min(val, maxPaid));
                        paidEditedRef.current = false;
                      }}/>
                  </div>
                )}
                <div className="sbf-pay-line">
                  <span className="k">Amt Paid</span>
                  <Form.Item name="paid_amount" noStyle>
                    <InputNumber keyboard={false} min={0} max={maxPaid} placeholder="0.00"
                      style={{width:'100%'}}
                      onChange={()=>{ paidEditedRef.current = true; }}/>
                  </Form.Item>
                </div>

                {changeDue > 0 && (
                  <div className="sbf-change">
                    <span className="k">Change due</span>
                    <span className="v">{fmtN(changeDue)}</span>
                  </div>
                )}

                <div className={`sbf-status ${statusClass}`}>
                  <span className="k">{statusLabel}</span>
                  <span className="v">{fmtN(Math.abs(balance))}</span>
                </div>
              </div>

            </div>
          </div>
        </section>

        {/* ═══════════════════════════════ (4) ACTION BAR ══════════════════════ */}
        <section className="sbf-action-bar">
          <div className="sbf-action-bar-inner">
            <button className="sbf-act" onClick={()=>confirmLeave(()=>navigate(backTarget))}>
              <span className="sbf-kbd">Esc</span> Back
            </button>
            <button className="sbf-act" onClick={handleReset}>
              <span className="sbf-kbd">F5</span> Reset
            </button>
            {!isEdit && (
              <>
                <button className="sbf-act" onClick={handleHold} disabled={holdLoading}
                        title="Save as draft to resume later — does NOT affect ledger, GST, or stock">
                  <span className="sbf-kbd">F4</span> {recalledDraftId ? 'Update Hold' : 'Hold'}
                </button>
                <button className="sbf-act" onClick={() => { loadDrafts(); setDraftsModalOpen(true); }}
                        title="View held drafts and recall one">
                  📋 Drafts
                  {drafts.length > 0 && (
                    <span style={{
                      marginLeft: 6, padding: '0 7px',
                      background: 'var(--accent-primary, #E26A4C)', color: '#fff',
                      borderRadius: 999, fontSize: 11, fontWeight: 700,
                      lineHeight: '18px', display: 'inline-block',
                    }}>{drafts.length}</span>
                  )}
                </button>
              </>
            )}
            {isEdit && (
              <button className="sbf-act" onClick={() => printDocument({ docType: 'sales', id })}>
                <span className="sbf-kbd">Ctrl+P</span> Print
              </button>
            )}
            <button className="sbf-act credit" onClick={()=>handleSave(false)} disabled={loading}>
              <span className="sbf-kbd">F8</span> Save Credit
            </button>
            <button className="sbf-act primary" onClick={()=>handleSave(true)} disabled={loading}>
              <span className="sbf-kbd">F1</span> Save &amp; Rcv
            </button>
          </div>
        </section>

      </div>

      {/* In-form Drafts modal — Recall replays into THIS form (no route
          change) so the operator stays in their billing flow. */}
      <Modal
        open={draftsModalOpen}
        onCancel={() => setDraftsModalOpen(false)}
        title={
          <div className="sbf-drafts-title">
            <span className="sbf-chip">Drafts</span>
            <span className="sbf-drafts-count">{drafts.length} held</span>
          </div>
        }
        footer={null}
        width="min(96vw, 1100px)"
        zIndex={1100}
        className="sbf-drafts-modal"
        styles={{ body: { padding: 0 } }}
      >
        {drafts.length === 0 ? (
          <div className="sbf-drafts-empty">
            <div className="sbf-drafts-empty-icon">📋</div>
            <div className="sbf-drafts-empty-main">No drafts held</div>
          </div>
        ) : (
          <div className="sbf-drafts-table">
            <div className="sbf-drafts-thead">
              <span className="c-date">Date</span>
              <span className="c-cust">Customer</span>
              <span className="c-qty">Qty</span>
              <span className="c-tot">Total</span>
              <span className="c-user">User</span>
              <span className="c-sm">Salesman</span>
              <span className="c-act"></span>
            </div>
            <div className="sbf-drafts-tbody">
              {drafts.map((d, i) => {
                const isAmount = d.payload?.bill_mode === 'amount';
                const isSelected = i === selectedDraftIdx;
                const totalQty = isAmount
                  ? null
                  : (d.payload?.items || []).reduce((s, it) => s + (parseFloat(it.quantity) || 0), 0);
                const dateObj = dayjs(d.created_date);
                return (
                  <div
                    key={d.draft_id}
                    ref={(el) => { draftCardRefs.current[i] = el; }}
                    className={`sbf-drafts-tr ${isSelected ? 'is-selected' : ''}`}
                    onClick={() => setSelectedDraftIdx(i)}
                    onDoubleClick={() => handleRecallDraft(d)}
                  >
                    <span className="c-date">
                      <span className="c-date-d">{dateObj.format('DD MMM YYYY')}</span>
                      <span className="c-date-t">{dateObj.format('HH:mm')}</span>
                    </span>
                    <span className="c-cust">
                      {d.customer?.party_name || <span className="walk-in">Walk-in</span>}
                      {isAmount && <span className="sbf-drafts-mode-tag amount">Amount</span>}
                    </span>
                    <span className="c-qty">{isAmount ? '—' : (totalQty % 1 === 0 ? totalQty : totalQty.toFixed(1))}</span>
                    <span className="c-tot">
                      ₹{parseFloat(d.total_preview || 0).toLocaleString('en-IN', { minimumFractionDigits: 2 })}
                    </span>
                    <span className="c-user">{d.creator?.username || '—'}</span>
                    <span className="c-sm">{d.payload?.salesman_name || '—'}</span>
                    <span className="c-act">
                      <button
                        className="sbf-drafts-btn recall"
                        onClick={(e) => { e.stopPropagation(); handleRecallDraft(d); }}>
                        <span className="sbf-drafts-btn-ico" aria-hidden>↩</span>
                        <span>Recall</span>
                      </button>
                      <button
                        className="sbf-drafts-btn discard"
                        title="Discard draft"
                        onClick={(e) => {
                          e.stopPropagation();
                          Modal.confirm({
                            title: `Discard ${d.draft_number}?`,
                            content: 'This permanently deletes the draft. Cannot be undone.',
                            okText: 'Discard', okType: 'danger',
                            onOk: async () => {
                              try {
                                await salesDraftAPI.delete(d.draft_id);
                                await loadDrafts();
                                message.success(`${d.draft_number} discarded`);
                              } catch (err) {
                                message.error('Failed to discard: ' + (err.response?.data?.error || err.message));
                              }
                            },
                          });
                        }}>
                        Discard
                      </button>
                    </span>
                  </div>
                );
              })}
            </div>
          </div>
        )}
      </Modal>

      {/* ── Inline Return modal ──
          Mini sales-return form that lives inside the SalesBillForm. The
          operator scans/searches items the customer is bringing back at the
          counter; on Done the running total drives the form's Return ₹
          field, and on Save & Rcv/Save Credit the backend creates a paired
          SalesReturnBill in the same transaction (stock restocks, party
          balance recomputes, GSTR routing matches the sale's intra/inter). */}
      <Modal
        open={returnModalOpen}
        onCancel={() => setReturnModalOpen(false)}
        title={
          <div className="sbf-drafts-title">
            <span className="sbf-chip" style={{ background: '#B91C1C', borderColor: '#B91C1C' }}>Return</span>
            <span className="sbf-drafts-count">
              {inlineReturnItems.length} item{inlineReturnItems.length === 1 ? '' : 's'} ·
              ₹{inlineReturnTotal.toLocaleString('en-IN', { minimumFractionDigits: 2 })}
            </span>
          </div>
        }
        footer={null}
        width="min(96vw, 1100px)"
        zIndex={1100}
        className="sbf-drafts-modal sbf-ret-modal"
        styles={{ body: { padding: 0 } }}
        afterOpenChange={(open) => { if (open) setTimeout(() => retBarcodeRef.current?.focus(), 80); }}
      >
        <div style={{ padding: '14px 20px', borderBottom: '1px solid var(--border-subtle)' }}>
          {/* Full sales-bill-form-style entry row: barcode → category →
              product (rich dropdown w/ category meta + sale rate + stock) →
              size → art# → rate → qty → disc% → gst% → unit → +ADD.
              Mirrors the main entry row's helpers + refs but uses the
              modal-scoped `retXxx` versions so a search inside the modal
              never overwrites the main form's product list. */}
          <div className="sbf-ret-entry" key={retEntryNonce}>
            <div className="sbf-field">
              <Input ref={retBarcodeRef} value={retEntry.barcode} placeholder="Barcode / scan"
                onChange={e => setRetEntry(p => ({ ...p, barcode: e.target.value }))}
                onPressEnter={e => {
                  const val = e.target.value.trim();
                  if (val) { e.target.value = ''; handleRetScan(val); }
                }}
                onKeyDown={e => { if (e.key === 'ArrowDown') { e.preventDefault(); retCatRef.current?.focus(); } }}
              />
            </div>
            <div className="sbf-field">
              <Select ref={retCatRef} value={retActiveCatId}
                onChange={(v, opt) => {
                  retJustSelectedRef.current = false;
                  setRetActiveCatId(v || null);
                  setRetEntry(p => ({ ...p, category_id: v || null, category_name: opt?.children || '', product_name: '', product_id: null }));
                }}
                placeholder="Category" showSearch
                filterOption={(input, opt) => !input || opt.children.toLowerCase().includes(input.toLowerCase())}
                allowClear notFoundContent={null}>
                {cats.map(c => <Select.Option key={c.category_id} value={c.category_id}>{c.category_name}</Select.Option>)}
              </Select>
            </div>
            <div className="sbf-field">
              <Select key={retActiveCatId ?? 'no-cat'} ref={retProdRef}
                showSearch filterOption={false} optionLabelProp="label"
                value={retEntry.product_id || undefined}
                open={retProdOpen}
                onDropdownVisibleChange={v => setRetProdOpen(v)}
                onSearch={v => { setRetProdOpen(true); handleRetProdSearch(v); }}
                onSelect={(val, opt) => { setRetProdOpen(false); handleRetProdSel(val, opt); }}
                onFocus={() => {
                  if (retJustSelectedRef.current) {
                    retJustSelectedRef.current = false;
                    requestAnimationFrame(() => { retProdRef.current?.blur(); retQtyRef.current?.focus(); });
                  }
                }}
                onClear={() => { setRetProdOpen(false); setRetEntry(p => ({ ...p, product_id: null, product_name: '' })); }}
                allowClear placeholder="Product name" notFoundContent={null}
                listHeight={320} dropdownMatchSelectWidth={460}
              >
                {retProdOpts.map(p => {
                  const stock = parseFloat(p.current_stock || 0);
                  const stockColor = stock <= 0 ? 'var(--danger)' : stock <= 5 ? 'var(--warning)' : 'var(--fg-tertiary)';
                  return (
                    <Select.Option key={p.product_id} value={p.product_id} label={p.product_name} product={p}>
                      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8, padding: '2px 0' }}>
                        <div style={{ minWidth: 0, flex: 1 }}>
                          <div style={{ fontWeight: 600, fontSize: 13, color: 'var(--fg-primary)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{p.product_name}</div>
                          <div style={{ fontSize: 10, color: 'var(--fg-tertiary)', marginTop: 1 }}>
                            {[p.Category?.category_name, p.article_number && `Art# ${p.article_number}`, p.size_value && `Size ${p.size_value}`].filter(Boolean).join(' · ')}
                          </div>
                        </div>
                        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 2, flexShrink: 0 }}>
                          <span style={{ color: 'var(--success)', fontWeight: 700, fontSize: 12 }}>₹{parseFloat(p.sale_rate || 0).toFixed(2)}</span>
                          <span style={{ color: stockColor, fontSize: 10, fontWeight: 600 }}>{stock <= 0 ? 'Out of stock' : `Stock: ${stock}`}</span>
                        </div>
                      </div>
                    </Select.Option>
                  );
                })}
              </Select>
            </div>
            {[
              { l: 'Size',   ref: retSizeRef, f: 'size',                v: retEntry.size,                          i: 1, t: 'txt' },
              { l: 'Art #',  ref: retArtRef,  f: 'article_number',      v: retEntry.article_number,                i: 2, t: 'txt' },
              { l: 'Rate ₹', ref: retRateRef, f: 'rate',                v: retEntry.rate || undefined,             i: 3, t: 'num', min: 0 },
              { l: 'Qty',    ref: retQtyRef,  f: 'quantity',            v: retEntry.quantity || undefined,         i: 4, t: 'num', min: 0 },
              { l: 'Disc%',  ref: retDiscRef, f: 'discount_percentage', v: retEntry.discount_percentage||undefined,i: 5, t: 'num', min: 0 },
              { l: 'GST%',   ref: retGstRef,  f: 'gst_rate',            v: retEntry.gst_rate || undefined,         i: 6, t: 'num', min: 0 },
            ].map(({ l, ref, f, v, i, t, min }) => (
              <div key={f} className="sbf-field">
                {t === 'txt'
                  ? <Input ref={ref} value={v} placeholder={l}
                      onChange={e => retUpdateEntry(f, e.target.value)} onKeyDown={e => retEntryKey(e, i)}/>
                  : <InputNumber keyboard={false} ref={ref} value={v} style={{ width: '100%' }} min={min} placeholder={l}
                      onChange={vv => retUpdateEntry(f, vv || 0)} onKeyDown={e => retEntryKey(e, i)}/>
                }
              </div>
            ))}
            <div className="sbf-field">
              <Select value={retEntry.unit_type || 'Pcs'} placeholder="Unit"
                onChange={v => retUpdateEntry('unit_type', v)}>
                {UNITS.map(u => <Select.Option key={u} value={u}>{u}</Select.Option>)}
              </Select>
            </div>
            <button onClick={retAddItem} className="sbf-add-btn">+ ADD</button>
            {retEntry.available_stock > 0 && (
              <span className={`sbf-stock-chip ${retEntry.quantity > retEntry.available_stock ? 'low' : 'ok'}`}>
                Stock: {retEntry.available_stock}
              </span>
            )}
          </div>
        </div>

        {inlineReturnItems.length === 0 ? (
          <div className="sbf-drafts-empty">
            <div className="sbf-drafts-empty-icon">↶</div>
            <div className="sbf-drafts-empty-main">No return items yet</div>
            <div style={{ marginTop: 6, fontSize: 12, color: 'var(--fg-tertiary)' }}>
              Scan a barcode or search a product to add. Items will be restocked when the bill is saved.
            </div>
          </div>
        ) : (
          <div className="sbf-drafts-table">
            {/* 9 columns: # | Product | Qty | Rate | Disc% | Taxable | GST% | Total | × */}
            <div className="sbf-drafts-thead" style={{ gridTemplateColumns:
                'minmax(40px,50px) minmax(180px,2fr) minmax(50px,70px) minmax(80px,90px) minmax(60px,70px) minmax(100px,1fr) minmax(50px,60px) minmax(100px,1fr) auto' }}>
              <span>#</span>
              <span>Product</span>
              <span style={{ textAlign: 'right' }}>Qty</span>
              <span style={{ textAlign: 'right' }}>Rate</span>
              <span style={{ textAlign: 'right' }}>Disc%</span>
              <span style={{ textAlign: 'right' }}>Taxable</span>
              <span style={{ textAlign: 'right' }}>GST%</span>
              <span style={{ textAlign: 'right' }}>Total</span>
              <span></span>
            </div>
            <div className="sbf-drafts-tbody">
              {inlineReturnItems.map((it, i) => {
                const lt = (it.quantity||0)*(it.rate||0);
                const disc = lt * ((it.discount_percentage||0)/100);
                const taxable = lt - disc;
                const gst = taxable * ((it.gst_rate||0)/100);
                return (
                  <div className="sbf-drafts-tr" key={it.key} style={{
                    gridTemplateColumns:
                      'minmax(40px,50px) minmax(180px,2fr) minmax(50px,70px) minmax(80px,90px) minmax(60px,70px) minmax(100px,1fr) minmax(50px,60px) minmax(100px,1fr) auto',
                    cursor: 'default',
                  }}>
                    <span style={{ color: 'var(--fg-tertiary)', fontWeight: 600 }}>{i + 1}</span>
                    <span style={{ fontWeight: 600 }}>
                      {it.product_name}
                      {it.size && <span style={{ color: 'var(--fg-tertiary)', fontWeight: 400, marginLeft: 6 }}>· {it.size}</span>}
                    </span>
                    <span style={{ textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>{it.quantity}</span>
                    <span style={{ textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>₹{it.rate.toFixed(2)}</span>
                    <span style={{ textAlign: 'right', fontVariantNumeric: 'tabular-nums',
                      color: (it.discount_percentage||0) > 0 ? 'var(--warning, #d97706)' : 'var(--fg-tertiary)' }}>
                      {it.discount_percentage || 0}%
                    </span>
                    <span style={{ textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>₹{taxable.toFixed(2)}</span>
                    <span style={{ textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>{it.gst_rate || 0}%</span>
                    <span style={{ textAlign: 'right', fontWeight: 700, fontVariantNumeric: 'tabular-nums' }}>₹{(taxable+gst).toFixed(2)}</span>
                    <span style={{ display: 'inline-flex', justifyContent: 'flex-end' }}>
                      <button
                        type="button"
                        className="sbf-drafts-btn discard"
                        title="Remove"
                        onClick={() => setInlineReturnItems(prev => prev.filter(x => x.key !== it.key))}>
                        ×
                      </button>
                    </span>
                  </div>
                );
              })}
            </div>
            <div style={{
              display: 'flex', justifyContent: 'space-between', alignItems: 'center',
              padding: '14px 20px', borderTop: '1px solid var(--border)',
              background: 'var(--bg-panel)',
            }}>
              <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                <span style={{ fontSize: 12, color: 'var(--fg-tertiary)' }}>Return total</span>
                <span style={{ fontSize: 18, fontWeight: 700, fontVariantNumeric: 'tabular-nums', color: '#B91C1C' }}>
                  ₹{inlineReturnTotal.toLocaleString('en-IN', { minimumFractionDigits: 2 })}
                </span>
              </div>
              <div style={{ display: 'flex', gap: 8 }}>
                <button
                  type="button"
                  className="sbf-drafts-btn discard"
                  onClick={() => setInlineReturnItems([])}>
                  Clear all
                </button>
                <button
                  type="button"
                  className="sbf-drafts-btn recall"
                  onClick={() => setReturnModalOpen(false)}>
                  Done
                </button>
              </div>
            </div>
          </div>
        )}
      </Modal>
    </Form>
  );
}
