import { readFileSync } from "node:fs";
import { stripTerminalSequences } from "@earendil-works/pi-tui";

export interface FrameOptions { enabled: boolean; title: string; color: string }
type FrameKind = "userPrompt" | "agentActivity" | "agentAnswer" | "subagentMessage";
const frames: Record<FrameKind, FrameOptions> = {
  userPrompt: { enabled: true, title: "User prompt", color: "#595959" },
  agentActivity: { enabled: true, title: "Agent activity", color: "#4DA3FF" },
  agentAnswer: { enabled: true, title: "Agent answer", color: "#2F9E5D" },
  subagentMessage: { enabled: true, title: "Message from {sender}", color: "#D69E2E" },
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
export const defaultProgress = { enabled: true, details: false, maxTasks: 12, maxRuns: 20 };
export type ProgressOptions = typeof defaultProgress;
export interface Settings { frames: typeof frames; footer: FooterOptions; progress: ProgressOptions }

const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
export const safeTitle = (text: string) => stripTerminalSequences(text)
  .replace(/[\x00-\x1f\x7f-\x9f]/g, " ").trim().slice(0, 240);

export function parseSettings(value: unknown): Settings {
  const input = record(value);
  const footer = { ...defaultFooter };
  const frameInput = record(input.frames);
  const footerInput = record(input.footer);
  for (const key of Object.keys(footer) as (keyof FooterOptions)[]) {
    const input = footerInput[key];
    const { enabled, icon } = record(input);
    const defaults = defaultFooter[key];
    const safeIcon = typeof icon === "string" && icon.length <= 24 && icon.isWellFormed()
      && !/[\x00-\x1f\x7f-\x9f\u2028-\u202e\u2066-\u2069]/.test(icon);
    footer[key] = {
      enabled: typeof input === "boolean" ? input : typeof enabled === "boolean" ? enabled : defaults.enabled,
      icon: safeIcon ? icon.trim() : defaults.icon,
    };
  }
  const result = { ...frames };
  for (const key of Object.keys(frames) as (keyof typeof frames)[]) {
    const { enabled, title, color } = record(frameInput[key]);
    result[key] = {
      enabled: typeof enabled === "boolean" ? enabled : frames[key].enabled,
      title: typeof title === "string" ? safeTitle(title) || frames[key].title : frames[key].title,
      color: typeof color === "string" && /^#[\da-f]{6}$/i.test(color) ? color : frames[key].color,
    };
  }
  const progress = { ...defaultProgress };
  const progressInput = record(input.progress);
  for (const key of ["enabled", "details"] as const) {
    if (typeof progressInput[key] === "boolean") progress[key] = progressInput[key];
  }
  for (const key of ["maxTasks", "maxRuns"] as const) {
    const value = progressInput[key];
    if (typeof value === "number" && Number.isInteger(value) && value >= 1 && value <= 100) progress[key] = value;
  }
  return { frames: result, footer, progress };
}

export function loadSettings(url = new URL("./config.json", import.meta.url)): { settings: Settings; warning?: string } {
  try {
    const value = JSON.parse(readFileSync(url, "utf8").replace(/^\uFEFF/, ""));
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("expected object");
    return { settings: parseSettings(value) };
  } catch (error) {
    const missing = (error as NodeJS.ErrnoException).code === "ENOENT";
    return { settings: parseSettings(undefined), warning: missing ? undefined : "clear-pi: cannot load config.json; using defaults" };
  }
}
