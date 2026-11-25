import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createProgressReader, readProgress } from "../progress-data.ts";
import { renderProgress } from "../progress-view.ts";
import { renderProgressHtml } from "../progress-export.ts";

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "progress-data-"));
  const root = { sessionId: "root", sessionFile: join(dir, "root.jsonl") };
  const history = join(dir, "artifacts", "root", "subagent-history");
  const runtime = join(dir, "artifacts", "root", "subagent-runtime");
  const branch: any[] = [{ id: "checkpoint", type: "custom", customType: "subagent-custody", data: { branchToken: "token" } }];
  const manager = { getSessionDir: () => dir, getSessionFile: () => root.sessionFile, getHeader: () => ({ id: root.sessionId }), getSessionId: () => root.sessionId, getBranch: () => branch };
  const authority = { sessionId: "root", branchInstanceId: "plan-branch" };
  const plan: any = { schemaVersion: 1, revision: 1, planId: "plan", title: "Feature plan", authority,
    tasks: [{ taskId: "feature", title: "The feature", status: "in_review", attempts: [{ attemptId: "attempt", runIds: ["coordinator"] }] }] };
  const lineage = (child: string, parent = root): any => ({ version: 1, parent, root,
    child: { sessionId: child, sessionFile: join(dir, `${child}.jsonl`) }, rootAssignmentId: "assignment", rootCheckpoint: "checkpoint", rootBranchToken: "token", eventDirectory: history });
  const coordinator = lineage("coordinator-session");
  branch.push({ type: "custom", customType: "subagent-lineage-assignment/v1", data: coordinator });
  const put = (path: string, value: any) => { mkdirSync(join(path, ".."), { recursive: true }); writeFileSync(path, typeof value === "string" ? value : JSON.stringify(value)); };
  const profile = (l: any, role: string) => ({ version: 1, sessionFile: l.child.sessionFile, role, lineage: l,
    runtimePlan: { model: "provider/model", modelId: "model", thinking: "high" } });
  const run = (id = "coordinator", l = coordinator, role = "coordinator") => ({ id, name: id, task: "Implement feature", sessionFile: l.child.sessionFile,
    startTime: 1, phase: "supervised", eventCursor: [], lineage: l, profile: profile(l, role) });
  const manifest: any = { schema: 1, revision: 1, generation: "generation", parent: { sessionFile: root.sessionFile, headerId: "root", branchToken: "token", checkpoint: "checkpoint" }, runs: { coordinator: run() }, outbox: {} };
  let next = 1;
  const event = (runId: string, l: any, kind: string, summary: string, timestamp = "2026-01-01T00:00:00Z") => {
    const id = (next++).toString(16).padStart(64, "0");
    const e = { version: 1, id, runId, lineage: l, kind, summary, timestamp, refs: [l.child.sessionFile] };
    put(join(history, `${id}.json`), e); return e;
  };
  const save = () => put(join(runtime, "manifest.json"), manifest);
  const addPlan = () => branch.push({ type: "custom", customType: "pi-subagents-plan/v1", data: plan });
  return { dir, root, history, runtime, branch, manager, plan, authority, lineage, coordinator, put, profile, run, manifest, event, save, addPlan,
    close: () => rmSync(dir, { recursive: true, force: true }) };
}

test("an accepted main-agent task needs no assignments or run artifacts to appear in Stages", async () => {
  const f = fixture();
  try {
    f.branch.length = 0;
    f.plan.tasks[0].attempts[0].runIds = [];
    f.plan.tasks[0].status = "accepted";
    f.addPlan();
    const { view } = await readProgress(f.manager);
    assert.deepEqual(view.tasks, [{ id: "feature", title: "The feature", status: "accepted", runs: [] }]);
    assert.deepEqual(view.unassigned, []);
    assert.deepEqual(renderProgress(view, 80, { compact: true }), []);
  } finally { f.close(); }
});

