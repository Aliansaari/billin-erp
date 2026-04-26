const express = require('express');
const router = express.Router();
const ctrl = require('../controllers/ledgerController');
const { authenticateToken } = require('../middleware/auth');
const { requirePermission } = require('../middleware/permissions');

router.use(authenticateToken);

router.get('/accounts',  requirePermission('accounts.view'), ctrl.listAccounts);
router.get('/integrity', requirePermission('accounts.view'), ctrl.integrity);
router.get('/unposted',  requirePermission('accounts.view'), ctrl.unposted);

module.exports = router;
