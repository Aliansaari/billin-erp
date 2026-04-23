import React, { useEffect, useState, useMemo } from 'react';
import {
  Table, Button, Input, Space, Tag, Typography, message, Popconfirm,
  Card, Modal, Form, Select, Switch, Checkbox, Divider, Alert, Tooltip,
} from 'antd';
import {
  PlusOutlined, EditOutlined, DeleteOutlined, InfoCircleOutlined,
  UndoOutlined, CheckOutlined, CloseOutlined,
} from '@ant-design/icons';
import { settingsAPI } from '../../api';

/*
 * User Management — user list + full permission editor.
 *
 * The form lets an admin assign a role (the template) and then, optionally,
 * override individual permissions for this specific user. The override is
 * stored in users.custom_permissions; NULL means "use role defaults". The
 * backend consults the override first at every authorisation check.
 *
 * The permission grid is designed to be:
 *   · compact — every permission on one modal, no drilling through tabs
 *   · legible — modules grouped into a CRUD matrix, special modules split out
 *   · safe    — "Use role defaults" switch puts the user back on the role
 *     template (sets custom_permissions=null); "Grant all / Revoke all /
 *     Row all" accelerators for common cases; every module row has a tick-
 *     all toggle so the admin can say "full inventory control" with one click.
 *
 * The form intentionally doesn't distinguish "permission denied at the role"
 * from "permission denied at the user" — the UI shows a flat "this user can
 * do X / not X" view, which is what an admin actually thinks about. Role
 * assignment is still the primary lever; overrides are for the cases where
 * a specific employee needs a slightly different set.
 */

const { Title, Text } = Typography;

const ROLE_COLORS = {
  'Super Admin':     'volcano',
  'Admin':           'red',
  'Manager':         'purple',
  'Accountant':      'blue',
  'Salesman':        'green',
  'Cashier':         'green',
  'Inventory Staff': 'orange',
};

// The same permission surface the backend knows about. Kept here (rather
// than fetched at runtime) so the form renders instantly; any addition on
// the backend requires a matching edit here, which is the right trade-off
// — permission names are a contract, not a data value.
const CRUD_MODULES = [
  { key: 'sales',            label: 'Sales Bills' },
  { key: 'purchase',         label: 'Purchase Bills' },
  { key: 'sales_returns',    label: 'Sales Returns' },
  { key: 'purchase_returns', label: 'Purchase Returns' },
  { key: 'parties',          label: 'Customers & Suppliers' },
  { key: 'inventory',        label: 'Inventory (Products, Stock)' },
  { key: 'payments',         label: 'Payments & Receipts' },
];
const CRUD_ACTIONS = ['view', 'create', 'edit', 'delete'];

const SINGLE_PERMS = [
  { path: 'reports.view',  label: 'Reports — View',           group: 'Reports & Accounts' },
  { path: 'accounts.view', label: 'Accounts — View P&L, Party Ledger', group: 'Reports & Accounts' },
];

const SETTINGS_PERMS = [
  { path: 'settings.view',           label: 'View Settings' },
  { path: 'settings.manage_users',   label: 'Manage Users' },
  { path: 'settings.manage_company', label: 'Company Profile & Modules' },
  { path: 'settings.barcode',        label: 'Barcode Config' },
  { path: 'settings.print',          label: 'Print Settings' },
  { path: 'settings.theme',          label: 'Theme' },
  { path: 'settings.import_export',  label: 'Import / Export' },
  { path: 'settings.tally',          label: 'TallyPrime Sync' },
  { path: 'settings.backup',         label: 'Backup & Recovery' },
  { path: 'settings.cleanup',        label: 'Data Cleanup' },
];

/* ─── perms helpers ───────────────────────────────────────────────── */

// Read a dot-path from a permissions object. Returns true if any level
// evaluates to `true` (module-level or action-level grant), matching the
// backend hasPermission semantics.
function pathGet(perms, path) {
  if (!perms) return false;
  if (perms.all === true) return true;
  const parts = path.split('.');
  let cur = perms;
  for (const p of parts) {
    if (cur === true) return true;
    if (!cur || typeof cur !== 'object') return false;
    cur = cur[p];
  }
  return cur === true;
}

