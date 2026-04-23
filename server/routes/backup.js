const express = require('express');
const router = express.Router();
const multer = require('multer');
const { authenticateToken: authenticate } = require('../middleware/auth');
const { requirePermission } = require('../middleware/permissions');
const bc = require('../controllers/backupController');

// Accept uploaded backup files up to 500 MB in memory
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 500 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (file.mimetype === 'application/json' || file.originalname.endsWith('.json'))
      cb(null, true);
    else
      cb(new Error('Only JSON backup files are accepted'));
  },
});

// EVERY backup route is Super-Admin-only. Restore/delete/create can destroy
// a firm's entire data set; lower roles must never be able to call them.
// List + settings are also gated because they expose the backup inventory
// and schedule, both firm-private.
const backupOnly = requirePermission('settings.backup');

router.get('/list',                  authenticate, backupOnly, bc.listBackups);
router.post('/create',               authenticate, backupOnly, bc.createBackup);
router.get('/download/:filename',    authenticate, backupOnly, bc.downloadBackup);
router.delete('/:filename',          authenticate, backupOnly, bc.deleteBackup);
router.post('/restore',              authenticate, backupOnly, upload.single('file'), bc.restoreBackup);
router.get('/settings',              authenticate, backupOnly, bc.getAutoBackupSettings);
router.put('/settings',              authenticate, backupOnly, bc.updateAutoBackupSettings);

module.exports = router;
