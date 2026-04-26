const express = require('express');
const router = express.Router();
const ctrl = require('../controllers/importJobController');
const { authenticateToken } = require('../middleware/auth');
const { requirePermission } = require('../middleware/permissions');

router.use(authenticateToken);

// Use settings.import_export — same gate as the existing legacy endpoint.
router.get('/',                  requirePermission('settings.import_export'), ctrl.list);
router.post('/',                 requirePermission('settings.import_export'), ctrl.uploadMiddleware, ctrl.create);
router.get('/:id',               requirePermission('settings.import_export'), ctrl.getById);
router.post('/:id/confirm',      requirePermission('settings.import_export'), ctrl.confirm);
router.post('/:id/cancel',       requirePermission('settings.import_export'), ctrl.cancel);
router.get('/:id/rejected-rows', requirePermission('settings.import_export'), ctrl.downloadRejected);
router.get('/:id/batches',       requirePermission('settings.import_export'), ctrl.batches);

module.exports = router;
