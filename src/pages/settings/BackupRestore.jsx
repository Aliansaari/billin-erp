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
  SyncOutlined,
} from '@ant-design/icons';
import dayjs from 'dayjs';
import relativeTime from 'dayjs/plugin/relativeTime';
import { backupAPI } from '../../api';

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
  const match = filename.match(/backup_(?:manual|auto)_(\d{4})-(\d{2})-(\d{2})_(\d{2})-(\d{2})-(\d{2})\.json/);
  if (!match) return filename;
  const [, yr, mo, dy, hr, mn] = match;
  return dayjs(`${yr}-${mo}-${dy}T${hr}:${mn}`).format('MMM D, YYYY  h:mm A');
}

// ── Main Component ────────────────────────────────────────────────────────────

export default function BackupRestore() {
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
      const filename = match ? match[1] : `backup_manual_${Date.now()}.json`;
      downloadBlob(res.data, filename);
      message.success('Backup created and downloaded successfully');
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
        <Space direction="vertical" size={0}>
          <Text strong style={{ fontSize: 14 }}>{formatFilename(filename)}</Text>
          <Text type="secondary" style={{ fontSize: 11, fontFamily: 'monospace' }}>{filename}</Text>
        </Space>
      ),
    },
    {
      title: 'Type',
      dataIndex: 'type',
      key: 'type',
      width: 90,
      render: (type) =>
        type === 'auto'
          ? <Tag color="blue" icon={<ClockCircleOutlined />}>Auto</Tag>
          : <Tag color="green" icon={<ThunderboltOutlined />}>Manual</Tag>,
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
        <Space>
          <Tooltip title="Download">
            <Button
              size="small"
              icon={<DownloadOutlined />}
              onClick={() => handleDownload(row.filename)}
            />
          </Tooltip>
          <Tooltip title="Restore this backup">
            <Button
              size="small"
              icon={<SyncOutlined />}
              type="primary"
              ghost
              onClick={() => setRestoreTarget({ filename: row.filename })}
            />
          </Tooltip>
          <Tooltip title="Delete">
            <Button
              size="small"
              danger
              icon={<DeleteOutlined />}
              onClick={() => setDeleteTarget(row.filename)}
            />
          </Tooltip>
        </Space>
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

          {/* Action row */}
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 12 }}>
            <div>
              <Title level={5} style={{ margin: 0 }}>Saved Backups</Title>
              <Text type="secondary">{backups.length} backup{backups.length !== 1 ? 's' : ''} · {totalSize} total</Text>
            </div>
            <Space>
              <Button icon={<ReloadOutlined />} onClick={fetchData} loading={loading}>Refresh</Button>
              <Button
                type="primary"
                icon={<CloudDownloadOutlined />}
                loading={creatingBackup}
                onClick={handleCreateBackup}
                size="large"
              >
                Create Backup Now
              </Button>
            </Space>
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

              <Card title="How it works" bordered={false} size="small">
                <Paragraph style={{ fontSize: 13, color: '#555' }}>
                  Automatic backups run on the server in the background. Backup files are stored
                  in <Text code>server/backups/</Text> and can be downloaded from the Backup History tab.
                  The server checks every 60 seconds whether a scheduled backup is due.
                </Paragraph>
                <Paragraph style={{ fontSize: 13, color: '#555', marginBottom: 0 }}>
                  Manual backups download the file directly to your browser.
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
                  accept=".json"
                  beforeUpload={(file) => { setUploadFile(file); return false; }}
                  onRemove={() => setUploadFile(null)}
                  maxCount={1}
                  fileList={uploadFile ? [{ uid: '-1', name: uploadFile.name, status: 'done' }] : []}
                >
                  <Button icon={<FolderOpenOutlined />} block>
                    Select Backup File (.json)
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
    <div style={{ padding: '0 4px' }}>

      {/* Page header */}
      <div style={{ marginBottom: 24 }}>
        <Title level={3} style={{ margin: 0 }}>
          <DatabaseOutlined style={{ marginRight: 10, color: '#1677ff' }} />
          Backup &amp; Recovery
        </Title>
        <Text type="secondary">
          Create, schedule, and restore full database backups — all data included.
        </Text>
      </div>

      {/* Stats row */}
      <Row gutter={[16, 16]} style={{ marginBottom: 24 }}>
        <Col xs={12} sm={6}>
          <Card bordered={false} style={{ background: '#f0f7ff', borderRadius: 12 }}>
            <Statistic
              title="Total Backups"
              value={backups.length}
              prefix={<DatabaseOutlined style={{ color: '#1677ff' }} />}
            />
          </Card>
        </Col>
        <Col xs={12} sm={6}>
          <Card bordered={false} style={{ background: '#f6ffed', borderRadius: 12 }}>
            <Statistic
              title="Storage Used"
              value={totalSize}
              prefix={<FolderOpenOutlined style={{ color: '#52c41a' }} />}
            />
          </Card>
        </Col>
        <Col xs={12} sm={6}>
          <Card bordered={false} style={{ background: '#fffbe6', borderRadius: 12 }}>
            <Statistic
              title="Last Backup"
              value={lastBackupTime}
              prefix={<ClockCircleOutlined style={{ color: '#faad14' }} />}
            />
          </Card>
        </Col>
        <Col xs={12} sm={6}>
          <Card bordered={false} style={{ background: settings.enabled ? '#f6ffed' : '#fafafa', borderRadius: 12 }}>
            <Statistic
              title="Auto-Backup"
              value={settings.enabled ? `${(settings.frequency || 'daily').charAt(0).toUpperCase() + (settings.frequency || 'daily').slice(1)}` : 'Disabled'}
              prefix={
                settings.enabled
                  ? <CheckCircleOutlined style={{ color: '#52c41a' }} />
                  : <CloseCircleOutlined style={{ color: '#d9d9d9' }} />
              }
            />
          </Card>
        </Col>
      </Row>

      {/* Main content tabs */}
      <Card bordered={false} style={{ borderRadius: 12 }}>
        <Tabs activeKey={activeTab} onChange={setActiveTab} items={tabItems} size="large" />
      </Card>

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
  );
}
