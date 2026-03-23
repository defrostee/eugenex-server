// ══════════════════════════════════════════════════════════════════════════════
//  EUGENEX — Render.com Proxy Server
//  Deploy: connect your GitHub repo to Render as a Web Service
//  Build command: npm install
//  Start command: node server.js
// ══════════════════════════════════════════════════════════════════════════════

const express = require('express');
const fetch   = require('node-fetch');
const app     = express();
const PORT    = process.env.PORT || 3000;

const ALLOWED_ORIGINS = [
  'https://defrostee.github.io',
];

// ── CORS middleware ────────────────────────────────────────────────────────────
app.use((req, res, next) => {
  const origin = req.headers.origin;
  const allowed = ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0];
  res.setHeader('Access-Control-Allow-Origin', allowed);
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS, HEAD');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Requested-With');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

app.use(express.raw({ type: '*/*', limit: '10mb' }));

// ── Health check ───────────────────────────────────────────────────────────────
app.get('/', (req, res) => {
  res.json({ status: 'EUGENEX online' });
});

// ── Proxy route: /proxy?url=https://example.com ────────────────────────────────
app.all('/proxy', async (req, res) => {
  const target = req.query.url;
  if (!target) return res.status(400).json({ error: 'Missing ?url= parameter' });

  let targetURL;
  try { targetURL = new URL(target); }
  catch { return res.status(400).json({ error: 'Invalid target URL' }); }

  if (isPrivateHost(targetURL.hostname)) {
    return res.status(403).json({ error: 'Private network access blocked' });
  }

  try {
    const headers = {
      'Host':            targetURL.hostname,
      'Origin':          targetURL.origin,
      'Referer':         targetURL.origin + '/',
      'User-Agent':      req.headers['user-agent'] || 'Mozilla/5.0',
      'Accept':          req.headers['accept'] || 'text/html,*/*',
      'Accept-Language': req.headers['accept-language'] || 'en-US,en;q=0.9',
      'Accept-Encoding': 'identity', // disable gzip so we can rewrite text easily
    };

    const upstream = await fetch(targetURL.toString(), {
      method:   req.method,
      headers,
      body:     ['GET','HEAD'].includes(req.method) ? undefined : req.body,
      redirect: 'follow',
    });

    const contentType = upstream.headers.get('content-type') || '';
    const workerBase  = `${req.protocol}://${req.get('host')}`;
    const proxyPrefix = `${workerBase}/proxy?url=`;

    // Strip security headers that would break our proxy iframe
    const skipHeaders = new Set([
      'content-security-policy',
      'content-security-policy-report-only',
      'x-frame-options',
      'strict-transport-security',
      'x-content-type-options',
      'transfer-encoding',
      'connection',
    ]);

    upstream.headers.forEach((val, key) => {
      if (!skipHeaders.has(key.toLowerCase())) {
        res.setHeader(key, val);
      }
    });

    res.status(upstream.status);

    if (contentType.includes('text/html')) {
      let html = await upstream.text();
      html = rewriteHTML(html, targetURL.toString(), proxyPrefix);
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      return res.send(html);
    }

    if (contentType.includes('text/css')) {
      let css = await upstream.text();
      css = rewriteCSS(css, targetURL.toString(), proxyPrefix);
      res.setHeader('Content-Type', contentType);
      return res.send(css);
    }

    // Stream everything else
    upstream.body.pipe(res);

  } catch (err) {
    res.status(502).json({ error: 'Fetch failed: ' + err.message });
  }
});

// ── HTML REWRITER ──────────────────────────────────────────────────────────────
function rewriteHTML(html, targetBase, proxyPrefix) {
  // Rewrite href, src, action
  html = html.replace(/(href|src|action)=["']([^"']+)["']/gi, (match, attr, val) => {
    const abs = resolveURL(val, targetBase);
    if (!abs || abs.startsWith('data:') || abs.startsWith('javascript:') || val.startsWith('#')) return match;
    return `${attr}="${proxyPrefix}${encodeURIComponent(abs)}"`;
  });

  // Rewrite inline style url()
  html = html.replace(/url\(["']?([^)"'\s]+)["']?\)/gi, (match, val) => {
    const abs = resolveURL(val, targetBase);
    if (!abs || abs.startsWith('data:')) return match;
    return `url("${proxyPrefix}${encodeURIComponent(abs)}")`;
  });

  // Inject fetch/XHR patch so in-page JS requests stay proxied
  const injected = `<script>
(function(){
  var P="${proxyPrefix}", B="${targetBase}";
  function px(u){
    if(!u||u.startsWith('data:')||u.startsWith('blob:')||u.startsWith('#'))return u;
    try{return P+encodeURIComponent(new URL(u,B).toString());}catch(e){return u;}
  }
  var _f=window.fetch;
  window.fetch=function(i,o){
    if(typeof i==='string')i=px(i);
    else if(i&&i.url)i=new Request(px(i.url),i);
    return _f.call(this,i,o);
  };
  var _o=XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open=function(m,u){
    return _o.apply(this,[m,px(u)].concat([].slice.call(arguments,2)));
  };
})();
<\/script>`;

  if (/<head[\s>]/i.test(html)) {
    html = html.replace(/(<head[\s>][^>]*>)/i, '$1' + injected);
  } else {
    html = injected + html;
  }

  return html;
}

// ── CSS REWRITER ───────────────────────────────────────────────────────────────
function rewriteCSS(css, targetBase, proxyPrefix) {
  return css.replace(/url\(["']?([^)"'\s]+)["']?\)/gi, (match, val) => {
    const abs = resolveURL(val.trim(), targetBase);
    if (!abs || abs.startsWith('data:')) return match;
    return `url("${proxyPrefix}${encodeURIComponent(abs)}")`;
  });
}

// ── HELPERS ────────────────────────────────────────────────────────────────────
function resolveURL(val, base) {
  val = val.trim();
  if (!val || val.startsWith('data:') || val.startsWith('javascript:')) return null;
  try { return new URL(val, base).toString(); } catch { return null; }
}

function isPrivateHost(host) {
  return (
    host === 'localhost' ||
    host === '127.0.0.1' ||
    /^192\.168\./.test(host) ||
    /^10\./.test(host) ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(host) ||
    host.endsWith('.local')
  );
}

app.listen(PORT, () => console.log(`EUGENEX running on port ${PORT}`));
