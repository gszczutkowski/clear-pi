import { mkdir, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { progressIcons, renderProgress, type ProgressView } from "./progress-view.ts";

const escapeHtml = (text: string) => text.replace(/[&<>"']/g, char => ({
  "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
})[char]!);

/** Same bounded detailed projection as expand, without viewport clipping.
 * Standard Unicode checkbox fallbacks keep the file independent of Nerd Fonts. */
export function renderProgressHtml(view: ProgressView, options: { maxTasks?: number; maxRuns?: number } = {}): string {
  const report = renderProgress(view, 140, { ...options, details: true }).join("\n")
    .replaceAll(progressIcons.unchecked, "☐").replaceAll(progressIcons.checked, "☑");
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'">
<title>Main Agent — progress report</title>
<style>
:root { color-scheme: light dark; }
body { margin: 0; padding: 24px; font-family: system-ui, sans-serif; }
pre { margin: 0; padding: 20px; overflow-x: auto; border: 1px solid #80808060; border-radius: 8px;
font-family: "Cascadia Mono", "DejaVu Sans Mono", Consolas, monospace; font-size: 13px; line-height: 1.5; white-space: pre; }
</style>
</head>
<body><pre>${escapeHtml(report)}</pre></body>
</html>
`;
}

/** Explicit local export only; unique filenames never overwrite another report. */
type ExportOptions = { maxTasks?: number; maxRuns?: number };
export function saveProgressExport(view: ProgressView, directory: string, options?: ExportOptions): Promise<string>;
export function saveProgressExport(view: ProgressView, directory: string, options: ExportOptions, current: () => boolean): Promise<string | undefined>;
export async function saveProgressExport(view: ProgressView, directory: string,
  options: ExportOptions = {}, current = () => true): Promise<string | undefined> {
  const html = renderProgressHtml(view, options);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  if (!current()) return undefined;
  const file = join(directory, `progress-${randomUUID()}.html`);
  await writeFile(file, html, { encoding: "utf8", flag: "wx", mode: 0o600 });
  return file;
}
