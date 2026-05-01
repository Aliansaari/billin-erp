import React, { useState, useRef, useEffect, useLayoutEffect, useCallback } from 'react';
import { Form, Input, DatePicker, Select, InputNumber, Table, message } from 'antd';
import { useNavigate, useParams } from 'react-router-dom';
import dayjs from 'dayjs';
import { salesAPI, partyAPI, productAPI, categoryAPI, settingsAPI } from '../../api';
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
};

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
  const { id }   = useParams();
  const isEdit   = Boolean(id);

  const [form]    = Form.useForm();
  const [items, setItems]       = useState([]);
  const [parties, setParties]   = useState([]);
  const [cats, setCats]         = useState([]);
  const [loading, setLoading]   = useState(false);
  const [pgLoading, setPgLoading] = useState(false);
  const [entry, setEntry]       = useState(EMPTY);
  const [prodOpts, setProdOpts] = useState([]);
  const [company, setCompany]   = useState('');
  const [billNo, setBillNo]     = useState('');
  const [gstMode]               = useState(()=>localStorage.getItem('gst_mode')||'product');
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
  const tableWrapRef = useRef(null);
  const [tblHeight, setTblHeight] = useState(300);
  const eRefs = [prodRef,sizeRef,artRef,rateRef,qtyRef,discRef,gstRef];

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
    settingsAPI.getSystem().then(({data})=>setCompany(data?.data?.company_name||'')).catch(()=>{});
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
        customer_id:data.customer_id,
        bill_date:data.bill_date?dayjs(data.bill_date):dayjs(),
        due_date:data.due_date?dayjs(data.due_date):null,
        discount_percentage:parseFloat(data.discount_percentage)||0,
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
      setCgstPct(parseFloat(data.cgst_pct)||0);
      setSgstPct(parseFloat(data.sgst_pct)||0);
      setIgstPct(parseFloat(data.igst_pct)||0);
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
    // Clear input immediately (before API call) so next scan chars go into a clean field
    setEntry(EMPTY);
    if(barcodeRef.current?.input) barcodeRef.current.input.value='';
    barcodeRef.current?.focus();
    try{
      const{data}=await productAPI.getByBarcode(code);
      const rate=parseFloat(data.sale_rate)||0;
      const gst=parseFloat(data.gst_rate)||0;
      const qty=parseFloat(data.quantity_per_box)||1;
      const unitType=qty>1?'Box':'Pcs';
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
      }]);
      message.success(`${data.product_name} added`,1);
    }catch{
      message.warning('Product not found');
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
    }));
    // Flag so onFocus intercepts any AntD focus-restore and redirects to qty
    justSelectedRef.current=true;
    requestAnimationFrame(()=>{ prodRef.current?.blur(); qtyRef.current?.focus(); });
  },[]);

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
    if(entry.available_stock>0&&entry.quantity>entry.available_stock)
      message.warning(`Low stock! Available: ${entry.available_stock}`);
    const lt=+(entry.quantity*entry.rate).toFixed(2);
    const da=+(lt*(entry.discount_percentage||0)/100).toFixed(2);
    setItems(prev=>[...prev,{...entry,key:nextKeyRef.current++,total_amount:lt-da,discount_amount:da}]);
    setActiveCatId(null); // triggers useEffect → clears prodOpts automatically
    setProdOpen(false);
    setEntry(EMPTY);
    setTimeout(()=>barcodeRef.current?.focus(),50);
  },[entry]);

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
  const subTotal    = items.reduce((s,i)=>s+(i.quantity||0)*(i.rate||0),0);
  const itemDiscTot = items.reduce((s,i)=>s+(i.discount_amount||0),0);
  const billDiscAmt = +(subTotal*discPct/100).toFixed(2);

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
  const productGST  = +items.reduce((s,i)=>{
    const lt=(i.quantity||0)*(i.rate||0)-(i.discount_amount||0);
    const lineTaxable = lt * (1 - billDiscRatio);
    return s+lineTaxable*((i.gst_rate||0)/100);
  },0).toFixed(2);
  // In product-wise mode: derive effective % from item totals; in bill-wise: use manual inputs
  const effCgstPct  = gstMode==='bill' ? (cgstPct||0) : (taxableAmt>0 ? +(productGST/2/taxableAmt*100).toFixed(2) : 0);
  const effSgstPct  = gstMode==='bill' ? (sgstPct||0) : effCgstPct;
  const cgst        = gstMode==='bill' ? +(taxableAmt*(cgstPct||0)/100).toFixed(2) : +(productGST/2).toFixed(2);
  const sgst        = gstMode==='bill' ? +(taxableAmt*(sgstPct||0)/100).toFixed(2) : +(productGST/2).toFixed(2);
  const igstAmt     = +(taxableAmt*(igstPct||0)/100).toFixed(2);
  const effectiveGST= +(cgst+sgst).toFixed(2);
  const totalGST    = +(effectiveGST+igstAmt).toFixed(2);
  const rawTotal    = taxableAmt+totalGST
    +parseFloat(otherChr||0)
    +parseFloat(freightChr||0);
  const roundedTotal = Math.round(rawTotal);
  const roundOff    = +(roundedTotal-rawTotal).toFixed(2);
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
      if(items.length===0){message.warning('Add at least one item');return;}
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
      const body={
        customer_id:vals.customer_id||null,
        bill_date:vals.bill_date.format('YYYY-MM-DD'),
        due_date:vals.due_date?.format('YYYY-MM-DD'),
        discount_percentage:discPct,
        discount_amount:billDiscAmt,
        sale_type:vals.sale_type||'Retail',
        salesman_name:vals.salesman_name||'',
        special_discount:parseFloat(splDisc)||0,
        other_charges:parseFloat(otherChr)||0,
        freight_charges:parseFloat(freightChr)||0,
        return_amount:parseFloat(returnAmt)||0,
        payment_method:vals.payment_method||'Cash',
        remarks:(vals.remarks||'').trim(),
        paid_amount:payFull?roundedTotal:(vals.paid_amount||0),
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
        })),
      };
      const{data}=isEdit?await salesAPI.update(id,body):await salesAPI.create(body);
      message.success(`Bill ${data.bill_number} ${isEdit?'updated':'saved'}!`);
      if(isEdit){
        navigate('/sales');
      } else {
        handleReset();
        setBillNo('');
      }
    }catch(e){message.error(e.response?.data?.error||'Failed to save');}
    finally{setLoading(false); submittingRef.current=false;}
  },[form,items,discPct,billDiscAmt,roundedTotal,splDisc,otherChr,freightChr,returnAmt,isEdit,id,navigate,selectedParty]);

  const handleReset=()=>{
    setItems([]);setEntry(EMPTY);
    form.resetFields(['discount_percentage','paid_amount','return_amount','special_discount','other_charges','freight_charges','salesman_name','remarks']);
    setTimeout(()=>barcodeRef.current?.focus(),50);
  };

  // Warn on tab close/refresh when there's in-progress work.
  const dirty = items.length > 0;
  const confirmLeave = useUnsavedChangesWarning(dirty);

  useCtrlEnterSubmit(()=>handleSave(true));

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
          <div className="sbf-top-inner">

            <div className="sbf-top-head">
              <span className="sbf-pill">
                <span className="dot"></span>
                {isEdit ? 'Edit Sales Bill' : 'Sales Invoice'}
              </span>
              <div className="sbf-doc">
                <span>Bill no.</span>
                <b>{billNo || `New · ${dayjs().format('DD MMM YYYY')}`}</b>
              </div>
              {company && <span className="sbf-company">· {company}</span>}
            </div>

            <div className="sbf-top-row">
              <div className="sbf-field">
                <Form.Item name="customer_id" noStyle>
                  <Select showSearch placeholder="Customer — Cash Sale (optional)"
                    allowClear optionFilterProp="label"
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
              <div className="sbf-field">
                <Form.Item name="bill_date" noStyle rules={[{required:true,message:' '}]}>
                  <DatePicker style={{width:'100%'}} format="DD-MM-YYYY" placeholder="Bill date *"/>
                </Form.Item>
              </div>
              <div className="sbf-field">
                <Form.Item name="due_date" noStyle>
                  <DatePicker style={{width:'100%'}} format="DD-MM-YYYY" placeholder="Due date"/>
                </Form.Item>
              </div>
            </div>

            {/* Party info strip */}
            {selectedParty && (() => {
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
                <div className="sbf-party-info">
                  {selectedParty.city && <span>{selectedParty.city}</span>}
                  {selectedParty.mobile_1 && <span>📞 <b>{selectedParty.mobile_1}</b></span>}
                  <span>Balance <b className={bal >= 0 ? 'pos' : 'neg'}>
                    ₹{bal.toFixed(2)}
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
                    Credit {selectedParty.credit_allowed ? 'allowed' : 'not allowed'}
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

            {/* Entry row */}
            <div className="sbf-top-row-2">
              <div className="sbf-field">
                <Input ref={barcodeRef} value={entry.barcode} placeholder="Barcode / scan"
                  onChange={e=>setEntry(p=>({...p,barcode:e.target.value}))}
                  onPressEnter={e=>{
                    const val=e.target.value.trim();
                    if(val){ e.target.value=''; handleScan(val); }
                  }}
                  onKeyDown={e=>{if(e.key==='ArrowDown'){e.preventDefault();prodRef.current?.focus();}}}
                />
              </div>
              <div className="sbf-field">
                <Select value={activeCatId}
                  onChange={(v,opt)=>{
                    justSelectedRef.current = false;
                    setActiveCatId(v||null);
                    setEntry(p=>({...p,category_id:v||null,category_name:opt?.children||'',product_name:'',product_id:null}));
                  }}
                  placeholder="Category" showSearch
                  filterOption={(input,opt)=>!input||opt.children.toLowerCase().includes(input.toLowerCase())}
                  allowClear notFoundContent={null}>
                  {cats.map(c=><Select.Option key={c.category_id} value={c.category_id}>{c.category_name}</Select.Option>)}
                </Select>
              </div>
              <div className="sbf-field" ref={prodWrapRef}>
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
              {[
                {l:'Size',  ref:sizeRef, f:'size',               v:entry.size,                          i:1,t:'txt'},
                {l:'Art #', ref:artRef,  f:'article_number',     v:entry.article_number,                i:2,t:'txt'},
                {l:'Rate ₹',ref:rateRef, f:'rate',               v:entry.rate||undefined,               i:3,t:'num',min:0},
                {l:'Qty',   ref:qtyRef,  f:'quantity',           v:entry.quantity||undefined,           i:4,t:'num',min:0},
                {l:'Disc%', ref:discRef, f:'discount_percentage',v:entry.discount_percentage||undefined,i:5,t:'num',min:0},
                {l:'GST%',  ref:gstRef,  f:'gst_rate',           v:entry.gst_rate||undefined,           i:6,t:'num',min:0},
              ].map(({l,ref,f,v,i,t,min})=>(
                <div key={f} className="sbf-field">
                  {t==='txt'
                    ?<Input ref={ref} value={v} placeholder={l}
                        onChange={e=>ue(f,e.target.value)} onKeyDown={e=>eKey(e,i)}/>
                    :<InputNumber keyboard={false} ref={ref} value={v} style={{width:'100%'}} min={min} placeholder={l}
                        onChange={vv=>ue(f,vv||0)} onKeyDown={e=>eKey(e,i)}/>
                  }
                </div>
              ))}
              <div className="sbf-field">
                <Select value={entry.unit_type||'Pcs'} placeholder="Unit"
                  onChange={v=>ue('unit_type',v)}>
                  {UNITS.map(u=><Select.Option key={u} value={u}>{u}</Select.Option>)}
                </Select>
              </div>
              <button onClick={addItem} className="sbf-add-btn">+ ADD</button>
              {entry.available_stock>0 && (
                <span className={`sbf-stock-chip ${entry.quantity>entry.available_stock?'low':'ok'}`}>
                  Stock: {entry.available_stock}
                </span>
              )}
            </div>
          </div>
        </section>

        {/* ═══════════════════════════════ (2) MIDDLE ══════════════════════════ */}
        <section className="sbf-mid">
          <div className="sbf-mid-card">
            <div ref={tableWrapRef} className="sbf-tbl-wrap">
              <Table
                columns={cols} dataSource={items} rowKey="key"
                size="small" pagination={false} loading={pgLoading}
                scroll={items.length?{x:1086,y:tblHeight}:{y:tblHeight}}
                locale={{emptyText:(
                  <div className="sbf-empty">
                    <div className="sbf-empty-bolt">⚡</div>
                    <div className="sbf-empty-main">Scan a barcode or search a product to add items</div>
                    <div className="sbf-empty-sub">Use the entry row above to add products to this invoice</div>
                    <div className="sbf-empty-hints">
                      <span><kbd>F1</kbd> save &amp; receive</span>
                      <span><kbd>F8</kbd> save credit</span>
                      <span><kbd>Esc</kbd> go back</span>
                    </div>
                  </div>
                )}}
              />
            </div>
          </div>
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
                    <span className="k" title="CGST + SGST — shared % applies to both halves">GST (C+S)</span>
                    <InputNumber keyboard={false} size="small" min={0} max={100}
                      className="sbf-pct-in" style={{width:'100%'}}
                      value={effCgstPct||undefined} disabled={gstMode==='product'}
                      onChange={v=>{ const n=v||0; setCgstPct(n); setSgstPct(n); }}
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
                        const pct = subTotal>0 ? +((amt||0)/subTotal*100).toFixed(4) : 0;
                        form.setFieldValue('discount_percentage', +pct.toFixed(2));
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
                <div className="sbf-pay-line">
                  <span className="k">Return ₹</span>
                  <Form.Item name="return_amount" noStyle>
                    <InputNumber keyboard={false} min={0} max={roundedTotal} placeholder="0.00"
                      style={{width:'100%'}}/>
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
            <button className="sbf-act" onClick={()=>confirmLeave(()=>navigate('/sales'))}>
              <span className="sbf-kbd">Esc</span> Back
            </button>
            <button className="sbf-act" onClick={handleReset}>
              <span className="sbf-kbd">F5</span> Reset
            </button>
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
    </Form>
  );
}
