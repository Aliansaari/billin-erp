import React, { useState, useEffect, useCallback } from 'react';
import {
  Card, Button, Table, Tag, Space, Modal, message, Tabs, Form,
  Switch, Select, TimePicker, InputNumber, Upload, Typography,
  Row, Col, Statistic, Tooltip, Divider, Alert, Progress, Badge,
} from 'antd';
import {
  CloudDownloadOutlined, DeleteOutlined, ReloadOutlined,
  UploadOutlined, SaveOutlined, ClockCircleOutlined,
  CheckCircleOutlined, CloseCircleOutlined, DatabaseOutlined,
  FolderOpenOutlined, ExclamationCircleOutlined, ThunderboltOutlined,
  DownloadOutlined, HistoryOutlined, SettingOutlined,
  SyncOutlined, LockOutlined, SafetyOutlined,
} from '@ant-design/icons';
import { useNavigate } from 'react-router-dom';
import dayjs from 'dayjs';
import relativeTime from 'dayjs/plugin/relativeTime';
import { backupAPI } from '../../api';
import ActionStrip from '../../components/keyboard/ActionStrip';
import CleanupModal from './CleanupModal';
import { useShowDataCleanup } from '../../hooks/useSystemSettings';
import './ModuleSettings.css';

dayjs.extend(relativeTime);

const { Title, Text, Paragraph } = Typography;
const { Option } = Select;

// ── Helpers ───────────────────────────────────────────────────────────────────

function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

function formatFilename(filename) {
  // backup_manual_2024-01-15_14-30-00.json → Jan 15, 2024  2:30 PM
  const match = filename.match(/backup_(?:manual|auto)_(\d{4})-(\d{2})-(\d{2})_(\d{2})-(\d{2})-(\d{2})\.(json|enc)/);
  if (!match) return filename;
  const [, yr, mo, dy, hr, mn] = match;
  return dayjs(`${yr}-${mo}-${dy}T${hr}:${mn}`).format('MMM D, YYYY  h:mm A');
}

// ── Main Component ────────────────────────────────────────────────────────────

