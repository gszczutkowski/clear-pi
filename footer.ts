import type { ExtensionContext, Theme, ReadonlyFooterDataProvider } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { CACHE_MS, duration, type UsageClient } from "./usage.ts";
import { stripVTControlCharacters } from "node:util";
import { defaultFooter, type FooterOptions } from "./config.ts";

export const colors = { orange: "255;165;0", red: "255;80;80", green: "80;200;120", blue: "100;190;255" };
const paint = (color: string, text: string) => `\x1b[38;2;${color}m${text}\x1b[39m`;

export const icons = {
  git: defaultFooter.gitBranch.icon, model: defaultFooter.model.icon, thinking: defaultFooter.thinking.icon,
  sent: defaultFooter.sent.icon, received: defaultFooter.received.icon, context: defaultFooter.context.icon,
  reset: defaultFooter.codexQuota.icon, cwd: defaultFooter.cwd.icon, statuses: defaultFooter.extensionStatuses.icon,
};
const withIcon = (icon: string, text: string, compact = false) => icon ? `${icon}${compact ? "" : " "}${text}` : text;
const clean = (text: string) => text.replace(/[\x00-\x1f\x7f-\x9f]/g, " ");
const count = (value: number | undefined) => typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0;
const fmt = (n: number) => n < 1000 ? `${n}` : n < 1_000_000 ? `${(n / 1000).toFixed(1)}k` : `${(n / 1_000_000).toFixed(1)}m`;

// Like Pi's footer, include separately recorded nested-tool and summary usage,
// but only on the active branch. totalTokens is deliberately never added.
export function branchTokens(ctx: ExtensionContext): { sent: number; received: number } {
  let sent = 0, received = 0;
  for (const entry of ctx.sessionManager.getBranch()) {
    const usage = entry.type === "message"
      ? (entry.message.role === "assistant" || entry.message.role === "toolResult" ? entry.message.usage : undefined)
      : entry.type === "usage" || entry.type === "compaction" || entry.type === "branch_summary" ? entry.usage : undefined;
    if (!usage) continue;
    sent += count(usage.input) + count(usage.cacheRead) + count(usage.cacheWrite);
    received += count(usage.output);
  }
  return { sent, received };
}

type FooterStats = {
  sessionId: string;
  leafId: string | null;
  entryCount: number;
  model: ExtensionContext["model"];
  contextWindow: number | undefined;
  tokens?: ReturnType<typeof branchTokens>;
  context?: { percent: number | null | undefined };
};
const statsCache = new WeakMap<ExtensionContext["sessionManager"], FooterStats>();

function footerStats(ctx: ExtensionContext, options: FooterOptions) {
  const showTokens = options.sent.enabled || options.received.enabled;
  const showContext = options.context.enabled;
  if (!showTokens && !showContext) return {};
  // Pi 1.6's runtime exposes the same O(1) count used by the native footer,
  // although it isn't in the extension's read-only type. Never copy all entries to get it.
  const session = ctx.sessionManager as ExtensionContext["sessionManager"] & { getEntryCount?: () => number };
  const entryCount = session.getEntryCount?.();
  if (entryCount === undefined) return {
    tokens: showTokens ? branchTokens(ctx) : undefined,
    percent: showContext ? ctx.getContextUsage()?.percent : undefined,
  };
  const sessionId = session.getSessionId();
  const leafId = session.getLeafId();
  const model = ctx.model;
  const contextWindow = model?.contextWindow;
  let stats = statsCache.get(session);
  if (!stats || stats.sessionId !== sessionId || stats.leafId !== leafId || stats.entryCount !== entryCount
    || stats.model !== model || stats.contextWindow !== contextWindow) {
    stats = { sessionId, leafId, entryCount, model, contextWindow };
    statsCache.set(session, stats);
  }
  if (showTokens) stats.tokens ??= branchTokens(ctx);
  // Pi uses the physical routed model's limit, which ExtensionContext does not expose.
  const percent = !showContext ? undefined : model?.api === "pi-virtual" ? ctx.getContextUsage()?.percent
    : (stats.context ??= { percent: ctx.getContextUsage()?.percent }).percent;
  return { tokens: stats.tokens, percent };
}

