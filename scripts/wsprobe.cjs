const WS = require('ws');
const fs = require('fs');
const port = parseInt(process.env.PORT || '14100', 10);
const { token } = JSON.parse(
  fs.readFileSync(process.env.HOME + '/.mtmux/config.json', 'utf8')
);
const ws = new WS('ws://127.0.0.1:' + port + '/_relay');
ws.on('open', () => {
  console.log('[c] open, sending auth');
  ws.send(JSON.stringify({ type: 'auth', token }));
});
let received = 0;
ws.on('message', (d) => {
  received++;
  let msg;
  try { msg = JSON.parse(d.toString()); } catch { msg = { _raw: d.toString().slice(0, 80) }; }
  console.log('[c] msg', received, msg.type, msg.type === 'auth:failure' ? msg.reason : '');
  if (msg.type === 'auth:success') {
    setTimeout(() => {
      console.log('[c] sending session:list');
      ws.send(JSON.stringify({ type: 'session:list' }));
    }, 500);
  }
});
ws.on('close', (code, reason) => {
  console.log('[c] CLOSE', code, reason.toString());
  process.exit(0);
});
ws.on('error', (err) => console.log('[c] err', err.message));
setTimeout(() => { console.log('[c] timeout'); ws.close(); }, 8000);
