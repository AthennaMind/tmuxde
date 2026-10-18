const { sleep, clickAt } = require('../scripts/lib');
module.exports = {
  async prepare(page) {
    await page.locator('[data-tree-row="s:orders-api"]').click();
    await sleep(2000);
    await page.getByRole('button', { name: /^Changes/ }).first().click();
    await sleep(1500);
  },
  async run(page) {
    const row = (name) => page.getByRole('button', { name: new RegExp(name) }).first();
    await clickAt(page, row('orders\\.go'), 500); await sleep(3000);
    await clickAt(page, row('dispatch_test\\.go'), 450); await sleep(2400);
    await clickAt(page, page.getByRole('button', { name: /^History/ }).first()); await sleep(2200);
    const commit = page.locator('ul[aria-label="Commits"] button').first();
    if (await commit.count()) { await clickAt(page, commit, 450); await sleep(2600); }
    await clickAt(page, page.getByRole('button', { name: /^Sessions/ }).first()); await sleep(1200);
    await clickAt(page, page.locator('[data-tree-row="s:agents"]'), 500); await sleep(2200);
    await clickAt(page, page.getByRole('button', { name: /^History/ }).first()); await sleep(2200);
    const graph = page.getByRole('button', { name: /^Open graph/ });
    if (await graph.count()) { await clickAt(page, graph, 450); await sleep(3200); }
  },
};
