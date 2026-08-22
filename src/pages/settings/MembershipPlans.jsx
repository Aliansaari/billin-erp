import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Table, Button, Switch, Tag, Space, Popconfirm, message } from 'antd';
import { PlusOutlined, EditOutlined, DeleteOutlined } from '@ant-design/icons';
import { membershipAPI } from '../../api';
import useListSelection from '../../hooks/useListSelection';
import ActionStrip from '../../components/keyboard/ActionStrip';
import EntityFormModal from '../../components/EntityFormModal';
import './ModuleSettings.css';

const { Section, Field } = EntityFormModal;
const EMPTY_PLAN = {
  plan_name: '', discount_percent: '', points_per_100: '',
  validity_months: '', sort_order: '', notes: '',
};

/*
 * Settings → Membership Plans.
 *
 * Define the loyalty tiers customers can be enrolled into (Silver / Gold /
 * Platinum). Each plan carries the discount % and points rate the billing
 * layer reads in a later update, plus an optional validity window.
 *
 * LOYALTY METADATA ONLY: nothing on this page posts to a ledger, changes a
 * bill total, or moves money. The discount and points values are configuration
 * the billing pipeline consumes later; editing them here has no retroactive
 * effect on any past bill. A plan that has enrolled members can't be deleted —
 * the server guards this and we relay the message; deactivate instead.
 */

