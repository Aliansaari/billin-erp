import React, { useEffect, useMemo, useState } from 'react';
import {
  Alert, Button, Card, Divider, Input, List, Radio, Result,
  Space, Spin, Steps, Tag, Typography, message,
} from 'antd';
import {
  CloudServerOutlined, DesktopOutlined, GlobalOutlined,
  HomeOutlined, LinkOutlined, ReloadOutlined, ThunderboltOutlined,
  WifiOutlined, CheckCircleOutlined, CloseCircleOutlined, CopyOutlined,
} from '@ant-design/icons';
import { getServerUrl, setServerUrl, probeServer } from '../api';

const { Title, Text, Paragraph } = Typography;

/* ── Server Setup ─────────────────────────────────────────────────────────
 *
 * First-launch screen for any client (Electron OR browser). Two paths:
 *
 *   A. "This computer is the server"
 *      Used on the office machine that runs PostgreSQL + Express.
 *      Saves http://localhost:3001 as the server URL. Health-checked
 *      before saving so a misconfigured local DB is caught here, not
 *      30 s into the first login attempt.
 *
 *   B. "Connect to a server already running on the LAN"
 *      Used on every other PC / laptop / tablet. The user types the
 *      host's LAN IP (and optionally port). The URL is health-checked
 *      and only persisted on success.
 *
 * The page lists the *current* machine's LAN IPs (fetched from the
 * server's /api/server-info if reachable, else from the live page
 * itself when running in a browser) so the operator can read the
 * address out to staff doing setup on other machines.
 *
 * Reload-after-save is intentional: the axios instance reads the URL
 * from localStorage at module-init time, so changing it mid-session
 * wouldn't take effect on already-imported API consumers.
 *
 * Routing: the rest of the app guards on `<PrivateRoute>` (auth) — this
 * page guards on whether SERVER_URL_KEY is set (or whether the user
 * intentionally re-opens it from Settings → Network).
 */
