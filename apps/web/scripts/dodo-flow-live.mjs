/**
 * The whole purchase, driven through the real app, exactly as a person does it.
 *
 *   node scripts/dodo-flow-live.mjs                    # India card (default)
 *   node scripts/dodo-flow-live.mjs --card us-visa --country US
 *   node scripts/dodo-flow-live.mjs --headed
 *
 * ## How this differs from `dodo-checkout-live.mjs`
 *
 * That script signs up over the API and creates the checkout over the API. It
 * proves the *provider* works. It does not prove that a person clicking
 * "Upgrade to Pro" in the dashboard ends up on Pro — which is the thing anyone
 * actually cares about, and which has a different failure mode: a checkout
 * created outside `/v1/billing/checkout` carries no `metadata.userId`, so its
 * webhook is correctly ignored as "an unknown customer" and no plan is granted.
 *
 * So this one starts at the register page and ends at the billing panel, and
 * touches nothing that a browser would not.
 *
 * ## The India route
 *
 * A ₹ payment from an Indian billing address is settled by an Indian acquirer,
 * and the US test cards are not valid on it — `4242…` fails with "Payment mode
 * not enabled for this merchant". India needs its own test cards, needs the
 * cardholder-name field the US form does not have, and finishes at Cashfree's
 * simulator where the outcome is chosen by a button rather than by the card.
 */
import { chromium } from "@playwright/test";

const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? fallback : process.argv[i + 1];
};

const APP = arg("app", "https://app.mtmux.com");
const API = arg("api", "https://api.mtmux.com");
const headed = process.argv.includes("--headed");

const CARDS = {
  "in-visa": { number: "4576238912771450", label: "India Visa …1450" },
  "in-mastercard": { number: "5409162669381034", label: "India Mastercard …1034" },
  "us-visa": { number: "4242424242424242", label: "US Visa …4242" },
  "us-mastercard": { number: "5555555555554444", label: "US Mastercard …4444" },
};
const cardKey = arg("card", "in-visa");
const CARD = CARDS[cardKey];
if (!CARD) throw new Error(`unknown --card ${cardKey}; try ${Object.keys(CARDS).join(", ")}`);
const country = arg("country", cardKey.startsWith("in") ? "IN" : "US");

const ADDRESS =
  country === "IN"
    ? { addressLine: "154, gali number 2, hirabagh", city: "Patiala", state: "Punjab", zipCode: "147002" }
    : { addressLine: "1 Market Street", city: "San Francisco", state: "California", zipCode: "94105" };

const stamp = Date.now();
const email = `flow-${stamp}@mtmux-verify.test`;
const password = "REMOVED";

const step = (n, text) => console.log(`\n[${n}] ${text}`);
const ok = (text) => console.log(`    ✓ ${text}`);
const bad = (text) => console.log(`    ✗ ${text}`);

console.log(`app      ${APP}`);
console.log(`api      ${API}`);
console.log(`account  ${email}`);
console.log(`card     ${CARD.label}   country ${country}`);

const browser = await chromium.launch({ headless: !headed });
const page = await browser.newPage({ viewport: { width: 1280, height: 1100 } });
const shot = async (name) => {
  await page.screenshot({ path: `flow-${name}.png`, fullPage: true }).catch(() => {});
};

// Every top-level navigation, timestamped. The return hop from the provider
// back to us is the one step nothing else can observe, and a customer who is
// left on the provider's status page has paid and has no idea we know.
const t0 = Date.now();
page.on("framenavigated", (frame) => {
  if (frame !== page.mainFrame()) return;
  const at = ((Date.now() - t0) / 1000).toFixed(1).padStart(6);
  console.log(`    [nav ${at}s] ${frame.url().slice(0, 110)}`);
});

/** Fill a control wherever it lives — the card fields are in a nested frame. */
async function fillAnywhere(selectors, value, label) {
  for (const frame of page.frames()) {
    if (/sardine|about:blank/.test(frame.url())) continue;
    for (const selector of selectors) {
      const locator = frame.locator(selector).first();
      if ((await locator.count()) === 0) continue;
      try {
        await locator.fill(value, { timeout: 5000 });
        ok(`${label} filled`);
        return true;
      } catch {
        try {
          await locator.click({ timeout: 3000 });
          await locator.type(value, { delay: 40 });
          ok(`${label} typed`);
          return true;
        } catch {
          /* next candidate */
        }
      }
    }
  }
  bad(`could not fill ${label}`);
  return false;
}

