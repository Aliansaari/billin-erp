import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Table, Button, Switch, Tag, Space, Popconfirm, message, Tooltip } from 'antd';
import { PlusOutlined, EditOutlined, DeleteOutlined } from '@ant-design/icons';
import { salesmanAPI } from '../../api';
import useListSelection from '../../hooks/useListSelection';
import ActionStrip from '../../components/keyboard/ActionStrip';
import EntityFormModal from '../../components/EntityFormModal';
import './ModuleSettings.css';

const { Section, Field } = EntityFormModal;
const EMPTY_SM = { code: '', name: '', phone: '', email: '', commission_percentage: '', notes: '' };

/*
 * Settings → Salesmen.
 *
 * Manage the list of sales staff credited on bills. Add / Edit via modal,
 * activate / deactivate, and Delete with the server's guard (a salesman
 * referenced by any bill can't be hard-deleted — the controller returns a
 * useful message which we relay verbatim, and the operator deactivates
 * instead, preserving historical attribution).
 *
 * PURE ATTRIBUTION: a salesman is only ever a label on a bill. Nothing on
 * this page affects any total, tax, ledger, or balance. The commission % is
 * informational — surfaced in the Sales-by-Salesman report as an indicative
 * figure only; it is never auto-applied to a bill or posted to a ledger.
 *
 * Plain Antd Table (no virtualisation) — sales rosters are small.
 */

