const express = require('express');
const router = express.Router();
const partyController = require('../controllers/partyController');
const { authenticateToken } = require('../middleware/auth');
const { requirePermission } = require('../middleware/permissions');

router.use(authenticateToken);

router.get('/',                        requirePermission('parties.view'),   partyController.getAll);
router.get('/customers',               requirePermission('parties.view'),   partyController.getCustomers);
router.get('/suppliers',               requirePermission('parties.view'),   partyController.getSuppliers);
router.get('/aging',                   requirePermission('parties.view'),   partyController.getAging);
router.post('/recalculate-balances',   requirePermission('parties.edit'),   partyController.recalculateAll);
router.get('/:id',                     requirePermission('parties.view'),   partyController.getById);
router.get('/:id/ledger',              requirePermission('parties.view'),   partyController.getLedger);
router.get('/:id/profit',              requirePermission('parties.view'),   partyController.getPartyProfit);
router.post('/',                       requirePermission('parties.create'), partyController.create);
router.put('/:id',                     requirePermission('parties.edit'),   partyController.update);
router.patch('/:id/toggle-active',     requirePermission('parties.edit'),   partyController.toggleActive);
router.delete('/:id',                  requirePermission('parties.delete'), partyController.delete);

module.exports = router;
