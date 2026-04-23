const express = require('express');
const router = express.Router();
const multer = require('multer');
const path = require('path');
const importExportController = require('../controllers/importExportController');
const { authenticateToken } = require('../middleware/auth');
const { requirePermission } = require('../middleware/permissions');

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

// Export reads all data for a module — treat as a report. Import can
// bulk-mutate; gated to settings.import_export which Super Admin + Admin
// have. Template downloads are harmless static files.
router.get('/export/:module',       requirePermission('reports.view'),          importExportController.exportToExcel);
router.get('/template/:module',     importExportController.downloadTemplate);
router.post('/import/:module',      requirePermission('settings.import_export'), upload.single('file'), importExportController.importFromExcel);
router.post('/failed-report',       requirePermission('settings.import_export'), importExportController.generateFailedReport);
router.post('/regenerate-barcodes', requirePermission('settings.import_export'), importExportController.regenerateBarcodes);

module.exports = router;
