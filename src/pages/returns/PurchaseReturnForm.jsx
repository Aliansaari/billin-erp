import React, { useState, useRef, useEffect, useLayoutEffect, useCallback } from 'react';
import { Form, Input, DatePicker, Select, InputNumber, Table, Modal, message, Popover, Checkbox } from 'antd';
import { SettingOutlined } from '@ant-design/icons';
import { useNavigate, useParams } from 'react-router-dom';
import dayjs from 'dayjs';
import {
  purchaseReturnAPI, purchaseAPI, partyAPI, productAPI, categoryAPI, settingsAPI, godownAPI,
} from '../../api';
import { useUnsavedChangesWarning } from '../../hooks/useUnsavedChangesWarning';
import { useMultiWarehouseEnabled } from '../../hooks/useSystemSettings';
import { useFiscalLockGuard, isFiscalLockCancel } from '../../hooks/useFiscalLockGuard';
import { printDocument } from '../../services/printer';
import ActionStrip from '../../components/keyboard/ActionStrip';
import { useDatePopup } from '../../components/keyboard/DatePopup';
import FiscalLockOverrideModal from '../../components/FiscalLockOverrideModal';
import confirmPrint from '../../utils/confirmPrint';
import './return-form.css';

const fmtN = (v) => parseFloat(v || 0).toLocaleString('en-IN', { minimumFractionDigits: 2 });

const UNITS     = ['Pcs','Box','Set','Pair','Dozen','Mtr','Roll','Lot'];
const PAY_MODES = ['Cash','Card','UPI','Bank Transfer','Cheque','Debit Note'];
const EMPTY_ENTRY = {
  barcode: '', category_id: null, category_name: '', product_name: '', size: '',
  article_number: '', rate: 0, quantity: 0, discount_percentage: 0,
  hsn_code: '', gst_rate: 0, product_id: null, mrp: 0,
  unit_type: 'Pcs', quantity_per_box: 1,
};

/* ════════════════════════════════════════════════════════════════════════════
 *  PurchaseReturnForm — debit note (goods returned to supplier).
 *
 *  Mirror of SalesReturnForm but on the supplier side:
 *    · "rate" comes from Product.purchase_rate, not sale_rate
 *    · reference bill picker lists purchase bills for the chosen supplier
 *    · reducing stock below zero is blocked in the controller when
 *      allow_negative_stock is off
 *
 *  Shares return-form.css with SalesReturnForm — same crimson accent so the
 *  operator recognises any "return" document at a glance.
 * ═══════════════════════════════════════════════════════════════════════════ */
