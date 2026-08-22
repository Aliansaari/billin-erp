import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Table, Button, Tag, Space, Popconfirm, message,
  Modal, Form, Select, Input, DatePicker, Checkbox, Alert,
} from 'antd';
import { PlusOutlined, EditOutlined, DeleteOutlined, UsergroupAddOutlined } from '@ant-design/icons';
import { useSearchParams } from 'react-router-dom';
import dayjs from 'dayjs';
import { membershipAPI, partyAPI } from '../../api';
import { useSystemSettings } from '../../hooks/useSystemSettings';
import useListSelection from '../../hooks/useListSelection';
import ActionStrip from '../../components/keyboard/ActionStrip';
import '../settings/ModuleSettings.css';

/*
 * Members — loyalty enrolments.
 *
 * Lists every customer enrolled into a membership plan and carries the
 * enrol / edit / un-enrol actions. Enrolment picks a customer (server-side
 * search), a plan, and a card number (pre-filled from the shop's configured
 * source — the customer's mobile by default).
 *
 * LOYALTY METADATA ONLY: nothing here posts to a ledger, changes a bill
 * total, or moves money. `points_balance` is display-only and always 0 until
 * the points module lands in a later update.
 */

const STATUS_COLORS = { Active: 'green', Suspended: 'orange', Expired: 'default' };

const num = (v) => {
  const n = parseFloat(v);
  return isFinite(n) ? n : 0;
};

