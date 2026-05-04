const express = require('express');
const router  = express.Router();
const c       = require('../controllers/batchController');
const { authenticateToken } = require('../middleware/auth');
const { requirePermission } = require('../middleware/permissions');

router.use(authenticateToken);

// Read-only surface — every endpoint requires `batches.view`. Mutations
// to per-batch stock happen on the bill controllers, not here.
router.get('/expiry-report', requirePermission('batches.view'), c.expiryReport);
router.get('/',              requirePermission('batches.view'), c.list);
router.get('/:batch_id',     requirePermission('batches.view'), c.detail);

module.exports = router;