export default function SalesmanList() {
  const [rows, setRows]             = useState([]);
  const [loading, setLoading]       = useState(false);
  const [editing, setEditing]       = useState(null);   // null = closed, {} = create, {…} = edit
  const [submitting, setSubmitting] = useState(false);
  const [form, setForm]             = useState(EMPTY_SM);
  const [initialForm, setInitialForm] = useState(EMPTY_SM);
  const [formErrors, setFormErrors]   = useState({});

  const load = async () => {
    setLoading(true);
    try {
      const { data } = await salesmanAPI.getAll({ include_inactive: 'true' });
      setRows(Array.isArray(data) ? data : []);
    } catch (err) {
      message.error(err?.response?.data?.error || 'Failed to load salesmen');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(); }, []);

  const hydrate = (s) => {
    const pct = parseFloat(s?.commission_percentage);
    const fresh = {
      code: s?.code || '',
      name: s?.name || '',
      phone: s?.phone || '',
      email: s?.email || '',
      // Show a clean empty field for a zero/blank commission rather than "0".
      commission_percentage: (isFinite(pct) && pct > 0) ? String(pct) : '',
      notes: s?.notes || '',
    };
    setForm(fresh);
    setInitialForm(fresh);
    setFormErrors({});
  };

  const openCreate = () => { setEditing({}); hydrate(null); };
  const openEdit   = (s) => { setEditing(s); hydrate(s); };
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
    if (!(form.name || '').trim()) next.name = 'Name is required';
    else if (form.name.length > 100) next.name = 'Max 100 characters';
    if (form.code && form.code.length > 20) next.code = 'Max 20 characters';
    if (form.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(form.email.trim())) {
      next.email = 'Enter a valid email';
    }
    if (form.commission_percentage !== '') {
      const n = parseFloat(form.commission_percentage);
      if (!isFinite(n) || n < 0 || n > 100) next.commission_percentage = 'Enter a value between 0 and 100';
    }
    setFormErrors(next);
    if (Object.keys(next).length) {
      message.warning('Fix the highlighted fields and try again');
      return;
    }
    setSubmitting(true);
    try {
      const payload = {
        name: form.name.trim(),
        code: (form.code || '').trim() ? form.code.trim().toUpperCase() : null,
        phone: (form.phone || '').trim() || null,
        email: (form.email || '').trim() || null,
        commission_percentage: form.commission_percentage === '' ? 0 : parseFloat(form.commission_percentage),
        notes: (form.notes || '').trim() || null,
      };
      if (editing && editing.salesman_id) {
        await salesmanAPI.update(editing.salesman_id, payload);
        message.success('Salesman updated');
      } else {
        await salesmanAPI.create(payload);
        message.success('Salesman added');
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

  const toggleActive = async (s) => {
    try {
      await salesmanAPI.update(s.salesman_id, { is_active: !s.is_active });
      await load();
    } catch (err) {
      message.error(err?.response?.data?.error || 'Failed to toggle active');
    }
  };

  // Cursor + multi-select on rows. Strip below acts on the cursored row.
  const sel = useListSelection({ totalCount: rows.length, rows });
  const single = sel.activeRow;

  const remove = async (s) => {
    try {
      await salesmanAPI.delete(s.salesman_id);
      message.success(`Deleted ${s.name}`);
      await load();
    } catch (err) {
      // Delete is the likely place to hit a 400 with a useful message
      // (salesman credited on bills) — surface it verbatim so the operator
      // knows to deactivate instead.
      message.error(err?.response?.data?.error || 'Delete failed', 6);
    }
  };

  const columns = useMemo(() => [
    {
      title: 'Code', dataIndex: 'code', width: 110,
      render: (v) => v
        ? <span style={{ fontWeight: 600, fontFamily: 'var(--font-mono, monospace)' }}>{v}</span>
        : <span style={{ color: 'var(--text-muted, #999)' }}>—</span>,
    },
    {
      title: 'Name', dataIndex: 'name',
      render: (v, row) => (
        <Space size={6}>
          <span style={{ fontWeight: 500 }}>{v}</span>
          {!row.is_active && <Tag color="default">inactive</Tag>}
        </Space>
      ),
    },
    {
      title: 'Contact', key: 'contact',
      render: (_, row) => [row.phone, row.email].filter(Boolean).join('  ·  ') || '—',
    },
    {
      title: 'Commission', dataIndex: 'commission_percentage', width: 130, align: 'right',
      render: (v) => {
        const n = parseFloat(v);
        return (isFinite(n) && n > 0)
          ? <Tooltip title="Indicative only — shown in the salesman report, never auto-applied to bills">{n}%</Tooltip>
          : <span style={{ color: 'var(--text-muted, #999)' }}>—</span>;
      },
    },
    {
      title: 'Active', dataIndex: 'is_active', width: 90, align: 'center',
      render: (v, row) => (
        <Switch size="small" checked={!!v} onChange={() => toggleActive(row)} />
      ),
    },
    {
      title: 'Actions', key: 'actions', width: 200, align: 'right',
      render: (_, row) => (
        <Space size={4}>
          <Button size="small" icon={<EditOutlined />} onClick={() => openEdit(row)}>Edit</Button>
          <Popconfirm
            title={`Delete ${row.name}?`}
            description="Permanent. A salesman credited on any bill can't be deleted — deactivate instead."
            okText="Delete"
            okButtonProps={{ danger: true }}
            onConfirm={() => remove(row)}
          >
            <Button size="small" danger icon={<DeleteOutlined />}>Delete</Button>
          </Popconfirm>
        </Space>
      ),
    },
  ], []);

  return (
    <div className="ms-shell settings-pane-fill">
      <header className="ms-page-header" style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 16 }}>
        <div>
          <h1 className="ms-page-title">Salesmen</h1>
          <p className="ms-page-sub">
            The sales staff you can credit on a bill. Pick one from the dropdown on the Sales Bill form; see per-salesman totals in the Sales by Salesman report.
          </p>
        </div>
        <Button type="primary" icon={<PlusOutlined />} onClick={openCreate}>Add Salesman</Button>
      </header>

      <div className="ms-page-body">
        <div className="ms-page-body-inner">
          <Table
            rowKey="salesman_id"
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

      {/* ── Add / Edit Salesman — shared EntityFormModal shell. Identity
       *  (name + code) and Contact & Commission (phone / email / % / notes). */}
      <EntityFormModal
        open={!!editing}
        onClose={close}
        title={editing && editing.salesman_id ? 'Edit Salesman' : 'Add Salesman'}
        subtitle={editing && editing.salesman_id
          ? `${editing.name} · update details`
          : 'New sales staff member'}
        entityIcon="S"
        entityTone="info"
        dirty={formDirty}
        saving={submitting}
        onSave={submit}
        onSaveAndClose={submit}
        onReset={handleReset}
        width={560}
      >
        <Section label="Identity">
          <Field label="Name" required error={formErrors.name}>
            <input
              className={`efm-input${formErrors.name ? ' has-error' : ''}`}
              value={form.name}
              onChange={setField('name')}
              maxLength={100}
              autoFocus
            />
          </Field>

          <Field label="Code" error={formErrors.code}
            help="Optional short identifier — e.g. RAVI, S-01. Auto-uppercased.">
            <input
              className={`efm-input${formErrors.code ? ' has-error' : ''}`}
              value={form.code}
              onChange={setField('code')}
              maxLength={20}
              style={{ textTransform: 'uppercase' }}
            />
          </Field>
        </Section>

        <Section label="Contact & Commission">
          <Field label="Phone">
            <input className="efm-input" value={form.phone} onChange={setField('phone')} maxLength={20} inputMode="tel" />
          </Field>

          <Field label="Email" error={formErrors.email}>
            <input
              className={`efm-input${formErrors.email ? ' has-error' : ''}`}
              value={form.email}
              onChange={setField('email')}
              maxLength={120}
              inputMode="email"
            />
          </Field>

          <Field label="Commission %" error={formErrors.commission_percentage}
            help="Indicative only. Shown in the Sales by Salesman report; never auto-applied to any bill or ledger.">
            <input
              className={`efm-input${formErrors.commission_percentage ? ' has-error' : ''}`}
              value={form.commission_percentage}
              onChange={setField('commission_percentage')}
              inputMode="decimal"
              placeholder="0"
            />
          </Field>

          <Field label="Notes" span="full">
            <textarea
              className="efm-textarea"
              value={form.notes}
              onChange={setField('notes')}
              maxLength={500}
              rows={2}
            />
          </Field>
        </Section>
      </EntityFormModal>

      <ActionStrip
        actions={[
          { id: 'edit', key: 'F2', label: 'Edit', disabled: !single, onAction: () => single && openEdit(single) },
          { id: 'new', key: 'F3', label: 'New', onAction: openCreate },
          { id: 'refresh', key: 'F5', label: 'Refresh', onAction: load },
          {
            id: 'deactivate', key: 'F8',
            label: (single && !single.is_active) ? 'Activate' : 'Deactivate',
            tone: 'danger',
            disabled: !single,
            onAction: () => single && toggleActive(single),
          },
          { id: 'open', key: 'F1', label: 'Edit', tone: 'primary', disabled: !single, onAction: () => single && openEdit(single) },
        ]}
      />
    </div>
  );
}
