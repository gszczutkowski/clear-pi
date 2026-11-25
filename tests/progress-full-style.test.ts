import assert from "node:assert/strict";
import test from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import { renderProgress, type ProgressRun } from "../progress-view.ts";

const run: ProgressRun = { id: "w", name: "unify-full-report", role: "worker", task: "A task\nwith continuation", summary: "first result\nsecond result " + "界面 ".repeat(100) + "END", status: "RESULT REPORTED", model: "provider/gpt-6.1-sol", thinking: "medium", children: [] };
test("full headers align runtime, preserve multiline results and end with delivery status", () => {
  const view = { title: null, branch: "hidden", tasks: [], unassigned: [run] };
  const lines = renderProgress(view, 110, { details: true });
  const output = lines.join("\n");
  assert.match(output, /󰙅 Main Agent/);
  assert.match(output, /Mode: Agents · No active plan/);
  const header = lines.find(line => line.includes(""))!;
  assert.match(header, /╭─ 󰢻 worker: unify-full-report ─+  gpt-6.1-sol ·  medium ─╮/);
  assert.match(output, /Task:   A task/);
  assert.match(output, /│ │         with continuation/);
  assert.match(output, /│ │         second result/);
  assert.match(output, /END/);
  assert.match(output, /Delivery: completed/);
  assert.doesNotMatch(output, /Branch:|Operations|provider\/|flat saved/);
  for (let width = 1; width <= 180; width++) {
    for (const line of renderProgress(view, width, { details: true })) assert.ok(visibleWidth(line) <= width);
  }
});

test("long Solo task titles retain their ending in TUI and the HTML layout", () => {
  const view = { title: "Plan", tasks: [{ id: "T1", status: "accepted", runs: [], title: `${"A long feature description ".repeat(6)}TITLE-END` }], unassigned: [] };
  for (const width of [68, 140]) {
    const output = renderProgress(view, width, { details: true, portable: width === 140 }).join("\n");
    assert.match(output, /Task T1: A long feature/);
    assert.match(output, /TITLE-END/);
    assert.match(output, /Status: accepted/);
  }
});

test("long runtime metadata never erases the run identity", () => {
  const long = { ...run, name: "Identify me", model: `provider/${"very-long-model-".repeat(8)}tail-end` };
  const output = renderProgress({ title: null, tasks: [], unassigned: [long] }, 80, { details: true }).join("\n");
  assert.match(output, /worker: Identify me/);
  assert.match(output, /[\s\S]*very-long-model/);
  assert.match(output, /tail-end[\s\S]* medium/);
});

test("deep coordinated reports keep cards readable at narrow widths", () => {
  let root: ProgressRun = { ...run, name: "Deepest", summary: "A long result ".repeat(200) + "RESULT-END" };
  for (let i = 1; i < 24; i++) root = { ...run, id: `run-${i}`, name: `Level-${i}`, role: i === 23 ? "coordinator" : "worker", summary: undefined, children: [root] };
  const lines = renderProgress({ title: null, tasks: [], unassigned: [root] }, 40, { details: true, maxRuns: 100 });
  assert.ok(lines.length < 500);
  assert.ok(lines.every(line => visibleWidth(line) <= 40));
  assert.match(lines.join("\n"), /Parent: Level-1/);
  assert.match(lines.join("\n"), /RESULT-END/);
});

test("coordinated run delivery is distinct from saved formal status", () => {
  const coord = { ...run, role: "coordinator", status: "RESULT REPORTED", model: undefined, thinking: undefined, children: [] };
  const output = renderProgress({ title: "Plan", tasks: [{ id: "T1", title: "Formal", status: "in_review", runs: [coord] }], unassigned: [] }, 140, { details: true }).join("\n");
  assert.match(output, /Status: in_review/);
  assert.match(output, /Delivery: completed/);
  assert.match(output, / model unknown ·  thinking unknown/);
  assert.doesNotMatch(output, /Status: RESULT REPORTED/);
});
