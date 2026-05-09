#!/usr/bin/env node
/**
 * One-shot refactor of every server/models/*.js file (except index.js)
 * from a sequelize-bound singleton into a factory accepting a sequelize
 * instance. Idempotent — running twice is a no-op.
 *
 * Before:
 *   const { DataTypes } = require('sequelize');
 *   const sequelize = require('../config/database');
 *
 *   const Foo = sequelize.define('Foo', { ... }, { ... });
 *
 *   Foo.addHook('afterCreate', ...);   // optional
 *
 *   module.exports = Foo;
 *
 * After:
 *   const { DataTypes } = require('sequelize');
 *
 *   module.exports = (sequelize) => {
 *     const Foo = sequelize.define('Foo', { ... }, { ... });
 *
 *     Foo.addHook('afterCreate', ...);   // optional
 *
 *     return Foo;
 *   };
 *
 * Why: per-company multi-tenancy needs each company's Postgres
 * connection to have its own model bag with its own associations.
 * That requires the model definition to be replayable on any sequelize
 * instance — i.e., a factory function.
 */

const fs = require('fs');
const path = require('path');

const MODELS_DIR = path.join(__dirname, '..', 'server', 'models');
const SKIP = new Set(['index.js', 'Company.js']); // index orchestrates; Company is master-DB only

let touched = 0;
let skipped = 0;

for (const file of fs.readdirSync(MODELS_DIR)) {
  if (!file.endsWith('.js')) continue;
  if (SKIP.has(file)) { skipped++; continue; }

  const full = path.join(MODELS_DIR, file);
  let src = fs.readFileSync(full, 'utf8');

  // Idempotency: if already a factory, leave alone.
  if (/module\.exports\s*=\s*\(sequelize\)\s*=>/.test(src)) {
    skipped++;
    continue;
  }

  const orig = src;

  // 1. Drop the `const sequelize = require('../config/database');` line
  //    (and its trailing blank line if present).
  src = src.replace(
    /\nconst\s+sequelize\s*=\s*require\(['"]\.\.\/config\/database['"]\);\n+/,
    '\n\n',
  );

  // 2. Find the model variable name from the first `sequelize.define` call.
  //    Pattern: `const Foo = sequelize.define('Foo', ...)` — the variable
  //    name comes BEFORE the equals.
  const defineMatch = src.match(/const\s+(\w+)\s*=\s*sequelize\.define\(/);
  if (!defineMatch) {
    console.error(`! ${file}: no sequelize.define found, skipping`);
    skipped++;
    continue;
  }
  const modelVar = defineMatch[1];

  // 3. Confirm the file ends with `module.exports = ${modelVar};`.
  const exportRe = new RegExp(`module\\.exports\\s*=\\s*${modelVar}\\s*;?\\s*$`);
  if (!exportRe.test(src.trim())) {
    console.error(`! ${file}: doesn't end with module.exports = ${modelVar}, skipping`);
    skipped++;
    continue;
  }

  // 4. Wrap the file body (starting at `const ${modelVar} = sequelize.define`)
  //    in an arrow function. Replace the trailing module.exports with a
  //    return statement.
  const before = src.slice(0, src.indexOf(`const ${modelVar}`));
  const body   = src.slice(src.indexOf(`const ${modelVar}`)).replace(exportRe, '').trimEnd();

  // Indent every line of the body by 2 spaces for readability.
  const indented = body.split('\n').map(l => l.length ? '  ' + l : l).join('\n');

  src = `${before}module.exports = (sequelize) => {\n${indented}\n  return ${modelVar};\n};\n`;

  fs.writeFileSync(full, src);
  console.log(`✓ ${file}`);
  touched++;
}

console.log(`\nDone. ${touched} refactored, ${skipped} skipped.`);
