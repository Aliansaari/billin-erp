/*
 * Settings → TallyPrime Sync
 *
 * Two modes:
 *   A. File mode  — export/import XML files manually (offline). Primary
 *      workflow today. Export is fully implemented; import parser handles
 *      ledgers + stock items (file path & preview done via existing
 *      Excel-import-style preview on the server).
 *   B. Live mode  — direct HTTP-XML push/pull to a running Tally instance
 *      on port 9000. Test Connection + Push + Pull all route through
 *      /api/tally/live/* endpoints.
 *
 * Tally's ODBC/XML server has to be enabled in Tally itself:
 *   Gateway of Tally → F1 (Help) → Settings → Connectivity → ODBC Server.
 * See TALLY_INTEGRATION.md for the full setup guide.
 */

import React, { useEffect, useState } from 'react';
import {
  Card, Form, Input, InputNumber, Button, Alert, Typography, Space, Tag,
  message, Switch, Divider, Descriptions, Modal, Table, Upload, DatePicker,
  Tabs,
} from 'antd';
import {
  ApiOutlined, SaveOutlined, CheckCircleOutlined, ExperimentOutlined,
  DownloadOutlined, UploadOutlined, SyncOutlined, CloudUploadOutlined,
  CloudDownloadOutlined, FileTextOutlined, LinkOutlined, InboxOutlined,
} from '@ant-design/icons';
import dayjs from 'dayjs';
import { tallyAPI } from '../../api';

const { Title, Text, Paragraph } = Typography;
const { RangePicker } = DatePicker;

function saveBlob(blob, filename) {
  const url = window.URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  window.URL.revokeObjectURL(url);
}

