const express = require('express');
const router = express.Router();
const multer = require('multer');
const settingsController = require('../controllers/settingsController');
const { authenticateToken } = require('../middleware/auth');
const { requirePermission } = require('../middleware/permissions');

router.use(authenticateToken);

// Multer for branding asset uploads. Memory storage so the controller
// can validate MIME + size BEFORE writing to disk. 5 MB cap matches
// the controller's secondary check; multer rejects oversize uploads
// upfront so we don't buffer huge files.
const brandingUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024, files: 1 },
});

// System settings are read by every page (feature flags, FY, GST toggle, etc.)
// so any authenticated user can GET — writes stay gated to manage_company.
router.get('/system',                                                       settingsController.getSystemSettings);
router.put('/system',       requirePermission('settings.manage_company'),  settingsController.updateSystemSettings);
router.get('/barcode',      requirePermission('settings.view'),            settingsController.getBarcodeSettings);
router.put('/barcode',      requirePermission('settings.barcode'),         settingsController.updateBarcodeSettings);

// Branding asset upload / fetch / clear. Logo is the company logo on
// invoices; signature is the authorized-signatory image at the bottom
// of bills. Both are size-capped at 5 MB and image-MIME only.
router.post('/branding/logo',
  requirePermission('settings.manage_company'),
  brandingUpload.single('file'),
  settingsController.uploadBrandingAsset('logo'));
router.get('/branding/logo',
  requirePermission('settings.view'),
  settingsController.getBrandingAsset('logo'));
router.delete('/branding/logo',
  requirePermission('settings.manage_company'),
  settingsController.removeBrandingAsset('logo'));

router.post('/branding/signature',
  requirePermission('settings.manage_company'),
  brandingUpload.single('file'),
  settingsController.uploadBrandingAsset('signature'));
router.get('/branding/signature',
  requirePermission('settings.view'),
  settingsController.getBrandingAsset('signature'));
router.delete('/branding/signature',
  requirePermission('settings.manage_company'),
  settingsController.removeBrandingAsset('signature'));

// Self-service profile (My Account). Every authenticated user can read
// and update their own row — no extra permission, but the controller
// pins to req.user.user_id so they can't touch anyone else.
router.get('/profile',  settingsController.getMyProfile);
router.put('/profile',  settingsController.updateMyProfile);

// User management is the most sensitive surface — Super Admin only.
router.get('/users',        requirePermission('settings.manage_users'),    settingsController.getUsers);
router.post('/users',       requirePermission('settings.manage_users'),    settingsController.createUser);
router.put('/users/:id',    requirePermission('settings.manage_users'),    settingsController.updateUser);
router.delete('/users/:id', requirePermission('settings.manage_users'),    settingsController.deleteUser);

// Reading the role list is needed by the user-management modal's role
// dropdown, so it's gated to manage_users (not just settings.view).
router.get('/roles',        requirePermission('settings.manage_users'),    settingsController.getRoles);
// Audit: flip per-role capability flags (currently can_enter_backdated).
router.patch('/roles/:role_id', requirePermission('settings.manage_users'), settingsController.updateRolePolicy);

router.post('/cleanup',     requirePermission('settings.cleanup'),         settingsController.cleanupData);

module.exports = router;
