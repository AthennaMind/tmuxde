const { sleep, clickAt } = require('../scripts/lib');
module.exports = {
  async run(page) {
    await clickAt(page, page.locator('section[aria-label="Dev Alpha"] [data-tree-row="s:dev"]'), 500); await sleep(2600);
    await clickAt(page, page.getByRole('button', { name: /^Files/ }).first()); await sleep(2600);
    await clickAt(page, page.getByRole('button', { name: /^Changes/ }).first()); await sleep(2000);
    const row = page.getByRole('button', { name: /edge-01\.yaml/ }).first();
    if (await row.count()) { await clickAt(page, row, 450); await sleep(2600); }
    await clickAt(page, page.getByRole('button', { name: /^Sessions/ }).first()); await sleep(1200);
    await clickAt(page, page.locator('section[aria-label="Dev Beta"] [data-tree-row="s:dev"]'), 500); await sleep(2600);
  },
};
