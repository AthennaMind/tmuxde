const { sleep, typeSlow, clickAt } = require('../scripts/lib');
module.exports = {
  async prepare(page) {
    await page.locator('[data-tree-row="s:orders-web"]').click();
    await sleep(2000);
  },
  async run(page) {
    const b = await page.getByRole('group', { name: /^Terminal, session orders-web/ }).boundingBox();
    await clickAt(page, { x: b.x + b.width * 0.5, y: b.y + b.height * 0.5 }, 350); await sleep(400);
    await page.keyboard.press('Control+k'); await sleep(1600);
    await typeSlow(page, 'catppuccin', 90); await sleep(1300);
    const opt = page.getByRole('option', { name: /Catppuccin/ });
    if (await opt.count()) await clickAt(page, opt, 500); else await page.keyboard.press('Escape');
    await sleep(2300);
    await page.keyboard.press('Control+p'); await sleep(1300);
    await typeSlow(page, 'orderl', 90); await sleep(1300);
    await page.keyboard.press('Enter'); await sleep(2800);
    await page.keyboard.press('Control+Shift+f'); await sleep(1300);
    await typeSlow(page, 'PASS', 90); await sleep(400);
    await page.keyboard.press('Enter'); await sleep(3000);
    await page.keyboard.press('Escape'); await sleep(700);
  },
};
