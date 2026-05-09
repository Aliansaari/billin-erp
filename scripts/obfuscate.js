#!/usr/bin/env node
/**
 * Layer 1 — JavaScript obfuscation.
 * ──────────────────────────────────
 *
 * Runs javascript-obfuscator over the server-side JS that ships inside
 * the .exe. Transforms identifiers, encrypts string literals, flattens
 * control flow, and injects dead code so a reader who extracts app.asar
 * gets pages of `_0x4f23` / `_0x4f23(_0x32a1, _0x4f23(_0x32b9))` instead
 * of `partyController.create`.
 *
 * What we obfuscate:
 *   server/**\/*.js   (everything except node_modules and dotfiles)
 *
 * What we DON'T obfuscate:
 *   - dist/        — already minified by Vite. Re-running obfuscator
 *                    on minified bundles often breaks them and the
 *                    incremental protection is small.
 *   - node_modules — third-party code; obfuscating breaks lots of libs.
 *   - electron/    — main-process bootstrap. Tiny, mostly Electron API
 *                    glue, low IP value.
 *   - scripts/     — only run during development.
 *
 * Settings tuning notes:
 *   We use the "medium-high" preset rather than "maximum". Maximum
 *   adds debug-protection and self-defending which, while protective,
 *   make legitimate runtime errors near-impossible to diagnose. The
 *   present settings give strong static-read resistance without
 *   wrecking the runtime experience.
 *
 * Usage:
 *   node scripts/obfuscate.js [--in <dir>] [--out <dir>] [--debug]
 *
 *   --debug   Skip obfuscation, just copy files. Used by `npm run
 *              dist:debug` so you can ship an unprotected build for
 *              your own AnyDesk troubleshooting.
 */

const fs = require('fs');
const path = require('path');
const obfuscator = require('javascript-obfuscator');

const args = process.argv.slice(2);
function flag(name)  { return args.includes('--' + name); }
function arg(name, def) {
  const i = args.indexOf('--' + name);
  return i >= 0 ? args[i + 1] : def;
}

const ROOT = path.resolve(__dirname, '..');
const SRC  = path.resolve(arg('in',  path.join(ROOT, 'server')));
const OUT  = path.resolve(arg('out', path.join(ROOT, 'server-obf')));
const DEBUG = flag('debug');

if (!fs.existsSync(SRC)) {
  console.error('[obfuscate] source dir not found:', SRC);
  process.exit(1);
}

// Wipe + recreate the output dir so a stale leftover can't sneak into
// the next build. Cheap; src is small.
fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(OUT, { recursive: true });

// ── Files we copy verbatim (no obfuscation) ──────────────────────────
const COPY_AS_IS = new Set([
  '.json', '.txt', '.md', '.html', '.css', '.png', '.jpg', '.gif',
  '.svg', '.ico', '.woff', '.woff2', '.ttf',
]);

// ── Skip these subtrees entirely ─────────────────────────────────────
//
// These are RUNTIME artefacts that should never ship in an installer:
//
//   uploads/       — user-uploaded customer files (logos, photos)
//   backups/       — auto-generated DB backups from this dev box
//   node_modules/  — dev artefact; root project's node_modules wins
//   package*.json  — root project's package.json wins
//
// Any of these making it into the .exe would (a) bloat the installer
// and (b) leak the developer's local data into the customer build.
function shouldSkip(rel) {
  const parts = rel.split(path.sep);
  if (parts.some(p =>
    p === 'node_modules' ||
    p === '.git'         ||
    p === 'tests'        ||
    p === 'test'         ||
    p === '__tests__'    ||
    p === 'uploads'      ||
    p === 'backups'      ||
    p.startsWith('.'))) return true;
  // Top-level package.json / package-lock — only the inner-server ones
  // (root project's get included by electron-builder separately).
  if (rel === 'package.json' || rel === 'package-lock.json') return true;
  return false;
}

