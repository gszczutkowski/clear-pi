import { watch, type FSWatcher } from "node:fs";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { matchesKey, truncateToWidth } from "@earendil-works/pi-tui";
import { defaultProgress, defaultProgressIcons, type ProgressIcons, type ProgressOptions } from "./config.ts";
import { createProgressReader, type ProgressSnapshot, type ProgressWatch } from "./progress-data.ts";
import { saveProgressExport } from "./progress-export.ts";
import { prepareProgress, renderProgress, type PreparedProgress, type ProgressView } from "./progress-view.ts";

export const PROGRESS_WIDGET = "clear-pi-progress";
const FULL_REPORT_LIMITS = { maxTasks: 100, maxRuns: 100 };
const MAX_ON_DEMAND_READS = 3;
const ACTIONS = ["expand", "full", "compact", "off", "refresh", "export"] as const;
const actionList = ACTIONS.join("|");
const summaryHint = "/clear-progress expand — summary · /clear-progress full — full report";
const empty: ProgressView = { title: null, tasks: [], unassigned: [] };

function branchKey(manager: ExtensionContext["sessionManager"]): string | undefined {
  const id = manager.getHeader()?.id;
  const file = manager.getSessionFile();
  return id && file ? JSON.stringify([id, manager.getSessionDir(), file, manager.getLeafId()]) : undefined;
}

interface DashboardDependencies {
  createReader?: () => (manager: ExtensionContext["sessionManager"]) => Promise<ProgressSnapshot>;
  watch?: typeof watch;
  render?: typeof renderProgress;
}

