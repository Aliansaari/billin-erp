import React, { useEffect, useState } from 'react';
import { Card, Tabs, Table, Tag, Typography, Descriptions, Spin, DatePicker, Space, Button } from 'antd';
import { ArrowLeftOutlined } from '@ant-design/icons';
import { useParams, useNavigate } from 'react-router-dom';
import dayjs from 'dayjs';
import { partyAPI } from '../../api';

const { Title, Text } = Typography;

export default function PartyDetail() {
  const { id } = useParams();
  const navigate = useNavigate();
  const [party, setParty] = useState(null);
  const [ledger, setLedger] = useState(null);
  const [loading, setLoading] = useState(true);
  const [dateRange, setDateRange] = useState([dayjs().startOf('year'), dayjs()]);

  useEffect(() => { loadParty(); loadLedger(); }, [id]);

  const loadParty = async () => {
    try {
      const { data } = await partyAPI.getById(id);
      setParty(data);
    } catch (e) { console.error(e); }
    setLoading(false);
  };

  const loadLedger = async () => {
    try {
      const { data } = await partyAPI.getLedger(id, {
        from_date: dateRange[0].format('YYYY-MM-DD'),
        to_date: dateRange[1].format('YYYY-MM-DD'),
      });
      setLedger(data);
    } catch (e) { console.error(e); }
  };

  const fmt = (v) => `₹ ${parseFloat(v || 0).toLocaleString('en-IN', { minimumFractionDigits: 2 })}`;

  if (loading) return <Spin size="large" style={{ display: 'block', margin: '100px auto' }} />;
  if (!party) return <div>Party not found</div>;

  const ledgerColumns = [
    { title: 'Date', dataIndex: 'date', key: 'date', width: 110, render: (v) => dayjs(v).format('DD-MMM-YY') },
    { title: 'Particulars', dataIndex: 'particulars', key: 'particulars', width: 180 },
    { title: 'Ref No', dataIndex: 'ref_number', key: 'ref', width: 140 },
    { title: 'Debit', dataIndex: 'debit', key: 'debit', width: 120, align: 'right',
      render: (v) => v > 0 ? fmt(v) : '-' },
    { title: 'Credit', dataIndex: 'credit', key: 'credit', width: 120, align: 'right',
      render: (v) => v > 0 ? <Text type="success">{fmt(v)}</Text> : '-' },
    { title: 'Balance', dataIndex: 'balance', key: 'balance', width: 130, align: 'right',
      render: (v) => <Text strong style={{ color: v > 0 ? '#ff4d4f' : '#52c41a' }}>{fmt(Math.abs(v))}</Text> },
  ];

  return (
    <div>
      <Space style={{ marginBottom: 16 }}>
        <Button icon={<ArrowLeftOutlined />} onClick={() => navigate(-1)}>Back</Button>
        <Title level={4} style={{ margin: 0 }}>{party.party_name}</Title>
        <Tag color={party.party_type === 'Customer' ? 'blue' : 'green'}>{party.party_type}</Tag>
        <Tag color={party.party_status === 'VIP' ? 'gold' : 'default'}>{party.party_status}</Tag>
      </Space>

      <Tabs defaultActiveKey="ledger" items={[
        {
          key: 'ledger',
          label: 'Ledger',
          children: (
            <Card>
              <Space style={{ marginBottom: 16 }}>
                <DatePicker.RangePicker
                  value={dateRange}
                  onChange={(v) => { setDateRange(v); }}
                  format="DD-MM-YYYY"
                />
                <Button type="primary" onClick={loadLedger}>Apply</Button>
              </Space>
              <Table
                columns={ledgerColumns}
                dataSource={ledger?.entries || []}
                rowKey={(r, i) => i}
                pagination={false}
                size="small"
                scroll={{ y: 500 }}
                summary={() => ledger ? (
                  <Table.Summary fixed>
                    <Table.Summary.Row>
                      <Table.Summary.Cell index={0} colSpan={3}><Text strong>Total</Text></Table.Summary.Cell>
                      <Table.Summary.Cell index={3} align="right"><Text strong>{fmt(ledger.total_debit)}</Text></Table.Summary.Cell>
                      <Table.Summary.Cell index={4} align="right"><Text strong type="success">{fmt(ledger.total_credit)}</Text></Table.Summary.Cell>
                      <Table.Summary.Cell index={5} align="right">
                        <Text strong style={{ color: ledger.closing_balance > 0 ? '#ff4d4f' : '#52c41a' }}>
                          {fmt(Math.abs(ledger.closing_balance))} {ledger.closing_balance > 0 ? '(Dr)' : '(Cr)'}
                        </Text>
                      </Table.Summary.Cell>
                    </Table.Summary.Row>
                  </Table.Summary>
                ) : null}
              />
            </Card>
          ),
        },
        {
          key: 'info',
          label: 'Info',
          children: (
            <Card>
              <Descriptions bordered column={2} size="small">
                <Descriptions.Item label="Party Name">{party.party_name}</Descriptions.Item>
                <Descriptions.Item label="Display Name">{party.display_name}</Descriptions.Item>
                <Descriptions.Item label="Mobile 1">{party.mobile_1}</Descriptions.Item>
                <Descriptions.Item label="Mobile 2">{party.mobile_2}</Descriptions.Item>
                <Descriptions.Item label="Email">{party.email}</Descriptions.Item>
                <Descriptions.Item label="Type">{party.party_type}</Descriptions.Item>
                <Descriptions.Item label="Address" span={2}>
                  {[party.address_line_1, party.address_line_2, party.city, party.state, party.pincode].filter(Boolean).join(', ')}
                </Descriptions.Item>
                <Descriptions.Item label="GSTIN">{party.gstin}</Descriptions.Item>
                <Descriptions.Item label="PAN">{party.pan_number}</Descriptions.Item>
                <Descriptions.Item label="Credit Allowed">{party.credit_allowed ? 'Yes' : 'No'}</Descriptions.Item>
                <Descriptions.Item label="Credit Limit">{fmt(party.credit_limit)}</Descriptions.Item>
                <Descriptions.Item label="Credit Days">{party.credit_days} days</Descriptions.Item>
                <Descriptions.Item label="Interest Rate">{party.interest_rate}%</Descriptions.Item>
                <Descriptions.Item label="Opening Balance">{fmt(party.opening_balance)} ({party.opening_balance_type})</Descriptions.Item>
                <Descriptions.Item label="Current Balance">
                  <Text strong style={{ color: party.current_balance > 0 ? '#ff4d4f' : '#52c41a', fontSize: 16 }}>
                    {fmt(Math.abs(party.current_balance))}
                  </Text>
                </Descriptions.Item>
              </Descriptions>
            </Card>
          ),
        },
      ]} />
    </div>
  );
}
