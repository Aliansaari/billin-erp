const express = require('express');
const router = express.Router();
const multer = require('multer');
const { authenticateToken: authenticate } = require('../middleware/auth');
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

router.get('/list',                  authenticate, bc.listBackups);
router.post('/create',               authenticate, bc.createBackup);
router.get('/download/:filename',    authenticate, bc.downloadBackup);
router.delete('/:filename',          authenticate, bc.deleteBackup);
router.post('/restore',              authenticate, upload.single('file'), bc.restoreBackup);
router.get('/settings',              authenticate, bc.getAutoBackupSettings);
router.put('/settings',              authenticate, bc.updateAutoBackupSettings);

module.exports = router;
