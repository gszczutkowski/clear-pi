import assert from "node:assert/strict";
import test from "node:test";
import { EventEmitter } from "node:events";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createProgressDashboard, PROGRESS_WIDGET } from "../progress.ts";
import { defaultProgress, parseSettings } from "../config.ts";
import { progressIcons, renderProgress, type ProgressView } from "../progress-view.ts";

function harness() {
  const commands = new Map<string, any>();
  let reads = 0, paints = 0, renders = 0, reports = 0;
  let leaf: string | null = "branch-a";
  let blocker: Promise<void> | undefined;
  let widget: any;
  let mode = "tui";
  let directories = ["/scope/history"];
  let view: ProgressView = { title: "Demo", tasks: [{ id: "T1", title: "Feature", status: "pending", runs: [] }], unassigned: [] };
  let broken = false;
  const hiddenWidgets: string[] = [];
  const watches: { path: string; callback: Function; closed: boolean; emitter: EventEmitter }[] = [];
  const ctx: any = { get mode() { return mode; }, hasUI: true, sessionManager: {
    getSessionDir: () => "/scope", getSessionFile: () => "/scope/session-test.jsonl",
    getHeader: () => ({ id: "session-test" }), getLeafId: () => leaf,
  }, ui: {
    setWidget(key: string, factory: any) {
      if (key !== PROGRESS_WIDGET) {
        assert.equal(key, "subagent-plan", "leave the native /subagents-tree widget untouched");
        assert.equal(factory, undefined);
        hiddenWidgets.push(key);
        return;
      }
      paints++;
      widget = factory?.({}, { fg: (_: string, line: string) => line });
    },
    notify() {},
  } };
  const dashboard = createProgressDashboard({ registerCommand: (key: string, command: any) => commands.set(key, command) } as any, {
    createReader: () => async () => {
      reads++;
      const snapshot = { view, watches: directories.map(directory => ({ directory, filename: /^[a-f0-9]{64}\.json$/ })) };
      const waiting = blocker;
      blocker = undefined;
      if (waiting) await waiting;
      if (broken) throw new Error("sensitive raw error");
      return snapshot;
    },
    render: (...args) => { reports++; return renderProgress(...args); },
    watch: ((path: string, callback: Function) => {
      const emitter = new EventEmitter();
      const item = { path, callback, closed: false, emitter };
      watches.push(item);
      return Object.assign(emitter, { close: () => { item.closed = true; } });
    }) as any,
  });
  return { dashboard, ctx, watches, hiddenWidgets, commands, command: (args: string) => commands.get("clear-progress").handler(args, ctx),
    start: () => dashboard.start(ctx, { ...defaultProgress }, () => renders++),
    rendered: () => widget?.render(100).join("\n"), reads: () => reads, paints: () => paints, renders: () => renders,
    setView: (next: ProgressView) => { view = next; }, setDirectories: (next: string[]) => { directories = next; },
    setMode: (next: string) => { mode = next; }, fail: () => { broken = true; }, setLeaf: (next: string) => { leaf = next; },
    reports: () => reports, delayNextRead: () => { const deferred = Promise.withResolvers<void>(); blocker = deferred.promise; return deferred.resolve; } };
}

test("export saves the cached detailed report without reads, UI changes or re-enabling watchers", async () => {
  const root = await mkdtemp(join(tmpdir(), "clear-progress-command-"));
  const h = harness();
  const notices: string[] = [];
  h.ctx.sessionManager.getSessionDir = () => root;
  h.ctx.ui.notify = (message: string) => notices.push(message);
  try {
    await h.start();
    await h.command("off");
    const reads = h.reads(), paints = h.paints(), watches = h.watches.length;
    await h.command("export");
    assert.equal(h.reads(), reads);
    assert.equal(h.paints(), paints);
    assert.equal(h.watches.length, watches);
    assert.ok(h.watches.every(w => w.closed));
    assert.equal(h.rendered(), undefined);
    const directory = join(root, "artifacts", "session-test", "clear-progress");
    const names = await readdir(directory);
    assert.equal(names.length, 1);
    assert.match(await readFile(join(directory, names[0]), "utf8"), /Main Agent/);
    assert.match(notices[0], /^Progress exported:/);
    assert.deepEqual(h.commands.get("clear-progress").getArgumentCompletions("ex").map((item: any) => item.value), ["expand", "export"]);
    h.ctx.sessionManager.getHeader = () => ({ id: "../bad" });
    await h.command("export");
    assert.match(notices[1], /Progress export failed/);
    assert.equal((await readdir(directory)).length, 1);
  } finally { h.dashboard.stop(); await rm(root, { recursive: true, force: true }); }
});

test("progress settings are independent, bounded and default-enabled", () => {
  assert.deepEqual(parseSettings(undefined).progress, defaultProgress);
  assert.deepEqual(parseSettings({ progress: { enabled: false, details: false, maxTasks: 5, maxRuns: 90 } }).progress,
    { enabled: false, details: false, maxTasks: 5, maxRuns: 90 });
  assert.deepEqual(parseSettings({ progress: { enabled: "false", details: null, maxTasks: 0, maxRuns: 101 } }).progress, defaultProgress);
});

