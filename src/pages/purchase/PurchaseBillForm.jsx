import React, { useState, useRef, useEffect, useLayoutEffect, useCallback, useMemo } from 'react';
import ReactDOM from 'react-dom';
import { Form, Input, DatePicker, Select, InputNumber, Table, message, Modal, Popover, Checkbox } from 'antd';
import { SettingOutlined } from '@ant-design/icons';
import { useNavigate, useParams, useLocation } from 'react-router-dom';
import dayjs from 'dayjs';
import { purchaseAPI, purchaseDraftAPI, partyAPI, productAPI, categoryAPI, settingsAPI, godownAPI } from '../../api';
import { printDocument } from '../../services/printer';
import ActionStrip from '../../components/keyboard/ActionStrip';
import { useDatePopup } from '../../components/keyboard/DatePopup';
import confirmPrint from '../../utils/confirmPrint';
import { useUnsavedChangesWarning } from '../../hooks/useUnsavedChangesWarning';
import { useMultiWarehouseEnabled, useMultiColorEnabled } from '../../hooks/useSystemSettings';
import BarcodePrintModal from '../../components/BarcodePrintModal';
import ProductFormModal from '../../components/ProductFormModal';
import './purchase-bill-form.css';

const fmtN = (v) => parseFloat(v || 0).toLocaleString('en-IN', { minimumFractionDigits: 2 });

