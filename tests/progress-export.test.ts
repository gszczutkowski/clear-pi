import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { progressIcons, renderProgress, type ProgressView } from "../progress-view.ts";
import { renderProgressHtml, saveProgressExport } from "../progress-export.ts";

const view: ProgressView = {
  title: '<script>alert("x")</script> & report',
  tasks: [{ id: "T1", title: "Feature", status: "accepted", runs: [{
    id: "worker-1", name: "Implement", role: "worker", task: "Feature", status: "RESULT REPORTED",
    summary: "Ready <img src=x onerror=alert(1)>", children: [],
  }] }, { id: "T2", title: "Next", status: "in_review", runs: [] }], unassigned: [],
};

test("HTML preserves expanded projection, escapes content, and needs no scripts/fonts/network", () => {
  const html = renderProgressHtml(view);
  assert.match(html, /^<!doctype html>/);
  assert.match(html, /charset="utf-8"/);
  assert.match(html, /default-src 'none'/);
  assert.doesNotMatch(html, /<script|<img|<link|@import|url\(/i);
  const pre = html.match(/<pre>([\s\S]*?)<\/pre>/)![1];
  const decoded = pre.replaceAll("&lt;", "<").replaceAll("&gt;", ">").replaceAll("&quot;", '"')
    .replaceAll("&#39;", "'").replaceAll("&amp;", "&");
  assert.equal(decoded, renderProgress(view, 140, { details: true }).join("\n")
    .replaceAll(progressIcons.checked, "☑").replaceAll(progressIcons.unchecked, "☐"));
  assert.match(decoded, /╭─ worker: Implement/);
  assert.match(decoded, /☑ T1/);
  assert.match(decoded, /☐ T2/);
  assert.ok(!html.includes(progressIcons.checked));
});

test("export honors the same run limits and writes unique UTF-8 local reports", async () => {
  const root = await mkdtemp(join(tmpdir(), "clear-progress-export-"));
  try {
    const directory = join(root, "reports");
    const first = await saveProgressExport(view, directory, { maxRuns: 0 });
    const content = await readFile(first, "utf8");
    assert.match(content, /runs hidden/);
    assert.doesNotMatch(content, /╭─ worker:/);
    assert.equal(content, renderProgressHtml(view, { maxRuns: 0 }));
    const second = await saveProgressExport(view, directory);
    assert.notEqual(first, second);
    assert.equal(await readFile(first, "utf8"), content);
    await assert.rejects(saveProgressExport(view, first));
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("export rechecks that the snapshot is current before writing the file", async () => {
  const root = await mkdtemp(join(tmpdir(), "clear-progress-export-race-"));
  try {
    let current = true;
    const pending = saveProgressExport(view, root, {}, () => current);
    current = false;
    assert.equal(await pending, undefined);
    assert.deepEqual(await readdir(root), []);
  } finally { await rm(root, { recursive: true, force: true }); }
});
