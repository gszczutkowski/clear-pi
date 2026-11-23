import assert from "node:assert/strict";
import test from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import { progressIcons, renderProgress, type ProgressRun, type ProgressView } from "../progress-view.ts";

const run = (overrides: Partial<ProgressRun> = {}): ProgressRun => ({
  id: "run-1", name: "Implement", role: "worker", task: "Build the feature", status: "completed",
  model: "test-model", thinking: "high", summary: "Implementation ready for review", children: [], ...overrides,
});
const fixture = (): ProgressView => ({
  title: "Release dashboard", notice: "Waiting for acceptance",
  tasks: [
    { id: "T1", title: "Feature one", status: "completed", runs: [run({ role: "coordinator", children: [
      run({ id: "w1", children: [run({ id: "r1", name: "Review", role: "reviewer", summary: "Needs another review" })] }),
      run({ id: "t1", name: "Test", role: "tester", status: "failed", summary: "Two checks failed", notice: "Retry pending" }),
    ] })] },
    { id: "T2", title: "Feature two", status: "accepted", runs: [] },
  ],
  unassigned: [run({ id: "u1", name: "Investigate", role: "scout", summary: "Located relevant code" })],
});
const output = (view = fixture(), details = true) => renderProgress(view, 140, { details }).join("\n");

test("plan checklist comes first and only exact accepted status is checked", () => {
  const view = fixture();
  for (const status of ["pending", "running", "complete", "PASSED", "Accepted", "failed", "blocked", ""]) {
    view.tasks.push({ id: `s-${status}`, title: "Other", status, runs: [] });
  }
  const rendered = output(view);
  assert.match(rendered, /^╭─ Main Agent /);
  assert.match(rendered, /Plan: Release dashboard/);
  assert.ok(rendered.includes(`${progressIcons.unchecked} T1 Feature one (completed)`));
  assert.ok(rendered.includes(`${progressIcons.checked} T2 Feature two (accepted)`));
  assert.equal(rendered.split(progressIcons.checked).length - 1, 1);
  assert.ok(rendered.indexOf(`${progressIcons.checked} T2`) < rendered.indexOf("╭─ Task T1"));
  assert.match(rendered, /Notice: Waiting for acceptance/);
});

const compact = (view: ProgressView, limits = {}) => renderProgress(view, 140, { compact: true, ...limits })
  .slice(1, -1).map(line => line.slice(2, -2).trimEnd());

test("compact panel summarizes solo work using only recorded stages", () => {
  assert.equal(progressIcons.unchecked.codePointAt(0), 0xF0131);
  assert.equal(progressIcons.checked.codePointAt(0), 0xF0C52);
  const view: ProgressView = { title: "Change layout", tasks: [
    { id: "T1", title: "Implementation – Plac: poprawne warstwy", status: "accepted", runs: [] },
    { id: "T2", title: "Verification", status: "in_review", runs: [] },
  ], unassigned: [], notice: "Full report only" };
  assert.deepEqual(compact(view), ["Plan: Change layout", "Stages:",
    `${progressIcons.checked} T1 Implementation – Plac: poprawne warstwy`,
    `${progressIcons.unchecked} T2 Verification (in_review)`]);
});

test("compact panel nests assignments with runtime metadata, without accepting the parent stage", () => {
  const view: ProgressView = { title: "Change layout", tasks: [{ id: "T1", title: "Plac", status: "in_review", runs: [
    run({ id: "coordinator", name: "Coordinate T1", role: "coordinator", status: "RESULT REPORTED", children: [
      run({ id: "worker-id", name: "worker-id", task: "Implement T1 – Plac", status: "RESULT REPORTED" }),
      run({ name: "Review T1 – Plac", role: "reviewer", thinking: "xhigh", status: "RESULT REPORTED" }),
    ] }),
  ] }], unassigned: [], notice: "Full report only" };
  assert.deepEqual(compact(view), ["Plan: Change layout", "Stages:",
    `${progressIcons.unchecked} T1 Plac (in_review)`,
    `   ${progressIcons.checked} Coordinate T1 · coordinator: test-model | high`,
    `      ${progressIcons.checked} Implement T1 – Plac`,
    "         worker: test-model | high",
    `      ${progressIcons.checked} Review T1 – Plac`,
    "         reviewer: test-model | xhigh"]);
});

test("compact panel does not imply success for failed/unassigned runs and honors global limits", () => {
  const view: ProgressView = { title: "Demo", tasks: [
    { id: "T1", title: "First", status: "pending", runs: [run({ model: undefined, thinking: undefined, status: "FAILURE REPORTED" })] },
    { id: "T2", title: "Second", status: "pending", runs: [] },
  ], unassigned: [run({ name: "Investigate", role: "scout", status: "SAVED", thinking: undefined })] };
  assert.deepEqual(compact(view, { maxTasks: 1, maxRuns: 1 }), ["Plan: Demo", "Stages:",
    `${progressIcons.unchecked} T1 First (pending)`,
    `   ${progressIcons.unchecked} worker: Implement (FAILURE REPORTED)`,
    "… 1 tasks hidden (maxTasks)", "… runs hidden (maxRuns)"]);
  assert.deepEqual(compact(view).slice(-3), ["Unassigned runs:",
    `   ${progressIcons.unchecked} Investigate (SAVED)`, "      scout: test-model"]);
});

