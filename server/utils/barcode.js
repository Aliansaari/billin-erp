const { BarcodeSettings } = require('../models');

async function generateBarcode() {
  const settings = await BarcodeSettings.findByPk(1);
  if (!settings) throw new Error('Barcode settings not configured');

  const nextNumber = settings.current_number + 1;
  const paddedNumber = String(nextNumber).padStart(settings.total_digits - settings.prefix.length - 1, '0');
  const barcode = `${settings.prefix}-${paddedNumber}`;

  await settings.update({ current_number: nextNumber });

  return barcode;
}

/**
 * Find an existing product that exactly matches all key fields.
 * Matching rules:
 *   - product_name  (required)
 *   - size_value    (if provided)
 *   - article_number (if provided)
 *   - quantity_per_box (always — changing pack size = different SKU = different barcode)
 *
 * If quantity_per_box is different from any existing product with the same
 * name/size/article, this will return null and a new barcode will be generated.
 */
async function findExistingProduct(Product, { product_name, size, article_number, quantity_per_box }, transaction) {
  const where = { product_name };

  if (size) where.size_value = size;
  if (article_number) where.article_number = article_number;

  // qty_per_box is always part of the match — even if not provided (defaults to 1)
  where.quantity_per_box = quantity_per_box || 1;

  return Product.findOne({ where, transaction });
}

module.exports = { generateBarcode, findExistingProduct };
