import React, { useEffect, useState, useMemo } from 'react';
import { Switch, Button, Input, Tag, Alert, Skeleton, message, Tooltip, Select, Tabs, Badge, TimePicker } from 'antd';
import {
  RobotOutlined, ReloadOutlined, PlusOutlined, SafetyOutlined, CheckCircleFilled,
  DeleteOutlined, InfoCircleOutlined, CrownOutlined, TeamOutlined, ShopOutlined,
  EyeOutlined, AppstoreOutlined, FundOutlined, WhatsAppOutlined, BellOutlined,
} from '@ant-design/icons';
import dayjs from 'dayjs';
import { whatsappAPI, partyAPI } from '../../api';
import './WhatsappBotSettings.css';

/*
 * Settings → WhatsApp Bot.  A WhatsApp command-centre for the shop:
 *   • OWNERS get private business reports + lookups (each switch below).
 *   • CUSTOMERS get self-service account info + their bill/receipt PDFs.
 *   • SUPPLIERS get what we owe them + their purchase/payment history.
 * Everything on this page is enforced server-side and driven by the same
 * whatsapp_settings row, so it just reads/writes /api/whatsapp/settings.
 */

// Owner panel capabilities (stored in the bot_owner_panel JSON map). Grouped
// for the UI; a missing key means ON (so nothing is hidden by surprise).
const OWNER_GROUPS = [
  { title: 'Sales & money', icon: <FundOutlined />, items: [
    { key: 'today', label: "Today's business", desc: 'Sales, collection, credit, average bill.' },
    { key: 'yesterday', label: "Yesterday", desc: "Yesterday's sales & collection." },
    { key: 'week', label: 'Last 7 days', desc: 'Rolling weekly sales & collection.' },
    { key: 'month', label: 'This month', desc: 'Month-to-date sales & collection.' },
  ] },
  { title: 'Dues', icon: <TeamOutlined />, items: [
    { key: 'receivables', label: 'Receivables', desc: 'Total to collect + top customers with dues.' },
    { key: 'payables', label: 'Payables', desc: 'Total we owe + top suppliers.' },
  ] },
  { title: 'Stock & products', icon: <AppstoreOutlined />, items: [
    { key: 'low_stock', label: 'Low / out of stock', desc: 'Items at or below reorder level.' },
    { key: 'top_products', label: 'Top-selling products', desc: 'Best sellers this month (qty + value).' },
    { key: 'top_customers', label: 'Top customers', desc: 'Highest-value customers this month.' },
  ] },
  { title: 'Cash & alerts', icon: <FundOutlined />, items: [
    { key: 'cash_bank', label: 'Cash & bank balances', desc: 'Live balance of every cash/bank account.' },
    { key: 'expenses', label: 'Expenses', desc: "Today's + this month's expense totals." },
    { key: 'cheques', label: 'Cheque alerts', desc: 'To deposit · awaiting clearance · bounced.' },
  ] },
  { title: 'Look-ups', icon: <EyeOutlined />, items: [
    { key: 'customer_lookup', label: 'Customer look-up', desc: 'Type a name → balance, history, statement PDF.' },
    { key: 'supplier_lookup', label: 'Supplier look-up', desc: 'Send “sup <name>” → payable & purchase history.' },
  ] },
];
const STOCK_FIGURES = [
  { key: 'bot_owner_show_sale_rate', label: 'Sale rate' },
  { key: 'bot_owner_show_purchase_rate', label: 'Purchase / cost' },
  { key: 'bot_owner_show_stock', label: 'Stock on hand' },
  { key: 'bot_owner_show_mrp', label: 'MRP' },
];
const CUSTOMER_FEATURES = [
  { key: 'bot_show_balance', label: 'Account balance', desc: 'Their current outstanding / advance.' },
  { key: 'bot_show_bills', label: 'Recent bills', desc: 'Last 5 invoices with due amounts.' },
  { key: 'bot_show_payments', label: 'Payments received', desc: 'Their last 5 payments.' },
  { key: 'bot_show_statement', label: 'Statement (PDF)', desc: 'Full account statement as a PDF.' },
  { key: 'bot_doc_request', label: 'Bill / receipt PDF on request', desc: 'Reply with a bill/receipt number → that PDF.' },
];
const SUPPLIER_FEATURES = [
  { key: 'balance', label: 'Balance', desc: 'What we owe them (or their advance).' },
  { key: 'bills', label: 'Purchase bills', desc: 'Their last 5 bills to us.' },
  { key: 'payments', label: 'Payments made', desc: 'Payments we made to them.' },
  { key: 'statement', label: 'Statement (PDF)', desc: 'Full account statement as a PDF.' },
];

