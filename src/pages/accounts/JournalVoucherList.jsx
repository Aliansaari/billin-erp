// Journal Voucher list — paginated table of manual JVs with date,
// number, narration, total, status. Cursor-driven; F1 opens edit;
// F8 reverses (soft-delete via paired reversing entry).

import React, { useCallback, useEffect, useState } from 'react';
import { Card, Table, Button, Space, Typography, Tag, message, Modal, Input } from 'antd';
import { PlusOutlined, ReloadOutlined } from '@ant-design/icons';
import { useNavigate } from 'react-router-dom';
import { journalAPI } from '../../api';
import useListSelection from '../../hooks/useListSelection';
import ActionStrip from '../../components/keyboard/ActionStrip';

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

  // Cursor + multi-select on the visible page.
  const sel = useListSelection({ totalCount: rows.length, rows });
  const single = sel.activeRow;

  // Reverse — single-row only because the API takes one id at a time
  // and each reversal posts a paired entry. Bulk would be possible
  // but rare for accounting workflows; keep it explicit per row.
  const handleReverseCursor = useCallback(() => {
    if (!single || single.is_reversed) return;
    let reason = '';
    Modal.confirm({
      title: `Reverse JV ${single.voucher_number}?`,
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
          await journalAPI.remove(single.id, reason);
          message.success('Voucher reversed.');
          load();
        } catch (e) {
          message.error(e.response?.data?.error || 'Reversal failed.');
        }
      },
    });
  }, [single]);

  const cols = [
    { title: 'Date',    dataIndex: 'voucher_date',   key: 'date',    width: 120 },
    { title: 'Voucher', dataIndex: 'voucher_number', key: 'number',  width: 180,
      render: (v, row) => row.is_reversed
        ? <Text delete>{v}</Text>
        : <span style={{ fontWeight: 600 }}>{v}</span>,
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
  ];

  return (
    <div className="blist-page" style={{ padding: 16 }}>
      <Card style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}
        bodyStyle={{ display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0 }}>
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
          rowClassName={(_record, index) => {
            if (sel.cursorIdx === index)    return 'vrt-row-active';
            if (sel.selectedSet.has(index)) return 'vrt-row-multi';
            return '';
          }}
          onRow={(record, index) => ({
            onClick: (e) => {
              if (e.shiftKey)               sel.extendTo(index);
              else if (e.ctrlKey || e.metaKey) sel.toggleRow(index);
              else                             sel.setCursor(index);
            },
            onDoubleClick: () => record?.id && !record.is_reversed && navigate(`/accounts/journal/edit/${record.id}`),
          })}
        />
      </Card>

      {/* ── Bottom action strip — F1 Open / F3 New / F5 Refresh /
          F8 Reverse (single-row, danger). No F4 (no search input);
          no F6/F7/F9/F10 (not applicable to journal vouchers). */}
      <ActionStrip
        actions={[
          {
            id: 'new', key: 'F3', label: 'New',
            onAction: () => navigate('/accounts/journal/new'),
          },
          {
            id: 'refresh', key: 'F5', label: 'Refresh',
            onAction: () => load(),
          },
          {
            id: 'reverse', key: 'F8', label: 'Reverse', tone: 'danger',
            disabled: !single || single.is_reversed,
            onAction: handleReverseCursor,
          },
          {
            id: 'open', key: 'F1', label: 'Open', tone: 'primary',
            disabled: !single || single.is_reversed,
            onAction: () => single && navigate(`/accounts/journal/edit/${single.id}`),
          },
        ]}
      />
    </div>
  );
}
