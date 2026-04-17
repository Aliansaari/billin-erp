import React, { useState, useRef, useEffect, useLayoutEffect, useCallback, useMemo } from 'react';
import ReactDOM from 'react-dom';
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
/* Rendered via portal (document.body) so position:fixed always works regardless
   of ancestor overflow/transform/filter CSS.                                    */
function VariantPickerDropdown({ options, selectedIdx, onPick, top, left, rateFilter, articleFilter }) {
  // Scroll the selected row into view on arrow navigation
  const rowRefs = React.useRef([]);
  React.useEffect(()=>{
    if (selectedIdx >= 0 && rowRefs.current[selectedIdx]) {
      rowRefs.current[selectedIdx].scrollIntoView({ block:'nearest' });
    }
  }, [selectedIdx]);

  const hintText = articleFilter ? `art# ${articleFilter}`
                 : rateFilter!=null && rateFilter>0 ? `₹${parseFloat(rateFilter).toFixed(0)}`
                 : '';

  const content = (
    <div
      data-variant-picker="1"
      onMouseDown={e=>e.preventDefault()}
      style={{
        position:'fixed', top, left, zIndex:99999,
        background:'#ffffff',
        border:'1px solid #e2e8f0',
        borderRadius:8,
        boxShadow:'0 10px 30px rgba(15,23,42,.12), 0 2px 8px rgba(15,23,42,.06)',
        minWidth:548,
        maxWidth:620,
        maxHeight:340,
        overflow:'hidden',
        display:'flex',
        flexDirection:'column',
        fontFamily:'system-ui, -apple-system, "Segoe UI", Roboto, sans-serif',
        fontSize:13,
        color:'#0f172a',
      }}
    >
      {/* Header — flat, one line, readable; columns align with rows below */}
      <div style={{
        display:'grid',
        gridTemplateColumns:'72px 64px 72px 52px 56px 72px 72px',
        columnGap:10, alignItems:'center',
        padding:'7px 14px',
        background:'#f8fafc',
        borderBottom:'1px solid #e2e8f0',
        flexShrink:0,
        fontSize:10, fontWeight:700, letterSpacing:.6,
        color:'#64748b', textTransform:'uppercase',
      }}>
        <span>Art#</span>
        <span>Size</span>
        <span style={{textAlign:'right'}}>Rate ₹</span>
        <span style={{textAlign:'right'}}>P/Box</span>
        <span style={{textAlign:'right'}}>Margin</span>
        <span style={{textAlign:'right'}}>Sale ₹</span>
        <span style={{textAlign:'right'}}>Stock</span>
      </div>

      {/* Secondary header — match count + hint */}
      <div style={{
        display:'flex', alignItems:'center', justifyContent:'space-between',
        padding:'4px 14px',
        background:'#fafbff',
        borderBottom:'1px solid #eef2ff',
        flexShrink:0,
      }}>
        <span style={{fontSize:11, fontWeight:600, color:'#4f46e5'}}>
          {options.length} match{options.length!==1?'es':''}{hintText?` · ${hintText}`:''}
        </span>
        <span style={{fontSize:10, color:'#94a3b8', letterSpacing:.2}}>↓ select · ↵ pick · esc skip</span>
      </div>

      {/* Rows — columns line up with the form fields */}
      <div style={{overflowY:'auto', flex:1}}>
        {options.map((v,i)=>{
          const stock     = parseFloat(v.current_stock||0);
          const stockColor= stock<=0 ? '#ef4444' : stock<=5 ? '#f59e0b' : '#10b981';
          const stockBg   = stock<=0 ? '#fef2f2' : stock<=5 ? '#fffbeb' : '#f0fdf4';
          const isSel     = i===selectedIdx;
          const buy       = parseFloat(v.purchase_rate||0);
          const sell      = parseFloat(v.sale_rate||0);
          const margin    = parseFloat(v.margin_percentage||0);
          const qpb       = parseFloat(v.quantity_per_box||1)||1;
          return(
            <div key={v.product_id}
              ref={el => rowRefs.current[i] = el}
              onClick={()=>onPick(v)}
              style={{
                display:'grid',
                gridTemplateColumns:'72px 64px 72px 52px 56px 72px 72px',
                columnGap:10, alignItems:'center',
                padding:'8px 14px',
                cursor:'pointer',
                background: isSel ? '#eef2ff' : '#ffffff',
                borderLeft: isSel ? '3px solid #4f46e5' : '3px solid transparent',
                borderBottom:'1px solid #f1f5f9',
                fontVariantNumeric:'tabular-nums',
              }}
            >
              {/* Art# */}
              <span style={{
                fontWeight:600, fontSize:13, color:'#0f172a',
                whiteSpace:'nowrap', overflow:'hidden', textOverflow:'ellipsis',
              }}>{v.article_number || '—'}</span>

              {/* Size */}
              <span style={{fontSize:12, color:'#475569'}}>{v.size_value || '—'}</span>

              {/* Rate ₹ */}
              <span style={{fontSize:13, fontWeight:600, color:'#0f172a', textAlign:'right'}}>
                {buy.toFixed(0)}
              </span>

              {/* P/Box */}
              <span style={{fontSize:12, color:'#64748b', textAlign:'right'}}>{qpb}</span>

              {/* Margin% */}
              <span style={{
                fontSize:11, fontWeight:600, color:'#b45309',
                background:'#fef3c7', borderRadius:4, padding:'1px 6px',
                textAlign:'center', justifySelf:'end',
              }}>{margin.toFixed(1)}%</span>

              {/* Sale ₹ */}
              <span style={{fontSize:13, fontWeight:600, color:'#7c3aed', textAlign:'right'}}>
                {sell.toFixed(0)}
              </span>

              {/* Stock */}
              <span style={{
                display:'inline-flex', alignItems:'center', gap:4,
                fontSize:11, fontWeight:600, color:stockColor,
                background:stockBg, borderRadius:4, padding:'1px 6px',
                justifySelf:'end',
              }}>
                <span style={{width:6, height:6, borderRadius:'50%', background:stockColor}}/>
                {stock<=0 ? 'out' : stock}
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );

  // Portal → renders directly in document.body, escaping all ancestor CSS constraints
  return ReactDOM.createPortal(content, document.body);
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
  const [pickerRateFilter, setPickerRateFilter] = useState(null);    // for rate-highlight in picker
  const [pickerArticleFilter, setPickerArticleFilter] = useState(null); // for article-highlight in picker
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
  const skipNextLookupRef                       = useRef(false);          // set when user explicitly skips picker
  // Guard against double-submit from rapid Ctrl+Enter / double-click. Without
  // this a second keystroke during the save round-trip creates a duplicate
  // purchase bill (duplicate stock inflow, supplier double-charged).
  const submittingRef                           = useRef(false);
  // Monotonic key for item rows. `Date.now()` collides under fast barcode
  // scanners (two rows added in the same millisecond share a key, React
  // re-renders the wrong row). A counter guarantees uniqueness.
  const nextKeyRef                              = useRef(1);
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
    // Clear the post-selection redirect flag so it can't steal focus on this fresh load
    justSelectedRef.current=false;
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
      const loaded=(data.items||[]).map((it,idx)=>({
        key:it.purchase_bill_item_id||idx,
        purchase_bill_item_id:it.purchase_bill_item_id,
        product_id:it.product_id, barcode:it.barcode||'',
        category_id:it.category_id, category_name:it.category_name||'',
        product_name:it.product_name||'', size:it.size||'',
        article_number:it.article_number||'',
        purchase_rate:parseFloat(it.purchase_rate)||0,
        quantity:parseFloat(it.quantity)||0,
        // parseFloat (not parseInt) — boxes can be fractional (0.5 metre, 2.5 kg).
        quantity_per_box:parseFloat(it.quantity_per_box)||1,
        margin_percentage:parseFloat(it.margin_percentage)||0,
        sale_rate:parseFloat(it.sale_rate)||0,
        mrp:parseFloat(it.mrp)||0,
        hsn_code:it.hsn_code||'',
        gst_rate:parseFloat(it.gst_rate)||0,
      }));
      // Advance monotonic key counter above any loaded row so newly-added
      // items in edit mode can't collide with existing keys.
      const maxLoadedKey = loaded.reduce((m,it)=>Math.max(m, it.key||0), 0);
      nextKeyRef.current = maxLoadedKey + 1;
      setItems(loaded);
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
        quantity_per_box:parseFloat(data.quantity_per_box)||1,quantity:1,
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
    // Redirect focus to Size field — blur Select first so AntD can't steal focus back.
    // The ref is a short-lived guard against AntD's own focus-restore after option click;
    // auto-clear it after 250ms so later category changes don't accidentally trigger the
    // same "jump to Size" behaviour when the Product field is re-focused.
    justSelectedRef.current=true;
    requestAnimationFrame(()=>{ productRef.current?.blur(); sizeRef.current?.focus(); sizeRef.current?.select?.(); });
    setTimeout(()=>{ justSelectedRef.current=false; },250);
  };

  // Match existing product by category + name + size + article + purchase_rate + quantity_per_box + sale_rate.
  // If ALL match → use existing barcode (same product variant, same pricing).
  // If any differ → product_id=null, barcode='' → backend creates new barcode on save.
  const lookupProduct=useCallback(async(snap)=>{
    if(!snap.product_name) return;
    // If the picker/barcode scan already bound a product, don't wipe it on a subsequent
    // blur-triggered lookup just because the substring search missed the 200-row cap.
    // We'll still run the match logic to pre-fill hints, but we protect the existing binding.
    setLookupLoading(true);
    try{
      // name_exact=true + limit 500 — same treatment as the variant picker's fetchFamily.
      // The old %PLAZO% substring search with limit 200 was silently dropping newly-created
      // variants when there were hundreds of PLAZO-like products, which caused this function
      // to believe the variant didn't exist and wipe the picker-assigned product_id/barcode.
      const{data}=await productAPI.search(snap.product_name,{category_id:snap.category_id,limit:500,name_exact:'true'});
      const list=data.data||[];
      const norm=s=>(s||'').toLowerCase().trim();
      const normTight=s=>(s||'').toString().toLowerCase().replace(/\s+/g,'').trim();
      const numEq=(a,b)=>{ // compare numbers, treat 0/null/undefined as same
        const fa=parseFloat(a)||0, fb=parseFloat(b)||0;
        return Math.abs(fa-fb)<0.001;
      };

      console.log('[lookup] snap', { name:snap.product_name, size:snap.size, art:snap.article_number, cat:snap.category_id,
        rate:snap.purchase_rate, qpb:snap.quantity_per_box, sale:snap.sale_rate, pid:snap.product_id, barcode:snap.barcode });
      console.log('[lookup] family', list.length, list.slice(0,5).map(p=>({ name:p.product_name, size:p.size_value, art:p.article_number, cat:p.category_id, rate:p.purchase_rate, qpb:p.quantity_per_box, sale:p.sale_rate, pid:p.product_id })));

      // Identity = (category + name + size + article). MULTIPLE variants can share identity
      // (different rate/qpb/sale → different barcode, same identity). We must scan ALL of
      // them, not just list.find's first hit, otherwise we'd wrongly wipe a picker-bound
      // variant when another variant with the same identity but different rate is first.
      const identityMatches=list.filter(p=>
        normTight(p.product_name)===normTight(snap.product_name)&&
        normTight(p.size_value)===normTight(snap.size)&&
        normTight(p.article_number)===normTight(snap.article_number)&&
        p.category_id===snap.category_id
      );

      if(identityMatches.length===0){
        console.warn('[lookup] NO identity match — wiping barcode', {
          want:{ n:normTight(snap.product_name), s:normTight(snap.size), a:normTight(snap.article_number), c:snap.category_id },
          have:list.map(p=>({ n:normTight(p.product_name), s:normTight(p.size_value), a:normTight(p.article_number), c:p.category_id })),
        });
        setEntry(prev=>({...prev,product_id:null,barcode:''}));
        return;
      }
      console.log('[lookup] identity matches', identityMatches.length, identityMatches.map(p=>({ pid:p.product_id, rate:p.purchase_rate, qpb:p.quantity_per_box, sale:p.sale_rate })));

      // Pricing gates — only enforce a field if the user has entered something meaningful.
      const rateEntered  = (snap.purchase_rate||0)>0;
      const qpbEntered   = (snap.quantity_per_box||0)>1;
      const saleEntered  = (snap.sale_rate||0)>0;

      // Among identity matches, find the one whose pricing ALSO matches the current entry.
      // Prefer the one already bound to entry.product_id (picker-picked) if it matches.
      const priceMatches = identityMatches.filter(p=>
        (!rateEntered || numEq(snap.purchase_rate, p.purchase_rate)) &&
        (!qpbEntered  || numEq(snap.quantity_per_box, p.quantity_per_box)) &&
        (!saleEntered || numEq(snap.sale_rate, p.sale_rate))
      );

      const fullMatch = snap.product_id
        ? (priceMatches.find(p=>p.product_id===snap.product_id) || priceMatches[0])
        : priceMatches[0];

      if(fullMatch){
        // Full match → existing product, use its barcode
        console.log('[lookup] full match found pid=', fullMatch.product_id, 'barcode=', fullMatch.barcode);
        setEntry(prev=>({...prev,
          product_id:fullMatch.product_id,
          barcode:fullMatch.barcode,
          // Pre-fill rate hints only if user hasn't entered them yet
          purchase_rate:rateEntered?prev.purchase_rate:parseFloat(fullMatch.purchase_rate)||0,
          sale_rate:saleEntered?prev.sale_rate:parseFloat(fullMatch.sale_rate)||0,
          mrp:prev.mrp||parseFloat(fullMatch.mrp)||0,
          margin_percentage:prev.margin_percentage||parseFloat(fullMatch.margin_percentage)||0,
          hsn_code:prev.hsn_code||fullMatch.hsn_code||'',
          gst_rate:prev.gst_rate||parseFloat(fullMatch.gst_rate)||0,
          quantity_per_box:qpbEntered?prev.quantity_per_box:parseFloat(fullMatch.quantity_per_box)||1,
        }));
      } else {
        // Identity matched but no variant has this exact pricing → new barcode variant
        console.warn('[lookup] identity ok but pricing differs from all', identityMatches.length, 'variants — wiping');
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
      quantity_per_box:parseFloat(variant.quantity_per_box)||1,
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
    // User explicitly skipped — tell the next blur NOT to run lookupProduct
    // so their typed sale_rate/qty/p-box don't get auto-overwritten from a matched variant.
    skipNextLookupRef.current = true;
    // Anchor-aware focus advance: article-picker → rate field; rate-picker → qty field
    setTimeout(()=>{
      const target = pickerAnchorRef.current === 'rate' ? qtyRef : rateRef;
      target.current?.focus(); target.current?.select?.();
    },30);
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
      // Auto-derive sale_rate only when rate/margin ACTUALLY changed. If AntD fires
      // onChange with the same value (e.g. blur formatting), skip recompute — otherwise
      // Math.ceil can shift sale_rate away from the picker-loaded DB value, which
      // then makes lookupProduct think it's a new variant and wipe the barcode.
      if((field==='purchase_rate'||field==='margin_percentage') && prev[field]!==value){
        const pr=field==='purchase_rate'?value:prev.purchase_rate;
        const mg=field==='margin_percentage'?value:prev.margin_percentage;
        u.sale_rate=Math.ceil(pr*(1+mg/100));
      }
      if(field==='sale_rate' && prev.sale_rate!==value && prev.purchase_rate>0)
        u.margin_percentage=+(((value-prev.purchase_rate)/prev.purchase_rate)*100).toFixed(2);
      return u;
    });
  };
  // Indices that trigger a silent lookup on leave: 3=Rate, 5=P/Box, 7=Sale Rate
  // Art# (idx=2) is handled by handleArticleBlur (variant picker) instead
  const LOOKUP_IDXS=new Set([3,5,7]);

  const handleEntryKey=(e,idx)=>{
    // When picker is visible, the global capture handler owns Up/Down/Enter/Esc/Tab.
    // Bail out here so we don't double-handle and desync state.
    if(showVariantPicker && (e.key==='ArrowUp'||e.key==='ArrowDown'||e.key==='Enter'||e.key==='Escape'||e.key==='Tab')) return;
    const isNum = idx >= 3;
    if(e.key==='Enter'||e.key==='Tab'||(e.key==='ArrowDown'&&!isNum)){
      e.preventDefault();
      if(LOOKUP_IDXS.has(idx)&&!showVariantPickerRef.current){
        if(skipNextLookupRef.current){ skipNextLookupRef.current = false; }
        else setEntry(snap=>{ lookupProduct(snap); return snap; });
      }
      if(idx>=entryRefs.length-1) addItem();
      else{const n=entryRefs[idx+1];if(n?.current){n.current.focus();n.current.select?.();}}
    }else if(e.key==='ArrowUp'&&!isNum){
      e.preventDefault();
      if(idx>0){const p=entryRefs[idx-1];if(p?.current){p.current.focus();p.current.select?.();}}
      else barcodeRef.current?.focus();
    }
  };

  const handleRateBlur=useCallback(()=>{
    if(showVariantPickerRef.current) return;
    if(skipNextLookupRef.current){ skipNextLookupRef.current = false; return; }
    setEntry(snap=>{ lookupProduct(snap); return snap; });
  },[lookupProduct]);

  // Reposition picker below whichever field triggered it (article or rate)
  const repositionPicker=useCallback(()=>{
    const anchorEl = pickerAnchorRef.current==='rate' ? rateWrapRef.current : articleWrapRef.current;
    if(anchorEl){
      const r=anchorEl.getBoundingClientRect();
      setPickerPos({top:r.bottom+4, left:r.left});
    }
  },[]);

  // ── PICKER TRIGGER via useEffect — strict filter + in-memory cache for speed ──

  // Normalise a field for comparison: lowercase + remove all whitespace.
  // Aggressive whitespace removal prevents "22-32" from failing to match "22 - 32" or "22-32 ".
  const normTight = s => (s||'').toString().toLowerCase().replace(/\s+/g,'').trim();

  // Cached family list keyed by product+category+size so we don't re-hit the API on every keystroke.
  // Short TTL (8 s) so that products newly created in this same form are picked up quickly.
  const familyCacheRef = useRef({ key:null, list:[], ts:0 });
  const CACHE_TTL_MS = 8000;
  const fetchFamily = useCallback(async (pname, category_id, sizeNorm) => {
    const key = `${normTight(pname)}|${category_id||''}|${sizeNorm||''}`;
    const now = Date.now();
    const c = familyCacheRef.current;
    if (c.key === key && (now - c.ts) < CACHE_TTL_MS) return c.list;
    // name_exact=true → server does `product_name ILIKE 'PLAZO'` (case-insensitive exact),
    // so we're not competing against the 200-row cap with unrelated PLAZO-like products.
    const { data } = await productAPI.search(pname, { category_id, limit:500, name_exact:'true' });
    const list = data.data || [];
    const family = list.filter(p =>
      normTight(p.product_name) === normTight(pname) &&
      (!sizeNorm || normTight(p.size_value) === sizeNorm)
    );
    console.log('[Picker] fetchFamily', { pname, category_id, sizeNorm, api_total:list.length, family_size:family.length,
      sample: list.slice(0,5).map(p=>({ name:p.product_name, size:p.size_value, art:p.article_number, cat:p.category_id })) });
    familyCacheRef.current = { key, list: family, ts: now };
    return family;
  }, []);
  const invalidateFamilyCache = useCallback(() => { familyCacheRef.current = { key:null, list:[], ts:0 }; }, []);

  // Article field — show ONLY variants whose article_number matches what's typed
  useEffect(() => {
    const pname = (entry.product_name||'').trim();
    const aval  = (entry.article_number||'').trim();
    console.log('[Picker:Art] effect', { pname, aval, size:entry.size, cat:entry.category_id });
    if (!pname || !aval) {
      if (pickerAnchorRef.current === 'article') { setShowVariantPicker(false); setVariantOptions([]); setPickerArticleFilter(null); }
      return;
    }
    let cancelled = false;
    const timer = setTimeout(async () => {
      try {
        const norm = s => (s||'').toLowerCase().trim();
        // Use normTight for size so "22 - 32" and "22-32" collapse to the same key
        const family = await fetchFamily(pname, entry.category_id, normTight(entry.size));
        if (cancelled) return;
        const artNorm = norm(aval);
        const matches = family.filter(p => norm(p.article_number).includes(artNorm));
        console.log('[Picker:Art] filter', { pname, size:entry.size, artNorm, family_count:family.length, matched:matches.length,
          sample: family.slice(0,5).map(p=>({ size:p.size_value, art:p.article_number })) });
        if (matches.length > 0) {
          pickerAnchorRef.current = 'article';
          setPickerArticleFilter(aval);
          setPickerRateFilter(null);
          setVariantOptions(matches);
          setVariantPickerIdx(-1);          // no pre-select — user must ↓ to select
          setShowVariantPicker(true);
        } else {
          setShowVariantPicker(false); setVariantOptions([]); setPickerArticleFilter(null);
        }
      } catch (e) { console.error('[VariantPicker:Art]', e); }
    }, 120);
    return () => { cancelled = true; clearTimeout(timer); };
  }, [entry.article_number, entry.product_name, entry.category_id, entry.size, fetchFamily]);

  // Rate field — when article is blank, show ONLY variants whose purchase_rate matches
  useEffect(() => {
    const pname = (entry.product_name||'').trim();
    const aval  = (entry.article_number||'').trim();
    const rate  = parseFloat(entry.purchase_rate || 0);
    if (!pname || aval) return; // article effect owns the picker when article has a value
    if (rate <= 0) {
      if (pickerAnchorRef.current === 'rate') { setShowVariantPicker(false); setVariantOptions([]); setPickerRateFilter(null); }
      return;
    }
    let cancelled = false;
    const timer = setTimeout(async () => {
      try {
        const family = await fetchFamily(pname, entry.category_id, normTight(entry.size));
        if (cancelled) return;
        const matches = family.filter(p => Math.abs(parseFloat(p.purchase_rate||0) - rate) < 0.01);
        if (matches.length > 0) {
          pickerAnchorRef.current = 'rate';
          setPickerRateFilter(rate);
          setPickerArticleFilter(null);
          setVariantOptions(matches);
          setVariantPickerIdx(-1);          // no pre-select — user must ↓ to select
          setShowVariantPicker(true);
        } else {
          setShowVariantPicker(false); setVariantOptions([]); setPickerRateFilter(null);
        }
      } catch (e) { console.error('[VariantPicker:Rate]', e); }
    }, 120);
    return () => { cancelled = true; clearTimeout(timer); };
  }, [entry.purchase_rate, entry.article_number, entry.product_name, entry.category_id, entry.size, fetchFamily]);

  // Invalidate family cache when the product_name changes (so we re-fetch for the new product)
  useEffect(() => { familyCacheRef.current = { key:null, list:[] }; }, [entry.product_name, entry.category_id]);

  // Art# onChange — just update state; useEffect above handles picker
  const handleArticleChange=(value)=>{
    updateEntry('article_number',value);
    setPickerRateFilter(null);
    setPickerArticleFilter(null); // will be re-set by effect after debounce
  };

  // Rate onChange — update entry; useEffect above handles picker; also update rate highlight
  const handleRateInputChange=(value)=>{
    updateEntry('purchase_rate',value||0);
    setPickerRateFilter(value||null);
  };

  // Keep refs in sync so global keydown handler never captures stale values
  useEffect(()=>{ variantOptionsRef.current=variantOptions; },[variantOptions]);
  useEffect(()=>{ variantPickerIdxRef.current=variantPickerIdx; },[variantPickerIdx]);
  useEffect(()=>{ entryRef.current=entry; },[entry]);
  useEffect(()=>{ showVariantPickerRef.current=showVariantPicker; },[showVariantPicker]);
  const addItem=useCallback(async ()=>{
    if(barcodeError){message.error(barcodeError);return;}
    if(!entry.product_name){message.warning('Enter product name');return;}
    if(!entry.quantity||entry.quantity<=0){message.warning('Enter quantity');return;}
    if(!entry.purchase_rate||entry.purchase_rate<=0){message.warning('Enter purchase rate');return;}

    // Barcode to display in the list row:
    //   - existing match (picker pick / lookupProduct) → entry.barcode is already set
    //   - brand-new variant → ask server for the next barcode so the column isn't blank
    let barcode = entry.barcode || '';
    console.log('[addItem] entry.barcode=', entry.barcode, 'product_id=', entry.product_id);
    if (!entry.product_id && !barcode) {
      try {
        const { data } = await productAPI.getNextBarcode();
        barcode = data?.barcode || '';
        console.log('[addItem] reserved barcode=', barcode);
      } catch (e) {
        console.error('[addItem] barcode fetch failed', e?.response?.status, e?.response?.data, e);
        message.warning('Could not reserve barcode — restart the backend server for the /next-barcode route');
      }
    }

    // Warn (but don't block) on suspicious margins so typos on cost/sale rate
     // don't save silently into the product master as loss-making SKUs.
    if(entry.sale_rate>0 && entry.purchase_rate>0 && parseFloat(entry.sale_rate)<parseFloat(entry.purchase_rate)){
      message.warning(`Sale rate ₹${entry.sale_rate} is LOWER than purchase rate ₹${entry.purchase_rate}. Added — please verify.`);
    }
    const nextKey = nextKeyRef.current++;
    setItems(prev=>[...prev,{...entry,barcode,key:nextKey,total_amount:+(entry.quantity*entry.purchase_rate).toFixed(2)}]);
    setEntry(EMPTY_ENTRY); setBarcodeError('');
    setVariantOptions([]); setShowVariantPicker(false); setVariantPickerIdx(-1);
    setPickerRateFilter(null); setPickerArticleFilter(null);
    invalidateFamilyCache(); // next lookup re-fetches fresh from DB (may include variants just saved)
    setActiveCatId(null); // triggers useEffect → clears prodRawList automatically
    setTimeout(()=>barcodeRef.current?.focus(),50);
  },[entry,barcodeError,invalidateFamilyCache]);
  const removeItem=(key)=>setItems(prev=>prev.filter(i=>i.key!==key));

  /* totals */
  const discountPct  = Form.useWatch('discount_percentage',form)||0;
  const paidAmt      = Form.useWatch('paid_amount',form)||0;
  const otherChr     = Form.useWatch('other_charges',form)||0;
  const freightChr   = Form.useWatch('freight_charges',form)||0;
  const subTotal     = items.reduce((s,i)=>s+(i.quantity||0)*(i.purchase_rate||0),0);
  const discountAmt  = +(subTotal*discountPct/100).toFixed(2);
  const taxableTotal = +(subTotal-discountAmt).toFixed(2);
  // Pro-rate the bill-level (trade) discount across each line so GST applies to
  // the DISCOUNTED base — that's the GST-law definition of "transaction value"
  // for trade discounts shown on the invoice. Previously GST used gross values
  // and a 5% trade discount on a 18% GST bill overstated GST by ~0.9% of total.
  const discountRatio = subTotal>0 ? discountAmt/subTotal : 0;
  const productGST   = +items.reduce((s,i)=>{
    const grossLine  = (i.quantity||0)*(i.purchase_rate||0);
    const taxableLine= grossLine*(1-discountRatio);
    return s + taxableLine*((i.gst_rate||0)/100);
  },0).toFixed(2);
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

  // When picker opens: compute fixed position below the triggering field.
  // (Do NOT reset variantPickerIdx — the article/rate effect already pre-selects idx 0.)
  useEffect(()=>{
    if(!showVariantPicker) return;
    repositionPicker();
  },[showVariantPicker, repositionPicker]);

  // Keep picker pinned below the anchor while the user scrolls or resizes
  useEffect(()=>{
    if(!showVariantPicker) return;
    const onScroll=()=>repositionPicker();
    window.addEventListener('scroll', onScroll, true);
    window.addEventListener('resize', onScroll);
    return ()=>{
      window.removeEventListener('scroll', onScroll, true);
      window.removeEventListener('resize', onScroll);
    };
  },[showVariantPicker, repositionPicker]);

  // Global capture-phase keydown — intercepts ↑↓/Enter/Esc/Tab from ANY focused field
  // while the variant picker is visible, so focus position doesn't matter
  useEffect(()=>{
    if(!showVariantPicker) return;
    const handler=e=>{
      if(e.key==='ArrowDown'){
        e.preventDefault(); e.stopPropagation();
        setVariantPickerIdx(i=>{
          const n = variantOptionsRef.current.length;
          if (n === 0) return -1;
          return i < 0 ? 0 : Math.min(i+1, n-1);
        });
      } else if(e.key==='ArrowUp'){
        e.preventDefault(); e.stopPropagation();
        setVariantPickerIdx(i=>{
          const n = variantOptionsRef.current.length;
          if (n === 0) return -1;
          return i <= 0 ? 0 : i-1;
        });
      } else if(e.key==='Enter' || e.key==='Tab'){
        e.preventDefault(); e.stopPropagation();
        const idx = variantPickerIdxRef.current;
        const opts = variantOptionsRef.current;
        if (idx >= 0 && opts[idx]) {
          // User explicitly arrow-navigated to a row → pick it
          handleVariantPick(opts[idx]);
        } else {
          // User didn't select anything — preserve their typed values, just advance focus
          handleVariantPickerDismiss();
        }
      } else if(e.key==='Escape'){
        e.preventDefault(); e.stopPropagation();
        handleVariantPickerDismiss();
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
    // Re-entrancy guard: a second Ctrl+Enter or rapid Save click during the
    // API round-trip would create a duplicate bill + duplicate stock inflow.
    if(submittingRef.current) return;
    try{
      const values=await form.validateFields();
      if(items.length===0){message.warning('Add at least one item');return;}
      // Block negative balance (paid_amount > total). Supplier ledger must
      // never receive an un-authorised credit from a data-entry typo.
      const paidPreview = payFull ? roundedTotal : (values.paid_amount||0);
      if(parseFloat(paidPreview) > roundedTotal + 0.01){
        message.error(`Paid amount ₹${parseFloat(paidPreview).toFixed(2)} exceeds bill total ₹${roundedTotal.toFixed(2)}`);
        return;
      }
      submittingRef.current=true;
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
        // Explicit mode flag so backend treats 0% bill-wise GST (exempt items)
        // as bill-wise, not as accidental product-wise fallback.
        gst_mode:gstMode,
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
      invalidateFamilyCache(); // newly-created variants are now live in DB — drop cached lookups
      const printItems=(data.items||[]).map(it=>({
        barcode:it.barcode,product_name:it.product_name,size:it.size,
        article_number:it.article_number,mrp:it.mrp,sale_rate:it.sale_rate,
        purchase_rate:it.purchase_rate,quantity:it.quantity,quantity_per_box:it.quantity_per_box||1,
      }));
      setPrintModal({visible:true,bill:{...data,printItems}});
    }catch(e){ message.error(e.response?.data?.error||'Failed to save'); }
    finally{ setLoading(false); submittingRef.current=false; }
  },[form,items,discountPct,discountAmt,otherChr,freightChr,roundedTotal,isEdit,id]);

  const handleReset=()=>{
    setItems([]); setEntry(EMPTY_ENTRY); setBarcodeError('');
    setVariantOptions([]); setShowVariantPicker(false); setVariantPickerIdx(-1);
    setPickerRateFilter(null); setPickerArticleFilter(null);
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
                allowClear notFoundContent={null}
                dropdownStyle={{
                  borderRadius:8,
                  boxShadow:'0 10px 30px rgba(15,23,42,.12), 0 2px 8px rgba(15,23,42,.06)',
                  border:'1px solid #e2e8f0',
                  padding:0,
                }}
                dropdownRender={menu=>(
                  <div style={{fontFamily:'system-ui, -apple-system, "Segoe UI", Roboto, sans-serif'}}>
                    <div style={{
                      padding:'6px 12px',
                      background:'#f8fafc',
                      borderBottom:'1px solid #e2e8f0',
                      fontSize:10, fontWeight:700, letterSpacing:.6,
                      color:'#64748b', textTransform:'uppercase',
                    }}>
                      Category · {categories.length}
                    </div>
                    {menu}
                  </div>
                )}
              >
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
                listHeight={320} dropdownMatchSelectWidth={520}
                dropdownStyle={{
                  borderRadius:8,
                  boxShadow:'0 10px 30px rgba(15,23,42,.12), 0 2px 8px rgba(15,23,42,.06)',
                  border:'1px solid #e2e8f0',
                  padding:0,
                }}
                dropdownRender={menu=>(
                  <div style={{fontFamily:'system-ui, -apple-system, "Segoe UI", Roboto, sans-serif'}}>
                    {/* Column headers — align with option rows below (AntD option padding = 5px 12px) */}
                    <div style={{
                      display:'grid',
                      gridTemplateColumns:'1fr 90px 70px 60px 72px',
                      columnGap:10, alignItems:'center',
                      padding:'7px 12px',
                      background:'#f8fafc',
                      borderBottom:'1px solid #e2e8f0',
                      fontSize:10, fontWeight:700, letterSpacing:.6,
                      color:'#64748b', textTransform:'uppercase',
                    }}>
                      <span>Product</span>
                      <span>Category</span>
                      <span>Art#</span>
                      <span>Size</span>
                      <span style={{textAlign:'right'}}>Stock</span>
                    </div>
                    <div style={{
                      padding:'4px 12px',
                      background:'#fafbff',
                      borderBottom:'1px solid #eef2ff',
                      fontSize:11, fontWeight:600, color:'#4f46e5',
                    }}>
                      {dedupedProducts.length} product{dedupedProducts.length!==1?'s':''}
                      {productSearching?' · searching…':''}
                    </div>
                    {menu}
                  </div>
                )}
              >
                {dedupedProducts.map(p=>{
                  const stock    = parseFloat(p._totalStock||p.current_stock||0);
                  const stockColor = stock<=0 ? '#ef4444' : stock<=5 ? '#f59e0b' : '#10b981';
                  const stockBg    = stock<=0 ? '#fef2f2' : stock<=5 ? '#fffbeb' : '#f0fdf4';
                  return(
                    <Select.Option key={p.product_id} value={p.product_name} label={p.product_name} product={p}>
                      <div style={{
                        display:'grid',
                        gridTemplateColumns:'1fr 90px 70px 60px 72px',
                        columnGap:10, alignItems:'center',
                        fontFamily:'system-ui, -apple-system, "Segoe UI", Roboto, sans-serif',
                        fontVariantNumeric:'tabular-nums',
                      }}>
                        {/* Product name */}
                        <span style={{
                          fontWeight:600, fontSize:13, color:'#0f172a',
                          whiteSpace:'nowrap', overflow:'hidden', textOverflow:'ellipsis',
                        }}>{p.product_name}</span>

                        {/* Category */}
                        <span style={{
                          fontSize:11, color:'#475569',
                          whiteSpace:'nowrap', overflow:'hidden', textOverflow:'ellipsis',
                        }}>{p.Category?.category_name || '—'}</span>

                        {/* Art# */}
                        <span style={{
                          fontSize:12, color:'#64748b',
                          whiteSpace:'nowrap', overflow:'hidden', textOverflow:'ellipsis',
                        }}>{p.article_number || '—'}</span>

                        {/* Size */}
                        <span style={{fontSize:12, color:'#64748b'}}>{p.size_value || '—'}</span>

                        {/* Stock */}
                        <span style={{
                          display:'inline-flex', alignItems:'center', gap:4,
                          fontSize:11, fontWeight:600, color:stockColor,
                          background:stockBg, borderRadius:4, padding:'1px 6px',
                          justifySelf:'end',
                        }}>
                          <span style={{width:6, height:6, borderRadius:'50%', background:stockColor}}/>
                          {stock<=0 ? 'out' : stock}
                        </span>
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
               wrapRef:rateWrapRef, onChangeFn:v=>handleRateInputChange(v||0)},
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
            {/* Variant picker — rendered via portal to document.body so no ancestor CSS can hide it */}
            {showVariantPicker&&variantOptions.length>0&&(
              <VariantPickerDropdown
                options={variantOptions}
                selectedIdx={variantPickerIdx}
                onPick={handleVariantPick}
                top={pickerPos.top}
                left={pickerPos.left}
                rateFilter={pickerAnchorRef.current==='rate'?pickerRateFilter:null}
                articleFilter={pickerAnchorRef.current==='article'?pickerArticleFilter:null}
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

              {/* Balance — show Due / Paid in full / Overpaid explicitly so a
                   negative balance (e.g. after removing items post-payment) is
                   never silently hidden by Math.abs. */}
              {(() => {
                const isOverpaid = balance < -0.001;
                const isDue      = balance > 0.001;
                const bg    = isDue ? 'rgba(239,68,68,0.15)'
                           : isOverpaid ? 'rgba(251,146,60,0.18)'
                           : 'rgba(52,211,153,0.12)';
                const border = isDue ? 'rgba(248,113,113,.4)'
                            : isOverpaid ? 'rgba(251,146,60,.45)'
                            : 'rgba(52,211,153,.3)';
                const color  = isDue ? '#f87171'
                            : isOverpaid ? '#fdba74'
                            : '#34d399';
                const label  = isDue ? 'Balance'
                            : isOverpaid ? 'Overpaid'
                            : 'Paid in full';
                return (
                  <div style={{
                    display:'flex', alignItems:'center', justifyContent:'space-between',
                    background: bg, borderRadius:8, padding:'6px 12px', flexShrink:0,
                    border:`1px solid ${border}`,
                  }}>
                    <span style={{fontSize:10,color:'rgba(255,255,255,.6)',fontWeight:700,letterSpacing:.8,textTransform:'uppercase'}}>{label}</span>
                    <span style={{fontSize:17,fontWeight:800,color,letterSpacing:-.5}}>
                      {fmtN(Math.abs(balance))}
                    </span>
                  </div>
                );
              })()}

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
