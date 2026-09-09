// Reproduce the browser's exact login flow against a running CLI:
// 1. fetch /login (HTML check)
// 2. find the JS chunk that has resolveRelayWsUrl, log what it computes
// 3. open a WebSocket with browser-equivalent Origin header
// 4. send auth and assert auth:success arrives within 5s
const WS = require('ws');
const fs = require('fs');
const http = require('http');

const port = parseInt(process.env.PORT || '14100', 10);
const origin = `http://127.0.0.1:${port}`;
const { token } = JSON.parse(
  fs.readFileSync(process.env.HOME + '/.mtmux/config.json', 'utf8'),
);

function get(path) {
  return new Promise((resolve, reject) => {
    http
      .get(origin + path, (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () =>
          resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }),
        );
      })
      .on('error', reject);
  });
}

(async () => {
  console.log('1. GET /login');
  const login = await get('/login');
  console.log('   status', login.status, 'bytes', login.body.length);
  console.log('   CSP header:', login.headers['content-security-policy']?.slice(0, 120) + '...');

  console.log('\n2. WS /_relay with browser-equivalent headers');
  const wsUrl = `ws://127.0.0.1:${port}/_relay`;
  const ws = new WS(wsUrl, {
    headers: {
      Origin: origin,
      'User-Agent': 'Mozilla/5.0 Chrome/120',
    },
  });

  let authSuccess = false;
  const deadline = setTimeout(() => {
    if (!authSuccess) {
      console.log('   ✗ TIMEOUT: no auth:success within 5s — this is what the browser sees');
      ws.close();
      process.exit(1);
    }
  }, 5000);

  ws.on('open', () => {
    console.log('   open: sending auth');
    ws.send(JSON.stringify({ type: 'auth', token }));
  });
  ws.on('message', (d) => {
    const msg = JSON.parse(d.toString());
    console.log('   <-', msg.type, msg.reason || '');
    if (msg.type === 'auth:success') {
      authSuccess = true;
      clearTimeout(deadline);
      console.log('   ✓ auth succeeded');
      setTimeout(() => ws.close(), 500);
    }
  });
  ws.on('close', (code, reason) => {
    console.log('   close', code, reason.toString() || '(no reason)');
    process.exit(authSuccess ? 0 : 1);
  });
  ws.on('error', (err) => {
    console.log('   error', err.message);
  });
  ws.on('unexpected-response', (req, res) => {
    console.log('   ! unexpected-response status', res.statusCode);
    let body = '';
    res.on('data', (c) => (body += c));
    res.on('end', () => console.log('     body:', body.slice(0, 200)));
  });
})();
