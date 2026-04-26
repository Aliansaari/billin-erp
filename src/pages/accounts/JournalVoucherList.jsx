// Journal Voucher list — paginated table of manual JVs with date,
// number, narration, total, status. Click → edit. Soft-delete = reverse.

import React, { useEffect, useState } from 'react';
import { Card, Table, Button, Space, Typography, Tag, message, Modal, Input } from 'antd';
import { PlusOutlined, ReloadOutlined, DeleteOutlined } from '@ant-design/icons';
import { useNavigate } from 'react-router-dom';
import { journalAPI } from '../../api';

const { Title, Text } = Typography;
const fmt = (v) =>
  parseFloat(v || 0).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

export default function JournalVoucherList() {
  const navigate = useNavigate();
  const [rows, setRows]       = useState([]);
  const [total, setTotal]     = useState(0);
  const [loading, setLoading] = useState(false);
  const [page, setPage]       = useState(1);
  const [pageSize, setSize]   = useState(20);

  const load = async () => {
    setLoading(true);
    try {
      const res = await journalAPI.list({ page, limit: pageSize });
      setRows(res.data.data || []);
      setTotal(res.data.total || 0);
    } catch (e) {
      message.error(e.response?.data?.error || 'Failed to load journal vouchers.');
    }
    setLoading(false);
  };
  useEffect(() => { load(); }, [page, pageSize]);

  const handleDelete = (row) => {
    let reason = '';
    Modal.confirm({
      title: `Reverse JV ${row.voucher_number}?`,
      content: (
        <div>
          <p>This posts a reversing entry. The original is preserved for audit.</p>
          <Input.TextArea rows={2} placeholder="Reason (optional)" onChange={(e) => { reason = e.target.value; }} />
        </div>
      ),
      okText: 'Reverse',
      okButtonProps: { danger: true },
      onOk: async () => {
        try {
          await journalAPI.remove(row.id, reason);
          message.success('Voucher reversed.');
          load();
        } catch (e) {
          message.error(e.response?.data?.error || 'Reversal failed.');
        }
      },
    });
  };

  const cols = [
    { title: 'Date',    dataIndex: 'voucher_date',   key: 'date',    width: 120 },
    { title: 'Voucher', dataIndex: 'voucher_number', key: 'number',  width: 180,
      render: (v, row) => row.is_reversed
        ? <Text delete>{v}</Text>
        : <a onClick={() => navigate(`/accounts/journal/edit/${row.id}`)}>{v}</a>,
    },
    { title: 'Narration', dataIndex: 'narration', key: 'narration', ellipsis: true },
    { title: 'Total Amount', dataIndex: 'total_amount', key: 'total', align: 'right', width: 160,
      render: (v) => <span style={{ fontFamily: 'Geist Mono, monospace' }}>{fmt(v)}</span>,
    },
    { title: 'Status', dataIndex: 'is_reversed', key: 'status', width: 110,
      render: (rev) => rev
        ? <Tag color="default">Reversed</Tag>
        : <Tag color="green">Posted</Tag>,
    },
    { title: '', key: 'actions', width: 100, align: 'right',
      render: (_, row) => row.is_reversed ? null : (
        <Button danger size="small" icon={<DeleteOutlined />} onClick={() => handleDelete(row)} />
      ),
    },
  ];

  return (
    <Card>
      <Space style={{ width: '100%', justifyContent: 'space-between', marginBottom: 16 }}>
        <Title level={4} style={{ margin: 0 }}>Journal Vouchers</Title>
        <Space>
          <Button icon={<ReloadOutlined />} onClick={load}>Refresh</Button>
          <Button type="primary" icon={<PlusOutlined />} onClick={() => navigate('/accounts/journal/new')}>
            New Voucher
          </Button>
        </Space>
      </Space>
      <Table
        rowKey="id"
        columns={cols}
        dataSource={rows}
        loading={loading}
        pagination={{
          current: page, pageSize, total,
          onChange: (p, ps) => { setPage(p); setSize(ps); },
        }}
        size="small"
      />
    </Card>
  );
}
