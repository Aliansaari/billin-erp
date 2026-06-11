import React, { useEffect, useState } from 'react';
import {
  Steps, Card, Button, Input, Alert, message, Tag, Space, Form, InputNumber, Spin,
} from 'antd';
import {
  DatabaseOutlined, CheckCircleFilled, ExclamationCircleFilled,
  RocketOutlined, ReloadOutlined, KeyOutlined,
} from '@ant-design/icons';
import api from '../api';

/**
 * PostgresSetup — first-run database wizard.
 *
 * Three steps:
 *   1. Detect Postgres on this machine. We surface what we found
 *      (version + bin dir), or a friendly install prompt.
 *   2. Enter superuser credentials (host/port/user/password). Test
 *      the connection live.
 *   3. Provision the master database (`billing_erp_master`) and
 *      persist creds to <homedir>/.billing-erp/config.json.
 *
 * After success the user should restart the server (we surface a clear
 * "Restart now" hint). On the next boot the server reads the config
 * file and Sequelize connects to the freshly-created master DB.
 *
 * Reachable without auth (license + LAN gates bypass /api/setup/*).
 */
export default function PostgresSetup({ onDone }) {
  const [step, setStep] = useState(0);
  const [busy, setBusy] = useState(false);
  const [detection, setDetection] = useState(null);
  const [conn, setConn] = useState({
    host: 'localhost', port: 5432, user: 'postgres', password: '', master_db_name: 'billing_erp_master',
  });
  const [testResult, setTestResult] = useState(null);
  const [provisionResult, setProvisionResult] = useState(null);

  useEffect(() => { detect(); }, []);

  async function detect() {
    setBusy(true);
    try {
      const r = await api.get('/setup/detect-postgres');
      setDetection(r.data);
    } catch (e) {
      setDetection({ installed: false, error: e?.message || 'Detection failed' });
    } finally { setBusy(false); }
  }

  async function testConn() {
    setBusy(true);
    setTestResult(null);
    try {
      const r = await api.post('/setup/test-connection', conn);
      setTestResult(r.data);
    } catch (e) {
      setTestResult({ ok: false, error: e?.response?.data?.error || e.message });
    } finally { setBusy(false); }
  }

  async function provision() {
    setBusy(true);
    try {
      const r = await api.post('/setup/provision', conn);
      setProvisionResult(r.data);
      if (r.data?.ok) setStep(3);
    } catch (e) {
      setProvisionResult({ ok: false, error: e?.response?.data?.error || e.message });
    } finally { setBusy(false); }
  }

  return (
    <div style={{
      minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 24,
      background: 'radial-gradient(circle at 20% 10%, rgba(33,96,76,0.10), transparent 50%), radial-gradient(circle at 80% 90%, rgba(177,71,47,0.08), transparent 60%)',
    }}>
      <Card style={{ width: 600, boxShadow: '0 20px 60px rgba(0,0,0,0.18)' }}>
        <div style={{ display: 'flex', gap: 12, alignItems: 'center', marginBottom: 16 }}>
          <div style={{
            width: 44, height: 44, borderRadius: 10,
            background: 'linear-gradient(135deg, #21604C, #163d31)',
            color: 'white', display: 'flex', alignItems: 'center', justifyContent: 'center',
            fontSize: 22,
          }}>
            <DatabaseOutlined />
          </div>
          <div>
            <h2 style={{ margin: 0, fontSize: 20, fontWeight: 700 }}>Set up ZEHEN</h2>
            <div style={{ color: '#64748b', fontSize: 13 }}>One-time database configuration. Takes about a minute.</div>
          </div>
        </div>

        <Steps
          size="small"
          current={step}
          items={[
            { title: 'Detect' },
            { title: 'Connect' },
            { title: 'Provision' },
            { title: 'Done' },
          ]}
          style={{ marginBottom: 24 }}
        />

        {step === 0 && (
          <DetectStep
            busy={busy}
            detection={detection}
            onRetry={detect}
            onContinue={() => setStep(1)}
          />
        )}

        {step === 1 && (
          <ConnectStep
            conn={conn}
            setConn={setConn}
            busy={busy}
            testResult={testResult}
            onTest={testConn}
            onBack={() => setStep(0)}
            onContinue={() => setStep(2)}
          />
        )}

        {step === 2 && (
          <ProvisionStep
            conn={conn}
            busy={busy}
            result={provisionResult}
            onProvision={provision}
            onBack={() => setStep(1)}
          />
        )}

        {step === 3 && (
          <DoneStep
            result={provisionResult}
            onDone={onDone}
          />
        )}
      </Card>
    </div>
  );
}

