// ══════════════════════════════════════════════════════════════════════════════
//  EUGENEX — Bare Server for Render
//  Build command: npm install
//  Start command: node server.js
// ══════════════════════════════════════════════════════════════════════════════

const http = require('http');
const { createBareServer } = require('bare-server-node');

const bareServer = createBareServer('/bare/');
const PORT = process.env.PORT || 3000;

const server = http.createServer((req, res) => {
  if (bareServer.shouldRoute(req)) {
    bareServer.routeRequest(req, res);
  } else {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'EUGENEX bare server online' }));
  }
});

server.on('upgrade', (req, socket, head) => {
  if (bareServer.shouldRoute(req)) {
    bareServer.routeUpgrade(req, socket, head);
  } else {
    socket.destroy();
  }
});

server.listen(PORT, () => console.log(`EUGENEX bare server running on port ${PORT}`));
