const express = require('express');
const router = express.Router();
const whatsappController = require('../controllers/whatsappController');
const { authenticateToken } = require('../middleware/auth');
const { requirePermission } = require('../middleware/permissions');

router.use(authenticateToken);

// Status is read by the send surfaces (sales bill, lists, statements) to decide
// auto-send vs. the deep-link fallback, so any authenticated operator may read
// it. Likewise enqueueing a send is an operator action — they send the bill
// they just created.
router.get('/status', whatsappController.getStatus);
router.post('/send',  whatsappController.send);

// Connection + configuration management is a Super Admin surface.
router.get('/settings', requirePermission('settings.manage_company'), whatsappController.getSettings);
router.put('/settings', requirePermission('settings.manage_company'), whatsappController.saveSettings);
router.post('/connect', requirePermission('settings.manage_company'), whatsappController.connect);
router.post('/logout',  requirePermission('settings.manage_company'), whatsappController.logout);
router.post('/test',    requirePermission('settings.manage_company'), whatsappController.test);
router.get('/outbox',   requirePermission('settings.manage_company'), whatsappController.outbox);

module.exports = router;
