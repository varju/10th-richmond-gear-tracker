import { expect, type Page, test } from "@playwright/test";

// One test, one risk: a phone with no signal must still open the app and
// show its data. Sign-in and the first sync ride along because the offline
// half is meaningless without them.

async function signIn(page: Page) {
  await page.goto("/");
  await page.getByLabel("Email").fill("alice@example.org");
  await page.getByLabel("Password").fill("correct horse");
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByText("Signed in as Alice")).toBeVisible();
}

test("installs its shell, then starts offline within budget", async ({ page, context }) => {
  await signIn(page);
  await expect(page.getByText(/^Synced /)).toBeVisible();

  // Let the service worker finish precaching before pulling the plug.
  await page.evaluate(() => navigator.serviceWorker.ready);
  await page.waitForFunction(async () => (await caches.keys()).length > 0);

  await context.setOffline(true);
  const started = Date.now();
  await page.reload();
  await expect(page.getByText("Signed in as Alice")).toBeVisible();
  expect(Date.now() - started).toBeLessThan(3_000);
  await expect(page.getByText(/^Offline\. Last synced/)).toBeVisible();

  await context.setOffline(false);
});

test("a wrong password is refused with a reason", async ({ page }) => {
  await page.goto("/");
  await page.getByLabel("Email").fill("alice@example.org");
  await page.getByLabel("Password").fill("wrong");
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByRole("alert")).toContainText(/password/i);
});