let failed = null;
try {
  // ---- 1. Register, in the browser ---------------------------------------
  // Sign-up is progressive: the address is asked for first, and only then does
  // the form decide what to ask for next. So this cannot be one fill-and-submit
  // — it has to follow the same steps a person does.
  step(1, "Register a new account at /signup");
  await page.goto(`${APP}/signup`, { waitUntil: "domcontentloaded", timeout: 60_000 });
  await page.waitForTimeout(3000);
  await page.fill('input[type="email"], input[name="email"]', email);
  await shot("01-signup-email");
  await page.getByRole("button", { name: /continue|next/i }).first().click();
  await page.waitForTimeout(5000);
  await shot("02-signup-step2");

  const passwordField = page.locator('input[type="password"]').first();
  if (await passwordField.count()) {
    await passwordField.fill(password);
    const confirmField = page.locator('input[type="password"]').nth(1);
    if (await confirmField.count()) await confirmField.fill(password);
    const nameField = page.locator('input[name="name"]').first();
    if (await nameField.count()) await nameField.fill("Flow Test");
    await shot("03-signup-password");
    await page
      .getByRole("button", { name: /create account|sign up|continue|finish/i })
      .first()
      .click();
    await page.waitForTimeout(8000);
  } else {
    const visible = await page.evaluate(() => document.body.innerText.slice(0, 400).replace(/\n{2,}/g, "\n"));
    throw new Error(`no password field after the email step. Page says:\n${visible}`);
  }
  ok(`landed on ${page.url()}`);
  await shot("04-after-signup");

  // ---- 2. The billing panel, before -------------------------------------
  step(2, "Open /settings/billing");
  await page.goto(`${APP}/settings/billing`, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(4000);
  await shot("03-billing-before");
  const before = await page.evaluate(() => document.body.innerText.slice(0, 300).replace(/\n{2,}/g, "\n"));
  console.log("    panel says:\n" + before.split("\n").map((l) => "      " + l).join("\n"));

  const upgrade = page.getByRole("button", { name: /Upgrade to Pro/i }).first();
  if (!(await upgrade.count())) throw new Error("no Upgrade button — is the account already Pro, or billing disabled?");
  if (!(await upgrade.isEnabled())) throw new Error("Upgrade button is disabled — billingEnabled is false on this broker");
  ok("Upgrade to Pro is present and enabled");

  // ---- 3. Our own checkout endpoint --------------------------------------
  step(3, "Click Upgrade — this goes through /v1/billing/checkout");
  await upgrade.click();
  await page.waitForURL(/dodopayments\.com/, { timeout: 60_000 });
  ok(`checkout: ${page.url()}`);
  await page.waitForTimeout(4500);
  await shot("04-checkout");

  // ---- 4. Billing details -------------------------------------------------
  step(4, `Fill billing details (${country})`);
  await page
    .selectOption('select[name="country"]', country)
    .catch(() => page.selectOption('select[name="country"]', { label: country === "IN" ? "India" : "United States" }));
  await page.waitForTimeout(1200);
  const manual = page.getByRole("button", { name: /Enter address manually/i });
  if (await manual.count()) {
    await manual.click();
    await page.waitForTimeout(1000);
  }
  for (const [name, value] of Object.entries(ADDRESS)) {
    await page.fill(`input[name="${name}"]`, value).catch(() => bad(`input[name=${name}]`));
  }
  const totals = await page.evaluate(() => (document.body.innerText.match(/(Subtotal|GST|Tax|Total)[^\n]*\n[^\n]*/g) || []).slice(0, 4));
  console.log("    charge:", JSON.stringify(totals));
  await shot("05-details");
  await page.getByRole("button", { name: /Continue to Payment/i }).click();
  await page.waitForTimeout(7000);
  await shot("06-card-step");

  // ---- 5. The card --------------------------------------------------------
  step(5, `Enter the card (${CARD.label})`);
  await fillAnywhere(['input[autocomplete="cc-number"]', 'input[placeholder*="1234"]'], CARD.number, "number");
  await fillAnywhere(['input[autocomplete="cc-exp"]', 'input[placeholder*="MM"]'], "06/32", "expiry");
  await fillAnywhere(['input[autocomplete="cc-csc"]', 'input[placeholder*="CVC"]'], "123", "cvv");
  // Required on the India form, absent on the US one. Unfilled, "Pay now"
  // stays disabled with no message — it simply looks broken.
  await fillAnywhere(['input[autocomplete="cc-name"]', 'input[placeholder*="Name on card"]'], "Flow Test", "name on card");
  await page.waitForTimeout(1500);
  await shot("07-card-filled");

  const pay = page.getByRole("button", { name: /Pay now|Subscribe|Confirm/i }).last();
  if (!(await pay.count())) throw new Error("no pay button");
  if (!(await pay.isEnabled())) throw new Error("Pay button is disabled — a required card field is empty (usually the cardholder name)");
  await pay.click();
  ok("submitted");
  await page.waitForTimeout(10_000);

  // ---- 6. The acquirer's simulator (India only) ---------------------------
  const simulate = page.getByRole("button", { name: /Simulate Success/i });
  if (await simulate.count()) {
    step(6, "Cashfree simulator — choosing Simulate Success");
    await shot("08-simulator");
    await simulate.click();
    ok("success chosen");
  } else {
    step(6, "No acquirer simulator on this route (US cards settle directly)");
  }

  // ---- 7. Back in our app -------------------------------------------------
  step(7, "Wait for the redirect back to the billing panel");
  await page
    .waitForURL(/app\.mtmux\.com\/settings\/billing/, { timeout: 90_000 })
    .then(() => ok(`returned to ${page.url()}`))
    .catch(() => bad(`did not return; still at ${page.url()}`));
  await page.waitForTimeout(2000);
  await shot("09-returned");

  const confirming = await page.getByText(/Confirming your payment/i).count();
  console.log(`    "Confirming your payment…" banner: ${confirming ? "shown" : "not seen (webhook may have won the race)"}`);

  step(8, "Wait for the plan to flip, without reloading");
  await page
    .getByText(/Renews on/i)
    .waitFor({ timeout: 40_000 })
    .then(() => ok("panel now shows an active Pro subscription"))
    .catch(() => bad("panel never showed a renewal date"));
  await page.waitForTimeout(1500);
  await shot("10-final");

  const after = await page.evaluate(() => document.body.innerText.slice(0, 400).replace(/\n{2,}/g, "\n"));
  console.log("    panel says:\n" + after.split("\n").map((l) => "      " + l).join("\n"));
} catch (error) {
  failed = error.message;
  bad(`FAILED: ${error.message}`);
  await shot("99-error");
} finally {
  await browser.close();
}

// ---- 9. Ground truth, from the API rather than the page --------------------
step(9, "Confirm against the broker itself");
const signIn = await fetch(`${API}/api/auth/sign-in/email`, {
  method: "POST",
  headers: { "Content-Type": "application/json", Origin: APP },
  body: JSON.stringify({ email, password }),
}).then((r) => r.json()).catch(() => null);

if (!signIn?.token) {
  bad("could not sign in to read the final state");
  process.exit(failed ? 1 : 0);
}
const billing = await fetch(`${API}/v1/billing`, {
  headers: { Authorization: `Bearer ${signIn.token}` },
}).then((r) => r.json());
console.log(`    plan=${billing.plan} planSource=${billing.planSource} status=${billing.status}`);
console.log(`    machines=${billing.usage?.servers} renewsAt=${billing.currentPeriodEnd ? new Date(billing.currentPeriodEnd).toISOString() : "-"}`);

if (billing.planSource === "paid") {
  console.log("\n✓ END TO END: a new account went from the register page to a paid Pro plan.");
  process.exit(0);
}
console.log("\n✗ The plan did NOT activate. The payment may have succeeded while the webhook was ignored —");
console.log("  check the broker log for 'Subscription webhook for an unknown customer'.");
process.exit(1);
