import React, { useEffect, useState } from 'react';
import { Table, Card, DatePicker, Select, Typography, Space, Row, Col, message } from 'antd';
import dayjs from 'dayjs';
import { partyAPI } from '../../api';

const { Title, Text } = Typography;

const fmt = (v) => `₹ ${parseFloat(v || 0).toLocaleString('en-IN', { minimumFractionDigits: 2 })}`;

export default function PartyLedger() {
  const [parties, setParties] = useState([]);
  const [ledger, setLedger] = useState(null);
  const [loading, setLoading] = useState(false);
  const [partyId, setPartyId] = useState(null);
  const [dateRange, setDateRange] = useState({
    from_date: dayjs().startOf('year').format('YYYY-MM-DD'),
    to_date: dayjs().endOf('month').format('YYYY-MM-DD'),
  });

  useEffect(() => {
    loadParties();
  }, []);

  useEffect(() => {
    if (partyId) loadLedger();
  }, [partyId, dateRange]);

  const loadParties = async () => {
    try {
      const { data } = await partyAPI.getAll();
      setParties(data.data || data);
    } catch (e) { /* ignore */ }
  };

  const loadLedger = async () => {
    setLoading(true);
    try {
      const res = await partyAPI.getLedger(partyId, dateRange);
      setLedger(res.data);
    } catch (e) {
      message.error('Failed to load ledger');
    }
    setLoading(false);
  };

  // Compute running balance for each entry
  const entriesWithBalance = () => {
    if (!ledger?.entries) return [];
    let balance = parseFloat(ledger.opening_balance || 0);
    return ledger.entries.map((entry, idx) => {
      const debit = parseFloat(entry.debit || 0);
      const credit = parseFloat(entry.credit || 0);
      balance = balance + debit - credit;
      return { ...entry, _key: idx, running_balance: balance };
    });
  };

  const columns = [
    { title: 'Date', dataIndex: 'date', width: 110, render: (v) => dayjs(v).format('DD-MMM-YYYY') },
    { title: 'Particulars', dataIndex: 'particulars', width: 250 },
    { title: 'Voucher Type', dataIndex: 'voucher_type', width: 130 },
    { title: 'Voucher No', dataIndex: 'voucher_no', width: 130 },
    {
      title: 'Debit', dataIndex: 'debit', width: 130, align: 'right',
      render: (v) => v > 0 ? fmt(v) : '',
    },
    {
      title: 'Credit', dataIndex: 'credit', width: 130, align: 'right',
      render: (v) => v > 0 ? fmt(v) : '',
    },
    {
      title: 'Balance', dataIndex: 'running_balance', width: 140, align: 'right',
      render: (v) => (
        <Text strong style={{ color: v >= 0 ? '#cf1322' : '#3f8600' }}>
          {fmt(Math.abs(v))} {v >= 0 ? 'Dr' : 'Cr'}
        </Text>
      ),
    },
  ];

  const entries = entriesWithBalance();

  const closingBal = parseFloat(ledger?.closing_balance || 0);

  return (
    <div style={{ height: '100%', display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
      {/* Page Header */}
      <div className="erp-page-header" style={{ padding: '12px 20px', marginBottom: 0, background: '#fff', borderBottom: '1px solid #f0f0f0', flexShrink: 0 }}>
        <div className="erp-page-header-title">
          <Title level={3} style={{ margin: 0, fontWeight: 700, color: '#1f2937' }}>Party Ledger</Title>
          <span style={{ fontSize: 13, color: '#6b7280' }}>Account statement by party</span>
        </div>
      </div>

      <Card bodyStyle={{ padding: 0, display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0 }}
        style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
        {/* Filter Bar */}
        <div className="erp-filter-bar">
          <Select placeholder="Select Party" style={{ width: 250, height: 34 }} showSearch
            optionFilterProp="children" onChange={(v) => setPartyId(v)} value={partyId}>
            {parties.map((p) => (
              <Select.Option key={p.party_id} value={p.party_id}>{p.party_name}</Select.Option>
            ))}
          </Select>
          <DatePicker.RangePicker format="DD-MMM-YYYY" style={{ height: 34 }}
            defaultValue={[dayjs().startOf('year'), dayjs().endOf('month')]}
            onChange={(v) => setDateRange({
              from_date: v?.[0]?.format('YYYY-MM-DD') || null,
              to_date: v?.[1]?.format('YYYY-MM-DD') || null,
            })} />
        </div>

        {!partyId && (
          <div style={{ textAlign: 'center', padding: '60px 20px' }}>
            <div style={{ fontSize: 40, marginBottom: 12 }}>📋</div>
            <Text type="secondary" style={{ fontSize: 14 }}>Select a party above to view their account ledger</Text>
          </div>
        )}

        {partyId && ledger && (
          <>
            {/* Summary Bar */}
            <div className="erp-summary-bar">
              <div className="erp-summary-stat" style={{ background: '#eef2ff' }}>
                <span className="erp-summary-stat-label">Opening Balance</span>
                <span className="erp-summary-stat-value" style={{ color: '#4F46E5', fontSize: 15 }}>
                  {fmt(Math.abs(ledger.opening_balance || 0))} {parseFloat(ledger.opening_balance || 0) >= 0 ? 'Dr' : 'Cr'}
                </span>
              </div>
              <div className="erp-summary-stat" style={{ background: '#fef2f2' }}>
                <span className="erp-summary-stat-label">Total Debit</span>
                <span className="erp-summary-stat-value" style={{ color: '#dc2626' }}>{fmt(ledger.total_debit)}</span>
              </div>
              <div className="erp-summary-stat" style={{ background: '#f0fdf4' }}>
                <span className="erp-summary-stat-label">Total Credit</span>
                <span className="erp-summary-stat-value" style={{ color: '#16a34a' }}>{fmt(ledger.total_credit)}</span>
              </div>
              <div className="erp-summary-stat" style={{ background: closingBal >= 0 ? '#fef2f2' : '#f0fdf4' }}>
                <span className="erp-summary-stat-label">Closing Balance</span>
                <span className="erp-summary-stat-value" style={{ color: closingBal >= 0 ? '#dc2626' : '#16a34a', fontSize: 16, fontWeight: 800 }}>
                  {fmt(Math.abs(closingBal))} {closingBal >= 0 ? 'Dr' : 'Cr'}
                </span>
              </div>
            </div>

            {/* Opening row */}
            <div style={{ background: '#f8fafc', padding: '8px 16px', borderBottom: '1px solid #f0f0f0', display: 'flex', justifyContent: 'space-between' }}>
              <Text strong style={{ color: '#6b7280', fontSize: 12 }}>OPENING BALANCE</Text>
              <Text strong style={{ color: '#4F46E5' }}>
                {fmt(Math.abs(ledger.opening_balance || 0))} {parseFloat(ledger.opening_balance || 0) >= 0 ? 'Dr' : 'Cr'}
              </Text>
            </div>

            <div style={{ flex: 1, overflow: 'auto' }}>
              <Table columns={columns} dataSource={entries} rowKey="_key" loading={loading}
                size="small" scroll={{ x: 1000 }} pagination={false} />
            </div>

            {/* Closing row */}
            <div style={{ background: '#e0f2fe', padding: '10px 16px', borderTop: '2px solid #0ea5e9', display: 'flex', justifyContent: 'space-between', borderRadius: '0 0 8px 8px' }}>
              <Text strong style={{ fontSize: 13 }}>CLOSING BALANCE</Text>
              <Text strong style={{ fontSize: 15, color: closingBal >= 0 ? '#dc2626' : '#16a34a' }}>
                {fmt(Math.abs(closingBal))} {closingBal >= 0 ? 'Dr' : 'Cr'}
              </Text>
            </div>
          </>
        )}
      </Card>
    </div>
  );
}
