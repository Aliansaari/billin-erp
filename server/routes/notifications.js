/*
 * Notification routes. Every endpoint sits behind authenticateToken;
 * authorisation is implicit (each route reads/writes only req.user's
 * own state), so we don't gate on a permission like 'reports.view'.
 *
 * No role can "see all users' notifications" — by design. If admins
 * later need a snapshot for support purposes, that goes through a
 * separate admin route, not this one.
 */

const express = require('express');
const router = express.Router();
const c = require('../controllers/notificationController');
const { authenticateToken } = require('../middleware/auth');

router.use(authenticateToken);

// Listing + count
router.get('/',         c.list);
router.get('/count',    c.count);

// Bulk + per-key actions
router.post('/mark-all-seen',     c.markAllSeen);
router.post('/:key/action',       c.action);

// Per-user preferences
router.get('/settings', c.getSettings);
router.put('/settings', c.updateSettings);

module.exports = router;
