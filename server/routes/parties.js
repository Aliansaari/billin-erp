const express = require('express');
const router = express.Router();
const partyController = require('../controllers/partyController');
const { authenticateToken } = require('../middleware/auth');

router.use(authenticateToken);

router.get('/', partyController.getAll);
router.get('/customers', partyController.getCustomers);
router.get('/suppliers', partyController.getSuppliers);
router.post('/recalculate-balances', partyController.recalculateAll);
router.get('/:id', partyController.getById);
router.get('/:id/ledger', partyController.getLedger);
router.post('/', partyController.create);
router.put('/:id', partyController.update);
router.patch('/:id/toggle-active', partyController.toggleActive);
router.delete('/:id', partyController.delete);

module.exports = router;
