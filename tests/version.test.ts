import { test } from "node:test";
import assert from "node:assert/strict";
// @ts-ignore -- release tooling is plain Node ESM, tested directly without compilation.
import { parseVersion, validateVersion } from "../scripts/check-version.mjs";

function check(version: string, base?: string, lockVersion = version, changelog = `# Changelog\n\n## [${version}] - 2026-01-01\n`) {
  validateVersion({ version }, { version: lockVersion, packages: { "": { version: lockVersion } } }, changelog, base);
}

test("release version permits stable patch, minor and major increases", () => {
  check("1.0.1", "1.0.0");
  check("1.1.0", "1.0.9");
  check("2.0.0", "1.99.99");
  check("1.10.0", "1.9.0");
  check("1.0.0");
});

test("release version rejects invalid, unchanged or decreasing versions", () => {
  for (const version of ["1.0", "v1.0.0", "01.0.0", "1.0.0-beta.1", "1.0.0+build", "-1.0.0"]) {
    assert.throws(() => parseVersion(version));
  }
  assert.throws(() => check("1.0.0", "1.0.0"), /must be greater/);
  assert.throws(() => check("1.0.0", "1.0.1"), /must be greater/);
  assert.throws(() => check("1.9.0", "1.10.0"), /must be greater/);
});

test("release version requires matching lockfile and changelog", () => {
  assert.throws(() => check("1.0.1", undefined, "1.0.0"), /must match/);
  assert.throws(() => check("1.0.1", undefined, "1.0.1", "## [1.0.10]\n"), /Missing CHANGELOG/);
  assert.throws(() => validateVersion({ version: "1.0.1" }, { version: "1.0.1", packages: {} }, "## [1.0.1]"), /must match/);
});