test("nested coordinator/worker/reviewer: exact binding, roles, summaries and saved-not-live status", async () => {
  const f = fixture();
  try {
    f.addPlan(); f.save();
    const worker = f.lineage("worker-session", f.coordinator.child);
    const reviewer = f.lineage("reviewer-session", worker.child);
    f.event("coordinator", f.coordinator, "assignment", "Coordinate feature");
    f.event("worker", worker, "assignment", "Build feature", "2026-01-01T00:01:00Z");
    f.event("worker", worker, "result", "Implemented and tested", "2026-01-01T00:02:00Z");
    f.event("reviewer", reviewer, "assignment", "Review feature", "2026-01-01T00:03:00Z");
    f.event("reviewer", reviewer, "result", "Review complete", "2026-01-01T00:04:00Z");
    f.put(`${worker.child.sessionFile}.launch-profile.json`, f.profile(worker, "worker"));
    f.put(`${reviewer.child.sessionFile}.launch-profile.json`, f.profile(reviewer, "reviewer"));
    const { view, watches } = await readProgress(f.manager);
    assert.equal(view.tasks[0].status, "in_review");
    assert.equal(view.tasks[0].runs.length, 1);
    const c = view.tasks[0].runs[0];
    assert.equal(c.status, "SAVED"); assert.equal(c.role, "coordinator");
    assert.equal(c.children.length, 1); assert.equal(c.children[0].role, "worker");
    assert.equal(c.children[0].status, "RESULT REPORTED");
    assert.equal(c.children[0].summary, "Implemented and tested");
    assert.equal(c.children[0].children[0].role, "reviewer");
    assert.equal(c.children[0].children[0].summary, "Review complete");
    assert.equal(c.children[0].thinking, "high"); assert.equal(c.model, "provider/model");
    assert.equal(view.unassigned.length, 0);
    assert.ok(watches.some(w => w.directory === f.history)); assert.ok(watches.some(w => w.directory === f.runtime));
    assert.match(view.notice!, /not acceptance/);
    assert.deepEqual(readdirSync(f.runtime), ["manifest.json"]); // No writer lease, migration or recovery side effects.
  } finally { f.close(); }
});

test("manifest canonical identity/header and active custody mismatch fail closed", async () => {
  for (const mutate of [
    (f: ReturnType<typeof fixture>) => f.manifest.parent.headerId = "other",
    (f: ReturnType<typeof fixture>) => f.manifest.parent.sessionFile = join(f.dir, "foreign.jsonl"),
    (f: ReturnType<typeof fixture>) => f.manifest.parent.branchToken = "other",
    (f: ReturnType<typeof fixture>) => f.manifest.parent.checkpoint = "other",
  ]) {
    const f = fixture(); try {
      mutate(f); f.save();
      const { view } = await readProgress(f.manager);
      assert.equal(view.unassigned.length, 0); assert.match(view.notice!, /custody mismatch/);
    } finally { f.close(); }
  }
});

test("no guessed task names: exact binding/authority/attempt or attempt runIds only", async () => {
  const f = fixture(); try {
    f.addPlan();
    const valid = { planId: "plan", authority: f.authority, taskId: "feature", attemptId: "attempt" };
    f.manifest.runs.coordinator.planTask = valid;
    f.plan.tasks[0].attempts[0].runIds = [];
    f.save(); assert.equal((await readProgress(f.manager)).view.tasks[0].runs.length, 1);
    for (const patch of [{ planId: "other" }, { taskId: "other" }, { attemptId: "other" }, { authority: { ...f.authority, branchInstanceId: "other" } }]) {
      f.manifest.runs.coordinator.planTask = { ...valid, ...patch }; f.save();
      const { view } = await readProgress(f.manager);
      assert.equal(view.tasks[0].runs.length, 0); assert.equal(view.unassigned.length, 1);
    }
    delete f.manifest.runs.coordinator.planTask;
    f.plan.tasks[0].attempts[0].runIds = ["coordinator"]; f.save();
    assert.equal((await readProgress(f.manager)).view.tasks[0].runs.length, 1);
    f.plan.tasks[0].status = "accepted";
    assert.equal((await readProgress(f.manager)).view.tasks[0].status, "accepted");
    f.branch.pop();
    f.event("coordinator", f.coordinator, "result", "Review complete");
    const withoutPlan = (await readProgress(f.manager)).view;
    assert.equal(withoutPlan.title, null);
    assert.equal(withoutPlan.tasks.length, 0); assert.equal(withoutPlan.unassigned.length, 1);
    const compact = renderProgress(withoutPlan, 80, { compact: true }).join("\n");
    assert.match(compact, /coordinator ⟦ 󱙺 ⟧ · Review complete/);
    assert.doesNotMatch(compact, /Stages:|Unassigned runs|Operations/);
    assert.match(renderProgressHtml(withoutPlan), /coordinator: coordinator.*Delivery: completed/s);
  } finally { f.close(); }
});

