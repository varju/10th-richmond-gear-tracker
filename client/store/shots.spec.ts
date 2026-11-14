import { expect, type Page, test } from "@playwright/test";

// The scene is bin/store-scene. Files land in store-shots/<project>/, named as the store listing has them.

// The desk's inventory focuses its search box on open; a store shot shows no focus ring.
const shot = (page: Page, name: string) =>
  page.screenshot({
    path: `${test.info().config.rootDir}/../store-shots/${test.info().project.name}/${name}.png`,
    animations: "disabled",
    style: ":focus-visible { outline: none !important; }",
  });

test("App Store screenshots", async ({ page }) => {
  await page.goto("/");
  await page.getByLabel("Email").fill("alice@example.org");
  await page.getByLabel("Password").fill("correct horse");
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByRole("button", { name: "Sign in" })).toHaveCount(0);

  await page.goto("/items");
  await expect(page.getByText("Tent, 4-person").first()).toBeVisible();
  await shot(page, "01-inventory");

  await page.getByText("Stove, two-burner propane").first().click();
  await expect(page.getByRole("heading", { name: /Stove, two-burner/ })).toBeVisible();
  await shot(page, "02-item");

  await page.goto("/out");
  await expect(page.getByText("Ben Okafor").first()).toBeVisible();
  await shot(page, "03-whats-out");

  await page.goto("/events");
  await page.getByText("Winter camp").first().click();
  await expect(page.getByRole("heading", { name: "Winter camp" })).toBeVisible();
  await shot(page, "04-camp-reservation");

  await page.goto("/repairs");
  await page
    .getByText(/Left burner/)
    .first()
    .click();
  await expect(page.getByText("New igniter ordered.")).toBeVisible();
  await shot(page, "05-repair");
});
