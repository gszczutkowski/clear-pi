import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";

export function parseVersion(value) {
  if (typeof value !== "string" || !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(value)) {
    throw new Error(`Expected a stable SemVer version, got ${JSON.stringify(value)}`);
  }
  return value.split(".").map(BigInt);
}

export function validateVersion(manifest, lock, changelog, baseVersion) {
  const current = parseVersion(manifest.version);
  if (lock.version !== manifest.version || lock.packages?.[""]?.version !== manifest.version) {
    throw new Error("package.json and package-lock.json versions must match");
  }
  if (!changelog.split(/\r?\n/).some((line) => line === `## [${manifest.version}]` || line.startsWith(`## [${manifest.version}] - `))) {
    throw new Error(`Missing CHANGELOG.md entry for ${manifest.version}`);
  }
  if (baseVersion !== undefined) {
    const base = parseVersion(baseVersion);
    const difference = current.findIndex((part, index) => part !== base[index]);
    if (difference === -1 || current[difference] < base[difference]) {
      throw new Error(`PR version ${manifest.version} must be greater than main version ${baseVersion}`);
    }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2);
  if (args.length && (args.length !== 2 || args[0] !== "--base")) {
    throw new Error("Usage: node scripts/check-version.mjs [--base <git-ref>]");
  }
  const manifest = JSON.parse(readFileSync("package.json", "utf8"));
  const base = args.length ? JSON.parse(execFileSync("git", ["show", `${args[1]}:package.json`], { encoding: "utf8" })).version : undefined;
  validateVersion(manifest, JSON.parse(readFileSync("package-lock.json", "utf8")), readFileSync("CHANGELOG.md", "utf8"), base);
  console.log(`Verified release version ${manifest.version}${base ? ` > ${base}` : ""}`);
}
