/*
 * Compliance routes — audit-log read API.
 *
 * Sits behind authenticateToken + requires `settings.manage_company`
 * to view, because the audit log can contain sensitive information
 * about who overrode locks and why. Regular operators don't see this
 * page; admins / accountants / external CA tools (with admin creds) do.
 *
 * No write endpoint here — every audit row is written from inside
 * the operation that produced it (settings controller for config
 * changes, voucher controllers for overrides) so the log + the
 * artifact commit together. A direct POST would let callers pollute
 * the log with arbitrary events.
 */

const express = require('express');
const router = express.Router();
const c = require('../controllers/complianceController');
const { authenticateToken } = require('../middleware/auth');
const { requirePermission } = require('../middleware/permissions');

router.use(authenticateToken);
router.use(requirePermission('settings.manage_company'));

router.get('/audit-log', c.list);

module.exports = router;
