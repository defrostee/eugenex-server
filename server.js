// ══════════════════════════════════════════════════════════════════════════════
//  EUGENEX — Render.com Proxy Server
//  Build command: npm install
//  Start command: node server.js
// ══════════════════════════════════════════════════════════════════════════════

const express  = require('express');
const https    = require('https');
const http     = require('http');
const { URL }  = require('url');
const app      = express();
const PORT     = process.env.PORT || 3000;

const ALLOWED_ORIGINS = [
  'https://defrostee.github.io',
];

// ── CORS ───────────────────────────────────────────────────────────────────────
app.use((req, res, next) => {
  const origin  = req.headers.origin;
  const allowed = ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0];
  res.setHeader('Access-Control-Allow-Origin', allowed);
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS, HEAD');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Requested-With');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

app.use(express.raw({ type: '*/*', limit: '10mb' }));

// ── Health ─────────────────────────────────────────────────────────────────────
app.get('/', (req, res) => res.json({ status: 'EUGENEX online' }));

// ── Proxy ──────────────────────────────────────────────────────────────────────
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
    const result = await fetchWithRedirects(targetURL.toString(), {
      method: 'GET',
      headers: {
        'User-Agent':      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept':          'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9',
        'Accept-Encoding': 'identity',
        'Cache-Control':   'no-cache',
      },
    });

    const contentType = result.headers['content-type'] || '';
    const proxyBase   = `${req.protocol}://${req.get('host')}`;
    const proxyPrefix = `${proxyBase}/proxy?url=`;
    const finalURL    = result.finalURL;

    const skip = new Set([
      'content-security-policy','content-security-policy-report-only',
      'x-frame-options','strict-transport-security','x-content-type-options',
      'transfer-encoding','connection','keep-alive','set-cookie',
    ]);
    Object.entries(result.headers).forEach(([k, v]) => {
      if (!skip.has(k.toLowerCase())) {
        try { res.setHeader(k, v); } catch {}
      }
    });

    res.status(result.status);

    if (contentType.includes('text/html')) {
      const html = rewriteHTML(result.body.toString('utf8'), finalURL, proxyPrefix);
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      return res.send(html);
    }

    if (contentType.includes('text/css')) {
      const css = rewriteCSS(result.body.toString('utf8'), finalURL, proxyPrefix);
      res.setHeader('Content-Type', contentType);
      return res.send(css);
    }

    res.send(result.body);

  } catch (err) {
    res.status(502).json({ error: 'Proxy error: ' + err.message });
  }
});

// ── Fetch with manual redirect following ───────────────────────────────────────
function fetchWithRedirects(urlStr, options, redirectCount = 0) {
  return new Promise((resolve, reject) => {
    if (redirectCount > 15) return reject(new Error('Too many redirects'));

    let parsed;
    try { parsed = new URL(urlStr); }
    catch (e) { return reject(e); }

    const lib = parsed.protocol === 'https:' ? https : http;

    const reqOptions = {
      hostname: parsed.hostname,
      port:     parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
      path:     parsed.pathname + parsed.search,
      method:   options.method || 'GET',
      headers:  { ...options.headers, Host: parsed.hostname },
      timeout:  15000,
    };

    const request = lib.request(reqOptions, (response) => {
      if ([301, 302, 303, 307, 308].includes(response.statusCode)) {
        const location = response.headers['location'];
        if (!location) return reject(new Error('Redirect with no location'));
        const next = new URL(location, urlStr).toString();
        response.resume();
        return resolve(fetchWithRedirects(next, options, redirectCount + 1));
      }

      const chunks = [];
      response.on('data', chunk => chunks.push(chunk));
      response.on('end', () => {
        resolve({
          status:   response.statusCode,
          headers:  response.headers,
          body:     Buffer.concat(chunks),
          finalURL: urlStr,
        });
      });
      response.on('error', reject);
    });

    request.on('error', reject);
    request.on('timeout', () => { request.destroy(); reject(new Error('Request timed out')); });
    request.end();
  });
}

// ── HTML rewriter ──────────────────────────────────────────────────────────────
function rewriteHTML(html, base, proxyPrefix) {
  html = html.replace(/(href|src|action|data-src)=["']([^"']+)["']/gi, (match, attr, val) => {
    const abs = resolveURL(val, base);
    if (!abs || abs.startsWith('data:') || abs.startsWith('javascript:') || val.startsWith('#')) return match;
    return `${attr}="${proxyPrefix}${encodeURIComponent(abs)}"`;
  });

  html = html.replace(/url\(["']?([^)"'\s]+)["']?\)/gi, (match, val) => {
    const abs = resolveURL(val, base);
    if (!abs || abs.startsWith('data:')) return match;
    return `url("${proxyPrefix}${encodeURIComponent(abs)}")`;
  });

  const patch = `<script>
(function(){
  var P="${proxyPrefix}",B="${base}";
  function px(u){
    if(!u||u.startsWith('data:')||u.startsWith('blob:')||u.startsWith('#'))return u;
    try{return P+encodeURIComponent(new URL(u,B).href);}catch(e){return u;}
  }
  var _f=window.fetch;
  window.fetch=function(i,o){
    if(typeof i==='string')i=px(i);
    else if(i instanceof Request)i=new Request(px(i.url),i);
    return _f.call(this,i,o);
  };
  var _o=XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open=function(m,u){
    return _o.apply(this,[m,px(String(u))].concat([].slice.call(arguments,2)));
  };
})();
<\/script>`;

  return /<head[\s>]/i.test(html)
    ? html.replace(/(<head[\s>][^>]*>)/i, '$1' + patch)
    : patch + html;
}

// ── CSS rewriter ───────────────────────────────────────────────────────────────
function rewriteCSS(css, base, proxyPrefix) {
  return css.replace(/url\(["']?([^)"'\s]+)["']?\)/gi, (match, val) => {
    const abs = resolveURL(val.trim(), base);
    if (!abs || abs.startsWith('data:')) return match;
    return `url("${proxyPrefix}${encodeURIComponent(abs)}")`;
  });
}

// ── Helpers ────────────────────────────────────────────────────────────────────
function resolveURL(val, base) {
  val = val.trim();
  if (!val || val.startsWith('data:') || val.startsWith('javascript:')) return null;
  try { return new URL(val, base).toString(); } catch { return null; }
}

function isPrivateHost(host) {
  return (
    host === 'localhost' || host === '127.0.0.1' ||
    /^192\.168\./.test(host) || /^10\./.test(host) ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(host) || host.endsWith('.local')
  );
}

app.listen(PORT, () => console.log(`EUGENEX running on port ${PORT}`));
