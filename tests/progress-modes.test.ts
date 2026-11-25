import assert from "node:assert/strict";
import test from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import { renderProgress, type ProgressRun, type ProgressView } from "../progress-view.ts";
import { renderProgressHtml } from "../progress-export.ts";

const run = (role = "worker"): ProgressRun => ({ id: role, name: role, role, task: "Saved task", status: "RESULT REPORTED", model: "model", thinking: "high", summary: "saved result ".repeat(40) + "END", children: [] });
const view = (): ProgressView => ({ title: "Not a mode selector", tasks: [], unassigned: [], branch: "branch", notice: "saved notice" });

test("solo summary, details and HTML remain task-only with zero, one or multiple tasks", () => {
  for (const count of [0, 1, 3]) {
    const data = view();
    data.tasks = Array.from({ length: count }, (_, i) => ({ id: `T${i + 1}`, title: "Solo task", status: "in_review", runs: [] }));
    for (const options of [{}, { compact: true }, { details: true }]) {
      const result = renderProgress(data, 140, options).join("\n");
      if (!("details" in options)) { assert.equal(result, ""); continue; }
      assert.match(result, /(?:Work mode|Mode): Solo/);
      assert.doesNotMatch(result, /Operations|AGENTS|coordinator:/);
      if (count) {
        assert.match(result, /╭─ Task T1: Solo task/);
        assert.match(result, /Status: in_review/);
        assert.equal((result.match(/╭─ Task T\d:/g) ?? []).length, count);
      } else assert.doesNotMatch(result, /╭─ Task/);
    }
    assert.match(renderProgressHtml(data), /(?:Work mode|Mode): Solo/);
    assert.doesNotMatch(renderProgressHtml(data), /Operations/);
  }
});

test("agents have root summaries and flat full saved evidence cards", () => {
  const data = view(); const root = run(); root.children.push(run("reviewer"));
  data.tasks.push({ id: "T1", title: "Formal", status: "in_review", runs: [root] });
  const summary = renderProgress(data, 140, { compact: true }).join("\n");
  assert.match(summary, /󰄬 1\/1 · 󱙺 2/); assert.match(summary, /\u{F17A9}/u);
  assert.doesNotMatch(summary, /reviewer/);
  const details = renderProgress(data, 140, { details: true }).join("\n");
  assert.match(details, /Formal task state · T1 Formal: in_review/);
  assert.match(details, /Parent: worker/);
  assert.match(details, /END/);
  assert.match(details, /╭─ 󰢻 worker: worker/);
  assert.match(details, /╭─ 󰛐 reviewer: reviewer/);
  assert.doesNotMatch(details, /╭─ Task/);
  const cards = renderProgress(data, 140, { details: true }).filter(line => /╭─ [^ ]+ (worker|reviewer):/.test(line));
  assert.equal(cards[0].indexOf("╭"), cards[1].indexOf("╭"));
  assert.match(renderProgressHtml(data), /Mode: Agents/);
  assert.match(renderProgress(data, 140, { details: true, maxRuns: 0 }).join("\n"), /runs hidden/);
});

test("full cards preserve missing metadata, task and global run limits without changing summaries", () => {
  const data = view();
  const root = run(); root.model = undefined; root.thinking = undefined;
  root.summary = undefined; root.task = ""; root.notice = "Delivery notice";
  root.children.push(run("reviewer"));
  data.tasks = [{ id: "T1", title: "Formal", status: "pending", runs: [root] },
    { id: "T2", title: "Omitted", status: "accepted", runs: [] }];
  const before = renderProgress(data, 140, { compact: true });
  const full = renderProgress(data, 140, { details: true, maxRuns: 1, maxTasks: 1 }).join("\n");
  assert.match(full, /Task:   —/);
  assert.match(full, /model unknown ·  thinking unknown/);
  assert.match(full, /Notice: Delivery notice/);
  assert.match(full, /Delivery: completed/);
  assert.match(full, /Formal task state · T1 Formal: pending/);
  assert.doesNotMatch(full, /flat saved evidence/);
  assert.match(full, /runs hidden/); assert.match(full, /1 tasks hidden/);
  assert.doesNotMatch(full, /╭─ 󰛐 reviewer:|Result:/);
  assert.deepEqual(renderProgress(data, 140, { compact: true }), before);
  assert.deepEqual(renderProgress(data, 140, { compact: false }), renderProgress(data, 140, { compact: false, details: false }));
  data.tasks.forEach(task => task.runs = []);
  const solo = renderProgress(data, 140, { details: true, maxTasks: 0 }).join("\n");
  assert.match(solo, /2 tasks hidden/); assert.doesNotMatch(solo, /╭─ Task/);
});

