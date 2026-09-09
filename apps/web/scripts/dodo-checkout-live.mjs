/**
 * Buy Pro, for real, with a Dodo **test** card — then prove the plan flipped.
 *
 *   node scripts/dodo-checkout-live.mjs
 *   node scripts/dodo-checkout-live.mjs --interval yearly --api https://api.mtmux.com
 *   node scripts/dodo-checkout-live.mjs --headed          # watch it happen
 *
 * ## Why this is not a spec in `e2e/`
 *
 * It signs up a real account on a real broker, opens a real hosted checkout at
 * a third party, and waits on a webhook delivered over the public internet.
 * None of that belongs in a suite that runs on every commit — it would be slow,
 * flaky, and would leave rows behind. `e2e/billing.spec.ts` stubs `/v1/billing`
 * and owns the permanent coverage; **this** is what proves the stub is telling
 * the truth about the shape the broker really sends.
 *
 * ## What it has already caught
 *
 * That scheduling a cancellation never reached the dashboard. Dodo does not
 * emit `subscription.cancelled` for that — the subscription stays `active` and
 * only `cancel_at_next_billing_date` flips, delivered as
 * `subscription.updated`, which had no handler and was not in the endpoint's
 * event filter. The symptom was invisible from the outside: someone cancels,
 * and the panel keeps saying "Renews on …" until the day it stops.
 *
 * ## Safety
 *
 * Refuses to run unless the broker reports a `test.` checkout host. There is no
 * flag to override that. A live-mode charge is not a thing this script should
 * be one typo away from.
 */
import { chromium } from "@playwright/test";

const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? fallback : process.argv[i + 1];
};

const API = arg("api", process.env.API_BASE ?? "https://api.mtmux.com");
const APP_ORIGIN = arg("origin", "https://app.mtmux.com");
const interval = arg("interval", "monthly");
const headed = process.argv.includes("--headed");

/** Dodo's US Visa success card. Expiry must be 06/32; CVV 123. */
const CARD = { number: "4242 4242 4242 4242", expiry: "06/32", cvv: "123" };

const email = `dodo-live-check+${Date.now()}@mtmux-verify.test`;
const password = "REMOVED";

const json = async (res) => ({ status: res.status, body: await res.json().catch(() => null) });

console.log(`api      ${API}`);
console.log(`account  ${email}`);
console.log(`interval ${interval}\n`);

// ---- A throwaway account -------------------------------------------------
const signUp = await json(
  await fetch(`${API}/api/auth/sign-up/email`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: APP_ORIGIN },
    body: JSON.stringify({ email, password, name: "Dodo Live Check" }),
  }),
);
const token = signUp.body?.token;
if (!token) {
  console.error(`sign-up failed: ${signUp.status} ${JSON.stringify(signUp.body)}`);
  process.exit(1);
}
console.log(`user     ${signUp.body.user.id}`);