const last10 = (s) => String(s || '').replace(/\D/g, '').slice(-10);
const parse = (v, d) => { try { const o = JSON.parse(v ?? ''); return o && typeof o === 'object' ? o : d; } catch { return d; } };

export default function WhatsappBotSettings() {
  const [cfg, setCfg] = useState(null);
  const [status, setStatus] = useState({});
  const [customers, setCustomers] = useState([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [ownerNo, setOwnerNo] = useState('');

  const load = async () => {
    try {
      const [sRes, stRes] = await Promise.all([whatsappAPI.getSettings(), whatsappAPI.status()]);
      const s = sRes.data || {};
      setCfg({
        ...s,
        _blocked: parse(s.bot_blocked, []), _owners: parse(s.bot_owner_numbers, []),
        _ownerPanel: parse(s.bot_owner_panel, {}), _supPanel: parse(s.bot_supplier_panel, {}),
      });
      setStatus(stRes.data || {});
    } catch (e) { message.error('Could not load bot settings — ' + (e.response?.data?.error || e.message)); }
    finally { setLoading(false); }
  };
  const loadCustomers = async () => {
    try { const r = await partyAPI.getCustomers({ limit: 5000 }); setCustomers((r.data?.data || r.data || []).filter((p) => p.is_active !== false && p.mobile_1)); }
    catch { /* search just won't have options */ }
  };
  useEffect(() => { load(); loadCustomers(); }, []);

  const labelForNumber = (num) => { const n = last10(num); const c = customers.find((p) => last10(p.mobile_1) === n || last10(p.mobile_2) === n); return c ? `${c.party_name} (+${num})` : `+${num}`; };

  const patch = async (partial, okMsg) => {
    setSaving(true); const prev = cfg; setCfg((c) => ({ ...c, ...partial }));
    try { await whatsappAPI.saveSettings(partial); if (okMsg) message.success(okMsg); }
    catch (e) { setCfg(prev); message.error('Could not save — ' + (e.response?.data?.error || e.message)); }
    finally { setSaving(false); }
  };
  // Toggle a key inside one of the JSON maps and persist the whole map.
  const toggleOwnerPanel = (key, val) => { const next = { ...(cfg._ownerPanel || {}), [key]: val }; setCfg((c) => ({ ...c, _ownerPanel: next })); patch({ bot_owner_panel: next }); };
  const toggleSupPanel = (key, val) => { const next = { ...(cfg._supPanel || {}), [key]: val }; setCfg((c) => ({ ...c, _supPanel: next })); patch({ bot_supplier_panel: next }); };
  const ownerOn = (k) => (cfg?._ownerPanel?.[k]) !== false;
  const supOn = (k) => (cfg?._supPanel?.[k]) !== false;

  const addOwner = async () => {
    const n = String(ownerNo).replace(/\D/g, ''); if (n.length < 10) { message.warning('Enter a valid mobile number'); return; }
    setOwnerNo(''); if ((cfg._owners || []).some((x) => last10(x) === last10(n))) return;
    const list = [...(cfg._owners || []), n]; setCfg((c) => ({ ...c, _owners: list })); await patch({ bot_owner_numbers: list }, 'Owner number added');
  };
  const removeOwner = async (num) => { const list = (cfg._owners || []).filter((n) => n !== num); setCfg((c) => ({ ...c, _owners: list })); await patch({ bot_owner_numbers: list }, 'Owner number removed'); };
  const addBlockedNum = async (num) => { const n = String(num).replace(/\D/g, ''); if (n.length < 10) return; if ((cfg._blocked || []).some((x) => last10(x) === last10(n))) return; const list = [...(cfg._blocked || []), n]; setCfg((c) => ({ ...c, _blocked: list })); await patch({ bot_blocked: list }, 'Customer blocked'); };
  const removeBlocked = async (num) => { const list = (cfg._blocked || []).filter((n) => n !== num); setCfg((c) => ({ ...c, _blocked: list })); await patch({ bot_blocked: list }, 'Customer un-blocked'); };

  // ── Live owner-menu preview, built from the enabled switches ──
  const ownerPreview = useMemo(() => {
    if (!cfg) return '';
    const L = ['👋 *Your Shop* — Owner Panel'];
    const seg = (title, items) => { const v = items.filter(([, k]) => ownerOn(k)); if (!v.length) return; L.push('', title); v.forEach(([n, , lbl]) => L.push(`${n}  ${lbl}`)); };
    seg('📊 SALES & MONEY', [['1', 'today', 'Today'], ['2', 'yesterday', 'Yesterday'], ['3', 'week', 'Last 7 days'], ['4', 'month', 'This month']]);
    seg('📒 DUES', [['5', 'receivables', 'Receivables'], ['6', 'payables', 'Payables']]);
    seg('📦 STOCK', [['7', 'low_stock', 'Low / out of stock'], ['8', 'top_products', 'Top products'], ['9', 'top_customers', 'Top customers']]);
    seg('💰 CASH', [['10', 'cash_bank', 'Cash & bank'], ['11', 'expenses', 'Expenses'], ['12', 'cheques', 'Cheque alerts']]);
    const look = [];
    if (ownerOn('customer_lookup')) look.push('• Customer: type a name · pdf <name>');
    if (ownerOn('supplier_lookup')) look.push('• Supplier: sup <name>');
    if (cfg.bot_stock_lookup !== false) look.push('• Stock: A <article> · B <barcode> · S <name>');
    if (look.length) { L.push('', '🔎 LOOK UP'); look.forEach((x) => L.push(x)); }
    L.push('', 'Reply 0 for this menu.');
    return L.join('\n');
  }, [cfg]);

  const custPreview = useMemo(() => {
    if (!cfg) return '';
    const L = ['👋 *Hello Ravi!*', 'This is *Your Shop* — self-service.', '', 'Reply with a number:'];
    if (cfg.bot_show_balance !== false) L.push('1  💰  Account balance');
    if (cfg.bot_show_bills !== false) L.push('2  🧾  Recent bills');
    if (cfg.bot_show_payments !== false) L.push('3  💵  Payments received');
    if (cfg.bot_show_statement !== false) L.push('4  📄  Statement (PDF)');
    if (cfg.bot_doc_request !== false) L.push('', '📎 Send a bill/receipt no. (e.g. 14388) for its PDF.');
    L.push('', 'Reply 0 anytime for this menu.');
    return L.join('\n');
  }, [cfg]);

  if (loading && !cfg) return <div className="wab-page"><div className="wab-card"><Skeleton active paragraph={{ rows: 5 }} /></div></div>;

  const connected = status.provider === 'web' && status.state === 'connected';
  const enabled = !!cfg.bot_enabled;
  const ownerCount = (cfg._owners || []).length;
  const ownerEnabledCount = OWNER_GROUPS.reduce((a, g) => a + g.items.filter((it) => ownerOn(it.key)).length, 0);

  // Reusable toggle row
  const Row = ({ label, desc, checked, onChange, disabled }) => (
    <div className={`wab-feat ${disabled ? 'is-disabled' : ''}`}>
      <div className="wab-feat-text"><div className="wab-feat-label">{label}</div>{desc && <div className="wab-feat-desc">{desc}</div>}</div>
      <Switch checked={checked} disabled={disabled} onChange={onChange} />
    </div>
  );

  // ── Tab: Owner Panel ──
  const OwnerTab = (
    <>
      <div className="wab-card">
        <div className="wab-kicker"><CrownOutlined /> Owner numbers</div>
        <p className="wab-note-line">These numbers get the private <b>Owner Panel</b> instead of the customer menu. Add yourself &amp; trusted staff.</p>
        <div className="wab-block-add">
          <Input placeholder="Owner mobile number" value={ownerNo} onChange={(e) => setOwnerNo(e.target.value)} onPressEnter={addOwner} style={{ maxWidth: 260 }} allowClear />
          <Button type="primary" icon={<PlusOutlined />} onClick={addOwner}>Add owner</Button>
        </div>
        {ownerCount === 0 ? <div className="wab-block-empty">No owner numbers yet — add one to unlock the owner panel.</div> : (
          <div className="wab-block-list">{(cfg._owners || []).map((num) => (
            <span className="wab-block-chip wab-owner-chip" key={num}><CrownOutlined /><span>{labelForNumber(num)}</span>
              <Tooltip title="Remove owner"><DeleteOutlined onClick={() => removeOwner(num)} /></Tooltip></span>))}
          </div>
        )}
      </div>

      <div className="wab-card">
        <div className="wab-kicker">Owner capabilities <Badge count={ownerEnabledCount} style={{ backgroundColor: 'var(--accent,#B1472F)' }} /></div>
        <p className="wab-note-line">Pick exactly what an owner can pull up over WhatsApp. Each becomes a numbered option in their menu.</p>
        {OWNER_GROUPS.map((g) => (
          <div className="wab-group" key={g.title}>
            <div className="wab-group-head">{g.icon}<span>{g.title}</span></div>
            <div className="wab-feat-list">{g.items.map((it) => (
              <Row key={it.key} label={it.label} desc={it.desc} checked={ownerOn(it.key)} onChange={(v) => toggleOwnerPanel(it.key, v)} />
            ))}</div>
          </div>
        ))}
      </div>

      <div className="wab-card">
        <div className="wab-feat" style={{ paddingTop: 0 }}>
          <div className="wab-feat-text"><div className="wab-feat-label"><AppstoreOutlined /> Stock look-up (A / B / S)</div>
            <div className="wab-feat-desc">Owners message <b>A &lt;article&gt;</b>, <b>B &lt;barcode&gt;</b> or <b>S &lt;name&gt;</b> for a stock card.</div></div>
          <Switch checked={cfg.bot_stock_lookup !== false} onChange={(v) => patch({ bot_stock_lookup: v })} />
        </div>
        {cfg.bot_stock_lookup !== false && (
          <><p className="wab-note-line" style={{ margin: '10px 0 2px' }}>Figures shown in a stock card:</p>
            <div className="wab-chip-toggles">{STOCK_FIGURES.map((f) => (
              <button key={f.key} type="button" className={`wab-chip-toggle ${cfg[f.key] !== false ? 'is-on' : ''}`} onClick={() => patch({ [f.key]: cfg[f.key] === false })}>
                {cfg[f.key] !== false ? <CheckCircleFilled /> : <span className="wab-dot" />}{f.label}</button>))}
            </div></>
        )}
      </div>

      <div className="wab-card">
        <div className="wab-feat" style={{ paddingTop: 0 }}>
          <div className="wab-feat-text">
            <div className="wab-feat-label"><BellOutlined /> Daily digest</div>
            <div className="wab-feat-desc">Auto-send owners a short end-of-day summary: sales, collection, receivables, cash &amp; bank, and cheques to deposit.</div>
          </div>
          <Switch checked={!!cfg.bot_daily_digest} onChange={(v) => patch({ bot_daily_digest: v }, v ? 'Daily digest on' : 'Daily digest off')} />
        </div>
        {cfg.bot_daily_digest && (
          <div className="wab-digest-time">
            <span>Send around</span>
            <TimePicker format="HH:mm" minuteStep={5} allowClear={false} inputReadOnly style={{ width: 120 }}
              value={dayjs(cfg.bot_digest_time || '21:00', 'HH:mm')}
              onChange={(v) => patch({ bot_digest_time: v ? v.format('HH:mm') : '21:00' })} />
            <span className="wab-optional">once a day, to all owner numbers</span>
          </div>
        )}
      </div>
    </>
  );

  // ── Tab: Customers ──
  const CustomerTab = (
    <>
      <div className="wab-card">
        <div className="wab-kicker"><TeamOutlined /> Customer self-service</div>
        <p className="wab-note-line">What a customer sees when they message your number. Only numbers <b>on file</b> get a reply.</p>
        <div className="wab-feat-list">{CUSTOMER_FEATURES.map((f) => (
          <Row key={f.key} label={f.label} desc={f.desc} checked={cfg[f.key] !== false} onChange={(v) => patch({ [f.key]: v })} />))}
        </div>
        <label className="wab-field"><span>Custom welcome line <span className="wab-optional">(optional)</span></span>
          <Input placeholder="e.g. For help, call 98765 43210" value={cfg.bot_welcome || ''} maxLength={200}
            onChange={(e) => setCfg((c) => ({ ...c, bot_welcome: e.target.value }))} onBlur={(e) => patch({ bot_welcome: e.target.value })} /></label>
      </div>
    </>
  );

  // ── Tab: Suppliers ──
  const SupplierTab = (
    <div className="wab-card">
      <div className="wab-feat" style={{ paddingTop: 0 }}>
        <div className="wab-feat-text"><div className="wab-feat-label"><ShopOutlined /> Supplier self-service</div>
          <div className="wab-feat-desc">When a <b>supplier</b> on file messages your number, they get their own menu (what you owe them, purchases, payments).</div></div>
        <Switch checked={supOn('enabled')} onChange={(v) => toggleSupPanel('enabled', v)} />
      </div>
      {supOn('enabled') && (
        <div className="wab-feat-list" style={{ marginTop: 6 }}>{SUPPLIER_FEATURES.map((f) => (
          <Row key={f.key} label={f.label} desc={f.desc} checked={supOn(f.key)} onChange={(v) => toggleSupPanel(f.key, v)} />))}
        </div>
      )}
    </div>
  );

  // ── Tab: Access ──
  const AccessTab = (
    <div className="wab-card">
      <div className="wab-kicker"><SafetyOutlined /> Blocked numbers</div>
      <p className="wab-note-line">Search a customer and block them — they get <b>no reply</b> from the bot. (Owners are never blocked.)</p>
      <Select showSearch allowClear value={null} placeholder="Search a customer to block…" style={{ width: '100%', maxWidth: 440 }}
        filterOption={(input, opt) => (opt?.label || '').toLowerCase().includes(input.toLowerCase())}
        onChange={(val) => { if (val) addBlockedNum(val); }}
        options={customers.map((c) => ({ value: last10(c.mobile_1), label: `${c.party_name} · +${c.mobile_1}` }))}
        notFoundContent={customers.length ? 'No match' : 'Loading customers…'} />
      {(cfg._blocked || []).length === 0 ? <div className="wab-block-empty" style={{ marginTop: 12 }}>No blocked customers.</div> : (
        <div className="wab-block-list" style={{ marginTop: 12 }}>{(cfg._blocked || []).map((num) => (
          <span className="wab-block-chip" key={num}><span>{labelForNumber(num)}</span>
            <Tooltip title="Un-block"><DeleteOutlined onClick={() => removeBlocked(num)} /></Tooltip></span>))}
        </div>
      )}
      <div className="wab-notes" style={{ marginTop: 16 }}>
        <div className="wab-note"><SafetyOutlined /><span>Only numbers <b>on file</b> get data — WhatsApp verifies the sender, so no one sees another's account.</span></div>
        <div className="wab-note"><CheckCircleFilled style={{ color: 'var(--success,#16a34a)' }} /><span>Replying to inbound messages is the <b>safest</b> WhatsApp use — normal two-way chat, not bulk sending.</span></div>
        <div className="wab-note"><InfoCircleOutlined /><span>This PC must stay on &amp; WhatsApp connected. Anyone can reply <b>STOP</b> to opt out.</span></div>
      </div>
    </div>
  );

  // ── Tab: Preview ──
  const PreviewTab = (
    <div className="wab-preview-grid">
      <div className="wab-card">
        <div className="wab-kicker"><CrownOutlined /> Owner sees</div>
        <div className="wab-preview"><div className="wab-bubble">{ownerPreview}</div></div>
      </div>
      <div className="wab-card">
        <div className="wab-kicker"><TeamOutlined /> Customer sees</div>
        <div className="wab-preview"><div className="wab-bubble">{custPreview}</div></div>
      </div>
    </div>
  );

  return (
    <div className="wab-page">
      <header className="wab-head">
        <div>
          <h1 className="wab-title">WhatsApp Bot</h1>
          <p className="wab-sub">A WhatsApp command-centre for your shop — owners get live business reports, customers &amp; suppliers self-serve. Everything below is under your control.</p>
        </div>
        <div className="wab-head-right">
          <span className={`wab-conn ${connected ? 'is-on' : ''}`}><WhatsAppOutlined />{connected ? `Connected${status.linked_number ? ' · ' + status.linked_number : ''}` : 'Not connected'}</span>
          <Button icon={<ReloadOutlined />} onClick={load} loading={loading}>Refresh</Button>
        </div>
      </header>

      {!connected && (
        <Alert type="warning" showIcon style={{ marginBottom: 16 }} message="Connect WhatsApp Web first"
          description={<>The bot replies from your linked number. Open <b>Settings → WhatsApp</b>, connect via QR, then enable the bot here.</>} />
      )}

      <div className={`wab-card wab-hero ${enabled ? 'is-on' : ''}`}>
        <div className="wab-hero-icon"><RobotOutlined /></div>
        <div className="wab-hero-body">
          <div className="wab-hero-row"><span className="wab-hero-ttl">WhatsApp Bot</span><Tag color={enabled ? 'success' : 'default'}>{enabled ? 'On' : 'Off'}</Tag></div>
          <p className="wab-hero-desc">{enabled ? 'Live — owners, customers and suppliers who message your number get instant replies.' : 'Turn on to auto-reply to anyone who messages your WhatsApp number.'}</p>
        </div>
        <Switch checked={enabled} loading={saving} onChange={(v) => patch({ bot_enabled: v }, v ? 'Bot enabled' : 'Bot turned off')} />
      </div>

      <Tabs defaultActiveKey="owner" className="wab-tabs" items={[
        { key: 'owner', label: <span><CrownOutlined /> Owner Panel</span>, children: OwnerTab },
        { key: 'customers', label: <span><TeamOutlined /> Customers</span>, children: CustomerTab },
        { key: 'suppliers', label: <span><ShopOutlined /> Suppliers</span>, children: SupplierTab },
        { key: 'access', label: <span><SafetyOutlined /> Access</span>, children: AccessTab },
        { key: 'preview', label: <span><EyeOutlined /> Preview</span>, children: PreviewTab },
      ]} />
    </div>
  );
}
