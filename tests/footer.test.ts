import assert from "node:assert/strict";
import test from "node:test";
import { stripVTControlCharacters as strip } from "node:util";
import { visibleWidth } from "@earendil-works/pi-tui";
import clearPi from "../index.ts";
import { parseSettings } from "../config.ts";
import { branchTokens, colors, icons, quotaText, renderFooter } from "../footer.ts";
import { CACHE_MS, RETRY_MS, UsageClient, parseUsage } from "../usage.ts";
import { renderProgress } from "../progress-view.ts";
import { renderProgressHtml } from "../progress-export.ts";

const theme = { fg: (_color: string, text: string) => `\x1b[32m${text}\x1b[39m` } as any;
const usage = { input: 100, cacheRead: 200, cacheWrite: 30, output: 40, totalTokens: 9999 };
const assistant = { type: "message", message: { role: "assistant", usage } };
function harness() {
  const events = new Map<string, Function>();
  const commands = new Map<string, any>();
  const statuses = new Map<string, string>();
  const notices: string[] = [];
  let branch = "main", unsubscribed = 0, renders = 0;
  let branchChanged: (() => void) | undefined;
  let component: any;
  const data = { getGitBranch: () => branch, getExtensionStatuses: () => statuses,
    onBranchChange: (cb: () => void) => { branchChanged = cb; return () => { unsubscribed++; }; } };
  const ctx: any = { mode: "tui", hasUI: true, cwd: "E:/Repositories/界面", thinkingLevel: "high",
    model: { provider: "openai-codex", id: "gpt-mock" }, getContextUsage: () => ({ percent: 12.5, tokens: 125, contextWindow: 1000 }),
    sessionManager: { getBranch: () => [assistant] },
    modelRegistry: { getProviderAuth: async () => undefined },
    ui: { setFooter: (factory: any) => { component?.dispose(); component = factory?.({ requestRender: () => renders++ }, theme, data); },
      notify: (text: string) => notices.push(text) } };
  clearPi({ on: (name: string, fn: Function) => events.set(name, fn), registerCommand: (name: string, cmd: any) => commands.set(name, cmd) } as any);
  return { events, commands, statuses, notices, ctx, data, component: () => component,
    renders: () => renders, unsubscribed: () => unsubscribed,
    switchGit: (name: string) => { branch = name; branchChanged?.(); } };
}

test("only clear-progress is registered; old commands cannot become model prompts in the TUI", () => {
  const h = harness();
  assert.deepEqual([...h.commands.keys()], ["clear-progress"]);
  const handler = h.events.get("input")!;
  for (const text of ["/clear-pi refresh", "/clear-pi-progress expand"]) {
    assert.deepEqual(handler({ text, source: "interactive" }, h.ctx), { action: "handled" });
  }
  assert.match(h.notices[0], /footer/);
  assert.match(h.notices[1], /clear-progress full/);
  for (const text of ["explain /clear-pi", "/clear-pi-example", "/clear-pi-progress\nexplain this"]) {
    assert.equal(handler({ text, source: "interactive" }, h.ctx), undefined);
  }
  assert.equal(handler({ text: "/clear-pi", source: "extension" }, h.ctx), undefined);
});

test("footer, summary and full report share configured runtime symbols; HTML uses labels", () => {
  const h = harness();
  const { footer, progressIcons } = parseSettings({ footer: { model: { icon: "[M]" }, thinking: { icon: "[T]" } } });
  const footerText = renderFooter(h.ctx, theme, h.data, undefined, 160, 0, footer).map(strip).join("\n");
  assert.match(footerText, /\[M\] gpt-mock.*\[T\] high/);
  const view = { title: null, tasks: [], unassigned: [{ id: "1", name: "Task", role: "worker", task: "Check", status: "SAVED",
    model: "openai-codex/gpt-mock", thinking: "high", children: [] }] };
  for (const details of [false, true]) {
    assert.match(renderProgress(view, 100, { details, icons: progressIcons }).join("\n"), /\[M\] gpt-mock · \[T\] high/);
    const hidden = parseSettings({ footer: { model: { enabled: false, icon: "[M]" }, thinking: { icon: "" } } });
    assert.match(renderProgress(view, 100, { details, icons: hidden.progressIcons }).join("\n"), /\[M\] gpt-mock · high/);
  }
  assert.match(renderProgressHtml(view), /Model: gpt-mock · Thinking: high/);
});

