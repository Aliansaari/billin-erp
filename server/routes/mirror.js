const express = require('express');
const router = express.Router();
const mirrorController = require('../controllers/mirrorController');
const { authenticateToken } = require('../middleware/auth');
const { requirePermission } = require('../middleware/permissions');

router.use(authenticateToken);

/* Gated on reports.view: the mirror hands out balances and party details, so
 * it must not be reachable by a login that is not allowed to see them on
 * screen. A cached copy is still a disclosure. */
router.get('/pull',     requirePermission('reports.view'), mirrorController.pull);
router.get('/checksum', requirePermission('reports.view'), mirrorController.checksum);

module.exports = router;
