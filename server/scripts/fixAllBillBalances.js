/**
 * One-time fix: Reconcile ALL bill balances for every party using FIFO.
 *
 * Run with:  node server/scripts/fixAllBillBalances.js
 */
require('dotenv').config({ path: require('path').join(__dirname, '../../.env') });

const sequelize = require('../config/database');
// Load all model associations
require('../models');

const { reconcileBillsForParty, recalculatePartyBalance } = require('../utils/balanceHelper');
const { Party } = require('../models');

async function run() {
  try {
    await sequelize.authenticate();
    console.log('DB connected.\n');

    // Collect every party that has any financial activity
    const [rows] = await sequelize.query(`
      SELECT DISTINCT party_id FROM (
        SELECT customer_id  AS party_id FROM sales_bills    WHERE is_cancelled = false
        UNION
        SELECT supplier_id  AS party_id FROM purchase_bills WHERE is_cancelled = false
        UNION
        SELECT party_id                  FROM payments_receipts WHERE is_cancelled = false
      ) sub
      ORDER BY party_id
    `);

    const partyIds = rows.map(r => r.party_id);
    console.log(`Found ${partyIds.length} active parties to reconcile.\n`);

    for (const partyId of partyIds) {
      const party = await Party.findByPk(partyId);
      const name  = party ? party.party_name : `#${partyId}`;
      try {
        await reconcileBillsForParty(partyId);
        const newBal = await recalculatePartyBalance(partyId);
        console.log(`  ✓ ${name.padEnd(30)} balance → ${newBal}`);
      } catch (err) {
        console.error(`  ✗ ${name}: ${err.message}`);
      }
    }

    console.log('\nAll done.');
    process.exit(0);
  } catch (err) {
    console.error('Fatal error:', err);
    process.exit(1);
  }
}

run();