test("unknown latest plan never falls back; foreign plan remains read-only and unbound", async () => {
  const f = fixture(); try {
    f.save(); f.addPlan(); f.plan.authority.sessionId = "foreign";
    let view = (await readProgress(f.manager)).view;
    assert.equal(view.tasks[0].runs.length, 0); assert.equal(view.unassigned.length, 1); assert.match(view.notice!, /Foreign/);
    f.branch.push({ type: "custom", customType: "pi-subagents-plan/v99", data: f.plan });
    view = (await readProgress(f.manager)).view;
    assert.equal(view.tasks.length, 0); assert.match(view.notice!, /no fallback/);
    f.branch.at(-1).customType = "pi-subagents-plan/v1"; f.branch.at(-1).data = "corrupt";
    assert.equal((await readProgress(f.manager)).view.tasks.length, 0);
  } finally { f.close(); }
});

test("history only follows authorized scope; corrupt/unknown/event filename mismatch is incomplete", async () => {
  const f = fixture(); try {
    f.event("coordinator", f.coordinator, "assignment", "Coordinate");
    const good = f.event("coordinator", f.coordinator, "result", "Bounded result");
    f.put(join(f.history, `${"f".repeat(64)}.json`), good); // mismatched filename, not a duplicate run
    const unknown = { ...good, id: "e".repeat(64), version: 99 };
    f.put(join(f.history, `${unknown.id}.json`), unknown);
    f.put(join(f.history, `${"d".repeat(64)}.json`), "{broken");
    const foreign = f.lineage("foreign"); foreign.rootBranchToken = "wrong";
    f.event("foreign", foreign, "assignment", "Must not show");
    const { view } = await readProgress(f.manager);
    assert.equal(view.unassigned.length, 1); assert.equal(view.unassigned[0].summary, "Bounded result");
    assert.match(view.notice!, /lower bound/);
    f.branch[1].data = { ...f.coordinator, rootBranchToken: "wrong" };
    const rejected = await readProgress(f.manager);
    assert.equal(rejected.view.unassigned.length, 0); assert.ok(!rejected.watches.some(w => w.directory === f.history));
  } finally { f.close(); }
});

test("valid sibling scopes in the shared history directory neither contribute runs nor make counts incomplete", async () => {
  const f = fixture(); try {
    f.save();
    const read = createProgressReader();
    f.event("coordinator", f.coordinator, "result", "Active result");
    const sibling = { ...f.lineage("sibling"), rootAssignmentId: "sibling-assignment" };
    f.event("coordinator", sibling, "result", "Sibling must not replace active result", "2026-01-02T00:00:00Z");
    const inactive = { ...sibling, rootCheckpoint: "inactive-checkpoint", rootBranchToken: "inactive-token" };
    f.event("inactive", inactive, "assignment", "Inactive work");
    const { view } = await read(f.manager);
    assert.deepEqual(view.unassigned.map(run => [run.id, run.summary]), [["coordinator", "Active result"]]);
    assert.ok(!view.incomplete);
    assert.doesNotMatch(view.notice!, /lower bound/);

    const foreign = { ...sibling, root: { ...f.root, sessionId: "foreign-root" } };
    const misplaced = f.event("foreign", foreign, "assignment", "Foreign root claiming this directory");
    const mismatch = await read(f.manager);
    assert.deepEqual(mismatch.view.unassigned.map(run => run.id), ["coordinator"]);
    assert.ok(mismatch.view.incomplete);
    rmSync(join(f.history, `${misplaced.id}.json`));

    const offDirectory = { ...sibling, eventDirectory: join(f.dir, "other-history") };
    const misfiled = f.event("misfiled", offDirectory, "assignment", "Wrong history directory");
    assert.ok((await read(f.manager)).view.incomplete);
    rmSync(join(f.history, `${misfiled.id}.json`));

    f.event("malformed-sibling", sibling, "result", "x".repeat(321));
    assert.ok((await read(f.manager)).view.incomplete);
  } finally { f.close(); }
});

