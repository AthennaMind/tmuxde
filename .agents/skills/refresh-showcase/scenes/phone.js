const { sleep } = require('../scripts/lib');
// Three phone screenshots composed side by side into phone.png.
module.exports = {
  png: true,
  viewport: { width: 390, height: 844, scale: 3, mobile: true },
  compose: ['phone-sessions.png', 'phone-terminal.png', 'phone-files.png'],
  async run(page, out) {
    const nav = (n) => page.locator('nav[aria-label="Workspace"] a, nav[aria-label="Workspace"] button').filter({ hasText: n }).first();
    await nav('Sessions').click(); await sleep(1500);
    await page.screenshot({ path: `${out}/phone-sessions.png` });
    await page.getByText('orders-api', { exact: true }).first().click();
    await sleep(2500);
    await page.screenshot({ path: `${out}/phone-terminal.png` });
    await nav('Files').click(); await sleep(2500);
    await page.screenshot({ path: `${out}/phone-files.png` });
  },
};
