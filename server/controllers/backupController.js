const path = require('path');
const fs = require('fs');
const multer = require('multer');
const {
  sequelize, Role, User, Party, Category, Product,
  PurchaseBill, PurchaseBillItem, SalesBill, SalesBillItem,
  PaymentReceipt, PaymentSplit, StockLedger,
  LedgerAccount, LedgerEntry, BarcodeSettings, SystemSettings,
} = require('../models');

const BACKUPS_DIR = path.join(__dirname, '../backups');
const SETTINGS_FILE = path.join(BACKUPS_DIR, 'backup-settings.json');

// Ensure backups directory exists
if (!fs.existsSync(BACKUPS_DIR)) fs.mkdirSync(BACKUPS_DIR, { recursive: true });

// ── Settings helpers ──────────────────────────────────────────────────────────

const DEFAULT_SETTINGS = {
  enabled: false,
  frequency: 'daily',   // hourly | daily | weekly | monthly
  time: '02:00',        // HH:MM  (used by daily / weekly / monthly)
  dayOfWeek: 0,         // 0=Sun … 6=Sat  (weekly)
  dayOfMonth: 1,        // 1-28           (monthly)
  maxBackups: 10,
  lastBackup: null,
  lastBackupStatus: null,
  lastBackupFile: null,
  lastBackupError: null,
};

