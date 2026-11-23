import assert from "node:assert/strict";
import test from "node:test";
import { stripVTControlCharacters as strip } from "node:util";
import { visibleWidth } from "@earendil-works/pi-tui";
import clearPi from "../index.ts";
import { parseSettings } from "../config.ts";
import { branchTokens, colors, icons, quotaText, renderFooter } from "../footer.ts";
import { CACHE_MS, UsageClient, parseUsage } from "../usage.ts";

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

test("actual footer component renders requested Unicode, Windows cwd, metrics and optional statuses", async () => {
  const h = harness();
  try {
    h.events.get("session_start")!({}, h.ctx);
    await h.commands.get("clear-pi").handler("refresh", h.ctx);
    let lines = h.component().render(300).map(strip);
    assert.equal(lines.length, 2);
    assert.equal(lines[0], `E:\\Repositories\\界面 (${icons.git} main)`);
    assert.match(lines[1], new RegExp(`${icons.model} gpt-mock • ${icons.thinking} high • ${icons.sent} 330 • ${icons.received} 40 • ${icons.context} 12.5%`));
    assert.match(lines[1], /Codex login required/);
    h.statuses.set("other", "\x1b[31mwide 界面\x1b[0m\nstatus");
    h.statuses.set("empty", "");
    h.statuses.set("clear-pi", "obsolete own status");
    lines = h.component().render(300).map(strip);
    assert.equal(lines.length, 3);
    assert.equal(lines[2], "wide 界面 status");
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
  assert.deepEqual(render({ ...fields, gitBranch: false, model: true }), [`${icons.model} gpt-mock`]);
  assert.deepEqual(render({ ...fields, gitBranch: false }), []);
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
    client.snapshot = { at: 0, blocked: false, windows: [{ used: 100 - remaining }] };
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
  client.snapshot = { at: 0, blocked: false, windows: [{ used: 0 }] };
  assert.match(quotaText(client, 0), /primary \[▰▰▰▰▰▰▰▰\] 100%/);
  client.dispose();
});

test("lifecycle: cache preserved, active branch switch, timer repaint, provider switch and idempotent cleanup", async () => {
  const original = globalThis.fetch;
  let calls = 0;
  const token = `header.${Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "mock-account" } })).toString("base64url")}.signature`;
  globalThis.fetch = async () => { calls++; return Response.json({ rate_limit: { primary_window: { used_percent: 25 } } }); };
  const h = harness();
  h.ctx.modelRegistry.getProviderAuth = async () => ({ auth: { apiKey: token } });
  try {
    h.events.get("session_start")!({}, h.ctx);
    await h.commands.get("clear-pi").handler("refresh", h.ctx);
    assert.equal(calls, 1);
    await h.commands.get("clear-pi").handler("", h.ctx);
    assert.equal(calls, 1);
    h.events.get("model_select")!({}, h.ctx);
    assert.equal(calls, 1);
    const before = h.renders();
    await new Promise(resolve => setTimeout(resolve, 1050));
    assert.ok(h.renders() > before);
    assert.equal(calls, 1);
    h.ctx.sessionManager.getBranch = () => [];
    h.events.get("session_tree")!({}, h.ctx);
    assert.ok(strip(h.component().render(300)[1]).includes(`${icons.sent} 0`));
    const other = { ...h.ctx, model: { provider: "other", id: "other-model" } };
    h.events.get("model_select")!({}, other);
    assert.match(strip(h.component().render(300)[1]), /other-model.*unsupported provider/);
    const retired = h.component();
    h.events.get("session_shutdown")!({}, h.ctx);
    h.events.get("session_shutdown")!({}, h.ctx);
    const stopped = h.renders();
    h.switchGit("late");
    assert.equal(h.renders(), stopped);
    assert.deepEqual(retired.render(300), []);
    assert.equal(h.unsubscribed(), 1);
    for (const mode of ["print", "json", "rpc"]) {
      h.events.get("session_start")!({}, { ...h.ctx, mode });
      assert.equal(h.component(), undefined);
    }
    assert.equal(calls, 1);
  } finally { h.events.get("session_shutdown")!({}, h.ctx); globalThis.fetch = original; }
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
    const pending = h.commands.get("clear-pi").handler("refresh", h.ctx);
    await new Promise(resolve => setImmediate(resolve));
    h.events.get("session_shutdown")!({}, h.ctx);
    const stopped = h.renders();
    release(undefined);
    await pending;
    assert.equal(h.renders(), stopped);
    assert.equal(h.notices.length, 0);
    assert.equal(calls, 0);
  } finally { h.events.get("session_shutdown")!({}, h.ctx); globalThis.fetch = original; }
});