test("nested, unassigned and standalone coordinators select coordinated views cycle-safely", () => {
  for (const location of ["nested", "unassigned", "standalone"]) {
    const data = view(); const coord = run("feature-coordinator");
    const root = run(); root.children.push(coord); coord.children.push(root);
    if (location !== "standalone") data.tasks.push({ id: "T1", title: "Real feature", status: "pending", runs: location === "nested" ? [root] : [] });
    if (location !== "nested") data.unassigned.push(coord);
    const summary = renderProgress(data, 140, { compact: true });
    assert.ok(summary.length <= 10); assert.match(summary.join("\n"), /Main Agent/);
    assert.match(summary.join("\n"), /⟦ .*\+\? ⟧/);
    const details = renderProgress(data, 140, { details: true }).join("\n");
    assert.match(details, /Mode: Coordinated/); assert.match(details, /feature-coordinator:/);
    assert.match(details, /not acceptance/); assert.match(details, /scan truncated/);
    assert.match(renderProgressHtml(data), /Mode: Coordinated/);
  }
});

test("large graphs honor row and card budgets without repeating formal state", () => {
  const data = view();
  const roots = Array.from({ length: 2000 }, (_, i) => ({ ...run(), id: `run-${i}`, name: `Operation ${i}`, summary: undefined }));
  data.tasks.push({ id: "T1", title: "Formal", status: "pending", runs: roots });
  const full = renderProgress(data, 80, { details: true, maxRuns: 1 }).join("\n");
  assert.equal((full.match(/Formal task state/g) ?? []).length, 1);
  assert.ok(full.split("\n").length < 20);
  assert.match(full, /runs hidden/);
  assert.doesNotMatch(full, /Operation 1\b/);
  roots[0].role = "feature-coordinator";
  data.tasks = [];
  data.unassigned = roots;
  const expanded = renderProgress(data, 100, { compact: false, maxRuns: 20 });
  assert.ok(expanded.length <= 23);
  assert.match(expanded.join("\n"), /1980 rows hidden/);
  assert.match(expanded[0], /󱙺 2000/);
});

test("summary and detailed reports select the same nested coordinator feedback and flag incomplete counts", () => {
  const data = view();
  const root = { ...run(), summary: "Worker note" };
  root.children.push({ ...run("feature-coordinator"), summary: "Coordinator note" });
  data.tasks.push({ id: "T1", title: "Feature", status: "pending", runs: [root] });
  data.incomplete = true;
  const summary = renderProgress(data, 100).join("\n");
  assert.match(summary, /󱙺 2\+/);
  assert.match(summary, /counts are a lower bound/);
  assert.match(summary, /· Coordinator note/);
  assert.doesNotMatch(summary, /Worker note/);
  for (const full of [renderProgress(data, 140, { details: true }).join("\n"), renderProgressHtml(data)]) {
    assert.match(full, /Reported feedback \(not acceptance\): Coordinator note/);
    assert.match(full, /Result: Worker note/);
  }
});

test("all modes retain frame width and sanitize saved text", () => {
  for (const role of [undefined, "worker", "coordinator"]) {
    const data = view(); data.notice = "bad\x1b[31mnotice\n\u202e";
    if (role) { const item = run(role); item.name = data.notice; data.unassigned.push(item); }
    for (const compact of [false, true]) for (const width of [0, 1, 2, 5, 12, 40, 140]) {
      const lines = renderProgress(data, width, { compact, details: !compact });
      assert.ok(lines.every(line => visibleWidth(line) <= width));
      assert.doesNotMatch(lines.join("\n"), /\x1b|\u202e/);
      if (compact) assert.ok(lines.length <= 10);
    }
  }
});
