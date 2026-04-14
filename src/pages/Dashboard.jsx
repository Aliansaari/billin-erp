import React, { useEffect, useState } from 'react';
import { Row, Col, Card, Statistic, Button, Table, Tag, Space, Typography, Spin, Tooltip } from 'antd';
import {
  ShoppingOutlined,
  ShoppingCartOutlined,
  DollarOutlined,
  WarningOutlined,
  PlusOutlined,
  ArrowUpOutlined,
  ArrowDownOutlined,
  FundOutlined,
  RiseOutlined,
  FallOutlined,
  ThunderboltOutlined,
  ReloadOutlined,
} from '@ant-design/icons';
import { useNavigate } from 'react-router-dom';
import { reportAPI } from '../api';
import dayjs from 'dayjs';

const { Title, Text } = Typography;

const fmt = (v) => `₹ ${parseFloat(v || 0).toLocaleString('en-IN', { minimumFractionDigits: 2 })}`;

export default function Dashboard() {
  const [stats, setStats] = useState(null);
  const [loading, setLoading] = useState(true);
  const navigate = useNavigate();

  useEffect(() => { loadStats(); }, []);

  const loadStats = async () => {
    setLoading(true);
    try {
      const { data } = await reportAPI.getDashboard();
      setStats(data);
    } catch (error) {
      console.error('Failed to load dashboard:', error);
    } finally {
      setLoading(false);
    }
  };

  if (loading) {
    return (
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '60vh' }}>
        <div style={{ textAlign: 'center' }}>
          <Spin size="large" />
          <div style={{ marginTop: 16, color: '#6b7280', fontSize: 14 }}>Loading dashboard...</div>
        </div>
      </div>
    );
  }

  const statCards = [
    {
      title: "Today's Sales",
      value: stats?.today_sales?.total || 0,
      count: stats?.today_sales?.count || 0,
      icon: <ShoppingOutlined />,
      color: '#10B981',
      gradient: 'linear-gradient(135deg, #10B981, #34D399)',
      bg: '#ecfdf5',
      link: '/sales',
      suffix: 'bills',
    },
    {
      title: "Today's Purchases",
      value: stats?.today_purchases?.total || 0,
      count: stats?.today_purchases?.count || 0,
      icon: <ShoppingCartOutlined />,
      color: '#4F46E5',
      gradient: 'linear-gradient(135deg, #4F46E5, #818CF8)',
      bg: '#eef2ff',
      link: '/purchases',
      suffix: 'bills',
    },
    {
      title: 'Receivables',
      value: stats?.receivables?.total || 0,
      count: stats?.receivables?.count || 0,
      icon: <ArrowDownOutlined />,
      color: '#F59E0B',
      gradient: 'linear-gradient(135deg, #F59E0B, #FBBF24)',
      bg: '#fffbeb',
      link: '/reports/party-ledger',
      suffix: 'parties',
    },
    {
      title: 'Payables',
      value: stats?.payables?.total || 0,
      count: stats?.payables?.count || 0,
      icon: <ArrowUpOutlined />,
      color: '#EF4444',
      gradient: 'linear-gradient(135deg, #EF4444, #F87171)',
      bg: '#fef2f2',
      link: '/reports/party-ledger',
      suffix: 'parties',
    },
  ];

  const summaryCards = [
    { title: 'Monthly Sales', value: stats?.monthly_sales || 0, icon: <RiseOutlined />, color: '#10B981' },
    { title: 'Monthly Purchases', value: stats?.monthly_purchases || 0, icon: <FallOutlined />, color: '#4F46E5' },
    { title: 'Monthly Profit', value: stats?.monthly_profit || 0, icon: <FundOutlined />, color: (stats?.monthly_profit || 0) >= 0 ? '#10B981' : '#EF4444' },
    { title: 'Low Stock Alerts', value: stats?.low_stock_count || 0, icon: <WarningOutlined />, color: (stats?.low_stock_count || 0) > 0 ? '#EF4444' : '#10B981', isCount: true, link: '/stock-report' },
  ];

  const statusColor = (s) => s === 'Paid' ? 'success' : s === 'Partial' ? 'warning' : 'error';

  const billColumns = (type) => [
    {
      title: 'Bill No',
      dataIndex: 'bill_number',
      width: 150,
      render: (v) => <Text strong style={{ fontSize: 13, color: '#4F46E5' }}>{v}</Text>,
    },
    {
      title: type === 'sales' ? 'Customer' : 'Supplier',
      dataIndex: type === 'sales' ? ['customer', 'party_name'] : ['supplier', 'party_name'],
      render: (v) => v || <Text type="secondary" italic>Cash Sale</Text>,
      ellipsis: true,
    },
    {
      title: 'Amount',
      dataIndex: 'total_amount',
      align: 'right',
      width: 130,
      render: (v) => <Text strong>{fmt(v)}</Text>,
    },
    {
      title: 'Status',
      dataIndex: 'payment_status',
      width: 90,
      align: 'center',
      render: (s) => <Tag color={statusColor(s)} style={{ margin: 0 }}>{s}</Tag>,
    },
  ];

  return (
    <div>
      {/* Page Header */}
      <div style={{
        display: 'flex',
        justifyContent: 'space-between',
        alignItems: 'flex-start',
        marginBottom: 24,
        gap: 12,
        flexWrap: 'wrap',
      }}>
        <div style={{ minWidth: 0 }}>
          <Title level={3} style={{ margin: 0, fontWeight: 700, color: '#1f2937' }}>Dashboard</Title>
          <Text type="secondary" style={{ fontSize: 13 }}>
            {dayjs().format('dddd, DD MMMM YYYY')} — Welcome back!
          </Text>
        </div>
        <Space size={8} wrap>
          <Tooltip title="Refresh (F5)">
            <Button icon={<ReloadOutlined />} onClick={loadStats} />
          </Tooltip>
          <Button
            type="primary"
            icon={<PlusOutlined />}
            onClick={() => navigate('/sale/new')}
            className="erp-quick-action-btn"
          >
            New Sale <kbd className="erp-kbd" style={{ marginLeft: 6, background: 'rgba(255,255,255,0.2)', color: '#fff', borderColor: 'rgba(255,255,255,0.3)', boxShadow: 'none' }}>Alt+S</kbd>
          </Button>
          <Button
            icon={<PlusOutlined />}
            onClick={() => navigate('/purchase/new')}
            className="erp-quick-action-btn"
          >
            New Purchase <kbd className="erp-kbd" style={{ marginLeft: 6 }}>Alt+P</kbd>
          </Button>
          <Button icon={<DollarOutlined />} onClick={() => navigate('/payment/new')} className="erp-quick-action-btn">
            Payment
          </Button>
        </Space>
      </div>

      {/* Main Stat Cards */}
      <Row gutter={[20, 20]}>
        {statCards.map((card, i) => (
          <Col xs={24} sm={12} lg={6} key={i}>
            <Card
              className={`erp-stat-card ${['green','blue','orange','red'][i]}`}
              hoverable
              onClick={() => navigate(card.link)}
              bodyStyle={{ padding: 20 }}
            >
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
                <div>
                  <Text style={{ color: '#6b7280', fontSize: 13, fontWeight: 500 }}>{card.title}</Text>
                  <div style={{ fontSize: 26, fontWeight: 700, color: '#1f2937', margin: '4px 0', lineHeight: 1.2 }}>
                    {fmt(card.value)}
                  </div>
                  <Text style={{ color: '#9ca3af', fontSize: 12 }}>
                    {card.count} {card.suffix}
                  </Text>
                </div>
                <div style={{
                  width: 48, height: 48, borderRadius: 12,
                  background: card.bg,
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                  fontSize: 22, color: card.color,
                }}>
                  {card.icon}
                </div>
              </div>
            </Card>
          </Col>
        ))}
      </Row>

      {/* Summary Row */}
      <Row gutter={[20, 20]} style={{ marginTop: 20 }}>
        {summaryCards.map((card, i) => (
          <Col xs={24} sm={12} lg={6} key={i}>
            <Card
              className="erp-stat-card purple"
              bodyStyle={{ padding: 20 }}
              hoverable={!!card.link}
              onClick={() => card.link && navigate(card.link)}
            >
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <div>
                  <Text style={{ color: '#6b7280', fontSize: 13, fontWeight: 500 }}>{card.title}</Text>
                  <div style={{ fontSize: 22, fontWeight: 700, color: card.color, marginTop: 4 }}>
                    {card.isCount ? card.value : fmt(card.value)}
                    {card.isCount && card.value > 0 && <Text style={{ fontSize: 13, color: '#9ca3af', marginLeft: 4 }}>items</Text>}
                  </div>
                </div>
                <div style={{
                  width: 40, height: 40, borderRadius: 10,
                  background: `${card.color}15`,
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                  fontSize: 18, color: card.color,
                }}>
                  {card.icon}
                </div>
              </div>
            </Card>
          </Col>
        ))}
      </Row>

      {/* Recent Bills */}
      <Row gutter={[20, 20]} style={{ marginTop: 20 }}>
        <Col xs={24} lg={12}>
          <Card
            title={
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <div style={{ width: 8, height: 8, borderRadius: '50%', background: '#10B981' }} />
                <span style={{ fontWeight: 600, color: '#1f2937' }}>Recent Sales</span>
              </div>
            }
            extra={
              <Button type="link" onClick={() => navigate('/sales')} style={{ fontWeight: 500 }}>
                View All →
              </Button>
            }
            bodyStyle={{ padding: 0 }}
          >
            <Table
              columns={billColumns('sales')}
              dataSource={stats?.recent_sales || []}
              rowKey="sales_bill_id"
              pagination={false}
              size="small"
              scroll={{ y: 280 }}
              locale={{ emptyText: <div style={{ padding: 40, color: '#9ca3af' }}>No sales today</div> }}
            />
          </Card>
        </Col>
        <Col xs={24} lg={12}>
          <Card
            title={
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <div style={{ width: 8, height: 8, borderRadius: '50%', background: '#4F46E5' }} />
                <span style={{ fontWeight: 600, color: '#1f2937' }}>Recent Purchases</span>
              </div>
            }
            extra={
              <Button type="link" onClick={() => navigate('/purchases')} style={{ fontWeight: 500 }}>
                View All →
              </Button>
            }
            bodyStyle={{ padding: 0 }}
          >
            <Table
              columns={billColumns('purchases')}
              dataSource={stats?.recent_purchases || []}
              rowKey="purchase_bill_id"
              pagination={false}
              size="small"
              scroll={{ y: 280 }}
              locale={{ emptyText: <div style={{ padding: 40, color: '#9ca3af' }}>No purchases today</div> }}
            />
          </Card>
        </Col>
      </Row>
    </div>
  );
}
