const { sleep, glideTo, resetWork } = require('../scripts/lib');
module.exports = {
  async prepare(page) {
    resetWork(); await sleep(1500);
    await page.locator('[data-tree-row="s:work"]').click();
    await sleep(2000);
  },
  async run(page) {
    const api = page.getByRole('group', { name: /^Panes of window 0 api/ });
    const mon = page.getByRole('group', { name: /^Panes of window 0 monitor/ });
    const targets = [
      api.getByRole('button', { name: /^Pane 1/ }),
      mon.getByRole('button', { name: /^Pane 0/ }),
      mon.getByRole('button', { name: /^Pane 1/ }),
      mon.getByRole('button', { name: /^Pane 3/ }),
      page.locator('[data-tree-row^="w:"]', { hasText: 'vi' }).first(),
      page.locator('[data-tree-row^="w:"]', { hasText: 'web' }).first(),
    ];
    for (const t of targets) { if (await glideTo(page, t, 550)) await sleep(1800); }
    await glideTo(page, { x: 1200, y: 600 }, 500); await sleep(1000);
  },
};