test("duplicate anchors/events and repeated child-session resumes keep run IDs distinct without duplicating descendants", async () => {
  const f = fixture(); try {
    f.branch.push({ ...f.branch[1] }); f.save();
    f.event("coordinator", f.coordinator, "assignment", "First run", "2026-01-01T00:00:00Z");
    f.event("coordinator", f.coordinator, "assignment", "First run", "2026-01-01T00:00:00Z");
    f.event("resume", f.coordinator, "continuation", "Resume same child", "2026-01-01T00:02:00Z");
    const child = f.lineage("child", f.coordinator.child);
    f.event("child", child, "assignment", "Nested work", "2026-01-01T00:03:00Z");
    f.put(`${child.child.sessionFile}.launch-profile.json`, f.profile(child, "worker"));
    f.put(`${f.coordinator.child.sessionFile}.launch-profile.json`, f.profile(f.coordinator, "coordinator"));
    const { view } = await readProgress(f.manager);
    assert.equal(view.unassigned.length, 2);
    assert.equal(view.unassigned[0].children.length, 0);
    assert.equal(view.unassigned[1].id, "resume"); assert.equal(view.unassigned[1].children.length, 1);
    assert.equal(view.unassigned[1].status, "ASSIGNED");
  } finally { f.close(); }
});

test("own child assignment grants history, but a forked parent's assignment does not", async () => {
  const f = fixture(); try {
    f.event("coordinator", f.coordinator, "assignment", "Own assigned work");
    f.branch.splice(0); f.branch.push({ type: "custom", customType: "subagent-assignment", data: { lineage: f.coordinator } });
    const childManager = { ...f.manager, getSessionFile: () => f.coordinator.child.sessionFile, getHeader: () => ({ id: f.coordinator.child.sessionId }) };
    assert.equal((await readProgress(childManager)).view.unassigned.length, 1);
    assert.equal((await readProgress(f.manager)).view.unassigned.length, 0);
  } finally { f.close(); }
});

test("native active-branch delivery enriches feedback and model; worker claims never accept tasks", async () => {
  const f = fixture(); try {
    f.addPlan(); f.save();
    f.branch.push({ type: "message", message: { role: "custom", customType: "subagent_result", details: {
      eventId: "subagent:coordinator:completion:result1", lineage: f.coordinator, sessionFile: f.coordinator.child.sessionFile,
      structuredResult: { status: "complete", summary: "All done (proposal)" }, runtimePlan: { model: "reported/model", thinking: "max" },
    } } });
    let view = (await readProgress(f.manager)).view;
    assert.equal(view.tasks[0].status, "in_review");
    assert.equal(view.tasks[0].runs[0].status, "RESULT REPORTED");
    assert.equal(view.tasks[0].runs[0].summary, "All done (proposal)");
    assert.equal(view.tasks[0].runs[0].resultStatus, "complete");
    assert.equal(view.tasks[0].runs[0].model, "reported/model");
    f.branch.push({ type: "custom_message", customType: "subagent_result", details: {
      eventId: "subagent:coordinator:completion:failure", lineage: f.coordinator, sessionFile: f.coordinator.child.sessionFile,
      errorMessage: "secret=do-not-expose", response: "password=do-not-expose",
    } });
    view = (await readProgress(f.manager)).view;
    assert.equal(view.tasks[0].runs[0].status, "FAILURE REPORTED");
    assert.ok(!JSON.stringify(view).includes("do-not-expose"));
  } finally { f.close(); }
});

