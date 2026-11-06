/**
 * Install the pnpm version pinned in package.json's `packageManager`, after
 * verifying the downloaded tarball against the integrity hash pnpm recorded
 * for it in pnpm-lock.yaml. The lockfile is the single source of truth: a
 * tarball that does not match it is never installed.
 *
 *   node scripts/install-pnpm.mjs
 */

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const pin = JSON.parse(readFileSync("package.json", "utf8")).packageManager ?? "";
const version = /^pnpm@(\d+\.\d+\.\d+)(?:\+|$)/.exec(pin)?.[1];
if (!version) throw new Error(`package.json packageManager is not an exact pnpm pin: ${pin}`);

const lockfile = readFileSync("pnpm-lock.yaml", "utf8");
const entry = new RegExp(`\\n  pnpm@${version.replace(/\./g, "\\.")}:\\n    resolution: \\{integrity: (sha512-[A-Za-z0-9+/=]+)\\}`);
const expected = entry.exec(lockfile)?.[1];
if (!expected) throw new Error(`pnpm-lock.yaml records no integrity for pnpm@${version}`);

const dir = mkdtempSync(join(tmpdir(), "pnpm-"));
const tarball = execFileSync("npm", ["pack", `pnpm@${version}`, "--silent", "--pack-destination", dir], {
  encoding: "utf8",
}).trim();
const path = join(dir, tarball);
const actual = `sha512-${createHash("sha512").update(readFileSync(path)).digest("base64")}`;
if (actual !== expected) {
  throw new Error(`pnpm@${version} tarball does not match pnpm-lock.yaml\n  expected ${expected}\n  actual   ${actual}`);
}

execFileSync("npm", ["install", "--global", "--ignore-scripts", path], { stdio: "inherit" });
console.log(`pnpm@${version} installed, integrity verified against pnpm-lock.yaml`);