export default function ServerSetup({ onDone, allowSkip = false }) {
  const [step,    setStep]    = useState(0);    // 0 = pick mode, 1 = configure, 2 = test+save
  const [mode,    setMode]    = useState('host'); // 'host' | 'client'
  const [input,   setInput]   = useState('http://192.168.1.');
  const [busy,    setBusy]    = useState(false);
  const [result,  setResult]  = useState(null); // { ok, info, error }
  const [hostInfo, setHostInfo] = useState(null); // /api/server-info response if reachable now
  const [hostBusy, setHostBusy] = useState(false);

  // Try to fetch the server's view of itself when in 'host' mode so we
  // can show the LAN IPs and confirm a local server is up. Falls back
  // silently if the local server isn't running yet.
  useEffect(() => {
    let cancelled = false;
    if (mode !== 'host') return;
    setHostBusy(true);
    probeServer('http://localhost:3001')
      .then(({ info }) => { if (!cancelled) setHostInfo(info); })
      .catch(() => { if (!cancelled) setHostInfo(null); })
      .finally(() => { if (!cancelled) setHostBusy(false); });
    return () => { cancelled = true; };
  }, [mode]);

  // The candidate URL the user has typed, normalised: ensure http:// scheme,
  // strip trailing slash. Empty string means "not enough to probe".
  const candidate = useMemo(() => {
    const t = String(input || '').trim();
    if (!t) return '';
    if (!/^https?:\/\//i.test(t)) return 'http://' + t.replace(/^\/+/, '').replace(/\/+$/, '');
    return t.replace(/\/+$/, '');
  }, [input]);

  const handleTest = async () => {
    setBusy(true);
    setResult(null);
    try {
      const url = mode === 'host' ? 'http://localhost:3001' : candidate;
      const res = await probeServer(url, { timeout: 5000 });
      setResult({ ok: true, info: res.info, health: res.health, url });
    } catch (e) {
      setResult({ ok: false, error: e.message || String(e) });
    } finally {
      setBusy(false);
    }
  };

  const handleSave = () => {
    if (!result?.ok) return;
    setServerUrl(result.url);
    message.success('Server connection saved');
    if (onDone) onDone(result.url);
    // Reload so the API base URL takes effect everywhere. The login
    // screen will appear (or the dashboard, if a session is still valid).
    setTimeout(() => { window.location.href = '/'; }, 600);
  };

  return (
    <div style={{
      minHeight: '100vh',
      background: 'linear-gradient(135deg, #f5f7fb 0%, #eef1f6 100%)',
      padding: '40px 20px',
      display: 'flex',
      justifyContent: 'center',
      alignItems: 'flex-start',
    }}>
      <div style={{ width: '100%', maxWidth: 720 }}>
        <div style={{ textAlign: 'center', marginBottom: 28 }}>
          <CloudServerOutlined style={{ fontSize: 44, color: '#21604C' }} />
          <Title level={2} style={{ marginTop: 12, marginBottom: 4 }}>
            Server Setup
          </Title>
          <Text type="secondary" style={{ fontSize: 14 }}>
            Tell ZEHEN where to find its database. You only do this once per computer.
          </Text>
        </div>

        <Card
          style={{ borderRadius: 14, boxShadow: '0 6px 32px rgba(15, 23, 42, 0.06)' }}
          styles={{ body: { padding: 28 } }}
        >
          <Steps
            current={step}
            size="small"
            style={{ marginBottom: 24 }}
            items={[
              { title: 'Choose role', icon: <DesktopOutlined /> },
              { title: 'Configure',   icon: <LinkOutlined /> },
              { title: 'Connect',     icon: <ThunderboltOutlined /> },
            ]}
          />

          {step === 0 && (
            <RoleStep
              mode={mode}
              setMode={setMode}
              hostInfo={hostInfo}
              hostBusy={hostBusy}
              onNext={() => setStep(1)}
              onSkip={allowSkip ? () => onDone && onDone(null) : null}
            />
          )}

          {step === 1 && (
            <ConfigureStep
              mode={mode}
              input={input}
              setInput={setInput}
              candidate={candidate}
              onBack={() => { setStep(0); setResult(null); }}
              onNext={() => { setStep(2); handleTest(); }}
            />
          )}

          {step === 2 && (
            <TestStep
              mode={mode}
              candidate={mode === 'host' ? 'http://localhost:3001' : candidate}
              busy={busy}
              result={result}
              onRetry={handleTest}
              onBack={() => { setStep(1); setResult(null); }}
              onSave={handleSave}
            />
          )}
        </Card>

        <div style={{ textAlign: 'center', marginTop: 18, color: '#9ca3af', fontSize: 12 }}>
          <WifiOutlined /> Wi-Fi is fine — the server doesn&rsquo;t need a wired LAN.
        </div>
      </div>
    </div>
  );
}

/* ── Step 0 ───────────────────────────────────────────────────────── */

function RoleStep({ mode, setMode, hostInfo, hostBusy, onNext, onSkip }) {
  return (
    <div>
      <Paragraph style={{ marginBottom: 18 }}>
        Pick the role this computer plays in your office network.
      </Paragraph>

      <Radio.Group
        value={mode}
        onChange={(e) => setMode(e.target.value)}
        style={{ width: '100%' }}
      >
        <Space direction="vertical" size={12} style={{ width: '100%' }}>
          <RoleCard
            value="host"
            picked={mode === 'host'}
            icon={<HomeOutlined style={{ fontSize: 22, color: '#21604C' }} />}
            title="This computer is the server"
            subtitle="The PC where the database (PostgreSQL) is installed. Pick this on ONE office machine — usually the main billing counter."
          >
            {hostBusy && <Spin size="small" />}
            {hostInfo && hostInfo.urls?.length > 0 && (
              <div style={{ marginTop: 10, fontSize: 12, color: '#21604C' }}>
                <CheckCircleOutlined /> Local server is already running.
                {' Other machines should use '}
                <code style={{ background: '#e6f4ee', padding: '1px 5px', borderRadius: 4 }}>
                  {hostInfo.urls[0]}
                </code>
              </div>
            )}
          </RoleCard>

          <RoleCard
            value="client"
            picked={mode === 'client'}
            icon={<GlobalOutlined style={{ fontSize: 22, color: '#4F46E5' }} />}
            title="Connect to a server on the network"
            subtitle="This PC, laptop, or tablet should bill against a server running on another machine in the same Wi-Fi / LAN."
          />
        </Space>
      </Radio.Group>

      <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 24 }}>
        <div>
          {onSkip && (
            <Button type="text" onClick={onSkip}>Skip for now</Button>
          )}
        </div>
        <Button type="primary" size="large" onClick={onNext}>Next</Button>
      </div>
    </div>
  );
}