export default function MembershipList() {
  const settings = useSystemSettings();
  const noSource = settings?.membership_no_source || 'mobile';
  const [searchParams, setSearchParams] = useSearchParams();
  const bulkAutoRef = useRef(false);

  const [rows, setRows]         = useState([]);
  const [loading, setLoading]   = useState(false);
  const [plans, setPlans]       = useState([]);

  // Modal state. `editing`: null=closed, {}=enrol (create), {…}=edit.
  const [editing, setEditing]   = useState(null);
  const [submitting, setSubmitting] = useState(false);
  const [form] = Form.useForm();

  // Bulk-enrol existing customers.
  const [bulkOpen, setBulkOpen]     = useState(false);
  const [bulkPlan, setBulkPlan]     = useState(null);
  const [bulkSeed, setBulkSeed]     = useState(false);
  const [bulkBusy, setBulkBusy]     = useState(false);

  // Points history modal.
  const [pointsFor, setPointsFor]       = useState(null);   // membership row or null
  const [pointsRows, setPointsRows]     = useState([]);
  const [pointsLoading, setPointsLoading] = useState(false);

  // Customer search (enrol only).
  const [custOptions, setCustOptions] = useState([]);
  const [custSearching, setCustSearching] = useState(false);
  const custCacheRef = useRef({}); // party_id -> party (to read mobile on pick)
  const searchSeqRef = useRef(0);

  const loadPlans = async () => {
    try {
      const { data } = await membershipAPI.getPlans(); // active only
      setPlans(Array.isArray(data) ? data : []);
    } catch (err) {
      message.error(err?.response?.data?.error || 'Failed to load plans');
    }
  };

  const load = async () => {
    setLoading(true);
    try {
      const { data } = await membershipAPI.getMembers();
      setRows(Array.isArray(data) ? data : []);
    } catch (err) {
      message.error(err?.response?.data?.error || 'Failed to load members');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(); loadPlans(); }, []);

  const activePlanOptions = useMemo(
    () => plans.map((p) => ({ value: p.plan_id, label: p.plan_name })),
    [plans],
  );

  // Debounced server-side customer search for the enrol picker.
  const searchCustomers = useCallback((q) => {
    const term = (q || '').trim();
    const seq = ++searchSeqRef.current;
    if (!term) { setCustOptions([]); return; }
    setCustSearching(true);
    partyAPI.getCustomers({ search: term, limit: 20 })
      .then(({ data }) => {
        if (seq !== searchSeqRef.current) return; // stale response
        const list = (data && Array.isArray(data.data)) ? data.data : [];
        list.forEach((p) => { custCacheRef.current[p.party_id] = p; });
        setCustOptions(list.map((p) => ({
          value: p.party_id,
          label: `${p.party_name}${p.mobile_1 ? ` · ${p.mobile_1}` : ''}`,
        })));
      })
      .catch(() => { if (seq === searchSeqRef.current) setCustOptions([]); })
      .finally(() => { if (seq === searchSeqRef.current) setCustSearching(false); });
  }, []);

  const debouncedSearch = useMemo(() => {
    let t;
    return (q) => { clearTimeout(t); t = setTimeout(() => searchCustomers(q), 300); };
  }, [searchCustomers]);

  // Pre-fill the card number when a customer is picked during enrolment,
  // per the shop's configured source. Editable afterwards.
  const onPickCustomer = (partyId) => {
    const p = custCacheRef.current[partyId];
    if (!p) return;
    let no = '';
    if (noSource === 'mobile') no = p.mobile_1 ? String(p.mobile_1) : '';
    // 'auto' → leave blank; the server generates. 'manual' → leave blank.
    form.setFieldsValue({ membership_no: no });
  };

  const openEnroll = () => {
    setEditing({});
    setCustOptions([]);
    form.resetFields();
    form.setFieldsValue({ enrolled_date: dayjs(), status: 'Active' });
  };

  const openEdit = (m) => {
    setEditing(m);
    form.resetFields();
    form.setFieldsValue({
      party_id: m.party_id,
      plan_id: m.plan_id,
      membership_no: m.membership_no,
      status: m.status,
      enrolled_date: m.enrolled_date ? dayjs(m.enrolled_date) : null,
      expiry_date: m.expiry_date ? dayjs(m.expiry_date) : null,
      date_of_birth: m.date_of_birth ? dayjs(m.date_of_birth) : null,
      notes: m.notes || '',
    });
  };

  const close = () => { setEditing(null); form.resetFields(); };

  const submit = async () => {
    let values;
    try {
      values = await form.validateFields();
    } catch { return; }

    setSubmitting(true);
    try {
      if (editing && editing.membership_id) {
        // Edit — party is immutable; send the editable fields.
        const payload = {
          plan_id: values.plan_id,
          membership_no: (values.membership_no || '').trim(),
          status: values.status,
          enrolled_date: values.enrolled_date ? values.enrolled_date.format('YYYY-MM-DD') : undefined,
          expiry_date: values.expiry_date ? values.expiry_date.format('YYYY-MM-DD') : null,
          date_of_birth: values.date_of_birth ? values.date_of_birth.format('YYYY-MM-DD') : null,
          notes: (values.notes || '').trim() || null,
        };
        await membershipAPI.updateMember(editing.membership_id, payload);
        message.success('Membership updated');
      } else {
        // Enrol.
        const payload = {
          party_id: values.party_id,
          plan_id: values.plan_id,
          // Blank card number → let the server derive it from the source.
          membership_no: (values.membership_no || '').trim() || undefined,
          enrolled_date: values.enrolled_date ? values.enrolled_date.format('YYYY-MM-DD') : undefined,
          date_of_birth: values.date_of_birth ? values.date_of_birth.format('YYYY-MM-DD') : null,
          notes: (values.notes || '').trim() || null,
        };
        await membershipAPI.enroll(payload);
        message.success('Customer enrolled');
      }
      close();
      await load();
    } catch (err) {
      message.error(err?.response?.data?.error || 'Save failed', 6);
    } finally {
      setSubmitting(false);
    }
  };

  const openBulk = () => {
    setBulkPlan(plans.length ? plans[0].plan_id : null);
    setBulkSeed(false);
    setBulkOpen(true);
  };

  const bulkPlanObj = plans.find((p) => p.plan_id === bulkPlan) || null;
  const bulkHasPoints = Number(bulkPlanObj?.points_per_100) > 0;

  // Auto-open the bulk-enrol modal when navigated here from Settings (?bulk=1),
  // once plans are loaded. Clear the param so a refresh doesn't reopen it.
  useEffect(() => {
    if (bulkAutoRef.current) return;
    if (searchParams.get('bulk') === '1' && plans.length) {
      bulkAutoRef.current = true;
      openBulk();
      const next = new URLSearchParams(searchParams);
      next.delete('bulk');
      setSearchParams(next, { replace: true });
    }
  }, [searchParams, plans]);

  const runBulk = async () => {
    if (!bulkPlan) { message.warning('Pick a plan'); return; }
    setBulkBusy(true);
    try {
      const { data } = await membershipAPI.bulkEnroll({ plan_id: bulkPlan, seed_points: bulkSeed });
      const bits = [`Enrolled ${data.enrolled} customer(s) into ${data.plan}`];
      if (data.seededMembers > 0) bits.push(`seeded ${data.seededPoints.toLocaleString('en-IN')} pts across ${data.seededMembers} member(s)`);
      if (data.skipped > 0) bits.push(`${data.skipped} skipped`);
      message.success(bits.join(' · '), 8);
      setBulkOpen(false);
      await load();
    } catch (err) {
      message.error(err?.response?.data?.error || 'Bulk enrol failed', 6);
    } finally {
      setBulkBusy(false);
    }
  };

  const openPoints = async (m) => {
    setPointsFor(m);
    setPointsRows([]);
    setPointsLoading(true);
    try {
      const { data } = await membershipAPI.getPoints(m.membership_id);
      setPointsRows(Array.isArray(data) ? data : []);
    } catch (err) {
      message.error(err?.response?.data?.error || 'Failed to load points history');
    } finally {
      setPointsLoading(false);
    }
  };

  const sel = useListSelection({ totalCount: rows.length, rows });
  const single = sel.activeRow;

  const remove = async (m) => {
    try {
      await membershipAPI.deleteMember(m.membership_id);
      message.success('Membership removed');
      await load();
    } catch (err) {
      message.error(err?.response?.data?.error || 'Remove failed', 6);
    }
  };

  const columns = useMemo(() => [
    {
      title: 'Member', key: 'member',
      render: (_, row) => (
        <div>
          <div style={{ fontWeight: 600 }}>{row.party?.party_name || `#${row.party_id}`}</div>
          <div style={{ fontFamily: 'var(--font-mono, monospace)', fontSize: 12, color: 'var(--text-muted, #999)' }}>
            {row.membership_no}
          </div>
        </div>
      ),
    },
    {
      title: 'Plan', key: 'plan', width: 140,
      render: (_, row) => row.plan?.plan_name || '—',
    },
    {
      title: 'Status', dataIndex: 'status', width: 110,
      render: (v) => <Tag color={STATUS_COLORS[v] || 'default'}>{v}</Tag>,
    },
    {
      title: 'Enrolled', dataIndex: 'enrolled_date', width: 120,
      render: (v) => v ? dayjs(v).format('DD MMM YYYY') : '—',
    },
    {
      title: 'Expiry', dataIndex: 'expiry_date', width: 120,
      render: (v) => v
        ? dayjs(v).format('DD MMM YYYY')
        : <span style={{ color: 'var(--text-muted, #999)' }}>No expiry</span>,
    },
    {
      title: 'Points', dataIndex: 'points_balance', width: 110, align: 'right',
      render: (v, row) => (
        <Button type="link" size="small" style={{ padding: 0 }}
          onClick={(e) => { e.stopPropagation(); openPoints(row); }}>
          {num(v).toLocaleString('en-IN')}
        </Button>
      ),
    },
    {
      title: 'Actions', key: 'actions', width: 190, align: 'right',
      render: (_, row) => (
        <Space size={4}>
          <Button size="small" icon={<EditOutlined />} onClick={() => openEdit(row)}>Edit</Button>
          <Popconfirm
            title="Remove membership?"
            description="The customer stays; only their loyalty enrolment is removed."
            okText="Remove"
            okButtonProps={{ danger: true }}
            onConfirm={() => remove(row)}
          >
            <Button size="small" danger icon={<DeleteOutlined />}>Remove</Button>
          </Popconfirm>
        </Space>
      ),
    },
  ], []);

  const isEdit = !!(editing && editing.membership_id);

  return (
    <div className="ms-shell settings-pane-fill">
      <header className="ms-page-header" style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 16 }}>
        <div>
          <h1 className="ms-page-title">Members</h1>
          <p className="ms-page-sub">
            Customers enrolled in a loyalty plan. Manage the tiers under Settings → Membership Plans.
          </p>
        </div>
        <Space>
          <Button icon={<UsergroupAddOutlined />} onClick={openBulk}>Enrol existing</Button>
          <Button type="primary" icon={<PlusOutlined />} onClick={openEnroll}>Enrol Member</Button>
        </Space>
      </header>

      <div className="ms-page-body">
        <div className="ms-page-body-inner">
          <Table
            rowKey="membership_id"
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

      <Modal
        open={!!editing}
        title={isEdit ? 'Edit Membership' : 'Enrol Member'}
        onCancel={close}
        onOk={submit}
        okText={isEdit ? 'Save' : 'Enrol'}
        confirmLoading={submitting}
        destroyOnClose
        width={520}
      >
        <Form form={form} layout="vertical" preserve={false}>
          {isEdit ? (
            <Form.Item label="Customer">
              <Input value={editing?.party?.party_name || `#${editing?.party_id}`} disabled />
            </Form.Item>
          ) : (
            <Form.Item
              name="party_id"
              label="Customer"
              rules={[{ required: true, message: 'Pick a customer' }]}
            >
              <Select
                showSearch
                placeholder="Search customers by name or mobile"
                filterOption={false}
                onSearch={debouncedSearch}
                onChange={onPickCustomer}
                notFoundContent={custSearching ? 'Searching…' : 'Type to search'}
                options={custOptions}
              />
            </Form.Item>
          )}

          <Form.Item
            name="plan_id"
            label="Plan"
            rules={[{ required: true, message: 'Pick a plan' }]}
          >
            <Select
              placeholder={activePlanOptions.length ? 'Select a plan' : 'No active plans — add one in Settings → Membership Plans'}
              options={activePlanOptions}
            />
          </Form.Item>

          <Form.Item
            name="membership_no"
            label="Membership number"
            help={!isEdit && noSource === 'auto'
              ? 'Leave blank to auto-generate.'
              : 'Defaults to the mobile number; editable.'}
          >
            <Input maxLength={40} placeholder={noSource === 'auto' ? 'Auto-generated' : 'e.g. 9876543210'} />
          </Form.Item>

          <Space size={12} style={{ display: 'flex' }}>
            <Form.Item name="enrolled_date" label="Enrolled on" style={{ flex: 1 }}>
              <DatePicker format="DD MMM YYYY" style={{ width: '100%' }} />
            </Form.Item>
            {isEdit && (
              <Form.Item name="expiry_date" label="Expires on" style={{ flex: 1 }}>
                <DatePicker format="DD MMM YYYY" style={{ width: '100%' }} allowClear />
              </Form.Item>
            )}
          </Space>

          <Form.Item name="date_of_birth" label="Birth date (optional)"
            help="Used only for birthday reminders. Month and day are what matter.">
            <DatePicker format="DD MMM YYYY" style={{ width: '100%' }} allowClear />
          </Form.Item>

          {isEdit && (
            <Form.Item name="status" label="Status">
              <Select
                options={[
                  { value: 'Active', label: 'Active' },
                  { value: 'Suspended', label: 'Suspended' },
                  { value: 'Expired', label: 'Expired' },
                ]}
              />
            </Form.Item>
          )}

          <Form.Item name="notes" label="Notes">
            <Input.TextArea rows={2} maxLength={500} />
          </Form.Item>
        </Form>
      </Modal>

      <Modal
        open={bulkOpen}
        title="Enrol existing customers"
        onCancel={() => setBulkOpen(false)}
        onOk={runBulk}
        okText="Enrol customers"
        confirmLoading={bulkBusy}
        width={520}
        destroyOnClose
      >
        <Alert type="info" showIcon style={{ marginBottom: 14 }}
          message="This enrols every active customer who isn't already a member into the selected plan."
          description="Nothing here changes any bill, tax, or balance. You can edit or remove any membership afterwards, and re-running only picks up newly-added customers." />

        <div style={{ marginBottom: 12 }}>
          <div style={{ fontWeight: 600, marginBottom: 6 }}>Plan</div>
          <Select
            style={{ width: '100%' }}
            value={bulkPlan}
            onChange={setBulkPlan}
            options={activePlanOptions}
            placeholder={activePlanOptions.length ? 'Select a plan' : 'No active plans — add one in Settings → Membership Plans'}
          />
        </div>

        <Checkbox checked={bulkSeed} disabled={!bulkHasPoints}
          onChange={(e) => setBulkSeed(e.target.checked)}>
          Seed starting points from past purchases
        </Checkbox>
        <div style={{ fontSize: 12, color: 'var(--fg-tertiary, #999)', marginTop: 4, marginLeft: 24 }}>
          {bulkHasPoints
            ? `Each customer gets points for their past purchase value at ${bulkPlanObj.points_per_100} pts / ₹100 (whole points).`
            : 'This plan has no points rate — set “Points per ₹100” on the plan to seed points.'}
        </div>
      </Modal>

      <Modal
        open={!!pointsFor}
        title={pointsFor ? `Points — ${pointsFor.party?.party_name || pointsFor.membership_no}` : 'Points'}
        onCancel={() => setPointsFor(null)}
        footer={null}
        width={560}
        destroyOnClose
      >
        <div style={{ marginBottom: 10, fontWeight: 600 }}>
          Balance: {num(pointsFor?.points_balance).toLocaleString('en-IN')} pts
        </div>
        <Table
          rowKey="entry_id"
          loading={pointsLoading}
          dataSource={pointsRows}
          pagination={false}
          size="small"
          scroll={{ y: 320 }}
          locale={{ emptyText: 'No points activity yet' }}
          columns={[
            { title: 'Date', dataIndex: 'created_at', width: 150,
              render: (v) => v ? dayjs(v).format('DD MMM YYYY HH:mm') : '—' },
            { title: 'Type', dataIndex: 'type', width: 90,
              render: (v) => <Tag>{v}</Tag> },
            { title: 'Points', dataIndex: 'points', width: 90, align: 'right',
              render: (v) => {
                const n = Number(v) || 0;
                return <span style={{ color: n < 0 ? 'var(--danger, #c00)' : 'var(--success, #1a7f37)', fontWeight: 600 }}>
                  {n > 0 ? `+${n}` : n}
                </span>;
              } },
            { title: 'Note', dataIndex: 'note', ellipsis: true },
          ]}
        />
      </Modal>

      <ActionStrip
        actions={[
          { id: 'edit', key: 'F2', label: 'Edit', disabled: !single, onAction: () => single && openEdit(single) },
          { id: 'new', key: 'F3', label: 'Enrol', onAction: openEnroll },
          { id: 'refresh', key: 'F5', label: 'Refresh', onAction: load },
          { id: 'open', key: 'F1', label: 'Edit', tone: 'primary', disabled: !single, onAction: () => single && openEdit(single) },
        ]}
      />
    </div>
  );
}
