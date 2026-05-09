const { DataTypes } = require('sequelize');
const masterSequelize = require('../config/masterDatabase');

/* ── Company ─────────────────────────────────────────────────────────────
 *
 * Lives in the master DB. Each row points at a per-company Postgres
 * database via `db_name`. Renames don't change `db_name` — the friendly
 * `name` field is purely cosmetic so backups + DB tooling stay
 * stable.
 *
 * Lifecycle:
 *   active=true              normal — appears in pickers, accepts logins
 *   active=false             archived — hidden from pickers, DB still
 *                            exists on disk so a backup or restore is
 *                            possible. Re-activating is reversible.
 *   db_dropped_at=<ts>       hard-deleted — DB has been dropped from
 *                            Postgres. Row stays for audit but cannot
 *                            be re-activated; user must create fresh.
 *
 * `is_primary` marks Company 1 (the original install). Useful for the
 * UI: "you can't delete the primary company" + per-company backup
 * defaults. Exactly one row should ever have is_primary=true.
 */
const Company = masterSequelize.define('Company', {
  company_id: {
    type: DataTypes.INTEGER,
    primaryKey: true,
    autoIncrement: true,
  },

  // Friendly name shown in pickers, switcher, manage page. Editable.
  name: {
    type: DataTypes.STRING(120),
    allowNull: false,
  },

  // Postgres DB name. Set at creation time, never changes. The bootstrap
  // generates this as `billing_erp_co_<id>` for every new company; the
  // primary (legacy single-DB install) keeps its original name
  // (`billing_erp`) so the existing connection string still works.
  db_name: {
    type: DataTypes.STRING(80),
    allowNull: false,
    unique: true,
  },

  // Cosmetic + GST metadata that the picker / manage page surface.
  // The actual GSTIN used for billing lives in each company's own
  // system_settings table; this is just for display in the company
  // chooser before login.
  legal_name: { type: DataTypes.STRING(200) },
  gstin:      { type: DataTypes.STRING(20)  },
  address:    { type: DataTypes.TEXT        },
  logo_path:  { type: DataTypes.STRING(500) },

  // Financial year start (1 = Jan, 4 = April etc.). Defaults to April
  // for Indian businesses. Used to pre-fill the new-company form.
  fy_start_month: { type: DataTypes.INTEGER, defaultValue: 4 },

  // Visual accent for the company switcher pill — lets the operator
  // tell at a glance which book they're in.
  accent_color:   { type: DataTypes.STRING(9), defaultValue: '#21604C' },

  // Status flags.
  is_primary: { type: DataTypes.BOOLEAN, defaultValue: false },
  is_active:  { type: DataTypes.BOOLEAN, defaultValue: true  },

  // Hard-delete timestamp. NULL means "DB still exists on disk"; once
  // set, the DB has been dropped and the row is read-only audit data.
  db_dropped_at: { type: DataTypes.DATE },

  // Audit fields.
  created_by_user_id: { type: DataTypes.INTEGER },
}, {
  tableName: 'companies',
  timestamps: true,
  createdAt: 'created_date',
  updatedAt: 'modified_date',
  indexes: [
    { fields: ['is_active'] },
    { fields: ['is_primary'] },
  ],
});

module.exports = Company;
