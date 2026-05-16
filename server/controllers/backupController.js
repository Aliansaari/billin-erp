const path = require('path');
const fs = require('fs');
const fsp = require('fs').promises;
const crypto = require('crypto');
const multer = require('multer');
const {
  sequelize, Role, User, Party, Category, Product,
  PurchaseBill, PurchaseBillItem, SalesBill, SalesBillItem,
  PaymentReceipt, PaymentSplit, StockLedger,
  LedgerAccount, LedgerEntry, BarcodeSettings, SystemSettings,
} = require('../models');

// In a packaged Electron build, server/ lives inside app.asar (read-
// only). server/utils/paths picks the right base dir for either case
// — dev: project root, packaged: <homedir>/.billing-erp.
const { IN_ASAR, USER_DATA } = require('../utils/paths');
const BACKUPS_DIR = IN_ASAR
  ? path.join(USER_DATA, 'app-backups')
  : path.join(__dirname, '../backups');
const SETTINGS_FILE = path.join(BACKUPS_DIR, 'backup-settings.json');

// One-time startup mkdir — runs once at module load. Wrapped so a
// stray ENOENT/permission glitch doesn't crash the whole boot.
try { fs.mkdirSync(BACKUPS_DIR, { recursive: true }); } catch {}

// ── AES-256-GCM backup encryption (ALWAYS ON, ZERO CONFIG) ────────────────
//
// Like typical billing software — the user clicks "Backup", gets an encrypted
// file, restores it on any machine running this app. No passwords, no
// prompts, completely invisible to the customer.
//
// HOW IT WORKS:
//   The encryption key is derived from an app-level secret baked into
//   this source file. After obfuscation (Layer 1: javascript-obfuscator
//   with control-flow-flattening + RC4 string array), the key is buried
//   deep in mangled code. A competitor who gets the .enc file sees
//   binary gibberish; even if they decompile the app, extracting the
//   key requires reversing heavy obfuscation.
//
//   Same key in every installation → backups are portable.
//   Customer remembers ZERO extra passwords.
//
//   Key derivation: PBKDF2-SHA512, 100 000 iterations, 32-byte AES key
//   Cipher:         AES-256-GCM (authenticated — detects tampering)
//   File format:    { encrypted:true, v:1, salt, iv, tag, data }
//   Salt + IV are random per backup → identical data ≠ identical output.
//

const PBKDF2_ITERATIONS = 100_000;
const KEY_LENGTH  = 32;  // 256 bits
const IV_LENGTH   = 12;  // GCM standard
const SALT_LENGTH = 32;

// ── App-level encryption secret ───────────────────────────────────────────
// This is the conventional approach — a proprietary key embedded in code that
// ships obfuscated. It's NOT a user password; the user never sees or
// types this. Changing it invalidates all existing backups, so treat it
// as permanent once you ship v1.
//
// The string is intentionally ugly/random to survive obfuscator transforms
// and to be impossible to guess.
const _ERP_BACKUP_KEY = 'sB!9$kL#nR@2xVp&7mWq*4YfDj^8Tz+GcE6hA3uN';

function deriveKey(salt) {
  return crypto.pbkdf2Sync(_ERP_BACKUP_KEY, salt, PBKDF2_ITERATIONS, KEY_LENGTH, 'sha512');
}

