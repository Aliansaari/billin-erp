const { DataTypes } = require('sequelize');
const sequelize = require('../config/database');

/*
 * UserReportFavorite — per-user pinned reports.
 *
 * Each row is one user pinning one report id (string, e.g. 'profit_loss',
 * 'gstr1' — values come from src/config/reports.js#REPORTS). The hub
 * page renders a star next to every report; the nav dropdown shows
 * ONLY the rows for the current user, ordered by pinned_at ASC so the
 * dropdown's order is predictable and matches the order the operator
 * pinned things in.
 *
 * Why a dedicated table (not a JSONB column on users):
 *   - sortable by pinned_at without parsing JSON in SQL
 *   - cascade-delete is automatic when a user is removed
 *   - leaves the door open for shareable favorite sets / role-based
 *     defaults later (a `shared_with_role_id` column would slot in
 *     without disturbing existing rows)
 *
 * report_id is a STRING, not an FK. The registry lives in src/config
 * (frontend) — there's no `reports` table to FK against. If a future
 * report is removed from the registry, orphan rows here just stop
 * resolving (the resolveReports helper in the registry filters them
 * out gracefully). A periodic cleanup job could prune orphans; not
 * worth the table for the rare-renames case.
 */
const UserReportFavorite = sequelize.define('UserReportFavorite', {
  id: {
    type: DataTypes.INTEGER,
    primaryKey: true,
    autoIncrement: true,
  },
  user_id: {
    type: DataTypes.INTEGER,
    allowNull: false,
    references: { model: 'users', key: 'user_id' },
    onDelete: 'CASCADE',
  },
  report_id: {
    type: DataTypes.STRING(64),
    allowNull: false,
  },
  pinned_at: {
    type: DataTypes.DATE,
    allowNull: false,
    defaultValue: DataTypes.NOW,
  },
}, {
  tableName: 'user_report_favorites',
  timestamps: false,  // pinned_at IS the timestamp; createdAt would be redundant
  indexes: [
    { unique: true, fields: ['user_id', 'report_id'] },
    { fields: ['user_id'] },
  ],
});

module.exports = UserReportFavorite;
