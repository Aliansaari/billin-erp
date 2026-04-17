import React, { useEffect, useState } from 'react';
import { Card, DatePicker, Typography, Space, Row, Col, Spin, message } from 'antd';
import dayjs from 'dayjs';
import { reportAPI } from '../../api';

const { Title, Text } = Typography;

const fmt = (v) => `₹ ${parseFloat(v || 0).toLocaleString('en-IN', { minimumFractionDigits: 2 })}`;

// Indian Financial Year: April 1 – March 31.
// Snapshot `now` once so both the comparison and the derived date use the
// exact same reference time — without this, calling dayjs() twice across
// month boundaries (e.g. at 23:59:59 on Mar 31) could put fyStart and fyEnd
// in different FYs and render an impossible range.
const fyStart = () => {
  const now = dayjs();
  return now.month() < 3
    ? now.subtract(1, 'year').month(3).startOf('month')  // Jan-Mar → FY began Apr last year
    : now.month(3).startOf('month');                      // Apr-Dec → FY began Apr this year
};
const fyEnd = () => {
  const now = dayjs();
  return now.month() < 3
    ? now.month(2).endOf('month')                         // Jan-Mar → FY ends Mar this year
    : now.add(1, 'year').month(2).endOf('month');         // Apr-Dec → FY ends Mar next year
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

  // Map backend response to display shape.
  // Backend returns { revenue: { sales_gross, sales, sales_return, net_sales },
  //                   cost_of_goods: { purchases_gross, purchases, purchase_return, net_purchases },
  //                   taxes: { gst_collected, gst_paid, gst_liability },
  //                   gross_profit, gross_margin, net_profit }
  // The revenue/cost_of_goods figures are already TAX-EXCLUDED — which is the
  // correct accounting basis for P&L. GST is shown as a separate tax panel.
  const rev  = data?.revenue || {};
  const cogs = data?.cost_of_goods || {};
  const tax  = data?.taxes || {};

  const income = {
    sales:        parseFloat(rev.sales || 0),          // sales excl. GST
    sales_return: -parseFloat(rev.sales_return || 0),  // shown as negative
  };
  const expenses = {
    purchases:       parseFloat(cogs.purchases || 0),      // purchases excl. GST
    purchase_return: -parseFloat(cogs.purchase_return || 0),
  };

  const totalIncome   = parseFloat(rev.net_sales || 0);
  const totalExpenses = parseFloat(cogs.net_purchases || 0);
  const netProfit     = parseFloat(data?.net_profit ?? data?.gross_profit ?? 0);
  const grossMargin   = parseFloat(data?.gross_margin || 0);
  const gstCollected  = parseFloat(tax.gst_collected || 0);
  const gstPaid       = parseFloat(tax.gst_paid || 0);
  const gstLiability  = parseFloat(tax.gst_liability || 0);

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
          allowClear={false}
          defaultValue={[fyStart(), fyEnd()]}
          onChange={(v) => {
            // If the picker is cleared, fall back to the Indian financial year
            // (Apr 1 – Mar 31). Never send null dates — the P&L statement is
            // meaningless without a period.
            const from = v?.[0]?.format('YYYY-MM-DD') || fyStart().format('YYYY-MM-DD');
            const to   = v?.[1]?.format('YYYY-MM-DD') || fyEnd().format('YYYY-MM-DD');
            setDateRange({ from_date: from, to_date: to });
          }}
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
                <div>
                  <Title level={4} style={{ margin: 0 }}>
                    {netProfit >= 0 ? 'Net Profit' : 'Net Loss'}
                  </Title>
                  {grossMargin !== 0 && (
                    <Text type="secondary" style={{ fontSize: 12 }}>
                      Gross margin: {grossMargin.toFixed(1)}%
                    </Text>
                  )}
                </div>
                <Title
                  level={3}
                  style={{ margin: 0, color: netProfit >= 0 ? '#3f8600' : '#cf1322' }}
                >
                  {fmt(Math.abs(netProfit))}
                </Title>
              </div>
            </Col>

            {/* GST summary — separate from P&L because tax is a liability, not income */}
            <Col span={24} style={{ marginTop: 16 }}>
              <div style={sectionStyle}>
                <div style={headerStyle('#e6f7ff')}>
                  <span>GST Summary (separate from P&L — tax is a liability, not profit)</span>
                </div>
                <div style={lineStyle}>
                  <Text>GST Collected on Sales (output)</Text>
                  <Text>{fmt(gstCollected)}</Text>
                </div>
                <div style={lineStyle}>
                  <Text>GST Paid on Purchases (input credit)</Text>
                  <Text>{fmt(gstPaid)}</Text>
                </div>
                <div style={{ ...lineStyle, background: '#e6f7ff', fontWeight: 600, borderBottom: 'none' }}>
                  <Text strong>
                    {gstLiability >= 0 ? 'Net GST Payable' : 'Net GST Credit (refundable)'}
                  </Text>
                  <Text strong style={{ color: gstLiability >= 0 ? '#cf1322' : '#3f8600' }}>
                    {fmt(Math.abs(gstLiability))}
                  </Text>
                </div>
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
