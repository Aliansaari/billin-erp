import React, { useEffect, useMemo, useRef, useState, useCallback } from 'react';
import { Form, DatePicker, Select, Input, InputNumber, Button, Table, Tag, Space, message, Popconfirm, Spin, Tooltip } from 'antd';
import { useNavigate, useParams } from 'react-router-dom';
import { SwapOutlined, DeleteOutlined, SaveOutlined, SendOutlined, CheckCircleOutlined, CloseCircleOutlined, ArrowLeftOutlined } from '@ant-design/icons';
import dayjs from 'dayjs';
import { stockTransferAPI, godownAPI, productAPI } from '../../api';

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
  const itemKeyRef    = useRef(1);
  const submittingRef = useRef(false);
  // Sales-form parity: debounce timer + stale-request id so concurrent
  // typed characters don't race and overwrite the latest result set.
  const searchTimerRef = useRef(null);
  const searchReqRef   = useRef(0);

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
          ...(fromGodownId ? { godown_id: fromGodownId } : {}),
        });
        if (reqId !== searchReqRef.current) return;
        setProdOpts(data.data || []);
      } catch { /* surface as empty result; server-side error already toasted globally */ }
    }, 150);
  }, [fromGodownId]);

  // Pick a product → push as a transfer line. Mirrors handleProdSel
  // shape from the bill forms (qty defaults from quantity_per_box,
  // rate snapshots purchase_rate for valuation). Then clears the
  // picker so the next character the operator types starts a fresh
  // search instead of appending to the previous query.
  const handleProdSel = (val, opt) => {
    const p = opt?.product;
    if (!p) return;
    const qty = parseFloat(p.quantity_per_box) || 1;
    addItem({
      product_id:   p.product_id,
      product_name: p.product_name,
      barcode:      p.barcode,
      unit:         p.unit_of_measurement || 'PCS',
      quantity:     qty,
      rate:         parseFloat(p.purchase_rate) || 0,
    });
    // Clear sequence — order matters: drop the search text first so the
    // controlled `searchValue` resets to '', then close the dropdown,
    // then drop the cached options so the next open starts empty.
    setSearchValue('');
    setProdOpen(false);
    setProdOpts([]);
  };

  const addItem = (it) => {
    if (!fromGodownId || !toGodownId) {
      message.warning('Pick both godowns first');
      return;
    }
    if (fromGodownId === toGodownId) {
      message.warning('From and To godowns must differ');
      return;
    }
    setItems((prev) => [...prev, { key: itemKeyRef.current++, ...it }]);
  };

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

  const itemColumns = [
    { title: '#', width: 40, render: (_, __, i) => i + 1 },
    {
      title: 'Product', dataIndex: 'product_name',
      render: (v, r) => (
        <div style={{ minWidth: 200 }}>
          <div style={{ fontWeight: 600 }}>{v || '—'}</div>
          <div style={{ color: 'var(--fg-tertiary, #9ca3af)', fontSize: 11, fontFamily: 'var(--font-mono, monospace)' }}>
            {r.barcode || '—'}
          </div>
        </div>
      ),
    },
    {
      title: 'Qty', dataIndex: 'quantity', width: 120, align: 'right',
      render: (v, r) => readOnly
        ? <span>{fmtN(v)} <span style={{ color: 'var(--fg-tertiary)', fontSize: 11 }}>{r.unit || ''}</span></span>
        : <InputNumber min={0.01} step={1} size="small" value={v}
            onChange={(val) => updateItem(r.key, 'quantity', val)} style={{ width: '100%' }} />,
    },
    {
      title: 'Rate', dataIndex: 'rate', width: 130, align: 'right',
      render: (v, r) => readOnly
        ? <span>₹ {fmtN(v)}</span>
        : <InputNumber min={0} step={1} size="small" value={v} prefix="₹"
            onChange={(val) => updateItem(r.key, 'rate', val)} style={{ width: '100%' }} />,
    },
    {
      title: 'Amount', width: 130, align: 'right',
      render: (_, r) => `₹ ${fmtN((parseFloat(r.quantity) || 0) * (parseFloat(r.rate) || 0))}`,
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

        {/* Product picker.
         *
         * Mirrors the Sales bill form's `.sbf-cell` Product picker
         * 1:1 — same Select props, same option rendering, same
         * dropdown width, same label-on-top treatment. Differences
         * from the Sales picker: standalone (not inside an entry-row
         * grid), and onSelect adds a row to `items` rather than
         * setting an entry. Everything else — including the after-
         * select clear-search behaviour — is identical.
         *
         * Why these props matter:
         *   - filterOption=false       → server-side search, no
         *                                client-side prefiltering
         *   - optionLabelProp="label"  → selected-value renders as
         *                                plain product_name, not the
         *                                option's grid <div> (without
         *                                this AntD tries to inject the
         *                                whole layout into the select
         *                                trigger and the cell collapses)
         *   - controlled `open` state  → picking closes the dropdown
         *                                synchronously
         *   - controlled `searchValue` → reset on select so the next
         *                                keystroke starts a fresh
         *                                search instead of appending
         *                                to the previous query
         *   - dropdownMatchSelectWidth=460 → same width as Sales
         */}
        {!readOnly && (
          <div
            style={{
              display: 'flex', flexDirection: 'column',
              padding: '4px 12px',
              borderTop: '1px solid var(--border-subtle, #f1f5f9)',
              borderBottom: '1px solid var(--border-subtle, #f1f5f9)',
              marginBottom: 8,
              position: 'relative',
            }}
          >
            <div style={{
              fontSize: 9, textTransform: 'uppercase', letterSpacing: 1.2,
              fontWeight: 700, color: 'var(--fg-tertiary)',
              lineHeight: '14px', whiteSpace: 'nowrap',
            }}>
              Product
            </div>
            <Select
              key={`prod-${fromGodownId || 'no'}`}
              showSearch
              filterOption={false}
              optionLabelProp="label"
              value={undefined}
              searchValue={searchValue}
              open={prodOpen}
              onDropdownVisibleChange={(v) => setProdOpen(v)}
              onSearch={(v) => { setProdOpen(true); handleProdSearch(v); }}
              onSelect={(val, opt) => handleProdSel(val, opt)}
              allowClear
              placeholder={fromGodownId ? 'Product name' : 'Pick source godown first'}
              disabled={!fromGodownId}
              notFoundContent={prodSearching ? 'Searching…' : null}
              listHeight={320}
              dropdownMatchSelectWidth={460}
              variant="borderless"
              style={{ width: '100%' }}
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
              <Table.Summary.Cell index={0} colSpan={2}><b>Total</b></Table.Summary.Cell>
              <Table.Summary.Cell index={2} align="right"><b>{fmtN(totals.totalQty)}</b></Table.Summary.Cell>
              <Table.Summary.Cell index={3} />
              <Table.Summary.Cell index={4} align="right"><b>₹ {fmtN(totals.totalVal)}</b></Table.Summary.Cell>
              {!readOnly && <Table.Summary.Cell index={5} />}
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
