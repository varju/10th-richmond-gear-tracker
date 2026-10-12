import { afterEach, expect, test, vi } from "vitest";
import { printPage, shareFile } from "./share";

afterEach(() => vi.unstubAllGlobals());

function share(impl: (data: ShareData) => Promise<void>) {
  const fn = vi.fn(impl);
  vi.stubGlobal("navigator", { ...navigator, share: fn });
  return fn;
}

test("the file goes to the share sheet under its name and type", async () => {
  const fn = share(async () => {});
  await shareFile(new Blob(["a,b"], { type: "text/csv" }), "inventory.csv");
  const file = fn.mock.calls[0]?.[0].files?.[0];
  expect(file?.name).toBe("inventory.csv");
  expect(file?.type).toBe("text/csv");
});

test("closing the sheet is not an error", async () => {
  share(async () => {
    throw new DOMException("cancelled", "AbortError");
  });
  await expect(shareFile(new Blob([]), "codes.pdf")).resolves.toBeUndefined();
});

test("a refused sheet is, so the caller can offer a button", async () => {
  share(async () => {
    throw new DOMException("no gesture", "NotAllowedError");
  });
  await expect(shareFile(new Blob([]), "codes.pdf")).rejects.toThrow("no gesture");
});

test("in the browser, print is the browser's", async () => {
  const print = vi.fn();
  vi.stubGlobal("print", print);
  await printPage(false);
  expect(print).toHaveBeenCalledOnce();
});

test("in the app, print goes to the app's print plugin", async () => {
  const nativePromise = vi.fn(async () => undefined);
  vi.stubGlobal("Capacitor", { nativePromise });
  await printPage(true);
  expect(nativePromise).toHaveBeenCalledWith("PrintPlugin", "print", {});
});

test("in the app, a print the plugin refuses is an error the caller sees", async () => {
  vi.stubGlobal("Capacitor", { nativePromise: async () => Promise.reject(new Error("no printer")) });
  await expect(printPage(true)).rejects.toThrow("no printer");
});

test("an app with no bridge says it cannot print", async () => {
  vi.stubGlobal("Capacitor", undefined);
  await expect(printPage(true)).rejects.toThrow("cannot print");
});
