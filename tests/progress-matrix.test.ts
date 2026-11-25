import assert from "node:assert/strict";
import test from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import { renderProgress, type ProgressRun, type ProgressView } from "../progress-view.ts";
const run = (role: string, summary?: string): ProgressRun => ({ id: role, name: role, role, summary, task: "Feature", status: "RESULT REPORTED", children: [] });
const fixture = (): ProgressView => ({ title: "Summary", branch: "feature/redesign", tasks: [{ id: "F01.A", title: "中文 feature", status: "accepted", runs: [{ ...run("feature-coordinator", "Coordinated result"), children: [run("worker", "PASS"), run("reviewer", "Verdict: CHANGES_REQUIRED"), run("ui-tester", "PARTIAL")] }] }, { id: "T2", title: "Other", status: "blocked", runs: [run("worker")] }], unassigned: [] });

test("coordinated summary has framed header, formal states, ordered individual runs and coordinator-only feedback", () => {
  const view = fixture();
  const lines = renderProgress(view, 150, { compact: true, maxRuns: 0 });
  const output = lines.join("\n");
  assert.ok(lines.length <= 10);
  assert.match(lines[0], /^╭─ Main Agent ─+ 󰄬 1\/2 · 󱙺 5 ─╮$/);
  assert.equal(visibleWidth(lines[0]), visibleWidth(lines.at(-1)!));
  assert.match(output, /󰄬 F01.A 中文 feature/);
  assert.match(output, /󰂭 T2 Other/);
  assert.match(output, /⟦ 󱙺 󰢻 󰛑 󱏵 ⟧ · Coordinated result/);
  assert.doesNotMatch(output, /accepted\/complete|normal\/failed|one icon\/run|tester\/UI/);
  assert.doesNotMatch(output, /PARTIAL|Verdict:/);
  assert.match(renderProgress(view, 150, { details: true }).join("\n"), /Verdict: CHANGES_REQUIRED/);
});

test("reported problems cross only the reporting run, including partial and blocked outcomes", () => {
  const view = fixture();
  const root = view.tasks[0].runs[0];
  root.resultStatus = "partial";
  root.children = [run("worker", "**STATUS: PARTIAL — grafiki odrzucone**"),
    run("reviewer", "## VERDICT — PARTIAL"),
    run("worker", "Zapisano raport recenzenta (PARTIAL). Kontrole PASS."),
    run("worker", "STATUS: BLOCKED"), run("worker", "PASS — no failed tests")];
  assert.match(renderProgress(view, 250).join("\n"), /⟦ 󱙻 󱏏 󰛑 󰢻 󱏏 󰢻 ⟧/);
});

test("all descendant role failures survive repair and display limits; reports are coordinator-only", () => {
  const view = fixture(); const root = view.tasks[0].runs[0];
  root.children = [run("worker", "PASS"), { ...run("worker"), status: "FAILURE REPORTED" }, run("worker", "PASS"),
    ...["tester", "reviewer", "documenter", "scout", "architect", "custom"].map(role => ({ ...run(role), status: "FAILURE REPORTED" }))];
  const output = renderProgress(view, 250, { maxRuns: 0 }).join("\n");
  assert.match(output, /⟦ 󱙺 󰢻 󱏏 󰢻 󱏵 󰛑 󱘡 󰮁 󱕛 󱙻 ⟧/);
  assert.doesNotMatch(output, /×\d/);
  // A later successful worker does not hide or transfer the second worker's failure.
  assert.equal(output.split("\n")[1].match(/󱏏/g)?.length, 1);
  root.summary = undefined;
  assert.match(renderProgress(view, 150).join("\n"), /no coordinator text/);
  assert.match(renderProgress(view, 150).join("\n"), /󰄬 1\/2/);
});

test("summary width, sanitization, cycle bounds, hidden rows and preserved feature IDs", () => {
  const view = fixture(); view.tasks[0].title += "\x1b[31m\nBAD\u202e";
  const root = view.tasks[0].runs[0]; root.children.push(root);
  for (let i = 0; i < 12; i++) view.tasks.push({ id: `T${i + 3}`, title: "Long task title ".repeat(30), status: "pending", runs: [] });
  for (let width = 1; width <= 250; width++) {
    const lines = renderProgress(view, width, { compact: true });
    assert.ok(lines.length <= 10);
    assert.ok(lines.every(line => visibleWidth(line) <= width));
    assert.ok(lines.every(line => !/[\x1b\n\u202e]/.test(line)));
  }
  assert.match(renderProgress(view, 150).join("\n"), /rows hidden/);
  assert.match(renderProgress(view, 150, { maxTasks: 1 }).join("\n"), /13 rows hidden/);
  assert.match(renderProgress(view, 150).join("\n"), /\+\? ⟧/);
  assert.match(renderProgress(view, 150).join("\n"), /Coordinated result/);
});

test("standalone coordinators and nested detection use summary; no coordinator preserves Agents", () => {
  const standalone: ProgressView = { title: null, tasks: [], unassigned: [run("coordinator", "Saved coordinator feedback")] };
  assert.match(renderProgress(standalone, 150).join("\n"), /Saved coordinator feedback/);
  const view = fixture(); view.tasks[0].runs[0].role = "worker";
  assert.match(renderProgress(view, 100).join("\n"), /󰄬 2\/2 · 󱙺 5/);
});
