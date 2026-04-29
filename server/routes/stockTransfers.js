const express = require('express');
const router = express.Router();
const c = require('../controllers/stockTransferController');
const { authenticateToken } = require('../middleware/auth');
const { requirePermission } = require('../middleware/permissions');

router.use(authenticateToken);

router.get('/',                requirePermission('stock_transfers.view'),   c.getAll);
router.get('/:id',             requirePermission('stock_transfers.view'),   c.getById);
router.post('/',               requirePermission('stock_transfers.create'), c.create);
router.post('/:id/submit',     requirePermission('stock_transfers.create'), c.submit);
router.post('/:id/receive',    requirePermission('stock_transfers.create'), c.receive);
router.post('/:id/cancel',     requirePermission('stock_transfers.create'), c.cancel);

module.exports = router;
