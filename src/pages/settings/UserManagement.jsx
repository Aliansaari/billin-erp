import React, { useEffect, useState, useMemo } from 'react';
import {
  Table, Button, Input, Space, Tag, Typography, message, Popconfirm,
  Card, Form, Select, Switch, Checkbox, Tooltip,
} from 'antd';
import {
  PlusOutlined, EditOutlined, DeleteOutlined,
  UndoOutlined, CheckOutlined, CloseOutlined,
} from '@ant-design/icons';
import { settingsAPI } from '../../api';
import useListSelection from '../../hooks/useListSelection';
import ActionStrip from '../../components/keyboard/ActionStrip';
import EntityFormModal from '../../components/EntityFormModal';
import './ModuleSettings.css';

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
  const [dirty, setDirty] = useState(false);

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
    setDirty(false);
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
    setDirty(false);
    setModalVisible(true);
  };

  const handleRoleChange = (roleId) => {
    setSelectedRoleId(roleId);
    // Re-seed the permission grid from the new role's template. If the
    // admin was customising, we keep their switch on but start from the
    // new role's defaults — that's the least-surprising behaviour when
    // switching between "Salesman" and "Manager" for instance.
    setPerms(rolePerms(roleId));
    setDirty(true);
  };

  const handleResetToRole = () => {
    if (!selectedRoleId) return;
    setPerms(rolePerms(selectedRoleId));
    setCustomizing(false);
    setDirty(true);
  };

  const handleTogglePerm = (path) => {
    setPerms(prev => pathSet(prev, path, !pathGet(prev, path)));
    setCustomizing(true);
    setDirty(true);
  };

  const handleToggleModuleAll = (moduleKey, allOn) => {
    let next = perms;
    for (const a of CRUD_ACTIONS) next = pathSet(next, `${moduleKey}.${a}`, !allOn);
    setPerms(next);
    setCustomizing(true);
    setDirty(true);
  };

  const handleGrantAll = () => {
    let next = {};
    for (const m of CRUD_MODULES) for (const a of CRUD_ACTIONS) next = pathSet(next, `${m.key}.${a}`, true);
    for (const s of SINGLE_PERMS) next = pathSet(next, s.path, true);
    for (const s of SETTINGS_PERMS) next = pathSet(next, s.path, true);
    setPerms(next);
    setCustomizing(true);
    setDirty(true);
  };

  const handleRevokeAll = () => {
    setPerms({});
    setCustomizing(true);
    setDirty(true);
  };

  const handleResetForm = () => {
    if (editingUser) {
      handleEdit(editingUser);
    } else {
      handleAdd();
    }
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

  // Cursor over the user list — arrow nav drives the F-key strip below.
  const sel = useListSelection({ totalCount: users.length, rows: users });
  const single = sel.activeRow;

  return (
    <div className="ms-shell settings-pane-fill">
      <header className="ms-page-header" style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 16 }}>
        <div>
          <h1 className="ms-page-title">Users</h1>
          <p className="ms-page-sub">Accounts, roles, and permissions for everyone using this software.</p>
        </div>
        <Button type="primary" icon={<PlusOutlined />} onClick={handleAdd}>Add User</Button>
      </header>

      <div className="ms-page-body">
        <div className="ms-page-body-inner">
          <Card bordered={false} style={{ background: 'var(--bg-panel)', border: '1px solid var(--border-subtle)', borderRadius: 10 }}>
        <Table
          columns={columns}
          dataSource={users}
          rowKey="user_id"
          loading={loading}
          pagination={{ pageSize: 10 }}
          rowClassName={(_r, idx) => {
            if (sel.cursorIdx === idx)    return 'vrt-row-active';
            if (sel.selectedSet.has(idx)) return 'vrt-row-multi';
            return '';
          }}
          onRow={(record, index) => ({
            onClick: (e) => {
              if (e.shiftKey)               sel.extendTo(index);
              else if (e.ctrlKey || e.metaKey) sel.toggleRow(index);
              else                              sel.setCursor(index);
            },
            onDoubleClick: () => record && handleEdit(record),
          })}
        />
          </Card>
        </div>
      </div>

      <Form
        form={form}
        layout="vertical"
        component={false}
        onValuesChange={() => setDirty(true)}
      >
        <EntityFormModal
          open={modalVisible}
          onClose={() => { setModalVisible(false); form.resetFields(); setEditingUser(null); }}
          title={editingUser ? 'Edit User' : 'Add User'}
          subtitle={editingUser ? editingUser.username : 'New account · role template + per-user override'}
          entityIcon="U"
          entityTone="accent"
          dirty={dirty}
          saving={formLoading}
          onSave={handleSubmit}
          onSaveAndClose={handleSubmit}
          onReset={handleResetForm}
          width={820}
        >
          <EntityFormModal.Section label="Account">
            <EntityFormModal.Field label="Username" required>
              <Form.Item name="username" rules={[{ required: true, message: 'Required' }]} noStyle>
                <Input className="efm-input" placeholder="e.g. rahul" disabled={!!editingUser} />
              </Form.Item>
            </EntityFormModal.Field>

            <EntityFormModal.Field
              label={editingUser ? 'Password (blank = keep)' : 'Password'}
              required={!editingUser}
            >
              <Form.Item
                name="password"
                rules={editingUser ? [] : [{ required: true, message: 'Required' }, { min: 6, message: 'Min 6 characters' }]}
                noStyle
              >
                <Input.Password className="efm-input" placeholder={editingUser ? '••••••' : 'At least 6 characters'} />
              </Form.Item>
            </EntityFormModal.Field>

            <EntityFormModal.Field label="Full Name" required>
              <Form.Item name="full_name" rules={[{ required: true, message: 'Required' }]} noStyle>
                <Input className="efm-input" placeholder="Full name" />
              </Form.Item>
            </EntityFormModal.Field>

            <EntityFormModal.Field label="Email">
              <Form.Item name="email" rules={[{ type: 'email', message: 'Invalid email' }]} noStyle>
                <Input className="efm-input" placeholder="name@company.com" />
              </Form.Item>
            </EntityFormModal.Field>

            <EntityFormModal.Field label="Mobile">
              <Form.Item name="mobile_number" noStyle>
                <Input className="efm-input" placeholder="10-digit phone" />
              </Form.Item>
            </EntityFormModal.Field>

            <EntityFormModal.Field label="Role" required>
              <Form.Item name="role_id" rules={[{ required: true, message: 'Required' }]} noStyle>
                <Select className="efm-select-antd" placeholder="Pick a role template" onChange={handleRoleChange}>
                  {roles.map(role => (
                    <Select.Option key={role.role_id} value={role.role_id}>
                      {role.role_name}
                    </Select.Option>
                  ))}
                </Select>
              </Form.Item>
            </EntityFormModal.Field>
          </EntityFormModal.Section>

          {/* ── Permissions editor ── */}
          {selectedRoleId && isSuperAdminRole && (
            <EntityFormModal.Section label="Permissions">
              <div className="efm-callout" style={{ gridColumn: '1 / -1' }}>
                <div style={{ fontWeight: 700, marginBottom: 2 }}>Super Admin has unlimited access</div>
                Per-user permission overrides are not applied to Super Admin accounts — they always have full access. Use a different role to restrict a user.
              </div>
            </EntityFormModal.Section>
          )}

          {selectedRoleId && !isSuperAdminRole && (
            <EntityFormModal.Section label="Permissions">
              <div style={{ gridColumn: '1 / -1' }}>
                {/* Customise switch + accelerators */}
                <div style={{
                  display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                  gap: 12, flexWrap: 'wrap',
                  padding: '8px 10px',
                  background: 'var(--bg-muted)',
                  border: '1px solid var(--border)',
                  borderRadius: 4,
                  marginBottom: 10,
                }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                    <Switch
                      size="small"
                      checked={customizing}
                      onChange={(v) => {
                        setCustomizing(v);
                        if (!v) setPerms(rolePerms(selectedRoleId));
                        setDirty(true);
                      }}
                    />
                    <Text strong style={{ fontSize: 12.5 }}>Customise for this user</Text>
                    {customizing
                      ? <Tag color="gold" style={{ marginInlineEnd: 0 }}>override active</Tag>
                      : <Tag style={{ marginInlineEnd: 0 }}>inheriting from {selectedRole?.role_name}</Tag>}
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

                <div style={{ fontSize: 11, color: 'var(--fg-tertiary)', marginBottom: 8 }}>
                  <b>{grantCount}</b> permission{grantCount === 1 ? '' : 's'} granted
                  {customizing && selectedRole ? <> · role template grants <b>{roleGrantCount}</b></> : null}
                </div>

                {/* CRUD matrix */}
                <div style={{
                  border: '1px solid var(--border)', borderRadius: 4,
                  overflow: 'hidden', marginBottom: 10,
                  background: 'var(--bg-app)',
                }}>
                  <div style={{
                    display: 'grid',
                    gridTemplateColumns: '1.8fr 56px 56px 56px 56px 52px',
                    padding: '6px 10px',
                    fontSize: 10, fontWeight: 700, letterSpacing: 1, textTransform: 'uppercase',
                    color: 'var(--fg-tertiary)',
                    background: 'var(--bg-muted)',
                    borderBottom: '1px solid var(--border)',
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
                        gridTemplateColumns: '1.8fr 56px 56px 56px 56px 52px',
                        padding: '6px 10px',
                        alignItems: 'center',
                        borderBottom: i < CRUD_MODULES.length - 1 ? '1px solid var(--border-subtle, var(--border))' : 'none',
                        fontSize: 12.5,
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

                {/* Single permissions */}
                <div style={{
                  border: '1px solid var(--border)', borderRadius: 4,
                  padding: '8px 10px', marginBottom: 10,
                  background: 'var(--bg-app)',
                }}>
                  <div style={{
                    fontSize: 9.5, fontWeight: 700, letterSpacing: 1.4, textTransform: 'uppercase',
                    color: 'var(--fg-tertiary)', marginBottom: 6,
                  }}>
                    Reports & Accounts
                  </div>
                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 4 }}>
                    {SINGLE_PERMS.map(p => (
                      <Checkbox
                        key={p.path}
                        checked={pathGet(perms, p.path)}
                        disabled={!customizing}
                        onChange={() => handleTogglePerm(p.path)}
                        style={{ fontSize: 12.5 }}
                      >
                        {p.label}
                      </Checkbox>
                    ))}
                  </div>
                </div>

                {/* Settings sub-permissions */}
                <div style={{
                  border: '1px solid var(--border)', borderRadius: 4,
                  padding: '8px 10px',
                  background: 'var(--bg-app)',
                }}>
                  <div style={{
                    fontSize: 9.5, fontWeight: 700, letterSpacing: 1.4, textTransform: 'uppercase',
                    color: 'var(--fg-tertiary)', marginBottom: 6,
                  }}>
                    Settings Access
                  </div>
                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 4 }}>
                    {SETTINGS_PERMS.map(p => (
                      <Checkbox
                        key={p.path}
                        checked={pathGet(perms, p.path)}
                        disabled={!customizing}
                        onChange={() => handleTogglePerm(p.path)}
                        style={{ fontSize: 12.5 }}
                      >
                        {p.label}
                      </Checkbox>
                    ))}
                  </div>
                </div>
              </div>
            </EntityFormModal.Section>
          )}
        </EntityFormModal>
      </Form>

      <ActionStrip
        actions={[
          {
            id: 'edit', key: 'F2', label: 'Edit',
            disabled: !single,
            onAction: () => single && handleEdit(single),
          },
          {
            id: 'new', key: 'F3', label: 'New',
            onAction: handleAdd,
          },
          {
            id: 'refresh', key: 'F5', label: 'Refresh',
            onAction: loadData,
          },
          {
            id: 'deactivate', key: 'F8',
            label: (single && !single.is_active) ? 'Activate' : 'Deactivate',
            tone: 'danger',
            disabled: !single,
            onAction: () => single && handleToggleStatus(single),
          },
          {
            id: 'open', key: 'F1', label: 'Edit', tone: 'primary',
            disabled: !single,
            onAction: () => single && handleEdit(single),
          },
        ]}
      />
    </div>
  );
}
