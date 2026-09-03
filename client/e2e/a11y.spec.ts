import AxeBuilder from "@axe-core/playwright";
import { expect, type Page, test } from "@playwright/test";

// WCAG 2.2 AA on the screens people use most (NFR-A11Y-01). One check per
// screen, against the real build, because contrast needs real layout.

const TAGS = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"];

async function audit(page: Page, name: string) {
  const results = await new AxeBuilder({ page }).withTags(TAGS).analyze();
  const problems = results.violations.map(
    (v) => `${name}: ${v.id} (${v.impact}) — ${v.help}\n  ${v.nodes.map((n) => n.target.join(" ")).join("\n  ")}`,
  );
  expect(problems, problems.join("\n")).toEqual([]);
}

async function signIn(page: Page) {
  await page.goto("/");
  await page.getByLabel("Email").fill("alice@example.org");
  await page.getByLabel("Password").fill("correct horse");
  await page.getByRole("button", { name: "Sign in" }).click();
  // Both layouts land on a home screen with the group's name at the top of it.
  await expect(page.getByRole("heading", { level: 1, name: /Gear Tracker/ })).toBeVisible();
}

// The layout turns at 900 px, and the home screen and the inventory differ
// either side of it (NFR-USE-10). This spec runs at both widths.
const isWide = (page: Page) => (page.viewportSize()?.width ?? 0) >= 900;

test("the main screens have no WCAG 2.2 AA violations", async ({ page }) => {
  const wide = isWide(page);
  await page.goto("/");
  await expect(page.getByLabel("Email")).toBeVisible();
  await audit(page, "sign in");

  await signIn(page);
  await audit(page, "home");

  // The inventory is a table at a desk and the phone's list at a phone's width.
  await page.goto("/items");
  if (wide) await expect(page.getByRole("table")).toBeVisible();
  else await expect(page.getByLabel("Search")).toBeVisible();
  await audit(page, "inventory");

  await page.getByRole("button", { name: "New item" }).click();
  await expect(page.getByLabel("Name")).toBeVisible();
  await audit(page, "new item");
  await page.getByLabel("Name").fill("Audit tent");
  await page.getByRole("button", { name: "Save" }).click();
  await expect(page.getByRole("heading", { name: "Audit tent" }).first()).toBeVisible();
  await audit(page, "item");

  for (const [path, heading] of [
    ["/settings", "Settings"],
    ["/reports", "Reports"],
    ["/reservations", "Reservations"],
    ["/reservations/new", "New reservation"],
    ["/repairs", "Needs repair"],
    ["/out", "What is out"],
  ] as const) {
    await page.goto(path);
    await expect(page.getByRole("heading", { level: 1 })).toContainText(heading);
    await audit(page, path);
  }
});