const EMPTY_ENTRY = {
  barcode:'', category_id:null, category_name:'', product_name:'', size:'',
  // P/Box left at 0 — the entry-row cell shows empty placeholder
  // (val: entry.quantity_per_box || undefined renders 0 as nothing) so
  // the operator types the actual box-size themselves. Downstream
  // calculations (boxQty, item-row math, save payload) all already
  // fall back to 1 when quantity_per_box is missing/0/falsy.
  article_number:'', purchase_rate:0, quantity:0, quantity_per_box:0,
  margin_percentage:0, sale_rate:0, mrp:0, hsn_code:'', gst_rate:0, product_id:null,
  // Batch tracking — only meaningful when global batch_tracking_enabled
  // is ON AND the resolved product has is_batch_tracked=true. The
  // entry-row batch strip stays mounted but hidden otherwise.
  is_batch_tracked:false, batch_number:'', manufacture_date:null,
  expiry_date:null, batch_notes:'',
  // Product mode — copied from the picked product (or 'variant' default).
  // Drives two things on the entry row:
  //   1. lookupProduct skips entirely for single mode (don't wipe the
  //      product_id binding when the user types a different rate).
  //   2. The variant-only fields (Size, Art#, P/Box, Margin%, Sale ₹, GST%)
  //      hide when a single-mode product is bound — they're master data,
  //      not per-line inputs in single mode.
  product_mode:'variant',
  // Color dimension — only meaningful for multi-color tracked
  // products. Each line carries a color_mode flag (copied from the
  // resolved product), the picked color_id+color_name, and the
  // available colors list (so the items-table dropdown can render
  // without a separate fetch). Non-multi lines stay 'none'/null.
  color_mode:'none', color_id:null, color_name:'', colors:[],
};

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
  const location = useLocation();
  const { id }   = useParams();
  const isEdit   = Boolean(id);

  const [form]            = Form.useForm();
  const [items, setItems] = useState([]);
  const [parties, setParties]       = useState([]);
  const [categories, setCategories] = useState([]);
  // Multi-warehouse master toggle. When OFF the picker hides and every
  // bill posts against the seeded default godown — the loadGodowns
  // pre-fill below already sets that, so submission still works.
  const multiWarehouseOn = useMultiWarehouseEnabled();
  const multiColorOn = useMultiColorEnabled();
  // Active godowns the operator can receive purchases into (filtered to
  // user.allowed_godowns when set; server enforces independently).
  const [godowns, setGodowns]       = useState([]);
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

  // Items table column visibility — operator picks via the Customize
  // popover in the top header. Required columns are pinned on; default
  // visible set covers all the optional pricing columns since purchase
  // entry typically wants the full pricing rhythm. Persists per-browser
  // via localStorage so the choice survives reloads.
  const PBF_COL_DEFAULTS = ['barcode','size','article','qpb','margin','sale_rate','mrp','gst'];
  const [pbfVisibleCols, setPbfVisibleCols] = useState(() => {
    try {
      const raw = localStorage.getItem('pbf_visible_cols');
      if (raw) return new Set(JSON.parse(raw));
    } catch {}
    return new Set(PBF_COL_DEFAULTS);
  });
  const togglePbfCol = (key) => {
    setPbfVisibleCols(prev => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key); else next.add(key);
      try { localStorage.setItem('pbf_visible_cols', JSON.stringify([...next])); } catch {}
      return next;
    });
  };
  const [companyName, setCompanyName] = useState('');
  const [billNumber, setBillNumber]   = useState('');
  // Predicted next bill number for new bills — operator sees what they'll get
  // on save instead of "pending". Computed from latest bill + prefix.
  const [nextBillNoPreview, setNextBillNoPreview] = useState('');
  // gstMode defaults to the user's last choice (saved in localStorage) for
  // new bills, but flips to 'bill' when we load an existing bill that was
  // clearly stored as bill-wise — i.e. it has non-zero bill-level GST
  // percentages or amounts. Without this, Tally-imported bills (which are
  // always bill-wise and whose line items have gst_rate=0) would render
  // with zero tax in the edit form and disagree with the list total.
  const [gstMode, setGstMode] = useState(()=>localStorage.getItem('gst_mode')||'product');
  const [cgstPct, setCgstPct] = useState(0);
  const [sgstPct, setSgstPct] = useState(0);
  const [igstPct, setIgstPct] = useState(0);

  // ── Amount-only billing state (mirrors SalesBillForm) ──
  // 'item' (default itemised) | 'amount' (single synthetic line for service /
  // freight / on-account purchases). Defaults to itemised; toggle hidden when
  // operator disables `enable_amount_only_billing` in System Settings.
  const [billMode,   setBillMode]   = useState('item');
  const [amountVal,    setAmountVal]    = useState('');
  const [amountGstRate,setAmountGstRate]= useState(0);
  const [amountHsnCode,setAmountHsnCode]= useState('');
  const [amountDesc,   setAmountDesc]   = useState('');
  const [amountOnlyEnabled, setAmountOnlyEnabled] = useState(true);
  // Global batch-tracking switch — gates the per-line batch strip on batch-
  // tracked products. With it OFF, batch-tracked products silently behave
  // as non-batch (the prompt is explicit about this — toggling global
  // must not break existing bills).
  const [batchTrackingEnabled, setBatchTrackingEnabled] = useState(false);
  // Global default product mode — drives the entry-row simplification.
  // When 'single', variant-only fields hide ALWAYS (regardless of which
  // product was picked), because the operator's UX is shaped by their
  // firm's mode, not the catalog row's mode. A leftover variant product
  // gets used silently with its master fields. The picked product's
  // own product_mode still drives backend persistence (frozen vs
  // overwritten purchase_rate, wac vs no wac, etc.) — only the form
  // UX is global-driven.
  const [globalProductMode, setGlobalProductMode] = useState('variant');
  // +Add Product modal — purely a shortcut to the existing Inventory →
  // Products → Add flow so the operator can register a missing product
  // mid-bill without leaving the purchase form. After save, the new
  // product is in the master and pickable from the dropdown like any
  // other; we don't auto-select on the entry row.
  const [addProductModalOpen, setAddProductModalOpen] = useState(false);

  // ── Hold / Recall / Drafts state ──
  // Tracks which draft (if any) the form was recalled from so handleSave
  // can pass the draft_id to the backend for same-txn deletion.
  const [recalledDraftId, setRecalledDraftId] = useState(null);
  const [holdLoading, setHoldLoading]         = useState(false);
  const [drafts, setDrafts]                   = useState([]);
  const [draftsModalOpen, setDraftsModalOpen] = useState(false);
  const [selectedDraftIdx, setSelectedDraftIdx] = useState(0);
  const draftCardRefs = useRef([]);

  const tableWrapRef = useRef(null);
  // F6 = Jump to Amt Paid input — attached to the Antd InputNumber.
  const paidInputRef = useRef(null);
  const [tblHeight, setTblHeight] = useState(300);
  const barcodeRef  = useRef(null);
  // Purchase flow is "category → product → details" (wholesale-buy style)
  // rather than sales' "scan barcode" POS flow. We focus categoryRef after
  // supplier pick AND after every addItem so the operator drops into the
  // category dropdown ready to start the next line item.
  const categoryRef = useRef(null);
  const productRef  = useRef(null);
  const sizeRef     = useRef(null);
  const articleRef  = useRef(null);
  const rateRef     = useRef(null);
  const qtyRef      = useRef(null);
  const qpbRef      = useRef(null);
  const marginRef   = useRef(null);
  const saleRateRef = useRef(null);
  const gstRef      = useRef(null);
  // Batch-strip refs — populated whenever batch_tracking_enabled is on
  // (regardless of the picked product's flag). Keyboard nav threads
  // them onto the end of entryRefs so Tab/Enter/Arrow walk lands on
  // Lot → Mfg → Exp → Notes → ADD without breaking the rhythm.
  const batchNumRef = useRef(null);
  const mfgRef      = useRef(null);
  const expRef      = useRef(null);
  const batchNotesRef = useRef(null);
  // Tab/Enter/ArrowDown walk this array left → right; ArrowUp walks
  // back. Order MIRRORS the visual entry-row order: Product → Size →
  // Art# → Qty → Rate → P/Box → Margin% → Sale ₹ → GST% → (+ADD via
  // the addItem fall-through at the end of handleEntryKey).
  // Qty BEFORE Rate so the natural typing rhythm is "size, art, how
  // many, at what price" — same flow as the sales form.
  const entryRefs   = [productRef,sizeRef,articleRef,qtyRef,rateRef,qpbRef,marginRef,saleRateRef,gstRef,
    // Batch refs are inserted at the end so the keyboard walk is:
    // … GST% → Lot → Mfg → Exp → Notes → ADD (handled by addItem
    // fall-through in handleEntryKey when idx >= entryRefs.length-1).
    batchNumRef, mfgRef, expRef, batchNotesRef,
  ];

  useLayoutEffect(()=>{
    const el = tableWrapRef.current;
    if(!el) return;
    setTblHeight(Math.max(100, el.clientHeight - 40));
    const ro = new ResizeObserver(([e])=>setTblHeight(Math.max(100, e.contentRect.height - 40)));
    ro.observe(el);
    return ()=>ro.disconnect();
  },[]);

  // Auto-scroll table body to bottom whenever a new item is added.
  // Track previous length so load (0 → N) and remove (N → N-1) don't
  // fire an unnecessary scroll.
  //
  // useLayoutEffect + synchronous scroll (no rAF) is intentional: the
  // scroll runs in the commit phase BEFORE the browser paints, so the
  // user sees the new row already at the bottom in the very first frame.
  // A previous rAF-based approach caused a one-frame "stretch then snap
  // back" because the new row rendered before the scroll adjusted.
  const prevItemsLenRef = useRef(0);
  useLayoutEffect(()=>{
    const prev = prevItemsLenRef.current;
    prevItemsLenRef.current = items.length;
    if(items.length > prev && items.length > 0){
      const body = tableWrapRef.current?.querySelector('.ant-table-body');
      if(body) body.scrollTop = body.scrollHeight;
    }
  },[items.length]);

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
    loadParties(); loadCategories(); loadGodowns();
    settingsAPI.getSystem().then(({data}) => {
      setCompanyName(data?.data?.company_name || '');
      // Default to enabled when the column is missing (older DBs without
      // the migration). Treat literal `false` as off; anything else is on.
      setAmountOnlyEnabled(data?.data?.enable_amount_only_billing !== false);
      setBatchTrackingEnabled(!!data?.data?.batch_tracking_enabled);
      setGlobalProductMode(data?.data?.default_product_mode || 'variant');
    }).catch(()=>{});
    // Predict the next bill number on new bills so the operator sees what
    // they'll get on save instead of "pending". Optimistic — actual
    // allocation happens server-side under a row lock and may drift if
    // another operator races us.
    if (!isEdit) {
      Promise.all([
        purchaseAPI.getAll({ limit: 1, page: 1 }),
        settingsAPI.getSystem(),
      ]).then(([listRes, setRes]) => {
        const prefix = setRes?.data?.data?.purchase_bill_prefix?.trim() || '';
        const latest = listRes?.data?.data?.[0]?.bill_number || '';
        const m = String(latest).match(/(\d+)(?!.*\d)/);
        const next = (m ? parseInt(m[1], 10) + 1 : 1);
        const padded = String(next).padStart(m ? m[1].length : 4, '0');
        setNextBillNoPreview((prefix ? prefix + '-' : '') + padded);
      }).catch(() => {});
    }
    if (isEdit) loadBill(id);
    else { form.setFieldsValue({bill_date:dayjs()}); setTimeout(()=>barcodeRef.current?.focus(),100); }
  }, [id]);

  const loadParties    = async()=>{ try{ const{data}=await partyAPI.getSuppliers({limit:1000}); setParties((data.data||[]).filter(p=>p.is_active!==false)); }catch(e){} };
  const loadCategories = async()=>{ try{ const{data}=await categoryAPI.getAllFlat(); setCategories(data||[]); }catch(e){} };
  const loadGodowns    = async()=>{
    try {
      const { data } = await godownAPI.getAll();
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
    } catch (e) { /* surfaces as empty dropdown — server enforces required */ }
  };

  const loadBill = async(billId)=>{
    setPageLoading(true);
    try{
      const{data}=await purchaseAPI.getById(billId);
      setBillNumber(data.bill_number||'');
      form.setFieldsValue({
        godown_id:data.godown_id,
        supplier_id:data.supplier_id,
        walk_in_name:data.walk_in_name||'',
        bill_date:data.bill_date?dayjs(data.bill_date):dayjs(),
        supplier_bill_number:data.supplier_bill_number||'',
        due_date:data.due_date?dayjs(data.due_date):null,
        transport_name:data.transport_name||'',
        vehicle_number:data.vehicle_number||'',
        lr_number:data.lr_number||'',
        // Derive pct from amount/sub_total when only amount is stored —
        // see SalesBillForm for rationale. Without this fallback, imported
        // purchase bills render with the discount amount visible but the
        // total never subtracts it.
        discount_percentage: (() => {
          const pct = parseFloat(data.discount_percentage)||0;
          if (pct > 0) return pct;
          const amt = parseFloat(data.discount_amount)||0;
          const sub = parseFloat(data.sub_total)||0;
          return (amt > 0 && sub > 0) ? +(amt / sub * 100).toFixed(4) : 0;
        })(),
        other_charges:parseFloat(data.other_charges)||0,
        freight_charges:parseFloat(data.freight_charges)||0,
        paid_amount:parseFloat(data.paid_amount)||0,
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
      setDiscAmtVal(parseFloat(data.discount_amount)||0);
      // Heuristic (mirrors SalesBillForm): if the bill has any bill-level
      // GST (pct or amount), it was stored bill-wise — flip the form's
      // mode so the totals match how the bill was originally saved.
      if (loadedCgstPct > 0 || loadedSgstPct > 0 || loadedIgstPct > 0
          || loadedCgstAmt > 0 || loadedSgstAmt > 0 || loadedIgstAmt > 0) {
        setGstMode('bill');
      }
      // Restore amount-mode if this bill was saved as a single synthetic line.
      // Backend persists bill_mode='amount' + description on the header; the
      // single item carries the rate (=amount), gst_rate, hsn_code.
      if (data.bill_mode === 'amount') {
        setBillMode('amount');
        const synth = (data.items || [])[0] || {};
        setAmountVal(parseFloat(synth.purchase_rate) || parseFloat(data.sub_total) || 0);
        setAmountGstRate(parseFloat(synth.gst_rate) || 0);
        setAmountHsnCode(synth.hsn_code || '');
        setAmountDesc(data.description || synth.product_name || '');
        setItems([]);
      } else {
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
          // Restore batch dimension. The included batch object (if any)
          // carries the metadata back so the Batch column can render
          // mfg/exp on edit; is_batch_tracked is read off the included
          // product so the picker still gates correctly when the line
          // is being edited rather than re-entered.
          is_batch_tracked: !!(it.product?.is_batch_tracked || it.batch_id),
          batch_id: it.batch_id || null,
          batch_number: it.batch?.batch_number || '',
          manufacture_date: it.batch?.manufacture_date || null,
          expiry_date: it.batch?.expiry_date || null,
          batch_notes: it.batch?.notes || '',
        }));
        // Advance monotonic key counter above any loaded row so newly-added
        // items in edit mode can't collide with existing keys.
        const maxLoadedKey = loaded.reduce((m,it)=>Math.max(m, it.key||0), 0);
        nextKeyRef.current = maxLoadedKey + 1;
        setItems(loaded);
      }
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
        is_batch_tracked:!!data.is_batch_tracked,
        product_mode:data.product_mode||'variant',
        batch_number:'', manufacture_date:null, expiry_date:null, batch_notes:'',
        // Multi-color tracking — purchase shows the dropdown of all
        // active colors (no stock filter; receiving more of any color
        // is always valid). Operator picks one before ADD; the per-
        // line color_id propagates into the saved bill row.
        color_mode: data.color_mode || 'none',
        color_id: null, color_name: '',
        colors: (data.color_mode === 'multi' && Array.isArray(data.colors)) ? data.colors : [],
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
  // Deduplicate by product_name, aggregate stock across variants. Batch
  // tracking is OR'd across the family — if ANY variant of "Banarasi
  // Silk Saree" is batch-tracked, the name-pick treats the family as
  // batch-tracked. Per-variant refinement happens when lookupProduct
  // resolves a specific (size, article, rate) match.
  //
  // product_mode preference: if any variant of a name is single-mode, the
  // dropdown picks the single-mode one. Single mode is "one product per
  // name", so prefer it when present — otherwise the dropdown's choice
  // of "first variant in result order" can land on a stale variant-mode
  // sibling and force the user through variant flow.
  const dedupedProducts=useMemo(()=>{
    const map=new Map();
    prodRawList.forEach(p=>{
      const key=(p.product_name||'').toLowerCase().trim();
      if(!map.has(key)){
        map.set(key,{...p, _totalStock:parseFloat(p.current_stock||0), is_batch_tracked:!!p.is_batch_tracked});
      } else {
        const existing=map.get(key);
        existing._totalStock+=parseFloat(p.current_stock||0);
        if(p.is_batch_tracked) existing.is_batch_tracked=true;
        // Replace with single-mode sibling if found — single takes priority.
        if(p.product_mode==='single' && existing.product_mode!=='single'){
          const carriedStock=existing._totalStock;
          const carriedBatch=existing.is_batch_tracked;
          map.set(key, {...p, _totalStock:carriedStock, is_batch_tracked:carriedBatch});
        }
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
    const isSingle = p.product_mode === 'single';

    if (isSingle) {
      // SINGLE mode: bind product_id + barcode immediately so the save
      // payload references the existing product directly. No lookup
      // needed — single mode = "one product per name", and the picker
      // already resolved which product. Pre-fill master fields as
      // hints; the operator typically only changes Qty + Rate.
      // Variant-only entry-row fields (Size / Art# / P/Box / Margin /
      // Sale / GST) get hidden by the mode-aware row filter below.
      setEntry(prev=>({...prev,
        product_id: p.product_id,
        barcode: p.barcode || '',
        product_name: p.product_name,
        category_id: p.category_id || prev.category_id,
        category_name: p.Category?.category_name || prev.category_name,
        size: p.size_value || '',
        article_number: p.article_number || '',
        purchase_rate: parseFloat(p.purchase_rate) || 0,
        sale_rate: parseFloat(p.sale_rate) || 0,
        mrp: parseFloat(p.mrp) || 0,
        margin_percentage: parseFloat(p.margin_percentage) || 0,
        hsn_code: p.hsn_code || '',
        gst_rate: parseFloat(p.gst_rate) || 0,
        quantity_per_box: parseFloat(p.quantity_per_box) || 1,
        is_batch_tracked: !!p.is_batch_tracked,
        product_mode: 'single',
        batch_number:'', manufacture_date:null, expiry_date:null, batch_notes:'',
      }));
      setBarcodeError('');
      // Single mode has no Size / Art# entry — focus Qty directly.
      justSelectedRef.current=true;
      requestAnimationFrame(()=>{ productRef.current?.blur(); qtyRef.current?.focus(); qtyRef.current?.select?.(); });
      setTimeout(()=>{ justSelectedRef.current=false; },250);
      return;
    }

    // VARIANT mode (existing behaviour, unchanged) — only set name +
    // category. Match lookup (by category+name+size+article) runs after
    // article# is entered to resolve which specific variant the user means.
    setEntry(prev=>({...prev,
      product_name:p.product_name,
      category_id:p.category_id||prev.category_id,
      category_name:p.Category?.category_name||prev.category_name,
      product_id:null, barcode:'',
      size:'', article_number:'',
      purchase_rate:0, sale_rate:0, mrp:0, margin_percentage:0,
      hsn_code:'', gst_rate:0, quantity_per_box:0,
      is_batch_tracked:!!p.is_batch_tracked,
      product_mode: p.product_mode || 'variant',
      batch_number:'', manufacture_date:null, expiry_date:null, batch_notes:'',
    }));
    setBarcodeError('');
    justSelectedRef.current=true;
    requestAnimationFrame(()=>{ productRef.current?.blur(); sizeRef.current?.focus(); sizeRef.current?.select?.(); });
    setTimeout(()=>{ justSelectedRef.current=false; },250);
  };

  // Match existing product by category + name + size + article + purchase_rate + quantity_per_box + sale_rate.
  // If ALL match → use existing barcode (same product variant, same pricing).
  // If any differ → product_id=null, barcode='' → backend creates new barcode on save.
  const lookupProduct=useCallback(async(snap)=>{
    if(!snap.product_name) return;
    // SINGLE-MODE short-circuit (unconditional). The fingerprint cascade
    // below is variant-mode UX — it wipes product_id when size / rate /
    // qpb differ from the matched row, expecting the server to spawn a
    // new variant on save. In single mode the server refuses to spawn
    // (Case 5 hard-block) and the matching is name-only at save time
    // (Case 4.5 case-insensitive iLike across all modes), so running
    // this lookup here can only HURT — a typed-but-not-picked product
    // would get wiped client-side, the save would error with "not in
    // master list", and the operator loses their typed line. Skip
    // entirely; the server resolver does the right thing.
    if (snap.product_mode === 'single' || globalProductMode === 'single') return;
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
          is_batch_tracked:!!fullMatch.is_batch_tracked,
          product_mode:fullMatch.product_mode||'variant',
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
      is_batch_tracked:!!variant.is_batch_tracked,
      product_mode:variant.product_mode||'variant',
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
    // Numeric cells (idx 3..8) consume ArrowUp/Down for value-step;
    // text + DatePicker cells (idx 0..2 + 9..12) let arrows walk
    // between fields. Batch strip (Lot / Mfg / Exp / Notes) is the
    // 9..12 range — explicit so a future re-order of the entry row
    // doesn't accidentally make them numeric.
    const isNum = idx >= 3 && idx <= 8;
    if(e.key==='Enter'||e.key==='Tab'||(e.key==='ArrowDown'&&!isNum)){
      e.preventDefault();
      if(LOOKUP_IDXS.has(idx)&&!showVariantPickerRef.current){
        if(skipNextLookupRef.current){ skipNextLookupRef.current = false; }
        else setEntry(snap=>{ lookupProduct(snap); return snap; });
      }
      // Skip-walk past unmounted refs. variantOnly cells (size, art#,
      // p/box, margin, sale, gst) are filtered out of the DOM in
      // single mode, and batch cells (Lot/Mfg/Exp/Notes) only mount
      // when batch_tracking_enabled. Their refs stay in entryRefs
      // but .current === null — focus would silently no-op without
      // this skip, leaving the operator stranded mid-row.
      let nextIdx = idx + 1;
      while (nextIdx < entryRefs.length && !entryRefs[nextIdx]?.current) nextIdx++;
      if (nextIdx >= entryRefs.length) addItem();
      else { entryRefs[nextIdx].current.focus(); entryRefs[nextIdx].current.select?.(); }
    }else if(e.key==='ArrowUp'&&!isNum){
      e.preventDefault();
      // Symmetric skip-walk back through unmounted refs.
      let prevIdx = idx - 1;
      while (prevIdx >= 0 && !entryRefs[prevIdx]?.current) prevIdx--;
      if (prevIdx >= 0) { entryRefs[prevIdx].current.focus(); entryRefs[prevIdx].current.select?.(); }
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
    // Single mode never spawns variants by definition — there's only
    // one product per name. The picker is variant-mode-only UX; in
    // single mode the operator's typed name + Case 4.5 server-side
    // resolver bind to the existing master row, no per-rate / per-
    // article disambiguation needed.
    if (globalProductMode === 'single') { setShowVariantPicker(false); return; }
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
    // Mirror of the article-anchored effect: skip the rate-anchored
    // picker entirely in single mode. Single-mode purchase rate is
    // just the per-line landed cost — it doesn't disambiguate across
    // sibling SKUs because there are no siblings.
    if (globalProductMode === 'single') { setShowVariantPicker(false); return; }
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
    // Batch enforcement mirrors the server-side check — keeps the round-
    // trip out of the operator's typing flow when the rule is obviously
    // unmet. Server still validates on save (defence in depth).
    if(batchTrackingEnabled && entry.is_batch_tracked && !entry.batch_number?.trim()){
      message.warning(`"${entry.product_name}" is batch-tracked. Enter a batch number.`);
      return;
    }

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
    // Focus the Category dropdown for the NEXT line item — purchase is a
    // wholesale-buy flow where the operator picks category → product per
    // line, not a barcode-scan flow. Sales does the opposite (focus
    // barcode after addItem) because retail = scan-driven.
    setTimeout(()=>categoryRef.current?.focus(),50);
  },[entry,barcodeError,invalidateFamilyCache,batchTrackingEnabled]);
  const removeItem=(key)=>setItems(prev=>prev.filter(i=>i.key!==key));

  /* totals */
  const discountPct  = Form.useWatch('discount_percentage',form)||0;
  const paidAmt      = Form.useWatch('paid_amount',form)||0;
  const otherChr     = Form.useWatch('other_charges',form)||0;
  const freightChr   = Form.useWatch('freight_charges',form)||0;
  // Watch supplier so we can show the walk-in vendor name field only when
  // the system "Cash" party is selected. Same UX as the sales form.
  const supplierIdW  = Form.useWatch('supplier_id', form);
  const isCashSupplierSelected = !!parties.find(
    p => p.party_id === supplierIdW && p.is_system_cash,
  );
  // In amount-mode the synthetic line has no item/bill discount — taxableTotal
  // is just the typed amount, GST is rate% × amount on a 'product'-style path.
  const subTotal     = billMode === 'amount'
    ? (parseFloat(amountVal) || 0)
    : items.reduce((s,i)=>s+(i.quantity||0)*(i.purchase_rate||0),0);
  const discountAmt  = billMode === 'amount' ? 0 : +(subTotal*discountPct/100).toFixed(2);
  const taxableTotal = +(subTotal-discountAmt).toFixed(2);
  // Pro-rate the bill-level (trade) discount across each line so GST applies to
  // the DISCOUNTED base — that's the GST-law definition of "transaction value"
  // for trade discounts shown on the invoice. Previously GST used gross values
  // and a 5% trade discount on a 18% GST bill overstated GST by ~0.9% of total.
  const discountRatio = subTotal>0 ? discountAmt/subTotal : 0;
  const productGST   = billMode === 'amount'
    ? +(taxableTotal * ((parseFloat(amountGstRate) || 0) / 100)).toFixed(2)
    : +items.reduce((s,i)=>{
      const grossLine  = (i.quantity||0)*(i.purchase_rate||0);
      const taxableLine= grossLine*(1-discountRatio);
      return s + taxableLine*((i.gst_rate||0)/100);
    },0).toFixed(2);
  // Force product-wise math in amount-mode so the synthetic line's per-rate
  // GST drives the totals (matches what salesController.create does on save).
  const effGstMode   = billMode === 'amount' ? 'product' : gstMode;
  const effCgstPct   = effGstMode==='bill' ? (cgstPct||0) : (taxableTotal>0 ? +(productGST/2/taxableTotal*100).toFixed(2) : 0);
  const effSgstPct   = effGstMode==='bill' ? (sgstPct||0) : effCgstPct;
  const cgst         = effGstMode==='bill' ? +(taxableTotal*(cgstPct||0)/100).toFixed(2) : +(productGST/2).toFixed(2);
  const sgst         = effGstMode==='bill' ? +(taxableTotal*(sgstPct||0)/100).toFixed(2) : +(productGST/2).toFixed(2);
  const igstAmt      = effGstMode==='bill' ? +(taxableTotal*(igstPct||0)/100).toFixed(2) : 0;
  const totalGST     = +(cgst+sgst+igstAmt).toFixed(2);
  const rawTotal     = taxableTotal+totalGST+parseFloat(otherChr||0)+parseFloat(freightChr||0);
  // Always round the net total to the nearest rupee (matches Tally's
  // convention). The fractional residue lands in round_off automatically,
  // so the form's net total agrees with the list's stored total.
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

  /* ── save ──
     `payFull=true` is the legacy "Save & Pay" auto-fill path; the
     redesigned strip stops passing it — paid_amount is whatever the
     operator typed in the Payment Card. Param stays for back-compat.
     `opts.onSaved(data, { openPrintModal })` fires after a successful
     save and BEFORE the form navigates / resets. If the callback
     opens the print modal, the form stays mounted (the modal's own
     onClose handles navigation). Otherwise we navigate / reset
     normally. This lets F1 ask "Print labels?" and only open the
     modal if the user agrees. */
  const handleSave=useCallback(async(payFull=false, opts={})=>{
    // Re-entrancy guard: a second Ctrl+Enter or rapid Save click during the
    // API round-trip would create a duplicate bill + duplicate stock inflow.
    if(submittingRef.current) return;
    try{
      const values=await form.validateFields();
      if (billMode === 'item' && items.length === 0) {
        message.warning('Add at least one item or switch to Amount mode');
        return;
      }
      if (billMode === 'amount' && (!parseFloat(amountVal) || parseFloat(amountVal) <= 0)) {
        message.warning('Enter an amount greater than 0');
        return;
      }
      // Block negative balance (paid_amount > total). Supplier ledger must
      // never receive an un-authorised credit from a data-entry typo.
      const paidPreview = payFull ? roundedTotal : (values.paid_amount||0);
      if(parseFloat(paidPreview) > roundedTotal + 0.01){
        message.error(`Paid amount ₹${parseFloat(paidPreview).toFixed(2)} exceeds bill total ₹${roundedTotal.toFixed(2)}`);
        return;
      }
      submittingRef.current=true;
      setLoading(true);
      // walk_in_name is only meaningful when the system Cash supplier
      // is selected; sent regardless so flipping a non-cash bill back
      // to Cash mid-edit cleanly overwrites the column.
      const walkIn = String(values.walk_in_name || '').trim().slice(0, 120);
      const billData={
        // Receiving godown — picked in the header strip; the controller
        // routes per-godown stock writes against this id.
        godown_id: values.godown_id,
        supplier_id:values.supplier_id,
        walk_in_name: walkIn || null,
        bill_date:values.bill_date.format('YYYY-MM-DD'),
        due_date:values.due_date?.format('YYYY-MM-DD'),
        supplier_bill_number:values.supplier_bill_number,
        transport_name:values.transport_name,
        vehicle_number:values.vehicle_number,
        lr_number:values.lr_number,
        remarks:(values.remarks||'').trim(),
        // Amount-mode skips bill-level discount entirely (no item or bill
        // discount on the synthetic line — mirrors salesController).
        discount_percentage: billMode === 'amount' ? 0 : discountPct,
        discount_amount:     billMode === 'amount' ? 0 : discountAmt,
        other_charges:parseFloat(otherChr)||0,
        freight_charges:parseFloat(freightChr)||0,
        // Explicit mode flag so backend treats 0% bill-wise GST (exempt items)
        // as bill-wise, not as accidental product-wise fallback.
        gst_mode: billMode === 'amount' ? 'product' : gstMode,
        cgst_pct: billMode === 'amount' ? 0 : (parseFloat(cgstPct)||0),
        sgst_pct: billMode === 'amount' ? 0 : (parseFloat(sgstPct)||0),
        igst_pct: billMode === 'amount' ? 0 : (parseFloat(igstPct)||0),
        paid_amount:payFull?roundedTotal:(values.paid_amount||0),
        // Amount-only mode: backend synthesises the single line from these
        // four fields. items[] is ignored when bill_mode='amount'.
        bill_mode:    billMode,
        amount:       billMode === 'amount' ? parseFloat(amountVal) || 0 : undefined,
        gst_rate:     billMode === 'amount' ? parseFloat(amountGstRate) || 0 : undefined,
        hsn_code:     billMode === 'amount' ? (amountHsnCode || '9999') : undefined,
        description:  billMode === 'amount' ? amountDesc : undefined,
        // Tells the backend to delete the recalled draft inside the same
        // transaction as the bill insert (race-safe: rollback keeps draft alive).
        draft_id:     recalledDraftId || undefined,
        items: billMode === 'amount' ? [] : items.map(i=>({
          product_id:i.product_id,barcode:i.barcode,
          category_id:i.category_id,category_name:i.category_name,
          product_name:i.product_name,size:i.size,
          article_number:i.article_number,hsn_code:i.hsn_code,
          quantity:i.quantity,quantity_per_box:i.quantity_per_box||1,
          purchase_rate:i.purchase_rate,margin_percentage:i.margin_percentage,
          sale_rate:i.sale_rate,mrp:i.mrp,gst_rate:i.gst_rate,
          // Batch fields per line. Server resolves/creates the batch row
          // from (product_id, batch_number) on save; date / notes are
          // first-write-wins so a re-purchase against an existing batch
          // doesn't overwrite the original metadata.
          batch_number:i.batch_number||undefined,
          manufacture_date:i.manufacture_date||undefined,
          expiry_date:i.expiry_date||undefined,
          batch_notes:i.batch_notes||undefined,
          // Forward color_id only for multi-color products. Backend
          // validator throws if a non-multi line carries one (stale
          // state from a UI bug).
          color_id: i.color_mode === 'multi' ? (i.color_id || null) : null,
        })),
      };
      // Block save while any multi-color line is missing its pick.
      // Server validates the same rule, but catching it here saves a
      // round-trip and keeps the operator's focus on the bad line.
      if (billMode !== 'amount') {
        const missing = items.findIndex(
          (it) => it.color_mode === 'multi' && !it.color_id,
        );
        if (missing >= 0) {
          message.warning(
            `Pick a color on line ${missing + 1} (${items[missing].product_name || 'item'}) before saving.`,
          );
          submittingRef.current = false;
          setLoading(false);
          return;
        }
      }
      const{data}=isEdit?await purchaseAPI.update(id,billData):await purchaseAPI.create(billData);
      message.success(`Bill ${data.bill_number} ${isEdit?'updated':'saved'}!`);
      invalidateFamilyCache(); // newly-created variants are now live in DB — drop cached lookups
      setRecalledDraftId(null);
      loadDrafts();

      // Track whether the onSaved callback chose to open the print
      // modal — when it does, the form stays mounted because the
      // modal's onClose handler does the navigation itself.
      let modalOpened = false;
      const openPrintModal = () => {
        if (billMode === 'amount') return; // amount-mode has no items to label
        modalOpened = true;
        const printItems = (data.items||[]).map(it=>({
          barcode:it.barcode,product_name:it.product_name,size:it.size,
          article_number:it.article_number,mrp:it.mrp,sale_rate:it.sale_rate,
          purchase_rate:it.purchase_rate,quantity:it.quantity,quantity_per_box:it.quantity_per_box||1,
        }));
        setPrintModal({visible:true,bill:{...data,printItems}});
      };

      if (opts.onSaved) {
        try { await opts.onSaved(data, { openPrintModal }); }
        catch (err) { console.error('[handleSave onSaved]', err); }
      }

      if (!modalOpened) {
        if (isEdit) navigate('/purchases');
        else { handleReset(); setBillNumber(''); }
      }
    }catch(e){ message.error(e.response?.data?.error||'Failed to save'); }
    finally{ setLoading(false); submittingRef.current=false; }
  },[form,items,discountPct,discountAmt,otherChr,freightChr,roundedTotal,isEdit,id,billMode,amountVal,amountGstRate,amountHsnCode,amountDesc,recalledDraftId,gstMode,cgstPct,sgstPct,igstPct]);

  const handleReset=()=>{
    setItems([]); setEntry(EMPTY_ENTRY); setBarcodeError('');
    setVariantOptions([]); setShowVariantPicker(false); setVariantPickerIdx(-1);
    setPickerRateFilter(null); setPickerArticleFilter(null);
    setActiveCatId(null);
    setAmountVal(''); setAmountGstRate(0); setAmountHsnCode(''); setAmountDesc('');
    setRecalledDraftId(null);
    form.resetFields(['supplier_id','walk_in_name','supplier_bill_number','transport_name','vehicle_number','lr_number','due_date','discount_percentage','paid_amount','other_charges','freight_charges','remarks']);
    setTimeout(()=>barcodeRef.current?.focus(),50);
  };

  // Warn on tab close/refresh when there's in-progress work. Declared above
  // handleRecallDraft because the recall flow reads `dirty` for the
  // unsaved-work confirmation. Amount-mode counts as dirty when an amount > 0.
  const dirty = items.length > 0 || (billMode === 'amount' && parseFloat(amountVal) > 0);
  const confirmLeave = useUnsavedChangesWarning(dirty);

  // F1 / F2 / F3 / F4 / F5 / F6 / F9 / Esc / Ctrl+Enter (alias of F1) /
  // Ctrl+L (Drafts) — all bound by the <ActionStrip> at the bottom of
  // the form. Single-source-of-truth registry; no parallel keydown
  // listeners needed.

  // F1 Save — saves the bill, then asks once "Print barcode labels?"
  // (Enter = open the BarcodePrintModal · Esc = skip and return to
  // the purchase list). One save key replaces the old dual F1 + F2.
  const handleSaveWithPrintPrompt = useCallback(() => {
    return handleSave(false, {
      onSaved: async (data, { openPrintModal }) => {
        // Amount-mode bills have no items to label → skip the prompt.
        if (billMode === 'amount') return;
        const wantsPrint = await confirmPrint(
          data?.bill_number ? `Print barcode labels for ${data.bill_number}?` : 'Print barcode labels?',
        );
        if (wantsPrint) openPrintModal();
      },
    });
  }, [handleSave, billMode]);

  // F2 Date popup — Tally-style smart-input popup for the bill date.
  const { openDate } = useDatePopup();
  const f2DatePopup = useCallback(() => {
    const current = form.getFieldValue('bill_date');
    openDate({
      title: 'Bill Date',
      value: current ? dayjs(current) : dayjs(),
      onConfirm: (d) => form.setFieldsValue({ bill_date: dayjs(d) }),
    });
  }, [form, openDate]);

  // F3 — toggle focus between Barcode and the items table. If focus
  // is anywhere inside .pbf-tbl-wrap, jump home to barcode; otherwise
  // land on the LAST row's quantity cell (the typical "fix the qty I
  // just scanned" use). Quantity column is at ciIdx=4 in this form
  // (see numCell call sites in allCols below).
  const isInItemsTable = (el) => !!(el && el.closest && el.closest('.pbf-tbl-wrap'));
  const focusBarcode = () => {
    barcodeRef.current?.focus?.();
    barcodeRef.current?.select?.();
  };
  const focusItemsTable = () => {
    const wrap = tableWrapRef.current;
    if (!wrap) return;
    const qtyCells = wrap.querySelectorAll('[id^="sc-"][id$="-4"] input');
    if (qtyCells.length === 0) return;
    const target = qtyCells[qtyCells.length - 1];
    target.focus();
    target.select?.();
  };
  const toggleBarcodeItems = useCallback(() => {
    const active = typeof document !== 'undefined' ? document.activeElement : null;
    if (isInItemsTable(active)) focusBarcode();
    else focusItemsTable();
  }, []);

  // F6 — focus the Amt Paid input via its ref.
  const jumpToPaymentCard = useCallback(() => {
    const inst = paidInputRef.current;
    if (!inst) return;
    inst.focus?.();
    setTimeout(() => inst.select?.(), 0);
  }, []);

  /* ── Hold (save as draft) ──
     Mirrors SalesBillForm.handleHold. Persists the entire form payload to
     purchase_bill_drafts so the operator can step away mid-bill (customer
     interruption, etc.) without consuming a bill_number. F4 keybind. */
  const loadDrafts = useCallback(async () => {
    try {
      const { data } = await purchaseDraftAPI.list();
      setDrafts(data?.data || []);
    } catch { /* silent — drafts pill just shows 0 */ }
  }, []);
  useEffect(() => { loadDrafts(); }, [loadDrafts]);
  useEffect(() => { if (draftsModalOpen) setSelectedDraftIdx(0); }, [draftsModalOpen]);

  const handleHold = useCallback(async () => {
    if (isEdit) return;                    // edit mode is a real bill, not a draft
    if (holdLoading) return;
    if (billMode === 'item' && items.length === 0 &&
        (billMode === 'amount' && !parseFloat(amountVal))) {
      message.warning('Nothing to hold — enter at least one item or an amount');
      return;
    }
    setHoldLoading(true);
    try {
      const values = form.getFieldsValue();
      const payload = {
        supplier_id:        values.supplier_id || null,
        walk_in_name:       String(values.walk_in_name || '').trim() || null,
        bill_date:          values.bill_date ? values.bill_date.format('YYYY-MM-DD') : null,
        due_date:           values.due_date  ? values.due_date.format('YYYY-MM-DD')  : null,
        supplier_bill_number: values.supplier_bill_number || '',
        transport_name:     values.transport_name || '',
        vehicle_number:     values.vehicle_number || '',
        lr_number:          values.lr_number || '',
        remarks:            (values.remarks || '').trim(),
        discount_percentage: parseFloat(values.discount_percentage) || 0,
        other_charges:       parseFloat(values.other_charges) || 0,
        freight_charges:     parseFloat(values.freight_charges) || 0,
        paid_amount:         parseFloat(values.paid_amount) || 0,
        gst_mode: gstMode, cgst_pct: cgstPct, sgst_pct: sgstPct, igst_pct: igstPct,
        bill_mode: billMode,
        amount:    billMode === 'amount' ? parseFloat(amountVal) || 0 : null,
        gst_rate:  billMode === 'amount' ? parseFloat(amountGstRate) || 0 : null,
        hsn_code:  billMode === 'amount' ? (amountHsnCode || '9999') : null,
        description: billMode === 'amount' ? amountDesc : null,
        items: billMode === 'amount' ? [] : items.map(i => ({
          product_id: i.product_id, barcode: i.barcode,
          category_id: i.category_id, category_name: i.category_name,
          product_name: i.product_name, size: i.size,
          article_number: i.article_number, hsn_code: i.hsn_code,
          quantity: i.quantity, quantity_per_box: i.quantity_per_box || 1,
          purchase_rate: i.purchase_rate, margin_percentage: i.margin_percentage,
          sale_rate: i.sale_rate, mrp: i.mrp, gst_rate: i.gst_rate,
          // Batch fields preserved on Hold so a recalled draft restores
          // them on next open. is_batch_tracked is rehydrated from the
          // product on recall, not the draft payload.
          batch_number: i.batch_number || null,
          manufacture_date: i.manufacture_date || null,
          expiry_date: i.expiry_date || null,
          batch_notes: i.batch_notes || null,
        })),
        _total_preview: roundedTotal,
      };
      // Update if recalled, else create.
      if (recalledDraftId) {
        await purchaseDraftAPI.update(recalledDraftId, payload);
        message.success('Draft updated');
      } else {
        const { data } = await purchaseDraftAPI.create(payload);
        message.success(`Held as ${data.draft_number}`);
      }
      handleReset();
      setRecalledDraftId(null);
      loadDrafts();
    } catch (e) {
      message.error(e.response?.data?.error || 'Failed to hold');
    } finally {
      setHoldLoading(false);
    }
  }, [form, items, billMode, amountVal, amountGstRate, amountHsnCode, amountDesc, gstMode, cgstPct, sgstPct, igstPct, recalledDraftId, holdLoading, isEdit, roundedTotal, loadDrafts]);

  /* ── Recall draft — restore form state from a held purchase_bill_drafts
     row. Sets recalledDraftId so the next save deletes the draft inside
     the same transaction. */
  const recallDraft = useCallback(async (draftId) => {
    try {
      const { data: draft } = await purchaseDraftAPI.get(draftId);
      const p = draft.payload || {};
      const mode = p.bill_mode === 'amount' ? 'amount' : 'item';
      setBillMode(mode);
      setRecalledDraftId(draft.draft_id);
      form.setFieldsValue({
        supplier_id:        p.supplier_id || undefined,
        walk_in_name:       p.walk_in_name || '',
        bill_date:          p.bill_date ? dayjs(p.bill_date) : dayjs(),
        due_date:           p.due_date  ? dayjs(p.due_date)  : undefined,
        supplier_bill_number: p.supplier_bill_number || '',
        transport_name:     p.transport_name || '',
        vehicle_number:     p.vehicle_number || '',
        lr_number:          p.lr_number || '',
        remarks:            p.remarks || '',
        paid_amount:        p.paid_amount || 0,
        discount_percentage:p.discount_percentage || 0,
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

  // Honour ?recallDraft state on mount (when navigated here from /purchases).
  useEffect(() => {
    const draftId = location.state?.recallDraft;
    if (draftId) recallDraft(draftId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /* Recall a draft after the unsaved-work prompt — shared by mouse click,
     double-click, and the Enter-key path so behaviour is consistent. */
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
     Enter to recall, Esc closed by AntD by default. */
  useEffect(() => {
    if (!draftsModalOpen || drafts.length === 0) return;
    const onKey = (e) => {
      if (document.querySelector('.ant-modal-confirm')) return;
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setSelectedDraftIdx(i => Math.min(i + 1, drafts.length - 1));
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        setSelectedDraftIdx(i => Math.max(i - 1, 0));
      } else if (e.key === 'Home') {
        e.preventDefault(); setSelectedDraftIdx(0);
      } else if (e.key === 'End') {
        e.preventDefault(); setSelectedDraftIdx(drafts.length - 1);
      } else if (e.key === 'Enter') {
        e.preventDefault();
        const d = drafts[selectedDraftIdx];
        if (d) handleRecallDraft(d);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [draftsModalOpen, drafts, selectedDraftIdx, handleRecallDraft]);

  useEffect(() => {
    if (!draftsModalOpen) return;
    const el = draftCardRefs.current[selectedDraftIdx];
    el?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }, [selectedDraftIdx, draftsModalOpen]);

  /* ── Table columns — Excel-style cells ──
     Inputs fill the whole cell (no floating pill). numCell/txtCell no
     longer take a fixed width — CSS handles it. The wrapping div carries
     id="tc-ri-ci" for arrow-key navigation. */
  const numCell=(ri,ci,val,field,min)=>(
    <div id={`tc-${ri}-${ci}`}>
      <InputNumber keyboard={false} variant="borderless" value={val}
        onChange={v=>updateItem(items[ri]?.key,field,v??0)}
        onKeyDown={e=>navTable(e,ri,ci)} min={min??0}
        size="small"/>
    </div>
  );
  const txtCell=(ri,ci,val,field)=>(
    <div id={`tc-${ri}-${ci}`}>
      <Input variant="borderless" value={val}
        onChange={e=>updateItem(items[ri]?.key,field,e.target.value)}
        onKeyDown={e=>navTable(e,ri,ci)}
        size="small"/>
    </div>
  );
  const readCell=(v,style={})=>(
    <span style={{fontSize:13,fontWeight:700,color:'var(--fg-primary)',fontFamily:'inherit',...style}}>{v||'—'}</span>
  );

  // Column catalogue — every column tagged with a `key` so the
  // Customize popover can flip them on/off; `required:true` columns
  // are pinned on. Filtered through `pbfVisibleCols` below.
  const allItemColumns=[
    { key:'index', required:true, title:'#', width:40, align:'center', render:(_,__,i)=><span style={{color:'var(--fg-primary)',fontSize:13,fontWeight:700,fontFamily:'inherit',textAlign:'center'}}>{i+1}</span> },
    { key:'barcode', title:'Barcode', dataIndex:'barcode', width:120,
      render:(v,r,ri)=>(
        <div id={`tc-${ri}-0`}>
          <Input variant="borderless" value={v}
            onChange={e=>updateItem(r.key,'barcode',e.target.value)}
            onBlur={e=>validateItemBarcode(r.key,e.target.value)}
            onKeyDown={e=>navTable(e,ri,0)}
            size="small" placeholder="—"/>
        </div>
      ),
    },
    // Batch column — auto-mounted (NOT operator-toggleable) when the
    // global toggle is on AND at least one line in the bill is batch-
    // tracked. Tagged with key:'__batch' so the Customize filter still
    // lets it through — `required:true` keeps it on whenever rendered.
    ...(batchTrackingEnabled && items.some(i=>i.is_batch_tracked) ? [{
      key:'__batch', required:true, title:'Batch', dataIndex:'batch_number', width:130,
      render:(v,r)=>r.is_batch_tracked ? (
        <div style={{fontSize:12,lineHeight:1.3}}>
          <div style={{fontWeight:600,color:'var(--fg-primary)'}}>{v||'—'}</div>
          {(r.manufacture_date || r.expiry_date) && (
            <div style={{fontSize:11,color:'var(--fg-tertiary)'}}>
              {r.manufacture_date && <span>Mfg {dayjs(r.manufacture_date).format('DD/MM/YY')}</span>}
              {r.manufacture_date && r.expiry_date && <span> · </span>}
              {r.expiry_date && <span>Exp {dayjs(r.expiry_date).format('DD/MM/YY')}</span>}
            </div>
          )}
        </div>
      ) : <span style={{color:'var(--fg-tertiary)'}}>—</span>,
    }] : []),
    { key:'product_name', required:true, title:'Product Name', dataIndex:'product_name', width:180,
      render:(v,r,ri)=>(
        <div id={`tc-${ri}-1`}>
          <Input variant="borderless" value={v} onChange={e=>updateItem(r.key,'product_name',e.target.value)}
            onKeyDown={e=>navTable(e,ri,1)} size="small"/>
        </div>
      ),
    },
    { key:'size',     title:'Size',  dataIndex:'size',             width:70,  render:(v,r,ri)=>txtCell(ri,2,v,'size') },
    // Color column — same posture as the sales form: shown only for
    // multi-color tracked products, hidden cell ("—") for non-multi
    // lines so a mixed bill reads cleanly. The column itself drops
    // out of the table when no line is multi-color (see filter below).
    { key:'color', title:'Color', dataIndex:'color_id', width:130,
      render:(v,r)=>{
        if (r.color_mode !== 'multi') return <span style={{color:'var(--fg-tertiary)'}}>—</span>;
        const opts = (r.colors || []).map((c) => ({ value: c.color_id, label: c.color_name }));
        return (
          <Select
            size="small"
            value={v || undefined}
            placeholder="Pick color"
            onChange={(val) => {
              const picked = (r.colors || []).find((c) => c.color_id === val);
              updateItem(r.key, 'color_id', val);
              updateItem(r.key, 'color_name', picked?.color_name || '');
            }}
            style={{ width: '100%' }}
            status={!v ? 'error' : ''}
            options={opts}
            dropdownStyle={{ minWidth: 160 }}
          />
        );
      },
    },
    { key:'article',  title:'Art#',  dataIndex:'article_number',   width:80,  render:(v,r,ri)=>txtCell(ri,3,v,'article_number') },
    { key:'qty',      required:true, title:'Qty',   dataIndex:'quantity',          width:80,  align:'center', className:'num-cell', render:(v,r,ri)=>numCell(ri,4,v,'quantity',0) },
    { key:'qpb',      title:'P/Box', dataIndex:'quantity_per_box',  width:70,  align:'center', className:'num-cell', render:(v,r,ri)=>numCell(ri,5,v,'quantity_per_box',1) },
    { key:'rate',     required:true, title:'Rate ₹',dataIndex:'purchase_rate',    width:100, align:'right',  className:'num-cell', render:(v,r,ri)=>numCell(ri,6,v,'purchase_rate',0) },
    { key:'margin',   title:'MG%',   dataIndex:'margin_percentage', width:70,  align:'right',  className:'num-cell', render:(v,r,ri)=>numCell(ri,7,v,'margin_percentage',null) },
    { key:'sale_rate',title:'Sale ₹',dataIndex:'sale_rate',         width:100, align:'right',  className:'num-cell', render:(v,r,ri)=>numCell(ri,8,v,'sale_rate',0) },
    { key:'mrp',      title:'MRP ₹', dataIndex:'mrp',               width:90,  align:'right',  className:'num-cell', render:(v,r,ri)=>numCell(ri,9,v,'mrp',0) },
    { key:'gst',      title:'GST%',  dataIndex:'gst_rate',          width:70,  align:'right',  className:'num-cell', render:(v,r,ri)=>numCell(ri,10,v,'gst_rate',0) },
    { key:'amount',   required:true, title:'Amount ₹', width:116, align:'right', className:'num-cell',
      render:(_,r)=><span style={{color:'var(--fg-primary)',fontWeight:700,fontSize:13,fontFamily:'inherit',fontVariantNumeric:'tabular-nums',textAlign:'right'}}>{fmtN((r.quantity||0)*(r.purchase_rate||0))}</span>,
    },
    { key:'remove',   required:true, title:'', width:36, align:'center',
      render:(_,r)=><button onClick={()=>removeItem(r.key)} style={{background:'none',border:'none',cursor:'pointer',color:'var(--danger)',fontSize:16,padding:'6px 8px',borderRadius:0,lineHeight:1,width:'100%',height:'100%'}}>×</button>,
    },
  ];
  // Filter to operator-chosen columns. Required ones always pass.
  // The Color column appears only when the global Multi-color toggle
  // is ON AND at least one line is multi-color tracked — installs
  // without the feature continue to look identical to before.
  const pbfAnyMultiColor = items.some((it) => it.color_mode === 'multi');
  const itemColumns = allItemColumns.filter(c => {
    if (c.key === 'color') return !!multiColorOn && pbfAnyMultiColor;
    return c.required || pbfVisibleCols.has(c.key);
  });

  // Customize popover — uses the shared `.cols-menu` markup so the
  // global customize-menu styles in styles/global.css drive the look.
  // Required + batch columns are deliberately NOT shown in the modal
  // (they're either auto-mounted from data state or always-on).
  const pbfCustomizeContent = (
    <div className="cols-menu" style={{ width: 240 }}>
      <div className="grp">
        <div className="gh">
          <span>Item details</span>
          <button
            className="gh-reset"
            type="button"
            onClick={() => {
              setPbfVisibleCols(new Set(PBF_COL_DEFAULTS));
              try { localStorage.removeItem('pbf_visible_cols'); } catch {}
            }}
          >Reset</button>
        </div>
        {[
          {key:'barcode',title:'Barcode'},
          {key:'size',   title:'Size'},
          {key:'article',title:'Art#'},
          {key:'qpb',    title:'P/Box'},
        ].map(c => (
          <label key={c.key} className="opt">
            <input
              type="checkbox"
              checked={pbfVisibleCols.has(c.key)}
              onChange={() => togglePbfCol(c.key)}
            />
            <span>{c.title}</span>
          </label>
        ))}
      </div>
      <div className="grp">
        <div className="mh">Pricing &amp; Tax</div>
        {[
          {key:'margin',   title:'MG%'},
          {key:'sale_rate',title:'Sale ₹'},
          {key:'mrp',      title:'MRP ₹'},
          {key:'gst',      title:'GST%'},
        ].map(c => (
          <label key={c.key} className="opt">
            <input
              type="checkbox"
              checked={pbfVisibleCols.has(c.key)}
              onChange={() => togglePbfCol(c.key)}
            />
            <span>{c.title}</span>
          </label>
        ))}
      </div>
    </div>
  );

  /* ─── Status for badge (Paid / Balance / Overpaid) ──────────────────── */
  const isOverpaid = balance < -0.001;
  const isDue      = balance > 0.001;
  const statusClass = isDue ? 'due' : isOverpaid ? 'over' : 'paid';
  const statusLabel = isDue ? 'Balance due' : isOverpaid ? 'Overpaid' : 'Paid in full';

  return (
    <Form form={form} component={false}>
      <div className="pbf-page">

        {/* ═══════════════════════════════ (1) TOP ════════════════════════════ */}
        <section className="pbf-top">
          <div className="pbf-top-inner">

            {/* Compact header strip — full-width, single row.
                LEFT  : doc-type chip + Bill-no box + Mode toggle (inline)
                MIDDLE: company name (chipped — visually parallel to doc chip)
                RIGHT : bill date + due date (no labels, pinned to right edge) */}
            <div className="pbf-top-head pbf-top-head--compact">
              <div className="pbf-top-head-left">
                <span className="pbf-chip">
                  {isEdit ? 'Edit Purchase' : 'New Purchase'}
                </span>
                {/* Bill number boxed pill — label and value share the SAME
                    font size so the eye reads them as one unit. */}
                <span className="pbf-billno-box">
                  <span className="pbf-billno-lbl">Bill no.</span>
                  <span className="pbf-billno-val">{billNumber || nextBillNoPreview || '…'}</span>
                </span>
                {/* Apple-style Items / Amount toggle. Hidden when amount-only
                    is disabled in Settings, and on Edit (mode is locked). */}
                {amountOnlyEnabled && !isEdit && (
                  <div className={`pbf-mode-apple ${billMode === 'amount' ? 'is-amount' : 'is-item'}`} role="tablist">
                    <span className="pbf-mode-apple-thumb" aria-hidden />
                    <button type="button" role="tab" aria-selected={billMode === 'item'}
                      className={`pbf-mode-apple-opt ${billMode === 'item' ? 'active' : ''}`}
                      onClick={() => { setBillMode('item'); setAmountVal(''); }}>
                      Items
                    </button>
                    <button type="button" role="tab" aria-selected={billMode === 'amount'}
                      className={`pbf-mode-apple-opt ${billMode === 'amount' ? 'active' : ''}`}
                      onClick={() => { setBillMode('amount'); setItems([]); setEntry(EMPTY_ENTRY); }}>
                      Amount
                    </button>
                  </div>
                )}
                {recalledDraftId && (
                  <span className="pbf-mode-recalled">Recalled draft</span>
                )}
              </div>
              {companyName && (
                <div className="pbf-top-head-center">
                  <span className="pbf-chip pbf-chip-company" title={companyName}>{companyName}</span>
                </div>
              )}
              <div className="pbf-top-head-right">
                {/* Receiving godown — sits in the header strip next to the
                    dates. Same height (size="small"); doesn't disturb the
                    company-name chip in the centre. Disabled on edit because
                    moving inventory between godowns is the Stock Transfer
                    flow rather than rewriting an existing bill. Hidden when
                    the Multi-warehouse master toggle is OFF — every bill
                    then posts against the default godown silently. */}
                {multiWarehouseOn && (
                  <Form.Item name="godown_id" noStyle rules={[{ required: true, message: ' ' }]}>
                    <Select
                      size="small"
                      style={{ width: 180 }}
                      placeholder="Godown *"
                      disabled={isEdit}
                      options={godowns.map(g => ({ value: g.godown_id, label: `${g.code} — ${g.name}` }))}
                    />
                  </Form.Item>
                )}
                {/* No labels — placeholders communicate the field's purpose. */}
                <Form.Item name="bill_date" noStyle rules={[{required:true,message:' '}]}>
                  <DatePicker style={{width:140}} format="DD-MM-YYYY" placeholder="Bill date *" size="small"/>
                </Form.Item>
                <Form.Item name="due_date" noStyle>
                  <DatePicker style={{width:140}} format="DD-MM-YYYY" placeholder="Due date" size="small"/>
                </Form.Item>
                {/* Customize — column-toggle popover. Lives in the
                    header so it's reachable regardless of bill mode. */}
                <Popover content={pbfCustomizeContent} title="Customize columns" trigger="click" placement="bottomRight">
                  <button type="button" className="sbf-cols-btn" title="Customize the items table columns">
                    <SettingOutlined /> Customize
                  </button>
                </Popover>
              </div>
            </div>

            {/* Supplier / transport row — bill_date and due_date moved up
                into the header strip's right cluster to match the editorial
                sales-form layout. When Cash is selected, the supplier-bill-#
                slot (col 2) flips to a Walk-in vendor name input — Tally-
                style cash purchases don't carry a separate supplier bill
                number, so the slot reuse is honest, not just convenient. */}
            <div className="pbf-top-row">
              <div className="pbf-field">
                {/* Supplier is hard-required. Cash purchases pick the
                    seeded system "Cash" party (pinned to the top); the
                    walk-in name appears in col 2 (same height + AntD
                    style as this Select) instead of supplier-bill-#. */}
                <Form.Item name="supplier_id" noStyle
                  rules={[{ required: true, message: 'Select a supplier (use Cash for walk-in vendors)' }]}>
                  <Select showSearch placeholder="Supplier (required — pick Cash for walk-in vendors)"
                    optionFilterProp="children" dropdownStyle={{minWidth:280}}
                    // Purchase = wholesale-buy flow: after picking the
                    // supplier, jump into the category dropdown so the
                    // operator can start choosing what to buy. onSelect
                    // (not onChange) so Form.Item's value binding stays
                    // intact and we don't fire on the initial-load
                    // hydration when editing an existing bill.
                    onSelect={() => setTimeout(() => categoryRef.current?.focus(), 50)}>
                    {parties.map(p=><Select.Option key={p.party_id} value={p.party_id}>{p.party_name}</Select.Option>)}
                  </Select>
                </Form.Item>
              </div>
              {/* Col 2 — supplier-bill-# OR walk-in name. Both rendered
                  but exactly one is display:flex so the grid track width
                  stays stable when toggling Cash on/off. */}
              <div className="pbf-field" style={{ display: isCashSupplierSelected ? 'none' : 'flex' }}>
                <Form.Item name="supplier_bill_number" noStyle>
                  <Input placeholder="Supp. bill #"/>
                </Form.Item>
              </div>
              <div className="pbf-field" style={{ display: isCashSupplierSelected ? 'flex' : 'none' }}>
                <Form.Item name="walk_in_name" noStyle>
                  {/* No allowClear — see SalesBillForm for the affix-wrapper
                      box-in-box rationale. */}
                  <Input placeholder="Walk-in vendor name (optional)" maxLength={120} style={{ width: '100%' }}/>
                </Form.Item>
              </div>
              <div className="pbf-field">
                <Form.Item name="transport_name" noStyle>
                  <Input placeholder="Transport"/>
                </Form.Item>
              </div>
              <div className="pbf-field">
                <Form.Item name="vehicle_number" noStyle>
                  <Input placeholder="Vehicle no."/>
                </Form.Item>
              </div>
              <div className="pbf-field">
                <Form.Item name="lr_number" noStyle>
                  <Input placeholder="LR no."/>
                </Form.Item>
              </div>
            </div>

            {/* ─── ENTRY ROW (Editorial Ledger) ──────────────────────────
             *
             *  Mirror of the sales-form ledger row — see SalesBillForm
             *  for the full rationale. One bordered strip with top +
             *  bottom hairlines, no internal rectangles, dotted column
             *  separators between cells, and a 2px accent under-rule on
             *  the active cell driven by :focus-within (zero React
             *  state). Field order: Barcode · Category · Product · Size
             *  · Art # · QTY · RATE · P/Box · Margin% · Sale ₹ · GST% ·
             *  +ADD — Qty BEFORE Rate so the typing rhythm is "size,
             *  art, how many, at what price", matching the sales form.
             *
             *  Logic preserved exactly: every ref (barcodeRef,
             *  productRef, sizeRef, articleRef, qtyRef, rateRef, qpbRef,
             *  marginRef, saleRateRef, gstRef + the *WrapRef wrappers)
             *  stays attached to the same element. The variant picker
             *  portal still anchors off articleWrapRef / rateWrapRef.
             *  handleRateBlur, handleRateInputChange,
             *  handleArticleChange, handleProductSelect,
             *  handleProductSearch, handleBarcodeScan, handleEntryKey —
             *  all unchanged.
             * ────────────────────────────────────────────────────────── */}
            {billMode === 'item' && (
            <div className="pbf-entry-ledger">
              <div className="pbf-entry-grid">
                {/* +Add Product — small icon affordance (40px) at the
                    start of the row. Opens the existing Add Product
                    modal so the operator can register a missing product
                    mid-bill without leaving the purchase form. After
                    save, the new product is in the master and appears
                    in the dropdown like any other; no auto-selection
                    on the entry row. Visible in both modes. Tooltip on
                    hover names the action. */}
                <button className="pbf-cell add-product"
                  type="button"
                  title="Add new product"
                  aria-label="Add new product"
                  onClick={() => setAddProductModalOpen(true)}>+</button>
                <div className="pbf-cell">
                  <div className="pbf-cell-lbl">Barcode</div>
                  <Input ref={barcodeRef} value={entry.barcode} placeholder="Scan or type"
                    onChange={e=>{setEntry(p=>({...p,barcode:e.target.value}));setBarcodeError('');}}
                    onPressEnter={e=>handleBarcodeScan(e.target.value)}
                    onBlur={e=>handleBarcodeBlur(e.target.value)}
                    onKeyDown={e=>{if(e.key==='ArrowDown'){e.preventDefault();productRef.current?.focus();}}}
                    status={barcodeError?'error':undefined}/>
                </div>
                <div className="pbf-cell has-arrow">
                  <div className="pbf-cell-lbl">Category</div>
                  <Select ref={categoryRef} value={activeCatId} placeholder="Category" showSearch
                    filterOption={(input,opt)=>!input||opt.children.toLowerCase().includes(input.toLowerCase())}
                    allowClear notFoundContent={null} dropdownMatchSelectWidth={300}
                    onChange={(v,opt)=>{
                      setActiveCatId(v||null);
                      setEntry(p=>({...p,category_id:v||null,category_name:opt?.children||'',product_name:'',product_id:null}));
                    }}>
                    {categories.map(c=><Select.Option key={c.category_id} value={c.category_id}>{c.category_name}</Select.Option>)}
                  </Select>
                </div>
                <div className="pbf-cell has-arrow" ref={prodWrapRef}>
                  <div className="pbf-cell-lbl">Product</div>
                  <Select key={activeCatId??'no-cat'} ref={productRef}
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
                    placeholder={activeCatId?'Product name (in category)':'Product name'}
                    notFoundContent={productSearching?'Searching…':null}
                    listHeight={320} dropdownMatchSelectWidth={520}>
                    {dedupedProducts.map(p=>{
                      const stock = parseFloat(p._totalStock||p.current_stock||0);
                      const stockColor = stock<=0 ? 'var(--danger)' : stock<=5 ? 'var(--warning)' : 'var(--success)';
                      return(
                        <Select.Option key={p.product_id} value={p.product_name} label={p.product_name} product={p}>
                          <div style={{display:'grid',gridTemplateColumns:'1fr 90px 70px 60px 72px',columnGap:10,alignItems:'center',fontVariantNumeric:'tabular-nums'}}>
                            <span style={{fontWeight:600,fontSize:13,overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap'}}>{p.product_name}</span>
                            <span style={{fontSize:11,color:'var(--fg-tertiary)',overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap'}}>{p.Category?.category_name||'—'}</span>
                            <span style={{fontSize:12,color:'var(--fg-tertiary)',overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap'}}>{p.article_number||'—'}</span>
                            <span style={{fontSize:12,color:'var(--fg-tertiary)'}}>{p.size_value||'—'}</span>
                            <span style={{fontSize:11,fontWeight:600,color:stockColor,justifySelf:'end'}}>
                              {stock<=0?'out':stock}
                            </span>
                          </div>
                        </Select.Option>
                      );
                    })}
                  </Select>
                </div>
                {/* Field array: Size · Art# · QTY · RATE · P/Box · Margin% ·
                 *  Sale ₹ · GST%. Indices 1–8 line up with entryRefs[1..8]
                 *  so handleEntryKey's ArrowUp/Down/Enter walk maps cell-
                 *  position to ref.
                 *
                 *  Mode-aware visibility: when the GLOBAL setting is
                 *  'single', variant-only fields hide ALWAYS (regardless
                 *  of which product is picked on the line). The entry
                 *  row is shaped by the firm's mode, not the catalog
                 *  row's mode — operators in single mode never see
                 *  variant fields, even if a leftover variant product
                 *  gets picked (its size/article/sale/mrp/gst are read
                 *  silently from products.* on save). */}
                {[
                  {lbl2:'Size',    ref:sizeRef,    field:'size',             val:entry.size,                        idx:1, t:'txt', variantOnly:true},
                  {lbl2:'Art #',   ref:articleRef, field:'article_number',   val:entry.article_number,              idx:2, t:'txt', wrapRef:articleWrapRef,
                   onChangeFn:e=>handleArticleChange(e.target.value), variantOnly:true},
                  {lbl2:'Qty',     ref:qtyRef,     field:'quantity',         val:entry.quantity||undefined,         idx:3, t:'num', min:0},
                  {lbl2:'Rate ₹',  ref:rateRef,    field:'purchase_rate',    val:entry.purchase_rate||undefined,    idx:4, t:'num', min:0, onBlur:handleRateBlur,
                   wrapRef:rateWrapRef, onChangeFn:v=>handleRateInputChange(v||0)},
                  {lbl2:'P/Box',   ref:qpbRef,     field:'quantity_per_box', val:entry.quantity_per_box||undefined, idx:5, t:'num', min:1, onBlur:handleRateBlur, variantOnly:true},
                  {lbl2:'Margin%', ref:marginRef,  field:'margin_percentage',val:entry.margin_percentage||undefined,idx:6, t:'num', variantOnly:true},
                  {lbl2:'Sale ₹',  ref:saleRateRef,field:'sale_rate',        val:entry.sale_rate||undefined,        idx:7, t:'num', min:0, onBlur:handleRateBlur, variantOnly:true},
                  {lbl2:'GST%',    ref:gstRef,     field:'gst_rate',         val:entry.gst_rate||undefined,         idx:8, t:'num', min:0, variantOnly:true},
                ].filter(f => !(f.variantOnly && globalProductMode === 'single'))
                 .map(({lbl2,ref,field,val,idx,t,min,onBlur,wrapRef,onChangeFn,onFocusFn})=>(
                  <div key={field} className={`pbf-cell ${t==='num'?'numeric':''}`} ref={wrapRef||undefined}>
                    <div className="pbf-cell-lbl">{lbl2}</div>
                    {t==='txt'
                      ? <Input ref={ref} value={val} placeholder=""
                          onChange={onChangeFn||(e=>updateEntry(field,e.target.value))}
                          onKeyDown={e=>handleEntryKey(e,idx)} onBlur={onBlur}/>
                      : <InputNumber keyboard={false} ref={ref} value={val} style={{width:'100%'}} min={min} placeholder=""
                          onChange={onChangeFn||(v=>updateEntry(field,v||0))}
                          onKeyDown={e=>handleEntryKey(e,idx)} onBlur={onBlur} onFocus={onFocusFn}/>
                    }
                  </div>
                ))}
                {/* Variant picker — rendered via portal so no ancestor CSS
                    can hide it. Anchors off articleWrapRef / rateWrapRef
                    which still attach to the same cells via wrapRef above. */}
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
                {/* Batch fields — inline in the entry row whenever the
                    global batch_tracking_enabled toggle is on. Per
                    operator request, the strip is ALWAYS visible (not
                    gated on the picked product's is_batch_tracked) so
                    operators can type Lot first and pick the product
                    afterwards if they prefer. The save path still
                    respects per-product is_batch_tracked: lines for
                    non-batch products simply ignore the batch fields.
                    Keyboard nav: GST% → Lot → Mfg → Exp → Notes → ADD
                    via Tab/Enter/Arrow (refs idx 9-12 in entryRefs).
                    DD/MM/YYYY format on dates so typing is unambiguous
                    (Y2 short-year would silently truncate "2026" to
                    "26" and back to "1926" on parse).  */}
                {batchTrackingEnabled && (
                  <>
                    <div className="pbf-cell">
                      <div className="pbf-cell-lbl">Lot{entry.is_batch_tracked ? ' *' : ''}</div>
                      <Input ref={batchNumRef} value={entry.batch_number}
                        placeholder="Lot-2401"
                        onChange={e=>setEntry(p=>({...p,batch_number:e.target.value}))}
                        onKeyDown={e=>handleEntryKey(e,9)}/>
                    </div>
                    <div className="pbf-cell">
                      <div className="pbf-cell-lbl">Mfg</div>
                      <DatePicker ref={mfgRef}
                        value={entry.manufacture_date?dayjs(entry.manufacture_date):null}
                        format={['DD/MM/YYYY','DD-MM-YYYY','D/M/YYYY','D-M-YYYY']}
                        onChange={d=>setEntry(p=>({...p,manufacture_date:d?d.format('YYYY-MM-DD'):null}))}
                        onKeyDown={e=>handleEntryKey(e,10)}
                        style={{width:'100%'}} allowClear inputReadOnly={false}/>
                    </div>
                    <div className="pbf-cell">
                      <div className="pbf-cell-lbl">Exp</div>
                      <DatePicker ref={expRef}
                        value={entry.expiry_date?dayjs(entry.expiry_date):null}
                        format={['DD/MM/YYYY','DD-MM-YYYY','D/M/YYYY','D-M-YYYY']}
                        onChange={d=>setEntry(p=>({...p,expiry_date:d?d.format('YYYY-MM-DD'):null}))}
                        onKeyDown={e=>handleEntryKey(e,11)}
                        style={{width:'100%'}} allowClear inputReadOnly={false}/>
                    </div>
                    <div className="pbf-cell">
                      <div className="pbf-cell-lbl">Notes</div>
                      <Input ref={batchNotesRef} value={entry.batch_notes}
                        placeholder="Optional"
                        onChange={e=>setEntry(p=>({...p,batch_notes:e.target.value}))}
                        onKeyDown={e=>handleEntryKey(e,12)}/>
                    </div>
                  </>
                )}
                <button className="pbf-cell add" onClick={addItem} type="button">
                  <span className="pbf-cell-add-text">ADD</span>
                </button>
              </div>
            </div>
            )}

            {/* Lookup status chip — sits under the entry row */}
            {billMode === 'item' && (lookupLoading || entry.product_name) && (
              <div style={{marginTop:6,display:'flex',justifyContent:'flex-end'}}>
                {lookupLoading && entry.product_name &&
                  <span className="pbf-entry-chip info">⏳ Checking variant…</span>}
                {!lookupLoading && entry.product_id &&
                  <span className="pbf-entry-chip ok">✓ Existing product</span>}
                {!lookupLoading && !entry.product_id && entry.product_name &&
                  <span className="pbf-entry-chip warn">＋ New barcode will be created</span>}
              </div>
            )}

            {/* Batch fields are now INLINE inside the entry-grid above
                (Batch / Mfg / Exp cells). The previous second-line
                strip wasted vertical space and broke the "type, type,
                type, ADD" rhythm — operators were asking to keep the
                whole entry on one row. The optional `batch_notes`
                field stays accessible via the items-table edit path
                (rare-enough that it doesn't earn a permanent slot in
                the entry row). */}

            {/* Amount-only entry panel — single synthetic line for service /
                freight / on-account purchases. Mirrors SalesBillForm. */}
            {billMode === 'amount' && (
              <div className="pbf-amount-panel" style={{
                margin: '10px 0 4px', padding: '18px 20px',
                background: 'rgba(99, 102, 241, .06)',
                border: '1px solid rgba(99, 102, 241, .20)',
                borderRadius: 10,
                display: 'grid',
                gridTemplateColumns: '2fr 1fr 1fr 1fr',
                gap: 14, alignItems: 'end',
              }}>
                <div style={{display:'flex',flexDirection:'column',gap:4}}>
                  <label style={{fontSize:11,color:'var(--fg-tertiary)',letterSpacing:'.04em',textTransform:'uppercase',fontWeight:600}}>Description</label>
                  <Input value={amountDesc}
                    onChange={e=>setAmountDesc(e.target.value)}
                    placeholder="Service / freight / labour charge..."
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
           Always render the section so the page-grid's flex row stays
           occupied — otherwise the bottom totals/payment cards collapse
           upward in Amount mode. The table itself is only mounted in Items mode. */}
        <section className="pbf-mid">
          {billMode === 'item' && (
            <div className="pbf-mid-card">
              <div ref={tableWrapRef} className="pbf-tbl-wrap">
                <Table
                  columns={itemColumns} dataSource={items} rowKey="key"
                  size="small" pagination={false} loading={pageLoading}
                  scroll={items.length?{x:1176,y:tblHeight}:{y:tblHeight}}
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
        <section className="pbf-bottom">
          <div className="pbf-bottom-inner">

            {/* LEFT: Summary + Notes */}
            <div className="pbf-bb-left">
              <div className="pbf-card pbf-summary">
                <div className="pbf-counters">
                  <div className="pbf-counter items">
                    <div className="k">Items</div>
                    <div className="v">{items.length}</div>
                  </div>
                  <div className="pbf-counter qty">
                    <div className="k">Qty</div>
                    <div className="v">{items.reduce((s,i)=>s+(i.quantity||0),0).toFixed(1)}</div>
                  </div>
                  <div className="pbf-counter box">
                    <div className="k">Box</div>
                    <div className="v">{boxQty.toFixed(1)}</div>
                  </div>
                </div>
                <div className="pbf-summary-notes">
                  <span className="pbf-lbl">Notes</span>
                  <Form.Item name="remarks" noStyle>
                    <Input.TextArea
                      rows={5}
                      maxLength={1000}
                      placeholder="Add remarks, delivery instructions, reference…"
                      className="pbf-notes-ta"
                    />
                  </Form.Item>
                </div>
              </div>
            </div>

            {/* RIGHT: Totals + Payment */}
            <div className="pbf-bb-right">

              {/* Totals card — 6 rows matching Payment height.
                    CGST+SGST merged into a single shared % (always equal in
                    intra-state GST). Other + Freight merged into one row. */}
              <div className="pbf-card pbf-totals">
                <div className="pbf-tot-lines">
                  <div className="pbf-tot-line total-row">
                    <span className="k">Total</span>
                    <span className="pbf-val-box">{fmtN(taxableTotal)}</span>
                  </div>
                  <div className="pbf-tot-line with-pct">
                    <span className="k" title="Combined CGST + SGST rate. Typed value is split half/half into the two columns on save.">GST (C+S)</span>
                    <InputNumber keyboard={false} size="small" min={0} max={100}
                      className="pbf-pct-in" style={{width:'100%'}}
                      // Show COMBINED rate (5%) not just CGST half (2.5%)
                      // so label and amount column agree — see SalesBillForm
                      // comment for the full rationale.
                      value={(effCgstPct + effSgstPct)||undefined} disabled={gstMode==='product'}
                      onChange={v=>{ const half = (v||0) / 2; setCgstPct(half); setSgstPct(half); }}
                      formatter={v=>v?`${v}%`:''} parser={v=>v?.replace('%','')||''}
                      placeholder="%"/>
                    <span className="pbf-val-box">{fmtN(cgst + sgst)}</span>
                  </div>
                  <div className="pbf-tot-line with-pct">
                    <span className="k">IGST</span>
                    <InputNumber keyboard={false} size="small" min={0} max={100}
                      className="pbf-pct-in" style={{width:'100%'}}
                      value={igstPct||undefined} disabled={gstMode==='product'}
                      onChange={v=>setIgstPct(v||0)}
                      formatter={v=>v?`${v}%`:''} parser={v=>v?.replace('%','')||''}
                      placeholder="%"/>
                    <span className="pbf-val-box">{fmtN(igstAmt)}</span>
                  </div>
                  <div className="pbf-tot-line gst-total">
                    <span className="k">Total GST</span>
                    <span className="pbf-val-box gst-val">{fmtN(totalGST)}</span>
                  </div>
                  <div className="pbf-tot-line extras">
                    <span className="k">Extras</span>
                    <Form.Item name="other_charges" noStyle>
                      <InputNumber keyboard={false} size="small" min={0} placeholder="Other"
                        className="pbf-amt-in" style={{width:'100%'}}/>
                    </Form.Item>
                    <Form.Item name="freight_charges" noStyle>
                      <InputNumber keyboard={false} size="small" min={0} placeholder="Freight"
                        className="pbf-amt-in" style={{width:'100%'}}/>
                    </Form.Item>
                  </div>
                  <div className="pbf-tot-line with-pct">
                    <span className="k">Bill Disc</span>
                    <Form.Item name="discount_percentage" noStyle>
                      <InputNumber keyboard={false} size="small" min={0} max={100} placeholder="%"
                        className="pbf-pct-in" style={{width:'100%'}}
                        formatter={v=>v?`${v}%`:''} parser={v=>v?.replace('%','')||''}
                        onChange={pct=>{
                          discAmtEditingRef.current=false;
                          setDiscAmtVal(+(subTotal*(pct||0)/100).toFixed(2));
                        }}/>
                    </Form.Item>
                    <InputNumber keyboard={false} size="small" min={0} placeholder="₹ amt"
                      className="pbf-amt-in" style={{width:'100%'}}
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
              <div className="pbf-card pbf-payment">
                <div className="pbf-net-hero">
                  <span className="k">Net total ₹</span>
                  <span className="v">{roundedTotal.toLocaleString('en-IN')}</span>
                </div>

                <div className="pbf-pay-line">
                  <span className="k">Amt paid</span>
                  <Form.Item name="paid_amount" noStyle>
                    <InputNumber ref={paidInputRef} keyboard={false} min={0} max={roundedTotal} placeholder="0.00"
                      style={{width:'100%'}}/>
                  </Form.Item>
                </div>

                <div className={`pbf-status ${statusClass}`}>
                  <span className="k">{statusLabel}</span>
                  <span className="v">{fmtN(Math.abs(balance))}</span>
                </div>
              </div>

            </div>
          </div>
        </section>

        {/* ═══════════════════════════════ (4) ACTION STRIP ════════════════════
            Same Tally-style strip as the Sales Bill Form. Single
            registry drives both the visible buttons and the keyboard
            bindings. F1 Save & Print opens the barcode-label modal
            after save (matches the legacy "Save & Pay" behavior).
            F2 Save skips the modal. Payment status is driven by what
            the operator types in the Payment Card. */}
        <ActionStrip
          actions={[
            { id: 'back', key: 'Esc', label: 'Back',
              onAction: () => confirmLeave(() => navigate('/purchases')) },
            { id: 'date', key: 'F2', label: 'Date',
              onAction: f2DatePopup,
              title: 'Open the smart-input date popup' },
            { id: 'reset', key: 'F5', label: 'Reset',
              onAction: handleReset },
            { id: 'hold', key: 'F4', label: recalledDraftId ? 'Update Hold' : 'Hold',
              hidden: isEdit, disabled: holdLoading,
              onAction: handleHold,
              title: 'Save as draft to resume later' },
            { id: 'drafts', key: 'Ctrl+L', label: 'Drafts',
              hidden: isEdit,
              badge: drafts.length > 0 ? drafts.length : null,
              onAction: () => { loadDrafts(); setDraftsModalOpen(true); },
              title: 'View held purchase drafts' },
            { id: 'jump-items', key: 'F3', label: 'Items',
              onAction: toggleBarcodeItems,
              title: 'Toggle focus between Barcode and the items table' },
            { id: 'jump-pay', key: 'F6', label: 'Pay',
              onAction: jumpToPaymentCard,
              title: 'Jump to Amount Paid' },
            { id: 'print-edit', key: 'F9', label: 'Print',
              hidden: !isEdit,
              onAction: () => printDocument({ docType: 'purchase', id }) },
            { id: 'save', key: 'F1', label: 'Save', tone: 'primary',
              disabled: loading,
              onAction: handleSaveWithPrintPrompt,
              title: 'Save the bill — prompts to print barcode labels after success' },
            // Hidden alias: Ctrl+Enter mirrors F1.
            { id: 'save-alt', key: 'Ctrl+Enter', label: '',
              hidden: true, disabled: loading,
              onAction: handleSaveWithPrintPrompt },
          ]}
        />

      </div>

      {/* In-form Drafts modal — Recall replays into THIS form (no route
          change) so the operator stays in their billing flow. */}
      <Modal
        open={draftsModalOpen}
        onCancel={() => setDraftsModalOpen(false)}
        title={
          <div className="pbf-drafts-title">
            <span className="pbf-pill"><span className="dot"></span>Drafts</span>
            <span className="pbf-drafts-count">{drafts.length} held</span>
          </div>
        }
        footer={null}
        width="min(96vw, 1100px)"
        zIndex={1100}
        className="pbf-drafts-modal"
        styles={{ body: { padding: 0 } }}
      >
        {drafts.length === 0 ? (
          <div className="pbf-drafts-empty">
            <div className="pbf-drafts-empty-icon">📋</div>
            <div className="pbf-drafts-empty-main">No drafts held</div>
          </div>
        ) : (
          <div className="pbf-drafts-table">
            <div className="pbf-drafts-thead">
              <span className="c-date">Date</span>
              <span className="c-cust">Supplier</span>
              <span className="c-qty">Qty</span>
              <span className="c-tot">Total</span>
              <span className="c-user">User</span>
              <span className="c-sm">Bill #</span>
              <span className="c-act"></span>
            </div>
            <div className="pbf-drafts-tbody">
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
                    className={`pbf-drafts-tr ${isSelected ? 'is-selected' : ''}`}
                    onClick={() => setSelectedDraftIdx(i)}
                    onDoubleClick={() => handleRecallDraft(d)}
                  >
                    <span className="c-date">
                      <span className="c-date-d">{dateObj.format('DD MMM YYYY')}</span>
                      <span className="c-date-t">{dateObj.format('HH:mm')}</span>
                    </span>
                    <span className="c-cust">
                      {d.supplier?.party_name || <span className="walk-in">No supplier</span>}
                      {isAmount && <span className="pbf-drafts-mode-tag amount">Amount</span>}
                    </span>
                    <span className="c-qty">{isAmount ? '—' : (totalQty % 1 === 0 ? totalQty : totalQty.toFixed(1))}</span>
                    <span className="c-tot">
                      ₹{parseFloat(d.total_preview || 0).toLocaleString('en-IN', { minimumFractionDigits: 2 })}
                    </span>
                    <span className="c-user">{d.creator?.username || '—'}</span>
                    <span className="c-sm">{d.payload?.supplier_bill_number || '—'}</span>
                    <span className="c-act">
                      <button
                        className="pbf-drafts-btn recall"
                        onClick={(e) => { e.stopPropagation(); handleRecallDraft(d); }}>
                        <span className="pbf-drafts-btn-ico" aria-hidden>↩</span>
                        <span>Recall</span>
                      </button>
                      <button
                        className="pbf-drafts-btn discard"
                        title="Discard draft"
                        onClick={(e) => {
                          e.stopPropagation();
                          Modal.confirm({
                            title: `Discard ${d.draft_number}?`,
                            content: 'This permanently deletes the draft. Cannot be undone.',
                            okText: 'Discard', okType: 'danger',
                            onOk: async () => {
                              try {
                                await purchaseDraftAPI.delete(d.draft_id);
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

      <BarcodePrintModal
        visible={printModal.visible}
        onClose={()=>{
          setPrintModal({visible:false,bill:null});
          if(isEdit){ navigate('/purchases'); }
          else { handleReset(); setBillNumber(''); }
        }}
        billNumber={printModal.bill?.bill_number}
        items={printModal.bill?.printItems||[]}
        initialCompany={companyName}
      />

      {/* +Add Product shortcut — opens the existing Add Product form
          (shared component, same UX as Inventory → Products → Add).
          On successful save we (a) invalidate the family cache so a
          re-search picks up the fresh product, and (b) auto-select the
          new product onto the entry row that triggered the modal.
          Without (b), single-mode users got duplicates: the entry row
          stayed product_id=null, the qty/rate they typed flowed into
          a save, and the controller's auto-create-from-purchase path
          spun up a SECOND product with sale_rate auto-filled from
          purchase_rate. The auto-select now mirrors a dropdown pick
          (handleProductSelect) — same identity binding, same focus
          jump to qty — so the operator's next keystroke goes into the
          quantity field, not into a new fingerprint. Cancel still
          leaves the entry row untouched (no setState fires there). */}
      <ProductFormModal
        open={addProductModalOpen}
        onCancel={() => setAddProductModalOpen(false)}
        onSaved={(p) => {
          setAddProductModalOpen(false);
          invalidateFamilyCache();
          if (p) {
            // Re-run any in-flight product search so the new name
            // appears in the dropdown if the operator pulls it down.
            if (p.product_name) handleProductSearch(p.product_name);
            // Auto-select onto the entry row. We deliberately set ONLY
            // the identity + meta fields the dropdown-pick path sets;
            // qty / purchase_rate / margin already typed by the user
            // are preserved. is_batch_tracked + product_mode flow
            // through so the row's mode-aware filter and the batch
            // strip render correctly without a refetch.
            setEntry((prev) => ({
              ...prev,
              product_id: p.product_id,
              barcode: p.barcode || '',
              product_name: p.product_name,
              category_id: p.category_id || prev.category_id,
              category_name: p.Category?.category_name || prev.category_name,
              size: p.size_value || '',
              article_number: p.article_number || '',
              hsn_code: p.hsn_code || '',
              gst_rate: parseFloat(p.gst_rate) || 0,
              quantity_per_box: parseFloat(p.quantity_per_box) || 1,
              mrp: parseFloat(p.mrp) || prev.mrp || 0,
              sale_rate: parseFloat(p.sale_rate) || prev.sale_rate || 0,
              margin_percentage: parseFloat(p.margin_percentage) || prev.margin_percentage || 0,
              is_batch_tracked: !!p.is_batch_tracked,
              product_mode: p.product_mode || prev.product_mode || 'variant',
            }));
            setBarcodeError('');
            // Same focus contract as handleProductSelect's single-mode
            // branch — operator's next keystroke is qty.
            justSelectedRef.current = true;
            requestAnimationFrame(() => {
              productRef.current?.blur(); qtyRef.current?.focus(); qtyRef.current?.select?.();
            });
            setTimeout(() => { justSelectedRef.current = false; }, 250);
          }
        }}
        defaultName={entry.product_name || ''}
      />
    </Form>
  );
}