export default function BackupRestore() {
  const navigate = useNavigate();
  // Data Cleanup / Wipe is a destructive power-tool. Gate it on the
  // dev_show_data_cleanup flag (or developer-mode unlock). It used to
  // render unconditionally, so the DeveloperSettings "Data Cleanup /
  // Wipe" toggle had no effect at all.
  const showDataCleanup = useShowDataCleanup();
  const [backups, setBackups]               = useState([]);
  const [settings, setSettings]             = useState({});
  const [totalSize, setTotalSize]           = useState('—');
  const [loading, setLoading]               = useState(false);
  const [creatingBackup, setCreatingBackup] = useState(false);
  const [savingSettings, setSavingSettings] = useState(false);
  const [restoring, setRestoring]           = useState(false);
  const [restoreProgress, setRestoreProgress] = useState(0);
  const [deleteTarget, setDeleteTarget]     = useState(null);
  const [restoreTarget, setRestoreTarget]   = useState(null); // { filename } or { file }
  const [uploadFile, setUploadFile]         = useState(null);
  const [activeTab, setActiveTab]           = useState('backups');
  const [cleanupOpen, setCleanupOpen]       = useState(false);
  const [form]                              = Form.useForm();

  // ── Data fetching ─────────────────────────────────────────────────────────

  const fetchData = useCallback(async () => {
    setLoading(true);
    try {
      const res = await backupAPI.list();
      setBackups(res.data.backups || []);
      setSettings(res.data.settings || {});
      setTotalSize(res.data.totalSizeFormatted || '0 B');
      form.setFieldsValue({
        ...res.data.settings,
        time: res.data.settings?.time ? dayjs(res.data.settings.time, 'HH:mm') : dayjs('02:00', 'HH:mm'),
      });
    } catch (err) {
      message.error('Failed to load backups');
    } finally {
      setLoading(false);
    }
  }, [form]);

  useEffect(() => { fetchData(); }, [fetchData]);

  // ── Manual backup ─────────────────────────────────────────────────────────

  const handleCreateBackup = async () => {
    setCreatingBackup(true);
    try {
      const res = await backupAPI.create();
      const cd = res.headers['content-disposition'] || '';
      const match = cd.match(/filename="?([^"]+)"?/);
      const filename = match ? match[1] : `backup_manual_${Date.now()}.enc`;
      downloadBlob(res.data, filename);
      message.success('Backup created and downloaded');
      fetchData();
    } catch (err) {
      message.error('Failed to create backup');
    } finally {
      setCreatingBackup(false);
    }
  };

  // ── Download existing backup ──────────────────────────────────────────────

  const handleDownload = async (filename) => {
    try {
      const res = await backupAPI.download(filename);
      downloadBlob(res.data, filename);
      message.success('Backup downloaded');
    } catch {
      message.error('Download failed');
    }
  };

  // ── Delete backup ─────────────────────────────────────────────────────────

  const confirmDelete = async () => {
    if (!deleteTarget) return;
    try {
      await backupAPI.delete(deleteTarget);
      message.success('Backup deleted');
      setDeleteTarget(null);
      fetchData();
    } catch {
      message.error('Delete failed');
    }
  };

  // ── Restore ───────────────────────────────────────────────────────────────

  const handleRestore = async () => {
    if (!restoreTarget) return;
    setRestoring(true);
    setRestoreProgress(0);

    // Fake progress for UX (real progress not measurable on restore)
    const tick = setInterval(() => {
      setRestoreProgress(p => (p < 85 ? p + Math.random() * 8 : p));
    }, 600);

    try {
      const arg = restoreTarget.filename || restoreTarget.file;
      const onProgress = (p) => setRestoreProgress(p);
      await backupAPI.restore(arg, onProgress);
      clearInterval(tick);
      setRestoreProgress(100);
      message.success('Database restored successfully! Refreshing in 3 s…', 4);
      setRestoreTarget(null);
      setUploadFile(null);
      fetchData();
      setTimeout(() => window.location.reload(), 3000);
    } catch (err) {
      clearInterval(tick);
      message.error(err.response?.data?.error || 'Restore failed');
      setRestoring(false);
      setRestoreProgress(0);
    }
  };

  // ── Auto-backup settings ──────────────────────────────────────────────────

  const handleSaveSettings = async (values) => {
    setSavingSettings(true);
    try {
      const payload = {
        ...values,
        time: values.time ? values.time.format('HH:mm') : '02:00',
      };
      const res = await backupAPI.updateSettings(payload);
      setSettings(res.data);
      message.success('Auto-backup settings saved');
    } catch {
      message.error('Failed to save settings');
    } finally {
      setSavingSettings(false);
    }
  };

  // ── Backup list columns ───────────────────────────────────────────────────

  const columns = [
    {
      title: 'Backup',
      dataIndex: 'filename',
      key: 'filename',
      render: (filename, row) => (
        <Space direction="vertical" size={2}>
          <Text strong style={{ fontSize: 14, color: 'var(--fg-primary, #0F172A)' }}>{formatFilename(filename)}</Text>
          <span className="bkp-filename">{filename}</span>
        </Space>
      ),
    },
    {
      title: 'Type',
      dataIndex: 'type',
      key: 'type',
      width: 130,
      render: (type, row) => {
        const isEnc = row.filename?.endsWith('.enc');
        return (
          <Space size={4}>
            {type === 'auto'
              ? <Tag color="blue" icon={<ClockCircleOutlined />}>Auto</Tag>
              : <Tag color="green" icon={<ThunderboltOutlined />}>Manual</Tag>}
            {isEnc && <Tag color="gold" icon={<LockOutlined />}>Encrypted</Tag>}
          </Space>
        );
      },
    },
    {
      title: 'Size',
      dataIndex: 'sizeFormatted',
      key: 'size',
      width: 90,
    },
    {
      title: 'Created',
      dataIndex: 'createdAt',
      key: 'createdAt',
      width: 150,
      render: (d) => (
        <Tooltip title={dayjs(d).format('MMM D, YYYY h:mm A')}>
          <span>{dayjs(d).fromNow()}</span>
        </Tooltip>
      ),
    },
    {
      title: 'Actions',
      key: 'actions',
      width: 160,
      render: (_, row) => (
        <div className="bkp-row-actions">
          <Tooltip title="Download backup">
            <button type="button" className="bkp-icon-btn" onClick={() => handleDownload(row.filename)} aria-label="Download">
              <DownloadOutlined />
            </button>
          </Tooltip>
          <Tooltip title="Restore from this backup">
            <button type="button" className="bkp-icon-btn bkp-icon-btn-accent" onClick={() => setRestoreTarget({ filename: row.filename })} aria-label="Restore">
              <SyncOutlined />
            </button>
          </Tooltip>
          <Tooltip title="Delete backup">
            <button type="button" className="bkp-icon-btn bkp-icon-btn-danger" onClick={() => setDeleteTarget(row.filename)} aria-label="Delete">
              <DeleteOutlined />
            </button>
          </Tooltip>
        </div>
      ),
    },
  ];

  // ── Last backup status ────────────────────────────────────────────────────

  const lastBackupStatus = settings.lastBackupStatus;
  const lastBackupTime   = settings.lastBackup
    ? dayjs(settings.lastBackup).fromNow()
    : 'Never';

  // ── Render ────────────────────────────────────────────────────────────────

  const tabItems = [
    {
      key: 'backups',
      label: <span><HistoryOutlined /> Backup History</span>,
      children: (
        <Space direction="vertical" size="large" style={{ width: '100%' }}>

          {/* Action row — primary backup button moved to page header; this is just summary + refresh */}
          <div className="bkp-list-head">
            <div>
              <div className="bkp-list-head-title">Saved backups</div>
              <div className="bkp-list-head-sub">
                {backups.length} backup{backups.length !== 1 ? 's' : ''} · {totalSize} total
              </div>
            </div>
            <Button icon={<ReloadOutlined />} onClick={fetchData} loading={loading}>Refresh</Button>
          </div>

          {backups.length === 0 && !loading && (
            <Alert
              message="No backups yet"
              description='Click "Create Backup Now" to create your first backup. All data will be saved as a JSON file.'
              type="info"
              showIcon
              icon={<DatabaseOutlined />}
            />
          )}

          <Table
            columns={columns}
            dataSource={backups}
            rowKey="filename"
            loading={loading}
            pagination={{ pageSize: 15, showTotal: (t) => `${t} backups` }}
            size="middle"
          />
        </Space>
      ),
    },
    {
      key: 'auto',
      label: (
        <span>
          <ClockCircleOutlined />
          {' Auto-Backup '}
          {settings.enabled
            ? <Badge status="processing" />
            : <Badge status="default" />}
        </span>
      ),
      children: (
        <Row gutter={[24, 24]}>
          <Col xs={24} lg={14}>
            <Card title={<><SettingOutlined /> Schedule Settings</>} bordered={false}>
              <Form
                form={form}
                layout="vertical"
                onFinish={handleSaveSettings}
                initialValues={{
                  enabled: false,
                  frequency: 'daily',
                  time: dayjs('02:00', 'HH:mm'),
                  dayOfWeek: 0,
                  dayOfMonth: 1,
                  maxBackups: 10,
                }}
              >
                <Form.Item name="enabled" label="Enable Automatic Backups" valuePropName="checked">
                  <Switch
                    checkedChildren="ON"
                    unCheckedChildren="OFF"
                    style={{ width: 70 }}
                  />
                </Form.Item>

                <Form.Item name="frequency" label="Backup Frequency">
                  <Select style={{ width: 200 }}>
                    <Option value="hourly">Every Hour</Option>
                    <Option value="daily">Daily</Option>
                    <Option value="weekly">Weekly</Option>
                    <Option value="monthly">Monthly</Option>
                  </Select>
                </Form.Item>

                <Form.Item
                  noStyle
                  shouldUpdate={(prev, cur) => prev.frequency !== cur.frequency}
                >
                  {({ getFieldValue }) => {
                    const freq = getFieldValue('frequency');
                    return (
                      <>
                        {freq !== 'hourly' && (
                          <Form.Item name="time" label="Backup Time">
                            <TimePicker format="HH:mm" minuteStep={15} style={{ width: 140 }} />
                          </Form.Item>
                        )}
                        {freq === 'weekly' && (
                          <Form.Item name="dayOfWeek" label="Day of Week">
                            <Select style={{ width: 160 }}>
                              {['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'].map((d, i) => (
                                <Option key={i} value={i}>{d}</Option>
                              ))}
                            </Select>
                          </Form.Item>
                        )}
                        {freq === 'monthly' && (
                          <Form.Item name="dayOfMonth" label="Day of Month">
                            <InputNumber min={1} max={28} style={{ width: 100 }} />
                          </Form.Item>
                        )}
                      </>
                    );
                  }}
                </Form.Item>

                <Form.Item
                  name="maxBackups"
                  label="Keep Last N Backups"
                  extra="Older backups are deleted automatically when this limit is reached."
                >
                  <InputNumber min={1} max={100} style={{ width: 100 }} />
                </Form.Item>

                <Divider style={{ margin: '16px 0' }} />

                <Form.Item>
                  <Button
                    type="primary"
                    htmlType="submit"
                    icon={<SaveOutlined />}
                    loading={savingSettings}
                  >
                    Save Settings
                  </Button>
                </Form.Item>
              </Form>
            </Card>
          </Col>

          <Col xs={24} lg={10}>
            <Space direction="vertical" size="middle" style={{ width: '100%' }}>
              <Card title={<><HistoryOutlined /> Last Auto-Backup</>} bordered={false}>
                <Space direction="vertical" style={{ width: '100%' }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                    <Text type="secondary">Status</Text>
                    {lastBackupStatus === 'success'
                      ? <Tag color="success" icon={<CheckCircleOutlined />}>Success</Tag>
                      : lastBackupStatus === 'failed'
                        ? <Tag color="error" icon={<CloseCircleOutlined />}>Failed</Tag>
                        : <Tag color="default">Not run yet</Tag>
                    }
                  </div>
                  <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                    <Text type="secondary">When</Text>
                    <Text strong>{lastBackupTime}</Text>
                  </div>
                  {settings.lastBackupFile && (
                    <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                      <Text type="secondary">File</Text>
                      <Text code style={{ fontSize: 11, maxWidth: 180, overflow: 'hidden', textOverflow: 'ellipsis' }}>
                        {settings.lastBackupFile}
                      </Text>
                    </div>
                  )}
                  {settings.lastBackupError && (
                    <Alert type="error" message={settings.lastBackupError} showIcon style={{ fontSize: 12 }} />
                  )}
                </Space>
              </Card>

              <Card
                title={<><SafetyOutlined /> Security</>}
                bordered={false}
                size="small"
                style={{ marginBottom: 16 }}
              >
                <Space>
                  <LockOutlined style={{ color: '#21604C', fontSize: 18 }} />
                  <div>
                    <Text strong style={{ color: '#21604C' }}>AES-256 Encrypted</Text>
                    <div style={{ fontSize: 11, color: '#64748b' }}>All backups are encrypted automatically</div>
                  </div>
                </Space>
              </Card>

              <Card title="How it works" bordered={false} size="small">
                <Paragraph style={{ fontSize: 13, color: '#555' }}>
                  Automatic backups run on the server in the background. Backup files are stored
                  locally and can be downloaded from the Backup History tab.
                  The server checks every 60 seconds whether a scheduled backup is due.
                </Paragraph>
                <Paragraph style={{ fontSize: 13, color: '#555', marginBottom: 0 }}>
                  Manual backups download the file directly to your browser.
                  All backups are encrypted — your data is always protected.
                </Paragraph>
              </Card>
            </Space>
          </Col>
        </Row>
      ),
    },
    {
      key: 'restore',
      label: <span><SyncOutlined /> Restore</span>,
      children: (
        <Row gutter={[24, 24]}>
          <Col xs={24} lg={12}>
            <Card
              title={<><UploadOutlined /> Restore from File</>}
              bordered={false}
            >
              <Alert
                type="warning"
                showIcon
                icon={<ExclamationCircleOutlined />}
                message="This will overwrite ALL current data"
                description="Restoring a backup permanently replaces every record in the database. Create a fresh backup first if you want to preserve the current state."
                style={{ marginBottom: 20 }}
              />
              <Space direction="vertical" style={{ width: '100%' }}>
                <Upload
                  accept=".json,.enc"
                  beforeUpload={(file) => { setUploadFile(file); return false; }}
                  onRemove={() => setUploadFile(null)}
                  maxCount={1}
                  fileList={uploadFile ? [{ uid: '-1', name: uploadFile.name, status: 'done' }] : []}
                >
                  <Button icon={<FolderOpenOutlined />} block>
                    Select Backup File (.json / .enc)
                  </Button>
                </Upload>

                {uploadFile && (
                  <Button
                    type="primary"
                    danger
                    icon={<SyncOutlined />}
                    block
                    onClick={() => setRestoreTarget({ file: uploadFile })}
                  >
                    Restore from Selected File
                  </Button>
                )}
              </Space>
            </Card>
          </Col>

          <Col xs={24} lg={12}>
            <Card
              title={<><HistoryOutlined /> Restore from Saved Backup</>}
              bordered={false}
            >
              {backups.length === 0 ? (
                <Alert message="No saved backups found" type="info" showIcon />
              ) : (
                <Space direction="vertical" style={{ width: '100%' }}>
                  <Text type="secondary">Select a backup from history to restore:</Text>
                  <Table
                    size="small"
                    dataSource={backups.slice(0, 8)}
                    rowKey="filename"
                    pagination={backups.length > 8 ? { pageSize: 8 } : false}
                    columns={[
                      {
                        title: 'Backup',
                        dataIndex: 'filename',
                        render: (f) => (
                          <Space direction="vertical" size={0}>
                            <Text style={{ fontSize: 13 }}>{formatFilename(f)}</Text>
                            <Text type="secondary" style={{ fontSize: 10 }}>
                              {f.includes('_auto_') ? 'Auto' : 'Manual'}
                            </Text>
                          </Space>
                        ),
                      },
                      {
                        title: 'Size',
                        dataIndex: 'sizeFormatted',
                        width: 80,
                      },
                      {
                        title: '',
                        key: 'action',
                        width: 80,
                        render: (_, row) => (
                          <Button
                            size="small"
                            type="primary"
                            danger
                            icon={<SyncOutlined />}
                            onClick={() => setRestoreTarget({ filename: row.filename })}
                          >
                            Restore
                          </Button>
                        ),
                      },
                    ]}
                  />
                </Space>
              )}
            </Card>
          </Col>
        </Row>
      ),
    },
  ];

  return (
    <div className="ms-shell settings-pane-fill bkp-page">
      <style>{BKP_STYLES}</style>

      <header className="ms-page-header bkp-header">
        <div>
          <h1 className="ms-page-title">Backup &amp; Recovery</h1>
          <p className="ms-page-sub">
            Encrypted backups of your entire database — schedule them, restore them, or wipe data when starting fresh.
          </p>
        </div>
        <Button
          type="primary"
          size="large"
          icon={<CloudDownloadOutlined />}
          loading={creatingBackup}
          onClick={handleCreateBackup}
          className="bkp-primary-btn"
        >
          Backup now
        </Button>
      </header>

      <div className="ms-page-body">
        <div className="ms-page-body-inner">
      {/* Stats row — premium card style */}
      <div className="bkp-stats">
        <StatTile
          tone="indigo"
          icon={<DatabaseOutlined />}
          label="Total backups"
          value={backups.length}
        />
        <StatTile
          tone="emerald"
          icon={<FolderOpenOutlined />}
          label="Storage used"
          value={totalSize}
        />
        <StatTile
          tone="amber"
          icon={<ClockCircleOutlined />}
          label="Last backup"
          value={lastBackupTime}
        />
        <StatTile
          tone={settings.enabled ? 'teal' : 'slate'}
          icon={settings.enabled ? <CheckCircleOutlined /> : <CloseCircleOutlined />}
          label="Auto-backup"
          value={settings.enabled ? `${(settings.frequency || 'daily').charAt(0).toUpperCase() + (settings.frequency || 'daily').slice(1)}` : 'Disabled'}
        />
      </div>

      {/* Main content tabs */}
      <Card bordered={false} className="bkp-tabs-card">
        <Tabs activeKey={activeTab} onChange={setActiveTab} items={tabItems} size="large" />
      </Card>

      {/* ── Danger zone — destructive, password-gated bulk cleanup ──
          Hidden unless the dev_show_data_cleanup flag is on (or developer
          mode is unlocked). Gating the modal too is defence-in-depth. */}
      {showDataCleanup && (
        <>
          <div className="bkp-danger">
            <div className="bkp-danger-inner">
              <div className="bkp-danger-icon"><ExclamationCircleOutlined /></div>
              <div className="bkp-danger-text">
                <div className="bkp-danger-eyebrow">Danger Zone</div>
                <div className="bkp-danger-title">Delete data permanently</div>
                <div className="bkp-danger-sub">
                  Wipe sales, purchases, payments, products, parties, and more — by category. Requires admin password confirmation.
                </div>
              </div>
              <Button danger icon={<DeleteOutlined />} onClick={() => setCleanupOpen(true)} className="bkp-danger-btn">
                Clean / reset…
              </Button>
            </div>
          </div>

          <CleanupModal open={cleanupOpen} onClose={() => setCleanupOpen(false)} />
        </>
      )}

      {/* ── Delete confirmation modal ── */}
      <Modal
        title={<><DeleteOutlined style={{ color: '#ff4d4f' }} /> Delete Backup</>}
        open={!!deleteTarget}
        onOk={confirmDelete}
        onCancel={() => setDeleteTarget(null)}
        okText="Delete"
        okButtonProps={{ danger: true }}
        width={420}
      >
        <Paragraph>
          Are you sure you want to permanently delete this backup?
        </Paragraph>
        <Text code style={{ fontSize: 12 }}>{deleteTarget}</Text>
      </Modal>

      {/* ── Restore confirmation modal ── */}
      <Modal
        title={<><ExclamationCircleOutlined style={{ color: '#faad14' }} /> Confirm Restore</>}
        open={!!restoreTarget && !restoring}
        onOk={handleRestore}
        onCancel={() => setRestoreTarget(null)}
        okText="Yes, Restore Now"
        okButtonProps={{ danger: true, size: 'large' }}
        cancelButtonProps={{ size: 'large' }}
        width={480}
      >
        <Alert
          type="error"
          showIcon
          message="This action cannot be undone"
          description="All current data (sales, purchases, inventory, parties, payments…) will be replaced with the backup data. The page will reload automatically after restore."
          style={{ marginBottom: 16 }}
        />
        {restoreTarget?.filename && (
          <div>
            <Text type="secondary">Restoring from: </Text>
            <Text strong>{formatFilename(restoreTarget.filename)}</Text>
          </div>
        )}
        {restoreTarget?.file && (
          <div>
            <Text type="secondary">Restoring from uploaded file: </Text>
            <Text strong>{restoreTarget.file.name}</Text>
          </div>
        )}
      </Modal>

      {/* ── Restore in-progress modal ── */}
      <Modal
        title={<><SyncOutlined spin style={{ color: '#1677ff' }} /> Restoring Database…</>}
        open={restoring}
        footer={null}
        closable={false}
        centered
        width={420}
      >
        <Space direction="vertical" style={{ width: '100%', textAlign: 'center' }} size="large">
          <Text>Please wait while the database is being restored. Do not close this window.</Text>
          <Progress
            percent={Math.round(restoreProgress)}
            status={restoreProgress === 100 ? 'success' : 'active'}
            strokeColor={{ from: '#108ee9', to: '#87d068' }}
          />
          {restoreProgress === 100 && (
            <Text type="success">
              <CheckCircleOutlined /> Restore complete — reloading…
            </Text>
          )}
        </Space>
      </Modal>

        </div>
      </div>

      <ActionStrip
        actions={[
          {
            id: 'back', key: 'Esc', label: 'Back',
            onAction: () => navigate('/'),
          },
          {
            id: 'refresh', key: 'F5', label: 'Refresh',
            onAction: fetchData,
          },
          {
            id: 'backup', key: 'F1', label: 'Backup Now', tone: 'primary',
            disabled: creatingBackup,
            onAction: handleCreateBackup,
          },
        ]}
      />
    </div>
  );
}

