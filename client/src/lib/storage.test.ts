import { expect, test } from "vitest";
import { ensurePersistent } from "./storage";

const manager = (persisted: boolean, persist: boolean) =>
  ({ persisted: async () => persisted, persist: async () => persist }) as unknown as StorageManager;

test("already persisted needs no asking", async () => {
  expect(await ensurePersistent(manager(true, false))).toBe("persisted");
});

test("asks, and reports a refusal", async () => {
  expect(await ensurePersistent(manager(false, true))).toBe("persisted");
  expect(await ensurePersistent(manager(false, false))).toBe("refused");
});

test("a browser without the API is reported, not crashed on", async () => {
  expect(await ensurePersistent(undefined)).toBe("unsupported");
  expect(await ensurePersistent({} as StorageManager)).toBe("unsupported");
});
