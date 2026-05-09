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