export default function TallySync() {
  const [form] = Form.useForm();
  const [config, setConfig]       = useState(null);
  const [loading, setLoading]     = useState(false);
  const [saving, setSaving]       = useState(false);
  const [testing, setTesting]     = useState(false);
  const [testResult, setTestResult] = useState(null);

  const [exportBusy, setExportBusy] = useState(false);
  const [exportRange, setExportRange] = useState([dayjs().startOf('year'), dayjs()]);

  const [pushBusy, setPushBusy] = useState(false);
  const [pushResult, setPushResult] = useState(null);
  const [pullBusy, setPullBusy] = useState(false);
  const [pullResult, setPullResult] = useState(null);

  useEffect(() => { load(); }, []);

  const load = async () => {
    setLoading(true);
    try {
      const { data } = await tallyAPI.getConfig();
      setConfig(data);
      form.setFieldsValue(data);
    } catch (err) {
      message.error(err.response?.data?.error || 'Failed to load Tally config');
    }
    setLoading(false);
  };

  const handleSave = async (values) => {
    setSaving(true);
    try {
      const { data } = await tallyAPI.updateConfig(values);
      setConfig(data);
      message.success('Tally configuration saved');
    } catch (err) {
      message.error(err.response?.data?.error || 'Save failed');
    }
    setSaving(false);
  };

  const handleTestConnection = async () => {
    setTesting(true);
    setTestResult(null);
    try {
      const values = await form.validateFields(['tally_host', 'tally_port']);
      const { data } = await tallyAPI.testConnection(values);
      setTestResult({ ok: true, ...data });
      message.success('Tally responded successfully');
    } catch (err) {
      setTestResult({
        ok: false,
        error: err.response?.data?.error || err.message || 'Connection failed',
        detail: err.response?.data?.detail,
      });
    }
    setTesting(false);
  };

  /* ── File mode — Export XML ─────────────────────────────────────────── */

  const doExport = async (kind) => {
    setExportBusy(true);
    try {
      const params = {
        from_date: exportRange[0]?.format('YYYY-MM-DD'),
        to_date:   exportRange[1]?.format('YYYY-MM-DD'),
      };
      const call = kind === 'masters' ? tallyAPI.exportMastersXML : tallyAPI.exportVouchersXML;
      const { data } = await call(params);
      const stamp = dayjs().format('YYYY-MM-DD-HHmm');
      saveBlob(data, `tally-${kind}-${stamp}.xml`);
      message.success(`${kind} XML downloaded`);
    } catch (err) {
      message.error(err.response?.data?.error || 'Export failed');
    }
    setExportBusy(false);
  };

  /* ── File mode — Import XML ─────────────────────────────────────────── */

  const handleImportFile = async (file) => {
    try {
      const { data } = await tallyAPI.importXML(file);
      Modal.info({
        title: 'Tally XML imported',
        width: 600,
        content: (
          <Descriptions column={2} size="small" bordered>
            <Descriptions.Item label="Ledgers">{data.ledgers_imported || 0}</Descriptions.Item>
            <Descriptions.Item label="Stock Items">{data.stockitems_imported || 0}</Descriptions.Item>
            <Descriptions.Item label="Vouchers">{data.vouchers_imported || 0}</Descriptions.Item>
            <Descriptions.Item label="Errors">
              <Tag color={data.errors?.length ? 'red' : 'green'}>{data.errors?.length || 0}</Tag>
            </Descriptions.Item>
          </Descriptions>
        ),
      });
    } catch (err) {
      message.error(err.response?.data?.error || 'Import failed');
    }
    return false;
  };

  /* ── Live mode — Push / Pull ────────────────────────────────────────── */

  const handleLivePush = async () => {
    setPushBusy(true);
    setPushResult(null);
    try {
      const { data } = await tallyAPI.pushLive({
        from_date: exportRange[0]?.format('YYYY-MM-DD'),
        to_date:   exportRange[1]?.format('YYYY-MM-DD'),
      });
      setPushResult(data);
    } catch (err) {
      setPushResult({ error: err.response?.data?.error || err.message });
    }
    setPushBusy(false);
  };

  const handleLivePull = async () => {
    setPullBusy(true);
    setPullResult(null);
    try {
      const { data } = await tallyAPI.pullLive({
        from_date: exportRange[0]?.format('YYYY-MM-DD'),
        to_date:   exportRange[1]?.format('YYYY-MM-DD'),
      });
      setPullResult(data);
    } catch (err) {
      setPullResult({ error: err.response?.data?.error || err.message });
    }
    setPullBusy(false);
  };

  /* ── Render ─────────────────────────────────────────────────────────── */

  return (
    <div style={{ padding: 24, height: '100%', overflow: 'auto' }}>
      <div style={{ marginBottom: 16 }}>
        <Title level={3} style={{ margin: 0 }}><ApiOutlined /> TallyPrime Sync</Title>
        <Text type="secondary">
          Two-way bridge between this ERP and TallyPrime. Use <b>File mode</b> if your
          Tally is on a different machine; use <b>Live mode</b> if Tally is running
          locally with the XML server enabled.
        </Text>
      </div>

      <Card title={<Space><LinkOutlined /> Connection</Space>} style={{ marginBottom: 16 }}>
        <Form form={form} layout="vertical" onFinish={handleSave} initialValues={{ tally_host: 'localhost', tally_port: 9000 }}>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: 16 }}>
            <Form.Item name="tally_host" label="Tally Host" rules={[{ required: true }]}>
              <Input placeholder="localhost" />
            </Form.Item>
            <Form.Item name="tally_port" label="Tally Port" rules={[{ required: true }]}>
              <InputNumber min={1} max={65535} style={{ width: '100%' }} />
            </Form.Item>
            <Form.Item name="tally_company" label="Active Tally Company">
              <Input placeholder="e.g. My Retail Pvt Ltd" />
            </Form.Item>
            <Form.Item name="tally_sync_enabled" label="Live Sync Enabled" valuePropName="checked">
              <Switch />
            </Form.Item>
          </div>

          <Space>
            <Button type="primary" htmlType="submit" icon={<SaveOutlined />} loading={saving}>
              Save Configuration
            </Button>
            <Button icon={<ExperimentOutlined />} loading={testing} onClick={handleTestConnection}>
              Test Connection
            </Button>
            {config?.tally_last_sync && (
              <Text type="secondary" style={{ fontSize: 12 }}>
                Last sync: {dayjs(config.tally_last_sync).format('DD MMM YYYY HH:mm')}
              </Text>
            )}
          </Space>

          {testResult && (
            <Alert
              style={{ marginTop: 12 }}
              type={testResult.ok ? 'success' : 'error'}
              showIcon
              message={testResult.ok ? 'Tally is reachable' : 'Connection failed'}
              description={
                testResult.ok
                  ? <>Active company: <b>{testResult.active_company || '—'}</b>. Response in {testResult.ms} ms.</>
                  : <>
                      <div>{testResult.error}</div>
                      {testResult.detail && <pre style={{ marginTop: 6, fontSize: 11 }}>{testResult.detail}</pre>}
                      <div style={{ marginTop: 6 }}>
                        Check that Tally is running, Company is loaded,
                        and <Text code>Gateway → F1 → Connectivity → ODBC Server</Text> is ON.
                      </div>
                    </>
              }
            />
          )}
        </Form>
      </Card>

      <Card style={{ marginBottom: 16 }} size="small">
        <Space>
          <Text type="secondary">Date range for exports / live sync:</Text>
          <RangePicker
            value={exportRange}
            onChange={(v) => setExportRange(v || [dayjs().startOf('year'), dayjs()])}
            format="DD MMM YYYY"
            allowClear={false}
          />
        </Space>
      </Card>

      <Tabs
        defaultActiveKey="file"
        items={[
          {
            key: 'file',
            label: <Space><FileTextOutlined /> File Mode (offline)</Space>,
            children: (
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))', gap: 16 }}>
                <Card size="small" title="Export Masters to XML">
                  <Paragraph style={{ fontSize: 13 }}>
                    Ledgers (parties), Groups, Units, Stock Items. Open the file
                    from Tally via <Text code>Gateway → Import → Data</Text>.
                  </Paragraph>
                  <Button icon={<DownloadOutlined />} loading={exportBusy} onClick={() => doExport('masters')} block>
                    Download Masters XML
                  </Button>
                </Card>

                <Card size="small" title="Export Vouchers to XML">
                  <Paragraph style={{ fontSize: 13 }}>
                    Sales, Purchase, Receipt, Payment vouchers in the selected date
                    range. CGST/SGST split automatically for intrastate;
                    IGST for interstate.
                  </Paragraph>
                  <Button icon={<DownloadOutlined />} loading={exportBusy} onClick={() => doExport('vouchers')} block>
                    Download Vouchers XML
                  </Button>
                </Card>

                <Card size="small" title="Import Tally XML">
                  <Paragraph style={{ fontSize: 13 }}>
                    Upload a Tally export file (<Text code>&lt;ENVELOPE&gt;</Text>).
                    Ledgers → Parties, Stock Items → Products, Vouchers → Bills.
                  </Paragraph>
                  <Upload.Dragger
                    accept=".xml"
                    multiple={false}
                    showUploadList={false}
                    beforeUpload={handleImportFile}
                  >
                    <p className="ant-upload-drag-icon"><InboxOutlined /></p>
                    <p className="ant-upload-text">Drop or pick a Tally XML file</p>
                  </Upload.Dragger>
                </Card>
              </div>
            ),
          },
          {
            key: 'live',
            label: <Space><SyncOutlined /> Live Mode (HTTP-XML)</Space>,
            children: (
              <>
                <Alert
                  type="info"
                  showIcon
                  style={{ marginBottom: 16 }}
                  message="Live mode requires Tally's ODBC/XML server enabled"
                  description={
                    <ol style={{ marginBottom: 0, paddingLeft: 22 }}>
                      <li>In Tally, open the company you want to sync.</li>
                      <li>Go to <Text code>Gateway → F1 (Help) → Settings → Connectivity</Text>.</li>
                      <li>Turn <b>ODBC Server</b> ON, note the port (default 9000).</li>
                      <li>Click <b>Test Connection</b> above — you should see Tally's active company name.</li>
                    </ol>
                  }
                />

                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(320px, 1fr))', gap: 16 }}>
                  <Card size="small" title={<Space><CloudUploadOutlined /> Push to Tally</Space>}>
                    <Paragraph style={{ fontSize: 13 }}>
                      Bulk-POST this ERP's masters + vouchers as an XML envelope.
                      Tally returns per-voucher CREATED / ALTERED / IGNORED /
                      LINEERROR counts which are surfaced below.
                    </Paragraph>
                    <Button icon={<CloudUploadOutlined />} type="primary" block loading={pushBusy} onClick={handleLivePush}>
                      Push Now
                    </Button>
                    {pushResult && (
                      <Alert
                        style={{ marginTop: 12 }}
                        type={pushResult.error ? 'error' : 'success'}
                        message={pushResult.error || `Pushed successfully`}
                        description={!pushResult.error && (
                          <Descriptions size="small" column={2}>
                            <Descriptions.Item label="Created">{pushResult.created || 0}</Descriptions.Item>
                            <Descriptions.Item label="Altered">{pushResult.altered || 0}</Descriptions.Item>
                            <Descriptions.Item label="Ignored">{pushResult.ignored || 0}</Descriptions.Item>
                            <Descriptions.Item label="Errors">{pushResult.errors || 0}</Descriptions.Item>
                          </Descriptions>
                        )}
                      />
                    )}
                  </Card>

                  <Card size="small" title={<Space><CloudDownloadOutlined /> Pull from Tally</Space>}>
                    <Paragraph style={{ fontSize: 13 }}>
                      Fetch Ledgers, Stock Items, and Day Book vouchers for the
                      selected date range. Masters load first, then vouchers.
                    </Paragraph>
                    <Button icon={<CloudDownloadOutlined />} block loading={pullBusy} onClick={handleLivePull}>
                      Pull Now
                    </Button>
                    {pullResult && (
                      <Alert
                        style={{ marginTop: 12 }}
                        type={pullResult.error ? 'error' : 'success'}
                        message={pullResult.error || `Pulled successfully`}
                        description={!pullResult.error && (
                          <Descriptions size="small" column={2}>
                            <Descriptions.Item label="Ledgers">
                              {pullResult.ledgers || 0}
                              {pullResult.ledgers_seen != null && pullResult.ledgers_seen !== (pullResult.ledgers || 0) &&
                                <span style={{ color: 'var(--fg-tertiary)', marginLeft: 6 }}>
                                  of {pullResult.ledgers_seen} fetched
                                </span>}
                            </Descriptions.Item>
                            <Descriptions.Item label="Stock Items">
                              {pullResult.stockitems || 0}
                              {pullResult.stockitems_seen != null && pullResult.stockitems_seen !== (pullResult.stockitems || 0) &&
                                <span style={{ color: 'var(--fg-tertiary)', marginLeft: 6 }}>
                                  of {pullResult.stockitems_seen} fetched
                                </span>}
                            </Descriptions.Item>
                            <Descriptions.Item label="Vouchers">{pullResult.vouchers || 0}</Descriptions.Item>
                            <Descriptions.Item label="Conflicts">{pullResult.conflicts || 0}</Descriptions.Item>
                          </Descriptions>
                        )}
                      />
                    )}
                  </Card>
                </div>
              </>
            ),
          },
        ]}
      />
    </div>
  );
}
