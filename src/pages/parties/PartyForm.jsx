import React, { useState } from 'react';
import { Modal, Form, Input, Select, InputNumber, Switch, Row, Col, Divider, Button, Space, message } from 'antd';
import { DeleteOutlined, StopOutlined, ExclamationCircleOutlined } from '@ant-design/icons';
import { partyAPI } from '../../api';

const { Option } = Select;
const { confirm } = Modal;

const indianStates = [
  'Andhra Pradesh', 'Arunachal Pradesh', 'Assam', 'Bihar', 'Chhattisgarh', 'Goa', 'Gujarat',
  'Haryana', 'Himachal Pradesh', 'Jharkhand', 'Karnataka', 'Kerala', 'Madhya Pradesh',
  'Maharashtra', 'Manipur', 'Meghalaya', 'Mizoram', 'Nagaland', 'Odisha', 'Punjab',
  'Rajasthan', 'Sikkim', 'Tamil Nadu', 'Telangana', 'Tripura', 'Uttar Pradesh',
  'Uttarakhand', 'West Bengal', 'Delhi', 'Jammu & Kashmir', 'Ladakh',
];

export default function PartyForm({ visible, onCancel, onSubmit, onDeleted, initialValues, partyType, loading }) {
  const [form] = Form.useForm();
  const [deleteLoading, setDeleteLoading] = useState(false);
  const isEdit = !!initialValues?.party_id;

  React.useEffect(() => {
    if (visible) {
      if (initialValues) {
        form.setFieldsValue(initialValues);
      } else {
        form.resetFields();
        form.setFieldsValue({ party_type: partyType, party_status: 'Regular', credit_allowed: false });
      }
    }
  }, [visible, initialValues]);

  const handleSubmit = async () => {
    const values = await form.validateFields();
    onSubmit(values);
  };

  const handleDelete = () => {
    confirm({
      title: `Delete ${partyType}?`,
      icon: <ExclamationCircleOutlined style={{ color: '#dc2626' }} />,
      content: `Are you sure you want to permanently delete "${initialValues?.party_name}"? This cannot be undone.`,
      okText: 'Delete',
      okButtonProps: { danger: true },
      cancelText: 'Cancel',
      onOk: async () => {
        setDeleteLoading(true);
        try {
          await partyAPI.delete(initialValues.party_id);
          message.success(`${partyType} deleted`);
          onDeleted(initialValues.party_id);
        } catch (err) {
          const errData = err.response?.data;
          if (errData?.canDeactivate) {
            // Has transactions — offer deactivate instead
            Modal.confirm({
              title: 'Cannot Delete — Has Transactions',
              icon: <ExclamationCircleOutlined style={{ color: '#f59e0b' }} />,
              content: (
                <div>
                  <p style={{ marginBottom: 8 }}>{errData.error}</p>
                  <p style={{ color: '#6b7280', fontSize: 13 }}>
                    Would you like to <strong>deactivate</strong> this {partyType.toLowerCase()} instead?
                    Inactive parties won't appear in transaction forms.
                  </p>
                </div>
              ),
              okText: `Deactivate ${partyType}`,
              okButtonProps: { style: { background: '#f59e0b', borderColor: '#f59e0b' } },
              cancelText: 'Cancel',
              onOk: async () => {
                await partyAPI.update(initialValues.party_id, { is_active: false });
                message.success(`${partyType} deactivated`);
                onDeleted(initialValues.party_id);
              },
            });
          } else {
            message.error(errData?.error || 'Failed to delete');
          }
        } finally {
          setDeleteLoading(false);
        }
      },
    });
  };

  return (
    <Modal
      title={isEdit ? `Edit ${partyType}` : `Add ${partyType}`}
      open={visible}
      onCancel={onCancel}
      width={700}
      destroyOnClose
      footer={
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          {/* Delete button only in edit mode */}
          {isEdit ? (
            <Button
              danger
              icon={<DeleteOutlined />}
              loading={deleteLoading}
              onClick={handleDelete}
            >
              Delete {partyType}
            </Button>
          ) : <span />}
          <Space>
            <Button onClick={onCancel}>Cancel</Button>
            <Button type="primary" loading={loading} onClick={handleSubmit}>
              {isEdit ? 'Save Changes' : `Add ${partyType}`}
            </Button>
          </Space>
        </div>
      }
    >
      <Form form={form} layout="vertical" size="middle">
        <Row gutter={16}>
          <Col span={12}>
            <Form.Item name="party_name" label="Party Name" rules={[{ required: true, min: 2 }]}>
              <Input placeholder="Enter name" autoFocus />
            </Form.Item>
          </Col>
          <Col span={12}>
            <Form.Item name="display_name" label="Display Name">
              <Input placeholder="Display name (optional)" />
            </Form.Item>
          </Col>
        </Row>

        <Row gutter={16}>
          <Col span={8}>
            <Form.Item name="mobile_1" label="Mobile 1" rules={[{ required: true, message: 'Required' }]}>
              <Input placeholder="10 digit mobile" maxLength={10} />
            </Form.Item>
          </Col>
          <Col span={8}>
            <Form.Item name="mobile_2" label="Mobile 2">
              <Input placeholder="Alternate mobile" maxLength={10} />
            </Form.Item>
          </Col>
          <Col span={8}>
            <Form.Item name="email" label="Email" rules={[{ type: 'email', message: 'Invalid email' }]}>
              <Input placeholder="Email address" />
            </Form.Item>
          </Col>
        </Row>

        <Divider orientation="left" plain>Address</Divider>
        <Row gutter={16}>
          <Col span={12}>
            <Form.Item name="address_line_1" label="Address Line 1">
              <Input placeholder="Street address" />
            </Form.Item>
          </Col>
          <Col span={12}>
            <Form.Item name="address_line_2" label="Address Line 2">
              <Input placeholder="Area / Landmark" />
            </Form.Item>
          </Col>
        </Row>
        <Row gutter={16}>
          <Col span={8}>
            <Form.Item name="city" label="City">
              <Input placeholder="City" />
            </Form.Item>
          </Col>
          <Col span={8}>
            <Form.Item name="state" label="State">
              <Select placeholder="Select state" showSearch allowClear>
                {indianStates.map(s => <Option key={s} value={s}>{s}</Option>)}
              </Select>
            </Form.Item>
          </Col>
          <Col span={8}>
            <Form.Item name="pincode" label="Pincode">
              <Input placeholder="Pincode" maxLength={6} />
            </Form.Item>
          </Col>
        </Row>

        <Divider orientation="left" plain>Tax Information</Divider>
        <Row gutter={16}>
          <Col span={8}>
            <Form.Item name="gstin" label="GSTIN">
              <Input placeholder="15 char GSTIN" maxLength={15} style={{ textTransform: 'uppercase' }} />
            </Form.Item>
          </Col>
          <Col span={8}>
            <Form.Item name="pan_number" label="PAN Number">
              <Input placeholder="PAN" maxLength={10} style={{ textTransform: 'uppercase' }} />
            </Form.Item>
          </Col>
          <Col span={8}>
            <Form.Item name="aadhar_number" label="Aadhar Number">
              <Input placeholder="Aadhar" maxLength={12} />
            </Form.Item>
          </Col>
        </Row>

        <Divider orientation="left" plain>Credit Settings</Divider>
        <Row gutter={16}>
          <Col span={6}>
            <Form.Item name="credit_allowed" label="Credit Allowed" valuePropName="checked">
              <Switch />
            </Form.Item>
          </Col>
          <Col span={6}>
            <Form.Item name="credit_limit" label="Credit Limit">
              <InputNumber style={{ width: '100%' }} min={0} prefix="₹" />
            </Form.Item>
          </Col>
          <Col span={6}>
            <Form.Item name="credit_days" label="Credit Days">
              <InputNumber style={{ width: '100%' }} min={0} suffix="days" />
            </Form.Item>
          </Col>
          <Col span={6}>
            <Form.Item name="interest_rate" label="Interest Rate">
              <InputNumber style={{ width: '100%' }} min={0} max={100} suffix="%" />
            </Form.Item>
          </Col>
        </Row>

        <Divider orientation="left" plain>Opening Balance</Divider>
        <Row gutter={16}>
          <Col span={8}>
            <Form.Item name="opening_balance" label="Amount">
              <InputNumber style={{ width: '100%' }} min={0} prefix="₹" />
            </Form.Item>
          </Col>
          <Col span={8}>
            <Form.Item name="opening_balance_type" label="Type">
              <Select>
                <Option value="Receivable">Receivable</Option>
                <Option value="Payable">Payable</Option>
              </Select>
            </Form.Item>
          </Col>
          <Col span={8}>
            <Form.Item name="party_status" label="Status">
              <Select>
                <Option value="Regular">Regular</Option>
                <Option value="Priority">Priority</Option>
                <Option value="VIP">VIP</Option>
                <Option value="Blacklist">Blacklist</Option>
              </Select>
            </Form.Item>
          </Col>
        </Row>

        <Form.Item name="party_type" hidden><Input /></Form.Item>
      </Form>
    </Modal>
  );
}