test("actual footer component renders requested Unicode, Windows cwd, metrics and optional statuses", async () => {
  const h = harness();
  try {
    h.events.get("session_start")!({}, h.ctx);
    await new Promise(resolve => setImmediate(resolve));
    let lines = h.component().render(300).map(strip);
    assert.equal(lines.length, 2);
    assert.equal(lines[0], `${icons.cwd} E:\\Repositories\\界面 (${icons.git} main)`);
    assert.match(lines[1], new RegExp(`${icons.model} gpt-mock • ${icons.thinking} high • ${icons.sent} 330 • ${icons.received} 40 • ${icons.context} 12.5%`));
    assert.match(lines[1], /Codex login required/);
    h.statuses.set("other", "\x1b[31mwide 界面\x1b[0m\nstatus");
    h.statuses.set("empty", "");
    h.statuses.set("clear-pi", "obsolete own status");
    lines = h.component().render(300).map(strip);
    assert.equal(lines.length, 3);
    assert.equal(lines[2], `${icons.statuses} wide 界面 status`);
    for (let width = 0; width <= 250; width++) {
      for (const line of h.component().render(width)) {
        assert.ok(visibleWidth(line) <= width, `overflow at ${width}: ${strip(line)}`);
        assert.doesNotMatch(strip(line), /[\r\n]/);
        assert.ok(!/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(strip(line)));
      }
    }
    h.switchGit("feature/新");
    assert.match(strip(h.component().render(300)[0]), /feature\/新/);
    h.ctx.thinkingLevel = "low";
    h.events.get("thinking_level_select")!({}, h.ctx);
    assert.match(strip(h.component().render(300)[1]), /low/);
  } finally { h.events.get("session_shutdown")!({}, h.ctx); }
  assert.equal(h.component(), undefined);
  assert.equal(h.unsubscribed(), 1);
});

test("footer fields can be hidden independently without empty lines or separators", () => {
  const h = harness();
  const fields = parseSettings({ footer: { cwd: false, model: false, thinking: false, sent: false,
    received: false, context: false, codexQuota: false, extensionStatuses: false } }).footer;
  h.ctx.sessionManager.getBranch = () => { throw new Error("hidden token counters must not be scanned"); };
  h.ctx.getContextUsage = () => { throw new Error("hidden context must not be fetched"); };
  h.statuses.set("test", "hidden status");
  const render = (options: typeof fields) => renderFooter(h.ctx, theme, h.data as any, undefined, 200, 0, options).map(strip);
  assert.deepEqual(render(fields), [`${icons.git} main`]);
  const noGit = { ...fields, gitBranch: { ...fields.gitBranch, enabled: false } };
  assert.deepEqual(render({ ...noGit, model: { ...fields.model, enabled: true } }), [`${icons.model} gpt-mock`]);
  assert.deepEqual(render(noGit), []);
});

test("every configured footer icon is rendered independently and can be blank", () => {
  const h = harness();
  const client = new UsageClient({ now: () => 0, fetch: async () => { throw new Error("no network"); } });
  client.snapshot = { at: 0, blocked: false, windows: [{ kind: "primary", used: 25, resetAt: 60_000 }] };
  h.statuses.set("test", "status");
  const footer = parseSettings({ footer: {
    cwd: { icon: "📁" }, gitBranch: { icon: "枝" }, model: { icon: "" }, thinking: { icon: "T" },
    sent: { icon: "↑" }, received: { icon: "↓" }, context: { icon: "C" }, codexQuota: { icon: "@" },
    extensionStatuses: { icon: "i" },
  } }).footer;
  const render = (width: number) => renderFooter(h.ctx, theme, h.data as any, client, width, 0, footer).map(strip);
  const [path, metrics, statuses] = render(300);
  assert.equal(path, "📁 E:\\Repositories\\界面 (枝 main)");
  assert.match(metrics, /^gpt-mock • T high • ↑ 330 • ↓ 40 • C 12\.5% • Codex .* • @ 1m$/);
  assert.equal(statuses, "i status");
  assert.equal(quotaText(client, 0, 8, false, false, ""), "Codex primary [▰▰▰▰▰▰▱▱] 75% • 1m");
  for (let width = 1; width <= 100; width++) assert.ok(render(width).every(line => visibleWidth(line) <= width));
});

