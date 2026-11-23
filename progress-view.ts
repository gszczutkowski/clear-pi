import { stripTerminalSequences, truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { frameWidth } from "./frame-layout.ts";

export const progressIcons = { unchecked: "\u{F0131}", checked: "\u{F0C52}" };

export interface ProgressView { title: string | null; tasks: ProgressTask[]; unassigned: ProgressRun[]; notice?: string }
export interface ProgressTask { id: string; title: string; status: string; runs: ProgressRun[] }
export interface ProgressRun {
  id: string; name: string; role: string; task: string; status: string;
  model?: string; thinking?: string; summary?: string; children: ProgressRun[]; notice?: string;
}

// These safety bounds are independent of the user's display limits.
const MAX_DEPTH = 24;
const MAX_SCAN = 2000;
const clean = (value: string | undefined) => stripTerminalSequences(value ?? "")
  .replace(/[\x00-\x1f\x7f-\x9f\u2028\u2029\u202a-\u202e\u2066-\u2069]/g, " ").trim();
const short = (value: string | undefined, width = 240) => truncateToWidth(clean(value), width, "…");
const limit = (value: number | undefined, fallback: number, ceiling: number) =>
  value === undefined || !Number.isFinite(value) ? fallback : Math.max(0, Math.min(ceiling, Math.floor(value)));
// The wrapping helper may append an ANSI reset even to unstyled content.
const fit = (text: string, width: number) => stripTerminalSequences(truncateToWidth(text, width, ""));
const text = (value: string, width: number): string[] => width < 1 ? [] :
  wrapTextWithAnsi(value, width).map(line => fit(line, width));

function box(title: string, body: string[], width: number): string[] {
  if (width < 12) return [...text(title, width), ...body.map(line => fit(line, width))];
  const label = fit(`─ ${title} `, width - 2);
  return [
    `╭${label}${"─".repeat(width - 2 - visibleWidth(label))}╮`,
    ...body.map(line => {
      const clipped = fit(line, width - 4);
      return `│ ${clipped}${" ".repeat(width - 4 - visibleWidth(clipped))} │`;
    }),
    `╰${"─".repeat(width - 2)}╯`,
  ];
}
const inside = (width: number) => width >= 12 ? width - 4 : width;
const taskLabel = (task: ProgressTask, index: number) => /^T\d+$/.test(task.id) ? task.id : `T${index + 1}`;
const checkbox = (checked: boolean) => checked ? progressIcons.checked : progressIcons.unchecked;
const planHeading = (title: ProgressView["title"]) => title === null ? "No active plan" : `Plan: ${short(title) || "Untitled"}`;

function operationStatus(status: string) {
  switch (status.trim().toUpperCase()) {
    case "RESULT REPORTED": return "completed";
    case "FAILURE REPORTED": return "failed";
    case "HELP REQUESTED": return "help requested";
    case "SAVED": return "saved";
    case "ASSIGNED": return "assigned";
    default: return "unknown";
  }
}
type OperationStatus = ReturnType<typeof operationStatus>;
const operationIcons: Record<OperationStatus, string> = {
  completed: "✓", failed: "×", "help requested": "?", saved: "·", assigned: "·", unknown: "·",
};

function compactPanel(view: ProgressView, width: number, maxTasks: number, maxRuns: number): string[] {
  const inner = inside(width);
  const line = (value: string) => stripTerminalSequences(truncateToWidth(value, inner, "…"));
  const slots = width >= 12 ? 8 : 9; // Ten widget lines including the frame or narrow title.
  const standalone = view.title === null;
  const singleOperation = standalone && view.unassigned.length === 1 && !view.unassigned[0].children.length;
  let remaining = maxRuns;
  let hiddenRuns = false;

  function* runs(items: ProgressRun[], depth: number, seen: Set<ProgressRun>): Generator<string[]> {
    if (items.length && depth > MAX_DEPTH) { yield ["… run tree truncated"]; return; }
    const indent = " ".repeat(Math.min(3 * depth, Math.floor(inner / 3)));
    const runtimeIndent = " ".repeat(Math.min(3 * depth + 3, Math.floor(inner / 2)));
    for (const run of items) {
      if (!remaining) { hiddenRuns = true; return; }
      if (seen.has(run)) { yield [`${indent}… repeated run omitted`]; continue; }
      seen.add(run);
      remaining--;
      const role = short(run.role, 40) || "run";
      const name = short(run.name, 120);
      // History-only descendants may carry the run ID in place of a display name.
      const label = (name && run.name !== run.id ? name : short(run.task, 120)) || name || role;
      const model = short(run.model, 100);
      const thinking = short(run.thinking, 40);
      if (standalone) {
        const status = operationStatus(run.status);
        const icon = operationIcons[status];
        if (singleOperation) {
          const modelName = model.replace(/^[^/]+\/(?=.)/, "");
          const metadata = [role, modelName, thinking].filter(Boolean).join("  ·  ");
          yield [` [${icon}] ${label}  ·  ${status}`, `     └─ ${metadata}`];
        } else {
          const metadata = [role, model, thinking].filter(Boolean).join(" · ");
          yield [`${indent}${icon} ${label} · ${status}`, `${runtimeIndent}${metadata}`];
        }
      } else {
        const runtime = [model, thinking].filter(Boolean).join(" | ");
        const reported = run.status === "RESULT REPORTED";
        const status = reported ? "" : ` (${short(run.status, 60) || "unknown"})`;
        const row = `${indent}${checkbox(reported)} ${runtime ? "" : `${role}: `}${label}${status}`;
        // Keep room for a coordinator's worker and reviewer in the bounded widget.
        if (runtime && role === "coordinator" && run.children.length) yield [`${row} · ${role}: ${runtime}`];
        else yield runtime ? [row, `${runtimeIndent}${role}: ${runtime}`] : [row];
      }
      yield* runs(run.children, depth + 1, seen);
    }
  }

  function* groups(): Generator<string[]> {
    yield [singleOperation ? " Plan  ·  None" : planHeading(view.title)];
    if (standalone) {
      if (view.unassigned.length) {
        yield singleOperation ? [""] : ["", operationsHeading(scan(view.unassigned))];
        yield* runs(view.unassigned, 1, new Set());
      }
    } else {
      yield ["Stages:"];
      if (!view.tasks.length) yield ["No tasks"];
      for (const [index, task] of view.tasks.slice(0, maxTasks).entries()) {
        const accepted = task.status === "accepted";
        const status = accepted ? "" : ` (${short(task.status, 60) || "unknown"})`;
        yield [`${checkbox(accepted)} ${taskLabel(task, index)} ${short(task.title)}${status}`];
        yield* runs(task.runs, 1, new Set());
      }
      if (view.tasks.length > maxTasks) yield [`… ${view.tasks.length - maxTasks} tasks hidden (maxTasks)`];
      if (view.unassigned.length && remaining) {
        yield ["Unassigned runs:"];
        yield* runs(view.unassigned, 1, new Set());
      } else if (view.unassigned.length) hiddenRuns = true;
    }
    if (hiddenRuns) yield ["… runs hidden (maxRuns)"];
  }

  const body: string[] = [];
  let previousSize = 0;
  for (const rows of groups()) {
    if (body.length + rows.length > slots) {
      // If needed, drop the previous group whole so metadata is never orphaned.
      if (body.length === slots) body.length -= previousSize;
      body.push(line("… more in full view"));
      break;
    }
    body.push(...rows.map(line));
    previousSize = rows.length;
  }
  return width < 12 ? [line("Main Agent"), ...body] : box("Main Agent", body, width);
}

interface RunNode { run: ProgressRun; children: RunNode[] }
interface RunTree {
  nodes: RunNode[]; roles: Map<string, number>; statuses: Map<OperationStatus, number>;
  count: number; latest?: string; truncated: boolean;
}

/** Snapshot each distinct run once; cycles/shared object references are not extra runs. */
function scan(runs: ProgressRun[]): RunTree {
  const tree: RunTree = { nodes: [], roles: new Map(), statuses: new Map(), count: 0, truncated: false };
  const seen = new Set<ProgressRun>();
  const visit = (items: ProgressRun[], depth: number): RunNode[] => {
    const nodes: RunNode[] = [];
    for (const run of items) {
      if (depth >= MAX_DEPTH || tree.count >= MAX_SCAN) { tree.truncated = true; break; }
      if (seen.has(run)) { tree.truncated = true; continue; }
      seen.add(run);
      tree.count++;
      const role = short(run.role, 40) || "unknown";
      tree.roles.set(role, (tree.roles.get(role) ?? 0) + 1);
      const status = operationStatus(run.status);
      tree.statuses.set(status, (tree.statuses.get(status) ?? 0) + 1);
      if (clean(run.summary)) tree.latest = short(run.summary);
      nodes.push({ run, children: visit(run.children, depth + 1) });
    }
    return nodes;
  };
  tree.nodes = visit(runs, 0);
  return tree;
}
const counts = (tree: RunTree) => `Runs: ${tree.count}${tree.truncated ? "+" : ""}` +
  (tree.roles.size ? ` (${[...tree.roles].map(([role, count]) => `${role}: ${count}`).join(", ")})` : "");
const operationsHeading = (tree: RunTree) => tree.truncated ? `Operations · ${tree.count}+ observed` :
  tree.count < 2 ? "Operations" : `Operations · ${[...tree.statuses].map(([status, count]) => `${count} ${status}`).join(", ")}`;

/** Pure display: run completion/results never confer task acceptance. */
export function renderProgress(
  view: ProgressView, width: number,
  options: { details?: boolean; maxTasks?: number; maxRuns?: number; compact?: boolean } = {},
): string[] {
  width = frameWidth(width);
  if (!width) return [];
  const maxTasks = limit(options.maxTasks, 12, 100);
  let remaining = limit(options.maxRuns, 20, 200);
  if (options.compact) return compactPanel(view, width, maxTasks, remaining);
  let hiddenRuns = false;
  const inner = inside(width);
  const standalone = view.title === null;
  const body = text(planHeading(view.title), inner);
  const tasks = standalone ? [] : view.tasks.slice(0, maxTasks);
  for (const [index, task] of tasks.entries()) {
    body.push(...text(`${checkbox(task.status === "accepted")} ${taskLabel(task, index)} ${short(task.title)} (${short(task.status, 60)})`, inner));
  }
  if (!standalone && !view.tasks.length) body.push(...text("No tasks", inner));
  if (!standalone && tasks.length < view.tasks.length) body.push(...text(`… ${view.tasks.length - tasks.length} tasks hidden (maxTasks)`, inner));
  if (view.notice) body.push(...text(`Notice: ${short(view.notice)}`, inner));

  const renderNodes = (nodes: RunNode[], available: number): string[] => {
    const lines: string[] = [];
    for (const node of nodes) {
      if (!remaining) { hiddenRuns = true; break; }
      remaining--;
      const run = node.run;
      const contentWidth = inside(available);
      const content = text(`Task: ${short(run.task) || "—"}`, contentWidth);
      const status = standalone ? operationStatus(run.status) : short(run.status, 60) || "unknown";
      content.push(...text(`Status: ${status}`, contentWidth));
      if (run.summary) content.push(...text(`Result: ${short(run.summary)}`, contentWidth));
      if (run.model || run.thinking) content.push(...text(`${short(run.model, 100) || "model unknown"} | ${short(run.thinking, 40) || "thinking unknown"}`, contentWidth));
      if (run.notice) content.push(...text(`Notice: ${short(run.notice)}`, contentWidth));
      content.push(...renderNodes(node.children, contentWidth));
      lines.push(...box(`${short(run.role, 40) || "run"}: ${short(run.name, 80) || short(run.id, 60)}`, content, available));
    }
    return lines;
  };
  const group = (title: string | undefined, runs: ProgressRun[], status?: string) => {
    const tree = scan(runs);
    title ??= operationsHeading(tree);
    const available = options.details ? inside(inner) : inner;
    const lines = text(counts(tree), available);
    if (status !== undefined && options.details) lines.unshift(...text(`Status: ${short(status, 60)}`, available));
    // Prefer a coordinator's report; tree traversal cannot establish chronology.
    const feedback = runs.findLast(run => clean(run.summary))?.summary ?? tree.latest;
    if (feedback) lines.push(...text(`Reported feedback (not acceptance): ${short(feedback)}`, available));
    if (tree.truncated) lines.push(...text("… run scan truncated (cycle/depth/safety limit)", available));
    if (options.details) {
      lines.push(...renderNodes(tree.nodes, available));
      body.push(...box(title, lines, inner));
    } else {
      body.push(...text(title, inner), ...lines);
    }
  };
  for (const [index, task] of tasks.entries()) group(`Task ${taskLabel(task, index)}: ${short(task.title)}`, task.runs, task.status);
  if (view.unassigned.length) group(standalone ? undefined : "Unassigned runs", view.unassigned);
  if (hiddenRuns) body.push(...text("… runs hidden (maxRuns)", inner));
  return box("Main Agent", body, width);
}
