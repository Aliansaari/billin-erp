import React, { useEffect, useMemo, useRef, useState, useCallback } from 'react';
import { Form, DatePicker, Select, Input, InputNumber, Button, Table, Tag, Space, message, Modal, Spin, Tooltip } from 'antd';
import { useNavigate, useParams } from 'react-router-dom';
import { SwapOutlined, DeleteOutlined, SaveOutlined, SendOutlined, CheckCircleOutlined, CloseCircleOutlined, ArrowLeftOutlined } from '@ant-design/icons';
import dayjs from 'dayjs';
import { stockTransferAPI, godownAPI, productAPI, categoryAPI, settingsAPI } from '../../api';
import ActionStrip from '../../components/keyboard/ActionStrip';
// Reuse the Sales bill form's entry-ledger CSS verbatim so the entry
// row visually matches its sibling on the Sales/Purchase forms — same
// hairlines, same cell padding, same focus state, same dotted column
// dividers, same +ADD button. We use the SAME .sbf-entry-grid (which
// has hardcoded 11-column layout in CSS) so the cells line up exactly
// with what an operator sees on Sales.
import '../sales/sales-bill-form.css';
// Page-specific styling — document-style header card (FROM → TO routing
// + date + notes in one panel), items card, summary footer card. Pulls
// theme tokens (--bg-elevated, --border, --fg-*, --accent-*) so light /
// dark / sepia themes inherit without per-mode overrides in the JSX.
import './stock-transfer-form.css';

// Same canonical unit list the Sales/Purchase forms use; keeping it
// identical here so the Unit dropdown's options match across pages.
const UNITS = ['Pcs', 'Box', 'Set', 'Pair', 'Dozen', 'Mtr', 'Roll'];

/*
 * Stock Transfer — create / view / receive / cancel form.
 *
 * Flow:
 *   /stock-transfer/new       → blank form, status defaults to Draft.
 *                               Operator picks from-godown + to-godown,
 *                               adds items, then either:
 *                                 - Save Draft   (status='Draft', no stock movement)
 *                                 - Submit       (status='In-Transit', source deducted)
 *
 *   /stock-transfer/edit/:id  → loads existing transfer.
 *                               Draft     → editable header, items list NOT editable
 *                                           (server has no update endpoint — cancel +
 *                                            recreate if items need to change), with
 *                                           Submit / Cancel buttons available.
 *                               In-Transit → read-only with Receive / Cancel buttons.
 *                               Received   → read-only.
 *                               Cancelled  → read-only.
 *
 * Item entry mirrors the bill-form pattern: barcode / product picker /
 * qty / rate. The Product picker shows per-godown stock at the FROM
 * godown so the operator knows what's available before committing.
 *
 * No GST, no party, no ledger — transfers are pure stock movement.
 */

const fmtN = (v) => parseFloat(v || 0).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

const STATUS_TONE = {
  'Draft':      'default',
  'In-Transit': 'orange',
  'Received':   'green',
  'Cancelled':  'red',
};

