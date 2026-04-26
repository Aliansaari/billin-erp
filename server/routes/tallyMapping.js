const express = require('express');
const router = express.Router();
const ctrl = require('../controllers/tallyMappingController');
const { authenticateToken } = require('../middleware/auth');
const { requirePermission } = require('../middleware/permissions');

router.use(authenticateToken);

router.get('/',         requirePermission('settings.tally'), ctrl.list);
router.get('/suggest',  requirePermission('settings.tally'), ctrl.suggest);
router.post('/',        requirePermission('settings.tally'), ctrl.save);

module.exports = router;