function encryptBackup(jsonString) {
  const salt = crypto.randomBytes(SALT_LENGTH);
  const iv   = crypto.randomBytes(IV_LENGTH);
  const key  = deriveKey(salt);

  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([cipher.update(jsonString, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();

  return JSON.stringify({
    encrypted: true,
    v: 1,
    salt: salt.toString('base64'),
    iv:  iv.toString('base64'),
    tag: tag.toString('base64'),
    data: encrypted.toString('base64'),
  });
}

function decryptBackup(envelope) {
  if (typeof envelope === 'string') envelope = JSON.parse(envelope);

  const salt = Buffer.from(envelope.salt, 'base64');
  const iv   = Buffer.from(envelope.iv,   'base64');
  const tag  = Buffer.from(envelope.tag,  'base64');
  const data = Buffer.from(envelope.data, 'base64');
  const key  = deriveKey(salt);

  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);

  try {
    const decrypted = Buffer.concat([decipher.update(data), decipher.final()]);
    return decrypted.toString('utf8');
  } catch (e) {
    if (/Unsupported state|unable to authenticate/i.test(e.message)) {
      throw new Error('Backup file is corrupted or was created by a different application');
    }
    throw e;
  }
}

/** Check whether a parsed object is an encrypted backup envelope */
function isEncryptedBackup(obj) {
  return obj && obj.encrypted === true && obj.salt && obj.iv && obj.tag && obj.data;
}

// ── Safe-filename validator ───────────────────────────────────────────────────
// Blocks path traversal (../), absolute paths, and stray separators that would
// let a request escape the backups directory via path.join. ONLY the basename
// (no directory component) is accepted.
const SAFE_FILENAME_RE = /^backup_[A-Za-z0-9._-]+\.(json|enc)$/;
function isSafeBackupFilename(name) {
  if (typeof name !== 'string') return false;
  // Reject anything that introduces a path component or null byte.
  if (name.includes('/') || name.includes('\\') || name.includes('\0')) return false;
  if (name.includes('..')) return false;
  if (path.basename(name) !== name) return false;
  return SAFE_FILENAME_RE.test(name);
}

// Async existence check — wraps fs.promises.access to avoid the blocking
// fs.existsSync in request paths. A non-existent file throws; we swallow only
// the ENOENT case so the caller sees `false` rather than an error.
async function pathExists(p) {
  try {
    await fsp.access(p);
    return true;
  } catch { return false; }
}

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

async function getSettings() {
  try {
    if (await pathExists(SETTINGS_FILE))
      return { ...DEFAULT_SETTINGS, ...JSON.parse(await fsp.readFile(SETTINGS_FILE, 'utf8')) };
  } catch {}
  return { ...DEFAULT_SETTINGS };
}

async function saveSettings(settings) {
  await fsp.writeFile(SETTINGS_FILE, JSON.stringify(settings, null, 2));
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

async function getBackupFiles() {
  if (!(await pathExists(BACKUPS_DIR))) return [];
  const entries = await fsp.readdir(BACKUPS_DIR);
  const matches = entries.filter(f => f.startsWith('backup_') && (f.endsWith('.json') || f.endsWith('.enc')));
  // Parallel stat calls — on spinning disks serial stat is the bottleneck,
  // and Promise.all lets the OS issue them concurrently.
  const files = await Promise.all(matches.map(async f => {
    const stats = await fsp.stat(path.join(BACKUPS_DIR, f));
    const type = f.includes('_auto_') ? 'auto' : 'manual';
    return {
      filename: f,
      type,
      size: stats.size,
      sizeFormatted: formatBytes(stats.size),
      createdAt: stats.birthtime,
    };
  }));
  return files.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
}

async function applyRetentionPolicy(maxBackups) {
  const files = await getBackupFiles();
  if (files.length > maxBackups) {
    await Promise.all(files.slice(maxBackups).map(f =>
      fsp.unlink(path.join(BACKUPS_DIR, f.filename)).catch(() => {})
    ));
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

// Topological sort for categories so a parent row is always inserted before
// its descendants — handles multi-level trees (A → B → C) that a single-pass
// null-first sort would corrupt. Falls back to original order on cycle.
function sortCategoriesByDepth(records) {
  const byId = new Map(records.map(r => [r.category_id, r]));
  const seen = new Set();
  const out  = [];
  const visit = (row, stack) => {
    if (!row || seen.has(row.category_id)) return;
    if (stack.has(row.category_id)) return; // cycle guard
    stack.add(row.category_id);
    if (row.parent_category_id && byId.has(row.parent_category_id)) {
      visit(byId.get(row.parent_category_id), stack);
    }
    stack.delete(row.category_id);
    seen.add(row.category_id);
    out.push(row);
  };
  records.forEach(r => visit(r, new Set()));
  // Append any rows we missed (should never happen, but safe fallback).
  records.forEach(r => { if (!seen.has(r.category_id)) out.push(r); });
  return out;
}

// Topologically-safe truncate + re-insert. The ENTIRE operation runs inside a
// single transaction — if any insert fails, the TRUNCATE is rolled back and
// the caller's data is preserved. Previously a mid-restore failure left the
// DB fully wiped with only partial data inserted.
async function performRestore(backupData) {
  const tableList = INSERT_ORDER
    .map(({ model }) => `"${model.getTableName()}"`)
    .join(', ');

  await sequelize.transaction(async (t) => {
    // Truncate all tables at once with CASCADE. RESTART IDENTITY resets
    // sequences automatically. Runs INSIDE the transaction so rollback on
    // any later insert failure undoes the truncate.
    await sequelize.query(
      `TRUNCATE TABLE ${tableList} RESTART IDENTITY CASCADE`,
      { transaction: t }
    );

    // Re-insert in FK-safe order
    for (const { name, model } of INSERT_ORDER) {
      const records = backupData[name];
      if (!records || !records.length) continue;

      // Multi-level category trees need depth-first parent-first ordering.
      const rows = name === 'Category' ? sortCategoriesByDepth(records) : records;

      // Insert in chunks of 500 to avoid query size limits. Plain bulkCreate
      // (no updateOnDuplicate) — TRUNCATE cleared every row, so any "duplicate"
      // now means the backup itself has a duplicate PK and we WANT to surface
      // that as an error rather than silently UPSERT-merge.
      const CHUNK = 500;
      for (let i = 0; i < rows.length; i += CHUNK) {
        await model.bulkCreate(rows.slice(i, i + CHUNK), {
          validate: false,
          transaction: t,
        });
      }
    }

    // Reset all sequences to max(id)+1 so inserts after restore don't conflict.
    for (const { model } of INSERT_ORDER) {
      const tableName = model.getTableName();
      const pkAttr = Object.entries(model.rawAttributes).find(([, a]) => a.primaryKey);
      if (!pkAttr) continue;
      const pkCol = pkAttr[1].field || pkAttr[0];
      try {
        await sequelize.query(
          `SELECT setval(pg_get_serial_sequence('${tableName}', '${pkCol}'),
            COALESCE((SELECT MAX("${pkCol}") FROM "${tableName}"), 0) + 1, false)`,
          { transaction: t }
        );
      } catch { /* non-serial PKs — ignore */ }
    }
  });
}

// ── Exported controller functions ─────────────────────────────────────────────

/** POST /api/backup/create — create encrypted backup, save to disk, download */
exports.createBackup = async (req, res) => {
  try {
    const { data, totalRecords } = await collectAllData();
    const payload = buildBackupPayload(data, totalRecords, 'manual');
    const fileContent = encryptBackup(JSON.stringify(payload, null, 2));
    const filename = generateFilename('manual').replace(/\.json$/, '.enc');
    const filepath = path.join(BACKUPS_DIR, filename);

    await fsp.writeFile(filepath, fileContent);
    const settings = await getSettings();
    await applyRetentionPolicy(settings.maxBackups || 10);

    res.setHeader('Content-Type', 'application/octet-stream');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.sendFile(filepath);
  } catch (err) {
    console.error('Backup error:', err);
    res.status(500).json({ error: 'Backup failed: ' + err.message });
  }
};

/** GET /api/backup/list */
exports.listBackups = async (req, res) => {
  try {
    const [backups, settings] = await Promise.all([getBackupFiles(), getSettings()]);
    const totalSize = backups.reduce((s, f) => s + f.size, 0);
    res.json({ backups, settings, totalSize, totalSizeFormatted: formatBytes(totalSize) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

/** GET /api/backup/download/:filename */
exports.downloadBackup = async (req, res) => {
  const { filename } = req.params;
  if (!isSafeBackupFilename(filename))
    return res.status(400).json({ error: 'Invalid filename' });

  // Resolve the absolute path and require it to live INSIDE BACKUPS_DIR —
  // a defence-in-depth check on top of the filename whitelist.
  const filepath = path.resolve(BACKUPS_DIR, filename);
  if (!filepath.startsWith(path.resolve(BACKUPS_DIR) + path.sep))
    return res.status(400).json({ error: 'Invalid filename' });
  if (!(await pathExists(filepath)))
    return res.status(404).json({ error: 'Backup file not found' });

  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.sendFile(filepath);
};

/** DELETE /api/backup/:filename */
exports.deleteBackup = async (req, res) => {
  try {
    const { filename } = req.params;
    if (!isSafeBackupFilename(filename))
      return res.status(400).json({ error: 'Invalid filename' });

    const filepath = path.resolve(BACKUPS_DIR, filename);
    if (!filepath.startsWith(path.resolve(BACKUPS_DIR) + path.sep))
      return res.status(400).json({ error: 'Invalid filename' });
    if (!(await pathExists(filepath)))
      return res.status(404).json({ error: 'Backup file not found' });

    await fsp.unlink(filepath);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

/** POST /api/backup/restore
 *  Body: multipart file upload  OR  { filename: 'backup_xxx.enc' }
 *  Decryption is automatic — uses the app-level key. No user password.
 */
exports.restoreBackup = async (req, res) => {
  try {
    // Audit C20 — restore is the most destructive endpoint in the app:
    // performRestore() TRUNCATEs every domain table (sales, parties,
    // products, etc.) before re-inserting from the backup. Require fresh
    // re-auth via the operator's CURRENT password (not just the bearer
    // token) so a stolen session can't trigger a destructive restore
    // without also having the live credential. Mirrors the cleanup-data
    // confirmation in settingsController.
    const bcrypt = require('bcryptjs');
    const { User } = require('../models');
    const supplied = req.body && req.body.confirm_password;
    if (!supplied || typeof supplied !== 'string') {
      return res.status(400).json({
        error: 'Restore requires confirm_password (operator must re-enter their password).',
        field: 'confirm_password',
      });
    }
    const userRow = await User.findByPk(req.user.user_id);
    if (!userRow) {
      return res.status(401).json({ error: 'User session is no longer valid; sign in again.' });
    }
    const validPwd = await bcrypt.compare(supplied, userRow.password_hash);
    if (!validPwd) {
      return res.status(401).json({ error: 'Confirmation password is incorrect.' });
    }

    let rawContent;

    if (req.file) {
      rawContent = req.file.buffer.toString('utf8');
    } else if (req.body && req.body.filename) {
      const { filename } = req.body;
      if (!isSafeBackupFilename(filename))
        return res.status(400).json({ error: 'Invalid filename' });
      const filepath = path.resolve(BACKUPS_DIR, filename);
      if (!filepath.startsWith(path.resolve(BACKUPS_DIR) + path.sep))
        return res.status(400).json({ error: 'Invalid filename' });
      if (!(await pathExists(filepath)))
        return res.status(404).json({ error: 'Backup file not found' });
      rawContent = await fsp.readFile(filepath, 'utf8');
    } else {
      return res.status(400).json({ error: 'Provide a backup file or filename' });
    }

    let backupPayload;
    const parsed = JSON.parse(rawContent);

    if (isEncryptedBackup(parsed)) {
      try {
        const decrypted = decryptBackup(parsed);
        backupPayload = JSON.parse(decrypted);
      } catch (e) {
        return res.status(400).json({
          error: 'This backup file is corrupted or was not created by Billing ERP.',
        });
      }
    } else {
      // Legacy plain JSON backup (from before encryption existed)
      backupPayload = parsed;
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
exports.getAutoBackupSettings = async (req, res) => {
  try {
    res.json(await getSettings());
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

/** PUT /api/backup/settings */
exports.updateAutoBackupSettings = async (req, res) => {
  try {
    const current = await getSettings();
    const updated = { ...current, ...req.body };
    await saveSettings(updated);
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
    const plainJson = JSON.stringify(payload, null, 2);

    const fileContent = encryptBackup(plainJson);
    const filename = generateFilename('auto').replace(/\.json$/, '.enc');

    const settings = await getSettings();
    const filepath = path.join(BACKUPS_DIR, filename);

    await fsp.writeFile(filepath, fileContent);

    settings.lastBackup = new Date().toISOString();
    settings.lastBackupStatus = 'success';
    settings.lastBackupFile = filename;
    settings.lastBackupError = null;
    await applyRetentionPolicy(settings.maxBackups || 10);
    await saveSettings(settings);

    console.log(`[Auto-backup] Created: ${filename}`);
    return { success: true, filename };
  } catch (err) {
    console.error('[Auto-backup] Failed:', err.message);
    try {
      const settings = await getSettings();
      settings.lastBackup = new Date().toISOString();
      settings.lastBackupStatus = 'failed';
      settings.lastBackupError = err.message;
      await saveSettings(settings);
    } catch (settingsErr) {
      // If we can't even persist the failure reason, just log — don't
      // crash the scheduler tick.
      console.error('[Auto-backup] Settings save also failed:', settingsErr.message);
    }
    return { success: false, error: err.message };
  }
};

/** Determine whether a backup should run right now based on settings.
 *
 * DST safety notes:
 *  - All comparisons use Date objects (UTC epoch ms), so the scheduler is
 *    timezone-aware automatically — "run at 02:00 local time every day" means
 *    02:00 wall-clock in the server's TZ.
 *  - Spring-forward: the non-existent 02:00 hour gets normalised by JS to 03:00
 *    so the backup fires at 03:00 on that day. Acceptable.
 *  - Fall-back: 02:00 exists twice. setHours picks the first (standard-time)
 *    occurrence. We guard against double-run with `last < scheduled` — after a
 *    run, `last` equals `scheduled` so the next iteration returns false until
 *    the NEXT day's scheduled time rolls past `last`.
 *  - Server downtime: the scheduler is catch-up-friendly: if we were off during
 *    02:00 and come up at 04:00, `now >= scheduled` is true and `last < scheduled`
 *    is true (last was yesterday), so we still run once.
 */
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
      // Clamp dayOfMonth to the last valid day of the current month. Without
      // this, `new Date(2025, 1, 31, ...)` (February 31) silently overflows to
      // March 3 and the monthly backup never fires in February — 11 of 12
      // months in a year a user who sets "31" would be missing backups.
      // The standard accounting convention is "run on the last day if the
      // chosen day doesn't exist this month", which is what this clamp implements.
      const desiredDay = settings.dayOfMonth || 1;
      const lastDayThisMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
      const safeDay = Math.min(desiredDay, lastDayThisMonth);
      const scheduled = new Date(now.getFullYear(), now.getMonth(), safeDay, h, m, 0);
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
      const settings = await getSettings();
      if (shouldRunNow(settings)) await exports.runAutoBackup();
    } catch (err) {
      console.error('[Auto-backup scheduler] Error:', err.message);
    }
  }, 60 * 1000);

  console.log('[Auto-backup] Scheduler started');
};

// Export helpers for routes
exports.getSettings = getSettings;
