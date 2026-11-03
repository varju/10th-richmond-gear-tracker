import { expect, type Page, test } from "@playwright/test";

// The desk layout at a desk's width (NFR-USE-10): the sections beside every
// screen, a home that opens on exceptions, and the inventory as a table. The
// phone specs prove the same build at a phone's width.

async function signIn(page: Page) {
  await page.goto("/");
  await page.getByLabel("Email").fill("alice@example.org");
  await page.getByLabel("Password").fill("correct horse");
  await page.getByRole("button", { name: "Sign in" }).click();
  // The sections are on the home screen at a phone's width and beside it at a desk's.
  await expect(page.getByRole("navigation", { name: "Sections" })).toBeVisible();
}

test("the sections stay beside the screen, and home opens on what needs a person", async ({ page }) => {
  await signIn(page);
  const sections = page.getByRole("navigation", { name: "Sections" });
  await expect(sections.getByRole("button", { name: "All items" })).toBeVisible();
  await expect(sections.getByRole("button", { name: "Help" })).toBeVisible();

  for (const heading of ["Needs attention", "What is out", "Coming up"]) {
    await expect(page.getByRole("heading", { name: heading })).toBeVisible();
  }

  await sections.getByRole("button", { name: "All items" }).click();
  await expect(page).toHaveURL(/\/items$/);
  // Every screen keeps them.
  await expect(sections.getByRole("button", { name: "Help" })).toBeVisible();
});

test("the inventory is a table that sorts, with a generic's units folded under it", async ({ page }) => {
  await signIn(page);
  await page.goto("/items");
  const table = page.getByRole("table");
  await expect(table).toBeVisible();
  // A desk starts typing.
  await expect(page.getByLabel("Search")).toBeFocused();

  // Shut until opened (FR-INV-25).
  const unit = table.getByRole("link", { name: "Tent, 4-person #1", exact: true });
  const fold = table.getByRole("button", { name: /, Tent, 4-person$/ });
  await expect(fold).toHaveAttribute("aria-expanded", "false");
  await expect(unit).toBeHidden();
  await fold.click();
  await expect(unit).toBeVisible();
  await fold.click();
  await expect(unit).toBeHidden();

  // A search is looking for units, so it opens what it finds.
  await page.getByLabel("Search").fill("tent, 4-person");
  await expect(unit).toBeVisible();
  // Whole numbers first and in numeric order, then text (FR-INV-23). The demo
  // carries a #10 and a "3b" so this is a real sort, not 1 through 6.
  const units = await table.getByRole("link", { name: /^Tent, 4-person #/ }).allInnerTexts();
  expect(units.map((t) => t.replace(/^Tent, 4-person #| \(.*\)$/g, ""))).toEqual([
    "1",
    "2",
    "3",
    "4",
    "5",
    "6",
    "10",
    "3b",
  ]);

  await page.getByRole("button", { name: /^Name/ }).click();
  await expect(page.getByRole("columnheader", { name: /Name/ })).toHaveAttribute("aria-sort", "descending");
});

test("back from an item returns to where the table was scrolled", async ({ page }) => {
  await signIn(page);
  await page.getByRole("navigation", { name: "Sections" }).getByRole("button", { name: "All items" }).click();
  await expect(page.getByRole("table")).toBeVisible();
  await page.getByRole("button", { name: /, Tent, 4-person$/ }).click();
  await page.evaluate(() => window.scrollTo(0, 400));
  expect(await page.evaluate(() => window.scrollY)).toBe(400);

  // Dispatched, not clicked: a click would first scroll the row into view.
  await page.getByRole("table").getByRole("link", { name: "Tent, 4-person #1", exact: true }).dispatchEvent("click");
  await expect(page).toHaveURL(/\/items\/./);
  expect(await page.evaluate(() => window.scrollY)).toBe(0);

  await page.getByRole("button", { name: "Back" }).click();
  await expect(page.getByRole("table")).toBeVisible();
  await expect.poll(() => page.evaluate(() => window.scrollY)).toBe(400);
});

test("an item name in the table is a link: plain click stays, middle-click opens a new page", async ({ page }) => {
  await signIn(page);
  await page.goto("/items");
  const table = page.getByRole("table");
  await expect(table).toBeVisible();
  await page.getByLabel("Search").fill("tent, 4-person");
  const unit = table.getByRole("link", { name: "Tent, 4-person #1", exact: true });
  await expect(unit).toBeVisible();
  const href = await unit.getAttribute("href");
  expect(href).toMatch(/\/items\/./);

  const opened = page.context().waitForEvent("page");
  await unit.click({ button: "middle" });
  const popup = await opened;
  await popup.waitForLoadState();
  expect(new URL(popup.url()).pathname).toBe(href);
  await expect(popup.getByRole("heading", { name: "Tent, 4-person #1" })).toBeVisible();
  await popup.close();
  await expect(page).not.toHaveURL(/\/items\/./);
  await expect(table).toBeVisible();

  let extra = 0;
  page.context().on("page", () => extra++);
  await unit.click();
  await expect(page).toHaveURL(/\/items\/./);
  expect(extra).toBe(0);
});