export default function MembershipPlans() {
  const [rows, setRows]               = useState([]);
  const [loading, setLoading]         = useState(false);
  const [editing, setEditing]         = useState(null);   // null=closed, {}=create, {…}=edit
  const [submitting, setSubmitting]   = useState(false);
  const [form, setForm]               = useState(EMPTY_PLAN);
  const [initialForm, setInitialForm] = useState(EMPTY_PLAN);
  const [formErrors, setFormErrors]   = useState({});

  const load = async () => {
    setLoading(true);
    try {
      const { data } = await membershipAPI.getPlans({ include_inactive: 'true' });
      setRows(Array.isArray(data) ? data : []);
    } catch (err) {
      message.error(err?.response?.data?.error || 'Failed to load plans');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(); }, []);

  const num = (v) => {
    const n = parseFloat(v);
    return (isFinite(n) && n > 0) ? String(n) : '';
  };

  const hydrate = (p) => {
    const fresh = {
      plan_name: p?.plan_name || '',
      discount_percent: num(p?.discount_percent),
      points_per_100: num(p?.points_per_100),
      validity_months: (p?.validity_months != null && p.validity_months !== '') ? String(p.validity_months) : '',
      sort_order: (p?.sort_order != null && p.sort_order !== '') ? String(p.sort_order) : '',
      notes: p?.notes || '',
    };
    setForm(fresh);
    setInitialForm(fresh);
    setFormErrors({});
  };

  const openCreate = () => { setEditing({}); hydrate(null); };
  const openEdit   = (p) => { setEditing(p); hydrate(p); };
  const close      = () => { setEditing(null); hydrate(null); };

  const setField = (k) => (e) => {
    const v = e?.target ? e.target.value : e;
    setForm((p) => ({ ...p, [k]: v }));
    if (formErrors[k]) setFormErrors((er) => { const x = { ...er }; delete x[k]; return x; });
  };

  const formDirty = useMemo(() => {
    return Object.keys(initialForm).some((k) => (form[k] || '') !== (initialForm[k] || ''));
  }, [form, initialForm]);

  const submit = async () => {
    const next = {};
    if (!(form.plan_name || '').trim()) next.plan_name = 'Plan name is required';
    else if (form.plan_name.length > 80) next.plan_name = 'Max 80 characters';
    if (form.discount_percent !== '') {
      const n = parseFloat(form.discount_percent);
      if (!isFinite(n) || n < 0 || n > 100) next.discount_percent = 'Enter a value between 0 and 100';
    }
    if (form.points_per_100 !== '') {
      const n = parseFloat(form.points_per_100);
      if (!isFinite(n) || n < 0) next.points_per_100 = 'Enter 0 or more';
    }
    if (form.validity_months !== '') {
      const n = parseInt(form.validity_months, 10);
      if (!isFinite(n) || n <= 0) next.validity_months = 'Enter a whole number of months (or leave blank for no expiry)';
    }
    if (form.sort_order !== '') {
      const n = parseInt(form.sort_order, 10);
      if (!isFinite(n)) next.sort_order = 'Enter a whole number';
    }
    setFormErrors(next);
    if (Object.keys(next).length) {
      message.warning('Fix the highlighted fields and try again');
      return;
    }
    setSubmitting(true);
    try {
      const payload = {
        plan_name: form.plan_name.trim(),
        discount_percent: form.discount_percent === '' ? 0 : parseFloat(form.discount_percent),
        points_per_100: form.points_per_100 === '' ? 0 : parseFloat(form.points_per_100),
        validity_months: form.validity_months === '' ? null : parseInt(form.validity_months, 10),
        sort_order: form.sort_order === '' ? 0 : parseInt(form.sort_order, 10),
        notes: (form.notes || '').trim() || null,
      };
      if (editing && editing.plan_id) {
        await membershipAPI.updatePlan(editing.plan_id, payload);
        message.success('Plan updated');
      } else {
        await membershipAPI.createPlan(payload);
        message.success('Plan added');
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

  const toggleActive = async (p) => {
    try {
      await membershipAPI.updatePlan(p.plan_id, { is_active: !p.is_active });
      await load();
    } catch (err) {
      message.error(err?.response?.data?.error || 'Failed to toggle active');
    }
  };

  const sel = useListSelection({ totalCount: rows.length, rows });
  const single = sel.activeRow;

  const remove = async (p) => {
    try {
      await membershipAPI.deletePlan(p.plan_id);
      message.success(`Deleted ${p.plan_name}`);
      await load();
    } catch (err) {
      // Likely a 400 with the "has enrolled members" guard — relay verbatim.
      message.error(err?.response?.data?.error || 'Delete failed', 6);
    }
  };

  const fmtPct = (v) => {
    const n = parseFloat(v);
    return (isFinite(n) && n > 0)
      ? `${n}%`
      : <span style={{ color: 'var(--text-muted, #999)' }}>—</span>;
  };

  const columns = useMemo(() => [
    {
      title: 'Plan', dataIndex: 'plan_name',
      render: (v, row) => (
        <Space size={6}>
          <span style={{ fontWeight: 600 }}>{v}</span>
          {!row.is_active && <Tag color="default">inactive</Tag>}
        </Space>
      ),
    },
    {
      title: 'Discount', dataIndex: 'discount_percent', width: 120, align: 'right',
      render: fmtPct,
    },
    {
      title: 'Points / ₹100', dataIndex: 'points_per_100', width: 130, align: 'right',
      render: (v) => {
        const n = parseFloat(v);
        return (isFinite(n) && n > 0) ? n : <span style={{ color: 'var(--text-muted, #999)' }}>—</span>;
      },
    },
    {
      title: 'Validity', dataIndex: 'validity_months', width: 120, align: 'right',
      render: (v) => (v != null && v !== '' && Number(v) > 0)
        ? `${v} mo`
        : <span style={{ color: 'var(--text-muted, #999)' }}>No expiry</span>,
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
            title={`Delete ${row.plan_name}?`}
            description="Permanent. A plan with enrolled members can't be deleted — deactivate instead."
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
          <h1 className="ms-page-title">Membership Plans</h1>
          <p className="ms-page-sub">
            The loyalty tiers your customers can be enrolled into. Enrol a customer from their details popup (F8) on the Customers list.
          </p>
        </div>
        <Button type="primary" icon={<PlusOutlined />} onClick={openCreate}>Add Plan</Button>
      </header>

      <div className="ms-page-body">
        <div className="ms-page-body-inner">
          <Table
            rowKey="plan_id"
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
                if (e.shiftKey)                  sel.extendTo(index);
                else if (e.ctrlKey || e.metaKey) sel.toggleRow(index);
                else                             sel.setCursor(index);
              },
              onDoubleClick: () => record && openEdit(record),
            })}
          />
        </div>
      </div>

      <EntityFormModal
        open={!!editing}
        onClose={close}
        title={editing && editing.plan_id ? 'Edit Plan' : 'Add Plan'}
        subtitle={editing && editing.plan_id
          ? `${editing.plan_name} · update tier`
          : 'New loyalty tier'}
        entityIcon="M"
        entityTone="info"
        dirty={formDirty}
        saving={submitting}
        onSave={submit}
        onSaveAndClose={submit}
        onReset={handleReset}
        width={560}
      >
        <Section label="Tier">
          <Field label="Plan name" required error={formErrors.plan_name}>
            <input
              className={`efm-input${formErrors.plan_name ? ' has-error' : ''}`}
              value={form.plan_name}
              onChange={setField('plan_name')}
              maxLength={80}
              placeholder="e.g. Gold"
              autoFocus
            />
          </Field>

          <Field label="Display order" error={formErrors.sort_order}
            help="Lower shows first in lists (e.g. Silver 1, Gold 2, Platinum 3). Optional.">
            <input
              className={`efm-input${formErrors.sort_order ? ' has-error' : ''}`}
              value={form.sort_order}
              onChange={setField('sort_order')}
              inputMode="numeric"
              placeholder="0"
            />
          </Field>
        </Section>

        <Section label="Benefits">
          <Field label="Discount %" error={formErrors.discount_percent}
            help="Member discount at billing for this tier. Auto-applied through the normal bill discount when 'Auto-apply tier discount' is on — never changes past bills.">
            <input
              className={`efm-input${formErrors.discount_percent ? ' has-error' : ''}`}
              value={form.discount_percent}
              onChange={setField('discount_percent')}
              inputMode="decimal"
              placeholder="0"
            />
          </Field>

          <Field label="Points earned per ₹100 spent" error={formErrors.points_per_100}
            help="How many loyalty points a member on this tier earns for every ₹100 of purchase. E.g. 1 → a ₹500 bill earns 5 points. Requires 'Earn loyalty points' to be on.">
            <input
              className={`efm-input${formErrors.points_per_100 ? ' has-error' : ''}`}
              value={form.points_per_100}
              onChange={setField('points_per_100')}
              inputMode="decimal"
              placeholder="0"
            />
          </Field>

          <Field label="Validity (months)" error={formErrors.validity_months}
            help="How long a membership lasts from enrolment. Leave blank for no expiry.">
            <input
              className={`efm-input${formErrors.validity_months ? ' has-error' : ''}`}
              value={form.validity_months}
              onChange={setField('validity_months')}
              inputMode="numeric"
              placeholder="No expiry"
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
