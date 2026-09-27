const express = require('express');
const router = express.Router();
const c = require('../controllers/payrollController');
const { authenticateToken } = require('../middleware/auth');
const { requirePermission } = require('../middleware/permissions');

/*
 * Payroll — owner/manager only, same gate as staff attendance: salaries are
 * the most private numbers in the shop.
 */
router.use(authenticateToken, requirePermission('settings.manage_company'));

router.get('/settings',                     c.getSettings);
router.put('/settings',                     c.saveSettings);

router.get('/structures',                   c.listStructures);
router.put('/structures/:staffId',          c.saveStructure);
router.delete('/structures/item/:structureId', c.deleteStructure);

router.get('/advances',                     c.listAdvances);
router.post('/advances',                    c.giveAdvance);
router.put('/advances/:id',                 c.updateAdvance);
router.post('/advances/:id/void',           c.voidAdvance);

router.post('/payments/:id/void',           c.voidPayment);

router.get('/runs/:period',                 c.getRun);
router.put('/runs/:period/lines/:staffId',  c.saveLine);
router.post('/runs/:period/finalize',       c.finalize);
router.post('/runs/:period/reopen',         c.reopen);
router.post('/runs/:period/pay',            c.pay);
router.get('/runs/:period/payments',        c.payments);

module.exports = router;