// ── Premium stat tile (replaces Ant Statistic for visual consistency) ────────
function StatTile({ tone, icon, label, value }) {
  return (
    <div className={`bkp-stat bkp-stat-${tone}`}>
      <div className="bkp-stat-icon">{icon}</div>
      <div className="bkp-stat-meta">
        <div className="bkp-stat-label">{label}</div>
        <div className="bkp-stat-value">{value}</div>
      </div>
    </div>
  );
}

const BKP_STYLES = `
.bkp-page {
  font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
  -webkit-font-smoothing: antialiased;
}
.bkp-header {
  display: flex; justify-content: space-between; align-items: flex-end;
  gap: 16px; flex-wrap: wrap;
}
.bkp-primary-btn.ant-btn-primary {
  background: linear-gradient(135deg, #0F172A 0%, #1e293b 100%) !important;
  border-color: #0F172A !important;
  border-radius: 10px !important;
  height: 42px !important;
  font-weight: 600 !important;
  box-shadow: 0 6px 16px -6px rgba(15, 23, 42, 0.4) !important;
  transition: all 0.18s ease !important;
}
.bkp-primary-btn.ant-btn-primary:hover {
  background: linear-gradient(135deg, #1e293b 0%, #334155 100%) !important;
  transform: translateY(-1px);
  box-shadow: 0 10px 22px -8px rgba(15, 23, 42, 0.5) !important;
}

/* ── Stat tiles ───────────────────────────────────────── */
.bkp-stats {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: 14px;
  margin-bottom: 22px;
}
@media (max-width: 980px) { .bkp-stats { grid-template-columns: repeat(2, minmax(0, 1fr)); } }
@media (max-width: 560px) { .bkp-stats { grid-template-columns: 1fr; } }
.bkp-stat {
  display: flex; gap: 14px; align-items: center;
  padding: 18px 20px;
  background: var(--bg-panel, #fff);
  border: 1px solid var(--border-subtle, rgba(15, 23, 42, 0.06));
  border-radius: 14px;
  box-shadow: 0 1px 2px rgba(15, 23, 42, 0.03);
  transition: all 0.2s ease;
}
.bkp-stat:hover {
  transform: translateY(-1px);
  box-shadow: 0 8px 20px -8px rgba(15, 23, 42, 0.08);
  border-color: var(--border, rgba(15, 23, 42, 0.10));
}
.bkp-stat-icon {
  flex: 0 0 44px; height: 44px;
  display: inline-flex; align-items: center; justify-content: center;
  border-radius: 11px;
  font-size: 20px;
}
.bkp-stat-indigo  .bkp-stat-icon { background: linear-gradient(135deg, rgba(99, 102, 241, 0.14), rgba(99, 102, 241, 0.06)); color: #6366f1; border: 1px solid rgba(99, 102, 241, 0.18); }
.bkp-stat-emerald .bkp-stat-icon { background: linear-gradient(135deg, rgba(16, 185, 129, 0.14), rgba(16, 185, 129, 0.06)); color: #10b981; border: 1px solid rgba(16, 185, 129, 0.18); }
.bkp-stat-amber   .bkp-stat-icon { background: linear-gradient(135deg, rgba(245, 158, 11, 0.14), rgba(245, 158, 11, 0.06)); color: #f59e0b; border: 1px solid rgba(245, 158, 11, 0.18); }
.bkp-stat-teal    .bkp-stat-icon { background: linear-gradient(135deg, rgba(20, 184, 166, 0.14), rgba(20, 184, 166, 0.06)); color: #14b8a6; border: 1px solid rgba(20, 184, 166, 0.18); }
.bkp-stat-slate   .bkp-stat-icon { background: var(--bg-muted, #f1f5f9); color: var(--fg-tertiary, #94a3b8); border: 1px solid var(--border-subtle, rgba(15, 23, 42, 0.06)); }
.bkp-stat-meta { flex: 1; min-width: 0; }
.bkp-stat-label {
  font-size: 11px; font-weight: 600;
  letter-spacing: 0.1em; text-transform: uppercase;
  color: var(--fg-tertiary, #94a3b8);
  margin-bottom: 4px;
}
.bkp-stat-value {
  font-size: 22px; font-weight: 700;
  color: var(--fg-primary, #0F172A);
  letter-spacing: -0.4px;
  line-height: 1.2;
  font-variant-numeric: tabular-nums;
  word-break: break-word;
}

/* ── Tabs card ────────────────────────────────────────── */
.bkp-tabs-card.ant-card {
  border-radius: 16px !important;
  border: 1px solid var(--border-subtle, rgba(15, 23, 42, 0.06)) !important;
  box-shadow: 0 1px 2px rgba(15, 23, 42, 0.03) !important;
}
.bkp-tabs-card .ant-tabs-nav::before { border-bottom-color: var(--border-subtle, rgba(15, 23, 42, 0.08)) !important; }
.bkp-tabs-card .ant-tabs-tab {
  font-weight: 500 !important;
  padding: 14px 0 !important;
}
.bkp-tabs-card .ant-tabs-tab-active .ant-tabs-tab-btn {
  font-weight: 600 !important;
  color: #0F172A !important;
}
.bkp-tabs-card .ant-tabs-ink-bar { background: #0F172A !important; height: 2px !important; }

/* ── Danger zone — premium treatment ─────────────────── */
.bkp-danger {
  margin-top: 22px;
  padding: 0;
  background: linear-gradient(135deg, rgba(239, 68, 68, 0.04), rgba(220, 38, 38, 0.02));
  border: 1px solid rgba(239, 68, 68, 0.20);
  border-radius: 16px;
  overflow: hidden;
  position: relative;
}
.bkp-danger::before {
  content: '';
  position: absolute; top: 0; left: 0; bottom: 0;
  width: 4px;
  background: linear-gradient(180deg, #ef4444, #b91c1c);
}
.bkp-danger-inner {
  display: flex; align-items: center; gap: 16px;
  padding: 18px 22px 18px 26px;
  flex-wrap: wrap;
}
.bkp-danger-icon {
  flex: 0 0 44px; height: 44px;
  display: inline-flex; align-items: center; justify-content: center;
  border-radius: 11px;
  background: linear-gradient(135deg, rgba(239, 68, 68, 0.14), rgba(239, 68, 68, 0.06));
  color: #dc2626;
  font-size: 22px;
  border: 1px solid rgba(239, 68, 68, 0.20);
}
.bkp-danger-text { flex: 1; min-width: 200px; }
.bkp-danger-eyebrow {
  font-size: 10.5px; font-weight: 700;
  letter-spacing: 0.12em; text-transform: uppercase;
  color: #dc2626;
  margin-bottom: 2px;
}
.bkp-danger-title {
  font-size: 15px; font-weight: 600;
  color: var(--fg-primary, #0F172A);
  margin-bottom: 2px;
}
.bkp-danger-sub {
  font-size: 12.5px; color: var(--fg-secondary, #64748b);
  line-height: 1.5;
}
.bkp-danger-btn.ant-btn {
  border-radius: 8px !important;
  font-weight: 500 !important;
  height: 36px !important;
}

/* ── List head (refresh row) ─────────────────────────── */
.bkp-list-head {
  display: flex; justify-content: space-between; align-items: center;
  gap: 12px; flex-wrap: wrap;
  padding-bottom: 4px;
}
.bkp-list-head-title {
  font-size: 16px; font-weight: 700; letter-spacing: -0.2px;
  color: var(--fg-primary, #0F172A);
}
.bkp-list-head-sub {
  font-size: 12.5px; color: var(--fg-tertiary, #94a3b8);
  margin-top: 2px;
}

/* ── Filename monospace (replaces ugly Courier fallback) ── */
.bkp-filename {
  font-family: ui-monospace, 'JetBrains Mono', 'SF Mono', Menlo, Consolas, 'Liberation Mono', monospace;
  font-size: 11.5px;
  font-weight: 400;
  letter-spacing: 0.01em;
  color: var(--fg-tertiary, #94a3b8);
  font-variant-numeric: tabular-nums;
  user-select: all;
}

/* ── Action icon buttons in rows ─────────────────────── */
.bkp-row-actions {
  display: inline-flex; gap: 6px; align-items: center;
}
.bkp-icon-btn {
  display: inline-flex; align-items: center; justify-content: center;
  width: 32px; height: 32px;
  background: var(--bg-panel, #fff);
  border: 1px solid var(--border-subtle, rgba(15, 23, 42, 0.08));
  border-radius: 8px;
  color: var(--fg-secondary, #64748b);
  font-size: 14px;
  cursor: pointer;
  transition: all 0.15s ease;
  padding: 0;
}
.bkp-icon-btn:hover {
  border-color: rgba(15, 23, 42, 0.18);
  color: var(--fg-primary, #0F172A);
  background: var(--bg-muted, #f8fafc);
  transform: translateY(-1px);
  box-shadow: 0 2px 6px -2px rgba(15, 23, 42, 0.10);
}
.bkp-icon-btn-accent {
  background: rgba(99, 102, 241, 0.06);
  border-color: rgba(99, 102, 241, 0.20);
  color: #6366f1;
}
.bkp-icon-btn-accent:hover {
  background: rgba(99, 102, 241, 0.10);
  border-color: rgba(99, 102, 241, 0.35);
  color: #4f46e5;
}
.bkp-icon-btn-danger {
  background: rgba(239, 68, 68, 0.04);
  border-color: rgba(239, 68, 68, 0.18);
  color: #dc2626;
}
.bkp-icon-btn-danger:hover {
  background: rgba(239, 68, 68, 0.10);
  border-color: rgba(239, 68, 68, 0.35);
  color: #b91c1c;
}

/* ── Polish the inner table ──────────────────────────── */
.bkp-tabs-card .ant-table-thead > tr > th {
  background: var(--bg-muted, #f8fafc) !important;
  font-size: 11px !important;
  font-weight: 700 !important;
  letter-spacing: 0.08em !important;
  text-transform: uppercase !important;
  color: var(--fg-secondary, #64748b) !important;
  border-bottom-color: var(--border-subtle, rgba(15, 23, 42, 0.06)) !important;
}
.bkp-tabs-card .ant-table-tbody > tr > td {
  border-bottom-color: var(--border-subtle, rgba(15, 23, 42, 0.05)) !important;
}
.bkp-tabs-card .ant-table-tbody > tr:hover > td {
  background: var(--bg-muted, #f8fafc) !important;
}
`;
