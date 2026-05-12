#!/usr/bin/env node
/**
 * decrypt-backup.js — Internal developer tool
 * ─────────────────────────────────────────────
 * Decrypts a customer's .enc backup file into readable JSON.
 *
 * Usage:
 *   node scripts/decrypt-backup.js  path/to/backup.enc
 *   node scripts/decrypt-backup.js  path/to/backup.enc  -o output.json
 *   node scripts/decrypt-backup.js  path/to/backup.enc  --pretty
 *
 * This script is for INTERNAL USE ONLY — never ship it to customers,
 * never commit it to a public repo. It contains the same app-level
 * encryption key that backupController.js uses.
 *
 * The script is excluded from the electron-builder bundle
 * (see package.json build.files which excludes scripts/).
 */

const fs = require('fs');
const crypto = require('crypto');
const path = require('path');

// ── Same constants as backupController.js ──
const PBKDF2_ITERATIONS = 100_000;
const KEY_LENGTH  = 32;
const _ERP_BACKUP_KEY = 'sB!9$kL#nR@2xVp&7mWq*4YfDj^8Tz+GcE6hA3uN';

function deriveKey(salt) {
  return crypto.pbkdf2Sync(_ERP_BACKUP_KEY, salt, PBKDF2_ITERATIONS, KEY_LENGTH, 'sha512');
}

function decrypt(envelope) {
  if (typeof envelope === 'string') envelope = JSON.parse(envelope);
  const salt = Buffer.from(envelope.salt, 'base64');
  const iv   = Buffer.from(envelope.iv,   'base64');
  const tag  = Buffer.from(envelope.tag,  'base64');
  const data = Buffer.from(envelope.data, 'base64');
  const key  = deriveKey(salt);
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8');
}

// ── CLI ──
const args = process.argv.slice(2);
const inputFile = args.find(a => !a.startsWith('-'));
const outputFlag = args.indexOf('-o');
const outputFile = outputFlag !== -1 ? args[outputFlag + 1] : null;
const pretty = args.includes('--pretty');

if (!inputFile) {
  console.log('Usage: node scripts/decrypt-backup.js <backup.enc> [-o output.json] [--pretty]');
  process.exit(1);
}

try {
  const raw = fs.readFileSync(inputFile, 'utf8');
  const parsed = JSON.parse(raw);

  if (!parsed.encrypted) {
    console.log('This file is already plain JSON (not encrypted).');
    process.exit(0);
  }

  console.log('Decrypting...');
  const decrypted = decrypt(parsed);
  const backup = JSON.parse(decrypted);

  // Show summary
  const counts = backup.recordCounts || {};
  console.log(`\nBackup: v${backup.version}  |  Type: ${backup.type}  |  Created: ${backup.createdAt}`);
  console.log(`Total records: ${backup.totalRecords}`);
  console.log('Tables:', Object.entries(counts).map(([k, v]) => `${k}(${v})`).join(', '));

  if (outputFile) {
    const content = pretty ? JSON.stringify(backup, null, 2) : JSON.stringify(backup);
    fs.writeFileSync(outputFile, content, 'utf8');
    console.log(`\nWritten to: ${outputFile}`);
  } else {
    console.log('\nAdd -o output.json to save, or --pretty for formatted output.');
  }
} catch (e) {
  if (e.message.includes('Unsupported state') || e.message.includes('unable to authenticate')) {
    console.error('ERROR: Decryption failed. File may be corrupted.');
  } else {
    console.error('ERROR:', e.message);
  }
  process.exit(1);
}
