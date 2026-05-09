const express = require('express');
const router = express.Router();
const multer = require('multer');
const path = require('path');
const tallyController = require('../controllers/tallyController');
const { authenticateToken } = require('../middleware/auth');
const { requirePermission } = require('../middleware/permissions');

const upload = multer({
  dest: require('../utils/paths').UPLOADS_DIR,
  fileFilter: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    if (['.xml', '.txt'].includes(ext)) cb(null, true);
    else cb(new Error('Only .xml files are allowed'));
  },
  // Tally XML exports are UTF-16 LE (2 bytes per char) and voucher files
  // from a full year can be 100+ MB on disk. 50 MB was routinely rejecting
  // real-world Transactions.xml exports; 250 MB is enough for ~5 years of
  // daily bills on a mid-size business.
  limits: { fileSize: 250 * 1024 * 1024 },
});

router.use(authenticateToken);

// Entire Tally surface gated on settings.tally — importing vouchers can
// mutate ledgers, stock, and bills in bulk; config is firm-wide.
router.use(requirePermission('settings.tally'));

router.get('/config', tallyController.getConfig);
router.put('/config', tallyController.updateConfig);
router.post('/test-connection', tallyController.testConnection);

router.get('/export/masters',   tallyController.exportMasters);
router.get('/export/vouchers',  tallyController.exportVouchers);
router.post('/import',          upload.single('file'), tallyController.importXML);

router.post('/live/push', tallyController.livePush);
router.post('/live/pull', tallyController.livePull);
router.get('/sync-logs',  tallyController.getSyncLogs);

module.exports = router;
