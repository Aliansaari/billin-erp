const express = require('express');
const router = express.Router();
const godownController = require('../controllers/godownController');
const { authenticateToken } = require('../middleware/auth');
const { requirePermission } = require('../middleware/permissions');

router.use(authenticateToken);

router.get('/',              requirePermission('godowns.view'),   godownController.getAll);
router.get('/:id',           requirePermission('godowns.view'),   godownController.getById);
router.post('/',             requirePermission('godowns.manage'), godownController.create);
router.put('/:id',           requirePermission('godowns.manage'), godownController.update);
router.post('/:id/default',  requirePermission('godowns.manage'), godownController.setDefault);
router.delete('/:id',        requirePermission('godowns.manage'), godownController.delete);

module.exports = router;