function getSettings() {
  try {
    if (fs.existsSync(SETTINGS_FILE))
      return { ...DEFAULT_SETTINGS, ...JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8')) };
  } catch {}
  return { ...DEFAULT_SETTINGS };
}

function saveSettings(settings) {
  fs.writeFileSync(SETTINGS_FILE, JSON.stringify(settings, null, 2));
}

// ── Model ordering ────────────────────────────────────────────────────────────
// INSERT order: parents before children (FK-safe)
const INSERT_ORDER = [
  { name: 'Role',            model: Role },
  { name: 'User',            model: User },
  { name: 'SystemSettings',  model: SystemSettings },
  { name: 'BarcodeSettings', model: BarcodeSettings },
  { name: 'Party',           model: Party },
  { name: 'Category',        model: Category },
  { name: 'Product',         model: Product },
  { name: 'PurchaseBill',    model: PurchaseBill },
  { name: 'PurchaseBillItem',model: PurchaseBillItem },
  { name: 'SalesBill',       model: SalesBill },
  { name: 'SalesBillItem',   model: SalesBillItem },
  { name: 'PaymentReceipt',  model: PaymentReceipt },
  { name: 'PaymentSplit',    model: PaymentSplit },
  { name: 'StockLedger',     model: StockLedger },
  { name: 'LedgerAccount',   model: LedgerAccount },
  { name: 'LedgerEntry',     model: LedgerEntry },
];

// ── Utilities ─────────────────────────────────────────────────────────────────

function formatBytes(bytes) {
  if (bytes < 1024)           return `${bytes} B`;
  if (bytes < 1024 * 1024)   return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

function generateFilename(type = 'manual') {
  const ts = new Date().toISOString().replace(/[:.]/g, '-').replace('T', '_').slice(0, 19);
  return `backup_${type}_${ts}.json`;
}

function getBackupFiles() {
  if (!fs.existsSync(BACKUPS_DIR)) return [];
  return fs.readdirSync(BACKUPS_DIR)
    .filter(f => f.startsWith('backup_') && f.endsWith('.json'))
    .map(f => {
      const stats = fs.statSync(path.join(BACKUPS_DIR, f));
      const type = f.includes('_auto_') ? 'auto' : 'manual';
      return {
        filename: f,
        type,
        size: stats.size,
        sizeFormatted: formatBytes(stats.size),
        createdAt: stats.birthtime,
      };
    })
    .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
}

function applyRetentionPolicy(maxBackups) {
  const files = getBackupFiles();
  if (files.length > maxBackups) {
    files.slice(maxBackups).forEach(f => {
      try { fs.unlinkSync(path.join(BACKUPS_DIR, f.filename)); } catch {}
    });
  }
}

// ── Core: collect all data ────────────────────────────────────────────────────

async function collectAllData() {
  const data = {};
  let totalRecords = 0;
  for (const { name, model } of INSERT_ORDER) {
    try {
      const rows = await model.findAll({ raw: true });
      data[name] = rows;
      totalRecords += rows.length;
    } catch {
      data[name] = [];
    }
  }
  return { data, totalRecords };
}

function buildBackupPayload(data, totalRecords, type = 'manual') {
  return {
    version: '1.0',
    appVersion: '1.0.0',
    type,
    createdAt: new Date().toISOString(),
    totalRecords,
    recordCounts: Object.fromEntries(
      Object.entries(data).map(([k, v]) => [k, Array.isArray(v) ? v.length : 0])
    ),
    data,
  };
}

// ── Core: restore ─────────────────────────────────────────────────────────────

async function performRestore(backupData) {
  const tableList = INSERT_ORDER
    .map(({ model }) => `"${model.getTableName()}"`)
    .join(', ');

  // Truncate all tables at once with CASCADE (no special permissions needed,
  // user owns all tables). RESTART IDENTITY resets sequences automatically.
  await sequelize.query(
    `TRUNCATE TABLE ${tableList} RESTART IDENTITY CASCADE`
  );

  // Re-insert in FK-safe order
  for (const { name, model } of INSERT_ORDER) {
    const records = backupData[name];
    if (!records || !records.length) continue;

    // For Category: sort so parent (null parent_category_id) comes first
    const rows = name === 'Category'
      ? [...records].sort((a, b) => {
          if (!a.parent_category_id && b.parent_category_id) return -1;
          if (a.parent_category_id && !b.parent_category_id) return 1;
          return 0;
        })
      : records;

    // Insert in chunks of 500 to avoid query size limits
    const CHUNK = 500;
    for (let i = 0; i < rows.length; i += CHUNK) {
      await model.bulkCreate(rows.slice(i, i + CHUNK), {
        updateOnDuplicate: Object.keys(model.rawAttributes),
      });
    }
  }

  // Reset all sequences to max(id)+1 so inserts after restore don't conflict
  for (const { model } of INSERT_ORDER) {
    const tableName = model.getTableName();
    const pkAttr = Object.entries(model.rawAttributes).find(([, a]) => a.primaryKey);
    if (!pkAttr) continue;
    const pkCol = pkAttr[1].field || pkAttr[0];
    try {
      await sequelize.query(
        `SELECT setval(pg_get_serial_sequence('${tableName}', '${pkCol}'),
          COALESCE((SELECT MAX("${pkCol}") FROM "${tableName}"), 0) + 1, false)`
      );
    } catch { /* non-serial PKs — ignore */ }
  }
}

// ── Exported controller functions ─────────────────────────────────────────────

/** POST /api/backup/create  — create backup, save to disk, stream to browser */
exports.createBackup = async (req, res) => {
  try {
    const { data, totalRecords } = await collectAllData();
    const payload = buildBackupPayload(data, totalRecords, 'manual');
    const filename = generateFilename('manual');
    const filepath = path.join(BACKUPS_DIR, filename);

    fs.writeFileSync(filepath, JSON.stringify(payload, null, 2));
    applyRetentionPolicy(getSettings().maxBackups || 10);

    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.sendFile(filepath);
  } catch (err) {
    console.error('Backup error:', err);
    res.status(500).json({ error: 'Backup failed: ' + err.message });
  }
};

/** GET /api/backup/list */
exports.listBackups = (req, res) => {
  try {
    const backups = getBackupFiles();
    const settings = getSettings();
    const totalSize = backups.reduce((s, f) => s + f.size, 0);
    res.json({ backups, settings, totalSize, totalSizeFormatted: formatBytes(totalSize) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

/** GET /api/backup/download/:filename */
exports.downloadBackup = (req, res) => {
  const { filename } = req.params;
  if (!filename.startsWith('backup_') || !filename.endsWith('.json'))
    return res.status(400).json({ error: 'Invalid filename' });

  const filepath = path.join(BACKUPS_DIR, filename);
  if (!fs.existsSync(filepath))
    return res.status(404).json({ error: 'Backup file not found' });

  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.sendFile(filepath);
};

/** DELETE /api/backup/:filename */
exports.deleteBackup = (req, res) => {
  const { filename } = req.params;
  if (!filename.startsWith('backup_') || !filename.endsWith('.json'))
    return res.status(400).json({ error: 'Invalid filename' });

  const filepath = path.join(BACKUPS_DIR, filename);
  if (!fs.existsSync(filepath))
    return res.status(404).json({ error: 'Backup file not found' });

  fs.unlinkSync(filepath);
  res.json({ success: true });
};

/** POST /api/backup/restore
 *  Body: multipart file upload  OR  { filename: 'backup_xxx.json' }
 */
exports.restoreBackup = async (req, res) => {
  try {
    let backupPayload;

    if (req.file) {
      backupPayload = JSON.parse(req.file.buffer.toString('utf8'));
    } else if (req.body && req.body.filename) {
      const { filename } = req.body;
      if (!filename.startsWith('backup_') || !filename.endsWith('.json'))
        return res.status(400).json({ error: 'Invalid filename' });
      const filepath = path.join(BACKUPS_DIR, filename);
      if (!fs.existsSync(filepath))
        return res.status(404).json({ error: 'Backup file not found' });
      backupPayload = JSON.parse(fs.readFileSync(filepath, 'utf8'));
    } else {
      return res.status(400).json({ error: 'Provide a backup file or filename' });
    }

    if (!backupPayload.version || !backupPayload.data)
      return res.status(400).json({ error: 'Invalid backup format' });

    await performRestore(backupPayload.data);

    res.json({
      success: true,
      message: 'Database restored successfully',
      restoredAt: new Date().toISOString(),
      totalRecords: backupPayload.totalRecords,
    });
  } catch (err) {
    console.error('Restore error:', err);
    res.status(500).json({ error: 'Restore failed: ' + err.message });
  }
};

/** GET /api/backup/settings */
exports.getAutoBackupSettings = (req, res) => {
  res.json(getSettings());
};

/** PUT /api/backup/settings */
exports.updateAutoBackupSettings = (req, res) => {
  try {
    const updated = { ...getSettings(), ...req.body };
    saveSettings(updated);
    res.json(updated);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

// ── Auto-backup scheduler ─────────────────────────────────────────────────────

/** Called by scheduler — saves to disk only (no HTTP response) */
exports.runAutoBackup = async () => {
  try {
    const { data, totalRecords } = await collectAllData();
    const payload = buildBackupPayload(data, totalRecords, 'auto');
    const filename = generateFilename('auto');
    const filepath = path.join(BACKUPS_DIR, filename);

    fs.writeFileSync(filepath, JSON.stringify(payload, null, 2));

    const settings = getSettings();
    settings.lastBackup = new Date().toISOString();
    settings.lastBackupStatus = 'success';
    settings.lastBackupFile = filename;
    settings.lastBackupError = null;
    applyRetentionPolicy(settings.maxBackups || 10);
    saveSettings(settings);

    console.log(`[Auto-backup] Created: ${filename}`);
    return { success: true, filename };
  } catch (err) {
    console.error('[Auto-backup] Failed:', err.message);
    const settings = getSettings();
    settings.lastBackup = new Date().toISOString();
    settings.lastBackupStatus = 'failed';
    settings.lastBackupError = err.message;
    saveSettings(settings);
    return { success: false, error: err.message };
  }
};

/** Determine whether a backup should run right now based on settings */
function shouldRunNow(settings) {
  if (!settings.enabled) return false;

  const now = new Date();
  const last = settings.lastBackup ? new Date(settings.lastBackup) : null;
  const [h, m] = (settings.time || '02:00').split(':').map(Number);

  switch (settings.frequency) {
    case 'hourly':
      return !last || (now - last) >= 60 * 60 * 1000;

    case 'daily': {
      const scheduled = new Date(now);
      scheduled.setHours(h, m, 0, 0);
      return now >= scheduled && (!last || last < scheduled);
    }

    case 'weekly': {
      const scheduled = new Date(now);
      scheduled.setHours(h, m, 0, 0);
      const diff = (settings.dayOfWeek - now.getDay() + 7) % 7;
      scheduled.setDate(scheduled.getDate() - (diff === 0 ? 0 : 7 - diff));
      return now >= scheduled && (!last || last < scheduled);
    }

    case 'monthly': {
      const scheduled = new Date(now.getFullYear(), now.getMonth(), settings.dayOfMonth || 1, h, m, 0);
      return now >= scheduled && (!last || last < scheduled);
    }

    default:
      return false;
  }
}

/** Start the scheduler — call once after server is ready */
exports.initScheduler = () => {
  // Check every 60 seconds
  setInterval(async () => {
    try {
      const settings = getSettings();
      if (shouldRunNow(settings)) await exports.runAutoBackup();
    } catch (err) {
      console.error('[Auto-backup scheduler] Error:', err.message);
    }
  }, 60 * 1000);

  console.log('[Auto-backup] Scheduler started');
};

// Export helpers for routes
exports.getSettings = getSettings;