function DetectStep({ busy, detection, onRetry, onContinue }) {
  if (busy && !detection) return <Spin size="large" />;

  if (detection?.installed) {
    return (
      <div>
        <Alert
          type="success"
          showIcon
          message="Postgres detected on this machine"
          description={(
            <div>
              <div>Version: <Tag color="green">{detection.version || 'unknown'}</Tag></div>
              {detection.binDir && (
                <div style={{ fontSize: 12, color: '#64748b', marginTop: 4 }}>
                  bin directory: <code>{detection.binDir}</code>
                </div>
              )}
              {detection.candidates?.length > 1 && (
                <div style={{ fontSize: 12, color: '#64748b', marginTop: 6 }}>
                  Other versions on this machine:{' '}
                  {detection.candidates.map(c => <Tag key={c.binDir}>{c.version}</Tag>)}
                </div>
              )}
            </div>
          )}
        />
        <Button type="primary" block size="large" onClick={onContinue} style={{ marginTop: 16 }} icon={<CheckCircleFilled />}>
          Continue to credentials
        </Button>
      </div>
    );
  }

  return (
    <div>
      <Alert
        type="warning"
        showIcon
        message="Postgres not found on this machine"
        description={(
          <div>
            <div>ZEHEN needs PostgreSQL 14 or newer. Install it from the
              <a href="https://www.postgresql.org/download/" target="_blank" rel="noreferrer" style={{ marginLeft: 4 }}>
                official site
              </a>, then click "Re-check".
            </div>
            <div style={{ marginTop: 8, fontSize: 12, color: '#64748b' }}>
              When the installer asks, set the postgres user password to something memorable —
              you'll need it on the next step.
            </div>
          </div>
        )}
      />
      <Space style={{ marginTop: 16 }}>
        <Button icon={<ReloadOutlined />} onClick={onRetry} loading={busy}>Re-check</Button>
        <Button type="link" onClick={onContinue}>I have Postgres elsewhere on the LAN — continue</Button>
      </Space>
    </div>
  );
}

function ConnectStep({ conn, setConn, busy, testResult, onTest, onBack, onContinue }) {
  const update = (k, v) => setConn({ ...conn, [k]: v });
  return (
    <div>
      <p style={{ color: '#475569', fontSize: 13, margin: '0 0 12px' }}>
        Where is Postgres running? Enter the superuser credentials. We'll
        connect to the cluster's <code>postgres</code> admin database to
        verify, then create the ZEHEN master database in the next step.
      </p>
      <Form layout="vertical" size="middle">
        <div style={{ display: 'grid', gridTemplateColumns: '2fr 1fr', gap: 12 }}>
          <Form.Item label="Host">
            <Input value={conn.host} onChange={e => update('host', e.target.value)} placeholder="localhost" />
          </Form.Item>
          <Form.Item label="Port">
            <InputNumber value={conn.port} onChange={v => update('port', v || 5432)} style={{ width: '100%' }} />
          </Form.Item>
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
          <Form.Item label="Superuser">
            <Input value={conn.user} onChange={e => update('user', e.target.value)} placeholder="postgres" prefix={<KeyOutlined />} />
          </Form.Item>
          <Form.Item label="Password">
            <Input.Password value={conn.password} onChange={e => update('password', e.target.value)} />
          </Form.Item>
        </div>
        <Form.Item label="Master database name">
          <Input value={conn.master_db_name} onChange={e => update('master_db_name', e.target.value)} />
          <div style={{ fontSize: 11, color: '#94a3b8', marginTop: 4 }}>
            Default is fine — only change this if you have a multi-tenant setup.
          </div>
        </Form.Item>
      </Form>

      {testResult?.ok && (
        <Alert
          type="success"
          showIcon
          message="Connection successful"
          description={(
            <div style={{ fontSize: 12, color: '#475569' }}>
              {testResult.version}
            </div>
          )}
          style={{ marginBottom: 12 }}
        />
      )}
      {testResult && !testResult.ok && (
        <Alert
          type="error"
          showIcon
          message="Could not connect"
          description={testResult.error || 'Unknown error'}
          style={{ marginBottom: 12 }}
        />
      )}

      <Space style={{ marginTop: 4 }}>
        <Button onClick={onBack}>Back</Button>
        <Button onClick={onTest} loading={busy} icon={<ReloadOutlined />}>Test connection</Button>
        <Button type="primary" onClick={onContinue} disabled={!testResult?.ok}>Continue</Button>
      </Space>
    </div>
  );
}

function ProvisionStep({ conn, busy, result, onProvision, onBack }) {
  return (
    <div>
      <Alert
        type="info"
        showIcon
        message="Ready to create the master database"
        description={(
          <ul style={{ marginBottom: 0, paddingLeft: 18, fontSize: 13 }}>
            <li>Database name: <code>{conn.master_db_name}</code></li>
            <li>Host: <code>{conn.host}:{conn.port}</code></li>
            <li>User: <code>{conn.user}</code></li>
            <li>If the database already exists, we leave it untouched.</li>
          </ul>
        )}
        style={{ marginBottom: 16 }}
      />

      {result && !result.ok && (
        <Alert type="error" showIcon message="Setup failed" description={result.error} style={{ marginBottom: 12 }} />
      )}

      <Space>
        <Button onClick={onBack}>Back</Button>
        <Button type="primary" size="large" icon={<RocketOutlined />} loading={busy} onClick={onProvision}>
          Create master database
        </Button>
      </Space>
    </div>
  );
}

function DoneStep({ result, onDone }) {
  return (
    <div>
      <Alert
        type="success"
        showIcon
        message="All set!"
        description={(
          <div>
            <div>Master database <code>{result?.masterDb}</code> is ready.</div>
            <div style={{ marginTop: 8, fontSize: 13, color: '#475569' }}>
              <strong>Restart the app now</strong> so the server picks up the new
              connection. Then activate your license on the next screen.
            </div>
          </div>
        )}
        style={{ marginBottom: 16 }}
      />
      <Button
        type="primary"
        block
        size="large"
        icon={<CheckCircleFilled />}
        onClick={() => {
          message.success('Reloading…');
          setTimeout(() => window.location.reload(), 600);
        }}
      >
        Restart and continue
      </Button>
      {onDone && (
        <Button block style={{ marginTop: 8 }} onClick={onDone}>Skip restart (advanced)</Button>
      )}
    </div>
  );
}