// Write a dot-path boolean into a permissions object (immutable).
// When unticking the last action of a module, we clear the empty object
// so the serialised JSON stays tidy.
function pathSet(perms, path, value) {
  const parts = path.split('.');
  const copy = JSON.parse(JSON.stringify(perms || {}));
  let cur = copy;
  for (let i = 0; i < parts.length - 1; i++) {
    const p = parts[i];
    if (!cur[p] || typeof cur[p] !== 'object') cur[p] = {};
    cur = cur[p];
  }
  const leaf = parts[parts.length - 1];
  if (value) cur[leaf] = true;
  else delete cur[leaf];
  // Prune empty intermediate objects so the JSON is readable in the DB.
  for (let i = parts.length - 2; i >= 0; i--) {
    let scan = copy;
    for (let j = 0; j < i; j++) scan = scan[parts[j]];
    const key = parts[i];
    if (scan[key] && typeof scan[key] === 'object' && Object.keys(scan[key]).length === 0) {
      delete scan[key];
    }
  }
  return copy;
}

function countGrants(perms) {
  if (!perms) return 0;
  if (perms.all === true) return 99;
  let n = 0;
  for (const mod of CRUD_MODULES) for (const a of CRUD_ACTIONS) if (pathGet(perms, `${mod.key}.${a}`)) n++;
  for (const s of SINGLE_PERMS) if (pathGet(perms, s.path)) n++;
  for (const s of SETTINGS_PERMS) if (pathGet(perms, s.path)) n++;
  return n;
}

/* ─── UI component ────────────────────────────────────────────────── */

