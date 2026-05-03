import React, { useEffect, useState } from 'react';
import { Modal, Form, Input, InputNumber, Select, Row, Col, Divider, DatePicker, Switch, message } from 'antd';
import { BarcodeOutlined, TagsOutlined } from '@ant-design/icons';
import dayjs from 'dayjs';
import { productAPI, categoryAPI, settingsAPI } from '../api';

/*
 * ProductFormModal — the create-product form, reused as-is by both
 * Inventory → Products → Add (the original home) and the +Add Product
 * shortcut on the Purchase form entry row.
 *
 * Same fields, same validation, same /products POST endpoint as the
 * Inventory page's existing form. Edit mode is intentionally NOT in
 * scope here — Inventory → Products keeps its own inline edit modal.
 * This component only exists to give the purchase-form +Add button a
 * functionally-identical create flow without leaving the bill.
 *
 * Props:
 *   open       — boolean, controlled
 *   onCancel   — close without saving
 *   onSaved    — called with the freshly-created product after save
 *   defaultName — optional, pre-fills product_name (e.g. whatever the
 *                 operator was typing in the picker before clicking +Add)
 */
export default function ProductFormModal({ open, onCancel, onSaved, defaultName }) {
  const [form] = Form.useForm();
  const [categories, setCategories] = useState([]);
  const [batchTrackingEnabled, setBatchTrackingEnabled] = useState(false);
  const [loading, setLoading] = useState(false);

  // Categories + global batch flag are needed every time the modal
  // opens. Cheap to refetch — the page using this component may have
  // been open for hours, and a Settings change in another tab should
  // surface here on next open.
  useEffect(() => {
    if (!open) return;
    categoryAPI.getAllFlat().then(({ data }) => setCategories(data || [])).catch(() => {});
    settingsAPI.getSystem().then(({ data }) => {
      const s = (data && data.data) ? data.data : data;
      setBatchTrackingEnabled(!!s?.batch_tracking_enabled);
    }).catch(() => {});
    form.resetFields();
    form.setFieldsValue({
      opening_stock_date: dayjs(),
      product_name: defaultName || undefined,
    });
  }, [open, defaultName, form]);

  const marginChanged = () => {
    const pr = form.getFieldValue('purchase_rate') || 0;
    const mg = form.getFieldValue('margin_percentage') || 0;
    form.setFieldsValue({ sale_rate: +(pr * (1 + mg / 100)).toFixed(2) });
  };

  const handleSubmit = async () => {
    setLoading(true);
    try {
      const values = await form.validateFields();
      if (values.opening_stock_date) {
        values.opening_stock_date = dayjs(values.opening_stock_date).format('YYYY-MM-DD');
      }
      const { data } = await productAPI.create(values);
      // productAPI.create returns either the product directly or
      // { existing: true, product } if the name+size+article+qpb
      // already matched. Either shape is "use this product."
      const product = data?.product || data;
      message.success(`Product added — Barcode: ${product?.barcode || ''}`);
      onSaved && onSaved(product);
    } catch (e) {
      if (e?.errorFields) return; // validation errors already inline
      message.error(e.response?.data?.error || 'Failed to save');
    } finally {
      setLoading(false);
    }
  };

  return (
    <Modal
      title="Add New Product"
      open={open}
      onCancel={onCancel}
      onOk={handleSubmit}
      confirmLoading={loading}
      width={680}
      destroyOnClose
      okText="Add Product"
    >
      <Form form={form} layout="vertical" size="middle">
        <Row gutter={16}>
          <Col span={8}>
            <Form.Item name="barcode" label="Barcode" help="Leave blank to auto-generate">
              <Input placeholder="Auto-generate" prefix={<BarcodeOutlined />} />
            </Form.Item>
          </Col>
          <Col span={8}>
            <Form.Item name="category_id" label="Category" rules={[{ required: true, message: 'Required' }]}>
              <Select placeholder="Select category" showSearch optionFilterProp="children">
                {categories.map(c => <Select.Option key={c.category_id} value={c.category_id}>{c.category_name}</Select.Option>)}
              </Select>
            </Form.Item>
          </Col>
          <Col span={8}>
            <Form.Item name="product_name" label="Product Name" rules={[{ required: true, message: 'Required' }]}>
              <Input placeholder="Product name" />
            </Form.Item>
          </Col>
        </Row>
        <Row gutter={16}>
          <Col span={6}><Form.Item name="size_value" label="Size"><Input placeholder="S/M/L/XL" /></Form.Item></Col>
          <Col span={6}><Form.Item name="article_number" label="Article No"><Input /></Form.Item></Col>
          <Col span={6}><Form.Item name="hsn_code" label="HSN Code"><Input /></Form.Item></Col>
          <Col span={6}><Form.Item name="gst_rate" label="GST %"><InputNumber style={{ width: '100%' }} min={0} /></Form.Item></Col>
        </Row>
        <Row gutter={16}>
          <Col span={6}>
            <Form.Item name="unit_of_measurement" label="Unit" initialValue="PCS">
              <Select>{['PCS','KG','METER','LITER','BOX','DOZEN'].map(u => <Select.Option key={u}>{u}</Select.Option>)}</Select>
            </Form.Item>
          </Col>
          <Col span={6}><Form.Item name="quantity_per_box" label="Qty/Box"><InputNumber style={{ width: '100%' }} min={1} /></Form.Item></Col>
          <Col span={6}><Form.Item name="minimum_stock_level" label="Min Stock"><InputNumber style={{ width: '100%' }} min={0} /></Form.Item></Col>
          <Col span={6}><Form.Item name="reorder_level" label="Reorder Level"><InputNumber style={{ width: '100%' }} min={0} /></Form.Item></Col>
        </Row>
        <Divider plain>Pricing</Divider>
        <Row gutter={16}>
          <Col span={6}>
            <Form.Item name="purchase_rate" label="Purchase Rate" rules={[{ required: true }]}>
              <InputNumber style={{ width: '100%' }} min={0} prefix="₹" onChange={marginChanged} />
            </Form.Item>
          </Col>
          <Col span={6}>
            <Form.Item name="margin_percentage" label="Margin %">
              <InputNumber style={{ width: '100%' }} min={0} suffix="%" onChange={marginChanged} />
            </Form.Item>
          </Col>
          <Col span={6}>
            <Form.Item name="sale_rate" label="Sale Rate" rules={[{ required: true }]}>
              <InputNumber style={{ width: '100%' }} min={0} prefix="₹" />
            </Form.Item>
          </Col>
          <Col span={6}>
            <Form.Item name="mrp" label="MRP">
              <InputNumber style={{ width: '100%' }} min={0} prefix="₹" />
            </Form.Item>
          </Col>
        </Row>

        {batchTrackingEnabled && (
          <>
            <Divider plain><span style={{ fontWeight: 600 }}><TagsOutlined /> Batch Tracking</span></Divider>
            <Row gutter={16}>
              <Col span={24}>
                <Form.Item
                  name="is_batch_tracked"
                  label="Track by batch"
                  valuePropName="checked"
                  style={{ marginBottom: 4 }}
                  extra={<span style={{ fontSize: 12, color: '#6b7280' }}>Each unit can be grouped into a batch with its own dates and (optional) expiry. Batch picker appears on purchases, sales, returns, and transfers.</span>}
                >
                  <Switch checkedChildren="ON" unCheckedChildren="OFF" />
                </Form.Item>
              </Col>
            </Row>
          </>
        )}

        <Divider plain><span style={{ color: 'var(--ed-accent)', fontWeight: 600 }}>Opening Stock</span></Divider>
        <div style={{ background: 'var(--ed-accent-s)', border: '1px solid var(--ed-accent-b)', borderRadius: 8, padding: '12px 16px' }}>
          <Row gutter={16}>
            <Col span={8}>
              <Form.Item name="opening_stock" label="Opening Qty" style={{ marginBottom: 0 }}>
                <InputNumber style={{ width: '100%' }} min={0} placeholder="0" precision={2} />
              </Form.Item>
            </Col>
            <Col span={8}>
              <Form.Item name="opening_stock_rate" label="Rate / Unit" style={{ marginBottom: 0 }}>
                <InputNumber style={{ width: '100%' }} min={0} prefix="₹" placeholder="Purchase rate" precision={2} />
              </Form.Item>
            </Col>
            <Col span={8}>
              <Form.Item name="opening_stock_date" label="As of Date" style={{ marginBottom: 0 }}>
                <DatePicker style={{ width: '100%' }} format="DD/MM/YYYY" />
              </Form.Item>
            </Col>
          </Row>
          <div style={{ marginTop: 8, fontSize: 12, color: 'var(--ed-fg-3)' }}>
            Leave Opening Qty blank or 0 if no opening stock.
          </div>
        </div>
      </Form>
    </Modal>
  );
}