test("controller has no startup side effects and uses display-only commands", async () => {
  const h = harness();
  assert.equal(h.reads(), 0);
  assert.equal(h.watches.length, 0);
  await h.start();
  assert.equal(h.reads(), 1);
  assert.match(h.rendered(), /Main Agent/);
  const initialPaints = h.paints();
  h.setView({ title: "Updated", tasks: [{ id: "T1", title: "Feature", status: "accepted", runs: [] }], unassigned: [] });
  await h.command("compact");
  assert.match(h.rendered(), /Updated/);
  assert.match(h.rendered(), /Stages:/);
  assert.ok(h.rendered().includes(`${progressIcons.checked} T1 Feature`));
  assert.doesNotMatch(h.rendered(), /Runs:|Notice:|╭─ Task/);
  assert.match(h.rendered(), /╰[^\n]+╯\n\/clear-progress expand — full view$/);
  assert.deepEqual(h.hiddenWidgets, ["subagent-plan", "subagent-plan"]);
  assert.equal(h.commands.get("clear-progress"), h.commands.get("clear-pi-progress"));
  assert.equal(h.paints(), initialPaints); // No component churn on refresh.
  assert.ok(h.renders() >= 2);
  await h.command("off");
  assert.equal(h.rendered(), undefined);
  assert.ok(h.watches.every(w => w.closed));
  const reads = h.reads();
  h.dashboard.update(h.ctx);
  assert.equal(h.reads(), reads);
  await h.command("expand");
  assert.match(h.rendered(), /Main Agent/);
  h.dashboard.stop();
  assert.equal(h.rendered(), undefined);
  assert.ok(h.watches.every(w => w.closed));
});

test("widget separates delegated work and updated runtime metadata from the parent stage", async () => {
  const h = harness();
  try {
    await h.start();
    h.setView({ title: "Demo", tasks: [{ id: "T1", title: "Feature", status: "in_review", runs: [
      { id: "worker-id", name: "Implement Feature", role: "worker", status: "RESULT REPORTED", task: "Implement Feature",
        model: "test-model", thinking: "high", children: [] },
      { id: "review-id", name: "Review Feature", role: "reviewer", status: "RESULT REPORTED", task: "Review Feature",
        model: "test-model", thinking: "xhigh", children: [] },
    ] }], unassigned: [] });
    await h.command("refresh");
    const rows = h.rendered().split("\n").slice(1, -2).map((line: string) => line.slice(2, -2).trimEnd());
    assert.deepEqual(rows, ["Plan: Demo", "Stages:", `${progressIcons.unchecked} T1 Feature (in_review)`,
      `   ${progressIcons.checked} Implement Feature`, "      worker: test-model | high",
      `   ${progressIcons.checked} Review Feature`, "      reviewer: test-model | xhigh"]);
  } finally { h.dashboard.stop(); }
});

test("watch scopes reconcile atomically, errors close watchers, shutdown ignores late callbacks", async () => {
  const h = harness(); await h.start();
  const original = h.watches[0];
  h.setDirectories(["/scope/new"]);
  await h.command("refresh");
  assert.ok(original.closed);
  assert.equal(h.watches[1].path, "/scope/new");
  h.watches[1].emitter.emit("error", new Error("gone"));
  assert.ok(h.watches[1].closed);
  await h.command("refresh");
  assert.equal(h.watches.length, 3);
  h.dashboard.stop();
  original.callback();
  const reads = h.reads();
  await h.command("expand");
  assert.equal(h.reads(), reads);
});

test("file/native refresh bursts coalesce and pending work is cancelled on shutdown", async () => {
  const h = harness(); await h.start();
  const initial = h.reads();
  h.watches[0].callback(); h.watches[0].callback(); h.dashboard.update(h.ctx);
  assert.equal(h.reads(), initial);
  await new Promise(resolve => setTimeout(resolve, 120));
  assert.equal(h.reads(), initial + 1);
  h.watches[0].callback();
  h.dashboard.stop();
  await new Promise(resolve => setTimeout(resolve, 120));
  assert.equal(h.reads(), initial + 1);
});

test("non-TUI and empty sessions remain untouched; manual view can show empty state", async () => {
  const h = harness();
  h.setMode("rpc"); await h.start();
  await h.command("expand");
  assert.equal(h.reads(), 0);
  assert.equal(h.watches.length, 0);
  h.setMode("tui"); h.setView({ title: null, tasks: [], unassigned: [] }); await h.start();
  assert.equal(h.rendered(), undefined);
  await h.command("");
  assert.match(h.rendered(), /No active plan/);
  assert.doesNotMatch(h.rendered(), /No tasks|Stages:|Operations/);
  h.dashboard.stop();
});

