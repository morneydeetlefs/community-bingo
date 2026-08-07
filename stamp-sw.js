// stamp-sw.js — run before every deploy to bust the service worker cache
// Called automatically by the predeploy script in package.json

const fs = require('fs');
const sw = fs.readFileSync('sw.js', 'utf8');
const stamped = sw.replace(
  /CACHE_VERSION = 'bingo-[^']+'/,
  "CACHE_VERSION = 'bingo-" + Date.now() + "'"
);
fs.writeFileSync('sw.js', stamped);
console.log('sw.js cache version stamped: bingo-' + Date.now());
