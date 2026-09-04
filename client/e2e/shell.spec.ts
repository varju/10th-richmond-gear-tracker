import { expect, type Page, test } from "@playwright/test";

// Few, and each one earns its seconds (architecture.md, "Browser tests").

async function signIn(page: Page) {
  await page.goto("/");
  await page.getByLabel("Email").fill("alice@example.org");
  await page.getByLabel("Password").fill("correct horse");
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByRole("button", { name: "Check out" })).toBeVisible();
}

test("installs its shell, then starts offline within budget", async ({ page, context }) => {
  await signIn(page);
  // The sync line moved off the home screen and onto the list.
  await page.goto("/items");
  await expect(page.getByText(/Synced /)).toBeVisible();
  await page.goto("/");

  // Let the service worker finish precaching before pulling the plug.
  await page.evaluate(() => navigator.serviceWorker.ready);
  await page.waitForFunction(async () => (await caches.keys()).length > 0);

  await context.setOffline(true);
  const started = Date.now();
  await page.reload();
  await expect(page.getByRole("button", { name: "Check out" })).toBeVisible();
  expect(Date.now() - started).toBeLessThan(3_000);
  await page.getByRole("button", { name: "Menu" }).click();
  await page.getByRole("button", { name: "Settings" }).click();
  await expect(page.getByText(/^Offline/)).toBeVisible();

  await context.setOffline(false);
});

test("a wrong password is refused with a reason", async ({ page }) => {
  await page.goto("/");
  await page.getByLabel("Email").fill("alice@example.org");
  await page.getByLabel("Password").fill("wrong");
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByRole("alert")).toContainText(/password/i);
});

// The labelling walk (S-BOOT-03): set the group up, print codes, land on a
// fresh code, create the item, find it by search, and see the sticker resolve.
// The lockers are already there: the server loaded the demo inventory.
test("a printed code becomes an item", async ({ browser, page, request }) => {
  await signIn(page);
  await page.getByRole("button", { name: "Menu" }).click();
  await page.getByRole("button", { name: "Settings" }).click();
  await page.getByRole("button", { name: "General" }).click();
  await page.getByLabel("Group name").fill("10th Richmond");
  await page.getByLabel("Site address").fill("https://example.org/gear");
  await page.getByLabel("How to reach us").fill("gear@example.org");
  await page.getByRole("button", { name: "Save group" }).click();
  await page.getByRole("button", { name: "Back" }).click();
  await page.getByRole("button", { name: "Sync now" }).click();
  await expect(page.getByRole("status")).toHaveCount(0);

  // Print a sheet through the API, then pull the new codes onto the phone.
  const api = await request.post("/auth/sign-in", {
    data: { email: "alice@example.org", password: "correct horse", device_id: "e2e-api" },
  });
  const { token } = (await api.json()) as { token: string };
  const headers = { Authorization: `Bearer ${token}` };
  const sheet = await request.post("/codes/sheets", { headers, data: { sheets: 1 } });
  expect(sheet.headers()["content-type"]).toBe("application/pdf");
  const snapshot = (await (await request.get("/sync/bootstrap", { headers })).json()) as { snapshot: { code: object } };
  const code = Object.keys(snapshot.snapshot.code)[0]!;
  await page.getByRole("button", { name: "Sync now" }).click();

  await page.goto(`/g/${code}`);
  await page.getByRole("button", { name: "Create a new item" }).click();
  await expect(page.getByText(`Code ${code} will go on this item.`)).toBeVisible();
  await page.getByLabel("Name").fill("Tent 1");
  await page.getByLabel("Home location").selectOption({ label: "Cold locker" });
  await page.getByLabel("Shelf").fill("shelf 4");
  await page.getByRole("button", { name: "Save" }).click();
  await expect(page).toHaveURL(/\/scan$/);

  await page.goto("/");
  await page.getByLabel("Search").fill("tent");
  await page.getByRole("button", { name: /Tent 1/ }).click();
  await expect(page.getByText("Cold locker / shelf 4")).toBeVisible();
  // The code sits in the Details fold, closed until asked for.
  await page.getByText("Details", { exact: true }).click();
  await expect(page.getByText(code)).toBeVisible();

  // The sticker's URL now opens the item.
  await page.goto(`/g/${code}`);
  await expect(page).toHaveURL(/\/items\//);
  await expect(page.getByRole("heading", { name: "Tent 1" })).toBeVisible();

  // The same sticker, scanned by someone with no account (S-PUB-01).
  const stranger = await browser.newContext({ baseURL: page.url() });
  const theirs = await stranger.newPage();
  await theirs.goto(`/g/${code}`);
  await expect(theirs.getByRole("heading", { name: "10th Richmond" })).toBeVisible();
  await expect(theirs.getByText("Tent 1")).toHaveCount(0);
  await expect(theirs.getByRole("link", { name: "gear@example.org" })).toBeVisible();
  await expect(theirs.getByLabel("Password")).toHaveCount(0);
  await stranger.close();
});

// A movement without the camera: search, open, out, in (FR-OUT-01, FR-OUT-08).
test("an item can be checked out and in from its page", async ({ page }) => {
  await signIn(page);
  await page.goto("/");
  // Home holds nothing but the alerts until it is asked something.
  await expect(page.getByText("Check out or return gear by scanning its code.")).toBeVisible();
  await expect(page.getByRole("listitem")).toHaveCount(0);

  // The list is behind the menu.
  await page.getByRole("button", { name: "Menu" }).click();
  await page.getByRole("button", { name: "All items" }).click();
  await expect(page).toHaveURL(/\/items$/);
  await expect(page.getByText("Filters")).toBeVisible();
  await page.getByRole("button", { name: "Back" }).click();

  await page.getByLabel("Search").fill("Tent 1");
  await page.getByRole("button", { name: /Tent 1/ }).click();
  await expect(page.getByRole("heading", { name: "Tent 1" })).toBeVisible();

  await page.getByRole("button", { name: "Check out" }).click();
  await expect(page.getByRole("status").filter({ hasText: "Checked out · Tent 1" })).toBeVisible();
  await expect(page.getByText(/^Out · Alice$/)).toBeVisible();
  await page.getByRole("button", { name: "Return" }).click();
  await expect(page.getByRole("status").filter({ hasText: "Returned · Tent 1" })).toBeVisible();
  await expect(page.getByText("In", { exact: true })).toBeVisible();
});
