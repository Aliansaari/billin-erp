const express = require('express');
const router = express.Router();
const c = require('../controllers/staffAttendanceController');
const { authenticateToken } = require('../middleware/auth');
const { requirePermission } = require('../middleware/permissions');

/*
 * Staff attendance — every route is owner/manager only.
 *
 * The register carries staff selfies and locations, and the roster carries
 * the controls that decide who can punch from which phone, so reads are
 * gated exactly like writes (settings.manage_company). Staff themselves never
 * use this API: they see their own attendance on staff.zehenapp.com.
 */
router.use(authenticateToken, requirePermission('settings.manage_company'));

router.get('/settings',              c.getSettings);
router.put('/settings',              c.updateSettings);
router.post('/sync',                 c.syncNow);

router.get('/staff',                 c.listStaff);
router.post('/staff',                c.createStaff);
router.post('/staff/import-salesmen', c.importSalesmen);
router.put('/staff/:id',             c.updateStaff);
router.post('/staff/:id/pin',        c.setPin);
router.post('/staff/:id/reset-device', c.resetDevice);

router.get('/register',              c.getRegister);
router.get('/punches/:id/selfie',    c.getSelfie);
router.post('/punches',              c.addPunch);
router.post('/punches/bulk',         c.bulkPunches);
router.post('/punches/:id/void',     c.voidPunch);

module.exports = router;
