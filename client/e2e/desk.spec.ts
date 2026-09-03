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

test("the inventory is a table that sorts, with every unit under its generic", async ({ page }) => {
  await signIn(page);
  await page.goto("/items");
  const table = page.getByRole("table");
  await expect(table).toBeVisible();
  // A desk starts typing.
  await expect(page.getByLabel("Search")).toBeFocused();

  await page.getByLabel("Search").fill("tent, 4-person");
  // Units are never folded away (FR-INV-25).
  await expect(table.getByRole("button", { name: "Tent, 4-person #1", exact: true })).toBeVisible();
  // Whole numbers first and in numeric order, then text (FR-INV-23). The demo
  // carries a #10 and a "3b" so this is a real sort, not 1 through 6.
  const units = await table.getByRole("button", { name: /^Tent, 4-person #/ }).allInnerTexts();
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
