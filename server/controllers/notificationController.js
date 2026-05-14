/*
 * Notifications controller — thin HTTP wrapper over notifications/service.js.
 *
 * All endpoints are scoped to req.user.user_id (set by authenticateToken
 * middleware). There's no cross-user read or write; notifications are
 * a per-operator surface.
 *
 * Public route shapes:
 *
 *   GET  /api/notifications                  → full payload
 *   GET  /api/notifications/count            → { unread_count, master_enabled }
 *   POST /api/notifications/mark-all-seen    → no body, marks every active row seen
 *   POST /api/notifications/:key/action      → { op, ...opts }
 *                                              op ∈ mark-seen | dismiss | snooze
 *   GET  /api/notifications/settings         → user prefs row
 *   PUT  /api/notifications/settings         → updates prefs (partial OK)
 *
 * Error policy: 500 on database failures (logged server-side; client
 * shows generic banner), 404 on action against non-existent key,
 * 400 on malformed body.
 */

const service = require('../notifications/service');

exports.list = async (req, res) => {
  try {
    const payload = await service.getNotifications(req.user);
    res.json(payload);
  } catch (err) {
    console.error('[notifications.list]', err);
    res.status(500).json({ error: err.message });
  }
};

exports.count = async (req, res) => {
  try {
    const payload = await service.getCount(req.user);
    res.json(payload);
  } catch (err) {
    console.error('[notifications.count]', err);
    res.status(500).json({ error: err.message });
  }
};

exports.action = async (req, res) => {
  try {
    const { key } = req.params;
    const { op, ...opts } = req.body || {};
    if (!key) return res.status(400).json({ error: 'Missing key' });
    if (!['mark-seen', 'dismiss', 'snooze'].includes(op)) {
      return res.status(400).json({ error: 'Invalid op' });
    }
    const row = await service.actOnKey(req.user, key, op, opts);
    if (!row) return res.status(404).json({ error: 'Notification not found' });
    res.json({
      key: row.notif_key,
      status: row.status,
      snoozed_until: row.snoozed_until,
    });
  } catch (err) {
    console.error('[notifications.action]', err);
    res.status(500).json({ error: err.message });
  }
};

exports.markAllSeen = async (req, res) => {
  try {
    await service.markAllSeen(req.user);
    res.status(204).end();
  } catch (err) {
    console.error('[notifications.markAllSeen]', err);
    res.status(500).json({ error: err.message });
  }
};

exports.getSettings = async (req, res) => {
  try {
    const row = await service.getSettings(req.user);
    res.json({
      master_enabled: row.master_enabled,
      type_toggles: row.type_toggles || {},
    });
  } catch (err) {
    console.error('[notifications.getSettings]', err);
    res.status(500).json({ error: err.message });
  }
};

exports.updateSettings = async (req, res) => {
  try {
    const row = await service.updateSettings(req.user, req.body || {});
    res.json({
      master_enabled: row.master_enabled,
      type_toggles: row.type_toggles || {},
    });
  } catch (err) {
    console.error('[notifications.updateSettings]', err);
    res.status(500).json({ error: err.message });
  }
};