test("projected outcomes are consistent in all reports and ordinary prose is not a verdict", async () => {
  const f = fixture();
  try {
    f.addPlan(); f.save();
    const delivery = (event: string, details: object) => f.branch.push({ type: "custom_message", customType: "subagent_result", details: {
      eventId: `subagent:coordinator:completion:${event}`, lineage: f.coordinator, sessionFile: f.coordinator.child.sessionFile, ...details,
    } });
    delivery("prose", { response: "Partial updates are now supported; all tests passed." });
    let { view } = await readProgress(f.manager);
    assert.match(renderProgress(view, 140).join("\n"), /⟦ 󱙺 ⟧/);
    assert.match(renderProgressHtml(view), /Outcome: not recorded/);
    delivery("heading", { response: "Checks completed.\n## Verdict: BLOCKED — awaiting approval" });
    ({ view } = await readProgress(f.manager));
    assert.match(renderProgress(view, 140).join("\n"), /⟦ 󱙻 ⟧/);
    assert.match(renderProgressHtml(view), /Outcome: blocked/);
    delivery("structured", {
      response: "# Code Review\n**Verdict:** APPROVED\n\n## Summary\nThe review looks good.",
      structuredResult: { status: "partial", summary: "Awaiting approval", artifacts: [], checks: [], unmetCriterionIds: [], risks: [] },
    });
    ({ view } = await readProgress(f.manager));
    assert.match(renderProgress(view, 140).join("\n"), /⟦ 󱙻 ⟧/);
    for (const text of [renderProgress(view, 140, { details: true }).join("\n"), renderProgressHtml(view)]) {
      assert.match(text, /Status: in_review/);
      assert.match(text, /Outcome: partial/);
      assert.match(text, /Delivery: completed/);
    }
  } finally { f.close(); }
});

test("herdr review verdicts are proposals in native delivery and flattened v1 history", async t => {
  const review = (verdict: string) => `# Code Review\n\n**Reviewed:** Progress projection\n**Verdict:** ${verdict}\n\n## Summary\nReviewed the result.\n\n## Checks\n**Status:** FAILED`;
  for (const [name, response, expected] of [
    ["approval", review("APPROVED"), "complete"],
    ["changes requested", review("NEEDS CHANGES"), "changes required"],
    ["standalone partial before checks", "PARTIAL\n\n## Checks\n**Status:** PASSED", "partial"],
    ["fenced example preceding real review", "````markdown\n**Verdict:** APPROVED\n````text\n## Verdict: COMPLETE\n```\n````\n\n" + review("NEEDS CHANGES"), "changes required"],
    ["fenced examples alone", "Review template:\n~~~markdown\n# Code Review\n**Verdict:** APPROVED\n## Status: PASSED\n~~~", "not recorded"],
    ["unclosed fence", "Review template:\n```markdown\n**Verdict:** APPROVED\n## Summary\nExample", "not recorded"],
    ["no verdict assembled across a fence", "# Code Review\n**Verdict:**\n```\nExample\n```\nAPPROVED\n## Summary", "not recorded"],
    ["bare field inside prose", "Review notes mention Verdict: APPROVED", "not recorded"],
  ]) for (const source of ["native", "history"] as const) {
    await t.test(`${name} (${source})`, async () => {
      const f = fixture(); try {
        f.addPlan(); f.save();
        if (source === "native") {
          f.branch.push({ type: "custom_message", customType: "subagent_result", details: {
            eventId: "subagent:coordinator:completion:review", lineage: f.coordinator,
            sessionFile: f.coordinator.child.sessionFile, exitCode: 0, response,
          } });
        } else {
          const reviewer = f.lineage("reviewer", f.coordinator.child);
          f.event("reviewer", reviewer, "assignment", "Review the feature");
          f.put(`${reviewer.child.sessionFile}.launch-profile.json`, f.profile(reviewer, "reviewer"));
          // history.ts boundedSummary collapses whitespace before the UTF-8 cap.
          f.event("reviewer", reviewer, "result", response.replace(/\s+/g, " ").trim(), "2026-01-02T00:00:00Z");
        }
        const { view } = await readProgress(f.manager);
        const run = view.tasks[0].runs[0];
        assert.equal(view.tasks[0].status, "in_review");
        assert.equal((source === "native" ? run : run.children[0]).status, "RESULT REPORTED");
        const outcomes = Array.from(renderProgressHtml(view).matchAll(/Outcome: ([a-z]+(?: [a-z]+)*)/g), match => match[1]);
        assert.deepEqual(outcomes, [expected]);
      } finally { f.close(); }
    });
  }
});

