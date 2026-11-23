'use strict';
/* The lab's static server: the lab directory only, with the product's security headers, so a
   module that would break under index.html's CSP breaks here first.
   [v1.1] /weather/<file> is served from WX_WEATHER (default ../public/weather/, the cove's files the dashboard
   serves), so the coast pass fetches them as index.html does.
   [critic] Without a manifest.json there, /weather/manifest.json answers 200 with an empty manifest
   ({v: 1, models: [], terrain: [], files: {}}), as src/server.js will, so no 404 reaches the console.
   PORT=0 node serve.cjs   prints: lab listening on http://127.0.0.1:<port>/
   require('./serve.cjs').start(port) -> Promise<{ url, close }> */
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = __dirname;
const CSP = ["default-src 'none'", "script-src 'unsafe-inline'", "style-src 'unsafe-inline'", 'img-src data:',
  "connect-src 'self'", "font-src 'self'", "base-uri 'none'", "form-action 'none'", "frame-ancestors 'none'"].join('; ');
const HEADERS = { 'x-frame-options': 'DENY', 'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer',
  'content-security-policy': CSP, 'cache-control': 'no-store' };
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.json': 'application/json',
  '.png': 'image/png', '.css': 'text/css', '.glb': 'model/gltf-binary', '.webp': 'image/webp' };
const WEATHER = path.resolve(process.env.WX_WEATHER || path.join(ROOT, '..', 'public', 'weather'));
const EMPTY_MANIFEST = JSON.stringify({ v: 1, models: [], terrain: [], files: {} });   // [critic] what a missing manifest answers

function start(port = 0) {
  const server = http.createServer((req, res) => {
    let p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    if (p === '/') p = '/index.html';
    const inWeather = p.startsWith('/weather/');
    const file = inWeather ? path.normalize(path.join(WEATHER, p.slice(9))) : path.normalize(path.join(ROOT, p));
    if (inWeather ? !file.startsWith(WEATHER + path.sep) || !/^[a-z0-9_.-]+$/.test(path.basename(file)) :
        !file.startsWith(ROOT + path.sep) || /(^|\/)(out|notes|tests|weather)\//.test(path.relative(ROOT, file)) && !/\.(png|json)$/.test(file)) {
      /* [r3] the folders are tested below ROOT: a lab copied into an out/ folder (budget --freeze) still serves */
      res.writeHead(404, HEADERS); return res.end('not found');
    }
    fs.readFile(file, (err, buf) => {
      /* [critic] no cove files: the manifest still answers, empty, as src/server.js will (DESIGN 13.6), so the
         page shows the open sea without the browser logging a 404 for it */
      if (err && p === '/weather/manifest.json') {
        res.writeHead(200, { ...HEADERS, 'content-type': MIME['.json'], 'cache-control': 'no-cache' });
        return res.end(EMPTY_MANIFEST);
      }
      if (err) { res.writeHead(404, HEADERS); return res.end('not found'); }
      res.writeHead(200, { ...HEADERS, 'content-type': MIME[path.extname(file)] || 'application/octet-stream',
        ...(inWeather ? { 'cache-control': 'max-age=86400' } : {}) });
      res.end(buf);
    });
  });
  return new Promise((done) => server.listen(port, '127.0.0.1', () => {
    const url = `http://127.0.0.1:${server.address().port}/`;
    done({ url, close: () => new Promise((d) => server.close(d)) });
  }));
}
module.exports = { start, CSP };
if (require.main === module) start(+(process.env.PORT || 0)).then(({ url }) => console.log('lab listening on ' + url));
