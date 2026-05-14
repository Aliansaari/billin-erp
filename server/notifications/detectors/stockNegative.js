/*
 * stock-negative detector.
 *
 * Surfaces products whose current_stock dropped below zero. In normal
 * operation stock can't be negative — sales validation prevents
 * overselling against on-hand. Negative stock almost always means a
 * data-entry mistake: a wrong opening balance, a missing purchase
 * bill, a duplicated sales bill, or a returns flow that bypassed
 * stock add-back.
 *
 * One notification per affected product. Stable key = product id, so
 * a product that goes negative twice in a day (oversell + correction)
 * doesn't double-fire — the existing row just stays active until the
 * operator resolves it.
 *
 * Cap of 20 affected products in the bell — beyond that the firm has
 * a systemic issue that needs a one-shot reconciliation, not 50
 * scrolling notifications. The bell would just be noise.
 */

const { Op } = require('sequelize');
const { Product } = require('../../models');

module.exports = async function detect(/* ctx */) {
  const rows = await Product.findAll({
    where: {
      current_stock: { [Op.lt]: 0 },
      is_active: true,
    },
    attributes: ['product_id', 'product_name', 'barcode', 'current_stock'],
    order: [['current_stock', 'ASC']],   // worst-deficit first
    limit: 20,
  });

  return rows.map((p) => {
    const shortBy = Math.abs(Number(p.current_stock || 0));
    return {
      key:         `stock-negative:${p.product_id}`,
      type:        'stock-negative',
      section:     'risk',
      severity:    'red',
      label:       `Negative stock: ${p.product_name}`,
      sub:         `${p.barcode ? `${p.barcode} · ` : ''}Shows ${shortBy} short. Likely a missed purchase or duplicate sale.`,
      occurredAt:  new Date(),
      actionRoute: `/stock-movement/${p.product_id}`,
      actionLabel: 'Investigate',
    };
  });
};