export function quotaText(client: UsageClient | undefined, now: number, barWidth = 8, compact = false, colored = false,
  icon = defaultFooter.codexQuota.icon): string {
  const snapshot = client?.snapshot;
  if (!snapshot) return `Codex ${client ? client.failure ?? "loading" : "unsupported provider"}`;
  const windows = snapshot.windows.map((window) => {
    const label = window.seconds ? duration(window.seconds * 1000) : window.kind;
    const remaining = 100 - window.used;
    const filled = Math.round(remaining / 100 * barWidth);
    const rawBar = `[${"▰".repeat(filled)}${"▱".repeat(barWidth - filled)}]`;
    const bar = colored ? paint(remaining < 10 ? colors.red : remaining <= 40 ? colors.orange : colors.green, rawBar) : rawBar;
    const reset = window.resetAt === undefined ? "?" : window.resetAt <= now ? "due" : duration(window.resetAt - now);
    const countdown = withIcon(icon, reset, compact);
    return compact ? `${label}${bar}${Math.round(remaining)}% • ${countdown}`
      : `${label} ${bar} ${Math.round(remaining)}% • ${countdown}`;
  }).join(" · ");
  const stale = client.failure || now - snapshot.at >= CACHE_MS || snapshot.windows.some(w => w.resetAt !== undefined && w.resetAt <= now);
  return `Codex ${windows}${snapshot.blocked ? " · limited" : ""}${stale ? ` · stale${client.failure ? ` (${client.failure})` : ""}` : ""}`;
}

export function renderFooter(ctx: ExtensionContext, theme: Theme, data: ReadonlyFooterDataProvider,
  client: UsageClient | undefined, width: number, now = Date.now(), options: FooterOptions = defaultFooter): string[] {
  width = Math.max(0, Math.floor(width));
  if (width === 0) return [];
  const fit = (text: string) => truncateToWidth(text, width, "…");
  const lines: string[] = [];
  const branch = options.gitBranch.enabled ? data.getGitBranch() : undefined;
  const branchLabel = branch ? withIcon(options.gitBranch.icon, clean(branch)) : "";
  if (options.cwd.enabled) {
    const suffix = branchLabel ? ` (${branchLabel})` : "";
    // Preserve Windows drive/UNC paths, even if Pi supplied forward slashes.
    const cwd = clean(ctx.cwd).replace(/^([a-z]):\//i, "$1:\\");
    const path = withIcon(options.cwd.icon, /^[a-z]:[\\/]|^\\\\/i.test(cwd) ? cwd.replaceAll("/", "\\") : cwd);
    lines.push(fit(visibleWidth(path + suffix) <= width ? path + suffix
      : truncateToWidth(path, Math.max(0, width - visibleWidth(suffix)), "…") + suffix));
  } else if (branchLabel) lines.push(fit(branchLabel));
  const { tokens, percent } = footerStats(ctx, options);
  const utilization = percent == null || !Number.isFinite(percent) ? "?%" : `${percent.toFixed(1)}%`;
  const model = clean(ctx.model?.id ?? "no-model");
  const level = ctx.thinkingLevel ?? "off";
  const thinkingText = withIcon(options.thinking.icon, level);
  const thinking = ["off", "minimal", "low"].includes(level)
    ? paint(colors.blue, thinkingText)
    : ["high", "xhigh", "max"].includes(level) ? paint(colors.red, thinkingText) : thinkingText;
  const contextText = withIcon(options.context.icon, utilization);
  const contextMetric = percent != null && Number.isFinite(percent) && percent >= 80 ? paint(colors.red, contextText)
    : percent != null && Number.isFinite(percent) && percent > 50 ? paint(colors.orange, contextText) : contextText;
  const metrics = [options.thinking.enabled && thinking, options.sent.enabled && withIcon(options.sent.icon, fmt(tokens!.sent)),
    options.received.enabled && withIcon(options.received.icon, fmt(tokens!.received)), options.context.enabled && contextMetric];
  const details = (stage: number) => [
    options.model.enabled && withIcon(options.model.icon, stage === 0 ? model : truncateToWidth(model, stage === 1 ? 18 : 12, "…"), stage === 2),
    ...metrics, options.codexQuota.enabled && quotaText(client, now, stage === 0 ? 8 : 3, stage === 2, true, options.codexQuota.icon),
  ].filter(Boolean).join(stage === 2 ? "•" : " • ");
  let second = details(0);
  if (visibleWidth(second) > width) second = details(1);
  if (visibleWidth(second) > width) second = details(2);
  if (second) lines.push(fit(second));
  if (options.extensionStatuses.enabled) {
    const statuses = [...data.getExtensionStatuses()].filter(([key, text]) => key !== "clear-pi" && text.trim())
      .sort(([a], [b]) => a.localeCompare(b)).map(([, text]) => text.replace(/[\r\n\t]/g, " ")).join(" · ");
    if (statuses) lines.push(fit(withIcon(options.extensionStatuses.icon, stripVTControlCharacters(statuses))));
  }
  return lines;
}
