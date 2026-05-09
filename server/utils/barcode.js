const { Op, fn, col, where: whereFn } = require('sequelize');
const { BarcodeSettings } = require('../models');

/**
 * Allocate the next barcode under a pessimistic row lock so concurrent callers
 * never receive the same number. Accepts an optional transaction so callers
 * that already hold a transaction (e.g., purchase bill creation) can pass
 * theirs — the lock is released when THAT transaction commits/rolls back.
 *
 * Without the lock two requests could both read current_number=N, both compute
 * N+1, and both write N+1 — yielding duplicate barcodes that then fail the
 * unique index check at product-create time, or worse slip through if the
 * index is missing.
 */
async function generateBarcode(transaction) {
  const sequelize = require('../config/database');
  const runWithTx = async (t) => {
    const settings = await BarcodeSettings.findByPk(1, {
      lock: t.LOCK.UPDATE,
      transaction: t,
    });
    if (!settings) throw new Error('Barcode settings not configured');

    const nextNumber = settings.current_number + 1;
    // Empty prefix is allowed — pure-numeric barcodes (e.g. EAN-style)
    // are produced by leaving prefix blank. The separator (- / _ / /
    // / . / none) is configurable and only counts toward digits when
    // both prefix and separator are non-empty.
    const prefix = settings.prefix || '';
    const sepRaw = settings.separator ?? '-';
    const separator = prefix ? sepRaw : '';
    const usedChars = prefix.length + separator.length;
    const digits = Math.max(1, (settings.total_digits || 13) - usedChars);
    const paddedNumber = String(nextNumber).padStart(digits, '0');
    const barcode = `${prefix}${separator}${paddedNumber}`;

    await settings.update({ current_number: nextNumber }, { transaction: t });
    return barcode;
  };

  // Re-use the caller's transaction if supplied; otherwise run in a new one.
  if (transaction) return runWithTx(transaction);
  return sequelize.transaction(runWithTx);
}

/**
 * Find an existing product that exactly matches all key fields.
 * Matching rules:
 *   - product_name     (required, case-insensitive trimmed)
 *   - size_value       (if provided, case-insensitive trimmed)
 *   - article_number   (if provided, case-insensitive trimmed)
 *   - quantity_per_box (always — changing pack size = different SKU = different barcode)
 *
 * Case-insensitive comparison prevents "Blue Shirt" and "blue shirt" from
 * creating two separate products with two different barcodes.
 */
async function findExistingProduct(Product, { product_name, size, article_number, quantity_per_box }, transaction) {
  if (!product_name) return null;
  const norm = (v) => (v == null ? '' : String(v).trim());

  const conditions = [
    whereFn(fn('LOWER', fn('TRIM', col('product_name'))), norm(product_name).toLowerCase()),
  ];

  if (norm(size)) {
    conditions.push(
      whereFn(fn('LOWER', fn('TRIM', fn('COALESCE', col('size_value'), ''))), norm(size).toLowerCase())
    );
  }
  if (norm(article_number)) {
    conditions.push(
      whereFn(fn('LOWER', fn('TRIM', fn('COALESCE', col('article_number'), ''))), norm(article_number).toLowerCase())
    );
  }

  // parseFloat, not parseInt — products / bill items are DECIMAL(10,2).
  // Under parseInt, 2.5 silently became 2, so a different SKU matched.
  const qpb = parseFloat(quantity_per_box || 1) || 1;
  conditions.push({ quantity_per_box: qpb });

  return Product.findOne({ where: { [Op.and]: conditions }, transaction });
}

module.exports = { generateBarcode, findExistingProduct };
