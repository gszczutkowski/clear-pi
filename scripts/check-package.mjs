import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";

const manifest = JSON.parse(readFileSync("package.json", "utf8"));
const npm = process.platform === "win32" ? "npm.cmd" : "npm";
const [pack] = JSON.parse(execFileSync(npm, ["pack", "--dry-run", "--json", "--ignore-scripts"], {
  encoding: "utf8",
  shell: process.platform === "win32",
}));
const paths = new Set(pack.files.map((file) => file.path));
assert.equal(pack.version, manifest.version);
assert.ok(manifest.keywords.includes("pi-package"));
assert.deepEqual(manifest.pi.extensions, ["./index.ts"]);
for (const file of [...readdirSync(".").filter((file) => file.endsWith(".ts")), "config.json", "package.json", "README.md", "CHANGELOG.md"]) {
  assert.ok(paths.has(file), `Missing runtime/documentation file: ${file}`);
}
for (const file of paths) {
  assert.ok(!/^(tests|scripts|node_modules|\.github)\//.test(file), `Unexpected packaged file: ${file}`);
  assert.ok(!file.endsWith(".tgz"), `Nested archive: ${file}`);
}
console.log(`Verified ${pack.filename}: ${paths.size} files`);
