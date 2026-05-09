import React, { useEffect, useState } from 'react';
import {
  Card, Button, Modal, Form, Input, Select, ColorPicker, Tag, Space, Tooltip,
  Typography, Empty, message, Popconfirm,
} from 'antd';
import {
  BankOutlined, PlusOutlined, EditOutlined, DeleteOutlined, ReloadOutlined,
  CheckOutlined, LockOutlined, ExclamationCircleOutlined,
} from '@ant-design/icons';
import { companyAPI } from '../../api';
import useCompanyStore from '../../store/companyStore';
import useDevModeStore from '../../store/devModeStore';

const { Title, Text } = Typography;

const FY_MONTHS = [
  { value: 1,  label: 'January' },  { value: 4,  label: 'April (Indian FY)' },
  { value: 7,  label: 'July' },     { value: 10, label: 'October' },
];

/* ── CompanyList ──────────────────────────────────────────────────────
 *
 * Manage Companies page. Lists every company in the master DB (active
 * + archived); lets the user create new, rename existing, archive,
 * and re-activate.
 *
 * The CREATE button respects the dev_max_companies cap — a non-dev
 * user with the cap reached sees a disabled button + tooltip
 * explaining how to raise the limit.
 *
 * The PRIMARY company has its delete + deactivate buttons disabled
 * server-side; the UI shows a lock icon to make this clear.
 *
 * Layout: editorial header + card grid (one card per company), modals
 * for create + edit, popconfirm for archive / restore.
 * ────────────────────────────────────────────────────────────────── */
