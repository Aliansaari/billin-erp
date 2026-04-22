const express = require('express');
const router = express.Router();
const multer = require('multer');
const path = require('path');
const tallyController = require('../controllers/tallyController');
const { authenticateToken } = require('../middleware/auth');

const upload = multer({
  dest: path.join(__dirname, '..', 'uploads'),
  fileFilter: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    if (['.xml', '.txt'].includes(ext)) cb(null, true);
    else cb(new Error('Only .xml files are allowed'));
  },
  limits: { fileSize: 50 * 1024 * 1024 }, // 50MB — Tally exports can be hefty
});

router.use(authenticateToken);

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