function RoleCard({ value, picked, icon, title, subtitle, children }) {
  return (
    <label
      style={{
        display: 'block',
        cursor: 'pointer',
        border: picked ? '2px solid #21604C' : '1px solid #e5e7eb',
        borderRadius: 12,
        padding: 16,
        background: picked ? 'rgba(33, 96, 76, 0.04)' : '#fff',
        transition: 'all 0.15s ease',
      }}
    >
      <Radio value={value} style={{ display: 'flex', alignItems: 'flex-start', width: '100%' }}>
        <div style={{ display: 'flex', gap: 14 }}>
          <div style={{ paddingTop: 2 }}>{icon}</div>
          <div>
            <div style={{ fontSize: 15, fontWeight: 600, color: '#1f2937', marginBottom: 2 }}>{title}</div>
            <div style={{ fontSize: 12, color: '#6b7280' }}>{subtitle}</div>
            {children}
          </div>
        </div>
      </Radio>
    </label>
  );
}

/* ── Step 1 ───────────────────────────────────────────────────────── */

function ConfigureStep({ mode, input, setInput, candidate, onBack, onNext }) {
  if (mode === 'host') {
    return (
      <div>
        <Alert
          type="info"
          showIcon
          message="Make sure PostgreSQL and the ZEHEN server are running"
          description={
            <span>
              Run <code>npm run server</code> on this machine, or use the bundled Electron build.
              The next step will probe <code>http://localhost:3001</code>.
            </span>
          }
          style={{ marginBottom: 16 }}
        />
        <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 16 }}>
          <Button onClick={onBack}>Back</Button>
          <Button type="primary" size="large" icon={<ThunderboltOutlined />} onClick={onNext}>
            Probe local server
          </Button>
        </div>
      </div>
    );
  }

  // Client mode — type the host machine's URL
  return (
    <div>
      <Paragraph>
        Type the address of the computer that runs the ZEHEN server. Ask the office admin —
        they can read it off their copy of this app under Settings → Network. It usually looks like
        {' '}<code>http://192.168.1.50:3001</code>.
      </Paragraph>

      <Input
        size="large"
        placeholder="http://192.168.1.50:3001"
        value={input}
        onChange={(e) => setInput(e.target.value)}
        prefix={<LinkOutlined style={{ color: '#9ca3af' }} />}
        style={{ marginBottom: 8 }}
        onPressEnter={() => candidate && onNext()}
        autoFocus
      />
      <Text type="secondary" style={{ fontSize: 12 }}>
        Will probe: <code>{candidate || '(type an address above)'}</code>
      </Text>

      <Alert
        type="warning"
        showIcon
        message="Both computers must be on the same Wi-Fi or LAN"
        description="If you can browse to the host's URL in your normal web browser and see a ZEHEN page, this app will connect too."
        style={{ marginTop: 16 }}
      />

      <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 18 }}>
        <Button onClick={onBack}>Back</Button>
        <Button type="primary" size="large" disabled={!candidate} onClick={onNext}>
          Test connection
        </Button>
      </div>
    </div>
  );
}

/* ── Step 2 ───────────────────────────────────────────────────────── */

