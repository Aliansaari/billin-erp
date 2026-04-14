import React, { useEffect, useState } from 'react';
import { Card, DatePicker, Typography, Space, Row, Col, Spin, message } from 'antd';
import dayjs from 'dayjs';
import { reportAPI } from '../../api';

const { Title, Text } = Typography;

const fmt = (v) => `₹ ${parseFloat(v || 0).toLocaleString('en-IN', { minimumFractionDigits: 2 })}`;

// Financial year: April to March
const fyStart = () => {
  const now = dayjs();
  return now.month() < 3 ? dayjs().subtract(1, 'year').month(3).startOf('month') : dayjs().month(3).startOf('month');
};
const fyEnd = () => {
  const now = dayjs();
  return now.month() < 3 ? dayjs().month(2).endOf('month') : dayjs().add(1, 'year').month(2).endOf('month');
};

export default function ProfitLoss() {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(false);
  const [dateRange, setDateRange] = useState({
    from_date: fyStart().format('YYYY-MM-DD'),
    to_date: fyEnd().format('YYYY-MM-DD'),
  });

  useEffect(() => {
    loadData();
  }, [dateRange]);

  const loadData = async () => {
    setLoading(true);
    try {
      const res = await reportAPI.getProfitLoss(dateRange);
      setData(res.data);
    } catch (e) {
      message.error('Failed to load Profit & Loss report');
    }
    setLoading(false);
  };

  const income = data?.income || {};
  const expenses = data?.expenses || {};
  const netProfit = parseFloat(data?.net_profit || 0);

  const totalIncome = Object.values(income).reduce((s, v) => s + parseFloat(v || 0), 0);
  const totalExpenses = Object.values(expenses).reduce((s, v) => s + parseFloat(v || 0), 0);

  const sectionStyle = {
    border: '1px solid #f0f0f0',
    borderRadius: 4,
    padding: 0,
    marginBottom: 16,
  };

  const headerStyle = (bg) => ({
    background: bg,
    padding: '10px 16px',
    fontWeight: 600,
    fontSize: 15,
    borderBottom: '1px solid #f0f0f0',
    display: 'flex',
    justifyContent: 'space-between',
  });

  const lineStyle = {
    display: 'flex',
    justifyContent: 'space-between',
    padding: '8px 16px',
    borderBottom: '1px solid #f5f5f5',
  };

  const formatLabel = (key) => {
    return key
      .replace(/_/g, ' ')
      .replace(/\b\w/g, (c) => c.toUpperCase());
  };

  return (
    <div style={{ height: '100%', display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
      {/* Page Header */}
      <div className="erp-page-header" style={{ padding: '12px 20px', marginBottom: 0, background: '#fff', borderBottom: '1px solid #f0f0f0', flexShrink: 0 }}>
        <div className="erp-page-header-title">
          <Title level={3} style={{ margin: 0, fontWeight: 700, color: '#1f2937' }}>Profit & Loss Statement</Title>
          <span style={{ fontSize: 13, color: '#6b7280' }}>Financial summary for selected period</span>
        </div>
        <DatePicker.RangePicker
          format="DD-MMM-YYYY"
          defaultValue={[fyStart(), fyEnd()]}
          onChange={(v) => setDateRange({
            from_date: v?.[0]?.format('YYYY-MM-DD') || null,
            to_date: v?.[1]?.format('YYYY-MM-DD') || null,
          })}
        />
      </div>

      <Card bodyStyle={{ padding: 20, flex: 1, overflow: 'auto' }}
        style={{ flex: 1, minHeight: 0 }}>
      <Spin spinning={loading}>
        {data && (
          <Row gutter={32}>
            {/* Left column: Income */}
            <Col xs={24} md={12}>
              <div style={sectionStyle}>
                <div style={headerStyle('#f6ffed')}>
                  <span>Income</span>
                  <span>{fmt(totalIncome)}</span>
                </div>
                {Object.entries(income).map(([key, value]) => (
                  <div key={key} style={lineStyle}>
                    <Text>{formatLabel(key)}</Text>
                    <Text>{fmt(value)}</Text>
                  </div>
                ))}
                <div style={{ ...lineStyle, background: '#f6ffed', fontWeight: 600, borderBottom: 'none' }}>
                  <Text strong>Total Income</Text>
                  <Text strong style={{ color: '#3f8600' }}>{fmt(totalIncome)}</Text>
                </div>
              </div>
            </Col>

            {/* Right column: Expenses */}
            <Col xs={24} md={12}>
              <div style={sectionStyle}>
                <div style={headerStyle('#fff2f0')}>
                  <span>Expenses</span>
                  <span>{fmt(totalExpenses)}</span>
                </div>
                {Object.entries(expenses).map(([key, value]) => (
                  <div key={key} style={lineStyle}>
                    <Text>{formatLabel(key)}</Text>
                    <Text>{fmt(value)}</Text>
                  </div>
                ))}
                <div style={{ ...lineStyle, background: '#fff2f0', fontWeight: 600, borderBottom: 'none' }}>
                  <Text strong>Total Expenses</Text>
                  <Text strong style={{ color: '#cf1322' }}>{fmt(totalExpenses)}</Text>
                </div>
              </div>
            </Col>

            {/* Net Profit / Loss */}
            <Col span={24}>
              <div
                style={{
                  background: netProfit >= 0 ? '#f6ffed' : '#fff2f0',
                  border: `2px solid ${netProfit >= 0 ? '#b7eb8f' : '#ffa39e'}`,
                  borderRadius: 6,
                  padding: '16px 24px',
                  display: 'flex',
                  justifyContent: 'space-between',
                  alignItems: 'center',
                }}
              >
                <Title level={4} style={{ margin: 0 }}>
                  {netProfit >= 0 ? 'Net Profit' : 'Net Loss'}
                </Title>
                <Title
                  level={3}
                  style={{ margin: 0, color: netProfit >= 0 ? '#3f8600' : '#cf1322' }}
                >
                  {fmt(Math.abs(netProfit))}
                </Title>
              </div>
            </Col>
          </Row>
        )}

        {!data && !loading && (
          <div style={{ textAlign: 'center', padding: 60 }}>
            <Text type="secondary">Select a date range to view Profit & Loss</Text>
          </div>
        )}
      </Spin>
      </Card>
    </div>
  );
}
