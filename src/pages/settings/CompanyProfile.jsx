import React, { useEffect, useState } from 'react';
import { Card, Form, Input, Button, DatePicker, Row, Col, Typography, message, Divider } from 'antd';
import { SaveOutlined } from '@ant-design/icons';
import dayjs from 'dayjs';
import { settingsAPI } from '../../api';

const { Title } = Typography;
const { TextArea } = Input;

export default function CompanyProfile() {
  const [form] = Form.useForm();
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);

  useEffect(() => { loadSettings(); }, []);

  const loadSettings = async () => {
    setLoading(true);
    try {
      const { data } = await settingsAPI.getSystem();
      // handle both response shapes: { data: settings } and bare settings object
      const s = (data && data.data) ? data.data : data;
      if (!s) throw new Error('No settings returned');
      form.setFieldsValue({
        company_name:          s.company_name || '',
        company_address:       s.company_address || '',
        gstin:                 s.gstin || '',
        pan_number:            s.pan_number || '',
        financial_year_start:  s.financial_year_start ? dayjs(s.financial_year_start) : null,
        financial_year_end:    s.financial_year_end   ? dayjs(s.financial_year_end)   : null,
      });
    } catch (error) {
      console.error('CompanyProfile load error:', error);
      message.error('Failed to load company settings');
    } finally {
      setLoading(false);
    }
  };

  const handleSave = async (values) => {
    setSaving(true);
    try {
      await settingsAPI.updateSystem({
        ...values,
        financial_year_start: values.financial_year_start?.format('YYYY-MM-DD'),
        financial_year_end:   values.financial_year_end?.format('YYYY-MM-DD'),
      });
      message.success('Company profile updated successfully');
    } catch (error) {
      message.error('Failed to update company profile');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div>
      <Title level={3}>Company Profile</Title>
      <Card loading={loading}>
        <Form form={form} layout="vertical" onFinish={handleSave}>
          <Row gutter={16}>
            <Col xs={24} md={12}>
              <Form.Item name="company_name" label="Company Name" rules={[{ required: true, message: 'Please enter company name' }]}>
                <Input placeholder="Enter company name" />
              </Form.Item>
            </Col>
            <Col xs={24} md={12}>
              <Form.Item name="gstin" label="GSTIN">
                <Input placeholder="Enter GSTIN" />
              </Form.Item>
            </Col>
          </Row>

          <Row gutter={16}>
            <Col xs={24} md={12}>
              <Form.Item name="pan_number" label="PAN Number">
                <Input placeholder="Enter PAN number" />
              </Form.Item>
            </Col>
          </Row>

          <Form.Item name="company_address" label="Company Address">
            <TextArea rows={3} placeholder="Enter full company address" />
          </Form.Item>

          <Divider>Financial Year</Divider>

          <Row gutter={16}>
            <Col xs={24} md={12}>
              <Form.Item name="financial_year_start" label="Financial Year Start" rules={[{ required: true, message: 'Please select start date' }]}>
                <DatePicker style={{ width: '100%' }} format="DD-MM-YYYY" />
              </Form.Item>
            </Col>
            <Col xs={24} md={12}>
              <Form.Item name="financial_year_end" label="Financial Year End" rules={[{ required: true, message: 'Please select end date' }]}>
                <DatePicker style={{ width: '100%' }} format="DD-MM-YYYY" />
              </Form.Item>
            </Col>
          </Row>

          <Form.Item>
            <Button type="primary" htmlType="submit" icon={<SaveOutlined />} loading={saving}>
              Save Changes
            </Button>
          </Form.Item>
        </Form>
      </Card>
    </div>
  );
}