function TestStep({ mode, candidate, busy, result, onRetry, onBack, onSave }) {
  return (
    <div>
      <div style={{ marginBottom: 16, padding: 12, background: '#f9fafb', borderRadius: 8, fontSize: 13 }}>
        <span style={{ color: '#6b7280' }}>Probing:</span>{' '}
        <code style={{ color: '#1f2937' }}>{candidate}/api/health</code>
      </div>

      {busy && (
        <div style={{ textAlign: 'center', padding: 30 }}>
          <Spin size="large" />
          <div style={{ marginTop: 12, color: '#6b7280' }}>Reaching the server…</div>
        </div>
      )}

      {!busy && result?.ok && (
        <Result
          status="success"
          icon={<CheckCircleOutlined style={{ color: '#16a34a' }} />}
          title="Connected!"
          subTitle={
            <>
              <div style={{ fontSize: 13, color: '#6b7280', marginTop: 6 }}>
                {result.info?.hostname && <>Host: <Tag>{result.info.hostname}</Tag></>}
                {result.info?.version && <>Version: <Tag>v{result.info.version}</Tag></>}
                Database: <Tag color="green">online</Tag>
              </div>
              {result.info?.urls?.length > 0 && (
                <div style={{ marginTop: 14 }}>
                  <Text type="secondary" style={{ fontSize: 12 }}>
                    Other machines on this network can also use:
                  </Text>
                  <List
                    size="small"
                    style={{ marginTop: 6, maxWidth: 360, marginLeft: 'auto', marginRight: 'auto' }}
                    dataSource={result.info.urls}
                    renderItem={(u) => (
                      <List.Item
                        style={{ padding: '4px 8px' }}
                        actions={[
                          <Button
                            key="copy"
                            size="small"
                            type="text"
                            icon={<CopyOutlined />}
                            onClick={() => {
                              navigator.clipboard?.writeText(u);
                              message.success('Copied');
                            }}
                          />,
                        ]}
                      >
                        <code style={{ fontSize: 12 }}>{u}</code>
                      </List.Item>
                    )}
                  />
                </div>
              )}
            </>
          }
          extra={[
            <Button key="back" onClick={onBack}>Back</Button>,
            <Button key="save" type="primary" size="large" icon={<CheckCircleOutlined />} onClick={onSave}>
              Save and continue
            </Button>,
          ]}
        />
      )}

      {!busy && result && !result.ok && (
        <Result
          status="error"
          icon={<CloseCircleOutlined style={{ color: '#dc2626' }} />}
          title="Couldn’t reach the server"
          subTitle={
            <div style={{ textAlign: 'left', maxWidth: 460, margin: '0 auto' }}>
              <Paragraph style={{ marginBottom: 8 }}>
                <Text code>{result.error}</Text>
              </Paragraph>
              <Paragraph style={{ marginBottom: 0, fontSize: 13 }}>
                Things to check:
                <ul style={{ marginTop: 6, marginBottom: 0, paddingLeft: 18 }}>
                  <li>Is the address correct? <code>{candidate}</code></li>
                  {mode === 'client' && <li>Is the host PC switched on, not asleep, and on the same Wi-Fi?</li>}
                  {mode === 'host'   && <li>Did you start the server with <code>npm run server</code>?</li>}
                  <li>Is PostgreSQL running on the host?</li>
                  <li>Is a firewall blocking port 3001?</li>
                </ul>
              </Paragraph>
            </div>
          }
          extra={[
            <Button key="back"  onClick={onBack}>Back</Button>,
            <Button key="retry" type="primary" icon={<ReloadOutlined />} onClick={onRetry}>
              Retry
            </Button>,
          ]}
        />
      )}
    </div>
  );
}

/* ── Helper for the gate component used in App.jsx ────────────────── */

/**
 * `useNeedsServerSetup` — returns `true` when the app should show the
 * Server Setup screen before anything else. We trigger setup when:
 *
 *   - Running under file:// (Electron prod, no relative-URL fallback)
 *     AND no SERVER_URL_KEY is set yet.
 *
 * Browser clients (http://) implicitly know the server URL — it's the
 * page's own origin — so they skip the gate entirely.
 */
export function useNeedsServerSetup() {
  const [needs, setNeeds] = React.useState(() => {
    if (typeof window === 'undefined') return false;
    if (window.location?.protocol !== 'file:') return false;
    return !getServerUrl();
  });
  return needs;
}
