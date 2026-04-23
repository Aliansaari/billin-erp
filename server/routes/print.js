const express = require('express');
const router = express.Router();
const ctrl = require('../controllers/printController');
const { authenticateToken } = require('../middleware/auth');
const { requirePermission } = require('../middleware/permissions');

router.use(authenticateToken);

// Reads (list / getDefault / getById) are needed any time a bill prints —
// every role that can view a bill needs to resolve the print template.
// Writes gated to settings.print.
router.get('/profiles',                   ctrl.list);
router.get('/profiles/default/:doc_type', ctrl.getDefault);
router.get('/profiles/:id',               ctrl.getById);
router.post('/profiles',                  requirePermission('settings.print'), ctrl.create);
router.put('/profiles/:id',               requirePermission('settings.print'), ctrl.update);
router.delete('/profiles/:id',            requirePermission('settings.print'), ctrl.remove);
router.post('/profiles/:id/duplicate',    requirePermission('settings.print'), ctrl.duplicate);

module.exports = router;
