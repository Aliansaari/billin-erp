import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Table, Button, Switch, Tag, Space, Popconfirm, message, Tooltip } from 'antd';
import { BankOutlined, PlusOutlined, EditOutlined, DeleteOutlined, CheckCircleFilled, StarFilled } from '@ant-design/icons';
import { godownAPI } from '../../api';
import useListSelection from '../../hooks/useListSelection';
import ActionStrip from '../../components/keyboard/ActionStrip';
import EntityFormModal from '../../components/EntityFormModal';
import './ModuleSettings.css';

const { Section, Field } = EntityFormModal;
const EMPTY_GD = { code: '', name: '', address: '', city: '', state: '', pincode: '', gstin: '' };

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
  // Replaced Antd Form with plain state — handled by the shared
  // EntityFormModal shell. 7 fields, no async validators.
  const [form, setForm]             = useState(EMPTY_GD);
  const [initialForm, setInitialForm] = useState(EMPTY_GD);
  const [formErrors, setFormErrors]   = useState({});

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

  const hydrate = (g) => {
    const fresh = {
      code: g?.code || '',
      name: g?.name || '',
      address: g?.address || '',
      city: g?.city || '',
      state: g?.state || '',
      pincode: g?.pincode || '',
      gstin: g?.gstin || '',
    };
    setForm(fresh);
    setInitialForm(fresh);
    setFormErrors({});
  };

  const openCreate = () => { setEditing({}); hydrate(null); };
  const openEdit   = (g) => { setEditing(g); hydrate(g); };
  const close      = () => { setEditing(null); hydrate(null); };

  const setField = (k) => (e) => {
    const v = e?.target ? e.target.value : e;
    setForm((p) => ({ ...p, [k]: v }));
    if (formErrors[k]) setFormErrors((er) => { const x = { ...er }; delete x[k]; return x; });
  };

  const formDirty = useMemo(() => {
    return Object.keys(initialForm).some((k) =>
      (form[k] || '') !== (initialForm[k] || ''));
  }, [form, initialForm]);

  const submit = async () => {
    const next = {};
    if (!(form.code || '').trim()) next.code = 'Code is required';
    else if (form.code.length > 20) next.code = 'Max 20 characters';
    if (!(form.name || '').trim()) next.name = 'Name is required';
    else if (form.name.length > 100) next.name = 'Max 100 characters';
    if (form.gstin && form.gstin.length !== 15) next.gstin = 'GSTIN must be 15 characters';
    setFormErrors(next);
    if (Object.keys(next).length) {
      message.warning('Fix the highlighted fields and try again');
      return;
    }
    setSubmitting(true);
    try {
      const payload = {
        ...form,
        code: form.code.trim().toUpperCase(),
        name: form.name.trim(),
      };
      if (editing && editing.godown_id) {
        await godownAPI.update(editing.godown_id, payload);
        message.success('Godown updated');
      } else {
        await godownAPI.create(payload);
        message.success('Godown created');
      }
      close();
      await load();
    } catch (err) {
      message.error(err?.response?.data?.error || 'Save failed');
    } finally {
      setSubmitting(false);
    }
  };

  const handleReset = useCallback(() => {
    setForm(initialForm);
    setFormErrors({});
  }, [initialForm]);

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

  // Cursor + multi-select on godown rows. Strip below acts on the cursored
  // row.
  const sel = useListSelection({ totalCount: rows.length, rows });
  const single = sel.activeRow;

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
    <div className="ms-shell settings-pane-fill">
      <header className="ms-page-header" style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 16 }}>
        <div>
          <h1 className="ms-page-title">Godowns</h1>
          <p className="ms-page-sub">
            Physical storage locations. Each bill is issued from a specific godown; stock is tracked per-godown.
          </p>
        </div>
        <Button type="primary" icon={<PlusOutlined />} onClick={openCreate}>Add Godown</Button>
      </header>

      <div className="ms-page-body">
        <div className="ms-page-body-inner">
      <Table
        rowKey="godown_id"
        loading={loading}
        dataSource={rows}
        columns={columns}
        pagination={false}
        size="middle"
        style={{ background: 'var(--bg-elevated, white)' }}
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
          onDoubleClick: () => record && openEdit(record),
        })}
      />
        </div>
      </div>

      {/* ── Add / Edit Godown — uses the shared EntityFormModal shell.
       *  Two sections: Identity (code + name + address) and
       *  Location & Tax (city / state / pin / GSTIN override). Tone
       *  is `info` since godowns are an admin/settings surface. */}
      <EntityFormModal
        open={!!editing}
        onClose={close}
        title={editing && editing.godown_id ? 'Edit Godown' : 'Add Godown'}
        subtitle={editing && editing.godown_id
          ? `${editing.code} · update godown details`
          : 'New warehouse / branch location'}
        entityIcon="G"
        entityTone="info"
        dirty={formDirty}
        saving={submitting}
        onSave={submit}
        onSaveAndClose={submit}
        onReset={handleReset}
        width={560}
      >
        <Section label="Identity">
          <Field label="Code" required error={formErrors.code}
            help="Short identifier — e.g. MAIN, MUM-01. Auto-uppercased.">
            <input
              className={`efm-input${formErrors.code ? ' has-error' : ''}`}
              value={form.code}
              onChange={setField('code')}
              maxLength={20}
              autoFocus
              style={{ textTransform: 'uppercase' }}
            />
          </Field>

          <Field label="Name" required error={formErrors.name}>
            <input
              className={`efm-input${formErrors.name ? ' has-error' : ''}`}
              value={form.name}
              onChange={setField('name')}
              maxLength={100}
            />
          </Field>

          <Field label="Address" span="full">
            <textarea
              className="efm-textarea"
              value={form.address}
              onChange={setField('address')}
              maxLength={500}
              rows={2}
            />
          </Field>
        </Section>

        <Section label="Location & Tax">
          <Field label="City">
            <input className="efm-input" value={form.city} onChange={setField('city')} />
          </Field>

          <Field label="State" help="Used for Place-of-Supply on bills issued from this godown">
            <input className="efm-input" value={form.state} onChange={setField('state')} />
          </Field>

          <Field label="PIN">
            <input className="efm-input" value={form.pincode} onChange={setField('pincode')} maxLength={10} inputMode="numeric" />
          </Field>

          <Field label="GSTIN Override" span="full" error={formErrors.gstin}
            help="Leave blank to use the company GSTIN. Set only when this godown has its own state registration.">
            <input
              className={`efm-input${formErrors.gstin ? ' has-error' : ''}`}
              value={form.gstin}
              onChange={(e) => setField('gstin')(e.target.value.toUpperCase())}
              maxLength={15}
              style={{ fontFamily: 'Geist Mono, JetBrains Mono, monospace', textTransform: 'uppercase' }}
            />
          </Field>
        </Section>
      </EntityFormModal>

      <ActionStrip
        actions={[
          {
            id: 'edit', key: 'F2', label: 'Edit',
            disabled: !single,
            onAction: () => single && openEdit(single),
          },
          {
            id: 'new', key: 'F3', label: 'New',
            onAction: openCreate,
          },
          {
            id: 'refresh', key: 'F5', label: 'Refresh',
            onAction: load,
          },
          {
            id: 'deactivate', key: 'F8',
            label: (single && !single.is_active) ? 'Activate' : 'Deactivate',
            tone: 'danger',
            disabled: !single || single.is_default,
            onAction: () => single && toggleActive(single),
          },
          {
            id: 'open', key: 'F1', label: 'Edit', tone: 'primary',
            disabled: !single,
            onAction: () => single && openEdit(single),
          },
        ]}
      />
    </div>
  );
}