test("semantic colors use exact thresholds and leave base fields unstyled", () => {
  const h = harness();
  const painted = (color: string, text: string) => `\x1b[38;2;${color}m${text}\x1b[39m`;
  h.ctx.thinkingLevel = "medium";
  for (const [percent, color] of [[0, null], [50, null], [50.1, colors.orange], [79.9, colors.orange], [80, colors.red], [100, colors.red]] as const) {
    h.ctx.getContextUsage = () => ({ percent });
    const lines = renderFooter(h.ctx, theme, h.data as any, undefined, 500);
    assert.equal(lines[0], strip(lines[0]));
    const field = `${icons.context} ${percent.toFixed(1)}%`;
    assert.ok(lines[1].includes(color ? painted(color, field) : field));
    if (!color) assert.equal(lines[1], strip(lines[1]));
  }
  h.ctx.getContextUsage = () => ({ percent: 0 });
  for (const level of ["off", "minimal", "low", "medium", "high", "xhigh", "max"]) {
    h.ctx.thinkingLevel = level;
    const line = renderFooter(h.ctx, theme, h.data as any, undefined, 500)[1];
    const field = `${icons.thinking} ${level}`;
    if (level === "medium") assert.equal(line, strip(line));
    else assert.ok(line.includes(painted(["off", "minimal", "low"].includes(level) ? colors.blue : colors.red, field)));
  }
  const client = new UsageClient({ now: () => 0, fetch: async () => { throw new Error("no network"); } });
  for (const [remaining, color] of [[100, colors.green], [40.1, colors.green], [40, colors.orange], [10, colors.orange], [9.9, colors.red], [0, colors.red]] as const) {
    client.snapshot = { at: 0, blocked: false, windows: [{ kind: "primary", used: 100 - remaining }] };
    const line = quotaText(client, 0, 8, false, true);
    assert.ok(line.includes(`\x1b[38;2;${color}m[`));
    assert.match(strip(line), /\[[▰▱]{8}\]/);
  }
  client.dispose();
});

test("active-branch tokens include cache, tool and summary usage without totalTokens double counts", () => {
  const h = harness();
  h.ctx.sessionManager.getBranch = () => [assistant,
    { type: "message", message: { role: "toolResult", usage } },
    { type: "message", message: { role: "toolResult" } },
    { type: "usage", usage }, { type: "compaction", usage }, { type: "branch_summary", usage },
    { type: "message", message: { role: "assistant", usage: null } }];
  assert.deepEqual(branchTokens(h.ctx), { sent: 1650, received: 200 });
  h.ctx.sessionManager.getBranch = () => [];
  assert.deepEqual(branchTokens(h.ctx), { sent: 0, received: 0 });
  for (const context of [undefined, { percent: null, tokens: null }, { percent: NaN }, { percent: 0 }]) {
    h.ctx.getContextUsage = () => context;
    const line = strip(renderFooter(h.ctx, theme, h.data as any, undefined, 300)[1]);
    assert.ok(line.includes(context?.percent === 0 ? "0.0%" : "?%"));
  }
});

