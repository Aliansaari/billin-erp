// zip → tar.gz for the voice models, with no dependencies (see voice.js).
// Kept free of Electron imports so it can be tested in plain Node.

const path = require('path');
const zlib = require('zlib');

// ── zip → tar.gz, no dependencies ───────────────────────────────────
// Reads the zip's central directory and inflates each entry with zlib;
// writes a plain ustar archive. Vosk zips hold one top folder, which the
// engine strips on extract, so paths are copied as they are.
function readZipEntries(buf) {
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65557); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('Not a zip file');
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const entries = [];
  for (let n = 0; n < count; n++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error('Bad zip directory');
    const method = buf.readUInt16LE(p + 10);
    const compSize = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const localOff = buf.readUInt32LE(p + 42);
    const name = buf.toString('utf8', p + 46, p + 46 + nameLen);
    p += 46 + nameLen + extraLen + commentLen;
    if (name.endsWith('/')) continue;
    if (name.includes('..') || path.isAbsolute(name)) throw new Error(`Unsafe path in zip: ${name}`);
    const lNameLen = buf.readUInt16LE(localOff + 26);
    const lExtraLen = buf.readUInt16LE(localOff + 28);
    const start = localOff + 30 + lNameLen + lExtraLen;
    const raw = buf.subarray(start, start + compSize);
    let data;
    if (method === 0) data = raw;
    else if (method === 8) data = zlib.inflateRawSync(raw);
    else throw new Error(`Unsupported zip compression (${method}) for ${name}`);
    entries.push({ name, data });
  }
  return entries;
}

function tarHeader(name, size, type = '0') {
  const h = Buffer.alloc(512, 0);
  let prefix = '';
  if (Buffer.byteLength(name) > 100) {
    const cut = name.replace(/\/$/, '').lastIndexOf('/', 154);
    prefix = name.slice(0, cut); name = name.slice(cut + 1);
  }
  h.write(name, 0, 100, 'utf8');
  h.write(type === '5' ? '0000755\0' : '0000644\0', 100);
  h.write('0000000\0', 108);
  h.write('0000000\0', 116);
  h.write(size.toString(8).padStart(11, '0') + '\0', 124);
  h.write(Math.floor(Date.now() / 1000).toString(8).padStart(11, '0') + '\0', 136);
  h.write('        ', 148);
  h.write(type, 156);
  h.write('ustar\0', 257);
  h.write('00', 263);
  h.write(prefix, 345, 155, 'utf8');
  let sum = 0;
  for (const b of h) sum += b;
  h.write(sum.toString(8).padStart(6, '0') + '\0 ', 148);
  return h;
}

// Directory entries matter: without them the engine's extractor makes the
// folders itself with no permissions, and saving the model into its
// IndexedDB cache then fails ("Failed to sync file system"), so the model
// never finishes loading.
function entriesToTarGz(entries) {
  const parts = [];
  const dirs = new Set();
  for (const { name } of entries) {
    const segs = name.split('/').slice(0, -1);
    for (let i = 1; i <= segs.length; i++) dirs.add(`${segs.slice(0, i).join('/')}/`);
  }
  for (const d of [...dirs].sort()) parts.push(tarHeader(d, 0, '5'));
  for (const { name, data } of entries) {
    parts.push(tarHeader(name, data.length), data);
    const pad = (512 - (data.length % 512)) % 512;
    if (pad) parts.push(Buffer.alloc(pad, 0));
  }
  parts.push(Buffer.alloc(1024, 0));
  return zlib.gzipSync(Buffer.concat(parts), { level: 6 });
}

const zipToTarGz = (zipBuf) => entriesToTarGz(readZipEntries(zipBuf));

// Files in a .tar.gz this module wrote (ustar, regular files + folders).
function readTarGzEntries(tgz) {
  const buf = zlib.gunzipSync(tgz);
  const entries = [];
  for (let p = 0; p + 512 <= buf.length;) {
    const h = buf.subarray(p, p + 512);
    if (h.every((b) => b === 0)) break;
    const str = (o, n) => h.toString('utf8', o, o + n).replace(/\0.*$/s, '');
    const name = str(0, 100);
    const prefix = str(345, 155);
    const size = parseInt(str(124, 12).trim(), 8) || 0;
    const type = str(156, 1) || '0';
    p += 512;
    if (type === '0') entries.push({ name: prefix ? `${prefix}/${name}` : name, data: Buffer.from(buf.subarray(p, p + size)) });
    p += Math.ceil(size / 512) * 512;
  }
  return entries;
}

// Rebuild an archive written by the first version (no folder entries).
const repairTarGz = (tgz) => entriesToTarGz(readTarGzEntries(tgz));

module.exports = { zipToTarGz, readZipEntries, readTarGzEntries, repairTarGz };