test("a single standalone operation uses a short model name and compact tree layout", () => {
  const operation = run({ name: "review-tests", role: "reviewer", status: "RESULT REPORTED",
    model: "openai-codex/gpt-6.1-terra", thinking: "low" });
  const view: ProgressView = { title: null, tasks: [], unassigned: [operation] };
  assert.deepEqual(compact(view), [" Plan  ·  None", "", " [✓] review-tests  ·  completed",
    "     └─ reviewer  ·  gpt-6.1-terra  ·  low"]);
  assert.match(output(view), /openai-codex\/gpt-6.1-terra/);
  assert.deepEqual(compact(view, { maxRuns: 0 }), [" Plan  ·  None", "", "… runs hidden (maxRuns)"]);
  operation.status = "SAVED";
  assert.match(compact(view)[2], /\[·\] review-tests  ·  saved/);
});

test("standalone operations show names, recorded statuses and runtime without plan rows", () => {
  const view: ProgressView = { title: null, tasks: [], unassigned: [
    run({ name: "review-tests", role: "reviewer", status: "RESULT REPORTED", thinking: "low" }),
    run({ name: "inspect-code", role: "scout", status: "SAVED", model: undefined, thinking: undefined }),
  ] };
  assert.deepEqual(compact(view), ["No active plan", "", "Operations · 1 completed, 1 saved",
    "   ✓ review-tests · completed", "      reviewer · test-model · low",
    "   · inspect-code · saved", "      scout"]);
  for (const details of [false, true]) {
    const rendered = output(view, details);
    assert.match(rendered, /No active plan/);
    assert.match(rendered, /Operations · 1 completed, 1 saved/);
    assert.doesNotMatch(rendered, /Plan:|Stages:|No tasks|Unassigned runs|running/);
  }
  assert.match(output(view), /Status: completed/);
  assert.match(output(view), /Status: saved/);
});

test("standalone counts include nested operations even when a run limit hides their rows", () => {
  const view: ProgressView = { title: null, tasks: [], unassigned: [
    run({ name: "parent", status: "ASSIGNED", children: [run({ name: "retry-me", status: "FAILURE REPORTED" })] }),
  ] };
  assert.deepEqual(compact(view, { maxRuns: 1 }), ["No active plan", "", "Operations · 1 assigned, 1 failed",
    "   · parent · assigned", "      worker · test-model · high", "… runs hidden (maxRuns)"]);
  assert.match(output(view), /Status: failed/);
});

test("a recorded plan with zero stages still uses plan layout", () => {
  const view: ProgressView = { title: "No active plan", tasks: [], unassigned: [run({ status: "ASSIGNED" })] };
  assert.deepEqual(compact(view).slice(0, 4), ["Plan: No active plan", "Stages:", "No tasks", "Unassigned runs:"]);
  assert.doesNotMatch(output(view), /Operations/);
});

test("compact viewport omits whole run rows and shows its truncation marker inside the frame", () => {
  const view: ProgressView = { title: "Demo", tasks: [{ id: "T1", title: "First", status: "pending", runs: [
    run({ name: "First run" }), run({ name: "Second run" }), run({ name: "Third run" }),
  ] }], unassigned: [] };
  const normal = renderProgress(view, 140, { compact: true });
  assert.equal(normal.length, 10);
  assert.match(normal.at(-2)!, /^│ … more in full view +│$/);
  assert.doesNotMatch(normal.join("\n"), /Third run/);
});

test("details use nested rounded task and role boxes with descriptive results", () => {
  const rendered = output();
  for (const label of ["╭─ Task T1: Feature one", "╭─ coordinator: Implement", "╭─ worker: Implement", "╭─ reviewer: Review", "╭─ tester: Test", "╭─ Unassigned runs", "╭─ scout: Investigate"]) {
    assert.ok(rendered.includes(label), label);
  }
  assert.match(rendered, /│ │ │ │ ╭─ reviewer: Review/);
  assert.match(rendered, /Task: Build the feature/);
  assert.match(rendered, /Status: completed/);
  assert.match(rendered, /Status: failed/);
  assert.match(rendered, /Result: Needs another review/);
  assert.match(rendered, /test-model \| high/);
  assert.match(rendered, /Notice: Retry pending/);
  assert.match(rendered, /Runs: 4 \(coordinator: 1, worker: 1, reviewer: 1, tester: 1\)/);
  assert.match(rendered, /Reported feedback \(not acceptance\): Implementation ready for review/);
  assert.doesNotMatch(rendered, /PASSED|processes/);
});

