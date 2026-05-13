const { Client } = require('pg');
const masterSequelize = require('../config/masterDatabase');
const Company = require('../models/Company');

/* ── Companies controller ──────────────────────────────────────────────
 *
 * All endpoints talk to the master DB (companies table). Per-company
 * data still lives in each company's own DB; this surface is purely
 * the directory + lifecycle.
 *
 * Endpoint security:
 *   GET  /list-public          — unauthenticated, used by the login
 *                                screen to populate the picker BEFORE
 *                                the user has credentials. Returns
 *                                only safe metadata (id, name, logo,
 *                                accent_color) — never gstin/address.
 *
 *   GET  /                     — auth required. Same shape but with
 *                                full metadata; used by the topbar
 *                                switcher and Manage Companies page.
 *
 *   POST /                     — auth + developer-mode required AND
 *                                under the dev_max_companies cap.
 *                                Allocates a new DB, registers the
 *                                row, returns the new id.
 *
 *   PATCH /:id                 — auth required. Edits friendly name,
 *                                logo, accent. Cannot change db_name.
 *
 *   DELETE /:id                — auth required. Soft-delete: flips
 *                                is_active=false but leaves the DB on
 *                                disk so backup/restore still works.
 *                                Cannot soft-delete the primary
 *                                company.
 */

const DB_HOST     = process.env.DB_HOST     || 'localhost';
const DB_PORT     = process.env.DB_PORT     || 5432;
const DB_USER     = process.env.DB_USER     || 'postgres';
const DB_PASSWORD = process.env.DB_PASSWORD || 'postgres';

// Strip a row down to fields the login picker is allowed to see. The
// picker fires unauthenticated, so we never expose gstin / address /
// audit timestamps to anyone with network reach.
function publicShape(row) {
  return {
    company_id:   row.company_id,
    name:         row.name,
    logo_path:    row.logo_path,
    accent_color: row.accent_color,
    is_primary:   row.is_primary,
  };
}

exports.listPublic = async (req, res) => {
  try {
    const rows = await Company.findAll({
      where: { is_active: true, db_dropped_at: null },
      order: [['is_primary', 'DESC'], ['name', 'ASC']],
    });
    res.json({ data: rows.map(publicShape) });
  } catch (e) {
    console.error('[companies] listPublic:', e.message);
    res.status(500).json({ error: 'Could not load companies' });
  }
};

exports.list = async (req, res) => {
  try {
    const includeInactive = String(req.query.include_inactive || '') === '1';
    const where = includeInactive ? { db_dropped_at: null } : { is_active: true, db_dropped_at: null };
    const rows = await Company.findAll({
      where,
      order: [['is_primary', 'DESC'], ['is_active', 'DESC'], ['name', 'ASC']],
    });
    res.json({ data: rows });
  } catch (e) {
    console.error('[companies] list:', e.message);
    res.status(500).json({ error: 'Could not load companies' });
  }
};

async function readMaxCompaniesCap() {
  // Read dev_max_companies from master_settings. 0 = unlimited.
  try {
    const [rows] = await masterSequelize.query(
      'SELECT dev_max_companies FROM master_settings WHERE setting_id = 1',
    );
    return Number(rows[0]?.dev_max_companies ?? 3);
  } catch {
    return 3;
  }
}

async function createCompanyDatabase(dbName) {
  // Create the per-company database via an admin connection. Connecting
  // to the cluster-level `postgres` DB so we don't need an existing
  // connection to dbName. CREATE DATABASE can't run inside a
  // transaction, so we use a one-off pg client.
  const admin = new Client({
    host: DB_HOST, port: DB_PORT,
    user: DB_USER, password: DB_PASSWORD,
    database: 'postgres',
  });
  await admin.connect();
  try {
    await admin.query(`CREATE DATABASE "${dbName}"`);
  } finally {
    await admin.end();
  }
}

exports.create = async (req, res) => {
  try {
    const {
      name, legal_name, gstin, address, fy_start_month, accent_color,
    } = req.body || {};

    if (!name || !String(name).trim()) {
      return res.status(400).json({ error: 'Company name is required' });
    }

    // Cap check.
    const cap = await readMaxCompaniesCap();
    if (cap > 0) {
      const existing = await Company.count({ where: { db_dropped_at: null } });
      if (existing >= cap) {
        return res.status(403).json({
          error: `Maximum of ${cap} companies reached. Ask your developer to raise the cap in Developer Settings.`,
          code: 'MAX_COMPANIES_REACHED',
          cap,
        });
      }
    }

    // Allocate the row first to claim the auto-increment id; we use
    // that id to derive the per-company db_name. If the DB-creation
    // step then fails we roll back the row so a half-created company
    // doesn't pollute the picker.
    const placeholderName = `billing_erp_co_pending_${Date.now()}`;
    const created = await Company.create({
      name: String(name).trim(),
      db_name: placeholderName,
      legal_name: legal_name || null,
      gstin: gstin || null,
      address: address || null,
      fy_start_month: Number(fy_start_month) || 4,
      accent_color: accent_color || '#21604C',
      is_primary: false,
      is_active:  true,
      created_by_user_id: req.user?.user_id || null,
    });

    const dbName = `billing_erp_co_${created.company_id}`;
    try {
      await createCompanyDatabase(dbName);
    } catch (dbErr) {
      // Roll back the directory row so the user can retry cleanly.
      await created.destroy().catch(() => {});
      console.error('[companies] CREATE DATABASE failed:', dbErr.message);
      return res.status(500).json({
        error: 'Could not create the company database. Check that your Postgres user has CREATE DATABASE permission.',
      });
    }

    await created.update({ db_name: dbName });

    // NOTE Phase 2: schema migrations against the new DB happen here.
    // For now the new DB is empty and not yet usable for billing —
    // switching to it will be wired in the next phase. The companies
    // directory + cap enforcement work today.

    res.status(201).json({ data: created });
  } catch (e) {
    console.error('[companies] create:', e.message);
    res.status(500).json({ error: 'Server error creating company' });
  }
};

