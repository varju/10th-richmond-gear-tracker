import { expect, type Page, test } from "@playwright/test";

// Few, and each one earns its seconds (architecture.md, "Browser tests").

async function signIn(page: Page) {
  await page.goto("/");
  await page.getByLabel("Email").fill("alice@example.org");
  await page.getByLabel("Password").fill("correct horse");
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByRole("button", { name: "Scan" })).toBeVisible();
}

test("installs its shell, then starts offline within budget", async ({ page, context }) => {
  await signIn(page);
  await expect(page.getByText(/Synced /)).toBeVisible();

  // Let the service worker finish precaching before pulling the plug.
  await page.evaluate(() => navigator.serviceWorker.ready);
  await page.waitForFunction(async () => (await caches.keys()).length > 0);

  await context.setOffline(true);
  const started = Date.now();
  await page.reload();
  await expect(page.getByRole("button", { name: "Scan" })).toBeVisible();
  expect(Date.now() - started).toBeLessThan(3_000);
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
test("a printed code becomes an item", async ({ page, request }) => {
  await signIn(page);
  await page.getByRole("button", { name: "Settings" }).click();
  await page.getByLabel("Group name").fill("10th Richmond");
  await page.getByLabel("Code URL").fill("https://example.org/g");
  await page.getByRole("button", { name: "Save group" }).click();
  await page.getByLabel("New location").fill("Cold locker");
  await page.getByRole("button", { name: "Add" }).first().click();
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
  await page.getByLabel("Sub-location").fill("shelf 4");
  await page.getByRole("button", { name: "Save" }).click();
  await expect(page).toHaveURL(/\/scan$/);

  await page.goto("/");
  await page.getByLabel("Search").fill("tent");
  await page.getByRole("button", { name: /Tent 1/ }).click();
  await expect(page.getByText("Cold locker / shelf 4")).toBeVisible();
  await expect(page.getByText(code)).toBeVisible();

  // The sticker's URL now opens the item.
  await page.goto(`/g/${code}`);
  await expect(page).toHaveURL(/\/items\//);
  await expect(page.getByRole("heading", { name: "Tent 1" })).toBeVisible();
});