/** Presentation only: no transcript writes, tools, model requests, or control bus. */
export function createProgressDashboard(pi: ExtensionAPI, dependencies: DashboardDependencies = {}) {
  const readFactory = dependencies.createReader ?? createProgressReader;
  const renderReport = dependencies.render ?? renderProgress;
  let context: ExtensionContext | undefined;
  let options = { ...defaultProgress };
  let icons: ProgressIcons = defaultProgressIcons;
  const reports = new WeakMap<ProgressView, PreparedProgress>();
  const prepared = (view: ProgressView) => {
    let report = reports.get(view);
    if (!report) { report = prepareProgress(view); reports.set(view, report); }
    return report;
  };
  let projection: { key: string | undefined; view: ProgressView; exportable: boolean; generation: number; covered: boolean } | undefined;
  let read: ReturnType<typeof readFactory> | undefined;
  const watchers = new Map<string, { watcher: FSWatcher; names: Set<ProgressWatch["filename"]> }>();
  let pending: ReturnType<typeof setTimeout> | undefined;
  let inFlight: { manager: ExtensionContext["sessionManager"]; key: string | undefined; generation: number; done: Promise<void> } | undefined;
  let generation = 0;
  let lifecycle = 0;
  let mounted = false;
  let stopped = true;
  let requestRender: (() => void) | undefined;

  const currentProjection = () => projection && context && projection.key === branchKey(context.sessionManager) ? projection : undefined;
  const currentView = () => currentProjection()?.view ?? empty;
  const reportRows = (mode: "compact" | "expand" | "full") => {
    let cache: { view: ProgressView; width: number; lines: string[] } | undefined;
    return (width: number) => {
      const view = currentView();
      if (cache?.view === view && cache.width === width) return cache.lines;
      const limits = mode === "full" ? FULL_REPORT_LIMITS : options;
      const lines = renderReport(view, width, { ...limits, details: mode === "full", compact: mode === "compact", icons, prepared: prepared(view) });
      if (mode === "compact" && lines.length) lines.push(truncateToWidth(summaryHint, width, ""));
      cache = { view, width, lines };
      return lines;
    };
  };
  const closeWatch = (directory: string) => {
    const entry = watchers.get(directory);
    watchers.delete(directory);
    entry?.watcher.close();
  };
  const clearWatchers = () => { for (const directory of watchers.keys()) closeWatch(directory); };
  const clearPending = () => { if (pending) clearTimeout(pending); pending = undefined; };
  const paint = () => {
    const ctx = context;
    if (!ctx || ctx.mode !== "tui" || typeof ctx.ui.setWidget !== "function") return;
    const view = currentView();
    // Only observed runs produce a summary; explicit expand cannot reveal a Solo panel.
    const visible = options.enabled && (view.unassigned.length > 0 || view.tasks.some(task => task.runs.length > 0));
    if (!visible) {
      if (mounted) ctx.ui.setWidget(PROGRESS_WIDGET, undefined);
      mounted = false;
      return;
    }
    // Replace herdr's plan summary, but leave the explicitly opened history tree alone.
    ctx.ui.setWidget("subagent-plan", undefined);
    if (mounted) return;
    ctx.ui.setWidget(PROGRESS_WIDGET, (_tui, theme) => {
      const rows = reportRows("compact");
      return { render: (width: number) => rows(width).map(line => theme.fg("muted", line)), invalidate() {} };
    });
    mounted = true;
  };
  const schedule = () => {
    if (stopped || pending || !options.enabled) return;
    pending = setTimeout(() => {
      pending = undefined;
      if (!inFlight) void refresh(); // An active read schedules a follow-up if invalidated.
    }, 80);
    pending.unref();
  };
  const invalidate = () => { generation++; schedule(); };
  const observe = (targets: ProgressWatch[]) => {
    const desired = new Map<string, Set<ProgressWatch["filename"]>>();
    let covered = targets.length > 0;
    for (const { directory, filename } of targets) {
      if (!desired.has(directory)) {
        if (desired.size >= 32) { covered = false; continue; }
        desired.set(directory, new Set());
      }
      desired.get(directory)!.add(filename);
    }
    for (const directory of watchers.keys()) {
      if (!desired.has(directory)) closeWatch(directory);
    }
    const filterKey = (filter: ProgressWatch["filename"]) => typeof filter === "string" ? `:${filter}` : filter.toString();
    let added = false;
    for (const [directory, names] of desired) {
      const existing = watchers.get(directory);
      if (existing) {
        const previous = new Set([...existing.names].map(filterKey));
        if ([...names].some(name => !previous.has(filterKey(name)))) added = true;
        existing.names = names;
        continue;
      }
      try {
        const watcher = (dependencies.watch ?? watch)(directory, (_event, filename) => {
          const entry = watchers.get(directory);
          if (entry?.watcher !== watcher) return;
          const name = filename?.toString();
          // Some platforms omit filenames. Reconcile conservatively in that case.
          if (!name) { invalidate(); return; }
          for (const filter of entry.names) {
            const matches = typeof filter === "string"
              ? (process.platform === "win32" ? filter.toLowerCase() === name.toLowerCase() : filter === name)
              : filter.test(name);
            if (matches) { invalidate(); break; }
          }
        });
        const lost = () => {
          if (watchers.get(directory)?.watcher !== watcher) return;
          watchers.delete(directory);
          if (projection) projection.covered = false;
          generation++;
        };
        watcher.on("close", lost);
        watcher.on("error", () => { lost(); watcher.close(); });
        watchers.set(directory, { watcher, names });
        added = true;
      } catch { covered = false; }
    }
    // Catch writes between discovery and installing a new watch or filter.
    if (added && covered) invalidate();
    else if (added) schedule();
    return covered;
  };
  const refresh = (oneShot = false) => {
    const reader = read;
    if (stopped || !context || (!options.enabled && !oneShot) || !reader) { paint(); return Promise.resolve(); }
    clearPending();
    const manager = context.sessionManager;
    const key = branchKey(manager);
    const job = { manager, key, generation, done: Promise.resolve() };
    inFlight = job;
    const current = () => inFlight === job && context?.sessionManager === manager && branchKey(manager) === key;
    job.done = (async () => {
      try {
        const next = await reader(manager);
        if (!current()) return;
        const covered = options.enabled && observe(next.watches);
        projection = { key, view: next.view, exportable: !!key, generation: job.generation, covered };
      } catch {
        if (!current()) return;
        projection = { key, view: { ...empty, notice: "Progress data unavailable; no completion inferred.", incomplete: true },
          exportable: false, generation: job.generation, covered: false };
        clearWatchers();
      } finally {
        if (inFlight === job) {
          const active = current();
          inFlight = undefined;
          if (active) { paint(); requestRender?.(); }
          if (!active || generation !== job.generation) schedule();
        }
      }
    })();
    return job.done;
  };
  const stop = () => {
    stopped = true;
    lifecycle++;
    inFlight = undefined;
    clearPending();
    clearWatchers();
    if (mounted) context?.ui.setWidget(PROGRESS_WIDGET, undefined);
    mounted = false;
    context = undefined;
    requestRender = undefined;
    read = undefined;
    projection = undefined;
  };
  const command: Parameters<ExtensionAPI["registerCommand"]>[1] = {
    description: `Show/export plan and agent progress without model calls: ${actionList}`,
    getArgumentCompletions: prefix => ACTIONS
      .filter(value => value.startsWith(prefix)).map(value => ({ value, label: value })),
    handler: async (args, ctx) => {
      if (ctx.mode !== "tui") { if (ctx.hasUI) ctx.ui.notify("Progress dashboard: TUI only", "info"); return; }
      if (stopped || !context) return;
      const arg = args.trim();
      const action = arg ? ACTIONS.find(candidate => candidate === arg) : "expand";
      if (!action) {
        ctx.ui.notify(`Usage: /clear-progress [${actionList}]`, "warning"); return;
      }
      if (action === "export") {
        const manager = ctx.sessionManager;
        const key = branchKey(manager);
        const current = () => !stopped && context?.sessionManager === manager && branchKey(manager) === key;
        const stale = () => ctx.ui.notify("Progress snapshot is not current. Run /clear-progress refresh before exporting.", "warning");
        try {
          const id = manager.getHeader()?.id;
          if (!id || !/^[a-zA-Z0-9_-]+$/.test(id)) throw new Error("Unavailable session identity");
          if (!key || !projection?.exportable || projection.key !== key || !current()) { stale(); return; }
          const directory = join(manager.getSessionDir(), "artifacts", id, "clear-progress");
          // Export only the already projected snapshot, without reading history again.
          const { view } = projection;
          const file = await saveProgressExport(view, directory, { ...options, prepared: prepared(view) }, current);
          if (file && current()) ctx.ui.notify(`Progress exported: ${file}`, "info");
          else if (!file && !stopped && context?.sessionManager === manager) stale();
        } catch {
          if (current()) ctx.ui.notify("Progress export failed: cannot write the report to session artifacts.", "error");
        }
        return;
      }
      context = ctx;
      if (action === "off") {
        options.enabled = false;
        clearPending();
        lifecycle++;
        inFlight = undefined;
        clearWatchers();
        paint();
        requestRender?.();
        return;
      }
      if (action === "compact" || action === "refresh") {
        options.enabled = true;
        read ??= readFactory();
        await refresh();
        return;
      }
      if (typeof ctx.ui.custom === "function") {
        const manager = ctx.sessionManager;
        const key = branchKey(manager);
        const started = lifecycle;
        const current = () => lifecycle === started && context?.sessionManager === manager && branchKey(manager) === key;
        let snapshot = currentProjection();
        // A same-leaf projection is reusable only while its watch coverage is intact and clean.
        if (!options.enabled || !snapshot?.covered || snapshot.generation !== generation) {
          const previous = snapshot;
          // Without full coverage, a read already underway may have missed an unobserved write.
          const earlier = options.enabled && snapshot?.covered ? undefined : inFlight;
          for (let attempt = 0; attempt < MAX_ON_DEMAND_READS; attempt++) {
            read ??= readFactory();
            const job = inFlight;
            if (job && job !== earlier && job.manager === manager && job.key === key && job.generation === generation) await job.done;
            else await refresh(!options.enabled);
            if (!current()) return;
            snapshot = currentProjection();
            if (snapshot && snapshot !== previous && snapshot.generation === generation) break;
          }
          if (!snapshot || snapshot === previous || snapshot.generation !== generation) {
            ctx.ui.notify("Progress is still changing. Try the command again in a moment.", "info");
            return;
          }
        }
        if (action === "expand" && prepared(snapshot.view).mode === "Solo") return;
        await ctx.ui.custom<void>((tui, theme, keys, done) => {
          const rows = reportRows(action);
          let top = 0;
          let page = 1;
          let total = 0;
          return {
            invalidate() {},
            render(width: number) {
              const lines = rows(width);
              total = lines.length;
              page = Math.max(0, Math.floor(tui.terminal.rows * 0.7) - 1);
              top = Math.min(top, Math.max(0, total - page));
              return [...lines.slice(top, top + page).map(line => theme.fg("muted", line)),
                theme.fg("dim", truncateToWidth(`Esc close · ${page && total ? top + 1 : 0}–${Math.min(top + page, total)}/${total} · ↑↓ PgUp/PgDn Home/End`, width, ""))];
            },
            handleInput(data: string) {
              if (keys.matches(data, "tui.select.cancel") || keys.matches(data, "tui.select.confirm")) { done(); return; }
              if (keys.matches(data, "tui.select.up")) top--;
              else if (keys.matches(data, "tui.select.down")) top++;
              else if (matchesKey(data, "pageUp")) top -= page;
              else if (matchesKey(data, "pageDown")) top += page;
              else if (matchesKey(data, "home")) top = 0;
              else if (matchesKey(data, "end")) top = total;
              else return;
              top = Math.max(0, Math.min(top, Math.max(0, total - page)));
              tui.requestRender();
            },
            handleMouse(event: { type: string; wheelDelta?: number }) {
              if (event.type !== "wheel") return;
              top = Math.max(0, Math.min(top + Math.sign(event.wheelDelta ?? 0) * 3, Math.max(0, total - page)));
              tui.requestRender();
              return { handled: true };
            },
          };
        }, { overlay: true, overlayOptions: { width: "95%" } });
      }
    },
  };
  pi.registerCommand("clear-progress", command);
  return {
    start(ctx: ExtensionContext, settings: ProgressOptions, render: () => void, palette: ProgressIcons = defaultProgressIcons) {
      stop();
      if (ctx.mode !== "tui" || typeof ctx.ui.setWidget !== "function") return;
      context = ctx;
      options = { ...settings };
      icons = palette;
      requestRender = render;
      stopped = false;
      if (options.enabled) read = readFactory();
      return refresh();
    },
    update(ctx: ExtensionContext) { if (!stopped) { context = ctx; invalidate(); } },
    stop,
  };
}