test("footer caches active branch tokens and context until the session, leaf, entry count or model changes", () => {
  const h = harness();
  let sessionId = "session-a", leafId = "branch-a", entryCount = 2;
  let entries: unknown[] = [assistant];
  let percent: number | null = 12.5;
  let branchReads = 0, contextReads = 0;
  h.ctx.model.contextWindow = 1000;
  h.ctx.sessionManager = {
    getSessionId: () => sessionId, getLeafId: () => leafId, getEntryCount: () => entryCount,
    getEntries: () => { throw new Error("must not copy all session entries"); },
    getBranch: () => { branchReads++; return entries; },
  };
  h.ctx.getContextUsage = () => { contextReads++; return { percent }; };
  const render = (width = 300) => strip(renderFooter(h.ctx, theme, h.data as any, undefined, width)[1]);
  assert.ok(render().includes(`${icons.sent} 330`));
  assert.ok(render(250).includes("12.5%"));
  assert.deepEqual([branchReads, contextReads], [1, 1]);

  leafId = "branch-b";
  entries = [];
  percent = 0;
  assert.ok(render().includes(`${icons.sent} 0`));
  assert.ok(render().includes("0.0%"));
  assert.deepEqual([branchReads, contextReads], [2, 2]);

  h.ctx.model = { ...h.ctx.model, id: "next-model", contextWindow: 2000 };
  percent = 6.25;
  assert.ok(render().includes("6.3%"));
  assert.deepEqual([branchReads, contextReads], [3, 3]);

  // Count changes are independently sufficient, even at an unchanged leaf.
  entryCount++;
  entries = [assistant, { type: "usage", usage }];
  assert.ok(render().includes(`${icons.sent} 660`));
  assert.deepEqual([branchReads, contextReads], [4, 4]);

  leafId = "compaction";
  entryCount++;
  entries.push({ type: "compaction", usage });
  percent = null;
  const compacted = render();
  assert.ok(compacted.includes(`${icons.sent} 990`));
  assert.ok(compacted.includes(`${icons.context} ?%`));
  assert.equal(render(), compacted);
  assert.deepEqual([branchReads, contextReads], [5, 5]);

  sessionId = "session-b";
  entries = [];
  assert.ok(render().includes(`${icons.sent} 0`));
  assert.deepEqual([branchReads, contextReads], [6, 6]);

  h.ctx.model = { ...h.ctx.model, api: "pi-virtual" };
  percent = 11;
  assert.ok(render().includes("11.0%"));
  percent = 22; // Routed model limits aren't available on the extension context.
  assert.ok(render().includes("22.0%"));
  assert.deepEqual([branchReads, contextReads], [7, 8]);
});

test("quota rendering: bars, both windows, reset countdown, unknown, stale, error and limited", () => {
  const client = new UsageClient({ now: () => 0, fetch: async () => { throw new Error("no network"); } });
  assert.equal(quotaText(client, 0), "Codex loading");
  assert.equal(quotaText(undefined, 0), "Codex unsupported provider");
  client.snapshot = parseUsage({ rate_limit: { allowed: false,
    primary_window: { used_percent: 25, limit_window_seconds: 18000, reset_after_seconds: 3600 },
    secondary_window: { used_percent: 100, limit_window_seconds: 604800 } } }, 0);
  assert.match(quotaText(client, 0), /5h \[▰▰▰▰▰▰▱▱\] 75%/);
  assert.match(quotaText(client, 0), /7d0h \[▱▱▱▱▱▱▱▱\] 0%/);
  assert.ok(quotaText(client, 0).includes(`75% • ${icons.reset} 1h`));
  assert.ok(quotaText(client, 120000).includes(`${icons.reset} 58m`));
  assert.ok(quotaText(client, 0).includes(`${icons.reset} ?`));
  assert.match(quotaText(client, 0), /limited/);
  const h = harness();
  const compact = strip(renderFooter(h.ctx, theme, h.data as any, client, 120, 0)[1]);
  assert.match(compact, /5h.*75%.*7d0h.*0%/);
  assert.equal(compact.split(icons.reset).length, 3);
  for (let width = 0; width <= 250; width++) {
    for (const line of renderFooter(h.ctx, theme, h.data as any, client, width, 0)) assert.ok(visibleWidth(line) <= width);
  }
  assert.match(quotaText(client, CACHE_MS), /stale/);
  assert.match(quotaText(client, 3600000), /due.*stale/);
  client.failure = "unavailable";
  assert.match(quotaText(client, 0), /stale \(unavailable\)/);
  client.snapshot = parseUsage({ rate_limit: { primary_window: { used_percent: 0 } } }, 0);
  assert.match(quotaText(client, 0), /primary \[▰▰▰▰▰▰▰▰\] 100%/);
  client.snapshot = parseUsage({ rate_limit: { secondary_window: { used_percent: 0 } } }, 0);
  assert.match(quotaText(client, 0), /^Codex secondary \[▰▰▰▰▰▰▰▰\] 100%/);
  client.dispose();
});

