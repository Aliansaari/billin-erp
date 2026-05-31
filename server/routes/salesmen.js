const express = require('express');
const router = express.Router();
const salesmanController = require('../controllers/salesmanController');
const { authenticateToken } = require('../middleware/auth');
const { requirePermission } = require('../middleware/permissions');

router.use(authenticateToken);

// Reads are open to any authenticated user — the Sales Bill form dropdown and
// the Sales-by-Salesman report both need the list, and sales staff don't hold
// the settings.manage_company permission.
router.get('/',       salesmanController.getAll);
router.get('/:id',    salesmanController.getById);

// Writes are gated to company-settings managers.
router.post('/',      requirePermission('settings.manage_company'), salesmanController.create);
router.put('/:id',    requirePermission('settings.manage_company'), salesmanController.update);
router.delete('/:id', requirePermission('settings.manage_company'), salesmanController.delete);

module.exports = router;
