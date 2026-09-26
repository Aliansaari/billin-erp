const express = require('express');
const router = express.Router();
const c = require('../controllers/userPreferencesController');
const { authenticateToken } = require('../middleware/auth');

router.use(authenticateToken);

// Authentication is the only gate. Every endpoint reads and writes
// req.user.user_id's own rows, so there is nothing here a role could
// sensibly be allowed or denied — a cashier owns their theme exactly
// as much as the proprietor owns theirs.
router.get('/',        c.list);
router.put('/',        c.putMany);
router.delete('/',     c.clear);
router.put('/:key',    c.put);
router.delete('/:key', c.remove);

module.exports = router;
