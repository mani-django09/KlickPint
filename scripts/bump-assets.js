'use strict';
// Stamps every local /css/*.css and /js/*.js reference in public/**/*.html with
// ?v=<hash of all CSS+JS>. The server caches versioned URLs for a week, so run
// this (npm run bump-assets) after editing any stylesheet or script. The hash
// only changes when the files do, so re-running it is harmless.
const fs     = require('fs');
const path   = require('path');
const crypto = require('crypto');

const PUBLIC = path.join(__dirname, '..', 'public');

function walk(dir, out = []) {
  for (const name of fs.readdirSync(dir)) {
    const p = path.join(dir, name);
    if (fs.statSync(p).isDirectory()) walk(p, out); else out.push(p);
  }
  return out;
}

const files  = walk(PUBLIC);
const rel    = f => path.relative(PUBLIC, f).split(path.sep).join('/');
const assets = files.filter(f => /^(css|js)\/[^/]+\.(css|js)$/.test(rel(f))).sort();
const hash   = crypto.createHash('sha1');
for (const f of assets) hash.update(fs.readFileSync(f));
const version = hash.digest('hex').slice(0, 8);

const ref = /((?:href|src)="\/(?:css|js)\/[\w.-]+\.(?:css|js))(?:\?v=[\w]+)?"/g;
let changed = 0;
for (const f of files.filter(f => f.endsWith('.html'))) {
  const src = fs.readFileSync(f, 'utf8');
  const out = src.replace(ref, `$1?v=${version}"`);
  if (out !== src) { fs.writeFileSync(f, out); changed++; }
}
console.log(`Asset version ${version}: updated ${changed} page(s).`);
