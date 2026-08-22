import React, { useEffect, useMemo, useState } from 'react';
import { Card, Table, Button, Tag, Row, Col, Statistic, message } from 'antd';
import { WhatsAppOutlined, ReloadOutlined } from '@ant-design/icons';
import dayjs from 'dayjs';
import { membershipAPI } from '../../api';
import { useSystemSettings } from '../../hooks/useSystemSettings';
import ActionStrip from '../../components/keyboard/ActionStrip';
import '../settings/ModuleSettings.css';

/*
 * Membership report — KPIs + actionable lists.
 *
 * Reminders are ALWAYS operator-initiated: each row's WhatsApp button opens a
 * pre-filled wa.me chat (the same safe pattern the payment-reminder button
 * uses). Nothing is ever auto-sent, so a shop can never accidentally spam its
 * customers or risk its number. The expiry/birthday SECTIONS are gated by
 * their Settings toggles so each shop shows only what it uses.
 */

const fmtDate = (v) => (v ? dayjs(v).format('DD MMM YYYY') : '—');
const inr = (v) => `₹${Number(v || 0).toLocaleString('en-IN', { maximumFractionDigits: 2 })}`;

// Pre-filled wa.me deep link — works whether or not the WhatsApp integration
// is connected; the operator sends from their own WhatsApp.
const waUrl = (mobile, text) => `https://wa.me/91${mobile}?text=${encodeURIComponent(text)}`;

