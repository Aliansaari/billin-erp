const express = require('express');
const router = express.Router();
const authController = require('../controllers/authController');
const { authenticateToken } = require('../middleware/auth');
const { loginRateLimit } = require('../middleware/loginRateLimit');

// Rate-limit login before the controller runs: returns 429 for keys that are
// currently locked out. The controller still records failures/successes so
// the counter stays accurate.
router.post('/login', loginRateLimit, authController.login);
router.get('/profile', authenticateToken, authController.getProfile);
router.post('/change-password', authenticateToken, authController.changePassword);
router.post('/verify-password', authenticateToken, authController.verifyPassword);

// Developer-mode unlock — verifies the (env-tunable) developer password.
// authenticateToken first so only logged-in users can attempt dev unlock;
// loginRateLimit caps brute-force tries by IP+user just like login.
router.post('/dev-verify', authenticateToken, loginRateLimit, authController.verifyDeveloperPassword);

module.exports = router;
