const { sleep, typeSlow, clickAt, resetWork } = require('../scripts/lib');
const term = (page) => page.getByRole('group', { name: /^Terminal, session work/ });
async function focusTerm(page) {
  const b = await term(page).boundingBox();
  await clickAt(page, { x: b.x + b.width * 0.55, y: b.y + b.height * 0.5 }, 350); await sleep(350);
}
module.exports = {
  async prepare(page) {
    resetWork(); await sleep(1500);
    await page.locator('[data-tree-row="s:work"]').click();
    await sleep(2000);
    await page.getByRole('button', { name: /^Files/ }).first().click();
    await sleep(1500);
  },
  async run(page) {
    await focusTerm(page);
    await typeSlow(page, 'cd orders-api && ls --color', 70); await page.keyboard.press('Enter');
    await sleep(3200);
    await clickAt(page, page.getByRole('button', { name: /^Changes/ }).first());
    await sleep(2600);
    await focusTerm(page);
    await typeSlow(page, 'cd ../orders-web && ls --color', 70); await page.keyboard.press('Enter');
    await sleep(3200);
    await clickAt(page, page.getByRole('button', { name: /^Files/ }).first());
    await sleep(2200);
    await focusTerm(page);
    await typeSlow(page, 'cd ../tmux && ls --color', 70); await page.keyboard.press('Enter');
    await sleep(3000);
    await clickAt(page, page.getByRole('button', { name: /^History/ }).first());
    await sleep(2800);
  },
};
