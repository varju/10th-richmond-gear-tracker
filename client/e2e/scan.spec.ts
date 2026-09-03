import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { type APIRequestContext, chromium, devices, expect, type Page, test } from "@playwright/test";

// Scan-to-move earns a browser test (architecture.md, "Browser tests"): the real
// client, the real server, the real decoder, and a real QR code in front of a
// camera. The camera is Chromium's fake device playing a video of the code.

const DEVICE = "e2e-cam";
const ITEM = "Tent 9";
// Not the values shell.spec.ts types into Settings, so its "Save group" still has a change to save.
const GROUP = "Camera test";
const CODE_URL = "https://example.org/cam";

const ULID_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

function ulid(now = Date.now()): string {
  let value = (BigInt(now) << 80n) | BigInt(`0x${randomBytes(10).toString("hex")}`);
  let out = "";
  for (let i = 0; i < 26; i++) {
    out = ULID_ALPHABET[Number(value & 31n)] + out;
    value >>= 5n;
  }
  return out;
}

interface Event {
  entity_type: string;
  entity_id: string;
  type: string;
  payload: Record<string, unknown>;
}

/** Sign in through the API, set the group up, print a sheet, and put one of its codes on a new item. */
async function seed(request: APIRequestContext): Promise<string> {
  const signIn = await request.post("/auth/sign-in", {
    data: { email: "alice@example.org", password: "correct horse", device_id: DEVICE },
  });
  expect(signIn.ok()).toBe(true);
  const { token, user } = (await signIn.json()) as { token: string; user: { id: string } };
  const headers = { Authorization: `Bearer ${token}` };

  let seq = 0;
  const push = async (events: Event[]) => {
    const now = Date.now();
    const response = await request.post("/sync/push", {
      headers,
      data: {
        device_id: DEVICE,
        client_time: now,
        events: events.map((e) => ({
          id: ulid(now),
          actor_id: user.id,
          device_id: DEVICE,
          device_seq: ++seq,
          occurred_at: now,
          clock_offset: 0,
          ...e,
        })),
      },
    });
    const body = (await response.json()) as { rejected: unknown[] };
    expect(body.rejected).toEqual([]);
  };

  await push([
    {
      entity_type: "setting",
      entity_id: "group",
      type: "created",
      payload: { name: GROUP, code_url: CODE_URL, contact: "gear@example.org" },
    },
  ]);
  const sheet = await request.post("/codes/sheets", { headers, data: { sheets: 1 } });
  expect(sheet.headers()["content-type"]).toBe("application/pdf");
  const bootstrap = (await (await request.get("/sync/bootstrap", { headers })).json()) as {
    snapshot: { code: Record<string, unknown> };
  };
  const code = Object.keys(bootstrap.snapshot.code)[0]!;
  const itemId = ulid();
  await push([
    { entity_type: "item", entity_id: itemId, type: "created", payload: { name: ITEM } },
    { entity_type: "code", entity_id: code, type: "code_bound", payload: { item_id: itemId } },
  ]);
  return code;
}

/** A Y4M video of the sticker's QR, written by the encoder the label sheets use. */
function stickerVideo(code: string): string {
  const dir = resolve(test.info().project.outputDir);
  mkdirSync(dir, { recursive: true });
  const file = resolve(dir, `sticker-${code}.y4m`);
  execFileSync("uv", ["run", "--project", "..", "python", "e2e/qr_video.py", `${CODE_URL}/${code}`, file], {
    stdio: "inherit",
  });
  return file;
}

async function signIn(page: Page) {
  await page.goto("/");
  await page.getByLabel("Email").fill("alice@example.org");
  await page.getByLabel("Password").fill("correct horse");
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByRole("button", { name: "Take out" })).toBeVisible();
}

test("a scanned sticker checks its item out and back in", async ({ request }) => {
  const code = await seed(request);
  const video = stickerVideo(code);

  // The fake camera is a launch flag, so this test brings its own browser.
  const browser = await chromium.launch({
    args: [
      "--use-fake-device-for-media-stream",
      "--use-fake-ui-for-media-stream",
      `--use-file-for-fake-video-capture=${video}`,
    ],
  });
  const baseURL = test.info().project.use.baseURL;
  const context = await browser.newContext({ ...devices["Pixel 7"], permissions: ["camera"], baseURL });
  const page = await context.newPage();
  try {
    await signIn(page);
    await page.goto("/scan?mode=out");

    // First decode: the wasm loads and the camera starts. Then take the tent.
    const card = page.getByRole("heading", { name: ITEM });
    await expect(card).toBeVisible({ timeout: 10_000 });
    await page.getByRole("button", { name: "Check out" }).click();
    await expect(page.getByRole("status").filter({ hasText: `Checked out · ${ITEM}` })).toBeVisible();

    // The sticker is still in front of the camera; switch to bringing gear back.
    await page.getByRole("button", { name: "Bring back" }).click();
    const checkIn = page.getByRole("button", { name: "Check in" });
    await expect(checkIn).toBeVisible({ timeout: 5_000 });
    await expect(page.getByText(/^Out · /)).toBeVisible();
    await checkIn.click();
    await expect(page.getByRole("status").filter({ hasText: `Checked in · ${ITEM}` })).toBeVisible();

    // Both movements are on the item.
    await page.goto("/");
    await page.getByLabel("Search").fill(ITEM);
    await page.getByRole("button", { name: new RegExp(ITEM) }).click();
    await expect(page.getByRole("heading", { name: ITEM })).toBeVisible();
    const entries = page
      .getByRole("list")
      .filter({ hasText: /^Checked/ })
      .getByRole("listitem");
    await expect(entries).toHaveText([/^Checked in by Alice/, /^Checked out by Alice/]);
  } finally {
    await browser.close();
  }
});
