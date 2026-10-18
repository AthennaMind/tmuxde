const { sleep, glideTo, clickAt, devTmux } = require('../scripts/lib');
module.exports = {
  async prepare(page) {
    devTmux('$T send-keys -t work:shell "clear; git -C tmux --no-pager log --oneline --decorate --color -n 80" Enter');
    await page.locator('[data-tree-row="s:agents"]').click();
    await sleep(2000);
    devTmux('$T resize-pane -t agents:0.0 -x 86');
    await sleep(2500);
  },
  async run(page) {
    await sleep(2500);
    await clickAt(page, page.getByRole('button', { name: /^Hide sidebar/ }));
    await sleep(3500);
    await clickAt(page, page.getByRole('button', { name: /^Overview/ }).first());
    await sleep(1000);
    await page.mouse.wheel(0, 40); await sleep(250); await page.mouse.wheel(0, -40);
    await sleep(2500);
    const cards = page.locator('ul[aria-label="Terminal previews"] > li');
    const n = await cards.count();
    for (const i of [3, 4, 5].filter((i) => i < n)) { await glideTo(page, cards.nth(i), 500); await sleep(900); }
    const tig = page.getByRole('button', { name: /tig.*agents/ }).first();
    if (await tig.count()) { await clickAt(page, tig, 600); await sleep(2600); }
  },
};
