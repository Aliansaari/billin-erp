import React, { useEffect, useState, useMemo } from 'react';
import {
  Table, Button, Input, Space, Tag, Typography, message, Popconfirm,
  Card, Form, Select, Switch, Checkbox, Tooltip,
} from 'antd';
import {
  PlusOutlined, EditOutlined, StopOutlined, CheckCircleOutlined,
  UndoOutlined, CheckOutlined, CloseOutlined, SearchOutlined,
} from '@ant-design/icons';
import dayjs from 'dayjs';
import relativeTime from 'dayjs/plugin/relativeTime';
import { settingsAPI, godownAPI } from '../../api';
import useAuthStore from '../../store/authStore';
import useListSelection from '../../hooks/useListSelection';
import ActionStrip from '../../components/keyboard/ActionStrip';
import EntityFormModal from '../../components/EntityFormModal';
import './ModuleSettings.css';
dayjs.extend(relativeTime);

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
  const [godowns, setGodowns] = useState([]);
  const [loading, setLoading] = useState(false);
  const [modalVisible, setModalVisible] = useState(false);
  const [editingUser, setEditingUser] = useState(null);
  const [formLoading, setFormLoading] = useState(false);
  const [dirty, setDirty] = useState(false);
  // Search filter (case-insensitive, matches username / full_name / email).
  const [search, setSearch] = useState('');

  // Self-edit guard — pulled from the auth store so we can prevent the
  // operator from deactivating themselves or demoting their own admin
  // role at the UI layer (server enforces too, but a UI hint is kinder).
  const me = useAuthStore((s) => s.user);

  // Permission editor state — lives outside AntD Form because we want
  // full control over the tick grid and the "inherit from role" toggle.
  const [selectedRoleId, setSelectedRoleId] = useState(null);
  const [customizing, setCustomizing]       = useState(false);
  const [perms, setPerms]                   = useState({});
  // Per-user godown access. Three states:
  //   null  → unrestricted (default for new users; current behaviour)
  //   []    → no godown access (locks user out of every godown)
  //   [1,3] → explicit allowlist
  const [allowedGodowns, setAllowedGodowns] = useState(null);

  const [form] = Form.useForm();

  useEffect(() => { loadData(); }, []);

  const loadData = async () => {
    setLoading(true);
    try {
      const [usersRes, rolesRes, godownsRes] = await Promise.all([
        settingsAPI.getUsers(),
        settingsAPI.getRoles(),
        // Fetch the godown list so the picker has labels. Fails open
        // (empty array) on multi-warehouse-disabled installs — the
        // picker just won't appear in that case.
        godownAPI.getAll().catch(() => ({ data: { data: [] } })),
      ]);
      setUsers(usersRes.data.data || []);
      setRoles(rolesRes.data.data || []);
      setGodowns(godownsRes.data?.data || godownsRes.data || []);
    } catch { message.error('Failed to load users'); }
    setLoading(false);
  };

  const roleById = useMemo(() => Object.fromEntries(roles.map(r => [r.role_id, r])), [roles]);
  const rolePerms = (roleId) => roleById[roleId]?.permissions_json || {};

  // Audit BACKDATED-1 — flip the per-role can_enter_backdated flag.
  // Optimistic local update with a server-error rollback so the UI
  // feels instantaneous; on failure we re-load to recover ground truth.
  const handleToggleRoleBackdated = async (role, nextValue) => {
    setRoles((prev) => prev.map((r) => (r.role_id === role.role_id ? { ...r, can_enter_backdated: nextValue } : r)));
    try {
      await settingsAPI.updateRolePolicy(role.role_id, { can_enter_backdated: nextValue });
      message.success(`${role.role_name}: back-dated entries ${nextValue ? 'allowed' : 'blocked'}`);
    } catch (e) {
      message.error(e.response?.data?.error || 'Failed to update role policy');
      // Re-pull on error so the UI shows DB truth.
      try {
        const r = await settingsAPI.getRoles();
        setRoles(r.data.data || []);
      } catch { /* swallow */ }
    }
  };

  const handleAdd = () => {
    setEditingUser(null);
    form.resetFields();
    setSelectedRoleId(null);
    setCustomizing(false);
    setPerms({});
    setAllowedGodowns(null);
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
    // Godown scoping: null/undefined → unrestricted; array → allowlist.
    setAllowedGodowns(Array.isArray(record.allowed_godowns) ? record.allowed_godowns : null);
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

  // "Delete" is a deactivation on the backend — preserves audit trail,
  // ledger integrity, FK references. We keep the same RPC but rename the
  // visible label to match the actual behaviour.
  const handleDelete = async (id) => {
    if (me && id === me.user_id) {
      message.warning("You can't deactivate your own account.");
      return;
    }
    try {
      await settingsAPI.deleteUser(id);
      message.success('User deactivated');
      loadData();
    } catch (error) {
      const apiMsg = error.response?.data?.error;
      message.error(apiMsg || 'Failed to deactivate user');
    }
  };

  const handleToggleStatus = async (record) => {
    // Self-protection — don't let an admin lock themselves out from the UI.
    // The backend has its own last-active-admin check; this is just a kinder
    // hint before the request goes out.
    if (me && record.user_id === me.user_id) {
      message.warning("You can't deactivate your own account.");
      return;
    }
    try {
      await settingsAPI.updateUser(record.user_id, { is_active: !record.is_active });
      message.success(record.is_active ? 'User deactivated' : 'User activated');
      loadData();
    } catch (error) {
      const apiMsg = error.response?.data?.error;
      message.error(apiMsg || 'Failed to update status');
    }
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
      // Godown scoping. We only send `allowed_godowns` when the multi-warehouse
      // picker rendered (i.e. at least one godown exists). null means
      // unrestricted; a populated array means "only these godown_ids".
      if (godowns.length > 0) values.allowed_godowns = allowedGodowns;
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

  // Initial-letter avatar — reuses the same colour vocabulary as the top-nav
  // avatar so a user's chip stays consistent across the app.
  const initialOf = (name = '') => (name.trim()[0] || '?').toUpperCase();
  const ROLE_HEX = {
    'Super Admin':     '#B1472F',
    'Admin':           '#4F46E5',
    'Manager':         '#7C3AED',
    'Accountant':      '#3B82F6',
    'Salesman':        '#10B981',
    'Cashier':         '#10B981',
    'Inventory Staff': '#F59E0B',
  };

  const columns = [
    {
      title: 'User',
      key: 'user',
      width: 260,
      render: (_, record) => {
        const roleName = getRoleName(record.role_id);
        const bg = ROLE_HEX[roleName] || '#4F46E5';
        return (
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, minWidth: 0 }}>
            <div
              style={{
                flex: '0 0 auto',
                width: 32, height: 32, borderRadius: 999,
                background: bg, color: '#fff',
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                fontSize: 13, fontWeight: 600, letterSpacing: 0.2,
              }}
              aria-hidden="true"
            >
              {initialOf(record.full_name || record.username)}
            </div>
            <div style={{ minWidth: 0, lineHeight: 1.25 }}>
              <div style={{
                fontWeight: 600, fontSize: 13,
                color: 'var(--fg-primary)',
                whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
              }}>
                {record.full_name || record.username}
                {me && record.user_id === me.user_id && (
                  <Tag color="default" style={{ marginInlineStart: 6, fontSize: 10, lineHeight: '16px', padding: '0 6px' }}>you</Tag>
                )}
              </div>
              <div style={{
                fontSize: 11.5, color: 'var(--fg-tertiary)',
                whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
              }}>
                @{record.username}
              </div>
            </div>
          </div>
        );
      },
    },
    {
      title: 'Role',
      dataIndex: 'role_id',
      key: 'role',
      width: 170,
      render: (roleId, record) => {
        const name = getRoleName(roleId);
        return (
          <Space size={4}>
            <Tag color={ROLE_COLORS[name] || 'default'} style={{ marginInlineEnd: 0 }}>{name}</Tag>
            {record.custom_permissions && (
              <Tooltip title="Permissions customised for this user">
                <Tag color="geekblue" style={{ marginInlineEnd: 0 }}>custom</Tag>
              </Tooltip>
            )}
          </Space>
        );
      },
    },
    {
      title: 'Contact',
      key: 'contact',
      render: (_, record) => {
        if (!record.email && !record.mobile_number) {
          return <Text type="secondary" style={{ fontSize: 12 }}>—</Text>;
        }
        return (
          <div style={{ lineHeight: 1.3, minWidth: 0 }}>
            {record.email && (
              <div style={{
                fontSize: 12.5, color: 'var(--fg-primary)',
                whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', maxWidth: 240,
              }}>
                {record.email}
              </div>
            )}
            {record.mobile_number && (
              <div style={{ fontSize: 11.5, color: 'var(--fg-tertiary)', fontVariantNumeric: 'tabular-nums' }}>
                {record.mobile_number}
              </div>
            )}
          </div>
        );
      },
    },
    {
      title: 'Last Login',
      dataIndex: 'last_login',
      key: 'last_login',
      width: 130,
      render: (v) => v
        ? <Tooltip title={dayjs(v).format('DD MMM YYYY, HH:mm')}>
            <span style={{ color: 'var(--fg-secondary)', fontSize: 12.5, whiteSpace: 'nowrap' }}>
              {dayjs(v).fromNow()}
            </span>
          </Tooltip>
        : <Text type="secondary" style={{ fontSize: 12 }}>Never</Text>,
    },
    {
      title: 'Created',
      dataIndex: 'created_date',
      key: 'created_date',
      width: 105,
      render: (v) => v
        ? <Tooltip title={dayjs(v).format('DD MMM YYYY, HH:mm')}>
            <span style={{ color: 'var(--fg-tertiary)', fontSize: 12, whiteSpace: 'nowrap' }}>
              {dayjs(v).format('DD MMM YY')}
            </span>
          </Tooltip>
        : <Text type="secondary" style={{ fontSize: 12 }}>—</Text>,
    },
    {
      title: 'Status',
      dataIndex: 'is_active',
      key: 'status',
      width: 92,
      // Status as a compact pill, not a switch. The switch was visually heavy
      // and competed with the row's primary identity (the User cell). Activate
      // / Deactivate live in the Actions column, which is where admins
      // intuitively reach for them anyway.
      render: (active) => (
        <span
          className="user-status-pill"
          data-active={active ? 'true' : 'false'}
          style={{
            display: 'inline-flex', alignItems: 'center', gap: 6,
            padding: '2px 8px', borderRadius: 999,
            fontSize: 11.5, fontWeight: 500, letterSpacing: 0.2,
            background: active ? 'rgba(16,185,129,0.12)' : 'rgba(148,163,184,0.14)',
            color: active ? '#10B981' : 'var(--fg-tertiary)',
            border: `1px solid ${active ? 'rgba(16,185,129,0.32)' : 'rgba(148,163,184,0.28)'}`,
            whiteSpace: 'nowrap',
          }}
        >
          <span
            style={{
              display: 'inline-block', width: 6, height: 6, borderRadius: 999,
              background: active ? '#10B981' : 'var(--fg-tertiary)',
            }}
            aria-hidden="true"
          />
          {active ? 'Active' : 'Inactive'}
        </span>
      ),
    },
    {
      title: '',
      key: 'actions',
      width: 100,
      align: 'right',
      render: (_, record) => {
        const isMe = me && record.user_id === me.user_id;
        return (
          <Space size={2}>
            <Tooltip title="Edit user">
              <Button
                type="text"
                size="small"
                icon={<EditOutlined />}
                onClick={() => handleEdit(record)}
              />
            </Tooltip>
            {record.is_active ? (
              <Popconfirm
                title="Deactivate this user?"
                description="They won't be able to log in until reactivated."
                onConfirm={() => handleDelete(record.user_id)}
                okText="Yes, deactivate"
                okButtonProps={{ danger: true }}
                cancelText="Cancel"
                disabled={isMe}
              >
                <Tooltip title={isMe ? "You can't deactivate yourself" : 'Deactivate user'}>
                  <Button
                    type="text"
                    size="small"
                    danger
                    icon={<StopOutlined />}
                    disabled={isMe}
                  />
                </Tooltip>
              </Popconfirm>
            ) : (
              <Tooltip title="Activate user">
                <Button
                  type="text"
                  size="small"
                  icon={<CheckCircleOutlined style={{ color: '#10B981' }} />}
                  onClick={() => handleToggleStatus(record)}
                />
              </Tooltip>
            )}
          </Space>
        );
      },
    },
  ];

  const grantCount = countGrants(perms);
  const roleGrantCount = selectedRole ? countGrants(rolePerms(selectedRoleId)) : 0;

  // Case-insensitive filter across the columns admins actually scan visually:
  // username, full name, email, mobile, role name. Empty search short-circuits
  // back to the full list (avoids an unnecessary array walk on every keystroke).
  const filteredUsers = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return users;
    return users.filter((u) => {
      const role = getRoleName(u.role_id).toLowerCase();
      return (
        (u.username || '').toLowerCase().includes(q) ||
        (u.full_name || '').toLowerCase().includes(q) ||
        (u.email || '').toLowerCase().includes(q) ||
        (u.mobile_number || '').toLowerCase().includes(q) ||
        role.includes(q)
      );
    });
  }, [users, search, roleById]); // roleById drives getRoleName; keep it in deps

  // Cursor over the (filtered) user list — arrow nav drives the F-key strip below.
  const sel = useListSelection({ totalCount: filteredUsers.length, rows: filteredUsers });
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
        {/* Override the shared 880px max-width — the user table has 7 columns
         *  and needs the full pane to render without horizontal scroll. */}
        <div className="ms-page-body-inner" style={{ maxWidth: 'none' }}>
          <Card bordered={false} style={{ background: 'var(--bg-panel)', border: '1px solid var(--border-subtle)', borderRadius: 10 }}>
        <div style={{
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          gap: 12, marginBottom: 10, flexWrap: 'wrap',
        }}>
          <Input
            allowClear
            prefix={<SearchOutlined style={{ color: 'var(--fg-tertiary)' }} />}
            placeholder="Search by name, username, email, mobile, or role"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            style={{ maxWidth: 380 }}
          />
          <Text type="secondary" style={{ fontSize: 12 }}>
            {filteredUsers.length} of {users.length} user{users.length === 1 ? '' : 's'}
          </Text>
        </div>
        <Table
          columns={columns}
          dataSource={filteredUsers}
          rowKey="user_id"
          loading={loading}
          // Pagination off in favour of a scrollable body — admins typically
          // have <100 users and want to see them all without paging through
          // 10-at-a-time pages. Sticky header keeps column labels visible
          // while the body scrolls.
          pagination={false}
          sticky
          scroll={{ y: 'calc(100vh - 280px)' }}
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

          {/* ── Role Policies ─────────────────────────────────────────────
           *  Per-role capability flags that gate transactional behaviour
           *  but aren't part of the JSONB permission matrix above.
           *  Currently exposes can_enter_backdated; future flags can
           *  land in the same panel.
           *  Hidden when no roles are loaded (defensive). */}
          {roles.length > 0 && (
            <Card
              bordered={false}
              style={{
                marginTop: 12,
                background: 'var(--bg-panel)',
                border: '1px solid var(--border-subtle)',
                borderRadius: 10,
              }}
              title={
                <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                  <span style={{ fontWeight: 600 }}>Role Policies</span>
                  <Text type="secondary" style={{ fontSize: 12, fontWeight: 400 }}>
                    Per-role rules that gate transactional behaviour beyond the per-user permission matrix above.
                  </Text>
                </div>
              }
            >
              <div style={{
                border: '1px solid var(--border)',
                borderRadius: 6,
                background: 'var(--bg-app)',
                overflow: 'hidden',
              }}>
                {/* Header row */}
                <div style={{
                  display: 'grid',
                  gridTemplateColumns: '1.6fr 1fr',
                  padding: '8px 12px',
                  background: 'var(--bg-subtle, var(--bg-panel))',
                  borderBottom: '1px solid var(--border-subtle)',
                  fontSize: 11,
                  fontWeight: 700,
                  letterSpacing: 1.2,
                  textTransform: 'uppercase',
                  color: 'var(--fg-tertiary)',
                }}>
                  <div>Role</div>
                  <Tooltip title="When OFF, members of this role cannot save bills / payments / vouchers / EMIs with a date earlier than today. Subject to the company-wide toggle in Settings → Defaults — if that's OFF, every role is blocked regardless.">
                    <div style={{ cursor: 'help' }}>
                      Allow back-dated entries
                    </div>
                  </Tooltip>
                </div>
                {roles.map((r, i) => (
                  <div
                    key={r.role_id}
                    style={{
                      display: 'grid',
                      gridTemplateColumns: '1.6fr 1fr',
                      padding: '10px 12px',
                      alignItems: 'center',
                      borderBottom: i < roles.length - 1 ? '1px solid var(--border-subtle)' : 'none',
                      fontSize: 13,
                    }}
                  >
                    <div style={{ fontWeight: 500 }}>
                      {r.role_name}
                      {r.role_name === 'Super Admin' && (
                        <Text type="secondary" style={{ marginLeft: 6, fontSize: 11 }}>
                          (built-in; flag has no effect)
                        </Text>
                      )}
                    </div>
                    <div>
                      <Switch
                        checked={r.can_enter_backdated !== false}
                        onChange={(checked) => handleToggleRoleBackdated(r, checked)}
                        checkedChildren="Allowed"
                        unCheckedChildren="Blocked"
                      />
                    </div>
                  </div>
                ))}
              </div>
            </Card>
          )}
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
              help={editingUser
                ? 'Leave blank to keep the existing password.'
                : 'Minimum 8 characters. Avoid weak defaults like admin123 / password.'}
            >
              <Form.Item
                name="password"
                rules={editingUser
                  ? [
                      // Even on edit, if the admin types something they must
                      // type a *real* password. The blank-keeps-existing
                      // branch handles "leave it alone" in handleSubmit.
                      { min: 8, message: 'Min 8 characters' },
                      {
                        validator: (_, v) => {
                          if (!v) return Promise.resolve();
                          const banned = ['admin', 'admin123', 'password', 'password123', '12345678', 'qwerty123', 'changeme'];
                          if (banned.includes(v.toLowerCase())) {
                            return Promise.reject(new Error('Too common — pick something less guessable'));
                          }
                          return Promise.resolve();
                        },
                      },
                    ]
                  : [
                      { required: true, message: 'Required' },
                      { min: 8, message: 'Min 8 characters' },
                      {
                        validator: (_, v) => {
                          if (!v) return Promise.resolve();
                          const banned = ['admin', 'admin123', 'password', 'password123', '12345678', 'qwerty123', 'changeme'];
                          if (banned.includes(v.toLowerCase())) {
                            return Promise.reject(new Error('Too common — pick something less guessable'));
                          }
                          return Promise.resolve();
                        },
                      },
                    ]}
                noStyle
              >
                <Input.Password className="efm-input" placeholder={editingUser ? '••••••' : 'At least 8 characters'} />
              </Form.Item>
            </EntityFormModal.Field>

            <EntityFormModal.Field label="Full Name" required>
              <Form.Item name="full_name" rules={[{ required: true, message: 'Required' }]} noStyle>
                <Input className="efm-input" placeholder="Full name" />
              </Form.Item>
            </EntityFormModal.Field>

            <EntityFormModal.Field label="Email">
              <Form.Item
                name="email"
                rules={[
                  // Server-side regex is RFC-5321 strict; mirror it here so the
                  // admin sees the error before the request goes out. The AntD
                  // `type: 'email'` rule is too permissive.
                  {
                    validator: (_, v) => {
                      if (!v) return Promise.resolve();
                      const re = /^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/;
                      return re.test(v) ? Promise.resolve() : Promise.reject(new Error('Enter a valid email'));
                    },
                  },
                ]}
                noStyle
              >
                <Input className="efm-input" placeholder="name@company.com" />
              </Form.Item>
            </EntityFormModal.Field>

            <EntityFormModal.Field label="Mobile" help="10-digit Indian mobile, starting 6–9.">
              <Form.Item
                name="mobile_number"
                rules={[
                  {
                    // Match server validateMobile — 10 digits, 6/7/8/9 first.
                    // The server also strips +91 / leading 0 / spaces, but we
                    // ask the admin to type the canonical form so what they
                    // see in the input matches what gets stored.
                    validator: (_, v) => {
                      if (!v) return Promise.resolve();
                      return /^[6-9]\d{9}$/.test(v.trim())
                        ? Promise.resolve()
                        : Promise.reject(new Error('10-digit Indian mobile (starts 6–9)'));
                    },
                  },
                ]}
                noStyle
              >
                <Input className="efm-input" placeholder="9876543210" maxLength={10} />
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

          {/* ── Godown access ──
           *  Only renders for multi-warehouse installs (godowns.length > 0).
           *  Three states are stored in `allowedGodowns`:
           *    null  → unrestricted (legacy default, every godown visible)
           *    []    → no access (locks the user out entirely)
           *    [..]  → explicit allowlist of godown_ids
           *  We model "unrestricted" as a switch and the picker only renders
           *  when restriction is on, so the common case (most users see
           *  everything) is one click. */}
          {godowns.length > 0 && (
            <EntityFormModal.Section label="Godown Access">
              <div style={{ gridColumn: '1 / -1' }}>
                {/* Two-card segmented control. Avoids the stretched-Switch
                 *  look that the .efm-field's column-flex layout produces
                 *  with `checkedChildren`. Cards are full-row but visually
                 *  paired so the active state is unambiguous. */}
                <div
                  role="radiogroup"
                  aria-label="Godown access mode"
                  style={{
                    display: 'grid',
                    gridTemplateColumns: '1fr 1fr',
                    gap: 8,
                    marginBottom: allowedGodowns !== null ? 12 : 0,
                  }}
                >
                  {[
                    {
                      key: 'all',
                      title: 'All godowns',
                      desc: 'User can see and act on every godown.',
                      active: allowedGodowns === null,
                      onClick: () => { setAllowedGodowns(null); setDirty(true); },
                    },
                    {
                      key: 'restricted',
                      title: 'Specific godowns',
                      desc: 'Limit this user to the godowns you pick below.',
                      active: allowedGodowns !== null,
                      onClick: () => { if (allowedGodowns === null) setAllowedGodowns([]); setDirty(true); },
                    },
                  ].map((opt) => (
                    <button
                      key={opt.key}
                      type="button"
                      role="radio"
                      aria-checked={opt.active}
                      onClick={opt.onClick}
                      style={{
                        textAlign: 'left',
                        padding: '10px 12px',
                        borderRadius: 6,
                        background: opt.active ? 'var(--accent-bg, rgba(99,102,241,0.10))' : 'var(--bg-app)',
                        border: `1px solid ${opt.active ? 'var(--accent)' : 'var(--border)'}`,
                        cursor: 'pointer',
                        transition: 'all 0.12s',
                        outline: 'none',
                        fontFamily: 'inherit',
                      }}
                    >
                      <div style={{
                        display: 'flex', alignItems: 'center', gap: 8,
                        fontSize: 13, fontWeight: 600,
                        color: opt.active ? 'var(--accent)' : 'var(--fg-primary)',
                        marginBottom: 3,
                      }}>
                        <span
                          aria-hidden="true"
                          style={{
                            width: 14, height: 14, borderRadius: 999,
                            border: `2px solid ${opt.active ? 'var(--accent)' : 'var(--border-strong, var(--border))'}`,
                            background: opt.active ? 'var(--accent)' : 'transparent',
                            boxShadow: opt.active ? 'inset 0 0 0 3px var(--bg-app)' : 'none',
                            flex: '0 0 auto',
                          }}
                        />
                        {opt.title}
                      </div>
                      <div style={{
                        fontSize: 11.5, color: 'var(--fg-tertiary)',
                        lineHeight: 1.4, paddingInlineStart: 22,
                      }}>
                        {opt.desc}
                      </div>
                    </button>
                  ))}
                </div>

                {allowedGodowns !== null && (
                  <div>
                    <label className="efm-lbl" style={{ marginBottom: 4, display: 'block' }}>
                      Allowed godowns
                    </label>
                    <Select
                      mode="multiple"
                      className="efm-select-antd"
                      placeholder="Pick the godowns this user can access"
                      value={allowedGodowns}
                      onChange={(v) => { setAllowedGodowns(v); setDirty(true); }}
                      options={godowns.map((g) => ({
                        value: g.godown_id,
                        label: g.godown_name + (g.is_main ? ' (Main)' : ''),
                      }))}
                      style={{ width: '100%' }}
                    />
                    {allowedGodowns.length === 0 && (
                      <div style={{ fontSize: 11.5, color: 'var(--warning, #F59E0B)', marginTop: 4 }}>
                        No godowns selected — this user will be locked out of every godown.
                      </div>
                    )}
                  </div>
                )}
              </div>
            </EntityFormModal.Section>
          )}

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
