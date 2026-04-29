import React, { useEffect, useMemo, useState } from 'react';
import { Table, Button, Modal, Form, Input, Switch, Tag, Space, Popconfirm, message, Tooltip } from 'antd';
import { BankOutlined, PlusOutlined, EditOutlined, DeleteOutlined, CheckCircleFilled, StarFilled } from '@ant-design/icons';
import { godownAPI } from '../../api';

/*
 * Settings → Godowns.
 *
 * Multi-warehouse foundation page. Lists every godown with city/state,
 * default-flag star, active toggle. Add / Edit via modal; Set-Default
 * action available on any non-default active godown; Delete with the
 * server's strict guards (refused on default, system, godown-with-stock,
 * or godown-referenced-by-bills — the controller surfaces a useful error
 * which we relay verbatim).
 *
 * No infinite scroll or virtualised table — godowns are typically <20
 * even for large multi-state operations, so a plain Antd Table is enough.
 */

export default function GodownList() {
  const [rows, setRows]             = useState([]);
  const [loading, setLoading]       = useState(false);
  const [editing, setEditing]       = useState(null);   // null = closed, {} = create, {…} = edit
  const [submitting, setSubmitting] = useState(false);
  const [form] = Form.useForm();

  const load = async () => {
    setLoading(true);
    try {
      const { data } = await godownAPI.getAll({ include_inactive: 'true' });
      setRows(data);
    } catch (err) {
      message.error(err?.response?.data?.error || 'Failed to load godowns');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(); }, []);

  const openCreate = () => { setEditing({}); form.resetFields(); };
  const openEdit   = (g) => { setEditing(g); form.setFieldsValue(g); };
  const close      = () => { setEditing(null); form.resetFields(); };

  const submit = async () => {
    try {
      const vals = await form.validateFields();
      setSubmitting(true);
      if (editing && editing.godown_id) {
        await godownAPI.update(editing.godown_id, vals);
        message.success('Godown updated');
      } else {
        await godownAPI.create(vals);
        message.success('Godown created');
      }
      close();
      await load();
    } catch (err) {
      // Form validation surfaces its own messages; only show server errors.
      if (err?.errorFields) return;
      message.error(err?.response?.data?.error || 'Save failed');
    } finally {
      setSubmitting(false);
    }
  };

  const setDefault = async (g) => {
    try {
      await godownAPI.setDefault(g.godown_id);
      message.success(`${g.code} is now the default godown`);
      await load();
    } catch (err) {
      message.error(err?.response?.data?.error || 'Failed to set default');
    }
  };

  const toggleActive = async (g) => {
    try {
      await godownAPI.update(g.godown_id, { is_active: !g.is_active });
      await load();
    } catch (err) {
      message.error(err?.response?.data?.error || 'Failed to toggle active');
    }
  };

  const remove = async (g) => {
    try {
      await godownAPI.delete(g.godown_id);
      message.success(`Deleted ${g.code}`);
      await load();
    } catch (err) {
      // Delete is the most likely place to hit a 400 with a useful
      // message — surface it verbatim so the operator knows what to do
      // (transfer stock out, deactivate instead, etc.).
      message.error(err?.response?.data?.error || 'Delete failed', 5);
    }
  };

  const columns = useMemo(() => [
    {
      title: 'Code', dataIndex: 'code', width: 120,
      render: (v, row) => (
        <Space size={6}>
          <span style={{ fontWeight: 600, fontFamily: 'var(--font-mono, monospace)' }}>{v}</span>
          {row.is_default && <Tooltip title="Default godown — auto-selected on new bills"><StarFilled style={{ color: 'var(--warning, #f59e0b)' }} /></Tooltip>}
          {row.is_system && <Tooltip title="System-managed; cannot be deleted"><Tag color="default" style={{ marginLeft: 0 }}>system</Tag></Tooltip>}
        </Space>
      ),
    },
    { title: 'Name', dataIndex: 'name' },
    {
      title: 'Location', key: 'location',
      render: (_, row) => [row.city, row.state].filter(Boolean).join(', ') || '—',
    },
    { title: 'GSTIN', dataIndex: 'gstin', render: (v) => v || '—' },
    {
      title: 'Active', dataIndex: 'is_active', width: 90, align: 'center',
      render: (v, row) => (
        <Switch
          size="small"
          checked={!!v}
          // Default godown cannot be deactivated — server enforces, mirror here.
          disabled={row.is_default}
          onChange={() => toggleActive(row)}
        />
      ),
    },
    {
      title: 'Actions', key: 'actions', width: 280, align: 'right',
      render: (_, row) => (
        <Space size={4}>
          {!row.is_default && row.is_active && (
            <Tooltip title="Make this the default godown">
              <Button size="small" icon={<CheckCircleFilled />} onClick={() => setDefault(row)}>Default</Button>
            </Tooltip>
          )}
          <Button size="small" icon={<EditOutlined />} onClick={() => openEdit(row)}>Edit</Button>
          <Popconfirm
            title={`Delete ${row.code}?`}
            description="This is permanent. Bills/stock referencing it must be cleared first."
            okText="Delete"
            okButtonProps={{ danger: true }}
            onConfirm={() => remove(row)}
            disabled={row.is_default || row.is_system}
          >
            <Button
              size="small"
              danger
              icon={<DeleteOutlined />}
              disabled={row.is_default || row.is_system}
            >
              Delete
            </Button>
          </Popconfirm>
        </Space>
      ),
    },
  ], []);

  return (
    <div style={{ padding: 24 }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 16 }}>
        <h2 style={{ margin: 0, display: 'flex', alignItems: 'center', gap: 10 }}>
          <BankOutlined /> Godowns
        </h2>
        <Button type="primary" icon={<PlusOutlined />} onClick={openCreate}>Add Godown</Button>
      </div>

      <p style={{ color: 'var(--fg-secondary, #6b7280)', marginTop: 0, marginBottom: 16, fontSize: 13 }}>
        Physical storage locations. Each bill is issued from a specific godown; stock is tracked per-godown.
        Stock transfers move inventory between godowns without affecting books.
      </p>

      <Table
        rowKey="godown_id"
        loading={loading}
        dataSource={rows}
        columns={columns}
        pagination={false}
        size="middle"
        style={{ background: 'var(--bg-elevated, white)' }}
      />

      <Modal
        title={editing && editing.godown_id ? `Edit godown — ${editing.code}` : 'Add godown'}
        open={!!editing}
        onCancel={close}
        onOk={submit}
        confirmLoading={submitting}
        okText={editing && editing.godown_id ? 'Save' : 'Create'}
        destroyOnClose
        width={560}
      >
        <Form form={form} layout="vertical" requiredMark="optional" preserve={false}>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', columnGap: 12 }}>
            <Form.Item
              name="code" label="Code"
              rules={[{ required: true, message: 'Code is required' }, { max: 20 }]}
              tooltip="Short identifier (auto-uppercased) shown in selectors. e.g. MAIN, MUM-01"
            >
              <Input placeholder="e.g. MUM-01" maxLength={20} />
            </Form.Item>
            <Form.Item
              name="name" label="Name"
              rules={[{ required: true, message: 'Name is required' }, { max: 100 }]}
            >
              <Input placeholder="e.g. Mumbai Branch Stock" maxLength={100} />
            </Form.Item>
          </div>
          <Form.Item name="address" label="Address">
            <Input.TextArea rows={2} maxLength={500} />
          </Form.Item>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', columnGap: 12 }}>
            <Form.Item name="city" label="City"><Input /></Form.Item>
            <Form.Item name="state" label="State" tooltip="Used for Place-of-Supply on bills issued from this godown.">
              <Input placeholder="e.g. Maharashtra" />
            </Form.Item>
            <Form.Item name="pincode" label="PIN"><Input maxLength={10} /></Form.Item>
          </div>
          <Form.Item
            name="gstin" label="GSTIN (override)"
            tooltip="Leave blank to use the company GSTIN. Set only when this godown has its own state registration."
          >
            <Input placeholder="Optional 15-char GSTIN" maxLength={15} />
          </Form.Item>
        </Form>
      </Modal>
    </div>
  );
}
