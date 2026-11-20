import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";

// The AGPL core must run without packages/ee (SupportX Commercial License).
const root = join(import.meta.dirname, "..", "..");
const scanned = ["apps", "packages", "scripts", "examples"];
const skip = new Set(["node_modules", "dist", ".git"]);

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    if (skip.has(name)) continue;
    const path = join(dir, name);
    if (statSync(path).isDirectory()) out.push(...sourceFiles(path));
    else if (/\.(ts|tsx|js|mjs)$/.test(name)) out.push(path);
  }
  return out;
}

test("no file outside packages/ee imports from packages/ee", () => {
  const eeDir = join(root, "packages", "ee") + sep;
  const offenders: string[] = [];
  for (const top of scanned) {
    for (const file of sourceFiles(join(root, top))) {
      if (file.startsWith(eeDir)) continue;
      const text = readFileSync(file, "utf8");
      if (/(from\s+|import\s*\(?\s*|require\s*\(\s*)["'][^"']*packages\/ee(\/|["'])/.test(text) ||
          /(from\s+|import\s*\(?\s*)["'](\.\.\/)+ee(\/|["'])/.test(text)) {
        offenders.push(relative(root, file));
      }
    }
  }
  assert.deepEqual(offenders, []);
});
