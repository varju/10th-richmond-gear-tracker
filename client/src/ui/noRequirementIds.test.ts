import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "vitest";

const ID = /\bN?FR-[A-Z]+-\d+/;

test("no text a person reads carries a requirement ID", () => {
  const bad: string[] = [];
  for (const name of readdirSync(__dirname)) {
    if (!/\.tsx?$/.test(name) || /\.test\./.test(name)) continue;
    const lines = readFileSync(join(__dirname, name), "utf8").split("\n");
    let inBlock = false;
    lines.forEach((line, i) => {
      const t = line.trim();
      if (inBlock) {
        if (t.includes("*/")) inBlock = false;
        return;
      }
      if (t.startsWith("/*")) {
        inBlock = !t.includes("*/");
        return;
      }
      if (t.startsWith("//") || t.startsWith("{/*")) return;
      if (ID.test(line.replace(/\/\/.*$/, "").replace(/\{\/\*.*\*\/\}/, ""))) bad.push(`${name}:${i + 1}: ${t}`);
    });
  }
  expect(bad).toEqual([]);
});
