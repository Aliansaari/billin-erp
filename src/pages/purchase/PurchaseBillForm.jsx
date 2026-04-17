import React, { useState, useRef, useEffect, useLayoutEffect, useCallback, useMemo } from 'react';
import { Form, Input, DatePicker, Select, InputNumber, Table, Typography, message } from 'antd';
import { ArrowLeftOutlined } from '@ant-design/icons';
import { useNavigate, useParams } from 'react-router-dom';
import dayjs from 'dayjs';
import { purchaseAPI, partyAPI, productAPI, categoryAPI, settingsAPI } from '../../api';
import { useCtrlEnterSubmit } from '../../hooks/useKeyboardShortcuts';
import BarcodePrintModal from '../../components/BarcodePrintModal';

const fmt  = (v) => `₹ ${parseFloat(v || 0).toLocaleString('en-IN', { minimumFractionDigits: 2 })}`;
const fmtN = (v) => parseFloat(v || 0).toLocaleString('en-IN', { minimumFractionDigits: 2 });

/* ─── Tokens ── Purchase = deep indigo ───────────────────────────────────── */
const DARK  = 'linear-gradient(160deg,#0d0b1e 0%,#1a1245 55%,#0f0c29 100%)';
const ACC   = '#818cf8';
const LBL_C = '#a5b4fc';
const PRI   = '#6366f1';
const TH_BG = 'linear-gradient(90deg,#3730a3 0%,#4f46e5 100%)';
const H     = '100%';

/* Financial row helpers */
const FL = { fontSize:13, color:'rgba(255,255,255,.92)', fontWeight:600, whiteSpace:'nowrap', width:90, flexShrink:0 };
const VB = {
  background:'#fff', border:'1px solid #c7d2fe', borderRadius:6,
  padding:'0 12px', height:32, flex:1,
  display:'flex', alignItems:'center', justifyContent:'flex-end',
  fontSize:14, fontWeight:700, color:'#1e1b4b',
  fontVariantNumeric:'tabular-nums', boxShadow:'0 1px 3px rgba(0,0,0,.12)',
};
/* Financial panel row helpers */
const finLbl = { fontSize:11, color:'rgba(255,255,255,.5)', fontWeight:600, whiteSpace:'nowrap', padding:'2px 0' };
const finVal = { textAlign:'right', fontSize:12, fontWeight:700, color:'#e2e8f0', fontVariantNumeric:'tabular-nums', padding:'2px 0' };

const EMPTY_ENTRY = {
  barcode:'', category_id:null, category_name:'', product_name:'', size:'',
  article_number:'', purchase_rate:0, quantity:0, quantity_per_box:1,
  margin_percentage:0, sale_rate:0, mrp:0, hsn_code:'', gst_rate:0, product_id:null,
};
const lbl = { fontSize:9, color:LBL_C, fontWeight:700, letterSpacing:.8, textTransform:'uppercase', marginBottom:2 };

/* ── Variant Picker Dropdown ─────────────────────────────────────────────── */
function VariantPickerDropdown({ options, selectedIdx, onPick, onDismiss, top, left, rateFilter }) {
  const matchCount = rateFilter!=null&&rateFilter>0
    ? options.filter(v=>Math.abs(parseFloat(v.purchase_rate||0)-parseFloat(rateFilter))<0.01).length
    : null;
  return (
    <div
      data-variant-picker="1"
      onMouseDown={e=>e.preventDefault()}
      style={{
        position:'fixed', top, left, zIndex:9999,
        background:'#fff',
        border:'1px solid #e0e7ff',
        borderRadius:10,
        boxShadow:'0 12px 40px rgba(0,0,0,.18), 0 2px 8px rgba(99,102,241,.12)',
        minWidth:520,
        maxHeight:340,
        overflow:'hidden',
        display:'flex',
        flexDirection:'column',
        animation:'fadeIn .12s ease-out',
      }}
    >
      {/* Header — matches product dropdown indigo gradient */}
      <div style={{
        display:'flex', alignItems:'center', justifyContent:'space-between',
        padding:'7px 12px',
        background:'linear-gradient(90deg,#3730a3 0%,#4f46e5 100%)',
        flexShrink:0,
      }}>
        <div style={{display:'flex',alignItems:'center',gap:8}}>
          <span style={{fontSize:11,fontWeight:700,color:'#fff',letterSpacing:.8,textTransform:'uppercase'}}>
            {options.length} Variant{options.length!==1?'s':''} found
          </span>
          {matchCount!=null&&(
            <span style={{fontSize:10,background:'rgba(52,211,153,.25)',color:'#6ee7b7',border:'1px solid rgba(52,211,153,.4)',borderRadius:10,padding:'1px 8px',fontWeight:700}}>
              {matchCount} match ₹{parseFloat(rateFilter).toFixed(2)}
            </span>
          )}
        </div>
        <span style={{fontSize:10,color:'rgba(255,255,255,.5)'}}>↑↓ · Enter · Esc</span>
      </div>

      {/* Rows — same style as product Select.Option */}
      <div style={{overflowY:'auto',flex:1}}>
        {options.map((v,i)=>{
          const stock=parseFloat(v.current_stock||0);
          const stockColor=stock<=0?'#ef4444':stock<=5?'#f59e0b':'#6b7280';
          const isSelected=i===selectedIdx;
          const rateMatches=matchCount!=null&&Math.abs(parseFloat(v.purchase_rate||0)-parseFloat(rateFilter))<0.01;
          return(
            <div key={v.product_id} onClick={()=>onPick(v)}
              style={{
                display:'flex', justifyContent:'space-between', alignItems:'center',
                gap:8, padding:'8px 12px', cursor:'pointer',
                background: isSelected?'#eef2ff': rateMatches?'#f0fdf4':'#fff',
                borderBottom:'1px solid #f3f4f6',
                borderLeft: isSelected?'3px solid #6366f1': rateMatches?'3px solid #34d399':'3px solid transparent',
                transition:'background .08s',
              }}
            >
              {/* Left: name + meta (matches product dropdown layout) */}
              <div style={{minWidth:0,flex:1}}>
                <div style={{fontWeight:600,fontSize:13,color:'#111827',whiteSpace:'nowrap',overflow:'hidden',textOverflow:'ellipsis'}}>
                  {v.product_name}
                </div>
                <div style={{fontSize:10,color:'#6b7280',marginTop:2}}>
                  {[
                    v.barcode&&<span key="bc" style={{fontFamily:'monospace',background:'#eef2ff',color:'#4f46e5',borderRadius:3,padding:'0 4px',fontSize:10,fontWeight:600}}>{v.barcode}</span>,
                    v.article_number&&`Art# ${v.article_number}`,
                    v.size_value&&`Size ${v.size_value}`,
                    v.quantity_per_box>1&&`P/Box ${v.quantity_per_box}`,
                  ].filter(Boolean).reduce((acc,el,i)=>i===0?[el]:[...acc,' · ',el],[])}
                </div>
              </div>
              {/* Right: rates + stock (matches product dropdown right column) */}
              <div style={{display:'flex',flexDirection:'column',alignItems:'flex-end',gap:2,flexShrink:0}}>
                <div style={{display:'flex',gap:8,alignItems:'center'}}>
                  <span style={{fontSize:12,fontWeight:700,color:'#059669'}}>Buy ₹{parseFloat(v.purchase_rate||0).toFixed(2)}</span>
                  <span style={{fontSize:12,fontWeight:700,color:'#7c3aed'}}>Sell ₹{parseFloat(v.sale_rate||0).toFixed(2)}</span>
                  <span style={{fontSize:11,color:'#b45309',fontWeight:600}}>{parseFloat(v.margin_percentage||0).toFixed(1)}%</span>
                </div>
                <span style={{color:stockColor,fontSize:10,fontWeight:600}}>{stock<=0?'Out of stock':`Stock: ${stock}`}</span>
              </div>
            </div>
          );
        })}
      </div>

      {/* Footer */}
      <div style={{
        display:'flex', justifyContent:'space-between', alignItems:'center',
        padding:'6px 12px',
        background:'#f8fafc',
        borderTop:'1px solid #e0e7ff',
        flexShrink:0,
      }}>
        <span style={{fontSize:10,color:'#9ca3af'}}>Click or use keyboard · Enter to pick · Esc to use new rates</span>
        <button
          onMouseDown={e=>e.preventDefault()}
          onClick={onDismiss}
          style={{
            background:'linear-gradient(135deg,#4f46e5,#818cf8)',
            border:'none', borderRadius:5,
            color:'#fff', fontSize:10, fontWeight:700,
            cursor:'pointer', padding:'3px 10px',
            boxShadow:'0 2px 6px rgba(99,102,241,.3)',
          }}
        >Use new rates →</button>
      </div>
    </div>
  );
}

