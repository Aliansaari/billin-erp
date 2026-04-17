const express = require('express');
const router = express.Router();
const multer = require('multer');
const { authenticateToken: authenticate } = require('../middleware/auth');
const { checkPermission } = require('../middleware/permissions');
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

// EVERY backup route is Admin-only. Restore/delete/create can destroy a firm's
// entire data set; cashiers must never be able to call them. List + settings
// are also admin because they expose the backup inventory.
const adminOnly = checkPermission('Admin');

router.get('/list',                  authenticate, adminOnly, bc.listBackups);
router.post('/create',               authenticate, adminOnly, bc.createBackup);
router.get('/download/:filename',    authenticate, adminOnly, bc.downloadBackup);
router.delete('/:filename',          authenticate, adminOnly, bc.deleteBackup);
router.post('/restore',              authenticate, adminOnly, upload.single('file'), bc.restoreBackup);
router.get('/settings',              authenticate, adminOnly, bc.getAutoBackupSettings);
router.put('/settings',              authenticate, adminOnly, bc.updateAutoBackupSettings);

module.exports = router;
