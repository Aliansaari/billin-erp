const express = require('express');
const router = express.Router();
const categoryController = require('../controllers/categoryController');
const { authenticateToken } = require('../middleware/auth');
const { requirePermission } = require('../middleware/permissions');

router.use(authenticateToken);

router.get('/',     requirePermission('inventory.view'),   categoryController.getAll);
router.get('/flat', requirePermission('inventory.view'),   categoryController.getAllFlat);
router.post('/',    requirePermission('inventory.create'), categoryController.create);
router.put('/:id',  requirePermission('inventory.edit'),   categoryController.update);
router.delete('/:id', requirePermission('inventory.delete'), categoryController.delete);

module.exports = router;
