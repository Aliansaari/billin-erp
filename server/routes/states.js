/*
 * /api/states — read-only Indian states list for state-picker dropdowns.
 *
 * Authenticated but no permission gate: every user has to be able to fill
 * the State field on Company Profile, regardless of role. The data isn't
 * sensitive (public reference info from the GST portal), so the auth gate
 * is purely about keeping anonymous traffic off the endpoint, not about
 * authorisation.
 */

const express = require('express');
const router = express.Router();
const statesController = require('../controllers/statesController');
const { authenticateToken } = require('../middleware/auth');

router.use(authenticateToken);
router.get('/', statesController.listStates);

module.exports = router;