test("full reports retain bounded native result text beyond the summary preview", async () => {
  const f = fixture();
  try {
    f.save();
    f.branch.push({ type: "custom_message", customType: "subagent_result", details: {
      eventId: "subagent:coordinator:completion:detailed", lineage: f.coordinator, sessionFile: f.coordinator.child.sessionFile,
      response: "Notes ".repeat(70) + "SAVED-RESULT-TAIL\n" + "More notes ".repeat(400) + "OUTSIDE-BOUND",
    } });
    const { view } = await readProgress(f.manager);
    const run = view.unassigned[0];
    assert.ok(run.summary!.length <= 320 && run.summary!.endsWith("…"));
    assert.ok(run.result!.length <= 4096 && run.result!.endsWith("…"));
    const html = renderProgressHtml(view);
    assert.match(html, /SAVED-RESULT-TAIL/);
    assert.doesNotMatch(html, /OUTSIDE-BOUND/);
  } finally { f.close(); }
});

test("v1 nested history preserves explicit Markdown verdicts but never infers missing structured data", async () => {
  const f = fixture();
  try {
    f.save();
    const child = f.lineage("reviewer", f.coordinator.child);
    f.event("reviewer", child, "assignment", "Review the feature");
    f.event("reviewer", child, "result", "Review notes ## Verdict: PARTIAL", "2026-01-02T00:00:00Z");
    f.put(`${child.child.sessionFile}.launch-profile.json`, f.profile(child, "reviewer"));
    const neutral = f.lineage("worker", f.coordinator.child);
    f.event("worker", neutral, "assignment", "Implement the feature");
    f.event("worker", neutral, "result", "Partial updates are supported.", "2026-01-02T00:00:00Z");
    f.put(`${neutral.child.sessionFile}.launch-profile.json`, f.profile(neutral, "worker"));
    const { view } = await readProgress(f.manager);
    const summary = renderProgress(view, 140).join("\n");
    assert.match(summary, /󰛑/);
    assert.match(summary, /󰢻/);
    const html = renderProgressHtml(view);
    assert.match(html, /Excerpt: Review notes ## Verdict: PARTIAL[\s\S]*Outcome: partial/);
    assert.match(html, /Excerpt: Partial updates are supported\.[\s\S]*Outcome: not recorded/);
  } finally { f.close(); }
});

test("custody-authorized legacy manifest profiles display metadata without granting history access", async () => {
  const f = fixture(); try {
    f.branch.splice(1);
    delete f.manifest.runs.coordinator.lineage;
    delete f.manifest.runs.coordinator.profile.lineage;
    f.save();
    const { view, watches } = await readProgress(f.manager);
    assert.equal(view.unassigned[0].role, "coordinator");
    assert.equal(view.unassigned[0].status, "SAVED");
    assert.equal(view.unassigned[0].model, "provider/model");
    assert.ok(!watches.some(w => w.directory === f.history));
    assert.match(view.notice!, /lower bound/);
  } finally { f.close(); }
});

test("bounded file sizes, missing history and profile identity mismatch are visibly incomplete", async () => {
  const f = fixture(); try {
    f.save();
    assert.match((await readProgress(f.manager)).view.notice!, /lower bound/);
    const child = f.lineage("child", f.coordinator.child);
    f.event("child", child, "assignment", "Bounded work");
    f.put(`${child.child.sessionFile}.launch-profile.json`, f.profile(f.coordinator, "wrong-role"));
    let result = await readProgress(f.manager);
    assert.equal(result.view.unassigned[0].children[0].role, "unknown");
    assert.match(result.view.notice!, /lower bound/);
    f.put(join(f.history, `${"b".repeat(64)}.json`), "x".repeat(24577));
    f.put(join(f.runtime, "manifest.json"), "x".repeat(2 * 1024 * 1024 + 1));
    result = await readProgress(f.manager);
    assert.match(result.view.notice!, /lower bound/);
    assert.ok(!JSON.stringify(result).includes("wrong-role"));
  } finally { f.close(); }
});

test("OSC 8 labels survive projection, TUI and local HTML without private targets", async () => {
  const f = fixture(); try {
    f.addPlan(); f.save();
    f.plan.title = "\x1b]8;;https://private.example/bel\x07<Plan>\x1b]8;;\x07";
    f.event("coordinator", f.coordinator, "result", "\x1b]8;;file:///private/st\x1b\\Local report\x1b]8;;\x1b\\");
    const { view } = await readProgress(f.manager);
    for (const output of [JSON.stringify(view), renderProgress(view, 100, { details: true }).join("\n"), renderProgressHtml(view)]) {
      assert.match(output, /(?:<|&lt;)Plan(?:>|&gt;)/);
      assert.match(output, /Local report/);
      assert.doesNotMatch(output, /private\.example|file:\/\/\/private/);
    }
    assert.match(renderProgressHtml(view), /&lt;Plan&gt;/);
  } finally { f.close(); }
});

test("a descendant is unassigned when its only confirmed parent run starts later", async () => {
  const f = fixture(); try {
    f.addPlan();
    const child = f.lineage("child", f.coordinator.child);
    f.event("child", child, "assignment", "Nested work", "2026-01-01T00:01:00Z");
    f.event("child", child, "result", "Proposed done", "2026-01-01T00:02:00Z");
    f.event("resume", f.coordinator, "continuation", "Later resume", "2026-01-01T00:05:00Z");
    f.event("unknown-parent", f.coordinator, "result", "Unconfirmed report", "2026-01-01T00:00:00Z");
    f.put(`${child.child.sessionFile}.launch-profile.json`, f.profile(child, "worker"));
    f.put(`${f.coordinator.child.sessionFile}.launch-profile.json`, f.profile(f.coordinator, "coordinator"));
    const { view } = await readProgress(f.manager);
    assert.equal(view.unassigned.find(r => r.id === "resume")?.children.length, 0);
    assert.equal(view.unassigned.find(r => r.id === "child")?.status, "RESULT REPORTED");
    assert.equal(view.tasks[0].status, "in_review");
    assert.match(view.notice!, /Incomplete evidence/);
  } finally { f.close(); }
});

test("cache loads only new or changed event files and revalidates the current branch's authority", async () => {
  const f = fixture(); try {
    const loaded: string[] = [];
    const { readFile } = await import("node:fs/promises");
    const read = createProgressReader(async path => { if (path.startsWith(f.history)) loaded.push(path); return JSON.parse(await readFile(path, "utf8")); });
    f.event("coordinator", f.coordinator, "assignment", "First");
    const result = f.event("coordinator", f.coordinator, "result", "Initial result");
    const path = join(f.history, `${result.id}.json`);
    assert.equal((await read(f.manager)).view.unassigned[0].summary, "Initial result");
    assert.equal(loaded.length, 2);
    loaded.length = 0;
    f.put(join(f.dir, "unrelated.txt"), "notes");
    assert.equal((await read(f.manager)).view.unassigned[0].summary, "Initial result");
    assert.deepEqual(loaded, []);
    f.put(path, { ...result, summary: "Updated result from changed file" });
    const fresh = f.event("new", f.coordinator, "assignment", "New artifact");
    assert.equal((await read(f.manager)).view.unassigned[0].summary, "Updated result from changed file");
    assert.deepEqual(new Set(loaded), new Set([path, join(f.history, `${fresh.id}.json`)]));
    rmSync(path);
    assert.equal((await read(f.manager)).view.unassigned[0].summary, undefined);
    loaded.length = 0;
    f.branch[0].data.branchToken = "other";
    f.branch[1].data = { ...f.coordinator, rootBranchToken: "other" };
    const rejected = await read(f.manager);
    assert.equal(rejected.view.unassigned.length, 0);
    assert.ok(!rejected.view.incomplete); // Previously authorized files are now valid siblings.
    assert.deepEqual(loaded, []);
  } finally { f.close(); }
});
