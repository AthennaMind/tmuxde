// Usage: node record.js <scene>
// Captures lossless PNG frames at 2.4x through the CDP screencast, then renders
// a 1920x1080 GIF and MP4 into .local/showcase/ with ffmpeg in Docker.
// Scenes with `png: true` take screenshots instead and may `compose` them.
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { OUT, WORK, launch, login, finish, sleep } = require('./lib');

const CURSOR = `
(() => {
  const style = document.createElement('style');
  style.textContent = '#__cur{position:fixed;left:0;top:0;width:24px;height:24px;pointer-events:none;z-index:2147483647;transform:translate(-3px,-2px);filter:drop-shadow(0 1px 2px rgba(0,0,0,.6));transition:transform .08s}' +
    '#__cur.down{transform:translate(-3px,-2px) scale(.85)}';
  const svg = '<svg id="__cur" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg"><path d="M5 3l14 9-6.5 1.2L16 20l-2.6 1.2-3.5-6.6L5 19z" fill="#fff" stroke="#000" stroke-width="1.4" stroke-linejoin="round"/></svg>';
  const add = () => { if (document.getElementById('__cur')) return; document.head.appendChild(style); document.body.insertAdjacentHTML('beforeend', svg); };
  if (document.body) add(); else document.addEventListener('DOMContentLoaded', add);
  let x = -100, y = -100;
  const place = () => { const c = document.getElementById('__cur'); if (c) c.style.left = x + 'px', c.style.top = y + 'px'; };
  document.addEventListener('mousemove', (e) => { x = e.clientX; y = e.clientY; place(); }, true);
  document.addEventListener('mousedown', () => document.getElementById('__cur')?.classList.add('down'), true);
  document.addEventListener('mouseup', () => document.getElementById('__cur')?.classList.remove('down'), true);
  new MutationObserver(() => { add(); place(); }).observe(document.documentElement, { childList: true, subtree: false });
})();`;

const FF = (args) => execFileSync('docker', ['run', '--rm', '-u', `${process.getuid()}:${process.getgid()}`, '-v', `${WORK}:/work`, '-v', `${OUT}:/out`, '-w', '/work', 'mwader/static-ffmpeg:7.1', '-hide_banner', '-loglevel', 'error', '-y', ...args], { stdio: 'inherit' });

async function main() {
  const name = process.argv[2];
  if (!name) throw new Error('usage: node record.js <scene>');
  const scene = require(path.join(__dirname, '..', 'scenes', name + '.js'));
  const opts = Object.assign({ width: 1600, height: 900, scale: 2.4 }, scene.viewport || {});
  for (const d of [OUT, path.join(WORK, 'frames')]) fs.mkdirSync(d, { recursive: true });
  const s = await launch(opts);
  if (!scene.png) {
    await s.context.addInitScript(CURSOR);
    await s.context.addInitScript(() => { try { localStorage.setItem('tmuxde-sidebar', JSON.stringify({ view: 'sessions', width: 360, collapsed: false })); } catch {} });
  }
  await login(s.page);
  await s.page.mouse.move(opts.width - 260, opts.height - 140);
  s.page.__cursor = { x: opts.width - 260, y: opts.height - 140 };
  if (scene.prepare) await scene.prepare(s.page);

  if (scene.png) {
    await scene.run(s.page, path.join(WORK, 'frames'));
    await finish(s);
    if (scene.compose) {
      const inputs = scene.compose.flatMap((f) => ['-i', `frames/${f}`]);
      const pads = scene.compose.map((_, i) => `[${i}]pad=iw+60:ih+60:30:30:color=#0b0b0b[p${i}]`).join(';');
      const stack = scene.compose.map((_, i) => `[p${i}]`).join('') + `hstack=${scene.compose.length},scale=1920:-1:flags=lanczos`;
      FF([...inputs, '-filter_complex', `${pads};${stack}`, `/out/${name}.png`]);
      console.log(`${name}: ${name}.png ${Math.round(fs.statSync(path.join(OUT, name + '.png')).size / 1024)} KB`);
    }
    return;
  }

  const rawDir = path.join(WORK, 'raw', name);
  fs.rmSync(rawDir, { recursive: true, force: true });
  fs.mkdirSync(rawDir, { recursive: true });
  const cdp = await s.context.newCDPSession(s.page);
  const frames = [];
  let seq = 0;
  cdp.on('Page.screencastFrame', async (ev) => {
    const file = path.join(rawDir, `f${String(seq++).padStart(5, '0')}.png`);
    fs.writeFileSync(file, Buffer.from(ev.data, 'base64'));
    frames.push({ t: ev.metadata.timestamp, file });
    await cdp.send('Page.screencastFrameAck', { sessionId: ev.sessionId }).catch(() => {});
  });
  await cdp.send('Page.startScreencast', { format: 'png', everyNthFrame: 1, maxWidth: Math.round(opts.width * opts.scale), maxHeight: Math.round(opts.height * opts.scale) });
  await sleep(700);
  const t0 = Date.now() / 1000;
  const wall0 = frames.length ? frames[frames.length - 1].t : null;
  await scene.run(s.page);
  await sleep(400);
  await cdp.send('Page.stopScreencast');
  const t1 = Date.now() / 1000;
  await finish(s);

  // Resample the change driven frames to a constant rate.
  const fps = scene.fps || 12;
  const start = wall0 && Math.abs(wall0 - t0) < 5 ? t0 : frames[0].t;
  const end = start + (t1 - t0);
  const seqDir = path.join(WORK, 'seq', name);
  fs.rmSync(seqDir, { recursive: true, force: true });
  fs.mkdirSync(seqDir, { recursive: true });
  let i = 0, n = 0;
  for (let t = start; t <= end; t += 1 / fps) {
    while (i + 1 < frames.length && frames[i + 1].t <= t) i++;
    fs.linkSync(frames[i].file, path.join(seqDir, `${String(n++).padStart(5, '0')}.png`));
  }
  const w = scene.outWidth || 1920;
  FF(['-framerate', String(fps), '-i', `seq/${name}/%05d.png`, '-vf', `scale=${w}:-1:flags=lanczos,split[a][b];[a]palettegen=max_colors=256:stats_mode=full[p];[b][p]paletteuse=dither=none:diff_mode=rectangle`, `/out/${name}.gif`]);
  FF(['-framerate', String(fps), '-i', `seq/${name}/%05d.png`, '-vf', `scale=${w}:-2:flags=lanczos`, '-c:v', 'libx264', '-preset', 'slow', '-crf', '18', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', `/out/${name}.mp4`]);
  const kb = (f) => Math.round(fs.statSync(path.join(OUT, f)).size / 1024);
  console.log(`${name}: ${(t1 - t0).toFixed(1)}s, ${frames.length} captured frames, ${n} output frames -> ${name}.gif ${kb(name + '.gif')} KB, ${name}.mp4 ${kb(name + '.mp4')} KB`);
}
main().catch((e) => { console.error(e); process.exit(1); });
