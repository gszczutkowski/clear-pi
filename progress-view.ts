import { stripTerminalSequences, truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { defaultProgressIcons, normalizeRoleKey, type ProgressIcons, type StatusIcon } from "./config.ts";
import { frameWidth } from "./frame-layout.ts";
import { reportedOutcome } from "./progress-outcome.ts";

export interface ProgressView { title: string | null; tasks: ProgressTask[]; unassigned: ProgressRun[]; notice?: string; incomplete?: boolean }
export interface ProgressTask { id: string; title: string; status: string; runs: ProgressRun[] }
export interface ProgressRun {
  id: string; name: string; role: string; task: string; status: string;
  model?: string; thinking?: string; summary?: string; result?: string; historyExcerpt?: boolean;
  resultStatus?: string; children: ProgressRun[]; notice?: string;
}

const MAX_DEPTH = 24;
const MAX_SCAN = 2000;
const COMPACT_HEIGHT = 10;
const MIN_NESTED_CARD_WIDTH = 48;
const clean = (value: string | undefined) => stripTerminalSequences(value ?? "")
  .replace(/[\x00-\x1f\x7f-\x9f\u2028\u2029\u202a-\u202e\u2066-\u2069]/g, " ").trim();
const limit = (value: number | undefined, fallback: number) =>
  value === undefined || !Number.isFinite(value) ? fallback : Math.max(0, Math.min(100, Math.floor(value)));
const fit = (value: string, width: number, ellipsis = "") => width < 1 ? "" :
  stripTerminalSequences(truncateToWidth(value, width, ellipsis));
const text = (value: string, width: number): string[] => width < 1 ? [] :
  wrapTextWithAnsi(value, width).map(line => fit(line, width));
const inside = (width: number) => width >= 12 ? width - 4 : width;
const prefix = (icon: string, label: string) => icon ? `${icon} ${label}` : label;
const append = (target: string[], source: readonly string[]) => { for (const line of source) target.push(line); };
const taskLabel = (task: ProgressTask, index: number) => /^(?:T\d+|F\d+(?:\.[A-Za-z0-9]+)*)$/.test(task.id) ? task.id : `T${index + 1}`;
const planHeading = (title: ProgressView["title"]) => title === null ? "No active plan" : `Plan: ${fit(clean(title), 240, "…") || "Untitled"}`;

function topBorder(left: string, right: string, width: number): string {
  const space = width - 6;
  const rhs = fit(right, space, "…");
  const lhs = fit(left, Math.max(0, space - visibleWidth(rhs) - (rhs ? 3 : 0)), "…");
  const gap = Math.max(0, space - visibleWidth(lhs) - visibleWidth(rhs));
  const divider = rhs && gap > 2 ? ` ${"─".repeat(gap - 2)} ` :
    !rhs && gap > 0 ? ` ${"─".repeat(gap - 1)}` : " ".repeat(gap);
  return `╭─ ${lhs}${divider}${rhs} ─╮`;
}

function box(title: string, body: string[], width: number, right = ""): string[] {
  if (width < 12) return [...text(title, width), ...(right ? text(right, width) : []), ...body.map(line => fit(line, width))];
  return [topBorder(title, right, width), ...body.map(line => {
    const columns = visibleWidth(line);
    const clipped = columns <= width - 4 ? line : fit(line, width - 4);
    return `│ ${clipped}${" ".repeat(width - 4 - (columns <= width - 4 ? columns : visibleWidth(clipped)))} │`;
  }), `╰${"─".repeat(width - 2)}╯`];
}

function summaryBox(body: string[], width: number, counters: string): string[] {
  return width < 12 ? [fit("Main Agent", width), ...body] : box("Main Agent", body, width, counters);
}

function deliveryStatus(status: string): StatusIcon {
  switch (status.trim().toUpperCase()) {
    case "RESULT REPORTED": return "completed";
    case "FAILURE REPORTED": return "failed";
    case "HELP REQUESTED": return "help_requested";
    case "SAVED": return "saved";
    case "ASSIGNED": return "assigned";
    default: return "unknown";
  }
}
const labelStatus = (status: string) => status.replaceAll("_", " ");
const aliases = new Map(Object.entries({
  "feature-coordinator": "coordinator", implementer: "worker", implementation: "worker",
  test: "tester", "ui-tester": "tester", "visual-tester": "tester", "tester/ui-tester": "tester", review: "reviewer",
}));
const isCoordinator = (role: string) => role === "coordinator" || role === "feature-coordinator";

interface Node {
  run: ProgressRun; children: Node[]; role: string; delivery: StatusIcon;
  end: number; feedback?: string; truncated: boolean;
}
interface Tree { roots: Node[]; ordered: Node[]; truncated: boolean; feedback?: string }
interface Group { task: ProgressTask; index: number; tree: Tree }
export interface PreparedProgress {
  readonly view: ProgressView; readonly mode: "Solo" | "Agents" | "Coordinated";
  readonly tasks: Group[]; readonly unassigned: Tree;
  readonly count: number; readonly roots: number; readonly completedRoots: number; readonly truncated: boolean;
}

/** One bounded DFS for both selection and display. Each snapshot can be laid out at multiple widths. */
export function prepareProgress(view: ProgressView): PreparedProgress {
  const seen = new Set<ProgressRun>();
  let coordinated = false, truncated = false, roots = 0, completedRoots = 0;
  function tree(runs: ProgressRun[]): Tree {
    const result: Tree = { roots: [], ordered: [], truncated: false };
    function visit(items: ProgressRun[], depth: number, into: Node[], parent?: Node) {
      const markTruncated = () => {
        result.truncated = truncated = true;
        if (parent) parent.truncated = true;
      };
      for (const run of items) {
        if (depth >= MAX_DEPTH || seen.size >= MAX_SCAN) { markTruncated(); break; }
        if (seen.has(run)) { markTruncated(); continue; }
        seen.add(run);
        const role = normalizeRoleKey(run.role);
        const delivery = deliveryStatus(run.status);
        const node: Node = { run, role, delivery, children: [], end: 0, truncated: false };
        into.push(node);
        result.ordered.push(node);
        if (depth === 0) { roots++; if (delivery === "completed") completedRoots++; }
        if (isCoordinator(role)) {
          coordinated = true;
          if (run.summary?.trim()) node.feedback = result.feedback = run.summary;
        }
        if (run.children.length) visit(run.children, depth + 1, node.children, node);
        node.end = result.ordered.length;
        if (parent) {
          parent.feedback = node.feedback ?? parent.feedback;
          parent.truncated ||= node.truncated;
        }
      }
    }
    visit(runs, 0, result.roots);
    return result;
  }
  const tasks = view.tasks.map((task, index) => ({ task, index, tree: tree(task.runs) }));
  const unassigned = tree(view.unassigned);
  return { view, mode: coordinated ? "Coordinated" : seen.size ? "Agents" : "Solo",
    tasks, unassigned, count: seen.size, roots, completedRoots, truncated };
}

function runName(run: ProgressRun): string {
  const name = clean(run.name), task = clean(run.task);
  return name || (task !== "Assignment unavailable" ? task : "") || clean(run.id) || "run";
}
function runtimeFields(run: ProgressRun, icons: ProgressIcons, portable: boolean): [string, string] {
  const model = clean(run.model);
  const slash = model.indexOf("/");
  const displayModel = (slash > 0 ? model.slice(slash + 1) : "") || model;
  const thinking = clean(run.thinking);
  if (portable) return [`Model: ${displayModel || "unknown"}`, `Thinking: ${thinking || "unknown"}`];
  return [prefix(icons.model, displayModel || "model unknown"), prefix(icons.thinking, thinking || "thinking unknown")];
}
const outcomeOf = (run: ProgressRun) => {
  const result = run.result ?? run.summary;
  return reportedOutcome(run.resultStatus, result && stripTerminalSequences(result), run.historyExcerpt);
};
function roleMark(node: Node, icons: ProgressIcons, problem: boolean): string {
  const { roles } = icons;
  const key = Object.hasOwn(roles, node.role) ? node.role : aliases.get(node.role) ?? "other";
  const pair = Object.hasOwn(roles, key) ? roles[key] : roles.other;
  return problem ? pair.problem : pair.normal;
}
const hasProblem = (node: Node, outcome: ReturnType<typeof outcomeOf>) =>
  node.delivery === "failed" || node.delivery === "help_requested" || (outcome !== undefined && outcome !== "complete");
function formalState(task: ProgressTask): string { return clean(task.status) || "unknown"; }
function statusKey(key: string): StatusIcon {
  return Object.hasOwn(defaultProgressIcons.status, key) ? key as StatusIcon : "unknown";
}
function statusText(status: StatusIcon, icons: ProgressIcons, portable: boolean) {
  const mark = portable ? "" : icons.status[status];
  return `${labelStatus(status)}${mark ? ` ${mark}` : ""}`;
}

function limitsNotice(report: PreparedProgress): string | undefined {
  return report.truncated ? "Run scan truncated; counts are a lower bound" :
    report.view.incomplete ? "Incomplete evidence; counts are a lower bound" : undefined;
}
function hiddenRows(count: number, heightLimited: boolean, noun = "row") {
  return `… ${count} ${noun}${count === 1 ? "" : "s"} hidden${heightLimited ? " · expand / full" : " (limit) · full"}`;
}

interface SummaryRow { node: Node; group?: Group }
function agentsSummary(report: PreparedProgress, width: number, maxTasks: number, maxRuns: number, compact: boolean, icons: ProgressIcons): string[] {
  const inner = inside(width);
  const warning = limitsNotice(report);
  const body = [warning ? fit(prefix(icons.info, warning), inner, "…") : ""];
  const groups = report.tasks.slice(0, maxTasks);
  const allowed = Math.min(maxRuns, groups.reduce((sum, group) => sum + group.tree.roots.length, report.unassigned.roots.length));
  const slots = COMPACT_HEIGHT - (width >= 12 ? 2 : 1) - body.length;
  // Reserve a whole line for the omission marker; never drop only a row's metadata.
  const overflow = allowed * 2 > slots || allowed < report.roots;
  const budget = compact ? Math.min(allowed, Math.floor((slots - Number(overflow)) / 2)) : allowed;
  const rows: SummaryRow[] = [];
  const add = (tree: Tree, group?: Group) => {
    for (const node of tree.roots) {
      if (rows.length >= budget) return;
      rows.push({ node, group });
    }
  };
  for (const group of groups) {
    if (rows.length >= budget) break;
    add(group.tree, group);
  }
  if (rows.length < budget) add(report.unassigned);
  const heightLimited = rows.length < allowed;
  for (const { node, group } of rows) {
    const outcome = outcomeOf(node.run);
    const problem = hasProblem(node, outcome);
    const state = group ? ` · ${taskLabel(group.task, group.index)}: ${formalState(group.task)}` : "";
    const reported = outcome ? ` · outcome: ${statusText(outcome, icons, false)}` : "";
    const suffix = ` · ${labelStatus(node.delivery)}${reported}${state}`;
    const nameWidth = Math.max(4, inner - visibleWidth(suffix) - 3);
    body.push(fit(`${prefix(icons.status[node.delivery], fit(runName(node.run), nameWidth, "…"))}${suffix} · ${clean(node.run.summary) || "—"}`, inner, "…"),
      fit(`  ${prefix(icons.runtime, prefix(roleMark(node, icons, problem), runtimeFields(node.run, icons, false).join(" · ")))}`, inner, "…"));
  }
  if (rows.length < report.roots) body.push(fit(hiddenRows(report.roots - rows.length, heightLimited), inner, "…"));
  const lower = report.truncated || report.view.incomplete ? "+" : "";
  return summaryBox(body, width, `${prefix(icons.status.completed, `${report.completedRoots}/${report.roots}${lower}`)} · ${prefix(icons.agents, `${report.count}${lower}`)}`);
}

function coordinatedSummary(report: PreparedProgress, width: number, maxTasks: number, maxRuns: number, compact: boolean, icons: ProgressIcons): string[] {
  const inner = inside(width);
  const warning = limitsNotice(report);
  const body = warning ? [fit(prefix(icons.info, warning), inner, "…")] : [];
  const total = report.tasks.length + report.unassigned.roots.length;
  const taskCount = Math.min(maxTasks, report.tasks.length);
  const allowed = taskCount + Math.min(maxRuns, report.unassigned.roots.length);
  const slots = COMPACT_HEIGHT - (width >= 12 ? 2 : 1) - body.length;
  const shown = compact && (allowed > slots || allowed < total) ? Math.min(allowed, slots - 1) : allowed;
  const rows: { label: string; roles: string; summary: string }[] = [];
  function add(nodes: Node[], label: string, status: string, report?: string, truncated = false, start = 0, end = nodes.length) {
    const marks: string[] = [];
    const maxMarks = Math.max(1, Math.ceil(inner / 2));
    for (let i = start; i < Math.min(end, start + maxMarks); i++) {
      const node = nodes[i];
      const mark = roleMark(node, icons, hasProblem(node, outcomeOf(node.run)));
      if (mark) marks.push(mark);
    }
    rows.push({ label: prefix(icons.status[statusKey(status)], label),
      roles: `⟦ ${marks.join(" ") || "—"}${truncated ? " +?" : end - start > maxMarks ? " …" : ""} ⟧`,
      summary: clean(report) || prefix(icons.info, "no coordinator text") });
  }
  for (let i = 0; i < Math.min(taskCount, shown); i++) {
    const { task, index, tree } = report.tasks[i];
    add(tree.ordered, `${taskLabel(task, index)} ${clean(task.title)}`, task.status, tree.feedback, tree.truncated);
  }
  let start = 0;
  for (let i = 0; i < shown - taskCount; i++) {
    const root = report.unassigned.roots[i];
    add(report.unassigned.ordered, runName(root.run), root.delivery, root.feedback, root.truncated, start, root.end);
    start = root.end;
  }
  const labelWidth = Math.min(Math.floor(inner * .3), Math.max(0, ...rows.map(row => visibleWidth(row.label))));
  const rolesWidth = Math.min(Math.floor(inner * .35), Math.max(0, ...rows.map(row => visibleWidth(row.roles))));
  const column = (value: string, width: number) => {
    if (width < 1) return "";
    const clipped = fit(value, width, "…");
    return clipped + " ".repeat(width - visibleWidth(clipped));
  };
  for (const row of rows) body.push(fit(inner >= 40
    ? `${column(row.label, labelWidth)} ${column(row.roles, rolesWidth)} · ${row.summary}`
    : `${row.label} ${row.roles} · ${row.summary}`, inner, "…"));
  if (shown < total) body.push(fit(hiddenRows(total - shown, shown < allowed), inner, "…"));
  const accepted = report.tasks.filter(group => group.task.status === "accepted").length;
  const lower = report.truncated || report.view.incomplete ? "+" : "";
  return summaryBox(body, width, `${prefix(icons.status.accepted, `${accepted}/${report.tasks.length}`)} · ${prefix(icons.agents, `${report.count}${lower}`)}`);
}

function fullField(label: string, value: string, width: number): string[] {
  const head = `${label}:`.padEnd(Math.max(8, label.length + 2));
  if (width <= head.length) return text(head + clean(value), width);
  const lines = stripTerminalSequences(value).split(/\r?\n/).flatMap(line => text(clean(line) || " ", width - head.length));
  return lines.map((line, index) => `${index ? " ".repeat(head.length) : head}${line}`);
}
function fullRun(node: Node, width: number, icons: ProgressIcons, portable: boolean, parent?: string, children: string[] = []): string[] {
  const { run } = node;
  const available = inside(width);
  const outcome = outcomeOf(run);
  const title = prefix(portable ? "" : roleMark(node, icons, hasProblem(node, outcome)), `${clean(run.role) || "run"}: ${runName(run)}`);
  const runtime = runtimeFields(run, icons, portable);
  const metadata = runtime.join(" · ");
  const content: string[] = [];
  // If both parts do not fit, preserve both on wrapped lines instead of letting runtime erase the identity.
  const inline = width >= 12 && visibleWidth(title) + visibleWidth(metadata) + 9 <= width;
  if (width >= 12 && visibleWidth(title) > width - 6) content.push(...fullField("Agent", title, available));
  if (!inline) for (const field of runtime) content.push(...text(field, available));
  if (!run.name && run.id) content.push(...fullField("Run ID", run.id, available));
  content.push(...fullField("Task", clean(run.task) ? run.task : "—", available));
  if (parent) content.push(...fullField("Parent", parent, available));
  const result = run.result ?? run.summary;
  if (result) content.push(...fullField(run.historyExcerpt ? "Excerpt" : "Result", result, available));
  if (run.notice) content.push(...fullField("Notice", run.notice, available));
  if (outcome || node.delivery === "completed") {
    content.push(...fullField("Outcome", outcome ? statusText(outcome, icons, portable) : "not recorded", available));
  }
  append(content, children);
  append(content, fullField("Delivery", statusText(node.delivery, icons, portable), available));
  return box(title, content, width, inline ? metadata : "");
}
function countRuns(tree: Tree): string {
  const roles = new Map<string, number>();
  for (const { run } of tree.ordered) {
    const role = fit(clean(run.role), 40) || "unknown";
    roles.set(role, (roles.get(role) ?? 0) + 1);
  }
  const labels = [...roles].slice(0, 8).map(([role, count]) => `${role}: ${count}`);
  if (roles.size > labels.length) labels.push(`+${roles.size - labels.length} roles`);
  return `Runs: ${tree.ordered.length}${tree.truncated ? "+" : ""}${labels.length ? ` (${labels.join(", ")})` : ""}`;
}
function detailedReport(report: PreparedProgress, width: number, maxTasks: number, maxRuns: number, icons: ProgressIcons, portable: boolean): string[] {
  const { view, mode } = report;
  const inner = inside(width);
  const body = text(`Mode: ${mode} · ${planHeading(view.title)}`, inner);
  const taskGroups = report.tasks.slice(0, maxTasks);
  const add = (value: string) => append(body, text(value, inner));
  if (mode !== "Agents" && view.title !== null && !view.tasks.length) add("No tasks");
  if (mode === "Coordinated") for (const { task, index } of taskGroups) {
    const checked = task.status === "accepted";
    add(`${prefix(checked ? (portable ? "☑" : icons.checked) : (portable ? "☐" : icons.unchecked), taskLabel(task, index))} ${clean(task.title)} (${formalState(task)})`);
  }
  if (view.notice) add(`Notice: ${clean(view.notice)}`);
  else if (view.incomplete && !report.truncated) add("Notice: Incomplete evidence; counts are a lower bound");
  if (report.truncated) add("… run scan truncated (cycle/depth/safety limit); counts are a lower bound");
  let remaining = maxRuns;
  let hidden = report.tasks.slice(maxTasks).some(group => group.tree.ordered.length > 0);
  const renderNodes = (nodes: Node[], available: number, flat: boolean, parent?: string): string[] => {
    const lines: string[] = [];
    for (const node of nodes) {
      if (!remaining) { hidden = true; break; }
      remaining--;
      // At narrow widths keep descendants readable instead of successively boxing
      // them down to a handful of columns. Parent labels preserve the hierarchy.
      const flattenChildren = flat || inside(available) < MIN_NESTED_CARD_WIDTH;
      const children = flattenChildren ? [] : renderNodes(node.children, inside(available), false);
      lines.push("");
      append(lines, fullRun(node, available, icons, portable, parent, children));
      if (flattenChildren && node.children.length) append(lines, renderNodes(node.children, available, true, runName(node.run)));
    }
    return lines;
  };
  const group = (tree: Tree, title: string, status?: string) => {
    const available = inside(inner);
    const lines = status === undefined ? [] : text(`Status: ${status}`, available);
    if (status !== undefined && inner >= 12 && visibleWidth(title) > inner - 6) lines.unshift(...text(title, available));
    if (mode === "Coordinated") {
      lines.push(...text(countRuns(tree), available));
      const feedback = clean(tree.feedback);
      if (feedback) lines.push(...text(`Reported feedback (not acceptance): ${feedback}`, available));
      if (tree.truncated) lines.push(...text("… run scan truncated (cycle/depth/safety limit)", available));
      append(lines, renderNodes(tree.roots, available, false));
    }
    body.push("");
    append(body, box(title, lines, inner));
  };
  for (const { task, index, tree } of taskGroups) {
    const label = `${taskLabel(task, index)} ${clean(task.title)}`;
    const status = formalState(task);
    if (mode === "Agents") {
      add(`Formal task state · ${label}: ${status}`);
      append(body, renderNodes(tree.roots, inner, true));
    } else group(tree, `Task ${taskLabel(task, index)}: ${clean(task.title)}`, status);
  }
  if (report.unassigned.roots.length) {
    if (mode === "Agents") append(body, renderNodes(report.unassigned.roots, inner, true));
    else group(report.unassigned, view.title === null ? "Coordinator overview" : "Unassigned runs");
  }
  if (view.tasks.length > maxTasks) add(`… ${view.tasks.length - maxTasks} tasks hidden (maxTasks)`);
  if (hidden) add("… runs hidden (display limits)");
  return box(prefix(portable ? "" : icons.main, "Main Agent"), body, width);
}

export interface RenderProgressOptions {
  details?: boolean; compact?: boolean; maxTasks?: number; maxRuns?: number; icons?: ProgressIcons;
  /** HTML uses text for runtime and portable checkboxes, not configured terminal glyphs. */
  portable?: boolean;
  prepared?: PreparedProgress;
}

/** Pure display: run delivery and reported outcomes never confer task acceptance. */
export function renderProgress(view: ProgressView, width: number, options: RenderProgressOptions = {}): string[] {
  width = frameWidth(width);
  if (!width) return [];
  if (options.details && !options.compact && width < 8) return [fit("Widen terminal", width)];
  const maxTasks = limit(options.maxTasks, 12);
  const maxRuns = limit(options.maxRuns, 20);
  const icons = options.icons ?? defaultProgressIcons;
  const report = options.prepared?.view === view ? options.prepared : prepareProgress(view);
  if (options.details && !options.compact) return detailedReport(report, width, maxTasks, maxRuns, icons, !!options.portable);
  const compact = options.compact !== false;
  if (report.mode === "Solo") return [];
  return report.mode === "Agents" ? agentsSummary(report, width, maxTasks, maxRuns, compact, icons) :
    coordinatedSummary(report, width, maxTasks, maxRuns, compact, icons);
}
