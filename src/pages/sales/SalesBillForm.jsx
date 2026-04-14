import React, { useState, useRef, useEffect, useLayoutEffect, useCallback } from 'react';
import { Form, Input, DatePicker, Select, InputNumber, Table, message, AutoComplete } from 'antd';
import { useNavigate, useParams } from 'react-router-dom';
import dayjs from 'dayjs';
import { salesAPI, partyAPI, productAPI, categoryAPI, settingsAPI } from '../../api';
import { useCtrlEnterSubmit } from '../../hooks/useKeyboardShortcuts';

const fmtN = (v) => parseFloat(v || 0).toLocaleString('en-IN', { minimumFractionDigits: 2 });
const fmt  = (v) => `₹ ${fmtN(v)}`;

/* ─── Design tokens ─────────────────────────────────────────────────────── */
const DARK   = 'linear-gradient(160deg,#021a12 0%,#052e1e 55%,#011208 100%)';
const ACC    = '#34d399';
const LBL_C  = '#6ee7b7';
const PRI    = '#10b981';
const TH_BG  = 'linear-gradient(90deg,#065f46 0%,#059669 100%)';
const H      = '100%';

const lbl  = { fontSize:9,  color:LBL_C, fontWeight:700, letterSpacing:.8, textTransform:'uppercase', marginBottom:2 };
const lbl8 = { fontSize:8,  color:LBL_C, fontWeight:700, letterSpacing:.6, textTransform:'uppercase', marginBottom:1 };
const darkIn = { background:'rgba(255,255,255,0.07)', borderColor:'rgba(255,255,255,0.13)', color:'#e2e8f0' };


/* Financial row helpers (right panel) */
const FL  = { fontSize:13, color:'rgba(255,255,255,.92)', fontWeight:600, whiteSpace:'nowrap', width:90, flexShrink:0 };
const VB  = { /* white value display box — flex:1 so all same width */
  background:'#fff', border:'1px solid #d1fae5', borderRadius:6,
  padding:'0 12px', height:32, flex:1,
  display:'flex', alignItems:'center', justifyContent:'flex-end',
  fontSize:14, fontWeight:700, color:'#064e3b',
  fontVariantNumeric:'tabular-nums', boxShadow:'0 1px 3px rgba(0,0,0,.12)',
};

const UNITS    = ['Pcs','Box','Set','Pair','Dozen','Mtr','Roll'];
const PAY_MODES = ['Cash','Card','UPI','Bank Transfer','Cheque','Credit'];

const EMPTY = {
  barcode:'', category_id:null, category_name:'', product_name:'', size:'',
  article_number:'', rate:0, quantity:0, discount_percentage:0,
  hsn_code:'', gst_rate:0, product_id:null, mrp:0, available_stock:0, unit_type:'Pcs',
  quantity_per_box:1,
};