export default function UserManagement() {
  const [users, setUsers] = useState([]);
  const [roles, setRoles] = useState([]);
  const [loading, setLoading] = useState(false);
  const [modalVisible, setModalVisible] = useState(false);
  const [editingUser, setEditingUser] = useState(null);
  const [formLoading, setFormLoading] = useState(false);

  // Permission editor state — lives outside AntD Form because we want
  // full control over the tick grid and the "inherit from role" toggle.
  const [selectedRoleId, setSelectedRoleId] = useState(null);
  const [customizing, setCustomizing]       = useState(false);
  const [perms, setPerms]                   = useState({});

  const [form] = Form.useForm();

  useEffect(() => { loadData(); }, []);

  const loadData = async () => {
    setLoading(true);
    try {
      const [usersRes, rolesRes] = await Promise.all([
        settingsAPI.getUsers(),
        settingsAPI.getRoles(),
      ]);
      setUsers(usersRes.data.data || []);
      setRoles(rolesRes.data.data || []);
    } catch { message.error('Failed to load users'); }
    setLoading(false);
  };

  const roleById = useMemo(() => Object.fromEntries(roles.map(r => [r.role_id, r])), [roles]);
  const rolePerms = (roleId) => roleById[roleId]?.permissions_json || {};

  const handleAdd = () => {
    setEditingUser(null);
    form.resetFields();
    setSelectedRoleId(null);
    setCustomizing(false);
    setPerms({});
    setModalVisible(true);
  };

  const handleEdit = (record) => {
    setEditingUser(record);
    form.setFieldsValue({
      username: record.username,
      full_name: record.full_name,
      email: record.email,
      mobile_number: record.mobile_number,
      role_id: record.role_id,
    });
    setSelectedRoleId(record.role_id);
    // If the user has a custom_permissions override, start the editor in
    // customise mode showing those exact ticks; otherwise mirror the role.
    if (record.custom_permissions) {
      setCustomizing(true);
      setPerms(record.custom_permissions);
    } else {
      setCustomizing(false);
      setPerms(rolePerms(record.role_id));
    }
    setModalVisible(true);
  };

  const handleRoleChange = (roleId) => {
    setSelectedRoleId(roleId);
    // Re-seed the permission grid from the new role's template. If the
    // admin was customising, we keep their switch on but start from the
    // new role's defaults — that's the least-surprising behaviour when
    // switching between "Salesman" and "Manager" for instance.
    setPerms(rolePerms(roleId));
  };

  const handleResetToRole = () => {
    if (!selectedRoleId) return;
    setPerms(rolePerms(selectedRoleId));
    setCustomizing(false);
  };

  const handleTogglePerm = (path) => {
    setPerms(prev => pathSet(prev, path, !pathGet(prev, path)));
    setCustomizing(true);
  };

  const handleToggleModuleAll = (moduleKey, allOn) => {
    let next = perms;
    for (const a of CRUD_ACTIONS) next = pathSet(next, `${moduleKey}.${a}`, !allOn);
    setPerms(next);
    setCustomizing(true);
  };

  const handleGrantAll = () => {
    let next = {};
    for (const m of CRUD_MODULES) for (const a of CRUD_ACTIONS) next = pathSet(next, `${m.key}.${a}`, true);
    for (const s of SINGLE_PERMS) next = pathSet(next, s.path, true);
    for (const s of SETTINGS_PERMS) next = pathSet(next, s.path, true);
    setPerms(next);
    setCustomizing(true);
  };

  const handleRevokeAll = () => {
    setPerms({});
    setCustomizing(true);
  };

  const handleDelete = async (id) => {
    try {
      await settingsAPI.deleteUser(id);
      message.success('User deleted');
      loadData();
    } catch { message.error('Failed to delete user'); }
  };

  const handleToggleStatus = async (record) => {
    try {
      await settingsAPI.updateUser(record.user_id, { is_active: !record.is_active });
      message.success('User status updated');
      loadData();
    } catch { message.error('Failed to update status'); }
  };

  const handleSubmit = async () => {
    try {
      const values = await form.validateFields();
      setFormLoading(true);
      // Custom permissions: null if the admin left "Use role defaults" on,
      // otherwise the current tick grid snapshot. The backend treats null
      // as "follow the role template" and a populated object as a full
      // override (no merging).
      values.custom_permissions = customizing ? perms : null;
      if (editingUser) {
        if (!values.password) delete values.password;
        await settingsAPI.updateUser(editingUser.user_id, values);
        message.success('User updated');
      } else {
        await settingsAPI.createUser(values);
        message.success('User created');
      }
      setModalVisible(false);
      form.resetFields();
      setEditingUser(null);
      loadData();
    } catch (error) {
      if (error.errorFields) return;
      const apiMsg = error.response?.data?.error;
      message.error(apiMsg || 'Failed to save user');
    } finally {
      setFormLoading(false);
    }
  };

  const getRoleName = (roleId) => roleById[roleId]?.role_name || '-';
  const selectedRole = selectedRoleId ? roleById[selectedRoleId] : null;
  const isSuperAdminRole = selectedRole?.role_name === 'Super Admin';

  const columns = [
    { title: 'Username',  dataIndex: 'username',  key: 'username' },
    { title: 'Full Name', dataIndex: 'full_name', key: 'full_name' },
    { title: 'Email',     dataIndex: 'email',     key: 'email' },
    { title: 'Mobile',    dataIndex: 'mobile_number', key: 'mobile_number' },
    {
      title: 'Role',
      dataIndex: 'role_id',
      key: 'role',
      render: (roleId, record) => {
        const name = getRoleName(roleId);
        return (
          <Space size={4}>
            <Tag color={ROLE_COLORS[name] || 'default'}>{name}</Tag>
            {record.custom_permissions && (
              <Tooltip title="Permissions customised for this user">
                <Tag color="geekblue">custom</Tag>
              </Tooltip>
            )}
          </Space>
        );
      },
    },
    {
      title: 'Status',
      dataIndex: 'is_active',
      key: 'status',
      render: (active, record) => (
        <Switch
          checked={active}
          checkedChildren="Active"
          unCheckedChildren="Inactive"
          onChange={() => handleToggleStatus(record)}
        />
      ),
    },
    {
      title: 'Actions',
      key: 'actions',
      render: (_, record) => (
        <Space>
          <Button type="link" icon={<EditOutlined />} onClick={() => handleEdit(record)}>Edit</Button>
          <Popconfirm
            title="Delete this user?"
            description="The user will be deactivated and cannot log in."
            onConfirm={() => handleDelete(record.user_id)}
            okText="Yes, delete"
            cancelText="Cancel"
          >
            <Button type="link" danger icon={<DeleteOutlined />}>Delete</Button>
          </Popconfirm>
        </Space>
      ),
    },
  ];

  const grantCount = countGrants(perms);
  const roleGrantCount = selectedRole ? countGrants(rolePerms(selectedRoleId)) : 0;

  return (
    <div>
      <div className="erp-list-header">
        <Title level={3} style={{ margin: 0 }}>User Management</Title>
        <Button type="primary" icon={<PlusOutlined />} onClick={handleAdd}>Add User</Button>
      </div>

      <Card>
        <Table columns={columns} dataSource={users} rowKey="user_id" loading={loading} pagination={{ pageSize: 10 }} />
      </Card>

      <Modal
        title={editingUser ? `Edit User — ${editingUser.username}` : 'Add User'}
        open={modalVisible}
        onOk={handleSubmit}
        onCancel={() => { setModalVisible(false); form.resetFields(); setEditingUser(null); }}
        confirmLoading={formLoading}
        destroyOnClose
        width={820}
        okText={editingUser ? 'Save changes' : 'Create user'}
      >
        <Form form={form} layout="vertical">
          {/* ── Basics ── */}
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}>
            <Form.Item name="username" label="Username" rules={[{ required: true, message: 'Required' }]}>
              <Input placeholder="e.g. rahul" disabled={!!editingUser} />
            </Form.Item>
            <Form.Item
              name="password"
              label={editingUser ? 'Password (leave blank to keep)' : 'Password'}
              rules={editingUser ? [] : [{ required: true, message: 'Required' }, { min: 6, message: 'Minimum 6 characters' }]}
            >
              <Input.Password placeholder={editingUser ? '••••••' : 'At least 6 characters'} />
            </Form.Item>
            <Form.Item name="full_name" label="Full Name" rules={[{ required: true, message: 'Required' }]}>
              <Input placeholder="Full name" />
            </Form.Item>
            <Form.Item name="email" label="Email" rules={[{ type: 'email', message: 'Invalid email' }]}>
              <Input placeholder="name@company.com" />
            </Form.Item>
            <Form.Item name="mobile_number" label="Mobile">
              <Input placeholder="10-digit phone" />
            </Form.Item>
            <Form.Item name="role_id" label="Role" rules={[{ required: true, message: 'Required' }]}>
              <Select placeholder="Pick a role template" onChange={handleRoleChange}>
                {roles.map(role => (
                  <Select.Option key={role.role_id} value={role.role_id}>
                    {role.role_name}
                  </Select.Option>
                ))}
              </Select>
            </Form.Item>
          </div>

          {/* ── Permissions editor ── */}
          {selectedRoleId && (
            <>
              <Divider plain style={{ margin: '8px 0 16px' }}>Permissions</Divider>

              {isSuperAdminRole && (
                <Alert
                  type="info"
                  showIcon
                  icon={<InfoCircleOutlined />}
                  message="Super Admin has unlimited access"
                  description="Per-user permission overrides are not applied to Super Admin accounts — they always have full access. Use a different role to restrict a user."
                  style={{ marginBottom: 16 }}
                />
              )}

              {!isSuperAdminRole && (
                <>
                  <div style={{
                    display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                    gap: 12, flexWrap: 'wrap',
                    padding: '10px 12px', background: 'var(--bg-muted, #f8fafc)',
                    borderRadius: 8, marginBottom: 12,
                  }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                      <Switch
                        checked={customizing}
                        onChange={(v) => {
                          setCustomizing(v);
                          if (!v) setPerms(rolePerms(selectedRoleId));    // reverting cleanly
                        }}
                      />
                      <Text strong>Customise for this user</Text>
                      {customizing
                        ? <Tag color="gold">override active</Tag>
                        : <Tag>inheriting from {selectedRole?.role_name}</Tag>}
                    </div>
                    <Space size={4}>
                      <Tooltip title="Copy the role template back into the tick grid">
                        <Button size="small" icon={<UndoOutlined />} onClick={handleResetToRole} disabled={!customizing}>
                          Reset to role
                        </Button>
                      </Tooltip>
                      <Button size="small" icon={<CheckOutlined />} onClick={handleGrantAll} disabled={!customizing}>
                        Grant all
                      </Button>
                      <Button size="small" icon={<CloseOutlined />} onClick={handleRevokeAll} disabled={!customizing}>
                        Revoke all
                      </Button>
                    </Space>
                  </div>

                  <div style={{ fontSize: 12, color: 'var(--fg-tertiary, #9ca3af)', marginBottom: 10 }}>
                    <b>{grantCount}</b> permission{grantCount === 1 ? '' : 's'} granted
                    {customizing && selectedRole ? <> · role template grants <b>{roleGrantCount}</b></> : null}
                  </div>

                  {/* ── CRUD matrix — modules × (view/create/edit/delete) ── */}
                  <div style={{
                    border: '1px solid var(--border, #e5e7eb)', borderRadius: 8,
                    overflow: 'hidden', marginBottom: 16,
                  }}>
                    <div style={{
                      display: 'grid',
                      gridTemplateColumns: '1.8fr 60px 60px 60px 60px 56px',
                      padding: '8px 12px',
                      fontSize: 11, fontWeight: 700, letterSpacing: 0.6, textTransform: 'uppercase',
                      color: 'var(--fg-tertiary, #9ca3af)',
                      background: 'var(--bg-muted, #f8fafc)',
                      borderBottom: '1px solid var(--border, #e5e7eb)',
                    }}>
                      <div>Module</div>
                      <div style={{ textAlign: 'center' }}>View</div>
                      <div style={{ textAlign: 'center' }}>Create</div>
                      <div style={{ textAlign: 'center' }}>Edit</div>
                      <div style={{ textAlign: 'center' }}>Delete</div>
                      <div style={{ textAlign: 'center' }}>All</div>
                    </div>
                    {CRUD_MODULES.map((m, i) => {
                      const rowAll = CRUD_ACTIONS.every(a => pathGet(perms, `${m.key}.${a}`));
                      const rowAny = CRUD_ACTIONS.some(a => pathGet(perms, `${m.key}.${a}`));
                      return (
                        <div key={m.key} style={{
                          display: 'grid',
                          gridTemplateColumns: '1.8fr 60px 60px 60px 60px 56px',
                          padding: '8px 12px',
                          alignItems: 'center',
                          borderBottom: i < CRUD_MODULES.length - 1 ? '1px solid var(--border-subtle, #f0f0f0)' : 'none',
                          fontSize: 13,
                        }}>
                          <div style={{ fontWeight: 500 }}>{m.label}</div>
                          {CRUD_ACTIONS.map(a => (
                            <div key={a} style={{ textAlign: 'center' }}>
                              <Checkbox
                                checked={pathGet(perms, `${m.key}.${a}`)}
                                disabled={!customizing}
                                onChange={() => handleTogglePerm(`${m.key}.${a}`)}
                              />
                            </div>
                          ))}
                          <div style={{ textAlign: 'center' }}>
                            <Checkbox
                              checked={rowAll}
                              indeterminate={rowAny && !rowAll}
                              disabled={!customizing}
                              onChange={() => handleToggleModuleAll(m.key, rowAll)}
                            />
                          </div>
                        </div>
                      );
                    })}
                  </div>

                  {/* ── Single-grant permissions ── */}
                  <div style={{
                    border: '1px solid var(--border, #e5e7eb)', borderRadius: 8,
                    padding: '10px 12px', marginBottom: 16,
                  }}>
                    <div style={{
                      fontSize: 11, fontWeight: 700, letterSpacing: 0.6, textTransform: 'uppercase',
                      color: 'var(--fg-tertiary, #9ca3af)', marginBottom: 8,
                    }}>
                      Reports & Accounts
                    </div>
                    <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 6 }}>
                      {SINGLE_PERMS.map(p => (
                        <Checkbox
                          key={p.path}
                          checked={pathGet(perms, p.path)}
                          disabled={!customizing}
                          onChange={() => handleTogglePerm(p.path)}
                        >
                          {p.label}
                        </Checkbox>
                      ))}
                    </div>
                  </div>

                  {/* ── Settings sub-permissions ── */}
                  <div style={{
                    border: '1px solid var(--border, #e5e7eb)', borderRadius: 8,
                    padding: '10px 12px',
                  }}>
                    <div style={{
                      fontSize: 11, fontWeight: 700, letterSpacing: 0.6, textTransform: 'uppercase',
                      color: 'var(--fg-tertiary, #9ca3af)', marginBottom: 8,
                    }}>
                      Settings Access
                    </div>
                    <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 6 }}>
                      {SETTINGS_PERMS.map(p => (
                        <Checkbox
                          key={p.path}
                          checked={pathGet(perms, p.path)}
                          disabled={!customizing}
                          onChange={() => handleTogglePerm(p.path)}
                        >
                          {p.label}
                        </Checkbox>
                      ))}
                    </div>
                  </div>
                </>
              )}
            </>
          )}
        </Form>
      </Modal>
    </div>
  );
}
