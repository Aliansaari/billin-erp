const express = require('express');
const router = express.Router();
const settingsController = require('../controllers/settingsController');
const { authenticateToken } = require('../middleware/auth');
const { requirePermission } = require('../middleware/permissions');

router.use(authenticateToken);

// Reads exposed to anyone who can access Settings at all. Writes gated to
// the specific sub-permission.
router.get('/system',       requirePermission('settings.view'),            settingsController.getSystemSettings);
router.put('/system',       requirePermission('settings.manage_company'),  settingsController.updateSystemSettings);
router.get('/barcode',      requirePermission('settings.view'),            settingsController.getBarcodeSettings);
router.put('/barcode',      requirePermission('settings.barcode'),         settingsController.updateBarcodeSettings);

// User management is the most sensitive surface — Super Admin only.
router.get('/users',        requirePermission('settings.manage_users'),    settingsController.getUsers);
router.post('/users',       requirePermission('settings.manage_users'),    settingsController.createUser);
router.put('/users/:id',    requirePermission('settings.manage_users'),    settingsController.updateUser);
router.delete('/users/:id', requirePermission('settings.manage_users'),    settingsController.deleteUser);

// Reading the role list is needed by the user-management modal's role
// dropdown, so it's gated to manage_users (not just settings.view).
router.get('/roles',        requirePermission('settings.manage_users'),    settingsController.getRoles);

router.post('/cleanup',     requirePermission('settings.cleanup'),         settingsController.cleanupData);

module.exports = router;
