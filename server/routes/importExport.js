const express = require('express');
const router = express.Router();
const multer = require('multer');
const path = require('path');
const importExportController = require('../controllers/importExportController');
const { authenticateToken } = require('../middleware/auth');

const upload = multer({
  dest: path.join(__dirname, '..', 'uploads'),
  fileFilter: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    if (['.xlsx', '.xls', '.csv'].includes(ext)) {
      cb(null, true);
    } else {
      cb(new Error('Only Excel/CSV files are allowed'));
    }
  },
  limits: { fileSize: 10 * 1024 * 1024 }, // 10MB
});

router.use(authenticateToken);

router.get('/export/:module', importExportController.exportToExcel);
router.get('/template/:module', importExportController.downloadTemplate);
router.post('/import/:module', upload.single('file'), importExportController.importFromExcel);
router.post('/failed-report', importExportController.generateFailedReport);

module.exports = router;