export default function StockTransferForm() {
  const nav = useNavigate();
  const { id } = useParams();
  const isEdit = Boolean(id);

  const [form]                  = Form.useForm();
  const [loading, setLoading]   = useState(false);
  const [pgLoading, setPgLoading] = useState(false);
  const [godowns, setGodowns]   = useState([]);
  // Category list backs the Category cell's narrow filter — picking a
  // category constrains the product search to that category, same as
  // SalesBillForm.
  const [cats, setCats]         = useState([]);
  const [activeCatId, setActiveCatId] = useState(null);
  const [items, setItems]       = useState([]);     // [{ key, product_id, product_name, barcode, quantity, rate }]
  const [transfer, setTransfer] = useState(null);   // loaded transfer (edit mode)
  const [prodOpts, setProdOpts] = useState([]);
  const [prodSearching, setProdSearching] = useState(false);
  const [prodOpen, setProdOpen] = useState(false);
  // justSelectedRef carries a one-shot flag from handleProdSel into the
  // next render's Select.onFocus — used to redirect AntD's focus-restore
  // to the qty cell so the operator can immediately type a quantity
  // without an extra Tab. Same pattern SalesBillForm uses.
  const justSelectedRef = useRef(false);
  const [transferNo, setTransferNo] = useState('—');
  // Entry-row state — mirrors Sales' single-row buffer. Operator fills
  // these cells (barcode → category → product → size → art# → qty →
  // rate → unit) and clicks +ADD to push a row into `items`. Same
  // shape as SalesBillForm's `entry`, minus the GST/discount fields
  // which don't apply to internal transfers (the cells still render
  // as disabled placeholders for visual parity with sales).
  const EMPTY_ENTRY = {
    product_id: null, product_name: '', barcode: '',
    category_id: null, category_name: '',
    size: '', article_number: '',
    unit_type: 'Pcs', quantity: 1, rate: 0,
    available_stock: 0,
    // Batch dimension — only meaningful when global batch_tracking_enabled
    // is ON AND the resolved product has is_batch_tracked=true. Picker
    // populates batch_id (auto-pick from FEFO/FIFO winner at the SOURCE
    // godown). Mirrors SalesBillForm's EMPTY shape so cross-form copy/
    // paste of cell logic stays straightforward.
    is_batch_tracked: false, batch_id: null, batch_number: '',
    manufacture_date: null, expiry_date: null, batch_stock: 0,
  };
  const [entry, setEntry] = useState(EMPTY_ENTRY);
  const itemKeyRef    = useRef(1);
  const submittingRef = useRef(false);
  // Sales-form parity: debounce timer + stale-request id so concurrent
  // typed characters don't race and overwrite the latest result set.
  const searchTimerRef = useRef(null);
  const searchReqRef   = useRef(0);
  // Cell refs for keyboard walk (Tab/Enter/ArrowDown/ArrowUp), matching
  // the bill-form rhythm so the operator never reaches for the mouse.
  const barcodeRef = useRef(null);
  const prodRef    = useRef(null);
  const sizeRef    = useRef(null);
  const artRef     = useRef(null);
  const qtyRef     = useRef(null);
  const rateRef    = useRef(null);
  // Batch picker state — populated when entry.product_id changes for a
  // batch-tracked product at the SOURCE godown. Server returns batches
  // already FEFO/FIFO sorted so the first row is the auto-pick winner.
  // batchTrackingOn comes from SystemSettings on mount; the form silently
  // falls back to non-batch behaviour when the global toggle is OFF.
  const [batchOpts, setBatchOpts]               = useState([]);
  const [batchOptsLoading, setBatchOptsLoading] = useState(false);
  const [batchTrackingOn, setBatchTrackingOn]   = useState(false);
  const [batchAlertDays, setBatchAlertDays]     = useState(30);
  const batchSelectRef = useRef(null);
  const [batchOpen, setBatchOpen] = useState(false);
  // pendingBatchFocusRef carries a flag from product-pick (or barcode
  // scan) into the next batch-fetch settle, then drains by focusing the
  // batch Select. Decouples async fetch timing from focus timing.
  const pendingBatchFocusRef = useRef(false);

  const fromGodownId = Form.useWatch('from_godown_id', form);
  const toGodownId   = Form.useWatch('to_godown_id', form);

  // Effective status:
  //   - new form  → 'Draft'
  //   - edit form → loaded transfer's status, or 'Draft' until loaded
  const status = transfer?.status || 'Draft';
  const readOnly = isEdit && status !== 'Draft';

  /* ── Loaders ──────────────────────────────────────────────────────── */
  useEffect(() => {
    godownAPI.getAll().then(({ data }) => {
      const list = (data || []).filter((g) => g.is_active);
      // Filter to user's allowed_godowns when set (server enforces too).
      const userAllowed = (() => {
        try {
          const u = JSON.parse(localStorage.getItem('user') || 'null');
          return Array.isArray(u?.allowed_godowns) ? u.allowed_godowns : null;
        } catch { return null; }
      })();
      setGodowns(userAllowed ? list.filter((g) => userAllowed.includes(g.godown_id)) : list);
    }).catch(() => {});
    // Categories — drives the Category cell's filter on product search.
    categoryAPI.getAllFlat().then(({ data }) => setCats(data || [])).catch(() => {});
    // Global batch toggle + expiry-alert window. Same names SalesBillForm
    // reads (Commit 3); the form silently falls back to the non-batch
    // entry layout when the toggle is OFF, so older instances keep the
    // pre-batch experience untouched.
    settingsAPI.getSystem().then(({ data }) => {
      setBatchTrackingOn(!!data?.data?.batch_tracking_enabled);
      const ad = parseInt(data?.data?.batch_expiry_alert_days, 10);
      setBatchAlertDays(Number.isFinite(ad) && ad > 0 ? ad : 30);
    }).catch(() => {});
  }, []);

  useEffect(() => {
    if (isEdit) {
      loadTransfer(id);
    } else {
      form.setFieldsValue({ transfer_date: dayjs() });
    }
    // eslint-disable-next-line
  }, [id]);

  const loadTransfer = async (tid) => {
    setPgLoading(true);
    try {
      const { data } = await stockTransferAPI.getById(tid);
      setTransfer(data);
      setTransferNo(data.transfer_number || '—');
      form.setFieldsValue({
        transfer_date:  data.transfer_date ? dayjs(data.transfer_date) : dayjs(),
        from_godown_id: data.from_godown_id,
        to_godown_id:   data.to_godown_id,
        notes:          data.notes || '',
      });
      const loaded = (data.items || []).map((it) => ({
        key:          itemKeyRef.current++,
        product_id:   it.product_id,
        product_name: it.product?.product_name || '',
        barcode:      it.barcode || it.product?.barcode || '',
        unit:         it.product?.unit_of_measurement || 'PCS',
        quantity:     parseFloat(it.quantity) || 0,
        rate:         parseFloat(it.rate) || 0,
        // Batch fields — persisted from the original transfer so re-opens
        // (and the cancel cascade) carry the same batch identity that
        // moved at submission time. Falls back gracefully to null on
        // older non-batch transfer rows.
        batch_id:         it.batch_id || null,
        batch_number:     it.batch?.batch_number || '',
        manufacture_date: it.batch?.manufacture_date || null,
        expiry_date:      it.batch?.expiry_date || null,
        is_batch_tracked: !!(it.product?.is_batch_tracked || it.batch_id),
      }));
      setItems(loaded);
    } catch (err) {
      message.error(err?.response?.data?.error || 'Failed to load transfer');
      nav('/stock-transfers');
    } finally {
      setPgLoading(false);
    }
  };

  /* ── Item entry ───────────────────────────────────────────────────── */

  // Mirrors SalesBillForm's handleProdSearch:
  //  - debounced (150ms) so we don't fire one request per keystroke
  //  - stale-request guard via reqId so a slow earlier response can't
  //    overwrite a later, fresher result set
  //  - response shape is data.data (paginated wrapper) — using `data`
  //    as the array would set prodOpts to an OBJECT and prodOpts.map
  //    would crash with "is not a function", blanking the screen.
  //  - godown_id forwarded so the server scopes current_stock to the
  //    source godown (productController.getAll honours godown_id).
  // Mirrors SalesBillForm's handleProdSearch byte-for-byte, plus
  // godown_id forwarding so the per-source-godown stock chip is
  // accurate. When the search box clears WITH a category active, we
  // intentionally DON'T blank prodOpts — the category-preload effect
  // below holds those results steady so the operator can pick from
  // the open dropdown without re-typing.
  const handleProdSearch = useCallback((v) => {
    if (searchTimerRef.current) clearTimeout(searchTimerRef.current);
    if (!v) { if (!activeCatId) setProdOpts([]); return; }
    searchTimerRef.current = setTimeout(async () => {
      const reqId = ++searchReqRef.current;
      try {
        const { data } = await productAPI.search(v, {
          name_only: 'true',
          ...(activeCatId ? { category_id: activeCatId } : {}),
          ...(fromGodownId ? { godown_id: fromGodownId } : {}),
        });
        if (reqId !== searchReqRef.current) return;
        setProdOpts(data.data || []);
      } catch { /* surface as empty result */ }
    }, 150);
  }, [fromGodownId, activeCatId]);

  // Category preload — when the operator picks a category, populate
  // prodOpts with everything in that category AND auto-jump focus
  // into the Product cell with the dropdown already open. Mirrors
  // SalesBillForm line ~362 (the setTimeout focus+open is the bit
  // that makes the keyboard rhythm feel right: pick category → land
  // in product with options visible → arrow-key down or click to
  // pick). 30ms gives AntD enough time to mount the new option list
  // before we focus.
  useEffect(() => {
    let cancelled = false;
    if (!activeCatId) { setProdOpts([]); return; }
    productAPI.search('', {
      category_id: activeCatId,
      name_only:   'true',
      ...(fromGodownId ? { godown_id: fromGodownId } : {}),
    })
      .then(({ data }) => {
        if (cancelled) return;
        setProdOpts(data.data || []);
        setTimeout(() => { prodRef.current?.focus(); setProdOpen(true); }, 30);
      })
      .catch(() => { if (!cancelled) setProdOpts([]); });
    return () => { cancelled = true; };
  }, [activeCatId, fromGodownId]);

  // Pick a product → fill the entry-row buffer (NOT items — bill-form
  // pattern: edit qty/rate first, then click +ADD). Mirrors
  // SalesBillForm's handleProdSel; jumps focus to the qty cell so the
  // operator can immediately type a quantity.
  // Pick a product → fill the entry-row buffer and jump focus into qty.
  // Mirrors SalesBillForm's handleProdSel exactly (same field set, same
  // justSelectedRef-driven focus redirect via requestAnimationFrame).
  // The `value={entry.product_id}` binding + `optionLabelProp="label"`
  // give us AntD's free clear-search-on-select behaviour, so we don't
  // touch a controlled searchValue here.
  const handleProdSel = useCallback((val, opt) => {
    const p = opt?.product;
    if (!p) return;
    const qty = parseFloat(p.quantity_per_box) || 1;
    const unit = qty > 1 ? 'Box' : 'Pcs';
    setActiveCatId(p.category_id || null);
    setEntry((prev) => ({
      ...prev,
      product_id:      p.product_id,
      product_name:    p.product_name,
      barcode:         p.barcode || prev.barcode,
      category_id:     p.category_id,
      category_name:   p.Category?.category_name || '',
      size:            p.size_value || '',
      article_number:  p.article_number || '',
      unit_type:       unit,
      quantity:        qty,
      // Cost basis pre-fill — mode-aware via display_cost (variant:
      // purchase_rate, single: weighted_avg_cost, single+batch: batch-
      // weighted average). Falls back to purchase_rate for older rows.
      // Without this, transfers of single-mode stock value at the master
      // purchase_rate even when the wac has drifted from it. For
      // batch-tracked products the rate gets refined to the picked
      // batch's purchase_rate by pickBatch / the auto-pick branch below.
      rate:            parseFloat(p.display_cost ?? p.purchase_rate) || 0,
      available_stock: parseFloat(p.current_stock) || 0,
      // Reset batch fields on every new product pick so a stale batch_id
      // from the previous product can't leak into the next line. The
      // fetch effect below repopulates if the product is batch-tracked.
      is_batch_tracked: !!p.is_batch_tracked,
      batch_id: null, batch_number: '',
      manufacture_date: null, expiry_date: null, batch_stock: 0,
    }));
    // Flag carries through the next focus cycle so onFocus can redirect.
    justSelectedRef.current = true;
    if (batchTrackingOn && p.is_batch_tracked) {
      // Defer focus to the batch fetch's settle: the picker is disabled
      // during fetch, so we set the pending flag and let the drainer
      // effect below land focus on the batch Select once batches load.
      pendingBatchFocusRef.current = true;
    } else {
      requestAnimationFrame(() => {
        prodRef.current?.blur();
        qtyRef.current?.focus();
      });
    }
  }, [batchTrackingOn]);

  // Barcode scan → look up product, fill entry, push immediately.
  // Same pattern Sales uses (barcode is the fast-path bypass for the
  // pick-then-edit flow).
  const handleScan = async (raw) => {
    const code = String(raw || '').trim();
    if (!code) return;
    if (!fromGodownId) {
      message.warning('Pick source godown first');
      return;
    }
    try {
      const { data } = await productAPI.getByBarcode(code);
      const p = data;
      if (!p) { message.warning(`No product with barcode ${code}`); return; }
      // Batch-tracked products with the global toggle ON cannot be
      // direct-pushed into items[] — the operator needs to pick a
      // specific batch via the entry-row Lot dropdown. Route the scan
      // through the entry buffer (same as Sales' handleScan from Commit
      // 3); the batch-fetch effect populates the dropdown and the
      // drainer effect focuses it. Without this, scanned batch products
      // would land in items[] with batch_id=null and the server would
      // reject the save.
      if (batchTrackingOn && p.is_batch_tracked) {
        setEntry((prev) => ({
          ...prev,
          product_id:      p.product_id,
          product_name:    p.product_name,
          barcode:         p.barcode,
          category_id:     p.category_id,
          category_name:   p.Category?.category_name || '',
          size:            p.size_value || '',
          article_number:  p.article_number || '',
          unit_type:       (parseFloat(p.quantity_per_box) || 1) > 1 ? 'Box' : 'Pcs',
          quantity:        parseFloat(p.quantity_per_box) || 1,
          rate:            parseFloat(p.display_cost ?? p.purchase_rate) || 0,
          available_stock: parseFloat(p.current_stock) || 0,
          is_batch_tracked: true,
          batch_id: null, batch_number: '',
          manufacture_date: null, expiry_date: null, batch_stock: 0,
        }));
        setProdOpen(false);
        setActiveCatId(p.category_id || null);
        if (typeof document !== 'undefined' && document.activeElement instanceof HTMLElement) {
          document.activeElement.blur();
        }
        message.info(`${p.product_name} — pick a batch and press ADD`, 1.5);
        pendingBatchFocusRef.current = true;
        return;
      }
      // Non-batch fast path: push directly with quantity 1, the way
      // scanner-led counters expect ("scan, scan, scan, save").
      setItems((prev) => [
        ...prev,
        {
          key:            itemKeyRef.current++,
          product_id:     p.product_id,
          product_name:   p.product_name,
          barcode:        p.barcode,
          category_id:    p.category_id,
          category_name:  p.Category?.category_name || '',
          size:           p.size_value || '',
          article_number: p.article_number || '',
          unit:           (parseFloat(p.quantity_per_box) || 1) > 1 ? 'Box' : 'Pcs',
          quantity:       parseFloat(p.quantity_per_box) || 1,
          // Mode-aware cost basis (display_cost from getByBarcode) so
          // single-mode + single+batch transfers reflect the right rate.
          rate:           parseFloat(p.display_cost ?? p.purchase_rate) || 0,
          is_batch_tracked: !!p.is_batch_tracked,
          batch_id:       null,
        },
      ]);
      // Same flag/state cleanup as +ADD so the next focus-into-Product
      // opens the dropdown normally instead of being intercepted as a
      // just-selected redirect.
      justSelectedRef.current = false;
      setActiveCatId(null);
      setEntry(EMPTY_ENTRY);
      barcodeRef.current?.focus();
    } catch (err) {
      message.error(err?.response?.data?.error || `Failed to look up ${code}`);
    }
  };

  /* ── Batch picker — fetch + auto-pick ───────────────────────────────
   * Watches (product_id, is_batch_tracked, fromGodownId, batchTrackingOn).
   * For a batch-tracked product at a known SOURCE godown with the global
   * toggle ON, fetch the FEFO/FIFO-sorted batch list at from_godown and
   * auto-pick the top row (FEFO winner if any expiry exists, else FIFO
   * winner). Operator can override by opening the dropdown — that path
   * goes through pickBatch(). NB: source-godown constraint only — the
   * destination doesn't constrain because we're moving stock TO it. */
  useEffect(() => {
    if (!batchTrackingOn || !entry.is_batch_tracked
        || !entry.product_id || !fromGodownId) {
      setBatchOpts([]);
      return;
    }
    let cancelled = false;
    setBatchOptsLoading(true);
    productAPI.getBatches(entry.product_id, { godown_id: fromGodownId })
      .then(({ data }) => {
        if (cancelled) return;
        const rows = data?.data || [];
        setBatchOpts(rows);
        if (rows.length > 0 && !entry.batch_id) {
          const top = rows[0];
          setEntry((p) => ({
            ...p,
            batch_id:         top.batch_id,
            batch_number:     top.batch_number,
            manufacture_date: top.manufacture_date,
            expiry_date:      top.expiry_date,
            batch_stock:      parseFloat(top.current_stock || 0),
            available_stock:  parseFloat(top.current_stock || 0),
            // Refine rate to the picked batch's purchase_rate — more
            // precise than display_cost (a batch-weighted average) for
            // valuing a transfer of a SPECIFIC lot. Falls back to the
            // existing rate if the batch row has no purchase_rate.
            rate: parseFloat(top.purchase_rate) || p.rate || 0,
          }));
        }
      })
      .catch(() => { if (!cancelled) setBatchOpts([]); })
      .finally(() => { if (!cancelled) setBatchOptsLoading(false); });
    return () => { cancelled = true; };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [entry.product_id, entry.is_batch_tracked, fromGodownId, batchTrackingOn]);

  // Drain pendingBatchFocusRef once the batch fetch settles. Mirrors
  // SalesBillForm's drainer exactly — order matters: setBatchOpen(true)
  // BEFORE focus() so the dropdown is mounted by the time we focus the
  // trigger. 60ms setTimeout (not rAF) gives React + AntD a full tick
  // to render the open dropdown. Empty-batch case still focuses qty so
  // the cursor isn't stranded on a disabled Select.
  useEffect(() => {
    if (!pendingBatchFocusRef.current) return;
    if (batchOptsLoading) return;
    pendingBatchFocusRef.current = false;
    if (batchOpts.length === 0) {
      requestAnimationFrame(() => qtyRef.current?.focus());
      return;
    }
    setBatchOpen(true);
    if (typeof document !== 'undefined' && document.activeElement instanceof HTMLElement) {
      document.activeElement.blur();
    }
    setTimeout(() => batchSelectRef.current?.focus(), 60);
  }, [batchOptsLoading, batchOpts]);

  // Switch-from-godown handling: when fromGodownId changes after a batch
  // has already been picked, re-evaluate. If the picked batch has stock
  // at the new source, keep it (the fetch effect refreshes batch_stock);
  // if it has zero stock, clear the pick so the operator must re-select.
  // Surfaces inline message so the operator understands why the picker
  // suddenly emptied. Skipped on initial load (no prior pick yet).
  const prevFromGodownRef = useRef(fromGodownId);
  useEffect(() => {
    const prev = prevFromGodownRef.current;
    prevFromGodownRef.current = fromGodownId;
    if (prev === fromGodownId) return;
    if (!entry.batch_id || !batchTrackingOn || !entry.is_batch_tracked) return;
    if (!fromGodownId) return;
    // Re-check the picked batch's stock at the NEW source godown.
    productAPI.getBatches(entry.product_id, { godown_id: fromGodownId })
      .then(({ data }) => {
        const rows = data?.data || [];
        const stillThere = rows.find((b) => b.batch_id === entry.batch_id);
        if (stillThere) {
          setEntry((p) => ({ ...p,
            batch_stock: parseFloat(stillThere.current_stock || 0),
            available_stock: parseFloat(stillThere.current_stock || 0),
          }));
        } else {
          const gname = godowns.find((g) => g.godown_id === fromGodownId)?.name || 'this godown';
          message.warning(`Selected batch has no stock at ${gname}. Pick another.`);
          setEntry((p) => ({ ...p,
            batch_id: null, batch_number: '',
            manufacture_date: null, expiry_date: null, batch_stock: 0,
          }));
        }
      })
      .catch(() => { /* swallow — fetch effect will re-run */ });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fromGodownId]);

  // Manual override — fires when the operator opens the dropdown and
  // picks a different batch. Refreshes batch_stock + available_stock so
  // the qty chip + addItem stock guard track per-batch on-hand. Also
  // refines the rate to the batch's purchase_rate (per-lot precision).
  const pickBatch = (batchId) => {
    const batch = batchOpts.find((b) => b.batch_id === batchId);
    if (!batch) return;
    setEntry((p) => ({
      ...p,
      batch_id:         batch.batch_id,
      batch_number:     batch.batch_number,
      manufacture_date: batch.manufacture_date,
      expiry_date:      batch.expiry_date,
      batch_stock:      parseFloat(batch.current_stock || 0),
      available_stock:  parseFloat(batch.current_stock || 0),
      rate: parseFloat(batch.purchase_rate) || p.rate || 0,
    }));
  };

  // Days-until-expiry for chip rendering. null → no expiry on file → no
  // chip. Positive → days to go. Negative → expired N days ago.
  const daysUntilExpiry = (expiryDate) => {
    if (!expiryDate) return null;
    const today = dayjs().startOf('day');
    return dayjs(expiryDate).startOf('day').diff(today, 'day');
  };

  // +ADD — push the entry-row buffer onto items. Validates qty>0 and
  // a product is selected; otherwise warns without crashing.
  const handleAddItem = () => {
    if (!fromGodownId || !toGodownId) {
      message.warning('Pick both godowns first');
      return;
    }
    if (fromGodownId === toGodownId) {
      message.warning('From and To godowns must differ');
      return;
    }
    if (!entry.product_id) {
      message.warning('Pick a product');
      prodRef.current?.focus();
      return;
    }
    const q = parseFloat(entry.quantity);
    if (!isFinite(q) || q <= 0) {
      message.warning('Quantity must be > 0');
      qtyRef.current?.focus();
      return;
    }
    // Batch enforcement — global toggle ON + product is batch-tracked
    // ⇒ line MUST carry batch_id. Mirror of the server-side guard.
    if (batchTrackingOn && entry.is_batch_tracked && !entry.batch_id) {
      if (batchOpts.length === 0) {
        message.warning(`"${entry.product_name}" has no batches with stock at this godown.`);
      } else {
        message.warning(`"${entry.product_name}" is batch-tracked. Pick a batch.`);
      }
      return;
    }
    // Per-batch stock guard — overrides the godown-level chip when a
    // batch is picked.
    if (entry.batch_id && entry.batch_stock > 0 && q > entry.batch_stock) {
      message.warning(`Batch ${entry.batch_number} has only ${entry.batch_stock} available at the source godown. Reduce qty or pick another batch.`);
      return;
    }
    setItems((prev) => [
      ...prev,
      {
        key:              itemKeyRef.current++,
        product_id:       entry.product_id,
        product_name:     entry.product_name,
        barcode:          entry.barcode,
        category_id:      entry.category_id,
        category_name:    entry.category_name,
        size:             entry.size,
        article_number:   entry.article_number,
        unit:             entry.unit_type,
        quantity:         q,
        rate:             parseFloat(entry.rate) || 0,
        // Batch identity carried into the persisted line so submit /
        // receive / cancel all operate on the same lot.
        is_batch_tracked: !!entry.is_batch_tracked,
        batch_id:         entry.batch_id || null,
        batch_number:     entry.batch_number || '',
        manufacture_date: entry.manufacture_date || null,
        expiry_date:      entry.expiry_date || null,
      },
    ]);
    // Same cleanup Sales does in addItem (line ~610): clearing
    // activeCatId triggers the preload useEffect to drop prodOpts so
    // the next category change starts fresh, AND we explicitly drop
    // justSelectedRef so the next focus-into-Product opens the
    // dropdown normally instead of being intercepted as a
    // "just-selected → jump to qty" redirect.
    justSelectedRef.current = false;
    setActiveCatId(null);
    setProdOpen(false);
    setEntry(EMPTY_ENTRY);
    setTimeout(() => barcodeRef.current?.focus(), 50);
  };

  // Field updater for entry cells (qty, rate, etc.) — mirrors Sales' `ue`.
  const ue = (field, value) => setEntry((p) => ({ ...p, [field]: value }));

  const removeItem = (key) => setItems((prev) => prev.filter((i) => i.key !== key));

  const updateItem = (key, field, value) => setItems((prev) =>
    prev.map((i) => (i.key === key ? { ...i, [field]: value } : i)),
  );

  const totals = useMemo(() => {
    const totalQty = items.reduce((s, i) => s + parseFloat(i.quantity || 0), 0);
    const totalVal = items.reduce((s, i) => s + parseFloat(i.quantity || 0) * parseFloat(i.rate || 0), 0);
    return { totalQty, totalVal };
  }, [items]);

  /* ── Save paths ───────────────────────────────────────────────────── */

  const collectPayload = async () => {
    const vals = await form.validateFields();
    if (vals.from_godown_id === vals.to_godown_id) {
      message.error('From and To godowns must differ');
      return null;
    }
    if (items.length === 0) {
      message.warning('Add at least one item');
      return null;
    }
    for (const it of items) {
      if (!it.product_id || !it.quantity || it.quantity <= 0) {
        message.warning('Each item needs a product and a positive quantity');
        return null;
      }
    }
    return {
      transfer_date:  vals.transfer_date.format('YYYY-MM-DD'),
      from_godown_id: vals.from_godown_id,
      to_godown_id:   vals.to_godown_id,
      notes:          (vals.notes || '').trim() || null,
      items: items.map((it) => ({
        product_id: it.product_id,
        barcode:    it.barcode,
        quantity:   it.quantity,
        rate:       it.rate || 0,
        // batch_id flows from the picker; null for non-batch products.
        // Server validates that batch-tracked products carry a batch_id
        // when global batch_tracking_enabled is ON.
        batch_id:   it.batch_id || null,
      })),
    };
  };

  const saveDraft = async () => {
    if (submittingRef.current) return;
    const payload = await collectPayload();
    if (!payload) return;
    submittingRef.current = true; setLoading(true);
    try {
      const { data } = await stockTransferAPI.create({ ...payload, status: 'Draft' });
      message.success(`Saved ${data.transfer_number} as draft`);
      nav('/stock-transfers');
    } catch (err) {
      message.error(err?.response?.data?.error || 'Save failed');
    } finally {
      submittingRef.current = false; setLoading(false);
    }
  };

  const saveAndSubmit = async () => {
    if (submittingRef.current) return;
    const payload = await collectPayload();
    if (!payload) return;
    submittingRef.current = true; setLoading(true);
    try {
      const { data } = await stockTransferAPI.create({ ...payload, status: 'In-Transit' });
      message.success(`Submitted ${data.transfer_number} (In-Transit) — source godown deducted`);
      nav('/stock-transfers');
    } catch (err) {
      message.error(err?.response?.data?.error || 'Submit failed');
    } finally {
      submittingRef.current = false; setLoading(false);
    }
  };

  const onSubmitDraft = async () => {
    if (!transfer) return;
    setLoading(true);
    try {
      await stockTransferAPI.submit(transfer.transfer_id);
      message.success(`${transfer.transfer_number} submitted (In-Transit)`);
      nav('/stock-transfers');
    } catch (err) {
      message.error(err?.response?.data?.error || 'Submit failed');
    } finally { setLoading(false); }
  };

  const onReceive = async () => {
    if (!transfer) return;
    setLoading(true);
    try {
      await stockTransferAPI.receive(transfer.transfer_id);
      message.success(`${transfer.transfer_number} received — destination godown updated`);
      nav('/stock-transfers');
    } catch (err) {
      message.error(err?.response?.data?.error || 'Receive failed');
    } finally { setLoading(false); }
  };

  const onCancel = async () => {
    if (!transfer) return;
    setLoading(true);
    try {
      await stockTransferAPI.cancel(transfer.transfer_id, 'Cancelled from form');
      message.success(`${transfer.transfer_number} cancelled`);
      nav('/stock-transfers');
    } catch (err) {
      message.error(err?.response?.data?.error || 'Cancel failed');
    } finally { setLoading(false); }
  };

  /* ── Render ───────────────────────────────────────────────────────── */

  // Items table — columns mirror the Sales bill items table (BARCODE,
  // PRODUCT NAME, SIZE, UNIT, ART#, QTY, RATE ₹, AMOUNT ₹) so an
  // operator who knows the Sales list also knows this one. The Disc%
  // and GST% columns from Sales are intentionally absent here — they
  // stay zero on transfers and would be visual noise.
  const itemColumns = [
    { title: '#', width: 40, render: (_, __, i) => i + 1 },
    {
      title: 'Barcode', dataIndex: 'barcode', width: 120,
      render: (v) => <span style={{ fontFamily: 'var(--font-mono, monospace)', fontSize: 11 }}>{v || '—'}</span>,
    },
    {
      title: 'Product Name', dataIndex: 'product_name',
      render: (v, r) => {
        // Batch sub-line — mirrors the recent SalesBillForm items-table
        // commit so an operator scanning the transfer sees lot identity
        // at a glance. Only renders when the line carries batch_id.
        const subParts = [];
        if (r.batch_number) subParts.push(`Lot ${r.batch_number}`);
        if (r.manufacture_date) subParts.push(`Mfg ${dayjs(r.manufacture_date).format('DD MMM YY')}`);
        if (r.expiry_date)      subParts.push(`Exp ${dayjs(r.expiry_date).format('DD MMM YY')}`);
        return (
          <div>
            <span style={{ fontWeight: 600 }}>{v || '—'}</span>
            {subParts.length > 0 && (
              <div style={{ fontSize: 11, color: 'var(--fg-tertiary)', marginTop: 2 }}>
                {subParts.join(' · ')}
              </div>
            )}
          </div>
        );
      },
    },
    { title: 'Size', dataIndex: 'size', width: 80, render: (v) => v || '—' },
    { title: 'Unit', dataIndex: 'unit', width: 70, render: (v) => v || 'Pcs' },
    {
      title: 'Art#', dataIndex: 'article_number', width: 100,
      render: (v) => v || '—',
    },
    {
      title: 'Qty', dataIndex: 'quantity', width: 100, align: 'right',
      render: (v, r) => readOnly
        ? fmtN(v)
        : <InputNumber min={0.01} step={1} size="small" value={v}
            onChange={(val) => updateItem(r.key, 'quantity', val)} style={{ width: '100%' }} />,
    },
    {
      title: 'Rate ₹', dataIndex: 'rate', width: 110, align: 'right',
      render: (v, r) => readOnly
        ? fmtN(v)
        : <InputNumber min={0} step={1} size="small" value={v}
            onChange={(val) => updateItem(r.key, 'rate', val)} style={{ width: '100%' }} />,
    },
    {
      title: 'Amount ₹', width: 120, align: 'right',
      render: (_, r) => fmtN((parseFloat(r.quantity) || 0) * (parseFloat(r.rate) || 0)),
    },
    !readOnly && {
      title: '', width: 50, align: 'center',
      render: (_, r) => (
        <Button size="small" type="text" danger icon={<DeleteOutlined />}
          onClick={() => removeItem(r.key)} />
      ),
    },
  ].filter(Boolean);

  return (
    <Spin spinning={pgLoading} tip="Loading transfer...">
      {/* `.sbf-page` is the same wrapper Sales / Purchase forms use —
       *  pulls var(--bg-app) + var(--fg-primary) + the form's font and
       *  AntD overrides so this page looks part of the same software
       *  rather than a flat-cream rectangle. Stock Transfer is the
       *  third member of the same form family (sales / purchase /
       *  transfer), so reusing the wrapper keeps the design consistent
       *  by construction. */}
      <div className="stf-page">
        {/* Top context bar — back button + breadcrumb + status pill.
         *  No loud accent chips up here; the visual weight belongs in
         *  the routing card below where the FROM → TO relationship is
         *  the actual subject of the page. */}
        <div className="stf-topbar">
          <Button size="middle" icon={<ArrowLeftOutlined />} onClick={() => nav('/stock-transfers')}>Back</Button>
          <div className="stf-topbar-crumb">
            <a onClick={(e) => { e.preventDefault(); nav('/stock-transfers'); }} href="/stock-transfers">Stock Transfers</a>
            <span className="stf-crumb-sep">/</span>
            <strong>{isEdit ? transferNo : 'New Transfer'}</strong>
          </div>
          <div className="stf-topbar-spacer" />
          {isEdit && <Tag color={STATUS_TONE[status] || 'default'} style={{ fontWeight: 600, fontSize: 12, padding: '2px 12px' }}>{status}</Tag>}
        </div>

        {/* Document header card — FROM → TO routing on top, notes
         *  underneath. The arrow between FROM and TO communicates the
         *  movement at a glance; a transfer challan operator should
         *  see source/destination instantly without label-hunting. */}
        <Form form={form} component={false} disabled={readOnly}>
          <div className="stf-card">
            <div className="stf-card-header">
              <h3 className="stf-card-title">Routing</h3>
              <span className="stf-card-meta">
                {readOnly ? 'Read-only — transfer is in a terminal state' : 'Same legal entity, internal movement (no GST, no party).'}
              </span>
            </div>
            <div className="stf-card-body">
              <div className="stf-routing">
                <div className="stf-route-cell">
                  <div className="stf-route-lbl">From godown<span className="req">*</span></div>
                  <Form.Item name="from_godown_id" noStyle rules={[{ required: true, message: 'Pick source godown' }]}>
                    <Select
                      placeholder="Source"
                      disabled={isEdit}
                      options={godowns.map((g) => ({ value: g.godown_id, label: `${g.code} — ${g.name}` }))}
                    />
                  </Form.Item>
                </div>
                <div className="stf-route-arrow"><SwapOutlined /></div>
                <div className="stf-route-cell">
                  <div className="stf-route-lbl">To godown<span className="req">*</span></div>
                  <Form.Item
                    name="to_godown_id" noStyle
                    rules={[
                      { required: true, message: 'Pick destination godown' },
                      ({ getFieldValue }) => ({
                        validator(_, value) {
                          if (value && value === getFieldValue('from_godown_id')) {
                            return Promise.reject(new Error('From and To must differ'));
                          }
                          return Promise.resolve();
                        },
                      }),
                    ]}
                  >
                    <Select
                      placeholder="Destination"
                      disabled={isEdit}
                      options={godowns.map((g) => ({ value: g.godown_id, label: `${g.code} — ${g.name}` }))}
                    />
                  </Form.Item>
                </div>
                <div className="stf-route-cell">
                  <div className="stf-route-lbl">Date<span className="req">*</span></div>
                  <Form.Item name="transfer_date" noStyle rules={[{ required: true, message: 'Date required' }]}>
                    <DatePicker style={{ width: '100%' }} format="DD-MM-YYYY" />
                  </Form.Item>
                </div>
              </div>
              <div className="stf-notes-row">
                <div className="stf-route-lbl">Notes</div>
                <Form.Item name="notes" noStyle>
                  <Input
                    maxLength={500}
                    placeholder="Reason / vehicle / driver / anything useful for the destination (optional)"
                  />
                </Form.Item>
              </div>
            </div>
          </div>
        </Form>

        {/* Items section — entry strip + items table inside one card.
         *  The card has a clean header showing the items count so an
         *  operator scanning a transfer at a glance sees how many lines
         *  it carries. The entry row + table render as a single dense
         *  block (the card body has padding:0 so the strip + table
         *  occupy the full card width — same hairlines, no gap). */}
        <div className="stf-card stf-items">
          <div className="stf-card-header">
            <h3 className="stf-card-title">Items</h3>
            <span className="stf-card-meta">
              {items.length === 0 ? 'No items yet' : `${items.length} ${items.length === 1 ? 'line' : 'lines'} · ${fmtN(totals.totalQty)} total qty`}
            </span>
          </div>
          <div className="stf-card-body">
        {/* Entry row — full 11-cell strip matching SalesBillForm's
         * .sbf-entry-grid layout 1:1 (same cells, same widths, same
         * order). Two cells are intentionally disabled: Disc% and
         * GST% don't apply to internal stock transfers (no party,
         * no GST) — they render as visually-present-but-greyed cells
         * so the row layout stays identical to a sales bill row.
         *
         * Cell order, mirroring SalesBillForm:
         *   Barcode · Category · Product · Size · Art# · Qty · Rate ₹
         *   · Disc% (N/A) · GST% (N/A) · Unit · +ADD
         *
         * No gridTemplateColumns override — we use the default
         * SalesBillForm template from sales-bill-form.css so cells
         * line up pixel-for-pixel with the sales form.
         */}
        {!readOnly && (
          <div className="sbf-entry-ledger">
            <div className={`sbf-entry-grid${batchTrackingOn ? ' with-batch' : ''}`}>
              <div className="sbf-cell">
                <div className="sbf-cell-lbl">Barcode</div>
                <Input
                  ref={barcodeRef}
                  value={entry.barcode}
                  placeholder="Scan or type"
                  disabled={!fromGodownId}
                  onChange={(e) => ue('barcode', e.target.value)}
                  onPressEnter={(e) => {
                    const v = e.target.value.trim();
                    if (v) { e.target.value = ''; handleScan(v); }
                  }}
                  onKeyDown={(e) => { if (e.key === 'ArrowDown') { e.preventDefault(); prodRef.current?.focus(); } }}
                />
              </div>
              <div className="sbf-cell has-arrow">
                <div className="sbf-cell-lbl">Category</div>
                <Select
                  value={activeCatId}
                  onChange={(v, opt) => {
                    // Reset the just-selected flag here (matches
                    // SalesBillForm line ~1444). Without this, if the
                    // operator picked a product, then clicked +ADD,
                    // then later clicked Product again, the leftover
                    // flag would intercept the first focus and the
                    // dropdown would close before the second click.
                    justSelectedRef.current = false;
                    setActiveCatId(v || null);
                    setEntry((p) => ({
                      ...p,
                      category_id:   v || null,
                      category_name: opt?.children || '',
                      product_name:  '', product_id: null,
                    }));
                  }}
                  placeholder="Category"
                  showSearch
                  filterOption={(input, opt) => !input || opt.children.toLowerCase().includes(input.toLowerCase())}
                  allowClear
                  notFoundContent={null}
                  dropdownMatchSelectWidth={300}
                  disabled={!fromGodownId}
                >
                  {cats.map((c) => (
                    <Select.Option key={c.category_id} value={c.category_id}>{c.category_name}</Select.Option>
                  ))}
                </Select>
              </div>
              <div className="sbf-cell has-arrow">
                <div className="sbf-cell-lbl">Product</div>
                <Select
                  ref={prodRef}
                  /* Mirrors SalesBillForm's product Select 1:1:
                   *   - key={activeCatId??'no-cat'}  remounts on category
                   *     change so the dropdown's option list refreshes
                   *     cleanly without stale opts bleeding through.
                   *   - value={entry.product_id||undefined} + optionLabelProp
                   *     "label" makes the trigger render product_name and
                   *     gives AntD's autoClearSearchValue (default true)
                   *     a chance to wipe the search text on select.
                   *   - onFocus catches the just-selected flag so AntD's
                   *     focus-restore after a click doesn't leave the
                   *     operator stuck back in Product instead of qty.
                   *   - notFoundContent=null keeps "no data" out of the
                   *     way during the brief async window between typing
                   *     and the search firing. */
                  key={activeCatId ?? 'no-cat'}
                  showSearch
                  filterOption={false}
                  optionLabelProp="label"
                  value={entry.product_id || undefined}
                  open={prodOpen}
                  onDropdownVisibleChange={(v) => setProdOpen(v)}
                  onSearch={(v) => { if (v) setProdOpen(true); handleProdSearch(v); }}
                  onSelect={(val, opt) => { setProdOpen(false); handleProdSel(val, opt); }}
                  onFocus={() => {
                    if (justSelectedRef.current) {
                      justSelectedRef.current = false;
                      requestAnimationFrame(() => {
                        prodRef.current?.blur();
                        qtyRef.current?.focus();
                      });
                    }
                  }}
                  onClear={() => {
                    // Same reset as Category-onChange so a clear-then-
                    // click cycle re-opens the dropdown cleanly.
                    justSelectedRef.current = false;
                    setProdOpen(false);
                    setEntry((p) => ({ ...p, product_id: null, product_name: '' }));
                  }}
                  allowClear
                  placeholder={fromGodownId ? 'Product name' : 'Pick source godown first'}
                  disabled={!fromGodownId}
                  notFoundContent={null}
                  listHeight={320}
                  dropdownMatchSelectWidth={460}
                >
                  {prodOpts.map((p) => {
                    const stock = parseFloat(p.current_stock || 0);
                    const stockColor = stock <= 0
                      ? 'var(--danger)'
                      : stock <= 5 ? 'var(--warning)' : 'var(--fg-tertiary)';
                    return (
                      <Select.Option key={p.product_id} value={p.product_id} label={p.product_name} product={p}>
                        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8, padding: '2px 0' }}>
                          <div style={{ minWidth: 0, flex: 1 }}>
                            <div style={{ fontWeight: 600, fontSize: 13, color: 'var(--fg-primary)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                              {p.product_name}
                            </div>
                            <div style={{ fontSize: 10, color: 'var(--fg-tertiary)', marginTop: 1 }}>
                              {[p.Category?.category_name, p.article_number && `Art# ${p.article_number}`, p.size_value && `Size ${p.size_value}`].filter(Boolean).join(' · ')}
                            </div>
                          </div>
                          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 2, flexShrink: 0 }}>
                            <span style={{ color: 'var(--success)', fontWeight: 700, fontSize: 12 }}>
                              ₹{parseFloat(p.purchase_rate || 0).toFixed(2)}
                            </span>
                            <span style={{ color: stockColor, fontSize: 10, fontWeight: 600 }}>
                              {stock <= 0 ? 'Out of stock' : `Stock: ${stock}`}
                            </span>
                          </div>
                        </div>
                      </Select.Option>
                    );
                  })}
                </Select>
              </div>
              {/* Batch picker — only renders when global batch_tracking_enabled
               * is ON. For non-batch products the Select stays disabled
               * (visible-but-inert) so the grid layout doesn't shift on
               * every product pick. Auto-pick + FEFO/FIFO sort + expiry
               * chips all match the SalesBillForm picker (Commit 3) byte-
               * for-byte; same `dropdownMatchSelectWidth`, same
               * `optionLabelProp="label"`, same `onSelect` (not onChange)
               * so Enter on the auto-picked top batch still advances. */}
              {batchTrackingOn && (
                <div className="sbf-cell has-arrow batch-cell">
                  <div className="sbf-cell-lbl">Batch</div>
                  <Select
                    ref={batchSelectRef}
                    value={entry.batch_id || undefined}
                    onSelect={(val) => {
                      pickBatch(val);
                      setBatchOpen(false);
                      requestAnimationFrame(() => qtyRef.current?.focus());
                    }}
                    open={batchOpen}
                    onDropdownVisibleChange={(v) => setBatchOpen(v)}
                    disabled={!entry.product_id || !entry.is_batch_tracked || batchOptsLoading || batchOpts.length === 0}
                    placeholder={!entry.product_id
                      ? 'Pick a product first'
                      : !entry.is_batch_tracked
                        ? 'Not batch-tracked'
                        : batchOptsLoading
                          ? 'Loading…'
                          : (batchOpts.length === 0
                              ? `No batches with stock at ${godowns.find((g) => g.godown_id === fromGodownId)?.name || 'source'}`
                              : 'Pick a batch')}
                    showSearch optionLabelProp="label"
                    filterOption={(input, opt) => !input || (opt.label || '').toLowerCase().includes(input.toLowerCase())}
                    dropdownMatchSelectWidth={380}
                  >
                    {batchOpts.map((b) => {
                      const d = daysUntilExpiry(b.expiry_date);
                      const expChip = d == null
                        ? null
                        : d < 0
                          ? <Tag color="red">Expired</Tag>
                          : d <= batchAlertDays
                            ? <Tag color="orange">{d}d left</Tag>
                            : null;
                      const dateMeta = [
                        b.manufacture_date ? `Mfd ${dayjs(b.manufacture_date).format('DD MMM YY')}` : null,
                        b.expiry_date     ? `Exp ${dayjs(b.expiry_date).format('DD MMM YY')}` : null,
                      ].filter(Boolean).join(' · ');
                      return (
                        <Select.Option key={b.batch_id} value={b.batch_id} label={b.batch_number}>
                          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8, padding: '2px 0' }}>
                            <div style={{ minWidth: 0, flex: 1 }}>
                              <div style={{ fontWeight: 600, fontSize: 13, color: 'var(--fg-primary)' }}>{b.batch_number}</div>
                              <div style={{ fontSize: 10, color: 'var(--fg-tertiary)', marginTop: 1 }}>
                                Stock: {b.current_stock}{dateMeta ? ` · ${dateMeta}` : ''}
                              </div>
                            </div>
                            <div style={{ flexShrink: 0 }}>{expChip}</div>
                          </div>
                        </Select.Option>
                      );
                    })}
                  </Select>
                </div>
              )}
              <div className="sbf-cell">
                <div className="sbf-cell-lbl">Size</div>
                <Input ref={sizeRef} value={entry.size} placeholder=""
                  onChange={(e) => ue('size', e.target.value)}
                  onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); artRef.current?.focus(); } }}
                />
              </div>
              <div className="sbf-cell">
                <div className="sbf-cell-lbl">Art #</div>
                <Input ref={artRef} value={entry.article_number} placeholder=""
                  onChange={(e) => ue('article_number', e.target.value)}
                  onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); qtyRef.current?.focus(); } }}
                />
              </div>
              <div className="sbf-cell numeric">
                <div className="sbf-cell-lbl">Qty</div>
                <InputNumber
                  ref={qtyRef}
                  keyboard={false}
                  value={entry.quantity || undefined}
                  min={0}
                  placeholder=""
                  style={{ width: '100%' }}
                  onChange={(v) => ue('quantity', v || 0)}
                  onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); rateRef.current?.focus(); } }}
                />
              </div>
              <div className="sbf-cell numeric">
                <div className="sbf-cell-lbl">Rate ₹</div>
                <InputNumber
                  ref={rateRef}
                  keyboard={false}
                  value={entry.rate || undefined}
                  min={0}
                  placeholder=""
                  style={{ width: '100%' }}
                  onChange={(v) => ue('rate', v || 0)}
                  onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); handleAddItem(); } }}
                />
              </div>
              {/* Disc% — N/A for stock transfers (internal movement, no
                  party, no discount). Disabled placeholder so the entry
                  row's column count + widths match a sales bill row 1:1. */}
              <Tooltip title="Discounts don't apply to stock transfers — same legal entity.">
                <div className="sbf-cell numeric">
                  <div className="sbf-cell-lbl">Disc%</div>
                  <InputNumber disabled value={undefined} placeholder="—" style={{ width: '100%' }} />
                </div>
              </Tooltip>
              {/* GST% — N/A for stock transfers (no outward/inward supply). */}
              <Tooltip title="GST doesn't apply to stock transfers — same legal entity.">
                <div className="sbf-cell numeric">
                  <div className="sbf-cell-lbl">GST%</div>
                  <InputNumber disabled value={undefined} placeholder="—" style={{ width: '100%' }} />
                </div>
              </Tooltip>
              <div className="sbf-cell has-arrow">
                <div className="sbf-cell-lbl">Unit</div>
                <Select value={entry.unit_type || 'Pcs'} placeholder=""
                  onChange={(v) => ue('unit_type', v)}>
                  {UNITS.map((u) => <Select.Option key={u} value={u}>{u}</Select.Option>)}
                </Select>
              </div>
              <button onClick={handleAddItem} className="sbf-cell add" type="button">
                <span className="sbf-cell-add-text">ADD</span>
              </button>
            </div>
            {entry.available_stock > 0 && (
              <span className={`sbf-stock-chip ${entry.quantity > entry.available_stock ? 'low' : 'ok'}`}>
                Stock at source: {entry.available_stock}
              </span>
            )}
          </div>
        )}

            {/* Items table — table summary row removed in favour of the
             *  card footer summary below. The footer is more readable
             *  than a sub-row tucked into the table chrome and matches
             *  the pattern used on Sales / Purchase footers. */}
            <Table
              rowKey="key"
              dataSource={items}
              columns={itemColumns}
              pagination={false}
              size="small"
              locale={{ emptyText: <div className="stf-items-empty">No items yet — scan a barcode or pick a product above to add the first line.</div> }}
            />
          </div>
        </div>

        {/* Footer — summary metrics on the left, primary actions on the
         *  right. Mirrors the rhythm a sales bill closes on (totals +
         *  save) so an operator's eye lands in the right place to commit
         *  the transfer. */}
        <div className="stf-footer">
          <div className="stf-summary">
            <div className="stf-summary-item">
              <span className="stf-summary-lbl">Total qty</span>
              <span className="stf-summary-val">{fmtN(totals.totalQty)}</span>
            </div>
            <div className="stf-summary-item">
              <span className="stf-summary-lbl">Total value</span>
              <span className="stf-summary-val is-money">₹ {fmtN(totals.totalVal)}</span>
            </div>
            <div className="stf-summary-item">
              <span className="stf-summary-lbl">Lines</span>
              <span className="stf-summary-val">{items.length}</span>
            </div>
          </div>
        </div>

        {/* ── ACTION STRIP — registry-driven; handles every status path.
            New mode  → F2 Save Draft + F1 Submit (saveAndSubmit) primary
            Edit Draft → F1 Submit (onSubmitDraft) primary + F8 Cancel
            Edit In-Transit → F1 Mark Received primary + F8 Cancel
            Edit terminal → just Esc Back. */}
        <ActionStrip
          actions={[
            {
              id: 'back', key: 'Esc', label: 'Back',
              onAction: () => nav('/stock-transfers'),
            },
            // New mode: Save Draft
            {
              id: 'save-draft', key: 'F2', label: 'Save Draft',
              hidden: isEdit,
              disabled: loading,
              onAction: saveDraft,
              title: 'Save without deducting stock',
            },
            // Cancel — appears for editable statuses
            {
              id: 'cancel', key: 'F8', label: 'Cancel Transfer', tone: 'danger',
              hidden: !isEdit || (status !== 'Draft' && status !== 'In-Transit'),
              disabled: loading,
              onAction: () => Modal.confirm({
                title: `Cancel ${transferNo}?`,
                content: status === 'In-Transit'
                  ? 'Stock at the source godown will be restored.'
                  : 'No stock has moved — this just marks the transfer cancelled.',
                okText: 'Cancel transfer', okButtonProps: { danger: true },
                cancelText: 'Keep it',
                onOk: onCancel,
              }),
            },
            // Primary action — label and handler vary by mode/status.
            {
              id: 'primary',
              key: 'F1',
              label: !isEdit
                ? 'Submit (In-Transit)'
                : (status === 'Draft' ? 'Submit'
                    : status === 'In-Transit' ? 'Mark Received'
                    : 'Open'),
              tone: 'primary',
              hidden: isEdit && status !== 'Draft' && status !== 'In-Transit',
              disabled: loading,
              onAction: !isEdit
                ? saveAndSubmit
                : (status === 'Draft' ? onSubmitDraft
                    : status === 'In-Transit' ? onReceive
                    : () => {}),
              title: !isEdit
                ? 'Saves and immediately deducts stock from the source godown'
                : (status === 'Draft' ? 'Deduct from source godown — moves to In-Transit'
                    : status === 'In-Transit' ? 'Add to destination godown — moves to Received'
                    : ''),
            },
          ]}
        />
      </div>
    </Spin>
  );
}
