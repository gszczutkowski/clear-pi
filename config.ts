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
export const defaultFooter = {
  cwd: true, gitBranch: true, model: true, thinking: true, sent: true,
  received: true, context: true, codexQuota: true, extensionStatuses: true,
};
export type FooterOptions = typeof defaultFooter;
export interface Settings { frames: typeof frames; footer: FooterOptions }

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
    const enabled = footerInput[key];
    if (typeof enabled === "boolean") footer[key] = enabled;
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
  return { frames: result, footer };
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