test("quota schedules only countdown, expiry and retry work; provider switch and shutdown cancel it", async (t) => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout", "setInterval"], now: 1_800_000_000_000 });
  const h = harness();
  let calls = 0, authCalls = 0, unavailable = false;
  const token = `header.${Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "mock-account" } })).toString("base64url")}.signature`;
  const resetAt = (Date.now() + CACHE_MS + 630_000) / 1000;
  t.mock.method(globalThis, "fetch", async () => {
    calls++;
    return unavailable ? new Response(null, { status: 500 })
      : Response.json({ rate_limit: { primary_window: { used_percent: 25, reset_at: resetAt } } });
  });
  h.ctx.modelRegistry.getProviderAuth = async () => { authCalls++; return { auth: { apiKey: token } }; };
  const other = { ...h.ctx, model: { provider: "other", id: "other-model" } };
  const tick = async (ms: number) => { t.mock.timers.tick(ms); await new Promise(resolve => setImmediate(resolve)); };
  const line = () => strip(h.component().render(300)[1]);
  try {
    h.events.get("session_start")!({}, other);
    let before = h.renders();
    await tick(CACHE_MS);
    assert.deepEqual([h.renders() - before, authCalls, calls], [0, 0, 0]);

    h.events.get("model_select")!({}, h.ctx);
    await tick(0);
    assert.ok(line().includes(`${icons.reset} 11m`));
    assert.equal(calls, 1);
    h.events.get("model_select")!({}, { ...h.ctx, model: { ...h.ctx.model, id: "another-codex" } });
    before = h.renders();
    await tick(29_999);
    assert.deepEqual([h.renders() - before, calls], [0, 1]);
    assert.equal(h.renders(), before);
    await tick(1);
    assert.ok(line().includes(`${icons.reset} 10m`));
    assert.deepEqual([h.renders() - before, calls], [1, 1]);

    unavailable = true;
    await tick(CACHE_MS - 30_001);
    assert.equal(calls, 1);
    await tick(1);
    assert.equal(calls, 2);
    assert.match(line(), /stale \(unavailable\)/);
    await tick(RETRY_MS - 1);
    assert.equal(calls, 2);
    before = h.renders();
    await tick(1);
    assert.deepEqual([h.renders() - before, calls], [0, 3]);

    h.events.get("model_select")!({}, other);
    assert.match(line(), /other-model.*unsupported provider/);
    before = h.renders();
    await tick(CACHE_MS);
    assert.deepEqual([h.renders() - before, authCalls, calls], [0, 3, 3]);
    h.events.get("model_select")!({}, h.ctx);
    await tick(0);
    assert.equal(calls, 4);
    const retired = h.component();
    h.events.get("session_shutdown")!({}, h.ctx);
    h.events.get("session_shutdown")!({}, h.ctx);
    before = h.renders();
    h.switchGit("late");
    await tick(CACHE_MS);
    assert.deepEqual(retired.render(300), []);
    assert.equal(h.unsubscribed(), 1);
    for (const mode of ["print", "json", "rpc"]) {
      const nonTui = { ...h.ctx, mode };
      h.events.get("session_start")!({}, nonTui);
      assert.equal(h.component(), undefined);
    }
    await tick(CACHE_MS);
    assert.deepEqual([h.renders() - before, authCalls, calls], [0, 4, 4]);
  } finally { h.events.get("session_shutdown")!({}, h.ctx); }
});

test("shutdown aborts pending quota and prevents late footer updates", async () => {
  const original = globalThis.fetch;
  const h = harness();
  let release!: (value: any) => void;
  h.ctx.modelRegistry.getProviderAuth = () => new Promise(resolve => { release = resolve; });
  let calls = 0;
  globalThis.fetch = async () => { calls++; throw new Error("must not fetch"); };
  try {
    h.events.get("session_start")!({}, h.ctx);
    await new Promise(resolve => setImmediate(resolve));
    h.events.get("session_shutdown")!({}, h.ctx);
    const stopped = h.renders();
    release(undefined);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(h.renders(), stopped);
    assert.equal(h.notices.length, 0);
    assert.equal(calls, 0);
  } finally { h.events.get("session_shutdown")!({}, h.ctx); globalThis.fetch = original; }
});