export default function PurchaseBillForm() {
  const navigate = useNavigate();
  const { id }   = useParams();
  const isEdit   = Boolean(id);

  const [form]            = Form.useForm();
  const [items, setItems] = useState([]);
  const [parties, setParties]       = useState([]);
  const [categories, setCategories] = useState([]);
  const [loading, setLoading]       = useState(false);
  const [pageLoading, setPageLoading] = useState(false);
  const [entry, setEntry]           = useState(EMPTY_ENTRY);
  const [prodRawList, setProdRawList]           = useState([]);  // flat list from API
  const [productSearching, setProductSearching] = useState(false);
  const [activeCatId, setActiveCatId]           = useState(null); // drives category product loading
  const [lookupLoading, setLookupLoading]       = useState(false);
  const [variantOptions, setVariantOptions]     = useState([]);
  const [showVariantPicker, setShowVariantPicker] = useState(false);
  const [variantPickerIdx, setVariantPickerIdx]   = useState(-1);
  const [pickerPos, setPickerPos]               = useState({top:0,left:0});
  const [pickerRateFilter, setPickerRateFilter] = useState(null); // state so picker re-renders on rate change
  const variantOptionsRef                        = useRef([]);   // stable ref for global handler
  const variantPickerIdxRef                      = useRef(-1);   // stable ref for global handler
  const prodWrapRef                             = useRef(null);
  const articleWrapRef                          = useRef(null);
  const rateWrapRef                             = useRef(null);  // anchor for rate-triggered picker
  const pickerAnchorRef                         = useRef('article'); // 'article' | 'rate'
  const pickerRateFilterRef                     = useRef(null);  // rate being typed (for row highlight)
  const articleSearchTimerRef                   = useRef(null);
  const rateSearchTimerRef                      = useRef(null);
  const entryRef                                = useRef(entry);          // live mirror — avoids nested setEntry
  const showVariantPickerRef                    = useRef(false);          // guard for lookupProduct
  const liveSearchIdRef                         = useRef(0);              // stale-response detection
  const justSelectedRef                         = useRef(false);          // redirect focus to size after product selection
  const searchTimerRef                          = useRef(null);           // debounce timer for product text search
  const searchReqRef                            = useRef(0);              // stale-response guard for text search
  const [barcodeError, setBarcodeError]         = useState('');
  const [printModal, setPrintModal] = useState({ visible:false, bill:null });
  const [companyName, setCompanyName] = useState('');
  const [billNumber, setBillNumber]   = useState('');
  const [gstMode] = useState(()=>localStorage.getItem('gst_mode')||'product');
  const [cgstPct, setCgstPct] = useState(0);
  const [sgstPct, setSgstPct] = useState(0);
  const [igstPct, setIgstPct] = useState(0);

  const tableWrapRef = useRef(null);
  const [tblHeight, setTblHeight] = useState(300);
  const barcodeRef  = useRef(null);
  const productRef  = useRef(null);
  const sizeRef     = useRef(null);
  const articleRef  = useRef(null);
  const rateRef     = useRef(null);
  const qtyRef      = useRef(null);
  const qpbRef      = useRef(null);
  const marginRef   = useRef(null);
  const saleRateRef = useRef(null);
  const gstRef      = useRef(null);
  const entryRefs   = [productRef,sizeRef,articleRef,rateRef,qtyRef,qpbRef,marginRef,saleRateRef,gstRef];

  useLayoutEffect(()=>{
    const el = tableWrapRef.current;
    if(!el) return;
    setTblHeight(Math.max(100, el.clientHeight - 40));
    const ro = new ResizeObserver(([e])=>setTblHeight(Math.max(100, e.contentRect.height - 40)));
    ro.observe(el);
    return ()=>ro.disconnect();
  },[]);

  // Load products when category changes — clean cancellation pattern
  useEffect(()=>{
    if(!activeCatId){ setProdRawList([]); return; }
    let cancelled=false;
    productAPI.search('',{category_id:activeCatId,name_only:'true'})
      .then(({data})=>{
        if(cancelled) return;
        setProdRawList(data.data||[]);
        setTimeout(()=>{ const inp=prodWrapRef.current?.querySelector('input'); inp?.focus(); },30);
      })
      .catch(()=>{ if(!cancelled) setProdRawList([]); });
    return ()=>{ cancelled=true; };
  },[activeCatId]);

  useEffect(() => {
    loadParties(); loadCategories();
    settingsAPI.getSystem().then(({data})=>setCompanyName(data?.data?.company_name||'')).catch(()=>{});
    if (isEdit) loadBill(id);
    else { form.setFieldsValue({bill_date:dayjs()}); setTimeout(()=>barcodeRef.current?.focus(),100); }
  }, [id]);

  const loadParties    = async()=>{ try{ const{data}=await partyAPI.getSuppliers({limit:1000}); setParties((data.data||[]).filter(p=>p.is_active!==false)); }catch(e){} };
  const loadCategories = async()=>{ try{ const{data}=await categoryAPI.getAllFlat(); setCategories(data||[]); }catch(e){} };

  const loadBill = async(billId)=>{
    setPageLoading(true);
    try{
      const{data}=await purchaseAPI.getById(billId);
      setBillNumber(data.bill_number||'');
      form.setFieldsValue({
        supplier_id:data.supplier_id,
        bill_date:data.bill_date?dayjs(data.bill_date):dayjs(),
        supplier_bill_number:data.supplier_bill_number||'',
        due_date:data.due_date?dayjs(data.due_date):null,
        transport_name:data.transport_name||'',
        vehicle_number:data.vehicle_number||'',
        lr_number:data.lr_number||'',
        discount_percentage:parseFloat(data.discount_percentage)||0,
        other_charges:parseFloat(data.other_charges)||0,
        freight_charges:parseFloat(data.freight_charges)||0,
        paid_amount:parseFloat(data.paid_amount)||0,
      });
      setCgstPct(parseFloat(data.cgst_pct)||0);
      setSgstPct(parseFloat(data.sgst_pct)||0);
      setIgstPct(parseFloat(data.igst_pct)||0);
      setDiscAmtVal(parseFloat(data.discount_amount)||0);
      setItems((data.items||[]).map((it,idx)=>({
        key:it.purchase_bill_item_id||idx,
        purchase_bill_item_id:it.purchase_bill_item_id,
        product_id:it.product_id, barcode:it.barcode||'',
        category_id:it.category_id, category_name:it.category_name||'',
        product_name:it.product_name||'', size:it.size||'',
        article_number:it.article_number||'',
        purchase_rate:parseFloat(it.purchase_rate)||0,
        quantity:parseFloat(it.quantity)||0,
        quantity_per_box:parseInt(it.quantity_per_box)||1,
        margin_percentage:parseFloat(it.margin_percentage)||0,
        sale_rate:parseFloat(it.sale_rate)||0,
        mrp:parseFloat(it.mrp)||0,
        hsn_code:it.hsn_code||'',
        gst_rate:parseFloat(it.gst_rate)||0,
      })));
    }catch(e){ message.error('Failed to load bill'); navigate('/purchases'); }
    finally{ setPageLoading(false); }
  };

  const updateItem=(key,field,value)=>{
    setItems(prev=>prev.map(item=>{
      if(item.key!==key) return item;
      const u={...item,[field]:value};
      if(field==='purchase_rate'||field==='margin_percentage'){
        const pr=field==='purchase_rate'?value:item.purchase_rate;
        const mg=field==='margin_percentage'?value:item.margin_percentage;
        u.sale_rate=Math.ceil(pr*(1+mg/100));
      }
      if(field==='sale_rate'&&item.purchase_rate>0)
        u.margin_percentage=+(((value-item.purchase_rate)/item.purchase_rate)*100).toFixed(2);
      return u;
    }));
  };
  const navTable=(e,ri,ci)=>{
    if(e.key!=='ArrowUp'&&e.key!=='ArrowDown') return;
    e.preventDefault();
    const nr=e.key==='ArrowDown'?Math.min(ri+1,items.length-1):Math.max(ri-1,0);
    if(nr===ri) return;
    const cell=document.getElementById(`tc-${nr}-${ci}`);
    if(cell){const inp=cell.querySelector('input');inp?.focus();inp?.select?.();}
  };
  const validateItemBarcode=async(key,barcode)=>{
    if(!barcode) return;
    const item=items.find(i=>i.key===key);
    try{ const{data}=await productAPI.getByBarcode(barcode);
      if(data.product_id&&data.product_id!==item?.product_id){ message.error(`Barcode "${barcode}" already used`); updateItem(key,'barcode',''); }
    }catch(e){}
  };

  const handleBarcodeScan=async(barcode)=>{
    if(!barcode) return;
    try{
      const{data}=await productAPI.getByBarcode(barcode);
      setEntry(p=>({...p,barcode:data.barcode,product_id:data.product_id,
        category_id:data.category_id,category_name:data.Category?.category_name||'',
        product_name:data.product_name,size:data.size_value||'',article_number:data.article_number||'',
        purchase_rate:parseFloat(data.purchase_rate)||0,sale_rate:parseFloat(data.sale_rate)||0,
        mrp:parseFloat(data.mrp)||0,margin_percentage:parseFloat(data.margin_percentage)||0,
        hsn_code:data.hsn_code||'',gst_rate:parseFloat(data.gst_rate)||0,
        quantity_per_box:parseInt(data.quantity_per_box)||1,quantity:1,
      }));
      setBarcodeError('');
      setVariantOptions([]); setShowVariantPicker(false); setVariantPickerIdx(-1);
      setTimeout(()=>qtyRef.current?.focus(),50);
    }catch(e){
      setEntry(p=>({...p,barcode,product_id:null})); setBarcodeError('');
      setVariantOptions([]); setShowVariantPicker(false); setVariantPickerIdx(-1);
      setTimeout(()=>productRef.current?.focus(),50);
    }
  };
  const handleBarcodeBlur=async(barcode)=>{
    if(!barcode||entry.product_id){setBarcodeError('');return;}
    try{ const{data}=await productAPI.getByBarcode(barcode);
      if(data.product_id&&data.product_id!==entry.product_id){ setBarcodeError(`Used by "${data.product_name}"`); setEntry(p=>({...p,barcode:''})); }
      else setBarcodeError('');
    }catch(e){ setBarcodeError(''); }
  };
  // Deduplicate by product_name, aggregate stock across variants
  const dedupedProducts=useMemo(()=>{
    const map=new Map();
    prodRawList.forEach(p=>{
      const key=(p.product_name||'').toLowerCase().trim();
      if(!map.has(key)){
        map.set(key,{...p, _totalStock:parseFloat(p.current_stock||0)});
      } else {
        map.get(key)._totalStock+=parseFloat(p.current_stock||0);
      }
    });
    return [...map.values()];
  },[prodRawList]);

  const handleProductSearch=useCallback((value)=>{
    if(searchTimerRef.current) clearTimeout(searchTimerRef.current);
    if(!value){ if(!activeCatId) setProdRawList([]); return; }
    searchTimerRef.current=setTimeout(async()=>{
      const reqId=++searchReqRef.current;
      setProductSearching(true);
      try{
        const{data}=await productAPI.search(value,{name_only:'true',...(activeCatId?{category_id:activeCatId}:{})});
        if(reqId!==searchReqRef.current) return;
        setProdRawList(data.data||[]);
      }catch(e){ if(reqId===searchReqRef.current) setProdRawList([]); }
      finally{ if(reqId===searchReqRef.current) setProductSearching(false); }
    },150);
  },[activeCatId]);
  const handleProductSelect=(value,option)=>{
    if(!option?.product) return;
    const p=option.product;
    // Only set name + category — do NOT fill other fields.
    // Match lookup (by category+name+size+article) will run after article# is entered.
    setEntry(prev=>({...prev,
      product_name:p.product_name,
      category_id:p.category_id||prev.category_id,
      category_name:p.Category?.category_name||prev.category_name,
      // reset identity + rate fields so user enters fresh
      product_id:null, barcode:'',
      size:'', article_number:'',
      purchase_rate:0, sale_rate:0, mrp:0, margin_percentage:0,
      hsn_code:'', gst_rate:0, quantity_per_box:1,
    }));
    setBarcodeError('');
    // Redirect focus to Size field — blur Select first so AntD can't steal focus back
    justSelectedRef.current=true;
    requestAnimationFrame(()=>{ productRef.current?.blur(); sizeRef.current?.focus(); sizeRef.current?.select?.(); });
  };

  // Match existing product by category + name + size + article + purchase_rate + quantity_per_box + sale_rate.
  // If ALL match → use existing barcode (same product variant, same pricing).
  // If any differ → product_id=null, barcode='' → backend creates new barcode on save.
  const lookupProduct=useCallback(async(snap)=>{
    if(!snap.product_name) return;
    // Need at least rate or p/box or sale_rate to have been entered for a full match check;
    // if none entered yet, just do a name/size/article identity check so we can pre-fill hints.
    setLookupLoading(true);
    try{
      const{data}=await productAPI.search(snap.product_name,{category_id:snap.category_id,limit:200});
      const list=data.data||[];
      const norm=s=>(s||'').toLowerCase().trim();
      const numEq=(a,b)=>{ // compare numbers, treat 0/null/undefined as same
        const fa=parseFloat(a)||0, fb=parseFloat(b)||0;
        return Math.abs(fa-fb)<0.001;
      };

      // Identity match: category + name + size + article (determines same product variant)
      const identityMatch=list.find(p=>
        norm(p.product_name)===norm(snap.product_name)&&
        norm(p.size_value)===norm(snap.size)&&
        norm(p.article_number)===norm(snap.article_number)&&
        p.category_id===snap.category_id
      );

      if(!identityMatch){
        // Completely new product variant → new barcode on save
        setEntry(prev=>({...prev,product_id:null,barcode:''}));
        return;
      }

      // Identity matched — now check pricing fields.
      // Only compare a field if the user has actually entered a value for it (>0).
      const rateEntered  = (snap.purchase_rate||0)>0;
      const qpbEntered   = (snap.quantity_per_box||0)>1;
      const saleEntered  = (snap.sale_rate||0)>0;

      const rateMatch    = !rateEntered  || numEq(snap.purchase_rate, identityMatch.purchase_rate);
      const qpbMatch     = !qpbEntered   || numEq(snap.quantity_per_box, identityMatch.quantity_per_box);
      const saleMatch    = !saleEntered  || numEq(snap.sale_rate, identityMatch.sale_rate);

      if(rateMatch&&qpbMatch&&saleMatch){
        // Full match → existing product, use its barcode
        setEntry(prev=>({...prev,
          product_id:identityMatch.product_id,
          barcode:identityMatch.barcode,
          // Pre-fill rate hints only if user hasn't entered them yet
          purchase_rate:rateEntered?prev.purchase_rate:parseFloat(identityMatch.purchase_rate)||0,
          sale_rate:saleEntered?prev.sale_rate:parseFloat(identityMatch.sale_rate)||0,
          mrp:prev.mrp||parseFloat(identityMatch.mrp)||0,
          margin_percentage:prev.margin_percentage||parseFloat(identityMatch.margin_percentage)||0,
          hsn_code:prev.hsn_code||identityMatch.hsn_code||'',
          gst_rate:prev.gst_rate||parseFloat(identityMatch.gst_rate)||0,
          quantity_per_box:qpbEntered?prev.quantity_per_box:parseInt(identityMatch.quantity_per_box)||1,
        }));
      } else {
        // Same name/size/article but different rate or p/box → new barcode variant
        setEntry(prev=>({...prev,product_id:null,barcode:''}));
      }
    }catch(e){
      setEntry(prev=>({...prev,product_id:null,barcode:''}));
    }finally{ setLookupLoading(false); }
  },[]);

  /* ── Variant picker handlers ─────────────────────────────────────────── */
  const handleVariantPick=useCallback((variant)=>{
    setEntry(prev=>({...prev,
      product_id:variant.product_id,
      barcode:variant.barcode,
      purchase_rate:parseFloat(variant.purchase_rate)||0,
      quantity_per_box:parseInt(variant.quantity_per_box)||1,
      sale_rate:parseFloat(variant.sale_rate)||0,
      mrp:parseFloat(variant.mrp)||0,
      margin_percentage:parseFloat(variant.margin_percentage)||0,
      hsn_code:variant.hsn_code||'',
      gst_rate:parseFloat(variant.gst_rate)||0,
    }));
    setVariantOptions([]); setShowVariantPicker(false); setVariantPickerIdx(-1);
    setTimeout(()=>{ qtyRef.current?.focus(); qtyRef.current?.select?.(); },50);
  },[]);

  const handleVariantPickerDismiss=useCallback(()=>{
    setShowVariantPicker(false); setVariantOptions([]); setVariantPickerIdx(-1);
    setTimeout(()=>{ rateRef.current?.focus(); rateRef.current?.select?.(); },30);
  },[]);

  const handleVariantPickerKeyDown=useCallback((e)=>{
    if(e.key==='ArrowDown'){ e.preventDefault(); setVariantPickerIdx(i=>Math.min(i+1,variantOptions.length-1)); }
    else if(e.key==='ArrowUp'){ e.preventDefault(); setVariantPickerIdx(i=>Math.max(i-1,0)); }
    else if(e.key==='Enter'){ e.preventDefault(); if(variantPickerIdx>=0) handleVariantPick(variantOptions[variantPickerIdx]); else handleVariantPickerDismiss(); }
    else if(e.key==='Escape'||e.key==='Tab'){ e.preventDefault(); handleVariantPickerDismiss(); }
  },[variantOptions,variantPickerIdx,handleVariantPick,handleVariantPickerDismiss]);

  const updateEntry=(field,value)=>{
    setEntry(prev=>{
      const u={...prev,[field]:value};
      if(field==='purchase_rate'||field==='margin_percentage'){
        const pr=field==='purchase_rate'?value:prev.purchase_rate;
        const mg=field==='margin_percentage'?value:prev.margin_percentage;
        u.sale_rate=Math.ceil(pr*(1+mg/100));
      }
      if(field==='sale_rate'&&prev.purchase_rate>0)
        u.margin_percentage=+(((value-prev.purchase_rate)/prev.purchase_rate)*100).toFixed(2);
      return u;
    });
  };
  // Indices that trigger a silent lookup on leave: 3=Rate, 5=P/Box, 7=Sale Rate
  // Art# (idx=2) is handled by handleArticleBlur (variant picker) instead
  const LOOKUP_IDXS=new Set([3,5,7]);

  const handleEntryKey=(e,idx)=>{
    // Variant picker open: global handler already covers this, but keep local guard too
    if(idx===2&&showVariantPicker){ handleVariantPickerKeyDown(e); return; }

    // Art# (idx=2) — on Tab/Enter/ArrowDown: prevent default so focus stays here,
    // run async family search, show picker if variants exist, else advance to Rate
    if(idx===2&&!showVariantPicker&&(e.key==='Enter'||e.key==='Tab'||e.key==='ArrowDown')){
      e.preventDefault();
      setEntry(snap=>{
        if(!snap.product_name){
          setTimeout(()=>{ rateRef.current?.focus(); rateRef.current?.select?.(); },0);
          return snap;
        }
        (async()=>{
          setLookupLoading(true);
          try{
            const{data}=await productAPI.search(snap.product_name,{category_id:snap.category_id,limit:200});
            const list=data.data||[];
            const norm=s=>(s||'').toLowerCase().trim();
            const family=list.filter(p=>
              norm(p.product_name)===norm(snap.product_name)&&
              norm(p.size_value)===norm(snap.size)&&
              norm(p.article_number)===norm(snap.article_number)
            );
            if(family.length>0){
              setVariantOptions(family);
              setShowVariantPicker(true); // focus stays on Art# — global handler nav works
            } else {
              setVariantOptions([]); setShowVariantPicker(false);
              setEntry(prev=>({...prev,product_id:null,barcode:''}));
              setTimeout(()=>{ rateRef.current?.focus(); rateRef.current?.select?.(); },0);
            }
          }catch(ex){
            setEntry(prev=>({...prev,product_id:null,barcode:''}));
            setTimeout(()=>{ rateRef.current?.focus(); rateRef.current?.select?.(); },0);
          }finally{ setLookupLoading(false); }
        })();
        return snap;
      });
      return;
    }


    // Number fields (idx≥3): ArrowDown/Up should change the value natively, not jump fields
    const isNum = idx >= 3;
    if(e.key==='Enter'||e.key==='Tab'||(e.key==='ArrowDown'&&!isNum)){
      e.preventDefault();
      if(LOOKUP_IDXS.has(idx)&&!showVariantPickerRef.current){
        setEntry(snap=>{ lookupProduct(snap); return snap; });
      }
      if(idx>=entryRefs.length-1) addItem();
      else{const n=entryRefs[idx+1];if(n?.current){n.current.focus();n.current.select?.();}}
    }else if(e.key==='ArrowUp'&&!isNum){
      e.preventDefault();
      if(idx>0){const p=entryRefs[idx-1];if(p?.current){p.current.focus();p.current.select?.();}}
      else barcodeRef.current?.focus();
    }
  };

  // On Art# blur: fetch all variants with same name+size+article → show picker
  // If no variants found → mark as new barcode
  const handleArticleBlur=useCallback(()=>{
    setEntry(snap=>{
      if(!snap.product_name){ return snap; }
      (async()=>{
        setLookupLoading(true);
        try{
          const{data}=await productAPI.search(snap.product_name,{category_id:snap.category_id,limit:200});
          const list=data.data||[];
          const norm=s=>(s||'').toLowerCase().trim();
          // Family = same name + size + article (all pricing variants)
          const family=list.filter(p=>
            norm(p.product_name)===norm(snap.product_name)&&
            norm(p.size_value)===norm(snap.size)&&
            norm(p.article_number)===norm(snap.article_number)
          );
          if(family.length>0){
            setVariantOptions(family);
            setShowVariantPicker(true);
          } else {
            setVariantOptions([]); setShowVariantPicker(false);
            setEntry(prev=>({...prev,product_id:null,barcode:''}));
          }
        }catch(e){
          setEntry(prev=>({...prev,product_id:null,barcode:''}));
        }finally{ setLookupLoading(false); }
      })();
      return snap;
    });
  },[]);

  const handleRateBlur=useCallback(()=>{
    // Don't run silent lookup while variant picker is open — it would auto-fill fields
    if(showVariantPickerRef.current) return;
    setEntry(snap=>{ lookupProduct(snap); return snap; });
  },[lookupProduct]);

  // Live search helper shared by article and rate change handlers.
  // Reads directly from entryRef (no nested setEntry anti-pattern).
  // Uses liveSearchIdRef to discard stale responses from earlier debounce calls.
  const runLiveVariantSearch=(artValue, matchArticle)=>{
    const id = ++liveSearchIdRef.current;
    const snap = entryRef.current;
    if(!snap.product_name) return;
    (async()=>{
      setLookupLoading(true);
      try{
        const{data}=await productAPI.search(snap.product_name,{category_id:snap.category_id,limit:200});
        // Discard response if a newer search has already been issued
        if(id!==liveSearchIdRef.current) return;
        const list=data.data||[];
        const norm=s=>(s||'').toLowerCase().trim();
        const artNorm=norm(artValue);
        const family=list.filter(p=>
          norm(p.product_name)===norm(snap.product_name)&&
          norm(p.size_value)===norm(snap.size)&&
          (!matchArticle||!artNorm||norm(p.article_number).includes(artNorm))
        );
        if(family.length>0){ setVariantOptions(family); setShowVariantPicker(true); }
        else{ setVariantOptions([]); setShowVariantPicker(false); }
      }catch(e){
        if(id===liveSearchIdRef.current){ setVariantOptions([]); setShowVariantPicker(false); }
      }finally{
        if(id===liveSearchIdRef.current) setLookupLoading(false);
      }
    })();
  };

  // Art# onChange — update entry + debounced live variant search
  const handleArticleChange=(value)=>{
    updateEntry('article_number',value);
    pickerAnchorRef.current='article';
    pickerRateFilterRef.current=null;
    setPickerRateFilter(null);
    clearTimeout(articleSearchTimerRef.current);
    articleSearchTimerRef.current=setTimeout(()=>runLiveVariantSearch(value,true),300);
  };

  // Rate onChange — update entry + update picker highlight live (no open/close from typing)
  const handleRateInputChange=(value)=>{
    updateEntry('purchase_rate',value||0);
    pickerRateFilterRef.current=value||null;
    setPickerRateFilter(value||null); // triggers picker re-render for live highlight
  };

  // Rate onFocus — if article is empty and product+size exist, open picker below rate box
  const handleRateFocus=useCallback(()=>{
    const snap=entryRef.current;
    if(!snap.product_name||snap.article_number) return; // only when article is blank
    if(showVariantPickerRef.current) return; // already open
    pickerAnchorRef.current='rate';
    pickerRateFilterRef.current=snap.purchase_rate||null;
    setPickerRateFilter(snap.purchase_rate||null);
    runLiveVariantSearch('',false);
  },[runLiveVariantSearch]);

  // Keep refs in sync so global keydown handler never captures stale values
  useEffect(()=>{ variantOptionsRef.current=variantOptions; },[variantOptions]);
  useEffect(()=>{ variantPickerIdxRef.current=variantPickerIdx; },[variantPickerIdx]);
  useEffect(()=>{ entryRef.current=entry; },[entry]);
  useEffect(()=>{ showVariantPickerRef.current=showVariantPicker; },[showVariantPicker]);
  const addItem=useCallback(()=>{
    if(barcodeError){message.error(barcodeError);return;}
    if(!entry.product_name){message.warning('Enter product name');return;}
    if(!entry.quantity||entry.quantity<=0){message.warning('Enter quantity');return;}
    if(!entry.purchase_rate||entry.purchase_rate<=0){message.warning('Enter purchase rate');return;}
    setItems(prev=>[...prev,{...entry,key:Date.now(),total_amount:+(entry.quantity*entry.purchase_rate).toFixed(2)}]);
    setEntry(EMPTY_ENTRY); setBarcodeError('');
    setVariantOptions([]); setShowVariantPicker(false); setVariantPickerIdx(-1);
    setActiveCatId(null); // triggers useEffect → clears prodRawList automatically
    setTimeout(()=>barcodeRef.current?.focus(),50);
  },[entry,barcodeError]);
  const removeItem=(key)=>setItems(prev=>prev.filter(i=>i.key!==key));

  /* totals */
  const discountPct  = Form.useWatch('discount_percentage',form)||0;
  const paidAmt      = Form.useWatch('paid_amount',form)||0;
  const otherChr     = Form.useWatch('other_charges',form)||0;
  const freightChr   = Form.useWatch('freight_charges',form)||0;
  const subTotal     = items.reduce((s,i)=>s+(i.quantity||0)*(i.purchase_rate||0),0);
  const discountAmt  = +(subTotal*discountPct/100).toFixed(2);
  const taxableTotal = +(subTotal-discountAmt).toFixed(2);
  const productGST   = +items.reduce((s,i)=>s+(i.quantity||0)*(i.purchase_rate||0)*((i.gst_rate||0)/100),0).toFixed(2);
  const effCgstPct   = gstMode==='bill' ? (cgstPct||0) : (taxableTotal>0 ? +(productGST/2/taxableTotal*100).toFixed(2) : 0);
  const effSgstPct   = gstMode==='bill' ? (sgstPct||0) : effCgstPct;
  const cgst         = gstMode==='bill' ? +(taxableTotal*(cgstPct||0)/100).toFixed(2) : +(productGST/2).toFixed(2);
  const sgst         = gstMode==='bill' ? +(taxableTotal*(sgstPct||0)/100).toFixed(2) : +(productGST/2).toFixed(2);
  const igstAmt      = +(taxableTotal*(igstPct||0)/100).toFixed(2);
  const totalGST     = +(cgst+sgst+igstAmt).toFixed(2);
  const rawTotal     = taxableTotal+totalGST+parseFloat(otherChr||0)+parseFloat(freightChr||0);
  const roundedTotal = Math.round(rawTotal);
  const roundOff     = +(roundedTotal-rawTotal).toFixed(2);
  const balance      = +(roundedTotal-paidAmt).toFixed(2);
  const boxQty       = items.reduce((s,i)=>s+(i.quantity||0)/(i.quantity_per_box||1),0);

  /* bidirectional disc amount state */
  const [discAmtVal, setDiscAmtVal]   = useState(0);
  const discAmtEditingRef             = useRef(false);
  useEffect(()=>{ if(!discAmtEditingRef.current) setDiscAmtVal(discountAmt||0); },[discountAmt]);

  // When picker opens: reset nav index + compute fixed position below the triggering field
  useEffect(()=>{
    if(!showVariantPicker) return;
    setVariantPickerIdx(-1);
    const anchorEl = pickerAnchorRef.current==='rate' ? rateWrapRef.current : articleWrapRef.current;
    if(anchorEl){
      const r=anchorEl.getBoundingClientRect();
      setPickerPos({top:r.bottom+4, left:r.left});
    }
  },[showVariantPicker]);

  // Global capture-phase keydown — intercepts ↑↓/Enter/Esc/Tab from ANY focused field
  // while the variant picker is visible, so focus position doesn't matter
  useEffect(()=>{
    if(!showVariantPicker) return;
    const handler=e=>{
      if(e.key==='ArrowDown'){
        e.preventDefault(); e.stopPropagation();
        setVariantPickerIdx(i=>Math.min(i+1, variantOptionsRef.current.length-1));
      } else if(e.key==='ArrowUp'){
        e.preventDefault(); e.stopPropagation();
        setVariantPickerIdx(i=>Math.max(i-1, 0));
      } else if(e.key==='Enter'){
        e.preventDefault(); e.stopPropagation();
        const idx=variantPickerIdxRef.current;
        if(idx>=0&&variantOptionsRef.current[idx]){
          handleVariantPick(variantOptionsRef.current[idx]);
        } else {
          handleVariantPickerDismiss(); // Enter with nothing selected → dismiss → go to Rate
        }
      } else if(e.key==='Escape'){
        handleVariantPickerDismiss();
      } else if(e.key==='Tab'){
        // Let Tab move focus naturally but close picker
        setShowVariantPicker(false); setVariantOptions([]); setVariantPickerIdx(-1);
      }
    };
    document.addEventListener('keydown', handler, true); // capture = fires before element handlers
    return ()=>document.removeEventListener('keydown', handler, true);
  },[showVariantPicker, handleVariantPick, handleVariantPickerDismiss]);

  // Close picker on click outside both Art# wrapper and the fixed picker overlay
  useEffect(()=>{
    if(!showVariantPicker) return;
    const handler=e=>{
      const inArt=articleWrapRef.current?.contains(e.target);
      const inRate=rateWrapRef.current?.contains(e.target);
      const inPicker=e.target.closest('[data-variant-picker]');
      if(!inArt&&!inRate&&!inPicker) setShowVariantPicker(false);
    };
    document.addEventListener('mousedown', handler);
    return ()=>document.removeEventListener('mousedown', handler);
  },[showVariantPicker]);

  const handleSave=useCallback(async(payFull=false)=>{
    try{
      const values=await form.validateFields();
      if(items.length===0){message.warning('Add at least one item');return;}
      setLoading(true);
      const billData={
        supplier_id:values.supplier_id,
        bill_date:values.bill_date.format('YYYY-MM-DD'),
        due_date:values.due_date?.format('YYYY-MM-DD'),
        supplier_bill_number:values.supplier_bill_number,
        transport_name:values.transport_name,
        vehicle_number:values.vehicle_number,
        lr_number:values.lr_number,
        discount_percentage:discountPct,discount_amount:discountAmt,
        other_charges:parseFloat(otherChr)||0,
        freight_charges:parseFloat(freightChr)||0,
        cgst_pct:parseFloat(cgstPct)||0,
        sgst_pct:parseFloat(sgstPct)||0,
        igst_pct:parseFloat(igstPct)||0,
        paid_amount:payFull?roundedTotal:(values.paid_amount||0),
        items:items.map(i=>({
          product_id:i.product_id,barcode:i.barcode,
          category_id:i.category_id,category_name:i.category_name,
          product_name:i.product_name,size:i.size,
          article_number:i.article_number,hsn_code:i.hsn_code,
          quantity:i.quantity,quantity_per_box:i.quantity_per_box||1,
          purchase_rate:i.purchase_rate,margin_percentage:i.margin_percentage,
          sale_rate:i.sale_rate,mrp:i.mrp,gst_rate:i.gst_rate,
        })),
      };
      const{data}=isEdit?await purchaseAPI.update(id,billData):await purchaseAPI.create(billData);
      message.success(`Bill ${data.bill_number} ${isEdit?'updated':'saved'}!`);
      const printItems=(data.items||[]).map(it=>({
        barcode:it.barcode,product_name:it.product_name,size:it.size,
        article_number:it.article_number,mrp:it.mrp,sale_rate:it.sale_rate,
        purchase_rate:it.purchase_rate,quantity:it.quantity,quantity_per_box:it.quantity_per_box||1,
      }));
      setPrintModal({visible:true,bill:{...data,printItems}});
    }catch(e){ message.error(e.response?.data?.error||'Failed to save'); }
    finally{ setLoading(false); }
  },[form,items,discountPct,discountAmt,otherChr,freightChr,roundedTotal,isEdit,id]);

  const handleReset=()=>{
    setItems([]); setEntry(EMPTY_ENTRY); setBarcodeError('');
    setVariantOptions([]); setShowVariantPicker(false); setVariantPickerIdx(-1);
    setActiveCatId(null);
    form.resetFields(['discount_percentage','paid_amount']);
    setTimeout(()=>barcodeRef.current?.focus(),50);
  };
  useCtrlEnterSubmit(()=>handleSave(true));

  /* ── Table columns ── */
  const numCell=(ri,ci,val,field,min,w)=>(
    <div id={`tc-${ri}-${ci}`}>
      <InputNumber keyboard={false} variant="borderless" value={val}
        onChange={v=>updateItem(items[ri]?.key,field,v??0)}
        onKeyDown={e=>navTable(e,ri,ci)} min={min??0}
        style={{width:w??'100%',fontSize:13,fontWeight:700,fontFamily:'inherit'}} size="small"/>
    </div>
  );
  const txtCell=(ri,ci,val,field,w)=>(
    <div id={`tc-${ri}-${ci}`}>
      <Input variant="borderless" value={val}
        onChange={e=>updateItem(items[ri]?.key,field,e.target.value)}
        onKeyDown={e=>navTable(e,ri,ci)}
        style={{width:w??'100%',fontSize:13,fontWeight:700,fontFamily:'inherit'}} size="small"/>
    </div>
  );
  const readCell=(v,style={})=>(
    <span style={{fontSize:13,color:'#1f2937',fontWeight:700,paddingLeft:4,...style}}>{v||'—'}</span>
  );

  const itemColumns=[
    { title:'#', width:34, align:'center', render:(_,__,i)=><span style={{color:'#94a3b8',fontSize:13,fontWeight:700}}>{i+1}</span> },
    { title:'Barcode', dataIndex:'barcode', width:120,
      render:(v,r,ri)=>(
        <div id={`tc-${ri}-0`}>
          <Input variant="borderless" value={v}
            onChange={e=>updateItem(r.key,'barcode',e.target.value)}
            onBlur={e=>validateItemBarcode(r.key,e.target.value)}
            onKeyDown={e=>navTable(e,ri,0)}
            style={{width:'100%',fontSize:13,fontWeight:700,fontFamily:'inherit'}} size="small" placeholder="—"/>
        </div>
      ),
    },
    { title:'Product Name', dataIndex:'product_name', width:170,
      render:(v,r,ri)=>(
        <div id={`tc-${ri}-1`}>
          <Input variant="borderless" value={v} onChange={e=>updateItem(r.key,'product_name',e.target.value)}
            onKeyDown={e=>navTable(e,ri,1)} style={{width:'100%',fontSize:13,fontWeight:700,fontFamily:'inherit'}} size="small"/>
        </div>
      ),
    },
    { title:'Size',  dataIndex:'size',             width:60,  render:(v,r,ri)=>txtCell(ri,2,v,'size',54) },
    { title:'Art#',  dataIndex:'article_number',   width:80,  render:(v,r,ri)=>txtCell(ri,3,v,'article_number',74) },
    { title:'Qty',   dataIndex:'quantity',          width:72,  align:'center', render:(v,r,ri)=>numCell(ri,4,v,'quantity',0,66) },
    { title:'P/Box', dataIndex:'quantity_per_box',  width:66,  align:'center', render:(v,r,ri)=>numCell(ri,5,v,'quantity_per_box',1,60) },
    { title:'Rate ₹',dataIndex:'purchase_rate',    width:96,  align:'right',  render:(v,r,ri)=>numCell(ri,6,v,'purchase_rate',0,90) },
    { title:'MG%',   dataIndex:'margin_percentage', width:66,  align:'right',  render:(v,r,ri)=>numCell(ri,7,v,'margin_percentage',null,60) },
    { title:'Sale ₹',dataIndex:'sale_rate',         width:96,  align:'right',  render:(v,r,ri)=>numCell(ri,8,v,'sale_rate',0,90) },
    { title:'MRP ₹', dataIndex:'mrp',               width:88,  align:'right',  render:(v,r,ri)=>numCell(ri,9,v,'mrp',0,82) },
    { title:'GST%',  dataIndex:'gst_rate',          width:60,  align:'right',  render:(v,r,ri)=>numCell(ri,10,v,'gst_rate',0,54) },
    { title:'Amount ₹', width:116, align:'right',
      render:(_,r)=><span style={{color:'#4f46e5',fontWeight:700,fontSize:13,fontFamily:'inherit',paddingRight:6}}>{fmtN((r.quantity||0)*(r.purchase_rate||0))}</span>,
    },
    { title:'', width:32, align:'center',
      render:(_,r)=><button onClick={()=>removeItem(r.key)} style={{background:'none',border:'none',cursor:'pointer',color:'#f87171',fontSize:16,padding:'2px 4px',borderRadius:4,lineHeight:1}}>×</button>,
    },
  ];

  /* ── input style helper for dark sections ── */
  const darkIn = { background:'rgba(255,255,255,0.08)', borderColor:'rgba(255,255,255,0.15)', color:'#e2e8f0' };

  return (
    <Form form={form} component={false}>
      <style>{`
        .pbf .ant-input, .pbf .ant-input-number, .pbf .ant-picker,
        .pbf .ant-select:not(.ant-select-customize-input) .ant-select-selector,
        .pbf .ant-input-affix-wrapper,
        .pbf .ant-autocomplete .ant-select-selector {
          background:rgba(255,255,255,0.14)!important;
          border:1px solid rgba(255,255,255,0.28)!important;
          border-radius:7px!important;
          box-shadow:inset 0 1px 3px rgba(0,0,0,0.25)!important;
        }
        .pbf .ant-input:focus, .pbf .ant-input:hover,
        .pbf .ant-picker:hover, .pbf .ant-picker-focused,
        .pbf .ant-select-focused .ant-select-selector,
        .pbf .ant-select:hover .ant-select-selector {
          border-color:rgba(129,140,248,0.7)!important;
          background:rgba(255,255,255,0.20)!important;
          box-shadow:0 0 0 2px rgba(99,102,241,0.18)!important;
        }
        .pbf .ant-input,
        .pbf .ant-input-number-input,
        .pbf .ant-picker-input>input,
        .pbf .ant-select-selection-item,
        .pbf .ant-select-selection-placeholder,
        .pbf .ant-autocomplete .ant-select-selection-search-input {
          color:#f1f5f9!important; font-size:13px!important; font-weight:600!important;
        }
        .pbf .ant-select-selection-placeholder { font-weight:400!important; color:rgba(255,255,255,0.35)!important; }
        .pbf .ant-input::placeholder, .pbf .ant-picker-input>input::placeholder { color:rgba(255,255,255,0.35)!important; font-weight:400!important; }
        .pbf .ant-select-arrow, .pbf .ant-picker-suffix, .pbf .ant-picker-separator { color:rgba(255,255,255,0.5)!important; }
        .pbf .ant-input-number-handler-wrap { background:rgba(255,255,255,0.06)!important; }
        .pbf .ant-select-clear { background:rgba(13,11,30,.95)!important; color:rgba(255,255,255,.5)!important; }
        .pbf .ant-autocomplete .ant-select-selector { height:32px!important; }
        .pbf .ant-autocomplete .ant-select-selection-search { display:flex!important; align-items:center!important; }
        .pbf .ant-autocomplete .ant-select-selection-search-input { height:30px!important; line-height:30px!important; }
        .pbf-tbl .ant-table-cell { border-inline-end:none!important; padding:3px 6px!important; border-bottom:1px solid #e0e7ff!important; }
        .pbf-tbl .ant-table-thead .ant-table-cell { padding:10px 8px!important; border-inline-end:1px solid rgba(255,255,255,0.15)!important; }
        .pbf-tbl .ant-table-tbody>tr:hover>td { background:#eef2ff!important; }
        .pbf-tbl .ant-table-summary>tr>td { border-inline-end:none!important; padding:7px 8px!important; background:#f5f3ff!important; }
        .pbf-tbl .ant-table-placeholder .ant-table-cell { border-bottom:none!important; }
        .pbf-tbl .ant-input-number-input,
        .pbf-tbl .ant-input { font-size:13px!important; font-weight:700!important; color:#1f2937!important; }
        .pbf-bot .ant-input-number, .pbf-bot .ant-input-number-input { background:rgba(255,255,255,0.08)!important; border-color:rgba(255,255,255,0.13)!important; color:#e2e8f0!important; }
        .pbf-btn { transition:filter .15s,transform .15s; }
        .pbf-btn:hover:not(:disabled) { filter:brightness(1.18); transform:translateY(-1px); }
        .pbf-btn:active:not(:disabled) { transform:translateY(0); filter:brightness(.95); }

        /* Financial panel white inputs */
        .pbf-fin-in.ant-input-number, .pbf-paid-in.ant-input-number {
          background:#fff!important; border:1px solid #c7d2fe!important;
          border-radius:6px!important; box-shadow:0 1px 3px rgba(0,0,0,.12)!important;
          height:32px!important; width:100%!important;
        }
        .pbf-fin-in .ant-input-number-input, .pbf-paid-in .ant-input-number-input {
          background:#fff!important; color:#1e1b4b!important; font-weight:700!important;
          font-size:13px!important; text-align:right!important; height:30px!important;
        }
        .pbf-fin-in .ant-input-number-input::placeholder,
        .pbf-paid-in .ant-input-number-input::placeholder { color:#9ca3af!important; font-weight:400!important; }
        .pbf-fin-in.ant-input-number-disabled { opacity:0.5; }
      `}</style>

      {/* ── OUTER SHELL — fixed height, no scroll ── */}
      <div style={{height:H,display:'flex',flexDirection:'column',overflow:'hidden',
        fontFamily:"'Inter','Segoe UI',system-ui,sans-serif",background:'#f8fafc'}}>

        {/* ══════ TOP ══════════════════════════════════════════════════════ */}
        <div className="pbf" style={{
          flexShrink:0, background:DARK,
          display:'flex', flexDirection:'column', gap:8,
          padding:'10px 20px 12px',
          borderBottom:'2px solid rgba(99,102,241,.35)',
          boxShadow:'0 4px 24px rgba(0,0,0,0.4)',
        }}>

          {/* Header */}
          <div style={{display:'flex',alignItems:'center',gap:10}}>
            <button className="pbf-btn" onClick={()=>navigate('/purchases')}
              style={{background:'rgba(255,255,255,.08)',border:'1px solid rgba(255,255,255,.12)',
                borderRadius:6,color:ACC,cursor:'pointer',padding:'3px 12px',fontSize:12,fontWeight:600}}>
              ← Back
            </button>
            {companyName&&<span style={{color:'rgba(255,255,255,.3)',fontSize:11}}>{companyName}</span>}
            <div style={{display:'flex',alignItems:'center',gap:7,background:'rgba(99,102,241,.15)',
              border:'1px solid rgba(99,102,241,.3)',borderRadius:20,padding:'3px 14px'}}>
              <span style={{width:6,height:6,borderRadius:'50%',background:ACC,display:'inline-block',boxShadow:`0 0 6px ${ACC}`}}/>
              <span style={{color:ACC,fontWeight:800,fontSize:12,letterSpacing:1.8,textTransform:'uppercase'}}>
                {isEdit?'Edit Purchase Bill':'Purchase Bill'}
              </span>
            </div>
            {billNumber&&<span style={{fontSize:11,background:'rgba(99,102,241,.18)',
              border:'1px solid rgba(99,102,241,.35)',color:'#c7d2fe',borderRadius:12,padding:'2px 10px'}}>{billNumber}</span>}
            <div style={{marginLeft:'auto'}}/>
          </div>

          {/* Supplier row */}
          <div style={{display:'flex',gap:8,alignItems:'flex-end'}}>
            {[
              { label:'Supplier *', node:<Form.Item name="supplier_id" noStyle rules={[{required:true,message:' '}]}><Select showSearch style={{width:240}} placeholder="Select supplier" optionFilterProp="children" dropdownStyle={{minWidth:280}}>{parties.map(p=><Select.Option key={p.party_id} value={p.party_id}>{p.party_name}</Select.Option>)}</Select></Form.Item> },
              { label:'Bill Date *', node:<Form.Item name="bill_date" noStyle rules={[{required:true,message:' '}]}><DatePicker style={{width:130}} format="DD-MM-YYYY"/></Form.Item> },
              { label:'Supp. Bill #', node:<Form.Item name="supplier_bill_number" noStyle><Input style={{width:110}} placeholder="Ref"/></Form.Item> },
              { label:'Due Date', node:<Form.Item name="due_date" noStyle><DatePicker style={{width:130}} format="DD-MM-YYYY"/></Form.Item> },
              { label:'Transport', node:<Form.Item name="transport_name" noStyle><Input style={{width:110}}/></Form.Item> },
              { label:'Vehicle No.', node:<Form.Item name="vehicle_number" noStyle><Input style={{width:110}}/></Form.Item> },
              { label:'LR No.', node:<Form.Item name="lr_number" noStyle><Input style={{width:90}}/></Form.Item> },
            ].map(({label,node})=>(
              <div key={label} style={{flexShrink:0}}>
                <div style={lbl}>{label}</div>{node}
              </div>
            ))}
          </div>

          {/* Entry row */}
          <div style={{display:'flex',gap:6,alignItems:'flex-end'}}>
            <div style={{flexShrink:0}}>
              <div style={lbl}>Barcode</div>
              <Input ref={barcodeRef} value={entry.barcode} placeholder="Scan…"
                onChange={e=>{setEntry(p=>({...p,barcode:e.target.value}));setBarcodeError('');}}
                onPressEnter={e=>handleBarcodeScan(e.target.value)}
                onBlur={e=>handleBarcodeBlur(e.target.value)}
                onKeyDown={e=>{if(e.key==='ArrowDown'){e.preventDefault();productRef.current?.focus();}}}
                style={{width:140,borderColor:barcodeError?'#f87171':undefined}}
                status={barcodeError?'error':undefined}/>
            </div>
            <div style={{flexShrink:0}}>
              <div style={lbl}>Category</div>
              <Select className="entry-dark-select" style={{width:200}} value={activeCatId}
                onChange={(v,opt)=>{
                  setActiveCatId(v||null); // useEffect fetches products + focuses field when ready
                  setEntry(p=>({...p,category_id:v||null,category_name:opt?.children||'',product_name:'',product_id:null}));
                }}
                placeholder="All Categories" showSearch
                filterOption={(input,opt)=>!input||opt.children.toLowerCase().includes(input.toLowerCase())}
                allowClear notFoundContent={null}>
                {categories.map(c=><Select.Option key={c.category_id} value={c.category_id}>{c.category_name}</Select.Option>)}
              </Select>
            </div>
            <div ref={prodWrapRef} style={{flexShrink:0}}>
              <div style={lbl}>Product Name</div>
              <Select key={activeCatId??'no-cat'} ref={productRef} className="entry-dark-select" style={{width:220}}
                showSearch filterOption={false} optionLabelProp="label"
                value={entry.product_name||undefined}
                onSearch={handleProductSearch}
                onSelect={(val,opt)=>handleProductSelect(val,opt)}
                onFocus={()=>{
                  if(justSelectedRef.current){
                    justSelectedRef.current=false;
                    requestAnimationFrame(()=>{ productRef.current?.blur(); sizeRef.current?.focus(); sizeRef.current?.select?.(); });
                  }
                }}
                onClear={()=>setEntry(p=>({...p,product_name:'',product_id:null}))}
                allowClear
                placeholder={activeCatId?'Search in category…':'Search all products…'}
                notFoundContent={productSearching?'Searching…':null}
                listHeight={320} dropdownMatchSelectWidth={460}
              >
                {dedupedProducts.map(p=>{
                  const stock=parseFloat(p._totalStock||p.current_stock||0);
                  const stockColor=stock<=0?'#ef4444':stock<=5?'#f59e0b':'#6b7280';
                  return(
                    <Select.Option key={p.product_id} value={p.product_name} label={p.product_name} product={p}>
                      <div style={{display:'flex',justifyContent:'space-between',alignItems:'center',gap:8,padding:'2px 0'}}>
                        <div style={{minWidth:0,flex:1}}>
                          <div style={{fontWeight:600,fontSize:13,color:'#111827',whiteSpace:'nowrap',overflow:'hidden',textOverflow:'ellipsis'}}>{p.product_name}</div>
                          <div style={{fontSize:10,color:'#6b7280',marginTop:1}}>
                            {[p.Category?.category_name,p.article_number&&`Art# ${p.article_number}`,p.size_value&&`Size ${p.size_value}`].filter(Boolean).join(' · ')}
                          </div>
                        </div>
                        <div style={{display:'flex',flexDirection:'column',alignItems:'flex-end',gap:2,flexShrink:0}}>
                          <span style={{color:stockColor,fontSize:10,fontWeight:600}}>{stock<=0?'Out of stock':`Stock: ${stock}`}</span>
                        </div>
                      </div>
                    </Select.Option>
                  );
                })}
              </Select>
            </div>
            {[
              {lbl2:'Size',    ref:sizeRef,    field:'size',             val:entry.size,                       w:70,  idx:1, t:'txt'},
              {lbl2:'Art #',   ref:articleRef, field:'article_number',   val:entry.article_number,             w:80,  idx:2, t:'txt', wrapRef:articleWrapRef,
               onChangeFn:e=>handleArticleChange(e.target.value)},
              {lbl2:'Rate ₹',  ref:rateRef,    field:'purchase_rate',    val:entry.purchase_rate||undefined,   w:100, idx:3, t:'num', min:0, onBlur:handleRateBlur,
               wrapRef:rateWrapRef, onChangeFn:v=>handleRateInputChange(v||0), onFocusFn:handleRateFocus},
              {lbl2:'Qty',     ref:qtyRef,     field:'quantity',         val:entry.quantity||undefined,        w:80,  idx:4, t:'num', min:0},
              {lbl2:'P/Box',   ref:qpbRef,     field:'quantity_per_box', val:entry.quantity_per_box,           w:70,  idx:5, t:'num', min:1, onBlur:handleRateBlur},
              {lbl2:'Margin%', ref:marginRef,  field:'margin_percentage',val:entry.margin_percentage||undefined,w:80, idx:6, t:'num'},
              {lbl2:'Sale ₹',  ref:saleRateRef,field:'sale_rate',        val:entry.sale_rate||undefined,       w:100, idx:7, t:'num', min:0, onBlur:handleRateBlur},
              {lbl2:'GST%',    ref:gstRef,     field:'gst_rate',         val:entry.gst_rate||undefined,        w:70,  idx:8, t:'num', min:0},
            ].map(({lbl2,ref,field,val,w,idx,t,min,onBlur,wrapRef,onChangeFn,onFocusFn})=>(
              <div key={field} ref={wrapRef||undefined} style={{flexShrink:0}}>
                <div style={lbl}>{lbl2}</div>
                {t==='txt'
                  ?<Input ref={ref} value={val} style={{width:w}} onChange={onChangeFn||(e=>updateEntry(field,e.target.value))} onKeyDown={e=>handleEntryKey(e,idx)} onBlur={onBlur}/>
                  :<InputNumber keyboard={false} ref={ref} value={val} style={{width:w}} min={min} onChange={onChangeFn||(v=>updateEntry(field,v||0))} onKeyDown={e=>handleEntryKey(e,idx)} onBlur={onBlur} onFocus={onFocusFn}/>
                }
              </div>
            ))}
            {/* Variant picker — position:fixed viewport-anchored, renders on top of everything */}
            {showVariantPicker&&variantOptions.length>0&&(
              <VariantPickerDropdown
                options={variantOptions}
                selectedIdx={variantPickerIdx}
                onPick={handleVariantPick}
                onDismiss={handleVariantPickerDismiss}
                top={pickerPos.top}
                left={pickerPos.left}
                rateFilter={pickerAnchorRef.current==='rate'?pickerRateFilter:null}
              />
            )}
            <div style={{flexShrink:0}}>
              <div style={{height:14}}/>
              <button className="pbf-btn" onClick={addItem}
                style={{background:`linear-gradient(135deg,${PRI},#818cf8)`,border:'none',color:'#fff',
                  borderRadius:7,padding:'6px 22px',fontSize:13,fontWeight:700,cursor:'pointer',height:32,
                  display:'flex',alignItems:'center',gap:6,boxShadow:`0 0 14px rgba(99,102,241,.55)`}}>
                ＋ ADD
              </button>
            </div>
            {lookupLoading&&entry.product_name&&
              <span style={{alignSelf:'flex-end',fontSize:9,color:'#93c5fd',background:'rgba(59,130,246,.12)',border:'1px solid rgba(59,130,246,.25)',borderRadius:10,padding:'2px 7px'}}>⏳ Checking…</span>}
            {!lookupLoading&&entry.product_id&&
              <span style={{alignSelf:'flex-end',fontSize:9,color:'#34d399',background:'rgba(16,185,129,.12)',border:'1px solid rgba(16,185,129,.25)',borderRadius:10,padding:'2px 7px'}}>✓ Existing</span>}
            {!lookupLoading&&!entry.product_id&&entry.product_name&&
              <span style={{alignSelf:'flex-end',fontSize:9,color:'#fbbf24',background:'rgba(251,191,36,.12)',border:'1px solid rgba(251,191,36,.25)',borderRadius:10,padding:'2px 7px'}}>＋ New Barcode</span>}
          </div>
        </div>

        {/* ══════ TABLE 65% ════════════════════════════════════════════════ */}
        <div ref={tableWrapRef} className="pbf-tbl" style={{flex:1,overflow:'hidden',minHeight:0,background:'#fff'}}>
          <Table columns={itemColumns} dataSource={items} rowKey="key"
            size="small" pagination={false} loading={pageLoading}
            scroll={items.length?{x:1240,y:tblHeight}:{y:tblHeight}}
            components={{header:{cell:(p)=>(
              <th {...p} style={{background:TH_BG,color:'#fff',fontWeight:700,fontSize:11,letterSpacing:.5,textTransform:'uppercase',
                padding:'9px 8px',border:'none',borderBottom:'2px solid #3730a3',
                whiteSpace:'nowrap'}}/>
            )}}}
            locale={{emptyText:(
              <div style={{padding:40,textAlign:'center',color:'#c4c4c4'}}>
                <div style={{fontSize:28,marginBottom:8}}>⚡</div>
                <div>Scan a barcode or search a product to add items</div>
              </div>
            )}}
          />
        </div>

        {/* ══════════════════════════════════════════════════════════════════
            BOTTOM — LEFT: stats + buttons    RIGHT: financials
            ═══════════════════════════════════════════════════════════════ */}
        <div className="pbf-bot" style={{
          height:'40%', minHeight:310,
          background:DARK, flexShrink:0,
          borderTop:'2px solid rgba(99,102,241,.3)',
          padding:'10px 20px',
          display:'flex', flexDirection:'row', gap:0,
          boxShadow:'0 -4px 20px rgba(0,0,0,.4)',
        }}>

          {/* ── LEFT PANEL — stats + buttons ── */}
          <div style={{
            flex:1, display:'flex', flexDirection:'column', justifyContent:'space-between',
            paddingRight:20, borderRight:'1px solid rgba(255,255,255,0.1)',
          }}>

            {/* Stat mini-cards */}
            <div style={{display:'flex',gap:8}}>
              {[
                {l:'ITEMS', v:items.length,        c:'rgba(129,140,248,0.9)'},
                {l:'QTY',   v:items.reduce((s,i)=>s+(i.quantity||0),0).toFixed(1), c:'rgba(96,165,250,0.9)'},
                {l:'BOX',   v:boxQty.toFixed(1),   c:'rgba(251,191,36,0.9)'},
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

            <div/>

            {/* Action buttons */}
            <div style={{display:'flex',gap:8}}>
              {[
                {label:'Back',        kbd:'ESC',bg:'#1e293b',                               onClick:()=>navigate('/purchases')},
                {label:'Reset',       kbd:'F5', bg:'#1e293b',                               onClick:handleReset},
                {label:'Save Credit', kbd:'F8', bg:'#1d4ed8',                               onClick:()=>handleSave(false), disabled:loading},
                {label:'Save & Pay',  kbd:'F1', bg:'linear-gradient(135deg,#059669,#10b981)',primary:true, onClick:()=>handleSave(true), disabled:loading},
              ].map(({label,kbd,bg,onClick,primary,disabled})=>(
                <button key={kbd} className="pbf-btn" onClick={onClick} disabled={disabled}
                  style={{background:bg, color:'#fff',
                    border:primary?'none':'1px solid rgba(255,255,255,.12)',
                    borderRadius:8, padding:'8px 18px', fontSize:13, fontWeight:700,
                    cursor:'pointer', display:'flex', alignItems:'center', gap:7,
                    opacity:disabled?.6:1,
                    boxShadow:primary?'0 0 16px rgba(16,185,129,.4)':'none',
                    whiteSpace:'nowrap'}}>
                  <span style={{background:'rgba(0,0,0,.3)',borderRadius:4,
                    padding:'2px 6px',fontSize:9,fontWeight:700,letterSpacing:.5}}>{kbd}</span>
                  {label}
                </button>
              ))}
            </div>
          </div>

          {/* ── RIGHT PANEL — exact same structure as SalesBillForm ── */}
          <div style={{
            width:520,
            paddingLeft:20,
            display:'flex', flexDirection:'row', gap:14,
            borderLeft:'1px solid rgba(255,255,255,.1)',
          }}>

            {/* ── Sub-left: financial rows ── */}
            <div style={{flex:1, display:'flex', flexDirection:'column', gap:6}}>

              {/* Sub Total */}
              <div style={{display:'flex',alignItems:'center',gap:10}}>
                <span style={FL}>Sub Total</span>
                <div style={VB}>{fmtN(subTotal)}</div>
              </div>

              {/* Bill Disc — % and ₹ bidirectional — RIGHT AFTER Sub Total */}
              <div style={{display:'flex',alignItems:'center',gap:10}}>
                <span style={FL}>Bill Disc</span>
                <div style={{flex:1,display:'flex',gap:6}}>
                  <Form.Item name="discount_percentage" noStyle>
                    <InputNumber keyboard={false} size="small" min={0} max={100} placeholder="%"
                      className="pbf-fin-in" style={{flex:1,width:'100%'}}
                      formatter={v=>v?`${v}%`:''} parser={v=>v?.replace('%','')||''}
                      onChange={pct=>{ discAmtEditingRef.current=false; setDiscAmtVal(+(subTotal*(pct||0)/100).toFixed(2)); }}/>
                  </Form.Item>
                  <InputNumber keyboard={false} size="small" min={0} placeholder="₹ amt"
                    className="pbf-fin-in" style={{flex:1,width:'100%'}}
                    value={discAmtVal||undefined}
                    onFocus={()=>{ discAmtEditingRef.current=true; }}
                    onBlur={()=>{ discAmtEditingRef.current=false; }}
                    onChange={amt=>{ discAmtEditingRef.current=true; setDiscAmtVal(amt||0); const pct=subTotal>0?+((amt||0)/subTotal*100).toFixed(4):0; form.setFieldValue('discount_percentage',+pct.toFixed(2)); }}/>
                </div>
              </div>

              {/* Other Chr. */}
              <div style={{display:'flex',alignItems:'center',gap:10}}>
                <span style={FL}>Other Chr.</span>
                <Form.Item name="other_charges" noStyle>
                  <InputNumber keyboard={false} size="small" min={0} placeholder="0.00"
                    className="pbf-fin-in" style={{flex:1,width:'100%'}}/>
                </Form.Item>
              </div>

              {/* Freight */}
              <div style={{display:'flex',alignItems:'center',gap:10}}>
                <span style={FL}>Freight Chr.</span>
                <Form.Item name="freight_charges" noStyle>
                  <InputNumber keyboard={false} size="small" min={0} placeholder="0.00"
                    className="pbf-fin-in" style={{flex:1,width:'100%'}}/>
                </Form.Item>
              </div>

              {/* Taxable */}
              <div style={{display:'flex',alignItems:'center',gap:10}}>
                <span style={FL}>Taxable</span>
                <div style={{...VB,color:'#312e81',fontWeight:800}}>{fmtN(taxableTotal)}</div>
              </div>

              {/* CGST */}
              <div style={{display:'flex',alignItems:'center',gap:10}}>
                <span style={FL}>CGST</span>
                <div style={{flex:1,display:'flex',gap:6}}>
                  <div style={{width:62,flexShrink:0}}>
                    <InputNumber keyboard={false} size="small" min={0} max={100}
                      className="pbf-fin-in" style={{width:'100%'}}
                      value={effCgstPct||undefined} disabled={gstMode==='product'}
                      onChange={v=>setCgstPct(v||0)}
                      formatter={v=>v?`${v}%`:''} parser={v=>v?.replace('%','')||''}
                      placeholder="%"/>
                  </div>
                  <div style={{...VB,flex:1}}>{fmtN(cgst)}</div>
                </div>
              </div>

              {/* SGST */}
              <div style={{display:'flex',alignItems:'center',gap:10}}>
                <span style={FL}>SGST</span>
                <div style={{flex:1,display:'flex',gap:6}}>
                  <div style={{width:62,flexShrink:0}}>
                    <InputNumber keyboard={false} size="small" min={0} max={100}
                      className="pbf-fin-in" style={{width:'100%'}}
                      value={effSgstPct||undefined} disabled={gstMode==='product'}
                      onChange={v=>setSgstPct(v||0)}
                      formatter={v=>v?`${v}%`:''} parser={v=>v?.replace('%','')||''}
                      placeholder="%"/>
                  </div>
                  <div style={{...VB,flex:1}}>{fmtN(sgst)}</div>
                </div>
              </div>

              {/* IGST */}
              <div style={{display:'flex',alignItems:'center',gap:10}}>
                <span style={FL}>IGST</span>
                <div style={{flex:1,display:'flex',gap:6}}>
                  <div style={{width:62,flexShrink:0}}>
                    <InputNumber keyboard={false} size="small" min={0} max={100}
                      className="pbf-fin-in" style={{width:'100%'}}
                      value={igstPct||undefined} disabled={gstMode==='product'}
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
                padding:'0 14px', fontSize:38, fontWeight:900, color:'#1e1b4b',
                letterSpacing:-2, border:'1px solid #c7d2fe',
                boxShadow:'0 2px 8px rgba(0,0,0,.15)', fontVariantNumeric:'tabular-nums',
              }}>
                {roundedTotal.toLocaleString('en-IN')}
              </div>

              {/* Amt Paid — capped at bill total (Fix: paid cannot exceed total) */}
              <div style={{display:'flex',alignItems:'center',gap:8}}>
                <span style={{color:'rgba(255,255,255,.85)',fontWeight:700,fontSize:12,width:56,flexShrink:0}}>Amt Paid</span>
                <Form.Item name="paid_amount" noStyle>
                  <InputNumber keyboard={false} size="small" min={0} max={roundedTotal} placeholder="0.00"
                    className="pbf-paid-in" style={{flex:1,width:'100%'}}/>
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
                  {fmtN(Math.abs(balance))}
                </span>
              </div>

            </div>
          </div>
        </div>
      </div>

      <BarcodePrintModal
        visible={printModal.visible}
        onClose={()=>{setPrintModal({visible:false,bill:null});navigate('/purchases');}}
        billNumber={printModal.bill?.bill_number}
        items={printModal.bill?.printItems||[]}
        initialCompany={companyName}
      />
    </Form>
  );
}