export default function MembershipReport() {
  const settings = useSystemSettings();
  const shop = settings?.company_name || '';
  const remindExpiry   = !!settings?.membership_remind_expiry;
  const remindBirthday = !!settings?.membership_remind_birthday;

  const [data, setData]       = useState(null);
  const [loading, setLoading] = useState(false);

  const load = async () => {
    setLoading(true);
    try {
      const res = await membershipAPI.getReport();
      setData(res.data || null);
    } catch (err) {
      message.error(err?.response?.data?.error || 'Failed to load membership report');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(); }, []);

  const expiryMsg = (name, plan, date) => [
    `Namaste ${name} 🙏`, '',
    `Your ${plan || 'membership'} is expiring on ${fmtDate(date)}.`,
    `Please renew to keep enjoying your member benefits${shop ? ` at ${shop}` : ''}.`,
  ].join('\n');

  const birthdayMsg = (name) => [
    `Happy Birthday ${name}! 🎉🎂`, '',
    `Wishing you a wonderful day${shop ? ` from all of us at ${shop}` : ''}.`,
  ].join('\n');

  const sendWa = (mobile, text) => {
    if (!mobile) { message.warning('No mobile number on file for this member'); return; }
    window.open(waUrl(mobile, text), '_blank', 'noopener,noreferrer');
  };

  const expiringCols = useMemo(() => [
    { title: 'Member', key: 'member',
      render: (_, r) => (
        <div>
          <div style={{ fontWeight: 600 }}>{r.party?.party_name || `#${r.party_id}`}</div>
          <div style={{ fontSize: 12, color: 'var(--fg-tertiary, #999)' }}>{r.party?.mobile_1 || '—'}</div>
        </div>
      ) },
    { title: 'Plan', width: 130, render: (_, r) => r.plan?.plan_name || '—' },
    { title: 'Expiry', dataIndex: 'expiry_date', width: 130, render: fmtDate },
    { title: 'In', key: 'days', width: 90,
      render: (_, r) => {
        const d = r.expiry_date ? dayjs(r.expiry_date).startOf('day').diff(dayjs().startOf('day'), 'day') : null;
        if (d == null) return '—';
        const color = d <= 0 ? 'red' : d <= 3 ? 'orange' : 'default';
        return <Tag color={color}>{d <= 0 ? 'due' : `${d}d`}</Tag>;
      } },
    { title: '', key: 'act', width: 130, align: 'right',
      render: (_, r) => (
        <Button size="small" icon={<WhatsAppOutlined />}
          disabled={!r.party?.mobile_1}
          onClick={() => sendWa(r.party?.mobile_1, expiryMsg(r.party?.party_name, r.plan?.plan_name, r.expiry_date))}>
          Remind
        </Button>
      ) },
  ], [shop]);

  const birthdayCols = useMemo(() => [
    { title: 'Member', key: 'member',
      render: (_, r) => (
        <div>
          <div style={{ fontWeight: 600 }}>{r.party_name || `#${r.party_id}`}</div>
          <div style={{ fontSize: 12, color: 'var(--fg-tertiary, #999)' }}>{r.mobile_1 || '—'}</div>
        </div>
      ) },
    { title: 'Plan', width: 130, render: (_, r) => r.plan_name || '—' },
    { title: 'Birth date', dataIndex: 'date_of_birth', width: 130, render: fmtDate },
    { title: '', key: 'act', width: 130, align: 'right',
      render: (_, r) => (
        <Button size="small" icon={<WhatsAppOutlined />}
          disabled={!r.mobile_1}
          onClick={() => sendWa(r.mobile_1, birthdayMsg(r.party_name))}>
          Wish
        </Button>
      ) },
  ], [shop]);

  const planCols = [
    { title: 'Plan', dataIndex: 'plan_name', render: (v) => <span style={{ fontWeight: 600 }}>{v}</span> },
    { title: 'Discount', dataIndex: 'discount_percent', width: 110, align: 'right',
      render: (v) => (Number(v) > 0 ? `${Number(v)}%` : '—') },
    { title: 'Pts / ₹100', dataIndex: 'points_per_100', width: 110, align: 'right',
      render: (v) => (Number(v) > 0 ? Number(v) : '—') },
    { title: 'Active members', dataIndex: 'members', width: 140, align: 'right' },
  ];

  const sc = data?.statusCounts || {};

  return (
    <div className="ms-shell settings-pane-fill">
      <header className="ms-page-header" style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 16 }}>
        <div>
          <h1 className="ms-page-title">Membership Report</h1>
          <p className="ms-page-sub">
            Members at a glance, loyalty-points liability, and who to reach out to. Reminders open a pre-filled WhatsApp chat — you send them.
          </p>
        </div>
        <Button icon={<ReloadOutlined />} onClick={load}>Refresh</Button>
      </header>

      <div className="ms-page-body">
        <div className="ms-page-body-inner">
          <Row gutter={[16, 16]}>
            <Col xs={12} md={6}><Card size="small"><Statistic title="Active members" value={sc.Active || 0} loading={loading} /></Card></Col>
            <Col xs={12} md={6}><Card size="small"><Statistic title="Points outstanding" value={data?.totalPoints || 0} loading={loading} /></Card></Col>
            <Col xs={12} md={6}><Card size="small"><Statistic title="Points liability" value={inr(data?.pointsValue)} loading={loading} /></Card></Col>
            <Col xs={12} md={6}><Card size="small"><Statistic title="Suspended / Expired" value={`${sc.Suspended || 0} / ${sc.Expired || 0}`} loading={loading} /></Card></Col>
          </Row>

          <Card size="small" title="Plans" style={{ marginTop: 16 }}>
            <Table rowKey="plan_id" size="small" pagination={false} loading={loading}
              dataSource={data?.planBreakdown || []} columns={planCols}
              locale={{ emptyText: 'No plans yet' }} />
          </Card>

          {remindExpiry && (
            <Card size="small" title={`Expiring within ${data?.days ?? 7} days`} style={{ marginTop: 16 }}>
              <Table rowKey="membership_id" size="small" pagination={false} loading={loading}
                dataSource={data?.expiring || []} columns={expiringCols}
                locale={{ emptyText: 'No memberships expiring in this window' }} />
            </Card>
          )}

          {remindBirthday && (
            <Card size="small" title="Birthdays today" style={{ marginTop: 16 }}>
              <Table rowKey="membership_id" size="small" pagination={false} loading={loading}
                dataSource={data?.birthdays || []} columns={birthdayCols}
                locale={{ emptyText: 'No member birthdays today' }} />
            </Card>
          )}

          {!remindExpiry && !remindBirthday && (
            <p className="ms-row-desc" style={{ marginTop: 16 }}>
              Turn on “Expiry reminders” or “Birthday reminders” under Settings → Features → Membership to see outreach lists here.
            </p>
          )}
        </div>
      </div>

      <ActionStrip
        actions={[
          { id: 'refresh', key: 'F5', label: 'Refresh', onAction: load },
        ]}
      />
    </div>
  );
}
