const express = require('express');
const router = express.Router();
const ctrl = require('../controllers/salesReturnController');
const { authenticateToken } = require('../middleware/auth');
const { checkPermission } = require('../middleware/permissions');

router.use(authenticateToken);

router.get('/', ctrl.getAll);
router.get('/reference/:id', ctrl.getReferenceBill);
router.get('/:id', ctrl.getById);
router.post('/', checkPermission('Admin', 'Manager', 'Cashier'), ctrl.create);
router.put('/:id', checkPermission('Admin', 'Manager', 'Cashier'), ctrl.update);
router.post('/:id/cancel', checkPermission('Admin', 'Manager'), ctrl.cancel);

module.exports = router;
