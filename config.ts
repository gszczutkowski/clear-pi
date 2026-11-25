import { readFileSync } from "node:fs";
import { stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";

export interface FrameOptions { enabled: boolean; title: string; color: string }
type FrameKind = "userPrompt" | "agentActivity" | "agentAnswer" | "subagentMessage";
const frames: Record<FrameKind, FrameOptions> = {
  userPrompt: { enabled: true, title: "User prompt", color: "#595959" },
  agentActivity: { enabled: true, title: "Agent activity", color: "#4DA3FF" },
  agentAnswer: { enabled: true, title: "Agent answer", color: "#2F9E5D" },
  subagentMessage: { enabled: true, title: "Message from {sender}", color: "#D69E2E" },
};
export type TranscriptNotices = Record<"skill" | "help", FrameOptions>;
export const defaultTranscriptNotices: TranscriptNotices = {
  skill: { enabled: true, title: "Skill invoked", color: "#FF9F43" },
  help: { enabled: true, title: "Needs help", color: "#FF9F43" },
};

export interface FooterField { enabled: boolean; icon: string }
export const defaultFooter = {
  cwd: { enabled: true, icon: "\uF07C" },
  gitBranch: { enabled: true, icon: "\uEC6F" },
  model: { enabled: true, icon: "\uE28C" },
  thinking: { enabled: true, icon: "\uEC59" },
  sent: { enabled: true, icon: "\u{F0552}" },
  received: { enabled: true, icon: "\u{F01DA}" },
  context: { enabled: true, icon: "\u{F0238}" },
  codexQuota: { enabled: true, icon: "\u{F0450}" },
  extensionStatuses: { enabled: true, icon: "\uF05A" },
} satisfies Record<string, FooterField>;
export type FooterOptions = Record<keyof typeof defaultFooter, FooterField>;
export const defaultProgress = { enabled: true, maxTasks: 12, maxRuns: 20 };
export type ProgressOptions = typeof defaultProgress;
export const defaultTranscriptIcons = { activity: "\uF449", expanded: "▾", collapsed: "▸" };
export type TranscriptIcons = typeof defaultTranscriptIcons;
export const defaultStatusIcons = {
  pending: "󰋼", in_progress: "󰋼", in_review: "󰋼", accepted: "󰄬", failed: "󰅖",
  blocked: "󰂭", skipped: "󰋼", cancelled: "󰋼", completed: "󰄬", help_requested: "󰂭",
  saved: "󰋼", assigned: "󰋼", unknown: "󰋼", complete: "󰄬", partial: "󰀪", changes_required: "󰀦",
};
export type StatusIcon = keyof typeof defaultStatusIcons;
export interface RoleIcons { normal: string; problem: string }
const defaultRoleIcons = {
  worker: { normal: "󰢻", problem: "󱏏" }, tester: { normal: "󰂕", problem: "󱏵" },
  reviewer: { normal: "󰛐", problem: "󰛑" }, documenter: { normal: "󰨸", problem: "󱘡" },
  scout: { normal: "󰆌", problem: "󰮁" }, architect: { normal: "󰺾", problem: "󱕛" },
  coordinator: { normal: "󱙺", problem: "󱙻" }, other: { normal: "󱙺", problem: "󱙻" },
} satisfies Record<string, RoleIcons>;
export interface ProgressIcons {
  main: string; agents: string; info: string; runtime: string; checked: string; unchecked: string;
  model: string; thinking: string;
  status: Record<StatusIcon, string>;
  roles: Readonly<Record<string, RoleIcons>>;
}
export const defaultProgressIcons = {
  main: "󰙅", agents: "󱙺", info: "󰋼", runtime: "\u{F17A9}", checked: "\u{F0C52}", unchecked: "\u{F0131}",
  model: defaultFooter.model.icon, thinking: defaultFooter.thinking.icon,
  status: defaultStatusIcons, roles: defaultRoleIcons,
} satisfies ProgressIcons;
export interface Settings {
  frames: typeof frames; footer: FooterOptions; progress: ProgressOptions;
  progressIcons: ProgressIcons; transcriptIcons: TranscriptIcons; transcriptNotices: TranscriptNotices;
}

const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
export const safeTitle = (text: string) => stripTerminalSequences(text)
  .replace(/[\x00-\x1f\x7f-\x9f\u2028-\u202e\u2066-\u2069]/g, " ").trim().slice(0, 240).toWellFormed();

const icon = (value: unknown, fallback: string, width?: number, allowEmpty = true): string => {
  if (typeof value !== "string" || value.length > 24 || !value.isWellFormed()
    || /[\x00-\x1f\x7f-\x9f\u2028-\u202e\u2066-\u2069]/.test(value)) return fallback;
  const trimmed = value.trim();
  if (!trimmed) return allowEmpty ? "" : fallback;
  const columns = visibleWidth(trimmed);
  return columns > 0 && (width === undefined || columns === width) ? trimmed : fallback;
};

export function normalizeRoleKey(role: string): string {
  return role.trim().toLowerCase().replace(/[ _]+/g, "-");
}

function parseProgressIcons(value: unknown, footer: FooterOptions): ProgressIcons {
  const input = record(value);
  const defaults = defaultProgressIcons;
  const statusInput = record(input.status);
  const status = { ...defaultStatusIcons };
  for (const key of Object.keys(status) as StatusIcon[]) status[key] = icon(statusInput[key], status[key], 1);
  const roles: Record<string, RoleIcons> = { ...defaultRoleIcons };
  // Keep custom role configuration bounded; unknown roles use `other`.
  for (const [raw, value] of Object.entries(record(input.roles)).slice(0, 100)) {
    const key = normalizeRoleKey(raw);
    if (!/^[a-z0-9][a-z0-9-]{0,59}$/.test(key)) continue;
    const fallback = Object.hasOwn(roles, key) ? roles[key] : defaultRoleIcons.other;
    const field = record(value);
    roles[key] = { normal: icon(field.normal, fallback.normal, 1), problem: icon(field.problem, fallback.problem, 1) };
  }
  return {
    main: icon(input.main, defaults.main, 1), agents: icon(input.agents, defaults.agents, 1),
    info: icon(input.info, defaults.info, 1), runtime: icon(input.runtime, defaults.runtime, 1),
    checked: icon(input.checked, defaults.checked, 1), unchecked: icon(input.unchecked, defaults.unchecked, 1),
    model: footer.model.icon, thinking: footer.thinking.icon, status, roles,
  };
}

export function parseSettings(value: unknown): Settings {
  const input = record(value);
  const footer: FooterOptions = { ...defaultFooter };
  const frameInput = record(input.frames);
  const footerInput = record(input.footer);
  for (const key of Object.keys(footer) as (keyof FooterOptions)[]) {
    const input = footerInput[key];
    const field = record(input);
    const defaults = defaultFooter[key];
    footer[key] = {
      enabled: typeof input === "boolean" ? input : typeof field.enabled === "boolean" ? field.enabled : defaults.enabled,
      icon: icon(field.icon, defaults.icon),
    };
  }
  const parseFrames = <K extends string>(source: Record<string, unknown>, defaults: Record<K, FrameOptions>) => {
    const result = { ...defaults };
    for (const key of Object.keys(defaults) as K[]) {
      const { enabled, title, color } = record(source[key]);
      result[key] = {
        enabled: typeof enabled === "boolean" ? enabled : defaults[key].enabled,
        title: typeof title === "string" ? safeTitle(title) || defaults[key].title : defaults[key].title,
        color: typeof color === "string" && /^#[\da-f]{6}$/i.test(color) ? color : defaults[key].color,
      };
    }
    return result;
  };
  const result = parseFrames(frameInput, frames);
  const progress = { ...defaultProgress };
  const progressInput = record(input.progress);
  if (typeof progressInput.enabled === "boolean") progress.enabled = progressInput.enabled;
  for (const key of ["maxTasks", "maxRuns"] as const) {
    const value = progressInput[key];
    if (typeof value === "number" && Number.isInteger(value) && value >= 1 && value <= 100) progress[key] = value;
  }
  const transcript = record(input.transcriptIcons);
  const transcriptIcons = {
    activity: icon(transcript.activity, defaultTranscriptIcons.activity, 1),
    expanded: icon(transcript.expanded, defaultTranscriptIcons.expanded, 1, false),
    collapsed: icon(transcript.collapsed, defaultTranscriptIcons.collapsed, 1, false),
  };
  return { frames: result, footer, progress, transcriptIcons, progressIcons: parseProgressIcons(progressInput.icons, footer),
    transcriptNotices: parseFrames(record(input.transcriptNotices), defaultTranscriptNotices) };
}

function unknownSettings(input: Record<string, unknown>): string | undefined {
  const examples: string[] = [];
  let count = 0;
  const check = (value: unknown, keys: readonly string[], prefix = "") => {
    const known = new Set(keys);
    for (const key of Object.keys(record(value))) if (!known.has(key)) {
      count++;
      if (examples.length < 4) examples.push(prefix + (safeTitle(key).slice(0, 60).toWellFormed() || "(empty key)"));
    }
  };
  const framesAt = (value: unknown, defaults: object, prefix: string) => {
    const keys = Object.keys(defaults);
    check(value, keys, prefix);
    for (const key of keys) check(record(value)[key], ["enabled", "title", "color"], `${prefix}${key}.`);
  };
  check(input, ["frames", "footer", "progress", "transcriptIcons", "transcriptNotices"]);
  framesAt(input.frames, frames, "frames.");
  framesAt(input.transcriptNotices, defaultTranscriptNotices, "transcriptNotices.");
  check(input.transcriptIcons, Object.keys(defaultTranscriptIcons), "transcriptIcons.");
  const footer = record(input.footer);
  check(footer, Object.keys(defaultFooter), "footer.");
  for (const key of Object.keys(defaultFooter)) check(footer[key], ["enabled", "icon"], `footer.${key}.`);
  const progress = record(input.progress);
  check(progress, [...Object.keys(defaultProgress), "icons", "details"], "progress."); // Legacy details is intentionally ignored.
  const icons = record(progress.icons);
  check(icons, Object.keys(defaultProgressIcons).filter(key => key !== "model" && key !== "thinking"), "progress.icons.");
  check(icons.status, Object.keys(defaultStatusIcons), "progress.icons.status.");
  for (const [role, fields] of Object.entries(record(icons.roles)).slice(0, 100)) {
    if (/^[a-z0-9][a-z0-9-]{0,59}$/.test(normalizeRoleKey(role))) check(fields, ["normal", "problem"], `progress.icons.roles.${normalizeRoleKey(role)}.`);
    else { count++; if (examples.length < 4) examples.push("progress.icons.roles.(invalid role)"); }
  }
  return count ? `clear-pi: unknown config keys ignored: ${examples.join(", ")}${count > examples.length ? ` (+${count - examples.length} more)` : ""}` : undefined;
}

export function loadSettings(url = new URL("./config.json", import.meta.url)): { settings: Settings; warning?: string } {
  try {
    const value = JSON.parse(readFileSync(url, "utf8").replace(/^\uFEFF/, ""));
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("expected object");
    return { settings: parseSettings(value), warning: unknownSettings(value) };
  } catch (error) {
    const missing = (error as NodeJS.ErrnoException).code === "ENOENT";
    return { settings: parseSettings(undefined), warning: missing ? undefined : "clear-pi: cannot load config.json; using defaults" };
  }
}