test("default concise view retains feature checklist and descendant counts without run cards", () => {
  const rendered = renderProgress(fixture(), 140).join("\n");
  assert.equal(rendered, output(fixture(), false));
  assert.ok(rendered.includes(`${progressIcons.unchecked} T1 Feature one`));
  assert.match(rendered, /Runs: 4 \(coordinator: 1, worker: 1, reviewer: 1, tester: 1\)/);
  assert.match(rendered, /Reported feedback \(not acceptance\): Implementation ready for review/);
  assert.doesNotMatch(rendered, /╭─ worker|Task: Build|test-model/);
});

test("display limits are finite, global for runs, visible, and independent of counts", () => {
  const view = fixture();
  let rendered = renderProgress(view, 140, { details: true, maxTasks: 1, maxRuns: 2 }).join("\n");
  assert.match(rendered, /1 tasks hidden \(maxTasks\)/);
  assert.match(rendered, /runs hidden \(maxRuns\)/);
  assert.match(rendered, /Runs: 4/);
  assert.equal((rendered.match(/╭─ (?:coordinator|worker|reviewer|tester|scout):/g) ?? []).length, 2);
  rendered = renderProgress(view, 140, { details: true, maxTasks: 0, maxRuns: 0 }).join("\n");
  assert.match(rendered, /2 tasks hidden/);
  assert.match(rendered, /runs hidden/);
  assert.doesNotMatch(rendered, /╭─ scout:/);
  view.tasks = Array.from({ length: 30 }, (_, i) => ({ id: String(i), title: "Feature", status: "pending", runs: [run()] }));
  view.tasks[0].runs = Array.from({ length: 40 }, () => run());
  rendered = renderProgress(view, 140, { details: true }).join("\n");
  assert.match(rendered, /18 tasks hidden/);
  assert.match(rendered, /runs hidden/);
  assert.equal((rendered.match(/╭─ worker:/g) ?? []).length, 20);
  assert.match(rendered, /Runs: 40/);
});

test("every width 0..250 is safe for Unicode and hostile text in every field", () => {
  const hostile = "界面 👩‍💻 é 🧪 \x1b[31mred\x1b[0m\x1b]8;;https://invalid\x07link\x1b]8;;\x07\x00\r\n\t\x9b\u202e";
  const view: ProgressView = {
    title: hostile, notice: hostile,
    tasks: [{ id: hostile, title: hostile, status: hostile, runs: [run({
      id: hostile, name: hostile, role: hostile, task: hostile, status: hostile,
      model: hostile, thinking: hostile, summary: hostile, notice: hostile,
      children: [run({ name: hostile, children: [run({ summary: hostile })] })],
    })] }], unassigned: [run({ name: hostile })],
  };
  for (const options of [{ details: false }, { details: true }, { compact: true }]) {
    for (let width = 0; width <= 250; width++) {
      const lines = renderProgress(view, width, options);
      if (!width) assert.deepEqual(lines, []);
      if (options.compact) assert.ok(lines.length <= 10);
      for (const line of lines) {
        assert.ok(visibleWidth(line) <= width, `overflow at ${width}: ${line}`);
        assert.doesNotMatch(line, /[\x00-\x1f\x7f-\x9f\u202a-\u202e]/);
        assert.doesNotMatch(line, /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u);
      }
    }
  }
});

test("tiny widths use a flat fallback, empty data and invalid widths are safe", () => {
  const empty: ProgressView = { title: "", tasks: [], unassigned: [] };
  assert.match(output(empty), /Plan: Untitled/);
  assert.match(output(empty), /No tasks/);
  for (const width of [-1, NaN, Infinity]) assert.deepEqual(renderProgress(empty, width), []);
  const lines = renderProgress(fixture(), 11, { details: true });
  assert.ok(lines.length);
  assert.doesNotMatch(lines.join("\n"), /[╭╮╰╯│]/);
  assert.ok(renderProgress(empty, 12.9).every(line => visibleWidth(line) <= 12));
});

test("cycles, excessive depth, and broad input stop with visible safety markers", () => {
  const view = fixture();
  const cycle = run();
  cycle.children.push(cycle);
  view.tasks[0].runs = [cycle];
  let rendered = output(view);
  assert.match(rendered, /Runs: 1\+/);
  assert.match(rendered, /run scan truncated/);
  let root = run();
  for (let i = 0; i < 100; i++) root = run({ children: [root] });
  view.tasks[0].runs = [root];
  rendered = output(view);
  assert.match(rendered, /Runs: 24\+/);
  assert.match(rendered, /run scan truncated/);
  view.tasks[0].runs = Array.from({ length: 2100 }, () => run());
  rendered = output(view);
  assert.match(rendered, /Runs: 2000\+/);
  assert.match(rendered, /run scan truncated/);
});

test("render is deterministic and does not mutate frozen input", () => {
  const view = fixture();
  const freeze = (value: any) => {
    if (value && typeof value === "object") { Object.values(value).forEach(freeze); Object.freeze(value); }
  };
  freeze(view);
  assert.equal(output(view), output(view));
});
