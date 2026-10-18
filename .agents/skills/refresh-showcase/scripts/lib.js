// Shared helpers for showcase recordings. Node on the host, Playwright from playwright-cli.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..', '..', '..');
const OUT = path.join(ROOT, '.local', 'showcase');
const WORK = path.join(os.tmpdir(), 'tmuxde-showcase');
const BASE = process.env.SHOWCASE_URL || 'http://localhost:24200';

function playwrightCore() {
  if (process.env.PLAYWRIGHT_CORE) return require(process.env.PLAYWRIGHT_CORE);
  try { return require('playwright-core'); } catch {}
  const roots = [path.join(os.homedir(), '.local/share/pnpm/global'), path.join(os.homedir(), '.npm-global/lib/node_modules')];
  for (const root of roots) {
    if (!fs.existsSync(root)) continue;
    const hit = execFileSync('find', [root, '-maxdepth', '9', '-type', 'd', '-path', '*node_modules/playwright-core', '-not', '-path', '*/playwright-core/*'], { encoding: 'utf8' }).split('\n').filter(Boolean)[0];
    if (hit) return require(hit);
  }
  throw new Error('playwright-core not found. Install playwright-cli or set PLAYWRIGHT_CORE.');
}
const { chromium } = playwrightCore();

function token() {
  const env = fs.readFileSync(path.join(ROOT, '.env'), 'utf8');
  const m = env.match(/^AUTH_TOKEN=(.*)$/m);
  if (!m) throw new Error('AUTH_TOKEN missing in .env');
  return m[1].trim();
}

async function launch({ width = 1440, height = 900, scale = 1, mobile = false, args = [] } = {}) {
  const browser = await chromium.launch({ headless: true, args });
  const context = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: scale, ignoreHTTPSErrors: true, colorScheme: 'dark', isMobile: mobile, hasTouch: mobile });
  const page = await context.newPage();
  page.on('console', (m) => { if (m.type() === 'error') console.error('[console]', m.text().slice(0, 200)); });
  return { browser, context, page };
}

async function login(page) {
  await page.goto(`${BASE}/login#token=${token()}`);
  await page.waitForURL((u) => !u.pathname.startsWith('/login'), { timeout: 20000 });
  await page.waitForTimeout(1500);
}

async function finish({ browser, context, page }) {
  await page.close();
  await context.close();
  await browser.close();
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Human paced typing into the focused terminal.
async function typeSlow(page, text, delay = 70) { await page.keyboard.type(text, { delay }); }

// Timed cursor movement. The screencast only emits frames on repaint, so a
// glide with real delays is what makes the cursor visible in the clip.
async function glideTo(page, target, ms = 450) {
  const b = typeof target.boundingBox === 'function' ? await target.boundingBox() : target;
  if (!b) return false;
  const tx = b.width != null ? b.x + b.width / 2 : b.x;
  const ty = b.height != null ? b.y + b.height / 2 : b.y;
  const from = page.__cursor || { x: tx - 200, y: ty + 120 };
  const steps = Math.max(8, Math.round(ms / 25));
  for (let i = 1; i <= steps; i++) {
    const k = i / steps; const e = 1 - Math.pow(1 - k, 3);
    await page.mouse.move(from.x + (tx - from.x) * e, from.y + (ty - from.y) * e);
    await sleep(ms / steps);
  }
  page.__cursor = { x: tx, y: ty };
  return true;
}

async function clickAt(page, target, ms) {
  if (!(await glideTo(page, target, ms))) return false;
  await sleep(220); await page.mouse.down(); await sleep(90); await page.mouse.up();
  return true;
}

// tmux against the dev server socket inside server-dev. $T is the tmux prefix.
function devTmux(script) {
  return execFileSync('docker', ['compose', '-f', path.join(ROOT, 'docker-compose.yml'), 'exec', '-T', 'server-dev', 'bash', '-c', `T="tmux -S /tmp/tmuxde-dev.sock"; ${script}`], { encoding: 'utf8' });
}

// Fresh shell for the cwd scene.
function resetWork() {
  devTmux('$T kill-session -t =work 2>/dev/null; $T new-session -d -s work -n shell -c /home/dev/projects; $T send-keys -t work:shell "clear; ls --color" Enter');
}

module.exports = { ROOT, OUT, WORK, BASE, launch, login, finish, sleep, typeSlow, glideTo, clickAt, devTmux, resetWork };
