const express = require('express');
const router = express.Router();
const settingsController = require('../controllers/settingsController');
const { authenticateToken } = require('../middleware/auth');
const { checkPermission } = require('../middleware/permissions');

router.use(authenticateToken);

router.get('/system', settingsController.getSystemSettings);
router.put('/system', checkPermission('Admin'), settingsController.updateSystemSettings);
router.get('/barcode', settingsController.getBarcodeSettings);
router.put('/barcode', checkPermission('Admin'), settingsController.updateBarcodeSettings);
router.get('/users', checkPermission('Admin'), settingsController.getUsers);
router.post('/users', checkPermission('Admin'), settingsController.createUser);
router.put('/users/:id', checkPermission('Admin'), settingsController.updateUser);
router.delete('/users/:id', checkPermission('Admin'), settingsController.deleteUser);
router.get('/roles', settingsController.getRoles);
router.post('/cleanup', checkPermission('Admin'), settingsController.cleanupData);

module.exports = router;