test("tall plans have a bounded preview and a keyboard/mouse scrollable full view", async () => {
  const h = harness();
  h.setView({ title: "Long plan", tasks: Array.from({ length: 12 }, (_, i) => ({
    id: `T${i + 1}`, title: `Feature ${i + 1}`, status: "pending", runs: [],
  })), unassigned: [] });
  await h.start();
  assert.ok(h.rendered().split("\n").length <= 11);
  assert.match(h.rendered(), /│ … more in full view +│/);
  let closed = false;
  h.ctx.ui.custom = async (factory: any) => {
    const component = factory({ terminal: { rows: 20 }, requestRender() {} },
      { fg: (_: string, text: string) => text },
      { matches: (data: string, action: string) => data === action }, () => { closed = true; });
    const reports = h.reports();
    const first = component.render(80).join("\n");
    assert.match(first, /Main Agent/);
    assert.ok(first.split("\n").length <= 14);
    component.handleInput("\x1b[F"); // End
    const last = component.render(80).join("\n");
    assert.match(last, /Task T12/);
    assert.notEqual(last, first);
    component.handleInput("\x1b[H"); // Home
    assert.equal(component.render(80).join("\n"), first);
    component.handleMouse({ type: "wheel", wheelDelta: 1 });
    assert.notEqual(component.render(80).join("\n"), first);
    component.handleInput("tui.select.down");
    component.render(80);
    component.handleInput("\x1b[6~"); // Page Down
    component.render(80);
    component.handleInput("\x1b[5~"); // Page Up
    component.render(80);
    assert.equal(h.reports(), reports + 1);
    component.render(90);
    assert.equal(h.reports(), reports + 2);
    h.setView({ title: "Changed", tasks: [], unassigned: [] });
    await h.command("refresh");
    component.handleInput("\x1b[H");
    assert.match(component.render(90).join("\n"), /Changed/);
    assert.equal(h.reports(), reports + 3);
    component.handleInput("tui.select.cancel");
  };
  await h.command("expand");
  assert.ok(closed);
  h.dashboard.stop();
});

test("unavailable data clears old accepted state and sanitizes observer failures", async () => {
  const h = harness(); await h.start(); h.fail();
  await h.command("refresh");
  assert.match(h.rendered(), /No active plan/);
  assert.doesNotMatch(h.rendered(), /sensitive raw error|Notice:/);
  assert.ok(!h.rendered().includes(progressIcons.checked));
  assert.ok(h.watches.every(w => w.closed));
  h.dashboard.stop();
});

for (const enabled of [false, true]) test(`export rejects the old leaf (${enabled ? "pending refresh" : "panel off"})`, async () => {
  const root = await mkdtemp(join(tmpdir(), "clear-progress-stale-"));
  const h = harness();
  h.ctx.sessionManager.getSessionDir = () => root;
  const notices: string[] = [];
  h.ctx.ui.notify = (message: string) => notices.push(message);
  try {
    await h.start();
    if (!enabled) await h.command("off");
    h.setLeaf("branch-b");
    h.setView({ title: "Branch B", tasks: [], unassigned: [] });
    h.dashboard.update(h.ctx);
    const reads = h.reads();
    await h.command("export");
    assert.match(notices[0], /\/clear-progress refresh/);
    assert.equal(h.reads(), reads);
    assert.deepEqual(await readdir(root), []);
    await h.command("refresh");
    const refreshed = h.reads();
    await h.command("export");
    assert.equal(h.reads(), refreshed);
    const dir = join(root, "artifacts", "session-test", "clear-progress");
    const files = await readdir(dir);
    assert.equal(files.length, 1);
    const html = await readFile(join(dir, files[0]), "utf8");
    assert.match(html, /Branch B/);
    assert.doesNotMatch(html, /Demo/);
  } finally { h.dashboard.stop(); await rm(root, { recursive: true, force: true }); }
});

test("watch events are filtered by exact filenames, with a fallback for missing names", async () => {
  const h = harness();
  try {
    await h.start();
    await h.command("refresh"); // No initial watcher reconciliation still pending.
    const count = h.reads();
    const callback = h.watches[0].callback;
    callback("rename", "unrelated.txt");
    await new Promise(resolve => setTimeout(resolve, 120));
    assert.equal(h.reads(), count);
    callback("change", `${"a".repeat(64)}.json`);
    callback("change", null);
    await new Promise(resolve => setTimeout(resolve, 120));
    assert.equal(h.reads(), count + 1);
    callback("rename", null);
    await new Promise(resolve => setTimeout(resolve, 120));
    assert.equal(h.reads(), count + 2);
  } finally { h.dashboard.stop(); }
});

test("in-flight snapshots neither repaint another branch nor remount an off panel", async () => {
  const h = harness();
  try {
    await h.start();
    const stale = h.delayNextRead();
    const a = h.command("refresh");
    h.setLeaf("branch-b");
    h.setView({ title: "Branch B", tasks: [], unassigned: [] });
    stale(); await a;
    assert.doesNotMatch(h.rendered(), /Demo/);
    await h.command("refresh");
    assert.match(h.rendered(), /Branch B/);
    const late = h.delayNextRead();
    const b = h.command("refresh");
    await h.command("off");
    const count = h.renders();
    late(); await b;
    assert.equal(h.renders(), count);
    assert.equal(h.rendered(), undefined);
    assert.ok(h.watches.every(w => w.closed));
  } finally { h.dashboard.stop(); }
});