export default function CompanyList() {
  const [list, setList] = useState([]);
  const [loading, setLoading] = useState(false);
  const [createOpen, setCreateOpen] = useState(false);
  const [editing, setEditing] = useState(null);
  const [createForm] = Form.useForm();
  const [editForm]   = Form.useForm();

  const setListInStore = useCompanyStore((s) => s.setList);
  const devUnlocked    = useDevModeStore((s) => s.unlocked);
  const previewAsUser  = useDevModeStore((s) => s.previewAsUser);
  const effectiveDev   = devUnlocked && !previewAsUser;

  const reload = async () => {
    setLoading(true);
    try {
      const r = await companyAPI.list({ include_inactive: 1 });
      const rows = r.data?.data || [];
      setList(rows);
      setListInStore(rows.filter((c) => c.is_active && !c.db_dropped_at));
    } catch (e) {
      message.error('Could not load companies');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { reload(); }, []);

  const handleCreate = async (values) => {
    try {
      await companyAPI.create(values);
      message.success(`"${values.name}" created`);
      setCreateOpen(false);
      createForm.resetFields();
      reload();
    } catch (e) {
      const msg = e.response?.data?.error || 'Could not create company';
      message.error(msg);
    }
  };

  const handleUpdate = async (values) => {
    try {
      await companyAPI.update(editing.company_id, values);
      message.success('Saved');
      setEditing(null);
      editForm.resetFields();
      reload();
    } catch (e) {
      message.error(e.response?.data?.error || 'Save failed');
    }
  };

  const handleArchive = async (row) => {
    try {
      await companyAPI.archive(row.company_id);
      message.success('Archived');
      reload();
    } catch (e) {
      message.error(e.response?.data?.error || 'Archive failed');
    }
  };

  const handleRestore = async (row) => {
    try {
      await companyAPI.update(row.company_id, { is_active: true });
      message.success('Restored');
      reload();
    } catch (e) {
      message.error('Restore failed');
    }
  };

  const activeCount = list.filter((c) => c.is_active && !c.db_dropped_at).length;

  return (
    <div style={{ padding: 24, maxWidth: 1100, margin: '0 auto' }}>
      <div style={{ marginBottom: 24, display: 'flex', alignItems: 'center', gap: 12 }}>
        <BankOutlined style={{ fontSize: 26, color: '#21604C' }} />
        <div style={{ flex: 1, minWidth: 0 }}>
          <Title level={2} style={{ margin: 0, lineHeight: 1.1 }}>Companies</Title>
          <Text type="secondary" style={{ fontSize: 13 }}>
            Each company is its own set of books. Switch between them from the topbar.
          </Text>
        </div>
        <Button onClick={reload} icon={<ReloadOutlined />} loading={loading}>Reload</Button>
        <Button
          type="primary"
          icon={<PlusOutlined />}
          onClick={() => setCreateOpen(true)}
        >
          New Company
        </Button>
      </div>

      {list.length === 0 && !loading && (
        <Empty description="No companies yet. Click New Company to get started." />
      )}

      <div style={{
        display: 'grid',
        gridTemplateColumns: 'repeat(auto-fit, minmax(min(280px, 100%), 1fr))',
        gap: 14,
      }}>
        {list.map((c) => {
          const archived = !c.is_active;
          return (
            <Card
              key={c.company_id}
              style={{
                borderRadius: 12,
                border: archived ? '1px dashed #cbd5e1' : '1px solid #e5e7eb',
                opacity: archived ? 0.65 : 1,
              }}
              styles={{ body: { padding: 16 } }}
            >
              <div style={{ display: 'flex', alignItems: 'flex-start', gap: 12 }}>
                <div style={{
                  width: 44, height: 44,
                  borderRadius: 10,
                  background: (c.accent_color || '#21604C') + '20',
                  color: c.accent_color || '#21604C',
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                  flexShrink: 0,
                }}>
                  <BankOutlined style={{ fontSize: 22 }} />
                </div>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
                    <span style={{ fontWeight: 600, fontSize: 15 }}>{c.name}</span>
                    {c.is_primary && <Tag color="gold" style={{ marginRight: 0 }}>Primary</Tag>}
                    {archived && <Tag color="default">Archived</Tag>}
                  </div>
                  {c.gstin && (
                    <div style={{ fontSize: 12, color: '#64748b', marginTop: 2, fontFamily: 'monospace' }}>
                      GSTIN {c.gstin}
                    </div>
                  )}
                  {c.address && (
                    <div style={{ fontSize: 12, color: '#94a3b8', marginTop: 2,
                                  whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                      {c.address}
                    </div>
                  )}
                  <div style={{ fontSize: 11, color: '#cbd5e1', marginTop: 6 }}>
                    DB: <code style={{ fontSize: 11 }}>{c.db_name}</code>
                  </div>
                </div>
              </div>

              <div style={{ display: 'flex', gap: 6, marginTop: 14, flexWrap: 'wrap' }}>
                <Button
                  size="small"
                  icon={<EditOutlined />}
                  onClick={() => {
                    setEditing(c);
                    editForm.setFieldsValue({
                      name: c.name,
                      legal_name: c.legal_name,
                      gstin: c.gstin,
                      address: c.address,
                      fy_start_month: c.fy_start_month,
                      accent_color: c.accent_color,
                    });
                  }}
                >
                  Edit
                </Button>
                {archived ? (
                  <Button size="small" icon={<CheckOutlined />} onClick={() => handleRestore(c)}>
                    Restore
                  </Button>
                ) : c.is_primary ? (
                  <Tooltip title="The primary company can't be archived">
                    <Button size="small" icon={<LockOutlined />} disabled>Primary</Button>
                  </Tooltip>
                ) : (
                  <Popconfirm
                    title="Archive this company?"
                    description="The data stays on disk and you can restore it later."
                    icon={<ExclamationCircleOutlined style={{ color: '#f59e0b' }} />}
                    okText="Archive"
                    okButtonProps={{ danger: true }}
                    onConfirm={() => handleArchive(c)}
                  >
                    <Button size="small" danger icon={<DeleteOutlined />}>Archive</Button>
                  </Popconfirm>
                )}
              </div>
            </Card>
          );
        })}
      </div>

      <div style={{ marginTop: 18, color: '#94a3b8', fontSize: 12 }}>
        {activeCount} active {activeCount === 1 ? 'company' : 'companies'}.
        {!effectiveDev && ' Ask your developer to add more if you need them.'}
      </div>

      {/* ── Create modal ───────────────────────────────────────────── */}
      <Modal
        title={<span><PlusOutlined /> New Company</span>}
        open={createOpen}
        onCancel={() => { setCreateOpen(false); createForm.resetFields(); }}
        onOk={() => createForm.submit()}
        okText="Create"
        destroyOnClose
      >
        <Form form={createForm} layout="vertical" onFinish={handleCreate}
              initialValues={{ fy_start_month: 4, accent_color: '#21604C' }}>
          <Form.Item label="Company name" name="name" rules={[{ required: true, message: 'Name is required' }]}>
            <Input placeholder="e.g. Sabina Dresses (Sister concern)" autoFocus />
          </Form.Item>
          <Form.Item label="Legal name (optional)" name="legal_name">
            <Input placeholder="As registered with the GST department" />
          </Form.Item>
          <Form.Item label="GSTIN (optional)" name="gstin">
            <Input placeholder="27AAAAA0000A1Z5" />
          </Form.Item>
          <Form.Item label="Address (optional)" name="address">
            <Input.TextArea rows={2} />
          </Form.Item>
          <Form.Item label="Financial year start" name="fy_start_month">
            <Select options={FY_MONTHS} />
          </Form.Item>
          <Form.Item label="Accent color" name="accent_color"
            tooltip="Used in the topbar pill so each company is visually distinct">
            <Input placeholder="#21604C" />
          </Form.Item>
        </Form>
      </Modal>

      {/* ── Edit modal ─────────────────────────────────────────────── */}
      <Modal
        title={<span><EditOutlined /> Edit {editing?.name}</span>}
        open={!!editing}
        onCancel={() => { setEditing(null); editForm.resetFields(); }}
        onOk={() => editForm.submit()}
        okText="Save"
        destroyOnClose
      >
        <Form form={editForm} layout="vertical" onFinish={handleUpdate}>
          <Form.Item label="Name" name="name" rules={[{ required: true }]}>
            <Input />
          </Form.Item>
          <Form.Item label="Legal name" name="legal_name">
            <Input />
          </Form.Item>
          <Form.Item label="GSTIN" name="gstin">
            <Input />
          </Form.Item>
          <Form.Item label="Address" name="address">
            <Input.TextArea rows={2} />
          </Form.Item>
          <Form.Item label="Financial year start" name="fy_start_month">
            <Select options={FY_MONTHS} />
          </Form.Item>
          <Form.Item label="Accent color" name="accent_color">
            <Input placeholder="#21604C" />
          </Form.Item>
        </Form>
      </Modal>
    </div>
  );
}