/* ════════════════════════════════════════════════════════════════════════════ */
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
  const [prodOpen, setProdOpen] = useState(false);
  const [company, setCompany]   = useState('');
  const [billNo, setBillNo]     = useState('');
  const [gstMode]               = useState(()=>localStorage.getItem('gst_mode')||'product');
  const [cgstPct, setCgstPct]   = useState(0);
  const [sgstPct, setSgstPct]   = useState(0);
  const [igstPct, setIgstPct]   = useState(0);
  const [selectedParty, setSelectedParty] = useState(null);
  const [discAmtVal, setDiscAmtVal]       = useState(0);
  const discAmtEditingRef                 = useRef(false);

  // Prevents the auto paid_amount effect from overwriting loaded edit values
  const billLoadedRef = useRef(false);

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
      });
      setCgstPct(parseFloat(data.cgst_pct)||0);
      setSgstPct(parseFloat(data.sgst_pct)||0);
      setIgstPct(parseFloat(data.igst_pct)||0);
      setDiscAmtVal(parseFloat(data.discount_amount)||0);
      setItems((data.items||[]).map((it,i)=>({
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
      })));
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
        key:Date.now(),
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

  const buildProdOpts=(list)=>list.map(p=>({
    value:p.product_name,
    label:<div style={{display:'flex',justifyContent:'space-between',gap:8}}>
      <span style={{fontWeight:500}}>{p.product_name}</span>
      <span style={{fontSize:11,color:'#9ca3af',flexShrink:0}}>{[p.size_value,p.article_number].filter(Boolean).join(' · ')}</span>
    </div>,
    product:p,
  }));

  const handleProdSearch=async(v)=>{
    try{
      const catId=entry.category_id;
      const params=catId?{category_id:catId}:{};
      if(!v&&!catId){setProdOpts([]);return;}
      const{data}=await productAPI.search(v||'',params);
      setProdOpts(buildProdOpts(data.data||[]));
    }catch{setProdOpts([]);}
  };

  const handleProdSel=(_,opt)=>{
    if(!opt?.product) return;
    const p=opt.product;
    const qty=parseFloat(p.quantity_per_box)||1;
    const unitType=qty>1?'Box':'Pcs';
    setEntry(prev=>({...prev,product_id:p.product_id,barcode:p.barcode,product_name:p.product_name,
      category_id:p.category_id,category_name:p.Category?.category_name||'',
      size:p.size_value||'',article_number:p.article_number||'',
      rate:parseFloat(p.sale_rate)||0,mrp:parseFloat(p.mrp)||0,
      hsn_code:p.hsn_code||'',gst_rate:parseFloat(p.gst_rate)||0,
      available_stock:parseFloat(p.current_stock)||0,
      quantity:qty, unit_type:unitType, quantity_per_box:parseFloat(p.quantity_per_box)||1,
    }));
    setTimeout(()=>qtyRef.current?.focus(),50);
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
    if(entry.available_stock>0&&entry.quantity>entry.available_stock)
      message.warning(`Low stock! Available: ${entry.available_stock}`);
    const lt=+(entry.quantity*entry.rate).toFixed(2);
    const da=+(lt*(entry.discount_percentage||0)/100).toFixed(2);
    setItems(prev=>[...prev,{...entry,key:Date.now(),total_amount:lt-da,discount_amount:da}]);
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

  const subTotal    = items.reduce((s,i)=>s+(i.quantity||0)*(i.rate||0),0);
  const itemDiscTot = items.reduce((s,i)=>s+(i.discount_amount||0),0);
  const billDiscAmt = +(subTotal*discPct/100).toFixed(2);

  // Sync ₹ disc display when % changes (and user isn't mid-typing in ₹ box)
  useEffect(()=>{
    if(!discAmtEditingRef.current) setDiscAmtVal(billDiscAmt||0);
  },[billDiscAmt]);
  const taxableAmt  = +(subTotal-itemDiscTot-billDiscAmt).toFixed(2);
  const productGST  = +items.reduce((s,i)=>{
    const lt=(i.quantity||0)*(i.rate||0)-(i.discount_amount||0);
    return s+lt*((i.gst_rate||0)/100);
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
  const balance     = +(roundedTotal-parseFloat(returnAmt||0)-paidAmt).toFixed(2);
  const totalQty = items.reduce((s,i)=>s+(i.quantity||0),0);
  // Box count: quantity is always stored as pieces, so boxes = qty / qpb
  const boxQty = items.reduce((s,i)=>{
    const qpb = parseFloat(i.quantity_per_box)||1;
    return s + (i.quantity||0) / qpb;
  },0);

  // Auto-scroll table to bottom when a new item is added
  useEffect(()=>{
    if(!items.length) return;
    const body = tableWrapRef.current?.querySelector('.ant-table-body');
    if(body) body.scrollTop = body.scrollHeight;
  },[items.length]);

  /* Sync selectedParty whenever customerId or parties list changes */
  useEffect(()=>{
    if(customerId && parties.length){
      setSelectedParty(parties.find(p=>p.party_id===customerId)||null);
    } else if(!customerId){
      setSelectedParty(null);
    }
  },[customerId, parties]);

  /* Auto-fill paid amount based on credit policy */
  /* In edit mode this runs once after bill loads — skip it so we don't
     overwrite the saved paid_amount. After that, billLoadedRef stays true
     and subsequent user-triggered changes (customer switch etc.) are
     intentional so we reset the guard then. */
  useEffect(()=>{
    // Skip auto-fill if we just loaded an existing bill
    if(isEdit && billLoadedRef.current){
      billLoadedRef.current = false; // allow future changes by the user
      return;
    }
    const ret = parseFloat(returnAmt||0);
    const due = Math.max(0, +(roundedTotal - ret).toFixed(2));
    if(!customerId){
      // Cash sale — fill total minus any return
      form.setFieldValue('paid_amount', due||0);
    } else {
      const party = parties.find(p=>p.party_id===customerId);
      if(party && !party.credit_allowed){
        // Credit NOT allowed — force full payment minus return
        form.setFieldValue('paid_amount', due||0);
      } else if(party && party.credit_allowed){
        // Credit allowed — leave paid_amount at 0 (user decides)
        form.setFieldValue('paid_amount', 0);
      }
    }
  },[customerId, roundedTotal, returnAmt, parties]);

  /* ── save ── */
  const handleSave=useCallback(async(payFull=false)=>{
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
        paid_amount:payFull?roundedTotal:(vals.paid_amount||0),
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
      navigate('/sales');
    }catch(e){message.error(e.response?.data?.error||'Failed to save');}
    finally{setLoading(false);}
  },[form,items,discPct,billDiscAmt,roundedTotal,splDisc,otherChr,freightChr,returnAmt,isEdit,id,navigate]);

  const handleReset=()=>{
    setItems([]);setEntry(EMPTY);
    form.resetFields(['discount_percentage','paid_amount','return_amount','special_discount','other_charges','freight_charges','salesman_name']);
    setTimeout(()=>barcodeRef.current?.focus(),50);
  };

  useCtrlEnterSubmit(()=>handleSave(true));

  /* ─── Table columns ─────────────────────────────────────────────────────── */
  const numCell=(ri,ci,val,field,min,w)=>(
    <div id={`sc-${ri}-${ci}`}>
      <InputNumber keyboard={false} variant="borderless" value={val}
        onChange={v=>updateItem(items[ri]?.key,field,v??0)}
        onKeyDown={e=>navTbl(e,ri,ci)} min={min??0}
        style={{width:w??'100%',fontSize:13,fontWeight:700,fontFamily:'inherit'}} size="small"/>
    </div>
  );
  const txtCell=(ri,ci,val,field,w)=>(
    <div id={`sc-${ri}-${ci}`}>
      <Input variant="borderless" value={val}
        onChange={e=>updateItem(items[ri]?.key,field,e.target.value)}
        onKeyDown={e=>navTbl(e,ri,ci)}
        style={{width:w??'100%',fontSize:13,fontWeight:700,fontFamily:'inherit'}} size="small"/>
    </div>
  );

  const readCell=(v,style={})=>(
    <span style={{fontSize:13,color:'#1f2937',fontWeight:700,paddingLeft:4,...style}}>{v||'—'}</span>
  );

  const cols=[
    {title:'#',width:34,align:'center',render:(_,__,i)=><span style={{color:'#94a3b8',fontSize:13,fontWeight:700}}>{i+1}</span>},
    {title:'Barcode',dataIndex:'barcode',width:120,render:(v)=>readCell(v,{color:'#374151'})},
    {title:'Product Name',dataIndex:'product_name',width:200,render:(v)=>readCell(v,{})},
    {title:'Size',dataIndex:'size',width:60,render:(v)=>readCell(v,{color:'#6b7280'})},
    {title:'Unit',dataIndex:'unit_type',width:70,align:'center',render:(v)=>(
      <span style={{fontSize:13,fontWeight:700,background:'#f3f4f6',borderRadius:4,padding:'1px 6px',color:'#374151'}}>{v||'Pcs'}</span>
    )},
    {title:'Art#',dataIndex:'article_number',width:80,render:(v)=>readCell(v,{color:'#6b7280'})},
    {title:'Qty',dataIndex:'quantity',width:72,align:'center',render:(v,r,ri)=>numCell(ri,5,v,'quantity',0,66)},
    {title:'Rate ₹',dataIndex:'rate',width:96,align:'right',render:(v,r,ri)=>numCell(ri,6,v,'rate',0,90)},
    {title:'Disc%',dataIndex:'discount_percentage',width:62,align:'right',render:(v,r,ri)=>numCell(ri,7,v,'discount_percentage',0,56)},
    {title:'GST%',dataIndex:'gst_rate',width:58,align:'right',render:(v,r,ri)=>numCell(ri,8,v,'gst_rate',0,52)},
    {title:'Amount ₹',width:116,align:'right',render:(_,r)=>{
      const lt=(r.quantity||0)*(r.rate||0);
      const da=lt*(r.discount_percentage||0)/100;
      return <span style={{color:'#059669',fontWeight:700,fontSize:13,fontFamily:'inherit',paddingRight:6}}>{fmtN(lt-da)}</span>;
    }},
    {title:'',width:32,align:'center',render:(_,r)=>(
      <button onClick={()=>removeItem(r.key)}
        style={{background:'none',border:'none',cursor:'pointer',color:'#f87171',
          padding:'2px 4px',borderRadius:4,lineHeight:1,fontSize:16}}>×</button>
    )},
  ];

  /* ─── render ─────────────────────────────────────────────────────────────── */
  return (
    <Form form={form} component={false}>
      <style>{`
        .sbf-dark .ant-input,
        .sbf-dark .ant-input-number,
        .sbf-dark .ant-picker,
        .sbf-dark .ant-select:not(.ant-select-customize-input) .ant-select-selector,
        .sbf-dark .ant-autocomplete .ant-select-selector {
          background:rgba(255,255,255,0.07)!important;
          border:1px solid rgba(255,255,255,0.13)!important;
          border-radius:6px!important;
        }
        .sbf-dark .ant-input,
        .sbf-dark .ant-input-number-input,
        .sbf-dark .ant-picker-input>input,
        .sbf-dark .ant-select-selection-item,
        .sbf-dark .ant-select-selection-placeholder,
        .sbf-dark .ant-autocomplete .ant-select-selection-search-input {
          color:#e2e8f0!important; font-size:12px!important;
        }
        .sbf-dark .ant-select-selection-item{line-height:24px!important;}
        .sbf-dark .ant-select-arrow,.sbf-dark .ant-picker-suffix{color:rgba(255,255,255,0.35)!important;}
        .sbf-dark .ant-select-clear{background:rgba(2,18,10,.9)!important;color:rgba(255,255,255,.5)!important;}
        .sbf-bot .ant-input-number,.sbf-bot .ant-input-number-input,
        .sbf-bot .ant-input,
        .sbf-bot .ant-select .ant-select-selector{
          background:rgba(255,255,255,0.07)!important;
          border-color:rgba(255,255,255,0.12)!important;
          color:#e2e8f0!important;
        }
        .sbf-bot .ant-select-selection-item,.sbf-bot .ant-select-arrow{color:#e2e8f0!important;}
        .sbf-tbl .ant-table-cell{
          border-inline-end:none!important;
          padding:3px 6px!important;
          border-bottom:1px solid #ecfdf5!important;
        }
        .sbf-tbl .ant-table-thead .ant-table-cell{
          padding:10px 8px!important;
          border-inline-end:1px solid rgba(255,255,255,0.1)!important;
        }
        .sbf-tbl .ant-table-tbody>tr:hover>td{background:#ecfdf5!important;}
        .sbf-tbl .ant-table-summary>tr>td{
          border-inline-end:none!important;
          padding:7px 8px!important;
          background:#f0fdf4!important;
        }
        .sbf-tbl .ant-table-placeholder .ant-table-cell{border-bottom:none!important;}
        .sbf-tbl .ant-input-number-input,
        .sbf-tbl .ant-input{font-size:13px!important;font-weight:700!important;color:#1f2937!important;}
        .sbf-btn{transition:all 0.15s!important;}
        .sbf-btn:hover{filter:brightness(1.15);transform:translateY(-1px);}
        .sbf-btn:active{transform:translateY(0);filter:brightness(.95);}

        /* Financial panel white inputs — uniform style */
        .sbf-fin-in.ant-input-number,
        .sbf-paid-in.ant-input-number {
          background: #fff !important;
          border: 1px solid #d1fae5 !important;
          border-radius: 6px !important;
          box-shadow: 0 1px 3px rgba(0,0,0,.12) !important;
          height: 32px !important;
          width: 100% !important;
        }
        .sbf-fin-in .ant-input-number-input,
        .sbf-paid-in .ant-input-number-input {
          background: #fff !important;
          color: #064e3b !important;
          font-weight: 700 !important;
          font-size: 13px !important;
          text-align: right !important;
          height: 30px !important;
        }
        .sbf-fin-in .ant-input-number-input::placeholder,
        .sbf-paid-in .ant-input-number-input::placeholder { color: #9ca3af !important; font-weight:400 !important; }
        /* Payment select */
        .sbf-pay-sel.ant-select .ant-select-selector {
          background: #fff !important;
          border: 1px solid #d1fae5 !important;
          border-radius: 6px !important;
          height: 32px !important;
          box-shadow: 0 1px 3px rgba(0,0,0,.12) !important;
        }
        .sbf-pay-sel .ant-select-selection-item { color: #064e3b !important; font-weight:700 !important; font-size: 13px !important; line-height: 30px !important; }
        .sbf-pay-sel .ant-select-arrow { color: #064e3b !important; }
      `}</style>

      <div style={{
        height:H,
        display:'flex', flexDirection:'column', overflow:'hidden',
        fontFamily:"'Inter','Segoe UI',system-ui,sans-serif",
      }}>

        {/* ══════════════════════════════════════════════════════════════════
            TOP — 15%
            ═══════════════════════════════════════════════════════════════ */}
        <div className="sbf-dark" style={{
          flexShrink:0,
          background:DARK,
          display:'flex', flexDirection:'column', gap:8,
          padding:'10px 20px 12px',
          borderBottom:'2px solid rgba(16,185,129,0.35)',
          boxShadow:'0 4px 24px rgba(0,0,0,0.4)',
        }}>

          {/* header row */}
          <div style={{display:'flex',alignItems:'center',gap:10}}>
            <button onClick={()=>navigate('/sales')} className="sbf-btn"
              style={{background:'rgba(255,255,255,0.08)',border:'1px solid rgba(255,255,255,0.12)',
                borderRadius:6,color:ACC,cursor:'pointer',padding:'3px 10px',
                fontSize:12,fontWeight:600,display:'flex',alignItems:'center',gap:5}}>
              ← Back
            </button>
            {company&&<span style={{color:'rgba(255,255,255,0.28)',fontSize:11}}>{company}</span>}
            <div style={{display:'flex',alignItems:'center',gap:7,
              background:'rgba(16,185,129,0.15)',border:'1px solid rgba(16,185,129,0.3)',
              borderRadius:20,padding:'3px 14px'}}>
              <span style={{width:6,height:6,borderRadius:'50%',background:ACC,
                display:'inline-block',boxShadow:`0 0 6px ${ACC}`}}/>
              <span style={{color:ACC,fontWeight:800,fontSize:12,letterSpacing:1.8,textTransform:'uppercase'}}>
                {isEdit?'Edit Sales Bill':'Sales Invoice'}
              </span>
            </div>
            {billNo&&(
              <span style={{fontSize:11,
                background:'rgba(16,185,129,0.18)',border:'1px solid rgba(16,185,129,0.35)',
                color:'#a7f3d0',borderRadius:12,padding:'2px 10px'}}>{billNo}
              </span>
            )}
            <div style={{marginLeft:'auto'}}/>
          </div>

          {/* customer / date row */}
          <div style={{display:'flex',gap:10,alignItems:'flex-end',flexWrap:'wrap'}}>
            <div style={{display:'flex',flexDirection:'column',justifyContent:'flex-end'}}>
              <div style={lbl8}>Customer</div>
              <Form.Item name="customer_id" noStyle>
                <Select showSearch style={{width:260}} placeholder="Cash Sale (optional)"
                  allowClear optionFilterProp="label"
                  dropdownStyle={{minWidth:600,padding:0}}
                  dropdownRender={menu=>(
                    <div>
                      <div style={{display:'flex',gap:0,background:'#fde047',padding:'5px 12px',
                        fontSize:11,fontWeight:700,color:'#1f2937',borderBottom:'2px solid #ca8a04'}}>
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
                        <span style={{flex:'0 0 120px',color:'#6b7280',overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap',paddingRight:6}}>{p.city||'—'}</span>
                        <span style={{flex:'0 0 110px',color:'#374151'}}>{p.mobile_1||'—'}</span>
                        <span style={{flex:'0 0 80px',textAlign:'right',fontWeight:700,paddingRight:8,
                          color:bal>0?'#059669':bal<0?'#dc2626':'#6b7280'}}>
                          {bal.toFixed(1)}
                        </span>
                        <span style={{flex:'0 0 70px',textAlign:'center'}}>
                          <span style={{background:p.credit_allowed?'#d1fae5':'#fee2e2',
                            color:p.credit_allowed?'#065f46':'#991b1b',
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
            <div>
              <div style={lbl8}>Bill Date *</div>
              <Form.Item name="bill_date" noStyle rules={[{required:true,message:' '}]}>
                <DatePicker style={{width:130}} format="DD-MM-YYYY"/>
              </Form.Item>
            </div>
            <div>
              <div style={lbl8}>Due Date</div>
              <Form.Item name="due_date" noStyle>
                <DatePicker style={{width:130}} format="DD-MM-YYYY"/>
              </Form.Item>
            </div>
          </div>
          {/* Party info badge — outside the flex row so it doesn't affect alignment */}
          {selectedParty&&(
            <div style={{display:'flex',gap:12,alignItems:'center',marginTop:3,flexWrap:'wrap'}}>
              {selectedParty.city&&<span style={{fontSize:13,color:'rgba(255,255,255,0.6)'}}>{selectedParty.city}</span>}
              {selectedParty.mobile_1&&<span style={{fontSize:14,fontWeight:700,color:'rgba(255,255,255,0.85)',letterSpacing:.5}}>{selectedParty.mobile_1}</span>}
              <span style={{fontSize:14,fontWeight:800,
                color:parseFloat(selectedParty.current_balance||0)>0?'#34d399':'#f87171'}}>
                Bal: ₹{parseFloat(selectedParty.current_balance||0).toFixed(2)}
              </span>
              <span style={{fontSize:12,fontWeight:700,padding:'2px 10px',borderRadius:4,
                background:selectedParty.credit_allowed?'rgba(52,211,153,0.15)':'rgba(248,113,113,0.15)',
                border:`1px solid ${selectedParty.credit_allowed?'rgba(52,211,153,0.3)':'rgba(248,113,113,0.3)'}`,
                color:selectedParty.credit_allowed?'#34d399':'#f87171'}}>
                Credit: {selectedParty.credit_allowed?'Allowed':'Not Allowed'}
              </span>
            </div>
          )}

          {/* entry row */}
          <div style={{display:'flex',gap:8,alignItems:'flex-end',flexWrap:'wrap'}}>
            <div style={{flexShrink:0}}>
              <div style={lbl8}>Barcode / Scan</div>
              <Input ref={barcodeRef} value={entry.barcode} placeholder="Scan or type…"
                onChange={e=>setEntry(p=>({...p,barcode:e.target.value}))}
                onPressEnter={e=>{
                  const val=e.target.value.trim();
                  if(val){ e.target.value=''; handleScan(val); }
                }}
                onKeyDown={e=>{if(e.key==='ArrowDown'){e.preventDefault();prodRef.current?.focus();}}}
                style={{width:140,}}/>
            </div>
            <div style={{flexShrink:0}}>
              <div style={lbl8}>Category</div>
              <Select style={{width:200}} value={entry.category_id}
                onChange={async(v,opt)=>{
                  setEntry(p=>({...p,category_id:v||null,category_name:opt?.children||'',product_name:'',product_id:null}));
                  setProdOpts([]);
                  setProdOpen(false);
                  if(v){
                    try{
                      const{data}=await productAPI.search('',{category_id:v});
                      const opts=buildProdOpts(data.data||[]);
                      setProdOpts(opts);
                      setProdOpen(true);
                      setTimeout(()=>{
                        const inp=prodWrapRef.current?.querySelector('input');
                        inp?.focus();
                      },60);
                    }catch{setProdOpts([]);}
                  }
                }}
                placeholder="Type to search…" showSearch
                filterOption={(input,opt)=>input?opt.children.toLowerCase().includes(input.toLowerCase()):false}
                allowClear notFoundContent={null}>
                {cats.map(c=><Select.Option key={c.category_id} value={c.category_id}>{c.category_name}</Select.Option>)}
              </Select>
            </div>
            <div ref={prodWrapRef} style={{flexShrink:0}}>
              <div style={lbl8}>Product Name</div>
              <AutoComplete ref={prodRef} style={{width:200}} options={prodOpts} value={entry.product_name}
                open={prodOpen}
                onSearch={v=>{ setProdOpen(true); handleProdSearch(v); }}
                onSelect={(v,opt)=>{ setProdOpen(false); handleProdSel(v,opt); }}
                onFocus={()=>{ if(prodOpts.length>0) setProdOpen(true); }}
                onBlur={()=>setProdOpen(false)}
                onChange={v=>setEntry(p=>({...p,product_name:v,product_id:null}))}
                placeholder="Search product…" notFoundContent={null}
                dropdownMatchSelectWidth={360}/>
            </div>
            {[
              {l:'Size',  ref:sizeRef, f:'size',               v:entry.size,                          w:70, i:1,t:'txt'},
              {l:'Art #', ref:artRef,  f:'article_number',     v:entry.article_number,                w:80, i:2,t:'txt'},
              {l:'Rate ₹',ref:rateRef, f:'rate',               v:entry.rate||undefined,               w:100,i:3,t:'num',min:0},
              {l:'Qty',   ref:qtyRef,  f:'quantity',           v:entry.quantity||undefined,           w:80, i:4,t:'num',min:0},
              {l:'Disc%', ref:discRef, f:'discount_percentage',v:entry.discount_percentage||undefined,w:70, i:5,t:'num',min:0},
              {l:'GST%',  ref:gstRef,  f:'gst_rate',           v:entry.gst_rate||undefined,           w:70, i:6,t:'num',min:0},
            ].map(({l,ref,f,v,w,i,t,min})=>(
              <div key={f} style={{flexShrink:0}}>
                <div style={lbl8}>{l}</div>
                {t==='txt'
                  ?<Input ref={ref} value={v} style={{width:w}}
                      onChange={e=>ue(f,e.target.value)} onKeyDown={e=>eKey(e,i)}/>
                  :<InputNumber keyboard={false} ref={ref} value={v} style={{width:w}} min={min}
                      onChange={vv=>ue(f,vv||0)} onKeyDown={e=>eKey(e,i)}/>
                }
              </div>
            ))}
            <div style={{flexShrink:0}}>
              <div style={lbl8}>Unit</div>
              <Select value={entry.unit_type||'Pcs'} style={{width:80}}
                onChange={v=>ue('unit_type',v)}>
                {UNITS.map(u=><Select.Option key={u} value={u}>{u}</Select.Option>)}
              </Select>
            </div>
            <div style={{flexShrink:0,display:'flex',flexDirection:'column',justifyContent:'flex-end'}}>
              <button onClick={addItem} className="sbf-btn"
                style={{background:`linear-gradient(135deg,${PRI},#34d399)`,
                  border:'none',color:'#fff',borderRadius:7,
                  padding:'6px 22px',fontSize:13,fontWeight:700,cursor:'pointer',
                  height:32,display:'flex',alignItems:'center',gap:6,
                  boxShadow:'0 0 14px rgba(16,185,129,0.55)'}}>
                + ADD
              </button>
            </div>
            {entry.available_stock>0&&(
              <span style={{alignSelf:'flex-end',fontSize:11,
                color:entry.quantity>entry.available_stock?'#f87171':'#34d399',
                background:entry.quantity>entry.available_stock?'rgba(239,68,68,0.12)':'rgba(16,185,129,0.12)',
                border:`1px solid ${entry.quantity>entry.available_stock?'rgba(248,113,113,.3)':'rgba(52,211,153,.3)'}`,
                borderRadius:10,padding:'3px 10px'}}>
                Stock: {entry.available_stock}
              </span>
            )}
          </div>
        </div>

        {/* ══════════════════════════════════════════════════════════════════
            TABLE — flex:1  (added products)
            ═══════════════════════════════════════════════════════════════ */}
        <div ref={tableWrapRef} className="sbf-tbl" style={{flex:1,overflow:'hidden',minHeight:0,background:'#fff'}}>
          <Table
            columns={cols} dataSource={items} rowKey="key"
            size="small" pagination={false} loading={pgLoading}
            scroll={items.length?{x:1150,y:tblHeight}:{y:tblHeight}}
            components={{header:{cell:(props)=>(
              <th {...props} style={{
                background:TH_BG,color:'#fff',fontWeight:700,fontSize:11,
                padding:'10px 8px',border:'none',borderBottom:'2px solid #065f46',
                whiteSpace:'nowrap',textTransform:'uppercase',letterSpacing:.5,
              }}/>
            )}}}
            locale={{emptyText:(
              <div style={{padding:48,textAlign:'center',color:'#c4c4c4'}}>
                <div style={{fontSize:36,marginBottom:10}}>⚡</div>
                <div style={{fontSize:14,fontWeight:500}}>Scan a barcode or search a product to add items</div>
                <div style={{fontSize:12,marginTop:4,color:'#d1d5db'}}>Use the entry row above to add products to this invoice</div>
              </div>
            )}}
          />
        </div>

        {/* ══════════════════════════════════════════════════════════════════
            BOTTOM — 28%   LEFT: stats + controls    RIGHT: financials
            ═══════════════════════════════════════════════════════════════ */}
        <div className="sbf-bot" style={{
          height:'40%', minHeight:310,
          background:DARK, flexShrink:0,
          borderTop:'2px solid rgba(16,185,129,0.3)',
          padding:'10px 20px',
          display:'flex', flexDirection:'row', gap:0,
          boxShadow:'0 -4px 28px rgba(0,0,0,0.4)',
        }}>

          {/* ─────────────────────────────────────────────────
              LEFT PANEL  — stats, controls, buttons
              ───────────────────────────────────────────────── */}
          <div style={{
            flex:1, display:'flex', flexDirection:'column', justifyContent:'space-between',
            paddingRight:20,
            borderRight:'1px solid rgba(255,255,255,0.1)',
          }}>

            {/* Stat mini-cards */}
            <div style={{display:'flex',gap:8}}>
              {[
                {l:'ITEMS',v:items.length,        c:'rgba(52,211,153,0.9)'},
                {l:'QTY',  v:totalQty.toFixed(1), c:'rgba(96,165,250,0.9)'},
                {l:'BOX',  v:boxQty.toFixed(1),   c:'rgba(251,191,36,0.9)'},
              ].map(({l,v,c})=>(
                <div key={l} style={{textAlign:'center',
                  background:'rgba(255,255,255,0.06)',
                  border:`1px solid ${c}40`,
                  borderRadius:8, padding:'4px 16px', minWidth:64}}>
                  <div style={{fontSize:8,color:c,fontWeight:700,letterSpacing:.8}}>{l}</div>
                  <div style={{color:'#fff',fontWeight:800,fontSize:20,lineHeight:1.2}}>{v}</div>
                </div>
              ))}
            </div>

            {/* Controls row */}
            <div style={{display:'flex',gap:14,alignItems:'flex-end',flexWrap:'wrap'}}>
              <div>
                <div style={lbl}>Sale Type</div>
                <Form.Item name="sale_type" noStyle initialValue="Retail">
                  <Select size="small" style={{width:96}}>
                    <Select.Option value="Retail">Retail</Select.Option>
                    <Select.Option value="Wholesale">Wholesale</Select.Option>
                  </Select>
                </Form.Item>
              </div>
              <div>
                <div style={lbl}>Salesman</div>
                <Form.Item name="salesman_name" noStyle>
                  <Input size="small" placeholder="Name" style={{width:120,...darkIn}}/>
                </Form.Item>
              </div>
            </div>

            {/* Action buttons */}
            <div style={{display:'flex',gap:8}}>
              {[
                {label:'Back',        kbd:'ESC',bg:'#0d2b1e',                onClick:()=>navigate('/sales')},
                {label:'Reset',       kbd:'F5', bg:'#0d2b1e',                onClick:handleReset},
                {label:'Save Credit', kbd:'F8', bg:'#1e3a8a',                onClick:()=>handleSave(false),disabled:loading},
                {label:'Save & Rcv',  kbd:'F1', bg:'linear-gradient(135deg,#065f46,#059669)',primary:true,onClick:()=>handleSave(true),disabled:loading},
              ].map(({label,kbd,bg,onClick,primary,disabled})=>(
                <button key={kbd} onClick={onClick} disabled={disabled} className="sbf-btn"
                  style={{
                    background:bg, color:'#fff',
                    border:primary?'none':'1px solid rgba(255,255,255,.14)',
                    borderRadius:8, padding:'8px 18px', fontSize:13, fontWeight:700,
                    cursor:'pointer', display:'flex', alignItems:'center', gap:7,
                    opacity:disabled?.55:1,
                    boxShadow:primary?'0 0 18px rgba(16,185,129,.45)':'none',
                    whiteSpace:'nowrap',
                  }}>
                  <span style={{background:'rgba(0,0,0,.3)',borderRadius:4,
                    padding:'2px 6px',fontSize:9,fontWeight:700,letterSpacing:.5}}>{kbd}</span>
                  {label}
                </button>
              ))}
            </div>
          </div>

          {/* ─────────────────────────────────────────────────
              RIGHT PANEL — two sub-columns (financials | NET TOTAL)
              ───────────────────────────────────────────────── */}
          <div style={{
            width:500,
            paddingLeft:20,
            display:'flex', flexDirection:'row', gap:14,
            borderLeft:'1px solid rgba(255,255,255,.1)',
          }}>

            {/* ── Sub-left: financial rows — all boxes flex:1 so same width ── */}
            <div style={{flex:1, display:'flex', flexDirection:'column', gap:6}}>

              {/* Taxable total */}
              <div style={{display:'flex',alignItems:'center',gap:10}}>
                <span style={FL}>Total</span>
                <div style={VB}>{fmtN(taxableAmt)}</div>
              </div>

              {/* CGST: [% input] [₹ amount] */}
              <div style={{display:'flex',alignItems:'center',gap:10}}>
                <span style={FL}>CGST</span>
                <div style={{flex:1,display:'flex',gap:6}}>
                  <div style={{width:62,flexShrink:0}}>
                    <InputNumber keyboard={false} size="small" min={0} max={100}
                      className="sbf-fin-in" style={{width:'100%'}}
                      value={effCgstPct||undefined} disabled={gstMode==='product'}
                      onChange={v=>setCgstPct(v||0)}
                      formatter={v=>v?`${v}%`:''} parser={v=>v?.replace('%','')||''}
                      placeholder="%"/>
                  </div>
                  <div style={{...VB,flex:1}}>{fmtN(cgst)}</div>
                </div>
              </div>

              {/* SGST: [% input] [₹ amount] */}
              <div style={{display:'flex',alignItems:'center',gap:10}}>
                <span style={FL}>SGST</span>
                <div style={{flex:1,display:'flex',gap:6}}>
                  <div style={{width:62,flexShrink:0}}>
                    <InputNumber keyboard={false} size="small" min={0} max={100}
                      className="sbf-fin-in" style={{width:'100%'}}
                      value={effSgstPct||undefined} disabled={gstMode==='product'}
                      onChange={v=>setSgstPct(v||0)}
                      formatter={v=>v?`${v}%`:''} parser={v=>v?.replace('%','')||''}
                      placeholder="%"/>
                  </div>
                  <div style={{...VB,flex:1}}>{fmtN(sgst)}</div>
                </div>
              </div>

              {/* IGST: [% input] [₹ amount] */}
              <div style={{display:'flex',alignItems:'center',gap:10}}>
                <span style={FL}>IGST</span>
                <div style={{flex:1,display:'flex',gap:6}}>
                  <div style={{width:62,flexShrink:0}}>
                    <InputNumber keyboard={false} size="small" min={0} max={100}
                      className="sbf-fin-in" style={{width:'100%'}}
                      value={igstPct||undefined}
                      onChange={v=>setIgstPct(v||0)}
                      formatter={v=>v?`${v}%`:''} parser={v=>v?.replace('%','')||''}
                      placeholder="%"/>
                  </div>
                  <div style={{...VB,flex:1}}>{fmtN(igstAmt)}</div>
                </div>
              </div>

              {/* Total GST */}
              <div style={{display:'flex',alignItems:'center',gap:10}}>
                <span style={FL}>Total GST</span>
                <div style={{...VB,color:'#b45309',fontWeight:700}}>{fmtN(totalGST)}</div>
              </div>

              {/* Other / Freight charges */}
              {[
                {label:'Other Chr.',  el:(
                  <Form.Item name="other_charges" noStyle>
                    <InputNumber keyboard={false} size="small" min={0} placeholder="0.00"
                      className="sbf-fin-in" style={{flex:1,width:'100%'}}/>
                  </Form.Item>
                )},
                {label:'Freight Chr.',el:(
                  <Form.Item name="freight_charges" noStyle>
                    <InputNumber keyboard={false} size="small" min={0} placeholder="0.00"
                      className="sbf-fin-in" style={{flex:1,width:'100%'}}/>
                  </Form.Item>
                )},
              ].map(({label,el})=>(
                <div key={label} style={{display:'flex',alignItems:'center',gap:10}}>
                  <span style={FL}>{label}</span>
                  {el}
                </div>
              ))}

              {/* Bill Disc — % and ₹ both sync bidirectionally */}
              <div style={{display:'flex',alignItems:'center',gap:10}}>
                <span style={FL}>Bill Disc</span>
                <div style={{flex:1,display:'flex',gap:6}}>
                  <Form.Item name="discount_percentage" noStyle>
                    <InputNumber keyboard={false} size="small" min={0} max={100} placeholder="%"
                      className="sbf-fin-in" style={{flex:1,width:'100%'}}
                      formatter={v=>v?`${v}%`:''} parser={v=>v?.replace('%','')||''}
                      onChange={pct=>{
                        discAmtEditingRef.current=false;
                        setDiscAmtVal(+(subTotal*(pct||0)/100).toFixed(2));
                      }}/>
                  </Form.Item>
                  <InputNumber keyboard={false} size="small" min={0} placeholder="₹ amt"
                    className="sbf-fin-in" style={{flex:1,width:'100%'}}
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

            {/* ── Sub-right: NET TOTAL + payment ── */}
            <div style={{width:210, display:'flex', flexDirection:'column', gap:7}}>

              <div style={{fontSize:11,fontWeight:800,color:'rgba(255,255,255,.6)',letterSpacing:1,textTransform:'uppercase'}}>
                Net Total Rs.
              </div>

              {/* Big NET TOTAL */}
              <div style={{
                height:72, background:'#fff', borderRadius:8, flexShrink:0,
                display:'flex', alignItems:'center', justifyContent:'flex-end',
                padding:'0 14px', fontSize:38, fontWeight:900, color:'#064e3b',
                letterSpacing:-2, border:'1px solid #d1fae5',
                boxShadow:'0 2px 8px rgba(0,0,0,.15)', fontVariantNumeric:'tabular-nums',
              }}>
                {roundedTotal.toLocaleString('en-IN')}
              </div>

              {/* Payment mode */}
              <Form.Item name="payment_method" noStyle initialValue="Cash">
                <Select size="small" style={{width:'100%'}} className="sbf-pay-sel">
                  {PAY_MODES.map(m=><Select.Option key={m} value={m}>{m}</Select.Option>)}
                </Select>
              </Form.Item>

              {/* Return ₹ */}
              <div style={{display:'flex',alignItems:'center',gap:8,marginTop:4}}>
                <span style={{color:'rgba(255,255,255,.85)',fontWeight:700,fontSize:12,width:56,flexShrink:0}}>Return ₹</span>
                <Form.Item name="return_amount" noStyle>
                  <InputNumber keyboard={false} size="small" min={0} placeholder="0.00"
                    className="sbf-paid-in" style={{flex:1,width:'100%'}}/>
                </Form.Item>
              </div>

              {/* Amt Paid */}
              <div style={{display:'flex',alignItems:'center',gap:8}}>
                <span style={{color:'rgba(255,255,255,.85)',fontWeight:700,fontSize:12,width:56,flexShrink:0}}>Amt Paid</span>
                <Form.Item name="paid_amount" noStyle>
                  <InputNumber keyboard={false} size="small" min={0} placeholder="0.00"
                    className="sbf-paid-in" style={{flex:1,width:'100%'}}/>
                </Form.Item>
              </div>

              {/* Balance */}
              <div style={{
                display:'flex', alignItems:'center', justifyContent:'space-between',
                background:balance>0?'rgba(239,68,68,0.15)':'rgba(52,211,153,0.12)',
                borderRadius:8, padding:'6px 12px', flexShrink:0,
                border:`1px solid ${balance>0?'rgba(248,113,113,.4)':'rgba(52,211,153,.3)'}`,
              }}>
                <span style={{fontSize:10,color:'rgba(255,255,255,.6)',fontWeight:700,letterSpacing:.8,textTransform:'uppercase'}}>Balance</span>
                <span style={{fontSize:17,fontWeight:800,color:balance>0?'#f87171':'#34d399',letterSpacing:-.5}}>
                  {fmtN(Math.abs(balance))}{balance<0?' ▲':''}
                </span>
              </div>

            </div>
          </div>
        </div>
      </div>
    </Form>
  );
}