export default function PurchaseReturnForm() {
  const navigate = useNavigate();
  const { id } = useParams();
  const isEdit = Boolean(id);

  const [form]                    = Form.useForm();
  const [items, setItems]         = useState([]);
  const [parties, setParties]     = useState([]);
  // Multi-warehouse master toggle — see PurchaseBillForm for the rationale.
  const multiWarehouseOn          = useMultiWarehouseEnabled();
  const [godowns, setGodowns]     = useState([]);  // godowns the operator can return from
  const [cats, setCats]           = useState([]);
  const [loading, setLoading]     = useState(false);
  const [pgLoading, setPgLoading] = useState(false);
  const [entry, setEntry]         = useState(EMPTY_ENTRY);
  const [prodOpts, setProdOpts]   = useState([]);
  const [company, setCompany]     = useState('');
  const [returnNo, setReturnNo]   = useState('');

  // Items table column visibility — Customize popover writes to this
  // Set, persists to localStorage. Required columns pinned on.
  const PRF_COL_DEFAULTS = ['barcode','size','unit','article','disc_pct','gst_pct'];
  const [prfVisibleCols, setPrfVisibleCols] = useState(() => {
    try {
      const raw = localStorage.getItem('prf_visible_cols');
      if (raw) return new Set(JSON.parse(raw));
    } catch {}
    return new Set(PRF_COL_DEFAULTS);
  });
  const togglePrfCol = (key) => {
    setPrfVisibleCols(prev => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key); else next.add(key);
      try { localStorage.setItem('prf_visible_cols', JSON.stringify([...next])); } catch {}
      return next;
    });
  };
  const [gstMode]                 = useState(() => localStorage.getItem('gst_mode') || 'product');
  const [cgstPct, setCgstPct]     = useState(0);
  const [sgstPct, setSgstPct]     = useState(0);
  const [igstPct, setIgstPct]     = useState(0);
  const [selectedParty, setSelectedParty] = useState(null);
  const [discAmtVal, setDiscAmtVal]       = useState(0);
  const discAmtEditingRef                 = useRef(false);
  const submittingRef                     = useRef(false);
  const nextKeyRef                        = useRef(1);

  const [returnMode, setReturnMode]       = useState('Items');
  const [amountOnly, setAmountOnly]       = useState(0);
  const [refBill, setRefBill]             = useState(null);
  const [refPickerOpen, setRefPickerOpen] = useState(false);
  const [refBills, setRefBills]           = useState([]);
  const [refSearch, setRefSearch]         = useState('');
  const [refLoading, setRefLoading]       = useState(false);

  const [activeCatId, setActiveCatId] = useState(null);
  const [prodOpen, setProdOpen]       = useState(false);
  const searchTimerRef  = useRef(null);
  const searchReqRef    = useRef(0);
  const justSelectedRef = useRef(false);
  const barcodeRef      = useRef(null);
  const prodRef         = useRef(null);
  const sizeRef         = useRef(null);
  const rateRef         = useRef(null);
  const qtyRef          = useRef(null);
  const discRef         = useRef(null);
  const gstRef          = useRef(null);
  const tableWrapRef    = useRef(null);
  const amountOnlyRef   = useRef(null);
  // F6 = Jump to Refund ₹ input.
  const refundInputRef  = useRef(null);
  const [tblHeight, setTblHeight] = useState(300);
  const eRefs = [prodRef, sizeRef, rateRef, qtyRef, discRef, gstRef];

  useLayoutEffect(() => {
    const el = tableWrapRef.current;
    if (!el) return;
    setTblHeight(Math.max(100, el.clientHeight - 40));
    const ro = new ResizeObserver(([e]) => setTblHeight(Math.max(100, e.contentRect.height - 40)));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  useEffect(() => {
    if (!activeCatId) { setProdOpts([]); return; }
    let cancelled = false;
    productAPI.search('', { category_id: activeCatId, name_only: 'true' })
      .then(({ data }) => {
        if (cancelled) return;
        setProdOpts(data.data || []);
        setTimeout(() => { prodRef.current?.focus(); setProdOpen(true); }, 30);
      })
      .catch(() => { if (!cancelled) setProdOpts([]); });
    return () => { cancelled = true; };
  }, [activeCatId]);

  useEffect(() => {
    partyAPI.getSuppliers({ limit: 1000 })
      .then(({ data }) => setParties((data.data || []).filter((p) => p.is_active !== false)))
      .catch(() => {});
    categoryAPI.getAllFlat().then(({ data }) => setCats(data || [])).catch(() => {});
    settingsAPI.getSystem().then(({ data }) => setCompany(data?.data?.company_name || '')).catch(() => {});
    godownAPI.getAll().then(({ data }) => {
      const list = (data || []).filter((g) => g.is_active);
      const userAllowed = (() => {
        try {
          const u = JSON.parse(localStorage.getItem('user') || 'null');
          return Array.isArray(u?.allowed_godowns) ? u.allowed_godowns : null;
        } catch { return null; }
      })();
      const filtered = userAllowed ? list.filter((g) => userAllowed.includes(g.godown_id)) : list;
      setGodowns(filtered);
      if (!isEdit && !form.getFieldValue('godown_id')) {
        const def = filtered.find((g) => g.is_default) || filtered[0];
        if (def) form.setFieldsValue({ godown_id: def.godown_id });
      }
    }).catch(() => {});
    if (isEdit) loadReturn(id);
    else {
      form.setFieldsValue({ return_date: dayjs(), refund_method: 'Cash' });
      setTimeout(() => barcodeRef.current?.focus(), 100);
    }
  }, [id]);

  const loadReturn = async (bid) => {
    setPgLoading(true);
    try {
      const { data } = await purchaseReturnAPI.getById(bid);
      setReturnNo(data.return_number || '');
      setReturnMode(data.return_mode || 'Items');
      form.setFieldsValue({
        godown_id: data.godown_id,
        supplier_id: data.supplier_id,
        return_date: data.return_date ? dayjs(data.return_date) : dayjs(),
        discount_percentage: parseFloat(data.discount_percentage) || 0,
        refund_amount: parseFloat(data.refund_amount) || 0,
        other_charges: parseFloat(data.other_charges) || 0,
        freight_charges: parseFloat(data.freight_charges) || 0,
        reason: data.reason || '',
        refund_method: data.refund_method || 'Cash',
        remarks: data.remarks || '',
      });
      setCgstPct(parseFloat(data.cgst_pct) || 0);
      setSgstPct(parseFloat(data.sgst_pct) || 0);
      setIgstPct(parseFloat(data.igst_pct) || 0);
      setDiscAmtVal(parseFloat(data.discount_amount) || 0);
      if (data.reference_bill_id) {
        setRefBill({
          purchase_bill_id: data.reference_bill_id,
          bill_number: data.reference_bill_number,
        });
      }
      if (data.return_mode === 'Amount') {
        setAmountOnly(parseFloat(data.total_amount) || 0);
        setItems([]);
      } else {
        const loaded = (data.items || []).map((it, i) => ({
          key: it.item_id || i,
          item_id: it.item_id,
          product_id: it.product_id, barcode: it.barcode || '',
          category_id: it.category_id, category_name: it.category_name || '',
          product_name: it.product_name || '', size: it.size || '',
          article_number: it.article_number || '', unit_type: it.unit_type || 'Pcs',
          rate: parseFloat(it.rate) || 0, quantity: parseFloat(it.quantity) || 0,
          quantity_per_box: parseFloat(it.quantity_per_box) || 1,
          discount_percentage: parseFloat(it.discount_percentage) || 0,
          discount_amount: parseFloat(it.discount_amount) || 0,
          total_amount: parseFloat(it.total_amount) || 0,
          mrp: parseFloat(it.mrp) || 0, hsn_code: it.hsn_code || '',
          gst_rate: parseFloat(it.gst_rate) || 0,
          original_item_id: it.original_item_id || null,
        }));
        const maxK = loaded.reduce((m, it) => Math.max(m, it.key || 0), 0);
        nextKeyRef.current = maxK + 1;
        setItems(loaded);
      }
    } catch {
      message.error('Failed to load return');
      navigate('/purchase-returns');
    } finally {
      setPgLoading(false);
    }
  };

  const updateItem = (key, field, value) => {
    setItems((prev) => prev.map((it) => {
      if (it.key !== key) return it;
      const u = { ...it, [field]: value };
      const lt = (u.quantity || 0) * (u.rate || 0);
      u.discount_amount = +(lt * (u.discount_percentage || 0) / 100).toFixed(2);
      u.total_amount = +(lt - u.discount_amount).toFixed(2);
      return u;
    }));
  };

  const navTbl = (e, ri, ci) => {
    if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return;
    e.preventDefault();
    const nr = e.key === 'ArrowDown' ? Math.min(ri + 1, items.length - 1) : Math.max(ri - 1, 0);
    if (nr === ri) return;
    const cell = document.getElementById(`sc-${nr}-${ci}`);
    if (cell) { const inp = cell.querySelector('input'); inp?.focus(); inp?.select?.(); }
  };

  const handleScan = async (barcode) => {
    if (!barcode?.trim()) return;
    const code = barcode.trim();
    setEntry(EMPTY_ENTRY);
    if (barcodeRef.current?.input) barcodeRef.current.input.value = '';
    barcodeRef.current?.focus();
    try {
      const { data } = await productAPI.getByBarcode(code);
      const rate = parseFloat(data.purchase_rate) || 0;
      const gst = parseFloat(data.gst_rate) || 0;
      const qty = parseFloat(data.quantity_per_box) || 1;
      const unitType = qty > 1 ? 'Box' : 'Pcs';
      const lt = +(qty * rate).toFixed(2);
      setItems((prev) => [...prev, {
        key: nextKeyRef.current++,
        product_id: data.product_id, barcode: data.barcode,
        category_id: data.category_id, category_name: data.Category?.category_name || '',
        product_name: data.product_name, size: data.size_value || '',
        article_number: data.article_number || '', unit_type: unitType,
        rate, quantity: qty, quantity_per_box: parseFloat(data.quantity_per_box) || 1,
        discount_percentage: 0, discount_amount: 0,
        total_amount: lt, mrp: parseFloat(data.mrp) || 0,
        hsn_code: data.hsn_code || '', gst_rate: gst,
      }]);
      message.success(`${data.product_name} added to return`, 1);
    } catch {
      message.warning('Product not found');
    }
  };

  const handleProdSearch = useCallback((v) => {
    if (searchTimerRef.current) clearTimeout(searchTimerRef.current);
    if (!v) { if (!activeCatId) setProdOpts([]); return; }
    searchTimerRef.current = setTimeout(async () => {
      const reqId = ++searchReqRef.current;
      try {
        const { data } = await productAPI.search(v, { name_only: 'true', ...(activeCatId ? { category_id: activeCatId } : {}) });
        if (reqId !== searchReqRef.current) return;
        setProdOpts(data.data || []);
      } catch {}
    }, 150);
  }, [activeCatId]);

  const handleProdSel = useCallback((val, opt) => {
    const p = opt?.product;
    if (!p) return;
    const qty = parseFloat(p.quantity_per_box) || 1;
    const unitType = qty > 1 ? 'Box' : 'Pcs';
    setActiveCatId(p.category_id || null);
    setEntry((prev) => ({
      ...prev, product_id: p.product_id, barcode: p.barcode, product_name: p.product_name,
      category_id: p.category_id, category_name: p.Category?.category_name || '',
      size: p.size_value || '', article_number: p.article_number || '',
      rate: parseFloat(p.purchase_rate) || 0, mrp: parseFloat(p.mrp) || 0,
      hsn_code: p.hsn_code || '', gst_rate: parseFloat(p.gst_rate) || 0,
      quantity: qty, unit_type: unitType,
      quantity_per_box: parseFloat(p.quantity_per_box) || 1,
    }));
    justSelectedRef.current = true;
    requestAnimationFrame(() => { prodRef.current?.blur(); qtyRef.current?.focus(); });
  }, []);

  const ue = (f, v) => setEntry((p) => ({ ...p, [f]: v }));

  const eKey = (e, idx) => {
    if (e.key === 'Enter' || e.key === 'ArrowDown') {
      e.preventDefault();
      if (idx >= eRefs.length - 1) { addItem(); }
      else { const n = eRefs[idx + 1]; n?.current?.focus(); n?.current?.select?.(); }
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      if (idx > 0) { const p = eRefs[idx - 1]; p?.current?.focus(); p?.current?.select?.(); }
      else { barcodeRef.current?.focus(); }
    }
  };

  const addItem = useCallback(() => {
    if (!entry.product_name) { message.warning('Enter product name'); return; }
    if (!entry.quantity || entry.quantity <= 0) { message.warning('Enter quantity'); return; }
    if (!entry.rate || entry.rate <= 0) { message.warning('Enter rate'); return; }
    const lt = +(entry.quantity * entry.rate).toFixed(2);
    const da = +(lt * (entry.discount_percentage || 0) / 100).toFixed(2);
    setItems((prev) => [...prev, { ...entry, key: nextKeyRef.current++, total_amount: lt - da, discount_amount: da }]);
    setActiveCatId(null);
    setProdOpen(false);
    setEntry(EMPTY_ENTRY);
    setTimeout(() => barcodeRef.current?.focus(), 50);
  }, [entry]);

  const removeItem = (key) => setItems((prev) => prev.filter((i) => i.key !== key));

  const openRefPicker = async () => {
    const supplierId = form.getFieldValue('supplier_id');
    setRefPickerOpen(true);
    setRefLoading(true);
    try {
      const { data } = await purchaseAPI.getAll({ ...(supplierId ? { supplier_id: supplierId } : {}), limit: 200 });
      setRefBills(data.data || []);
    } catch {
      setRefBills([]);
    } finally {
      setRefLoading(false);
    }
  };

  const pickReferenceBill = async (bill) => {
    setRefPickerOpen(false);
    setRefLoading(true);
    try {
      const { data } = await purchaseReturnAPI.getReferenceBill(bill.purchase_bill_id);
      setRefBill({
        purchase_bill_id: data.purchase_bill_id,
        bill_number: data.bill_number,
        bill_date: data.bill_date,
        total_amount: data.total_amount,
      });
      form.setFieldValue('supplier_id', data.supplier_id);
      setCgstPct(parseFloat(data.cgst_pct) || 0);
      setSgstPct(parseFloat(data.sgst_pct) || 0);
      setIgstPct(parseFloat(data.igst_pct) || 0);
      const loaded = (data.items || []).map((it, i) => ({
        key: nextKeyRef.current++,
        product_id: it.product_id, barcode: it.barcode || '',
        category_id: it.category_id, category_name: it.category_name || '',
        product_name: it.product_name || '', size: it.size || '',
        article_number: it.article_number || '',
        unit_type: 'Pcs',
        rate: parseFloat(it.purchase_rate) || 0, quantity: parseFloat(it.quantity) || 0,
        quantity_per_box: parseFloat(it.quantity_per_box) || 1,
        discount_percentage: parseFloat(it.discount_percentage) || 0,
        discount_amount: parseFloat(it.discount_amount) || 0,
        total_amount: parseFloat(it.total_amount) || 0,
        mrp: parseFloat(it.mrp) || 0, hsn_code: it.hsn_code || '',
        gst_rate: parseFloat(it.gst_rate) || 0,
        original_item_id: it.item_id,
      }));
      setItems(loaded);
      message.success(`Loaded ${loaded.length} items from ${data.bill_number}`);
    } catch (e) {
      message.error(e.response?.data?.error || 'Failed to load bill');
    } finally {
      setRefLoading(false);
    }
  };

  const clearReference = () => setRefBill(null);

  const discPct    = Form.useWatch('discount_percentage', form) || 0;
  const refundAmt  = Form.useWatch('refund_amount', form) || 0;
  const otherChr   = Form.useWatch('other_charges', form) || 0;
  const freightChr = Form.useWatch('freight_charges', form) || 0;
  const supplierId = Form.useWatch('supplier_id', form);

  const subTotal    = returnMode === 'Amount'
    ? +(parseFloat(amountOnly) || 0).toFixed(2)
    : items.reduce((s, i) => s + (i.quantity || 0) * (i.rate || 0), 0);
  const itemDiscTot = returnMode === 'Amount' ? 0 : items.reduce((s, i) => s + (i.discount_amount || 0), 0);
  const billDiscAmt = returnMode === 'Amount' ? 0 : +(subTotal * discPct / 100).toFixed(2);

  useEffect(() => {
    if (!discAmtEditingRef.current) setDiscAmtVal(billDiscAmt || 0);
  }, [billDiscAmt]);

  const taxableAmt = +(subTotal - itemDiscTot - billDiscAmt).toFixed(2);
  const postItemBase = +(subTotal - itemDiscTot).toFixed(2);
  const billDiscRatio = postItemBase > 0 ? billDiscAmt / postItemBase : 0;
  const productGST = returnMode === 'Amount'
    ? 0
    : +items.reduce((s, i) => {
      const lt = (i.quantity || 0) * (i.rate || 0) - (i.discount_amount || 0);
      const lineTaxable = lt * (1 - billDiscRatio);
      return s + lineTaxable * ((i.gst_rate || 0) / 100);
    }, 0).toFixed(2);
  const effCgstPct = gstMode === 'bill' ? (cgstPct || 0) : (taxableAmt > 0 ? +(productGST / 2 / taxableAmt * 100).toFixed(2) : 0);
  const cgst = gstMode === 'bill' ? +(taxableAmt * (cgstPct || 0) / 100).toFixed(2) : +(productGST / 2).toFixed(2);
  const sgst = gstMode === 'bill' ? +(taxableAmt * (sgstPct || 0) / 100).toFixed(2) : +(productGST / 2).toFixed(2);
  const igstAmt = +(taxableAmt * (igstPct || 0) / 100).toFixed(2);
  const totalGST = +(cgst + sgst + igstAmt).toFixed(2);
  const rawTotal = taxableAmt + totalGST + parseFloat(otherChr || 0) + parseFloat(freightChr || 0);
  const roundedTotal = Math.round(rawTotal);
  const maxRefund = Math.max(0, roundedTotal);
  const balance = +(roundedTotal - Math.min(parseFloat(refundAmt || 0), maxRefund)).toFixed(2);
  const totalQty = items.reduce((s, i) => s + (i.quantity || 0), 0);
  const boxQty = items.reduce((s, i) => {
    const qpb = parseFloat(i.quantity_per_box) || 1;
    return s + (i.quantity || 0) / qpb;
  }, 0);

  const prevItemsLenRef = useRef(0);
  useLayoutEffect(() => {
    const prev = prevItemsLenRef.current;
    prevItemsLenRef.current = items.length;
    if (items.length > prev && items.length > 0) {
      const body = tableWrapRef.current?.querySelector('.ant-table-body');
      if (body) body.scrollTop = body.scrollHeight;
    }
  }, [items.length]);

  useEffect(() => {
    if (supplierId && parties.length) {
      setSelectedParty(parties.find((p) => p.party_id === supplierId) || null);
    } else if (!supplierId) {
      setSelectedParty(null);
    }
  }, [supplierId, parties]);

  // Fiscal-lock override flow for backdated saves.
  // Audit (UI live test) — moved above handleSave so the useCallback
  // dependency array doesn't TDZ-reference `guardedSave` before
  // its const declaration.
  const { lockModal, guardedSave } = useFiscalLockGuard({
    onBlocked: (msg) => message.error(msg),
  });

  /* `markRefunded=true` is the legacy auto-fill path (refund_amount =
     total). The redesigned strip stops passing it. `opts.onSaved`
     fires before navigate/reset so Save & Print can reach the saved
     bill id while the form is still mounted. */
  const handleSave = useCallback(async (markRefunded = false, opts = {}) => {
    if (submittingRef.current) return;
    try {
      const vals = await form.validateFields();
      if (returnMode === 'Items' && items.length === 0) {
        message.warning('Add at least one item or switch to Amount mode');
        return;
      }
      if (returnMode === 'Amount' && (!amountOnly || amountOnly <= 0)) {
        message.warning('Enter a return amount');
        return;
      }
      const refund = markRefunded ? roundedTotal : (parseFloat(vals.refund_amount) || 0);
      if (refund > roundedTotal + 0.01) {
        message.error(`Refund ₹${refund.toFixed(2)} exceeds return total ₹${roundedTotal.toFixed(2)}`);
        return;
      }
      submittingRef.current = true;
      setLoading(true);
      const body = {
        // Source godown — where the goods physically leave from.
        godown_id: vals.godown_id,
        supplier_id: vals.supplier_id,
        return_date: vals.return_date.format('YYYY-MM-DD'),
        reference_bill_id: refBill?.purchase_bill_id || null,
        reference_bill_number: refBill?.bill_number || null,
        return_mode: returnMode,
        reason: vals.reason || null,
        discount_percentage: returnMode === 'Amount' ? 0 : discPct,
        discount_amount: returnMode === 'Amount' ? 0 : billDiscAmt,
        other_charges: parseFloat(otherChr) || 0,
        freight_charges: parseFloat(freightChr) || 0,
        refund_amount: refund,
        refund_method: vals.refund_method || 'Cash',
        remarks: (vals.remarks || '').trim(),
        gst_mode: gstMode,
        cgst_pct: parseFloat(cgstPct) || 0,
        sgst_pct: parseFloat(sgstPct) || 0,
        igst_pct: parseFloat(igstPct) || 0,
        amount_only_total: returnMode === 'Amount' ? parseFloat(amountOnly) || 0 : 0,
        items: returnMode === 'Amount' ? [] : items.map((i) => ({
          product_id: i.product_id,
          original_item_id: i.original_item_id || null,
          barcode: i.barcode,
          category_id: i.category_id, category_name: i.category_name,
          product_name: i.product_name, size: i.size,
          article_number: i.article_number, hsn_code: i.hsn_code,
          unit_type: i.unit_type || 'Pcs',
          quantity: i.quantity, rate: i.rate, mrp: i.mrp,
          discount_percentage: i.discount_percentage, gst_rate: i.gst_rate,
          quantity_per_box: parseFloat(i.quantity_per_box) || 1,
        })),
      };
      const data = await guardedSave(body, (b) => (
        isEdit ? purchaseReturnAPI.update(id, b).then(r => r.data) : purchaseReturnAPI.create(b).then(r => r.data)
      ));
      message.success(`Return ${data.return_number} ${isEdit ? 'updated' : 'saved'}!`);
      if (opts.onSaved) {
        try { opts.onSaved(data); } catch (e) { console.error('[handleSave onSaved]', e); }
      }
      if (isEdit) navigate('/purchase-returns');
      else { handleReset(); setReturnNo(''); }
    } catch (e) {
      if (!isFiscalLockCancel(e)) {
        message.error(e.response?.data?.message || e.response?.data?.error || 'Failed to save');
      }
    } finally {
      setLoading(false);
      submittingRef.current = false;
    }
  }, [form, items, discPct, billDiscAmt, roundedTotal, otherChr, freightChr, isEdit, id, navigate, returnMode, amountOnly, refBill, cgstPct, sgstPct, igstPct, gstMode]);

  const handleReset = () => {
    setItems([]);
    setEntry(EMPTY_ENTRY);
    setRefBill(null);
    setAmountOnly(0);
    setReturnMode('Items');
    form.resetFields(['discount_percentage', 'refund_amount', 'other_charges', 'freight_charges', 'reason', 'remarks']);
    setTimeout(() => barcodeRef.current?.focus(), 50);
  };

  const dirty = items.length > 0 || amountOnly > 0;
  const confirmLeave = useUnsavedChangesWarning(dirty);

  /* ── F-key handlers (driven by ActionStrip below) ───────────────── */
  // F1 Save — saves, then asks "Print debit note?" with Enter / Esc.
  const handleSaveWithPrintPrompt = useCallback(() => {
    return handleSave(false, {
      onSaved: async (data) => {
        const num = data?.return_number || '';
        const printId = data?.purchase_return_id || id;
        if (!printId) return;
        const wantsPrint = await confirmPrint(
          num ? `Print debit note ${num}?` : 'Print debit note?',
        );
        if (wantsPrint) printDocument({ docType: 'purchase_return', id: printId });
      },
    });
  }, [handleSave, id]);

  // F2 Date popup — classic accounting-style smart-input popup for the return date.
  const { openDate } = useDatePopup();
  const f2DatePopup = useCallback(() => {
    const current = form.getFieldValue('return_date');
    openDate({
      title: 'Return Date',
      value: current ? dayjs(current) : dayjs(),
      onConfirm: (d) => form.setFieldsValue({ return_date: dayjs(d) }),
    });
  }, [form, openDate]);

  // F3 = toggle focus between Barcode and items table. Quantity column
  // is at ciIdx=5 in this form.
  const isInItemsTable = (el) => !!(el && el.closest && el.closest('.rtn-tbl-wrap'));
  const focusBarcode = () => {
    barcodeRef.current?.focus?.();
    barcodeRef.current?.select?.();
  };
  const focusItemsTable = () => {
    const wrap = tableWrapRef.current;
    if (!wrap) return;
    const qtyCells = wrap.querySelectorAll('[id^="sc-"][id$="-5"] input');
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

  // F6 — focus the Refund ₹ input via its ref.
  const jumpToRefund = useCallback(() => {
    const inst = refundInputRef.current;
    if (!inst) return;
    inst.focus?.();
    setTimeout(() => inst.select?.(), 0);
  }, []);

  const numCell = (ri, ci, val, field, min) => (
    <div id={`sc-${ri}-${ci}`}>
      <InputNumber keyboard={false} variant="borderless" value={val}
        onChange={(v) => updateItem(items[ri]?.key, field, v ?? 0)}
        onKeyDown={(e) => navTbl(e, ri, ci)} min={min ?? 0}
        size="small"/>
    </div>
  );
  const txtCell = (ri, ci, val, field) => (
    <div id={`sc-${ri}-${ci}`}>
      <Input variant="borderless" value={val}
        onChange={(e) => updateItem(items[ri]?.key, field, e.target.value)}
        onKeyDown={(e) => navTbl(e, ri, ci)} size="small"/>
    </div>
  );
  const readCell = (v, style = {}) => (
    <span style={{ fontSize: 13, fontWeight: 700, color: 'var(--fg-primary)', fontFamily: 'inherit', ...style }}>{v || '—'}</span>
  );

  // Column catalogue — `key` + `required` props let the Customize
  // popover filter optional columns on/off via `prfVisibleCols`.
  const allCols = [
    { key: 'index', required: true, title: '#', width: 40, align: 'center',
      render: (_, __, i) => <span style={{ color: 'var(--fg-primary)', fontSize: 13, fontWeight: 700, fontFamily: 'inherit' }}>{i + 1}</span> },
    { key: 'barcode', title: 'Barcode', dataIndex: 'barcode', width: 120, render: (v) => readCell(v, { fontVariantNumeric: 'tabular-nums' }) },
    { key: 'product_name', required: true, title: 'Product Name', dataIndex: 'product_name', width: 220, render: (v) => readCell(v) },
    { key: 'size', title: 'Size', dataIndex: 'size', width: 70, render: (v) => readCell(v) },
    { key: 'unit', title: 'Unit', dataIndex: 'unit_type', width: 70, align: 'center',
      render: (v) => <span style={{ fontSize: 13, fontWeight: 700, color: 'var(--fg-primary)', fontFamily: 'inherit' }}>{v || 'Pcs'}</span> },
    { key: 'article', title: 'Art#', dataIndex: 'article_number', width: 80, render: (v) => readCell(v) },
    { key: 'qty', required: true, title: 'Qty', dataIndex: 'quantity', width: 80, align: 'center', className: 'num-cell', render: (v, r, ri) => numCell(ri, 5, v, 'quantity', 0) },
    { key: 'rate', required: true, title: 'Rate ₹', dataIndex: 'rate', width: 110, align: 'right', className: 'num-cell', render: (v, r, ri) => numCell(ri, 6, v, 'rate', 0) },
    { key: 'disc_pct', title: 'Disc%', dataIndex: 'discount_percentage', width: 70, align: 'right', className: 'num-cell', render: (v, r, ri) => numCell(ri, 7, v, 'discount_percentage', 0) },
    { key: 'gst_pct', title: 'GST%', dataIndex: 'gst_rate', width: 70, align: 'right', className: 'num-cell', render: (v, r, ri) => numCell(ri, 8, v, 'gst_rate', 0) },
    { key: 'amount', required: true, title: 'Amount ₹', width: 120, align: 'right', className: 'num-cell',
      render: (_, r) => {
        const lt = (r.quantity || 0) * (r.rate || 0);
        const da = lt * (r.discount_percentage || 0) / 100;
        return <span style={{ color: 'var(--fg-primary)', fontWeight: 700, fontSize: 13, fontFamily: 'inherit', fontVariantNumeric: 'tabular-nums', textAlign: 'right' }}>{fmtN(lt - da)}</span>;
      } },
    { key: 'remove', required: true, title: '', width: 36, align: 'center',
      render: (_, r) => (
        <button onClick={() => removeItem(r.key)}
          style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--danger)',
                   padding: '6px 8px', lineHeight: 1, fontSize: 16, width: '100%', height: '100%' }}>×</button>
      ) },
  ];
  const cols = allCols.filter(c => c.required || prfVisibleCols.has(c.key));

  // Customize popover — uses the shared `.cols-menu` markup so the
  // global customize-menu styles in styles/global.css drive the look.
  const prfCustomizeContent = (
    <div className="cols-menu" style={{ width: 240 }}>
      <div className="grp">
        <div className="gh">
          <span>Item details</span>
          <button
            className="gh-reset"
            type="button"
            onClick={() => {
              setPrfVisibleCols(new Set(PRF_COL_DEFAULTS));
              try { localStorage.removeItem('prf_visible_cols'); } catch {}
            }}
          >Reset</button>
        </div>
        {[
          {key:'barcode',title:'Barcode'},
          {key:'size',   title:'Size'},
          {key:'unit',   title:'Unit'},
          {key:'article',title:'Art#'},
        ].map(c => (
          <label key={c.key} className="opt">
            <input
              type="checkbox"
              checked={prfVisibleCols.has(c.key)}
              onChange={() => togglePrfCol(c.key)}
            />
            <span>{c.title}</span>
          </label>
        ))}
      </div>
      <div className="grp">
        <div className="mh">Tax</div>
        {[
          {key:'disc_pct',title:'Disc%'},
          {key:'gst_pct', title:'GST%'},
        ].map(c => (
          <label key={c.key} className="opt">
            <input
              type="checkbox"
              checked={prfVisibleCols.has(c.key)}
              onChange={() => togglePrfCol(c.key)}
            />
            <span>{c.title}</span>
          </label>
        ))}
      </div>
    </div>
  );

  const isPending = balance > 0.001;
  const isPartial = parseFloat(refundAmt || 0) > 0 && isPending;
  const statusClass = isPending ? (isPartial ? 'partial' : 'pending') : 'refunded';
  const statusLabel = isPending ? (isPartial ? 'Debit due (partial)' : 'Debit pending') : 'Refunded in full';

  return (
    <Form form={form} component={false}>
      <div className="rtn-page">

        <section className="rtn-top">
          <div className="rtn-top-inner">

            <div className="rtn-top-head">
              <span className="rtn-pill">
                <span className="arrow">↶</span>
                {isEdit ? 'Edit Purchase Return' : 'Purchase Return / Debit Note'}
              </span>
              <div className="rtn-doc">
                <span>Return no.</span>
                <b>{returnNo || `New · ${dayjs().format('DD MMM YYYY')}`}</b>
              </div>
              {company && <span className="rtn-company">· {company}</span>}

              {!isEdit && (
                <div className="rtn-mode-toggle">
                  <button type="button"
                    className={`rtn-mode-opt ${returnMode === 'Items' ? 'active' : ''}`}
                    onClick={() => setReturnMode('Items')}>Items</button>
                  <button type="button"
                    className={`rtn-mode-opt ${returnMode === 'Amount' ? 'active' : ''}`}
                    onClick={() => { setReturnMode('Amount'); setTimeout(() => amountOnlyRef.current?.focus(), 50); }}>
                    Amount only
                  </button>
                </div>
              )}
              {/* Customize — column-toggle popover. Pushed to the right
                  edge of the head strip via margin-left: auto so it
                  reads as a separate affordance from the mode toggle. */}
              <Popover content={prfCustomizeContent} title="Customize columns" trigger="click" placement="bottomRight">
                <button type="button" className="sbf-cols-btn" style={{ marginLeft: 'auto' }} title="Customize the items table columns">
                  <SettingOutlined /> Customize
                </button>
              </Popover>
            </div>

            <div className="rtn-top-row">
              {/* Source godown — where the returned goods leave from.
                  Defaults to the referenced bill's godown when one is
                  loaded. Hidden when the Multi-warehouse master toggle
                  is OFF — default godown pre-fill keeps submission honest. */}
              {multiWarehouseOn && (
                <div className="rtn-field" style={{ flex: '0 0 180px' }}>
                  <Form.Item name="godown_id" noStyle rules={[{ required: true, message: ' ' }]}>
                    <Select
                      placeholder="Godown *"
                      disabled={isEdit}
                      options={godowns.map((g) => ({ value: g.godown_id, label: `${g.code} — ${g.name}` }))}
                    />
                  </Form.Item>
                </div>
              )}
              <div className="rtn-field">
                <Form.Item name="supplier_id" noStyle rules={[{ required: true, message: ' ' }]}>
                  <Select showSearch placeholder="Supplier *" allowClear optionFilterProp="label"
                    options={parties.map((p) => ({ value: p.party_id, label: p.party_name, party: p }))}/>
                </Form.Item>
              </div>
              <div className="rtn-field">
                {refBill ? (
                  <div style={{ display: 'flex', alignItems: 'center', height: 38 }}>
                    <span className="rtn-ref-pill">
                      Ref: {refBill.bill_number}
                      <span className="clear" onClick={clearReference} title="Remove reference">×</span>
                    </span>
                  </div>
                ) : (
                  <button type="button" className="rtn-act" style={{ height: 38 }} onClick={openRefPicker}>
                    Link to purchase bill
                  </button>
                )}
              </div>
              <div className="rtn-field">
                <Form.Item name="return_date" noStyle rules={[{ required: true, message: ' ' }]}>
                  <DatePicker style={{ width: '100%' }} format="DD-MM-YYYY" placeholder="Return date *"/>
                </Form.Item>
              </div>
              <div className="rtn-field">
                <Form.Item name="reason" noStyle>
                  <Input placeholder="Reason (defective, shortage, etc.)"/>
                </Form.Item>
              </div>
            </div>

            {selectedParty && (
              <div className="rtn-party-info">
                {selectedParty.city && <span>{selectedParty.city}</span>}
                {selectedParty.mobile_1 && <span>📞 <b>{selectedParty.mobile_1}</b></span>}
                <span>Balance <b className={parseFloat(selectedParty.current_balance || 0) >= 0 ? 'pos' : 'neg'}>
                  ₹{parseFloat(selectedParty.current_balance || 0).toFixed(2)}
                </b></span>
              </div>
            )}

            {returnMode === 'Items' ? (
              <div className="rtn-top-row-2">
                <div className="rtn-field">
                  <Input ref={barcodeRef} value={entry.barcode} placeholder="Barcode / scan"
                    onChange={(e) => setEntry((p) => ({ ...p, barcode: e.target.value }))}
                    onPressEnter={(e) => { const val = e.target.value.trim(); if (val) { e.target.value = ''; handleScan(val); } }}
                    onKeyDown={(e) => { if (e.key === 'ArrowDown') { e.preventDefault(); prodRef.current?.focus(); } }}/>
                </div>
                <div className="rtn-field">
                  <Select value={activeCatId} placeholder="Category" showSearch
                    filterOption={(input, opt) => !input || opt.children.toLowerCase().includes(input.toLowerCase())}
                    allowClear notFoundContent={null} dropdownMatchSelectWidth={300}
                    onChange={(v, opt) => {
                      justSelectedRef.current = false;
                      setActiveCatId(v || null);
                      setEntry((p) => ({ ...p, category_id: v || null, category_name: opt?.children || '', product_name: '', product_id: null }));
                    }}>
                    {cats.map((c) => <Select.Option key={c.category_id} value={c.category_id}>{c.category_name}</Select.Option>)}
                  </Select>
                </div>
                <div className="rtn-field">
                  <Select key={activeCatId ?? 'no-cat'} ref={prodRef}
                    showSearch filterOption={false} optionLabelProp="label"
                    value={entry.product_id || undefined}
                    open={prodOpen}
                    onDropdownVisibleChange={(v) => setProdOpen(v)}
                    onSearch={(v) => { if (v) setProdOpen(true); handleProdSearch(v); }}
                    onSelect={(val, opt) => { setProdOpen(false); handleProdSel(val, opt); }}
                    onFocus={() => {
                      if (justSelectedRef.current) {
                        justSelectedRef.current = false;
                        requestAnimationFrame(() => { prodRef.current?.blur(); qtyRef.current?.focus(); });
                      }
                    }}
                    onClear={() => { setProdOpen(false); setEntry((p) => ({ ...p, product_id: null, product_name: '' })); }}
                    allowClear placeholder="Product name" notFoundContent={null}
                    listHeight={320} dropdownMatchSelectWidth={460}>
                    {prodOpts.map((p) => (
                      <Select.Option key={p.product_id} value={p.product_id} label={p.product_name} product={p}>
                        <div style={{ display: 'flex', justifyContent: 'space-between', padding: '2px 0' }}>
                          <span style={{ fontWeight: 600, fontSize: 13, color: 'var(--fg-primary)' }}>{p.product_name}</span>
                          <span style={{ color: 'var(--rtn-accent, #B91C1C)', fontWeight: 700, fontSize: 12 }}>₹{parseFloat(p.purchase_rate || 0).toFixed(2)}</span>
                        </div>
                      </Select.Option>
                    ))}
                  </Select>
                </div>
                {[
                  { l: 'Size',   ref: sizeRef, f: 'size',                v: entry.size,                            i: 1, t: 'txt' },
                  { l: 'Rate ₹', ref: rateRef, f: 'rate',                v: entry.rate || undefined,               i: 2, t: 'num', min: 0 },
                  { l: 'Qty',    ref: qtyRef,  f: 'quantity',            v: entry.quantity || undefined,           i: 3, t: 'num', min: 0 },
                  { l: 'Disc%',  ref: discRef, f: 'discount_percentage', v: entry.discount_percentage || undefined, i: 4, t: 'num', min: 0 },
                  { l: 'GST%',   ref: gstRef,  f: 'gst_rate',            v: entry.gst_rate || undefined,           i: 5, t: 'num', min: 0 },
                ].map(({ l, ref, f, v, i, t, min }) => (
                  <div key={f} className="rtn-field">
                    {t === 'txt'
                      ? <Input ref={ref} value={v} placeholder={l} onChange={(e) => ue(f, e.target.value)} onKeyDown={(e) => eKey(e, i)}/>
                      : <InputNumber keyboard={false} ref={ref} value={v} style={{ width: '100%' }} min={min} placeholder={l}
                          onChange={(vv) => ue(f, vv || 0)} onKeyDown={(e) => eKey(e, i)}/>
                    }
                  </div>
                ))}
                <button onClick={addItem} className="rtn-add-btn">+ ADD</button>
              </div>
            ) : (
              <div className="rtn-amount-box">
                <div>
                  <div className="label">Amount-only return</div>
                  <div className="hint">Straight debit note for ₹ below. Stock isn't affected. Use for rate adjustments, shortage claims, or damages that don't physically return stock.</div>
                </div>
                <div className="hero-input">
                  <InputNumber ref={amountOnlyRef} keyboard={false} size="large" min={0}
                    style={{ width: '100%', fontSize: 22 }}
                    value={amountOnly || undefined}
                    onChange={(v) => setAmountOnly(v || 0)}
                    placeholder="0.00" prefix="₹"/>
                </div>
              </div>
            )}
          </div>
        </section>

        {returnMode === 'Items' && (
          <section className="rtn-mid">
            <div className="rtn-mid-card">
              <div ref={tableWrapRef} className="rtn-tbl-wrap">
                <Table columns={cols} dataSource={items} rowKey="key"
                  size="small" pagination={false} loading={pgLoading}
                  scroll={items.length ? { x: 1086, y: tblHeight } : { y: tblHeight }}
                  locale={{
                    emptyText: (
                      <div className="rtn-empty">
                        <div className="rtn-empty-icon">↶</div>
                        <div className="rtn-empty-main">Scan a barcode or pick a purchase bill to return items</div>
                        <div className="rtn-empty-sub">
                          <b>scan a barcode</b> · <b>search a product</b> · <b>link a purchase bill</b> to auto-fill all its items.
                        </div>
                        <div className="rtn-empty-hints">
                          <span><kbd>F1</kbd> save &amp; refund</span>
                          <span><kbd>F8</kbd> save debit</span>
                          <span><kbd>Esc</kbd> go back</span>
                        </div>
                      </div>
                    ),
                  }}/>
              </div>
            </div>
          </section>
        )}
        {returnMode === 'Amount' && <section className="rtn-mid"><div style={{ flex: 1 }}/></section>}

        <section className="rtn-bottom">
          <div className="rtn-bottom-inner">

            <div className="rtn-bb-left">
              <div className="rtn-card rtn-summary">
                <div className="rtn-counters">
                  <div className="rtn-counter items"><div className="k">Items</div><div className="v">{returnMode === 'Amount' ? '—' : items.length}</div></div>
                  <div className="rtn-counter qty"><div className="k">Qty</div><div className="v">{returnMode === 'Amount' ? '—' : totalQty.toFixed(1)}</div></div>
                  <div className="rtn-counter val"><div className="k">Box</div><div className="v">{returnMode === 'Amount' ? '—' : boxQty.toFixed(1)}</div></div>
                </div>
                <div className="rtn-summary-notes">
                  <span className="rtn-lbl">Notes</span>
                  <Form.Item name="remarks" noStyle>
                    <Input.TextArea rows={5} maxLength={1000} placeholder="Internal notes for this return…" className="rtn-notes-ta"/>
                  </Form.Item>
                </div>
              </div>
            </div>

            <div className="rtn-bb-right">
              <div className="rtn-card rtn-totals">
                <div className="rtn-tot-lines">
                  <div className="rtn-tot-line total-row">
                    <span className="k">Total</span>
                    <span className="rtn-val-box">{fmtN(taxableAmt)}</span>
                  </div>
                  <div className="rtn-tot-line with-pct">
                    <span className="k">GST (C+S)</span>
                    <InputNumber keyboard={false} size="small" min={0} max={100}
                      className="rtn-pct-in" style={{ width: '100%' }}
                      value={effCgstPct || undefined} disabled={gstMode === 'product' || returnMode === 'Amount'}
                      onChange={(v) => { const n = v || 0; setCgstPct(n); setSgstPct(n); }}
                      formatter={(v) => v ? `${v}%` : ''} parser={(v) => v?.replace('%', '') || ''} placeholder="%"/>
                    <span className="rtn-val-box">{fmtN(cgst + sgst)}</span>
                  </div>
                  <div className="rtn-tot-line with-pct">
                    <span className="k">IGST</span>
                    <InputNumber keyboard={false} size="small" min={0} max={100}
                      className="rtn-pct-in" style={{ width: '100%' }}
                      value={igstPct || undefined} disabled={returnMode === 'Amount'}
                      onChange={(v) => setIgstPct(v || 0)}
                      formatter={(v) => v ? `${v}%` : ''} parser={(v) => v?.replace('%', '') || ''} placeholder="%"/>
                    <span className="rtn-val-box">{fmtN(igstAmt)}</span>
                  </div>
                  <div className="rtn-tot-line gst-total">
                    <span className="k">Total GST</span>
                    <span className="rtn-val-box gst-val">{fmtN(totalGST)}</span>
                  </div>
                  <div className="rtn-tot-line extras">
                    <span className="k">Extras</span>
                    <Form.Item name="other_charges" noStyle>
                      <InputNumber keyboard={false} size="small" min={0} placeholder="Other" className="rtn-amt-in" style={{ width: '100%' }}/>
                    </Form.Item>
                    <Form.Item name="freight_charges" noStyle>
                      <InputNumber keyboard={false} size="small" min={0} placeholder="Freight" className="rtn-amt-in" style={{ width: '100%' }}/>
                    </Form.Item>
                  </div>
                  <div className="rtn-tot-line with-pct">
                    <span className="k">Bill Disc</span>
                    <Form.Item name="discount_percentage" noStyle>
                      <InputNumber keyboard={false} size="small" min={0} max={100} placeholder="%"
                        disabled={returnMode === 'Amount'}
                        className="rtn-pct-in" style={{ width: '100%' }}
                        formatter={(v) => v ? `${v}%` : ''} parser={(v) => v?.replace('%', '') || ''}
                        onChange={(pct) => { discAmtEditingRef.current = false; setDiscAmtVal(+(subTotal * (pct || 0) / 100).toFixed(2)); }}/>
                    </Form.Item>
                    <InputNumber keyboard={false} size="small" min={0} placeholder="₹ amt"
                      className="rtn-amt-in" style={{ width: '100%' }}
                      value={discAmtVal || undefined}
                      disabled={returnMode === 'Amount'}
                      onFocus={() => { discAmtEditingRef.current = true; }}
                      onBlur={() => { discAmtEditingRef.current = false; }}
                      onChange={(amt) => {
                        discAmtEditingRef.current = true;
                        setDiscAmtVal(amt || 0);
                        const pct = subTotal > 0 ? +((amt || 0) / subTotal * 100).toFixed(4) : 0;
                        form.setFieldValue('discount_percentage', +pct.toFixed(2));
                      }}/>
                  </div>
                </div>
              </div>

              <div className="rtn-card rtn-refund">
                <div className="rtn-hero">
                  <span className="k">Return total ₹</span>
                  <span className="v">{roundedTotal.toLocaleString('en-IN')}</span>
                </div>
                <div className="rtn-pay-line">
                  <span className="k">Mode</span>
                  <Form.Item name="refund_method" noStyle initialValue="Cash">
                    <Select>
                      {PAY_MODES.map((m) => <Select.Option key={m} value={m}>{m}</Select.Option>)}
                    </Select>
                  </Form.Item>
                </div>
                <div className="rtn-pay-line">
                  <span className="k">Refund ₹</span>
                  <Form.Item name="refund_amount" noStyle>
                    <InputNumber ref={refundInputRef} keyboard={false} min={0} max={maxRefund} placeholder="0.00" style={{ width: '100%' }}/>
                  </Form.Item>
                </div>
                <div className={`rtn-status ${statusClass}`}>
                  <span className="k">{statusLabel}</span>
                  <span className="v">{fmtN(Math.abs(balance))}</span>
                </div>
              </div>

            </div>
          </div>
        </section>

        {/* ═══════════════════════════════ (4) ACTION STRIP ════════════════════
            Same registry-driven strip as Sales Return Form. F1 saves
            + prints the debit note; F2 saves only. F6 jumps to Refund ₹. */}
        <ActionStrip
          actions={[
            { id: 'back', key: 'Esc', label: 'Back',
              onAction: () => confirmLeave(() => navigate('/purchase-returns')) },
            { id: 'date', key: 'F2', label: 'Date',
              onAction: f2DatePopup,
              title: 'Open the smart-input date popup' },
            { id: 'reset', key: 'F5', label: 'Reset',
              onAction: handleReset },
            { id: 'jump-items', key: 'F3', label: 'Items',
              onAction: toggleBarcodeItems,
              title: 'Toggle focus between Barcode and the items table' },
            { id: 'jump-refund', key: 'F6', label: 'Refund',
              onAction: jumpToRefund,
              title: 'Jump to Refund ₹' },
            { id: 'print-edit', key: 'F9', label: 'Print',
              hidden: !isEdit,
              onAction: () => printDocument({ docType: 'purchase_return', id }) },
            { id: 'save', key: 'F1', label: 'Save', tone: 'primary',
              disabled: loading,
              onAction: handleSaveWithPrintPrompt,
              title: 'Save the return — prompts to print debit note after success' },
            // Hidden alias: Ctrl+Enter mirrors F1.
            { id: 'save-alt', key: 'Ctrl+Enter', label: '',
              hidden: true, disabled: loading,
              onAction: handleSaveWithPrintPrompt },
          ]}
        />

        <Modal open={refPickerOpen} onCancel={() => setRefPickerOpen(false)}
          title="Pick purchase bill to return" footer={null} width={720}>
          <Input.Search placeholder="Search by bill number or supplier" allowClear
            value={refSearch} onChange={(e) => setRefSearch(e.target.value)}
            style={{ marginBottom: 12 }}/>
          <div className="rtn-ref-picker-list">
            {refLoading && <div style={{ padding: 24, textAlign: 'center' }}>Loading…</div>}
            {!refLoading && refBills.length === 0 && <div style={{ padding: 24, textAlign: 'center', color: 'var(--fg-tertiary)' }}>No bills found</div>}
            {!refLoading && refBills
              .filter((b) => !refSearch ||
                b.bill_number?.toLowerCase().includes(refSearch.toLowerCase()) ||
                b.supplier?.party_name?.toLowerCase().includes(refSearch.toLowerCase()))
              .map((b) => (
                <div key={b.purchase_bill_id} className="rtn-ref-picker-row" onClick={() => pickReferenceBill(b)}>
                  <div>
                    <div className="num">{b.bill_number}</div>
                    <div className="date">{dayjs(b.bill_date).format('DD-MMM-YYYY')}</div>
                  </div>
                  <div>
                    <div style={{ fontWeight: 600 }}>{b.supplier?.party_name || '—'}</div>
                    <div style={{ fontSize: 12, color: 'var(--fg-tertiary)' }}>{b.total_items} items · {parseFloat(b.total_quantity || 0)} qty</div>
                  </div>
                  <div className="amt">₹ {fmtN(b.total_amount)}</div>
                  <div style={{ fontSize: 11, textAlign: 'right', color: 'var(--fg-tertiary)' }}>{b.payment_status}</div>
                </div>
              ))}
          </div>
        </Modal>

        <FiscalLockOverrideModal
          open={!!lockModal}
          lock={lockModal?.lock}
          billDate={form.getFieldValue('return_date')}
          vouchTypeLabel="Purchase return"
          onConfirm={lockModal?.onConfirm}
          onCancel={lockModal?.onCancel}
        />
      </div>
    </Form>
  );
}
