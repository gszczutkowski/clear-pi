import type { ExtensionContext, Theme, ReadonlyFooterDataProvider } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { CACHE_MS, duration, type UsageClient } from "./usage.ts";
import { stripVTControlCharacters } from "node:util";
import { defaultFooter, type FooterOptions } from "./config.ts";

export const colors = { orange: "255;165;0", red: "255;80;80", green: "80;200;120", blue: "100;190;255" };
const paint = (color: string, text: string) => `\x1b[38;2;${color}m${text}\x1b[39m`;

export const icons = {
  git: "\uEC6F", model: "\uE28C", thinking: "\uEC59", sent: "\u{F0552}",
  received: "\u{F01DA}", context: "\u{F0238}", reset: "\u{F0450}",
};
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

export function quotaText(client: UsageClient | undefined, now: number, barWidth = 8, compact = false, colored = false): string {
  const snapshot = client?.snapshot;
  if (!snapshot) return `Codex ${client ? client.failure ?? "loading" : "unsupported provider"}`;
  const windows = snapshot.windows.map((window, index) => {
    const label = window.seconds ? duration(window.seconds * 1000) : index === 0 ? "primary" : "secondary";
    const remaining = 100 - window.used;
    const filled = Math.round(remaining / 100 * barWidth);
    const rawBar = `[${"▰".repeat(filled)}${"▱".repeat(barWidth - filled)}]`;
    const bar = colored ? paint(remaining < 10 ? colors.red : remaining <= 40 ? colors.orange : colors.green, rawBar) : rawBar;
    const reset = window.resetAt === undefined ? "?" : window.resetAt <= now ? "due" : duration(window.resetAt - now);
    return compact ? `${label}${bar}${Math.round(remaining)}% • ${icons.reset}${reset}`
      : `${label} ${bar} ${Math.round(remaining)}% • ${icons.reset} ${reset}`;
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
  const branch = options.gitBranch ? data.getGitBranch() : undefined;
  if (options.cwd) {
    const suffix = branch ? ` (${icons.git} ${clean(branch)})` : "";
    // Preserve Windows drive/UNC paths, even if Pi supplied forward slashes.
    const cwd = clean(ctx.cwd).replace(/^([a-z]):\//i, "$1:\\");
    const path = /^[a-z]:[\\/]|^\\\\/i.test(cwd) ? cwd.replaceAll("/", "\\") : cwd;
    lines.push(fit(visibleWidth(path + suffix) <= width ? path + suffix
      : truncateToWidth(path, Math.max(0, width - visibleWidth(suffix)), "…") + suffix));
  } else if (branch) lines.push(fit(`${icons.git} ${clean(branch)}`));
  const tokens = options.sent || options.received ? branchTokens(ctx) : undefined;
  const percent = options.context ? ctx.getContextUsage()?.percent : undefined;
  const utilization = percent == null || !Number.isFinite(percent) ? "?%" : `${percent.toFixed(1)}%`;
  const model = clean(ctx.model?.id ?? "no-model");
  const level = ctx.thinkingLevel ?? "off";
  const thinkingText = `${icons.thinking} ${level}`;
  const thinking = ["off", "minimal", "low"].includes(level)
    ? paint(colors.blue, thinkingText)
    : ["high", "xhigh", "max"].includes(level) ? paint(colors.red, thinkingText) : thinkingText;
  const contextText = `${icons.context} ${utilization}`;
  const contextMetric = percent != null && Number.isFinite(percent) && percent >= 80 ? paint(colors.red, contextText)
    : percent != null && Number.isFinite(percent) && percent > 50 ? paint(colors.orange, contextText) : contextText;
  const metrics = [options.thinking && thinking, options.sent && `${icons.sent} ${fmt(tokens!.sent)}`,
    options.received && `${icons.received} ${fmt(tokens!.received)}`, options.context && contextMetric];
  const details = (stage: number) => [
    options.model && `${icons.model}${stage === 2 ? "" : " "}${stage === 0 ? model : truncateToWidth(model, stage === 1 ? 18 : 12, "…")}`,
    ...metrics, options.codexQuota && quotaText(client, now, stage === 0 ? 8 : 3, stage === 2, true),
  ].filter(Boolean).join(stage === 2 ? "•" : " • ");
  let second = details(0);
  if (visibleWidth(second) > width) second = details(1);
  if (visibleWidth(second) > width) second = details(2);
  if (second) lines.push(fit(second));
  if (options.extensionStatuses) {
    const statuses = [...data.getExtensionStatuses()].filter(([key, text]) => key !== "clear-pi" && text.trim())
      .sort(([a], [b]) => a.localeCompare(b)).map(([, text]) => text.replace(/[\r\n\t]/g, " ")).join(" · ");
    if (statuses) lines.push(fit(stripVTControlCharacters(statuses)));
  }
  return lines;
}
