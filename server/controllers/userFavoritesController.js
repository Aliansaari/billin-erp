/*
 * Per-user report favorites — list / pin / unpin.
 *
 * Three endpoints, all scoped to req.user.user_id (set by the auth
 * middleware). No cross-user reads; no cross-user writes. Server is
 * the source of truth so favorites persist across browsers and
 * device changes.
 *
 * Response shape kept minimal — the frontend only ever needs the
 * ordered list of report_id strings. Resolving each id to a full
 * report definition happens client-side via the registry in
 * src/config/reports.js, which already knows the names, routes,
 * categories, etc.
 */

const { UserReportFavorite } = require('../models');

exports.list = async (req, res) => {
  try {
    const rows = await UserReportFavorite.findAll({
      where: { user_id: req.user.user_id },
      attributes: ['report_id', 'pinned_at'],
      order: [['pinned_at', 'ASC']],   // oldest pin first → predictable dropdown order
    });
    res.json(rows.map((r) => r.report_id));
  } catch (err) {
    console.error('[favorites.list]', err);
    res.status(500).json({ error: err.message });
  }
};

exports.pin = async (req, res) => {
  try {
    const { reportId } = req.params;
    if (!reportId || typeof reportId !== 'string' || reportId.length > 64) {
      return res.status(400).json({ error: 'Invalid report id' });
    }
    // findOrCreate is the right primitive — pinning an already-pinned
    // report is idempotent (returns the existing row, no-op effect).
    // The unique index on (user_id, report_id) backs this up at the DB
    // level so concurrent double-clicks can't create duplicates.
    const [row, created] = await UserReportFavorite.findOrCreate({
      where: { user_id: req.user.user_id, report_id: reportId },
      defaults: { user_id: req.user.user_id, report_id: reportId },
    });
    res.status(created ? 201 : 200).json({
      report_id: row.report_id,
      pinned_at: row.pinned_at,
    });
  } catch (err) {
    console.error('[favorites.pin]', err);
    res.status(500).json({ error: err.message });
  }
};

exports.unpin = async (req, res) => {
  try {
    const { reportId } = req.params;
    const n = await UserReportFavorite.destroy({
      where: { user_id: req.user.user_id, report_id: reportId },
    });
    // 204 even when n=0 — unpinning an already-unpinned report is
    // idempotent from the operator's perspective. Returning 404 here
    // would force the client to special-case race conditions where two
    // clicks arrive in quick succession.
    res.status(204).end();
  } catch (err) {
    console.error('[favorites.unpin]', err);
    res.status(500).json({ error: err.message });
  }
};
