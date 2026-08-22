import React, { useEffect, useMemo, useState } from 'react';
import { Select, Button, Tag, Popconfirm, message } from 'antd';
import dayjs from 'dayjs';
import { membershipAPI } from '../../api';
import { useSystemSettings } from '../../hooks/useSystemSettings';
import useAuthStore from '../../store/authStore';
import { hasPermission } from '../../utils/perms';

/*
 * MembershipCard — a self-contained loyalty widget for one customer.
 *
 * Drop it into any customer view; it fetches its own membership + the active
 * plan list keyed by the party, and carries the enrol / change-plan /
 * suspend / remove actions inline. Renders NOTHING when the membership module
 * is off, when there's no party, or for a supplier-only party — so hosts (the
 * customer detail modal) can embed it unconditionally and stay presentational.
 *
 * LOYALTY METADATA ONLY: every action calls /api/membership, which never
 * touches a bill total, tax, ledger, or balance. `points_balance` is display
 * only (0 until the points module lands in a later update).
 *
 * Permission-aware: read access shows the status; the enrol / change / remove
 * controls appear only for users with parties.edit (mirrors the API gate), so
 * a view-only user sees the membership but no dead buttons.
 */
export default function MembershipCard({ party }) {
  const settings = useSystemSettings();
  const enabled  = !!settings?.membership_enabled;
  const noSource = settings?.membership_no_source || 'mobile';
  const user     = useAuthStore((s) => s.user);
  const canManage = hasPermission(user, 'parties.edit');

  const partyId   = party?.party_id;
  const isSupplier = party?.party_type === 'Supplier';

  const [loading, setLoading]       = useState(false);
  const [membership, setMembership] = useState(null);
  const [plans, setPlans]           = useState([]);
  const [pickPlan, setPickPlan]     = useState(null); // selected plan for the enrol control
  const [busy, setBusy]             = useState(false);

  const active = enabled && !!partyId && !isSupplier;

  useEffect(() => {
    if (!active) { setMembership(null); return; }
    let alive = true;
    setLoading(true);
    Promise.all([
      membershipAPI.getByParty(partyId),
      membershipAPI.getPlans(), // active plans only
    ])
      .then(([mRes, pRes]) => {
        if (!alive) return;
        setMembership(mRes?.data?.membership || null);
        const list = Array.isArray(pRes?.data) ? pRes.data : [];
        setPlans(list);
        setPickPlan(list.length ? list[0].plan_id : null);
      })
      .catch(() => { if (alive) { setMembership(null); setPlans([]); } })
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [active, partyId]);

  const planOptions = useMemo(
    () => plans.map((p) => ({ value: p.plan_id, label: p.plan_name })),
    [plans],
  );

  if (!active) return null;

  const enrol = async () => {
    if (!pickPlan) { message.warning('Add an active plan first (Settings → Membership Plans)'); return; }
    setBusy(true);
    try {
      // membership_no omitted → the server derives it from the shop's
      // configured source (mobile by default). Keeps the counter flow one-click.
      const { data } = await membershipAPI.enroll({ party_id: partyId, plan_id: pickPlan });
      setMembership(data);
      message.success('Customer enrolled');
    } catch (err) {
      message.error(err?.response?.data?.error || 'Enrol failed', 6);
    } finally {
      setBusy(false);
    }
  };

  const changePlan = async (planId) => {
    setBusy(true);
    try {
      const { data } = await membershipAPI.updateMember(membership.membership_id, { plan_id: planId });
      setMembership(data);
      message.success('Plan changed');
    } catch (err) {
      message.error(err?.response?.data?.error || 'Change failed', 6);
    } finally {
      setBusy(false);
    }
  };

  const toggleStatus = async () => {
    const next = membership.status === 'Active' ? 'Suspended' : 'Active';
    setBusy(true);
    try {
      const { data } = await membershipAPI.updateMember(membership.membership_id, { status: next });
      setMembership(data);
      message.success(next === 'Active' ? 'Membership activated' : 'Membership suspended');
    } catch (err) {
      message.error(err?.response?.data?.error || 'Update failed', 6);
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    setBusy(true);
    try {
      await membershipAPI.deleteMember(membership.membership_id);
      setMembership(null);
      message.success('Membership removed');
    } catch (err) {
      message.error(err?.response?.data?.error || 'Remove failed', 6);
    } finally {
      setBusy(false);
    }
  };

  const STATUS_COLORS = { Active: 'green', Suspended: 'orange', Expired: 'default' };
  const suggestedNo = noSource === 'mobile' && party?.mobile_1 ? String(party.mobile_1) : null;

  return (
    <div className="cdm-sec">
      <div className="cdm-sec-h">Membership</div>

      {loading ? (
        <div className="mc-muted">Loading…</div>
      ) : membership ? (
        <div className="mc-wrap">
          <div className="mc-row">
            <span className="mc-plan">{membership.plan?.plan_name || '—'}</span>
            <Tag color={STATUS_COLORS[membership.status] || 'default'}>{membership.status}</Tag>
          </div>
          <div className="mc-grid">
            <div className="mc-cell"><div className="k">Card no.</div><div className="v mono">{membership.membership_no}</div></div>
            <div className="mc-cell"><div className="k">Points</div><div className="v">{Number(membership.points_balance || 0).toLocaleString('en-IN')}</div></div>
            <div className="mc-cell">
              <div className="k">Expiry</div>
              <div className="v">{membership.expiry_date ? dayjs(membership.expiry_date).format('DD MMM YYYY') : 'No expiry'}</div>
            </div>
            <div className="mc-cell">
              <div className="k">Enrolled</div>
              <div className="v">{membership.enrolled_date ? dayjs(membership.enrolled_date).format('DD MMM YYYY') : '—'}</div>
            </div>
          </div>

          {canManage && (
            <div className="mc-actions">
              <Select
                size="small"
                value={membership.plan_id}
                options={planOptions}
                onChange={changePlan}
                disabled={busy}
                style={{ minWidth: 130 }}
              />
              <Button size="small" onClick={toggleStatus} disabled={busy}>
                {membership.status === 'Active' ? 'Suspend' : 'Activate'}
              </Button>
              <Popconfirm
                title="Remove membership?"
                description="The customer stays; only their loyalty enrolment is removed."
                okText="Remove" okButtonProps={{ danger: true }}
                onConfirm={remove}
              >
                <Button size="small" danger disabled={busy}>Remove</Button>
              </Popconfirm>
            </div>
          )}
        </div>
      ) : (
        <div className="mc-wrap">
          <div className="mc-muted">Not a member.</div>
          {canManage && (
            plans.length ? (
              <div className="mc-actions">
                <Select
                  size="small"
                  value={pickPlan}
                  options={planOptions}
                  onChange={setPickPlan}
                  disabled={busy}
                  style={{ minWidth: 130 }}
                  placeholder="Plan"
                />
                <Button size="small" type="primary" onClick={enrol} loading={busy}>Enrol</Button>
                {suggestedNo && <span className="mc-hint">Card no. → {suggestedNo}</span>}
              </div>
            ) : (
              <div className="mc-hint">No active plans yet — add one in Settings → Membership Plans.</div>
            )
          )}
        </div>
      )}
    </div>
  );
}