const api = async (path, init = {}) =>
  json(
    await fetch(`${API}${path}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        ...init.headers,
      },
    }),
  );

const before = await api("/v1/billing");
if (!before.body?.billingEnabled) {
  console.error("billingEnabled is false — the broker has no payment provider. Nothing to test.");
  process.exit(1);
}
console.log(`before   plan=${before.body.plan} source=${before.body.planSource}\n`);

const created = await api("/v1/billing/checkout", {
  method: "POST",
  body: JSON.stringify({ plan: "pro", interval }),
});
const url = created.body?.url;
if (created.status !== 200 || !url) {
  console.error(`checkout failed: ${created.status} ${JSON.stringify(created.body)}`);
  process.exit(1);
}
if (!/^https:\/\/test\./.test(url)) {
  console.error(`REFUSING: checkout is not a test host — ${url}\nThis script must never touch a real card.`);
  process.exit(1);
}
console.log(`checkout ${url}\n`);

// ---- Pay -----------------------------------------------------------------
const browser = await chromium.launch({ headless: !headed });
const page = await browser.newPage({ viewport: { width: 1280, height: 1100 } });
page.on("pageerror", (e) => console.log(`  [pageerror] ${e.message.slice(0, 200)}`));

/**
 * Fill a field wherever it lives.
 *
 * Dodo's card step mounts inputs inside nested third-party frames (Airwallex,
 * Stripe), and the frame layout is theirs to change. Searching every frame for
 * any of several plausible selectors is the only version of this that does not
 * break the first time they reorganise it.
 */
async function fillAnywhere(selectors, value, label) {
  for (const frame of page.frames()) {
    if (/sardine|about:blank/.test(frame.url())) continue;
    for (const selector of selectors) {
      const locator = frame.locator(selector).first();
      if ((await locator.count()) === 0) continue;
      try {
        await locator.fill(value, { timeout: 5000 });
        return true;
      } catch {
        try {
          await locator.click({ timeout: 3000 });
          await locator.type(value, { delay: 40 });
          return true;
        } catch {
          /* next candidate */
        }
      }
    }
  }
  console.log(`  !! could not fill ${label}`);
  return false;
}

let paid = false;
try {
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60_000 });
  await page.waitForTimeout(4500);

  // Step 1 — billing details. Name and email arrive prefilled and *locked*,
  // because the checkout session attaches the customer; only the address is
  // ours to supply.
  await page
    .selectOption('select[name="country"]', "US")
    .catch(() => page.selectOption('select[name="country"]', { label: "United States" }));
  await page.waitForTimeout(1000);

  // The address field is a lookup widget by default; this swaps it for plain
  // inputs, which is the only version that is scriptable.
  const manual = page.getByRole("button", { name: /Enter address manually/i });
  if (await manual.count()) {
    await manual.click();
    await page.waitForTimeout(1000);
  }

  for (const [selector, value] of [
    ['input[name="addressLine"]', "1 Market Street"],
    ['input[name="city"]', "San Francisco"],
    ['input[name="state"]', "California"],
    ['input[name="zipCode"]', "94105"],
  ]) {
    await page.fill(selector, value).catch(() => console.log(`  !! ${selector}`));
  }

  await page.getByRole("button", { name: /Continue to Payment/i }).click();
  await page.waitForTimeout(6000);

  // Step 2 — the card.
  await fillAnywhere(
    ['input[placeholder*="1234"]', 'input[autocomplete="cc-number"]', 'input[name="cardNumber"]'],
    CARD.number,
    "card number",
  );
  await fillAnywhere(
    ['input[autocomplete="cc-exp"]', 'input[name="expiry"]', 'input[placeholder*="MM"]'],
    CARD.expiry,
    "expiry",
  );
  await fillAnywhere(
    ['input[autocomplete="cc-csc"]', 'input[name="cvc"]', 'input[placeholder*="CVC"]'],
    CARD.cvv,
    "cvv",
  );

  const pay = page.getByRole("button", { name: /Pay now|Pay |Subscribe|Confirm/i }).last();
  if (!(await pay.count())) throw new Error("no pay button on the card step");
  await pay.click();
  await page.waitForTimeout(8000);
  paid = true;
} catch (error) {
  console.error(`\ncheckout failed: ${error.message}`);
  await page.screenshot({ path: "dodo-checkout-failure.png", fullPage: true });
  console.error("screenshot: apps/web/dodo-checkout-failure.png");
} finally {
  await browser.close();
}

if (!paid) process.exit(1);

// ---- Did the webhook land? -----------------------------------------------
console.log("\npolling /v1/billing for the webhook…");
for (let i = 0; i < 20; i++) {
  const { body } = await api("/v1/billing");
  console.log(`  ${String(i * 3).padStart(2)}s  plan=${body?.plan} source=${body?.planSource} status=${body?.status}`);
  if (body?.planSource === "paid") {
    console.log("\n✓ PAID — the webhook landed and the plan flipped.");
    const portal = await api("/v1/billing/portal", { method: "POST", body: "{}" });
    console.log(`✓ portal ${portal.status}: ${portal.body?.url ? "link issued" : JSON.stringify(portal.body)}`);
    console.log(
      "\nTo finish the round trip, schedule a cancellation and watch " +
        "cancelAtPeriodEnd flip:\n" +
        "  pnpm --filter @app/api exec tsx -e \"import D from 'dodopayments';\" …\n" +
        "  (see e2e/MANUAL.md)",
    );
    process.exit(0);
  }
  await new Promise((r) => setTimeout(r, 3000));
}
console.error("\n✗ NOT PAID within 60s — the webhook did not arrive, or was rejected.");
console.error("  Check: the endpoint's signing secret matches DODO_WEBHOOK_KEY on the");
console.error("  *running* process (--env-file is read at start, not on reload).");
process.exit(1);