// ── Obfuscator settings ──────────────────────────────────────────────
//
// "Medium-high" — strong static obscurity without runtime fragility.
// Each option's purpose, in plain words:
//
//   compact:               strips whitespace
//   identifierNamesGenerator hexadecimal: rename to _0x… form
//   stringArray + stringArrayEncoding rc4: lift every string literal
//                          into a runtime-decoded array
//   stringArrayThreshold 0.85: encode 85% of literals (some left raw
//                          to avoid breaking dynamic property access)
//   transformObjectKeys:   property names also get encoded
//   controlFlowFlattening: turns `a; b; c` into a state-machine —
//                          devastating for static reading
//   deadCodeInjection:     adds plausible-looking branches that never
//                          run, drowning real logic in noise
//   selfDefending: false:  (we leave this OFF — true breaks debugging)
//   debugProtection: false:  (also OFF — true causes anti-DevTools
//                            loops which fight legitimate support work)
//
const OBF_OPTIONS = {
  compact: true,
  controlFlowFlattening: true,
  controlFlowFlatteningThreshold: 0.5,        // half of functions get flattened
  deadCodeInjection: true,
  deadCodeInjectionThreshold: 0.3,            // 30% extra fake branches
  identifierNamesGenerator: 'hexadecimal',
  numbersToExpressions: true,                 // 42 → (0xFF ^ 0xD5)
  renameGlobals: false,                       // off — would break require/module
  rotateStringArray: true,
  selfDefending: false,                       // off — see comment above
  shuffleStringArray: true,
  splitStrings: true,
  splitStringsChunkLength: 6,
  stringArray: true,
  stringArrayEncoding: ['rc4'],
  stringArrayIndexShift: true,
  stringArrayWrappersChainedCalls: true,
  stringArrayWrappersCount: 4,
  stringArrayWrappersType: 'function',
  stringArrayThreshold: 0.85,
  transformObjectKeys: true,
  unicodeEscapeSequence: false,               // off — bloats size 2x

  // Files we should NOT touch (dynamic features that obf would break).
  // Sequelize models declare property keys via JS property access; we
  // disable transformObjectKeys for the models tree by passing them
  // through with lighter settings (handled below).

  // Don't crash on syntax we don't understand — log + copy.
  target: 'node',
  log: false,
};

// Lighter settings for files where heavy transforms break things.
// Sequelize models, Tally importer, anything that uses string-named
// property access at runtime. `transformObjectKeys: false` is the
// critical relaxation — those files often do `model.fields[fieldName]`
// where fieldName is a runtime string, and renaming the key would
// silently break the lookup.
const OBF_OPTIONS_LIGHT = {
  ...OBF_OPTIONS,
  transformObjectKeys: false,
  controlFlowFlattening: false,        // off — interferes with dynamic dispatch
  controlFlowFlatteningThreshold: 0,
  deadCodeInjection: false,
  deadCodeInjectionThreshold: 0,
  stringArrayThreshold: 0.5,           // less aggressive
};

const LIGHT_PATHS = [
  // These trees use heavy runtime introspection — keep them light to
  // avoid runtime breakage. They still benefit from string-array
  // encoding + identifier renaming.
  'models',
  'config',                            // license.js lives here; bytecode-compile takes care of it later
  'controllers',                       // sequelize property access
];

function isLight(rel) {
  const parts = rel.split(path.sep);
  return LIGHT_PATHS.some(p => parts.includes(p));
}

// ── Walker ───────────────────────────────────────────────────────────
let jsFiles = 0, copiedFiles = 0, skipped = 0;
function walk(dir, relBase = '') {
  for (const name of fs.readdirSync(dir)) {
    const abs = path.join(dir, name);
    const rel = path.join(relBase, name);
    if (shouldSkip(rel)) { skipped++; continue; }

    const stat = fs.statSync(abs);
    if (stat.isDirectory()) {
      const targetDir = path.join(OUT, rel);
      fs.mkdirSync(targetDir, { recursive: true });
      walk(abs, rel);
      continue;
    }

    const ext = path.extname(name).toLowerCase();
    const target = path.join(OUT, rel);
    fs.mkdirSync(path.dirname(target), { recursive: true });

    if (ext === '.js') {
      const src = fs.readFileSync(abs, 'utf8');
      let out;
      if (DEBUG) {
        out = src;
      } else {
        try {
          const opts = isLight(rel) ? OBF_OPTIONS_LIGHT : OBF_OPTIONS;
          out = obfuscator.obfuscate(src, opts).getObfuscatedCode();
        } catch (e) {
          console.error(`[obfuscate] FAILED on ${rel}: ${e.message}`);
          console.error(`[obfuscate] copying as-is to keep build working`);
          out = src;
        }
      }
      fs.writeFileSync(target, out, 'utf8');
      jsFiles++;
    } else if (COPY_AS_IS.has(ext) || ext === '') {
      fs.copyFileSync(abs, target);
      copiedFiles++;
    } else {
      // Unknown extension — copy verbatim.
      fs.copyFileSync(abs, target);
      copiedFiles++;
    }
  }
}

const t0 = Date.now();
console.log(`[obfuscate] ${DEBUG ? 'DEBUG mode (no obfuscation, just copying)' : 'obfuscating'}…`);
console.log(`[obfuscate]   from: ${SRC}`);
console.log(`[obfuscate]   to:   ${OUT}`);
walk(SRC);
console.log(`[obfuscate] done in ${Date.now() - t0} ms — ${jsFiles} JS files, ${copiedFiles} copied, ${skipped} skipped`);
