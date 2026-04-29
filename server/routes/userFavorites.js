const express = require('express');
const router = express.Router();
const c = require('../controllers/userFavoritesController');
const { authenticateToken } = require('../middleware/auth');

router.use(authenticateToken);

// All three endpoints are scoped to req.user.user_id. No permission
// gate beyond authentication — every authenticated user can manage
// their own favorites regardless of role.
router.get('/',                      c.list);
router.post('/:reportId',            c.pin);
router.delete('/:reportId',          c.unpin);

module.exports = router;