exports.update = async (req, res) => {
  try {
    const row = await Company.findByPk(req.params.id);
    if (!row) return res.status(404).json({ error: 'Company not found' });
    if (row.db_dropped_at) return res.status(400).json({ error: 'Cannot edit a permanently-deleted company' });

    // Only the cosmetic + GST metadata fields are editable. db_name and
    // is_primary stay locked so backups + the legacy primary-company
    // chain don't drift.
    const allowed = [
      'name', 'legal_name', 'gstin', 'address', 'logo_path',
      'fy_start_month', 'accent_color', 'is_active',
    ];
    const patch = {};
    for (const k of allowed) {
      if (req.body && k in req.body) patch[k] = req.body[k];
    }

    // Don't let a user deactivate the primary — the only company they
    // could fall back to. Primary stays active forever; soft-delete it
    // and there'd be no DB to log into.
    if (row.is_primary && patch.is_active === false) {
      return res.status(400).json({
        error: 'The primary company cannot be deactivated. Pick a different primary first.',
      });
    }

    await row.update(patch);
    res.json({ data: row });
  } catch (e) {
    console.error('[companies] update:', e.message);
    res.status(500).json({ error: 'Server error updating company' });
  }
};

exports.softDelete = async (req, res) => {
  try {
    const row = await Company.findByPk(req.params.id);
    if (!row) return res.status(404).json({ error: 'Company not found' });
    if (row.is_primary) {
      return res.status(400).json({ error: 'The primary company cannot be archived' });
    }
    await row.update({ is_active: false });
    res.json({ data: row });
  } catch (e) {
    console.error('[companies] softDelete:', e.message);
    res.status(500).json({ error: 'Server error archiving company' });
  }
};

/*
 * backupCompany — create + stream an encrypted backup file for a
 * specific company by id, regardless of which company the caller's
 * session is currently routed to.
 *
 * Why this exists: the delete-company modal offers a "Back up first"
 * button. The standard /api/backup/create endpoint always backs up the
 * caller's active company, so backing up a non-active company would
 * normally require switching to it first (and a password prompt). This
 * endpoint sidesteps that by running the existing collectAllData() flow
 * inside a temporary companyContext.run() scoped to the target — same
 * mechanism the request middleware uses, just one-shot per call.
 *
 * Permission: Super Admin / Admin (same gate as create / delete).
 */
exports.backupCompany = async (req, res) => {
  try {
    const id = Number(req.params.id);
    const row = await Company.findByPk(id);
    if (!row) return res.status(404).json({ error: 'Company not found' });

    const { getCompanyConnection, companyContext } = require('../services/companyConnections');
    let dest;
    try {
      dest = await getCompanyConnection(id);
    } catch (e) {
      return res.status(500).json({ error: 'Could not connect to company database: ' + e.message });
    }

    // Re-use the existing backup pipeline from backupController. We don't
    // want to duplicate the collectAllData logic here — it touches every
    // model and would drift. Instead, run the backup controller's create
    // path inside a companyContext.run scoped to this company's models.
    const backupCtrl = require('./backupController');
    return companyContext.run(
      { sequelize: dest.sequelize, models: dest.models, companyId: id },
      () => backupCtrl.createBackup(req, res),
    );
  } catch (e) {
    console.error('[companies] backupCompany:', e.message);
    res.status(500).json({ error: 'Backup failed: ' + e.message });
  }
};

/*
 * hardDelete — irreversibly drop a company.
 *
 * Three things happen, in order:
 *   1. The per-company PostgreSQL database is DROPPED (cluster-level
 *      command via the master pg client — bills, ledger entries, audit
 *      trail, all gone).
 *   2. The branding upload folder (if any) is recursively removed so we
 *      don't leak logo / signature PNGs.
 *   3. The row in master.companies is destroy()'d so the company stops
 *      appearing in the picker.
 *
 * Confirmation: the client MUST POST `{ confirm_name }` with a value
 * that matches the company's `name` exactly (trimmed). This prevents
 * "DELETE /api/companies/3" via a stray script from nuking the firm's
 * books — the human in the loop has to type the name into the modal.
 *
 * Refusals (400):
 *   • Primary company (would leave nothing to log into).
 *   • Active company in this request — caller must switch away first.
 *   • Name confirmation mismatch.
 *
 * Permission: same gate as create/update — Super Admin or Admin role.
 * In future this could be narrowed to dev-mode-only on the server side,
 * but we already enforce dev-mode at the UI layer for visibility.
 */
