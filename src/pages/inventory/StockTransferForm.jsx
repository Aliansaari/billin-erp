import React, { useEffect, useMemo, useRef, useState, useCallback } from 'react';
import { Form, DatePicker, Select, Input, InputNumber, Button, Table, Tag, Space, message, Popconfirm, Spin, Tooltip } from 'antd';
import { useNavigate, useParams } from 'react-router-dom';
import { SwapOutlined, DeleteOutlined, SaveOutlined, SendOutlined, CheckCircleOutlined, CloseCircleOutlined, ArrowLeftOutlined } from '@ant-design/icons';
import dayjs from 'dayjs';
import { stockTransferAPI, godownAPI, productAPI, categoryAPI } from '../../api';
// Reuse the Sales bill form's entry-ledger CSS verbatim so the entry
// row visually matches its sibling on the Sales/Purchase forms — same
// hairlines, same cell padding, same focus state, same dotted column
// dividers, same +ADD button. We use the SAME .sbf-entry-grid (which
// has hardcoded 11-column layout in CSS) so the cells line up exactly
// with what an operator sees on Sales.
import '../sales/sales-bill-form.css';

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
  // searchValue is the controlled query the operator typed. Resetting it
  // on select is the single point of control that makes the Select clear
  // back to placeholder after each pick — without this, AntD leaves the
  // last typed string in the box and the operator has to backspace before
  // searching for the next item.
  const [searchValue, setSearchValue] = useState('');
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
  const handleProdSearch = useCallback((v) => {
    setSearchValue(v);
    if (searchTimerRef.current) clearTimeout(searchTimerRef.current);
    if (!v) { setProdOpts([]); return; }
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
      } catch { /* surface as empty result; server-side error already toasted globally */ }
    }, 150);
  }, [fromGodownId, activeCatId]);

  // Pick a product → fill the entry-row buffer (NOT items — bill-form
  // pattern: edit qty/rate first, then click +ADD). Mirrors
  // SalesBillForm's handleProdSel; jumps focus to the qty cell so the
  // operator can immediately type a quantity.
  const handleProdSel = (val, opt) => {
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
      rate:            parseFloat(p.purchase_rate) || 0,
      available_stock: parseFloat(p.current_stock) || 0,
    }));
    // Clear sequence — order matters: drop the search text first so the
    // controlled `searchValue` resets to '', then close the dropdown,
    // then drop the cached options so the next open starts empty.
    setSearchValue('');
    setProdOpen(false);
    setProdOpts([]);
    // Keyboard rhythm — jump straight into qty so the operator can
    // type the count without reaching for the mouse.
    setTimeout(() => qtyRef.current?.focus(), 30);
  };

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
      // For barcode-driven entry: push directly with quantity 1, the
      // way scanner-led counters expect ("scan, scan, scan, save").
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
          rate:           parseFloat(p.purchase_rate) || 0,
        },
      ]);
      setEntry(EMPTY_ENTRY);
      barcodeRef.current?.focus();
    } catch (err) {
      message.error(err?.response?.data?.error || `Failed to look up ${code}`);
    }
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
    setItems((prev) => [
      ...prev,
      {
        key:            itemKeyRef.current++,
        product_id:     entry.product_id,
        product_name:   entry.product_name,
        barcode:        entry.barcode,
        category_id:    entry.category_id,
        category_name:  entry.category_name,
        size:           entry.size,
        article_number: entry.article_number,
        unit:           entry.unit_type,
        quantity:       q,
        rate:           parseFloat(entry.rate) || 0,
      },
    ]);
    setEntry(EMPTY_ENTRY);
    barcodeRef.current?.focus();
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
      render: (v) => <span style={{ fontWeight: 600 }}>{v || '—'}</span>,
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
      <div style={{ padding: 24, maxWidth: 1200, margin: '0 auto' }}>
        {/* Header strip */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 16, flexWrap: 'wrap' }}>
          <Button icon={<ArrowLeftOutlined />} onClick={() => nav('/stock-transfers')}>Back</Button>
          <h2 style={{ margin: 0, display: 'flex', alignItems: 'center', gap: 10 }}>
            <SwapOutlined /> {isEdit ? 'Stock Transfer' : 'New Stock Transfer'}
          </h2>
          {isEdit && (
            <>
              <span style={{ fontFamily: 'var(--font-mono, monospace)', fontWeight: 600, fontSize: 14 }}>
                {transferNo}
              </span>
              <Tag color={STATUS_TONE[status] || 'default'} style={{ fontWeight: 600 }}>{status}</Tag>
            </>
          )}
        </div>

        {/* Form header — godowns + date + notes */}
        <Form form={form} layout="vertical" disabled={readOnly}>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 200px', columnGap: 12 }}>
            <Form.Item
              name="from_godown_id" label="From godown"
              rules={[{ required: true, message: 'Pick source godown' }]}
            >
              <Select
                placeholder="Source"
                disabled={isEdit}
                options={godowns.map((g) => ({ value: g.godown_id, label: `${g.code} — ${g.name}` }))}
              />
            </Form.Item>
            <Form.Item
              name="to_godown_id" label="To godown"
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
            <Form.Item
              name="transfer_date" label="Date"
              rules={[{ required: true, message: 'Date required' }]}
            >
              <DatePicker style={{ width: '100%' }} format="DD-MM-YYYY" />
            </Form.Item>
          </div>
          <Form.Item name="notes" label="Notes (optional)">
            <Input.TextArea rows={2} maxLength={500} placeholder="Reason / vehicle / driver / anything useful for the destination" />
          </Form.Item>
        </Form>

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
            <div className="sbf-entry-grid">
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
                  key={`prod-${fromGodownId || 'no'}-${activeCatId || 'all'}`}
                  showSearch
                  filterOption={false}
                  optionLabelProp="label"
                  value={entry.product_name || undefined}
                  searchValue={searchValue}
                  open={prodOpen}
                  onDropdownVisibleChange={(v) => setProdOpen(v)}
                  onSearch={(v) => { setProdOpen(true); handleProdSearch(v); }}
                  onSelect={(val, opt) => handleProdSel(val, opt)}
                  onClear={() => { setProdOpen(false); setEntry((p) => ({ ...p, product_id: null, product_name: '' })); }}
                  allowClear
                  placeholder={fromGodownId ? 'Product name' : 'Pick source godown first'}
                  disabled={!fromGodownId}
                  notFoundContent={prodSearching ? 'Searching…' : null}
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

        {/* Items table */}
        <Table
          rowKey="key"
          dataSource={items}
          columns={itemColumns}
          pagination={false}
          size="small"
          locale={{ emptyText: readOnly ? 'No items.' : 'No items yet — add one above.' }}
          style={{ background: 'var(--bg-elevated, white)' }}
          summary={() => items.length === 0 ? null : (
            <Table.Summary.Row>
              {/* Columns now: # · Barcode · Product · Size · Unit · Art#
                  · Qty · Rate · Amount · (Action). Span the first 6 to
                  carry the "Total" label across product-meta columns,
                  then put totals under Qty + Amount. Action cell empty. */}
              <Table.Summary.Cell index={0} colSpan={6}><b>Total</b></Table.Summary.Cell>
              <Table.Summary.Cell index={6} align="right"><b>{fmtN(totals.totalQty)}</b></Table.Summary.Cell>
              <Table.Summary.Cell index={7} />
              <Table.Summary.Cell index={8} align="right"><b>₹ {fmtN(totals.totalVal)}</b></Table.Summary.Cell>
              {!readOnly && <Table.Summary.Cell index={9} />}
            </Table.Summary.Row>
          )}
        />

        {/* Action bar */}
        <div style={{ display: 'flex', gap: 8, marginTop: 16, justifyContent: 'flex-end', flexWrap: 'wrap' }}>
          {/* Create mode buttons */}
          {!isEdit && (
            <>
              <Button icon={<SaveOutlined />} loading={loading} onClick={saveDraft}>
                Save Draft
              </Button>
              <Tooltip title="Saves and immediately deducts stock from the source godown">
                <Button type="primary" icon={<SendOutlined />} loading={loading} onClick={saveAndSubmit}>
                  Submit (In-Transit)
                </Button>
              </Tooltip>
            </>
          )}
          {/* Edit mode — Draft */}
          {isEdit && status === 'Draft' && (
            <>
              <Tooltip title="Deduct from source godown — moves to In-Transit">
                <Button type="primary" icon={<SendOutlined />} loading={loading} onClick={onSubmitDraft}>
                  Submit
                </Button>
              </Tooltip>
              <Popconfirm title={`Cancel ${transferNo}?`} okText="Cancel transfer" okButtonProps={{ danger: true }} onConfirm={onCancel}>
                <Button danger icon={<CloseCircleOutlined />} loading={loading}>Cancel</Button>
              </Popconfirm>
            </>
          )}
          {/* Edit mode — In-Transit */}
          {isEdit && status === 'In-Transit' && (
            <>
              <Tooltip title="Add to destination godown — moves to Received">
                <Button type="primary" icon={<CheckCircleOutlined />} loading={loading} onClick={onReceive}>
                  Mark Received
                </Button>
              </Tooltip>
              <Popconfirm
                title={`Cancel ${transferNo}?`}
                description="Stock at the source will be restored."
                okText="Cancel transfer" okButtonProps={{ danger: true }}
                onConfirm={onCancel}
              >
                <Button danger icon={<CloseCircleOutlined />} loading={loading}>Cancel</Button>
              </Popconfirm>
            </>
          )}
          {/* Terminal states — view only */}
        </div>
      </div>
    </Spin>
  );
}