exports.hardDelete = async (req, res) => {
  try {
    const id = Number(req.params.id);
    const row = await Company.findByPk(id);
    if (!row) return res.status(404).json({ error: 'Company not found' });

    if (row.is_primary) {
      return res.status(400).json({
        error: 'The primary company cannot be deleted. Promote another company first.',
      });
    }

    // Name confirmation — must match exactly (trimmed, case-sensitive).
    const confirmName = String(req.body?.confirm_name || '').trim();
    if (!confirmName || confirmName !== String(row.name || '').trim()) {
      return res.status(400).json({
        error: 'Type the company name exactly to confirm deletion.',
      });
    }

    // Refuse if THIS request is currently routed to that company.
    // companyContext is set by the per-request middleware; if the
    // operator is acting "inside" the company they're trying to delete,
    // they'd nuke the same DB they're connected through. Make them
    // switch to a different company first.
    const { companyContext } = require('../services/companyConnections');
    const ctx = companyContext.getStore();
    if (ctx && Number(ctx.companyId) === id) {
      return res.status(400).json({
        error: 'Switch to a different company before deleting this one.',
      });
    }

    const dbName = row.db_name;

    // 1) Close any pooled connection to this company so the DROP isn't
    //    blocked by "database is being accessed by other users".
    try {
      const { invalidateCompany } = require('../services/companyConnections');
      invalidateCompany(id);
    } catch (e) {
      console.error('[hardDelete] invalidateCompany:', e.message);
    }

    // Wait briefly for the close() to finish — invalidateCompany returns
    // synchronously but the underlying sequelize.close() is async.
    await new Promise((r) => setTimeout(r, 250));

    // 2) Drop the per-company database. WITH (FORCE) terminates any
    //    lingering backends so a stale idle session can't block us.
    //    PG 13+ supports the FORCE option; older clusters fall back.
    if (dbName && dbName.startsWith('billing_erp_co_')) {
      const admin = new Client({
        host: DB_HOST, port: DB_PORT,
        user: DB_USER, password: DB_PASSWORD,
        database: 'postgres',
      });
      await admin.connect();
      try {
        try {
          await admin.query(`DROP DATABASE IF EXISTS "${dbName}" WITH (FORCE)`);
        } catch {
          // Fallback for pre-PG13 — terminate sessions, then DROP.
          await admin.query(
            `SELECT pg_terminate_backend(pid) FROM pg_stat_activity ` +
            `WHERE datname = $1 AND pid <> pg_backend_pid()`,
            [dbName],
          );
          await admin.query(`DROP DATABASE IF EXISTS "${dbName}"`);
        }
      } finally {
        await admin.end().catch(() => {});
      }
    }

    // 3) Remove the branding folder (logos / signatures). Best-effort —
    //    a missing folder is fine; a permission error logs but doesn't
    //    fail the request because the more important step (DROP DATABASE)
    //    has already succeeded.
    try {
      const path = require('path');
      const fs = require('fs');
      const dir = path.join(__dirname, '..', 'uploads', 'branding', String(id));
      if (fs.existsSync(dir)) {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    } catch (e) {
      console.error('[hardDelete] branding cleanup:', e.message);
    }

    // 4) Drop the row from master.companies.
    await row.destroy();

    res.json({ ok: true, deleted: { company_id: id, name: row.name } });
  } catch (e) {
    console.error('[companies] hardDelete:', e.message);
    res.status(500).json({ error: 'Server error deleting company: ' + e.message });
  }
};

// Read / write the master cap. Used by Developer Settings.
exports.getMaxCompaniesCap = async (req, res) => {
  try {
    const cap = await readMaxCompaniesCap();
    res.json({ data: { dev_max_companies: cap } });
  } catch (e) {
    res.status(500).json({ error: 'Could not read setting' });
  }
};

exports.setMaxCompaniesCap = async (req, res) => {
  try {
    const v = Number(req.body?.dev_max_companies);
    if (!Number.isFinite(v) || v < 0) {
      return res.status(400).json({ error: 'dev_max_companies must be a non-negative integer' });
    }
    await masterSequelize.query(
      'UPDATE master_settings SET dev_max_companies = :v, modified_date = NOW() WHERE setting_id = 1',
      { replacements: { v } },
    );
    res.json({ data: { dev_max_companies: v } });
  } catch (e) {
    console.error('[companies] setMaxCompaniesCap:', e.message);
    res.status(500).json({ error: 'Could not update setting' });
  }
};
